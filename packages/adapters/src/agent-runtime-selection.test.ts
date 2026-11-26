import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRuntimeSelection,
  parseAgentRuntimeRoutes,
  resolveAgentRuntimeName,
} from "./agent-runtime-selection.js";

const mocks = vi.hoisted(() => {
  const runtime = (id: string): AgentRuntime => ({
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: {
        streaming: true,
        tools: true,
        compaction: id === "pi",
        scripted: id === "scripted",
      },
    }),
    run: vi.fn(async function* (): AsyncGenerator<AgentRuntimeEvent> {
      yield { type: "done", text: id };
    }),
    abort: vi.fn(async () => {}),
  });
  return {
    pi: runtime("pi"),
    scripted: runtime("scripted"),
    codex: runtime("codex"),
    piOptions: vi.fn(),
    codexOptions: vi.fn(),
    codexLoads: 0,
    log: vi.fn(),
  };
});
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ info: mocks.log }) }));
vi.mock("./pi-runtime.js", () => ({
  PiAgentRuntime: class {
    describe = mocks.pi.describe;
    run = mocks.pi.run;
    abort = mocks.pi.abort;
    constructor(options: unknown) {
      mocks.piOptions(options);
    }
  },
}));
vi.mock("./scripted-runtime.js", () => ({
  ScriptedAgentRuntime: class {
    describe = mocks.scripted.describe;
    run = mocks.scripted.run;
    abort = mocks.scripted.abort;
  },
}));
vi.mock("./codex-runtime.js", () => {
  mocks.codexLoads += 1;
  return {
    CodexAgentRuntime: class {
      describe = mocks.codex.describe;
      run = mocks.codex.run;
      abort = mocks.codex.abort;
      constructor(options: unknown) {
        mocks.codexOptions(options);
      }
    },
  };
});

function request(botId: string, runId = `${botId}:run`): AgentRunRequest {
  return {
    botId,
    runId,
    threadId: "thread",
    instructions: "instructions",
    prompt: "task",
    history: [],
    tools: [],
    model: { provider: "test-provider", id: "test-model" },
  };
}

async function collect(runtime: AgentRuntime, input: AgentRunRequest) {
  const events = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}

beforeEach(() => vi.clearAllMocks());

describe("agent runtime routes", () => {
  it("parses only an explicit bot-to-runtime object and defaults to no routes", () => {
    for (const value of [undefined, "", "  ", "{}"])
      expect(parseAgentRuntimeRoutes(value)).toEqual({});
    expect(parseAgentRuntimeRoutes('{"pilot":"codex","normal":"pi"}')).toEqual({
      pilot: "codex",
      normal: "pi",
    });
    for (const value of [
      "null",
      "[]",
      "1",
      "{bad",
      '{"pilot":"unknown"}',
      '{"pilot":null}',
      '{" ":"pi"}',
    ]) {
      expect(() => parseAgentRuntimeRoutes(value)).toThrow("AGENT_RUNTIME_ROUTES");
    }
  });

  it("resolves exact bot IDs without routing unrelated bots or inherited object names", () => {
    const routes = { pilot: "codex" } as const;
    expect(resolveAgentRuntimeName("pilot", routes)).toBe("codex");
    expect(resolveAgentRuntimeName("helper", routes)).toBe("pi");
    expect(resolveAgentRuntimeName("constructor", routes)).toBe("pi");
    expect(resolveAgentRuntimeName("other", routes, "scripted")).toBe("scripted");
    expect(resolveAgentRuntimeName("other", routes, "unknown")).toBe("pi");
  });

  it("retains default Pi/scripted and does not load Codex without a route", async () => {
    expect((await createAgentRuntimeSelection({ dataDir: "/data" })).describe().id).toBe("pi");
    expect(
      (
        await createAgentRuntimeSelection({ dataDir: "/data", defaultRuntime: "scripted" })
      ).describe().id,
    ).toBe("scripted");
    expect(
      (
        await createAgentRuntimeSelection({ dataDir: "/data", defaultRuntime: "unknown" })
      ).describe().id,
    ).toBe("pi");
    await createAgentRuntimeSelection({ dataDir: "/data", routes: { normal: "pi" } });
    expect(mocks.codexLoads).toBe(0);
    expect(mocks.codexOptions).not.toHaveBeenCalled();
  });

  it("routes only selected bots, retains the request/model/context, and uses the data directory", async () => {
    const runtime = await createAgentRuntimeSelection({
      dataDir: "/data",
      routes: { pilot: "codex" },
      piSessionRoot: "/pi-sessions",
    });
    const input = request("pilot");
    const context: Partial<AdapterContext> = { signal: new AbortController().signal };
    for await (const _event of runtime.run(input, context)) {
    }
    expect(mocks.codex.run).toHaveBeenCalledWith(input, context);
    expect(vi.mocked(mocks.codex.run).mock.calls[0]?.[0]).toBe(input);
    expect(mocks.piOptions).toHaveBeenCalledWith({ sessionRoot: "/pi-sessions" });
    expect(mocks.codexOptions).toHaveBeenCalledWith({ stateRoot: "/data/runtime-sessions/codex" });
    expect(await collect(runtime, request("normal"))).toEqual([{ type: "done", text: "pi" }]);
    expect(
      await collect(runtime, { ...request("helper"), prompt: "You are a background helper" }),
    ).toEqual([{ type: "done", text: "pi" }]);
    expect(mocks.log).toHaveBeenCalledWith(
      "agent runtime selected",
      expect.objectContaining({ "runtime.id": "codex" }),
    );
    expect(runtime.describe()).toMatchObject({
      id: "routed",
      capabilities: { scripted: false, compaction: false },
    });
  });

  it("allows an explicit Pi route while keeping the original scripted fallback", async () => {
    const runtime = await createAgentRuntimeSelection({
      dataDir: "/data",
      defaultRuntime: "scripted",
      routes: { pilot: "codex", normal: "pi" },
    });
    expect(await collect(runtime, request("normal"))).toEqual([{ type: "done", text: "pi" }]);
    expect(await collect(runtime, request("unrouted"))).toEqual([
      { type: "done", text: "scripted" },
    ]);
    expect(runtime.describe().capabilities.scripted).toBe(false);
  });

  it("aborts only the runtime owning each active run and forgets completed runs", async () => {
    const runtime = await createAgentRuntimeSelection({
      dataDir: "/data",
      routes: { pilot: "codex" },
    });
    const codex = runtime.run(request("pilot"))[Symbol.asyncIterator]();
    const pi = runtime.run(request("normal"))[Symbol.asyncIterator]();
    await codex.next();
    await pi.next();
    await runtime.abort("pilot:run");
    expect(mocks.codex.abort).toHaveBeenCalledExactlyOnceWith("pilot:run");
    expect(mocks.pi.abort).not.toHaveBeenCalled();
    await runtime.abort("normal:run");
    expect(mocks.pi.abort).toHaveBeenCalledExactlyOnceWith("normal:run");
    await codex.next();
    await pi.return?.();
    await runtime.abort("pilot:run");
    await runtime.abort("normal:run");
    await runtime.abort("unknown");
    expect(mocks.codex.abort).toHaveBeenCalledTimes(1);
    expect(mocks.pi.abort).toHaveBeenCalledTimes(1);
  });

  it("forwards iterator cancellation while a next call is pending", async () => {
    const runtime = await createAgentRuntimeSelection({
      dataDir: "/data",
      routes: { pilot: "codex" },
    });
    let finish: (value: IteratorResult<AgentRuntimeEvent>) => void = () => {};
    const pending = new Promise<IteratorResult<AgentRuntimeEvent>>((resolve) => {
      finish = resolve;
    });
    const returned = vi.fn(async () => {
      finish({ done: true, value: undefined });
      return { done: true as const, value: undefined };
    });
    vi.mocked(mocks.codex.run).mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => pending, return: returned }),
    }));
    const iterator = runtime.run(request("pilot"))[Symbol.asyncIterator]();
    const read = iterator.next();
    await iterator.return?.();
    expect(returned).toHaveBeenCalledTimes(1);
    expect((await read).done).toBe(true);
    await runtime.abort("pilot:run");
    expect(mocks.codex.abort).not.toHaveBeenCalled();
  });

  it("does not silently retry a failed routed run through Pi", async () => {
    const runtime = await createAgentRuntimeSelection({
      dataDir: "/data",
      routes: { pilot: "codex" },
    });
    vi.mocked(mocks.codex.run).mockImplementationOnce(async function* () {
      yield { type: "progress", text: "starting" };
      throw new Error("native failure");
    });
    await expect(collect(runtime, request("pilot"))).rejects.toThrow("native failure");
    expect(mocks.pi.run).not.toHaveBeenCalled();
    await runtime.abort("pilot:run");
    expect(mocks.codex.abort).not.toHaveBeenCalled();
  });
});
