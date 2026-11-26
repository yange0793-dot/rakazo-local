UPDATE "action_auto_review_preferences"
SET "mode" = CASE
  WHEN "mode" = 'auto' THEN 'auto'
  WHEN "mode" IN ('dontAsk', 'bypassPermissions') THEN 'bypermission'
  ELSE 'ask'
END;

UPDATE "user_action_auto_review_preferences"
SET "mode" = CASE
  WHEN "mode" = 'auto' THEN 'auto'
  WHEN "mode" IN ('dontAsk', 'bypassPermissions') THEN 'bypermission'
  ELSE 'ask'
END;

ALTER TABLE "action_auto_review_preferences"
  ALTER COLUMN "mode" SET DEFAULT 'ask';
ALTER TABLE "user_action_auto_review_preferences"
  ALTER COLUMN "mode" SET DEFAULT 'ask';
