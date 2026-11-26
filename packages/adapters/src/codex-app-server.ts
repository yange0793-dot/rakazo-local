import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexAppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerRequest extends CodexAppServerNotification {
  id: string | number;
}

export interface CodexAppServerOptions {
  binary?: string;
  args?: string[];
  cwd?: string;
  /** Overrides inherited process environment entries without changing global configuration. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** No timeout: a host tool can wait until it finishes or the connection closes. */
  onServerRequest?: (
    request: CodexAppServerRequest,
    signal: AbortSignal,
  ) => unknown | Promise<unknown>;
  onNotification?: (notification: CodexAppServerNotification) => void;
  /** Called once on unexpected connection loss or abort; not on explicit close. */
  onExit?: (error: Error) => void;
}

export interface CodexAppServer {
  /** Timeout covers this request's ACK only; zero disables the timeout. Never retries. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Cancels callbacks and pending requests, then waits for the owned process to exit. */
  close(): Promise<void>;
  readonly closed: boolean;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

const CLOSE_GRACE_MS = 1_000;

/** Only transport: the caller owns initialization, threads, turns and tool semantics. */
export function createCodexAppServer(options: CodexAppServerOptions = {}): CodexAppServer {
  if (options.signal?.aborted) throw abortError();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      options.binary ?? "codex",
      options.args ?? ["app-server", "--listen", "stdio://"],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
  } catch {
    throw new Error("Could not spawn Codex app-server.");
  }

  const callbacks = new AbortController();
  const pending = new Map<number, PendingRequest>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0;
  let closedError: Error | undefined;
  let closePromise: Promise<void> | undefined;
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function seal(error: Error) {
    if (closedError) return;
    closedError = error;
    options.signal?.removeEventListener("abort", onAbort);
    callbacks.abort(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function fail(error: Error) {
    if (closedError) return;
    seal(error);
    // close remains awaitable by the owner; do not leave a rejected cleanup promise unobserved.
    void close().catch(() => undefined);
    options.onExit?.(error);
  }

  function onAbort() {
    fail(abortError());
  }

  function write(message: unknown) {
    if (closedError) throw closedError;
    const line = `${JSON.stringify(message)}\n`;
    try {
      child.stdin.write(line, (error) => {
        if (error) fail(new Error("Codex app-server input stream failed."));
      });
    } catch {
      const error = new Error("Codex app-server input stream failed.");
      fail(error);
      throw error;
    }
  }

  function request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (closedError) return Promise.reject(closedError);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      return Promise.reject(new Error("Request timeout must be a nonnegative finite number."));
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const waiting: PendingRequest = { resolve: (value) => resolve(value as T), reject };
      if (timeoutMs > 0) {
        waiting.timer = setTimeout(() => {
          pending.delete(id);
          const error = new Error(`Codex ${method} acknowledgement timed out; nothing was resent.`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }
      pending.set(id, waiting);
      try {
        write({ id, method, params });
      } catch (error) {
        clearTimeout(waiting.timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function respond(message: CodexAppServerRequest) {
    let response:
      | { result: unknown }
      | { error: { code: number; message: string; data?: unknown } };
    try {
      if (!options.onServerRequest)
        throw new CodexAppServerRpcError(-32601, "Client method is not supported.");
      const result = await options.onServerRequest(message, callbacks.signal);
      response = { result: result ?? null };
    } catch (error) {
      response = {
        error:
          error instanceof CodexAppServerRpcError
            ? { code: error.code, message: error.message, data: error.data }
            : { code: -32603, message: "Client request handler failed." },
      };
    }
    if (closedError) return;
    try {
      write({ id: message.id, ...response });
    } catch {
      fail(new Error("Could not send the Codex client request response."));
    }
  }

  lines.on("line", (line) => {
    if (closedError || !line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch {
      // Never include the raw wire payload or stderr in diagnostic errors.
      fail(new Error("Codex app-server returned invalid JSON-RPC."));
      return;
    }
    if (typeof message.method === "string") {
      const notification = { method: message.method, params: message.params };
      if (Object.hasOwn(message, "id")) {
        if (typeof message.id !== "number" && typeof message.id !== "string") {
          fail(new Error("Codex app-server returned an invalid request id."));
          return;
        }
        // Server request ids occupy a separate namespace, even when they equal our ACK ids.
        void respond({ ...notification, id: message.id });
      } else {
        try {
          options.onNotification?.(notification);
        } catch {
          fail(new Error("Codex notification handler failed."));
        }
      }
      return;
    }
    const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id as number);
    clearTimeout(waiting.timer);
    const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | null;
    if (error && typeof error.code === "number" && typeof error.message === "string") {
      waiting.reject(new CodexAppServerRpcError(error.code, error.message, error.data));
    } else if (Object.hasOwn(message, "result")) {
      waiting.resolve(message.result);
    } else {
      waiting.reject(new Error("Codex returned a response without a valid result or error."));
    }
  });

  child.stdin.on("error", () => fail(new Error("Codex app-server input stream failed.")));
  child.stdout.on("error", () => fail(new Error("Codex app-server output stream failed.")));
  child.stderr.on("error", () => fail(new Error("Codex app-server diagnostic stream failed.")));
  child.stderr.resume();
  lines.on("close", () => fail(new Error("Codex app-server output stream closed.")));
  child.on("exit", (code, signal) => {
    exited = true;
    resolveExit();
    fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"}).`));
  });
  child.on("error", () => {
    if (!child.pid) {
      exited = true;
      resolveExit();
    }
    fail(new Error("Codex app-server process failed."));
  });

  async function waitForExit() {
    if (exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_GRACE_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    // Publish the promise before aborting host callbacks, which may call close again.
    closePromise = Promise.resolve().then(async () => {
      try {
        child.stdin.end();
        await waitForExit();
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          if (exited) break;
          child.kill(signal);
          await waitForExit();
        }
        if (!exited) throw new Error("Codex app-server did not exit after shutdown.");
      } finally {
        lines.close();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    seal(new Error("Codex app-server connection closed."));
    return closePromise;
  }

  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return {
    request,
    notify: (method, params) => write({ method, params }),
    close,
    get closed() {
      return closedError !== undefined;
    },
  };
}

function abortError() {
  const error = new Error("Codex app-server connection aborted.");
  error.name = "AbortError";
  return error;
}
