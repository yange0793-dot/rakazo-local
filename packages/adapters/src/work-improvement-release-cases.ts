import type { WorkImprovementCase, WorkImprovementOutput } from "./work-improvement.js";

export const RELEASE_CHECK_PILOT = {
  id: "release-check",
  revision: "3",
  outputContract: {
    checkIds: ["source", "web_host", "rpc_host", "api", "behavior"],
    observationIds: ["version_mismatches", "missing_evidence", "failed_behaviors"],
  },
};

const REQUIRED_BEHAVIORS = [
  {
    id: "chat",
    description: "A message sent in the web client reaches the assistant and a reply appears.",
  },
  {
    id: "file_upload",
    description: "A file attached in the web client is stored and listed in the conversation.",
  },
];

/** The same neutral wording for every case. How to verify is left to the playbook under test. */
const TASK = [
  "Verify whether the services running for this project are the release specified by release.json and report the result.",
  "request.json names the project being verified; release.json is the release that project should be running.",
  "source is whether the source code being run is the release's commit; web_host, rpc_host and api are whether those layers are running the release's build; behavior is whether every behavior in release.json's requiredBehaviors was observed passing.",
  "outcome is failed when any check fails, otherwise unknown when any check is unknown, otherwise complete.",
  "version_mismatches lists the layers whose version is not the one in release.json; missing_evidence lists the layers with no build or commit recorded; failed_behaviors lists the behaviors observed failing.",
  "When release.json belongs to a project other than the one request.json names, outcome is out_of_scope and every check is not_applicable.",
].join("\n");

type LayerBuild = { web_host: string; rpc_host: string; api: string };
type RunningBuild = { web_host: string; rpc_host?: string; api: string };

interface Scenario {
  id: string;
  split: "diagnostic" | "holdout";
  category: "success" | "failure" | "insufficient_evidence" | "scope_exception";
  protection: boolean;
  releaseProject: string;
  /** The project the user asked about; release.json belongs to it except in the scope case. */
  requestProject?: string;
  commit: string;
  /** The builds release.json names for each layer. */
  builds: LayerBuild;
  /** The builds the layers report while running; a missing rpc_host build means none was recorded. */
  running: RunningBuild;
  behavior: { id: string; passed: boolean }[];
  expected: WorkImprovementOutput;
}

/** Synthetic release checks; the comparison keeps these answers outside model input. */
export function releaseCheckPilotCases(project: string): WorkImprovementCase[] {
  // One distinct 40-character hexadecimal commit id per case.
  const commit = (seed: string) => seed.repeat(5);
  const output = (change: Partial<WorkImprovementOutput> = {}): WorkImprovementOutput => ({
    schemaVersion: "work-improvement.output.v1",
    outcome: "complete",
    checks: { source: "pass", web_host: "pass", rpc_host: "pass", api: "pass", behavior: "pass" },
    observations: { version_mismatches: [], missing_evidence: [], failed_behaviors: [] },
    ...change,
  });
  const scenarios: Scenario[] = [
    {
      id: "clean",
      split: "diagnostic",
      category: "success",
      protection: true,
      releaseProject: project,
      commit: commit("0a1b2c3d"),
      builds: {
        web_host: "20261118120000",
        rpc_host: "20261118120000",
        api: "20261118120000",
      },
      running: {
        web_host: "20261118120000",
        rpc_host: "20261118120000",
        api: "20261118120000",
      },
      behavior: [
        { id: "chat", passed: true },
        { id: "file_upload", passed: true },
      ],
      expected: output(),
    },
    {
      // Success even though the layers carry different build numbers: each one matches its own
      // entry in release.json.
      id: "layers-differ",
      split: "holdout",
      category: "success",
      protection: true,
      releaseProject: project,
      commit: commit("1b2c3d4e"),
      builds: {
        web_host: "20261117100500",
        rpc_host: "20261117093000",
        api: "20261117104500",
      },
      running: {
        web_host: "20261117100500",
        rpc_host: "20261117093000",
        api: "20261117104500",
      },
      behavior: [
        { id: "chat", passed: true },
        { id: "file_upload", passed: true },
      ],
      expected: output(),
    },
    {
      // The api layer is healthy but runs an older build than the release names.
      id: "stale-layer",
      split: "holdout",
      category: "failure",
      protection: false,
      releaseProject: project,
      commit: commit("2c3d4e5f"),
      builds: {
        web_host: "20261116120000",
        rpc_host: "20261116121000",
        api: "20261116122000",
      },
      running: {
        web_host: "20261116120000",
        rpc_host: "20261116121000",
        api: "20261115101500",
      },
      behavior: [
        { id: "chat", passed: true },
        { id: "file_upload", passed: true },
      ],
      expected: output({
        outcome: "failed",
        checks: {
          source: "pass",
          web_host: "pass",
          rpc_host: "pass",
          api: "fail",
          behavior: "pass",
        },
        observations: { version_mismatches: ["api"], missing_evidence: [], failed_behaviors: [] },
      }),
    },
    {
      // The rpc_host layer reports only health; with no build recorded it cannot be compared.
      id: "no-build-recorded",
      split: "holdout",
      category: "insufficient_evidence",
      protection: true,
      releaseProject: project,
      commit: commit("3d4e5f60"),
      builds: {
        web_host: "20261114143000",
        rpc_host: "20261114144000",
        api: "20261114145000",
      },
      running: { web_host: "20261114143000", api: "20261114145000" },
      behavior: [
        { id: "chat", passed: true },
        { id: "file_upload", passed: true },
      ],
      expected: output({
        outcome: "unknown",
        checks: {
          source: "pass",
          web_host: "pass",
          rpc_host: "unknown",
          api: "pass",
          behavior: "pass",
        },
        observations: {
          version_mismatches: [],
          missing_evidence: ["rpc_host"],
          failed_behaviors: [],
        },
      }),
    },
    {
      // Every version matches, but one required behavior was observed failing.
      id: "behavior-failed",
      split: "diagnostic",
      category: "failure",
      protection: false,
      releaseProject: project,
      commit: commit("4e5f6071"),
      builds: {
        web_host: "20261113110000",
        rpc_host: "20261113111000",
        api: "20261113112000",
      },
      running: {
        web_host: "20261113110000",
        rpc_host: "20261113111000",
        api: "20261113112000",
      },
      behavior: [
        { id: "chat", passed: false },
        { id: "file_upload", passed: true },
      ],
      expected: output({
        outcome: "failed",
        checks: {
          source: "pass",
          web_host: "pass",
          rpc_host: "pass",
          api: "pass",
          behavior: "fail",
        },
        observations: { version_mismatches: [], missing_evidence: [], failed_behaviors: ["chat"] },
      }),
    },
    {
      id: "other-project",
      split: "holdout",
      category: "scope_exception",
      protection: true,
      releaseProject: project,
      requestProject: `${project}-unrelated`,
      commit: commit("5f607182"),
      builds: {
        web_host: "20261112101000",
        rpc_host: "20261112102000",
        api: "20261112103000",
      },
      running: {
        web_host: "20261112101000",
        rpc_host: "20261112102000",
        api: "20261112103000",
      },
      behavior: [
        { id: "chat", passed: true },
        { id: "file_upload", passed: true },
      ],
      expected: output({
        outcome: "out_of_scope",
        checks: {
          source: "not_applicable",
          web_host: "not_applicable",
          rpc_host: "not_applicable",
          api: "not_applicable",
          behavior: "not_applicable",
        },
      }),
    },
  ];
  return scenarios.map((scenario): WorkImprovementCase => {
    const requestProject = scenario.requestProject ?? scenario.releaseProject;
    return {
      id: scenario.id,
      project: requestProject,
      family: RELEASE_CHECK_PILOT.id,
      split: scenario.split,
      category: scenario.category,
      protection: scenario.protection,
      input: {
        task: TASK,
        materials: {
          "request.json": JSON.stringify({ project: requestProject }),
          "release.json": JSON.stringify({
            project: scenario.releaseProject,
            target: {
              commit: scenario.commit,
              builds: { source: scenario.commit, ...scenario.builds },
            },
            requiredBehaviors: REQUIRED_BEHAVIORS,
          }),
          "source.json": JSON.stringify({ commit: scenario.commit }),
          "web_host.json": JSON.stringify({ build: scenario.running.web_host, health: "ok" }),
          "rpc_host.json": JSON.stringify(
            scenario.running.rpc_host === undefined
              ? { health: "ok" }
              : { build: scenario.running.rpc_host, health: "ok" },
          ),
          "api.json": JSON.stringify({ build: scenario.running.api, health: "ok" }),
          "behavior.json": JSON.stringify({ results: scenario.behavior }),
        },
      },
      expected: scenario.expected,
      requiredSteps:
        scenario.id === "other-project"
          ? [
              { tool: "read_file", path: "request.json" },
              { tool: "read_file", path: "release.json" },
            ]
          : [
              { tool: "read_file", path: "request.json" },
              { tool: "read_file", path: "release.json" },
              { tool: "read_file", path: "source.json" },
              { tool: "read_file", path: "web_host.json" },
              { tool: "read_file", path: "rpc_host.json" },
              { tool: "read_file", path: "api.json" },
              { tool: "read_file", path: "behavior.json" },
            ],
    };
  });
}
