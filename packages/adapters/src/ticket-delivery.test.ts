import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { deliverTicketWork } from "./ticket-delivery.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "worker-1",
  threadId: "worker-thread",
  ticketId: "ticket-1",
};
const result = {
  previousVersion: 0,
  summary: "Client comparison is ready.",
  findings: [
    {
      outcome: "unknown",
      conclusion: "Server behavior needs evidence.",
      evidence: "Only the client sample is retained.",
    },
  ],
};

function setup() {
  const ticket = {
    id: "ticket-1",
    spaceId: run.spaceId,
    boardId: "board-1",
    number: 1,
    title: "Compare releases",
    createdByBotId: "owner-1",
    createdByUserId: run.userId,
    assigneeBotId: run.botId,
    originMessageId: "request-1",
    originThread: {
      id: "owner-thread",
      botId: "owner-1",
      groupId: null,
      externalConversationId: null,
    },
    board: { ticketPrefix: "RAK" },
    receiptVersion: 0,
  };
  const prisma = {
    ticket: { findFirst: vi.fn(async () => ticket), updateMany: vi.fn() },
    run: { findFirst: vi.fn(async () => ({ ticketId: run.ticketId, thread: { groupId: null } })) },
    message: { findFirst: vi.fn(async () => null as { id: string } | null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const artifacts = { get: vi.fn(), put: vi.fn(), remove: vi.fn() };
  const events = { notify: vi.fn() };
  const onTicketChange = vi.fn();
  return {
    ticket,
    prisma,
    artifacts,
    events,
    onTicketChange,
    deps: {
      prisma,
      artifacts,
      events,
      onTicketChange,
      ticketBoardEnabled: true,
    } as unknown as ExecutorDeps,
  };
}

beforeEach(() => vi.stubEnv("TICKET_WORK_RECEIPTS", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("ticket delivery boundary", () => {
  it("rejects an empty finding list before accessing persistence", async () => {
    const s = setup();
    const delivered = await deliverTicketWork(s.deps, run, {
      id: "ticket-1",
      result: { ...result, findings: [] },
      ownerAuthored: false,
      secrets: [],
    });
    expect(delivered).toHaveProperty("error", expect.stringContaining("findings"));
    expect(s.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("requires the durable execution assignment rather than a stale tool snapshot", async () => {
    const s = setup();
    s.prisma.run.findFirst.mockResolvedValue({
      ticketId: "other-ticket",
      thread: { groupId: null },
    });
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error");
    expect(s.prisma.message.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects a stale revision before copying evidence", async () => {
    const s = setup();
    s.ticket.receiptVersion = 1;
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: { ...result, artifactIds: ["evidence-1"] },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("Receipt changed"));
    expect(s.prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(s.artifacts.get).not.toHaveBeenCalled();
  });

  it("replays the committed receipt even after a newer revision without copying or notifying again", async () => {
    const s = setup();
    s.ticket.receiptVersion = 2;
    s.prisma.message.findFirst.mockResolvedValue({ id: "receipt-1" });
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: false,
        secrets: [],
      }),
    ).toEqual({ ok: true, version: 1, messageId: "receipt-1", status: "review" });
    expect(s.prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
    expect(s.events.notify).not.toHaveBeenCalled();
    expect(s.onTicketChange).not.toHaveBeenCalled();
  });

  it("rejects unavailable evidence before writing a receipt", async () => {
    const s = setup();
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result: { ...result, artifactIds: ["private-evidence"] },
        ownerAuthored: false,
        secrets: [],
      }),
    ).toHaveProperty("error", expect.stringContaining("evidence file"));
    expect(s.artifacts.get).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
    expect(s.prisma.ticket.updateMany).not.toHaveBeenCalled();
  });

  it("disables receipt delivery without touching work or artifacts", async () => {
    const s = setup();
    vi.stubEnv("TICKET_WORK_RECEIPTS", "false");
    expect(
      await deliverTicketWork(s.deps, run, {
        id: "ticket-1",
        result,
        ownerAuthored: true,
        secrets: [],
      }),
    ).toHaveProperty("error", "Ticket delivery is unavailable.");
    expect(s.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expect(s.artifacts.put).not.toHaveBeenCalled();
  });
});
