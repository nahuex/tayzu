# ADR-0014: Three Postgres roles and forced row-level security

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md) (design D6)

## Context

`001-catalog-core` isolates tenants in application code: every query filters
by `tenant_id`, and `withTenantTransaction` sets `app.tenant_id` with
`set_config('app.tenant_id', $1, true)`. That seam activated no database
policy, so a query that forgot the filter would still have read every
tenant's rows. 001 (design D5) named this ADR's decision as the precondition
for making isolation a database guarantee.

`002-auth-and-rbac` also adds Better Auth, whose tables (`user`, `session`,
`account`, `organization`, ...) are cross-tenant by design: `organization` is
the tenant itself and has no parent to scope by.

A single database role that owns the tables and also runs queries would
bypass row-level security: a table owner is exempt from RLS unless the table
is `FORCE`d, and a role with `BYPASSRLS` is exempt regardless.

## Decision

1. **Three roles, one purpose each.**

   | Role             | Purpose                                                                                                                                                      | RLS                                                                     |
   | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
   | `tayzu_migrator` | Owns the catalog and `auth` tables and runs DDL. Never used to issue runtime DML.                                                                            | Subject to `FORCE`, but moot because nothing at runtime connects as it. |
   | `tayzu_app`      | Runtime role for the catalog. `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the catalog tables; `SELECT`, `INSERT` only on `catalog_change_event`. Owns nothing. | Subject to RLS, and `FORCE`d.                                           |
   | `tayzu_auth`     | Runtime role for Better Auth. Full CRUD on the `auth` schema only. No grant on any catalog table.                                                            | Not applicable: `auth` tables carry no `tenant_id`.                     |

   No role is shared between migration and runtime use, and none has
   `BYPASSRLS`.

2. **Every catalog table has a `tenant_isolation` policy** for `tayzu_app`,
   `FOR ALL`, with `USING` and `WITH CHECK` both
   `tenant_id = current_setting('app.tenant_id', true)`, plus
   `ENABLE` and `FORCE ROW LEVEL SECURITY`. The `missing_ok` argument makes
   an unset `app.tenant_id` evaluate to `NULL`, so a query outside
   `withTenantTransaction` sees and affects zero rows instead of raising.
   `machine_credential_revocation` (see
   [ADR-0016](0016-machine-credential-token-exchange.md)) gets the same
   treatment.

3. **Better Auth never runs inside `withTenantTransaction`.** It uses its own
   pool as `tayzu_auth`, in its own `auth` Postgres schema, and `tayzu_auth`
   has no privilege on the catalog schema, so a bug in either path cannot
   reach the other's tables.

4. **Drizzle expresses the policies, hand-written SQL expresses the rest.**
   `pgPolicy` and `ENABLE ROW LEVEL SECURITY` are generated. `CREATE ROLE`,
   `GRANT`, `REVOKE` and `FORCE ROW LEVEL SECURITY` are not expressible in
   Drizzle and are custom SQL migrations, the same pattern 001 used for the
   append-only trigger. Roles are created only when missing, so
   infrastructure may provision them first.

5. **The test harness mirrors production.** `getTestDatabase()` applies
   migrations as `tayzu_migrator` and hands tests a pool connected as
   `tayzu_app`, so 001's isolation tests are RLS tests without a rewrite.
   New tests assert that an unset tenant returns zero rows and that
   `tayzu_migrator` is not reachable from any runtime code path.

6. **Each migration is its own Checkpoint 3 review.** As implemented:
   `0002_auth_schema` and `0003_auth_role_grants` (the `auth` schema and
   `tayzu_auth`), `0006_catalog_role_grants` (`tayzu_migrator`, `tayzu_app`,
   grants, `FORCE`), `0007_catalog_tenant_isolation_rls` (policies),
   `0008` and `0009` (the revocation table and its grants). Each has a
   `down` script next to it.

## Alternatives considered

- **Application-level filtering only, as in 001.** Rejected: one missed
  `WHERE tenant_id = ...` leaks across tenants. RLS turns that bug into an
  empty result.
- **One runtime role for catalog and Better Auth.** Rejected: it would need
  grants on both sets of tables, so a flaw in either code path could reach
  the other's data, and `auth` tables cannot carry a tenant policy.
- **RLS on, but no `FORCE`, with the owner as runtime role.** Rejected: the
  owner bypasses RLS, which is the failure this decision exists to prevent.
- **A `BYPASSRLS` migration role.** Rejected: `tayzu_migrator` needs no
  bypass, because it runs DDL only, and a bypass attribute on any role is a
  standing risk.

## Consequences

- Cross-tenant reads fail closed at the database even if application code,
  Cerbos or a policy has a bug. The layers are independent: RLS makes a
  cross-tenant row invisible (`CATALOG_NOT_FOUND`), Cerbos makes an in-tenant
  deny visible (`AUTH_FORBIDDEN`).
- Every new catalog table needs its policy, its grants and `FORCE` in the
  same change, or `tayzu_app` cannot use it. A table added without a policy
  is unreadable, not open.
- `tayzu_app` cannot alter or delete `catalog_change_event` rows, so the
  append-only guarantee no longer rests on the trigger alone.
- `tayzu_migrator`'s password is a deploy-time secret only. See
  [`docs/security/secrets.md`](../security/secrets.md).
- `tayzu_app` runs `set_config('app.tenant_id', ...)` per transaction, so
  a code path that opens a connection without `withTenantTransaction`
  returns nothing.
