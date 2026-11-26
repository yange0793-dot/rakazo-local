import type { BackgroundJobHandlers, JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  answerRunInput,
  finalizeComputerControlRelease,
  pauseRunForInput,
  sendUserMessage,
} from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { claimRun, requeueComputerRun } from "./run-lifecycle.js";
import { RunJobPublisher, RunStarter, RunWorkerHost } from "./run-wakeup.js";
import { refreshTakeoverContinuePlan, takeoverContinuePlan } from "./takeover-resume.js";

afterEach(() => vi.useRealTimers());

// Apply the production Prisma predicates, including SQL's non-matching null ranges.
// Unknown predicates fail the test instead of silently accepting a claim.
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === "OR") return value.some((term: any) => matches(row, term));
    if (key === "AND") return value.every((term: any) => matches(row, term));
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    if (value !== null && typeof value === "object") {
      if ("some" in value) return row[key].some((item: any) => matches(item, value.some));
      if ("in" in value) return value.in.includes(row[key]);
      if ("notIn" in value) return !value.notIn.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
      if ("lte" in value) return row[key] != null && row[key] <= value.lte;
      if ("gt" in value) return row[key] != null && row[key] > value.gt;
      throw new Error(`Unsupported predicate: ${key}`);
    }
    return row[key] === value;
  });
}

function fixture(status = "queued") {
  vi.useFakeTimers({ now: new Date("2026-11-23T00:00:00Z") });
  const task = { prompt: "Original task" };
  const steering: Array<{ id: string; runId: string; claimedAt: Date | null }> = [];
  const row = {
    id: "run",
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    userId: "user",
    taskId: "task",
    ticketId: null,
    workControlEpoch: null,
    workRequirementsVersion: null,
    trigger: "messaging" as const,
    sourceMessageId: "source",
    sourceMessage: { blocks: [{ kind: "text", text: task.prompt }] },
    task,
    status,
    checkpoint: null as string | null,
    leaseFence: 0,
    leaseOwner: null as string | null,
    leaseExpiresAt: null as Date | null,
    wakeAt: null as Date | null,
    createdAt: new Date(0),
    firstResponseAt: new Date(0),
    steeringMessages: steering,
    bot: { computerId: "computer" },
  };
  const messages = [
    {
      id: "source",
      threadId: row.threadId,
      runId: null as string | null,
      role: "user",
      clientNonce: "original-send",
      blocks: row.sourceMessage.blocks as MessageBlock[],
      seq: 1,
    },
    {
      id: "ask",
      threadId: row.threadId,
      runId: row.id,
      role: "bot",
      clientNonce: null as string | null,
      blocks: [{ kind: "ask", text: "Which city?", status: "pending" }] as MessageBlock[],
      seq: 2,
    },
  ];
  const computer = {
    id: "computer",
    spaceId: row.spaceId,
    controlRunId: row.id as string | null,
    controlBotId: row.botId as string | null,
    controlLeaseId: "control" as string | null,
    controlHolder: "user",
  };
  const updateMany = vi.fn(async ({ where, data }) => {
    if (!matches(row, where)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const findMany = vi.fn(async ({ where }) => (matches(row, where) ? [{ ...row }] : []));
  const db = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
    run: {
      updateMany,
      findMany,
      findUnique: vi.fn(async () => ({ ...row })),
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      findFirst: vi.fn(async ({ where }) => (matches(row, where) ? { ...row } : null)),
    },
    computerExecutionLease: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    attempt: {
      updateMany: vi.fn(async ({ where }) => ({
        count: matches(
          { id: "attempt", runId: row.id, fence: row.leaseFence, status: "running" },
          where,
        )
          ? 1
          : 0,
      })),
    },
    computer: {
      findFirst: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!matches(computer, where)) return { count: 0 };
        Object.assign(computer, data);
        return { count: 1 };
      }),
    },
    bot: { findFirst: vi.fn(async () => null) },
    task: {
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(task, data);
        return { count: 1 };
      }),
    },
    message: {
      findUnique: vi.fn(async ({ where }) =>
        messages.find((message) => matches(message, where.threadId_clientNonce)),
      ),
      findFirst: vi.fn(async ({ where }) => messages.find((message) => matches(message, where))),
      create: vi.fn(async ({ data }) => {
        const message = { id: `message-${messages.length}`, ...data };
        messages.push(message);
        return message;
      }),
      update: vi.fn(async ({ where, data }) => {
        const message = messages.find((message) => message.id === where.id)!;
        Object.assign(message, data);
        return message;
      }),
    },
    steeringMessage: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }) => {
        const entry = { id: "steering", claimedAt: null, ...data };
        steering.push(entry);
        return entry;
      }),
    },
    thread: {
      update: vi.fn(async () => ({ nextEventSeq: 3, nextMessageSeq: 4, spaceId: row.spaceId })),
    },
    event: {
      create: vi.fn(async ({ data }) => ({ id: "event", createdAt: new Date(), ...data })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    ...db,
    $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  } as unknown as PrismaClient;
  const realtime = new InMemoryRealtimeFanout();
  const starter = new RunStarter(realtime);
  const publisher = new RunJobPublisher(
    prisma,
    { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() } as JobPublisher,
    starter,
  );
  const deps = { prisma, jobs: publisher } as unknown as ExecutorDeps;
  const host = new RunWorkerHost(prisma, realtime, starter);
  return { row, task, steering, messages, computer, db, deps, prisma, starter, publisher, host };
}

async function pauseForInput(f: ReturnType<typeof fixture>) {
  expect(
    await pauseRunForInput(f.prisma, {
      spaceId: f.row.spaceId,
      threadId: f.row.threadId,
      botId: f.row.botId,
      runId: f.row.id,
      attemptId: "attempt",
      leaseOwner: f.row.leaseOwner!,
      leaseFence: f.row.leaseFence,
      blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
    }),
  ).toBeTruthy();
  expect(f.row).toMatchObject({
    status: "waiting_input",
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

function answer(f: ReturnType<typeof fixture>, messageId = f.messages.at(-1)!.id) {
  return answerRunInput(f.prisma, {
    spaceId: f.row.spaceId,
    threadId: f.row.threadId,
    runId: f.row.id,
    messageId,
    answeredByUserId: f.row.userId,
    answer: "Paris",
  });
}

function handback(f: ReturnType<typeof fixture>, reason: "done" | "skipped") {
  return finalizeComputerControlRelease(f.prisma, {
    spaceId: f.row.spaceId,
    computerId: f.computer.id,
    botId: f.row.botId,
    runId: f.row.id,
    leaseId: f.computer.controlLeaseId,
    holder: "bot",
    reason,
  });
}

describe("durable permission to resume a run", () => {
  it.each([null, new Date(0)])(
    "never claims unanswered input, even with wakeAt=%s or unrelated steering",
    async (wakeAt) => {
      const f = fixture("waiting_input");
      f.row.wakeAt = wakeAt;
      f.steering.push({ id: "steering", runId: f.row.id, claimedAt: null });
      const start = vi.spyOn(f.starter, "start");
      await f.publisher.enqueue(runContinueJob(f.row.id));
      expect(start).not.toHaveBeenCalled();
      expect(f.row.wakeAt).toEqual(wakeAt);
      expect(await claimRun(f.deps, { ...f.row }, "worker")).toBeUndefined();
      expect(f.row).toMatchObject({ status: "waiting_input", leaseFence: 0 });
    },
  );

  it("does not turn a send nonce replay into an answer", async () => {
    const f = fixture("waiting_input");
    const result = await sendUserMessage(f.prisma, {
      ...f.row,
      prompt: f.task.prompt,
      blocks: [{ kind: "text", text: f.task.prompt }],
      clientNonce: "original-send",
    });
    expect(result.runId).toBe(f.row.id);
    await f.publisher.enqueue(runContinueJob(result.runId!));
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toBeUndefined();
    expect(f.row).toMatchObject({ status: "waiting_input", wakeAt: null, leaseFence: 0 });
    expect(f.task.prompt).toBe("Original task");
    expect(f.db.message.create).not.toHaveBeenCalled();
  });

  it("rejects a queued scan snapshot after the run has paused", async () => {
    const f = fixture();
    const findMany = f.db.run.findMany.getMockImplementation()!;
    f.db.run.findMany.mockImplementationOnce(async (query) => {
      const scanned = await findMany(query);
      expect(scanned).toHaveLength(1);
      expect(await claimRun(f.deps, { ...f.row }, "other-worker")).toMatchObject({ fence: 1 });
      await pauseForInput(f);
      return scanned;
    });
    const handler = vi.fn(async () => claimRun(f.deps, { ...f.row }, "stale-scanner"));
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(await handler.mock.results[0]!.value).toBeUndefined();
      expect(f.row).toMatchObject({ status: "waiting_input", leaseFence: 1 });
    } finally {
      await f.host.stop();
    }
  });

  it("rejects a wake that was published before another worker paused for input", async () => {
    const f = fixture();
    let release!: () => void;
    const beforeClaim = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await beforeClaim;
      return claimRun(f.deps, { ...f.row }, "notified-worker");
    });
    f.starter.attach({ "run.continue": handler } as unknown as BackgroundJobHandlers);
    try {
      await f.publisher.enqueue(runContinueJob(f.row.id));
      expect(f.row.wakeAt).not.toBeNull();
      expect(await claimRun(f.deps, { ...f.row }, "other-worker")).toMatchObject({ fence: 1 });
      await pauseForInput(f);
      release();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(await handler.mock.results[0]!.value).toBeUndefined();
      expect(f.row).toMatchObject({ status: "waiting_input", wakeAt: null, leaseFence: 1 });
    } finally {
      release();
      await f.starter.stop();
    }
  });

  it("does not let an old answer replay resume the next unanswered pause", async () => {
    const f = fixture("waiting_input");
    expect(await answer(f, "ask")).toBe(true);
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toMatchObject({ fence: 1 });
    await pauseForInput(f);
    expect(await answer(f, "ask")).toBe(false);
    await f.publisher.enqueue(runContinueJob(f.row.id));
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toBeUndefined();
    expect(f.row).toMatchObject({ status: "waiting_input", wakeAt: null, leaseFence: 1 });
    expect(f.messages.at(-1)?.blocks).toEqual([
      { kind: "ask", text: "Which city?", status: "pending" },
    ]);
  });

  it.each([false, true])(
    "rechecks durable permission after dueAgain (answer committed: %s)",
    async (answered) => {
      const f = fixture();
      let release!: () => void;
      const finishing = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claims: number[] = [];
      const handler = vi.fn(async (_payload, execution) => {
        const claimed = await claimRun(f.deps, { ...f.row }, "worker");
        if (!claimed) return;
        claims.push(claimed.fence);
        execution.onRunStarted();
        if (claims.length === 1) await finishing;
      });
      f.starter.attach({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      try {
        await f.publisher.enqueue(runContinueJob(f.row.id));
        await vi.waitFor(() => expect(claims).toEqual([1]));
        await f.publisher.enqueue(runContinueJob(f.row.id));
        // A local notification admitted before pause may already be in dueAgain.
        f.starter.start(f.row.id);
        await pauseForInput(f);
        if (answered) {
          expect(await answer(f)).toBe(true);
          expect(f.row.status).toBe("queued");
          await f.publisher.enqueue(runContinueJob(f.row.id));
        }
        release();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(1);
        expect(claims).toEqual(answered ? [1, 2] : [1]);
        expect(f.row.status).toBe(answered ? "running" : "waiting_input");
        expect(f.task.prompt).toBe(answered ? "Paris" : "Original task");
      } finally {
        release();
        await f.starter.stop();
      }
    },
  );

  it.each(["leased", "running"])(
    "recovers an expired %s lease under a new fence",
    async (status) => {
      const f = fixture(status);
      Object.assign(f.row, {
        leaseOwner: "lost-worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(0),
      });
      expect(await claimRun(f.deps, { ...f.row }, "replacement")).toMatchObject({ fence: 8 });
      expect(f.row).toMatchObject({ status: "running", leaseOwner: "replacement", leaseFence: 8 });
      expect(f.row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    },
  );

  it.each(["leased", "running"])("does not steal a live %s lease", async (status) => {
    const f = fixture(status);
    Object.assign(f.row, {
      leaseOwner: "owner",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const start = vi.spyOn(f.starter, "start");
    await f.publisher.enqueue(runContinueJob(f.row.id));
    expect(start).not.toHaveBeenCalled();
    expect(f.row.wakeAt).toBeNull();
    expect(await claimRun(f.deps, { ...f.row }, "competitor")).toBeUndefined();
    expect(f.row.leaseFence).toBe(7);
  });

  it("does not reuse an old fence after another recovery's lease also expires", async () => {
    const f = fixture("running");
    Object.assign(f.row, { leaseOwner: "lost-worker", leaseFence: 7, leaseExpiresAt: new Date(0) });
    const stale = { ...f.row };
    expect(await claimRun(f.deps, stale, "replacement")).toMatchObject({ fence: 8 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await claimRun(f.deps, stale, "stale-worker")).toBeUndefined();
    expect(await claimRun(f.deps, { ...f.row }, "new-worker")).toMatchObject({ fence: 9 });
  });

  it.each([false, true])(
    "keeps a takeover held without new work (old steering: %s)",
    async (old) => {
      const f = fixture("waiting_takeover");
      if (old) f.steering.push({ id: "old", runId: f.row.id, claimedAt: new Date(0) });
      const start = vi.spyOn(f.starter, "start");
      await f.publisher.enqueue(runContinueJob(f.row.id));
      expect(start).not.toHaveBeenCalled();
      expect(await claimRun(f.deps, { ...f.row }, "worker")).toBeUndefined();
      expect(f.row).toMatchObject({ status: "waiting_takeover", wakeAt: null, leaseFence: 0 });
    },
  );

  it("resumes new external steering while preserving the user's screen hold", async () => {
    const f = fixture("waiting_takeover");
    const result = await sendUserMessage(f.prisma, {
      ...f.row,
      prompt: "Use the files while I finish on screen",
      blocks: [{ kind: "text", text: "Use the files while I finish on screen" }],
      clientNonce: "new-message",
    });
    expect(result.runId).toBe(f.row.id);
    expect(f.row.status).toBe("waiting_takeover");
    expect(f.steering).toMatchObject([{ runId: f.row.id, claimedAt: null }]);
    const plan = takeoverContinuePlan(f.row);
    await f.publisher.enqueue(runContinueJob(f.row.id));
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toMatchObject({ fence: 1 });
    expect(refreshTakeoverContinuePlan(plan, f.row)).toMatchObject({
      heldForTakeover: true,
      resumeCheckpoint: null,
    });
    expect(f.computer.controlHolder).toBe("user");
  });

  it.each(["done", "skipped"] as const)(
    "preserves a %s handback racing a stale claim",
    async (reason) => {
      const f = fixture("waiting_takeover");
      const observed = { ...f.row };
      expect(await handback(f, reason)).toEqual({ runId: f.row.id });
      expect(await claimRun(f.deps, observed, "stale-worker")).toBeUndefined();
      const checkpoint = reason === "done" ? "takeover" : "takeover-skipped";
      expect(takeoverContinuePlan(f.row)).toMatchObject({
        heldForTakeover: false,
        resumeCheckpoint: checkpoint,
      });
      expect(await claimRun(f.deps, { ...f.row }, "worker")).toMatchObject({ fence: 1 });
    },
  );

  it("observes a handback stamped after leasing without stealing the worker's lease", async () => {
    const f = fixture("waiting_takeover");
    f.steering.push({ id: "steering", runId: f.row.id, claimedAt: null });
    const plan = takeoverContinuePlan(f.row);
    f.db.run.findUniqueOrThrow.mockImplementationOnce(async () => {
      expect(f.row.status).toBe("leased");
      expect(await handback(f, "done")).toEqual({ runId: f.row.id });
      return { ...f.row };
    });
    const claimed = await claimRun(f.deps, { ...f.row }, "worker");
    expect(claimed).toMatchObject({ fence: 1, current: { checkpoint: "takeover" } });
    expect(f.row).toMatchObject({ status: "running", leaseOwner: "worker", leaseFence: 1 });
    expect(refreshTakeoverContinuePlan(plan, f.row)).toMatchObject({
      heldForTakeover: false,
      resumeCheckpoint: "takeover",
    });
    await requeueComputerRun(f.deps, f.row.id, "worker", 1, null, true);
    expect(f.row).toMatchObject({ status: "queued", checkpoint: "takeover" });
  });

  it("keeps a held takeover's resource retry durable and respects its due time", async () => {
    const f = fixture("running");
    Object.assign(f.row, { leaseOwner: "worker", leaseFence: 1 });
    await requeueComputerRun(f.deps, f.row.id, "worker", 1, null, true);
    expect(f.row.status).toBe("waiting_takeover");
    const due = f.row.wakeAt;
    await f.publisher.enqueue({ ...runContinueJob(f.row.id), keepExisting: true });
    expect(f.row.wakeAt).toEqual(due);
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(await claimRun(f.deps, { ...f.row }, "worker")).toMatchObject({ fence: 2 });
    expect(
      takeoverContinuePlan({ status: "waiting_takeover", checkpoint: null }).heldForTakeover,
    ).toBe(true);
  });

  it.each([
    { status: "waiting_input", work: "none", expected: false },
    { status: "waiting_input", work: "timer", expected: false },
    { status: "waiting_input", work: "steering", expected: false },
    { status: "waiting_takeover", work: "none", expected: false },
    { status: "waiting_takeover", work: "claimed-steering", expected: false },
    { status: "waiting_takeover", work: "steering", expected: true },
    { status: "waiting_takeover", work: "takeover", expected: true },
    { status: "waiting_takeover", work: "takeover-skipped", expected: true },
    { status: "waiting_takeover", work: "timer", expected: true },
    { status: "waiting_takeover", work: "future-timer", expected: false },
    { status: "running", work: "expired", expected: true },
    { status: "leased", work: "expired", expected: true },
    { status: "running", work: "live", expected: false },
    { status: "leased", work: "live", expected: false },
    { status: "queued", work: "none", expected: true },
    { status: "queued", work: "future-timer", expected: false },
  ])("recovers missed wakeups from $status with $work", async ({ status, work, expected }) => {
    const f = fixture(status);
    if (work === "timer") f.row.wakeAt = new Date(0);
    if (work === "future-timer") f.row.wakeAt = new Date(Date.now() + 60_000);
    if (work === "expired") f.row.leaseExpiresAt = new Date(0);
    if (work === "live") f.row.leaseExpiresAt = new Date(Date.now() + 60_000);
    if (work === "steering") f.steering.push({ id: "new", runId: f.row.id, claimedAt: null });
    if (work === "claimed-steering")
      f.steering.push({ id: "old", runId: f.row.id, claimedAt: new Date(0) });
    if (work === "takeover" || work === "takeover-skipped") f.row.checkpoint = work;
    const handler = vi.fn(async () => claimRun(f.deps, { ...f.row }, "worker"));
    try {
      await f.host.start({ "run.continue": handler } as unknown as BackgroundJobHandlers);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(f.row.status).toBe(expected ? "running" : status);
      expect(f.row.leaseFence).toBe(expected ? 1 : 0);
    } finally {
      await f.host.stop();
    }
  });
});
