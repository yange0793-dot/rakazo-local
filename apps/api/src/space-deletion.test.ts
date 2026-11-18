import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import { destroyBot } from "@rakazo/adapters";
import type * as Db from "@rakazo/db";
import {
  claimSpaceDeletionForMember,
  deleteClaimedSpaceForMember,
  listClaimedSpaceBots,
  listClaimedSpaceComputers,
  renewSpaceDeletionClaim,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rehomeItemsLeaving } from "./availability.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { deleteSpaceWithContent } from "./space-deletion.js";

const pendingIndexWork = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  SemanticFactStore: class {
    pendingIndexWork = pendingIndexWork;
  },
  claimSpaceDeletionForMember: vi.fn(),
  deleteClaimedSpaceForMember: vi.fn(),
  listClaimedSpaceBots: vi.fn(),
  listClaimedSpaceComputers: vi.fn(),
  releaseSpaceDeletionClaim: vi.fn(async () => undefined),
  renewSpaceDeletionClaim: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  destroyBot: vi.fn(async () => undefined),
}));

vi.mock("./availability.js", () => ({
  rehomeItemsLeaving: vi.fn(async () => undefined),
}));

const actor = { spaceId: "space-active", userId: "user-1" };
const removedSpaceId = "space-removed";
const deleted = {
  id: "space-active",
  artifactKeys: [],
  homeKeys: [],
  pageShareSecrets: [],
};
const pointer = { id: "index-work-1", spaceId: removedSpaceId, userId: actor.userId };

const indexOutbox = vi.hoisted(() => ({ deleteMany: vi.fn(async () => ({ count: 0 })) }));

function makeDeps(overrides: Partial<SpaceDeletionDeps> = {}): SpaceDeletionDeps {
  return {
    prisma: { semanticMemoryIndexOutbox: indexOutbox },
    sandbox: {},
    home: {},
    jobs: {},
    artifacts: {},
    dataDir: "unused",
    ...overrides,
  } as unknown as SpaceDeletionDeps;
}

function makeFacts() {
  return {
    retireScope: vi.fn(async () => undefined),
    purgeHistory: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingIndexWork.mockReset().mockResolvedValue([]);
  vi.mocked(claimSpaceDeletionForMember).mockResolvedValue({
    claimId: "space-delete-claim",
    recovered: false,
  });
  vi.mocked(renewSpaceDeletionClaim).mockResolvedValue(true);
  vi.mocked(listClaimedSpaceBots).mockResolvedValue([]);
  vi.mocked(listClaimedSpaceComputers).mockResolvedValue([]);
  vi.mocked(deleteClaimedSpaceForMember).mockResolvedValue(deleted);
  vi.mocked(destroyBot).mockResolvedValue(undefined);
});

describe("space semantic memory cleanup", () => {
  it("retires the claimed space and drains its index before the final cascade", async () => {
    const order: string[] = [];
    const semanticFacts = makeFacts();
    semanticFacts.retireScope.mockImplementation(async () => {
      order.push("retire");
    });
    pendingIndexWork.mockResolvedValue([pointer]);
    vi.mocked(listClaimedSpaceBots).mockResolvedValue([
      {
        id: "bot-removed",
        spaceId: removedSpaceId,
        userId: actor.userId,
        name: "Removed",
        archivedAt: null,
        computerId: null,
        webhookSecretId: null,
      },
    ]);
    vi.mocked(destroyBot).mockImplementation(async () => {
      order.push("bot");
    });
    const syncIndex = vi.fn(async () => {
      order.push("index");
      return { ok: true as const, value: undefined };
    });
    const memoryProviders = {
      resolve: vi.fn(async () => ({
        provider: { syncIndex } as unknown as SemanticMemoryProvider,
        defaultScope: "isolated" as const,
      })),
    };
    vi.mocked(deleteClaimedSpaceForMember).mockImplementation(async () => {
      order.push("cascade");
      return deleted;
    });

    await expect(
      deleteSpaceWithContent(makeDeps({ semanticFacts, memoryProviders }), actor, removedSpaceId),
    ).resolves.toEqual({ activeSpaceId: actor.spaceId });

    expect(semanticFacts.retireScope).toHaveBeenCalledWith(
      { spaceId: removedSpaceId },
      expect.objectContaining({ spaceId: removedSpaceId, userId: actor.userId }),
    );
    expect(destroyBot).toHaveBeenCalledWith(
      expect.objectContaining({ semanticFacts }),
      expect.objectContaining({ id: "bot-removed" }),
      expect.any(Object),
      { deleteMemories: true, strictTeardown: true },
    );
    expect(pendingIndexWork).toHaveBeenCalledWith(1, removedSpaceId);
    expect(memoryProviders.resolve).toHaveBeenCalledWith(removedSpaceId);
    expect(order).toEqual(["retire", "bot", "index", "cascade"]);
  });

  it("allows a space with no pending index work to be deleted without a resolver", async () => {
    await expect(deleteSpaceWithContent(makeDeps(), actor, removedSpaceId)).resolves.toEqual({
      activeSpaceId: actor.spaceId,
    });
    expect(pendingIndexWork).toHaveBeenCalledWith(1, removedSpaceId);
    expect(deleteClaimedSpaceForMember).toHaveBeenCalledOnce();
  });

  it("still deletes the space when pending cleanup has no resolver", async () => {
    pendingIndexWork.mockResolvedValue([pointer]);

    await expect(
      deleteSpaceWithContent(makeDeps({ semanticFacts: makeFacts() }), actor, removedSpaceId),
    ).resolves.toEqual({ activeSpaceId: actor.spaceId });

    expect(deleteClaimedSpaceForMember).toHaveBeenCalledOnce();
    expect(rehomeItemsLeaving).toHaveBeenCalledOnce();
    expect(indexOutbox.deleteMany).toHaveBeenCalledWith({ where: { spaceId: removedSpaceId } });
  });

  it("still deletes the space when the index reports an error", async () => {
    pendingIndexWork.mockResolvedValue([pointer]);
    const syncIndex = vi.fn(async () => ({
      ok: false as const,
      error: "Synthetic index unavailable",
    }));
    const memoryProviders = {
      resolve: vi.fn(async () => ({
        provider: { syncIndex } as unknown as SemanticMemoryProvider,
        defaultScope: "isolated" as const,
      })),
    };

    await expect(
      deleteSpaceWithContent(
        makeDeps({ semanticFacts: makeFacts(), memoryProviders }),
        actor,
        removedSpaceId,
      ),
    ).resolves.toEqual({ activeSpaceId: actor.spaceId });

    expect(deleteClaimedSpaceForMember).toHaveBeenCalledOnce();
  });
});
