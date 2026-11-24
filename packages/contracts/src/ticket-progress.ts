import * as z from "zod";

export const TICKET_PROGRESS_EVIDENCE_LIMIT = 128;
export const TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS = 2;
export const TICKET_PROGRESS_JUDGE_MAX_TOKENS = 4_096;
export const TICKET_PROGRESS_JUDGE_MAX_COST_USD = 0.05;

const Counter = z.number().int().nonnegative();
const Ref = z.string().min(1).max(240);

export const TicketProgressWaitSchema = z.strictObject({
  kind: z.enum(["human", "external"]),
  ref: Ref,
});
export type TicketProgressWait = z.infer<typeof TicketProgressWaitSchema>;

export const TicketProgressDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("continue"),
    reason: z.enum([
      "stale_state",
      "rate_limited",
      "requirements_changed",
      "new_evidence",
      "no_new_evidence",
      "evidence_limit",
      "replan_budget_exhausted",
      "judge_budget_exhausted",
      "judge_unavailable",
      "judge_usage_unknown",
      "judge_unknown",
      "judge_can_continue",
    ]),
  }),
  z.strictObject({ action: z.literal("replan"), reason: z.literal("judge_confirmed_stall") }),
  z.strictObject({
    action: z.literal("wait"),
    reason: z.enum(["waiting_for_human", "waiting_for_external"]),
    ref: Ref,
  }),
  z.strictObject({ action: z.literal("stop"), reason: z.literal("deadline_reached") }),
]);
export type TicketProgressDecision = z.infer<typeof TicketProgressDecisionSchema>;

/** Host-owned bookkeeping inside Ticket.workState, not a replacement for evidence or acceptance. */
export const TicketProgressCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    requirementsVersion: z.number().int().positive().nullable(),
    lastBoundaryId: Ref,
    lastCheckAt: Counter,
    lastProgressAt: Counter.nullable(),
    seenEvidence: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(TICKET_PROGRESS_EVIDENCE_LIMIT),
    evidenceSaturated: z.boolean(),
    lastRepeatKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    repeatedChecks: z.number().int().min(0).max(2),
    replanIssued: z.boolean(),
    wait: TicketProgressWaitSchema.nullable(),
    lastDecision: TicketProgressDecisionSchema,
    judge: z.strictObject({
      attempts: z.number().int().min(0).max(TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS),
      tokensSubtotal: z.number().int().nonnegative().safe(),
      costUsdSubtotal: z.number().nonnegative().finite(),
      unknownTokenAttempts: z.number().int().min(0).max(TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS),
      unknownCostAttempts: z.number().int().min(0).max(TICKET_PROGRESS_JUDGE_MAX_ATTEMPTS),
    }),
  })
  .refine(
    ({ lastCheckAt, lastProgressAt, judge }) =>
      (lastProgressAt === null || lastProgressAt <= lastCheckAt) &&
      judge.unknownTokenAttempts <= judge.attempts &&
      judge.unknownCostAttempts <= judge.attempts,
    "Inconsistent progress checkpoint",
  );
export type TicketProgressCheckpoint = z.infer<typeof TicketProgressCheckpointSchema>;
