# ADR-0014: Three Postgres roles and forced row-level security

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/archive/2026-10-15-002-auth-and-rbac/design.md) (design D6)

Amended 2026-11-18 by `045-org-deletion-and-data-retention`: see the
[addendum](#addendum-2026-11-18-five-roles-and-better-auth-row-level-security)
at the end. The sections before the addendum are the original decision,
unchanged.

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

## Addendum, 2026-11-18: five roles and Better Auth row-level security

- **Change**: [`045-org-deletion-and-data-retention`](../../openspec/changes/045-org-deletion-and-data-retention/design.md) (design D1 to D3; Resolved decisions Q35, Q48, Q49, Q59, Q65, Q82, Q159, Q161, Q162 and Q171)

Org deletion ([ADR-0019](0019-org-deletion-two-phase-purge.md)) changes two
statements of this ADR. Decision 1 says "Three roles", and its table records
row-level security on the `tayzu_auth` tables as "Not applicable" (`002`
design D6 says the same). `045` adds two roles and enables row-level security
on nine Better Auth tables. Everything else above still holds: no role has
`BYPASSRLS`, no role is shared between migration and runtime use, and
`tayzu_app` and `tayzu_auth` keep their grants.

1. **Five roles.**

   | Role                   | Added by | Purpose                                                                                                                                                                                                  | RLS                                                                                                |
   | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `tayzu_migrator`       | `002`    | Owns the catalog and `auth` tables, including `tenant_deletion_marker`, and runs DDL. Unchanged.                                                                                                         | As before. No policy names it, so it reads no marker row either.                                   |
   | `tayzu_app`            | `002`    | As before, plus `SELECT` and a column-level `INSERT` (`tenant_id`, `purge_after`, `requested_by`) on `tenant_deletion_marker`. No `UPDATE` or `DELETE` on it.                                            | Subject to RLS, and `FORCE`d, on the marker too (`tenant_isolation`).                              |
   | `tayzu_auth`           | `002`    | Runtime role for Better Auth. Unchanged.                                                                                                                                                                 | A permissive `auth_full_access` policy (`USING (true) WITH CHECK (true)`) on nine `auth` tables.   |
   | `tayzu_purge`          | `045`    | The purge job only. `SELECT, DELETE` on the seven tenant tables and nine `auth` tables, named one by one; `SELECT` and an `UPDATE` of the progress columns and `state` on the marker; `USAGE` on `auth`. | Policies limited to tenants with a due marker (`state = 'pending' AND purge_after <= now()`).      |
   | `tayzu_deletion_admin` | `045`    | The reversal job only. `SELECT` and an `UPDATE` of `state`, `cancelled_at` and `cancelled_by` on the marker. No tenant data, no `USAGE` on `auth`.                                                       | Reads pending markers; may only tombstone one with no recorded purge step and a future purge date. |

   Both new roles are created guarded, with `LOGIN`, `NOSUPERUSER`,
   `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS` and no
   password, each provisioned out of band with its own secret. They own
   nothing and there is no `SECURITY DEFINER` function (Q48).
   `createrole_self_grant` is cleared while they are created, so
   `tayzu_migrator` keeps only an admin-only membership and cannot `SET ROLE`
   to either.

2. **Row-level security on the Better Auth tables.** Migration `0014` enables
   (does not force) row-level security on `auth.organization`, `member`,
   `invitation`, `apikey`, `session`, `user`, `account`, `two_factor` and
   `verification`. Each table first gets a permissive `auth_full_access`
   policy `TO tayzu_auth`, so Better Auth reads and writes every tenant's rows
   exactly as before (Q59 as reworded by Q65). The restriction applies to
   `tayzu_purge` only, through `purge_due_select` and `purge_due_delete`
   policies: an organization-keyed row when its organization is due, a
   user-keyed row when every membership of the user is in a due tenant (read
   through `purge_read_all`, a `SELECT` policy over every `auth.member` row,
   Q65), and an `auth.verification` row by identifier family. `auth.rate_limit`
   and `auth.jwks` have no row-level security and no grant to `tayzu_purge`.
   `FORCE` is not set on these tables, because their owner is
   `tayzu_migrator`, which no runtime path uses (Q162).

3. **Decision 3, as amended.** Better Auth still never runs inside
   `withTenantTransaction`, and `tayzu_auth` still has no privilege on the
   catalog schema. `tayzu_purge` is the one role that reaches both sides, and
   only the rows of a tenant with a due marker. `0003` revoked `USAGE` on
   `auth` from everyone but `tayzu_auth`; `0014` grants it to `tayzu_purge`
   too.

4. **The catalog side.** `tenant_deletion_marker` is a catalog-schema table
   and follows decision 2: `ENABLE` and `FORCE ROW LEVEL SECURITY` with the
   `tenant_isolation` policy `TO tayzu_app` (Q159). The seven tenant tables
   keep their `tenant_isolation` policy and `FORCE`, and gain the
   `tayzu_purge` policies. The append-only trigger on `catalog_change_event`
   now admits a `DELETE` only when `current_user = 'tayzu_purge'`; `tayzu_app`
   still cannot alter or delete those rows.

5. **The migrations that carry the grants.** Each is its own Checkpoint 3
   review and has a `down` script next to it: `0012_tenant_deletion` (the
   marker table, with no row-level security yet), `0013_tenant_deletion_grants`
   (the two roles, the marker's grants and policies, the catalog purge
   policies and the trigger amendment; amended before it reached `master`,
   Q171) and `0014_tenant_deletion_auth_grants` (the Better Auth side, Q82).
