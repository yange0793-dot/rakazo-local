import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryDerivedSpan,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  Prisma,
  runAsTenant,
  SemanticFactStore,
  withTransactionRetry,
} from "@rakazo/db";
import {
  memoryDerivations,
  memorySpanHash,
  projectMemory,
  retainMemoryDerivations,
  storedMemoryDerivations,
} from "./memory-derivation.js";

/** Memory is the Space's: every member's runs read and write the same documents. */
export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  private async authorize(
    request: { scope: "bot" | "user" | "all"; botId?: string },
    context: AdapterContext,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<void> {
    context.signal.throwIfAborted();
    if (
      (request.scope === "bot" && !request.botId) ||
      (request.botId && context.botId && request.botId !== context.botId) ||
      (request.scope === "user" && request.botId)
    )
      throw new IsolationError();
    const [member, space] = await Promise.all([
      db.spaceMember.findFirst({
        where: { spaceId: context.spaceId, userId: context.userId },
        select: { id: true },
      }),
      db.space.findFirst({
        where: { id: context.spaceId },
        select: { deletingAt: true },
      }),
    ]);
    if (!member || !space || space.deletingAt) throw new IsolationError();
    const botId = context.botId ?? request.botId;
    if (
      botId &&
      !(await db.bot.findFirst({
        where: { id: botId, spaceId: context.spaceId },
        select: { id: true },
      }))
    )
      throw new IsolationError();
  }

  private async projection(
    doc: { content: string; derivations: unknown; scope: string; botId: string | null },
    context: AdapterContext,
    tx?: Prisma.TransactionClient,
  ) {
    const spans = storedMemoryDerivations(doc.derivations, doc.content);
    const authority = new SemanticFactStore(this.prisma);
    const current = await Promise.all(
      spans.map(async (span) => {
        const sources = await authority.derivationSources(
          span.sources,
          { ...context, botId: doc.botId ?? context.botId },
          tx,
        );
        return Boolean(
          sources &&
            (doc.scope !== "user" ||
              sources.every((source) => source.scope === "shared" && source.kind !== "lesson")),
        );
      }),
    );
    return projectMemory(doc.content, spans, current);
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    return runAsTenant(context, async () => {
      await this.authorize(request, context);
      if (request.purpose === "edit" && context.runId) throw new IsolationError();
      const documents = await this.prisma.memoryDocument.findMany({
        where: {
          spaceId: context.spaceId,
          scope: request.scope,
          botId: request.botId ?? null,
          ...(request.path ? { path: request.path } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
      });
      const visible = await Promise.all(
        documents.map(async (doc) => ({
          id: doc.id,
          path: doc.path,
          content:
            request.purpose === "edit"
              ? doc.content
              : (await this.projection(doc, context)).content,
          revision: doc.revision,
          updatedAt: doc.updatedAt.toISOString(),
        })),
      );
      return { documents: visible };
    });
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    return runAsTenant(context, async () => {
      await this.authorize(request, context);
      const botId = request.botId ?? context.botId;
      const documents = await this.prisma.memoryDocument.findMany({
        where: {
          spaceId: context.spaceId,
          ...(request.scope === "all" ? {} : { scope: request.scope }),
          ...(request.scope === "user"
            ? { botId: null }
            : request.scope === "bot"
              ? { botId }
              : botId
                ? {
                    OR: [
                      { scope: "user", botId: null },
                      { scope: "bot", botId },
                    ],
                  }
                : {}),
        },
      });
      const q = request.query.toLowerCase();
      const projected = await Promise.all(
        documents.map(async (doc) => ({
          ...doc,
          content: (await this.projection(doc, context)).content,
        })),
      );
      return projected
        .filter((doc) => doc.content.trim())
        .filter(
          (doc) => doc.content.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q),
        )
        .map((doc) => ({
          path: doc.path,
          snippet: snippet(doc.content, q),
          score: 1,
        }));
    });
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    const annotations = memoryDerivations(request.derivations, request.content);
    return runAsTenant(context, () =>
      withTransactionRetry(() =>
        this.prisma.$transaction(
          async (tx) => {
            await this.authorize(request, context, tx);
            const existing = await tx.memoryDocument.findFirst({
              where: {
                spaceId: context.spaceId,
                scope: request.scope,
                botId: request.botId ?? null,
                path: request.path,
              },
            });
            if (request.expectedRevision !== undefined) {
              const live = existing?.revision ?? 0;
              if (live !== request.expectedRevision)
                throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
            }
            const automatic = Boolean(context.runId || request.sourceRunId);
            if (
              (annotations.length || existing?.derivations) &&
              request.expectedRevision === undefined
            )
              throw new Error("Derived memory edits require an expected document revision.");
            const authority = new SemanticFactStore(this.prisma);
            const added: MemoryDerivedSpan[] = [];
            for (const annotation of annotations) {
              const sources = await authority.derivationSources(
                annotation.sources,
                { ...context, botId: request.botId ?? context.botId },
                tx,
              );
              if (
                !sources ||
                (request.scope === "user" &&
                  sources.some((source) => source.scope !== "shared" || source.kind === "lesson"))
              )
                throw new Error("A memory derivation source is no longer current or accessible.");
              added.push({ ...annotation, sources });
            }
            const previous = existing
              ? automatic
                ? await this.projection(existing, context, tx)
                : {
                    content: existing.content,
                    derivations: storedMemoryDerivations(existing.derivations, existing.content),
                    hidden: [],
                  }
              : { content: "", derivations: [], hidden: [] };
            let content = request.content;
            const retained = retainMemoryDerivations(
              existing?.content ?? "",
              content,
              existing ? storedMemoryDerivations(existing.derivations, existing.content) : [],
              automatic,
            );
            if (automatic && previous.derivations.length) {
              const lines = new Set(
                (previous.content.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) =>
                  line.replace(/\r?\n$/, ""),
                ),
              );
              const remaining = retainMemoryDerivations(
                previous.content,
                content,
                previous.derivations,
              );
              const countLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
              const before = previous.derivations.reduce(
                (count, span) => count + countLines(previous.content.slice(span.start, span.end)),
                0,
              );
              const after = remaining.reduce(
                (count, span) => count + countLines(content.slice(span.start, span.end)),
                0,
              );
              if (after < before) {
                let start = 0;
                for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
                  if (
                    line.trim() &&
                    !lines.has(line.replace(/\r?\n$/, "")) &&
                    !added.some((span) => span.start <= start && span.end >= start + line.length)
                  )
                    throw new Error(
                      "An automatic rewrite of derived memory requires source_facts.",
                    );
                  start += line.length;
                }
              }
            }
            const derivations = [
              ...retained.flatMap((span) => {
                let pieces = [span];
                for (const next of added) {
                  pieces = pieces.flatMap((piece) =>
                    next.start >= piece.end || next.end <= piece.start
                      ? [piece]
                      : [
                          ...(piece.start < next.start ? [{ ...piece, end: next.start }] : []),
                          ...(piece.end > next.end ? [{ ...piece, start: next.end }] : []),
                        ],
                  );
                }
                return pieces;
              }),
              ...added,
            ].sort((left, right) => left.start - right.start);
            // A source may change after the agent read. Keep its annotations even when the
            // submitted text still contains the old projection, then retain omitted originals.
            const included = new Map<string, number>();
            for (const span of retained) {
              for (const line of content.slice(span.start, span.end).match(/[^\n]*\n|[^\n]+$/g) ??
                []) {
                const key = JSON.stringify([span.sources, line.replace(/\r?\n$/, "")]);
                included.set(key, (included.get(key) ?? 0) + 1);
              }
            }
            for (const span of previous.hidden) {
              for (const line of existing!.content
                .slice(span.start, span.end)
                .match(/[^\n]*\n|[^\n]+$/g) ?? []) {
                const key = JSON.stringify([span.sources, line.replace(/\r?\n$/, "")]);
                const count = included.get(key) ?? 0;
                if (count) {
                  included.set(key, count - 1);
                  continue;
                }
                if (content && !content.endsWith("\n")) content += "\n";
                const start = content.length;
                content += line;
                const last = derivations.at(-1);
                if (
                  last?.end === start &&
                  JSON.stringify(last.sources) === JSON.stringify(span.sources)
                )
                  last.end = content.length;
                else derivations.push({ ...span, start, end: content.length });
              }
            }
            memoryDerivations(derivations, content);
            for (const span of derivations)
              span.contentHash = memorySpanHash(content.slice(span.start, span.end));
            const metadata = derivations.length ? derivations : Prisma.DbNull;
            const doc = existing
              ? await tx.memoryDocument.update({
                  where: { id: existing.id },
                  data: { content, derivations: metadata, revision: existing.revision + 1 },
                })
              : await tx.memoryDocument.create({
                  data: {
                    spaceId: context.spaceId,
                    userId: context.userId,
                    botId: request.botId,
                    scope: request.scope,
                    path: request.path,
                    content,
                    ...(derivations.length ? { derivations } : {}),
                  },
                });
            await tx.memoryRevision.create({
              data: {
                documentId: doc.id,
                revision: doc.revision,
                content,
                sourceRunId: request.sourceRunId,
                sourceThreadId: request.sourceThreadId,
              },
            });
            return {
              id: doc.id,
              path: doc.path,
              revision: doc.revision,
              content: automatic ? (await this.projection(doc, context, tx)).content : doc.content,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  }

  async remove(
    request: MemoryRemoveRequest,
    context: AdapterContext,
  ): Promise<{ removed: boolean }> {
    // Revisions cascade with the document row.
    return runAsTenant(context, async () => {
      await this.authorize(request, context);
      const { count } = await this.prisma.memoryDocument.deleteMany({
        where: {
          ...(request.id ? { id: request.id } : {}),
          spaceId: context.spaceId,
          scope: request.scope,
          botId: request.botId ?? null,
          path: request.path,
        },
      });
      return { removed: count > 0 };
    });
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
