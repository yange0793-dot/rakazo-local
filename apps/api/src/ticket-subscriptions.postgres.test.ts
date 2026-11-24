import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadMessage,
  ensureBoard,
  listTicketSubscriptionRunEvents,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routeTicketSourceEvent } from "../../../packages/adapters/src/ticket-subscriptions.js";
import {
  cancelTicketSubscription,
  createTicketSubscription,
} from "../../../packages/db/src/ticket-subscriptions.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

postgres("durable Ticket source subscriptions (PostgreSQL)", () => {
  const address = `ticket-subscriptions-${randomUUID()}@example.test`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let actor: Actor;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const enqueue = vi.fn(async () => undefined);
  const jobs: JobPublisher = {
    enqueue,
    cancel: async () => {},
    close: async () => {},
  };

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    identity = await runAsSystem("Ticket subscription fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "email", address }),
    );
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "subscription-fixture@example.test",
      isDeploymentOwner: false,
    };
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await prisma?.$disconnect();
    await db?.pool.end();
  });

  it("routes multiple source Threads to one durable Run and deduplicates replay", async () => {
    await runAsTenant(actor, async () => {
      const board = await ensureBoard(prisma, actor.spaceId);
      const ticket = await prisma.ticket.create({
        data: {
          boardId: board.id,
          spaceId: actor.spaceId,
          number: 1,
          title: "Follow two conversations",
          assigneeBotId: identity.botId,
          createdByUserId: actor.userId,
        },
      });
      const secondBot = await prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Second source bot",
          color: "blue",
        },
      });
      const secondThread = await prisma.thread.create({
        data: { spaceId: actor.spaceId, userId: actor.userId, botId: secondBot.id },
      });

      await createTicketSubscription(prisma, actor, {
        ticketId: ticket.id,
        source: { type: "thread", threadId: identity.threadId },
      });
      await createTicketSubscription(prisma, actor, {
        ticketId: ticket.id,
        source: { type: "thread", threadId: secondThread.id },
      });
      const [firstMessage, secondMessage] = await Promise.all([
        createThreadMessage(prisma, {
          threadId: identity.threadId,
          role: "user",
          authorUserId: actor.userId,
          blocks: [{ kind: "text", text: "First source update" }],
        }),
        createThreadMessage(prisma, {
          threadId: secondThread.id,
          role: "user",
          authorUserId: actor.userId,
          blocks: [{ kind: "text", text: "Second source update" }],
        }),
      ]);
      const deps = { prisma, jobs, ticketBoardEnabled: true };
      const first = await routeTicketSourceEvent(deps, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        event: {
          source: { type: "thread", threadId: identity.threadId },
          eventId: firstMessage.id,
          messageId: firstMessage.id,
          position: firstMessage.seq,
        },
      });
      const second = await routeTicketSourceEvent(deps, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: secondBot.id,
        event: {
          source: { type: "thread", threadId: secondThread.id },
          eventId: secondMessage.id,
          messageId: secondMessage.id,
          position: secondMessage.seq,
        },
      });
      const replay = await routeTicketSourceEvent(deps, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        event: {
          source: { type: "thread", threadId: identity.threadId },
          eventId: firstMessage.id,
          messageId: firstMessage.id,
          position: firstMessage.seq,
        },
      });

      expect(first.status).toBe("routed");
      expect(second).toMatchObject({
        status: "routed",
        ticketId: ticket.id,
        runId: first.status === "routed" ? first.runId : undefined,
        duplicate: false,
      });
      expect(replay).toMatchObject({
        status: "routed",
        ticketId: ticket.id,
        runId: first.status === "routed" ? first.runId : undefined,
        duplicate: true,
      });
      if (first.status !== "routed" || !first.runId) throw new Error("Expected a durable Run");
      expect(await prisma.run.count({ where: { ticketId: ticket.id } })).toBe(1);
      const sourceEvents = await listTicketSubscriptionRunEvents(prisma, {
        spaceId: actor.spaceId,
        userId: actor.userId,
        ticketId: ticket.id,
        runId: first.runId,
      });
      expect(sourceEvents.map((event) => event.message.id)).toEqual(
        expect.arrayContaining([firstMessage.id, secondMessage.id]),
      );
      expect(sourceEvents).toHaveLength(2);
      expect(
        await (
          prisma as unknown as {
            ticketSubscriptionEvent: { count(args: unknown): Promise<number> };
          }
        ).ticketSubscriptionEvent.count({
          where: { runId: first.status === "routed" ? first.runId : "" },
        }),
      ).toBe(2);
      expect(enqueue).toHaveBeenCalledTimes(3);

      const subscriptions = await (
        prisma as unknown as {
          ticketSubscription: {
            findMany(args: unknown): Promise<Array<{ id: string; lastProcessedPosition: number }>>;
          };
        }
      ).ticketSubscription.findMany({
        where: { ticketId: ticket.id },
        select: { id: true, lastProcessedPosition: true },
      });
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.every((subscription) => subscription.lastProcessedPosition === 0)).toBe(
        true,
      );

      const cancelled = await cancelTicketSubscription(prisma, actor, {
        subscriptionId: subscriptions[0]!.id,
      });
      expect(cancelled).toBe(true);
      const repeatedCancel = await cancelTicketSubscription(prisma, actor, {
        subscriptionId: subscriptions[0]!.id,
      });
      expect(repeatedCancel).toBe(false);
    });
  });

  it("does not choose between multiple live Ticket matches for the same source", async () => {
    await runAsTenant(actor, async () => {
      const board = await ensureBoard(prisma, actor.spaceId);
      const firstTicket = await prisma.ticket.create({
        data: {
          boardId: board.id,
          spaceId: actor.spaceId,
          number: 2,
          title: "First candidate",
          assigneeBotId: identity.botId,
          createdByUserId: actor.userId,
        },
      });
      const secondTicket = await prisma.ticket.create({
        data: {
          boardId: board.id,
          spaceId: actor.spaceId,
          number: 3,
          title: "Second candidate",
          assigneeBotId: identity.botId,
          createdByUserId: actor.userId,
        },
      });
      await Promise.all(
        [firstTicket, secondTicket].map((ticket) =>
          createTicketSubscription(prisma, actor, {
            ticketId: ticket.id,
            source: { type: "thread", threadId: identity.threadId },
          }),
        ),
      );
      const message = await createThreadMessage(prisma, {
        threadId: identity.threadId,
        role: "user",
        authorUserId: actor.userId,
        blocks: [{ kind: "text", text: "Ambiguous update" }],
      });

      await expect(
        routeTicketSourceEvent(
          { prisma, jobs, ticketBoardEnabled: true },
          {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: identity.botId,
            event: {
              source: { type: "thread", threadId: identity.threadId },
              eventId: message.id,
              messageId: message.id,
              position: message.seq,
            },
          },
        ),
      ).resolves.toEqual({ status: "ambiguous" });
      expect(
        await prisma.run.count({ where: { ticketId: { in: [firstTicket.id, secondTicket.id] } } }),
      ).toBe(0);
    });
  });
});
