import { describe, expect, it } from "vitest";
import { TicketWorkStateDraftSchema, TicketWorkStateSchema } from "./ticket-work-state.js";

const draft = {
  goal: "Publish the checked report",
  constraints: ["Use the approved source"],
  evidenceRefs: [{ kind: "effect", effectId: "effect-1" }],
  nextStep: "Read the stored receipt",
  blocker: null,
  wait: null,
  position: null,
};

describe("ticket work state contract", () => {
  it("accepts bounded advisory state and reference-only evidence", () => {
    expect(TicketWorkStateDraftSchema.parse(draft)).toEqual(draft);
  });

  it.each([
    { status: "done" },
    { completedAt: "2026-01-01T00:00:00Z" },
    { progress: null },
    { requirementsVersion: 99 },
    { sourceRunId: "other-run" },
    { environment: null },
    { configurationRef: "fake-receipt" },
    { pendingCall: { toolCallId: "fake", toolName: "send", effectId: null } },
  ])("rejects model writes to host fields: %j", (field) => {
    expect(TicketWorkStateDraftSchema.safeParse({ ...draft, ...field }).success).toBe(false);
  });

  it("rejects embedded output, self-confirmed effects and unbounded state", () => {
    expect(
      TicketWorkStateDraftSchema.safeParse({
        ...draft,
        evidenceRefs: [{ kind: "effect", effectId: "effect-1", confirmed: true }],
      }).success,
    ).toBe(false);
    expect(
      TicketWorkStateDraftSchema.safeParse({
        ...draft,
        evidenceRefs: [{ kind: "artifact", artifactId: "file", content: "screen bytes" }],
      }).success,
    ).toBe(false);
    expect(TicketWorkStateDraftSchema.safeParse({ ...draft, goal: "x".repeat(1601) }).success).toBe(
      false,
    );
  });

  it("treats a missing progress checkpoint as null, but rejects future/corrupt budgets", () => {
    const state = {
      ...draft,
      schemaVersion: 1,
      requirementsVersion: null,
      sourceRunId: "run-1",
      updatedAt: "2026-01-01T00:00:00Z",
      environment: null,
      configurationRef: null,
      pendingCall: null,
    };
    expect(TicketWorkStateSchema.parse(state).progress).toBeNull();
    expect(TicketWorkStateSchema.safeParse({ ...state, schemaVersion: 2 }).success).toBe(false);
    expect(
      TicketWorkStateSchema.safeParse({ ...state, progress: { schemaVersion: 99 } }).success,
    ).toBe(false);
    expect(
      TicketWorkStateSchema.safeParse({
        ...state,
        environment: { computerId: "computer", screenshot: "old screen" },
      }).success,
    ).toBe(false);
  });
});
