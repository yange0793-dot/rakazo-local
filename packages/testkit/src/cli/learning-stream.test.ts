import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelConnectInputSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  learningStreamModelFromConnection,
  startLearningStreamFixtureServer,
} from "./learning-stream.js";

const connection = {
  provider: "openai-compatible",
  modelId: "selected-fixture-model",
  apiKey: "synthetic-live-connection-key",
  baseUrl: "http://127.0.0.1:1/v1",
  apiProtocol: "chat-completions",
  reasoning: true,
  thinkingLevel: "high",
  maxTokens: 16_000,
  contextWindow: 32_768,
  headers: { "x-fixture-token": "synthetic-private-header" },
};

function isolatedEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, RAKAZO_LIVE_MODEL_CATALOG: "off" };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("VERIFY_") ||
      [
        "DATABASE_URL",
        "DATABASE_MIGRATION_URL",
        "REALTIME_DATABASE_URL",
        "COPY_TEST_DATABASE",
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

async function runCli(args: string[], cwd: string) {
  const executable = process.execPath;
  const tsx = path.resolve(cwd, "node_modules/tsx/dist/cli.mjs");
  const script = path.resolve(cwd, "packages/testkit/src/cli/learning-stream.ts");
  const child = spawn(executable, [tsx, script, ...args], {
    cwd,
    env: isolatedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

describe("learning-stream CLI", () => {
  it("preserves the selected model connection settings", () => {
    const parsed = ModelConnectInputSchema.parse(connection);
    const selected = learningStreamModelFromConnection(parsed);
    expect(selected).toMatchObject({
      provider: "openai-compatible",
      id: "selected-fixture-model",
      thinkingLevel: "high",
      maxTokens: 16_000,
      headers: { "x-fixture-token": "synthetic-private-header" },
    });
  });

  it("runs the full evaluation with unknown cost and priority wire metadata", async () => {
    const fixture = startLearningStreamFixtureServer();
    const root = process.cwd();
    const directory = await mkdtemp(path.join(os.tmpdir(), "learning-stream-cli-"));
    const connectionPath = path.join(directory, "connection.json");
    const reportPath = path.join(directory, "report.json");
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const liveConnection = {
        ...connection,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      };
      await writeFile(connectionPath, JSON.stringify(liveConnection), { mode: 0o600 });

      const withoutPricing = await runCli(
        ["--live", "--connection", connectionPath, "--spend-cap-usd", "1", "--output", reportPath],
        root,
      );
      expect(withoutPricing.code).toBe(1);
      expect(withoutPricing.stderr).toContain("--spend-cap-usd requires --pricing");
      expect(fixture.requestCount).toBe(0);

      const result = await runCli(
        [
          "--live",
          "--connection",
          connectionPath,
          "--service-tier",
          "priority",
          "--output",
          reportPath,
        ],
        root,
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        status: string;
        execution: {
          mode: string;
          requestedServiceTier: string | null;
          model: { provider: string; id: string; thinkingLevel: string; maxTokens: number };
          spendCapUsd: number | null;
        };
        phases: Array<{ name: string; status: string; reason: string | null }>;
        usage: {
          totals: {
            modelCalls: number;
            costUsd: number | null;
            costStatus: string;
          };
        };
        assessment: { adoptionQualification: string };
        outboundHeaderReceipts: Array<{
          headerNames: string[];
          userAgent: string | null;
          originator: string | null;
          authorizationPresent: boolean;
          status: number | null;
          terminalStatus: string | null;
          tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
          requestedServiceTier: string | null;
          serviceTierApplied: boolean;
          returnedServiceTier: string | null;
        }>;
      };
      expect(report.status).toBe("completed");
      expect(report.execution).toMatchObject({
        mode: "live",
        requestedServiceTier: "priority",
        model: {
          provider: "openai-compatible",
          id: "selected-fixture-model",
          thinkingLevel: "high",
          maxTokens: 16_000,
        },
        spendCapUsd: null,
      });
      expect(report.phases.every((phase) => phase.status === "completed")).toBe(true);
      expect(report.usage.totals).toMatchObject({
        modelCalls: fixture.requestCount,
      });
      expect(report.usage.totals.modelCalls).toBeGreaterThan(1);
      expect(report.assessment.adoptionQualification).toBe("unknown_cost");
      expect(fixture.observedServiceTiers.length).toBeGreaterThan(1);
      expect(fixture.observedServiceTiers.every((tier) => tier === "priority")).toBe(true);
      expect(report.outboundHeaderReceipts).toHaveLength(fixture.requestCount);
      expect(
        report.outboundHeaderReceipts.every(
          (receipt) =>
            receipt.userAgent?.startsWith("codex_cli_rs/") &&
            receipt.originator === "codex_cli_rs" &&
            receipt.authorizationPresent &&
            receipt.status === 200 &&
            ["stop", "tool_calls"].includes(receipt.terminalStatus ?? "") &&
            receipt.requestedServiceTier === "priority" &&
            receipt.serviceTierApplied &&
            receipt.returnedServiceTier === "priority",
        ),
      ).toBe(true);
      expect(report.outboundHeaderReceipts[0]?.tokenUsage?.inputTokens).toBeGreaterThan(0);
      expect(report.outboundHeaderReceipts[0]?.tokenUsage?.outputTokens).toBeGreaterThan(0);
      expect(fixture.inboundHeaderReceipts[0]).toMatchObject({
        userAgent: expect.stringMatching(/^codex_cli_rs\//),
        originator: "codex_cli_rs",
        authorizationPresent: true,
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(liveConnection.apiKey);
      expect(serialized).not.toContain(liveConnection.headers["x-fixture-token"]);
      expect(serialized).not.toContain(liveConnection.baseUrl);
      expect(serialized).not.toContain("At 2026-01-01");
    } finally {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        fixture.server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
