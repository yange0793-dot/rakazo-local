import { Buffer } from "node:buffer";
import type { SkillPlaybook } from "@rakazo/contracts";
import {
  ContentDecryptionError,
  openTaughtSkillSnapshot,
  sealTaughtSkillSnapshot,
} from "@rakazo/db";
import { describe, expect, it } from "vitest";
import type {
  TaughtSkillRevisionContext,
  TaughtSkillRevisionScope,
} from "./taught-skill-revisions.js";
import { taughtSkillPlaybookHash, taughtSkillRevisionApplies } from "./taught-skill-revisions.js";

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
