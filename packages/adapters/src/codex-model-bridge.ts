import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent, AgentUsage } from "@rakazo/adapter-kit";
import { DEFAULT_MODEL_MAX_TOKENS, parseModelHeaders } from "@rakazo/contracts";
import { withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { estimateTextTokens } from "./context-selection.js";
import { modelClientHeaders, tagMixRouterRequest } from "./model-client-headers.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";
import { maximumModelCallCost } from "./pi-usage.js";

export type CodexModelUsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }> & {
  runId: string;
  endpoint: "/responses" | "/responses/compact";
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  outcome: "completed" | "failed" | "aborted" | "incomplete";
  terminalType: string | null;
  nativeSessionId?: string;
  nativeRequestId?: string;
  dispatched: true;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseUsage(raw: unknown, providerRequestId: string | null): AgentUsage {
  const usage = record(raw);
  const input = count(usage.input_tokens);
  const cached = count(record(usage.input_tokens_details).cached_tokens);
  return {
    providerRequestId,
    inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    reasoningTokens: count(record(usage.output_tokens_details).reasoning_tokens),
    totalTokens: count(usage.total_tokens),
    costUsd: null,
    costSource: null,
    usageSource: raw ? "provider-reported-via-responses-bridge" : "responses-bridge-unavailable",
  };
}

/** One authenticated loopback bridge per run. onUsage owns producer-side accounting. */
export async function createCodexModelBridge(options: {
  request: AgentRunRequest;
  signal: AbortSignal;
  onUsage: (event: CodexModelUsageEvent) => Promise<void>;
  fetch?: typeof fetch;
}): Promise<{ baseUrl: string; token: string; close(): Promise<void> }> {
  const { request, signal } = options;
  const { model } = request;
  signal.throwIfAborted();
  const selected = resolveRuntimeModel(model);
  if (selected.model?.api !== "openai-responses") {
    throw new Error("The native runtime requires a Responses model connection.");
  }
  const resolved = selected.model;
  const customHeaders = model.headers ? parseModelHeaders(model.headers) : undefined;
  const policy = { allowPrivate: model.allowPrivateEndpoint };
  const upstream = assertAllowedOpenAiCompatibleUrl(resolved.baseUrl, policy);
  assertHttpsForKeyedOpenAiCompatibleUrl(
    upstream,
    model.apiKey,
    Boolean(model.headers && Object.keys(model.headers).length),
  );
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const fetchUpstream = createOpenAiCompatibleFetch(options.fetch, undefined, {
    ...policy,
    headers: customHeaders,
    modelStream: true,
  });
  const shutdown = new AbortController();
  const inflight = new Set<Promise<void>>();
  const accountingFailures: Error[] = [];
  let closing: Promise<void> | undefined;

  async function handle(incoming: IncomingMessage, outgoing: ServerResponse) {
    const credential = Buffer.from(incoming.headers.authorization ?? "");
    if (
      incoming.headers.origin ||
      credential.length !== authorization.length ||
      !timingSafeEqual(credential, authorization)
    ) {
      outgoing.writeHead(401).end();
      return;
    }
    if (incoming.method !== "POST") {
      outgoing.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (incoming.url !== "/responses" && incoming.url !== "/responses/compact") {
      outgoing.writeHead(404).end();
      return;
    }
    const endpoint = incoming.url;
    const disconnected = new AbortController();
    const callSignal = AbortSignal.any([signal, shutdown.signal, disconnected.signal]);
    const disconnect = () => {
      if (!outgoing.writableFinished) disconnected.abort();
    };
    outgoing.once("close", disconnect);
    incoming.once("aborted", disconnect);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelRead = () => {
      void reader?.cancel().catch(() => undefined);
    };
    callSignal.addEventListener("abort", cancelRead, { once: true });
    let reservation: string | undefined;
    let dispatched = false;
    let rawUsage: unknown;
    let providerRequestId: string | null = null;
    let httpStatus: number | null = null;
    let outcome: CodexModelUsageEvent["outcome"] = "failed";
    let terminalType: string | null = null;
    let startedAt = Date.now();
    const callId = randomUUID();
    const operationKind =
      endpoint === "/responses/compact" ? "compaction" : (request.usageOperationKind ?? "answer");
    const observer = model.callObserver;
    const observeId = async (id: unknown) => {
      if (providerRequestId || typeof id !== "string" || !id) return;
      providerRequestId = id;
      if (reservation !== undefined) await observer?.onRequestId?.(reservation, id);
    };
    const observe = async (value: unknown) => {
      const event = record(value);
      const response = event.response ? record(event.response) : event;
      await observeId(response.id);
      if (response.usage) rawUsage = response.usage;
      if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      ) {
        terminalType = event.type;
        outcome =
          event.type === "response.completed"
            ? "completed"
            : event.type === "response.incomplete"
              ? "incomplete"
              : "failed";
      }
    };

    try {
      callSignal.throwIfAborted();
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        callSignal.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
      let payload: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        payload = value as Record<string, unknown>;
      } catch {
        outgoing.writeHead(400).end(JSON.stringify({ error: "Expected a JSON object." }));
        return;
      }
      if (payload.model !== resolved.id) {
        outgoing.writeHead(400).end(
          JSON.stringify({
            error: "Native model does not match the run model.",
          }),
        );
        return;
      }
      const maxOutput = Math.min(
        count(payload.max_output_tokens) ||
          model.maxTokens ||
          resolved.maxTokens ||
          DEFAULT_MODEL_MAX_TOKENS,
        model.maxTokens ?? resolved.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      );
      if (endpoint === "/responses") payload.max_output_tokens = maxOutput;
      const body = JSON.stringify(payload);
      const estimatedInput = estimateTextTokens(body);
      callSignal.throwIfAborted();
      reservation = await observer?.beforeCall({
        callId,
        runId: request.runId,
        operationKind,
        provider: model.provider,
        modelId: resolved.id,
        inputTokensEstimate: estimatedInput,
        maxOutputTokens: maxOutput,
        maxCostUsd: maximumModelCallCost(resolved.cost, estimatedInput, maxOutput),
      });
      callSignal.throwIfAborted();
      const headers = new Headers({
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      });
      for (const [name, value] of Object.entries(
        tagMixRouterRequest(modelClientHeaders("openai-responses"), upstream.href),
      )) {
        if (typeof value === "string") headers.set(name, value);
      }
      for (const name of [
        "session-id",
        "session_id",
        "x-client-request-id",
        "x-codex-turn-metadata",
        "x-codex-turn-state",
      ]) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      if (model.apiKey) headers.set("authorization", `Bearer ${model.apiKey}`);
      startedAt = Date.now();
      dispatched = true;
      const response = await fetchUpstream(`${upstream.href.replace(/\/$/, "")}${endpoint}`, {
        method: "POST",
        headers,
        body,
        signal: callSignal,
      });
      httpStatus = response.status;
      reader = response.body?.getReader();
      outcome = response.ok ? "incomplete" : "failed";
      await observeId(
        response.headers.get("x-generation-id") ?? response.headers.get("x-request-id"),
      );
      const responseHeaders: Record<string, string> = { "cache-control": "no-store" };
      for (const name of [
        "content-type",
        "retry-after",
        "x-request-id",
        "x-generation-id",
        "x-codex-turn-state",
      ]) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.flushHeaders();
      const decoder = new TextDecoder();
      let buffer = "";
      const streaming = response.headers.get("content-type")?.includes("text/event-stream");
      const inspectFrame = async (frame: string) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        await observe(event);
      };
      while (reader) {
        callSignal.throwIfAborted();
        const chunk = await withAbort(reader.read(), callSignal);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (streaming) {
          let boundary = /\r?\n\r?\n/.exec(buffer);
          while (boundary?.index !== undefined) {
            await inspectFrame(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            boundary = /\r?\n\r?\n/.exec(buffer);
          }
        }
        if (!outgoing.write(chunk.value)) await once(outgoing, "drain", { signal: callSignal });
      }
      buffer += decoder.decode();
      if (streaming) await inspectFrame(buffer);
      else if (buffer.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(buffer);
        } catch {
          value = undefined;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          await observe(value);
          const object = record(value);
          if (response.ok && !object.error && terminalType === null) {
            terminalType = typeof object.status === "string" ? object.status : "json";
            outcome =
              object.status === "failed"
                ? "failed"
                : object.status === "incomplete"
                  ? "incomplete"
                  : "completed";
          }
        }
      }
      callSignal.throwIfAborted();
    } catch {
      // Native clients can close the stream as soon as they receive its terminal event.
      if (terminalType === null) outcome = callSignal.aborted ? "aborted" : "failed";
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(dispatched ? 502 : 503, { "content-type": "application/json" });
        outgoing.write(
          JSON.stringify({
            error: dispatched
              ? "Upstream model request failed."
              : "Model call was not authorized or could not start.",
            callId,
          }),
        );
      }
    } finally {
      const durationMs = Date.now() - startedAt;
      callSignal.removeEventListener("abort", cancelRead);
      incoming.removeListener("aborted", disconnect);
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const usage = { ...responseUsage(rawUsage, providerRequestId), operationKind };
      if (reservation !== undefined) {
        try {
          await observer?.afterCall(
            reservation,
            dispatched
              ? usage
              : {
                  ...usage,
                  inputTokens: 0,
                  outputTokens: 0,
                  costUsd: 0,
                  usageSource: "not-started",
                },
          );
        } catch {
          accountingFailures.push(new Error("Model bridge reservation settlement failed."));
        }
      }
      if (dispatched) {
        const receipt: CodexModelUsageEvent = {
          type: "usage",
          ...usage,
          provider: model.provider,
          model: resolved.id,
          callId,
          runId: request.runId,
          endpoint,
          startedAt: new Date(startedAt).toISOString(),
          durationMs,
          httpStatus,
          outcome,
          terminalType,
          nativeSessionId:
            typeof incoming.headers["session-id"] === "string"
              ? incoming.headers["session-id"]
              : typeof incoming.headers.session_id === "string"
                ? incoming.headers.session_id
                : undefined,
          nativeRequestId:
            typeof incoming.headers["x-client-request-id"] === "string"
              ? incoming.headers["x-client-request-id"]
              : undefined,
          dispatched: true,
        };
        try {
          await options.onUsage(receipt);
        } catch {
          accountingFailures.push(new Error("Model bridge usage persistence failed."));
        }
        getLogger().info("native runtime model call", {
          "run.id": receipt.runId,
          "call.id": callId,
          "runtime.id": "codex",
          "model.provider": model.provider,
          "model.id": resolved.id,
          endpoint,
          httpStatus,
          outcome,
          terminalType,
          durationMs: receipt.durationMs,
          providerRequestId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
      }
      outgoing.removeListener("close", disconnect);
      if (!outgoing.destroyed) outgoing.end();
    }
  }

  const server = createServer((incoming, outgoing) => {
    const work = handle(incoming, outgoing);
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => {
        inflight.delete(work);
        accountingFailures.push(new Error("Model bridge request cleanup failed."));
        outgoing.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Model bridge listener unavailable.");
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener("abort", abort);
      shutdown.abort();
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await stopped;
      while (inflight.size) await Promise.allSettled([...inflight]);
      if (accountingFailures.length)
        throw new AggregateError(accountingFailures, "Model bridge accounting failed.");
    })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, token, close };
}
