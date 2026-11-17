import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalMemoryIndex,
  MAX_LOCAL_MEMORY_RESPONSE_BYTES,
  MAX_LOCAL_MEMORY_TEXT_BYTES,
} from "./local-memory-index.js";
import { dispatcherFetch } from "./undici-fetch.js";

vi.mock("./undici-fetch.js", () => ({ dispatcherFetch: vi.fn() }));

const baseUrl = "http://127.0.0.1:17676";
const token = "synthetic-token-for-unit-tests-only-0001";
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", baseUrl);
  vi.mocked(dispatcherFetch).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("local memory index client", () => {
  it("is lazy and sends authenticated, deadline-bound no-redirect requests", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const ambient = vi.fn();
    vi.stubGlobal("fetch", ambient);
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example.test:3128");
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    expect(transport).not.toHaveBeenCalled();
    await index.health(signal());
    expect(ambient).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(
      `${baseUrl}/health`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
        dispatcher: expect.any(Object),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }),
    );
  });

  it("returns only authority candidates even when an endpoint supplies indexed text", async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json({
        candidates: [
          {
            id: "fact-a",
            revision: 2,
            score: 0.8,
            content: "Do not return indexed text",
            namespace: "foreign",
          },
        ],
      }),
    );
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(
      index.search({ namespace: "space-a:bot-a", query: "synthetic project", limit: 5 }, signal()),
    ).resolves.toEqual([{ id: "fact-a", revision: 2, score: 0.8 }]);
    expect(transport.mock.calls[0]?.[0]).toBe(`${baseUrl}/search`);
  });

  it("preserves stable exact index ids for repeated upserts and deletes", async () => {
    const transport = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    const input = {
      namespace: "space-a",
      indexId: "fact-a:2",
      id: "fact-a",
      revision: 2,
      content: "Synthetic preference.",
    };
    await index.upsert(input, signal());
    await index.upsert(input, signal());
    expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(input));
    expect(transport.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(input));
    expect(transport.mock.calls[0]?.[1]?.dispatcher).not.toBe(
      transport.mock.calls[1]?.[1]?.dispatcher,
    );
    await index.remove({ namespace: "space-a", indexId: "fact-a:2" }, signal());
    expect(transport.mock.calls[2]?.[0]).toBe(`${baseUrl}/delete`);
    expect(transport.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ namespace: "space-a", indexId: "fact-a:2" }),
    );
  });

  it("revalidates policy before sending credentials on an existing client", async () => {
    const transport = vi.fn();
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    vi.stubEnv("RAKAZO_LOCAL_MEMORY_ALLOWED_URLS", "");
    await expect(index.health(signal())).rejects.toThrow(/allowlist/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated configuration without any request", () => {
    const transport = vi.fn();
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    expect(() => createLocalMemoryIndex({ baseUrl, token: "short" })).toThrow(/token/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds external inputs before a request", async () => {
    const transport = vi.fn();
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(
      index.search({ namespace: "space-a", query: "q", limit: 51 }, signal()),
    ).rejects.toThrow(/limit/);
    await expect(
      index.upsert(
        {
          namespace: "space-a",
          indexId: "fact-a:1",
          id: "fact-a",
          revision: 1,
          content: "a".repeat(MAX_LOCAL_MEMORY_TEXT_BYTES + 1),
        },
        signal(),
      ),
    ).rejects.toThrow(/too large/);
    await expect(
      index.upsert(
        {
          namespace: "space-a",
          indexId: "fact-a:1",
          id: "fact-a",
          revision: 1.5,
          content: "synthetic",
        },
        signal(),
      ),
    ).rejects.toThrow(/revision/);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { candidates: [{ id: "fact-a", revision: 0, score: 0.8 }] },
    { candidates: [{ id: "fact-a", revision: 1, score: 1.2 }] },
    { candidates: [{ id: "fact-a", revision: 1, score: "0.8" }] },
    { candidates: [{ id: "", revision: 1, score: 0.8 }] },
    { candidates: null },
    {
      candidates: [
        { id: "fact-a", revision: 1, score: 0.8 },
        { id: "fact-b", revision: 1, score: 0.7 },
      ],
    },
  ])("rejects malformed or excessive candidates %#", async (data) => {
    vi.mocked(dispatcherFetch).mockResolvedValue(Response.json(data));
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(
      index.search({ namespace: "space-a", query: "q", limit: 1 }, signal()),
    ).rejects.toThrow(/candidate/);
  });

  it("does not expose an error response body or treat a success error shell as healthy", async () => {
    const transport = vi
      .fn()
      .mockImplementationOnce(async () => new Response("private body", { status: 401 }))
      .mockImplementationOnce(async () => Response.json({ error: "unavailable" }));
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(index.health(signal())).rejects.toThrow(
      "Local memory index request failed (401).",
    );
    await expect(index.health(signal())).rejects.toThrow(/acknowledgement/);
  });

  it("does not repeat an untrusted body in a JSON parsing error", async () => {
    vi.mocked(dispatcherFetch).mockResolvedValue(new Response("private malformed body"));
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(index.health(signal())).rejects.toThrow(
      "Local memory index returned invalid JSON.",
    );
  });

  it("caps declared and streamed responses", async () => {
    const transport = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response("{}", {
            headers: { "Content-Length": String(MAX_LOCAL_MEMORY_RESPONSE_BYTES + 1) },
          }),
      )
      .mockImplementationOnce(
        async () => new Response("x".repeat(MAX_LOCAL_MEMORY_RESPONSE_BYTES + 1)),
      );
    vi.mocked(dispatcherFetch).mockImplementation(transport);
    const index = createLocalMemoryIndex({ baseUrl, token });
    await expect(index.health(signal())).rejects.toThrow(/too large/);
    await expect(index.health(signal())).rejects.toThrow(/too large/);
  });

  it("honors cancellation even if the transport ignores its signal", async () => {
    vi.mocked(dispatcherFetch).mockImplementation(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const index = createLocalMemoryIndex({ baseUrl, token });
    const response = index.health(controller.signal);
    controller.abort(new Error("synthetic cancellation"));
    await expect(response).rejects.toThrow("synthetic cancellation");
  });
});
