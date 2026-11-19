import type { MessageBlock } from "@rakazo/contracts";
import type { Run } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  lockSpaceGroup,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  touchGroupUpdatedAt,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

/** What a ticket's run is waiting on; the original chat says which. */
export type TicketAttention = "answer" | "approval" | "takeover";

const NEEDS_TEXT: Record<TicketAttention, string> = {
  answer: "needs your answer",
  approval: "needs your approval",
  takeover: "needs you at the computer",
};

/**
 * A chat ticket's run paused on its person, but its card is only in the executor's own thread.
 * Say so once in the chat that asked for the work, so the request does not look unfinished.
 * `waitId` names the pause, and one attempt pauses at most once.
 */
export async function announceTicketAttention(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: Pick<Run, "spaceId" | "userId" | "botId" | "threadId" | "ticketId">,
  input: { waitId: string; needs: TicketAttention },
): Promise<void> {
  if (!ticketReceiptsEnabled() || !run.ticketId) return;
  const ticket = await deps.prisma.ticket.findFirst({
    where: {
      id: run.ticketId,
      spaceId: run.spaceId,
      createdByUserId: run.userId,
      originKey: { not: null },
      assigneeBotId: run.botId,
    },
    include: {
      originThread: {
        select: { id: true, groupId: true, externalConversationId: true },
      },
      board: { select: { ticketPrefix: true } },
    },
  });
  const origin = ticket?.originThread;
  const originMessageId = ticket?.originMessageId;
  const author = ticket?.createdByBotId;
  if (
    !ticket ||
    !origin ||
    !originMessageId ||
    !author ||
    origin.externalConversationId ||
    // The card already is in this chat when the ticket's own run paused here.
    run.threadId === origin.id
  )
    return;
  const ref = `${ticket.board.ticketPrefix}-${ticket.number}`;
  const blocks: MessageBlock[] = [{ kind: "text", text: `${ref} ${NEEDS_TEXT[input.needs]}.` }];
  const clientNonce = `work-attention:${ticket.id}:${input.waitId}`;
  try {
    await writeAttention(deps, run, {
      threadId: origin.id,
      groupId: origin.groupId,
      botId: author,
      originMessageId,
      blocks,
      clientNonce,
    });
  } catch (error) {
    // The pause already committed and its card still takes the answer; only the note in
    // the original chat is missing, so the paused work does not fail over it.
    getLogger().warn("ticket attention announce", { error });
  }
}

/** Host-authored reply in the chat that asked for the work, deduplicated by its nonce. */
async function writeAttention(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: Pick<Run, "spaceId" | "userId" | "botId">,
  input: {
    threadId: string;
    groupId: string | null;
    botId: string;
    originMessageId: string;
    blocks: MessageBlock[];
    clientNonce: string;
  },
): Promise<void> {
  const seq = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      // A group is locked before its thread, as receipts and group sends take them.
      if (input.groupId) await lockSpaceGroup(tx, run, input.groupId);
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
      const previous = await tx.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: input.threadId, clientNonce: input.clientNonce },
        },
        select: { id: true },
      });
      if (previous) return null;
      // The same chat and author checks a receipt passes before it writes here.
      const chat = await tx.thread.findFirst({
        where: {
          id: input.threadId,
          spaceId: run.spaceId,
          ...(input.groupId
            ? {
                groupId: input.groupId,
                group: {
                  archivedAt: null,
                  members: {
                    some: { botId: input.botId, bot: { userId: run.userId, archivedAt: null } },
                  },
                },
              }
            : {
                botId: input.botId,
                bot: { userId: run.userId, archivedAt: null },
              }),
        },
        select: { id: true },
      });
      const source = chat
        ? await tx.message.findFirst({
            where: {
              id: input.originMessageId,
              threadId: input.threadId,
              role: "user",
              authorUserId: run.userId,
            },
            select: { id: true },
          })
        : null;
      if (!source) return null;
      if (input.groupId) await touchGroupUpdatedAt(tx, input.groupId);
      const message = await createThreadMessageInTransaction(tx, {
        threadId: input.threadId,
        role: "bot",
        botId: input.botId,
        replyToMessageId: source.id,
        blocks: input.blocks,
        clientNonce: input.clientNonce,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        type: "thread.message.created",
        payload: {
          messageId: message.id,
          role: "bot",
          blocks: input.blocks,
          replyToMessageId: source.id,
          clientNonce: input.clientNonce,
        },
      });
      return event.seq;
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  if (seq !== null) await deps.events.notify(input.threadId, seq);
}
