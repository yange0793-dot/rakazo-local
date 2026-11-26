-- deferred
ALTER TABLE "action_auto_review_preferences"
  DROP COLUMN "enabled",
  DROP COLUMN "skipApprovals";
ALTER TABLE "user_action_auto_review_preferences"
  DROP COLUMN "enabled",
  DROP COLUMN "skipApprovals";
