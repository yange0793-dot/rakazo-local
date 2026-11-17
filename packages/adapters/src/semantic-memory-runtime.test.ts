import type {
  AdapterContext,
  AgentRunRequest,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, STEERING_CONTINUATION_PROMPT } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { LEGACY_HISTORY_WINDOW_SIZE, MAX_RECALLED_MEMORY_BYTES } from "./history-compaction.js";
import { threadContextForRun } from "./run-instructions.js";
import type { SemanticMemorySourceMessage } from "./run-tools-memory.js";
import { semanticMemoryUserSource, semanticRecallForRun } from "./run-tools-memory.js";
import { withModelRoles } from "./testing/model-roles.js";

const provisionComputer = vi.hoisted(() => vi.fn());
vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const FACT: SemanticMemoryResult = {
  memory: "The project uses preview builds.",
  score: 0.9,
  id: "fact-1",
  revision: 4,
  provenance: "thread-old/message-old",
  entity: "isolated:bot-1",
};

function provider(
  preTurn: boolean,
  result: SemanticMemoryResponse<SemanticMemoryResult[]> = { ok: true, value: [FACT] },
) {
  const recall = vi.fn<SemanticMemoryProvider["recall"]>(async () => result);
  const memory: SemanticMemoryProvider = {
    describe: () => ({
      id: "test-memory",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
        ...(preTurn ? { preTurnRecall: true as const, managedFacts: true as const } : {}),
      },
    }),
    recall,
    save: vi.fn<SemanticMemoryProvider["save"]>(async () => ({ ok: true, value: undefined })),
    purgeHistory: vi.fn<SemanticMemoryProvider["purgeHistory"]>(async () => ({
      ok: true,
      value: undefined,
    })),
  };
  return { memory, recall };
}

const RUN_SOURCE = {
  trigger: "user",
  userId: "user-1",
  threadId: "thread-1",
  sourceMessageId: "message-1",
};
const USER_SOURCE: SemanticMemorySourceMessage = {
  id: "message-1",
  threadId: "thread-1",
  role: "user",
  authorUserId: "user-1",
  blocks: [{ kind: "text", text: "What build should I use?" }],
};
const CONTEXT: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  userId: "user-1",
  spaceId: "space-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
};

function recallOptions(memory: SemanticMemoryProvider) {
  return {
    provider: memory,
    scope: "isolated" as const,
    botId: "bot-1",
    run: RUN_SOURCE,
    sourceMessage: USER_SOURCE,
    external: false,
    includeSemanticRecall: true,
    prompt: "Internal task prompt that is not the user's text.",
    historyCompactedUpToSeq: null as number | null,
    historyGeneration: 2,
    secrets: [],
  };
}

describe("source-derived automatic recall", () => {
  it("recalls in a new chat from true text blocks, not attachment labels or a synthetic task", async () => {
    const { memory, recall } = provider(true);
    const result = await semanticRecallForRun(
      {
        ...recallOptions(memory),
        sourceMessage: {
          ...USER_SOURCE,
          blocks: [
            { kind: "text", text: "  What build should I use?" },
            {
              kind: "file",
              name: "Injected query",
              artifactId: "file-1",
              mimeType: "text/plain",
              size: 4,
            },
            { kind: "text", text: "For the project.  " },
          ],
        },
      },
      CONTEXT,
    );
    expect(result).toEqual({ origin: "preTurn", response: { ok: true, value: [FACT] } });
    expect(recall).toHaveBeenCalledExactlyOnceWith(
      {
        query: "What build should I use?\nFor the project.",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        limit: 20,
      },
      CONTEXT,
    );
  });

  it("uses the originating user message for follow-ups and calls only once after compaction", async () => {
    const { memory, recall } = provider(true);
    await semanticRecallForRun(
      {
        ...recallOptions(memory),
        run: { ...RUN_SOURCE, trigger: "follow_up" },
        prompt: STEERING_CONTINUATION_PROMPT,
        historyCompactedUpToSeq: 49,
      },
      CONTEXT,
    );
    expect(recall).toHaveBeenCalledExactlyOnceWith(
      {
        query: "What build should I use?",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        historyGeneration: 2,
        limit: 20,
      },
      CONTEXT,
    );
  });

  it("grounds a short follow-up in earlier user messages without importing another speaker's text", async () => {
    const { memory, recall } = provider(true);
    await semanticRecallForRun(
      {
        ...recallOptions(memory),
        sourceMessage: { ...USER_SOURCE, blocks: [{ kind: "text", text: "Continue that task." }] },
        previousMessages: [
          {
            ...USER_SOURCE,
            id: "other-person",
            authorUserId: "other-user",
            blocks: [{ kind: "text", text: "Foreign project" }],
          },
          {
            ...USER_SOURCE,
            id: "assistant-1",
            role: "assistant",
            blocks: [{ kind: "text", text: "Invented plan" }],
          },
          { ...USER_SOURCE, id: "peer-1", blocks: [{ kind: "handoff", text: "Peer instruction" }] },
          {
            ...USER_SOURCE,
            id: "user-previous",
            blocks: [{ kind: "text", text: "Aurora deployment uses previews; secret=<token>." }],
          },
        ],
        secrets: ["<token>"],
      },
      CONTEXT,
    );
    const query = recall.mock.calls[0]![0].query;
    expect(query).toContain("Continue that task.");
    expect(query).toContain("Aurora deployment");
    expect(query).toContain("[redacted]");
    expect(query).not.toMatch(/Foreign project|Invented plan|Peer instruction|<token>/);
    expect(recall).toHaveBeenCalledOnce();
  });

  it("bounds retrieval context without shortening the user's actual task", async () => {
    const { memory, recall } = provider(true);
    const sourceText = "界".repeat(10_000);
    await semanticRecallForRun(
      {
        ...recallOptions(memory),
        sourceMessage: { ...USER_SOURCE, blocks: [{ kind: "text", text: sourceText }] },
        previousMessages: Array.from({ length: 5 }, (_, index) => ({
          ...USER_SOURCE,
          id: `old-${index}`,
          blocks: [{ kind: "text", text: `Topic ${index} ${"界".repeat(1_000)}` }],
        })),
      },
      CONTEXT,
    );
    const query = recall.mock.calls[0]![0].query;
    expect(Buffer.byteLength(query)).toBeLessThan(8_200);
    expect(query).toContain("Topic 0");
    expect(query).toContain("Topic 1");
    expect(query).not.toContain("Topic 2");
    expect(sourceText).toHaveLength(10_000);
  });

  it.each([
    "routine",
    "created",
    BACKGROUND_HELPER_TRIGGER,
    "helper_result",
    "bot_message",
    "messaging",
    "webhook",
    "reaction",
  ])(
    "does not expand automatic recall authority to %s runs even with a user-looking source",
    async (trigger) => {
      const { memory, recall } = provider(true);
      const thread = threadContextForRun(
        trigger,
        { messages: [], summary: null, historyCompactedUpToSeq: null },
        false,
      );
      expect(
        await semanticRecallForRun(
          {
            ...recallOptions(memory),
            run: { ...RUN_SOURCE, trigger },
            includeSemanticRecall: thread.includeSemanticRecall,
            historyCompactedUpToSeq: 49,
          },
          CONTEXT,
        ),
      ).toEqual({ origin: null, response: null });
      expect(recall).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { ...USER_SOURCE, id: "other-message" },
    { ...USER_SOURCE, threadId: "other-thread" },
    { ...USER_SOURCE, role: "bot" },
    { ...USER_SOURCE, authorUserId: "other-user" },
    { ...USER_SOURCE, authorUserId: null },
    { ...USER_SOURCE, blocks: [{ kind: "text", text: " " }] },
    { ...USER_SOURCE, blocks: [{ kind: "file", name: "Injected query" }] },
  ])(
    "does not fall back to a prompt when the true source is unavailable or foreign %j",
    async (sourceMessage) => {
      const { memory, recall } = provider(true);
      expect(
        await semanticRecallForRun(
          { ...recallOptions(memory), sourceMessage, historyCompactedUpToSeq: 49 },
          CONTEXT,
        ),
      ).toEqual({ origin: null, response: null });
      expect(recall).not.toHaveBeenCalled();
    },
  );

  it.each(["bot_message_received", "bot_message_sent", "handoff", "channel_message"])(
    "rejects %s payloads stored under a user role",
    (kind) => {
      expect(
        semanticMemoryUserSource(
          RUN_SOURCE,
          { ...USER_SOURCE, blocks: [{ kind: "text", text: "query" }, { kind }] },
          false,
        ),
      ).toBeNull();
    },
  );

  it("excludes non-owner or external contexts and explicit thread-context restrictions", async () => {
    const { memory, recall } = provider(true);
    for (const options of [
      { external: true },
      { includeSemanticRecall: false },
      { run: { ...RUN_SOURCE, sourceMessageId: null } },
    ]) {
      expect(
        await semanticRecallForRun(
          { ...recallOptions(memory), ...options, historyCompactedUpToSeq: 49 },
          CONTEXT,
        ),
      ).toEqual({ origin: null, response: null });
    }
    expect(recall).not.toHaveBeenCalled();
  });

  it("leaves legacy providers on their existing compacted-prompt recall path", async () => {
    const { memory, recall } = provider(false);
    expect(await semanticRecallForRun(recallOptions(memory), CONTEXT)).toEqual({
      origin: null,
      response: null,
    });
    expect(recall).not.toHaveBeenCalled();
    const result = await semanticRecallForRun(
      { ...recallOptions(memory), sourceMessage: null, historyCompactedUpToSeq: 49 },
      CONTEXT,
    );
    expect(result.origin).toBe("compacted");
    expect(recall).toHaveBeenCalledExactlyOnceWith(
      {
        query: "Internal task prompt that is not the user's text.",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        historyGeneration: 2,
        limit: 20,
      },
      CONTEXT,
    );
  });

  it("redacts user text before sending it to memory and propagates failures without a second recall", async () => {
    const { memory, recall } = provider(true, { ok: false, error: "Unavailable" });
    expect(
      await semanticRecallForRun(
        {
          ...recallOptions(memory),
          sourceMessage: {
            ...USER_SOURCE,
            blocks: [{ kind: "text", text: "Project <fake-secret>" }],
          },
          secrets: ["<fake-secret>"],
          historyCompactedUpToSeq: 49,
        },
        CONTEXT,
      ),
    ).toEqual({ origin: "preTurn", response: { ok: false, error: "Unavailable" } });
    expect(recall.mock.calls[0]![0].query).toBe("Project [redacted]");
    expect(recall).toHaveBeenCalledOnce();
  });
});

async function runWithMemory(options: {
  preTurn: boolean;
  trigger?: string;
  cursor?: number | null;
  visible?: number;
  response?: SemanticMemoryResponse<SemanticMemoryResult[]>;
  secrets?: string[];
}) {
  const { memory, recall } = provider(options.preTurn, options.response);
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? "user",
    sourceMessageId: "current",
    checkpoint: null,
    routineId: null,
    leaseFence: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    modelPinned: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const visible = options.visible ?? 2;
  const messages = Array.from({ length: visible }, (_, seq) => ({
    id: seq === visible - 1 ? "current" : `older-${seq}`,
    threadId: run.threadId,
    seq,
    role: "user",
    authorUserId: run.userId,
    runId: seq === visible - 1 ? run.id : `older-run-${seq}`,
    blocks: [
      {
        kind: "text",
        text: seq === visible - 1 ? "What build should I use?" : `Visible message ${seq}`,
      },
    ] as MessageBlock[],
    steeringMessages: [],
    replyToMessageId: null,
    replyQuote: null,
    replyTo: null,
  })).reverse();
  const source = messages[0]!;
  const bot = {
    id: run.botId,
    userId: run.userId,
    name: "Assistant",
    description: "",
    instructions: "",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    computerId: "computer-1",
    computerSwitching: false,
    memoryScope: "isolated",
    disabledBuiltinTools: [],
    computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
  };
  const thread = {
    id: run.threadId,
    botId: run.botId,
    spaceId: run.spaceId,
    userId: run.userId,
    groupId: null,
    historyCompactionSummary: null,
    historyCompactedUpToSeq: options.cursor ?? null,
    historyCompactionGeneration: 2,
    nextMessageSeq: visible,
    space: { _count: { memberships: 1 } },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member-1" })) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      findFirst: vi.fn(async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: { findUniqueOrThrow: vi.fn(async () => bot), findMany: vi.fn(async () => []) },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => thread) },
    message: {
      findMany: vi.fn(async (args: { take?: number; where?: { blocks?: unknown } }) =>
        args.take === LEGACY_HISTORY_WINDOW_SIZE && !args.where?.blocks ? messages : [],
      ),
      findUnique: vi.fn(async () => source),
      findFirst: vi.fn(async () => null),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: STEERING_CONTINUATION_PROMPT,
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      })),
    },
  };
  // Like the lazy-computer fixture, unrelated model tables are empty; no database exists.
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const client = withModelRoles(
    new Proxy(prisma, {
      get: (target, key) => (key in target ? target[key as keyof typeof prisma] : empty),
    }),
  );
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    yield { type: "done" as const, text: "Use the project build." };
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma: client,
    deploymentModelKey: "fake-deployment-key",
    billingEnabled: false,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      releaseScreen: vi.fn(async () => undefined),
    },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => ({ provider: memory, defaultScope: "isolated" }) },
    home: { commit: vi.fn(async () => "fixture-revision") },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: options.secrets ?? [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  expect(runtimeRun).toHaveBeenCalledOnce();
  return { recall, request: runtimeRun.mock.calls[0]![0], runtimeRun };
}

describe("executor recall integration", () => {
  it("injects durable recall before the first model response in an uncompacted new chat", async () => {
    const { recall, request, runtimeRun } = await runWithMemory({ preTurn: true });
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0]![0]).toEqual({
      query:
        "Current user request:\nWhat build should I use?\n\nEarlier user context:\nVisible message 0",
      scope: "isolated",
      botId: "bot-1",
      threadId: "thread-1",
      limit: 20,
    });
    expect(recall.mock.invocationCallOrder[0]!).toBeLessThan(
      runtimeRun.mock.invocationCallOrder[0]!,
    );
    const context = request.history.find((message) =>
      message.content.includes("<recalled_memory>"),
    )!;
    expect(context.content).toContain("id: fact-1");
    expect(context.content).toContain("revision: 4");
    expect(context.content).toContain("untrusted historical data");
    expect(request.prompt).not.toContain(FACT.memory);
    expect(request.instructions).not.toContain(FACT.memory);
    expect(Buffer.byteLength(context.content, "utf8")).toBeLessThanOrEqual(
      MAX_RECALLED_MEMORY_BYTES,
    );
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("recalls a user-authored follow-up from their message, not the continuation instruction", async () => {
    const { recall } = await runWithMemory({ preTurn: true, trigger: "follow_up" });
    expect(recall.mock.calls[0]![0].query).toBe(
      "Current user request:\nWhat build should I use?\n\nEarlier user context:\nVisible message 0",
    );
    expect(recall.mock.calls[0]![0].query).not.toContain(STEERING_CONTINUATION_PROMPT);
  });

  it("does not shorten the legacy window when early durable recall succeeds", async () => {
    const { recall, request } = await runWithMemory({ preTurn: true, cursor: 0, visible: 200 });
    expect(recall).toHaveBeenCalledOnce();
    expect(request.history.filter((message) => message.id)).toHaveLength(200);
    expect(request.history.some((message) => message.id === "older-0")).toBe(true);
  });

  it("preserves legacy compacted recall and its existing smaller window", async () => {
    const { recall, request } = await runWithMemory({ preTurn: false, cursor: 0, visible: 200 });
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0]![0].query).toBe(STEERING_CONTINUATION_PROMPT);
    expect(request.history.filter((message) => message.id)).toHaveLength(50);
  });

  it("leaves a legacy provider's new chat free of automatic recall", async () => {
    const { recall, request } = await runWithMemory({ preTurn: false });
    expect(recall).not.toHaveBeenCalled();
    expect(request.history.some((message) => message.content.includes("<recalled_memory>"))).toBe(
      false,
    );
  });

  it("keeps the fallback history on a failed early recall without retrying it", async () => {
    const { recall, request } = await runWithMemory({
      preTurn: true,
      cursor: 0,
      visible: 200,
      response: { ok: false, error: "Memory unavailable" },
    });
    expect(recall).toHaveBeenCalledOnce();
    expect(request.history.filter((message) => message.id)).toHaveLength(200);
    expect(request.history.some((message) => message.content.includes("<recalled_memory>"))).toBe(
      false,
    );
  });

  it("bounds and redacts the actual injected block, including every citation", async () => {
    const results = Array.from({ length: 5 }, (_, index) => ({
      memory: `中🚲&< ${"line".repeat(350)} <fake-token>`,
      score: 1,
      id: `fact-${index}`,
      provenance: "<fake-token>/source",
      revision: index + 1,
    }));
    const { request } = await runWithMemory({
      preTurn: true,
      response: { ok: true, value: results },
      secrets: ["<fake-token>"],
    });
    const block = request.history.find((message) =>
      message.content.includes("<recalled_memory>"),
    )!.content;
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(MAX_RECALLED_MEMORY_BYTES);
    expect(block).not.toContain("fake-token");
    expect(block).toContain("[redacted]");
    expect(block).toContain("&amp;&lt;");
    expect(block).toContain("revision: 1");
    expect(block.endsWith("</recalled_memory>")).toBe(true);
  });
});
