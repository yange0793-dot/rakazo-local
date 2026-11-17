import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider-id.js";

/** Per-attempt wait for response headers; this does not cap active streaming duration. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/** Bound connection establishment independently of response streaming. */
export const MODEL_CONNECT_TIMEOUT_MS = 30_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. Bound silence for every provider so a stalled stream can fail
 * and advance the configured fallback chain.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;

/**
 * Options for an undici `Agent` that carries model streams. undici otherwise drops a
 * response after 5 minutes without headers or body data, which caps the timeouts
 * above and fails as a bare "terminated". The SDK's `timeoutMs` and the stream idle
 * watchdog bound both waits instead.
 */
export const MODEL_STREAM_AGENT_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

/**
 * Parse a configurable timeout in whole milliseconds. Invalid or blank values
 * retain the existing default. Node timers support delays up to 2^31 - 1 ms.
 * Provider HTTP transports may impose additional independent limits.
 */
function timeoutMsFromEnv(
  value: string | undefined,
  fallback: number,
  min: number = 1_000,
  max: number = 300_000,
): number {
  const raw = Number(value?.trim() || fallback);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function modelStreamTimeoutMs(): number {
  return timeoutMsFromEnv(
    process.env.MODEL_STREAM_TIMEOUT_MS,
    MODEL_STREAM_TIMEOUT_MS,
    1_000,
    2_147_483_647,
  );
}

export function modelConnectTimeoutMs(): number {
  return timeoutMsFromEnv(process.env.MODEL_CONNECT_TIMEOUT_MS, MODEL_CONNECT_TIMEOUT_MS);
}

export function modelStreamIdleTimeoutMs(): number {
  return timeoutMsFromEnv(
    process.env.MODEL_STREAM_IDLE_TIMEOUT_MS,
    MODEL_STREAM_IDLE_TIMEOUT_MS,
    0,
    2_147_483_647,
  );
}

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Share one remaining character budget across all text parts.
 * Later text is omitted once the aggregate limit is exhausted; non-text parts stay.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): T[] {
  let remaining = limit;
  const clipped: T[] = [];
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      !("type" in part) ||
      (part as { type?: unknown }).type !== "text" ||
      !("text" in part)
    ) {
      clipped.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const text = String((part as { text: unknown }).text);
    if (text.length <= remaining) {
      clipped.push(part);
      remaining -= text.length;
      continue;
    }
    clipped.push({ ...part, text: clipToolResultText(text, remaining) });
    remaining = 0;
  }
  return clipped;
}

/**
 * Prompt tokens providers bill, including cache read/write rather than the uncached remainder.
 * The cache halves are reported alongside so downstream views can show what a cache hit saved.
 */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheReadTokens = nonNegativeCount(usage.cacheRead);
  const cacheWriteTokens = nonNegativeCount(usage.cacheWrite);
  return {
    inputTokens: nonNegativeCount(usage.input) + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonNegativeCount(usage.output),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** Reasoning models share the same uncapped default: thinking and the reply draw on one budget. */
export const REASONING_MODEL_MAX_TOKENS = DEFAULT_MODEL_MAX_TOKENS;

/** Leave at least three quarters of the window for input; token limits are positive integers. */
export function effectiveOutputReserve(contextWindow: number, maxTokens: number): number {
  return Math.min(maxTokens, Math.max(1, Math.floor(contextWindow / 4)));
}

/**
 * The output cap the operator chose for a model that has no per-connection field: the local
 * model server's own limit, when RAKAZO_LOCAL_MAX_TOKENS is set. Unset, and for other providers,
 * the defaults apply.
 */
export function operatorMaxTokens(
  model: Pick<Model<Api>, "provider" | "maxTokens">,
): number | undefined {
  return model.provider === LOCAL_PROVIDER_ID && process.env.RAKAZO_LOCAL_MAX_TOKENS?.trim()
    ? model.maxTokens
    : undefined;
}

/**
 * Completions add no output cap of their own: a model runs up to its own ceiling unless a
 * connection (or the operator) sets a limit, and the context window still reserves room for
 * input by trimming output to a quarter of it. Reasoning models share thinking and reply
 * budget, so they get the same uncapped default.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
  contextWindow?: number,
  operatorDefault?: number,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : operatorDefault !== undefined && operatorDefault >= 1
        ? operatorDefault
        : reasoning
          ? REASONING_MODEL_MAX_TOKENS
          : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  const maxTokens =
    typeof modelMaxTokens === "number" && modelMaxTokens >= 1
      ? Math.min(modelMaxTokens, optionCap)
      : optionCap;
  return contextWindow === undefined ? maxTokens : effectiveOutputReserve(contextWindow, maxTokens);
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
