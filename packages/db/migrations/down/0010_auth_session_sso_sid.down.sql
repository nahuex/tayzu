-- Down script for 0010_auth_session_sso_sid.sql (task 21.2, design D25, Q29).
ALTER TABLE "auth"."account" DROP CONSTRAINT IF EXISTS "account_provider_account_uq";
ALTER TABLE "auth"."session" DROP COLUMN IF EXISTS "sso_sid";
