import type { AutoReviewProvider } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { refusalCode } from "./tool-refusal.js";

/**
 * The gate's decision for the tools outside text can reach. Everything below the pause is
 * covered by the executor tests; here only whether the call asks a person, runs, or is judged
 * by the approval model is under test.
 */

const review = vi.fn();
const autoReview: AutoReviewProvider = {
  describe: () => ({
    id: "mock",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: { offline: true, keyless: true },
  }),
  review: review as AutoReviewProvider["review"],
};

type EffectRow = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  batchActions?: string[];
};

function request(name: string, args: Record<string, unknown> = {}): ToolRequest {
  return {
    name,
    args,
    executionId: "call-1",
    connectorCall: { tool: name, args, executionId: "call-1" },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
  };
}

function prismaFake(effects: EffectRow[]) {
  return {
    externalEffect: {
      findUnique: async ({ where }: { where: { idempotencyKey?: string; id?: string } }) =>
        effects.find(
          (effect) => effect.id === where.id || effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
      findMany: async ({ where }: { where: { kind?: string; status?: string } }) =>
        effects.filter(
          (effect) =>
            (!where.kind || effect.kind === where.kind) &&
            (!where.status || effect.status === where.status),
        ),
      create: async ({ data }: { data: EffectRow }) => {
        const row = { ...data, id: `effect-${effects.length + 1}` };
        effects.push(row);
        return row;
      },
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(effects[0] as object, data);
        return effects[0];
      },
    },
    attempt: { count: async () => 0 },
    run: { updateMany: async () => ({ count: 1 }) },
  };
}

function context(options: {
  trigger?: string;
  ownerStartedRun?: boolean;
  messagingChannelRun?: boolean;
  tainted?: boolean;
  mode?: "auto" | "ask" | "never";
  effects?: EffectRow[];
}) {
  const effects = options.effects ?? [];
  const paused: unknown[] = [];
  const prisma = prismaFake(effects);
  const ctx = {
    deps: {
      prisma,
      autoReview,
      notifications: undefined,
      jobs: { enqueue: async () => undefined },
      events: {
        pauseRunForInput: async (input: unknown) => {
          paused.push(input);
          return { continuationRunId: "run-2", cardThreadId: "thread-1" };
        },
        notify: async () => undefined,
      },
    },
    run: {
      id: "run-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      trigger: options.trigger ?? "user",
      routineId: null,
    },
    runId: "run-1",
    bot: { id: "bot-1", name: "Assistant", description: "" },
    thread: { id: "thread-1" },
    attempt: { id: "attempt-1" },
    workerId: "worker-1",
    fence: 1,
    task: { prompt: "Do the thing" },
    context: { signal: new AbortController().signal },
    secrets: [],
    source: {
      ownerStartedRun: options.ownerStartedRun ?? true,
      messagingChannelRun: options.messagingChannelRun ?? false,
    },
    state: {
      tainted: options.tainted ?? false,
      earlierAttempt: undefined,
      effects: {
        consumedIds: new Set<string>(),
        pendingTurnCheckpoints: new Map<string, () => string>(),
        storedTurnCheckpoint: false,
        occurrences: [],
        counts: new Map(),
        restoredPending: undefined,
      },
      approval: { request: undefined, pausePending: false },
    },
    trust: {
      searchResultUrls: new Set<string>(),
      loadApprovalRules: async () => [],
      loadTrustedSites: async () => new Set<string>(),
      loadTrustedConnectors: async () => new Set<string>(),
      loadApprovalModel: async () => ({ primary: null, backups: [], primarySource: "none" }),
      loadAutoReviewPreference: async () => ({
        enabled: (options.mode ?? "auto") !== "ask",
        skipApprovals: options.mode === "never",
      }),
      loadOwnerWords: async () => "",
      routineNamesNewSite: async () => false,
      receivedOutsideMessage: async () => false,
    },
    tools: { connector: new Map(), connectedPlugins: [], disabled: new Set<string>() },
    computer: {
      stored: { id: "computer-1", providerRef: null },
      mode: "team",
      checkpoint: { flush: async () => undefined, markDirty: () => undefined },
    },
    providers: {
      browser: {
        describe: () => ({
          id: "fake",
          contractVersion: "1",
          adapterVersion: "0.1.0",
          capabilities: {},
        }),
      },
    },
    settleRunningHelpers: async () => undefined,
  };
  return { ctx: ctx as unknown as RunContext, paused, effects };
}

beforeEach(() => {
  review.mockReset();
  review.mockResolvedValue({ decision: "pass", model: "mock/model", reason: "" });
});

describe("tools outside text can reach", () => {
  it("does not ask the owner to run a shell command in their own run", async () => {
    const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: false });
    const outcome = await gateToolCall(ctx, request("shell", { command: "ls" }), undefined);
    expect("call" in outcome).toBe(true);
    expect(paused).toHaveLength(0);
  });

  it.each([
    ["bot_message", false],
    ["helper_result", false],
    ["routine", false],
  ])("asks a person before %s runs a shell command once the run is tainted", async (trigger) => {
    const { ctx, paused } = context({
      trigger,
      ownerStartedRun: false,
      tainted: true,
    });
    const outcome = await gateToolCall(ctx, request("shell", { command: "ls" }), undefined);
    expect(isApprovalPausedResult((outcome as { result: unknown }).result)).toBe(true);
    expect(paused).toHaveLength(1);
    expect(review).not.toHaveBeenCalled();
  });

  it("refuses a background helper's shell command when it has no chat to ask in", async () => {
    const { ctx, paused } = context({
      trigger: "helper",
      ownerStartedRun: false,
      tainted: true,
    });
    const outcome = await gateToolCall(ctx, request("shell", { command: "ls" }), undefined);
    const result = (outcome as { result: unknown }).result;
    expect(refusalCode(result)).toBe("helper_cannot_ask_approval");
    expect(paused).toHaveLength(0);
    expect(review).not.toHaveBeenCalled();
  });

  it("asks before a channel message runs a shell command even before the run reads anything", async () => {
    const { ctx, paused } = context({
      trigger: "messaging",
      ownerStartedRun: false,
      messagingChannelRun: true,
      tainted: false,
    });
    const outcome = await gateToolCall(ctx, request("shell", { command: "ls" }), undefined);
    expect(isApprovalPausedResult((outcome as { result: unknown }).result)).toBe(true);
    expect(paused).toHaveLength(1);
  });

  it.each(["schedule_create", "schedule_update", "spawn_bot", "save_shared_memory"])(
    "asks a person before %s once the owner's own run is tainted",
    async (name) => {
      const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: true });
      const outcome = await gateToolCall(
        ctx,
        request(name, { prompt: "check the site" }),
        undefined,
      );
      expect(isApprovalPausedResult((outcome as { result: unknown }).result)).toBe(true);
      expect(paused).toHaveLength(1);
      expect(review).not.toHaveBeenCalled();
    },
  );

  it.each(["schedule_create", "schedule_update", "spawn_bot", "save_shared_memory"])(
    "leaves %s alone in the owner's own run before outside content arrived",
    async (name) => {
      const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: false });
      const outcome = await gateToolCall(
        ctx,
        request(name, { prompt: "check the site" }),
        undefined,
      );
      expect("call" in outcome).toBe(true);
      expect(paused).toHaveLength(0);
    },
  );

  it("always asks a person before adding an MCP server, even in an untainted owner run", async () => {
    const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: false });
    const outcome = await gateToolCall(
      ctx,
      request("add_mcp_server", {
        name: "x",
        transport: "streamable_http",
        endpoint: "https://x.test/mcp",
      }),
      undefined,
    );
    expect(isApprovalPausedResult((outcome as { result: unknown }).result)).toBe(true);
    expect(paused).toHaveLength(1);
    expect(review).not.toHaveBeenCalled();
  });

  it("refuses a local MCP server before showing a card it could never act on", async () => {
    const { ctx, paused, effects } = context({
      trigger: "user",
      ownerStartedRun: true,
      tainted: false,
    });
    const outcome = await gateToolCall(
      ctx,
      request("add_mcp_server", { name: "x", transport: "stdio", command: "node" }),
      undefined,
    );
    expect((outcome as { result: unknown }).result).toEqual({
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    });
    expect(paused).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });

  it.each(["write_file", "remember", "save_memory"])(
    "does not gate %s in a tainted owner run",
    async (name) => {
      const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: true });
      const outcome = await gateToolCall(
        ctx,
        request(name, { path: "notes.txt", content: "hi", content_text: "hi" }),
        undefined,
      );
      expect("call" in outcome).toBe(true);
      expect(paused).toHaveLength(0);
    },
  );

  it("still lets the approval model pass an ordinary consequential tool", async () => {
    const { ctx, paused } = context({ trigger: "user", ownerStartedRun: true, tainted: true });
    const outcome = await gateToolCall(
      ctx,
      request("send_email", { to: "a@example.test", subject: "s", body: "b" }),
      undefined,
    );
    expect("call" in outcome).toBe(true);
    expect(review).toHaveBeenCalledOnce();
    expect(paused).toHaveLength(0);
  });
});
