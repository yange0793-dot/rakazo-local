import type {
  ManagedExternalInputQuestion,
  ManagedExternalInputResponse,
  MessageBlock,
} from "@rakazo/contracts";
import {
  ManagedExternalInputResponseSchema,
  ManagedExternalInputSchema,
  ManagedInputCheckpointSchema,
  MessageBlock as MessageBlockSchema,
} from "@rakazo/contracts";
import { resolveAskChoice } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { ExternalAgentExecution, Prisma } from "./client.js";
import { managedWorkOriginAvailable } from "./coordination.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

export function managedInputCheckpoint(eventId: string): string {
  return JSON.stringify({ kind: "managed_external_input_v1", eventId });
}

export function readManagedInputCheckpoint(checkpoint: string | null | undefined) {
  if (!checkpoint) return null;
  try {
    return ManagedInputCheckpointSchema.safeParse(JSON.parse(checkpoint)).data ?? null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const ExternalInputIdentity = ManagedExternalInputSchema.pick({
  executionId: true,
  controlEpoch: true,
  requirementsVersion: true,
  inputRequestId: true,
});

/** The snapshot writer holds the origin thread, execution thread and ticket locks. */
export async function retireExternalInputInTransaction(
  tx: Prisma.TransactionClient,
  execution: ExternalAgentExecution,
  originThreadId: string,
  pending: ReadonlyArray<{ inputRequestId: string; turnId?: string }>,
) {
  const events = await tx.workEvent.findMany({
    where: {
      spaceId: execution.spaceId,
      userId: execution.userId,
      ticketId: execution.ticketId,
      controlEpoch: execution.controlEpoch,
      targetBotId: execution.ownerBotId,
      targetThreadId: execution.threadId,
      kind: "external_input",
      status: { in: ["pending", "prepared"] },
    },
  });
  const notifications: Array<{ threadId: string; seq: number }> = [];
  for (const event of events) {
    const payload = object(event.payload);
    const binding = ExternalInputIdentity.safeParse(payload).data;
    if (
      binding?.executionId !== execution.id ||
      binding.controlEpoch !== execution.controlEpoch ||
      (payload.sessionId === execution.sessionId &&
        payload.turnId === execution.turnId &&
        pending.some(
          (input) =>
            input.inputRequestId === binding.inputRequestId && input.turnId === payload.turnId,
        ))
    )
      continue;
    if (event.wakeRunId) {
      const response = ManagedExternalInputResponseSchema.safeParse(payload.inputResponse).data;
      const input = ManagedExternalInputSchema.safeParse(payload).data;
      if (response?.status !== "collecting" || !input) continue;
      const run = await tx.run.findFirst({
        where: {
          id: event.wakeRunId,
          spaceId: event.spaceId,
          userId: event.userId,
          botId: event.targetBotId,
          threadId: event.targetThreadId,
          ticketId: event.ticketId,
          workControlEpoch: event.controlEpoch,
          workRequirementsVersion: binding.requirementsVersion,
          status: "waiting_input",
          trigger: "bot_message",
          clientNonce: `work-event-input:${event.id}`,
        },
        select: { id: true, taskId: true, spaceId: true, userId: true, checkpoint: true },
      });
      if (!run || readManagedInputCheckpoint(run.checkpoint)?.eventId !== event.id) continue;
      const [cancelled] = await cancelRunsInTransaction(tx, [run], new Date(), {
        status: "waiting_input",
      });
      if (!cancelled) continue;
      await tx.run.update({ where: { id: run.id }, data: { checkpoint: null } });
      const card = response.messageId
        ? await tx.message.findFirst({
            where: { id: response.messageId, threadId: originThreadId, runId: run.id, role: "bot" },
            select: { id: true, blocks: true },
          })
        : null;
      const eventInput = {
        spaceId: event.spaceId,
        botId: event.targetBotId,
        runId: run.id,
      };
      const blocks = MessageBlockSchema.array().safeParse(card?.blocks).data;
      const ask = blocks?.find(
        (block) =>
          block.kind === "ask" &&
          block.managedInput?.eventId === event.id &&
          block.managedInput.questionId === input.questions[response.questionIndex]?.id &&
          block.status !== "answered",
      );
      if (card && blocks && ask?.kind === "ask") {
        const closed = blocks.map((block) =>
          block === ask ? { ...ask, status: "answered" as const, dismissed: true as const } : block,
        );
        await tx.message.update({ where: { id: card.id }, data: { blocks: closed } });
        await appendEventInTransaction(tx, {
          ...eventInput,
          threadId: originThreadId,
          type: "thread.message.updated",
          allowCancelledRun: true,
          payload: { messageId: card.id, role: "bot", blocks: closed },
        });
      }
      for (const threadId of new Set([originThreadId, event.targetThreadId])) {
        notifications.push(
          await appendEventInTransaction(tx, {
            ...eventInput,
            threadId,
            type: "run.cancelled",
            payload: { reason: "external_input_unavailable" },
          }),
        );
      }
    }
    await tx.workEvent.update({ where: { id: event.id }, data: { status: "suppressed" } });
  }
  return notifications;
}

/** Caller locks origin thread, owning thread, ticket, then WorkEvent before mutating. */
export async function loadManagedInputInTransaction(
  tx: Prisma.TransactionClient,
  input: { eventId: string; spaceId?: string; runId?: string; requirePending?: boolean },
) {
  const event = await tx.workEvent.findFirst({
    where: { id: input.eventId, ...(input.spaceId ? { spaceId: input.spaceId } : {}) },
  });
  if (event?.kind !== "external_input" || event.status === "suppressed") return null;
  const parsed = ManagedExternalInputSchema.safeParse(event.payload);
  if (!parsed.success) return null;
  const binding = parsed.data;
  const ticket = await tx.ticket.findFirst({
    where: {
      id: event.ticketId,
      spaceId: event.spaceId,
      createdByUserId: event.userId,
      assigneeBotId: event.targetBotId,
      managedVersion: { gt: 0 },
      controlEpoch: event.controlEpoch,
      requirementsVersion: binding.requirementsVersion,
      stopRequestedAt: null,
    },
  });
  if (
    !ticket?.originThreadId ||
    binding.controlEpoch !== event.controlEpoch ||
    !(await managedWorkOriginAvailable(tx, ticket))
  )
    return null;
  const execution = await tx.externalAgentExecution.findFirst({
    where: {
      id: binding.executionId,
      spaceId: event.spaceId,
      userId: event.userId,
      ticketId: ticket.id,
      ownerBotId: event.targetBotId,
      threadId: event.targetThreadId,
      controlEpoch: event.controlEpoch,
      sessionId: binding.sessionId,
      turnId: binding.turnId,
      stopRequestedAt: null,
    },
  });
  if (!execution) return null;
  if (input.runId) {
    if (event.wakeRunId !== input.runId) return null;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        spaceId: event.spaceId,
        userId: event.userId,
        botId: event.targetBotId,
        threadId: event.targetThreadId,
        ticketId: ticket.id,
        trigger: "bot_message",
        clientNonce: `work-event-input:${event.id}`,
        workControlEpoch: event.controlEpoch,
        workRequirementsVersion: binding.requirementsVersion,
      },
      select: { checkpoint: true },
    });
    if (readManagedInputCheckpoint(run?.checkpoint)?.eventId !== event.id) return null;
  }
  const response = ManagedExternalInputResponseSchema.safeParse(
    object(event.payload).inputResponse,
  ).data;
  if (input.requirePending !== false) {
    const receipt = object(execution.result);
    const pending = Array.isArray(receipt.pendingInputRequests)
      ? receipt.pendingInputRequests.find(
          (value) => object(value).inputRequestId === binding.inputRequestId,
        )
      : undefined;
    const question = object(pending);
    if (
      execution.status !== "waiting_input" ||
      !binding.inputResponseSupported ||
      !binding.resumable ||
      binding.questions.some((item) => item.isSecret) ||
      question.turnId !== binding.turnId ||
      question.inputResponseSupported !== true ||
      question.resumable !== true ||
      object(receipt.session).connected === false
    )
      return null;
  }
  return { event, binding, ticket, execution, response };
}

export function managedInputAskBlock(
  eventId: string,
  question: ManagedExternalInputQuestion,
): Extract<MessageBlock, { kind: "ask" }> {
  const descriptions = question.options
    ?.filter((option) => option.description)
    .map((option) => `${option.label}: ${option.description}`)
    .join("\n");
  return {
    kind: "ask",
    text: question.question,
    status: "pending",
    managedInput: { eventId, questionId: question.id },
    ...(descriptions ? { detail: descriptions, detailFormat: "text" } : {}),
    ...(question.options?.length
      ? {
          actions: question.options.map((option, index) => ({
            id: `option:${index}`,
            label: option.label,
          })),
        }
      : {}),
  };
}

/** Uses the existing answer endpoint, but never turns an answer into model instructions. */
export async function answerManagedInputInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    runId: string;
    messageId: string;
    answeredByUserId: string;
    answer: string;
    answerMessageId?: string;
  },
  card: {
    blocks: MessageBlock[];
    ask: Extract<MessageBlock, { kind: "ask" }>;
  },
): Promise<{ threadId: string; seq: number } | null> {
  if (!card.ask.managedInput || !input.answer.trim()) return null;
  const saved = await tx.workEvent.findUnique({
    where: { id: card.ask.managedInput.eventId },
  });
  if (!saved) return null;
  if (saved.targetThreadId !== input.threadId)
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${saved.targetThreadId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${saved.ticketId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM work_events WHERE id = ${saved.id} FOR UPDATE`;
  const work = await loadManagedInputInTransaction(tx, {
    eventId: saved.id,
    spaceId: input.spaceId,
    runId: input.runId,
  });
  if (
    work?.event.status !== "prepared" ||
    work.event.userId !== input.answeredByUserId ||
    work.ticket.originThreadId !== input.threadId ||
    work.response?.status !== "collecting" ||
    work.response.messageId !== input.messageId
  )
    return null;
  const { binding, response } = work;
  const question = binding.questions[response.questionIndex];
  if (!question || question.id !== card.ask.managedInput.questionId) return null;
  const offered = managedInputAskBlock(saved.id, question);
  const selected = resolveAskChoice(input.answer, offered.actions);
  const answer = selected?.label ?? input.answer;
  const nextIndex = response.questionIndex + 1;
  const ready = nextIndex === binding.questions.length;
  const resumed = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      status: "waiting_input",
      workControlEpoch: binding.controlEpoch,
      workRequirementsVersion: binding.requirementsVersion,
    },
    data: { status: ready ? "queued" : "waiting_input" },
  });
  if (resumed.count !== 1) return null;
  const blocks = card.blocks.map((block) =>
    block === card.ask
      ? {
          ...block,
          status: "answered" as const,
          answer: selected?.id ?? input.answer,
          ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
        }
      : block,
  );
  await tx.message.update({ where: { id: input.messageId }, data: { blocks } });
  let event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: work.execution.ownerBotId,
    runId: input.runId,
    type: "thread.message.updated",
    payload: { messageId: input.messageId, role: "bot", blocks },
  });
  let messageId = response.messageId;
  if (!ready) {
    const next = [managedInputAskBlock(saved.id, binding.questions[nextIndex]!)];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      botId: work.execution.ownerBotId,
      role: "bot",
      runId: input.runId,
      blocks: next,
      clientNonce: `work-input:${saved.id}:${nextIndex}`,
    });
    messageId = message.id;
    event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: work.execution.ownerBotId,
      runId: input.runId,
      type: "thread.message.created",
      payload: { messageId, role: "bot", blocks: next },
    });
  }
  const updated: ManagedExternalInputResponse = {
    ...response,
    status: ready ? "ready" : "collecting",
    questionIndex: nextIndex,
    answers: { ...response.answers, [question.id]: { answers: [answer] } },
    messageId,
  };
  await tx.workEvent.update({
    where: { id: saved.id },
    data: {
      payload: JSON.parse(
        JSON.stringify({ ...object(work.event.payload), inputResponse: updated }),
      ),
    },
  });
  return { threadId: event.threadId, seq: event.seq };
}
