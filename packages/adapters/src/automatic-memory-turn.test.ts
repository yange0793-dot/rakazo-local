import type { AdapterContext, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { automaticMemoryJob } from "@rakazo/adapter-kit";
import type { ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun, consumeRunEvents } from "./run-turn.js";
import { MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS } from "./tool-loop.js";

vi.mock("./run-messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-messages.js")>()),
  publishMessage: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-11-17T10:00:00.000Z");
const DEBOUNCE = new Date(NOW.getTime() + 60_000);

async function context(options: { trigger: string; automatic?: boolean }) {
  const enqueue = vi.fn(async (_job: unknown) => {});
  const finalizeRun = vi.fn<ThreadEvents["finalizeRun"]>(async (input) => ({
    continuationRunId: null,
    ...(input.outcome === "completed" && input.memoryArchiveAt
      ? { memoryArchiveAt: input.memoryArchiveAt }
      : {}),
  }));
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
      toolCallStreak: { count: 0 },
      toolResults: new Map(),
      overLimitActionCalls: 0,
    },
    abortController: new AbortController(),
    runtimeAbortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} }, connector: new Map() },
    source: {},
    secrets: [],
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  return { ctx, enqueue, finalizeRun };
}

describe("post-turn automatic memory scheduling", () => {
  it.each(["user", "follow_up"])(
    "passes the %s archive intent into completion before the pointer-only debounce job",
    async (trigger) => {
      const { ctx, enqueue, finalizeRun } = await context({ trigger });

      await completeRun(ctx);

      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed", memoryArchiveAt: DEBOUNCE }),
      );
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        automaticMemoryJob("thread-1", "bot-1", "user-1", DEBOUNCE),
      );
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
      expect(finalizeRun.mock.invocationCallOrder[0]!).toBeLessThan(
        enqueue.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("does not publish until the completion transaction has resolved", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    let commit!: () => void;
    let entered!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    finalizeRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          commit = () => resolve({ continuationRunId: null, memoryArchiveAt: DEBOUNCE });
          entered();
        }),
    );

    const completion = completeRun(ctx);
    await finalizing;
    expect(enqueue).not.toHaveBeenCalled();
    commit();
    await completion;
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps the completed reply when the job publisher fails", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    enqueue.mockRejectedValue(new Error("publisher down"));

    await expect(completeRun(ctx)).resolves.toBeUndefined();

    expect(finalizeRun).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not schedule when the run has no newly eligible user text", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    finalizeRun.mockResolvedValue({ continuationRunId: null });

    await completeRun(ctx);

    expect(finalizeRun).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not publish an intent for a fenced-out completion", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    finalizeRun.mockResolvedValue(false);

    await completeRun(ctx);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not publish when the completion transaction fails", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    finalizeRun.mockRejectedValue(new Error("intent write failed"));

    await expect(completeRun(ctx)).rejects.toThrow("intent write failed");

    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { trigger: "user", automatic: false },
    { trigger: "routine", automatic: true },
    { trigger: "bot_message", automatic: true },
    { trigger: "messaging", automatic: true },
    { trigger: "webhook", automatic: true },
  ])("skips disabled or non-user runs: %o", async (options) => {
    const { ctx, enqueue, finalizeRun } = await context(options);

    await completeRun(ctx);

    expect(finalizeRun.mock.calls[0]?.[0]).toMatchObject({ memoryArchiveAt: undefined });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("also registers and publishes the completed tool-loop stop", async () => {
    const { ctx, enqueue, finalizeRun } = await context({ trigger: "user" });
    ctx.state.overLimitActionCalls = MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS - 1;
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield {
        type: "tool",
        name: "computer_act",
        args: { actions: Array.from({ length: 25 }, () => ({ kind: "click", x: 1, y: 1 })) },
        executionId: "call-1",
      };
    }

    await expect(consumeRunEvents(ctx, runtime())).resolves.toBe(true);

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "completed", memoryArchiveAt: DEBOUNCE }),
    );
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      automaticMemoryJob("thread-1", "bot-1", "user-1", DEBOUNCE),
    );
  });
});
