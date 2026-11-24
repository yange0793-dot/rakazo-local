import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRunModel,
  AgentRuntime,
  AgentUsage,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import {
  FILE_DELIVERY_OUTPUT_CONTRACT,
  FILE_DELIVERY_PLAYBOOKS,
} from "../../../adapters/src/fixtures/work-improvement.js";
import {
  CURRENT_IMPROVER,
  parseTicketImprovementProposal,
  ticketImprovementProposalRequest,
} from "../../../adapters/src/ticket-improvement.js";
import type {
  JsonValue,
  WorkImprovementCase,
  WorkImprovementComparison,
  WorkImprovementHistorySummary,
  WorkImprovementInput,
  WorkImprovementRun,
} from "../../../adapters/src/work-improvement.js";
import {
  compareWorkImprovement,
  evaluateWorkImprovementRevision,
  summarizeWorkImprovementHistory,
} from "../../../adapters/src/work-improvement.js";
import type { WorkImprovementComposition } from "../../../adapters/src/work-improvement-compose.js";
import { compareAndComposeWorkImprovement } from "../../../adapters/src/work-improvement-compose.js";
import fixture from "./fixtures/learning-stream/learning-stream.seed-v1.json" with { type: "json" };
import type { EvalPricing } from "./measurement.js";
import { measureCalls, SpendBudget } from "./measurement.js";

export const LEARNING_STREAM_FIXTURE_VERSION = fixture.fixtureVersion;
export const LEARNING_STREAM_DEFAULT_SEED = fixture.defaultSeed;
const LEARNING_STREAM_PHASES = [
  "bootstrap_proposal",
  "bootstrap_compose",
  "history_update",
  "frozen_proposal",
  "frozen_compose",
  "accumulating_proposal",
  "accumulating_compose",
  "selection",
  "holdout",
  "equal_budget_retry",
] as const;
type LearningStreamPhase = (typeof LEARNING_STREAM_PHASES)[number];

const BASELINE = {
  revision: fixture.baselineRevision,
  playbook: FILE_DELIVERY_PLAYBOOKS.baseline.playbook,
};
const MAX_STREAM_TASKS = 36;

type Split = "train" | "selection" | "holdout";
type Archetype = (typeof fixture.archetypes)[number];
type StreamTask = {
  id: string;
  logicalTime: string;
  split: Split;
  archetype: Archetype;
  feedback: string;
  case: WorkImprovementCase;
  expectedHash: string;
};

export type LearningStreamManifest = {
  schemaVersion: "learning-stream.manifest.v1";
  fixtureVersion: string;
  seed: number;
  generatedAt: string;
  partitions: { train: number; selection: number; holdout: number };
  orderedTasks: Array<{
    id: string;
    ordinal: number;
    logicalTime: string;
    split: Split;
    inputSha256: string;
    expectedSha256: string;
  }>;
};

export type LearningStreamCallReceipt = {
  id: string;
  phase: string;
  provider: string;
  model: string;
  providerRequestIdSha256: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  usageSource: string | null;
  reservedTokens: number;
  status: "settled" | "missing_usage";
};

export type LearningStreamRunReceipt = {
  taskId: string;
  revision: string;
  attempt: number;
  verdict: WorkImprovementRun["score"]["verdict"];
  finished: boolean;
  durationMs: number;
  errors: Array<{ code: WorkImprovementRun["errors"][number]["code"] }>;
  toolCalls: Array<{
    name: string;
    args: JsonValue;
    status: WorkImprovementRun["tools"][number]["status"];
    error: string | null;
  }>;
  usage: Array<
    Omit<WorkImprovementRun["usage"][number], "callId" | "providerRequestId"> & {
      providerRequestIdSha256: string | null;
    }
  >;
  outputSha256: string;
};

export type LearningStreamReport = {
  schemaVersion: "learning-stream.report.v1";
  status: "running" | "completed" | "incomplete" | "failed";
  startedAt: string;
  completedAt: string | null;
  fixtureVersion: string;
  manifest: LearningStreamManifest;
  codeRevision: string | null;
  workingDiffHash: string | null;
  environment: {
    node: string;
    platform: string;
    architecture: string;
    reversibleEnvironment: "fresh-read-only-synthetic-snapshot";
    runtime: ReturnType<AgentRuntime["describe"]>;
  };
  execution: {
    mode: "live" | "offline-fixture";
    requestedServiceTier: "priority" | null;
    model: {
      provider: string;
      id: string;
      thinkingLevel: AgentRunModel["thinkingLevel"] | null;
      maxTokens: number | null;
      contextWindow: number | null;
    };
    route: string;
    spendCapUsd: number | null;
    pricing: EvalPricing | null;
  };
  revisionRefs: {
    baseline: string;
    improver: string;
    scorer: string | null;
    proposals: Array<{ condition: string; revision: string; taskId: string }>;
    compositions: Array<{ condition: string; revision: string; taskId: string }>;
  };
  promptAudit: Array<{
    phase: "proposal" | "composition";
    condition: "shared-bootstrap" | "frozen" | "accumulating";
    taskIds: string[];
    historyTaskIds: string[];
    historyComparisonIds: string[];
    promptSha256: string;
    excludedSelectionAndHoldoutTaskIds: string[];
  }>;
  phases: Array<{
    name: string;
    status: "running" | "completed" | "unknown" | "failed" | "not_run";
    startedAt: string;
    completedAt: string | null;
    taskIds: string[];
    reason: string | null;
    details?: Record<string, unknown>;
  }>;
  histories: {
    frozen: { comparisonIds: string[]; taskIds: string[] };
    accumulating: { comparisonIds: string[]; taskIds: string[] };
  };
  bootstrap: {
    taskId: string;
    proposal: { status: "candidate" | "skip" | "unknown"; revision: string | null };
    composition: {
      status: WorkImprovementComposition["composition"]["status"];
      candidateRevision: string | null;
      initial: ReturnType<typeof comparisonReceipt>;
      composed: ReturnType<typeof comparisonReceipt> | null;
    } | null;
  } | null;
  training: Array<{
    condition: "frozen" | "accumulating";
    taskId: string;
    historyComparisonIds: string[];
    proposal: { status: "candidate" | "skip" | "unknown"; revision: string | null };
    composition: {
      status: WorkImprovementComposition["composition"]["status"];
      candidateRevision: string | null;
      initial: ReturnType<typeof comparisonReceipt>;
      composed: ReturnType<typeof comparisonReceipt> | null;
    } | null;
  }>;
  selection: Array<{
    condition: "frozen" | "accumulating";
    candidateRevision: string;
    selected: boolean;
    metrics: ReturnType<typeof comparisonReceipt>["summary"];
    runs: LearningStreamRunReceipt[];
  }>;
  holdout: {
    frozen: {
      revision: string;
      metrics: ReturnType<typeof runMetrics>;
      runs: LearningStreamRunReceipt[];
    };
    accumulating: {
      revision: string;
      metrics: ReturnType<typeof runMetrics>;
      runs: LearningStreamRunReceipt[];
    };
    baseline: {
      revision: string;
      metrics: ReturnType<typeof runMetrics>;
      runs: LearningStreamRunReceipt[];
    };
    equalBudgetRetry: {
      revision: string;
      metrics: {
        final: ReturnType<typeof runMetrics>;
        attempts: ReturnType<typeof runMetrics>;
      };
      runs: LearningStreamRunReceipt[];
    };
  } | null;
  usage: {
    calls: LearningStreamCallReceipt[];
    blockedAttempts: Array<{ phase: string; reason: string }>;
    byPhase: Record<string, { modelCalls: number; reservedTokens: number }>;
    totals: {
      modelCalls: number;
      reservedTokens: number;
      knownTokens: number;
      unknownUsageCalls: number;
      costUsd: number | null;
      costStatus: "known" | "unknown";
      spendGuardUsedUsd: number | null;
      spendGuardReservedUsd: number | null;
    };
  };
  outboundHeaderReceipts: Array<{
    request: number;
    headerNames: string[];
    userAgent: string | null;
    originator: string | null;
    app: string | null;
    authorizationPresent: boolean;
    status: number | null;
    providerRequestIdSha256: string | null;
    transportError: string | null;
    requestedServiceTier: "priority" | null;
    serviceTierApplied: boolean;
    terminalStatus: string | null;
    tokenUsage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    } | null;
    returnedServiceTier: string | null;
  }>;
  assessment: {
    statisticalSignificanceClaimed: false;
    adoptionQualification: "not_applicable" | "unknown_cost" | "cost_known_not_qualified";
    note: string;
  };
  termination: {
    status: "running" | "completed" | "budget_exhausted" | "timed_out" | "interrupted" | "failed";
    reason: string | null;
    startedAt: string;
    finishedAt: string | null;
    modelCalls: number;
    reservedTokens: number;
    blockedAttempts: number;
  };
};

export type LearningStreamOptions = {
  seed: number;
  trainCount: number;
  selectionCount: number;
  holdoutCount: number;
  model: AgentRunModel;
  route: string;
  codeRevision: string | null;
  workingDiffHash: string | null;
  spendCapUsd?: number;
  serviceTier?: "priority";
  mode?: "live" | "offline-fixture";
};

export type LearningStreamDeps = {
  runtime: AgentRuntime;
  context?: { signal?: AbortSignal };
  pricing?: EvalPricing;
  onProgress?: (report: LearningStreamReport) => void;
  outboundHeaderReceipts?: () => LearningStreamReport["outboundHeaderReceipts"];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: string): string {
  return sha256(value);
}

function deterministicOrder(seed: number): Archetype[] {
  const items = [...fixture.archetypes];
  let state = seed >>> 0;
  for (let index = items.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [items[index], items[target]] = [items[target]!, items[index]!];
  }
  return items;
}

function materialText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildTask(seed: number, ordinal: number, split: Split, archetype: Archetype): StreamTask {
  const id = `task-${String(ordinal + 1).padStart(3, "0")}`;
  const logicalTime = new Date(Date.UTC(2026, 0, 1 + ordinal)).toISOString();
  const packageId = `${fixture.packageIdPrefix}-${(seed >>> 0).toString(16).padStart(8, "0")}-${String(ordinal + 1).padStart(3, "0")}`;
  const expectedFiles = Object.entries(fixture.fileContents).map(([filePath, content]) => ({
    path: filePath,
    sha256: contentHash(content),
  }));
  const actual = new Map<string, string>(Object.entries(fixture.fileContents));
  let completeInventory = true;
  let projectId = fixture.projectId;
  let selectionStatus = "missing";
  let uploadStatus = "completed";

  switch (archetype) {
    case "unexpected_file":
      actual.set(fixture.extraPath, fixture.extraContents);
      break;
    case "missing_upload_receipt":
      selectionStatus = "selected";
      uploadStatus = "missing";
      break;
    case "incomplete_inventory":
      completeInventory = false;
      break;
    case "hash_mismatch":
      actual.set("app/main.txt", fixture.wrongHashContents);
      break;
    case "runtime_exclusion":
      actual.set(fixture.runtimePath, fixture.runtimeContents);
      break;
    case "wrong_project":
      projectId = "project-unrelated-example";
      break;
    case "clean":
      break;
  }

  const request = {
    projectId,
    packageId,
    runtimeAllowlist: [fixture.runtimePath],
  };
  const manifest = { packageId, files: expectedFiles };
  const installedInventory = {
    packageId,
    complete: completeInventory,
    files: [...actual.entries()].map(([path, content]) => ({
      path,
      sha256: contentHash(content),
    })),
  };
  const selectionReceipt = { packageId, status: selectionStatus };
  const uploadReceipt = { packageId, status: uploadStatus };
  const materials: Record<string, string> = {
    "request.json": materialText(request),
    "manifest.json": materialText(manifest),
    "installed-files.json": materialText(installedInventory),
    "selection-receipt.json": materialText(selectionReceipt),
    "upload-receipt.json": materialText(uploadReceipt),
    ...Object.fromEntries([...actual].map(([path, content]) => [`installed/${path}`, content])),
  };
  const taskText = [
    `At ${logicalTime}, verify retained package ${packageId} for project ${fixture.projectId}.`,
    "Use the isolated evidence to report installation, directory, and completed-upload checks.",
    "Do not infer missing evidence or perform an external action.",
  ].join(" ");
  const expected = gradeEnvironment(request, manifest, installedInventory, uploadReceipt);
  const category: WorkImprovementCase["category"] =
    expected.outcome === "complete"
      ? "success"
      : expected.outcome === "failed"
        ? "failure"
        : expected.outcome === "unknown"
          ? "insufficient_evidence"
          : "scope_exception";
  const feedback =
    expected.outcome === "complete"
      ? "The recorded checks match the synthetic package evidence; no correction is requested."
      : expected.outcome === "out_of_scope"
        ? "The package belongs to another project; keep the result out of scope."
        : expected.checks.upload === "unknown"
          ? "A selected package is not evidence of a completed upload."
          : expected.checks.directory === "unknown"
            ? "An incomplete file inventory cannot establish a clean directory."
            : expected.checks.directory === "fail"
              ? "The complete installed directory contains an unrequested file."
              : (expected.observations.hash_mismatches?.length ?? 0) > 0
                ? "The installed file hash differs from the manifest."
                : "The installed package is missing a manifest file.";

  return {
    id,
    logicalTime,
    split,
    archetype,
    feedback,
    expectedHash: sha256(canonical(expected)),
    case: {
      id,
      project: fixture.projectId,
      family: "synthetic-package-delivery",
      split: split === "train" ? "diagnostic" : "holdout",
      category,
      protection: category !== "failure",
      input: { task: taskText, materials },
      expected,
      requiredSteps: [
        { tool: "list_files", path: "" },
        { tool: "list_files", path: "installed" },
        { tool: "read_file", path: "request.json" },
        { tool: "read_file", path: "manifest.json" },
        { tool: "read_file", path: "installed-files.json" },
        { tool: "read_file", path: "selection-receipt.json" },
        { tool: "read_file", path: "upload-receipt.json" },
      ],
    },
  };
}

function gradeEnvironment(
  request: {
    projectId: string;
    packageId: string;
    runtimeAllowlist: string[];
  },
  manifest: {
    packageId: string;
    files: Array<{ path: string; sha256: string }>;
  },
  installed: {
    complete: boolean;
    files: Array<{ path: string; sha256: string }>;
  },
  upload: { packageId: string; status: string },
): WorkImprovementCase["expected"] {
  const emptyObservations = {
    missing_files: [],
    unexpected_files: [],
    hash_mismatches: [],
    excluded_runtime_files: [],
  };
  if (request.projectId !== fixture.projectId || manifest.packageId !== request.packageId) {
    return {
      schemaVersion: "work-improvement.output.v1",
      outcome: "out_of_scope",
      checks: {
        installation: "not_applicable",
        directory: "not_applicable",
        upload: "not_applicable",
      },
      observations: emptyObservations,
    };
  }
  const installedByPath = new Map(installed.files.map((entry) => [entry.path, entry.sha256]));
  const missing = manifest.files
    .filter((entry) => !installedByPath.has(entry.path))
    .map((entry) => entry.path)
    .sort();
  const mismatched = manifest.files
    .filter(
      (entry) =>
        installedByPath.has(entry.path) && installedByPath.get(entry.path) !== entry.sha256,
    )
    .map((entry) => entry.path)
    .sort();
  const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
  const unexpected: string[] = [];
  const excluded: string[] = [];
  for (const entry of installed.files) {
    if (expectedPaths.has(entry.path)) continue;
    if (request.runtimeAllowlist.includes(entry.path)) excluded.push(entry.path);
    else unexpected.push(entry.path);
  }
  const checks: WorkImprovementCase["expected"]["checks"] = {
    installation: missing.length || mismatched.length ? "fail" : "pass",
    directory: !installed.complete ? "unknown" : unexpected.length ? "fail" : "pass",
    upload:
      upload.packageId === request.packageId && upload.status === "completed" ? "pass" : "unknown",
  };
  const values = Object.values(checks);
  const outcome = values.includes("fail")
    ? "failed"
    : values.includes("unknown")
      ? "unknown"
      : "complete";
  return {
    schemaVersion: "work-improvement.output.v1",
    outcome,
    checks,
    observations: {
      missing_files: missing,
      unexpected_files: unexpected.sort(),
      hash_mismatches: mismatched,
      excluded_runtime_files: excluded.sort(),
    },
  };
}

function buildStream(
  seed: number,
  trainCount: number,
  selectionCount: number,
  holdoutCount: number,
) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
    throw new Error("Seed must be an unsigned 32-bit integer.");
  for (const [name, count] of Object.entries({ trainCount, selectionCount, holdoutCount })) {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STREAM_TASKS)
      throw new Error(`${name} must be an integer between 1 and ${MAX_STREAM_TASKS}.`);
  }
  const total = trainCount + selectionCount + holdoutCount;
  if (total > MAX_STREAM_TASKS) throw new Error(`At most ${MAX_STREAM_TASKS} tasks are allowed.`);
  const archetypes = deterministicOrder(seed);
  const splits: Array<{ split: Split; count: number }> = [
    { split: "train", count: trainCount },
    { split: "selection", count: selectionCount },
    { split: "holdout", count: holdoutCount },
  ];
  const tasks: StreamTask[] = [];
  for (const { split, count } of splits) {
    for (let index = 0; index < count; index += 1) {
      const ordinal = tasks.length;
      tasks.push(buildTask(seed, ordinal, split, archetypes[ordinal % archetypes.length]!));
    }
  }
  return tasks;
}

export function createLearningStreamManifest(
  input: {
    seed?: number;
    trainCount?: number;
    selectionCount?: number;
    holdoutCount?: number;
    generatedAt?: string;
  } = {},
): LearningStreamManifest {
  const seed = input.seed ?? LEARNING_STREAM_DEFAULT_SEED;
  const trainCount = input.trainCount ?? 3;
  const selectionCount = input.selectionCount ?? 2;
  const holdoutCount = input.holdoutCount ?? 3;
  const tasks = buildStream(seed, trainCount, selectionCount, holdoutCount);
  return {
    schemaVersion: "learning-stream.manifest.v1",
    fixtureVersion: LEARNING_STREAM_FIXTURE_VERSION,
    seed,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    partitions: { train: trainCount, selection: selectionCount, holdout: holdoutCount },
    orderedTasks: tasks.map((task, ordinal) => ({
      id: task.id,
      ordinal,
      logicalTime: task.logicalTime,
      split: task.split,
      inputSha256: sha256(canonical(task.case.input)),
      expectedSha256: task.expectedHash,
    })),
  };
}

export function listLearningStreamTasks(
  input: {
    seed?: number;
    trainCount?: number;
    selectionCount?: number;
    holdoutCount?: number;
  } = {},
) {
  return buildStream(
    input.seed ?? LEARNING_STREAM_DEFAULT_SEED,
    input.trainCount ?? 3,
    input.selectionCount ?? 2,
    input.holdoutCount ?? 3,
  ).map((task) => ({
    id: task.id,
    logicalTime: task.logicalTime,
    split: task.split,
    inputSha256: sha256(canonical(task.case.input)),
  }));
}

function workInput(
  model: AgentRunModel,
  route: string,
  taskCases: WorkImprovementCase[],
  baseline: WorkImprovementInput["baseline"],
  candidate: WorkImprovementInput["candidate"],
  comparisonId: string,
): WorkImprovementInput {
  return {
    comparisonId,
    caseSet: { id: LEARNING_STREAM_FIXTURE_VERSION, revision: "time-split-v1" },
    source: {
      runId: `learning-stream:${comparisonId}`,
      project: fixture.projectId,
      family: "synthetic-package-delivery",
      receipt: { schemaVersion: "synthetic.receipt.v1", comparisonId },
    },
    baseline,
    candidate,
    improverRevision: CURRENT_IMPROVER,
    execution: {
      model,
      route,
      budget: {},
    },
    outputContract: FILE_DELIVERY_OUTPUT_CONTRACT,
    cases: taskCases,
  };
}

function feedbackReceipt(task: StreamTask) {
  const request = JSON.parse(task.case.input.materials["request.json"]!) as {
    packageId: string;
  };
  const selection = JSON.parse(task.case.input.materials["selection-receipt.json"]!) as {
    status: string;
  };
  const upload = JSON.parse(task.case.input.materials["upload-receipt.json"]!) as {
    status: string;
  };
  return {
    schemaVersion: "synthetic.training-receipt.v1",
    taskId: task.id,
    packageId: request.packageId,
    selectionStatus: selection.status,
    uploadStatus: upload.status,
  };
}

type RunReceiptPricing = {
  pricing?: EvalPricing;
  model: Pick<AgentRunModel, "provider" | "id">;
  callsById: ReadonlyMap<string, LearningStreamCallReceipt>;
};

function receiptRun(
  taskId: string,
  run: WorkImprovementRun,
  attempt: number,
  { pricing, model, callsById }: RunReceiptPricing,
): LearningStreamRunReceipt {
  return {
    taskId,
    revision: run.revision,
    attempt,
    verdict: run.score.verdict,
    finished: run.finished,
    durationMs: run.durationMs,
    errors: run.errors.map(({ code }) => ({ code })),
    toolCalls: run.tools.map((tool) => ({
      name: tool.name,
      args: tool.args,
      status: tool.status,
      error: tool.error?.code ?? null,
    })),
    usage: run.usage.map(({ callId, providerRequestId, ...safeUsage }, index) => {
      let costUsd = safeUsage.costSource === "provider-reported" ? safeUsage.costUsd : null;
      let costSource = costUsd === null ? null : "provider-reported";
      if (costUsd === null) {
        // WorkImprovement omits the 1h split. The observer prices it with the full breakdown.
        const settled = callId ? callsById.get(callId) : undefined;
        if (settled) {
          ({ costUsd, costSource } = settled);
        } else if (
          pricing &&
          safeUsage.provider === model.provider &&
          safeUsage.model === model.id &&
          safeUsage.cacheWriteTokens === 0
        ) {
          costUsd = measureCalls(
            [
              {
                ...safeUsage,
                id: callId ?? `${taskId}:${attempt}:${index}`,
                cacheWrite1hTokens: 0,
              },
            ],
            pricing,
          ).costUsd;
          if (costUsd !== null) costSource = "explicit-pricing-estimate";
        }
      }
      return {
        ...safeUsage,
        costUsd,
        costSource,
        providerRequestIdSha256: providerRequestId ? sha256(providerRequestId) : null,
      };
    }),
    outputSha256: sha256(run.outputText),
  };
}

function receiptRuns(
  taskId: string,
  run: WorkImprovementRun,
  pricing: RunReceiptPricing,
): LearningStreamRunReceipt[] {
  return [
    ...(run.previousAttempt ? [receiptRun(taskId, run.previousAttempt, 1, pricing)] : []),
    receiptRun(taskId, run, run.previousAttempt ? 2 : 1, pricing),
  ];
}

function comparisonReceipt(comparison: WorkImprovementComparison, pricing: RunReceiptPricing) {
  const baselineRuns = comparison.cases.flatMap((entry) =>
    receiptRuns(entry.id, entry.baseline, pricing),
  );
  const candidateRuns = comparison.cases.flatMap((entry) =>
    receiptRuns(entry.id, entry.candidate, pricing),
  );
  const baselineCosts = runMetrics(baselineRuns);
  const candidateCosts = runMetrics(candidateRuns);
  return {
    comparisonId: comparison.comparisonId,
    decision: comparison.decision,
    reasons: comparison.reasons,
    scorerVersion: comparison.scorerVersion,
    summary: {
      ...comparison.summary,
      baseline: {
        ...comparison.summary.baseline,
        costUsd: baselineCosts.costUsd,
        knownCostUsd: baselineCosts.knownCostUsd,
      },
      candidate: {
        ...comparison.summary.candidate,
        costUsd: candidateCosts.costUsd,
        knownCostUsd: candidateCosts.knownCostUsd,
      },
    },
    cases: comparison.cases.map((entry) => ({
      taskId: entry.id,
      baseline: receiptRuns(entry.id, entry.baseline, pricing),
      candidate: receiptRuns(entry.id, entry.candidate, pricing),
    })),
  };
}

function runMetrics(runs: LearningStreamRunReceipt[]) {
  const usage = runs.flatMap((run) => run.usage);
  const knownCosts = usage.flatMap(({ costUsd }) => (costUsd === null ? [] : [costUsd]));
  const knownCostUsd = knownCosts.length ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null;
  return {
    runs: runs.length,
    passed: runs.filter((run) => run.verdict === "pass").length,
    failed: runs.filter((run) => run.verdict === "fail").length,
    unknown: runs.filter((run) => run.verdict === "unknown").length,
    unfinished: runs.filter((run) => !run.finished).length,
    modelCalls: usage.length,
    knownTokens: usage.reduce((sum, call) => {
      const measured =
        call.totalTokens ??
        (call.inputTokens !== null && call.outputTokens !== null
          ? call.inputTokens + call.outputTokens
          : 0);
      return sum + measured;
    }, 0),
    unknownUsageCalls: usage.filter(
      (call) =>
        call.totalTokens === null && (call.inputTokens === null || call.outputTokens === null),
    ).length,
    costUsd: knownCosts.length === usage.length ? knownCostUsd : null,
    knownCostUsd,
  };
}

function proposalCandidate(proposal: ReturnType<typeof parseTicketImprovementProposal>) {
  if (proposal?.kind !== "candidate") return null;
  return {
    revision: `proposal:${sha256(canonical(proposal.playbook))}`,
    playbook: proposal.playbook,
  };
}

function modelSecrets(model: AgentRunModel): string[] {
  return [
    model.apiKey,
    ...Object.values(model.headers ?? {}),
    model.oauth?.credential.access,
    model.oauth?.credential.refresh,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function createTrackedRuntime(
  runtime: AgentRuntime,
  model: AgentRunModel,
  report: LearningStreamReport,
  options: LearningStreamOptions,
  deps: LearningStreamDeps,
  currentPhase: () => string,
) {
  const spend =
    deps.pricing && options.spendCapUsd !== undefined
      ? new SpendBudget(options.spendCapUsd, deps.pricing)
      : undefined;
  const reservations = new Map<
    string,
    {
      receiptId: string;
      reservedTokens: number;
      spendId: string | null;
      downstreamId: string | null;
      downstream: ModelCallObserver | undefined;
      phase: string;
      call: Parameters<ModelCallObserver["beforeCall"]>[0];
    }
  >();
  const callsById = new Map<string, LearningStreamCallReceipt>();
  const perPhase = new Map<string, { modelCalls: number; reservedTokens: number }>();
  const promptHashes = new Map<string, string>();
  let globalCalls = 0;
  let globalReservedTokens = 0;
  let exhaustedReason: string | null = null;

  const publish = () => {
    const calls = report.usage.calls;
    const costUsd =
      calls.length > 0 && calls.every((call) => call.costUsd !== null)
        ? calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0)
        : null;
    report.usage = {
      calls: report.usage.calls,
      blockedAttempts: report.usage.blockedAttempts,
      byPhase: Object.fromEntries([...perPhase].map(([phase, totals]) => [phase, { ...totals }])),
      totals: {
        modelCalls: globalCalls,
        reservedTokens: globalReservedTokens,
        knownTokens: report.usage.calls.reduce((sum, call) => {
          const tokens =
            call.totalTokens ??
            (call.inputTokens !== null && call.outputTokens !== null
              ? call.inputTokens + call.outputTokens
              : 0);
          return sum + tokens;
        }, 0),
        unknownUsageCalls: report.usage.calls.filter(
          (call) =>
            call.status === "missing_usage" ||
            (call.totalTokens === null &&
              (call.inputTokens === null || call.outputTokens === null)),
        ).length,
        costUsd,
        costStatus: costUsd === null ? "unknown" : "known",
        spendGuardUsedUsd: spend?.usedUsd ?? null,
        spendGuardReservedUsd: spend?.reservedUsd ?? null,
      },
    };
    report.assessment.adoptionQualification =
      (options.mode ?? "live") === "offline-fixture"
        ? "not_applicable"
        : costUsd === null
          ? "unknown_cost"
          : "cost_known_not_qualified";
    report.outboundHeaderReceipts = deps.outboundHeaderReceipts?.() ?? [];
    deps.onProgress?.(structuredClone(report));
  };

  const tracked: AgentRuntime = {
    describe: () => runtime.describe(),
    abort: (runId) => runtime.abort(runId),
    async *run(request, context) {
      const phase = currentPhase();
      if (request.tools.length === 0) promptHashes.set(phase, sha256(request.prompt));
      const downstream = request.model.callObserver;
      const observer: ModelCallObserver = {
        async beforeCall(call) {
          const reject = (reason: string): never => {
            exhaustedReason ??= reason;
            report.usage.blockedAttempts.push({ phase, reason });
            publish();
            throw new Error("learning_stream_budget_exhausted");
          };
          if (exhaustedReason) reject(exhaustedReason);
          if (call.provider !== model.provider || call.modelId !== model.id)
            reject("pinned_model_changed");
          const receiptId = `call-${String(++globalCalls).padStart(4, "0")}`;
          const phaseTotals = perPhase.get(phase) ?? { modelCalls: 0, reservedTokens: 0 };
          phaseTotals.modelCalls += 1;
          perPhase.set(phase, phaseTotals);

          const reservedTokens = call.inputTokensEstimate + call.maxOutputTokens;
          if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0)
            reject("invalid_model_token_reservation");
          globalReservedTokens += reservedTokens;
          phaseTotals.reservedTokens += reservedTokens;

          let spendId: string | null = null;
          try {
            if (spend)
              spendId = spend.reserve(
                call.inputTokensEstimate,
                call.maxOutputTokens,
                call.cacheWriteRetention,
              );
            const downstreamId = await downstream?.beforeCall(call);
            const id = randomUUID();
            reservations.set(id, {
              receiptId,
              reservedTokens,
              spendId,
              downstreamId: downstreamId ?? null,
              downstream,
              phase,
              call,
            });
            publish();
            return id;
          } catch (error) {
            if (spendId) spend?.settle(spendId, null);
            if (error instanceof Error && /spend cap/i.test(error.message)) {
              exhaustedReason = "spend_cap_reached";
              report.usage.blockedAttempts.push({ phase, reason: exhaustedReason });
              publish();
            }
            throw error;
          }
        },
        async afterCall(id, usage) {
          const reservation = reservations.get(id);
          if (!reservation) throw new Error("learning_stream_unknown_model_reservation");
          reservations.delete(id);
          if (reservation.spendId) spend?.settleUsage(reservation.spendId, usage);
          const callUsage = usage ?? ({} as AgentUsage);
          const providerCost =
            callUsage.costSource === "provider-reported" ? (callUsage.costUsd ?? null) : null;
          const measured = measureCalls(
            [
              {
                id: reservation.receiptId,
                inputTokens: callUsage.inputTokens ?? null,
                outputTokens: callUsage.outputTokens ?? null,
                cacheReadTokens: callUsage.cacheReadTokens ?? null,
                cacheWriteTokens: callUsage.cacheWriteTokens ?? null,
                cacheWrite1hTokens:
                  callUsage.cacheWrite1hTokens ?? (callUsage.cacheWriteTokens === 0 ? 0 : null),
                reasoningTokens: callUsage.reasoningTokens ?? null,
                totalTokens: callUsage.totalTokens ?? null,
                costUsd: providerCost,
                costSource: providerCost === null ? null : "provider-reported",
                provider: reservation.call.provider,
                modelId: reservation.call.modelId,
              },
            ],
            deps.pricing,
            undefined,
            { provider: model.provider, modelId: model.id },
          );
          const callReceipt: LearningStreamCallReceipt = {
            id: reservation.receiptId,
            phase: reservation.phase,
            provider: reservation.call.provider,
            model: reservation.call.modelId,
            providerRequestIdSha256: callUsage.providerRequestId
              ? sha256(callUsage.providerRequestId)
              : null,
            inputTokens: callUsage.inputTokens ?? null,
            outputTokens: callUsage.outputTokens ?? null,
            cacheReadTokens: callUsage.cacheReadTokens ?? null,
            cacheWriteTokens: callUsage.cacheWriteTokens ?? null,
            cacheWrite1hTokens: callUsage.cacheWrite1hTokens ?? null,
            reasoningTokens: callUsage.reasoningTokens ?? null,
            totalTokens: callUsage.totalTokens ?? null,
            costUsd: measured.costUsd,
            costSource: measured.costSources[0] ?? null,
            usageSource: callUsage.usageSource ?? null,
            reservedTokens: reservation.reservedTokens,
            status: usage ? "settled" : "missing_usage",
          };
          report.usage.calls.push(callReceipt);
          if (reservation.call.callId) callsById.set(reservation.call.callId, callReceipt);
          await reservation.downstream?.afterCall(reservation.downstreamId!, usage);
          publish();
        },
        async onRequestId(id, providerRequestId) {
          const reservation = reservations.get(id);
          if (!reservation) return;
          await reservation.downstream?.onRequestId?.(reservation.downstreamId!, providerRequestId);
        },
      };
      const events = runtime.run(
        {
          ...request,
          model: {
            ...request.model,
            headers: request.model.headers ? { ...request.model.headers } : undefined,
            callObserver: observer,
          },
        },
        context,
      );
      yield* events;
    },
  };

  return {
    runtime: tracked,
    callsById,
    promptHash: (phase: string) => promptHashes.get(phase) ?? null,
    get exhaustedReason() {
      return exhaustedReason;
    },
    publish,
  };
}

function comparisonWorkInput(
  taskCases: WorkImprovementCase[],
  model: AgentRunModel,
  route: string,
  baseline: WorkImprovementInput["baseline"],
  candidate: WorkImprovementInput["candidate"],
  comparisonId: string,
) {
  return workInput(model, route, taskCases, baseline, candidate, comparisonId);
}

function historyIds(history: WorkImprovementHistorySummary[]) {
  return {
    comparisonIds: history.map((summary) => summary.comparisonId),
    taskIds: history.flatMap((summary) => summary.diagnostics.map((entry) => entry.caseId)),
  };
}

function proposalStatus(
  result: ReturnType<typeof parseTicketImprovementProposal>,
  error: string | null,
) {
  const candidate = proposalCandidate(result);
  return {
    candidate,
    receipt: {
      status: error ? ("unknown" as const) : candidate ? ("candidate" as const) : ("skip" as const),
      revision: candidate?.revision ?? null,
    },
  };
}

async function generateProposal(
  task: StreamTask,
  baseline: WorkImprovementInput["baseline"],
  history: WorkImprovementHistorySummary[],
  model: AgentRunModel,
  runtime: AgentRuntime,
  signal: AbortSignal | undefined,
): Promise<{
  result: ReturnType<typeof parseTicketImprovementProposal>;
  error: string | null;
  prompt: string;
}> {
  const requestContent = {
    task: task.case.input.task,
    receipt: feedbackReceipt(task),
    feedback: { messageId: `feedback:${task.id}`, text: task.feedback },
    baseline,
    summaries: history,
  };
  const prompt = ticketImprovementProposalRequest(CURRENT_IMPROVER.strategy, requestContent);
  const secrets = modelSecrets(model);
  const runId = randomUUID();
  let output = "";
  let finished = false;
  const usage = new Set<string>();
  let error: string | null = null;
  try {
    signal?.throwIfAborted();
    for await (const event of runtime.run(
      {
        botId: "learning-stream",
        threadId: "synthetic-learning-stream",
        runId,
        usageOperationKind: "learning",
        instructions: prompt.instructions,
        prompt: prompt.prompt,
        history: [],
        tools: [],
        allowSilentEmpty: true,
        secrets,
        model: { ...model, callObserver: undefined },
      },
      { signal, runId },
    )) {
      switch (event.type) {
        case "turn":
          output = "";
          break;
        case "text":
          output += event.text;
          break;
        case "usage":
          usage.add(event.callId ?? event.providerRequestId ?? "usage-without-id");
          break;
        case "done":
          if (!output) output = event.text ?? "";
          finished = true;
          break;
        case "tool":
        case "ask":
        case "takeover":
        case "subagent":
          error = "unsupported_proposal_action";
          break;
      }
      if (finished) break;
    }
  } catch {
    error = signal?.aborted ? "proposal_interrupted" : "proposal_runtime_error";
  }
  if (!finished) error ??= "unfinished_proposal";
  if (!usage.size) error ??= "missing_proposal_usage";
  const redacted = secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), output);
  const parsed = error ? null : parseTicketImprovementProposal(redacted, task.feedback);
  if (!parsed) error ??= "invalid_proposal_or_quote";
  return { result: parsed, error, prompt: prompt.prompt };
}

function selectByTrainingScore(comparison: WorkImprovementComparison): boolean {
  const { baseline, candidate } = comparison.summary;
  if (candidate.unknown > 0) return false;
  if (candidate.passed !== baseline.passed) return candidate.passed > baseline.passed;
  if (candidate.failed !== baseline.failed) return candidate.failed < baseline.failed;
  return false;
}

function phaseReceipt(
  report: LearningStreamReport,
  name: string,
  taskIds: string[],
  body: () => Promise<Record<string, unknown> | undefined>,
  publish: () => void,
  setCurrentPhase: (phase: string) => void,
  stoppedReason: () => string | null,
) {
  const phase = {
    name,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    taskIds,
    reason: null as string | null,
  };
  report.phases.push(phase);
  setCurrentPhase(name);
  publish();
  return body()
    .then((details) => {
      const reason = stoppedReason();
      const status = reason ? "unknown" : "completed";
      Object.assign(phase, {
        status,
        completedAt: new Date().toISOString(),
        reason,
        ...(details ? { details } : {}),
      });
      return details;
    })
    .catch(() => {
      const reason = stoppedReason();
      Object.assign(phase, {
        status: reason ? "unknown" : "failed",
        completedAt: new Date().toISOString(),
        reason: reason ?? "phase_failed",
      });
      return undefined;
    })
    .finally(() => {
      setCurrentPhase(name);
      publish();
    });
}

export async function runLearningStream(
  options: LearningStreamOptions,
  deps: LearningStreamDeps,
): Promise<LearningStreamReport> {
  const taskCases = buildStream(
    options.seed,
    options.trainCount,
    options.selectionCount,
    options.holdoutCount,
  );
  if (options.trainCount < 3)
    throw new Error("The learning run requires at least three training tasks.");
  if (options.spendCapUsd !== undefined && !deps.pricing)
    throw new Error("A monetary spend cap requires explicit pricing.");

  const startedAt = new Date().toISOString();
  const manifest = createLearningStreamManifest({
    seed: options.seed,
    trainCount: options.trainCount,
    selectionCount: options.selectionCount,
    holdoutCount: options.holdoutCount,
    generatedAt: startedAt,
  });
  const runtimeDescriptor = deps.runtime.describe();
  const model = {
    ...options.model,
    headers: options.model.headers ? { ...options.model.headers } : undefined,
  };
  delete model.callObserver;
  const selection = taskCases.filter((task) => task.split === "selection");
  const holdout = taskCases.filter((task) => task.split === "holdout");
  const excludedSelectionAndHoldoutTaskIds = [...selection, ...holdout].map((task) => task.id);
  let activePhase = "bootstrap_proposal";
  const report: LearningStreamReport = {
    schemaVersion: "learning-stream.report.v1",
    status: "running",
    startedAt,
    completedAt: null,
    fixtureVersion: LEARNING_STREAM_FIXTURE_VERSION,
    manifest,
    codeRevision: options.codeRevision,
    workingDiffHash: options.workingDiffHash,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      reversibleEnvironment: "fresh-read-only-synthetic-snapshot",
      runtime: runtimeDescriptor,
    },
    execution: {
      mode: options.mode ?? "live",
      requestedServiceTier: options.serviceTier ?? null,
      model: {
        provider: model.provider,
        id: model.id,
        thinkingLevel: model.thinkingLevel ?? null,
        maxTokens: model.maxTokens ?? null,
        contextWindow: model.contextWindow ?? null,
      },
      route: options.route,
      spendCapUsd: options.spendCapUsd ?? null,
      pricing: deps.pricing ?? null,
    },
    revisionRefs: {
      baseline: BASELINE.revision,
      improver: CURRENT_IMPROVER.revision,
      scorer: null,
      proposals: [],
      compositions: [],
    },
    promptAudit: [],
    phases: [],
    histories: {
      frozen: { comparisonIds: [], taskIds: [] },
      accumulating: { comparisonIds: [], taskIds: [] },
    },
    bootstrap: null,
    training: [],
    selection: [],
    holdout: null,
    usage: {
      calls: [],
      blockedAttempts: [],
      byPhase: {},
      totals: {
        modelCalls: 0,
        reservedTokens: 0,
        knownTokens: 0,
        unknownUsageCalls: 0,
        costUsd: null,
        costStatus: "unknown",
        spendGuardUsedUsd: null,
        spendGuardReservedUsd: null,
      },
    },
    outboundHeaderReceipts: [],
    assessment: {
      statisticalSignificanceClaimed: false,
      adoptionQualification: options.mode === "offline-fixture" ? "not_applicable" : "unknown_cost",
      note:
        options.mode === "offline-fixture"
          ? "Offline fixture responses verify execution, scoring, split isolation, and accounting only; they are not evidence of model learning or generalization."
          : "Descriptive results from a small synthetic stream; no statistical significance or generalization claim is made. Score-based selection is diagnostic, not qualified adoption; cost remains unknown unless every model call has a measured charge.",
    },
    termination: {
      status: "running",
      reason: null,
      startedAt,
      finishedAt: null,
      modelCalls: 0,
      reservedTokens: 0,
      blockedAttempts: 0,
    },
  };
  const tracker = createTrackedRuntime(
    deps.runtime,
    model,
    report,
    options,
    deps,
    () => activePhase,
  );
  const receiptPricing = { pricing: deps.pricing, model, callsById: tracker.callsById };
  const publish = () => {
    report.outboundHeaderReceipts = deps.outboundHeaderReceipts?.() ?? [];
    deps.onProgress?.(structuredClone(report));
  };
  const context = { signal: deps.context?.signal };
  const runPhase = (
    name: LearningStreamPhase,
    taskIds: string[],
    body: () => Promise<Record<string, unknown> | undefined>,
  ) =>
    phaseReceipt(
      report,
      name,
      taskIds,
      async () => {
        context.signal?.throwIfAborted();
        const result = await body();
        context.signal?.throwIfAborted();
        return result;
      },
      () => {
        tracker.publish();
        publish();
      },
      (phase) => {
        activePhase = phase;
      },
      () =>
        tracker.exhaustedReason ??
        (context.signal?.aborted
          ? context.signal.reason instanceof Error &&
            context.signal.reason.message.includes("wall-time limit")
            ? "wall_time_limit_reached"
            : "interrupted_by_signal"
          : null),
    );
  const train = taskCases.filter((task) => task.split === "train");
  const bootstrapTask = train[0]!;
  const baseline = BASELINE;
  let retained = BASELINE;
  let bootstrapHistory: WorkImprovementHistorySummary | undefined;
  const accumulatingHistory: WorkImprovementHistorySummary[] = [];
  let frozenCandidate = BASELINE;
  let accumulatingCandidate = BASELINE;
  let frozenSelected = BASELINE;
  let accumulatingSelected = BASELINE;

  try {
    let bootstrapProposedCandidate: WorkImprovementInput["candidate"] = baseline;
    const bootstrapProposalPhase = await runPhase(
      "bootstrap_proposal",
      [bootstrapTask.id],
      async () => {
        const generated = await generateProposal(
          bootstrapTask,
          baseline,
          [],
          model,
          tracker.runtime,
          context.signal,
        );
        const resolved = proposalStatus(generated.result, generated.error);
        const candidate = resolved.candidate ?? baseline;
        bootstrapProposedCandidate = candidate;
        report.promptAudit.push({
          phase: "proposal",
          condition: "shared-bootstrap",
          taskIds: [bootstrapTask.id],
          historyTaskIds: [],
          historyComparisonIds: [],
          promptSha256: sha256(generated.prompt),
          excludedSelectionAndHoldoutTaskIds,
        });
        report.bootstrap = {
          taskId: bootstrapTask.id,
          proposal: resolved.receipt,
          composition: null,
        };
        if (resolved.candidate)
          report.revisionRefs.proposals.push({
            condition: "shared-bootstrap",
            revision: resolved.candidate.revision,
            taskId: bootstrapTask.id,
          });
        return {
          candidateRevision: candidate.revision,
          proposalStatus: resolved.receipt.status,
          error: generated.error,
        };
      },
    );
    if (!bootstrapProposalPhase) throw new Error("bootstrap_proposal_failed");
    const bootstrapCompositionPhase = await runPhase(
      "bootstrap_compose",
      [bootstrapTask.id],
      async () => {
        const input = comparisonWorkInput(
          [bootstrapTask.case],
          model,
          options.route,
          baseline,
          bootstrapProposedCandidate,
          "learning-stream-bootstrap",
        );
        const composition = await compareAndComposeWorkImprovement(input, {
          runtime: tracker.runtime,
          context,
        });
        report.promptAudit.push({
          phase: "composition",
          condition: "shared-bootstrap",
          taskIds: [bootstrapTask.id],
          historyTaskIds: [],
          historyComparisonIds: [],
          promptSha256:
            tracker.promptHash("bootstrap_compose") ?? sha256(canonical(input.candidate)),
          excludedSelectionAndHoldoutTaskIds,
        });
        const composedCandidate = composition.composition.candidate;
        retained = composedCandidate ?? baseline;
        const evidence = composition.composed ?? composition.initial;
        report.revisionRefs.scorer = composition.initial.scorerVersion;
        report.bootstrap!.composition = {
          status: composition.composition.status,
          candidateRevision: composedCandidate?.revision ?? null,
          initial: comparisonReceipt(composition.initial, receiptPricing),
          composed: composition.composed
            ? comparisonReceipt(composition.composed, receiptPricing)
            : null,
        };
        report.revisionRefs.compositions.push({
          condition: "shared-bootstrap",
          revision: composedCandidate?.revision ?? baseline.revision,
          taskId: bootstrapTask.id,
        });
        bootstrapHistory = summarizeWorkImprovementHistory(evidence);
        accumulatingHistory.push(bootstrapHistory);
        frozenCandidate = retained;
        accumulatingCandidate = retained;
        report.histories.frozen = historyIds([bootstrapHistory]);
        report.histories.accumulating = historyIds(accumulatingHistory);
        return {
          candidateRevision: composedCandidate?.revision ?? null,
          comparison: comparisonReceipt(evidence, receiptPricing),
        };
      },
    );
    if (!bootstrapCompositionPhase) throw new Error("bootstrap_composition_failed");
    if (tracker.exhaustedReason) throw new Error("learning_stream_budget_exhausted");

    const historyTask = train[1]!;
    const historyPhase = await runPhase("history_update", [historyTask.id], async () => {
      const comparison = await compareWorkImprovement(
        comparisonWorkInput(
          [historyTask.case],
          model,
          options.route,
          baseline,
          retained,
          "learning-stream-history-update",
        ),
        { runtime: tracker.runtime, context },
      );
      const summary = summarizeWorkImprovementHistory(comparison);
      accumulatingHistory.push(summary);
      report.histories.accumulating = historyIds(accumulatingHistory);
      return { comparison: comparisonReceipt(comparison, receiptPricing) };
    });
    if (!historyPhase) throw new Error("history_update_failed");
    if (tracker.exhaustedReason) throw new Error("learning_stream_budget_exhausted");

    const proposalTask = train[2]!;
    for (const condition of ["frozen", "accumulating"] as const) {
      const history = condition === "frozen" ? [bootstrapHistory!] : accumulatingHistory;
      const proposalPhase = condition === "frozen" ? "frozen_proposal" : "accumulating_proposal";
      const composePhase = condition === "frozen" ? "frozen_compose" : "accumulating_compose";
      const prior = condition === "frozen" ? frozenCandidate : accumulatingCandidate;
      const promptAuditStart = report.promptAudit.length;
      let generatedCandidate: WorkImprovementInput["candidate"] | null = null;
      const proposalRun = await runPhase(proposalPhase, [proposalTask.id], async () => {
        const generated = await generateProposal(
          proposalTask,
          prior,
          history,
          model,
          tracker.runtime,
          context.signal,
        );
        const resolved = proposalStatus(generated.result, generated.error);
        generatedCandidate = resolved.candidate;
        const ids = historyIds(history);
        report.promptAudit.push({
          phase: "proposal",
          condition,
          taskIds: [proposalTask.id],
          historyTaskIds: ids.taskIds,
          historyComparisonIds: ids.comparisonIds,
          promptSha256: sha256(generated.prompt),
          excludedSelectionAndHoldoutTaskIds,
        });
        if (resolved.candidate)
          report.revisionRefs.proposals.push({
            condition,
            revision: resolved.candidate.revision,
            taskId: proposalTask.id,
          });
        return {
          proposalStatus: resolved.receipt.status,
          candidateRevision: resolved.candidate?.revision ?? null,
          error: generated.error,
        };
      });
      let composition: WorkImprovementComposition | null = null;
      const compositionPhase = proposalRun
        ? await runPhase(composePhase, [proposalTask.id], async () => {
            const input = comparisonWorkInput(
              [proposalTask.case],
              model,
              options.route,
              prior,
              generatedCandidate ?? prior,
              `learning-stream-${condition}-compose`,
            );
            composition = await compareAndComposeWorkImprovement(input, {
              runtime: tracker.runtime,
              context,
            });
            const evidence = composition.composed ?? composition.initial;
            const composedCandidate = composition.composition.candidate;
            if (condition === "frozen") frozenCandidate = composedCandidate ?? prior;
            else accumulatingCandidate = composedCandidate ?? prior;
            report.training.push({
              condition,
              taskId: proposalTask.id,
              historyComparisonIds: historyIds(history).comparisonIds,
              proposal: {
                status:
                  report.phases.find((phase) => phase.name === proposalPhase)?.details
                    ?.proposalStatus === "candidate"
                    ? "candidate"
                    : report.phases.find((phase) => phase.name === proposalPhase)?.details
                          ?.proposalStatus === "skip"
                      ? "skip"
                      : "unknown",
                revision: generatedCandidate?.revision ?? null,
              },
              composition: {
                status: composition.composition.status,
                candidateRevision: composedCandidate?.revision ?? null,
                initial: comparisonReceipt(composition.initial, receiptPricing),
                composed: composition.composed
                  ? comparisonReceipt(composition.composed, receiptPricing)
                  : null,
              },
            });
            report.revisionRefs.compositions.push({
              condition,
              revision: composedCandidate?.revision ?? prior.revision,
              taskId: proposalTask.id,
            });
            if (report.promptAudit.length > promptAuditStart)
              report.promptAudit.push({
                phase: "composition",
                condition,
                taskIds: [proposalTask.id],
                historyTaskIds: [],
                historyComparisonIds: [],
                promptSha256:
                  tracker.promptHash(composePhase) ??
                  sha256(
                    canonical({
                      baseline: input.baseline,
                      candidate: input.candidate,
                      diagnosticCases: input.cases.map((entry) => entry.id),
                    }),
                  ),
                excludedSelectionAndHoldoutTaskIds,
              });
            return {
              candidateRevision: composedCandidate?.revision ?? null,
              comparison: comparisonReceipt(evidence, receiptPricing),
            };
          })
        : undefined;
      if (!proposalRun || !compositionPhase || tracker.exhaustedReason)
        throw new Error("candidate_training_failed");
      if (!composition) throw new Error("candidate_composition_missing");
    }

    for (const condition of ["frozen", "accumulating"] as const) {
      const candidate = condition === "frozen" ? frozenCandidate : accumulatingCandidate;
      const selectionComparison = await runPhase(
        "selection",
        selection.map((task) => task.id),
        async () => {
          const comparison = await compareWorkImprovement(
            comparisonWorkInput(
              selection.map((task) => task.case),
              model,
              options.route,
              retained,
              candidate,
              `learning-stream-${condition}-selection`,
            ),
            { runtime: tracker.runtime, context },
          );
          const selectedCandidate = selectByTrainingScore(comparison);
          const receipt = comparisonReceipt(comparison, receiptPricing);
          if (condition === "frozen") frozenSelected = selectedCandidate ? candidate : retained;
          else accumulatingSelected = selectedCandidate ? candidate : retained;
          report.selection.push({
            condition,
            candidateRevision: candidate.revision,
            selected: selectedCandidate,
            metrics: receipt.summary,
            runs: comparison.cases.flatMap((entry) => [
              ...receiptRuns(entry.id, entry.baseline, receiptPricing),
              ...receiptRuns(entry.id, entry.candidate, receiptPricing),
            ]),
          });
          return {
            candidateRevision: candidate.revision,
            selected: selectedCandidate,
            metrics: receipt.summary,
            comparisonId: comparison.comparisonId,
          };
        },
      );
      if (!selectionComparison || tracker.exhaustedReason) throw new Error("selection_failed");
    }

    const holdoutArms = [
      { key: "baseline", revision: baseline },
      { key: "frozen", revision: frozenSelected },
      { key: "accumulating", revision: accumulatingSelected },
    ] as const;
    const holdoutResults: Record<string, LearningStreamRunReceipt[]> = {};
    for (const arm of holdoutArms) {
      const results = await runPhase(
        "holdout",
        holdout.map((task) => task.id),
        async () => {
          const evaluated = await evaluateWorkImprovementRevision(
            comparisonWorkInput(
              holdout.map((task) => task.case),
              model,
              options.route,
              baseline,
              arm.revision,
              `learning-stream-holdout-${arm.key}`,
            ),
            arm.revision,
            tracker.runtime
              ? { runtime: tracker.runtime, context }
              : { runtime: deps.runtime, context },
          );
          const runs = evaluated.flatMap(({ fixture: taskCase, run }) =>
            receiptRuns(taskCase.id, run, receiptPricing),
          );
          holdoutResults[arm.key] = runs;
          return {
            revision: arm.revision.revision,
            metrics: runMetrics(runs),
            runs,
          };
        },
      );
      if (!results || tracker.exhaustedReason) throw new Error("holdout_failed");
    }

    const retries: LearningStreamRunReceipt[] = [];
    for (const task of holdout) {
      const retryResult = await runPhase("equal_budget_retry", [task.id], async () => {
        const firstInput = comparisonWorkInput(
          [task.case],
          model,
          options.route,
          baseline,
          baseline,
          `learning-stream-retry-first-${task.id}`,
        );
        const first = await evaluateWorkImprovementRevision(firstInput, baseline, {
          runtime: tracker.runtime,
          context,
        });
        const firstRun = first[0]!.run;
        const previousAttempt = {
          output: firstRun.output,
          tools: firstRun.tools.map((tool) => ({
            name: tool.name,
            args: tool.args,
            status: tool.status,
            error: tool.error?.code ?? null,
          })),
          errors: firstRun.errors.map((error) => error.code),
        };
        const retryCase: WorkImprovementCase = {
          ...task.case,
          input: {
            ...task.case.input,
            task: `${task.case.input.task}\nPrevious attempt receipt (untrusted; verify afresh): ${JSON.stringify(previousAttempt)}`,
          },
        };
        const retryInput = comparisonWorkInput(
          [retryCase],
          model,
          options.route,
          baseline,
          baseline,
          `learning-stream-retry-second-${task.id}`,
        );
        const second = await evaluateWorkImprovementRevision(retryInput, baseline, {
          runtime: tracker.runtime,
          context,
        });
        const firstReceipt = receiptRun(task.id, firstRun, 1, receiptPricing);
        const secondReceipt = receiptRun(task.id, second[0]!.run, 2, receiptPricing);
        retries.push(firstReceipt, secondReceipt);
        return { attempts: [firstReceipt, secondReceipt] };
      });
      if (!retryResult || tracker.exhaustedReason) throw new Error("equal_budget_retry_failed");
    }

    report.holdout = {
      baseline: {
        revision: baseline.revision,
        metrics: runMetrics(holdoutResults.baseline ?? []),
        runs: holdoutResults.baseline ?? [],
      },
      frozen: {
        revision: frozenSelected.revision,
        metrics: runMetrics(holdoutResults.frozen ?? []),
        runs: holdoutResults.frozen ?? [],
      },
      accumulating: {
        revision: accumulatingSelected.revision,
        metrics: runMetrics(holdoutResults.accumulating ?? []),
        runs: holdoutResults.accumulating ?? [],
      },
      equalBudgetRetry: {
        revision: BASELINE.revision,
        metrics: {
          final: runMetrics(retries.filter((run) => run.attempt === 2)),
          attempts: runMetrics(retries),
        },
        runs: retries,
      },
    };
    report.status = "completed";
    report.termination.status = "completed";
  } catch {
    report.status = tracker.exhaustedReason || context.signal?.aborted ? "incomplete" : "failed";
    const timedOut =
      context.signal?.reason instanceof Error &&
      context.signal.reason.message.includes("wall-time limit");
    report.termination.status = tracker.exhaustedReason
      ? "budget_exhausted"
      : context.signal?.aborted
        ? timedOut
          ? "timed_out"
          : "interrupted"
        : "failed";
    report.termination.reason =
      tracker.exhaustedReason ??
      (timedOut
        ? "wall_time_limit_reached"
        : context.signal?.aborted
          ? "interrupted_by_signal"
          : "evaluation_incomplete");
  } finally {
    report.completedAt = new Date().toISOString();
    report.termination.finishedAt = report.completedAt;
    report.termination.modelCalls = report.usage.totals.modelCalls;
    report.termination.reservedTokens = report.usage.totals.reservedTokens;
    report.termination.blockedAttempts = report.usage.blockedAttempts.length;
    report.outboundHeaderReceipts = deps.outboundHeaderReceipts?.() ?? [];
    if (report.status === "completed") report.termination.reason = null;
    tracker.publish();
    publish();
  }
  return report;
}
