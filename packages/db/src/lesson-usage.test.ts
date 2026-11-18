import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { lessonOutcomeCounts, recordLessonUse, settleLessonUse } from "./lesson-usage.js";

function fixture(groups: Array<{ outcome: string | null; count: number }> = []) {
  const createMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
  const updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
  const groupBy = vi.fn(async (_args: unknown) =>
    groups.map((group) => ({ outcome: group.outcome, _count: { _all: group.count } })),
  );
  return {
    db: { lessonUsage: { createMany, updateMany, groupBy } } as unknown as PrismaClient,
    createMany,
    updateMany,
    groupBy,
  };
}

describe("lesson usage bookkeeping", () => {
  it("records the first shown revisions and lets the run/lesson key absorb repeats", async () => {
    const f = fixture();
    await recordLessonUse(f.db, {
      spaceId: "space-a",
      botId: "bot-a",
      runId: "run-a",
      lessons: [
        { id: "lesson-1", revision: 2 },
        { id: "lesson-2", revision: 1 },
      ],
    });
    expect(f.createMany).toHaveBeenCalledWith({
      data: [
        {
          spaceId: "space-a",
          botId: "bot-a",
          lessonId: "lesson-1",
          firstRevision: 2,
          runId: "run-a",
        },
        {
          spaceId: "space-a",
          botId: "bot-a",
          lessonId: "lesson-2",
          firstRevision: 1,
          runId: "run-a",
        },
      ],
      skipDuplicates: true,
    });
    await recordLessonUse(f.db, {
      spaceId: "space-a",
      botId: "bot-a",
      runId: "run-a",
      lessons: [],
    });
    expect(f.createMany).toHaveBeenCalledTimes(1);
  });

  it("settles only the named run's rows", async () => {
    const f = fixture();
    await settleLessonUse(f.db, { spaceId: "space-a", runId: "run-a", outcome: "denied" });
    expect(f.updateMany).toHaveBeenCalledWith({
      where: { spaceId: "space-a", runId: "run-a", settledAt: null },
      data: { outcome: "denied", settledAt: expect.any(Date) },
    });
  });

  it("counts settled outcomes and ignores null or unknown ones", async () => {
    const f = fixture([
      { outcome: "completed", count: 2 },
      { outcome: "failed", count: 3 },
      { outcome: "denied", count: 1 },
      { outcome: null, count: 9 },
    ]);
    await expect(lessonOutcomeCounts(f.db, "lesson-1")).resolves.toEqual({
      completed: 2,
      failed: 3,
      denied: 1,
    });
    expect(f.groupBy).toHaveBeenCalledWith({
      by: ["outcome"],
      where: { lessonId: "lesson-1" },
      _count: { _all: true },
    });
  });
});
