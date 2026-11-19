-- Chat origin is server-assigned. Existing board tickets and runs have no origin.
ALTER TABLE "tickets" ADD COLUMN "originKey" TEXT,
  ADD COLUMN "originThreadId" TEXT REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "originMessageId" TEXT REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "originRunId" TEXT REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "receiptVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "runs" ADD COLUMN "ticketId" TEXT REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "tickets_originKey_key" ON "tickets"("originKey");
CREATE INDEX "tickets_originThreadId_updatedAt_idx" ON "tickets"("originThreadId", "updatedAt");
CREATE INDEX "runs_ticketId_idx" ON "runs"("ticketId");
