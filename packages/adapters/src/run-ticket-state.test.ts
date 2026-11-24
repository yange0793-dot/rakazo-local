import { createHash } from "node:crypto";
import type { AgentRunModel, AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { TicketFileDeliveryAcceptance, TicketWorkEvidenceRef } from "@rakazo/contracts";
import { TicketWorkStateSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TICKET_PROGRESS_CALIBRATION_CASES } from "./fixtures/ticket-progress-calibration.js";
import type { RunContext } from "./run-context.js";
import {
  ensureRunTicketWorkState,
  loadRunTicketWorkState,
  runTicketProgressCheck,
  saveRunTicketPendingCall,
  saveRunTicketWorkState,
  ticketEnvironment,
} from "./run-ticket-state.js";
import type { TicketProgressJudgeOptions } from "./ticket-progress-judge.js";
import {
  createTicketProgressJudge,
  TICKET_PROGRESS_RUBRIC_VERSION,
} from "./ticket-progress-judge.js";

afterEach(() => vi.unstubAllEnvs());

const computer = {
  id: "computer",
  homeRevision: "snapshot-1",
  homeRevisionAt: new Date(10),
  autoRecoveredAt: null,
  restorePending: false,
};
const descriptor = {
  id: "runtime",
  contractVersion: "1",
  adapterVersion: "2",
  capabilities: { streaming: true, tools: true, scripted: false, compaction: true },
};
const acceptance: TicketFileDeliveryAcceptance = {
  schemaVersion: 1,
  evaluatorRevision: "file-delivery.v1",
  requirementsVersion: 1,
  status: "verified",
  results: [
    {
      requirementId: "file",
      status: "verified",
      reason: "verified_observation",
      evidenceRefs: [
        {
          kind: "artifact",
          requirementId: "file",
          artifactId: "report",
          version: 1,
          hash: "a".repeat(64),
          observedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ],
};
const reportRef: TicketWorkEvidenceRef = {
  kind: "artifact",
  artifactId: "report",
  version: 1,
  hash: "a".repeat(64),
};

function fixture() {
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
  vi.stubEnv("GIT_SHA", "deployment-1");
  let now = 1_000_000;
  const ticket = {
    id: "ticket",
    spaceId: "space",
    createdByUserId: "user",
    assigneeBotId: "bot",
    createdByBotId: "bot",
    title: "Deliver a checked report",
    status: "doing",
    completedAt: null,
    originKey: "source-request" as string | null,
    originThreadId: "origin",
    receiptVersion: 0,
    fileDeliveryRequirements: {
      version: 1,
      items: [{ id: "file", kind: "artifact", description: "Readable report" }],
    } as unknown,
    workStateVersion: 0,
    workState: null as unknown,
  };
  const run = {
    id: "run",
    spaceId: "space",
    botId: "bot",
    userId: "user",
    ticketId: "ticket",
    checkpoint: "original-call",
    leaseOwner: "worker" as string | null,
    leaseFence: 1,
    status: "running",
  };
  const receipt = {
    schema: 1,
    ticketId: ticket.id,
    version: 1,
    acceptance: structuredClone(acceptance),
    findings: [{ outcome: "pass", conclusion: "Claimed completion", evidence: "Plan" }],
  };
  const receiptBytes = () => new TextEncoder().encode(JSON.stringify(receipt));
  const configuration = { id: "configuration" } as { id: string } | null;
  const flags = { configuration, staleCas: false, wrongHash: false, receiptUnavailable: false };
  const storedArtifacts: Array<{ id: string; version: number; hash: string; runId: string }> = [];
  const storedEffects: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
    updatedAt: Date;
  }> = [];
  const ticketUpdate = vi.fn(async ({ where, data }) => {
    if (flags.staleCas || where.workStateVersion !== ticket.workStateVersion) return { count: 0 };
    ticket.workState = structuredClone(data.workState);
    ticket.workStateVersion++;
    return { count: 1 };
  });
  const prisma = {
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(prisma),
    $queryRaw: vi.fn(async () => [{ id: ticket.id }]),
    run: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === run.id &&
        where.spaceId === run.spaceId &&
        where.userId === run.userId &&
        where.botId === run.botId
          ? { ...run }
          : null,
      ),
      findMany: vi.fn(async ({ where }) =>
        where.id.in.includes(run.id) && where.ticketId === run.ticketId ? [{ id: run.id }] : [],
      ),
      updateMany: vi.fn(async ({ where }) => ({
        count:
          where.leaseOwner === run.leaseOwner &&
          where.leaseFence === run.leaseFence &&
          where.status === run.status
            ? 1
            : 0,
      })),
    },
    ticket: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === ticket.id &&
        where.spaceId === ticket.spaceId &&
        where.createdByUserId === ticket.createdByUserId &&
        where.assigneeBotId === ticket.assigneeBotId &&
        (!where.originKey || ticket.originKey !== null)
          ? { ...ticket }
          : null,
      ),
      updateMany: ticketUpdate,
    },
    externalEffect: {
      findFirst: vi.fn(async () => flags.configuration),
      findMany: vi.fn(async ({ where }) =>
        where.kind?.notIn
          ? storedEffects
          : storedEffects.filter((effect) => where.id?.in.includes(effect.id)),
      ),
    },
    artifact: {
      findMany: vi.fn(async ({ where }) =>
        storedArtifacts.filter((artifact) => where.id.in.includes(artifact.id)),
      ),
      findFirst: vi.fn(async () => ({
        storageKey: "receipt-storage",
        size: receiptBytes().length,
        hash: flags.wrongHash
          ? "f".repeat(64)
          : createHash("sha256").update(receiptBytes()).digest("hex"),
      })),
    },
    message: {
      findFirst: vi.fn(async () => ({
        blocks: [
          {
            kind: "file",
            artifactId: "receipt",
            name: "work-ticket.json",
            mimeType: "application/json",
            size: 500,
          },
        ],
      })),
    },
  };
  const artifacts = {
    get: vi.fn(async () => {
      if (flags.receiptUnavailable) throw new Error("Unavailable");
      return receiptBytes();
    }),
  };
  const runtime = { describe: () => descriptor, run: vi.fn() };
  const ctx = {
    deps: { prisma, artifacts, runtime, ticketBoardEnabled: true, now: () => new Date(now) },
    run,
    runId: run.id,
    bot: { id: "bot", computer },
    workerId: "worker",
    fence: 1,
    attempt: { id: "attempt-1" },
    context: {
      runId: run.id,
      spaceId: "space",
      userId: "user",
      botId: "bot",
      signal: new AbortController().signal,
    },
    state: {
      toolCallStreak: { key: undefined, count: 0 },
      toolResults: new Map(),
      reply: { toolCalls: [] },
    },
    tools: { offered: [{ name: "read_file", readOnly: true }] },
    secrets: ["fixture-secret"],
  } as unknown as RunContext;
  return {
    ctx,
    prisma,
    ticket,
    run,
    flags,
    receipt,
    ticketUpdate,
    artifacts,
    runtime,
    storedArtifacts,
    storedEffects,
    advance: () => {
      now += 31_000;
    },
    state: () => TicketWorkStateSchema.parse(ticket.workState),
  };
}

function repeatedFailure(ctx: RunContext) {
  const fingerprint = `failed:${"a".repeat(64)}`;
  ctx.state.toolCallStreak = {
    key: 'read_file:{"path":"report"}',
    count: 3,
    executionId: "execution",
    results: [fingerprint],
    failures: 2,
  };
  ctx.state.toolResults.set("execution", fingerprint);
  ctx.state.reply.toolCalls = [{ executionId: "execution", label: "Read report" }];
}

function progressJudge(f: ReturnType<typeof fixture>, duringJudge?: () => void) {
  const model: AgentRunModel = {
    provider: "fixture-provider",
    id: "fixture-model",
    thinkingLevel: "high",
    callObserver: {
      beforeCall: vi.fn(async () => "reservation"),
      afterCall: vi.fn(async () => {}),
    },
  };
  const recordUsage = vi.fn<TicketProgressJudgeOptions["recordUsage"]>(async () => {});
  const requests: AgentRunRequest[] = [];
  const runtime: Pick<AgentRuntime, "run" | "abort"> = {
    async *run(request) {
      requests.push(request);
      expect(f.state().progress?.judge).toMatchObject({
        attempts: 1,
        unknownTokenAttempts: 1,
        unknownCostAttempts: 1,
      });
      duringJudge?.();
      const reservation = await request.model.callObserver!.beforeCall({
        provider: model.provider,
        modelId: model.id,
        inputTokensEstimate: 120,
        maxOutputTokens: 512,
        maxCostUsd: 0.002,
      });
      const usage = {
        provider: model.provider,
        model: model.id,
        inputTokens: 100,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 112,
        costUsd: 0.001,
        operationKind: "learning" as const,
      };
      await request.onUsage?.({ type: "usage", ...usage });
      await request.model.callObserver!.afterCall(reservation, usage);
      yield {
        type: "done",
        text: JSON.stringify({
          schemaVersion: 1,
          rubricVersion: TICKET_PROGRESS_RUBRIC_VERSION,
          verdicts: [
            ...TICKET_PROGRESS_CALIBRATION_CASES.map(({ id, expected }) => ({
              id,
              verdict: expected,
            })),
            { id: "current", verdict: "stalled" },
          ],
        }),
      };
    },
    abort: vi.fn(async () => {}),
  };
  const judge = createTicketProgressJudge({
    runtime,
    model,
    context: { ...f.ctx.context, botId: "bot", threadId: "origin" },
    goal: f.ticket.title,
    recordUsage,
  });
  return { judge, model, recordUsage, requests };
}

describe("run ticket work state integration", () => {
  it("initializes only after this attempt's configuration receipt, with no evidence or completion claims", async () => {
    const f = fixture();
    f.flags.configuration = null;
    expect(await ensureRunTicketWorkState(f.ctx)).toBeUndefined();
    expect(f.ticketUpdate).not.toHaveBeenCalled();
    f.flags.configuration = { id: "configuration" };
    const initialized = await ensureRunTicketWorkState(f.ctx);
    expect(initialized?.state).toMatchObject({
      goal: f.ticket.title,
      constraints: ["Readable report"],
      evidenceRefs: [],
      position: null,
      progress: null,
      pendingCall: null,
      sourceRunId: "run",
      configurationRef: "configuration",
    });
    expect(f.prisma.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: "run",
          idempotencyKey: JSON.stringify(["runtime_configuration", "run", "attempt-1", "start", 0]),
        }),
      }),
    );
    await ensureRunTicketWorkState(f.ctx);
    expect(f.ticketUpdate).toHaveBeenCalledTimes(1);
    expect(f.ticket.status).toBe("doing");
    expect(f.ticket.completedAt).toBeNull();
  });

  it.each(["unbound", "historical", "non-owner", "other-bot", "disabled"])(
    "leaves %s tickets on the existing path",
    async (scenario) => {
      const f = fixture();
      if (scenario === "unbound") f.run.ticketId = "";
      if (scenario === "historical") f.ticket.originKey = null;
      if (scenario === "non-owner") f.ticket.createdByUserId = "other";
      if (scenario === "other-bot") f.ticket.assigneeBotId = "other";
      if (scenario === "disabled") f.ctx.deps.ticketBoardEnabled = false;
      expect(await ensureRunTicketWorkState(f.ctx)).toBeUndefined();
      expect(f.ticketUpdate).not.toHaveBeenCalled();
    },
  );

  it("returns clear validation/CAS errors and retains the host progress budget on model writes", async () => {
    const f = fixture();
    await ensureRunTicketWorkState(f.ctx);
    await runTicketProgressCheck(f.ctx);
    const previous = f.state();
    const draft = {
      goal: "Check fixture-secret output",
      constraints: [],
      evidenceRefs: [],
      nextStep: "Read report",
      blocker: null,
      wait: null,
      position: null,
    };
    const update = {
      expectedVersion: f.ticket.workStateVersion,
      expectedRequirementsVersion: 1,
      state: draft,
    };
    expect(
      await saveRunTicketWorkState(f.ctx, { ...update, state: { ...draft, progress: null } }),
    ).toHaveProperty("error");
    expect(await saveRunTicketWorkState(f.ctx, { ...update, expectedVersion: 0 })).toMatchObject({
      error: expect.stringContaining("version_changed"),
    });
    const result = await saveRunTicketWorkState(f.ctx, update);
    expect(result).not.toHaveProperty("error");
    expect(f.state().progress).toEqual(previous.progress);
    expect(f.state().goal).not.toContain("fixture-secret");
    expect(f.ticket.status).toBe("doing");
  });

  it("preserves pending-call identity without relabeling historical evidence or environments", async () => {
    const f = fixture();
    await ensureRunTicketWorkState(f.ctx);
    const before = f.state();
    f.ctx.bot.computer = { ...f.ctx.bot.computer!, homeRevision: "changed" };
    await saveRunTicketPendingCall(f.ctx, {
      toolCallId: "original-call",
      toolName: "request_secret",
      effectId: null,
    });
    expect(f.state().pendingCall).toEqual({
      toolCallId: "original-call",
      toolName: "request_secret",
      effectId: null,
    });
    expect(f.state().environment).toEqual(before.environment);
    expect(f.state().updatedAt).toBe(before.updatedAt);
    expect(f.run.checkpoint).toBe("original-call");
    f.flags.staleCas = true;
    await expect(saveRunTicketPendingCall(f.ctx, null)).resolves.toBeUndefined();
    expect(f.state().pendingCall?.toolCallId).toBe("original-call");
    f.flags.staleCas = false;
    f.run.leaseOwner = "replacement-worker";
    await expect(saveRunTicketPendingCall(f.ctx, null)).rejects.toThrow("lease expired");
    expect(f.run.checkpoint).toBe("original-call");
  });

  it("restores a subsequent worker from stored work and keeps the progress budget", async () => {
    const f = fixture();
    await ensureRunTicketWorkState(f.ctx);
    await runTicketProgressCheck(f.ctx);
    const previous = f.state().progress;
    f.run.id = "run-2";
    f.run.leaseOwner = "worker-2";
    f.run.leaseFence = 2;
    const next = {
      ...f.ctx,
      runId: "run-2",
      workerId: "worker-2",
      fence: 2,
      attempt: { id: "attempt-2" },
      context: { ...f.ctx.context, runId: "run-2" },
    };
    const recovered = await loadRunTicketWorkState(next);
    expect(recovered?.state?.sourceRunId).toBe("run");
    expect(recovered?.state?.progress).toEqual(previous);
    expect(f.ticketUpdate).toHaveBeenCalledTimes(2);
  });

  it("counts only persisted current acceptance, never draft evidence, waits or narration", async () => {
    const f = fixture();
    await ensureRunTicketWorkState(f.ctx);
    f.ticket.workState = {
      ...f.state(),
      wait: { kind: "input", reference: "model-invented-wait" },
    };
    const noReceipt = await runTicketProgressCheck(f.ctx);
    expect(noReceipt?.decision.action).toBe("continue");
    expect(f.state().progress).toMatchObject({
      seenEvidence: [],
      lastProgressAt: null,
      wait: null,
    });
    f.ticket.receiptVersion = 1;
    f.advance();
    expect(
      (await runTicketProgressCheck(f.ctx, { boundaryId: "accepted-receipt" }))?.decision,
    ).toEqual({
      action: "continue",
      reason: "new_evidence",
    });
    expect(f.state().progress!.seenEvidence.length).toBeGreaterThan(0);
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.ticket.status).toBe("doing");
  });

  it("tracks an ordinary ticket's verified artifact references without inventing acceptance", async () => {
    const f = fixture();
    f.ticket.fileDeliveryRequirements = null;
    await ensureRunTicketWorkState(f.ctx);
    f.storedArtifacts.push(
      { id: "report", runId: f.run.id, version: 1, hash: "a".repeat(64) },
      { id: "incidental", runId: f.run.id, version: 1, hash: "b".repeat(64) },
    );
    f.storedEffects.push(
      {
        id: "ambiguous",
        kind: "shell",
        status: "executing",
        result: null,
        updatedAt: new Date(),
      },
      {
        id: "completed",
        kind: "shell",
        status: "completed",
        result: { code: 0 },
        updatedAt: new Date(),
      },
    );
    const saved = await saveRunTicketWorkState(f.ctx, {
      expectedVersion: f.ticket.workStateVersion,
      expectedRequirementsVersion: null,
      state: {
        goal: f.ticket.title,
        constraints: [],
        evidenceRefs: [
          reportRef,
          { kind: "effect", effectId: "ambiguous" },
          { kind: "effect", effectId: "completed" },
        ],
        nextStep: "Inspect the report",
        blocker: null,
        wait: { kind: "external", reference: "draft-wait" },
        position: { summary: "Report stored", evidenceRef: reportRef },
      },
    });
    expect(saved).not.toHaveProperty("error");
    const expectedEvidence = createHash("sha256")
      .update(JSON.stringify(["artifact", "report", 1, "a".repeat(64)]))
      .digest("hex");
    expect((await runTicketProgressCheck(f.ctx))?.decision).toEqual({
      action: "continue",
      reason: "new_evidence",
    });
    expect(f.state().progress).toMatchObject({
      requirementsVersion: null,
      seenEvidence: [expectedEvidence],
      lastProgressAt: 1_000_000,
      wait: null,
      judge: { attempts: 0 },
    });
    expect(f.prisma.artifact.findFirst).not.toHaveBeenCalled();
    const before = f.state().progress;
    f.advance();
    await runTicketProgressCheck(f.ctx, { boundaryId: "same-artifact" });
    expect(f.state().progress?.seenEvidence).toEqual(before?.seenEvidence);
    expect(f.state().progress?.lastProgressAt).toEqual(before?.lastProgressAt);
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.ticket.status).toBe("doing");
  });

  it.each(["missing", "hash", "version", "foreign-run", "environment", "configuration"])(
    "does not count an ordinary ticket's %s artifact reference as progress",
    async (scenario) => {
      const f = fixture();
      f.ticket.fileDeliveryRequirements = null;
      await ensureRunTicketWorkState(f.ctx);
      f.ticket.workState = { ...f.state(), evidenceRefs: [reportRef] };
      if (scenario !== "missing") {
        f.storedArtifacts.push({
          id: "report",
          runId: scenario === "foreign-run" ? "unrelated-run" : f.run.id,
          version: scenario === "version" ? 2 : 1,
          hash: (scenario === "hash" ? "b" : "a").repeat(64),
        });
      }
      if (scenario === "environment")
        f.ctx.bot.computer = { ...f.ctx.bot.computer!, homeRevision: "snapshot-2" };
      if (scenario === "configuration") f.flags.configuration = null;
      expect((await runTicketProgressCheck(f.ctx))?.decision).toEqual({
        action: "continue",
        reason: "no_new_evidence",
      });
      expect(f.state().progress).toMatchObject({
        requirementsVersion: null,
        seenEvidence: [],
        lastProgressAt: null,
      });
    },
  );

  it("keeps nullable progress through worker restart and rejects references from old requirements", async () => {
    const f = fixture();
    f.ticket.fileDeliveryRequirements = null;
    await ensureRunTicketWorkState(f.ctx);
    await runTicketProgressCheck(f.ctx, { boundaryId: "first-worker" });
    const checkpoint = f.state().progress;
    f.ctx.workerId = "worker-2";
    f.ctx.fence = 2;
    f.run.leaseOwner = "worker-2";
    f.run.leaseFence = 2;
    f.ctx.attempt.id = "attempt-2";
    f.advance();
    await runTicketProgressCheck(f.ctx, { boundaryId: "replacement-worker" });
    expect(f.state().progress?.judge).toEqual(checkpoint?.judge);
    expect(f.state().progress?.requirementsVersion).toBeNull();
    f.ticket.workState = { ...f.state(), evidenceRefs: [reportRef] };
    f.storedArtifacts.push({ id: "report", runId: f.run.id, version: 1, hash: "a".repeat(64) });
    f.ticket.fileDeliveryRequirements = {
      version: 1,
      items: [{ id: "file", kind: "artifact", description: "New report requirements" }],
    };
    f.advance();
    expect(
      (await runTicketProgressCheck(f.ctx, { boundaryId: "requirements-added" }))?.decision,
    ).toEqual({ action: "continue", reason: "requirements_changed" });
    expect(f.state().progress).toMatchObject({
      requirementsVersion: 1,
      seenEvidence: [],
      judge: checkpoint?.judge,
    });
    expect(f.ticket.status).toBe("doing");
  });

  it.each(["waiting_input", "waiting_takeover"])(
    "reports committed %s state without another CAS or changing the pending identity",
    async (status) => {
      const f = fixture();
      f.ticket.fileDeliveryRequirements = null;
      await ensureRunTicketWorkState(f.ctx);
      await saveRunTicketPendingCall(f.ctx, {
        toolCallId: "original-call",
        toolName: "request_secret",
        effectId: null,
      });
      const state = f.state();
      const runSnapshot = { ...f.ctx.run };
      f.run.status = status;
      f.run.leaseOwner = null;
      f.ticketUpdate.mockClear();
      f.prisma.run.updateMany.mockClear();
      const judge = progressJudge(f);
      expect(
        await runTicketProgressCheck({ ...f.ctx, run: runSnapshot }, { judge: judge.judge }),
      ).toEqual({
        decision: { action: "wait", reason: "waiting_for_human", ref: f.run.id },
        revision: null,
      });
      expect(f.ticketUpdate).not.toHaveBeenCalled();
      expect(f.prisma.run.updateMany).not.toHaveBeenCalled();
      expect(f.runtime.run).not.toHaveBeenCalled();
      expect(judge.requests).toHaveLength(0);
      expect(f.state()).toEqual(state);
      expect(f.run.checkpoint).toBe("original-call");
    },
  );

  it("does not infer a wait from an old pending call or a stale in-memory pause", async () => {
    const f = fixture();
    f.ticket.fileDeliveryRequirements = null;
    f.ticket.receiptVersion = 1;
    await ensureRunTicketWorkState(f.ctx);
    await saveRunTicketPendingCall(f.ctx, {
      toolCallId: "original-call",
      toolName: "request_secret",
      effectId: null,
    });
    f.ticket.workState = {
      ...f.state(),
      wait: { kind: "approval", reference: "draft-wait" },
      nextStep: "Finish after approval",
    };
    const result = await runTicketProgressCheck({
      ...f.ctx,
      run: { ...f.ctx.run, status: "waiting_input" },
    });
    expect(result?.decision).toEqual({ action: "continue", reason: "no_new_evidence" });
    expect(f.state().progress).toMatchObject({
      requirementsVersion: null,
      wait: null,
      seenEvidence: [],
      lastProgressAt: null,
    });
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.state().pendingCall?.toolCallId).toBe("original-call");
  });

  it.each(["hash", "version", "unknown", "unreadable"])(
    "does not count %s receipt evidence as progress",
    async (scenario) => {
      const f = fixture();
      await ensureRunTicketWorkState(f.ctx);
      f.ticket.receiptVersion = 1;
      if (scenario === "hash") f.flags.wrongHash = true;
      if (scenario === "version") f.receipt.acceptance.requirementsVersion = 2;
      if (scenario === "unknown") f.receipt.acceptance.results[0]!.status = "unknown";
      if (scenario === "unreadable") f.flags.receiptUnavailable = true;
      await runTicketProgressCheck(f.ctx);
      expect(f.state().progress).toMatchObject({ seenEvidence: [], lastProgressAt: null });
    },
  );

  it("discards progress advice if a competing state update wins its CAS", async () => {
    const f = fixture();
    await ensureRunTicketWorkState(f.ctx);
    f.flags.staleCas = true;
    expect(await runTicketProgressCheck(f.ctx)).toEqual({
      decision: { action: "continue", reason: "stale_state" },
      revision: null,
    });
    expect(f.state().progress).toBeNull();
  });

  it("propagates lease loss for a running ticket instead of committing progress", async () => {
    const f = fixture();
    f.ticket.fileDeliveryRequirements = null;
    await ensureRunTicketWorkState(f.ctx);
    f.run.leaseOwner = "replacement-worker";
    await expect(runTicketProgressCheck(f.ctx)).rejects.toThrow("lease expired");
    expect(f.state().progress).toBeNull();
  });

  it.each([null, 1])(
    "does not judge repeated failures by default with requirements version %s",
    async (requirementsVersion) => {
      const f = fixture();
      if (requirementsVersion === null) f.ticket.fileDeliveryRequirements = null;
      await ensureRunTicketWorkState(f.ctx);
      repeatedFailure(f.ctx);
      await runTicketProgressCheck(f.ctx, { boundaryId: "boundary-1" });
      f.advance();
      const second = await runTicketProgressCheck(f.ctx, { boundaryId: "boundary-2" });
      expect(second?.decision).toEqual({ action: "continue", reason: "judge_unavailable" });
      expect(f.state().progress?.judge.attempts).toBe(0);
      expect(f.state().progress?.requirementsVersion).toBe(requirementsVersion);
      expect(f.runtime.run).not.toHaveBeenCalled();
    },
  );

  it("passes an optional calibrated judge through the fenced progress boundary", async () => {
    const f = fixture();
    f.ticket.fileDeliveryRequirements = null;
    await ensureRunTicketWorkState(f.ctx);
    repeatedFailure(f.ctx);
    const judge = progressJudge(f);
    await runTicketProgressCheck(f.ctx, { boundaryId: "boundary-1", judge: judge.judge });
    expect(judge.requests).toHaveLength(0);
    f.advance();
    const result = await runTicketProgressCheck(f.ctx, {
      boundaryId: "boundary-2",
      judge: judge.judge,
    });
    expect(result).toEqual({
      decision: { action: "replan", reason: "judge_confirmed_stall" },
      revision: f.ticket.workStateVersion,
    });
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0]).toMatchObject({
      tools: [],
      model: {
        provider: judge.model.provider,
        id: judge.model.id,
        thinkingLevel: "high",
      },
      usageOperationKind: "learning",
    });
    expect(judge.recordUsage).toHaveBeenCalledWith(
      "ticket:ticket-progress:1",
      expect.objectContaining({ totalTokens: 112, costUsd: 0.001, operationKind: "learning" }),
    );
    expect(f.state().progress).toMatchObject({
      requirementsVersion: null,
      lastBoundaryId: "boundary-2",
      replanIssued: true,
      judge: {
        attempts: 1,
        tokensSubtotal: 112,
        costUsdSubtotal: 0.001,
        unknownTokenAttempts: 0,
        unknownCostAttempts: 0,
      },
    });
    expect(
      await runTicketProgressCheck(f.ctx, { boundaryId: "boundary-2", judge: judge.judge }),
    ).toEqual(result);
    expect(judge.requests).toHaveLength(1);
    expect(f.ticket.status).toBe("doing");
    expect(f.run.status).toBe("running");
  });

  it.each(["claim", "settlement", "requirements", "lease"])(
    "does not grant a replan after a %s conflict",
    async (conflict) => {
      const f = fixture();
      f.ticket.fileDeliveryRequirements = null;
      await ensureRunTicketWorkState(f.ctx);
      repeatedFailure(f.ctx);
      await runTicketProgressCheck(f.ctx, { boundaryId: "boundary-1" });
      const judge = progressJudge(f, () => {
        if (conflict === "settlement") f.flags.staleCas = true;
        if (conflict === "lease") f.run.leaseOwner = "replacement-worker";
        if (conflict === "requirements")
          f.ticket.fileDeliveryRequirements = {
            version: 1,
            items: [{ id: "new", kind: "artifact", description: "Changed requirements" }],
          };
      });
      if (conflict === "claim") f.flags.staleCas = true;
      f.advance();
      const result = runTicketProgressCheck(f.ctx, {
        boundaryId: "boundary-2",
        judge: judge.judge,
      });
      if (conflict === "lease") await expect(result).rejects.toThrow("lease expired");
      else
        expect(await result).toEqual({
          decision: { action: "continue", reason: "stale_state" },
          revision: null,
        });
      expect(judge.requests).toHaveLength(conflict === "claim" ? 0 : 1);
      expect(f.state().progress).toMatchObject({
        replanIssued: false,
        judge: {
          attempts: conflict === "claim" ? 0 : 1,
          unknownTokenAttempts: conflict === "claim" ? 0 : 1,
          unknownCostAttempts: conflict === "claim" ? 0 : 1,
        },
      });
      expect(f.ticket.status).toBe("doing");
    },
  );

  it("keeps unsupported work state unknown instead of erasing it during initialization", async () => {
    const f = fixture();
    f.ticket.workState = { schemaVersion: 9, progress: { judge: { attempts: 2 } } };
    expect((await ensureRunTicketWorkState(f.ctx))?.status).toBe("unknown");
    expect(await runTicketProgressCheck(f.ctx)).toBeUndefined();
    expect(f.ticketUpdate).not.toHaveBeenCalled();
  });
});

describe("ticket environment references", () => {
  it("uses only host revisions and marks an unrestored computer unknown", () => {
    vi.stubEnv("GIT_SHA", "revision");
    expect(ticketEnvironment(computer, descriptor)).toEqual({
      computerId: computer.id,
      snapshotRef: "snapshot-1",
      runtimeRevision: "runtime:1:2",
      toolRevision: "revision",
    });
    expect(
      ticketEnvironment({ ...computer, restorePending: true }, descriptor).snapshotRef,
    ).toBeNull();
    expect(
      ticketEnvironment({ ...computer, autoRecoveredAt: new Date(11) }, descriptor).snapshotRef,
    ).toBeNull();
    expect(
      ticketEnvironment({ ...computer, homeRevision: "empty" }, descriptor).snapshotRef,
    ).toBeNull();
    expect(ticketEnvironment(null).runtimeRevision).toBeNull();
    expect(ticketEnvironment(computer, descriptor)).not.toHaveProperty("screen");
  });
});
