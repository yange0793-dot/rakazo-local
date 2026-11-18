import type { AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const sink = createTestSink();

const provisionComputer = vi.hoisted(() => vi.fn());
const acquireExecutionLease = vi.hoisted(() => vi.fn(async () => null));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: acquireExecutionLease,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/**
 * A run whose model calls the given tools, then answers. The finished tool calls are where a
 * background turn can step aside for a person's message waiting on the same computer.
 */
async function runTurn(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: { trigger?: string; waitingUserRun?: boolean; attempts?: number } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued" as string,
    trigger: options.trigger ?? "routine",
    sourceMessageId: null,
    routineId: "routine-1",
    retryOfRunId: null,
    leaseOwner: null as string | null,
    leaseFence: 0,
    leaseExpiresAt: null as Date | null,
    wakeAt: null as Date | null,
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const [index, call] of toolCalls.entries()) {
      await request.executeTool?.(call.name, call.args, `exec-${index}`);
    }
    yield { type: "text-delta" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      // A person's message waits for this bot's computer when the scenario says so.
      findFirst: vi.fn(async (args?: { where?: { status?: unknown } }) =>
        args?.where?.status === "queued" && options.waitingUserRun
          ? { id: "waiting-user-run" }
          : args?.where?.status === "queued"
            ? null
            : { bot: { notifyOnFinish: false }, thread: { groupId: null } },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: { status?: unknown; leaseOwner?: unknown; leaseFence?: unknown };
          data: Record<string, unknown>;
        }) => {
          // Honor the lease fence the executor uses to avoid releasing a run it no longer owns.
          if (typeof where?.status === "string" && where.status !== run.status) return { count: 0 };
          if (typeof where?.leaseOwner === "string" && where.leaseOwner !== run.leaseOwner)
            return { count: 0 };
          if (typeof where?.leaseFence === "number" && where.leaseFence !== run.leaseFence)
            return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    computerExecutionLease: { findFirst: vi.fn(async () => null) },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: {
          id: "computer-1",
          scope: "dedicated",
          kind: "e2b",
          homeKey: "home-1",
        },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      // This attempt's own row is the first one unless the scenario says the run restarted.
      count: vi.fn(async () => options.attempts ?? 1),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        state: "running",
        restorePending: false,
        screenGeneration: 0,
      })),
    },
    connection: { findMany: vi.fn(async () => []) },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    vaultCredential: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: false } }),
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      yield* [];
    }),
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const events = {
    append: vi.fn(async () => undefined),
    claimSteering: vi.fn(async () => []),
    finalizeRun,
  };
  const executor = createRunExecutor({
    prisma: withEmptyModels(prisma),
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events,
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  return { run, finalizeRun, runtimeRun, enqueue, prisma };
}

beforeEach(() => {
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
  acquireExecutionLease.mockReset();
  acquireExecutionLease.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("a background turn beside a person's message", () => {
  it("finishes normally when no message waits for the computer", async () => {
    const { finalizeRun, run } = await runTurn([{ name: "list_files", args: { path: "" } }]);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(run.status).not.toBe("queued");
  });

  it("steps aside after a tool call and queues itself again", async () => {
    const { finalizeRun, enqueue, run, runtimeRun } = await runTurn(
      [{ name: "list_files", args: { path: "" } }],
      { waitingUserRun: true },
    );
    // The turn did not finish: its result is dropped and the run waits for another attempt.
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(run.leaseOwner).toBeNull();
    expect(runtimeRun).toHaveBeenCalledOnce();
    // The wake is what starts it again once the person's run is done.
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: run.id } }),
    );
  });

  it("continues when the waiting message belongs to the same conversation", async () => {
    const { finalizeRun } = await runTurn([{ name: "list_files", args: { path: "" } }], {
      trigger: "user",
      waitingUserRun: true,
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("finishes a background turn that never ran a tool", async () => {
    const { finalizeRun } = await runTurn([], { waitingUserRun: true });
    // No tool boundary passed: the turn was never interrupted mid-way.
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });

  it("runs to its end once this run has already restarted", async () => {
    const { finalizeRun, run, runtimeRun } = await runTurn(
      [{ name: "list_files", args: { path: "" } }],
      { waitingUserRun: true, attempts: 2 },
    );
    // Its first attempt already yielded (or it was requeued for another reason): a second
    // restart would re-send every model call of the turn while the person keeps talking.
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(run.status).not.toBe("queued");
    expect(runtimeRun).toHaveBeenCalledOnce();
  });
});

function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
