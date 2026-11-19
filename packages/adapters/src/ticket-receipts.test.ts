import type { Prisma } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAgentTicketContext } from "./ticket-context.js";
import { createTicket, updateTicket } from "./ticket-tools.js";

const now = new Date("2026-01-01T00:00:00Z");
const origin = {
  threadId: "thread-1",
  messageId: "message-1",
  runId: "run-1",
  key: "run-1:create-1",
};
const input = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  title: "Compare releases",
  origin,
};

function setup() {
  const board = {
    id: "board-1",
    spaceId: input.spaceId,
    name: "Board",
    ticketPrefix: "RAK",
    nextNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
  const sourceRun = { ticketId: null as string | null };
  const tickets: Array<
    Prisma.TicketUncheckedCreateInput & {
      id: string;
      createdAt: Date;
      updatedAt: Date;
      status: string;
      receiptVersion: number;
    }
  > = [];
  const tx = {
    board: { update: vi.fn(async () => ({ nextNumber: ++board.nextNumber })) },
    run: {
      findFirst: vi.fn(async () => sourceRun as typeof sourceRun | null),
      update: vi.fn(async ({ data }: { data: { ticketId: string } }) =>
        Object.assign(sourceRun, data),
      ),
      create: vi.fn(),
    },
    task: { create: vi.fn() },
    ticket: {
      findFirst: vi.fn(
        async ({ where }: { where: { originKey?: string; id?: string } }) =>
          tickets.find((ticket) =>
            where.originKey ? ticket.originKey === where.originKey : ticket.id === where.id,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Prisma.TicketUncheckedCreateInput }) => {
        const ticket = {
          ...data,
          id: `ticket-${tickets.length + 1}`,
          createdAt: now,
          updatedAt: now,
          status: data.status ?? "todo",
          receiptVersion: data.receiptVersion ?? 0,
        };
        tickets.push(ticket);
        return ticket;
      }),
      update: vi.fn(async ({ data }: { data: Prisma.TicketUncheckedUpdateInput }) =>
        Object.assign(tickets[0]!, data),
      ),
    },
    $queryRaw: vi.fn(async () => []),
  };
  const changes = vi.fn();
  const prisma = {
    board: { findUnique: vi.fn(async () => board) },
    bot: { findFirst: vi.fn(async () => ({ id: input.botId })) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    sourceRun,
    tx,
    tickets,
    changes,
    deps: { prisma, onTicketChange: changes, ticketBoardEnabled: true } as never,
  };
}

beforeEach(() => vi.stubEnv("TICKET_WORK_RECEIPTS", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("chat ticket assignment", () => {
  it("attaches self-assignment to the current run and reuses repeated creation", async () => {
    const s = setup();
    const first = await createTicket(s.deps, input);
    const second = await createTicket(s.deps, input);
    expect(first).toHaveProperty("ticket.id", "ticket-1");
    expect(second).toHaveProperty("ticket.id", "ticket-1");
    expect(s.sourceRun.ticketId).toBe("ticket-1");
    expect(s.tickets).toHaveLength(1);
    expect(s.tx.task.create).not.toHaveBeenCalled();
    expect(s.tx.run.create).not.toHaveBeenCalled();
    expect(s.changes).toHaveBeenCalledOnce();
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });

  it("rejects an unavailable source before allocating a ticket", async () => {
    const s = setup();
    s.tx.run.findFirst.mockResolvedValue(null);
    expect(await createTicket(s.deps, input)).toHaveProperty(
      "error",
      "Ticket source does not match its execution.",
    );
    expect(s.tx.board.update).not.toHaveBeenCalled();
    expect(s.tx.ticket.create).not.toHaveBeenCalled();
    expect(s.changes).not.toHaveBeenCalled();
  });

  it("does not overwrite a current execution's ticket with another self-assignment", async () => {
    const s = setup();
    await createTicket(s.deps, input);
    expect(
      await createTicket(s.deps, { ...input, origin: { ...origin, key: "run-1:create-2" } }),
    ).toHaveProperty("error", expect.stringContaining("already belongs"));
    expect(s.tickets).toHaveLength(1);
    expect(s.sourceRun.ticketId).toBe("ticket-1");
  });

  it("records a later self-claim on the acting run without waking another worker", async () => {
    const s = setup();
    await createTicket(s.deps, input);
    s.sourceRun.ticketId = null;
    s.tickets[0]!.assigneeBotId = "peer-1";
    s.changes.mockClear();
    expect(
      await updateTicket(s.deps, {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        runId: "run-2",
        id: "ticket-1",
        ownerBotId: input.botId,
      }),
    ).toHaveProperty("ticket.assigneeBotId", input.botId);
    expect(s.sourceRun.ticketId).toBe("ticket-1");
    expect(s.tx.task.create).not.toHaveBeenCalled();
    expect(s.changes).toHaveBeenCalledWith(expect.objectContaining({ wakeAssignee: false }));
  });
});

describe("receipt ticket context", () => {
  it("recognizes a reply to a completed receipt without a ticket number", async () => {
    const findMany = vi.fn(async (_query: unknown) => [
      {
        id: "ticket-1",
        number: 1,
        title: "Compare releases",
        status: "done",
        assigneeBotId: null,
        originMessageId: "request-1",
      },
    ]);
    const prisma = {
      board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
      message: {
        findFirst: vi.fn(async () => ({
          replyTo: {
            id: "receipt-1",
            threadId: origin.threadId,
            role: "bot",
            botId: input.botId,
            runId: "worker-run-1",
            clientNonce: "work-receipt:ticket-1:1:digest",
          },
        })),
      },
      run: { findFirst: vi.fn(async () => ({ ticketId: "ticket-1" })) },
      ticket: { findMany },
      ticketComment: { findMany: vi.fn(async () => []) },
    };
    const context = await loadAgentTicketContext({ prisma, ticketBoardEnabled: true } as never, {
      spaceId: input.spaceId,
      text: "The server conclusion needs correcting.",
      origin: { ...input, threadId: origin.threadId, messageId: "correction-1" },
    });
    expect(context).toContain("RAK-1 [done] Compare releases");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: input.spaceId,
        boardId: "board-1",
        originThreadId: origin.threadId,
        createdByUserId: input.userId,
        createdByBotId: input.botId,
        id: "ticket-1",
      },
    });
  });

  it("loads an assignment from its durable ID when the prompt contains no readable reference", async () => {
    const prisma = {
      board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
      ticket: {
        findMany: vi.fn(async () => [
          {
            id: "ticket-1",
            number: 1,
            title: "Compare releases",
            status: "doing",
            assigneeBotId: null,
          },
        ]),
      },
      ticketComment: { findMany: vi.fn(async () => []) },
    };
    expect(
      await loadAgentTicketContext({ prisma, ticketBoardEnabled: true } as never, {
        spaceId: input.spaceId,
        text: "Continue the comparison.",
        ticketId: "ticket-1",
      }),
    ).toContain("RAK-1 [doing]");
  });

  it("does not bind a plain chat to historical work when the pilot is disabled", async () => {
    vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
    const findUnique = vi.fn();
    const prisma = { board: { findUnique } };
    expect(
      await loadAgentTicketContext({ prisma, ticketBoardEnabled: true } as never, {
        spaceId: input.spaceId,
        text: "Continue.",
        ticketId: "ticket-1",
        origin: {
          threadId: origin.threadId,
          userId: input.userId,
          botId: input.botId,
          messageId: "correction-1",
        },
      }),
    ).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
