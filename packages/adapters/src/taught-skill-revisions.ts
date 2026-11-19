import { createHash, randomUUID } from "node:crypto";
import type { Actor, SkillPlaybook } from "@rakazo/contracts";
import { SkillPlaybookSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError, openTaughtSkillSnapshot, sealTaughtSkillSnapshot } from "@rakazo/db";
import { z } from "zod";
import { emptyRecording, parsePlaybook } from "./teaching-session.js";

const ScopeSchema = z
  .object({
    project: z
      .object({ computerId: z.string().min(1), path: z.string().min(1) })
      .strict()
      .optional(),
    taskFamilies: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type TaughtSkillRevisionScope = z.infer<typeof ScopeSchema>;
export type TaughtSkillRevisionContext = TaughtSkillRevisionScope;

const TrialSchema = z
  .object({
    artifactId: z.string().min(1),
    version: z.number().int().positive(),
    hash: z.string().min(1),
    baselineRevisionId: z.string().min(1),
    baselineGeneration: z.number().int().nonnegative(),
    candidatePlaybookHash: z.string().length(64),
    outcome: z.enum(["improved", "tie", "insufficient", "regressed"]),
    improvedCases: z.number().int().nonnegative(),
    protectedCasesPassed: z.boolean(),
    falsePasses: z.number().int().nonnegative(),
    withinBudget: z.boolean(),
    rubricVersion: z.string().min(1),
  })
  .strict();

/** A host-written trial verdict, never a model's assertion that its own candidate passed. */
export type TaughtSkillRevisionTrial = z.infer<typeof TrialSchema>;

const SnapshotSchema = z
  .object({
    name: z.string(),
    goal: z.string(),
    playbook: SkillPlaybookSchema,
    scope: ScopeSchema,
    trial: TrialSchema.optional(),
  })
  .strict();

const RevisionSchema = z
  .object({
    id: z.string(),
    skillId: z.string(),
    spaceId: z.string(),
    botId: z.string(),
    userId: z.string(),
    previousRevisionId: z.string().nullable(),
    createdAt: z.coerce.date(),
    snapshot: SnapshotSchema,
  })
  .strict();

export type TaughtSkillRevision = z.infer<typeof RevisionSchema>;

export type TaughtSkillRevisionActivation =
  | { status: "activated"; revision: TaughtSkillRevision }
  | { status: "conflict"; currentRevisionId: string }
  | { status: "no_previous"; currentRevisionId: string }
  | {
      status: "not_adopted";
      reason: "missing_evidence" | "tie" | "insufficient" | "regressed" | "unqualified";
    };

export class TaughtSkillRevisionConflictError extends Error {
  constructor() {
    super("Skill changed; read its current revision first");
    this.name = "TaughtSkillRevisionConflictError";
  }
}

export class TaughtSkillRevisionStateError extends Error {
  constructor() {
    super("Finish recording before saving a skill revision");
    this.name = "TaughtSkillRevisionStateError";
  }
}

type RevisionActor = Pick<Actor, "spaceId" | "userId">;
type Tx = Prisma.TransactionClient;
type SkillRow = {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  name: string;
  goal: string;
  status: string;
  playbook: unknown;
  currentRevisionId: string | null;
  currentRevisionGeneration: number;
};
type RevisionRow = Omit<TaughtSkillRevision, "snapshot"> & { snapshot: unknown };
type PinRow = {
  id: string;
  spaceId: string;
  runId: string;
  snapshot: unknown;
};

const ChangesSchema = z
  .object({
    skillId: z.string().min(1),
    name: z.string().optional(),
    playbook: SkillPlaybookSchema.optional(),
    scope: ScopeSchema.optional(),
  })
  .strict();
type RevisionChanges = z.infer<typeof ChangesSchema>;

/** The trial and saved candidate hash the same structured procedure, independent of key order. */
export function taughtSkillPlaybookHash(playbook: SkillPlaybook): string {
  const {
    whenToUse,
    inputs,
    steps,
    howToCheck,
    whatToReturn,
    approvalBoundaries,
    failureHandling,
  } = playbook;
  return createHash("sha256")
    .update(
      JSON.stringify({
        whenToUse,
        inputs,
        steps,
        howToCheck,
        whatToReturn,
        approvalBoundaries,
        failureHandling,
      }),
    )
    .digest("hex");
}

/** Exact structured matching. Paths and family tags must come from the caller's task context. */
export function taughtSkillRevisionApplies(
  scope: TaughtSkillRevisionScope,
  context: TaughtSkillRevisionContext,
): boolean {
  return (
    (!scope.project ||
      (scope.project.computerId === context.project?.computerId &&
        scope.project.path === context.project.path)) &&
    (!scope.taskFamilies?.length ||
      scope.taskFamilies.some((family) => context.taskFamilies?.includes(family)))
  );
}

async function lockedSkill(tx: Tx, actor: RevisionActor, skillId: string): Promise<SkillRow> {
  const [skill] = await tx.$queryRaw<SkillRow[]>`
    SELECT id, "spaceId", "botId", "userId", name, goal, status, playbook, "currentRevisionId", "currentRevisionGeneration"
    FROM taught_skills WHERE id = ${skillId} AND "spaceId" = ${actor.spaceId} FOR UPDATE`;
  if (!skill) throw new IsolationError();
  if (skill.status !== "draft" && skill.status !== "saved")
    throw new TaughtSkillRevisionStateError();
  return skill;
}

async function readRevision(
  prisma: PrismaClient,
  tx: Pick<Tx, "$queryRaw">,
  actor: RevisionActor,
  skillId: string,
  revisionId: string,
): Promise<TaughtSkillRevision> {
  const [row] = await tx.$queryRaw<RevisionRow[]>`
    SELECT * FROM taught_skill_revisions
    WHERE id = ${revisionId} AND "spaceId" = ${actor.spaceId} AND "skillId" = ${skillId}`;
  if (!row) throw new IsolationError();
  const snapshot = await openTaughtSkillSnapshot(
    prisma,
    { table: "taught_skill_revisions", rowId: row.id, spaceId: row.spaceId, owner: row.skillId },
    row.snapshot,
  );
  return RevisionSchema.parse({ ...row, snapshot });
}

async function appendRevision(
  prisma: PrismaClient,
  tx: Tx,
  skill: SkillRow,
  userId: string,
  previousRevisionId: string | null,
  snapshot: TaughtSkillRevision["snapshot"],
): Promise<TaughtSkillRevision> {
  const id = randomUUID();
  const sealed = await sealTaughtSkillSnapshot(
    prisma,
    { table: "taught_skill_revisions", rowId: id, spaceId: skill.spaceId, owner: skill.id },
    snapshot,
  );
  const [row] = await tx.$queryRaw<RevisionRow[]>`
    INSERT INTO taught_skill_revisions
      (id, "spaceId", "skillId", "botId", "userId", "previousRevisionId", snapshot)
    VALUES (${id}, ${skill.spaceId}, ${skill.id}, ${skill.botId}, ${userId},
      ${previousRevisionId}, ${JSON.stringify(sealed)}::jsonb)
    RETURNING *`;
  return { ...row!, snapshot };
}

async function currentRevision(
  prisma: PrismaClient,
  tx: Tx,
  actor: RevisionActor,
  skill: SkillRow,
): Promise<TaughtSkillRevision> {
  if (skill.status !== "saved") throw new TaughtSkillRevisionStateError();
  if (skill.currentRevisionId)
    return readRevision(prisma, tx, actor, skill.id, skill.currentRevisionId);
  const revision = await appendRevision(prisma, tx, skill, skill.userId, null, {
    name: skill.name,
    goal: skill.goal,
    playbook: parsePlaybook(skill.playbook),
    scope: {},
  });
  // This is the first observed saved version, not evidence of any earlier editing history.
  await tx.$executeRaw`
    UPDATE taught_skills SET "currentRevisionId" = ${revision.id}
    WHERE id = ${skill.id} AND "spaceId" = ${actor.spaceId}`;
  skill.currentRevisionId = revision.id;
  return revision;
}

async function applyRevision(
  tx: Tx,
  actor: RevisionActor,
  skill: SkillRow,
  revision: TaughtSkillRevision,
): Promise<void> {
  const { name, goal, playbook } = revision.snapshot;
  const count = await tx.$executeRaw`
    UPDATE taught_skills SET "currentRevisionId" = ${revision.id},
      "currentRevisionGeneration" = "currentRevisionGeneration" + 1, status = 'saved',
      name = ${name}, goal = ${goal}, playbook = ${JSON.stringify(playbook)}::jsonb,
      recording = CASE WHEN "userId" = ${actor.userId} THEN recording
        ELSE ${JSON.stringify(emptyRecording())}::jsonb END,
      "userId" = ${actor.userId}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${skill.id} AND "spaceId" = ${actor.spaceId}
      AND "currentRevisionId" IS NOT DISTINCT FROM ${skill.currentRevisionId}
      AND "currentRevisionGeneration" = ${skill.currentRevisionGeneration}`;
  if (count !== 1) throw new TaughtSkillRevisionConflictError();
}

async function checkProjectScope(
  tx: Tx,
  actor: RevisionActor,
  skill: SkillRow,
  scope: TaughtSkillRevisionScope,
) {
  if (!scope.project) return;
  const bot = await tx.bot.findFirst({
    where: { id: skill.botId, spaceId: actor.spaceId, computerId: scope.project.computerId },
    select: { id: true },
  });
  if (!bot) throw new IsolationError();
}

export async function getCurrentTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  skillId: string,
): Promise<TaughtSkillRevision> {
  return (await getCurrentTaughtSkillRevisionState(prisma, actor, skillId)).revision;
}

/** Capture this before trial work; the generation also detects a switch away and back. */
export async function getCurrentTaughtSkillRevisionState(
  prisma: PrismaClient,
  actor: RevisionActor,
  skillId: string,
): Promise<{ revision: TaughtSkillRevision; generation: number }> {
  return prisma.$transaction(async (tx) => {
    const skill = await lockedSkill(tx, actor, skillId);
    const revision = await currentRevision(prisma, tx, actor, skill);
    return { revision, generation: skill.currentRevisionGeneration };
  });
}

/** Historical reads do not require the live skill to still exist. */
export async function getTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: { skillId: string; revisionId: string },
): Promise<TaughtSkillRevision> {
  return readRevision(prisma, prisma, actor, input.skillId, input.revisionId);
}

/** Human edits always append; an already-saved legacy skill keeps its old contents as r1. */
export async function saveTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: RevisionChanges,
): Promise<TaughtSkillRevision> {
  const changes = ChangesSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const skill = await lockedSkill(tx, actor, changes.skillId);
    const previous =
      skill.status === "saved" ? await currentRevision(prisma, tx, actor, skill) : null;
    const scope = changes.scope ?? previous?.snapshot.scope ?? {};
    if (changes.scope) await checkProjectScope(tx, actor, skill, changes.scope);
    const revision = await appendRevision(prisma, tx, skill, actor.userId, previous?.id ?? null, {
      name: changes.name ?? skill.name,
      goal: skill.goal,
      playbook: changes.playbook ?? parsePlaybook(skill.playbook),
      scope,
    });
    await applyRevision(tx, actor, skill, revision);
    return revision;
  });
}

/** Snapshot a trial candidate without making it effective. Trial evidence is immutable too. */
export async function snapshotTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: RevisionChanges & {
    expectedCurrentRevisionId?: string | null;
    trial?: TaughtSkillRevisionTrial;
  },
): Promise<TaughtSkillRevision> {
  const changes = ChangesSchema.extend({
    expectedCurrentRevisionId: z.string().min(1).nullable().optional(),
    trial: TrialSchema.optional(),
  }).parse(input);
  return prisma.$transaction(async (tx) => {
    const skill = await lockedSkill(tx, actor, changes.skillId);
    const current = await currentRevision(prisma, tx, actor, skill);
    if (
      (changes.expectedCurrentRevisionId !== undefined &&
        changes.expectedCurrentRevisionId !== current.id) ||
      (changes.trial &&
        (changes.trial.baselineRevisionId !== current.id ||
          changes.trial.baselineGeneration !== skill.currentRevisionGeneration))
    )
      throw new TaughtSkillRevisionConflictError();
    const scope = changes.scope ?? current.snapshot.scope;
    if (changes.scope) await checkProjectScope(tx, actor, skill, changes.scope);
    return appendRevision(prisma, tx, skill, actor.userId, current.id, {
      name: changes.name ?? current.snapshot.name,
      goal: current.snapshot.goal,
      playbook: changes.playbook ?? current.snapshot.playbook,
      scope,
      ...(changes.trial ? { trial: changes.trial } : {}),
    });
  });
}

export async function activateTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: { skillId: string; revisionId: string; expectedCurrentRevisionId: string },
): Promise<TaughtSkillRevisionActivation> {
  return prisma.$transaction(async (tx) => {
    const skill = await lockedSkill(tx, actor, input.skillId);
    const current = await currentRevision(prisma, tx, actor, skill);
    const revision = await readRevision(prisma, tx, actor, skill.id, input.revisionId);
    if (current.id !== input.expectedCurrentRevisionId)
      return { status: "conflict", currentRevisionId: current.id };
    const trial = revision.snapshot.trial;
    if (!trial) return { status: "not_adopted", reason: "missing_evidence" };
    if (
      trial.baselineRevisionId !== current.id ||
      revision.previousRevisionId !== current.id ||
      trial.baselineGeneration !== skill.currentRevisionGeneration
    )
      return { status: "conflict", currentRevisionId: current.id };
    if (trial.outcome !== "improved") return { status: "not_adopted", reason: trial.outcome };
    if (trial.candidatePlaybookHash !== taughtSkillPlaybookHash(revision.snapshot.playbook))
      return { status: "not_adopted", reason: "missing_evidence" };
    if (
      !trial.improvedCases ||
      !trial.protectedCasesPassed ||
      trial.falsePasses ||
      !trial.withinBudget
    )
      return { status: "not_adopted", reason: "unqualified" };
    const evidence = await tx.artifact.findFirst({
      where: {
        id: trial.artifactId,
        spaceId: actor.spaceId,
        botId: skill.botId,
        userId: actor.userId,
        groupId: null,
        version: trial.version,
        hash: trial.hash,
        mimeType: "application/json",
      },
      select: { id: true },
    });
    if (!evidence) return { status: "not_adopted", reason: "missing_evidence" };
    await applyRevision(tx, actor, skill, revision);
    return { status: "activated", revision };
  });
}

export async function rollbackTaughtSkillRevision(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: { skillId: string; expectedCurrentRevisionId: string },
): Promise<TaughtSkillRevisionActivation> {
  return prisma.$transaction(async (tx) => {
    const skill = await lockedSkill(tx, actor, input.skillId);
    const current = await currentRevision(prisma, tx, actor, skill);
    if (current.id !== input.expectedCurrentRevisionId)
      return { status: "conflict", currentRevisionId: current.id };
    if (!current.previousRevisionId)
      return { status: "no_previous", currentRevisionId: current.id };
    const revision = await readRevision(prisma, tx, actor, skill.id, current.previousRevisionId);
    await applyRevision(tx, actor, skill, revision);
    return { status: "activated", revision };
  });
}

async function openPin(prisma: PrismaClient, pin: PinRow): Promise<TaughtSkillRevision> {
  return RevisionSchema.parse(
    await openTaughtSkillSnapshot(
      prisma,
      {
        table: "run_taught_skill_revisions",
        rowId: pin.id,
        spaceId: pin.spaceId,
        owner: pin.runId,
      },
      pin.snapshot,
    ),
  );
}

export async function listPinnedTaughtSkillRevisions(
  prisma: PrismaClient,
  actor: RevisionActor,
  runId: string,
): Promise<TaughtSkillRevision[]> {
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!run) throw new IsolationError();
  const pins = await prisma.$queryRaw<PinRow[]>`
    SELECT id, "spaceId", "runId", snapshot FROM run_taught_skill_revisions
    WHERE "runId" = ${runId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
    ORDER BY "pinnedAt", id`;
  return Promise.all(pins.map((pin) => openPin(prisma, pin)));
}

/** First use wins across processes. Recovery reads the pin before the live skill or scope. */
export async function pinTaughtSkillRevisionToRun(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: {
    runId: string;
    skillId: string;
    revisionId?: string;
    context: TaughtSkillRevisionContext;
  },
): Promise<TaughtSkillRevision | null> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.findFirst({
      where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true, botId: true },
    });
    if (!run) throw new IsolationError();
    const existing = await tx.$queryRaw<PinRow[]>`
      SELECT id, "spaceId", "runId", snapshot FROM run_taught_skill_revisions
      WHERE "runId" = ${run.id} AND "skillId" = ${input.skillId}
        AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}`;
    if (existing[0]) return openPin(prisma, existing[0]);
    const context = ScopeSchema.parse(input.context);
    const skill = await lockedSkill(tx, actor, input.skillId);
    if (skill.status !== "saved") throw new TaughtSkillRevisionStateError();
    if (skill.botId !== run.botId) throw new IsolationError();
    const revision = input.revisionId
      ? await readRevision(prisma, tx, actor, skill.id, input.revisionId)
      : await currentRevision(prisma, tx, actor, skill);
    if (!taughtSkillRevisionApplies(revision.snapshot.scope, context)) return null;
    const id = randomUUID();
    const sealed = await sealTaughtSkillSnapshot(
      prisma,
      { table: "run_taught_skill_revisions", rowId: id, spaceId: actor.spaceId, owner: run.id },
      revision,
    );
    const inserted = await tx.$queryRaw<PinRow[]>`
      INSERT INTO run_taught_skill_revisions
        (id, "spaceId", "userId", "botId", "runId", "skillId", "revisionId", snapshot)
      VALUES (${id}, ${actor.spaceId}, ${actor.userId}, ${run.botId}, ${run.id}, ${skill.id},
        ${revision.id}, ${JSON.stringify(sealed)}::jsonb)
      ON CONFLICT ("runId", "skillId") DO NOTHING RETURNING id, "spaceId", "runId", snapshot`;
    if (inserted[0]) return revision;
    const [winner] = await tx.$queryRaw<PinRow[]>`
      SELECT id, "spaceId", "runId", snapshot FROM run_taught_skill_revisions
      WHERE "runId" = ${run.id} AND "skillId" = ${skill.id}
        AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}`;
    return openPin(prisma, winner!);
  });
}

export async function listCurrentApplicableTaughtSkillRevisions(
  prisma: PrismaClient,
  actor: RevisionActor,
  input: { botId: string; context: TaughtSkillRevisionContext; includeOtherEditors?: boolean },
): Promise<TaughtSkillRevision[]> {
  const context = ScopeSchema.parse(input.context);
  const skills = await prisma.taughtSkill.findMany({
    where: {
      spaceId: actor.spaceId,
      botId: input.botId,
      status: "saved",
      ...(input.includeOtherEditors ? {} : { userId: actor.userId }),
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  const revisions: TaughtSkillRevision[] = [];
  for (const skill of skills) {
    const revision = await getCurrentTaughtSkillRevision(prisma, actor, skill.id);
    if (taughtSkillRevisionApplies(revision.snapshot.scope, context)) revisions.push(revision);
  }
  return revisions;
}
