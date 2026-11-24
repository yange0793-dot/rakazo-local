import { createHash } from "node:crypto";
import type { MemoryDerivedSpan } from "@rakazo/adapter-kit";
import { MemoryDerivedSpansSchema } from "@rakazo/adapter-kit";

export function memoryDerivations(value: unknown, content: string): MemoryDerivedSpan[] {
  if (value === null || value === undefined) return [];
  const spans = MemoryDerivedSpansSchema.parse(value);
  if (
    spans.some(
      (span) =>
        span.end > content.length ||
        (span.start !== 0 && content[span.start - 1] !== "\n") ||
        (span.end !== content.length && content[span.end - 1] !== "\n"),
    )
  )
    throw new Error("Memory derivations must cover complete lines within the document.");
  return spans;
}

export function memorySpanHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Previous-release writers do not know these offsets; changed text becomes user-owned. */
export function storedMemoryDerivations(value: unknown, content: string): MemoryDerivedSpan[] {
  if (value === null || value === undefined) return [];
  return MemoryDerivedSpansSchema.parse(value).filter(
    (span) =>
      span.end <= content.length &&
      (span.start === 0 || content[span.start - 1] === "\n") &&
      (span.end === content.length || content[span.end - 1] === "\n") &&
      (!span.contentHash ||
        span.contentHash === memorySpanHash(content.slice(span.start, span.end))),
  );
}

/**
 * Match exact lines, including moved lines. When identical manual and derived lines collapse
 * into one, keep the manual occurrence: a source correction must never erase handwritten text.
 */
export function retainMemoryDerivations(
  previous: string,
  content: string,
  spans: readonly MemoryDerivedSpan[],
  copyDerived = false,
): MemoryDerivedSpan[] {
  const lines = new Map<string, Array<MemoryDerivedSpan["sources"] | undefined>>();
  const derivedLines = new Map<string, MemoryDerivedSpan["sources"]>();
  let start = 0;
  for (const line of previous.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const key = line.replace(/\r?\n$/, "");
    const source = spans.find((span) => span.start <= start && span.end >= start + line.length);
    const matches = lines.get(key) ?? [];
    // Untracked occurrences have priority when duplicate lines are removed.
    if (source) {
      matches.push(source.sources);
      derivedLines.set(key, source.sources);
    } else matches.unshift(undefined);
    lines.set(key, matches);
    start += line.length;
  }
  const retained: MemoryDerivedSpan[] = [];
  start = 0;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const key = line.replace(/\r?\n$/, "");
    const matches = lines.get(key);
    const sources = matches?.length
      ? matches.shift()
      : copyDerived
        ? derivedLines.get(key)
        : undefined;
    if (sources) {
      const last = retained.at(-1);
      if (last?.end === start && JSON.stringify(last.sources) === JSON.stringify(sources))
        last.end += line.length;
      else retained.push({ start, end: start + line.length, sources });
    }
    start += line.length;
  }
  return retained;
}

export function projectMemory(
  content: string,
  spans: readonly MemoryDerivedSpan[],
  current: readonly boolean[],
): { content: string; derivations: MemoryDerivedSpan[]; hidden: MemoryDerivedSpan[] } {
  let projected = "";
  let cursor = 0;
  const visible: MemoryDerivedSpan[] = [];
  const hidden: MemoryDerivedSpan[] = [];
  for (const [index, span] of spans.entries()) {
    projected += content.slice(cursor, span.start);
    if (current[index]) {
      const start = projected.length;
      projected += content.slice(span.start, span.end);
      visible.push({ ...span, start, end: projected.length });
    } else hidden.push(span);
    cursor = span.end;
  }
  return { content: projected + content.slice(cursor), derivations: visible, hidden };
}
