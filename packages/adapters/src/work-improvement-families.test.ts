import { describe, expect, it } from "vitest";
import { validateWorkImprovementCases } from "./work-improvement.js";
import { WORK_IMPROVEMENT_FAMILIES, workImprovementFamily } from "./work-improvement-families.js";

describe("work improvement families", () => {
  it("registers every family under its own id", () => {
    for (const family of WORK_IMPROVEMENT_FAMILIES)
      expect(workImprovementFamily(family.id)).toBe(family);
    expect(workImprovementFamily("missing")).toBeUndefined();
    expect(new Set(WORK_IMPROVEMENT_FAMILIES.map((family) => family.id)).size).toBe(
      WORK_IMPROVEMENT_FAMILIES.length,
    );
  });

  it.each(WORK_IMPROVEMENT_FAMILIES.map((family) => [family.id, family] as const))(
    "%s supplies a valid, protected case set",
    (_id, family) => {
      const cases = family.cases("project-alpha");
      validateWorkImprovementCases(cases, family.outputContract);
      expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
      expect(cases.length).toBeGreaterThanOrEqual(6);
      expect(new Set(cases.map((entry) => entry.category))).toEqual(
        new Set(["success", "failure", "insufficient_evidence", "scope_exception"]),
      );
      for (const category of ["success", "insufficient_evidence", "scope_exception"] as const)
        expect(cases.some((entry) => entry.category === category && entry.protection)).toBe(true);
      expect(cases.some((entry) => entry.split === "diagnostic")).toBe(true);
      expect(
        cases.some(
          (entry) => entry.category === "scope_exception" && entry.project !== "project-alpha",
        ),
      ).toBe(true);
      expect(new Set(cases.map((entry) => JSON.stringify(entry.input))).size).toBe(cases.length);
    },
  );
});
