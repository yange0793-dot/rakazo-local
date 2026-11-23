import { randomUUID } from "node:crypto";
import { LOCAL_INSTALL_SESSION_PREFIX } from "@rakazo/contracts";
import { createDb, createOrganizationWithDefaultSpace, runAsSystem } from "@rakazo/db";

export { DestinationEmulator, McpEmulator } from "@rakazo/adapters";

type TestApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

/** Business fixtures share the local owner but keep their resources in separate spaces. */
export async function createTestSpace(
  app: TestApp,
  name = "Test",
  databaseUrl = process.env.DATABASE_URL!,
): Promise<string> {
  const response = await app.request("/api/local-identity");
  if (!response.ok) throw new Error(`Local identity failed (${response.status})`);
  const user = (await response.json()) as { id: string };
  const { prisma, pool } = createDb(databaseUrl);
  try {
    return await runAsSystem("create local business test space", async () => {
      await prisma.user.update({ where: { id: user.id }, data: { name } });
      return createOrganizationWithDefaultSpace(prisma, {
        userId: user.id,
        orgId: randomUUID(),
        name: name.slice(0, 60),
        slug: `test-${randomUUID()}`,
      });
    });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

export function testSpaceHeaders(spaceId: string) {
  return {
    "x-rakazo-space-id": spaceId,
    "x-rakazo-install-id": `${LOCAL_INSTALL_SESSION_PREFIX}${spaceId}`,
  };
}
