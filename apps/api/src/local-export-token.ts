import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

const TOKEN_TTL_MS = 60_000;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export async function issueLocalAccountExportToken(
  prisma: PrismaClient,
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await runAsSystem("issue local account export token", () =>
    prisma.$transaction(async (tx) => {
      await tx.localExportGrant.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await tx.localExportGrant.create({
        data: { digest: digest(token), userId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
      });
    }),
  );
  return token;
}

export async function consumeLocalAccountExportToken(
  prisma: PrismaClient,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  return runAsSystem("consume local account export token", async () => {
    const [consumed] = await prisma.$queryRaw<Array<{ userId: string }>>`
      DELETE FROM "local_export_grants" WHERE "digest" = ${digest(token)}
      AND "expiresAt" > CURRENT_TIMESTAMP RETURNING "userId"`;
    return consumed?.userId ?? null;
  });
}
