import { createHash } from "node:crypto";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type {
  TicketFileDeliveryAcceptance,
  TicketWorkEnvironment,
  TicketWorkPendingCall,
} from "@rakazo/contracts";
import {
  MessageBlock,
  TicketFileDeliveryAcceptanceSchema,
  TicketFileDeliveryRequirementsSchema,
  TicketWorkStateUpdateSchema,
} from "@rakazo/contracts";
import { redactSecrets, withAbort } from "@rakazo/core";
import type { Computer, TicketWorkStateScope } from "@rakazo/db";
import {
  IsolationError,
  loadTicketWorkState,
  saveTicketWorkPendingCall,
  saveTicketWorkProgress,
  TicketWorkStateConflict,
  TicketWorkStateLeaseError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import * as z from "zod";
import { RUN_CONFIGURATION_RECEIPT_KIND } from "./run-configuration-manifest.js";
import type { RunContext } from "./run-context.js";
import type {
  TicketProgressBoundaryInput,
  TicketProgressBoundaryResult,
  TicketProgressObservation,
} from "./ticket-progress.js";
import { runTicketProgressBoundary } from "./ticket-progress.js";
import { ticketReceiptsEnabled } from "./ticket-receipt-config.js";
import type { TicketWorkStateRecovery } from "./ticket-work-state.js";
import {
  loadAgentTicketWorkState,
  recoverTicketWorkState,
  saveAgentTicketWorkState,
} from "./ticket-work-state.js";

/** A filesystem revision is not a restored screen. Unknown runtime/tool versions stay unknown. */
export function ticketEnvironment(
  computer: Pick<
    Computer,
    "id" | "homeRevision" | "homeRevisionAt" | "autoRecoveredAt" | "restorePending"
  > | null,
  runtime?: ReturnType<AgentRuntime["describe"]>,
): TicketWorkEnvironment {
  const revision = process.env.GIT_SHA ?? process.env.RAKAZO_GIT_SHA;
  return {
    computerId: computer?.id ?? null,
    snapshotRef:
      computer &&
      !computer.restorePending &&
      computer.homeRevision !== "empty" &&
      computer.homeRevisionAt &&
      (!computer.autoRecoveredAt || computer.autoRecoveredAt < computer.homeRevisionAt)
        ? computer.homeRevision
        : null,
    runtimeRevision: runtime
      ? `${runtime.id}:${runtime.contractVersion}:${runtime.adapterVersion}`
      : null,
    toolRevision: revision && revision !== "unknown" ? revision : null,
  };
}

async function currentTicket(ctx: RunContext) {
  if (!ctx.deps.ticketBoardEnabled || !ticketReceiptsEnabled()) return null;
  const run = await ctx.deps.prisma.run.findFirst({
    where: {
      id: ctx.runId,
      spaceId: ctx.run.spaceId,
      userId: ctx.run.userId,
      botId: ctx.bot.id,
      bot: { userId: ctx.run.userId, archivedAt: null },
    },
    select: { ticketId: true, status: true },
  });
  if (!run?.ticketId) return null;
  const ticket = await ctx.deps.prisma.ticket.findFirst({
    where: {
      id: run.ticketId,
      spaceId: ctx.run.spaceId,
      createdByUserId: ctx.run.userId,
      assigneeBotId: ctx.bot.id,
      originKey: { not: null },
    },
    select: {
      id: true,
      title: true,
      status: true,
      fileDeliveryRequirements: true,
      receiptVersion: true,
      originThreadId: true,
      createdByBotId: true,
    },
  });
  if (!ticket) return null;
  const scope: TicketWorkStateScope = {
    ticketId: ticket.id,
    spaceId: ctx.run.spaceId,
    userId: ctx.run.userId,
    botId: ctx.bot.id,
    runId: ctx.runId,
  };
  return { ticket, scope, run };
}

async function currentConfiguration(ctx: RunContext): Promise<string | null> {
  return (
    (
      await ctx.deps.prisma.externalEffect.findFirst({
        where: {
          spaceId: ctx.run.spaceId,
          runId: ctx.runId,
          kind: RUN_CONFIGURATION_RECEIPT_KIND,
          status: RUN_CONFIGURATION_RECEIPT_KIND,
          idempotencyKey: JSON.stringify([
            RUN_CONFIGURATION_RECEIPT_KIND,
            ctx.runId,
            ctx.attempt.id,
            "start",
            0,
          ]),
        },
        select: { id: true },
      })
    )?.id ?? null
  );
}

/** After configuration publication; historical/non-owner tasks simply have no work-state entry. */
export async function ensureRunTicketWorkState(
  ctx: RunContext,
): Promise<TicketWorkStateRecovery | undefined> {
  const current = await currentTicket(ctx);
  if (!current) return undefined;
  const environment = ticketEnvironment(ctx.bot.computer, ctx.deps.runtime.describe());
  const existing = await loadAgentTicketWorkState(ctx.deps, { ...current.scope, environment });
  if (
    !existing ||
    existing.state ||
    existing.reasons.includes("invalid_state") ||
    existing.version !== 0
  )
    return existing;
  if (current.ticket.status === "done" || current.ticket.status === "closed") return undefined;
  const requirements = current.ticket.fileDeliveryRequirements
    ? TicketFileDeliveryRequirementsSchema.parse(current.ticket.fileDeliveryRequirements)
    : null;
  const configurationRef = await currentConfiguration(ctx);
  if (!configurationRef) return undefined;
  try {
    return await saveAgentTicketWorkState(ctx.deps, {
      ...current.scope,
      lease: { owner: ctx.workerId, fence: ctx.fence },
      expectedVersion: 0,
      expectedRequirementsVersion: requirements?.version ?? null,
      state: {
        goal: redactSecrets(current.ticket.title, ctx.secrets),
        constraints:
          requirements?.items.map((item) =>
            redactSecrets(item.description, ctx.secrets).slice(0, 400),
          ) ?? [],
        evidenceRefs: [],
        nextStep: null,
        blocker: null,
        wait: null,
        position: null,
      },
      environment,
      configurationRef,
    });
  } catch (error) {
    // A parallel tool may have initialized or revised the ticket. Do not retry its old plan.
    if (error instanceof TicketWorkStateConflict)
      return loadAgentTicketWorkState(ctx.deps, { ...current.scope, environment });
    throw error;
  }
}

export async function loadRunTicketWorkState(
  ctx: RunContext,
): Promise<TicketWorkStateRecovery | undefined> {
  const current = await currentTicket(ctx);
  return current
    ? loadAgentTicketWorkState(ctx.deps, {
        ...current.scope,
        environment: ticketEnvironment(ctx.bot.computer, ctx.deps.runtime.describe()),
      })
    : undefined;
}

export async function saveRunTicketWorkState(
  ctx: RunContext,
  input: unknown,
): Promise<TicketWorkStateRecovery | { error: string }> {
  const parsed = TicketWorkStateUpdateSchema.safeParse(input);
  if (!parsed.success)
    return { error: "Invalid workState update. Only advisory state fields are writable." };
  const current = await currentTicket(ctx);
  if (!current) return { error: "This run has no assigned ticket work state." };
  const configurationRef = await currentConfiguration(ctx);
  if (!configurationRef)
    return { error: "The current execution configuration is not recorded yet." };
  const state = parsed.data.state;
  const clean = (value: string | null) =>
    value === null ? null : redactSecrets(value, ctx.secrets);
  try {
    const saved = await saveAgentTicketWorkState(ctx.deps, {
      ...current.scope,
      ...parsed.data,
      state: {
        ...state,
        goal: clean(state.goal),
        constraints: state.constraints.map((constraint) => clean(constraint)),
        nextStep: clean(state.nextStep),
        blocker: clean(state.blocker),
        position: state.position
          ? { ...state.position, summary: clean(state.position.summary) }
          : null,
      },
      lease: { owner: ctx.workerId, fence: ctx.fence },
      environment: ticketEnvironment(ctx.bot.computer, ctx.deps.runtime.describe()),
      configurationRef,
    });
    return saved ?? { error: "Ticket work state is unavailable." };
  } catch (error) {
    if (error instanceof TicketWorkStateConflict)
      return { error: `Ticket work state ${error.reason}. Read ticket_get before updating it.` };
    if (error instanceof IsolationError)
      return { error: "Ticket work state or evidence is outside this execution." };
    throw error;
  }
}

/** The original turn checkpoint remains authoritative; this only preserves its reference. */
export async function saveRunTicketPendingCall(
  ctx: RunContext,
  pendingCall: TicketWorkPendingCall | null,
): Promise<void> {
  try {
    const current = await currentTicket(ctx);
    if (!current) return;
    const saved = await loadTicketWorkState(ctx.deps.prisma, current.scope);
    if (saved.invalid || !saved.state) return;
    await saveTicketWorkPendingCall(ctx.deps.prisma, {
      ...current.scope,
      lease: { owner: ctx.workerId, fence: ctx.fence },
      expectedVersion: saved.version,
      expectedRequirementsVersion: saved.requirementsVersion,
      pendingCall,
    });
  } catch (error) {
    if (error instanceof TicketWorkStateLeaseError) throw error;
    if (error instanceof TicketWorkStateConflict || error instanceof IsolationError) return;
    getLogger().warn("ticket pending call reference unavailable", {
      runId: ctx.runId,
      reason: error instanceof z.ZodError ? "invalid_state" : "persistence_unavailable",
    });
  }
}

export type RunTicketProgressCheckOptions = {
  boundaryId?: string;
  deadlineAt?: number;
  judge?: TicketProgressBoundaryInput["judge"];
};

/** Serial main-phase boundary; optional calibrated judging never changes the run lifecycle. */
export async function runTicketProgressCheck(
  ctx: RunContext,
  options: RunTicketProgressCheckOptions = {},
): Promise<TicketProgressBoundaryResult | undefined> {
  const current = await currentTicket(ctx);
  if (!current || current.ticket.status === "done" || current.ticket.status === "closed")
    return undefined;
  const saved = await loadTicketWorkState(ctx.deps.prisma, current.scope);
  if (saved.invalid || !saved.state) return undefined;
  if (current.run.status === "waiting_input" || current.run.status === "waiting_takeover") {
    // Committing a pause releases the lease. Report its existing identity without another write.
    return {
      decision: { action: "wait", reason: "waiting_for_human", ref: ctx.runId },
      revision: null,
    };
  }
  const { ticket, scope } = current;
  const recovered = recoverTicketWorkState(
    saved,
    ticketEnvironment(ctx.bot.computer, ctx.deps.runtime.describe()),
  );
  const verifiedArtifacts = [
    ...recovered.currentEvidenceRefs,
    ...(recovered.position ? [recovered.position.evidenceRef] : []),
  ].flatMap((ref) =>
    ref.kind === "artifact" ? [{ id: ref.artifactId, version: ref.version, hash: ref.hash }] : [],
  );
  let acceptance: TicketFileDeliveryAcceptance | undefined;
  const artifacts = ctx.deps.artifacts;
  if (
    saved.requirementsVersion !== null &&
    artifacts &&
    ticket.receiptVersion > 0 &&
    ticket.originThreadId &&
    ticket.createdByBotId
  ) {
    const receiptMessage = await ctx.deps.prisma.message.findFirst({
      where: {
        threadId: ticket.originThreadId,
        role: "bot",
        botId: ticket.createdByBotId,
        clientNonce: { startsWith: `work-receipt:${ticket.id}:${ticket.receiptVersion}:` },
      },
      select: { blocks: true },
    });
    const blocks = z.array(MessageBlock).safeParse(receiptMessage?.blocks);
    const fileIds = blocks.success
      ? blocks.data.flatMap((block) => (block.kind === "file" ? [block.artifactId] : []))
      : [];
    const receipt = fileIds.length
      ? await ctx.deps.prisma.artifact.findFirst({
          where: {
            id: { in: fileIds },
            spaceId: scope.spaceId,
            userId: scope.userId,
            botId: ticket.createdByBotId,
            name: `work-${ticket.id}.json`,
            mimeType: "application/json",
          },
          select: { storageKey: true, size: true, hash: true },
        })
      : null;
    if (receipt && receipt.size <= 256 * 1024) {
      const signal = AbortSignal.any([ctx.context.signal, AbortSignal.timeout(2_000)]);
      try {
        const bytes = await withAbort(
          artifacts.get(receipt.storageKey, { ...ctx.context, signal }),
          signal,
        );
        if (
          bytes.byteLength <= 256 * 1024 &&
          createHash("sha256").update(bytes).digest("hex") === receipt.hash
        ) {
          const parsed = z
            .object({
              schema: z.literal(1),
              ticketId: z.literal(ticket.id),
              version: z.literal(ticket.receiptVersion),
              acceptance: TicketFileDeliveryAcceptanceSchema,
            })
            .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
          if (
            parsed.success &&
            parsed.data.acceptance.requirementsVersion === saved.requirementsVersion
          )
            acceptance = parsed.data.acceptance;
        }
      } catch {
        // Missing/malformed/unreadable receipts supply no evidence, never a successful check.
      }
    }
  }
  const streak = ctx.state.toolCallStreak;
  const fingerprint = streak.executionId
    ? ctx.state.toolResults.get(streak.executionId)
    : undefined;
  const tool = ctx.state.reply.toolCalls.findLast(
    (call) => call.executionId === streak.executionId,
  );
  const name = streak.key?.slice(0, streak.key.indexOf(":"));
  const patternKey = createHash("sha256")
    .update(JSON.stringify([streak.key, fingerprint]))
    .digest("hex");
  const repeated: TicketProgressObservation["repeated"] =
    streak.count > 1 && fingerprint && streak.results?.includes(fingerprint)
      ? fingerprint.startsWith("failed:")
        ? { patternKey, kind: "same_failure", outcome: "failed", tool: tool?.label ?? name }
        : ctx.tools.offered.some((offered) => offered.name === name && offered.readOnly === true)
          ? { patternKey, kind: "same_read", outcome: "succeeded", tool: tool?.label ?? name }
          : undefined
      : undefined;
  const result = await runTicketProgressBoundary({
    ticketId: ticket.id,
    snapshot: { revision: saved.version, checkpoint: saved.state.progress },
    boundaryId: options.boundaryId ?? `${ctx.runId}:${ctx.attempt.id}:pre-finalize`,
    now: (ctx.deps.now?.() ?? new Date()).getTime(),
    deadlineAt: options.deadlineAt,
    judge: options.judge,
    observation: {
      requirementsVersion: saved.requirementsVersion,
      acceptance,
      // Generic effect rows have no stable outcome key; completion alone is not progress.
      artifacts: verifiedArtifacts,
      repeated,
    },
    commit: (expectedVersion, checkpoint) =>
      saveTicketWorkProgress(ctx.deps.prisma, {
        ...scope,
        lease: { owner: ctx.workerId, fence: ctx.fence },
        expectedVersion,
        expectedRequirementsVersion: saved.requirementsVersion,
        checkpoint,
      }),
  });
  if (result.revision !== null)
    getLogger().info("ticket progress checked", {
      ticketId: ticket.id,
      runId: ctx.runId,
      action: result.decision.action,
      reason: result.decision.reason,
    });
  return result;
}
