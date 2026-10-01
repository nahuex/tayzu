-- Down script for 0006_catalog_role_grants.sql (task 6.2, design D6).
-- Reverses the FORCE flag, the grants and the revoke, then drops both roles.
-- Safe only because neither role owns any object of its own (they were only
-- ever granted/revoked privileges on the catalog tables, never `CREATE`,
-- never ownership).
ALTER TABLE catalog_tenant_sequence NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_relation_definition NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_entity_relation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_entity NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_change_event NO FORCE ROW LEVEL SECURITY;
ALTER TABLE catalog_blueprint NO FORCE ROW LEVEL SECURITY;

GRANT UPDATE, DELETE, TRUNCATE ON catalog_change_event TO tayzu_app;
REVOKE SELECT, INSERT ON catalog_change_event FROM tayzu_app;

REVOKE SELECT, INSERT, UPDATE, DELETE ON catalog_tenant_sequence FROM tayzu_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON catalog_relation_definition FROM tayzu_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON catalog_entity_relation FROM tayzu_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON catalog_entity FROM tayzu_app;
REVOKE SELECT, INSERT, UPDATE, DELETE ON catalog_blueprint FROM tayzu_app;

REVOKE USAGE ON SCHEMA public FROM tayzu_app;

DROP ROLE IF EXISTS tayzu_app;
DROP ROLE IF EXISTS tayzu_migrator;
