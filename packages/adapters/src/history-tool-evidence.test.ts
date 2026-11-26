import type { PrismaClient } from "@rakazo/db";
import { boundHistoryResponse } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { readHistoryToolEvidence } from "./run-tools-memory.js";

function fixture(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    findMany,
    prisma: { externalEffect: { findMany } } as unknown as PrismaClient,
  };
}

describe("history tool evidence", () => {
  it("does not read receipts without an authorized linked run", async () => {
    const h = fixture([]);
    const result = await readHistoryToolEvidence(h.prisma, "space", [], {
      messageId: "message",
      toolEffectId: "other-bot-effect",
    });
    expect(h.findMany).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(result.toolReceipt).toBeNull();
  });

  it("scopes the original arguments and result to authorized runs in the current space", async () => {
    const effect = {
      id: "effect",
      runId: "run",
      kind: "mcp__browser__navigate",
      status: "succeeded",
      createdAt: new Date(),
      request: { url: "https://example.test/?q=original+query", tab: "active" },
      result: { content: [{ type: "text", text: "Actual page title" }] },
    };
    const h = fixture([effect]);
    const result = await readHistoryToolEvidence(h.prisma, "space", [{ id: "run" }], {
      messageId: "message",
      toolEffectId: "effect",
    });
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", runId: { in: ["run"] }, id: "effect" },
      }),
    );
    expect(JSON.parse(result.toolReceipt!.text)).toEqual({
      request: effect.request,
      result: effect.result,
    });
  });

  it("pages a long original receipt without losing text or exposing all bodies in the list", async () => {
    const effect = {
      id: "effect",
      runId: "run",
      kind: "browser_read",
      status: "succeeded",
      createdAt: new Date(),
      request: { tab: "active" },
      result: { text: "Page evidence ".repeat(2000) },
    };
    const h = fixture([effect]);
    let collected = "";
    let offset = 0;
    for (;;) {
      const page = await readHistoryToolEvidence(h.prisma, "space", [{ id: "run" }], {
        messageId: "message",
        toolEffectId: "effect",
        toolTextOffset: offset,
      });
      expect(Buffer.byteLength(page.toolReceipt!.text)).toBeLessThanOrEqual(4000);
      collected += page.toolReceipt!.text;
      const next = page.toolReceipt!.nextTextOffset;
      if (next === null) break;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    expect(JSON.parse(collected)).toEqual({ request: effect.request, result: effect.result });
    await readHistoryToolEvidence(h.prisma, "space", [{ id: "run" }], {
      messageId: "message",
    });
    expect(h.findMany.mock.calls.at(-1)![0].select).not.toHaveProperty("result");
  });

  it("keeps a full history page and added tool metadata inside the response budget", async () => {
    const h = fixture(
      Array.from({ length: 6 }, (_, i) => ({
        id: `effect-${i}`,
        runId: "run",
        kind: "mcp__browser__navigate",
        status: "succeeded",
        createdAt: new Date(),
      })),
    );
    const evidence = await readHistoryToolEvidence(h.prisma, "space", [{ id: "run" }], {
      messageId: "message",
    });
    const text = "Historical message. ".repeat(100);
    const response = boundHistoryResponse({
      messages: Array.from({ length: 5 }, (_, i) => ({
        messageId: `message-${i}`,
        threadId: "thread",
        seq: i,
        role: "bot",
        createdAt: new Date().toISOString(),
        text,
        textOffset: 0,
        nextTextOffset: null,
        truncated: false,
        runId: "run",
        replyToMessageId: null,
      })),
      ...evidence,
    });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(10_000);
    expect(response.toolCalls).toHaveLength(5);
    expect(response.nextToolId).toBe("effect-4");
    const shortened = response.messages.find((message) => message.truncated)!;
    expect(shortened.text).toBe(text.slice(0, shortened.nextTextOffset!));
  });

  it("redacts a complete credential before splitting it across receipt pages", async () => {
    const secret = "private-test-credential";
    const effect = {
      id: "effect",
      runId: "run",
      kind: "browser_read",
      status: "completed",
      createdAt: new Date(),
      request: {},
      result: { text: `${"x".repeat(3960)}${secret}` },
    };
    const h = fixture([effect]);
    let text = "";
    let offset = 0;
    for (;;) {
      const page = await readHistoryToolEvidence(
        h.prisma,
        "space",
        [{ id: "run" }],
        { messageId: "message", toolEffectId: "effect", toolTextOffset: offset },
        [secret],
      );
      text += page.toolReceipt!.text;
      if (page.toolReceipt!.nextTextOffset === null) break;
      offset = page.toolReceipt!.nextTextOffset;
    }
    expect(JSON.parse(text).result.text).not.toContain(secret);
    expect(JSON.parse(text).result.text).toContain("[redacted]");
  });
});
