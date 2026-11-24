import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import {
  logLoopGuardStop,
  logToolRefusal,
  toolCompletionAuditPayload,
} from "./tool-completion-audit.js";
import { refusal } from "./tool-refusal.js";

const target = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  trigger: "bot_message",
};

function capture() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink;
}

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("lesson read audit", () => {
  const source = { id: "fact-1", revision: 3, botId: "bot-1", scope: "shared", kind: "durable" };
  const exactResult = {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "PRIVATE_BODY SYNTHETIC_SECRET" }],
    details: {
      ok: true,
      operation: "read",
      kind: "fact",
      shown: 1,
      omitted: 0,
      sourceFact: source,
    },
  };

  it("records only source coordinates from a successful complete exact read", () => {
    const audit = toolCompletionAuditPayload(
      {
        name: "recall_memory",
        executionId: "read-1",
        durationMs: 1,
        result: exactResult,
      },
      ["SYNTHETIC_SECRET"],
    );
    expect(audit.memory).toEqual({
      kind: "durable",
      operation: "read",
      references: [{ id: "fact-1", revision: 3 }],
      sources: [source],
      omitted: [],
    });
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_BODY|SYNTHETIC_SECRET/);
  });

  it.each([
    { operation: "recall" },
    { shown: 0, omitted: 1 },
    { ok: false },
    { sourceFact: { ...source, revision: 0 } },
    { sourceFact: { ...source, content: "PRIVATE_BODY" } },
    { sourceFact: { ...source, id: "SYNTHETIC_SECRET" } },
  ])("does not claim authoritative reads for ineligible metadata %j", (details) => {
    const audit = toolCompletionAuditPayload(
      {
        name: "recall_memory",
        executionId: "read-1",
        durationMs: 1,
        result: { ...exactResult, details: { ...exactResult.details, ...details } },
      },
      ["SYNTHETIC_SECRET"],
    );
    expect(audit.memory).toBeUndefined();
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_BODY|SYNTHETIC_SECRET/);
  });

  it("does not turn an errored, paused, or empty exact result into an observed source", () => {
    for (const completion of [
      { result: exactResult, error: "failed" },
      { result: exactResult, paused: true },
      { result: { ...exactResult, content: [] } },
    ]) {
      expect(
        toolCompletionAuditPayload({
          name: "recall_memory",
          executionId: "read-1",
          durationMs: 1,
          ...completion,
        }).memory,
      ).toBeUndefined();
    }
  });

  it("retains exact read references without copying lesson contents", () => {
    const audit = toolCompletionAuditPayload({
      name: "recall_memory",
      executionId: "read-1",
      durationMs: 1,
      result: {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Private lesson body." }],
        details: {
          kind: "lesson",
          operation: "read",
          id: "lesson-1",
          revision: 3,
          shown: 1,
        },
      },
    });
    expect(audit.memory).toEqual({
      kind: "lesson",
      operation: "read",
      references: [{ id: "lesson-1", revision: 3 }],
      omitted: [],
    });
    expect(JSON.stringify(audit)).not.toContain("Private lesson body");
  });

  it("distinguishes discovery and body-budget omission from reading", () => {
    const audit = toolCompletionAuditPayload({
      name: "recall_memory",
      executionId: "recall-1",
      durationMs: 1,
      result: {
        kind: "agent_tool_result",
        content: [],
        details: {
          kind: "lesson",
          references: [{ id: "lesson-1", revision: 3 }],
          omitted: [{ id: "lesson-1", revision: 3, reason: "body_budget" }],
        },
      },
    });
    expect(audit.memory).toMatchObject({
      operation: "recall",
      references: [{ id: "lesson-1", revision: 3 }],
      omitted: ["body_budget"],
    });
  });
});

describe("tool refusal log", () => {
  it("logs a refused call by its code, with the run it happened in", () => {
    const sink = capture();
    const refused = refusal("run_not_owner_started", 'No bot named "Chief". Ask the owner.');
    expect(refused).toEqual({ error: 'No bot named "Chief". Ask the owner.' });
    expect(logToolRefusal(target, "update_bot", refused)).toEqual({
      code: "run_not_owner_started",
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "agent.tool.refused",
        "run.id": "run-1",
        "run.trigger": "bot_message",
        tool: "update_bot",
        "tool.refusal": "run_not_owner_started",
      }),
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("Chief");
  });

  it("logs nothing for an error that carries no code", () => {
    const sink = capture();
    expect(logToolRefusal(target, "crm_search", { error: "upstream said: private" })).toBe(
      undefined,
    );
    expect(logToolRefusal(target, "update_bot", { terminate: true })).toBeUndefined();
    expect(sink.events).toEqual([]);
  });
});

describe("loop guard stop log", () => {
  it("names the tool, the count and the refusal it kept getting", () => {
    const sink = capture();
    logLoopGuardStop(target, {
      tool: "update_bot",
      reason: "repeated_calls",
      count: 6,
      failures: 5,
      refusal: { code: "run_not_owner_started", target: "crm_update" },
    });
    logLoopGuardStop(target, {
      tool: "computer_act",
      reason: "over_limit_actions",
      count: 4,
      failures: 0,
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        message: "run.loop_guard_stopped",
        "run.id": "run-1",
        tool: "update_bot",
        "loop.reason": "repeated_calls",
        "loop.count": 6,
        "loop.failures": 5,
        "tool.target": "crm_update",
        "tool.refusal": "run_not_owner_started",
      }),
      expect.not.objectContaining({ "tool.refusal": expect.anything() }),
    ]);
  });
});
