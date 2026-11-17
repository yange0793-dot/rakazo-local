import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { SemanticFact as FactRecord, PrismaClient } from "./generated/prisma/client.js";
import { IsolationError } from "./scope.js";
import { SemanticFactStore, semanticFactNamespace } from "./semantic-facts.js";

const ctx: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};
const namespace = semanticFactNamespace(ctx.spaceId, "isolated", "bot-a");
const time = new Date("2026-01-01T00:00:00.000Z");

function record(overrides: Partial<FactRecord> = {}): FactRecord {
  return {
    id: "fact-a",
    spaceId: ctx.spaceId,
    userId: ctx.userId,
    botId: "bot-a",
    namespace,
    scope: "isolated",
    kind: "durable",
    content: "Use a narrow console.",
    provenance: JSON.stringify({ kind: "manual", observedAt: time.toISOString() }),
    revision: 1,
    status: "active",
    sourceThreadId: null,
    sourceGeneration: null,
    validFrom: null,
    validTo: null,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}

function fixture(rows: FactRecord[] = []) {
  const sources = new Map<string, string>();
  const outbox = new Map<string, Record<string, unknown>>();
  const revisions: Array<Record<string, unknown>> = [];
  const retired: Array<Record<string, unknown>> = [];
  const findFirst = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof FactRecord] === value),
      ) ?? null,
  );
  const fact = {
    findFirst,
    findMany: vi.fn(async (_args?: unknown) => rows),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = record({ ...data, id: `fact-${rows.length + 1}` } as Partial<FactRecord>);
      rows.push(row);
      return row;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        const previous = rows[index]!;
        const updated = { ...previous, ...data, updatedAt: new Date() } as FactRecord;
        if (typeof data.revision === "object") updated.revision = previous.revision + 1;
        rows[index] = updated;
        return updated;
      },
    ),
  };
  const db = {
    space: { findFirst: vi.fn(async () => ({ deletingAt: null })) },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "membership" })) },
    bot: { findFirst: vi.fn(async () => ({ userId: ctx.userId })) },
    thread: {
      findFirst: vi.fn(async () => ({
        botId: "bot-a",
        groupId: null,
        externalConversationId: null,
        historyCompactionGeneration: 3,
      })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        threadId: "thread-a",
        sourceMessageId: "message-a",
        trigger: "user",
        status: "running",
      })),
    },
    message: {
      findFirst: vi.fn(async () => ({
        authorUserId: ctx.userId,
        blocks: [{ kind: "text", text: "Please use a narrow console." }],
      })),
    },
    chatGroupMember: { findFirst: vi.fn(async () => ({ botId: "bot-a" })) },
    semanticFact: fact,
    semanticFactSource: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { namespace_sourceKey: { namespace: string; sourceKey: string } };
        }) => {
          const id = sources.get(
            `${where.namespace_sourceKey.namespace}:${where.namespace_sourceKey.sourceKey}`,
          );
          return id ? { fact: rows.find((row) => row.id === id)! } : null;
        },
      ),
      create: vi.fn(
        async ({ data }: { data: { namespace: string; sourceKey: string; factId: string } }) => {
          sources.set(`${data.namespace}:${data.sourceKey}`, data.factId);
          return data;
        },
      ),
    },
    semanticFactRevision: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        revisions.push(data);
        return data;
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
        encryptWrites: true,
        current: async () => ({ key: Buffer.alloc(32, 7) }),
        all: async () => [{ key: Buffer.alloc(32, 7) }],
      },
    }),
  };
  return {
    db,
    rows,
    outbox,
    sources,
    revisions,
    retired,
    store: new SemanticFactStore(db as unknown as PrismaClient),
  };
}

describe("managed semantic fact authority", () => {
  it("uses exactly one isolated or shared namespace without delimiter collisions", () => {
    expect(semanticFactNamespace("space-a", "shared", "bot-a")).toBe(
      semanticFactNamespace("space-a", "shared", "bot-b"),
    );
    expect(semanticFactNamespace("space-a", "shared", "bot-a")).not.toBe(namespace);
    expect(semanticFactNamespace("space-b", "shared", "bot-a")).not.toBe(
      semanticFactNamespace("space-a", "shared", "bot-a"),
    );
    expect(semanticFactNamespace("a:b", "isolated", "c")).not.toBe(
      semanticFactNamespace("a", "isolated", "b:c"),
    );
  });

  it("binds stable exact source/content and never resurrects a forgotten retry", async () => {
    const f = fixture();
    const request = {
      botId: "bot-a",
      scope: "isolated" as const,
      content: "Use a narrow console.",
      source: { kind: "durable" as const },
    };
    const saved = await f.store.save(request, ctx);
    expect((await f.store.save(request, ctx)).id).toBe(saved.id);
    expect(f.db.semanticFact.create).toHaveBeenCalledTimes(1);
    await f.store.forget(
      { id: saved.id, botId: "bot-a", scope: "isolated", expectedRevision: 1 },
      ctx,
    );
    expect(await f.store.save(request, ctx)).toMatchObject({
      id: saved.id,
      status: "forgotten",
      revision: 2,
    });
    expect(f.db.semanticFact.create).toHaveBeenCalledTimes(1);
    expect(f.revisions.map((row) => row.status)).toEqual(["active", "forgotten"]);
    expect(
      [...f.outbox.values()].every((work) => !("content" in work) && !("provenance" in work)),
    ).toBe(true);
  });

  it("changes a fact and enqueues revision cleanup atomically, rejects stale corrections", async () => {
    const f = fixture([record()]);
    const request = {
      id: "fact-a",
      botId: "bot-a",
      scope: "isolated" as const,
      content: "Use a wide console.",
      expectedRevision: 1,
    };
    const saved = await f.store.correct(request, ctx);
    expect(saved).toMatchObject({
      id: "fact-a",
      revision: 2,
      content: request.content,
      provenance: { kind: "manual" },
    });
    expect([...f.outbox.values()].map((work) => [work.revision, work.action])).toEqual([
      [1, "delete"],
      [2, "upsert"],
    ]);
    expect((await f.store.correct(request, ctx)).revision).toBe(2);
    await expect(
      f.store.correct({ ...request, content: "Another correction." }, ctx),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(f.db.semanticFact.update).toHaveBeenCalledTimes(1);
    expect(f.db.$transaction).toHaveBeenCalled();
  });

  it("accepts only persisted matching source quotes and keeps inference run-attributed", async () => {
    const f = fixture();
    const runContext = { ...ctx, runId: "run-a" };
    const request = {
      botId: "bot-a",
      scope: "isolated" as const,
      content: "The console should be narrow.",
      source: {
        kind: "durable" as const,
        runId: "run-a",
        threadId: "thread-a",
        messageId: "message-a",
        quote: "use a narrow console",
      },
    };
    const saved = await f.store.save(request, runContext);
    expect(saved.provenance).toMatchObject({
      kind: "run",
      runId: "run-a",
      messageId: "message-a",
      quote: request.source.quote,
    });
    await expect(
      f.store.save(
        { ...request, source: { ...request.source, quote: "invented quote" } },
        runContext,
      ),
    ).rejects.toThrow(/actual user message/);
    await expect(
      f.store.save(
        { ...request, source: { ...request.source, messageId: "foreign-message" } },
        runContext,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    f.db.run.findFirst.mockResolvedValueOnce({
      threadId: "thread-a",
      sourceMessageId: "message-a",
      trigger: "helper",
      status: "running",
    });
    await expect(f.store.save(request, runContext)).rejects.toBeInstanceOf(IsolationError);
  });

  it("retains routine run attribution without granting a user quote or helper writes", async () => {
    const f = fixture();
    f.db.run.findFirst.mockResolvedValue({
      threadId: "thread-a",
      sourceMessageId: "message-a",
      trigger: "routine",
      status: "running",
    });
    const request = {
      botId: "bot-a",
      scope: "isolated" as const,
      content: "Synthetic routine observation.",
      source: { kind: "durable" as const, runId: "routine-run", threadId: "thread-a" },
    };
    const saved = await f.store.save(request, { ...ctx, runId: "routine-run" });
    expect(saved.provenance).toMatchObject({
      kind: "run",
      runId: "routine-run",
      threadId: "thread-a",
    });
    expect(saved.provenance.messageId).toBeUndefined();
    await expect(
      f.store.save(
        { ...request, source: { ...request.source, quote: "invented user authorization" } },
        { ...ctx, runId: "routine-run" },
      ),
    ).rejects.toThrow("routine cannot claim");
  });

  it("does not accept an unattributed user message or a body the index cannot store", async () => {
    const f = fixture();
    const request = {
      botId: "bot-a",
      scope: "isolated" as const,
      content: "A fact.",
      source: {
        kind: "durable" as const,
        runId: "run-a",
        threadId: "thread-a",
        messageId: "message-a",
      },
    };
    f.db.message.findFirst.mockResolvedValueOnce({
      authorUserId: null as unknown as string,
      blocks: [{ kind: "text", text: "A fact." }],
    });
    await expect(f.store.save(request, { ...ctx, runId: "run-a" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    await expect(
      f.store.save({ ...request, content: "界".repeat(14_000) }, { ...ctx, runId: "run-a" }),
    ).rejects.toThrow("40 KiB");
    expect(f.db.semanticFact.create).not.toHaveBeenCalled();
  });

  it("keeps retired-generation history out of the normal listing before physical purge", async () => {
    const f = fixture([
      record({
        id: "stale-history",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 2,
      }),
    ]);
    f.db.thread.findFirst.mockResolvedValue(null as never);
    expect((await f.store.list({ botId: "bot-a", scope: "isolated" }, ctx)).items).toEqual([]);
    expect(
      (await f.store.list({ botId: "bot-a", scope: "isolated", includeHistory: true }, ctx)).items,
    ).toHaveLength(1);
  });

  it("filters stale, foreign, forgotten and inactive-time hits without trusting indexed text", async () => {
    const f = fixture([
      record(),
      record({ id: "future", validFrom: new Date("2999-01-01") }),
      record({ id: "old", validTo: time }),
      record({ id: "forgotten", status: "forgotten" }),
      record({
        id: "history-good",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 3,
      }),
      record({
        id: "history-foreign",
        kind: "history",
        sourceThreadId: "thread-b",
        sourceGeneration: 3,
      }),
    ]);
    const candidates = [
      { id: "fact-a", revision: 9, score: 20 },
      { id: "missing-foreign", revision: 1, score: 19 },
      { id: "future", revision: 1, score: 18 },
      { id: "old", revision: 1, score: 17 },
      { id: "forgotten", revision: 1, score: 16 },
      { id: "history-foreign", revision: 1, score: 15 },
      { id: "history-good", revision: 1, score: 14 },
      { id: "fact-a", revision: 1, score: 13 },
    ];
    const recalled = await f.store.resolveCandidates(
      {
        botId: "bot-a",
        scope: "isolated",
        query: "console",
        threadId: "thread-a",
        historyGeneration: 3,
        limit: 5,
      },
      candidates,
      ctx,
    );
    expect(recalled.map((hit) => hit.id)).toEqual(["history-good", "fact-a"]);
    expect(
      recalled.every((hit) => hit.memory === "Use a narrow console." && hit.revision === 1),
    ).toBe(true);
    expect(f.db.semanticFact.findMany.mock.calls[0]![0]).toMatchObject({
      where: { namespace, status: "active" },
    });
  });

  it("does not expose index query or management across a foreign bot scope", async () => {
    const f = fixture();
    f.db.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.store.list({ botId: "bot-a", scope: "isolated" }, ctx)).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.db.semanticFact.findMany).not.toHaveBeenCalled();
  });

  it("resolves stale upsert pointers to delete and keeps cleanup after a racing tombstone", async () => {
    const f = fixture([record()]);
    const work = {
      id: "sm-upsert:fact-a:1",
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      namespace,
      indexId: "sm:fact-a:1",
      factId: "fact-a",
      revision: 1,
      action: "upsert",
      createdAt: time,
    };
    f.outbox.set(work.id, work);
    expect(await f.store.getIndexWork(work.id)).toMatchObject({
      action: "upsert",
      content: "Use a narrow console.",
    });
    f.rows[0] = record({ status: "forgotten", revision: 2 });
    expect(await f.store.getIndexWork(work.id)).toMatchObject({ action: "delete", content: null });
    await f.store.completeIndexWork(work.id);
    expect(f.outbox.has(work.id)).toBe(false);
    expect(f.outbox.get("sm-delete:fact-a:1")).toMatchObject({ action: "delete", revision: 1 });
  });

  it("preserves explicit import status, dates and source identity", async () => {
    const f = fixture();
    const input = {
      botId: "bot-a",
      scope: "isolated" as const,
      sourceKey: "legacy:source-a",
      content: "",
      kind: "durable" as const,
      provenance: {
        kind: "import" as const,
        sourceId: "source-a",
        legacy: { validationStatus: "expired" },
      },
      status: "historical" as const,
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
    };
    const saved = await f.store.importFact(input, ctx);
    expect(saved).toMatchObject({
      status: "historical",
      content: "",
      createdAt: input.createdAt,
      provenance: input.provenance,
    });
    expect(
      await f.store.importFact({ ...input, status: "active", content: "Do not promote." }, ctx),
    ).toMatchObject({ id: saved.id, status: "historical", content: "" });
    expect(f.db.semanticFact.create).toHaveBeenCalledTimes(1);
    expect([...f.outbox.values()][0]).toMatchObject({ action: "delete" });
  });

  it("pages substring matches exactly and binds cursors to the scope and filter", async () => {
    const f = fixture([
      record({ id: "a", content: "needle one" }),
      record({ id: "b", content: "irrelevant" }),
      record({ id: "c", content: "needle two" }),
    ]);
    f.db.semanticFact.findMany.mockImplementation(async (args?: unknown) => {
      const after = (args as { where: { id: { gt: string } } }).where.id.gt;
      return f.rows.filter((row) => row.id > after);
    });
    const first = await f.store.list(
      { botId: "bot-a", scope: "isolated", query: "needle", limit: 1 },
      ctx,
    );
    expect(first.items.map((item) => item.id)).toEqual(["a"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await f.store.list(
      { botId: "bot-a", scope: "isolated", query: "needle", limit: 1, cursor: first.nextCursor! },
      ctx,
    );
    expect(second.items.map((item) => item.id)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
    await expect(
      f.store.list(
        { botId: "bot-a", scope: "shared", query: "needle", cursor: first.nextCursor! },
        ctx,
      ),
    ).rejects.toThrow(/another listing/);
  });

  it("fences retired history and refuses a late save before creating a fact", async () => {
    const f = fixture();
    f.retired.push({ id: "retired" });
    await expect(
      f.store.save(
        {
          botId: "bot-a",
          scope: "isolated",
          content: "Old summary.",
          source: { kind: "history", generation: 3, threadId: "thread-a" },
        },
        ctx,
      ),
    ).rejects.toThrow(/retired/);
    expect(f.db.semanticFact.create).not.toHaveBeenCalled();
  });

  it("applies archive changes from host-verified text and skips an exact-content repeat", async () => {
    const f = fixture();
    const sources = new Map([
      [
        "message-a",
        {
          messageId: "message-a",
          threadId: "thread-a",
          text: "Please use a narrow console. Also prefer dark mode.",
          observedAt: time,
        },
      ],
      [
        "message-b",
        {
          messageId: "message-b",
          threadId: "thread-a",
          text: "Prefer a narrow console.",
          observedAt: time,
        },
      ],
    ]);
    const result = await f.store.applyArchiveChanges(
      f.db as never,
      {
        botId: "bot-a",
        scope: "isolated",
        threadId: "thread-a",
        sources,
        changes: [
          {
            content: "Prefer dark mode.",
            sourceMessageId: "message-a",
            sourceQuote: "prefer dark mode",
            category: "preference",
          },
          {
            content: "Prefer dark mode.",
            sourceMessageId: "message-b",
            sourceQuote: "Prefer a narrow console",
            category: "preference",
          },
          {
            content: "Prefer a wide console.",
            sourceMessageId: "message-a",
            sourceQuote: "invented quote",
            category: "preference",
          },
        ],
      },
      ctx,
    );
    expect(result).toEqual({ saved: 1, updated: 0, skipped: 2 });
    expect(f.revisions).toHaveLength(1);
    expect(JSON.parse(f.rows[0]!.provenance)).toMatchObject({
      kind: "run",
      threadId: "thread-a",
      messageId: "message-a",
      quote: "prefer dark mode",
      category: "preference",
      observedAt: time.toISOString(),
    });
    expect([...f.outbox.values()].map((work) => work.action)).toEqual(["upsert"]);
  });

  it("keeps an archived source quotation retired when a retry paraphrases the fact", async () => {
    const f = fixture();
    const input = {
      botId: "bot-a",
      scope: "isolated" as const,
      threadId: "thread-a",
      sources: new Map([
        [
          "message-a",
          {
            messageId: "message-a",
            threadId: "thread-a",
            text: "Always use dark mode.",
            observedAt: time,
          },
        ],
      ]),
      changes: [
        {
          content: "Prefer dark mode.",
          sourceMessageId: "message-a",
          sourceQuote: "Always use dark mode",
          category: "preference" as const,
        },
      ],
    };
    await f.store.applyArchiveChanges(f.db as never, input, ctx);
    f.rows[0]!.status = "forgotten";
    const replay = await f.store.applyArchiveChanges(
      f.db as never,
      {
        ...input,
        changes: [{ ...input.changes[0]!, content: "The user prefers a dark interface." }],
      },
      ctx,
    );
    expect(replay).toEqual({ saved: 0, updated: 0, skipped: 1 });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.status).toBe("forgotten");
  });

  it("refuses archive writes in a retired scope without creating or updating facts", async () => {
    const f = fixture([record()]);
    f.retired.push({ id: "scope-retired" });
    const result = await f.store.applyArchiveChanges(
      f.db as never,
      {
        botId: "bot-a",
        scope: "isolated",
        threadId: "thread-a",
        sources: new Map([
          [
            "message-a",
            {
              messageId: "message-a",
              threadId: "thread-a",
              text: "Change the console size.",
              observedAt: time,
            },
          ],
        ]),
        changes: [
          {
            content: "Use a wide console.",
            sourceMessageId: "message-a",
            sourceQuote: "Change the console size",
            category: "preference",
            replacesId: "fact-a",
            expectedRevision: 1,
          },
        ],
      },
      ctx,
    );
    expect(result).toEqual({ saved: 0, updated: 0, skipped: 1 });
    expect(f.db.semanticFact.create).not.toHaveBeenCalled();
    expect(f.db.semanticFact.update).not.toHaveBeenCalled();
  });
});
