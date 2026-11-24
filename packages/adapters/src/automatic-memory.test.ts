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
import type { MemoryArchiveApplyCounts, MemoryArchiveBatch, PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomaticMemoryDeps } from "./automatic-memory.js";
import { archiveConversationMemory, reconcileAutomaticMemory } from "./automatic-memory.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

const store = vi.hoisted(() => ({
  loadBatch: vi.fn(),
  applyBatch: vi.fn(),
  pending: vi.fn(),
  pause: vi.fn(),
}));

vi.mock("@rakazo/db", () => ({
  FORCE_BATCH_MESSAGES: 200,
  MemoryArchiveStore: class {
    loadBatch = store.loadBatch;
    applyBatch = store.applyBatch;
    pending = store.pending;
    pause = store.pause;
  },
}));

beforeEach(() => {
  store.loadBatch.mockReset();
  store.applyBatch.mockReset();
  store.pending.mockReset();
  store.pause.mockReset();
  store.pause.mockResolvedValue(undefined);
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
  applied?: MemoryArchiveApplyCounts;
  recalled?: SemanticMemoryResult[];
  recall?: { ok: true; value: SemanticMemoryResult[] } | { ok: false; error: string };
  secrets?: readonly string[];
  botDocuments?: Array<{ id: string; path: string; content: string; revision: number }>;
  userDocuments?: Array<{ id: string; path: string; content: string; revision: number }>;
}

function setup(options: SetupOptions = {}) {
  const queue = [...(options.batches ?? [null])];
  store.loadBatch.mockImplementation(async () => queue.shift() ?? null);
  store.applyBatch.mockResolvedValue(
    options.applied ?? { saved: 1, updated: 0, skipped: 0, removed: 0 },
  );
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

  it("passes a removal through only when the user's words ask for it", async () => {
    const text = "别再记我的地址了";
    const batch = makeBatch({
      messages: [
        {
          id: "message-a",
          role: "user",
          content: text,
          createdAt: "2026-11-17T09:00:00.000Z",
          isNew: true,
        },
      ],
      newSources: [{ id: "message-a", text, createdAt: "2026-11-17T09:00:00.000Z" }],
    });
    const removal: MemoryExtractionChange = {
      content: "用户住在北京",
      sourceMessageId: "message-a",
      sourceQuote: "别再记我的地址了",
      category: "preference",
      replacesId: "fact-1",
      expectedRevision: 3,
      remove: true,
    };
    const unquoted: MemoryExtractionChange = { ...removal, sourceQuote: "忘掉所有记忆" };
    const { deps, enqueue } = setup({
      batches: [batch, null],
      changes: [removal, unquoted],
      applied: { saved: 0, updated: 0, skipped: 0, removed: 1 },
    });

    await archiveConversationMemory(deps, target, context);

    expect(store.applyBatch).toHaveBeenCalledWith(batch, [removal], context);
    // A tombstone changes the index too, so the sync job is still enqueued.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ name: "memory.sync" });
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
      applied: { saved: 0, updated: 0, skipped: 0, removed: 0 },
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
      applied: { saved: 0, updated: 0, skipped: 0, removed: 0 },
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
      applied: { saved: 0, updated: 0, skipped: 0, removed: 0 },
    });

    await archiveConversationMemory(deps, target, context, { force: true });

    // A clear covers as much of the conversation per call as one request allows.
    expect(store.loadBatch).toHaveBeenCalledWith({ ...target, limit: 200 }, context);
    expect(store.applyBatch).toHaveBeenCalledTimes(6);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("archives without candidates when recall is down instead of failing the batch", async () => {
    const change: MemoryExtractionChange = {
      content: "用户偏好先写测试",
      sourceMessageId: "message-a",
      sourceQuote: "先把测试写出来",
      category: "preference",
    };
    const { deps, extract } = setup({
      batches: [makeBatch(), null],
      changes: [change],
      recall: { ok: false, error: "synthetic recall down" },
    });

    await expect(archiveConversationMemory(deps, target, context)).resolves.toBeUndefined();
    expect(extract.mock.calls[0]?.[0]).toMatchObject({ existing: [] });
    expect(store.applyBatch).toHaveBeenCalledWith(expect.any(Object), [change], context);
  });

  it.each([
    { text: "我姓王", changes: [{ content: "用户姓王", category: "reference" as const }] },
    {
      text: "改姓李",
      changes: [
        {
          content: "用户姓李",
          category: "reference" as const,
          replacesId: "fact-1",
          expectedRevision: 3,
        },
      ],
    },
    { text: "谢谢", changes: [] },
    { text: "好的", changes: [] },
  ])(
    "lets the extractor decide whether the short source '$text' changes memory",
    async ({ text, changes }) => {
      const batch = makeBatch({
        messages: [
          {
            id: "message-a",
            role: "user",
            content: text,
            createdAt: "2026-11-17T09:00:00.000Z",
            isNew: true,
          },
        ],
        newSources: [{ id: "message-a", text, createdAt: "2026-11-17T09:00:00.000Z" }],
      });
      const proposed = changes.map((change) => ({
        ...change,
        sourceMessageId: "message-a",
        sourceQuote: text,
      }));
      const { deps, extract } = setup({
        batches: [batch, null],
        changes: proposed,
        recalled: [{ memory: "用户姓王", score: 0.9, id: "fact-1", revision: 3 }],
      });

      await archiveConversationMemory(deps, target, context);

      expect(extract).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messages: batch.messages }),
        context,
      );
      expect(extract.mock.invocationCallOrder[0]!).toBeLessThan(
        store.applyBatch.mock.invocationCallOrder[0]!,
      );
      expect(store.applyBatch).toHaveBeenCalledWith(batch, proposed, context);
    },
  );

  it("queries recall with the tail of a message longer than the index accepts", async () => {
    const long = `${"前缀".repeat(10_000)}最后的偏好`;
    const batch = makeBatch({
      messages: [
        {
          id: "message-a",
          role: "user",
          content: long,
          createdAt: "2026-11-17T09:00:00.000Z",
          isNew: true,
        },
      ],
      newSources: [{ id: "message-a", text: long, createdAt: "2026-11-17T09:00:00.000Z" }],
    });
    const { deps, recall } = setup({ batches: [batch, null] });

    await archiveConversationMemory(deps, target, context);

    const request = recall.mock.calls[0]?.[0] as { query: string } | undefined;
    expect(Buffer.byteLength(request?.query ?? "")).toBeLessThanOrEqual(8 * 1024);
    expect(request?.query.endsWith("最后的偏好")).toBe(true);
  });

  it("leaves short configured values out of redaction so ordinary words survive", async () => {
    const batch = makeBatch({
      messages: [
        {
          id: "message-a",
          role: "user",
          content: "记住 MODE 是 on 的意思",
          createdAt: "2026-11-17T09:00:00.000Z",
          isNew: true,
        },
      ],
      newSources: [
        { id: "message-a", text: "记住 MODE 是 on 的意思", createdAt: "2026-11-17T09:00:00.000Z" },
      ],
    });
    const { deps, extract } = setup({ batches: [batch, null], secrets: ["on"] });

    await archiveConversationMemory(deps, target, context);

    const request = extract.mock.calls[0]?.[0] as MemoryExtractionRequest;
    expect(request.messages[0]?.content).toBe("记住 MODE 是 on 的意思");
  });

  it("stops automatic retries when a batch keeps failing", async () => {
    const { deps } = setup({
      batches: [makeBatch(), null],
      recall: { ok: true, value: [] },
    });
    store.applyBatch.mockRejectedValue(new Error("synthetic store failure"));

    await expect(archiveConversationMemory(deps, target, context)).rejects.toThrow(
      "synthetic store failure",
    );
    expect(store.pause).toHaveBeenCalledWith(target, context);
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

  it("steps over an unextractable range during a forced clear instead of blocking it", async () => {
    const bad = makeBatch({ fromSeq: 1, throughSeq: 2 });
    const good = makeBatch({ fromSeq: 3, throughSeq: 4 });
    const { deps, extract } = setup({
      batches: [bad, good, null],
      applied: { saved: 0, updated: 0, skipped: 0, removed: 0 },
    });
    extract.mockRejectedValueOnce(new Error("synthetic model failure"));

    await expect(
      archiveConversationMemory(deps, target, context, { force: true }),
    ).resolves.toBeUndefined();

    expect(store.pause).not.toHaveBeenCalled();
    // The failed range is checkpointed empty so the clear can delete the conversation.
    expect(store.applyBatch).toHaveBeenCalledWith(bad, [], context);
    expect(store.applyBatch).toHaveBeenCalledWith(good, [], context);
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
      // A worker that died mid-extraction never unlocks its job.
      replaceLockedBefore: expect.any(Date),
    });
  });
});
