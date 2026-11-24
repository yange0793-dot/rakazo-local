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
import { FORCE_BATCH_MESSAGES, MemoryArchiveStore } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { MAX_EXTRACTION_REQUEST_BYTES } from "./langmem-memory-extractor.js";
import { readAgentMemory } from "./memory-context.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** A normal background pass finishes within one job lease; the rest defers to another job. */
const DEFAULT_MAX_BATCHES = 4;
/** A clear drain still needs a finite ceiling; reaching it fails instead of deferring. */
const FORCE_MAX_BATCHES = 64;
const RECALL_LIMIT = 20;
/** The local index rejects a longer query, so recall reads the tail of the newest message. */
const MAX_RECALL_QUERY_BYTES = 8 * 1024;
const REDACTED = "[redacted]";
/** Shorter values cannot be redacted without shredding ordinary words; the password rule agrees. */
const MIN_SECRET_REDACTION_LENGTH = 6;
/** A worker killed mid-extraction leaves its job locked for Graphile's hours; retry after this. */
const LOCKED_EXTRACTION_ABANDONED_MS = 10 * 60_000;

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
 * checkpoint. A failure still propagates, but the pointer stops retrying so a range that cannot
 * be extracted costs one call per turn instead of one per reconciler tick; a forced clear steps
 * over such a range instead of blocking the clear for good.
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
  // A clear runs inside one request with an eight-minute budget, so each of its batches
  // covers as much of the conversation as one extraction request allows.
  const batchInput = options.force ? { ...input, limit: FORCE_BATCH_MESSAGES } : input;

  for (let processed = 0; ; processed += 1) {
    if (processed === maxBatches) {
      const remaining = await store.loadBatch(batchInput, ctx);
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
    const batch = await store.loadBatch(batchInput, ctx);
    if (!batch) return;
    try {
      await archiveBatch(deps, store, batch, ctx);
    } catch (error) {
      if (options.force && !ctx.signal.aborted) {
        // The person asked for these messages to be deleted: archive what can be archived,
        // step over one unextractable range, and keep the clear inside its request budget.
        getLogger().error("automatic memory skipped an unextractable range during a clear", error, {
          threadId: batch.threadId,
          fromSeq: batch.fromSeq,
          throughSeq: batch.throughSeq,
        });
        await store.applyBatch(batch, [], ctx);
        continue;
      }
      // The reconciler would retry this same range forever, one paid model call per tick.
      // Stop the automatic retries and keep the range; the next completed turn re-arms it.
      if (!ctx.signal.aborted) {
        await store.pause(input, ctx).catch((pauseError) => {
          getLogger().error("automatic memory pause failed", pauseError, {
            threadId: input.threadId,
          });
        });
        getLogger().warn("automatic memory stopped retrying this range", {
          threadId: input.threadId,
          botId: input.botId,
        });
      }
      throw error;
    }
  }
}

/** Enqueue one recovery job per scheduled conversation without resetting its idle debounce. */
export async function reconcileAutomaticMemory(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
}): Promise<void> {
  const pending = await new MemoryArchiveStore(deps.prisma).pending(100);
  const abandonedLockAt = new Date(Date.now() - LOCKED_EXTRACTION_ABANDONED_MS);
  await Promise.all(
    pending.map((pointer) =>
      deps.jobs.enqueue({
        ...automaticMemoryJob(pointer.threadId, pointer.botId, pointer.userId, pointer.availableAt),
        keepExisting: true,
        // A worker that died mid-extraction never unlocks its job; replace that one.
        replaceLockedBefore: abandonedLockAt,
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
  // Counts only, never content: an extraction used to leave no trace at all.
  getLogger().info("automatic memory extraction finished", {
    threadId: batch.threadId,
    saved: applied.saved,
    updated: applied.updated,
    removed: applied.removed,
    skipped: applied.skipped,
    proposed: proposed.length,
    rejected: proposed.length - changes.length,
  });
  if (applied.saved + applied.updated + applied.removed === 0) return;

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
  const query = tailBytes(batch.newSources.at(-1)?.text ?? "", MAX_RECALL_QUERY_BYTES);
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
    // Recall only supplies correction candidates; an index outage must not block archiving.
    getLogger().warn("automatic memory recall failed; extracting without candidates", {
      threadId: batch.threadId,
      error: response.error,
    });
    return [];
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
 * Only a literal quotation of this batch's new direct user message can support a change, and no
 * proposal may carry protected secret material or a redaction placeholder into storage. A
 * removal writes no new text: its content is the fact being forgotten, so only the quote is
 * checked.
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
    if (containsSecret(change.sourceQuote, secrets)) return false;
    if (change.sourceQuote.includes(REDACTED)) return false;
    if (change.remove === true) {
      const revision = change.expectedRevision;
      return (
        typeof change.replacesId === "string" &&
        typeof revision === "number" &&
        Number.isSafeInteger(revision) &&
        revision > 0
      );
    }
    return !containsSecret(change.content, secrets) && !change.content.includes(REDACTED);
  });
}

async function collectSecrets(deps: AutomaticMemoryDeps, ctx: AdapterContext): Promise<string[]> {
  const loaded = deps.loadSecrets ? await deps.loadSecrets(ctx) : [];
  // Longest first so a secret that contains another value is replaced whole. A one- or
  // two-character command value would otherwise shred ordinary text into [redacted].
  return [
    ...new Set(
      [...(deps.secrets ?? []), ...loaded].filter(
        (secret) => secret.length >= MIN_SECRET_REDACTION_LENGTH,
      ),
    ),
  ].sort((left, right) => right.length - left.length);
}

/** The tail of a text in whole characters, at most maxBytes of UTF-8. */
function tailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const bytes = Buffer.from(text);
  return bytes
    .subarray(bytes.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/, "");
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
