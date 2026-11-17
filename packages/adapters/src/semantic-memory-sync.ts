import type { JobPublisher } from "@rakazo/adapter-kit";
import { semanticMemorySyncJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant, SemanticFactStore } from "@rakazo/db";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** Drain existing transactional intent before deleting the credentials that can fulfill it. */
export async function syncSemanticMemorySpace(
  deps: { prisma: PrismaClient; memoryProviders: MemoryProviderResolver },
  spaceId: string,
): Promise<void> {
  const store = new SemanticFactStore(deps.prisma);
  const pending = await runAsSystem("find the owner of semantic memory index work", () =>
    store.pendingIndexWork(1, spaceId),
  );
  const owner = pending[0];
  if (!owner) return;
  await runAsTenant({ spaceId, userId: owner.userId }, async () => {
    const configured = await deps.memoryProviders.resolve(spaceId);
    if (!configured?.provider.syncIndex) {
      throw new Error("Reconnect local memory to finish pending index cleanup.");
    }
    const response = await configured.provider.syncIndex({
      operationId: `memory.sync:${spaceId}`,
      traceId: `memory.sync:${spaceId}`,
      spaceId,
      userId: owner.userId,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(response.error);
  });
}

/** Reuse the existing reconciler so a commit followed by a publisher failure is recoverable. */
export async function reconcileSemanticMemoryIndex(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
}): Promise<void> {
  const pending = await runAsSystem("recover pending semantic memory index work", () =>
    new SemanticFactStore(deps.prisma).pendingIndexWork(100),
  );
  await Promise.all(
    [...new Set(pending.map((work) => work.spaceId))].map((spaceId) =>
      deps.jobs.enqueue(semanticMemorySyncJob(spaceId)),
    ),
  );
}
