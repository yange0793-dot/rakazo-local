import { randomUUID } from "node:crypto";
import type { ConnectorProvider } from "@rakazo/adapter-kit";
import { ManagedExternalInputSchema } from "@rakazo/contracts";
import type { PrismaClient, Run } from "@rakazo/db";
import { allocateTicketNumber, asSystem, createDb, ensureBoard, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeManagedExternalTool, reconcileExternalExecutions } from "./external-execution.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

suite("managed external execution persistence", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let fixtures: PrismaClient;
  let run: Run;
  const suffix = randomUUID();
  const tenant = { spaceId: `external-space-${suffix}`, userId: `external-user-${suffix}` };
  const orgId = `external-org-${suffix}`;
  const shutdown = new AbortController();
  const operationStates = new Map<string, string>();
  const operationTurns = new Map<string, string>();
  const operationSessions = new Map<string, string>();
  const calls: string[] = [];
  const fullResult = "The file is ready.".padEnd(14_000, ".");
  const connector = {
    async *execute(call: { args: Record<string, unknown>; route: { toolName: string } }) {
      const name = call.route.toolName;
      calls.push(name);
      const key = String(call.args.requestId ?? "");
      const session = {
        id: String(call.args.sessionId ?? operationSessions.get(key) ?? `session-${suffix}`),
        status: "idle",
        turnId: operationTurns.get(key) ?? "turn",
        cursor: 0,
      };
      const capabilities = {
        operationLookup: true,
        events: true,
        steer: true,
        cancelConfirmation: true,
        inputResponse: false,
      };
      let value: unknown;
      if (name === "phone_inspect" && !key) value = { protocolVersion: 1, capabilities };
      else if (name === "phone_start") {
        operationStates.set(key, "completed");
        value = { session, operation: { state: "completed", turnId: "turn" } };
      } else if (name === "phone_send") {
        operationStates.set(key, "completed");
        operationSessions.set(key, session.id);
        operationTurns.set(key, "continued-turn");
        value = {
          session: { ...session, cwd: "/tmp/continued-workspace" },
          operation: { state: "completed", turnId: "continued-turn" },
        };
      } else if (name === "phone_stop") {
        // Completion can win the native cancel race; it must not restart host work.
        operationStates.set(String(call.args.targetRequestId), "completed");
        value = { session, operation: { state: "completed", stopConfirmed: true } };
      } else if (name === "phone_inspect") {
        value = operationStates.has(key)
          ? {
              found: true,
              session,
              operation: { state: operationStates.get(key), turnId: session.turnId },
            }
          : { found: false };
      } else if (name === "phone_read") {
        const operationKey = `external-start-${suffix}`;
        const after = Number(call.args.after);
        const events =
          session.id === `session-${suffix}` && after === 0
            ? [{ seq: 1, type: "result", operationKey, text: fullResult }]
            : [];
        value = { session, events, cursor: events.length ? 1 : after, hasMore: false };
      } else throw new Error(`Unexpected call ${name}`);
      yield { type: "result" as const, data: { structuredContent: value } };
    },
  } as unknown as ConnectorProvider;

  beforeAll(async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    fixtures = asSystem(prisma);
    await fixtures.user.create({
      data: { id: tenant.userId, name: "Owner", email: `${suffix}@example.test` },
    });
    await fixtures.organization.create({
      data: { id: orgId, name: "Test", slug: orgId, createdAt: new Date() },
    });
    await fixtures.space.create({
      data: { id: tenant.spaceId, organizationId: orgId, name: "Test" },
    });
    const bot = await fixtures.bot.create({ data: { ...tenant, name: "Engineer", color: "blue" } });
    const thread = await fixtures.thread.create({
      data: { ...tenant, botId: bot.id, nextMessageSeq: 2 },
    });
    const message = await fixtures.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "user",
        authorUserId: tenant.userId,
        blocks: [{ kind: "text", text: "Produce the file." }],
      },
    });
    const task = await fixtures.task.create({
      data: {
        ...tenant,
        botId: bot.id,
        threadId: thread.id,
        status: "running",
        prompt: "Produce the file.",
      },
    });
    run = await fixtures.run.create({
      data: {
        ...tenant,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: "user",
        sourceMessageId: message.id,
        status: "running",
      },
    });
  });
  afterAll(async () => {
    shutdown.abort();
    vi.unstubAllEnvs();
    if (!db) return;
    await vi.waitFor(async () => {
      expect(
        await fixtures.externalAgentExecution.count({
          where: { spaceId: tenant.spaceId, leaseOwner: { not: null } },
        }),
      ).toBe(0);
    });
    await fixtures.externalAgentExecution.deleteMany({ where: { spaceId: tenant.spaceId } });
    await fixtures.organization.delete({ where: { id: orgId } });
    await fixtures.user.delete({ where: { id: tenant.userId } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  const deps = () => ({
    prisma,
    connector,
    ticketBoardEnabled: true,
    jobs: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    events: { notify: vi.fn().mockResolvedValue(undefined) },
    shutdownSignal: shutdown.signal,
  });

  async function seededExecution(name: string) {
    const board = await ensureBoard(fixtures, tenant.spaceId);
    const thread = await fixtures.thread.findUniqueOrThrow({ where: { id: run.threadId } });
    const ticket = await fixtures.$transaction(async (tx) =>
      tx.ticket.create({
        data: {
          boardId: board.id,
          number: await allocateTicketNumber(tx, board.id),
          spaceId: tenant.spaceId,
          title: name,
          status: "doing",
          createdByUserId: tenant.userId,
          createdByBotId: run.botId,
          assigneeBotId: run.botId,
          originThreadId: run.threadId,
          originMessageId: run.sourceMessageId,
          originGeneration: thread.historyCompactionGeneration,
          managedVersion: 1,
        },
      }),
    );
    const sourceRun = await fixtures.run.create({
      data: {
        ...tenant,
        botId: run.botId,
        threadId: run.threadId,
        taskId: run.taskId,
        sourceMessageId: run.sourceMessageId,
        trigger: "user",
        status: "completed",
        ticketId: ticket.id,
        workControlEpoch: ticket.controlEpoch,
        workRequirementsVersion: ticket.requirementsVersion,
      },
    });
    const execution = await fixtures.externalAgentExecution.create({
      data: {
        ...tenant,
        ownerBotId: run.botId,
        threadId: run.threadId,
        ticketId: ticket.id,
        runId: sourceRun.id,
        operationKey: `${name}-${suffix}`,
        connectionId: "connection",
        provider: "local-session",
        route: { connectorId: "mcp", resourceId: "connection", toolName: "phone_start" },
        request: { message: name },
        sessionId: `session-${name}-${suffix}`,
        turnId: `turn-${name}`,
        status: "running",
        operationState: "running",
        controlEpoch: ticket.controlEpoch,
      },
    });
    operationStates.set(execution.operationKey, "running");
    operationSessions.set(execution.operationKey, execution.sessionId!);
    operationTurns.set(execution.operationKey, execution.turnId!);
    return { ticket, execution };
  }

  function directCall(
    toolName: string,
    args: Record<string, unknown>,
    effectKey: string,
    overrides: Partial<ReturnType<typeof deps>> = {},
  ) {
    const context = {
      deps: { ...deps(), ...overrides },
      run,
      bot: { id: run.botId },
      source: { ownerStartedRun: true },
      context: {
        ...tenant,
        botId: run.botId,
        operationId: effectKey,
        traceId: effectKey,
        signal: shutdown.signal,
      },
    } as unknown as RunContext;
    const call = {
      effectKey,
      args,
      connectorCall: {
        route: { connectorId: "mcp", resourceId: "connection", toolName },
      },
    } as unknown as ToolCall;
    return runAsTenant(tenant, () => executeManagedExternalTool(context, call));
  }

  it("persists the binding before dispatch and replays a completed call without resending", async () => {
    const scopedDeps = deps();
    const context = {
      deps: scopedDeps,
      run,
      bot: { id: run.botId },
      source: { ownerStartedRun: true },
      context: {
        ...tenant,
        botId: run.botId,
        operationId: "start",
        traceId: "start",
        signal: shutdown.signal,
      },
    } as unknown as RunContext;
    const call = {
      effectKey: `external-start-${suffix}`,
      args: { agent: "codex", cwd: "/tmp", message: "Produce the file." },
      connectorCall: {
        route: { connectorId: "mcp", resourceId: "connection", toolName: "phone_start" },
      },
    } as unknown as ToolCall;
    const first = await runAsTenant(tenant, () => executeManagedExternalTool(context, call));
    expect(first).toMatchObject({ managed: true });
    const execution = await fixtures.externalAgentExecution.findUniqueOrThrow({
      where: { operationKey: call.effectKey },
    });
    expect(execution).toMatchObject({
      status: "completed",
      sessionId: `session-${suffix}`,
      result: { operationResult: fullResult },
    });
    expect(
      await fixtures.workEvent.count({
        where: { ticketId: execution.ticketId, kind: "external_completed" },
      }),
    ).toBe(1);
    const event = await fixtures.workEvent.findUniqueOrThrow({
      where: { eventKey: `external:${execution.id}:completed` },
    });
    expect(event.payload).toMatchObject({
      connectionId: "connection",
      cursor: "1",
      cwd: "/tmp",
      result: fullResult,
      instruction: expect.stringContaining(
        "The referenced provider's filesystem is separate from other connectors.",
      ),
    });
    const repeated = await runAsTenant(tenant, () => executeManagedExternalTool(context, call));
    expect(repeated).toMatchObject({ duplicate: true, executionId: execution.id });
    expect(calls.filter((name) => name === "phone_start")).toHaveLength(1);
  });

  it("reconciles an ambiguous send by lookup without replaying its side effect", async () => {
    const { execution: existing } = await seededExecution("ambiguous-source");
    await fixtures.externalAgentExecution.update({
      where: { id: existing.id },
      data: { status: "completed", operationState: "completed", completedAt: new Date() },
    });
    const pending = await fixtures.externalAgentExecution.create({
      data: {
        ...tenant,
        ownerBotId: existing.ownerBotId,
        threadId: existing.threadId,
        ticketId: existing.ticketId,
        runId: existing.runId,
        connectionId: existing.connectionId,
        provider: existing.provider,
        route: { connectorId: "mcp", resourceId: "connection", toolName: "phone_start" },
        request: { agent: "codex", cwd: "/tmp", message: "Produce the file." },
        operationKey: `unknown-${suffix}`,
        controlEpoch: existing.controlEpoch,
        sessionId: null,
        turnId: null,
        status: "unknown",
        operationState: "unknown",
        completedAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseFence: 0,
      },
    });
    const startsBefore = calls.filter((name) => name === "phone_start").length;
    await runAsTenant(tenant, () => reconcileExternalExecutions(deps()));
    await vi.waitFor(async () => {
      expect(
        await fixtures.workEvent.count({ where: { eventKey: `external:${pending.id}:unknown` } }),
      ).toBe(1);
    });
    expect(
      (
        await fixtures.workEvent.findUniqueOrThrow({
          where: { eventKey: `external:${pending.id}:unknown` },
        })
      ).payload,
    ).toMatchObject({ connectionId: "connection", cursor: "0", cwd: "/tmp" });
    expect(calls.filter((name) => name === "phone_start")).toHaveLength(startsBefore);
  });

  it("does not wake a coordinator from a late completion after direct phone_stop", async () => {
    const { ticket, execution } = await seededExecution("direct-stop");
    const { execution: unrelated } = await seededExecution("same-session-other-operation");
    await fixtures.externalAgentExecution.update({
      where: { id: unrelated.id },
      data: { sessionId: execution.sessionId },
    });
    const result = await directCall(
      "phone_stop",
      {
        sessionId: execution.sessionId,
        targetRequestId: execution.operationKey,
        expectedTurnId: execution.turnId,
      },
      `stop-${suffix}`,
    );
    expect(result).toMatchObject({ managed: true, operation: { stopConfirmed: true } });
    await vi.waitFor(
      async () => {
        const saved = await fixtures.externalAgentExecution.findUniqueOrThrow({
          where: { id: execution.id },
        });
        expect(saved).toMatchObject({ status: "completed", leaseOwner: null });
        expect(saved.stopRequestedAt).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(await fixtures.workEvent.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(
      await fixtures.externalAgentExecution.findUniqueOrThrow({ where: { id: unrelated.id } }),
    ).toMatchObject({ stopRequestedAt: null });
    expect(
      await fixtures.run.count({ where: { ticketId: ticket.id, trigger: "bot_message" } }),
    ).toBe(0);
  });

  it("reopens accepted work before a new phone_send and invalidates the old receipt", async () => {
    const { ticket, execution } = await seededExecution("accepted-send");
    operationStates.set(execution.operationKey, "completed");
    await fixtures.externalAgentExecution.update({
      where: { id: execution.id },
      data: { status: "completed", operationState: "completed", completedAt: new Date() },
    });
    await fixtures.ticket.update({
      where: { id: ticket.id },
      data: {
        status: "done",
        completedAt: new Date(),
        receiptVersion: 3,
        acceptedRequirementsVersion: ticket.requirementsVersion,
        acceptedReceiptVersion: 3,
      },
    });
    const effectKey = `follow-up-${suffix}`;
    const result = await directCall(
      "phone_send",
      { sessionId: execution.sessionId, message: "Revise the delivered file." },
      effectKey,
    );
    expect(result).toMatchObject({ managed: true, ticketId: ticket.id });
    expect(
      (
        await fixtures.workEvent.findFirstOrThrow({
          where: { ticketId: ticket.id, kind: "external_completed" },
        })
      ).payload,
    ).toMatchObject({
      connectionId: "connection",
      cursor: "0",
      cwd: "/tmp/continued-workspace",
    });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      status: "doing",
      completedAt: null,
      receiptVersion: 3,
      requirementsVersion: ticket.requirementsVersion + 1,
      acceptedRequirementsVersion: null,
      acceptedReceiptVersion: null,
    });
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      ticketId: ticket.id,
      workRequirementsVersion: ticket.requirementsVersion + 1,
    });
    const sends = calls.filter((name) => name === "phone_send").length;
    const repeated = await directCall(
      "phone_send",
      { sessionId: execution.sessionId, message: "Revise the delivered file." },
      effectKey,
    );
    expect(repeated).toMatchObject({ duplicate: true });
    expect(calls.filter((name) => name === "phone_send")).toHaveLength(sends);
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).requirementsVersion,
    ).toBe(ticket.requirementsVersion + 1);
  });

  it.each(["inspect", "event replay"] as const)(
    "persists %s input questions across pages, empty polls and a restarted monitor",
    async (mode) => {
      const { ticket, execution } = await seededExecution(`input-${mode}`);
      const question = {
        seq: 1,
        type: "tool",
        status: "waiting_input",
        inputRequestId: `question-${mode}`,
        operationKey: execution.operationKey,
        turnId: execution.turnId!,
        inputResponseSupported: true,
        resumable: true,
        questions: [
          {
            id: "format",
            question: "Which report format should be used?",
            options: [{ label: "PDF", description: "A portable document." }],
          },
        ],
      };
      const native = {
        state: "running",
        pending: mode === "inspect" ? [question] : (undefined as unknown[] | undefined),
        events: [
          question,
          {
            seq: 2,
            type: "text",
            text: "Waiting for the requested format.",
            operationKey: execution.operationKey,
            turnId: execution.turnId!,
          },
        ] as Array<Record<string, unknown> & { seq: number }>,
        reads: 0,
      };
      const inputConnector = {
        async *execute(call: { args: Record<string, unknown>; route: { toolName: string } }) {
          const session = {
            id: execution.sessionId!,
            turnId: execution.turnId!,
            status: "running",
            cursor: native.events.at(-1)?.seq ?? 0,
            cwd: "/tmp/input-workspace",
          };
          let value: unknown;
          if (call.route.toolName === "phone_inspect")
            value = {
              found: true,
              session,
              operation: { state: native.state, turnId: execution.turnId },
              ...(native.pending ? { pendingInputRequests: native.pending } : {}),
            };
          else if (call.route.toolName === "phone_read") {
            native.reads += 1;
            const after = Number(call.args.after);
            const events = native.events.filter((event) => event.seq > after).slice(0, 1);
            const cursor = events.at(-1)?.seq ?? after;
            value = { session, events, cursor, hasMore: cursor < session.cursor };
          } else throw new Error(`Unexpected input monitor call ${call.route.toolName}`);
          yield { type: "result" as const, data: { structuredContent: value } };
        },
      } as unknown as ConnectorProvider;
      let controller = new AbortController();
      const monitor = () =>
        directCall("phone_send", { sessionId: execution.sessionId }, execution.operationKey, {
          connector: inputConnector,
          shutdownSignal: controller.signal,
        });
      const saved = () =>
        fixtures.externalAgentExecution.findUniqueOrThrow({ where: { id: execution.id } });
      try {
        await monitor();
        await vi.waitFor(
          async () => {
            expect(native.reads).toBeGreaterThanOrEqual(4);
            expect(await saved()).toMatchObject({
              status: "waiting_input",
              cursor: "2",
              result: { pendingInputRequests: [question] },
            });
          },
          { timeout: 10_000 },
        );
        const inputEvent = await fixtures.workEvent.findUniqueOrThrow({
          where: { eventKey: `external:${execution.id}:${question.inputRequestId}` },
        });
        expect(ManagedExternalInputSchema.safeParse(inputEvent.payload).success).toBe(true);
        expect(inputEvent.payload).toMatchObject({
          executionId: execution.id,
          operationKey: execution.operationKey,
          connectionId: "connection",
          sessionId: execution.sessionId,
          turnId: execution.turnId,
          controlEpoch: ticket.controlEpoch,
          requirementsVersion: ticket.requirementsVersion,
          inputResponseSupported: true,
          resumable: true,
          question: question.questions[0]!.question,
          questions: question.questions,
          inputRequest: question,
        });
        controller.abort();
        await vi.waitFor(async () => expect((await saved()).leaseOwner).toBeNull(), {
          timeout: 10_000,
        });
        const readsBeforeRestart = native.reads;
        controller = new AbortController();
        await monitor();
        await vi.waitFor(
          async () => {
            expect(native.reads).toBeGreaterThanOrEqual(readsBeforeRestart + 2);
            expect((await saved()).status).toBe("waiting_input");
          },
          { timeout: 5_000 },
        );
        expect(
          await fixtures.workEvent.count({
            where: { ticketId: ticket.id, kind: "external_input" },
          }),
        ).toBe(1);

        native.pending = mode === "inspect" ? [] : undefined;
        native.events.push({
          seq: 3,
          type: "input_resolved",
          inputRequestId: question.inputRequestId,
          turnId: execution.turnId!,
        });
        await vi.waitFor(
          async () =>
            expect(await saved()).toMatchObject({
              status: "running",
              cursor: "3",
              result: { pendingInputRequests: [] },
            }),
          { timeout: 5_000 },
        );

        native.state = "completed";
        native.pending = mode === "inspect" ? [question] : undefined;
        native.events.push(
          {
            seq: 4,
            type: "result",
            text: "The report is ready.",
            operationKey: execution.operationKey,
            turnId: execution.turnId,
          },
          {
            seq: 5,
            type: "input_resolved",
            inputRequestId: question.inputRequestId,
            turnId: execution.turnId!,
          },
        );
        await vi.waitFor(
          async () =>
            expect(await saved()).toMatchObject({
              status: "completed",
              cursor: "5",
              leaseOwner: null,
              result: { pendingInputRequests: [], operationResult: "The report is ready." },
            }),
          { timeout: 5_000 },
        );
        expect(
          await fixtures.workEvent.count({
            where: { ticketId: ticket.id, kind: "external_input" },
          }),
        ).toBe(1);
        expect(
          await fixtures.workEvent.findUniqueOrThrow({
            where: { eventKey: `external:${execution.id}:completed` },
          }),
        ).toMatchObject({ payload: { result: "The report is ready." } });
      } finally {
        controller.abort();
        await vi.waitFor(async () => expect((await saved()).leaseOwner).toBeNull(), {
          timeout: 10_000,
        });
      }
    },
  );
});
