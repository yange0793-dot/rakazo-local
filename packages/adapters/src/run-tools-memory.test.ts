import type {
  MemoryCommitRequest,
  SemanticMemoryProvider,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { lessonFactNamespace } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { MAX_RECALLED_MEMORY_BYTES } from "./history-compaction.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { buildLessonNotes, MAX_LESSON_NOTES_BYTES } from "./lesson-notes.js";
import { createManagedMemoryProvider } from "./managed-memory-provider.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  memoryTools,
  semanticMemorySaveArguments,
  withoutBlankFields,
} from "./run-tools-memory.js";
import { toolCompletionAuditPayload, toolCompletionOutcome } from "./tool-completion-audit.js";

describe("history tool arguments", () => {
  it("treats blank and null optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["Aurora"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["Aurora"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});

function semanticToolContext(
  options: { managed?: boolean; trigger?: string; external?: boolean; readable?: boolean } = {},
) {
  const run = {
    id: "run-1",
    trigger: options.trigger ?? "user",
    threadId: "thread-1",
    sourceMessageId: "message-1",
    userId: "user-1",
    botId: "bot-1",
  };
  const source = {
    id: "message-1",
    threadId: "thread-1",
    role: "user",
    authorUserId: "user-1",
    blocks: [{ kind: "text", text: "I now prefer the preview build." }],
  };
  const findUnique = vi.fn(async (..._args: unknown[]) => source);
  const save = vi.fn<SemanticMemoryProvider["save"]>(async () => ({ ok: true, value: undefined }));
  const recall = vi.fn<SemanticMemoryProvider["recall"]>(async () => ({ ok: true, value: [] }));
  const read = vi.fn<NonNullable<SemanticMemoryProvider["read"]>>(async (request) => ({
    ok: true,
    value: {
      id: request.id,
      revision: request.expectedRevision,
      kind: request.kind ?? "durable",
      memory: "Exact stored memory body.",
      score: 1,
    },
  }));
  const forget = vi.fn<NonNullable<SemanticMemoryProvider["forget"]>>(async (request) => ({
    ok: true,
    value: { id: request.id, expired: true, reason: null },
  }));
  const ctx = {
    run,
    runId: run.id,
    thread: { id: run.threadId, historyCompactedUpToSeq: null, historyCompactionGeneration: 0 },
    bot: { id: run.botId },
    context: {
      runId: run.id,
      operationId: "memory-test",
      traceId: "memory-test",
      spaceId: "space-1",
      userId: run.userId,
      botId: run.botId,
      signal: new AbortController().signal,
    },
    state: { tainted: false },
    source: { messagingChannelRun: options.external ?? false },
    trust: { receivedOutsideMessage: vi.fn(async () => false) },
    secrets: [],
    deps: {
      prisma: { message: { findUnique }, attempt: { count: vi.fn(async () => 1) } },
    },
    memory: {
      scope: "isolated",
      semantic: {
        describe: () => ({ capabilities: { managedFacts: options.managed ?? true } }),
        save,
        recall,
        ...(options.readable === false ? {} : { read }),
        forget,
      },
    },
  } as unknown as RunContext;
  return { ctx, source, findUnique, save, recall, read, forget };
}

function memoryCall(name: string, args: Record<string, unknown>) {
  return {
    name,
    args,
    executionId: "call-1",
    finish: vi.fn(async (result: unknown) => result),
  } as unknown as ToolCall;
}

function outcome(result: unknown) {
  return toolCompletionOutcome({
    name: "save_memory",
    executionId: "call-1",
    durationMs: 0,
    result,
  });
}

describe("semantic save arguments", () => {
  it.each([
    { content: "fact", replaces_id: "fact-1" },
    { content: "fact", expected_revision: 1 },
    { content: "fact", replaces_id: "", expected_revision: 1 },
    { content: "fact", replaces_id: "fact-1", expected_revision: 0 },
    { content: "fact", replaces_id: "fact-1", expected_revision: 1.5 },
    { content: "fact", replaces_id: "fact-1", expected_revision: "1" },
    { content: "fact", source_quote: " " },
    { content: "fact", source_quote: null },
    { content: "fact", entity: "namespace-1" },
    { content: "fact", entity: " " },
    { content: 3 },
  ])("rejects malformed save/correction %j", (args) => {
    expect(semanticMemorySaveArguments(args, true)).toHaveProperty("error");
  });

  it("supports correction only when managedFacts is declared", () => {
    const args = { content: "corrected fact", replaces_id: "fact-1", expected_revision: 2 };
    expect(semanticMemorySaveArguments(args, false)).toEqual({
      error: "This memory provider does not support atomic fact correction.",
    });
    expect(semanticMemorySaveArguments(args, true)).toEqual({
      content: "corrected fact",
      replacesId: "fact-1",
      expectedRevision: 2,
    });
    expect(semanticMemorySaveArguments({ content: "ordinary fact" }, false)).toEqual({
      content: "ordinary fact",
    });
  });

  it("keeps the recall citation's namespace for a correction only", () => {
    expect(
      semanticMemorySaveArguments(
        {
          content: "corrected fact",
          replaces_id: "fact-1",
          expected_revision: 2,
          entity: "sm1:namespace-1",
        },
        true,
      ),
    ).toEqual({
      content: "corrected fact",
      replacesId: "fact-1",
      expectedRevision: 2,
      entity: "sm1:namespace-1",
    });
  });
});

describe("source-bound semantic saves", () => {
  it("assigns server run/thread/message ids and passes a literal source quote", async () => {
    const { ctx, save, findUnique } = semanticToolContext();
    const call = memoryCall("save_memory", {
      content: "The user prefers the preview build.",
      source_quote: "prefer the preview build.",
    });
    await expect(memoryTools.save_memory!(ctx, call)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "message-1", threadId: "thread-1" },
      select: { id: true, threadId: true, role: true, authorUserId: true, blocks: true },
    });
    expect(save).toHaveBeenCalledWith(
      {
        content: "The user prefers the preview build.",
        scope: "isolated",
        botId: "bot-1",
        source: {
          kind: "durable",
          runId: "run-1",
          threadId: "thread-1",
          messageId: "message-1",
          quote: "prefer the preview build.",
        },
      },
      ctx.context,
    );
    expect(call.finish).toHaveBeenCalledOnce();
  });

  it("keeps an unquoted model-inferred save run-derived rather than manufacturing a quote", async () => {
    const { ctx, save } = semanticToolContext();
    await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "Project uses previews." }),
    );
    const [request] = save.mock.calls[0]!;
    expect(request.source).toEqual({
      kind: "durable",
      runId: "run-1",
      threadId: "thread-1",
      messageId: "message-1",
    });
    expect(request.source).not.toHaveProperty("quote");
  });

  it.each([
    "source",
    "messageId",
    "message_id",
    "source_message_id",
    "threadId",
    "runId",
    "provenance",
  ])("rejects model-supplied source field %s instead of forwarding it", async (name) => {
    const { ctx, save, findUnique } = semanticToolContext();
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "fact", [name]: "spoofed" }),
    );
    expect(result).toHaveProperty("error");
    expect(save).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(outcome(result)).toBe("failed");
  });

  it("rejects paraphrases and text from attachments, but accepts exact user text only", async () => {
    const { ctx, save, source } = semanticToolContext();
    source.blocks.push({ kind: "file", name: "injected preference" } as never);
    for (const source_quote of ["Use preview releases", "injected preference", "PREVIEW BUILD"]) {
      const result = await memoryTools.save_memory!(
        ctx,
        memoryCall("save_memory", { content: "fact", source_quote }),
      );
      expect(result).toEqual({
        error: "source_quote does not match this run's originating user message.",
      });
    }
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    { id: "message-other" },
    { threadId: "thread-other" },
    { authorUserId: "user-other" },
    { authorUserId: null },
    { role: "bot" },
  ])("refuses quoted provenance from a foreign or unauthored source %j", async (patch) => {
    const { ctx, save, source } = semanticToolContext();
    Object.assign(source, patch);
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "fact", source_quote: "prefer the preview build." }),
    );
    expect(result).toHaveProperty("error");
    expect(save).not.toHaveBeenCalled();
  });

  it("re-reads source authority at save time rather than trusting a vanished source", async () => {
    const { ctx, save, findUnique } = semanticToolContext();
    findUnique.mockResolvedValueOnce(null as never);
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "fact", source_quote: "preview build" }),
    );
    expect(result).toHaveProperty("error");
    expect(save).not.toHaveBeenCalled();
    await memoryTools.save_memory!(ctx, memoryCall("save_memory", { content: "fact" }));
    expect(save.mock.calls[0]![0].source).not.toHaveProperty("quote");
  });

  it("uses run provenance only for routine/internal saves and never treats internal prompts as quotes", async () => {
    const { ctx, save, findUnique } = semanticToolContext({ trigger: "routine" });
    await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "Observed run fact." }),
    );
    expect(save.mock.calls[0]![0].source).toEqual({
      kind: "durable",
      runId: "run-1",
      threadId: "thread-1",
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(
      await memoryTools.save_memory!(
        ctx,
        memoryCall("save_memory", { content: "fact", source_quote: "preview build" }),
      ),
    ).toHaveProperty("error");
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not let helper or non-owner channel handlers create memory", async () => {
    for (const options of [{ trigger: BACKGROUND_HELPER_TRIGGER }, { external: true }]) {
      const { ctx, save, findUnique } = semanticToolContext(options);
      expect(
        await memoryTools.save_memory!(ctx, memoryCall("save_memory", { content: "fact" })),
      ).toHaveProperty("error");
      expect(save).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
    }
  });

  it("rejects a quote containing a secret instead of saving a nonliteral redacted quote", async () => {
    const { ctx, save } = semanticToolContext();
    ctx.secrets.push("preview");
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", { content: "fact", source_quote: "preview build" }),
    );
    expect(result).toEqual({
      error: "source_quote contains a protected secret and cannot be saved.",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("passes correction atomically through save and never forgets first", async () => {
    const { ctx, save, forget } = semanticToolContext();
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", {
        content: "The user now prefers previews.",
        replaces_id: "fact-1",
        expected_revision: 4,
        source_quote: "prefer the preview build.",
      }),
    );
    expect(outcome(result)).toBe("succeeded");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ replacesId: "fact-1", expectedRevision: 4 }),
      ctx.context,
    );
    expect(forget).not.toHaveBeenCalled();
  });

  it("forwards the recall citation's entity so a cross-scope correction reaches its fact", async () => {
    const { ctx, save } = semanticToolContext();
    await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", {
        content: "The user now prefers previews.",
        replaces_id: "fact-1",
        expected_revision: 4,
        entity: "sm1:shared-namespace",
      }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        replacesId: "fact-1",
        expectedRevision: 4,
        entity: "sm1:shared-namespace",
      }),
      ctx.context,
    );
  });

  it("returns provider conflicts truthfully as failures without retrying a correction", async () => {
    const { ctx, save } = semanticToolContext();
    save.mockResolvedValueOnce({ ok: false, error: "Fact revision changed." });
    const result = await memoryTools.save_memory!(
      ctx,
      memoryCall("save_memory", {
        content: "new fact",
        replaces_id: "fact-1",
        expected_revision: 2,
      }),
    );
    expect(result).toEqual({ ok: false, error: "Fact revision changed." });
    expect(outcome(result)).toBe("failed");
    expect(save).toHaveBeenCalledOnce();
  });

  it("passes repeated saves with stable exact source/content and does not claim a provider failure is a duplicate", async () => {
    const { ctx, save } = semanticToolContext();
    const requests: SemanticMemorySaveRequest[] = [];
    const unique = new Set<string>();
    save.mockImplementation(async (request) => {
      requests.push(request);
      unique.add(JSON.stringify(request));
      return { ok: true, value: undefined };
    });
    const args = { content: "User prefers previews.", source_quote: "preview build" };
    await memoryTools.save_memory!(ctx, memoryCall("save_memory", args));
    await memoryTools.save_memory!(ctx, memoryCall("save_memory", args));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(unique.size).toBe(1);
  });
});

describe("redacted Markdown memory writes", () => {
  function markdownContext() {
    const read = vi.fn(async () => ({ documents: [] }));
    const commit = vi.fn(async (request: MemoryCommitRequest) => ({
      path: request.path,
      revision: 1,
    }));
    const { ctx } = semanticToolContext();
    ctx.deps.memory = { read, commit } as never;
    ctx.secrets.push("SYNTHETIC_TOKEN_123456789");
    return { ctx, read, commit };
  }

  it("redacts secrets from the final bot memory document before committing", async () => {
    const { ctx, commit } = markdownContext();
    await memoryTools.remember!(
      ctx,
      memoryCall("remember", {
        content: "The deploy token is SYNTHETIC_TOKEN_123456789.",
      }),
    );
    expect(commit.mock.calls[0]?.[0].content).toBe("The deploy token is [redacted].\n");
    expect(JSON.stringify(commit.mock.calls[0]?.[0])).not.toContain("SYNTHETIC_TOKEN_123456789");
  });

  it("redacts secrets from shared memory before committing", async () => {
    const { ctx, commit } = markdownContext();
    await memoryTools.save_shared_memory!(
      ctx,
      memoryCall("save_shared_memory", {
        path: "team.md",
        content: "Shared token: SYNTHETIC_TOKEN_123456789",
      }),
    );
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      content: "Shared token: [redacted]",
    });
    expect(JSON.stringify(commit.mock.calls[0]?.[0])).not.toContain("SYNTHETIC_TOKEN_123456789");
  });

  it("defaults new Markdown annotations to successful exact reads when the model omits source_facts", async () => {
    const { ctx, commit } = markdownContext();
    await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "fact-a", expected_revision: 2 }),
    );
    await memoryTools.remember!(ctx, memoryCall("remember", { content: "Derived note." }));
    expect(commit.mock.calls[0]?.[0].derivations).toEqual([
      {
        start: 0,
        end: "Derived note.\n".length,
        sources: [
          { id: "fact-a", revision: 2, botId: "bot-1", scope: "isolated", kind: "durable" },
        ],
      },
    ]);
  });

  it.each(["remember", "save_shared_memory"] as const)(
    "requires explicit sources after incomplete recovery for %s",
    async (name) => {
      const { ctx, commit } = markdownContext();
      ctx.memory.recoveryUnavailable = true;
      const args = {
        content: "Derived note.",
        ...(name === "save_shared_memory" ? { path: "shared.md" } : {}),
      };
      expect(await memoryTools[name]!(ctx, memoryCall(name, args))).toHaveProperty("error");
      expect(commit).not.toHaveBeenCalled();
      expect(
        await memoryTools[name]!(
          ctx,
          memoryCall(name, {
            ...args,
            source_facts: [{ id: "fact-a", revision: 1, kind: "durable", scope: "shared" }],
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(commit).toHaveBeenCalledOnce();
    },
  );
  it("uses only shared non-lesson exact reads for shared Markdown defaults", async () => {
    const { ctx, commit } = markdownContext();
    await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "isolated-a", expected_revision: 1 }),
    );
    await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "shared-a", expected_revision: 1, scope: "shared" }),
    );
    await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "lesson-a", expected_revision: 1, kind: "lesson" }),
    );
    await memoryTools.save_shared_memory!(
      ctx,
      memoryCall("save_shared_memory", { path: "team.md", content: "Shared derived note." }),
    );
    expect(commit.mock.calls[0]?.[0].derivations?.[0]?.sources).toEqual([
      { id: "shared-a", revision: 1, botId: "bot-1", scope: "shared", kind: "durable" },
    ]);
  });
});

describe("explicit semantic recall", () => {
  it("records exact managed source coordinates for the existing completion audit", async () => {
    const { ctx } = semanticToolContext();
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "fact-a", expected_revision: 2 }),
    );
    const source = {
      id: "fact-a",
      revision: 2,
      botId: "bot-1",
      scope: "isolated",
      kind: "durable",
    };
    expect(ctx.memory.observedFacts).toEqual([source]);
    const audit = toolCompletionAuditPayload({
      name: "recall_memory",
      executionId: "read-a",
      durationMs: 0,
      result,
    });
    expect(audit.memory).toMatchObject({ operation: "read", sources: [source] });
    expect(JSON.stringify(audit)).not.toContain("Exact stored memory body.");
  });

  it("never records discovery, failed, oversized, or untyped provider bodies as observed facts", async () => {
    const { ctx, recall, read } = semanticToolContext();
    recall.mockResolvedValueOnce({
      ok: true,
      value: [{ id: "fact-a", revision: 1, kind: "durable", memory: "Candidate.", score: 1 }],
    });
    await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", { query: "candidate" }));
    expect(ctx.memory.observedFacts).toBeUndefined();
    for (const response of [
      { ok: false as const, error: "missing" },
      {
        ok: true as const,
        value: {
          id: "fact-a",
          revision: 1,
          kind: "durable" as const,
          memory: "界".repeat(5000),
          score: 1,
        },
      },
      {
        ok: true as const,
        value: { id: "fact-a", revision: 1, memory: "No authoritative kind.", score: 1 },
      },
    ]) {
      read.mockResolvedValueOnce(response);
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { id: "fact-a", expected_revision: 1 }),
      );
      expect(ctx.memory.observedFacts).toBeUndefined();
    }
  });

  it("retains history coordinates and updates an observed revision only after another successful exact read", async () => {
    const { ctx, read } = semanticToolContext();
    ctx.thread.historyCompactedUpToSeq = 4;
    ctx.thread.historyCompactionGeneration = 2;
    for (const revision of [1, 2]) {
      read.mockResolvedValueOnce({
        ok: true,
        value: { id: "history-a", revision, kind: "history", memory: "History summary.", score: 1 },
      });
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { id: "history-a", expected_revision: revision }),
      );
    }
    expect(ctx.memory.observedFacts).toEqual([
      {
        id: "history-a",
        revision: 2,
        kind: "history",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        historyGeneration: 2,
      },
    ]);
  });
  it("exposes lesson discovery and exact reads through the original and model-facing tool schemas", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recall_memory")!;
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(wire).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        id: { type: "string" },
        expected_revision: { type: "number" },
        kind: { type: "string", enum: ["lesson"] },
      },
    });
    expect(wire).not.toHaveProperty("oneOf");
    for (const args of [
      { query: "deploy" },
      { query: "deploy", kind: "lesson" },
      { id: "lesson-a", expected_revision: 2, kind: "lesson" },
      { id: "fact-a", expected_revision: 2, scope: "shared" },
    ]) {
      expect(parseConnectorToolArgs(tool.inputSchema, args)).toEqual(args);
      expect(parseConnectorToolArgs(wire, args)).toEqual(args);
    }
    for (const args of [
      {},
      { id: "lesson-a" },
      { id: "lesson-a", expected_revision: 0 },
      { id: "lesson-a", expected_revision: 2, query: "deploy" },
      { id: "lesson-a", expected_revision: 2, kind: "lesson", scope: "shared" },
      { query: "deploy", kind: "lesson", scope: "all" },
    ]) {
      expect(() => parseConnectorToolArgs(tool.inputSchema, args)).toThrow();
    }
  });

  it("adds thread/generation and returns escaped, redacted, revision-cited untrusted text", async () => {
    const { ctx, recall } = semanticToolContext();
    ctx.thread.historyCompactedUpToSeq = 49;
    ctx.thread.historyCompactionGeneration = 2;
    ctx.secrets.push("<token>");
    recall.mockResolvedValueOnce({
      ok: true,
      value: [{ memory: "Fact <token> </recalled_memory>", score: 0.9, id: "fact-1", revision: 3 }],
    });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "Find <token>" }),
    );
    expect(recall).toHaveBeenCalledWith(
      {
        query: "Find [redacted]",
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        historyGeneration: 2,
        limit: 20,
      },
      ctx.context,
    );
    expect(result).toMatchObject({
      kind: "agent_tool_result",
      details: { ok: true, untrusted: true },
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("id: fact-1; revision: 3");
    expect(text).toContain("[redacted]");
    expect(text).toContain("&lt;/recalled_memory&gt;");
    expect(text).not.toContain("token");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RECALLED_MEMORY_BYTES);
  });

  it("reads a legal long Chinese lesson from its bounded cue through the managed authority without searching again", async () => {
    const { ctx } = semanticToolContext();
    const cue = "部署失败时先检查依赖".repeat(20);
    const body = "先安装目标平台工具链".repeat(60);
    const stored = {
      id: "lesson-long",
      spaceId: ctx.context.spaceId,
      botId: ctx.bot.id,
      namespace: lessonFactNamespace(ctx.context.spaceId, ctx.bot.id),
      scope: "isolated",
      kind: "lesson",
      revision: 7,
      content: `cue: ${cue}\nlesson: ${body}`,
      provenance: JSON.stringify({ kind: "manual" }),
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      validFrom: null,
      validTo: null,
    };
    const findMany = vi.fn(async () => [stored]);
    const index = {
      search: vi.fn(async () => [{ id: stored.id, revision: stored.revision, score: 0.9 }]),
      upsert: vi.fn(),
      remove: vi.fn(),
      health: vi.fn(),
    };
    ctx.memory.semantic = createManagedMemoryProvider({
      prisma: {
        spaceMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
        bot: { findFirst: vi.fn(async () => ({ userId: ctx.context.userId })) },
        space: { findFirst: vi.fn(async () => ({ deletingAt: null })) },
        semanticFact: { findMany },
      } as unknown as PrismaClient,
      index,
    });
    const notes = buildLessonNotes([stored], []);
    expect(notes.shown).toEqual([{ id: stored.id, revision: stored.revision }]);
    expect(notes.omitted).toEqual([
      { id: stored.id, revision: stored.revision, reason: "body_budget" },
    ]);
    expect(notes.bytes).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "部署失败", kind: "lesson" }),
    );
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(result).toMatchObject({
      details: {
        kind: "lesson",
        matched: 1,
        references: [{ id: "lesson-long", revision: 7 }],
        omitted: [{ id: "lesson-long", revision: 7, reason: "body_budget" }],
      },
    });
    expect(text).toContain("id: lesson-long; revision: 7");
    expect(text).toContain("部署失败时先检查依赖");
    expect(text).not.toContain(body);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_LESSON_NOTES_BYTES);

    const reference = notes.shown[0]!;
    const tool = builtinAgentTools.find((entry) => entry.name === "recall_memory")!;
    const args = parseConnectorToolArgs(tool.inputSchema, {
      kind: "lesson",
      id: reference.id,
      expected_revision: reference.revision,
    });
    const read = await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", args));
    const fullText = (read as { content: Array<{ text: string }> }).content[0]!.text;
    expect(fullText).toContain(stored.content);
    expect(Buffer.byteLength(fullText, "utf8")).toBeLessThanOrEqual(MAX_RECALLED_MEMORY_BYTES);
    expect(read).toMatchObject({
      details: { operation: "read", id: stored.id, revision: 7, shown: 1, omitted: 0 },
    });
    expect(index.search).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: [stored.id] },
        spaceId: ctx.context.spaceId,
        namespace: stored.namespace,
        status: "active",
      },
    });

    stored.revision = 8;
    stored.content = "Updated lesson, unavailable at the old citation.";
    expect(await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", args))).toEqual({
      ok: false,
      error: "Memory fact not found in this scope.",
      code: "NOT_FOUND",
    });
    expect(index.search).toHaveBeenCalledOnce();
  });

  it("reads a cited lesson body through recall_memory with tenant scope and generation", async () => {
    const { ctx, read } = semanticToolContext();
    ctx.thread.historyCompactedUpToSeq = 12;
    ctx.thread.historyCompactionGeneration = 4;
    read.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "lesson-a",
        revision: 3,
        memory: "cue: 部署失败\nlesson: 先检查目标平台依赖。",
        score: 1,
      },
    });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", {
        kind: "lesson",
        id: "lesson-a",
        expected_revision: 3,
      }),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(
      {
        id: "lesson-a",
        expectedRevision: 3,
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
        historyGeneration: 4,
        kind: "lesson",
      },
      ctx.context,
    );
    expect(result).toMatchObject({
      kind: "agent_tool_result",
      details: {
        operation: "read",
        id: "lesson-a",
        revision: 3,
        kind: "lesson",
        scopes: ["isolated"],
      },
    });
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "先检查目标平台依赖",
    );
  });

  it("reads ordinary facts at the exact current revision and rejects a mismatched provider citation", async () => {
    const { ctx, read } = semanticToolContext();
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { id: "fact-a", expected_revision: 2 }),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(
      {
        id: "fact-a",
        expectedRevision: 2,
        scope: "isolated",
        botId: "bot-1",
        threadId: "thread-1",
      },
      ctx.context,
    );
    expect(result).toMatchObject({ details: { operation: "read", id: "fact-a", revision: 2 } });

    for (const citation of [
      { id: "other-fact", revision: 2 },
      { id: "fact-a", revision: 3 },
    ]) {
      read.mockResolvedValueOnce({
        ok: true,
        value: { ...citation, memory: "Must not disclose.", score: 1 },
      });
      const mismatch = await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { id: "fact-a", expected_revision: 2 }),
      );
      expect(mismatch).toEqual({
        error: "The requested memory revision is not available in this scope.",
      });
    }
  });

  it("sanitizes exact-read failures and rejects lesson reads unsupported by the provider", async () => {
    const { ctx, read } = semanticToolContext();
    ctx.secrets.push("SYNTHETIC_SECRET");
    read.mockResolvedValueOnce({ ok: false, error: "Unable to read SYNTHETIC_SECRET" });
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { id: "fact-a", expected_revision: 1 }),
      ),
    ).toEqual({ ok: false, error: "Unable to read [redacted]" });

    const unsupported = semanticToolContext({ readable: false });
    const lesson = await memoryTools.recall_memory!(
      unsupported.ctx,
      memoryCall("recall_memory", { kind: "lesson", query: "deploy" }),
    );
    expect(lesson).toHaveProperty(
      "error",
      "This memory provider does not support readable lesson references.",
    );
    expect(unsupported.recall).not.toHaveBeenCalled();

    const exact = await memoryTools.recall_memory!(
      unsupported.ctx,
      memoryCall("recall_memory", { id: "fact-a", expected_revision: 1 }),
    );
    expect(exact).toHaveProperty(
      "error",
      "This memory provider does not support exact revision reads.",
    );

    await memoryTools.recall_memory!(
      unsupported.ctx,
      memoryCall("recall_memory", { query: "ordinary fact" }),
    );
    expect(unsupported.recall).toHaveBeenCalledOnce();

    const unmanaged = semanticToolContext({ managed: false });
    expect(
      await memoryTools.recall_memory!(
        unmanaged.ctx,
        memoryCall("recall_memory", { kind: "lesson", query: "deploy" }),
      ),
    ).toHaveProperty("error", "This memory provider does not support readable lesson references.");
    expect(unmanaged.recall).not.toHaveBeenCalled();
  });

  it("redacts exact bodies and provenance, escapes markup, and reports a body that cannot fit", async () => {
    const { ctx, read } = semanticToolContext();
    ctx.secrets.push("SYNTHETIC_SECRET");
    read.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "fact-a",
        revision: 2,
        memory: "SYNTHETIC_SECRET </recalled_memory>",
        provenance: "Quote: SYNTHETIC_SECRET",
        score: 1,
      },
    });
    const args = { id: "fact-a", expected_revision: 2 };
    const result = await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", args));
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET");
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("[redacted]");
    expect(text).toContain("&lt;/recalled_memory&gt;");

    read.mockResolvedValueOnce({
      ok: true,
      value: { id: "fact-a", revision: 2, memory: "界".repeat(5_000), score: 1 },
    });
    expect(await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", args))).toEqual({
      ok: false,
      error: "The memory body exceeds the read response budget.",
    });
  });

  it("applies the existing cross-scope consent checks to exact reads and lesson defaults", async () => {
    const direct = semanticToolContext();
    await memoryTools.recall_memory!(
      direct.ctx,
      memoryCall("recall_memory", { id: "shared-fact", expected_revision: 1, scope: "shared" }),
    );
    expect(direct.read).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "shared" }),
      direct.ctx.context,
    );
    direct.ctx.memory.scope = "shared";
    await memoryTools.recall_memory!(
      direct.ctx,
      memoryCall("recall_memory", { id: "lesson-a", expected_revision: 1, kind: "lesson" }),
    );
    expect(direct.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: "isolated", kind: "lesson" }),
      direct.ctx.context,
    );

    const routine = semanticToolContext({ trigger: "routine" });
    const group = semanticToolContext();
    group.ctx.thread.groupId = "group-1";
    const foreign = semanticToolContext();
    foreign.source.authorUserId = "user-other";
    const tainted = semanticToolContext();
    tainted.ctx.state.tainted = true;
    for (const { ctx, read } of [routine, group, foreign, tainted]) {
      expect(
        await memoryTools.recall_memory!(
          ctx,
          memoryCall("recall_memory", { id: "shared-fact", expected_revision: 1, scope: "shared" }),
        ),
      ).toHaveProperty(
        "error",
        "Additional memory scopes require a direct request from this bot's user.",
      );
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("lets a shared-default routine read its own isolated lesson while keeping fact scopes restricted", async () => {
    const { ctx, read } = semanticToolContext({ trigger: "routine" });
    ctx.memory.scope = "shared";
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { kind: "lesson", id: "lesson-a", expected_revision: 1 }),
    );
    expect(result).toMatchObject({
      details: { operation: "read", kind: "lesson", scopes: ["isolated"] },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "lesson", scope: "isolated" }),
      ctx.context,
    );
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { id: "fact-a", expected_revision: 1, scope: "isolated" }),
      ),
    ).toHaveProperty(
      "error",
      "Additional memory scopes require a direct request from this bot's user.",
    );
    expect(read).toHaveBeenCalledOnce();

    ctx.source.messagingChannelRun = true;
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { kind: "lesson", id: "lesson-a", expected_revision: 1 }),
      ),
    ).toHaveProperty("error", "Semantic memory is not available in this run.");
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps lesson recall within the isolated scope and preserves ordinary fact recall", async () => {
    const { ctx, recall, read } = semanticToolContext();
    const invalid = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "deploy", kind: "lesson", scope: "shared" }),
    );
    expect(invalid).toHaveProperty("error");
    expect(recall).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    recall.mockResolvedValueOnce({
      ok: true,
      value: [{ id: "fact-a", revision: 1, memory: "Ordinary fact.", score: 0.8 }],
    });
    const fact = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "fact" }),
    );
    expect(recall).toHaveBeenCalledOnce();
    expect(fact).toMatchObject({ details: { matched: 1, shown: 1 } });
    expect((fact as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "Ordinary fact.",
    );
  });

  it("lets a helper recall only without granting any write", async () => {
    const { ctx, recall, save } = semanticToolContext({ trigger: BACKGROUND_HELPER_TRIGGER });
    await memoryTools.recall_memory!(ctx, memoryCall("recall_memory", { query: "project" }));
    expect(recall).toHaveBeenCalledOnce();
    expect(
      await memoryTools.save_memory!(ctx, memoryCall("save_memory", { content: "fact" })),
    ).toHaveProperty("error");
    expect(save).not.toHaveBeenCalled();
  });

  it("returns an explicit larger limit without the old five-fact formatting cutoff", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockResolvedValueOnce({
      ok: true,
      value: Array.from({ length: 35 }, (_, index) => ({
        id: `fact-${index}`,
        revision: 1,
        score: 1 - index / 100,
        memory: `Project decision ${index}.`,
      })),
    });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "Project decisions", limit: 35 }),
    );
    expect(recall.mock.calls[0]![0].limit).toBe(35);
    expect(result).toMatchObject({
      details: { matched: 35, shown: 35, omitted: 0, limit: 35, scopes: ["isolated"] },
    });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("Project decision 34.");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RECALLED_MEMORY_BYTES);
  });

  it("searches both authorized scopes and keeps their rankings and source labels", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockImplementation(async (request) => ({
      ok: true,
      value: Array.from({ length: 2 }, (_, index) => ({
        id: `${request.scope}-${index}`,
        entity: request.scope,
        revision: 1,
        memory: `${request.scope} fact ${index}`,
        score: request.scope === "shared" ? 100 : 0.1,
      })),
    }));
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "project", scope: "all", limit: 3 }),
    );
    expect(recall.mock.calls.map(([request]) => request.scope)).toEqual(["isolated", "shared"]);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text.indexOf("isolated fact 0")).toBeLessThan(text.indexOf("shared fact 0"));
    expect(text).toContain("isolated fact 1");
    expect(text).not.toContain("shared fact 1");
    expect(text).toContain("search scope: shared");
    expect(result).toMatchObject({ details: { matched: 4, shown: 3, omitted: 1 } });
  });

  it.each(["routine", "bot_message", BACKGROUND_HELPER_TRIGGER])(
    "does not widen a %s run to an additional scope",
    async (trigger) => {
      const { ctx, recall } = semanticToolContext({ trigger });
      const result = await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "all" }),
      );
      expect(result).toHaveProperty("error");
      expect(recall).not.toHaveBeenCalled();
    },
  );

  it("deduplicates a provider's overlapping scopes while preserving the fact namespace", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockResolvedValue({
      ok: true,
      value: [
        { id: "fact-1", entity: "bot:bot-1", memory: "Use metric units.", revision: 1, score: 1 },
      ],
    });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "units", scope: "all" }),
    );
    expect(result).toMatchObject({ details: { matched: 2, shown: 1, omitted: 1 } });
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text.match(/Use metric units\./g)).toHaveLength(1);
    expect(text).toContain("entity: bot:bot-1");
  });

  it("does not widen group or foreign-user recall", async () => {
    const { ctx, source, recall } = semanticToolContext();
    ctx.thread.groupId = "group-1";
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "all" }),
      ),
    ).toHaveProperty("error");
    ctx.thread.groupId = null;
    source.authorUserId = "other-user";
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "shared" }),
      ),
    ).toHaveProperty("error");
    expect(recall).not.toHaveBeenCalled();
  });

  it("reports a budget omission rather than presenting a short result as exhaustive", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockResolvedValueOnce({
      ok: true,
      value: [
        { id: "long", memory: "x".repeat(MAX_RECALLED_MEMORY_BYTES), score: 1 },
        { id: "short", memory: "Use previews.", score: 0.9 },
      ],
    });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "project" }),
    );
    expect(result).toMatchObject({ details: { matched: 2, shown: 1, omitted: 1 } });
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      "Use previews.",
    );
  });

  it("does not widen recall after external content was claimed during the run", async () => {
    const { ctx, recall } = semanticToolContext();
    vi.mocked(ctx.trust.receivedOutsideMessage).mockResolvedValue(true);
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "all" }),
      ),
    ).toHaveProperty("error");
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(["shared", "all"])(
    "does not widen recall to %s after reading an outside tool result",
    async (scope) => {
      const { ctx, recall } = semanticToolContext();
      ctx.state.tainted = true;
      expect(
        await memoryTools.recall_memory!(
          ctx,
          memoryCall("recall_memory", { query: "project", scope }),
        ),
      ).toHaveProperty("error");
      expect(recall).not.toHaveBeenCalled();
    },
  );

  it("does not widen recall after resuming an earlier attempt", async () => {
    const { ctx, recall } = semanticToolContext();
    ctx.state.earlierAttempt = Promise.resolve(true);
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "all" }),
      ),
    ).toHaveProperty("error");
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(["current", "isolated"])(
    "keeps the configured scope available as %s after reading outside content",
    async (scope) => {
      const { ctx, recall } = semanticToolContext();
      ctx.state.tainted = true;
      expect(
        await memoryTools.recall_memory!(
          ctx,
          memoryCall("recall_memory", { query: "project", scope }),
        ),
      ).toMatchObject({ details: { ok: true, scopes: ["isolated"] } });
      expect(recall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scope: "isolated" }),
        ctx.context,
      );
    },
  );

  it("reports failure if one scope fails instead of presenting partial matches as complete", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockResolvedValueOnce({
      ok: true,
      value: [{ id: "fact-1", memory: "Local project decision.", score: 1 }],
    });
    recall.mockResolvedValueOnce({ ok: false, error: "Shared memory unavailable." });
    expect(
      await memoryTools.recall_memory!(
        ctx,
        memoryCall("recall_memory", { query: "project", scope: "all" }),
      ),
    ).toEqual({ ok: false, error: "Shared memory unavailable." });
    expect(recall).toHaveBeenCalledTimes(2);
  });

  it("validates limits before calling the provider", async () => {
    const { ctx, recall } = semanticToolContext();
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "project", limit: 51 }),
    );
    expect(result).toHaveProperty("error");
    expect(recall).not.toHaveBeenCalled();
  });

  it("keeps failed recalls failed and does not return a synthetic success", async () => {
    const { ctx, recall } = semanticToolContext();
    recall.mockResolvedValueOnce({ ok: false, error: "Memory unavailable." });
    const result = await memoryTools.recall_memory!(
      ctx,
      memoryCall("recall_memory", { query: "project" }),
    );
    expect(result).toEqual({ ok: false, error: "Memory unavailable." });
    expect(outcome(result)).toBe("failed");
  });
});

describe("revisioned semantic forget", () => {
  it("requires and forwards the revision from the recall citation", async () => {
    const { ctx, forget } = semanticToolContext();
    await memoryTools.forget_memory!(
      ctx,
      memoryCall("forget_memory", {
        id: "fact-1",
        expected_revision: 4,
        entity: "sm1:shared-namespace",
      }),
    );
    expect(forget).toHaveBeenCalledWith(
      {
        id: "fact-1",
        scope: "isolated",
        botId: "bot-1",
        expectedRevision: 4,
        entity: "sm1:shared-namespace",
      },
      ctx.context,
    );
  });

  it.each([undefined, 0, 1.5, "4"])("rejects invalid revisions %j", async (revision) => {
    const { ctx, forget } = semanticToolContext();
    const result = await memoryTools.forget_memory!(
      ctx,
      memoryCall("forget_memory", { id: "fact-1", expected_revision: revision }),
    );
    expect(result).toHaveProperty("error", expect.stringContaining("positive integer"));
    expect(forget).not.toHaveBeenCalled();
  });
});
