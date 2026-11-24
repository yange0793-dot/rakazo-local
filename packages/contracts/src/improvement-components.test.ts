import { describe, expect, it } from "vitest";
import {
  ImprovementComponentReceiptSchema,
  ImprovementComponentSetSchema,
} from "./improvement-components.js";

describe("improvement component contracts", () => {
  it("accepts bounded guidance, registered-capability selections and tool-sequence scripts", () => {
    expect(
      ImprovementComponentSetSchema.parse({
        schemaVersion: "improvement-components.v1",
        items: [
          { id: "guide", revision: "1", kind: "task_guidance", text: "Compare exact paths." },
          {
            id: "reader",
            revision: "1",
            kind: "plugin",
            capabilityId: "isolated.snapshot.read_file",
          },
          {
            id: "script",
            revision: "2",
            kind: "script",
            language: "tool-sequence.v1",
            steps: [
              {
                capabilityId: "isolated.snapshot.read_file",
                input: { path: "request.json" },
              },
            ],
          },
        ],
      }).items,
    ).toHaveLength(3);
  });

  it("rejects duplicate identities, unbounded script plans and arbitrary executable fields", () => {
    const base = {
      schemaVersion: "improvement-components.v1",
      items: [
        { id: "same", revision: "1", kind: "task_guidance", text: "Use evidence." },
        { id: "same", revision: "2", kind: "system_strategy", text: "Check the result." },
      ],
    };
    expect(ImprovementComponentSetSchema.safeParse(base).success).toBe(false);
    expect(
      ImprovementComponentSetSchema.safeParse({
        schemaVersion: "improvement-components.v1",
        items: [
          {
            id: "script",
            revision: "1",
            kind: "script",
            language: "tool-sequence.v1",
            source: "process.exec('anything')",
            steps: [{ capabilityId: "isolated.snapshot.read_file", input: { path: "x" } }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ImprovementComponentSetSchema.safeParse({
        schemaVersion: "improvement-components.v1",
        items: [
          {
            id: "script",
            revision: "1",
            kind: "script",
            language: "tool-sequence.v1",
            steps: Array.from({ length: 5 }, (_, index) => ({
              capabilityId: "isolated.snapshot.read_file",
              input: { path: `file-${index}` },
            })),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates execution receipts against the exact component and skill hashes", () => {
    const digest = "a".repeat(64);
    const receipt = ImprovementComponentReceiptSchema.parse({
      schemaVersion: "improvement-component-receipt.v1",
      componentId: "script",
      componentRevision: "2",
      componentKind: "script",
      componentHash: digest,
      status: "executed",
      runId: "trial-run",
      skillRevision: "skill-revision-4",
      skillHash: digest,
      instructionsHash: digest,
      capabilities: [
        {
          id: "isolated.snapshot.read_file",
          adapterId: "work-improvement-isolated-tools",
          contractVersion: "1",
          adapterVersion: "1",
          schemaHash: digest,
          toolHash: digest,
        },
      ],
      executions: [
        {
          executionId: "trial-run:component:script:0",
          capabilityId: "isolated.snapshot.read_file",
          status: "succeeded",
          outputHash: digest,
          observedByRuntime: true,
        },
      ],
    });
    expect(receipt.status).toBe("executed");
    expect(
      ImprovementComponentReceiptSchema.safeParse({
        ...receipt,
        componentHash: "not-a-sha256",
      }).success,
    ).toBe(false);
  });
});
