import type { ManagedWorkDependency } from "@rakazo/contracts";
import { ManagedWorkDependencySchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, Ticket } from "./client.js";

export const TERMINAL_EXTERNAL_WORK_STATUSES = ["completed", "failed", "cancelled", "stopped"];

export class ManagedWorkError extends Error {}

/** The original chat can stop work after its conversational Run has already finished. */
export async function threadHasManagedWork(
  tx: Pick<Prisma.TransactionClient, "ticket" | "externalAgentExecution">,
  input: { spaceId: string; userId: string; threadId: string },
): Promise<boolean> {
  const tickets = await tx.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      createdByUserId: input.userId,
      originThreadId: input.threadId,
      managedVersion: { gt: 0 },
      stopRequestedAt: null,
    },
    select: {
      id: true,
      status: true,
      requirementsVersion: true,
      receiptVersion: true,
      acceptedRequirementsVersion: true,
      acceptedReceiptVersion: true,
    },
  });
  if (
    tickets.some(
      (ticket) =>
        ticket.status !== "done" ||
        ticket.acceptedRequirementsVersion !== ticket.requirementsVersion ||
        ticket.acceptedReceiptVersion !== ticket.receiptVersion,
    )
  )
    return true;
  if (!tickets.length) return false;
  return Boolean(
    await tx.externalAgentExecution.findFirst({
      where: {
        spaceId: input.spaceId,
        userId: input.userId,
        ticketId: { in: tickets.map((ticket) => ticket.id) },
        stopRequestedAt: null,
        status: { notIn: TERMINAL_EXTERNAL_WORK_STATUSES },
      },
      select: { id: true },
    }),
  );
}

export async function getManagedWorkCompletionBlockers(
  tx: Pick<Prisma.TransactionClient, "ticket" | "externalAgentExecution">,
  input: { spaceId: string; ticketId: string },
) {
  const children = await tx.ticket.findMany({
    where: { parentTicketId: input.ticketId, spaceId: input.spaceId, managedVersion: { gt: 0 } },
    select: {
      id: true,
      stopRequestedAt: true,
      requirementsVersion: true,
      acceptedRequirementsVersion: true,
      acceptedReceiptVersion: true,
    },
  });
  const executions = await tx.externalAgentExecution.findMany({
    where: {
      ticketId: input.ticketId,
      spaceId: input.spaceId,
      status: { notIn: TERMINAL_EXTERNAL_WORK_STATUSES },
    },
    select: { id: true },
  });
  return {
    ticketIds: children
      .filter(
        (child) =>
          child.stopRequestedAt !== null ||
          child.acceptedRequirementsVersion !== child.requirementsVersion ||
          child.acceptedReceiptVersion === null,
      )
      .map((child) => child.id),
    executionIds: executions.map((row) => row.id),
  };
}

/** Validates the saved origin, never a caller-provided ancestor message. */
export async function managedWorkOriginAvailable(
  tx: Pick<Prisma.TransactionClient, "thread" | "message" | "routine">,
  ticket: Pick<
    Ticket,
    | "spaceId"
    | "createdByUserId"
    | "originThreadId"
    | "originMessageId"
    | "originRoutineId"
    | "originGeneration"
  >,
): Promise<boolean> {
  if (!ticket.originThreadId || !ticket.createdByUserId) return false;
  const thread = await tx.thread.findFirst({
    where: {
      id: ticket.originThreadId,
      spaceId: ticket.spaceId,
      userId: ticket.createdByUserId,
      externalConversationId: null,
    },
    select: { historyCompactionGeneration: true },
  });
  if (
    !thread ||
    (ticket.originGeneration !== null &&
      ticket.originGeneration !== thread.historyCompactionGeneration)
  )
    return false;
  if (ticket.originMessageId) {
    return Boolean(
      await tx.message.findFirst({
        where: {
          id: ticket.originMessageId,
          threadId: ticket.originThreadId,
          role: "user",
          authorUserId: ticket.createdByUserId,
        },
        select: { id: true },
      }),
    );
  }
  if (!ticket.originRoutineId) return false;
  return Boolean(
    await tx.routine.findFirst({
      where: {
        id: ticket.originRoutineId,
        spaceId: ticket.spaceId,
        userId: ticket.createdByUserId,
        threadId: ticket.originThreadId,
      },
      select: { id: true },
    }),
  );
}

export async function getManagedWorkAdmission(
  tx: Pick<
    Prisma.TransactionClient,
    "ticket" | "ticketDependency" | "thread" | "message" | "routine"
  >,
  input: { spaceId: string; ticketId: string },
) {
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId },
  });
  const unmetDependencies: Array<{
    ticketId: string;
    requirementsVersion: number;
    receiptVersion: number | null;
    reason: string;
  }> = [];
  if (!ticket) return { admitted: false, reason: "unavailable", ticket, unmetDependencies };
  if (!ticket.managedVersion) return { admitted: true, ticket, unmetDependencies };
  if (ticket.stopRequestedAt)
    return { admitted: false, reason: "stopped", ticket, unmetDependencies };
  if (!(await managedWorkOriginAvailable(tx, ticket)))
    return { admitted: false, reason: "source_unavailable", ticket, unmetDependencies };
  const dependencies = await tx.ticketDependency.findMany({
    where: { spaceId: input.spaceId, ticketId: ticket.id },
    include: { prerequisiteTicket: true },
  });
  for (const edge of dependencies) {
    const prerequisite = edge.prerequisiteTicket;
    const reason = prerequisite.stopRequestedAt
      ? "prerequisite_stopped"
      : prerequisite.requirementsVersion !== edge.requirementsVersion
        ? "requirements_changed"
        : prerequisite.acceptedRequirementsVersion !== edge.requirementsVersion ||
            prerequisite.acceptedReceiptVersion === null ||
            (edge.receiptVersion !== null &&
              prerequisite.acceptedReceiptVersion !== edge.receiptVersion)
          ? "not_accepted"
          : undefined;
    if (reason)
      unmetDependencies.push({
        ticketId: edge.prerequisiteTicketId,
        requirementsVersion: edge.requirementsVersion,
        receiptVersion: edge.receiptVersion,
        reason,
      });
  }
  return {
    admitted: unmetDependencies.length === 0,
    ...(unmetDependencies.length ? { reason: "dependencies" } : {}),
    ticket,
    unmetDependencies,
  };
}

/** Board lock serializes edits to the dependency graph, including concurrent opposite edges. */
export async function setManagedWorkDependenciesInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string; dependencies: ManagedWorkDependency[] },
) {
  const dependencies = input.dependencies.map((edge) => ManagedWorkDependencySchema.parse(edge));
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId, managedVersion: { gt: 0 } },
    select: { boardId: true, stopRequestedAt: true },
  });
  if (!ticket || ticket.stopRequestedAt)
    throw new ManagedWorkError("Work is unavailable or stopped.");
  await tx.$queryRaw`SELECT id FROM boards WHERE id = ${ticket.boardId} FOR UPDATE`;
  const ids = dependencies.map((edge) => edge.ticketId);
  if (new Set(ids).size !== ids.length || ids.includes(input.ticketId))
    throw new ManagedWorkError("Dependencies must be distinct other tickets.");
  const prerequisites = await tx.ticket.findMany({
    where: {
      id: { in: ids },
      spaceId: input.spaceId,
      boardId: ticket.boardId,
      managedVersion: { gt: 0 },
    },
  });
  for (const edge of dependencies) {
    const prerequisite = prerequisites.find((row) => row.id === edge.ticketId);
    if (
      !prerequisite ||
      prerequisite.stopRequestedAt ||
      prerequisite.requirementsVersion !== edge.requirementsVersion
    )
      throw new ManagedWorkError("Dependency is unavailable or its requirements version changed.");
  }
  const edges = await tx.ticketDependency.findMany({
    where: { spaceId: input.spaceId, ticketId: { not: input.ticketId } },
    select: { ticketId: true, prerequisiteTicketId: true },
  });
  const reachable = new Set(ids);
  const frontier = [...ids];
  while (frontier.length) {
    const id = frontier.pop()!;
    if (id === input.ticketId) throw new ManagedWorkError("Dependencies would create a cycle.");
    for (const edge of edges) {
      if (edge.ticketId !== id || reachable.has(edge.prerequisiteTicketId)) continue;
      reachable.add(edge.prerequisiteTicketId);
      frontier.push(edge.prerequisiteTicketId);
    }
  }
  await tx.ticketDependency.deleteMany({
    where: { spaceId: input.spaceId, ticketId: input.ticketId },
  });
  if (dependencies.length)
    await tx.ticketDependency.createMany({
      data: dependencies.map((edge) => ({
        spaceId: input.spaceId,
        ticketId: input.ticketId,
        prerequisiteTicketId: edge.ticketId,
        requirementsVersion: edge.requirementsVersion,
        receiptVersion: edge.receiptVersion ?? null,
      })),
    });
}

export interface RecordWorkEventInput {
  spaceId: string;
  userId: string;
  ticketId: string;
  eventKey: string;
  kind: string;
  controlEpoch: number;
  targetBotId: string;
  targetThreadId: string;
  sourceTicketId?: string;
  sourceRunId?: string;
  payload?: Prisma.InputJsonValue;
}

export async function recordWorkEventInTransaction(
  tx: Prisma.TransactionClient,
  input: RecordWorkEventInput,
) {
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId, createdByUserId: input.userId },
  });
  if (!ticket?.managedVersion) throw new ManagedWorkError("Managed work is unavailable.");
  const suppressed = ticket.stopRequestedAt !== null || ticket.controlEpoch !== input.controlEpoch;
  const { payload, ...event } = input;
  await tx.workEvent.createMany({
    data: [
      {
        ...event,
        ...(suppressed ? {} : { payload }),
        status: suppressed ? "suppressed" : "pending",
      },
    ],
    skipDuplicates: true,
  });
  const saved = await tx.workEvent.findUniqueOrThrow({ where: { eventKey: input.eventKey } });
  if (
    saved.spaceId !== input.spaceId ||
    saved.userId !== input.userId ||
    saved.ticketId !== input.ticketId ||
    saved.controlEpoch !== input.controlEpoch ||
    saved.kind !== input.kind ||
    saved.targetBotId !== input.targetBotId ||
    saved.targetThreadId !== input.targetThreadId
  )
    throw new ManagedWorkError("Work event key belongs to another obligation.");
  return saved;
}

/** A changed prerequisite needs a coordinator decision, not an infinite old-version wait. */
export async function recordManagedDependencyChangeInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string; sourceRunId?: string },
) {
  const source = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId, managedVersion: { gt: 0 } },
  });
  if (!source) return [];
  const edges = await tx.ticketDependency.findMany({
    where: { spaceId: input.spaceId, prerequisiteTicketId: source.id },
    include: { ticket: true },
  });
  const events = [];
  for (const edge of edges) {
    if (
      edge.requirementsVersion === source.requirementsVersion &&
      (edge.receiptVersion === null || edge.receiptVersion === source.acceptedReceiptVersion)
    )
      continue;
    const coordinator = await tx.ticket.findFirst({
      where: {
        id: edge.ticket.parentTicketId ?? edge.ticket.id,
        spaceId: input.spaceId,
        stopRequestedAt: null,
      },
      include: { assigneeBot: { select: { thread: { select: { id: true } } } } },
    });
    if (
      !coordinator?.assigneeBotId ||
      !coordinator.createdByUserId ||
      !coordinator.assigneeBot?.thread
    )
      continue;
    events.push(
      await recordWorkEventInTransaction(tx, {
        spaceId: input.spaceId,
        userId: coordinator.createdByUserId,
        ticketId: coordinator.id,
        eventKey: `managed:dependency:${edge.ticketId}:${source.id}:${source.requirementsVersion}:${source.acceptedReceiptVersion ?? 0}:${coordinator.controlEpoch}`,
        kind: "dependency_changed",
        controlEpoch: coordinator.controlEpoch,
        targetBotId: coordinator.assigneeBotId,
        targetThreadId: coordinator.assigneeBot.thread.id,
        sourceTicketId: source.id,
        sourceRunId: input.sourceRunId,
        payload: {
          dependentTicketId: edge.ticketId,
          prerequisiteTicketId: source.id,
          expectedRequirementsVersion: edge.requirementsVersion,
          actualRequirementsVersion: source.requirementsVersion,
          expectedReceiptVersion: edge.receiptVersion,
          actualReceiptVersion: source.acceptedReceiptVersion,
        },
      }),
    );
  }
  return events;
}

export function listPendingWorkEvents(
  prisma: Pick<PrismaClient, "workEvent">,
  input: { spaceId?: string; take?: number } = {},
) {
  return prisma.workEvent.findMany({
    where: {
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      status: { in: ["pending", "prepared"] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...(input.take === undefined ? {} : { take: input.take }),
  });
}

/** The caller supplies an actual action/wait/block/delivery decision, not Run.completed. */
export async function markWorkEventHandledInTransaction(
  tx: Prisma.TransactionClient,
  input: { eventId: string; wakeRunId: string; controlEpoch: number },
) {
  const event = await tx.workEvent.findFirst({
    where: { id: input.eventId, wakeRunId: input.wakeRunId, controlEpoch: input.controlEpoch },
    include: { ticket: true },
  });
  if (!event || event.ticket.stopRequestedAt || event.ticket.controlEpoch !== input.controlEpoch)
    return false;
  const changed = await tx.workEvent.updateMany({
    where: {
      id: event.id,
      wakeRunId: input.wakeRunId,
      status: "prepared",
      controlEpoch: input.controlEpoch,
    },
    data: { status: "handled", handledAt: new Date() },
  });
  return changed.count === 1;
}

export async function requestManagedWorkStopInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string; threadId?: string; ticketId?: string },
) {
  if (!input.threadId && !input.ticketId)
    throw new ManagedWorkError("Stopping work requires a thread or ticket.");
  const roots = await tx.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      createdByUserId: input.userId,
      managedVersion: { gt: 0 },
      ...(input.ticketId ? { id: input.ticketId } : { originThreadId: input.threadId }),
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const ticketIds = new Set(roots.map((row) => row.id));
  // Every dispatch locks its parent, so children committed before this lock are
  // discovered below, and a later dispatch observes the stop intent.
  for (const { id } of roots)
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
  let frontier = [...ticketIds];
  while (frontier.length) {
    const children = await tx.ticket.findMany({
      where: {
        spaceId: input.spaceId,
        createdByUserId: input.userId,
        parentTicketId: { in: frontier },
        id: { notIn: [...ticketIds] },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    frontier = children.map((row) => row.id);
    for (const id of frontier) {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
      ticketIds.add(id);
    }
  }
  const ids = [...ticketIds];
  const now = new Date();
  await tx.ticket.updateMany({
    where: { id: { in: ids }, stopRequestedAt: null },
    data: { stopRequestedAt: now, controlEpoch: { increment: 1 } },
  });
  await tx.workEvent.updateMany({
    where: {
      spaceId: input.spaceId,
      ticketId: { in: ids },
      status: { in: ["pending", "prepared", "failed"] },
    },
    data: { status: "suppressed" },
  });
  const runs = await tx.run.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      ticketId: { in: ids },
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  const executions = await tx.externalAgentExecution.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      OR: [{ ticketId: { in: ids } }, ...(input.threadId ? [{ threadId: input.threadId }] : [])],
      status: { notIn: TERMINAL_EXTERNAL_WORK_STATUSES },
    },
    select: { id: true },
  });
  await tx.externalAgentExecution.updateMany({
    where: { id: { in: executions.map((row) => row.id) }, stopRequestedAt: null },
    data: { stopRequestedAt: now },
  });
  return {
    ticketIds: ids,
    runIds: runs.map((row) => row.id),
    executionIds: executions.map((row) => row.id),
  };
}
