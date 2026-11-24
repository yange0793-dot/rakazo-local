import type { TicketProgressCheckpoint, TicketWorkStateDraft } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import type { DataKey } from "./content-crypto.js";
import { IsolationError } from "./scope.js";
import type { SaveTicketWorkStateInput, TicketWorkStateScope } from "./ticket-work-state.js";
import {
  loadTicketWorkState,
  saveTicketWorkProgress,
  saveTicketWorkState,
} from "./ticket-work-state.js";

const scope: TicketWorkStateScope = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  ticketId: "ticket-1",
  runId: "run-1",
};
const environment = {
  computerId: "computer-1",
  snapshotRef: "home-revision-1",
  runtimeRevision: "runtime-1",
  toolRevision: "tools-1",
};
const draft: TicketWorkStateDraft = {
  goal: "Complete the report",
  constraints: ["Keep the original source"],
  evidenceRefs: [
    { kind: "effect", effectId: "effect-1" },
    { kind: "artifact", artifactId: "artifact-1", version: 1, hash: "a".repeat(64) },
  ],
  nextStep: "Check the output",
  blocker: null,
  wait: { kind: "input", reference: "original-tool-call" },
  position: {
    summary: "Created the file",
    evidenceRef: { kind: "artifact", artifactId: "artifact-1", version: 1, hash: "a".repeat(64) },
  },
};
const progress: TicketProgressCheckpoint = {
  schemaVersion: 1,
  requirementsVersion: 1,
  lastBoundaryId: "boundary-1",
  lastCheckAt: 100,
  lastProgressAt: 50,
  seenEvidence: ["a".repeat(64)],
  evidenceSaturated: false,
  lastRepeatKey: null,
  repeatedChecks: 2,
  replanIssued: true,
  wait: null,
  lastDecision: { action: "continue", reason: "no_new_evidence" },
  judge: {
    attempts: 1,
    tokensSubtotal: 20,
    costUsdSubtotal: 0.01,
    unknownTokenAttempts: 0,
    unknownCostAttempts: 0,
  },
};

function fixture(encrypted = false) {
  const ticket = {
    id: scope.ticketId,
    spaceId: scope.spaceId,
    createdByUserId: scope.userId,
    assigneeBotId: scope.botId,
    status: "doing",
    completedAt: null,
    workState: null as Prisma.JsonValue | null,
    workStateVersion: 0,
    fileDeliveryRequirements: {
      version: 1,
      items: [{ id: "report", kind: "artifact", description: "Report" }],
    },
  };
  const run = {
    id: scope.runId,
    spaceId: scope.spaceId,
    userId: scope.userId,
    botId: scope.botId,
    ticketId: scope.ticketId,
    status: "running",
    leaseOwner: "worker-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    checkpoint: "original-human-wait-call",
  };
  const authorization = { member: true, botArchived: false, spaceDeleting: false };
  const effect = {
    id: "effect-1",
    kind: "send",
    status: "ambiguous",
    result: null as Prisma.JsonValue | null,
    updatedAt: new Date(),
  };
  const artifact = {
    id: "artifact-1",
    spaceId: scope.spaceId,
    userId: scope.userId,
    runId: scope.runId,
    version: 1,
    hash: "a".repeat(64),
  };
  const key: DataKey = {
    id: "fixture-key",
    spaceId: scope.spaceId,
    version: 1,
    key: new Uint8Array(32).fill(8),
  };
  const matchesRun = (where: Record<string, unknown>) =>
    (["id", "spaceId", "userId", "botId", "ticketId"] as const).every(
      (field) => where[field] === undefined || where[field] === run[field],
    );
  const updateMany = vi.fn(async ({ where, data }) => {
    if (where.workStateVersion !== ticket.workStateVersion) return { count: 0 };
    ticket.workState = data.workState;
    ticket.workStateVersion += data.workStateVersion.increment;
    return { count: 1 };
  });
  const client = {
    $contentEncryption: () =>
      encrypted
        ? { ring: { encryptWrites: true, current: async () => key, byId: async () => key } }
        : undefined,
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(client),
    $queryRaw: vi.fn(async () => [{ id: ticket.id }]),
    ticket: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === ticket.id &&
        where.spaceId === ticket.spaceId &&
        where.createdByUserId === ticket.createdByUserId &&
        where.assigneeBotId === ticket.assigneeBotId
          ? { ...ticket }
          : null,
      ),
      updateMany,
    },
    run: {
      findFirst: vi.fn(async ({ where }) =>
        matchesRun(where) &&
        authorization.member &&
        !authorization.botArchived &&
        !authorization.spaceDeleting
          ? { id: run.id }
          : null,
      ),
      findMany: vi.fn(async ({ where }) =>
        where.id.in.includes(artifact.runId) &&
        where.spaceId === run.spaceId &&
        where.userId === run.userId &&
        where.ticketId === run.ticketId
          ? [{ id: artifact.runId }]
          : [],
      ),
      updateMany: vi.fn(async ({ where }) => ({
        count:
          matchesRun(where) &&
          where.status === run.status &&
          where.leaseOwner === run.leaseOwner &&
          where.leaseFence === run.leaseFence &&
          run.leaseExpiresAt > where.leaseExpiresAt.gt
            ? 1
            : 0,
      })),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }) =>
        (!where.id || where.id.in.includes(effect.id)) &&
        where.spaceId === scope.spaceId &&
        where.run.userId === scope.userId &&
        where.run.ticketId === scope.ticketId
          ? [{ ...effect }]
          : [],
      ),
      findFirst: vi.fn(async ({ where }) =>
        where.id === "configuration-1" && where.spaceId === scope.spaceId ? { id: where.id } : null,
      ),
    },
    artifact: {
      findMany: vi.fn(async ({ where }) =>
        where.id.in.includes(artifact.id) &&
        where.spaceId === artifact.spaceId &&
        where.userId === artifact.userId
          ? [{ ...artifact }]
          : [],
      ),
    },
  };
  const input: SaveTicketWorkStateInput = {
    ...scope,
    lease: { owner: "worker-1", fence: 1 },
    expectedVersion: 0,
    expectedRequirementsVersion: 1,
    state: structuredClone(draft),
    environment,
    configurationRef: "configuration-1",
    pendingCall: { toolCallId: "original-tool-call", toolName: "send", effectId: effect.id },
  };
  return {
    prisma: client as unknown as PrismaClient,
    client,
    ticket,
    run,
    effect,
    artifact,
    input,
    authorization,
    updateMany,
  };
}

describe("ticket work state persistence", () => {
  it("starts absent without fabricating historical acceptance", async () => {
    const f = fixture();
    f.client.externalEffect.findMany.mockResolvedValue([]);
    expect(await loadTicketWorkState(f.prisma, scope)).toMatchObject({
      version: 0,
      state: null,
      invalid: false,
      effects: [],
    });
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("loads effects committed before the first advisory state save", async () => {
    const f = fixture();
    expect(await loadTicketWorkState(f.prisma, scope)).toMatchObject({
      state: null,
      version: 0,
      effects: [{ id: "effect-1", status: "ambiguous" }],
    });
  });

  it("preserves unreferenced durable effects in a save response", async () => {
    const f = fixture();
    const saved = await saveTicketWorkState(f.prisma, {
      ...f.input,
      state: { ...draft, evidenceRefs: [], position: null },
      pendingCall: null,
    });
    expect(saved.effects).toEqual([f.effect]);
    expect(saved.state?.evidenceRefs).toEqual([]);
  });

  it("writes encrypted state, then restores it through a new client with the same key", async () => {
    const f = fixture(true);
    const saved = await saveTicketWorkState(f.prisma, f.input);
    expect(saved.version).toBe(1);
    expect(JSON.stringify(f.ticket.workState)).not.toContain(draft.goal);
    expect(JSON.stringify(f.ticket.workState)).toContain("$sealed");
    const restarted = { ...f.prisma } as PrismaClient;
    expect(await loadTicketWorkState(restarted, scope)).toMatchObject({
      version: 1,
      state: { goal: draft.goal, sourceRunId: scope.runId, requirementsVersion: 1 },
      effects: [{ id: "effect-1", status: "ambiguous" }],
      configurationAvailable: true,
    });
    expect(f.ticket.status).toBe("doing");
    expect(f.ticket.completedAt).toBeNull();
    expect(f.run.checkpoint).toBe("original-human-wait-call");
  });

  it("allows exactly one CAS writer and rejects stale and parallel updates", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      saveTicketWorkState(f.prisma, f.input),
      saveTicketWorkState(f.prisma, { ...f.input, state: { ...draft, nextStep: "Different" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(f.ticket.workStateVersion).toBe(1);
    await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toMatchObject({
      reason: "version_changed",
    });
  });

  it.each(["userId", "spaceId", "botId", "runId", "ticketId"] as const)(
    "rejects a different %s on read and write",
    async (field) => {
      const f = fixture();
      const wrong = { ...scope, [field]: "unrelated" };
      await expect(loadTicketWorkState(f.prisma, wrong)).rejects.toBeInstanceOf(IsolationError);
      await expect(saveTicketWorkState(f.prisma, { ...f.input, ...wrong })).rejects.toBeInstanceOf(
        IsolationError,
      );
      expect(f.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["member", "botArchived", "spaceDeleting"] as const)(
    "checks current %s authorization before touching state",
    async (field) => {
      const f = fixture();
      f.authorization[field] = field !== "member";
      await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toBeInstanceOf(IsolationError);
      expect(f.updateMany).not.toHaveBeenCalled();
    },
  );

  it("rejects a ticket created by another user in the same space", async () => {
    const f = fixture();
    f.ticket.createdByUserId = "other-user";
    await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toBeInstanceOf(IsolationError);
  });

  it("fences a lost worker and permits the new lease without changing human wait identity", async () => {
    const f = fixture();
    await saveTicketWorkState(f.prisma, f.input);
    f.run.leaseOwner = "worker-2";
    f.run.leaseFence = 2;
    await expect(saveTicketWorkState(f.prisma, { ...f.input, expectedVersion: 1 })).rejects.toThrow(
      "lease expired",
    );
    const saved = await saveTicketWorkState(f.prisma, {
      ...f.input,
      expectedVersion: 1,
      lease: { owner: "worker-2", fence: 2 },
      pendingCall: undefined,
    });
    expect(saved.version).toBe(2);
    expect(saved.state?.pendingCall?.toolCallId).toBe("original-tool-call");
    expect(f.run.checkpoint).toBe("original-human-wait-call");
  });

  it.each(["expired", "waiting_input", "completed"])("rejects an %s lease", async (status) => {
    const f = fixture();
    if (status === "expired") f.run.leaseExpiresAt = new Date(0);
    else f.run.status = status;
    await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toThrow("lease expired");
    expect(f.updateMany).not.toHaveBeenCalled();
  });

  it("fences requirements revisions while retaining old evidence and state for recovery", async () => {
    const f = fixture();
    await saveTicketWorkState(f.prisma, f.input);
    f.ticket.fileDeliveryRequirements.version = 2;
    await expect(
      saveTicketWorkState(f.prisma, { ...f.input, expectedVersion: 1 }),
    ).rejects.toMatchObject({ reason: "requirements_changed" });
    expect(await loadTicketWorkState(f.prisma, scope)).toMatchObject({
      requirementsVersion: 2,
      state: { requirementsVersion: 1, evidenceRefs: draft.evidenceRefs },
    });
  });

  it("rejects cross-scope effects, artifacts and configuration references", async () => {
    for (const change of [
      { state: { ...draft, evidenceRefs: [{ kind: "effect", effectId: "other-effect" }] } },
      {
        state: {
          ...draft,
          evidenceRefs: [
            { kind: "artifact", artifactId: "other-file", version: 1, hash: "a".repeat(64) },
          ],
        },
      },
      { configurationRef: "other-config" },
    ]) {
      const f = fixture();
      await expect(saveTicketWorkState(f.prisma, { ...f.input, ...change })).rejects.toBeInstanceOf(
        IsolationError,
      );
      expect(f.updateMany).not.toHaveBeenCalled();
    }
  });

  it("rejects a changed artifact revision instead of treating it as the same evidence", async () => {
    const f = fixture();
    f.artifact.version = 2;
    await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toMatchObject({
      reason: "evidence_changed",
    });
  });

  it("merges only host progress and preserves its budget on ordinary updates and requirements changes", async () => {
    const f = fixture(true);
    await saveTicketWorkState(f.prisma, f.input);
    const progressInput = {
      ...scope,
      lease: f.input.lease,
      expectedVersion: 1,
      expectedRequirementsVersion: 1,
      checkpoint: progress,
    };
    expect(await saveTicketWorkProgress(f.prisma, progressInput)).toBe(2);
    expect(await saveTicketWorkProgress(f.prisma, progressInput)).toBeNull();
    f.ticket.fileDeliveryRequirements.version = 2;
    const saved = await saveTicketWorkState(f.prisma, {
      ...f.input,
      expectedVersion: 2,
      expectedRequirementsVersion: 2,
      state: { ...draft, nextStep: "Check revised requirements" },
    });
    expect(saved.state?.progress).toEqual(progress);
    expect(saved.state?.goal).toBe(draft.goal);
    await expect(
      saveTicketWorkState(f.prisma, {
        ...f.input,
        expectedVersion: 3,
        expectedRequirementsVersion: 2,
        state: { ...draft, progress: null },
      }),
    ).rejects.toThrow();
  });

  it("does not initialize a progress budget from missing, corrupt or future state", async () => {
    const f = fixture();
    expect(
      await saveTicketWorkProgress(f.prisma, {
        ...scope,
        lease: f.input.lease,
        expectedVersion: 0,
        expectedRequirementsVersion: 1,
        checkpoint: progress,
      }),
    ).toBeNull();
    f.ticket.workState = { schemaVersion: 9, progress: { replanIssued: true } };
    expect(await loadTicketWorkState(f.prisma, scope)).toMatchObject({
      invalid: true,
      state: null,
    });
    await expect(saveTicketWorkState(f.prisma, f.input)).rejects.toMatchObject({
      reason: "invalid_state",
    });
  });

  it("rejects ciphertext moved between ticket rows", async () => {
    const f = fixture(true);
    await saveTicketWorkState(f.prisma, f.input);
    f.ticket.id = "ticket-2";
    f.run.ticketId = "ticket-2";
    await expect(
      loadTicketWorkState(f.prisma, { ...scope, ticketId: "ticket-2" }),
    ).rejects.toThrow();
  });
});
