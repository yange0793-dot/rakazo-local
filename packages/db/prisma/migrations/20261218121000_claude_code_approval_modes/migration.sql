ALTER TABLE "action_auto_review_preferences"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "user_action_auto_review_preferences"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'default';

UPDATE "action_auto_review_preferences"
SET "mode" = CASE
  WHEN "skipApprovals" THEN 'bypassPermissions'
  WHEN "enabled" THEN 'auto'
  ELSE 'default'
END;
UPDATE "user_action_auto_review_preferences"
SET "mode" = CASE
  WHEN "skipApprovals" THEN 'bypassPermissions'
  WHEN "enabled" THEN 'auto'
  ELSE 'default'
END;
