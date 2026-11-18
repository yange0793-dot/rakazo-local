import type { SemanticMemoryProvider, SemanticMemorySaveRequest } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { MAX_RECALLED_MEMORY_BYTES } from "./history-compaction.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import {
  memoryTools,
  semanticMemorySaveArguments,
  withoutBlankFields,
} from "./run-tools-memory.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";

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
  options: { managed?: boolean; trigger?: string; external?: boolean } = {},
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
  const forget = vi.fn<NonNullable<SemanticMemoryProvider["forget"]>>(async (request) => ({
    ok: true,
    value: { id: request.id, expired: true, reason: null },
  }));
  const ctx = {
    run,
    runId: run.id,
    thread: { id: run.threadId, historyCompactedUpToSeq: null, historyCompactionGeneration: 0 },
    bot: { id: run.botId },
    context: { runId: run.id },
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
        forget,
      },
    },
  } as unknown as RunContext;
  return { ctx, source, findUnique, save, recall, forget };
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

describe("explicit semantic recall", () => {
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
