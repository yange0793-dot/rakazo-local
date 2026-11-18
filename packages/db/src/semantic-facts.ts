import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  MemoryExtractionChange,
  SemanticMemoryForgetRequest,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type {
  SemanticFact,
  SemanticFactCorrectRequest,
  SemanticFactListRequest,
  SemanticFactPage,
} from "@rakazo/contracts";
import { SemanticFactProvenanceSchema } from "@rakazo/contracts";
import { sanitizeUtf16ForJson, withAbort } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { ContentEncryption } from "./content-encryption.js";
import { contentEncryptionOf } from "./content-encryption.js";
import type {
  SemanticFact as FactRecord,
  SemanticMemoryIndexOutbox as IndexRecord,
  Prisma,
  PrismaClient,
} from "./generated/prisma/client.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

export interface SemanticFactImportInput {
  botId: string;
  scope: DurableMemoryScope;
  /** Privileged importer identity, not a model-authored source path. */
  sourceKey: string;
  content: string;
  kind: "durable" | "history";
  provenance: SemanticFact["provenance"];
  status: SemanticFact["status"];
  createdAt: string;
  updatedAt: string;
  generation?: number;
}

export interface SemanticIndexWork {
  id: string;
  spaceId: string;
  userId: string;
  namespace: string;
  indexId: string;
  factId: string;
  revision: number;
  action: "upsert" | "delete";
  content: string | null;
}

/** A host-written lesson; no model tool can produce one, so only the reflection job calls this. */
export interface LessonWriteInput {
  botId: string;
  /** The situation that should bring this lesson to mind (1-200 characters). */
  cue: string;
  /** What to do or avoid (1-600 characters). */
  lesson: string;
  /** A run of this bot authored the lesson; the store re-checks that run before writing. */
  provenance: Provenance & { runId: string; harness: NonNullable<Provenance["harness"]> };
  /** An existing lesson this one refines, with the revision the reviewer observed. */
  replaces?: { id: string; expectedRevision: number };
}

/**
 * A live user message the archive host re-read in the transaction that applies a batch. The
 * extraction proposal may name it, but only this host-read text authorizes a write.
 */
export interface SemanticArchiveSource {
  messageId: string;
  threadId: string;
  /** Current text of the message; the proposed quote must occur in it verbatim. */
  text: string;
  /** The message's own creation time, never the extraction time. */
  observedAt: Date;
  /** Bound by the host only when a real run for this message still exists. */
  runId?: string;
}

export interface SemanticArchiveApplyInput {
  botId: string;
  scope: DurableMemoryScope;
  threadId: string;
  /** Live direct user messages by id; the only sources a batch may write from. */
  sources: ReadonlyMap<string, SemanticArchiveSource>;
  changes: readonly MemoryExtractionChange[];
}

const ARCHIVE_CATEGORIES: ReadonlySet<string> = new Set([
  "preference",
  "project",
  "experience",
  "reference",
]);

/** Bulk retirement tombstones every fact in a scope; Prisma's 5s default expires mid-run. */
const BULK_RETIRE_TRANSACTION_OPTIONS = { timeout: 120_000 };

/** Forgetting keeps the tombstone and its source fingerprints, never the body. */
const FORGOTTEN_CONTENT = "[forgotten]";

const DURABLE_SCOPES: readonly DurableMemoryScope[] = ["isolated", "shared"];

type Tx = Prisma.TransactionClient;
type ReadDb = Pick<
  PrismaClient,
  "space" | "spaceMember" | "bot" | "thread" | "run" | "message" | "chatGroupMember"
>;
type Provenance = SemanticFact["provenance"];
type Source = {
  provenance: Provenance;
  identity: unknown[];
  threadId?: string;
  generation?: number;
};

/** A shared namespace is just that space; it never also searches the bot namespace. */
export function semanticFactNamespace(
  spaceId: string,
  scope: DurableMemoryScope,
  botId: string,
): string {
  if (!spaceId || !botId || (scope !== "isolated" && scope !== "shared"))
    throw new Error("Semantic memory requires an explicit space, bot, and scope.");
  return `sm1:${Buffer.from(JSON.stringify([spaceId, scope, scope === "isolated" ? botId : null])).toString("base64url")}`;
}

/** Host-written lessons get their own per-bot namespace, so ordinary recall never sees them. */
export function lessonFactNamespace(spaceId: string, botId: string): string {
  if (!spaceId || !botId) throw new Error("A lesson requires an explicit space and bot.");
  return `hl1:${Buffer.from(JSON.stringify([spaceId, botId])).toString("base64url")}`;
}

function indexId(factId: string, revision: number): string {
  return `sm:${factId}:${revision}`;
}

function outboxId(factId: string, revision: number, action: "upsert" | "delete"): string {
  return `sm-${action}:${factId}:${revision}`;
}

function contentValue(value: string): string {
  const content = sanitizeUtf16ForJson(value);
  if (!content.trim() || content.length > 20_000 || Buffer.byteLength(content, "utf8") > 40 * 1024)
    throw new Error(
      "Memory fact content must contain 1 to 20000 characters and fit within 40 KiB.",
    );
  return content;
}

/** Case, character width, spacing and punctuation variants of one assertion compare equal. */
function dedupeContent(content: string): string {
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\p{P}]+/gu, "")
    .trim();
}

function positiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("An expected memory revision is required.");
}

function historyGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("A non-negative history generation is required.");
}

function dateValue(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Memory timestamps must be valid dates.");
  return date;
}

function validity(provenance: Provenance): { validFrom: Date | null; validTo: Date | null } {
  const validFrom = provenance.validFrom ? dateValue(provenance.validFrom) : null;
  const validTo = provenance.validTo ? dateValue(provenance.validTo) : null;
  if (validFrom && validTo && validTo < validFrom)
    throw new Error("A memory fact cannot end before it starts.");
  return { validFrom, validTo };
}

function activeAt(row: FactRecord, now: Date): boolean {
  return (
    row.status === "active" &&
    (!row.validFrom || row.validFrom <= now) &&
    (!row.validTo || row.validTo > now)
  );
}

function factValue(row: FactRecord): SemanticFact {
  return {
    id: row.id,
    botId: row.botId,
    scope: row.scope as DurableMemoryScope,
    kind: row.kind as SemanticFact["kind"],
    content: row.content,
    revision: row.revision,
    status: row.status as SemanticFact["status"],
    provenance: SemanticFactProvenanceSchema.parse(JSON.parse(row.provenance)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cursorValue(
  namespace: string,
  query: string,
  includeHistory: boolean,
  id: string,
): string {
  return Buffer.from(JSON.stringify([namespace, query, includeHistory, id])).toString("base64url");
}

function readCursor(
  value: string | undefined,
  namespace: string,
  query: string,
  includeHistory: boolean,
): string {
  if (!value) return "";
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid memory fact cursor.");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== namespace ||
    decoded[1] !== query ||
    decoded[2] !== includeHistory ||
    typeof decoded[3] !== "string" ||
    !decoded[3]
  )
    throw new Error("Memory fact cursor belongs to another listing.");
  return decoded[3];
}

/** Postgres owns memory state. The local index contributes ids and scores only. */
export class SemanticFactStore {
  constructor(private readonly prisma: PrismaClient) {}

  private encryption(): ContentEncryption {
    const encryption = contentEncryptionOf(this.prisma);
    if (!encryption?.ring.encryptWrites)
      throw new Error("Managed memory requires an encrypted database client.");
    return encryption;
  }

  private async sourceKey(spaceId: string, identity: unknown[]): Promise<string> {
    const ring = this.encryption().ring;
    await ring.current(spaceId);
    // Data-key rotation retains earlier versions; keep exact identities stable across rotations.
    const first = (await ring.all(spaceId))[0]!;
    return createHmac("sha256", first.key)
      .update("rakazo/semantic-source/v1\0")
      .update(JSON.stringify(identity))
      .digest("hex");
  }

  private inTenant<T>(ctx: AdapterContext, fn: () => Promise<T>): Promise<T> {
    ctx.signal.throwIfAborted();
    return runAsTenant(ctx, fn);
  }

  private transaction<T>(
    ctx: AdapterContext,
    fn: (tx: Tx) => Promise<T>,
    options?: { timeout?: number },
  ): Promise<T> {
    return this.inTenant(ctx, () =>
      withTransactionRetry(() => this.prisma.$transaction(fn, options)),
    );
  }

  /**
   * A recall citation names one of the two namespaces this bot may read; management acts on
   * exactly that namespace instead of the caller's default scope.
   */
  private citationNamespace(
    request: { botId: string; entity: string },
    ctx: AdapterContext,
  ): string {
    for (const scope of DURABLE_SCOPES) {
      const namespace = semanticFactNamespace(ctx.spaceId, scope, request.botId);
      if (namespace === request.entity) return namespace;
    }
    throw new IsolationError();
  }

  /** Lessons live in their own per-bot namespace; every management path picks it this way. */
  private scopeNamespace(
    request: { botId: string; scope: DurableMemoryScope; kind?: SemanticFact["kind"] },
    ctx: AdapterContext,
  ): string {
    return request.kind === "lesson"
      ? lessonFactNamespace(ctx.spaceId, request.botId)
      : semanticFactNamespace(ctx.spaceId, request.scope, request.botId);
  }

  private async requireScope(
    db: ReadDb,
    botId: string,
    ctx: AdapterContext,
    allowDeleting = false,
  ): Promise<{ userId: string }> {
    if (ctx.botId && ctx.botId !== botId) throw new IsolationError();
    const [membership, bot, space] = await Promise.all([
      db.spaceMember.findFirst({
        where: { spaceId: ctx.spaceId, userId: ctx.userId },
        select: { id: true },
      }),
      db.bot.findFirst({ where: { id: botId, spaceId: ctx.spaceId }, select: { userId: true } }),
      db.space.findFirst({ where: { id: ctx.spaceId }, select: { deletingAt: true } }),
    ]);
    if (!membership || !bot || !space || (!allowDeleting && space.deletingAt))
      throw new IsolationError();
    return bot;
  }

  /** Authorize before a query is sent to the optional index, without decrypting any facts. */
  async authorizeScope(
    request: { botId: string; scope: DurableMemoryScope },
    ctx: AdapterContext,
  ): Promise<void> {
    semanticFactNamespace(ctx.spaceId, request.scope, request.botId);
    return this.inTenant(ctx, async () => {
      await this.requireScope(this.prisma, request.botId, ctx);
    });
  }

  private async lockSpace(tx: Tx, spaceId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${spaceId}, 0))::text AS lock`;
  }

  private async lockNamespace(tx: Tx, namespace: string, exclusive = false): Promise<void> {
    const key = `semantic-facts:${namespace}`;
    if (exclusive)
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock`;
    else
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text AS lock`;
  }

  private async lockSource(tx: Tx, namespace: string, sourceKey: string): Promise<void> {
    const key = `semantic-source:${namespace}:${sourceKey}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock`;
  }

  private async lockFact(tx: Tx, id: string, namespace: string): Promise<FactRecord> {
    await tx.$queryRaw`SELECT id FROM semantic_facts WHERE id = ${id} AND namespace = ${namespace} FOR UPDATE`;
    const row = await tx.semanticFact.findFirst({ where: { id, namespace } });
    if (!row) throw new IsolationError();
    return row;
  }

  private async requireThread(
    db: ReadDb,
    botId: string,
    threadId: string,
    ctx: AdapterContext,
  ): Promise<{ historyCompactionGeneration: number }> {
    const thread = await db.thread.findFirst({
      where: { id: threadId, spaceId: ctx.spaceId, helperBotId: null },
      select: {
        botId: true,
        groupId: true,
        externalConversationId: true,
        historyCompactionGeneration: true,
      },
    });
    if (!thread || thread.externalConversationId) throw new IsolationError();
    if (thread.botId !== botId) {
      if (
        !thread.groupId ||
        !(await db.chatGroupMember.findFirst({
          where: { groupId: thread.groupId, botId },
          select: { botId: true },
        }))
      )
        throw new IsolationError();
    }
    return thread;
  }

  private async sourceFor(
    tx: Tx,
    request: SemanticMemorySaveRequest,
    ctx: AdapterContext,
  ): Promise<Source> {
    const source = request.source;
    const runId = source.runId ?? ctx.runId;
    if (ctx.runId && source.runId && ctx.runId !== source.runId) throw new IsolationError();
    if (source.kind === "history") {
      if (!source.threadId) throw new Error("History memory must name its real thread.");
      historyGeneration(source.generation);
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} AND "spaceId" = ${ctx.spaceId} FOR SHARE`;
      const thread = await this.requireThread(tx, request.botId, source.threadId, ctx);
      if (thread.historyCompactionGeneration !== source.generation)
        throw new Error("This history generation has been retired.");
      return {
        provenance: {
          kind: "history",
          threadId: source.threadId,
          observedAt: new Date().toISOString(),
        },
        identity: ["history", request.botId, source.threadId, source.generation],
        threadId: source.threadId,
        generation: source.generation,
      };
    }
    if (!runId) {
      if (source.threadId || source.messageId || source.quote)
        throw new Error("Source identifiers require a real run.");
      return {
        provenance: { kind: "manual", observedAt: new Date().toISOString() },
        identity: ["manual", ctx.userId, ctx.operationId],
      };
    }
    const run = await tx.run.findFirst({
      where: { id: runId, spaceId: ctx.spaceId, botId: request.botId, userId: ctx.userId },
      select: { threadId: true, sourceMessageId: true, trigger: true, status: true },
    });
    if (
      !run ||
      !["user", "follow_up", "routine"].includes(run.trigger) ||
      run.status === "cancelled"
    )
      throw new IsolationError();
    if (source.threadId && source.threadId !== run.threadId) throw new IsolationError();
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} AND "spaceId" = ${ctx.spaceId} FOR SHARE`;
    await this.requireThread(tx, request.botId, run.threadId, ctx);
    if (run.trigger === "routine") {
      if (source.messageId || source.quote !== undefined)
        throw new Error("A routine cannot claim a user source quote.");
      return {
        provenance: {
          kind: "run",
          runId,
          threadId: run.threadId,
          observedAt: new Date().toISOString(),
        },
        identity: ["run", runId, run.threadId],
        threadId: run.threadId,
      };
    }
    if (!run.sourceMessageId || (source.messageId && source.messageId !== run.sourceMessageId))
      throw new IsolationError();
    const message = await tx.message.findFirst({
      where: { id: run.sourceMessageId, threadId: run.threadId, role: "user" },
      select: { blocks: true, authorUserId: true },
    });
    if (!message || message.authorUserId !== ctx.userId) throw new IsolationError();
    const blocks = message.blocks;
    if (
      !Array.isArray(blocks) ||
      blocks.some(
        (block) =>
          block &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          ["channel_message", "bot_message_received", "bot_message_sent", "handoff"].includes(
            String(block.kind),
          ),
      )
    )
      throw new IsolationError();
    const text = blocks
      .flatMap((block) =>
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        block.kind === "text" &&
        typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n");
    if (source.quote !== undefined && (!source.quote.trim() || !text.includes(source.quote)))
      throw new Error("Memory source quote does not match the actual user message.");
    return {
      // A real source quote attributes a model-derived assertion; it does not verify the assertion.
      provenance: {
        kind: "run",
        runId,
        threadId: run.threadId,
        messageId: run.sourceMessageId,
        ...(source.quote !== undefined ? { quote: source.quote } : {}),
        observedAt: new Date().toISOString(),
      },
      identity: ["run", runId, run.threadId, run.sourceMessageId],
      threadId: run.threadId,
    };
  }

  private async requireNotRetired(
    tx: Tx,
    namespace: string,
    botId: string,
    source?: Source,
  ): Promise<void> {
    const retired = await tx.semanticMemoryRetirement.findFirst({
      where: {
        namespace,
        OR: [
          { kind: "scope" },
          ...(source?.generation !== undefined
            ? [
                {
                  kind: "history",
                  botId,
                  generation: source.generation,
                  OR: [{ threadId: null }, { threadId: source.threadId }],
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (retired) throw new Error("This memory source or scope has been retired.");
  }

  private async rememberSource(tx: Tx, row: FactRecord, sourceKey: string): Promise<void> {
    await tx.semanticFactSource.create({
      data: { spaceId: row.spaceId, namespace: row.namespace, sourceKey, factId: row.id },
    });
  }

  private async boundSource(
    tx: Tx,
    namespace: string,
    sourceKey: string,
  ): Promise<FactRecord | null> {
    const source = await tx.semanticFactSource.findUnique({
      where: { namespace_sourceKey: { namespace, sourceKey } },
      include: { fact: true },
    });
    return source?.fact ?? null;
  }

  private async enqueueIndex(
    tx: Tx,
    row: FactRecord,
    revision: number,
    action: "upsert" | "delete",
  ): Promise<void> {
    const id = outboxId(row.id, revision, action);
    await tx.semanticMemoryIndexOutbox.upsert({
      where: { id },
      update: {},
      create: {
        id,
        spaceId: row.spaceId,
        userId: row.userId,
        namespace: row.namespace,
        indexId: indexId(row.id, revision),
        factId: row.id,
        revision,
        action,
      },
    });
  }

  private async snapshot(tx: Tx, row: FactRecord): Promise<void> {
    this.encryption();
    await tx.semanticFactRevision.create({
      data: {
        spaceId: row.spaceId,
        factId: row.id,
        revision: row.revision,
        content: row.content,
        provenance: row.provenance,
        status: row.status,
        validFrom: row.validFrom,
        validTo: row.validTo,
        createdAt: row.updatedAt,
      },
    });
  }

  private async insert(
    tx: Tx,
    input: {
      botId: string;
      scope: DurableMemoryScope;
      namespace: string;
      kind: SemanticFact["kind"];
      content: string;
      provenance: Provenance;
      status: SemanticFact["status"];
      source: Source;
      sourceKey: string;
      createdAt: Date;
      updatedAt: Date;
    },
    ctx: AdapterContext,
  ): Promise<SemanticFact> {
    const row = await tx.semanticFact.create({
      data: {
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        botId: input.botId,
        namespace: input.namespace,
        scope: input.scope,
        kind: input.kind,
        content: input.content,
        provenance: JSON.stringify(input.provenance),
        status: input.status,
        sourceThreadId: input.source.threadId ?? null,
        sourceGeneration: input.source.generation ?? null,
        ...validity(input.provenance),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
    });
    await this.rememberSource(tx, row, input.sourceKey);
    await this.snapshot(tx, row);
    await this.enqueueIndex(tx, row, row.revision, row.status === "active" ? "upsert" : "delete");
    return factValue(row);
  }

  private async replace(
    tx: Tx,
    row: FactRecord,
    content: string,
    provenance: Provenance,
    expectedRevision: number,
    sourceKey: string,
    source?: Source,
  ): Promise<SemanticFact> {
    if (row.revision !== expectedRevision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
    if (row.status !== "active")
      throw new Error("A retired or forgotten memory cannot be corrected.");
    provenance = {
      ...provenance,
      ...(row.validFrom ? { validFrom: row.validFrom.toISOString() } : {}),
      ...(row.validTo ? { validTo: row.validTo.toISOString() } : {}),
    };
    const updated = await tx.semanticFact.update({
      where: { id: row.id },
      data: {
        content,
        provenance: JSON.stringify(provenance),
        revision: { increment: 1 },
        ...(source
          ? { sourceThreadId: source.threadId ?? null, sourceGeneration: source.generation ?? null }
          : {}),
      },
    });
    await this.rememberSource(tx, updated, sourceKey);
    await this.snapshot(tx, updated);
    await this.enqueueIndex(tx, updated, row.revision, "delete");
    await this.enqueueIndex(tx, updated, updated.revision, "upsert");
    return factValue(updated);
  }

  async save(
    request: SemanticMemorySaveRequest & { entity?: string },
    ctx: AdapterContext,
  ): Promise<SemanticFact> {
    const content = contentValue(request.content);
    if (request.entity !== undefined && request.replacesId === undefined)
      throw new Error("A memory citation entity only selects the scope of a correction.");
    const namespace = request.entity
      ? this.citationNamespace({ botId: request.botId, entity: request.entity }, ctx)
      : semanticFactNamespace(ctx.spaceId, request.scope, request.botId);
    if ((request.replacesId === undefined) !== (request.expectedRevision === undefined))
      throw new Error("A correction requires both a fact id and its expected revision.");
    if (request.expectedRevision !== undefined) positiveRevision(request.expectedRevision);
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      await this.requireScope(tx, request.botId, ctx);
      await this.lockNamespace(tx, namespace);
      const source = await this.sourceFor(tx, request, ctx);
      await this.requireNotRetired(tx, namespace, request.botId, source);
      const sourceKey = await this.sourceKey(ctx.spaceId, [
        ...source.identity,
        content,
        ...(request.replacesId ? ["correction", request.replacesId, request.expectedRevision] : []),
      ]);
      await this.lockSource(tx, namespace, sourceKey);
      const bound = await this.boundSource(tx, namespace, sourceKey);
      if (bound) {
        if (!request.replacesId) return factValue(bound);
        if (
          bound.id === request.replacesId &&
          bound.revision === request.expectedRevision! + 1 &&
          bound.status === "active" &&
          bound.content === content
        )
          return factValue(bound);
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      if (request.replacesId) {
        const row = await this.lockFact(tx, request.replacesId, namespace);
        if (row.kind !== request.source.kind)
          throw new Error("A correction cannot change the memory source kind.");
        return this.replace(
          tx,
          row,
          content,
          source.provenance,
          request.expectedRevision!,
          sourceKey,
          source,
        );
      }
      const now = new Date();
      return this.insert(
        tx,
        {
          botId: request.botId,
          scope: request.scope,
          namespace,
          kind: request.source.kind,
          content,
          provenance: source.provenance,
          status: "active",
          source,
          sourceKey,
          createdAt: now,
          updatedAt: now,
        },
        ctx,
      );
    });
  }

  /**
   * Host-only lesson write. The reflection job calls this after checking a run; no model tool
   * reaches it, so a run cannot write its own note into later prompts.
   */
  async saveLesson(input: LessonWriteInput, ctx: AdapterContext): Promise<SemanticFact | null> {
    const cue = input.cue.trim();
    const lesson = input.lesson.trim();
    if (!cue || cue.length > 200 || !lesson || lesson.length > 600)
      throw new Error("A lesson needs a cue of 1-200 characters and a lesson of 1-600.");
    const content = contentValue(`cue: ${cue}\nlesson: ${lesson}`);
    const provenance = SemanticFactProvenanceSchema.parse(input.provenance);
    if (provenance.kind !== "run")
      throw new Error("A lesson must be attributed to the run that produced it.");
    if (input.replaces) positiveRevision(input.replaces.expectedRevision);
    const namespace = lessonFactNamespace(ctx.spaceId, input.botId);
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      await this.requireScope(tx, input.botId, ctx);
      // The lesson must cite a real run of this bot in this space. Space membership is already
      // required above, and a member may confirm a review card for a run someone else started.
      const run = await tx.run.findFirst({
        where: { id: input.provenance.runId, spaceId: ctx.spaceId, botId: input.botId },
        select: { id: true },
      });
      if (!run) throw new IsolationError();
      await this.lockNamespace(tx, namespace);
      await this.requireNotRetired(tx, namespace, input.botId);
      const sourceKey = await this.sourceKey(ctx.spaceId, [
        "lesson",
        input.provenance.runId,
        content,
      ]);
      const contentKey = await this.sourceKey(ctx.spaceId, ["lesson-content", content]);
      await this.lockSource(tx, namespace, sourceKey);
      await this.lockSource(tx, namespace, contentKey);
      // A replay of the same run, or the same wording from another run, keeps the first row.
      const bound = await this.boundSource(tx, namespace, sourceKey);
      if (bound) return factValue(bound);
      const sameContent = input.replaces ? null : await this.boundSource(tx, namespace, contentKey);
      if (sameContent) return factValue(sameContent);
      const source: Source = {
        provenance,
        identity: ["lesson", input.provenance.runId, content],
      };
      const now = new Date();
      if (!input.replaces) {
        const saved = await this.insert(
          tx,
          {
            botId: input.botId,
            scope: "isolated",
            namespace,
            kind: "lesson",
            content,
            provenance,
            status: "active",
            source,
            sourceKey,
            createdAt: now,
            updatedAt: now,
          },
          ctx,
        );
        await this.bindContent(tx, namespace, [contentKey], saved.id, ctx);
        return saved;
      }
      let target: FactRecord | null = null;
      try {
        target = await this.lockFact(tx, input.replaces.id, namespace);
      } catch (error) {
        if (!(error instanceof IsolationError)) throw error;
      }
      const dropped = !target
        ? "missing"
        : target.kind !== "lesson"
          ? "not_lesson"
          : target.status !== "active"
            ? "not_active"
            : target.revision !== input.replaces.expectedRevision
              ? "revision_changed"
              : null;
      if (!target || dropped) {
        // A stale replacement loses its own line; the reviewer still saves other lessons.
        getLogger().warn("lesson replacement skipped", {
          "lesson.id": input.replaces.id,
          "lesson.expected_revision": input.replaces.expectedRevision,
          "lesson.reason": dropped,
        });
        return null;
      }
      const updated = await this.replace(
        tx,
        target,
        content,
        provenance,
        input.replaces.expectedRevision,
        sourceKey,
        source,
      );
      await this.bindContent(tx, namespace, [contentKey], updated.id, ctx);
      return updated;
    });
  }

  async importFact(input: SemanticFactImportInput, ctx: AdapterContext): Promise<SemanticFact> {
    if (ctx.runId) throw new Error("Legacy import is not available to a model run.");
    if (!input.sourceKey.trim()) throw new Error("Import requires a stable legacy source key.");
    if (
      !["active", "historical", "forgotten"].includes(input.status) ||
      !["durable", "history"].includes(input.kind)
    )
      throw new Error("Import requires explicit kind and status.");
    // Historical bodies remain verbatim; an active fact must fit the index's accepted input.
    const content =
      input.status === "active" ? contentValue(input.content) : sanitizeUtf16ForJson(input.content);
    const provenance = SemanticFactProvenanceSchema.parse(input.provenance);
    const createdAt = dateValue(input.createdAt);
    const updatedAt = dateValue(input.updatedAt);
    if (updatedAt < createdAt) throw new Error("Memory update cannot precede its creation.");
    if (input.generation !== undefined) historyGeneration(input.generation);
    validity(provenance);
    const namespace = semanticFactNamespace(ctx.spaceId, input.scope, input.botId);
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      await this.requireScope(tx, input.botId, ctx);
      await this.lockNamespace(tx, namespace);
      const sourceKey = await this.sourceKey(ctx.spaceId, ["import", input.sourceKey]);
      const source: Source = {
        provenance,
        identity: ["import", input.sourceKey],
        threadId: provenance.threadId,
        ...(input.kind === "history" ? { generation: input.generation } : {}),
      };
      await this.requireNotRetired(tx, namespace, input.botId, source);
      await this.lockSource(tx, namespace, sourceKey);
      const bound = await this.boundSource(tx, namespace, sourceKey);
      // Never overwrite/promote a source already imported or subsequently corrected/forgotten.
      if (bound) return factValue(bound);
      return this.insert(
        tx,
        {
          ...input,
          content,
          provenance,
          namespace,
          source,
          sourceKey,
          createdAt,
          updatedAt,
        },
        ctx,
      );
    });
  }

  /**
   * Internal to MemoryArchiveStore: apply extractor proposals inside the caller's archive
   * transaction, after it locked the thread and re-read the real source messages. Nothing in a
   * proposal is permission: every source, quote, revision and retirement is checked here again.
   */
  async applyArchiveChanges(
    tx: Tx,
    input: SemanticArchiveApplyInput,
    ctx: AdapterContext,
  ): Promise<{ saved: number; updated: number; removed: number; skipped: number }> {
    this.encryption();
    const namespace = semanticFactNamespace(ctx.spaceId, input.scope, input.botId);
    const result = { saved: 0, updated: 0, removed: 0, skipped: 0 };
    const prepared: Array<{
      content: string;
      source: SemanticArchiveSource;
      quote: string;
      category: MemoryExtractionChange["category"];
      remove: boolean;
      sourceKey: string;
      contentKey?: string;
      normalizedKey?: string;
      replacesId?: string;
      expectedRevision?: number;
    }> = [];
    for (const change of input.changes) {
      if (!change || typeof change !== "object") {
        result.skipped += 1;
        continue;
      }
      const source = input.sources.get(change.sourceMessageId);
      const remove = change.remove === true;
      const paired = (change.replacesId === undefined) === (change.expectedRevision === undefined);
      const revision =
        change.expectedRevision === undefined ||
        (Number.isSafeInteger(change.expectedRevision) && change.expectedRevision > 0);
      if (
        !source ||
        source.threadId !== input.threadId ||
        ARCHIVE_CATEGORIES.has(change.category) === false ||
        typeof change.content !== "string" ||
        typeof change.sourceQuote !== "string" ||
        !change.sourceQuote.trim() ||
        !source.text.includes(change.sourceQuote) ||
        !paired ||
        !revision ||
        // A removal must name the exact fact it retires; content is not used for it.
        (remove && change.replacesId === undefined)
      ) {
        result.skipped += 1;
        continue;
      }
      let content = "";
      if (!remove) {
        try {
          content = contentValue(change.content);
        } catch {
          result.skipped += 1;
          continue;
        }
      }
      prepared.push({
        content,
        source,
        quote: change.sourceQuote,
        category: change.category,
        remove,
        sourceKey: await this.sourceKey(ctx.spaceId, [
          "auto",
          input.threadId,
          source.messageId,
          change.sourceQuote,
        ]),
        ...(remove
          ? {}
          : {
              contentKey: await this.sourceKey(ctx.spaceId, ["auto-content", content]),
              normalizedKey: await this.sourceKey(ctx.spaceId, [
                "auto-content",
                dedupeContent(content),
              ]),
            }),
        ...(change.replacesId !== undefined
          ? { replacesId: change.replacesId, expectedRevision: change.expectedRevision }
          : {}),
      });
    }
    if (!prepared.length) return result;
    await this.lockSpace(tx, ctx.spaceId);
    await this.lockNamespace(tx, namespace);
    const retired = await tx.semanticMemoryRetirement.findFirst({
      where: { namespace, kind: "scope" },
      select: { id: true },
    });
    if (retired) {
      result.skipped += prepared.length;
      return result;
    }
    // Stable lock order across transactions: every source key, then every corrected fact.
    for (const key of [
      ...new Set(
        prepared.flatMap((item) =>
          [item.sourceKey, item.contentKey, item.normalizedKey].filter(
            (key): key is string => key !== undefined,
          ),
        ),
      ),
    ].sort())
      await this.lockSource(tx, namespace, key);
    const replacements = new Map<string, FactRecord>();
    for (const id of [
      ...new Set(
        prepared.flatMap((item) => (item.replacesId === undefined ? [] : [item.replacesId])),
      ),
    ].sort()) {
      try {
        replacements.set(id, await this.lockFact(tx, id, namespace));
      } catch (error) {
        if (!(error instanceof IsolationError)) throw error;
      }
    }
    const corrected = new Set<string>();
    const now = new Date();
    for (const item of prepared) {
      // An exact source identity never writes twice and never revives a tombstone.
      if (await this.boundSource(tx, namespace, item.sourceKey)) {
        result.skipped += 1;
        continue;
      }
      if (item.remove) {
        const row = replacements.get(item.replacesId!);
        const dropped = !row
          ? "missing"
          : corrected.has(item.replacesId!)
            ? "duplicate_in_batch"
            : row.kind !== "durable"
              ? "not_durable"
              : row.status !== "active"
                ? "not_active"
                : row.revision !== item.expectedRevision
                  ? "revision_changed"
                  : null;
        if (!row || dropped) {
          getLogger().warn("memory archive removal skipped", {
            "memory.fact_id": item.replacesId,
            "memory.expected_revision": item.expectedRevision,
            "memory.reason": dropped,
          });
          result.skipped += 1;
          continue;
        }
        // The user's words are the evidence for the deletion; keep the binding so a replay of
        // this batch cannot retire a different fact that reused the id later.
        corrected.add(item.replacesId!);
        await this.rememberSource(tx, row, item.sourceKey);
        await this.tombstone(tx, row);
        result.removed += 1;
        continue;
      }
      // Content identity only guards a new fact: a correction may legitimately restore wording
      // that an earlier revision or an already-forgotten fact once used.
      if (
        item.replacesId === undefined &&
        ((await this.boundSource(tx, namespace, item.contentKey!)) ||
          (item.normalizedKey !== item.contentKey &&
            (await this.boundSource(tx, namespace, item.normalizedKey!))))
      ) {
        result.skipped += 1;
        continue;
      }
      const provenance: Provenance = {
        kind: "run",
        ...(item.source.runId ? { runId: item.source.runId } : {}),
        threadId: input.threadId,
        messageId: item.source.messageId,
        quote: item.quote,
        category: item.category,
        observedAt: item.source.observedAt.toISOString(),
      };
      const source: Source = {
        provenance,
        identity: ["auto", input.threadId, item.source.messageId, item.quote],
        threadId: input.threadId,
      };
      if (item.replacesId !== undefined) {
        const row = replacements.get(item.replacesId);
        const dropped = !row
          ? "missing"
          : corrected.has(item.replacesId)
            ? "duplicate_in_batch"
            : row.kind !== "durable"
              ? "not_durable"
              : row.status !== "active"
                ? "not_active"
                : row.revision !== item.expectedRevision
                  ? "revision_changed"
                  : row.content === item.content
                    ? "unchanged"
                    : null;
        if (!row || dropped) {
          // Dropping a correction silently left the fact on its old value with no trace.
          getLogger().warn("memory archive correction skipped", {
            "memory.fact_id": item.replacesId,
            "memory.expected_revision": item.expectedRevision,
            "memory.reason": dropped,
          });
          result.skipped += 1;
          continue;
        }
        corrected.add(item.replacesId);
        const updated = await this.replace(
          tx,
          row,
          item.content,
          provenance,
          item.expectedRevision!,
          item.sourceKey,
          source,
        );
        await this.bindContent(
          tx,
          namespace,
          [item.contentKey!, item.normalizedKey!],
          updated.id,
          ctx,
        );
        result.updated += 1;
        continue;
      }
      const saved = await this.insert(
        tx,
        {
          botId: input.botId,
          scope: input.scope,
          namespace,
          kind: "durable",
          content: item.content,
          provenance,
          status: "active",
          source,
          sourceKey: item.sourceKey,
          createdAt: now,
          updatedAt: now,
        },
        ctx,
      );
      await this.bindContent(tx, namespace, [item.contentKey!, item.normalizedKey!], saved.id, ctx);
      result.saved += 1;
    }
    return result;
  }

  /** Index these contents as already known so a retry cannot duplicate them. */
  private async bindContent(
    tx: Tx,
    namespace: string,
    contentKeys: readonly string[],
    factId: string,
    ctx: AdapterContext,
  ): Promise<void> {
    for (const contentKey of new Set(contentKeys)) {
      // A correction may restore content an earlier revision already bound.
      const existing = await tx.semanticFactSource.findUnique({
        where: { namespace_sourceKey: { namespace, sourceKey: contentKey } },
        select: { id: true },
      });
      if (existing) continue;
      await tx.semanticFactSource.create({
        data: { spaceId: ctx.spaceId, namespace, sourceKey: contentKey, factId },
      });
    }
  }

  async correct(request: SemanticFactCorrectRequest, ctx: AdapterContext): Promise<SemanticFact> {
    if (ctx.runId) throw new Error("Use the source-bound save operation for a run correction.");
    positiveRevision(request.expectedRevision);
    const content = contentValue(request.content);
    const namespace = this.scopeNamespace(request, ctx);
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      await this.requireScope(tx, request.botId, ctx);
      await this.lockNamespace(tx, namespace);
      await this.requireNotRetired(tx, namespace, request.botId);
      const sourceKey = await this.sourceKey(ctx.spaceId, [
        "correction",
        ctx.userId,
        request.id,
        request.expectedRevision,
        content,
      ]);
      await this.lockSource(tx, namespace, sourceKey);
      const row = await this.lockFact(tx, request.id, namespace);
      const bound = await this.boundSource(tx, namespace, sourceKey);
      if (
        bound &&
        row.revision === request.expectedRevision + 1 &&
        row.status === "active" &&
        row.content === content
      )
        return factValue(row);
      if (bound) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      const previous = factValue(row).provenance;
      const provenance: Provenance = {
        kind: "manual",
        observedAt: new Date().toISOString(),
        ...(previous.category ? { category: previous.category } : {}),
        ...(previous.validFrom ? { validFrom: previous.validFrom } : {}),
        ...(previous.validTo ? { validTo: previous.validTo } : {}),
      };
      return this.replace(tx, row, content, provenance, request.expectedRevision, sourceKey);
    });
  }

  async list(request: SemanticFactListRequest, ctx: AdapterContext): Promise<SemanticFactPage> {
    const namespace = this.scopeNamespace(request, ctx);
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid memory page size.");
    if (request.query && request.query.length > 500) throw new Error("Memory query is too long.");
    const query = (request.query ?? "").toLowerCase();
    const includeHistory = request.includeHistory === true;
    let cursor = readCursor(request.cursor, namespace, query, includeHistory);
    return this.inTenant(ctx, async () => {
      await this.requireScope(this.prisma, request.botId, ctx);
      const now = new Date();
      const items: SemanticFact[] = [];
      const where: Prisma.SemanticFactWhereInput = {
        namespace,
        ...(includeHistory
          ? {}
          : {
              status: "active",
              AND: [
                { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
                { OR: [{ validTo: null }, { validTo: { gt: now } }] },
              ],
            }),
      };
      // Content is encrypted, so substring matching happens after opening each exact page.
      for (;;) {
        ctx.signal.throwIfAborted();
        const rows = await this.prisma.semanticFact.findMany({
          where: { ...where, id: { gt: cursor } },
          orderBy: { id: "asc" },
          take: 100,
        });
        if (!rows.length) return { supported: true, items, nextCursor: null };
        for (const row of rows) {
          cursor = row.id;
          if (!includeHistory && row.kind === "history") {
            const liveThread =
              row.sourceThreadId && row.sourceGeneration !== null
                ? await this.prisma.thread.findFirst({
                    where: {
                      id: row.sourceThreadId,
                      spaceId: ctx.spaceId,
                      helperBotId: null,
                      externalConversationId: null,
                      historyCompactionGeneration: row.sourceGeneration,
                    },
                    select: { id: true },
                  })
                : null;
            if (!liveThread) continue;
          }
          if (query && !row.content.toLowerCase().includes(query)) continue;
          if (items.length === limit)
            return {
              supported: true,
              items,
              nextCursor: cursorValue(namespace, query, includeHistory, items.at(-1)!.id),
            };
          items.push(factValue(row));
        }
        if (rows.length < 100) return { supported: true, items, nextCursor: null };
      }
    });
  }

  private async tombstone(tx: Tx, row: FactRecord): Promise<void> {
    if (row.status === "forgotten") return;
    // Forgetting must not leave the body recoverable in the live row or in any revision.
    // Source fingerprints and the tombstone itself stay to block a later identical learn.
    await tx.semanticFactRevision.deleteMany({ where: { factId: row.id } });
    const updated = await tx.semanticFact.update({
      where: { id: row.id },
      data: { status: "forgotten", revision: { increment: 1 }, content: FORGOTTEN_CONTENT },
    });
    await this.snapshot(tx, updated);
    await this.enqueueIndex(tx, updated, row.revision, "delete");
    await this.enqueueIndex(tx, updated, updated.revision, "delete");
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    ctx: AdapterContext,
  ): Promise<{ id: string; expired: boolean; reason: string | null }> {
    if (request.expectedRevision !== undefined) positiveRevision(request.expectedRevision);
    if (request.expectedRevision === undefined && !ctx.runId)
      throw new Error("Forgetting a managed fact requires its expected revision.");
    const namespace = request.entity
      ? this.citationNamespace({ botId: request.botId, entity: request.entity }, ctx)
      : this.scopeNamespace(request, ctx);
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      await this.requireScope(tx, request.botId, ctx);
      await this.lockNamespace(tx, namespace);
      const row = await this.lockFact(tx, request.id, namespace);
      if (request.expectedRevision !== undefined && row.revision !== request.expectedRevision) {
        // A retry after a committed forget sees exactly one revision past its expectation.
        if (row.status === "forgotten" && row.revision === request.expectedRevision + 1)
          return { id: row.id, expired: true, reason: null };
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      if (ctx.runId)
        await this.sourceFor(
          tx,
          {
            botId: request.botId,
            scope: request.scope,
            content: row.content,
            source: { kind: "durable" },
          },
          ctx,
        );
      await this.tombstone(tx, row);
      return { id: row.id, expired: true, reason: null };
    });
  }

  /** Auto-retirement: an active lesson becomes historical and leaves the recall index. */
  async retireLesson(id: string, ctx: AdapterContext): Promise<void> {
    return this.transaction(ctx, async (tx) => {
      await this.lockSpace(tx, ctx.spaceId);
      const found = await tx.semanticFact.findFirst({
        where: { id, spaceId: ctx.spaceId, kind: "lesson" },
        select: { botId: true, namespace: true },
      });
      if (!found) return;
      await this.requireScope(tx, found.botId, ctx);
      await this.lockNamespace(tx, found.namespace);
      let row: FactRecord;
      try {
        row = await this.lockFact(tx, id, found.namespace);
      } catch (error) {
        // A concurrent forget or deletion already retired it; nothing left to do.
        if (error instanceof IsolationError) return;
        throw error;
      }
      if (row.status !== "active") return;
      const retired = await tx.semanticFact.update({
        where: { id: row.id },
        data: { status: "historical", revision: { increment: 1 } },
      });
      await this.snapshot(tx, retired);
      await this.enqueueIndex(tx, retired, row.revision, "delete");
      await this.enqueueIndex(tx, retired, retired.revision, "delete");
    });
  }

  async purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    ctx: AdapterContext,
  ): Promise<void> {
    for (const generation of request.generations) historyGeneration(generation);
    if (!request.generations.length) return;
    const namespaces = [
      semanticFactNamespace(ctx.spaceId, "isolated", request.botId),
      semanticFactNamespace(ctx.spaceId, "shared", request.botId),
    ].sort();
    return this.transaction(
      ctx,
      async (tx) => {
        await this.lockSpace(tx, ctx.spaceId);
        await this.requireScope(tx, request.botId, ctx);
        for (const namespace of namespaces) await this.lockNamespace(tx, namespace, true);
        // Omitted thread is a deliberate bot-wide generation fence for legacy callers.
        if (request.threadId) await this.requireThread(tx, request.botId, request.threadId, ctx);
        for (const namespace of namespaces)
          for (const generation of new Set(request.generations)) {
            const id = `sm-retired:${Buffer.from(JSON.stringify([namespace, request.botId, request.threadId ?? null, generation])).toString("base64url")}`;
            await tx.semanticMemoryRetirement.upsert({
              where: { id },
              update: {},
              create: {
                id,
                spaceId: ctx.spaceId,
                userId: ctx.userId,
                namespace,
                kind: "history",
                botId: request.botId,
                threadId: request.threadId ?? null,
                generation,
              },
            });
          }
        const rows = await tx.semanticFact.findMany({
          where: {
            spaceId: ctx.spaceId,
            botId: request.botId,
            kind: "history",
            status: { not: "forgotten" },
            sourceGeneration: { in: request.generations },
            ...(request.threadId ? { sourceThreadId: request.threadId } : {}),
          },
          orderBy: { id: "asc" },
        });
        for (const row of rows) await this.tombstone(tx, row);
      },
      BULK_RETIRE_TRANSACTION_OPTIONS,
    );
  }

  async resolveCandidates(
    request: SemanticMemoryRecallRequest,
    candidates: Array<{ id: string; revision: number; score: number }>,
    ctx: AdapterContext,
  ): Promise<SemanticMemoryResult[]> {
    const namespace = this.scopeNamespace(request, ctx);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new Error("Invalid memory recall limit.");
    return this.inTenant(ctx, async () => {
      await this.requireScope(this.prisma, request.botId, ctx);
      let generation: number | undefined;
      if (request.threadId && request.historyGeneration !== undefined) {
        historyGeneration(request.historyGeneration);
        const thread = await this.requireThread(this.prisma, request.botId, request.threadId, ctx);
        if (thread.historyCompactionGeneration === request.historyGeneration)
          generation = request.historyGeneration;
      }
      const ids = [
        ...new Set(
          candidates
            .filter(
              (candidate) =>
                candidate.id &&
                Number.isSafeInteger(candidate.revision) &&
                candidate.revision > 0 &&
                Number.isFinite(candidate.score),
            )
            .map((candidate) => candidate.id),
        ),
      ];
      if (!ids.length) return [];
      const now = new Date();
      const rows = await this.prisma.semanticFact.findMany({
        where: { id: { in: ids }, namespace, status: "active" },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const seen = new Set<string>();
      const results: SemanticMemoryResult[] = [];
      for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
        const row = byId.get(candidate.id);
        if (!row || seen.has(row.id) || row.revision !== candidate.revision || !activeAt(row, now))
          continue;
        if (
          row.kind === "history" &&
          (generation === undefined ||
            row.botId !== request.botId ||
            row.sourceThreadId !== request.threadId ||
            row.sourceGeneration !== generation)
        )
          continue;
        seen.add(row.id);
        const fact = factValue(row);
        results.push({
          id: fact.id,
          revision: fact.revision,
          memory: fact.content,
          score: candidate.score,
          updatedAt: fact.updatedAt,
          provenance: JSON.stringify(fact.provenance),
          entity: namespace,
        });
        if (results.length >= request.limit) break;
      }
      return results;
    });
  }

  async retireScope(
    request: { spaceId: string; botId?: string },
    ctx: AdapterContext,
    tx?: Tx,
  ): Promise<void> {
    if (request.spaceId !== ctx.spaceId) throw new IsolationError();
    // A caller deleting the scope's owner passes its transaction so a failed delete cannot
    // leave the bot alive with its memory already retired.
    if (tx) return this.retireScopeInTransaction(tx, request, ctx);
    return this.transaction(
      ctx,
      (owned) => this.retireScopeInTransaction(owned, request, ctx),
      BULK_RETIRE_TRANSACTION_OPTIONS,
    );
  }

  private async retireScopeInTransaction(
    tx: Tx,
    request: { spaceId: string; botId?: string },
    ctx: AdapterContext,
  ): Promise<void> {
    await this.lockSpace(tx, ctx.spaceId);
    if (request.botId) {
      const bot = await this.requireScope(tx, request.botId, ctx, true);
      if (bot.userId !== ctx.userId) throw new IsolationError();
    } else {
      const space = await tx.space.findFirst({
        where: { id: ctx.spaceId },
        select: { deletingAt: true },
      });
      if (!space?.deletingAt)
        throw new Error("Only a deleting space can retire every memory scope.");
    }
    const namespaces = request.botId
      ? [
          semanticFactNamespace(ctx.spaceId, "isolated", request.botId),
          lessonFactNamespace(ctx.spaceId, request.botId),
        ]
      : [
          ...new Set(
            (
              await tx.semanticFact.findMany({
                where: { spaceId: ctx.spaceId },
                select: { namespace: true },
              })
            ).map((row) => row.namespace),
          ),
        ].sort();
    for (const namespace of namespaces) {
      await this.lockNamespace(tx, namespace, true);
      const id = `sm-scope-retired:${namespace}`;
      await tx.semanticMemoryRetirement.upsert({
        where: { id },
        update: {},
        create: {
          id,
          spaceId: ctx.spaceId,
          userId: ctx.userId,
          namespace,
          kind: "scope",
          botId: request.botId ?? null,
        },
      });
    }
    const rows = await tx.semanticFact.findMany({
      where: {
        spaceId: ctx.spaceId,
        status: { not: "forgotten" },
        ...(request.botId ? { namespace: { in: namespaces } } : {}),
      },
      orderBy: { id: "asc" },
    });
    for (const row of rows) await this.tombstone(tx, row);
    if (!request.botId) return;
    // The deleted bot's history facts in the shared scope are unreachable once it is gone:
    // recall requires the requesting bot to own them, so nothing would ever clear them.
    const shared = semanticFactNamespace(ctx.spaceId, "shared", request.botId);
    await this.lockNamespace(tx, shared, true);
    const sharedHistory = await tx.semanticFact.findMany({
      where: {
        spaceId: ctx.spaceId,
        namespace: shared,
        botId: request.botId,
        kind: "history",
        status: { not: "forgotten" },
      },
      orderBy: { id: "asc" },
    });
    for (const row of sharedHistory) await this.tombstone(tx, row);
  }

  private async indexWork(db: Tx | PrismaClient, record: IndexRecord): Promise<SemanticIndexWork> {
    let action = record.action as "upsert" | "delete";
    let content: string | null = null;
    if (action === "upsert") {
      const row = await db.semanticFact.findFirst({
        where: { id: record.factId, spaceId: record.spaceId, namespace: record.namespace },
      });
      let current = Boolean(
        row &&
          row.revision === record.revision &&
          row.status === "active" &&
          (!row.validTo || row.validTo > new Date()),
      );
      if (current && row!.kind === "history") {
        const thread =
          row!.sourceThreadId && row!.sourceGeneration !== null
            ? await db.thread.findFirst({
                where: {
                  id: row!.sourceThreadId,
                  spaceId: row!.spaceId,
                  helperBotId: null,
                  externalConversationId: null,
                  historyCompactionGeneration: row!.sourceGeneration,
                },
                select: { id: true },
              })
            : null;
        current = Boolean(thread);
      }
      if (current) content = row!.content;
      else action = "delete";
    }
    return {
      id: record.id,
      spaceId: record.spaceId,
      userId: record.userId,
      namespace: record.namespace,
      indexId: record.indexId,
      factId: record.factId,
      revision: record.revision,
      action,
      content,
    };
  }

  async getIndexWork(id: string): Promise<SemanticIndexWork | null> {
    this.encryption();
    return runAsSystem("resolve authoritative managed-memory index work", async () => {
      const record = await this.prisma.semanticMemoryIndexOutbox.findUnique({ where: { id } });
      return record ? this.indexWork(this.prisma, record) : null;
    });
  }

  async pendingIndexWork(
    limit: number,
    spaceId?: string,
  ): Promise<Array<{ id: string; spaceId: string; userId: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid index work limit.");
    return runAsSystem("find pending managed-memory index revision pointers", () =>
      this.prisma.semanticMemoryIndexOutbox.findMany({
        where: spaceId ? { spaceId } : undefined,
        distinct: spaceId ? undefined : ["spaceId"],
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
        select: { id: true, spaceId: true, userId: true },
      }),
    );
  }

  private async complete(tx: Tx, record: IndexRecord): Promise<void> {
    if (record.action === "upsert") {
      const current = await this.indexWork(tx, record);
      if (current.action === "delete") {
        // A network upsert may have raced a tombstone. Keep a cleanup pointer, never stale text.
        const id = outboxId(record.factId, record.revision, "delete");
        await tx.semanticMemoryIndexOutbox.upsert({
          where: { id },
          update: {},
          create: { ...record, id, action: "delete" },
        });
      }
    }
    await tx.semanticMemoryIndexOutbox.deleteMany({ where: { id: record.id } });
  }

  async completeIndexWork(id: string): Promise<void> {
    return runAsSystem("complete a managed-memory index revision pointer", () =>
      this.prisma.$transaction(async (tx) => {
        const record = await tx.semanticMemoryIndexOutbox.findUnique({ where: { id } });
        if (record) await this.complete(tx, record);
      }),
    );
  }

  /** Serialize only index writers for this space across processes; fact writes never wait on it. */
  async syncIndexWork(
    spaceId: string,
    apply: (work: SemanticIndexWork, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    return runAsSystem("synchronize one space's managed-memory revision index", async () => {
      // Commit each page so a slow provider cannot roll back all prior progress.
      for (;;) {
        deadline.throwIfAborted();
        const empty = await this.prisma.$transaction(
          async (tx) => {
            const key = `semantic-index:${spaceId}`;
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS lock`;
            const records = await tx.semanticMemoryIndexOutbox.findMany({
              where: { spaceId },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 100,
            });
            for (const record of records) {
              deadline.throwIfAborted();
              await withAbort(apply(await this.indexWork(tx, record), deadline), deadline);
              await this.complete(tx, record);
            }
            return records.length === 0;
          },
          { timeout: 65_000 },
        );
        if (empty) return;
      }
    });
  }
}
