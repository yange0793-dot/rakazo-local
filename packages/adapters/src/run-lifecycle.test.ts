import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { failRunBeforeTurn, requeueComputerRun, startNextWaitingRun } from "./run-lifecycle.js";
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
  it("starts the oldest other due run of the bot, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          status: "queued",
          id: { not: "finished" },
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

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("requeueing a run for a busy computer", () => {
  function requeueDeps(released: boolean) {
    const updateMany = vi.fn(async (_args: { data: { wakeAt: Date | null } }) => ({
      count: released ? 1 : 0,
    }));
    const enqueue = vi.fn(async () => undefined);
    return {
      deps: { prisma: { run: { updateMany } }, jobs: { enqueue } } as unknown as ExecutorDeps,
      updateMany,
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
