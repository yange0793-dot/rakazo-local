import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";

/** The write handler's only job here is choosing the path it hands the sandbox. */
function writeContext(mode: "team" | "dedicated") {
  const writeFile = vi.fn(async () => undefined);
  const append = vi.fn(async () => undefined);
  const ctx = {
    deps: { sandbox: { writeFile }, events: { append } },
    run: { id: "run-1", spaceId: "space-1", botId: "bot-1", userId: "user-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    context: {},
    secrets: [],
    computer: {
      mode,
      checkpoint: { markDirty: vi.fn() },
      get: async () => ({
        id: "computer-1",
        botId: "team-1",
        kind: "desktop",
        providerRef: "/tmp/team-home",
      }),
    },
  } as unknown as RunContext;
  return { ctx, writeFile, append };
}

function writeCall(path: string): ToolCall {
  return {
    name: "write_file",
    args: { path, content: "hello" },
    executionId: "call-1",
    applied: undefined,
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

function writeFileTool(ctx: RunContext, call: ToolCall) {
  const handler = fileTools.write_file;
  if (!handler) throw new Error("write_file handler is missing");
  return handler(ctx, call);
}

describe("write_file on a Team Computer", () => {
  it("writes into its own folder and shared", async () => {
    for (const [requested, stored] of [
      ["notes/result.txt", "bots/bot-1/notes/result.txt"],
      ["shared/brief.md", "shared/brief.md"],
    ]) {
      const { ctx, writeFile } = writeContext("team");
      await writeFileTool(ctx, writeCall(requested!));
      expect(writeFile).toHaveBeenCalledWith(
        expect.anything(),
        { path: stored, content: expect.any(Uint8Array) },
        ctx.context,
      );
    }
  });

  it("refuses another bot's folder before anything is written", async () => {
    const { ctx, writeFile } = writeContext("team");
    await expect(writeFileTool(ctx, writeCall("bots/bot-2/notes.txt"))).rejects.toThrow(
      "Path escapes the bot workspace",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("keeps a private computer's whole workspace writable", async () => {
    const { ctx, writeFile } = writeContext("dedicated");
    await writeFileTool(ctx, writeCall("/notes/result.txt"));
    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      { path: "notes/result.txt", content: expect.any(Uint8Array) },
      ctx.context,
    );
  });
});
