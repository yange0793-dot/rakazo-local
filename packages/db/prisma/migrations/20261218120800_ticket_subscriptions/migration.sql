CREATE TABLE "ticket_subscriptions" (
  "id" TEXT PRIMARY KEY,
  "ticketId" TEXT NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "threadId" TEXT REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "externalConversationId" TEXT REFERENCES "external_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastProcessedPosition" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ticket_subscriptions_source_check"
    CHECK (("threadId" IS NOT NULL) <> ("externalConversationId" IS NOT NULL)),
  CONSTRAINT "ticket_subscriptions_position_check" CHECK ("lastProcessedPosition" >= 0)
);
CREATE UNIQUE INDEX "ticket_subscriptions_ticketId_threadId_key"
  ON "ticket_subscriptions" ("ticketId", "threadId") WHERE "threadId" IS NOT NULL;
CREATE UNIQUE INDEX "ticket_subscriptions_ticketId_externalConversationId_key"
  ON "ticket_subscriptions" ("ticketId", "externalConversationId")
  WHERE "externalConversationId" IS NOT NULL;
CREATE INDEX "ticket_subscriptions_ticketId_active_idx"
  ON "ticket_subscriptions" ("ticketId", "active");
CREATE INDEX "ticket_subscriptions_threadId_active_idx"
  ON "ticket_subscriptions" ("threadId", "active");
CREATE INDEX "ticket_subscriptions_externalConversationId_active_idx"
  ON "ticket_subscriptions" ("externalConversationId", "active");

CREATE TABLE "ticket_subscription_events" (
  "id" TEXT PRIMARY KEY,
  "subscriptionId" TEXT NOT NULL REFERENCES "ticket_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "eventId" TEXT NOT NULL,
  "position" INTEGER NOT NULL CHECK ("position" >= 0),
  "runId" TEXT REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ticket_subscription_events_subscriptionId_eventId_key"
  ON "ticket_subscription_events" ("subscriptionId", "eventId");
CREATE INDEX "ticket_subscription_events_subscriptionId_position_idx"
  ON "ticket_subscription_events" ("subscriptionId", "position");

ALTER TABLE "ticket_subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_subscriptions_tenant ON "ticket_subscriptions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY ticket_subscriptions_system ON "ticket_subscriptions"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "ticket_subscription_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_subscription_events_tenant ON "ticket_subscription_events"
  USING (EXISTS (
    SELECT 1 FROM "ticket_subscriptions" s
    WHERE s.id = "subscriptionId"
      AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "ticket_subscriptions" s
    WHERE s.id = "subscriptionId"
      AND s."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY ticket_subscription_events_system ON "ticket_subscription_events"
  USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "ticket_subscriptions", "ticket_subscription_events" TO rakazo_app;
  END IF;
END $$;
