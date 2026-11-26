import type { AgentRunRequest, ModelCallObserver } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelUsageEvent } from "./codex-model-bridge.js";
import { createCodexModelBridge } from "./codex-model-bridge.js";
import { CODEX_CLIENT_HEADERS } from "./model-client-headers.js";
import * as runtimeModels from "./pi-runtime-models.js";

const logs = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("@rakazo/logging", () => ({ getLogger: () => logs }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function input(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "task",
    instructions: "instructions",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "test-model",
      apiProtocol: "responses",
      baseUrl: "https://models.example.test/v1",
      apiKey: "upstream-secret",
      maxTokens: 1234,
      headers: { "x-test-header": "host-only-value" },
    },
  };
}

function completed(id = "response-1") {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 60 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 120,
      },
    },
  };
}

const sse = (value: unknown) =>
  `event: response.completed\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

async function fixture(fetcher: typeof fetch, request = input(), observer?: ModelCallObserver) {
  const events: CodexModelUsageEvent[] = [];
  const controller = new AbortController();
  if (observer) request.model.callObserver = observer;
  const bridge = await createCodexModelBridge({
    request,
    signal: controller.signal,
    onUsage: async (event) => {
      events.push(event);
    },
    fetch: fetcher,
  });
  cleanups.push(bridge.close);
  const post = (
    path = "/responses",
    body: unknown = { model: "test-model", input: "private prompt", stream: true },
  ) =>
    fetch(`${bridge.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { ...bridge, controller, post, events };
}

describe("native runtime model bridge", () => {
  it("relays Responses SSE, uses host credentials/model, and accounts one actual HTTP call", async () => {
    const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "reservation");
    const afterCall = vi.fn(async () => {});
    const onRequestId = vi.fn(async () => {});
    const wire = sse(completed());
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
    const bridge = await fixture(fetcher, input(), { beforeCall, afterCall, onRequestId });
    const result = await bridge.post();
    expect(await result.text()).toBe(wire);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://models.example.test/v1/responses");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(headers.get("x-test-header")).toBe("host-only-value");
    expect(headers.get("user-agent")).toBe(CODEX_CLIENT_HEADERS["user-agent"]);
    expect(headers.get("originator")).toBe(CODEX_CLIENT_HEADERS.originator);
    expect(headers.get("authorization")).not.toContain(bridge.token);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "test-model",
      max_output_tokens: 1234,
    });
    expect(beforeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run",
        provider: "openai-compatible",
        modelId: "test-model",
        maxOutputTokens: 1234,
      }),
    );
    expect(onRequestId).toHaveBeenCalledExactlyOnceWith("reservation", "response-1");
    expect(afterCall).toHaveBeenCalledExactlyOnceWith(
      "reservation",
      expect.objectContaining({ inputTokens: 40, cacheReadTokens: 60 }),
    );
    expect(bridge.events).toHaveLength(1);
    expect(bridge.events[0]).toMatchObject({
      type: "usage",
      runId: "run",
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 60,
      reasoningTokens: 5,
      totalTokens: 120,
      costUsd: null,
      httpStatus: 200,
      outcome: "completed",
      terminalType: "response.completed",
      dispatched: true,
    });
    expect(bridge.events[0]?.callId).toBe(beforeCall.mock.calls[0]?.[0].callId);
    const logged = JSON.stringify(logs.info.mock.calls);
    for (const secret of ["upstream-secret", "host-only-value", "private prompt", bridge.token])
      expect(logged).not.toContain(secret);
  });

  it("gives native retries separate call IDs, including failures, without inventing token counts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection failed upstream-secret"))
      .mockResolvedValueOnce(json({ error: "busy" }, 429))
      .mockResolvedValueOnce(json(completed("response-3").response));
    const beforeCall = vi.fn(async () => "reservation");
    const afterCall = vi.fn(async () => {});
    const bridge = await fixture(fetcher, input(), { beforeCall, afterCall });
    const failed = await bridge.post();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("upstream-secret");
    expect((await bridge.post()).status).toBe(429);
    await (await bridge.post()).text();
    await bridge.close();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(beforeCall).toHaveBeenCalledTimes(3);
    expect(afterCall).toHaveBeenCalledTimes(3);
    expect(bridge.events).toHaveLength(3);
    expect(new Set(bridge.events.map((event) => event.callId)).size).toBe(3);
    expect(bridge.events.map((event) => event.httpStatus)).toEqual([null, 429, 200]);
    expect(bridge.events[0]).toMatchObject({ inputTokens: null, costUsd: null, outcome: "failed" });
  });

  it("uses the resolved Responses API, model ID, and endpoint when raw settings omit the protocol", async () => {
    const request = input();
    const resolved = runtimeModels.resolveRuntimeModel({
      ...request.model,
      id: "route/fixture-model",
      baseUrl: "https://resolved.example.test/v1",
    });
    request.model.apiProtocol = undefined;
    request.model.id = "catalog-reference";
    vi.spyOn(runtimeModels, "resolveRuntimeModel").mockReturnValueOnce(resolved);
    const fetcher = vi.fn<typeof fetch>(async () => json(completed().response));
    const beforeCall = vi.fn(async () => "reservation");
    const bridge = await fixture(fetcher, request, { beforeCall, afterCall: async () => {} });
    expect((await bridge.post("/responses", { model: request.model.id, input: [] })).status).toBe(
      400,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const response = await bridge.post("/responses", { model: "route/fixture-model", input: [] });
    expect(response.status).toBe(200);
    await response.text();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://resolved.example.test/v1/responses");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe("route/fixture-model");
    expect(beforeCall).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "route/fixture-model" }),
    );
    expect(bridge.events[0]?.model).toBe("route/fixture-model");
  });

  it("preserves a configured routing alias and rejects a stripped model ID", async () => {
    const request = input();
    request.model.id = "route/fixture-model";
    const fetcher = vi.fn<typeof fetch>(async () => json(completed().response));
    const bridge = await fixture(fetcher, request);
    expect((await bridge.post("/responses", { model: "fixture-model", input: [] })).status).toBe(
      400,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const response = await bridge.post("/responses", { model: request.model.id, input: [] });
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).model).toBe(request.model.id);
    expect(bridge.events[0]?.model).toBe(request.model.id);
  });

  it("rejects a resolved non-Responses API even when raw settings say responses", async () => {
    const request = input();
    const resolved = runtimeModels.resolveRuntimeModel({
      ...request.model,
      apiProtocol: "anthropic-messages",
    });
    vi.spyOn(runtimeModels, "resolveRuntimeModel").mockReturnValueOnce(resolved);
    const fetcher = vi.fn<typeof fetch>();
    await expect(fixture(fetcher, request)).rejects.toThrow("Responses");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accounts compact JSON as a separate compaction request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(completed("compact-1").response));
    const bridge = await fixture(fetcher);
    await (await bridge.post("/responses/compact", { model: "test-model", input: [] })).text();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://models.example.test/v1/responses/compact",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).max_output_tokens).toBeUndefined();
    expect(bridge.events[0]).toMatchObject({
      operationKind: "compaction",
      inputTokens: 40,
      providerRequestId: "compact-1",
    });
  });

  it("rejects unauthorized methods/paths/input without any upstream call or receipt", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bridge = await fixture(fetcher);
    expect(
      (await fetch(`${bridge.baseUrl}/responses`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${bridge.baseUrl}/responses`, {
          headers: { authorization: `Bearer ${bridge.token}` },
        })
      ).status,
    ).toBe(405);
    expect((await bridge.post("/other")).status).toBe(404);
    expect((await bridge.post("/responses", [])).status).toBe(400);
    expect((await bridge.post("/responses", { model: "different", input: [] })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(bridge.events).toEqual([]);
  });

  it("honors beforeCall refusal and does not count it as an upstream invocation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const beforeCall = vi.fn(async () => {
      throw new Error("not enough credits");
    });
    const afterCall = vi.fn(async () => {});
    const bridge = await fixture(fetcher, input(), { beforeCall, afterCall });
    expect((await bridge.post()).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
    expect(afterCall).not.toHaveBeenCalled();
    expect(bridge.events).toEqual([]);
  });

  it("retains endpoint policy and rejects non-Responses connections before listening", async () => {
    const request = input();
    const fetcher = vi.fn<typeof fetch>();
    request.model.apiProtocol = "chat-completions";
    await expect(fixture(fetcher, request)).rejects.toThrow("Responses");
    request.model.apiProtocol = "responses";
    request.model.baseUrl = "http://127.0.0.1:1/v1";
    await expect(fixture(fetcher, request)).rejects.toThrow("Private model endpoints");
    request.model.baseUrl = "http://169.254.169.254/latest";
    request.model.allowPrivateEndpoint = true;
    await expect(fixture(fetcher, request)).rejects.toThrow("metadata");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a split terminal SSE frame intact for accounting", async () => {
    const wire = new TextEncoder().encode(sse(completed("split")));
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < wire.length; offset += 7)
                controller.enqueue(wire.slice(offset, offset + 7));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const bridge = await fixture(fetcher);
    await (await bridge.post()).text();
    expect(bridge.events[0]).toMatchObject({ providerRequestId: "split", inputTokens: 40 });
  });

  it("abort cancels the upstream stream, settles the reservation, and close waits for usage", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      upstreamSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const afterCall = vi.fn(async () => {});
    const bridge = await fixture(fetcher, input(), {
      beforeCall: async () => "reserved",
      afterCall,
    });
    const response = await bridge.post();
    const drained = response.text().catch(() => "");
    bridge.controller.abort();
    await bridge.close();
    await drained;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(afterCall).toHaveBeenCalledTimes(1);
    expect(bridge.events).toHaveLength(1);
    expect(bridge.events[0]).toMatchObject({ outcome: "aborted", inputTokens: null });
  });

  it("client disconnect aborts only that upstream call and still accounts it", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      upstreamSignal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const bridge = await fixture(fetcher);
    const response = await bridge.post();
    await response.body?.cancel();
    await vi.waitFor(() => expect(bridge.events).toHaveLength(1));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(bridge.events[0]?.outcome).toBe("aborted");
  });

  it.each([
    { terminalType: "response.completed", outcome: "completed" },
    { terminalType: "response.failed", outcome: "failed" },
    { terminalType: "response.incomplete", outcome: "incomplete" },
  ])(
    "preserves $terminalType when the client disconnects after receiving it",
    async ({ terminalType, outcome }) => {
      let upstreamSignal: AbortSignal | null | undefined;
      const cancelled = vi.fn();
      const wire = `event: ${terminalType}\ndata: ${JSON.stringify({ ...completed(), type: terminalType })}\n\n`;
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        upstreamSignal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(wire));
            },
            cancel: cancelled,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const afterCall = vi.fn(async () => {});
      const bridge = await fixture(fetcher, input(), {
        beforeCall: async () => "reserved",
        afterCall,
      });
      const response = await bridge.post();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("\n\n")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toBe(wire);
      await reader.cancel();
      await vi.waitFor(() => expect(bridge.events).toHaveLength(1));
      await bridge.close();
      expect(upstreamSignal?.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(afterCall).toHaveBeenCalledExactlyOnceWith(
        "reserved",
        expect.objectContaining({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60 }),
      );
      expect(bridge.events[0]).toMatchObject({
        outcome,
        terminalType,
        httpStatus: 200,
        inputTokens: 40,
        outputTokens: 20,
        providerRequestId: "response-1",
      });
    },
  );

  it("waits for producer accounting and exposes persistence errors through close", async () => {
    let release: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onUsage = vi.fn(async () => {
      await persistence;
      throw new Error("storage failed");
    });
    const controller = new AbortController();
    const bridge = await createCodexModelBridge({
      request: input(),
      signal: controller.signal,
      onUsage,
      fetch: vi.fn<typeof fetch>(async () => json(completed().response)),
    });
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ model: "test-model" }),
    });
    const drained = response.text().catch(() => "");
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = bridge.close().finally(() => {
      closed = true;
    });
    const rejected = expect(closing).rejects.toThrow("accounting");
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await rejected;
    await drained;
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("does not report a truncated or failed HTTP 200 stream as completed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          sse({
            type: "response.failed",
            response: { id: "failed-response" },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const bridge = await fixture(fetcher);
    await (await bridge.post()).text();
    await (await bridge.post()).text();
    expect(
      bridge.events.map((event) => [event.httpStatus, event.outcome, event.terminalType]),
    ).toEqual([
      [200, "incomplete", null],
      [200, "failed", "response.failed"],
    ]);
  });

  it("forwards only native correlation headers and host credentials", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(sse(completed()), {
          headers: { "content-type": "text/event-stream", "x-codex-turn-state": "sticky-state" },
        }),
    );
    const bridge = await fixture(fetcher);
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "session-id": "native-session",
        "x-client-request-id": "native-request",
        "x-codex-turn-metadata": '{"turn_id":"turn-1"}',
        "x-codex-turn-state": "prior-state",
        cookie: "local-cookie",
      },
      body: JSON.stringify({ model: "test-model", input: [] }),
    });
    await response.text();
    const forwarded = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(forwarded.get("authorization")).toBe("Bearer upstream-secret");
    expect(forwarded.get("session-id")).toBe("native-session");
    expect(forwarded.get("x-client-request-id")).toBe("native-request");
    expect(forwarded.get("x-codex-turn-metadata")).toBe('{"turn_id":"turn-1"}');
    expect(forwarded.get("cookie")).toBeNull();
    expect(response.headers.get("x-codex-turn-state")).toBe("sticky-state");
    expect(bridge.events[0]).toMatchObject({
      nativeSessionId: "native-session",
      nativeRequestId: "native-request",
    });
  });
});
