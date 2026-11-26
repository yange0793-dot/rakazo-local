import { runContinueJob } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import {
  attachmentComputerPath,
  messageBlockForArtifact,
  userTurnMessageForRun,
  userVisibleMessages,
} from "@rakazo/core";
import type * as Db from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  getManagedWorkAdmission,
  listPendingWorkEvents,
  managedWorkOriginAvailable,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  managedWorkInputAttachmentsInTransaction,
  prepareWorkEventWake,
  reconcileManagedWorkEvents,
} from "./managed-work-events.js";
import { listCurrentTurnFiles, materializeCurrentTurnFiles } from "./thread-artifacts.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "source-message" })),
  getManagedWorkAdmission: vi.fn(async () => ({ admitted: true })),
  listPendingWorkEvents: vi.fn(async () => []),
  managedWorkOriginAvailable: vi.fn(async () => true),
}));

function harness(
  options: { kind?: string; active?: boolean; receipt?: boolean; dependency?: boolean } = {},
) {
  const event: Db.WorkEvent = {
    id: "event-1",
    eventKey: "child-outcome-1",
    kind: options.kind ?? "child_outcome",
    spaceId: "space-1",
    userId: "user-1",
    ticketId: "ticket-1",
    controlEpoch: 0,
    targetBotId: "bot-1",
    targetThreadId: "thread-1",
    sourceTicketId: "child-ticket",
    sourceRunId: "child-run",
    wakeRunId: null,
    payload: {
      sourceTicketId: "child-ticket",
      summary: "The final article is ready.",
      finalArtifactId: "article-1",
      artifactIds: ["article-1", "sources-1"],
      ...(options.receipt
        ? { receiptMessageId: "receipt-1", receiptVersion: 1, requirementsVersion: 2 }
        : {}),
      ...(options.kind === "dispatch" ? { messageId: "dispatch-source", taskId: "task-1" } : {}),
    },
    status: "pending",
    handledAt: null,
    createdAt: new Date("2026-11-26T00:00:00Z"),
    updatedAt: new Date("2026-11-26T00:00:00Z"),
  };
  const ticket = {
    id: event.ticketId,
    spaceId: event.spaceId,
    createdByUserId: event.userId,
    createdByBotId: "coordinator",
    originThreadId: "origin-thread",
    originMessageId: "original-request",
    originRoutineId: null,
    originGeneration: 0,
    managedVersion: 1,
    controlEpoch: event.controlEpoch,
    requirementsVersion: 2,
    stopRequestedAt: null,
  };
  const source = {
    ...ticket,
    id: "child-ticket",
    parentTicketId: ticket.id,
    receiptVersion: 1,
    acceptedRequirementsVersion: 2 as number | null,
    acceptedReceiptVersion: 1 as number | null,
    stopRequestedAt: null as Date | null,
  };
  const artifacts = [
    { id: "receipt-json", name: "work-child-ticket.json", mimeType: "application/json", size: 25 },
    { id: "article-1", name: "article.md", mimeType: "text/markdown", size: 41 },
    { id: "figure-1", name: "figure.png", mimeType: "image/png", size: 7 },
  ].map((artifact) => ({
    ...artifact,
    spaceId: ticket.spaceId,
    userId: ticket.createdByUserId,
    botId: ticket.createdByBotId,
    groupId: null as string | null,
    storageKey: `stored-${artifact.id}`,
  }));
  const receipt = {
    id: "receipt-1",
    role: "bot",
    botId: ticket.createdByBotId,
    runId: event.sourceRunId,
    threadId: ticket.originThreadId,
    replyToMessageId: ticket.originMessageId,
    clientNonce: "work-receipt:child-ticket:1:hash",
    blocks: [{ kind: "delivery" }, ...artifacts.map(messageBlockForArtifact)] as MessageBlock[],
    thread: {
      spaceId: ticket.spaceId,
      userId: ticket.createdByUserId,
      groupId: null as string | null,
    },
    run: {
      spaceId: ticket.spaceId,
      userId: ticket.createdByUserId,
      ticketId: source.id,
      workControlEpoch: source.controlEpoch,
      workRequirementsVersion: source.requirementsVersion,
    },
  };
  const inputs = [
    { id: "active-source", blocks: [{ kind: "delivery" }] as MessageBlock[] },
    {
      id: "dispatch-source",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "coordinator",
          fromBotName: "Coordinator",
          text: "Write the article from the accepted research.",
        },
      ] as MessageBlock[],
    },
  ];
  const dependencies = options.dependency
    ? [{ requirementsVersion: 2, receiptVersion: 1 as number | null, prerequisiteTicket: source }]
    : [];
  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) =>
        (value !== null && typeof value === "object") ||
        (row as Record<string, unknown>)[key] === value,
    );
  const task = { id: "task-1", prompt: "Finish the existing assignment." };
  let wake = options.active
    ? {
        id: "wake-1",
        taskId: task.id,
        status: "queued",
        checkpoint: null,
        sourceMessageId: "active-source",
      }
    : null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    workEvent: {
      findUnique: vi.fn(async () => event),
      findUniqueOrThrow: vi.fn(async () => event),
      update: vi.fn(async ({ data }: { data: Partial<Db.WorkEvent> }) =>
        Object.assign(event, data),
      ),
    },
    ticket: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === ticket.id ? ticket : matches(source, where) ? source : null,
      ),
    },
    ticketDependency: { findMany: vi.fn(async () => dependencies) },
    artifact: {
      findMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> & { id: { in: string[] } } }) =>
          artifacts.filter(
            (artifact) => where.id.in.includes(artifact.id) && matches(artifact, where),
          ),
      ),
    },
    bot: { findFirst: vi.fn(async () => ({ id: event.targetBotId })) },
    thread: { findFirst: vi.fn(async () => ({ id: event.targetThreadId })) },
    run: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === receipt.runId
          ? matches({ id: receipt.runId, ...receipt.run }, where)
            ? { id: receipt.runId }
            : null
          : wake,
      ),
      findUnique: vi.fn(async () => ({ id: "child-run", status: "completed" })),
      create: vi.fn(async (_input: { data: unknown }) => {
        wake = {
          id: "wake-1",
          taskId: task.id,
          status: "queued",
          checkpoint: null,
          sourceMessageId: "source-message",
        };
        return wake;
      }),
    },
    task: {
      findFirst: vi.fn(async () => task),
      findUniqueOrThrow: vi.fn(async () => task),
      create: vi.fn(async ({ data }: { data: { prompt: string } }) => {
        task.prompt = data.prompt;
        return task;
      }),
      update: vi.fn(async ({ data }: { data: { prompt: string } }) => {
        task.prompt = data.prompt;
        return task;
      }),
    },
    message: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: Record<string, unknown> & {
            clientNonce?: { startsWith: string };
            thread?: Record<string, unknown>;
          };
        }) => {
          if (!where.clientNonce) return inputs.find((input) => input.id === where.id) ?? null;
          return matches(receipt, where) &&
            receipt.clientNonce.startsWith(where.clientNonce.startsWith) &&
            matches(receipt.thread, where.thread ?? {})
            ? receipt
            : null;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { blocks?: MessageBlock[]; runId?: string };
        }) => {
          const input = inputs.find((input) => input.id === where.id);
          if (input && data.blocks) input.blocks = data.blocks;
          return {};
        },
      ),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const events = { notify: vi.fn(async () => undefined) };
  vi.mocked(listPendingWorkEvents).mockResolvedValue([event]);
  return {
    deps: { prisma: prisma as never, jobs: jobs as never, events },
    tx,
    task,
    event,
    ticket,
    source,
    receipt,
    artifacts,
    dependencies,
    inputs,
    jobs,
    events,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("managed work notification visibility", () => {
  it.each(["child_outcome", "requirements_changed", "external_completed"])(
    "wakes for %s with full context and a hidden source message",
    async (kind) => {
      const h = harness({ kind });
      const results = await reconcileManagedWorkEvents(h.deps);

      expect(results).toEqual([
        { eventId: "event-1", status: "prepared", runId: "wake-1", threadId: "thread-1" },
      ]);
      expect(h.jobs.enqueue).toHaveBeenCalledWith(runContinueJob("wake-1"));
      expect(h.tx.run.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sourceMessageId: "source-message",
          trigger: "bot_message",
          taskId: "task-1",
          ticketId: "ticket-1",
          workControlEpoch: 0,
          workRequirementsVersion: 2,
          status: "queued",
        }),
        select: { id: true },
      });
      expect(h.task.prompt).toContain(JSON.stringify(h.event.payload));
      expect(h.event).toMatchObject({ status: "prepared", wakeRunId: "wake-1" });
      const [, source] = vi.mocked(createThreadMessageInTransaction).mock.calls[0]!;
      expect(source).toEqual({
        threadId: "thread-1",
        role: "system",
        blocks: [{ kind: "delivery" }],
        clientNonce: "work-event:event-1",
        markUnread: false,
      });
      expect(MessageBlock.parse(source.blocks[0])).toEqual({ kind: "delivery" });
      expect(
        userVisibleMessages([{ ...source, id: "source-message" }], { includePeerReceipts: true }),
      ).toEqual([]);
      expect(h.tx.message.update).toHaveBeenCalledWith({
        where: { id: "source-message" },
        data: { runId: "wake-1" },
      });
      expect(appendEventInTransaction).not.toHaveBeenCalled();
      expect(h.events.notify).not.toHaveBeenCalled();
    },
  );

  it("merges new evidence into a queued run without publishing a work update", async () => {
    const h = harness({ active: true });
    await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id });

    expect(h.task.prompt).toContain("Finish the existing assignment.");
    expect(h.task.prompt).toContain(JSON.stringify(h.event.payload));
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.tx.task.create).not.toHaveBeenCalled();
    expect(h.tx.task.update).toHaveBeenCalledOnce();
    const [, source] = vi.mocked(createThreadMessageInTransaction).mock.calls[0]!;
    expect(userVisibleMessages([{ ...source, id: "source-message" }])).toEqual([]);
    expect(appendEventInTransaction).not.toHaveBeenCalled();
  });

  it("recovers an enqueue failure without creating another message, task, or wake", async () => {
    const h = harness();
    h.jobs.enqueue.mockRejectedValueOnce(new Error("queue offline"));
    expect(await reconcileManagedWorkEvents(h.deps)).toEqual([
      { eventId: "event-1", status: "deferred" },
    ]);
    const results = await reconcileManagedWorkEvents(h.deps);

    expect(results).toEqual([
      {
        eventId: "event-1",
        status: "prepared",
        runId: "wake-1",
        threadId: "thread-1",
        enqueue: true,
      },
    ]);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(h.tx.run.create).toHaveBeenCalledOnce();
    expect(h.tx.task.create).toHaveBeenCalledOnce();
    expect(createThreadMessageInTransaction).toHaveBeenCalledOnce();
    expect(appendEventInTransaction).not.toHaveBeenCalled();
    expect(h.events.notify).not.toHaveBeenCalled();
  });
});

describe("managed work receipt attachments", () => {
  it("materializes the receipt's files and images from the hidden current-turn source", async () => {
    const h = harness({ receipt: true });
    await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id });
    const [, input] = vi.mocked(createThreadMessageInTransaction).mock.calls[0]!;
    const source = { ...input, id: "source-message", runId: "wake-1" };
    expect(source.blocks).toEqual([
      { kind: "delivery" },
      ...h.artifacts.map(messageBlockForArtifact),
    ]);
    expect(userVisibleMessages([source])).toEqual([]);
    const current = userTurnMessageForRun("bot_message", "wake-1", [source], source.id);
    expect(current).toEqual(source);

    const context = {
      operationId: "wake-1",
      traceId: "wake-1",
      runId: "wake-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const bytes = new Map(
      h.artifacts.map((artifact) => [artifact.storageKey, new TextEncoder().encode(artifact.name)]),
    );
    const get = vi.fn(async (key: string) => bytes.get(key)!);
    const writeFile = vi.fn(async () => undefined);
    const deps = {
      prisma: h.tx as never,
      artifacts: { get } as never,
      sandbox: { writeFile } as never,
    };
    const expected = h.artifacts.map(({ id, name, mimeType, size }) => ({
      name,
      mimeType,
      size,
      path: attachmentComputerPath(id, mimeType),
    }));
    expect(await listCurrentTurnFiles(deps, current!.blocks, context)).toEqual(expected);
    expect(
      await materializeCurrentTurnFiles(deps, current!.blocks, {
        context,
        computer: async () => ({ id: "computer-1" }) as never,
        computerMode: "team",
      }),
    ).toEqual(expected);
    expect(writeFile).toHaveBeenCalledTimes(h.artifacts.length);
    for (const artifact of h.artifacts) {
      expect(writeFile).toHaveBeenCalledWith(
        expect.anything(),
        {
          path: expect.stringContaining(attachmentComputerPath(artifact.id, artifact.mimeType)),
          content: bytes.get(artifact.storageKey),
        },
        context,
      );
    }
    expect(h.tx.run.findFirst).toHaveBeenCalledWith({
      where: {
        id: "child-run",
        spaceId: "space-1",
        userId: "user-1",
        ticketId: "child-ticket",
        workControlEpoch: 0,
        workRequirementsVersion: 2,
      },
      select: { id: true },
    });
    expect(appendEventInTransaction).not.toHaveBeenCalled();
  });

  it("adds accepted dependency outputs when a waiting dispatch starts", async () => {
    const h = harness({ kind: "dispatch", dependency: true });
    const original = [...h.inputs[1]!.blocks];
    await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id });
    expect(h.inputs[1]!.blocks).toEqual([...original, ...h.artifacts.map(messageBlockForArtifact)]);
    expect(h.tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceMessageId: "dispatch-source" }),
      select: { id: true },
    });
    expect(h.event.status).toBe("handled");
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(appendEventInTransaction).not.toHaveBeenCalled();
  });

  it("provides the same validated dependency files to an immediate dispatch", async () => {
    const h = harness({ dependency: true });
    h.dependencies[0]!.receiptVersion = null;
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never),
    ).toEqual(h.artifacts.map(messageBlockForArtifact));
    expect(h.tx.message.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        threadId: "origin-thread",
        role: "bot",
        botId: "coordinator",
        replyToMessageId: "original-request",
        clientNonce: { startsWith: "work-receipt:child-ticket:1:" },
        thread: { spaceId: "space-1", userId: "user-1" },
      }),
      select: { runId: true, blocks: true, thread: { select: { groupId: true } } },
    });
  });

  it("keeps a dispatch waiting when the dependencies have not been accepted", async () => {
    const h = harness({ kind: "dispatch", dependency: true });
    vi.mocked(getManagedWorkAdmission).mockResolvedValueOnce({
      admitted: false,
      reason: "dependencies",
    } as never);
    expect(await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id })).toEqual({
      status: "waiting",
      reason: "dependencies",
    });
    expect(h.tx.message.update).not.toHaveBeenCalled();
    expect(h.tx.run.create).not.toHaveBeenCalled();
  });

  it.each([
    { requirementsVersion: 3 },
    { acceptedRequirementsVersion: null },
    { acceptedReceiptVersion: null },
    { acceptedReceiptVersion: 2 },
    { stopRequestedAt: new Date("2026-11-26T01:00:00Z") },
    { spaceId: "another-space" },
    { createdByUserId: "another-user" },
  ])("excludes an ineligible prerequisite: %j", async (change) => {
    const h = harness({ dependency: true });
    Object.assign(h.source, change);
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never),
    ).toEqual([]);
    expect(h.tx.artifact.findMany).not.toHaveBeenCalled();
  });

  it.each([
    "different-parent",
    "stale-requirements",
    "stale-receipt",
    "different-message",
    "different-run",
    "different-origin",
    "wrong-receipt-role",
    "different-run-owner",
    "different-run-ticket",
    "stale-run-epoch",
    "stale-run-requirements",
  ])("does not grant files from a mismatched child receipt: %s", async (change) => {
    const h = harness({ receipt: true });
    switch (change) {
      case "different-parent":
        h.source.parentTicketId = "other-parent";
        break;
      case "stale-requirements":
        h.source.requirementsVersion += 1;
        break;
      case "stale-receipt":
        h.source.receiptVersion += 1;
        break;
      case "different-message":
        h.receipt.id = "other-receipt";
        break;
      case "different-run":
        h.receipt.runId = "other-run";
        break;
      case "different-origin":
        h.receipt.replyToMessageId = "other-request";
        break;
      case "wrong-receipt-role":
        h.receipt.role = "user";
        break;
      case "different-run-owner":
        h.receipt.run.userId = "other-user";
        break;
      case "different-run-ticket":
        h.receipt.run.ticketId = "other-ticket";
        break;
      case "stale-run-epoch":
        h.receipt.run.workControlEpoch += 1;
        break;
      case "stale-run-requirements":
        h.receipt.run.workRequirementsVersion += 1;
        break;
    }
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never, h.event),
    ).toEqual([]);
    expect(h.tx.artifact.findMany).not.toHaveBeenCalled();
  });

  it("rejects files whose prerequisite source was cleared", async () => {
    const h = harness({ dependency: true });
    vi.mocked(managedWorkOriginAvailable).mockResolvedValueOnce(false);
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never),
    ).toEqual([]);
    expect(h.tx.message.findFirst).not.toHaveBeenCalled();
  });

  it("does not guess attachments from artifact ids in the event payload", async () => {
    const h = harness();
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never, h.event),
    ).toEqual([]);
    expect(h.tx.artifact.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { spaceId: "other-space" },
    { userId: "other-user" },
    { botId: "other-bot" },
    { groupId: "other-group" },
  ])("excludes a receipt file outside its original chat's ownership: %j", async (change) => {
    const h = harness({ receipt: true });
    Object.assign(h.artifacts[1]!, change);
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never, h.event),
    ).toEqual([h.artifacts[0]!, h.artifacts[2]!].map(messageBlockForArtifact));
  });

  it("allows files already shared into the original group", async () => {
    const h = harness({ receipt: true });
    h.receipt.thread.groupId = "original-group";
    for (const artifact of h.artifacts)
      Object.assign(artifact, { groupId: "original-group", botId: "group-bot", userId: "member" });
    expect(
      await managedWorkInputAttachmentsInTransaction(h.tx as never, h.ticket as never, h.event),
    ).toEqual(h.artifacts.map(messageBlockForArtifact));
  });

  it("merges files into the queued run's actual source without duplicating an attachment", async () => {
    const h = harness({ active: true, receipt: true, dependency: true });
    const existing = messageBlockForArtifact(h.artifacts[1]!);
    h.inputs[0]!.blocks.push(existing);
    await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id });
    expect(h.inputs[0]!.blocks).toEqual([
      { kind: "delivery" },
      existing,
      ...[h.artifacts[0]!, h.artifacts[2]!].map(messageBlockForArtifact),
    ]);
    expect(h.tx.run.create).not.toHaveBeenCalled();
    expect(h.task.prompt).toContain(JSON.stringify(h.event.payload));
  });

  it("waits to deliver new files without rewriting a queued user's source message", async () => {
    const h = harness({ active: true, receipt: true });
    h.inputs[0]!.blocks = [{ kind: "text", text: "A new user request." }];
    expect(await prepareWorkEventWake(h.deps.prisma, { eventId: h.event.id })).toEqual({
      status: "waiting",
    });
    expect(h.event.status).toBe("pending");
    expect(h.tx.message.update).not.toHaveBeenCalled();
    expect(createThreadMessageInTransaction).not.toHaveBeenCalled();
    expect(h.tx.task.update).not.toHaveBeenCalled();
  });
});
