import type { PrismaClient } from "@rakazo/db";
import { threadHasManagedWork } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { threadSnapshot } from "./thread-snapshot.js";
import type { ThreadTarget } from "./thread-target.js";

vi.mock("./thread-message-pages.js", () => ({
  loadMessagePage: vi.fn(async () => ({ messages: [], olderCursor: null })),
}));

const target: ThreadTarget = {
  kind: "group",
  groupId: "group-1",
  threadId: "thread-1",
  groupName: "Team",
  members: [],
  memberBotIds: [],
};

function setup() {
  const runFindMany = vi.fn(async (_args: unknown) => []);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    event: { findFirst: vi.fn(async () => null) },
    run: { findMany: runFindMany },
    thread: { findUnique: vi.fn(async () => ({ spaceId: "space-1" })) },
    ticket: { findMany: vi.fn(async () => []) },
    externalAgentExecution: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, runFindMany, tx };
}

function helperQuery(runFindMany: ReturnType<typeof setup>["runFindMany"]) {
  return runFindMany.mock.calls
    .map(([args]) => args as { where?: Record<string, unknown> })
    .find((args) => args?.where?.trigger === "helper");
}

describe("thread snapshot helper approvals", () => {
  it("shows only the helper cards the viewer started", async () => {
    const { prisma, runFindMany } = setup();

    await threadSnapshot({ prisma }, target, "user-1");

    expect(helperQuery(runFindMany)?.where).toMatchObject({ userId: "user-1" });
  });

  it("leaves the helper cards unfiltered when no viewer is known", async () => {
    const { prisma, runFindMany } = setup();

    await threadSnapshot({ prisma }, target);

    expect(helperQuery(runFindMany)?.where).not.toHaveProperty("userId");
  });

  it("keeps stop available for external work after the parent run completed without fabricating a run", async () => {
    const { prisma, tx } = setup();
    tx.ticket.findMany.mockResolvedValue([
      {
        id: "ticket-1",
        status: "done",
        requirementsVersion: 1,
        receiptVersion: 1,
        acceptedRequirementsVersion: 1,
        acceptedReceiptVersion: 1,
      },
    ] as never);
    tx.externalAgentExecution.findFirst.mockResolvedValue({ id: "execution-1" } as never);
    const snapshot = await threadSnapshot({ prisma }, target, "user-1");
    expect(snapshot.hasManagedWork).toBe(true);
    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
    expect(tx.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          createdByUserId: "user-1",
          originThreadId: "thread-1",
          managedVersion: { gt: 0 },
          stopRequestedAt: null,
        }),
      }),
    );
  });

  it("uses the current receipt versions and stops querying after all managed work settles", async () => {
    const { tx } = setup();
    const ticket = {
      id: "ticket-1",
      status: "done",
      requirementsVersion: 2,
      receiptVersion: 2,
      acceptedRequirementsVersion: 1,
      acceptedReceiptVersion: 1,
    };
    tx.ticket.findMany.mockResolvedValue([ticket] as never);
    const client = tx as unknown as Parameters<typeof threadHasManagedWork>[0];
    const input = { spaceId: "space-1", userId: "user-1", threadId: "thread-1" };
    expect(await threadHasManagedWork(client, input)).toBe(true);
    tx.ticket.findMany.mockResolvedValue([
      {
        ...ticket,
        acceptedRequirementsVersion: 2,
        acceptedReceiptVersion: 2,
      },
    ] as never);
    expect(await threadHasManagedWork(client, input)).toBe(false);
  });
});
