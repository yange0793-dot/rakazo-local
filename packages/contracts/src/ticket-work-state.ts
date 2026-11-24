import * as z from "zod";
import { IsoDate } from "./ids.js";
import { TicketProgressCheckpointSchema } from "./ticket-progress.js";

export const TICKET_WORK_STATE_MAX_BYTES = 24 * 1024;
const Reference = z.string().trim().min(1).max(200);
const Revision = z.number().int().nonnegative().max(2_147_483_646);
export const TicketWorkRequirementsVersionSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
  .nullable();

/** References existing snapshots and contracts; never a cached screen or transcript. */
export const TicketWorkEnvironmentSchema = z.strictObject({
  computerId: Reference.nullable(),
  snapshotRef: Reference.nullable(),
  runtimeRevision: Reference.nullable(),
  toolRevision: Reference.nullable(),
});
export type TicketWorkEnvironment = z.infer<typeof TicketWorkEnvironmentSchema>;

export const TicketWorkEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("effect"),
    effectId: Reference,
    requirementId: Reference.optional(),
  }),
  z.strictObject({
    kind: z.literal("artifact"),
    artifactId: Reference,
    version: z.number().int().positive().max(2_147_483_647),
    hash: z.string().regex(/^[a-f0-9]{64}$/i),
    requirementId: Reference.optional(),
  }),
]);
export type TicketWorkEvidenceRef = z.infer<typeof TicketWorkEvidenceRefSchema>;

/** Advisory fields only. Host evidence and acceptance remain the completion authority. */
export const TicketWorkStateDraftSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1600),
  constraints: z.array(z.string().trim().min(1).max(400)).max(20),
  evidenceRefs: z.array(TicketWorkEvidenceRefSchema).max(40),
  nextStep: z.string().trim().min(1).max(800).nullable(),
  blocker: z.string().trim().min(1).max(800).nullable(),
  wait: z
    .strictObject({
      kind: z.enum(["input", "approval", "external"]),
      reference: Reference,
    })
    .nullable(),
  position: z
    .strictObject({
      summary: z.string().trim().min(1).max(800),
      evidenceRef: TicketWorkEvidenceRefSchema,
    })
    .nullable(),
});
export type TicketWorkStateDraft = z.infer<typeof TicketWorkStateDraftSchema>;

export const TicketWorkPendingCallSchema = z.strictObject({
  toolCallId: Reference,
  toolName: Reference,
  effectId: Reference.nullable(),
});
export type TicketWorkPendingCall = z.infer<typeof TicketWorkPendingCallSchema>;

export const TicketWorkStateSchema = TicketWorkStateDraftSchema.extend({
  schemaVersion: z.literal(1),
  requirementsVersion: TicketWorkRequirementsVersionSchema,
  sourceRunId: Reference,
  updatedAt: IsoDate,
  environment: TicketWorkEnvironmentSchema.nullable(),
  configurationRef: Reference.nullable(),
  pendingCall: TicketWorkPendingCallSchema.nullable(),
  /** Only host progress CAS may update this budget; ordinary saves preserve it. */
  progress: TicketProgressCheckpointSchema.nullable().default(null),
});
export type TicketWorkState = z.infer<typeof TicketWorkStateSchema>;

export const TicketWorkStateUpdateSchema = z.strictObject({
  expectedVersion: Revision,
  expectedRequirementsVersion: TicketWorkRequirementsVersionSchema,
  state: TicketWorkStateDraftSchema,
});
export type TicketWorkStateUpdate = z.infer<typeof TicketWorkStateUpdateSchema>;
