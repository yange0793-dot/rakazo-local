import type { JobPublisher } from "@rakazo/adapter-kit";
import { reflectRunJob } from "@rakazo/adapter-kit";
import { ticketReceiptsEnabled } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { isTerminal, messageReaction } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Deps = { prisma: PrismaClient; jobs: JobPublisher };

export async function workReceiptTicketId(
  prisma: Pick<Prisma.TransactionClient, "message" | "run">,
  actor: Actor,
  threadId: string,
  botId: string,
  parentId?: string,
): Promise<string | undefined> {
  if (!ticketReceiptsEnabled() || !parentId) return undefined;
  const parent = await prisma.message.findFirst({
    where: {
      id: parentId,
      threadId,
      botId,
      role: "bot",
      clientNonce: { startsWith: "work-receipt:" },
    },
    select: {
      replyToMessageId: true,
      runId: true,
    },
  });
  if (!parent?.runId || !parent.replyToMessageId) return undefined;
  const run = await prisma.run.findFirst({
    where: {
      id: parent.runId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ticket: {
        is: {
          spaceId: actor.spaceId,
          createdByUserId: actor.userId,
          createdByBotId: botId,
          originThreadId: threadId,
          originMessageId: parent.replyToMessageId,
        },
      },
    },
    select: { ticketId: true },
  });
  return run?.ticketId ?? undefined;
}

export async function reviewDislikedRun(deps: Deps, actor: Actor, runId: string): Promise<void> {
  const run = await deps.prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, status: true },
  });
  if (run && isTerminal(run.status)) await deps.jobs.enqueue(reflectRunJob(run.id, { auto: true }));
}

/** Work receipts accept written feedback directly; other replies can explain an earlier dislike. */
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
      clientNonce: true,
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
    ((ticketReceiptsEnabled() && parent.clientNonce?.startsWith("work-receipt:")) ||
      parent.replies.some(
        ({ blocks }) =>
          messageReaction({
            role: "user",
            replyToMessageId: parentId,
            blocks: blocks as MessageBlock[],
          }) === "👎",
      ))
  )
    await reviewDislikedRun(deps, actor, parent.runId);
}

export function logFeedbackReviewError(error: unknown): void {
  getLogger().error("feedback reflection enqueue", error);
}
