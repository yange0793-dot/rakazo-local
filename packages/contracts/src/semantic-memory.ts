import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Facts are distinct from the Markdown notes that are included in every prompt. */
export const SemanticFactScopeSchema = z.enum(["isolated", "shared"]);
export const SemanticFactStatusSchema = z.enum(["active", "historical", "forgotten"]);

/**
 * Lessons are host-written notes for future runs and live in their own per-bot namespace, so
 * ordinary fact recall and listing never mix them with durable or history rows.
 */
export const SemanticFactKindSchema = z.enum(["durable", "history", "lesson"]);
export type SemanticFactKind = z.infer<typeof SemanticFactKindSchema>;

/** A host-checked citation, never a copy of the source text. */
export const MemorySourceFactSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive(),
    botId: Id,
    scope: SemanticFactScopeSchema,
    kind: SemanticFactKindSchema,
    threadId: Id.optional(),
    historyGeneration: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (source) =>
      source.kind === "history"
        ? source.threadId !== undefined && source.historyGeneration !== undefined
        : source.threadId === undefined && source.historyGeneration === undefined,
    { message: "Only history citations require a thread and generation." },
  )
  .refine((source) => source.kind !== "lesson" || source.scope === "isolated", {
    message: "Lessons belong to an isolated bot scope.",
  });
export type MemorySourceFact = z.infer<typeof MemorySourceFactSchema>;
export const MemorySourceFactsSchema = z.array(MemorySourceFactSchema).min(1).max(64);

/** UTF-16 offsets into the stored Markdown; each span covers complete lines. */
export const MemoryDerivedSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    sources: MemorySourceFactsSchema,
    /** Set by the store; a writer that changes bytes cannot leave authority on new text. */
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((span) => span.start < span.end, { message: "A derived span must contain text." });
export type MemoryDerivedSpan = z.infer<typeof MemoryDerivedSpanSchema>;
export const MemoryDerivedSpansSchema = z
  .array(MemoryDerivedSpanSchema)
  .max(256)
  .refine(
    (spans) => spans.every((span, index) => index === 0 || spans[index - 1]!.end <= span.start),
    { message: "Derived spans must be ordered and cannot overlap." },
  );

export const LessonEvidenceKindSchema = z.enum([
  "run_failed",
  "approval_denied",
  "tool_error",
  "user_steering",
  "user_feedback",
]);
export type LessonEvidenceKind = z.infer<typeof LessonEvidenceKindSchema>;

export const LessonEvidenceSchema = z.object({
  kind: LessonEvidenceKindSchema,
  quote: z.string().max(300),
  /** Only the host can attach the authenticated message behind a feedback quote. */
  messageId: Id.optional(),
});

/** Why a host-written lesson exists and which observed event it cites. */
export const LessonHarnessProvenanceSchema = z.object({
  domainKey: z.string().max(120),
  signals: z.array(z.string().max(40)).max(8),
  autoApplied: z.boolean(),
  evidence: LessonEvidenceSchema,
});
export type LessonHarnessProvenance = z.infer<typeof LessonHarnessProvenanceSchema>;

export const SEMANTIC_RECALL_DEFAULT_LIMIT = 20;
export const SEMANTIC_RECALL_MAX_LIMIT = 50;

/** Query discovery and exact revision reads share the existing recall tool. */
export const SemanticMemoryRecallInputSchema = z
  .union([
    z
      .object({
        query: z.string().trim().min(1).max(10_000),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEMANTIC_RECALL_MAX_LIMIT)
          .default(SEMANTIC_RECALL_DEFAULT_LIMIT),
        scope: z.enum(["current", "isolated", "shared", "all"]).default("current"),
        kind: z.literal("lesson").optional(),
      })
      .strict(),
    z
      .object({
        id: z.string().trim().min(1),
        expected_revision: z.number().int().positive(),
        scope: z.enum(["current", "isolated", "shared"]).default("current"),
        kind: z.literal("lesson").optional(),
      })
      .strict(),
  ])
  .refine(
    (input) => input.kind !== "lesson" || input.scope === "current" || input.scope === "isolated",
    { message: "Lessons belong to this bot's isolated scope.", path: ["scope"] },
  );

export const SemanticFactProvenanceSchema = z.object({
  kind: z.enum(["user", "run", "manual", "import", "history"]),
  runId: Id.optional(),
  threadId: Id.optional(),
  messageId: Id.optional(),
  sourcePath: z.string().optional(),
  sourceId: z.string().optional(),
  quote: z.string().optional(),
  category: z.enum(["preference", "project", "experience", "reference"]).optional(),
  observedAt: IsoDate.optional(),
  validFrom: IsoDate.optional(),
  validTo: IsoDate.optional(),
  /** Set on host-written lessons: why it exists and where it came from. */
  harness: LessonHarnessProvenanceSchema.optional(),
  /** Automatic projections depend on these exact source revisions. Manual edits detach. */
  derivedFrom: MemorySourceFactsSchema.optional(),
  /** Imported assertions are retained as history, not newly verified by the host. */
  legacy: z
    .object({
      validationStatus: z.string().optional(),
      sourceBotId: z.string().optional(),
      sourceProject: z.string().optional(),
      supersedes: z.string().optional(),
      supersededBy: z.string().optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

export const SemanticFactSchema = z.object({
  id: Id,
  botId: Id,
  scope: SemanticFactScopeSchema,
  kind: SemanticFactKindSchema,
  content: z.string(),
  revision: z.number().int().positive(),
  status: SemanticFactStatusSchema,
  provenance: SemanticFactProvenanceSchema,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type SemanticFact = z.infer<typeof SemanticFactSchema>;

export const SemanticFactListRequestSchema = z.object({
  botId: Id,
  scope: SemanticFactScopeSchema,
  /** "lesson" lists the host's lessons for this bot; omitted lists facts only. */
  kind: SemanticFactKindSchema.optional(),
  query: z.string().max(500).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeHistory: z.boolean().optional(),
});
export type SemanticFactListRequest = z.infer<typeof SemanticFactListRequestSchema>;

export const SemanticFactPageSchema = z.object({
  supported: z.boolean(),
  items: z.array(SemanticFactSchema),
  nextCursor: z.string().nullable(),
});
export type SemanticFactPage = z.infer<typeof SemanticFactPageSchema>;

export const SemanticFactCorrectRequestSchema = z.object({
  id: Id,
  botId: Id,
  scope: SemanticFactScopeSchema,
  /** "lesson" corrects a host-written lesson; omitted corrects a durable or history fact. */
  kind: SemanticFactKindSchema.optional(),
  content: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 40 * 1024,
      "Memory fact content must fit within 40 KiB.",
    ),
  expectedRevision: z.number().int().positive(),
});
export type SemanticFactCorrectRequest = z.infer<typeof SemanticFactCorrectRequestSchema>;

export const SemanticFactForgetRequestSchema = z.object({
  id: Id,
  botId: Id,
  scope: SemanticFactScopeSchema,
  /** "lesson" forgets a host-written lesson; omitted forgets a durable or history fact. */
  kind: SemanticFactKindSchema.optional(),
  expectedRevision: z.number().int().positive(),
});

export const SemanticFactExportRequestSchema = z.object({
  botId: Id,
  scope: SemanticFactScopeSchema,
});
export const SemanticFactExportSchema = z.object({
  format: z.literal("rakazo-semantic-memory-v1"),
  facts: z.array(SemanticFactSchema),
});
