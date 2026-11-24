import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type { TicketWorkState } from "@rakazo/contracts";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { TICKET_PROGRESS_CALIBRATION_CASES } from "./fixtures/ticket-progress-calibration.js";
import type * as CreditObserver from "./model-credit-observer.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { TICKET_PROGRESS_INTERVAL_MS, TICKET_PROGRESS_REPLAN_NOTE } from "./ticket-progress.js";
import { TICKET_PROGRESS_RUBRIC_VERSION } from "./ticket-progress-judge.js";

const delivery = vi.hoisted(() => ({
  receipts: [] as Array<{ id: string; result: unknown }>,
}));

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => ({
    id: "fixture-computer",
    botId: "fixture-bot",
    kind: "fake",
    providerRef: "fixture-computer",
  }),
}));

// Delivery persistence belongs to its boundary tests. This fixture observes the real
// executor/Pi dispatch into that boundary and exposes the resulting receipt to the executor.
vi.mock("./ticket-delivery.js", () => ({
  deliverTicketWork: async (
    _deps: unknown,
    _run: unknown,
    input: { id: string; result: unknown },
  ) => {
    delivery.receipts.push(input);
    return { ok: true, version: 1, messageId: "fixture-receipt", status: "done" };
  },
}));

vi.mock("./model-credit-observer.js", async (original) => ({
  ...(await original<typeof CreditObserver>()),
  hostedModelCreditObserver: async () => ({
    beforeCall: async () => "fixture-credit-reservation",
    afterCall: async () => undefined,
  }),
}));

type WireRequest = {
  model: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: Array<{ function: { name: string } }>;
};
type Reply = { text: string; cost?: number } | { name: string; args: Record<string, unknown> };
const sink = createTestSink();

beforeEach(() => {
  delivery.receipts.length = 0;
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
  vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

function fixture(
  answer: (request: WireRequest, index: number) => Reply,
  options: {
    ticket?: boolean;
    alreadyDelivered?: boolean;
    failUsageWriteAt?: number;
    semantic?: SemanticMemoryProvider;
    toolResult?: unknown;
    initialFence?: number;
    hostedProgressClock?: () => Date;
  } = {},
) {
  const hosted = Boolean(options.hostedProgressClock);
  const provider = hosted ? "openrouter" : "openai-compatible";
  const model = hosted ? "openai/gpt-4.1-mini" : "fixture-model";
  if (hosted) {
    vi.stubEnv("PI_DEFAULT_PROVIDER", provider);
    vi.stubEnv("OPENROUTER_API_KEY", "fixture-hosted-key");
  }
  const requests: WireRequest[] = [];
  const modelFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    requests.push(request);
    if (requests.length > 10) throw new Error("Unexpected extra model call");
    const reply = answer(request, requests.length);
    const choice = {
      index: 0,
      delta:
        "text" in reply
          ? { role: "assistant", content: reply.text }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `fixture-call-${requests.length}`,
                  type: "function",
                  function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                },
              ],
            },
      finish_reason: "text" in reply ? "stop" : "tool_calls",
    };
    return new Response(
      `data: ${JSON.stringify({
        id: `fixture-response-${requests.length}`,
        choices: [choice],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          ...("text" in reply && reply.cost !== undefined ? { cost: reply.cost } : {}),
        },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const run = {
    id: "fixture-run",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    taskId: "fixture-task",
    spaceId: "fixture-space",
    userId: "fixture-user",
    ticketId: options.ticket === false ? null : "fixture-ticket",
    status: "queued",
    trigger: options.ticket === false ? "user" : "tickets",
    sourceMessageId: null,
    routineId: null,
    leaseFence: options.initialFence ?? 0,
    checkpoint: null,
  };
  const workState: TicketWorkState | null = hosted
    ? {
        schemaVersion: 1,
        goal: "Publish the report.",
        constraints: [],
        requirementsVersion: null,
        evidenceRefs: [],
        nextStep: null,
        blocker: null,
        wait: null,
        position: null,
        environment: null,
        configurationRef: null,
        pendingCall: null,
        sourceRunId: run.id,
        updatedAt: "2026-01-01T00:00:00.000Z",
        progress: null,
      }
    : null;
  const ticket = {
    id: "fixture-ticket",
    spaceId: run.spaceId,
    createdByUserId: run.userId,
    assigneeBotId: run.botId,
    originThreadId: "fixture-origin",
    originRunId: run.id,
    originKey: "fixture-origin-key",
    fileDeliveryRequirements: null,
    status: "doing",
    workState,
    workStateVersion: hosted ? 1 : 0,
  };
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const effects: Array<Record<string, unknown>> = [];
  const usage: Array<Record<string, unknown>> = [];
  let usageWrites = 0;
  const prisma = new Proxy(
    {
      $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      usageRecord: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          if (++usageWrites === options.failUsageWriteAt) {
            throw new Error("Fixture usage write unavailable");
          }
          usage.push(...data);
          return { count: data.length };
        },
      },
      userActionApprovalRule: {
        findMany: async () => [{ effect: "allow", matchKind: "tool", matchValue: "fixture_write" }],
      },
      run: {
        findUnique: async () => run,
        findUniqueOrThrow: async () => run,
        findFirst: async ({ where }: { where: { id?: string } }) =>
          where.id === run.id ? run : null,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      ticket: {
        ...empty,
        findFirst: async () => ticket,
        updateMany: async ({
          where,
          data,
        }: {
          where: { workStateVersion: number };
          data: { workState: TicketWorkState; workStateVersion: { increment: number } };
        }) => {
          if (!hosted || where.workStateVersion !== ticket.workStateVersion) return { count: 0 };
          ticket.workState = structuredClone(data.workState);
          ticket.workStateVersion += data.workStateVersion.increment;
          return { count: 1 };
        },
      },
      message: {
        ...empty,
        findFirst: async ({ where }: { where: { clientNonce?: unknown } }) =>
          where.clientNonce && (delivery.receipts.length || options.alreadyDelivered)
            ? { id: "fixture-receipt" }
            : null,
      },
      task: {
        findUniqueOrThrow: async () => ({
          id: run.taskId,
          prompt: "Publish the report, check its evidence and deliver the receipt.",
        }),
      },
      bot: {
        ...empty,
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Fixture",
          title: "Fixture",
          description: "Fixture",
          modelProvider: provider,
          modelId: model,
          thinkingLevel: "high",
          computerId: "fixture-computer",
          computerSwitching: false,
          memoryScope: null,
          computer: {
            id: "fixture-computer",
            scope: "dedicated",
            kind: "fake",
            homeKey: "fixture-home",
          },
        }),
      },
      attempt: {
        ...empty,
        create: async () => ({ id: "fixture-attempt" }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
        count: async () => 2,
      },
      thread: {
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          nextMessageSeq: 1,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
        }),
      },
      spaceMember: {
        findUnique: async () => ({
          id: "fixture-member",
          member: {
            role: "owner",
            organization: {
              modelCredits: { mode: "credits", balanceMicros: 10_000_000n, byokFreeUntil: null },
              billing: null,
            },
          },
        }),
      },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: provider,
          defaultModelId: model,
        }),
      },
      userModelCredential: {
        ...empty,
        findMany: async () =>
          hosted
            ? []
            : [
                {
                  id: "fixture-credential",
                  provider,
                  defaultModel: model,
                  secretId: "fixture-key",
                },
              ],
      },
      secret: {
        ...empty,
        findFirst: async () => ({ id: "fixture-key", ciphertext: "fixture-ciphertext" }),
      },
      externalEffect: {
        ...empty,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          ),
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          effects.find((effect) => effect.idempotencyKey === where.idempotencyKey) ?? null,
        create: async ({ data }: { data: object }) => {
          const effect = { id: `fixture-effect-${effects.length}`, ...data };
          effects.push(effect);
          return effect;
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
          const matching = effects.filter((effect) =>
            Object.entries(where).every(
              ([key, value]) => typeof value === "object" || effect[key] === value,
            ),
          );
          for (const effect of matching) Object.assign(effect, data);
          return { count: matching.length };
        },
      },
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : empty) },
  );
  const writes = vi.fn(
    async () =>
      options.toolResult ?? {
        ok: true,
        observationId: "unique-external-receipt-1",
        evidence: "Published report with three rows.",
      },
  );
  const reads = vi.fn(async () =>
    new TextEncoder().encode("Verified artifact contains three rows."),
  );
  const runtime = new PiAgentRuntime({ modelFetch });
  const runtimeRun = vi.spyOn(runtime, "run");
  const finalizeRun = vi.fn(async (input) => {
    run.status = input.outcome;
    return { continuationRunId: null };
  });
  const events = {
    append: vi.fn(async () => undefined),
    claimSteering: async () => [],
    finalizeRun,
  };
  const executor = createRunExecutor({
    prisma,
    ticketBoardEnabled: true,
    billingEnabled: hosted,
    runtime,
    now: options.hostedProgressClock,
    mcpAllowPrivateEndpoint: true,
    deploymentModelKey: "fixture-key",
    secretStore: {
      load: async () =>
        JSON.stringify({
          kind: "openai_compatible",
          apiKey: "fixture-api-key",
          baseUrl: "http://127.0.0.1:9/v1",
          allowPrivateEndpoint: true,
          contextWindow: 160000,
          maxTokens: 1024,
          reasoning: true,
          thinkingLevel: "high",
        }),
    },
    connector: {
      discoverTools: async () => [
        {
          name: "fixture_write",
          description: "Publish the report.",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      ],
      async *execute() {
        yield { type: "result", data: await writes() };
      },
    },
    sandbox: {
      describe: () => ({ id: "fake", capabilities: { graphical: false } }),
      readFile: reads,
      releaseScreen: async () => undefined,
      async *exportWorkspace() {},
    },
    home: { commit: async () => "fixture-revision" },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () =>
        options.semantic ? { defaultScope: "isolated", provider: options.semantic } : null,
    },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    execute: () => executor.continueRun(run.id, "fixture-worker"),
    run,
    ticket,
    writes,
    reads,
    requests,
    runtimeRun,
    finalizeRun,
    events,
    usage,
  };
}

describe("executor ticket receipt finalization with real Pi", () => {
  it.each([true, false])(
    "only injects one replan in the main transcript when calibration is verified=%s",
    async (calibrated) => {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const noteCounts: number[] = [];
      let mainCalls = 0;
      let judgeCalls = 0;
      const state = fixture(
        (request) => {
          const transcript = JSON.stringify(request.messages);
          if (transcript.includes(TICKET_PROGRESS_RUBRIC_VERSION)) {
            judgeCalls++;
            expect(mainCalls).toBe(3);
            expect(request.tools ?? []).toEqual([]);
            expect(transcript).not.toContain(TICKET_PROGRESS_REPLAN_NOTE);
            return {
              text: JSON.stringify({
                schemaVersion: 1,
                rubricVersion: TICKET_PROGRESS_RUBRIC_VERSION,
                verdicts: [
                  ...TICKET_PROGRESS_CALIBRATION_CASES.map(({ id, expected }, index) => ({
                    id,
                    verdict: !calibrated && index === 0 ? "unknown" : expected,
                  })),
                  { id: "current", verdict: "stalled" },
                ],
              }),
              cost: 0.002,
            };
          }
          mainCalls++;
          noteCounts.push(transcript.split(TICKET_PROGRESS_REPLAN_NOTE).length - 1);
          if (mainCalls <= 4) {
            if (mainCalls <= 3 || calibrated) now += TICKET_PROGRESS_INTERVAL_MS;
            return { name: "read_file", args: { path: "report.txt" } };
          }
          return { text: "Report checked." };
        },
        { alreadyDelivered: true, hostedProgressClock: () => new Date(now) },
      );
      await state.execute();
      expect(state.reads).toHaveBeenCalledTimes(4);
      expect(noteCounts).toEqual([0, 0, 0, Number(calibrated), Number(calibrated)]);
      expect(judgeCalls).toBe(1);
      expect(state.usage.filter((row) => row.operationKind === "learning")).toEqual([
        expect.objectContaining({
          operationId: "fixture-ticket:ticket-progress:1",
          runId: "fixture-run",
          provider: "openrouter",
          model: "openai/gpt-4.1-mini",
          costUsd: 0.002,
        }),
      ]);
      expect(state.events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "effect.recorded",
          payload: {
            kind: "ticket_progress_assessment",
            assessment: expect.objectContaining({
              status: calibrated ? "verified" : "unknown",
              reviewedVerdict: "stalled",
              verdict: calibrated ? "stalled" : "unknown",
            }),
          },
        }),
      );
      expect(state.ticket.workState?.progress).toMatchObject({
        replanIssued: calibrated,
        judge: { attempts: 1, costUsdSubtotal: 0.002 },
        lastDecision: {
          action: "continue",
          reason: calibrated ? "replan_budget_exhausted" : "judge_unknown",
        },
      });
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
    },
  );

  it("carries unique observations, reads evidence and delivers without repeating external writes", async () => {
    let observedReceipt: string | undefined;
    const state = fixture((request, index) => {
      const wire = JSON.stringify(request.messages);
      if (index === 1) {
        return { name: "fixture_write", args: { content: "Publish report" } };
      }
      if (index === 2) {
        expect(wire).toContain("unique-external-receipt-1");
        return { text: "Report published. Checks finished." };
      }
      if (index === 3) {
        observedReceipt = /unique-external-receipt-\d+/.exec(wire)?.[0];
        expect(observedReceipt).toBe("unique-external-receipt-1");
        expect(wire).toContain("Just-finished tool observations");
        const names = request.tools.map((tool) => tool.function.name);
        expect(names).toContain("deliver_work");
        expect(names).toContain("read_file");
        expect(names).not.toContain("fixture_write");
        expect(names).not.toContain("ticket_update");
        expect(names).not.toContain("run_subagent");
        expect(names).not.toContain("shell");
        return { name: "fixture_write", args: { content: "Must not repeat" } };
      }
      if (index === 4) {
        expect(wire).toMatch(/not found|unavailable|not available/i);
        return { name: "read_file", args: { path: "report.txt" } };
      }
      if (index === 5) {
        expect(wire).toContain("Verified artifact contains three rows.");
        return {
          name: "deliver_work",
          args: {
            result: {
              previousVersion: 0,
              summary: "Report published and checked.",
              findings: [
                {
                  outcome: "pass",
                  conclusion: "Report has three rows.",
                  evidence: `${observedReceipt}; report.txt contains three rows.`,
                },
              ],
            },
          },
        };
      }
      return { text: "Receipt delivered." };
    });
    await state.execute();
    expect(state.requests).toHaveLength(6);
    expect(state.runtimeRun).toHaveBeenCalledTimes(2);
    const [first, second] = state.runtimeRun.mock.calls.map(([request]) => request);
    expect(second!.model).toBe(first!.model);
    expect(second!.model.thinkingLevel).toBe("high");
    expect(state.requests.every((request) => request.model === "fixture-model")).toBe(true);
    expect(state.requests.every((request) => request.reasoning_effort === "high")).toBe(true);
    expect(state.writes).toHaveBeenCalledOnce();
    expect(state.reads).toHaveBeenCalledOnce();
    expect(delivery.receipts).toHaveLength(1);
    expect(delivery.receipts[0]).toMatchObject({
      id: "fixture-ticket",
      result: {
        findings: [{ evidence: "unique-external-receipt-1; report.txt contains three rows." }],
      },
    });
    expect(state.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    expect(state.usage).toHaveLength(6);
    expect(state.usage.map((row) => row.operationId)).toEqual([
      "fixture-run",
      "fixture-run",
      ...Array(4).fill("fixture-run:ticket-finalize"),
    ]);
    expect(new Set(state.usage.map((row) => row.callId)).size).toBe(6);
    expect(state.usage.every((row) => row.runId === "fixture-run")).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        message: "run.phase.started",
        "run.phase": "finalize",
        "phase.reason": "missing_work_receipt",
      }),
    );
    expect(JSON.stringify(state.events.append.mock.calls)).not.toContain("unique-external-receipt");
  });

  it("attempts receipt finalization only once and fails if it still has no receipt", async () => {
    const state = fixture(() => ({ text: "No receipt was delivered." }));
    await state.execute();
    expect(state.runtimeRun).toHaveBeenCalledTimes(2);
    expect(state.requests).toHaveLength(2);
    expect(state.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Ticket execution ended without delivering its work receipt.",
      }),
    );
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("keeps finalization usage attribution when producer accounting needs the consumer fallback", async () => {
    const state = fixture(() => ({ text: "Finished." }), { failUsageWriteAt: 2 });
    await state.execute();
    expect(state.runtimeRun).toHaveBeenCalledTimes(2);
    expect(state.usage).toHaveLength(2);
    expect(state.usage.map((row) => row.operationId)).toEqual([
      "fixture-run",
      "fixture-run:ticket-finalize",
    ]);
    expect(new Set(state.usage.map((row) => row.callId)).size).toBe(2);
    expect(state.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it.each(["ordinary-chat", "pilot-disabled", "receipt-present"] as const)(
    "does not add a finalization call for %s",
    async (scenario) => {
      if (scenario === "pilot-disabled") vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
      const state = fixture(() => ({ text: "Finished." }), {
        ticket: scenario !== "ordinary-chat",
        alreadyDelivered: scenario === "receipt-present",
      });
      await state.execute();
      expect(state.runtimeRun).toHaveBeenCalledOnce();
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      expect(state.usage.every((row) => row.operationId === "fixture-run")).toBe(true);
    },
  );

  it.each(["failed", "provider-error", "result-shaped", "recovery"] as const)(
    "uses actual stage recall in the executor for %s",
    async (scenario) => {
      vi.stubEnv("SELF_EVOLUTION", "true");
      const recalls: string[] = [];
      const provider = {
        describe: () => ({ capabilities: { managedFacts: true } }),
        read: async () => ({ ok: true, value: null }),
        recall: async (input: { query: string }) => {
          const staged =
            input.query.startsWith("Observed tool failure:") ||
            input.query.startsWith("Task recovery:");
          if (!staged) return { ok: true, value: [] };
          recalls.push(input.query);
          if (scenario === "provider-error") throw new Error("synthetic provider unavailable");
          return {
            ok: true,
            value: [
              {
                id: "exact-stage-lesson",
                revision: 4,
                memory: "Check the retained upload receipt.",
                score: 1,
              },
            ],
          };
        },
      } as unknown as SemanticMemoryProvider;
      const state = fixture(
        (_request, index) => {
          if (scenario !== "recovery" && index === 1)
            return { name: "fixture_write", args: { content: "report" } };
          return { text: "The operation needs another step." };
        },
        {
          semantic: provider,
          alreadyDelivered: true,
          initialFence: scenario === "recovery" ? 1 : 0,
          toolResult:
            scenario === "result-shaped"
              ? {
                  acceptance: {
                    status: "unknown",
                    results: [{ status: "unknown", reason: "synthetic gap" }],
                  },
                }
              : { error: "synthetic-write-failure" },
        },
      );
      await state.execute();
      const wire = JSON.stringify(state.requests.at(-1)?.messages);
      if (scenario === "failed" || scenario === "recovery")
        expect(wire).toContain("Check the retained upload receipt.");
      else expect(wire).not.toContain("Check the retained upload receipt.");
      if (scenario === "failed") expect(wire).toContain("synthetic-write-failure");
      expect(recalls).toHaveLength(scenario === "result-shaped" ? 0 : 1);
      expect(state.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "completed" }),
      );
      expect(state.requests).toHaveLength(scenario === "recovery" ? 1 : 2);
      // This fixture has no LessonUsage create delegate. Its unavailable audit must not fail the turn.
      if (scenario === "failed" || scenario === "recovery")
        expect(
          sink.events.some((event) => event.message === "lesson stage recall audit unavailable"),
        ).toBe(true);
    },
  );
});
