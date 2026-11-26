import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

/** Shared with chat creation so a committed assignment always has a recoverable queued run. */
export async function prepareTicketRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; ticketId: string; botId: string },
) {
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${input.ticketId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
    include: { board: { select: { ticketPrefix: true } } },
  });
  if (!ticket) return null;
  // Managed dispatches have one bot_message/WorkEvent path. A board notifier
  // must never create a second execution with the tickets tool surface.
  if (ticket.managedVersion) return null;
  const status = TicketStatusSchema.safeParse(ticket.status);
  if (!status.success || isTicketCompletedStatus(status.data)) return null;
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, userId: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) return null;
  const active = await tx.run.findFirst({
    where: {
      ticketId: ticket.id,
      botId: bot.id,
      userId: bot.userId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (active) return active;
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      prompt:
        ticket.originKey && ticketReceiptsEnabled()
          ? `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number} (id: ${ticket.id}). Read it with ticket_get and complete the requested work. Before finishing, call ticket_update with id and result to send its findings and evidence back to the original conversation. Use delivery.previousVersion from ticket_get. Mark missing evidence unknown and actual problems issue; do not claim pass without evidence. Plain final text is not a delivery. Use ask or approval cards only for input you cannot obtain yourself.`
          : `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.`,
      status: "queued",
    },
  });
  return tx.run.create({
    select: { id: true },
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      taskId: task.id,
      ticketId: ticket.id,
      trigger: "tickets",
      status: "queued",
    },
  });
}

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; ticketBoardEnabled?: boolean },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  if (!deps.ticketBoardEnabled) return;
  const run = await deps.prisma.$transaction((tx) => prepareTicketRun(tx, input));

  if (!run) return;
  await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
}
