import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { lessonFactNamespace, SemanticFactStore, semanticFactNamespace } from "./semantic-facts.js";

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
const taskId = `sm-task-${stamp}`;
const runId = `sm-run-${stamp}`;
const otherUserId = `sm-other-user-${stamp}`;
const otherUserRunId = `sm-other-user-run-${stamp}`;
const peerTaskId = `sm-peer-task-${stamp}`;
const peerRunId = `sm-peer-run-${stamp}`;

/** A lesson always cites a run and the harness evidence that justified it. */
const lessonRun = (runIdValue: string, quote: string, threadIdValue = threadId) => ({
  kind: "run" as const,
  runId: runIdValue,
  threadId: threadIdValue,
  observedAt: new Date().toISOString(),
  harness: {
    domainKey: "files",
    signals: ["tool_error"],
    autoApplied: true,
    evidence: { kind: "tool_error" as const, quote },
  },
});

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
      await prisma.task.create({
        data: {
          id: taskId,
          spaceId,
          botId,
          threadId,
          userId,
          prompt: "Synthetic lesson run",
          status: "completed",
        },
      });
      await prisma.run.create({
        data: {
          id: runId,
          spaceId,
          botId,
          threadId,
          taskId,
          userId,
          status: "completed",
          trigger: "user",
        },
      });
      // A second member of the same space and a run that member started on the same bot;
      // any member may confirm a review card for a run someone else started.
      await prisma.user.create({
        data: {
          id: otherUserId,
          name: "Memory peer",
          email: `${otherUserId}@example.test`,
        },
      });
      await prisma.member.create({
        data: {
          id: `sm-other-member-${stamp}`,
          organizationId: orgId,
          userId: otherUserId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: `sm-member-${otherUserId}`,
          spaceId,
          organizationId: orgId,
          userId: otherUserId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await prisma.run.create({
        data: {
          id: otherUserRunId,
          spaceId,
          botId,
          threadId,
          taskId,
          userId: otherUserId,
          status: "completed",
          trigger: "user",
        },
      });
      // A run of the space's other bot: never a valid attribution for this bot's lesson.
      await prisma.task.create({
        data: {
          id: peerTaskId,
          spaceId,
          botId: peerBotId,
          threadId: otherThreadId,
          userId,
          prompt: "Synthetic peer lesson run",
          status: "completed",
        },
      });
      await prisma.run.create({
        data: {
          id: peerRunId,
          spaceId,
          botId: peerBotId,
          threadId: otherThreadId,
          taskId: peerTaskId,
          userId,
          status: "completed",
          trigger: "user",
        },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("synthetic semantic-memory fixture cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: orgId } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
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

  it("keeps a deleted bot's scope when its deleting transaction rolls back", async () => {
    const saved = await store.save(
      {
        botId,
        scope: "isolated",
        content: "Survives a failed delete.",
        source: { kind: "durable" },
      },
      { ...ctx, operationId: "rolled-back-delete" },
    );
    await expect(
      runAsTenant(ctx, () =>
        prisma.$transaction(async (tx) => {
          await store.retireScope({ spaceId, botId }, { ...ctx, botId }, tx);
          throw new Error("deletion aborted");
        }),
      ),
    ).rejects.toThrow("deletion aborted");
    expect(
      (await store.list({ botId, scope: "isolated", includeHistory: true }, ctx)).items.find(
        (fact) => fact.id === saved.id,
      ),
    ).toMatchObject({ status: "active", content: "Survives a failed delete." });
    expect(
      await runAsTenant(ctx, () =>
        prisma.semanticMemoryRetirement.findMany({
          where: {
            namespace: semanticFactNamespace(spaceId, "isolated", botId),
            kind: "scope",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("forgets the body and every revision, and a repeated forget still succeeds", async () => {
    const saved = await store.save(
      {
        botId,
        scope: "isolated",
        content: "Synthetic body to forget.",
        source: { kind: "durable" },
      },
      { ...ctx, operationId: "forget-scrub" },
    );
    await store.correct(
      {
        id: saved.id,
        botId,
        scope: "isolated",
        content: "Synthetic body, corrected.",
        expectedRevision: 1,
      },
      ctx,
    );
    await store.forget({ id: saved.id, botId, scope: "isolated", expectedRevision: 2 }, ctx);
    await expect(
      store.forget({ id: saved.id, botId, scope: "isolated", expectedRevision: 2 }, ctx),
    ).resolves.toEqual({ id: saved.id, expired: true, reason: null });

    const revisions = await runAsTenant(ctx, () =>
      prisma.semanticFactRevision.findMany({ where: { factId: saved.id } }),
    );
    expect(revisions.map((row) => [row.revision, row.content, row.status])).toEqual([
      [3, "[forgotten]", "forgotten"],
    ]);
    const raw = await runAsSystem("inspect the forgotten body", () =>
      db.pool.query<{ content: string }>("SELECT content FROM semantic_facts WHERE id = $1", [
        saved.id,
      ]),
    );
    expect(raw.rows[0]!.content).toMatch(/^rkz1:/);
    expect(
      await runAsTenant(ctx, () =>
        prisma.semanticFactSource.count({ where: { factId: saved.id } }),
      ),
    ).toBeGreaterThan(0);
  });

  it("retires a deleted bot's shared history and forgets a fact cited from another scope", async () => {
    const shared = semanticFactNamespace(spaceId, "shared", peerBotId);
    const sharedHistory = await store.save(
      {
        botId: peerBotId,
        scope: "shared",
        content: "Peer shared thread summary.",
        source: { kind: "history", threadId: otherThreadId, generation: 0 },
      },
      { ...ctx, botId: peerBotId },
    );
    const sharedDurable = await store.save(
      {
        botId: peerBotId,
        scope: "shared",
        content: "Peer durable shared fact.",
        source: { kind: "durable" },
      },
      { ...ctx, botId: peerBotId, operationId: "peer-shared-durable" },
    );
    const cited = await store.save(
      {
        botId: peerBotId,
        scope: "shared",
        content: "Peer fact cited from another scope.",
        source: { kind: "durable" },
      },
      { ...ctx, botId: peerBotId, operationId: "peer-shared-cited" },
    );
    await store.retireScope({ spaceId, botId: peerBotId }, { ...ctx, botId: peerBotId });
    const listed = await runAsTenant(ctx, () =>
      prisma.semanticFact.findMany({ where: { id: { in: [sharedHistory.id, sharedDurable.id] } } }),
    );
    expect(listed.map((row) => [row.id, row.status])).toEqual(
      expect.arrayContaining([
        [sharedHistory.id, "forgotten"],
        [sharedDurable.id, "active"],
      ]),
    );
    await store.forget(
      {
        id: cited.id,
        botId,
        scope: "isolated",
        entity: semanticFactNamespace(spaceId, "shared", botId),
        expectedRevision: 1,
      },
      ctx,
    );
    expect(
      (await store.list({ botId, scope: "shared", includeHistory: true }, ctx)).items.find(
        (fact) => fact.id === cited.id,
      ),
    ).toMatchObject({ status: "forgotten", content: "[forgotten]" });
    expect(semanticFactNamespace(spaceId, "shared", botId)).toBe(shared);
  });

  it("keeps host lessons in their own namespace and retires them out of recall", async () => {
    const context = { ...ctx, operationId: "lesson-write" };
    const lesson = await store.saveLesson(
      {
        botId,
        cue: "The build fails on a missing file",
        lesson: "List the directory before retrying the build.",
        provenance: {
          kind: "run",
          runId,
          threadId,
          observedAt: new Date().toISOString(),
          harness: {
            domainKey: "files",
            signals: ["tool_error"],
            autoApplied: true,
            evidence: { kind: "tool_error", quote: "ENOENT" },
          },
        },
      },
      context,
    );
    expect(lesson).toMatchObject({
      kind: "lesson",
      scope: "isolated",
      revision: 1,
      status: "active",
    });
    const raw = await runAsSystem("inspect synthetic lesson bytes", () =>
      db.pool.query<{ kind: string; namespace: string; content: string }>(
        "SELECT kind, namespace, content FROM semantic_facts WHERE id = $1",
        [lesson!.id],
      ),
    );
    expect(raw.rows[0]).toMatchObject({
      kind: "lesson",
      namespace: lessonFactNamespace(spaceId, botId),
    });
    expect(raw.rows[0]!.content).toMatch(/^rkz1:/);
    expect(raw.rows[0]!.content).not.toContain("List the directory");
    expect(
      (await store.list({ botId, scope: "isolated", kind: "lesson" }, context)).items.map(
        (item) => [item.id, item.kind],
      ),
    ).toEqual([[lesson!.id, "lesson"]]);
    // Ordinary listing and recall never include a lesson, even when its exact id is offered.
    expect(
      (await store.list({ botId, scope: "isolated" }, context)).items.some(
        (item) => item.id === lesson!.id,
      ),
    ).toBe(false);
    expect(
      await store.resolveCandidates(
        { botId, scope: "isolated", query: "build", limit: 5 },
        [{ id: lesson!.id, revision: 1, score: 1 }],
        context,
      ),
    ).toEqual([]);
    expect(
      (
        await store.resolveCandidates(
          { botId, scope: "isolated", kind: "lesson", query: "build", limit: 5 },
          [{ id: lesson!.id, revision: 1, score: 1 }],
          context,
        )
      ).map((item) => item.id),
    ).toEqual([lesson!.id]);
    await store.retireLesson(lesson!.id, context);
    expect((await store.list({ botId, scope: "isolated", kind: "lesson" }, context)).items).toEqual(
      [],
    );
    expect(
      (
        await store.list(
          { botId, scope: "isolated", kind: "lesson", includeHistory: true },
          context,
        )
      ).items.map((item) => [item.id, item.status]),
    ).toEqual([[lesson!.id, "historical"]]);
    const work = await runAsTenant(ctx, () =>
      prisma.semanticMemoryIndexOutbox.findMany({
        where: { factId: lesson!.id },
        orderBy: [{ revision: "asc" }, { action: "desc" }],
      }),
    );
    expect(work.map((row) => [row.revision, row.action])).toEqual([
      [1, "upsert"],
      [1, "delete"],
      [2, "delete"],
    ]);
  });

  it("accepts a lesson a member writes from another member's run of the same bot", async () => {
    const lesson = await store.saveLesson(
      {
        botId,
        cue: "Another member's run failed to compile",
        lesson: "Run the type check before reporting a build failure.",
        provenance: lessonRun(otherUserRunId, "TS2345"),
      },
      { ...ctx, operationId: "lesson-other-author" },
    );
    expect(lesson).toMatchObject({
      botId,
      kind: "lesson",
      scope: "isolated",
      revision: 1,
      status: "active",
    });
    // The run belongs to a different member; the caller only has to share the space.
    const author = await runAsSystem("inspect the borrowed run author", () =>
      prisma.run.findUnique({ where: { id: otherUserRunId }, select: { userId: true } }),
    );
    expect(author?.userId).toBe(otherUserId);
    const raw = await runAsSystem("inspect the borrowed-run lesson", () =>
      db.pool.query<{ kind: string; namespace: string; status: string }>(
        "SELECT kind, namespace, status FROM semantic_facts WHERE id = $1",
        [lesson!.id],
      ),
    );
    expect(raw.rows[0]).toEqual({
      kind: "lesson",
      namespace: lessonFactNamespace(spaceId, botId),
      status: "active",
    });
  });

  it("rejects a lesson citing a run that belongs to another bot", async () => {
    await expect(
      store.saveLesson(
        {
          botId,
          cue: "A run of the peer bot",
          lesson: "This lesson must never be stored.",
          provenance: lessonRun(peerRunId, "build failed", otherThreadId),
        },
        { ...ctx, operationId: "lesson-foreign-run" },
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      (await store.list({ botId, scope: "isolated", kind: "lesson", query: "peer bot" }, ctx))
        .items,
    ).toEqual([]);
  });

  it("returns null and keeps the stored revision when a lesson replacement goes stale", async () => {
    const cue = "Build breaks after a rename";
    const first = await store.saveLesson(
      {
        botId,
        cue,
        lesson: "Search the tree for the old name.",
        provenance: lessonRun(runId, "ENOENT"),
      },
      { ...ctx, operationId: "lesson-replace-first" },
    );
    expect(first).toMatchObject({ kind: "lesson", revision: 1, status: "active" });
    const replacementContent = `cue: ${cue}\nlesson: Search the tree for the old name, then rebuild.`;
    const replacement = await store.saveLesson(
      {
        botId,
        cue,
        lesson: "Search the tree for the old name, then rebuild.",
        provenance: lessonRun(runId, "ENOENT"),
        replaces: { id: first!.id, expectedRevision: 1 },
      },
      { ...ctx, operationId: "lesson-replace-apply" },
    );
    expect(replacement).toMatchObject({
      id: first!.id,
      kind: "lesson",
      revision: 2,
      status: "active",
    });
    const stale = await store.saveLesson(
      {
        botId,
        cue,
        lesson: "A stale reviewer replaced this lesson.",
        provenance: lessonRun(runId, "ENOENT"),
        replaces: { id: first!.id, expectedRevision: 1 },
      },
      { ...ctx, operationId: "lesson-replace-stale" },
    );
    expect(stale).toBeNull();
    const stored = (
      await store.list({ botId, scope: "isolated", kind: "lesson", query: "old name" }, ctx)
    ).items.filter((item) => item.id === first!.id);
    expect(stored).toMatchObject([
      { id: first!.id, revision: 2, status: "active", content: replacementContent },
    ]);
    expect(stored[0]!.content).not.toContain("stale reviewer");
    const revisions = await runAsTenant(ctx, () =>
      prisma.semanticFactRevision.findMany({
        where: { factId: first!.id },
        orderBy: { revision: "asc" },
      }),
    );
    expect(revisions.map((row) => [row.revision, row.content])).toEqual([
      [1, `cue: ${cue}\nlesson: Search the tree for the old name.`],
      [2, replacementContent],
    ]);
  });

  it("corrects and forgets a lesson while ordinary fact queries never see it", async () => {
    const cue = "Deploy fails on a stale lock";
    const saved = await store.saveLesson(
      {
        botId,
        cue,
        lesson: "Clear the lock file before deploying.",
        provenance: lessonRun(runId, "lock held"),
      },
      { ...ctx, operationId: "lesson-manage-save" },
    );
    const correctedContent = `cue: ${cue}\nlesson: Remove the lock file, then deploy.`;
    const corrected = await store.correct(
      {
        id: saved!.id,
        botId,
        scope: "isolated",
        kind: "lesson",
        content: correctedContent,
        expectedRevision: 1,
      },
      { ...ctx, operationId: "lesson-manage-correct" },
    );
    expect(corrected).toMatchObject({
      id: saved!.id,
      kind: "lesson",
      revision: 2,
      status: "active",
      content: correctedContent,
    });
    const raw = await runAsSystem("inspect the corrected lesson", () =>
      db.pool.query<{ kind: string; namespace: string }>(
        "SELECT kind, namespace FROM semantic_facts WHERE id = $1",
        [saved!.id],
      ),
    );
    expect(raw.rows[0]).toEqual({
      kind: "lesson",
      namespace: lessonFactNamespace(spaceId, botId),
    });
    // Ordinary facts never see a lesson, even when its exact id is offered.
    for (const scope of ["isolated", "shared"] as const)
      expect(
        (await store.list({ botId, scope }, ctx)).items.some((item) => item.id === saved!.id),
      ).toBe(false);
    expect(
      await store.resolveCandidates(
        { botId, scope: "isolated", query: "lock file", limit: 5 },
        [{ id: saved!.id, revision: 2, score: 1 }],
        ctx,
      ),
    ).toEqual([]);
    expect(
      (
        await store.list({ botId, scope: "isolated", kind: "lesson", query: "lock file" }, ctx)
      ).items.filter((item) => item.id === saved!.id),
    ).toMatchObject([{ revision: 2, content: correctedContent }]);
    expect(
      await store.forget(
        { id: saved!.id, botId, scope: "isolated", kind: "lesson", expectedRevision: 2 },
        ctx,
      ),
    ).toEqual({ id: saved!.id, expired: true, reason: null });
    expect(
      (
        await store.list({ botId, scope: "isolated", kind: "lesson", includeHistory: true }, ctx)
      ).items.filter((item) => item.id === saved!.id),
    ).toMatchObject([{ revision: 3, status: "forgotten", content: "[forgotten]" }]);
    expect(
      (await store.list({ botId, scope: "isolated", kind: "lesson" }, ctx)).items.some(
        (item) => item.id === saved!.id,
      ),
    ).toBe(false);
    const revisions = await runAsTenant(ctx, () =>
      prisma.semanticFactRevision.findMany({ where: { factId: saved!.id } }),
    );
    expect(revisions.map((row) => [row.revision, row.content, row.status])).toEqual([
      [3, "[forgotten]", "forgotten"],
    ]);
  });
});
