import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServer, CodexAppServerOptions } from "./codex-app-server.js";
import { CodexAppServerRpcError, createCodexAppServer } from "./codex-app-server.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const connections: CodexAppServer[] = [];

function fakeProcess(options: { stubborn?: boolean; cannotKill?: boolean; noPid?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: options.noPid ? undefined : 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_: string) => true),
  });
  const received: Array<Record<string, any>> = [];
  let buffer = "";
  let exited = false;
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      received.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const exit = (code = 0) => {
    if (exited) return;
    exited = true;
    child.emit("exit", code, null);
    child.stdout.end();
    child.stderr.end();
  };
  child.stdin.on("finish", () => {
    if (!options.stubborn) exit();
  });
  child.kill.mockImplementation((signal) => {
    if (!options.cannotKill && (signal === "SIGKILL" || !options.stubborn)) exit();
    return true;
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  return {
    child,
    received,
    exit,
    push: (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`),
  };
}

function open(options: CodexAppServerOptions = {}) {
  const connection = createCodexAppServer(options);
  connections.push(connection);
  return connection;
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Codex app-server transport", () => {
  it("uses an owned stdio process, overrides its environment, and leaves initialization to the caller", async () => {
    const server = fakeProcess();
    const client = open({
      binary: "/opt/agent/bin/codex",
      args: ["app-server", "--listen", "stdio://"],
      cwd: "/workspace/project",
      env: { CODEX_HOME: "/workspace/agent-state" },
    });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/agent/bin/codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        cwd: "/workspace/project",
        env: { ...process.env, CODEX_HOME: "/workspace/agent-state" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      }),
    );
    expect(server.received).toEqual([]);
    const initialized = client.request<{ version: string }>("initialize", {
      clientInfo: { name: "test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    server.push({ id: server.received[0]!.id, result: { version: "test" } });
    await expect(initialized).resolves.toEqual({ version: "test" });
    client.notify("initialized", {});
    expect(server.received[1]).toEqual({ method: "initialized", params: {} });
    expect(client.closed).toBe(false);
  });

  it("correlates out-of-order ACKs independently from asynchronous server requests with the same id", async () => {
    const server = fakeProcess();
    const tool = deferred<unknown>();
    const onServerRequest = vi.fn<NonNullable<CodexAppServerOptions["onServerRequest"]>>(
      () => tool.promise,
    );
    const onNotification = vi.fn();
    const client = open({ onServerRequest, onNotification });
    const first = client.request("thread/start", {});
    const second = client.request("turn/start", {});
    const firstId = server.received[0]!.id;
    const secondId = server.received[1]!.id;
    server.push({
      id: firstId,
      method: "item/tool/call",
      params: { tool: "read_file", arguments: { path: "README.md" } },
    });
    server.push({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
    server.push({ id: secondId, result: { turn: { id: "turn" } } });
    server.push({ id: firstId, result: { thread: { id: "thread" } } });
    await expect(second).resolves.toEqual({ turn: { id: "turn" } });
    await expect(first).resolves.toEqual({ thread: { id: "thread" } });
    expect(onServerRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: firstId, method: "item/tool/call" }),
      expect.any(AbortSignal),
    );
    expect(onNotification).toHaveBeenCalledOnce();
    expect(server.received).toHaveLength(2);
    tool.resolve({ success: true, contentItems: [] });
    await tool.promise;
    expect(server.received[2]).toEqual({
      id: firstId,
      result: { success: true, contentItems: [] },
    });
  });

  it("does not impose the ACK timeout on long-running host tools or block notifications", async () => {
    vi.useFakeTimers();
    const server = fakeProcess();
    const tool = deferred<unknown>();
    const onNotification = vi.fn();
    const client = open({ onServerRequest: () => tool.promise, onNotification });
    server.push({ id: "server-1", method: "item/tool/call", params: { tool: "shell" } });
    await vi.advanceTimersByTimeAsync(120_000);
    server.push({ method: "item/started", params: { itemId: "work" } });
    expect(client.closed).toBe(false);
    expect(onNotification).toHaveBeenCalledOnce();
    expect(server.received).toEqual([]);
    tool.resolve({ success: true });
    await tool.promise;
    expect(server.received).toEqual([{ id: "server-1", result: { success: true } }]);
  });

  it("parses fragmented UTF-8 JSONL and returns remote RPC errors with their code", async () => {
    const server = fakeProcess();
    const onNotification = vi.fn();
    const client = open({ onNotification });
    const wire = Buffer.from(
      `${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "\u4f60" } })}\r\n`,
    );
    const split = wire.indexOf(Buffer.from("\u4f60")) + 1;
    server.child.stdout.write(wire.subarray(0, split));
    expect(onNotification).not.toHaveBeenCalled();
    server.child.stdout.write(wire.subarray(split));
    expect(onNotification).toHaveBeenCalledWith({
      method: "item/agentMessage/delta",
      params: { delta: "\u4f60" },
    });
    const request = client.request("turn/steer", {});
    const rejected = expect(request).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32600,
      message: "Turn is not active",
      data: { reason: "inactive" },
    });
    server.push({
      id: server.received[0]!.id,
      error: { code: -32600, message: "Turn is not active", data: { reason: "inactive" } },
    });
    await rejected;
  });

  it("times out only the matching ACK without resending and ignores late ACKs", async () => {
    vi.useFakeTimers();
    const server = fakeProcess();
    const client = open();
    const first = client.request("turn/start", {}, 10);
    const second = client.request("thread/read", {}, 0);
    const rejected = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    server.push({ id: server.received[0]!.id, result: { late: true } });
    await vi.advanceTimersByTimeAsync(60_000);
    server.push({ id: server.received[1]!.id, result: { thread: "present" } });
    await expect(second).resolves.toEqual({ thread: "present" });
    expect(server.received).toHaveLength(2);
    expect(client.closed).toBe(false);
  });

  it("replies to failed callbacks without leaking their exception and preserves explicit RPC errors", async () => {
    const server = fakeProcess();
    open({
      onServerRequest: async ({ method }) => {
        if (method === "unsupported") throw new CodexAppServerRpcError(-32601, "Not supported.");
        throw new Error("private-config-value");
      },
    });
    server.push({ id: "failed-tool", method: "item/tool/call", params: {} });
    server.push({ id: "unsupported-tool", method: "unsupported", params: {} });
    await Promise.resolve();
    expect(server.received).toEqual([
      { id: "failed-tool", error: { code: -32603, message: "Client request handler failed." } },
      { id: "unsupported-tool", error: { code: -32601, message: "Not supported." } },
    ]);
    expect(JSON.stringify(server.received)).not.toContain("private-config-value");
  });

  it("exit rejects all pending requests, aborts callbacks and reports only one sanitized exit", async () => {
    const server = fakeProcess();
    const tool = deferred<unknown>();
    const onServerRequest = vi.fn<NonNullable<CodexAppServerOptions["onServerRequest"]>>(
      () => tool.promise,
    );
    const onExit = vi.fn();
    const client = open({ onServerRequest, onExit });
    const first = client.request("thread/read");
    const second = client.request("turn/start");
    const firstRejected = expect(first).rejects.toThrow("exited");
    const secondRejected = expect(second).rejects.toThrow("exited");
    server.push({ id: "tool", method: "item/tool/call", params: {} });
    const signal = onServerRequest.mock.calls[0]![1];
    server.child.stderr.write("private-config-value");
    server.exit(7);
    await Promise.all([firstRejected, secondRejected]);
    expect(signal.aborted).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    expect(onExit.mock.calls[0]![0].message).toBe("Codex app-server exited (7).");
    expect(client.closed).toBe(true);
    await expect(client.request("thread/read")).rejects.toThrow("exited");
    tool.resolve({ success: true });
    await tool.promise;
    expect(server.received).toHaveLength(2);
  });

  it("close cancels a pending callback immediately, is idempotent, and ignores late rejection", async () => {
    const server = fakeProcess();
    const tool = deferred<unknown>();
    const onServerRequest = vi.fn<NonNullable<CodexAppServerOptions["onServerRequest"]>>(
      () => tool.promise,
    );
    const onExit = vi.fn();
    const client = open({ onServerRequest, onExit });
    server.push({ id: "tool", method: "item/tool/call", params: {} });
    const pending = client.request("thread/read");
    const rejected = expect(pending).rejects.toThrow("closed");
    const closing = client.close();
    expect(client.close()).toBe(closing);
    expect(onServerRequest.mock.calls[0]![1].aborted).toBe(true);
    await Promise.all([closing, rejected]);
    tool.reject(new Error("late failure"));
    await tool.promise.catch(() => undefined);
    expect(onExit).not.toHaveBeenCalled();
    expect(server.child.kill).not.toHaveBeenCalled();
    expect(server.received).toHaveLength(1);
  });

  it("abort rejects requests and only terminates its owned child, escalating when it ignores EOF and TERM", async () => {
    vi.useFakeTimers();
    const server = fakeProcess({ stubborn: true });
    const unrelated = { kill: vi.fn() };
    const controller = new AbortController();
    const onExit = vi.fn();
    const client = open({ signal: controller.signal, onExit });
    const request = client.request("turn/interrupt");
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(client.closed).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await client.close();
    expect(server.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(unrelated.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts cleanup once when an aborted host callback reenters close", async () => {
    const server = fakeProcess();
    const tool = deferred<unknown>();
    let reentered: Promise<void> | undefined;
    const client = open({
      onServerRequest: (_request, signal) => {
        signal.addEventListener("abort", () => {
          reentered = client.close();
        });
        return tool.promise;
      },
    });
    server.push({ id: "tool", method: "item/tool/call", params: {} });
    const end = vi.spyOn(server.child.stdin, "end");
    const closing = client.close();
    expect(reentered).toBe(closing);
    await closing;
    expect(end).toHaveBeenCalledOnce();
    tool.resolve({ success: true });
    await tool.promise;
    expect(server.received).toEqual([]);
  });

  it("fails promptly for spawn failure and rejects malformed frames without logging them", async () => {
    const server = fakeProcess({ noPid: true });
    const onExit = vi.fn();
    const client = open({ onExit });
    const request = client.request("initialize");
    const rejected = expect(request).rejects.toThrow("process failed");
    server.child.emit("error", new Error("spawn /private-config-value ENOENT"));
    await rejected;
    await client.close();
    expect(server.child.kill).not.toHaveBeenCalled();
    expect(onExit.mock.calls[0]![0].message).not.toContain("private-config-value");

    const invalid = fakeProcess();
    const invalidExit = vi.fn();
    const invalidClient = open({ onExit: invalidExit });
    invalid.child.stdout.write("private-config-value\n");
    await invalidClient.close();
    expect(invalidExit.mock.calls[0]![0].message).toBe(
      "Codex app-server returned invalid JSON-RPC.",
    );
  });

  it("does not spawn when already aborted and bounds shutdown even if killing cannot be confirmed", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => createCodexAppServer({ signal: controller.signal })).toThrow("aborted");
    expect(spawn).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const server = fakeProcess({ stubborn: true, cannotKill: true });
    const client = open();
    const closing = client.close();
    const rejected = expect(closing).rejects.toThrow("did not exit");
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(server.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(server.child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
