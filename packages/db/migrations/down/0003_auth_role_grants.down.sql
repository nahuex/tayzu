-- Down script for 0003_auth_role_grants.sql (Migration Plan, task 2.2).
-- Reverses the grants and drops `tayzu_auth`. Safe only because this role
-- owns no object of its own (it was only ever granted privileges on schema
-- `auth`'s tables and sequences, never `CREATE`, never ownership).
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth FROM tayzu_auth;
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth FROM tayzu_auth;
REVOKE USAGE ON SCHEMA auth FROM tayzu_auth;
DROP ROLE IF EXISTS tayzu_auth;
