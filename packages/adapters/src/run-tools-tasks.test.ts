import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { taskTools } from "./run-tools-tasks.js";

type Row = { id: string; name: string; threadId: string | null; spaceId: string; botId: string };

/**
 * The bot's routines in its own chat, the group and none (made on the web), plus another member's
 * in the group, filtered like the database would.
 */
function groupRun() {
  const rows: Row[] = [
    { id: "routine-dm", name: "Daily check", threadId: "dm-thread", spaceId: "s", botId: "b" },
    { id: "routine-group", name: "Digest", threadId: "group-thread", spaceId: "s", botId: "b" },
    { id: "routine-web", name: "Weekly", threadId: null, spaceId: "s", botId: "b" },
    { id: "routine-peer", name: "Peer", threadId: "group-thread", spaceId: "s", botId: "other" },
  ];
  const matches = (where: Record<string, unknown>) =>
    rows.filter((row) =>
      (["id", "name", "threadId", "spaceId", "botId"] as const).every(
        (key) => where[key] === undefined || where[key] === row[key],
      ),
    );
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    matches(where).map((row) => ({ ...row, prompt: "p", crons: ["0 9 * * *"], active: true })),
  );
  const findFirst = vi.fn(
    async ({ where }: { where: Record<string, unknown> }) => matches(where)[0] ?? null,
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const ctx = {
    deps: {
      prisma: {
        routine: { findMany, findFirst, deleteMany, updateMany: vi.fn() },
        scratchpadItem: { findMany: vi.fn(async () => []) },
        taughtSkill: { findMany: vi.fn(async () => []) },
        agentSkill: { findMany: vi.fn(async () => []) },
      },
      jobs: { cancel: vi.fn(async () => undefined) },
    },
    run: { id: "run-1", spaceId: "s", userId: "u", threadId: "group-thread" },
    bot: { id: "b", name: "Bot" },
    thread: { id: "group-thread", groupId: "group-1" },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    ({ name, args, finish: async (result: unknown) => result }) as unknown as ToolCall;
  return { ctx, call, deleteMany };
}

describe("routine tools in a group run", () => {
  it("lists the bot's routines from every chat and marks the group's own", async () => {
    const { ctx, call } = groupRun();
    const marks = [
      ["routine-dm", false],
      ["routine-group", true],
      ["routine-web", false],
    ];
    const note =
      "inThisChat marks the routines this group chat can change; change the others from the bot's own chat.";
    const listed = (await taskTools.schedule_list!(ctx, call("schedule_list"))) as {
      note: string;
      routines: { routineId: string; inThisChat: boolean }[];
    };
    expect(listed.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(listed.note).toBe(note);
    const catalog = (await taskTools.task_catalog!(ctx, call("task_catalog"))) as {
      routinesNote: string;
      routines: typeof listed.routines;
    };
    expect(catalog.routines.map((row) => [row.routineId, row.inThisChat])).toEqual(marks);
    expect(catalog.routinesNote).toBe(note);
  });

  it("refuses to change a listed routine from another chat, saying where it is", async () => {
    const { ctx, call, deleteMany } = groupRun();
    const error = {
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    };
    await expect(
      taskTools.schedule_update!(
        ctx,
        call("schedule_update", { routineId: "routine-dm", name: "x" }),
      ),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { name: "Daily check" })),
    ).resolves.toEqual(error);
    await expect(
      taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId: "routine-web" })),
    ).resolves.toEqual(error);
    for (const routineId of ["made-up", "routine-peer"]) {
      await expect(
        taskTools.schedule_cancel!(ctx, call("schedule_cancel", { routineId })),
      ).resolves.toEqual({ error: "Schedule not found." });
      await expect(
        taskTools.schedule_update!(ctx, call("schedule_update", { routineId, name: "x" })),
      ).resolves.toEqual({ error: "Schedule not found." });
    }
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

/** This chat's finished runs, filtered like the database would. */
function reflectionRun(
  finishedRunIds: string[] = ["run-finished"],
  skills: unknown[] = [],
  sourceMessageId: string | null = null,
) {
  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const id = where.id;
    if (typeof id === "string") return finishedRunIds.includes(id) ? { id } : null;
    return finishedRunIds.length ? { id: finishedRunIds[finishedRunIds.length - 1] } : null;
  });
  const skillFindFirst = vi.fn(async () => skills[0] ?? null);
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: {
      prisma: { run: { findFirst }, taughtSkill: { findFirst: skillFindFirst } },
      jobs: { enqueue },
    },
    run: { id: "run-current", spaceId: "space-1", userId: "user-1", sourceMessageId },
    runId: "run-current",
    bot: { id: "bot-1", name: "Bot" },
    thread: { id: "thread-1", groupId: null },
    source: { ownerStartedRun: true },
    tools: { offered: [] },
  } as unknown as RunContext;
  const call = (args: Record<string, unknown> = {}) =>
    ({
      name: "reflect_on_run",
      args,
      finish: async (result: unknown) => result,
    }) as unknown as ToolCall;
  return { ctx, call, findFirst, skillFindFirst, enqueue };
}

describe("reflect_on_run", () => {
  const savedSelfEvolution = process.env.SELF_EVOLUTION;
  beforeEach(() => {
    process.env.SELF_EVOLUTION = "1";
  });
  afterEach(() => {
    if (savedSelfEvolution === undefined) delete process.env.SELF_EVOLUTION;
    else process.env.SELF_EVOLUTION = savedSelfEvolution;
  });

  it("queues a review of the finished run it was asked for", async () => {
    const { ctx, call, enqueue } = reflectionRun();
    await expect(taskTools.reflect_on_run!(ctx, call({ runId: "run-finished" }))).resolves.toEqual({
      ok: true,
      runId: "run-finished",
      hint: "Short lessons the review saves appear on this bot's memory page under Experience; a draft skill card appears in this chat only if something reusable turns up, and the user must review and save it.",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      name: "harness.reflect",
      payload: { runId: "run-finished" },
      replaceKey: "harness.reflect:run-finished",
      maxAttempts: 2,
    });
  });

  it("leaves the asking message out of the review's follow-up reading", async () => {
    const { ctx, call, enqueue } = reflectionRun(["run-finished"], [], "message-that-asked");
    await taskTools.reflect_on_run!(ctx, call({ runId: "run-finished" }));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { runId: "run-finished", exceptMessageId: "message-that-asked" },
      }),
    );
  });

  it("refuses when reviewing runs is turned off, without queueing", async () => {
    const { ctx, call, enqueue } = reflectionRun();
    delete process.env.SELF_EVOLUTION;
    try {
      await expect(taskTools.reflect_on_run!(ctx, call())).resolves.toEqual({
        error: "Reviewing a run is turned off in this deployment.",
      });
    } finally {
      if (savedSelfEvolution === undefined) delete process.env.SELF_EVOLUTION;
      else process.env.SELF_EVOLUTION = savedSelfEvolution;
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports an unknown run id as not a finished run here, without queueing", async () => {
    const { ctx, call, enqueue } = reflectionRun();
    await expect(taskTools.reflect_on_run!(ctx, call({ runId: "run-elsewhere" }))).resolves.toEqual(
      { error: "That run is not a finished run in this chat." },
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports the run's existing skill instead of queueing a second review", async () => {
    const { ctx, call, enqueue } = reflectionRun(
      ["run-finished"],
      [
        {
          id: "skill-9",
          name: "Daily Notes",
          status: "saved",
          recording: { evidence: { runIds: ["run-finished"] } },
        },
      ],
    );
    await expect(taskTools.reflect_on_run!(ctx, call({ runId: "run-finished" }))).resolves.toEqual({
      ok: true,
      runId: "run-finished",
      alreadyReviewed: true,
      skill: { id: "skill-9", name: "Daily Notes", status: "saved" },
      hint: 'This run already produced the skill "Daily Notes" (saved); no new draft will be created. Edit that skill instead, or delete it first to review this run again.',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reviews the latest finished run when none was named", async () => {
    const { ctx, call, findFirst, enqueue } = reflectionRun();
    await expect(taskTools.reflect_on_run!(ctx, call())).resolves.toMatchObject({
      ok: true,
      runId: "run-finished",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        status: { in: ["completed", "failed", "cancelled"] },
        id: { not: "run-current" },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses in a group, where the card would land in another chat", async () => {
    const { ctx, call, enqueue } = reflectionRun();
    (ctx.thread as { groupId: string | null }).groupId = "group-1";
    await expect(taskTools.reflect_on_run!(ctx, call())).resolves.toEqual({
      error: "Run reviews happen in the bot's own chat.",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
