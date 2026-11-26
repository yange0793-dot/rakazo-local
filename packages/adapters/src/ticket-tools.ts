import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type {
  ManagedWorkDependency,
  MessageBlock,
  TicketFileDeliveryRequirements,
  TicketStatus,
} from "@rakazo/contracts";
import {
  CommentTicketInput,
  CreateTicketInput,
  isTicketCompletedStatus,
  TicketFileDeliveryRequirementsSchema,
  TicketStatusSchema,
  TicketWorkResult,
  UpdateTicketInput,
} from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  allocateTicketNumber,
  ensureBoard,
  findTicket,
  listTicketComments,
  ManagedWorkError,
  managedWorkOriginAvailable,
  recordManagedDependencyChangeInTransaction,
  recordWorkEventInTransaction,
  setManagedWorkDependenciesInTransaction,
  toTicketCommentDto,
  toTicketDto,
} from "@rakazo/db";
import * as z from "zod";
import { managedReceiptReplyTicketId } from "./managed-work.js";
import type { TicketChangeNotifier } from "./ticket-changes.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";
import { prepareTicketRun } from "./ticket-wake.js";

type TicketToolDeps = {
  prisma: PrismaClient;
  artifacts?: ArtifactStore;
  ticketBoardEnabled?: boolean;
  onTicketChange?: TicketChangeNotifier;
};

function ticketInputError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues
    .map(({ path, message }) => {
      const field =
        path[0] === "assigneeBotId" ? "ownerBotId" : path[0] === "ticketId" ? "id" : path.join(".");
      return field ? `${field}: ${message}` : message;
    })
    .join("; ");
}

const STATUS_ERROR = `status must be one of ${TicketStatusSchema.options.join(", ")}.`;
function coerceInputStatus(value: string) {
  const parsed = TicketStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/**
 * An assignee must be one of the acting user's own bots, as the HTTP API
 * requires through `repos.getBot`. Assigning wakes the bot, which runs as its
 * owner, so another member's bot in the same space is not a valid target.
 */
async function ownBotInSpace(
  deps: TicketToolDeps,
  input: { spaceId: string; userId: string },
  botId: string,
) {
  return Boolean(
    await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      select: { id: true },
    }),
  );
}
const LIST_TICKETS_LIMIT = 50;
const LIST_DESCRIPTION_CHARS = 200;
const ManagedReceiptArtifacts = TicketWorkResult.pick({ artifactIds: true, finalArtifactId: true })
  .required({ artifactIds: true })
  .refine((value) => !value.finalArtifactId || value.artifactIds.includes(value.finalArtifactId));

/**
 * The page key is the ticket's `createdAt` with `id` as the tiebreaker, because
 * both never change. A key on `updatedAt` would move a ticket that is edited
 * while a bot pages the board: the ticket would end up above the saved cursor
 * and no later page could return it. A stable key keeps the scan complete.
 */
function encodeTicketListCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeTicketListCursor(
  cursor: string,
): { createdAt: Date; id: string } | { error: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return { error: "cursor is invalid." };
  }
  const split = raw.indexOf("|");
  if (split <= 0) return { error: "cursor is invalid." };
  const createdAt = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return { error: "cursor is invalid." };
  return { createdAt, id };
}

function truncateDescription(value: string | null | undefined) {
  if (!value || value.length <= LIST_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, LIST_DESCRIPTION_CHARS - 1)}…`;
}

export async function listBoardTickets(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    status?: string;
    assigneeBotId?: string;
    cursor?: string;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  let status: TicketStatus | undefined;
  if (input.status !== undefined) {
    status = coerceInputStatus(input.status);
    if (!status) return { error: STATUS_ERROR };
  }
  const cursor = input.cursor?.trim();
  let pageCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const decoded = decodeTicketListCursor(cursor);
    if ("error" in decoded) return decoded;
    pageCursor = decoded;
  }
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const rows = await deps.prisma.ticket.findMany({
    where: {
      spaceId: input.spaceId,
      boardId: board.id,
      // Closed tickets are history; they only show up when asked for by status.
      ...(status ? { status } : { status: { not: "closed" } }),
      ...(input.assigneeBotId ? { assigneeBotId: input.assigneeBotId } : {}),
      ...(pageCursor
        ? {
            OR: [
              { createdAt: { lt: pageCursor.createdAt } },
              { createdAt: pageCursor.createdAt, id: { lt: pageCursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_TICKETS_LIMIT + 1,
  });
  const page = rows.slice(0, LIST_TICKETS_LIMIT);
  const next = rows.length > LIST_TICKETS_LIMIT ? page.at(-1) : undefined;
  // A list is for scanning; ticket_get returns the full description.
  return {
    tickets: page.map((row) => {
      const dto = toTicketDto(row, board.ticketPrefix);
      return { ...dto, description: truncateDescription(dto.description) };
    }),
    ...(next ? { nextCursor: encodeTicketListCursor(next) } : {}),
  };
}

export async function getTicket(deps: TicketToolDeps, input: { spaceId: string; ref: string }) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const ref = input.ref.trim();
  if (!ref) return { error: "ref is required." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const row =
    (await findTicket(deps.prisma, input.spaceId, board, { ref })) ??
    (await findTicket(deps.prisma, input.spaceId, board, { id: ref }));
  if (!row) return { error: `Ticket ${ref} not found.` };
  const comments = await listTicketComments(deps.prisma, input.spaceId, row.id);
  let receiptArtifacts: { artifactIds: string[]; finalArtifactId?: string } | undefined;
  if (row.managedVersion && row.receiptVersion > 0 && ticketReceiptsEnabled()) {
    const evidence = row.parentTicketId
      ? await deps.prisma.workEvent.findMany({
          where: {
            spaceId: input.spaceId,
            ticketId: row.parentTicketId,
            sourceTicketId: row.id,
            kind: "child_outcome",
          },
          select: { payload: true },
        })
      : [];
    for (const event of evidence) {
      const parsed = ManagedReceiptArtifacts.and(
        z.object({ receiptVersion: z.literal(row.receiptVersion) }),
      ).safeParse(event.payload);
      if (!parsed.success) continue;
      receiptArtifacts = {
        artifactIds: parsed.data.artifactIds,
        ...(parsed.data.finalArtifactId ? { finalArtifactId: parsed.data.finalArtifactId } : {}),
      };
      break;
    }
    if (
      !receiptArtifacts &&
      deps.artifacts &&
      row.originThreadId &&
      row.createdByUserId &&
      row.createdByBotId
    ) {
      const receipt = await deps.prisma.message.findFirst({
        where: {
          threadId: row.originThreadId,
          role: "bot",
          botId: row.createdByBotId,
          clientNonce: { startsWith: `work-receipt:${row.id}:${row.receiptVersion}:` },
        },
        select: { clientNonce: true },
      });
      const artifact = receipt?.clientNonce
        ? await deps.prisma.artifact.findFirst({
            where: {
              spaceId: input.spaceId,
              userId: row.createdByUserId,
              botId: row.createdByBotId,
              clientNonce: receipt.clientNonce,
              mimeType: "application/json",
            },
          })
        : null;
      if (artifact) {
        const bytes = await deps.artifacts.get(artifact.storageKey, {
          operationId: receipt!.clientNonce!,
          traceId: receipt!.clientNonce!,
          spaceId: input.spaceId,
          userId: row.createdByUserId,
          botId: row.createdByBotId,
          signal: new AbortController().signal,
        });
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.hash)
          return { error: "Saved managed receipt hash mismatch." };
        const parsed = ManagedReceiptArtifacts.and(
          z.object({
            schema: z.literal(1),
            ticketId: z.literal(row.id),
            version: z.literal(row.receiptVersion),
          }),
        ).safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        if (!parsed.success) return { error: "Saved managed receipt does not match this ticket." };
        receiptArtifacts = {
          artifactIds: parsed.data.artifactIds,
          ...(parsed.data.finalArtifactId ? { finalArtifactId: parsed.data.finalArtifactId } : {}),
        };
      }
    }
  }
  return {
    ticket: {
      ...toTicketDto(row, board.ticketPrefix),
      ...(row.managedVersion
        ? {
            managedWork: {
              ticketId: row.id,
              parentTicketId: row.parentTicketId,
              controlEpoch: row.controlEpoch,
              requirementsVersion: row.requirementsVersion,
              acceptedRequirementsVersion: row.acceptedRequirementsVersion,
              acceptedReceiptVersion: row.acceptedReceiptVersion,
              stopped: Boolean(row.stopRequestedAt),
            },
          }
        : {}),
    },
    ...(row.managedVersion
      ? {
          dependencies: await deps.prisma.ticketDependency.findMany({
            where: { spaceId: input.spaceId, ticketId: row.id },
            select: { prerequisiteTicketId: true, requirementsVersion: true, receiptVersion: true },
          }),
        }
      : {}),
    comments: comments.map(toTicketCommentDto),
    ...(row.originKey && ticketReceiptsEnabled()
      ? {
          delivery: {
            previousVersion: row.receiptVersion,
            ...receiptArtifacts,
            ...(row.fileDeliveryRequirements ? { requirements: row.fileDeliveryRequirements } : {}),
          },
        }
      : {}),
  };
}

export async function createTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    title: string;
    description?: string;
    priority?: string;
    ownerBotId?: string;
    fileDeliveryRequirements?: unknown;
    origin?: { threadId: string; messageId: string; runId: string; key: string };
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = CreateTicketInput.safeParse({
    ...input,
    assigneeBotId: input.ownerBotId ?? input.botId,
  });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;
  const origin = ticketReceiptsEnabled() ? input.origin : undefined;
  if (data.fileDeliveryRequirements && !origin)
    return { error: "File-delivery requirements need an eligible original chat receipt." };
  if (!(await ownBotInSpace(deps, input, data.assigneeBotId))) return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const result = await deps.prisma.$transaction(async (tx) => {
    if (origin) {
      await tx.$queryRaw`SELECT id FROM boards WHERE id = ${board.id} FOR UPDATE`;
      const sourceRun = await tx.run.findFirst({
        where: {
          id: origin.runId,
          spaceId: input.spaceId,
          threadId: origin.threadId,
          botId: input.botId,
          bot: { userId: input.userId, archivedAt: null },
          userId: input.userId,
          sourceMessageId: origin.messageId,
          sourceMessage: {
            threadId: origin.threadId,
            role: "user",
            authorUserId: input.userId,
          },
          thread: {
            externalConversationId: null,
            OR: [
              { botId: input.botId, bot: { userId: input.userId, archivedAt: null } },
              { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
            ],
          },
        },
        select: { ticketId: true },
      });
      if (!input.botId || !sourceRun)
        return { error: "Ticket source does not match its execution." } as const;
      const existing = await tx.ticket.findFirst({
        where: { spaceId: input.spaceId, originKey: origin.key },
      });
      if (existing) {
        if (
          existing.originRunId !== origin.runId ||
          existing.originMessageId !== origin.messageId ||
          existing.createdByBotId !== input.botId ||
          existing.createdByUserId !== input.userId
        ) {
          return { error: "Ticket creation key belongs to another request." } as const;
        }
        if (existing.assigneeBotId === input.botId) {
          if (sourceRun.ticketId && sourceRun.ticketId !== existing.id) {
            return { error: "This execution already belongs to another ticket." } as const;
          }
          await tx.run.update({ where: { id: origin.runId }, data: { ticketId: existing.id } });
        }
        return { row: existing, reused: true, preparedRunId: undefined };
      }
      if (data.assigneeBotId === input.botId && sourceRun.ticketId) {
        return {
          error: "This execution already belongs to a ticket. Update that ticket instead.",
        } as const;
      }
    }
    const number = await allocateTicketNumber(tx, board.id);
    const row = await tx.ticket.create({
      data: {
        boardId: board.id,
        spaceId: input.spaceId,
        number,
        ...(origin
          ? {
              originKey: origin.key,
              originThreadId: origin.threadId,
              originMessageId: origin.messageId,
              originRunId: origin.runId,
            }
          : {}),
        title: data.title,
        description: data.description ?? null,
        priority: data.priority,
        ...(data.fileDeliveryRequirements
          ? { fileDeliveryRequirements: data.fileDeliveryRequirements }
          : {}),
        assigneeBotId: data.assigneeBotId,
        createdByBotId: input.botId ?? null,
        createdByUserId: input.userId,
      },
    });
    if (origin && row.assigneeBotId === input.botId) {
      await tx.run.update({ where: { id: origin.runId }, data: { ticketId: row.id } });
    }
    const next =
      origin && row.assigneeBotId && row.assigneeBotId !== input.botId
        ? await prepareTicketRun(tx, {
            spaceId: input.spaceId,
            ticketId: row.id,
            botId: row.assigneeBotId,
          })
        : null;
    return { row, preparedRunId: next?.id, reused: false };
  });
  if (result.error) return { error: result.error };
  const { row, preparedRunId, reused } = result;
  if (!reused)
    await deps.onTicketChange?.({
      spaceId: input.spaceId,
      boardId: board.id,
      ticketId: row.id,
      assigneeBotId: row.assigneeBotId,
      wakeAssignee: !origin && row.assigneeBotId !== input.botId,
      preparedRunId,
    });
  return {
    ticket: toTicketDto(row, board.ticketPrefix),
    ...(origin
      ? {
          delivery: {
            previousVersion: row.receiptVersion,
            ...(row.fileDeliveryRequirements ? { requirements: row.fileDeliveryRequirements } : {}),
          },
        }
      : {}),
  };
}

export async function updateTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId: string;
    id: string;
    title?: string;
    description?: string | null;
    priority?: string | null;
    status?: string;
    ownerBotId?: string;
    runId?: string;
    threadId?: string;
    ownerAuthored?: boolean;
    expectedRequirementsVersion?: unknown;
    fileDeliveryRequirements?: unknown;
    dependencies?: ManagedWorkDependency[];
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = UpdateTicketInput.safeParse({ ...input, assigneeBotId: input.ownerBotId });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const data = parsed.data;
  if (data.fileDeliveryRequirements && !ticketReceiptsEnabled())
    return { error: "File-delivery requirements are unavailable." };
  if (data.assigneeBotId && !(await ownBotInSpace(deps, input, data.assigneeBotId)))
    return { error: "Unknown bot." };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const result = await deps.prisma
    .$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${data.id} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
      const current = await tx.ticket.findFirst({
        where: { id: data.id, spaceId: input.spaceId, boardId: board.id },
      });
      if (!current) return null;
      const resuming = Boolean(current.managedVersion && current.stopRequestedAt);
      if (resuming) {
        if (
          !ticketReceiptsEnabled() ||
          data.status !== "doing" ||
          !input.botId ||
          data.assigneeBotId !== input.botId ||
          !input.runId ||
          current.parentTicketId ||
          current.createdByUserId !== input.userId ||
          current.createdByBotId !== input.botId ||
          current.assigneeBotId !== input.botId ||
          input.threadId !== current.originThreadId
        )
          throw new ManagedWorkError(
            "Only a new request from the original owner chat can resume this root work.",
          );
        const ownerRun = await tx.run.findFirst({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            userId: input.userId,
            botId: input.botId,
            threadId: current.originThreadId!,
            status: "running",
            trigger: { in: ["user", "follow_up"] },
            createdAt: { gte: current.stopRequestedAt! },
            OR: [{ ticketId: null }, { ticketId: current.id }],
            sourceMessage: {
              threadId: current.originThreadId!,
              role: "user",
              authorUserId: input.userId,
              createdAt: { gte: current.stopRequestedAt! },
            },
          },
          select: { id: true },
        });
        if (!ownerRun || !(await managedWorkOriginAvailable(tx, current)))
          throw new ManagedWorkError("Resuming work requires a new owner message after the stop.");
      }
      if (data.dependencies !== undefined) {
        if (
          !current.managedVersion ||
          current.createdByUserId !== input.userId ||
          (input.botId &&
            input.botId !== current.assigneeBotId &&
            input.botId !== current.createdByBotId)
        )
          throw new ManagedWorkError("Only the work owner or coordinator can change dependencies.");
      }
      let requirements: TicketFileDeliveryRequirements | undefined;
      if (data.fileDeliveryRequirements) {
        if (
          !current.originKey ||
          !current.originThreadId ||
          !current.originMessageId ||
          !current.createdByBotId ||
          current.fileDeliveryRequirements == null
        ) {
          return { error: "Only tickets created with file-delivery requirements can revise them." };
        }
        if (
          current.createdByUserId !== input.userId ||
          (input.botId &&
            (!input.ownerAuthored ||
              !input.runId ||
              input.threadId !== current.originThreadId ||
              input.botId !== current.createdByBotId))
        ) {
          return {
            error: "Only the ticket creator or its original owner chat can change requirements.",
          };
        }
        const source = await tx.message.findFirst({
          where: {
            id: current.originMessageId,
            threadId: current.originThreadId,
            role: "user",
            authorUserId: input.userId,
            thread: {
              spaceId: input.spaceId,
              externalConversationId: null,
              OR: [
                {
                  botId: current.createdByBotId,
                  bot: { userId: input.userId, archivedAt: null },
                },
                {
                  group: {
                    spaceId: input.spaceId,
                    archivedAt: null,
                    members: {
                      some: {
                        botId: current.createdByBotId,
                        bot: { userId: input.userId, archivedAt: null },
                      },
                    },
                  },
                },
              ],
            },
          },
          select: { id: true },
        });
        if (!source) return { error: "Original request is unavailable." };
        if (input.botId) {
          const ownerRun = await tx.run.findFirst({
            where: {
              id: input.runId,
              spaceId: input.spaceId,
              userId: input.userId,
              botId: input.botId,
              threadId: current.originThreadId,
              OR: [{ ticketId: null }, { ticketId: current.id }],
              sourceMessage: {
                threadId: current.originThreadId,
                role: "user",
                authorUserId: input.userId,
              },
            },
            select: { id: true },
          });
          if (!ownerRun)
            return { error: "Requirements change does not match its owner execution." };
        }
        const saved = TicketFileDeliveryRequirementsSchema.safeParse(
          current.fileDeliveryRequirements,
        );
        if (!saved.success) return { error: "Saved file-delivery requirements are unavailable." };
        if (saved.data.version !== data.expectedRequirementsVersion)
          return { error: "Requirements changed. Read ticket_get before revising them." };
        requirements = {
          version: saved.data.version + 1,
          items: data.fileDeliveryRequirements.items,
        };
      }
      if (
        input.botId &&
        current.originKey &&
        ticketReceiptsEnabled() &&
        data.status &&
        isTicketCompletedStatus(data.status) &&
        data.status !== current.status
      ) {
        return {
          error: "Use ticket_update with result to deliver this work in its original chat.",
        } as const;
      }
      const continuingDependencies = Boolean(
        current.managedVersion &&
          !resuming &&
          data.dependencies !== undefined &&
          !requirements &&
          data.description === undefined &&
          input.runId &&
          input.botId === current.assigneeBotId &&
          (data.assigneeBotId === undefined || data.assigneeBotId === input.botId),
      );
      const bindingRun = Boolean(
        input.runId &&
          input.botId &&
          (data.assigneeBotId === input.botId || continuingDependencies),
      );
      let adoptingReceiptReply = false;
      if (bindingRun) {
        const run = await tx.run.findFirst({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            botId: input.botId,
            userId: input.userId,
            status: "running",
          },
          select: {
            id: true,
            spaceId: true,
            userId: true,
            botId: true,
            threadId: true,
            ticketId: true,
            workControlEpoch: true,
            workRequirementsVersion: true,
            sourceMessage: true,
          },
        });
        if (
          !run ||
          (run.ticketId && run.ticketId !== current.id) ||
          (continuingDependencies && run.ticketId !== current.id)
        ) {
          return {
            error: "This execution already belongs to another ticket or is unavailable.",
          } as const;
        }
        // Reply routing can prelink a new owner run before its managed
        // version is initialized. Only the actual receipt reply may adopt it.
        adoptingReceiptReply = Boolean(
          current.managedVersion &&
            !resuming &&
            !current.parentTicketId &&
            current.createdByUserId === input.userId &&
            current.createdByBotId === input.botId &&
            current.assigneeBotId === input.botId &&
            run.threadId === current.originThreadId &&
            run.ticketId === current.id &&
            run.workControlEpoch === null &&
            run.workRequirementsVersion === null &&
            (await managedReceiptReplyTicketId(tx, run, run.sourceMessage)) === current.id &&
            (await managedWorkOriginAvailable(tx, current)),
        );
        if (
          current.managedVersion &&
          !resuming &&
          !adoptingReceiptReply &&
          run.ticketId === current.id &&
          run.workControlEpoch !== current.controlEpoch
        )
          throw new ManagedWorkError("This execution belongs to an earlier work control epoch.");
        if (
          current.managedVersion &&
          !resuming &&
          !adoptingReceiptReply &&
          run.ticketId === current.id &&
          run.workRequirementsVersion !== current.requirementsVersion
        )
          throw new ManagedWorkError("This execution belongs to an earlier requirements version.");
        if (adoptingReceiptReply)
          await tx.ticketComment.create({
            data: {
              spaceId: input.spaceId,
              ticketId: current.id,
              authorUserId: input.userId,
              body: blocksToAgentHistoryText(run.sourceMessage!.blocks as MessageBlock[]),
            },
          });
      }
      if (data.dependencies !== undefined)
        await setManagedWorkDependenciesInTransaction(tx, {
          spaceId: input.spaceId,
          ticketId: current.id,
          dependencies: data.dependencies,
        });
      const row = await tx.ticket.update({
        where: {
          id: current.id,
          ...(requirements
            ? {
                fileDeliveryRequirements: {
                  path: ["version"],
                  equals: data.expectedRequirementsVersion,
                },
              }
            : {}),
        },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.priority !== undefined ? { priority: data.priority ?? "normal" } : {}),
          ...(data.assigneeBotId !== undefined ? { assigneeBotId: data.assigneeBotId } : {}),
          ...(data.status !== undefined
            ? {
                status: data.status,
                completedAt: isTicketCompletedStatus(data.status)
                  ? (current.completedAt ?? new Date())
                  : null,
              }
            : {}),
          ...(resuming
            ? {
                stopRequestedAt: null,
                controlEpoch: { increment: 1 },
                acceptedRequirementsVersion: null,
                acceptedReceiptVersion: null,
              }
            : {}),
          ...(requirements
            ? { fileDeliveryRequirements: requirements, status: "review", completedAt: null }
            : {}),
          ...(current.managedVersion &&
          (requirements ||
            data.description !== undefined ||
            data.dependencies !== undefined ||
            adoptingReceiptReply)
            ? {
                requirementsVersion: { increment: 1 },
                acceptedRequirementsVersion: null,
                acceptedReceiptVersion: null,
                status: adoptingReceiptReply ? "doing" : "review",
                completedAt: null,
              }
            : {}),
        },
      });
      if (bindingRun)
        await tx.run.update({
          where: { id: input.runId! },
          data: {
            ticketId: row.id,
            ...(row.managedVersion
              ? {
                  workControlEpoch: row.controlEpoch,
                  workRequirementsVersion: row.requirementsVersion,
                }
              : {}),
          },
        });
      const reassigned =
        data.assigneeBotId !== undefined && data.assigneeBotId !== current.assigneeBotId;
      if (
        row.managedVersion &&
        (requirements ||
          data.description !== undefined ||
          data.dependencies !== undefined ||
          adoptingReceiptReply)
      )
        await recordManagedDependencyChangeInTransaction(tx, {
          spaceId: row.spaceId,
          ticketId: row.id,
          sourceRunId: input.runId,
        });
      if (
        row.managedVersion &&
        data.status === "blocked" &&
        input.runId &&
        input.botId &&
        input.threadId
      ) {
        const actor = await tx.run.findFirst({
          where: {
            id: input.runId,
            spaceId: row.spaceId,
            userId: input.userId,
            botId: input.botId,
            ticketId: row.id,
            workControlEpoch: row.controlEpoch,
            workRequirementsVersion: row.requirementsVersion,
          },
          select: { id: true },
        });
        if (!actor)
          throw new ManagedWorkError("Blocking work requires its current owner execution.");
        const decision = await recordWorkEventInTransaction(tx, {
          spaceId: row.spaceId,
          userId: input.userId,
          ticketId: row.id,
          eventKey: `managed:blocked:${row.id}:${row.controlEpoch}:${input.runId}`,
          kind: "decision",
          controlEpoch: row.controlEpoch,
          targetBotId: input.botId,
          targetThreadId: input.threadId,
          sourceRunId: input.runId,
          payload: { status: "blocked", requirementsVersion: row.requirementsVersion },
        });
        await tx.workEvent.update({
          where: { id: decision.id },
          data: { status: "handled", handledAt: new Date() },
        });
      }
      if (
        row.managedVersion &&
        (reassigned ||
          requirements ||
          data.description !== undefined ||
          data.dependencies !== undefined ||
          adoptingReceiptReply)
      ) {
        const owner = row.assigneeBotId
          ? await tx.bot.findFirst({
              where: {
                id: row.assigneeBotId,
                spaceId: row.spaceId,
                userId: input.userId,
                archivedAt: null,
              },
              select: { thread: { select: { id: true } } },
            })
          : null;
        if (owner?.thread && row.assigneeBotId) {
          const event = await recordWorkEventInTransaction(tx, {
            spaceId: row.spaceId,
            userId: input.userId,
            ticketId: row.id,
            eventKey: `managed:requirements:${row.id}:${row.controlEpoch}:${row.requirementsVersion}:${row.assigneeBotId}`,
            kind: "requirements_changed",
            controlEpoch: row.controlEpoch,
            targetBotId: row.assigneeBotId,
            targetThreadId: owner.thread.id,
            sourceRunId: input.runId,
            payload: { requirementsVersion: row.requirementsVersion, reassigned },
          });
          // The authoring execution already knows this change and holds the
          // new version. A second wake would repeat the same assignment.
          if (bindingRun)
            await tx.workEvent.update({
              where: { id: event.id },
              data: { status: "handled", wakeRunId: input.runId!, handledAt: new Date() },
            });
        }
      }
      const next =
        current.originKey &&
        ticketReceiptsEnabled() &&
        (reassigned || requirements) &&
        row.assigneeBotId &&
        row.assigneeBotId !== input.botId
          ? await prepareTicketRun(tx, {
              spaceId: input.spaceId,
              ticketId: row.id,
              botId: row.assigneeBotId,
            })
          : null;
      return {
        row,
        reassigned,
        requirementsChanged: Boolean(requirements),
        preparedRunId: next?.id,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof ManagedWorkError) return { error: error.message };
      throw error;
    });
  if (!result) return { error: "Ticket not found." };
  if (result.error !== undefined) return { error: result.error };
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: result.row.id,
    assigneeBotId: result.row.assigneeBotId,
    wakeAssignee:
      (result.reassigned || result.requirementsChanged) && result.row.assigneeBotId !== input.botId,
    preparedRunId: result.preparedRunId,
  });
  return {
    ticket: toTicketDto(result.row, board.ticketPrefix),
    ...(result.requirementsChanged
      ? {
          delivery: {
            previousVersion: result.row.receiptVersion,
            requirements: result.row.fileDeliveryRequirements,
          },
        }
      : {}),
  };
}

export async function commentTicket(
  deps: TicketToolDeps,
  input: {
    spaceId: string;
    botId?: string;
    userId?: string;
    id: string;
    body: string;
  },
) {
  if (!deps.ticketBoardEnabled) return { error: "Board unavailable." };
  const parsed = CommentTicketInput.safeParse({ ticketId: input.id, body: input.body });
  if (!parsed.success) return { error: ticketInputError(parsed.error) };
  const board = await ensureBoard(deps.prisma, input.spaceId);
  const ticket = await findTicket(deps.prisma, input.spaceId, board, { id: input.id });
  if (!ticket) return { error: "Ticket not found." };
  const row = await deps.prisma.$transaction(async (tx) => {
    const comment = await tx.ticketComment.create({
      include: { authorBot: { select: { name: true } }, authorUser: { select: { name: true } } },
      data: {
        ticketId: ticket.id,
        spaceId: input.spaceId,
        authorBotId: input.botId ?? null,
        authorUserId: input.userId ?? null,
        body: parsed.data.body,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
    return comment;
  });
  await deps.onTicketChange?.({
    spaceId: input.spaceId,
    boardId: board.id,
    ticketId: ticket.id,
    assigneeBotId: ticket.assigneeBotId,
    wakeAssignee: false,
  });
  return { comment: toTicketCommentDto(row) };
}
