import { reflectRunJob } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { listClaimedUserSteering, settleLessonUse } from "@rakazo/db";
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
    data: { tainted, learningSourceChecked: true },
  });
}

/**
 * The first lease has all its signals in memory. Later leases can follow an approval, a
 * requeue, or a wait before the first turn, so consult the run's durable records too.
 */
export async function collectRunSignals(
  ctx: RunContext,
  outcome: "completed" | "failed",
  learnableFailure = false,
): Promise<RunSignals> {
  if (!selfEvolutionEnabled()) {
    return { outcome, learnableFailure, signals: [], denied: false };
  }
  const { prisma } = ctx.deps;
  const resumed = ctx.fence > 1;
  const [denial, priorTools, earlierSteering] = await Promise.all([
    resumed || ctx.state.effects.counts.size
      ? prisma.externalEffect.findFirst({
          where: { runId: ctx.runId, status: "denied" },
          select: { id: true },
        })
      : null,
    resumed
      ? prisma.event.findMany({
          where: { runId: ctx.runId, type: "agent.tool.completed" },
          orderBy: { seq: "desc" },
          select: { payload: true },
        })
      : [],
    resumed && !ctx.state.steeringClaimed ? listClaimedUserSteering(prisma, ctx.run, 1) : [],
  ]);
  let outcomes = ctx.state.reply.toolOutcomes;
  if (priorTools.length) {
    // Audit IDs use the same redaction. Prefer this attempt (even if its audit append failed),
    // then the newest terminal result for each execution. A pause has no tool outcome.
    outcomes = new Map([...outcomes].map(([id, value]) => [redactSecrets(id, ctx.secrets), value]));
    for (const { payload } of priorTools) {
      const tool = payload as { executionId?: string; outcome?: string } | null;
      if (typeof tool?.executionId !== "string" || outcomes.has(tool.executionId)) continue;
      if (tool.outcome === "error") outcomes.set(tool.executionId, "failed");
      if (tool.outcome === "succeeded") outcomes.set(tool.executionId, "succeeded");
    }
  }
  const denied = denial !== null;
  const failedTools = [...outcomes.values()].filter((value) => value === "failed").length;
  const signals: RunSignal[] = [];
  // Provider, account and rate-limit failures end a run without saying anything about its task.
  if (outcome === "failed" && learnableFailure && outcomes.size > 0) {
    signals.push("run_failed");
  }
  if (denied) signals.push("approval_denied");
  if (failedTools >= TOOL_ERROR_SIGNAL_MIN) signals.push("tool_error");
  if (ctx.state.steeringClaimed > 0 || earlierSteering.length > 0) signals.push("user_steering");
  if (ctx.state.toolLoopStopped) signals.push("stuck_loop");
  return { outcome, learnableFailure, signals, denied };
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
 * Close exposures across all attempts. A run status cannot establish that a particular hint
 * helped or hurt, so it never retires a lesson. A correction can still replace or forget it.
 */
export async function finishRunLearning(ctx: RunContext, signals: RunSignals): Promise<void> {
  if (!selfEvolutionEnabled()) return;
  const { deps, run, runId } = ctx;
  const inconclusive =
    signals.signals.includes("stuck_loop") ||
    (signals.outcome === "failed" && !signals.learnableFailure);
  await settleLessonUse(deps.prisma, {
    spaceId: run.spaceId,
    runId,
    outcome: inconclusive ? null : signals.denied ? "denied" : signals.outcome,
  });
  // One reflection per run: the replace key absorbs a repeat of the same run.
  if (signals.signals.length === 0) return;
  if (run.trigger === "routine" && run.routineId && (await routineReviewedRecently(ctx))) return;
  await deps.jobs.enqueue(reflectRunJob(runId, { auto: true }));
}
