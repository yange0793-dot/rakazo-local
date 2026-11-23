import { createHash } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
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
} from "./taught-skill-revisions.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import type { TicketImprovementDeps } from "./ticket-improvement.js";
import {
  CURRENT_IMPROVER,
  parseTicketImprovementProposal,
  reflectTicketImprovement,
} from "./ticket-improvement.js";
import {
  badDeliveryPlaybook,
  baselineDeliveryPlaybook,
  goodDeliveryPlaybook,
  manifestOnlyDeliveryPlaybook,
  OfflineTicketImprovementRuntime,
} from "./ticket-improvement.test-fixtures.js";

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

function harness() {
  const baseline = structuredClone(BASELINE);
  let current = baseline;
  let generation = 0;
  let feedbackId = "feedback";
  let feedbackText = CORRECTION;
  let failPhase: string | null = null;
  const files = new Map<string, Uint8Array>();
  const artifacts: Artifact[] = [];
  const revisions: TaughtSkillRevision[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const runtime = new OfflineTicketImprovementRuntime();
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
    $queryRaw: vi.fn(async () =>
      revisions.map((revision) => ({ id: revision.id, snapshot: revision.snapshot })),
    ),
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
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        artifacts.filter((row) => matches(row, where)),
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
      snapshot: { ...baseline.snapshot, playbook: input.playbook!, trial: input.trial! },
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
  return {
    deps,
    runtime,
    run,
    baseline,
    artifacts,
    revisions,
    posted,
    result,
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
    feedback: (id: string, text = CORRECTION) => {
      feedbackId = id;
      feedbackText = text;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
});
afterEach(() => vi.unstubAllEnvs());

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
  it("saves real tool evidence before adoption, attaches it to the feedback, and reuses it on retry", async () => {
    const h = harness();
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    const result = h.result();
    expect(result).toMatchObject({
      status: "adopted",
      calibration: { kind: "fixed_synthetic" },
      improverRevision: CURRENT_IMPROVER,
      comparison: {
        decision: "adopt",
        summary: {
          improvements: ["stale", "selected"],
          candidate: { passed: 7, falsePositiveCompletions: 0 },
        },
      },
    });
    expect(h.runtime.proposalCalls).toBe(1);
    expect(h.runtime.comparisonCalls).toBe(14);
    expect(h.current().snapshot.trial).toMatchObject({
      improvedCases: 2,
      protectedCasesPassed: true,
      falsePasses: 0,
      withinBudget: true,
      artifactId: result.comparisonArtifact.id,
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
    for (const entry of result.comparison.cases) {
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
    expect(result.comparison.execution.budget).not.toHaveProperty("maxTotalTokens");
    expect(proposalRequest.history).toEqual([]);
    expect(proposalRequest.prompt).not.toContain('"expected"');
    expect(proposalRequest.prompt).not.toContain("package-stale");
    expect(vi.mocked(recordUsage).mock.calls).toHaveLength(15);
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
    expect(h.runtime.comparisonCalls).toBe(14);
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
        reasons: expect.arrayContaining(["protected_case_failed", "regression"]),
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
    });
    expect(activateTaughtSkillRevision).not.toHaveBeenCalled();
  });
  it("keeps a tie and a CAS conflict on the current revision", async () => {
    const h = harness();
    h.baseline.snapshot.playbook = goodDeliveryPlaybook;
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "retained",
      comparison: { decision: "reject", reasons: ["no_improvement"] },
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
    expect(h.runtime.comparisonCalls).toBe(14);
    expect(snapshotTaughtSkillRevision).toHaveBeenCalledTimes(1);
    expect(activateTaughtSkillRevision).toHaveBeenCalledTimes(1);
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
    expect(h.runtime.comparisonCalls).toBe(14);
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
    expect(h.runtime.comparisonCalls).toBe(14);
  });
  it("saves unqualified runs as unknown without activating the candidate", async () => {
    const h = harness();
    h.runtime.missingComparisonUsage = true;
    await reflectTicketImprovement(h.deps, { runId: h.run.id, auto: true });
    expect(h.result()).toMatchObject({
      status: "unknown",
      comparison: {
        decision: "inconclusive",
        summary: { baseline: { unknown: 7 }, candidate: { unknown: 7 } },
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
});
