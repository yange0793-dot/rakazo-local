import type { AdapterContext, MemorySourceFact } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticFact as FactRecord, PrismaClient } from "./generated/prisma/client.js";
import { IsolationError } from "./scope.js";
import { lessonFactNamespace, SemanticFactStore, semanticFactNamespace } from "./semantic-facts.js";

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

/** Enough of Prisma's `where` for the queries these tests drive. */
function matchesWhere(row: FactRecord, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND" && Array.isArray(value))
      return value.every((part) => matchesWhere(row, part as Record<string, unknown>));
    if (key === "OR" && Array.isArray(value))
      return value.some((part) => matchesWhere(row, part as Record<string, unknown>));
    const own = row[key as keyof FactRecord];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const filter = value as { in?: unknown[]; not?: unknown };
      if ("in" in filter) return (filter.in ?? []).includes(own);
      if ("not" in filter) return own !== filter.not;
      return true;
    }
    return own === value;
  });
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
    findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
      args?.where ? rows.filter((row) => matchesWhere(row, args.where!)) : rows,
    ),
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
    spaceMember: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "membership" })),
    },
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
        id: "run-a",
        threadId: "thread-a",
        thread: { historyCompactionGeneration: 3 },
        sourceMessageId: "message-a" as string | null,
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
      deleteMany: vi.fn(async ({ where }: { where: { factId?: string } }) => {
        const before = revisions.length;
        for (let index = revisions.length - 1; index >= 0; index -= 1)
          if (revisions[index]!.factId === where.factId) revisions.splice(index, 1);
        return { count: before - revisions.length };
      }),
    },
    semanticMemoryRetirement: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          retired.find((row) => matchesWhere(row as unknown as FactRecord, where)) ?? null,
      ),
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
      findMany: vi.fn(
        async (args?: { where?: { spaceId?: string | { in?: string[] } }; take?: number }) => {
          let rows = [...outbox.values()];
          const spaceId = args?.where?.spaceId;
          if (typeof spaceId === "string") rows = rows.filter((row) => row.spaceId === spaceId);
          else if (spaceId?.in)
            rows = rows.filter((row) => spaceId.in!.includes(String(row.spaceId)));
          return args?.take ? rows.slice(0, args.take) : rows;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => ({
        count: Number(outbox.delete(where.id)),
      })),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) =>
      fn(db),
    ),
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
    rows,
    outbox,
    sources,
    revisions,
    retired,
    store: new SemanticFactStore(db as unknown as PrismaClient),
  };
}

describe("managed semantic fact authority", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  });

  const dependency: MemorySourceFact = {
    id: "fact-a",
    revision: 1,
    botId: "bot-a",
    kind: "durable",
    scope: "isolated",
  };
  const derivedLesson = (sources: MemorySourceFact[] = [dependency]) => ({
    botId: "bot-a",
    cue: "Working with the console",
    lesson: "Keep the console narrow.",
    provenance: {
      kind: "run" as const,
      runId: "run-a",
      derivedFrom: sources,
      harness: {
        domainKey: "files",
        signals: ["tool_error"],
        autoApplied: true,
        evidence: { kind: "tool_error" as const, quote: "Console failed." },
      },
    },
  });

  it.each(["correct", "forget"] as const)(
    "removes an automatically derived lesson from recall, exact reads, current lists and index publication after source %s",
    async (action) => {
      const f = fixture([record()]);
      const saved = (await f.store.saveLesson(derivedLesson(), ctx))!;
      const request = {
        id: saved.id,
        expectedRevision: 1,
        botId: "bot-a",
        scope: "isolated" as const,
        kind: "lesson" as const,
      };
      await expect(f.store.read(request, ctx)).resolves.toMatchObject({ id: saved.id });
      if (action === "correct")
        await f.store.correct(
          {
            id: "fact-a",
            botId: "bot-a",
            scope: "isolated",
            expectedRevision: 1,
            content: "Use a wide console.",
          },
          ctx,
        );
      else
        await f.store.forget(
          { id: "fact-a", botId: "bot-a", scope: "isolated", expectedRevision: 1 },
          ctx,
        );
      await expect(f.store.read(request, ctx)).rejects.toBeInstanceOf(IsolationError);
      expect(
        await f.store.resolveCandidates(
          { botId: "bot-a", scope: "isolated", kind: "lesson", query: "console", limit: 5 },
          [{ id: saved.id, revision: 1, score: 1 }],
          ctx,
        ),
      ).toEqual([]);
      expect(
        (await f.store.list({ botId: "bot-a", scope: "isolated", kind: "lesson" }, ctx)).items,
      ).toEqual([]);
      expect(
        (
          await f.store.list(
            { botId: "bot-a", scope: "isolated", kind: "lesson", includeHistory: true },
            ctx,
          )
        ).items,
      ).toHaveLength(1);
      expect(await f.store.getIndexWork(`sm-upsert:${saved.id}:1`)).toMatchObject({
        action: "delete",
        content: null,
      });
      expect(f.rows.find((row) => row.id === saved.id)).toMatchObject({
        status: "active",
        revision: 1,
      });
    },
  );

  it("retains manually corrected lesson text after its former source is forgotten", async () => {
    const f = fixture([record()]);
    const saved = (await f.store.saveLesson(derivedLesson(), ctx))!;
    const manual = await f.store.correct(
      {
        id: saved.id,
        botId: "bot-a",
        scope: "isolated",
        kind: "lesson",
        expectedRevision: 1,
        content: "My personal note.",
      },
      ctx,
    );
    expect(manual.provenance.derivedFrom).toBeUndefined();
    await f.store.forget(
      { id: "fact-a", botId: "bot-a", scope: "isolated", expectedRevision: 1 },
      ctx,
    );
    await expect(
      f.store.read(
        { id: saved.id, expectedRevision: 2, botId: "bot-a", scope: "isolated", kind: "lesson" },
        ctx,
      ),
    ).resolves.toMatchObject({ memory: "My personal note." });
  });

  it("keeps upstream sources when the host refines an existing derived lesson", async () => {
    const f = fixture([record()]);
    const saved = (await f.store.saveLesson(derivedLesson(), ctx))!;
    const { derivedFrom: _derivedFrom, ...provenance } = derivedLesson().provenance;
    const request = {
      ...derivedLesson(),
      lesson: "Check the console width first.",
      provenance,
      replaces: { id: saved.id, expectedRevision: 1 },
    };
    const refined = await f.store.saveLesson(request, ctx);
    expect(refined?.provenance.derivedFrom).toEqual([dependency]);
    await expect(f.store.saveLesson(request, ctx)).resolves.toMatchObject({
      id: saved.id,
      revision: 2,
    });
    await f.store.forget(
      { id: "fact-a", botId: "bot-a", scope: "isolated", expectedRevision: 1 },
      ctx,
    );
    await expect(
      f.store.read(
        {
          id: saved.id,
          expectedRevision: 2,
          botId: "bot-a",
          scope: "isolated",
          kind: "lesson",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  });
  it("tracks upstream revisions when deriving from a lesson and hides descendants after retirement", async () => {
    const f = fixture([record()]);
    const parent = (await f.store.saveLesson(derivedLesson(), ctx))!;
    const child = (await f.store.saveLesson(
      {
        ...derivedLesson([{ ...dependency, id: parent.id, kind: "lesson" }]),
        lesson: "Check width before rendering.",
      },
      ctx,
    ))!;
    expect(child.provenance.derivedFrom).toEqual(
      [{ ...dependency, id: parent.id, kind: "lesson" }, dependency].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    await f.store.retireLesson(parent.id, ctx);
    await expect(
      f.store.read(
        { id: child.id, expectedRevision: 1, botId: "bot-a", scope: "isolated", kind: "lesson" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(f.rows.find((row) => row.id === child.id)?.status).toBe("active");
  });

  it("checks source history generations, validity, retirement fences and reader scope", async () => {
    const f = fixture([
      record(),
      record({ id: "history-a", kind: "history", sourceThreadId: "thread-a", sourceGeneration: 3 }),
      record({ id: "other-space", spaceId: "space-b" }),
      record({
        id: "other-bot",
        botId: "bot-b",
        namespace: semanticFactNamespace(ctx.spaceId, "isolated", "bot-b"),
      }),
      record({ id: "expired", validTo: new Date("2000-01-01") }),
    ]);
    const history: MemorySourceFact = {
      ...dependency,
      id: "history-a",
      kind: "history",
      threadId: "thread-a",
      historyGeneration: 3,
    };
    await expect(f.store.derivationSources([history], ctx)).resolves.toEqual([history]);
    f.db.thread.findFirst.mockResolvedValueOnce({
      botId: "bot-a",
      groupId: null,
      externalConversationId: null,
      historyCompactionGeneration: 4,
    });
    await expect(f.store.derivationSources([history], ctx)).resolves.toBeNull();
    for (const source of [
      { ...dependency, revision: 2 },
      { ...dependency, id: "other-space" },
      { ...dependency, id: "other-bot", botId: "bot-b" },
      { ...dependency, id: "expired" },
    ]) {
      await expect(f.store.saveLesson(derivedLesson([source]), ctx)).rejects.toThrow(/source/);
    }
    expect(f.db.semanticFact.create).not.toHaveBeenCalled();
    f.retired.push({ namespace, kind: "scope" });
    await expect(f.store.derivationSources([dependency], ctx)).resolves.toBeNull();
  });

  it("does not let a stale source or self-replacement be published as a new lesson", async () => {
    const f = fixture([record()]);
    const saved = (await f.store.saveLesson(derivedLesson(), ctx))!;
    await expect(
      f.store.saveLesson(
        {
          ...derivedLesson([{ ...dependency, id: saved.id, kind: "lesson" }]),
          replaces: { id: saved.id, expectedRevision: 1 },
        },
        ctx,
      ),
    ).rejects.toThrow(/own previous revision/);
    await f.store.correct(
      {
        id: "fact-a",
        botId: "bot-a",
        scope: "isolated",
        expectedRevision: 1,
        content: "Wide console.",
      },
      ctx,
    );
    await expect(f.store.saveLesson(derivedLesson(), ctx)).rejects.toThrow(/source/);
    const current = await f.store.saveLesson(derivedLesson([{ ...dependency, revision: 2 }]), ctx);
    expect(current?.id).not.toBe(saved.id);
  });

  it("filters obsolete candidates before the recall limit and leaves untracked historical notes untouched", async () => {
    const f = fixture([
      record(),
      record({
        id: "derived",
        namespace: lessonFactNamespace(ctx.spaceId, "bot-a"),
        kind: "lesson",
        provenance: JSON.stringify({ kind: "run", derivedFrom: [{ ...dependency, revision: 2 }] }),
      }),
      record({
        id: "manual",
        namespace: lessonFactNamespace(ctx.spaceId, "bot-a"),
        kind: "lesson",
        content: "Legacy untracked note.",
      }),
    ]);
    expect(
      await f.store.resolveCandidates(
        { botId: "bot-a", scope: "isolated", kind: "lesson", query: "console", limit: 1 },
        [
          { id: "derived", revision: 1, score: 10 },
          { id: "manual", revision: 1, score: 1 },
        ],
        ctx,
      ),
    ).toEqual([expect.objectContaining({ id: "manual", memory: "Legacy untracked note." })]);
  });
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

  it("reads only the active cited revision inside its exact tenant, namespace, and history generation", async () => {
    const f = fixture([
      record({ content: "Current fact." }),
      record({
        id: "lesson-a",
        namespace: lessonFactNamespace(ctx.spaceId, "bot-a"),
        kind: "lesson",
        content: "cue: deployment\nlesson: check the platform.",
        revision: 4,
      }),
      record({
        id: "old-fact",
        revision: 2,
        status: "historical",
      }),
      record({ id: "forgotten-fact", status: "forgotten" }),
      record({ id: "expired-fact", validTo: new Date("2000-01-01T00:00:00Z") }),
      record({ id: "future-fact", validFrom: new Date("2999-01-01T00:00:00Z") }),
      record({
        id: "shared-fact",
        scope: "shared",
        namespace: semanticFactNamespace(ctx.spaceId, "shared", "bot-a"),
      }),
      record({
        id: "history-a",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 3,
        content: "History fact.",
      }),
      record({
        id: "foreign-tenant",
        spaceId: "space-other",
        content: "Other tenant.",
      }),
    ]);

    await expect(
      f.store.read({ id: "fact-a", expectedRevision: 1, botId: "bot-a", scope: "isolated" }, ctx),
    ).resolves.toMatchObject({ id: "fact-a", revision: 1, memory: "Current fact." });
    await expect(
      f.store.read(
        {
          id: "lesson-a",
          expectedRevision: 4,
          botId: "bot-a",
          scope: "isolated",
          kind: "lesson",
        },
        ctx,
      ),
    ).resolves.toMatchObject({
      id: "lesson-a",
      revision: 4,
      memory: expect.stringContaining("deployment"),
    });
    await expect(
      f.store.read(
        {
          id: "history-a",
          expectedRevision: 1,
          botId: "bot-a",
          scope: "isolated",
          threadId: "thread-a",
          historyGeneration: 3,
        },
        ctx,
      ),
    ).resolves.toMatchObject({ id: "history-a", revision: 1 });
    await expect(
      f.store.read(
        { id: "shared-fact", expectedRevision: 1, botId: "bot-a", scope: "shared" },
        ctx,
      ),
    ).resolves.toMatchObject({ id: "shared-fact", revision: 1 });

    for (const request of [
      { id: "fact-a", expectedRevision: 2, botId: "bot-a", scope: "isolated" as const },
      { id: "fact-a", expectedRevision: 1, botId: "bot-a", scope: "shared" as const },
      { id: "old-fact", expectedRevision: 2, botId: "bot-a", scope: "isolated" as const },
      { id: "forgotten-fact", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      { id: "expired-fact", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      { id: "future-fact", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      { id: "shared-fact", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      { id: "lesson-a", expectedRevision: 4, botId: "bot-a", scope: "isolated" as const },
      { id: "fact-a", expectedRevision: 1, botId: "bot-other", scope: "isolated" as const },
      { id: "foreign-tenant", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      { id: "history-a", expectedRevision: 1, botId: "bot-a", scope: "isolated" as const },
      {
        id: "history-a",
        expectedRevision: 1,
        botId: "bot-a",
        scope: "isolated" as const,
        threadId: "thread-other",
        historyGeneration: 3,
      },
      {
        id: "history-a",
        expectedRevision: 1,
        botId: "bot-a",
        scope: "isolated" as const,
        threadId: "thread-a",
        historyGeneration: 2,
      },
    ]) {
      await expect(f.store.read(request, ctx)).rejects.toBeInstanceOf(IsolationError);
    }
    await expect(
      f.store.read(
        {
          id: "lesson-a",
          expectedRevision: 4,
          botId: "bot-a",
          scope: "shared",
          kind: "lesson",
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(f.db.semanticFact.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["fact-a"] },
        spaceId: "space-a",
        namespace,
        status: "active",
      },
    });
  });

  it("rechecks membership and the persisted history generation on an exact read", async () => {
    const f = fixture([
      record({
        id: "history-a",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 3,
      }),
    ]);
    const request = {
      id: "history-a",
      expectedRevision: 1,
      botId: "bot-a",
      scope: "isolated" as const,
      threadId: "thread-a",
      historyGeneration: 3,
    };
    await expect(f.store.read(request, ctx)).resolves.toMatchObject({ id: "history-a" });
    f.db.thread.findFirst.mockResolvedValueOnce({
      botId: "bot-a",
      groupId: null,
      externalConversationId: null,
      historyCompactionGeneration: 4,
    });
    await expect(f.store.read(request, ctx)).rejects.toBeInstanceOf(IsolationError);
    f.db.spaceMember.findFirst.mockResolvedValueOnce(null);
    await expect(f.store.read(request, ctx)).rejects.toBeInstanceOf(IsolationError);
  });

  it("filters eligible spaces before applying the bounded pending-index limit", async () => {
    const f = fixture();
    for (let index = 1; index <= 100; index += 1) {
      f.outbox.set(`work-${index}`, {
        id: `work-${index}`,
        spaceId: `disconnected-${index}`,
        userId: "user-a",
      });
    }
    f.outbox.set("work-101", {
      id: "work-101",
      spaceId: "connected-101",
      userId: "user-101",
    });

    await expect(f.store.pendingIndexWork(100, undefined, ["connected-101"])).resolves.toEqual([
      { id: "work-101", spaceId: "connected-101", userId: "user-101" },
    ]);
    expect(f.db.semanticMemoryIndexOutbox.findMany).toHaveBeenCalledWith({
      where: { spaceId: { in: ["connected-101"] } },
      distinct: ["spaceId"],
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, spaceId: true, userId: true },
    });
    f.db.semanticMemoryIndexOutbox.findMany.mockClear();
    await expect(f.store.pendingIndexWork(100, undefined, [])).resolves.toEqual([]);
    await expect(
      f.store.pendingIndexWork(100, "disconnected-1", ["connected-101"]),
    ).resolves.toEqual([]);
    expect(f.db.semanticMemoryIndexOutbox.findMany).not.toHaveBeenCalled();
    await expect(f.store.pendingIndexWork(1, "connected-101")).resolves.toEqual([
      { id: "work-101", spaceId: "connected-101", userId: "user-101" },
    ]);
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
      content: "[forgotten]",
    });
    expect(f.db.semanticFact.create).toHaveBeenCalledTimes(1);
    expect(f.revisions.map((row) => [row.status, row.content])).toEqual([
      ["forgotten", "[forgotten]"],
    ]);
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
      id: "run-a",
      threadId: "thread-a",
      thread: { historyCompactionGeneration: 3 },
      sourceMessageId: "message-a",
      trigger: "helper",
      status: "running",
    });
    await expect(f.store.save(request, runContext)).rejects.toBeInstanceOf(IsolationError);
  });

  it("retains routine run attribution without granting a user quote or helper writes", async () => {
    const f = fixture();
    f.db.run.findFirst.mockResolvedValue({
      id: "routine-run",
      threadId: "thread-a",
      thread: { historyCompactionGeneration: 3 },
      sourceMessageId: null,
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
    expect(saved.provenance.quote).toBeUndefined();
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
    f.retired.push({
      id: "retired",
      namespace,
      kind: "history",
      botId: "bot-a",
      threadId: "thread-a",
      generation: 3,
    });
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
    expect(result).toEqual({ saved: 1, updated: 0, removed: 0, skipped: 2 });
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
    await expect(
      f.store.applyArchiveChanges(
        f.db as never,
        {
          botId: "bot-a",
          scope: "isolated",
          threadId: "thread-a",
          sources,
          changes: [
            {
              content: "Use a narrow console.",
              sourceMessageId: "message-b",
              sourceQuote: "Prefer a narrow console",
              category: "preference",
            },
          ],
        },
        ctx,
      ),
    ).resolves.toMatchObject({ saved: 0, skipped: 1 });
    expect(f.rows).toHaveLength(1);
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
    expect(replay).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.status).toBe("forgotten");
  });

  it("refuses archive writes in a retired scope without creating or updating facts", async () => {
    const f = fixture([record()]);
    f.retired.push({ id: "scope-retired", namespace, kind: "scope" });
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
    expect(result).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(f.db.semanticFact.create).not.toHaveBeenCalled();
    expect(f.db.semanticFact.update).not.toHaveBeenCalled();
  });

  it("forgets the body, provenance and every revision while keeping the tombstone and source keys", async () => {
    const f = fixture();
    const saved = await f.store.save(
      {
        botId: "bot-a",
        scope: "isolated",
        content: "A private preference.",
        source: { kind: "durable" },
      },
      ctx,
    );
    f.rows[0]!.provenance = JSON.stringify({
      kind: "run",
      runId: "run-private",
      threadId: "thread-private",
      messageId: "message-private",
      quote: "private source quote",
      category: "preference",
      observedAt: time.toISOString(),
    });
    const sourceKeys = [...f.sources.keys()];
    const forgotten = await f.store.forget(
      { id: saved.id, botId: "bot-a", scope: "isolated", expectedRevision: 1 },
      ctx,
    );
    expect(forgotten).toEqual({ id: saved.id, expired: true, reason: null });
    expect(f.rows[0]).toMatchObject({
      status: "forgotten",
      revision: 2,
      content: "[forgotten]",
    });
    expect(JSON.parse(f.rows[0]!.provenance)).toMatchObject({ kind: "run" });
    expect(f.rows[0]!.provenance).not.toContain("run-private");
    expect(f.rows[0]!.provenance).not.toContain("thread-private");
    expect(f.rows[0]!.provenance).not.toContain("message-private");
    expect(f.rows[0]!.provenance).not.toContain("private source quote");
    expect(f.rows[0]!.provenance).not.toContain("preference");
    expect(f.revisions.map((row) => [row.revision, row.status, row.content])).toEqual([
      [2, "forgotten", "[forgotten]"],
    ]);
    expect([...f.sources.keys()]).toEqual(sourceKeys);
    expect([...f.outbox.values()].map((work) => [work.revision, work.action])).toEqual([
      [1, "upsert"],
      [1, "delete"],
      [2, "delete"],
    ]);
  });

  it("treats a repeated forget as already done but rejects a different revision", async () => {
    const f = fixture();
    const saved = await f.store.save(
      { botId: "bot-a", scope: "isolated", content: "A fact.", source: { kind: "durable" } },
      ctx,
    );
    const request = {
      id: saved.id,
      botId: "bot-a",
      scope: "isolated" as const,
      expectedRevision: 1,
    };
    await f.store.forget(request, ctx);
    await expect(f.store.forget(request, ctx)).resolves.toEqual({
      id: saved.id,
      expired: true,
      reason: null,
    });
    expect(f.rows[0]!.revision).toBe(2);
    await expect(f.store.forget({ ...request, expectedRevision: 9 }, ctx)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
  });

  it("scrubs legacy forgotten provenance and revisions on an idempotent retry", async () => {
    const f = fixture();
    const saved = await f.store.save(
      {
        botId: "bot-a",
        scope: "isolated",
        content: "A private fact.",
        source: { kind: "durable" },
      },
      ctx,
    );
    const request = {
      id: saved.id,
      botId: "bot-a",
      scope: "isolated" as const,
      expectedRevision: 1,
    };
    await f.store.forget(request, ctx);
    f.rows[0]!.provenance = JSON.stringify({
      kind: "user",
      quote: "legacy private quote",
      messageId: "legacy-message",
      category: "preference",
      observedAt: time.toISOString(),
    });
    f.revisions.push({
      factId: saved.id,
      revision: 1,
      content: "A private fact.",
      provenance: "legacy private quote",
    });

    await expect(f.store.forget(request, ctx)).resolves.toEqual({
      id: saved.id,
      expired: true,
      reason: null,
    });
    expect(f.rows[0]).toMatchObject({
      status: "forgotten",
      revision: 2,
      content: "[forgotten]",
    });
    expect(f.rows[0]!.provenance).not.toContain("legacy private quote");
    expect(f.rows[0]!.provenance).not.toContain("legacy-message");
    expect(f.rows[0]!.provenance).not.toContain("preference");
    expect(f.revisions).toEqual([
      expect.objectContaining({
        factId: saved.id,
        revision: 2,
        content: "[forgotten]",
        status: "forgotten",
      }),
    ]);
  });

  it("requires an expected revision even when the caller has a run id", async () => {
    const f = fixture();
    await expect(
      f.store.forget(
        { id: "fact-a", botId: "bot-a", scope: "isolated" },
        { ...ctx, runId: "run-a" },
      ),
    ).rejects.toThrow("Forgetting a managed fact requires its expected revision.");
  });

  it("lets a correction restore content an earlier revision or a forgotten fact used", async () => {
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
            text: "Use a narrow console. Change it. Actually keep the narrow console.",
            observedAt: time,
          },
        ],
      ]),
    };
    const changes = [
      {
        content: "Use a narrow console.",
        sourceMessageId: "message-a",
        sourceQuote: "Use a narrow console",
        category: "preference" as const,
      },
      {
        content: "Use a wide console.",
        sourceMessageId: "message-a",
        sourceQuote: "Change it",
        category: "preference" as const,
        replacesId: "fact-1",
        expectedRevision: 1,
      },
      {
        content: "Use a narrow console.",
        sourceMessageId: "message-a",
        sourceQuote: "keep the narrow console",
        category: "preference" as const,
        replacesId: "fact-1",
        expectedRevision: 2,
      },
    ];
    expect(
      await f.store.applyArchiveChanges(f.db as never, { ...input, changes: [changes[0]!] }, ctx),
    ).toEqual({ saved: 1, updated: 0, removed: 0, skipped: 0 });
    expect(
      await f.store.applyArchiveChanges(f.db as never, { ...input, changes: [changes[1]!] }, ctx),
    ).toEqual({ saved: 0, updated: 1, removed: 0, skipped: 0 });
    expect(
      await f.store.applyArchiveChanges(f.db as never, { ...input, changes: [changes[2]!] }, ctx),
    ).toEqual({ saved: 0, updated: 1, removed: 0, skipped: 0 });
    expect(f.rows[0]).toMatchObject({
      content: "Use a narrow console.",
      revision: 3,
      status: "active",
    });
  });

  it("deduplicates an archived fact whose wording differs only by case, width and punctuation", async () => {
    const f = fixture();
    const sources = new Map([
      [
        "message-a",
        {
          messageId: "message-a",
          threadId: "thread-a",
          text: "Prefer dark mode. Prefer  DARK mode.",
          observedAt: time,
        },
      ],
    ]);
    const base = {
      sourceMessageId: "message-a",
      category: "preference" as const,
    };
    expect(
      await f.store.applyArchiveChanges(
        f.db as never,
        {
          botId: "bot-a",
          scope: "isolated",
          threadId: "thread-a",
          sources,
          changes: [{ ...base, content: "Prefer dark mode.", sourceQuote: "Prefer dark mode" }],
        },
        ctx,
      ),
    ).toEqual({ saved: 1, updated: 0, removed: 0, skipped: 0 });
    expect(
      await f.store.applyArchiveChanges(
        f.db as never,
        {
          botId: "bot-a",
          scope: "isolated",
          threadId: "thread-a",
          sources,
          changes: [{ ...base, content: "prefer  DARK mode", sourceQuote: "Prefer  DARK mode" }],
        },
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(f.rows).toHaveLength(1);
  });

  it("logs a correction it had to drop instead of discarding it silently", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const f = fixture([record()]);
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
              text: "Change the console.",
              observedAt: time,
            },
          ],
        ]),
        changes: [
          {
            content: "Use a wide console.",
            sourceMessageId: "message-a",
            sourceQuote: "Change the console",
            category: "preference",
            replacesId: "fact-a",
            expectedRevision: 7,
          },
        ],
      },
      ctx,
    );
    expect(result).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    const logged = sink.events.find(
      (event) => event.message === "memory archive correction skipped",
    );
    expect(logged).toMatchObject({
      "memory.fact_id": "fact-a",
      "memory.reason": "revision_changed",
    });
  });

  it("forgets or corrects a fact under the namespace its recall citation named", async () => {
    const shared = semanticFactNamespace(ctx.spaceId, "shared", "bot-a");
    const forgotten = fixture([record({ id: "shared-fact", namespace: shared, scope: "shared" })]);
    await forgotten.store.forget(
      {
        id: "shared-fact",
        botId: "bot-a",
        scope: "isolated",
        entity: shared,
        expectedRevision: 1,
      },
      ctx,
    );
    expect(forgotten.rows[0]).toMatchObject({ status: "forgotten", revision: 2 });

    const corrected = fixture([record({ id: "shared-fact", namespace: shared, scope: "shared" })]);
    expect(
      await corrected.store.save(
        {
          botId: "bot-a",
          scope: "isolated",
          entity: shared,
          replacesId: "shared-fact",
          expectedRevision: 1,
          content: "Corrected shared fact.",
          source: { kind: "durable" },
        },
        ctx,
      ),
    ).toMatchObject({ id: "shared-fact", revision: 2, content: "Corrected shared fact." });
  });

  it("refuses a citation namespace this bot could not have read", async () => {
    const foreign = semanticFactNamespace(ctx.spaceId, "isolated", "bot-b");
    const f = fixture([record({ id: "peer-fact", namespace: foreign, botId: "bot-b" })]);
    await expect(
      f.store.forget(
        {
          id: "peer-fact",
          botId: "bot-a",
          scope: "isolated",
          entity: foreign,
          expectedRevision: 1,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      f.store.save(
        {
          botId: "bot-a",
          scope: "isolated",
          entity: foreign,
          replacesId: "peer-fact",
          expectedRevision: 1,
          content: "Stolen.",
          source: { kind: "durable" },
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      f.store.save(
        {
          botId: "bot-a",
          scope: "isolated",
          entity: semanticFactNamespace(ctx.spaceId, "shared", "bot-a"),
          content: "No correction target.",
          source: { kind: "durable" },
        },
        ctx,
      ),
    ).rejects.toThrow(/correction/);
    expect(f.rows[0]!.status).toBe("active");
  });

  it("gives bulk retirement and purge enough time for a large scope", async () => {
    const shared = semanticFactNamespace(ctx.spaceId, "shared", "bot-a");
    const f = fixture([
      record(),
      record({
        id: "shared-history",
        namespace: shared,
        scope: "shared",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 3,
      }),
    ]);
    await f.store.retireScope({ spaceId: ctx.spaceId, botId: "bot-a" }, ctx);
    await f.store.purgeHistory({ botId: "bot-a", threadId: "thread-a", generations: [3] }, ctx);
    expect(f.db.$transaction).toHaveBeenCalledTimes(2);
    for (const call of f.db.$transaction.mock.calls)
      expect(call[1]).toMatchObject({ timeout: 120_000 });
  });

  it("retires a deleted bot's shared history facts but keeps its shared durable ones", async () => {
    const shared = semanticFactNamespace(ctx.spaceId, "shared", "bot-a");
    const f = fixture([
      record({ id: "isolated" }),
      record({
        id: "lesson-a",
        namespace: lessonFactNamespace(ctx.spaceId, "bot-a"),
        kind: "lesson",
      }),
      record({ id: "shared-durable", namespace: shared, scope: "shared" }),
      record({
        id: "shared-history",
        namespace: shared,
        scope: "shared",
        kind: "history",
        sourceThreadId: "thread-a",
        sourceGeneration: 3,
      }),
      record({
        id: "peer-shared-history",
        namespace: shared,
        scope: "shared",
        botId: "bot-b",
        kind: "history",
        sourceThreadId: "thread-b",
        sourceGeneration: 3,
      }),
    ]);
    await f.store.retireScope({ spaceId: ctx.spaceId, botId: "bot-a" }, ctx);
    expect(f.rows.map((row) => [row.id, row.status])).toEqual([
      ["isolated", "forgotten"],
      ["lesson-a", "forgotten"],
      ["shared-durable", "active"],
      ["shared-history", "forgotten"],
      ["peer-shared-history", "active"],
    ]);
    expect([...f.outbox.keys()]).toEqual(
      expect.arrayContaining(["sm-delete:shared-history:1", "sm-delete:shared-history:2"]),
    );
  });

  it("writes host lessons into a per-bot namespace with run authorization and content dedupe", async () => {
    const f = fixture();
    const input = {
      botId: "bot-a",
      cue: "A command fails with ENOENT",
      lesson: "Check the working directory before retrying.",
      provenance: {
        kind: "run" as const,
        runId: "run-a",
        threadId: "thread-a",
        observedAt: time.toISOString(),
        harness: {
          domainKey: "files",
          signals: ["tool_error"],
          autoApplied: false,
          evidence: { kind: "tool_error" as const, quote: "ENOENT" },
        },
      },
    };
    expect(lessonFactNamespace(ctx.spaceId, "bot-a")).not.toBe(namespace);
    const saved = await f.store.saveLesson(input, ctx);
    expect(saved).toMatchObject({
      kind: "lesson",
      scope: "isolated",
      content:
        "cue: A command fails with ENOENT\nlesson: Check the working directory before retrying.",
      revision: 1,
      status: "active",
    });
    expect(saved!.provenance.harness).toMatchObject({ domainKey: "files", autoApplied: false });
    expect(f.rows[0]!.namespace).toBe(lessonFactNamespace(ctx.spaceId, "bot-a"));
    // Any space member may confirm a card; the cited run only has to belong to this bot.
    expect(f.db.run.findFirst).toHaveBeenCalledWith({
      where: { id: "run-a", spaceId: ctx.spaceId, botId: "bot-a" },
      select: { id: true },
    });
    expect([...f.outbox.values()].map((work) => [work.revision, work.action])).toEqual([
      [1, "upsert"],
    ]);
    await expect(f.store.saveLesson(input, ctx)).resolves.toMatchObject({ id: saved!.id });
    await expect(
      f.store.saveLesson({ ...input, provenance: { ...input.provenance, runId: "run-b" } }, ctx),
    ).resolves.toMatchObject({ id: saved!.id });
    expect(f.db.semanticFact.create).toHaveBeenCalledTimes(1);
  });

  it("updates a lesson only at its observed revision and drops a stale replacement", async () => {
    const f = fixture();
    const input = {
      botId: "bot-a",
      cue: "A command fails",
      lesson: "Retry after checking the directory.",
      provenance: {
        kind: "run" as const,
        runId: "run-a",
        observedAt: time.toISOString(),
        harness: {
          domainKey: "files",
          signals: ["run_failed"],
          autoApplied: true,
          evidence: { kind: "run_failed" as const, quote: "ENOENT" },
        },
      },
    };
    const saved = await f.store.saveLesson(input, ctx);
    const replaced = await f.store.saveLesson(
      {
        ...input,
        lesson: "Check the directory before retrying.",
        replaces: { id: saved!.id, expectedRevision: 1 },
      },
      ctx,
    );
    expect(replaced).toMatchObject({ id: saved!.id, revision: 2, status: "active" });
    expect(replaced!.content).toContain("Check the directory before retrying.");
    await expect(
      f.store.saveLesson(
        {
          ...input,
          lesson: "Stale edit.",
          replaces: { id: saved!.id, expectedRevision: 1 },
        },
        ctx,
      ),
    ).resolves.toBeNull();
    expect(f.rows[0]).toMatchObject({ revision: 2, status: "active" });
  });

  it("retires a lesson to historical and deindexes it, leaving other kinds alone", async () => {
    const f = fixture([
      record({
        id: "lesson-a",
        namespace: lessonFactNamespace(ctx.spaceId, "bot-a"),
        kind: "lesson",
      }),
    ]);
    await f.store.retireLesson("lesson-a", ctx);
    expect(f.rows[0]).toMatchObject({ status: "historical", revision: 2 });
    expect([...f.outbox.values()].map((work) => [work.revision, work.action])).toEqual([
      [1, "delete"],
      [2, "delete"],
    ]);
    await f.store.retireLesson("lesson-a", ctx);
    expect(f.rows[0]!.revision).toBe(2);
    const durable = fixture([record()]);
    await durable.store.retireLesson("fact-a", ctx);
    expect(durable.rows[0]!.status).toBe("active");
  });

  it("lists, corrects and forgets lessons only from the lesson namespace", async () => {
    const lessons = lessonFactNamespace(ctx.spaceId, "bot-a");
    const f = fixture([
      record({ id: "durable-1" }),
      record({ id: "lesson-1", namespace: lessons, kind: "lesson", content: "cue: A\nlesson: B" }),
    ]);
    const page = await f.store.list({ botId: "bot-a", scope: "isolated", kind: "lesson" }, ctx);
    expect(page.items.map((item) => item.id)).toEqual(["lesson-1"]);
    const facts = await f.store.list({ botId: "bot-a", scope: "isolated" }, ctx);
    expect(facts.items.map((item) => item.id)).toEqual(["durable-1"]);
    const recalled = await f.store.resolveCandidates(
      { query: "x", scope: "isolated", botId: "bot-a", limit: 5, kind: "lesson" },
      [{ id: "lesson-1", revision: 1, score: 1 }],
      ctx,
    );
    expect(recalled.map((item) => item.id)).toEqual(["lesson-1"]);
    expect(
      await f.store.resolveCandidates(
        { query: "x", scope: "isolated", botId: "bot-a", limit: 5 },
        [{ id: "lesson-1", revision: 1, score: 1 }],
        ctx,
      ),
    ).toEqual([]);
    await expect(
      f.store.correct(
        {
          id: "lesson-1",
          botId: "bot-a",
          scope: "isolated",
          kind: "lesson",
          content: "cue: A\nlesson: C",
          expectedRevision: 1,
        },
        ctx,
      ),
    ).resolves.toMatchObject({ revision: 2, content: "cue: A\nlesson: C" });
    await expect(
      f.store.forget(
        {
          id: "lesson-1",
          botId: "bot-a",
          scope: "isolated",
          kind: "lesson",
          expectedRevision: 2,
        },
        ctx,
      ),
    ).resolves.toMatchObject({ id: "lesson-1", expired: true });
    expect(f.rows[1]).toMatchObject({ status: "forgotten", revision: 3 });
  });

  it("removes an archived fact from a verifiable quote and its observed revision only", async () => {
    const sources = new Map([
      [
        "message-a",
        {
          messageId: "message-a",
          threadId: "thread-a",
          text: "Forget the console preference.",
          observedAt: time,
        },
      ],
    ]);
    const removal = {
      content: "",
      sourceMessageId: "message-a",
      sourceQuote: "Forget the console preference",
      category: "preference" as const,
      remove: true as const,
      replacesId: "fact-a",
      expectedRevision: 1,
    };
    const input = {
      botId: "bot-a",
      scope: "isolated" as const,
      threadId: "thread-a",
      sources,
    };
    const f = fixture([record()]);
    expect(
      await f.store.applyArchiveChanges(f.db as never, { ...input, changes: [removal] }, ctx),
    ).toEqual({ saved: 0, updated: 0, removed: 1, skipped: 0 });
    expect(f.rows[0]).toMatchObject({
      status: "forgotten",
      revision: 2,
      content: "[forgotten]",
    });
    // The source binding makes a replay a no-op instead of a second removal.
    expect(
      await f.store.applyArchiveChanges(f.db as never, { ...input, changes: [removal] }, ctx),
    ).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    const stale = fixture([record()]);
    expect(
      await stale.store.applyArchiveChanges(
        stale.db as never,
        { ...input, changes: [{ ...removal, expectedRevision: 7 }] },
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(stale.rows[0]!.status).toBe("active");
    // A removal names its exact target and needs the user's words.
    expect(
      await stale.store.applyArchiveChanges(
        stale.db as never,
        {
          ...input,
          changes: [{ ...removal, replacesId: undefined, expectedRevision: undefined }],
        },
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(
      await stale.store.applyArchiveChanges(
        stale.db as never,
        { ...input, changes: [{ ...removal, sourceQuote: "Never said this" }] },
        ctx,
      ),
    ).toEqual({ saved: 0, updated: 0, removed: 0, skipped: 1 });
    expect(stale.rows[0]!.status).toBe("active");
  });
});
