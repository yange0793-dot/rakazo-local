import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LegacyDrawer,
  LegacyExperience,
  LegacyLedgerEntry,
  LegacyTemporalFact,
} from "../../../scripts/import-semantic-memory.js";
import {
  applyLegacyImport,
  assertIsolatedImportTarget,
  parseLegacyExperiences,
  parseLegacyImportArgs,
  parseLegacyLedger,
  planLegacyImport,
  readLegacyExperiences,
  readLegacySnapshot,
  runLegacyImport,
} from "../../../scripts/import-semantic-memory.js";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const asOf = "2026-01-10T12:00:00.000Z";
const observedAt = "2026-01-01T12:00:00.000Z";
const changeAt = "2026-01-02T12:00:00.000Z";
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const target = {
  spaceId: "fixture-space",
  userId: "fixture-user",
  botId: "fixture-bot",
  scope: "isolated" as const,
};
const botWing = (id: string) => `claudebot_bot_${sha(id).slice(0, 16)}`;

function drawer(
  id: string,
  content = "Synthetic preference",
  wing = "claudebot_shared",
  room = "preference",
): LegacyDrawer {
  return {
    id,
    content,
    wing,
    room,
    sourcePath: "fixture://source",
    createdAt: observedAt,
    updatedAt: observedAt,
  };
}

function alias(value: LegacyDrawer, extra: Partial<LegacyLedgerEntry> = {}): LegacyLedgerEntry {
  return {
    sourceKey: `fixture:${value.id}`,
    hash: sha(value.content),
    drawerId: value.id,
    wing: value.wing,
    deleted: false,
    originalSource: value.sourcePath,
    ...extra,
  };
}

function fact(extra: Partial<LegacyTemporalFact> = {}): LegacyTemporalFact {
  return {
    project: null,
    key: "fixture-fact",
    observedAt,
    validFrom: observedAt,
    validTo: null,
    ...extra,
  };
}

function envelope(status: "current" | "historical", content = "Synthetic archived record") {
  const applicability =
    status === "current"
      ? "当前适用的偏好或经验；涉及运行状态需查证"
      : "历史记录，不代表当前状态或授权";
  return `# Fixture\n\n${content}\n\n记录日期：2025-12-01\n适用状态：${applicability}\n来源：fixture://source\n外部旧会话只作归档来源，不在此恢复或接管。`;
}

function plan(
  drawers: LegacyDrawer[],
  entries = drawers.map((item) => alias(item)),
  extra: {
    experiences?: LegacyExperience[];
    botMappings?: Array<{ legacyBotId: string; targetBotId: string }>;
    scope?: "isolated" | "shared";
  } = {},
) {
  return planLegacyImport({
    sourceId: "fixture-source-instance",
    drawers,
    ledger: { version: 2, entries },
    target: { ...target, scope: extra.scope ?? "isolated" },
    asOf,
    experiences: extra.experiences,
    botMappings: extra.botMappings,
  });
}

function legacy(record: ReturnType<typeof plan>["records"][number]) {
  return record.provenance.legacy as Record<string, unknown>;
}

async function sqliteFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-legacy-import-"));
  temporary.push(dir);
  const sqlitePath = path.join(dir, "synthetic.sqlite3");
  const ledgerPath = path.join(dir, "synthetic-ledger.json");
  const value = drawer("fixture-drawer", envelope("current"));
  const ledger = { version: 2, entries: [alias(value)] };
  const fixtureSource = `
import json, sqlite3, sys
record = json.loads(sys.argv[2])
db = sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE); CREATE TABLE documents (collection_id INTEGER NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection_id,id)); CREATE TABLE experiences (id TEXT PRIMARY KEY, json TEXT NOT NULL);")
metadata = {"wing": record["wing"], "room": record["room"], "source_file": record["sourcePath"]}
db.execute("INSERT INTO collections VALUES (1, 'mempalace_drawers')")
db.execute("INSERT INTO collections VALUES (2, 'fixture-closets')")
db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)", (1, record["id"], record["content"], json.dumps(metadata), record["createdAt"], record["updatedAt"]))
db.execute("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)", (2, record["id"], "Synthetic other collection body", json.dumps(metadata), record["createdAt"], record["updatedAt"]))
db.execute("INSERT INTO experiences VALUES (?, ?)", ("one", json.dumps({"id": "one", "botId": "fixture-old-bot", "memoryId": "fixture-drawer", "status": "candidate", "revision": 1, "createdAt": record["createdAt"], "updatedAt": record["updatedAt"]})))
db.commit()
db.close()
`;
  await exec("python3", ["-I", "-c", fixtureSource, sqlitePath, JSON.stringify(value)]);
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const metadata = {
    wing: value.wing,
    room: value.room,
    source_file: value.sourcePath,
  };
  return {
    dir,
    sqlitePath,
    ledgerPath,
    collectionName: "mempalace_drawers",
    value: { ...value, metadata, collectionName: "mempalace_drawers" },
    ledger,
  };
}

describe("legacy semantic memory conversion", () => {
  it("maps old shared facts to one explicitly isolated bot, keeping source/category/time/body", () => {
    const value = drawer("one", envelope("current"));
    const result = plan([value]);
    expect(result.records).toHaveLength(1);
    const imported = result.records[0]!;
    expect(imported).toMatchObject({
      botId: target.botId,
      scope: "isolated",
      kind: "durable",
      status: "active",
      createdAt: observedAt,
      updatedAt: observedAt,
      content: value.content,
      provenance: {
        kind: "import",
        sourcePath: value.sourcePath,
        sourceId: "fixture:one",
        category: "preference",
      },
    });
    expect(legacy(imported)).toMatchObject({
      applicability: { status: "current", recordedAsOf: "2025-12-01" },
      wing: value.wing,
    });
    expect(imported).not.toHaveProperty("revision");
    expect(imported).not.toHaveProperty("revisions");
    expect(result.manifest.counts.scope).toEqual({ isolated: 1, shared: 0 });
    expect(JSON.stringify(result.manifest)).not.toContain(value.content);
    expect(JSON.stringify(result.manifest)).not.toContain("fixture://source");
  });

  it("holds private records without a real old-id mapping; mappings never inherit shared scope", () => {
    const oldBot = "old-fixture-bot";
    const privateRecord = drawer(
      "private",
      "Synthetic private fact",
      `${botWing(oldBot)}_project_${"a".repeat(16)}`,
    );
    const shared = drawer("shared", envelope("current"));
    const held = plan([shared, privateRecord]);
    expect(held.records.map((item) => item.botId)).toEqual([target.botId]);
    expect(held.manifest.counts.held).toEqual({ privateUnmapped: 1 });
    const mapped = plan(
      [shared, privateRecord],
      [alias(shared), alias(privateRecord, { fact: fact() })],
      {
        scope: "shared",
        botMappings: [{ legacyBotId: oldBot, targetBotId: "mapped-fixture-bot" }],
      },
    );
    expect(mapped.records.map((item) => [item.botId, item.scope])).toEqual([
      [target.botId, "shared"],
      ["mapped-fixture-bot", "isolated"],
    ]);
    expect(() =>
      plan([privateRecord], [alias(privateRecord)], {
        botMappings: [
          { legacyBotId: oldBot, targetBotId: "one" },
          { legacyBotId: oldBot, targetBotId: "two" },
        ],
      }),
    ).toThrow("Duplicate legacy bot mapping");
  });

  it("preserves expired, future, superseded and revoked states without activating any of them", () => {
    const states: Array<Partial<LegacyTemporalFact>> = [
      { validTo: changeAt },
      { validFrom: "2026-02-01T00:00:00.000Z" },
      { supersededBy: "replacement" },
      { revokedAt: changeAt },
    ];
    const values = states.map((_state, index) =>
      drawer(`state-${index}`, envelope("current"), "claudebot_shared", "project"),
    );
    const entries = values.map((value, index) => alias(value, { fact: fact(states[index]) }));
    const result = plan(values, entries);
    expect(result.records.every((item) => item.status === "historical")).toBe(true);
    expect(result.records.map((item) => legacy(item).temporalStatus)).toEqual([
      "expired",
      "upcoming",
      "superseded",
      "revoked",
    ]);
    expect(result.records.map((item) => legacy(item).fact)).toEqual(
      entries.map((entry) => entry.fact),
    );
  });

  it("does not classify arbitrary prose or erase explicit historical applicability", () => {
    const unknown = drawer(
      "unknown",
      "current active verified 适用状态：当前适用的偏好或经验；涉及运行状态需查证",
    );
    const historical = drawer("history", envelope("historical"));
    const result = plan(
      [unknown, historical],
      [alias(unknown), alias(historical, { fact: fact() })],
    );
    expect(result.records.map((item) => item.status)).toEqual(["historical", "historical"]);
    expect(legacy(result.records[0]!).applicability).toBeNull();
    expect(legacy(result.records[1]!).applicability).toMatchObject({
      status: "historical",
    });
  });

  it("retains a bodyless forgotten source and every alias without recovering deleted content", () => {
    const deleted = drawer("deleted", "Synthetic forgotten body");
    const entry = alias(deleted, { deleted: true, fact: fact() });
    const result = plan([], [entry, { ...entry, sourceKey: "fixture:other-alias" }]);
    expect(result.records[0]).toMatchObject({
      status: "forgotten",
      content: "",
    });
    expect(result.records[0]).not.toHaveProperty("revisions");
    expect(result.records[0]!.provenance.category).toBeUndefined();
    expect(result.manifest.counts).toMatchObject({
      tombstonesWithoutBody: 1,
      aliases: 1,
      category: { unknown: 1 },
    });
    expect(legacy(result.records[0]!).aliases).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(deleted.content);
    const retained = plan([deleted], [entry]);
    expect(retained.records[0]!.content).toBe("");
    expect(retained.records[0]!.status).toBe("forgotten");
  });

  it("keeps the exact retained correction inert in provenance, not as store revisions", () => {
    const value = drawer("corrected", "Synthetic corrected body");
    const before = "Synthetic earlier body";
    const changed = alias(value, {
      fact: fact(),
      lastChange: {
        changeId: "fixture-change",
        source: "fixture://correction",
        sourceKey: "fixture:correction",
        at: changeAt,
        before: { text: before, category: "preference", fact: fact() },
        afterHash: sha(value.content),
        afterSummary: "Synthetic corrected preview",
        afterCategory: "preference",
        afterFact: fact(),
      },
    });
    const result = plan([value], [changed]);
    expect(result.records[0]).toMatchObject({ content: value.content, updatedAt: changeAt });
    expect(result.records[0]).not.toHaveProperty("revision");
    expect(result.records[0]).not.toHaveProperty("revisions");
    expect(legacy(result.records[0]!)).not.toHaveProperty("retainedSnapshotOrdinal");
    expect(legacy(result.records[0]!)).toMatchObject({
      lastChange: changed.lastChange,
      revisionBasis: "legacy-correction-metadata-only",
    });
    expect(result.manifest.counts.revisions).toBe(1);
  });

  it("never invents the full undone correction from a truncated afterSummary", () => {
    const value = drawer("undone", "Synthetic restored body");
    const undoAt = "2026-01-03T00:00:00.000Z";
    const entry = alias(value, {
      lastChange: {
        changeId: "fixture-undone",
        source: "fixture://correction",
        sourceKey: "fixture:correction",
        at: changeAt,
        before: { text: value.content, category: "preference" },
        afterHash: sha("Synthetic missing correction body"),
        afterSummary: "Truncated preview only",
        afterCategory: "preference",
        undoneAt: undoAt,
      },
    });
    const result = plan([value], [entry]);
    expect(result.records[0]).toMatchObject({ content: value.content, updatedAt: undoAt });
    expect(result.records[0]).not.toHaveProperty("revisions");
    expect(legacy(result.records[0]!)).toMatchObject({
      lastChange: entry.lastChange,
    });
    expect(result.manifest.counts.missing.undoneCorrectionBody).toBe(1);
    expect(result.records[0]!.content).not.toBe(entry.lastChange!.afterSummary);
  });

  it("does not turn a predecessor from supersede into an edit revision of the new drawer", () => {
    const value = drawer("new-version");
    const entry = alias(value, {
      fact: fact({ supersedes: "old-version" }),
      lastChange: {
        kind: "supersede",
        supersedes: "old-version",
        changeId: "fixture-supersede",
        source: "fixture://source",
        sourceKey: "fixture:new",
        at: changeAt,
        before: {
          text: "Another drawer's previous content",
          category: "preference",
          fact: fact(),
        },
        afterHash: sha(value.content),
        afterSummary: value.content,
        afterCategory: "preference",
      },
    });
    const result = plan([value], [entry]);
    expect(result.records[0]).toMatchObject({ content: value.content, status: "active" });
    expect(result.records[0]).not.toHaveProperty("revisions");
    expect(legacy(result.records[0]!).lastChange).toEqual(entry.lastChange);
    expect(legacy(result.records[0]!)).not.toHaveProperty("retainedSnapshotOrdinal");
    expect(result.manifest.counts.revisions).toBe(0);
  });

  it("downgrades missing/candidate/retired experience evidence and preserves only sourced legacy active reviews", () => {
    const oldBot = "experience-fixture-bot";
    const values = [
      "missing",
      "candidate",
      "unsupported-active",
      "supported-active",
      "retired",
      "forgotten",
    ].map((id) => drawer(id, envelope("current"), botWing(oldBot), "experience"));
    const statuses: LegacyExperience["status"][] = [
      "candidate",
      "active",
      "active",
      "retired",
      "forgotten",
    ];
    const experiences = values.slice(1).map(
      (value, index): LegacyExperience => ({
        id: `experience-${index}`,
        botId: oldBot,
        memoryId: value.id,
        status: statuses[index]!,
        revision: 2,
        createdAt: observedAt,
        updatedAt: changeAt,
        sourceGoalId: "source-goal",
        sourceTaskId: "source-task",
        evidenceQuote: "Original synthetic result",
        reviews:
          value.id === "supported-active"
            ? [
                {
                  goalId: "another-goal",
                  taskId: "another-task",
                  toolUseId: "tool-result",
                  verdict: "supported",
                  evidenceQuote: "Actual synthetic review quote",
                  at: changeAt,
                },
              ]
            : [],
      }),
    );
    const result = plan(
      values,
      values.map((value) => alias(value, { fact: fact() })),
      {
        experiences,
        botMappings: [{ legacyBotId: oldBot, targetBotId: target.botId }],
      },
    );
    expect(result.records.map((item) => item.status)).toEqual([
      "historical",
      "historical",
      "historical",
      "active",
      "historical",
      "forgotten",
    ]);
    expect(result.records.map((item) => legacy(item).validationStatus)).toEqual([
      "historical",
      "candidate",
      "candidate",
      "legacy-active",
      "retired",
      "forgotten",
    ]);
    expect(legacy(result.records[3]!).validationEvidence).toBe(
      "legacy-review-record-not-reexecuted",
    );
    expect(result.manifest.counts.missing).toMatchObject({
      experienceState: 1,
      independentExperienceReview: 1,
    });
    expect(legacy(result.records[5]!).experience).toBeUndefined();
  });

  it("holds incomplete or contradictory source snapshots rather than active partial facts", () => {
    const mismatch = drawer("mismatch");
    const unfinished = drawer(
      "unfinished",
      "Synthetic version body",
      "claudebot_shared",
      `preference__cbf_${"b".repeat(32)}`,
    );
    const absent = drawer("absent");
    const result = plan(
      [mismatch, unfinished],
      [alias(mismatch, { hash: sha("Other body") }), alias(unfinished), alias(absent)],
    );
    expect(result.records).toEqual([]);
    expect(result.manifest.counts.held).toEqual({
      contentHashMismatch: 1,
      uncommittedVersion: 1,
      missingBody: 1,
    });
  });

  it("marks missing original times separately from storage import timestamps and stable source IDs", () => {
    const value = drawer("undated", envelope("current"));
    delete value.createdAt;
    delete value.updatedAt;
    const result = plan([value]);
    const imported = result.records[0]!;
    expect(imported.createdAt).toBe(asOf);
    expect(imported.provenance.observedAt).toBeUndefined();
    expect(legacy(imported)).toMatchObject({
      originalCreatedAt: null,
      originalUpdatedAt: null,
    });
    expect(result.manifest.counts.missing).toMatchObject({
      createdAt: 1,
      updatedAt: 1,
    });
    const another = planLegacyImport({
      sourceId: "fixture-source-instance",
      drawers: [value],
      ledger: { version: 2, entries: [alias(value)] },
      target,
      asOf: changeAt,
    });
    expect(another.records[0]!.sourceKey).toBe(imported.sourceKey);
  });

  it("rejects invalid source metadata at the conversion boundary without showing its body", () => {
    expect(() =>
      parseLegacyLedger({
        version: 2,
        entries: [
          {
            sourceKey: "source",
            hash: "wrong",
            drawerId: "drawer",
            wing: "wing",
            deleted: false,
          },
        ],
      }),
    ).toThrow("Invalid legacy ledger content hash");
    expect(() =>
      parseLegacyExperiences({
        version: 1,
        experiences: [{ id: "one", botId: "two", status: "active", revision: 0 }],
      }),
    ).toThrow("Invalid legacy experience state");
    expect(() =>
      planLegacyImport({
        sourceId: "fixture",
        drawers: [],
        ledger: { version: 2, entries: [] },
        target: { ...target, botId: "" },
        asOf,
      }),
    ).toThrow("target botId");
  });
});

describe("legacy importer source and apply boundaries", () => {
  const args = (sqlitePath: string, ledgerPath: string, collectionName = "mempalace_drawers") => [
    "--source-sqlite",
    sqlitePath,
    "--source-ledger",
    ledgerPath,
    "--source-collection",
    collectionName,
    "--source-id",
    "fixture-instance",
    "--target-space",
    target.spaceId,
    "--target-user",
    target.userId,
    "--target-bot",
    target.botId,
    "--as-of",
    asOf,
  ];

  it("defaults to dry-run and requires explicit credentials for apply; the test fence is optional", () => {
    const options = parseLegacyImportArgs(args("/fixture/source.sqlite3", "/fixture/ledger.json"));
    expect(options.apply).toBe(false);
    expect(options.target.scope).toBe("isolated");
    expect(options.databaseUrlFile).toBeUndefined();
    expect(() =>
      parseLegacyImportArgs([
        ...args("/fixture/source.sqlite3", "/fixture/ledger.json"),
        "--apply",
      ]),
    ).toThrow("--database-url-file");
    const explicitApply = parseLegacyImportArgs([
      ...args("/fixture/source.sqlite3", "/fixture/ledger.json"),
      "--apply",
      "--database-url-file",
      "/fixture/credentials",
    ]);
    expect(explicitApply).toMatchObject({
      apply: true,
      testTarget: false,
      databaseUrlFile: "/fixture/credentials",
      target,
    });
    expect(() =>
      parseLegacyImportArgs([
        ...args("/fixture/source.sqlite3", "/fixture/ledger.json"),
        "--database-url-file",
        "/fixture/credentials",
      ]),
    ).toThrow("Database options require --apply");
    expect(() =>
      parseLegacyImportArgs([
        ...args("/fixture/source.sqlite3", "/fixture/ledger.json"),
        "--manifest",
        "/fixture/ledger.json",
      ]),
    ).toThrow("Manifest must not replace");
  });

  it("accepts only loopback random database/runtime-login pairs, never the real database or owner role", () => {
    const id = "a".repeat(32);
    expect(() =>
      assertIsolatedImportTarget(
        `postgresql://rakazo_test_rt_${id}:fixture-password@127.0.0.1:55432/rakazo_test_${id}`,
      ),
    ).not.toThrow();
    expect(() =>
      assertIsolatedImportTarget(
        `postgresql://rkz_c_rt_20260101_120000_a1b2c3:fixture-password@127.0.0.1:55432/rkz_c_20260101_120000_a1b2c3_${id}`,
      ),
    ).not.toThrow();
    for (const connection of [
      "postgresql://rakazo_app:fixture-password@127.0.0.1:55432/rakazo",
      `postgresql://rakazo:fixture-password@127.0.0.1:55432/rakazo_test_${id}`,
      `postgresql://rakazo_test_rt_${id}:fixture-password@example.invalid/rakazo_test_${id}`,
      `postgresql://rakazo_test_rt_${id}:fixture-password@127.0.0.1/rakazo_test_${id}?host=remote.invalid`,
      `postgresql://rakazo_test_rt_${id}:fixture-password@127.0.0.1/rakazo_test_${"b".repeat(32)}`,
    ])
      expect(() => assertIsolatedImportTarget(connection)).toThrow("isolated random database");
  });

  it("reads a synthetic SQLite snapshot and experience-only table without changing either source", async () => {
    const fixture = await sqliteFixture();
    const databaseBefore = await readFile(fixture.sqlitePath);
    const ledgerBefore = await readFile(fixture.ledgerPath);
    const snapshot = await readLegacySnapshot(fixture);
    expect(snapshot).toEqual({
      drawers: [fixture.value],
      ledger: fixture.ledger,
    });
    const experiences = await readLegacyExperiences({
      sqlitePath: fixture.sqlitePath,
    });
    expect(experiences[0]).toMatchObject({
      id: "one",
      status: "candidate",
      revision: 1,
    });
    expect(await readFile(fixture.sqlitePath)).toEqual(databaseBefore);
    expect(await readFile(fixture.ledgerPath)).toEqual(ledgerBefore);
  });

  it("dry-run writes a counts-only manifest, refuses overwriting it, and never needs a DB connection", async () => {
    const fixture = await sqliteFixture();
    const manifestPath = path.join(fixture.dir, "manifest.json");
    const options = parseLegacyImportArgs([
      ...args(fixture.sqlitePath, fixture.ledgerPath),
      "--manifest",
      manifestPath,
    ]);
    const manifest = await runLegacyImport(options);
    expect(manifest).toMatchObject({ mode: "dry-run", planned: 1, applied: 0 });
    const text = await readFile(manifestPath, "utf8");
    expect(JSON.parse(text)).toEqual(manifest);
    expect(text).not.toContain(fixture.value.content);
    expect(text).not.toContain(fixture.value.sourcePath);
    await expect(runLegacyImport(options)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("loads the real CLI apply dependencies when all source records are held", async () => {
    const fixture = await sqliteFixture();
    const urlFile = path.join(fixture.dir, "url");
    const id = "c".repeat(32);
    await writeFile(
      urlFile,
      `postgresql://rakazo_test_rt_${id}:fixture-password@127.0.0.1:1/rakazo_test_${id}`,
    );
    const { stdout } = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/import-semantic-memory.ts",
        ...args(fixture.sqlitePath, fixture.ledgerPath, "fixture-closets"),
        "--apply",
        "--test-target",
        "--database-url-file",
        urlFile,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, RAKAZO_ENV_FILE: "none", CONTENT_ENCRYPTION: "off" },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      mode: "apply",
      planned: 0,
      applied: 0,
      counts: { held: { contentHashMismatch: 1 } },
    });
  });

  it("applies only via the scoped authoritative store and one existing index scheduling action", async () => {
    const values = [drawer("one", envelope("current")), drawer("two", envelope("historical"))];
    const importPlan = plan(values);
    const calls: unknown[] = [];
    let tenantOpen = false;
    const manifest = await applyLegacyImport(importPlan, {
      withTenant: async (tenant, action) => {
        expect(tenant).toMatchObject({
          spaceId: target.spaceId,
          userId: target.userId,
        });
        tenantOpen = true;
        try {
          return await action();
        } finally {
          tenantOpen = false;
        }
      },
      importFact: async (record, context) => {
        expect(tenantOpen).toBe(true);
        expect(context).toMatchObject({
          spaceId: target.spaceId,
          userId: target.userId,
          botId: record.botId,
        });
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(Object.keys(record).sort()).toEqual([
          "botId",
          "content",
          "createdAt",
          "kind",
          "provenance",
          "scope",
          "sourceKey",
          "status",
          "updatedAt",
        ]);
        calls.push(record);
        return {
          id: `fact:${record.sourceKey}`,
          botId: record.botId,
          scope: record.scope,
          kind: record.kind,
          content: record.content,
          revision: 1,
          status: record.status,
          provenance: record.provenance,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      },
      scheduleIndex: async (spaceId) => {
        calls.push(["memory.sync", spaceId]);
      },
    });
    expect(manifest).toMatchObject({ mode: "apply", applied: 2, planned: 2 });
    expect(calls).toEqual([...importPlan.records, ["memory.sync", target.spaceId]]);
    expect(importPlan.manifest.mode).toBe("dry-run");
    expect(importPlan.manifest.applied).toBe(0);
  });

  it("rejects a supplied live apply URL before reading sources or importing DB code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-legacy-url-"));
    temporary.push(dir);
    const urlFile = path.join(dir, "url");
    await writeFile(urlFile, "postgresql://rakazo_app:fixture-password@127.0.0.1:55432/rakazo");
    const options = parseLegacyImportArgs([
      ...args(path.join(dir, "missing.sqlite3"), path.join(dir, "missing.json")),
      "--apply",
      "--test-target",
      "--database-url-file",
      urlFile,
    ]);
    await expect(runLegacyImport(options)).rejects.toThrow("isolated random database");
  });
});
