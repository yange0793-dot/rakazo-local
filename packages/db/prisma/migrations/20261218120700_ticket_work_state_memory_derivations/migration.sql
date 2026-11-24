ALTER TABLE "tickets"
  ADD COLUMN "workState" JSONB,
  ADD COLUMN "workStateVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "memory_documents" ADD COLUMN "derivations" JSONB;
