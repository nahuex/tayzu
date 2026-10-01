-- Down script for 0008_machine_credential_revocation.sql (task 5.5, design D21).
DROP POLICY IF EXISTS "tenant_isolation" ON "machine_credential_revocation";
DROP TABLE IF EXISTS "machine_credential_revocation";
