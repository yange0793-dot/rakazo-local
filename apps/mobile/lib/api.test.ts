import { getArtifactById } from "./artifacts";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import type { RpcInput } from "@rakazo/contracts";
import { isServerUnreachable } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptAiConsent } from "./ai-consent";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  MAX_MOBILE_RPC_RESPONSE_BYTES,
  rpc,
  selectedSpaceId,
  setCachedApiBase,
  subscribeServerReachable,
} from "./api.js";
import { subscribeThread } from "./api-live.js";
import { loadApiBase, selectSpace } from "./api-server.js";
import { resumeLiveNotifications } from "./live-notifications.js";
import type { MobileModelCredential } from "./mobile-types.js";
import { changeLocalEndpoint, loadLocalInstallSessionId } from "./session.js";
import type { UnsentDisk } from "./thread-feedback.js";
import { configureUnsentSends } from "./thread-feedback.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { deferredFetch, jsonResponse, mockSecureStore, rpcErrorResponse } from "./api-test-helpers";

// whatwg-fetch exposes the buffered payload through Body methods without a body stream.
function bufferedResponse(body: string, { status = 200, headers }: ResponseInit = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: vi.fn(async () => new TextEncoder().encode(body).buffer),
  };
}

describe("mobile API requests", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset().mockResolvedValue(null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockResolvedValue(undefined);
    vi.mocked(SecureStore.deleteItemAsync).mockReset().mockResolvedValue(undefined);
    vi.mocked(resumeLiveNotifications).mockClear();
  });

  it("does not send a captured request after switching endpoints", async () => {
    const context = await captureApiRequestContext();
    await changeLocalEndpoint(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(rpc("bots/list", {}, { requestContext: context })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not move an ordinary request to a server selected during auth setup", async () => {
    const previous = currentApiBase();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const request = rpc("bots/list");
    try {
      setCachedApiBase("https://other.example.test");
      await expect(request).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      setCachedApiBase(previous);
    }
  });

  it("rejects a successful HTTP response that has no RPC result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    await expect(rpc("preferences/update", { locale: "en" })).rejects.toThrow();
  });

  it("reads a valid ordinary buffered RPC without a declared length", async () => {
    const response = bufferedResponse('{"json":[]}');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/list")).resolves.toEqual([]);
    expect(response.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("rejects an empty buffered 204 as an invalid RPC result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => bufferedResponse("", { status: 204 })),
    );

    await expect(rpc("bots/list")).rejects.toMatchObject({ cause: { name: "SyntaxError" } });
  });

  it("reports an rpc that hit its timeout as a timeout, not as a canceled fetch", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
  });

  it("reports a stalled rpc response body as a timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = rpc("computer/status", { botId: "bot" });
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a caller's cancellation with the caller's reason", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );

    const external = new AbortController();
    const pending = rpc("computer/status", { botId: "bot" }, { signal: external.signal });
    const rejection = expect(pending).rejects.toThrow("screen closed");
    await vi.advanceTimersByTimeAsync(0);
    external.abort(new Error("screen closed"));
    await rejection;
  });

  it("reads a slowly delivered Files detail body", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const artifact = { id: "artifact-1", size: 5, contentBase64: "aGVsbG8=" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        let timer: ReturnType<typeof setTimeout>;
        return new Response(
          new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ json: artifact })));
                controller.close();
              }, 20_000);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
        );
      }),
    );

    const result = getArtifactById("artifact-1").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual({ value: artifact });
  });

  describe.each([
    ["streaming", (body: string) => new Response(body)],
    ["buffered", bufferedResponse],
  ] as const)("%s artifact responses", (_mode, response) => {
    it.each([
      ["AQ==", 1],
      ["AQI=", 2],
      ["AQID", 3],
    ] as const)("accepts %s as a complete %i-byte file", async (contentBase64, size) => {
      const artifact = { id: "artifact-1", size, contentBase64 };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(JSON.stringify({ json: artifact }))),
      );

      await expect(getArtifactById("artifact-1")).resolves.toEqual(artifact);
    });

    it.each([
      ["size mismatch", { size: 6, contentBase64: "AQID" }],
      ["same encoded length with different padding", { size: 3, contentBase64: "AQI=" }],
      ["malformed encoding with matching apparent length", { size: 3, contentBase64: "AQ?D" }],
      ["missing size", { contentBase64: "AQID" }],
    ] as const)("rejects a small artifact with %s", async (_description, artifact) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(JSON.stringify({ json: artifact }))),
      );

      await expect(getArtifactById("artifact-1")).rejects.toMatchObject({
        message: "Incomplete artifact download",
        cause: { message: "Incomplete artifact download" },
      });
    });

    it.each([
      ["Files detail", () => getArtifactById("artifact-1")],
      ["direct chat", () => rpc("artifacts/get", { artifactId: "artifact-1", botId: "bot-1" })],
      ["group chat", () => rpc("artifacts/get", { artifactId: "artifact-1", groupId: "group-1" })],
    ] as const)("downloads a stored 13 MiB artifact from %s", async (_path, download) => {
      const bytes = Buffer.alloc(13 * 1024 * 1024, 123);
      bytes[bytes.length - 1] = 231;
      const artifact = {
        id: "artifact-1",
        name: '報告 ,"contentBase64": draft.pdf',
        size: bytes.length,
        contentBase64: bytes.toString("base64"),
      };
      const body = JSON.stringify({ json: artifact });
      expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_MOBILE_RPC_RESPONSE_BYTES);
      const fetch = vi.fn(async () => response(body));
      vi.stubGlobal("fetch", fetch);

      const result = await download();
      expect(result.name).toBe(artifact.name);
      expect(Buffer.from(result.contentBase64, "base64").equals(bytes)).toBe(true);
      // No current upload-limit lookup is needed for an artifact that was already stored.
      expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
      ["missing quartet", 4, 0],
      ["shorter decoded length with the same encoded length", 0, 1],
    ] as const)(
      "rejects a large incomplete artifact with %s",
      async (_description, missingCharacters, sizeIncrease) => {
        const bytes = Buffer.alloc(13 * 1024 * 1024);
        const encoded = bytes.toString("base64");
        const contentBase64 = encoded.slice(0, encoded.length - missingCharacters);
        const size = bytes.length + sizeIncrease;
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => response(JSON.stringify({ json: { size, contentBase64 } }))),
        );

        await expect(getArtifactById("artifact-1")).rejects.toMatchObject({
          message: "Incomplete artifact download",
          cause: { message: "Incomplete artifact download" },
        });
      },
    );

    it("preserves a null JSON envelope", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(JSON.stringify({ json: null }))),
      );
      await expect(getArtifactById("artifact-1")).resolves.toBeNull();
    });
  });

  it("bounds ordinary RPCs even when the reply looks like an artifact", async () => {
    const size = 13 * 1024 * 1024;
    const contentBase64 = Buffer.alloc(size).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ json: { size, contentBase64 } })),
    );

    await expect(rpc("bots/list")).rejects.toMatchObject({
      message: "Something went wrong. Try again.",
      cause: {
        name: "ResponseBodyTooLargeError",
        message: `Response body exceeds ${MAX_MOBILE_RPC_RESPONSE_BYTES} bytes`,
      },
    });
  });

  it("keeps the ordinary content-length cap for a buffered response", async () => {
    const response = bufferedResponse('{"json":[]}', {
      headers: { "content-length": String(MAX_MOBILE_RPC_RESPONSE_BYTES + 1) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/list")).rejects.toMatchObject({
      cause: { name: "ResponseBodyTooLargeError" },
    });
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it("bounds a buffered ordinary response by actual bytes without a declared length", async () => {
    const size = 13 * 1024 * 1024;
    const contentBase64 = Buffer.alloc(size).toString("base64");
    const response = bufferedResponse(JSON.stringify({ json: { size, contentBase64 } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/list")).rejects.toMatchObject({
      message: "Something went wrong. Try again.",
      cause: {
        name: "ResponseBodyTooLargeError",
        message: `Response body exceeds ${MAX_MOBILE_RPC_RESPONSE_BYTES} bytes`,
      },
    });
    expect(response.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("preserves a structured error from a buffered artifact response", async () => {
    const error = { code: "FORBIDDEN", status: 403, message: "You cannot open this artifact." };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        bufferedResponse(JSON.stringify({ json: error }), { status: error.status }),
      ),
    );
    await expect(getArtifactById("artifact-1")).rejects.toMatchObject(error);
  });

  it("times out while reading a stalled buffered artifact", async () => {
    vi.useFakeTimers();
    const response = bufferedResponse('{"json":null}');
    response.arrayBuffer.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const pending = getArtifactById("artifact-1");
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(response.arrayBuffer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it("times out and cancels a stalled Files detail body after the download budget", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );

    const pending = getArtifactById("artifact-1");
    const rejection = expect(pending).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(119_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("lets a call opt into a longer timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve(new Response(JSON.stringify({ json: { ok: true } }))), 20_000);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("computer/boot", { botId: "bot" }, { timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("publishes only reachability transitions and preserves transport causes", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeServerReachable(changed);
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockResolvedValueOnce(rpcErrorResponse(404, "NOT_FOUND", "Bot does not exist")),
    );
    try {
      expect(isServerUnreachable(await rpc("bots/list").catch((error) => error))).toBe(true);
      expect(isServerReachable()).toBe(false);
      await expect(rpc("bots/get", { botId: "bot-1" })).rejects.toThrow("Bot does not exist");
      expect(isServerReachable()).toBe(true);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("counts an rpc timeout as unreachable and a reopened live connection as reachable again", async () => {
    vi.useFakeTimers();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fetch failed: FetchRequestCanceledException")),
            );
          }),
      ),
    );
    const pending = rpc("threads/get", { botId: "bot" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(isServerUnreachable(await pending)).toBe(true);
    expect(isServerReachable()).toBe(false);

    const reachableAgain = vi.fn();
    const unsubscribe = subscribeServerReachable(reachableAgain);
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.close() }))),
      );
      await subscribeThread({ botId: "bot" }, -1, vi.fn(), new AbortController().signal);
      expect(isServerReachable()).toBe(true);
      expect(reachableAgain).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it("sends installation-scoped RPC input and reports structured RPC errors", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ json: { ok: true } }))
      .mockResolvedValueOnce(rpcErrorResponse(404, "NOT_FOUND", "Bot does not exist"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/get", { botId: "bot-1" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3100/rpc/bots/get",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-rakazo-install-id": await loadLocalInstallSessionId(),
        }),
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
    );
    await expect(rpc("bots/get", { botId: "missing" })).rejects.toThrow("Bot does not exist");
  });

  it("shows the server's message instead of the procedure name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcErrorResponse(400, "BAD_REQUEST", "Connect a model to start a run.")),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Connect a model to start a run."),
    );
  });

  it.each([
    ["an empty", new Response(null, { status: 404 })],
    [
      "an HTML",
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    ],
  ])("reports a failure with %s body without a parser error", async (_body, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(rpc("bots/create", { name: "Ada" })).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
  });

  it("sends model headers unchanged and reads names-only credential DTOs", async () => {
    const credential: MobileModelCredential = {
      id: "credential",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      headerNames: ["x-session"],
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ json: credential }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "custom",
      headers: { "x-session": "fake-session-secret" },
    };
    expect(await rpc("models/connect", input)).toEqual(credential);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ json: input });
    fetchMock.mockResolvedValueOnce(jsonResponse({ json: [credential] }));
    const listed = await rpc("models/credentials");
    expect(listed[0]?.headerNames).toEqual(["x-session"]);
    expect(JSON.stringify(listed)).not.toContain("fake-session-secret");
    await rpc("models/connect", { ...input, headers: undefined });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).json).not.toHaveProperty(
      "headers",
    );
    await rpc("models/connect", { ...input, headers: {} });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)).json.headers).toEqual({});
    await rpc("models/probeOpenAiCompatible", {
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)).json).toEqual({
      baseUrl: input.baseUrl,
      headers: input.headers,
      credentialId: credential.id,
    });
  });

  it("keeps the Space when a non-401 failure mentions unauthorized", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await selectSpace("space-support");
    const fetchMock = vi.fn(async () =>
      rpcErrorResponse(400, "BAD_REQUEST", "Model server returned 401 Unauthorized"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rpc("models/probeOpenAiCompatible", { baseUrl: "https://models.example.test" }),
    ).rejects.toThrow("Model server returned 401 Unauthorized");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(selectedSpaceId()).toBe("space-support");
    expect(store.get("rakazo.space_id")).toBe("space-support");
  });

  it("blocks mobile message and attachment submission when AI sharing is declined", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        json: {
          scope: "account-space",
          version: "2026-09-14",
          recipients: [
            { key: "provider", name: "Example AI", use: "model", detail: "", allowed: false },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (const proc of ["threads/send", "artifacts/create", "routines/create"] as const) {
      const body = { botId: "bot-1", text: "private content" } as RpcInput<typeof proc>;
      await expect(rpc(proc, body)).rejects.toThrow("AI data sharing");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain("/rpc/aiConsent/status");
      expect(init?.body).not.toContain("private content");
    }
  });

  it("asks about every mentioned routine's recipients before a combined send", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    // A paused routine on another bot is reported only by a check for that routine.
    const recipient = {
      key: "routine-model",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).json;
      return jsonResponse({
        json: {
          scope: "account-space",
          version: "2026-09-14",
          recipients: query.routineId === "routine-paused" ? [recipient] : [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      rpc("threads/sendWithRoutines", {
        botId: "bot-1",
        clientNonce: "nonce-1",
        text: "private content",
        routineIds: ["routine-active", "routine-paused"],
      }),
    ).rejects.toThrow("AI data sharing");
    expect(promptAiConsent).toHaveBeenCalledWith(recipient, undefined);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/rpc/aiConsent/status",
      "/rpc/aiConsent/status",
      "/rpc/aiConsent/status",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).json)).toEqual([
      { uses: ["model", "memory"], botId: "bot-1" },
      { uses: ["model", "memory"], routineId: "routine-active" },
      { uses: ["model", "memory"], routineId: "routine-paused" },
    ]);
  });

  it.each([true, false])("explains the mobile upgrade requirement with JSON=%s", async (json) => {
    const fetchMock = vi.fn(async () =>
      json
        ? rpcErrorResponse(404, "NOT_FOUND", "Not found")
        : new Response("404 Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["throws", "rejects", "stalls"])(
    "reports the upgrade message when body cancellation %s",
    async (mode) => {
      const cancel = vi.fn(() => {
        if (mode === "throws") throw new Error("cancel failed");
        if (mode === "rejects") return Promise.reject(new Error("cancel failed"));
        return new Promise<void>(() => {});
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ status: 404, body: { cancel } })),
      );
      await expect(rpc("threads/send", { botId: "bot" })).rejects.toThrow("Update your server");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("records mobile consent before submitting and uses the deployment policy URL", async () => {
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: path.endsWith("/status")
            ? {
                scope: "account-space",
                version: "2026-09-14",
                recipients: [recipient],
                privacyUrl: "https://example.com/privacy",
              }
            : { ok: true },
        });
      }),
    );
    await rpc("threads/send", { botId: "bot-1", text: "authorized content" });
    expect(calls).toEqual(["/rpc/aiConsent/status", "/rpc/aiConsent/allow", "/rpc/threads/send"]);
    expect(promptAiConsent).toHaveBeenLastCalledWith(recipient, "https://example.com/privacy");
  });

  it("coalesces concurrent mobile consent checks before sending each request once", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(true);
    const calls: string[] = [];
    const recipient = {
      key: "provider",
      name: "Example AI",
      use: "model",
      detail: "",
      allowed: false,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path.endsWith("/status"))
          return jsonResponse({
            json: {
              scope: "account-space",
              version: "2026-09-14",
              recipients: [recipient],
            },
          });
        return jsonResponse({ json: { ok: true } });
      }),
    );

    await Promise.all([
      rpc("threads/send", { botId: "bot-1", text: "first" }),
      rpc("threads/send", { botId: "bot-1", text: "second" }),
    ]);

    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/status"))).toHaveLength(2);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(1);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(2);
  });

  it("coalesces a concurrent refusal without granting or replaying the action", async () => {
    vi.mocked(promptAiConsent).mockClear();
    vi.mocked(promptAiConsent).mockResolvedValue(false);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        return jsonResponse({
          json: {
            scope: "account-space",
            version: "2026-09-14",
            recipients: [
              {
                key: "provider",
                name: "Example AI",
                use: "model",
                detail: "",
                allowed: false,
              },
            ],
          },
        });
      }),
    );

    const results = await Promise.allSettled([
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
      rpc("threads/send", { botId: "bot-1", text: "keep this draft" }),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(promptAiConsent).toHaveBeenCalledTimes(1);
    expect(calls.filter((path) => path.endsWith("/aiConsent/allow"))).toHaveLength(0);
    expect(calls.filter((path) => path.endsWith("/threads/send"))).toHaveLength(0);
  });

  it("rejects an oversized RPC response before parsing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { json: { ok: true } },
          { headers: { "content-length": String(MAX_MOBILE_RPC_RESPONSE_BYTES + 1) } },
        ),
      ),
    );

    await expect(rpc("bots/get", { botId: "bot-1" })).rejects.toThrow(
      new Error("Something went wrong. Try again."),
    );
  });

  it("keeps the Space selection when unauthorized is a session failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-support");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("spaces/list")).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-support");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("keeps a Space selected during unauthorized recovery when the retry succeeds", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    let resolveRetry!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("spaces/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(selectSpace("space-new")).resolves.toBe(true);
    resolveRetry(jsonResponse({ json: { spaces: [] } }));

    await expect(pending).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("keeps a Space selected during unauthorized recovery when the retry fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    let resolveRetry!: (value: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = rpc("spaces/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(selectSpace("space-new")).resolves.toBe(true);
    resolveRetry(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    await expect(pending).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("ignores a 401 from a request sent before the user switched Spaces", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-a"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-a");

    let resolveStale!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStale = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stale = rpc("bots/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-a");
    await expect(selectSpace("space-b")).resolves.toBe(true);
    resolveStale(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    // The stale request fails without probing or touching the new selection;
    // Space B's own requests run recovery if B is itself inaccessible.
    await expect(stale).rejects.toThrow("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("ignores a stale 401 after switching away and back to the same Space", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-a"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-a");

    let resolveStale!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStale = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stale = rpc("bots/list");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-a");
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    resolveStale(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));

    // ID-only matching would treat this obsolete Space A response as current
    // after A → B → A; the selection epoch must keep recovery from clearing
    // the newer Space A selection.
    await expect(stale).rejects.toThrow("Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("Network request failed"))],
    ["a server error", async () => rpcErrorResponse(503, "INTERNAL_SERVER_ERROR", "Unavailable")],
    ["a forbidden request", async () => rpcErrorResponse(403, "FORBIDDEN", "Forbidden")],
    [
      "a non-401 failure that mentions unauthorized",
      async () => rpcErrorResponse(400, "BAD_REQUEST", "Model server returned 401 Unauthorized"),
    ],
  ])("keeps the session after %s", async (_failure, respond) => {
    const store = new Map<string, string>([["rakazo.session_token", "session-token"]]);
    mockSecureStore(store);
    await loadApiBase();
    vi.stubGlobal("fetch", vi.fn(respond));
    await expect(rpc("bots/list")).rejects.toThrow();
  });

  it("re-persists a Space selected while recovery cleanup is in flight", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        await expect(selectSpace("space-new")).resolves.toBe(true);
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(injected).toBe(true);
    expect(selectedSpaceId()).toBe("space-new");
    expect(storage.get("rakazo.space_id")).toBe("space-new");
  });

  it("does not retry a mutating RPC against the default Space after Space auth failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/create", { name: "Wrong space bot" })).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/rpc/bots/create");
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/rpc/spaces/list");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("keeps the Space selection when a mutating RPC unauthorized is a session failure", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("bots/create", { name: "Should not land" })).rejects.toThrow("Unauthorized");
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/rpc/bots/create");
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-support");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/rpc/spaces/list");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });
});
