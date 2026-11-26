import type { ManagedWorkDependency, MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, blocksToAgentHistoryText } from "@rakazo/core";
import type { Message, Prisma, PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  appendEventInTransaction,
  cancelRunsInTransaction,
  getManagedWorkAdmission,
  ManagedWorkError,
  managedWorkOriginAvailable,
  recordManagedDependencyChangeInTransaction,
  setManagedWorkDependenciesInTransaction,
  TERMINAL_EXTERNAL_WORK_STATUSES,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { observedManagedWorkEventIds } from "./managed-work-observation.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

export interface ManagedWorkRun {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
}

export function managedWorkEnabled(deps: { ticketBoardEnabled?: boolean }): boolean {
  return deps.ticketBoardEnabled === true && ticketReceiptsEnabled();
}

export async function managedReceiptReplyTicketId(
  tx: Prisma.TransactionClient,
  run: ManagedWorkRun,
  message: Pick<Message, "role" | "authorUserId" | "threadId" | "replyToMessageId"> | null,
) {
  if (
    message?.role !== "user" ||
    message.authorUserId !== run.userId ||
    message.threadId !== run.threadId ||
    !message.replyToMessageId
  )
    return undefined;
  const receipt = await tx.message.findFirst({
    where: {
      id: message.replyToMessageId,
      threadId: run.threadId,
      role: "bot",
      botId: run.botId,
      clientNonce: { startsWith: "work-receipt:" },
    },
    select: { runId: true, clientNonce: true },
  });
  const producer = receipt?.runId
    ? await tx.run.findFirst({
        where: {
          id: receipt.runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          threadId: run.threadId,
        },
        select: { ticketId: true },
      })
    : null;
  return producer?.ticketId &&
    receipt?.clientNonce?.startsWith(`work-receipt:${producer.ticketId}:`)
    ? producer.ticketId
    : undefined;
}

export async function ensureRootManagedWorkInTransaction(
  tx: Prisma.TransactionClient,
  run: ManagedWorkRun,
  input: { brief: string; operationKey: string },
) {
  const source = await tx.run.findFirst({
    where: {
      id: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      threadId: run.threadId,
      status: "running",
      bot: { userId: run.userId, archivedAt: null },
    },
    include: { task: true, sourceMessage: true, thread: true },
  });
  if (!source) throw new ManagedWorkError("Source execution is no longer active.");
  const message = source.sourceMessage;
  const userSource =
    message?.role === "user" &&
    message.authorUserId === run.userId &&
    message.threadId === run.threadId;
  const replyTicketId =
    source.workControlEpoch === null && source.workRequirementsVersion === null
      ? await managedReceiptReplyTicketId(tx, run, message)
      : undefined;
  if (source.ticketId && replyTicketId && source.ticketId !== replyTicketId)
    throw new ManagedWorkError("This execution is bound to different work than its reply.");
  const ticketId = source.ticketId ?? replyTicketId;
  if (ticketId) {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
    const ticket = await tx.ticket.findFirst({
      where: {
        id: ticketId,
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        assigneeBotId: run.botId,
        ...(replyTicketId
          ? {
              managedVersion: { gt: 0 },
              parentTicketId: null,
              createdByBotId: run.botId,
              originThreadId: run.threadId,
            }
          : {}),
      },
    });
    if (
      !ticket ||
      ticket.stopRequestedAt ||
      (source.workControlEpoch !== null && source.workControlEpoch !== ticket.controlEpoch) ||
      (source.workRequirementsVersion !== null &&
        source.workRequirementsVersion !== ticket.requirementsVersion) ||
      !(await managedWorkOriginAvailable(tx, ticket))
    )
      throw new ManagedWorkError(
        "Work was stopped, changed, or its original request is unavailable.",
      );
    const adopted =
      ticket.managedVersion && !replyTicketId
        ? ticket
        : await tx.ticket.update({
            where: { id: ticket.id },
            data: {
              managedVersion: 1,
              ...(replyTicketId
                ? {
                    requirementsVersion: { increment: 1 },
                    acceptedRequirementsVersion: null,
                    acceptedReceiptVersion: null,
                    status: "doing",
                    completedAt: null,
                  }
                : {}),
            },
          });
    if (replyTicketId) {
      await tx.ticketComment.create({
        data: {
          spaceId: run.spaceId,
          ticketId: adopted.id,
          authorUserId: run.userId,
          body:
            blocksToAgentHistoryText(message!.blocks as MessageBlock[]) ||
            source.task.prompt ||
            input.brief,
        },
      });
      await recordManagedDependencyChangeInTransaction(tx, {
        spaceId: run.spaceId,
        ticketId: adopted.id,
        sourceRunId: run.id,
      });
    }
    await tx.run.update({
      where: { id: run.id },
      data: {
        ticketId: adopted.id,
        workControlEpoch: adopted.controlEpoch,
        workRequirementsVersion: adopted.requirementsVersion,
      },
    });
    return adopted;
  }
  const routine =
    !userSource && source.routineId
      ? await tx.routine.findFirst({
          where: {
            id: source.routineId,
            spaceId: run.spaceId,
            userId: run.userId,
            botId: run.botId,
            threadId: run.threadId,
          },
        })
      : null;
  if (
    (!userSource && !routine) ||
    source.thread.externalConversationId ||
    source.thread.userId !== run.userId
  )
    throw new ManagedWorkError(
      "Managed delegation needs a real user request, routine, or inherited work.",
    );

  await tx.board.createMany({
    data: [{ spaceId: run.spaceId, name: "Board" }],
    skipDuplicates: true,
  });
  const board = await tx.board.findUniqueOrThrow({ where: { spaceId: run.spaceId } });
  await tx.$queryRaw`SELECT id FROM boards WHERE id = ${board.id} FOR UPDATE`;
  const originKey = userSource
    ? `managed:root:${run.botId}:${message!.id}`
    : `managed:routine:${routine!.id}:${run.id}`;
  let ticket = await tx.ticket.findUnique({ where: { originKey } });
  if (
    ticket &&
    (ticket.spaceId !== run.spaceId ||
      ticket.createdByUserId !== run.userId ||
      ticket.assigneeBotId !== run.botId ||
      ticket.stopRequestedAt)
  )
    throw new ManagedWorkError("Original work is unavailable or stopped.");
  if (!ticket) {
    const brief = source.task.prompt || input.brief;
    ticket = await tx.ticket.create({
      data: {
        spaceId: run.spaceId,
        boardId: board.id,
        number: await allocateTicketNumber(tx, board.id),
        title: brief.trim().split("\n")[0]!.slice(0, 200) || "Work",
        description: brief.slice(0, 20_000),
        assigneeBotId: run.botId,
        createdByBotId: run.botId,
        createdByUserId: run.userId,
        originKey,
        originThreadId: run.threadId,
        originMessageId: userSource ? message!.id : null,
        originRoutineId: routine?.id ?? null,
        originRunId: run.id,
        originGeneration: source.thread.historyCompactionGeneration,
        managedVersion: 1,
        status: "doing",
      },
    });
  }
  await tx.run.update({
    where: { id: run.id },
    data: {
      ticketId: ticket.id,
      workControlEpoch: ticket.controlEpoch,
      workRequirementsVersion: ticket.requirementsVersion,
    },
  });
  return ticket;
}

export async function ensureManagedWorkForRun(
  deps: { prisma: PrismaClient; ticketBoardEnabled?: boolean },
  run: ManagedWorkRun,
  input: { brief: string; operationKey: string },
) {
  if (!managedWorkEnabled(deps))
    throw new ManagedWorkError("Managed work requires board and work receipts.");
  const ticket = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      return ensureRootManagedWorkInTransaction(tx, run, input);
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  return { ticketId: ticket.id, controlEpoch: ticket.controlEpoch };
}

export async function prepareManagedWorkInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    run: ManagedWorkRun;
    ownerBotId: string;
    brief: string;
    operationKey: string;
    existingTicketId?: string;
    newTask?: boolean;
    replyToId?: string;
    dependencies?: ManagedWorkDependency[];
  },
) {
  if (input.newTask && input.existingTicketId)
    throw new ManagedWorkError("Use either new_task or ticket_id, not both.");
  const parentTicket = await ensureRootManagedWorkInTransaction(tx, input.run, input);
  const owner = await tx.bot.findFirst({
    where: {
      id: input.ownerBotId,
      spaceId: input.run.spaceId,
      userId: input.run.userId,
      archivedAt: null,
    },
    select: { id: true },
  });
  if (!owner) throw new ManagedWorkError("Managed work owner is unavailable.");
  const originKey = `managed:dispatch:${input.run.spaceId}:${input.operationKey}`;
  let existingTicketId = input.existingTicketId;
  if (!input.newTask && input.replyToId) {
    const reply = await tx.message.findFirst({
      where: {
        id: input.replyToId,
        thread: { spaceId: input.run.spaceId, userId: input.run.userId, botId: owner.id },
      },
      select: { runId: true },
    });
    const repliedRun = reply?.runId
      ? await tx.run.findFirst({
          where: {
            id: reply.runId,
            spaceId: input.run.spaceId,
            userId: input.run.userId,
            botId: owner.id,
          },
          select: { ticketId: true },
        })
      : null;
    if (existingTicketId && repliedRun?.ticketId && existingTicketId !== repliedRun.ticketId)
      throw new ManagedWorkError("ticket_id and reply_to_message_id identify different work.");
    existingTicketId ??= repliedRun?.ticketId ?? undefined;
  }
  let ticket = await tx.ticket.findFirst({
    where: existingTicketId ? { id: existingTicketId, spaceId: input.run.spaceId } : { originKey },
  });
  const replaying = !existingTicketId && ticket !== null;
  if (existingTicketId && !ticket)
    throw new ManagedWorkError("Existing delegated work is unavailable.");
  if (!ticket && !input.newTask) {
    // A parent/owner pair continues its sole assignment unless the caller
    // explicitly starts separate work. Never infer identity from the brief.
    const candidates = await tx.ticket.findMany({
      where: {
        spaceId: input.run.spaceId,
        parentTicketId: parentTicket.id,
        assigneeBotId: owner.id,
        createdByUserId: input.run.userId,
        managedVersion: { gt: 0 },
      },
      take: 2,
      orderBy: { id: "asc" },
    });
    if (candidates.length > 1)
      throw new ManagedWorkError(
        `Multiple assignments belong to this owner and parent. Pass ticket_id to continue one, or new_task=true for separate work. Candidates: ${candidates.map((row) => row.id).join(", ")}.`,
      );
    ticket = candidates[0] ?? null;
  }
  if (ticket) {
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticket.id} FOR UPDATE`;
    ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    if (
      ticket.parentTicketId !== parentTicket.id ||
      ticket.assigneeBotId !== owner.id ||
      ticket.createdByUserId !== input.run.userId ||
      (ticket.stopRequestedAt && !existingTicketId)
    )
      throw new ManagedWorkError("Delegated work does not belong to this owner and parent.");
    if (!replaying) {
      const external = await tx.externalAgentExecution.findFirst({
        where: {
          spaceId: input.run.spaceId,
          ticketId: ticket.id,
          status: { notIn: TERMINAL_EXTERNAL_WORK_STATUSES },
        },
        select: { id: true },
      });
      if (external)
        throw new ManagedWorkError(
          "The previous external execution has not confirmed its terminal state.",
        );
      const active = await tx.run.findMany({
        where: { ticketId: ticket.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
      });
      const cancelled = await cancelRunsInTransaction(tx, active, new Date());
      for (const execution of cancelled)
        await appendEventInTransaction(tx, {
          spaceId: execution.spaceId,
          threadId: execution.threadId,
          botId: execution.botId,
          runId: execution.id,
          type: "run.cancelled",
          payload: { reason: "work_version_changed" },
        });
      await tx.workEvent.updateMany({
        where: {
          ticketId: ticket.id,
          kind: { in: ["dispatch", "requirements_changed"] },
          status: { in: ["pending", "prepared"] },
        },
        data: { status: "suppressed" },
      });
      await tx.ticketComment.create({
        data: {
          spaceId: input.run.spaceId,
          ticketId: ticket.id,
          authorBotId: input.run.botId,
          body: input.brief,
        },
      });
      ticket = await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          status: "todo",
          completedAt: null,
          requirementsVersion: { increment: 1 },
          acceptedRequirementsVersion: null,
          acceptedReceiptVersion: null,
          ...(ticket.stopRequestedAt
            ? {
                stopRequestedAt: null,
                controlEpoch: { increment: 1 },
              }
            : {}),
        },
      });
      await recordManagedDependencyChangeInTransaction(tx, {
        spaceId: input.run.spaceId,
        ticketId: ticket.id,
        sourceRunId: input.run.id,
      });
    }
  } else {
    ticket = await tx.ticket.create({
      data: {
        spaceId: parentTicket.spaceId,
        boardId: parentTicket.boardId,
        number: await allocateTicketNumber(tx, parentTicket.boardId),
        title: input.brief.trim().split("\n")[0]!.slice(0, 200) || "Delegated work",
        description: input.brief.slice(0, 20_000),
        assigneeBotId: owner.id,
        createdByBotId: parentTicket.createdByBotId,
        createdByUserId: parentTicket.createdByUserId,
        parentTicketId: parentTicket.id,
        managedVersion: 1,
        originKey,
        originThreadId: parentTicket.originThreadId,
        originMessageId: parentTicket.originMessageId,
        originRunId: parentTicket.originRunId,
        originRoutineId: parentTicket.originRoutineId,
        originGeneration: parentTicket.originGeneration,
      },
    });
  }
  if (input.dependencies !== undefined)
    await setManagedWorkDependenciesInTransaction(tx, {
      spaceId: input.run.spaceId,
      ticketId: ticket.id,
      dependencies: input.dependencies,
    });
  const admission = await getManagedWorkAdmission(tx, {
    spaceId: input.run.spaceId,
    ticketId: ticket.id,
  });
  return { managed: true as const, ticket, parentTicket, admission };
}

export async function getManagedCoordinationWait(
  prisma: PrismaClient,
  input: { spaceId: string; runId: string },
) {
  const empty = {
    waiting: false,
    childTicketIds: [] as string[],
    executionIds: [] as string[],
    pendingEventIds: [] as string[],
  };
  const run = await prisma.run.findFirst({ where: { id: input.runId, spaceId: input.spaceId } });
  if (!run?.ticketId) return empty;
  const ticket = await prisma.ticket.findFirst({
    where: { id: run.ticketId, spaceId: input.spaceId, managedVersion: { gt: 0 } },
  });
  if (
    !ticket?.managedVersion ||
    ticket.stopRequestedAt ||
    ticket.controlEpoch !== run.workControlEpoch ||
    !(await managedWorkOriginAvailable(prisma, ticket))
  )
    return empty;
  const children = await prisma.ticket.findMany({
    where: { parentTicketId: ticket.id, stopRequestedAt: null },
    select: { id: true },
  });
  const childIds = children.map((row) => row.id);
  const active = await prisma.run.findMany({
    where: { ticketId: { in: childIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { ticketId: true },
  });
  const executions = await prisma.externalAgentExecution.findMany({
    where: {
      spaceId: input.spaceId,
      ticketId: { in: [ticket.id, ...childIds] },
      status: { notIn: [...TERMINAL_EXTERNAL_WORK_STATUSES, "unknown", "interrupted"] },
      stopRequestedAt: null,
    },
    select: { id: true },
  });
  const events = await prisma.workEvent.findMany({
    where: {
      spaceId: input.spaceId,
      ticketId: { in: [ticket.id, ...childIds] },
      status: { in: ["pending", "prepared"] },
      OR: [{ wakeRunId: null }, { wakeRunId: { not: run.id } }],
    },
  });
  const outcomes = events.filter(
    (event) => event.ticketId === ticket.id && event.kind !== "dispatch",
  );
  const observed = await observedManagedWorkEventIds(prisma, { run, events: outcomes });
  return {
    ticketId: ticket.id,
    waiting:
      active.length > 0 ||
      executions.length > 0 ||
      events.some((event) => event.kind === "dispatch") ||
      outcomes.some((event) => !observed.has(event.id)),
    childTicketIds: [...new Set(active.flatMap((row) => (row.ticketId ? [row.ticketId] : [])))],
    executionIds: executions.map((row) => row.id),
    pendingEventIds: events.map((row) => row.id),
  };
}
