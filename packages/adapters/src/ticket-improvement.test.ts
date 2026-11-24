import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentUsage,
} from "@rakazo/adapter-kit";
import type { ImprovementComponentSet, MessageBlock } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import type { Artifact, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  recordUsage,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Revisions from "./taught-skill-revisions.js";
import type { TaughtSkillRevision } from "./taught-skill-revisions.js";
import {
  activateTaughtSkillRevision,
  getCurrentTaughtSkillRevision,
  getCurrentTaughtSkillRevisionState,
  listPinnedTaughtSkillRevisions,
  snapshotTaughtSkillRevision,
  TaughtSkillRevisionConflictError,
  taughtSkillPlaybookHash,
  taughtSkillRevisionHash,
} from "./taught-skill-revisions.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import type { TicketImprovementDeps } from "./ticket-improvement.js";
import {
  CURRENT_IMPROVER,
  parseTicketImprovementProposal,
  reflectTicketImprovement,
  ticketImprovementTrial,
} from "./ticket-improvement.js";
import {
  badDeliveryPlaybook,
  baselineDeliveryPlaybook,
  goodDeliveryPlaybook,
  manifestOnlyDeliveryPlaybook,
  OfflineTicketImprovementRuntime,
} from "./ticket-improvement.test-fixtures.js";
import type { WorkImprovementComparison, WorkImprovementRun } from "./work-improvement.js";
import type { WorkImprovementComposition } from "./work-improvement-compose.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordUsage: vi.fn(async () => undefined),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "result-message" })),
}));
vi.mock("./taught-skill-revisions.js", async (original) => ({
  ...(await original<typeof Revisions>()),
  listPinnedTaughtSkillRevisions: vi.fn(),
  snapshotTaughtSkillRevision: vi.fn(),
  getCurrentTaughtSkillRevision: vi.fn(),
  getCurrentTaughtSkillRevisionState: vi.fn(),
  activateTaughtSkillRevision: vi.fn(),
}));
vi.mock("./thread-artifacts.js", () => ({ attachWorkspaceFileToThread: vi.fn() }));

const CORRECTION =
  "You checked installation but did not inspect the complete directory or confirm upload completion.";
const BASELINE_COMPONENTS: ImprovementComponentSet = {
  schemaVersion: "improvement-components.v1",
  items: [
    {
      id: "reader",
      revision: "1",
      kind: "plugin",
      capabilityId: "isolated.snapshot.read_file",
    },
  ],
};
const BASELINE: TaughtSkillRevision = {
  id: "baseline-revision",
  skillId: "delivery-skill",
  spaceId: "space",
  botId: "worker-bot",
  userId: "user",
  previousRevisionId: null,
  createdAt: new Date("2026-11-18T00:00:00Z"),
  snapshot: {
    name: "Verify delivery",
    goal: "Verify a retained package.",
    scope: { taskFamilies: ["file-delivery"] },
    playbook: baselineDeliveryPlaybook,
  },
};

class TicketCompositionRuntime extends OfflineTicketImprovementRuntime {
  compositionCalls = 0;
  compositionReply?:
    | {
        kind: "compose";
        playbook: WorkImprovementComparison["candidate"]["playbook"];
        components?: ImprovementComponentSet;
      }
    | { kind: "reject"; reason: string }
    | string;
  missingCompositionUsage = false;
  compositionUsage?: Partial<AgentUsage>;
  comparisonUsage?: Partial<AgentUsage>;

  override async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (request.runId.endsWith(":proposal") || request.tools.length > 0) {
      yield* super.run(
        request.tools.length > 0 && this.comparisonUsage
          ? {
              ...request,
              onUsage: (usage) => request.onUsage?.({ ...usage, ...this.comparisonUsage }),
            }
          : request,
        context,
      );
      return;
    }
    this.requests.push(request);
    this.compositionCalls++;
    if (!this.missingCompositionUsage) {
      const observer = request.model.callObserver!;
      const callId = `${request.runId}:compose-call`;
      const reservation = await observer.beforeCall({
        callId,
        runId: request.runId,
        provider: request.model.provider,
        modelId: request.model.id,
        inputTokensEstimate: 80,
        maxOutputTokens: request.model.maxTokens ?? 512,
      });
      const usage = {
        type: "usage" as const,
        provider: request.model.provider,
        model: request.model.id,
        callId,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        costUsd: 0,
        usageSource: "deterministic_offline_fixture",
        ...this.compositionUsage,
      };
      await observer.afterCall(reservation, usage);
      await request.onUsage?.(usage);
    }
    const reply = this.compositionReply ?? {
      kind: "compose",
      playbook: this.proposal.kind === "candidate" ? this.proposal.playbook : goodDeliveryPlaybook,
    };
    yield { type: "done", text: typeof reply === "string" ? reply : JSON.stringify(reply) };
  }
}

function harness() {
  const baseline = structuredClone(BASELINE);
  let current = baseline;
  let generation = 0;
  let feedbackId = "feedback";
  let feedbackText = CORRECTION;
  let failPhase: string | null = null;
  let afterStorePhase: ((phase: string) => void) | undefined;
  const files = new Map<string, Uint8Array>();
  const artifacts: Artifact[] = [];
  const revisions: TaughtSkillRevision[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const runtime = new TicketCompositionRuntime();
  let afterCandidateLookup: (() => void) | undefined;
  const run = {
    id: "original-run",
    spaceId: "space",
    userId: "user",
    botId: "worker-bot",
    status: "completed",
    modelProvider: "fixture",
    modelId: "model",
    task: { prompt: "Verify the package and deliver the evidence." },
    ticket: {
      id: "ticket",
      spaceId: "space",
      createdByUserId: "user",
      createdByBotId: "owner-bot",
      originKey: "origin",
      originMessageId: "original-request",
      originThread: {
        id: "owner-thread",
        spaceId: "space",
        botId: "owner-bot",
        groupId: null,
        externalConversationId: null,
      },
    },
  };
  const matches = (artifact: Artifact, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = artifact[key as keyof Artifact];
      if (value && typeof value === "object") {
        const check = value as {
          in?: string[];
          not?: null;
          startsWith?: string;
          endsWith?: string;
        };
        return (
          (!check.in || check.in.includes(actual as string)) &&
          (check.not !== null || actual !== null) &&
          (!check.startsWith || String(actual).startsWith(check.startsWith)) &&
          (!check.endsWith || String(actual).endsWith(check.endsWith))
        );
      }
      return actual === value;
    });
  const tx = {
    $queryRaw: vi.fn(async () => {
      const rows = revisions.map((revision) => ({ id: revision.id, snapshot: revision.snapshot }));
      afterCandidateLookup?.();
      afterCandidateLookup = undefined;
      return rows;
    }),
    artifact: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Artifact> }) => {
        const row = artifacts.find((artifact) => artifact.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          posted.find(
            (message) => message.clientNonce === where.threadId_clientNonce.clientNonce,
          ) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const message = posted.find((item) => item.id === where.id)!;
          Object.assign(message, data);
          return message;
        },
      ),
    },
  };
  const prisma = {
    run: { findUnique: vi.fn(async () => run) },
    message: {
      findMany: vi.fn(async () => [
        {
          id: feedbackId,
          blocks: [{ kind: "text", text: feedbackText }],
          replyTo: {
            id: "receipt-message",
            blocks: [{ kind: "file", artifactId: "receipt-artifact" }],
          },
        },
      ]),
    },
    artifact: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          artifacts.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
          skip = 0,
          take,
        }: {
          where: Record<string, unknown>;
          skip?: number;
          take?: number;
        }) =>
          artifacts
            .filter((row) => matches(row, where))
            .sort(
              (left, right) =>
                right.createdAt.getTime() - left.createdAt.getTime() ||
                right.id.localeCompare(left.id),
            )
            .slice(skip, take === undefined ? undefined : skip + take),
      ),
    },
    $queryRaw: tx.$queryRaw,
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  const receiptBytes = new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      runId: run.id,
      ticketId: run.ticket.id,
      version: 1,
      summary: "Installation passed; selected upload was reported complete.",
    }),
  );
  const row = (id: string, botId: string, name: string, bytes: Uint8Array): Artifact => ({
    id,
    spaceId: "space",
    userId: "user",
    botId,
    groupId: null,
    runId: run.id,
    name,
    mimeType: "application/json",
    size: bytes.byteLength,
    hash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: id,
    version: 1,
    rootArtifactId: null,
    standalone: false,
    clientNonce: null,
    description: null,
    createdAt: new Date(),
  });
  artifacts.push(row("receipt-artifact", "owner-bot", "work-ticket.json", receiptBytes));
  files.set("receipt-artifact", receiptBytes);
  vi.mocked(attachWorkspaceFileToThread).mockImplementation(async (_deps, input) => {
    const phase = JSON.parse(new TextDecoder().decode(input.bytes)).phase;
    if (phase === failPhase) {
      failPhase = null;
      throw new Error("checkpoint storage unavailable");
    }
    const artifact = row(
      `artifact-${artifacts.length}`,
      input.botId,
      input.name ?? input.filePath,
      input.bytes,
    );
    artifact.groupId = input.groupId ?? null;
    artifacts.push(artifact);
    files.set(artifact.storageKey, input.bytes);
    await input.onAttached?.(tx as never, artifact);
    afterStorePhase?.(phase);
    return {
      artifactId: artifact.id,
      block: {
        kind: "file",
        artifactId: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
      },
    };
  });
  vi.mocked(createThreadMessageInTransaction).mockImplementation(async (_tx, input) => {
    const message = { ...input, id: `result-message-${posted.length}` };
    posted.push(message);
    return message as never;
  });
  vi.mocked(listPinnedTaughtSkillRevisions).mockImplementation(async () => [baseline]);
  vi.mocked(getCurrentTaughtSkillRevision).mockImplementation(async () => current);
  vi.mocked(getCurrentTaughtSkillRevisionState).mockImplementation(async () => ({
    revision: current,
    generation,
  }));
  vi.mocked(snapshotTaughtSkillRevision).mockImplementation(async (_prisma, _actor, input) => {
    if (
      input.expectedCurrentRevisionId !== current.id ||
      input.trial?.baselineGeneration !== generation
    )
      throw new TaughtSkillRevisionConflictError();
    const candidate = {
      ...baseline,
      id: `candidate-${revisions.length}`,
      previousRevisionId: baseline.id,
      snapshot: {
        ...baseline.snapshot,
        playbook: input.playbook!,
        ...(input.components ? { components: input.components } : {}),
        trial: input.trial!,
      },
    };
    revisions.push(candidate);
    return candidate;
  });
  vi.mocked(activateTaughtSkillRevision).mockImplementation(async (_prisma, _actor, input) => {
    if (
      input.expectedCurrentRevisionId !== current.id ||
      revisions.find((revision) => revision.id === input.revisionId)?.snapshot.trial
        ?.baselineGeneration !== generation
    )
      return { status: "conflict", currentRevisionId: current.id };
    current = revisions.find((revision) => revision.id === input.revisionId)!;
    generation++;
    return { status: "activated", revision: current };
  });
  const resolveModel = vi.fn(async () => ({
    provider: "fixture",
    id: "model",
    maxTokens: 32_768,
    apiKey: "fixture-api-secret",
    headers: { authorization: "fixture-header-secret" },
  }));
  const deps: TicketImprovementDeps = {
    prisma,
    runtime,
    events: { notify: vi.fn(async () => undefined) } as never,
    artifacts: { get: vi.fn(async (key: string) => files.get(key)!) } as never,
    resolveModel,
  };
  const result = () =>
    JSON.parse(
      new TextDecoder().decode(
        files.get(
          artifacts.findLast((artifact) => artifact.clientNonce?.endsWith(":result"))!.storageKey,
        )!,
      ),
    );
  const checkpoint = (phase: string) => {
    const artifact = artifacts.findLast((item) => item.clientNonce?.endsWith(`:${phase}`));
    return artifact
      ? JSON.parse(new TextDecoder().decode(files.get(artifact.storageKey)!))
      : undefined;
  };
  const seedHistory = (
    skillId: string,
    comparison: WorkImprovementComparison | WorkImprovementComposition,
    id: string,
    createdAt: Date,
  ) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "ticket-improvement.v1",
        comparisonId: id,
        phase: "comparison",
        baseline: { ...baseline, skillId },
        comparison,
      }),
    );
    const artifact = row(id, baseline.botId, "Skill comparison.json", bytes);
    artifact.clientNonce = `${id}:comparison`;
    artifact.runId = `history-${id}`;
    artifact.createdAt = createdAt;
    artifacts.push(artifact);
    files.set(artifact.storageKey, bytes);
  };
  return {
    deps,
    runtime,
    run,
    baseline,
    artifacts,
    revisions,
    posted,
    result,
    checkpoint,
    seedHistory,
    replaceCheckpoint: (phase: string, record: unknown) => {
      const artifact = artifacts.findLast((item) => item.clientNonce?.endsWith(`:${phase}`))!;
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      artifact.hash = createHash("sha256").update(bytes).digest("hex");
      files.set(artifact.storageKey, bytes);
    },
    removeCheckpoints: (...phases: string[]) => {
      for (let index = artifacts.length - 1; index >= 0; index--)
        if (phases.some((phase) => artifacts[index]!.clientNonce?.endsWith(`:${phase}`)))
          artifacts.splice(index, 1);
    },
    resolveModel,
    current: () => current,
    changeCurrent: () => {
      current = { ...baseline, id: "human-revision" };
      generation++;
    },
    rollback: () => {
      current = baseline;
      generation++;
    },
    failStore: (phase: string) => {
      failPhase = phase;
    },
    afterStore: (phase: string, callback: () => void) => {
      afterStorePhase = (storedPhase) => {
        if (storedPhase === phase) callback();
      };
    },
    afterCandidateLookup: (callback: () => void) => {
      afterCandidateLookup = callback;
    },
    feedback: (id: string, text = CORRECTION) => {
      feedbackId = id;
      feedbackText = text;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
  vi.stubEnv("SELF_EVOLUTION", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ticket improvement proposal boundary", () => {
  it("requires a complete playbook and a quote present in that exact feedback", () => {
    const candidate = { kind: "candidate", quote: CORRECTION, playbook: goodDeliveryPlaybook };
    expect(parseTicketImprovementProposal(JSON.stringify(candidate), CORRECTION)).toEqual(
      candidate,
    );
    expect(
      parseTicketImprovementProposal(
        JSON.stringify({ ...candidate, quote: "Different feedback" }),
        CORRECTION,
      ),
    ).toBeNull();
    expect(
      parseTicketImprovementProposal(
        JSON.stringify({ ...candidate, playbook: { steps: [] } }),
        CORRECTION,
      ),
    ).toBeNull();
    expect(
      parseTicketImprovementProposal(
        `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``,
        CORRECTION,
      ),
    ).toBeNull();
    expect(
      parseTicketImprovementProposal(
        JSON.stringify({ ...candidate, outcome: "improved" }),
        CORRECTION,
      ),
    ).toBeNull();
    expect(
      parseTicketImprovementProposal(
        JSON.stringify({ ...candidate, components: BASELINE_COMPONENTS }),
        CORRECTION,
      ),
    ).toMatchObject({ kind: "candidate", components: BASELINE_COMPONENTS });
  });
  it.each(["disabled", "not-pinned", "other-family"])(
    "spends no pilot model calls when %s",
    async (condition) => {
      const h = harness();
      if (condition === "disabled") vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
      if (condition === "not-pinned")
        vi.mocked(listPinnedTaughtSkillRevisions).mockResolvedValue([]);
      if (condition === "other-family") h.baseline.snapshot.scope.taskFamilies = ["research"];
      expect(await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).toBe(false);
      expect(h.resolveModel).not.toHaveBeenCalled();
      expect(h.runtime.proposalCalls).toBe(0);
    },
  );
  it("does no work when disabled with a cached comparison waiting for recovery", async () => {
    const h = harness();
    h.afterStore("comparison", () => vi.stubEnv("SELF_EVOLUTION", "off"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.checkpoint("comparison")).toMatchObject({
      phase: "comparison",
      comparison: {
        schemaVersion: "work-improvement.composition.v1",
        decision: "adopt",
        composed: { decision: "adopt" },
      },
    });
    expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();

    h.runtime.proposalCalls = 0;
    h.runtime.comparisonCalls = 0;
    h.runtime.compositionCalls = 0;
    h.runtime.requests.length = 0;
    h.resolveModel.mockClear();
    vi.mocked(snapshotTaughtSkillRevision).mockClear();
    vi.mocked(activateTaughtSkillRevision).mockClear();
    vi.mocked(h.deps.prisma.artifact.findFirst).mockClear();
    expect(await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).toBe(false);
    expect(h.resolveModel).not.toHaveBeenCalled();
    expect(h.runtime.proposalCalls).toBe(0);
    expect(h.runtime.comparisonCalls).toBe(0);
    expect(h.runtime.compositionCalls).toBe(0);
    expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
    expect(h.deps.prisma.artifact.findFirst).not.toHaveBeenCalled();
  });
  it("rechecks the switch immediately before snapshotting a comparison", async () => {
    const h = harness();
    h.afterCandidateLookup(() => vi.stubEnv("SELF_EVOLUTION", "off"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.checkpoint("comparison")).toMatchObject({ comparison: { decision: "adopt" } });
    expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("rechecks the switch immediately before activating a snapshotted candidate", async () => {
    const h = harness();
    vi.mocked(getCurrentTaughtSkillRevision).mockImplementation(async () => {
      vi.stubEnv("SELF_EVOLUTION", "off");
      return h.current();
    });
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(snapshotTaughtSkillRevision).toHaveBeenCalledTimes(1);
    expect(h.revisions).toHaveLength(1);
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
    expect(h.current().id).toBe(BASELINE.id);
  });
  it("skips a bare dislike without a model and lets the model skip praise or a new task", async () => {
    const h = harness();
    h.feedback("dislike", "👎");
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.resolveModel).not.toHaveBeenCalled();
    h.feedback("praise", "Thanks, that worked. Now deliver another package.");
    h.runtime.proposal = {
      kind: "skip",
      reason: "Praise and a new task do not correct this receipt.",
    };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "skipped",
      proposal: { totalTokens: 30, costUsd: 0 },
    });
    expect(h.runtime.comparisonCalls).toBe(0);
    expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
    expect(h.posted).toHaveLength(0);
  });
  it("leaves a manual reflection with the existing reviewer", async () => {
    const h = harness();
    expect(await reflectTicketImprovement(h.deps, { runId: h.run.id })).toBe(false);
    expect(h.resolveModel).not.toHaveBeenCalled();
  });
  it("keeps a model-route change unknown without spending a proposal call", async () => {
    const h = harness();
    h.run.modelId = "earlier-model";
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "unknown",
      proposal: { error: "original_model_route_unavailable" },
    });
    expect(h.runtime.proposalCalls).toBe(0);
  });
  it("counts cache buckets in a proposal total and proceeds when a provider omits one", async () => {
    const complete = harness();
    complete.runtime.proposal = { kind: "skip", reason: "Nothing here corrects the receipt." };
    complete.runtime.proposalUsage = { totalTokens: null, cacheReadTokens: 5, cacheWriteTokens: 0 };
    await reflectTicketImprovement(complete.deps, { runId: complete.run.id, auto: true });
    expect(complete.result()).toMatchObject({ status: "skipped", proposal: { totalTokens: 35 } });

    // The total stays unknown rather than being summed from an incomplete breakdown.
    const partial = harness();
    partial.runtime.proposalUsage = { totalTokens: null, cacheReadTokens: 5 };
    await reflectTicketImprovement(partial.deps, { runId: partial.run.id, auto: true });
    expect(partial.result()).toMatchObject({
      status: "adopted",
      proposal: { totalTokens: null, error: null },
    });

    const unreported = harness();
    unreported.runtime.proposalUsage = { totalTokens: null, inputTokens: null };
    await reflectTicketImprovement(unreported.deps, { runId: unreported.run.id, auto: true });
    expect(unreported.result()).toMatchObject({
      status: "unknown",
      proposal: { error: "missing_proposal_usage" },
    });
    expect(unreported.runtime.comparisonCalls).toBe(0);
  });
  it("keeps the configured proposal output and accepts reported usage above the former ceiling", async () => {
    const h = harness();
    h.runtime.proposalUsage = { inputTokens: 40_000, outputTokens: 5_000, totalTokens: 45_000 };
    const run = h.runtime.run.bind(h.runtime);
    h.runtime.run = async function* (request, context) {
      if (request.runId.endsWith(":proposal")) {
        const observer = request.model.callObserver!;
        const reservation = await observer.beforeCall({
          provider: request.model.provider,
          modelId: request.model.id,
          inputTokensEstimate: 40_000,
          maxOutputTokens: request.model.maxTokens!,
        });
        await observer.afterCall(reservation, null);
      }
      yield* run(request, context);
    };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "adopted",
      proposal: { totalTokens: 45_000, error: null },
    });
    expect(h.runtime.requests.every((request) => request.model.maxTokens === 32_768)).toBe(true);
  });
  it.each(["bad-quote", "missing-usage", "provider-error"])(
    "saves an unknown result for %s",
    async (kind) => {
      const h = harness();
      if (kind === "bad-quote")
        h.runtime.proposal = {
          kind: "candidate",
          quote: "Made-up correction",
          playbook: goodDeliveryPlaybook,
        };
      if (kind === "missing-usage") h.runtime.missingUsage = true;
      if (kind === "provider-error")
        h.runtime.proposalError = new Error("failed fixture-api-secret fixture-header-secret");
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result().status).toBe("unknown");
      expect(JSON.stringify(h.result())).not.toContain("fixture-api-secret");
      expect(JSON.stringify(h.result())).not.toContain("fixture-header-secret");
      expect(h.runtime.comparisonCalls).toBe(0);
    },
  );
});

describe("ticket improvement actual isolated comparison", () => {
  it("passes current production runtime capabilities when activating a proved component set", async () => {
    const h = harness();
    h.current().snapshot.components = {
      ...BASELINE_COMPONENTS,
      items: [
        ...BASELINE_COMPONENTS.items,
        {
          id: "lister",
          revision: "1",
          kind: "plugin",
          capabilityId: "isolated.snapshot.list_files",
        },
      ],
    };
    const run = h.runtime.run.bind(h.runtime);
    h.runtime.run = async function* (request, context) {
      // The out-of-scope fixture exits before listing in the shared test runtime.
      if (request.tools.some(({ name }) => name === "list_files"))
        await request.executeTool!("list_files", { path: "installed" }, `${request.runId}:list`);
      yield* run(request, context);
    };
    const trialRuntime = h.runtime.describe();
    const productionCapabilities = { ...trialRuntime.capabilities, tools: false };
    h.afterStore("comparison", () => {
      vi.spyOn(h.runtime, "describe").mockReturnValue({
        ...trialRuntime,
        capabilities: productionCapabilities,
      });
    });
    vi.mocked(activateTaughtSkillRevision).mockResolvedValue({
      status: "not_adopted",
      reason: "unqualified",
    });

    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });

    expect(h.revisions[0]?.snapshot.trial?.componentProof?.eligible).toBe(true);
    expect(activateTaughtSkillRevision).toHaveBeenCalledWith(h.deps.prisma, expect.anything(), {
      skillId: BASELINE.skillId,
      revisionId: h.revisions[0]!.id,
      expectedCurrentRevisionId: BASELINE.id,
      runtimeCapabilities: productionCapabilities,
    });
    expect(h.result()).toMatchObject({
      status: "retained",
      comparison: { decision: "adopt" },
      activation: { status: "not_adopted", reason: "unqualified" },
    });
    expect(h.current().id).toBe(BASELINE.id);
  });

  it("composes and persists the exact component set proved by the rerun", async () => {
    const h = harness();
    h.current().snapshot.components = BASELINE_COMPONENTS;
    const composedComponents: ImprovementComponentSet = {
      schemaVersion: "improvement-components.v1",
      items: [
        ...BASELINE_COMPONENTS.items,
        {
          id: "task-guidance",
          revision: "2",
          kind: "task_guidance",
          text: "Check the completed upload receipt.",
        },
      ],
    };
    const composedPlaybook = {
      ...goodDeliveryPlaybook,
      howToCheck: "Check the complete tree and completed upload receipt.",
    };
    h.runtime.compositionReply = {
      kind: "compose",
      playbook: composedPlaybook,
      components: composedComponents,
    };

    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });

    const result = h.result();
    expect(result.status).toBe("unknown");
    expect(result.comparison.initial.candidate.components).toEqual(BASELINE_COMPONENTS);
    expect(result.comparison.composition.candidate.components).toEqual(composedComponents);
    expect(result.comparison.composed.candidate.components).toEqual(composedComponents);
    expect(result.comparison.composed.componentEligibility.candidate.eligible).toBe(true);
    expect(result.candidateRevisionId).toBe(h.revisions[0]?.id);
    expect(h.revisions[0]?.snapshot.components).toEqual(composedComponents);
    expect(h.revisions[0]?.snapshot.trial).toMatchObject({
      componentProof: {
        eligible: true,
        candidateRevision: result.comparison.composed.candidate.revision,
        runs: expect.arrayContaining([
          expect.objectContaining({
            caseId: expect.any(String),
            runId: expect.any(String),
            receipts: expect.arrayContaining([
              expect.objectContaining({
                componentId: "task-guidance",
                componentRevision: "2",
                status: "applied",
              }),
            ]),
          }),
        ]),
      },
    });
    expect(h.revisions[0]?.snapshot.trial?.candidateSnapshotHash).toBe(
      taughtSkillRevisionHash(composedPlaybook, composedComponents),
    );
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
    expect(h.current().id).toBe(BASELINE.id);
  });

  it("saves real tool evidence before adoption, attaches it to the feedback, and reuses it on retry", async () => {
    const h = harness();
    const composedPlaybook = {
      ...goodDeliveryPlaybook,
      howToCheck: "Check complete directory evidence, then the final upload receipt.",
    };
    h.runtime.compositionReply = { kind: "compose", playbook: composedPlaybook };
    h.resolveModel.mockResolvedValue({
      ...(await h.resolveModel()),
      thinkingLevel: "high",
    } as Awaited<ReturnType<typeof h.resolveModel>>);
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const result = h.result();
    expect(result).toMatchObject({
      status: "adopted",
      calibration: { kind: "fixed_synthetic" },
      improverRevision: CURRENT_IMPROVER,
      proposal: { result: { kind: "candidate", playbook: goodDeliveryPlaybook } },
      comparison: {
        schemaVersion: "work-improvement.composition.v1",
        decision: "adopt",
        initial: { candidate: { playbook: goodDeliveryPlaybook }, decision: "adopt" },
        composition: {
          status: "composed",
          candidate: { playbook: composedPlaybook },
          totalTokens: 30,
          costUsd: 0,
        },
        composed: {
          candidate: { playbook: composedPlaybook },
          decision: "adopt",
          summary: {
            improvements: ["stale", "selected"],
            candidate: { passed: 7, falsePositiveCompletions: 0 },
          },
        },
      },
    });
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(h.current().snapshot.playbook).toEqual(composedPlaybook);
    expect(h.current().snapshot.trial).toMatchObject({
      improvedCases: 2,
      protectedCasesPassed: true,
      falsePasses: 0,
      withinBudget: true,
      artifactId: result.comparisonArtifact.id,
      candidatePlaybookHash: taughtSkillPlaybookHash(composedPlaybook),
      baselineGeneration: 0,
    });
    expect(h.current().snapshot.trial!.candidatePlaybookHash).not.toBe(
      taughtSkillPlaybookHash(goodDeliveryPlaybook),
    );
    expect(activateTaughtSkillRevision).toHaveBeenCalledWith(h.deps.prisma, expect.anything(), {
      skillId: BASELINE.skillId,
      revisionId: h.current().id,
      expectedCurrentRevisionId: BASELINE.id,
    });
    const canonical = h.artifacts.find((artifact) => artifact.id === result.comparisonArtifact.id)!;
    expect(canonical).toMatchObject({
      botId: "worker-bot",
      groupId: null,
      version: result.comparisonArtifact.version,
      hash: result.comparisonArtifact.hash,
    });
    expect(h.posted[0]).toMatchObject({
      botId: "owner-bot",
      threadId: "owner-thread",
      replyToMessageId: "feedback",
      blocks: [
        expect.objectContaining({ kind: "meta" }),
        expect.objectContaining({ kind: "file" }),
      ],
    });
    expect(h.posted[0]).not.toHaveProperty("runId");
    const linked = (h.posted[0]!.blocks as MessageBlock[]).find((block) => block.kind === "file")!;
    expect(h.artifacts.find((artifact) => artifact.id === linked.artifactId)).toMatchObject({
      botId: "owner-bot",
      groupId: null,
    });
    for (const entry of result.comparison.composed.cases) {
      expect(entry.baseline.workspaceId).not.toBe(entry.candidate.workspaceId);
      expect(entry.candidate.tools[0]).toMatchObject({
        name: "read_file",
        status: "succeeded",
        result: { path: "request.json", content: expect.any(String) },
      });
    }
    const proposalRequest = h.runtime.requests.find((request) =>
      request.runId.endsWith(":proposal"),
    )!;
    expect(proposalRequest.tools).toEqual([]);
    expect(proposalRequest.model.maxTokens).toBe(32_768);
    expect(
      h.runtime.requests
        .filter((request) => request.tools.length > 0)
        .every((request) => request.model.maxTokens === 32_768),
    ).toBe(true);
    expect(result.comparison.composed.execution.budget).not.toHaveProperty("maxTotalTokens");
    const composerRequest = h.runtime.requests.find(
      (request) => !request.runId.endsWith(":proposal") && !request.tools.length,
    )!;
    expect(composerRequest.tools).toEqual([]);
    expect(composerRequest.history).toEqual([]);
    expect(composerRequest.model).toMatchObject({
      provider: "fixture",
      id: "model",
      maxTokens: 32_768,
      thinkingLevel: "high",
    });
    expect(
      h.runtime.requests.every(
        (request) =>
          request.model.provider === "fixture" &&
          request.model.id === "model" &&
          request.model.thinkingLevel === "high" &&
          request.fallbackModels === undefined,
      ),
    ).toBe(true);
    const rerunIds = new Set<string>(
      result.comparison.composed.cases.map(
        (entry: { candidate: WorkImprovementRun }) => entry.candidate.runId,
      ),
    );
    const reruns = h.runtime.requests.filter((request) => rerunIds.has(request.runId));
    expect(reruns).toHaveLength(7);
    for (const request of reruns)
      expect(JSON.parse(request.instructions.split("\n").at(-1)!).playbook).toEqual(
        composedPlaybook,
      );
    expect(proposalRequest.history).toEqual([]);
    expect(proposalRequest.prompt).not.toContain('"expected"');
    expect(proposalRequest.prompt).not.toContain("package-stale");
    expect(vi.mocked(recordUsage).mock.calls).toHaveLength(30);
    expect(
      vi
        .mocked(recordUsage)
        .mock.calls.every(
          ([, , attribution]) =>
            attribution.operationKind === "learning" && attribution.parentRunId === h.run.id,
        ),
    ).toBe(true);
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(vi.mocked(recordUsage).mock.calls).toHaveLength(30);
    expect(snapshotTaughtSkillRevision).toHaveBeenCalledTimes(1);
    expect(h.posted).toHaveLength(1);
    expect(appendEventInTransaction).toHaveBeenCalledTimes(1);
  });
  it("rejects a candidate that flags allowed runtime files and keeps the baseline", async () => {
    const h = harness();
    h.runtime.proposal = { kind: "candidate", quote: CORRECTION, playbook: badDeliveryPlaybook };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "retained",
      comparison: {
        decision: "reject",
        composed: { reasons: expect.arrayContaining(["protected_case_failed", "regression"]) },
      },
    });
    expect(h.revisions[0]!.snapshot.trial).toMatchObject({
      outcome: "regressed",
      improvedCases: 2,
      protectedCasesPassed: false,
    });
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
    expect(h.current().id).toBe(BASELINE.id);
  });
  it.each(["reject", "invalid", "missing-usage"] as const)(
    "does not fall back to an initial adoption when composition returns %s",
    async (mode) => {
      const h = harness();
      if (mode === "reject")
        h.runtime.compositionReply = { kind: "reject", reason: "Keep the existing procedure." };
      if (mode === "invalid") h.runtime.compositionReply = "Not a composition";
      if (mode === "missing-usage") h.runtime.missingCompositionUsage = true;
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result()).toMatchObject({
        status: mode === "reject" ? "retained" : "unknown",
        comparison: {
          initial: { decision: "adopt" },
          composition: { status: mode === "reject" ? "rejected" : "unknown" },
          composed: null,
          decision: mode === "reject" ? "reject" : "inconclusive",
          retainedRevision: BASELINE.id,
        },
      });
      expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
      expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.runtime.proposalCalls).toBe(1);
      expect(h.runtime.compositionCalls).toBe(1);
      expect(h.runtime.comparisonCalls).toBe(14);
      expect(h.current().id).toBe(BASELINE.id);
    },
  );
  it("retains the baseline when the composed rerun regresses after a successful first trial", async () => {
    const h = harness();
    h.runtime.compositionReply = { kind: "compose", playbook: badDeliveryPlaybook };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "retained",
      proposal: { result: { playbook: goodDeliveryPlaybook } },
      comparison: {
        initial: { decision: "adopt" },
        composed: {
          candidate: { playbook: badDeliveryPlaybook },
          decision: "reject",
          reasons: expect.arrayContaining(["protected_case_failed"]),
        },
      },
    });
    expect(h.revisions[0]!.snapshot.playbook).toEqual(badDeliveryPlaybook);
    expect(h.revisions[0]!.snapshot.trial).toMatchObject({
      candidatePlaybookHash: taughtSkillPlaybookHash(badDeliveryPlaybook),
      outcome: "regressed",
    });
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it.each(["missing-rerun", "different-playbook", "different-revision"] as const)(
    "keeps cached composition evidence unqualified with %s",
    async (mode) => {
      const h = harness();
      h.afterStore("comparison", () => vi.stubEnv("SELF_EVOLUTION", "off"));
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      const record = h.checkpoint("comparison");
      if (mode === "missing-rerun") record.comparison.composed = null;
      if (mode === "different-playbook")
        record.comparison.composed.candidate.playbook = badDeliveryPlaybook;
      if (mode === "different-revision")
        record.comparison.composed.candidate.revision = "not-the-composed-revision";
      h.replaceCheckpoint("comparison", record);
      h.resolveModel.mockClear();
      vi.stubEnv("SELF_EVOLUTION", "1");
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result().status).toBe("unknown");
      expect(h.resolveModel).not.toHaveBeenCalled();
      expect(h.runtime.compositionCalls).toBe(1);
      expect(h.runtime.comparisonCalls).toBe(28);
      expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
      expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
    },
  );
  it("retains unknown costs and partial token totals at every stage without inventing zero totals", async () => {
    const h = harness();
    h.runtime.proposalUsage = { totalTokens: null, costUsd: null };
    h.runtime.comparisonUsage = { totalTokens: null, costUsd: null };
    h.runtime.compositionUsage = { totalTokens: null, costUsd: null };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const result = h.result();
    expect(result.status).toBe("adopted");
    expect(result.proposal).toMatchObject({ totalTokens: null, costUsd: null });
    expect(result.comparison.composition).toMatchObject({
      totalTokens: null,
      knownTotalTokens: 30,
      costUsd: null,
      knownCostUsd: 0,
    });
    for (const trial of [result.comparison.initial, result.comparison.composed]) {
      expect(trial.summary.baseline).toMatchObject({ totalTokens: null, costUsd: null });
      expect(trial.summary.candidate).toMatchObject({ totalTokens: null, costUsd: null });
    }
    expect(h.current().snapshot.trial!.withinBudget).toBe(true);
  });
  it.each(["initial-attempt", "rerun-attempt", "composer", "proposal"] as const)(
    "includes %s evidence in activation budget eligibility",
    async (stage) => {
      const h = harness();
      h.afterStore("comparison", () => vi.stubEnv("SELF_EVOLUTION", "off"));
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      const record = h.checkpoint("comparison");
      if (stage === "initial-attempt" || stage === "rerun-attempt") {
        const trial =
          stage === "initial-attempt" ? record.comparison.initial : record.comparison.composed;
        const candidate = trial.cases[0].candidate;
        candidate.previousAttempt = {
          ...structuredClone(candidate),
          errors: [{ code: "missing_usage", message: "First call had no receipt." }],
        };
      }
      if (stage === "composer") record.comparison.composition.durationMs = 180_001;
      if (stage === "proposal") record.proposal.durationMs = 180_001;
      h.replaceCheckpoint("comparison", record);
      vi.stubEnv("SELF_EVOLUTION", "1");
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result().status).toBe("retained");
      expect(h.revisions[0]!.snapshot.trial).toMatchObject({
        outcome: "improved",
        withinBudget: false,
      });
      expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
      expect(h.current().id).toBe(BASELINE.id);
    },
  );
  it("retains the current revision when a candidate calls a manifest-only snapshot clean", async () => {
    const h = harness();
    h.runtime.proposal = {
      kind: "candidate",
      quote: CORRECTION,
      playbook: manifestOnlyDeliveryPlaybook,
    };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "retained",
      comparison: {
        decision: "reject",
        composed: {
          reasons: expect.arrayContaining(["false_positive_completion", "protected_case_failed"]),
          cases: expect.arrayContaining([
            expect.objectContaining({
              id: "manifest-only",
              expected: expect.objectContaining({
                checks: { installation: "pass", directory: "unknown", upload: "pass" },
              }),
              candidate: expect.objectContaining({
                score: expect.objectContaining({ falsePositiveCompletion: true }),
              }),
            }),
          ]),
        },
      },
    });
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("keeps a tie and a CAS conflict on the current revision", async () => {
    const h = harness();
    h.baseline.snapshot.playbook = goodDeliveryPlaybook;
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "retained",
      comparison: { decision: "reject", composed: { reasons: ["no_improvement"] } },
    });
    expect(h.revisions[0]!.snapshot.trial).toMatchObject({ outcome: "tie", improvedCases: 0 });
    h.feedback("next-feedback");
    h.changeCurrent();
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.current().id).toBe("human-revision");
    expect(h.result().status).toBe("conflict");
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("recovers the saved comparison and already-activated candidate after final storage fails", async () => {
    const h = harness();
    h.failStore("result");
    await expect(reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).rejects.toThrow(
      "checkpoint storage unavailable",
    );
    expect(h.current().id).toBe("candidate-0");
    h.resolveModel.mockRejectedValue(new Error("credentials unavailable after comparison"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result().status).toBe("adopted");
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(snapshotTaughtSkillRevision).toHaveBeenCalledTimes(1);
    expect(activateTaughtSkillRevision).toHaveBeenCalledTimes(1);
  });
  it("recovers a completed rerun without paying again when the comparison checkpoint fails", async () => {
    const h = harness();
    h.failStore("comparison");
    await expect(reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).rejects.toThrow(
      "checkpoint storage unavailable",
    );
    expect(h.checkpoint("composed")).toMatchObject({
      comparison: { composed: { decision: "adopt" } },
    });
    expect(h.checkpoint("comparison")).toBeUndefined();
    h.resolveModel.mockRejectedValue(new Error("route no longer available"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result().status).toBe("adopted");
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(vi.mocked(recordUsage).mock.calls).toHaveLength(30);
    expect(activateTaughtSkillRevision).toHaveBeenCalledTimes(1);
  });
  it.each(["initial", "composition"] as const)(
    "resumes the durable %s checkpoint without repeating its completed calls",
    async (phase) => {
      const h = harness();
      h.afterStore("comparison", () => vi.stubEnv("SELF_EVOLUTION", "off"));
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      const checkpoint = h.checkpoint(phase);
      h.removeCheckpoints(
        "comparison",
        "composed",
        ...(phase === "initial" ? ["composition"] : []),
      );
      h.runtime.requests.length = 0;
      h.runtime.proposalCalls = 0;
      h.runtime.comparisonCalls = 0;
      h.runtime.compositionCalls = 0;
      vi.mocked(recordUsage).mockClear();
      h.afterStore("unused", () => {});
      vi.stubEnv("SELF_EVOLUTION", "1");
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result().status).toBe("adopted");
      expect(h.result().comparison.initial).toEqual(checkpoint.compositionCheckpoint.initial);
      expect(h.runtime.proposalCalls).toBe(0);
      expect(h.runtime.comparisonCalls).toBe(14);
      expect(h.runtime.compositionCalls).toBe(phase === "initial" ? 1 : 0);
      expect(recordUsage).toHaveBeenCalledTimes(phase === "initial" ? 15 : 14);
      expect(activateTaughtSkillRevision).toHaveBeenCalledTimes(1);
    },
  );
  it("finishes a cached composer rejection with no route and no additional calls", async () => {
    const h = harness();
    h.runtime.compositionReply = { kind: "reject", reason: "No justified composition." };
    h.failStore("composed");
    await expect(reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).rejects.toThrow(
      "checkpoint storage unavailable",
    );
    h.resolveModel.mockRejectedValue(new Error("route no longer available"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result().status).toBe("retained");
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(14);
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("reads and recovers a legacy comparison without relabeling it as composed", async () => {
    const h = harness();
    h.afterStore("comparison", () => vi.stubEnv("SELF_EVOLUTION", "off"));
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const record = h.checkpoint("comparison");
    record.comparison = record.comparison.initial;
    h.replaceCheckpoint("comparison", record);
    h.runtime.requests.length = 0;
    h.resolveModel.mockClear();
    vi.stubEnv("SELF_EVOLUTION", "1");
    expect(await reflectTicketImprovement(h.deps, { runId: h.run.id })).toBe(false);
    expect(snapshotTaughtSkillRevision).not.toHaveBeenCalled();
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "adopted",
      comparison: { schemaVersion: "work-improvement.comparison.v1", decision: "adopt" },
    });
    expect(h.result().comparison).not.toHaveProperty("composition");
    expect(h.current().snapshot.playbook).toEqual(goodDeliveryPlaybook);
    expect(h.runtime.requests).toHaveLength(0);
    expect(h.resolveModel).not.toHaveBeenCalled();
  });
  it("recovers a durable candidate after snapshot completion was interrupted", async () => {
    const h = harness();
    const snapshot = vi.mocked(snapshotTaughtSkillRevision).getMockImplementation()!;
    vi.mocked(snapshotTaughtSkillRevision).mockImplementationOnce(async (...args) => {
      await snapshot(...args);
      throw new Error("snapshot completion interrupted");
    });
    await expect(reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).rejects.toThrow(
      "snapshot completion interrupted",
    );
    expect(h.revisions).toHaveLength(1);
    expect(h.current().id).toBe(BASELINE.id);
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result().status).toBe("adopted");
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(h.runtime.compositionCalls).toBe(1);
    expect(snapshotTaughtSkillRevision).toHaveBeenCalledTimes(1);
  });
  it("honors a rollback after activation when the result checkpoint was interrupted", async () => {
    const h = harness();
    h.failStore("result");
    await expect(reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true })).rejects.toThrow(
      "checkpoint storage unavailable",
    );
    h.rollback();
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({ status: "conflict", activation: { status: "conflict" } });
    expect(h.current().id).toBe(BASELINE.id);
    expect(getCurrentTaughtSkillRevisionState).toHaveBeenCalledTimes(1);
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(28);
    expect(h.runtime.compositionCalls).toBe(1);
  });
  it("saves unqualified runs as unknown without activating the candidate", async () => {
    const h = harness();
    h.runtime.missingComparisonUsage = true;
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "unknown",
      comparison: {
        decision: "inconclusive",
        composed: { summary: { baseline: { unknown: 7 }, candidate: { unknown: 7 } } },
      },
    });
    expect(h.revisions[0]!.snapshot.trial).toMatchObject({
      outcome: "insufficient",
      improvedCases: 0,
      withinBudget: false,
    });
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("supplies later proposals with historical summaries without holdout materials or truth", async () => {
    const h = harness();
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    h.feedback("later-feedback");
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const request = h.runtime.requests.filter((entry) => entry.runId.endsWith(":proposal")).at(-1)!;
    expect(request.prompt).toContain("work-improvement.history.v1");
    expect(request.prompt).not.toContain('"expected"');
    expect(request.prompt).not.toContain('"materials"');
    expect(request.prompt).not.toContain("package-stale");
    expect(request.prompt).not.toContain('"caseId":"selected"');
  });
  it("finds older same-skill failure history beyond a full page of other skills", async () => {
    const h = harness();
    h.runtime.proposal = {
      kind: "candidate",
      quote: CORRECTION,
      playbook: badDeliveryPlaybook,
    };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const failedComparison = h.result().comparison as WorkImprovementComposition;
    const prior = h.artifacts.find((artifact) => artifact.clientNonce?.endsWith(":comparison"))!;
    prior.createdAt = new Date("2026-11-01T00:00:00.000Z");

    for (let index = 0; index < 20; index++)
      h.seedHistory(
        `unrelated-skill-${index}`,
        failedComparison,
        `ticket-improvement:unrelated-${index}`,
        new Date(`2026-11-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`),
      );

    h.feedback("later-feedback");
    h.runtime.proposal = {
      kind: "candidate",
      quote: CORRECTION,
      playbook: goodDeliveryPlaybook,
    };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const request = h.runtime.requests.filter((entry) => entry.runId.endsWith(":proposal")).at(-1)!;
    expect(request.prompt).toContain('"decision":"reject"');
    expect(request.prompt).toContain('"protected_case_failed"');
  });
  it("keeps legacy and composed history distinct while retaining the original first trial", async () => {
    const h = harness();
    h.runtime.compositionReply = { kind: "reject", reason: "No justified composition." };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    h.seedHistory(
      BASELINE.skillId,
      h.result().comparison.initial,
      "ticket-improvement:legacy",
      new Date("2026-11-01T00:00:00Z"),
    );
    h.feedback("later-feedback");
    h.runtime.proposal = { kind: "skip", reason: "No additional correction." };
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const request = h.runtime.requests.filter((entry) => entry.runId.endsWith(":proposal")).at(-1)!;
    const encoded = request.prompt.split("<earlier_trial_summaries>")[1]!.split("</")[0]!;
    const summaries = JSON.parse(encoded);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      schemaVersion: "ticket-improvement.composition-history.v1",
      initial: { schemaVersion: "work-improvement.history.v1", decision: "adopt" },
      composition: { status: "rejected" },
      composed: null,
      decision: "reject",
      retainedRevision: BASELINE.id,
    });
    expect(summaries[1]).toMatchObject({
      schemaVersion: "work-improvement.history.v1",
      decision: "adopt",
    });
    expect(summaries[1]).not.toHaveProperty("composition");
  });
  it.each(["artifact", "page"] as const)(
    "finishes at the shared deadline while the underlying %s read stays pending",
    async (boundary) => {
      const h = harness();
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      h.feedback("blocked-history-feedback");
      const controller = new AbortController();
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        ms === 180_000 ? controller.signal : originalTimeout(ms),
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let underlyingSettled = false;
      if (boundary === "artifact") {
        const get = vi.mocked(h.deps.artifacts.get).getMockImplementation()!;
        vi.mocked(h.deps.artifacts.get).mockImplementation(async (...args) => {
          if (args[1].operationId === "ticket-improvement:history") {
            expect(args[1].signal).toBe(controller.signal);
            entered();
            await held;
            underlyingSettled = true;
          }
          return get(...args);
        });
      } else {
        const findMany = vi.mocked(h.deps.prisma.artifact.findMany).getMockImplementation()!;
        vi.mocked(h.deps.prisma.artifact.findMany).mockImplementationOnce((args) => {
          entered();
          return held.then(() => {
            underlyingSettled = true;
            return findMany(args);
          }) as ReturnType<typeof findMany>;
        });
      }
      let finished = false;
      const pending = reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true }).then(() => {
        finished = true;
      });
      try {
        await started;
        controller.abort(new Error("proposal deadline"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).toBe(true);
        expect(underlyingSettled).toBe(false);
        expect(h.result()).toMatchObject({
          status: "unknown",
          proposal: { result: null, error: "proposal deadline" },
        });
      } finally {
        release();
        await pending;
      }
      expect(h.runtime.proposalCalls).toBe(1);
      expect(h.runtime.compositionCalls).toBe(1);
      expect(h.runtime.comparisonCalls).toBe(28);
    },
  );
  it.each(["artifact", "page"] as const)(
    "stops history at the shared proposal deadline during a %s read",
    async (boundary) => {
      const h = harness();
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      const prior = h.artifacts.find((artifact) => artifact.clientNonce?.endsWith(":comparison"))!;
      prior.createdAt = new Date("2026-10-01T00:00:00Z");
      for (let index = 0; index < 40; index++)
        h.seedHistory(
          `other-skill-${index}`,
          h.result().comparison.initial,
          `ticket-improvement:other-${index}`,
          new Date("2026-11-01T00:00:00Z"),
        );
      h.feedback("deadline-feedback");
      const controller = new AbortController();
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => (ms === 180_000 ? controller.signal : originalTimeout(ms)));
      const historySignals: Array<AbortSignal | undefined> = [];
      const get = vi.mocked(h.deps.artifacts.get).getMockImplementation()!;
      vi.mocked(h.deps.artifacts.get).mockImplementation(async (...args) => {
        if (args[1].operationId === "ticket-improvement:history") {
          historySignals.push(args[1].signal);
          if (boundary === "artifact" && historySignals.length === 20)
            controller.abort(new Error("proposal deadline"));
        }
        return get(...args);
      });
      const pages: number[] = [];
      const findMany = vi.mocked(h.deps.prisma.artifact.findMany).getMockImplementation()!;
      vi.mocked(h.deps.prisma.artifact.findMany).mockImplementation((args) => {
        pages.push(args?.skip ?? 0);
        if (boundary === "page" && args?.skip === 20)
          controller.abort(new Error("proposal deadline"));
        return findMany(args);
      });
      await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
      expect(h.result()).toMatchObject({
        status: "unknown",
        proposal: { result: null, error: "proposal deadline" },
      });
      expect(historySignals).toHaveLength(20);
      expect(historySignals.every((signal) => signal === controller.signal)).toBe(true);
      expect(pages).toEqual(boundary === "artifact" ? [0] : [0, 20]);
      expect(timeout.mock.calls.filter(([ms]) => ms === 180_000)).toHaveLength(1);
      expect(h.runtime.proposalCalls).toBe(1);
      expect(h.runtime.compositionCalls).toBe(1);
      expect(h.runtime.comparisonCalls).toBe(28);
    },
  );
});

describe("ticket improvement trial budget", () => {
  const attempt = (
    toolCount: number,
    errors: WorkImprovementRun["errors"] = [],
  ): WorkImprovementRun =>
    ({
      tools: Array.from({ length: toolCount }, () => ({})),
      durationMs: 100,
      errors,
    }) as WorkImprovementRun;

  const trialFor = (candidate: WorkImprovementRun) => {
    const comparison = {
      schemaVersion: "work-improvement.comparison.v1",
      summary: {
        improvements: ["case"],
        protectedCases: { correct: 1, total: 1 },
        candidate: { falsePositiveCompletions: 0 },
      },
      baseline: { revision: "baseline", playbook: baselineDeliveryPlaybook },
      candidate: { revision: "candidate", playbook: goodDeliveryPlaybook },
      execution: { budget: { maxModelCalls: 1, maxToolCalls: 16, timeoutMs: 180_000 } },
      decision: "adopt",
      reasons: [],
      scorerVersion: "work-improvement.scorer.v1",
      cases: [{ baseline: attempt(1), candidate }],
    } as unknown as WorkImprovementComparison;
    return ticketImprovementTrial(comparison, { id: "comparison", version: 1, hash: "hash" }, 0);
  };

  it("checks each retry attempt without summing their separate budgets", () => {
    const successfulRetry = attempt(9);
    successfulRetry.previousAttempt = attempt(9);
    expect(trialFor(successfulRetry)).toMatchObject({ outcome: "improved", withinBudget: true });

    const missingFirstUsage = attempt(9);
    missingFirstUsage.previousAttempt = attempt(9, [{ code: "missing_usage", message: "unknown" }]);
    expect(trialFor(missingFirstUsage)).toMatchObject({
      outcome: "improved",
      withinBudget: false,
    });

    const overBudgetFirstAttempt = attempt(9);
    overBudgetFirstAttempt.previousAttempt = attempt(17);
    expect(trialFor(overBudgetFirstAttempt)).toMatchObject({
      outcome: "improved",
      withinBudget: false,
    });
  });
});
