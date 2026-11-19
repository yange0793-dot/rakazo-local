import type * as Db from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTicketAttention } from "./ticket-attention.js";

const state = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  ticket: null as Record<string, unknown> | null,
  chatVisible: true,
  eventSeq: 5,
}));

vi.mock("@rakazo/db", async (original) => {
  const actual = await original<typeof Db>();
  return {
    ...actual,
    createThreadMessageInTransaction: vi.fn(
      async (_tx: unknown, input: Record<string, unknown>) => {
        const message = { id: `message-${state.posted.length + 2}`, ...input };
        state.posted.push(message);
        return message;
      },
    ),
    appendEventInTransaction: vi.fn(async () => ({ seq: state.eventSeq, firstResponse: false })),
  };
});

const run = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "exec-bot",
  threadId: "exec-thread",
  ticketId: "ticket-1",
};

function chatTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: "ticket-1",
    number: 6,
    spaceId: "space-1",
    createdByUserId: "user-1",
    createdByBotId: "owner-bot",
    assigneeBotId: "exec-bot",
    originKey: "run-1:create-1",
    originMessageId: "request-1",
    originThread: {
      id: "origin-thread",
      botId: "owner-bot",
      groupId: null,
      externalConversationId: null,
    },
    board: { ticketPrefix: "RAK" },
    ...overrides,
  };
}

function setup() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "origin-thread" }]),
    message: {
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce: { clientNonce: string } } }) =>
          state.posted.find(
            (message) => message.clientNonce === where.threadId_clientNonce.clientNonce,
          ) ?? null,
      ),
      findFirst: vi.fn(async () => ({ id: "request-1" })),
    },
    thread: {
      findFirst: vi.fn(async () => (state.chatVisible ? { id: "origin-thread" } : null)),
    },
    chatGroup: { update: vi.fn(async () => undefined) },
  };
  const ticket = {
    findFirst: vi.fn(async ({ where }: { where: { id?: string } }) =>
      state.ticket && where.id === state.ticket.id ? state.ticket : null,
    ),
  };
  const notify = vi.fn(async () => undefined);
  const deps = {
    prisma: {
      ticket,
      $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
    },
    events: { notify },
  };
  return { tx, ticket, notify, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.posted.length = 0;
  state.ticket = chatTicket();
  state.chatVisible = true;
  vi.stubEnv("TICKET_WORK_RECEIPTS", "true");
});

afterEach(() => vi.unstubAllEnvs());

describe("ticket attention in the original chat", () => {
  it("posts one note that answers the request the ticket came from", async () => {
    const s = setup();
    await announceTicketAttention(s.deps as never, run, {
      waitId: "attempt-1",
      needs: "approval",
    });
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]).toMatchObject({
      threadId: "origin-thread",
      role: "bot",
      botId: "owner-bot",
      replyToMessageId: "request-1",
      blocks: [{ kind: "text", text: "RAK-6 needs your approval." }],
      clientNonce: "work-attention:ticket-1:attempt-1",
    });
    expect(s.notify).toHaveBeenCalledWith("origin-thread", 5);
  });

  it("keeps one note when the same pause is announced again", async () => {
    const s = setup();
    const input = { waitId: "attempt-1", needs: "answer" as const };
    await announceTicketAttention(s.deps as never, run, input);
    await announceTicketAttention(s.deps as never, run, input);
    expect(state.posted).toHaveLength(1);
    expect(s.notify).toHaveBeenCalledOnce();
  });

  it("says nothing while ticket receipts are off", async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
    const s = setup();
    await announceTicketAttention(s.deps as never, run, {
      waitId: "attempt-1",
      needs: "answer",
    });
    expect(s.ticket.findFirst).not.toHaveBeenCalled();
    expect(state.posted).toHaveLength(0);
  });

  it("says nothing for a ticket created on the board rather than in a chat", async () => {
    state.ticket = null;
    const s = setup();
    await announceTicketAttention(s.deps as never, run, {
      waitId: "attempt-1",
      needs: "answer",
    });
    expect(s.tx.message.findUnique).not.toHaveBeenCalled();
    expect(state.posted).toHaveLength(0);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("says nothing when the paused card is already in the original chat", async () => {
    const s = setup();
    await announceTicketAttention(
      s.deps as never,
      { ...run, threadId: "origin-thread" },
      {
        waitId: "attempt-1",
        needs: "takeover",
      },
    );
    expect(s.tx.message.findUnique).not.toHaveBeenCalled();
    expect(state.posted).toHaveLength(0);
  });

  it("writes nothing when the original chat is no longer open to its owner", async () => {
    state.chatVisible = false;
    const s = setup();
    await announceTicketAttention(s.deps as never, run, {
      waitId: "attempt-1",
      needs: "answer",
    });
    expect(state.posted).toHaveLength(0);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("answers in the group chat the ticket came from", async () => {
    state.ticket = chatTicket({
      originThread: {
        id: "origin-thread",
        botId: null,
        groupId: "group-1",
        externalConversationId: null,
      },
    });
    const s = setup();
    await announceTicketAttention(s.deps as never, run, {
      waitId: "attempt-1",
      needs: "answer",
    });
    expect(state.posted).toHaveLength(1);
    expect(s.tx.chatGroup.update).toHaveBeenCalledOnce();
    expect(s.notify).toHaveBeenCalledWith("origin-thread", 5);
  });
});
