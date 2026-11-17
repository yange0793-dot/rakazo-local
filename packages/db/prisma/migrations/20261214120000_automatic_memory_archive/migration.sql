-- Additive automatic-archive cursor. Older releases do not read this table and its rows hold
-- no message text, only the source generation and the sequence range this feature scheduled.
CREATE TABLE "memory_archive_progress" (
  "threadId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "throughSeq" INTEGER NOT NULL,
  "processedUpToSeq" INTEGER NOT NULL,
  "pending" BOOLEAN NOT NULL DEFAULT true,
  "availableAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "memory_archive_progress_pkey" PRIMARY KEY ("threadId"),
  CONSTRAINT "memory_archive_progress_scope_check" CHECK ("scope" IN ('isolated', 'shared')),
  CONSTRAINT "memory_archive_progress_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "memory_archive_progress_cursor_check"
    CHECK ("throughSeq" >= -1 AND "processedUpToSeq" >= -1 AND "processedUpToSeq" <= "throughSeq"),
  CONSTRAINT "memory_archive_progress_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "memory_archive_progress_pending_availableAt_threadId_idx"
  ON "memory_archive_progress"("pending", "availableAt", "threadId");

ALTER TABLE "memory_archive_progress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_archive_progress_tenant ON "memory_archive_progress"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY memory_archive_progress_system ON "memory_archive_progress"
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "memory_archive_progress" TO rakazo_app;
  END IF;
END $$;
