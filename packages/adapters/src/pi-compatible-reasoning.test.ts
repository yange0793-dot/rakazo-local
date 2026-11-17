import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, normalizeContext } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { ModelApiProtocol } from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { compatibleThinkingLevels } from "@rakazo/core";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";
import { modelForCompletion, resolveRuntimeModel, thinkingLevelFor } from "./pi-runtime-models.js";

type WireRequest = {
  model: string;
  reasoning_effort?: string;
  reasoning?: { effort: string };
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort: string };
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
};

const context = normalizeContext({
  messages: [{ role: "user", content: "Fixture prompt.", timestamp: 1 }],
});

function fixtureResponse(protocol: ModelApiProtocol): Response {
  const events =
    protocol === "anthropic-messages"
      ? [
          {
            type: "message_start",
            message: { id: "msg_fixture", model: "fixture-model", usage: { input_tokens: 3 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          },
          { type: "message_stop" },
        ]
      : protocol === "responses"
        ? [
            {
              type: "response.created",
              response: { id: "resp_fixture", model: "fixture-model", status: "in_progress" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_fixture",
                status: "completed",
                output: [],
                usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
              },
            },
          ]
        : [
            {
              id: "fixture",
              choices: [{ index: 0, delta: { content: "Fixture reply." }, finish_reason: "stop" }],
            },
          ];
  const body = events
    .map(
      (event) =>
        `${protocol === "anthropic-messages" && "type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function capture(
  protocol: ModelApiProtocol,
  requested: ModelThinkingLevel,
  overrides: Partial<Parameters<typeof resolveRuntimeModel>[0]> = {},
) {
  const config = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    id: "route-id/fixture-model",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiProtocol: protocol,
    allowPrivateEndpoint: true,
    reasoning: true,
    thinkingLevel: requested,
    ...overrides,
  };
  const resolved = resolveRuntimeModel(config);
  const model = resolved.model!;
  let body: WireRequest | undefined;
  const result = await resolved.models
    .getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!
    .streamSimple(modelForCompletion(model), context, {
      apiKey: "fake-api-key",
      // Exercise the provider boundary too: Messages must clamp a direct caller's saved value.
      reasoning: requested === "off" ? undefined : requested,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return fixtureResponse(protocol);
      },
    })
    .result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(body).toBeDefined();
  expect(body!.model).toBe(config.id);
  expect(thinkingLevelFor(model, requested)).toBe(resolved.thinking!.effective);
  return { body: body!, model, selection: resolved.thinking! };
}

const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;

describe.each(["chat-completions", "responses", "anthropic-messages"] as const)(
  "%s local reasoning serialization",
  (protocol) => {
    it.each(allLevels)("reports and emits the effective selection for %s", async (requested) => {
      const { body, model, selection } = await capture(protocol, requested);
      const effective =
        protocol === "anthropic-messages" && (requested === "xhigh" || requested === "max")
          ? "high"
          : requested;
      expect(selection).toEqual({ requested, effective, adjusted: requested !== effective });
      expect(getSupportedThinkingLevels(model)).toEqual([
        "off",
        ...compatibleThinkingLevels(protocol),
      ]);
      if (protocol === "anthropic-messages") {
        expect(body.output_config).toBeUndefined();
        expect(body.thinking).toMatchObject(
          effective === "off"
            ? { type: "disabled" }
            : { type: "enabled", budget_tokens: budgets[effective as keyof typeof budgets] },
        );
      } else if (protocol === "responses") {
        expect(body.reasoning?.effort).toBe(effective === "off" ? "none" : effective);
      } else {
        expect(body.reasoning_effort).toBe(effective === "off" ? "none" : effective);
      }
      expect(model.maxTokens).toBe(DEFAULT_MODEL_MAX_TOKENS);
      const outputLimit = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens!;
      expect(outputLimit).toBeGreaterThan(32_768);
      expect(outputLimit).toBeLessThan(model.contextWindow);
    });

    it("honors an explicitly disabled reasoning capability without enabling images or a new output cap", async () => {
      const { body, model, selection } = await capture(protocol, "max", {
        reasoningCapabilities: { levels: [] },
      });
      expect(selection).toEqual({ requested: "max", effective: "off", adjusted: true });
      expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(DEFAULT_MODEL_MAX_TOKENS);
    });

    it("keeps an unavailable off selection consistent with the emitted request", async () => {
      const { body, model, selection } = await capture(protocol, "off", {
        reasoningCapabilities: { levels: ["high"] },
      });
      expect(getSupportedThinkingLevels(model)).toEqual(["high"]);
      expect(selection).toEqual({ requested: "off", effective: "high", adjusted: true });
      if (protocol === "anthropic-messages") {
        expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16_384 });
      } else {
        expect(body.reasoning_effort ?? body.reasoning?.effort).toBe("high");
      }
    });

    it("does not turn a connection's reasoning on from a level declaration alone", async () => {
      const { body, selection } = await capture(protocol, "max", {
        reasoning: false,
        reasoningCapabilities: { mode: "adaptive", levels: ["high", "max"] },
      });
      expect(selection).toEqual({ requested: "max", effective: "off", adjusted: true });
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    });

    it("preserves an explicit output ceiling alongside reasoning declarations", async () => {
      const { body, model } = await capture(protocol, "high", {
        maxTokens: 64_000,
        reasoningCapabilities: { levels: ["off", "low", "high"] },
      });
      expect(model.maxTokens).toBe(64_000);
      expect(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens).toBe(64_000);
    });
  },
);

describe("explicit adaptive declarations", () => {
  it.each(allLevels)(
    "emits distinct adaptive efforts without a model-name lookup: %s",
    async (requested) => {
      const { body, model, selection } = await capture("anthropic-messages", requested, {
        reasoningCapabilities: { mode: "adaptive" },
      });
      const effective = requested === "minimal" ? "low" : requested;
      expect(selection).toEqual({ requested, effective, adjusted: requested !== effective });
      expect(getSupportedThinkingLevels(model)).toEqual([
        "off",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(body.thinking?.type).toBe(effective === "off" ? "disabled" : "adaptive");
      expect(body.output_config?.effort).toBe(effective === "off" ? undefined : effective);
      expect(body.thinking?.budget_tokens).toBeUndefined();
    },
  );

  it("clamps to declared levels and emits that same effort", async () => {
    const { body, selection } = await capture("anthropic-messages", "medium", {
      reasoningCapabilities: { mode: "adaptive", levels: ["off", "low", "max"] },
    });
    expect(selection).toEqual({ requested: "medium", effective: "max", adjusted: true });
    expect(body.output_config?.effort).toBe("max");
  });

  it.each(["claude-opus-5-5", "route-id/claude-opus-5-5", "route-id/gpt-6-luna"])(
    "does not borrow reasoning, image, or context capabilities from %s",
    async (id) => {
      const { body, model, selection } = await capture("anthropic-messages", "max", { id });
      expect(model.compat).toBeUndefined();
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(DEFAULT_MODEL_MAX_TOKENS);
      expect(selection).toEqual({ requested: "max", effective: "high", adjusted: true });
      expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16_384 });
      expect(body.output_config).toBeUndefined();
    },
  );
});

describe("runtime reasoning evidence", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records each call's requested and effective level, including rejection recovery, without changing saved settings", async () => {
    const sink = Logging.createTestSink();
    vi.spyOn(Logging, "getLogger").mockReturnValue(
      Logging.createLogger({ service: "reasoning-fixture", sinks: [sink] }),
    );
    const bodies: WireRequest[] = [];
    const runtime = new PiAgentRuntime({
      modelFetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return Response.json(
            { error: { message: "reasoning_effort must be one of: low, medium, high" } },
            { status: 400 },
          );
        }
        return fixtureResponse("chat-completions");
      },
    });
    const request: AgentRunRequest = {
      botId: "bot-fixture",
      threadId: "thread-fixture",
      runId: "run-fixture",
      prompt: "Private fixture prompt.",
      instructions: "Return a short fixture answer.",
      history: [],
      tools: [],
      model: {
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        connectionId: "connection-fixture",
        id: "route-id/fixture-model",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiProtocol: "chat-completions",
        apiKey: "fake-api-key-private",
        allowPrivateEndpoint: true,
        reasoning: true,
        thinkingLevel: "max",
      },
      executeTool: vi.fn(async () => ({ ok: true })),
    };
    const saved = structuredClone(request.model);
    const events = [];
    for await (const event of runtime.run(request, {
      operationId: "operation-fixture",
      traceId: "trace-fixture",
      spaceId: "space-fixture",
      userId: "user-fixture",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Fixture reply." });
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["max", "high"]);
    const logs = sink.events.filter((event) => event.message === "model.reasoning_selected");
    expect(logs).toEqual([
      expect.objectContaining({
        runId: request.runId,
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: request.model.id,
        connectionId: "connection-fixture",
        api: "openai-completions",
        requestedThinkingLevel: "max",
        effectiveThinkingLevel: "max",
        reasoningAdjusted: false,
      }),
      expect.objectContaining({
        requestedThinkingLevel: "max",
        effectiveThinkingLevel: "high",
        reasoningAdjusted: true,
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(request.prompt);
    expect(JSON.stringify(logs)).not.toContain(request.model.apiKey);
    expect(request.model).toEqual(saved);
  });
});
