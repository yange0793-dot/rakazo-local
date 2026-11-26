import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { ThreadArchiveCoverageError, ThreadClearConflictError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { ThreadTarget } from "../thread-target.js";
import { createRouterContext } from "./context.js";
import { threadsRoutes } from "./threads.js";

const archive = vi.hoisted(() => ({
  prepareClear: vi.fn(),
  observeClear: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    MemoryArchiveStore: class {
      prepareClear(...args: unknown[]) {
        return archive.prepareClear(...args);
      }
      observeClear(...args: unknown[]) {
        return archive.observeClear(...args);
      }
    },
  };
});

const resolved = vi.hoisted(() => ({ target: null as unknown }));

vi.mock("../thread-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-target.js")>()),
  resolveThreadTarget: vi.fn(async () => resolved.target),
}));

const stop = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../thread-stop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-stop.js")>()),
  stopThreadRuns: stop,
}));

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};

const directTarget = {
  kind: "bot",
  botId: "bot-1",
  threadId: "thread-1",
  bot: { userId: "user-1", thread: { userId: "user-1" } },
} as unknown as ThreadTarget;

const groupTarget = {
  kind: "group",
  groupId: "group-1",
  threadId: "thread-1",
  groupName: "Team",
  members: [],
  memberBotIds: ["bot-1"],
} as unknown as ThreadTarget;

function setup(
  options: {
    archive?: boolean;
    target?: ThreadTarget;
    archiveError?: Error;
    clearError?: Error;
  } = {},
) {
  resolved.target = options.target ?? directTarget;
  archive.prepareClear.mockResolvedValue({ generation: 4, nextMessageSeq: 9 });
  archive.observeClear.mockResolvedValue({ generation: 4, nextMessageSeq: 9 });
  const clearThread = vi.fn(async (_input: Record<string, unknown>) => {
    if (options.clearError) throw options.clearError;
    return { cancelledRunIds: [], historyCompactionGeneration: 3 };
  });
  const archiveConversationMemory = vi.fn(async () => {
    if (options.archiveError) throw options.archiveError;
  });
  const resolve = vi.fn(async () => null);
  const purgeHistory = vi.fn(async () => { throw new Error("unexpected managed purge"); });
  const deps = {
    prisma: {},
    events: { clearThread },
    memoryProviders: { resolve },
    semanticFacts: { purgeHistory },
    jobs: { cancel: vi.fn(async () => {}), enqueue: vi.fn(async () => {}) },
    env: { agentRuntime: "scripted" },
    ...(options.archive === false ? {} : { archiveConversationMemory }),
  } as unknown as RouterDeps;
  const client = createRouterClient(threadsRoutes(createRouterContext(deps)), {
    context: { actor },
  });
  const input =
    resolved.target && (resolved.target as ThreadTarget).kind === "group"
      ? { groupId: "group-1" }
      : { botId: "bot-1" };
  return { client, input, clearThread, archiveConversationMemory, resolve, purgeHistory };
}

describe("clear with automatic memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops the direct chat, prepares the fence, force-drains, then clears under it", async () => {
    const { client, input, clearThread, archiveConversationMemory } = setup();

    await expect(client.threads.clear(input)).resolves.toEqual({ ok: true });

    expect(stop).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      actor,
      expect.objectContaining({ kind: "bot", botId: "bot-1", threadId: "thread-1" }),
    );
    expect(archive.prepareClear).toHaveBeenCalledExactlyOnceWith(
      { threadId: "thread-1", botId: "bot-1", userId: "user-1" },
      expect.objectContaining({ operationId: "thread-archive:thread-1" }),
    );
    expect(archiveConversationMemory).toHaveBeenCalledExactlyOnceWith(
      { threadId: "thread-1", botId: "bot-1", userId: "user-1" },
      expect.objectContaining({ operationId: "thread-archive:thread-1" }),
      { force: true },
    );
    expect(clearThread).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        expectedGeneration: 4,
        expectedNextMessageSeq: 9,
        archiveCoverage: "required",
      }),
    );
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0]!;
    expect(order(stop)).toBeLessThan(order(archive.prepareClear));
    expect(order(archive.prepareClear)).toBeLessThan(order(archiveConversationMemory));
    expect(order(archiveConversationMemory)).toBeLessThan(order(clearThread));
  });

  it("leaves the clear uncalled when forced archiving fails", async () => {
    const { client, input, clearThread } = setup({
      archiveError: new Error("extractor unavailable"),
    });

    await expect(client.threads.clear(input)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Memory archiving failed. No messages were deleted. Try clearing again later.",
    });
    expect(clearThread).not.toHaveBeenCalled();
  });

  it("refuses a clear with pending automatic memory when no extractor is configured", async () => {
    const { client, input, clearThread } = setup({
      archive: false,
      clearError: new ThreadArchiveCoverageError(),
    });

    await expect(client.threads.clear(input)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Memory archiving is unavailable. No messages were deleted.",
    });
    expect(archive.observeClear).toHaveBeenCalledExactlyOnceWith(
      { threadId: "thread-1", botId: "bot-1", userId: "user-1" },
      expect.objectContaining({ operationId: "thread-archive:thread-1" }),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(clearThread).toHaveBeenCalledWith(expect.objectContaining({
      expectedGeneration: 4,
      expectedNextMessageSeq: 9,
    }));
  });

  it("pins the head even without an extractor and relies on transactional managed purge", async () => {
    const { client, input, clearThread, archiveConversationMemory, purgeHistory } = setup({
      archive: false,
    });

    await expect(client.threads.clear(input)).resolves.toEqual({ ok: true });
    expect(archiveConversationMemory).not.toHaveBeenCalled();
    expect(archive.prepareClear).not.toHaveBeenCalled();
    expect(clearThread).toHaveBeenCalledOnce();
    expect(clearThread.mock.calls[0]![0]).toMatchObject({
      expectedGeneration: 4,
      expectedNextMessageSeq: 9,
    });
    expect(purgeHistory).not.toHaveBeenCalled();
  });

  it("surfaces a generation/head conflict instead of acknowledging the clear", async () => {
    const { client, input, clearThread } = setup({
      target: groupTarget,
      clearError: new ThreadClearConflictError(),
    });

    await expect(client.threads.clear(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(clearThread).toHaveBeenCalledOnce();
    expect(archive.prepareClear).not.toHaveBeenCalled();
    expect(archive.observeClear).not.toHaveBeenCalled();
  });

  it("never drains or fences a group or another owner's chat", async () => {
    const otherOwner = {
      ...directTarget,
      bot: { userId: "user-2", thread: { userId: "user-2" } },
    } as unknown as ThreadTarget;
    for (const target of [groupTarget, otherOwner]) {
      const { client, input, clearThread, archiveConversationMemory } = setup({ target });

      await expect(client.threads.clear(input)).resolves.toEqual({ ok: true });
      expect(archive.prepareClear).not.toHaveBeenCalled();
      expect(archive.observeClear).not.toHaveBeenCalled();
      expect(archiveConversationMemory).not.toHaveBeenCalled();
      expect(clearThread).toHaveBeenCalledOnce();
      expect(clearThread.mock.calls[0]![0]).not.toHaveProperty("expectedGeneration");
      expect(clearThread.mock.calls[0]![0]).not.toHaveProperty("expectedNextMessageSeq");
    }
  });
});
