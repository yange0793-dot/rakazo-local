import type {
  AdapterContext,
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
} from "@rakazo/adapter-kit";
import type { TicketFileDeliveryAcceptance, TicketProgressCheckpoint } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { TICKET_PROGRESS_CALIBRATION_CASES } from "./fixtures/ticket-progress-calibration.js";
import type { TicketProgressBoundaryInput, TicketProgressJudge } from "./ticket-progress.js";
import { runTicketProgressBoundary, TICKET_PROGRESS_INTERVAL_MS } from "./ticket-progress.js";
import type { TicketProgressJudgeOptions } from "./ticket-progress-judge.js";
import {
  createTicketProgressJudge,
  TICKET_PROGRESS_RUBRIC_VERSION,
} from "./ticket-progress-judge.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const repeatedRead = {
  patternKey: "c".repeat(64),
  kind: "same_read",
  tool: "read_file",
  outcome: "succeeded",
} as const;
const repeatedFailure = {
  patternKey: "d".repeat(64),
  kind: "same_failure",
  tool: "shell",
  outcome: "failed",
} as const;
const NOW = 1_800_000_000_000;

const acceptance = (hash: string, version = 1): TicketFileDeliveryAcceptance => ({
  schemaVersion: 1,
  evaluatorRevision: "file-delivery.v1",
  requirementsVersion: 1,
  status: "verified",
  results: [
    {
      requirementId: "deliverable",
      status: "verified",
      reason: "verified_observation",
      evidenceRefs: [
        {
          kind: "artifact",
          requirementId: "deliverable",
          artifactId: "artifact-1",
          version,
          hash,
          observedAt: new Date(NOW).toISOString(),
        },
      ],
    },
  ],
});

const input = (
  snapshot: { revision: number; checkpoint: TicketProgressCheckpoint | null } = {
    revision: 1,
    checkpoint: null,
  },
  overrides: Partial<TicketProgressBoundaryInput> = {},
): TicketProgressBoundaryInput => ({
  ticketId: "ticket-1",
  snapshot,
  boundaryId: "boundary-1",
  now: NOW,
  observation: { requirementsVersion: 1 },
  commit: vi.fn(async (revision) => revision + 1),
  ...overrides,
});

function fakeJudge(
  verdict: "can_continue" | "stalled" | "unknown",
  usage: "complete" | "missing" | "incomplete" = "complete",
  observe?: (request: AgentRunRequest, context: Partial<AdapterContext>) => void,
) {
  const recordUsageCalls: Array<Parameters<TicketProgressJudgeOptions["recordUsage"]>> = [];
  const recordUsage: TicketProgressJudgeOptions["recordUsage"] = async (...args) => {
    recordUsageCalls.push(args);
  };
  const parentObserver = {
    beforeCall: vi.fn(async () => "fixture-reservation"),
    afterCall: vi.fn(async () => {}),
  };
  const model: AgentRunModel = {
    provider: "provider-fixture",
    id: "model-fixture",
    callObserver: parentObserver,
  };
  const runtime: Pick<AgentRuntime, "run" | "abort"> = {
    abort: async () => {},
    async *run(request, context) {
      observe?.(request, context ?? {});
      if (usage !== "missing") {
        const call = {
          provider: model.provider,
          modelId: model.id,
          inputTokensEstimate: 120,
          maxOutputTokens: 512,
          maxCostUsd: 0.002,
        };
        const reservation = await request.model.callObserver!.beforeCall(call);
        const measured = {
          provider: model.provider,
          model: model.id,
          inputTokens: 100,
          outputTokens: 12,
          cacheReadTokens: usage === "complete" ? 0 : null,
          cacheWriteTokens: usage === "complete" ? 0 : null,
          totalTokens: 112,
          costUsd: 0.001,
          operationKind: "learning" as const,
        };
        const event = { type: "usage" as const, ...measured };
        await request.onUsage?.(event);
        await request.model.callObserver!.afterCall(reservation, measured);
        yield { ...event, accounted: true };
      }
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
            { id: "current", verdict },
          ],
        }),
      };
    },
  };
  const judge = createTicketProgressJudge({
    runtime,
    model,
    context: {
      operationId: "run-1",
      traceId: "trace-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      signal: new AbortController().signal,
    },
    goal: "Produce the requested deliverable.",
    recordUsage,
  });
  return { ...judge, recordUsageCalls };
}

async function progressToRepeatCandidate(
  repeated: NonNullable<TicketProgressBoundaryInput["observation"]["repeated"]> = repeatedRead,
) {
  let revision = 0;
  let checkpoint: TicketProgressCheckpoint | null = null;
  const commit = vi.fn(async (expected: number, next: TicketProgressCheckpoint) => {
    if (expected !== revision) return null;
    checkpoint = next;
    return ++revision;
  });
  for (let index = 0; index < 2; index++) {
    await runTicketProgressBoundary({
      ...input(
        { revision, checkpoint },
        {
          boundaryId: `repeat-${index}`,
          now: NOW + index * TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, repeated },
          commit,
        },
      ),
    });
  }
  return { revision, checkpoint: checkpoint!, commit };
}

describe("runTicketProgressBoundary", () => {
  it("counts accepted evidence once, not repeated receipts or read calls", async () => {
    const commit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const first = await runTicketProgressBoundary(
      input(undefined, {
        observation: { requirementsVersion: 1, acceptance: acceptance(HASH_A) },
        commit,
      }),
    );
    expect(first.decision).toEqual({ action: "continue", reason: "new_evidence" });
    const accepted = commit.mock.calls[0]?.[1] as TicketProgressCheckpoint;
    expect(accepted.seenEvidence).toHaveLength(2);

    const repeated = await runTicketProgressBoundary(
      input(
        { revision: 5, checkpoint: accepted },
        {
          boundaryId: "next",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS,
          observation: {
            requirementsVersion: 1,
            acceptance: acceptance(HASH_A),
            repeated: repeatedRead,
          },
        },
      ),
    );
    expect(repeated.decision).toEqual({ action: "continue", reason: "no_new_evidence" });
    expect(accepted.seenEvidence).toHaveLength(2);
  });

  it("recognizes a genuinely new artifact revision as progress", async () => {
    const firstCommit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    await runTicketProgressBoundary(
      input(undefined, {
        observation: { requirementsVersion: 1, acceptance: acceptance(HASH_A) },
        commit: firstCommit,
      }),
    );
    const checkpoint = firstCommit.mock.calls[0]![1] as TicketProgressCheckpoint;
    const nextCommit = vi.fn(async (revision) => revision + 1);
    const result = await runTicketProgressBoundary(
      input(
        { revision: 2, checkpoint },
        {
          boundaryId: "new-version",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, acceptance: acceptance(HASH_B) },
          commit: nextCommit,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "new_evidence" });
  });

  it("counts an accepted artifact version change even when its content hash is unchanged", async () => {
    const firstCommit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    await runTicketProgressBoundary(
      input(undefined, {
        observation: { requirementsVersion: 1, acceptance: acceptance(HASH_A, 1) },
        commit: firstCommit,
      }),
    );
    const checkpoint = firstCommit.mock.calls[0]![1] as TicketProgressCheckpoint;
    const result = await runTicketProgressBoundary(
      input(
        { revision: 2, checkpoint },
        {
          boundaryId: "artifact-version-2",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, acceptance: acceptance(HASH_A, 2) },
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "new_evidence" });
  });

  it("treats an explicit requirements revision as progress without treating a plan as evidence", async () => {
    const base = await progressToRepeatCandidate();
    const commit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const result = await runTicketProgressBoundary(
      input(
        { revision: base.revision, checkpoint: base.checkpoint },
        {
          boundaryId: "requirements-v2",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 2 },
          commit,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "requirements_changed" });
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).lastProgressAt).toBe(
      NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
    );
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).repeatedChecks).toBe(0);
  });

  it("tracks host-observed artifacts when a ticket has no file-delivery requirement version", async () => {
    const commit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const result = await runTicketProgressBoundary(
      input(undefined, {
        observation: {
          requirementsVersion: null,
          acceptance: acceptance(HASH_A),
          artifacts: [{ id: "artifact-1", version: 1, hash: HASH_A }],
        },
        commit,
      }),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "new_evidence" });
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).requirementsVersion).toBeNull();
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).seenEvidence).toHaveLength(1);
  });

  it("resets the repeat streak when the canonical repeated input changes", async () => {
    let revision = 0;
    let checkpoint: TicketProgressCheckpoint | null = null;
    const commit = vi.fn(async (expected: number, next: TicketProgressCheckpoint) => {
      if (expected !== revision) return null;
      checkpoint = next;
      return ++revision;
    });
    await runTicketProgressBoundary(
      input(undefined, {
        boundaryId: "read",
        observation: { requirementsVersion: 1, repeated: repeatedRead },
        commit,
      }),
    );
    const second = await runTicketProgressBoundary(
      input(
        { revision, checkpoint },
        {
          boundaryId: "failure",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, repeated: repeatedFailure },
          commit,
          judge: fakeJudge("stalled"),
        },
      ),
    );
    expect(second.decision).toEqual({ action: "continue", reason: "no_new_evidence" });
    expect((commit.mock.calls[1]![1] as TicketProgressCheckpoint).repeatedChecks).toBe(1);
  });

  it("records human and external waits without accumulating stagnation", async () => {
    const commit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const result = await runTicketProgressBoundary(
      input(undefined, {
        observation: {
          requirementsVersion: 1,
          repeated: repeatedFailure,
          wait: { kind: "human", ref: "approval-1" },
        },
        commit,
      }),
    );
    expect(result.decision).toEqual({
      action: "wait",
      reason: "waiting_for_human",
      ref: "approval-1",
    });
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).repeatedChecks).toBe(0);
    expect((commit.mock.calls[0]![1] as TicketProgressCheckpoint).wait).toEqual({
      kind: "human",
      ref: "approval-1",
    });
  });

  it("uses a bounded structured judge and only replans on its measured stall verdict", async () => {
    const seed = await progressToRepeatCandidate();
    const judge = fakeJudge("stalled", "complete", (request) => {
      expect(request.tools).toEqual([]);
      expect(request.usageOperationKind).toBe("learning");
      expect(request.model.maxTokens).toBeLessThanOrEqual(512);
      expect(request.instructions).toContain(TICKET_PROGRESS_RUBRIC_VERSION);
    });
    const commit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const result = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "third-repeat",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: {
            requirementsVersion: 1,
            repeated: repeatedRead,
          },
          judge,
          commit,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "replan", reason: "judge_confirmed_stall" });
    expect(judge.recordUsageCalls).toHaveLength(1);
    const reserved = commit.mock.calls[0]![1] as TicketProgressCheckpoint;
    const settled = commit.mock.calls[1]![1] as TicketProgressCheckpoint;
    expect(reserved.judge.attempts).toBe(1);
    expect(reserved.judge.unknownCostAttempts).toBe(1);
    expect(settled.judge.tokensSubtotal).toBe(112);
    expect(settled.judge.costUsdSubtotal).toBe(0.001);
    expect(settled.judge.unknownTokenAttempts).toBe(0);
    expect(settled.judge.unknownCostAttempts).toBe(0);
  });

  it("keeps a missing-usage judge result unknown and never spends it as a pass", async () => {
    const seed = await progressToRepeatCandidate(repeatedFailure);
    const judge = fakeJudge("stalled", "missing");
    const result = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "third-repeat",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: {
            requirementsVersion: 1,
            repeated: repeatedFailure,
          },
          judge,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "judge_unknown" });
    expect(judge.recordUsageCalls).toHaveLength(0);
  });

  it("does not accept the previous raw runtime/model judge or a calibrated flag", async () => {
    const seed = await progressToRepeatCandidate(repeatedFailure);
    const runtime = { run: vi.fn() };
    const result = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "legacy-raw-judge",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, repeated: repeatedFailure },
          judge: { runtime, calibrated: true } as unknown as TicketProgressJudge,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "judge_unavailable" });
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("retains the reserved unknown attempt when evaluate throws", async () => {
    const seed = await progressToRepeatCandidate(repeatedFailure);
    const commit = vi.fn(async (revision: number, _next: TicketProgressCheckpoint) => revision + 1);
    const result = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "failed-judge",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: { requirementsVersion: 1, repeated: repeatedFailure },
          judge: {
            evaluate: async () => {
              throw new Error("Synthetic failure");
            },
          },
          commit,
        },
      ),
    );
    expect(result.decision).toEqual({ action: "continue", reason: "judge_unknown" });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![1].judge).toMatchObject({
      attempts: 1,
      unknownTokenAttempts: 1,
      unknownCostAttempts: 1,
    });
  });

  it("does not reclassify a result when the fenced settlement loses its CAS", async () => {
    const seed = await progressToRepeatCandidate(repeatedFailure);
    const judge = fakeJudge("stalled");
    const commit = vi
      .fn()
      .mockResolvedValueOnce(seed.revision + 1)
      .mockResolvedValueOnce(null);
    const result = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "third-repeat",
          now: NOW + 2 * TICKET_PROGRESS_INTERVAL_MS,
          observation: {
            requirementsVersion: 1,
            repeated: repeatedFailure,
          },
          judge,
          commit,
        },
      ),
    );
    expect(result).toEqual({
      decision: { action: "continue", reason: "stale_state" },
      revision: null,
    });
    expect(judge.recordUsageCalls).toHaveLength(1);
  });

  it("honors task deadlines, check frequency, duplicate boundaries, and task judge budgets", async () => {
    const stopCommit = vi.fn(
      async (revision: number, _checkpoint: TicketProgressCheckpoint) => revision + 1,
    );
    const expired = await runTicketProgressBoundary(
      input(undefined, {
        boundaryId: "deadline-boundary",
        deadlineAt: NOW,
        observation: { requirementsVersion: 1 },
        commit: stopCommit,
      }),
    );
    expect(expired.decision).toEqual({ action: "stop", reason: "deadline_reached" });
    const stoppedCheckpoint = stopCommit.mock.calls[0]![1] as TicketProgressCheckpoint;
    const replayedStop = await runTicketProgressBoundary(
      input(
        { revision: 2, checkpoint: stoppedCheckpoint },
        {
          boundaryId: "deadline-boundary",
          deadlineAt: NOW,
          commit: stopCommit,
        },
      ),
    );
    expect(replayedStop).toEqual({ decision: expired.decision, revision: 2 });
    expect(stopCommit).toHaveBeenCalledOnce();

    const seed = await progressToRepeatCandidate();
    const rateLimited = await runTicketProgressBoundary(
      input(
        { revision: seed.revision, checkpoint: seed.checkpoint },
        {
          boundaryId: "too-soon",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS + 1,
          observation: {
            requirementsVersion: 1,
            repeated: repeatedRead,
          },
        },
      ),
    );
    expect(rateLimited.decision).toEqual({ action: "continue", reason: "rate_limited" });

    const exhausted = await runTicketProgressBoundary(
      input(
        {
          revision: 4,
          checkpoint: {
            ...seed.checkpoint,
            lastBoundaryId: "older",
            lastCheckAt: NOW,
            repeatedChecks: 2,
            judge: {
              attempts: 2,
              tokensSubtotal: 200,
              costUsdSubtotal: 0.002,
              unknownTokenAttempts: 0,
              unknownCostAttempts: 0,
            },
          },
        },
        {
          boundaryId: "exhausted",
          now: NOW + TICKET_PROGRESS_INTERVAL_MS,
          observation: {
            requirementsVersion: 1,
            repeated: repeatedRead,
          },
          judge: fakeJudge("stalled"),
        },
      ),
    );
    expect(exhausted.decision).toEqual({
      action: "continue",
      reason: "judge_budget_exhausted",
    });
  });

  it("returns stale_state and grants no recommendation when the initial CAS loses", async () => {
    const judge = fakeJudge("stalled");
    const result = await runTicketProgressBoundary(
      input(undefined, {
        observation: {
          requirementsVersion: 1,
          repeated: repeatedFailure,
        },
        judge,
        commit: async () => null,
      }),
    );
    expect(result).toEqual({
      decision: { action: "continue", reason: "stale_state" },
      revision: null,
    });
    expect(judge.recordUsageCalls).toHaveLength(0);
  });
});
