import type { Prisma, SendUserMessageInput } from "@rakazo/db";
import { routeTicketSourceEventInTransaction } from "../../../packages/adapters/src/ticket-subscriptions.js";

/** Used inside message writes, before the ordinary chat fallback can create another run. */
export async function routeThreadTicketSource(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    ticketBoardEnabled?: boolean;
  },
  message: { id: string; seq: number },
): ReturnType<NonNullable<SendUserMessageInput["routeSourceEvent"]>> {
  const route = await routeTicketSourceEventInTransaction(tx, {
    ...input,
    event: {
      source: { type: "thread", threadId: input.threadId },
      eventId: message.id,
      messageId: message.id,
      position: message.seq,
    },
  });
  if (route.status !== "routed") return null;
  const run = route.runId
    ? await tx.run.findFirst({
        where: {
          id: route.runId,
          spaceId: input.spaceId,
          userId: input.userId,
          ticketId: route.ticketId,
        },
        select: { id: true, taskId: true, status: true, botId: true },
      })
    : null;
  return { run };
}
