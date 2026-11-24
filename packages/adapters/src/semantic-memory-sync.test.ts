import type {
  AdapterContext,
  BackgroundJob,
  JobPublisher,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MEMORY_PROVIDER_ID } from "./local-memory-index.js";
import { reconcileSemanticMemoryIndex, syncSemanticMemorySpace } from "./semantic-memory-sync.js";

const pendingIndexWork = vi.hoisted(() => vi.fn());
const observedScopes: Array<ReturnType<typeof currentDbContext>> = [];
vi.mock("@rakazo/db", async (importOriginal) => {
  const scopes = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...scopes,
    SemanticFactStore: class {
      pendingIndexWork(limit: number, spaceId?: string, eligibleSpaceIds?: readonly string[]) {
        // Capture before Vitest's async mock dispatcher enters its own execution context.
        observedScopes.push(scopes.currentDbContext());
        return pendingIndexWork(limit, spaceId, eligibleSpaceIds);
      }
    },
  };
});

beforeEach(() => {
  pendingIndexWork.mockReset();
  observedScopes.length = 0;
});

const prisma = {} as PrismaClient;
const pointer = { id: "work-a", spaceId: "space-a", userId: "user-a" };

describe("semantic index synchronization", () => {
  it("does not resolve credentials when the space has no pending work", async () => {
    pendingIndexWork.mockResolvedValue([]);
    const memoryProviders = { resolve: vi.fn() };
    await syncSemanticMemorySpace({ prisma, memoryProviders }, "space-a");
    expect(pendingIndexWork).toHaveBeenCalledWith(1, "space-a", undefined);
    expect(memoryProviders.resolve).not.toHaveBeenCalled();
  });

  it("loads the durable owner before invoking the provider in that tenant context", async () => {
    pendingIndexWork.mockResolvedValue([pointer]);
    const received: AdapterContext[] = [];
    const scopes: Array<ReturnType<typeof currentDbContext>> = [];
    const memoryProviders = {
      async resolve() {
        scopes.push(currentDbContext());
        return {
          provider: {
            async syncIndex(context: AdapterContext) {
              scopes.push(currentDbContext());
              received.push(context);
              return { ok: true as const, value: undefined };
            },
          } as unknown as SemanticMemoryProvider,
          defaultScope: "isolated" as const,
        };
      },
    };
    await syncSemanticMemorySpace({ prisma, memoryProviders }, "space-a");
    expect(observedScopes[0]?.kind).toBe("system");
    expect(scopes).toEqual([
      { kind: "tenant", spaceId: "space-a", userId: "user-a" },
      { kind: "tenant", spaceId: "space-a", userId: "user-a" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      spaceId: "space-a",
      userId: "user-a",
      operationId: "memory.sync:space-a",
    });
  });

  it("keeps missing-connection and index failures visible to deletion and job retries", async () => {
    pendingIndexWork.mockResolvedValue([pointer]);
    await expect(
      syncSemanticMemorySpace(
        { prisma, memoryProviders: { resolve: async () => null } },
        "space-a",
      ),
    ).rejects.toThrow("Reconnect local memory");
    const memoryProviders = {
      resolve: async () => ({
        provider: {
          syncIndex: async () => ({ ok: false as const, error: "synthetic index unavailable" }),
        } as unknown as SemanticMemoryProvider,
        defaultScope: "isolated" as const,
      }),
    };
    await expect(syncSemanticMemorySpace({ prisma, memoryProviders }, "space-a")).rejects.toThrow(
      "synthetic index unavailable",
    );
  });

  it("recovers one keyed job per pending space without sending fact text to the queue", async () => {
    pendingIndexWork.mockResolvedValue([
      pointer,
      { ...pointer, id: "work-b" },
      { id: "work-c", spaceId: "space-b", userId: "user-b" },
    ]);
    const configured = {
      spaceMemoryConfig: {
        findMany: vi.fn(async () => [{ spaceId: "space-a" }, { spaceId: "space-b" }]),
      },
    } as unknown as PrismaClient;
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    await reconcileSemanticMemoryIndex({
      prisma: configured,
      jobs: { enqueue } as unknown as JobPublisher,
    });
    expect(configured.spaceMemoryConfig.findMany).toHaveBeenCalledWith({
      where: { provider: LOCAL_MEMORY_PROVIDER_ID },
      select: { spaceId: true },
    });
    expect(pendingIndexWork).toHaveBeenCalledWith(100, undefined, ["space-a", "space-b"]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([job]) => job.payload)).toEqual([
      { spaceId: "space-a" },
      { spaceId: "space-b" },
    ]);
    expect(enqueue.mock.calls.every(([job]) => job.keepExisting === true)).toBe(true);
  });

  it("does not re-enqueue a space whose memory provider is disconnected", async () => {
    pendingIndexWork.mockResolvedValue([pointer]);
    const disconnected = {
      spaceMemoryConfig: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    await reconcileSemanticMemoryIndex({
      prisma: disconnected,
      jobs: { enqueue } as unknown as JobPublisher,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(pendingIndexWork).not.toHaveBeenCalled();
  });

  it("finds the 101st space when the first 100 pending spaces are disconnected", async () => {
    const connected = { id: "work-101", spaceId: "space-101", userId: "user-101" };
    const backlog = [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `work-${index}`,
        spaceId: `disconnected-${index}`,
        userId: "user-a",
      })),
      connected,
    ];
    const configured = {
      spaceMemoryConfig: {
        findMany: vi.fn(async () => [{ spaceId: "space-101" }]),
      },
    } as unknown as PrismaClient;
    pendingIndexWork.mockImplementation(
      async (limit: number, _spaceId?: string, eligibleSpaceIds?: readonly string[]) =>
        backlog
          .filter((work) => !eligibleSpaceIds || eligibleSpaceIds.includes(work.spaceId))
          .slice(0, limit),
    );
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);

    await reconcileSemanticMemoryIndex({
      prisma: configured,
      jobs: { enqueue } as unknown as JobPublisher,
    });

    expect(pendingIndexWork).toHaveBeenCalledWith(100, undefined, ["space-101"]);
    expect(enqueue.mock.calls.map(([job]) => job.payload)).toEqual([{ spaceId: "space-101" }]);
  });
});
