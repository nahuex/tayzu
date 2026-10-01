-- Down script for 0009_machine_credential_revocation_grants.sql (task 5.5,
-- design D21). Reverses the FORCE flag and the grant. Safe because
-- `tayzu_app` was only ever granted privileges on this table, never
-- ownership.
ALTER TABLE machine_credential_revocation NO FORCE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT ON machine_credential_revocation FROM tayzu_app;
