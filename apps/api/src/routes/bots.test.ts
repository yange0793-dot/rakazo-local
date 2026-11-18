import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { botsRoutes } from "./bots.js";
import { createRouterContext } from "./context.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};

function setup(input: { lease: { id: string } | null }) {
  const computer = {
    id: "computer-1",
    spaceId: "space-1",
    userId: "user-1",
    scope: "dedicated",
    kind: "docker",
    state: "suspended",
    providerRef: "sandbox-1",
    controlHolder: "none",
    controlBotId: null,
    controlUserId: null,
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    maintenanceId: null,
  };
  const bot = {
    id: "bot-1",
    userId: "user-1",
    spaceId: "space-1",
    archivedAt: null,
    thread: { id: "thread-1" },
    computer,
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async () => bot),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: { findFirst: vi.fn(async () => null) },
    computerExecutionLease: {
      findFirst: vi.fn(async () => input.lease),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    computer: { update: vi.fn(async () => computer) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
      webOrigin: "https://web.example.test",
      screenProxySecret: "test-secret",
      agentRuntime: "scripted",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(botsRoutes(createRouterContext(deps)), {
    context: { actor },
  });
  return { client, prisma };
}

describe("bots.setComputer", () => {
  it("refuses to stop a dedicated computer while a helper tool holds a live lease", async () => {
    const { client, prisma } = setup({ lease: { id: "lease-1" } });

    await expect(client.bots.setComputer({ botId: "bot-1", mode: "team" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Stop the bot first",
    });

    expect(prisma.computerExecutionLease.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ computerId: "computer-1" }),
      }),
    );
    expect(prisma.computer.update).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).not.toHaveBeenCalled();
  });
});
