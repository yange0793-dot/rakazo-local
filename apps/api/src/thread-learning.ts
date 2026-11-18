import type { JobPublisher } from "@rakazo/adapter-kit";
import { reflectRunJob } from "@rakazo/adapter-kit";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { isTerminal, messageReaction } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Deps = { prisma: PrismaClient; jobs: JobPublisher };

export async function reviewDislikedRun(deps: Deps, actor: Actor, runId: string): Promise<void> {
  const run = await deps.prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, status: true },
  });
  if (run && isTerminal(run.status)) await deps.jobs.enqueue(reflectRunJob(run.id, { auto: true }));
}

/** A written reply to the same bot message can explain a dislike after its first review ran. */
export async function reviewExplainedDislike(
  deps: Deps,
  actor: Actor,
  threadId: string,
  parentId: string,
  beforeSeq: number,
): Promise<void> {
  const parent = await deps.prisma.message.findFirst({
    where: { id: parentId, threadId, role: "bot", runId: { not: null } },
    select: {
      runId: true,
      replies: {
        where: { role: "user", authorUserId: actor.userId, seq: { lt: beforeSeq } },
        orderBy: { seq: "desc" },
        take: 20,
        select: { blocks: true },
      },
    },
  });
  if (
    parent?.runId &&
    parent.replies.some(
      ({ blocks }) =>
        messageReaction({
          role: "user",
          replyToMessageId: parentId,
          blocks: blocks as MessageBlock[],
        }) === "👎",
    )
  )
    await reviewDislikedRun(deps, actor, parent.runId);
}

export function logFeedbackReviewError(error: unknown): void {
  getLogger().error("feedback reflection enqueue", error);
}
