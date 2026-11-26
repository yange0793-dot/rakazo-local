import { describe, expect, it, vi } from "vitest";
import { loadPageRuntime } from "./page-runtime";
import { saveServerHeaders } from "./server-headers";

vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async () => {}),
  deleteItemAsync: vi.fn(async () => {}),
}));

describe("loadPageRuntime", () => {
  it("fetches the runtime with the headers configured for that server", async () => {
    const base = "https://protected.example.test";
    await saveServerHeaders(base, { "x-proxy-access": "fixture" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("kit"));
    try {
      await expect(loadPageRuntime(base, fetcher)).resolves.toBe("kit");
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
      expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-proxy-access")).toBe("fixture");
    } finally {
      await saveServerHeaders(base, {});
    }
  });

  it("shares one fetch per server at a time and retries after a failed fetch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("runtime-a"))
      .mockResolvedValueOnce(new Response("runtime-b"));
    await expect(loadPageRuntime("https://one.example.test", fetcher)).rejects.toThrow("503");
    const [first, again] = [
      loadPageRuntime("https://one.example.test", fetcher),
      loadPageRuntime("https://one.example.test/", fetcher),
    ];
    await expect(first).resolves.toBe("runtime-a");
    await expect(again).resolves.toBe("runtime-a");
    await expect(loadPageRuntime("http://192.168.1.20:5173", fetcher)).resolves.toBe("runtime-b");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://one.example.test/api/v1/assets/page-runtime.js",
      "https://one.example.test/api/v1/assets/page-runtime.js",
      "http://192.168.1.20:5173/api/v1/assets/page-runtime.js",
    ]);
  });

  it("revalidates with the server on each use, so an upgraded server's kit is picked up", async () => {
    const base = "https://upgrade.example.test";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("kit-v1", { headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response("kit-v2", { headers: { etag: '"v2"' } }));
    await expect(loadPageRuntime(base, fetcher)).resolves.toBe("kit-v1");
    await expect(loadPageRuntime(base, fetcher)).resolves.toBe("kit-v1");
    await expect(loadPageRuntime(base, fetcher)).resolves.toBe("kit-v2");
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      undefined,
      { "if-none-match": '"v1"' },
      { "if-none-match": '"v1"' },
    ]);
  });
});
