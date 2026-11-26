import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT, HEARTBEAT_MS, mergeStreams, withHeartbeats } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("withHeartbeats", () => {
  it("observes a pending read once across repeated heartbeats", async () => {
    vi.useFakeTimers();
    const read = deferred<IteratorResult<string>>();
    const observe = vi.spyOn(read.promise, "then");
    const source = (async function* (): AsyncGenerator<string> {})();
    source.next = () => read.promise;
    const stream = withHeartbeats({}, () => source);

    for (let i = 0; i < 3; i++) {
      const heartbeat = stream.next();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });
    }
    expect(observe).toHaveBeenCalledOnce();

    read.resolve({ done: false, value: "event" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "event" });
    await stream.return(undefined);
  });

  it("keeps the in-flight read across heartbeats so events stay in order", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reads = vi.fn();
    async function* follow() {
      reads();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield "first";
      yield "second";
    }
    const stream = withHeartbeats({}, follow);

    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });

    const first = stream.next();
    release?.();
    await expect(first).resolves.toEqual({ done: false, value: "first" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "second" });
    expect(reads).toHaveBeenCalledOnce();
    await stream.return(undefined);
  });

  it("holds no abort listener once each event is delivered", async () => {
    const request = new AbortController();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      for (let i = 0; i < 50; i++) yield i;
    });

    for (let i = 0; i < 50; i++) await stream.next();

    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    await stream.return(undefined);
  });

  it("does not start reading when the request has already aborted", async () => {
    const request = new AbortController();
    request.abort();
    const reads = vi.fn();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      reads();
      yield "event";
    });

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(reads).not.toHaveBeenCalled();
  });

  it("ends on revocation without waiting for a read the abort never lands on", async () => {
    vi.useFakeTimers();
    let sourceSignal: AbortSignal | undefined;
    const stillAuthorized = vi.fn(async () => false);
    const stream = withHeartbeats({ stillAuthorized }, async function* (signal) {
      sourceSignal = signal;
      await new Promise<never>(() => {});
      yield "never";
    });

    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(stillAuthorized).toHaveBeenCalledOnce();
    expect(sourceSignal?.aborted).toBe(true);
  });

  it("ends when the request aborts, without re-checking the session or waiting for the source", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const stillAuthorized = vi.fn(async () => true);
    const stream = withHeartbeats({ signal: request.signal, stillAuthorized }, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    request.abort();
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(stillAuthorized).not.toHaveBeenCalled();
  });
});

describe("mergeStreams", () => {
  it("observes a quiet stream once while another stream yields", async () => {
    const read = deferred<IteratorResult<string>>();
    const observe = vi.spyOn(read.promise, "then");
    const quiet = (async function* (): AsyncGenerator<string> {})();
    const next = quiet.next.bind(quiet);
    quiet.next = () => {
      quiet.next = next;
      return read.promise;
    };
    async function* busy() {
      yield 1;
      yield 2;
      yield 3;
    }
    const stream = mergeStreams(quiet, busy());

    for (const value of [1, 2, 3]) {
      await expect(stream.next()).resolves.toEqual({ done: false, value });
    }
    expect(observe).toHaveBeenCalledOnce();

    read.resolve({ done: false, value: "event" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "event" });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });
});
