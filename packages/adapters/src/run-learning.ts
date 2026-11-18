import { reflectRunJob } from "@rakazo/adapter-kit";
import { lessonOutcomeCounts, SemanticFactStore, settleLessonUse } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import { isRunTainted } from "./run-context.js";
import { selfEvolutionEnabled } from "./self-evolution.js";

export type RunSignal =
  | "run_failed"
  | "approval_denied"
  | "tool_error"
  | "user_steering"
  | "stuck_loop";

export interface RunSignals {
  outcome: "completed" | "failed";
  learnableFailure: boolean;
  signals: RunSignal[];
  denied: boolean;
}

/** One failed tool call is noise; three in one run say the procedure itself went wrong. */
export const TOOL_ERROR_SIGNAL_MIN = 3;
/** A lesson that failed this often with no success at all is no longer a hint, so it retires. */
const FAILURES_BEFORE_RETIRE = 3;
/** A broken routine retries; one review per six hours is enough to learn from it. */
const ROUTINE_REVIEW_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** The taint snapshot the reflection job reads, saved while this attempt still owns the run. */
export async function persistRunTaint(ctx: RunContext): Promise<void> {
  if (!selfEvolutionEnabled()) return;
  const tainted = await isRunTainted(ctx);
  await ctx.deps.prisma.run.updateMany({
    where: {
      id: ctx.runId,
      status: "running",
      leaseOwner: ctx.workerId,
      leaseFence: ctx.fence,
    },
    data: { tainted },
  });
}

/** Only a run that asked for an approval can have a denial to find. */
async function approvalDenied(ctx: RunContext): Promise<boolean> {
  if (ctx.state.effects.counts.size === 0) return false;
  const denied = await ctx.deps.prisma.externalEffect.findFirst({
    where: { runId: ctx.runId, status: "denied" },
    select: { id: true },
  });
  return denied !== null;
}

/**
 * What this run is worth learning from, read from the attempt's own state plus one refusal
 * lookup. Off when self-evolution is off: no queries, no queue entries.
 */
export async function collectRunSignals(
  ctx: RunContext,
  outcome: "completed" | "failed",
  learnableFailure = false,
): Promise<RunSignals> {
  if (!selfEvolutionEnabled()) {
    return { outcome, learnableFailure, signals: [], denied: false };
  }
  const denied = await approvalDenied(ctx);
  const failedTools = [...ctx.state.reply.toolOutcomes.values()].filter(
    (value) => value === "failed",
  ).length;
  const signals: RunSignal[] = [];
  // Provider, account and rate-limit failures end a run without saying anything about its task.
  if (outcome === "failed" && learnableFailure && ctx.state.reply.toolOutcomes.size > 0) {
    signals.push("run_failed");
  }
  if (denied) signals.push("approval_denied");
  if (failedTools >= TOOL_ERROR_SIGNAL_MIN) signals.push("tool_error");
  if (ctx.state.steeringClaimed > 0) signals.push("user_steering");
  if (ctx.state.toolLoopStopped) signals.push("stuck_loop");
  return { outcome, learnableFailure, signals, denied };
}

/** A failed run whose lessons never once helped is retired rather than kept as advice. */
async function retireFailedLessons(ctx: RunContext, lessonIds: readonly string[]): Promise<void> {
  const store = new SemanticFactStore(ctx.deps.prisma);
  for (const lessonId of new Set(lessonIds)) {
    const counts = await lessonOutcomeCounts(ctx.deps.prisma, lessonId);
    if (counts.completed > 0 || counts.failed + counts.denied < FAILURES_BEFORE_RETIRE) continue;
    await store.retireLesson(lessonId, ctx.context);
  }
}

async function routineReviewedRecently(ctx: RunContext): Promise<boolean> {
  const recent = await ctx.deps.prisma.run.findFirst({
    where: {
      routineId: ctx.run.routineId,
      status: "failed",
      id: { not: ctx.runId },
      completedAt: {
        gt: new Date((ctx.deps.now?.() ?? new Date()).getTime() - ROUTINE_REVIEW_BACKOFF_MS),
      },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * Run close: settle how this run used its lessons, retire ones that keep failing, and queue a
 * reflection when the run said something worth learning. Called after the run is finalized.
 */
export async function finishRunLearning(ctx: RunContext, signals: RunSignals): Promise<void> {
  if (!selfEvolutionEnabled()) return;
  const { deps, run, runId } = ctx;
  const lessonIds = ctx.state.injectedLessonIds;
  if (lessonIds.length > 0) {
    const outcome =
      signals.outcome === "failed" ? "failed" : signals.denied ? "denied" : "completed";
    await settleLessonUse(deps.prisma, { spaceId: run.spaceId, runId, outcome });
    if (outcome !== "completed") await retireFailedLessons(ctx, lessonIds);
  }
  // One reflection per run: the replace key absorbs a repeat of the same run.
  if (signals.signals.length === 0) return;
  if (run.trigger === "routine" && run.routineId && (await routineReviewedRecently(ctx))) return;
  await deps.jobs.enqueue(reflectRunJob(runId, { auto: true }));
}
