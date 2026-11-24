import { Buffer } from "node:buffer";
import type {
  ImprovementComponentReceipt,
  ImprovementComponentSet,
  SkillPlaybook,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  openTaughtSkillSnapshot,
  sealTaughtSkillSnapshot,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type {
  TaughtSkillRevision,
  TaughtSkillRevisionContext,
  TaughtSkillRevisionScope,
  TaughtSkillRevisionTrial,
} from "./taught-skill-revisions.js";
import {
  activateTaughtSkillRevision,
  pinTaughtSkillRevisionToRun,
  rollbackTaughtSkillRevision,
  saveTaughtSkillRevision,
  snapshotTaughtSkillRevision,
  taughtSkillComponentSetHash,
  taughtSkillPlaybookHash,
  taughtSkillRevisionApplies,
  taughtSkillRevisionHash,
} from "./taught-skill-revisions.js";
import {
  prepareWorkImprovementComponents,
  workImprovementComponentHash,
  workImprovementComponentReceipts,
} from "./work-improvement-components.js";

const project = { computerId: "computer-fixture", path: "projects/ledger" };
const scope: TaughtSkillRevisionScope = { project, taskFamilies: ["ledger.net"] };

describe("trial candidate identity", () => {
  const playbook: SkillPlaybook = {
    whenToUse: "Fixture report",
    inputs: [],
    steps: ["Read the fixture"],
    howToCheck: "Compare the fixture",
    whatToReturn: "The fixture result",
    approvalBoundaries: "Read only",
    failureHandling: "Report missing evidence",
  };

  it("uses structured fields instead of object insertion order", () => {
    const reversed = Object.fromEntries(Object.entries(playbook).reverse()) as SkillPlaybook;
    expect(taughtSkillPlaybookHash(reversed)).toBe(taughtSkillPlaybookHash(playbook));
  });

  it("distinguishes a candidate procedure from the procedure its trial measured", () => {
    expect(
      taughtSkillPlaybookHash({ ...playbook, steps: [...playbook.steps, "Check the target tree"] }),
    ).not.toBe(taughtSkillPlaybookHash(playbook));
  });

  it("binds the immutable candidate hash to both the playbook and exact component revisions", () => {
    const components: ImprovementComponentSet = {
      schemaVersion: "improvement-components.v1",
      items: [
        {
          id: "guidance",
          revision: "1",
          kind: "task_guidance",
          text: "Use the uploaded receipt.",
        },
      ],
    };
    expect(taughtSkillRevisionHash(playbook, components)).not.toBe(
      taughtSkillRevisionHash(playbook),
    );
    expect(
      taughtSkillRevisionHash(playbook, {
        ...components,
        items: [{ ...components.items[0]!, revision: "2" }],
      }),
    ).not.toBe(taughtSkillRevisionHash(playbook, components));
  });
});

const initialComponents: ImprovementComponentSet = {
  schemaVersion: "improvement-components.v1",
  items: [
    {
      id: "guidance",
      revision: "1",
      kind: "task_guidance",
      text: "Use the completed receipt.",
    },
  ],
};
const changedComponents: ImprovementComponentSet = {
  schemaVersion: "improvement-components.v1",
  items: [
    {
      id: "guidance",
      revision: "2",
      kind: "task_guidance",
      text: "Check the receipt and complete directory.",
    },
  ],
};
const savedPlaybook: SkillPlaybook = {
  whenToUse: "Fixture report",
  inputs: [],
  steps: ["Read the fixture"],
  howToCheck: "Compare the fixture",
  whatToReturn: "The fixture result",
  approvalBoundaries: "Read only",
  failureHandling: "Report missing evidence",
};

const qualifiedTrial: TaughtSkillRevisionTrial = {
  artifactId: "trial-artifact",
  version: 1,
  hash: "b".repeat(64),
  baselineRevisionId: "revision-current",
  baselineGeneration: 4,
  candidatePlaybookHash: taughtSkillPlaybookHash(savedPlaybook),
  outcome: "improved",
  improvedCases: 1,
  protectedCasesPassed: true,
  falsePasses: 0,
  withinBudget: true,
  rubricVersion: "fixture-rubric.v1",
};
const toolRuntime = { tools: true, scripted: false };

function revisionStore(snapshotComponents: ImprovementComponentSet | null = initialComponents) {
  const actor = { spaceId: "space-fixture", userId: "user-fixture" };
  const currentSkill = {
    id: "skill-fixture",
    spaceId: actor.spaceId,
    botId: "bot-fixture",
    userId: actor.userId,
    name: "Fixture skill",
    goal: "Verify fixture evidence.",
    status: "saved",
    playbook: savedPlaybook,
    currentRevisionId: "revision-current",
    currentRevisionGeneration: 4,
  };
  const bot = {
    id: currentSkill.botId,
    archivedAt: null as Date | null,
    disabledBuiltinTools: [] as string[],
  };
  const rows = new Map<string, Record<string, unknown>>([
    [
      "revision-current",
      {
        id: "revision-current",
        skillId: currentSkill.id,
        spaceId: currentSkill.spaceId,
        botId: currentSkill.botId,
        userId: currentSkill.userId,
        previousRevisionId: null,
        createdAt: new Date("2026-11-20T00:00:00Z"),
        snapshot: {
          name: currentSkill.name,
          goal: currentSkill.goal,
          playbook: savedPlaybook,
          ...(snapshotComponents ? { components: snapshotComponents } : {}),
          scope: {},
        },
      },
    ],
  ]);
  const pins = new Map<string, Record<string, unknown>>();
  const queryRaw = async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
    const sql = strings.join(" ");
    if (sql.includes("FROM taught_skills")) return [structuredClone(currentSkill)] as T;
    if (sql.includes("INSERT INTO taught_skill_revisions")) {
      const [id, spaceId, skillId, botId, userId, previousRevisionId, snapshot] = values;
      const row = {
        id,
        skillId,
        spaceId,
        botId,
        userId,
        previousRevisionId,
        createdAt: new Date("2026-11-21T00:00:00Z"),
        snapshot: JSON.parse(String(snapshot)),
      };
      rows.set(String(id), row);
      return [row] as T;
    }
    if (sql.includes("FROM taught_skill_revisions")) {
      const row = rows.get(String(values[0]));
      return (row ? [structuredClone(row)] : []) as T;
    }
    if (sql.includes("INSERT INTO run_taught_skill_revisions")) {
      const [id, spaceId, userId, botId, runId, skillId, revisionId, snapshot] = values;
      const pin = {
        id,
        spaceId,
        runId,
        userId,
        botId,
        skillId,
        revisionId,
        snapshot: JSON.parse(String(snapshot)),
      };
      pins.set(`${runId}:${skillId}`, pin);
      return [pin] as T;
    }
    if (sql.includes("FROM run_taught_skill_revisions")) {
      const runId = String(values[0]);
      const skillIdPosition = sql.includes('"skillId"') ? 1 : undefined;
      const skillId = skillIdPosition === undefined ? undefined : String(values[skillIdPosition]);
      return [...pins.values()]
        .filter((pin) => pin.runId === runId && (!skillId || pin.skillId === skillId))
        .map((pin) => structuredClone(pin)) as T;
    }
    return [] as T;
  };
  const executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("UPDATE taught_skills")) {
      const revision = rows.get(String(values[0])) as {
        snapshot: TaughtSkillRevision["snapshot"];
      };
      currentSkill.currentRevisionId = String(values[0]);
      currentSkill.currentRevisionGeneration++;
      currentSkill.name = revision.snapshot.name;
      currentSkill.goal = revision.snapshot.goal;
      currentSkill.playbook = revision.snapshot.playbook;
    }
    return 1;
  };
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    run: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        botId: currentSkill.botId,
      }),
    },
    artifact: { findFirst: async () => ({ id: "trial-artifact" }) },
    bot: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; spaceId: string; archivedAt?: null };
      }) =>
        where.id === bot.id &&
        where.spaceId === actor.spaceId &&
        (where.archivedAt !== null || !bot.archivedAt)
          ? structuredClone(bot)
          : null,
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
    run: { findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
  } as unknown as PrismaClient;
  return { actor, bot, currentSkill, rows, pins, prisma };
}

const toolComponents: ImprovementComponentSet = {
  schemaVersion: "improvement-components.v1",
  items: [
    {
      id: "reader",
      revision: "1",
      kind: "plugin",
      capabilityId: "isolated.snapshot.read_file",
    },
    {
      id: "lister",
      revision: "1",
      kind: "plugin",
      capabilityId: "isolated.snapshot.list_files",
    },
  ],
};

describe("component-bearing taught skill revisions", () => {
  it("preserves components on a playbook-only edit and snapshots an exact candidate set", async () => {
    const store = revisionStore();
    const edited = await saveTaughtSkillRevision(store.prisma, store.actor, {
      skillId: "skill-fixture",
      playbook: { ...savedPlaybook, steps: ["Check the receipt"] },
    });
    expect(edited.snapshot.components).toEqual(initialComponents);

    const candidate = await snapshotTaughtSkillRevision(store.prisma, store.actor, {
      skillId: "skill-fixture",
      playbook: { ...savedPlaybook, steps: ["Check the complete receipt"] },
      components: changedComponents,
      expectedCurrentRevisionId: edited.id,
    });
    expect(candidate.snapshot.components).toEqual(changedComponents);
  });

  it("keeps old run pins fixed through rollback while a new run pins the restored set", async () => {
    const store = revisionStore();
    const edited = await saveTaughtSkillRevision(store.prisma, store.actor, {
      skillId: "skill-fixture",
      components: changedComponents,
    });
    const firstPin = await pinTaughtSkillRevisionToRun(store.prisma, store.actor, {
      runId: "run-fixture",
      skillId: "skill-fixture",
      context: {},
    });
    expect(firstPin?.snapshot.components).toEqual(changedComponents);

    const rollback = await rollbackTaughtSkillRevision(store.prisma, store.actor, {
      skillId: "skill-fixture",
      expectedCurrentRevisionId: edited.id,
    });
    expect(rollback.status).toBe("activated");
    if (rollback.status !== "activated") throw new Error("Expected rollback activation");
    expect(rollback.revision.snapshot.components).toEqual(initialComponents);

    const secondPin = await pinTaughtSkillRevisionToRun(store.prisma, store.actor, {
      runId: "run-fixture-2",
      skillId: "skill-fixture",
      context: {},
    });
    expect(secondPin?.snapshot.components).toEqual(initialComponents);
    const storedFirstPin = store.pins.get("run-fixture:skill-fixture")!;
    await expect(
      openTaughtSkillSnapshot(
        store.prisma,
        {
          table: "run_taught_skill_revisions",
          rowId: String(storedFirstPin.id),
          spaceId: String(storedFirstPin.spaceId),
          owner: String(storedFirstPin.runId),
        },
        storedFirstPin.snapshot,
      ),
    ).resolves.toMatchObject({ snapshot: { components: changedComponents } });
  });

  it.each(["missing", "unsupported", "valid"] as const)(
    "activation %s component proof",
    async (fault) => {
      const store = revisionStore();
      const component = initialComponents.items[0]!;
      const receipt: ImprovementComponentReceipt = {
        schemaVersion: "improvement-component-receipt.v1",
        componentId: component.id,
        componentRevision: component.revision,
        componentKind: component.kind,
        componentHash: workImprovementComponentHash(component),
        status: fault === "unsupported" ? "unsupported" : "applied",
        runId: "trial-run",
        skillRevision: "candidate-trial-revision",
        skillHash: taughtSkillPlaybookHash(savedPlaybook),
        instructionsHash: "a".repeat(64),
        capabilities: [],
        executions: [],
      };
      const proof = {
        eligible: true,
        componentSetHash: taughtSkillComponentSetHash(initialComponents),
        candidateRevision: "candidate-trial-revision",
        expectedRuns: 1,
        runs:
          fault === "missing"
            ? [{ caseId: "case-1", runId: "trial-run", receipts: [] }]
            : [{ caseId: "case-1", runId: "trial-run", receipts: [receipt] }],
      };
      const trial = {
        ...qualifiedTrial,
        candidateSnapshotHash: taughtSkillRevisionHash(savedPlaybook, initialComponents),
        componentProof: proof,
      };
      const candidate = {
        id: "revision-candidate",
        skillId: "skill-fixture",
        spaceId: store.actor.spaceId,
        botId: "bot-fixture",
        userId: store.actor.userId,
        previousRevisionId: "revision-current",
        createdAt: new Date("2026-11-22T00:00:00Z"),
        snapshot: {
          name: "Fixture skill",
          goal: "Verify fixture evidence.",
          playbook: savedPlaybook,
          components: initialComponents,
          scope: {},
          trial,
        },
      };
      store.rows.set(candidate.id, candidate);
      const input = {
        skillId: "skill-fixture",
        revisionId: candidate.id,
        expectedCurrentRevisionId: "revision-current",
        runtimeCapabilities: { tools: false, scripted: false },
      };
      const result = await activateTaughtSkillRevision(store.prisma, store.actor, input);
      if (fault === "valid") expect(result).toMatchObject({ status: "activated" });
      else
        expect(result).toMatchObject({
          status: "not_adopted",
          reason: fault === "missing" ? "missing_evidence" : "unqualified",
        });
    },
  );

  it.each([
    { reason: "read_file is disabled", disabled: [" read_file "], runtime: toolRuntime },
    { reason: "list_files is disabled", disabled: ["list_files"], runtime: toolRuntime },
    { reason: "the bot is archived", archived: true, runtime: toolRuntime },
    { reason: "the runtime has no tools", runtime: { ...toolRuntime, tools: false } },
    { reason: "the runtime is scripted", runtime: { ...toolRuntime, scripted: true } },
    { reason: "production capabilities are missing" },
  ])("keeps the current revision when $reason despite valid isolated evidence", async (test) => {
    const store = revisionStore();
    const baseline = structuredClone(store.currentSkill);
    const plan = prepareWorkImprovementComponents(toolComponents, toolRuntime);
    const receipts = workImprovementComponentReceipts({
      plan,
      runId: "trial-run",
      skillRevision: "trial-candidate",
      skillHash: qualifiedTrial.candidatePlaybookHash,
      instructionsHash: "a".repeat(64),
      runtimeInvoked: true,
      executions: plan.tools.map(({ name }) => ({
        name,
        executionId: `trial-run:${name}`,
        status: "succeeded",
        result: { fixture: name },
      })),
      scriptExecutionIds: new Map(),
    });
    expect(receipts.map(({ status }) => status)).toEqual(["loaded", "loaded"]);
    const candidate = await snapshotTaughtSkillRevision(store.prisma, store.actor, {
      skillId: baseline.id,
      components: toolComponents,
      expectedCurrentRevisionId: baseline.currentRevisionId,
      trial: {
        ...qualifiedTrial,
        candidateSnapshotHash: taughtSkillRevisionHash(savedPlaybook, toolComponents),
        componentProof: {
          eligible: true,
          componentSetHash: taughtSkillComponentSetHash(toolComponents),
          candidateRevision: "trial-candidate",
          expectedRuns: 1,
          runs: [{ caseId: "case-1", runId: "trial-run", receipts }],
        },
      },
    });
    const input = {
      skillId: baseline.id,
      revisionId: candidate.id,
      expectedCurrentRevisionId: baseline.currentRevisionId,
      runtimeCapabilities: test.runtime,
    };
    store.bot.disabledBuiltinTools = test.disabled ?? [];
    if (test.archived) store.bot.archivedAt = new Date("2026-11-22T00:00:00Z");

    await expect(activateTaughtSkillRevision(store.prisma, store.actor, input)).resolves.toEqual({
      status: "not_adopted",
      reason: "unqualified",
    });
    expect(store.currentSkill).toEqual(baseline);

    store.bot.archivedAt = null;
    store.bot.disabledBuiltinTools = ["shell"];
    await expect(
      activateTaughtSkillRevision(store.prisma, store.actor, {
        ...input,
        runtimeCapabilities: toolRuntime,
      }),
    ).resolves.toEqual({ status: "activated", revision: candidate });
    expect(store.currentSkill).toMatchObject({
      currentRevisionId: candidate.id,
      currentRevisionGeneration: baseline.currentRevisionGeneration + 1,
    });
  });

  it("activates a qualified legacy playbook without production capability metadata", async () => {
    const store = revisionStore(null);
    store.bot.archivedAt = new Date("2026-11-22T00:00:00Z");
    store.bot.disabledBuiltinTools = ["read_file", "list_files"];
    const { id: skillId, currentRevisionId } = store.currentSkill;
    const candidate = await snapshotTaughtSkillRevision(store.prisma, store.actor, {
      skillId,
      expectedCurrentRevisionId: currentRevisionId,
      trial: qualifiedTrial,
    });
    expect(candidate.snapshot.components).toBeUndefined();
    await expect(
      activateTaughtSkillRevision(store.prisma, store.actor, {
        skillId,
        revisionId: candidate.id,
        expectedCurrentRevisionId: currentRevisionId,
      }),
    ).resolves.toEqual({ status: "activated", revision: candidate });
  });
});

describe("structured skill revision scope", () => {
  it("matches both the explicit workspace project and a family tag", () => {
    expect(
      taughtSkillRevisionApplies(scope, { project, taskFamilies: ["report", "ledger.net"] }),
    ).toBe(true);
  });

  it.each<TaughtSkillRevisionContext>([
    {},
    { project, taskFamilies: [] },
    { project, taskFamilies: ["ledger.gross"] },
    { project, taskFamilies: ["Ledger.Net"] },
    { project: { ...project, path: "projects/ledger-copy" }, taskFamilies: ["ledger.net"] },
    { project: { ...project, path: "projects/ledger/subproject" }, taskFamilies: ["ledger.net"] },
    { project: { ...project, computerId: "other-computer" }, taskFamilies: ["ledger.net"] },
  ])("keeps a scope exception out (%j)", (context) => {
    expect(taughtSkillRevisionApplies(scope, context)).toBe(false);
  });

  it("leaves omitted dimensions unrestricted, without interpreting text", () => {
    expect(taughtSkillRevisionApplies({}, {})).toBe(true);
    expect(taughtSkillRevisionApplies({ project }, { project })).toBe(true);
    expect(
      taughtSkillRevisionApplies(
        { taskFamilies: ["ledger.net"] },
        { taskFamilies: ["ledger.net"] },
      ),
    ).toBe(true);
    expect(
      taughtSkillRevisionApplies(scope, {
        project,
        taskFamilies: ["Please calculate ledger net totals"],
      }),
    ).toBe(false);
  });
});

const key = { id: "fixture-key", spaceId: "space-fixture", version: 1, key: Buffer.alloc(32, 7) };
function encryptedClient(encryptWrites = true) {
  return {
    $contentEncryption: () => ({
      ring: {
        encryptWrites,
        current: async () => key,
        byId: async () => key,
      },
    }),
  };
}

const location = {
  table: "taught_skill_revisions" as const,
  rowId: "revision-fixture",
  spaceId: key.spaceId,
  owner: "skill-fixture",
};
const snapshot = {
  name: "Fixture skill",
  playbook: { steps: ["Read the synthetic-private-file"] },
  scope: { project },
  trial: { artifactId: "fixture-trial", rubricVersion: "fixture-v1" },
};

describe("skill snapshot encryption", () => {
  it("seals all snapshot fields and can reopen them with encryption writes off", async () => {
    const sealed = await sealTaughtSkillSnapshot(encryptedClient(), location, snapshot);
    const raw = JSON.stringify(sealed);
    expect(raw).toContain("$sealed");
    expect(raw).not.toContain("synthetic-private-file");
    expect(raw).not.toContain("projects/ledger");
    expect(raw).not.toContain("fixture-trial");
    await expect(
      openTaughtSkillSnapshot(encryptedClient(false), location, sealed),
    ).resolves.toEqual(snapshot);
  });

  it.each([
    { ...location, rowId: "another-revision" },
    { ...location, owner: "another-skill" },
    { ...location, spaceId: "another-space" },
    { ...location, table: "run_taught_skill_revisions" as const },
  ])("rejects a ciphertext moved to a different binding (%j)", async (destination) => {
    const sealed = await sealTaughtSkillSnapshot(encryptedClient(), location, snapshot);
    await expect(
      openTaughtSkillSnapshot(encryptedClient(), destination, sealed),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
  });

  it("binds a run's full fixed revision to that run, independently of the original", async () => {
    const pinLocation = {
      ...location,
      table: "run_taught_skill_revisions" as const,
      rowId: "pin-fixture",
      owner: "run-fixture",
    };
    const revision = { id: location.rowId, previousRevisionId: "previous-fixture", snapshot };
    const sealed = await sealTaughtSkillSnapshot(encryptedClient(), pinLocation, revision);
    await expect(openTaughtSkillSnapshot(encryptedClient(), pinLocation, sealed)).resolves.toEqual(
      revision,
    );
    await expect(
      openTaughtSkillSnapshot(encryptedClient(), { ...pinLocation, owner: "another-run" }, sealed),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
  });

  it("reads legacy plaintext and requires a key for ciphertext", async () => {
    await expect(openTaughtSkillSnapshot({}, location, snapshot)).resolves.toEqual(snapshot);
    await expect(
      sealTaughtSkillSnapshot(encryptedClient(false), location, snapshot),
    ).resolves.toEqual(snapshot);
    const sealed = await sealTaughtSkillSnapshot(encryptedClient(), location, snapshot);
    await expect(openTaughtSkillSnapshot({}, location, sealed)).rejects.toBeInstanceOf(
      ContentDecryptionError,
    );
  });
});
