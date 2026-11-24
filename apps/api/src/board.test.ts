import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("disabled ticket board", () => {
  it.each([undefined, false])(
    "refuses every route and stream before accessing the database (%s)",
    async (enabled) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const follow = vi.fn();
      const prisma = new Proxy({}, { get: () => query });
      const client = createRouterClient(
        createRouter({
          prisma,
          env: { ticketBoardEnabled: enabled },
          boardEvents: { follow },
        } as unknown as RouterDeps),
        { context: { actor } },
      );
      const calls = [
        () => client.boards.list(),
        () => client.boards.get(),
        () => client.boards.rename({ name: "Launch" }),
        () => client.boards.subscribe(),
        () => client.tickets.list({}),
        () => client.tickets.get({ id: "ticket-1" }),
        () => client.tickets.create({ title: "Launch", assigneeBotId: "bot-1" }),
        () => client.tickets.update({ id: "ticket-1", assigneeBotId: "bot-1" }),
        () => client.tickets.move({ id: "ticket-1", status: "doing" }),
        () => client.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
        () => client.tickets.comments({ ticketId: "ticket-1" }),
        () =>
          client.tickets.subscribe({
            id: "ticket-1",
            source: { type: "thread", threadId: "thread-1" },
          }),
        () => client.tickets.unsubscribe({ subscriptionId: "subscription-1" }),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(query).not.toHaveBeenCalled();
      expect(follow).not.toHaveBeenCalled();
    },
  );
});

describe("ticket source subscription routes", () => {
  function setup() {
    const tx = {
      $queryRaw: vi.fn(async () => [{ nextMessageSeq: 7 }]),
      spaceMember: { findUnique: vi.fn(async () => ({ userId: actor.userId })) },
      space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
      ticket: {
        findFirst: vi.fn(async () => ({
          id: "ticket-1",
          spaceId: actor.spaceId,
          assigneeBotId: "bot-1",
          createdByUserId: actor.userId,
        })),
      },
      thread: { findFirst: vi.fn(async () => ({ id: "thread-1", nextMessageSeq: 7 })) },
      ticketSubscription: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "subscription-1",
          ...data,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const client = createRouterClient(
      createRouter({ prisma, env: { ticketBoardEnabled: true } } as unknown as RouterDeps),
      { context: { actor } },
    );
    return { client, tx };
  }

  it("creates a subscription using the authenticated actor and cancels by durable id", async () => {
    const f = setup();
    await expect(
      f.client.tickets.subscribe({
        id: "ticket-1",
        source: { type: "thread", threadId: "thread-1" },
      }),
    ).resolves.toEqual({ subscriptionId: "subscription-1" });
    expect(f.tx.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ticket-1", spaceId: actor.spaceId }),
      }),
    );
    await expect(
      f.client.tickets.unsubscribe({ subscriptionId: "subscription-1" }),
    ).resolves.toEqual({ cancelled: true });
    expect(f.tx.ticketSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "subscription-1",
          spaceId: actor.spaceId,
          active: true,
        }),
        data: { active: false },
      }),
    );
  });

  it("does not create a subscription for an unavailable ticket", async () => {
    const f = setup();
    f.tx.ticket.findFirst.mockResolvedValue(null as never);
    await expect(
      f.client.tickets.subscribe({
        id: "ticket-1",
        source: { type: "thread", threadId: "thread-1" },
      }),
    ).rejects.toThrow();
    expect(f.tx.ticketSubscription.create).not.toHaveBeenCalled();
  });
});

it("answers a signed-out caller with not found while the board is off", async () => {
  const client = createRouterClient(
    createRouter({ prisma: {}, env: { ticketBoardEnabled: false } } as unknown as RouterDeps),
    { context: { actor: null } },
  );
  await expect(client.boards.get()).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("rejects an out-of-range ticket reference before querying tickets", async () => {
  const findFirst = vi.fn(async () => null);
  const prisma = {
    board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
    ticket: { findFirst },
  };
  const client = createRouterClient(
    createRouter({ prisma, env: { ticketBoardEnabled: true } } as unknown as RouterDeps),
    { context: { actor } },
  );

  await expect(client.tickets.get({ ref: `RAK-${"9".repeat(115)}` })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Invalid ticket reference.",
  });
  expect(findFirst).not.toHaveBeenCalled();
});

it("refuses a signed-out caller before querying the board", async () => {
  const findUnique = vi.fn();
  const client = createRouterClient(
    createRouter({
      prisma: { board: { findUnique } },
      env: { ticketBoardEnabled: true },
    } as unknown as RouterDeps),
    { context: { actor: null } },
  );
  await expect(client.boards.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(findUnique).not.toHaveBeenCalled();
});

it.each([false, true])("includes the board capability in me (%s)", async (ticketBoardEnabled) => {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "user@rakazo.test",
        name: "Test",
        avatarStyle: "robot",
        secrets: [],
      })),
    },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
  };
  const deps = {
    prisma,
    env: {
      ticketBoardEnabled,
      phoneCallsEnabled: ticketBoardEnabled,
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  await expect(client.me()).resolves.toHaveProperty("ticketBoardEnabled", ticketBoardEnabled);
  await expect(client.me()).resolves.toHaveProperty("phoneCallsEnabled", ticketBoardEnabled);
});
