import * as z from "zod";
import { Id } from "./ids.js";

export const ManagedWorkDependencySchema = z.object({
  ticketId: Id,
  requirementsVersion: z.number().int().positive(),
  receiptVersion: z.number().int().positive().optional(),
});
export type ManagedWorkDependency = z.infer<typeof ManagedWorkDependencySchema>;

export const ManagedWorkEventStatusSchema = z.enum([
  "pending",
  "prepared",
  "handled",
  "suppressed",
  "failed",
]);
export type ManagedWorkEventStatus = z.infer<typeof ManagedWorkEventStatusSchema>;

export const ManagedWorkContextSchema = z.object({
  ticketId: Id,
  parentTicketId: Id.nullable(),
  controlEpoch: z.number().int().nonnegative(),
  requirementsVersion: z.number().int().positive(),
  acceptedRequirementsVersion: z.number().int().positive().nullable(),
  acceptedReceiptVersion: z.number().int().positive().nullable(),
  stopped: z.boolean(),
});
export type ManagedWorkContext = z.infer<typeof ManagedWorkContextSchema>;

export const ManagedExternalInputQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
    .nullish(),
});
export type ManagedExternalInputQuestion = z.infer<typeof ManagedExternalInputQuestionSchema>;

/** Evidence from the provider, never arguments supplied by a model or answer client. */
export const ManagedExternalInputSchema = z.object({
  executionId: Id,
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  inputRequestId: z.string().min(1),
  requirementsVersion: z.number().int().positive(),
  controlEpoch: z.number().int().nonnegative(),
  inputResponseSupported: z.boolean(),
  resumable: z.boolean(),
  questions: z
    .array(ManagedExternalInputQuestionSchema)
    .min(1)
    .refine(
      (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
    ),
});
export type ManagedExternalInput = z.infer<typeof ManagedExternalInputSchema>;

export const ManagedExternalInputResponseSchema = z.object({
  status: z.enum(["collecting", "ready", "dispatching", "submitted", "unknown", "blocked"]),
  operationKey: z.string().min(1),
  questionIndex: z.number().int().nonnegative(),
  answers: z.record(z.string(), z.object({ answers: z.array(z.string()).min(1) })),
  messageId: Id.optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type ManagedExternalInputResponse = z.infer<typeof ManagedExternalInputResponseSchema>;

export const ManagedInputCheckpointSchema = z.object({
  kind: z.literal("managed_external_input_v1"),
  eventId: Id,
});
