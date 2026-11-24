import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { sendUserMessage } from "./events.js";

describe("source routing during message persistence", () => {
  it.each(["queued", "waiting_input", "unknown", "consumed"])(
    "uses the durable message and preserves the resolved %s state",
    async (status) => {
      const sourceRun =
        status === "unknown" || status === "consumed"
          ? null
          : { id: "ticket-run", taskId: "ticket-task", status };
      const tx = {
        $queryRaw: vi.fn(async () => []),
        space: { findUnique: vi.fn() },
        thread: {
          update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
            data.nextMessageSeq ? { nextMessageSeq: 5 } : { nextEventSeq: 9 },
          ),
        },
        message: {
          create: vi.fn(async () => ({ id: "source-message", seq: 4, createdAt: new Date() })),
          update: vi.fn(),
        },
        task: { create: vi.fn(async () => ({ id: "default-task" })) },
        run: {
          findMany: vi.fn(async () => []),
          findUnique: vi.fn(async () => ({ status: "queued" })),
          create: vi.fn(async () => ({
            id: "default-run",
            taskId: "default-task",
            status: "queued",
          })),
        },
        event: { create: vi.fn(async () => ({ id: "event", seq: 8 })) },
      };
      const routeSourceEvent = vi.fn(async (client, message) => {
        expect(client).toBe(tx);
        expect(tx.message.create).toHaveBeenCalledOnce();
        expect(message).toMatchObject({ id: "source-message", seq: 4 });
        expect(tx.run.create).not.toHaveBeenCalled();
        return status === "unknown" ? null : { run: sourceRun };
      });
      const prisma = {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      } as unknown as PrismaClient;
      const sent = await sendUserMessage(prisma, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        userId: "user-1",
        blocks: [{ kind: "text", text: "Actual source" }],
        prompt: "Actual source",
        trigger: "messaging",
        routeSourceEvent,
      });
      expect(sent).toEqual({
        messageId: "source-message",
        seq: 4,
        taskId: status === "unknown" ? "default-task" : (sourceRun?.taskId ?? null),
        runId: status === "unknown" ? "default-run" : (sourceRun?.id ?? null),
        runStatus: status === "unknown" ? "queued" : (sourceRun?.status ?? null),
      });
      expect(tx.run.create).toHaveBeenCalledTimes(status === "unknown" ? 1 : 0);
      expect(tx.task.create).toHaveBeenCalledTimes(status === "unknown" ? 1 : 0);
      expect(tx.event.create).toHaveBeenCalledOnce();
    },
  );
});
