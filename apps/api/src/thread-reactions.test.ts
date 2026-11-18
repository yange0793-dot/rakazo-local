import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactToThreadMessage } from "./thread-reactions.js";
import type { ThreadTarget } from "./thread-target.js";

function harness(run: { id: string; status: string } | null) {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    user: { findMany: vi.fn(async () => []) },
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 9, spaceId: "space-1" } : { nextEventSeq: 4 },
      ),
    },
    message: {
      findFirst: vi.fn(async () => ({
        id: "parent",
        seq: 7,
        role: "bot",
        botId: "bot-1",
        runId: "run-done",
      })),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "reaction-1",
        ...data,
      })),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ seq: 4, ...data })),
    },
  };
  const runFindFirst = vi.fn(async () => run);
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    run: { findFirst: runFindFirst },
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const react = () =>
    reactToThreadMessage(
      { prisma, jobs: { enqueue } as never },
      { spaceId: "space-1", userId: "user-1" } as Actor,
      { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
      {
        messageId: "parent",
        reaction: "👎",
        clientNonce: "nonce-1",
        // No reply turn: this test is only about the review the reaction asks for.
        mayStartTurn: false,
      },
    );
  return { react, enqueue, runFindFirst, tx };
}

const saved = process.env.SELF_EVOLUTION;

beforeEach(() => {
  process.env.SELF_EVOLUTION = "1";
});

afterEach(() => {
  if (saved === undefined) delete process.env.SELF_EVOLUTION;
  else process.env.SELF_EVOLUTION = saved;
});

describe("thumb-down reflection", () => {
  it("asks for a review of the finished run behind the disliked message", async () => {
    const h = harness({ id: "run-done", status: "completed" });
    await h.react();
    expect(h.runFindFirst).toHaveBeenCalledWith({
      where: { id: "run-done", spaceId: "space-1" },
      select: { id: true, status: true },
    });
    expect(h.enqueue).toHaveBeenCalledWith({
      name: "harness.reflect",
      payload: { runId: "run-done", auto: true },
      replaceKey: "harness.reflect:run-done",
      maxAttempts: 2,
    });
  });

  it("leaves a run that is still working alone", async () => {
    const h = harness({ id: "run-done", status: "running" });
    await h.react();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("asks for nothing at all when self-evolution is off", async () => {
    process.env.SELF_EVOLUTION = "off";
    const h = harness({ id: "run-done", status: "completed" });
    await h.react();
    expect(h.runFindFirst).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
