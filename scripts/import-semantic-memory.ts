import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AdapterContext } from "../packages/adapter-kit/src/index.js";
import type { SemanticFact } from "../packages/contracts/src/index.js";
import type { SemanticFactImportInput } from "../packages/db/src/index.js";

const exec = promisify(execFile);
const categories = ["preference", "project", "experience", "reference"] as const;
type Category = (typeof categories)[number];
type FactStatus = SemanticFact["status"];
type Provenance = SemanticFact["provenance"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface LegacyDrawer {
  id: string;
  wing: string;
  room: string;
  content: string;
  sourcePath?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  collectionName?: string;
}

export interface LegacyTemporalFact {
  project: string | null;
  key: string | null;
  observedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  supersedes?: string;
  supersededBy?: string;
  revokedAt?: string;
}

export interface LegacyChange {
  changeId: string;
  kind?: "supersede";
  source: string;
  sourceKey: string;
  at: string;
  before: {
    text: string;
    category: string;
    fact?: LegacyTemporalFact | null;
    storageRoom?: string;
  };
  afterHash: string;
  afterSummary: string;
  afterCategory: string;
  afterFact?: LegacyTemporalFact;
  supersedes?: string;
  supersededFact?: LegacyTemporalFact;
  undoneAt?: string;
  undoSource?: string;
  undoSourceKey?: string;
}

export interface LegacyLedgerEntry {
  sourceKey: string;
  hash: string;
  drawerId: string;
  wing: string;
  deleted: boolean;
  originalSource?: string;
  renewalOf?: string;
  fact?: LegacyTemporalFact;
  lastChange?: LegacyChange;
}

export interface LegacyLedger {
  version: 1 | 2;
  entries: LegacyLedgerEntry[];
}

export interface LegacyExperience {
  id: string;
  botId: string;
  memoryId?: string | null;
  status: "candidate" | "active" | "retired" | "forgotten";
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceGoalId?: string;
  sourceTaskId?: string;
  source?: string;
  evidenceQuote?: string;
  applicability?: string;
  cwd?: string;
  reviews?: Array<{
    goalId: string;
    taskId: string;
    toolUseId: string | number;
    verdict: "supported" | "contradicted";
    evidenceQuote: string;
    at: string;
    reason?: string;
  }>;
}

export interface LegacyTarget {
  spaceId: string;
  userId: string;
  botId: string;
  scope: "isolated" | "shared";
}

export interface LegacyBotMapping {
  legacyBotId: string;
  targetBotId: string;
}

export type LegacyImportRecord = SemanticFactImportInput;

export interface LegacyImportManifest {
  format: "rakazo-legacy-memory-manifest-v1";
  mode: "dry-run" | "apply";
  asOf: string;
  source: { drawers: number; ledgerEntries: number; experiences: number };
  planned: number;
  applied: number;
  counts: {
    status: Record<FactStatus, number>;
    scope: Record<"isolated" | "shared", number>;
    category: Record<Category | "unknown", number>;
    validation: Record<string, number>;
    held: Record<string, number>;
    missing: Record<string, number>;
    revisions: number;
    tombstonesWithoutBody: number;
    aliases: number;
  };
}

export interface LegacyImportPlan {
  target: LegacyTarget;
  records: LegacyImportRecord[];
  manifest: LegacyImportManifest;
}

function required(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`Invalid legacy import ${field}`);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Invalid legacy import ${field}`);
  }
  return new Date(value).toISOString();
}

function assertTemporalFact(value: unknown): asserts value is LegacyTemporalFact {
  if (!object(value)) throw new Error("Invalid legacy fact metadata");
  for (const field of ["project", "key"]) {
    if (value[field] !== null) required(value[field], `fact ${field}`);
  }
  for (const field of ["observedAt", "validFrom", "validTo"]) {
    if (value[field] !== null) timestamp(value[field], `fact ${field}`);
  }
  if (
    value.validFrom &&
    value.validTo &&
    timestamp(value.validFrom, "validFrom") >= timestamp(value.validTo, "validTo")
  ) {
    throw new Error("Invalid legacy fact validity window");
  }
  for (const field of ["supersedes", "supersededBy"]) {
    if (value[field] !== undefined) required(value[field], `fact ${field}`);
  }
  if (value.revokedAt !== undefined) timestamp(value.revokedAt, "fact revokedAt");
}

export function parseLegacyLedger(value: unknown): LegacyLedger {
  if (!object(value) || ![1, 2].includes(Number(value.version)) || !Array.isArray(value.entries)) {
    throw new Error("Invalid legacy memory ledger");
  }
  for (const row of value.entries) {
    if (!object(row) || typeof row.deleted !== "boolean")
      throw new Error("Invalid legacy ledger entry");
    for (const field of ["sourceKey", "drawerId", "wing"]) required(row[field], field);
    if (typeof row.hash !== "string" || !/^[a-f0-9]{64}$/.test(row.hash)) {
      throw new Error("Invalid legacy ledger content hash");
    }
    if (row.originalSource !== undefined && typeof row.originalSource !== "string")
      throw new Error("Invalid legacy original source");
    if (row.fact !== undefined) {
      if (value.version !== 2) throw new Error("Legacy fact metadata requires ledger version 2");
      assertTemporalFact(row.fact);
    }
    if (row.renewalOf !== undefined) {
      required(row.renewalOf, "renewal key");
      if (!object(row.fact) || row.renewalOf !== row.fact.key)
        throw new Error("Invalid legacy renewal metadata");
    }
    if (row.lastChange !== undefined) {
      const change = row.lastChange;
      if (!object(change) || !object(change.before) || typeof change.before.text !== "string") {
        throw new Error("Invalid legacy correction snapshot");
      }
      for (const field of ["changeId", "source", "sourceKey", "afterCategory"])
        required(change[field], field);
      if (
        !categories.includes(change.before.category as Category) ||
        !categories.includes(change.afterCategory as Category)
      )
        throw new Error("Invalid legacy correction category");
      if (
        typeof change.afterHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(change.afterHash) ||
        typeof change.afterSummary !== "string"
      ) {
        throw new Error("Invalid legacy correction hash");
      }
      timestamp(change.at, "correction time");
      if (change.undoneAt !== undefined) timestamp(change.undoneAt, "undo time");
      if (change.kind !== undefined && change.kind !== "supersede")
        throw new Error("Invalid legacy correction kind");
      for (const field of ["supersedes", "undoSource", "undoSourceKey"]) {
        if (change[field] !== undefined) required(change[field], field);
      }
      for (const fact of [change.before.fact, change.afterFact, change.supersededFact]) {
        if (fact !== undefined && fact !== null) assertTemporalFact(fact);
      }
    }
  }
  return value as unknown as LegacyLedger;
}

export function parseLegacyExperiences(value: unknown): LegacyExperience[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.experiences)) {
    throw new Error("Experience snapshot must have version 1 and an experiences array");
  }
  for (const entry of value.experiences) {
    if (
      !object(entry) ||
      !["candidate", "active", "retired", "forgotten"].includes(String(entry.status)) ||
      !Number.isInteger(entry.revision) ||
      Number(entry.revision) < 1
    )
      throw new Error("Invalid legacy experience state");
    required(entry.id, "experience id");
    required(entry.botId, "experience bot id");
    timestamp(entry.createdAt, "experience createdAt");
    timestamp(entry.updatedAt, "experience updatedAt");
    if (entry.memoryId !== undefined && entry.memoryId !== null)
      required(entry.memoryId, "experience memoryId");
    if (entry.reviews !== undefined && !Array.isArray(entry.reviews))
      throw new Error("Invalid legacy experience reviews");
    for (const review of (entry.reviews ?? []) as unknown[]) {
      if (!object(review) || !["supported", "contradicted"].includes(String(review.verdict)))
        throw new Error("Invalid legacy experience review");
      for (const field of ["goalId", "taskId", "evidenceQuote"])
        required(review[field], `experience review ${field}`);
      if (
        !(typeof review.toolUseId === "string" && review.toolUseId.trim()) &&
        !(typeof review.toolUseId === "number" && Number.isFinite(review.toolUseId))
      )
        throw new Error("Invalid legacy experience review tool id");
      timestamp(review.at, "experience review time");
    }
  }
  return value.experiences as LegacyExperience[];
}

// This decodes only the footer emitted by the known archive importer, never arbitrary prose.
function archiveEnvelope(content: string, source: string) {
  const tail = `\n来源：${source}\n外部旧会话只作归档来源，不在此恢复或接管。`;
  if (!content.endsWith(tail)) return null;
  const offset = content.lastIndexOf("\n\n记录日期：");
  if (offset < 0) return null;
  const lines = content.slice(offset + 2, -tail.length).split("\n");
  if (lines.length < 2 || lines.length > 3 || !lines[0]?.startsWith("记录日期：")) return null;
  const statuses: Record<string, "current" | "historical"> = {
    "适用状态：当前适用的偏好或经验；涉及运行状态需查证": "current",
    "适用状态：历史记录，不代表当前状态或授权": "historical",
  };
  const status = statuses[lines[1] ?? ""];
  if (!status || (lines.length === 3 && !lines[2]?.startsWith("项目："))) return null;
  return {
    status,
    recordedAsOf: lines[0].slice("记录日期：".length),
    ...(lines[2] ? { project: lines[2].slice("项目：".length) } : {}),
  };
}

function temporalStatus(fact: LegacyTemporalFact | undefined, asOf: string) {
  if (!fact) return "unknown";
  if (fact.revokedAt) return "revoked";
  if (fact.supersededBy) return "superseded";
  if (fact.validTo && timestamp(fact.validTo, "validTo") <= asOf) return "expired";
  if (fact.validFrom && timestamp(fact.validFrom, "validFrom") > asOf) return "upcoming";
  return fact.validFrom ? "current" : "unknown";
}

function experienceValidation(experience: LegacyExperience | undefined) {
  if (!experience) return "historical";
  if (experience.status !== "active") return experience.status;
  const supported = experience.reviews?.some(
    (review) =>
      object(review) &&
      review.verdict === "supported" &&
      typeof review.goalId === "string" &&
      Boolean(review.goalId.trim()) &&
      review.goalId !== experience.sourceGoalId &&
      typeof experience.sourceGoalId === "string" &&
      Boolean(experience.sourceTaskId) &&
      typeof review.taskId === "string" &&
      Boolean(review.taskId.trim()) &&
      review.taskId !== experience.sourceTaskId &&
      ((typeof review.toolUseId === "string" && Boolean(review.toolUseId.trim())) ||
        (typeof review.toolUseId === "number" && Number.isFinite(review.toolUseId))) &&
      typeof review.evidenceQuote === "string" &&
      Boolean(review.evidenceQuote.trim()) &&
      typeof review.at === "string" &&
      Number.isFinite(Date.parse(review.at)),
  );
  const contradicted = experience.reviews?.some((review) => review?.verdict === "contradicted");
  return supported && !contradicted ? "legacy-active" : "candidate";
}

/** Pure conversion: no database, environment reads, source writes, or private-content logging. */
export function planLegacyImport(input: {
  sourceId: string;
  drawers: LegacyDrawer[];
  ledger: LegacyLedger;
  experiences?: LegacyExperience[];
  target: LegacyTarget;
  botMappings?: LegacyBotMapping[];
  asOf: string;
}): LegacyImportPlan {
  required(input.sourceId, "sourceId");
  const asOf = timestamp(input.asOf, "asOf");
  for (const field of ["spaceId", "userId", "botId"] as const)
    required(input.target[field], `target ${field}`);
  if (!["isolated", "shared"].includes(input.target.scope))
    throw new Error("Explicit target scope is required");
  const ledger = parseLegacyLedger(input.ledger);
  const experiences = parseLegacyExperiences({
    version: 1,
    experiences: input.experiences ?? [],
  });
  const mappings = new Map<string, string>();
  const legacyBots = new Map<string, string>();
  for (const mapping of input.botMappings ?? []) {
    required(mapping.legacyBotId, "mapped legacy bot id");
    required(mapping.targetBotId, "mapped target bot id");
    const wing = `claudebot_bot_${hash(mapping.legacyBotId).slice(0, 16)}`;
    if (mappings.has(wing)) throw new Error("Duplicate legacy bot mapping");
    mappings.set(wing, mapping.targetBotId);
    legacyBots.set(wing, mapping.legacyBotId);
  }

  const manifest: LegacyImportManifest = {
    format: "rakazo-legacy-memory-manifest-v1",
    mode: "dry-run",
    asOf,
    source: {
      drawers: input.drawers.length,
      ledgerEntries: ledger.entries.length,
      experiences: experiences.length,
    },
    planned: 0,
    applied: 0,
    counts: {
      status: { active: 0, historical: 0, forgotten: 0 },
      scope: { isolated: 0, shared: 0 },
      category: {
        preference: 0,
        project: 0,
        experience: 0,
        reference: 0,
        unknown: 0,
      },
      validation: {},
      held: {},
      missing: {},
      revisions: 0,
      tombstonesWithoutBody: 0,
      aliases: 0,
    },
  };
  const count = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const grouped = new Map<string, { drawer?: LegacyDrawer; aliases: LegacyLedgerEntry[] }>();
  const keyOf = (wing: string, id: string) => JSON.stringify([wing, id]);
  for (const drawer of input.drawers) {
    for (const field of ["id", "wing", "room"] as const) required(drawer[field], `drawer ${field}`);
    if (typeof drawer.content !== "string") throw new Error("Invalid legacy drawer content");
    const key = keyOf(drawer.wing, drawer.id);
    if (grouped.has(key)) throw new Error("Duplicate legacy SQLite drawer");
    grouped.set(key, { drawer, aliases: [] });
  }
  for (const alias of ledger.entries) {
    const key = keyOf(alias.wing, alias.drawerId);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { aliases: [] };
      grouped.set(key, entry);
    }
    entry.aliases.push(alias);
  }

  const records: LegacyImportRecord[] = [];
  for (const [identity, entry] of grouped) {
    const { drawer, aliases } = entry;
    const primary =
      aliases.find(
        (row) =>
          row.originalSource !== undefined ||
          row.fact !== undefined ||
          row.lastChange !== undefined,
      ) ?? aliases[0];
    const wing = drawer?.wing ?? primary?.wing ?? "";
    const drawerId = drawer?.id ?? primary?.drawerId ?? "";
    const shared = /^claudebot_shared(?:_project_[a-f0-9]{16})?$/.test(wing);
    const privateWing = /^(claudebot_bot_[a-f0-9]{16})(?:_project_[a-f0-9]{16})?$/.exec(wing)?.[1];
    const botId = shared ? input.target.botId : privateWing ? mappings.get(privateWing) : undefined;
    if (!botId) {
      count(manifest.counts.held, privateWing ? "privateUnmapped" : "unknownWing");
      continue;
    }
    const scope = shared ? input.target.scope : "isolated";
    const matchingExperiences = experiences.filter((row) => row.memoryId === drawerId);
    const experience = matchingExperiences.find(
      (row) => privateWing && row.botId === legacyBots.get(privateWing),
    );
    if (matchingExperiences.length && (!experience || matchingExperiences.length !== 1)) {
      count(manifest.counts.held, "experienceOwnerMismatch");
      continue;
    }
    const forgotten = aliases.some((row) => row.deleted) || experience?.status === "forgotten";
    if (!drawer && !forgotten) {
      count(manifest.counts.held, "missingBody");
      continue;
    }
    if (!forgotten && primary && aliases.some((row) => row.hash !== hash(drawer?.content ?? ""))) {
      count(manifest.counts.held, "contentHashMismatch");
      continue;
    }
    if (
      aliases.some(
        (row) =>
          row.fact && primary?.fact && JSON.stringify(row.fact) !== JSON.stringify(primary.fact),
      )
    ) {
      count(manifest.counts.held, "conflictingFactAliases");
      continue;
    }
    const versionRoom = /^(preference|project|experience|reference)__cbf_[a-f0-9]{32}$/.exec(
      drawer?.room ?? "",
    );
    if (!forgotten && versionRoom && !primary?.fact) {
      count(manifest.counts.held, "uncommittedVersion");
      continue;
    }
    const categoryValue = versionRoom?.[1] ?? drawer?.room;
    if (categoryValue !== undefined && !categories.includes(categoryValue as Category)) {
      count(manifest.counts.held, "unsupportedCategory");
      continue;
    }
    const category = categoryValue as Category | undefined;
    if (!category) count(manifest.counts.missing, "category");
    const source = primary?.originalSource || drawer?.sourcePath;
    const envelope = source && drawer ? archiveEnvelope(drawer.content, source) : null;
    const temporal = temporalStatus(primary?.fact, asOf);
    const validation = category === "experience" ? experienceValidation(experience) : undefined;
    let status: FactStatus = forgotten ? "forgotten" : "historical";
    if (
      !forgotten &&
      primary &&
      !["revoked", "expired", "upcoming", "superseded"].includes(temporal) &&
      envelope?.status !== "historical"
    ) {
      if (category === "experience") {
        if (validation === "legacy-active") status = "active";
      } else if (temporal === "current" || envelope?.status === "current") status = "active";
    }
    if (!primary) count(manifest.counts.missing, "ledgerRecord");
    if (!source) count(manifest.counts.missing, "originalSource");
    if (validation) count(manifest.counts.validation, validation);
    if (category === "experience" && !experience) count(manifest.counts.missing, "experienceState");
    if (category === "experience" && experience?.status === "active" && validation === "candidate")
      count(manifest.counts.missing, "independentExperienceReview");
    const created =
      drawer?.createdAt ?? experience?.createdAt ?? primary?.fact?.observedAt ?? undefined;
    const createdAt = created ? timestamp(created, "createdAt") : asOf;
    const changed = primary?.lastChange?.undoneAt ?? primary?.lastChange?.at;
    const updated =
      experience?.updatedAt ?? changed ?? drawer?.updatedAt ?? primary?.fact?.observedAt ?? created;
    const updatedAt = updated ? timestamp(updated, "updatedAt") : asOf;
    if (!created) count(manifest.counts.missing, "createdAt");
    if (!updated) count(manifest.counts.missing, "updatedAt");
    const change = forgotten ? undefined : primary?.lastChange;
    const retainedCorrectionSnapshots = change && change.kind !== "supersede" ? 1 : 0;
    if (retainedCorrectionSnapshots && change) {
      const currentHash = hash(drawer?.content ?? "");
      const expectedHash = change.undoneAt ? hash(change.before.text) : change.afterHash;
      if (currentHash !== expectedHash) {
        count(manifest.counts.held, "correctionSnapshotMismatch");
        continue;
      }
      if (change.undoneAt) count(manifest.counts.missing, "undoneCorrectionBody");
    }
    const legacy = {
      sourceId: input.sourceId,
      wing,
      drawerId,
      aliases: aliases.map((row) => ({
        sourceKey: row.sourceKey,
        hash: row.hash,
        deleted: row.deleted,
      })),
      sqliteSource: drawer?.sourcePath ?? null,
      sqliteMetadata: forgotten ? null : (drawer?.metadata ?? null),
      collectionName: drawer?.collectionName ?? null,
      room: drawer?.room ?? null,
      categoryKnown: Boolean(drawer),
      ledgerVersion: ledger.version,
      ledgerPresent: Boolean(primary),
      temporalStatus: temporal,
      fact: primary?.fact ?? null,
      applicability: envelope ?? null,
      renewalOf: primary?.renewalOf ?? null,
      revisionBasis: "legacy-correction-metadata-only",
      originalCreatedAt: created ?? null,
      originalUpdatedAt: updated ?? null,
      sqliteCreatedAt: drawer?.createdAt ?? null,
      sqliteUpdatedAt: drawer?.updatedAt ?? null,
      ...(change ? { lastChange: change } : {}),
      ...(validation
        ? {
            validationStatus: validation,
            validationEvidence:
              validation === "legacy-active"
                ? "legacy-review-record-not-reexecuted"
                : "not-independently-verified",
            ...(experience && !forgotten ? { experience } : {}),
          }
        : {}),
    };
    const provenance: Provenance = {
      kind: "import",
      sourceId: primary?.sourceKey ?? `drawer:${drawerId}`,
      ...(source ? { sourcePath: source } : {}),
      ...(category ? { category } : {}),
      ...(primary?.fact?.observedAt
        ? { observedAt: timestamp(primary.fact.observedAt, "observedAt") }
        : {}),
      ...(primary?.fact?.validFrom
        ? { validFrom: timestamp(primary.fact.validFrom, "validFrom") }
        : {}),
      ...(primary?.fact?.validTo ? { validTo: timestamp(primary.fact.validTo, "validTo") } : {}),
      legacy,
    };
    records.push({
      sourceKey: `legacy:${hash(JSON.stringify([input.sourceId, identity]))}`,
      botId,
      scope,
      kind: "durable",
      content: forgotten ? "" : (drawer?.content ?? ""),
      status,
      provenance,
      createdAt,
      updatedAt,
    });
    manifest.planned += 1;
    manifest.counts.status[status] += 1;
    manifest.counts.scope[scope] += 1;
    manifest.counts.category[category ?? "unknown"] += 1;
    manifest.counts.revisions += retainedCorrectionSnapshots;
    manifest.counts.aliases += Math.max(0, aliases.length - 1);
    if (forgotten && !drawer) manifest.counts.tombstonesWithoutBody += 1;
  }
  return { target: { ...input.target }, records, manifest };
}

const sqliteReader = String.raw`
import json
import pathlib
import sqlite3
import sys


def connect(filename):
    filename = pathlib.Path(filename)
    if not filename.is_absolute() or not filename.is_file():
        raise ValueError("Source must be an existing absolute file")
    db = sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only = ON")
    db.execute("BEGIN")
    return db


def memory_snapshot(filename, ledger_path, collection_name):
    db = connect(filename)
    try:
        columns = {row[1] for row in db.execute("PRAGMA table_info(documents)")}
        required = {"collection_id", "id", "document", "metadata_json", "created_at", "updated_at"}
        if not required.issubset(columns):
            raise ValueError("Unsupported legacy SQLite documents schema")
        collection = db.execute("SELECT id FROM collections WHERE name = ?", (collection_name,)).fetchone()
        if collection is None:
            raise ValueError("Explicit source collection does not exist")
        before = pathlib.Path(ledger_path).read_bytes()
        drawers = []
        rows = db.execute("SELECT id, document, metadata_json, created_at, updated_at FROM documents WHERE collection_id = ? ORDER BY id", (collection[0],))
        for row in rows:
            metadata = json.loads(row["metadata_json"] or "{}")
            if not isinstance(metadata, dict):
                raise ValueError("Invalid document metadata")
            source = metadata.get("source_path") or metadata.get("source_file") or metadata.get("source")
            drawer = {"id": row["id"], "content": row["document"], "wing": metadata.get("wing"), "room": metadata.get("room"), "metadata": metadata, "collectionName": collection_name}
            if source is not None:
                drawer["sourcePath"] = source
            for snake, camel in (("created_at", "createdAt"), ("updated_at", "updatedAt")):
                value = row[snake]
                if value is not None:
                    drawer[camel] = value
            drawers.append(drawer)
        after = pathlib.Path(ledger_path).read_bytes()
        if before != after:
            raise ValueError("Legacy ledger changed during read; take a new snapshot")
        return {"drawers": drawers, "ledger": json.loads(before)}
    finally:
        db.close()


def experience_snapshot(filename):
    db = connect(filename)
    try:
        columns = {row[1] for row in db.execute("PRAGMA table_info(experiences)")}
        if "json" not in columns:
            raise ValueError("Unsupported legacy experience SQLite schema")
        return {"version": 1, "experiences": [json.loads(row[0]) for row in db.execute("SELECT json FROM experiences ORDER BY id")]}
    finally:
        db.close()


try:
    if sys.argv[1] == "memory":
        value = memory_snapshot(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1] == "experiences":
        value = experience_snapshot(sys.argv[2])
    else:
        raise ValueError("Invalid reader mode")
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
except (OSError, ValueError, TypeError, sqlite3.Error):
    sys.stderr.write("Legacy read-only snapshot failed; source data was not changed.\n")
    sys.exit(2)
`;

function absoluteSource(filename: string, field: string) {
  required(filename, field);
  if (!path.isAbsolute(filename)) throw new Error(`Legacy import ${field} must be absolute`);
  return filename;
}

async function sqliteJson(args: string[], python: string): Promise<unknown> {
  const result = await exec(python, ["-I", "-c", sqliteReader, ...args], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  }).catch(() => {
    // Subprocess errors can include private paths or SQLite contents: convert only here.
    throw new Error("Legacy read-only snapshot failed; source data was not changed");
  });
  return JSON.parse(result.stdout);
}

export async function readLegacySnapshot(input: {
  sqlitePath: string;
  ledgerPath: string;
  collectionName: string;
  python?: string;
}): Promise<{ drawers: LegacyDrawer[]; ledger: LegacyLedger }> {
  required(input.collectionName, "source collection");
  const value = await sqliteJson(
    [
      "memory",
      absoluteSource(input.sqlitePath, "SQLite source"),
      absoluteSource(input.ledgerPath, "ledger source"),
      input.collectionName,
    ],
    input.python ?? "python3",
  );
  if (!object(value) || !Array.isArray(value.drawers))
    throw new Error("Invalid legacy SQLite snapshot");
  return {
    drawers: value.drawers as LegacyDrawer[],
    ledger: parseLegacyLedger(value.ledger),
  };
}

export async function readLegacyExperiences(input: {
  jsonPath?: string;
  sqlitePath?: string;
  python?: string;
}): Promise<LegacyExperience[]> {
  if (input.jsonPath && input.sqlitePath) throw new Error("Select one experience source");
  if (input.jsonPath) {
    return parseLegacyExperiences(
      JSON.parse(await readFile(absoluteSource(input.jsonPath, "experience JSON"), "utf8")),
    );
  }
  if (input.sqlitePath) {
    return parseLegacyExperiences(
      await sqliteJson(
        ["experiences", absoluteSource(input.sqlitePath, "experience SQLite")],
        input.python ?? "python3",
      ),
    );
  }
  return [];
}

/** Imported facts enter the ordinary transactional outbox, not a direct vector write. */
export async function applyLegacyImport(
  plan: LegacyImportPlan,
  deps: {
    importFact(input: SemanticFactImportInput, context: AdapterContext): Promise<SemanticFact>;
    withTenant<T>(
      target: { spaceId: string; userId: string },
      operation: () => Promise<T>,
    ): Promise<T>;
    scheduleIndex(spaceId: string): Promise<void>;
    signal?: AbortSignal;
  },
): Promise<LegacyImportManifest> {
  const manifest = structuredClone(plan.manifest);
  manifest.mode = "apply";
  manifest.applied = 0;
  const signal = deps.signal ?? new AbortController().signal;
  const operationId = `legacy-import:${randomUUID()}`;
  await deps.withTenant(plan.target, async () => {
    for (const record of plan.records) {
      signal.throwIfAborted();
      const context: AdapterContext = {
        operationId,
        traceId: operationId,
        spaceId: plan.target.spaceId,
        userId: plan.target.userId,
        botId: record.botId,
        signal,
      };
      await deps.importFact(record, context);
      manifest.applied += 1;
    }
  });
  if (manifest.applied > 0) await deps.scheduleIndex(plan.target.spaceId);
  return manifest;
}

/** A named target is not isolation: require a random verification database AND runtime login. */
export function assertIsolatedImportTarget(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Invalid isolated import database URL");
  }
  const database = url.pathname.slice(1);
  const role = url.username;
  const runnerDatabase = /^rkz_c_(\d{8}_\d{6}_[a-f0-9]{6})(?:_[a-f0-9]{32})?$/.exec(database);
  const genericDatabase = /^rakazo_test_([a-f0-9]{32})$/.exec(database);
  const isolatedRole = runnerDatabase
    ? role === `rkz_c_rt_${runnerDatabase[1]}`
    : genericDatabase
      ? role === `rakazo_test_rt_${genericDatabase[1]}`
      : false;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !isolatedRole ||
    !url.password
  )
    throw new Error(
      "Apply requires an isolated random database and matching runtime login on loopback",
    );
}

export interface LegacyImportCliOptions {
  sqlitePath: string;
  ledgerPath: string;
  collectionName: string;
  sourceId: string;
  target: LegacyTarget;
  botMappings: LegacyBotMapping[];
  asOf: string;
  apply: boolean;
  testTarget: boolean;
  databaseUrlFile?: string;
  manifestPath?: string;
  experienceJsonPath?: string;
  experienceSqlitePath?: string;
  python?: string;
}

export function parseLegacyImportArgs(args: string[]): LegacyImportCliOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const botMappings: LegacyBotMapping[] = [];
  const names = new Set([
    "--source-sqlite",
    "--source-ledger",
    "--source-collection",
    "--source-id",
    "--target-space",
    "--target-user",
    "--target-bot",
    "--as-of",
    "--manifest",
    "--database-url-file",
    "--experience-json",
    "--experience-sqlite",
    "--python",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["--apply", "--test-target", "--shared"].includes(arg)) {
      if (switches.has(arg)) throw new Error("Duplicate legacy import option");
      switches.add(arg);
    } else if (arg === "--map-bot") {
      const mapping = args[++index];
      const separator = mapping?.indexOf("=") ?? -1;
      if (!mapping || separator < 1 || separator === mapping.length - 1)
        throw new Error("Use --map-bot oldBotId=newBotId");
      botMappings.push({
        legacyBotId: mapping.slice(0, separator),
        targetBotId: mapping.slice(separator + 1),
      });
    } else {
      if (!names.has(arg) || values.has(arg))
        throw new Error("Unknown or duplicate legacy import option");
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing legacy import option value");
      values.set(arg, value);
    }
  }
  const get = (name: string) => {
    const value = values.get(name);
    required(value, name);
    return value;
  };
  const options: LegacyImportCliOptions = {
    sqlitePath: absoluteSource(get("--source-sqlite"), "SQLite source"),
    ledgerPath: absoluteSource(get("--source-ledger"), "ledger source"),
    collectionName: get("--source-collection"),
    sourceId: get("--source-id"),
    target: {
      spaceId: get("--target-space"),
      userId: get("--target-user"),
      botId: get("--target-bot"),
      scope: switches.has("--shared") ? "shared" : "isolated",
    },
    botMappings,
    asOf: values.has("--as-of") ? timestamp(get("--as-of"), "asOf") : new Date().toISOString(),
    apply: switches.has("--apply"),
    testTarget: switches.has("--test-target"),
    ...(values.has("--database-url-file")
      ? {
          databaseUrlFile: absoluteSource(get("--database-url-file"), "database URL file"),
        }
      : {}),
    ...(values.has("--manifest")
      ? { manifestPath: absoluteSource(get("--manifest"), "manifest path") }
      : {}),
    ...(values.has("--experience-json")
      ? {
          experienceJsonPath: absoluteSource(get("--experience-json"), "experience JSON"),
        }
      : {}),
    ...(values.has("--experience-sqlite")
      ? {
          experienceSqlitePath: absoluteSource(get("--experience-sqlite"), "experience SQLite"),
        }
      : {}),
    ...(values.has("--python") ? { python: get("--python") } : {}),
  };
  if (options.experienceJsonPath && options.experienceSqlitePath)
    throw new Error("Select one experience source");
  if (options.apply && !options.databaseUrlFile) {
    throw new Error("CLI apply requires an explicit --database-url-file");
  }
  if (!options.apply && (options.testTarget || options.databaseUrlFile))
    throw new Error("Database options require --apply");
  if (
    options.manifestPath &&
    [
      options.sqlitePath,
      options.ledgerPath,
      options.experienceJsonPath,
      options.experienceSqlitePath,
      options.databaseUrlFile,
    ].includes(options.manifestPath)
  ) {
    throw new Error("Manifest must not replace a source or credential file");
  }
  return options;
}

export async function runLegacyImport(
  options: LegacyImportCliOptions,
): Promise<LegacyImportManifest> {
  // Explicit target credentials (and the optional test fence) precede source and DB reads.
  let connectionString: string | undefined;
  if (options.apply) {
    if (!options.databaseUrlFile)
      throw new Error("CLI apply requires an explicit --database-url-file");
    connectionString = (await readFile(options.databaseUrlFile, "utf8")).trim();
    required(connectionString, "database URL");
    if (options.testTarget) assertIsolatedImportTarget(connectionString);
  }
  const snapshot = await readLegacySnapshot({
    sqlitePath: options.sqlitePath,
    ledgerPath: options.ledgerPath,
    collectionName: options.collectionName,
    python: options.python,
  });
  const experiences = await readLegacyExperiences({
    jsonPath: options.experienceJsonPath,
    sqlitePath: options.experienceSqlitePath,
    python: options.python,
  });
  const plan = planLegacyImport({
    ...snapshot,
    experiences,
    sourceId: options.sourceId,
    target: options.target,
    botMappings: options.botMappings,
    asOf: options.asOf,
  });
  let manifest = plan.manifest;
  if (connectionString) {
    const { createDb, runAsTenant, SemanticFactStore } = await import(
      "../packages/db/src/index.js"
    );
    const { GraphileJobPublisher } = await import("../packages/adapters/src/wakeup.js");
    const { semanticMemorySyncJob } = await import("../packages/adapter-kit/src/index.js");
    const db = createDb(connectionString, {
      applicationName: "legacy-memory-import",
    });
    const publisher = new GraphileJobPublisher(db.pool);
    try {
      const store = new SemanticFactStore(db.prisma);
      manifest = await applyLegacyImport(plan, {
        importFact: (record, context) => store.importFact(record, context),
        withTenant: runAsTenant,
        scheduleIndex: (spaceId) => publisher.enqueue(semanticMemorySyncJob(spaceId)),
      });
    } finally {
      await publisher.close();
      await db.pool.end();
    }
  }
  if (options.manifestPath) {
    // Counts only; refuse an existing path rather than overwriting an old report or source.
    await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options: LegacyImportCliOptions | undefined;
  try {
    options = parseLegacyImportArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid legacy import options"}\n`,
    );
    process.exitCode = 1;
  }
  if (options) {
    runLegacyImport(options)
      .then((manifest) => {
        process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      })
      .catch(() => {
        process.stderr.write(
          "Legacy import failed. Completed facts, if any, remain idempotent; no source data was changed.\n",
        );
        process.exitCode = 1;
      });
  }
}
