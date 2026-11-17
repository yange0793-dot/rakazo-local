import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MemoryExtractionChange,
  MemoryExtractionRequest,
  MemoryExtractor,
  MemoryStore,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResult,
} from "@rakazo/adapter-kit";
import type { MemoryArchiveBatch, PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomaticMemoryDeps } from "./automatic-memory.js";
import { archiveConversationMemory, reconcileAutomaticMemory } from "./automatic-memory.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

const store = vi.hoisted(() => ({
  loadBatch: vi.fn(),
  applyBatch: vi.fn(),
  pending: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  MemoryArchiveStore: class {
    loadBatch = store.loadBatch;
    applyBatch = store.applyBatch;
    pending = store.pending;
  },
}));

beforeEach(() => {
  store.loadBatch.mockReset();
  store.applyBatch.mockReset();
  store.pending.mockReset();
});

const context: AdapterContext = {
  operationId: "memory.extract:thread-a",
  traceId: "memory.extract:thread-a",
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  signal: new AbortController().signal,
};
const target = { threadId: "thread-a", botId: "bot-a", userId: "user-a" };

function makeBatch(overrides: Partial<MemoryArchiveBatch> = {}): MemoryArchiveBatch {
  const text = "我更喜欢先把测试写出来";
  return {
    threadId: "thread-a",
    botId: "bot-a",
    userId: "user-a",
    spaceId: "space-a",
    scope: "isolated",
    generation: 4,
    fromSeq: 7,
    throughSeq: 8,
    messages: [
      {
        id: "message-a",
        role: "user",
        content: text,
        createdAt: "2026-11-17T09:00:00.000Z",
        isNew: true,
      },
      {
        id: "message-b",
        role: "assistant",
        content: "记住了",
        createdAt: "2026-11-17T09:00:05.000Z",
        isNew: false,
      },
    ],
    newSources: [{ id: "message-a", text, createdAt: "2026-11-17T09:00:00.000Z" }],
    retirementEvidence: [],
    ...overrides,
  };
}

interface SetupOptions {
  batches?: Array<MemoryArchiveBatch | null>;
  changes?: MemoryExtractionChange[];
  applied?: { saved: number; updated: number; skipped: number };
  recalled?: SemanticMemoryResult[];
  recall?: { ok: true; value: SemanticMemoryResult[] } | { ok: false; error: string };
  secrets?: readonly string[];
  botDocuments?: Array<{ id: string; path: string; content: string; revision: number }>;
  userDocuments?: Array<{ id: string; path: string; content: string; revision: number }>;
}

function setup(options: SetupOptions = {}) {
  const queue = [...(options.batches ?? [null])];
  store.loadBatch.mockImplementation(async () => queue.shift() ?? null);
  store.applyBatch.mockResolvedValue(options.applied ?? { saved: 1, updated: 0, skipped: 0 });
  store.pending.mockResolvedValue([]);

  const extract = vi.fn(async (_request: MemoryExtractionRequest) => options.changes ?? []);
  const recall = vi.fn(
    async (_request: SemanticMemoryRecallRequest) =>
      options.recall ?? { ok: true as const, value: options.recalled ?? [] },
  );
  const provider = { recall } as unknown as SemanticMemoryProvider;
  const resolve = vi.fn(async () => ({ provider, defaultScope: "isolated" as const }));
  const read = vi.fn(async (request: { scope: "bot" | "user" }) => ({
    documents:
      request.scope === "bot"
        ? (options.botDocuments ?? [
            { id: "bot-doc", path: "MEMORY.md", content: "动手前先确认测试", revision: 2 },
          ])
        : (options.userDocuments ?? [
            { id: "user-doc", path: "PROFILE.md", content: "常用中文交流", revision: 1 },
          ]),
  }));
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const loadSecrets = vi.fn(async () => options.secrets ?? []);

  const deps: AutomaticMemoryDeps = {
    prisma: {} as PrismaClient,
    memory: { read } as unknown as MemoryStore,
    memoryProviders: { resolve } as unknown as MemoryProviderResolver,
    jobs: {
      enqueue,
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as JobPublisher,
    extractor: { extract } as unknown as MemoryExtractor,
    loadSecrets,
  };
  return { deps, extract, recall, resolve, read, enqueue, loadSecrets };
}

describe("archiveConversationMemory", () => {
  it("does nothing when the conversation has no eligible batch", async () => {
    const { deps, extract, resolve, loadSecrets, enqueue } = setup({ batches: [null] });

    await archiveConversationMemory(deps, target, context);

    expect(store.loadBatch).toHaveBeenCalledWith(target, context);
    expect(loadSecrets).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(store.applyBatch).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("commits an empty-source checkpoint without secrets or extraction", async () => {
    const empty = makeBatch({ messages: [], newSources: [] });
    const { deps, extract, resolve, loadSecrets, enqueue } = setup({ batches: [empty, null] });

    await archiveConversationMemory(deps, target, context);

    expect(store.applyBatch).toHaveBeenCalledTimes(1);
    expect(store.applyBatch).toHaveBeenCalledWith(empty, [], context);
    expect(extract).not.toHaveBeenCalled();
    expect(loadSecrets).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("recalls the batch scope, reads Markdown notes, and archives verified changes", async () => {
    const batch = makeBatch({
      retirementEvidence: [
        { id: "fact-2", revision: 5, content: "已遗忘的偏好", status: "forgotten" },
      ],
    });
    const change: MemoryExtractionChange = {
      content: "用户偏好先写测试",
      sourceMessageId: "message-a",
      sourceQuote: "先把测试写出来",
      category: "preference",
    };
    const { deps, extract, recall, resolve, enqueue } = setup({
      batches: [batch, null],
      changes: [change],
      recalled: [{ memory: "偏好使用 TypeScript", score: 0.9, id: "fact-1", revision: 3 }],
    });

    await archiveConversationMemory(deps, target, context);

    expect(resolve).toHaveBeenCalledWith("space-a");
    expect(recall).toHaveBeenCalledWith(
      {
        query: "我更喜欢先把测试写出来",
        scope: "isolated",
        botId: "bot-a",
        limit: 20,
      },
      context,
    );
    const request = extract.mock.calls[0]?.[0] as MemoryExtractionRequest;
    expect(request.existing).toEqual([
      { id: "fact-1", revision: 3, content: "偏好使用 TypeScript", status: "active" },
      { id: "fact-2", revision: 5, content: "已遗忘的偏好", status: "forgotten" },
    ]);
    expect(request.notes).toEqual([
      { scope: "bot", path: "MEMORY.md", revision: 2, content: "动手前先确认测试" },
      { scope: "user", path: "PROFILE.md", revision: 1, content: "常用中文交流" },
    ]);
    expect(store.applyBatch).toHaveBeenCalledWith(batch, [change], context);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "memory.sync",
      payload: { spaceId: "space-a" },
    });
  });

  it("keeps only literal new-source quotes and drops secret or placeholder content", async () => {
    const secret = "sk-live-1234567890";
    const batch = makeBatch({
      messages: [
        {
          id: "message-a",
          role: "user",
          content: "我更喜欢深色主题",
          createdAt: "2026-11-17T09:00:00.000Z",
          isNew: true,
        },
        {
          id: "message-c",
          role: "user",
          content: "记录 标注[redacted]即可",
          createdAt: "2026-11-17T09:00:03.000Z",
          isNew: true,
        },
        {
          id: "message-b",
          role: "user",
          content: `我的密钥是 ${secret}`,
          createdAt: "2026-11-17T09:00:05.000Z",
          isNew: true,
        },
      ],
      newSources: [
        { id: "message-a", text: "我更喜欢深色主题", createdAt: "2026-11-17T09:00:00.000Z" },
        {
          id: "message-c",
          text: "记录 标注[redacted]即可",
          createdAt: "2026-11-17T09:00:03.000Z",
        },
        { id: "message-b", text: `我的密钥是 ${secret}`, createdAt: "2026-11-17T09:00:05.000Z" },
      ],
    });
    const accepted: MemoryExtractionChange = {
      content: "用户喜欢深色主题",
      sourceMessageId: "message-a",
      sourceQuote: "我更喜欢深色主题",
      category: "preference",
    };
    const { deps, extract, recall, loadSecrets } = setup({
      batches: [batch, null],
      secrets: [secret],
      changes: [
        accepted,
        {
          content: "没有对应来源",
          sourceMessageId: "message-x",
          sourceQuote: "我更喜欢深色主题",
          category: "preference",
        },
        {
          content: "用户喜欢浅色主题",
          sourceMessageId: "message-a",
          sourceQuote: "我喜欢浅色主题",
          category: "preference",
        },
        {
          content: "用户保存了一个密钥",
          sourceMessageId: "message-b",
          sourceQuote: `我的密钥是 ${secret}`,
          category: "reference",
        },
        {
          content: `记住 ${secret}`,
          sourceMessageId: "message-a",
          sourceQuote: "我更喜欢深色主题",
          category: "reference",
        },
        {
          content: "用户的密钥是 [redacted]",
          sourceMessageId: "message-a",
          sourceQuote: "我更喜欢深色主题",
          category: "reference",
        },
        {
          content: "用户提到过占位标记",
          sourceMessageId: "message-c",
          sourceQuote: "记录 标注[redacted]即可",
          category: "reference",
        },
      ],
    });

    await archiveConversationMemory(deps, target, context);

    expect(loadSecrets).toHaveBeenCalledWith(context);
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: "我的密钥是 [redacted]" }),
      context,
    );
    const request = extract.mock.calls[0]?.[0] as MemoryExtractionRequest;
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(request.messages.find((message) => message.id === "message-b")?.content).toBe(
      "我的密钥是 [redacted]",
    );
    expect(store.applyBatch).toHaveBeenCalledWith(batch, [accepted], context);
  });

  it("defers remaining backlog with one immediate pointer job", async () => {
    const batches = Array.from({ length: 5 }, (_, index) =>
      makeBatch({ fromSeq: index * 2 + 1, throughSeq: index * 2 + 2 }),
    );
    const { deps, enqueue } = setup({
      batches,
      applied: { saved: 0, updated: 0, skipped: 0 },
    });

    await archiveConversationMemory(deps, target, context);

    expect(store.applyBatch).toHaveBeenCalledTimes(4);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = enqueue.mock.calls[0]?.[0] as BackgroundJob;
    expect(job).toMatchObject({
      name: "memory.extract",
      payload: target,
      replaceKey: "memory.extract:thread-a:bot-a:user-a",
    });
    expect(Math.abs((job.availableAt as Date).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("fails explicitly when a forced drain reaches its ceiling", async () => {
    const { deps, enqueue } = setup({
      batches: [makeBatch(), makeBatch(), makeBatch()],
      applied: { saved: 0, updated: 0, skipped: 0 },
    });

    await expect(
      archiveConversationMemory(deps, target, context, { force: true, maxBatches: 2 }),
    ).rejects.toThrow(/batches to apply after 2/);
    expect(store.applyBatch).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("drains a forced clear past the ordinary batch budget", async () => {
    const batches = Array.from({ length: 6 }, (_, index) =>
      makeBatch({ fromSeq: index * 2 + 1, throughSeq: index * 2 + 2 }),
    );
    const { deps, enqueue } = setup({
      batches: [...batches, null],
      applied: { saved: 0, updated: 0, skipped: 0 },
    });

    await archiveConversationMemory(deps, target, context, { force: true });

    expect(store.applyBatch).toHaveBeenCalledTimes(6);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps recall failures visible instead of applying an empty batch", async () => {
    const { deps } = setup({
      batches: [makeBatch(), null],
      recall: { ok: false, error: "synthetic recall down" },
    });

    await expect(archiveConversationMemory(deps, target, context)).rejects.toThrow(
      "synthetic recall down",
    );
    expect(store.applyBatch).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of truncating a source over the extractor limit", async () => {
    const huge = "字".repeat(1_500_000);
    const batch = makeBatch({
      messages: [
        {
          id: "message-a",
          role: "user",
          content: huge,
          createdAt: "2026-11-17T09:00:00.000Z",
          isNew: true,
        },
      ],
      newSources: [{ id: "message-a", text: huge, createdAt: "2026-11-17T09:00:00.000Z" }],
    });
    const { deps } = setup({ batches: [batch, null] });

    await expect(archiveConversationMemory(deps, target, context)).rejects.toThrow(
      /extractor limit/,
    );
    expect(store.applyBatch).not.toHaveBeenCalled();
  });

  it("keeps saved memory when the index sync publisher fails", async () => {
    const change: MemoryExtractionChange = {
      content: "用户偏好先写测试",
      sourceMessageId: "message-a",
      sourceQuote: "先把测试写出来",
      category: "preference",
    };
    const { deps, enqueue } = setup({ batches: [makeBatch(), null], changes: [change] });
    enqueue.mockImplementation(async (job: BackgroundJob) => {
      if (job.name === "memory.sync") throw new Error("synthetic publisher down");
    });

    await expect(archiveConversationMemory(deps, target, context)).resolves.toBeUndefined();
    expect(store.applyBatch).toHaveBeenCalled();
  });
});

describe("reconcileAutomaticMemory", () => {
  it("enqueues scheduled pointers without resetting their debounce", async () => {
    const availableAt = new Date("2026-11-17T09:01:00.000Z");
    const { deps, enqueue } = setup();
    store.pending.mockResolvedValue([
      { ...target, spaceId: "space-a", availableAt },
      { threadId: "thread-b", botId: "bot-b", userId: "user-b", spaceId: "space-b", availableAt },
    ]);

    await reconcileAutomaticMemory({ prisma: deps.prisma, jobs: deps.jobs });

    expect(store.pending).toHaveBeenCalledWith(100);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "memory.extract",
      payload: target,
      availableAt,
      keepExisting: true,
    });
  });
});
