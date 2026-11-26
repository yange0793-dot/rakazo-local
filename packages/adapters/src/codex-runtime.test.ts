import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  AgentToolCompletion,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminatingToolResult } from "./approval-effect.js";
import { builtinAgentTools } from "./builtin-tools.js";
import type { CodexAppServer, CodexAppServerOptions } from "./codex-app-server.js";
import { createCodexAppServer } from "./codex-app-server.js";
import { createCodexModelBridge } from "./codex-model-bridge.js";
import { CodexAgentRuntime } from "./codex-runtime.js";
import { restoreTurnCheckpoint, unresolvedTurnCheckpointCalls } from "./turn-checkpoint.js";

vi.mock("./codex-app-server.js", () => ({ createCodexAppServer: vi.fn() }));
vi.mock("./codex-model-bridge.js", () => ({ createCodexModelBridge: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const model: AgentRunRequest["model"] = {
  provider: "openai-compatible",
  id: "runtime-fixture-model",
  apiProtocol: "responses",
  baseUrl: "https://model.example.test/v1",
  apiKey: "test-only-model-key",
  thinkingLevel: "medium",
  reasoning: true,
  contextWindow: 128_000,
};

const toolNames = new Set([
  "write_file",
  "shell",
  "remember",
  "save_memory",
  "recall_memory",
  "ask_user",
]);
const tools = builtinAgentTools.filter((tool) => toolNames.has(tool.name));
const bridgeClose = vi.fn(async () => {});
const natives: NativeFixture[] = [];
const bridgeOptions: Array<Parameters<typeof createCodexModelBridge>[0]> = [];
const streams: Array<{ return(): Promise<unknown> }> = [];
let stateRoot: string;
let runNumber = 0;
let onStart: ((native: NativeFixture) => void | Promise<void>) | undefined;

interface NativeToolResult {
  success: boolean;
  contentItems: Array<{ type: string; text?: string }>;
}

class NativeFixture implements CodexAppServer {
  closed = false;
  readonly threadId = "native-thread";
  turnId = "";
  readonly started = deferred<void>();
  readonly lifetime = new AbortController();
  readonly order: string[] = [];
  private turnNumber = 0;

  constructor(readonly options: CodexAppServerOptions) {}

  rpc = vi.fn(async (method: string, raw: unknown = {}): Promise<unknown> => {
    const params = raw as Record<string, any>;
    this.order.push(method);
    let result: unknown;
    switch (method) {
      case "initialize":
      case "turn/steer":
        result = {};
        break;
      case "thread/start":
      case "thread/resume":
        result = { thread: { id: this.threadId }, model: params.model };
        break;
      case "turn/start":
        this.turnId = `native-turn-${++this.turnNumber}`;
        await onStart?.(this);
        this.started.resolve();
        result = { turn: { id: this.turnId, status: "inProgress", items: [] } };
        break;
      case "turn/interrupt":
        this.emit("turn/completed", {
          turn: { id: params.turnId, status: "interrupted", items: [] },
        });
        result = {};
        break;
      default:
        throw new Error(`Unexpected test RPC: ${method}`);
    }
    return result;
  });

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc(method, params) as Promise<T>;
  }

  notify = vi.fn();
  close = vi.fn(async () => {
    this.closed = true;
    this.lifetime.abort();
  });

  emit(method: string, params: Record<string, unknown>) {
    this.options.onNotification?.({
      method,
      params: { threadId: this.threadId, ...params },
    });
  }

  async tool(name: string, args: Record<string, unknown>, callId: string, turnId = this.turnId) {
    const result = await this.options.onServerRequest!(
      {
        id: `request-${callId}`,
        method: "item/tool/call",
        params: {
          threadId: this.threadId,
          turnId,
          callId,
          tool: name,
          arguments: args,
        },
      },
      this.lifetime.signal,
    );
    this.order.push(`tool-result:${callId}`);
    return result as NativeToolResult;
  }

  finish(text = "Task finished.") {
    this.emit("item/completed", {
      turnId: this.turnId,
      item: { type: "agentMessage", id: "final", text, phase: "final_answer" },
    });
    this.emit("turn/completed", {
      turn: { id: this.turnId, status: "completed", items: [] },
    });
  }

  params(method: string) {
    return this.rpc.mock.calls.find(([name]) => name === method)?.[1] as Record<string, any>;
  }
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "test-bot",
    threadId: "test-thread",
    runId: `test-run-${++runNumber}`,
    prompt: "Complete the requested work.",
    instructions: "Use the supplied tools and preserve the user's instructions.",
    history: [{ id: "earlier-message", role: "user", content: "The report must include totals." }],
    tools,
    model,
    ...overrides,
  };
}

function launch(overrides: Partial<AgentRunRequest> = {}, signal?: AbortSignal) {
  const input = request(overrides);
  const runtime = new CodexAgentRuntime({ stateRoot, binary: "fixture-codex" });
  const stream = runtime.run(input, { signal });
  streams.push(stream);
  const events: AgentRuntimeEvent[] = [];
  const completed = (async () => {
    for await (const event of stream) events.push(event);
    return events;
  })();
  void completed.catch(() => {});
  return { runtime, input, stream, events, completed };
}

async function ready(index = 0) {
  await vi.waitFor(() => expect(natives[index]).toBeDefined());
  const native = natives[index]!;
  await native.started.promise;
  // Let the runtime consume the mocked turn/start acknowledgement.
  await Promise.resolve();
  return native;
}

beforeEach(async () => {
  natives.length = 0;
  bridgeOptions.length = 0;
  runNumber = 0;
  onStart = undefined;
  stateRoot = await mkdtemp(path.join(tmpdir(), "rakazo-codex-runtime-test-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden in runtime tests.");
    }),
  );
  vi.mocked(createCodexAppServer).mockImplementation((options = {}) => {
    const native = new NativeFixture(options);
    natives.push(native);
    return native;
  });
  vi.mocked(createCodexModelBridge).mockImplementation(async (options) => {
    options.signal.throwIfAborted();
    bridgeOptions.push(options);
    return {
      baseUrl: "http://127.0.0.1:23456",
      token: "test-only-bridge-token",
      close: bridgeClose,
    };
  });
});

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.return().catch(() => undefined);
  await rm(stateRoot, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Codex runtime host contract", () => {
  it("uses real tool preparation, memory schemas, executor dispatch and completion hooks", async () => {
    const completions: AgentToolCompletion[] = [];
    const executeTool = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async (name, args) => ({
      ok: true,
      name,
      args,
    }));
    const run = launch({
      executeTool,
      onToolCompleted: (completion) => {
        completions.push(completion);
      },
    });
    const native = await ready();
    const definitions = native.params("thread/start").dynamicTools as Array<{
      name: string;
      inputSchema: ConnectorTool["inputSchema"];
    }>;
    expect(definitions.find((tool) => tool.name === "remember")?.inputSchema).toMatchObject({
      type: "object",
      properties: { content: { type: "string" }, old_text: { type: "string" } },
    });
    expect(definitions.find((tool) => tool.name === "save_memory")?.inputSchema).toMatchObject({
      required: ["content"],
      properties: {
        content: { type: "string" },
        source_quote: { type: "string" },
        replaces_id: { type: "string" },
        expected_revision: expect.any(Object),
      },
    });
    expect(bridgeOptions[0]!.request.model).toEqual(model);
    expect(native.params("thread/start").model).toBe(model.id);

    const written = await native.tool(
      "write_file",
      {
        path: "report.txt",
        content: "Revenue: 100; costs: 40; net: 60.",
      },
      "write-1",
    );
    expect(written.success).toBe(true);
    expect(executeTool).toHaveBeenLastCalledWith(
      "write_file",
      { path: "report.txt", content: "Revenue: 100; costs: 40; net: 60." },
      expect.any(String),
      undefined,
      expect.any(Object),
    );
    const remembered = await native.tool("remember", { content: 42, old_text: "" }, "remember-1");
    expect(remembered.success).toBe(true);
    expect(executeTool.mock.calls.at(-1)?.slice(0, 2)).toEqual(["remember", { content: "42" }]);

    const memory = {
      content: "The reporting currency is EUR.",
      source_quote: "Use EUR for the report.",
      replaces_id: "fact-1",
      expected_revision: 2,
    };
    expect((await native.tool("save_memory", memory, "memory-1")).success).toBe(true);
    expect(executeTool.mock.calls.at(-1)?.slice(0, 2)).toEqual(["save_memory", memory]);
    const callsBeforeInvalid = executeTool.mock.calls.length;
    expect(
      (await native.tool("save_memory", { expected_revision: 0 }, "invalid-memory")).success,
    ).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(callsBeforeInvalid);
    const lookup = { id: "fact-1", expected_revision: 2, scope: "current" };
    expect((await native.tool("recall_memory", lookup, "recall-1")).success).toBe(true);
    expect(executeTool.mock.calls.at(-1)?.slice(0, 2)).toEqual(["recall_memory", lookup]);

    native.finish("The file and memory are saved.");
    await run.completed;
    expect(completions.map((completion) => completion.name)).toEqual([
      "write_file",
      "remember",
      "save_memory",
      "recall_memory",
    ]);
    for (const completion of completions) {
      expect(completion.executionId).toBe(
        executeTool.mock.calls.find(([name]) => name === completion.name)?.[2],
      );
      expect(completion.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(run.events).toContainEqual({ type: "done", text: "The file and memory are saved." });
    const writingIndex = run.events.findIndex(
      (event) => event.type === "progress" && event.activity && event.text === "Writing report.txt",
    );
    expect(writingIndex).toBeGreaterThanOrEqual(0);
    expect(run.events.slice(writingIndex + 1).find((event) => event.type === "progress")).toEqual({
      type: "progress",
      activity: true,
      text: "",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("ignores replayed historical turns and retains text arriving before the start ACK", async () => {
    onStart = (native) => {
      native.emit("turn/started", { turn: { id: "old-turn", status: "inProgress" } });
      native.emit("item/agentMessage/delta", { turnId: "old-turn", itemId: "old", delta: "OLD" });
      native.emit("turn/completed", { turn: { id: "old-turn", status: "completed" } });
      native.emit("item/agentMessage/delta", {
        turnId: native.turnId,
        itemId: "final",
        delta: "NEW ",
      });
    };
    const run = launch();
    const native = await ready();
    native.emit("turn/started", { turn: { id: "old-turn", status: "inProgress" } });
    native.emit("item/agentMessage/delta", {
      threadId: "other-thread",
      turnId: native.turnId,
      itemId: "wrong",
      delta: "OTHER",
    });
    native.finish("NEW answer");
    await run.completed;
    expect(run.events.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
      "NEW ",
      "answer",
    ]);
    expect(run.events).toContainEqual({ type: "done", text: "NEW answer" });
  });

  it("rejects same-thread tool requests from a different turn without host effects", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const onCheckpoint = vi.fn();
    const onToolCompleted = vi.fn();
    const run = launch({ executeTool, onCheckpoint, onToolCompleted });
    const native = await ready();
    await expect(
      native.tool("write_file", { path: "stale.txt", content: "stale" }, "stale", "old-turn"),
    ).rejects.toThrow(/active turn/);
    expect(executeTool).not.toHaveBeenCalled();
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(onToolCompleted).not.toHaveBeenCalled();
    native.finish();
    await run.completed;
  });

  it("waits for the start ACK before accepting a tool and rejects historical calls", async () => {
    const ack = deferred<void>();
    const sent = deferred<void>();
    const executeTool = vi.fn(async () => ({ ok: true }));
    let early!: Promise<NativeToolResult>;
    let historical!: Promise<unknown>;
    onStart = async (native) => {
      native.emit("turn/started", { turn: { id: "old-turn", status: "inProgress" } });
      historical = native
        .tool("write_file", { path: "old.txt", content: "old" }, "old", "old-turn")
        .catch((error: unknown) => error);
      early = native.tool("write_file", { path: "new.txt", content: "new" }, "new");
      void early.catch(() => {});
      sent.resolve();
      await ack.promise;
    };
    const run = launch({ executeTool });
    await sent.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeAck = executeTool.mock.calls.length;
    ack.resolve();
    const result = await early;
    const stale = await historical;
    natives[0]!.finish();
    await run.completed;
    expect(callsBeforeAck).toBe(0);
    expect(result.success).toBe(true);
    expect(stale).toBeInstanceOf(Error);
    expect((stale as Error).message).toMatch(/active turn/);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]).toEqual([
      "write_file",
      { path: "new.txt", content: "new" },
      expect.any(String),
      undefined,
      expect.any(Object),
    ]);
  });

  it("releases a tool waiting for an ACK when turn/start fails without executing it", async () => {
    const ack = deferred<void>();
    const sent = deferred<void>();
    const executeTool = vi.fn(async () => ({ ok: true }));
    let early!: Promise<unknown>;
    onStart = async (native) => {
      early = native
        .tool("write_file", { path: "unconfirmed.txt", content: "pending" }, "unconfirmed")
        .catch((error: unknown) => error);
      sent.resolve();
      await ack.promise;
    };
    const run = launch({ executeTool });
    await sent.promise;
    ack.reject(new Error("Fixture start failed."));
    await expect(run.completed).rejects.toThrow("Fixture start failed.");
    expect(await early).toBeInstanceOf(Error);
    expect(executeTool).not.toHaveBeenCalled();
    expect(natives[0]!.closed).toBe(true);
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("does not execute queued or late tool calls after the current turn completes", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const executeTool = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    const run = launch({ executeTool });
    const native = await ready();
    const first = native.tool("write_file", { path: "first.txt", content: "first" }, "first");
    await entered.promise;
    const queued = native
      .tool("write_file", { path: "queued.txt", content: "queued" }, "queued")
      .catch((error: unknown) => error);
    native.finish();
    const late = native
      .tool("write_file", { path: "late.txt", content: "late" }, "late")
      .catch((error: unknown) => error);
    release.resolve();
    expect((await first).success).toBe(true);
    expect(await queued).toBeInstanceOf(Error);
    expect(await late).toBeInstanceOf(Error);
    await run.completed;
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("claims messages during work and steers the confirmed turn once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const incoming: AgentSteeringMessage[] = [];
    const claimSteering = vi.fn(async (seen: string[]) =>
      incoming.filter((message) => !seen.includes(message.id)),
    );
    const run = launch({ claimSteering });
    const native = await ready();
    incoming.push({
      id: "steering-1",
      messageId: "message-2",
      text: "Also include VAT.",
      origin: "user",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(native.params("turn/steer")).toMatchObject({
      threadId: native.threadId,
      expectedTurnId: native.turnId,
      input: [{ type: "text", text: "Also include VAT." }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.rpc.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
    native.finish("VAT included.");
    await run.completed;
    expect(run.events).toContainEqual({ type: "steered", fromRunUser: true });
  });

  it("iterator.return aborts a quiet pending next and closes both owned connections", async () => {
    const runtime = new CodexAgentRuntime({ stateRoot });
    const input = request();
    const stream = runtime.run(input);
    streams.push(stream);
    const next = stream.next();
    const native = await ready();
    await expect(stream.return()).resolves.toMatchObject({ done: true });
    await next;
    expect(bridgeOptions[0]!.signal.aborted).toBe(true);
    expect(native.params("turn/interrupt")).toMatchObject({
      threadId: native.threadId,
      turnId: native.turnId,
    });
    expect(native.close).toHaveBeenCalled();
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("runtime.abort cancels the native turn without yielding a successful done event", async () => {
    const run = launch();
    const native = await ready();
    await run.runtime.abort(run.input.runId);
    await run.completed;
    expect(native.params("turn/interrupt").turnId).toBe(native.turnId);
    expect(run.events.some((event) => event.type === "done")).toBe(false);
    expect(native.closed).toBe(true);
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("rejects an interruption that Rakazo did not request", async () => {
    const run = launch();
    const native = await ready();
    native.emit("turn/completed", { turn: { id: native.turnId, status: "interrupted" } });
    await expect(run.completed).rejects.toThrow("Native turn ended with status interrupted");
    expect(run.events.some((event) => event.type === "done")).toBe(false);
  });

  it("streams a terminating tool's final reply after earlier narration", async () => {
    const run = launch({
      executeTool: async () => terminatingToolResult("The receipt was delivered.", {}),
    });
    const native = await ready();
    native.emit("item/agentMessage/delta", {
      turnId: native.turnId,
      itemId: "narration",
      delta: "Preparing the reply.",
    });
    await native.tool("write_file", { path: "receipt.txt", content: "Receipt" }, "deliver");
    await run.completed;
    const text = run.events.flatMap((event) => (event.type === "text" ? [event.text] : []));
    expect(text).toEqual(["Preparing the reply.", "The receipt was delivered."]);
    expect(run.events).toContainEqual({ type: "done", text: "The receipt was delivered." });
  });

  it("closes a bridge created during cancellation without spawning the app-server", async () => {
    const created = deferred<void>();
    const release = deferred<void>();
    vi.mocked(createCodexModelBridge).mockImplementationOnce(async (options) => {
      bridgeOptions.push(options);
      created.resolve();
      await release.promise;
      return {
        baseUrl: "http://127.0.0.1:23456",
        token: "test-only-bridge-token",
        close: bridgeClose,
      };
    });
    onStart = (native) => native.finish();
    const run = launch();
    await created.promise;
    const cancelled = run.runtime.abort(run.input.runId);
    release.resolve();
    await cancelled;
    await run.completed;
    expect(vi.mocked(createCodexAppServer).mock.calls.length).toBe(0);
    expect(bridgeClose).toHaveBeenCalledOnce();
    expect(run.events.some((event) => event.type === "done")).toBe(false);
  });

  it("observes cancellation before the abort listener is installed", async () => {
    const controller = new AbortController();
    vi.mocked(createCodexAppServer).mockImplementationOnce((options = {}) => {
      const native = new NativeFixture(options);
      natives.push(native);
      controller.abort();
      return native;
    });
    onStart = (native) => native.finish();
    const run = launch({}, controller.signal);
    await run.completed;
    expect(natives[0]!.rpc).not.toHaveBeenCalled();
    expect(natives[0]!.close).toHaveBeenCalledOnce();
    expect(bridgeClose).toHaveBeenCalledOnce();
    expect(run.events.some((event) => event.type === "done")).toBe(false);
  });

  it("closes the bridge and reports a synchronous app-server creation failure", async () => {
    vi.mocked(createCodexAppServer).mockImplementationOnce(() => {
      throw new Error("Fixture app-server creation failed.");
    });
    const run = launch();
    await expect(run.completed).rejects.toThrow("Fixture app-server creation failed.");
    expect(bridgeClose).toHaveBeenCalledOnce();
  });

  it("pauses on ask_user and resumes its checkpoint without replaying a completed effect", async () => {
    let checkpoint = "";
    const executeTool = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({
      ok: true,
    }));
    const onCheckpoint = vi.fn(async (capture: () => string) => {
      checkpoint = capture();
    });
    const onToolCompleted = vi.fn<NonNullable<AgentRunRequest["onToolCompleted"]>>();
    const first = launch({ executeTool, onCheckpoint, onToolCompleted });
    const native = await ready();
    await native.tool(
      "write_file",
      { path: "draft.txt", content: "Approved draft." },
      "write-once",
    );
    const ask = await native.tool(
      "ask_user",
      {
        question: "Which format?",
        options: ["CSV", "JSON"],
      },
      "ask-format",
    );
    expect(ask.contentItems).toContainEqual({
      type: "inputText",
      text: "Waiting for the user's choice.",
    });
    await first.completed;
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "ask",
        text: "Which format?",
        actions: [
          { id: "choice-1", label: "CSV" },
          { id: "choice-2", label: "JSON" },
        ],
      }),
    );
    expect(first.events.some((event) => event.type === "done")).toBe(false);
    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ask_user",
        paused: true,
      }),
    );
    expect(native.order.indexOf("tool-result:ask-format")).toBeLessThan(
      native.order.indexOf("turn/interrupt"),
    );
    const restored = restoreTurnCheckpoint(checkpoint, model);
    expect(unresolvedTurnCheckpointCalls(restored.messages).map((call) => call.id)).toEqual([
      "ask-format",
    ]);
    expect(restored.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "write-once",
      }),
    );
    const second = launch({
      ...first.input,
      prompt: "Use CSV.",
      turnCheckpoint: checkpoint,
      resumeToolResult: { content: [{ type: "text", text: "CSV" }] },
    });
    const resumed = await ready(1);
    expect(resumed.params("thread/resume").threadId).toBe(native.threadId);
    expect(resumed.rpc.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(resumed.params("turn/start").input[0].text).toContain("CSV");
    resumed.finish("CSV selected.");
    await second.completed;
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(second.events.some((event) => event.type === "ask")).toBe(false);
    expect(second.events).toContainEqual({ type: "done", text: "CSV selected." });
  });
});
