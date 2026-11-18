import type { PrismaClient } from "@rakazo/db";
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
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, runFindMany };
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
});
