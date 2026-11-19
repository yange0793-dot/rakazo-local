import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
  ScriptedTurn,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  FILE_DELIVERY_OUTPUT_CONTRACT,
  FILE_DELIVERY_PLAYBOOKS,
  FILE_DELIVERY_SCRIPTED_REPLIES,
  fileDeliveryFixtures,
} from "./fixtures/work-improvement.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";
import type { WorkImprovementComparison, WorkImprovementInput } from "./work-improvement.js";
import {
  compareWorkImprovement,
  summarizeWorkImprovementHistory,
  workImprovementOutputJsonSchema,
} from "./work-improvement.js";

type Arm = "baseline" | "candidate";
type Tool = NonNullable<ScriptedTurn["toolCalls"]>[number];
type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

function comparisonInput(): WorkImprovementInput {
  return {
    comparisonId: "synthetic-comparison",
    caseSet: { id: "synthetic-file-delivery", revision: "1" },
    source: {
      runId: "synthetic-source-run",
      project: "project-alpha",
      family: "file-delivery",
      receipt: { schemaVersion: "receipt.v1", status: "needs_evidence" },
      correction: { messageId: "synthetic-correction", text: "Check the full installed tree." },
    },
    baseline: structuredClone(FILE_DELIVERY_PLAYBOOKS.baseline),
    candidate: structuredClone(FILE_DELIVERY_PLAYBOOKS.candidate),
    improverRevision: {
      revision: "proposal-strategy.v1",
      strategy: "Try a distinguishing case pair.",
    },
    execution: {
      model: { provider: "scripted", id: "scripted", maxTokens: 512 },
      route: "offline-fixed-route",
      budget: { maxToolCalls: 16, maxTotalTokens: 20_000, timeoutMs: 2_000 },
    },
    outputContract: structuredClone(FILE_DELIVERY_OUTPUT_CONTRACT),
    cases: fileDeliveryFixtures(),
  };
}

/**
 * Replays independently authored transcripts using the existing ScriptedRuntime.
 * It gets public task/playbook data, never expected answers or case scoring metadata.
 * callbackTools also exercises the executeTool transport used by a model runtime.
 */
class DeliveryReplayRuntime implements AgentRuntime {
  private readonly scripted = new ScriptedAgentRuntime();
  private readonly taskIds = new Map(
    fileDeliveryFixtures().map((fixture) => [fixture.input.task, fixture.id]),
  );
  readonly requests: AgentRunRequest[] = [];
  readonly received: Array<{ runId: string; name: string; result: AgentToolExecutionResult }> = [];
  readonly aborted: string[] = [];
  callbackTools = false;
  producerUsage = false;
  observeCalls = false;
  useCallIds = true;
  secondModelCall = false;
  outputFor = (arm: Arm, id: string): string =>
    JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES[arm][id]);
  toolsFor = (_arm: Arm, id: string): Tool[] => {
    const reads: Tool[] = [
      { name: "list_files", args: { path: "" } },
      { name: "read_file", args: { path: "request.json" } },
      { name: "read_file", args: { path: "manifest.json" } },
    ];
    if (id !== "exception") {
      reads.push(
        { name: "read_file", args: { path: "installed-files.json" } },
        { name: "read_file", args: { path: "selection-receipt.json" } },
      );
      if (id !== "selected")
        reads.push({ name: "read_file", args: { path: "upload-receipt.json" } });
      if (id !== "partial") reads.push({ name: "list_files", args: { path: "installed" } });
    }
    return reads;
  };
  failureFor = (_arm: Arm, _id: string): Error | null => null;
  usageFor = (_arm: Arm, _id: string, event: UsageEvent): UsageEvent | null => event;

  describe() {
    return {
      ...this.scripted.describe(),
      id: "offline-delivery-replay",
      capabilities: {
        ...this.scripted.describe().capabilities,
        scripted: !this.callbackTools,
      },
    };
  }

  async abort(runId: string) {
    this.aborted.push(runId);
    await this.scripted.abort(runId);
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    this.requests.push(request);
    const publicTask = JSON.parse(request.prompt) as { task: string };
    const id = this.taskIds.get(publicTask.task);
    if (!id) throw new Error("Unknown replay task");
    const publicInstructions = JSON.parse(request.instructions.split("\n").at(-1)!) as {
      playbook: WorkImprovementInput["baseline"]["playbook"];
    };
    const arm: Arm =
      publicInstructions.playbook.howToCheck ===
      FILE_DELIVERY_PLAYBOOKS.baseline.playbook.howToCheck
        ? "baseline"
        : "candidate";
    const failure = this.failureFor(arm, id);
    if (failure) throw failure;
    const callId = `${request.runId}:model-call`;
    const observer = request.model.callObserver!;
    const call = {
      callId: this.useCallIds ? callId : undefined,
      runId: request.runId,
      provider: request.model.provider,
      modelId: request.model.id,
      inputTokensEstimate: 12,
      maxOutputTokens: request.model.maxTokens!,
    };
    const reservation = this.observeCalls ? await observer.beforeCall(call) : undefined;
    const script: ScriptedTurn[] = [
      { toolCalls: this.toolsFor(arm, id) },
      { assistant: this.outputFor(arm, id), complete: true },
    ];
    for await (let event of this.scripted.run({ ...request, script }, context)) {
      if (event.type === "tool" && this.callbackTools) {
        // The callback result is really returned to the runtime, not synthesized from truth.
        const result = (await request.executeTool!(
          event.name,
          event.args,
          event.executionId,
        )) as AgentToolExecutionResult;
        this.received.push({ runId: request.runId, name: event.name, result });
      }
      if (event.type === "usage") {
        const usage = this.usageFor(arm, id, {
          ...event,
          callId: this.useCallIds ? callId : undefined,
        });
        if (!usage) continue;
        if (reservation !== undefined) {
          await observer.onRequestId?.(reservation, `synthetic-request-${callId}`);
          await observer.afterCall(reservation, usage);
        }
        if (this.producerUsage) await request.onUsage!(usage);
        if (this.secondModelCall)
          await observer.beforeCall({ ...call, callId: `${callId}:second` });
        event = { ...usage, ...(this.producerUsage ? { accounted: true } : {}) };
      }
      yield event;
    }
  }
}

function caseResult(artifact: WorkImprovementComparison, id: string) {
  return artifact.cases.find((fixture) => fixture.id === id)!;
}

describe("isolated work improvement comparison", () => {
  it("runs nine paired snapshots, grades observable JSON, and recommends the candidate", async () => {
    const input = comparisonInput();
    const runtime = new DeliveryReplayRuntime();
    const artifact = await compareWorkImprovement(input, { runtime });

    expect(artifact.decision).toBe("adopt");
    expect(artifact.retainedRevision).toBe(input.candidate.revision);
    expect(artifact.execution.kind).toBe("scripted");
    expect(artifact.scorerVersion).toBe("work-improvement.scorer.v3");
    expect(artifact.summary.baseline).toMatchObject({
      runs: 9,
      passed: 5,
      failed: 4,
      unknown: 0,
      falsePositiveCompletions: 4,
      totalTokens: 468,
      costUsd: null,
    });
    expect(artifact.summary.candidate).toMatchObject({
      runs: 9,
      passed: 9,
      failed: 0,
      unknown: 0,
      falsePositiveCompletions: 0,
      totalTokens: 468,
      costUsd: null,
    });
    expect(artifact.summary.improvements).toEqual(["stale", "selected", "partial", "unapproved"]);
    expect(artifact.summary.protectedCases).toEqual({ correct: 5, total: 5 });
    expect(artifact.summary.holdoutCases).toEqual({ correct: 7, total: 7 });
    expect(artifact.coverage.families[0]).toMatchObject({
      sufficient: true,
      independentCases: 9,
      crossProjectExceptions: 1,
      categories: { success: 2, failure: 4, insufficient_evidence: 2, scope_exception: 1 },
    });
    expect(runtime.requests).toHaveLength(18);
    expect(
      new Set(
        artifact.cases.flatMap((fixture) => [
          fixture.baseline.workspaceId,
          fixture.candidate.workspaceId,
        ]),
      ).size,
    ).toBe(18);
    expect(new Set(runtime.requests.map((request) => request.runId)).size).toBe(18);
    expect(runtime.requests.every((request) => request.history.length === 0)).toBe(true);
    expect(runtime.requests.every((request) => request.model.maxTokens === 512)).toBe(true);
    expect(runtime.requests.every((request) => request.fallbackModels === undefined)).toBe(true);
    expect(
      runtime.requests.every(
        (request) => request.tools.map((tool) => tool.name).join(",") === "read_file,list_files",
      ),
    ).toBe(true);

    const stale = caseResult(artifact, "stale");
    const enumerated = stale.candidate.tools.find(
      (call) => call.name === "list_files" && (call.args as { path: string }).path === "installed",
    )!;
    expect(enumerated.status).toBe("succeeded");
    expect(enumerated.result).toMatchObject({
      recursive: true,
      files: expect.arrayContaining([
        expect.objectContaining({ path: "installed/legacy/old.txt" }),
      ]),
    });
    const manifestRead = stale.candidate.tools.find(
      (call) =>
        call.name === "read_file" && (call.args as { path: string }).path === "manifest.json",
    )!;
    expect(manifestRead.result).toMatchObject({
      content: input.cases[1]!.input.materials["manifest.json"],
    });
    expect(stale.baseline.tools).not.toBe(stale.candidate.tools);
    expect(stale.baseline.score.mismatches).toEqual([
      "outcome",
      "checks.directory",
      "observations.unexpected_files",
    ]);
    expect(
      artifact.cases.every(
        (fixture) => fixture.baseline.durationMs >= 0 && fixture.candidate.durationMs >= 0,
      ),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });

  it("returns real isolated read results through the model executeTool interface", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.callbackTools = true;
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });

    expect(artifact.decision).toBe("adopt");
    expect(artifact.execution.kind).toBe("model");
    expect(runtime.received).toHaveLength(
      artifact.summary.baseline.toolCalls + artifact.summary.candidate.toolCalls,
    );
    const stale = caseResult(artifact, "stale");
    const received = runtime.received.find(
      (call) => call.runId === stale.candidate.runId && call.name === "read_file",
    )!;
    expect(received.result.kind).toBe("agent_tool_result");
    expect(
      JSON.parse(
        received.result.content[0]!.type === "text" ? received.result.content[0]!.text : "",
      ),
    ).toEqual(received.result.details);
    expect(received.result.details).toMatchObject({
      path: "request.json",
      sizeBytes: expect.any(Number),
      sha256: expect.any(String),
    });
  });

  it.each(["cumulative", "absent"] as const)(
    "keeps the final assistant stream with %s done text",
    async (kind) => {
      const replay = new DeliveryReplayRuntime();
      replay.callbackTools = true;
      const narration = "I'll start by discovering the snapshot contents.\n\n";
      const runtime: AgentRuntime = {
        describe: () => replay.describe(),
        abort: (id) => replay.abort(id),
        async *run(request, context) {
          yield { type: "text", text: narration };
          for await (const event of replay.run(request, context)) {
            if (event.type === "text") continue;
            if (event.type !== "done") {
              yield event;
              continue;
            }
            const text = event.text!;
            const split = Math.floor(text.length / 2);
            yield { type: "turn" };
            yield { type: "text", text: text.slice(0, split) };
            yield { type: "text", text: text.slice(split) };
            yield { ...event, text: kind === "cumulative" ? narration + text : undefined };
          }
        },
      };
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      const stale = caseResult(artifact, "stale");
      expect(stale.candidate.outputText).toBe(
        JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale),
      );
      expect(stale.candidate.output).toEqual(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale);
      expect(stale.candidate.errors).toEqual([]);
      expect(stale.baseline.score.verdict).toBe("fail");
      expect(stale.baseline.score.mismatches).toEqual([
        "outcome",
        "checks.directory",
        "observations.unexpected_files",
      ]);
      expect(artifact.summary.baseline).toMatchObject({ failed: 4, unknown: 0 });
      expect(artifact.summary.candidate).toMatchObject({ passed: 9, unknown: 0 });
    },
  );

  it.each(["empty", "prose", "fenced prose"] as const)(
    "does not recover an %s final message from an earlier JSON in done text",
    async (kind) => {
      const replay = new DeliveryReplayRuntime();
      const runtime: AgentRuntime = {
        describe: () => replay.describe(),
        abort: (id) => replay.abort(id),
        async *run(request, context) {
          for await (const event of replay.run(request, context)) {
            if (event.type === "text") continue;
            if (event.type !== "done") {
              yield event;
              continue;
            }
            yield { type: "text", text: event.text! };
            yield { type: "turn" };
            if (kind !== "empty")
              yield {
                type: "text",
                text:
                  kind === "prose"
                    ? `Here is the result.\n${event.text}`
                    : `Here is the result.\n\`\`\`json\n${event.text}\n\`\`\``,
              };
            yield event;
          }
        },
      };
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      const run = caseResult(artifact, "clean").candidate;
      expect(run.finished).toBe(true);
      expect(run.output).toBeNull();
      if (kind === "empty") expect(run.outputText).toBe("");
      expect(run.score.verdict).toBe("unknown");
      expect(run.errors.map((error) => error.code)).toContain("invalid_output");
      expect(artifact.decision).toBe("inconclusive");
    },
  );

  it("accepts strict JSON from a done-only runtime without text events", async () => {
    const replay = new DeliveryReplayRuntime();
    const runtime: AgentRuntime = {
      describe: () => ({
        ...replay.describe(),
        capabilities: { ...replay.describe().capabilities, streaming: false },
      }),
      abort: (id) => replay.abort(id),
      async *run(request, context) {
        for await (const event of replay.run(request, context))
          if (event.type !== "text") yield event;
      },
    };
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(caseResult(artifact, "clean").candidate.output).toEqual(
      FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean,
    );
    expect(artifact.summary.baseline).toMatchObject({ failed: 4, unknown: 0 });
    expect(artifact.summary.candidate).toMatchObject({ passed: 9, unknown: 0 });
    expect(artifact.decision).toBe("adopt");
  });

  it("never sends truth, split, source correction, or improver instructions to the model", async () => {
    const input = comparisonInput();
    input.source.correction!.text = "SOURCE_CORRECTION_SENTINEL";
    input.improverRevision!.strategy = "IMPROVER_STRATEGY_SENTINEL";
    const oraclePath = "cache/OUTER_ORACLE_SENTINEL.log";
    const held = input.cases.find((fixture) => fixture.id === "unapproved")!;
    held.input.materials[`installed/${oraclePath}`] = "Synthetic held-out bytes";
    held.expected.observations.unexpected_files = ["cache/legacy.log", oraclePath];
    const runtime = new DeliveryReplayRuntime();
    await compareWorkImprovement(input, { runtime });

    for (const request of runtime.requests) {
      const sent = JSON.stringify({
        prompt: request.prompt,
        instructions: request.instructions,
        history: request.history,
        tools: request.tools,
      });
      expect(sent).not.toContain("OUTER_ORACLE_SENTINEL");
      expect(sent).not.toContain("SOURCE_CORRECTION_SENTINEL");
      expect(sent).not.toContain("IMPROVER_STRATEGY_SENTINEL");
      expect(sent).not.toContain('"expected"');
      expect(sent).not.toContain('"holdout"');
      expect(sent).not.toContain('"requiredSteps"');
      expect(sent).not.toContain('"protection"');
      const task = JSON.parse(request.prompt) as { task: string };
      expect(task.task).not.toContain("delivery stale");
      expect(task.task).not.toContain("delivery selected");
      expect(task.task).not.toContain("delivery partial");
    }
    const schema = workImprovementOutputJsonSchema(input.outputContract);
    expect(schema).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(schema)).not.toContain(oraclePath);
  });

  it("grades genuine insufficient evidence as correct while keeping installation and upload separate", async () => {
    const artifact = await compareWorkImprovement(comparisonInput(), {
      runtime: new DeliveryReplayRuntime(),
    });
    const selected = caseResult(artifact, "selected").candidate;
    const partial = caseResult(artifact, "partial").candidate;
    expect(selected.score.verdict).toBe("pass");
    expect(selected.output).toMatchObject({
      outcome: "unknown",
      checks: { installation: "pass", directory: "pass", upload: "unknown" },
    });
    expect(
      selected.tools.some((call) => (call.args as { path: string }).path === "upload-receipt.json"),
    ).toBe(false);
    expect(partial.score.verdict).toBe("pass");
    expect(partial.output).toMatchObject({ checks: { directory: "unknown", upload: "pass" } });
    expect(partial.tools.some((call) => (call.args as { path: string }).path === "installed")).toBe(
      false,
    );
  });

  it("passes an answer the case also accepts and scores other answers against the closest one", async () => {
    const failedUpload = {
      outcome: "failed" as const,
      checks: {
        installation: "pass" as const,
        directory: "pass" as const,
        upload: "fail" as const,
      },
    };
    const input = comparisonInput();
    const selectedCase = input.cases.find((fixture) => fixture.id === "selected")!;
    selectedCase.alsoAccepted = [{ ...selectedCase.expected, ...failedUpload }];
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) =>
      id !== "selected"
        ? original(arm, id)
        : JSON.stringify({
            ...FILE_DELIVERY_SCRIPTED_REPLIES.candidate.selected,
            ...(arm === "candidate"
              ? failedUpload
              : { outcome: "failed", checks: { ...failedUpload.checks, directory: "fail" } }),
          });
    const selected = caseResult(await compareWorkImprovement(input, { runtime }), "selected");
    expect(selected.candidate.score).toMatchObject({ verdict: "pass", mismatches: [] });
    expect(selected.baseline.score).toMatchObject({
      verdict: "fail",
      mismatches: ["checks.directory"],
    });

    selectedCase.alsoAccepted = [{ ...selectedCase.expected, outcome: "complete" }];
    await expect(compareWorkImprovement(input, { runtime })).rejects.toThrow(
      "Accepted answers must agree on whether the work is complete.",
    );
  });

  it("accepts a successful recursive root listing as evidence for the installed tree", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.callbackTools = true;
    const original = runtime.toolsFor;
    runtime.toolsFor = (arm, id) =>
      original(arm, id).filter(
        (call) => !(call.name === "list_files" && call.args.path === "installed"),
      );
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "stale").candidate;
    const listings = run.tools.filter((call) => call.name === "list_files");
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      args: { path: "" },
      status: "succeeded",
      result: {
        recursive: true,
        files: expect.arrayContaining([
          expect.objectContaining({ path: "installed/legacy/old.txt" }),
        ]),
      },
    });
    expect(run.output).toEqual(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale);
    expect(run.score.verdict).toBe("pass");
    expect(run.score.missingSteps).toEqual([]);
    expect(run.errors).toEqual([]);
    expect(artifact.summary.baseline).toMatchObject({ failed: 4, unknown: 0 });
    expect(artifact.summary.candidate).toMatchObject({ passed: 9, unknown: 0 });
    expect(artifact.decision).toBe("adopt");
  });

  it.each(["missing", "descendant"] as const)(
    "marks %s directory evidence as a failure even when the scripted JSON matches truth",
    async (kind) => {
      const runtime = new DeliveryReplayRuntime();
      const original = runtime.toolsFor;
      runtime.toolsFor = (arm, id) => {
        if (arm !== "candidate" || id !== "stale") return original(arm, id);
        const reads = original(arm, id).filter((call) => call.name !== "list_files");
        return kind === "missing"
          ? reads
          : [{ name: "list_files", args: { path: "installed/legacy" } }, ...reads];
      };
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      const run = caseResult(artifact, "stale").candidate;
      expect(run.output).toEqual(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale);
      expect(run.score.verdict).toBe("fail");
      expect(run.score.missingSteps).toEqual([
        { tool: "list_files", path: "" },
        { tool: "list_files", path: "installed" },
      ]);
      expect(run.errors).toEqual([]);
      // The baseline fails this diagnostic case too, so it is no regression; it is just not fixed.
      expect(artifact.summary.improvements).not.toContain("stale");
      expect(artifact.summary.regressions).toEqual([]);
    },
  );

  it("does not count recursive file metadata as a required file content read", async () => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.toolsFor;
    runtime.toolsFor = (arm, id) =>
      arm === "candidate" && id === "stale"
        ? original(arm, id).filter(
            (call) => !(call.name === "read_file" && call.args.path === "manifest.json"),
          )
        : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "stale").candidate;
    expect(run.output).toEqual(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale);
    expect(run.score.verdict).toBe("fail");
    expect(run.score.missingSteps).toEqual([{ tool: "read_file", path: "manifest.json" }]);
    expect(run.errors).toEqual([]);
    expect(artifact.summary.improvements).not.toContain("stale");
  });

  it("rejects a single false positive completion even when other cases improve", async () => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) =>
      arm === "candidate" && id === "stale"
        ? JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES.baseline.stale)
        : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.summary.improvements).toHaveLength(3);
    expect(artifact.summary.candidate.falsePositiveCompletions).toBe(1);
    expect(artifact.decision).toBe("reject");
    expect(artifact.reasons).toContain("false_positive_completion");
  });

  it("rejects the always-unknown candidate on protected successes", async () => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) =>
      arm === "candidate"
        ? JSON.stringify({
            schemaVersion: "work-improvement.output.v1",
            outcome: "unknown",
            checks: { installation: "unknown", directory: "unknown", upload: "unknown" },
            observations: {
              missing_files: [],
              unexpected_files: [],
              hash_mismatches: [],
              excluded_runtime_files: [],
            },
          })
        : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(caseResult(artifact, "clean").candidate.score.verdict).toBe("fail");
    expect(artifact.summary.regressions).toContain("clean");
    expect(artifact.decision).toBe("reject");
    expect(artifact.reasons).toContain("protected_case_failed");
  });

  it("rejects a new structured error in a holdout even without a false completion", async () => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) => {
      if (arm !== "candidate" || id !== "mismatch") return original(arm, id);
      const value = structuredClone(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.mismatch!);
      value.observations.hash_mismatches = ["data/settings.json"];
      return JSON.stringify(value);
    };
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.summary.candidate.falsePositiveCompletions).toBe(0);
    expect(artifact.decision).toBe("reject");
    expect(artifact.reasons).toContain("holdout_case_failed");
    expect(artifact.summary.regressions).toContain("mismatch");
  });

  it("keeps the old revision on a tie", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.outputFor = (_arm, id) => JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES.candidate[id]);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.summary.baseline.passed).toBe(9);
    expect(artifact.summary.candidate.passed).toBe(9);
    expect(artifact.decision).toBe("reject");
    expect(artifact.reasons).toEqual(["no_improvement"]);
    expect(artifact.retainedRevision).toBe(FILE_DELIVERY_PLAYBOOKS.baseline.revision);
  });

  it("denies tool calls beyond the exact per-run budget and retains partial evidence", async () => {
    const input = comparisonInput();
    input.execution.budget.maxToolCalls = 3;
    const artifact = await compareWorkImprovement(input, { runtime: new DeliveryReplayRuntime() });
    const run = caseResult(artifact, "stale").candidate;
    expect(run.tools.filter((call) => call.status === "succeeded")).toHaveLength(3);
    expect(run.tools).toHaveLength(4);
    expect(run.tools.at(-1)).toMatchObject({
      status: "denied",
      error: { code: "tool_budget_exhausted" },
    });
    expect(run.score.verdict).toBe("unknown");
    expect(artifact.summary.candidate.totalTokens).toBeNull();
    expect(artifact.decision).toBe("inconclusive");
  });

  it("permits a complete run exactly within its token budget and rejects overspend as unknown", async () => {
    const exact = comparisonInput();
    exact.execution.budget.maxTotalTokens = 52;
    const complete = await compareWorkImprovement(exact, { runtime: new DeliveryReplayRuntime() });
    expect(complete.decision).toBe("adopt");
    const limited = comparisonInput();
    limited.execution.budget.maxTotalTokens = 51;
    const partial = await compareWorkImprovement(limited, { runtime: new DeliveryReplayRuntime() });
    expect(partial.decision).toBe("inconclusive");
    expect(partial.cases.every((fixture) => fixture.candidate.score.verdict === "unknown")).toBe(
      true,
    );
    expect(caseResult(partial, "clean").candidate.errors.map((error) => error.code)).toContain(
      "token_budget_exhausted",
    );
    expect(partial.summary.candidate.knownTotalTokens).toBe(468);
    expect(partial.summary.candidate.totalTokens).toBeNull();
  });

  it.each(["maxToolCalls", "maxTotalTokens", "timeoutMs"] as const)(
    "returns a serializable unknown artifact for an initially exhausted %s budget",
    async (key) => {
      const input = comparisonInput();
      input.execution.budget[key] = 0;
      const runtime = new DeliveryReplayRuntime();
      let starts = 0;
      const observed: AgentRuntime = {
        describe: () => runtime.describe(),
        abort: (id) => runtime.abort(id),
        run: (request, context) => {
          starts++;
          return runtime.run(request, context);
        },
      };
      const artifact = await compareWorkImprovement(input, { runtime: observed });
      expect(starts).toBe(0);
      expect(runtime.requests).toHaveLength(0);
      expect(artifact.decision).toBe("inconclusive");
      expect(artifact.summary.candidate).toMatchObject({
        passed: 0,
        unknown: 9,
        totalTokens: null,
      });
      expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    },
  );

  it("accounts producer and observer receipts once and preserves upstream spending hooks", async () => {
    const input = comparisonInput();
    const upstream: string[] = [];
    input.execution.model.callObserver = {
      beforeCall: (call) => {
        upstream.push(`before:${call.callId}`);
        return `external:${call.callId}`;
      },
      afterCall: (id) => {
        upstream.push(`after:${id}`);
      },
      onRequestId: (id) => {
        upstream.push(`request:${id}`);
      },
    };
    const runtime = new DeliveryReplayRuntime();
    runtime.observeCalls = true;
    runtime.producerUsage = true;
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(artifact.decision).toBe("adopt");
    expect(upstream.filter((entry) => entry.startsWith("before:"))).toHaveLength(18);
    expect(upstream.filter((entry) => entry.startsWith("after:"))).toHaveLength(18);
    expect(upstream.filter((entry) => entry.startsWith("request:"))).toHaveLength(18);
    expect(
      artifact.cases.every(
        (fixture) => fixture.baseline.usage.length === 1 && fixture.candidate.usage.length === 1,
      ),
    ).toBe(true);
    expect(artifact.summary.candidate.totalTokens).toBe(468);
  });

  it("blocks the next model call before it can exceed the remaining token budget", async () => {
    const input = comparisonInput();
    input.execution.model.maxTokens = 64;
    input.execution.budget.maxTotalTokens = 80;
    const runtime = new DeliveryReplayRuntime();
    runtime.observeCalls = true;
    runtime.secondModelCall = true;
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(artifact.decision).toBe("inconclusive");
    expect(caseResult(artifact, "clean").candidate.errors.map((error) => error.code)).toContain(
      "token_budget_exhausted",
    );
    expect(artifact.summary.candidate.knownTotalTokens).toBe(468);
    expect(artifact.cases.every((fixture) => fixture.candidate.usage.length === 1)).toBe(true);
  });

  it("accounts anonymous observer and producer receipts without inventing extra token usage", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.observeCalls = true;
    runtime.producerUsage = true;
    runtime.useCallIds = false;
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.decision).toBe("adopt");
    expect(artifact.summary.candidate.totalTokens).toBe(468);
    expect(artifact.cases.every((fixture) => fixture.candidate.usage.length === 1)).toBe(true);
    expect(caseResult(artifact, "clean").candidate.usage[0]!.callId).toBeNull();
  });

  it("retains reported cost and pricing attribution without charging the same receipt twice", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.observeCalls = true;
    runtime.producerUsage = true;
    runtime.usageFor = (_arm, _id, event) => ({
      ...event,
      costUsd: 0.002,
      costSource: "synthetic-receipt",
      pricingVersion: "synthetic-pricing.v1",
    });
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.summary.candidate.costUsd).toBeCloseTo(0.018);
    expect(caseResult(artifact, "clean").candidate.usage[0]).toMatchObject({
      costUsd: 0.002,
      costSource: "synthetic-receipt",
      pricingVersion: "synthetic-pricing.v1",
    });
  });

  it("keeps a caught upstream authorization error unknown even if the runtime tries to continue", async () => {
    const input = comparisonInput();
    input.execution.model.callObserver = {
      beforeCall: () => {
        throw new Error("Synthetic upstream authorization failure");
      },
      afterCall: () => {},
    };
    const replay = new DeliveryReplayRuntime();
    const runtime: AgentRuntime = {
      describe: () => replay.describe(),
      abort: (id) => replay.abort(id),
      async *run(request, context) {
        try {
          await request.model.callObserver!.beforeCall({
            provider: request.model.provider,
            modelId: request.model.id,
            inputTokensEstimate: 12,
            maxOutputTokens: 40,
          });
        } catch {
          // Exercise an upstream runtime which catches a failed call and keeps producing events.
        }
        yield* replay.run(request, context);
      },
    };
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(artifact.decision).toBe("inconclusive");
    expect(caseResult(artifact, "clean").candidate.errors).toContainEqual({
      code: "upstream_error",
      message: "Synthetic upstream authorization failure",
    });
    expect(artifact.summary.candidate.passed).toBe(0);
  });

  it("records tool requests without treating unexecuted runtime events as evidence", async () => {
    const replay = new DeliveryReplayRuntime();
    const runtime: AgentRuntime = {
      describe: () => ({
        ...replay.describe(),
        capabilities: { ...replay.describe().capabilities, scripted: false },
      }),
      run: (request, context) => replay.run(request, context),
      abort: (id) => replay.abort(id),
    };
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "clean").candidate;
    expect(run.toolRequests).toHaveLength(7);
    expect(run.tools).toHaveLength(0);
    expect(run.score.verdict).toBe("unknown");
    expect(run.errors.map((error) => error.code)).toContain("runtime_protocol_error");
    expect(artifact.decision).toBe("inconclusive");
  });

  it.each(["missing", "unknown"] as const)(
    "does not count %s usage as a free successful run",
    async (kind) => {
      const runtime = new DeliveryReplayRuntime();
      runtime.usageFor = (_arm, _id, event) =>
        kind === "missing"
          ? null
          : {
              ...event,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              totalTokens: null,
            };
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      expect(artifact.decision).toBe("inconclusive");
      expect(artifact.summary.candidate.passed).toBe(0);
      expect(artifact.summary.candidate.totalTokens).toBeNull();
      expect(caseResult(artifact, "clean").candidate.errors.map((error) => error.code)).toContain(
        "missing_usage",
      );
    },
  );

  it("judges a run whose provider omits a cache bucket, reporting its total as unknown", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.observeCalls = true;
    runtime.usageFor = (_arm, _id, event) => ({
      ...event,
      inputTokens: 12,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: null,
      totalTokens: null,
    });
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "clean").candidate;
    expect(run.finished).toBe(true);
    expect(run.output).not.toBeNull();
    expect(run.tools.length).toBeGreaterThan(0);
    expect(run.errors).toEqual([]);
    expect(run.score.verdict).toBe("pass");
    expect(run.usage[0]).toMatchObject({ cacheWriteTokens: null, totalTokens: null });
    expect(artifact.decision).toBe("adopt");
    expect(artifact.summary.candidate.totalTokens).toBeNull();
    expect(artifact.summary.candidate.knownTotalTokens).toBe(9 * 62);
  });

  it("charges an unmeasured call its estimated input and reported output against the budget", async () => {
    const usage = (runtime: DeliveryReplayRuntime) => {
      runtime.observeCalls = true;
      runtime.usageFor = (_arm, _id, event) => ({
        ...event,
        inputTokens: 12,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: null,
        totalTokens: null,
      });
      return runtime;
    };
    // First call: 12 + 10 reported input with 40 output = 62. The next reserves 12 + 64 = 76.
    const codes = async (maxTotalTokens: number) => {
      const input = comparisonInput();
      input.execution.model.maxTokens = 64;
      input.execution.budget.maxTotalTokens = maxTotalTokens;
      const runtime = usage(new DeliveryReplayRuntime());
      runtime.secondModelCall = true;
      const artifact = await compareWorkImprovement(input, { runtime });
      return caseResult(artifact, "clean").candidate.errors.map((error) => error.code);
    };
    expect(await codes(138)).not.toContain("token_budget_exhausted");
    expect(await codes(137)).toContain("token_budget_exhausted");
  });

  it("returns an unknown run artifact for an upstream error without discarding other pairs", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.failureFor = (arm, id) =>
      arm === "candidate" && id === "clean" ? new Error("Synthetic upstream failure") : null;
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.cases).toHaveLength(9);
    expect(caseResult(artifact, "clean").candidate.score.verdict).toBe("unknown");
    expect(caseResult(artifact, "clean").candidate.errors).toContainEqual({
      code: "upstream_error",
      message: "Synthetic upstream failure",
    });
    expect(caseResult(artifact, "stale").candidate.score.verdict).toBe("pass");
    expect(artifact.decision).toBe("inconclusive");
  });

  it("gives an arm one fresh try after an upstream failure and keeps the first try's cost", async () => {
    const runtime = new DeliveryReplayRuntime();
    let failed = false;
    runtime.failureFor = (arm, id) => {
      if (arm !== "candidate" || id !== "clean" || failed) return null;
      failed = true;
      return new Error("Synthetic upstream failure");
    };
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "clean").candidate;
    expect(run.score.verdict).toBe("pass");
    expect(run.previousAttempt?.errors.map((error) => error.code)).toContain("upstream_error");
    expect(run.previousAttempt?.workspaceId).not.toBe(run.workspaceId);
    expect(artifact.decision).toBe("adopt");
  });

  it("gives an arm one fresh try after an answer wrapped in prose, then leaves it unknown", async () => {
    const wrapped = (always: boolean) => {
      const runtime = new DeliveryReplayRuntime();
      const original = runtime.outputFor;
      let seen = 0;
      runtime.outputFor = (arm, id) =>
        arm === "candidate" && id === "clean" && (always || seen++ === 0)
          ? `Here is the result.\n${original(arm, id)}`
          : original(arm, id);
      return runtime;
    };
    const recovered = await compareWorkImprovement(comparisonInput(), { runtime: wrapped(false) });
    const run = caseResult(recovered, "clean").candidate;
    expect(run.score.verdict).toBe("pass");
    expect(run.previousAttempt?.errors.map((error) => error.code)).toEqual(["invalid_output"]);
    expect(recovered.decision).toBe("adopt");
    const stuck = await compareWorkImprovement(comparisonInput(), { runtime: wrapped(true) });
    expect(caseResult(stuck, "clean").candidate.score.verdict).toBe("unknown");
    expect(stuck.decision).toBe("inconclusive");
  });

  it("records a provider/model change as unknown", async () => {
    const runtime = new DeliveryReplayRuntime();
    runtime.usageFor = (arm, id, usage) =>
      arm === "candidate" && id === "clean"
        ? { ...usage, provider: "other-route", model: "other-model" }
        : usage;
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(artifact.execution.route).toBe("offline-fixed-route");
    expect(caseResult(artifact, "clean").candidate.usage[0]).toMatchObject({
      provider: "other-route",
      model: "other-model",
    });
    expect(caseResult(artifact, "clean").candidate.errors.map((error) => error.code)).toContain(
      "model_mismatch",
    );
    expect(artifact.decision).toBe("inconclusive");
  });

  it.each(["```json\n", "```\n", "\n```json  \n"])(
    "reads a final message that is only the object inside one code fence (%j)",
    async (open) => {
      const runtime = new DeliveryReplayRuntime();
      const original = runtime.outputFor;
      runtime.outputFor = (arm, id) =>
        arm === "candidate" && id === "clean"
          ? `${open}${original(arm, id)}\n\`\`\`\n`
          : original(arm, id);
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      const run = caseResult(artifact, "clean").candidate;
      expect(run.output).toEqual(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean);
      expect(run.score.verdict).toBe("pass");
      expect(artifact.decision).toBe("adopt");
    },
  );

  it.each([
    ["prose", "All checks passed."],
    [
      "fenced with prose",
      `Done.\n\`\`\`json\n${JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean)}\n\`\`\``,
    ],
    [
      "another language fence",
      `\`\`\`yaml\n${JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean)}\n\`\`\``,
    ],
    ["Markdown", "~~~json\n{}\n~~~"],
    [
      "extra field",
      JSON.stringify({
        ...FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean,
        explanation: "Everything is fine.",
      }),
    ],
    [
      "missing check",
      JSON.stringify({
        ...FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean,
        checks: { installation: "pass" },
      }),
    ],
    [
      "extra check",
      JSON.stringify({
        ...FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean,
        checks: { installation: "pass", directory: "pass", upload: "pass", invented: "pass" },
      }),
    ],
    [
      "duplicate observation",
      JSON.stringify({
        ...FILE_DELIVERY_SCRIPTED_REPLIES.candidate.clean,
        observations: {
          missing_files: [],
          unexpected_files: ["a", "a"],
          hash_mismatches: [],
          excluded_runtime_files: [],
        },
      }),
    ],
  ])("requires strict structured output for %s", async (_kind, text) => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) =>
      arm === "candidate" && id === "clean" ? text : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    const run = caseResult(artifact, "clean").candidate;
    expect(run.output).toBeNull();
    expect(run.score.verdict).toBe("unknown");
    expect(run.errors.map((error) => error.code)).toContain("invalid_output");
    expect(artifact.decision).toBe("inconclusive");
  });

  it("compares path sets without relying on their order", async () => {
    const input = comparisonInput();
    const stale = input.cases.find((fixture) => fixture.id === "stale")!;
    stale.input.materials["installed/legacy/another.txt"] = "Another synthetic leftover";
    stale.expected.observations.unexpected_files = ["legacy/old.txt", "legacy/another.txt"];
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.outputFor;
    runtime.outputFor = (arm, id) => {
      if (arm !== "candidate" || id !== "stale") return original(arm, id);
      const value = structuredClone(FILE_DELIVERY_SCRIPTED_REPLIES.candidate.stale!);
      value.observations.unexpected_files = ["legacy/another.txt", "legacy/old.txt"];
      return JSON.stringify(value);
    };
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(caseResult(artifact, "stale").candidate.score.verdict).toBe("pass");
    expect(artifact.decision).toBe("adopt");
  });

  it.each([
    "../../host.txt",
    "/host.txt",
    "other/../host.txt",
    "C:\\host.txt",
    "https://example.test/file",
  ])("denies a read outside the canonical snapshot root: %s", async (path) => {
    const runtime = new DeliveryReplayRuntime();
    runtime.callbackTools = true;
    const original = runtime.toolsFor;
    runtime.toolsFor = (arm, id) =>
      arm === "candidate" && id === "clean"
        ? [{ name: "read_file", args: { path } }]
        : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(caseResult(artifact, "clean").candidate.tools[0]).toMatchObject({
      status: "denied",
      error: { code: "invalid_tool_arguments" },
    });
    expect(caseResult(artifact, "clean").candidate.score.verdict).toBe("unknown");
    expect(artifact.decision).toBe("inconclusive");
  });

  it.each(["shell", "write_file", "upload", "web_fetch"])(
    "never executes the external tool %s",
    async (name) => {
      const runtime = new DeliveryReplayRuntime();
      runtime.callbackTools = true;
      const original = runtime.toolsFor;
      runtime.toolsFor = (arm, id) =>
        arm === "candidate" && id === "clean"
          ? [{ name, args: { command: "synthetic-command", path: "file" } }]
          : original(arm, id);
      const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
      expect(caseResult(artifact, "clean").candidate.tools[0]).toMatchObject({
        name,
        status: "denied",
        result: { error: "forbidden_tool" },
      });
      expect(caseResult(artifact, "clean").candidate.score.verdict).toBe("unknown");
      expect(artifact.decision).toBe("inconclusive");
    },
  );

  it("tells the run a path is absent and lets it go on, without counting the read as evidence", async () => {
    const runtime = new DeliveryReplayRuntime();
    const original = runtime.toolsFor;
    runtime.toolsFor = (arm, id) =>
      arm === "candidate" && id === "clean"
        ? [{ name: "read_file", args: { path: "absent.json" } }]
        : original(arm, id);
    const artifact = await compareWorkImprovement(comparisonInput(), { runtime });
    expect(caseResult(artifact, "clean").candidate.tools[0]).toMatchObject({
      status: "error",
      error: { code: "tool_error" },
      result: { error: "not_found" },
    });
    expect(caseResult(artifact, "clean").candidate).toMatchObject({
      finished: true,
      errors: [],
      score: { verdict: "fail", mismatches: [] },
    });
    expect(artifact.decision).toBe("reject");
  });

  it("returns at the deadline even if runtime abort and iterator return never settle", async () => {
    const input = comparisonInput();
    input.execution.budget.timeoutMs = 30;
    const descriptor = new DeliveryReplayRuntime().describe();
    const aborted: string[] = [];
    const runtime: AgentRuntime = {
      describe: () => descriptor,
      abort: (id) => {
        aborted.push(id);
        return new Promise(() => {});
      },
      run: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: () => new Promise(() => {}),
        }),
      }),
    };
    const started = performance.now();
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(aborted).toHaveLength(18);
    expect(artifact.decision).toBe("inconclusive");
    expect(
      artifact.cases.every((fixture) =>
        fixture.candidate.errors.some((error) => error.code === "timeout"),
      ),
    ).toBe(true);
    expect(artifact.summary.candidate.totalTokens).toBeNull();
  });

  it("honors caller cancellation before any runtime starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = new DeliveryReplayRuntime();
    const artifact = await compareWorkImprovement(comparisonInput(), {
      runtime,
      context: { signal: controller.signal },
    });
    expect(runtime.requests).toHaveLength(0);
    expect(artifact.decision).toBe("inconclusive");
    expect(
      artifact.cases.every((fixture) =>
        fixture.candidate.errors.some((error) => error.code === "cancelled"),
      ),
    ).toBe(true);
  });

  it("enforces the deadline on an upstream stream that never yields to timers", async () => {
    const input = comparisonInput();
    input.execution.budget.timeoutMs = 25;
    const descriptor = new DeliveryReplayRuntime().describe();
    const runtime: AgentRuntime = {
      describe: () => descriptor,
      abort: async () => {},
      async *run() {
        while (true) yield { type: "progress", text: "synthetic progress", activity: true };
      },
    };
    const started = performance.now();
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(artifact.decision).toBe("inconclusive");
    expect(
      artifact.cases.every((fixture) =>
        fixture.candidate.errors.some((error) => error.code === "timeout"),
      ),
    ).toBe(true);
  });

  it("runs both arms of a case together and keeps one route's concurrent runs bounded", async () => {
    const input = comparisonInput();
    const replay = new DeliveryReplayRuntime();
    let active = 0;
    let peak = 0;
    let started = 0;
    const runtime: AgentRuntime = {
      describe: () => replay.describe(),
      abort: (id) => replay.abort(id),
      async *run(request, context) {
        started++;
        peak = Math.max(peak, ++active);
        // Let every run of this batch start before any of them finishes.
        await new Promise((resolve) => setTimeout(resolve, 5));
        for await (const event of replay.run(request, context)) {
          // The engine closes a finished iterator without awaiting it, so count the run as over
          // when it reports done rather than when its cleanup happens to execute.
          if (event.type === "done") active--;
          yield event;
        }
      },
    };
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(started).toBe(18);
    expect(peak).toBe(4);
    expect(artifact.decision).toBe("adopt");
  });

  it.each(["small", "duplicate", "no_holdout", "no_protection", "no_cross_project"] as const)(
    "keeps insufficient %s coverage inconclusive with its denominators",
    async (kind) => {
      const input = comparisonInput();
      if (kind === "small") input.cases = input.cases.slice(0, 5);
      if (kind === "duplicate")
        input.cases.push({ ...structuredClone(input.cases[0]!), id: "independent-in-name-only" });
      if (kind === "no_holdout") for (const fixture of input.cases) fixture.split = "diagnostic";
      if (kind === "no_protection") for (const fixture of input.cases) fixture.protection = false;
      if (kind === "no_cross_project")
        for (const fixture of input.cases) fixture.project = input.source.project;
      const artifact = await compareWorkImprovement(input, {
        runtime: new DeliveryReplayRuntime(),
      });
      expect(artifact.coverage.sufficient).toBe(false);
      expect(artifact.coverage.families[0]!.totalCases).toBe(input.cases.length);
      expect(artifact.coverage.families[0]!.independentCases).toBe(
        kind === "duplicate" ? 9 : input.cases.length,
      );
      expect(artifact.decision).toBe("inconclusive");
      expect(artifact.reasons).toContain("inadequate_coverage");
      expect(artifact.retainedRevision).toBe(input.baseline.revision);
    },
  );

  it("requires six cases for every evaluated family", async () => {
    const input = comparisonInput();
    input.cases.push({
      ...structuredClone(input.cases[0]!),
      id: "another-family",
      family: "other-family",
    });
    const artifact = await compareWorkImprovement(input, { runtime: new DeliveryReplayRuntime() });
    expect(artifact.coverage.families).toHaveLength(2);
    expect(
      artifact.coverage.families.find((family) => family.family === "other-family"),
    ).toMatchObject({
      independentCases: 1,
      sufficient: false,
    });
    expect(artifact.decision).toBe("inconclusive");
  });

  it.each([
    "duplicate_id",
    "unsafe_path",
    "conflicting_path",
    "wrong_category",
    "wrong_contract",
  ] as const)("validates the trusted case contract once before execution: %s", async (kind) => {
    const input = comparisonInput();
    if (kind === "duplicate_id") input.cases[1]!.id = input.cases[0]!.id;
    if (kind === "unsafe_path") input.cases[0]!.input.materials["../file"] = "Synthetic bytes";
    if (kind === "conflicting_path")
      input.cases[0]!.input.materials.installed = "This cannot also be a directory";
    if (kind === "wrong_category") input.cases[0]!.category = "failure";
    if (kind === "wrong_contract") input.cases[0]!.expected.checks = { invented: "pass" };
    const runtime = new DeliveryReplayRuntime();
    await expect(compareWorkImprovement(input, { runtime })).rejects.toThrow();
    expect(runtime.requests).toHaveLength(0);
  });

  it("keeps model credentials and callbacks out of the artifact and redacts upstream errors", async () => {
    const input = comparisonInput();
    input.execution.model.apiKey = "SYNTHETIC_MODEL_SECRET";
    input.execution.model.baseUrl = "https://private.example.test/inference";
    input.execution.model.headers = { authorization: "Bearer SYNTHETIC_MODEL_SECRET" };
    const runtime = new DeliveryReplayRuntime();
    runtime.failureFor = (arm, id) =>
      arm === "candidate" && id === "clean" ? new Error("Rejected SYNTHETIC_MODEL_SECRET") : null;
    const artifact = await compareWorkImprovement(input, { runtime });
    expect(JSON.stringify(artifact)).not.toContain("SYNTHETIC_MODEL_SECRET");
    expect(JSON.stringify(artifact)).not.toContain("private.example.test");
    expect(JSON.stringify(artifact)).not.toContain("callObserver");
    expect(caseResult(artifact, "clean").candidate.errors).toContainEqual({
      code: "upstream_error",
      message: "Rejected [redacted]",
    });
  });

  it("exports detached proposal history without materials, truth or per-case holdout outputs", async () => {
    const input = comparisonInput();
    input.source.correction!.text = "PRIVATE_CORRECTION_SENTINEL";
    const held = input.cases.find((fixture) => fixture.id === "unapproved")!;
    held.input.materials["holdout-material.txt"] = "HOLDOUT_MATERIAL_SENTINEL";
    held.expected.observations.unexpected_files!.push("OUTER_TRUTH_SENTINEL");
    const artifact = await compareWorkImprovement(input, { runtime: new DeliveryReplayRuntime() });
    const summary = summarizeWorkImprovementHistory(artifact);
    const serialized = JSON.stringify(summary);
    expect(summary.diagnostics.map((diagnostic) => diagnostic.caseId)).toEqual(["clean", "stale"]);
    expect(summary.improverRevision).toEqual(input.improverRevision);
    expect(serialized).not.toContain("HOLDOUT_MATERIAL_SENTINEL");
    expect(serialized).not.toContain("OUTER_TRUTH_SENTINEL");
    expect(serialized).not.toContain("PRIVATE_CORRECTION_SENTINEL");
    expect(serialized).not.toContain("unapproved");
    expect(serialized).not.toContain('"expected"');
    expect(serialized).not.toContain('"materials"');
    expect(serialized).not.toContain('"outputText"');
    expect(serialized).not.toContain('"recursiveBenefit"');
    summary.baseline.playbook.steps.push("A later proposal");
    expect(artifact.baseline.playbook.steps).toEqual(input.baseline.playbook.steps);
    expect(JSON.parse(serialized)).toEqual({ ...summary, baseline: artifact.baseline });
  });
});
