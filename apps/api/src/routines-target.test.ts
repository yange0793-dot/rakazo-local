import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routineTestTarget } from "./routines.js";
import type { RouterContext } from "./routes/context.js";

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

function routineRow(threadId: string | null) {
  return {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId,
    name: "Daily digest",
    prompt: "Summarize the inbox.",
  };
}

/**
 * `eligibleThreadId` is what the stored-thread lookup returns: the id when it is still a
 * thread this bot may run in, null when it is gone, archived, or no longer has the bot.
 */
function fixture(options: {
  routineThreadId: string | null;
  eligibleThreadId?: string | null;
  botThreadId?: string | null;
}) {
  const findRoutine = vi.fn().mockResolvedValue(routineRow(options.routineThreadId));
  const findThread = vi
    .fn()
    .mockResolvedValue(options.eligibleThreadId ? { id: options.eligibleThreadId } : null);
  const botThreadId = options.botThreadId === undefined ? "thread-dm" : options.botThreadId;
  const getBot = vi.fn().mockResolvedValue({
    id: "bot-1",
    thread: botThreadId ? { id: botThreadId } : null,
  });
  return {
    prisma: {
      routine: { findFirst: findRoutine },
      thread: { findFirst: findThread },
    } as unknown as PrismaClient,
    repos: { getBot } as unknown as RouterContext["repos"],
    findRoutine,
    findThread,
    getBot,
  };
}

describe("routineTestTarget", () => {
  it("keeps a bound group thread the bot still belongs to", async () => {
    const f = fixture({
      routineThreadId: "thread-group",
      eligibleThreadId: "thread-group",
    });

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).resolves.toMatchObject({
      botId: "bot-1",
      threadId: "thread-group",
    });
    expect(f.findRoutine).toHaveBeenCalledWith({
      where: { id: "routine-1", spaceId: "space-1" },
    });
    // Archived groups and a bot that left the group drop out here, exactly as wakeRoutine
    // reads the same stored thread before a scheduled run.
    expect(f.findThread).toHaveBeenCalledWith({
      where: {
        id: "thread-group",
        spaceId: "space-1",
        OR: [
          { botId: "bot-1" },
          {
            group: {
              archivedAt: null,
              members: { some: { botId: "bot-1" } },
            },
          },
        ],
      },
      select: { id: true },
    });
  });

  it("keeps a stored chat that is the bot's own", async () => {
    const f = fixture({ routineThreadId: "thread-dm", eligibleThreadId: "thread-dm" });

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).resolves.toMatchObject({
      threadId: "thread-dm",
    });
  });

  it("falls back to the bot chat when the routine has no stored thread", async () => {
    const f = fixture({ routineThreadId: null });

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).resolves.toMatchObject({
      threadId: "thread-dm",
    });
    expect(f.findThread).not.toHaveBeenCalled();
  });

  it("falls back when the stored thread is gone, archived, or no longer has the bot", async () => {
    const f = fixture({
      routineThreadId: "thread-group",
      eligibleThreadId: null,
    });

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).resolves.toMatchObject({
      threadId: "thread-dm",
    });
  });

  it("keeps the routine's Space authorization before looking up a thread", async () => {
    const findThread = vi.fn();
    const getBot = vi.fn();
    const prisma = {
      routine: { findFirst: vi.fn().mockResolvedValue(null) },
      thread: { findFirst: findThread },
    } as unknown as PrismaClient;
    const repos = { getBot } as unknown as RouterContext["repos"];

    await expect(
      routineTestTarget(prisma, repos, actor, "routine-other-space"),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(getBot).not.toHaveBeenCalled();
    expect(findThread).not.toHaveBeenCalled();
  });

  it("propagates the bot authorization failure", async () => {
    const f = fixture({ routineThreadId: "thread-group", eligibleThreadId: "thread-group" });
    f.getBot.mockRejectedValueOnce(new IsolationError());

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.findThread).not.toHaveBeenCalled();
  });

  it("still refuses a bot without a chat", async () => {
    const f = fixture({
      routineThreadId: "thread-group",
      eligibleThreadId: "thread-group",
      botThreadId: null,
    });

    await expect(routineTestTarget(f.prisma, f.repos, actor, "routine-1")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.findThread).not.toHaveBeenCalled();
  });
});
