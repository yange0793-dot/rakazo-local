import { createHash } from "node:crypto";
import type { AdapterContext, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { redactSecrets, requestDeadline, withAbort } from "@rakazo/core";
import { sanitizeConnectorError } from "./connector-safety.js";
import { buildLessonNotes } from "./lesson-notes.js";
import { selfEvolutionEnabled } from "./self-evolution.js";
import { truncateUtf8 } from "./utf8.js";

export const MAX_RUN_STAGE_RECALLS = 3;
export const RUN_STAGE_RECALL_TIMEOUT_MS = 1_500;
const MAX_RUN_STAGE_QUERY_BYTES = 2_000;

export type RunStageRecallTrigger =
  | { stage: "recovery"; task: string }
  | { stage: "tool_failure"; toolName: string; error: unknown }
  | { stage: "acceptance_gap"; task: string; gaps: readonly string[] };

export type RunStageRecallOmission = {
  id: string;
  revision: number;
  reason: "body_budget" | "note_budget" | "note_limit" | "empty";
};

export type RunStageRecallResult = {
  addition?: string;
  audit: {
    stage: RunStageRecallTrigger["stage"];
    status:
      | "added"
      | "no_match"
      | "omitted"
      | "duplicate"
      | "limit"
      | "feature_off"
      | "external"
      | "provider_unavailable"
      | "unknown";
    references: Array<{ id: string; revision: number }>;
    omitted: RunStageRecallOmission[];
    bytes: number;
    recallsUsed: number;
  };
};

function stageQuery(trigger: RunStageRecallTrigger, secrets: readonly string[]): string {
  let query: string;
  switch (trigger.stage) {
    case "recovery":
      query = `Task recovery:\n${trigger.task}`;
      break;
    case "tool_failure":
      query = `Observed tool failure: ${sanitizeConnectorError(trigger.error, [...secrets])}\nTool: ${trigger.toolName}`;
      break;
    case "acceptance_gap":
      query = `Acceptance evidence gap:\n${trigger.task}\nMissing evidence: ${trigger.gaps.join(", ")}`;
      break;
  }
  return truncateUtf8(
    sanitizeConnectorError(redactSecrets(query, [...secrets]), [...secrets]).trim(),
    MAX_RUN_STAGE_QUERY_BYTES,
  );
}

function redactReference<T extends { id: string; revision: number }>(
  reference: T,
  secrets: readonly string[],
): T {
  return { ...reference, id: redactSecrets(reference.id, [...secrets]) };
}

export function createRunStageRecall(
  options: {
    provider: SemanticMemoryProvider | null;
    botId: string;
    threadId: string;
    secrets: readonly string[];
    external: boolean;
  },
  context: AdapterContext,
): (trigger: RunStageRecallTrigger) => Promise<RunStageRecallResult> {
  const seen = new Set<string>();
  let recallsUsed = 0;

  return async (trigger) => {
    const audit = (
      status: RunStageRecallResult["audit"]["status"],
      values: Partial<Pick<RunStageRecallResult["audit"], "references" | "omitted" | "bytes">> = {},
    ): RunStageRecallResult => ({
      audit: {
        stage: trigger.stage,
        status,
        references: values.references ?? [],
        omitted: values.omitted ?? [],
        bytes: values.bytes ?? 0,
        recallsUsed,
      },
    });

    if (!selfEvolutionEnabled()) return audit("feature_off");
    if (options.external) return audit("external");
    const provider = options.provider;
    if (!provider) return audit("provider_unavailable");
    let readableLessons: boolean;
    try {
      readableLessons =
        provider.describe().capabilities.managedFacts === true && Boolean(provider.read);
    } catch {
      return audit("provider_unavailable");
    }
    if (!readableLessons) return audit("provider_unavailable");

    const query = stageQuery(trigger, options.secrets);
    const signalKey = createHash("sha256").update(`${trigger.stage}\0${query}`).digest("hex");
    if (seen.has(signalKey)) return audit("duplicate");
    seen.add(signalKey);
    if (recallsUsed >= MAX_RUN_STAGE_RECALLS) return audit("limit");
    recallsUsed += 1;

    const deadline = requestDeadline(
      RUN_STAGE_RECALL_TIMEOUT_MS,
      "Lesson recall deadline exceeded.",
      context.signal,
    );
    try {
      const response = await withAbort(
        provider.recall(
          {
            query,
            scope: "isolated",
            botId: options.botId,
            threadId: options.threadId,
            kind: "lesson",
            limit: 3,
          },
          { ...context, signal: deadline.signal },
        ),
        deadline.signal,
      );
      if (!response.ok) return audit("unknown");
      if (!Array.isArray(response.value)) return audit("unknown");
      const lessons = response.value.flatMap((result) =>
        typeof result.id === "string" &&
        result.id.length > 0 &&
        Number.isSafeInteger(result.revision) &&
        result.revision! > 0 &&
        typeof result.memory === "string"
          ? [{ id: result.id, revision: result.revision!, content: result.memory }]
          : [],
      );
      if (response.value.length > 0 && lessons.length === 0) return audit("unknown");
      if (lessons.length === 0) return audit("no_match");

      const notes = buildLessonNotes(lessons, options.secrets);
      const references = notes.shown.map((reference) =>
        redactReference(reference, options.secrets),
      );
      const omitted = notes.omitted.map((entry) => redactReference(entry, options.secrets));
      return {
        ...(notes.text ? { addition: notes.text } : {}),
        audit: {
          stage: trigger.stage,
          status: notes.text ? "added" : "omitted",
          references,
          omitted,
          bytes: notes.bytes,
          recallsUsed,
        },
      };
    } catch {
      return audit("unknown");
    } finally {
      deadline.dispose();
    }
  };
}
