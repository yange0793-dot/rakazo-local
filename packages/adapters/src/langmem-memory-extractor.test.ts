import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  AgentRunModel,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCompletionRequest } from "./langmem-memory-extractor.js";
import {
  completionReasoning,
  createLangMemExtractor,
  createRuntimeMemoryCompletion,
  validateChanges,
} from "./langmem-memory-extractor.js";

const spawnSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnSpy.mockImplementation(actual.spawn as never);
  return { ...actual, spawn: spawnSpy };
});

const context: AdapterContext = {
  operationId: "memory-extract-test",
  traceId: "memory-extract-test",
  spaceId: "space-fixture",
  userId: "user-fixture",
  botId: "bot-fixture",
  signal: new AbortController().signal,
};

const request = {
  messages: [
    {
      id: "m1",
      role: "user" as const,
      content: "以后都用深色模式",
      createdAt: "2026-11-17T00:00:00.000Z",
      isNew: true,
    },
  ],
  existing: [
    {
      id: "f1",
      revision: 2,
      content: "用户喜欢浅色模式",
      status: "active" as const,
      sourceMessageId: "m0",
      sourceQuote: "喜欢浅色模式",
      category: "preference" as const,
    },
  ],
  notes: [],
};

const completionRequest: MemoryCompletionRequest = {
  messages: [
    { role: "system", content: "You are a memory subroutine." },
    { role: "user", content: "以后都用深色模式" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_a", name: "DurableFact", args: { content: "x" } }],
    },
    { role: "tool", content: "Memory x inserted.", toolCallId: "call_a" },
  ],
  tools: [
    {
      name: "DurableFact",
      description: "A durable fact",
      parameters: { type: "object", properties: {} },
    },
  ],
  toolChoice: "any",
};

function childHeader(header: string): string {
  return `#!${process.execPath}\n${header}`;
}

function writeChild(header: string, terminal: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "langmem-extractor-"));
  const childPath = join(directory, "child.js");
  const extractFramePath = join(directory, "extract.json");
  writeFileSync(
    childPath,
    `${childHeader(header)}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "extract") {
    require("node:fs").writeFileSync(${JSON.stringify(extractFramePath)}, line);
    process.stdout.write(${JSON.stringify(
      JSON.stringify({ type: "completion", id: "c1", request: completionRequest }),
    )} + "\\n");
    return;
  }
  if (message.type === "completion_result") {
    process.stdout.write(${JSON.stringify(JSON.stringify(terminal))} + "\\n");
    process.exit(0);
  }
});
`,
  );
  // The adapter always passes "-I <script>"; this wrapper drops those arguments.
  const wrapper = join(directory, "python");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(childPath)}\n`,
  );
  chmodSync(wrapper, 0o755);
  // The adapter checks both configured paths exist before spawning.
  const scriptPath = join(directory, "child.py");
  writeFileSync(scriptPath, "");
  return { pythonPath: wrapper, scriptPath, directory, extractFramePath };
}

async function startChatFixture() {
  const server = createServer((incoming, response) => {
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      for await (const _chunk of incoming) {
        // Drain the request body; the completion content is fixed.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "fixture",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "准备记录" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  spawnSpy.mockClear();
});

describe("LangMem extractor transport", () => {
  it("relays LangMem turns and validates the returned source", async () => {
    const child = writeChild("", {
      type: "result",
      changes: [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
        },
      ],
    });
    const complete = vi.fn(async (_request: MemoryCompletionRequest, _context: AdapterContext) => ({
      content: "",
      toolCalls:
        complete.mock.calls.length === 1
          ? [
              {
                id: "call_a",
                name: "DurableFact",
                args: { content: "用户偏好深色模式" },
              },
            ]
          : [
              {
                id: "call_judge",
                name: "judge_memory_support",
                args: { decisions: [{ index: 0, supported: true }] },
              },
            ],
    }));
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete,
    });
    await expect(extractor.extract(request, context)).resolves.toEqual([
      {
        content: "用户偏好深色模式",
        sourceMessageId: "m1",
        sourceQuote: "以后都用深色模式",
        category: "preference",
      },
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]).toEqual(completionRequest);
    expect(complete.mock.calls[1]?.[0].messages[0]?.content).toContain("Rubric v1");
    expect(complete.mock.calls[1]?.[1].operationId).toContain("memory-support:v1");
  });

  it("asks the child for the removal-capable protocol and returns a verified removal", async () => {
    const removalRequest = {
      ...request,
      messages: [{ ...request.messages[0]!, content: "请忘掉深色模式偏好" }],
    };
    const child = writeChild("", {
      type: "result",
      changes: [
        {
          content: "用户喜欢浅色模式",
          sourceMessageId: "m1",
          sourceQuote: "请忘掉深色模式偏好",
          category: "preference",
          replacesId: "f1",
          expectedRevision: 2,
          remove: true,
        },
      ],
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [] })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "call_judge",
            name: "judge_memory_support",
            args: { decisions: [{ index: 0, supported: true }] },
          },
        ],
      });
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete,
    });

    await expect(extractor.extract(removalRequest, context)).resolves.toEqual([
      {
        content: "用户喜欢浅色模式",
        sourceMessageId: "m1",
        sourceQuote: "请忘掉深色模式偏好",
        category: "preference",
        replacesId: "f1",
        expectedRevision: 2,
        remove: true,
      },
    ]);
    expect(JSON.parse(readFileSync(child.extractFramePath, "utf8"))).toMatchObject({
      type: "extract",
      allowRemovals: true,
    });
  });

  it("rejects an unrelated fact even when its quote occurs in the source", async () => {
    const child = writeChild("", {
      type: "result",
      changes: [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "not in the message",
          category: "preference",
        },
        {
          content: "用户偏好先写测试",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
        },
      ],
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [] })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "call_judge",
            name: "judge_memory_support",
            args: { decisions: [{ index: 0, supported: false }] },
          },
        ],
      });
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete,
    });
    await expect(extractor.extract(request, context)).resolves.toEqual([]);
    expect(complete.mock.calls[1]?.[0].messages[1]?.content).toContain("用户偏好先写测试");
  });

  it("fails closed when the semantic judge returns malformed output", async () => {
    const child = writeChild("", {
      type: "result",
      changes: [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
        },
      ],
    });
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: "", toolCalls: [] })
      .mockResolvedValueOnce({ content: "", toolCalls: [] });
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete,
    });
    await expect(extractor.extract(request, context)).rejects.toThrow(
      "Memory support judge returned no valid decision tool call.",
    );
  });

  it("names a configured extractor path that is gone instead of failing the spawn", async () => {
    const complete = vi.fn(async () => ({ content: "", toolCalls: [] }));
    const extractor = createLangMemExtractor({
      pythonPath: "/langmem-test/missing-python",
      scriptPath: "/langmem-test/missing-script.py",
      complete,
    });

    await expect(extractor.extract(request, context)).rejects.toThrow(
      "LangMem extractor Python is missing at /langmem-test/missing-python",
    );
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("surfaces a completion failure and terminates the child", async () => {
    const child = writeChild("", { type: "result", changes: [] });
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete: async () => {
        throw new Error("provider unavailable");
      },
    });
    await expect(extractor.extract(request, context)).rejects.toThrow("provider unavailable");
  });

  it("kills the child when the extraction is aborted", async () => {
    const child = writeChild("setInterval(() => {}, 1000);", {
      type: "result",
      changes: [],
    });
    const controller = new AbortController();
    const extractor = createLangMemExtractor({
      pythonPath: child.pythonPath,
      scriptPath: child.scriptPath,
      complete: async () => {
        controller.abort();
        return { content: "", toolCalls: [] };
      },
    });
    await expect(
      extractor.extract(request, { ...context, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it("rejects an oversized request before spawning the child or calling the model", async () => {
    const complete = vi.fn(async () => ({ content: "", toolCalls: [] }));
    const extractor = createLangMemExtractor({
      pythonPath: "/langmem-test/missing-python",
      scriptPath: "/langmem-test/missing-script.py",
      complete,
    });
    const oversized = {
      ...request,
      messages: [{ ...request.messages[0]!, content: "x".repeat(1024 * 1024 + 1) }],
    };

    await expect(extractor.extract(oversized, context)).rejects.toThrow(
      /over the \d+-byte extractor limit/,
    );
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("validated LangMem changes", () => {
  it("keeps a removal only at the active target's revision", () => {
    const removal = {
      content: "用户喜欢浅色模式",
      sourceMessageId: "m1",
      sourceQuote: "以后都用深色模式",
      category: "preference" as const,
      replacesId: "f1",
      expectedRevision: 2,
      remove: true as const,
    };

    expect(validateChanges(request, [removal])).toEqual({ changes: [removal], dropped: 0 });
    expect(
      validateChanges(request, [
        { ...removal, expectedRevision: 1 },
        { ...removal, replacesId: "missing" },
        { ...removal, sourceQuote: "not in the message" },
      ]),
    ).toEqual({ changes: [], dropped: 3 });
  });

  it("binds an update to the active fact and its observed revision", () => {
    expect(
      validateChanges(request, [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
          replacesId: "f1",
          expectedRevision: 2,
        },
      ]),
    ).toEqual({
      changes: [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
          replacesId: "f1",
          expectedRevision: 2,
        },
      ],
      dropped: 0,
    });
  });

  it("drops an update at a stale revision and keeps the rest", () => {
    expect(
      validateChanges(request, [
        {
          content: "用户偏好深色模式",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
          replacesId: "f1",
          expectedRevision: 1,
        },
        {
          content: "用户偏好先写测试",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
        },
      ]),
    ).toEqual({
      changes: [
        {
          content: "用户偏好先写测试",
          sourceMessageId: "m1",
          sourceQuote: "以后都用深色模式",
          category: "preference",
        },
      ],
      dropped: 1,
    });
  });
});

describe("memory completion reasoning", () => {
  it("drops thinking for every forced tool choice the way Anthropic refuses", () => {
    expect(completionReasoning("any", "high")).toBeUndefined();
    expect(completionReasoning("required", "high")).toBeUndefined();
    expect(completionReasoning("any", "off")).toBeUndefined();
    expect(completionReasoning("auto", "high")).toBe("high");
    expect(completionReasoning("none", "high")).toBe("high");
    expect(completionReasoning(undefined, "medium")).toBe("medium");
  });
});

describe("runtime memory completion", () => {
  const runtime = {
    describe: () => ({
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    }),
    run: () => {
      throw new Error("runtime.run must not be used for memory completions");
    },
    abort: async () => undefined,
  } as unknown as AgentRuntime;

  function resolveModel(model: AgentRunModel) {
    return async () => model;
  }

  it("returns one Pi completion without dispatching its tool calls", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "fixture",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "准备记录",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_fixture",
                      type: "function",
                      function: {
                        name: "DurableFact",
                        arguments: JSON.stringify({
                          content: "用户偏好深色模式",
                          sourceMessageId: "m1",
                          sourceQuote: "以后都用深色模式",
                          category: "preference",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    const usage = vi.fn();
    try {
      const complete = createRuntimeMemoryCompletion({
        runtime,
        resolveModel: resolveModel({
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: "fixture-key",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiProtocol: "chat-completions",
          allowPrivateEndpoint: true,
        }),
        onUsage: usage,
      });
      const result = await complete(completionRequest, context);
      expect(result.content).toBe("准备记录");
      expect(result.toolCalls).toEqual([
        {
          id: "call_fixture",
          name: "DurableFact",
          args: {
            content: "用户偏好深色模式",
            sourceMessageId: "m1",
            sourceQuote: "以后都用深色模式",
            category: "preference",
          },
        },
      ]);
      const body = bodies[0]!;
      expect(body.tool_choice).toBe("required");
      expect(body.tools).toEqual([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "DurableFact" }),
        }),
      ]);
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual({ role: "system", content: "You are a memory subroutine." });
      expect(messages[1]).toMatchObject({ role: "user", content: "以后都用深色模式" });
      expect(messages[2]).toMatchObject({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            id: "call_a",
            type: "function",
            function: expect.objectContaining({ name: "DurableFact" }),
          }),
        ],
      });
      expect(messages[3]).toMatchObject({
        role: "tool",
        content: "Memory x inserted.",
        tool_call_id: "call_a",
      });
      expect(usage).toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }, 30_000);

  it("uses the resolved API key and automatic tool choice for Responses memory calls", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let receivedAuthorization: string | undefined;
    let receivedOriginator: IncomingHttpHeaders["originator"];
    const server = createServer((incoming, response) => {
      receivedAuthorization = incoming.headers.authorization;
      receivedOriginator = incoming.headers.originator;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            {
              type: "response.created",
              response: { id: "resp_fixture", model: "fixture-model", status: "in_progress" },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_fixture",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const complete = createRuntimeMemoryCompletion({
        runtime,
        resolveModel: resolveModel({
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: "fixture-key",
          headers: { Originator: "fixture-client" },
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiProtocol: "responses",
          allowPrivateEndpoint: true,
        }),
      });
      await expect(complete(completionRequest, context)).resolves.toMatchObject({
        content: "",
        toolCalls: [],
      });
      expect(receivedAuthorization).toBe("Bearer fixture-key");
      expect(receivedOriginator).toBe("fixture-client");
      expect(bodies[0]?.tool_choice).toBe("auto");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }, 30_000);

  it("passes the full usage event and extraction context to onUsage and awaits it", async () => {
    const fixture = await startChatFixture();
    try {
      const usage = vi.fn(
        async (_event: Extract<AgentRuntimeEvent, { type: "usage" }>, _context: AdapterContext) => {
          throw new Error("usage sink failed");
        },
      );
      const complete = createRuntimeMemoryCompletion({
        runtime,
        resolveModel: resolveModel({
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: "fixture-key",
          baseUrl: fixture.baseUrl,
          apiProtocol: "chat-completions",
          allowPrivateEndpoint: true,
        }),
        onUsage: usage,
      });

      await expect(complete(completionRequest, context)).rejects.toThrow("usage sink failed");
      expect(usage).toHaveBeenCalledOnce();
      const [event, receivedContext] = usage.mock.calls[0]!;
      expect(event).toMatchObject({
        type: "usage",
        provider: "openai-compatible",
        model: "fixture-model",
        callId: expect.any(String),
        operationKind: "compaction",
      });
      expect(receivedContext).toBe(context);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("refuses to extract with the scripted model", async () => {
    const complete = createRuntimeMemoryCompletion({
      runtime,
      resolveModel: resolveModel({ provider: "scripted", id: "scripted" }),
    });
    await expect(complete(completionRequest, context)).rejects.toThrow("needs a configured model");
  });
});
