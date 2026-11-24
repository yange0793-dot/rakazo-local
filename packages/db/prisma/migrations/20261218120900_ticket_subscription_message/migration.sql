-- Keep older subscription writers valid; new routing always supplies the source message.
ALTER TABLE "ticket_subscription_events"
  ADD COLUMN "messageId" TEXT REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
