import type { AgentRunRequest, ConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { isTerminatingReplyResult } from "./approval-effect.js";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  createTicketFinalizationEvidence,
  managedTicketEvidenceReader,
  TICKET_FINALIZATION_EVIDENCE_CHARS,
  ticketFinalizationRequest,
} from "./ticket-finalization.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    let complete = "";
    let textOffset: number | null = 0;
    while (textOffset !== null) {
      const page = evidence.read({ source: "observations", id: "1", textOffset });
      if (!("text" in page)) throw new Error("Missing first observation");
      complete += page.text;
      textOffset = page.nextTextOffset;
    }
    expect(JSON.parse(complete)).toMatchObject({
      executionId: "read-0",
      result: `${"x".repeat(20_000)}unique-tail-0`,
    });
  });
});

describe("ticket receipt phase", () => {
  it("retrieves the actual launch arguments and complete saved audit for the active assignment", async () => {
    const ticket = {
      id: "ticket-1",
      spaceId: "space",
      createdByUserId: "owner",
      originThreadId: "origin-thread",
      originMessageId: "origin-message",
      originGeneration: 2,
      controlEpoch: 4,
    };
    const ticketLookup = vi.fn().mockResolvedValue(ticket);
    const originLookup = vi.fn().mockResolvedValue({ historyCompactionGeneration: 2 });
    const launch = {
      id: "launch",
      runId: "origin-run",
      route: { connectorId: "mcp", toolName: "phone_start" },
      status: "completed",
      request: { agent: "codex", cwd: "/fixture/work", message: "Inspect the report." },
      operationKey: "fixture-operation",
      result: {
        operation: { operationKey: "fixture-operation", state: "completed" },
        operationResult: "Saved original result",
        session: { result: "Unrelated session result" },
      },
    };
    const launchLookup = vi.fn().mockResolvedValue([launch]);
    const nativeLookup = vi.fn().mockResolvedValue({
      route: { ...launch.route, resourceId: "connection-1" },
      connectionId: "connection-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const secret = 'fixture-"audit-credential"';
    const audit = {
      id: "audit",
      runId: "origin-run",
      kind: "shell",
      status: "completed",
      request: { command: "git diff -- report.txt" },
      result: { stdout: `diff --git a/report.txt b/report.txt\n${"🙂".repeat(3_000)}${secret}` },
    };
    const auditLookup = vi.fn().mockResolvedValue([audit]);
    const prisma = {
      ticket: { findFirst: ticketLookup },
      thread: { findFirst: originLookup },
      message: { findFirst: vi.fn().mockResolvedValue({ id: ticket.originMessageId }) },
      externalAgentExecution: { findMany: launchLookup, findFirst: nativeLookup },
      externalEffect: { findMany: auditLookup },
    } as unknown as PrismaClient;
    const nativeRead = vi.fn(async function* () {
      yield {
        type: "result" as const,
        data: {
          structuredContent: {
            session: { id: "session-1", turnId: "turn-2", status: "idle" },
            events: [
              { seq: 1, type: "tool", turnId: "turn-1", detail: "git diff output" },
              { seq: 2, type: "tool", turnId: "turn-2", detail: "unrelated turn" },
              { seq: 3, type: "result", turnId: "turn-1", text: "terminal result" },
            ],
            cursor: 3,
            hasMore: true,
          },
        },
      };
    });
    const original = request();
    const controller = new AbortController();
    const phase = ticketFinalizationRequest(original, {
      ticketId: ticket.id,
      evidence: "",
      managedEvidence: managedTicketEvidenceReader(
        prisma,
        {
          id: original.runId,
          spaceId: ticket.spaceId,
          userId: ticket.createdByUserId,
          botId: original.botId,
          workControlEpoch: 4,
          workRequirementsVersion: 3,
        },
        {
          ticketId: ticket.id,
          workerId: "worker",
          fence: 7,
          secrets: [secret],
          controller,
          context: {
            operationId: original.runId,
            traceId: original.runId,
            spaceId: ticket.spaceId,
            userId: ticket.createdByUserId,
            botId: original.botId,
            signal: controller.signal,
          },
        },
        undefined,
        { execute: nativeRead } as unknown as ConnectorProvider,
      ),
    });
    const read = (args: Record<string, unknown>) =>
      phase.executeTool!("read_work_evidence", args, "evidence-read");
    const entries = await read({ source: "executions" });
    expect(entries).toMatchObject({ entries: [expect.objectContaining({ id: "launch" })] });
    expect(launchLookup.mock.lastCall?.[0].select).not.toHaveProperty("request");
    const saved = (await read({ source: "executions", id: "launch" })) as { text: string };
    expect(JSON.parse(saved.text).request).toEqual(launch.request);
    expect(JSON.parse(saved.text).request).not.toHaveProperty("model");
    expect(JSON.parse(saved.text).result).toEqual({
      operation: launch.result.operation,
      operationResult: launch.result.operationResult,
    });
    expect(saved.text).not.toContain("Unrelated session result");
    expect(launchLookup.mock.lastCall?.[0].where).toEqual({
      id: "launch",
      spaceId: ticket.spaceId,
      userId: ticket.createdByUserId,
      ownerBotId: original.botId,
      ticketId: ticket.id,
      controlEpoch: 4,
    });
    expect(ticketLookup.mock.lastCall?.[0].where).toMatchObject({
      executions: { some: { id: original.runId, leaseOwner: "worker", leaseFence: 7 } },
    });
    let auditText = "";
    let textOffset: number | null = 0;
    while (textOffset !== null) {
      const page = (await read({ source: "tools", id: "audit", textOffset })) as {
        text: string;
        nextTextOffset: number | null;
      };
      auditText += page.text;
      textOffset = page.nextTextOffset;
    }
    expect(JSON.parse(auditText)).toMatchObject({
      request: audit.request,
      result: { stdout: audit.result.stdout.replace(secret, "[redacted]") },
    });
    expect(auditLookup.mock.lastCall?.[0].where).toMatchObject({
      id: "audit",
      run: { ticketId: ticket.id, userId: ticket.createdByUserId, workControlEpoch: 4 },
    });
    const native = (await read({ source: "nativeEvents", id: "launch" })) as {
      text: string;
      nextId: string;
    };
    expect(JSON.parse(native.text)).toEqual([
      { seq: 1, type: "tool", turnId: "turn-1", detail: "git diff output" },
    ]);
    expect(native.nextId).toBe("3");
    expect(nativeRead).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tool: "phone_read",
        route: expect.objectContaining({ resourceId: "connection-1" }),
        args: expect.objectContaining({ sessionId: "session-1", after: 0, waitMs: 0 }),
      }),
      expect.objectContaining({ userId: ticket.createdByUserId }),
    );
    expect(await read({ source: "executions", ticketId: "foreign" })).toHaveProperty("error");
    expect(
      await read({ source: "nativeEvents", id: "launch", sessionId: "foreign" }),
    ).toHaveProperty("error");
    originLookup.mockResolvedValue({ historyCompactionGeneration: 3 });
    await expect(read({ source: "executions", id: "launch" })).rejects.toThrow(
      "Managed work assignment or original request is no longer active.",
    );
    expect(controller.signal.aborted).toBe(true);
    expect(launchLookup).toHaveBeenCalledTimes(2);
    expect(original.executeTool).not.toHaveBeenCalled();
  });

  it.each(["clear", "stop", "reassign"] as const)(
    "aborts the finalizer when %s invalidates an in-flight native evidence read",
    async (scenario) => {
      const original = request();
      const controller = new AbortController();
      const entered = deferred<AbortSignal>();
      const release = deferred<void>();
      const ticket = {
        id: "ticket-1",
        spaceId: "space",
        createdByUserId: "owner",
        originThreadId: "origin-thread",
        originMessageId: "origin-message",
        originGeneration: 2,
        controlEpoch: 4,
        assigneeBotId: original.botId,
        stopRequestedAt: null as Date | null,
      };
      const ticketLookup = vi.fn(
        async ({ where }: { where: { assigneeBotId: string; stopRequestedAt: Date | null } }) =>
          where.assigneeBotId === ticket.assigneeBotId &&
          where.stopRequestedAt === ticket.stopRequestedAt
            ? ticket
            : null,
      );
      const originLookup = vi.fn().mockResolvedValue({ historyCompactionGeneration: 2 });
      const prisma = {
        ticket: { findFirst: ticketLookup },
        thread: { findFirst: originLookup },
        message: { findFirst: vi.fn().mockResolvedValue({ id: ticket.originMessageId }) },
        externalAgentExecution: {
          findFirst: vi.fn().mockResolvedValue({
            route: { connectorId: "mcp", toolName: "phone_start", resourceId: "connection-1" },
            connectionId: "connection-1",
            sessionId: "session-1",
            turnId: "turn-1",
          }),
        },
      } as unknown as PrismaClient;
      const connector: Pick<ConnectorProvider, "execute"> = {
        async *execute(_call, context) {
          entered.resolve(context.signal);
          await release.promise;
          yield {
            type: "result",
            data: {
              structuredContent: {
                session: { id: "session-1", status: "idle" },
                events: [{ seq: 1, type: "tool", turnId: "turn-1", detail: "Retired evidence" }],
                cursor: 1,
                hasMore: false,
              },
            },
          };
        },
      };
      const phase = ticketFinalizationRequest(original, {
        ticketId: ticket.id,
        evidence: "",
        managedEvidence: managedTicketEvidenceReader(
          prisma,
          {
            id: original.runId,
            spaceId: ticket.spaceId,
            userId: ticket.createdByUserId,
            botId: original.botId,
            workControlEpoch: 4,
            workRequirementsVersion: 3,
          },
          {
            ticketId: ticket.id,
            workerId: "worker",
            fence: 7,
            secrets: [],
            context: {
              operationId: original.runId,
              traceId: original.runId,
              spaceId: ticket.spaceId,
              userId: ticket.createdByUserId,
              botId: original.botId,
              signal: controller.signal,
            },
            controller,
          },
          undefined,
          connector as ConnectorProvider,
        ),
      });
      const read = phase.executeTool!(
        "read_work_evidence",
        { source: "nativeEvents", id: "launch" },
        "read",
      );
      try {
        const signal = await Promise.race([
          entered.promise,
          read.then(() => {
            throw new Error("Evidence read finished before entering the connector");
          }),
        ]);
        expect(signal.aborted).toBe(false);
        if (scenario === "clear") {
          originLookup.mockResolvedValue({ historyCompactionGeneration: 3 });
        } else if (scenario === "stop") {
          ticket.stopRequestedAt = new Date();
        } else {
          ticket.assigneeBotId = "successor";
        }
        release.resolve();
        await expect(read).rejects.toThrow(
          "Managed work assignment or original request is no longer active.",
        );
        expect(ticketLookup).toHaveBeenCalledTimes(2);
        expect(ticketLookup.mock.lastCall?.[0].where).toMatchObject({
          assigneeBotId: original.botId,
          stopRequestedAt: null,
          controlEpoch: 4,
          requirementsVersion: 3,
          executions: {
            some: {
              status: "running",
              leaseOwner: "worker",
              leaseFence: 7,
              leaseExpiresAt: { gt: expect.any(Date) },
              workControlEpoch: 4,
              workRequirementsVersion: 3,
            },
          },
        });
        expect(signal.aborted).toBe(true);
        await expect(
          phase.executeTool!("deliver_work", { result: {} }, "deliver"),
        ).rejects.toThrow("Managed work assignment or original request is no longer active.");
        expect(original.executeTool).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await read.catch(() => undefined);
      }
    },
  );

  it.each(["done", "review"] as const)(
    "ends after a committed %s receipt and does not write another version",
    async (status) => {
      const original = request();
      const receipt = { ok: true, status, version: 1, messageId: "receipt-1" };
      original.executeTool = vi.fn().mockResolvedValue(receipt);
      const phase = ticketFinalizationRequest(original, { ticketId: "ticket-1", evidence: "" });
      const result = {
        previousVersion: 0,
        summary: "Output delivered.",
        findings: [{ conclusion: "Source audit", outcome: "unknown", evidence: "No baseline." }],
      };
      const first = await phase.executeTool!("deliver_work", { result }, "first");
      expect(isTerminatingReplyResult(first)).toBe(true);
      expect(first).toMatchObject({
        details: receipt,
        content: [{ type: "text", text: result.summary }],
      });
      const second = await phase.executeTool!(
        "deliver_work",
        { result: { ...result, previousVersion: 1, summary: "Reworded only." } },
        "second",
      );
      expect(second).toBe(first);
      expect(original.executeTool).toHaveBeenCalledOnce();
    },
  );

  it("shares concurrent delivery and allows correction only after a rejected receipt", async () => {
    const original = request();
    let commit!: (result: unknown) => void;
    original.executeTool = vi
      .fn()
      .mockResolvedValueOnce({ error: "An evidence file is unavailable." })
      .mockImplementationOnce(() => new Promise((resolve) => (commit = resolve)));
    const phase = ticketFinalizationRequest(original, { ticketId: "ticket-1", evidence: "" });
    const result = {
      previousVersion: 0,
      summary: "Output delivered.",
      findings: [{ conclusion: "Output verified", outcome: "pass", evidence: "Read back." }],
    };
    expect(await phase.executeTool!("deliver_work", { result }, "rejected")).toHaveProperty(
      "error",
    );
    const first = phase.executeTool!("deliver_work", { result }, "first");
    const second = phase.executeTool!(
      "deliver_work",
      { result: { ...result, previousVersion: 1 } },
      "parallel",
    );
    commit({ ok: true, status: "done", version: 1, messageId: "receipt-1" });
    const delivered = await first;
    expect(await second).toBe(delivered);
    expect(isTerminatingReplyResult(delivered)).toBe(true);
    expect(original.executeTool).toHaveBeenCalledTimes(2);
  });

  it("only offers fixed file-delivery claims when the ticket has file requirements", () => {
    const dynamic = ticketFinalizationRequest(request(), { ticketId: "ticket-1", evidence: "" });
    const fixed = ticketFinalizationRequest(request(), {
      ticketId: "ticket-1",
      evidence: "",
      hasFileRequirements: true,
    });
    const schema = (phase: AgentRunRequest) =>
      JSON.stringify(phase.tools.find((tool) => tool.name === "deliver_work")?.inputSchema);
    expect(schema(dynamic)).not.toContain('"fileDelivery"');
    expect(schema(dynamic)).toContain('"artifactIds"');
    expect(schema(fixed)).toContain('"fileDelivery"');
    expect(dynamic.prompt).toContain("omit fileDelivery");
  });

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
