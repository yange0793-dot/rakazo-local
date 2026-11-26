import { createHash } from "node:crypto";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { BotMessageIntent, ManagedWorkDependency, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MESSAGE_MAX_LENGTH,
  BOT_MESSAGE_TOO_LONG,
  botMessageContext,
  botMessageHopExhausted,
  buildBotMessageWakePrompt,
  clampBotMessage,
  nextBotMessageHop,
  resolveBotAddress,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  ManagedWorkError,
  recordWorkEventInTransaction,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { managedWorkEnabled, prepareManagedWorkInTransaction } from "./managed-work.js";
import {
  managedWorkInputAttachmentsInTransaction,
  reconcileManagedWorkEvents,
  recordManagedChildOutcomeInTransaction,
} from "./managed-work-events.js";
import { runLeaseFor } from "./run-messages.js";

/**
 * The hop the current run sits at, read back from the message that woke this
 * bot. A run a person started carries no bot message, so it starts at 0.
 */
export async function currentBotMessageHop(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
): Promise<number> {
  if (!sourceMessageId) return 0;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true },
  });
  const blocks = Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [];
  return botMessageContext(blocks)?.hop ?? 0;
}

export async function loadBotMessageContext(
  prisma: PrismaClient,
  sourceMessageId: string | null | undefined,
) {
  if (!sourceMessageId) return undefined;
  const source = await prisma.message.findUnique({
    where: { id: sourceMessageId },
    select: { blocks: true, replyTo: { select: { blocks: true } } },
  });
  const context = botMessageContext(
    Array.isArray(source?.blocks) ? (source.blocks as MessageBlock[]) : [],
  );
  if (!context) return undefined;
  const replyBlocks = Array.isArray(source?.replyTo?.blocks)
    ? (source.replyTo.blocks as MessageBlock[])
    : [];
  const repliesToRequest =
    (context.intent === "result" || context.intent === "status" || context.intent === "fyi") &&
    replyBlocks.some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === context.fromBotId &&
        (block.intent === undefined || block.intent === "request" || block.intent === "question"),
    );
  return { ...context, repliesToRequest };
}

export async function messageBot(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease" | "ticketBoardEnabled">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  input: {
    bot_id?: string;
    confirm_name?: string;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey?: string;
    ticket_id?: string;
    new_task?: boolean;
    dependencies?: ManagedWorkDependency[];
    /** A message in the recipient's chat this one answers, so it arrives as a reply. */
    replyToId?: string;
    /** Attachments filed under the recipient's chat, shown there and copied to its computer. */
    files?: Array<Extract<MessageBlock, { kind: "image" | "file" }>>;
  },
  options?: { allowTerminalSource?: boolean; forceUnread?: boolean },
) {
  const message = String(input.message ?? "").trim();
  if (!message) return { ok: false as const, error: "message is required" };
  if (message.length > BOT_MESSAGE_MAX_LENGTH) {
    return { ok: false as const, error: BOT_MESSAGE_TOO_LONG };
  }

  const sourceContext = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  const intent = input.intent ?? "request";
  if (input.new_task !== undefined && typeof input.new_task !== "boolean")
    return { ok: false as const, error: "new_task must be a boolean" };
  if (input.new_task && (intent !== "request" || input.ticket_id))
    return {
      ok: false as const,
      error: "new_task requires a request without ticket_id",
    };
  const supplemental = intent === "fyi" || intent === "status";
  const managedIntent = intent === "request" || supplemental;
  if (input.ticket_id && !managedIntent)
    return {
      ok: false as const,
      error:
        "ticket_id continues delegated work with request, fyi, or status. Return current work with result without ticket_id.",
    };
  const hop = nextBotMessageHop(sourceContext?.hop);

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: input.bot_id,
    name: input.confirm_name,
  });
  if (!target) return { ok: false as const, error: "no bot found with that id or name" };
  if (target.id === sender.id) return { ok: false as const, error: "a bot cannot message itself" };
  if (!target.thread)
    return { ok: false as const, error: `${target.name} has no chat to deliver to` };
  const returnsToSender =
    options?.allowTerminalSource === true &&
    (intent === "result" || intent === "status") &&
    (sourceContext?.intent === undefined ||
      sourceContext.intent === "request" ||
      sourceContext.intent === "question") &&
    sourceContext?.fromBotId === target.id;
  if (botMessageHopExhausted(hop) && !returnsToSender) {
    return {
      ok: false as const,
      error:
        "bot-to-bot message limit reached for this chain; report back to the user instead of messaging another bot",
    };
  }

  const targetThreadId = target.thread.id;

  // A tool call can be re-executed after a lease expiry, so a delivery has to be
  // replayable: without this the recipient is messaged twice and woken twice.
  const enableManaged = managedWorkEnabled(deps);
  const operationKey =
    input.deliveryKey ??
    (enableManaged && managedIntent
      ? `${run.id}:${target.id}:${createHash("sha256").update(message).digest("hex")}`
      : undefined);
  const deliveryKey = operationKey ? `bot-message:${operationKey}` : undefined;
  const replayed = async (messageId: string) => {
    const dispatch =
      enableManaged && managedIntent && operationKey
        ? await deps.prisma.workEvent.findFirst({
            where: {
              eventKey: `managed:dispatch:${deliveryKey}`,
              spaceId: run.spaceId,
              userId: run.userId,
              targetBotId: target.id,
              kind: "dispatch",
            },
            select: { ticket: { select: { id: true, managedVersion: true } } },
          })
        : null;
    const ticket = dispatch?.ticket;
    if (input.ticket_id && ticket?.id !== input.ticket_id)
      return {
        ok: false as const,
        error: "This delivery key is already bound to different work.",
      };
    return {
      ok: true as const,
      status: "duplicate" as const,
      botId: target.id,
      name: target.name,
      messageId,
      delivered: message,
      replayed: true as const,
      managed: Boolean(ticket?.managedVersion),
      ...(ticket?.managedVersion ? { ticketId: ticket.id } : {}),
      note: `Already sent to ${target.name} in this turn; it was not sent again.`,
    } as const;
  };

  const wakePrompt = buildBotMessageWakePrompt({ from: sender, text: message, intent });
  const outboundBlock: MessageBlock = {
    kind: "bot_message_sent",
    toBotId: target.id,
    toBotName: target.name,
    text: message,
    intent,
  };
  const files = input.files ?? [];

  let committed:
    | {
        ok: true;
        messageId: string;
        runId?: string;
        ticketId?: string;
        managed?: boolean;
        waiting?: boolean;
        targetEventSeq: number;
        senderEventSeq: number;
      }
    | {
        ok: false;
        error: string;
      }
    | {
        ok: true;
        replayed: true;
        messageId: string;
      }
    | {
        ok: true;
        recorded: true;
        eventId: string;
        ticketId: string;
      };
  try {
    committed = await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx) => {
        if (!(await spaceTakesWork(tx, run.spaceId)))
          return { ok: false as const, error: "this Space is being deleted" };
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        // Claim the delivery key inside the transaction so a concurrent retry
        // either sees the winner or loses on the unique (threadId, clientNonce).
        if (deliveryKey) {
          const already = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
            select: { id: true },
          });
          if (already) return { ok: true as const, replayed: true as const, messageId: already.id };
        }

        const senderStillRunning = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: options?.allowTerminalSource
              ? { in: ["completed", "failed", "cancelled"] }
              : "running",
          },
          select: { id: true, ticketId: true, workControlEpoch: true },
        });
        if (!senderStillRunning)
          return { ok: false as const, error: "source run is no longer active" };

        // Re-read the target inside the transaction: it can be archived between
        // resolving it above and committing here.
        const stillAddressable = await tx.bot.findFirst({
          where: {
            id: target.id,
            spaceId: run.spaceId,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!stillAddressable)
          return { ok: false as const, error: `${target.name} is no longer available` };

        // An explicit reply must point at something the recipient can see in its own chat.
        // Validate before the sender echo is written; returning from this callback commits.
        const explicitReplyTo = input.replyToId
          ? await tx.message.findFirst({
              where: { id: input.replyToId, threadId: targetThreadId },
              select: { id: true },
            })
          : undefined;
        if (input.replyToId && !explicitReplyTo)
          return {
            ok: false as const,
            error: `reply_to_message_id does not name a message in ${target.name}'s chat`,
          };

        const existingWork = senderStillRunning.ticketId
          ? await tx.ticket.findFirst({
              where: { id: senderStillRunning.ticketId, spaceId: run.spaceId },
              select: {
                managedVersion: true,
                stopRequestedAt: true,
                controlEpoch: true,
                parentTicketId: true,
              },
            })
          : null;
        if (
          existingWork?.managedVersion &&
          (existingWork.stopRequestedAt ||
            (senderStillRunning.workControlEpoch !== null &&
              senderStillRunning.workControlEpoch !== existingWork.controlEpoch))
        )
          return { ok: false as const, error: "This work was stopped or superseded." };
        if (
          managedIntent &&
          !enableManaged &&
          (existingWork?.managedVersion ||
            input.ticket_id ||
            input.new_task ||
            input.dependencies?.length)
        )
          return { ok: false as const, error: "Managed work requires board and work receipts." };
        let supplementalTicketId: string | undefined;
        if (enableManaged && supplemental && (input.ticket_id || existingWork?.managedVersion)) {
          if (!senderStillRunning.ticketId || !existingWork?.managedVersion)
            return {
              ok: false as const,
              error:
                "Bind this execution to the original parent ticket before continuing its work.",
            };
          await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${senderStillRunning.ticketId} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
          const assignments = await tx.ticket.findMany({
            where: {
              spaceId: run.spaceId,
              parentTicketId: senderStillRunning.ticketId,
              assigneeBotId: target.id,
              createdByUserId: run.userId,
              managedVersion: { gt: 0 },
            },
            orderBy: { id: "asc" },
            take: 2,
          });
          const candidateIds = assignments.map((assignment) => assignment.id).join(", ");
          if (input.ticket_id) {
            const assignment = await tx.ticket.findFirst({
              where: {
                id: input.ticket_id,
                spaceId: run.spaceId,
                parentTicketId: senderStillRunning.ticketId,
                assigneeBotId: target.id,
                createdByUserId: run.userId,
                managedVersion: { gt: 0 },
              },
              select: { id: true },
            });
            if (!assignment)
              return {
                ok: false as const,
                error: `ticket_id must name this recipient's delegated child, not the parent or another assignment. Candidates: ${candidateIds || "none"}.`,
              };
            supplementalTicketId = assignment.id;
          } else if (assignments.length > 1) {
            return {
              ok: false as const,
              error: `Multiple assignments belong to this owner and parent. Pass ticket_id. Candidates: ${candidateIds}.`,
            };
          } else {
            if (assignments[0]?.stopRequestedAt)
              return {
                ok: false as const,
                error:
                  "The original assignment was stopped. Pass ticket_id to resume it explicitly.",
              };
            supplementalTicketId = assignments[0]?.id;
          }
        }
        let replyTicket: { id: string; controlEpoch: number; requirementsVersion: number } | null =
          null;
        if (existingWork?.managedVersion && existingWork.parentTicketId) {
          replyTicket = await tx.ticket.findFirst({
            where: {
              id: existingWork.parentTicketId,
              spaceId: run.spaceId,
              assigneeBotId: target.id,
              stopRequestedAt: null,
            },
            select: { id: true, controlEpoch: true, requirementsVersion: true },
          });
          if (replyTicket && intent === "result") {
            const event = await recordManagedChildOutcomeInTransaction(tx, {
              spaceId: run.spaceId,
              runId: run.id,
              ticketId: senderStillRunning.ticketId!,
              payload: { text: message, intent },
            });
            if (!event)
              return {
                ok: false as const,
                error: "The original work can no longer receive this result.",
              };
            return {
              ok: true as const,
              recorded: true as const,
              eventId: event.id,
              ticketId: replyTicket.id,
            };
          }
        }
        const replyToMessageId =
          explicitReplyTo?.id ??
          (sourceContext?.fromBotId === target.id && intent !== "fyi"
            ? sourceContext.returnToMessageId
            : undefined);
        const managed =
          enableManaged && (intent === "request" || supplementalTicketId)
            ? await prepareManagedWorkInTransaction(tx, {
                run,
                ownerBotId: target.id,
                brief: message,
                operationKey: operationKey!,
                existingTicketId: input.ticket_id ?? supplementalTicketId,
                newTask: input.new_task,
                replyToId: replyToMessageId,
                dependencies: input.dependencies,
              })
            : undefined;
        // Echo into the sender's chat in the same transaction so a failed notify
        // cannot leave one side delivered and the other blank.
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [outboundBlock],
          botId: run.botId,
          runId: run.id,
          markUnread: options?.forceUnread === true,
          allowCancelledRun: options?.allowTerminalSource === true,
          lease: runLeaseFor(deps, run.id),
        });
        const inboundBlock: MessageBlock = {
          kind: "bot_message_received",
          fromBotId: sender.id,
          fromBotName: sender.name,
          text: message,
          hop,
          intent,
          returnToMessageId: outbound.id,
        };
        const dependencyFiles = managed
          ? await managedWorkInputAttachmentsInTransaction(tx, managed.ticket)
          : [];
        const sentFileIds = new Set(
          files.flatMap((file) =>
            file.kind === "file" || file.kind === "image" ? [file.artifactId] : [],
          ),
        );
        const inboundBlocks: MessageBlock[] = [
          inboundBlock,
          ...files,
          ...dependencyFiles.filter((file) => !sentFileIds.has(file.artifactId)),
        ];
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "user",
          blocks: inboundBlocks,
          replyToMessageId,
          clientNonce: deliveryKey,
          markUnread: options?.forceUnread === true,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: target.id,
            threadId: targetThreadId,
            userId: run.userId,
            // The reply tool addresses the original sender's chat, so use the echo there,
            // not the delivery message in the recipient's own chat.
            prompt: `${wakePrompt}\n\nTo answer this sender directly, pass reply_to_message_id "${outbound.id}".${
              managed
                ? `\n\nThis is managed ticket ${managed.ticket.id} (parent ${managed.parentTicket.id}). Read ticket_get. Deliver findings and actual artifacts with ticket_update result using its delivery.previousVersion. A final text alone is not a work receipt.`
                : ""
            }`,
            status: "queued",
          },
        });
        const nextRun =
          managed && !managed.admission.admitted
            ? null
            : await tx.run.create({
                data: {
                  spaceId: run.spaceId,
                  botId: target.id,
                  threadId: targetThreadId,
                  taskId: task.id,
                  userId: run.userId,
                  status: "queued",
                  trigger: "bot_message",
                  sourceMessageId: inbound.id,
                  ...(managed
                    ? {
                        ticketId: managed.ticket.id,
                        workControlEpoch: managed.ticket.controlEpoch,
                        workRequirementsVersion: managed.ticket.requirementsVersion,
                      }
                    : replyTicket && intent !== "request"
                      ? {
                          ticketId: replyTicket.id,
                          workControlEpoch: replyTicket.controlEpoch,
                          workRequirementsVersion: replyTicket.requirementsVersion,
                        }
                      : {}),
                },
                select: { id: true },
              });
        if (nextRun)
          await tx.message.update({ where: { id: inbound.id }, data: { runId: nextRun.id } });
        if (managed) {
          const obligation = await recordWorkEventInTransaction(tx, {
            spaceId: run.spaceId,
            userId: run.userId,
            ticketId: managed.ticket.id,
            eventKey: `managed:dispatch:${deliveryKey}`,
            kind: "dispatch",
            controlEpoch: managed.ticket.controlEpoch,
            targetBotId: target.id,
            targetThreadId,
            sourceTicketId: managed.parentTicket.id,
            sourceRunId: run.id,
            payload: { taskId: task.id, messageId: inbound.id },
          });
          if (nextRun)
            await tx.workEvent.update({
              where: { id: obligation.id },
              data: { status: "handled", wakeRunId: nextRun.id, handledAt: new Date() },
            });
        }
        const inboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: target.id,
          type: "thread.message.created",
          runId: nextRun?.id,
          payload: { messageId: inbound.id, role: "user", blocks: inboundBlocks },
        });
        const outboundEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          allowCancelledRun: options?.allowTerminalSource === true,
          lease: runLeaseFor(deps, run.id),
          payload: { messageId: outbound.id, role: "bot", blocks: [outboundBlock] },
        });
        return {
          ok: true as const,
          messageId: inbound.id,
          runId: nextRun?.id,
          ...(managed
            ? {
                managed: true,
                ticketId: managed.ticket.id,
                waiting: !nextRun,
              }
            : { managed: false }),
          targetEventSeq: inboundEvent.seq,
          senderEventSeq: outboundEvent.seq,
        };
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    if (error instanceof ManagedWorkError) return { ok: false as const, error: error.message };
    // Two concurrent retries can both miss the in-transaction lookup; the
    // loser hits the unique key. Treat that as a successful replay.
    if (deliveryKey && isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return replayed(winner.id);
    }
    throw error;
  }
  if ("replayed" in committed) return replayed(committed.messageId);
  if (!committed.ok) return committed;
  if ("recorded" in committed) {
    await reconcileManagedWorkEvents(deps, { spaceId: run.spaceId });
    return {
      ok: true as const,
      status: "recorded" as const,
      botId: target.id,
      name: target.name,
      messageId: run.sourceMessageId ?? "",
      eventId: committed.eventId,
      ticketId: committed.ticketId,
      managed: true,
      delivered: message,
      note: "Result recorded against the original work; its owner will continue after this execution finishes.",
    };
  }

  await deps.events.notify(targetThreadId, committed.targetEventSeq).catch((error) => {
    getLogger().error("bot message realtime notification", error);
  });
  await deps.events.notify(run.threadId, committed.senderEventSeq).catch((error) => {
    getLogger().error("bot message sender echo notification", error);
  });
  if (committed.runId)
    await deps.jobs.enqueue(runContinueJob(committed.runId)).catch((error) => {
      // The queued run is durable; the job reconciler repairs a missed wake.
      getLogger().error("bot message enqueue", error);
    });
  return {
    ok: true as const,
    status: committed.waiting ? ("waiting" as const) : ("delivered" as const),
    botId: target.id,
    name: target.name,
    messageId: committed.messageId,
    runId: committed.runId,
    managed: committed.managed ?? false,
    ...(committed.ticketId ? { ticketId: committed.ticketId } : {}),
    delivered: message,
    note: `Sent to ${target.name}. Delivery is async; a reply wakes you later as a new message. Continue independent work; send another update later only if it adds something new.`,
  };
}

/** Return a delegated run's terminal outcome unless it already sent one explicitly. */
export async function returnBotMessageOutcome(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  sender: { id: string; name: string },
  text: string,
  intent: "result" | "status" = "result",
  options?: { forceUnread?: boolean },
) {
  const linked = await deps.prisma.run.findFirst({
    where: { id: run.id, spaceId: run.spaceId, userId: run.userId },
    select: { ticketId: true, ticket: { select: { managedVersion: true, parentTicketId: true } } },
  });
  if (linked?.ticket?.managedVersion && linked.ticketId) {
    if (linked.ticket.parentTicketId)
      await deps.prisma.$transaction((tx) =>
        recordManagedChildOutcomeInTransaction(tx, {
          spaceId: run.spaceId,
          runId: run.id,
          ticketId: linked.ticketId!,
          payload: { text: clampBotMessage(text), intent },
        }),
      );
    await markBotOutcomeReturned(deps.prisma, run.id);
    await reconcileManagedWorkEvents(deps, { spaceId: run.spaceId });
    return true;
  }
  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (!source) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    // Handled: nothing to deliver. Return true so callers do not release a reservation.
    return true;
  }
  const sourceIntent = source.intent ?? "request";
  if (sourceIntent !== "request" && sourceIntent !== "question") {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const sent = await deps.prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { blocks: true },
  });
  // Only an explicit result counts as a terminal outcome. Interim message_bot
  // status updates must not suppress the automatic final return.
  const alreadyReturned = sent.some((message) =>
    (Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : []).some(
      (block) =>
        block.kind === "bot_message_sent" &&
        block.toBotId === source.fromBotId &&
        block.intent === "result",
    ),
  );
  if (alreadyReturned) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  // messageBot reaches only active bots of this space, so an archived or deleted
  // requester can never take the outcome. Handled: nothing is left to deliver.
  const requester = await deps.prisma.bot.findFirst({
    where: { id: source.fromBotId, spaceId: run.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!requester) {
    await markBotOutcomeReturned(deps.prisma, run.id);
    return true;
  }
  const outcome = await messageBot(
    deps,
    run,
    sender,
    {
      bot_id: source.fromBotId,
      message: clampBotMessage(text),
      intent,
      // One key per run so status vs result (executor vs reconciler) cannot double-deliver.
      deliveryKey: `auto-outcome:${run.id}`,
    },
    {
      allowTerminalSource: true,
      forceUnread: options?.forceUnread,
    },
  );
  if (outcome.ok) await markBotOutcomeReturned(deps.prisma, run.id);
  return outcome.ok;
}

async function markBotOutcomeReturned(prisma: PrismaClient, runId: string) {
  await prisma.run.updateMany({
    where: {
      id: runId,
      status: { in: ["completed", "failed", "cancelled"] },
      botOutcomeReturnedAt: null,
    },
    data: { botOutcomeReturnedAt: new Date() },
  });
}
