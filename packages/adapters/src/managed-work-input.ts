import type {
  AdapterContext,
  ConnectorProvider,
  ExternalExecutionSnapshot,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { ManagedExternalInputResponse, MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient, ThreadEvents, Ticket, WorkEvent } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  loadManagedInputInTransaction,
  managedInputAskBlock,
  managedInputCheckpoint,
  managedWorkOriginAvailable,
  readManagedInputCheckpoint,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import * as z from "zod";
import { LocalAgentPhoneProvider } from "./local-agent-phone.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function prepareManagedInputWakeInTransaction(
  tx: Prisma.TransactionClient,
  event: WorkEvent,
  ticket: Ticket,
  prompt: string,
) {
  const work = await loadManagedInputInTransaction(tx, { eventId: event.id });
  if (!work) {
    const blocks: MessageBlock[] = [
      { kind: "meta", text: "The external question cannot be answered through this connection." },
    ];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: ticket.originThreadId!,
      botId: event.targetBotId,
      role: "system",
      clientNonce: `work-input-blocked:${event.id}`,
      blocks,
    });
    const visible = await appendEventInTransaction(tx, {
      spaceId: event.spaceId,
      threadId: ticket.originThreadId!,
      botId: event.targetBotId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    await tx.workEvent.update({
      where: { id: event.id },
      data: { status: "failed" },
    });
    return { status: "blocked" as const, threadId: visible.threadId, eventSeq: visible.seq };
  }
  const source = await createThreadMessageInTransaction(tx, {
    threadId: event.targetThreadId,
    botId: event.targetBotId,
    role: "system",
    clientNonce: `work-event:${event.id}`,
    blocks: [{ kind: "meta", text: "External execution needs an answer." }],
  });
  const task = await tx.task.create({
    data: {
      spaceId: event.spaceId,
      userId: event.userId,
      botId: event.targetBotId,
      threadId: event.targetThreadId,
      prompt,
      status: "waiting_input",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: event.spaceId,
      userId: event.userId,
      botId: event.targetBotId,
      threadId: event.targetThreadId,
      taskId: task.id,
      ticketId: ticket.id,
      workControlEpoch: ticket.controlEpoch,
      workRequirementsVersion: ticket.requirementsVersion,
      trigger: "bot_message",
      sourceMessageId: source.id,
      clientNonce: `work-event-input:${event.id}`,
      checkpoint: managedInputCheckpoint(event.id),
      status: "waiting_input",
    },
  });
  await tx.message.update({ where: { id: source.id }, data: { runId: run.id } });
  const blocks = [managedInputAskBlock(event.id, work.binding.questions[0]!)];
  const question = await createThreadMessageInTransaction(tx, {
    threadId: ticket.originThreadId!,
    botId: event.targetBotId,
    role: "bot",
    runId: run.id,
    clientNonce: `work-input:${event.id}:0`,
    blocks,
  });
  await appendEventInTransaction(tx, {
    spaceId: event.spaceId,
    threadId: ticket.originThreadId!,
    botId: event.targetBotId,
    type: "thread.message.created",
    runId: run.id,
    payload: { messageId: question.id, role: "bot", blocks },
  });
  const visible = await appendEventInTransaction(tx, {
    spaceId: event.spaceId,
    threadId: ticket.originThreadId!,
    botId: event.targetBotId,
    type: "run.waiting_input",
    runId: run.id,
    payload: { userId: event.userId },
  });
  const response: ManagedExternalInputResponse = {
    status: "collecting",
    operationKey: `work-input:${event.id}`,
    questionIndex: 0,
    answers: {},
    messageId: question.id,
  };
  await tx.workEvent.update({
    where: { id: event.id },
    data: {
      status: "prepared",
      wakeRunId: run.id,
      payload: json({ ...object(event.payload), inputResponse: response }),
    },
  });
  return {
    status: "waiting_input" as const,
    runId: run.id,
    threadId: visible.threadId,
    eventSeq: visible.seq,
    enqueue: false,
  };
}

export interface ResumeManagedExternalInputDeps {
  prisma: PrismaClient;
  connector?: ConnectorProvider;
  events: Pick<ThreadEvents, "notify" | "finalizeRun">;
  jobs: Pick<JobPublisher, "enqueue">;
}

export interface ResumeManagedExternalInput {
  spaceId: string;
  runId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  signal?: AbortSignal;
}

const Route = z.object({
  connectorId: z.string(),
  toolName: z.string(),
  resourceId: z.string().optional(),
  resourceRevision: z.union([z.string(), z.number()]).optional(),
  connectionId: z.string().optional(),
});

/** Runs after the Run claim and before any model setup. Never starts a native turn. */
export async function resumeManagedExternalInput(
  deps: ResumeManagedExternalInputDeps,
  input: ResumeManagedExternalInput,
): Promise<{ handled: false } | { handled: true; status: "sent" | "blocked" | "unknown" }> {
  const run = await deps.prisma.run.findFirst({
    where: { id: input.runId, spaceId: input.spaceId },
  });
  const checkpoint = readManagedInputCheckpoint(run?.checkpoint);
  if (!run || !checkpoint) return { handled: false };
  const saved = await deps.prisma.workEvent.findUnique({
    where: { id: checkpoint.eventId },
    include: { ticket: true },
  });
  let status: "sent" | "blocked" | "unknown" = "blocked";
  let error: string | undefined;
  let snapshot: ExternalExecutionSnapshot | undefined;
  const ownedRun = {
    id: run.id,
    status: "running",
    leaseOwner: input.leaseOwner,
    leaseFence: input.leaseFence,
  };
  const claim = await deps.prisma.$transaction(async (tx) => {
    if (!saved?.ticket.originThreadId) return null;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${saved.ticket.originThreadId} FOR UPDATE`;
    if (saved.targetThreadId !== saved.ticket.originThreadId)
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${saved.targetThreadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${saved.ticketId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM work_events WHERE id = ${saved.id} FOR UPDATE`;
    const current = await tx.run.findFirst({
      where: ownedRun,
      select: { id: true },
    });
    if (!current) return null;
    const work = await loadManagedInputInTransaction(tx, {
      eventId: saved.id,
      spaceId: run.spaceId,
      runId: run.id,
      requirePending: false,
    });
    if (!work?.response || !["prepared", "handled", "failed"].includes(work.event.status))
      return null;
    const response = work.response;
    if (response.questionIndex !== work.binding.questions.length) return null;
    if (
      work.binding.questions.some((question) => !Object.hasOwn(response.answers, question.id)) ||
      Object.keys(response.answers).length !== work.binding.questions.length
    )
      return null;
    if (response.status === "ready") {
      const pending = await loadManagedInputInTransaction(tx, {
        eventId: saved.id,
        runId: run.id,
      });
      if (!pending) return { ...work, response, unavailable: true, dispatch: false };
      await tx.workEvent.update({
        where: { id: saved.id },
        data: {
          payload: json({
            ...object(work.event.payload),
            inputResponse: { ...response, status: "dispatching" },
          }),
        },
      });
    }
    return { ...work, response, dispatch: response.status === "ready" };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (!claim || "unavailable" in claim) {
    error = "This external question is no longer available. The answer was not sent.";
  } else if (claim.response.status === "submitted") {
    status = "sent";
  } else if (claim.response.status === "blocked" || claim.response.status === "unknown") {
    status = claim.response.status;
    error = claim.response.error ?? "The external answer was not delivered.";
  } else {
    try {
      if (!deps.connector) throw new Error("The external execution connection is unavailable.");
      const provider = new LocalAgentPhoneProvider(
        deps.connector,
        Route.parse(claim.execution.route),
      );
      const context: AdapterContext = {
        operationId: claim.response.operationKey,
        traceId: run.id,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      };
      if (claim.dispatch) {
        const current = await provider.inspect({ sessionId: claim.binding.sessionId }, context);
        const pending = Array.isArray(current.receipt.pendingInputRequests)
          ? current.receipt.pendingInputRequests.find(
              (value) => object(value).inputRequestId === claim.binding.inputRequestId,
            )
          : undefined;
        const question = object(pending);
        if (
          !current.found ||
          current.sessionId !== claim.binding.sessionId ||
          current.turnId !== claim.binding.turnId ||
          object(current.receipt.session).connected === false ||
          question.turnId !== claim.binding.turnId ||
          question.inputResponseSupported !== true ||
          question.resumable !== true
        )
          throw new Error("The native question is no longer available. The answer was not sent.");
        context.signal?.throwIfAborted();
        // Recheck the cancellation/version fence after the network read, immediately before send.
        const currentWork = await deps.prisma.$transaction(async (tx) => {
          const work = await loadManagedInputInTransaction(tx, {
            eventId: claim.event.id,
            runId: run.id,
          });
          return work && (await tx.run.findFirst({ where: ownedRun, select: { id: true } }));
        });
        if (!currentWork) throw new Error("The task changed or stopped. The answer was not sent.");
        status = "unknown";
        snapshot = await provider.send(
          {
            operationKey: claim.response.operationKey,
            sessionId: claim.binding.sessionId,
            payload: {
              inputRequestId: claim.binding.inputRequestId,
              expectedTurnId: claim.binding.turnId,
              answers: claim.response.answers,
            },
          },
          context,
        );
      } else {
        // A worker may have stopped after dispatch. Query the stable operation; never resend it.
        status = "unknown";
        snapshot = await provider.inspect(
          { sessionId: claim.binding.sessionId, operationKey: claim.response.operationKey },
          context,
        );
      }
      if (
        snapshot.found &&
        ["accepted", "running", "completed"].includes(snapshot.operationStatus ?? "")
      ) {
        status = "sent";
      } else if (["failed", "cancelled"].includes(snapshot.operationStatus ?? "")) {
        status = "blocked";
        error = snapshot.error ?? "The external execution did not accept the answer.";
      } else {
        status = "unknown";
        error =
          "Answer delivery is not confirmed. The same answer will not be sent again automatically.";
      }
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The external answer could not be delivered.";
    }
  }
  const visible = await deps.prisma.$transaction(async (tx) => {
    if (!saved?.ticket.originThreadId) return null;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${saved.ticket.originThreadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${saved.ticketId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM work_events WHERE id = ${saved.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR UPDATE`;
    if (!(await tx.run.findFirst({ where: ownedRun, select: { id: true } }))) return null;
    const event = await tx.workEvent.findUnique({ where: { id: saved.id } });
    const ticket = await tx.ticket.findUnique({ where: { id: saved.ticketId } });
    if (
      !event ||
      !ticket ||
      ticket.stopRequestedAt ||
      event.controlEpoch !== ticket.controlEpoch ||
      (claim && ticket.requirementsVersion !== claim.binding.requirementsVersion) ||
      event.status === "suppressed" ||
      event.status === "handled" ||
      event.status === "failed" ||
      !(await managedWorkOriginAvailable(tx, ticket))
    )
      return null;
    const response = claim?.response;
    await tx.workEvent.update({
      where: { id: event.id },
      data: {
        status: status === "sent" ? "handled" : "failed",
        ...(status === "sent" ? { handledAt: new Date() } : {}),
        payload: json({
          ...object(event.payload),
          ...(response
            ? {
                inputResponse: {
                  ...response,
                  status: status === "sent" ? "submitted" : status,
                  ...(snapshot ? { receipt: snapshot.receipt } : {}),
                  ...(error ? { error } : {}),
                },
              }
            : { inputError: error }),
        }),
      },
    });
    const blocks: MessageBlock[] = [
      {
        kind: "meta",
        text: status === "sent" ? "Answer sent to the external execution." : error!,
      },
    ];
    const existing = await tx.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: ticket.originThreadId!,
          clientNonce: `work-input-response:${event.id}`,
        },
      },
      select: { id: true },
    });
    if (existing) return null;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: ticket.originThreadId!,
      botId: event.targetBotId,
      role: "system",
      clientNonce: `work-input-response:${event.id}`,
      blocks,
    });
    return appendEventInTransaction(tx, {
      spaceId: event.spaceId,
      threadId: ticket.originThreadId!,
      botId: event.targetBotId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (visible) await deps.events.notify(visible.threadId, visible.seq);
  const completed = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId: input.attemptId,
    leaseOwner: input.leaseOwner,
    leaseFence: input.leaseFence,
    ...(status === "sent"
      ? { outcome: "completed" as const, blocks: [], markUnread: false }
      : { outcome: "failed" as const, error: error ?? "The external answer was not delivered." }),
  });
  if (completed) {
    if (completed.continuationRunId)
      await deps.jobs.enqueue(runContinueJob(completed.continuationRunId));
  }
  if (completed && saved?.ticket.originThreadId && saved.ticket.originThreadId !== run.threadId) {
    const originTerminal = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${saved.ticket.originThreadId} FOR UPDATE`;
      const ticket = await tx.ticket.findUnique({ where: { id: saved.ticketId } });
      if (
        !ticket ||
        ticket.stopRequestedAt ||
        ticket.controlEpoch !== saved.controlEpoch ||
        !(await managedWorkOriginAvailable(tx, ticket))
      )
        return null;
      return appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: ticket.originThreadId!,
        botId: run.botId,
        runId: run.id,
        type: status === "sent" ? "run.completed" : "run.failed",
        payload: status === "sent" ? {} : { error },
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    if (originTerminal) await deps.events.notify(originTerminal.threadId, originTerminal.seq);
  }
  return { handled: true, status };
}
