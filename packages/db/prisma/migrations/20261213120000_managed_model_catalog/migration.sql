CREATE TABLE "model_catalog_sources" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "group" TEXT NOT NULL,
  "apiProtocol" TEXT NOT NULL,
  "fingerprint" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "error" TEXT,
  CONSTRAINT "model_catalog_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "model_catalog_sources_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "model_catalog_sources_id_userId_key" ON "model_catalog_sources"("id", "userId");
CREATE UNIQUE INDEX "model_catalog_sources_userId_sourceKey_key" ON "model_catalog_sources"("userId", "sourceKey");
ALTER TABLE "user_model_credentials" ADD COLUMN "catalogSourceId" TEXT,
  ADD COLUMN "catalogProviderId" TEXT;
ALTER TABLE "user_model_credentials" ADD CONSTRAINT "user_model_credentials_catalogSourceId_userId_fkey"
  FOREIGN KEY ("catalogSourceId", "userId") REFERENCES "model_catalog_sources"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "user_model_credentials_catalogSourceId_catalogProviderId_key"
  ON "user_model_credentials"("catalogSourceId", "catalogProviderId");

ALTER TABLE "model_catalog_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY model_catalog_sources_user ON "model_catalog_sources"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY model_catalog_sources_system ON "model_catalog_sources"
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "model_catalog_sources" TO rakazo_app;
  END IF;
END $$;
