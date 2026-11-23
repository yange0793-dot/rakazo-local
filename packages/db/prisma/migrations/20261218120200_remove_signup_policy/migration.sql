-- deferred
ALTER TABLE "deployment_settings"
  DROP COLUMN "signupsEnabled",
  DROP COLUMN "signupAllowlist",
  DROP COLUMN "signupPolicyInitialized";
