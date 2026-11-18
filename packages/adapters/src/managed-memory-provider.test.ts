import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient, SemanticIndexWork } from "@rakazo/db";
import { IsolationError, lessonFactNamespace, semanticFactNamespace } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalMemoryCandidate, LocalMemoryIndex } from "./local-memory-index.js";
import { MAX_LOCAL_MEMORY_CANDIDATES } from "./local-memory-index.js";
import { createManagedMemoryProvider, syncManagedMemoryIndex } from "./managed-memory-provider.js";

const store = vi.hoisted(() => ({
  save: vi.fn(),
  forget: vi.fn(),
  purgeHistory: vi.fn(),
  list: vi.fn(),
  correct: vi.fn(),
  authorizeScope: vi.fn(),
  resolveCandidates: vi.fn(),
  syncIndexWork: vi.fn(),
}));
vi.mock("@rakazo/db", async (original) => {
  const actual = await original<object>();
  return {
    ...actual,
    SemanticFactStore: class {
      save = store.save;
      forget = store.forget;
      purgeHistory = store.purgeHistory;
      list = store.list;
      correct = store.correct;
      authorizeScope = store.authorizeScope;
      resolveCandidates = store.resolveCandidates;
      syncIndexWork = store.syncIndexWork;
    },
  };
});

const ctx: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};
const prisma = {} as PrismaClient;

function fixture(withJobs = true) {
  const index: LocalMemoryIndex = {
    search: vi.fn(async () => [{ id: "fact-a", revision: 1, score: 0.9 }]),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    health: vi.fn(async () => {}),
  };
  const jobs = { enqueue: vi.fn(async () => {}) };
  return {
    index,
    jobs,
    provider: createManagedMemoryProvider({ prisma, index, ...(withJobs ? { jobs } : {}) }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  store.list.mockResolvedValue({ supported: true, items: [], nextCursor: null });
  store.resolveCandidates.mockResolvedValue([
    { id: "fact-a", revision: 1, memory: "DB text", score: 0.9 },
  ]);
  store.forget.mockResolvedValue({ id: "fact-a", expired: true, reason: null });
});

describe("managed local memory provider", () => {
  it("opts in to early recall and managed facts without backend product names", () => {
    expect(fixture().provider.describe()).toMatchObject({
      id: "local",
      capabilities: { managedFacts: true, preTurnRecall: true },
    });
  });

  it("authorizes scope before index access and resolves every hit through DB authority", async () => {
    const f = fixture();
    const request = {
      query: "console",
      botId: "bot-a",
      scope: "isolated" as const,
      limit: 5,
      threadId: "thread-a",
    };
    expect(await f.provider.recall(request, ctx)).toEqual({
      ok: true,
      value: [{ id: "fact-a", revision: 1, memory: "DB text", score: 0.9 }],
    });
    expect(store.authorizeScope.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.index.search).mock.invocationCallOrder[0]!,
    );
    expect(store.resolveCandidates).toHaveBeenCalledWith(
      request,
      [{ id: "fact-a", revision: 1, score: 0.9 }],
      ctx,
    );
    expect(f.index.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "console", limit: MAX_LOCAL_MEMORY_CANDIDATES }),
      ctx.signal,
    );
    store.authorizeScope.mockRejectedValueOnce(new IsolationError());
    expect(await f.provider.recall(request, ctx)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(f.index.search).toHaveBeenCalledTimes(1);
  });

  it("reads lessons from their own per-bot namespace, never the fact namespaces", async () => {
    const f = fixture();
    expect(
      await f.provider.recall(
        { query: "Deploys fail", botId: "bot-a", scope: "isolated", limit: 3, kind: "lesson" },
        ctx,
      ),
    ).toMatchObject({ ok: true });
    expect(f.index.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ namespace: lessonFactNamespace(ctx.spaceId, "bot-a") }),
      ctx.signal,
    );
    expect(lessonFactNamespace(ctx.spaceId, "bot-a")).toMatch(/^hl1:/);
    expect(
      await f.provider.recall(
        { query: "console", botId: "bot-a", scope: "isolated", limit: 5 },
        ctx,
      ),
    ).toMatchObject({ ok: true });
    expect(f.index.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        namespace: semanticFactNamespace(ctx.spaceId, "isolated", "bot-a"),
      }),
      ctx.signal,
    );
  });

  it("lets later candidates refill a small final limit after stale top hits are filtered", async () => {
    const f = fixture();
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      id: `fact-${index + 1}`,
      revision: index < 4 ? 1 : 2,
      score: 1 - index / 10,
    }));
    vi.mocked(f.index.search).mockResolvedValue(candidates);
    store.resolveCandidates.mockImplementationOnce(
      async (request: { limit: number }, indexed: LocalMemoryCandidate[]) =>
        indexed
          .filter((candidate) => candidate.revision === 2)
          .slice(0, request.limit)
          .map((candidate) => ({
            id: candidate.id,
            revision: candidate.revision,
            memory: `${candidate.id} current`,
            score: candidate.score,
          })),
    );
    const request = {
      query: "current revision",
      botId: "bot-a",
      scope: "isolated" as const,
      limit: 2,
      threadId: "thread-a",
    };

    expect(await f.provider.recall(request, ctx)).toEqual({
      ok: true,
      value: [
        { id: "fact-5", revision: 2, memory: "fact-5 current", score: 0.6 },
        { id: "fact-6", revision: 2, memory: "fact-6 current", score: 0.5 },
      ],
    });
    expect(f.index.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_LOCAL_MEMORY_CANDIDATES }),
      ctx.signal,
    );
    expect(store.resolveCandidates).toHaveBeenCalledWith(request, candidates, ctx);
  });

  it("schedules the existing keyed job only after committed authority mutation", async () => {
    const f = fixture();
    const request = {
      content: "A synthetic fact.",
      botId: "bot-a",
      scope: "isolated" as const,
      source: { kind: "durable" as const },
    };
    expect(await f.provider.save(request, ctx)).toEqual({ ok: true, value: undefined });
    expect(f.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "memory.sync", payload: { spaceId: ctx.spaceId } }),
    );
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(
      f.jobs.enqueue.mock.invocationCallOrder[0]!,
    );
    store.save.mockRejectedValueOnce(new Error(MEMORY_REVISION_CONFLICT_ERROR));
    expect(await f.provider.save(request, ctx)).toEqual({
      ok: false,
      error: MEMORY_REVISION_CONFLICT_ERROR,
      code: "CONFLICT",
    });
    expect(f.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("surfaces job/index failures rather than pretending the index synchronized", async () => {
    const f = fixture();
    f.jobs.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    expect(
      await f.provider.forget!(
        { id: "fact-a", botId: "bot-a", scope: "isolated", expectedRevision: 1 },
        ctx,
      ),
    ).toMatchObject({
      ok: false,
      error: "Memory change saved locally; index synchronization is pending. queue unavailable",
    });
    expect(store.forget).toHaveBeenCalledTimes(1);
    const inline = fixture(false);
    store.syncIndexWork.mockRejectedValueOnce(new Error("index unavailable"));
    expect(
      await inline.provider.purgeHistory(
        { botId: "bot-a", generations: [1], threadId: "thread-a" },
        ctx,
      ),
    ).toMatchObject({
      ok: false,
      error: "Memory change saved locally; index synchronization is pending. index unavailable",
    });
  });

  it("syncs revision ids, removes stale hits, and lets failed work stay pending", async () => {
    const f = fixture(false);
    const upsert: SemanticIndexWork = {
      id: "work-a",
      spaceId: ctx.spaceId,
      userId: ctx.userId,
      namespace: "ns",
      indexId: "fact-a:2",
      factId: "fact-a",
      revision: 2,
      action: "upsert",
      content: "DB text",
    };
    const stale: SemanticIndexWork = {
      ...upsert,
      id: "work-b",
      indexId: "fact-a:1",
      revision: 1,
      action: "delete",
      content: null,
    };
    store.syncIndexWork.mockImplementationOnce(async (_spaceId, apply, signal) => {
      await apply(upsert, signal);
      await apply(stale, signal);
    });
    await syncManagedMemoryIndex({ prisma, index: f.index }, ctx.spaceId, ctx.signal);
    expect(f.index.upsert).toHaveBeenCalledWith(
      { namespace: "ns", indexId: "fact-a:2", id: "fact-a", revision: 2, content: "DB text" },
      ctx.signal,
    );
    expect(f.index.remove).toHaveBeenCalledWith(
      { namespace: "ns", indexId: "fact-a:1" },
      ctx.signal,
    );
    f.index.upsert = vi.fn(async () => {
      throw new Error("index down");
    });
    store.syncIndexWork.mockImplementationOnce(async (_spaceId, apply, signal) =>
      apply(upsert, signal),
    );
    await expect(
      syncManagedMemoryIndex({ prisma, index: f.index }, ctx.spaceId, ctx.signal),
    ).rejects.toThrow("index down");
  });

  it("exposes the same durable index drain to background jobs and deletion cleanup", async () => {
    const f = fixture();
    expect(await f.provider.syncIndex!(ctx)).toEqual({ ok: true, value: undefined });
    expect(store.syncIndexWork).toHaveBeenCalledWith(ctx.spaceId, expect.any(Function), ctx.signal);
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
    store.syncIndexWork.mockRejectedValueOnce(new Error("synthetic drain failed"));
    expect(await f.provider.syncIndex!(ctx)).toEqual({
      ok: false,
      error: "synthetic drain failed",
    });
  });

  it("uses store management methods and schedules a corrected revision", async () => {
    const f = fixture();
    const value = { id: "fact-a", revision: 2, content: "Corrected" };
    store.correct.mockResolvedValueOnce(value);
    const request = {
      id: "fact-a",
      botId: "bot-a",
      scope: "isolated" as const,
      content: "Corrected",
      expectedRevision: 1,
    };
    expect(await f.provider.correctFact!(request, ctx)).toEqual({ ok: true, value });
    expect(store.correct).toHaveBeenCalledWith(request, ctx);
    expect(f.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(await f.provider.listFacts!({ botId: "bot-a", scope: "isolated" }, ctx)).toMatchObject({
      ok: true,
      value: { supported: true },
    });
  });
});
