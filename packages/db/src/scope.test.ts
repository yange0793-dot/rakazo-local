import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(found: boolean, lastActive: string[] = []) {
  return {
    $queryRaw: vi.fn(async () => lastActive.map((spaceId) => ({ spaceId }))),
    space: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        organizationId: `org-of-${where.id}`,
      })),
    },
    spaceMember: {
      findFirst: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { userId: string; spaceId?: string };
          select: Record<string, unknown>;
        }) => {
          if (select.organizationId) return { organizationId: "org-first" };
          return found
            ? {
                userId: where.userId,
                spaceId: where.spaceId ?? "space-default",
                member: { user: { email: "owner@example.test" } },
              }
            : null;
        },
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })),
    },
  } as unknown as PrismaClient;
}

describe("requireMembership", () => {
  it("scopes the actor without granting privileges to a stored deployment owner", async () => {
    const prisma = prismaForMembership(true);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toEqual({
      userId: "user-1",
      spaceId: "space-support",
      email: "owner@example.test",
      isDeploymentOwner: false,
    });
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", spaceId: "space-support" },
      }),
    );
  });

  it("rejects a requested space the user does not belong to", async () => {
    await expect(
      requireMembership(prismaForMembership(false), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("selects the explicit default Space before older non-default memberships", async () => {
    const prisma = prismaForMembership(true);

    await requireMembership(prisma, "user-1");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", organizationId: "org-first", space: { deletingAt: null } },
        orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("without a requested Space, opens the organization the user was last active in", async () => {
    const prisma = prismaForMembership(true, ["space-recent"]);

    await requireMembership(prisma, "user-1");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          organizationId: "org-of-space-recent",
          space: { deletingAt: null },
        },
      }),
    );
  });

  it("does not look up recent activity for a requested Space", async () => {
    const prisma = prismaForMembership(true, ["space-recent"]);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toMatchObject({
      spaceId: "space-support",
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
