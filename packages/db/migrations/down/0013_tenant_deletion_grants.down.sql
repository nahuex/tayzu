-- Down script for 0013_tenant_deletion_grants.sql (045 task 2.2, design D1,
-- D2, D3). Run the down script of 0014_tenant_deletion_auth_grants first: it
-- grants `tayzu_purge` `USAGE` on `auth` and privileges on the Better Auth
-- tables. Restores 0001's append-only trigger body, drops every policy and
-- grant this migration added, turns the marker's row-level security off
-- (0012 created it with none, Q159), then drops both roles. Safe only because
-- neither role owns any object (they were only ever granted privileges, never
-- `CREATE`, never ownership).
CREATE OR REPLACE FUNCTION catalog_change_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'catalog_change_event is append-only: % is not allowed', TG_OP;
END;
$$;

DROP POLICY IF EXISTS purge_due_delete ON machine_credential_revocation;
DROP POLICY IF EXISTS purge_due_select ON machine_credential_revocation;
REVOKE SELECT, DELETE ON machine_credential_revocation FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_tenant_sequence;
DROP POLICY IF EXISTS purge_due_select ON catalog_tenant_sequence;
REVOKE SELECT, DELETE ON catalog_tenant_sequence FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_change_event;
DROP POLICY IF EXISTS purge_due_select ON catalog_change_event;
REVOKE SELECT, DELETE ON catalog_change_event FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_entity_relation;
DROP POLICY IF EXISTS purge_due_select ON catalog_entity_relation;
REVOKE SELECT, DELETE ON catalog_entity_relation FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_entity;
DROP POLICY IF EXISTS purge_due_select ON catalog_entity;
REVOKE SELECT, DELETE ON catalog_entity FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_relation_definition;
DROP POLICY IF EXISTS purge_due_select ON catalog_relation_definition;
REVOKE SELECT, DELETE ON catalog_relation_definition FROM tayzu_purge;
DROP POLICY IF EXISTS purge_due_delete ON catalog_blueprint;
DROP POLICY IF EXISTS purge_due_select ON catalog_blueprint;
REVOKE SELECT, DELETE ON catalog_blueprint FROM tayzu_purge;

DROP POLICY IF EXISTS deletion_admin_tombstone ON tenant_deletion_marker;
DROP POLICY IF EXISTS deletion_admin_select ON tenant_deletion_marker;
REVOKE UPDATE (state, cancelled_at, cancelled_by) ON tenant_deletion_marker FROM tayzu_deletion_admin;
REVOKE SELECT ON tenant_deletion_marker FROM tayzu_deletion_admin;
DROP POLICY IF EXISTS purge_due_update ON tenant_deletion_marker;
DROP POLICY IF EXISTS purge_due_select ON tenant_deletion_marker;
REVOKE UPDATE (catalog_purged_at, auth_purged_at, state) ON tenant_deletion_marker FROM tayzu_purge;
REVOKE SELECT ON tenant_deletion_marker FROM tayzu_purge;
DROP POLICY IF EXISTS tenant_isolation ON tenant_deletion_marker;
REVOKE INSERT (tenant_id, purge_after, requested_by) ON tenant_deletion_marker FROM tayzu_app;
REVOKE SELECT ON tenant_deletion_marker FROM tayzu_app;
ALTER TABLE tenant_deletion_marker NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_marker DISABLE ROW LEVEL SECURITY;

REVOKE USAGE ON SCHEMA public FROM tayzu_deletion_admin;
REVOKE USAGE ON SCHEMA public FROM tayzu_purge;

DROP ROLE IF EXISTS tayzu_deletion_admin;
DROP ROLE IF EXISTS tayzu_purge;
