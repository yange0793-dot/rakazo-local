-- Additive rollout. Old releases keep reading/writing the existing playbook fields.
-- Legacy saved skills get their first truthful snapshot lazily, never fabricated history.
ALTER TABLE "taught_skills"
  ADD COLUMN "currentRevisionId" TEXT,
  ADD COLUMN "currentRevisionGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "taught_skill_revisions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "previousRevisionId" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "taught_skill_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "taught_skill_revisions_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "taught_skill_revisions_id_spaceId_skillId_key"
  ON "taught_skill_revisions" ("id", "spaceId", "skillId");
CREATE INDEX "taught_skill_revisions_spaceId_skillId_createdAt_id_idx"
  ON "taught_skill_revisions" ("spaceId", "skillId", "createdAt", "id");
ALTER TABLE "taught_skill_revisions"
  ADD CONSTRAINT "taught_skill_revisions_previousRevisionId_spaceId_skillId_fkey"
  FOREIGN KEY ("previousRevisionId", "spaceId", "skillId")
  REFERENCES "taught_skill_revisions" ("id", "spaceId", "skillId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "taught_skills"
  ADD CONSTRAINT "taught_skills_currentRevisionId_spaceId_id_fkey"
  FOREIGN KEY ("currentRevisionId", "spaceId", "id")
  REFERENCES "taught_skill_revisions" ("id", "spaceId", "skillId")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "run_taught_skill_revisions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "revisionId" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_taught_skill_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_taught_skill_revisions_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_taught_skill_revisions_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_taught_skill_revisions_revisionId_spaceId_skillId_fkey"
    FOREIGN KEY ("revisionId", "spaceId", "skillId")
    REFERENCES "taught_skill_revisions" ("id", "spaceId", "skillId")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "run_taught_skill_revisions_runId_skillId_key"
  ON "run_taught_skill_revisions" ("runId", "skillId");
CREATE INDEX "run_taught_skill_revisions_spaceId_botId_idx"
  ON "run_taught_skill_revisions" ("spaceId", "botId");

-- Tenant callers append and read, never edit or delete history. Named system access remains
-- available for content-key maintenance and whole-space/run deletion, as on existing tables.
ALTER TABLE "taught_skill_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY taught_skill_revisions_read ON "taught_skill_revisions" FOR SELECT
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY taught_skill_revisions_append ON "taught_skill_revisions" FOR INSERT
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "taught_skills" s
      WHERE s.id = "taught_skill_revisions"."skillId"
        AND s."spaceId" = "taught_skill_revisions"."spaceId"
        AND s."botId" = "taught_skill_revisions"."botId"
    )
  );
CREATE POLICY taught_skill_revisions_system ON "taught_skill_revisions"
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

ALTER TABLE "run_taught_skill_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_taught_skill_revisions_read ON "run_taught_skill_revisions" FOR SELECT
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  );
CREATE POLICY run_taught_skill_revisions_append ON "run_taught_skill_revisions" FOR INSERT
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM "runs" r
      WHERE r.id = "run_taught_skill_revisions"."runId"
        AND r."spaceId" = "run_taught_skill_revisions"."spaceId"
        AND r."botId" = "run_taught_skill_revisions"."botId"
        AND r."userId" = "run_taught_skill_revisions"."userId"
    )
    AND EXISTS (
      SELECT 1 FROM "taught_skill_revisions" s
      WHERE s.id = "run_taught_skill_revisions"."revisionId"
        AND s."spaceId" = "run_taught_skill_revisions"."spaceId"
        AND s."skillId" = "run_taught_skill_revisions"."skillId"
        AND s."botId" = "run_taught_skill_revisions"."botId"
    )
  );
CREATE POLICY run_taught_skill_revisions_system ON "run_taught_skill_revisions"
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "taught_skill_revisions", "run_taught_skill_revisions"
      TO rakazo_app;
  END IF;
END $$;
