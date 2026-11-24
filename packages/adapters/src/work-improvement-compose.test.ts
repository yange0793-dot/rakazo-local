import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentUsage,
} from "@rakazo/adapter-kit";
import type { ImprovementComponentSet } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILE_DELIVERY_PLAYBOOKS,
  FILE_DELIVERY_SCRIPTED_REPLIES,
  fileDeliveryFixtures,
} from "./fixtures/work-improvement.js";
import type { WorkImprovementInput } from "./work-improvement.js";
import type { WorkImprovementCompositionCheckpoint } from "./work-improvement-compose.js";
import { compareAndComposeWorkImprovement } from "./work-improvement-compose.js";

afterEach(() => vi.useRealTimers());

function comparisonInput(): WorkImprovementInput {
  return {
    comparisonId: "synthetic-compose-comparison",
    caseSet: { id: "synthetic-file-delivery", revision: "1" },
    source: {
      runId: "synthetic-source-run",
      project: "project-alpha",
      family: "file-delivery",
      receipt: { schemaVersion: "receipt.v1", status: "needs_evidence" },
    },
    baseline: structuredClone(FILE_DELIVERY_PLAYBOOKS.baseline),
    candidate: structuredClone(FILE_DELIVERY_PLAYBOOKS.candidate),
    execution: {
      model: {
        provider: "scripted",
        id: "scripted",
        maxTokens: 512,
        thinkingLevel: "high",
      },
      route: "offline-fixed-route",
      budget: {
        maxModelCalls: 1,
        maxToolCalls: 16,
        maxTotalTokens: 20_000,
        timeoutMs: 2_000,
      },
    },
    outputContract: {
      checkIds: ["installation", "directory", "upload"],
      observationIds: [
        "missing_files",
        "unexpected_files",
        "hash_mismatches",
        "excluded_runtime_files",
      ],
    },
    cases: fileDeliveryFixtures(),
  };
}

type ComposeReply =
  | {
      kind: "compose";
      playbook: WorkImprovementInput["candidate"]["playbook"];
      components?: ImprovementComponentSet;
    }
  | { kind: "reject"; reason: string };

class CompositionReplayRuntime implements AgentRuntime {
  private readonly taskIds = new Map(
    fileDeliveryFixtures().map((fixture) => [fixture.input.task, fixture.id]),
  );
  readonly requests: AgentRunRequest[] = [];
  readonly compositionRequests: AgentRunRequest[] = [];
  readonly executionPlaybooks: Array<{ runId: string; howToCheck: string }> = [];
  readonly executionComponents: Array<{ runId: string; components: unknown }> = [];
  reply: ComposeReply = {
    kind: "compose",
    playbook: {
      ...FILE_DELIVERY_PLAYBOOKS.candidate.playbook,
      howToCheck: "Composed: verify the installed tree and the final upload receipt.",
    },
  };
  compositionMode: "normal" | "no_usage" | "budget_exhausted" = "normal";
  compositionCallCount = 1;
  compositionUsage?: Partial<AgentUsage>;

  describe() {
    return {
      id: "offline-composition-replay",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }

  async abort(): Promise<void> {
    return;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    this.requests.push(request);
    if (request.tools.length > 0) {
      const { task } = JSON.parse(request.prompt) as { task: string };
      const fixtureId = this.taskIds.get(task);
      if (!fixtureId) throw new Error("Unknown comparison task");
      const payload = JSON.parse(request.instructions.split("\n").at(-1)!) as {
        playbook: WorkImprovementInput["candidate"]["playbook"];
        components?: unknown;
      };
      const { playbook } = payload;
      this.executionPlaybooks.push({ runId: request.runId, howToCheck: playbook.howToCheck });
      this.executionComponents.push({
        runId: request.runId,
        components: payload.components,
      });
      const arm =
        playbook.howToCheck === FILE_DELIVERY_PLAYBOOKS.baseline.playbook.howToCheck
          ? "baseline"
          : "candidate";
      const reads: Array<{ name: string; args: { path: string } }> = [
        { name: "list_files", args: { path: "" } },
        { name: "read_file", args: { path: "request.json" } },
        { name: "read_file", args: { path: "manifest.json" } },
      ];
      if (fixtureId !== "exception") {
        reads.push(
          { name: "read_file", args: { path: "installed-files.json" } },
          { name: "read_file", args: { path: "selection-receipt.json" } },
        );
        if (fixtureId !== "selected")
          reads.push({ name: "read_file", args: { path: "upload-receipt.json" } });
        if (fixtureId !== "partial")
          reads.push({ name: "list_files", args: { path: "installed" } });
      }
      for (const [index, call] of reads.entries()) {
        const executionId = `${request.runId}:tool:${index}`;
        await request.executeTool!(call.name, call.args, executionId);
        yield { type: "tool", name: call.name, args: call.args, executionId };
      }
      yield {
        type: "usage",
        inputTokens: 12,
        outputTokens: 40,
        totalTokens: 52,
        costUsd: 0.01,
        costSource: "synthetic",
        provider: request.model.provider,
        model: request.model.id,
      };
      const text = JSON.stringify(FILE_DELIVERY_SCRIPTED_REPLIES[arm][fixtureId]);
      yield { type: "text", text };
      yield { type: "done", text };
      return;
    }
    this.compositionRequests.push(request);
    if (this.compositionMode === "no_usage") {
      const text = JSON.stringify(this.reply);
      yield { type: "text", text };
      yield { type: "done", text };
      return;
    }
    const observer = request.model.callObserver!;
    for (let index = 0; index < this.compositionCallCount; index += 1) {
      const callId =
        index === 0
          ? `${request.runId}:compose-call`
          : `${request.runId}:compose-call-${index + 1}`;
      const inputTokensEstimate = this.compositionMode === "budget_exhausted" ? 19_600 : 80;
      let reservation: string;
      try {
        reservation = await observer.beforeCall({
          callId,
          runId: request.runId,
          provider: request.model.provider,
          modelId: request.model.id,
          inputTokensEstimate,
          maxOutputTokens: request.model.maxTokens ?? 512,
        });
      } catch {
        return;
      }
      const usage = {
        inputTokens: 20,
        outputTokens: 40,
        totalTokens: 60,
        costUsd: 0.005,
        provider: request.model.provider,
        model: request.model.id,
        callId,
        usageSource: "synthetic",
        ...this.compositionUsage,
      };
      await observer.afterCall(reservation, usage);
      yield { type: "usage", ...usage };
    }
    const text = JSON.stringify(this.reply);
    yield { type: "text", text };
    yield { type: "done", text };
  }
}

describe("work improvement composition", () => {
  it("executes a composed playbook through the isolated comparison path and retains both trials", async () => {
    const input = comparisonInput();
    const runtime = new CompositionReplayRuntime();
    const artifact = await compareAndComposeWorkImprovement(input, { runtime });

    expect(artifact.initial.decision).toBe("adopt");
    expect(artifact.composition.status).toBe("composed");
    expect(artifact.composition.candidate?.playbook).toEqual(
      runtime.reply.kind === "compose" ? runtime.reply.playbook : null,
    );
    expect(artifact.composition.execution).toMatchObject({
      model: {
        provider: "scripted",
        id: "scripted",
        maxTokens: 512,
        thinkingLevel: "high",
      },
      route: "offline-fixed-route",
      budget: {
        maxModelCalls: 1,
        maxTotalTokens: 20_000,
        maxOutputTokens: 512,
        timeoutMs: 2_000,
      },
    });
    expect(artifact.composition.usage).toHaveLength(1);
    expect(artifact.composition.usage[0]!.callId).toBe(
      `${runtime.compositionRequests[0]!.runId}:compose-call`,
    );
    expect(artifact.composition.totalTokens).toBe(60);
    expect(artifact.composition.knownCostUsd).toBeCloseTo(0.005);
    expect(artifact.initial.summary.candidate.knownCostUsd).toBeGreaterThan(0);
    expect(artifact.composed?.decision).toBe("adopt");
    expect(artifact.composed?.summary.candidate.knownTotalTokens).toBe(468);
    expect(artifact.composed?.summary.candidate.knownCostUsd).toBeCloseTo(0.09);
    expect(artifact.composed?.candidate.revision).toBe(artifact.composition.candidate?.revision);
    expect(artifact.decision).toBe("adopt");
    expect(artifact.retainedRevision).toBe(artifact.composition.candidate?.revision);
    expect(runtime.compositionRequests).toHaveLength(1);
    expect(runtime.compositionRequests[0]?.model.thinkingLevel).toBe("high");
    expect(runtime.compositionRequests[0]?.fallbackModels).toBeUndefined();
    const comparisonRequests = runtime.requests.filter((request) => request.tools.length > 0);
    expect(comparisonRequests).toHaveLength(36);
    expect(
      comparisonRequests.every(
        (request) =>
          request.model.provider === "scripted" &&
          request.model.id === "scripted" &&
          request.model.maxTokens === 512 &&
          request.model.thinkingLevel === "high" &&
          request.fallbackModels === undefined,
      ),
    ).toBe(true);
    expect(
      runtime.executionPlaybooks.filter((entry) =>
        artifact.composed?.cases.some((fixture) => fixture.candidate.runId === entry.runId),
      ),
    ).toHaveLength(9);
    expect(
      runtime.executionPlaybooks
        .filter((entry) =>
          artifact.composed?.cases.some((fixture) => fixture.candidate.runId === entry.runId),
        )
        .every(
          (entry) =>
            runtime.reply.kind === "compose" &&
            entry.howToCheck === runtime.reply.playbook.howToCheck,
        ),
    ).toBe(true);
    expect(
      artifact.composed?.cases.every((fixture) => fixture.candidate.score.verdict === "pass"),
    ).toBe(true);
  });

  it("allows multiple compose requests when the caller supplies no request budget", async () => {
    const input = comparisonInput();
    input.execution.budget = {};
    const runtime = new CompositionReplayRuntime();
    runtime.compositionCallCount = 2;

    const artifact = await compareAndComposeWorkImprovement(input, { runtime });

    expect(artifact.composition.status).toBe("composed");
    expect(artifact.composition.usage).toHaveLength(2);
    expect(artifact.composition.execution.budget).toMatchObject({
      maxModelCalls: null,
      maxTotalTokens: null,
      maxOutputTokens: 512,
      timeoutMs: null,
    });
  });

  it("does not apply a default compose timeout and honors caller cancellation", async () => {
    vi.useFakeTimers();
    const input = comparisonInput();
    input.execution.budget = {};
    const replay = new CompositionReplayRuntime();
    const controller = new AbortController();
    const aborted: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runtime: AgentRuntime = {
      describe: () => replay.describe(),
      abort: async (runId) => {
        aborted.push(runId);
        await replay.abort();
      },
      async *run(request, context) {
        if (request.tools.length > 0) {
          yield* replay.run(request);
          return;
        }
        markStarted();
        await new Promise<void>((resolve) => {
          if (context?.signal?.aborted) resolve();
          else context?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const composition = compareAndComposeWorkImprovement(input, {
      runtime,
      context: { signal: controller.signal } as Partial<AdapterContext>,
    });

    await started;
    await vi.advanceTimersByTimeAsync(181_000);
    expect(aborted).toEqual([]);
    controller.abort(new Error("Evaluation interrupted"));

    const artifact = await composition;
    expect(artifact.composition.status).toBe("unknown");
    expect(aborted).toHaveLength(1);
  });

  it("composes, reruns and retains the exact revised component set", async () => {
    const input = comparisonInput();
    const proposed = {
      schemaVersion: "improvement-components.v1" as const,
      items: [
        {
          id: "reader",
          revision: "1",
          kind: "plugin" as const,
          capabilityId: "isolated.snapshot.read_file",
        },
        {
          id: "listing",
          revision: "1",
          kind: "plugin" as const,
          capabilityId: "isolated.snapshot.list_files",
        },
        {
          id: "prefetch",
          revision: "1",
          kind: "script" as const,
          language: "tool-sequence.v1" as const,
          steps: [
            {
              capabilityId: "isolated.snapshot.read_file",
              input: { path: "request.json" },
            },
          ],
        },
      ],
    };
    const composed = {
      schemaVersion: "improvement-components.v1" as const,
      items: [
        ...proposed.items,
        {
          id: "task-guidance",
          revision: "2",
          kind: "task_guidance" as const,
          text: "Check the receipt after inspecting the files.",
        },
      ],
    };
    input.candidate.components = proposed;
    const runtime = new CompositionReplayRuntime();
    runtime.reply = {
      kind: "compose",
      playbook: {
        ...FILE_DELIVERY_PLAYBOOKS.candidate.playbook,
        howToCheck: "Composed: inspect the receipt after collecting file evidence.",
      },
      components: composed,
    };

    const result = await compareAndComposeWorkImprovement(input, { runtime });

    expect(result.composition.candidate?.components).toEqual(composed);
    expect(result.composed?.candidate.components).toEqual(composed);
    expect(result.composed?.componentEligibility.candidate.eligible).toBe(true);
    const composedRunIds = new Set(
      result.composed!.cases.map((fixture) => fixture.candidate.runId),
    );
    const reruns = runtime.executionComponents.filter((entry) => composedRunIds.has(entry.runId));
    expect(reruns).toHaveLength(result.composed!.cases.length);
    expect(reruns.every((entry) => entry.components === undefined)).toBe(false);
    const first = reruns[0]!;
    expect(first.components).toMatchObject({
      guidance: [
        {
          id: "task-guidance",
          revision: "2",
          text: "Check the receipt after inspecting the files.",
        },
      ],
      scriptOutputs: [{ componentId: "prefetch" }],
    });
  });

  it("preserves proposed components when the composer omits the optional field", async () => {
    const input = comparisonInput();
    const proposed: ImprovementComponentSet = {
      schemaVersion: "improvement-components.v1",
      items: [
        {
          id: "reader",
          revision: "1",
          kind: "plugin",
          capabilityId: "isolated.snapshot.read_file",
        },
        {
          id: "listing",
          revision: "1",
          kind: "plugin",
          capabilityId: "isolated.snapshot.list_files",
        },
      ],
    };
    input.candidate.components = proposed;
    const runtime = new CompositionReplayRuntime();

    const result = await compareAndComposeWorkImprovement(input, { runtime });

    expect(result.composition.candidate?.components).toEqual(proposed);
    expect(result.composed?.candidate.components).toEqual(proposed);
    expect(result.composed?.componentEligibility.candidate.eligible).toBe(true);
  });

  it("keeps source and holdout answers out of the composer input", async () => {
    const input = comparisonInput();
    input.source.correction = {
      text: "PRIVATE_CORRECTION_SENTINEL",
      messageId: "synthetic-correction",
    };
    input.source.receipt = { private: "SOURCE_RECEIPT_SENTINEL" };
    const fixtures = fileDeliveryFixtures();
    const held = fixtures.find((fixture) => fixture.split === "holdout")!;
    held.expected.observations.unexpected_files = ["HOLDOUT_ANSWER_SENTINEL"];
    held.input.materials["hidden.txt"] = "HOLDOUT_MATERIAL_SENTINEL";
    input.cases = fixtures;
    const runtime = new CompositionReplayRuntime();
    await compareAndComposeWorkImprovement(input, { runtime });

    const composerInput = JSON.stringify({
      instructions: runtime.compositionRequests[0]?.instructions,
      prompt: runtime.compositionRequests[0]?.prompt,
      history: runtime.compositionRequests[0]?.history,
      tools: runtime.compositionRequests[0]?.tools,
    });
    expect(composerInput).not.toContain("PRIVATE_CORRECTION_SENTINEL");
    expect(composerInput).not.toContain("SOURCE_RECEIPT_SENTINEL");
    expect(composerInput).not.toContain("HOLDOUT_ANSWER_SENTINEL");
    expect(composerInput).not.toContain("HOLDOUT_MATERIAL_SENTINEL");
    expect(composerInput).not.toContain('"expected"');
    expect(composerInput).not.toContain('"score"');
  });

  it("does not adopt a generated candidate when its model-call budget cannot be proven", async () => {
    const runtime = new CompositionReplayRuntime();
    runtime.compositionMode = "budget_exhausted";
    const artifact = await compareAndComposeWorkImprovement(comparisonInput(), { runtime });

    expect(artifact.initial.decision).toBe("adopt");
    expect(artifact.composition.error).toContain("token_budget_exhausted");
    expect(artifact.composition.status).toBe("unknown");
    expect(artifact.composed).toBeNull();
    expect(artifact.decision).toBe("inconclusive");
    expect(artifact.retainedRevision).toBe(FILE_DELIVERY_PLAYBOOKS.baseline.revision);
  });

  it("retains a valid composition rejection without falling back to the initial adoption", async () => {
    const runtime = new CompositionReplayRuntime();
    runtime.reply = {
      kind: "reject",
      reason: "The diagnostic executions do not support a safe merge.",
    };
    const artifact = await compareAndComposeWorkImprovement(comparisonInput(), { runtime });

    expect(artifact.initial.decision).toBe("adopt");
    expect(artifact.composition.status).toBe("rejected");
    expect(artifact.composition.reason).toBe(
      "The diagnostic executions do not support a safe merge.",
    );
    expect(artifact.composed).toBeNull();
    expect(artifact.decision).toBe("reject");
    expect(artifact.retainedRevision).toBe(FILE_DELIVERY_PLAYBOOKS.baseline.revision);
  });

  it("leaves a composition with no usage receipt unknown", async () => {
    const runtime = new CompositionReplayRuntime();
    runtime.compositionMode = "no_usage";
    const artifact = await compareAndComposeWorkImprovement(comparisonInput(), { runtime });

    expect(artifact.composition.status).toBe("unknown");
    expect(artifact.composition.error).toContain("missing_usage");
    expect(artifact.composed).toBeNull();
    expect(artifact.decision).toBe("inconclusive");
  });

  it.each(["inputTokens", "outputTokens"] as const)(
    "does not qualify a composer receipt missing %s and total tokens",
    async (bucket) => {
      const input = comparisonInput();
      delete input.execution.budget.maxTotalTokens;
      const runtime = new CompositionReplayRuntime();
      runtime.compositionUsage = { totalTokens: null, [bucket]: null };
      const artifact = await compareAndComposeWorkImprovement(input, { runtime });

      expect(artifact.composition.status).toBe("unknown");
      expect(artifact.composition.error).toContain("missing_usage");
      expect(artifact.composed).toBeNull();
      expect(artifact.decision).toBe("inconclusive");
    },
  );

  it("preserves the resolved route without adding an output ceiling when none is configured", async () => {
    const input = comparisonInput();
    delete input.execution.model.maxTokens;
    delete input.execution.budget.maxTotalTokens;
    const runtime = new CompositionReplayRuntime();
    const artifact = await compareAndComposeWorkImprovement(input, { runtime });

    expect(artifact.decision).toBe("adopt");
    expect(artifact.composition.execution.model.maxTokens).toBeNull();
    expect(artifact.composition.execution.budget.maxOutputTokens).toBeNull();
    expect(
      runtime.requests.every(
        (request) =>
          request.model.maxTokens === undefined &&
          request.model.thinkingLevel === "high" &&
          request.model.provider === input.execution.model.provider &&
          request.model.id === input.execution.model.id,
      ),
    ).toBe(true);
  });

  it.each(["initial", "composition", "composed"] as const)(
    "resumes a durable %s checkpoint without repeating completed stages",
    async (phase) => {
      const input = comparisonInput();
      const runtime = new CompositionReplayRuntime();
      let checkpoint: WorkImprovementCompositionCheckpoint | undefined;
      await expect(
        compareAndComposeWorkImprovement(input, {
          runtime,
          onCheckpoint: async (saved) => {
            checkpoint = saved;
            if (saved.phase === phase) throw new Error("interrupted after durable checkpoint");
          },
        }),
      ).rejects.toThrow("interrupted after durable checkpoint");
      expect(checkpoint!.phase).toBe(phase);
      const callsBeforeResume = runtime.requests.length;
      const artifact = await compareAndComposeWorkImprovement(input, { runtime, checkpoint });

      expect(artifact.decision).toBe("adopt");
      expect(runtime.compositionRequests).toHaveLength(1);
      expect(runtime.requests.filter((request) => request.tools.length > 0)).toHaveLength(36);
      expect(runtime.requests.length - callsBeforeResume).toBe(
        phase === "initial" ? 19 : phase === "composition" ? 18 : 0,
      );
    },
  );

  it("does not call the composer when its bounded evidence input is too large", async () => {
    const input = comparisonInput();
    input.baseline.playbook.whenToUse = "baseline ".repeat(8_000);
    const runtime = new CompositionReplayRuntime();
    const artifact = await compareAndComposeWorkImprovement(input, { runtime });

    expect(artifact.composition.status).toBe("unknown");
    expect(artifact.composition.error).toContain("composition_input_too_large");
    expect(runtime.compositionRequests).toHaveLength(0);
    expect(artifact.composed).toBeNull();
    expect(artifact.decision).toBe("inconclusive");
    expect(artifact.retainedRevision).toBe(input.baseline.revision);
  });
});
