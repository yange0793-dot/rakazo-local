ALTER TABLE "tickets"
  ADD COLUMN "managedVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "parentTicketId" TEXT,
  ADD COLUMN "controlEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "stopRequestedAt" TIMESTAMP(3),
  ADD COLUMN "requirementsVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "acceptedRequirementsVersion" INTEGER,
  ADD COLUMN "acceptedReceiptVersion" INTEGER,
  ADD COLUMN "originRoutineId" TEXT,
  ADD COLUMN "originGeneration" INTEGER;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parentTicketId_fkey"
  FOREIGN KEY ("parentTicketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tickets_parentTicketId_idx" ON "tickets"("parentTicketId");
ALTER TABLE "runs" ADD COLUMN "workControlEpoch" INTEGER,
  ADD COLUMN "workRequirementsVersion" INTEGER;

CREATE TABLE "ticket_dependencies" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "prerequisiteTicketId" TEXT NOT NULL,
  "requirementsVersion" INTEGER NOT NULL,
  "receiptVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_dependencies_ticketId_fkey" FOREIGN KEY ("ticketId")
    REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_dependencies_prerequisiteTicketId_fkey" FOREIGN KEY ("prerequisiteTicketId")
    REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_dependencies_versions_check" CHECK
    ("requirementsVersion" > 0 AND ("receiptVersion" IS NULL OR "receiptVersion" > 0)),
  CONSTRAINT "ticket_dependencies_self_check" CHECK ("ticketId" <> "prerequisiteTicketId")
);
CREATE UNIQUE INDEX "ticket_dependencies_ticketId_prerequisiteTicketId_key"
  ON "ticket_dependencies"("ticketId", "prerequisiteTicketId");
CREATE INDEX "ticket_dependencies_spaceId_prerequisiteTicketId_idx"
  ON "ticket_dependencies"("spaceId", "prerequisiteTicketId");

CREATE TABLE "external_agent_executions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ownerBotId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "runId" TEXT,
  "operationKey" TEXT NOT NULL,
  "connectionId" TEXT,
  "provider" TEXT NOT NULL,
  "route" JSONB NOT NULL,
  "request" JSONB NOT NULL,
  "sessionId" TEXT,
  "turnId" TEXT,
  "cursor" TEXT NOT NULL DEFAULT '0',
  "status" TEXT NOT NULL DEFAULT 'registered',
  "operationState" TEXT NOT NULL DEFAULT 'registered',
  "controlEpoch" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseFence" INTEGER NOT NULL DEFAULT 0,
  "lastEventAt" TIMESTAMP(3),
  "stopRequestedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "external_agent_executions_operationKey_key"
  ON "external_agent_executions"("operationKey");
CREATE INDEX "external_agent_executions_spaceId_ticketId_status_idx"
  ON "external_agent_executions"("spaceId", "ticketId", "status");
CREATE INDEX "external_agent_executions_spaceId_threadId_status_idx"
  ON "external_agent_executions"("spaceId", "threadId", "status");
CREATE INDEX "external_agent_executions_status_leaseExpiresAt_idx"
  ON "external_agent_executions"("status", "leaseExpiresAt");

CREATE TABLE "work_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "controlEpoch" INTEGER NOT NULL,
  "targetBotId" TEXT NOT NULL,
  "targetThreadId" TEXT NOT NULL,
  "sourceTicketId" TEXT,
  "sourceRunId" TEXT,
  "wakeRunId" TEXT,
  "payload" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "handledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "work_events_ticketId_fkey" FOREIGN KEY ("ticketId")
    REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "work_events_eventKey_key" ON "work_events"("eventKey");
CREATE INDEX "work_events_spaceId_ticketId_status_idx" ON "work_events"("spaceId", "ticketId", "status");
CREATE INDEX "work_events_status_createdAt_idx" ON "work_events"("status", "createdAt");
CREATE INDEX "work_events_wakeRunId_idx" ON "work_events"("wakeRunId");

ALTER TABLE "ticket_dependencies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_dependencies_tenant ON "ticket_dependencies"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ticket_dependencies_system ON "ticket_dependencies" USING ((SELECT app_rls_bypass()));
ALTER TABLE "external_agent_executions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_agent_executions_tenant ON "external_agent_executions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY external_agent_executions_system ON "external_agent_executions" USING ((SELECT app_rls_bypass()));
ALTER TABLE "work_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_events_tenant ON "work_events"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY work_events_system ON "work_events" USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket_dependencies", "external_agent_executions", "work_events" TO rakazo_app;
  END IF;
END $$;
