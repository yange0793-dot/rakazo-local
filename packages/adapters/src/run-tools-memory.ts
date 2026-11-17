import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  HistoryReadInputSchema,
  HistorySearchInputSchema,
  MEMORY_INDEX_PATH,
  SemanticMemoryRecallInputSchema,
} from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, redactSecrets } from "@rakazo/core";
import { readHistory, searchHistory } from "@rakazo/db";
import { sharedMemorySaveError } from "./builtin-tools.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import {
  buildRecalledMemory,
  MAX_RECALLED_MEMORIES,
  MAX_RECALLED_MEMORY_BYTES,
} from "./history-compaction.js";
import { editMemory } from "./memory-tools.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argsError } from "./tool-args.js";
import { truncateUtf8 } from "./utf8.js";

export type SemanticMemoryRunSource = {
  trigger: string;
  threadId: string;
  userId: string;
  sourceMessageId?: string | null;
};

export type SemanticMemorySourceMessage = {
  id: string;
  threadId: string;
  role: string;
  authorUserId?: string | null;
  blocks: unknown;
};

/** Only the originating person's text, never a generated task prompt or another sender's blocks. */
export function semanticMemoryUserSource(
  run: SemanticMemoryRunSource,
  source: SemanticMemorySourceMessage | null,
  external: boolean,
): { messageId: string; text: string } | null {
  if (
    external ||
    (run.trigger !== "user" && run.trigger !== "follow_up") ||
    !run.sourceMessageId ||
    source?.id !== run.sourceMessageId ||
    source.threadId !== run.threadId ||
    source.role !== "user" ||
    source.authorUserId !== run.userId ||
    !Array.isArray(source.blocks)
  ) {
    return null;
  }
  const blocks = source.blocks as MessageBlock[];
  if (
    blocks.some(
      (block) =>
        block.kind === "bot_message_received" ||
        block.kind === "bot_message_sent" ||
        block.kind === "channel_message" ||
        block.kind === "handoff",
    )
  ) {
    return null;
  }
  const text = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
  return text.trim() ? { messageId: source.id, text } : null;
}

/** One automatic recall path: early user-source recall or the unchanged legacy compacted path. */
export async function semanticRecallForRun(
  options: {
    provider: SemanticMemoryProvider | null;
    scope: DurableMemoryScope | null;
    botId: string;
    run: SemanticMemoryRunSource;
    sourceMessage: SemanticMemorySourceMessage | null;
    /** Newest first, preceding the source message in this same thread. */
    previousMessages?: readonly SemanticMemorySourceMessage[];
    external: boolean;
    includeSemanticRecall: boolean;
    prompt: string;
    historyCompactedUpToSeq: number | null;
    historyGeneration: number;
    secrets: readonly string[];
  },
  context: AdapterContext,
): Promise<{
  origin: "preTurn" | "compacted" | null;
  response: SemanticMemoryResponse<SemanticMemoryResult[]> | null;
}> {
  const { provider, scope } = options;
  if (!provider || !scope || !options.includeSemanticRecall) {
    return { origin: null, response: null };
  }
  const preTurn = provider.describe().capabilities.preTurnRecall === true;
  const source = preTurn
    ? semanticMemoryUserSource(options.run, options.sourceMessage, options.external)
    : null;
  if (preTurn ? !source : options.historyCompactedUpToSeq == null) {
    return { origin: null, response: null };
  }
  let query = source ? redactSecrets(source.text, options.secrets).trim() : options.prompt;
  if (source) {
    const previous = (options.previousMessages ?? [])
      .flatMap((message) => {
        if (message.id === source.messageId) return [];
        const value = semanticMemoryUserSource(
          { ...options.run, sourceMessageId: message.id },
          message,
          options.external,
        );
        return value
          ? [truncateUtf8(redactSecrets(value.text, options.secrets).trim(), 1_000)]
          : [];
      })
      .slice(0, 2);
    query = truncateUtf8(query, 6_000);
    if (previous.length) {
      query = `Current user request:\n${query}\n\nEarlier user context:\n${previous.reverse().join("\n")}`;
    }
  }
  const request: SemanticMemoryRecallRequest = {
    query,
    scope,
    botId: options.botId,
    threadId: options.run.threadId,
    ...(options.historyCompactedUpToSeq == null
      ? {}
      : { historyGeneration: options.historyGeneration }),
    limit: MAX_RECALLED_MEMORIES,
  };
  return {
    origin: preTurn ? "preTurn" : "compacted",
    response: await provider.recall(request, context),
  };
}

/** Cross-chat history requires a surviving direct human request in this app thread. */
export function historyMyChatsAllowed(
  run: { trigger: string; threadId: string },
  source: { role: string; threadId: string } | null,
  external: boolean,
): boolean {
  return (
    !external &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source?.role === "user" &&
    source.threadId === run.threadId
  );
}

/**
 * Models often fill optional fields they do not use with "" or null (botId: "", linkedRunId: "").
 * No history field means anything when blank, so a blank field counts as not given.
 */
export function withoutBlankFields(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([, value]) => value !== null && !(typeof value === "string" && !value.trim()),
    ),
  );
}

export function semanticMemorySaveArguments(
  args: Record<string, unknown>,
  managedFacts: boolean,
):
  | (Pick<SemanticMemorySaveRequest, "content" | "replacesId" | "expectedRevision"> & {
      sourceQuote?: string;
    })
  | { error: string } {
  if (
    Object.keys(args).some(
      (name) => !["content", "source_quote", "replaces_id", "expected_revision"].includes(name),
    )
  ) {
    return { error: "Unsupported memory argument. Source ids are assigned by the server." };
  }
  if (typeof args.content !== "string" || !args.content.trim()) {
    return { error: "content must be a nonblank string." };
  }
  if (
    args.source_quote !== undefined &&
    (typeof args.source_quote !== "string" || !args.source_quote.trim())
  ) {
    return { error: "source_quote must be a nonblank literal quote from the user's message." };
  }
  const replaces = args.replaces_id !== undefined;
  const revision = args.expected_revision !== undefined;
  if (replaces !== revision) {
    return { error: "replaces_id and expected_revision must be provided together." };
  }
  if (replaces) {
    if (
      typeof args.replaces_id !== "string" ||
      !args.replaces_id.trim() ||
      !Number.isSafeInteger(args.expected_revision) ||
      (args.expected_revision as number) < 1
    ) {
      return {
        error: "Correction requires a nonblank replaces_id and a positive integer revision.",
      };
    }
    if (!managedFacts) {
      return { error: "This memory provider does not support atomic fact correction." };
    }
  }
  return {
    content: args.content,
    ...(args.source_quote === undefined ? {} : { sourceQuote: args.source_quote as string }),
    ...(replaces
      ? {
          replacesId: args.replaces_id as string,
          expectedRevision: args.expected_revision as number,
        }
      : {}),
  };
}

async function readHistoryTool(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const { name, args } = call;
  const crossChat =
    name === "search_history"
      ? args.scope === "my_chats"
      : typeof args.threadId === "string" && args.threadId !== run.threadId;
  // Channel or webhook text claimed mid-turn revokes the grant for the rest of the run.
  const allowMyChats =
    crossChat && ctx.source.myChatsAllowed && !(await ctx.trust.receivedOutsideMessage());
  const scope = {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    channelId: ctx.source.channelId,
    searchBeforeSeq: ctx.source.historySearchBeforeSeq,
    allowMyChats,
    searchAt: run.createdAt,
  };
  const given = withoutBlankFields(args);
  let response: Awaited<ReturnType<typeof searchHistory | typeof readHistory>>;
  if (name === "search_history") {
    const parsed = HistorySearchInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await searchHistory(deps.prisma, scope, parsed.data);
  } else {
    const parsed = HistoryReadInputSchema.safeParse(given);
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    response = await readHistory(deps.prisma, scope, parsed.data);
  }
  const redacted = redactConnectorPayload(response, ctx.secrets);
  // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
  if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
    return call.finish({
      untrusted: true,
      error:
        "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
    });
  }
  // Files the bot can now see are copied before its next computer tool.
  ctx.computer.copyEarlierFiles(
    response.messages.flatMap((message) =>
      (message.attachments ?? []).map((file) => ({
        kind: "file" as const,
        artifactId: file.artifactId,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      })),
    ),
  );
  return call.finish(redacted);
}

/** Memory documents, semantic memory and thread history. */
export const memoryTools: ToolHandlers = {
  async remember(ctx, call) {
    const { deps, runId, bot, thread, context } = ctx;
    const { args } = call;
    // One document per bot keeps the size cap meaningful.
    const path = MEMORY_INDEX_PATH;
    // A concurrent save changes the revision, so re-read and apply the edit again.
    for (let attempt = 1; ; attempt += 1) {
      const snapshot = await deps.memory.read({ scope: "bot", botId: bot.id, path }, context);
      const existing = snapshot.documents[0];
      const edit = editMemory(
        existing?.content ?? "",
        String(args.content ?? ""),
        String(args.old_text ?? ""),
      );
      if ("error" in edit) return call.finish(edit);
      const { content } = edit;
      if (content === (existing?.content ?? "")) return call.finish({ ok: true });
      try {
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path,
            content,
            expectedRevision: existing?.revision ?? 0,
            sourceRunId: runId,
            sourceThreadId: thread.id,
          },
          context,
        );
        return call.finish({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
      }
    }
  },
  async save_shared_memory(ctx, call) {
    const { deps, runId, thread, context } = ctx;
    const { args } = call;
    const invalid = sharedMemorySaveError(args);
    if (invalid) return call.finish({ error: invalid });
    const path = String(args.path ?? "").trim();
    // The save replaces the whole document. Pass the revision just read so a
    // concurrent edit is rejected instead of overwritten.
    const snapshot = await deps.memory.read({ scope: "user", path }, context);
    const expectedRevision = snapshot.documents[0]?.revision ?? 0;
    try {
      const saved = await deps.memory.commit(
        {
          scope: "user",
          path,
          content: String(args.content ?? ""),
          expectedRevision,
          sourceRunId: runId,
          sourceThreadId: thread.id,
        },
        context,
      );
      return call.finish({ ok: true, path: saved.path, revision: saved.revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save shared memory.";
      if (message === MEMORY_REVISION_CONFLICT_ERROR) return call.finish({ error: message });
      throw error;
    }
  },
  async recall_memory(ctx, call) {
    const { bot, thread, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic || !ctx.memory.scope || ctx.source.messagingChannelRun) {
      return call.finish({ error: "Semantic memory is not available in this run." });
    }
    const parsed = SemanticMemoryRecallInputSchema.safeParse(withoutBlankFields(args));
    if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
    const { query, limit, scope } = parsed.data;
    const scopes: DurableMemoryScope[] =
      scope === "all"
        ? [ctx.memory.scope, ctx.memory.scope === "isolated" ? "shared" : "isolated"]
        : [scope === "current" ? ctx.memory.scope : scope];
    if (scopes.some((value) => value !== ctx.memory.scope)) {
      const sourceMessage = ctx.run.sourceMessageId
        ? await ctx.deps.prisma.message.findUnique({
            where: { id: ctx.run.sourceMessageId, threadId: thread.id },
            select: { id: true, threadId: true, role: true, authorUserId: true, blocks: true },
          })
        : null;
      if (
        thread.groupId ||
        thread.externalConversationId ||
        !semanticMemoryUserSource(ctx.run, sourceMessage, ctx.source.messagingChannelRun) ||
        (await isRunTainted(ctx))
      ) {
        return call.finish({
          error: "Additional memory scopes require a direct request from this bot's user.",
        });
      }
    }
    const responses = await Promise.all(
      scopes.map((selectedScope) =>
        ctx.memory.semantic!.recall(
          {
            query: redactSecrets(query, ctx.secrets),
            scope: selectedScope,
            botId: bot.id,
            threadId: thread.id,
            ...(thread.historyCompactedUpToSeq == null
              ? {}
              : { historyGeneration: thread.historyCompactionGeneration }),
            limit,
          },
          context,
        ),
      ),
    );
    const failure = responses.find((response) => !response.ok);
    if (failure && !failure.ok)
      return call.finish({ ok: false, error: sanitizeConnectorError(failure.error, ctx.secrets) });
    // Provider scores need not be comparable across scopes; retain each scope's rank.
    const results: SemanticMemoryResult[] = [];
    for (let rank = 0; rank < limit; rank++) {
      for (let index = 0; index < responses.length; index++) {
        const response = responses[index]!;
        if (response.ok && response.value[rank]) {
          const value = response.value[rank]!;
          results.push({
            ...value,
            provenance: `search scope: ${scopes[index]}; ${value.provenance ?? ""}`,
          });
        }
      }
    }
    const rendered = buildRecalledMemory(results, ctx.secrets, {
      maxFacts: limit,
      maxBytes: MAX_RECALLED_MEMORY_BYTES,
    });
    return call.finish({
      kind: "agent_tool_result",
      content: [
        {
          type: "text",
          text:
            rendered.text ||
            (results.length
              ? "No recalled facts fit the response budget."
              : "No matching memories."),
        },
      ],
      details: {
        ok: true,
        untrusted: true,
        matched: results.length,
        shown: rendered.shown,
        omitted: rendered.omitted,
        bytes: rendered.bytes,
        limit,
        scopes,
      },
    });
  },
  search_history: readHistoryTool,
  read_history: readHistoryTool,
  async save_memory(ctx, call) {
    const { bot, run, runId, context } = ctx;
    const { args } = call;
    if (run.trigger === BACKGROUND_HELPER_TRIGGER) {
      return call.finish({
        error: "A helper cannot write memory. Return the fact to the bot instead.",
      });
    }
    const semantic = ctx.memory.semantic;
    if (!semantic || !ctx.memory.scope || ctx.source.messagingChannelRun) {
      return call.finish({ error: "Semantic memory is not available in this run." });
    }
    const parsed = semanticMemorySaveArguments(
      args,
      semantic.describe().capabilities.managedFacts === true,
    );
    if ("error" in parsed) return call.finish(parsed);
    const sourceMessage =
      (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
        ? await ctx.deps.prisma.message.findUnique({
            where: { id: run.sourceMessageId, threadId: run.threadId },
            select: { id: true, threadId: true, role: true, authorUserId: true, blocks: true },
          })
        : null;
    const userSource = semanticMemoryUserSource(run, sourceMessage, ctx.source.messagingChannelRun);
    if (parsed.sourceQuote !== undefined && !userSource?.text.includes(parsed.sourceQuote)) {
      return call.finish({
        error: "source_quote does not match this run's originating user message.",
      });
    }
    const { sourceQuote, ...request } = parsed;
    if (sourceQuote !== undefined && redactSecrets(sourceQuote, ctx.secrets) !== sourceQuote) {
      return call.finish({
        error: "source_quote contains a protected secret and cannot be saved.",
      });
    }
    return call.finish(
      await semantic.save(
        {
          ...request,
          content: redactSecrets(request.content, ctx.secrets),
          scope: ctx.memory.scope,
          botId: bot.id,
          source: {
            kind: "durable",
            runId,
            threadId: run.threadId,
            ...(userSource ? { messageId: userSource.messageId } : {}),
            ...(sourceQuote === undefined ? {} : { quote: sourceQuote }),
          },
        },
        context,
      ),
    );
  },
  async forget_memory(ctx, call) {
    const { bot, context } = ctx;
    const { args } = call;
    if (!ctx.memory.semantic?.forget) {
      return call.finish({
        error: "This memory provider does not support forgetting individual facts.",
      });
    }
    return call.finish(
      await ctx.memory.semantic.forget(
        {
          id: String(args.id ?? ""),
          scope: ctx.memory.scope!,
          botId: bot.id,
          ...(typeof args.entity === "string" && args.entity.trim()
            ? { entity: args.entity.trim() }
            : {}),
          ...(typeof args.reason === "string" && args.reason.trim()
            ? { reason: args.reason.trim() }
            : {}),
        },
        context,
      ),
    );
  },
};
