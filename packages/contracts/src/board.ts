import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import { ManagedWorkContextSchema, ManagedWorkDependencySchema } from "./managed-work.js";

export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** `done` is finished-but-open for review; `closed` is terminal, so both stamp completion. */
export function isTicketCompletedStatus(status: TicketStatus): boolean {
  return status === "done" || status === "closed";
}

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_DESCRIPTION_MAX_LENGTH = 20_000;
const TICKET_PREFIX_MAX_LENGTH = 12;
// Ticket numbers are stored as PostgreSQL Int values.
const TICKET_NUMBER_MAX = 2_147_483_647;
export const TICKET_COMMENT_MAX_LENGTH = 10_000;

const TicketPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_PREFIX_MAX_LENGTH)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Prefix must start with a letter and contain only letters and digits",
  );

export function ticketRef(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export function parseTicketRef(
  value: string,
  expectedPrefix?: string,
): { prefix: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawPrefix, rawNumber] = match;
  if (!rawPrefix || !rawNumber) return null;
  const prefix = rawPrefix.toUpperCase();
  if (expectedPrefix !== undefined && prefix !== expectedPrefix.trim().toUpperCase()) return null;
  const number = Number(rawNumber);
  if (number > TICKET_NUMBER_MAX) return null;
  return { prefix, number };
}

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.ticketPrefix !== undefined, {
    message: "Provide a name or ticketPrefix",
  });
export type RenameBoardInput = z.infer<typeof RenameBoardInput>;

export const TicketCommentSchema = z.object({
  id: Id,
  ticketId: Id,
  body: z.string(),
  authorBotId: Id.nullable(),
  authorUserId: Id.nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

const TicketFileDeliveryRequirementBaseSchema = z.object({
  id: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
});

export const TicketFileDeliveryContentConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_nonempty") }),
  z.object({
    kind: z.literal("csv_columns"),
    columns: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
    minRows: z.number().int().min(0).max(1_000_000).optional(),
  }),
  z.object({
    kind: z.literal("json_fields"),
    fields: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
  }),
]);

export const TicketFileDeliveryRequirementSchema = z.discriminatedUnion("kind", [
  TicketFileDeliveryRequirementBaseSchema.extend({
    kind: z.literal("artifact"),
    name: z.string().trim().min(1).max(255).optional(),
    mimeType: z.string().trim().min(1).max(255).optional(),
    contentConstraints: z
      .array(TicketFileDeliveryContentConstraintSchema)
      .min(1)
      .max(20)
      .optional(),
  }),
  TicketFileDeliveryRequirementBaseSchema.extend({
    kind: z.literal("effect"),
    effectKind: z.string().trim().min(1).max(120),
  }),
  TicketFileDeliveryRequirementBaseSchema.extend({
    kind: z.literal("semantic"),
    rubricVersion: z.string().trim().min(1).max(120).optional(),
    criteria: z
      .array(z.enum(["coverage", "evidence_support"]))
      .min(1)
      .max(2)
      .refine((items) => new Set(items).size === items.length, {
        message: "Semantic criteria must be unique.",
      })
      .optional(),
  }),
]);

/** Revisions replace the complete requirement set; the host assigns its next version. */
export const TicketFileDeliveryRequirementsUpdateSchema = z
  .strictObject({
    items: z.array(TicketFileDeliveryRequirementSchema).min(1).max(20),
  })
  .superRefine(({ items }, context) => {
    if (!items.some((item) => item.kind === "artifact")) {
      context.addIssue({
        code: "custom",
        message: "File delivery requirements must include an artifact requirement.",
        path: ["items"],
      });
    }
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          message: "Requirement ids must be unique.",
          path: ["items", index, "id"],
        });
      }
      ids.add(item.id);
    }
  });

export const TicketFileDeliveryRequirementsSchema =
  TicketFileDeliveryRequirementsUpdateSchema.safeExtend({
    version: z.number().int().positive().max(2_147_483_647),
  });
export type TicketFileDeliveryRequirements = z.infer<typeof TicketFileDeliveryRequirementsSchema>;

export const TicketSchema = z.object({
  id: Id,
  boardId: Id,
  spaceId: Id,
  number: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: Id.nullable(),
  createdByBotId: Id.nullable(),
  createdByUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  fileDeliveryRequirements: TicketFileDeliveryRequirementsSchema.optional(),
  managedWork: ManagedWorkContextSchema.optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsInput = z.object({
  boardId: Id.optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsInput>;

export const ListTicketsOutput = z.object({ tickets: z.array(TicketSchema) });
export type ListTicketsOutput = z.infer<typeof ListTicketsOutput>;

export const GetTicketInput = z
  .object({
    id: Id.optional(),
    ref: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.id) !== Boolean(value.ref), {
    message: "Provide exactly one of id or ref",
  });
export type GetTicketInput = z.infer<typeof GetTicketInput>;

export const UpdateTicketInput = z
  .object({
    id: Id,
    title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
    description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).nullable().optional(),
    priority: TicketPrioritySchema.nullable().optional(),
    status: TicketStatusSchema.optional(),
    assigneeBotId: Id.optional(),
    expectedRequirementsVersion: z.number().int().positive().max(2_147_483_646).optional(),
    fileDeliveryRequirements: TicketFileDeliveryRequirementsUpdateSchema.optional(),
    dependencies: z.array(ManagedWorkDependencySchema).optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.expectedRequirementsVersion !== undefined) !==
      (value.fileDeliveryRequirements !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Provide fileDeliveryRequirements and expectedRequirementsVersion together.",
        path: ["expectedRequirementsVersion"],
      });
    }
    if (value.fileDeliveryRequirements && value.status && value.status !== "review") {
      context.addIssue({
        code: "custom",
        message: "Changing file-delivery requirements reopens the ticket for review.",
        path: ["status"],
      });
    }
  });
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

export const MoveTicketInput = z.object({
  id: Id,
  status: TicketStatusSchema,
});
export type MoveTicketInput = z.infer<typeof MoveTicketInput>;

export const CommentTicketInput = z.object({
  ticketId: Id,
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX_LENGTH),
});
export type CommentTicketInput = z.infer<typeof CommentTicketInput>;

export const BoardEventSchema = z.object({
  spaceId: Id,
  boardId: Id.optional(),
  ticketId: Id.optional(),
  createdAt: z.string(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const TicketWorkFindingSchema = z.object({
  conclusion: z.string().trim().min(1).max(1200),
  outcome: z.enum(["pass", "issue", "unknown"]),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2400)
    .describe("Observed evidence, or the missing evidence for an unknown."),
});

export const CreateTicketInput = z.object({
  boardId: Id.optional(),
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  assigneeBotId: Id,
  fileDeliveryRequirements: TicketFileDeliveryRequirementsSchema.refine(
    (requirements) => requirements.version === 1,
    { message: "New file-delivery requirements start at version 1." },
  ).optional(),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

const TicketFileDeliveryEvidenceBaseSchema = z.object({
  requirementId: z.string().trim().min(1).max(120),
});

export const TicketFileDeliveryEvidenceInputSchema = z.discriminatedUnion("kind", [
  TicketFileDeliveryEvidenceBaseSchema.extend({
    kind: z.literal("artifact"),
    artifactId: Id,
    version: z.number().int().positive().max(2_147_483_647),
    hash: z.string().regex(/^[a-f0-9]{64}$/i),
    role: z.enum(["deliverable", "source"]).optional(),
  }),
  TicketFileDeliveryEvidenceBaseSchema.extend({
    kind: z.literal("effect"),
    effectId: Id,
  }),
]);

export const TicketFileDeliveryEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  TicketFileDeliveryEvidenceBaseSchema.extend({
    kind: z.literal("artifact"),
    artifactId: Id,
    version: z.number().int().positive().max(2_147_483_647),
    hash: z.string().regex(/^[a-f0-9]{64}$/i),
    observedAt: IsoDate,
    role: z.enum(["deliverable", "source"]).optional(),
  }),
  TicketFileDeliveryEvidenceBaseSchema.extend({
    kind: z.literal("effect"),
    effectId: Id,
    observedAt: IsoDate,
  }),
]);

export const TicketFileDeliverySchema = z.object({
  requirementsVersion: z.number().int().positive().max(2_147_483_647),
  evidenceRefs: z.array(TicketFileDeliveryEvidenceInputSchema).max(40),
});
export type TicketFileDelivery = z.infer<typeof TicketFileDeliverySchema>;
export type TicketFileDeliveryEvidenceReference = z.infer<
  typeof TicketFileDeliveryEvidenceReferenceSchema
>;

const TicketFileDeliveryJudgmentSchema = z.object({
  coverage: z.enum(["verified", "issue", "unknown"]),
  evidenceSupport: z.enum(["verified", "issue", "unknown"]),
});

export const TicketFileDeliveryAcceptanceResultSchema = z.object({
  requirementId: z.string(),
  status: z.enum(["verified", "issue", "unknown"]),
  reason: z.enum([
    "verified_observation",
    "missing_evidence",
    "unsupported_semantic",
    "scope_mismatch",
    "version_mismatch",
    "artifact_unavailable",
    "artifact_unreadable",
    "artifact_hash_mismatch",
    "artifact_constraint_mismatch",
    "effect_unavailable",
    "effect_not_completed",
    "effect_kind_mismatch",
    "unsupported_evidence",
    "content_verified",
    "content_constraint_mismatch",
    "content_unsupported",
    "content_unreadable",
    "content_too_large",
    "semantic_verified",
    "semantic_issue",
    "judge_unavailable",
    "judge_error",
    "judge_invalid_output",
    "judge_missing_usage",
    "judge_unknown_cost",
    "judge_uncalibrated",
    "judge_budget_exceeded",
  ]),
  evidenceRefs: z.array(TicketFileDeliveryEvidenceReferenceSchema),
  judge: z
    .object({
      rubricVersion: z.string(),
      calibrationRevision: z.string(),
      operationId: z.string(),
      status: z.enum(["verified", "issue", "unknown"]),
      reason: z.string(),
      costUsd: z.number().nonnegative().nullable(),
      totalTokens: z.number().int().nonnegative().nullable(),
      verdict: TicketFileDeliveryJudgmentSchema.extend({ reason: z.string() }).optional(),
      calibration: z
        .object({
          rubricVersion: z.string(),
          revision: z.string(),
          rubricDigest: z.string(),
          fixtureDigest: z.string(),
          modelFingerprint: z.string(),
          operationId: z.string(),
          status: z.enum(["verified", "unknown"]),
          reason: z.string(),
          costUsd: z.number().nonnegative().nullable(),
          totalTokens: z.number().int().nonnegative().nullable(),
          cases: z.array(
            z.object({
              id: z.string(),
              expected: TicketFileDeliveryJudgmentSchema,
              actual: TicketFileDeliveryJudgmentSchema.nullable(),
            }),
          ),
        })
        .optional(),
    })
    .optional(),
});

export const TicketFileDeliveryAcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  evaluatorRevision: z.enum(["file-delivery.v1", "file-delivery.v2"]),
  requirementsVersion: z.number().int().positive(),
  status: z.enum(["verified", "issue", "unknown"]),
  results: z.array(TicketFileDeliveryAcceptanceResultSchema).min(1).max(20),
});
export type TicketFileDeliveryAcceptance = z.infer<typeof TicketFileDeliveryAcceptanceSchema>;
export type TicketFileDeliveryAcceptanceResult = z.infer<
  typeof TicketFileDeliveryAcceptanceResultSchema
>;

/** Conclusions explicitly say which observation supports them or which evidence is missing. */
export const TicketWorkResult = z.object({
  previousVersion: z.number().int().min(0).max(2_147_483_646),
  summary: z.string().trim().min(1).max(1600),
  findings: z.array(TicketWorkFindingSchema).min(1).max(20),
  artifactIds: z.array(z.string().min(1).max(200)).max(8).optional(),
  finalArtifactId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "The finished deliverable from artifactIds. Forward this same artifact after review. Markdown and plain text are displayed directly from its bytes; do not rewrite them in a separate reply.",
    )
    .optional(),
  /** References the requirements fixed on the ticket before delivery. */
  fileDelivery: TicketFileDeliverySchema.optional(),
});
export type TicketWorkResult = z.infer<typeof TicketWorkResult>;
