import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  cancelTicketSubscription,
  createTicketSubscription,
  listTicketSubscriptionRunEvents,
  resolveTicketSubscription,
} from "./ticket-subscriptions.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function sourceDb(overrides: Record<string, unknown> = {}) {
  const thread = {
    findFirst: vi.fn(
      async (): Promise<{
        id: string;
        nextMessageSeq: number;
        botId: string;
        externalConversation: null;
        group: null;
      } | null> => ({
        id: "thread-1",
        nextMessageSeq: 8,
        botId: "bot-1",
        externalConversation: null,
        group: null,
      }),
    ),
  };
  const externalConversation = {
    findFirst: vi.fn(
      async (): Promise<{
        botId: string;
        thread: { id: string; nextMessageSeq: number };
      } | null> => ({
        botId: "bot-1",
        thread: { id: "external-thread", nextMessageSeq: 12 },
      }),
    ),
  };
  const ticket = {
    findFirst: vi.fn(
      async (): Promise<{ id: string; spaceId: string; assigneeBotId: string } | null> => ({
        id: "ticket-1",
        spaceId: "space-1",
        assigneeBotId: "bot-1",
      }),
    ),
  };
  const ticketSubscription = {
    findFirst: vi.fn(
      async (): Promise<{ id: string; active: boolean; lastProcessedPosition: number } | null> =>
        null,
    ),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "subscription-1",
      ...data,
    })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "subscription-1",
      ...data,
    })),
    findMany: vi.fn(async () => [
      { id: "subscription-1", ticketId: "ticket-1", ticket: { assigneeBotId: "bot-1" } },
    ]),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const ticketSubscriptionEvent = {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  };
  const tx = {
    ...thread,
    thread,
    externalConversation,
    ticket,
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
    ticketSubscription,
    ticketSubscriptionEvent,
    $queryRaw: vi.fn(async () => [{ nextMessageSeq: 8 }]),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    ...overrides,
  };
  return {
    prisma,
    tx,
    thread,
    externalConversation,
    ticket,
    ticketSubscription,
    ticketSubscriptionEvent,
  };
}

describe("Ticket subscriptions", () => {
  it("authorizes a Ticket and source, locks the Thread, and starts at its current position", async () => {
    const f = sourceDb();
    await createTicketSubscription(f.prisma as never, actor, {
      ticketId: "ticket-1",
      source: { type: "thread", threadId: "thread-1" },
    });

    expect(f.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ticket-1",
          spaceId: "space-1",
          assigneeBot: { is: { spaceId: "space-1", userId: "user-1", archivedAt: null } },
        }),
      }),
    );
    expect(f.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "thread-1",
          spaceId: "space-1",
          userId: "user-1",
        }),
      }),
    );
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.ticketSubscription.create).toHaveBeenCalledWith({
      data: {
        ticketId: "ticket-1",
        spaceId: "space-1",
        threadId: "thread-1",
        externalConversationId: null,
        active: true,
        lastProcessedPosition: 8,
      },
    });
  });

  it("accepts only an owned existing external conversation with a linked Thread", async () => {
    const f = sourceDb();
    await createTicketSubscription(f.prisma as never, actor, {
      ticketId: "ticket-1",
      source: { type: "externalConversation", externalConversationId: "conversation-1" },
    });

    expect(f.externalConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "conversation-1",
          spaceId: "space-1",
          userId: "user-1",
          thread: { is: { spaceId: "space-1", userId: "user-1" } },
        }),
      }),
    );
    expect(f.ticketSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: null,
        externalConversationId: "conversation-1",
        lastProcessedPosition: 8,
      }),
    });
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it("rejects a ticket or source outside the actor's ownership", async () => {
    const noTicket = sourceDb();
    noTicket.ticket.findFirst.mockResolvedValue(null);
    await expect(
      createTicketSubscription(noTicket.prisma as never, actor, {
        ticketId: "other-ticket",
        source: { type: "thread", threadId: "thread-1" },
      }),
    ).rejects.toThrow("Resource not found");
    expect(noTicket.thread.findFirst).not.toHaveBeenCalled();

    const noSource = sourceDb();
    noSource.thread.findFirst.mockResolvedValue(null);
    await expect(
      createTicketSubscription(noSource.prisma as never, actor, {
        ticketId: "ticket-1",
        source: { type: "thread", threadId: "other-thread" },
      }),
    ).rejects.toThrow("Resource not found");
    expect(noSource.ticketSubscription.create).not.toHaveBeenCalled();
  });

  it("returns unknown for an inaccessible source and ambiguity for multiple live matches", async () => {
    const inaccessible = sourceDb();
    inaccessible.thread.findFirst.mockResolvedValue(null);
    await expect(
      resolveTicketSubscription(inaccessible.prisma as never, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        source: { type: "thread", threadId: "other-thread" },
      }),
    ).resolves.toEqual({ status: "unknown" });
    expect(inaccessible.ticketSubscription.findMany).not.toHaveBeenCalled();

    const ambiguous = sourceDb();
    ambiguous.ticketSubscription.findMany.mockResolvedValue([
      { id: "sub-a", ticketId: "ticket-a", ticket: { assigneeBotId: "bot-1" } },
      { id: "sub-b", ticketId: "ticket-b", ticket: { assigneeBotId: "bot-2" } },
    ]);
    await expect(
      resolveTicketSubscription(ambiguous.prisma as never, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        source: { type: "thread", threadId: "thread-1" },
      }),
    ).resolves.toEqual({ status: "ambiguous" });
    expect(ambiguous.ticketSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          spaceId: "space-1",
          threadId: "thread-1",
          ticket: expect.objectContaining({
            is: expect.objectContaining({
              assigneeBot: {
                is: { spaceId: "space-1", userId: "user-1", archivedAt: null },
              },
            }),
          }),
        }),
        take: 2,
      }),
    );
  });

  it("routes to the Ticket's owned assignee even when the source belongs to another owned bot", async () => {
    const f = sourceDb();
    f.ticketSubscription.findMany.mockResolvedValue([
      { id: "subscription-1", ticketId: "ticket-1", ticket: { assigneeBotId: "bot-2" } },
    ]);
    await expect(
      resolveTicketSubscription(f.prisma as never, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "bot-1",
        source: { type: "thread", threadId: "thread-1" },
      }),
    ).resolves.toEqual({
      status: "matched",
      subscriptionId: "subscription-1",
      ticketId: "ticket-1",
      botId: "bot-2",
      sourceThreadId: "thread-1",
    });
  });

  it("reads only source events attached to this Ticket Run and tenant", async () => {
    const f = sourceDb();
    const createdAt = new Date("2026-11-23T10:00:00.000Z");
    f.ticketSubscriptionEvent.findMany.mockResolvedValue([
      {
        eventId: "message-1",
        position: 5,
        message: {
          id: "message-1",
          threadId: "thread-1",
          seq: 5,
          role: "user",
          blocks: [{ kind: "text", text: "Update" }],
          createdAt,
        },
        subscription: { threadId: "thread-1", externalConversationId: null },
      },
      {
        eventId: "external-event-1",
        position: 6,
        message: {
          id: "message-2",
          threadId: "external-thread-1",
          seq: 6,
          role: "user",
          blocks: [{ kind: "text", text: "External update" }],
          createdAt,
        },
        subscription: { threadId: null, externalConversationId: "conversation-1" },
      },
      {
        eventId: "invalid-source",
        position: 7,
        message: {
          id: "message-3",
          threadId: "thread-1",
          seq: 7,
          role: "user",
          blocks: [],
          createdAt,
        },
        subscription: { threadId: "thread-1", externalConversationId: "conversation-1" },
      },
    ]);

    await expect(
      listTicketSubscriptionRunEvents(f.prisma as never, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        ticketId: "ticket-1",
        runId: "run-1",
      }),
    ).resolves.toEqual([
      {
        eventId: "message-1",
        position: 5,
        source: { type: "thread", threadId: "thread-1" },
        message: expect.objectContaining({ id: "message-1", seq: 5 }),
      },
      {
        eventId: "external-event-1",
        position: 6,
        source: {
          type: "externalConversation",
          externalConversationId: "conversation-1",
        },
        message: expect.objectContaining({ id: "message-2", seq: 6 }),
      },
    ]);
    expect(f.ticketSubscriptionEvent.findMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        message: { isNot: null },
        subscription: { is: { ticketId: "ticket-1", spaceId: "space-1" } },
        run: {
          is: {
            id: "run-1",
            spaceId: "space-1",
            userId: "user-1",
            ticketId: "ticket-1",
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        eventId: true,
        position: true,
        message: {
          select: {
            id: true,
            threadId: true,
            seq: true,
            role: true,
            blocks: true,
            createdAt: true,
          },
        },
        subscription: { select: { threadId: true, externalConversationId: true } },
      },
    });
  });

  it("cancels only an active subscription owned by the actor's assigned bot", async () => {
    const f = sourceDb();
    await expect(
      cancelTicketSubscription(f.prisma as never, actor, { subscriptionId: "subscription-1" }),
    ).resolves.toBe(true);
    expect(f.ticketSubscription.updateMany).toHaveBeenCalledWith({
      where: {
        id: "subscription-1",
        spaceId: "space-1",
        active: true,
        space: { deletingAt: null, memberships: { some: { userId: actor.userId } } },
        ticket: {
          is: {
            createdByUserId: actor.userId,
            assigneeBot: { is: { spaceId: "space-1", userId: "user-1", archivedAt: null } },
          },
        },
      },
      data: { active: false },
    });

    f.ticketSubscription.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      cancelTicketSubscription(f.prisma as never, actor, { subscriptionId: "other" }),
    ).resolves.toBe(false);
  });

  it("returns an active duplicate and reactivates a cancelled source from the new position", async () => {
    const f = sourceDb();
    const input = {
      ticketId: "ticket-1",
      source: { type: "thread" as const, threadId: "thread-1" },
    };
    f.ticketSubscription.findFirst.mockResolvedValue({
      id: "subscription-1",
      active: true,
      lastProcessedPosition: 3,
    });
    expect(await createTicketSubscription(f.prisma as never, actor, input)).toMatchObject({
      id: "subscription-1",
      active: true,
      lastProcessedPosition: 3,
    });
    expect(f.ticketSubscription.create).not.toHaveBeenCalled();
    f.ticketSubscription.findFirst.mockResolvedValue({
      id: "subscription-1",
      active: false,
      lastProcessedPosition: 3,
    });
    await createTicketSubscription(f.prisma as never, actor, input);
    expect(f.ticketSubscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: { active: true, lastProcessedPosition: 8 },
    });
    expect(f.ticketSubscription.create).not.toHaveBeenCalled();
  });
});
