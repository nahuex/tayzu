-- Down script for 0000_catalog_core.sql (Migration Plan, task 5.1).
-- Hand-written, kept next to the migration for completeness: this is a
-- greenfield database, so the only rollback this change needs is dropping
-- the six tables it created, in reverse dependency order.
DROP TABLE IF EXISTS "catalog_entity_relation";
DROP TABLE IF EXISTS "catalog_entity";
DROP TABLE IF EXISTS "catalog_relation_definition";
DROP TABLE IF EXISTS "catalog_tenant_sequence";
DROP TABLE IF EXISTS "catalog_change_event";
DROP TABLE IF EXISTS "catalog_blueprint";
