import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { SemanticFactStore, semanticFactNamespace } from "./semantic-facts.js";

// The implementation owner never runs this. The isolated runner creates a random
// database AND runtime role; refuse a production/default target even if opted in.
const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const stamp = randomUUID();
const userId = `sm-user-${stamp}`;
const orgId = `sm-org-${stamp}`;
const spaceId = `sm-space-${stamp}`;
const foreignSpaceId = `sm-foreign-space-${stamp}`;
const botId = `sm-bot-${stamp}`;
const peerBotId = `sm-peer-bot-${stamp}`;
const foreignBotId = `sm-foreign-bot-${stamp}`;
const threadId = `sm-thread-${stamp}`;
const otherThreadId = `sm-other-thread-${stamp}`;

postgres("semantic fact authority (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let store: SemanticFactStore;
  let ctx: AdapterContext;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !url.pathname.slice(1).startsWith("rkz_") ||
      !decodeURIComponent(url.username).startsWith("rkz_") ||
      url.pathname === "/rakazo"
    )
      throw new Error(
        "Semantic memory PostgreSQL tests require a fresh rkz_ database and runtime login.",
      );
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    store = new SemanticFactStore(prisma);
    ctx = {
      operationId: "test",
      traceId: "test",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    };
    await runAsSystem("synthetic semantic-memory fixture", async () => {
      await prisma.user.create({
        data: { id: userId, name: "Memory fixture", email: `${userId}@example.test` },
      });
      await prisma.organization.create({
        data: { id: orgId, name: "Fixture", slug: orgId, createdAt: new Date() },
      });
      await prisma.member.create({
        data: {
          id: `sm-member-${stamp}`,
          organizationId: orgId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      for (const id of [spaceId, foreignSpaceId]) {
        await prisma.space.create({ data: { id, organizationId: orgId, name: "Memory" } });
        await prisma.spaceMember.create({
          data: {
            id: `sm-member-${id}`,
            spaceId: id,
            organizationId: orgId,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
      }
      for (const [id, space] of [
        [botId, spaceId],
        [peerBotId, spaceId],
        [foreignBotId, foreignSpaceId],
      ])
        await prisma.bot.create({
          data: { id: id!, spaceId: space!, userId, name: "Fixture bot", color: "ink" },
        });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
      await prisma.thread.create({
        data: { id: otherThreadId, spaceId, userId, botId: peerBotId },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("synthetic semantic-memory fixture cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: orgId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.semanticMemoryIndexOutbox.deleteMany({
        where: { spaceId: { in: [spaceId, foreignSpaceId] } },
      });
      await prisma.semanticMemoryRetirement.deleteMany({
        where: { spaceId: { in: [spaceId, foreignSpaceId] } },
      });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("coalesces concurrent exact writes, seals source/body, and retains tombstones", async () => {
    const request = {
      botId,
      scope: "isolated" as const,
      content: "Synthetic preference: use a narrow console.",
      source: { kind: "durable" as const },
    };
    const context = { ...ctx, operationId: "exact-source" };
    const [left, right] = await Promise.all([
      store.save(request, context),
      store.save(request, context),
    ]);
    expect(left.id).toBe(right.id);
    const raw = await runAsSystem("inspect synthetic encryption bytes", () =>
      db.pool.query<{ content: string; provenance: string }>(
        "SELECT content, provenance FROM semantic_facts WHERE id = $1",
        [left.id],
      ),
    );
    expect(raw.rows[0]!.content).toMatch(/^rkz1:/);
    expect(raw.rows[0]!.provenance).toMatch(/^rkz1:/);
    expect(raw.rows[0]!.content).not.toContain("narrow console");
    await store.forget({ id: left.id, botId, scope: "isolated", expectedRevision: 1 }, context);
    expect(await store.save(request, context)).toMatchObject({
      id: left.id,
      revision: 2,
      status: "forgotten",
    });
    expect(
      await store.resolveCandidates(
        { botId, scope: "isolated", query: "console", limit: 5 },
        [
          { id: left.id, revision: 1, score: 1 },
          { id: left.id, revision: 2, score: 1 },
        ],
        context,
      ),
    ).toEqual([]);
  });

  it("performs correction CAS and revision outbox in one transaction", async () => {
    const saved = await store.save(
      {
        botId,
        scope: "isolated",
        content: "Original synthetic fact.",
        source: { kind: "durable" },
      },
      { ...ctx, operationId: "cas" },
    );
    const requests = ["Left correction.", "Right correction."].map((content) => ({
      id: saved.id,
      botId,
      scope: "isolated" as const,
      content,
      expectedRevision: 1,
    }));
    const outcomes = await Promise.allSettled(
      requests.map((request) => store.correct(request, ctx)),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find(
      (outcome) => outcome.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failed.reason.message).toBe(MEMORY_REVISION_CONFLICT_ERROR);
    const rows = await runAsTenant(ctx, () =>
      prisma.semanticFactRevision.findMany({
        where: { factId: saved.id },
        orderBy: { revision: "asc" },
      }),
    );
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    const work = await runAsTenant(ctx, () =>
      prisma.semanticMemoryIndexOutbox.findMany({ where: { factId: saved.id } }),
    );
    expect(work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 1, action: "delete" }),
        expect.objectContaining({ revision: 2, action: "upsert" }),
      ]),
    );
    expect(work.every((row) => !("content" in row) && !("provenance" in row))).toBe(true);
  });

  it("keeps exact scope, active time and history thread/generation boundaries", async () => {
    const shared = await store.save(
      { botId, scope: "shared", content: "Shared synthetic fact.", source: { kind: "durable" } },
      { ...ctx, operationId: "shared" },
    );
    const foreign = await store.save(
      {
        botId: foreignBotId,
        scope: "isolated",
        content: "Foreign fact.",
        source: { kind: "durable" },
      },
      { ...ctx, botId: foreignBotId, spaceId: foreignSpaceId, operationId: "foreign" },
    );
    const future = await store.importFact(
      {
        botId,
        scope: "isolated",
        sourceKey: "future",
        content: "Future fact.",
        kind: "durable",
        status: "active",
        provenance: { kind: "import", validFrom: "2999-01-01T00:00:00.000Z" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      ctx,
    );
    const history = await store.save(
      {
        botId,
        scope: "isolated",
        content: "Thread summary.",
        source: { kind: "history", threadId, generation: 0 },
      },
      ctx,
    );
    const request = {
      botId,
      scope: "isolated" as const,
      query: "fact",
      threadId,
      historyGeneration: 0,
      limit: 5,
    };
    expect(
      (
        await store.resolveCandidates(
          request,
          [
            { id: shared.id, revision: 1, score: 10 },
            { id: foreign.id, revision: 1, score: 9 },
            { id: future.id, revision: 1, score: 8 },
            { id: history.id, revision: 1, score: 7 },
          ],
          ctx,
        )
      ).map((hit) => hit.id),
    ).toEqual([history.id]);
    await expect(
      store.resolveCandidates(
        { ...request, threadId: otherThreadId },
        [{ id: history.id, revision: 1, score: 1 }],
        ctx,
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      await store.resolveCandidates(
        { ...request, threadId: undefined },
        [{ id: history.id, revision: 1, score: 1 }],
        ctx,
      ),
    ).toEqual([]);
    await store.purgeHistory({ botId, generations: [0], threadId }, ctx);
    await expect(
      store.save(
        {
          botId,
          scope: "isolated",
          content: "Late old summary.",
          source: { kind: "history", generation: 0, threadId },
        },
        ctx,
      ),
    ).rejects.toThrow(/retired/);
    expect(
      (await store.list({ botId, scope: "shared" }, ctx)).items.some(
        (fact) => fact.id === shared.id,
      ),
    ).toBe(true);
    expect(
      (await store.list({ botId, scope: "isolated" }, ctx)).items.some(
        (fact) => fact.id === history.id,
      ),
    ).toBe(false);
  });

  it("lets shared authority survive bot retirement and enforces tenant RLS", async () => {
    const isolated = await store.save(
      {
        botId: peerBotId,
        scope: "isolated",
        content: "Peer private fact.",
        source: { kind: "durable" },
      },
      { ...ctx, botId: peerBotId, operationId: "peer-isolated" },
    );
    const shared = await store.save(
      {
        botId: peerBotId,
        scope: "shared",
        content: "Peer shared fact.",
        source: { kind: "durable" },
      },
      { ...ctx, botId: peerBotId, operationId: "peer-shared" },
    );
    await store.retireScope({ spaceId, botId: peerBotId }, { ...ctx, botId: peerBotId });
    expect(
      (
        await store.resolveCandidates(
          { botId, scope: "shared", query: "fact", limit: 5 },
          [{ id: shared.id, revision: 1, score: 1 }],
          ctx,
        )
      ).map((hit) => hit.id),
    ).toEqual([shared.id]);
    expect(
      (
        await store.list(
          { botId: peerBotId, scope: "isolated", includeHistory: true },
          { ...ctx, botId: peerBotId },
        )
      ).items.find((fact) => fact.id === isolated.id)?.status,
    ).toBe("forgotten");
    const visible = await runAsTenant({ spaceId: foreignSpaceId, userId }, () =>
      prisma.semanticFact.findMany({ where: { id: shared.id } }),
    );
    expect(visible).toEqual([]);
    await expect(
      store.list({ botId: foreignBotId, scope: "isolated" }, ctx),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("serializes index writers per space without blocking a concurrent fact write", async () => {
    await store.syncIndexWork(spaceId, async () => {}, ctx.signal);
    const saved = await store.save(
      { botId, scope: "isolated", content: "Index race fact.", source: { kind: "durable" } },
      { ...ctx, operationId: "index-race" },
    );
    let release!: () => void;
    let began!: () => void;
    const begun = new Promise<void>((resolve) => {
      began = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied: Array<{ revision: number; action: string }> = [];
    const sync = store.syncIndexWork(
      spaceId,
      async (work) => {
        applied.push({ revision: work.revision, action: work.action });
        if (work.factId === saved.id && work.action === "upsert" && work.revision === 1) {
          began();
          await held;
        }
      },
      ctx.signal,
    );
    await begun;
    await store.correct(
      {
        id: saved.id,
        botId,
        scope: "isolated",
        content: "Index race corrected.",
        expectedRevision: 1,
      },
      ctx,
    );
    release();
    await sync;
    expect(applied).toEqual(
      expect.arrayContaining([
        { revision: 1, action: "upsert" },
        { revision: 1, action: "delete" },
        { revision: 2, action: "upsert" },
      ]),
    );
    expect(await store.pendingIndexWork(100, spaceId)).toEqual([]);
    expect(semanticFactNamespace(spaceId, "shared", botId)).toBe(
      semanticFactNamespace(spaceId, "shared", peerBotId),
    );
  });
});
