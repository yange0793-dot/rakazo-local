import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type {
  TicketFileDelivery,
  TicketFileDeliveryAcceptance,
  TicketFileDeliveryAcceptanceResult,
  TicketFileDeliveryEvidenceReference,
  TicketFileDeliveryRequirements,
} from "@rakazo/contracts";
import { isToolPauseResult } from "./approval-effect.js";
import { evaluateFileDeliveryContent, readFileDeliveryContent } from "./file-delivery-content.js";
import type { FileDeliveryJudge, FileDeliveryJudgeEvidence } from "./file-delivery-judge.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";

type ArtifactObservation = {
  id: string;
  version: number;
  hash: string;
  name: string;
  mimeType: string;
  bytes?: Uint8Array;
  observedAt: string;
};

type EffectObservation = {
  id: string;
  status: string;
  kind: string;
  result: unknown;
  observedAt: string;
};

type ResultReason = TicketFileDeliveryAcceptanceResult["reason"];

function result(
  requirementId: string,
  status: TicketFileDeliveryAcceptanceResult["status"],
  reason: ResultReason,
  evidenceRefs: TicketFileDeliveryEvidenceReference[] = [],
): TicketFileDeliveryAcceptanceResult {
  return { requirementId, status, reason, evidenceRefs };
}

export interface FileDeliveryAcceptanceInput {
  requirements: TicketFileDeliveryRequirements;
  fileDelivery?: TicketFileDelivery;
  deliveredArtifactIds: readonly string[];
  artifacts: readonly ArtifactObservation[];
  effects: readonly EffectObservation[];
}

export function evaluateFileDeliveryAcceptance(
  input: FileDeliveryAcceptanceInput,
): TicketFileDeliveryAcceptance {
  const { requirements, fileDelivery } = input;
  const evidenceRefs = fileDelivery?.evidenceRefs ?? [];
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const effects = new Map(input.effects.map((effect) => [effect.id, effect]));
  const deliveredArtifactIds = new Set(input.deliveredArtifactIds);
  const results = requirements.items.map((requirement) => {
    if (fileDelivery && fileDelivery.requirementsVersion !== requirements.version)
      return result(requirement.id, "unknown", "version_mismatch");
    if (requirement.kind === "semantic")
      return result(requirement.id, "unknown", "unsupported_semantic");

    const refs = evidenceRefs.filter((ref) => ref.requirementId === requirement.id);
    if (!refs.length) return result(requirement.id, "unknown", "missing_evidence");
    const matchingKind = refs.filter((ref) => ref.kind === requirement.kind);
    if (!matchingKind.length) return result(requirement.id, "unknown", "unsupported_evidence");
    const verifiedRefs: TicketFileDeliveryEvidenceReference[] = [];
    let failure: ReturnType<typeof result> | undefined;
    for (const ref of matchingKind) {
      if (ref.kind === "artifact") {
        if (!deliveredArtifactIds.has(ref.artifactId)) {
          failure ??= result(requirement.id, "unknown", "artifact_unavailable");
          continue;
        }
        const artifact = artifacts.get(ref.artifactId);
        if (!artifact) {
          failure ??= result(requirement.id, "unknown", "artifact_unavailable");
          continue;
        }
        if (artifact.version !== ref.version) {
          failure ??= result(requirement.id, "issue", "version_mismatch");
          continue;
        }
        if (artifact.hash.toLowerCase() !== ref.hash.toLowerCase()) {
          failure ??= result(requirement.id, "issue", "artifact_hash_mismatch");
          continue;
        }
        if (!artifact.bytes) {
          failure ??= result(requirement.id, "unknown", "artifact_unreadable");
          continue;
        }
        const actualHash = createHash("sha256").update(artifact.bytes).digest("hex");
        if (actualHash !== artifact.hash.toLowerCase()) {
          failure ??= result(requirement.id, "issue", "artifact_hash_mismatch");
          continue;
        }
        if (
          requirement.kind !== "artifact" ||
          (requirement.name && requirement.name !== artifact.name) ||
          (requirement.mimeType && requirement.mimeType !== artifact.mimeType)
        ) {
          failure ??= result(requirement.id, "issue", "artifact_constraint_mismatch");
          continue;
        }
        if (requirement.contentConstraints?.length) {
          const content = evaluateFileDeliveryContent(
            readFileDeliveryContent({ mimeType: artifact.mimeType, bytes: artifact.bytes }),
            requirement.contentConstraints,
          );
          if (content.status !== "verified") {
            failure ??= result(requirement.id, content.status, content.reason);
            continue;
          }
        }
        verifiedRefs.push({ ...ref, observedAt: artifact.observedAt });
        continue;
      }

      const effect = effects.get(ref.effectId);
      if (!effect) {
        failure ??= result(requirement.id, "unknown", "effect_unavailable");
        continue;
      }
      if (requirement.kind !== "effect" || effect.kind !== requirement.effectKind) {
        failure ??= result(requirement.id, "issue", "effect_kind_mismatch");
        continue;
      }
      if (effect.status !== "completed") {
        failure ??=
          effect.status === "failed"
            ? result(requirement.id, "issue", "effect_not_completed")
            : result(requirement.id, "unknown", "effect_not_completed");
        continue;
      }
      if (effect.result == null) {
        failure ??= result(requirement.id, "unknown", "effect_unavailable");
        continue;
      }
      const effectResult = effect.result as {
        running?: unknown;
        code?: unknown;
        exitCode?: unknown;
        details?: { running?: unknown; code?: unknown; exitCode?: unknown };
      };
      const commandCode =
        effectResult.code ??
        effectResult.exitCode ??
        effectResult.details?.code ??
        effectResult.details?.exitCode;
      if (
        effectResult.running === true ||
        effectResult.details?.running === true ||
        isToolPauseResult(effect.result) ||
        (effect.kind === "shell" &&
          (typeof commandCode !== "number" || !Number.isFinite(commandCode)))
      ) {
        failure ??= result(requirement.id, "unknown", "effect_not_completed");
        continue;
      }
      if (
        toolCompletionOutcome({
          name: effect.kind,
          executionId: effect.id,
          durationMs: 0,
          result: effect.result,
        }) !== "succeeded"
      ) {
        failure ??= result(requirement.id, "issue", "effect_not_completed");
        continue;
      }
      verifiedRefs.push({ ...ref, observedAt: effect.observedAt });
    }
    if (verifiedRefs.length)
      return result(
        requirement.id,
        "verified",
        requirement.kind === "artifact" && requirement.contentConstraints?.length
          ? "content_verified"
          : "verified_observation",
        verifiedRefs,
      );
    return failure ?? result(requirement.id, "unknown", "missing_evidence");
  });
  const status = results.some((item) => item.status === "issue")
    ? "issue"
    : results.every((item) => item.status === "verified")
      ? "verified"
      : "unknown";
  return {
    schemaVersion: 1,
    evaluatorRevision: requirements.items.some(
      (item) => item.kind === "artifact" && item.contentConstraints?.length,
    )
      ? "file-delivery.v2"
      : "file-delivery.v1",
    requirementsVersion: requirements.version,
    status,
    results,
  };
}

/** The synchronous entry remains usable for legacy callers and deterministic acceptance. */
export async function evaluateFileDeliveryAcceptanceWithJudge(
  input: FileDeliveryAcceptanceInput,
  options?: { judge?: FileDeliveryJudge; context: AdapterContext },
): Promise<TicketFileDeliveryAcceptance> {
  const acceptance = evaluateFileDeliveryAcceptance(input);
  if (!input.fileDelivery || input.fileDelivery.requirementsVersion !== input.requirements.version)
    return acceptance;
  for (const [index, requirement] of input.requirements.items.entries()) {
    if (requirement.kind !== "semantic") continue;
    acceptance.evaluatorRevision = "file-delivery.v2";
    if (!options?.judge) {
      acceptance.results[index] = result(requirement.id, "unknown", "judge_unavailable");
      continue;
    }
    const refs = input.fileDelivery.evidenceRefs.filter(
      (ref) => ref.requirementId === requirement.id,
    );
    if (!refs.length) {
      acceptance.results[index] = result(requirement.id, "unknown", "missing_evidence");
      continue;
    }
    if (refs.some((ref) => ref.kind !== "artifact")) {
      acceptance.results[index] = result(requirement.id, "unknown", "unsupported_evidence");
      continue;
    }
    const evidence: FileDeliveryJudgeEvidence[] = [];
    const verifiedRefs: TicketFileDeliveryEvidenceReference[] = [];
    let failure: TicketFileDeliveryAcceptanceResult | undefined;
    for (const [refIndex, ref] of refs.entries()) {
      if (ref.kind !== "artifact") continue;
      // Reuse the host's exact delivery/hash/version checks before exposing text to a judge.
      const observation = evaluateFileDeliveryAcceptance({
        ...input,
        requirements: {
          version: input.requirements.version,
          items: [{ id: requirement.id, kind: "artifact", description: requirement.description }],
        },
        fileDelivery: { ...input.fileDelivery, evidenceRefs: [ref] },
      }).results[0]!;
      if (observation.status !== "verified") {
        failure = observation;
        break;
      }
      const artifact = input.artifacts.find((item) => item.id === ref.artifactId)!;
      const content = readFileDeliveryContent({
        mimeType: artifact.mimeType,
        bytes: artifact.bytes!,
      });
      if (content.status !== "read") {
        failure = result(requirement.id, "unknown", content.reason);
        break;
      }
      verifiedRefs.push(...observation.evidenceRefs);
      evidence.push({
        id: `evidence-${refIndex}`,
        artifactId: artifact.id,
        version: artifact.version,
        hash: artifact.hash,
        name: artifact.name,
        mimeType: artifact.mimeType,
        role: ref.role ?? "deliverable",
        text: content.text,
      });
    }
    const deliverables = new Set(
      evidence.filter((item) => item.role === "deliverable").map((item) => item.artifactId),
    );
    if (
      !failure &&
      (!deliverables.size ||
        evidence.some((item) => item.role === "source" && deliverables.has(item.artifactId)))
    )
      failure = result(requirement.id, "unknown", "unsupported_evidence");
    if (failure) {
      acceptance.results[index] = failure;
      continue;
    }
    try {
      const judgment = await options.judge(
        {
          requirementsVersion: input.requirements.version,
          requirementId: requirement.id,
          description: requirement.description,
          rubricVersion: requirement.rubricVersion,
          criteria: requirement.criteria,
          evidence,
        },
        options.context,
      );
      acceptance.results[index] = {
        requirementId: requirement.id,
        ...judgment,
        evidenceRefs: verifiedRefs,
      };
    } catch {
      acceptance.results[index] = result(requirement.id, "unknown", "judge_error", verifiedRefs);
    }
  }
  acceptance.status = acceptance.results.some((item) => item.status === "issue")
    ? "issue"
    : acceptance.results.every((item) => item.status === "verified")
      ? "verified"
      : "unknown";
  return acceptance;
}
