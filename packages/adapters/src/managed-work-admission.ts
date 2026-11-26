import type { Prisma, Run } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  getManagedWorkAdmission,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";

export type ManagedRunAdmission = Pick<
  Run,
  | "id"
  | "spaceId"
  | "threadId"
  | "botId"
  | "userId"
  | "taskId"
  | "ticketId"
  | "workControlEpoch"
  | "workRequirementsVersion"
  | "leaseFence"
>;

/** Caller holds the run thread lock. Edits, stop and clear all take the ticket row lock. */
export async function managedRunRejectionInTransaction(
  tx: Prisma.TransactionClient,
  run: ManagedRunAdmission,
) {
  if (run.workControlEpoch == null || !run.ticketId) return undefined;
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${run.ticketId} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
  const admission = await getManagedWorkAdmission(tx, {
    spaceId: run.spaceId,
    ticketId: run.ticketId,
  });
  if (
    admission.admitted &&
    admission.ticket?.controlEpoch === run.workControlEpoch &&
    admission.ticket.requirementsVersion === run.workRequirementsVersion &&
    admission.ticket.assigneeBotId === run.botId
  )
    return undefined;
  return admission.reason ?? "work_version_changed";
}

export async function cancelRejectedManagedRunInTransaction(
  tx: Prisma.TransactionClient,
  run: ManagedRunAdmission,
  reason: string,
  condition?: Prisma.RunWhereInput,
) {
  const cancelled = await cancelRunsInTransaction(tx, [run], new Date(), {
    ticketId: run.ticketId,
    workControlEpoch: run.workControlEpoch,
    workRequirementsVersion: run.workRequirementsVersion,
    leaseFence: run.leaseFence,
    ...(condition ? { AND: [condition] } : {}),
  });
  if (cancelled.length === 0) return null;
  return appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    type: "run.cancelled",
    payload: { reason },
  });
}

/** Rechecks a queued work version before it can make another model or tool call. */
export async function admitManagedRun(
  deps: Pick<ExecutorDeps, "prisma" | "events">,
  run: Run,
): Promise<boolean> {
  if (run.workControlEpoch == null || !run.ticketId) return true;
  const stopped = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const reason = await managedRunRejectionInTransaction(tx, run);
    return reason
      ? cancelRejectedManagedRunInTransaction(tx, run, reason, {
          status: run.status,
          checkpoint: run.checkpoint,
        })
      : undefined;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (stopped === undefined) return true;
  if (stopped) await deps.events.notify(run.threadId, stopped.seq);
  return false;
}
