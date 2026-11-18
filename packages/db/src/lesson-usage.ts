import type { PrismaClient } from "./generated/prisma/client.js";

/** Run-level observation, not a verdict on the lesson. A settled null is uninformative. */
export type LessonOutcome = "completed" | "failed" | "denied" | null;

/**
 * Record the lessons a run actually put in front of the model. A run may be requeued and retry
 * the same turn, so the (run, lesson) primary key makes a repeated record a no-op.
 */
export async function recordLessonUse(
  db: PrismaClient,
  input: {
    spaceId: string;
    botId: string;
    runId: string;
    lessons: ReadonlyArray<{ id: string; revision: number }>;
  },
): Promise<void> {
  if (!input.lessons.length) return;
  await db.lessonUsage.createMany({
    data: input.lessons.map(({ id, revision }) => ({
      spaceId: input.spaceId,
      botId: input.botId,
      lessonId: id,
      firstRevision: revision,
      runId: input.runId,
    })),
    skipDuplicates: true,
  });
}

/** Write how the run ended onto every lesson it saw; rows of other runs are untouched. */
export async function settleLessonUse(
  db: PrismaClient,
  input: { spaceId: string; runId: string; outcome: LessonOutcome },
): Promise<void> {
  await db.lessonUsage.updateMany({
    where: { spaceId: input.spaceId, runId: input.runId, settledAt: null },
    data: { outcome: input.outcome, settledAt: new Date() },
  });
}

/** Completed, failed and denied uses of one lesson. Rows without an outcome are not counted. */
export async function lessonOutcomeCounts(
  db: PrismaClient,
  lessonId: string,
): Promise<{ completed: number; failed: number; denied: number }> {
  const groups = await db.lessonUsage.groupBy({
    by: ["outcome"],
    where: { lessonId },
    _count: { _all: true },
  });
  const counts = { completed: 0, failed: 0, denied: 0 };
  for (const group of groups) {
    if (group.outcome === "completed" || group.outcome === "failed" || group.outcome === "denied")
      counts[group.outcome] = group._count._all;
  }
  return counts;
}
