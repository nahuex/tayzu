-- Custom SQL migration file, put your code below! -----
-- Hand-written custom SQL (design D6, Migration Plan step 2's second half;
-- task 6.2). `CREATE ROLE`, `GRANT`, `REVOKE` and `FORCE ROW LEVEL SECURITY`
-- are not expressible through Drizzle's table definitions
-- (`packages/catalog/src/persistence/schema.ts`), so this migration is
-- hand-written, the same pattern 0001 and 0003 already used.
--
-- This migration is numbered ahead of 0007_catalog_tenant_isolation_rls.sql
-- (task 6.1's Drizzle-generated migration) even though the design's prose
-- lists the Drizzle-generated migration first: 0007's `CREATE POLICY ... TO
-- "tayzu_app"` statements name that role, and Postgres raises 42704 "role
-- does not exist" if the role is not already there when that statement runs
-- (the from-scratch migration sequence is one single transaction, executed
-- in journal order, so this cannot be fixed by application order alone).
-- Both migrations are presented and approved together at the same
-- Checkpoint 3 (design Migration Plan step 2); only the file numbering is
-- adjusted so the sequence actually applies to an empty database.
--
-- Role creation is guarded so this migration is idempotent at the cluster
-- level, matching 0003's pattern: `CREATE ROLE` is cluster-wide, but this
-- migration re-applies once per database in the same cluster (every scratch
-- database this package's integration tests create, for example). No
-- password is set for either role — both are provisioned out of band (Azure
-- Key Vault in a deployed environment, design D15/task 14.1), never baked
-- into migration SQL.
--
-- `tayzu_migrator` is the DDL/ownership role (design D6); wiring it into the
-- migration runner itself, and reassigning table ownership to it, is task
-- 6.3, not this migration. Creating the role here only satisfies "where not
-- already infrastructure-provisioned" ahead of that task.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tayzu_migrator') THEN
    CREATE ROLE tayzu_migrator LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tayzu_app') THEN
    CREATE ROLE tayzu_app LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Explicit, since this cluster does not grant schema `public` USAGE to
-- PUBLIC by default (defense in depth, matching this project's
-- explicit-over-implicit convention; `tayzu_app` needs it to reach any
-- catalog table).
GRANT USAGE ON SCHEMA public TO tayzu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_blueprint TO tayzu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_entity TO tayzu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_entity_relation TO tayzu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_relation_definition TO tayzu_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_tenant_sequence TO tayzu_app;
--> statement-breakpoint
-- `catalog_change_event` is append-only (0001's trigger already rejects
-- UPDATE/DELETE/TRUNCATE at the trigger layer); revoking the privileges
-- themselves means a trigger bypass (for example `ALTER TABLE ... DISABLE
-- TRIGGER`, which `tayzu_app` cannot do either) is still not enough on its
-- own to mutate history (defense in depth, design D6, spec "Tenant isolation
-- is enforced by the database independent of application code").
GRANT SELECT, INSERT ON catalog_change_event TO tayzu_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON catalog_change_event FROM tayzu_app;
--> statement-breakpoint
ALTER TABLE catalog_blueprint FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_change_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_entity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_entity_relation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_relation_definition FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_tenant_sequence FORCE ROW LEVEL SECURITY;
