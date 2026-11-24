import type { SemanticMemoryReadRequest, SemanticMemoryResult } from "@rakazo/adapter-kit";
import type { MemoryDerivedSpan, MemorySourceFact } from "@rakazo/contracts";
import { MemorySourceFactSchema } from "@rakazo/contracts";
import * as z from "zod";

export const ToolSourceFactsSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1),
        revision: z.number().int().positive(),
        scope: z.enum(["isolated", "shared"]),
        kind: z.enum(["durable", "history", "lesson"]),
        threadId: z.string().min(1).optional(),
        historyGeneration: z.number().int().nonnegative().optional(),
      })
      .strict(),
  )
  .min(1)
  .max(32);

/** The tool supplies citation coordinates; the host binds the reader bot. */
export function memorySourceFactsArgument(
  args: Record<string, unknown>,
  botId: string,
): { sources: MemorySourceFact[] } | { error: string } {
  if (args.source_facts === undefined) return { sources: [] };
  const parsed = ToolSourceFactsSchema.safeParse(args.source_facts);
  if (!parsed.success) return { error: "source_facts must contain 1-32 exact memory citations." };
  const sources: MemorySourceFact[] = [];
  for (const source of parsed.data) {
    const bound = MemorySourceFactSchema.safeParse({ ...source, botId });
    if (!bound.success)
      return { error: "A source citation has an invalid scope, kind, or history generation." };
    sources.push(bound.data);
  }
  return { sources };
}

/** Call only after the exact body was successfully rendered by a managed provider. */
export function memoryReadSource(
  request: SemanticMemoryReadRequest,
  result: SemanticMemoryResult,
): MemorySourceFact | undefined {
  if (result.id !== request.id || result.revision !== request.expectedRevision || !result.kind)
    return undefined;
  const parsed = MemorySourceFactSchema.safeParse({
    id: result.id,
    revision: result.revision,
    botId: request.botId,
    scope: request.scope,
    kind: result.kind,
    ...(result.kind === "history"
      ? { threadId: request.threadId, historyGeneration: request.historyGeneration }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Mark only newly written lines, leaving unchanged and moved handwritten lines alone. */
export function memoryDerivationsForEdit(
  existing: string,
  content: string,
  sources: readonly MemorySourceFact[],
): MemoryDerivedSpan[] {
  if (!sources.length || content === existing) return [];
  const previous = new Map<string, number>();
  for (const line of existing.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const key = line.replace(/\r?\n$/, "");
    previous.set(key, (previous.get(key) ?? 0) + 1);
  }
  const spans: MemoryDerivedSpan[] = [];
  let start = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const key = line.replace(/\r?\n$/, "");
    const count = previous.get(key) ?? 0;
    if (count > 0) previous.set(key, count - 1);
    else if (line.trim()) {
      const last = spans.at(-1);
      if (last?.end === start) last.end += line.length;
      else spans.push({ start, end: start + line.length, sources: [...sources] });
    }
    start += line.length;
  }
  return spans;
}
