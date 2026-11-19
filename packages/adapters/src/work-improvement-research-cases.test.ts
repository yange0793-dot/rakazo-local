import { describe, expect, it } from "vitest";
import { validateWorkImprovementCases } from "./work-improvement.js";
import {
  RESEARCH_CHECK_PILOT,
  researchCheckPilotCases,
} from "./work-improvement-research-cases.js";

const PROJECT = "project-alpha";
const CASES = researchCheckPilotCases(PROJECT);
const PLAN = [
  { id: "clean", split: "diagnostic", category: "success", protection: true },
  { id: "multi-source", split: "holdout", category: "success", protection: true },
  { id: "unsupported", split: "diagnostic", category: "failure", protection: false },
  {
    id: "missing-source",
    split: "holdout",
    category: "insufficient_evidence",
    protection: true,
  },
  { id: "stale", split: "holdout", category: "failure", protection: false },
  { id: "other-project", split: "holdout", category: "scope_exception", protection: true },
] as const;

type Claim = { id: string; text: string; sourceId: string };
type Source = { title: string; publishedAt: string; version: string; text: string };

function parse<T>(materials: Record<string, string>, path: string): T {
  const text = materials[path];
  if (text === undefined) throw new Error(`Missing material ${path}`);
  return JSON.parse(text) as T;
}

function citedSourcePaths(materials: Record<string, string>, claims: Claim[]): string[] {
  return [...new Set(claims.map((claim) => `sources/${claim.sourceId}.json`))]
    .filter((path) => materials[path] !== undefined)
    .sort();
}

/** Coverage and currency follow from the files themselves, without reading the expected answer. */
function deriveCoverageAndCurrency(materials: Record<string, string>) {
  const request = parse<{ question: string; asOf: string }>(materials, "request.json");
  const summary = parse<{ claims: Claim[] }>(materials, "summary.json");
  const missing = summary.claims
    .filter((claim) => materials[`sources/${claim.sourceId}.json`] === undefined)
    .map((claim) => claim.id);
  const edition = /(\d{4} edition)/i.exec(request.question)?.[1]?.toLowerCase();
  const stale = [
    ...new Set(
      summary.claims
        .map((claim) => claim.sourceId)
        .filter((sourceId) => {
          const path = `sources/${sourceId}.json`;
          if (materials[path] === undefined) return false;
          const source = parse<Source>(materials, path);
          return (
            source.publishedAt > request.asOf ||
            (edition !== undefined && !source.version.toLowerCase().includes(edition))
          );
        }),
    ),
  ];
  return {
    coverage: missing.length > 0 ? "unknown" : "pass",
    missing,
    currency: stale.length > 0 ? "fail" : "pass",
    stale,
  };
}

describe("research check pilot cases", () => {
  it("passes the comparison's case-set rules", () => {
    expect(() =>
      validateWorkImprovementCases(
        researchCheckPilotCases("project-alpha"),
        RESEARCH_CHECK_PILOT.outputContract,
      ),
    ).not.toThrow();
  });

  it("covers the six planned cases with fixed splits, categories and protections", () => {
    expect(
      CASES.map(({ id, split, category, protection }) => ({
        id,
        split,
        category,
        protection,
      })),
    ).toEqual(PLAN);
    expect(new Set(CASES.map((fixture) => fixture.id)).size).toBe(PLAN.length);
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

  it("answers with exactly the public output contract's fields", () => {
    for (const fixture of CASES) {
      expect(Object.keys(fixture.expected.checks).sort()).toEqual(
        [...RESEARCH_CHECK_PILOT.outputContract.checkIds].sort(),
      );
      expect(Object.keys(fixture.expected.observations).sort()).toEqual(
        [...RESEARCH_CHECK_PILOT.outputContract.observationIds].sort(),
      );
    }
  });

  it("gives every case its own input", () => {
    const inputs = CASES.map((fixture) => JSON.stringify(fixture.input));
    expect(new Set(inputs).size).toBe(CASES.length);
  });

  it("reads request and summary first, then every cited source that exists", () => {
    for (const fixture of CASES) {
      const request = parse<{ project: string; question: string }>(
        fixture.input.materials,
        "request.json",
      );
      const summary = parse<{ project: string; question: string; claims: Claim[] }>(
        fixture.input.materials,
        "summary.json",
      );
      const scoped = summary.project !== request.project || summary.question !== request.question;
      const sourcePaths = scoped ? [] : citedSourcePaths(fixture.input.materials, summary.claims);
      expect(fixture.requiredSteps).toEqual([
        { tool: "read_file", path: "request.json" },
        { tool: "read_file", path: "summary.json" },
        ...sourcePaths.map((path) => ({ tool: "read_file", path })),
      ]);
      for (const path of sourcePaths) expect(fixture.input.materials[path]).toBeDefined();
      for (const claim of summary.claims)
        if (sourcePaths.includes(`sources/${claim.sourceId}.json`))
          expect(fixture.input.materials[`sources/${claim.sourceId}.json`]).toBeDefined();
    }
  });

  it("cites every source the materials hold and skips the one they do not", () => {
    const multi = CASES.find((fixture) => fixture.id === "multi-source")!;
    const summary = parse<{ claims: Claim[] }>(multi.input.materials, "summary.json");
    expect(summary.claims).toHaveLength(3);
    expect(summary.claims.filter((claim) => claim.sourceId === "src-rate-limits")).toHaveLength(2);
    expect(
      Object.keys(multi.input.materials).filter((path) => path.startsWith("sources/")),
    ).toHaveLength(2);

    const missing = CASES.find((fixture) => fixture.id === "missing-source")!;
    const cited = parse<{ claims: Claim[] }>(missing.input.materials, "summary.json").claims;
    expect(cited.map((claim) => claim.sourceId)).toContain("src-rollout-roadmap");
    expect(missing.input.materials["sources/src-rollout-roadmap.json"]).toBeUndefined();
  });

  it("derives coverage and currency from the materials", () => {
    for (const fixture of CASES) {
      if (fixture.expected.outcome === "out_of_scope") continue;
      const truth = deriveCoverageAndCurrency(fixture.input.materials);
      expect(fixture.expected.checks.coverage).toBe(truth.coverage);
      expect(fixture.expected.observations.missing_sources).toEqual(truth.missing);
      expect(fixture.expected.checks.currency).toBe(truth.currency);
      expect(fixture.expected.observations.stale_sources).toEqual(truth.stale);
    }
  });

  it("marks the contradicted claim's date as absent from its source", () => {
    const unsupported = CASES.find((fixture) => fixture.id === "unsupported")!;
    const summary = parse<{ claims: Claim[] }>(unsupported.input.materials, "summary.json");
    for (const claim of summary.claims) {
      const source = parse<Source>(unsupported.input.materials, `sources/${claim.sourceId}.json`);
      const stated = claim.text.match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i,
      );
      if (stated === null) continue;
      const backed = source.text.toLowerCase().includes(stated[0].toLowerCase());
      const flagged =
        unsupported.expected.observations.unsupported_claims?.includes(claim.id) ?? false;
      expect(flagged).toBe(!backed);
    }
  });

  it("puts the other-project case's summary outside the requested project", () => {
    const other = CASES.find((fixture) => fixture.id === "other-project")!;
    const request = parse<{ project: string }>(other.input.materials, "request.json");
    const summary = parse<{ project: string }>(other.input.materials, "summary.json");
    expect(request.project).toBe(PROJECT);
    expect(summary.project).toBe(`${PROJECT}-unrelated`);
    expect(other.project).toBe(`${PROJECT}-unrelated`);
    expect(other.requiredSteps).toEqual([
      { tool: "read_file", path: "request.json" },
      { tool: "read_file", path: "summary.json" },
    ]);
  });

  it("does not leak the expected answer into the task or materials", () => {
    for (const fixture of CASES) {
      const answer = JSON.stringify(fixture.expected);
      expect(fixture.input.task).not.toContain(answer);
      for (const text of Object.values(fixture.input.materials)) expect(text).not.toContain(answer);
    }
  });
});
