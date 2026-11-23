-- deferred
DELETE FROM "security_events" WHERE "type" LIKE 'auth.%';
DELETE FROM "audit_events" WHERE "action" LIKE 'auth.%';
DELETE FROM "push_tokens" WHERE "sessionId" NOT LIKE 'rakazo-local-install:%';
DELETE FROM "call_push_devices" WHERE "sessionId" NOT LIKE 'rakazo-local-install:%';
DELETE FROM "work_activity_tokens" WHERE "sessionId" NOT LIKE 'rakazo-local-install:%';
DELETE FROM "work_activity_start_tokens" WHERE "sessionId" NOT LIKE 'rakazo-local-install:%';
DELETE FROM "user_devices"
WHERE "sessionId" IS NOT NULL AND "sessionId" NOT LIKE 'rakazo-local-install:%';
DROP TABLE "email_sends";
