ALTER TABLE "messaging_outbound"
  ADD COLUMN "deliveryState" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "confirmedAt" TIMESTAMP(3);

CREATE INDEX "messaging_outbound_deliveryState_claimedAt_idx"
  ON "messaging_outbound"("deliveryState", "claimedAt");

-- Previous workers claim with status=sent and retry every transport error.
-- Preserve their readable status values while fencing these unsafe transitions.
-- Historical rows stay NULL: sent without a handle is never confirmation.
CREATE FUNCTION messaging_outbound_compatibility() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'sent' THEN
    -- Same lane lock as both releases' claim/insert transactions.
    IF NEW."identityId" IS NOT NULL THEN
      PERFORM id FROM messaging_identities WHERE id = NEW."identityId" FOR UPDATE;
    ELSIF NEW."threadId" IS NOT NULL THEN
      PERFORM id FROM messaging_channels WHERE "threadId" = NEW."threadId" FOR UPDATE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM messaging_outbound o
      WHERE o.id <> NEW.id
        AND (
          (NEW."identityId" IS NOT NULL AND o."identityId" = NEW."identityId")
          OR (NEW."identityId" IS NULL AND NEW."threadId" IS NOT NULL
              AND o."identityId" IS NULL AND o."threadId" = NEW."threadId")
        )
        AND (
          (o.status = 'sent' AND (
            o."deliveryState" IN ('claimed', 'unknown')
            OR (o."deliveryState" IS NULL AND COALESCE(o."providerHandle", '') = '')
          ))
          OR (o.status = 'pending' AND (o."createdAt", o.id) < (NEW."createdAt", NEW.id))
        )
    ) THEN
      RETURN NULL; -- A legacy updateMany sees count=0 and does not send.
    END IF;
    IF NEW."deliveryState" IS NOT DISTINCT FROM OLD."deliveryState" THEN
      NEW."deliveryState" := 'unknown';
      NEW."claimedAt" := CURRENT_TIMESTAMP;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'sent'
     AND NEW."deliveryState" IS NOT DISTINCT FROM OLD."deliveryState"
     AND (NEW.status = 'pending'
          OR (NEW.status = 'failed' AND COALESCE(OLD."providerHandle", '') = '')) THEN
    -- Legacy retries/exhaustion cannot settle a send whose result is unknown.
    -- New code explicitly changes deliveryState for known rejection/pre-send recovery.
    NEW.status := OLD.status;
    NEW."deliveryState" := COALESCE(OLD."deliveryState", 'unknown');
    NEW."nextAttemptAt" := NULL;
  END IF;

  IF NEW.status = 'sent' AND COALESCE(NEW."providerHandle", '') <> ''
     AND (TG_OP = 'INSERT' OR NEW."providerHandle" IS DISTINCT FROM OLD."providerHandle") THEN
    NEW."deliveryState" := 'accepted';
    NEW."confirmedAt" := COALESCE(NEW."confirmedAt", CURRENT_TIMESTAMP);
  ELSIF NEW.status = 'failed' AND COALESCE(NEW."providerHandle", '') <> '' THEN
    NEW."deliveryState" := 'rejected';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER messaging_outbound_compatibility
  BEFORE INSERT OR UPDATE ON messaging_outbound
  FOR EACH ROW EXECUTE FUNCTION messaging_outbound_compatibility();
