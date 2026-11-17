import type {
  AdapterContext,
  JobPublisher,
  MemoryExtractionChange,
  MemoryExtractionExisting,
  MemoryExtractionNote,
  MemoryExtractionRequest,
  MemoryExtractor,
  MemoryStore,
} from "@rakazo/adapter-kit";
import { automaticMemoryJob, semanticMemorySyncJob } from "@rakazo/adapter-kit";
import type { MemoryArchiveBatch, PrismaClient } from "@rakazo/db";
import { MemoryArchiveStore } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { readAgentMemory } from "./memory-context.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** A normal background pass finishes within one job lease; the rest defers to another job. */
const DEFAULT_MAX_BATCHES = 4;
/** A clear drain still needs a finite ceiling; reaching it fails instead of deferring. */
const FORCE_MAX_BATCHES = 64;
const RECALL_LIMIT = 20;
const REDACTED = "[redacted]";
/** An explicit ceiling for one extractor frame. Overflow fails; sources are never truncated. */
const MAX_EXTRACTION_REQUEST_BYTES = 4 * 1024 * 1024;

export interface AutomaticMemoryDeps {
  prisma: PrismaClient;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  jobs: JobPublisher;
  /** Created by the composition root from the owner's selected runtime model. */
  extractor: MemoryExtractor;
  /** Literal secret values that must never reach the extractor. */
  secrets?: readonly string[];
  /** Load remaining secrets only when a batch actually needs extraction. */
  loadSecrets?: (context: AdapterContext) => Promise<readonly string[]>;
}

export interface AutomaticMemoryInput {
  threadId: string;
  botId: string;
  userId: string;
}

export interface AutomaticMemoryOptions {
  maxBatches?: number;
  /** Clear-time drain: process to the pinned head or fail instead of deferring. */
  force?: boolean;
}

/**
 * Archive new direct user text from one personal conversation. Ordinary chat never calls this on
 * its hot path: a durable pointer job invokes it, and a batch with no new source only advances the
 * checkpoint. Failures propagate so the job retries instead of appearing complete.
 */
export async function archiveConversationMemory(
  deps: AutomaticMemoryDeps,
  input: AutomaticMemoryInput,
  ctx: AdapterContext,
  options: AutomaticMemoryOptions = {},
): Promise<void> {
  const store = new MemoryArchiveStore(deps.prisma);
  const maxBatches = Math.max(
    1,
    options.maxBatches ?? (options.force ? FORCE_MAX_BATCHES : DEFAULT_MAX_BATCHES),
  );

  for (let processed = 0; ; processed += 1) {
    if (processed === maxBatches) {
      const remaining = await store.loadBatch(input, ctx);
      if (!remaining) return;
      if (options.force) {
        throw new Error(
          `Automatic memory still had batches to apply after ${maxBatches} for thread ${input.threadId}.`,
        );
      }
      // The durable cursor keeps the source; one job resumes it after this pass returns.
      await deps.jobs.enqueue(
        automaticMemoryJob(input.threadId, input.botId, input.userId, new Date()),
      );
      return;
    }
    const batch = await store.loadBatch(input, ctx);
    if (!batch) return;
    await archiveBatch(deps, store, batch, ctx);
  }
}

/** Enqueue one recovery job per scheduled conversation without resetting its idle debounce. */
export async function reconcileAutomaticMemory(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
}): Promise<void> {
  const pending = await new MemoryArchiveStore(deps.prisma).pending(100);
  await Promise.all(
    pending.map((pointer) =>
      deps.jobs.enqueue({
        ...automaticMemoryJob(pointer.threadId, pointer.botId, pointer.userId, pointer.availableAt),
        keepExisting: true,
      }),
    ),
  );
}

async function archiveBatch(
  deps: AutomaticMemoryDeps,
  store: MemoryArchiveStore,
  batch: MemoryArchiveBatch,
  ctx: AdapterContext,
): Promise<void> {
  // No new direct user source: commit the checkpoint without loading secrets or calling a model.
  if (batch.newSources.length === 0) {
    await store.applyBatch(batch, [], ctx);
    return;
  }

  const secrets = await collectSecrets(deps, ctx);
  const request = await buildExtractionRequest(deps, batch, ctx, secrets);
  const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (requestBytes > MAX_EXTRACTION_REQUEST_BYTES) {
    // Never truncate a source and checkpoint it as if it had been read.
    throw new Error(
      `Automatic memory request for thread ${batch.threadId} is ${requestBytes} bytes, over the ${MAX_EXTRACTION_REQUEST_BYTES}-byte extractor limit; no checkpoint was saved.`,
    );
  }
  const proposed = await deps.extractor.extract(request, ctx);
  const changes = verifyProposedChanges(proposed, batch, secrets);
  const applied = await store.applyBatch(batch, changes, ctx);
  if (applied.saved + applied.updated === 0) return;

  try {
    await deps.jobs.enqueue(semanticMemorySyncJob(batch.spaceId));
  } catch (error) {
    // The facts are committed; reconciliation drains the outbox, so do not fail the batch.
    getLogger().error("Automatic memory saved but its index sync job was not enqueued", error, {
      threadId: batch.threadId,
      spaceId: batch.spaceId,
    });
  }
}

async function buildExtractionRequest(
  deps: AutomaticMemoryDeps,
  batch: MemoryArchiveBatch,
  ctx: AdapterContext,
  secrets: readonly string[],
): Promise<MemoryExtractionRequest> {
  const query = batch.newSources.at(-1)?.text ?? "";
  const recalled = await recallRelatedFacts(deps, batch, ctx, redactText(query, secrets));
  const notes = (await readAgentMemory(deps.memory, batch.botId, ctx)).map(
    (document): MemoryExtractionNote => ({
      scope: document.scope,
      path: document.path,
      revision: document.revision,
      content: redactText(document.content, secrets),
    }),
  );
  return {
    messages: batch.messages.map((message) => ({
      ...message,
      content: redactText(message.content, secrets),
    })),
    existing: mergeExisting(recalled, batch.retirementEvidence, secrets),
    notes,
  };
}

/**
 * Active facts recalled from the batch's own scope. Facts without a host id or revision cannot be
 * corrected conditionally, so they are omitted rather than offered as update targets.
 */
async function recallRelatedFacts(
  deps: AutomaticMemoryDeps,
  batch: MemoryArchiveBatch,
  ctx: AdapterContext,
  query: string,
): Promise<MemoryExtractionExisting[]> {
  if (!query.trim()) return [];
  const configured = await deps.memoryProviders.resolve(batch.spaceId);
  if (!configured) return [];
  const response = await configured.provider.recall(
    { query, scope: batch.scope, botId: batch.botId, limit: RECALL_LIMIT },
    ctx,
  );
  if (!response.ok) {
    throw new Error(`Semantic memory recall failed for automatic extraction: ${response.error}`);
  }
  return response.value.flatMap((result): MemoryExtractionExisting[] =>
    result.id === undefined || result.revision === undefined
      ? []
      : [
          {
            id: result.id,
            revision: result.revision,
            content: result.memory,
            status: "active",
          },
        ],
  );
}

function mergeExisting(
  recalled: readonly MemoryExtractionExisting[],
  retirementEvidence: readonly MemoryExtractionExisting[],
  secrets: readonly string[],
): MemoryExtractionExisting[] {
  const byId = new Map<string, MemoryExtractionExisting>();
  for (const fact of recalled) byId.set(fact.id, fact);
  // Retirement evidence wins: a forgotten or historical fact keeps that status as data context.
  for (const fact of retirementEvidence) byId.set(fact.id, fact);
  return [...byId.values()].map((fact) => ({
    ...fact,
    content: redactText(fact.content, secrets),
    ...(fact.sourceQuote === undefined
      ? {}
      : { sourceQuote: redactText(fact.sourceQuote, secrets) }),
  }));
}

/**
 * Only a literal quotation of this batch's new direct user message can support a fact, and no
 * proposal may carry protected secret material or a redaction placeholder into storage.
 */
function verifyProposedChanges(
  changes: readonly MemoryExtractionChange[],
  batch: MemoryArchiveBatch,
  secrets: readonly string[],
): MemoryExtractionChange[] {
  const sources = new Map(batch.newSources.map((source) => [source.id, source.text] as const));
  return changes.filter((change) => {
    const source = sources.get(change.sourceMessageId);
    if (source === undefined) return false;
    if (!change.sourceQuote || !source.includes(change.sourceQuote)) return false;
    if (containsSecret(change.content, secrets) || containsSecret(change.sourceQuote, secrets)) {
      return false;
    }
    return !change.content.includes(REDACTED) && !change.sourceQuote.includes(REDACTED);
  });
}

async function collectSecrets(deps: AutomaticMemoryDeps, ctx: AdapterContext): Promise<string[]> {
  const loaded = deps.loadSecrets ? await deps.loadSecrets(ctx) : [];
  // Longest first so a secret that contains another value is replaced whole.
  return [
    ...new Set([...(deps.secrets ?? []), ...loaded].filter((secret) => secret.length > 0)),
  ].sort((left, right) => right.length - left.length);
}

function redactText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}
