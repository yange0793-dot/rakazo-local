import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ConnectorProvider } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient, Run, Ticket, WorkEvent } from "@rakazo/db";
import {
  answerRunInput,
  asSystem,
  clearThread,
  createDb,
  createThreadEvents,
  createThreadMessageInTransaction,
  getManagedWorkAdmission,
  recordWorkEventInTransaction,
  requestManagedWorkStopInTransaction,
  runAsTenant,
  setManagedWorkDependenciesInTransaction,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";
import { returnHelperOutcome, startBackgroundHelper } from "./background-helpers.js";
import { messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { reconcileExternalExecutions } from "./external-execution.js";
import { ensureManagedWorkForRun, getManagedCoordinationWait } from "./managed-work.js";
import { admitManagedRun } from "./managed-work-admission.js";
import {
  prepareWorkEventWake,
  reconcileManagedWorkEvents,
  recordManagedChildOutcomeInTransaction,
  settleManagedWorkEventsForRun,
} from "./managed-work-events.js";
import { resumeManagedExternalInput } from "./managed-work-input.js";
import { claimRun, writeComputerRunRequeue } from "./run-lifecycle.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { deliverTicketWork } from "./ticket-delivery.js";
import { getTicket, updateTicket } from "./ticket-tools.js";
import { prepareTicketRun } from "./ticket-wake.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("managed work coordination (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let fixtures: PrismaClient;
  let artifactDirectory: string;
  let artifacts: LocalArtifactStore;
  const suffix = randomUUID();
  const userId = `work-user-${suffix}`;
  const organizationId = `work-org-${suffix}`;
  const spaceId = `work-space-${suffix}`;
  const tenant = { spaceId, userId };
  let chief: { id: string; name: string; threadId: string };
  let specialist: typeof chief;
  let reviewer: typeof chief;
  let run: Run;
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const deps = () =>
    ({
      prisma,
      artifacts,
      ticketBoardEnabled: true,
      jobs: { enqueue },
      events: { notify },
    }) as unknown as ExecutorDeps;
  const within = <T>(fn: () => Promise<T>) => runAsTenant(tenant, fn);

  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    prisma = db.prisma;
    fixtures = asSystem(prisma);
    artifactDirectory = await mkdtemp(path.join(tmpdir(), "managed-work-"));
    artifacts = new LocalArtifactStore(artifactDirectory);
    await fixtures.user.create({
      data: { id: userId, name: "Owner", email: `${suffix}@example.test` },
    });
    await fixtures.organization.create({
      data: { id: organizationId, name: "Test", slug: organizationId, createdAt: new Date() },
    });
    await fixtures.space.create({ data: { id: spaceId, organizationId, name: "Work" } });
    const makeBot = async (name: string) => {
      const bot = await fixtures.bot.create({
        data: { spaceId, userId, name, color: "blue" },
      });
      const thread = await fixtures.thread.create({
        data: { spaceId, userId, botId: bot.id },
      });
      return { id: bot.id, name: bot.name, threadId: thread.id };
    };
    chief = await makeBot("Coordinator");
    specialist = await makeBot("Specialist");
    reviewer = await makeBot("Reviewer");
  });
  beforeEach(async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
    enqueue.mockClear();
    notify.mockClear();
    await fixtures.externalAgentExecution.deleteMany({ where: { spaceId } });
    await fixtures.workEvent.deleteMany({ where: { spaceId } });
    await fixtures.ticket.deleteMany({ where: { spaceId } });
    await fixtures.run.deleteMany({ where: { spaceId } });
    await fixtures.task.deleteMany({ where: { spaceId } });
    await fixtures.message.deleteMany({ where: { thread: { spaceId } } });
    await fixtures.event.deleteMany({ where: { spaceId } });
    await fixtures.artifact.deleteMany({ where: { spaceId } });
    await fixtures.thread.updateMany({
      where: { spaceId },
      data: { nextMessageSeq: 0, nextEventSeq: 0, historyCompactionGeneration: 0 },
    });
    const message = await fixtures.message.create({
      data: {
        threadId: chief.threadId,
        seq: 0,
        role: "user",
        authorUserId: userId,
        blocks: [{ kind: "text", text: "Research the source and produce a verified report." }],
      },
    });
    await fixtures.thread.update({
      where: { id: chief.threadId },
      data: { nextMessageSeq: 1 },
    });
    const task = await fixtures.task.create({
      data: {
        spaceId,
        userId,
        botId: chief.id,
        threadId: chief.threadId,
        status: "running",
        prompt: "Research the source and produce a verified report.",
      },
    });
    run = await fixtures.run.create({
      data: {
        spaceId,
        userId,
        botId: chief.id,
        threadId: chief.threadId,
        taskId: task.id,
        trigger: "user",
        sourceMessageId: message.id,
        status: "running",
      },
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (!db) return;
    await fixtures.externalAgentExecution.deleteMany({ where: { spaceId } });
    await fixtures.organization.deleteMany({ where: { id: organizationId } });
    await fixtures.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    await db.pool.end();
    await rm(artifactDirectory, { recursive: true, force: true });
  });

  async function dispatch(
    key = "research",
    target = specialist,
    dependencies?: Array<{
      ticketId: string;
      requirementsVersion: number;
      receiptVersion?: number;
    }>,
  ) {
    return within(() =>
      messageBot(deps(), run, chief, {
        bot_id: target.id,
        message: `Produce ${key}.`,
        deliveryKey: `${run.id}:${key}`,
        dependencies,
      }),
    );
  }
  async function work() {
    const current = await fixtures.run.findUniqueOrThrow({ where: { id: run.id } });
    return fixtures.ticket.findUniqueOrThrow({ where: { id: current.ticketId! } });
  }
  async function child() {
    return fixtures.ticket.findFirstOrThrow({ where: { spaceId, parentTicketId: { not: null } } });
  }
  async function runFor(ticket: Ticket) {
    return fixtures.run.findFirstOrThrow({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: "desc" },
    });
  }
  async function recordOutcomeRead(event: WorkEvent, sourceRun = run) {
    const evidence = event.payload as Prisma.JsonObject;
    return fixtures.externalEffect.create({
      data: {
        spaceId,
        runId: sourceRun.id,
        kind: "mcp__fixture__phone_read",
        idempotencyKey: `read:${event.id}`,
        status: "completed",
        request: [
          "__rakazoCatalogTool",
          "connectors_execute_tool",
          { id: "server:phone_read", arguments: { sessionId: evidence.sessionId } },
          { connectorId: "mcp", resourceId: "server", toolName: "phone_read" },
        ] as Prisma.InputJsonArray,
        result: {
          structuredContent: {
            session: {
              id: evidence.sessionId,
              status: "idle",
              turnId: evidence.turnId,
              result: evidence.result,
              operations: [
                {
                  operationKey: evidence.operationKey,
                  turnId: evidence.turnId,
                  state: evidence.status,
                },
              ],
            },
          },
        } as Prisma.InputJsonObject,
      },
    });
  }
  async function completedChild() {
    await dispatch();
    const ticket = await child();
    const execution = await runFor(ticket);
    await fixtures.run.update({ where: { id: execution.id }, data: { status: "completed" } });
    await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
    return { ticket, execution };
  }
  async function external(ticket: Ticket) {
    return fixtures.externalAgentExecution.create({
      data: {
        spaceId,
        userId,
        ownerBotId: chief.id,
        threadId: chief.threadId,
        ticketId: ticket.id,
        runId: run.id,
        operationKey: randomUUID(),
        provider: "test",
        route: { kind: "test" },
        request: { text: "Produce output" },
        status: "running",
        operationState: "accepted",
        controlEpoch: ticket.controlEpoch,
      },
    });
  }

  async function newOwnerRun(
    options: { peer?: boolean; authorUserId?: string; replyToMessageId?: string } = {},
  ) {
    return within(() =>
      prisma.$transaction(async (tx) => {
        const message = await createThreadMessageInTransaction(tx, {
          threadId: chief.threadId,
          role: "user",
          ...(options.peer ? {} : { authorUserId: options.authorUserId ?? userId }),
          replyToMessageId: options.replyToMessageId,
          blocks: [{ kind: "text", text: "Continue the original work from its saved outputs." }],
        });
        const task = await tx.task.create({
          data: {
            spaceId,
            userId,
            botId: chief.id,
            threadId: chief.threadId,
            prompt: "Continue the original work from its saved outputs.",
            status: "running",
          },
        });
        return tx.run.create({
          data: {
            spaceId,
            userId,
            botId: chief.id,
            threadId: chief.threadId,
            taskId: task.id,
            sourceMessageId: message.id,
            trigger: options.peer ? "bot_message" : "user",
            status: "running",
          },
        });
      }),
    );
  }

  async function stopWork() {
    const stopped = await within(() =>
      prisma.$transaction((tx) =>
        requestManagedWorkStopInTransaction(tx, { spaceId, userId, threadId: chief.threadId }),
      ),
    );
    await fixtures.run.updateMany({
      where: { id: { in: stopped.runIds } },
      data: { status: "cancelled", completedAt: new Date() },
    });
    return stopped;
  }

  it("starts a managed helper with a ticket and returns its receipt through the parent event", async () => {
    const helper = {
      deps: deps(),
      run,
      runId: run.id,
      bot: { id: chief.id, name: chief.name },
      thread: { id: chief.threadId, botId: chief.id },
      model: { provider: "fixture", id: "model", thinkingLevel: null },
      source: { ownerAuthoredRun: true },
      secrets: [],
    } as never;
    const started = await within(() =>
      startBackgroundHelper(helper, {
        name: "source checker",
        task: "Verify the original source.",
        instructions: "",
        modelProvider: "",
        modelId: "",
        executionId: "helper-call",
        effectKey: "helper-managed-receipt",
      }),
    );
    expect(started).toMatchObject({ ok: true, ticketId: expect.any(String) });

    const parent = await work();
    const delegated = await child();
    const helperRun = await runFor(delegated);
    expect(parent).toMatchObject({
      originMessageId: run.sourceMessageId,
      originRunId: run.id,
      originThreadId: chief.threadId,
      managedVersion: 1,
    });
    expect(delegated).toMatchObject({
      parentTicketId: parent.id,
      originMessageId: run.sourceMessageId,
      originRunId: run.id,
      managedVersion: 1,
    });
    expect(helperRun).toMatchObject({
      trigger: "helper",
      ticketId: delegated.id,
      workControlEpoch: delegated.controlEpoch,
      workRequirementsVersion: delegated.requirementsVersion,
    });
    expect(
      await fixtures.workEvent.findFirstOrThrow({
        where: { ticketId: delegated.id, kind: "dispatch" },
      }),
    ).toMatchObject({ status: "handled", wakeRunId: helperRun.id });
    expect(
      await within(() => getManagedCoordinationWait(prisma, { spaceId, runId: run.id })),
    ).toMatchObject({
      waiting: true,
      childTicketIds: [delegated.id],
    });

    await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
    await fixtures.run.update({ where: { id: helperRun.id }, data: { status: "running" } });
    const result = {
      previousVersion: 0,
      summary: "Original source verified.",
      findings: [
        {
          conclusion: "The source supports the result",
          outcome: "pass",
          evidence: "Checked the source text.",
        },
      ],
    };
    expect(
      await within(() =>
        deliverTicketWork(deps(), helperRun, {
          id: delegated.id,
          result,
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "done", version: 1 });

    await fixtures.run.update({ where: { id: helperRun.id }, data: { status: "completed" } });
    await within(() =>
      returnHelperOutcome(deps(), helperRun, {
        status: "completed",
        text: "Original source verified.",
      }),
    );
    expect(
      await fixtures.run.findFirst({
        where: { spaceId, clientNonce: `helper-result:${helperRun.id}` },
      }),
    ).toBeNull();

    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    const outcome = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: parent.id, kind: "child_outcome", sourceRunId: helperRun.id },
    });
    expect(outcome.status).toBe("prepared");
    const wake = await fixtures.run.findUniqueOrThrow({ where: { id: outcome.wakeRunId! } });
    expect(wake).toMatchObject({ trigger: "bot_message", ticketId: parent.id });
    expect(
      await fixtures.message.findFirst({
        where: {
          threadId: chief.threadId,
          clientNonce: { startsWith: `work-receipt:${delegated.id}:1:` },
        },
      }),
    ).not.toBeNull();
  });

  it("defaults requests to one parent/child relationship and one bot_message execution", async () => {
    const result = await dispatch();
    expect(result).toMatchObject({ ok: true, managed: true, status: "delivered" });
    const parent = await work();
    const delegated = await child();
    const execution = await runFor(delegated);
    expect(delegated).toMatchObject({
      parentTicketId: parent.id,
      originMessageId: run.sourceMessageId,
      originRunId: run.id,
      originThreadId: chief.threadId,
      createdByUserId: userId,
    });
    expect(execution).toMatchObject({
      trigger: "bot_message",
      workControlEpoch: 0,
      workRequirementsVersion: 1,
    });
    const inbound = await fixtures.message.findUniqueOrThrow({
      where: { id: execution.sourceMessageId! },
    });
    expect(inbound.authorUserId).toBeNull();
    expect(inbound.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bot_message_received", text: "Produce research." }),
      ]),
    );
    const rawMessages = await within(
      () => prisma.$queryRaw<Array<{ blocks: unknown }>>`
      SELECT blocks FROM messages WHERE id = ${inbound.id}
    `,
    );
    expect(rawMessages).toHaveLength(1);
    expect(JSON.stringify(rawMessages[0]!.blocks)).not.toContain("Produce research.");
    const inboundEvent = await fixtures.event.findFirstOrThrow({
      where: { runId: execution.id, threadId: specialist.threadId, type: "thread.message.created" },
    });
    expect(inboundEvent.payload).toMatchObject({
      messageId: inbound.id,
      blocks: expect.arrayContaining([
        expect.objectContaining({ kind: "bot_message_received", text: "Produce research." }),
      ]),
    });
    const rawEvents = await within(
      () => prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM events WHERE id = ${inboundEvent.id}
    `,
    );
    expect(rawEvents).toHaveLength(1);
    expect(JSON.stringify(rawEvents[0]!.payload)).not.toContain("Produce research.");
    expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(1);
    expect(
      await within(() =>
        prisma.$transaction((tx) =>
          prepareTicketRun(tx, {
            spaceId,
            ticketId: delegated.id,
            botId: specialist.id,
          }),
        ),
      ),
    ).toBeNull();
    await dispatch();
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
    expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("continues the sole assignment without an explicit id, supersedes its old run, and replays the same ticket", async () => {
    await dispatch();
    const delegated = await child();
    const original = await runFor(delegated);
    await fixtures.run.update({ where: { id: original.id }, data: { status: "running" } });

    const sent = await dispatch("verified supplemental material");
    expect(sent).toMatchObject({ ok: true, managed: true, ticketId: delegated.id });
    const continued = await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } });
    expect(continued).toMatchObject({
      description: delegated.description,
      requirementsVersion: 2,
      controlEpoch: delegated.controlEpoch,
    });
    const replacement = await runFor(continued);
    expect(replacement).toMatchObject({
      status: "queued",
      workRequirementsVersion: 2,
      ticketId: delegated.id,
    });
    expect(replacement.id).not.toBe(original.id);
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      status: "cancelled",
      workRequirementsVersion: 1,
    });
    expect(await fixtures.task.findUniqueOrThrow({ where: { id: original.taskId } })).toMatchObject(
      {
        status: "cancelled",
      },
    );
    expect(await fixtures.ticketComment.findMany({ where: { ticketId: delegated.id } })).toEqual([
      expect.objectContaining({
        authorBotId: chief.id,
        body: "Produce verified supplemental material.",
      }),
    ]);
    expect(await dispatch("verified supplemental material")).toMatchObject({
      ok: true,
      status: "duplicate",
      managed: true,
      ticketId: delegated.id,
    });
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
    expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(2);
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } }))
        .requirementsVersion,
    ).toBe(2);
    expect(
      await within(() =>
        deliverTicketWork(deps(), original, {
          id: delegated.id,
          result: {
            previousVersion: 0,
            summary: "Old output",
            findings: [{ conclusion: "Finished", outcome: "pass", evidence: "Original output" }],
          },
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toHaveProperty("error", expect.stringContaining("requirements changed"));
    await within(() => returnBotMessageOutcome(deps(), original, specialist, "Late old result"));
    expect(
      await fixtures.workEvent.count({
        where: { sourceRunId: original.id, kind: "child_outcome" },
      }),
    ).toBe(0);
  });

  it.each([
    { intent: "fyi" as const, explicit: false },
    { intent: "fyi" as const, explicit: true },
    { intent: "status" as const, explicit: false },
    { intent: "status" as const, explicit: true },
  ])(
    "continues an existing assignment for $intent (explicit id: $explicit)",
    async ({ intent, explicit }) => {
      await dispatch();
      const delegated = await child();
      const original = await runFor(delegated);
      await fixtures.run.update({ where: { id: original.id }, data: { status: "running" } });
      expect(
        await within(() =>
          deliverTicketWork(deps(), original, {
            id: delegated.id,
            ownerAuthored: false,
            secrets: [],
            result: {
              previousVersion: 0,
              summary: "Outline only; awaiting sources.",
              findings: [
                { conclusion: "Sources pending", outcome: "unknown", evidence: "Outline." },
              ],
            },
          }),
        ),
      ).toMatchObject({ ok: true, status: "review" });
      await fixtures.run.update({ where: { id: original.id }, data: { status: "completed" } });
      const input = {
        bot_id: specialist.id,
        intent,
        message: "Verified source material for the existing report.",
        deliveryKey: `${run.id}:supplement`,
        ...(explicit ? { ticket_id: delegated.id } : {}),
      };
      const sent = await within(() => messageBot(deps(), run, chief, input));
      expect(sent).toMatchObject({ ok: true, managed: true, ticketId: delegated.id });
      const continued = await runFor(delegated);
      expect(continued).toMatchObject({
        ticketId: delegated.id,
        workRequirementsVersion: 2,
        status: "queued",
      });
      const received = await fixtures.message.findUniqueOrThrow({
        where: { id: continued.sourceMessageId! },
      });
      expect(received.blocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "bot_message_received", intent })]),
      );
      expect(
        (await fixtures.task.findUniqueOrThrow({ where: { id: continued.taskId } })).prompt,
      ).toContain(`managed ticket ${delegated.id}`);
      expect(await within(() => messageBot(deps(), run, chief, input))).toMatchObject({
        ok: true,
        status: "duplicate",
        managed: true,
        ticketId: delegated.id,
      });
      expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
      expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(2);
    },
  );

  it.each(["request", "fyi", "status", "question", "result"] as const)(
    "never ignores an incorrect parent ticket_id on a %s message",
    async (intent) => {
      await dispatch();
      const parent = await work();
      const delegated = await child();
      const messageCount = await fixtures.message.count({ where: { thread: { spaceId } } });
      const result = await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: specialist.id,
          intent,
          ticket_id: parent.id,
          message: "Additional source material.",
          deliveryKey: `${run.id}:wrong-ticket`,
        }),
      );
      expect(result).toMatchObject({ ok: false, error: expect.any(String) });
      if (intent === "fyi" || intent === "status")
        expect(result).toMatchObject({ error: expect.stringContaining(delegated.id) });
      expect(await fixtures.message.count({ where: { thread: { spaceId } } })).toBe(messageCount);
      expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
      expect(await fixtures.run.count({ where: { spaceId } })).toBe(2);
      expect(
        (await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } }))
          .requirementsVersion,
      ).toBe(1);
    },
  );

  it.each(["fyi", "status"] as const)(
    "leaves an unrelated %s message unmanaged without creating an assignment",
    async (intent) => {
      await dispatch();
      const sent = await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: reviewer.id,
          intent,
          message: "General information.",
          deliveryKey: `${run.id}:unrelated`,
        }),
      );
      expect(sent).toMatchObject({ ok: true, managed: false });
      const received = await fixtures.run.findFirstOrThrow({
        where: { spaceId, botId: reviewer.id },
      });
      expect(received.ticketId).toBeNull();
      expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
    },
  );

  it("keeps explicitly new work separate and refuses an ambiguous continuation without changing either assignment", async () => {
    await dispatch();
    const first = await child();
    const original = await runFor(first);
    const second = await within(() =>
      messageBot(deps(), run, chief, {
        bot_id: specialist.id,
        message: "Produce research.",
        deliveryKey: `${run.id}:separate`,
        new_task: true,
      }),
    );
    expect(second).toMatchObject({ ok: true, managed: true });
    const assignments = await fixtures.ticket.findMany({
      where: { spaceId, parentTicketId: first.parentTicketId, assigneeBotId: specialist.id },
    });
    expect(assignments).toHaveLength(2);
    const sibling = assignments.find((ticket) => ticket.id !== first.id)!;
    const siblingRun = await runFor(sibling);
    const messageCount = await fixtures.message.count({ where: { thread: { spaceId } } });
    expect(await dispatch("additional material")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Multiple assignments"),
    });
    for (const intent of ["fyi", "status"] as const)
      expect(
        await within(() =>
          messageBot(deps(), run, chief, {
            bot_id: specialist.id,
            intent,
            message: "Additional material.",
            deliveryKey: `${run.id}:ambiguous-${intent}`,
          }),
        ),
      ).toMatchObject({ ok: false, error: expect.stringContaining("Multiple assignments") });
    expect(await fixtures.message.count({ where: { thread: { spaceId } } })).toBe(messageCount);
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      status: "queued",
      workRequirementsVersion: 1,
    });
    expect(
      await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: specialist.id,
          ticket_id: first.id,
          message: "Revise this specific assignment.",
          deliveryKey: `${run.id}:specific`,
        }),
      ),
    ).toMatchObject({ ok: true, ticketId: first.id });
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: siblingRun.id } })).toMatchObject({
      status: "queued",
      workRequirementsVersion: 1,
    });
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(3);
    expect(
      await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: specialist.id,
          ticket_id: first.id,
          new_task: true,
          message: "Conflicting identity.",
          deliveryKey: `${run.id}:conflict`,
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("without ticket_id") });
  });

  it("resolves a reply to its original assignment and rejects conflicting or cross-parent identity", async () => {
    await dispatch();
    const first = await child();
    const original = await runFor(first);
    await within(() =>
      messageBot(deps(), run, chief, {
        bot_id: specialist.id,
        message: "A separate deliverable.",
        deliveryKey: `${run.id}:separate`,
        new_task: true,
      }),
    );
    const sibling = await fixtures.ticket.findFirstOrThrow({
      where: { parentTicketId: first.parentTicketId, id: { not: first.id } },
    });
    expect(
      await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: specialist.id,
          replyToId: original.sourceMessageId!,
          message: "Continue with these sources.",
          deliveryKey: `${run.id}:reply`,
        }),
      ),
    ).toMatchObject({ ok: true, ticketId: first.id });
    expect(
      await within(() =>
        messageBot(deps(), run, chief, {
          bot_id: specialist.id,
          ticket_id: sibling.id,
          replyToId: original.sourceMessageId!,
          message: "Conflicting references.",
          deliveryKey: `${run.id}:conflicting-reply`,
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("different work") });
    const owner = await newOwnerRun();
    expect(
      await within(() =>
        messageBot(deps(), owner, chief, {
          bot_id: specialist.id,
          ticket_id: first.id,
          message: "Different parent request.",
          deliveryKey: `${owner.id}:foreign-parent`,
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("owner and parent") });
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).ticketId).toBeNull();
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(3);
  });

  it("replaces a waiting dispatch on the same ticket and starts only the latest continuation", async () => {
    await dispatch("source");
    const source = await child();
    const dependencies = [{ ticketId: source.id, requirementsVersion: 1 }];
    await dispatch("draft", reviewer, dependencies);
    const document = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: reviewer.id },
    });
    const previous = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: document.id, kind: "dispatch" },
    });
    expect(await dispatch("draft with additional sources", reviewer)).toMatchObject({
      ok: true,
      status: "waiting",
      ticketId: document.id,
    });
    expect(
      (await fixtures.workEvent.findUniqueOrThrow({ where: { id: previous.id } })).status,
    ).toBe("suppressed");
    expect(await fixtures.ticketDependency.count({ where: { ticketId: document.id } })).toBe(1);
    expect(await fixtures.run.count({ where: { ticketId: document.id } })).toBe(0);
    await fixtures.ticket.update({
      where: { id: source.id },
      data: { acceptedRequirementsVersion: 1, acceptedReceiptVersion: 1 },
    });
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    const execution = await runFor(document);
    expect(execution).toMatchObject({ status: "queued", workRequirementsVersion: 2 });
    expect(
      (await fixtures.task.findUniqueOrThrow({ where: { id: execution.taskId } })).prompt,
    ).toContain("draft with additional sources");
    expect(await fixtures.run.count({ where: { ticketId: document.id } })).toBe(1);
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(3);
  });

  it("keeps legacy messages explicitly unmanaged and creates no tickets when receipts are disabled", async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
    expect(await dispatch()).toMatchObject({ ok: true, managed: false });
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(0);
  });

  it("rejects a peer message pretending to be a new owner request without changing either chat", async () => {
    await fixtures.message.update({
      where: { id: run.sourceMessageId! },
      data: { authorUserId: null },
    });
    const before = await fixtures.message.count({ where: { thread: { spaceId } } });
    expect(await dispatch()).toMatchObject({ ok: false });
    expect(await fixtures.message.count({ where: { thread: { spaceId } } })).toBe(before);
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(0);
  });

  it("reads the current run link even if the supplied Run snapshot is stale", async () => {
    await dispatch();
    const parent = await work();
    expect(run.ticketId).toBeNull();
    expect(
      await within(() =>
        ensureManagedWorkForRun(deps(), run, {
          brief: "Continue",
          operationKey: "external-one",
        }),
      ),
    ).toEqual({ ticketId: parent.id, controlEpoch: 0 });
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
  });

  it("records a dependency without starting a Run, then starts once only after the required acceptance", async () => {
    await dispatch("source");
    const first = await child();
    expect(
      await dispatch("review", reviewer, [
        {
          ticketId: first.id,
          requirementsVersion: 1,
        },
      ]),
    ).toMatchObject({ ok: true, status: "waiting", managed: true });
    const second = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: reviewer.id },
    });
    const event = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: second.id, kind: "dispatch" },
    });
    expect(await fixtures.run.count({ where: { ticketId: second.id } })).toBe(0);
    await fixtures.ticket.update({ where: { id: first.id }, data: { status: "done" } });
    expect(await within(() => prepareWorkEventWake(prisma, { eventId: event.id }))).toMatchObject({
      status: "waiting",
    });
    await fixtures.ticket.update({
      where: { id: first.id },
      data: { acceptedRequirementsVersion: 1, acceptedReceiptVersion: 1 },
    });
    await within(() =>
      Promise.all([
        prepareWorkEventWake(prisma, { eventId: event.id }),
        prepareWorkEventWake(prisma, { eventId: event.id }),
      ]),
    );
    expect(await fixtures.run.count({ where: { ticketId: second.id } })).toBe(1);
    expect((await runFor(second)).trigger).toBe("bot_message");
    await within(() =>
      updateTicket(deps(), {
        spaceId,
        userId,
        botId: chief.id,
        runId: run.id,
        threadId: chief.threadId,
        id: first.id,
        description: "Use the revised source.",
      }),
    );
    expect(
      await within(() => getManagedWorkAdmission(prisma, { spaceId, ticketId: second.id })),
    ).toMatchObject({ admitted: false, reason: "dependencies" });
    const changed = await fixtures.workEvent.findFirstOrThrow({
      where: { spaceId, kind: "dependency_changed" },
    });
    expect(changed).toMatchObject({ ticketId: (await work()).id, targetBotId: chief.id });
  });

  it("continues the current owner's run after dependency registration and delivers without a replacement wake", async () => {
    await dispatch("source");
    const source = await child();
    const sourceRun = await runFor(source);
    await dispatch("document", reviewer);
    const document = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: reviewer.id },
    });
    const execution = await runFor(document);
    await fixtures.run.updateMany({
      where: { id: { in: [sourceRun.id, execution.id] } },
      data: { status: "running" },
    });
    expect(
      await within(() =>
        updateTicket(deps(), {
          spaceId,
          userId,
          botId: reviewer.id,
          runId: execution.id,
          threadId: reviewer.threadId,
          id: document.id,
          dependencies: [{ ticketId: source.id, requirementsVersion: 1 }],
        }),
      ),
    ).toHaveProperty("ticket.id", document.id);
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: execution.id } })).toMatchObject({
      status: "running",
      workRequirementsVersion: 2,
    });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: document.id } })).toMatchObject({
      requirementsVersion: 2,
    });
    expect(
      await fixtures.workEvent.findFirstOrThrow({
        where: { ticketId: document.id, kind: "requirements_changed" },
      }),
    ).toMatchObject({ status: "handled", wakeRunId: execution.id });
    expect(
      await within(() => getManagedWorkAdmission(prisma, { spaceId, ticketId: document.id })),
    ).toMatchObject({ admitted: false, reason: "dependencies" });
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    expect(await fixtures.run.count({ where: { ticketId: document.id } })).toBe(1);
    const result = {
      previousVersion: 0,
      summary: "Verified output.",
      findings: [{ conclusion: "Output checked", outcome: "pass", evidence: "Source inspected." }],
    };
    expect(
      await within(() =>
        deliverTicketWork(deps(), sourceRun, {
          id: source.id,
          result,
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "done" });
    expect(
      await within(() =>
        deliverTicketWork(deps(), execution, {
          id: document.id,
          result,
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "done" });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: document.id } })).toMatchObject({
      acceptedRequirementsVersion: 2,
      acceptedReceiptVersion: 1,
    });
    const parent = await work();
    expect(
      await within(() =>
        deliverTicketWork(deps(), run, {
          id: parent.id,
          result,
          ownerAuthored: true,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "done" });
    expect(await fixtures.run.count({ where: { ticketId: document.id } })).toBe(1);
  });

  it("does not adopt a real requirements change through dependency registration or self-assignment", async () => {
    await dispatch();
    const delegated = await child();
    const execution = await runFor(delegated);
    await fixtures.run.update({ where: { id: execution.id }, data: { status: "running" } });
    expect(
      await within(() =>
        updateTicket(deps(), {
          spaceId,
          userId,
          botId: chief.id,
          runId: run.id,
          threadId: chief.threadId,
          id: delegated.id,
          description: "A revised deliverable.",
        }),
      ),
    ).toHaveProperty("ticket.id", delegated.id);
    for (const change of [{ dependencies: [] }, { ownerBotId: specialist.id }]) {
      expect(
        await within(() =>
          updateTicket(deps(), {
            spaceId,
            userId,
            botId: specialist.id,
            runId: execution.id,
            threadId: specialist.threadId,
            id: delegated.id,
            ...change,
          }),
        ),
      ).toHaveProperty("error", expect.stringContaining("earlier requirements version"));
    }
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: execution.id } })).toMatchObject({
      workRequirementsVersion: 1,
    });
    expect(
      await within(() =>
        deliverTicketWork(deps(), execution, {
          id: delegated.id,
          result: {
            previousVersion: 0,
            summary: "Old output",
            findings: [{ conclusion: "Finished", outcome: "pass", evidence: "Original output" }],
          },
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toHaveProperty("error", expect.stringContaining("requirements changed"));
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } }))
        .requirementsVersion,
    ).toBe(2);
  });

  it("rejects a dependency cycle rather than leaving mutually waiting tasks", async () => {
    await dispatch("source");
    const first = await child();
    await dispatch("review", reviewer);
    const second = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: reviewer.id },
    });
    await within(() =>
      prisma.$transaction((tx) =>
        setManagedWorkDependenciesInTransaction(tx, {
          spaceId,
          ticketId: second.id,
          dependencies: [{ ticketId: first.id, requirementsVersion: 1 }],
        }),
      ),
    );
    await expect(
      within(() =>
        prisma.$transaction((tx) =>
          setManagedWorkDependenciesInTransaction(tx, {
            spaceId,
            ticketId: first.id,
            dependencies: [{ ticketId: second.id, requirementsVersion: 1 }],
          }),
        ),
      ),
    ).rejects.toThrow("cycle");
    expect(await fixtures.ticketDependency.count({ where: { spaceId } })).toBe(1);
  });

  it("merges receipt and terminal outcome into one non-user coordination wake with actual evidence", async () => {
    const { ticket, execution } = await completedChild();
    await within(() =>
      prisma.$transaction((tx) =>
        recordManagedChildOutcomeInTransaction(tx, {
          spaceId,
          runId: execution.id,
          ticketId: ticket.id,
          payload: { receiptMessageId: "receipt-evidence", summary: "Verified source" },
        }),
      ),
    );
    await within(() => returnBotMessageOutcome(deps(), execution, specialist, "Final findings"));
    const parent = await work();
    const wakes = await fixtures.run.findMany({
      where: { ticketId: parent.id, id: { not: run.id } },
    });
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.trigger).toBe("bot_message");
    const task = await fixtures.task.findUniqueOrThrow({ where: { id: wake.taskId } });
    expect(task.prompt).toContain("receipt-evidence");
    expect(task.prompt).toContain("Final findings");
    const message = await fixtures.message.findUniqueOrThrow({
      where: { id: wake.sourceMessageId! },
    });
    expect(message.role).toBe("system");
    expect(message.authorUserId).toBeNull();
    expect(message.blocks).toEqual([{ kind: "delivery" }]);
    await within(() => returnBotMessageOutcome(deps(), execution, specialist, "Final findings"));
    expect(await fixtures.run.count({ where: { ticketId: parent.id, id: { not: run.id } } })).toBe(
      1,
    );
  });

  it("puts external results into the task and recovers a saved event without exposing protocol data in chat", async () => {
    const linked = await within(() =>
      ensureManagedWorkForRun(deps(), run, {
        brief: "External work",
        operationKey: "external",
      }),
    );
    await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const event = await within(() =>
      prisma.$transaction((tx) =>
        recordWorkEventInTransaction(tx, {
          spaceId,
          userId,
          ticketId: linked.ticketId,
          eventKey: "external-terminal",
          kind: "external_completed",
          controlEpoch: 0,
          targetBotId: chief.id,
          targetThreadId: chief.threadId,
          payload: {
            executionId: "execution",
            sessionId: "session",
            result: { text: "OUTPUT_OK" },
            instruction: "Inspect the output",
            operationKey: "operation",
          },
        }),
      ),
    );
    enqueue.mockRejectedValueOnce(new Error("queue offline"));
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    const saved = await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(saved.status).toBe("prepared");
    expect(saved.payload).toMatchObject({
      result: { text: "OUTPUT_OK" },
      instruction: "Inspect the output",
    });
    const rawWorkEvents = await within(
      () => prisma.$queryRaw<Array<{ payload: unknown }>>`
      SELECT payload FROM work_events WHERE id = ${event.id}
    `,
    );
    expect(rawWorkEvents).toHaveLength(1);
    expect(JSON.stringify(rawWorkEvents[0]!.payload)).not.toContain("OUTPUT_OK");
    const wake = await fixtures.run.findUniqueOrThrow({ where: { id: saved.wakeRunId! } });
    expect(
      (await fixtures.task.findUniqueOrThrow({ where: { id: wake.taskId } })).prompt,
    ).toContain("OUTPUT_OK");
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    expect(await fixtures.run.count({ where: { ticketId: linked.ticketId } })).toBe(2);
    expect(
      await within(() => settleManagedWorkEventsForRun(prisma, { spaceId, runId: wake.id })),
    ).toBe(0);
    await fixtures.run.update({ where: { id: wake.id }, data: { status: "failed" } });
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    expect((await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      "failed",
    );
    expect(await fixtures.run.count({ where: { ticketId: linked.ticketId } })).toBe(2);
  });

  it("stop finds children and external executions after the parent Run finishes and suppresses late results", async () => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const childRun = await runFor(delegated);
    const execution = await external(parent);
    await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const stopped = await within(() =>
      prisma.$transaction((tx) =>
        requestManagedWorkStopInTransaction(tx, {
          spaceId,
          userId,
          threadId: chief.threadId,
        }),
      ),
    );
    expect(stopped.ticketIds.sort()).toEqual([parent.id, delegated.id].sort());
    expect(stopped.runIds).toContain(childRun.id);
    expect(stopped.executionIds).toContain(execution.id);
    expect(
      (await fixtures.externalAgentExecution.findUniqueOrThrow({ where: { id: execution.id } }))
        .stopRequestedAt,
    ).not.toBeNull();
    await within(() =>
      prisma.$transaction((tx) =>
        requestManagedWorkStopInTransaction(tx, {
          spaceId,
          userId,
          threadId: chief.threadId,
        }),
      ),
    );
    expect((await work()).controlEpoch).toBe(1);
    await fixtures.run.update({ where: { id: childRun.id }, data: { status: "completed" } });
    await within(() => returnBotMessageOutcome(deps(), childRun, specialist, "Late output"));
    expect(await fixtures.run.count({ where: { ticketId: parent.id } })).toBe(1);
  });

  it("clear generation suppresses a saved wake and a failed child is not a coordination wait", async () => {
    const { ticket, execution } = await completedChild();
    await fixtures.run.update({ where: { id: execution.id }, data: { status: "failed" } });
    expect(
      await within(() => getManagedCoordinationWait(prisma, { spaceId, runId: run.id })),
    ).toMatchObject({ waiting: false });
    const event = await within(() =>
      prisma.$transaction((tx) =>
        recordManagedChildOutcomeInTransaction(tx, {
          spaceId,
          runId: execution.id,
          ticketId: ticket.id,
          payload: { error: "Source unavailable" },
        }),
      ),
    );
    expect(event).not.toBeNull();
    await fixtures.thread.update({
      where: { id: chief.threadId },
      data: { historyCompactionGeneration: { increment: 1 } },
    });
    expect(await within(() => prepareWorkEventWake(prisma, { eventId: event!.id }))).toMatchObject({
      status: "suppressed",
    });
    expect(await fixtures.run.count({ where: { ticketId: (await work()).id } })).toBe(1);
  });

  it("uses a real artifact receipt to accept a child and refuses parent success before child acceptance", async () => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const childRun = await runFor(delegated);
    const result = {
      previousVersion: 0,
      summary: "Source checked.",
      findings: [
        {
          conclusion: "Source verified",
          outcome: "pass",
          evidence: "Inspected the supplied source.",
        },
      ],
    };
    expect(
      await within(() =>
        deliverTicketWork(
          deps(),
          { ...run, ticketId: parent.id },
          {
            id: parent.id,
            result,
            ownerAuthored: true,
            secrets: [],
          },
        ),
      ),
    ).toHaveProperty("error", expect.stringContaining("unresolved"));
    await fixtures.run.update({ where: { id: childRun.id }, data: { status: "running" } });
    const delivered = await within(() =>
      deliverTicketWork(deps(), childRun, {
        id: delegated.id,
        result,
        ownerAuthored: false,
        secrets: [],
      }),
    );
    expect(delivered).toMatchObject({ ok: true, status: "done", version: 1 });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } })).toMatchObject({
      acceptedRequirementsVersion: 1,
      acceptedReceiptVersion: 1,
    });
    const receipt = await fixtures.artifact.findFirstOrThrow({
      where: { spaceId, name: `work-${delegated.id}.json` },
    });
    const bytes = await artifacts.get(receipt.storageKey, {
      operationId: "test",
      traceId: "test",
      spaceId,
      userId,
      botId: chief.id,
      signal: new AbortController().signal,
    });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      ticketId: delegated.id,
      version: 1,
      summary: "Source checked.",
    });
    await fixtures.run.updateMany({
      where: { id: { in: [run.id, childRun.id] } },
      data: { status: "completed", completedAt: new Date() },
    });
    const outcome = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: parent.id, kind: "child_outcome" },
    });
    const prepared = await within(() => prepareWorkEventWake(prisma, { eventId: outcome.id }));
    const parentRun = await fixtures.run.findUniqueOrThrow({
      where: { id: "runId" in prepared ? prepared.runId : "" },
    });
    await fixtures.run.update({ where: { id: parentRun.id }, data: { status: "running" } });
    const parentDelivery = await within(() =>
      deliverTicketWork(deps(), parentRun, {
        id: parent.id,
        result,
        ownerAuthored: true,
        secrets: [],
      }),
    );
    expect(parentDelivery).toMatchObject({ ok: true, status: "done" });
    expect(
      await within(() => settleManagedWorkEventsForRun(prisma, { spaceId, runId: parentRun.id })),
    ).toBe(0);
    const covered = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: parent.id, kind: "child_outcome" },
    });
    expect(covered.status).toBe("handled");
  });

  it("reads only the current managed receipt's artifact references from persisted evidence", async () => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const execution = await runFor(delegated);
    await fixtures.run.update({ where: { id: execution.id }, data: { status: "running" } });
    const findings = [
      { conclusion: "Document checked", outcome: "pass", evidence: "Read the finished document." },
    ];
    let latest: { artifactIds: string[]; finalArtifactId: string } | undefined;
    for (const previousVersion of [0, 1]) {
      const attached = await within(() =>
        attachWorkspaceFileToThread(
          { prisma, artifacts },
          {
            spaceId,
            userId,
            botId: specialist.id,
            runId: execution.id,
            filePath: "finished.md",
            operationId: `${execution.id}:document:${previousVersion}`,
            bytes: Buffer.from(`# Finished document ${previousVersion + 1}\n`),
          },
        ),
      );
      expect(
        await within(() =>
          deliverTicketWork(deps(), execution, {
            id: delegated.id,
            result: {
              previousVersion,
              summary: "Document ready.",
              findings,
              artifactIds: [attached.artifactId],
              finalArtifactId: attached.artifactId,
            },
            ownerAuthored: false,
            secrets: [],
          }),
        ),
      ).toMatchObject({ ok: true, status: "done" });
      const event = await fixtures.workEvent.findFirstOrThrow({
        where: { sourceTicketId: delegated.id, kind: "child_outcome" },
      });
      latest = event.payload as unknown as typeof latest;
      expect(await within(() => getTicket(deps(), { spaceId, ref: delegated.id }))).toHaveProperty(
        "delivery",
        expect.objectContaining({
          previousVersion: previousVersion + 1,
          artifactIds: latest!.artifactIds,
          finalArtifactId: latest!.finalArtifactId,
        }),
      );
    }
    const forwarded = await within(() =>
      deliverTicketWork(deps(), run, {
        id: parent.id,
        ownerAuthored: true,
        secrets: [],
        result: {
          previousVersion: 0,
          summary: "Reviewed finished document.",
          findings,
          artifactIds: latest!.artifactIds,
          finalArtifactId: latest!.finalArtifactId,
        },
      }),
    );
    expect(forwarded).toMatchObject({ ok: true, status: "done" });
    if (!("messageId" in forwarded)) throw new Error("Missing parent receipt");
    const parentMessage = await fixtures.message.findUniqueOrThrow({
      where: { id: forwarded.messageId },
    });
    expect(parentMessage.blocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", mimeType: "application/json" }),
      ]),
    );
    const receiptArtifact = await fixtures.artifact.findFirstOrThrow({
      where: { spaceId, clientNonce: parentMessage.clientNonce! },
    });
    await fixtures.artifact.update({
      where: { id: receiptArtifact.id },
      data: { name: "persisted-receipt.json" },
    });
    expect(await within(() => getTicket(deps(), { spaceId, ref: parent.id }))).toHaveProperty(
      "delivery",
      expect.objectContaining({
        previousVersion: 1,
        artifactIds: latest!.artifactIds,
        finalArtifactId: latest!.finalArtifactId,
      }),
    );
    await fixtures.workEvent.create({
      data: {
        spaceId,
        userId,
        ticketId: parent.id,
        sourceTicketId: delegated.id,
        targetBotId: chief.id,
        targetThreadId: chief.threadId,
        kind: "child_outcome",
        eventKey: "older-receipt-evidence",
        controlEpoch: parent.controlEpoch,
        status: "handled",
        payload: {
          receiptVersion: 1,
          artifactIds: ["older-artifact"],
          finalArtifactId: "older-artifact",
        },
      },
    });
    // Only older outcome evidence remains; the receipt nonce identifies the current artifact.
    await fixtures.workEvent.deleteMany({
      where: {
        sourceTicketId: delegated.id,
        kind: "child_outcome",
        eventKey: { not: "older-receipt-evidence" },
      },
    });
    expect(await within(() => getTicket(deps(), { spaceId, ref: delegated.id }))).toHaveProperty(
      "delivery",
      expect.objectContaining({
        artifactIds: latest!.artifactIds,
        finalArtifactId: latest!.finalArtifactId,
      }),
    );
    await fixtures.ticket.update({ where: { id: delegated.id }, data: { receiptVersion: 3 } });
    expect(await within(() => getTicket(deps(), { spaceId, ref: delegated.id }))).toHaveProperty(
      "delivery",
      { previousVersion: 3 },
    );
  });

  it.each([
    "receipt reply",
    "prelinked receipt reply",
    "prelinked reply update",
    "prelinked reply revision",
    "explicit parent binding",
  ])("revises a completed delivery on its original parent and child through %s", async (mode) => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const execution = await runFor(delegated);
    await fixtures.run.update({ where: { id: execution.id }, data: { status: "running" } });
    const result = {
      previousVersion: 0,
      summary: "Finished report.",
      findings: [{ conclusion: "Checked", outcome: "pass", evidence: "Read the report." }],
    };
    expect(
      await within(() =>
        deliverTicketWork(deps(), execution, {
          id: delegated.id,
          result,
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "done" });
    const delivered = await within(() =>
      deliverTicketWork(deps(), run, {
        id: parent.id,
        result,
        ownerAuthored: true,
        secrets: [],
      }),
    );
    expect(delivered).toMatchObject({ ok: true, status: "done" });
    if (!("messageId" in delivered)) throw new Error("Missing parent receipt");
    await fixtures.run.updateMany({
      where: { id: { in: [run.id, execution.id] } },
      data: { status: "completed", completedAt: new Date() },
    });
    const owner = await newOwnerRun(
      mode !== "explicit parent binding" ? { replyToMessageId: delivered.messageId } : {},
    );
    if (mode.startsWith("prelinked"))
      await fixtures.run.update({ where: { id: owner.id }, data: { ticketId: parent.id } });
    const updateBeforeDispatch =
      mode === "explicit parent binding" ||
      mode === "prelinked reply update" ||
      mode === "prelinked reply revision";
    if (updateBeforeDispatch) {
      expect(
        await within(() =>
          updateTicket(deps(), {
            spaceId,
            userId,
            botId: chief.id,
            runId: owner.id,
            threadId: chief.threadId,
            ownerAuthored: true,
            id: parent.id,
            ownerBotId: chief.id,
            ...(mode !== "prelinked reply update"
              ? { description: "Revise the original report with the new source." }
              : {}),
            status: "doing",
          }),
        ),
      ).toHaveProperty("ticket.id", parent.id);
      expect(await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
        ticketId: parent.id,
        workControlEpoch: parent.controlEpoch,
        workRequirementsVersion: 2,
      });
      expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
        requirementsVersion: 2,
        acceptedRequirementsVersion: null,
        acceptedReceiptVersion: null,
        ...(mode.startsWith("prelinked") ? { status: "doing" } : {}),
      });
      if (mode.startsWith("prelinked")) {
        expect(
          await fixtures.ticketComment.findMany({
            where: { ticketId: parent.id, authorUserId: userId },
          }),
        ).toEqual([
          expect.objectContaining({ body: "Continue the original work from its saved outputs." }),
        ]);
        expect(
          await within(() =>
            updateTicket(deps(), {
              spaceId,
              userId,
              botId: chief.id,
              runId: owner.id,
              threadId: chief.threadId,
              id: parent.id,
              status: "doing",
              ownerBotId: chief.id,
            }),
          ),
        ).toHaveProperty("ticket.id", parent.id);
        expect(
          (await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } }))
            .requirementsVersion,
        ).toBe(2);
      }
    }
    expect(
      await within(() =>
        messageBot(deps(), owner, chief, {
          bot_id: specialist.id,
          message: "Revise the original report with the new source.",
          deliveryKey: `${owner.id}:revision`,
        }),
      ),
    ).toMatchObject({ ok: true, ticketId: delegated.id });
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
      ticketId: parent.id,
      workRequirementsVersion: 2,
    });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      requirementsVersion: 2,
      acceptedRequirementsVersion: null,
      acceptedReceiptVersion: null,
    });
    const revisedRun = await runFor(delegated);
    expect(revisedRun).toMatchObject({ ticketId: delegated.id, workRequirementsVersion: 2 });
    await within(() =>
      ensureManagedWorkForRun(deps(), owner, {
        brief: "Continue revision.",
        operationKey: "again",
      }),
    );
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).requirementsVersion,
    ).toBe(2);
    await fixtures.run.update({ where: { id: revisedRun.id }, data: { status: "running" } });
    for (const delivery of [
      { execution: revisedRun, ticketId: delegated.id, ownerAuthored: false },
      { execution: owner, ticketId: parent.id, ownerAuthored: true },
    ])
      expect(
        await within(() =>
          deliverTicketWork(deps(), delivery.execution, {
            id: delivery.ticketId,
            result: { ...result, previousVersion: 1, summary: "Revised report." },
            ownerAuthored: delivery.ownerAuthored,
            secrets: [],
          }),
        ),
      ).toMatchObject({ ok: true, status: "done", version: 2 });
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
    expect(await fixtures.ticket.findMany({ where: { spaceId } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.id,
          acceptedRequirementsVersion: 2,
          acceptedReceiptVersion: 2,
        }),
        expect.objectContaining({
          id: delegated.id,
          acceptedRequirementsVersion: 2,
          acceptedReceiptVersion: 2,
        }),
      ]),
    );
  });

  it.each([false, true])(
    "recovers a completed child through a direct result from its owner receipt reply (prelinked: %s)",
    async (prelinked) => {
      await dispatch();
      const parent = await work();
      const delegated = await child();
      const execution = await runFor(delegated);
      await fixtures.run.update({ where: { id: execution.id }, data: { status: "running" } });
      const result = {
        previousVersion: 0,
        summary: "Finished report.",
        findings: [{ conclusion: "Checked", outcome: "pass", evidence: "Read the report." }],
      };
      expect(
        await within(() =>
          deliverTicketWork(deps(), execution, {
            id: delegated.id,
            result,
            ownerAuthored: false,
            secrets: [],
          }),
        ),
      ).toMatchObject({ ok: true, status: "done" });
      await fixtures.run.update({
        where: { id: execution.id },
        data: { status: "completed", completedAt: new Date() },
      });
      const acceptedChild = await fixtures.ticket.findUniqueOrThrow({
        where: { id: delegated.id },
      });
      const receipt = await within(() =>
        deliverTicketWork(deps(), run, {
          id: parent.id,
          result: {
            ...result,
            findings: [
              { conclusion: "Owner verification", outcome: "unknown", evidence: "Still pending." },
            ],
          },
          ownerAuthored: true,
          secrets: [],
        }),
      );
      expect(receipt).toMatchObject({ ok: true, status: "review" });
      if (!("messageId" in receipt)) throw new Error("Missing parent receipt");
      await fixtures.run.update({
        where: { id: run.id },
        data: { status: "failed", completedAt: new Date() },
      });
      const owner = await newOwnerRun({ replyToMessageId: receipt.messageId });
      if (prelinked)
        await fixtures.run.update({ where: { id: owner.id }, data: { ticketId: parent.id } });
      const input = {
        id: parent.id,
        result: { ...result, previousVersion: 1, summary: "Verified the saved report." },
        ownerAuthored: true,
        secrets: [],
      };
      const delivered = await within(() => deliverTicketWork(deps(), owner, input));
      expect(delivered).toMatchObject({ ok: true, managed: true, status: "done", version: 2 });
      expect(await within(() => deliverTicketWork(deps(), owner, input))).toEqual(delivered);
      expect(await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
        ticketId: parent.id,
        workControlEpoch: parent.controlEpoch,
        workRequirementsVersion: 2,
      });
      expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
        status: "done",
        requirementsVersion: 2,
        acceptedRequirementsVersion: 2,
        receiptVersion: 2,
        acceptedReceiptVersion: 2,
      });
      expect(await fixtures.ticketComment.findMany({ where: { ticketId: parent.id } })).toEqual([
        expect.objectContaining({
          authorUserId: userId,
          body: "Continue the original work from its saved outputs.",
        }),
      ]);
      expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } })).toEqual(
        acceptedChild,
      );
      expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(2);
      expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(1);
      expect(await within(() => deliverTicketWork(deps(), run, input))).toHaveProperty(
        "error",
        expect.stringContaining("requirements changed"),
      );
    },
  );

  it.each([
    ...[
      "missing reply",
      "peer reply",
      "old epoch",
      "old requirements",
      "initialized epoch",
      "initialized requirements",
      "stopped work",
      "cleared origin",
    ].flatMap((invalid) => ["owner update", "result"].map((entry) => ({ invalid, entry }))),
    { invalid: "old receipt", entry: "result" },
  ])(
    "does not admit a prelinked revision through ticket_update $entry for $invalid",
    async ({ invalid, entry }) => {
      const linked = await within(() =>
        ensureManagedWorkForRun(deps(), run, {
          brief: "Original report.",
          operationKey: "original",
        }),
      );
      const delivered = await within(() =>
        deliverTicketWork(deps(), run, {
          id: linked.ticketId,
          ownerAuthored: true,
          secrets: [],
          result: {
            previousVersion: 0,
            summary: "Original report.",
            findings: [{ conclusion: "Checked", outcome: "pass", evidence: "Read the report." }],
          },
        }),
      );
      expect(delivered).toMatchObject({ ok: true, status: "done" });
      if (!("messageId" in delivered)) throw new Error("Missing parent receipt");
      await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
      const owner = await newOwnerRun({
        ...(invalid !== "missing reply" ? { replyToMessageId: delivered.messageId } : {}),
        ...(invalid === "peer reply" ? { peer: true } : {}),
      });
      await fixtures.run.update({
        where: { id: owner.id },
        data: {
          ticketId: linked.ticketId,
          ...(invalid === "old epoch" || invalid === "old requirements"
            ? { workControlEpoch: 0, workRequirementsVersion: 1 }
            : {}),
          ...(invalid === "initialized epoch" ? { workControlEpoch: 0 } : {}),
          ...(invalid === "initialized requirements" ? { workRequirementsVersion: 1 } : {}),
        },
      });
      if (invalid === "old epoch" || invalid === "stopped work")
        await fixtures.ticket.update({
          where: { id: linked.ticketId },
          data: {
            controlEpoch: 1,
            ...(invalid === "stopped work"
              ? { stopRequestedAt: new Date(owner.createdAt.getTime() + 1) }
              : {}),
          },
        });
      if (invalid === "old requirements")
        await fixtures.ticket.update({
          where: { id: linked.ticketId },
          data: { requirementsVersion: 2 },
        });
      if (invalid === "cleared origin")
        await fixtures.thread.update({
          where: { id: chief.threadId },
          data: { historyCompactionGeneration: { increment: 1 } },
        });
      const before = await fixtures.ticket.findUniqueOrThrow({ where: { id: linked.ticketId } });
      const beforeRun = await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } });
      expect(
        await within(async () =>
          entry === "result"
            ? deliverTicketWork(deps(), owner, {
                id: linked.ticketId,
                ownerAuthored: true,
                secrets: [],
                result: {
                  previousVersion: invalid === "old receipt" ? 0 : 1,
                  summary: "Verified saved report.",
                  findings: [{ conclusion: "Checked", outcome: "pass", evidence: "Read it." }],
                },
              })
            : updateTicket(deps(), {
                spaceId,
                userId,
                botId: chief.id,
                runId: owner.id,
                threadId: chief.threadId,
                ownerAuthored: true,
                id: linked.ticketId,
                ownerBotId: chief.id,
                status: "doing",
              }),
        ),
      ).toHaveProperty("error", expect.any(String));
      expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: linked.ticketId } })).toEqual(
        before,
      );
      expect(await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(beforeRun);
      expect(await fixtures.ticketComment.count({ where: { ticketId: linked.ticketId } })).toBe(0);
    },
  );

  it("keeps an unresolved child in review, notifies its owner, and refuses parent success", async () => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const childRun = await runFor(delegated);
    await fixtures.run.update({ where: { id: childRun.id }, data: { status: "running" } });
    const result = {
      previousVersion: 0,
      summary: "Output delivered; a source audit remains unresolved.",
      findings: [
        { conclusion: "Source audit", outcome: "unknown", evidence: "No original baseline." },
      ],
    };
    expect(
      await within(() =>
        deliverTicketWork(deps(), childRun, {
          id: delegated.id,
          result,
          ownerAuthored: false,
          secrets: [],
        }),
      ),
    ).toMatchObject({ ok: true, status: "review", version: 1 });
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } })).toMatchObject({
      status: "review",
      acceptedReceiptVersion: null,
      acceptedRequirementsVersion: null,
    });
    expect(
      await within(() =>
        deliverTicketWork(
          deps(),
          { ...run, ticketId: parent.id },
          {
            id: parent.id,
            ownerAuthored: true,
            secrets: [],
            result: {
              ...result,
              findings: [
                { conclusion: "All work complete", outcome: "pass", evidence: "Child returned." },
              ],
            },
          },
        ),
      ),
    ).toHaveProperty("error", expect.stringContaining("unresolved"));
    await fixtures.run.updateMany({
      where: { id: { in: [run.id, childRun.id] } },
      data: { status: "completed", completedAt: new Date() },
    });
    const event = await fixtures.workEvent.findFirstOrThrow({
      where: { ticketId: parent.id, kind: "child_outcome" },
    });
    const wake = await within(() => prepareWorkEventWake(prisma, { eventId: event.id }));
    expect(wake).toMatchObject({ status: "prepared" });
    expect(
      await fixtures.run.findUniqueOrThrow({ where: { id: "runId" in wake ? wake.runId : "" } }),
    ).toMatchObject({
      botId: chief.id,
      ticketId: parent.id,
      trigger: "bot_message",
    });
  });

  it.each(["pass", "unknown", "issue"] as const)(
    "settles external events atomically with a %s receipt but retains later evidence and stale-version receipts",
    async (outcome) => {
      const linked = await within(() =>
        ensureManagedWorkForRun(deps(), run, {
          brief: "Finish output",
          operationKey: "finish",
        }),
      );
      const record = (key: string) =>
        within(() =>
          prisma.$transaction((tx) =>
            recordWorkEventInTransaction(tx, {
              spaceId,
              userId,
              ticketId: linked.ticketId,
              eventKey: key,
              kind: "external_completed",
              controlEpoch: 0,
              targetBotId: chief.id,
              targetThreadId: chief.threadId,
              sourceRunId: run.id,
              payload: {
                connectionId: "server",
                sessionId: "session",
                turnId: key,
                operationKey: key,
                status: "completed",
                result: `Finished ${key}`,
              },
            }),
          ),
        );
      const before = await record("before-receipt");
      const changed = await record("changed-after-receipt");
      await recordOutcomeRead(before);
      await recordOutcomeRead(changed);
      expect(
        await within(() => getManagedCoordinationWait(prisma, { spaceId, runId: run.id })),
      ).toMatchObject({
        waiting: false,
      });
      const delivery = await within(() =>
        deliverTicketWork(
          deps(),
          { ...run, ticketId: linked.ticketId },
          {
            id: linked.ticketId,
            ownerAuthored: true,
            secrets: [],
            result: {
              previousVersion: 0,
              summary: "Delivered output.",
              findings: [
                {
                  conclusion: "Output verified",
                  outcome,
                  evidence: "Read back the produced output.",
                },
              ],
            },
          },
        ),
      );
      expect(delivery).toMatchObject({ ok: true, status: outcome === "pass" ? "done" : "review" });
      expect(
        await fixtures.ticket.findUniqueOrThrow({ where: { id: linked.ticketId } }),
      ).toMatchObject({
        receiptVersion: 1,
        acceptedReceiptVersion: outcome === "pass" ? 1 : null,
      });
      expect(await within(() => prepareWorkEventWake(prisma, { eventId: before.id }))).toEqual({
        status: "handled",
      });
      expect(await fixtures.run.count({ where: { ticketId: linked.ticketId } })).toBe(1);
      await fixtures.run.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date() },
      });
      expect(await within(() => prepareWorkEventWake(prisma, { eventId: before.id }))).toEqual({
        status: "handled",
      });
      expect(await fixtures.run.count({ where: { ticketId: linked.ticketId } })).toBe(1);
      const after = await record("after-receipt");
      // A reconciler races the successful finalizer and stamps failed after delivery.
      await fixtures.workEvent.update({
        where: { id: before.id },
        data: { status: "failed", wakeRunId: run.id },
      });
      await fixtures.workEvent.update({
        where: { id: changed.id },
        data: {
          status: "failed",
          wakeRunId: run.id,
          payload: {
            result: "A later result changed the evidence",
            evidenceUpdatedAt: new Date(Date.now() + 1000).toISOString(),
          },
        },
      });
      expect(
        await within(() => settleManagedWorkEventsForRun(prisma, { spaceId, runId: run.id })),
      ).toBe(1);
      expect(
        (await fixtures.workEvent.findUniqueOrThrow({ where: { id: before.id } })).status,
      ).toBe("handled");
      expect((await fixtures.workEvent.findUniqueOrThrow({ where: { id: after.id } })).status).toBe(
        "pending",
      );
      expect(
        (await fixtures.workEvent.findUniqueOrThrow({ where: { id: changed.id } })).status,
      ).toBe("failed");
      await fixtures.ticket.update({
        where: { id: linked.ticketId },
        data: { requirementsVersion: 2 },
      });
      expect(
        await within(() => settleManagedWorkEventsForRun(prisma, { spaceId, runId: run.id })),
      ).toBe(0);
      expect((await fixtures.workEvent.findUniqueOrThrow({ where: { id: after.id } })).status).toBe(
        "pending",
      );
    },
  );

  it("retains an unread completed outcome despite a stale connecting receipt and wakes once to handle it", async () => {
    const linked = await within(() =>
      ensureManagedWorkForRun(deps(), run, { brief: "Verify output", operationKey: "start" }),
    );
    const event = await within(() =>
      prisma.$transaction((tx) =>
        recordWorkEventInTransaction(tx, {
          spaceId,
          userId,
          ticketId: linked.ticketId,
          eventKey: "unread-completion",
          kind: "external_completed",
          controlEpoch: 0,
          targetBotId: chief.id,
          targetThreadId: chief.threadId,
          sourceRunId: run.id,
          payload: {
            connectionId: "server",
            sessionId: "session",
            turnId: "turn",
            operationKey: "start",
            status: "completed",
            result: "Output ready.",
          },
        }),
      ),
    );
    const read = await recordOutcomeRead(event);
    await fixtures.externalEffect.update({
      where: { id: read.id },
      data: {
        result: { structuredContent: { session: { id: "session", status: "connecting" } } },
      },
    });
    expect(
      await within(() => getManagedCoordinationWait(prisma, { spaceId, runId: run.id })),
    ).toMatchObject({
      waiting: true,
      pendingEventIds: [event.id],
    });
    // Reproduce completion arriving after the executor's decision to finalize.
    const result = {
      previousVersion: 0,
      summary: "Only the start acknowledgement was observed.",
      findings: [{ conclusion: "Output", outcome: "unknown", evidence: "No completion observed." }],
    };
    expect(
      await within(() =>
        deliverTicketWork(
          deps(),
          { ...run, ticketId: linked.ticketId },
          {
            id: linked.ticketId,
            ownerAuthored: true,
            secrets: [],
            result,
          },
        ),
      ),
    ).toMatchObject({ ok: true, status: "review", version: 1 });
    expect(await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: "pending",
      wakeRunId: null,
    });
    await fixtures.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const prepared = await within(() => prepareWorkEventWake(prisma, { eventId: event.id }));
    const wake = await fixtures.run.findUniqueOrThrow({
      where: { id: "runId" in prepared ? prepared.runId : "" },
    });
    expect(
      (await fixtures.task.findUniqueOrThrow({ where: { id: wake.taskId } })).prompt,
    ).toContain("Output ready.");
    await fixtures.run.update({ where: { id: wake.id }, data: { status: "running" } });
    expect(
      await within(() =>
        deliverTicketWork(deps(), wake, {
          id: linked.ticketId,
          ownerAuthored: false,
          secrets: [],
          result: {
            previousVersion: 1,
            summary: "Output handled; independent audit remains unknown.",
            findings: [
              {
                conclusion: "Independent audit",
                outcome: "unknown",
                evidence: "Output inspected, no baseline audit.",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ ok: true, status: "review", version: 2 });
    expect(await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: "handled",
      wakeRunId: wake.id,
    });
    await fixtures.run.update({ where: { id: wake.id }, data: { status: "completed" } });
    await within(() => reconcileManagedWorkEvents(deps(), { spaceId }));
    expect(await fixtures.run.count({ where: { ticketId: linked.ticketId } })).toBe(2);
  });

  it("resumes only the stopped root from a new owner request and explicitly redispatches one child in a new epoch", async () => {
    await dispatch();
    await dispatch("review", reviewer);
    const parent = await work();
    const delegated = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: specialist.id, parentTicketId: parent.id },
    });
    const oldRun = await runFor(delegated);
    const sibling = await fixtures.ticket.findFirstOrThrow({
      where: { spaceId, assigneeBotId: reviewer.id, parentTicketId: parent.id },
    });
    const event = await within(() =>
      prisma.$transaction((tx) =>
        recordWorkEventInTransaction(tx, {
          spaceId,
          userId,
          ticketId: parent.id,
          eventKey: "resume-old-event",
          kind: "external_unknown",
          controlEpoch: 0,
          targetBotId: chief.id,
          targetThreadId: chief.threadId,
          sourceRunId: run.id,
          payload: { error: "Previous run interrupted" },
        }),
      ),
    );
    await fixtures.ticket.update({
      where: { id: parent.id },
      data: { receiptVersion: 1, acceptedReceiptVersion: 1, acceptedRequirementsVersion: 1 },
    });
    await stopWork();
    const owner = await newOwnerRun();
    const resume = () =>
      within(() =>
        updateTicket(deps(), {
          spaceId,
          userId,
          botId: chief.id,
          runId: owner.id,
          threadId: chief.threadId,
          ownerAuthored: true,
          id: parent.id,
          status: "doing",
          ownerBotId: chief.id,
        }),
      );
    expect(await resume()).toHaveProperty("ticket.id", parent.id);
    expect(await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      controlEpoch: 2,
      requirementsVersion: 1,
      stopRequestedAt: null,
      acceptedReceiptVersion: null,
      acceptedRequirementsVersion: null,
    });
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
      ticketId: parent.id,
      workControlEpoch: 2,
      workRequirementsVersion: 1,
    });
    await resume();
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: parent.id } })).controlEpoch,
    ).toBe(2);
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } })).stopRequestedAt,
    ).not.toBeNull();
    expect((await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      "suppressed",
    );
    const sent = await within(() =>
      messageBot(deps(), owner, chief, {
        bot_id: specialist.id,
        ticket_id: delegated.id,
        message: "Read the existing output and deliver its receipt only.",
        deliveryKey: `${owner.id}:resume-child`,
      }),
    );
    expect(sent).toMatchObject({ ok: true, ticketId: delegated.id });
    const resumed = await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } });
    expect(resumed).toMatchObject({
      controlEpoch: 2,
      requirementsVersion: 2,
      stopRequestedAt: null,
    });
    expect(await runFor(resumed)).toMatchObject({
      trigger: "bot_message",
      workControlEpoch: 2,
      workRequirementsVersion: 2,
    });
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: sibling.id } })).stopRequestedAt,
    ).not.toBeNull();
    expect(await fixtures.ticket.count({ where: { spaceId } })).toBe(3);
    await within(() => returnBotMessageOutcome(deps(), oldRun, specialist, "Late old result"));
    expect(
      await fixtures.workEvent.count({
        where: { sourceRunId: oldRun.id, kind: "child_outcome" },
      }),
    ).toBe(0);
    expect(await within(() => prepareWorkEventWake(prisma, { eventId: event.id }))).toMatchObject({
      status: "suppressed",
    });
  });

  it("refuses peer and old-owner executions attempting to reopen stopped work", async () => {
    await dispatch();
    const parent = await work();
    await stopWork();
    const peer = await newOwnerRun({ peer: true });
    expect(
      await within(() =>
        updateTicket(deps(), {
          spaceId,
          userId,
          botId: chief.id,
          runId: peer.id,
          threadId: chief.threadId,
          ownerAuthored: true,
          id: parent.id,
          status: "doing",
          ownerBotId: chief.id,
        }),
      ),
    ).toHaveProperty("error", expect.stringContaining("new owner message"));
    // A caller cannot turn the pre-stop user request into a new authorization.
    await fixtures.run.update({ where: { id: run.id }, data: { status: "running" } });
    expect(
      await within(() =>
        updateTicket(deps(), {
          spaceId,
          userId,
          botId: chief.id,
          runId: run.id,
          threadId: chief.threadId,
          ownerAuthored: true,
          id: parent.id,
          status: "doing",
          ownerBotId: chief.id,
        }),
      ),
    ).toHaveProperty("error", expect.stringContaining("new owner message"));
    expect((await work()).controlEpoch).toBe(1);
    expect((await work()).stopRequestedAt).not.toBeNull();
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: peer.id } })).ticketId).toBeNull();
  });

  it("does not redispatch a stopped child whose external execution still has an unknown terminal state", async () => {
    await dispatch();
    const parent = await work();
    const delegated = await child();
    const execution = await external(delegated);
    await fixtures.externalAgentExecution.update({
      where: { id: execution.id },
      data: { status: "unknown", operationState: "unknown" },
    });
    await stopWork();
    const owner = await newOwnerRun();
    await within(() =>
      updateTicket(deps(), {
        spaceId,
        userId,
        botId: chief.id,
        runId: owner.id,
        threadId: chief.threadId,
        id: parent.id,
        status: "doing",
        ownerBotId: chief.id,
      }),
    );
    expect(
      await within(() =>
        messageBot(deps(), owner, chief, {
          bot_id: specialist.id,
          ticket_id: delegated.id,
          message: "Continue saved work.",
          deliveryKey: `${owner.id}:still-unknown`,
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("terminal state") });
    expect(
      (await fixtures.ticket.findUniqueOrThrow({ where: { id: delegated.id } })).controlEpoch,
    ).toBe(1);
    expect(await fixtures.run.count({ where: { ticketId: delegated.id } })).toBe(1);
  });

  async function externalQuestion(options: { supported?: boolean; resumable?: boolean } = {}) {
    const { ticket, execution: sourceRun } = await completedChild();
    const questions = [
      {
        id: "format",
        question: "Which output format?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Markdown", description: "Text report" },
          { label: "HTML", description: "Web report" },
        ],
      },
      { id: "heading", question: "What heading should appear?", isOther: true, isSecret: false },
    ];
    const pending = {
      inputRequestId: "native-request",
      turnId: "native-turn",
      questions,
      inputResponseSupported: options.supported ?? true,
      resumable: options.resumable ?? true,
    };
    const receipt = {
      found: true,
      session: { id: "native-session", turnId: "native-turn", status: "running", connected: true },
      pendingInputRequests: [pending],
    };
    const execution = await fixtures.externalAgentExecution.create({
      data: {
        spaceId,
        userId,
        ownerBotId: specialist.id,
        threadId: specialist.threadId,
        ticketId: ticket.id,
        runId: sourceRun.id,
        operationKey: `start:${randomUUID()}`,
        connectionId: "connection",
        provider: "local-agent-phone",
        route: { connectorId: "mcp", resourceId: "connection", toolName: "phone_start" },
        request: { message: "Produce the report" },
        status: "waiting_input",
        operationState: "running",
        sessionId: "native-session",
        turnId: "native-turn",
        controlEpoch: ticket.controlEpoch,
        result: receipt,
      },
    });
    const event = await within(() =>
      prisma.$transaction((tx) =>
        recordWorkEventInTransaction(tx, {
          spaceId,
          userId,
          ticketId: ticket.id,
          eventKey: `input:${execution.id}`,
          kind: "external_input",
          controlEpoch: ticket.controlEpoch,
          targetBotId: specialist.id,
          targetThreadId: specialist.threadId,
          sourceRunId: sourceRun.id,
          payload: {
            executionId: execution.id,
            sessionId: execution.sessionId,
            ...pending,
            controlEpoch: ticket.controlEpoch,
            requirementsVersion: ticket.requirementsVersion,
          },
        }),
      ),
    );
    const prepared = await within(() => prepareWorkEventWake(prisma, { eventId: event.id }));
    return { ticket, execution, event, prepared, receipt, sourceRun };
  }

  async function inputCard(runId: string) {
    return fixtures.message.findFirstOrThrow({
      where: { runId, threadId: chief.threadId, role: "bot" },
      orderBy: { seq: "desc" },
    });
  }

  async function answerCard(runId: string, answer: string, overrides: Record<string, string> = {}) {
    const card = await inputCard(runId);
    return within(() =>
      answerRunInput(prisma, {
        spaceId,
        threadId: chief.threadId,
        runId,
        messageId: card.id,
        answeredByUserId: userId,
        answer,
        ...overrides,
      }),
    );
  }

  async function claimedInput(runId: string) {
    const run = await fixtures.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("queued");
    expect(run.wakeAt === null || run.wakeAt.getTime() <= Date.now()).toBe(true);
    const claimed = await within(() => claimRun(deps(), run, "input-worker"));
    expect(claimed).toBeDefined();
    expect(claimed!.current.checkpoint).toBe(run.checkpoint);
    const attempt = await fixtures.attempt.create({
      data: { runId, fence: claimed!.fence, status: "running" },
    });
    return {
      spaceId,
      runId,
      attemptId: attempt.id,
      leaseOwner: "input-worker",
      leaseFence: claimed!.fence,
    };
  }

  it.each(["requirements", "control epoch", "terminal run"] as const)(
    "rechecks managed claim after preflight when the %s changes",
    async (change) => {
      await dispatch();
      const ticket = await child();
      const observed = await runFor(ticket);
      expect(observed.status).toBe("queued");
      expect(await within(() => admitManagedRun(deps(), observed))).toBe(true);
      if (change === "requirements") {
        expect(
          await within(() =>
            updateTicket(deps(), { spaceId, userId, id: ticket.id, description: "Revised brief." }),
          ),
        ).toMatchObject({ ticket: { id: ticket.id } });
        expect(
          (await fixtures.ticket.findUniqueOrThrow({ where: { id: ticket.id } }))
            .requirementsVersion,
        ).toBe(ticket.requirementsVersion + 1);
      } else if (change === "control epoch") {
        await within(() =>
          prisma.$transaction((tx) =>
            requestManagedWorkStopInTransaction(tx, { spaceId, userId, ticketId: ticket.id }),
          ),
        );
      } else {
        await fixtures.run.update({ where: { id: observed.id }, data: { status: "completed" } });
      }
      expect(await within(() => claimRun(deps(), observed, "stale-worker"))).toBeUndefined();
      expect(await within(() => claimRun(deps(), observed, "duplicate-wake"))).toBeUndefined();
      expect(await fixtures.run.findUniqueOrThrow({ where: { id: observed.id } })).toMatchObject({
        status: change === "terminal run" ? "completed" : "cancelled",
        leaseFence: observed.leaseFence,
        leaseOwner: null,
      });
      expect(
        await fixtures.event.count({ where: { runId: observed.id, type: "run.cancelled" } }),
      ).toBe(change === "terminal run" ? 0 : 1);
    },
  );

  it("waits for an in-flight requirements edit before claiming managed work", async () => {
    await dispatch();
    const ticket = await child();
    const observed = await runFor(ticket);
    expect(await within(() => admitManagedRun(deps(), observed))).toBe(true);
    const editing = deferred<number>();
    const commit = deferred();
    const edit = fixtures.$transaction(async (tx) => {
      const [editor] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid FROM tickets WHERE id = ${ticket.id} FOR UPDATE
      `;
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { requirementsVersion: { increment: 1 } },
      });
      editing.resolve(editor!.pid);
      await commit.promise;
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    let claim: ReturnType<typeof claimRun> | undefined;
    try {
      const editorPid = await Promise.race([editing.promise, edit.then(() => 0)]);
      claim = within(() => claimRun(deps(), observed, "stale-worker"));
      await vi.waitFor(
        async () => {
          const [lock] = await fixtures.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS(
            SELECT 1 FROM pg_stat_activity WHERE ${editorPid}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `;
          expect(lock?.blocked).toBe(true);
        },
        { timeout: 10_000 },
      );
      commit.resolve();
      await edit;
      expect(await claim).toBeUndefined();
      expect(await fixtures.run.findUniqueOrThrow({ where: { id: observed.id } })).toMatchObject({
        status: "cancelled",
        leaseFence: observed.leaseFence,
      });
    } finally {
      commit.resolve();
      await Promise.all([edit, claim]);
    }
  });

  it.each(["disappeared", "terminal", "after answer", "during delivery"] as const)(
    "reconciles an external question that is %s",
    async (mode) => {
      const { ticket, execution, event, receipt } = await externalQuestion();
      const wake = await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } });
      const runId = wake.wakeRunId!;
      const entered = deferred();
      const release = deferred();
      const controller = new AbortController();
      let state = mode === "disappeared" ? "running" : "completed";
      const monitorConnector = {
        async *execute(call: { tool: string }) {
          if (call.tool === "phone_inspect") {
            entered.resolve();
            await release.promise;
            yield {
              type: "result",
              data: {
                structuredContent: {
                  ...receipt,
                  operation: { state, turnId: execution.turnId },
                  pendingInputRequests: state === "completed" ? receipt.pendingInputRequests : [],
                },
              },
            };
          } else if (call.tool === "phone_read") {
            yield {
              type: "result",
              data: { structuredContent: { session: receipt.session, events: [], cursor: 0 } },
            };
          } else throw new Error(`Unexpected monitor tool ${call.tool}`);
        },
      } as unknown as ConnectorProvider;
      const delivering = deferred();
      const deliver = deferred();
      const send = vi.fn();
      const inputConnector = {
        async *execute(call: { tool: string }) {
          if (call.tool === "phone_inspect") {
            yield { type: "result", data: { structuredContent: receipt } };
          } else if (call.tool === "phone_send") {
            send();
            delivering.resolve();
            await deliver.promise;
            yield {
              type: "result",
              data: {
                structuredContent: {
                  ...receipt,
                  operation: { state: "accepted", turnId: execution.turnId },
                },
              },
            };
          } else throw new Error(`Unexpected answer tool ${call.tool}`);
        },
      } as unknown as ConnectorProvider;
      const resume = async () => {
        const claim = await claimedInput(runId);
        return within(() =>
          resumeManagedExternalInput(
            {
              prisma,
              connector: inputConnector,
              events: createThreadEvents(prisma),
              jobs: { enqueue },
            },
            claim,
          ),
        );
      };
      const saved = () =>
        fixtures.externalAgentExecution.findUniqueOrThrow({ where: { id: execution.id } });
      const outcome = () =>
        fixtures.workEvent.findUnique({
          where: { eventKey: `external:${execution.id}:completed` },
        });
      let delivery: ReturnType<typeof resume> | undefined;
      try {
        await within(() =>
          reconcileExternalExecutions({
            ...deps(),
            connector: monitorConnector,
            shutdownSignal: controller.signal,
          }),
        );
        await entered.promise;
        if (mode === "after answer" || mode === "during delivery") {
          expect(await answerCard(runId, "option:0")).toBe(true);
          expect(await answerCard(runId, "Saved title")).toBe(true);
        }
        if (mode === "during delivery") {
          delivery = resume();
          await Promise.race([delivering.promise, delivery]);
          expect(send).toHaveBeenCalledOnce();
        }
        release.resolve();
        if (mode === "disappeared") {
          await vi.waitFor(
            async () => {
              expect(await saved()).toMatchObject({ status: "running" });
              expect(await fixtures.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                status: "cancelled",
              });
            },
            { timeout: 12_000 },
          );
          state = "completed";
        }
        await vi.waitFor(
          async () =>
            expect(await saved()).toMatchObject({
              status: "completed",
              leaseOwner: null,
            }),
          { timeout: 12_000 },
        );
        const terminal = (await outcome())!;
        expect(terminal).toBeTruthy();
        if (mode === "after answer" || mode === "during delivery") {
          expect(terminal).toMatchObject({ status: "pending", wakeRunId: null });
          expect(
            await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }),
          ).toMatchObject({
            status: "prepared",
            payload: {
              inputResponse: {
                status: mode === "after answer" ? "ready" : "dispatching",
                answers: {
                  format: { answers: ["Markdown"] },
                  heading: { answers: ["Saved title"] },
                },
              },
            },
          });
          if (mode === "during delivery") {
            deliver.resolve();
            expect(await delivery).toEqual({ handled: true, status: "sent" });
            expect(send).toHaveBeenCalledOnce();
            expect(
              await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }),
            ).toMatchObject({
              status: "handled",
              payload: { inputResponse: { status: "submitted" } },
            });
          } else {
            expect(await resume()).toEqual({ handled: true, status: "blocked" });
            expect(send).not.toHaveBeenCalled();
            expect(
              await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }),
            ).toMatchObject({
              status: "failed",
              payload: {
                inputResponse: {
                  status: "blocked",
                  answers: {
                    format: { answers: ["Markdown"] },
                    heading: { answers: ["Saved title"] },
                  },
                },
              },
            });
          }
        } else {
          expect(await answerCard(runId, "Too late")).toBe(false);
          expect(await inputCard(runId)).toMatchObject({
            blocks: [{ kind: "ask", status: "answered", dismissed: true }],
          });
          expect(
            await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }),
          ).toMatchObject({
            status: "suppressed",
          });
          expect(await fixtures.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
            status: "cancelled",
            checkpoint: null,
          });
        }
        const terminalWake = await within(() =>
          prepareWorkEventWake(prisma, { eventId: terminal.id }),
        );
        expect(terminalWake).toMatchObject({ status: "prepared", runId: expect.any(String) });
        expect("runId" in terminalWake && terminalWake.runId).not.toBe(runId);
      } finally {
        release.resolve();
        deliver.resolve();
        controller.abort();
        await delivery;
        await vi.waitFor(async () => expect((await saved()).leaseOwner).toBeNull(), {
          timeout: 12_000,
        });
      }
    },
  );

  it.each([
    "clear",
    "clear during pagination",
    "stop",
    "stale epoch",
    "stale origin",
    "expired lease",
    "replaced lease",
  ] as const)("does not save a late external receipt after %s", async (change) => {
    const { ticket, execution, receipt } = await externalQuestion();
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const partialPage = change === "clear during pagination";
    let inspections = 0;
    let reads = 0;
    const cancel = vi.fn();
    const monitorFinished = deferred();
    const monitorPrisma = prisma.$extends({
      query: {
        externalAgentExecution: {
          async updateMany({ args, query }) {
            const result = await query(args);
            if (args.where?.id === execution.id && args.data.leaseOwner === null)
              monitorFinished.resolve();
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;
    const connector = {
      async *execute(call: { tool: string; args: Record<string, unknown> }) {
        const session = { ...receipt.session };
        const value = {
          ...receipt,
          session,
          operation: { state: "completed", turnId: execution.turnId },
        };
        if (call.tool === "phone_inspect") {
          inspections += 1;
          if (inspections === (partialPage ? 2 : 1)) {
            entered.resolve();
            await release.promise;
          }
          yield {
            type: "result",
            data: { structuredContent: { ...value, privateOutput: "late receipt" } },
          };
        } else if (call.tool === "phone_read") {
          reads += 1;
          yield {
            type: "result",
            data: {
              structuredContent: {
                session,
                events:
                  reads === 1
                    ? [
                        {
                          seq: 1,
                          type: "result",
                          operationKey: execution.operationKey,
                          text: "late private output",
                        },
                      ]
                    : [],
                cursor: 1,
                hasMore: partialPage && reads === 1,
              },
            },
          };
        } else if (call.tool === "phone_stop") {
          cancel(call.args);
          yield { type: "result", data: { structuredContent: value } };
        } else throw new Error(`Unexpected receipt tool ${call.tool}`);
      },
    } as unknown as ConnectorProvider;
    const saved = () =>
      fixtures.externalAgentExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const cleared = change === "clear" || partialPage;
    let expectedOwner: string | null = null;
    try {
      await within(() =>
        reconcileExternalExecutions({
          ...deps(),
          prisma: monitorPrisma,
          connector,
          shutdownSignal: controller.signal,
        }),
      );
      await entered.promise;
      if (cleared) {
        await within(() =>
          clearThread(prisma, { spaceId, botId: chief.id, threadId: chief.threadId }),
        );
        expect(await saved()).toMatchObject({
          request: null,
          result: null,
          stopRequestedAt: expect.any(Date),
        });
      } else if (change === "stop") {
        await within(() =>
          prisma.$transaction((tx) =>
            requestManagedWorkStopInTransaction(tx, { spaceId, userId, ticketId: ticket.id }),
          ),
        );
      } else if (change === "stale epoch") {
        await fixtures.ticket.update({
          where: { id: ticket.id },
          data: { controlEpoch: { increment: 1 } },
        });
      } else if (change === "stale origin") {
        await fixtures.thread.update({
          where: { id: chief.threadId },
          data: { historyCompactionGeneration: { increment: 1 } },
        });
      } else if (change === "expired lease") {
        await fixtures.externalAgentExecution.update({
          where: { id: execution.id },
          data: { leaseExpiresAt: new Date(0) },
        });
      } else {
        expectedOwner = "replacement";
        await fixtures.externalAgentExecution.update({
          where: { id: execution.id },
          data: {
            leaseOwner: expectedOwner,
            leaseFence: { increment: 1 },
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      }
      const before = await saved();
      release.resolve();
      const staleLease = change === "expired lease" || change === "replaced lease";
      await monitorFinished.promise;
      expect(await saved()).toMatchObject({
        result: before.result,
        sessionId: before.sessionId,
        turnId: before.turnId,
        stopRequestedAt: before.stopRequestedAt,
        leaseOwner: expectedOwner,
        ...(staleLease
          ? { leaseFence: before.leaseFence, cursor: before.cursor, status: before.status }
          : { status: "completed", operationState: "completed", cursor: "1" }),
      });
      expect(
        await fixtures.workEvent.count({
          where: { ticketId: ticket.id, kind: "external_completed" },
        }),
      ).toBe(0);
      expect(
        await fixtures.message.count({
          where: { threadId: chief.threadId, clientNonce: `external-progress:${execution.id}` },
        }),
      ).toBe(0);
      expect(
        await fixtures.task.count({
          where: {
            spaceId,
            runs: { some: { ticketId: ticket.id, clientNonce: { startsWith: "work-event:" } } },
          },
        }),
      ).toBe(0);
      if (partialPage) {
        expect(reads).toBe(2);
        expect(cancel).toHaveBeenCalledWith(
          expect.objectContaining({ targetRequestId: execution.operationKey }),
        );
      }
    } finally {
      release.resolve();
      controller.abort();
      await monitorFinished.promise;
    }
  });

  it("routes all native questions to the original chat and sends exactly the real answers without a model", async () => {
    const { event, prepared, receipt, sourceRun } = await externalQuestion();
    expect(prepared).toMatchObject({
      status: "waiting_input",
      threadId: chief.threadId,
      enqueue: false,
    });
    const wake = await fixtures.run.findUniqueOrThrow({
      where: {
        id: (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).wakeRunId!,
      },
    });
    expect(wake).toMatchObject({
      threadId: specialist.threadId,
      trigger: "bot_message",
      status: "waiting_input",
    });
    expect(
      (await fixtures.message.findUniqueOrThrow({ where: { id: wake.sourceMessageId! } })).role,
    ).toBe("system");
    expect(await answerCard(wake.id, "option:1", { answeredByUserId: "other-user" })).toBe(false);
    expect(await answerCard(wake.id, "option:1")).toBe(true);
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: wake.id } })).status).toBe(
      "waiting_input",
    );
    const second = await inputCard(wake.id);
    expect(second.blocks).toMatchObject([{ kind: "ask", managedInput: { questionId: "heading" } }]);
    expect(await answerCard(wake.id, "User chosen title")).toBe(true);
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: wake.id } })).status).toBe(
      "queued",
    );
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const connector = {
      async *execute(call: { tool: string; args: Record<string, unknown> }) {
        calls.push(call);
        yield {
          type: "result",
          data: {
            structuredContent: {
              ...receipt,
              ...(call.tool === "phone_send"
                ? { operation: { state: "accepted", turnId: "native-turn" } }
                : {}),
            },
          },
        };
      },
    } as unknown as ConnectorProvider;
    const claim = await claimedInput(wake.id);
    expect(
      await within(() =>
        resumeManagedExternalInput(
          {
            prisma,
            connector,
            events: createThreadEvents(prisma),
            jobs: { enqueue },
          },
          claim,
        ),
      ),
    ).toEqual({ handled: true, status: "sent" });
    expect(calls.map((call) => call.tool)).toEqual(["phone_inspect", "phone_send"]);
    expect(calls[1]!.args).toMatchObject({
      sessionId: "native-session",
      expectedTurnId: "native-turn",
      inputRequestId: "native-request",
      answers: { format: { answers: ["HTML"] }, heading: { answers: ["User chosen title"] } },
    });
    expect(calls[1]!.args).not.toHaveProperty("message");
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: wake.id } })).status).toBe(
      "completed",
    );
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: sourceRun.id } })).status).toBe(
      "completed",
    );
    expect((await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      "handled",
    );
    expect(
      await fixtures.event.count({
        where: { threadId: chief.threadId, runId: wake.id, type: "run.completed" },
      }),
    ).toBe(1);
    const stored = await fixtures.$queryRaw<Array<{ payload: string }>>`
      SELECT payload::text FROM work_events WHERE id = ${event.id}`;
    expect(stored[0]!.payload).not.toContain("User chosen title");
  });

  it.each(["version", "epoch", "request", "restart", "clear", "thread"])(
    "rejects an external answer after its %s binding changes",
    async (change) => {
      const { event, execution, ticket, receipt } = await externalQuestion();
      const wakeId = (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .wakeRunId!;
      if (change === "version")
        await fixtures.ticket.update({
          where: { id: ticket.id },
          data: { requirementsVersion: { increment: 1 } },
        });
      if (change === "epoch")
        await fixtures.ticket.update({
          where: { id: ticket.id },
          data: { controlEpoch: { increment: 1 } },
        });
      if (change === "request")
        await fixtures.externalAgentExecution.update({
          where: { id: execution.id },
          data: { result: { ...receipt, pendingInputRequests: [] } },
        });
      if (change === "restart")
        await fixtures.externalAgentExecution.update({
          where: { id: execution.id },
          data: {
            result: {
              ...receipt,
              pendingInputRequests: receipt.pendingInputRequests.map((request) => ({
                ...request,
                resumable: false,
              })),
            },
          },
        });
      if (change === "clear")
        await fixtures.thread.update({
          where: { id: chief.threadId },
          data: { historyCompactionGeneration: { increment: 1 } },
        });
      expect(
        await answerCard(
          wakeId,
          "option:0",
          change === "thread" ? { threadId: reviewer.threadId } : {},
        ),
      ).toBe(false);
      expect((await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } })).status).toBe(
        "waiting_input",
      );
    },
  );

  it.each([{ supported: false }, { resumable: false }])(
    "blocks unsupported or disconnected native questions without a model wake: %o",
    async (options) => {
      const { event, prepared } = await externalQuestion(options);
      expect(prepared.status).toBe("blocked");
      expect(
        (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).wakeRunId,
      ).toBeNull();
      const cards = await fixtures.message.findMany({
        where: { threadId: chief.threadId, clientNonce: { startsWith: "work-input-blocked:" } },
      });
      expect(cards).toHaveLength(1);
    },
  );

  it("queries a previously dispatched answer after a worker restart and never resends unknown delivery", async () => {
    const { event, receipt } = await externalQuestion();
    const wakeId = (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .wakeRunId!;
    await answerCard(wakeId, "option:0");
    await answerCard(wakeId, "Saved title");
    const ready = await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } });
    const payload = ready.payload as Record<string, Prisma.InputJsonValue>;
    await fixtures.workEvent.update({
      where: { id: event.id },
      data: {
        payload: {
          ...payload,
          inputResponse: {
            ...(payload.inputResponse as Prisma.InputJsonObject),
            status: "dispatching",
          },
        },
      },
    });
    const tools: string[] = [];
    const connector = {
      async *execute(call: { tool: string }) {
        tools.push(call.tool);
        yield { type: "result", data: { structuredContent: { ...receipt, found: false } } };
      },
    } as unknown as ConnectorProvider;
    const claim = await claimedInput(wakeId);
    expect(
      await within(() =>
        resumeManagedExternalInput(
          { prisma, connector, events: createThreadEvents(prisma), jobs: { enqueue } },
          claim,
        ),
      ),
    ).toEqual({ handled: true, status: "unknown" });
    expect(tools).toEqual(["phone_inspect"]);
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } })).status).toBe("failed");
  });

  it("finalizes an answer with a durable delivery receipt even when the connection is gone", async () => {
    const { event } = await externalQuestion();
    const wakeId = (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .wakeRunId!;
    expect(await answerCard(wakeId, "option:0")).toBe(true);
    expect(await answerCard(wakeId, "Saved title")).toBe(true);
    const ready = await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } });
    const payload = ready.payload as Record<string, Prisma.InputJsonValue>;
    await fixtures.workEvent.update({
      where: { id: event.id },
      data: {
        status: "handled",
        handledAt: new Date(),
        payload: {
          ...payload,
          inputResponse: {
            ...(payload.inputResponse as Prisma.InputJsonObject),
            status: "submitted",
            receipt: { operation: { state: "accepted" } },
          },
        },
      },
    });

    const claim = await claimedInput(wakeId);
    expect(
      await within(() =>
        resumeManagedExternalInput(
          { prisma, events: createThreadEvents(prisma), jobs: { enqueue } },
          claim,
        ),
      ),
    ).toEqual({ handled: true, status: "sent" });
    expect(await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } })).toMatchObject({
      status: "completed",
    });
    expect(await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: "handled",
      payload: { inputResponse: { status: "submitted" } },
    });
  });

  it("preserves a native answer binding across a computer requeue and the next real claim", async () => {
    const { event } = await externalQuestion();
    const wakeId = (await fixtures.workEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .wakeRunId!;
    expect(await answerCard(wakeId, "option:0")).toBe(true);
    expect(await answerCard(wakeId, "Saved title")).toBe(true);
    const first = await claimedInput(wakeId);
    const before = await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } });
    expect(
      await within(() =>
        writeComputerRunRequeue(
          deps(),
          wakeId,
          first.leaseOwner,
          first.leaseFence,
          null,
          false,
          null,
          new Date(0),
        ),
      ),
    ).toBe(true);
    const requeued = await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } });
    expect(requeued).toMatchObject({
      status: "queued",
      checkpoint: before.checkpoint,
      leaseOwner: null,
    });
    const second = await claimedInput(wakeId);
    expect(second.leaseFence).toBe(first.leaseFence + 1);
    expect(
      await within(() =>
        writeComputerRunRequeue(
          deps(),
          wakeId,
          first.leaseOwner,
          first.leaseFence,
          null,
          false,
          null,
          null,
        ),
      ),
    ).toBe(false);
    const after = await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } });
    expect(after).toMatchObject({
      status: "running",
      checkpoint: before.checkpoint,
      leaseFence: second.leaseFence,
    });
    const calls: string[] = [];
    const connector = {
      async *execute(call: { tool: string }) {
        calls.push(call.tool);
        yield { type: "result", data: { structuredContent: { found: false } } };
      },
    } as unknown as ConnectorProvider;
    expect(
      await within(() =>
        resumeManagedExternalInput(
          {
            prisma,
            connector,
            events: createThreadEvents(prisma),
            jobs: { enqueue },
          },
          second,
        ),
      ),
    ).toEqual({ handled: true, status: "blocked" });
    expect(calls).toEqual(["phone_inspect"]);
    expect((await fixtures.run.findUniqueOrThrow({ where: { id: wakeId } })).status).toBe("failed");
  });
});
