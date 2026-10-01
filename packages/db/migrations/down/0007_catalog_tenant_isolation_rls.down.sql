-- Down script for 0007_catalog_tenant_isolation_rls.sql (task 6.1, design D6).
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_tenant_sequence";
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_relation_definition";
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_entity_relation";
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_entity";
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_change_event";
DROP POLICY IF EXISTS "tenant_isolation" ON "catalog_blueprint";
ALTER TABLE "catalog_tenant_sequence" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_relation_definition" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_entity_relation" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_entity" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_change_event" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_blueprint" DISABLE ROW LEVEL SECURITY;
