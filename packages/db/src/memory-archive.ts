import type {
  AdapterContext,
  DurableMemoryScope,
  MemoryExtractionChange,
  MemoryExtractionExisting,
  MemoryExtractionMessage,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { effectiveMemoryScope } from "./memory-config.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import type { SemanticArchiveSource } from "./semantic-facts.js";
import { SemanticFactStore, semanticFactNamespace } from "./semantic-facts.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "./transaction-retry.js";

/**
 * One unit of automatic archiving for a direct personal chat. It carries message text for the
 * optional extractor only; the durable cursor and job pointer store no transcript content.
 */
export interface MemoryArchiveBatch {
  threadId: string;
  botId: string;
  userId: string;
  spaceId: string;
  scope: DurableMemoryScope;
  generation: number;
  fromSeq: number;
  throughSeq: number;
  messages: MemoryExtractionMessage[];
  newSources: Array<{ id: string; text: string; createdAt: string }>;
  retirementEvidence: MemoryExtractionExisting[];
}

export interface MemoryArchiveTarget {
  threadId: string;
  botId: string;
  userId: string;
}

/** What one applied batch changed; `removed` counts removal proposals applied as tombstones. */
export interface MemoryArchiveApplyCounts {
  saved: number;
  updated: number;
  skipped: number;
  removed: number;
}

/** Pointer-only scheduled work for a reconciler; no message text leaves Postgres. */
export interface MemoryArchivePointer {
  threadId: string;
  botId: string;
  userId: string;
  spaceId: string;
  availableAt: Date;
}

type Tx = Prisma.TransactionClient;
type ReadDb = Pick<PrismaClient, "spaceMember" | "bot" | "space" | "thread" | "spaceMemoryConfig">;

interface ArchiveMessageRow {
  id: string;
  seq: number;
  role: string;
  botId: string | null;
  authorUserId: string | null;
  blocks: unknown;
  createdAt: Date;
}

const MESSAGE_SELECT = {
  id: true,
  seq: true,
  role: true,
  botId: true,
  authorUserId: true,
  blocks: true,
  createdAt: true,
} as const;

/** Delivery prompts and channel/bot payloads are never the person's own words. */
const NON_USER_SOURCE_BLOCKS: ReadonlySet<string> = new Set([
  "channel_message",
  "bot_message_received",
  "bot_message_sent",
  "handoff",
  "delivery",
]);

const DIRECT_RUN_TRIGGERS: ReadonlySet<string> = new Set(["user", "follow_up"]);
const CONTEXT_MESSAGES = 8;
const DEFAULT_BATCH_MESSAGES = 40;
/** A clear drains whole conversations, so each call covers as much as one request allows. */
export const FORCE_BATCH_MESSAGES = 200;
const MAX_BATCH_MESSAGES = 200;
/** One batch's message text has to fit one extraction request beside notes and recall. */
const MAX_BATCH_TEXT_BYTES = 512 * 1024;
/** Preceding turns are context; they never get to fill a request on their own. */
const MAX_CONTEXT_TEXT_BYTES = 64 * 1024;
const RETIREMENT_EVIDENCE_LIMIT = 100;
const MAX_PENDING_POINTERS = 1000;
const CLEAR_SOURCE_RUNS = 10;
/** Prior turns a first schedule may reach back over when no cursor exists yet. */
const PRIOR_FAILED_RUNS = 20;

function blocksOf(value: unknown): Array<{ kind?: unknown; text?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (block): block is { kind?: unknown; text?: unknown } =>
      Boolean(block) && typeof block === "object" && !Array.isArray(block),
  );
}

function textOf(blocks: Array<{ kind?: unknown; text?: unknown }>): string {
  return blocks
    .flatMap((block) =>
      block.kind === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n");
}

/** The person's own direct text, or null for deliveries, channel payloads and empty bodies. */
function directUserText(blocks: unknown): string | null {
  const parsed = blocksOf(blocks);
  if (
    parsed.some((block) => typeof block.kind === "string" && NON_USER_SOURCE_BLOCKS.has(block.kind))
  )
    return null;
  const text = textOf(parsed);
  return text.trim() ? text : null;
}

/** Ordinary assistant prose only: tool, page, helper and channel blocks carry no text here. */
function assistantText(blocks: unknown): string | null {
  const text = textOf(blocksOf(blocks));
  return text.trim() ? text : null;
}

function extractionMessage(
  row: ArchiveMessageRow,
  target: MemoryArchiveTarget,
  isNew: boolean,
): MemoryExtractionMessage | null {
  if (row.role === "user") {
    if (row.authorUserId !== target.userId) return null;
    const content = directUserText(row.blocks);
    return content
      ? {
          id: row.id,
          role: "user",
          content,
          createdAt: row.createdAt.toISOString(),
          isNew,
        }
      : null;
  }
  if (row.role === "bot") {
    if (row.botId !== target.botId) return null;
    const content = assistantText(row.blocks);
    return content
      ? {
          id: row.id,
          role: "assistant",
          content,
          createdAt: row.createdAt.toISOString(),
          isNew: false,
        }
      : null;
  }
  return null;
}

function provenanceValue(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Authority for the optional background archive of one direct personal chat. It schedules a
 * pointer after a completed user turn, reads the unscanned range, and commits extracted facts
 * and the cursor together. Postgres stores no transcript copy here.
 */
export class MemoryArchiveStore {
  private readonly facts: SemanticFactStore;

  constructor(private readonly prisma: PrismaClient) {
    this.facts = new SemanticFactStore(prisma);
  }

  private inTenant<T>(ctx: AdapterContext, fn: () => Promise<T>): Promise<T> {
    ctx.signal.throwIfAborted();
    return runAsTenant(ctx, fn);
  }

  private transaction<T>(ctx: AdapterContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    ctx.signal.throwIfAborted();
    return runAsTenant(ctx, () =>
      withTransactionRetry(() => this.prisma.$transaction(fn, THREAD_LOCK_TRANSACTION_OPTIONS)),
    );
  }

  private async requireDirectThread(
    db: ReadDb,
    target: MemoryArchiveTarget,
    ctx: AdapterContext,
  ): Promise<{
    nextMessageSeq: number;
    historyCompactionGeneration: number;
    scope: DurableMemoryScope;
  }> {
    if (target.userId !== ctx.userId) throw new IsolationError();
    if (ctx.botId && ctx.botId !== target.botId) throw new IsolationError();
    const [membership, bot, space, thread, config] = await Promise.all([
      db.spaceMember.findFirst({
        where: { spaceId: ctx.spaceId, userId: ctx.userId },
        select: { id: true },
      }),
      db.bot.findFirst({
        where: { id: target.botId, spaceId: ctx.spaceId },
        select: { memoryScope: true },
      }),
      db.space.findFirst({ where: { id: ctx.spaceId }, select: { deletingAt: true } }),
      db.thread.findFirst({
        where: { id: target.threadId, spaceId: ctx.spaceId },
        select: {
          botId: true,
          userId: true,
          helperBotId: true,
          groupId: true,
          externalConversationId: true,
          nextMessageSeq: true,
          historyCompactionGeneration: true,
        },
      }),
      db.spaceMemoryConfig.findUnique({
        where: { spaceId: ctx.spaceId },
        select: { defaultMemoryScope: true },
      }),
    ]);
    if (!membership || !bot || !space || space.deletingAt || !thread) throw new IsolationError();
    if (
      thread.botId !== target.botId ||
      thread.userId !== target.userId ||
      thread.helperBotId ||
      thread.groupId ||
      thread.externalConversationId
    )
      throw new IsolationError();
    return {
      nextMessageSeq: thread.nextMessageSeq,
      historyCompactionGeneration: thread.historyCompactionGeneration,
      scope: effectiveMemoryScope(bot.memoryScope, config?.defaultMemoryScope ?? "isolated"),
    };
  }

  /** Real direct user messages this run carries: its source plus steering claimed by it. */
  private async runSourceSeqs(
    tx: Tx,
    run: { id: string; threadId: string; botId: string; sourceMessageId: string | null },
    ctx: AdapterContext,
  ): Promise<number[]> {
    const rows = await tx.message.findMany({
      where: {
        threadId: run.threadId,
        OR: [
          ...(run.sourceMessageId ? [{ id: run.sourceMessageId }] : []),
          {
            steeringMessages: {
              some: { runId: run.id, botId: run.botId, userId: ctx.userId },
            },
          },
        ],
      },
      select: { seq: true, role: true, authorUserId: true, blocks: true },
    });
    return rows.flatMap((row) =>
      row.role === "user" && row.authorUserId === ctx.userId && directUserText(row.blocks) !== null
        ? [row.seq]
        : [],
    );
  }

  /**
   * Sources of the contiguous direct turns before this one that never completed. Scheduling
   * only follows a completed turn, so without a cursor these sources would be seeded past and
   * never archived. The walk ends at the first turn that completed or is still undecided.
   */
  private async skippedSourceSeqs(
    tx: Tx,
    run: { id: string; threadId: string; botId: string; createdAt: Date },
    ctx: AdapterContext,
  ): Promise<number[]> {
    const prior = await tx.run.findMany({
      where: {
        threadId: run.threadId,
        spaceId: ctx.spaceId,
        botId: run.botId,
        userId: ctx.userId,
        trigger: { in: [...DIRECT_RUN_TRIGGERS] },
        createdAt: { lt: run.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: PRIOR_FAILED_RUNS,
      select: { id: true, status: true, sourceMessageId: true },
    });
    const seqs: number[] = [];
    for (const row of prior) {
      if (row.status !== "failed" && row.status !== "cancelled") break;
      seqs.push(
        ...(await this.runSourceSeqs(
          tx,
          { ...row, threadId: run.threadId, botId: run.botId },
          ctx,
        )),
      );
    }
    return seqs;
  }

  /**
   * Schedule one completed trusted personal turn. The cursor seeds just before this run's
   * earliest real user source, so the first schedule never imports the older conversation.
   */
  async markPending(runId: string, ctx: AdapterContext, availableAt: Date): Promise<boolean> {
    if (!Number.isFinite(availableAt.getTime()))
      throw new Error("Automatic memory requires a valid debounce time.");
    return this.transaction(ctx, async (tx) => {
      const run = await tx.run.findFirst({
        where: { id: runId, spaceId: ctx.spaceId, userId: ctx.userId },
        select: {
          id: true,
          botId: true,
          threadId: true,
          status: true,
          trigger: true,
          sourceMessageId: true,
          createdAt: true,
        },
      });
      if (!run) return false;
      if (ctx.botId && ctx.botId !== run.botId) throw new IsolationError();
      if (run.status !== "completed" || !DIRECT_RUN_TRIGGERS.has(run.trigger)) return false;
      // Serialize with message writers and clear so the seed and bound use one consistent head.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} AND "spaceId" = ${ctx.spaceId} FOR UPDATE`;
      // Group and channel turns complete here too; they have no personal archive and this
      // is an ordinary no-op rather than an isolation failure.
      const thread = await tx.thread.findFirst({
        where: { id: run.threadId, spaceId: ctx.spaceId },
        select: { helperBotId: true, groupId: true, externalConversationId: true },
      });
      if (thread && (thread.helperBotId || thread.groupId || thread.externalConversationId))
        return false;
      const target = { threadId: run.threadId, botId: run.botId, userId: ctx.userId };
      const authorized = await this.requireDirectThread(tx, target, ctx);
      const seqs = await this.runSourceSeqs(tx, run, ctx);
      if (!seqs.length) return false;
      const generation = authorized.historyCompactionGeneration;
      const throughSeq = authorized.nextMessageSeq - 1;
      const existing = await tx.memoryArchiveProgress.findUnique({
        where: { threadId: run.threadId },
      });
      const bound = {
        spaceId: ctx.spaceId,
        botId: run.botId,
        userId: ctx.userId,
        scope: authorized.scope,
        generation,
        availableAt,
        pending: true,
      };
      if (!existing || existing.generation !== generation) {
        // A thread whose first direct turn failed has no cursor yet; seeding at this run alone
        // would step over that turn forever, so reach back over the uncompleted ones.
        const skipped = await this.skippedSourceSeqs(tx, run, ctx);
        // A clear retired the old range; seed from this run instead of reviving its messages.
        await tx.memoryArchiveProgress.upsert({
          where: { threadId: run.threadId },
          create: {
            threadId: run.threadId,
            ...bound,
            processedUpToSeq: Math.min(...seqs, ...skipped) - 1,
            throughSeq,
          },
          update: {
            ...bound,
            processedUpToSeq: Math.min(...seqs, ...skipped) - 1,
            throughSeq,
          },
        });
      } else {
        await tx.memoryArchiveProgress.update({
          where: { threadId: run.threadId },
          data: { ...bound, throughSeq: Math.max(existing.throughSeq, throughSeq) },
        });
      }
      return true;
    });
  }

  /**
   * Pin the live source head before a clear. An activated cursor is only extended; otherwise the
   * cursor starts just before the latest persisted direct user source, never at old history.
   */
  async prepareClear(
    input: MemoryArchiveTarget,
    ctx: AdapterContext,
  ): Promise<{ generation: number; nextMessageSeq: number }> {
    return this.transaction(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${ctx.spaceId} FOR UPDATE`;
      const authorized = await this.requireDirectThread(tx, input, ctx);
      const generation = authorized.historyCompactionGeneration;
      const nextMessageSeq = authorized.nextMessageSeq;
      const throughSeq = nextMessageSeq - 1;
      const availableAt = new Date();
      const existing = await tx.memoryArchiveProgress.findUnique({
        where: { threadId: input.threadId },
      });
      if (
        existing &&
        existing.spaceId === ctx.spaceId &&
        existing.botId === input.botId &&
        existing.userId === input.userId &&
        existing.scope === authorized.scope &&
        existing.generation === generation
      ) {
        // An activated cursor already owes its own range; extend it to the pinned head.
        await tx.memoryArchiveProgress.update({
          where: { threadId: input.threadId },
          data: {
            throughSeq,
            pending: existing.processedUpToSeq < throughSeq,
            availableAt,
          },
        });
        return { generation, nextMessageSeq };
      }
      const seedSeq = await this.latestDirectSourceSeq(tx, input, ctx.spaceId, throughSeq);
      if (seedSeq === null) return { generation, nextMessageSeq };
      const data = {
        spaceId: ctx.spaceId,
        botId: input.botId,
        userId: input.userId,
        scope: authorized.scope,
        generation,
        processedUpToSeq: seedSeq - 1,
        throughSeq,
        pending: seedSeq - 1 < throughSeq,
        availableAt,
      };
      await tx.memoryArchiveProgress.upsert({
        where: { threadId: input.threadId },
        create: { threadId: input.threadId, ...data },
        update: data,
      });
      return { generation, nextMessageSeq };
    });
  }

  /**
   * The latest run's own persisted direct source. Steering rows may already be gone after a stop,
   * but seeding before the run source still covers the run's later persisted user text.
   */
  private async latestDirectSourceSeq(
    tx: Tx,
    target: MemoryArchiveTarget,
    spaceId: string,
    throughSeq: number,
  ): Promise<number | null> {
    const runs = await tx.run.findMany({
      where: {
        threadId: target.threadId,
        spaceId,
        botId: target.botId,
        userId: target.userId,
        trigger: { in: [...DIRECT_RUN_TRIGGERS] },
        sourceMessageId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: CLEAR_SOURCE_RUNS,
      select: { id: true, sourceMessageId: true },
    });
    const sourceIds = runs.flatMap((run) => (run.sourceMessageId ? [run.sourceMessageId] : []));
    if (!sourceIds.length) return null;
    const rows = await tx.message.findMany({
      where: { threadId: target.threadId, id: { in: sourceIds }, seq: { lte: throughSeq } },
      select: { id: true, seq: true, role: true, authorUserId: true, blocks: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    for (const run of runs) {
      const row = run.sourceMessageId ? byId.get(run.sourceMessageId) : undefined;
      if (!row) continue;
      if (row.role !== "user" || row.authorUserId !== target.userId) continue;
      if (directUserText(row.blocks) === null) continue;
      return row.seq;
    }
    return null;
  }

  /**
   * The next eligible range: real messages after the committed cursor up to the scheduled
   * bound, with at most eight preceding messages as context. Null when nothing is scheduled.
   */
  async loadBatch(
    input: MemoryArchiveTarget & { limit?: number },
    ctx: AdapterContext,
  ): Promise<MemoryArchiveBatch | null> {
    const limit = input.limit ?? DEFAULT_BATCH_MESSAGES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_MESSAGES)
      throw new Error("Invalid memory archive batch size.");
    return this.inTenant(ctx, async () => {
      const authorized = await this.requireDirectThread(this.prisma, input, ctx);
      const progress = await this.prisma.memoryArchiveProgress.findUnique({
        where: { threadId: input.threadId },
      });
      if (
        !progress ||
        progress.spaceId !== ctx.spaceId ||
        progress.botId !== input.botId ||
        progress.userId !== input.userId
      )
        return null;
      if (progress.generation !== authorized.historyCompactionGeneration) return null;
      if (!progress.pending || progress.processedUpToSeq >= progress.throughSeq) return null;
      const fromSeq = progress.processedUpToSeq + 1;
      const [contextRows, rangeRows] = await Promise.all([
        this.prisma.message.findMany({
          where: { threadId: input.threadId, seq: { lt: fromSeq } },
          orderBy: { seq: "desc" },
          take: CONTEXT_MESSAGES,
          select: MESSAGE_SELECT,
        }),
        this.prisma.message.findMany({
          where: {
            threadId: input.threadId,
            seq: { gte: fromSeq, lte: progress.throughSeq },
          },
          orderBy: { seq: "asc" },
          take: limit,
          select: MESSAGE_SELECT,
        }),
      ]);
      // A batch has to fit one extraction request: a long paste otherwise makes the same
      // range fail forever, and it would ride along in the context of every later batch too.
      const context: MemoryExtractionMessage[] = [];
      let contextBytes = 0;
      // Newest first: the turns closest to the batch are the ones worth the remaining budget.
      for (const row of contextRows) {
        const message = extractionMessage(row, input, false);
        if (!message) continue;
        const bytes = Buffer.byteLength(message.content);
        if (contextBytes + bytes > MAX_CONTEXT_TEXT_BYTES) break;
        contextBytes += bytes;
        context.push(message);
      }
      context.reverse();
      const fresh: MemoryExtractionMessage[] = [];
      const newSources: MemoryArchiveBatch["newSources"] = [];
      let batchThroughSeq = progress.throughSeq;
      let rangeBytes = 0;
      for (const row of rangeRows) {
        const message = extractionMessage(row, input, true);
        const text =
          row.role === "user" && row.authorUserId === input.userId
            ? directUserText(row.blocks)
            : null;
        const bytes = Buffer.byteLength(message?.content ?? text ?? "");
        if (bytes > MAX_BATCH_TEXT_BYTES) {
          batchThroughSeq = row.seq;
          continue;
        }
        if (fresh.length > 0 && rangeBytes + bytes > MAX_BATCH_TEXT_BYTES) break;
        rangeBytes += bytes;
        if (message) fresh.push(message);
        if (text !== null) {
          newSources.push({ id: row.id, text, createdAt: row.createdAt.toISOString() });
        }
        batchThroughSeq = row.seq;
      }
      const scope: DurableMemoryScope = progress.scope === "shared" ? "shared" : "isolated";
      const namespace = semanticFactNamespace(ctx.spaceId, scope, input.botId);
      // Forgotten facts carry the hard "never recreate this" instruction, so they take the
      // evidence slots before this thread's own retired history fills the rest.
      const [forgotten, historical] = await Promise.all([
        this.prisma.semanticFact.findMany({
          where: { spaceId: ctx.spaceId, namespace, status: "forgotten" },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          take: RETIREMENT_EVIDENCE_LIMIT,
          select: { id: true, revision: true, content: true, status: true, provenance: true },
        }),
        this.prisma.semanticFact.findMany({
          where: {
            spaceId: ctx.spaceId,
            namespace,
            status: "historical",
            sourceThreadId: input.threadId,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          take: RETIREMENT_EVIDENCE_LIMIT,
          select: { id: true, revision: true, content: true, status: true, provenance: true },
        }),
      ]);
      const evidence = [...forgotten, ...historical].slice(0, RETIREMENT_EVIDENCE_LIMIT);
      const retirementEvidence: MemoryExtractionExisting[] = evidence.flatMap(
        (row): MemoryExtractionExisting[] => {
          if (row.status === "forgotten") {
            return [
              {
                id: row.id,
                revision: row.revision,
                content: row.content,
                status: "forgotten" as const,
              },
            ];
          }
          const provenance = provenanceValue(row.provenance);
          if (row.status !== "historical") return [];
          const category = provenance.category;
          const quote = typeof provenance.quote === "string" ? provenance.quote : undefined;
          return [
            {
              id: row.id,
              revision: row.revision,
              content: row.content,
              status: "historical",
              ...(typeof provenance.messageId === "string"
                ? { sourceMessageId: provenance.messageId }
                : {}),
              ...(quote === undefined ? {} : { sourceQuote: quote }),
              ...(category === "preference" ||
              category === "project" ||
              category === "experience" ||
              category === "reference"
                ? { category }
                : {}),
            },
          ];
        },
      );
      return {
        threadId: input.threadId,
        botId: input.botId,
        userId: input.userId,
        spaceId: ctx.spaceId,
        scope,
        generation: progress.generation,
        fromSeq,
        // Never advance past a row this page did not return: a full page leaves the rest due.
        throughSeq: batchThroughSeq,
        messages: [...context, ...fresh],
        newSources,
        retirementEvidence,
      };
    });
  }

  /** Live direct source messages for the changes, bound to a real run only when one exists. */
  private async verifiedSources(
    tx: Tx,
    batch: MemoryArchiveBatch,
    changes: readonly MemoryExtractionChange[],
    processedUpToSeq: number,
    throughSeq: number,
  ): Promise<Map<string, SemanticArchiveSource>> {
    const ids = [
      ...new Set(
        changes.flatMap((change) =>
          typeof change.sourceMessageId === "string" ? [change.sourceMessageId] : [],
        ),
      ),
    ];
    const sources = new Map<string, SemanticArchiveSource>();
    if (!ids.length) return sources;
    const rows = await tx.message.findMany({
      where: { id: { in: ids }, threadId: batch.threadId },
      select: { ...MESSAGE_SELECT, runId: true },
    });
    const runIds = rows.flatMap((row) => (row.runId ? [row.runId] : []));
    const runs =
      ids.length || runIds.length
        ? await tx.run.findMany({
            where: {
              spaceId: batch.spaceId,
              botId: batch.botId,
              userId: batch.userId,
              OR: [
                { sourceMessageId: { in: ids } },
                ...(runIds.length ? [{ id: { in: runIds } }] : []),
              ],
            },
            select: { id: true, sourceMessageId: true },
          })
        : [];
    const runBySource = new Map<string, string>();
    for (const run of runs) if (run.sourceMessageId) runBySource.set(run.sourceMessageId, run.id);
    const realRunIds = new Set(runs.map((run) => run.id));
    for (const row of rows) {
      if (row.role !== "user" || row.authorUserId !== batch.userId) continue;
      const text = directUserText(row.blocks);
      if (!text) continue;
      if (row.seq <= processedUpToSeq || row.seq > throughSeq) continue;
      const runId = row.runId && realRunIds.has(row.runId) ? row.runId : runBySource.get(row.id);
      sources.set(row.id, {
        messageId: row.id,
        threadId: batch.threadId,
        text,
        observedAt: row.createdAt,
        ...(runId ? { runId } : {}),
      });
    }
    return sources;
  }

  /**
   * Apply extracted changes and commit the cursor in one transaction under the thread row and
   * progress lock. A batch from another generation, or one already applied, writes nothing.
   */
  async applyBatch(
    batch: MemoryArchiveBatch,
    changes: readonly MemoryExtractionChange[],
    ctx: AdapterContext,
  ): Promise<MemoryArchiveApplyCounts> {
    if (ctx.spaceId !== batch.spaceId) throw new IsolationError();
    if (ctx.userId !== batch.userId) throw new IsolationError();
    if (ctx.botId && ctx.botId !== batch.botId) throw new IsolationError();
    if (!Array.isArray(changes)) throw new Error("Memory archive changes must be an array.");
    const skippedAll = { saved: 0, updated: 0, skipped: changes.length, removed: 0 };
    return this.transaction(ctx, async (tx) => {
      // Same row lock every message writer and clearThread uses; a clear strictly orders here.
      await tx.$queryRaw`SELECT id FROM threads
        WHERE id = ${batch.threadId} AND "spaceId" = ${ctx.spaceId} FOR SHARE`;
      const authorized = await this.requireDirectThread(tx, batch, ctx);
      if (authorized.historyCompactionGeneration !== batch.generation) return skippedAll;
      await tx.$queryRaw`SELECT "threadId" FROM memory_archive_progress
        WHERE "threadId" = ${batch.threadId} FOR UPDATE`;
      const progress = await tx.memoryArchiveProgress.findUnique({
        where: { threadId: batch.threadId },
      });
      if (!progress) return skippedAll;
      if (
        progress.spaceId !== ctx.spaceId ||
        progress.botId !== batch.botId ||
        progress.userId !== batch.userId ||
        progress.scope !== batch.scope
      )
        throw new IsolationError();
      if (progress.generation !== batch.generation) return skippedAll;
      // The persisted schedule bounds the range; a batch body cannot extend it.
      const throughSeq = Math.min(batch.throughSeq, progress.throughSeq);
      if (progress.processedUpToSeq >= throughSeq) return skippedAll;
      const sources = await this.verifiedSources(
        tx,
        batch,
        changes,
        progress.processedUpToSeq,
        throughSeq,
      );
      const counts = await this.facts.applyArchiveChanges(
        tx,
        {
          botId: batch.botId,
          scope: batch.scope,
          threadId: batch.threadId,
          sources,
          changes,
        },
        ctx,
      );
      // Outbox rows and the checkpoint commit together even when nothing was extracted.
      const processedUpToSeq = Math.max(progress.processedUpToSeq, throughSeq);
      await tx.memoryArchiveProgress.update({
        where: { threadId: batch.threadId },
        data: {
          processedUpToSeq,
          pending: processedUpToSeq < progress.throughSeq,
        },
      });
      return counts;
    });
  }

  /**
   * Stop automatic extraction retries for this thread after a failed range. The cursor and
   * the unprocessed messages stay; the next completed turn re-arms the pointer, and a clear
   * is allowed to proceed instead of failing on a range that cannot be extracted.
   */
  async pause(input: MemoryArchiveTarget, ctx: AdapterContext): Promise<void> {
    if (input.userId !== ctx.userId) throw new IsolationError();
    if (ctx.botId && ctx.botId !== input.botId) throw new IsolationError();
    await this.inTenant(ctx, () =>
      this.prisma.memoryArchiveProgress.updateMany({
        where: {
          threadId: input.threadId,
          spaceId: ctx.spaceId,
          botId: input.botId,
          userId: input.userId,
          pending: true,
        },
        data: { pending: false },
      }),
    );
  }

  /** Pointer-only backlog for the reconciler, across spaces, without transcript text. */
  async pending(limit = 100): Promise<MemoryArchivePointer[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_POINTERS)
      throw new Error("Invalid automatic-memory backlog limit.");
    return runAsSystem(
      "list scheduled automatic-memory archives",
      () =>
        this.prisma.$queryRaw<MemoryArchivePointer[]>`
        SELECT p."threadId", p."botId", p."userId", p."spaceId", p."availableAt"
        FROM memory_archive_progress AS p
        JOIN threads AS t ON t."id" = p."threadId" AND t."spaceId" = p."spaceId"
        WHERE p."pending" = TRUE
          AND p."processedUpToSeq" < p."throughSeq"
          AND p."generation" = t."historyCompactionGeneration"
        ORDER BY p."availableAt" ASC, p."threadId" ASC
        LIMIT ${limit}`,
    );
  }

  /** Whether clear still owes this chat an archive of already scheduled source messages. */
  async hasPending(input: MemoryArchiveTarget, ctx: AdapterContext): Promise<boolean> {
    return this.inTenant(ctx, async () => {
      if (input.userId !== ctx.userId) throw new IsolationError();
      if (ctx.botId && ctx.botId !== input.botId) throw new IsolationError();
      const [progress, thread] = await Promise.all([
        this.prisma.memoryArchiveProgress.findUnique({
          where: { threadId: input.threadId },
        }),
        this.prisma.thread.findFirst({
          where: { id: input.threadId, spaceId: ctx.spaceId },
          select: {
            botId: true,
            userId: true,
            helperBotId: true,
            groupId: true,
            externalConversationId: true,
            historyCompactionGeneration: true,
          },
        }),
      ]);
      if (!progress) return false;
      if (!thread || thread.botId !== input.botId || thread.userId !== input.userId)
        throw new IsolationError();
      if (
        progress.spaceId !== ctx.spaceId ||
        progress.botId !== input.botId ||
        progress.userId !== input.userId
      )
        throw new IsolationError();
      if (thread.helperBotId || thread.groupId || thread.externalConversationId) return false;
      return (
        progress.pending &&
        progress.processedUpToSeq < progress.throughSeq &&
        progress.generation === thread.historyCompactionGeneration
      );
    });
  }
}
