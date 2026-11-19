import type { BackgroundJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { TicketChange } from "./ticket-changes.js";
import { createTicketChangeNotifier } from "./ticket-changes.js";

const change: TicketChange = {
  spaceId: "space-1",
  boardId: "board-1",
  ticketId: "ticket-1",
  assigneeBotId: "bot-1",
  wakeAssignee: true,
};
function setup(ticketBoardEnabled: boolean, status = "todo") {
  const notify = vi.fn(async () => {});
  const enqueue = vi.fn(async (_job: BackgroundJob) => {});
  let activeRun: { id: string } | null = null;
  const createRun = vi.fn(async () => {
    activeRun = { id: "run-1" };
    return activeRun;
  });
  const createTask = vi.fn(async () => ({ id: "task-1" }));
  const tx = {
    ticket: {
      findFirst: vi.fn(async () => ({
        id: "ticket-1",
        status,
        number: 1,
        board: { ticketPrefix: "RAK" },
      })),
    },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", userId: "user-1", thread: { id: "thread-1" } })),
    },
    task: { create: createTask },
    run: { create: createRun, findFirst: vi.fn(async () => activeRun) },
    $queryRaw: vi.fn(async () => []),
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  const changes = createTicketChangeNotifier({
    ticketBoardEnabled,
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    jobs: { enqueue } as never,
    boardEvents: { notify } as never,
  });
  return { changes, notify, enqueue, createRun, createTask, transaction };
}

describe("ticket changes", () => {
  it("does nothing when disabled, including creation and assignment", async () => {
    const s = setup(false);
    await s.changes(change);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it.each(["todo", "doing", "review", "blocked"])(
    "wakes an assigned %s ticket once using a hidden run",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.createRun).toHaveBeenCalledTimes(1);
      expect(s.createRun).toHaveBeenCalledWith({
        select: { id: true },
        data: expect.objectContaining({
          trigger: "tickets",
          status: "queued",
          ticketId: change.ticketId,
        }),
      });
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
      );
      expect(s.notify).toHaveBeenCalledWith("space-1", {
        boardId: "board-1",
        ticketId: "ticket-1",
      });
    },
  );
  it.each(["done", "closed", "cancelled"])(
    "does not wake a reassigned %s ticket",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.notify).toHaveBeenCalledTimes(1);
      expect(s.createTask).not.toHaveBeenCalled();
      expect(s.createRun).not.toHaveBeenCalled();
      expect(s.enqueue).not.toHaveBeenCalled();
    },
  );
  it("only publishes changes for comments or status edits", async () => {
    const s = setup(true);
    await s.changes({ ...change, wakeAssignee: false });
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("does not wake an unassigned ticket", async () => {
    const s = setup(true);
    await s.changes({ ...change, assigneeBotId: null });
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it("enqueues a run prepared with the ticket without creating another execution", async () => {
    const s = setup(true);
    await s.changes({ ...change, preparedRunId: "prepared-1" });
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.createRun).not.toHaveBeenCalled();
    expect(s.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run.continue", payload: { runId: "prepared-1" } }),
    );
  });
  it("reuses the active assignment when its change notification is replayed", async () => {
    const s = setup(true);
    await s.changes(change);
    await s.changes(change);
    expect(s.createTask).toHaveBeenCalledOnce();
    expect(s.createRun).toHaveBeenCalledOnce();
    expect(s.enqueue.mock.calls.map(([job]) => job)).toEqual([
      expect.objectContaining({ payload: { runId: "run-1" } }),
      expect.objectContaining({ payload: { runId: "run-1" } }),
    ]);
  });
  it("keeps the prepared execution recoverable when the immediate enqueue fails", async () => {
    const s = setup(true);
    s.enqueue.mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(s.changes({ ...change, preparedRunId: "prepared-1" })).resolves.toBeUndefined();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.notify).toHaveBeenCalledOnce();
  });
});
