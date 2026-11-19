import { describe, expect, it } from "vitest";
import { validateWorkImprovementCases } from "./work-improvement.js";
import { RELEASE_CHECK_PILOT, releaseCheckPilotCases } from "./work-improvement-release-cases.js";

const PROJECT = "project-alpha";
const CASES = releaseCheckPilotCases(PROJECT);
const CASE_IDS = [
  "clean",
  "layers-differ",
  "stale-layer",
  "no-build-recorded",
  "behavior-failed",
  "other-project",
];

describe("release check pilot cases", () => {
  it("passes the comparison's case-set rules", () => {
    expect(() =>
      validateWorkImprovementCases(
        releaseCheckPilotCases("project-alpha"),
        RELEASE_CHECK_PILOT.outputContract,
      ),
    ).not.toThrow();
  });

  it("covers the six planned cases with unique ids", () => {
    expect(CASES.map((fixture) => fixture.id)).toEqual(CASE_IDS);
    expect(new Set(CASES.map((fixture) => fixture.id)).size).toBe(CASE_IDS.length);
  });

  it("matches each expected outcome to its category", () => {
    const outcomeByCategory = {
      success: "complete",
      failure: "failed",
      insufficient_evidence: "unknown",
      scope_exception: "out_of_scope",
    } as const;
    for (const fixture of CASES)
      expect(fixture.expected.outcome).toBe(outcomeByCategory[fixture.category]);
  });

  it("keeps at least two diagnostic and three holdout cases", () => {
    expect(CASES.filter((fixture) => fixture.split === "diagnostic").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(CASES.filter((fixture) => fixture.split === "holdout").length).toBeGreaterThanOrEqual(3);
  });

  it("protects every non-failure category", () => {
    for (const category of ["success", "insufficient_evidence", "scope_exception"] as const)
      expect(CASES.some((fixture) => fixture.category === category && fixture.protection)).toBe(
        true,
      );
  });

  it("puts the other-project case outside the requested project", () => {
    const other = CASES.find((fixture) => fixture.id === "other-project");
    expect(other?.project).not.toBe(PROJECT);
    expect(JSON.parse(other!.input.materials["request.json"]!).project).toBe(
      `${PROJECT}-unrelated`,
    );
    expect(JSON.parse(other!.input.materials["release.json"]!).project).toBe(PROJECT);
  });

  it("gives every case its own input", () => {
    const inputs = CASES.map((fixture) => JSON.stringify(fixture.input));
    expect(new Set(inputs).size).toBe(CASES.length);
  });

  it("reads every material in the same order, and stops after the scope check", () => {
    const paths = [
      "request.json",
      "release.json",
      "source.json",
      "web_host.json",
      "rpc_host.json",
      "api.json",
      "behavior.json",
    ];
    for (const fixture of CASES)
      expect(fixture.requiredSteps).toEqual(
        paths
          .slice(0, fixture.id === "other-project" ? 2 : paths.length)
          .map((path) => ({ tool: "read_file", path })),
      );
  });

  it("does not leak the expected answer into the input", () => {
    for (const fixture of CASES) {
      const answer = JSON.stringify(fixture.expected);
      expect(fixture.input.task).not.toContain(answer);
      for (const text of Object.values(fixture.input.materials)) expect(text).not.toContain(answer);
    }
  });
});
