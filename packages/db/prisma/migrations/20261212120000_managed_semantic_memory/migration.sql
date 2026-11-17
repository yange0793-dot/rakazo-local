-- Additive managed semantic memory authority. Older releases do not read these tables.
CREATE TABLE "semantic_facts" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'active',
  "sourceThreadId" TEXT,
  "sourceGeneration" INTEGER,
  "validFrom" TIMESTAMP(3),
  "validTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "semantic_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_facts_scope_check" CHECK ("scope" IN ('isolated', 'shared')),
  CONSTRAINT "semantic_facts_kind_check" CHECK ("kind" IN ('durable', 'history')),
  CONSTRAINT "semantic_facts_status_check" CHECK ("status" IN ('active', 'historical', 'forgotten')),
  CONSTRAINT "semantic_facts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "semantic_facts_generation_check" CHECK ("sourceGeneration" IS NULL OR "sourceGeneration" >= 0),
  CONSTRAINT "semantic_facts_valid_time_check" CHECK ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" >= "validFrom")
);
CREATE UNIQUE INDEX "semantic_facts_id_spaceId_key" ON "semantic_facts"("id", "spaceId");
CREATE INDEX "semantic_facts_namespace_status_id_idx" ON "semantic_facts"("namespace", "status", "id");
CREATE INDEX "semantic_facts_history_source_idx"
  ON "semantic_facts"("spaceId", "botId", "kind", "sourceThreadId", "sourceGeneration");
ALTER TABLE "semantic_facts" ADD CONSTRAINT "semantic_facts_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "semantic_fact_revisions" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "provenance" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "validFrom" TIMESTAMP(3),
  "validTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_fact_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_fact_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "semantic_fact_revisions_status_check" CHECK ("status" IN ('active', 'historical', 'forgotten'))
);
CREATE UNIQUE INDEX "semantic_fact_revisions_factId_revision_key" ON "semantic_fact_revisions"("factId", "revision");
ALTER TABLE "semantic_fact_revisions" ADD CONSTRAINT "semantic_fact_revisions_factId_spaceId_fkey"
  FOREIGN KEY ("factId", "spaceId") REFERENCES "semantic_facts"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "semantic_fact_sources" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_fact_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "semantic_fact_sources_namespace_sourceKey_key" ON "semantic_fact_sources"("namespace", "sourceKey");
CREATE INDEX "semantic_fact_sources_factId_idx" ON "semantic_fact_sources"("factId");
ALTER TABLE "semantic_fact_sources" ADD CONSTRAINT "semantic_fact_sources_factId_spaceId_fkey"
  FOREIGN KEY ("factId", "spaceId") REFERENCES "semantic_facts"("id", "spaceId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "semantic_memory_retirements" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "botId" TEXT,
  "threadId" TEXT,
  "generation" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_memory_retirements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_memory_retirements_kind_check" CHECK ("kind" IN ('scope', 'history')),
  CONSTRAINT "semantic_memory_retirements_generation_check" CHECK ("generation" IS NULL OR "generation" >= 0)
);
CREATE INDEX "semantic_memory_retirements_namespace_kind_idx" ON "semantic_memory_retirements"("namespace", "kind");

CREATE TABLE "semantic_memory_index_outbox" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "indexId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semantic_memory_index_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_memory_index_outbox_action_check" CHECK ("action" IN ('upsert', 'delete')),
  CONSTRAINT "semantic_memory_index_outbox_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "semantic_memory_index_outbox_spaceId_createdAt_id_idx"
  ON "semantic_memory_index_outbox"("spaceId", "createdAt", "id");
CREATE INDEX "semantic_memory_index_outbox_createdAt_id_idx"
  ON "semantic_memory_index_outbox"("createdAt", "id");

-- Retirements and outbox pointers deliberately have no parent foreign keys. Once a
-- fact/space is removed, they still fence late writes and remove stale index revisions.
-- Deletes issued outside the service also enqueue current-revision index cleanup.
CREATE FUNCTION semantic_fact_delete_index_work() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Retirement already queued and drained every indexed revision. Its final tombstone
  -- was never indexed; do not recreate cleanup after the space credentials are gone.
  IF OLD."status" = 'forgotten' THEN RETURN OLD; END IF;
  INSERT INTO "semantic_memory_index_outbox"
    ("id", "spaceId", "userId", "namespace", "indexId", "factId", "revision", "action")
  VALUES
    ('sm-delete:' || OLD."id" || ':' || OLD."revision"::text,
     OLD."spaceId", OLD."userId", OLD."namespace",
     'sm:' || OLD."id" || ':' || OLD."revision"::text,
     OLD."id", OLD."revision", 'delete')
  ON CONFLICT ("id") DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER semantic_fact_delete_index_work
  BEFORE DELETE ON "semantic_facts"
  FOR EACH ROW EXECUTE FUNCTION semantic_fact_delete_index_work();

ALTER TABLE "semantic_facts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_facts_tenant ON "semantic_facts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_facts_system ON "semantic_facts" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
ALTER TABLE "semantic_fact_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_fact_revisions_tenant ON "semantic_fact_revisions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_fact_revisions_system ON "semantic_fact_revisions" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
ALTER TABLE "semantic_fact_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_fact_sources_tenant ON "semantic_fact_sources"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_fact_sources_system ON "semantic_fact_sources" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
ALTER TABLE "semantic_memory_retirements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_memory_retirements_tenant ON "semantic_memory_retirements"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_memory_retirements_system ON "semantic_memory_retirements" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
ALTER TABLE "semantic_memory_index_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_memory_index_outbox_tenant ON "semantic_memory_index_outbox"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY semantic_memory_index_outbox_system ON "semantic_memory_index_outbox" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "semantic_facts", "semantic_fact_revisions", "semantic_fact_sources",
      "semantic_memory_retirements", "semantic_memory_index_outbox" TO rakazo_app;
  END IF;
END $$;
