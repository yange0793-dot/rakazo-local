import type { AgentRunRequest, AgentToolCompletion } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { toolCompletionAuditPayload } from "./tool-completion-audit.js";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
  vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "0");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["success", "failure"] as const)(
  "preserves a parallel read's %s outcome when another call pauses the real Pi loop",
  async (outcome) => {
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted = false;
    let readFinished = false;
    let askBeforeReadFinished = false;
    const completions: AgentToolCompletion[] = [];
    const modelFetch = vi.fn(async () => {
      const chunk = {
        id: "synthetic-response",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "synthetic-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "synthetic.txt" }),
                  },
                },
                {
                  index: 1,
                  id: "synthetic-ask",
                  type: "function",
                  function: {
                    name: "ask_user",
                    arguments: JSON.stringify({
                      question: "Which option?",
                      options: ["A", "B"],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const runtime = new PiAgentRuntime({ modelFetch });
    const request: AgentRunRequest = {
      botId: "synthetic-bot",
      threadId: "synthetic-thread",
      runId: `parallel-pause-${outcome}`,
      prompt: "Read the file and ask for a choice.",
      instructions: "Offline fixture.",
      history: [],
      tools: builtinAgentTools.filter((tool) => ["read_file", "ask_user"].includes(tool.name)),
      model: {
        provider: "openai-compatible",
        id: "synthetic-model",
        baseUrl: "http://127.0.0.1:9/v1",
        allowPrivateEndpoint: true,
        contextWindow: 128_000,
        maxTokens: 1024,
      },
      onCheckpoint: async () => undefined,
      onToolCompleted: (completion) => {
        completions.push(completion);
      },
      executeTool: async (name) => {
        expect(name).toBe("read_file");
        readStarted = true;
        await heldRead;
        readFinished = true;
        if (outcome === "failure") throw new Error("Synthetic read failure");
        return { content: "Synthetic file content." };
      },
    };
    try {
      for await (const event of runtime.run(request, {
        operationId: "parallel-pause",
        traceId: "parallel-pause",
        spaceId: "synthetic-space",
        userId: "synthetic-user",
        signal: AbortSignal.timeout(5_000),
      })) {
        if (event.type === "ask") {
          askBeforeReadFinished = readStarted && !readFinished;
          releaseRead();
        }
      }
    } finally {
      releaseRead();
      await runtime.abort(request.runId);
    }
    expect(modelFetch).toHaveBeenCalledTimes(1);
    expect(askBeforeReadFinished).toBe(true);
    expect(readFinished).toBe(true);
    const read = completions.find((completion) => completion.name === "read_file")!;
    expect(read).toBeDefined();
    expect(read.paused).toBeUndefined();
    expect(toolCompletionAuditPayload(read).outcome).toBe(
      outcome === "success" ? "succeeded" : "error",
    );
    const ask = completions.find((completion) => completion.name === "ask_user")!;
    expect(toolCompletionAuditPayload(ask).outcome).toBe("paused");
  },
);
