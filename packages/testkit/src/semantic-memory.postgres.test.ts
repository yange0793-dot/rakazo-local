import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { createAdapterContext, MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { SemanticFact } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  IsolationError,
  runAsSystem,
  runAsTenant,
  SemanticFactStore,
  semanticFactNamespace,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  LocalMemoryCandidate,
  LocalMemoryIndex,
} from "../../adapters/src/local-memory-index.js";
import {
  createManagedMemoryProvider,
  syncManagedMemoryIndex,
} from "../../adapters/src/managed-memory-provider.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describePostgres = hasDb ? describe : describe.skip;

type IndexedFact = Parameters<LocalMemoryIndex["upsert"]>[0];
type FixtureBot = { id: string; threadId: string };
type FixtureTenant = {
  actor: { spaceId: string; userId: string };
  alpha: FixtureBot;
  beta: FixtureBot;
};
type Source = Extract<SemanticMemorySaveRequest["source"], { kind: "durable" }>;

/** Candidates and delayed writes are scripted; no embeddings, HTTP or original memory data. */
class SyntheticIndex implements LocalMemoryIndex {
  readonly documents = new Map<string, IndexedFact>();
  readonly upserts: IndexedFact[] = [];
  readonly searches: Array<Parameters<LocalMemoryIndex["search"]>[0]> = [];
  private readonly replays = new Map<string, LocalMemoryCandidate[]>();
  private pause?: { entered: (input: IndexedFact) => void; resumed: Promise<void> };

  pauseNextUpsert() {
    let entered!: (input: IndexedFact) => void;
    let release!: () => void;
    const started = new Promise<IndexedFact>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { entered, resumed };
    return { started, release };
  }

  replay(namespace: string, candidates: LocalMemoryCandidate[]) {
    this.replays.set(namespace, candidates);
  }

  async search(input: Parameters<LocalMemoryIndex["search"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    this.searches.push(input);
    const candidates =
      this.replays.get(input.namespace) ??
      [...this.documents.values()]
        .filter((document) => document.namespace === input.namespace)
        .map(({ id, revision }) => ({ id, revision, score: 1 }));
    return candidates.slice(0, input.limit);
  }

  async upsert(input: IndexedFact, signal: AbortSignal) {
    signal.throwIfAborted();
    const pause = this.pause;
    this.pause = undefined;
    if (pause) {
      pause.entered(input);
      await pause.resumed;
    }
    signal.throwIfAborted();
    this.upserts.push({ ...input });
    this.documents.set(`${input.namespace}\0${input.indexId}`, { ...input });
  }

  async remove(input: Parameters<LocalMemoryIndex["remove"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    this.documents.delete(`${input.namespace}\0${input.indexId}`);
  }

  async health(signal: AbortSignal) {
    signal.throwIfAborted();
  }
}

function successfulValue<T>(response: SemanticMemoryResponse<T>): T {
  if (!response.ok) throw new Error(`${response.code ?? "ERROR"}: ${response.error}`);
  return response.value;
}

function durable(bot: FixtureBot, source: Source, content: string): SemanticMemorySaveRequest {
  return { botId: bot.id, scope: "isolated", source, content };
}

function recallRequest(
  bot: FixtureBot,
  scope: "isolated" | "shared" = "isolated",
): SemanticMemoryRecallRequest {
  return { botId: bot.id, threadId: bot.threadId, scope, query: "synthetic fact", limit: 5 };
}

function candidate(fact: SemanticFact): LocalMemoryCandidate {
  return { id: fact.id, revision: fact.revision, score: 1 };
}

describePostgres("managed semantic memory authority and local index (PostgreSQL)", () => {
  let database: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let db: PrismaClient;
  let store: SemanticFactStore;
  const stamp = randomUUID();

  beforeAll(async () => {
    database = createDb(process.env.DATABASE_URL!, {
      encryptContent: true,
      applicationName: "semantic-memory-postgres-test",
      poolMax: 8,
    });
    prisma = database.prisma;
    db = asSystem(prisma);
    store = new SemanticFactStore(prisma);
  });

  afterAll(async () => {
    await database?.prisma.$disconnect();
    await database?.pool.end();
  });

  async function tenant(label: string): Promise<FixtureTenant> {
    const userId = `semantic-user-${label}-${stamp}`;
    const organizationId = `semantic-org-${label}-${stamp}`;
    const spaceId = `semantic-space-${label}-${stamp}`;
    await db.user.create({
      data: { id: userId, name: "Synthetic Owner", email: `${userId}@rakazo.test` },
    });
    await db.organization.create({
      data: { id: organizationId, slug: organizationId, name: "Synthetic", createdAt: new Date() },
    });
    await db.member.create({
      data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: new Date() },
    });
    await db.space.create({ data: { id: spaceId, organizationId, name: "Synthetic" } });
    await db.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    async function bot(name: string): Promise<FixtureBot> {
      const created = await db.bot.create({
        data: { spaceId, userId, name, color: "ink" },
      });
      const thread = await db.thread.create({ data: { spaceId, userId, botId: created.id } });
      return { id: created.id, threadId: thread.id };
    }
    return { actor: { userId, spaceId }, alpha: await bot("Alpha"), beta: await bot("Beta") };
  }

  function context(fixture: FixtureTenant, bot = fixture.alpha): AdapterContext {
    return createAdapterContext(fixture.actor, bot.id, randomUUID());
  }

  async function source(fixture: FixtureTenant, bot: FixtureBot, text: string): Promise<Source> {
    return runAsTenant(fixture.actor, async () => {
      const message = await createThreadMessage(prisma, {
        threadId: bot.threadId,
        role: "user",
        authorUserId: fixture.actor.userId,
        blocks: [{ kind: "text", text }],
      });
      const task = await prisma.task.create({
        data: {
          ...fixture.actor,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: text,
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          ...fixture.actor,
          botId: bot.id,
          threadId: bot.threadId,
          taskId: task.id,
          sourceMessageId: message.id,
          trigger: "user",
          status: "completed",
          completedAt: new Date(),
        },
      });
      return {
        kind: "durable",
        threadId: bot.threadId,
        runId: run.id,
        messageId: message.id,
        quote: text,
      };
    });
  }

  it("binds concurrent save retries to the exact persisted source without merging other sources", async () => {
    const fixture = await tenant("source");
    const text = "SYNTHETIC_SOURCE_FACT = route-A";
    const origin = await source(fixture, fixture.alpha, text);
    const request = durable(fixture.alpha, origin, text);
    const [first, retry] = await Promise.all([
      runAsTenant(fixture.actor, () => store.save(request, context(fixture))),
      runAsTenant(fixture.actor, () => store.save(request, context(fixture))),
    ]);
    expect(retry).toMatchObject({ id: first.id, revision: 1, content: text, status: "active" });
    expect(first.provenance).toMatchObject({
      kind: "run",
      runId: origin.runId,
      messageId: origin.messageId,
      threadId: origin.threadId,
      quote: text,
    });
    expect(await db.semanticFactRevision.count({ where: { factId: first.id } })).toBe(1);
    expect(await db.semanticFactSource.count({ where: { factId: first.id } })).toBe(1);
    expect(await db.semanticMemoryIndexOutbox.count({ where: { factId: first.id } })).toBe(1);

    const otherOrigin = await source(fixture, fixture.alpha, text);
    const other = await runAsTenant(fixture.actor, () =>
      store.save(durable(fixture.alpha, otherOrigin, text), context(fixture)),
    );
    expect(other.id).not.toBe(first.id);
    expect(other.provenance.messageId).toBe(otherOrigin.messageId);
  });

  it("commits only one competing correction and preserves source retry identities across revisions", async () => {
    const fixture = await tenant("correction");
    const original = "SYNTHETIC_CORRECTION = version-1";
    const origin = await source(fixture, fixture.alpha, original);
    const request = durable(fixture.alpha, origin, original);
    const first = await runAsTenant(fixture.actor, () => store.save(request, context(fixture)));
    const corrections = await Promise.allSettled(
      ["version-2-A", "version-2-B"].map((content) =>
        runAsTenant(fixture.actor, () =>
          store.correct(
            {
              id: first.id,
              botId: fixture.alpha.id,
              scope: "isolated",
              content,
              expectedRevision: 1,
            },
            context(fixture),
          ),
        ),
      ),
    );
    const accepted = corrections.filter((result) => result.status === "fulfilled");
    const rejected = corrections.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ message: MEMORY_REVISION_CONFLICT_ERROR });
    const updated = accepted[0]!.value;
    expect(updated).toMatchObject({
      id: first.id,
      revision: 2,
      status: "active",
      provenance: { kind: "manual" },
    });
    await expect(
      runAsTenant(fixture.actor, () =>
        store.correct(
          {
            id: first.id,
            botId: fixture.alpha.id,
            scope: "isolated",
            content: "stale correction",
            expectedRevision: 1,
          },
          context(fixture),
        ),
      ),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);

    const revisedSource = await source(fixture, fixture.alpha, "SYNTHETIC_CORRECTION = version-3");
    const revisedRequest = {
      ...durable(fixture.alpha, revisedSource, "SYNTHETIC_CORRECTION = version-3"),
      replacesId: first.id,
      expectedRevision: 2,
    };
    const revised = await runAsTenant(fixture.actor, () =>
      store.save(revisedRequest, context(fixture)),
    );
    expect(revised).toMatchObject({ id: first.id, revision: 3 });
    const replay = await runAsTenant(fixture.actor, () => store.save(request, context(fixture)));
    expect(replay).toMatchObject({ id: first.id, revision: 3, content: revised.content });
    expect(
      (
        await db.semanticFactRevision.findMany({
          where: { factId: first.id },
          orderBy: { revision: "asc" },
          select: { revision: true },
        })
      ).map((row) => row.revision),
    ).toEqual([1, 2, 3]);
  });

  it("does not revive a forgotten fact from same-source saves or stale index text", async () => {
    const fixture = await tenant("forget");
    const index = new SyntheticIndex();
    const provider = createManagedMemoryProvider({ prisma, index });
    const text = "SYNTHETIC_FORGET = remove-this";
    const origin = await source(fixture, fixture.alpha, text);
    const request = durable(fixture.alpha, origin, text);
    const first = await runAsTenant(fixture.actor, () => store.save(request, context(fixture)));
    const namespace = semanticFactNamespace(fixture.actor.spaceId, "isolated", fixture.alpha.id);
    // Even a current candidate's stored text is not the returned text: Postgres is authoritative.
    await index.upsert(
      {
        namespace,
        indexId: `synthetic:${first.id}:1`,
        id: first.id,
        revision: 1,
        content: "FORGED_INDEX_CONTENT",
      },
      context(fixture).signal,
    );
    const before = successfulValue(
      await runAsTenant(fixture.actor, () =>
        provider.recall(recallRequest(fixture.alpha), context(fixture)),
      ),
    );
    expect(before).toEqual([expect.objectContaining({ id: first.id, revision: 1, memory: text })]);

    await runAsTenant(fixture.actor, () =>
      store.forget(
        { id: first.id, botId: fixture.alpha.id, scope: "isolated", expectedRevision: 1 },
        context(fixture),
      ),
    );
    const replay = await runAsTenant(fixture.actor, () => store.save(request, context(fixture)));
    expect(replay).toMatchObject({ id: first.id, status: "forgotten" });
    expect(
      await db.semanticFact.count({ where: { spaceId: fixture.actor.spaceId, status: "active" } }),
    ).toBe(0);
    const forgotten = await db.semanticFact.findUniqueOrThrow({ where: { id: first.id } });
    index.replay(namespace, [
      candidate(first),
      { id: first.id, revision: forgotten.revision, score: 1 },
    ]);
    expect(
      successfulValue(
        await runAsTenant(fixture.actor, () =>
          provider.recall(recallRequest(fixture.alpha), context(fixture)),
        ),
      ),
    ).toEqual([]);
    expect(await db.semanticFact.count({ where: { spaceId: fixture.actor.spaceId } })).toBe(1);
  });

  it("rechecks exact bot and space namespaces instead of unioning shared, private or foreign candidates", async () => {
    const fixture = await tenant("scope");
    const foreign = await tenant("scope-foreign");
    async function save(
      f: FixtureTenant,
      bot: FixtureBot,
      scope: "isolated" | "shared",
      content: string,
    ) {
      const origin = await source(f, bot, content);
      return runAsTenant(f.actor, () =>
        store.save({ ...durable(bot, origin, content), scope }, context(f, bot)),
      );
    }
    const alpha = await save(fixture, fixture.alpha, "isolated", "SYNTHETIC_PRIVATE_ALPHA");
    const beta = await save(fixture, fixture.beta, "isolated", "SYNTHETIC_PRIVATE_BETA");
    const shared = await save(fixture, fixture.alpha, "shared", "SYNTHETIC_SPACE_SHARED");
    const elsewhere = await save(foreign, foreign.alpha, "shared", "SYNTHETIC_OTHER_SPACE_SHARED");
    const all = [alpha, beta, shared, elsewhere].map(candidate);
    const resolve = (bot: FixtureBot, scope: "isolated" | "shared") =>
      runAsTenant(fixture.actor, () =>
        store.resolveCandidates(recallRequest(bot, scope), all, context(fixture, bot)),
      );
    expect((await resolve(fixture.alpha, "isolated")).map((fact) => fact.id)).toEqual([alpha.id]);
    expect((await resolve(fixture.beta, "isolated")).map((fact) => fact.id)).toEqual([beta.id]);
    for (const bot of [fixture.alpha, fixture.beta]) {
      expect((await resolve(bot, "shared")).map((fact) => fact.id)).toEqual([shared.id]);
      const listed = await runAsTenant(fixture.actor, () =>
        store.list({ botId: bot.id, scope: "shared" }, context(fixture, bot)),
      );
      expect(listed.items.map((fact) => fact.id)).toEqual([shared.id]);
    }
    expect(semanticFactNamespace(fixture.actor.spaceId, "shared", fixture.alpha.id)).toBe(
      semanticFactNamespace(fixture.actor.spaceId, "shared", fixture.beta.id),
    );
    expect(semanticFactNamespace(fixture.actor.spaceId, "isolated", fixture.alpha.id)).not.toBe(
      semanticFactNamespace(fixture.actor.spaceId, "isolated", fixture.beta.id),
    );
    expect(semanticFactNamespace(fixture.actor.spaceId, "shared", fixture.alpha.id)).not.toBe(
      semanticFactNamespace(foreign.actor.spaceId, "shared", foreign.alpha.id),
    );
    expect(
      await runAsTenant(
        fixture.actor,
        () =>
          prisma.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM semantic_facts WHERE id = ${elsewhere.id}`,
      ),
    ).toEqual([]);
    await expect(
      runAsTenant(fixture.actor, () =>
        store.correct(
          {
            id: alpha.id,
            botId: fixture.beta.id,
            scope: "isolated",
            content: "foreign correction",
            expectedRevision: 1,
          },
          context(fixture, fixture.beta),
        ),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("fills a small recall from later candidates after real revision and forgotten-state filtering", async () => {
    const fixture = await tenant("candidate-refill");
    const ctx = context(fixture);
    const index = new SyntheticIndex();
    const provider = createManagedMemoryProvider({ prisma, index });
    const facts: SemanticFact[] = [];
    for (const text of [
      "Old decision",
      "Forgotten decision",
      "Current decision A",
      "Current decision B",
    ]) {
      const origin = await source(fixture, fixture.alpha, text);
      facts.push(
        await runAsTenant(fixture.actor, () =>
          store.save(durable(fixture.alpha, origin, text), ctx),
        ),
      );
    }
    await runAsTenant(fixture.actor, async () => {
      await store.correct(
        {
          id: facts[0]!.id,
          botId: fixture.alpha.id,
          scope: "isolated",
          content: "Revised decision",
          expectedRevision: 1,
        },
        ctx,
      );
      await store.forget(
        { id: facts[1]!.id, botId: fixture.alpha.id, scope: "isolated", expectedRevision: 1 },
        ctx,
      );
    });
    index.replay(
      semanticFactNamespace(fixture.actor.spaceId, "isolated", fixture.alpha.id),
      facts.map((fact, rank) => ({ ...candidate(fact), score: 1 - rank / 10 })),
    );
    const results = successfulValue(
      await runAsTenant(fixture.actor, () =>
        provider.recall({ ...recallRequest(fixture.alpha), limit: 2 }, ctx),
      ),
    );
    expect(results.map((fact) => fact.id)).toEqual(facts.slice(2).map((fact) => fact.id));
    expect(results.map((fact) => fact.memory)).toEqual([
      "Current decision A",
      "Current decision B",
    ]);
  });

  it("fences the real cleared thread generation before purge and retains durable and other-thread facts", async () => {
    const fixture = await tenant("clear");
    const ctx = context(fixture);
    const origin = await source(fixture, fixture.alpha, "SYNTHETIC_DURABLE_SURVIVES_CLEAR");
    const durableFact = await runAsTenant(fixture.actor, () =>
      store.save(durable(fixture.alpha, origin, "SYNTHETIC_DURABLE_SURVIVES_CLEAR"), ctx),
    );
    const historyRequest: SemanticMemorySaveRequest = {
      botId: fixture.alpha.id,
      scope: "isolated",
      content: "SYNTHETIC_OLD_HISTORY",
      source: { kind: "history", generation: 0, threadId: fixture.alpha.threadId },
    };
    const history = await runAsTenant(fixture.actor, () => store.save(historyRequest, ctx));
    const otherHistory = await runAsTenant(fixture.actor, () =>
      store.save(
        {
          botId: fixture.beta.id,
          scope: "isolated",
          content: "SYNTHETIC_OTHER_THREAD_HISTORY",
          source: { kind: "history", generation: 0, threadId: fixture.beta.threadId },
        },
        context(fixture, fixture.beta),
      ),
    );
    const cleared = await runAsTenant(fixture.actor, () =>
      createThreadEvents(prisma).clearThread({
        ...fixture.actor,
        threadId: fixture.alpha.threadId,
        botId: fixture.alpha.id,
      }),
    );
    expect(cleared.historyCompactionGeneration).toBe(0);
    expect(
      (await db.thread.findUniqueOrThrow({ where: { id: fixture.alpha.threadId } }))
        .historyCompactionGeneration,
    ).toBe(1);
    expect(await db.message.count({ where: { threadId: fixture.alpha.threadId } })).toBe(0);
    // The API's purge comes after clear: even in this gap stale indexed history is suppressed.
    expect(
      (
        await runAsTenant(fixture.actor, () =>
          store.resolveCandidates(
            { ...recallRequest(fixture.alpha), historyGeneration: 0 },
            [candidate(durableFact), candidate(history)],
            ctx,
          ),
        )
      ).map((fact) => fact.id),
    ).toEqual([durableFact.id]);
    await expect(
      runAsTenant(fixture.actor, () =>
        store.save({ ...historyRequest, content: "SYNTHETIC_LATE_BEFORE_PURGE" }, ctx),
      ),
    ).rejects.toThrow("This history generation has been retired.");
    await runAsTenant(fixture.actor, () =>
      store.purgeHistory(
        {
          botId: fixture.alpha.id,
          threadId: fixture.alpha.threadId,
          generations: [cleared.historyCompactionGeneration],
        },
        ctx,
      ),
    );
    await expect(
      runAsTenant(fixture.actor, () =>
        store.save({ ...historyRequest, content: "SYNTHETIC_LATE_AFTER_PURGE" }, ctx),
      ),
    ).rejects.toThrow("This history generation has been retired.");
    const fresh = await runAsTenant(fixture.actor, () =>
      store.save(
        {
          ...historyRequest,
          content: "SYNTHETIC_NEW_HISTORY",
          source: { kind: "history", generation: 1, threadId: fixture.alpha.threadId },
        },
        ctx,
      ),
    );
    expect(
      (
        await runAsTenant(fixture.actor, () =>
          store.resolveCandidates(
            { ...recallRequest(fixture.alpha), historyGeneration: 1 },
            [candidate(durableFact), candidate(history), candidate(fresh)],
            ctx,
          ),
        )
      ).map((fact) => fact.id),
    ).toEqual([durableFact.id, fresh.id]);
    expect(
      (await db.semanticFact.findUniqueOrThrow({ where: { id: durableFact.id } })).status,
    ).toBe("active");
    expect(
      (await db.semanticFact.findUniqueOrThrow({ where: { id: otherHistory.id } })).status,
    ).toBe("active");
    expect(
      await db.semanticFact.count({ where: { spaceId: fixture.actor.spaceId, status: "active" } }),
    ).toBe(3);
  });

  it("encrypts facts and revisions, keeps pointer-only outbox rows and converts stale work to deletes", async () => {
    const fixture = await tenant("encrypted");
    const text = "SYNTHETIC_AT_REST_CONTENT";
    const quote = "SYNTHETIC_AT_REST_SOURCE_QUOTE";
    const origin = await source(fixture, fixture.alpha, quote);
    const first = await runAsTenant(fixture.actor, () =>
      store.save(durable(fixture.alpha, origin, text), context(fixture)),
    );
    const raw = await runAsSystem("semantic memory encrypted storage assertion", () =>
      database.pool.query<{ content: string; provenance: string }>(
        `SELECT content, provenance FROM semantic_facts WHERE id = $1 UNION ALL SELECT content, provenance FROM semantic_fact_revisions WHERE "factId" = $1`,
        [first.id],
      ),
    );
    expect(raw.rows).toHaveLength(2);
    for (const row of raw.rows) {
      expect(row.content).toContain("rkz1:");
      expect(row.provenance).toContain("rkz1:");
      expect(JSON.stringify(row)).not.toContain(text);
      expect(JSON.stringify(row)).not.toContain(quote);
    }
    const rawOutbox = await runAsSystem("semantic memory pointer-only outbox assertion", () =>
      database.pool.query<{ payload: Record<string, unknown> }>(
        `SELECT to_jsonb(work) AS payload FROM semantic_memory_index_outbox work WHERE "factId" = $1`,
        [first.id],
      ),
    );
    expect(rawOutbox.rows).toHaveLength(1);
    expect(rawOutbox.rows[0]!.payload).not.toHaveProperty("content");
    expect(rawOutbox.rows[0]!.payload).not.toHaveProperty("provenance");
    expect(JSON.stringify(rawOutbox.rows)).not.toContain(quote);
    const pending = await runAsTenant(fixture.actor, () =>
      store.pendingIndexWork(100, fixture.actor.spaceId),
    );
    expect(pending).toHaveLength(1);
    expect(
      await runAsTenant(fixture.actor, () => store.getIndexWork(pending[0]!.id)),
    ).toMatchObject({ factId: first.id, action: "upsert", revision: 1, content: text });
    const revised = await runAsTenant(fixture.actor, () =>
      store.correct(
        {
          id: first.id,
          botId: fixture.alpha.id,
          scope: "isolated",
          expectedRevision: 1,
          content: "SYNTHETIC_AT_REST_NEW_CONTENT",
        },
        context(fixture),
      ),
    );
    expect(
      await runAsTenant(fixture.actor, () => store.getIndexWork(pending[0]!.id)),
    ).toMatchObject({ factId: first.id, action: "delete", revision: 1, content: null });
    const index = new SyntheticIndex();
    await syncManagedMemoryIndex({ prisma, index }, fixture.actor.spaceId, context(fixture).signal);
    expect(index.upserts).toEqual([
      expect.objectContaining({ id: first.id, revision: 2, content: revised.content }),
    ]);
    expect(
      await runAsTenant(fixture.actor, () => store.pendingIndexWork(100, fixture.actor.spaceId)),
    ).toEqual([]);
  });

  it("does not lose cleanup when an already-started index upsert completes after forget and a competing drain", async () => {
    const fixture = await tenant("index-race");
    const index = new SyntheticIndex();
    const provider = createManagedMemoryProvider({ prisma, index });
    const drain = () =>
      syncManagedMemoryIndex({ prisma, index }, fixture.actor.spaceId, context(fixture).signal);
    const text = "SYNTHETIC_IN_FLIGHT_INDEX_FACT";
    const origin = await source(fixture, fixture.alpha, text);
    const first = await runAsTenant(fixture.actor, () =>
      store.save(durable(fixture.alpha, origin, text), context(fixture)),
    );
    const gate = index.pauseNextUpsert();
    const started = drain();
    let competing: Promise<void> | undefined;
    try {
      const entered = await Promise.race([
        gate.started,
        started.then(() => {
          throw new Error("Index drain finished without applying the pending upsert.");
        }),
      ]);
      expect(entered).toMatchObject({ id: first.id, revision: 1 });
      await runAsTenant(fixture.actor, () =>
        store.forget(
          { id: first.id, botId: fixture.alpha.id, scope: "isolated", expectedRevision: 1 },
          context(fixture),
        ),
      );
      // Index writers serialize per space; the fact mutation above must not wait on that lock.
      competing = drain();
    } finally {
      gate.release();
    }
    await started;
    await competing;
    expect(
      successfulValue(
        await runAsTenant(fixture.actor, () =>
          provider.recall(recallRequest(fixture.alpha), context(fixture)),
        ),
      ),
    ).toEqual([]);
    // One ordinary later drain may finish physical cleanup; it must not need a new mutation.
    await drain();
    expect([...index.documents.values()]).toEqual([]);
    expect(
      await runAsTenant(fixture.actor, () => store.pendingIndexWork(100, fixture.actor.spaceId)),
    ).toEqual([]);
    expect((await db.semanticFact.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      "forgotten",
    );
  });

  it("does not recreate drained index work when a forgotten fact is cascaded with its own space", async () => {
    const fixture = await tenant("cascade");
    const index = new SyntheticIndex();
    const provider = createManagedMemoryProvider({ prisma, index });
    const text = "SYNTHETIC_CASCADE_FACT";
    const origin = await source(fixture, fixture.alpha, text);
    const first = await runAsTenant(fixture.actor, () =>
      store.save(durable(fixture.alpha, origin, text), context(fixture)),
    );
    await runAsTenant(fixture.actor, () =>
      store.forget(
        { id: first.id, botId: fixture.alpha.id, scope: "isolated", expectedRevision: 1 },
        context(fixture),
      ),
    );
    successfulValue(await provider.syncIndex!(context(fixture)));
    expect(
      await db.semanticMemoryIndexOutbox.count({ where: { spaceId: fixture.actor.spaceId } }),
    ).toBe(0);
    expect([...index.documents.values()]).toEqual([]);
    // Only this case's newly-created space is deleted; every other test namespace survives.
    await db.space.delete({ where: { id: fixture.actor.spaceId } });
    expect(await db.semanticFact.count({ where: { spaceId: fixture.actor.spaceId } })).toBe(0);
    expect(
      await db.semanticMemoryIndexOutbox.count({ where: { spaceId: fixture.actor.spaceId } }),
    ).toBe(0);
  });
});
