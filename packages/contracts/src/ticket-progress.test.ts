import { describe, expect, it } from "vitest";
import {
  TICKET_PROGRESS_EVIDENCE_LIMIT,
  TicketProgressCheckpointSchema,
} from "./ticket-progress.js";

const checkpoint = {
  schemaVersion: 1,
  requirementsVersion: 2,
  lastBoundaryId: "boundary-1",
  lastCheckAt: 100,
  lastProgressAt: 90,
  seenEvidence: ["a".repeat(64)],
  evidenceSaturated: false,
  lastRepeatKey: null,
  repeatedChecks: 1,
  replanIssued: false,
  wait: null,
  lastDecision: { action: "continue", reason: "no_new_evidence" },
  judge: {
    attempts: 1,
    tokensSubtotal: 100,
    costUsdSubtotal: 0.001,
    unknownTokenAttempts: 0,
    unknownCostAttempts: 0,
  },
};

describe("TicketProgressCheckpointSchema", () => {
  it("accepts a bounded versioned checkpoint and distinct unknown usage counters", () => {
    expect(TicketProgressCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(
      TicketProgressCheckpointSchema.parse({
        ...checkpoint,
        judge: {
          ...checkpoint.judge,
          unknownTokenAttempts: 1,
          unknownCostAttempts: 1,
        },
      }).judge.unknownTokenAttempts,
    ).toBe(1);
  });

  it("rejects malformed evidence, inconsistent usage, missing wait state, and oversized history", () => {
    expect(
      TicketProgressCheckpointSchema.safeParse({
        ...checkpoint,
        seenEvidence: ["not-a-digest"],
      }).success,
    ).toBe(false);
    expect(
      TicketProgressCheckpointSchema.safeParse({
        ...checkpoint,
        judge: { ...checkpoint.judge, unknownCostAttempts: 2 },
      }).success,
    ).toBe(false);
    expect(
      TicketProgressCheckpointSchema.safeParse(
        Object.fromEntries(Object.entries(checkpoint).filter(([key]) => key !== "wait")),
      ).success,
    ).toBe(false);
    expect(
      TicketProgressCheckpointSchema.safeParse({
        ...checkpoint,
        seenEvidence: Array.from({ length: TICKET_PROGRESS_EVIDENCE_LIMIT + 1 }, () =>
          "b".repeat(64),
        ),
      }).success,
    ).toBe(false);
  });
});
