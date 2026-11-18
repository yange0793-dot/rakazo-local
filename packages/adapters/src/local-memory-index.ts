import { cancelResponseBody, readResponseWithin, withAbort } from "@rakazo/core";
import { assertLocalMemoryEndpointAllowed } from "./local-memory-endpoint.js";

export const LOCAL_MEMORY_PROVIDER_ID = "local";
export const MAX_LOCAL_MEMORY_TEXT_BYTES = 40 * 1024;
export const MAX_LOCAL_MEMORY_CANDIDATES = 50;
export const MAX_LOCAL_MEMORY_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Recall runs before every direct turn, so it needs its own short deadline: an index that is up
 * but stuck (embedding lock, ONNX stall) must cost a few seconds, not the full write timeout.
 */
const SEARCH_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 256 * 1024;

export interface LocalMemoryCandidate {
  id: string;
  revision: number;
  score: number;
}

export interface LocalMemoryIndex {
  search(
    request: { namespace: string; query: string; limit: number },
    signal: AbortSignal,
  ): Promise<LocalMemoryCandidate[]>;
  upsert(
    request: { namespace: string; indexId: string; id: string; revision: number; content: string },
    signal: AbortSignal,
  ): Promise<void>;
  remove(request: { namespace: string; indexId: string }, signal: AbortSignal): Promise<void>;
  health(signal: AbortSignal): Promise<void>;
}

function boundedText(value: string, name: string, maxBytes: number): void {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw new Error(`Local memory ${name} is empty, too large or contains a NUL.`);
  }
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Credentials are only used after the exact memory-only endpoint policy is checked. */
export function createLocalMemoryIndex(
  config: { baseUrl: string; token: string },
  options: { allowedUrls?: string } = {},
): LocalMemoryIndex {
  const baseUrl = assertLocalMemoryEndpointAllowed(config.baseUrl, options.allowedUrls);
  const token = config.token.trim();
  if (!/^[A-Za-z0-9._~+/-]{32,512}$/.test(token)) {
    throw new Error("Local memory token must contain 32–512 bearer-token characters.");
  }

  async function request(
    path: string,
    body: object | undefined,
    signal: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    assertLocalMemoryEndpointAllowed(baseUrl, options.allowedUrls);
    const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    abort.throwIfAborted();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("Local memory request is too large.");
    }
    // A fresh direct dispatcher prevents ambient proxies from receiving local credentials/content.
    const [{ Agent }, { dispatcherFetch }] = await Promise.all([
      import("undici"),
      import("./undici-fetch.js"),
    ]);
    abort.throwIfAborted();
    assertLocalMemoryEndpointAllowed(baseUrl, options.allowedUrls);
    const dispatcher = new Agent();
    try {
      const response = await withAbort(
        dispatcherFetch(`${baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: payload,
          redirect: "error",
          signal: abort,
          ...{ dispatcher },
        }),
        abort,
      );
      if (!response.ok) {
        cancelResponseBody(response);
        // Never surface an endpoint's body: it may contain indexed text or credentials.
        throw new Error(`Local memory index request failed (${response.status}).`);
      }
      const bytes = await readResponseWithin(response, {
        maxBytes: MAX_LOCAL_MEMORY_RESPONSE_BYTES,
        tooLargeMessage: "Local memory index response is too large.",
        signal: abort,
      });
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        // JSON parser diagnostics may repeat an untrusted response body.
        throw new Error("Local memory index returned invalid JSON.");
      }
    } finally {
      await dispatcher.destroy();
    }
  }

  async function acknowledged(
    path: string,
    body: object | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await request(path, body, signal);
    if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) {
      throw new Error("Local memory index returned an invalid acknowledgement.");
    }
  }

  return {
    async search(input, signal) {
      boundedText(input.namespace, "namespace", 512);
      boundedText(input.query, "query", MAX_LOCAL_MEMORY_TEXT_BYTES);
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_LOCAL_MEMORY_CANDIDATES
      ) {
        throw new Error(`Local memory limit must be between 1 and ${MAX_LOCAL_MEMORY_CANDIDATES}.`);
      }
      const response = await request("/search", input, signal, SEARCH_TIMEOUT_MS);
      const candidates =
        response && typeof response === "object"
          ? (response as { candidates?: unknown }).candidates
          : undefined;
      if (!Array.isArray(candidates) || candidates.length > input.limit) {
        throw new Error("Local memory index returned invalid candidates.");
      }
      return candidates.map((candidate: unknown) => {
        if (!candidate || typeof candidate !== "object") {
          throw new Error("Local memory index returned an invalid candidate.");
        }
        const row = candidate as { id?: unknown; revision?: unknown; score?: unknown };
        if (
          typeof row.id !== "string" ||
          !row.id.trim() ||
          row.id.includes("\0") ||
          Buffer.byteLength(row.id, "utf8") > 256 ||
          typeof row.revision !== "number" ||
          !validRevision(row.revision) ||
          typeof row.score !== "number" ||
          !Number.isFinite(row.score) ||
          row.score < 0 ||
          row.score > 1
        ) {
          throw new Error("Local memory index returned an invalid candidate.");
        }
        return { id: row.id, revision: row.revision, score: row.score };
      });
    },
    async upsert(input, signal) {
      boundedText(input.namespace, "namespace", 512);
      boundedText(input.indexId, "indexId", 256);
      boundedText(input.id, "id", 256);
      boundedText(input.content, "content", MAX_LOCAL_MEMORY_TEXT_BYTES);
      if (!validRevision(input.revision))
        throw new Error("Local memory revision must be a positive integer.");
      await acknowledged("/upsert", input, signal);
    },
    async remove(input, signal) {
      boundedText(input.namespace, "namespace", 512);
      boundedText(input.indexId, "indexId", 256);
      await acknowledged("/delete", input, signal);
    },
    async health(signal) {
      await acknowledged("/health", undefined, signal);
    },
  };
}
