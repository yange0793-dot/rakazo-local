import type { AdapterContext } from "@rakazo/adapter-kit";
import { automaticMemoryJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun } from "./run-turn.js";

const archive = vi.hoisted(() => ({
  markPending: vi.fn(),
  loadBatch: vi.fn(),
  applyBatch: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    MemoryArchiveStore: class {
      markPending(...args: unknown[]) {
        return archive.markPending(...args);
      }
      loadBatch(...args: unknown[]) {
        return archive.loadBatch(...args);
      }
      applyBatch(...args: unknown[]) {
        return archive.applyBatch(...args);
      }
    },
  };
});

const NOW = new Date("2026-11-17T10:00:00.000Z");
const DEBOUNCE = new Date(NOW.getTime() + 60_000);

async function context(options: { trigger: string; automatic?: boolean }) {
  archive.markPending.mockReset();
  archive.loadBatch.mockReset();
  archive.applyBatch.mockReset();
  archive.markPending.mockResolvedValue(true);
  const enqueue = vi.fn(async (_job: unknown) => {});
  const finalizeRun = vi.fn(async () => ({}));
  const adapterContext = {
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    operationId: "run.complete",
    traceId: "test",
    signal: new AbortController().signal,
  } satisfies AdapterContext;
  const deps = {
    prisma: {
      message: { findMany: async () => [] },
      run: { updateMany: async () => ({ count: 1 }) },
      thread: {
        findUniqueOrThrow: async () => ({ nextMessageSeq: 0, historyCompactedUpToSeq: null }),
      },
    },
    events: { append: vi.fn(), finalizeRun },
    jobs: { enqueue },
    now: () => NOW,
    ...(options.automatic === false ? {} : { automaticMemory: { enabled: true } }),
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: options.trigger,
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId },
    attempt: { id: "attempt-1" },
    context: adapterContext,
    state: {
      reply,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    secrets: [],
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, enqueue, finalizeRun, adapterContext };
}

describe("post-turn automatic memory scheduling", () => {
  it.each(["user", "follow_up"])(
    "marks the completed %s run pending before the pointer-only debounce job",
    async (trigger) => {
      const { ctx, enqueue, finalizeRun, adapterContext } = await context({ trigger });

      await completeRun(ctx);

      expect(finalizeRun).toHaveBeenCalledOnce();
      expect(archive.markPending).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        adapterContext,
        DEBOUNCE,
      );
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        automaticMemoryJob("thread-1", "bot-1", "user-1", DEBOUNCE),
      );
      expect(archive.loadBatch).not.toHaveBeenCalled();
      expect(archive.applyBatch).not.toHaveBeenCalled();
      const job = enqueue.mock.calls[0]![0] as {
        name: string;
        payload: Record<string, unknown>;
        replaceKey: string;
        maxAttempts: number;
      };
      expect(job).toMatchObject({
        name: "memory.extract",
        payload: { threadId: "thread-1", botId: "bot-1", userId: "user-1" },
        replaceKey: "memory.extract:thread-1:bot-1:user-1",
        maxAttempts: 3,
      });
      expect(job.payload).not.toHaveProperty("messages");
      expect(job.payload).not.toHaveProperty("text");
      expect(job.payload).not.toHaveProperty("content");
      expect(archive.markPending.mock.invocationCallOrder[0]!).toBeLessThan(
        enqueue.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("keeps the completed reply when the job publisher fails", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    enqueue.mockRejectedValue(new Error("publisher down"));

    await expect(completeRun(ctx)).resolves.toBeUndefined();

    expect(finalizeRun).toHaveBeenCalledOnce();
    expect(archive.markPending).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not schedule when the run has no newly eligible user text", async () => {
    const { ctx, enqueue } = await context({ trigger: "user" });
    archive.markPending.mockResolvedValue(false);

    await completeRun(ctx);

    expect(archive.markPending).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { trigger: "user", automatic: false },
    { trigger: "routine", automatic: true },
    { trigger: "bot_message", automatic: true },
  ])("skips disabled or non-user runs: %o", async (options) => {
    const { ctx, enqueue } = await context(options);

    await completeRun(ctx);

    expect(archive.markPending).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
