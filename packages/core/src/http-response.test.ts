import { describe, expect, it, vi } from "vitest";
import {
  isUnauthorizedError,
  ResponseBodyTooLargeError,
  readBoundedJsonResponse,
} from "./http-response.js";

describe("readBoundedJsonResponse", () => {
  it("checks the actual UTF-8 byte count for a buffered body", async () => {
    const json = '{"name":"caf\u00e9"}';
    const bytes = new TextEncoder().encode(json);
    const response = new Response(null);
    const read = vi.spyOn(response, "arrayBuffer").mockResolvedValue(bytes.buffer);

    await expect(readBoundedJsonResponse(response, bytes.byteLength)).resolves.toEqual({
      name: "caf\u00e9",
    });
    await expect(readBoundedJsonResponse(response, bytes.byteLength - 1)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not read a buffered body with an oversized declared length", async () => {
    const response = new Response(null, { headers: { "content-length": "65" } });
    const read = vi.spyOn(response, "arrayBuffer");

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("does not start a buffered read after the signal has aborted", async () => {
    const response = new Response(null);
    const read = vi.spyOn(response, "arrayBuffer");
    const reason = new Error("request canceled");

    await expect(readBoundedJsonResponse(response, 64, AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a pending buffered read on abort and discards its late result", async () => {
    const response = new Response(null);
    let finish!: (bytes: ArrayBuffer) => void;
    vi.spyOn(response, "arrayBuffer").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const reason = new Error("request timed out");
    const pending = readBoundedJsonResponse(response, 64, controller.signal);
    const rejection = expect(pending).rejects.toBe(reason);
    controller.abort(reason);

    await rejection;
    finish(new TextEncoder().encode('{"ok":true}').buffer);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects an empty 204 response as missing JSON", async () => {
    await expect(
      readBoundedJsonResponse(new Response(null, { status: 204 }), 64),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("parses a fragmented JSON response", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":'));
          controller.enqueue(encoder.encode("true}"));
          controller.close();
        },
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects and cancels a response with an oversized declared length", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "65" },
    });

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("rejects and cancels a streamed response that crosses the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65));
        },
        cancel,
      }),
    );

    await expect(readBoundedJsonResponse(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("aborts a stalled body read", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const pending = readBoundedJsonResponse(response, 64, controller.signal);

    controller.abort(new Error("request timed out"));

    await expect(pending).rejects.toThrow("request timed out");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not read a body once the request is already aborted", async () => {
    const signal = AbortSignal.abort(new Error("request timed out"));

    await expect(readBoundedJsonResponse(new Response('{"ok":true}'), 64, signal)).rejects.toThrow(
      "request timed out",
    );
  });

  it("rejects malformed JSON after a complete bounded read", async () => {
    await expect(readBoundedJsonResponse(new Response("not-json"), 64)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});

describe("isUnauthorizedError", () => {
  it("recognizes only a 401 status", () => {
    expect(isUnauthorizedError({ status: 401 })).toBe(true);
    expect(isUnauthorizedError({ status: 403 })).toBe(false);
    expect(isUnauthorizedError(new Error("401"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});
