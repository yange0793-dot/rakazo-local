import type {
  TicketProgressCheckpoint,
  TicketWorkEnvironment,
  TicketWorkPendingCall,
  TicketWorkState,
} from "@rakazo/contracts";
import {
  TICKET_WORK_STATE_MAX_BYTES,
  TicketFileDeliveryRequirementsSchema,
  TicketProgressCheckpointSchema,
  TicketWorkEnvironmentSchema,
  TicketWorkPendingCallSchema,
  TicketWorkStateSchema,
  TicketWorkStateUpdateSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  jsonKeyIds,
  openJson,
  sealJson,
} from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import type { RunLease } from "./messages.js";
import { IsolationError } from "./scope.js";

export type TicketWorkStateScope = {
  spaceId: string;
  userId: string;
  botId: string;
  runId: string;
  ticketId: string;
};

export type TicketWorkStateRecord = {
  ticketId: string;
  version: number;
  requirementsVersion: number | null;
  state: TicketWorkState | null;
  invalid: boolean;
  configurationAvailable: boolean;
  effectsTruncated: boolean;
  effects: Array<{
    id: string;
    kind: string;
    status: string;
    result: Prisma.JsonValue | null;
    updatedAt: Date;
  }>;
  artifacts: Array<{ id: string; version: number; hash: string }>;
};

export type SaveTicketWorkStateInput = TicketWorkStateScope & {
  lease: RunLease;
  expectedVersion: number;
  expectedRequirementsVersion: number | null;
  state: unknown;
  environment: TicketWorkEnvironment | null;
  configurationRef: string | null;
  pendingCall?: TicketWorkPendingCall | null;
};

export class TicketWorkStateConflict extends Error {
  constructor(
    readonly reason:
      | "version_changed"
      | "requirements_changed"
      | "invalid_state"
      | "evidence_changed"
      | "state_too_large",
  ) {
    super(`Ticket work state ${reason}`);
    this.name = "TicketWorkStateConflict";
  }
}

export class TicketWorkStateLeaseError extends Error {
  constructor() {
    super("Run lease expired before ticket work state");
    this.name = "TicketWorkStateLeaseError";
  }
}

async function requireScope(tx: Prisma.TransactionClient, scope: TicketWorkStateScope) {
  const run = await tx.run.findFirst({
    where: {
      id: scope.runId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      botId: scope.botId,
      ticketId: scope.ticketId,
      bot: { spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
      space: { deletingAt: null, memberships: { some: { userId: scope.userId } } },
    },
    select: { id: true },
  });
  if (!run) throw new IsolationError();
  const ticket = await tx.ticket.findFirst({
    where: {
      id: scope.ticketId,
      spaceId: scope.spaceId,
      createdByUserId: scope.userId,
      assigneeBotId: scope.botId,
    },
    select: {
      id: true,
      status: true,
      workState: true,
      workStateVersion: true,
      fileDeliveryRequirements: true,
    },
  });
  if (!ticket) throw new IsolationError();
  return ticket;
}

function requirementsVersion(value: Prisma.JsonValue | null): number | null {
  if (value === null) return null;
  const parsed = TicketFileDeliveryRequirementsSchema.safeParse(value);
  if (!parsed.success) throw new TicketWorkStateConflict("requirements_changed");
  return parsed.data.version;
}

const locationOf = (scope: TicketWorkStateScope) => ({
  table: "tickets",
  column: "workState",
  rowId: scope.ticketId,
  owner: scope.userId,
});

async function readState(
  prisma: PrismaClient,
  scope: TicketWorkStateScope,
  value: Prisma.JsonValue | null,
): Promise<{ state: TicketWorkState | null; invalid: boolean }> {
  if (value === null) return { state: null, invalid: false };
  const keyIds = jsonKeyIds(value);
  let opened: unknown = value;
  if (keyIds.length) {
    const encryption = contentEncryptionOf(prisma);
    if (!encryption) throw new ContentDecryptionError("Ticket work state needs its content key");
    const keys = new Map(
      await Promise.all(keyIds.map(async (id) => [id, await encryption.ring.byId(id)] as const)),
    );
    opened = openJson(value, (text) => {
      const key = keys.get(ciphertextKeyId(text)!)!;
      if (key.spaceId !== scope.spaceId) throw new ContentDecryptionError();
      return decryptText(key, locationOf(scope), text);
    });
  }
  const parsed = TicketWorkStateSchema.safeParse(opened);
  return parsed.success ? { state: parsed.data, invalid: false } : { state: null, invalid: true };
}

async function sealState(
  prisma: PrismaClient,
  scope: TicketWorkStateScope,
  state: TicketWorkState,
): Promise<Prisma.InputJsonValue> {
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > TICKET_WORK_STATE_MAX_BYTES)
    throw new TicketWorkStateConflict("state_too_large");
  const encryption = contentEncryptionOf(prisma);
  if (!encryption?.ring.encryptWrites) return state;
  const key = await encryption.ring.current(scope.spaceId);
  return sealJson(state, new Set(), (text) =>
    encryptText(key, locationOf(scope), text),
  ) as Prisma.InputJsonValue;
}

async function evidenceFor(
  tx: Prisma.TransactionClient,
  scope: TicketWorkStateScope,
  state: Pick<TicketWorkState, "evidenceRefs" | "position" | "pendingCall">,
) {
  const refs = state.position
    ? [...state.evidenceRefs, state.position.evidenceRef]
    : state.evidenceRefs;
  const effectIds = refs.flatMap((ref) => (ref.kind === "effect" ? [ref.effectId] : []));
  if (state.pendingCall?.effectId) effectIds.push(state.pendingCall.effectId);
  const artifactIds = refs.flatMap((ref) => (ref.kind === "artifact" ? [ref.artifactId] : []));
  const effects = effectIds.length
    ? await tx.externalEffect.findMany({
        where: {
          id: { in: effectIds },
          spaceId: scope.spaceId,
          run: { userId: scope.userId, spaceId: scope.spaceId, ticketId: scope.ticketId },
        },
        select: { id: true, kind: true, status: true, result: true, updatedAt: true },
      })
    : [];
  // Effects can commit before the next advisory save, including before the first one.
  const recentEffects = await tx.externalEffect.findMany({
    where: {
      spaceId: scope.spaceId,
      run: { ticketId: scope.ticketId, userId: scope.userId, spaceId: scope.spaceId },
      kind: { notIn: ["runtime_checkpoint", "runtime_configuration"] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 41,
    select: { id: true, kind: true, status: true, result: true, updatedAt: true },
  });
  const candidates = artifactIds.length
    ? await tx.artifact.findMany({
        where: {
          id: { in: artifactIds },
          spaceId: scope.spaceId,
          userId: scope.userId,
        },
        select: { id: true, version: true, hash: true, runId: true },
      })
    : [];
  const sources = candidates.length
    ? await tx.run.findMany({
        where: {
          id: { in: candidates.flatMap((artifact) => (artifact.runId ? [artifact.runId] : [])) },
          ticketId: scope.ticketId,
          spaceId: scope.spaceId,
          userId: scope.userId,
        },
        select: { id: true },
      })
    : [];
  const sourceIds = new Set(sources.map((run) => run.id));
  const artifacts = candidates
    .filter((artifact) => artifact.runId && sourceIds.has(artifact.runId))
    .map(({ id, version, hash }) => ({ id, version, hash }));
  return {
    effects: [
      ...new Map(
        [...recentEffects.slice(0, 40), ...effects].map((effect) => [effect.id, effect]),
      ).values(),
    ],
    effectsTruncated: recentEffects.length > 40,
    artifacts,
  };
}

export async function loadTicketWorkState(
  prisma: PrismaClient,
  scope: TicketWorkStateScope,
): Promise<TicketWorkStateRecord> {
  return prisma.$transaction(async (tx) => {
    const ticket = await requireScope(tx, scope);
    const decoded = await readState(prisma, scope, ticket.workState);
    const evidence = await evidenceFor(
      tx,
      scope,
      decoded.state ?? { evidenceRefs: [], position: null, pendingCall: null },
    );
    const configuration = decoded.state?.configurationRef
      ? await tx.externalEffect.findFirst({
          where: {
            id: decoded.state.configurationRef,
            spaceId: scope.spaceId,
            runId: decoded.state.sourceRunId,
            kind: "runtime_configuration",
            status: "runtime_configuration",
            run: { ticketId: scope.ticketId, userId: scope.userId, spaceId: scope.spaceId },
          },
          select: { id: true },
        })
      : null;
    return {
      ticketId: ticket.id,
      version: ticket.workStateVersion,
      requirementsVersion: requirementsVersion(ticket.fileDeliveryRequirements),
      ...decoded,
      configurationAvailable: Boolean(configuration),
      ...evidence,
    };
  });
}

async function lockWriter(
  tx: Prisma.TransactionClient,
  input: TicketWorkStateScope & { lease: RunLease },
) {
  // Ticket updates already lock ticket before run when binding an assignee.
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${input.ticketId} AND "spaceId" = ${input.spaceId} FOR UPDATE`;
  const ticket = await requireScope(tx, input);
  const locked = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      ticketId: input.ticketId,
      status: "running",
      leaseOwner: input.lease.owner,
      leaseFence: input.lease.fence,
      leaseExpiresAt: { gt: new Date() },
    },
    data: { leaseFence: input.lease.fence },
  });
  if (locked.count !== 1) throw new TicketWorkStateLeaseError();
  return ticket;
}

export async function saveTicketWorkState(
  prisma: PrismaClient,
  input: SaveTicketWorkStateInput,
): Promise<TicketWorkStateRecord> {
  const update = TicketWorkStateUpdateSchema.parse({
    expectedVersion: input.expectedVersion,
    expectedRequirementsVersion: input.expectedRequirementsVersion,
    state: input.state,
  });
  const environment = TicketWorkEnvironmentSchema.nullable().parse(input.environment);
  const requestedPendingCall =
    input.pendingCall === undefined
      ? undefined
      : TicketWorkPendingCallSchema.nullable().parse(input.pendingCall);
  return prisma.$transaction(async (tx) => {
    const ticket = await lockWriter(tx, input);
    if (ticket.workStateVersion !== update.expectedVersion)
      throw new TicketWorkStateConflict("version_changed");
    const currentRequirementsVersion = requirementsVersion(ticket.fileDeliveryRequirements);
    if (currentRequirementsVersion !== update.expectedRequirementsVersion)
      throw new TicketWorkStateConflict("requirements_changed");
    if (ticket.status === "done" || ticket.status === "closed")
      throw new TicketWorkStateConflict("version_changed");
    const previous = await readState(prisma, input, ticket.workState);
    if (previous.invalid) throw new TicketWorkStateConflict("invalid_state");
    const pendingCall =
      requestedPendingCall === undefined
        ? (previous.state?.pendingCall ?? null)
        : requestedPendingCall;
    if (input.configurationRef) {
      const configuration = await tx.externalEffect.findFirst({
        where: {
          id: input.configurationRef,
          spaceId: input.spaceId,
          runId: input.runId,
          kind: "runtime_configuration",
          status: "runtime_configuration",
        },
        select: { id: true },
      });
      if (!configuration) throw new IsolationError();
    }
    const state: TicketWorkState = {
      ...update.state,
      schemaVersion: 1,
      requirementsVersion: currentRequirementsVersion,
      sourceRunId: input.runId,
      updatedAt: new Date().toISOString(),
      environment,
      configurationRef: input.configurationRef,
      pendingCall,
      progress: previous.state?.progress ?? null,
    };
    const evidence = await evidenceFor(tx, input, state);
    for (const ref of [
      ...state.evidenceRefs,
      ...(state.position ? [state.position.evidenceRef] : []),
    ]) {
      if (ref.kind === "effect") {
        if (!evidence.effects.some((effect) => effect.id === ref.effectId))
          throw new IsolationError();
      } else {
        const artifact = evidence.artifacts.find((item) => item.id === ref.artifactId);
        if (!artifact) throw new IsolationError();
        if (
          artifact.version !== ref.version ||
          artifact.hash.toLowerCase() !== ref.hash.toLowerCase()
        )
          throw new TicketWorkStateConflict("evidence_changed");
      }
    }
    if (
      pendingCall?.effectId &&
      !evidence.effects.some((effect) => effect.id === pendingCall.effectId)
    )
      throw new IsolationError();
    const saved = await tx.ticket.updateMany({
      where: {
        id: input.ticketId,
        spaceId: input.spaceId,
        workStateVersion: update.expectedVersion,
      },
      data: {
        workState: await sealState(prisma, input, state),
        workStateVersion: { increment: 1 },
      },
    });
    if (saved.count !== 1) throw new TicketWorkStateConflict("version_changed");
    return {
      ticketId: input.ticketId,
      version: update.expectedVersion + 1,
      requirementsVersion: currentRequirementsVersion,
      state,
      invalid: false,
      configurationAvailable: Boolean(input.configurationRef),
      ...evidence,
    };
  });
}

type TicketWorkHostWrite = TicketWorkStateScope & {
  lease: RunLease;
  expectedVersion: number;
  expectedRequirementsVersion: number | null;
};

async function mergeHostState(
  prisma: PrismaClient,
  input: TicketWorkHostWrite,
  patch: Pick<TicketWorkState, "progress"> | Pick<TicketWorkState, "pendingCall">,
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const ticket = await lockWriter(tx, input);
    if (
      ticket.workStateVersion !== input.expectedVersion ||
      requirementsVersion(ticket.fileDeliveryRequirements) !== input.expectedRequirementsVersion ||
      ticket.status === "done" ||
      ticket.status === "closed"
    )
      return null;
    const previous = await readState(prisma, input, ticket.workState);
    if (previous.invalid || !previous.state) return null;
    if ("pendingCall" in patch && patch.pendingCall?.effectId) {
      const effect = await tx.externalEffect.findFirst({
        where: {
          id: patch.pendingCall.effectId,
          spaceId: input.spaceId,
          runId: input.runId,
        },
        select: { id: true },
      });
      if (!effect) throw new IsolationError();
    }
    const state = { ...previous.state, ...patch };
    const saved = await tx.ticket.updateMany({
      where: {
        id: input.ticketId,
        spaceId: input.spaceId,
        workStateVersion: input.expectedVersion,
      },
      data: {
        workState: await sealState(prisma, input, state),
        workStateVersion: { increment: 1 },
      },
    });
    return saved.count === 1 ? input.expectedVersion + 1 : null;
  });
}

/** Host-only merge. Stale observations never reload and retry against a newer revision. */
export async function saveTicketWorkProgress(
  prisma: PrismaClient,
  input: TicketWorkHostWrite & { checkpoint: TicketProgressCheckpoint },
): Promise<number | null> {
  const checkpoint = TicketProgressCheckpointSchema.parse(input.checkpoint);
  if (checkpoint.requirementsVersion !== input.expectedRequirementsVersion) return null;
  return mergeHostState(prisma, input, { progress: checkpoint });
}

/** A reference to the existing turn checkpoint, never a new pause or environment observation. */
export async function saveTicketWorkPendingCall(
  prisma: PrismaClient,
  input: TicketWorkHostWrite & { pendingCall: TicketWorkPendingCall | null },
): Promise<number | null> {
  const pendingCall = TicketWorkPendingCallSchema.nullable().parse(input.pendingCall);
  return mergeHostState(prisma, input, { pendingCall });
}
