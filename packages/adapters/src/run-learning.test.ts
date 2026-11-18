import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import {
  collectRunSignals,
  finishRunLearning,
  persistRunTaint,
  TOOL_ERROR_SIGNAL_MIN,
} from "./run-learning.js";

const stubs = vi.hoisted(() => ({
  retireLesson: vi.fn(async (_id: string, _ctx: unknown) => undefined),
  lessonOutcomeCounts: vi.fn(async (_db: unknown, _lessonId: string) => ({
    completed: 0,
    failed: 0,
    denied: 0,
  })),
  settleLessonUse: vi.fn(
    async (_db: unknown, _input: { spaceId: string; runId: string; outcome: string }) => undefined,
  ),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    SemanticFactStore: class {
      retireLesson = stubs.retireLesson;
    },
    lessonOutcomeCounts: stubs.lessonOutcomeCounts,
    settleLessonUse: stubs.settleLessonUse,
  };
});

const originalSelfEvolution = process.env.SELF_EVOLUTION;

beforeEach(() => {
  process.env.SELF_EVOLUTION = "1";
  stubs.retireLesson.mockClear();
  stubs.lessonOutcomeCounts.mockReset().mockResolvedValue({ completed: 0, failed: 0, denied: 0 });
  stubs.settleLessonUse.mockClear();
});

afterEach(() => {
  if (originalSelfEvolution === undefined) delete process.env.SELF_EVOLUTION;
  else process.env.SELF_EVOLUTION = originalSelfEvolution;
});

const CONTEXT = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

function fixture(
  options: {
    trigger?: string;
    routineId?: string | null;
    outcomes?: Array<"succeeded" | "failed" | "stopped">;
    steeringClaimed?: number;
    toolLoopStopped?: boolean;
    effectsRan?: number;
    denied?: boolean;
    recentRoutineFailure?: boolean;
    tainted?: boolean;
    earlierAttempts?: number;
    outsideMessage?: boolean;
    priorTools?: Array<{ executionId: string; outcome: "error" | "succeeded" | "paused" }>;
  } = {},
) {
  const enqueue = vi.fn(async (_job: unknown) => undefined);
  const runUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
  const runFindFirst = vi.fn(async (_args: unknown) =>
    options.recentRoutineFailure ? { id: "prior-run" } : null,
  );
  const effectFindFirst = vi.fn(async (_args: unknown) =>
    options.denied ? { id: "effect-1" } : null,
  );
  const ctx = {
    runId: "run-1",
    workerId: "worker-1",
    fence: options.earlierAttempts ? 2 : 1,
    secrets: [],
    run: {
      id: "run-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
      userId: "user-1",
      trigger: options.trigger ?? "user",
      routineId: options.routineId ?? null,
    },
    context: CONTEXT,
    deps: {
      prisma: {
        run: { updateMany: runUpdateMany, findFirst: runFindFirst },
        attempt: { count: vi.fn(async () => options.earlierAttempts ?? 0) },
        externalEffect: { findFirst: effectFindFirst },
        event: {
          findMany: vi.fn(async ({ where }: { where: { type: string } }) =>
            where.type === "agent.tool.completed"
              ? (options.priorTools ?? []).map((payload) => ({ payload }))
              : [],
          ),
        },
      },
      jobs: { enqueue },
      now: () => new Date("2026-11-18T12:00:00Z"),
    },
    trust: { receivedOutsideMessage: vi.fn(async () => options.outsideMessage ?? false) },
    state: {
      tainted: options.tainted ?? false,
      earlierAttempt: undefined,
      reply: {
        toolOutcomes: new Map(
          (options.outcomes ?? []).map((outcome, index) => [`call-${index}`, outcome]),
        ),
      },
      effects: {
        counts: new Map(
          Array.from({ length: options.effectsRan ?? 0 }, (_, index) => [`fp-${index}`, 1]),
        ),
      },
      steeringClaimed: options.steeringClaimed ?? 0,
      toolLoopStopped: options.toolLoopStopped ?? false,
    },
  };
  return {
    ctx: ctx as unknown as RunContext,
    enqueue,
    runUpdateMany,
    runFindFirst,
    effectFindFirst,
  };
}

const completed = {
  outcome: "completed" as const,
  learnableFailure: false,
  signals: [],
  denied: false,
};

describe("collectRunSignals", () => {
  it("reports no signals for a clean completed run", async () => {
    const { ctx, effectFindFirst } = fixture({ outcomes: ["succeeded", "succeeded"] });
    expect(await collectRunSignals(ctx, "completed")).toEqual(completed);
    expect(effectFindFirst).not.toHaveBeenCalled();
  });

  it("signals a learnable failure only when the run used a tool", async () => {
    const withTool = fixture({ outcomes: ["failed"] });
    const signals = await collectRunSignals(withTool.ctx, "failed", true);
    expect(signals.signals).toEqual(["run_failed"]);
    expect(signals.outcome).toBe("failed");

    // The same failure from a provider or account problem learns nothing about the task.
    const notLearnable = fixture({ outcomes: ["succeeded"] });
    expect((await collectRunSignals(notLearnable.ctx, "failed", false)).signals).toEqual([]);

    // A run that never called a tool has no procedure to learn from either.
    const noTools = fixture();
    expect((await collectRunSignals(noTools.ctx, "failed", true)).signals).toEqual([]);
  });

  it("signals a denied approval only after asking for one", async () => {
    const denied = fixture({ effectsRan: 1, denied: true });
    expect(await collectRunSignals(denied.ctx, "completed")).toMatchObject({
      denied: true,
      signals: ["approval_denied"],
    });

    const neverAsked = fixture({ denied: true });
    expect((await collectRunSignals(neverAsked.ctx, "completed")).signals).toEqual([]);
    expect(neverAsked.effectFindFirst).not.toHaveBeenCalled();
  });

  it("signals three failed tool calls, steering and a stopped loop", async () => {
    const failures = Array.from({ length: TOOL_ERROR_SIGNAL_MIN }, () => "failed" as const);
    const two = fixture({ outcomes: failures.slice(0, 2) });
    expect((await collectRunSignals(two.ctx, "completed")).signals).toEqual([]);
    const three = fixture({ outcomes: failures });
    expect((await collectRunSignals(three.ctx, "completed")).signals).toEqual(["tool_error"]);

    const steered = fixture({ steeringClaimed: 1 });
    expect((await collectRunSignals(steered.ctx, "completed")).signals).toEqual(["user_steering"]);

    const looped = fixture({ toolLoopStopped: true });
    expect((await collectRunSignals(looped.ctx, "completed")).signals).toEqual(["stuck_loop"]);
  });

  it("counts the last terminal outcome of each execution across a fresh attempt", async () => {
    const { ctx } = fixture({
      earlierAttempts: 2,
      tainted: true,
      outcomes: ["succeeded"],
      // Newest first, as read from the audit. This attempt recovered call-0.
      priorTools: [
        { executionId: "call-0", outcome: "error" },
        { executionId: "a", outcome: "error" },
        { executionId: "a", outcome: "error" },
        { executionId: "b", outcome: "error" },
        { executionId: "c", outcome: "paused" },
        { executionId: "d", outcome: "succeeded" },
        { executionId: "d", outcome: "error" },
      ],
    });
    expect(await collectRunSignals(ctx, "completed")).toEqual(completed);
    ctx.state.reply.toolOutcomes.set("c", "failed");
    expect((await collectRunSignals(ctx, "completed")).signals).toEqual(["tool_error"]);
  });

  it("finds earlier denials and tool work even when the last attempt calls no tools", async () => {
    const { ctx } = fixture({
      earlierAttempts: 2,
      tainted: true,
      denied: true,
      priorTools: [{ executionId: "earlier", outcome: "succeeded" }],
    });
    expect(await collectRunSignals(ctx, "failed", true)).toMatchObject({
      signals: ["run_failed", "approval_denied"],
      denied: true,
    });
    const paused = fixture({
      earlierAttempts: 2,
      priorTools: [{ executionId: "ask", outcome: "paused" }],
    });
    expect((await collectRunSignals(paused.ctx, "failed", true)).signals).toEqual([]);
  });

  it("does nothing at all when self-evolution is off", async () => {
    process.env.SELF_EVOLUTION = "off";
    const { ctx, effectFindFirst } = fixture({
      effectsRan: 1,
      denied: true,
      outcomes: ["failed", "failed", "failed"],
      steeringClaimed: 2,
      toolLoopStopped: true,
    });
    expect(await collectRunSignals(ctx, "failed", true)).toEqual({
      outcome: "failed",
      learnableFailure: true,
      signals: [],
      denied: false,
    });
    expect(effectFindFirst).not.toHaveBeenCalled();
  });
});

describe("finishRunLearning", () => {
  it("settles the lessons this run saw and queues one reflection", async () => {
    const { ctx, enqueue } = fixture();
    await finishRunLearning(ctx, {
      outcome: "completed",
      learnableFailure: false,
      signals: ["user_steering"],
      denied: false,
    });
    expect(stubs.settleLessonUse).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      spaceId: "space-1",
      runId: "run-1",
      outcome: "completed",
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "harness.reflect",
        payload: { runId: "run-1", auto: true },
      }),
    );
  });

  it("settles a failure as failed and a denied run as denied", async () => {
    const failed = fixture();
    await finishRunLearning(failed.ctx, {
      outcome: "failed",
      learnableFailure: true,
      signals: ["run_failed"],
      denied: false,
    });
    expect(stubs.settleLessonUse).toHaveBeenLastCalledWith(expect.anything(), {
      spaceId: "space-1",
      runId: "run-1",
      outcome: "failed",
    });

    const denied = fixture();
    await finishRunLearning(denied.ctx, {
      outcome: "completed",
      learnableFailure: false,
      signals: ["approval_denied"],
      denied: true,
    });
    expect(stubs.settleLessonUse).toHaveBeenLastCalledWith(expect.anything(), {
      spaceId: "space-1",
      runId: "run-1",
      outcome: "denied",
    });
  });

  it("never retires a surfaced lesson based on run-level failures", async () => {
    const { ctx } = fixture();
    await finishRunLearning(ctx, {
      outcome: "failed",
      learnableFailure: true,
      signals: ["run_failed"],
      denied: false,
    });
    expect(stubs.retireLesson).not.toHaveBeenCalled();
    expect(stubs.lessonOutcomeCounts).not.toHaveBeenCalled();
  });

  it("settles infrastructure failures and loop stops as inconclusive including earlier attempts", async () => {
    const { ctx } = fixture({ earlierAttempts: 2 });
    await finishRunLearning(ctx, { ...completed, outcome: "failed" });
    await finishRunLearning(ctx, { ...completed, signals: ["stuck_loop"] });
    expect(stubs.settleLessonUse.mock.calls.map(([, row]) => row)).toEqual([
      { spaceId: "space-1", runId: "run-1", outcome: null },
      { spaceId: "space-1", runId: "run-1", outcome: null },
    ]);
    expect(stubs.retireLesson).not.toHaveBeenCalled();
  });

  it("does not queue a routine review while a recent routine failure is still fresh", async () => {
    const throttled = fixture({
      trigger: "routine",
      routineId: "routine-1",
      recentRoutineFailure: true,
    });
    await finishRunLearning(throttled.ctx, {
      outcome: "failed",
      learnableFailure: true,
      signals: ["run_failed"],
      denied: false,
    });
    expect(throttled.enqueue).not.toHaveBeenCalled();
    const where = throttled.runFindFirst.mock.calls[0]![0] as {
      where: { routineId: string; status: string; completedAt: { gt: Date } };
    };
    expect(where.where.routineId).toBe("routine-1");
    expect(where.where.status).toBe("failed");
    expect(where.where.completedAt.gt.toISOString()).toBe("2026-11-18T06:00:00.000Z");

    const fresh = fixture({ trigger: "routine", routineId: "routine-1" });
    await finishRunLearning(fresh.ctx, {
      outcome: "failed",
      learnableFailure: true,
      signals: ["run_failed"],
      denied: false,
    });
    expect(fresh.enqueue).toHaveBeenCalledOnce();
  });

  it("queues nothing without a signal and touches nothing when self-evolution is off", async () => {
    const quiet = fixture();
    await finishRunLearning(quiet.ctx, completed);
    expect(quiet.enqueue).not.toHaveBeenCalled();

    process.env.SELF_EVOLUTION = "off";
    stubs.settleLessonUse.mockClear();
    const off = fixture();
    await finishRunLearning(off.ctx, {
      outcome: "failed",
      learnableFailure: true,
      signals: ["run_failed"],
      denied: false,
    });
    expect(off.enqueue).not.toHaveBeenCalled();
    expect(off.runFindFirst).not.toHaveBeenCalled();
    expect(stubs.settleLessonUse).not.toHaveBeenCalled();
  });
});

describe("persistRunTaint", () => {
  it("saves the attempt's taint snapshot under its lease", async () => {
    const { ctx, runUpdateMany } = fixture({ tainted: true });
    await persistRunTaint(ctx);
    expect(runUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "run-1", status: "running", leaseOwner: "worker-1", leaseFence: 1 },
      data: { tainted: true, learningSourceChecked: true },
    });
  });

  it("treats a later attempt as tainted", async () => {
    const { ctx, runUpdateMany } = fixture({ earlierAttempts: 2 });
    await persistRunTaint(ctx);
    expect(runUpdateMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: { tainted: true, learningSourceChecked: true } }),
    );
  });

  it("does not query or write when self-evolution is off", async () => {
    process.env.SELF_EVOLUTION = "off";
    const { ctx, runUpdateMany } = fixture({ tainted: true });
    await persistRunTaint(ctx);
    expect(runUpdateMany).not.toHaveBeenCalled();
  });
});
