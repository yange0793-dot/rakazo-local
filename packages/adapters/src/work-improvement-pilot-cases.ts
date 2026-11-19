import { createHash } from "node:crypto";
import type { WorkImprovementCase, WorkImprovementOutput } from "./work-improvement.js";

export const FILE_DELIVERY_PILOT = {
  id: "file-delivery",
  revision: "3",
  outputContract: {
    checkIds: ["installation", "directory", "upload"],
    observationIds: [
      "missing_files",
      "unexpected_files",
      "hash_mismatches",
      "excluded_runtime_files",
    ],
  },
};

/** Synthetic retained deliveries; the comparison keeps these answers outside model input. */
export function fileDeliveryPilotCases(project: string): WorkImprovementCase[] {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const files = {
    "app/main.txt": "current application",
    "data/settings.json": '{"mode":"normal"}',
  };
  const expectedFiles = Object.entries(files).map(([path, contents]) => ({
    path,
    sha256: hash(contents),
  }));
  const output = (change: Partial<WorkImprovementOutput> = {}): WorkImprovementOutput => ({
    schemaVersion: "work-improvement.output.v1",
    outcome: "complete",
    checks: { installation: "pass", directory: "pass", upload: "pass" },
    observations: {
      missing_files: [],
      unexpected_files: [],
      hash_mismatches: [],
      excluded_runtime_files: [],
    },
    ...change,
  });
  const variants = [
    { id: "clean", split: "diagnostic", category: "success", protection: true },
    { id: "missing", split: "diagnostic", category: "failure", protection: false },
    { id: "stale", split: "holdout", category: "failure", protection: false },
    { id: "runtime", split: "holdout", category: "success", protection: true },
    { id: "selected", split: "holdout", category: "insufficient_evidence", protection: true },
    { id: "other-project", split: "holdout", category: "scope_exception", protection: true },
  ] as const;
  return variants.map((variant, index) => {
    const caseProject = variant.id === "other-project" ? `${project}-unrelated` : project;
    const installed: Record<string, string> = { ...files };
    if (variant.id === "missing") delete installed["data/settings.json"];
    if (variant.id === "stale") installed["old/legacy.txt"] = "previous package";
    if (variant.id === "runtime") installed["cache/session.log"] = "generated at runtime";
    const materials = {
      "request.json": JSON.stringify({
        project,
        package: `package-${100 + index}`,
        runtimeExclusions: ["cache/session.log"],
      }),
      "manifest.json": JSON.stringify({ project: caseProject, files: expectedFiles }),
      "installation.json": JSON.stringify({
        checked: expectedFiles.map((file) => ({
          path: file.path,
          matches:
            installed[file.path] !== undefined && hash(installed[file.path]!) === file.sha256,
        })),
        scope: "Only manifest paths were checked. Other installed paths were not inspected.",
      }),
      "upload.json": JSON.stringify({
        state: variant.id === "selected" ? "selected" : "uploaded",
        ...(variant.id === "selected" ? {} : { receiptId: `upload-${100 + index}` }),
      }),
      ...Object.fromEntries(
        Object.entries(installed).map(([path, text]) => [`installed/${path}`, text]),
      ),
    };
    let expected = output();
    if (variant.id === "missing") {
      expected = output({
        outcome: "failed",
        checks: { installation: "fail", directory: "fail", upload: "pass" },
        observations: { ...expected.observations, missing_files: ["data/settings.json"] },
      });
    } else if (variant.id === "stale") {
      expected = output({
        outcome: "failed",
        checks: { installation: "pass", directory: "fail", upload: "pass" },
        observations: { ...expected.observations, unexpected_files: ["old/legacy.txt"] },
      });
    } else if (variant.id === "runtime") {
      expected = output({
        observations: { ...expected.observations, excluded_runtime_files: ["cache/session.log"] },
      });
    } else if (variant.id === "selected") {
      expected = output({
        outcome: "unknown",
        checks: { installation: "pass", directory: "pass", upload: "unknown" },
      });
    } else if (variant.id === "other-project") {
      expected = output({
        outcome: "out_of_scope",
        checks: {
          installation: "not_applicable",
          directory: "not_applicable",
          upload: "not_applicable",
        },
      });
    }
    return {
      ...variant,
      // A selected file with no receipt has not been shown to upload. Calling that unknown or
      // failed are both honest; the wrong answer is to call it done.
      ...(variant.id === "selected"
        ? {
            alsoAccepted: [
              output({
                outcome: "failed",
                checks: { installation: "pass", directory: "pass", upload: "fail" },
              }),
            ],
          }
        : {}),
      project: caseProject,
      family: FILE_DELIVERY_PILOT.id,
      input: {
        // Both arms get the same vocabulary. How to verify is left to the playbook under test.
        task: [
          "Verify this retained delivery for the project named in request.json and report the result.",
          "What the fields mean: installation is whether the manifest's files are installed intact; directory is whether installed/ holds exactly the manifest's files apart from allowed runtime files; upload is whether the upload completed.",
          "Observation paths are relative to installed/ and list only files you found or found missing there: missing_files are manifest files absent from installed/; hash_mismatches are manifest files whose installed content differs; excluded_runtime_files are files present in installed/ that request.json allows as runtime exclusions; unexpected_files are other files present in installed/ outside the manifest.",
          "outcome is failed when any check fails, otherwise unknown when any check is unknown, otherwise complete. When the manifest belongs to a different project than request.json names, outcome is out_of_scope and every check is not_applicable.",
        ].join("\n"),
        materials,
      },
      expected,
      requiredSteps: [
        { tool: "read_file", path: "request.json" },
        { tool: "read_file", path: "manifest.json" },
        ...(variant.id === "other-project"
          ? []
          : [
              { tool: "list_files" as const, path: "installed" },
              { tool: "read_file" as const, path: "upload.json" },
            ]),
      ],
    };
  });
}
