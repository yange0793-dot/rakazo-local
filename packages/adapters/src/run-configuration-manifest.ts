import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentContextStrategy,
  AgentRuntime,
  ArtifactStore,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";

export const RUN_CONFIGURATION_MANIFEST_FORMAT = "rakazo-run-configuration-manifest";
export const RUN_CONFIGURATION_MANIFEST_VERSION = 1;
/** Separate from tool/approval effects and the disposable turn checkpoint. */
export const RUN_CONFIGURATION_RECEIPT_KIND = "runtime_configuration";

export type RunConfigurationModel = {
  provider: string;
  modelId: string;
  /** Configured level for this target; it is not proof of the provider's effective level. */
  reasoningLevel: string | null;
};

export type RunConfigurationManifestInput = {
  runId: string;
  attemptId: string;
  deploymentRevision: string | null;
  model: {
    requested: RunConfigurationModel | null;
    /** Executor-delivered configuration, not proof of what the provider used. */
    deliveredAtStart: RunConfigurationModel | null;
    computerModel: RunConfigurationModel | null;
    /** Null until the runtime exposes its resolved level. */
    effectiveReasoningLevel: string | null;
    /** Backups still eligible at runtime entry, after startup selection. */
    allowedFallbacks: readonly RunConfigurationModel[] | null;
    /** Observations through this snapshot only; later callbacks have separate immutable receipts. */
    actualFallbacks:
      | readonly (RunConfigurationModel & {
          source: "startup-selection" | "runtime-switch";
        })[]
      | null;
  };
  runtime: ReturnType<AgentRuntime["describe"]> | null;
  contextPolicy: {
    requestedStrategy: AgentContextStrategy | null;
    deliveredStrategy: AgentContextStrategy | null;
    effectiveStrategy: AgentContextStrategy | null;
    /** Current pipeline has no independent context or recall policy revision. */
    revision: string | null;
    recallRevision: string | null;
  };
  /** Null means run pins were not read; [] means the pin query found none. */
  pinnedTaughtSkills: readonly { skillId: string; revisionId: string }[] | null;
  /** These are the lessons actually rendered, not every recalled candidate. */
  shownLessons: readonly { lessonId: string; revision: number }[] | null;
};

export type RunConfigurationManifest = {
  format: typeof RUN_CONFIGURATION_MANIFEST_FORMAT;
  version: typeof RUN_CONFIGURATION_MANIFEST_VERSION;
  runId: string;
  attemptId: string;
  deploymentRevision: string | null;
  model: {
    requested: RunConfigurationModel | null;
    deliveredAtStart: RunConfigurationModel | null;
    computerModel: RunConfigurationModel | null;
    effectiveReasoningLevel: string | null;
    allowedFallbacks: RunConfigurationModel[] | null;
    actualFallbacks: Array<
      RunConfigurationModel & { source: "startup-selection" | "runtime-switch" }
    > | null;
  };
  runtime: {
    id: string;
    contractVersion: string;
    adapterVersion: string;
    capabilities: {
      streaming: boolean;
      compaction: boolean;
      tools: boolean;
      scripted: boolean;
    };
  } | null;
  contextPolicy: {
    requestedStrategy: AgentContextStrategy | null;
    deliveredStrategy: AgentContextStrategy | null;
    effectiveStrategy: AgentContextStrategy | null;
    revision: string | null;
    recallRevision: string | null;
  };
  pinnedTaughtSkills: Array<{ skillId: string; revisionId: string }> | null;
  shownLessons: Array<{ lessonId: string; revision: number }> | null;
};

export function buildRunConfigurationManifest(
  input: RunConfigurationManifestInput,
): RunConfigurationManifest {
  const deploymentRevision = input.deploymentRevision?.trim();
  const runtime = input.runtime;

  return {
    format: RUN_CONFIGURATION_MANIFEST_FORMAT,
    version: RUN_CONFIGURATION_MANIFEST_VERSION,
    runId: input.runId,
    attemptId: input.attemptId,
    deploymentRevision:
      deploymentRevision && deploymentRevision !== "unknown" ? deploymentRevision : null,
    model: {
      requested: input.model.requested
        ? {
            provider: input.model.requested.provider,
            modelId: input.model.requested.modelId,
            reasoningLevel: input.model.requested.reasoningLevel,
          }
        : null,
      deliveredAtStart: input.model.deliveredAtStart
        ? {
            provider: input.model.deliveredAtStart.provider,
            modelId: input.model.deliveredAtStart.modelId,
            reasoningLevel: input.model.deliveredAtStart.reasoningLevel,
          }
        : null,
      computerModel: input.model.computerModel
        ? {
            provider: input.model.computerModel.provider,
            modelId: input.model.computerModel.modelId,
            reasoningLevel: input.model.computerModel.reasoningLevel,
          }
        : null,
      effectiveReasoningLevel: input.model.effectiveReasoningLevel,
      allowedFallbacks:
        input.model.allowedFallbacks?.map(({ provider, modelId, reasoningLevel }) => ({
          provider,
          modelId,
          reasoningLevel,
        })) ?? null,
      actualFallbacks:
        input.model.actualFallbacks?.map(({ provider, modelId, reasoningLevel, source }) => ({
          provider,
          modelId,
          reasoningLevel,
          source,
        })) ?? null,
    },
    runtime: runtime
      ? {
          id: runtime.id,
          contractVersion: runtime.contractVersion,
          adapterVersion: runtime.adapterVersion,
          capabilities: {
            streaming: runtime.capabilities.streaming,
            compaction: runtime.capabilities.compaction,
            tools: runtime.capabilities.tools,
            scripted: runtime.capabilities.scripted,
          },
        }
      : null,
    contextPolicy: {
      requestedStrategy: input.contextPolicy.requestedStrategy,
      deliveredStrategy: input.contextPolicy.deliveredStrategy,
      effectiveStrategy: input.contextPolicy.effectiveStrategy,
      revision: input.contextPolicy.revision,
      recallRevision: input.contextPolicy.recallRevision,
    },
    pinnedTaughtSkills:
      input.pinnedTaughtSkills?.map(({ skillId, revisionId }) => ({ skillId, revisionId })) ?? null,
    shownLessons:
      input.shownLessons?.map(({ lessonId, revision }) => ({ lessonId, revision })) ?? null,
  };
}

export async function storeRunConfigurationManifest(
  artifacts: ArtifactStore,
  context: AdapterContext,
  input: RunConfigurationManifestInput,
): Promise<{ storageKey: string; sha256: string; size: number }> {
  const manifest = buildRunConfigurationManifest(input);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await artifacts.put(
    {
      name: "run-configuration-manifest.v1.json",
      mimeType: "application/json",
      bytes,
    },
    { ...context, runId: input.runId },
  );

  return { storageKey: stored.id, sha256, size: bytes.byteLength };
}

type ReceiptScope = { runId: string; attemptId: string; spaceId: string };
type ReceiptLease = { owner: string; fence: number };
type ModelChange = {
  provider: string;
  modelId: string;
  /** Undefined is a backup callback; false/true are main/computer role callbacks. */
  computerMode?: boolean;
};

async function appendConfigurationReceipt(
  prisma: PrismaClient,
  scope: ReceiptScope,
  lease: ReceiptLease,
  receipt: {
    phase: "start" | "model-change";
    sequence: number;
    result: Prisma.InputJsonObject;
    modelChange?: ModelChange;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Match saveRunTurnCheckpoint: terminal writes or a newer lease fence win first,
    // or wait until this receipt commits. A model change and its receipt commit together.
    const locked = await tx.run.updateMany({
      where: {
        id: scope.runId,
        spaceId: scope.spaceId,
        status: "running",
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
      },
      data: {
        leaseFence: lease.fence,
        ...(receipt.modelChange && !receipt.modelChange.computerMode
          ? {
              modelProvider: receipt.modelChange.provider,
              modelId: receipt.modelChange.modelId,
            }
          : {}),
      },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before configuration receipt");
    const attempt = await tx.attempt.findFirst({
      where: { id: scope.attemptId, runId: scope.runId, fence: lease.fence, status: "running" },
      select: { id: true },
    });
    if (!attempt) throw new Error("Run attempt expired before configuration receipt");
    await tx.externalEffect.create({
      data: {
        spaceId: scope.spaceId,
        runId: scope.runId,
        kind: RUN_CONFIGURATION_RECEIPT_KIND,
        status: RUN_CONFIGURATION_RECEIPT_KIND,
        idempotencyKey: JSON.stringify([
          RUN_CONFIGURATION_RECEIPT_KIND,
          scope.runId,
          scope.attemptId,
          receipt.phase,
          receipt.sequence,
        ]),
        request: {
          attemptId: scope.attemptId,
          phase: receipt.phase,
          sequence: receipt.sequence,
        },
        result: receipt.result,
      },
    });
  });
}

/** A create-only reference owns the object. Failed/duplicate publication removes only its new object. */
export async function persistRunConfigurationManifest(
  prisma: PrismaClient,
  artifacts: ArtifactStore,
  context: AdapterContext,
  input: RunConfigurationManifestInput,
  lease: ReceiptLease,
): Promise<void> {
  const reference = await storeRunConfigurationManifest(artifacts, context, input);
  try {
    await appendConfigurationReceipt(
      prisma,
      { runId: input.runId, attemptId: input.attemptId, spaceId: context.spaceId },
      lease,
      {
        phase: "start",
        sequence: 0,
        result: {
          format: RUN_CONFIGURATION_MANIFEST_FORMAT,
          version: RUN_CONFIGURATION_MANIFEST_VERSION,
          ...reference,
        },
      },
    );
  } catch (error) {
    await artifacts.remove(reference.storageKey, { ...context, runId: input.runId });
    throw error;
  }
}

/** The callback confirms selection before a request, not a provider response or effective effort. */
export async function recordRunConfigurationModelChange(
  prisma: PrismaClient,
  scope: ReceiptScope,
  lease: ReceiptLease,
  sequence: number,
  operationId: string,
  change: ModelChange,
): Promise<void> {
  await appendConfigurationReceipt(prisma, scope, lease, {
    phase: "model-change",
    sequence,
    modelChange: change,
    result: {
      source: "onModelChange",
      operationId,
      provider: change.provider,
      modelId: change.modelId,
      computerMode: change.computerMode ?? null,
      effectiveReasoningLevel: null,
    },
  });
}
