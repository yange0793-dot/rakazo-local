import type { Actor, TicketSubscriptionSource } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

export type TicketSubscriptionRecord = {
  id: string;
  ticketId: string;
  spaceId: string;
  threadId: string | null;
  externalConversationId: string | null;
  active: boolean;
  lastProcessedPosition: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketSubscriptionClient = PrismaClient | Prisma.TransactionClient;

export type TicketSubscriptionRunEvent = {
  eventId: string;
  position: number;
  source: TicketSubscriptionSource;
  message: {
    id: string;
    threadId: string;
    seq: number;
    role: string;
    blocks: Prisma.JsonValue;
    createdAt: Date;
  };
};

function ownedThreadWhere(spaceId: string, userId: string): Prisma.ThreadWhereInput {
  return {
    spaceId,
    userId,
    space: { deletingAt: null, memberships: { some: { userId } } },
    OR: [
      { bot: { is: { spaceId, userId, archivedAt: null } } },
      {
        group: {
          is: {
            spaceId,
            userId,
            archivedAt: null,
            members: {
              some: { bot: { is: { spaceId, userId, archivedAt: null } } },
            },
          },
        },
      },
      {
        externalConversation: {
          is: {
            spaceId,
            userId,
            bot: { is: { spaceId, userId, archivedAt: null } },
          },
        },
      },
    ],
  };
}

async function sourcePosition(
  prisma: TicketSubscriptionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  source: TicketSubscriptionSource,
): Promise<{ threadId: string; position: number; sourceBotIds: string[] } | null> {
  if (source.type === "thread") {
    const thread = await prisma.thread.findFirst({
      where: { id: source.threadId, ...ownedThreadWhere(actor.spaceId, actor.userId) },
      select: {
        id: true,
        nextMessageSeq: true,
        botId: true,
        externalConversation: { select: { botId: true } },
        group: { select: { members: { select: { botId: true } } } },
      },
    });
    return thread
      ? {
          threadId: thread.id,
          position: thread.nextMessageSeq,
          sourceBotIds: [
            ...new Set(
              [
                thread.botId,
                thread.externalConversation?.botId,
                ...(thread.group?.members.map((member) => member.botId) ?? []),
              ].filter((id): id is string => Boolean(id)),
            ),
          ],
        }
      : null;
  }

  const conversation = await prisma.externalConversation.findFirst({
    where: {
      id: source.externalConversationId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      bot: { is: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null } },
      thread: { is: { spaceId: actor.spaceId, userId: actor.userId } },
    },
    select: { botId: true, thread: { select: { id: true, nextMessageSeq: true } } },
  });
  return conversation?.thread
    ? {
        threadId: conversation.thread.id,
        position: conversation.thread.nextMessageSeq,
        sourceBotIds: [conversation.botId],
      }
    : null;
}

async function ownedTicket(
  prisma: TicketSubscriptionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  ticketId: string,
) {
  return prisma.ticket.findFirst({
    where: {
      id: ticketId,
      spaceId: actor.spaceId,
      createdByUserId: actor.userId,
      status: { notIn: ["done", "closed"] },
      space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      assigneeBot: {
        is: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      },
    },
    select: { id: true, spaceId: true, assigneeBotId: true },
  });
}

export async function createTicketSubscription(
  prisma: PrismaClient,
  actor: Actor,
  input: { ticketId: string; source: TicketSubscriptionSource },
): Promise<TicketSubscriptionRecord> {
  return prisma.$transaction(async (tx) => {
    const ticket = await ownedTicket(tx, actor, input.ticketId);
    if (!ticket?.assigneeBotId) throw new IsolationError();
    const position = await sourcePosition(tx, actor, input.source);
    if (!position) throw new IsolationError();

    // Thread writers take this same row lock. Starting at its current sequence subscribes
    // only to subsequent source events, never to the existing transcript/backfill.
    const locked = await tx.$queryRaw<Array<{ nextMessageSeq: number }>>`
      SELECT "nextMessageSeq" FROM threads
      WHERE id = ${position.threadId} AND "spaceId" = ${actor.spaceId}
      FOR UPDATE`;
    if (!locked[0]) throw new IsolationError();

    const source =
      input.source.type === "thread"
        ? { threadId: input.source.threadId, externalConversationId: null }
        : { threadId: null, externalConversationId: input.source.externalConversationId };
    const existing = await tx.ticketSubscription.findFirst({
      where: { ticketId: ticket.id, spaceId: actor.spaceId, ...source },
    });
    if (existing?.active) return existing;
    if (existing) {
      return tx.ticketSubscription.update({
        where: { id: existing.id },
        data: { active: true, lastProcessedPosition: locked[0].nextMessageSeq },
      });
    }
    return tx.ticketSubscription.create({
      data: {
        ticketId: ticket.id,
        spaceId: actor.spaceId,
        ...source,
        active: true,
        lastProcessedPosition: locked[0].nextMessageSeq,
      },
    });
  });
}

export async function cancelTicketSubscription(
  prisma: PrismaClient,
  actor: Actor,
  input: { subscriptionId: string },
): Promise<boolean> {
  const result = await prisma.ticketSubscription.updateMany({
    where: {
      id: input.subscriptionId,
      spaceId: actor.spaceId,
      active: true,
      space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
      ticket: {
        is: {
          createdByUserId: actor.userId,
          assigneeBot: {
            is: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
          },
        },
      },
    },
    data: { active: false },
  });
  return result.count === 1;
}

export async function resolveTicketSubscription(
  prisma: TicketSubscriptionClient,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    source: TicketSubscriptionSource;
  },
): Promise<
  | {
      status: "matched";
      subscriptionId: string;
      ticketId: string;
      botId: string;
      sourceThreadId: string;
    }
  | { status: "unknown" }
  | { status: "ambiguous" }
> {
  const position = await sourcePosition(prisma, input, input.source);
  if (!position) return { status: "unknown" };
  if (!position.sourceBotIds.includes(input.botId)) return { status: "unknown" };
  const sourceBot = await prisma.bot.findFirst({
    where: {
      id: input.botId,
      spaceId: input.spaceId,
      userId: input.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!sourceBot) return { status: "unknown" };

  const sourceFilter =
    input.source.type === "thread"
      ? { threadId: input.source.threadId }
      : { externalConversationId: input.source.externalConversationId };
  const matches = await prisma.ticketSubscription.findMany({
    where: {
      spaceId: input.spaceId,
      active: true,
      ...sourceFilter,
      ticket: {
        is: {
          spaceId: input.spaceId,
          createdByUserId: input.userId,
          status: { notIn: ["done", "closed"] },
          assigneeBot: {
            is: {
              spaceId: input.spaceId,
              userId: input.userId,
              archivedAt: null,
            },
          },
        },
      },
    },
    select: { id: true, ticketId: true, ticket: { select: { assigneeBotId: true } } },
    take: 2,
  });
  if (matches.length === 0) return { status: "unknown" };
  if (matches.length > 1) return { status: "ambiguous" };
  const botId = matches[0]!.ticket.assigneeBotId;
  if (!botId) return { status: "unknown" };
  return {
    status: "matched",
    subscriptionId: matches[0]!.id,
    ticketId: matches[0]!.ticketId,
    botId,
    sourceThreadId: position.threadId,
  };
}

export async function listTicketSubscriptionRunEvents(
  prisma: TicketSubscriptionClient,
  input: { spaceId: string; userId: string; ticketId: string; runId: string },
): Promise<TicketSubscriptionRunEvent[]> {
  const rows = await prisma.ticketSubscriptionEvent.findMany({
    where: {
      runId: input.runId,
      message: { isNot: null },
      subscription: { is: { ticketId: input.ticketId, spaceId: input.spaceId } },
      run: {
        is: {
          id: input.runId,
          spaceId: input.spaceId,
          userId: input.userId,
          ticketId: input.ticketId,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      eventId: true,
      position: true,
      message: {
        select: { id: true, threadId: true, seq: true, role: true, blocks: true, createdAt: true },
      },
      subscription: { select: { threadId: true, externalConversationId: true } },
    },
  });
  return rows.flatMap<TicketSubscriptionRunEvent>((row) => {
    if (row.message && row.subscription.threadId && !row.subscription.externalConversationId) {
      return [
        {
          eventId: row.eventId,
          position: row.position,
          source: { type: "thread" as const, threadId: row.subscription.threadId },
          message: row.message,
        },
      ];
    }
    if (row.message && row.subscription.externalConversationId && !row.subscription.threadId) {
      return [
        {
          eventId: row.eventId,
          position: row.position,
          source: {
            type: "externalConversation" as const,
            externalConversationId: row.subscription.externalConversationId,
          },
          message: row.message,
        },
      ];
    }
    return [];
  });
}
