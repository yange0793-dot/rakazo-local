import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentUsage,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { FileDeliveryJudgeInput, FileDeliveryJudgeOptions } from "./file-delivery-judge.js";
import {
  createFileDeliveryJudge,
  FILE_DELIVERY_FIXTURE_DIGEST,
  FILE_DELIVERY_RUBRIC_VERSION,
} from "./file-delivery-judge.js";
import { FILE_DELIVERY_CALIBRATION_CASES } from "./fixtures/file-delivery-calibration.js";

const context: AdapterContext = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  runId: "run",
  traceId: "trace",
  operationId: "receipt",
  signal: new AbortController().signal,
};
const model = {
  provider: "fixture",
  id: "fixed-model",
  apiProtocol: "chat-completions" as const,
  thinkingLevel: "high" as const,
  maxTokens: 2_000,
  headers: { "x-connection-setting": "fixed" },
};
const evidence: FileDeliveryJudgeInput["evidence"] = [
  {
    id: "deliverable",
    artifactId: "report",
    name: "report.txt",
    mimeType: "text/plain",
    version: 1,
    hash: "a".repeat(64),
    role: "deliverable",
    text: "Revenue was 12 and costs were 5.",
  },
  {
    id: "source",
    artifactId: "records",
    name: "records.txt",
    mimeType: "text/plain",
    version: 1,
    hash: "b".repeat(64),
    role: "source",
    text: "Revenue: 12. Costs: 5.",
  },
];
const input: FileDeliveryJudgeInput = {
  requirementsVersion: 3,
  requirementId: "report-complete",
  description: "Report revenue and costs, supported by the records.",
  evidence,
};
type Label = { coverage: "verified" | "issue" | "unknown"; evidenceSupport: Label["coverage"] };

/** Deterministic wire labels exercise orchestration; they are not live calibration evidence. */
class ReplayRuntime implements AgentRuntime {
  requests: AgentRunRequest[] = [];
  contexts: Array<Partial<AdapterContext> | undefined> = [];
  usage: Partial<AgentUsage> = {};
  label: Label = { coverage: "verified", evidenceSupport: "verified" };
  mode:
    | "normal"
    | "error"
    | "no_usage"
    | "invalid_json"
    | "wrong_version"
    | "missing_verdict"
    | "wrong_citation"
    | "calibration_rejected"
    | "no_done"
    | "tool"
    | "twice"
    | "hanging" = "normal";
  producer = true;
  describe() {
    return {
      id: "offline-judge-replay",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }
  async abort() {}
  async *run(
    request: AgentRunRequest,
    callContext?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.requests.push(request);
    this.contexts.push(callContext);
    if (this.mode === "error") throw new Error("offline provider failure");
    if (this.mode === "hanging") {
      await new Promise(() => {});
      return;
    }
    const prompt = JSON.parse(request.prompt) as {
      requirementsVersion: number;
      requirements: Array<{
        requirementId: string;
        evidence: FileDeliveryJudgeInput["evidence"];
      }>;
    };
    const callId = `call-${this.requests.length}`;
    const observer = request.model.callObserver!;
    const reservation = await observer.beforeCall({
      callId,
      runId: request.runId,
      provider: request.model.provider,
      modelId: request.model.id,
      operationKind: request.usageOperationKind,
      inputTokensEstimate: 100,
      maxOutputTokens: request.model.maxTokens!,
    });
    const usage = {
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      costUsd: 0.01,
      costSource: "fixture",
      ...this.usage,
    };
    await observer.afterCall(reservation, usage);
    if (this.mode === "twice")
      await observer.beforeCall({
        provider: request.model.provider,
        modelId: request.model.id,
        inputTokensEstimate: 1,
        maxOutputTokens: 1,
      });
    if (this.mode !== "no_usage") {
      const event: Extract<AgentRuntimeEvent, { type: "usage" }> = {
        ...usage,
        type: "usage",
        provider: request.model.provider,
        model: request.model.id,
        callId,
      };
      let accounted = false;
      if (this.producer) {
        try {
          await request.onUsage!(event);
          accounted = true;
        } catch {
          // The real runtime exposes an unaccounted event for consumer recovery.
        }
      }
      yield { ...event, accounted };
    }
    const verdicts = prompt.requirements.map((item) => {
      const fixture = FILE_DELIVERY_CALIBRATION_CASES.find(
        (sample) => sample.id === item.requirementId,
      );
      const label = fixture ? fixture.expected : this.label;
      return {
        requirementId: item.requirementId,
        ...label,
        ...(fixture && this.mode === "calibration_rejected" ? { coverage: "unknown" } : {}),
        reason: "Offline fixture label.",
        citations: item.evidence.map((entry) => ({
          evidenceId: entry.id,
          quote:
            this.mode === "wrong_citation" && !fixture ? "not present" : entry.text.slice(0, 80),
        })),
      };
    });
    const text =
      this.mode === "invalid_json"
        ? "```json\n{}\n```"
        : JSON.stringify({
            schemaVersion: 1,
            rubricVersion: FILE_DELIVERY_RUBRIC_VERSION,
            requirementsVersion:
              this.mode === "wrong_version"
                ? prompt.requirementsVersion + 1
                : prompt.requirementsVersion,
            verdicts: this.mode === "missing_verdict" ? verdicts.slice(1) : verdicts,
          });
    if (this.mode === "tool")
      yield { type: "tool", name: "shell", args: {}, executionId: "unexpected" };
    yield { type: "text", text };
    if (this.mode !== "no_done") yield { type: "done", text };
  }
}

function setup(overrides: Partial<FileDeliveryJudgeOptions> = {}) {
  const runtime = new ReplayRuntime();
  const onUsage = vi.fn(async () => {});
  const options: FileDeliveryJudgeOptions = {
    runtime,
    model,
    onUsage,
    budget: { maxTotalTokens: 40_000, timeoutMs: 5_000 },
    ...overrides,
  };
  return { runtime, onUsage, judge: createFileDeliveryJudge(options) };
}

describe("versioned file-delivery judge", () => {
  it("earns calibration, caches it within one run, and keeps independent cost references", async () => {
    const parent = {
      beforeCall: vi.fn(async () => "parent-reservation"),
      afterCall: vi.fn(async () => {}),
    };
    const { judge, runtime, onUsage } = setup({ model: { ...model, callObserver: parent } });
    const report = await judge.calibrate(context);
    expect(report).toMatchObject({
      status: "verified",
      fixtureDigest: FILE_DELIVERY_FIXTURE_DIGEST,
      revision: "file-delivery.calibration.v1",
      operationId: "run:file-judge:calibration",
      totalTokens: 600,
    });
    expect(report.costUsd).toBeCloseTo(0.06);
    expect(report.cases).toHaveLength(6);
    const first = await judge(input, context);
    const second = await judge({ ...input, requirementId: "second" }, context);
    expect(first).toMatchObject({
      status: "verified",
      reason: "semantic_verified",
      judge: {
        calibration: report,
        operationId: "receipt:file-judge:3:report-complete",
        costUsd: 0.01,
        totalTokens: 100,
      },
    });
    expect(second.status).toBe("verified");
    expect(runtime.requests).toHaveLength(8);
    expect(onUsage).toHaveBeenCalledTimes(8);
    expect(parent.beforeCall).toHaveBeenCalledTimes(8);
    expect(parent.afterCall).toHaveBeenCalledTimes(8);
    for (const request of runtime.requests) {
      expect(request).toMatchObject({ tools: [], history: [], usageOperationKind: "setup", model });
      expect(request.fallbackModels).toBeUndefined();
      expect(request.computerModel).toBeUndefined();
      expect(request.executeTool).toBeUndefined();
      expect(request.script).toBeUndefined();
      expect(request.instructions).toContain("not its own source");
    }
    const calibrationPrompt = runtime.requests[0]!.prompt;
    expect(calibrationPrompt).not.toContain('"expected"');
    expect(calibrationPrompt).not.toContain('"rationale"');
    expect(calibrationPrompt).not.toContain("Both requested facts are supported");
  });

  it.each([
    [{ coverage: "issue", evidenceSupport: "verified" }, "issue"],
    [{ coverage: "verified", evidenceSupport: "issue" }, "issue"],
    [{ coverage: "verified", evidenceSupport: "unknown" }, "unknown"],
  ] as const)("uses semantic labels for omissions and support: %j", async (label, status) => {
    const { judge, runtime } = setup();
    runtime.label = label;
    expect((await judge(input, context)).status).toBe(status);
  });

  it("permits a fixed coverage-only requirement without falsely verifying support", async () => {
    const { judge, runtime } = setup();
    runtime.label = { coverage: "verified", evidenceSupport: "unknown" };
    expect(
      await judge({ ...input, criteria: ["coverage"], evidence: [evidence[0]!] }, context),
    ).toMatchObject({
      status: "verified",
      judge: { verdict: { evidenceSupport: "unknown" } },
    });
  });

  it("does not accept an unrecognized rubric revision or reuse calibration across runs", async () => {
    const { judge, runtime } = setup();
    expect((await judge({ ...input, rubricVersion: "new-unreviewed" }, context)).status).toBe(
      "unknown",
    );
    expect(runtime.requests).toHaveLength(0);
    await judge(input, context);
    expect((await judge(input, { ...context, runId: "other-run" })).status).toBe("unknown");
    expect(runtime.requests).toHaveLength(7);
  });

  it.each([
    ["error", 1],
    ["invalid_json", 1],
    ["wrong_version", 1],
    ["missing_verdict", 1],
    ["calibration_rejected", 6],
    ["no_done", 1],
    ["tool", 1],
    ["twice", 1],
  ] as const)("rejects %s calibration and never calls the task judge", async (mode, requests) => {
    const { judge, runtime } = setup();
    runtime.mode = mode;
    const judged = await judge(input, context);
    expect(judged.status).toBe("unknown");
    expect(judged.judge.calibration?.status).toBe("unknown");
    await judge(input, context);
    expect(runtime.requests).toHaveLength(requests);
  });

  it.each([
    ["no_usage", {}, "judge_missing_usage"],
    ["normal", { inputTokens: null }, "judge_missing_usage"],
    ["normal", { totalTokens: null }, "judge_missing_usage"],
    ["normal", { costUsd: null }, "judge_unknown_cost"],
  ] as const)("keeps %s / %j calibration usage unknown", async (mode, usage, reason) => {
    const { judge, runtime } = setup();
    runtime.mode = mode;
    runtime.usage = usage;
    const judged = await judge(input, context);
    expect(judged).toMatchObject({
      status: "unknown",
      judge: { calibration: { status: "unknown", reason } },
    });
    if ("costUsd" in usage && usage.costUsd === null)
      expect(judged.judge.calibration?.costUsd).toBeNull();
  });

  it("handles bad formal judge output after successful calibration", async () => {
    const { judge, runtime } = setup();
    await judge.calibrate(context);
    runtime.mode = "wrong_citation";
    const judged = await judge(input, context);
    expect(judged).toMatchObject({
      status: "unknown",
      reason: "judge_invalid_output",
      judge: { calibration: { status: "verified" }, costUsd: 0.01 },
    });
  });

  it.each([
    "error",
    "invalid_json",
    "wrong_version",
    "missing_verdict",
    "no_done",
    "tool",
  ] as const)("keeps a formal %s result unknown after calibration", async (mode) => {
    const { judge, runtime } = setup();
    await judge.calibrate(context);
    runtime.mode = mode;
    expect((await judge(input, context)).status).toBe("unknown");
    expect(runtime.requests).toHaveLength(7);
  });

  it("does not let a returned report turn a failed calibration into a pass", async () => {
    const { judge, runtime } = setup();
    runtime.mode = "calibration_rejected";
    const report = await judge.calibrate(context);
    report.status = "verified";
    report.cases = [];
    expect((await judge(input, context)).status).toBe("unknown");
    expect(runtime.requests).toHaveLength(6);
  });

  it("does not fabricate known costs for formal judgment after calibration", async () => {
    const { judge, runtime } = setup();
    await judge.calibrate(context);
    runtime.usage = { costUsd: null };
    expect(await judge(input, context)).toMatchObject({
      status: "unknown",
      reason: "judge_unknown_cost",
      judge: { costUsd: null, totalTokens: 100 },
    });
  });

  it("uses consumer accounting when producer accounting fails", async () => {
    const onUsage = vi.fn<FileDeliveryJudgeOptions["onUsage"]>(async () => {});
    onUsage.mockRejectedValueOnce(new Error("temporary ledger failure"));
    const { judge } = setup({ onUsage });
    expect((await judge(input, context)).status).toBe("verified");
    expect(onUsage).toHaveBeenCalledTimes(8);
    expect(onUsage.mock.calls.map((call) => call[1]?.operationId)).toEqual([
      "run:file-judge:calibration:paraphrase",
      "run:file-judge:calibration:paraphrase",
      "run:file-judge:calibration:omission",
      "run:file-judge:calibration:contradiction",
      "run:file-judge:calibration:missing-support",
      "run:file-judge:calibration:partial-support",
      "run:file-judge:calibration:instruction-in-evidence",
      "receipt:file-judge:3:report-complete",
    ]);
  });

  it("treats permanent usage or calibration persistence failure as unknown", async () => {
    for (const failure of ["onUsage", "onCalibration"] as const) {
      const { judge } = setup({
        [failure]: async () => {
          throw new Error("offline persistence failure");
        },
      });
      expect((await judge(input, context)).status).toBe("unknown");
    }
  });

  it("shares reservations and measured tokens across calibration and all judgments", async () => {
    const { judge, runtime } = setup({ budget: { maxTotalTokens: 2_699, timeoutMs: 5_000 } });
    expect((await judge(input, context)).reason).toBe("judge_budget_exceeded");
    expect(runtime.requests).toHaveLength(7);
    expect((await judge.calibrate(context)).status).toBe("verified");
  });

  it("times out even if a runtime never finishes", async () => {
    const { judge, runtime } = setup({ budget: { maxTotalTokens: 40_000, timeoutMs: 20 } });
    runtime.mode = "hanging";
    const abort = vi.spyOn(runtime, "abort");
    expect((await judge(input, context)).status).toBe("unknown");
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not truncate long evidence and declare it verified", async () => {
    const { judge, runtime } = setup();
    const judged = await judge(
      { ...input, evidence: [{ ...evidence[0]!, text: "x".repeat(100_000) }] },
      context,
    );
    expect(judged).toMatchObject({ status: "unknown", reason: "content_too_large" });
    expect(runtime.requests).toHaveLength(6);
  });
});
