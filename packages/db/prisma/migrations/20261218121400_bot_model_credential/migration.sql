-- Keep the selected ID after disconnect so the Bot can report its unavailable connection.
ALTER TABLE "bots" ADD COLUMN "modelCredentialId" TEXT;
ALTER TABLE "runs" ADD COLUMN "modelCredentialId" TEXT;
