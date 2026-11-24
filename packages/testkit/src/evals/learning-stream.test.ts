import { once } from "node:events";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "../../../adapters/src/pi-runtime.js";
import { startLearningStreamFixtureServer } from "../cli/learning-stream.js";
import {
  createLearningStreamManifest,
  LEARNING_STREAM_DEFAULT_SEED,
  listLearningStreamTasks,
  runLearningStream,
} from "./learning-stream.js";

describe("time-split learning stream", () => {
  it("generates a stable, ordered, disjoint manifest without exposing oracle fields in list output", () => {
    const options = {
      seed: LEARNING_STREAM_DEFAULT_SEED,
      trainCount: 3,
      selectionCount: 2,
      holdoutCount: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
    const first = createLearningStreamManifest(options);
    expect(createLearningStreamManifest(options)).toEqual(first);
    expect(first.orderedTasks.map((task) => task.split)).toEqual([
      "train",
      "train",
      "train",
      "selection",
      "selection",
      "holdout",
      "holdout",
      "holdout",
    ]);
    expect(new Set(first.orderedTasks.map((task) => task.inputSha256)).size).toBe(
      first.orderedTasks.length,
    );
    const listed = listLearningStreamTasks(options);
    expect(listed.every((task) => !("expectedHash" in task))).toBe(true);
    expect(listed.every((task) => !("archetype" in task))).toBe(true);
    expect(listed.every((task) => !("feedback" in task))).toBe(true);
    expect(listed.map((task) => task.inputSha256)).toEqual(
      first.orderedTasks.map((task) => task.inputSha256),
    );
  });

  it("runs proposal, WorkImprovement, Compose, selection, retry, and future holdout through Pi offline", async () => {
    const fixture = startLearningStreamFixtureServer();
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const report = await runLearningStream(
        {
          seed: LEARNING_STREAM_DEFAULT_SEED,
          trainCount: 3,
          selectionCount: 2,
          holdoutCount: 3,
          model: {
            provider: "openai-compatible",
            id: "learning-stream-offline-v1",
            apiKey: "synthetic-offline-fixture-key",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiProtocol: "chat-completions",
            allowPrivateEndpoint: true,
            reasoning: false,
            maxTokens: 1024,
            contextWindow: 32_768,
            headers: {},
          },
          route: "synthetic-loopback-fixture",
          codeRevision: "synthetic-test-revision",
          workingDiffHash: "synthetic-test-diff",
          mode: "offline-fixture",
        },
        { runtime: new PiAgentRuntime() },
      );

      expect(fixture.fixtureErrors).toEqual([]);
      expect(report.status).toBe("completed");
      expect(report.execution.mode).toBe("offline-fixture");
      expect(report.termination.status).toBe("completed");
      expect(report.bootstrap?.composition?.initial.cases).toHaveLength(1);
      expect(report.training).toHaveLength(2);
      expect(report.histories.frozen.taskIds).toHaveLength(1);
      expect(report.histories.accumulating.taskIds).toHaveLength(2);
      expect(report.promptAudit).toHaveLength(6);
      expect(
        report.promptAudit.every((entry) => entry.excludedSelectionAndHoldoutTaskIds.length === 5),
      ).toBe(true);
      expect(report.selection).toHaveLength(2);
      for (const { metrics } of report.selection) {
        expect(metrics.baseline).toMatchObject({ costUsd: null, knownCostUsd: null });
        expect(metrics.candidate).toMatchObject({ costUsd: null, knownCostUsd: null });
      }
      expect(report.holdout?.baseline.runs).toHaveLength(3);
      expect(report.holdout?.frozen.runs).toHaveLength(3);
      expect(report.holdout?.accumulating.runs).toHaveLength(3);
      expect(report.holdout?.baseline.metrics).toMatchObject({
        costUsd: null,
        knownCostUsd: null,
      });
      expect(report.bootstrap?.composition?.initial.summary.baseline).toMatchObject({
        costUsd: null,
        knownCostUsd: null,
      });
      expect(report.holdout?.equalBudgetRetry.runs).toHaveLength(6);
      expect(report.holdout?.equalBudgetRetry.metrics.final.runs).toBe(3);
      expect(report.holdout?.equalBudgetRetry.metrics.attempts.runs).toBe(6);
      expect(
        report.holdout?.equalBudgetRetry.runs
          .flatMap((run) => run.usage)
          .every((usage) => !("callId" in usage) && !("providerRequestId" in usage)),
      ).toBe(true);
      expect(report.usage.totals.modelCalls).toBeGreaterThan(0);
      expect(report.execution).not.toHaveProperty("phaseBudgets");
      expect(report.execution).not.toHaveProperty("perTaskBudget");
      expect(report.usage.totals.reservedTokens).toBeGreaterThan(0);
      expect(report.usage.totals.costUsd).toBeNull();
      expect(report.usage.totals.costStatus).toBe("unknown");
      expect(report.assessment.adoptionQualification).toBe("not_applicable");
      expect(report.assessment.statisticalSignificanceClaimed).toBe(false);
      expect(report.assessment.note).toContain("not evidence of model learning");
      expect(JSON.stringify(report)).not.toContain("synthetic-offline-fixture-key");

      const unseenIds = report.manifest.orderedTasks
        .filter((task) => task.split !== "train")
        .map((task) => task.id);
      const unseenOracleHashes = report.manifest.orderedTasks
        .filter((task) => task.split !== "train")
        .map((task) => task.expectedSha256);
      expect(
        fixture.observedPrompts.every(
          (prompt) =>
            unseenIds.every((id) => !prompt.includes(id)) &&
            unseenOracleHashes.every((hash) => !prompt.includes(hash)),
        ),
      ).toBe(true);
      expect(fixture.inboundHeaderReceipts.length).toBeGreaterThan(0);
      expect(
        fixture.inboundHeaderReceipts.every(
          (receipt) =>
            receipt.status === 200 &&
            receipt.originator === "codex_cli_rs" &&
            receipt.userAgent?.startsWith("codex_cli_rs/") === true,
        ),
      ).toBe(true);
    } finally {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        fixture.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 120_000);

  it.each([
    { ledger: "fully priced", omitSplit: false },
    { ledger: "partially priced", omitSplit: true },
  ])("reports consistent costs with a $ledger call ledger", async ({ omitSplit }) => {
    const fixture = startLearningStreamFixtureServer();
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const pi = new PiAgentRuntime();
      const runtime: AgentRuntime = {
        describe: () => pi.describe(),
        abort: (runId) => pi.abort(runId),
        run(request, context) {
          const observer = request.model.callObserver!;
          let callCount = 0;
          return pi.run(
            {
              ...request,
              model: {
                ...request.model,
                callObserver: {
                  ...observer,
                  afterCall(id, usage) {
                    const secondCall = ++callCount === 2;
                    const reported = secondCall && !omitSplit;
                    return observer.afterCall(
                      id,
                      usage && {
                        ...usage,
                        inputTokens: 120,
                        outputTokens: 20,
                        cacheReadTokens: 10,
                        cacheWriteTokens: 100,
                        cacheWrite1hTokens: secondCall ? null : 40,
                        totalTokens: 250,
                        costUsd: reported ? 0 : null,
                        costSource: reported ? "provider-reported" : null,
                      },
                    );
                  },
                },
              },
            },
            context,
          );
        },
      };
      const report = await runLearningStream(
        {
          seed: LEARNING_STREAM_DEFAULT_SEED,
          trainCount: 3,
          selectionCount: 2,
          holdoutCount: 3,
          model: {
            provider: "openai-compatible",
            id: "learning-stream-offline-v1",
            apiKey: "synthetic-offline-fixture-key",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiProtocol: "chat-completions",
            allowPrivateEndpoint: true,
            maxTokens: 1024,
            contextWindow: 32_768,
          },
          route: "synthetic-loopback-fixture",
          codeRevision: null,
          workingDiffHash: null,
          mode: "offline-fixture",
        },
        {
          runtime,
          pricing: {
            source: "fixture",
            version: "1",
            input: 2,
            output: 5,
            cacheRead: 1,
            cacheWrite: 3,
            cacheWrite1h: 6,
          },
        },
      );
      expect(report.status).toBe("completed");
      expect(fixture.fixtureErrors).toEqual([]);
      const { calls, totals } = report.usage;
      const pricedCalls = calls.filter((call) => call.cacheWrite1hTokens === 40);
      const splitWriteCost = 0.00077; // 120*2 + 20*5 + 10*1 + 60*3 + 40*6, per million.
      const secondCallCost = omitSplit ? null : 0;
      expect(pricedCalls.length).toBeGreaterThan(0);
      expect(
        pricedCalls.every(
          (call) =>
            call.costUsd === splitWriteCost && call.costSource === "explicit-pricing-estimate",
        ),
      ).toBe(true);
      expect(calls).toContainEqual(
        expect.objectContaining({
          cacheWrite1hTokens: null,
          costUsd: secondCallCost,
          costSource: omitSplit ? null : "provider-reported",
        }),
      );
      expect(calls).toHaveLength(fixture.requestCount);
      expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length);
      if (omitSplit) expect(totals.costUsd).toBeNull();
      else expect(totals.costUsd).toBeCloseTo(pricedCalls.length * splitWriteCost, 10);
      expect(report.selection).toHaveLength(2);
      for (const { metrics } of report.selection) {
        for (const arm of [metrics.baseline, metrics.candidate]) {
          expect(arm.knownCostUsd).toBeCloseTo(2 * splitWriteCost, 10);
          if (omitSplit) expect(arm.costUsd).toBeNull();
          else expect(arm.costUsd).toBeCloseTo(2 * splitWriteCost, 10);
        }
      }
      const { metrics, runs } = report.holdout!.baseline;
      expect(runs.flatMap((run) => run.usage.map((usage) => usage.costUsd))).toEqual(
        runs.flatMap(() => [splitWriteCost, secondCallCost]),
      );
      expect(metrics.knownCostUsd).toBeCloseTo(3 * splitWriteCost, 10);
      if (omitSplit) expect(metrics.costUsd).toBeNull();
      else expect(metrics.costUsd).toBeCloseTo(3 * splitWriteCost, 10);
    } finally {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        fixture.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stops on the caller's explicit abort signal", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const runtime: AgentRuntime = {
      describe: () => new PiAgentRuntime().describe(),
      abort: async () => {},
      async *run(_request, context) {
        markStarted();
        await new Promise<void>((resolve) => {
          if (context?.signal?.aborted) resolve();
          else context?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const evaluation = runLearningStream(
      {
        seed: LEARNING_STREAM_DEFAULT_SEED,
        trainCount: 3,
        selectionCount: 2,
        holdoutCount: 3,
        model: {
          provider: "openai-compatible",
          id: "learning-stream-offline-v1",
          apiKey: "synthetic-offline-fixture-key",
          baseUrl: "http://127.0.0.1:1/v1",
          apiProtocol: "chat-completions",
          allowPrivateEndpoint: true,
          maxTokens: 1024,
          contextWindow: 32_768,
          headers: {},
        },
        route: "synthetic-loopback-fixture",
        codeRevision: null,
        workingDiffHash: null,
        mode: "offline-fixture",
      },
      { runtime, context: { signal: controller.signal } },
    );

    await started;
    controller.abort(new Error("Evaluation interrupted"));
    const report = await evaluation;

    expect(report.status).toBe("incomplete");
    expect(report.termination.status).toBe("interrupted");
    expect(report.termination.reason).toBe("interrupted_by_signal");
    expect(report.phases[0]).toMatchObject({
      name: "bootstrap_proposal",
      status: "unknown",
      reason: "interrupted_by_signal",
    });
  });
});
