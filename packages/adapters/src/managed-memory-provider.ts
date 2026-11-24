import type {
  AdapterContext,
  JobPublisher,
  SemanticMemoryProvider,
  SemanticMemoryResponse,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR, semanticMemorySyncJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  lessonFactNamespace,
  SemanticFactStore,
  semanticFactNamespace,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { LocalMemoryIndex } from "./local-memory-index.js";
import { LOCAL_MEMORY_PROVIDER_ID, MAX_LOCAL_MEMORY_CANDIDATES } from "./local-memory-index.js";

export interface ManagedMemoryProviderOptions {
  prisma: PrismaClient;
  index: LocalMemoryIndex;
  jobs?: Pick<JobPublisher, "enqueue">;
}

/** The index only stores revision candidates; the DB always supplies recalled text. */
export function createManagedMemoryProvider(
  options: ManagedMemoryProviderOptions,
): SemanticMemoryProvider {
  const store = new SemanticFactStore(options.prisma);
  const afterMutation = async (ctx: AdapterContext): Promise<void> => {
    try {
      if (options.jobs) await options.jobs.enqueue(semanticMemorySyncJob(ctx.spaceId));
      else await syncManagedMemoryIndex(options, ctx.spaceId, ctx.signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Index unavailable";
      throw new Error(`Memory change saved locally; index synchronization is pending. ${reason}`);
    }
  };

  return {
    describe: () => ({
      id: LOCAL_MEMORY_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
        preTurnRecall: true,
        managedFacts: true,
      },
    }),
    async recall(request, ctx) {
      return response(async () => {
        ctx.signal.throwIfAborted();
        if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
          throw new Error("Invalid memory recall limit.");
        // Authorize the real bot/space before sending even the query to the index.
        await store.authorizeScope(request, ctx);
        const startedAt = performance.now();
        // Lessons live in their own per-bot namespace, so ordinary recall never sees them.
        const namespace =
          request.kind === "lesson"
            ? lessonFactNamespace(ctx.spaceId, request.botId)
            : semanticFactNamespace(ctx.spaceId, request.scope, request.botId);
        const candidates = await options.index.search(
          {
            namespace,
            query: request.query,
            // The DB filters stale revisions/history after the index returns; keep a surplus.
            limit: MAX_LOCAL_MEMORY_CANDIDATES,
          },
          ctx.signal,
        );
        const results = await store.resolveCandidates(request, candidates, ctx);
        getLogger().info("semantic memory candidates resolved", {
          "memory.scope": request.scope,
          "memory.candidates": candidates.length,
          "memory.returned": results.length,
          "memory.limit": request.limit,
          "memory.duration_ms": Math.round(performance.now() - startedAt),
        });
        return results;
      });
    },
    async read(request, ctx) {
      return response(() => store.read(request, ctx));
    },
    async save(request, ctx) {
      return response(async () => {
        await store.save(request, ctx);
        await afterMutation(ctx);
      });
    },
    async forget(request, ctx) {
      return response(async () => {
        const value = await store.forget(request, ctx);
        await afterMutation(ctx);
        return value;
      });
    },
    async purgeHistory(request, ctx) {
      return response(async () => {
        await store.purgeHistory(request, ctx);
        await afterMutation(ctx);
      });
    },
    async syncIndex(ctx) {
      return response(() => syncManagedMemoryIndex(options, ctx.spaceId, ctx.signal));
    },
    async listFacts(request, ctx) {
      return response(() => store.list(request, ctx));
    },
    async correctFact(request, ctx) {
      return response(async () => {
        const value = await store.correct(request, ctx);
        await afterMutation(ctx);
        return value;
      });
    },
  };
}

/** Existing memory.sync jobs call this with their configured local index connection. */
export async function syncManagedMemoryIndex(
  options: Pick<ManagedMemoryProviderOptions, "prisma" | "index">,
  spaceId: string,
  signal: AbortSignal,
): Promise<void> {
  const store = new SemanticFactStore(options.prisma);
  await store.syncIndexWork(
    spaceId,
    async (work, workSignal) => {
      if (work.action === "upsert") {
        if (work.content === null) throw new Error("Authoritative index content is missing.");
        await options.index.upsert(
          {
            namespace: work.namespace,
            indexId: work.indexId,
            id: work.factId,
            revision: work.revision,
            content: work.content,
          },
          workSignal,
        );
      } else {
        await options.index.remove(
          { namespace: work.namespace, indexId: work.indexId },
          workSignal,
        );
      }
    },
    signal,
  );
}

async function response<T>(operation: () => Promise<T>): Promise<SemanticMemoryResponse<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof IsolationError)
      return { ok: false, error: "Memory fact not found in this scope.", code: "NOT_FOUND" };
    if (error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR)
      return { ok: false, error: error.message, code: "CONFLICT" };
    // Content, scope retirement, credentials and index failures stay visible to the caller.
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Managed memory operation failed.",
    };
  }
}
