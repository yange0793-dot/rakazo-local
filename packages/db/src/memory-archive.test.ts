import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { MemoryArchiveStore } from "./memory-archive.js";
import { IsolationError } from "./scope.js";
import { semanticFactNamespace } from "./semantic-facts.js";

const ctx: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};
const now = new Date("2026-01-01T00:00:00.000Z");

interface ThreadRow {
  botId: string | null;
  userId: string;
  helperBotId: string | null;
  groupId: string | null;
  externalConversationId: string | null;
  nextMessageSeq: number;
  historyCompactionGeneration: number;
}

interface MessageRow {
  id: string;
  seq: number;
  role: string;
  botId: string | null;
  authorUserId: string | null;
  blocks: unknown;
  createdAt: Date;
  runId?: string | null;
}

interface RunRow {
  id: string;
  botId: string;
  threadId: string;
  userId: string;
  status: string;
  trigger: string;
  sourceMessageId: string | null;
  createdAt?: Date;
}

interface ProgressRow {
  threadId: string;
  spaceId: string;
  botId: string;
  userId: string;
  scope: string;
  generation: number;
  throughSeq: number;
  processedUpToSeq: number;
  pending: boolean;
  availableAt: Date;
}

interface SteerRow {
  runId: string;
  messageId: string;
  botId: string;
  userId: string;
}

function threadRow(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    botId: "bot-a",
    userId: "user-a",
    helperBotId: null,
    groupId: null,
    externalConversationId: null,
    nextMessageSeq: 5,
    historyCompactionGeneration: 0,
    ...overrides,
  };
}

function message(seq: number, overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `m${seq}`,
    seq,
    role: "user",
    botId: null,
    authorUserId: "user-a",
    blocks: [{ kind: "text", text: `message ${seq}` }],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
    ...overrides,
  };
}

function assistant(seq: number, overrides: Partial<MessageRow> = {}): MessageRow {
  return message(seq, {
    role: "bot",
    botId: "bot-a",
    authorUserId: null,
    blocks: [{ kind: "text", text: `reply ${seq}` }],
    ...overrides,
  });
}

function factRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-a",
    spaceId: ctx.spaceId,
    userId: ctx.userId,
    botId: "bot-a",
    namespace: semanticFactNamespace(ctx.spaceId, "isolated", "bot-a"),
    scope: "isolated",
    kind: "durable",
    content: "Use a narrow console.",
    provenance: JSON.stringify({ kind: "manual", observedAt: now.toISOString() }),
    revision: 1,
    status: "active",
    sourceThreadId: null,
    sourceGeneration: null,
    validFrom: null,
    validTo: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fixture(
  init: {
    thread?: ThreadRow;
    progress?: ProgressRow | null;
    messages?: MessageRow[];
    runs?: RunRow[];
    steering?: SteerRow[];
    facts?: Array<ReturnType<typeof factRecord>>;
  } = {},
) {
  const messages = [...(init.messages ?? [])];
  const runs = [...(init.runs ?? [])];
  const steering = [...(init.steering ?? [])];
  const thread = init.thread ?? threadRow();
  let progress = init.progress ?? null;
  const facts = [...(init.facts ?? [])];
  const bindings = new Map<string, string>();
  const outbox = new Map<string, Record<string, unknown>>();
  const revisions: Array<Record<string, unknown>> = [];
  const retired: Array<Record<string, unknown>> = [];

  const readMessages = (args: {
    where: Record<string, unknown>;
    take?: number;
    orderBy?: Record<string, unknown>;
  }) => {
    const where = args.where;
    let rows = [...messages];
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) {
      rows = rows.filter((row) =>
        or.some((clause) => {
          if (typeof clause.id === "string") return row.id === clause.id;
          const some = (clause.steeringMessages as { some?: Record<string, unknown> } | undefined)
            ?.some;
          if (!some) return false;
          return steering.some(
            (item) =>
              item.messageId === row.id &&
              item.runId === some.runId &&
              item.botId === some.botId &&
              item.userId === some.userId,
          );
        }),
      );
    }
    const ids = (where.id as { in?: string[] } | undefined)?.in;
    if (ids) rows = rows.filter((row) => ids.includes(row.id));
    const seq = where.seq as { lt?: number; gte?: number; lte?: number } | undefined;
    if (seq?.lt !== undefined) rows = rows.filter((row) => row.seq < seq.lt!);
    if (seq?.gte !== undefined) rows = rows.filter((row) => row.seq >= seq.gte!);
    if (seq?.lte !== undefined) rows = rows.filter((row) => row.seq <= seq.lte!);
    rows = [...rows].sort((a, b) => (args.orderBy?.seq === "desc" ? b.seq - a.seq : a.seq - b.seq));
    return args.take === undefined ? rows : rows.slice(0, args.take);
  };

  const db = {
    spaceMember: { findFirst: vi.fn(async () => ({ id: "membership" })) },
    bot: { findFirst: vi.fn(async () => ({ memoryScope: "isolated" })) },
    space: { findFirst: vi.fn(async () => ({ deletingAt: null })) },
    spaceMemoryConfig: { findUnique: vi.fn(async () => ({ defaultMemoryScope: "isolated" })) },
    thread: { findFirst: vi.fn(async () => ({ ...thread })) },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return runs.find((run) => run.id === where.id) ?? null;
      }),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: {
            OR?: Array<{ sourceMessageId?: { in: string[] }; id?: { in: string[] } }>;
            threadId?: string;
            botId?: string;
            userId?: string;
            trigger?: { in: string[] };
            sourceMessageId?: { not: null };
            createdAt?: { lt?: Date };
          };
          take?: number;
        }) => {
          const sourceIds = where.OR?.flatMap((clause) =>
            clause.sourceMessageId ? clause.sourceMessageId.in : [],
          );
          const ids = where.OR?.flatMap((clause) => (clause.id ? clause.id.in : []));
          let rows = where.OR
            ? runs.filter(
                (run) =>
                  (run.sourceMessageId && sourceIds?.includes(run.sourceMessageId)) ||
                  ids?.includes(run.id),
              )
            : [...runs];
          if (!where.OR) {
            if (where.threadId !== undefined)
              rows = rows.filter((run) => run.threadId === where.threadId);
            if (where.botId !== undefined) rows = rows.filter((run) => run.botId === where.botId);
            if (where.userId !== undefined)
              rows = rows.filter((run) => run.userId === where.userId);
            if (where.trigger?.in)
              rows = rows.filter((run) => where.trigger!.in.includes(run.trigger));
            if (where.sourceMessageId) rows = rows.filter((run) => run.sourceMessageId !== null);
            if (where.createdAt?.lt)
              rows = rows.filter(
                (run) => (run.createdAt?.getTime() ?? 0) < where.createdAt!.lt!.getTime(),
              );
            rows = [...rows].sort(
              (left, right) => (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0),
            );
          }
          return take === undefined ? rows : rows.slice(0, take);
        },
      ),
    },
    message: { findMany: vi.fn(async (args: never) => readMessages(args)) },
    memoryArchiveProgress: {
      findUnique: vi.fn(async () => progress),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          progress = progress
            ? { ...progress, ...(update as Partial<ProgressRow>) }
            : ({ ...create } as unknown as ProgressRow);
          return progress;
        },
      ),
      update: vi.fn(async ({ data }: { data: Partial<ProgressRow> }) => {
        progress = { ...progress!, ...data };
        return progress;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Partial<ProgressRow>; data: Partial<ProgressRow> }) => {
          const matches =
            progress !== null &&
            Object.entries(where).every(
              ([key, value]) => progress![key as keyof ProgressRow] === value,
            );
          if (!matches) return { count: 0 };
          progress = { ...progress!, ...data };
          return { count: 1 };
        },
      ),
    },
    semanticFact: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          facts.find((row) =>
            Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
          ) ?? null
        );
      }),
      findMany: vi.fn(
        async (
          { where, take }: { where: Record<string, unknown>; take?: number } = { where: {} },
        ) => {
          let rows = [...facts];
          if (typeof where.namespace === "string")
            rows = rows.filter((row) => row.namespace === where.namespace);
          const status = where.status as { in?: string[] } | string | undefined;
          if (typeof status === "string") rows = rows.filter((row) => row.status === status);
          else if (status?.in) rows = rows.filter((row) => status.in!.includes(row.status));
          if (typeof where.sourceThreadId === "string")
            rows = rows.filter((row) => row.sourceThreadId === where.sourceThreadId);
          return take === undefined ? rows : rows.slice(0, take);
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = factRecord({ ...data, id: `fact-${facts.length + 1}` });
        facts.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = facts.findIndex((row) => row.id === where.id);
          const previous = facts[index]!;
          const updated = { ...previous, ...data } as typeof previous;
          if (typeof data.revision === "object") updated.revision = previous.revision + 1;
          facts[index] = updated;
          return updated;
        },
      ),
    },
    semanticFactSource: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { namespace_sourceKey: { namespace: string; sourceKey: string } };
        }) => {
          const id = bindings.get(
            `${where.namespace_sourceKey.namespace}:${where.namespace_sourceKey.sourceKey}`,
          );
          return id ? { fact: facts.find((row) => row.id === id)! } : null;
        },
      ),
      create: vi.fn(
        async ({ data }: { data: { namespace: string; sourceKey: string; factId: string } }) => {
          bindings.set(`${data.namespace}:${data.sourceKey}`, data.factId);
          return data;
        },
      ),
    },
    semanticFactRevision: {
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const { factId, revision } = where.factId_revision;
        return { id: `${factId}:${revision}` };
      }),
      update: vi.fn(async ({ where, data }) => {
        const snapshot = revisions.find((row) => `${row.factId}:${row.revision}` === where.id);
        if (snapshot) Object.assign(snapshot, data);
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        revisions.push(data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { factId: string } }) => {
        let count = 0;
        for (let index = revisions.length - 1; index >= 0; index -= 1) {
          if (revisions[index]!.factId === where.factId) {
            revisions.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      }),
    },
    semanticMemoryRetirement: {
      findFirst: vi.fn(async () => retired[0] ?? null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        retired.push(create);
        return create;
      }),
    },
    semanticMemoryIndexOutbox: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> & { id: string } }) => {
        if (!outbox.has(create.id)) outbox.set(create.id, create);
        return outbox.get(create.id);
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => outbox.get(where.id) ?? null,
      ),
      findMany: vi.fn(async () => [...outbox.values()]),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({
        count: Number(outbox.delete(where.id)),
      })),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    $contentEncryption: () => ({
      ring: {
        remember: vi.fn(),
        encryptWrites: true,
        current: async () => ({ key: Buffer.alloc(32, 7) }),
        all: async () => [{ key: Buffer.alloc(32, 7) }],
      },
    }),
  };
  return {
    db,
    messages,
    runs,
    facts,
    bindings,
    outbox,
    revisions,
    retired,
    progress: () => progress,
    store: new MemoryArchiveStore(db as unknown as PrismaClient),
  };
}

const batchBase = {
  threadId: "thread-a",
  botId: "bot-a",
  userId: "user-a",
  spaceId: "space-a",
  scope: "isolated" as const,
  generation: 0,
  fromSeq: 4,
  throughSeq: 6,
};

const change = {
  content: "Prefer a narrow console.",
  sourceMessageId: "m4",
  sourceQuote: "narrow console",
  category: "preference" as const,
};

describe("automatic memory archive", () => {
  it("seeds the cursor at the completed run's own user source and extends later turns", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 5 }),
      messages: [
        message(0, { blocks: [{ kind: "text", text: "ancient history" }] }),
        message(2, { blocks: [{ kind: "text", text: "Please use a narrow console." }] }),
        assistant(3),
      ],
      runs: [
        {
          id: "run-a",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "completed",
          trigger: "user",
          sourceMessageId: "m2",
        },
      ],
    });
    expect(await f.store.markPending("run-a", ctx, now)).toBe(true);
    expect(f.progress()).toMatchObject({
      threadId: "thread-a",
      botId: "bot-a",
      userId: "user-a",
      scope: "isolated",
      generation: 0,
      processedUpToSeq: 1,
      throughSeq: 4,
      pending: true,
    });
    f.messages.push(message(4, { blocks: [{ kind: "text", text: "Also prefer dark mode." }] }));
    f.runs.push({
      id: "run-b",
      botId: "bot-a",
      threadId: "thread-a",
      userId: "user-a",
      status: "completed",
      trigger: "follow_up",
      sourceMessageId: "m4",
    });
    f.db.thread.findFirst.mockResolvedValue(
      threadRow({ nextMessageSeq: 6, historyCompactionGeneration: 0 }) as never,
    );
    expect(await f.store.markPending("run-b", ctx, new Date(now.getTime() + 60_000))).toBe(true);
    expect(f.progress()).toMatchObject({ processedUpToSeq: 1, throughSeq: 5 });
  });

  it("reseeds after a clear generation instead of reviving the retired range", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 9, historyCompactionGeneration: 2 }),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 1,
        throughSeq: 20,
        processedUpToSeq: 15,
        pending: true,
        availableAt: now,
      },
      messages: [message(8, { blocks: [{ kind: "text", text: "After the clear." }] })],
      runs: [
        {
          id: "run-a",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "completed",
          trigger: "user",
          sourceMessageId: "m8",
        },
      ],
    });
    expect(await f.store.markPending("run-a", ctx, now)).toBe(true);
    expect(f.progress()).toMatchObject({
      generation: 2,
      processedUpToSeq: 7,
      throughSeq: 8,
    });
  });

  it("seeds before an unarchived failed turn that preceded the first completed one", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 5 }),
      messages: [
        message(2, { blocks: [{ kind: "text", text: "第一轮就失败的那句话" }] }),
        assistant(3),
        message(4, { blocks: [{ kind: "text", text: "第二轮成功" }] }),
      ],
      runs: [
        {
          id: "run-b",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "completed",
          trigger: "user",
          sourceMessageId: "m4",
          createdAt: new Date(now.getTime() + 1_000),
        },
        {
          id: "run-a",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "failed",
          trigger: "user",
          sourceMessageId: "m2",
          createdAt: now,
        },
      ],
    });
    expect(await f.store.markPending("run-b", ctx, now)).toBe(true);
    // The failed turn's message would otherwise sit before the seed and never be archived.
    expect(f.progress()).toMatchObject({ processedUpToSeq: 1, throughSeq: 4 });
  });

  it("schedules only trusted direct personal runs with real user text", async () => {
    const base = {
      id: "run-a",
      botId: "bot-a",
      threadId: "thread-a",
      userId: "user-a",
      status: "completed",
      trigger: "user",
      sourceMessageId: "m2",
    };
    for (const run of [
      { ...base, trigger: "routine" },
      { ...base, trigger: "helper" },
      { ...base, trigger: "webhook" },
      { ...base, status: "running" },
    ]) {
      const f = fixture({
        thread: threadRow({ nextMessageSeq: 3 }),
        messages: [message(2)],
        runs: [run],
      });
      expect(await f.store.markPending("run-a", ctx, now)).toBe(false);
      expect(f.progress()).toBeNull();
    }
    const delivery = fixture({
      thread: threadRow({ nextMessageSeq: 3 }),
      messages: [
        message(2, {
          blocks: [{ kind: "delivery" }, { kind: "text", text: "A webhook prompt body." }],
        }),
      ],
      runs: [base],
    });
    expect(await delivery.store.markPending("run-a", ctx, now)).toBe(false);
    const group = fixture({
      thread: threadRow({ groupId: "group-a" }),
      messages: [message(2)],
      runs: [base],
    });
    // A group turn completes here too; it has no personal archive, so this is a quiet no-op.
    expect(await group.store.markPending("run-a", ctx, now)).toBe(false);
    expect(group.progress()).toBeNull();
  });

  it("counts the run's claimed steering messages as its own user sources", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 6 }),
      messages: [message(3, { blocks: [{ kind: "text", text: "Steering while it worked." }] })],
      steering: [{ runId: "run-a", messageId: "m3", botId: "bot-a", userId: "user-a" }],
      runs: [
        {
          id: "run-a",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "completed",
          trigger: "user",
          sourceMessageId: null,
        },
      ],
    });
    expect(await f.store.markPending("run-a", ctx, now)).toBe(true);
    expect(f.progress()).toMatchObject({ processedUpToSeq: 2, throughSeq: 5 });
  });

  it("loads bounded context before the cursor and marks only new direct user text", async () => {
    const rows: MessageRow[] = [];
    for (let seq = 0; seq <= 3; seq += 1) rows.push(message(seq));
    rows.push(assistant(2, { id: "bot2" }));
    rows.push(
      message(4, { blocks: [{ kind: "channel_message", text: "group chatter" }] }),
      message(5, { authorUserId: "someone-else" }),
      message(6, { blocks: [{ kind: "text", text: "I prefer dark mode." }] }),
      assistant(7, { blocks: [{ kind: "steps", steps: [] }] }),
      assistant(8),
      message(9, {
        role: "system",
        authorUserId: null,
        blocks: [{ kind: "text", text: "system" }],
      }),
    );
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 9,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      messages: rows,
    });
    const batch = await f.store.loadBatch(
      { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
      ctx,
    );
    expect(batch).not.toBeNull();
    expect(batch!.newSources.map((source) => source.id)).toEqual(["m6"]);
    expect(batch!.messages.map((message) => [message.id, message.role, message.isNew])).toEqual([
      ["m0", "user", false],
      ["m1", "user", false],
      ["bot2", "assistant", false],
      ["m2", "user", false],
      ["m3", "user", false],
      ["m6", "user", true],
      ["m8", "assistant", false],
    ]);
    expect(f.db.message.findMany.mock.calls[0]![0]).toMatchObject({ take: 8 });
  });

  it("stops a batch at its byte budget so one request can hold it", async () => {
    const huge = "字".repeat(100_000);
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 3,
        processedUpToSeq: 0,
        pending: true,
        availableAt: now,
      },
      messages: [
        message(1, { blocks: [{ kind: "text", text: huge }] }),
        message(2, { blocks: [{ kind: "text", text: huge }] }),
        message(3, { blocks: [{ kind: "text", text: huge }] }),
      ],
    });
    const batch = await f.store.loadBatch(
      { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
      ctx,
    );
    // Each message is ~300 KiB; only the first fits the batch, and the cursor stops there.
    expect(batch!.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(batch!.newSources.map((source) => source.id)).toEqual(["m1"]);
    expect(batch!.throughSeq).toBe(1);
  });

  it("rejects an overlarge source and leaves the messages and checkpoint intact", async () => {
    const overlarge = "x".repeat(512 * 1024 + 1);
    const withinLimit = "字".repeat(100_000);
    const messages = [
      message(1, { blocks: [{ kind: "text", text: overlarge }] }),
      message(2, { blocks: [{ kind: "text", text: withinLimit }] }),
      message(3, { blocks: [{ kind: "text", text: withinLimit }] }),
      message(4, { blocks: [{ kind: "text", text: "A later source." }] }),
    ];
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 4,
        processedUpToSeq: 0,
        pending: true,
        availableAt: now,
      },
      messages,
    });
    const target = { threadId: "thread-a", botId: "bot-a", userId: "user-a" };
    const checkpoint = { ...f.progress() };
    const originalMessages = structuredClone(messages);

    await expect(f.store.loadBatch(target, ctx)).rejects.toThrow(
      "An automatic memory source exceeds the batch limit.",
    );
    expect(f.progress()).toEqual(checkpoint);
    expect(f.messages).toEqual(originalMessages);
  });

  it("never advances the cursor past a page it truncated", async () => {
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 9,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      messages: [message(4), message(5), message(6)],
    });
    const batch = await f.store.loadBatch(
      { threadId: "thread-a", botId: "bot-a", userId: "user-a", limit: 2 },
      ctx,
    );
    expect(batch!.throughSeq).toBe(5);
    expect(batch!.messages.map((message) => message.id)).toEqual(["m4", "m5"]);
  });

  it("ignores progress from a retired generation and an empty backlog", async () => {
    const progress = {
      threadId: "thread-a",
      spaceId: "space-a",
      botId: "bot-a",
      userId: "user-a",
      scope: "isolated",
      generation: 1,
      throughSeq: 5,
      processedUpToSeq: 5,
      pending: false,
      availableAt: now,
    };
    const retired = fixture({ thread: threadRow({ historyCompactionGeneration: 2 }), progress });
    expect(
      await retired.store.loadBatch(
        { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
        ctx,
      ),
    ).toBeNull();
    const empty = fixture({ thread: threadRow(), progress });
    expect(
      await empty.store.loadBatch({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx),
    ).toBeNull();
  });

  it("stops automatic retries without losing the unprocessed range", async () => {
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 9,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    await f.store.pause({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx);
    expect(f.progress()).toMatchObject({
      pending: false,
      processedUpToSeq: 3,
      throughSeq: 9,
    });
    expect(
      await f.store.loadBatch({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx),
    ).toBeNull();
    expect(
      await f.store.hasPending({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx),
    ).toBe(true);
  });

  it("arms a caught-up cursor for messages added since it finished", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 9 }),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 5,
        processedUpToSeq: 5,
        pending: false,
        availableAt: now,
      },
      messages: [message(6)],
    });
    await f.store.prepareClear({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx);
    expect(f.progress()).toMatchObject({ throughSeq: 8, pending: true });
  });

  it("offers only bounded forgotten or same-thread retirement evidence", async () => {
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 4,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      messages: [message(4)],
      facts: [
        factRecord({ id: "kept", status: "active" }),
        factRecord({
          id: "forgotten",
          status: "forgotten",
          revision: 3,
          content: "[forgotten]",
          provenance: JSON.stringify({
            kind: "run",
            messageId: "m1",
            quote: "narrow",
            category: "preference",
            observedAt: now.toISOString(),
          }),
        }),
        factRecord({
          id: "old-history",
          status: "historical",
          kind: "history",
          sourceThreadId: "thread-a",
        }),
        factRecord({ id: "other-thread", status: "historical", sourceThreadId: "thread-b" }),
      ],
    });
    const batch = await f.store.loadBatch(
      { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
      ctx,
    );
    expect(batch!.retirementEvidence.map((fact) => fact.id).sort()).toEqual([
      "forgotten",
      "old-history",
    ]);
    expect(batch!.retirementEvidence.find((fact) => fact.id === "forgotten")).toMatchObject({
      status: "forgotten",
      revision: 3,
      content: "[forgotten]",
    });
    expect(batch!.retirementEvidence.find((fact) => fact.id === "forgotten")).not.toHaveProperty(
      "sourceQuote",
    );
    expect(batch!.retirementEvidence.find((fact) => fact.id === "forgotten")).not.toHaveProperty(
      "sourceMessageId",
    );
  });

  it("keeps the stored placeholder as evidence when a forgotten fact had no quote", async () => {
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 4,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      messages: [message(4)],
      facts: [
        factRecord({
          id: "forgotten",
          status: "forgotten",
          revision: 2,
          content: "[forgotten]",
          provenance: JSON.stringify({ kind: "manual", observedAt: now.toISOString() }),
        }),
      ],
    });
    const batch = await f.store.loadBatch(
      { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
      ctx,
    );
    expect(batch!.retirementEvidence).toEqual([
      { id: "forgotten", revision: 2, content: "[forgotten]", status: "forgotten" },
    ]);
  });

  it("saves a source-bound fact and checkpoints in the same transaction", async () => {
    const f = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      messages: [message(4, { blocks: [{ kind: "text", text: "Please use a narrow console." }] })],
    });
    const result = await f.store.applyBatch(
      { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
      [change],
      ctx,
    );
    expect(result).toEqual({ saved: 1, updated: 0, skipped: 0, removed: 0 });
    expect(f.progress()).toMatchObject({ processedUpToSeq: 6, pending: false });
    expect(f.facts).toHaveLength(1);
    expect(JSON.parse(f.facts[0]!.provenance)).toMatchObject({
      kind: "run",
      threadId: "thread-a",
      messageId: "m4",
      quote: "narrow console",
      category: "preference",
      observedAt: f.messages[0]!.createdAt.toISOString(),
    });
    expect(f.facts[0]).toMatchObject({ kind: "durable", status: "active" });
    expect([...f.outbox.values()].map((work) => work.action)).toEqual(["upsert"]);
  });

  it("skips a repeated exact fact and never revives a forgotten one", async () => {
    const f = fixture({
      thread: threadRow(),
      messages: [message(4), message(5)],
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    f.messages[0]!.blocks = [{ kind: "text", text: "Prefer a narrow console." }];
    f.messages[1]!.blocks = [{ kind: "text", text: "Prefer a narrow console always." }];
    const repeat = { ...change, sourceMessageId: "m5", sourceQuote: "narrow console" };
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [change, repeat],
        ctx,
      ),
    ).toEqual({ saved: 1, updated: 0, skipped: 1, removed: 0 });
    f.facts[0]!.status = "forgotten";
    const p = f.progress()!;
    f.db.memoryArchiveProgress.findUnique.mockResolvedValue({
      ...p,
      processedUpToSeq: 3,
      pending: true,
    } as never);
    f.db.thread.findFirst.mockResolvedValue(threadRow() as never);
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [repeat],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 1, removed: 0 });
    expect(f.facts).toHaveLength(1);
  });

  it("applies a cited correction only at its observed revision", async () => {
    const f = fixture({
      thread: threadRow(),
      messages: [message(4, { blocks: [{ kind: "text", text: "Use a wide console now." }] })],
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
      facts: [factRecord({ id: "fact-a", revision: 1 })],
    });
    const correction = {
      ...change,
      content: "Use a wide console.",
      sourceQuote: "wide console",
      replacesId: "fact-a",
      expectedRevision: 1,
    };
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [correction],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 1, skipped: 0, removed: 0 });
    expect(f.facts[0]).toMatchObject({ revision: 2, content: "Use a wide console." });
    expect(JSON.parse(f.facts[0]!.provenance)).toMatchObject({
      kind: "run",
      messageId: "m4",
      quote: "wide console",
    });
    const p = f.progress()!;
    f.db.memoryArchiveProgress.findUnique.mockResolvedValue({
      ...p,
      processedUpToSeq: 3,
      pending: true,
    } as never);
    f.db.thread.findFirst.mockResolvedValue(threadRow() as never);
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [{ ...correction, content: "Another wide console.", expectedRevision: 1 }],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 1, removed: 0 });
    expect(f.facts[0]).toMatchObject({ revision: 2 });
  });

  it("skips foreign, context-only and quote-mismatched sources without failing the batch", async () => {
    const f = fixture({
      thread: threadRow(),
      messages: [
        message(2, { blocks: [{ kind: "text", text: "Before the cursor." }] }),
        message(4, { blocks: [{ kind: "text", text: "Please use a narrow console." }] }),
        message(5, {
          authorUserId: "someone-else",
          blocks: [{ kind: "text", text: "Someone else's words." }],
        }),
      ],
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    const result = await f.store.applyBatch(
      { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
      [
        { ...change, sourceMessageId: "m2" },
        { ...change, sourceMessageId: "m5" },
        { ...change, sourceQuote: "invented quote" },
        { ...change, category: "secret" as never },
        { ...change, replacesId: "fact-a" },
      ],
      ctx,
    );
    expect(result).toEqual({ saved: 0, updated: 0, skipped: 5, removed: 0 });
    expect(f.facts).toHaveLength(0);
    expect(f.progress()).toMatchObject({ processedUpToSeq: 6 });
  });

  it("tombstones a cited removal only at the revision the extractor was shown", async () => {
    const f = fixture({
      thread: threadRow(),
      messages: [
        message(4, { blocks: [{ kind: "text", text: "别再记我的地址了，我早就不住北京了。" }] }),
      ],
      facts: [factRecord({ id: "fact-a", revision: 2, content: "用户住在北京" })],
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    const removal = {
      content: "用户住在北京",
      sourceMessageId: "m4",
      sourceQuote: "别再记我的地址了",
      category: "preference" as const,
      replacesId: "fact-a",
      expectedRevision: 2,
      remove: true as const,
    };
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [{ ...removal, expectedRevision: 1 }],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 1, removed: 0 });
    expect(f.facts[0]).toMatchObject({ status: "active", revision: 2 });

    const p = f.progress()!;
    f.db.memoryArchiveProgress.findUnique.mockResolvedValue({
      ...p,
      processedUpToSeq: 3,
      pending: true,
    } as never);
    f.db.thread.findFirst.mockResolvedValue(threadRow() as never);
    expect(
      await f.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [removal],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 0, removed: 1 });
    expect(f.facts[0]).toMatchObject({
      status: "forgotten",
      revision: 3,
      content: "[forgotten]",
    });
    expect(f.revisions.filter((row) => row.factId === "fact-a").map((row) => row.status)).toEqual([
      "forgotten",
    ]);
    expect([...f.outbox.values()].map((work) => work.action)).toEqual(["delete", "delete"]);
  });

  it("writes nothing for another generation and checkpoints an empty batch", async () => {
    const stale = fixture({
      thread: threadRow({ historyCompactionGeneration: 1 }),
      messages: [message(4)],
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    expect(
      await stale.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [change],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 1, removed: 0 });
    expect(stale.db.semanticFact.create).not.toHaveBeenCalled();
    expect(stale.db.memoryArchiveProgress.update).not.toHaveBeenCalled();

    const empty = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    expect(
      await empty.store.applyBatch(
        { ...batchBase, messages: [], newSources: [], retirementEvidence: [] },
        [],
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, skipped: 0, removed: 0 });
    expect(empty.progress()).toMatchObject({ processedUpToSeq: 6, pending: false });
  });

  it("rejects a batch body for another owner before touching facts", async () => {
    const f = fixture({ thread: threadRow() });
    const batch = { ...batchBase, messages: [], newSources: [], retirementEvidence: [] };
    await expect(f.store.applyBatch(batch, [], { ...ctx, userId: "other" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(
      f.store.loadBatch(
        { threadId: "thread-a", botId: "bot-a", userId: "user-a" },
        { ...ctx, botId: "other-bot" },
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("returns pointer rows and answers pending only for the live generation", async () => {
    const pointer = {
      threadId: "thread-a",
      botId: "bot-a",
      userId: "user-a",
      spaceId: "space-a",
      availableAt: now,
    };
    const live = fixture({
      thread: threadRow(),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 0,
        throughSeq: 6,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });
    live.db.$queryRaw.mockResolvedValueOnce([pointer] as never);
    expect(await live.store.pending(10)).toEqual([pointer]);
    expect(
      await live.store.hasPending({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx),
    ).toBe(true);
    live.db.thread.findFirst.mockResolvedValue(
      threadRow({ historyCompactionGeneration: 1 }) as never,
    );
    expect(
      await live.store.hasPending({ threadId: "thread-a", botId: "bot-a", userId: "user-a" }, ctx),
    ).toBe(false);
  });
});

describe("automatic memory clear preparation", () => {
  const target = { threadId: "thread-a", botId: "bot-a", userId: "user-a" };

  it.each(["isolated", "shared"])("extends an activated %s cursor despite scope changes", async (scope) => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 8, historyCompactionGeneration: 2 }),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope,
        generation: 2,
        throughSeq: 5,
        processedUpToSeq: 3,
        pending: true,
        availableAt: now,
      },
    });

    expect(await f.store.prepareClear(target, ctx)).toEqual({ generation: 2, nextMessageSeq: 8 });
    expect(f.progress()).toMatchObject({
      throughSeq: 7,
      processedUpToSeq: 3,
      pending: true,
      generation: 2,
      scope: "isolated",
    });
    expect(f.db.message.findMany).not.toHaveBeenCalled();
    expect(f.db.run.findMany).not.toHaveBeenCalled();
  });

  it("reseeds a stale generation just before the latest persisted direct source", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 7 }),
      progress: {
        threadId: "thread-a",
        spaceId: "space-a",
        botId: "bot-a",
        userId: "user-a",
        scope: "isolated",
        generation: 1,
        throughSeq: 6,
        processedUpToSeq: 5,
        pending: false,
        availableAt: now,
      },
      messages: [
        message(1, { blocks: [{ kind: "text", text: "ancient preference" }] }),
        message(4, { blocks: [{ kind: "text", text: "latest preference" }] }),
        message(6, { blocks: [{ kind: "text", text: "current steering" }] }),
      ],
      runs: [
        {
          id: "run-late",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "cancelled",
          trigger: "follow_up",
          sourceMessageId: "m4",
        },
        {
          id: "run-old",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "completed",
          trigger: "user",
          sourceMessageId: "m1",
        },
      ],
    });

    expect(await f.store.prepareClear(target, ctx)).toEqual({ generation: 0, nextMessageSeq: 7 });
    expect(f.progress()).toMatchObject({
      generation: 0,
      scope: "isolated",
      processedUpToSeq: 3,
      throughSeq: 6,
      pending: true,
    });
  });

  it("records coverage when the remaining transcript has no direct user source", async () => {
    const f = fixture({
      thread: threadRow({ nextMessageSeq: 3 }),
      messages: [
        message(2, { blocks: [{ kind: "channel_message", text: "relayed instruction" }] }),
      ],
      runs: [
        {
          id: "run-relayed",
          botId: "bot-a",
          threadId: "thread-a",
          userId: "user-a",
          status: "running",
          trigger: "user",
          sourceMessageId: "m2",
        },
      ],
    });

    expect(await f.store.prepareClear(target, ctx)).toEqual({ generation: 0, nextMessageSeq: 3 });
    expect(f.progress()).toMatchObject({
      generation: 0,
      processedUpToSeq: 2,
      throughSeq: 2,
      pending: false,
    });
  });

  it("rejects a different target owner for prepareClear and hasPending", async () => {
    const f = fixture();
    const other = { ...ctx, userId: "user-b" };
    await expect(f.store.prepareClear(target, other)).rejects.toBeInstanceOf(IsolationError);
    await expect(f.store.hasPending(target, other)).rejects.toBeInstanceOf(IsolationError);
  });
});
