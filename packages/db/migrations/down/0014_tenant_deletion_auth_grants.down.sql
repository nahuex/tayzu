-- Down script for 0014_tenant_deletion_auth_grants.sql (045 task 2.3, design
-- D1, D2). Run it before the down script of 0013_tenant_deletion_grants,
-- which drops `tayzu_purge`. For each of the nine Better Auth tables, turns
-- row-level security off first (so `tayzu_auth` never sees the table with RLS
-- on and no policy), then drops the purge role's policies and grant and the
-- `tayzu_auth` policy; finally revokes the purge role's `USAGE` on `auth`.
-- `tayzu_auth`'s own table grants (0003, 0005) are untouched.
ALTER TABLE auth.verification DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.verification;
DROP POLICY IF EXISTS purge_due_select ON auth.verification;
REVOKE SELECT, DELETE ON auth.verification FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.verification;

ALTER TABLE auth.two_factor DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.two_factor;
DROP POLICY IF EXISTS purge_due_select ON auth.two_factor;
REVOKE SELECT, DELETE ON auth.two_factor FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.two_factor;

ALTER TABLE auth.account DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.account;
DROP POLICY IF EXISTS purge_due_select ON auth.account;
REVOKE SELECT, DELETE ON auth.account FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.account;

ALTER TABLE auth."user" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth."user";
DROP POLICY IF EXISTS purge_due_select ON auth."user";
REVOKE SELECT, DELETE ON auth."user" FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth."user";

ALTER TABLE auth.session DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.session;
DROP POLICY IF EXISTS purge_due_select ON auth.session;
REVOKE SELECT, DELETE ON auth.session FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.session;

ALTER TABLE auth.apikey DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.apikey;
DROP POLICY IF EXISTS purge_due_select ON auth.apikey;
REVOKE SELECT, DELETE ON auth.apikey FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.apikey;

ALTER TABLE auth.invitation DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.invitation;
DROP POLICY IF EXISTS purge_due_select ON auth.invitation;
REVOKE SELECT, DELETE ON auth.invitation FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.invitation;

ALTER TABLE auth.member DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.member;
DROP POLICY IF EXISTS purge_read_all ON auth.member;
REVOKE SELECT, DELETE ON auth.member FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.member;

ALTER TABLE auth.organization DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS purge_due_delete ON auth.organization;
DROP POLICY IF EXISTS purge_due_select ON auth.organization;
REVOKE SELECT, DELETE ON auth.organization FROM tayzu_purge;
DROP POLICY IF EXISTS auth_full_access ON auth.organization;

REVOKE USAGE ON SCHEMA auth FROM tayzu_purge;
