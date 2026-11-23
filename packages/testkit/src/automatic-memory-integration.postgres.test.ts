import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  MemoryExtractionCategory,
  MemoryExtractionChange,
  MemoryStore,
  SemanticMemoryResponse,
} from "@rakazo/adapter-kit";
import type {
  AutomaticMemoryDeps,
  MemoryCompletionRequest,
  MemoryCompletionResponse,
  MemoryProviderResolver,
} from "@rakazo/adapters";
import {
  archiveConversationMemory,
  createLangMemExtractor,
  createLocalMemoryIndex,
  createManagedMemoryProvider,
  syncManagedMemoryIndex,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  MemoryArchiveStore,
  runAsSystem,
  runAsTenant,
  SemanticFactStore,
  semanticFactNamespace,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * One synthetic end-to-end journey for automatic memory: the real archive store, the real
 * runtime orchestrator, the real LangMem child process with a scripted model completion, and
 * the actual cached local memory index service. The scripted model deliberately proposes the
 * facts this journey expects; every asserted result is a database row, revision, cursor,
 * outbox id or index candidate, never generated prose.
 */
const databaseUrl = process.env.DATABASE_URL;

const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INDEX_PYTHON = process.env.RAKAZO_TEST_INDEX_PYTHON ?? "";
const INDEX_CACHE = process.env.RAKAZO_TEST_INDEX_CACHE ?? "";
const INDEX_SCRIPT = join(SOURCE_ROOT, "scripts/local-memory-index.py");
const LANGMEM_PYTHON = process.env.RAKAZO_TEST_EXTRACTOR_PYTHON ?? "";
const LANGMEM_SCRIPT = join(SOURCE_ROOT, "scripts/langmem-memory-extractor.py");
const OUTPUT_DIR = process.env.RAKAZO_TEST_MEMORY_OUTPUT ?? tmpdir();

// The real-service journey is opt-in: supply the two Python runtimes and offline model cache.
// A partially supplied configuration still runs and fails validation instead of being skipped.
const configured = Boolean(INDEX_PYTHON || INDEX_CACHE || LANGMEM_PYTHON);
const postgres =
  process.env.VERIFY_DATABASE && databaseUrl && configured ? describe : describe.skip;

const stamp = randomUUID();
const userId = `am-int-user-${stamp}`;
const organizationId = `am-int-org-${stamp}`;
const spaceId = `am-int-space-${stamp}`;
const botId = `am-int-bot-${stamp}`;
const threadId = `am-int-thread-${stamp}`;
const target = { threadId, botId, userId };

const content = {
  preference: "用户偏好每周三上午做规划。合成标记 AM-J7Q。",
  correction: "用户把规划时间改为每周四上午。合成标记 AM-J7Q。",
  reference: "实验记录位于 /synthetic/experiments/run-42.md。合成标记 AM-K3V。",
  project: "合成项目代号确定为 atlas-k92。合成标记 AM-P9S。",
  review: "合成项目将在周五评审。合成标记 AM-Q4W。",
};

interface Proposition {
  content: string;
  sourceMessageId: string;
  sourceQuote: string;
  category: MemoryExtractionCategory;
}

type Stage =
  | { kind: "insert"; facts: Proposition[] }
  | { kind: "patch"; factId: string; fact: Proposition };

function successfulValue<T>(response: SemanticMemoryResponse<T>): T {
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

function propertyNames(tool: { parameters: Record<string, unknown> }): string[] {
  const properties = tool.parameters.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Synthetic index could not find a loopback port."));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

postgres("automatic memory synthetic integration (isolated PostgreSQL)", () => {
  let database: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let db: PrismaClient;
  let archive: MemoryArchiveStore;
  let facts: SemanticFactStore;
  let index: ReturnType<typeof createLocalMemoryIndex>;
  let provider: ReturnType<typeof createManagedMemoryProvider>;
  let deps: AutomaticMemoryDeps;
  let ctx: AdapterContext;

  let stages: Stage[] = [];
  let stageCursor = 0;
  const enqueued: BackgroundJob[] = [];

  let service: ChildProcess | undefined;
  let serviceExit: Promise<void> | undefined;
  let serviceLog: WriteStream | undefined;
  let temporaryRoot: string | undefined;

  const fixture = { spaceId, userId };

  function expectStages(...next: Stage[]) {
    stages = next;
    stageCursor = 0;
  }

  function currentStage(): Stage {
    const stage = stages[stageCursor];
    stageCursor += 1;
    if (!stage) throw new Error("LangMem requested an unexpected model completion.");
    return stage;
  }

  const complete = async (request: MemoryCompletionRequest): Promise<MemoryCompletionResponse> => {
    if (request.tools.some((tool) => tool.name === "judge_memory_support")) {
      const candidates = JSON.parse(request.messages.at(-1)!.content) as Array<{
        index: number;
        memory: string;
      }>;
      const scripted = stages.flatMap((stage) =>
        stage.kind === "insert" ? stage.facts : [stage.fact],
      );
      expect(candidates.map((candidate) => candidate.memory)).toEqual(
        scripted.map((fact) => fact.content),
      );
      return {
        content: "",
        toolCalls: [
          {
            id: `support-${stamp}-${stageCursor}`,
            name: "judge_memory_support",
            args: {
              decisions: candidates.map(({ index }) => ({ index, supported: true })),
            },
          },
        ],
      };
    }
    const durable = request.tools.find((tool) => tool.name === "DurableFact");
    if (!durable) throw new Error("LangMem did not offer the DurableFact tool.");
    expect(propertyNames(durable)).toEqual(
      expect.arrayContaining(["content", "sourceMessageId", "sourceQuote", "category"]),
    );
    const stage = currentStage();
    if (stage.kind === "insert") {
      return {
        content: "",
        toolCalls: stage.facts.map((fact, offset) => ({
          id: `proposal-${stamp}-${stageCursor}-${offset}`,
          name: "DurableFact",
          args: {
            content: fact.content,
            sourceMessageId: fact.sourceMessageId,
            sourceQuote: fact.sourceQuote,
            category: fact.category,
          },
        })),
      };
    }
    const patch = request.tools.find((tool) => tool.name === "PatchDoc");
    if (!patch) throw new Error("LangMem did not offer the PatchDoc tool.");
    expect(propertyNames(patch)).toEqual(
      expect.arrayContaining(["json_doc_id", "planned_edits", "patches"]),
    );
    return {
      content: "",
      toolCalls: [
        {
          id: `patch-${stamp}-${stageCursor}`,
          name: "PatchDoc",
          args: {
            json_doc_id: stage.factId,
            planned_edits: "Replace the cited active fact with the correcting user message.",
            patches: [
              { op: "replace", path: "/content", value: stage.fact.content },
              { op: "replace", path: "/sourceMessageId", value: stage.fact.sourceMessageId },
              { op: "replace", path: "/sourceQuote", value: stage.fact.sourceQuote },
            ],
          },
        },
      ],
    };
  };

  async function startIndexService(): Promise<void> {
    if (
      !INDEX_PYTHON.startsWith("/") ||
      !LANGMEM_PYTHON.startsWith("/") ||
      !INDEX_SCRIPT.startsWith("/")
    ) {
      throw new Error("Synthetic integration needs explicit absolute runtime paths.");
    }
    await mkdir(OUTPUT_DIR, { recursive: true });
    temporaryRoot = await mkdtemp(join(tmpdir(), "rakazo-auto-memory-integration-"));
    const palace = join(temporaryRoot, "palace");
    const tokenFile = join(temporaryRoot, "token");
    await mkdir(palace, { mode: 0o700 });
    const token = randomBytes(48).toString("base64url");
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    const port = await freeLoopbackPort();
    if (port === 17676) throw new Error("Synthetic index must not use the deployed port.");
    const log = createWriteStream(join(OUTPUT_DIR, `integration-index-${stamp}.log`), {
      flags: "wx",
      mode: 0o600,
    });
    serviceLog = log;
    const child = spawn(
      INDEX_PYTHON,
      [
        "-I",
        INDEX_SCRIPT,
        "--palace-dir",
        palace,
        "--token-file",
        tokenFile,
        "--cache-dir",
        INDEX_CACHE,
        "--embedding-model",
        "embeddinggemma",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: temporaryRoot,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: temporaryRoot,
          TMPDIR: temporaryRoot,
          HF_HUB_CACHE: INDEX_CACHE,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
          ANONYMIZED_TELEMETRY: "False",
          MEMPALACE_EMBEDDING_THREADS: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    service = child;
    serviceExit = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.stderr?.on("data", (chunk: Buffer | string) => log.write(chunk));
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error("Synthetic local index did not announce readiness.")),
          120_000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Synthetic local index exited before readiness (${code ?? signal}).`));
        });
        child.stdout?.on("data", (chunk: Buffer | string) => {
          log.write(chunk);
          stdout += String(chunk);
          if (stdout.includes(`Local memory index listening on loopback port ${port}.`)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    } catch (error) {
      child.kill("SIGKILL");
      await serviceExit;
      throw error;
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    index = createLocalMemoryIndex({ baseUrl, token }, { allowedUrls: baseUrl });
  }

  async function stopIndexService(): Promise<void> {
    const child = service;
    service = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (serviceExit) {
      await Promise.race([
        serviceExit,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await serviceExit;
      }
    }
    if (serviceLog) {
      const log = serviceLog;
      serviceLog = undefined;
      await new Promise<void>((resolve, reject) =>
        log.end((error?: Error) => (error ? reject(error) : resolve())),
      );
    }
  }

  async function addMessage(role: "user" | "bot", text: string) {
    return runAsTenant(fixture, () =>
      createThreadMessage(prisma, {
        threadId,
        role,
        blocks: [{ kind: "text", text }],
        ...(role === "bot" ? { botId } : { authorUserId: userId }),
      }),
    );
  }

  async function addTurn(text: string, reply: string) {
    const user = await addMessage("user", text);
    const bot = await addMessage("bot", reply);
    return { user, bot };
  }

  async function createRun(
    status: "completed" | "running",
    sourceMessageId: string,
    label: string,
  ) {
    return runAsTenant(fixture, async () => {
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId,
          prompt: `Synthetic automatic-memory turn ${label}.`,
          status,
        },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId,
          taskId: task.id,
          sourceMessageId,
          trigger: "user",
          status,
          ...(status === "completed" ? { completedAt: new Date() } : {}),
        },
      });
    });
  }

  async function listFacts(includeHistory = false) {
    return runAsTenant(fixture, () =>
      facts.list({ botId, scope: "isolated", includeHistory }, ctx),
    ).then((page) => page.items);
  }

  async function recall(query: string) {
    return successfulValue(
      await runAsTenant(fixture, () =>
        provider.recall({ botId, scope: "isolated", query, limit: 5 }, ctx),
      ),
    );
  }

  async function outbox(factId: string) {
    return db.semanticMemoryIndexOutbox.findMany({
      where: { spaceId, factId },
      orderBy: [{ revision: "asc" }, { id: "asc" }],
      select: { indexId: true, revision: true, action: true },
    });
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !url.pathname.slice(1).startsWith("rkz_") ||
      !decodeURIComponent(url.username).startsWith("rkz_") ||
      url.pathname === "/rakazo"
    ) {
      throw new Error(
        "Automatic-memory integration requires a fresh rkz_ database and runtime login.",
      );
    }
    database = createDb(databaseUrl!, {
      encryptContent: true,
      applicationName: "automatic-memory-integration-test",
      poolMax: 8,
    });
    prisma = database.prisma;
    db = asSystem(prisma);
    archive = new MemoryArchiveStore(prisma);
    facts = new SemanticFactStore(prisma);
    ctx = {
      operationId: `automatic-memory-integration:${stamp}`,
      traceId: `automatic-memory-integration:${stamp}`,
      spaceId,
      userId,
      botId,
      signal: AbortSignal.timeout(480_000),
    };
    await runAsSystem("synthetic automatic-memory integration fixture", async () => {
      await prisma.user.create({
        data: { id: userId, name: "Synthetic Owner", email: `${userId}@rakazo.test` },
      });
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Synthetic" } });
      await prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId,
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.bot.create({
        data: { id: botId, spaceId, userId, name: "Synthetic", color: "ink" },
      });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    });
    await startIndexService();
    provider = createManagedMemoryProvider({ prisma, index });
    const memory = {
      read: async () => ({
        documents: [
          {
            id: `synthetic-note-${stamp}`,
            path: "MEMORY.md",
            content: "Synthetic standing note supplied only as extraction context.",
            revision: 1,
          },
        ],
      }),
    } as unknown as MemoryStore;
    const memoryProviders: MemoryProviderResolver = {
      resolve: async (requestedSpaceId) =>
        requestedSpaceId === spaceId ? { provider, defaultScope: "isolated" } : null,
    };
    const jobs: JobPublisher = {
      async enqueue(job) {
        enqueued.push(job);
      },
      async cancel() {},
      async close() {},
    };
    deps = {
      prisma,
      memory,
      memoryProviders,
      jobs,
      extractor: createLangMemExtractor({
        pythonPath: LANGMEM_PYTHON,
        scriptPath: LANGMEM_SCRIPT,
        complete,
      }),
    };
  }, 180_000);

  afterAll(async () => {
    await stopIndexService();
    if (database) {
      await database.prisma.$disconnect();
      await database.pool.end();
    }
  }, 30_000);

  it("archives, corrects, forgets, drains a clear and rejects the retired generation", async () => {
    const namespace = semanticFactNamespace(spaceId, "isolated", botId);

    // The older turn is context only: the first schedule must start at this run's own source.
    const historical = await addMessage("user", "合成历史背景：这段更早的聊天不属于本次自动归档。");
    const turn1 = await addTurn(
      "我偏好每周三上午做规划。合成标记 AM-J7Q。",
      "已记录你的规划偏好。",
    );
    const run1 = await createRun("completed", turn1.user.id, "one");
    expect(await archive.markPending(run1.id, ctx, new Date())).toBe(true);
    const firstBatch = await archive.loadBatch(target, ctx);
    expect(firstBatch).not.toBeNull();
    expect(firstBatch!.generation).toBe(0);
    expect(firstBatch!.newSources.map((source) => source.id)).toEqual([turn1.user.id]);
    expect(firstBatch!.messages.find((message) => message.id === historical.id)?.isNew).toBe(false);

    expectStages({
      kind: "insert",
      facts: [
        {
          content: content.preference,
          sourceMessageId: turn1.user.id,
          sourceQuote: "我偏好每周三上午做规划",
          category: "preference",
        },
      ],
    });
    enqueued.length = 0;
    await archiveConversationMemory(deps, target, ctx);
    expect(stageCursor).toBe(1);

    const afterFirst = await listFacts();
    expect(afterFirst).toHaveLength(1);
    const f1 = afterFirst[0]!;
    expect(f1).toMatchObject({ content: content.preference, revision: 1, status: "active" });
    expect(f1.provenance).toMatchObject({
      kind: "run",
      threadId,
      messageId: turn1.user.id,
      quote: "我偏好每周三上午做规划",
      category: "preference",
    });
    const progress1 = await runAsTenant(fixture, () =>
      prisma.memoryArchiveProgress.findUniqueOrThrow({ where: { threadId } }),
    );
    expect(progress1).toMatchObject({
      generation: 0,
      throughSeq: turn1.bot.seq,
      processedUpToSeq: turn1.bot.seq,
      pending: false,
    });
    expect(await archive.hasPending(target, ctx)).toBe(false);
    expect(enqueued.map((job) => job.name)).toEqual(["memory.sync"]);
    expect(await outbox(f1.id)).toEqual([
      { indexId: `sm:${f1.id}:1`, revision: 1, action: "upsert" },
    ]);
    await syncManagedMemoryIndex({ prisma, index }, spaceId, ctx.signal);
    expect(await db.semanticMemoryIndexOutbox.count({ where: { spaceId } })).toBe(0);
    expect(await index.search({ namespace, query: "AM-J7Q", limit: 10 }, ctx.signal)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: f1.id, revision: 1 })]),
    );

    // A correction is a conditional revision of the same fact, proposed through real LangMem.
    const turn2 = await addTurn(
      "更正一下，我改为每周四上午做规划。合成标记 AM-J7Q。",
      "已改为周四。",
    );
    const run2 = await createRun("completed", turn2.user.id, "two");
    expect(await archive.markPending(run2.id, ctx, new Date())).toBe(true);
    expectStages({
      kind: "patch",
      factId: f1.id,
      fact: {
        content: content.correction,
        sourceMessageId: turn2.user.id,
        sourceQuote: "改为每周四上午做规划",
        category: "preference",
      },
    });
    enqueued.length = 0;
    await archiveConversationMemory(deps, target, ctx);
    expect(stageCursor).toBe(1);

    const afterCorrection = await listFacts();
    expect(afterCorrection).toHaveLength(1);
    expect(afterCorrection[0]).toMatchObject({
      id: f1.id,
      content: content.correction,
      revision: 2,
      status: "active",
    });
    expect(afterCorrection[0]!.provenance).toMatchObject({
      messageId: turn2.user.id,
      quote: "改为每周四上午做规划",
    });
    expect(
      (
        await db.semanticFactRevision.findMany({
          where: { factId: f1.id },
          orderBy: { revision: "asc" },
          select: { revision: true },
        })
      ).map((row) => row.revision),
    ).toEqual([1, 2]);
    expect(await outbox(f1.id)).toEqual([
      { indexId: `sm:${f1.id}:1`, revision: 1, action: "delete" },
      { indexId: `sm:${f1.id}:2`, revision: 2, action: "upsert" },
    ]);
    await syncManagedMemoryIndex({ prisma, index }, spaceId, ctx.signal);
    const recalledCorrection = await recall("AM-J7Q");
    expect(recalledCorrection.find((result) => result.id === f1.id)).toMatchObject({
      revision: 2,
      memory: content.correction,
    });
    expect(recalledCorrection.some((result) => result.memory === content.preference)).toBe(false);

    // A durable reference fact, then an explicit forget. A later restatement proposes the
    // same content again, but the authority store must keep the tombstone and write nothing.
    const turn3 = await addTurn(
      "我的实验记录放在 /synthetic/experiments/run-42.md，标记 AM-K3V。",
      "已记录实验记录位置。",
    );
    const run3 = await createRun("completed", turn3.user.id, "three");
    expect(await archive.markPending(run3.id, ctx, new Date())).toBe(true);
    expectStages({
      kind: "insert",
      facts: [
        {
          content: content.reference,
          sourceMessageId: turn3.user.id,
          sourceQuote: "/synthetic/experiments/run-42.md",
          category: "reference",
        },
      ],
    });
    await archiveConversationMemory(deps, target, ctx);
    expect(stageCursor).toBe(1);
    const reference = (await listFacts()).find((fact) => fact.content === content.reference);
    expect(reference).toMatchObject({ revision: 1, status: "active" });
    await syncManagedMemoryIndex({ prisma, index }, spaceId, ctx.signal);
    const forgotten = await runAsTenant(fixture, () =>
      facts.forget({ id: reference!.id, botId, scope: "isolated", expectedRevision: 1 }, ctx),
    );
    expect(forgotten).toMatchObject({ id: reference!.id, expired: true });
    await syncManagedMemoryIndex({ prisma, index }, spaceId, ctx.signal);

    const turn4 = await addTurn(
      "再记一次：实验记录放在 /synthetic/experiments/run-42.md，标记 AM-K3V。",
      "没有再保存这条记录。",
    );
    const run4 = await createRun("completed", turn4.user.id, "four");
    expect(await archive.markPending(run4.id, ctx, new Date())).toBe(true);
    expectStages({
      kind: "insert",
      facts: [
        {
          content: content.reference,
          sourceMessageId: turn4.user.id,
          sourceQuote: "/synthetic/experiments/run-42.md",
          category: "reference",
        },
      ],
    });
    enqueued.length = 0;
    await archiveConversationMemory(deps, target, ctx);
    expect(stageCursor).toBe(1);
    const afterRestatement = await listFacts(true);
    expect(afterRestatement.find((fact) => fact.id === reference!.id)).toMatchObject({
      content: "[forgotten]",
      revision: 2,
      status: "forgotten",
    });
    // Forgetting erases the stored body, and the restatement must not have re-created it.
    expect(afterRestatement.some((fact) => fact.content === content.reference)).toBe(false);
    expect(enqueued).toHaveLength(0);
    const recalledForgotten = await recall("AM-K3V");
    expect(recalledForgotten.filter((result) => result.id === reference!.id)).toEqual([]);
    expect(recalledForgotten.filter((result) => result.memory === content.reference)).toEqual([]);

    // Clear must drain every scheduled source, including an unfinished run's user text,
    // then retain the durable facts and reject the stale pre-clear batch.
    const turn5 = await addTurn("项目决定：代号用 atlas-k92，标记 AM-P9S。", "已记录项目代号。");
    const run5 = await createRun("completed", turn5.user.id, "five");
    expect(await archive.markPending(run5.id, ctx, new Date())).toBe(true);
    const staleBatch = await archive.loadBatch(target, ctx);
    expect(staleBatch).not.toBeNull();
    expect(staleBatch!.generation).toBe(0);
    expect(staleBatch!.newSources.map((source) => source.id)).toEqual([turn5.user.id]);

    const turn6 = await addTurn("补充：项目将在周五评审，标记 AM-Q4W。", "好的。");
    const run6 = await createRun("running", turn6.user.id, "six");
    const prepared = await archive.prepareClear(target, ctx);
    expect(prepared.generation).toBe(0);
    expect(prepared.nextMessageSeq).toBe(turn6.bot.seq + 1);
    expect(await archive.hasPending(target, ctx)).toBe(true);
    expectStages({
      kind: "insert",
      facts: [
        {
          content: content.project,
          sourceMessageId: turn5.user.id,
          sourceQuote: "代号用 atlas-k92",
          category: "project",
        },
        {
          content: content.review,
          sourceMessageId: turn6.user.id,
          sourceQuote: "项目将在周五评审",
          category: "project",
        },
      ],
    });
    enqueued.length = 0;
    await archiveConversationMemory(deps, target, ctx, { force: true });
    expect(stageCursor).toBe(1);
    expect(await archive.hasPending(target, ctx)).toBe(false);
    expect(await archive.pending(100)).toEqual([]);
    expect(enqueued.map((job) => job.name)).toEqual(["memory.sync"]);
    const progress6 = await runAsTenant(fixture, () =>
      prisma.memoryArchiveProgress.findUniqueOrThrow({ where: { threadId } }),
    );
    expect(progress6.processedUpToSeq).toBeGreaterThanOrEqual(turn6.user.seq);
    expect(progress6.throughSeq).toBeGreaterThanOrEqual(turn6.user.seq);
    expect(progress6.pending).toBe(false);
    const activeBeforeClear = await listFacts();
    const project = activeBeforeClear.find((fact) => fact.content === content.project);
    const review = activeBeforeClear.find((fact) => fact.content === content.review);
    expect(project).toMatchObject({ revision: 1, status: "active" });
    expect(review).toMatchObject({ revision: 1, status: "active" });
    expect(await outbox(project!.id)).toEqual([
      { indexId: `sm:${project!.id}:1`, revision: 1, action: "upsert" },
    ]);
    expect(await outbox(review!.id)).toEqual([
      { indexId: `sm:${review!.id}:1`, revision: 1, action: "upsert" },
    ]);
    await syncManagedMemoryIndex({ prisma, index }, spaceId, ctx.signal);
    expect(await index.search({ namespace, query: "AM-P9S", limit: 10 }, ctx.signal)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project!.id, revision: 1 })]),
    );
    expect(await index.search({ namespace, query: "AM-Q4W", limit: 10 }, ctx.signal)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: review!.id, revision: 1 })]),
    );

    const cleared = await runAsTenant(fixture, () =>
      createThreadEvents(prisma).clearThread({
        spaceId,
        threadId,
        botId,
        expectedGeneration: prepared.generation,
        expectedNextMessageSeq: prepared.nextMessageSeq,
      }),
    );
    expect(cleared.historyCompactionGeneration).toBe(0);
    expect(await db.message.count({ where: { threadId } })).toBe(0);
    expect(
      (await db.thread.findUniqueOrThrow({ where: { id: threadId } })).historyCompactionGeneration,
    ).toBe(1);
    expect(
      await db.run.findUniqueOrThrow({ where: { id: run6.id }, select: { status: true } }),
    ).toEqual({ status: "cancelled" });

    const afterClear = await listFacts(true);
    expect(afterClear.find((fact) => fact.id === f1.id)).toMatchObject({
      content: content.correction,
      revision: 2,
      status: "active",
    });
    expect(afterClear.find((fact) => fact.id === project!.id)).toMatchObject({
      content: content.project,
      revision: 1,
      status: "active",
    });
    expect(afterClear.find((fact) => fact.id === review!.id)).toMatchObject({
      content: content.review,
      revision: 1,
      status: "active",
    });
    expect(afterClear.find((fact) => fact.id === reference!.id)).toMatchObject({
      content: "[forgotten]",
      revision: 2,
      status: "forgotten",
    });
    const recalledAfterClear = await recall("AM-J7Q");
    expect(recalledAfterClear.find((result) => result.id === f1.id)).toMatchObject({
      revision: 2,
      memory: content.correction,
    });
    expect(recalledAfterClear.some((result) => result.memory === content.preference)).toBe(false);
    const recalledForgottenAfterClear = await recall("AM-K3V");
    expect(recalledForgottenAfterClear.filter((result) => result.id === reference!.id)).toEqual([]);

    const staleChange: MemoryExtractionChange = {
      content: content.project,
      sourceMessageId: turn5.user.id,
      sourceQuote: "代号用 atlas-k92",
      category: "project",
    };
    expect(await archive.applyBatch(staleBatch!, [staleChange], ctx)).toEqual({
      saved: 0,
      updated: 0,
      skipped: 1,
      removed: 0,
    });
    expect((await listFacts(true)).filter((fact) => fact.content === content.project)).toHaveLength(
      1,
    );
    expect(await archive.loadBatch(target, ctx)).toBeNull();
    expect(await archive.hasPending(target, ctx)).toBe(false);
    expect(await archive.pending(100)).toEqual([]);
  }, 300_000);
});
