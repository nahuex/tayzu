-- Down script for 0015_catalog_entity_search.sql (003 task 3.1, design D7, Q41).
-- Drops the four search and sort indexes of catalog_entity, then the pg_trgm
-- extension, which nothing else uses. The extension goes last: the two trigram
-- indexes depend on its operator class.
DROP INDEX IF EXISTS "catalog_entity_tenant_blueprint_updated_idx";
DROP INDEX IF EXISTS "catalog_entity_tenant_blueprint_title_idx";
DROP INDEX IF EXISTS "catalog_entity_identifier_trgm_idx";
DROP INDEX IF EXISTS "catalog_entity_title_trgm_idx";
DROP EXTENSION IF EXISTS pg_trgm;
