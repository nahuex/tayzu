-- Custom SQL migration file, put your code below! --
-- Hand-written custom SQL (045 design D1, D2, D3, Migration Plan; task 2.2;
-- Resolved decisions Q35, Q48, Q82, Q158 and Q159). Roles, column-level
-- grants, row-level security policies and the trigger amendment are not
-- expressible through Drizzle's table definitions
-- (`packages/catalog/src/persistence/schema.ts`), so this migration is
-- hand-written, the same pattern 0001, 0006 and 0009 already used.
--
-- The catalog side of the deletion access model, in one Checkpoint 3 review
-- (Q159: 0012 created the marker table with no row-level security; the whole
-- access model of the table lives here). The Better Auth side is 0014 (Q82).
--
-- - `tayzu_app` (the request role) may insert its own tenant's marker, and
--   only the tenant id, `purge_after` and the requesting actor: every other
--   column always takes its default, so it can neither back-date a marker nor
--   insert one already `purged`. It may read its own tenant's marker. It has
--   no UPDATE and no DELETE.
-- - `tayzu_purge` (the purge job's role, its own pool and secret) lists the
--   due markers, records the two purge steps and the `purged` state, and reads
--   and deletes the rows of a tenant with a due marker on the seven tenant
--   tables, named one by one.
-- - `tayzu_deletion_admin` (the reversal's role, Q35) may only tombstone a
--   pending marker with no recorded purge step and a future `purge_after`.
--
-- No function is created and no ownership is transferred (Q48): every rule is
-- a grant, a policy or the amended trigger. "Due" is always the same
-- predicate: `state = 'pending' AND purge_after <= now()`.
--
-- Role creation is guarded so this migration is idempotent at the cluster
-- level, matching 0006: `CREATE ROLE` is cluster-wide, but this migration
-- re-applies once per database in the same cluster. No password is set:
-- both roles are provisioned out of band (each with its own secret, design
-- D2), never baked into migration SQL. `createrole_self_grant` is cleared for
-- this transaction first, so the creating role (`tayzu_migrator`) always gets
-- PostgreSQL 16's admin-only membership (`set_option` and `inherit_option`
-- false) and can never `SET ROLE` to either new role, whatever that setting
-- is for the migrator's role or database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tayzu_purge') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE tayzu_purge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tayzu_deletion_admin') THEN
    PERFORM pg_catalog.set_config('createrole_self_grant', '', true);
    CREATE ROLE tayzu_deletion_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- Schema `public` is granted per role (0006). Neither role gets `USAGE` on
-- `auth` here: `tayzu_purge` gets it in 0014 (task 2.3), and
-- `tayzu_deletion_admin` never does.
GRANT USAGE ON SCHEMA public TO tayzu_purge;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tayzu_deletion_admin;
--> statement-breakpoint
-- The marker table: row-level security, forced for the owner too (Q159).
ALTER TABLE tenant_deletion_marker ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenant_deletion_marker FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The request role, `tayzu_app`: table-level SELECT and a column-level INSERT
-- limited to the three columns the request writes (a DEFAULT does not ignore
-- an explicit value, so the column grant is what keeps `requested_at`,
-- `state`, the step timestamps and the cancellation fields at their
-- defaults). No UPDATE and no DELETE.
GRANT SELECT ON tenant_deletion_marker TO tayzu_app;
--> statement-breakpoint
GRANT INSERT (tenant_id, purge_after, requested_by) ON tenant_deletion_marker TO tayzu_app;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_deletion_marker AS PERMISSIVE FOR ALL TO tayzu_app
  USING (tenant_deletion_marker.tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_deletion_marker.tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- The purge role, `tayzu_purge`, on the marker: SELECT (the listing of due
-- tenants, with no function, Q48) and an UPDATE limited to the progress
-- columns and `state`.
GRANT SELECT ON tenant_deletion_marker TO tayzu_purge;
--> statement-breakpoint
GRANT UPDATE (catalog_purged_at, auth_purged_at, state) ON tenant_deletion_marker TO tayzu_purge;
--> statement-breakpoint
-- Reads only due markers, plus the row this transaction has just purged.
--
-- Why the second disjunct: when an UPDATE has a WHERE or a RETURNING clause,
-- PostgreSQL also checks the role's SELECT policies against the NEW row, so a
-- policy limited strictly to `pending` would refuse the `state = 'purged'`
-- write with "new row violates row-level security policy". The update
-- policy below accepts `purged` only with `auth_purged_at = now()` and only
-- on a due pending row, so every row the purge role turns `purged` carries
-- the clock of the transaction that purged it: `now()` is the transaction's
-- start time, and no later transaction has the same one. The disjunct
-- therefore admits the row this transaction is writing and, in any other
-- transaction, no row it could not already read before it purged it. It
-- grants no read of a pending marker that is not due, of a cancelled one, or
-- of an earlier purged one.
CREATE POLICY purge_due_select ON tenant_deletion_marker AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    (tenant_deletion_marker.state = 'pending' AND tenant_deletion_marker.purge_after <= now())
    OR (tenant_deletion_marker.state = 'purged' AND tenant_deletion_marker.auth_purged_at = now())
  );
--> statement-breakpoint
-- Updates only a due pending marker, and leaves it either pending (a step
-- recorded) or `purged` once both steps are recorded, step 2 in this same
-- transaction. Never `cancelled`.
CREATE POLICY purge_due_update ON tenant_deletion_marker AS PERMISSIVE FOR UPDATE TO tayzu_purge
  USING (tenant_deletion_marker.state = 'pending' AND tenant_deletion_marker.purge_after <= now())
  WITH CHECK (
    tenant_deletion_marker.purge_after <= now()
    AND (
      tenant_deletion_marker.state = 'pending'
      OR (
        tenant_deletion_marker.state = 'purged'
        AND tenant_deletion_marker.catalog_purged_at IS NOT NULL
        AND tenant_deletion_marker.auth_purged_at = now()
      )
    )
  );
--> statement-breakpoint
-- The reversal role, `tayzu_deletion_admin`, on the marker (Q35): SELECT (an
-- UPDATE ... WHERE and its RETURNING need it) and an UPDATE limited to the
-- tombstone columns. No INSERT and no DELETE.
GRANT SELECT ON tenant_deletion_marker TO tayzu_deletion_admin;
--> statement-breakpoint
GRANT UPDATE (state, cancelled_at, cancelled_by) ON tenant_deletion_marker TO tayzu_deletion_admin;
--> statement-breakpoint
-- Reads only a pending marker with no recorded purge step and a future
-- purge date, plus the tombstone this transaction has just written. The
-- second disjunct exists for the same reason as in `purge_due_select`: the
-- tombstone's `UPDATE ... WHERE ... RETURNING` has its NEW row
-- (`state = 'cancelled'`) checked against this SELECT policy. The update
-- policy below accepts a tombstone only with `cancelled_at = now()`, so every
-- tombstone this role writes carries the clock of its own transaction, and
-- no other transaction of this role reads it: the role never reads a
-- cancelled marker it is not writing, nor a purged or half-purged one.
CREATE POLICY deletion_admin_select ON tenant_deletion_marker AS PERMISSIVE FOR SELECT TO tayzu_deletion_admin
  USING (
    (
      tenant_deletion_marker.state = 'pending'
      AND tenant_deletion_marker.catalog_purged_at IS NULL
      AND tenant_deletion_marker.auth_purged_at IS NULL
      AND tenant_deletion_marker.purge_after > now()
    )
    OR (tenant_deletion_marker.state = 'cancelled' AND tenant_deletion_marker.cancelled_at = now())
  );
--> statement-breakpoint
-- Tombstones only a pending marker with no recorded purge step and a future
-- purge date (design D3: a half-purged tenant can never be revived), and the
-- result must be a tombstone stamped by this transaction with an operator id.
CREATE POLICY deletion_admin_tombstone ON tenant_deletion_marker AS PERMISSIVE FOR UPDATE TO tayzu_deletion_admin
  USING (
    tenant_deletion_marker.state = 'pending'
    AND tenant_deletion_marker.catalog_purged_at IS NULL
    AND tenant_deletion_marker.auth_purged_at IS NULL
    AND tenant_deletion_marker.purge_after > now()
  )
  WITH CHECK (
    tenant_deletion_marker.state = 'cancelled'
    AND tenant_deletion_marker.cancelled_at = now()
    AND tenant_deletion_marker.cancelled_by IS NOT NULL
    AND tenant_deletion_marker.catalog_purged_at IS NULL
    AND tenant_deletion_marker.auth_purged_at IS NULL
    AND tenant_deletion_marker.purge_after > now()
  );
--> statement-breakpoint
-- The purge role on the tenant's tables, named one by one (not by a prefix):
-- SELECT and DELETE, each under its own SELECT and DELETE policy limited to a
-- tenant with a due marker. A `DELETE ... WHERE tenant_id = ...` needs the
-- SELECT privilege and a SELECT policy as well as the DELETE one, and the
-- `entities_removed` count needs reads. The marker subquery runs as
-- `tayzu_purge`, under `purge_due_select`, and names the due predicate
-- explicitly, so a marker this transaction has just turned `purged` admits
-- no catalog row. The seven tables are already FORCE ROW LEVEL SECURITY
-- (0006, 0009), so their owner gets no row through these policies either.
GRANT SELECT, DELETE ON catalog_blueprint TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_blueprint AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_blueprint.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_blueprint AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_blueprint.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
GRANT SELECT, DELETE ON catalog_relation_definition TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_relation_definition AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_relation_definition.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_relation_definition AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_relation_definition.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
GRANT SELECT, DELETE ON catalog_entity TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_entity AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_entity.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_entity AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_entity.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
GRANT SELECT, DELETE ON catalog_entity_relation TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_entity_relation AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_entity_relation.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_entity_relation AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_entity_relation.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
-- `catalog_change_event` is append-only: `tayzu_app` keeps no UPDATE, DELETE
-- or TRUNCATE (0006), and the amended trigger below admits a DELETE only from
-- `tayzu_purge`, which these policies then limit to a due tenant.
GRANT SELECT, DELETE ON catalog_change_event TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_change_event AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_change_event.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_change_event AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_change_event.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
GRANT SELECT, DELETE ON catalog_tenant_sequence TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON catalog_tenant_sequence AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_tenant_sequence.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON catalog_tenant_sequence AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = catalog_tenant_sequence.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
-- `machine_credential_revocation` has no `catalog_` prefix, which is why the
-- tables are named one by one. `tayzu_app` still has no DELETE on it (0009).
GRANT SELECT, DELETE ON machine_credential_revocation TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON machine_credential_revocation AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = machine_credential_revocation.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON machine_credential_revocation AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM tenant_deletion_marker m
     WHERE m.tenant_id = machine_credential_revocation.tenant_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
-- Amends 0001's append-only trigger function (design D1): a DELETE is allowed
-- only when `current_user` is `tayzu_purge`, a real identity that no role can
-- `SET ROLE` to and that owns nothing (so no SECURITY DEFINER function can
-- run as it), not a settable flag (a GUC would be spoofable). UPDATE and
-- TRUNCATE still raise for every role, and a DELETE by any other role,
-- including the table owner and `tayzu_app`, still raises. For `tayzu_purge`
-- the policies above still limit the rows to a due tenant. `CREATE OR
-- REPLACE` keeps the function's owner, its privileges and both triggers.
CREATE OR REPLACE FUNCTION catalog_change_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'tayzu_purge' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'catalog_change_event is append-only: % is not allowed', TG_OP;
END;
$$;
