import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { FinalizeRunInput } from "./events.js";
import { finalizeRun } from "./events.js";
import type { MemoryArchiveProgress, Prisma, PrismaClient } from "./generated/prisma/client.js";
import { MemoryArchiveStore } from "./memory-archive.js";
import { IsolationError } from "./scope.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const AVAILABLE_AT = new Date(NOW.getTime() + 60_000);
const scope = { spaceId: "space-a", userId: "user-a", botId: "bot-a" };
const target = { threadId: "thread-a", botId: scope.botId, userId: scope.userId };
const context: AdapterContext = {
  ...scope,
  operationId: "archive-test",
  traceId: "archive-test",
  signal: new AbortController().signal,
};
type Progress = Omit<MemoryArchiveProgress, "createdAt" | "updatedAt">;

interface Message {
  id: string;
  seq: number;
  role: string;
  authorUserId: string | null;
  botId: string | null;
  blocks: unknown;
  createdAt: Date;
}

function runRow(seq: number, userId = scope.userId) {
  return {
    ...scope,
    userId,
    threadId: target.threadId,
    id: `run-${seq}`,
    taskId: `task-${seq}`,
    sourceMessageId: `message-${seq}` as string | null,
    trigger: "user",
    status: "running",
    leaseOwner: "worker-a" as string | null,
    leaseFence: 1,
    createdAt: new Date(NOW.getTime() + seq * 1_000),
    startedAt: NOW,
    completedAt: null as Date | null,
    firstResponseAt: null as Date | null,
    sourceMessage: null,
  };
}

function fixture(initialUserId = scope.userId) {
  let state = {
    memberships: [
      { id: "member-a", spaceId: scope.spaceId, userId: scope.userId },
      { id: "member-b", spaceId: scope.spaceId, userId: "user-b" },
    ],
    space: { id: scope.spaceId, deletingAt: null as Date | null },
    bot: { id: scope.botId, spaceId: scope.spaceId, memoryScope: "isolated" },
    runs: [] as ReturnType<typeof runRow>[],
    messages: [] as Message[],
    events: [] as Array<{ type: string; threadId: string; seq: number; createdAt: Date }>,
    steering: [] as Array<{ runId: string | null; messageId: string }>,
    progress: null as Progress | null,
    taskStatus: "running",
    attemptStatus: "running",
    thread: {
      ...scope,
      helperBotId: null,
      groupId: null,
      externalConversationId: null,
      historyCompactionGeneration: 0,
      nextMessageSeq: 0,
      nextEventSeq: 0,
    },
  };
  function startTurn(userId = initialUserId): FinalizeRunInput & { outcome: "completed" } {
    const seq = state.thread.nextMessageSeq++;
    const run = runRow(seq, userId);
    state.runs.push(run);
    state.messages.push({
      id: run.sourceMessageId!,
      seq,
      role: "user",
      authorUserId: userId,
      botId: null,
      blocks: [{ kind: "text", text: `source ${seq}` }],
      createdAt: run.createdAt,
    });
    state.taskStatus = "running";
    state.attemptStatus = "running";
    return {
      ...scope,
      threadId: target.threadId,
      runId: run.id,
      taskId: run.taskId,
      attemptId: `attempt-${seq}`,
      leaseOwner: "worker-a",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: `reply ${seq}` }],
      markUnread: false,
      memoryArchiveAt: AVAILABLE_AT,
    };
  }
  const input = startTurn();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findFirst: vi.fn(
        async ({ where }: { where: { spaceId: string; userId: string } }) =>
          state.memberships.find(
            (member) => member.spaceId === where.spaceId && member.userId === where.userId,
          ) ?? null,
      ),
    },
    space: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.space.id === where.id ? { ...state.space } : null,
      ),
    },
    spaceMemoryConfig: { findUnique: vi.fn(async () => ({ defaultMemoryScope: "isolated" })) },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        state.bot.id === where.id && state.bot.spaceId === where.spaceId ? { ...state.bot } : null,
      ),
      update: vi.fn(async () => ({})),
    },
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.runs.find((run) => run.id === where.id),
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; spaceId?: string; userId?: string; status?: { in: string[] } };
        }) =>
          state.runs.find(
            (run) =>
              (!where.spaceId || run.spaceId === where.spaceId) &&
              (!where.userId || run.userId === where.userId) &&
              (where.id ? run.id === where.id : where.status?.in.includes(run.status)),
          ) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; spaceId: string; botId: string; createdAt: { lt: Date } };
        }) =>
          state.runs
            .filter(
              (run) =>
                run.userId === where.userId &&
                run.spaceId === where.spaceId &&
                run.botId === where.botId &&
                run.createdAt < where.createdAt.lt,
            )
            .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Partial<ReturnType<typeof runRow>>;
          data: Partial<ReturnType<typeof runRow>>;
        }) => {
          const rows = state.runs.filter((run) =>
            Object.entries(where).every(([key, value]) => Reflect.get(run, key) === value),
          );
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      ),
    },
    task: {
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
        state.taskStatus = data.status;
        return { count: 1 };
      }),
    },
    attempt: {
      updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
        state.attemptStatus = data.status;
        return { count: 1 };
      }),
    },
    thread: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        target.threadId === where.id && state.thread.spaceId === where.spaceId
          ? { ...state.thread }
          : null,
      ),
      update: vi.fn(
        async ({
          data,
        }: {
          data: {
            nextMessageSeq?: { increment: number };
            nextEventSeq?: { increment: number };
          };
        }) => {
          state.thread.nextMessageSeq += data.nextMessageSeq?.increment ?? 0;
          state.thread.nextEventSeq += data.nextEventSeq?.increment ?? 0;
          return { ...state.thread };
        },
      ),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Omit<Message, "id" | "createdAt"> }) => {
        const row = { ...data, id: `message-${data.seq}`, createdAt: NOW };
        state.messages.push(row);
        return row;
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: {
            OR?: Array<{
              id?: string;
              steeringMessages?: { some: { runId: string } };
            }>;
            seq?: { lt?: number; gte?: number; lte?: number };
          };
          orderBy?: { seq: string };
          take?: number;
        }) => {
          const rows = state.messages.filter((row) => {
            if (where.OR) {
              return where.OR.some(
                (clause) =>
                  clause.id === row.id ||
                  state.steering.some(
                    (steering) =>
                      steering.messageId === row.id &&
                      steering.runId === clause.steeringMessages?.some.runId,
                  ),
              );
            }
            return (
              (where.seq?.lt === undefined || row.seq < where.seq.lt) &&
              (where.seq?.gte === undefined || row.seq >= where.seq.gte) &&
              (where.seq?.lte === undefined || row.seq <= where.seq.lte)
            );
          });
          rows.sort((a, b) => (orderBy?.seq === "desc" ? b.seq - a.seq : a.seq - b.seq));
          return rows.slice(0, take ?? rows.length);
        },
      ),
    },
    event: {
      create: vi.fn(async ({ data }: { data: (typeof state.events)[number] }) => {
        const row = { ...data, createdAt: NOW };
        state.events.push(row);
        return row;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    steeringMessage: {
      deleteMany: vi.fn(async () => {
        const count = state.steering.length;
        state.steering = [];
        return { count };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    memoryArchiveProgress: {
      findUnique: vi.fn(async () => state.progress),
      upsert: vi.fn(async ({ create, update }: { create: Progress; update: Partial<Progress> }) => {
        state.progress = state.progress ? { ...state.progress, ...update } : { ...create };
        return state.progress;
      }),
      update: vi.fn(async ({ data }: { data: Partial<Progress> }) => {
        state.progress = { ...state.progress!, ...data };
        return state.progress;
      }),
    },
    semanticFact: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(
      async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => {
        const before = structuredClone(state);
        try {
          return await callback(tx as unknown as Prisma.TransactionClient);
        } catch (error) {
          state = before;
          throw error;
        }
      },
    ),
    $queryRaw: vi.fn(async () => {
      const progress = state.progress;
      if (
        !progress?.pending ||
        progress.processedUpToSeq >= progress.throughSeq ||
        progress.generation !== state.thread.historyCompactionGeneration
      )
        return [];
      return [{ ...scope, threadId: target.threadId, availableAt: progress.availableAt }];
    }),
  };
  const db = prisma as unknown as PrismaClient;
  return { db, prisma, tx, state: () => state, startTurn, input };
}

describe("completion and automatic memory intent", () => {
  it.each(["user", "follow_up"])(
    "completes another space member's %s turn without a personal archive and keeps owner archiving",
    async (trigger) => {
      const memberId = "user-b";
      const f = fixture(memberId);
      f.state().runs[0]!.trigger = trigger;

      await expect(finalizeRun(f.db, f.input)).resolves.toEqual({ continuationRunId: null });

      expect(f.prisma.$transaction).toHaveBeenCalledOnce();
      expect(f.state()).toMatchObject({
        runs: [{ userId: memberId, status: "completed" }],
        taskStatus: "completed",
        attemptStatus: "completed",
        thread: { userId: scope.userId },
        progress: null,
      });
      expect(f.state().messages).toEqual([
        expect.objectContaining({ role: "user", authorUserId: memberId }),
        expect.objectContaining({ role: "bot", blocks: f.input.blocks }),
      ]);
      expect(f.state().events.map((event) => event.type)).toContain("run.completed");
      expect(f.tx.memoryArchiveProgress.upsert).not.toHaveBeenCalled();
      const archive = new MemoryArchiveStore(f.db);
      expect(await archive.pending()).toEqual([]);

      const ownerTurn = f.startTurn(scope.userId);
      await expect(finalizeRun(f.db, ownerTurn)).resolves.toEqual({
        continuationRunId: null,
        memoryArchiveAt: AVAILABLE_AT,
      });
      expect(f.state().progress).toMatchObject({
        userId: scope.userId,
        processedUpToSeq: 1,
        throughSeq: 3,
        pending: true,
      });
      expect((await archive.loadBatch(target, context))?.newSources.map((row) => row.id)).toEqual([
        "message-2",
      ]);
      await expect(
        archive.loadBatch({ ...target, userId: memberId }, { ...context, userId: memberId }),
      ).rejects.toBeInstanceOf(IsolationError);

      const progress = structuredClone(f.state().progress);
      const nextMemberTurn = f.startTurn(memberId);
      f.state().runs.at(-1)!.trigger = trigger;
      await expect(finalizeRun(f.db, nextMemberTurn)).resolves.toEqual({
        continuationRunId: null,
      });
      expect(f.state().progress).toEqual(progress);
      expect(f.tx.memoryArchiveProgress.upsert).toHaveBeenCalledOnce();
      expect(f.tx.memoryArchiveProgress.update).not.toHaveBeenCalled();
      expect(f.state().runs.every((run) => run.status === "completed")).toBe(true);
    },
  );

  it.each([
    "missing membership",
    "foreign thread",
    "wrong thread bot",
    "foreign bot",
    "deleting space",
  ])("keeps %s as an authorization failure for another member's completion", async (failure) => {
    const f = fixture("user-b");
    switch (failure) {
      case "missing membership":
        f.state().memberships = f
          .state()
          .memberships.filter((member) => member.userId !== "user-b");
        break;
      case "foreign thread":
        f.state().thread.spaceId = "space-b";
        break;
      case "wrong thread bot":
        f.state().thread.botId = "bot-b";
        break;
      case "foreign bot":
        f.state().bot.spaceId = "space-b";
        break;
      case "deleting space":
        f.state().space.deletingAt = NOW;
        break;
    }
    const before = structuredClone(f.state());

    await expect(finalizeRun(f.db, f.input)).rejects.toBeInstanceOf(IsolationError);

    expect(f.state()).toEqual(before);
    expect(f.tx.memoryArchiveProgress.upsert).not.toHaveBeenCalled();
  });

  it("recovers the first committed source without a publication and keeps it after the next turn", async () => {
    const f = fixture();
    await expect(finalizeRun(f.db, f.input)).resolves.toEqual({
      continuationRunId: null,
      memoryArchiveAt: AVAILABLE_AT,
    });
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({
      runs: [{ status: "completed" }],
      attemptStatus: "completed",
      taskStatus: "completed",
      progress: { processedUpToSeq: -1, throughSeq: 1, pending: true, availableAt: AVAILABLE_AT },
    });
    expect(f.tx.semanticFact.findMany).not.toHaveBeenCalled();

    // A fresh worker sees only the committed DB state; no post-completion publisher ran.
    const recovered = new MemoryArchiveStore(f.db);
    expect(await recovered.pending()).toEqual([
      { ...scope, threadId: target.threadId, availableAt: AVAILABLE_AT },
    ]);
    expect((await recovered.loadBatch(target, context))?.newSources.map((row) => row.id)).toEqual([
      "message-0",
    ]);
    const nextAvailableAt = new Date(AVAILABLE_AT.getTime() + 60_000);
    await finalizeRun(f.db, { ...f.startTurn(), memoryArchiveAt: nextAvailableAt });
    expect(f.state().progress).toMatchObject({
      processedUpToSeq: -1,
      throughSeq: 3,
      availableAt: nextAvailableAt,
    });
    expect((await recovered.loadBatch(target, context))?.newSources.map((row) => row.id)).toEqual([
      "message-0",
      "message-2",
    ]);
  });

  it("rolls back completion when the first intent cannot be saved, then retries with the same source", async () => {
    const f = fixture();
    const before = structuredClone(f.state());
    f.tx.memoryArchiveProgress.upsert.mockRejectedValueOnce(new Error("intent unavailable"));

    await expect(finalizeRun(f.db, f.input)).rejects.toThrow("intent unavailable");

    expect(f.state()).toEqual(before);
    expect(await new MemoryArchiveStore(f.db).pending()).toEqual([]);
    await expect(finalizeRun(f.db, f.input)).resolves.toMatchObject({
      memoryArchiveAt: AVAILABLE_AT,
    });
    expect(f.state().progress).toMatchObject({ processedUpToSeq: -1, throughSeq: 1 });
  });

  it("rolls back the intent as well when the completion transaction fails after registration", async () => {
    const f = fixture();
    const before = structuredClone(f.state());
    f.tx.bot.update.mockRejectedValueOnce(new Error("completion unavailable"));

    await expect(finalizeRun(f.db, f.input)).rejects.toThrow("completion unavailable");

    expect(f.tx.memoryArchiveProgress.upsert).toHaveBeenCalledOnce();
    expect(f.state()).toEqual(before);
    expect(await new MemoryArchiveStore(f.db).pending()).toEqual([]);
  });

  it("registers claimed steering before completion deletes it", async () => {
    const f = fixture();
    f.state().runs[0]!.sourceMessageId = null;
    f.state().steering.push({ runId: f.input.runId, messageId: "message-0" });

    await expect(finalizeRun(f.db, f.input)).resolves.toMatchObject({
      memoryArchiveAt: AVAILABLE_AT,
    });

    expect(f.state().steering).toEqual([]);
    expect(f.state().progress).toMatchObject({ processedUpToSeq: -1, throughSeq: 1 });
    expect(f.tx.memoryArchiveProgress.upsert.mock.invocationCallOrder[0]!).toBeLessThan(
      f.tx.steeringMessage.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("does not register an archive for a superseded completion fence", async () => {
    const f = fixture();
    const before = structuredClone(f.state());

    await expect(finalizeRun(f.db, { ...f.input, leaseFence: 0 })).resolves.toBe(false);

    expect(f.state()).toEqual(before);
    expect(f.tx.memoryArchiveProgress.upsert).not.toHaveBeenCalled();
  });

  it("starts at the first enabled completion without importing earlier completed sources", async () => {
    const f = fixture();
    await expect(finalizeRun(f.db, { ...f.input, memoryArchiveAt: undefined })).resolves.toEqual({
      continuationRunId: null,
    });
    expect(f.tx.memoryArchiveProgress.upsert).not.toHaveBeenCalled();
    expect(f.state().progress).toBeNull();

    await finalizeRun(f.db, f.startTurn());

    expect(f.state().progress).toMatchObject({ processedUpToSeq: 1, throughSeq: 3 });
    const batch = await new MemoryArchiveStore(f.db).loadBatch(target, context);
    expect(batch?.newSources.map((row) => row.id)).toEqual(["message-2"]);
    expect(batch?.messages.find((row) => row.id === "message-0")?.isNew).toBe(false);
  });

  it("retires the previous generation and seeds from the first source after clear", async () => {
    const f = fixture();
    await finalizeRun(f.db, f.input);
    f.state().thread.historyCompactionGeneration += 1;
    f.state().messages = [];
    const recovered = new MemoryArchiveStore(f.db);
    expect(await recovered.pending()).toEqual([]);
    expect(await recovered.loadBatch(target, context)).toBeNull();

    await finalizeRun(f.db, f.startTurn());

    expect(f.state().progress).toMatchObject({
      generation: 1,
      processedUpToSeq: 1,
      throughSeq: 3,
    });
    expect((await recovered.loadBatch(target, context))?.newSources.map((row) => row.id)).toEqual([
      "message-2",
    ]);
  });
});
