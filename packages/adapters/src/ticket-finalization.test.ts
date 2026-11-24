import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  createTicketFinalizationEvidence,
  TICKET_FINALIZATION_EVIDENCE_CHARS,
  ticketFinalizationRequest,
} from "./ticket-finalization.js";

function request(): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: "fixture-run",
    prompt: "Publish the report.",
    instructions: "Fixture instructions.",
    history: [{ role: "user", content: "Earlier context." }],
    tools: builtinAgentTools,
    model: {
      provider: "openai-compatible",
      id: "fixture-model",
      thinkingLevel: "high",
      reasoning: true,
    },
    executeTool: vi.fn(async () => ({ ok: true })),
  };
}

describe("ticket finalization evidence", () => {
  it("retains actual outcomes, redacts secrets and omits binary observations", () => {
    const secrets = ['fixture-"secret'];
    const evidence = createTicketFinalizationEvidence(secrets);
    evidence.observe({
      name: "read_file",
      executionId: "read-1",
      durationMs: 5,
      result: {
        content: [
          { type: "text", text: `unique-evidence ${secrets[0]} late-secret` },
          { type: "image", data: "image-bytes" },
        ],
        bytes: new Uint8Array([1, 2]),
      },
    });
    evidence.observe({
      name: "failed_read",
      executionId: "read-2",
      durationMs: 3,
      error: new Error(`Missing ${secrets[0]}`),
    });
    evidence.observe({
      name: "ask_user",
      executionId: "paused",
      durationMs: 1,
      paused: true,
    });
    secrets.push("late-secret");
    const text = evidence.text();
    const snapshot = JSON.parse(text);
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations[0]).toMatchObject({
      tool: "read_file",
      executionId: "read-1",
      outcome: "succeeded",
      result: expect.stringContaining("unique-evidence"),
    });
    expect(snapshot.observations[1]).toMatchObject({
      outcome: "failed",
      error: "Missing [redacted]",
    });
    expect(text).not.toContain("image-bytes");
    expect(text).not.toContain("late-secret");
    expect(text).not.toContain("fixture-");
    expect(text).toContain('"omittedObservations":0');
  });

  it("keeps a bounded recent tail and makes missing or truncated evidence explicit", () => {
    const evidence = createTicketFinalizationEvidence([]);
    for (let index = 0; index < 50; index++) {
      evidence.observe({
        name: "read_file",
        executionId: `read-${index}`,
        durationMs: 1,
        result: `${"x".repeat(20_000)}unique-tail-${index}`,
      });
    }
    const text = evidence.text();
    const snapshot = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(TICKET_FINALIZATION_EVIDENCE_CHARS + 100);
    expect(snapshot.omittedObservations).toBeGreaterThan(0);
    expect(snapshot.observations.length).toBeLessThanOrEqual(16);
    expect(snapshot.observations.at(-1)).toMatchObject({ executionId: "read-49" });
    expect(text).toContain("unique-tail-49");
    expect(text).toContain("[observation truncated]");
    expect(text).not.toContain('"executionId":"read-0"');
  });
});

describe("ticket receipt phase", () => {
  it("retains the selected model, effort, usage hook and original request without resuming actions", () => {
    const original = request();
    original.onUsage = vi.fn();
    original.claimSteering = vi.fn();
    original.turnCheckpoint = "old-transcript";
    original.onCheckpoint = vi.fn();
    original.resumeFromCheckpoint = "old-interaction";
    original.resumeToolResult = { content: [{ type: "text", text: "approved" }] };
    original.computerModel = { ...original.model, id: "computer-model" };
    original.script = [{ toolCalls: [{ name: "write_file", args: {} }] }];
    const phase = ticketFinalizationRequest(original, {
      ticketId: "ticket-1",
      evidence: "unique-observation",
      draft: "Draft only",
    });
    expect(phase.model).toBe(original.model);
    expect(phase.onUsage).toBe(original.onUsage);
    expect(phase.history).toEqual([
      ...original.history,
      { role: "user", content: original.prompt },
    ]);
    expect(phase.prompt).toContain("unique-observation");
    expect(phase.prompt).toContain("Draft only");
    for (const key of [
      "turnCheckpoint",
      "onCheckpoint",
      "resumeFromCheckpoint",
      "resumeToolResult",
      "script",
      "computerModel",
      "claimSteering",
    ]) {
      expect(phase[key as keyof AgentRunRequest]).toBeUndefined();
    }
    expect(original.turnCheckpoint).toBe("old-transcript");
  });

  it("enforces evidence reads and a fixed-ticket delivery at the execution boundary", async () => {
    const original = request();
    const phase = ticketFinalizationRequest(original, { ticketId: "ticket-1", evidence: "" });
    expect(phase.tools.map((tool) => tool.name).sort()).toEqual([
      "deliver_work",
      "list_files",
      "read_file",
      "read_history",
      "search_history",
      "ticket_get",
    ]);
    for (const name of ["shell", "ticket_update", "run_subagent", "use_tool", "connector_write"]) {
      expect(await phase.executeTool!(name, {}, "forbidden")).toHaveProperty("error");
    }
    expect(
      await phase.executeTool!("deliver_work", { id: "other-ticket", result: {} }, "wrong-ticket"),
    ).toHaveProperty("error");
    expect(await phase.executeTool!("deliver_work", {}, "missing-result")).toHaveProperty("error");
    expect(original.executeTool).not.toHaveBeenCalled();
    await phase.executeTool!("read_file", { path: "report.txt" }, "read");
    const result = { previousVersion: 0, summary: "Fixture", findings: [] };
    await phase.executeTool!("deliver_work", { result }, "receipt");
    expect(original.executeTool).toHaveBeenNthCalledWith(
      1,
      "read_file",
      { path: "report.txt" },
      "read",
      undefined,
      undefined,
    );
    expect(original.executeTool).toHaveBeenNthCalledWith(
      2,
      "ticket_update",
      { id: "ticket-1", result },
      "receipt",
      undefined,
      undefined,
    );
  });

  it("does not widen disabled capabilities or replay an event-only runtime's script", () => {
    const original = request();
    original.tools = original.tools.filter((tool) => tool.name !== "ticket_update");
    expect(() =>
      ticketFinalizationRequest(original, { ticketId: "ticket-1", evidence: "" }),
    ).toThrow("available delivery tool");
    expect(() =>
      ticketFinalizationRequest(
        { ...request(), executeTool: undefined },
        { ticketId: "ticket-1", evidence: "" },
      ),
    ).toThrow("available delivery tool");
  });
});
