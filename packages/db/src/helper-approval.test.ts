import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExternalEffect, PrismaClient } from "./client.js";
import { clearThread } from "./events.js";
import { installSecurityEventStore } from "./security-events.js";
import { answerRunInput, pauseRunForInput } from "./thread-ask.js";

class TestFanout implements RealtimeFanout {
  describe() {
    return {
      id: "test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { distributed: false, push: true },
    };
  }

  async publish(_topic: string, _payload: string) {}

  async subscribe(_topic: string, _subscriber: (payload: string) => void) {
    return async () => {};
  }

  async close() {}
}

function eventRow(data: {
  spaceId?: string;
  threadId: string;
  botId?: string;
  seq: number;
  type: string;
  runId?: string | null;
}) {
  return {
    id: `event-${data.seq}`,
    spaceId: data.spaceId ?? "space-1",
    threadId: data.threadId,
    botId: data.botId ?? "bot-1",
    seq: data.seq,
    type: data.type,
    payload: {},
    runId: data.runId ?? null,
    createdAt: new Date("2026-11-15T12:00:00.000Z"),
  };
}

/** The subagent card left in the chat when the helper started. */
const helperCard = {
  kind: "subagent" as const,
  agentId: "execution-1",
  name: "Scout",
  task: "fetch the venue page",
  status: "running" as const,
};

/** The approval the gate builds for a helper's gated tool. */
const approvalAsk = {
  kind: "ask" as const,
  approvalEffectId: "effect-1",
  text: "Review before web_fetch",
  detail: "url: https://example.com/venues",
  status: "pending" as const,
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "deny", label: "Deny" },
  ],
};

/**
 * A helper run paused on its hidden thread, with its source card in the parent chat. Every
 * table the pause path touches is mocked; a test overrides only what it exercises.
 */
function pauseTransaction(options: { threadLock?: Array<{ id: string }> } = {}) {
  return {
    $executeRaw: vi.fn(async () => 0),
    // The first two calls are the thread locks; their template values order the two chats.
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) =>
        options.threadLock ?? [{ id: "thread-parent" }],
    ),
    run: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({
        userId: "user-1",
        trigger: "helper",
        botId: "bot-1",
        spaceId: "space-1",
        sourceMessageId: "card-1",
      })),
    },
    externalEffect: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "effect-1" })),
    },
    message: {
      findFirst: vi.fn(
        async (): Promise<{ id: string; blocks: MessageBlock[] } | null> => ({
          id: "card-1",
          blocks: [helperCard],
        }),
      ),
      create: vi.fn(async () => ({ id: "ask-message" })),
      update: vi.fn(async () => ({ id: "card-1" })),
    },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 7 })
        .mockResolvedValueOnce({ nextEventSeq: 11 })
        .mockResolvedValueOnce({ nextEventSeq: 3 })
        .mockResolvedValueOnce({ nextEventSeq: 12 })
        .mockResolvedValue({ nextEventSeq: 13 }),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Parameters<typeof eventRow>[0] }) => eventRow(data)),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    steeringMessage: { findMany: vi.fn(async () => []) },
  };
}

function pauseClient(tx: ReturnType<typeof pauseTransaction>) {
  return {
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
}

const pauseInput = {
  spaceId: "space-1",
  threadId: "helper-thread",
  botId: "bot-1",
  runId: "helper-run",
  attemptId: "attempt-1",
  leaseOwner: "worker-1",
  leaseFence: 4,
  blocks: [approvalAsk],
  cardThreadId: "thread-parent",
};

describe("pauseRunForInput across chats", () => {
  it("shows the card in the chat that started the helper and pauses the run on its own thread", async () => {
    const fanout = new TestFanout();
    const publish = vi.spyOn(fanout, "publish");
    const tx = pauseTransaction();

    await expect(pauseRunForInput(pauseClient(tx), pauseInput, fanout)).resolves.toEqual({
      continuationRunId: null,
      cardThreadId: "thread-parent",
    });

    // The parent chat is locked before the run's own thread, the order clear and outcome use.
    expect(tx.$queryRaw.mock.calls[0]![1]).toBe("thread-parent");
    expect(tx.$queryRaw.mock.calls[0]![2]).toBe("space-1");
    expect(tx.$queryRaw.mock.calls[1]![1]).toBe("helper-thread");

    // The run itself keeps its lease check, attempt, hidden-thread pause and lease release.
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "helper-run",
          spaceId: "space-1",
          threadId: "helper-thread",
          botId: "bot-1",
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 4,
        },
      }),
    );
    expect(tx.attempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "attempt-1", runId: "helper-run", fence: 4, status: "running" },
      }),
    );
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: "helper-run" },
      data: { expiresAt: new Date(0) },
    });

    // The ask lands in the parent chat, named and marked with the verified source card.
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "thread-parent",
          botId: "bot-1",
          runId: "helper-run",
          blocks: [
            expect.objectContaining({
              kind: "ask",
              approvalEffectId: "effect-1",
              helper: { messageId: "card-1", name: "Scout" },
              text: 'Helper "Scout": Review before web_fetch',
              status: "pending",
            }),
          ],
        }),
      }),
    );
    // The source card says it is waiting, in the same transaction.
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-1" },
      data: { blocks: [{ ...helperCard, status: "waiting" }] },
    });

    const events = tx.event.create.mock.calls.map(([input]) => input.data);
    expect(events.map((data) => [data.type, data.threadId])).toEqual([
      ["thread.message.created", "thread-parent"],
      ["run.waiting_input", "helper-thread"],
      ["thread.message.updated", "thread-parent"],
    ]);
    expect(events[1]).toMatchObject({ runId: "helper-run", payload: { userId: "user-1" } });
    expect(events[2]).toMatchObject({
      payload: { messageId: "card-1", blocks: [{ ...helperCard, status: "waiting" }] },
    });

    // Nothing follows the helper into the parent chat: steering stays on the hidden thread.
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "helper-thread", botId: "bot-1" }),
      }),
    );
    // Each chat hears about its own committed rows, and only after commit.
    expect(publish).toHaveBeenCalledWith("thread:helper-thread", JSON.stringify({ cursor: 2 }));
    expect(publish).toHaveBeenCalledWith("thread:thread-parent", JSON.stringify({ cursor: 11 }));
  });

  it.each([
    [
      "a choice ask",
      {
        kind: "ask",
        text: "Which token?",
        status: "pending",
        actions: [{ id: "choice-1", label: "use the first" }],
      },
    ],
    ["a free-text ask", { kind: "ask", text: "Which city?", status: "pending" }],
    ["a secret ask", { kind: "ask", text: "API key?", input: "secret", status: "pending" }],
  ] satisfies Array<[string, MessageBlock]>)("refuses %s for another chat", async (_label, ask) => {
    const tx = pauseTransaction();

    await expect(pauseRunForInput(pauseClient(tx), { ...pauseInput, blocks: [ask] })).resolves.toBe(
      false,
    );
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("writes no card when the worker lost the run's lease", async () => {
    const tx = pauseTransaction();
    tx.run.updateMany.mockResolvedValue({ count: 0 });

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(tx.computerExecutionLease.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a card thread that is not in this space", async () => {
    const tx = pauseTransaction({ threadLock: [] });

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("refuses a run that is not a background helper", async () => {
    const tx = pauseTransaction();
    tx.run.findUnique.mockResolvedValue({
      userId: "user-1",
      trigger: "user",
      botId: "bot-1",
      spaceId: "space-1",
      sourceMessageId: "message-1",
    });

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("refuses a source card the chat does not hold", async () => {
    const tx = pauseTransaction();
    tx.message.findFirst.mockResolvedValue(null);

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("refuses a source message that is not a helper card", async () => {
    const tx = pauseTransaction();
    tx.message.findFirst.mockResolvedValue({
      id: "card-1",
      blocks: [{ kind: "text", text: "venue notes" }],
    });

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("refuses an approval whose effect is not this run's intended effect", async () => {
    const tx = pauseTransaction();
    tx.externalEffect.findFirst.mockResolvedValue(null);

    await expect(pauseRunForInput(pauseClient(tx), pauseInput)).resolves.toBe(false);
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "effect-1",
          spaceId: "space-1",
          runId: "helper-run",
          status: "intended",
        },
      }),
    );
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a same-thread pause exactly as before", async () => {
    const tx = pauseTransaction();

    await expect(
      pauseRunForInput(pauseClient(tx), { ...pauseInput, cardThreadId: undefined }),
    ).resolves.toEqual({ continuationRunId: null });

    // One thread, no source lookup, no decoration and no card update.
    const locks = tx.$queryRaw.mock.calls.filter(([strings]) =>
      String(strings).includes("FOR UPDATE"),
    );
    expect(locks).toHaveLength(1);
    expect(locks[0]![1]).toBe("helper-thread");
    expect(tx.message.findFirst).not.toHaveBeenCalled();
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ threadId: "helper-thread", blocks: [approvalAsk] }),
      }),
    );
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});

/** The parent chat's approval card, as pause wrote it. */
const routedAsk = {
  ...approvalAsk,
  helper: { messageId: "card-1", name: "Scout" },
  text: 'Helper "Scout": Review before web_fetch',
};

function answerTransaction() {
  return {
    $queryRaw: vi.fn(async () => [{ id: "thread-parent" }]),
    run: {
      findFirst: vi
        .fn()
        // The parent chat holds no run with this id; the linked helper run is found next.
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          botId: "bot-1",
          userId: "user-1",
          checkpoint: null,
          trigger: "helper",
          clientNonce: null,
          threadId: "helper-thread",
          sourceMessageId: "card-1",
          task: { prompt: "fetch the venue page" },
        }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: "queued" })),
    },
    message: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ id: "ask-message", blocks: [routedAsk] })
        .mockResolvedValueOnce({ id: "card-1", blocks: [{ ...helperCard, status: "waiting" }] }),
      update: vi.fn(async () => ({ id: "ask-message" })),
    },
    externalEffect: {
      findFirst: vi.fn(
        async (): Promise<Pick<
          ExternalEffect,
          "id" | "kind" | "status" | "request" | "batchActions"
        > | null> => ({
          id: "effect-1",
          kind: "web_fetch",
          status: "intended",
          request: { url: "https://example.com/venues" },
          batchActions: null,
        }),
      ),
      update: vi.fn(async () => ({ id: "effect-1" })),
    },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 6 })) },
    event: {
      create: vi.fn(async ({ data }: { data: Parameters<typeof eventRow>[0] }) => eventRow(data)),
    },
  };
}

function answerClient(tx: ReturnType<typeof answerTransaction>) {
  return {
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
}

const answerInput = {
  spaceId: "space-1",
  threadId: "thread-parent",
  runId: "helper-run",
  messageId: "ask-message",
  answeredByUserId: "user-1",
  answer: "allow",
};

describe("answerRunInput for a helper's card in another chat", () => {
  it("answers only the helper run and reopens its card", async () => {
    const fanout = new TestFanout();
    const tx = answerTransaction();
    const audit = { securityEvent: { create: vi.fn(async () => ({})) } };
    installSecurityEventStore(audit as never);

    await expect(answerRunInput(answerClient(tx), answerInput, fanout)).resolves.toBe(true);
    installSecurityEventStore(undefined);

    // The run is found through the persisted source card, never by trusting the run id alone.
    expect(tx.run.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "helper-run",
          spaceId: "space-1",
          status: "waiting_input",
          trigger: "helper",
          sourceMessage: { threadId: "thread-parent" },
        },
      }),
    );
    // It resumes on its own hidden thread, not the chat that showed the card.
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "helper-run",
        spaceId: "space-1",
        threadId: "helper-thread",
        status: "waiting_input",
      },
      data: { status: "queued" },
    });
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "approved" },
    });
    // The answer is recorded on the card the user saw, keeping who asked.
    expect(tx.message.update).toHaveBeenNthCalledWith(1, {
      where: { id: "ask-message" },
      data: {
        blocks: [
          {
            ...routedAsk,
            status: "answered",
            answer: "allow",
          },
        ],
      },
    });
    // And the helper's own card says it is working again in the same transaction.
    expect(tx.message.update).toHaveBeenNthCalledWith(2, {
      where: { id: "card-1" },
      data: { blocks: [{ ...helperCard, status: "running" }] },
    });
    const events = tx.event.create.mock.calls.map(([input]) => input.data);
    expect(events.map((data) => [data.type, data.threadId, data.runId])).toEqual([
      ["thread.message.updated", "thread-parent", "helper-run"],
      ["thread.message.updated", "thread-parent", "helper-run"],
    ]);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(audit.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "approval.decided",
        metadata: { decision: "allow", effectKind: "web_fetch", runId: "helper-run" },
      }),
    });
  });

  it("records a denial without executing and reopens the card", async () => {
    const tx = answerTransaction();

    await expect(
      answerRunInput(answerClient(tx), { ...answerInput, answer: "deny" }),
    ).resolves.toBe(true);
    expect(tx.externalEffect.update).toHaveBeenCalledWith({
      where: { id: "effect-1" },
      data: { status: "denied" },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "queued" } }),
    );
    expect(tx.message.update).toHaveBeenNthCalledWith(2, {
      where: { id: "card-1" },
      data: { blocks: [{ ...helperCard, status: "running" }] },
    });
  });

  it("refuses an answer from anyone but the run's own user", async () => {
    const tx = answerTransaction();
    tx.run.findFirst.mockReset();
    tx.run.findFirst.mockResolvedValue({
      botId: "bot-1",
      userId: "user-2",
      checkpoint: null,
      trigger: "helper",
      clientNonce: null,
      threadId: "helper-thread",
      sourceMessageId: "card-1",
      task: { prompt: "fetch the venue page" },
    });

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.message.findFirst).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a run from another space, or one stopped since its card was shown", async () => {
    const tx = answerTransaction();
    tx.run.findFirst.mockReset();
    tx.run.findFirst.mockResolvedValue(null);

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.run.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          status: "waiting_input",
          trigger: "helper",
        }),
      }),
    );
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an answer once the source card is gone", async () => {
    const tx = answerTransaction();
    tx.message.findFirst.mockReset();
    tx.message.findFirst
      .mockResolvedValueOnce({ id: "ask-message", blocks: [routedAsk] })
      .mockResolvedValueOnce(null);

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.externalEffect.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a card naming another helper card",
      { ...routedAsk, helper: { messageId: "card-2", name: "Scout" } },
    ],
    [
      "a card naming another helper",
      { ...routedAsk, helper: { messageId: "card-1", name: "Rival" } },
    ],
    ["a card with no helper metadata", { ...approvalAsk }],
  ] satisfies Array<[string, MessageBlock]>)("refuses %s", async (_label, ask) => {
    const tx = answerTransaction();
    tx.message.findFirst.mockReset();
    tx.message.findFirst
      .mockResolvedValueOnce({ id: "ask-message", blocks: [ask] })
      .mockResolvedValueOnce({ id: "card-1", blocks: [{ ...helperCard, status: "waiting" }] });

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.externalEffect.update).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an approval effect that belongs to another run", async () => {
    const tx = answerTransaction();
    tx.externalEffect.findFirst.mockResolvedValue(null);

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.externalEffect.findFirst).toHaveBeenCalledWith({
      where: {
        id: "effect-1",
        spaceId: "space-1",
        runId: "helper-run",
        status: "intended",
      },
    });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an already answered card", async () => {
    const tx = answerTransaction();
    tx.message.findFirst.mockReset();
    tx.message.findFirst
      .mockResolvedValueOnce({
        id: "ask-message",
        blocks: [{ ...routedAsk, status: "answered", answer: "allow" }],
      })
      .mockResolvedValueOnce({ id: "card-1", blocks: [{ ...helperCard, status: "waiting" }] });

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a secret ask",
      {
        kind: "ask",
        text: routedAsk.text,
        helper: routedAsk.helper,
        input: "secret",
        status: "pending",
      },
    ],
    [
      "a free-text ask",
      { kind: "ask", text: routedAsk.text, helper: routedAsk.helper, status: "pending" },
    ],
  ] satisfies Array<[string, MessageBlock]>)("refuses %s in another chat", async (_label, ask) => {
    const tx = answerTransaction();
    tx.message.findFirst.mockReset();
    tx.message.findFirst
      .mockResolvedValueOnce({ id: "ask-message", blocks: [ask] })
      .mockResolvedValueOnce({ id: "card-1", blocks: [{ ...helperCard, status: "waiting" }] });

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(false);
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a same-thread approval answer unchanged", async () => {
    const tx = answerTransaction();
    tx.run.findFirst.mockReset();
    tx.run.findFirst.mockResolvedValue({
      botId: "bot-1",
      userId: "user-1",
      checkpoint: null,
      trigger: "user",
      clientNonce: null,
      threadId: "thread-parent",
      sourceMessageId: null,
      task: { prompt: "check the venue" },
    });
    tx.message.findFirst.mockReset();
    tx.message.findFirst.mockResolvedValue({ id: "ask-message", blocks: [approvalAsk] });

    await expect(answerRunInput(answerClient(tx), answerInput)).resolves.toBe(true);
    expect(tx.run.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-parent", status: "waiting_input" }),
      }),
    );
    // No source card is read or settled for a normal run.
    expect(tx.message.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledTimes(1);
  });
});

function clearTransaction(options: {
  helperThreads: Array<{ id: string }>;
  activeRuns: Array<{ id: string; taskId: string; userId: string; spaceId: string }>;
}) {
  return {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    threadRead: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    thread: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => options.helperThreads),
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 5, historyCompactionGeneration: 0 })
        .mockResolvedValue({ nextEventSeq: 1 }),
    },
    run: {
      findMany: vi.fn(async () => options.activeRuns),
      updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id })),
      ),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
    task: { updateMany: vi.fn(async () => ({ count: 0 })) },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    message: { deleteMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) },
    event: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () =>
        eventRow({ threadId: "thread-parent", seq: 0, type: "thread.cleared" }),
      ),
    },
    bot: { update: vi.fn(async () => ({ id: "bot-1" })) },
    chatGroup: { update: vi.fn(async () => ({ id: "group-1" })) },
  };
}

function clearClient(tx: ReturnType<typeof clearTransaction>) {
  return {
    computer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
}

describe("clearThread with background helpers", () => {
  it("clears only this chat and the helper threads it started", async () => {
    const tx = clearTransaction({
      helperThreads: [{ id: "helper-own" }],
      activeRuns: [
        { id: "parent-run", taskId: "task-1", userId: "user-1", spaceId: "space-1" },
        { id: "helper-run", taskId: "task-2", userId: "user-1", spaceId: "space-1" },
      ],
    });

    await expect(
      clearThread(clearClient(tx), {
        spaceId: "space-1",
        threadId: "thread-parent",
        botId: "bot-1",
      }),
    ).resolves.toMatchObject({ cancelledRunIds: ["parent-run", "helper-run"] });

    // The chat's own runs and the helpers it started are ended together.
    expect(tx.run.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          OR: [
            { threadId: "thread-parent", botId: "bot-1" },
            { trigger: "helper", sourceMessage: { threadId: "thread-parent" } },
          ],
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
      }),
    );
    // Helper threads come from the source relation, not from every thread the bot owns.
    expect(tx.thread.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        id: { not: "thread-parent" },
        helperBotId: "bot-1",
        OR: [
          { runs: { some: { trigger: "helper", sourceMessage: { threadId: "thread-parent" } } } },
          { runs: { none: {} } },
        ],
      },
      select: { id: true },
    });
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ["thread-parent", "helper-own"] } },
    });
    expect(tx.event.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ["thread-parent", "helper-own"] } },
    });
    expect(tx.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["parent-run", "helper-run"] } },
      data: { expiresAt: new Date(0) },
    });
  });

  it("cancels a group's helpers and reads their history before the source rows go", async () => {
    const tx = clearTransaction({
      helperThreads: [{ id: "group-helper" }],
      activeRuns: [
        { id: "group-run", taskId: "task-1", userId: "user-1", spaceId: "space-1" },
        { id: "group-helper-run", taskId: "task-2", userId: "user-1", spaceId: "space-1" },
      ],
    });

    await expect(
      clearThread(clearClient(tx), {
        spaceId: "space-1",
        threadId: "thread-group",
        botId: "bot-1",
        groupId: "group-1",
      }),
    ).resolves.toMatchObject({ cancelledRunIds: ["group-run", "group-helper-run"] });

    expect(tx.run.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { threadId: "thread-group" },
            { trigger: "helper", sourceMessage: { threadId: "thread-group" } },
          ],
        }),
      }),
    );
    // A group clear follows the group's helpers, not one member bot's threads.
    expect(tx.thread.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        id: { not: "thread-group" },
        runs: { some: { trigger: "helper", sourceMessage: { threadId: "thread-group" } } },
      },
      select: { id: true },
    });
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ["thread-group", "group-helper"] } },
    });
    expect(tx.thread.findMany.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.message.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves another chat's helper threads untouched", async () => {
    // The database query only matches this chat's helpers; an empty result is the other
    // chat's helper thread staying with its own source.
    const tx = clearTransaction({ helperThreads: [], activeRuns: [] });

    await clearThread(clearClient(tx), {
      spaceId: "space-1",
      threadId: "thread-parent",
      botId: "bot-1",
    });
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ["thread-parent"] } },
    });
    expect(tx.event.deleteMany).toHaveBeenCalledWith({
      where: { threadId: { in: ["thread-parent"] } },
    });
    // No broad "every helper thread this bot owns" clause is left behind.
    expect(tx.message.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ OR: expect.anything() }),
    );
    expect(tx.thread.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ historyCompactionSummary: { not: null } }),
      }),
    );
  });
});
