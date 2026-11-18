import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { lessonOutcomeCounts, recordLessonUse, settleLessonUse } from "./lesson-usage.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

// The implementation owner never runs this. The isolated runner creates a random
// database AND runtime role; refuse a production/default target even if opted in.
const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const stamp = randomUUID();
const userId = `lu-user-${stamp}`;
const orgId = `lu-org-${stamp}`;
const spaceId = `lu-space-${stamp}`;
const foreignSpaceId = `lu-foreign-${stamp}`;
const botId = `lu-bot-${stamp}`;
const threadId = `lu-thread-${stamp}`;
const taskId = `lu-task-${stamp}`;
const runId = `lu-run-${stamp}`;
const secondRunId = `lu-run-2-${stamp}`;

postgres("lesson usage (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const tenant = { spaceId, userId };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !url.pathname.slice(1).startsWith("rkz_") ||
      !decodeURIComponent(url.username).startsWith("rkz_") ||
      url.pathname === "/rakazo"
    )
      throw new Error(
        "Lesson usage PostgreSQL tests require a fresh rkz_ database and runtime login.",
      );
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await runAsSystem("synthetic lesson-usage fixture", async () => {
      await prisma.user.create({
        data: { id: userId, name: "Lesson fixture", email: `${userId}@example.test` },
      });
      await prisma.organization.create({
        data: { id: orgId, name: "Fixture", slug: orgId, createdAt: new Date() },
      });
      await prisma.member.create({
        data: {
          id: `lu-member-${stamp}`,
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
            id: `lu-member-${id}`,
            spaceId: id,
            organizationId: orgId,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
        });
      }
      await prisma.bot.create({
        data: { id: botId, spaceId, userId, name: "Fixture bot", color: "ink" },
      });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
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
      for (const id of [runId, secondRunId])
        await prisma.run.create({
          data: {
            id,
            spaceId,
            botId,
            threadId,
            taskId,
            userId,
            status: "completed",
            trigger: "user",
          },
        });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("synthetic lesson-usage fixture cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: orgId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("records, settles and counts each run's injected lessons without duplicates", async () => {
    await runAsTenant(tenant, () =>
      recordLessonUse(prisma, {
        spaceId,
        botId,
        runId,
        lessons: [
          { id: "lesson-a", revision: 2 },
          { id: "lesson-a", revision: 2 },
          { id: "lesson-b", revision: 1 },
        ],
      }),
    );
    // A requeued attempt re-records the same lessons; the primary key absorbs it.
    await runAsTenant(tenant, () =>
      recordLessonUse(prisma, {
        spaceId,
        botId,
        runId,
        lessons: [
          { id: "lesson-a", revision: 3 },
          { id: "lesson-b", revision: 1 },
        ],
      }),
    );
    await runAsTenant(tenant, () =>
      recordLessonUse(prisma, {
        spaceId,
        botId,
        runId: secondRunId,
        lessons: [{ id: "lesson-a", revision: 3 }],
      }),
    );
    expect(
      await runAsSystem("inspect synthetic lesson usage", () =>
        prisma.lessonUsage.count({ where: { runId } }),
      ),
    ).toBe(2);
    await runAsTenant(tenant, () => settleLessonUse(prisma, { spaceId, runId, outcome: "failed" }));
    const settled = await runAsSystem("inspect synthetic lesson usage", () =>
      prisma.lessonUsage.findMany({
        where: { runId },
        select: { lessonId: true, outcome: true, settledAt: true, firstRevision: true },
        orderBy: { lessonId: "asc" },
      }),
    );
    expect(settled.map((row) => row.firstRevision)).toEqual([2, 1]);
    expect(settled.map((row) => [row.lessonId, row.outcome, row.settledAt !== null])).toEqual([
      ["lesson-a", "failed", true],
      ["lesson-b", "failed", true],
    ]);
    expect(
      await runAsSystem("inspect synthetic lesson usage", () =>
        prisma.lessonUsage.count({ where: { runId: secondRunId, outcome: null } }),
      ),
    ).toBe(1);
    await expect(
      runAsTenant(tenant, () => lessonOutcomeCounts(prisma, "lesson-a")),
    ).resolves.toEqual({ completed: 0, failed: 1, denied: 0 });
    await runAsTenant(tenant, () =>
      settleLessonUse(prisma, { spaceId, runId: secondRunId, outcome: "completed" }),
    );
    await expect(
      runAsTenant(tenant, () => lessonOutcomeCounts(prisma, "lesson-a")),
    ).resolves.toEqual({ completed: 1, failed: 1, denied: 0 });
  });

  it("hides one space's usage from another and cascades with its run", async () => {
    expect(
      await runAsTenant({ spaceId: foreignSpaceId, userId }, () => prisma.lessonUsage.count()),
    ).toBe(0);
    await runAsSystem("delete a synthetic run", () => prisma.run.delete({ where: { id: runId } }));
    expect(
      await runAsSystem("inspect synthetic lesson usage", () =>
        prisma.lessonUsage.count({ where: { runId } }),
      ),
    ).toBe(0);
    expect(
      await runAsSystem("inspect synthetic lesson usage", () =>
        prisma.lessonUsage.count({ where: { runId: secondRunId } }),
      ),
    ).toBe(1);
  });
});
