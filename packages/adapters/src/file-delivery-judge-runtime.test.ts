import { createHash } from "node:crypto";
import type { AdapterContext, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { TicketFileDeliveryRequirements } from "@rakazo/contracts";
import { TicketFileDeliveryAcceptanceSchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateFileDeliveryAcceptanceWithJudge } from "./file-delivery-acceptance.js";
import type { FileDeliveryJudgeInput } from "./file-delivery-judge.js";
import { createFileDeliveryJudge, FILE_DELIVERY_RUBRIC_VERSION } from "./file-delivery-judge.js";
import { FILE_DELIVERY_CALIBRATION_CASES } from "./fixtures/file-delivery-calibration.js";
import { CODEX_CLIENT_HEADERS } from "./model-client-headers.js";
import { PiAgentRuntime } from "./pi-runtime.js";

type WireRequest = {
  model: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file-delivery judge through the real Pi runtime", () => {
  it.each([
    ["verified", false],
    ["issue", false],
    ["unknown", true],
  ] as const)(
    "carries the pinned route, headers, evidence and accounted %s result into acceptance",
    async (expected, unknownCost) => {
      vi.stubGlobal("fetch", () => {
        throw new Error("Unexpected live request.");
      });
      const context: AdapterContext = {
        operationId: "receipt",
        runId: "actual-run",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        traceId: "trace",
        signal: new AbortController().signal,
      };
      const wire: Array<{ request: WireRequest; headers: Headers }> = [];
      const usage: Array<{
        event: Extract<AgentRuntimeEvent, { type: "usage" }>;
        context: AdapterContext;
      }> = [];
      const runtime = new PiAgentRuntime({
        modelFetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as WireRequest;
          wire.push({ request, headers: new Headers(init?.headers) });
          if (wire.length > 7) throw new Error("Unexpected extra inference.");
          const prompt = JSON.parse(request.messages.at(-1)!.content) as {
            requirementsVersion: number;
            requirements: FileDeliveryJudgeInput[];
          };
          const verdicts = prompt.requirements.map((item) => {
            const fixture = FILE_DELIVERY_CALIBRATION_CASES.find(
              (entry) => entry.id === item.requirementId,
            );
            return {
              requirementId: item.requirementId,
              ...(fixture?.expected ?? {
                coverage: expected === "issue" ? "issue" : "verified",
                evidenceSupport: "verified",
              }),
              reason: "Synthetic wire verdict for runtime verification.",
              citations: item.evidence.map((evidence) => ({
                evidenceId: evidence.id,
                quote: evidence.text.slice(0, 100),
              })),
            };
          });
          const text = JSON.stringify({
            schemaVersion: 1,
            rubricVersion: FILE_DELIVERY_RUBRIC_VERSION,
            requirementsVersion: prompt.requirementsVersion,
            verdicts,
          });
          return new Response(
            `data: ${JSON.stringify({
              id: `fixture-request-${wire.length}`,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: text },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150,
                ...(!unknownCost || wire.length <= 6 ? { cost: 0.02 } : {}),
              },
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const beforeCall = vi.fn(async () => "parent-budget-reservation");
      const afterCall = vi.fn(async () => {});
      const judge = createFileDeliveryJudge({
        runtime,
        model: {
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: "fake-test-key",
          apiProtocol: "chat-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          allowPrivateEndpoint: true,
          reasoning: true,
          thinkingLevel: "high",
          maxTokens: 2_000,
          contextWindow: 64_000,
          headers: { "x-fixture-setting": "kept" },
          callObserver: { beforeCall, afterCall },
        },
        budget: { maxTotalTokens: 40_000, timeoutMs: 10_000 },
        onUsage: async (event, usageContext) => {
          usage.push({ event, context: usageContext });
        },
      });
      const artifacts = [
        { id: "report", name: "report.txt", text: "The release is on 14 May due to payment work." },
        {
          id: "source",
          name: "source.txt",
          text: "Launch May 14. Payment integration delayed it.",
        },
      ].map(({ text, ...artifact }) => {
        const bytes = Buffer.from(text);
        return {
          ...artifact,
          bytes,
          version: 1,
          hash: createHash("sha256").update(bytes).digest("hex"),
          mimeType: "text/plain",
          observedAt: "2026-11-23T10:00:00.000Z",
        };
      });
      const requirements: TicketFileDeliveryRequirements = {
        version: 2,
        items: [
          {
            id: "file",
            kind: "artifact",
            name: "report.txt",
            description: "Deliver a nonempty report.",
            contentConstraints: [{ kind: "text_nonempty" }],
          },
          {
            id: "meaning",
            kind: "semantic",
            description: "Report the release date and reason for delay, supported by the source.",
            rubricVersion: FILE_DELIVERY_RUBRIC_VERSION,
          },
        ],
      };
      const acceptance = await evaluateFileDeliveryAcceptanceWithJudge(
        {
          requirements,
          fileDelivery: {
            requirementsVersion: 2,
            evidenceRefs: [
              {
                requirementId: "file",
                kind: "artifact",
                artifactId: artifacts[0]!.id,
                version: 1,
                hash: artifacts[0]!.hash,
              },
              ...artifacts.map((artifact) => ({
                requirementId: "meaning",
                kind: "artifact" as const,
                artifactId: artifact.id,
                version: artifact.version,
                hash: artifact.hash,
                role: artifact.id === "report" ? ("deliverable" as const) : ("source" as const),
              })),
            ],
          },
          deliveredArtifactIds: artifacts.map((artifact) => artifact.id),
          artifacts,
          effects: [],
        },
        { judge, context },
      );
      expect(acceptance.status).toBe(expected);
      expect(acceptance.results[1]?.judge).toMatchObject({
        status: expected,
        operationId: "receipt:file-judge:2:meaning",
        costUsd: unknownCost ? null : 0.02,
        totalTokens: 150,
        calibration: {
          status: "verified",
          operationId: "actual-run:file-judge:calibration",
          totalTokens: 900,
        },
      });
      expect(acceptance.results[1]?.judge?.calibration?.costUsd).toBeCloseTo(0.12);
      expect(TicketFileDeliveryAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
      expect(wire).toHaveLength(7);
      expect(usage).toHaveLength(7);
      expect(usage.map((entry) => entry.context.operationId)).toEqual([
        "actual-run:file-judge:calibration:paraphrase",
        "actual-run:file-judge:calibration:omission",
        "actual-run:file-judge:calibration:contradiction",
        "actual-run:file-judge:calibration:missing-support",
        "actual-run:file-judge:calibration:partial-support",
        "actual-run:file-judge:calibration:instruction-in-evidence",
        "receipt:file-judge:2:meaning",
      ]);
      expect(usage.every((entry) => entry.event.operationKind === "setup")).toBe(true);
      expect(usage.every((entry) => entry.context.runId === "actual-run")).toBe(true);
      expect(beforeCall).toHaveBeenCalledTimes(7);
      expect(afterCall).toHaveBeenCalledTimes(7);
      for (const { request, headers } of wire) {
        expect(request.model).toBe("fixture-model");
        expect(request.reasoning_effort).toBe("high");
        expect(request.tools ?? []).toEqual([]);
        expect(headers.get("x-fixture-setting")).toBe("kept");
        expect(headers.get("user-agent")).toBe(CODEX_CLIENT_HEADERS["user-agent"]);
        expect(headers.get("originator")).toBe("codex_cli_rs");
      }
      const formalPrompt = wire[6]!.request.messages.at(-1)!.content;
      expect(formalPrompt).toContain("The release is on 14 May due to payment work.");
      expect(formalPrompt).toContain('"version":1');
      expect(formalPrompt).not.toContain("fake-test-key");
    },
  );
});
