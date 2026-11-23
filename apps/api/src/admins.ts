import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma">;

/** The local deployment owner, not an arbitrary messaging or space member. */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return settings?.ownerUserId === userId;
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
