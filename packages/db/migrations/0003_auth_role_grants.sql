-- Custom SQL migration file, put your code below! -----
-- Companion custom SQL to 0002_auth_schema.sql (design D6, Migration Plan
-- step 1; task 2.2). `CREATE ROLE`, `GRANT` and `REVOKE` are not expressible
-- through Drizzle's table definitions, so this migration is hand-written
-- rather than generated, the same pattern 0001 already used for the
-- append-only trigger.
--
-- `tayzu_auth` gets full CRUD on every table (and, for forward-compatibility,
-- every sequence) in schema `auth`, and nothing else: no grant on any
-- `catalog_*` relation, and no `CREATE` on schema `auth` itself (only a
-- migration role creates new auth tables). Role creation is guarded so this
-- migration is idempotent at the cluster level: `CREATE ROLE` is a
-- cluster-wide operation, but this migration re-applies once per database in
-- the same cluster (every scratch database `schema.int.test.ts` creates, for
-- example), and a bare `CREATE ROLE` would fail on the second database with
-- "role already exists". No password is set here — `tayzu_auth`'s password
-- is provisioned out of band (Azure Key Vault in a deployed environment,
-- design D15), never baked into migration SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tayzu_auth') THEN
    CREATE ROLE tayzu_auth LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Explicit, even though a newly created non-`public` schema already grants
-- nothing to PUBLIC by default (defense in depth, matching this project's
-- explicit-over-implicit convention).
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO tayzu_auth;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO tayzu_auth;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO tayzu_auth;
