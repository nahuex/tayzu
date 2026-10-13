-- Down script for 0011_machine_credential_revocation_tenant_key.sql (043 task 11.1).
-- Restores the single-column primary key on credential_id. It fails if two tenants
-- already hold a revocation row for the same credential id; resolve those rows first.
ALTER TABLE "machine_credential_revocation" DROP CONSTRAINT IF EXISTS "machine_credential_revocation_pkey";
ALTER TABLE "machine_credential_revocation" ADD CONSTRAINT "machine_credential_revocation_pkey" PRIMARY KEY ("credential_id");
