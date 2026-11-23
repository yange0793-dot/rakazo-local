CREATE TABLE "local_export_grants" (
  "digest" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
