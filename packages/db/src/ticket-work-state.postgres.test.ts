import { randomBytes, randomUUID } from "node:crypto";
import type {
  TicketProgressCheckpoint,
  TicketWorkEnvironment,
  TicketWorkStateDraft,
} from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { ContentDecryptionError } from "./content-crypto.js";
import { LocalKeyProvider } from "./content-keys.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import type { SaveTicketWorkStateInput, TicketWorkStateScope } from "./ticket-work-state.js";
import {
  loadTicketWorkState,
  saveTicketWorkPendingCall,
  saveTicketWorkProgress,
  saveTicketWorkState,
  TicketWorkStateConflict,
} from "./ticket-work-state.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const keyProvider = new LocalKeyProvider([
  { id: "ticket-work-state-fixture-key", key: randomBytes(32) },
]);
const environment: TicketWorkEnvironment = {
  computerId: "synthetic-computer",
  snapshotRef: "synthetic-home-revision",
  runtimeRevision: "runtime-v1",
  toolRevision: "tools-v1",
};
const checkpoint: TicketProgressCheckpoint = {
  schemaVersion: 1,
  requirementsVersion: 1,
  lastBoundaryId: "synthetic-boundary",
  lastCheckAt: 200,
  lastProgressAt: 100,
  seenEvidence: ["a".repeat(64)],
  evidenceSaturated: false,
  lastRepeatKey: "b".repeat(64),
  repeatedChecks: 2,
  replanIssued: true,
  wait: null,
  lastDecision: { action: "replan", reason: "judge_confirmed_stall" },
  judge: {
    attempts: 1,
    tokensSubtotal: 300,
    costUsdSubtotal: 0.01,
    unknownTokenAttempts: 0,
    unknownCostAttempts: 0,
  },
};
const requirements = (version: number) => ({
  version,
  items: [{ id: "report", kind: "artifact", description: "Deliver the requested report." }],
});

postgres("ticket work state (isolated PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let restarted: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const organizations: string[] = [];
  const users: string[] = [];
  const system = <T>(work: () => Promise<T>) =>
    runAsSystem("synthetic ticket work-state fixture", work);
  const tenant = <T>(scope: TicketWorkStateScope, work: () => Promise<T>) =>
    runAsTenant(scope, work);

  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.pathname.slice(1).startsWith("rkz_") ||
      !decodeURIComponent(url.username).startsWith("rkz_")
    )
      throw new Error(
        "Ticket work-state PostgreSQL tests require an isolated rkz_ database/login.",
      );
    db = createDb(databaseUrl!, { encryptContent: true, keyProvider });
    restarted = createDb(databaseUrl!, { encryptContent: true, keyProvider });
    prisma = db.prisma;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await system(async () => {
        await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
        await prisma.user.deleteMany({ where: { id: { in: users } } });
      });
    } finally {
      for (const client of [restarted, db]) {
        await client.prisma.$disconnect();
        await client.pool.end();
      }
    }
  });

  async function fixture() {
    return system(async () => {
      const stamp = randomUUID();
      const userId = `work-user-${stamp}`;
      const memberId = `work-member-${stamp}`;
      const organizationId = `work-org-${stamp}`;
      const spaceId = `work-space-${stamp}`;
      const foreignSpaceId = `work-foreign-space-${stamp}`;
      const botId = `work-bot-${stamp}`;
      const memberBotId = `work-member-bot-${stamp}`;
      users.push(userId, memberId);
      organizations.push(organizationId);
      for (const id of [userId, memberId])
        await prisma.user.create({
          data: { id, name: "Synthetic work-state user", email: `${id}@example.test` },
        });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic work-state organization",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      for (const id of [userId, memberId])
        await prisma.member.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId: id,
            role: id === userId ? "owner" : "member",
            createdAt: new Date(),
          },
        });
      for (const id of [spaceId, foreignSpaceId])
        await prisma.space.create({
          data: { id, organizationId, name: "Synthetic work-state space" },
        });
      for (const [space, user] of [
        [spaceId, userId],
        [spaceId, memberId],
        [foreignSpaceId, userId],
      ] as const)
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId: space,
            organizationId,
            userId: user,
            role: user === userId ? "owner" : "member",
            createdAt: new Date(),
          },
        });
      for (const [id, user] of [
        [botId, userId],
        [memberBotId, memberId],
      ] as const)
        await prisma.bot.create({
          data: { id, spaceId, userId: user, name: "Work-state bot", color: "ink" },
        });
      const thread = await prisma.thread.create({ data: { spaceId, userId, botId } });
      const board = await prisma.board.create({ data: { spaceId } });
      const ticket = await prisma.ticket.create({
        data: {
          boardId: board.id,
          spaceId,
          number: 1,
          title: "Synthetic report task",
          status: "doing",
          assigneeBotId: botId,
          createdByUserId: userId,
          fileDeliveryRequirements: requirements(1),
        },
      });
      const otherTicket = await prisma.ticket.create({
        data: {
          boardId: board.id,
          spaceId,
          number: 2,
          title: "Separate synthetic task",
          status: "doing",
          assigneeBotId: botId,
          createdByUserId: userId,
          fileDeliveryRequirements: requirements(1),
        },
      });
      const addRun = async (ticketId: string) => {
        const task = await prisma.task.create({
          data: {
            spaceId,
            userId,
            botId,
            threadId: thread.id,
            prompt: "Synthetic work-state task.",
            status: "running",
          },
        });
        return prisma.run.create({
          data: {
            spaceId,
            userId,
            botId,
            threadId: thread.id,
            taskId: task.id,
            ticketId,
            status: "running",
            trigger: "tickets",
            leaseOwner: "worker-a",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 300_000),
            checkpoint: "original-human-tool-checkpoint",
          },
        });
      };
      const run = await addRun(ticket.id);
      const otherRun = await addRun(otherTicket.id);
      const siblingRun = await addRun(ticket.id);
      const addEffect = async (runId: string, kind: string, status: string) =>
        prisma.externalEffect.create({
          data: {
            spaceId,
            runId,
            kind,
            status,
            idempotencyKey: randomUUID(),
            request: { fixture: true },
            ...(status === "completed" ? { result: { ok: true, receipt: "observed" } } : {}),
          },
        });
      const confirmed = await addEffect(run.id, "upload", "completed");
      const unknown = await addEffect(run.id, "send", "ambiguous");
      const configuration = await addEffect(
        run.id,
        "runtime_configuration",
        "runtime_configuration",
      );
      const otherConfiguration = await addEffect(
        otherRun.id,
        "runtime_configuration",
        "runtime_configuration",
      );
      const siblingConfiguration = await addEffect(
        siblingRun.id,
        "runtime_configuration",
        "runtime_configuration",
      );
      const foreignEffect = await addEffect(otherRun.id, "upload", "completed");
      const artifact = await prisma.artifact.create({
        data: {
          spaceId,
          userId,
          botId,
          runId: run.id,
          name: "synthetic-report.txt",
          mimeType: "text/plain",
          size: 10,
          storageKey: `synthetic-work/${stamp}`,
          hash: "a".repeat(64),
          version: 1,
        },
      });
      const scope: TicketWorkStateScope = {
        spaceId,
        userId,
        botId,
        runId: run.id,
        ticketId: ticket.id,
      };
      const draft: TicketWorkStateDraft = {
        goal: `Private synthetic goal ${stamp}`,
        constraints: [`Private constraint ${stamp}`],
        evidenceRefs: [
          { kind: "effect", effectId: confirmed.id },
          { kind: "effect", effectId: unknown.id },
          { kind: "artifact", artifactId: artifact.id, version: 1, hash: artifact.hash },
        ],
        nextStep: `Private next step ${stamp}`,
        blocker: null,
        wait: { kind: "external", reference: unknown.id },
        position: {
          summary: `Private observed position ${stamp}`,
          evidenceRef: {
            kind: "artifact",
            artifactId: artifact.id,
            version: 1,
            hash: artifact.hash,
          },
        },
      };
      const input: SaveTicketWorkStateInput = {
        ...scope,
        lease: { owner: "worker-a", fence: 1 },
        expectedVersion: 0,
        expectedRequirementsVersion: 1,
        state: draft,
        environment,
        configurationRef: configuration.id,
        pendingCall: { toolCallId: "original-tool-call", toolName: "send", effectId: unknown.id },
      };
      return {
        scope,
        input,
        draft,
        memberId,
        memberBotId,
        foreignSpaceId,
        confirmed,
        unknown,
        artifact,
        configuration,
        otherConfiguration,
        siblingConfiguration,
        foreignEffect,
        otherRun,
        otherTicket,
        siblingRun,
      };
    });
  }

  it("reads effects committed before the first advisory save without inventing saved state", async () => {
    const f = await fixture();
    const record = await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope));
    expect(record).toMatchObject({
      version: 0,
      state: null,
      invalid: false,
      configurationAvailable: false,
    });
    expect(record.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.confirmed.id,
          status: "completed",
          result: { ok: true, receipt: "observed" },
        }),
        expect.objectContaining({ id: f.unknown.id, status: "ambiguous", result: null }),
      ]),
    );
    expect(record.effects.map((effect) => effect.id)).not.toContain(f.foreignEffect.id);
    expect(record.effects.some((effect) => effect.kind === "runtime_configuration")).toBe(false);
  });

  it("keeps existing durable effects in an initialization response with no submitted evidence", async () => {
    const f = await fixture();
    const saved = await tenant(f.scope, () =>
      saveTicketWorkState(prisma, {
        ...f.input,
        state: {
          ...f.draft,
          evidenceRefs: [],
          position: null,
          wait: null,
        },
        pendingCall: null,
      }),
    );
    expect(saved.state?.evidenceRefs).toEqual([]);
    expect(saved.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.confirmed.id, status: "completed" }),
        expect.objectContaining({ id: f.unknown.id, status: "ambiguous" }),
      ]),
    );
  });

  it("persists encrypted text and reloads the same scope with a fresh client", async () => {
    const f = await fixture();
    const saved = await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    expect(saved).toMatchObject({ version: 1, configurationAvailable: true, state: f.draft });
    const raw = await system(() =>
      db.pool.query<{ state: string }>(
        'SELECT "workState"::text AS state FROM tickets WHERE id = $1',
        [f.scope.ticketId],
      ),
    );
    expect(raw.rows[0]!.state).toContain("$sealed");
    for (const text of [
      f.draft.goal,
      f.draft.constraints[0]!,
      f.draft.nextStep!,
      f.draft.position!.summary,
    ])
      expect(raw.rows[0]!.state).not.toContain(text);
    const loaded = await tenant(f.scope, () => loadTicketWorkState(restarted.prisma, f.scope));
    expect(loaded).toMatchObject({
      version: 1,
      requirementsVersion: 1,
      state: {
        ...f.draft,
        sourceRunId: f.scope.runId,
        environment,
        configurationRef: f.configuration.id,
      },
      configurationAvailable: true,
    });
    await tenant(f.scope, async () => {
      expect(await prisma.ticket.findFirst({ where: { id: f.scope.ticketId } })).toMatchObject({
        status: "doing",
        completedAt: null,
        receiptVersion: 0,
      });
      expect(await prisma.run.findFirst({ where: { id: f.scope.runId } })).toMatchObject({
        checkpoint: "original-human-tool-checkpoint",
        leaseOwner: "worker-a",
        leaseFence: 1,
      });
    });
  });

  it("allows one parallel save and rejects the stale state revision", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      tenant(f.scope, () => saveTicketWorkState(prisma, f.input)),
      tenant(f.scope, () =>
        saveTicketWorkState(restarted.prisma, {
          ...f.input,
          state: { ...f.draft, nextStep: "Competing next step" },
        }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      reason: "version_changed",
    });
    await expect(
      tenant(f.scope, () => saveTicketWorkState(prisma, f.input)),
    ).rejects.toBeInstanceOf(TicketWorkStateConflict);
    expect((await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).version).toBe(1);
  });

  it("shares the state CAS with progress and preserves host budgets across ordinary saves", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    const progress = {
      ...f.scope,
      lease: f.input.lease,
      expectedVersion: 1,
      expectedRequirementsVersion: 1,
      checkpoint,
    };
    const outcomes = await Promise.all([
      tenant(f.scope, () => saveTicketWorkProgress(prisma, progress)),
      tenant(f.scope, () => saveTicketWorkProgress(restarted.prisma, progress)),
    ]);
    expect(outcomes.filter((value) => value === 2)).toHaveLength(1);
    expect(outcomes.filter((value) => value === null)).toHaveLength(1);
    const saved = await tenant(f.scope, () =>
      saveTicketWorkState(prisma, {
        ...f.input,
        expectedVersion: 2,
        state: { ...f.draft, nextStep: "Continue after host progress check" },
        pendingCall: undefined,
      }),
    );
    expect(saved.state?.progress).toEqual(checkpoint);
    expect(saved.state?.pendingCall).toEqual(f.input.pendingCall);
    await expect(
      tenant(f.scope, () =>
        saveTicketWorkState(prisma, {
          ...f.input,
          expectedVersion: 3,
          state: { ...f.draft, progress: null },
        }),
      ),
    ).rejects.toThrow();
    expect((await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).version).toBe(3);
  });

  it("fences an old worker on state, progress and pending-call writes", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    await system(() =>
      prisma.run.update({
        where: { id: f.scope.runId },
        data: {
          leaseOwner: "worker-b",
          leaseFence: 2,
          leaseExpiresAt: new Date(Date.now() + 300_000),
        },
      }),
    );
    const stale = { ...f.input, expectedVersion: 1 };
    await expect(tenant(f.scope, () => saveTicketWorkState(prisma, stale))).rejects.toThrow(
      "lease expired",
    );
    await expect(
      tenant(f.scope, () => saveTicketWorkProgress(prisma, { ...stale, checkpoint })),
    ).rejects.toThrow("lease expired");
    await expect(
      tenant(f.scope, () => saveTicketWorkPendingCall(prisma, { ...stale, pendingCall: null })),
    ).rejects.toThrow("lease expired");
    const saved = await tenant(f.scope, () =>
      saveTicketWorkState(prisma, {
        ...stale,
        lease: { owner: "worker-b", fence: 2 },
        pendingCall: undefined,
      }),
    );
    expect(saved.version).toBe(2);
    expect(saved.state?.pendingCall).toEqual(f.input.pendingCall);
    expect(saved.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.confirmed.id, status: "completed" }),
        expect.objectContaining({ id: f.unknown.id, status: "ambiguous" }),
      ]),
    );
  });

  it.each(["expired", "waiting_input", "completed"])(
    "rejects %s runs at the database lease boundary",
    async (status) => {
      const f = await fixture();
      await system(() =>
        prisma.run.update({
          where: { id: f.scope.runId },
          data: status === "expired" ? { leaseExpiresAt: new Date(0) } : { status },
        }),
      );
      await expect(tenant(f.scope, () => saveTicketWorkState(prisma, f.input))).rejects.toThrow(
        "lease expired",
      );
      expect((await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).version).toBe(0);
    },
  );

  it("invalidates a requirements revision without clearing confirmed or unknown effects and progress spend", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    await tenant(f.scope, () =>
      saveTicketWorkProgress(prisma, { ...f.input, expectedVersion: 1, checkpoint }),
    );
    await system(() =>
      prisma.ticket.update({
        where: { id: f.scope.ticketId },
        data: { fileDeliveryRequirements: requirements(2), status: "review" },
      }),
    );
    await expect(
      tenant(f.scope, () => saveTicketWorkState(prisma, { ...f.input, expectedVersion: 2 })),
    ).rejects.toMatchObject({ reason: "requirements_changed" });
    expect(
      await tenant(f.scope, () =>
        saveTicketWorkProgress(prisma, { ...f.input, expectedVersion: 2, checkpoint }),
      ),
    ).toBeNull();
    const stale = await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope));
    expect(stale).toMatchObject({
      version: 2,
      requirementsVersion: 2,
      state: { requirementsVersion: 1, evidenceRefs: f.draft.evidenceRefs, progress: checkpoint },
    });
    expect(stale.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.confirmed.id,
          status: "completed",
          result: { ok: true, receipt: "observed" },
        }),
        expect.objectContaining({ id: f.unknown.id, status: "ambiguous", result: null }),
      ]),
    );
    const current = await tenant(f.scope, () =>
      saveTicketWorkState(prisma, {
        ...f.input,
        expectedVersion: 2,
        expectedRequirementsVersion: 2,
        state: { ...f.draft, nextStep: "Reconcile the revised requirements." },
      }),
    );
    expect(current.state).toMatchObject({ requirementsVersion: 2, progress: checkpoint });
    expect(current.effects).toEqual(
      expect.arrayContaining(
        stale.effects.filter(
          (effect) => effect.id === f.confirmed.id || effect.id === f.unknown.id,
        ),
      ),
    );
    expect(current.effects).toHaveLength(2);
  });

  it("merges pending-call identity without changing progress, environment or the original runtime checkpoint", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    await tenant(f.scope, () =>
      saveTicketWorkProgress(prisma, { ...f.input, expectedVersion: 1, checkpoint }),
    );
    const pendingCall = {
      toolCallId: "paused-tool-call",
      toolName: "send",
      effectId: f.unknown.id,
    };
    expect(
      await tenant(f.scope, () =>
        saveTicketWorkPendingCall(prisma, { ...f.input, expectedVersion: 2, pendingCall }),
      ),
    ).toBe(3);
    expect(
      await tenant(f.scope, () =>
        saveTicketWorkPendingCall(prisma, { ...f.input, expectedVersion: 2, pendingCall: null }),
      ),
    ).toBeNull();
    const state = await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope));
    expect(state.state).toMatchObject({ pendingCall, progress: checkpoint, environment });
    await expect(
      tenant(f.scope, () =>
        saveTicketWorkPendingCall(prisma, {
          ...f.input,
          expectedVersion: 3,
          pendingCall: { ...pendingCall, effectId: f.foreignEffect.id },
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(
      await tenant(f.scope, () => prisma.run.findFirst({ where: { id: f.scope.runId } })),
    ).toMatchObject({
      checkpoint: "original-human-tool-checkpoint",
    });
  });

  it("enforces configuration reference kind, source run, ticket and current availability", async () => {
    const f = await fixture();
    for (const configurationRef of [
      f.otherConfiguration.id,
      f.siblingConfiguration.id,
      f.confirmed.id,
    ]) {
      await expect(
        tenant(f.scope, () => saveTicketWorkState(prisma, { ...f.input, configurationRef })),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    expect((await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).version).toBe(0);
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    const resumedScope = { ...f.scope, runId: f.siblingRun.id };
    expect(
      await tenant(resumedScope, () => loadTicketWorkState(restarted.prisma, resumedScope)),
    ).toMatchObject({
      configurationAvailable: true,
      state: { sourceRunId: f.scope.runId, configurationRef: f.configuration.id },
    });
    await system(() => prisma.externalEffect.delete({ where: { id: f.configuration.id } }));
    expect(await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).toMatchObject({
      configurationAvailable: false,
      state: { configurationRef: f.configuration.id },
    });
  });

  it("rejects an authorized space member who does not own the ticket and scope", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    const memberScope = { ...f.scope, userId: f.memberId, botId: f.memberBotId };
    await expect(
      tenant(memberScope, () => loadTicketWorkState(prisma, memberScope)),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      tenant(memberScope, () =>
        saveTicketWorkState(prisma, { ...f.input, ...memberScope, expectedVersion: 1 }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    const foreignScope = { ...f.scope, spaceId: f.foreignSpaceId };
    await expect(
      tenant(foreignScope, () => loadTicketWorkState(prisma, foreignScope)),
    ).rejects.toBeInstanceOf(IsolationError);
    await system(() =>
      prisma.spaceMember.deleteMany({
        where: { spaceId: f.scope.spaceId, userId: f.scope.userId },
      }),
    );
    await expect(
      tenant(f.scope, () => loadTicketWorkState(prisma, f.scope)),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      tenant(f.scope, () => saveTicketWorkState(prisma, { ...f.input, expectedVersion: 1 })),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("rejects cross-ticket effects and artifact revisions before committing state", async () => {
    const f = await fixture();
    await expect(
      tenant(f.scope, () =>
        saveTicketWorkState(prisma, {
          ...f.input,
          state: { ...f.draft, evidenceRefs: [{ kind: "effect", effectId: f.foreignEffect.id }] },
        }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    await system(() =>
      prisma.artifact.update({
        where: { id: f.artifact.id },
        data: { version: 2, hash: "b".repeat(64) },
      }),
    );
    await expect(tenant(f.scope, () => saveTicketWorkState(prisma, f.input))).rejects.toMatchObject(
      { reason: "evidence_changed" },
    );
    expect((await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope))).version).toBe(0);
  });

  it("rejects encrypted state transplanted to another ticket row", async () => {
    const f = await fixture();
    await tenant(f.scope, () => saveTicketWorkState(prisma, f.input));
    await system(() =>
      db.pool.query(
        'UPDATE tickets SET "workState" = (SELECT "workState" FROM tickets WHERE id = $1), "workStateVersion" = 1 WHERE id = $2',
        [f.scope.ticketId, f.otherTicket.id],
      ),
    );
    const otherScope = { ...f.scope, ticketId: f.otherTicket.id, runId: f.otherRun.id };
    await expect(
      tenant(otherScope, () => loadTicketWorkState(restarted.prisma, otherScope)),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
  });

  it("keeps durable effects readable when a saved state schema is unsupported", async () => {
    const f = await fixture();
    await system(() =>
      prisma.ticket.update({
        where: { id: f.scope.ticketId },
        data: { workState: { schemaVersion: 99 }, workStateVersion: 1 },
      }),
    );
    const record = await tenant(f.scope, () => loadTicketWorkState(prisma, f.scope));
    expect(record).toMatchObject({ invalid: true, state: null, version: 1 });
    expect(record.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.confirmed.id, status: "completed" }),
        expect.objectContaining({ id: f.unknown.id, status: "ambiguous" }),
      ]),
    );
    expect(
      await tenant(f.scope, () =>
        saveTicketWorkProgress(prisma, { ...f.input, expectedVersion: 1, checkpoint }),
      ),
    ).toBeNull();
    await expect(
      tenant(f.scope, () => saveTicketWorkState(prisma, { ...f.input, expectedVersion: 1 })),
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });
});
