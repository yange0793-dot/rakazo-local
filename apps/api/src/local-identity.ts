import { randomUUID } from "node:crypto";
import {
  isLocalInstallSessionId,
  LOCAL_INSTALL_SESSION_ID,
  LOCAL_INSTALL_SESSION_PREFIX,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, runAsSystem } from "@rakazo/db";

export const LOCAL_USER_EMAIL = "local@rakazo.local";
export const LOCAL_SESSION_ID = LOCAL_INSTALL_SESSION_ID;

export function requestLocalSessionId(request: Request): string {
  const supplied = request.headers.get("x-rakazo-install-id") ?? "";
  return isLocalInstallSessionId(supplied) ? supplied : LOCAL_SESSION_ID;
}

export function newLocalSessionId(): string {
  return `${LOCAL_INSTALL_SESSION_PREFIX}${randomUUID()}`;
}

export async function ensureLocalIdentity(prisma: PrismaClient) {
  return runAsSystem("initialize local identity", async () => {
    const user = await prisma.user.upsert({
      where: { email: LOCAL_USER_EMAIL },
      create: {
        id: randomUUID(),
        name: "Local",
        email: LOCAL_USER_EMAIL,
        emailVerified: true,
      },
      update: {},
      select: { id: true, name: true, email: true },
    });
    const membership = await prisma.spaceMember.findFirst({
      where: { userId: user.id, space: { deletingAt: null } },
      select: { id: true },
    });
    if (!membership) {
      await bootstrapUserSpace(prisma, user);
    }
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: user.id },
      update: { ownerUserId: user.id },
    });
    return user;
  });
}
