import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  failRunBeforeTurn,
  requeueComputerRun,
  startNextGroupMember,
  startNextWaitingRun,
} from "./run-lifecycle.js";
import { notifyRun } from "./run-notifications.js";

vi.mock("./run-notifications.js", () => ({ notifyRun: vi.fn(async () => undefined) }));
vi.mock("./background-helpers.js", () => ({ returnHelperOutcome: vi.fn(async () => undefined) }));

function deps(next: { id: string } | null) {
  const findFirst = vi.fn(async () => next);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest other due run of the bot, a person's turn ahead of a background one", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: {
          botId: "bot",
          status: "queued",
          id: { not: "finished" },
          trigger: { notIn: ["routine", "webhook", "created", "tickets", "bot_message"] },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a background run when no person's turn is waiting", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "routine-waiting" });
    const enqueue = vi.fn(async () => undefined);
    const fallbackDeps = {
      prisma: { run: { findFirst } },
      jobs: { enqueue },
    } as unknown as ExecutorDeps;
    await startNextWaitingRun(fallbackDeps, "bot", "finished");
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[1]?.[0]).toMatchObject({
      where: { botId: "bot", status: "queued", id: { not: "finished" } },
    });
    expect(findFirst.mock.calls[1]?.[0].where).not.toHaveProperty("trigger");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("routine-waiting"));
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("waking the next member of a group send", () => {
  it("starts the next turn of the same send as soon as this one ends", async () => {
    const f = deps({ id: "member-2" });
    await startNextGroupMember(f.deps, {
      threadId: "thread",
      sourceMessageId: "message",
      groupTurn: 0,
    });
    expect(f.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        threadId: "thread",
        sourceMessageId: "message",
        trigger: "user",
        status: "queued",
        groupTurn: { gt: 0 },
      },
      orderBy: [{ groupTurn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("member-2"));
  });

  it("leaves a run that is not part of a group send alone", async () => {
    const f = deps({ id: "member-2" });
    await startNextGroupMember(f.deps, {
      threadId: "thread",
      sourceMessageId: "message",
      groupTurn: null,
    });
    await startNextGroupMember(f.deps, {
      threadId: "thread",
      sourceMessageId: null,
      groupTurn: 0,
    });
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("requeueing a run for a busy computer", () => {
  function requeueDeps(released: boolean, trigger = "user") {
    const updateMany = vi.fn(async (_args: { data: { wakeAt: Date | null } }) => ({
      count: released ? 1 : 0,
    }));
    const findUnique = vi.fn(async () => ({
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      trigger,
    }));
    const append = vi.fn(async () => ({ seq: 1 }));
    const enqueue = vi.fn(async () => undefined);
    return {
      deps: {
        prisma: { run: { updateMany, findUnique } },
        events: { append },
        jobs: { enqueue },
      } as unknown as ExecutorDeps,
      updateMany,
      append,
      enqueue,
    };
  }

  it("writes a run waiting for the release as due now and schedules no retry", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = requeueDeps(true);
      await requeueComputerRun(f.deps, "run", "worker", 1, null, false, true);
      expect(f.updateMany.mock.calls[0]?.[0]).toMatchObject({
        data: { status: "queued", wakeAt: new Date("2026-10-28T12:00:00Z") },
      });
      expect(f.enqueue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a person's waiting turn as waiting for the computer, and a routine's as nothing", async () => {
    const person = requeueDeps(true);
    await requeueComputerRun(person.deps, "run", "worker", 1, null, false, true);
    expect(person.append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "run",
        type: "thread.progress",
        lease: { owner: "worker", fence: 1 },
        payload: { text: "Waiting for the computer", activity: true },
      }),
    );

    const routine = requeueDeps(true, "routine");
    await requeueComputerRun(routine.deps, "run", "worker", 1, null, false, true);
    expect(routine.append).not.toHaveBeenCalled();
  });

  it("gives a run that found the computer busy a bounded future retry", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = requeueDeps(true);
      await requeueComputerRun(f.deps, "run", "worker", 1, null);
      expect(f.updateMany.mock.calls[0]?.[0]).toMatchObject({
        data: { status: "queued", wakeAt: new Date("2026-10-28T12:00:00.250Z") },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({
        ...runContinueJob("run"),
        availableAt: new Date("2026-10-28T12:00:00.250Z"),
      });
      expect(f.append).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enqueues nothing when another worker already owns the run", async () => {
    const f = requeueDeps(false);
    await requeueComputerRun(f.deps, "run", "worker", 1, null);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("failing a run before its turn", () => {
  it("brings a background helper's failure back to its chat instead of pushing a notice", async () => {
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const deps = { events: { finalizeRun } } as unknown as ExecutorDeps;
    const run = (trigger: string) => ({
      id: `${trigger}-run`,
      spaceId: "space",
      userId: "user",
      botId: "bot",
      threadId: "thread",
      taskId: "task",
      trigger,
    });
    const lease = { attemptId: "attempt", workerId: "worker", fence: 1 };

    await failRunBeforeTurn(deps, run("helper"), "Chief", lease, "model not connected");
    expect(returnHelperOutcome).toHaveBeenCalledExactlyOnceWith(deps, run("helper"), {
      status: "failed",
      text: "model not connected",
    });
    expect(notifyRun).not.toHaveBeenCalled();

    await failRunBeforeTurn(deps, run("user"), "Chief", lease, "model not connected");
    expect(notifyRun).toHaveBeenCalledOnce();
    expect(returnHelperOutcome).toHaveBeenCalledOnce();
  });
});
