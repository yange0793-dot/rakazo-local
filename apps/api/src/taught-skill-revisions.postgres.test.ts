import { randomUUID } from "node:crypto";
import type { Actor, SkillPlaybook } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createThreadEvents,
  IsolationError,
  LocalKeyProvider,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  TaughtSkillRevision,
  TaughtSkillRevisionContext,
  TaughtSkillRevisionTrial,
} from "../../../packages/adapters/src/taught-skill-revisions.js";
import {
  activateTaughtSkillRevision,
  getCurrentTaughtSkillRevision,
  getCurrentTaughtSkillRevisionState,
  getTaughtSkillRevision,
  listCurrentApplicableTaughtSkillRevisions,
  listPinnedTaughtSkillRevisions,
  pinTaughtSkillRevisionToRun,
  rollbackTaughtSkillRevision,
  saveTaughtSkillRevision,
  snapshotTaughtSkillRevision,
  TaughtSkillRevisionConflictError,
  taughtSkillPlaybookHash,
} from "../../../packages/adapters/src/taught-skill-revisions.js";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const pg =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

type Tenant = Actor & { botId: string; threadId: string; computerId: string };
const suffix = randomUUID();
const organizationId = `skill-revision-org-${suffix}`;
const tenants: Tenant[] = ["a", "b"].map((name) => ({
  spaceId: `skill-revision-space-${name}-${suffix}`,
  userId: `skill-revision-user-${name}-${suffix}`,
  email: `skill-revision-${name}-${suffix}@example.test`,
  isDeploymentOwner: false,
  botId: `skill-revision-bot-${name}-${suffix}`,
  threadId: `skill-revision-thread-${name}-${suffix}`,
  computerId: `skill-revision-computer-${name}-${suffix}`,
}));
const [tenant, other] = tenants as [Tenant, Tenant];
const playbook: SkillPlaybook = {
  whenToUse: "Fixture ledger report",
  inputs: ["Synthetic ledger"],
  steps: ["Read the synthetic ledger", "Report the gross total"],
  howToCheck: "Compare with the fixture receipt",
  whatToReturn: "Fixture total",
  approvalBoundaries: "Read only",
  failureHandling: "Report missing evidence",
};
const revisedPlaybook: SkillPlaybook = {
  ...playbook,
  steps: ["Read the synthetic ledger", "Subtract settled refunds", "Report the net total"],
};

pg("saved skill revisions (PostgreSQL)", () => {
  const clients: Array<ReturnType<typeof createDb>> = [];
  let prisma: PrismaClient;
  let service: ReturnType<typeof createTaughtSkillsService>;

  function client() {
    const db = createDb(runtimeUrl!, {
      encryptContent: true,
      keyProvider: new LocalKeyProvider([
        { id: "skill-revision-fixture", key: Buffer.alloc(32, 11) },
      ]),
    });
    clients.push(db);
    return db;
  }

  beforeAll(async () => {
    const db = client();
    prisma = db.prisma;
    const {
      rows: [role],
    } = await db.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    if (role!.rolsuper || role!.rolbypassrls)
      throw new Error("Revision tests require the runtime RLS role");
    await runAsSystem("skill revision fixture", async () => {
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Revision fixture",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      for (const t of tenants) {
        await prisma.user.create({
          data: { id: t.userId, email: t.email, name: "Fixture", emailVerified: false },
        });
        await prisma.space.create({ data: { id: t.spaceId, organizationId, name: "Fixture" } });
        await prisma.computer.create({
          data: {
            id: t.computerId,
            spaceId: t.spaceId,
            userId: t.userId,
            scopeKey: `revision-fixture:${t.spaceId}`,
            homeKey: `revision-home:${t.spaceId}`,
            kind: "fake",
          },
        });
        await prisma.bot.create({
          data: {
            id: t.botId,
            spaceId: t.spaceId,
            userId: t.userId,
            name: "Fixture",
            color: "ink",
            computerId: t.computerId,
          },
        });
        await prisma.thread.create({
          data: { id: t.threadId, spaceId: t.spaceId, userId: t.userId, botId: t.botId },
        });
      }
    });
    service = createTaughtSkillsService({
      prisma,
      events: createThreadEvents(prisma),
    } as TaughtSkillsDeps);
  });

  afterAll(async () => {
    try {
      if (prisma)
        await runAsSystem("skill revision fixture cleanup", async () => {
          await prisma.organization.deleteMany({ where: { id: organizationId } });
          await prisma.user.deleteMany({ where: { id: { in: tenants.map((t) => t.userId) } } });
        });
    } finally {
      for (const db of clients) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  async function skill(t = tenant, status = "draft") {
    return prisma.taughtSkill.create({
      data: {
        spaceId: t.spaceId,
        botId: t.botId,
        userId: t.userId,
        name: "Fixture ledger",
        goal: "Report a synthetic ledger total",
        status,
        playbook,
      },
    });
  }

  async function run(t = tenant) {
    const task = await prisma.task.create({
      data: {
        spaceId: t.spaceId,
        userId: t.userId,
        botId: t.botId,
        threadId: t.threadId,
        prompt: "Run the fixture ledger procedure",
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: t.spaceId,
        userId: t.userId,
        botId: t.botId,
        threadId: t.threadId,
        taskId: task.id,
        trigger: "skill",
        status: "running",
      },
    });
  }

  async function trial(
    baseline: TaughtSkillRevision,
    overrides: Partial<TaughtSkillRevisionTrial> = {},
  ) {
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: tenant.spaceId,
        userId: tenant.userId,
        botId: tenant.botId,
        name: `trial-${randomUUID()}.json`,
        mimeType: "application/json",
        size: 10,
        hash: "synthetic-trial-hash",
        storageKey: `fixture-trial-${randomUUID()}`,
      },
    });
    return {
      artifactId: artifact.id,
      version: artifact.version,
      hash: artifact.hash,
      baselineRevisionId: baseline.id,
      baselineGeneration: (
        await getCurrentTaughtSkillRevisionState(prisma, tenant, baseline.skillId)
      ).generation,
      candidatePlaybookHash: taughtSkillPlaybookHash(revisedPlaybook),
      outcome: "improved" as const,
      improvedCases: 1,
      protectedCasesPassed: true,
      falsePasses: 0,
      withinBudget: true,
      rubricVersion: "fixture-v1",
      ...overrides,
    } satisfies TaughtSkillRevisionTrial;
  }

  const history = (skillId: string) => prisma.$queryRaw<Array<{ id: string; snapshot: unknown }>>`
    SELECT id, snapshot FROM taught_skill_revisions
    WHERE "spaceId" = ${tenant.spaceId} AND "skillId" = ${skillId} ORDER BY "createdAt", id`;

  it("saves r1, edits to r2, restores a run's r1 from storage, and rolls new runs back to r1", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      await service.save(tenant, taught.id);
      const r1 = await getCurrentTaughtSkillRevision(prisma, tenant, taught.id);
      const active = await run();
      expect(
        await pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: active.id,
          skillId: taught.id,
          context: {},
        }),
      ).toEqual(r1);

      await service.updateDraft(tenant, taught.id, {
        name: "Net fixture ledger",
        playbook: revisedPlaybook,
      });
      const r2 = await getCurrentTaughtSkillRevision(prisma, tenant, taught.id);
      expect(r2.previousRevisionId).toBe(r1.id);
      expect(r2.snapshot.playbook).toEqual(revisedPlaybook);
      expect(
        await getTaughtSkillRevision(prisma, tenant, { skillId: taught.id, revisionId: r1.id }),
      ).toEqual(r1);
      const live = await prisma.taughtSkill.findFirstOrThrow({ where: { id: taught.id } });
      expect(live.playbook).toEqual(revisedPlaybook);

      // A new client has no cached skill, snapshot or content key; the resumed run stays on r1.
      const recovered = client().prisma;
      await prisma.run.update({ where: { id: active.id }, data: { checkpoint: "fixture-resume" } });
      expect(
        await pinTaughtSkillRevisionToRun(recovered, tenant, {
          runId: active.id,
          skillId: taught.id,
          revisionId: r2.id,
          context: { project: { computerId: other.computerId, path: "projects/another" } },
        }),
      ).toEqual(r1);
      expect(await listPinnedTaughtSkillRevisions(recovered, tenant, active.id)).toEqual([r1]);

      const onR2 = await run();
      expect(
        await pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: onR2.id,
          skillId: taught.id,
          context: {},
        }),
      ).toEqual(r2);

      expect(
        await rollbackTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: r2.id,
        }),
      ).toEqual({ status: "activated", revision: r1 });
      const next = await run();
      expect(
        await pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: next.id,
          skillId: taught.id,
          context: {},
        }),
      ).toEqual(r1);
      expect(
        await pinTaughtSkillRevisionToRun(recovered, tenant, {
          runId: onR2.id,
          skillId: taught.id,
          context: {},
        }),
      ).toEqual(r2);
      expect(await history(taught.id)).toHaveLength(2);
      expect((await history(taught.id)).map((row) => row.id)).toEqual(
        expect.arrayContaining([r1.id, r2.id]),
      );
      expect(
        await rollbackTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: r2.id,
        }),
      ).toEqual({ status: "conflict", currentRevisionId: r1.id });
    }));

  it("snapshots a legacy saved version once, then preserves it when an editor saves", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill(tenant, "saved");
      const r2 = await saveTaughtSkillRevision(prisma, tenant, {
        skillId: taught.id,
        playbook: revisedPlaybook,
      });
      const rows = await history(taught.id);
      expect(rows).toHaveLength(2);
      expect(r2.previousRevisionId).not.toBeNull();
      expect(
        await rollbackTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: r2.id,
        }),
      ).toMatchObject({ status: "activated", revision: { snapshot: { playbook } } });
      await getCurrentTaughtSkillRevision(prisma, tenant, taught.id);
      expect(await history(taught.id)).toHaveLength(2);
      const raw = JSON.stringify(rows);
      expect(raw).toContain("$sealed");
      expect(raw).not.toContain("Synthetic ledger");
      // Tenant SQL cannot rewrite or erase a historical snapshot.
      expect(
        await prisma.$executeRaw`UPDATE taught_skill_revisions SET snapshot = '{}'::jsonb WHERE id = ${rows[0]!.id}`,
      ).toBe(0);
      expect(
        await prisma.$executeRaw`DELETE FROM taught_skill_revisions WHERE id = ${rows[0]!.id}`,
      ).toBe(0);
    }));

  it("keeps ties, missing evidence and failed safeguards out of the live version", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      const baseline = await saveTaughtSkillRevision(prisma, tenant, { skillId: taught.id });
      const cases: Array<[Partial<TaughtSkillRevisionTrial> | null, string]> = [
        [null, "missing_evidence"],
        [{ outcome: "tie" }, "tie"],
        [{ outcome: "insufficient" }, "insufficient"],
        [{ outcome: "regressed" }, "regressed"],
        [{ improvedCases: 0 }, "unqualified"],
        [{ protectedCasesPassed: false }, "unqualified"],
        [{ falsePasses: 1 }, "unqualified"],
        [{ withinBudget: false }, "unqualified"],
        [{ artifactId: "missing-fixture-artifact" }, "missing_evidence"],
        [{ candidatePlaybookHash: taughtSkillPlaybookHash(playbook) }, "missing_evidence"],
        [{ hash: "wrong-fixture-hash" }, "missing_evidence"],
        [{ version: 2 }, "missing_evidence"],
      ];
      for (const [overrides, reason] of cases) {
        const candidate = await snapshotTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          playbook: revisedPlaybook,
          expectedCurrentRevisionId: baseline.id,
          ...(overrides ? { trial: await trial(baseline, overrides) } : {}),
        });
        expect(
          await activateTaughtSkillRevision(prisma, tenant, {
            skillId: taught.id,
            revisionId: candidate.id,
            expectedCurrentRevisionId: baseline.id,
          }),
        ).toEqual({ status: "not_adopted", reason });
        expect((await getCurrentTaughtSkillRevision(prisma, tenant, taught.id)).id).toBe(
          baseline.id,
        );
      }
    }));

  it("adopts one qualified candidate by CAS and refuses a stale competing trial", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      const baseline = await saveTaughtSkillRevision(prisma, tenant, { skillId: taught.id });
      const evidence = await trial(baseline);
      const candidates = await Promise.all(
        [1, 2].map((n) =>
          snapshotTaughtSkillRevision(prisma, tenant, {
            skillId: taught.id,
            name: `Qualified fixture ${n}`,
            playbook: revisedPlaybook,
            expectedCurrentRevisionId: baseline.id,
            trial: evidence,
          }),
        ),
      );
      expect((await getCurrentTaughtSkillRevision(prisma, tenant, taught.id)).id).toBe(baseline.id);
      const results = await Promise.all(
        candidates.map((candidate) =>
          activateTaughtSkillRevision(prisma, tenant, {
            skillId: taught.id,
            revisionId: candidate.id,
            expectedCurrentRevisionId: baseline.id,
          }),
        ),
      );
      expect(results.filter((result) => result.status === "activated")).toHaveLength(1);
      expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
      await expect(
        snapshotTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: baseline.id,
          playbook: revisedPlaybook,
        }),
      ).rejects.toBeInstanceOf(TaughtSkillRevisionConflictError);
      expect(await history(taught.id)).toHaveLength(3);
      const winner = await getCurrentTaughtSkillRevision(prisma, tenant, taught.id);
      expect(
        await rollbackTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: winner.id,
        }),
      ).toMatchObject({ status: "activated", revision: { id: baseline.id } });
      // r1 is current again, but the old queued trials must not undo this explicit rollback.
      for (const candidate of candidates)
        expect(
          await activateTaughtSkillRevision(prisma, tenant, {
            skillId: taught.id,
            revisionId: candidate.id,
            expectedCurrentRevisionId: baseline.id,
          }),
        ).toEqual({ status: "conflict", currentRevisionId: baseline.id });
      // A trial finishing after the rollback is stale too, even before a candidate exists.
      await expect(
        snapshotTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: baseline.id,
          playbook: revisedPlaybook,
          trial: evidence,
        }),
      ).rejects.toBeInstanceOf(TaughtSkillRevisionConflictError);
      expect(await history(taught.id)).toHaveLength(3);
    }));

  it("selects only matching structured project and family scopes", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      const context = {
        project: { computerId: tenant.computerId, path: "projects/ledger" },
        taskFamilies: ["ledger.net"],
      };
      const revision = await saveTaughtSkillRevision(prisma, tenant, {
        skillId: taught.id,
        scope: context,
      });
      const contains = async (value: TaughtSkillRevisionContext) =>
        (
          await listCurrentApplicableTaughtSkillRevisions(prisma, tenant, {
            botId: tenant.botId,
            context: value,
          })
        ).some((row) => row.id === revision.id);
      expect(await contains(context)).toBe(true);
      for (const exception of [
        {},
        { ...context, taskFamilies: ["ledger.gross"] },
        { ...context, project: { ...context.project, path: "projects/ledger-other" } },
        { ...context, project: { ...context.project, computerId: other.computerId } },
      ])
        expect(await contains(exception)).toBe(false);
      const active = await run();
      expect(
        await pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: active.id,
          skillId: taught.id,
          context: {},
        }),
      ).toBeNull();
      expect(await listPinnedTaughtSkillRevisions(prisma, tenant, active.id)).toEqual([]);
      expect(
        await pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: active.id,
          skillId: taught.id,
          context,
        }),
      ).toEqual(revision);
      await expect(
        saveTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          scope: { project: { computerId: other.computerId, path: "projects/ledger" } },
        }),
      ).rejects.toBeInstanceOf(IsolationError);
      const anotherBot = await prisma.bot.create({
        data: {
          spaceId: tenant.spaceId,
          userId: tenant.userId,
          name: "Other fixture",
          color: "ink",
        },
      });
      const anotherThread = await prisma.thread.create({
        data: {
          spaceId: tenant.spaceId,
          userId: tenant.userId,
          botId: anotherBot.id,
        },
      });
      const anotherRun = await run({ ...tenant, botId: anotherBot.id, threadId: anotherThread.id });
      await expect(
        pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: anotherRun.id,
          skillId: taught.id,
          context,
        }),
      ).rejects.toBeInstanceOf(IsolationError);
    }));

  it("keeps the first pin when two clients select different revisions concurrently", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      const r1 = await saveTaughtSkillRevision(prisma, tenant, { skillId: taught.id });
      const r2 = await saveTaughtSkillRevision(prisma, tenant, {
        skillId: taught.id,
        playbook: revisedPlaybook,
      });
      const active = await run();
      const secondClient = client().prisma;
      const pins = await Promise.all([
        pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: active.id,
          skillId: taught.id,
          revisionId: r1.id,
          context: {},
        }),
        pinTaughtSkillRevisionToRun(secondClient, tenant, {
          runId: active.id,
          skillId: taught.id,
          revisionId: r2.id,
          context: {},
        }),
      ]);
      expect(pins[0]).toEqual(pins[1]);
      expect([r1.id, r2.id]).toContain(pins[0]!.id);
      expect(await listPinnedTaughtSkillRevisions(secondClient, tenant, active.id)).toEqual([
        pins[0],
      ]);
    }));

  it("refuses another tenant's skill, run, revision and evidence", async () => {
    const foreign = await runAsTenant(other, async () => {
      const taught = await skill(other);
      const revision = await saveTaughtSkillRevision(prisma, other, { skillId: taught.id });
      const evidence = await prisma.artifact.create({
        data: {
          spaceId: other.spaceId,
          userId: other.userId,
          botId: other.botId,
          name: "foreign-fixture.json",
          mimeType: "application/json",
          size: 10,
          hash: "foreign-fixture-hash",
          storageKey: `foreign-fixture-${randomUUID()}`,
        },
      });
      return { taught, revision, run: await run(other), evidence };
    });
    await runAsTenant(tenant, async () => {
      await expect(
        getCurrentTaughtSkillRevision(prisma, tenant, foreign.taught.id),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        saveTaughtSkillRevision(prisma, tenant, { skillId: foreign.taught.id }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        rollbackTaughtSkillRevision(prisma, tenant, {
          skillId: foreign.taught.id,
          expectedCurrentRevisionId: foreign.revision.id,
        }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: foreign.run.id,
          skillId: foreign.taught.id,
          context: {},
        }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        listPinnedTaughtSkillRevisions(prisma, tenant, foreign.run.id),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(
        await prisma.$queryRaw`SELECT id FROM taught_skill_revisions WHERE id = ${foreign.revision.id}`,
      ).toEqual([]);
      const taught = await skill();
      const baseline = await saveTaughtSkillRevision(prisma, tenant, { skillId: taught.id });
      await expect(
        activateTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          revisionId: foreign.revision.id,
          expectedCurrentRevisionId: baseline.id,
        }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        snapshotTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          expectedCurrentRevisionId: foreign.revision.id,
        }),
      ).rejects.toBeInstanceOf(TaughtSkillRevisionConflictError);
      const candidate = await snapshotTaughtSkillRevision(prisma, tenant, {
        skillId: taught.id,
        playbook: revisedPlaybook,
        trial: await trial(baseline, {
          artifactId: foreign.evidence.id,
          version: foreign.evidence.version,
          hash: foreign.evidence.hash,
        }),
      });
      expect(
        await activateTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          revisionId: candidate.id,
          expectedCurrentRevisionId: baseline.id,
        }),
      ).toEqual({ status: "not_adopted", reason: "missing_evidence" });
      await expect(prisma.$executeRaw`
          UPDATE taught_skills SET "currentRevisionId" = ${foreign.revision.id} WHERE id = ${taught.id}
        `).rejects.toThrow(/foreign key/i);
      await expect(prisma.$executeRaw`
          INSERT INTO taught_skill_revisions
            (id, "spaceId", "skillId", "botId", "userId", "previousRevisionId", snapshot)
          VALUES (${randomUUID()}, ${tenant.spaceId}, ${taught.id}, ${tenant.botId}, ${tenant.userId},
            ${foreign.revision.id}, '{}'::jsonb)
        `).rejects.toThrow(/foreign key/i);
    });
  });

  it("deletes the live skill without erasing or inventing history and keeps its run fixed", () =>
    runAsTenant(tenant, async () => {
      const taught = await skill();
      const revision = await saveTaughtSkillRevision(prisma, tenant, { skillId: taught.id });
      const active = await run();
      await pinTaughtSkillRevisionToRun(prisma, tenant, {
        runId: active.id,
        skillId: taught.id,
        context: {},
      });
      const before = await history(taught.id);
      await service.remove(tenant, taught.id);
      expect(
        await getTaughtSkillRevision(prisma, tenant, {
          skillId: taught.id,
          revisionId: revision.id,
        }),
      ).toEqual(revision);
      expect(await history(taught.id)).toEqual(before);
      const legacy = await skill(tenant, "saved");
      expect(await history(legacy.id)).toEqual([]);
      await service.remove(tenant, legacy.id);
      expect(await history(legacy.id)).toEqual([]);
      await expect(getCurrentTaughtSkillRevision(prisma, tenant, legacy.id)).rejects.toBeInstanceOf(
        IsolationError,
      );
      expect(
        await pinTaughtSkillRevisionToRun(client().prisma, tenant, {
          runId: active.id,
          skillId: taught.id,
          context: {},
        }),
      ).toEqual(revision);
      expect(await listPinnedTaughtSkillRevisions(prisma, tenant, active.id)).toEqual([revision]);
      expect(
        (
          await listCurrentApplicableTaughtSkillRevisions(prisma, tenant, {
            botId: tenant.botId,
            context: {},
          })
        ).some((row) => row.skillId === taught.id),
      ).toBe(false);
      const next = await run();
      await expect(
        pinTaughtSkillRevisionToRun(prisma, tenant, {
          runId: next.id,
          skillId: taught.id,
          context: {},
        }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(
        snapshotTaughtSkillRevision(prisma, tenant, { skillId: taught.id }),
      ).rejects.toBeInstanceOf(IsolationError);
      await expect(prisma.$executeRaw`
      INSERT INTO taught_skill_revisions (id, "spaceId", "skillId", "botId", "userId", snapshot)
      VALUES (${randomUUID()}, ${tenant.spaceId}, ${taught.id}, ${tenant.botId}, ${tenant.userId}, '{}'::jsonb)
    `).rejects.toThrow(/row-level security/i);
      expect(await history(taught.id)).toEqual(before);
    }));
});
