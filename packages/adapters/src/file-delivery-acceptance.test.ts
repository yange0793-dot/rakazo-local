import { createHash } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { TicketFileDelivery, TicketFileDeliveryRequirements } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateFileDeliveryAcceptance,
  evaluateFileDeliveryAcceptanceWithJudge,
} from "./file-delivery-acceptance.js";
import type { FileDeliveryJudge, FileDeliveryJudgeResult } from "./file-delivery-judge.js";

const bytes = Buffer.from("Observed file content.");
const hash = createHash("sha256").update(bytes).digest("hex");
const observedAt = "2026-11-23T10:00:00.000Z";
const requirements: TicketFileDeliveryRequirements = {
  version: 1,
  items: [
    { id: "report", kind: "artifact", description: "Deliver the report.", name: "report.txt" },
    { id: "index", kind: "artifact", description: "Deliver the index.", name: "index.txt" },
  ],
};
const report = {
  id: "report-file",
  version: 1,
  hash,
  name: "report.txt",
  mimeType: "text/plain",
  bytes,
  observedAt,
};
const index = { ...report, id: "index-file", name: "index.txt" };
const fileDelivery: TicketFileDelivery = {
  requirementsVersion: 1,
  evidenceRefs: [
    { requirementId: "report", kind: "artifact", artifactId: report.id, version: 1, hash },
    { requirementId: "index", kind: "artifact", artifactId: index.id, version: 1, hash },
  ],
};
const input = {
  requirements,
  fileDelivery,
  deliveredArtifactIds: [report.id, index.id],
  artifacts: [report, index],
  effects: [],
};

describe("file-delivery acceptance", () => {
  it("preserves the old evaluator and receipt shape without new constraints", () => {
    expect(evaluateFileDeliveryAcceptance(input)).toMatchObject({
      schemaVersion: 1,
      evaluatorRevision: "file-delivery.v1",
      status: "verified",
    });
  });

  it("checks actual bytes against fixed content constraints", () => {
    const checked = evaluateFileDeliveryAcceptance({
      ...input,
      requirements: {
        version: 1,
        items: [
          {
            id: "report",
            kind: "artifact",
            description: "The report must be readable and nonempty.",
            contentConstraints: [{ kind: "text_nonempty" }],
          },
        ],
      },
    });
    expect(checked).toMatchObject({
      evaluatorRevision: "file-delivery.v2",
      status: "verified",
      results: [{ reason: "content_verified" }],
    });
    const empty = Buffer.from(" \n");
    const emptyHash = createHash("sha256").update(empty).digest("hex");
    expect(
      evaluateFileDeliveryAcceptance({
        ...input,
        artifacts: [{ ...report, bytes: empty, hash: emptyHash }],
        fileDelivery: {
          ...fileDelivery,
          evidenceRefs: [
            {
              requirementId: "report",
              kind: "artifact",
              artifactId: report.id,
              version: 1,
              hash: emptyHash,
            },
          ],
        },
        requirements: {
          version: 1,
          items: [
            {
              id: "report",
              kind: "artifact",
              description: "Nonempty report.",
              contentConstraints: [{ kind: "text_nonempty" }],
            },
          ],
        },
      }).status,
    ).toBe("issue");
  });

  it("requires evidence for every previously fixed requirement", () => {
    const acceptance = evaluateFileDeliveryAcceptance({
      ...input,
      fileDelivery: { ...fileDelivery, evidenceRefs: [fileDelivery.evidenceRefs[0]!] },
    });
    expect(acceptance.status).toBe("unknown");
    expect(acceptance.results).toMatchObject([
      { requirementId: "report", status: "verified" },
      { requirementId: "index", status: "unknown", reason: "missing_evidence" },
    ]);
  });

  it("records actual host observations for files that meet the declared constraints", () => {
    const acceptance = evaluateFileDeliveryAcceptance(input);
    expect(acceptance.status).toBe("verified");
    expect(acceptance.results[0]?.evidenceRefs[0]).toEqual({
      ...fileDelivery.evidenceRefs[0],
      observedAt,
    });
  });

  it("does not infer evidence from a completion claim", () => {
    expect(evaluateFileDeliveryAcceptance({ ...input, fileDelivery: undefined }).status).toBe(
      "unknown",
    );
  });

  it.each([
    ["missing", [], "unknown", "artifact_unavailable"],
    ["unreadable", [{ ...report, bytes: undefined }, index], "unknown", "artifact_unreadable"],
    [
      "changed",
      [{ ...report, bytes: Buffer.from("Changed content") }, index],
      "issue",
      "artifact_hash_mismatch",
    ],
    ["wrong version", [{ ...report, version: 2 }, index], "issue", "version_mismatch"],
    [
      "wrong name",
      [{ ...report, name: "other.txt" }, index],
      "issue",
      "artifact_constraint_mismatch",
    ],
  ] as const)("keeps %s file evidence unverified", (_name, artifacts, status, reason) => {
    const acceptance = evaluateFileDeliveryAcceptance({ ...input, artifacts });
    expect(acceptance.status).toBe(status);
    expect(acceptance.results[0]).toMatchObject({ status, reason });
  });

  it("does not accept a reference to a different requirements version", () => {
    const acceptance = evaluateFileDeliveryAcceptance({
      ...input,
      fileDelivery: { ...fileDelivery, requirementsVersion: 2 },
    });
    expect(acceptance.status).toBe("unknown");
    expect(acceptance.results.every((item) => item.reason === "version_mismatch")).toBe(true);
  });

  it("leaves semantic requirements unknown even when a file exists", () => {
    const acceptance = evaluateFileDeliveryAcceptance({
      ...input,
      requirements: {
        ...requirements,
        items: [
          ...requirements.items,
          { id: "meaning", kind: "semantic", description: "Supported conclusions." },
        ],
      },
    });
    expect(acceptance.status).toBe("unknown");
    expect(acceptance.results.at(-1)).toMatchObject({ reason: "unsupported_semantic" });
  });

  it("checks the actual effect kind, terminal state and tool result", () => {
    const effectInput = {
      ...input,
      requirements: {
        ...requirements,
        items: [
          ...requirements.items,
          {
            id: "upload",
            kind: "effect" as const,
            description: "The upload action completed.",
            effectKind: "upload",
          },
        ],
      },
      fileDelivery: {
        ...fileDelivery,
        evidenceRefs: [
          ...fileDelivery.evidenceRefs,
          { requirementId: "upload", kind: "effect" as const, effectId: "effect-1" },
        ],
      },
    };
    const effect = {
      id: "effect-1",
      kind: "upload",
      status: "completed",
      result: { ok: true },
      observedAt,
    };
    expect(evaluateFileDeliveryAcceptance({ ...effectInput, effects: [effect] }).status).toBe(
      "verified",
    );
    expect(
      evaluateFileDeliveryAcceptance({
        ...effectInput,
        effects: [{ ...effect, kind: "read_file" }],
      }).results.at(-1)?.reason,
    ).toBe("effect_kind_mismatch");
    expect(
      evaluateFileDeliveryAcceptance({
        ...effectInput,
        effects: [{ ...effect, result: { error: "Rejected" } }],
      }).status,
    ).toBe("issue");
    expect(
      evaluateFileDeliveryAcceptance({
        ...effectInput,
        effects: [{ ...effect, status: "uncertain" }],
      }).status,
    ).toBe("unknown");
    expect(evaluateFileDeliveryAcceptance(effectInput).results.at(-1)?.reason).toBe(
      "effect_unavailable",
    );
  });

  it.each([
    [{ stdout: "Started", stderr: "", code: null, running: true }, "unknown"],
    [{ stdout: "Output", stderr: "" }, "unknown"],
    [{ stdout: "Output", stderr: "", code: 0 }, "verified"],
    [{ stdout: "", stderr: "Failed", code: 1 }, "issue"],
    [{ kind: "agent_tool_result", details: { running: true, code: null } }, "unknown"],
    [{ kind: "agent_tool_result", details: { exitCode: 0 } }, "verified"],
  ])("requires a terminal shell exit code for %j", (shellResult, status) => {
    const acceptance = evaluateFileDeliveryAcceptance({
      ...input,
      requirements: {
        ...requirements,
        items: [
          ...requirements.items,
          { id: "check", kind: "effect", description: "Check completed.", effectKind: "shell" },
        ],
      },
      fileDelivery: {
        ...fileDelivery,
        evidenceRefs: [
          ...fileDelivery.evidenceRefs,
          { requirementId: "check", kind: "effect", effectId: "shell-1" },
        ],
      },
      effects: [
        { id: "shell-1", kind: "shell", status: "completed", result: shellResult, observedAt },
      ],
    });
    expect(acceptance.status).toBe(status);
    expect(acceptance.results.at(-1)).toMatchObject({
      requirementId: "check",
      status,
      reason: status === "verified" ? "verified_observation" : "effect_not_completed",
    });
  });
});

describe("file-delivery asynchronous acceptance", () => {
  const context: AdapterContext = {
    operationId: "receipt",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    runId: "run",
    signal: new AbortController().signal,
  };
  const semanticInput = {
    ...input,
    requirements: {
      ...requirements,
      items: [
        ...requirements.items,
        {
          id: "meaning",
          kind: "semantic" as const,
          description: "Cover the requested topics with support.",
          rubricVersion: "file-delivery.semantic.v1",
        },
      ],
    },
    fileDelivery: {
      ...fileDelivery,
      evidenceRefs: [
        ...fileDelivery.evidenceRefs,
        {
          requirementId: "meaning",
          kind: "artifact" as const,
          artifactId: report.id,
          version: 1,
          hash,
          role: "deliverable" as const,
        },
        {
          requirementId: "meaning",
          kind: "artifact" as const,
          artifactId: index.id,
          version: 1,
          hash,
          role: "source" as const,
        },
      ],
    },
  };
  function judgeFixture() {
    const handler = vi.fn(
      async (): Promise<FileDeliveryJudgeResult> => ({
        status: "verified",
        reason: "semantic_verified",
        judge: {
          rubricVersion: "file-delivery.semantic.v1",
          calibrationRevision: "file-delivery.calibration.v1",
          operationId: "receipt:file-judge:1:meaning",
          status: "verified",
          reason: "semantic_verified",
          costUsd: 0.01,
          totalTokens: 100,
        },
      }),
    );
    const judge: FileDeliveryJudge = Object.assign(handler, {
      calibrate: vi.fn<FileDeliveryJudge["calibrate"]>(),
    });
    return { handler, judge };
  }

  it("passes complete, version-bound host observations and records the judge metadata", async () => {
    const { judge, handler } = judgeFixture();
    const acceptance = await evaluateFileDeliveryAcceptanceWithJudge(semanticInput, {
      judge,
      context,
    });
    expect(acceptance.status).toBe("verified");
    expect(acceptance.evaluatorRevision).toBe("file-delivery.v2");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementId: "meaning",
        requirementsVersion: 1,
        evidence: [
          expect.objectContaining({
            artifactId: report.id,
            role: "deliverable",
            text: bytes.toString(),
          }),
          expect.objectContaining({ artifactId: index.id, role: "source", text: bytes.toString() }),
        ],
      }),
      context,
    );
    expect(acceptance.results.at(-1)).toMatchObject({
      status: "verified",
      judge: { operationId: "receipt:file-judge:1:meaning", costUsd: 0.01 },
      evidenceRefs: [
        expect.objectContaining({ role: "deliverable", observedAt }),
        expect.objectContaining({ role: "source", observedAt }),
      ],
    });
  });

  it.each([
    ["omitted evidence", { fileDelivery: { ...fileDelivery } }],
    [
      "changed requirements",
      { fileDelivery: { ...semanticInput.fileDelivery, requirementsVersion: 2 } },
    ],
    ["missing bytes", { artifacts: [{ ...report, bytes: undefined }, index] }],
    ["wrong hash", { artifacts: [{ ...report, bytes: Buffer.from("changed") }, index] }],
    ["wrong artifact version", { artifacts: [{ ...report, version: 2 }, index] }],
    ["unsupported format", { artifacts: [{ ...report, mimeType: "application/pdf" }, index] }],
    ["not delivered", { deliveredArtifactIds: [report.id] }],
  ])("never invokes a semantic judge for %s", async (_name, overrides) => {
    const { judge, handler } = judgeFixture();
    const acceptance = await evaluateFileDeliveryAcceptanceWithJudge(
      { ...semanticInput, ...overrides },
      { judge, context },
    );
    expect(acceptance.status).not.toBe("verified");
    expect(handler).not.toHaveBeenCalled();
  });

  it("cannot use one artifact as its own source", async () => {
    const { judge, handler } = judgeFixture();
    const acceptance = await evaluateFileDeliveryAcceptanceWithJudge(
      {
        ...semanticInput,
        fileDelivery: {
          ...semanticInput.fileDelivery,
          evidenceRefs: semanticInput.fileDelivery.evidenceRefs.map((ref) =>
            ref.requirementId === "meaning" && "role" in ref && ref.role === "source"
              ? { ...ref, artifactId: report.id }
              : ref,
          ),
        },
      },
      { judge, context },
    );
    expect(acceptance.results.at(-1)).toMatchObject({
      status: "unknown",
      reason: "unsupported_evidence",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps required semantics unknown with no configured judge or on judge failure", async () => {
    expect(
      (await evaluateFileDeliveryAcceptanceWithJudge(semanticInput)).results.at(-1),
    ).toMatchObject({ status: "unknown", reason: "judge_unavailable" });
    const { judge, handler } = judgeFixture();
    handler.mockRejectedValue(new Error("offline judge failure"));
    expect(
      (await evaluateFileDeliveryAcceptanceWithJudge(semanticInput, { judge, context })).results.at(
        -1,
      ),
    ).toMatchObject({ status: "unknown", reason: "judge_error" });
  });
});
