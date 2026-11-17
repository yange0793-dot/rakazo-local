import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** Facts are distinct from the Markdown notes that are included in every prompt. */
export const SemanticFactScopeSchema = z.enum(["isolated", "shared"]);
export const SemanticFactStatusSchema = z.enum(["active", "historical", "forgotten"]);

export const SEMANTIC_RECALL_DEFAULT_LIMIT = 20;
export const SEMANTIC_RECALL_MAX_LIMIT = 50;

export const SemanticMemoryRecallInputSchema = z
  .object({
    query: z.string().trim().min(1).max(10_000),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEMANTIC_RECALL_MAX_LIMIT)
      .default(SEMANTIC_RECALL_DEFAULT_LIMIT),
    scope: z.enum(["current", "isolated", "shared", "all"]).default("current"),
  })
  .strict();

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
  kind: z.enum(["durable", "history"]),
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
