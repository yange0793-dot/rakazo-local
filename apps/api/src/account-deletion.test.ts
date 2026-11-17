import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import { destroyBot } from "@rakazo/adapters";
import type * as Db from "@rakazo/db";
import {
  claimOrganizationForDeletion,
  claimSpacesLeavingWithAccount,
  deleteClaimedSpace,
  expireSpaceDeletionClaims,
  leaveInvitedSpaces,
  recordAuditEvent,
  restoreSpaceDeletionClaims,
  setOrganizationDeletionLease,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAccountContent, deleteOrganization } from "./account-deletion.js";

const pendingIndexWork = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  SemanticFactStore: class {
    pendingIndexWork = pendingIndexWork;
  },
  claimOrganizationForDeletion: vi.fn(),
  claimSpacesLeavingWithAccount: vi.fn(),
  expireSpaceDeletionClaims: vi.fn(async () => undefined),
  restoreSpaceDeletionClaims: vi.fn(async () => undefined),
  leaveInvitedSpaces: vi.fn(async () => undefined),
  deletePageShareSecrets: vi.fn(async () => []),
  keepOrganizationTrialUse: vi.fn(async () => undefined),
  setOrganizationDeletionLease: vi.fn(),
  deleteClaimedSpace: vi.fn(),
  deleteEmptyOrganization: vi.fn(async () => undefined),
  releaseOrganizationDeletionClaim: vi.fn(async () => undefined),
  recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  destroyBot: vi.fn(async () => undefined),
}));

beforeEach(() => pendingIndexWork.mockReset().mockResolvedValue([]));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("deleteOrganization lease", () => {
  let spacesLeft: number;
  const prisma = {
    organization: { findUnique: vi.fn(async () => ({ name: "Work" })) },
    artifact: { findMany: vi.fn(async () => []) },
    bot: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    space: { count: vi.fn(async () => spacesLeft) },
  };
  const deps = (overrides: Record<string, unknown> = {}) =>
    ({
      prisma,
      artifacts: { remove: vi.fn(async () => undefined) },
      ...overrides,
    }) as unknown as Parameters<typeof deleteOrganization>[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spacesLeft = 1;
    vi.mocked(claimOrganizationForDeletion).mockResolvedValue({
      claimId: "organization-deletion:org-1:attempt",
      spaceIds: ["space-1"],
      fresh: true,
    });
    vi.mocked(setOrganizationDeletionLease).mockImplementation(async () => spacesLeft > 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes and records a deletion whose last file cleanup outlasts the lease", async () => {
    const cleanup = deferred();
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      spacesLeft = 0;
      return { artifactKeys: ["blob-1"], pageShareSecrets: [] };
    });
    const remove = vi.fn(() => cleanup.promise);

    const deleting = deleteOrganization(deps({ artifacts: { remove } }), "user-1", "org-1");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    cleanup.resolve();

    await expect(deleting).resolves.toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledOnce();
  });

  it("stops before teardown once renewals fail for most of the lease", async () => {
    const billing = deferred();
    let billingCalled = false;
    vi.mocked(setOrganizationDeletionLease).mockRejectedValue(new Error("database unavailable"));

    const deleting = deleteOrganization(
      deps({
        billing: {
          cancelForDeletedOrganization: () => {
            billingCalled = true;
            return billing.promise;
          },
        },
      }),
      "user-1",
      "org-1",
    );
    deleting.catch(() => undefined);
    await vi.waitFor(() => expect(billingCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    await expect(deleting).rejects.toThrow("lost its claim");
    billing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps the organization claimed when pending memory cleanup is disconnected", async () => {
    pendingIndexWork.mockResolvedValue([
      { id: "index-work-1", spaceId: "space-1", userId: "user-1" },
    ]);
    const retireScope = vi.fn(async () => undefined);

    await expect(
      deleteOrganization(
        deps({ semanticFacts: { retireScope, purgeHistory: vi.fn() } }),
        "user-1",
        "org-1",
      ),
    ).rejects.toThrow("Reconnect local memory");

    expect(retireScope).toHaveBeenCalledWith(
      { spaceId: "space-1" },
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
    expect(deleteClaimedSpace).not.toHaveBeenCalled();
    expect(setOrganizationDeletionLease).toHaveBeenCalledWith(prisma, {
      organizationId: "org-1",
      claimId: "organization-deletion:org-1:attempt",
      at: new Date(0),
    });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("account semantic memory cleanup", () => {
  const prisma = {
    bot: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    botDeletion: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(),
  };
  const makeDeps = (overrides: Record<string, unknown> = {}) =>
    ({
      prisma,
      artifacts: { remove: vi.fn(async () => undefined) },
      ...overrides,
    }) as unknown as Parameters<typeof deleteAccountContent>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimSpacesLeavingWithAccount).mockResolvedValue({
      claimId: "account-deletion:user-1",
      attemptId: "attempt-1",
      spaceIds: ["space-claimed"],
      takenOver: [],
    });
    vi.mocked(deleteClaimedSpace).mockResolvedValue({ artifactKeys: [], pageShareSecrets: [] });
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    );
  });

  it("retires and synchronizes only claimed spaces, not invited spaces that survive", async () => {
    const order: string[] = [];
    const retireScope = vi.fn(async () => {
      order.push("retire");
    });
    const semanticFacts = { retireScope, purgeHistory: vi.fn(async () => undefined) };
    pendingIndexWork.mockResolvedValue([
      { id: "index-work-1", spaceId: "space-claimed", userId: "user-1" },
    ]);
    const syncIndex = vi.fn(async () => {
      order.push("index");
      return { ok: true as const, value: undefined };
    });
    const memoryProviders = {
      resolve: vi.fn(async () => ({
        provider: { syncIndex } as unknown as SemanticMemoryProvider,
        defaultScope: "shared" as const,
      })),
    };
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      order.push("cascade");
      return { artifactKeys: [], pageShareSecrets: [] };
    });

    await deleteAccountContent(makeDeps({ semanticFacts, memoryProviders }), "user-1");

    expect(leaveInvitedSpaces).toHaveBeenCalledWith(prisma, "user-1", expect.any(Function));
    expect(retireScope).toHaveBeenCalledTimes(1);
    expect(retireScope).toHaveBeenCalledWith(
      { spaceId: "space-claimed" },
      expect.objectContaining({ spaceId: "space-claimed", userId: "user-1" }),
    );
    expect(pendingIndexWork).toHaveBeenCalledWith(1, "space-claimed");
    expect(memoryProviders.resolve).toHaveBeenCalledTimes(1);
    expect(memoryProviders.resolve).toHaveBeenCalledWith("space-claimed");
    expect(order).toEqual(["retire", "index", "cascade"]);
    expect(expireSpaceDeletionClaims).not.toHaveBeenCalled();
  });

  it("fails visibly without erasing credentials when pending index work has no resolver", async () => {
    pendingIndexWork.mockResolvedValue([
      { id: "index-work-1", spaceId: "space-claimed", userId: "user-1" },
    ]);
    const semanticFacts = {
      retireScope: vi.fn(async () => undefined),
      purgeHistory: vi.fn(async () => undefined),
    };

    await expect(
      deleteAccountContent(makeDeps({ semanticFacts }), "user-1"),
    ).rejects.toThrow("Reconnect local memory");

    expect(deleteClaimedSpace).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.botDeletion.findMany).not.toHaveBeenCalled();
    expect(restoreSpaceDeletionClaims).not.toHaveBeenCalled();
    expect(expireSpaceDeletionClaims).toHaveBeenCalledWith(prisma, {
      claimId: "account-deletion:user-1",
      attemptId: "attempt-1",
    });
  });

  it("expires its own claim for retry when the index cleanup returns an error", async () => {
    pendingIndexWork.mockResolvedValue([
      { id: "index-work-1", spaceId: "space-claimed", userId: "user-1" },
    ]);
    const memoryProviders = {
      resolve: vi.fn(async () => ({
        provider: {
          syncIndex: async () => ({ ok: false as const, error: "Synthetic index unavailable" }),
        } as unknown as SemanticMemoryProvider,
        defaultScope: "isolated" as const,
      })),
    };

    await expect(
      deleteAccountContent(makeDeps({ memoryProviders }), "user-1"),
    ).rejects.toThrow("Synthetic index unavailable");

    expect(destroyBot).not.toHaveBeenCalled();
    expect(deleteClaimedSpace).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(expireSpaceDeletionClaims).toHaveBeenCalledOnce();
  });
});
