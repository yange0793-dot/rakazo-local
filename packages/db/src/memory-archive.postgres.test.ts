import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { MemoryArchiveStore } from "./memory-archive.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { SemanticFactStore } from "./semantic-facts.js";

// The implementation owner never runs this. The isolated runner creates a random
// database AND runtime role; refuse a production/default target even if opted in.
const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const stamp = randomUUID();
const userId = `ma-user-${stamp}`;
const orgId = `ma-org-${stamp}`;
const spaceId = `ma-space-${stamp}`;
const foreignSpaceId = `ma-foreign-space-${stamp}`;
const botId = `ma-bot-${stamp}`;
const peerBotId = `ma-peer-bot-${stamp}`;
const foreignBotId = `ma-foreign-bot-${stamp}`;
const threadId = `ma-thread-${stamp}`;
const peerThreadId = `ma-peer-thread-${stamp}`;
const helperThreadId = `ma-helper-thread-${stamp}`;
const foreignThreadId = `ma-foreign-thread-${stamp}`;

postgres("automatic memory archive (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let archive: MemoryArchiveStore;
  let facts: SemanticFactStore;
  let ctx: AdapterContext;
  let taskSequence = 0;

  const system = <T>(reason: string, fn: () => Promise<T>) => runAsSystem(reason, fn);

  async function addMessage(
    id: string,
    seq: number,
    role: "user" | "bot" | "system",
    blocks: unknown[],
    thread = threadId,
    bot = botId,
  ) {
    await system("synthetic archive message", async () => {
      await prisma.message.create({
        data: {
          id,
          threadId: thread,
          seq,
          role,
          blocks: blocks as never,
          botId: role === "bot" ? bot : null,
          authorUserId: role === "user" ? userId : null,
        },
      });
      await prisma.thread.update({
        where: { id: thread },
        data: { nextMessageSeq: seq + 1 },
      });
    });
  }

  async function completedRun(
    id: string,
    sourceMessageId: string | null,
    trigger = "user",
    thread = threadId,
    bot = botId,
  ): Promise<string> {
    return system("synthetic archive run", async () => {
      taskSequence += 1;
      const task = await prisma.task.create({
        data: {
          id: `ma-task-${stamp}-${taskSequence}`,
          spaceId,
          botId: bot,
          threadId: thread,
          userId,
          prompt: "synthetic archive prompt",
          status: "completed",
        },
      });
      await prisma.run.create({
        data: {
          id,
          spaceId,
          botId: bot,
          threadId: thread,
          taskId: task.id,
          userId,
          status: "completed",
          trigger,
          sourceMessageId,
        },
      });
      return id;
    });
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !url.pathname.slice(1).startsWith("rkz_") ||
      !decodeURIComponent(url.username).startsWith("rkz_") ||
      url.pathname === "/rakazo"
    )
      throw new Error(
        "Automatic-memory PostgreSQL tests require a fresh rkz_ database and runtime login.",
      );
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    archive = new MemoryArchiveStore(prisma);
    facts = new SemanticFactStore(prisma);
    ctx = {
      operationId: "test",
      traceId: "test",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    };
    await system("synthetic archive fixture", async () => {
      await prisma.user.create({
        data: { id: userId, name: "Archive fixture", email: `${userId}@example.test` },
      });
      await prisma.organization.create({
        data: { id: orgId, name: "Fixture", slug: orgId, createdAt: new Date() },
      });
      await prisma.member.create({
        data: {
          id: `ma-member-${stamp}`,
          organizationId: orgId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      for (const id of [spaceId, foreignSpaceId]) {
        await prisma.space.create({ data: { id, organizationId: orgId, name: "Archive" } });
        await prisma.spaceMember.create({
          data: {
            id: `ma-member-${id}`,
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
          data: { id: id!, spaceId: space!, userId, name: "Archive bot", color: "ink" },
        });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
      await prisma.thread.create({
        data: { id: peerThreadId, spaceId, userId, botId: peerBotId },
      });
      await prisma.thread.create({
        data: { id: helperThreadId, spaceId, userId, helperBotId: botId },
      });
      await prisma.thread.create({
        data: { id: foreignThreadId, spaceId: foreignSpaceId, userId, botId: foreignBotId },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system("synthetic archive fixture cleanup", async () => {
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

  it("archives one completed direct turn, seals the fact, and checkpoints the cursor", async () => {
    await addMessage("ma-m0", 0, "user", [{ kind: "text", text: "Older chat before the turn." }]);
    await addMessage("ma-m1", 1, "user", [{ kind: "text", text: "I prefer a narrow console." }]);
    await addMessage("ma-m2", 2, "bot", [{ kind: "text", text: "Understood." }]);
    const runId = await completedRun("ma-run-a", "ma-m1");
    expect(await archive.markPending(runId, ctx, new Date())).toBe(true);

    const progress = await runAsTenant(ctx, () =>
      prisma.memoryArchiveProgress.findUnique({ where: { threadId } }),
    );
    expect(progress).toMatchObject({
      spaceId,
      botId,
      userId,
      scope: "isolated",
      generation: 0,
      processedUpToSeq: 0,
      throughSeq: 2,
      pending: true,
    });

    const batch = await archive.loadBatch({ threadId, botId, userId }, ctx);
    expect(batch).not.toBeNull();
    expect(batch!.newSources.map((source) => source.id)).toEqual(["ma-m1"]);
    expect(batch!.messages.map((message) => [message.id, message.role, message.isNew])).toEqual([
      ["ma-m0", "user", false],
      ["ma-m1", "user", true],
      ["ma-m2", "assistant", false],
    ]);
    expect(await archive.hasPending({ threadId, botId, userId }, ctx)).toBe(true);

    const result = await archive.applyBatch(
      batch!,
      [
        {
          content: "Prefer a narrow console.",
          sourceMessageId: "ma-m1",
          sourceQuote: "narrow console",
          category: "preference",
        },
      ],
      ctx,
    );
    expect(result).toEqual({ saved: 1, updated: 0, skipped: 0 });
    expect(
      await runAsTenant(ctx, () =>
        prisma.memoryArchiveProgress.findUnique({ where: { threadId } }),
      ),
    ).toMatchObject({ processedUpToSeq: 2, pending: false });
    expect(await archive.hasPending({ threadId, botId, userId }, ctx)).toBe(false);

    const listed = await facts.list({ botId, scope: "isolated" }, ctx);
    const saved = listed.items.find((fact) => fact.content === "Prefer a narrow console.");
    expect(saved?.provenance).toMatchObject({
      kind: "run",
      messageId: "ma-m1",
      quote: "narrow console",
      category: "preference",
      threadId,
    });
    const raw = await system("inspect synthetic archive bytes", () =>
      db.pool.query<{ content: string; provenance: string }>(
        "SELECT content, provenance FROM semantic_facts WHERE id = $1",
        [saved!.id],
      ),
    );
    expect(raw.rows[0]!.content).toMatch(/^rkz1:/);
    expect(raw.rows[0]!.content).not.toContain("narrow console");
    const work = await runAsTenant(ctx, () =>
      prisma.semanticMemoryIndexOutbox.findMany({ where: { factId: saved!.id } }),
    );
    expect(work).toEqual([expect.objectContaining({ revision: 1, action: "upsert" })]);
    expect(work.every((row) => !("content" in row) && !("provenance" in row))).toBe(true);
    expect(await archive.pending(100)).toEqual([]);
  });

  it("never resurrects a forgotten fact or an exact repeat from a later turn", async () => {
    const listed = await facts.list({ botId, scope: "isolated" }, ctx);
    const saved = listed.items.find((fact) => fact.content === "Prefer a narrow console.")!;
    await facts.forget({ id: saved.id, botId, scope: "isolated", expectedRevision: 1 }, ctx);
    await runAsSystem("retire the synthetic archive thread history", () =>
      prisma.thread.update({
        where: { id: threadId },
        data: { nextMessageSeq: 4 },
      }),
    );
    await addMessage("ma-m3", 3, "user", [
      { kind: "text", text: "I prefer a narrow console, still." },
    ]);
    const runId = await completedRun("ma-run-b", "ma-m3");
    expect(await archive.markPending(runId, ctx, new Date())).toBe(true);
    const batch = await archive.loadBatch({ threadId, botId, userId }, ctx);
    expect(batch!.newSources.map((source) => source.id)).toEqual(["ma-m3"]);
    const result = await archive.applyBatch(
      batch!,
      [
        {
          content: "Prefer a narrow console.",
          sourceMessageId: "ma-m3",
          sourceQuote: "narrow console",
          category: "preference",
        },
      ],
      ctx,
    );
    expect(result).toEqual({ saved: 0, updated: 0, skipped: 1 });
    const after = await facts.list({ botId, scope: "isolated", includeHistory: true }, ctx);
    expect(after.items.filter((fact) => fact.content === "Prefer a narrow console.")).toHaveLength(
      1,
    );
    expect(after.items.find((fact) => fact.id === saved.id)).toMatchObject({
      status: "forgotten",
      revision: 2,
    });
  });

  it("rejects a batch from before a clear and reseeds the next generation", async () => {
    await addMessage("ma-m4", 4, "user", [{ kind: "text", text: "We chose the atlas project." }]);
    const runId = await completedRun("ma-run-c", "ma-m4");
    expect(await archive.markPending(runId, ctx, new Date())).toBe(true);
    const stale = await archive.loadBatch({ threadId, botId, userId }, ctx);
    expect(stale!.generation).toBe(0);
    await system("simulate the guarded clear", async () => {
      await prisma.message.deleteMany({ where: { threadId } });
      await prisma.thread.update({
        where: { id: threadId },
        data: { historyCompactionGeneration: { increment: 1 } },
      });
    });
    const rejected = await archive.applyBatch(
      stale!,
      [
        {
          content: "The atlas project is chosen.",
          sourceMessageId: "ma-m4",
          sourceQuote: "atlas project",
          category: "project",
        },
      ],
      ctx,
    );
    expect(rejected).toEqual({ saved: 0, updated: 0, skipped: 1 });
    expect(
      await runAsTenant(ctx, () =>
        prisma.semanticFact.count({ where: { spaceId, botId, status: "active" } }),
      ),
    ).toBe(0);

    // The same scheduled thread is quiet for the retired generation, then reseeds cleanly.
    expect(await archive.hasPending({ threadId, botId, userId }, ctx)).toBe(false);
    await addMessage("ma-m5", 5, "user", [{ kind: "text", text: "The atlas project shipped." }]);
    const nextRun = await completedRun("ma-run-d", "ma-m5");
    expect(await archive.markPending(nextRun, ctx, new Date())).toBe(true);
    expect(
      await runAsTenant(ctx, () =>
        prisma.memoryArchiveProgress.findUnique({ where: { threadId } }),
      ),
    ).toMatchObject({ generation: 1, processedUpToSeq: 4, throughSeq: 5, pending: true });
    const fresh = await archive.loadBatch({ threadId, botId, userId }, ctx);
    expect(fresh!.generation).toBe(1);
    expect(
      await archive.applyBatch(
        fresh!,
        [
          {
            content: "The atlas project shipped.",
            sourceMessageId: "ma-m5",
            sourceQuote: "atlas project shipped",
            category: "project",
          },
        ],
        ctx,
      ),
    ).toEqual({ saved: 1, updated: 0, skipped: 0 });
  });

  it("keeps direct personal scope, tenant isolation, and one committed apply", async () => {
    await expect(
      archive.loadBatch({ threadId: helperThreadId, botId, userId }, ctx),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      archive.loadBatch({ threadId, botId, userId }, { ...ctx, spaceId: foreignSpaceId }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      await runAsTenant({ spaceId: foreignSpaceId, userId }, () =>
        prisma.memoryArchiveProgress.count(),
      ),
    ).toBe(0);

    await addMessage("ma-m6", 6, "user", [{ kind: "text", text: "Keep answers brief." }]);
    const runId = await completedRun("ma-run-e", "ma-m6");
    expect(await archive.markPending(runId, ctx, new Date())).toBe(true);
    const pointer = (await archive.pending(100)).find((row) => row.threadId === threadId);
    expect(pointer).toBeDefined();
    expect(Object.keys(pointer!).sort()).toEqual([
      "availableAt",
      "botId",
      "spaceId",
      "threadId",
      "userId",
    ]);
    const batch = await archive.loadBatch({ threadId, botId, userId }, ctx);
    const change = {
      content: "Keep replies brief.",
      sourceMessageId: "ma-m6",
      sourceQuote: "Keep answers brief",
      category: "preference" as const,
    };
    const outcomes = await Promise.allSettled([
      archive.applyBatch(batch!, [change], ctx),
      archive.applyBatch(batch!, [change], ctx),
    ]);
    const applied = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    expect(applied.reduce((sum, value) => sum + value.saved, 0)).toBe(1);
    expect(
      (await facts.list({ botId, scope: "isolated" }, ctx)).items.filter(
        (fact) => fact.content === "Keep replies brief.",
      ),
    ).toHaveLength(1);
  });
});
