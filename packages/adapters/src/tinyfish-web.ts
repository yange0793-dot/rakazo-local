import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import { isBlockedHostname, withAbort } from "./web-ssrf.js";

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai/";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai/";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullable().optional(),
      url: z.string().max(8_192),
      snippet: z.string().nullable().optional(),
      site_name: z.string().nullable().optional(),
    }),
  ),
});
const fetchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string().max(8_192),
      final_url: z.string().max(8_192).optional(),
      title: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    }),
  ),
  errors: z.array(z.object({ url: z.string().optional(), error: z.string() })).optional(),
});

export type TinyFishWebOptions = {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/** TinyFish-backed search and page extraction for Rakazo's built-in web tools. */
export class TinyFishWebProvider implements WebProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: TinyFishWebOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.TINYFISH_API_KEY ?? "").trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  describe() {
    return {
      id: "tinyfish",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: false, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const url = new URL(SEARCH_ENDPOINT);
    url.searchParams.set("query", query);
    const response = await this.request(
      url,
      undefined,
      context,
      request.signal,
      this.options.searchTimeoutMs ?? 30_000,
    );
    const parsed = searchResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error("Invalid TinyFish search response");
    return parsed.data.results
      .flatMap((result): WebSearchHit[] => {
        const safeUrl = publicPageUrl(result.url);
        if (!safeUrl) return [];
        return [
          {
            url: safeUrl,
            title: result.title?.trim().slice(0, 1_000) || result.site_name?.trim() || safeUrl,
            snippet: result.snippet?.slice(0, 8_000) ?? "",
          },
        ];
      })
      .slice(0, clampMaxResults(request.maxResults));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const safeUrl = requestedPublicUrl(request.url);
    const raw = await this.request(
      new URL(FETCH_ENDPOINT),
      { urls: [safeUrl.href], format: "markdown", per_url_timeout_ms: 110_000 },
      context,
      request.signal,
      this.options.fetchTimeoutMs ?? 120_000,
    );
    const parsed = fetchResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid TinyFish fetch response");
    const page = parsed.data.results[0];
    if (!page) {
      throw new Error(
        `TinyFish page fetch failed: ${parsed.data.errors?.[0]?.error ?? "no content"}`,
      );
    }
    const pageUrl = publicPageUrl(page.final_url ?? page.url);
    if (!pageUrl) throw new Error("TinyFish returned an invalid page URL");
    const text = page.text ?? "";
    if (!/\S/.test(text)) throw new Error("TinyFish returned empty page content");
    return {
      url: pageUrl,
      title: page.title?.trim().slice(0, 1_000) || pageUrl,
      ...pageWindow(text.slice(offset), maxChars, offset),
    };
  }

  private signal(
    context: AdapterContext,
    requestSignal: AbortSignal | undefined,
    timeoutMs: number,
  ) {
    const parent = requestSignal ? combineSignals(context.signal, requestSignal) : context.signal;
    parent.throwIfAborted();
    return combineSignals(parent, AbortSignal.timeout(timeoutMs));
  }

  private async request(
    url: URL,
    body: Record<string, unknown> | undefined,
    context: AdapterContext,
    requestSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.apiKey)
      throw new Error("TinyFish is selected but TINYFISH_API_KEY is not configured");
    const signal = this.signal(context, requestSignal, timeoutMs);
    const response = await withAbort(
      this.fetchImpl(url, {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: {
          "X-API-Key": this.apiKey,
          "User-Agent": USER_AGENT,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      }),
      signal,
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`TinyFish request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }
}

function publicPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !isBlockedHostname(url.hostname)
    )
      return url.href;
  } catch {
    /* Malformed provider URLs are not usable citations. */
  }
  return undefined;
}

function requestedPublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Only http: and https: URLs are allowed");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  if (isBlockedHostname(url.hostname)) throw new Error("URL targets a private or internal host");
  // TinyFish resolves and rejects private destinations on its fetch service; local DNS here may
  // be a synthetic proxy resolver and is not authoritative for the remote fetch destination.
  return url;
}
