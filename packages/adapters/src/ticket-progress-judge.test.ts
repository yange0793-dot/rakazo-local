import { createHash } from "node:crypto";
import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOMATED_MESSAGE_LABEL } from "./automated-messages.js";
import {
  TICKET_PROGRESS_CALIBRATION_CASES,
  TICKET_PROGRESS_CALIBRATION_REVISION,
} from "./fixtures/ticket-progress-calibration.js";
import { CODEX_CLIENT_HEADERS } from "./model-client-headers.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import type {
  TicketProgressCalibrationReport,
  TicketProgressJudgeInput,
  TicketProgressJudgeOptions,
} from "./ticket-progress-judge.js";
import {
  createTicketProgressJudge,
  TICKET_PROGRESS_FIXTURE_DIGEST,
  TICKET_PROGRESS_RUBRIC,
  TICKET_PROGRESS_RUBRIC_DIGEST,
  TICKET_PROGRESS_RUBRIC_VERSION,
} from "./ticket-progress-judge.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
type Verdict = "stalled" | "can_continue" | "unknown";
const output = (verdict: Verdict = "stalled") => ({
  schemaVersion: 1,
  rubricVersion: TICKET_PROGRESS_RUBRIC_VERSION,
  verdicts: [
    ...TICKET_PROGRESS_CALIBRATION_CASES.map(({ id, expected }) => ({ id, verdict: expected })),
    { id: "current", verdict },
  ],
});
const input = (changes: Partial<TicketProgressJudgeInput> = {}): TicketProgressJudgeInput => ({
  operationId: "ticket-1:ticket-progress:1",
  observation: {
    requirementsVersion: 3,
    repeated: {
      patternKey: "a".repeat(64),
      kind: "same_failure",
      tool: "export_csv",
      outcome: "failed",
      detail: "The same export failed twice with an unsupported delimiter and unchanged input.",
    },
  },
  repeatedChecks: 2,
  timeMs: 5_000,
  remainingTokens: 4_096,
  remainingCostUsd: 0.05,
  ...changes,
});

function fixture(
  changes: {
    verdict?: Verdict;
    text?: string;
    usage?: Partial<UsageEvent> | null;
    call?: Partial<Parameters<ModelCallObserver["beforeCall"]>[0]>;
    retry?: boolean;
    missingDone?: boolean;
    unexpected?: AgentRuntimeEvent;
    throwAfterUsage?: boolean;
    options?: Partial<TicketProgressJudgeOptions>;
  } = {},
) {
  const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "credit-reservation");
  const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => {});
  const onRequestId = vi.fn<NonNullable<ModelCallObserver["onRequestId"]>>(async () => {});
  const recordUsage = vi.fn<TicketProgressJudgeOptions["recordUsage"]>(async () => {});
  const onAssessment = vi.fn<NonNullable<TicketProgressJudgeOptions["onAssessment"]>>(
    async () => {},
  );
  const requests: AgentRunRequest[] = [];
  const model: AgentRunModel = {
    provider: "provider-fixture",
    id: "model-fixture",
    apiKey: "synthetic-api-key",
    apiProtocol: "responses",
    thinkingLevel: "max",
    reasoning: true,
    maxTokens: 8_192,
    headers: { "x-fixture-header": "retained" },
    callObserver: { beforeCall, afterCall, onRequestId },
  };
  const runtime: Pick<AgentRuntime, "run" | "abort"> = {
    abort: vi.fn(async () => {}),
    async *run(request) {
      requests.push(request);
      const observer = request.model.callObserver!;
      const call = {
        callId: "model-call-1",
        provider: model.provider,
        modelId: model.id,
        inputTokensEstimate: 1_100,
        maxOutputTokens: 512,
        maxCostUsd: 0.003,
        ...changes.call,
      };
      const id = await observer.beforeCall(call);
      await observer.onRequestId?.(id, "provider-request-1");
      if (changes.retry) await observer.beforeCall(call);
      if (changes.usage !== null) {
        const usage: UsageEvent = {
          type: "usage",
          callId: "model-call-1",
          provider: model.provider,
          model: model.id,
          inputTokens: 1_000,
          outputTokens: 150,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1_150,
          costUsd: 0.002,
          ...changes.usage,
        };
        try {
          await request.onUsage?.(usage);
          yield { ...usage, accounted: true };
        } catch {
          yield { ...usage, accounted: false };
        }
        await observer.afterCall(id, usage);
      }
      if (changes.throwAfterUsage) throw new Error("Synthetic transport error after usage.");
      if (changes.unexpected) yield changes.unexpected;
      if (!changes.missingDone)
        yield { type: "done", text: changes.text ?? JSON.stringify(output(changes.verdict)) };
    },
  };
  const options: TicketProgressJudgeOptions = {
    runtime,
    model,
    context: {
      operationId: "run-1",
      runId: "run-1",
      traceId: "trace-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      signal: new AbortController().signal,
    },
    goal: "Produce a valid CSV export.",
    recordUsage,
    onAssessment,
    ...changes.options,
  };
  return {
    judge: createTicketProgressJudge(options),
    runtime,
    model,
    requests,
    recordUsage,
    onAssessment,
    beforeCall,
    afterCall,
    onRequestId,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ticket progress calibrated judge", () => {
  it.each(["stalled", "can_continue", "unknown"] as const)(
    "calibrates and returns %s in one bounded call with independent accounting",
    async (verdict) => {
      const f = fixture({ verdict });
      const assessment = await f.judge.evaluate(input());
      expect(assessment).toMatchObject({
        verdict,
        tokens: 1_150,
        cost: 0.002,
        accounted: true,
        calibration: {
          schemaVersion: 1,
          status: "verified",
          reason: "calibrated",
          rubricVersion: TICKET_PROGRESS_RUBRIC_VERSION,
          revision: TICKET_PROGRESS_CALIBRATION_REVISION,
          operationId: input().operationId,
          rubricDigest: TICKET_PROGRESS_RUBRIC_DIGEST,
          fixtureDigest: TICKET_PROGRESS_FIXTURE_DIGEST,
        },
      });
      expect(f.requests).toHaveLength(1);
      expect(f.beforeCall).toHaveBeenCalledOnce();
      expect(f.afterCall).toHaveBeenCalledWith("credit-reservation", expect.any(Object));
      expect(f.onRequestId).toHaveBeenCalledWith("credit-reservation", "provider-request-1");
      expect(f.recordUsage).toHaveBeenCalledExactlyOnceWith(
        input().operationId,
        expect.objectContaining({ operationKind: "learning" }),
      );
      expect(f.onAssessment).toHaveBeenCalledExactlyOnceWith(assessment.calibration);
      const request = f.requests[0]!;
      expect(request).toMatchObject({
        usageOperationKind: "learning",
        tools: [],
        history: [],
        contextStrategy: "current",
        model: {
          provider: f.model.provider,
          id: f.model.id,
          thinkingLevel: "max",
          apiProtocol: "responses",
          maxTokens: 512,
          headers: f.model.headers,
        },
      });
      expect(f.model.maxTokens).toBe(8_192);
      expect(request).not.toHaveProperty("executeTool");
      expect(request).not.toHaveProperty("fallbackModels");
      expect(request).not.toHaveProperty("script");
      expect(request).not.toHaveProperty("resumeFromCheckpoint");
      const prompt = JSON.parse(request.prompt.slice(AUTOMATED_MESSAGE_LABEL.length + 1));
      expect(prompt.cases).toHaveLength(7);
      expect(prompt.cases.at(-1)).toMatchObject({ id: "current", requirementsVersion: 3 });
      expect(request.prompt).not.toContain('"expected"');
      expect(request.prompt).not.toContain('"rationale"');
      for (const item of TICKET_PROGRESS_CALIBRATION_CASES)
        expect(request.prompt).not.toContain(item.rationale);
      expect(JSON.stringify(assessment.calibration)).not.toContain("CSV");
      expect(JSON.stringify(assessment.calibration)).not.toContain("synthetic-api-key");
      expect(JSON.stringify(assessment.calibration).length).toBeLessThan(2_048);
    },
  );

  it("pins the full rubric and fixture including labels to reproducible digests", () => {
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(TICKET_PROGRESS_RUBRIC_DIGEST).toBe(hash(TICKET_PROGRESS_RUBRIC));
    expect(TICKET_PROGRESS_FIXTURE_DIGEST).toBe(hash(TICKET_PROGRESS_CALIBRATION_CASES));
    expect(new Set(TICKET_PROGRESS_CALIBRATION_CASES.map(({ expected }) => expected)).size).toBe(3);
  });

  it.each(TICKET_PROGRESS_CALIBRATION_CASES.map(({ id }) => id))(
    "withholds stalled when reviewed case %s fails calibration",
    async (id) => {
      const invalid = output();
      invalid.verdicts.find((entry) => entry.id === id)!.verdict = "stalled";
      if (
        TICKET_PROGRESS_CALIBRATION_CASES.find((entry) => entry.id === id)!.expected === "stalled"
      )
        invalid.verdicts.find((entry) => entry.id === id)!.verdict = "can_continue";
      const f = fixture({ text: JSON.stringify(invalid) });
      expect(await f.judge.evaluate(input())).toMatchObject({
        verdict: "unknown",
        tokens: 1_150,
        cost: 0.002,
        calibration: {
          status: "unknown",
          reason: "calibration_mismatch",
          reviewedVerdict: "stalled",
        },
      });
    },
  );

  it.each([
    ["old rubric", { ...output(), rubricVersion: "ticket-progress.v1" }],
    ["future schema", { ...output(), schemaVersion: 2 }],
    ["missing case", { ...output(), verdicts: output().verdicts.slice(1) }],
    [
      "duplicate case",
      { ...output(), verdicts: [...output().verdicts.slice(1), output().verdicts[1]] },
    ],
    [
      "unknown case",
      { ...output(), verdicts: [...output().verdicts.slice(1), { id: "p7", verdict: "stalled" }] },
    ],
    ["extra key", { ...output(), calibrated: true }],
    [
      "extra verdict key",
      {
        ...output(),
        verdicts: output().verdicts.map((entry) => ({ ...entry, rationale: "trust me" })),
      },
    ],
  ])("rejects %s", async (_label, invalid) => {
    const f = fixture({ text: JSON.stringify(invalid) });
    expect(await f.judge.evaluate(input())).toMatchObject({
      verdict: "unknown",
      calibration: { status: "unknown", reason: "judge_invalid_output" },
    });
  });

  it.each(["not JSON", "x".repeat(2_049), `\`\`\`json\n${JSON.stringify(output())}\n\`\`\``])(
    "does not repair nonconforming model output",
    async (text) => {
      const f = fixture({ text });
      expect((await f.judge.evaluate(input())).calibration.reason).toBe("judge_invalid_output");
      expect(f.requests).toHaveLength(1);
    },
  );

  it.each([
    ["no receipt", null, "judge_missing_usage"],
    ["unknown tokens", { totalTokens: null, inputTokens: null }, "judge_missing_usage"],
    ["unknown cost", { costUsd: null }, "judge_unknown_cost"],
    ["invalid cost", { costUsd: Number.NaN }, "judge_unknown_cost"],
    ["wrong model", { model: "other-model" }, "judge_missing_usage"],
  ] as const)("preserves %s as unknown without a second request", async (_label, usage, reason) => {
    const f = fixture({ usage });
    const result = await f.judge.evaluate(input());
    expect(result.verdict).toBe("unknown");
    expect(result.calibration).toMatchObject({ status: "unknown", reason });
    await f.judge.evaluate(input({ operationId: "ticket-1:ticket-progress:2" }));
    expect(f.requests).toHaveLength(1);
  });

  it("uses a complete token breakdown when totalTokens is absent", async () => {
    const f = fixture({ usage: { totalTokens: null } });
    expect(await f.judge.evaluate(input())).toMatchObject({ verdict: "stalled", tokens: 1_150 });
  });

  it("accounts producer failure through the consumer using the same operationId", async () => {
    const recordUsage = vi
      .fn<TicketProgressJudgeOptions["recordUsage"]>()
      .mockRejectedValueOnce(new Error("Synthetic ledger interruption"))
      .mockResolvedValue(undefined);
    const f = fixture({ options: { recordUsage } });
    expect(await f.judge.evaluate(input())).toMatchObject({ verdict: "stalled", accounted: true });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage.mock.calls.map(([operationId]) => operationId)).toEqual([
      input().operationId,
      input().operationId,
    ]);
  });

  it("withholds a verdict when both usage sinks fail", async () => {
    const f = fixture({
      options: {
        recordUsage: async () => {
          throw new Error("Synthetic ledger unavailable");
        },
      },
    });
    expect(await f.judge.evaluate(input())).toMatchObject({ verdict: "unknown", accounted: false });
  });

  it("does not grant a verdict if metadata audit fails or tries to mutate calibration", async () => {
    const f = fixture({
      options: {
        onAssessment: (report) => {
          report.status = "verified";
          report.verdict = "stalled";
        },
      },
      verdict: "unknown",
    });
    expect((await f.judge.evaluate(input())).verdict).toBe("unknown");
    const failed = fixture({
      options: {
        onAssessment: async () => {
          throw new Error("Synthetic audit unavailable");
        },
      },
    });
    expect(await failed.judge.evaluate(input())).toMatchObject({
      verdict: "unknown",
      calibration: { status: "unknown", reason: "judge_audit_failed" },
    });
  });

  it.each([
    ["unknown price", { maxCostUsd: undefined }, "judge_unknown_cost"],
    ["excess tokens", { inputTokensEstimate: 4_096 }, "judge_budget_exceeded"],
    ["excess cost", { maxCostUsd: 0.051 }, "judge_budget_exceeded"],
    ["excess output", { maxOutputTokens: 513 }, "judge_budget_exceeded"],
    ["changed model", { modelId: "different" }, "judge_error"],
  ] as const)("refuses %s before credit authorization", async (_label, call, reason) => {
    const f = fixture({ call });
    expect((await f.judge.evaluate(input())).calibration.reason).toBe(reason);
    expect(f.beforeCall).not.toHaveBeenCalled();
  });

  it("enforces remaining durable token and dollar budgets before a request", async () => {
    const f = fixture();
    expect((await f.judge.evaluate(input({ remainingTokens: 1_500 }))).verdict).toBe("unknown");
    expect(f.beforeCall).not.toHaveBeenCalled();
    const cost = fixture();
    expect((await cost.judge.evaluate(input({ remainingCostUsd: 0.001 }))).verdict).toBe("unknown");
    expect(cost.beforeCall).not.toHaveBeenCalled();
  });

  it("allows at most two batch calls without expanding the inherited budget", async () => {
    const f = fixture();
    await f.judge.evaluate(input());
    await f.judge.evaluate(
      input({
        operationId: "ticket-1:ticket-progress:2",
        remainingTokens: 2_946,
        remainingCostUsd: 0.048,
      }),
    );
    expect(
      (await f.judge.evaluate(input({ operationId: "ticket-1:ticket-progress:3" }))).calibration
        .reason,
    ).toBe("judge_budget_exceeded");
    expect(f.requests).toHaveLength(2);
  });

  it("does not mislabel a blocked runtime retry as exhausted token budget", async () => {
    const f = fixture({ retry: true });
    expect((await f.judge.evaluate(input())).calibration.reason).toBe("judge_call_limit");
    expect(f.beforeCall).toHaveBeenCalledOnce();
  });

  it.each([
    ["excess measured tokens", { totalTokens: 4_097 }],
    ["excess measured cost", { costUsd: 0.051 }],
  ] as const)("retains %s and withholds intervention", async (_label, usage) => {
    const f = fixture({ usage });
    expect(await f.judge.evaluate(input())).toMatchObject({
      verdict: "unknown",
      calibration: {
        reason: "judge_budget_exceeded",
        totalTokens: "totalTokens" in usage ? usage.totalTokens : 1_150,
        costUsd: "costUsd" in usage ? usage.costUsd : 0.002,
      },
    });
  });

  it.each([
    { type: "tool", name: "write_file", args: {}, executionId: "forbidden" },
    { type: "ask", text: "Approve" },
    { type: "takeover", reason: "Need screen" },
    { type: "subagent", agentId: "helper", name: "helper", task: "do work", status: "running" },
  ] satisfies AgentRuntimeEvent[])("rejects unexpected $type events", async (unexpected) => {
    const f = fixture({ unexpected });
    expect((await f.judge.evaluate(input())).calibration.reason).toBe("judge_invalid_output");
    expect(f.runtime.abort).toHaveBeenCalledOnce();
  });

  it("keeps measured usage after a transport failure without granting replan", async () => {
    const f = fixture({ throwAfterUsage: true });
    expect(await f.judge.evaluate(input())).toMatchObject({
      verdict: "unknown",
      tokens: 1_150,
      cost: 0.002,
      calibration: { reason: "judge_error" },
    });
  });

  it("requires a terminal response", async () => {
    const f = fixture({ missingDone: true });
    expect((await f.judge.evaluate(input())).calibration.reason).toBe("judge_invalid_output");
  });

  it("bounds a runtime that ignores cancellation", async () => {
    let started = false;
    const runtime: Pick<AgentRuntime, "run" | "abort"> = {
      abort: vi.fn(async () => {}),
      async *run() {
        started = true;
        await new Promise<void>(() => {});
      },
    };
    const f = fixture({ options: { runtime } });
    expect((await f.judge.evaluate(input({ timeMs: 10 }))).calibration.reason).toBe(
      "judge_deadline",
    );
    expect(started).toBe(true);
    expect(runtime.abort).toHaveBeenCalledOnce();
  });

  it("refuses a cancelled context or missing observer without calling runtime", async () => {
    const unavailable = fixture({ options: { model: { provider: "fixture", id: "fixture" } } });
    expect((await unavailable.judge.evaluate(input())).calibration.reason).toBe(
      "judge_unavailable",
    );
    expect(unavailable.requests).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    const f = fixture({
      options: {
        context: {
          operationId: "cancelled",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          threadId: "thread",
          traceId: "trace",
          signal: controller.signal,
        },
      },
    });
    expect((await f.judge.evaluate(input())).calibration.reason).toBe("judge_deadline");
    expect(f.requests).toHaveLength(0);
  });

  it("redacts supplied secrets and does not classify a truncated goal or observation", async () => {
    const f = fixture({
      options: {
        goal: "Create the file with synthetic-api-key and secret-marker.",
        secrets: ["secret-marker"],
      },
    });
    await f.judge.evaluate(input());
    expect(f.requests[0]!.prompt).not.toContain("synthetic-api-key");
    expect(f.requests[0]!.prompt).not.toContain("secret-marker");
    const oversized = fixture({ options: { goal: "g".repeat(1_201) } });
    expect((await oversized.judge.evaluate(input())).calibration.reason).toBe(
      "incomplete_observation",
    );
    expect(oversized.requests).toHaveLength(0);
    const missing = fixture();
    expect(
      (await missing.judge.evaluate(input({ observation: { requirementsVersion: 1 } }))).calibration
        .reason,
    ).toBe("incomplete_observation");
    expect(missing.requests).toHaveLength(0);
  });
});

describe("ticket progress judge with real Pi runtime", () => {
  it.each([false, true])(
    "keeps model, effort, client headers and strict one-call calibration (unknownCost=%s)",
    async (unknownCost) => {
      vi.stubGlobal("fetch", () => {
        throw new Error("Unexpected live request.");
      });
      const wire: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
      const records: Array<Parameters<TicketProgressJudgeOptions["recordUsage"]>> = [];
      const reports: TicketProgressCalibrationReport[] = [];
      const runtime = new PiAgentRuntime({
        modelFetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          wire.push({ body, headers: new Headers(init?.headers) });
          if (wire.length > 1) throw new Error("Unexpected extra call.");
          return new Response(
            `data: ${JSON.stringify({
              id: "fixture-request",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: JSON.stringify(output()) },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 1_000,
                completion_tokens: 150,
                total_tokens: 1_150,
                ...(!unknownCost ? { cost: 0.002 } : {}),
              },
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(
        async () => "real-credit-reservation",
      );
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => {});
      const judge = createTicketProgressJudge({
        runtime,
        model: {
          provider: "openrouter",
          id: "openai/gpt-4.1-mini",
          apiKey: "synthetic-test-key",
          thinkingLevel: "off",
          maxTokens: 4_096,
          callObserver: { beforeCall, afterCall },
        },
        context: {
          operationId: "real-run",
          runId: "real-run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          threadId: "thread",
          traceId: "trace",
          signal: new AbortController().signal,
        },
        goal: "Produce a valid CSV export.",
        recordUsage: async (...args) => {
          records.push(args);
        },
        onAssessment: (report) => {
          reports.push(report);
        },
      });
      const result = await judge.evaluate(input());
      expect(result).toMatchObject({
        verdict: unknownCost ? "unknown" : "stalled",
        tokens: 1_150,
        accounted: true,
        calibration: { status: unknownCost ? "unknown" : "verified" },
      });
      expect(wire).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0]![0]).toBe(input().operationId);
      expect(records[0]![1].operationKind).toBe("learning");
      expect(beforeCall).toHaveBeenCalledOnce();
      expect(afterCall).toHaveBeenCalledOnce();
      expect(reports).toHaveLength(1);
      expect(wire[0]!.body.model).toBe("openai/gpt-4.1-mini");
      expect(wire[0]!.body.tools ?? []).toEqual([]);
      expect(wire[0]!.headers.get("user-agent")).toBe(CODEX_CLIENT_HEADERS["user-agent"]);
      expect(wire[0]!.headers.get("originator")).toBe("codex_cli_rs");
    },
  );
});
