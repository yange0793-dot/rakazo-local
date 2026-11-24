import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { claimSteering } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routeTicketSourceEvent } from "./ticket-subscriptions.js";

function fixture(
  options: {
    matches?: Array<{
      id: string;
      ticketId: string;
      ticket: { assigneeBotId: string | null };
    }>;
    previousRunId?: string | null;
    activeRunId?: string;
    status?: string;
    sourceMessage?: {
      id: string;
      externalTranscriptFor?: { externalConversationId: string; providerEventId: string } | null;
    } | null;
    externalEvent?: { externalConversationId: string; providerEventId: string };
    lockSubscription?: boolean;
  } = {},
) {
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
        nextMessageSeq: 3,
        botId: "bot-1",
        externalConversation: null,
        group: null,
      }),
    ),
  };
  const externalConversation = {
    findFirst: vi.fn(async () => ({
      botId: "bot-1",
      thread: { id: "external-thread-1", nextMessageSeq: 3 },
    })),
  };
  const ticket = {
    findFirst: vi.fn(async () => ({
      id: "ticket-1",
      spaceId: "space-1",
      assigneeBotId: "bot-1",
      status: "todo",
      number: 7,
      originKey: null,
      board: { ticketPrefix: "RAK" },
    })),
  };
  const taskCreate = vi.fn(async () => ({ id: "task-1" }));
  const runFindFirst = vi.fn(async () =>
    options.activeRunId ? { id: options.activeRunId } : null,
  );
  const runCreate = vi.fn(async () => ({ id: "run-new" }));
  const eventFindUnique = vi.fn(async () =>
    options.previousRunId !== undefined ? { runId: options.previousRunId } : null,
  );
  const eventCreate = vi.fn(async () => ({}));
  const tx = {
    thread,
    externalConversation,
    message: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.sourceMessage === null
          ? null
          : (options.sourceMessage ?? {
              id: where.id,
              externalTranscriptFor: options.externalEvent ?? null,
            }),
      ),
    },
    ticket,
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        userId: "user-1",
        thread: { id: "bot-thread" },
      })),
    },
    run: { findFirst: runFindFirst, create: runCreate },
    task: { create: taskCreate },
    steeringMessage: { upsert: vi.fn(async (_input: unknown) => ({})) },
    ticketSubscription: {
      findMany: vi.fn(
        async () =>
          options.matches ?? [
            {
              id: "subscription-1",
              ticketId: "ticket-1",
              ticket: { assigneeBotId: "bot-1" },
            },
          ],
      ),
    },
    ticketSubscriptionEvent: {
      findUnique: eventFindUnique,
      create: eventCreate,
    },
    $queryRaw: vi.fn(async () =>
      options.lockSubscription === false ? [] : [{ id: "subscription-1" }],
    ),
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    run: { findFirst: vi.fn(async () => ({ status: options.status ?? "queued" })) },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  const enqueue = vi.fn(async () => {});
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue, cancel: vi.fn(), close: vi.fn() } as unknown as JobPublisher,
    ticketBoardEnabled: true,
  };
  return {
    deps,
    tx,
    enqueue,
    taskCreate,
    runFindFirst,
    runCreate,
    eventFindUnique,
    eventCreate,
  };
}

const input = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  event: {
    source: { type: "thread" as const, threadId: "thread-1" },
    eventId: "message-1",
    messageId: "message-1",
    position: 3,
  },
};

describe("Ticket source event routing", () => {
  it("routes an exact source event and atomically prepares a durable Ticket Run", async () => {
    const f = fixture();
    await expect(routeTicketSourceEvent(f.deps, input)).resolves.toEqual({
      status: "routed",
      ticketId: "ticket-1",
      runId: "run-new",
      duplicate: false,
    });

    expect(f.tx.message.findFirst).toHaveBeenCalledWith({
      where: { id: "message-1", threadId: "thread-1", seq: 3, role: "user" },
      select: {
        id: true,
        externalTranscriptFor: {
          select: { externalConversationId: true, providerEventId: true },
        },
      },
    });
    expect(f.eventCreate).toHaveBeenCalledWith({
      data: {
        subscriptionId: "subscription-1",
        eventId: "message-1",
        messageId: "message-1",
        position: 3,
        runId: "run-new",
      },
    });
    expect(f.tx.$executeRaw).toHaveBeenCalledOnce();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("run-new"));
    expect(f.taskCreate).toHaveBeenCalledOnce();
    expect(f.runCreate).toHaveBeenCalledOnce();
    expect(f.tx.steeringMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          messageId: "message-1",
          botId: "bot-1",
          userId: "user-1",
          runId: "run-new",
          originTrigger: "ticket_subscription",
        },
      }),
    );
  });

  it("continues the active Run instead of creating a parallel Run", async () => {
    const f = fixture({ activeRunId: "run-active" });
    await expect(
      routeTicketSourceEvent(f.deps, {
        ...input,
        event: { ...input.event, eventId: "message-2", messageId: "message-2", position: 4 },
      }),
    ).resolves.toEqual({
      status: "routed",
      ticketId: "ticket-1",
      runId: "run-active",
      duplicate: false,
    });

    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("run-active"));
  });

  it("treats replays as the existing route and never creates another run", async () => {
    const f = fixture({ previousRunId: "run-original" });
    await expect(routeTicketSourceEvent(f.deps, input)).resolves.toEqual({
      status: "routed",
      ticketId: "ticket-1",
      runId: "run-original",
      duplicate: true,
    });

    expect(f.eventCreate).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.runCreate).not.toHaveBeenCalled();
    expect(f.tx.steeringMessage.upsert).not.toHaveBeenCalled();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("run-original"));
  });

  it("returns ambiguity without selecting a Ticket or starting work", async () => {
    const f = fixture({
      matches: [
        {
          id: "subscription-a",
          ticketId: "ticket-a",
          ticket: { assigneeBotId: "bot-1" },
        },
        {
          id: "subscription-b",
          ticketId: "ticket-b",
          ticket: { assigneeBotId: "bot-2" },
        },
      ],
    });
    await expect(routeTicketSourceEvent(f.deps, input)).resolves.toEqual({
      status: "ambiguous",
    });
    expect(f.eventFindUnique).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("does not route inaccessible, mismatched, or cancelled source events", async () => {
    const inaccessible = fixture();
    inaccessible.tx.thread.findFirst.mockResolvedValue(null);
    await expect(routeTicketSourceEvent(inaccessible.deps, input)).resolves.toEqual({
      status: "unknown",
    });
    expect(inaccessible.tx.ticketSubscription.findMany).not.toHaveBeenCalled();

    const mismatchedMessage = fixture({ sourceMessage: null });
    await expect(routeTicketSourceEvent(mismatchedMessage.deps, input)).resolves.toEqual({
      status: "unknown",
    });
    expect(mismatchedMessage.eventFindUnique).not.toHaveBeenCalled();
    expect(mismatchedMessage.taskCreate).not.toHaveBeenCalled();

    const cancelled = fixture({ lockSubscription: false });
    await expect(routeTicketSourceEvent(cancelled.deps, input)).resolves.toEqual({
      status: "unknown",
    });
    expect(cancelled.eventFindUnique).not.toHaveBeenCalled();
    expect(cancelled.taskCreate).not.toHaveBeenCalled();
  });

  it("routes external-conversation events through their owned transcript Thread", async () => {
    const f = fixture({
      externalEvent: {
        externalConversationId: "conversation-1",
        providerEventId: "provider-event-1",
      },
    });
    await expect(
      routeTicketSourceEvent(f.deps, {
        ...input,
        event: {
          source: { type: "externalConversation", externalConversationId: "conversation-1" },
          eventId: "provider-event-1",
          messageId: "message-1",
          position: 3,
        },
      }),
    ).resolves.toMatchObject({ status: "routed", ticketId: "ticket-1" });
    expect(f.tx.externalConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "conversation-1",
          spaceId: "space-1",
          userId: "user-1",
        }),
        select: { botId: true, thread: { select: { id: true, nextMessageSeq: true } } },
      }),
    );
    expect(f.tx.message.findFirst).toHaveBeenCalledWith({
      where: {
        id: "message-1",
        threadId: "external-thread-1",
        seq: 3,
        role: "user",
      },
      select: {
        id: true,
        externalTranscriptFor: {
          select: { externalConversationId: true, providerEventId: true },
        },
      },
    });
  });

  it("rejects a changed event key for an already persisted Thread message", async () => {
    const f = fixture();
    await expect(
      routeTicketSourceEvent(f.deps, {
        ...input,
        event: { ...input.event, eventId: "another-key" },
      }),
    ).resolves.toEqual({ status: "unknown" });
    expect(f.eventFindUnique).not.toHaveBeenCalled();
    expect(f.taskCreate).not.toHaveBeenCalled();
  });

  it("does not wake Runs when the Ticket board is disabled", async () => {
    const f = fixture();
    f.deps.ticketBoardEnabled = false;
    await expect(routeTicketSourceEvent(f.deps, input)).resolves.toEqual({ status: "unknown" });
    expect(f.deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(["waiting_input", "running", "completed"])(
    "records an event without blindly waking a %s run",
    async (status) => {
      const f = fixture({ activeRunId: "run-active", status });
      expect(await routeTicketSourceEvent(f.deps, input)).toMatchObject({
        status: "routed",
        runId: "run-active",
      });
      expect(f.tx.steeringMessage.upsert).toHaveBeenCalledOnce();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(["thread", "externalConversation"] as const)(
    "delivers the actual %s source to the real fenced steering consumer",
    async (source) => {
      const f = fixture({
        externalEvent:
          source === "externalConversation"
            ? { externalConversationId: "conversation-1", providerEventId: "provider-event-1" }
            : undefined,
      });
      const event =
        source === "externalConversation"
          ? {
              source: {
                type: "externalConversation" as const,
                externalConversationId: "conversation-1",
              },
              eventId: "provider-event-1",
              messageId: "message-1",
              position: 3,
            }
          : input.event;
      await routeTicketSourceEvent(f.deps, { ...input, event });
      const written = vi.mocked(f.tx.steeringMessage.upsert).mock.calls[0]![0] as unknown as {
        create: {
          messageId: string;
          botId: string;
          userId: string;
          runId: string;
          originTrigger: string;
        };
      };
      const blocks = [
        { kind: "text", text: "Actual source observation, not a generic ticket prompt." },
      ];
      const consumer = {
        $queryRaw: vi.fn(async () => []),
        run: {
          findFirst: vi.fn(async () => ({
            id: "run-new",
            spaceId: "space-1",
            userId: "user-1",
            ticketId: "ticket-1",
            trigger: "tickets",
          })),
          findUnique: vi.fn(async () => ({ status: "running", startedAt: null })),
        },
        thread: {
          findUniqueOrThrow: vi.fn(async () => ({ nextMessageSeq: 4 })),
          update: vi.fn(async () => ({ nextEventSeq: 1 })),
        },
        steeringMessage: {
          findMany: vi.fn(
            async ({ where }: { where: { message: { OR: Array<Record<string, unknown>> } } }) => {
              expect(where.message.OR[1]).toMatchObject({
                thread: { spaceId: "space-1", userId: "user-1" },
                ticketSubscriptionEvents: {
                  some: { runId: "run-new", subscription: { ticketId: "ticket-1" } },
                },
              });
              return [
                {
                  id: "steering-1",
                  ...written.create,
                  message: {
                    blocks,
                    seq: 3,
                    threadId: "source-thread",
                    authorUserId: source === "thread" ? "user-1" : null,
                  },
                },
              ];
            },
          ),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        event: { create: vi.fn(async () => ({ id: "claim-event" })) },
      };
      const prisma = {
        $transaction: vi.fn(async (fn: (tx: typeof consumer) => unknown) => fn(consumer)),
      } as unknown as PrismaClient;
      expect(
        await claimSteering(prisma, {
          threadId: "bot-thread",
          botId: "bot-1",
          runId: "run-new",
          leaseOwner: "worker",
          leaseFence: 1,
          seenIds: [],
        }),
      ).toEqual([
        expect.objectContaining({
          messageId: "message-1",
          blocks,
          text: expect.stringContaining("Actual source observation"),
          origin: source === "thread" ? "user" : "messaging",
        }),
      ]);
    },
  );
});
