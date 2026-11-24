import { createHash } from "node:crypto";
import type { AdapterContext, AgentRunRequest, SandboxProvider } from "@rakazo/adapter-kit";
import type { ImprovementComponentSet } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import type { DataKey, PrismaClient, ThreadEvents } from "@rakazo/db";
import { isCiphertext, isSealedArtifact, loadRunTurnCheckpoint } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectArtifactStore } from "./artifact-store-factory.js";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import type {
  RunConfigurationManifest,
  RunConfigurationManifestInput,
} from "./run-configuration-manifest.js";
import {
  persistRunConfigurationManifest,
  RUN_CONFIGURATION_RECEIPT_KIND,
  recordRunConfigurationModelChange,
} from "./run-configuration-manifest.js";
import {
  listPinnedTaughtSkillRevisions,
  pinTaughtSkillRevisionToRun,
  taughtSkillComponentSetHash,
} from "./taught-skill-revisions.js";

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => ({
    id: "fixture-computer",
    botId: "fixture-bot",
    kind: "fake",
    providerRef: "fixture-computer",
  }),
}));

const sink = createTestSink();
beforeEach(() => {
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
  vi.stubEnv("SELF_EVOLUTION", "true");
  vi.stubEnv("GIT_SHA", "fixture-revision");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

type Row = Record<string, unknown>;
type Receipt = {
  id: string;
  spaceId: string;
  runId: string;
  kind: string;
  status: string;
  idempotencyKey: string;
  request: { attemptId: string; phase: string; sequence: number };
  result: { storageKey?: string; sha256?: string; size?: number } & Row;
};
type Query = { where: Row };

// These fixtures exercise scalar lease/fence guards; other query shapes only read empty tables.
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(
    ([key, value]) => (value !== null && typeof value === "object") || row[key] === value,
  );

function fixture(
  options: {
    ticket?: boolean;
    lesson?: boolean;
    pin?: boolean;
    components?: ImprovementComponentSet;
    startupFallback?: boolean;
    runtimeFallback?: boolean;
    ticketTools?: "create" | "claim";
    approvalRules?: ActionApprovalRule[];
    skipApprovals?: boolean;
    encryptReadEffects?: boolean;
    modelTools?: readonly { name: string; args: Row }[];
    onRuntime?: (request: AgentRunRequest) => Promise<void>;
  } = {},
) {
  const run = {
    id: "fixture-run",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    taskId: "fixture-task",
    spaceId: "fixture-space",
    userId: "fixture-user",
    ticketId: options.ticket === false ? null : "fixture-ticket",
    status: "queued",
    trigger: "user",
    sourceMessageId: options.ticketTools ? "fixture-request" : null,
    routineId: null,
    leaseOwner: null as string | null,
    leaseFence: 0,
    checkpoint: null,
  };
  const attempts: Row[] = [];
  const receipts: Receipt[] = [];
  const effects: Row[] = [];
  const now = new Date();
  const board = {
    id: "fixture-board",
    spaceId: run.spaceId,
    name: "Board",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
  const ticketDefaults = {
    id: "fixture-ticket",
    spaceId: run.spaceId,
    boardId: board.id,
    number: 1,
    title: "Fixture work",
    status: "todo",
    receiptVersion: 0,
    fileDeliveryRequirements: null,
    workState: null,
    workStateVersion: 0,
    createdByUserId: run.userId,
    assigneeBotId: run.botId,
    originKey: null,
    createdAt: now,
    updatedAt: now,
  };
  const tickets: Row[] =
    options.ticketTools === "claim"
      ? [
          {
            ...ticketDefaults,
            createdByUserId: run.userId,
            createdByBotId: run.botId,
            assigneeBotId: "fixture-peer",
            originKey: "fixture-existing-work",
            originThreadId: run.threadId,
            originMessageId: run.sourceMessageId,
            originRunId: run.id,
          },
        ]
      : run.ticketId
        ? [{ ...ticketDefaults }]
        : [];
  const key: DataKey = {
    id: "fixture-artifact-key",
    spaceId: run.spaceId,
    version: 1,
    key: new Uint8Array(32).fill(7),
  };
  const storage = new MemoryObjectStorage();
  const keyRing = {
    encryptWrites: true,
    current: async () => key,
    byId: async () => key,
  };
  const artifacts = new ObjectArtifactStore(storage, keyRing);
  const put = vi.spyOn(artifacts, "put");
  const remove = vi.spyOn(artifacts, "remove");
  const context: AdapterContext = {
    operationId: run.id,
    traceId: run.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    runId: run.id,
    signal: new AbortController().signal,
  };
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const createReceipt = vi.fn(async ({ data }: { data: Omit<Receipt, "id"> }) => {
    if (receipts.some((row) => row.idempotencyKey === data.idempotencyKey))
      throw new Error("Duplicate configuration receipt");
    const row = { id: `effect-${receipts.length + 1}`, ...data };
    receipts.push(row);
    return row;
  });
  const lessonUsage = vi.fn(async () => ({ count: 1 }));
  const revision = {
    id: "fixture-skill-revision",
    skillId: "fixture-skill",
    spaceId: run.spaceId,
    botId: run.botId,
    userId: run.userId,
    previousRevisionId: null,
    createdAt: new Date(),
    snapshot: {
      name: "Fixture skill",
      goal: "Private skill goal",
      scope: {},
      playbook: {
        whenToUse: "Private skill cue",
        inputs: [],
        steps: ["Private skill step"],
        howToCheck: "",
        whatToReturn: "",
        approvalBoundaries: "",
        failureHandling: "",
      },
      ...(options.components ? { components: options.components } : {}),
    },
  };
  const taughtSkill = {
    id: revision.skillId,
    spaceId: revision.spaceId,
    botId: revision.botId,
    userId: revision.userId,
    status: "saved",
    currentRevisionId: revision.id,
  };
  let pin = options.pin
    ? { id: "fixture-pin", spaceId: run.spaceId, runId: run.id, snapshot: revision }
    : undefined;
  const db = {
    $contentEncryption: () => (options.encryptReadEffects ? { ring: keyRing } : undefined),
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const beforeRun = { ...run };
      const beforeReceipts = receipts.length;
      try {
        return await work(db);
      } catch (error) {
        Object.assign(run, beforeRun);
        receipts.splice(beforeReceipts);
        throw error;
      }
    },
    $queryRaw: async (sql: TemplateStringsArray | { sql: string }, ...values: unknown[]) => {
      const query = "sql" in sql ? sql.sql : sql.join("");
      if (query.includes("FROM run_taught_skill_revisions")) return pin ? [pin] : [];
      if (!options.components) return [];
      if (query.includes("FROM taught_skills")) return [taughtSkill];
      if (query.includes("FROM taught_skill_revisions")) return [revision];
      if (query.includes("INSERT INTO run_taught_skill_revisions")) {
        pin = {
          id: String(values[0]),
          spaceId: run.spaceId,
          runId: run.id,
          snapshot: JSON.parse(String(values.at(-1))),
        };
        return [pin];
      }
      return [];
    },
    $executeRaw: async () => 0,
    run: {
      findUnique: async () => ({ ...run }),
      findUniqueOrThrow: async () => ({ ...run }),
      findFirst: async ({ where }: Query) =>
        where.id === run.id && matches(run, where) ? { ...run } : null,
      updateMany: vi.fn(async ({ where, data }: Query & { data: Row }) => {
        if (!matches(run, where)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }),
      update: async ({ data }: { data: Row }) => {
        Object.assign(run, data);
        return { ...run };
      },
    },
    attempt: {
      ...empty,
      create: async ({ data }: { data: Row }) => {
        const attempt = { id: `attempt-${attempts.length + 1}`, ...data };
        attempts.push(attempt);
        return attempt;
      },
      findFirst: async ({ where }: Query) =>
        attempts.find((attempt) => matches(attempt, where)) ?? null,
      findMany: async () => attempts,
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    externalEffect: {
      ...empty,
      findFirst: async ({ where }: Query) =>
        [...receipts, ...effects].find((effect) => matches(effect, where)) ?? null,
      create: async (input: Parameters<typeof createReceipt>[0]) => {
        if (input.data.kind === RUN_CONFIGURATION_RECEIPT_KIND) return createReceipt(input);
        const effect = { id: `tool-effect-${effects.length + 1}`, ...input.data };
        effects.push(effect);
        return effect;
      },
      findMany: async ({ where }: Query) =>
        [...receipts, ...effects].filter((effect) => matches(effect, where)),
      findUnique: async ({ where }: Query) =>
        [...receipts, ...effects].find((effect) => matches(effect, where)) ?? null,
      upsert: async ({ where, create, update }: Query & { create: Row; update: Row }) => {
        const saved = effects.find((effect) => matches(effect, where));
        if (saved) return Object.assign(saved, update);
        const effect = { id: `tool-effect-${effects.length + 1}`, ...create };
        effects.push(effect);
        return effect;
      },
      updateMany: async ({ where, data }: Query & { data: Row }) => {
        const changed = effects.filter((effect) => matches(effect, where));
        for (const effect of changed) Object.assign(effect, data);
        return { count: changed.length };
      },
    },
    bot: {
      ...empty,
      findFirst: async ({ where }: Query) =>
        matches(
          { id: run.botId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
          where,
        )
          ? { id: run.botId }
          : null,
      findUniqueOrThrow: async () => ({
        id: run.botId,
        name: "Fixture",
        title: "Fixture",
        description: "Fixture",
        instructions: "Private bot instructions",
        modelProvider: options.startupFallback ? "unconnected-provider" : "openai-compatible",
        modelId: options.startupFallback ? "unavailable-model" : "fixture-model",
        thinkingLevel: "high",
        computerId: "fixture-computer",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "fixture-computer", scope: "dedicated", kind: "fake" },
      }),
    },
    task: {
      findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Private task prompt" }),
    },
    thread: {
      findUniqueOrThrow: async () => ({
        id: run.threadId,
        botId: run.botId,
        groupId: null,
        externalConversationId: null,
        nextMessageSeq: 1,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
      }),
    },
    deploymentSettings: {
      findUnique: async () => ({
        defaultModelProvider: "openai-compatible",
        defaultModelId: "fixture-model",
      }),
    },
    userModelCredential: {
      ...empty,
      findMany: async ({ where }: Query) =>
        where.provider === "unconnected-provider"
          ? []
          : [
              {
                id: "fixture-credential",
                provider: "openai-compatible",
                defaultModel: "fixture-model",
                secretId: "fixture-secret",
              },
            ],
    },
    userModelRoleChoice: {
      findMany: async () => [
        {
          userId: run.userId,
          role: "main",
          position: 0,
          provider: "openai-compatible",
          modelId: "fixture-model",
          thinkingLevel: "high",
        },
        {
          userId: run.userId,
          role: "main",
          position: 1,
          provider: "openai-compatible",
          modelId: "fixture-backup",
          thinkingLevel: "low",
        },
      ],
    },
    secret: {
      ...empty,
      findFirst: async () => ({ id: "fixture-secret", ciphertext: "fixture-ciphertext" }),
    },
    spaceMember: { findUnique: async () => ({ id: "fixture-member" }) },
    lessonUsage: { ...empty, createMany: lessonUsage },
    space: empty,
    user: empty,
    spaceModelRoleChoice: empty,
    spaceSettingOverride: empty,
    userModelPreference: empty,
    userActionApprovalRule: {
      ...empty,
      findMany: async () => options.approvalRules ?? [],
    },
    userActionAutoReviewPreference: {
      ...empty,
      findUnique: async () =>
        options.skipApprovals ? { enabled: false, skipApprovals: true } : null,
    },
    chatGroup: empty,
    message: {
      ...empty,
      findUnique: async ({ where }: Query) =>
        options.ticketTools && where.id === run.sourceMessageId
          ? {
              id: run.sourceMessageId,
              threadId: run.threadId,
              role: "user",
              authorUserId: run.userId,
              blocks: [{ kind: "text", text: "Create and deliver this work." }],
            }
          : null,
      // Receipt persistence is covered separately; this fixture completes the tool boundary.
      findFirst: async ({ where }: Query) =>
        options.ticketTools && tickets.length && where.clientNonce
          ? { id: "fixture-work-receipt" }
          : null,
    },
    steeringMessage: empty,
    event: empty,
    connection: empty,
    taughtSkill: {
      ...empty,
      findFirst: async ({ where }: Query) =>
        options.components && matches(taughtSkill, where) ? { id: taughtSkill.id } : null,
    },
    vaultCredential: empty,
    agentSkill: empty,
    scratchpadItem: empty,
    artifact: empty,
    board: {
      ...empty,
      findUnique: async () => (options.ticketTools ? board : null),
      update: async () => ({ ...board, nextNumber: ++board.nextNumber }),
    },
    ticket: {
      ...empty,
      findFirst: async ({ where }: Query) =>
        tickets.find((ticket) => matches(ticket, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const ticket = { ...ticketDefaults, ...data };
        tickets.push(ticket);
        return ticket;
      },
      update: async ({ where, data }: Query & { data: Row }) =>
        Object.assign(tickets.find((ticket) => matches(ticket, where))!, data),
      updateMany: async ({ where, data }: Query & { data: Row }) => {
        const rows = tickets.filter((ticket) => matches(ticket, where));
        for (const ticket of rows) {
          for (const [key, value] of Object.entries(data)) {
            ticket[key] =
              value && typeof value === "object" && "increment" in value
                ? Number(ticket[key]) + Number(value.increment)
                : value;
          }
        }
        return { count: rows.length };
      },
    },
    ticketComment: empty,
    mcpServer: empty,
    modelCreditEntry: empty,
    usageRecord: { createMany: async () => ({ count: 1 }) },
  };
  const prisma = db as unknown as PrismaClient;
  const skillRead = { name: "skill_read", args: { taughtSkillId: revision.skillId } };
  const modelTools = options.modelTools ?? (options.components ? [skillRead, skillRead] : []);
  let modelCalls = 0;
  const modelFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const call = ++modelCalls;
    const wire = JSON.parse(String(init?.body)) as { model: string };
    if (options.runtimeFallback && wire.model === "fixture-model") {
      return new Response(
        JSON.stringify({ error: { type: "insufficient_quota", message: "Quota exhausted" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    if (options.runtimeFallback) {
      expect(wire.model).toBe("fixture-backup");
      expect(receipts.at(-1)?.result).toMatchObject({
        source: "onModelChange",
        modelId: "fixture-backup",
      });
    }
    const tool = modelTools[call - 1];
    return new Response(
      `data: ${JSON.stringify({
        id: `fixture-response-${call}`,
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `fixture-call-${call}`,
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.args),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "Finished." },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const runtime = new PiAgentRuntime({ modelFetch });
  const realRun = runtime.run.bind(runtime);
  const runtimeRun = vi.spyOn(runtime, "run").mockImplementation(async function* (request, ctx) {
    await options.onRuntime?.(request);
    yield* realRun(request, ctx);
  });
  const finalizeRun = vi.fn(async (input) => {
    if (run.leaseOwner !== input.leaseOwner || run.leaseFence !== input.leaseFence) return null;
    run.status = input.outcome;
    return { continuationRunId: null };
  });
  const events = {
    append: vi.fn(async (_input: Parameters<ThreadEvents["append"]>[0]) => undefined),
    claimSteering: async () => [],
    pauseRunForInput: vi.fn(async (input: Parameters<ThreadEvents["pauseRunForInput"]>[0]) => {
      if (run.leaseOwner !== input.leaseOwner || run.leaseFence !== input.leaseFence) return false;
      run.status = "waiting_input";
      run.leaseOwner = null;
      return { continuationRunId: null };
    }),
    finalizeRun,
  };
  const readFile = vi.fn<SandboxProvider["readFile"]>(async () =>
    new TextEncoder().encode("Pinned script observation."),
  );
  const listFiles = vi.fn<SandboxProvider["listFiles"]>(async () => [
    { path: "notes/pinned-evidence.txt", kind: "file", size: 26 },
  ]);
  const executor = createRunExecutor({
    prisma,
    artifacts,
    ticketBoardEnabled: true,
    runtime,
    mcpAllowPrivateEndpoint: true,
    secretStore: {
      load: async () =>
        JSON.stringify({
          kind: "openai_compatible",
          apiKey: "fixture-private-api-key",
          baseUrl: "http://127.0.0.1:9/v1",
          allowPrivateEndpoint: true,
          contextWindow: 160000,
          maxTokens: 1024,
          reasoning: true,
          thinkingLevel: "high",
        }),
    },
    sandbox: {
      describe: () => ({ id: "fake", capabilities: { graphical: false } }),
      readFile,
      listFiles,
      releaseScreen: async () => undefined,
      async *exportWorkspace() {},
    },
    home: { commit: async () => "fixture-home" },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: {
      resolve: async () =>
        options.lesson
          ? {
              defaultScope: "isolated",
              provider: {
                describe: () => ({ capabilities: { managedFacts: true } }),
                recall: async ({ kind }: { kind?: string }) => ({
                  ok: true,
                  value:
                    kind === "lesson"
                      ? [
                          {
                            id: "fixture-lesson",
                            revision: 3,
                            memory: "cue: Private lesson cue\nlesson: Private lesson text",
                          },
                        ]
                      : [],
                }),
              },
            }
          : null,
    },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  const read = async (attemptId = "attempt-1") => {
    const rows = await prisma.externalEffect.findMany({
      where: { runId: run.id, spaceId: run.spaceId, kind: RUN_CONFIGURATION_RECEIPT_KIND },
    });
    const receipt = (rows as unknown as Receipt[]).find(
      (row) => row.request.phase === "start" && row.request.attemptId === attemptId,
    );
    expect(receipt).toBeDefined();
    const bytes = await artifacts.get(receipt!.result.storageKey!, context);
    return {
      receipt: receipt!,
      bytes,
      manifest: JSON.parse(new TextDecoder().decode(bytes)) as RunConfigurationManifest,
    };
  };
  return {
    execute: (workerId = "fixture-worker") => executor.continueRun(run.id, workerId),
    run,
    attempts,
    receipts,
    artifacts,
    storage,
    context,
    prisma,
    put,
    remove,
    createReceipt,
    runtimeRun,
    modelFetch,
    readFile,
    listFiles,
    finalizeRun,
    lessonUsage,
    events,
    read,
  };
}

describe("executor configuration receipts", () => {
  it("publishes and reads an encrypted immutable start manifest before the real Pi turn", async () => {
    const state = fixture({
      onRuntime: async (request) => {
        const { manifest } = await state.read();
        expect(manifest.model.deliveredAtStart).toEqual({
          provider: request.model.provider,
          modelId: request.model.id,
          reasoningLevel: request.model.thinkingLevel,
        });
      },
    });
    await state.execute();
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
    expect(state.modelFetch).toHaveBeenCalledOnce();
    expect(state.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
    const { manifest, bytes, receipt } = await state.read();
    expect(manifest).toMatchObject({
      runId: state.run.id,
      attemptId: "attempt-1",
      deploymentRevision: "fixture-revision",
      runtime: { id: "pi" },
      model: {
        requested: { modelId: "fixture-model", reasoningLevel: "high" },
        effectiveReasoningLevel: null,
        allowedFallbacks: [
          { provider: "openai-compatible", modelId: "fixture-backup", reasoningLevel: "low" },
        ],
        actualFallbacks: [],
      },
      contextPolicy: {
        requestedStrategy: null,
        deliveredStrategy: null,
        effectiveStrategy: null,
        revision: null,
        recallRevision: null,
      },
      pinnedTaughtSkills: [],
      shownLessons: [],
    });
    expect(receipt.status).toBe(RUN_CONFIGURATION_RECEIPT_KIND);
    expect(receipt.result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(receipt.result.size).toBe(bytes.byteLength);
    expect(isSealedArtifact([...state.storage.objects.values()][0]!.bytes)).toBe(true);
    const serialized = new TextDecoder().decode(bytes);
    for (const secret of ["fixture-private-api-key", "Private task", "Private bot", "127.0.0.1"])
      expect(serialized).not.toContain(secret);
    expect(JSON.stringify(state.events.append.mock.calls)).not.toContain(receipt.result.storageKey);
  });

  it("keeps requested configuration distinct from a startup substitute", async () => {
    const state = fixture({ startupFallback: true });
    await state.execute();
    expect(state.run.status).toBe("completed");
    expect(state.modelFetch).toHaveBeenCalledOnce();
    const { manifest } = await state.read();
    expect(manifest.model.requested).toMatchObject({
      provider: "unconnected-provider",
      modelId: "unavailable-model",
      reasoningLevel: "high",
    });
    expect(manifest.model.deliveredAtStart?.modelId).toBe("fixture-model");
    expect(manifest.model.actualFallbacks).toEqual([
      expect.objectContaining({ modelId: "fixture-model", source: "startup-selection" }),
    ]);
  });

  it("records callback evidence separately and leaves the start snapshot unchanged", async () => {
    let initial: Uint8Array;
    const state = fixture({
      onRuntime: async (request) => {
        initial = (await state.read()).bytes;
        await request.onModelChange!("openai-compatible", "fixture-backup");
        await request.onModelChange!("openai-compatible", "fixture-model", false);
      },
    });
    await state.execute();
    expect(state.run.status).toBe("completed");
    expect(state.modelFetch).toHaveBeenCalledOnce();
    expect((await state.read()).bytes).toEqual(initial!);
    expect(state.put).toHaveBeenCalledOnce();
    expect(
      state.receipts.slice(1).map((row) => ({ request: row.request, result: row.result })),
    ).toEqual([
      {
        request: { attemptId: "attempt-1", phase: "model-change", sequence: 1 },
        result: {
          source: "onModelChange",
          operationId: state.run.id,
          provider: "openai-compatible",
          modelId: "fixture-backup",
          computerMode: null,
          effectiveReasoningLevel: null,
        },
      },
      {
        request: { attemptId: "attempt-1", phase: "model-change", sequence: 2 },
        result: {
          source: "onModelChange",
          operationId: state.run.id,
          provider: "openai-compatible",
          modelId: "fixture-model",
          computerMode: false,
          effectiveReasoningLevel: null,
        },
      },
    ]);
  });

  it("persists a real Pi fallback callback before the backup request", async () => {
    const state = fixture({ runtimeFallback: true });
    await state.execute();
    expect(state.run.status).toBe("completed");
    expect(state.receipts).toHaveLength(2);
    expect(state.receipts[1]).toMatchObject({
      request: { attemptId: "attempt-1", phase: "model-change", sequence: 1 },
      result: { source: "onModelChange", modelId: "fixture-backup", computerMode: null },
    });
    expect((await state.read()).manifest.model.deliveredAtStart?.modelId).toBe("fixture-model");
    expect(state.put).toHaveBeenCalledOnce();
  });

  it.each(["lesson", "pin"] as const)(
    "records the actual %s references in an ordinary chat",
    async (kind) => {
      const state = fixture({ ticket: false, [kind]: true });
      await state.execute();
      expect(state.run.status).toBe("completed");
      expect(state.modelFetch).toHaveBeenCalledOnce();
      const { manifest, bytes } = await state.read();
      expect(manifest.shownLessons).toEqual(
        kind === "lesson" ? [{ lessonId: "fixture-lesson", revision: 3 }] : [],
      );
      expect(manifest.pinnedTaughtSkills).toEqual(
        kind === "pin" ? [{ skillId: "fixture-skill", revisionId: "fixture-skill-revision" }] : [],
      );
      expect(new TextDecoder().decode(bytes)).not.toMatch(/Private (skill|lesson)/);
      if (kind === "lesson") expect(state.lessonUsage).toHaveBeenCalledOnce();
    },
  );

  it("executes the pinned script before the first Pi request and only once across repeated skill reads", async () => {
    const capabilityId = "isolated.snapshot.read_file";
    const guidance = "Check the pinned evidence before reporting.";
    const observation = "Pinned script observation.";
    const components: ImprovementComponentSet = {
      schemaVersion: "improvement-components.v1",
      items: [
        { id: "reader", revision: "1", kind: "plugin", capabilityId },
        { id: "read-guidance", revision: "2", kind: "tool_guidance", capabilityId, text: guidance },
        {
          id: "prefetch",
          revision: "3",
          kind: "script",
          language: "tool-sequence.v1",
          steps: [{ capabilityId, input: { path: "pinned-evidence.txt" } }],
        },
      ],
    };
    const state = fixture({ ticket: false, components });
    const pinned = await pinTaughtSkillRevisionToRun(
      state.prisma,
      { spaceId: state.run.spaceId, userId: state.run.userId },
      { runId: state.run.id, skillId: "fixture-skill", context: {} },
    );
    expect(pinned?.id).toBe("fixture-skill-revision");
    await state.execute();

    expect(state.run.status).toBe("completed");
    expect(state.modelFetch).toHaveBeenCalledTimes(3);
    expect(state.readFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "fixture-computer" }),
      "pinned-evidence.txt",
      expect.objectContaining({ runId: state.run.id }),
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
    expect(state.readFile.mock.invocationCallOrder[0]!).toBeLessThan(
      state.modelFetch.mock.invocationCallOrder[0]!,
    );
    await expect(
      state.prisma.externalEffect.findMany({ where: { kind: "read_file", runId: state.run.id } }),
    ).resolves.toEqual([]);
    const wires = state.modelFetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: unknown }>;
          tools: Array<{ function: { name: string; description: string } }>;
        },
    );
    expect(JSON.stringify(wires[0]!.messages)).toContain(observation);
    expect(
      wires[0]!.tools.find((tool) => tool.function.name === "read_file")?.function.description,
    ).toContain(guidance);
    expect(wires[2]!.messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ content: expect.stringContaining("fixture-skill-revision") }),
      expect.objectContaining({ content: expect.stringContaining("fixture-skill-revision") }),
    ]);

    expect((await state.read()).manifest.pinnedTaughtSkills).toEqual([
      { skillId: "fixture-skill", revisionId: "fixture-skill-revision" },
    ]);
    const componentEvents = state.events.append.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.type === "effect.recorded" && event.payload.kind === "skill_components",
      );
    expect(componentEvents).toHaveLength(1);
    expect(componentEvents[0]?.payload.receipts).toContainEqual(
      expect.objectContaining({
        componentId: "prefetch",
        componentRevision: "3",
        componentSetHash: taughtSkillComponentSetHash(components),
        skillRevision: "fixture-skill-revision",
        status: "executed",
        executions: [
          expect.objectContaining({
            capabilityId,
            toolName: "read_file",
            status: "succeeded",
            outputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ],
      }),
    );
    expect(JSON.stringify(componentEvents)).not.toContain(observation);
  });

  it("pins on the first Pi skill read and delivers components once through the tool result", async () => {
    const capabilityId = "isolated.snapshot.read_file";
    const guidance = "Check the pinned evidence before reporting.";
    const observation = "Pinned script observation.";
    const path = "pinned-evidence.txt";
    const revisionId = "fixture-skill-revision";
    const components: ImprovementComponentSet = {
      schemaVersion: "improvement-components.v1",
      items: [
        { id: "reader", revision: "1", kind: "plugin", capabilityId },
        { id: "read-guidance", revision: "2", kind: "tool_guidance", capabilityId, text: guidance },
        {
          id: "prefetch",
          revision: "3",
          kind: "script",
          language: "tool-sequence.v1",
          steps: [{ capabilityId, input: { path } }],
        },
      ],
    };
    const state = fixture({ ticket: false, components });
    const readPins = () =>
      listPinnedTaughtSkillRevisions(
        state.prisma,
        { spaceId: state.run.spaceId, userId: state.run.userId },
        state.run.id,
      );
    await expect(readPins()).resolves.toEqual([]);

    await state.execute();

    expect(state.run.status).toBe("completed");
    await expect(readPins()).resolves.toMatchObject([
      { id: revisionId, skillId: "fixture-skill", snapshot: { components } },
    ]);
    expect(state.modelFetch).toHaveBeenCalledTimes(3);
    expect(state.readFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "fixture-computer" }),
      path,
      expect.objectContaining({ runId: state.run.id }),
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
    const [firstRequest, secondRequest] = state.modelFetch.mock.invocationCallOrder;
    const [read] = state.readFile.mock.invocationCallOrder;
    expect(read).toBeGreaterThan(firstRequest!);
    expect(read).toBeLessThan(secondRequest!);

    const wires = state.modelFetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: unknown }>;
          tools: Array<{ function: { name: string; description: string } }>;
        },
    );
    const readTools = wires.map(({ tools }) =>
      tools.find((tool) => tool.function.name === "read_file"),
    );
    expect(readTools[0]).toBeDefined();
    expect(readTools[0]?.function.description).not.toContain(guidance);
    expect(readTools.slice(1)).toEqual([readTools[0], readTools[0]]);

    const toolResults = wires[1]!.messages.filter(({ role }) => role === "tool");
    expect(toolResults).toEqual([
      expect.objectContaining({ content: expect.stringContaining(revisionId) }),
    ]);
    const firstResult = String(toolResults[0]?.content);
    const componentJson = firstResult.match(/<skill_components>(.*?)<\/skill_components>/s)?.[1];
    expect(componentJson).toBeDefined();
    expect(JSON.parse(componentJson!)).toMatchObject({
      toolGuidance: [{ toolName: "read_file", text: [guidance] }],
      scriptObservations: [
        {
          componentId: "prefetch",
          steps: [
            {
              capabilityId,
              toolName: "read_file",
              status: "succeeded",
              result: { path, content: observation },
            },
          ],
        },
      ],
    });
    const finalResults = wires[2]!.messages.filter(({ role }) => role === "tool");
    expect(finalResults).toEqual([
      expect.objectContaining({ content: firstResult }),
      expect.objectContaining({ content: expect.stringContaining(revisionId) }),
    ]);
    expect(finalResults[1]?.content).not.toContain("<skill_components>");

    const componentEvents = state.events.append.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.type === "effect.recorded" && event.payload.kind === "skill_components",
      );
    expect(componentEvents).toHaveLength(1);
    expect(componentEvents[0]?.payload).toMatchObject({
      attemptId: "attempt-1",
      phase: "tool_result",
      receipts: expect.arrayContaining([
        expect.objectContaining({
          componentId: "read-guidance",
          componentRevision: "2",
          skillRevision: revisionId,
          status: "applied",
        }),
        expect.objectContaining({
          componentId: "prefetch",
          componentRevision: "3",
          skillRevision: revisionId,
          status: "executed",
        }),
      ]),
    });
  });

  it.each([
    ["read_file", "pinned-evidence.txt", "Pinned script observation."],
    ["list_files", "notes", "pinned-evidence.txt"],
  ] as const)(
    "pauses pinned %s before I/O and replays its approved result",
    async (name, path, text) => {
      const capabilityId = `isolated.snapshot.${name}` as const;
      const state = fixture({
        ticket: false,
        pin: true,
        encryptReadEffects: name === "read_file",
        components: {
          schemaVersion: "improvement-components.v1",
          items: [
            { id: "reader", revision: "1", kind: "plugin", capabilityId },
            {
              id: "prefetch",
              revision: "1",
              kind: "script",
              language: "tool-sequence.v1",
              steps: [{ capabilityId, input: { path } }],
            },
          ],
        },
        approvalRules: [{ effect: "require_approval", matchKind: "tool", matchValue: name }],
      });
      const effects = () =>
        state.prisma.externalEffect.findMany({ where: { runId: state.run.id, kind: name } });
      const io = name === "read_file" ? state.readFile : state.listFiles;

      await state.execute();

      expect(io).not.toHaveBeenCalled();
      expect(state.modelFetch).not.toHaveBeenCalled();
      expect(state.run.status).toBe("waiting_input");
      const pending = await effects();
      expect(pending).toEqual([expect.objectContaining({ status: "intended", request: { path } })]);
      const effect = pending[0]!;
      expect(state.events.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: effect.id })],
        }),
      );

      await state.prisma.externalEffect.updateMany({
        where: { id: effect.id, status: "intended" },
        data: { status: "approved" },
      });
      state.run.status = "queued";
      await state.execute();

      expect(state.run.status).toBe("completed");
      expect(io).toHaveBeenCalledOnce();
      expect(io.mock.calls[0]?.[1]).toBe(path);
      const completed = await effects();
      expect(completed).toEqual([expect.objectContaining({ id: effect.id, status: "completed" })]);
      if (name === "read_file") {
        expect(isCiphertext(completed[0]?.result)).toBe(true);
        expect(JSON.stringify(completed[0]?.result)).not.toContain(text);
      } else {
        expect(JSON.stringify(completed[0]?.result)).toContain(text);
      }
      expect(String(state.modelFetch.mock.calls[0]?.[1]?.body)).toContain(text);

      const nextModelCall = state.modelFetch.mock.calls.length;
      state.run.status = "queued";
      await state.execute();

      expect(state.run.status).toBe("completed");
      expect(io).toHaveBeenCalledOnce();
      expect(state.events.pauseRunForInput).toHaveBeenCalledOnce();
      expect(await effects()).toEqual(completed);
      expect(String(state.modelFetch.mock.calls[nextModelCall]?.[1]?.body)).toContain(text);
    },
  );

  it("resumes a Pi checkpoint without rerunning the pinned script before its pending call", async () => {
    const capabilityId = "isolated.snapshot.read_file";
    const path = "pinned-evidence.txt";
    const observation = "Pinned script observation.";
    const state = fixture({
      ticket: false,
      pin: true,
      encryptReadEffects: true,
      components: {
        schemaVersion: "improvement-components.v1",
        items: [
          { id: "reader", revision: "1", kind: "plugin", capabilityId },
          {
            id: "prefetch",
            revision: "1",
            kind: "script",
            language: "tool-sequence.v1",
            steps: [{ capabilityId, input: { path } }],
          },
        ],
      },
      modelTools: [{ name: "list_files", args: { path: "notes" } }],
      approvalRules: [{ effect: "require_approval", matchKind: "tool", matchValue: "list_files" }],
    });
    const effects = () =>
      state.prisma.externalEffect.findMany({
        where: { runId: state.run.id, kind: "list_files" },
      });

    await state.execute();

    expect(state.run.status).toBe("waiting_input");
    expect(state.readFile).toHaveBeenCalledOnce();
    expect(state.listFiles).not.toHaveBeenCalled();
    expect(state.modelFetch).toHaveBeenCalledOnce();
    const checkpoint = (await loadRunTurnCheckpoint(state.prisma, state.run))!;
    expect(JSON.parse(checkpoint)).toMatchObject({
      systemPrompt: expect.stringContaining(observation),
      pendingToolCallId: "fixture-call-1",
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              id: "fixture-call-1",
              name: "list_files",
              arguments: { path: "notes" },
            }),
          ]),
        }),
      ]),
    });
    const pending = await effects();
    expect(pending).toEqual([
      expect.objectContaining({ status: "intended", request: { path: "notes" } }),
    ]);
    const effect = pending[0]!;
    await state.prisma.externalEffect.updateMany({
      where: { id: effect.id, status: "intended" },
      data: { status: "approved" },
    });
    state.run.status = "queued";
    await state.execute("replacement-worker");

    expect(state.run.status).toBe("completed");
    expect(state.readFile).toHaveBeenCalledOnce();
    expect(state.listFiles).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "fixture-computer" }),
      "notes",
      expect.objectContaining({ runId: state.run.id }),
    );
    expect(state.events.pauseRunForInput).toHaveBeenCalledOnce();
    expect(await effects()).toEqual([
      expect.objectContaining({ id: effect.id, status: "completed" }),
    ]);
    expect(state.modelFetch).toHaveBeenCalledTimes(2);
    const wire = JSON.parse(String(state.modelFetch.mock.calls[1]?.[1]?.body));
    expect(wire.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining(observation) }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "fixture-call-1",
          content: expect.stringContaining("notes/pinned-evidence.txt"),
        }),
      ]),
    );

    const componentEvents = state.events.append.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.type === "effect.recorded" && event.payload.kind === "skill_components",
      );
    expect(componentEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        attemptId: "attempt-1",
        phase: "before_model",
        eligible: true,
        receipts: expect.arrayContaining([
          expect.objectContaining({ componentId: "prefetch", status: "executed" }),
        ]),
      }),
      expect.objectContaining({
        attemptId: "attempt-2",
        phase: "restored_turn",
        eligible: false,
        receipts: expect.arrayContaining([
          expect.objectContaining({
            componentId: "prefetch",
            status: "unexecuted",
            executions: [],
          }),
        ]),
      }),
    ]);
  });

  it.each(["require_approval", "deny"] as const)(
    "honors Never ask for workspace reads under a %s rule",
    async (effect) => {
      const names = ["read_file", "list_files"];
      const blocked = effect === "deny";
      const state = fixture({
        ticket: false,
        skipApprovals: true,
        approvalRules: names.map((matchValue) => ({ effect, matchKind: "tool", matchValue })),
        onRuntime: async (request) => {
          for (const name of names) {
            const result = await request.executeTool!(name, { path: "notes" }, name);
            expect(result).toMatchObject(
              blocked ? { error: expect.stringContaining("blocked") } : { path: "notes" },
            );
          }
        },
      });
      await state.execute();
      expect(state.run.status).toBe("completed");
      expect(state.readFile).toHaveBeenCalledTimes(blocked ? 0 : 1);
      expect(state.listFiles).toHaveBeenCalledTimes(blocked ? 0 : 1);
      expect(state.events.pauseRunForInput).not.toHaveBeenCalled();
      await expect(
        state.prisma.externalEffect.findMany({ where: { runId: state.run.id } }),
      ).resolves.toEqual([]);
    },
  );

  it("does no object-store work for an ordinary chat without learning evidence", async () => {
    const state = fixture({ ticket: false });
    await state.execute();
    expect(state.run.status).toBe("completed");
    expect(state.modelFetch).toHaveBeenCalledOnce();
    expect(state.put).not.toHaveBeenCalled();
    expect(state.receipts).toEqual([]);
  });

  it.each(["create", "claim"] as const)(
    "publishes the entry snapshot after a real ticket %s and records later model changes",
    async (binding) => {
      const state = fixture({
        ticket: false,
        ticketTools: binding,
        onRuntime: async (request) => {
          expect(state.put).not.toHaveBeenCalled();
          await request.onModelChange!("openai-compatible", "fixture-backup");
          expect(state.run).toMatchObject({ modelId: "fixture-backup" });
          expect(state.receipts).toEqual([]);

          const changed = await request.executeTool!(
            binding === "create" ? "ticket_create" : "ticket_update",
            binding === "create"
              ? { title: "Work created during this turn" }
              : { id: "fixture-ticket", ownerBotId: state.run.botId },
            `bind-${binding}`,
          );
          expect(changed).toHaveProperty("ticket.id", "fixture-ticket");
          expect(state.run.ticketId).toBe("fixture-ticket");
          const start = await state.read();
          expect(start.manifest.model).toMatchObject({
            deliveredAtStart: { modelId: "fixture-model", reasoningLevel: "high" },
            actualFallbacks: [],
          });
          expect(state.put).toHaveBeenCalledOnce();

          await request.onModelChange!("openai-compatible", "fixture-model", false);
          expect(state.receipts).toHaveLength(2);
          expect(state.receipts[1]).toMatchObject({
            request: { attemptId: "attempt-1", phase: "model-change", sequence: 1 },
            result: {
              operationId: state.run.id,
              modelId: "fixture-model",
              computerMode: false,
            },
          });
          expect((await state.read()).bytes).toEqual(start.bytes);
        },
      });
      await state.execute();
      expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
      expect(state.run.status).toBe("completed");
      expect(state.modelFetch).toHaveBeenCalledOnce();
      expect(state.put).toHaveBeenCalledOnce();
    },
  );

  it("shares one pending publication with a parallel tool after ticket binding", async () => {
    let started!: () => void;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const upload = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = fixture({
      ticket: false,
      ticketTools: "create",
      onRuntime: async (request) => {
        const creating = request.executeTool!(
          "ticket_create",
          { title: "Parallel work" },
          "parallel-create",
        );
        await publishing;
        let readFinished = false;
        const reading = request.executeTool!("ticket_get", { ref: "RAK-1" }, "parallel-read").then(
          (result) => {
            readFinished = true;
            return result;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(readFinished).toBe(false);
        expect(state.put).toHaveBeenCalledOnce();
        release();
        const [created, read] = await Promise.all([creating, reading]);
        expect(created).toHaveProperty("ticket.id", "fixture-ticket");
        expect(read).toHaveProperty("ticket.id", "fixture-ticket");
      },
    });
    state.put.mockImplementation(async (artifact, context) => {
      started();
      await upload;
      return ObjectArtifactStore.prototype.put.call(state.artifacts, artifact, context);
    });
    await state.execute();
    expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
    expect(state.run.status).toBe("completed");
    expect(state.put).toHaveBeenCalledOnce();
    expect(state.receipts).toHaveLength(1);
    expect(state.storage.objects.size).toBe(1);
  });

  it("keeps separate snapshots when the same run has another attempt", async () => {
    const state = fixture();
    await state.execute();
    expect(state.run.status).toBe("completed");
    const first = await state.read();
    state.run.status = "queued";
    await state.execute();
    expect(state.run.status).toBe("completed");
    const second = await state.read("attempt-2");
    expect(state.modelFetch).toHaveBeenCalledTimes(2);
    expect((await state.read()).bytes).toEqual(first.bytes);
    expect(second.receipt.result.storageKey).not.toBe(first.receipt.result.storageKey);
    expect(state.receipts).toHaveLength(2);
    expect(state.storage.objects.size).toBe(2);
  });

  it("removes a new object when publication fails and never starts the runtime", async () => {
    const state = fixture();
    state.createReceipt.mockRejectedValueOnce(new Error("Fixture receipt write failure"));
    await state.execute();
    expect(state.put).toHaveBeenCalledOnce();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.storage.objects.size).toBe(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.runtimeRun).not.toHaveBeenCalled();
    expect(state.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("rejects an expired lease after upload and cleans up its unreferenced object", async () => {
    const state = fixture();
    const realPut = state.artifacts.put.bind(state.artifacts);
    state.put.mockRestore();
    vi.spyOn(state.artifacts, "put").mockImplementation(async (artifact, context) => {
      const result = await realPut(artifact, context);
      state.run.leaseFence += 1;
      state.run.leaseOwner = "new-worker";
      return result;
    });
    await state.execute();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.storage.objects.size).toBe(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.runtimeRun).not.toHaveBeenCalled();
    expect(state.run.leaseOwner).toBe("new-worker");
  });

  it("rejects duplicate publication without overwriting or deleting the existing manifest", async () => {
    const state = fixture();
    await state.execute();
    const first = await state.read();
    state.run.status = "running";
    await expect(
      persistRunConfigurationManifest(
        state.prisma,
        state.artifacts,
        state.context,
        { ...first.manifest, deploymentRevision: "replacement" } as RunConfigurationManifestInput,
        { owner: "fixture-worker", fence: state.run.leaseFence },
      ),
    ).rejects.toThrow("Duplicate configuration receipt");
    expect(state.storage.objects.size).toBe(1);
    expect((await state.read()).bytes).toEqual(first.bytes);
    expect(state.receipts).toHaveLength(1);
  });

  it("rolls back a model change when its receipt fails and fences computer-mode callbacks too", async () => {
    const state = fixture();
    await state.execute();
    state.run.status = "running";
    const scope = { runId: state.run.id, attemptId: "attempt-1", spaceId: state.run.spaceId };
    const lease = { owner: "fixture-worker", fence: state.run.leaseFence };
    state.createReceipt.mockRejectedValueOnce(new Error("Fixture switch receipt write failure"));
    await expect(
      recordRunConfigurationModelChange(state.prisma, scope, lease, 1, state.run.id, {
        provider: "openai-compatible",
        modelId: "fixture-backup",
      }),
    ).rejects.toThrow("Fixture switch receipt write failure");
    expect(state.run).toMatchObject({ modelId: "fixture-model" });
    state.run.leaseFence += 1;
    await expect(
      recordRunConfigurationModelChange(state.prisma, scope, lease, 2, state.run.id, {
        provider: "openai-compatible",
        modelId: "fixture-backup",
        computerMode: true,
      }),
    ).rejects.toThrow("Run lease expired");
    expect(state.receipts).toHaveLength(1);
  });
});
