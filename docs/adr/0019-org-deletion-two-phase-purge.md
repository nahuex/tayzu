# ADR-0019: Org deletion is a two-phase purge under dedicated database roles

- **Status**: Accepted
- **Date**: 2026-11-18
- **Change**: [`045-org-deletion-and-data-retention`](../../openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention/design.md) (design D1, D2, D3; Resolved decisions Q14, Q21, Q26, Q27, Q35, Q41, Q48, Q49, Q55, Q64, Q65, Q150, Q153 and Q158 to Q176)

`043-identity-lifecycle-and-org-admin` reserved number `0019` for this change
when org deletion moved out of it, so ADR-0020 to ADR-0024 were written first.

## Context

An organization admin must be able to delete the organization, which is the
tenant. A synchronous delete in the request cannot work with the database
model of `001` and `002`
([ADR-0014](0014-postgres-roles-and-forced-rls.md)):

- `catalog_change_event` is append-only: a trigger rejects `DELETE` for every
  role, the owner included, and `tayzu_app` has no `DELETE` or `TRUNCATE` on
  it. `machine_credential_revocation` has no `DELETE` grant either.
- The catalog tables run on `tayzu_app` and the Better Auth tables on
  `tayzu_auth`. Two roles on two pools cannot share a transaction.
  `auth.apikey` has no foreign key to the organization, and several catalog
  foreign keys are `RESTRICT`.
- The catalog tables are `FORCE ROW LEVEL SECURITY` with policies
  `TO tayzu_app` only, so a function owned by `tayzu_migrator` (no policy, no
  `BYPASSRLS`) sees zero rows. A `SECURITY DEFINER` function owned by a new
  role needs the migrator to be able to `SET ROLE` to it, which ADR-0014
  forbids.
- The Better Auth tables had no row-level security and `tayzu_auth` has full
  CRUD on every tenant's rows, so a purge run as `tayzu_auth` would be limited
  by code alone.

An immediate hard delete is also irreversible: a compromised admin session
with a fresh MFA verification could destroy a tenant in one call, and
server-level point-in-time restore cannot bring back one tenant of a
shared-schema database. The decision must therefore leave a window in which a
deletion can be reversed, and make the database itself refuse a purge that is
not due, whatever the request path does.

## Decision

1. **Two phases: revoke now, purge later.** Phase 1 is the request,
   `identity.organization.delete` (`DELETE /v1/organization`): Cerbos
   `organization.delete` with the real tenant (any `admin`), step-up, and a
   confirmation that must equal the host `ctx.tenantId`. As `tayzu_app` it
   inserts a pending **deletion marker** whose `purge_after` is computed in
   SQL (`now() + make_interval(days => $1)`, one transaction clock with
   `requested_at`), from `ORG_DELETION_WINDOW_DAYS` (7 to 14, default 14).
   It then emits `catalog.audit.org_deletion_requested` at once (Q168), and
   on the `tayzu_auth` pool deletes every session whose active organization is
   the tenant, together with the `sso-reauth-state:` and `sso-reauth-result:`
   verification rows keyed by those sessions' tokens, in one statement (Q170:
   the purge cannot do it later, because no session token is left to join).
   It revokes every org-owned machine credential through the revocation list,
   cancels the pending invitations and notifies the owners and admins. A
   repeat while pending inserts nothing (`ON CONFLICT` on the partial unique
   index), returns the original `purgeAfter`, logs
   `catalog.security.org_deletion_repeated` and re-runs the idempotent
   revocations, so a first request that failed half-way is completed. From the
   insert on, `resolveContext`, token exchange and invitation acceptance reject
   the tenant (design D4). Phase 2 is the purge job (item 5).

2. **The marker is a trust boundary** (migrations `0012` and `0013`;
   Q26, Q158 to Q161). `tenant_deletion_marker` holds the tenant id,
   `requested_at` (`DEFAULT now()`), `purge_after`, `requested_by`, `state`,
   the step timestamps `catalog_purged_at` and `auth_purged_at`, and
   `cancelled_at` and `cancelled_by`. Every value is an opaque id or a
   timestamp. Its integrity rules:
   - a `CHECK` limits `state` to `pending`, `cancelled` and `purged`;
   - a `CHECK` keeps `purge_after` between `requested_at + 7 days` and
     `requested_at + 14 days`, so no marker can be back-dated;
   - a partial unique index on `tenant_id` `WHERE state = 'pending'` allows one
     pending marker per tenant, and addresses it (the table has no primary
     key, Q160);
   - `ENABLE` and `FORCE ROW LEVEL SECURITY` (in `0013`, Q159), with the
     `tenant_isolation` policy `TO tayzu_app`;
   - `tayzu_app` holds `SELECT` and a **column-level `INSERT`** on
     `tenant_id`, `purge_after` and `requested_by` only, because a `DEFAULT`
     does not ignore an explicit value: the request role can neither set
     `requested_at`, nor insert a `purged` marker, nor fill a step or a
     cancellation field. It has no `UPDATE` and no `DELETE`;
   - no role holds `DELETE` on the marker. A cancelled or purged marker stays
     as a tombstone, and a later request inserts a new pending one.

3. **A dedicated purge role, with no function** (`0013`; Q48). `tayzu_purge`
   is created like `tayzu_app` in `0006`: guarded, `LOGIN` with `NOSUPERUSER`,
   `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` and `NOBYPASSRLS`, and no
   password (provisioned out of band, with its own secret). `createrole_self_grant` is cleared while it
   is created, so `tayzu_migrator` keeps only an admin-only membership and can
   never `SET ROLE` to it. It owns nothing and there is no `SECURITY DEFINER`
   function: every rule is a grant, a policy or the amended trigger. "Due" is
   always `state = 'pending' AND purge_after <= now()`.
   - On the marker it holds `SELECT` and `UPDATE` of `catalog_purged_at`,
     `auth_purged_at` and `state`. `purge_due_select` reads the due markers,
     which is how the job lists due tenants across tenants, plus the row its
     own transaction turns `purged` (an `UPDATE` with `WHERE` checks the new
     row against the `SELECT` policy too, Q161). `purge_due_update` admits a
     due pending marker and accepts `purged` only with `catalog_purged_at`
     set and `auth_purged_at = now()`; never `cancelled`.
   - On the seven tenant tables, named one by one (`catalog_blueprint`,
     `catalog_relation_definition`, `catalog_entity`,
     `catalog_entity_relation`, `catalog_change_event`,
     `catalog_tenant_sequence`, `machine_credential_revocation`), it holds
     `SELECT, DELETE` under `purge_due_select` and `purge_due_delete`
     policies that restate the due predicate. The tables stay `FORCE`d.
   - The append-only trigger of `0001` is amended: a `DELETE` passes only when
     `current_user = 'tayzu_purge'`, a real identity rather than a settable
     flag. `UPDATE` and `TRUNCATE` still raise for every role, and a `DELETE`
     by any other role, the owner and `tayzu_app` included, still raises.

4. **The Better Auth rows get the same boundary** (`0014`; Q49, Q65, Q150,
   Q162). Row-level security is enabled, not forced, on the nine tables the
   purge deletes from: `organization`, `member`, `invitation`, `apikey`,
   `session`, `user`, `account`, `two_factor` and `verification`. Each gets a
   permissive `auth_full_access` policy `TO tayzu_auth`
   (`USING (true) WITH CHECK (true)`), created before row-level security is
   enabled, so Better Auth behaves as before. `tayzu_purge` gets `USAGE` on
   `auth` and an explicit `SELECT, DELETE` on each of the nine, and nothing on
   `auth.rate_limit` or `auth.jwks`. Its policies, all on the due predicate:
   - an organization-keyed row (the organization, `member`, `invitation`,
     `apikey` by `reference_id`, a `session` by `active_organization_id`) when
     its organization is due;
   - the user predicate for `user`, `account` and `two_factor`: at least one
     membership and none in a tenant that is not due. It is evaluated through
     `purge_read_all`, a read-only `SELECT` policy over every `auth.member`
     row (Q65), while the `DELETE` on `member` stays limited to due tenants;
   - a `session` when its active organization is due or its user passes the
     user predicate;
   - an `auth.verification` row only by identifier family, by exact prefix,
     joined to the row it names: `invitation-accept:` and `invitation-shed:`
     to the invitation, `step-up-verified:` to the session, `temp-password:`
     and `mfa-reenrol:` to the user, `sso-link:` to the account.
     `password-reset:` (30-minute state that names no tenant) has no policy
     and is exempt (Q150).

5. **The purge is a scheduled job that runs as `tayzu_purge`** (design D2).
   `apps/api/scripts/purge-job.ts` (`pnpm --filter @tayzu/api identity:purge`)
   is a Container Apps Job with its own identity, provisioned with `010`, and
   opens no listener. It reads only `PURGE_DATABASE_URL`
   (`sslmode=verify-full`), and `043`'s `runScript` asserts
   `current_user = 'tayzu_purge'` before any other query, then starts and
   flushes telemetry (Q79). Each pass lists the due tenants and runs two
   idempotent steps per tenant, with progress on the marker:
   - **Step 1, catalog**: deletes in foreign-key order (entity relations,
     entities, relation definitions, blueprints, change events, the tenant
     sequence, credential revocations), each delete committed on its own,
     then `catalog_purged_at = now()`.
   - **Step 2, Better Auth**: refused unless step 1 is recorded. First the
     tenant's `invitation-accept:` and `invitation-shed:` rows and its
     invitations, before any user (Q163: a user's deletion cascades to the
     invitations that user sent). Then each user with no membership outside
     due tenants, in one transaction per user that re-checks the memberships
     and deletes the user's verification rows, `step-up-verified:` markers,
     sessions, accounts, two-factor rows and the user last; it rolls back if
     the user delete removes nothing. Then the API keys, the step-up markers
     and sessions still active in the tenant, and the members. The job emits
     `catalog.audit.org_deletion_completed` immediately before it deletes the
     organization row, then writes `auth_purged_at = now()` and
     `state = 'purged'` in one statement.

   A failed step emits `catalog.security.org_deletion_failed` with the step,
   ends that tenant's pass (a failed step 1 never runs step 2) and makes the
   job exit non-zero; the next run resumes from the marker. A schema-driven
   completeness test fails when a table with a `tenant_id`, an `auth` table
   that references an organization or a user, or a verification family is
   neither purged nor exempted with a reason.

6. **Reversal is one audited operator action under its own role**
   (design D3; Q35, Q41, Q171 to Q175). `tayzu_deletion_admin` (`0013`,
   created like `tayzu_purge`) has `USAGE` on `public`, none on `auth`, and
   reads no tenant data. On the marker it holds `SELECT` under
   `deletion_admin_select`, which reads every pending marker plus the
   tombstone its own transaction writes (amended in `0013` before it reached
   `master`, approved at Checkpoint 3 on 2026-11-18, Q171), and `UPDATE` of
   `state`, `cancelled_at` and `cancelled_by` under
   `deletion_admin_tombstone`, which admits only a pending marker with no
   recorded step and a future `purge_after`, and accepts only
   `state = 'cancelled'`, `cancelled_at = now()` and a non-null
   `cancelled_by`. `apps/api/scripts/cancel-org-deletion.ts` reads only
   `REVERSAL_DATABASE_URL`, asserts `current_user = 'tayzu_deletion_admin'`,
   takes the tenant from `TAYZU_TENANT_ID` and the operator from
   `TAYZU_OPERATOR_ID` (Q172), checks the tenant id's shape, and refuses with
   `invalid_tenant`, `no_pending_marker`, `purge_begun` or
   `purge_date_passed`, each logged as
   `catalog.security.org_deletion_cancel_refused` and set as the span's
   `error.type` (Q175). Otherwise it tombstones the marker and emits
   `catalog.audit.org_deletion_cancelled` with the operator's opaque id
   (Q176). A tombstone that touches no row lost a race and is classified
   again, failing closed.

7. **The reversal is started only through a reviewed workflow** (Q41, Q55,
   Q64, Q153). `.github/workflows/identity-maintenance.yml` is a manual
   `workflow_dispatch` whose job runs only on `refs/heads/master`, in the
   `identity-maintenance` environment with required reviewers, and with
   `id-token: write` as its only permission. Its `job` input is a `choice`
   (`cancel-org-deletion`, `backfill-user-blueprint`, `reconcile-users`), and
   every input reaches the steps only through `env`. The first step rejects a
   reversal whose tenant id does not match `^[A-Za-z0-9_-]{1,64}$`. There is
   no checkout and no setup step: only `azure/login`, pinned by commit SHA,
   and `az containerapp job start` with `--name`, `--resource-group` and
   `--env-vars` (`TAYZU_OPERATOR_ID=gh:<numeric actor id>` and, for the
   reversal, `TAYZU_TENANT_ID`). The operator id comes from the authenticated
   actor and is never typed. `CODEOWNERS` gives `@nahuex` the workflows, the
   actions, the `CODEOWNERS` file and `apps/api/scripts/**`. The GitHub
   settings the workflow relies on are human-owned and listed in
   [`docs/security/secrets.md`](../security/secrets.md).

## Alternatives considered

- **Immediate hard delete, with a point-in-time restore runbook.** Rejected
  (Q14): irreversible in one call, and PITR cannot restore one tenant of a
  shared-schema database.
- **Keep the change events and pseudonymize their snapshots.** Rejected: it
  keeps tamper resistance but only partly erases the `_user` emails the
  snapshots hold.
- **`tayzu_app` runs the purge, guarded by `CHECK` constraints only.**
  Rejected (Q26): a request-path compromise could purge any tenant after a
  short wait.
- **No automated purge in v1.** Rejected (Q26): every deletion would need a
  human.
- **A `SECURITY DEFINER` function that disables the trigger, or purge and
  lister functions owned by `tayzu_purge` or by `tayzu_migrator`.** Rejected
  (Q26, Q48): disabling the trigger needs the table owner and a heavy lock, an
  ownership transfer needs the migrator to `SET ROLE` to `tayzu_purge`, and
  policies `TO tayzu_migrator` widen the migrator's reach.
- **A settable flag (a GUC) to open the append-only trigger.** Rejected: any
  session can set it. `current_user` is an authenticated identity.
- **A marker table without row-level security.** Rejected (Q26): every
  catalog-schema table is RLS-forced.
- **Purge the Better Auth rows as `tayzu_auth`.** Rejected (Q49): only code
  would limit it to due tenants.
- **`FORCE ROW LEVEL SECURITY` on the `auth` tables.** Rejected (Q162): their
  owner is the migration role, which no runtime path uses, and `tayzu_auth` is
  unrestricted by design.
- **A reversal policy that reads only tombstonable markers.** Rejected (Q171):
  the script could not tell a begun or past-due purge from a missing marker,
  and its refusals would be less useful. The tombstone policy is unchanged, so
  the database still refuses those cases.
- **Exempt the `sso-reauth-*` rows as short-lived state, or purge them in step
  2 through a new policy.** Rejected (Q170): an expired, never-consumed row
  keeps an `id_token` indefinitely, and by purge time no session is left to
  join.
- **An in-product cancel, or a reversal run from a workstation.** Rejected
  (Q21, Q41): the reversal needs a named second approver and an authenticated
  operator, which the reviewed workflow enforces technically.

## Consequences

- A request-path compromise cannot back-date a marker, mark a tenant purged,
  cancel a deletion or purge a tenant that is not due: the `CHECK`, the column
  grant and the policies refuse it in the database. A compromised admin
  session can still request a deletion, but the tenant survives the window
  and the admins are notified.
- Access to the tenant ends at the request. A reversal does not restore what
  phase 1 revoked: every org-owned credential stays revoked and the admins
  rotate each one. The runbook in
  [`docs/security/data-retention.md`](../security/data-retention.md) says so.
- Every new table with a `tenant_id`, and every `auth` table or verification
  family keyed by an organization or a user, needs its purge grant and policy,
  or an explicit exemption, in the same change. The completeness test fails
  otherwise.
- The Better Auth tables now carry row-level security. A new Better Auth
  table that the purge must reach needs an `auth_full_access` policy for
  `tayzu_auth` too, or Better Auth loses access to it.
- Markers are never deleted. A tombstone keeps the tenant id, the state, the
  timestamps and opaque ids only.
- A purge does not remove backups until their retention expires, Cerbos
  decision logs, Azure Monitor data, Azure Communication Services records,
  `password-reset:` rows or `auth.rate_limit` rows. The erasure statement in
  `docs/security/data-retention.md` names them.
- Deleting a purged user cascades to the invitations that user sent in a
  tenant that is not due (Q164), as on any user deletion.
- `entities_removed` on `catalog.audit.org_deletion_completed` counts the
  entities of the run that emits it: a run that resumes after step 1 reports
  0, and the step-1 span holds the full count (Q169).
- Two new database secrets, `PURGE_DATABASE_URL` and `REVERSAL_DATABASE_URL`,
  each held by one job with its own identity. No other script holds either
  role.
- The workflow is only as strong as its GitHub settings. It cannot be enabled
  until a second human is an environment reviewer and a code owner (Q153),
  and whether a job start can override the job's command is confirmed in
  `010`'s sandbox rehearsal (Q157).
