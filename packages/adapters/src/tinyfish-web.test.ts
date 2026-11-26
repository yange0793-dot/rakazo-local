import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { TinyFishWebProvider } from "./tinyfish-web.js";
import { MAX_WEB_FETCH_OFFSET } from "./web-limits.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
describe("TinyFish web provider", () => {
  it("maps TinyFish search hits to Rakazo web_search results", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.search.tinyfish.ai/");
      expect(url.searchParams.get("query")).toBe("latest Rakazo release");
      expect(init?.headers).toMatchObject({ "X-API-Key": "test-key" });
      expect(init?.redirect).toBe("error");
      return Response.json({
        results: [
          {
            title: "Rakazo releases",
            url: "https://example.test/releases",
            snippet: "Latest release notes",
          },
          { title: "Unsafe", url: "file:///etc/passwd", snippet: "ignored" },
        ],
      });
    });
    const provider = new TinyFishWebProvider({ apiKey: "test-key", fetch });
    await expect(
      webSearchFromTool(provider, context, { query: "latest Rakazo release", maxResults: 1 }),
    ).resolves.toEqual({
      results: [
        {
          title: "Rakazo releases",
          url: "https://example.test/releases",
          snippet: "Latest release notes",
        },
      ],
    });
  });

  it("fetches and windows page markdown through TinyFish", async () => {
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({
        urls: ["https://example.test/page"],
        format: "markdown",
        per_url_timeout_ms: 110_000,
      });
      expect(init?.headers).toMatchObject({ "X-API-Key": "test-key" });
      return Response.json({
        results: [
          {
            url: "https://example.test/page",
            final_url: "https://example.test/final",
            title: "Page",
            text: "0123456789".repeat(30),
          },
        ],
        errors: [],
      });
    });
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      fetch,
      fetchTimeoutMs: 5_000,
    });
    await expect(
      webFetchFromTool(provider, context, {
        url: "https://example.test/page",
        maxChars: 100,
        offset: 100,
      }),
    ).resolves.toEqual({
      url: "https://example.test/final",
      title: "Page",
      text: `${"0123456789".repeat(10)}\n\n[Content truncated; continue with offset 200]`,
      truncated: true,
    });
  });

  it("reports missing configuration and TinyFish fetch errors", async () => {
    vi.stubEnv("TINYFISH_API_KEY", "");
    try {
      await expect(new TinyFishWebProvider().search({ query: "q" }, context)).rejects.toThrow(
        "TINYFISH_API_KEY is not configured",
      );
    } finally {
      vi.unstubAllEnvs();
    }
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      fetch: async () => Response.json({ results: [], errors: [{ error: "bot_blocked" }] }),
    });
    await expect(provider.fetch({ url: "https://example.test/page" }, context)).rejects.toThrow(
      "TinyFish page fetch failed: bot_blocked",
    );
  });

  it("rejects internal URLs before disclosing them to TinyFish", async () => {
    const fetch = vi.fn();
    const provider = new TinyFishWebProvider({ apiKey: "test-key", fetch });
    await expect(provider.fetch({ url: "http://127.0.0.1/private" }, context)).rejects.toThrow(
      "URL targets a private or internal host",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 502])("aborts a stalled response body after HTTP %i headers", async (status) => {
    let markBodyClosed!: () => void;
    const bodyClosed = new Promise<void>((resolve) => {
      markBodyClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.once("close", markBodyClosed);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.write('{"results":');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      let requestSignal: AbortSignal | null | undefined;
      let receivedHeaders = false;
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        requestSignal = init?.signal;
        const response = await globalThis.fetch(`http://127.0.0.1:${port}/`, init);
        receivedHeaders = true;
        return response;
      };
      const provider = new TinyFishWebProvider({
        apiKey: "test-key",
        fetch,
        searchTimeoutMs: 1_000,
      });

      await expect(provider.search({ query: "offline" }, context)).rejects.toThrow();
      expect(receivedHeaders).toBe(true);
      expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
      await bodyClosed;
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  });

  it("reads a multibyte body through the largest supported character offset", async () => {
    const url = "https://example.test/page";
    const tail = "Final page content";
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          results: [{ url, text: `${"\u00e9".repeat(MAX_WEB_FETCH_OFFSET)}${tail}` }],
        }),
    });
    await expect(
      provider.fetch({ url, offset: MAX_WEB_FETCH_OFFSET, maxChars: 100 }, context),
    ).resolves.toMatchObject({ text: tail, truncated: false });
  });

  it("keeps the existing diagnostic window for a large HTTP error body", async () => {
    const detail = "x".repeat(1_000);
    const provider = new TinyFishWebProvider({
      apiKey: "test-key",
      fetch: async () => new Response(`${detail}${"y".repeat(100_000)}`, { status: 502 }),
    });
    await expect(provider.search({ query: "offline" }, context)).rejects.toMatchObject({
      message: `TinyFish request failed (502): ${detail}`,
    });
  });
});
