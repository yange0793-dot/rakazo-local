import { createHash } from "node:crypto";
import type {
  TicketFileDeliveryAcceptance,
  TicketProgressCheckpoint,
  TicketProgressDecision,
  TicketProgressWait,
} from "@rakazo/contracts";
import {
  TICKET_PROGRESS_EVIDENCE_LIMIT,
  TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS,
  TICKET_PROGRESS_JUDGE_MAX_COST_USD,
  TICKET_PROGRESS_JUDGE_MAX_TOKENS,
  TicketProgressCheckpointSchema,
} from "@rakazo/contracts";
import * as z from "zod";
import type { TicketProgressAssessment, TicketProgressJudge } from "./ticket-progress-judge.js";
import { TICKET_PROGRESS_JUDGE_TIMEOUT_MS } from "./ticket-progress-judge.js";

export type { TicketProgressJudge } from "./ticket-progress-judge.js";

export const TICKET_PROGRESS_INTERVAL_MS = 30_000;
export const TICKET_PROGRESS_REPLAN_NOTE =
  "Recent work repeated without new verified evidence. Revisit the next step against the existing " +
  "requirements and evidence. Keep the same scope and approvals; do not repeat uncertain effects " +
  "or treat this check as completion.";

export type TicketProgressObservation = {
  requirementsVersion: number | null;
  acceptance?: TicketFileDeliveryAcceptance | null;
  /** Verified, task-relevant durable artifacts, not incidental output files. */
  artifacts?: readonly { id: string; version: number; hash: string }[];
  /** Confirmed changes with a canonical outcome key that survives replay. */
  effects?: readonly { id: string; outcomeKey: string }[];
  wait?: TicketProgressWait;
  repeated?: {
    /** SHA-256 of the loop guard's canonical repeated-call/failure fingerprint. */
    patternKey: string;
    kind: "same_read" | "same_write" | "same_failure";
    tool?: string;
    outcome?: "succeeded" | "failed" | "unknown";
    detail?: string;
  };
};

export type TicketProgressBoundaryInput = {
  ticketId: string;
  snapshot: { revision: number; checkpoint: TicketProgressCheckpoint | null };
  boundaryId: string;
  now: number;
  deadlineAt?: number;
  observation: TicketProgressObservation;
  /** Fence the active run and merge only progress using the Ticket work-state revision. */
  commit: (
    expectedRevision: number,
    checkpoint: TicketProgressCheckpoint,
  ) => Promise<number | null>;
  judge?: TicketProgressJudge;
};

export type TicketProgressBoundaryResult = {
  decision: TicketProgressDecision;
  /** null means no checkpoint was committed and this result grants no intervention. */
  revision: number | null;
};

function observeEvidence(
  observation: TicketProgressObservation,
  previous: TicketProgressCheckpoint | null,
) {
  const seen = new Set(previous?.seenEvidence);
  let saturated = previous?.evidenceSaturated ?? false;
  const record = (...parts: (string | number)[]) => {
    if (saturated) return;
    const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    if (seen.has(key)) return;
    if (seen.size === TICKET_PROGRESS_EVIDENCE_LIMIT) saturated = true;
    else seen.add(key);
  };
  const { acceptance, requirementsVersion } = observation;
  if (requirementsVersion !== null && acceptance?.requirementsVersion === requirementsVersion) {
    for (const result of acceptance.results) {
      if (result.status !== "verified") continue;
      for (const ref of result.evidenceRefs) {
        if (ref.requirementId !== result.requirementId) continue;
        record("requirement", requirementsVersion, result.requirementId);
        if (ref.kind === "artifact") {
          record(
            "accepted_artifact",
            requirementsVersion,
            result.requirementId,
            ref.artifactId,
            ref.version,
            ref.hash.toLowerCase(),
          );
        } else {
          record("accepted_effect", requirementsVersion, result.requirementId, ref.effectId);
        }
      }
    }
  }
  for (const { id, version, hash } of observation.artifacts ?? [])
    record("artifact", id, version, hash.toLowerCase());
  for (const { id, outcomeKey } of observation.effects ?? []) record("effect", id, outcomeKey);
  return {
    changed: seen.size > (previous?.seenEvidence.length ?? 0),
    seenEvidence: [...seen],
    evidenceSaturated: saturated,
  };
}

/** Call only from a serial executor boundary, not from a judge or per-tool callback. */
export async function runTicketProgressBoundary(
  input: TicketProgressBoundaryInput,
): Promise<TicketProgressBoundaryResult> {
  const { snapshot, boundaryId, observation, now, deadlineAt, commit, judge } = input;
  const startedAt = performance.now();
  const previous = snapshot.checkpoint;
  const stale = {
    decision: { action: "continue", reason: "stale_state" },
    revision: null,
  } as const;
  const parsedPrevious = previous ? TicketProgressCheckpointSchema.safeParse(previous) : null;
  if (
    (previous && !parsedPrevious?.success) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    (observation.requirementsVersion !== null &&
      (!Number.isSafeInteger(observation.requirementsVersion) ||
        observation.requirementsVersion < 1)) ||
    (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) ||
    (previous &&
      ((observation.requirementsVersion !== null &&
        previous.requirementsVersion !== null &&
        observation.requirementsVersion < previous.requirementsVersion) ||
        now < previous.lastCheckAt))
  )
    return stale;
  const validBoundaryId = z.string().min(1).max(240).safeParse(boundaryId);
  if (!validBoundaryId.success) return stale;
  const versionChanged = Boolean(
    previous && previous.requirementsVersion !== observation.requirementsVersion,
  );
  const waiting: TicketProgressDecision | undefined = observation.wait
    ? {
        action: "wait",
        reason: observation.wait.kind === "human" ? "waiting_for_human" : "waiting_for_external",
        ref: observation.wait.ref,
      }
    : undefined;
  const sameWait =
    JSON.stringify(previous?.wait ?? null) === JSON.stringify(observation.wait ?? null);
  const expired = deadlineAt !== undefined && now >= deadlineAt;
  if (previous && !versionChanged && sameWait) {
    if (previous.lastBoundaryId === boundaryId) {
      return {
        decision: previous.lastDecision,
        revision: snapshot.revision,
      };
    }
    if (!expired && now - previous.lastCheckAt < TICKET_PROGRESS_INTERVAL_MS) {
      return {
        decision: waiting ?? { action: "continue", reason: "rate_limited" },
        revision: null,
      };
    }
  }

  const {
    changed: evidenceChanged,
    seenEvidence,
    evidenceSaturated,
  } = observeEvidence(observation, previous);
  const changed = evidenceChanged || versionChanged;
  const validPatternKey = observation.repeated
    ? z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .safeParse(observation.repeated.patternKey)
    : undefined;
  if (observation.repeated && !validPatternKey?.success) return stale;
  const candidate =
    !waiting &&
    !expired &&
    !changed &&
    !versionChanged &&
    !evidenceSaturated &&
    Boolean(observation.repeated);
  const repeatedChecks = candidate
    ? previous?.lastRepeatKey === observation.repeated!.patternKey
      ? Math.min((previous?.repeatedChecks ?? 0) + 1, 2)
      : 1
    : 0;
  let decision: TicketProgressDecision;
  let judgeCandidate = false;
  if (expired) decision = { action: "stop", reason: "deadline_reached" };
  else if (waiting) decision = waiting;
  else if (versionChanged) decision = { action: "continue", reason: "requirements_changed" };
  else if (changed) decision = { action: "continue", reason: "new_evidence" };
  else if (evidenceSaturated) decision = { action: "continue", reason: "evidence_limit" };
  else if (!candidate || repeatedChecks < 2)
    decision = { action: "continue", reason: "no_new_evidence" };
  else if (previous?.replanIssued)
    decision = { action: "continue", reason: "replan_budget_exhausted" };
  else if (typeof judge?.evaluate !== "function")
    decision = { action: "continue", reason: "judge_unavailable" };
  else if (previous?.judge.unknownTokenAttempts || previous?.judge.unknownCostAttempts)
    decision = { action: "continue", reason: "judge_usage_unknown" };
  else if (
    previous &&
    (previous.judge.attempts >= TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS ||
      previous.judge.tokensSubtotal >= TICKET_PROGRESS_JUDGE_MAX_TOKENS ||
      previous.judge.costUsdSubtotal >= TICKET_PROGRESS_JUDGE_MAX_COST_USD)
  )
    decision = { action: "continue", reason: "judge_budget_exhausted" };
  else {
    decision = { action: "continue", reason: "judge_unknown" };
    judgeCandidate = true;
  }

  const checkpoint: TicketProgressCheckpoint = {
    schemaVersion: 1,
    requirementsVersion: observation.requirementsVersion,
    lastBoundaryId: boundaryId,
    lastCheckAt: now,
    lastProgressAt: changed ? now : (previous?.lastProgressAt ?? null),
    seenEvidence,
    evidenceSaturated,
    lastRepeatKey: candidate ? observation.repeated!.patternKey : null,
    repeatedChecks,
    replanIssued: previous?.replanIssued ?? false,
    wait: observation.wait ?? null,
    lastDecision: decision,
    judge: previous?.judge ?? {
      attempts: 0,
      tokensSubtotal: 0,
      costUsdSubtotal: 0,
      unknownTokenAttempts: 0,
      unknownCostAttempts: 0,
    },
  };
  if (judgeCandidate) {
    const usage = checkpoint.judge;
    // Reserve unknown usage BEFORE I/O; a takeover cannot reuse a lost attempt's budget.
    checkpoint.judge = {
      ...usage,
      attempts: usage.attempts + 1,
      unknownTokenAttempts: usage.unknownTokenAttempts + 1,
      unknownCostAttempts: usage.unknownCostAttempts + 1,
    };
  }
  const revision = await commit(snapshot.revision, checkpoint);
  if (revision === null) return stale;
  if (!judge || !judgeCandidate) return { decision, revision };

  const remainingTokens = TICKET_PROGRESS_JUDGE_MAX_TOKENS - checkpoint.judge.tokensSubtotal;
  const remainingCostUsd = TICKET_PROGRESS_JUDGE_MAX_COST_USD - checkpoint.judge.costUsdSubtotal;
  if (remainingTokens <= 0 || remainingCostUsd <= 0)
    return { decision: { action: "continue", reason: "judge_budget_exhausted" }, revision };
  const timeout = Math.floor(
    Math.min(
      TICKET_PROGRESS_JUDGE_TIMEOUT_MS,
      deadlineAt === undefined
        ? TICKET_PROGRESS_JUDGE_TIMEOUT_MS
        : deadlineAt - now - (performance.now() - startedAt),
    ),
  );
  if (timeout <= 0) return { decision, revision };
  let assessment: TicketProgressAssessment;
  try {
    assessment = await judge.evaluate({
      operationId: `${input.ticketId}:ticket-progress:${checkpoint.judge.attempts}`,
      observation,
      repeatedChecks: checkpoint.repeatedChecks,
      timeMs: timeout,
      remainingTokens,
      remainingCostUsd,
    });
  } catch {
    // The reserved attempt remains unknown if evaluation cannot settle.
    return { decision, revision };
  }
  if (assessment.calibration.status === "verified" && assessment.verdict === "stalled")
    decision = { action: "replan", reason: "judge_confirmed_stall" };
  else if (assessment.calibration.status === "verified" && assessment.verdict === "can_continue")
    decision = { action: "continue", reason: "judge_can_continue" };
  checkpoint.lastDecision = decision;
  const settled: TicketProgressCheckpoint = {
    ...checkpoint,
    replanIssued: decision.action === "replan",
    judge: {
      attempts: checkpoint.judge.attempts,
      tokensSubtotal: checkpoint.judge.tokensSubtotal + (assessment.tokens ?? 0),
      costUsdSubtotal: checkpoint.judge.costUsdSubtotal + (assessment.cost ?? 0),
      unknownTokenAttempts: Number(!assessment.accounted || assessment.tokens === undefined),
      unknownCostAttempts: Number(!assessment.accounted || assessment.cost === undefined),
    },
  };
  const settledRevision = await commit(revision, settled);
  return settledRevision === null ? stale : { decision, revision: settledRevision };
}
