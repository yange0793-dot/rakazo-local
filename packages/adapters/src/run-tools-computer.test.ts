import type { ComputerCommand } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { computerTools } from "./run-tools-computer.js";
import type { FinishedShellCommand } from "./shell-command-stream.js";
import { deliverFinishedShells, SHELL_STREAM_IDLE_MS } from "./shell-command-stream.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("publishes a terminal failure and preserves output when a detached shell loses its stream", async () => {
  vi.useFakeTimers();
  try {
    const secret = "test-shell-secret";
    const prompt = "Enter code ABCD-1234 at https://example.test/device\n";
    const progress = deferred();
    const disconnect = deferred();
    const events: ComputerCommand[] = [];
    const ctx = {
      deps: {
        prisma: {
          spaceSettingOverride: { findUnique: async () => null },
          vaultCredential: { findMany: async () => [] },
        },
        events: {
          append: async ({ payload }: { payload: ComputerCommand }) => {
            events.push(payload);
          },
        },
        sandbox: {
          async *execute() {
            yield { type: "stdout", data: prompt };
            await progress.promise;
            yield { type: "stdout", data: "still working\n" };
            yield { type: "stderr", data: `warning: ${secret}\n` };
            await disconnect.promise;
            throw new Error(`Provider disconnected using ${secret}`);
          },
        },
      },
      run: { spaceId: "space-1", userId: "user-1" },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      state: { reply: {} },
      secrets: [secret],
      computer: {
        mode: "dedicated",
        graphical: false,
        stored: { id: "computer-1" },
        checkpoint: { markDirty: vi.fn() },
        get: async () => ({ kind: "fake" }),
      },
    } as unknown as RunContext;
    const onShellStillRunning = vi.fn<(completion: Promise<FinishedShellCommand>) => void>();
    const name = "shell";
    const args = { command: "test-shell" };
    const executionId = "shell-1";
    const call: ToolCall = {
      name,
      args,
      executionId,
      observer: { onShellStillRunning },
      connectorCall: { tool: name, args, executionId },
      effectKey: executionId,
      applied: undefined,
      nextApprovedTool: undefined,
      bypassApproval: false,
      spend: undefined,
      claimedEffect: false,
      persistEffectResult: async () => true,
      finish: async (result) => result,
      claimOrReturn: async () => undefined,
    };

    const tool = computerTools.shell!(ctx, call);
    await vi.advanceTimersByTimeAsync(SHELL_STREAM_IDLE_MS);
    expect(await tool).toMatchObject({ stdout: prompt, code: null, running: true });
    expect(onShellStillRunning).toHaveBeenCalledOnce();

    progress.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const completion = onShellStillRunning.mock.calls[0]![0];
    disconnect.resolve();
    await expect(completion).rejects.toThrow("Provider disconnected using [redacted]");
    expect(vi.getTimerCount()).toBe(0);
    expect(events.filter((event) => event.status === "done")).toEqual([
      expect.objectContaining({
        executionId: "shell-1",
        exitCode: 1,
        output: `${prompt}still working\nwarning: [redacted]\nProvider disconnected using [redacted]`,
      }),
    ]);
    expect(events.at(-1)?.status).toBe("done");
    expect(JSON.stringify(events)).not.toContain(secret);

    const deliver = vi.fn();
    await deliverFinishedShells(deliver, [completion], { toolResults: [] });
    expect(deliver).toHaveBeenCalledWith(expect.stringContaining("exit code: 1"));
    expect(deliver).toHaveBeenCalledWith(
      expect.stringContaining(
        `stdout:\n${prompt}still working\n\nstderr:\nwarning: [redacted]\nProvider disconnected using [redacted]`,
      ),
    );
  } finally {
    vi.useRealTimers();
  }
});
