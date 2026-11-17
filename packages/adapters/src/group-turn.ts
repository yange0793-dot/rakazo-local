import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { WORKING_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How soon a waiting member checks again whether the speakers before it have finished. */
export const GROUP_TURN_RETRY_MS = 2_000;

/**
 * A later turn created by one group send waits for the newly created turns before it, so the
 * history it reads holds their replies. Its predecessor's reply commits in the same transaction
 * that ends its run, so a working status is the only barrier. Waiting on the user does not block:
 * a question from one member must not freeze the rest of the round.
 */
export async function groupTurnBlocked(
  prisma: PrismaClient,
  run: { threadId: string; sourceMessageId: string | null; groupTurn?: number | null },
): Promise<boolean> {
  if (run.groupTurn == null || run.groupTurn <= 0 || !run.sourceMessageId) return false;
  const earlier = await prisma.run.findFirst({
    where: {
      threadId: run.threadId,
      sourceMessageId: run.sourceMessageId,
      trigger: "user",
      groupTurn: { lt: run.groupTurn },
      status: { in: [...WORKING_RUN_STATUSES] },
    },
    select: { id: true },
  });
  return Boolean(earlier);
}

/**
 * Queues this member's next check. If the enqueue fails, the durable queued run is still
 * picked up by the recovery scan, so only the immediate wake is lost.
 */
export async function retryGroupTurnLater(jobs: JobPublisher, runId: string): Promise<void> {
  await jobs
    .enqueue({
      ...runContinueJob(runId),
      availableAt: new Date(Date.now() + GROUP_TURN_RETRY_MS),
    })
    .catch((error) => getLogger().error("group turn retry enqueue", error));
}
