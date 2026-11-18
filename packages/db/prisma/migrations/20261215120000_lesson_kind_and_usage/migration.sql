-- Additive: an experience kind for host-managed semantic facts, and per-run bookkeeping of
-- which lessons were injected. Older releases never write 'lesson' and never read lesson_usage.
-- A rolling deploy may briefly list rows whose kind it does not know; its oRPC output schema
-- rejects them, which is why the API and worker restart together.

ALTER TABLE "semantic_facts" DROP CONSTRAINT "semantic_facts_kind_check";
ALTER TABLE "semantic_facts"
  ADD CONSTRAINT "semantic_facts_kind_check"
  CHECK ("kind" IN ('durable', 'history', 'lesson'));

ALTER TABLE "runs" ADD COLUMN "tainted" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "lesson_usage" (
  "spaceId"    TEXT NOT NULL,
  "botId"      TEXT NOT NULL,
  "lessonId"   TEXT NOT NULL,
  "runId"      TEXT NOT NULL,
  "surfacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "outcome"    TEXT,
  "settledAt"  TIMESTAMP(3),
  CONSTRAINT "lesson_usage_pkey" PRIMARY KEY ("runId", "lessonId"),
  CONSTRAINT "lesson_usage_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('completed', 'failed', 'denied')),
  CONSTRAINT "lesson_usage_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "lesson_usage_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "lesson_usage_lessonId_outcome_idx" ON "lesson_usage"("lessonId", "outcome");

ALTER TABLE "lesson_usage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY lesson_usage_tenant ON "lesson_usage"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY lesson_usage_system ON "lesson_usage"
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "lesson_usage" TO rakazo_app;
  END IF;
END $$;
