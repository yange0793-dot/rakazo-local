import { ORPCError } from "@orpc/server";
import type { AdapterContext, SemanticMemoryResponse } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  buildAgentMemoryPrompt,
  isScratchpadStatus,
  listScratchpadItems,
  mapScratchpadItem,
  readAgentMemory,
} from "@rakazo/adapters";
import type { Actor, MessageBlock, SemanticFact } from "@rakazo/contracts";
import { isDeletableMemoryDocument } from "@rakazo/contracts";
import { findSpaceMemoryConfig, IsolationError, SemanticFactStore } from "@rakazo/db";
import {
  disconnectMemoryProvider,
  persistMemoryProviderConfig,
  serializeSpaceMemoryConfig,
  updateMemoryProviderDefaultScope,
} from "../memory-provider-config.js";
import type { RouterContext } from "./context.js";

function semanticValue<T>(response: SemanticMemoryResponse<T>): T {
  if (response.ok) return response.value;
  if (response.error === MEMORY_REVISION_CONFLICT_ERROR) {
    throw new ORPCError("CONFLICT", { message: response.error });
  }
  throw new ORPCError(response.code ?? "SERVICE_UNAVAILABLE", { message: response.error });
}

function factManagementUnsupported(): never {
  throw new ORPCError("NOT_IMPLEMENTED", {
    message: "This memory provider does not support fact management.",
  });
}

function factContext(actor: Actor, botId: string, operationId: string, signal?: AbortSignal) {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: signal ?? new AbortController().signal,
  } satisfies AdapterContext;
}

export function memoryRoutes(ctx: RouterContext) {
  const { deps, repos, taughtSkills, agentSkills, authed } = ctx;
  const managedProvider = async (actor: Actor, botId: string) => {
    // Even an unsupported provider must not let a foreign or invented bot through.
    await repos.getBot(actor, botId, { includeArchived: true });
    const configured = await deps.memoryProviders.resolve(actor.spaceId);
    return configured?.provider.describe().capabilities.managedFacts === true
      ? configured.provider
      : null;
  };
  return {
    memory: {
      facts: authed.memory.facts.handler(async ({ context, input }) => {
        const provider = await managedProvider(context.actor, input.botId);
        if (!provider?.listFacts) {
          return { supported: false, items: [], nextCursor: null };
        }
        return semanticValue(
          await provider.listFacts(
            input,
            factContext(context.actor, input.botId, "memory.facts", context.signal),
          ),
        );
      }),
      correctFact: authed.memory.correctFact.handler(async ({ context, input }) => {
        const provider = await managedProvider(context.actor, input.botId);
        if (!provider?.correctFact) factManagementUnsupported();
        // The provider authors manual provenance from this authenticated context;
        // clients cannot supply a run, source quote, or a user-confirmed label.
        return semanticValue(
          await provider.correctFact(
            input,
            factContext(context.actor, input.botId, "memory.correctFact", context.signal),
          ),
        );
      }),
      forgetFact: authed.memory.forgetFact.handler(async ({ context, input }) => {
        const provider = await managedProvider(context.actor, input.botId);
        if (!provider?.forget) factManagementUnsupported();
        const forgotten = semanticValue(
          await provider.forget(
            input,
            factContext(context.actor, input.botId, "memory.forgetFact", context.signal),
          ),
        );
        if (!forgotten.expired) {
          throw new ORPCError("CONFLICT", {
            message: forgotten.reason ?? "The memory fact was not forgotten.",
          });
        }
        return { ok: true as const };
      }),
      /**
       * The draft block on the bot's thread is the only source of cue, lesson, and evidence:
       * the client names which draft to save and cannot supply or alter its text.
       */
      saveLesson: authed.memory.saveLesson.handler(async ({ context, input }) => {
        const provider = await managedProvider(context.actor, input.botId);
        if (!provider) factManagementUnsupported();
        const bot = await deps.prisma.bot.findFirst({
          where: { id: input.botId, spaceId: context.actor.spaceId },
          select: { thread: { select: { id: true } } },
        });
        if (!bot?.thread) throw new ORPCError("NOT_FOUND", { message: "Lesson draft not found" });
        const messages = await deps.prisma.message.findMany({
          where: { threadId: bot.thread.id, role: "bot" },
          orderBy: { seq: "desc" },
          take: 100,
        });
        let draft:
          | {
              messageId: string;
              blocks: MessageBlock[];
              index: number;
              block: Extract<MessageBlock, { kind: "lesson_draft" }>;
            }
          | undefined;
        for (const message of messages) {
          const blocks = message.blocks as MessageBlock[];
          if (!Array.isArray(blocks)) continue;
          const index = blocks.findIndex(
            (block) => block.kind === "lesson_draft" && block.lessonId === input.lessonId,
          );
          const block = blocks[index];
          if (block?.kind !== "lesson_draft") continue;
          draft = { messageId: message.id, blocks, index, block };
          break;
        }
        if (!draft) throw new ORPCError("NOT_FOUND", { message: "Lesson draft not found" });
        // The host-written draft names its run; the store re-checks that the run exists for
        // this space and bot before attributing the saved lesson to it.
        const fact = await new SemanticFactStore(deps.prisma).saveLesson(
          {
            botId: input.botId,
            cue: draft.block.cue,
            lesson: draft.block.lesson,
            provenance: {
              kind: "run",
              runId: draft.block.runId,
              threadId: bot.thread.id,
              messageId: draft.messageId,
              harness: {
                // The draft block carries no domain; empty leaves the memory page's Domain row out.
                domainKey: "",
                signals: [],
                autoApplied: false,
                evidence: draft.block.evidence,
              },
            },
          },
          factContext(context.actor, input.botId, "memory.saveLesson", context.signal),
        );
        if (!fact) throw new ORPCError("CONFLICT", { message: "The lesson could not be saved." });
        // A retry after a lost reply finds the block already saved; the store deduped the write
        // by content, so only the card still has to hear about it.
        if (draft.block.status !== "saved") {
          const nextBlocks: MessageBlock[] = [...draft.blocks];
          nextBlocks[draft.index] = { ...draft.block, status: "saved" };
          await deps.prisma.message.update({
            where: { id: draft.messageId },
            data: { blocks: nextBlocks as never },
          });
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: input.botId,
            type: "thread.message.updated",
            payload: { messageId: draft.messageId, role: "bot", blocks: nextBlocks },
          });
        }
        return fact;
      }),
      exportFacts: authed.memory.exportFacts.handler(async ({ context, input }) => {
        const provider = await managedProvider(context.actor, input.botId);
        if (!provider?.listFacts) factManagementUnsupported();
        const facts: SemanticFact[] = [];
        const adapterContext = factContext(
          context.actor,
          input.botId,
          "memory.exportFacts",
          context.signal,
        );
        let cursor: string | undefined;
        do {
          const page = semanticValue(
            await provider.listFacts(
              { ...input, includeHistory: true, limit: 100, ...(cursor ? { cursor } : {}) },
              adapterContext,
            ),
          );
          if (!page.supported) factManagementUnsupported();
          // Forgotten facts keep only a body-free tombstone; they are not part of an export.
          facts.push(...page.items.filter((item) => item.status !== "forgotten"));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return { format: "rakazo-semantic-memory-v1" as const, facts };
      }),
      list: authed.memory.list.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
          },
        });
        return docs.map((doc) => ({
          id: doc.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: doc.path,
          content: doc.content,
          revision: doc.revision,
          updatedAt: doc.updatedAt.toISOString(),
        }));
      }),
      budget: authed.memory.budget.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        // Read through the store a run uses, so the numbers match what the bot receives.
        const documents = await readAgentMemory(deps.memory, input.botId, {
          operationId: "mem",
          traceId: "mem",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          botId: input.botId,
          signal: context.signal ?? new AbortController().signal,
        });
        return buildAgentMemoryPrompt(documents).plan;
      }),
      update: authed.memory.update.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!doc) throw new IsolationError();
        const updated = await deps.memory
          .commit(
            {
              scope: doc.scope as "bot" | "user",
              botId: doc.botId ?? undefined,
              path: doc.path,
              content: input.content,
              expectedRevision: input.expectedRevision,
            },
            {
              operationId: "mem",
              traceId: "mem",
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              signal: new AbortController().signal,
            },
          )
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR) {
              throw new ORPCError("CONFLICT", { message: error.message });
            }
            throw error;
          });
        return {
          id: updated.id,
          scope: doc.scope as "bot" | "user",
          botId: doc.botId,
          path: updated.path,
          content: updated.content,
          revision: updated.revision,
          updatedAt: new Date().toISOString(),
        };
      }),
      remove: authed.memory.remove.handler(async ({ context, input }) => {
        const doc = await deps.prisma.memoryDocument.findFirst({
          where: {
            id: input.documentId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!doc) throw new IsolationError();
        if (!isDeletableMemoryDocument(doc.path)) {
          throw new ORPCError("BAD_REQUEST", {
            message: `${doc.path} cannot be deleted; edit its content instead.`,
          });
        }
        await deps.memory.remove(
          {
            id: doc.id,
            scope: doc.scope as "bot" | "user",
            botId: doc.botId ?? undefined,
            path: doc.path,
          },
          {
            operationId: "mem",
            traceId: "mem",
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            signal: new AbortController().signal,
          },
        );
        return { ok: true as const };
      }),
      exportMarkdown: authed.memory.exportMarkdown.handler(async ({ context, input }) => {
        const docs = await deps.prisma.memoryDocument.findMany({
          where: {
            spaceId: context.actor.spaceId,
            ...(input.botId ? { botId: input.botId } : {}),
          },
        });
        return docs.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n");
      }),
      providerConfig: authed.memory.providerConfig.handler(async ({ context }) => {
        const config = await findSpaceMemoryConfig(deps.prisma, context.actor.spaceId);
        return config ? serializeSpaceMemoryConfig(config) : null;
      }),
      connectProvider: authed.memory.connectProvider.handler(async ({ context, input }) =>
        persistMemoryProviderConfig(deps, context.actor, input),
      ),
      setDefaultScope: authed.memory.setDefaultScope.handler(async ({ context, input }) =>
        updateMemoryProviderDefaultScope(deps, context.actor, input.defaultMemoryScope),
      ),
      disconnectProvider: authed.memory.disconnectProvider.handler(async ({ context }) =>
        disconnectMemoryProvider(deps, context.actor),
      ),
    },
    scratchpad: {
      list: authed.scratchpad.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return listScratchpadItems(
          { prisma: deps.prisma },
          {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            status: input.status,
            includeDone: input.includeDone ?? false,
          },
        );
      }),
      create: authed.scratchpad.create.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const row = await deps.prisma.scratchpadItem.create({
          data: {
            spaceId: context.actor.spaceId,
            botId: input.botId,
            userId: context.actor.userId,
            title: input.title.trim(),
            status: input.status,
            notes: input.notes.trim(),
          },
        });
        return mapScratchpadItem(row);
      }),
      update: authed.scratchpad.update.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!existing) throw new IsolationError();
        if (input.status !== undefined && !isScratchpadStatus(input.status)) {
          throw new ORPCError("BAD_REQUEST", { message: "Invalid scratchpad status." });
        }
        const row = await deps.prisma.scratchpadItem.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title.trim() } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes.trim() } : {}),
          },
        });
        return mapScratchpadItem(row);
      }),
      remove: authed.scratchpad.remove.handler(async ({ context, input }) => {
        const existing = await deps.prisma.scratchpadItem.findFirst({
          where: {
            id: input.itemId,
            spaceId: context.actor.spaceId,
          },
        });
        if (!existing) throw new IsolationError();
        await deps.prisma.scratchpadItem.delete({ where: { id: existing.id } });
        return { ok: true as const };
      }),
    },
    skills: {
      list: authed.skills.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.list(context.actor, input.botId);
      }),
      get: authed.skills.get.handler(async ({ context, input }) =>
        taughtSkills.get(context.actor, input.skillId),
      ),
      start: authed.skills.start.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        return taughtSkills.start(context.actor, input.botId, input.goal);
      }),
      appendEvent: authed.skills.appendEvent.handler(async ({ context, input }) =>
        taughtSkills.appendEvent(context.actor, input.skillId, input.event),
      ),
      snapshot: authed.skills.snapshot.handler(async ({ context, input }) =>
        taughtSkills.snapshot(context.actor, input.skillId),
      ),
      stop: authed.skills.stop.handler(async ({ context, input }) =>
        taughtSkills.stop(context.actor, input.skillId),
      ),
      updateDraft: authed.skills.updateDraft.handler(async ({ context, input }) =>
        taughtSkills.updateDraft(context.actor, input.skillId, {
          name: input.name,
          playbook: input.playbook,
        }),
      ),
      save: authed.skills.save.handler(async ({ context, input }) =>
        taughtSkills.save(context.actor, input.skillId, input.name),
      ),
      testRun: authed.skills.testRun.handler(async ({ context, input }) =>
        taughtSkills.testRun(context.actor, input.skillId, input.prompt),
      ),
      remove: authed.skills.remove.handler(async ({ context, input }) =>
        taughtSkills.remove(context.actor, input.skillId),
      ),
    },
    agentSkills: {
      list: authed.agentSkills.list.handler(async ({ context }) => agentSkills.list(context.actor)),
      get: authed.agentSkills.get.handler(async ({ context, input }) =>
        agentSkills.get(context.actor, input),
      ),
      create: authed.agentSkills.create.handler(async ({ context, input }) =>
        agentSkills.create(context.actor, input),
      ),
      update: authed.agentSkills.update.handler(async ({ context, input }) =>
        agentSkills.update(context.actor, input),
      ),
      remove: authed.agentSkills.remove.handler(async ({ context, input }) =>
        agentSkills.remove(context.actor, input.skillId),
      ),
    },
  };
}
