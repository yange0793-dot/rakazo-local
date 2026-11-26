import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterContext,
  ConnectorProvider,
  ExternalExecutionEventPage,
  ExternalExecutionSnapshot,
  JobPublisher,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type {
  ExternalAgentExecution,
  Prisma,
  PrismaClient,
  ThreadEvents,
  Ticket,
} from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  managedWorkOriginAvailable,
  recordManagedDependencyChangeInTransaction,
  recordWorkEventInTransaction,
  retireExternalInputInTransaction,
  runAsTenant,
  TERMINAL_EXTERNAL_WORK_STATUSES,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { isLocalAgentPhoneRoute, LocalAgentPhoneProvider } from "./local-agent-phone.js";
import { ensureManagedWorkForRun } from "./managed-work.js";
import { reconcileManagedWorkEvents } from "./managed-work-events.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";

interface ExternalExecutionDeps {
  prisma: PrismaClient;
  connector?: ConnectorProvider;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify">;
  shutdownSignal?: AbortSignal;
}

const Route = z.object({
  connectorId: z.string(),
  toolName: z.string(),
  resourceId: z.string().optional(),
  resourceRevision: z.union([z.string(), z.number()]).optional(),
  connectionId: z.string().optional(),
});
const InputRequest = z
  .object({
    inputRequestId: z.string(),
    turnId: z.string().optional(),
    operationKey: z.string().optional(),
    operationKeys: z.array(z.string()).optional(),
  })
  .passthrough();
const ACTIVE = ["registered", "dispatching", "accepted", "queued", "running", "waiting_input"];
const TERMINAL = new Set(TERMINAL_EXTERNAL_WORK_STATUSES);
const monitors = new Map<string, Promise<void>>();
const monitorOwner = randomUUID();
const LEASE_MS = 90_000;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function contextFor(
  execution: ExternalAgentExecution,
  deps: ExternalExecutionDeps,
  operationId = execution.operationKey,
): AdapterContext {
  const timeout = AbortSignal.timeout(30_000);
  return {
    operationId,
    traceId: execution.id,
    spaceId: execution.spaceId,
    userId: execution.userId,
    botId: execution.ownerBotId,
    signal: deps.shutdownSignal ? AbortSignal.any([deps.shutdownSignal, timeout]) : timeout,
  };
}

function providerFor(deps: ExternalExecutionDeps, execution: ExternalAgentExecution) {
  if (!deps.connector) throw new Error("External execution connection is unavailable.");
  return new LocalAgentPhoneProvider(deps.connector, Route.parse(execution.route));
}

function executionState(snapshot: ExternalExecutionSnapshot): string {
  // A session may have moved to another turn; only this operation's receipt is authoritative.
  return snapshot.operationStatus ?? "unknown";
}

function savedOperationResult(execution: ExternalAgentExecution) {
  const saved = z.record(z.string(), z.unknown()).safeParse(execution.result).data;
  return typeof saved?.operationResult === "string" ? saved.operationResult : undefined;
}

function operationEvents(
  execution: ExternalAgentExecution,
  snapshot: ExternalExecutionSnapshot,
  page: ExternalExecutionEventPage,
) {
  const turnId = snapshot.turnId ?? execution.turnId;
  return page.events.filter(
    (event) =>
      event.operationKey === execution.operationKey ||
      event.operationKeys?.includes(execution.operationKey) ||
      (turnId && event.turnId === turnId),
  );
}

function reportedInputRequests(snapshot: ExternalExecutionSnapshot): unknown {
  const session = z.record(z.string(), z.unknown()).safeParse(snapshot.receipt.session).data;
  return snapshot.receipt.pendingInputRequests ?? session?.pendingInputRequests;
}

function pendingInputs(
  execution: ExternalAgentExecution,
  snapshot: ExternalExecutionSnapshot,
  events: ExternalExecutionEventPage["events"] = [],
) {
  if (TERMINAL.has(executionState(snapshot))) return [];
  const previous = z.record(z.string(), z.unknown()).safeParse(execution.result).data;
  const current = reportedInputRequests(snapshot);
  const authoritative = Array.isArray(current);
  const saved = authoritative ? current : previous?.pendingInputRequests;
  const pending = new Map<string, z.infer<typeof InputRequest>>();
  const turnId = snapshot.turnId ?? execution.turnId;
  const belongs = (input: z.infer<typeof InputRequest>) =>
    input.operationKey === execution.operationKey ||
    input.operationKeys?.includes(execution.operationKey) ||
    Boolean(turnId && input.turnId === turnId);
  for (const value of Array.isArray(saved) ? saved : []) {
    const input = InputRequest.safeParse(value).data;
    if (input && belongs(input)) pending.set(input.inputRequestId, input);
  }
  // Inspect follows the event read, so its list supersedes historical page contents.
  if (authoritative) return [...pending.values()];
  for (const event of events) {
    const input = InputRequest.safeParse(event.data).data;
    if (!input) continue;
    if (event.type === "input_resolved") {
      const waiting = pending.get(input.inputRequestId);
      if (!input.turnId || !waiting?.turnId || input.turnId === waiting.turnId)
        pending.delete(input.inputRequestId);
    } else if (event.status === "waiting_input" && belongs(input))
      pending.set(input.inputRequestId, input);
  }
  return [...pending.values()];
}

async function progressInTransaction(
  tx: Prisma.TransactionClient,
  execution: ExternalAgentExecution,
  ticket: Ticket,
  originThreadId: string,
  detail?: string,
) {
  if (!ticket.originMessageId) return null;
  const clientNonce = `external-progress:${execution.id}`;
  const text = [
    `External execution: ${execution.status}`,
    `Session: ${execution.sessionId ?? "connecting"}`,
    ...(detail ? [detail.slice(0, 600)] : []),
  ].join("\n");
  const blocks: MessageBlock[] = [{ kind: "meta", text }];
  const existing = await tx.message.findUnique({
    where: { threadId_clientNonce: { threadId: originThreadId, clientNonce } },
    select: { id: true, blocks: true },
  });
  if (existing && JSON.stringify(existing.blocks) === JSON.stringify(blocks)) return null;
  const author = ticket.createdByBotId ?? execution.ownerBotId;
  const message = existing
    ? await tx.message.update({
        where: { id: existing.id },
        data: { blocks },
        select: { id: true },
      })
    : await createThreadMessageInTransaction(tx, {
        threadId: originThreadId,
        botId: author,
        role: "system",
        blocks,
        clientNonce,
      });
  const event = await appendEventInTransaction(tx, {
    spaceId: execution.spaceId,
    threadId: originThreadId,
    botId: author,
    type: existing ? "thread.message.updated" : "thread.message.created",
    payload: { messageId: message.id, role: "system", blocks },
  });
  return { threadId: originThreadId, seq: event.seq };
}

async function saveSnapshot(
  deps: ExternalExecutionDeps,
  execution: ExternalAgentExecution,
  snapshot: ExternalExecutionSnapshot,
  options: { cursor?: string; detail?: string; fence: number; partialPage?: boolean },
) {
  const nativeStatus = executionState(snapshot);
  const inputListKnown = Array.isArray(reportedInputRequests(snapshot));
  const inputs = pendingInputs(execution, snapshot);
  const needsInput = nativeStatus === "unknown" ? undefined : inputs[0];
  const status = needsInput ? "waiting_input" : nativeStatus;
  const operationResult = snapshot.result ?? savedOperationResult(execution);
  snapshot.receipt = {
    ...snapshot.receipt,
    pendingInputRequests: inputs,
    ...(operationResult !== undefined ? { operationResult } : {}),
  };
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const origin = await tx.ticket.findUnique({
        where: { id: execution.ticketId },
        select: { originThreadId: true },
      });
      if (origin?.originThreadId) {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${origin.originThreadId} FOR UPDATE`;
      }
      if (execution.threadId !== origin?.originThreadId)
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${execution.threadId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${execution.ticketId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM external_agent_executions WHERE id = ${execution.id} FOR UPDATE`;
      const current = await tx.externalAgentExecution.findFirst({
        where: {
          id: execution.id,
          leaseOwner: monitorOwner,
          leaseFence: options.fence,
          leaseExpiresAt: { gt: new Date() },
          status: { notIn: [...TERMINAL] },
        },
      });
      if (!current) return null;
      const ticket = await tx.ticket.findFirst({
        where: {
          id: current.ticketId,
          spaceId: current.spaceId,
          createdByUserId: current.userId,
          managedVersion: { gt: 0 },
          controlEpoch: current.controlEpoch,
          stopRequestedAt: null,
        },
      });
      const originThreadId = ticket?.originThreadId;
      const currentOrigin = Boolean(
        ticket &&
          originThreadId &&
          originThreadId === origin?.originThreadId &&
          (await managedWorkOriginAvailable(tx, ticket)),
      );
      const canWriteReceipt = currentOrigin && !current.stopRequestedAt;
      const updated = await tx.externalAgentExecution.updateMany({
        where: {
          id: execution.id,
          leaseOwner: monitorOwner,
          leaseFence: options.fence,
          status: { notIn: [...TERMINAL] },
        },
        data: {
          sessionId: snapshot.sessionId ?? current.sessionId,
          turnId: snapshot.turnId ?? current.turnId,
          ...(!options.partialPage
            ? {
                operationState: nativeStatus,
                status,
                ...(TERMINAL.has(status) ? { completedAt: new Date() } : {}),
              }
            : {}),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          lastEventAt: new Date(),
          ...(canWriteReceipt ? { result: json(snapshot.receipt) } : {}),
        },
      });
      if (!updated.count) return null;
      const saved = await tx.externalAgentExecution.findUniqueOrThrow({
        where: { id: execution.id },
      });
      const notifications: Array<{ threadId: string; seq: number }> = [];
      if (options.partialPage) return { execution: saved, notifications, reconcile: false };
      if (
        currentOrigin &&
        originThreadId &&
        (saved.stopRequestedAt || nativeStatus !== "unknown" || inputListKnown)
      ) {
        notifications.push(
          ...(await retireExternalInputInTransaction(
            tx,
            saved,
            originThreadId,
            saved.stopRequestedAt ? [] : inputs,
          )),
        );
      }
      const hasNewEvidence = TERMINAL.has(status) || status === "unknown" || Boolean(needsInput);
      if (
        ticket &&
        ticket.assigneeBotId === saved.ownerBotId &&
        canWriteReceipt &&
        hasNewEvidence
      ) {
        const request = z.object({ cwd: z.string().optional() }).safeParse(saved.request);
        const session = z
          .object({ cwd: z.string().optional() })
          .safeParse(snapshot.receipt.session);
        const cwd = request.data?.cwd ?? session.data?.cwd;
        const question =
          typeof needsInput?.detail === "string"
            ? needsInput.detail
            : z
                .array(z.object({ question: z.string() }))
                .safeParse(needsInput?.questions)
                .data?.map((item) => item.question)
                .join("\n");
        await recordWorkEventInTransaction(tx, {
          spaceId: saved.spaceId,
          userId: saved.userId,
          ticketId: saved.ticketId,
          eventKey: `external:${saved.id}:${needsInput?.inputRequestId ?? status}`,
          kind: needsInput ? "external_input" : `external_${status}`,
          controlEpoch: saved.controlEpoch,
          targetBotId: saved.ownerBotId,
          targetThreadId: saved.threadId,
          sourceRunId: saved.runId ?? undefined,
          payload: {
            executionId: saved.id,
            sessionId: saved.sessionId,
            operationKey: saved.operationKey,
            connectionId: saved.connectionId,
            cursor: saved.cursor,
            ...(cwd !== undefined ? { cwd } : {}),
            turnId: saved.turnId,
            controlEpoch: saved.controlEpoch,
            requirementsVersion: ticket.requirementsVersion,
            status,
            ...(needsInput
              ? {
                  inputRequestId: needsInput.inputRequestId,
                  inputRequest: json(needsInput),
                  inputResponseSupported: needsInput.inputResponseSupported === true,
                  resumable: needsInput.resumable === true,
                  question,
                  ...(Array.isArray(needsInput.questions)
                    ? { questions: json(needsInput.questions) }
                    : {}),
                }
              : {}),
            result: operationResult,
            error: snapshot.error,
            instruction:
              "Inspect the existing execution and artifacts. A finished turn is not acceptance. " +
              "Continue the existing work, return a verified result, or record its concrete blocker. " +
              "Do not resend an operation whose delivery is unknown. " +
              "The referenced provider's filesystem is separate from other connectors. " +
              "Use existing local workspace tools to read or import its files. " +
              "Do not restart the agent just to export files.",
          },
        });
      }
      if (canWriteReceipt && ticket && originThreadId) {
        const progress = await progressInTransaction(
          tx,
          saved,
          ticket,
          originThreadId,
          options.detail ?? snapshot.error,
        );
        if (progress) notifications.push(progress);
      }
      return {
        execution: saved,
        notifications,
        reconcile: notifications.length > 0 || (canWriteReceipt && hasNewEvidence),
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  for (const { threadId, seq } of result?.notifications ?? []) {
    await deps.events.notify(threadId, seq).catch((error) => {
      getLogger().warn("external execution progress notification", error);
    });
  }
  if (result?.reconcile) {
    await reconcileManagedWorkEvents(deps, { spaceId: execution.spaceId });
  }
  return result?.execution;
}

async function monitorExecution(deps: ExternalExecutionDeps, id: string) {
  const claimed = await deps.prisma.externalAgentExecution.updateMany({
    where: {
      id,
      status: { notIn: [...TERMINAL] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }],
    },
    data: {
      leaseOwner: monitorOwner,
      leaseFence: { increment: 1 },
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    },
  });
  if (!claimed.count) return;
  let execution = await deps.prisma.externalAgentExecution.findUniqueOrThrow({ where: { id } });
  const fence = execution.leaseFence;
  try {
    while (!deps.shutdownSignal?.aborted) {
      const current = await deps.prisma.externalAgentExecution.findUnique({ where: { id } });
      if (!current || current.leaseOwner !== monitorOwner || current.leaseFence !== fence) return;
      execution = current;
      const provider = providerFor(deps, execution);
      const renewed = await deps.prisma.externalAgentExecution.updateMany({
        where: {
          id,
          leaseOwner: monitorOwner,
          leaseFence: fence,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      });
      if (!renewed.count) return;
      if (execution.stopRequestedAt && !TERMINAL.has(execution.status)) {
        if (!execution.sessionId) {
          const found = await provider.inspect(
            { operationKey: execution.operationKey },
            contextFor(execution, deps),
          );
          if (found.sessionId) {
            const saved = await saveSnapshot(deps, execution, found, { fence });
            if (!saved || TERMINAL.has(saved.status)) return;
            execution = saved;
          } else {
            await saveSnapshot(
              deps,
              execution,
              {
                found: false,
                operationStatus: "unknown",
                receipt: { reason: "Stop cannot be confirmed." },
              },
              { fence },
            );
            return;
          }
        }
        if (execution.sessionId) {
          await provider.cancel(
            {
              sessionId: execution.sessionId,
              operationKey: `cancel:${execution.id}:${execution.controlEpoch}`,
              targetOperationKey: execution.operationKey,
              ...(execution.turnId ? { expectedTurnId: execution.turnId } : {}),
            },
            contextFor(execution, deps, `cancel:${execution.id}:${execution.controlEpoch}`),
          );
        }
      }
      let snapshot = await provider.inspect(
        {
          operationKey: execution.operationKey,
          ...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
        },
        contextFor(execution, deps),
      );
      if (!snapshot.found && execution.status === "registered" && !execution.stopRequestedAt) {
        // This state is committed before dispatch starts, so no remote side effect was issued.
        const dispatch = await deps.prisma.externalAgentExecution.updateMany({
          where: { id, status: "registered", stopRequestedAt: null, leaseFence: fence },
          data: { status: "dispatching" },
        });
        if (!dispatch.count) continue;
        const payload = z.record(z.string(), z.unknown()).parse(execution.request);
        snapshot = execution.sessionId
          ? await provider.send(
              { operationKey: execution.operationKey, sessionId: execution.sessionId, payload },
              contextFor(execution, deps),
            )
          : await provider.start(
              { operationKey: execution.operationKey, payload },
              contextFor(execution, deps),
            );
      }
      if (!snapshot.found || !snapshot.sessionId) {
        await saveSnapshot(deps, execution, { ...snapshot, operationStatus: "unknown" }, { fence });
        return;
      }
      if (executionState(snapshot) === "unknown") {
        await saveSnapshot(deps, execution, snapshot, { fence });
        return;
      }
      if (!TERMINAL.has(executionState(snapshot))) {
        const saved = await saveSnapshot(deps, execution, snapshot, { fence });
        if (!saved) return;
        execution = saved;
        if (execution.stopRequestedAt && !current.stopRequestedAt) continue;
      }
      const page = await provider.readEvents(
        {
          sessionId: snapshot.sessionId,
          cursor: execution.cursor,
          waitMs: TERMINAL.has(executionState(snapshot)) ? 0 : 20_000,
        },
        contextFor(execution, deps),
      );
      const relevant = operationEvents(execution, snapshot, page);
      const detail = relevant.at(-1);
      const currentSnapshot = await provider.inspect(
        { operationKey: execution.operationKey, sessionId: snapshot.sessionId },
        contextFor(execution, deps),
      );
      const resultEvent = relevant.findLast((event) => event.type === "result" && event.text);
      currentSnapshot.result = resultEvent?.text ?? savedOperationResult(execution);
      currentSnapshot.receipt = {
        ...currentSnapshot.receipt,
        pendingInputRequests: pendingInputs(execution, currentSnapshot, page.events),
        ...(currentSnapshot.result ? { operationResult: currentSnapshot.result } : {}),
      };
      if (page.hasMore) {
        const saved = await saveSnapshot(deps, execution, currentSnapshot, {
          fence,
          cursor: page.nextCursor,
          partialPage: true,
        });
        if (!saved) return;
        continue;
      }
      const saved = await saveSnapshot(deps, execution, currentSnapshot, {
        fence,
        cursor: page.nextCursor,
        detail:
          detail?.text ??
          (detail ? `${detail.type}${detail.status ? `: ${detail.status}` : ""}` : undefined),
      });
      if (!saved || TERMINAL.has(saved.status) || saved.status === "unknown") return;
      execution = saved;
      await delay(500, undefined, { signal: deps.shutdownSignal });
    }
  } catch (error) {
    if (!deps.shutdownSignal?.aborted) {
      await saveSnapshot(
        deps,
        execution,
        {
          found: Boolean(execution.sessionId),
          operationStatus: "unknown",
          error: error instanceof Error ? error.message : String(error),
          receipt: { error: error instanceof Error ? error.message : String(error) },
        },
        { fence },
      );
    }
  } finally {
    await deps.prisma.externalAgentExecution.updateMany({
      where: { id, leaseOwner: monitorOwner, leaseFence: fence },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }
}

function startMonitor(deps: ExternalExecutionDeps, execution: ExternalAgentExecution) {
  if (monitors.has(execution.id)) return;
  const work = runAsTenant(execution, () => monitorExecution(deps, execution.id))
    .catch((error) => getLogger().error("external execution monitoring", error))
    .finally(() => monitors.delete(execution.id));
  monitors.set(execution.id, work);
}

export async function reconcileExternalExecutions(deps: ExternalExecutionDeps) {
  if (!deps.connector) return;
  const executions = await deps.prisma.externalAgentExecution.findMany({
    where: {
      OR: [
        { status: { in: ACTIVE } },
        { status: "unknown", completedAt: null },
        { stopRequestedAt: { not: null }, status: { notIn: [...TERMINAL] } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  for (const execution of executions) startMonitor(deps, execution);
}

/** Runs after the existing tool gate, using its stable effect key and resolved connection. */
export async function executeManagedExternalTool(ctx: RunContext, call: ToolCall) {
  const route = call.connectorCall.route;
  if (!route || !isLocalAgentPhoneRoute(route)) return undefined;
  if (!ctx.deps.ticketBoardEnabled || !ticketReceiptsEnabled()) {
    if (ctx.run.ticketId) return { error: "Managed external execution is unavailable." };
    return undefined;
  }
  if (!ctx.deps.connector) return { error: "Agent connection is unavailable." };
  const deps: ExternalExecutionDeps = ctx.deps;
  const provider = new LocalAgentPhoneProvider(ctx.deps.connector, route);
  const existingOperation = await deps.prisma.externalAgentExecution.findUnique({
    where: { operationKey: call.effectKey },
  });
  if (existingOperation) {
    if (
      existingOperation.spaceId !== ctx.run.spaceId ||
      existingOperation.userId !== ctx.run.userId
    ) {
      return { error: "External execution operation scope changed." };
    }
    startMonitor(deps, existingOperation);
    return {
      ...(existingOperation.result as Record<string, unknown> | null),
      managed: true,
      executionId: existingOperation.id,
      ticketId: existingOperation.ticketId,
      duplicate: true,
      status: existingOperation.status,
    };
  }
  let prior: ExternalAgentExecution | null = null;
  if (route.toolName !== "phone_start") {
    prior = await deps.prisma.externalAgentExecution.findFirst({
      where: {
        spaceId: ctx.run.spaceId,
        userId: ctx.run.userId,
        sessionId: String(call.args.sessionId ?? ""),
        connectionId: route.resourceId,
        ownerBotId: ctx.bot.id,
        ...(typeof call.args.targetRequestId === "string"
          ? { operationKey: call.args.targetRequestId }
          : {}),
        ...(typeof call.args.expectedTurnId === "string"
          ? { turnId: call.args.expectedTurnId }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (!prior) return { error: "This session has no managed work association." };
  }
  if (route.toolName === "phone_stop" && prior?.sessionId) {
    if (typeof call.args.expectedTurnId === "string" && call.args.expectedTurnId !== prior.turnId) {
      return { error: "The requested turn is not the managed execution turn." };
    }
    await deps.prisma.externalAgentExecution.updateMany({
      where: {
        id: prior.id,
        status: { notIn: [...TERMINAL] },
      },
      data: { stopRequestedAt: new Date() },
    });
    const stopped = await provider.cancel(
      {
        sessionId: prior.sessionId,
        operationKey: call.effectKey,
        targetOperationKey: prior.operationKey,
        ...(typeof call.args.expectedTurnId === "string"
          ? { expectedTurnId: call.args.expectedTurnId }
          : prior.turnId
            ? { expectedTurnId: prior.turnId }
            : {}),
      },
      ctx.context,
    );
    startMonitor(deps, prior);
    return { ...stopped.receipt, managed: true, executionId: prior.id, ticketId: prior.ticketId };
  }
  const capabilities = await provider.describe(ctx.context);
  if (!capabilities.operationLookup || !capabilities.events || !capabilities.cancelConfirmation) {
    return { error: "This connection cannot provide managed execution receipts and cancellation." };
  }
  const work = prior
    ? { ticketId: prior.ticketId, controlEpoch: prior.controlEpoch }
    : await ensureManagedWorkForRun(
        ctx.deps,
        {
          id: ctx.run.id,
          spaceId: ctx.run.spaceId,
          userId: ctx.run.userId,
          botId: ctx.bot.id,
          threadId: ctx.run.threadId,
        },
        {
          brief: String(call.args.message ?? ""),
          operationKey: call.effectKey,
        },
      );
  const execution = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${ctx.run.threadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${work.ticketId} FOR UPDATE`;
    let ticket = await tx.ticket.findUniqueOrThrow({ where: { id: work.ticketId } });
    const reopensAcceptedWork =
      prior &&
      (ticket.status === "done" ||
        ticket.status === "closed" ||
        ticket.acceptedRequirementsVersion !== null ||
        ticket.acceptedReceiptVersion !== null);
    if (ticket.stopRequestedAt && !ctx.source.ownerStartedRun)
      throw new Error("This work is stopped. It needs an explicit continuation.");
    if (ticket.stopRequestedAt || reopensAcceptedWork) {
      ticket = await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          status: "doing",
          completedAt: null,
          ...(ticket.stopRequestedAt
            ? { stopRequestedAt: null, controlEpoch: { increment: 1 } }
            : {}),
          ...(reopensAcceptedWork
            ? {
                requirementsVersion: { increment: 1 },
                acceptedRequirementsVersion: null,
                acceptedReceiptVersion: null,
              }
            : {}),
        },
      });
      if (reopensAcceptedWork)
        await recordManagedDependencyChangeInTransaction(tx, {
          spaceId: ticket.spaceId,
          ticketId: ticket.id,
          sourceRunId: ctx.run.id,
        });
    }
    if (prior) {
      await tx.run.update({
        where: { id: ctx.run.id },
        data: {
          ticketId: ticket.id,
          workControlEpoch: ticket.controlEpoch,
          workRequirementsVersion: ticket.requirementsVersion,
        },
      });
    }
    return tx.externalAgentExecution.create({
      data: {
        spaceId: ctx.run.spaceId,
        userId: ctx.run.userId,
        ownerBotId: ctx.bot.id,
        threadId: ctx.run.threadId,
        ticketId: ticket.id,
        runId: ctx.run.id,
        operationKey: call.effectKey,
        connectionId: route.resourceId,
        provider: "local-session",
        route: json(route),
        request: json(call.args),
        sessionId: prior?.sessionId,
        cursor: prior?.cursor ?? "0",
        controlEpoch: ticket.controlEpoch,
      },
    });
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  const fence = execution.leaseFence + 1;
  const dispatch = await deps.prisma.externalAgentExecution.updateMany({
    where: {
      id: execution.id,
      stopRequestedAt: null,
      status: "registered",
      leaseOwner: null,
      leaseFence: execution.leaseFence,
    },
    data: {
      status: "dispatching",
      operationState: "dispatching",
      leaseOwner: monitorOwner,
      leaseFence: fence,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
    },
  });
  if (!dispatch.count) {
    const current = await deps.prisma.externalAgentExecution.findUniqueOrThrow({
      where: { id: execution.id },
    });
    if (current.stopRequestedAt)
      return { error: "Execution stopped before dispatch.", executionId: execution.id };
    return {
      managed: true,
      executionId: execution.id,
      ticketId: execution.ticketId,
      status: current.status,
      tracking: "Events are monitored by the service. End this turn when only waiting remains.",
    };
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(ctx.context.signal ? [ctx.context.signal] : []),
    ...(deps.shutdownSignal ? [deps.shutdownSignal] : []),
  ]);
  try {
    const snapshot = prior?.sessionId
      ? await provider.send(
          { operationKey: execution.operationKey, sessionId: prior.sessionId, payload: call.args },
          { ...ctx.context, signal },
        )
      : await provider.start(
          { operationKey: execution.operationKey, payload: call.args },
          { ...ctx.context, signal },
        );
    let cursor = execution.cursor;
    if (snapshot.sessionId && TERMINAL.has(executionState(snapshot))) {
      // A terminal dispatch response can arrive before the monitor starts. Read its
      // events before recording the terminal obligation so the wake has its result.
      while (true) {
        const page = await provider.readEvents(
          { sessionId: snapshot.sessionId, cursor, waitMs: 0 },
          { ...ctx.context, signal },
        );
        snapshot.result =
          operationEvents(execution, snapshot, page).findLast(
            (event) => event.type === "result" && event.text,
          )?.text ?? snapshot.result;
        if (!page.hasMore) {
          cursor = page.nextCursor;
          break;
        }
        if (page.nextCursor === cursor)
          throw new Error("External event pagination did not advance.");
        cursor = page.nextCursor;
      }
    }
    const saved = await saveSnapshot(deps, execution, snapshot, { cursor, fence });
    return {
      ...(saved?.result as Record<string, unknown> | null | undefined),
      managed: true,
      executionId: execution.id,
      ticketId: execution.ticketId,
      tracking: "Events are monitored by the service. End this turn when only waiting remains.",
    };
  } catch (error) {
    await saveSnapshot(
      deps,
      execution,
      {
        found: false,
        operationStatus: "unknown",
        error: error instanceof Error ? error.message : String(error),
        receipt: { error: error instanceof Error ? error.message : String(error) },
      },
      { fence },
    );
    return {
      error: "External delivery is unknown; the service will inspect the original operation.",
      managed: true,
      executionId: execution.id,
    };
  } finally {
    const released = await deps.prisma.externalAgentExecution.updateMany({
      where: { id: execution.id, leaseOwner: monitorOwner, leaseFence: fence },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
    if (released.count) startMonitor(deps, execution);
  }
}
