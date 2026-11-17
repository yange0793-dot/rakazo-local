import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { GROUP_TURN_RETRY_MS, groupTurnBlocked, retryGroupTurnLater } from "./group-turn.js";

function prismaWith(found: { id: string } | null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  return { prisma: { run: { findFirst } } as unknown as PrismaClient, findFirst };
}

describe("group turn waiting", () => {
  it("never gates the first speaker or a run outside a group send", async () => {
    const { prisma, findFirst } = prismaWith({ id: "earlier" });
    const run = { threadId: "thread-1", sourceMessageId: "message-1" };
    await expect(groupTurnBlocked(prisma, { ...run, groupTurn: 0 })).resolves.toBe(false);
    await expect(groupTurnBlocked(prisma, { ...run, groupTurn: null })).resolves.toBe(false);
    await expect(
      groupTurnBlocked(prisma, { threadId: "thread-1", sourceMessageId: null, groupTurn: 2 }),
    ).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("waits only for an earlier speaker in the same send that is still working", async () => {
    const { prisma, findFirst } = prismaWith({ id: "earlier" });
    await expect(
      groupTurnBlocked(prisma, {
        threadId: "thread-1",
        sourceMessageId: "message-1",
        groupTurn: 2,
      }),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        sourceMessageId: "message-1",
        trigger: "user",
        groupTurn: { lt: 2 },
        status: { in: ["queued", "leased", "running"] },
      },
      select: { id: true },
    });
  });

  it("starts once no earlier speaker is working", async () => {
    const { prisma } = prismaWith(null);
    await expect(
      groupTurnBlocked(prisma, {
        threadId: "thread-1",
        sourceMessageId: "message-1",
        groupTurn: 1,
      }),
    ).resolves.toBe(false);
  });
});

describe("group turn retry", () => {
  it("requeues the same run after a short wait", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const before = Date.now();
    await retryGroupTurnLater({ enqueue } as never, "run-1");
    const job = enqueue.mock.calls[0]![0] as {
      name: string;
      payload: { runId: string };
      availableAt: Date;
    };
    expect(job.name).toBe("run.continue");
    expect(job.payload).toEqual({ runId: "run-1" });
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before + GROUP_TURN_RETRY_MS - 50);
  });

  it("keeps the durable run when the retry cannot be queued", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("publisher closed"));
    await expect(retryGroupTurnLater({ enqueue } as never, "run-2")).resolves.toBeUndefined();
  });
});
