import { createHash } from "node:crypto";
import type { WorkImprovementCase, WorkImprovementOutput } from "../work-improvement.js";

export const FILE_DELIVERY_OUTPUT_CONTRACT = {
  checkIds: ["installation", "directory", "upload"],
  observationIds: [
    "missing_files",
    "unexpected_files",
    "hash_mismatches",
    "excluded_runtime_files",
  ],
};

const commonPlaybook = {
  whenToUse: "Accept a retained package delivery for the project named in request.json.",
  inputs: ["request.json", "manifest.json", "installed-files.json", "selection/upload receipts"],
  whatToReturn: "Structured installation, directory and upload checks with file difference sets.",
  approvalBoundaries: "Only read the isolated snapshot. Never install, upload or run commands.",
  failureHandling: "Missing evidence is unknown. A different project is out_of_scope.",
};

export const FILE_DELIVERY_PLAYBOOKS = {
  baseline: {
    revision: "manifest-hashes.v1",
    playbook: {
      ...commonPlaybook,
      steps: [
        "Read request.json and manifest.json; stop with out_of_scope if their projects differ.",
        "Discover receipt files and read the installed file inventory. List the installed tree when a complete snapshot exists.",
        "Compare hashes only for manifest members. If members match, report the directory as passing.",
        "Treat either selection or upload of the package as a passing upload check.",
      ],
      howToCheck:
        "Missing members and wrong member hashes fail; explicit runtime files are exclusions.",
    },
  },
  candidate: {
    revision: "directory-and-receipts.v2",
    playbook: {
      ...commonPlaybook,
      steps: [
        "Read request.json and manifest.json; stop with out_of_scope if their projects differ.",
        "Discover and read the installed-files inventory and selection/upload receipts.",
        "For a complete retained inventory, enumerate installed/ and compare the entire path set to the manifest. Report missing paths, unexpected paths and hash mismatches separately.",
        "Exclude only the exact runtime paths allowed by request.json. Do not exclude arbitrary cache files.",
        "A manifest-only inventory cannot establish a clean full directory. Report that check as unknown.",
        "Upload passes only with a completion receipt bound to this package. Selection alone leaves upload unknown.",
      ],
      howToCheck:
        "Report actual directory differences, exact runtime exclusions and separately evidenced upload.",
    },
  },
};

function output(
  outcome: WorkImprovementOutput["outcome"],
  checks: WorkImprovementOutput["checks"],
  observations: Partial<WorkImprovementOutput["observations"]> = {},
): WorkImprovementOutput {
  return {
    schemaVersion: "work-improvement.output.v1",
    outcome,
    checks,
    observations: {
      missing_files: [],
      unexpected_files: [],
      hash_mismatches: [],
      excluded_runtime_files: [],
      ...observations,
    },
  };
}

const passed = { installation: "pass", directory: "pass", upload: "pass" } as const;
const scopeChecks = {
  installation: "not_applicable",
  directory: "not_applicable",
  upload: "not_applicable",
} as const;

/** These are transcript fixtures, not a model or a claim that a strategy learned anything. */
export const FILE_DELIVERY_SCRIPTED_REPLIES: Record<
  "baseline" | "candidate",
  Record<string, WorkImprovementOutput>
> = {
  baseline: {
    clean: output("complete", passed),
    stale: output("complete", passed),
    missing: output(
      "failed",
      { installation: "fail", directory: "fail", upload: "pass" },
      { missing_files: ["data/settings.json"] },
    ),
    mismatch: output(
      "failed",
      { installation: "fail", directory: "pass", upload: "pass" },
      { hash_mismatches: ["app/main.txt"] },
    ),
    runtime: output("complete", passed, { excluded_runtime_files: ["cache/session.log"] }),
    selected: output("complete", passed),
    partial: output("complete", passed),
    exception: output("out_of_scope", scopeChecks),
    unapproved: output("complete", passed),
  },
  candidate: {
    clean: output("complete", passed),
    stale: output(
      "failed",
      { installation: "pass", directory: "fail", upload: "pass" },
      { unexpected_files: ["legacy/old.txt"] },
    ),
    missing: output(
      "failed",
      { installation: "fail", directory: "fail", upload: "pass" },
      { missing_files: ["data/settings.json"] },
    ),
    mismatch: output(
      "failed",
      { installation: "fail", directory: "pass", upload: "pass" },
      { hash_mismatches: ["app/main.txt"] },
    ),
    runtime: output("complete", passed, { excluded_runtime_files: ["cache/session.log"] }),
    selected: output("unknown", { installation: "pass", directory: "pass", upload: "unknown" }),
    partial: output("unknown", { installation: "pass", directory: "unknown", upload: "pass" }),
    exception: output("out_of_scope", scopeChecks),
    unapproved: output(
      "failed",
      { installation: "pass", directory: "fail", upload: "pass" },
      { unexpected_files: ["cache/legacy.log"] },
    ),
  },
};

/** Independent synthetic snapshots; no historical user files or receipts. */
export function fileDeliveryFixtures(): WorkImprovementCase[] {
  const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");
  const packageFiles = {
    "app/main.txt": "Synthetic application version two.\n",
    "data/settings.json": '{"mode":"demo"}\n',
  };
  const manifestFiles = Object.entries(packageFiles).map(([path, contents]) => ({
    path,
    sha256: digest(contents),
  }));
  const variants = [
    { id: "clean", split: "diagnostic", category: "success", protection: true },
    { id: "stale", split: "diagnostic", category: "failure", protection: false },
    { id: "missing", split: "holdout", category: "failure", protection: false },
    { id: "mismatch", split: "holdout", category: "failure", protection: false },
    { id: "runtime", split: "holdout", category: "success", protection: true },
    { id: "selected", split: "holdout", category: "insufficient_evidence", protection: true },
    { id: "partial", split: "holdout", category: "insufficient_evidence", protection: true },
    { id: "exception", split: "holdout", category: "scope_exception", protection: true },
    { id: "unapproved", split: "holdout", category: "failure", protection: false },
  ] as const;

  return variants.map((variant, index) => {
    const packageId = `bundle-${String(index + 1).padStart(2, "0")}`;
    const project = variant.id === "exception" ? "project-beta" : "project-alpha";
    const installed: Record<string, string> = { ...packageFiles };
    if (variant.id === "stale") installed["legacy/old.txt"] = "Old synthetic package member.\n";
    if (variant.id === "missing") delete installed["data/settings.json"];
    if (variant.id === "mismatch") installed["app/main.txt"] = "Synthetic version one.\n";
    if (variant.id === "runtime")
      installed["cache/session.log"] = "Runtime-generated synthetic log.\n";
    if (variant.id === "unapproved") installed["cache/legacy.log"] = "An old non-excluded log.\n";
    const materials: Record<string, string> = {
      "request.json": JSON.stringify({
        project: "project-alpha",
        packageId,
        runtimeExclusions: ["cache/session.log"],
      }),
      "manifest.json": JSON.stringify({
        project,
        packageId,
        files: manifestFiles,
      }),
      "installed-files.json": JSON.stringify({
        root: "installed",
        coverage: variant.id === "partial" ? "manifest_only" : "complete",
        capturedAt: "2026-01-02T03:04:05.000Z",
        files: Object.entries(installed).map(([path, contents]) => ({
          path,
          sha256: digest(contents),
        })),
      }),
      "selection-receipt.json": JSON.stringify({
        phase: "selected",
        packageId,
        file: `${packageId}.zip`,
      }),
    };
    if (variant.id !== "selected")
      materials["upload-receipt.json"] = JSON.stringify({
        phase: "completed",
        packageId,
        receiptId: `synthetic-upload-${String(index + 1).padStart(2, "0")}`,
      });
    // A manifest-only historical record does not invent an absent full tree copy.
    if (variant.id !== "partial")
      for (const [path, contents] of Object.entries(installed))
        materials[`installed/${path}`] = contents;

    let expected = output("complete", passed);
    if (variant.id === "stale")
      expected = output(
        "failed",
        { installation: "pass", directory: "fail", upload: "pass" },
        { unexpected_files: ["legacy/old.txt"] },
      );
    if (variant.id === "missing")
      expected = output(
        "failed",
        { installation: "fail", directory: "fail", upload: "pass" },
        { missing_files: ["data/settings.json"] },
      );
    if (variant.id === "mismatch")
      expected = output(
        "failed",
        { installation: "fail", directory: "pass", upload: "pass" },
        { hash_mismatches: ["app/main.txt"] },
      );
    if (variant.id === "runtime")
      expected = output("complete", passed, { excluded_runtime_files: ["cache/session.log"] });
    if (variant.id === "selected")
      expected = output("unknown", { installation: "pass", directory: "pass", upload: "unknown" });
    if (variant.id === "partial")
      expected = output("unknown", { installation: "pass", directory: "unknown", upload: "pass" });
    if (variant.id === "exception") expected = output("out_of_scope", scopeChecks);
    if (variant.id === "unapproved")
      expected = output(
        "failed",
        { installation: "pass", directory: "fail", upload: "pass" },
        { unexpected_files: ["cache/legacy.log"] },
      );

    const requiredSteps: WorkImprovementCase["requiredSteps"] = [
      { tool: "list_files", path: "" },
      { tool: "read_file", path: "request.json" },
      { tool: "read_file", path: "manifest.json" },
    ];
    if (variant.id !== "exception") {
      requiredSteps.push(
        { tool: "read_file", path: "installed-files.json" },
        { tool: "read_file", path: "selection-receipt.json" },
      );
      if (variant.id !== "selected")
        requiredSteps.push({ tool: "read_file", path: "upload-receipt.json" });
      if (variant.id !== "partial") requiredSteps.push({ tool: "list_files", path: "installed" });
    }
    return {
      ...variant,
      project,
      family: "file-delivery",
      input: {
        task:
          "Verify retained delivery " +
          packageId +
          " for request.json. Compare installation members and directory contents separately, honor exact runtime exclusions, and verify upload evidence. Observation paths are relative to installed/.",
        materials,
      },
      expected,
      requiredSteps,
    };
  });
}
