# Design: 045-org-deletion-and-data-retention

## Context

- This change is the second half of `043-identity-lifecycle-and-org-admin`, split
  out by the human's own decision of 2026-10-07 (Resolved decision Q103 of `043`,
  carried in "Resolved decisions" below) because `043` had reached 227 tasks
  against the roadmap's ~30-80 TDD-task sizing
  (`docs/references/port/roadmap-analysis.md:9-12`; item C4 of `043`'s seventh
  drift-check). It depends on `002-auth-and-rbac` and on `043`, and it executes
  after `044` (`002 -> 043 -> 044 -> 045 -> 003`, `openspec/project.md` §23,
  decision D12). `043` keeps its migration `0011` and `045` owns `0012` to `0014`;
  nothing is renumbered.
- **Decisions.** Every row of "Resolved decisions" below up to Q103 is carried
  verbatim from `043` and keeps its number there, because the human approved it in
  that context; a mixed row (one that also governs something that stayed in `043`)
  is carried whole. A reference inside a carried row to "this change", to a
  design section such as D9 or D13, or to a task of `043`'s old group 12 is to `043`
  as it was before the split: the table at the start of that section says where each
  one landed. The rows Q150 to Q169 are this change's own: the human answered them in
  chat on 2026-11-16 (Q150-Q157, after the drift-check and the VCDM pre-assessment of
  task 1.1) and 2026-11-17 (Q158-Q165, at the Checkpoint 3 of migrations `0012`, `0013` and `0014` and of the policy of task 3.3)
  (`043`'s own rows run to Q149, so this change's rows start at Q150). This change has
  no Open Questions.
- **Authored from `043`'s plan, not yet reconciled as a change of its own.** The
  text of D1 to D3 and of the tasks was written inside `043`, where it passed seven
  drift-checks against the merged `002` (2026-10-01 and 2026-10-07) and seven VCDM
  passes. This change's own VCDM pre-assessment (Mode A) and its drift-check
  against the merged `002` and against `043` as built are its first task (1.1),
  run before Checkpoint 1. A scope or design conflict that task finds is asked in
  chat and recorded in "Resolved decisions" as a row from Q150 on.
- **Drift-check of 2026-11-16 (task 1.1).** Run against `master` with `002`, `043` and
  `044` merged and archived. It found 16 items of mechanical drift, corrected in place
  in this design, the proposal, the spec and the tasks: the seven-kind `EmailTemplate`
  union and its telemetry value set after `044`, the route counts, the email options a
  mounted `createApp` now requires, the notice dispatcher's fixed template type, the
  notices' own per-recipient bucket of `043` Q101, a wrong task number, the archive
  paths, the numbering of new decisions, the runtime-role assertion, the target kinds of
  the identity wrapper, the system diagram's zone blocks, an ambiguous test file name,
  `044`'s out-of-band CLI and the documents that already exist. It found 3 conflicts,
  which the human decided as Q150 to Q152. The VCDM pre-assessment (Mode A) reported no
  blocking gap: its questions are Q153 to Q157, and its non-blocking gaps G4 to G8 are
  folded into the Observability contract, the posture table and the tasks (G9 was
  already closed by `043` Q101).
- **Where the earlier changes are now.** `002`, `043` and `044` are archived, so a
  reference to their design, spec or tasks is to
  `openspec/changes/archive/2026-10-15-002-auth-and-rbac/`,
  `openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/` and
  `openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery/`.
  `drift7.md`, the report of `043`'s seventh drift-check, was a working file and is not
  in the archive.
- **What it reuses from `043`, unchanged:** the `EmailSender` port and the controls of
  the notice dispatcher (the kill switch, the notices' own per-recipient bucket keyed
  by an HMAC, scope `notice_recipient`, `043` Q101, the per-tenant notice cap, the list
  of disabled tenants, at most 20 recipients); the identity router and its `defineIdentityOperation` wrapper (the
  caller's role is checked first, the input is parsed after, the target is resolved
  on the server, then Cerbos is asked with the target's real tenant, and the wrapper
  fails closed); `apps/api/src/identity/auth-repository.ts`, through which phase 1
  reads `session`, `apikey`, `invitation` and `member` (the purge job reads under
  row-level policies and is not a client of it); `revokeMachineCredential`, exported
  only on the `@tayzu/auth/machine-credentials` subpath and importable only from
  `apps/api/src/identity/**`; the mount switch (`MOUNT_IDENTITY_ROUTES`) and the
  route-table and procedure-list tests behind it; the committed
  `openapi/identity.openapi.json` and its drift check; the identity telemetry
  contract module `packages/auth/src/telemetry/identity-contract.ts` and the helpers
  `@tayzu/auth` exports for spans and counters; `runScript` (telemetry start and
  flush, and the script's own database-role assertion) and the script
  configuration loader; the user status state machine; the 5-second cache of the
  resolver.
- **What it extends from `043`, and how.** (1) The resolver checks of `043` D13:
  a principal of a tenant with a pending or purged marker is rejected, in the
  resolver and in token exchange (D4 here; `043` adds the ports for the `_user`
  lookup and this change adds the marker lookup). (2) The acceptance of `043` D4: an
  invitation of such a tenant answers the uniform rejection (D4 here). (3) The
  `EmailTemplate` union, which holds seven kinds after `044` (the two of `043`,
  `InvitationEmail` and `AdminAcceptedNotice`, and the five of `044`), gains
  `OrgDeletionNotice` as the eighth, and the notice dispatcher
  (`apps/api/src/identity/notices.ts`), which accepts only `AdminAcceptedNotice` and
  names its template with a constant, accepts it and derives the template name from
  the kind (D5). (4) The maintenance mechanism of `043` D9, in which the
  `_user` backfill and reconcile are operator-started Container Apps Jobs, becomes
  the reviewed workflow (D3). (5) The identity router gains one procedure, the
  OpenAPI document one path, the route-template matcher one path (D6, D9).
  (6) `RESOURCE_KINDS`, the target kinds of the identity wrapper and the role ceilings
  gain `organization` (D6). (7) The
  identity contract module gains the names of the Observability contract below.
- **History carried from `043`'s amendment notes**, so that a reader of the carried
  text is not surprised:
  - The purge uses a dedicated `tayzu_purge` role, an insert-only marker and an
    amended append-only trigger; reversal is an audited operator script and the
    admins are notified (Q26, Q27, 2026-10-01).
  - The reversal script and the `_user` backfill run only through a reviewed
    `workflow_dispatch` workflow (Q41).
  - There is no `SECURITY DEFINER` function: `tayzu_purge` deletes under per-table
    row-level policies limited to due tenants, lists the due tenants through a
    `SELECT` policy on the marker, and also deletes the Better Auth rows under
    policies gated on the same due marker, so the purge job holds that one role
    (Q48, Q49). Each maintenance script is its own Container Apps Job. The
    workflow's GitHub settings are a checklist the human applies (Q55).
  - The workflow takes its inputs only through `env` and its Azure role is limited
    to starting the named jobs (Q64). The purge role reads every `auth.member` row
    so that "all memberships are in due tenants" can be evaluated, its deletes stay
    limited to due tenants and its `DELETE` always comes with the `SELECT` and the
    `SELECT` policy it needs, and `tayzu_auth` keeps a permissive policy (Q65, Q59
    reworded). The pre-purge warning and the orphan-marker alert are a
    first-deployment gate (Q68). The completeness test also classifies the SSO
    re-authorization and back-channel logout identifiers, `auth.rate_limit` and
    `auth.jwks`; a repeated deletion request re-runs the idempotent revocations and
    is logged; the operator id is `gh:<numeric actor id>` with actor type `user`
    (Q70).
  - The migrations are three here (four in `043` before the split): the Better Auth
    side of the purge is its own file, `0014`, so that each approved migration stays
    immutable (Q82). The marker's columns that the request role must not set are
    protected by a column-level `INSERT` grant, because a `DEFAULT` does not ignore
    an explicit value; it also has the cancellation columns. The new roles need
    `USAGE` on the schemas, the purge deletes invitation tokens before the
    invitations their policy joins, and the runtime-role assertion covers the marker
    table (`043` Q109 already added `machine_credential_revocation`, the other table
    it missed).
  - The purge role's table list and deletion order, `purge_after` computed in SQL,
    the reversal role's `SELECT` and every script's own role assertion; each
    maintenance script starts telemetry and flushes it before it exits (Q79); the
    maintenance workflow has no checkout, no start override and a broader
    `CODEOWNERS`.
- Per `docs/references/platform-engineering/README.md:58` (the row naming
  `002-auth-and-rbac`; the matrix has no row for `043`, `044` or `045`), this change is
  where "an audit trail for authentication" (`CDE` L92, L104-106) extends to the
  deletion of an organization; `SOV` L873-L894 (the sovereign IAM use case: audit
  access, comply with GDPR) is the nearest passage on erasure, and it does not
  discuss organization deletion, so the two-phase window and the purge are Tayzu's
  own design, not something a report says. `docs/references/port/roadmap-analysis.md`
  has no section for `043` or `045`; its `002` row (L40-59, written before the
  split) lists "data retention/deletion policy and org deletion" among the
  capabilities this change now implements.

## Goals / Non-Goals

**Goals:**

- Let an admin delete an organization in two phases: access is revoked at once and
  the tenant is marked, then a scheduled job purges it for good after a 7-to-14-day
  window, with a documented retention policy and erasure statement (D1, D2,
  Resolved decisions Q14 and Q21).
- Keep the marker and the purge out of the request path's reach: an insert-only
  marker with column-level privileges, a dedicated purge role under row-level
  policies limited to due tenants, an append-only trigger that admits only that
  role, and no `SECURITY DEFINER` function (D1, Q26, Q48, Q49).
- Add exactly **three SQL migrations**, each a Checkpoint 3 item: `0012` (the
  tenant-deletion marker table), `0013` (its grants, the `tayzu_purge` and
  `tayzu_deletion_admin` roles, the catalog row-level policies and the amended
  append-only trigger) and `0014` (the row-level policies that gate the Better Auth
  rows). `043` keeps `0011`; nothing is renumbered.
- Authorize the request through Cerbos with the real tenant, never through an
  `actor.type` or origin check, and make it a high-risk operation that needs a
  fresh step-up (D6).
- Make the reversal an audited operator action that can only run through a reviewed
  workflow, and tell every administrator of the organization when a deletion is
  requested (D3, D5, Q27, Q41).

**Non-Goals:**

- No in-product way to cancel a pending org deletion: reversal is an audited
  operator action (Resolved decisions Q21 and Q27). No point-in-time restore of one
  tenant out of a shared-schema database. No BullMQ-based deletion queue: the purge
  is a scheduled job.
- No last-active-admin protection (any admin may request deletion, Q27; a ticket),
  and no pre-purge warning or orphan-marker alert here (a first-deployment gate
  owned by `010`, Q68).
- No change to the user lifecycle, invitations, service accounts, credentials,
  disable-takes-effect, the `_user` reconcile or the hand-offs from `002`: they stay
  in `043`. No org-wide audit-log **product surface**, its retention or export
  tooling (`015`, `010`): this change only emits the events. No multi-org UX (`042`).
- No changes to `002`'s MFA, Cerbos engine wiring or three-tier RBAC baseline. This
  change does edit `002`'s resolver and token exchange where its decisions require
  it (the marker lookup, D4), and says so.

## Decisions

### D1. Org deletion is two-phase: revoke now, purge later — [ADR-0019](../../../../docs/adr/0019-org-deletion-two-phase-purge.md)

Decision (Resolved decisions Q14, Q21, Q26, Q27, carried from `043`), rewriting the earlier
synchronous design, which could not work as written: `catalog_change_event` is
append-only (a trigger rejects DELETE for every role, owner included, and
`tayzu_app` has no DELETE or TRUNCATE), `machine_credential_revocation` has no
DELETE grant, catalog tables run on `tayzu_app` and Better Auth tables on
`tayzu_auth` (two roles and pools cannot share a transaction), `apikey` has no
FK to the organization, and several catalog FKs are `RESTRICT`. The catalog
tables are also `FORCE ROW LEVEL SECURITY` with policies `TO tayzu_app`, so a
function owned by `tayzu_migrator` (no policy, no `BYPASSRLS`, `002` D6) would
see zero rows: it cannot be the purge mechanism. Resolved decision Q26 therefore superseded the `tayzu_migrator` owner that Q14
named, and Resolved decision Q48 goes one step further: there is no `SECURITY
DEFINER` function at all (below).

**Phase 1, request** (`identity.organization.delete`): Cerbos `organization.delete`
with the real tenant (any `admin` may request it, Resolved decision Q27),
step-up, and an explicit confirmation: the caller sends the organization's
identifier, and it must equal the **host** `ctx.tenantId` (never a value looked
up from input). The operation inserts a **deletion marker** for the tenant
(`tenant_deletion_marker`, migrations `0012` to `0014`, Checkpoint 3), revokes
every session whose active organization is the tenant, revokes every org-owned
credential (revocation list), cancels pending invitations, sends the
org-deletion notice to the administrators of the organization through the notice controls of `043` (D4 there, Resolved decision Q53; the template is D5 here), and emits
`catalog.audit.org_deletion_requested`. From that moment `resolveContext` and
token exchange reject every principal of the tenant, human or machine, and an invitation of the tenant is no longer acceptable (D4 here). The window is between 7
and 14 days (configurable, validated at startup; the default is 14, Resolved
decision Q21). The request computes `purge_after` in SQL, as
`now() + make_interval(days => $1)` with the day count as a bound parameter, so it
and the database-set `requested_at` come from one transaction clock: a date computed
in the application would let clock skew refuse a valid request at the 14-day bound.
Requesting it again while pending inserts no second marker, sends no
second notice and returns the original date, but **re-runs the idempotent
revocations** (sessions, credentials, invitations): a first request that failed
half-way would otherwise leave a session or a credential alive that a later reversal
could never repair. The repeated request is logged as
`catalog.security.org_deletion_repeated`.

**The marker is a trust boundary** (Resolved decision Q26): a "due" check is
worthless if the role that serves requests can write the marker. So:

- The marker is **insert-only for `tayzu_app`**: it can insert the tenant's own
  row (RLS) and read it, and it has no UPDATE or DELETE. `requested_at` is set
  by the database (`DEFAULT now()`), but a `DEFAULT` does not ignore an explicit
  value, so what keeps the request role from setting it, `state` (it could insert
  `purged`) or a step timestamp is a **column-level `INSERT` grant** limited to the
  tenant id, `purge_after` and the requesting actor; every other column takes its
  default. A `CHECK` constrains `purge_after` to between `requested_at + 7 days` and
  `requested_at + 14 days`, so a request-path compromise cannot insert a past-dated
  marker. One pending marker per tenant is a partial unique index. A marker has a
  `state` (`pending`, `cancelled`, `purged`), the timestamps of the two purge steps,
  `requested_by` (an opaque id) and the cancellation fields `cancelled_at` and
  `cancelled_by` (the operator's opaque id), which only the reversal role can set.
- A dedicated role, **`tayzu_purge`**, created by migration `0013` (as `0006`
  created `tayzu_app`: guarded, with no password, provisioned out of band), with
  its own pool and its own secret, is used **only** by the purge job. Only it can
  update the marker's progress. It owns nothing, and there is **no `SECURITY
  DEFINER` function** (Resolved decision Q48): such a function would have to be
  owned by `tayzu_purge`, and `ALTER FUNCTION ... OWNER TO tayzu_purge` needs the
  migrator to be able to `SET ROLE` to it, which contradicts the rule that no role
  can. `002`'s migrations only `GRANT`. (PostgreSQL 16 gives the creating role,
  `tayzu_migrator`, an admin-only membership of a role it creates, with
  `set_option` and `inherit_option` false, so a `pg_auth_members` row will exist;
  the test asserts that no application role can actually `SET ROLE` to it and that every
  row that names it as the granted role and an application role (`tayzu_app`,
  `tayzu_auth`, `tayzu_migrator`, `tayzu_deletion_admin`) as the member has both
  options false; the test harness's own bare `GRANT ... TO current_user`
  (`harness.ts`) carries both options and names the connecting test role, which is
  not an application role, so the rows are filtered by member.) Schema `public` is granted per role (`0006`), so each new
  role also gets `USAGE` on `public`.
- `tayzu_purge` has `DELETE` **and `SELECT`** on the tenant's tables, **named one by
  one** (not by a prefix): `catalog_blueprint`, `catalog_relation_definition`,
  `catalog_entity`, `catalog_entity_relation`, `catalog_change_event`,
  `catalog_tenant_sequence` and `machine_credential_revocation` (which has no
  `catalog_` prefix). A `DELETE ... WHERE tenant_id = ...` needs the `SELECT`
  privilege and a `SELECT` policy as well as the `DELETE` ones, and the
  `entities_removed` count needs reads. Each table has a `SELECT` and a `DELETE`
  policy limited to tenants **with a due marker** (`state = 'pending'` and
  `purge_after <= now()`), so row-level security itself enforces "only due
  tenants" even for the owner (FORCE). Listing the due tenants is a `SELECT`
  policy on the marker for `tayzu_purge` with the same predicate, so the job
  enumerates them across tenants without any blanket read of the marker table.
  The reversal role, `tayzu_deletion_admin`, can only update `state`, `cancelled_at`
  and `cancelled_by` of a pending marker with no recorded step and a future
  `purge_after`, and it holds `SELECT` on the marker under a policy that reads every
  `pending` marker and the tombstone its own transaction writes (an `UPDATE ... WHERE`
  and its `RETURNING` need one, and the script must tell a begun or past-due purge
  from a missing marker; Resolved decision Q171), never an earlier tombstone or a
  purged marker; it reads no tenant data and has no `USAGE` on `auth`.
- The append-only trigger on `catalog_change_event` (migration `0001`) is amended
  to allow DELETE **only when `current_user` is `tayzu_purge`**, a real identity,
  not a settable flag (a GUC would be spoofable). Every other path, including the
  table owner and `tayzu_app`, still raises, and for `tayzu_purge` the policy above
  still limits the rows to a due tenant.
- **The Better Auth rows get the same boundary** (Resolved decision Q49), in its own
  migration, `0014`, so that the approved `0013` stays immutable (Q82,
  recommended option). The `auth` tables have no row-level security and `tayzu_auth`
  has full CRUD on every tenant's rows, so a purge step run as `tayzu_auth` would be
  gated only by code, the weakness this section argues against. Migration `0014`
  therefore gives `tayzu_purge` `DELETE` (and the `SELECT` it needs) on the Better
  Auth tables that step 2 below deletes from, named one by one (`organization`,
  `member`, `invitation`, `apikey`, `session`, `user`, `account`, `two_factor` and
  `verification`, each with an explicit table-level `GRANT SELECT, DELETE`, because a
  policy grants nothing without the privilege), under policies gated
  on the **same due marker**, and `USAGE` on the `auth` schema (`0003` revokes it from
  everyone but `tayzu_auth`): an organization-keyed row (`invitation`, `member`,
  `apikey` by `reference_id`, a `session` by `active_organization_id` (which has no
  foreign key) and the organization) only when its organization is due; a user-keyed
  row only for a user whose memberships are all in due tenants; and an
  `auth.verification` row by its identifier family, joined to the row it names (an
  `invitation-accept:` row to its invitation, a `step-up-verified:` row to its
  session, a `temp-password:`, `mfa-reenrol:` or `sso-link:` row to its user or
  account, and an `invitation-shed:` row to its invitation), so a verification row is
  deleted **before** the row its policy joins (an `sso-link:<accountId>` row before the
  account it names, a `temp-password:<userId>` or `mfa-reenrol:<userId>` row before the
  user, an `invitation-accept:<invitationId>` or `invitation-shed:<invitationId>` row
  before its invitation). `mfa-reenrol:<userId>` is the marker `044` writes after an MFA
  reset, with a far-future expiry that nothing else removes, and
  `invitation-shed:<invitationId>` is the record `043` keeps of the session an
  acceptance's shed kept; both are purged (Resolved decision Q150, following `044` D18).
  `044`'s `password-reset:<id>` row is **not** purged and gets no policy: its identifier
  holds neither a tenant nor a user, so a policy that joins by identifier family cannot
  join it, and it is 30-minute state (the completeness test of D2 exempts it).
  **Evaluating "all memberships" needs the purge role to see the user's other
  memberships** (Resolved decision Q65), so `tayzu_purge` also gets a **read-only
  `SELECT` policy over every `auth.member` row**, while its `DELETE` on `member`
  stays limited to due tenants. Without it the policy that exposes only due rows
  would make the predicate true for a user who also belongs to a tenant that is
  not due. Enabling row-level security on these tables needs a permissive policy
  `TO tayzu_auth` (`USING (true)`), so Better Auth's own behavior is unchanged: the
  due-tenant restriction applies to the purge role, not to `tayzu_auth` (Q59,
  reworded by Q65). The exact predicates are fixed in the migration and reviewed
  at Checkpoint 3.

### D2. Phase 2, the purge, is a scheduled job that runs as `tayzu_purge` — ADR-0019

**Phase 2, purge** (a scheduled job; an Azure Container Apps Job provisioned
with `010`, with its entry point a `tsx` script in this change (started through `043`'s `runScript` helper, which starts and flushes telemetry, Q79),
`apps/api/scripts/purge-job.ts` (`pnpm --filter @tayzu/api identity:purge`), no
HTTP listener). It holds **one** database secret, `tayzu_purge`, and must refuse
to run as another role, and the existing `assertRuntimeRole` of
`apps/api/src/bootstrap.ts` cannot do that: it is private and checks only
superuser, `BYPASSRLS` and table ownership, so `tayzu_app` would pass it. The job
therefore adds a new check, `current_user = 'tayzu_purge'`. It lists the due
tenants through the `SELECT` policy on the marker and, for each one, runs two
idempotent steps with safe resume (progress is recorded on the marker):

1. **Catalog data**: ordered deletes of relations, entities, blueprints and the
   other `catalog_*` rows (the order respects the `RESTRICT` FKs), the append-only
   rows included, because the trigger and the policies admit `tayzu_purge` for a
   due tenant.
2. **Better Auth data**, under the due-marker policies of Resolved decision Q49.
   First the org's invitation tokens and shed records in `auth.verification`
   (`invitation-accept:<invitationId>` and `invitation-shed:<invitationId>`, Q150)
   and then the invitations themselves, **before any user** (Resolved decision Q163):
   deleting a user cascades, outside row-level security, to every invitation that
   user sent (`invitation_inviter_id_fk ON DELETE CASCADE`), and a token or shed
   record whose invitation is gone can no longer be joined by its policy. Then
   each user who has no membership in any other org (deleted while their
   membership in this org still exists, so the policy can evaluate it) together
   with that user's `account`, `session` and `two_factor` rows and the
   `auth.verification` rows keyed by that user (`temp-password:<userId>`,
   `mfa-reenrol:<userId>` and `sso-link:<accountId>`; the verification rows go first, because their policies join
   the user and the account), **in one transaction per user that re-checks the user's
   memberships**, so a membership added between the check and the delete is seen;
   then, in this order, the API keys (`referenceId`), the sessions
   whose `active_organization_id` is the tenant (those of users who stay) and the
   members; and the organization row last. The step-up
   marker is keyed by the **session token**, not by the user
   (`step-up-verified:<sessionToken>`, `packages/auth/src/step-up.ts`), so the step
   first collects the tokens of the sessions it is about to delete and deletes the
   markers of those tokens, before it deletes the sessions. Global user data is not
   per-org, so deleting only `member`/`invitation`/`apikey` would orphan it.

The purge job is its own Container Apps Job with its own identity and secrets
(Resolved decision Q49), and the reversal is another one (it holds
`tayzu_deletion_admin`); neither holds a role of the other, and none of `043`'s
scripts (the blueprint backfill and the `_user` reconcile, which hold `tayzu_auth`
and `tayzu_app`) holds `tayzu_purge`, and neither does `044`'s break-glass CLI
(`recover-admin-mfa`, which holds `tayzu_auth`). Each script **asserts its own database
role** at start (`current_user` against the role or roles it declares), through the
helper of `043`'s task 2.0, and refuses to run otherwise: `002`'s runtime-role
assertion runs only in `createAppFromEnv` (`002` Q62), which no script goes through.
The `tayzu_purge` secret is documented with an owner and a rotation in
`docs/security/secrets.md`, and so is the reversal role's. The scripts read the
**separate configuration loader** of `043` (`apps/api/scripts/script-config.ts`),
which this change extends with `PURGE_DATABASE_URL` and `REVERSAL_DATABASE_URL`
(read only by the two scripts, never printed, `sslmode=verify-full` outside test
like `DATABASE_URL`), and **each script starts telemetry, emits its audit events and
flushes before it exits** (Resolved decision Q79) through the same helper: telemetry
starts only in `apps/api/src/main.ts` today, so the durable `catalog.audit.*` events
of a short job would be no-ops without it. The environment names are the ones the
app already reads (`OTEL_EXPORTER_OTLP_ENDPOINT` and `TAYZU_TELEMETRY_DISABLED`),
documented in `docs/security/secrets.md`. Two CLIs stay outside everything here: the
bootstrap CLI (Resolved decision Q91, `043` D9) and `044`'s break-glass
`recover-admin-mfa` (Resolved decision Q155, `044` D12). An operator runs each out of
band, the second under just-in-time access (Azure PIM).

A **completeness test** is driven by the schema, not by a list: it enumerates
every table that has a `tenant_id` column (catalog), every `auth` table that
references an organization or a user **by foreign key or by column name**
(`apikey.reference_id` and `session.active_organization_id` have no foreign key)
and the `auth.verification` rows by identifier pattern (`invitation-accept:`,
`invitation-shed:`, `temp-password:`, `mfa-reenrol:`, `sso-link:` and
`step-up-verified:`, which are keyed by string, not by foreign key, and which step 2
deletes), and fails unless each is deleted by a purge step or explicitly
exempted with a reason, so a later change that adds a table cannot silently escape
the purge. `002`, `044` and Better Auth write more identifier families than those, and
the test must classify them too, or its "an unlisted pattern fails" case fails on the real
schema: `sso-reauth-state:` and `sso-reauth-result:` (`apps/api/src/reauthorization.ts`)
are deleted by the deletion request itself, in the same operation that deletes the
tenant's sessions, keyed by those sessions' tokens (Resolved decision Q170), and
otherwise exempt as short-lived state with its own expiry;
`backchannel-logout:<client>:<jti>` (`server.ts`) is exempt (replay state keyed by the
identity provider's client and token id, not by tenant); `2fa-<random>` and
`2fa-attempts-2fa-<random>` (written by Better Auth's two-factor plugin on every
enrolled sign-in) are exempt as short-lived state keyed by a random value;
`password-reset:<id>` (`044`'s reset token: a random id, a digest and a user id in its
value, 30 minutes, cleaned by the next issue) is exempt as short-lived state that no
identifier-family policy can join (Q150); the OAuth
state identifiers, if an SSO sign-in in the test shows that Better Auth writes any to
`auth.verification`, are classified the same way; and the tables `auth.rate_limit`
and `auth.jwks` (the platform's signing keys) are exempt. `auth.rate_limit` stays
exempt for a corrected reason (Resolved decision Q151): a row holds only a count and a
timestamp under a key that is an unsalted SHA-256 of a scope and a tenant id, a user
id, an IP or the keyed (HMAC) hash of an email, so it holds no personal data in clear,
although the key of a tenant-keyed bucket (`invitation_tenant`, `notice_tenant`,
`account_created_notice_tenant`) can be recomputed from the tenant id, which the
marker's tombstone keeps anyway. The rows persist after a purge, the erasure statement
says so, `tayzu_purge` gets **no** grant on the table, and removing old rows is `044`'s
ticket "Prune `auth.rate_limit`", not the purge. Each classification, and its reason,
is a line of the test's table. `044`'s `verification-families.int.test.ts` is the
early-warning list of the families that change writes.

`catalog.audit.org_deletion_completed` is emitted by the purge itself
immediately before the organization row is deleted, **not** from Better Auth's
`afterDeleteOrganization` hook, and is flushed before the job exits (Q79) (the installed plugin also has
`beforeDeleteOrganization`, and the `after` hook runs after the delete). A
failed step emits `catalog.security.org_deletion_failed` (with the step) and
the next run resumes. The marker stays as a tombstone (tenant id, state and
timestamps only) so a later request finds nothing to purge.

### D3. Reversal is an audited operator action, started only through a reviewed workflow — ADR-0019

**Reversal** (Resolved decisions Q21, Q27) is the pending window plus one
audited operator action, not point-in-time restore: server-level PITR cannot
restore one tenant out of a shared-schema database, and there is no in-product
cancel. A platform operator runs a `tsx` script that **tombstones** the marker
(`state = 'cancelled'`, `cancelled_at` and `cancelled_by`; the row is never deleted) and emits
`catalog.audit.org_deletion_cancelled` with the operator's opaque id. It refuses a
tenant whose purge has begun (a step timestamp is recorded) or whose purge date has
passed, so a half-purged tenant can never be revived with its catalog data gone,
and the `tayzu_deletion_admin` policy enforces the same condition in the database.
A reversal does **not** restore what phase 1 revoked permanently: every org-owned
credential stays revoked and the admins must rotate each one (the runbook says
so). After the reversal the tenant's principals are accepted again and a later
request inserts a new marker. The script runs as the dedicated
`tayzu_deletion_admin` role of Resolved decision Q35 (migration `0013`), which can
only tombstone a pending marker. It is started **only** through a manual
`workflow_dispatch` GitHub Actions workflow that runs only from `master`, whose
environment has required reviewers, which starts an Azure Container Apps Job
through OIDC (Resolved decisions Q41 and Q55), so the named second approver is
enforced technically and the operator identity is authenticated. The second approver is
a **second human** (Resolved decision Q153), added as a reviewer of the environment and
as a code owner before the first deployment; "prevent self-review" leaves a
single-person repository with nobody who can approve, so until that person is added the
workflow cannot be enabled, and neither a bot account nor self-review stands in.
The identity works this way: the opaque
operator id is derived from the workflow's authenticated actor and handed to the
job by the workflow, never typed as an argument. It is `gh:<numeric GitHub actor
id>` (never the login, which can be a bot name such as `x[bot]` that the catalog's
id pattern `[A-Za-z0-9_.:-]{1,128}` rejects), and it is the `onBehalfOf` of the
`system` writes with the actor type `user`, one of the closed set of four (Q70). The job runs inside the VNET, so
no one connects to the production database from a workstation. The same workflow
also starts `043`'s maintenance scripts, the blueprint backfill and the `_user`
reconcile (`043` D1 and D9). Until this change lands, `043` runs those two as
operator-started Container Apps Jobs under just-in-time access (Azure PIM), with the
operator's opaque id taken from the job's environment and the named second approver
recorded in the change record; this workflow **extends** that mechanism by deriving
the same operator id from the workflow's authenticated actor instead, so that the
second approver is enforced technically for them as well (Resolved decision Q41,
which names both the reversal and the backfill). The reconcile's change events carry
the operator id as `onBehalfOf`, like the reversal. The workflow is only as strong as its GitHub
settings, which are human-owned (Resolved decision Q55) and recorded as a
checklist in `docs/security/secrets.md`: required reviewers with "prevent
self-review" on the environment, deployment branches limited to `master`, the
OIDC federated credential's subject pinned to that environment, and (Resolved
decision Q64) the federated identity's Azure role limited to the action that starts
the named Container Apps Jobs and scoped to those job resources only, plus branch
protection on `master` with "Require review from Code Owners", without which the
`CODEOWNERS` entry below has no effect (five settings in all). The human also confirms
whether a job start can carry an execution template that overrides the job's command,
arguments or image: if it can, a role limited to "start the named jobs" is not limited
to the job's own command, and the workflow's tests below forbid every override. That
confirmation is made in `010`'s sandbox rehearsal (Resolved decision Q157): if a start
request can carry such a template, it is recorded as an accepted risk, covered by
`CODEOWNERS`, the environment approval and the workflow's text tests, and a custom Azure
role is a ticket. The workflow file also carries a branch condition and a test reads it.

**Workflow inputs and supply chain** (Resolved decision Q64). The runner holds an
Azure OIDC token that starts jobs running as `tayzu_purge` and
`tayzu_deletion_admin`, so a tenant id interpolated into a `run:` script or a command
line would be script injection. Every input is a `choice` (the job) or validated
against a regular expression (the tenant id, the catalog's id pattern) and reaches
the job **only through `env`** (or the job's environment-variable arguments), never
through an expression inside `run:`; a test fails on `${{ inputs.* }}`,
`github.event.*` or `github.head_ref` inside a `run:`. Every third-party action is
pinned by commit SHA (and none is a local action, which a SHA test would mis-handle
and `CODEOWNERS` would not cover), the workflow has **no checkout and no setup step**
(only a pinned Azure login and the `az` call that starts the job), the call passes
no `--command`, `--args`, `--image` or `--env-vars` override other than the fixed
variable names, no other workflow names the same GitHub environment, and a
`CODEOWNERS` entry covers `.github/workflows/**`, `.github/actions/**`, the
`CODEOWNERS` file itself and `apps/api/scripts/**`, so a change to any of them needs
the owners' review (the owner is `@nahuex`, Resolved decision Q72, joined by the second
human of Q153, without whom a change by the owner has no reviewer; the repository has
no `CODEOWNERS` file today). The workflow's `choice` input lists the reversal, the
blueprint backfill and the reconcile only: neither out-of-band CLI (the bootstrap CLI
and `044`'s `recover-admin-mfa`, Q91 and Q155) is started by it, and `CODEOWNERS` still
covers both because they live under `apps/api/scripts/`. The runbook in
`docs/security/data-retention.md` still requires just-in-time access (Azure PIM)
for any other operator access with a personal account, and records the **named
second approver** in the change record. Backups keep purged data until the backup
retention expires; the erasure statement in `docs/security/data-retention.md` says
so, and also names what a purge does not remove by itself: Cerbos decision logs,
Azure Monitor data, Azure Communication Services records and backups. A
compromised admin session with a fresh MFA can no longer destroy a tenant
irreversibly in one call, and the org administrators are told within the request
that it happened (at most 20, D5).

- _Alternative:_ immediate hard delete as the first draft had it, with a
  point-in-time restore runbook. Rejected by Resolved decision Q14.
- _Alternative:_ keep change events and pseudonymize snapshots. Rejected: it
  keeps the tamper-resistance but partially defeats erasure of the `_user`
  emails the snapshots hold.
- _Alternative (Q26):_ `tayzu_app` executes the function with only `CHECK`
  constraints (a request-path compromise could purge any tenant after a short
  wait), no automated purge in v1 (needs a human per deletion), a `SECURITY
DEFINER` function that disables the trigger (needs the table owner and a heavy
  lock), or a marker table without RLS (breaks `002` D6's rule that every
  catalog table is RLS-forced). All rejected.
- _Alternative (Q48):_ keep the `SECURITY DEFINER` purge and lister functions with
  an ownership transfer to `tayzu_purge` (it needs the migrator to be able to `SET
  ROLE` to it, which the design forbids), or with `tayzu_migrator` as the owner and
  policies `TO tayzu_migrator` (it widens the migrator's reach). Both rejected.

### D4. A tenant with a pending or purged marker is closed to every principal and to invitation acceptance

This extends `043` D13 (the resolver checks) and D4 step 2 (the acceptance). A
principal, human or machine, of a tenant with a **pending** or **purged** deletion
marker is rejected; a cancelled marker (a tombstone) does not reject. The check is
made in `resolveContext` and in token exchange, through the existing 5-second cache
(keyed by tenant) and **failing closed** on any lookup failure, and it is selected by
the credential branch (a session cookie or a bearer machine token), never by
comparing `actor.type`, which lint bans outside three files (`043` D13). The marker
is read as `tayzu_app`, which holds `SELECT` on the marker under the tenant-isolation
policy of migration `0013` (D1), so the lookup sees only the tenant's own marker.
`exchangeMachineToken` already gains ports for the `_user` lookups in `043`; this
change adds the marker lookup, and token exchange refuses to **mint** a token for a
credential of such a tenant, not only to accept an already-issued one. Each rejection
emits `catalog.security.principal_rejected` with the reason `tenant_pending_deletion`
and increments `tayzu.identity.principal_rejections`.

An invitation of such a tenant is no longer acceptable: it answers the same uniform
rejection as every other dead invitation (`CATALOG_NOT_FOUND`, `043` D4 step 5), with
the denial reason `tenant_pending_deletion` only in
`catalog.security.invitation_acceptance_denied`. Phase 1 also cancels the tenant's
pending invitations (reason `org_deletion` on `catalog.audit.invitation_cancelled`),
so the acceptance check is the second layer.

**The password-reset routes are left untouched** (Resolved decision Q152). `044`'s two
public routes do not go through `resolveContext`, and its eligibility reads memberships
and the `_user` status only. A user of a tenant with a pending marker can still reset a
password during the window: the account is global, a reset grants no access to the
closed tenant (every session it leads to is rejected by the check above), and a user who
also belongs to another tenant must keep a way to recover the account. A test proves
that a reset completed during the window does not reopen the tenant (task 5.6). Making
eligibility ignore pending tenants, or disabling every `_user` in phase 1, were rejected.

The switch of `043` D15 gates the **routes** only: the rejection applies to the
catalog `/v1` routes from the deploy of this change, not from the mount. Migrations
`0012` and `0013` therefore run before the release that carries this check serves
traffic, because a failed marker lookup rejects every principal (Migration Plan).

### D5. The deletion notice is the eighth fixed template and goes through `043`'s notice controls

The **org-deletion notice** (D1, Resolved decision Q27) is the eighth fixed template of
the email port (`043` D5; `043` ships `InvitationEmail` and `AdminAcceptedNotice`, `044`
adds `PasswordResetEmail`, `PasswordChangedNotice`, `MfaChangedNotice`, `MfaResetNotice`
and `AccountCreatedNotice`, and this change adds `OrgDeletionNotice` to the closed
`EmailTemplate` union, with its case in the renderer of
`packages/auth/src/identity/email/azure-communication-email.ts`): a fixed
subject and body whose only interpolated value is the purge date, with **no link** and
no tenant or actor free text. It is sent as one email per recipient to the
administrators of the organization (at most 20), resolved on the server from the
tenant's memberships, once per deletion request (a repeated request while pending
sends nothing), through the notice dispatcher of `043` (Resolved decision Q53): the
kill switch, the notices' own per-recipient bucket (`notice_recipient`, 3 per 24 hours,
`043` Q101), the per-tenant notice cap (`notice_tenant`, 60 per hour), the list of
disabled tenants and the limit of 20 recipients. The dispatcher of `043` is typed for
`AdminAcceptedNotice` alone and names its template with the constant `admin_accepted`
(`apps/api/src/identity/notices.ts`), so this change widens it: it accepts
`OrgDeletionNotice` and derives the template name (`org_deletion`) from the kind, with
its controls unchanged. A send failure never blocks the request
(access has already been revoked) and is logged as
`catalog.security.org_deletion_notice_failed`; a suppressed or truncated notice is
logged as `catalog.security.notice_suppressed` with the template `org_deletion`.

### D6. API contract: one route, built with `043`'s wrapper

`identity.organization.delete` is **one oRPC procedure**, `DELETE /v1/organization`,
added to the identity router of `043` (`apps/api/src/identity-router.ts`, merged with
the catalog router into the one `OpenAPIHandler`). After `044` the switch of `043` D15
gates seventeen routes: fourteen oRPC procedures (the thirteen of `043` and `044`'s
`identity.users.resetMfa`) and three plain routes (the accept route and `044`'s two
password-reset routes). This one is the fifteenth oRPC procedure and the eighteenth
route, registered behind the same switch. It declares
`.route({ method: 'DELETE', path: '/v1/organization', spec: markHighRisk })`, because
step-up runs only in the OpenAPI interceptor, keyed on the route spec, and it uses
`inputStructure: 'detailed'`: the confirmation travels in the query string
(`?confirmation=<organization identifier>`) and is compared to the **host**
`ctx.tenantId`; a confirmation sent only in a body does not count (Resolved decision
Q47, item 2).

It is built with `defineIdentityOperation({ authorization: { kind: 'organization',
action: 'delete', resolveTarget }, handler })`, so the wrapper's order holds: the
caller's role is checked first in the caller's own tenant, then the input is parsed and
the target resolved, then Cerbos is asked with the target's real tenant, and only then
the handler runs. The target of `organization.delete` is the host tenant itself: the
resource id is the tenant id (the opaque id of `043` D3's table) and the real tenant is
the host tenant, never a value read from input. The wrapper's target kinds are
`invitation`, `credential` and `user` today (`IdentityTargetKind` in
`apps/api/src/identity/identity-target.ts`), and a declared target is resolved through
the target resolver and a per-kind operation name in
`apps/api/src/identity/define-operation.ts`, so both gain the kind `organization`, which
resolves to the host tenant with no lookup. Every Better Auth call the handler makes
is given the host tenant only.

The Cerbos side: `RESOURCE_KINDS` in `packages/authz/src/resource-kinds.ts` gains
`organization`; `policies/role_policies/admin.yaml` (a ceiling that lists kinds one by
one) gains it, with `member.yaml` if a ceiling must be stated and
`role_policies_test.yaml`; and a new resource policy, `organization.yaml`, allows
`delete` to `admin` only (any admin may request it, Resolved decision Q27), imports
`002` D7's `same_tenant` derived role and carries the explicit cross-tenant
`EFFECT_DENY` that `002` D8 requires in every resource policy, with every attribute
reference guarded by `has()` (`043` D3). The existing `same_tenant_test.yaml`, the
"denied on every kind" suite, is extended with the kind. A role-policy allow does
nothing without a resource-policy allow, so the admin-allowed assertions are made with
the resource policy. Every new policy and policy edit is a ⛔ **Checkpoint 3** item.

`identity.organization.delete` is in the high-risk set (`x-tayzu-risk: high`, VCDM
B11), so a fresh step-up is required over HTTP; the committed
`openapi/identity.openapi.json` (paths, methods, path parameters and `x-tayzu-risk`
only, `043` D10) gains the path. Error codes reuse `001` and `002`'s: `AUTH_FORBIDDEN`
(403), `AUTH_STEP_UP_REQUIRED` (403), `CATALOG_VALIDATION_FAILED` (400) for a
confirmation that does not name the host tenant. The change introduces no new code.

### D7. Testing strategy

Integration tests run against a real PostgreSQL 18 (ADR-0024) and a real Cerbos test container
(`002`'s harness): the purge tests connect as `tayzu_purge`, the reversal tests as
`tayzu_deletion_admin` and the request tests as `tayzu_app`, so that the privilege
boundaries of D1 are exercised by the roles themselves and not by code (the harness
gains the two roles, task 1.3). The `EmailSender` port is the recording fake of `043`,
never the real Azure Communication Services API. Failure seams (after the marker,
after step 1 of the purge, between a membership check and a delete) prove the safe
resume and the per-user re-check. Step-up is tested **over HTTP only** (`043` D10), and
so are the route's authorization, its cross-tenant 404 and the mount gate. Since `044`
`createApp` refuses to mount the identity routes without the email path (the HMAC
secret, the email provider and the reset link base URL), so every test that mounts them
passes `testEmailOptions()` from `apps/api/src/__fixtures__/email-options.ts`. The
maintenance workflow is tested as text, from `apps/api/src` (`.github` is outside every
package), like `zap-seed.test.ts`. A completeness test driven by the schema keeps a
later table from escaping the purge (D2). `cerbos compile` (with its bundled test
suites) gates the policy files.

### D8. Docs-as-Code and ADRs from this change

- `docs/adr/0019-org-deletion-two-phase-purge.md` (D1 to D3, including the purge
  role, the marker's integrity rules and the reversal control). `043` reserved the
  number: its own ADRs are 0017, 0018 and 0020.
- This change amends `docs/adr/0014-postgres-roles-and-forced-rls.md`, which says
  "Three roles" and records row-level security on the `tayzu_auth` tables as "Not
  applicable", while this change adds two roles and row-level security on the Better
  Auth tables.
- `docs/security/data-retention.md`, which `043` created for its own operational
  policies (the invitation caps, the email policy, the credential rotation cadence,
  the off-boarding step) and `044` extended (the two identifier families, the reset caps
  and its hand-off note to this change), gains the retention policy and the erasure
  statement, replacing its sentence that nothing about org deletion is stated yet: the
  purge window; the PostgreSQL backup retention of 7 days, so purged data is gone from
  the backups at most 21 days after the request with the default window (Resolved
  decision Q156); what a purge does not remove by itself (backups until that retention
  expires, Cerbos decision logs, Azure Monitor data, Azure Communication Services
  records, the 30-minute `password-reset:<id>` rows, and `auth.rate_limit`, whose rows
  hold a count and a timestamp under an unsalted SHA-256 of a tenant id, a user id, an
  IP or a keyed email hash, with no personal data in clear, and are exempt from the
  purge, so they persist until `044`'s ticket "Prune `auth.rate_limit`" removes old
  rows; Q151); the reversal runbook (the maintenance
  workflow with its environment reviewers as the named second approver, just-in-time
  access through Azure PIM with a personal account for any other operator access, the
  script, which refuses a tenant whose purge has begun and does not restore the
  credentials phase 1 revoked, so the admins rotate each one); and the retention of
  audit and security logs (12 months, independent of tenant deletion, stated as the
  target that `010` implements, Q156, and cross-referenced from `010`/`015`).
- `docs/security/secrets.md`: the `tayzu_purge` secret of the purge job and the
  reversal role's secret, each job with its own identity, with owner and rotation; the
  telemetry environment names every script reads; the OIDC federation; and the GitHub
  settings checklist of the maintenance workflow (required reviewers with "prevent
  self-review", deployment branch limited to `master`, OIDC subject pinned to the
  environment, the Azure role limited to starting the named jobs, and branch protection
  with "Require review from Code Owners"; Resolved decisions Q55 and Q64), with the
  second human who is the environment reviewer and a code owner (Q153) and the
  start-template confirmation of the sandbox rehearsal (Q157).
- `docs/security/attack-surfaces.md`: the route `DELETE /v1/organization` and its mount
  gate state, the route count, and the `workflow_dispatch` entry point of the maintenance
  workflow. `docs/catalog/auth-and-rbac.md`: the `organization` kind and the new
  events. `docs/architecture/system-diagram.md`: the platform operator's reversal (the
  operator is already drawn, since `043`), the purge job with its database connection as
  `tayzu_purge`, the reversal script and the GitHub Actions workflow that starts it
  through OIDC, in the full diagram **and** in the diagram of each trust zone they touch,
  with each rendered image (the document has one block per zone since `044`).

### D9. The route's path reaches telemetry only as its template

`DELETE /v1/organization` has no path parameter, and its confirmation travels in the
query string, which the HTTP instrumentation already drops (`002` Q67, `043` D16). The
route-template matcher of `043` D16, which matches the parsed pathname against the
identity paths, gains this path, and the organization's name and identifier never reach
any exported signal.

## Observability contract

Tracer/meter name `@tayzu/auth`, version equal to the package version, as in `043`.
Shared attribute keys (`tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`) come
from `@tayzu/observability/semconv`, unchanged. The names of this change are **added to
`043`'s identity contract module**, `packages/auth/src/telemetry/identity-contract.ts`
(Resolved decision Q74 of `043`), which `otel-smoke-check` already imports; `002`'s
contract is untouched. Every span, counter and log event is created through the helpers
that `@tayzu/auth` exports (`apps/api` has no `@opentelemetry/api` dependency), and the
purge and the reversal start telemetry and flush it before they exit (Resolved decision
Q79), so their audit events are exported.

Identifier rules: no organization name, email, token, credential name or secret appears
anywhere. `tayzu.identity.operator.id` is the platform operator's opaque identifier,
derived from the maintenance workflow's authenticated actor and never self-asserted or
an email (Q41): `gh:<numeric actor id>`. In every audit event `tayzu.actor.id` is the
**admin** who acted (the `onBehalfOf` of the `system` write), never the `system` actor;
for the cancellation it is the operator.

### Spans

| Span name                               | When   | Required attributes                                                                                    | Conditional attributes |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| `identity.organization.delete`          | op     | `tayzu.tenant.id`                                                                                                                 | —                                                                    |
| `identity.organization.cancel_deletion` | script | `tayzu.tenant.id`, `tayzu.identity.operator.id`                                                                                   | —                                                                    |
| `identity.organization.purge`           | job    | `tayzu.tenant.id`, `tayzu.identity.org_deletion.step` (`catalog`\|`auth`), `tayzu.identity.org_deletion.entities_removed`         | —                                                                    |

All spans are `INTERNAL`, one per operation (one per tenant and step for the purge),
following `001` design's error and sanitization rules verbatim (expected errors:
`error.type` only, no exception event; unexpected errors: sanitized exception, no
message/SQL).

### Metrics

| Instrument                     | Type, unit            | Attributes | Purpose |
| ------------------------------ | --------------------- | ---------- | ------- |
| `tayzu.identity.org_deletions`        | Counter, `{deletion}`   | `tayzu.identity.org_deletion.outcome` (`requested`\|`completed`\|`failed`\|`cancelled`)                                                                                 | Rare, high-impact operation — always worth a signal (`denied_step_up` dropped: the guard already emits `tayzu.auth.step_up.required`) |

The existing counter `tayzu.identity.principal_rejections` of `043` gains the value
`tenant_pending_deletion` of `tayzu.identity.rejection.reason`; no instrument is added.

**Cardinality budget**: `tayzu.tenant.id` stays under the same <20 bound `001` ADR-0006
already assumes. Every other attribute above is a bounded enum, and the organization's
name, email and tokens are **never** attributes on any signal.

### Log events

| Event name | Severity | Attributes | Purpose |
| ---------- | -------- | ---------- | ------- |
| `catalog.audit.org_deletion_requested`            | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                                                                                                                                                                         | Phase 1 started: access revoked, tenant marked (new)                                                             |
| `catalog.audit.org_deletion_cancelled`            | INFO     | `tayzu.tenant.id`, `tayzu.identity.operator.id`                                                                                                                                                                                                                                                             | The reversal script tombstoned a pending marker; the operator's opaque id is recorded (new)                      |
| `catalog.audit.org_deletion_completed`            | INFO     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.entities_removed`                                                                                                                                                                                                                                           | Durable record that the irreversible purge happened, emitted by the purge before the organization row is deleted |
| `catalog.security.org_deletion_notice_failed`     | WARN     | `tayzu.tenant.id`                                                                                                                                                                                                                                                                                           | The org-deletion notice could not be sent to an administrator; the request itself is not blocked (new)           |
| `catalog.security.org_deletion_failed`            | WARN     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.step` (`catalog`\|`auth`)                                                                                                                                                                                                                                   | A purge step failed; a failed deletion is no longer invisible (new)                                              |
| `catalog.security.org_deletion_repeated` | WARN | `tayzu.tenant.id`, `tayzu.actor.id` | A deletion was requested again while one was pending; the idempotent revocations were re-run (D1, new) |
| `catalog.security.org_deletion_cancel_refused` | WARN | `tayzu.identity.operator.id`, `tayzu.identity.org_deletion.cancel_refusal` (`invalid_tenant`\|`no_pending_marker`\|`purge_begun`\|`purge_date_passed`); conditional: `tayzu.tenant.id` (present when the tenant id passed its shape check, so absent for `invalid_tenant`) | The reversal script refused: a refused attempt to revive a tenant is no longer invisible (D3, new) |

Values added to attributes `043` declares: `tayzu.identity.invitation.reason` gains
`org_deletion` (the cancellation by phase 1), `tayzu.identity.invitation.denial_reason`
gains `tenant_pending_deletion`, and `tayzu.identity.email.template` (seven values after
`044`, so `org_deletion` is the eighth) and `tayzu.identity.notice.template` (today
`admin_accepted` alone) gain `org_deletion`. The new attribute
`tayzu.identity.org_deletion.cancel_refusal` is a closed set of four values, one per
refusal of D3; a run with no operator id fails at the script's configuration load, before
any event, because there is no authenticated operator to name.

Every event above is exempt from sampling and from any downstream filter/drop rule, per
`001`'s existing rule for `catalog.audit.*`/`catalog.security.*` (`001` design, Sampling
exemption) — `010` inherits this constraint unchanged. These names are declared in the
identity contract module by the telemetry task of this change, before the route can be
mounted, because `002` Q42 forbids mounting an operation whose events are not declared.

## Security considerations (SSA SEC01-SEC16 posture)

This is this change's own SEC01-16 walk-through. The findings below were recorded by the
seven VCDM passes over `043` (Mode A, 2026-10-01 and 2026-10-07) and are carried here
with the deletion material; each is also a requirement or scenario in the spec and a
task. This change's own pre-assessment is its task 1.1.

| Gap | Where it is closed |
| --- | --- |
| B5 org deletion impossible as written | D1, D2, spec "Org deletion revokes access immediately and purges tenant data after a window", groups 5 and 6, migrations `0012` to `0014` |
| NB3 purge function and marker integrity (Q26) | D1, spec "The deletion marker and the purge are protected from the request path", migrations `0012` to `0014`, tasks 2.1, 2.2, 2.3, 6.1 |
| NB4 reversal of a pending deletion unaudited (Q27) | D1, D3, D5, spec "Org deletion revokes access immediately and purges tenant data after a window", tasks 5.5, 7.1, 7.2 |
| G1 notice emails outside every cap and the kill switch (Q53), the deletion notice | D5, spec "The deletion notice is fixed and capped", tasks 4.1, 5.5 |
| G7 auth-side purge privileges (Q49) | D1, tasks 2.3, 6.6 |
| G8 maintenance-workflow settings (Q55) | D3, tasks 7.3, 10.6 |
| NB-3 maintenance workflow inputs and OIDC scope (Q64) | D3, spec "The reversal runs only through a reviewed workflow", tasks 7.3, 7.4, 10.6 |
| G6-2 workflow residuals (CODEOWNERS scope, local action, start overrides, one environment, role scope) | D3, tasks 7.3, 7.4, 10.6 |
| G-g purge predicates, Q59 wording, per-user transaction, repeat request | D1, tasks 2.3, 5.3, 6.2 |
| G-h repeated-request log | D1, task 5.4 |
| G6-6 `auth.rate_limit` hashes after a purge | D2 (the completeness test exempts them, with the reason corrected by Q151), task 10.3 (the erasure statement) |
| Q-C pre-purge warning and marker alert (Q68) | Gates |
| G2, G5, G9, G10, G11, G13, G14, the part closed by the deletion tasks of `043` (its old 12.14, 12.6 and 12.8) | tasks 7.1, 5.6, 6.2 |
| Seventh drift-check (A1-A38 of `drift7.md`, a working file of `043` that is not in the archive), the deletion items | Context, D1 to D3, tasks 1.1 |
| Drift-check of 2026-11-16 (16 mechanical items, 3 conflicts) | Context, Resolved decisions Q150 to Q152 |
| VCDM pre-assessment of this change (Mode A, 2026-11-16, no blocking gap): G4 the purge span's tenant, G5 a refused reversal is logged, G6 the DAST exclusion, G7 the posture rows SEC04, SEC05, SEC07, SEC08 and SEC15, G8 the workflow's entry point as an attack surface (G9, the shared notice bucket, was already closed by `043` Q101) | Observability contract, the posture table below, tasks 7.1, 8.2, 9.1, 10.4; its questions are Resolved decisions Q153 to Q157 |

| Section | Applies | Posture |
| ------- | ------- | ------- |
| SEC01 Diagram | Yes | The platform operator, an actor the diagram already draws since `043`, gains the reversal, and there are new arrows: the purge job with its database connection as `tayzu_purge`, the reversal script and the workflow that starts it through OIDC, added to `docs/architecture/system-diagram.md`, in the full diagram and in the zone diagrams (task 10.5). |
| SEC02 Attack surfaces | Yes | One route, `DELETE /v1/organization`, with its actor, authentication (a step-up-verified session) and Cerbos check named in `docs/security/attack-surfaces.md` (task 10.4); it sits behind the mount gate of `043` and answers like an unknown path until mounted. The `workflow_dispatch` entry point of the maintenance workflow is a second surface with its own row (task 10.4). |
| SEC03 Access control | Yes | `organization.delete` is Cerbos-gated to `admin` with the real tenant (D6); the confirmation must equal the host tenant; a fresh step-up is required (D6). Any admin may request org deletion, every admin is notified and reversal is an audited, JIT-gated operator action (D1, Q27). The human attestations, which only the human can make, are deferred to `010`'s full SSA (Resolved decision Q154, as Q17 of `043`). |
| SEC04 Password storage | N/A | No password, hash or credential store is added or changed; the two new database roles have no password in a migration and are provisioned out of band (D1). |
| SEC05 Cryptography | Partial | No new primitive. Two new database connections (`tayzu_purge` and `tayzu_deletion_admin`) use TLS with `sslmode=verify-full` outside the test harness, like `DATABASE_URL` (D2, task 1.3). |
| SEC06 Misuse | Yes | Org deletion is idempotent and reversible during the window; a repeated request re-runs the revocations; a half-purged tenant can never be revived (D1, D3). A password reset during the window does not reopen the tenant (D4, Q152). |
| SEC07 Dependencies | Partial | No npm dependency is added. One third-party GitHub action (the Azure login), pinned by commit SHA and covered by `CODEOWNERS` (D3, task 7.4). |
| SEC08 File upload | N/A | No upload. |
| SEC09/SEC10 Secrets | Yes | The purge job's `tayzu_purge` secret and the reversal role's secret are documented with owner and rotation, each job with its own identity (D2). |
| SEC11 Phishing | Partial | The eighth fixed template carries only the purge date, no link and no free text, and shares the kill switch, the notices' own per-recipient bucket (`043` Q101), the per-tenant notice cap and the 20-recipient limit of `043` (D5, Q53). |
| SEC12 Testing | Yes | Every requirement has a scenario-backed test; the route has a cross-tenant test and a row in the authorization matrix; `cerbos compile` gates the policy. The OpenAPI-driven ZAP scan would hit `organization.delete`, so the route is on an explicit exclusion list with its reason, asserted by the DAST tests (task 8.2), and the scan runs against a sandbox tenant (Gates). |
| SEC13 Deployment | Partial | The purge window, and a scheduled job provisioned with `010` that holds the `tayzu_purge` secret only; a reviewed `workflow_dispatch` workflow (environment reviewers with "prevent self-review", deployment branch limited to `master`, OIDC subject pinned to the environment and an Azure role limited to starting the named jobs, Q55 and Q64; inputs only through `env`, actions pinned by SHA, `CODEOWNERS` on the workflow and the scripts) for the reversal script and `043`'s `_user` backfill and reconcile (Q41), so nothing runs against production from a workstation, except two out-of-band CLIs: the bootstrap CLI, which an operator runs as `002` designed it (Q91), and `044`'s break-glass `recover-admin-mfa`, which stays under just-in-time access (Q155). The second approver is a second human, added before the first deployment (Q153). |
| SEC14 Infra permissions | Yes | Three migrations (Checkpoint 3): `0012` (the marker table), `0013` (the `tayzu_purge` and `tayzu_deletion_admin` roles, the catalog row-level policies and the amended append-only trigger) and `0014` (the Better Auth row-level policies); no `SECURITY DEFINER` function, Q48 and Q49. The request role inserts only three marker columns (a column-level grant), the new roles get `USAGE` on the schemas they need, and the runtime-role assertion covers the marker (and, since `043` Q109, the revocation table). The marker is insert-only for `tayzu_app`, the roles stay separate (`tayzu_app`, `tayzu_auth`, `tayzu_purge`, `tayzu_migrator`, `tayzu_deletion_admin`) and a test proves no role can `SET ROLE tayzu_purge` (D1, Q26, Q48). The resolver rejects a `purged` marker as well as a `pending` one (D4). |
| SEC15 Network and host | Partial | The purge and the reversal are Container Apps Jobs inside the VNET, provisioned by `010`, with no HTTP listener; no new ingress (D2, D3). |
| SEC16 Logging | Yes | Seven new log events in the contract (a refused reversal included), all sampling-exempt, opaque ids and enums only, with `tayzu.actor.id` pinned to the admin (or the operator for a cancellation); no organization name reaches telemetry (D9). |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 045 | Why |
| ----- | ---- | --------- | --- |
| Org deletion recovery              | Described as a 14-day internal backup process, mechanics undocumented  | A pending window (7 to 14 days) during which access is revoked and the tenant can still be reversed, then a job purges | Server PITR cannot restore one tenant; the window is a real, testable mechanism (D1, D2, ADR-0019)                    |

## Risks / Trade-offs

- **A membership added while purge step 2 deletes its user** → step 2 re-checks a leaving
  user's memberships inside the user's own transaction, and rolls back if the user delete
  then removes nothing, but `tayzu_purge` holds no `UPDATE` grant and so cannot lock the
  user row. A membership in another tenant whose insert is still in flight at the instant of
  the user delete would be removed by the user's cascade. Residual, one statement wide; the
  hardening is the per-user advisory lock of `apps/api/src/identity/user-lock.ts` taken by
  the purge and by every path that adds a membership (ticket "Purge and membership
  serialization").

- **A purged user's invitation in another tenant goes with the user** → deleting a user
  cascades, outside row-level security, to every invitation that user sent
  (`invitation_inviter_id_fk ON DELETE CASCADE`, Better Auth's own schema). A user is
  purged only when every membership is in a due tenant, so such an invitation belongs to
  a tenant the user no longer belongs to. Accepted (Resolved decision Q164): it is the
  foreign key's behaviour on any user deletion, and the invitation would point at a user
  who no longer exists. The completeness test of 6.7 sees the cascade.

- [A pending org deletion is reversible only through the operator script (D3,
  Resolved decisions Q21 and Q27), and the purge removes the data for good; backups
  keep it until their own retention expires] → The erasure statement in
  `docs/security/data-retention.md` says so and states 7 days of PostgreSQL backup
  retention (Resolved decision Q156), which `010` sets when the server is provisioned. A compromised
  admin session can still request a deletion, but every admin is notified at once and
  the window is at least 7 days.
- [The deletion marker and the purge role are the most privileged new surface] → The
  marker is insert-only for `tayzu_app` with a database-set `requested_at` and a
  `CHECK` on the window, the purge runs as a dedicated `tayzu_purge` role with its own
  secret under a row-level policy limited to due tenants, the append-only trigger
  admits only that role, and there is no `SECURITY DEFINER` function (D1, Resolved
  decisions Q26 and Q48). The Better Auth rows get due-marker policies too (Q49),
  which means enabling row-level security on tables `002` owns, with a permissive
  policy for `tayzu_auth` (Q59, Q65), and a read-only `SELECT` of the purge role over
  every `auth.member` row so that it can see a user's other memberships (Q65).
  Checkpoint 3 reviews every grant and the trigger amendment. Recorded for `010`.
- [Any admin can request deletion of an organization with an `owner`, and an admin who
  is the only administrator can be disabled (`043`)] → Last-active-admin protection is
  a ticket; Resolved decision Q27 accepts that any `admin` may request deletion,
  mitigated by the notice to every admin and the window.
- [The resolver's marker lookup fails closed (D4): if the release that carries it
  serves traffic before migrations `0012` and `0013` are applied, every principal is
  rejected] → The Migration Plan runs `db:migrate` before the release.
- [The deletion notice consumes the notices' own per-recipient bucket (`notice_recipient`,
  3 per 24 hours, `043` Q101) and the per-tenant notice cap: a notice that exceeds a cap is
  dropped] → Accepted; the request is never blocked, the drop is logged as
  `catalog.security.notice_suppressed`, and the same request has already revoked
  access. The kill switch stops every email, so flipping it also stops the deletion
  notice.
- [An admin of another tenant could once drain a victim admin's bucket with three
  invitations and so suppress their deletion notice] → Closed by `043` Q101 (its task
  6.12b): invitations and notices no longer share a bucket, so only notices, which an
  invitation does not send to its recipient, count against it.
- [`auth.rate_limit` rows persist after a purge. Each holds a count and a timestamp under
  an unsalted SHA-256 of a scope and a tenant id, a user id, an IP or the keyed hash
  (HMAC-SHA256 under `IDENTITY_TOKEN_HMAC_SECRET`, `043` Q93) of an email; the key of a
  tenant-keyed bucket can be recomputed from the tenant id] → Accepted (Resolved decision
  Q151): no personal data is held in clear, the tenant id stays in the marker's tombstone
  anyway, the erasure statement in `docs/security/data-retention.md` says so, the purge
  role gets no grant on the table, and old rows are removed by `044`'s ticket "Prune
  `auth.rate_limit`".
- [A user of a tenant pending deletion can still reset a password (D4, Q152)] → Accepted:
  the reset grants no access to the closed tenant and a test proves it.
- [The maintenance workflow needs a second human as environment reviewer and code owner
  (Q153), and the repository has one owner today] → A first-deployment gate: until that
  person is added the workflow cannot be enabled, so a pending deletion cannot be reversed
  through it and the purge job stays disabled.
- [A Container Apps Job start may accept an execution template that overrides the job's
  command (Q157)] → Confirmed in `010`'s sandbox rehearsal; if it holds it is an accepted
  risk covered by `CODEOWNERS`, the environment approval and the workflow's text tests.
- [The pre-purge warning and the alert on a marker with no matching
  `catalog.audit.org_deletion_requested` event do not exist in this change (Q68)] → A
  first-deployment gate for `010`, which owns alerting; until then a marker inserted by
  a compromised request path would purge silently after its window.
- [The maintenance workflow is only as strong as its GitHub and Azure settings] →
  Inputs reach the job only through `env`, actions are pinned by SHA, `CODEOWNERS`
  covers the workflow and the scripts, and the settings (reviewers, branch, OIDC
  subject, Azure role) are a checklist the human applies (Q55, Q64).
- [Drift between this design and `002`, `043` and `044` as implemented by the time this
  change starts] → Checked in task 1.1 before Checkpoint 1 (the drift-check of 2026-11-16,
  Context), and again at implementation.

## Gates for the first deployment (`010`)

Human-owned. `043`'s gates apply as they stand (the mount switch, the email sender, the
DAST scan, the rate-limit stores, the `002` items it restates); these are this change's
own:

- The purge job is provisioned with its `tayzu_purge` secret, one Container Apps Job per
  maintenance script with its own identity (Q49), the purge window is confirmed and the
  PostgreSQL backup retention is set to 7 days (Q156), and the reversal runbook's JIT
  access and named approver are in place.
- A **second human** is added as a required reviewer of the workflow's GitHub environment
  and as a code owner (Resolved decision Q153). Until then the maintenance workflow cannot
  be enabled; neither a bot account nor self-review replaces that person.
- The maintenance workflow (the reversal script and `043`'s `_user` backfill and
  reconcile, Q41) has its GitHub environment with required reviewers and "prevent
  self-review", its deployment branch limited to `master`, its OIDC federated credential
  pinned to that environment and its Azure role limited to starting the named jobs (the
  settings checklist of Q55 and Q64, applied by the human, with the `CODEOWNERS` owner),
  its Azure Container Apps Jobs provisioned (with `010`), and the first run is rehearsed
  in a sandbox. That rehearsal confirms whether a job start can carry an execution
  template that overrides the job's command, arguments or image (Resolved decision Q157);
  if it can, the human records it as an accepted risk covered by `CODEOWNERS`, the
  environment approval and the workflow's text tests.
- The pre-purge warning (the admins are told 24 to 48 hours before a purge) and the
  alert on a marker with no matching `catalog.audit.org_deletion_requested` event exist
  in `010`'s alerting before the purge job is enabled (Resolved decision Q68): the request
  role can insert a marker, and the purge is irreversible.
- Migrations `0012` to `0014` run with a migration role that holds `CREATEROLE`, because
  `0013` creates the `tayzu_purge` and `tayzu_deletion_admin` roles (`db:migrate` reads
  `DATABASE_URL` and `MIGRATION_DATABASE_URL` is not wired yet, `002`'s first-deployment
  gate), and they run before the release that carries the marker lookup serves traffic.
- The DAST scan of `043`'s gate excludes `DELETE /v1/organization` (a destructive route,
  on the explicit exclusion list of task 8.2) and runs against a sandbox tenant.
- The security-log retention of 12 months that the erasure statement states as a target is
  implemented by `010` (Q156), and the human attestations of the SSA are made in `010`'s
  full SSA (Q154).

## Tickets (non-blocking VCDM items, not built in this change)

| Ticket | Item |
| ------ | ---- |
| Purge and membership serialization | Take the per-user advisory lock of `apps/api/src/identity/user-lock.ts` in purge step 2 and in every path that adds a membership (invitation acceptance, `identity.users.create`), so a membership whose insert is in flight cannot be removed by the cascade of a purged user (Risks; found in task 6.2). |
| Last-active-admin protection for deletion | Any admin can request deletion of an organization with an `owner` (Q27). `043` has the ticket for the rest: two admins can disable each other, and the last admin can be disabled. |
| Retention windows | Accepted, expired and cancelled `invitation` rows keep the invitee's email; a `_user` left at `Invited` after expiry stays; define windows. |
| Cerbos decision logs | `decisionLogsEnabled: true` records the resource id and attributes; `043` sends only opaque ids (D3 there), but the content and retention of those logs need a policy, and the erasure statement names them (SEC16). |
| Custom Azure role for job starts | If `010`'s sandbox rehearsal shows that a job start can override the job's command, arguments or image, a custom role that forbids the override replaces the accepted risk (Q157, SEC14). |
| Prune `auth.rate_limit` | `044`'s ticket: delete rows older than the longest window. It is what removes a purged tenant's bucket rows, which the purge exempts (Q151). |
| Pre-purge warning and marker detection (**promoted to a first-deployment gate by Q68, no longer a ticket**) | The job warns the admins 24 to 48 hours before a purge, and alerts on a marker with no matching `catalog.audit.org_deletion_requested` event, because a compromised request path could insert a marker silently (SEC14). |

## Migration Plan

1. **Three SQL migrations, all Checkpoint 3**, each with its
   `migrations/down/00NN_<tag>.down.sql` (the full tag, as `down/0010_auth_session_sso_sid.down.sql`),
   `meta/00NN_snapshot.json` and `_journal.json` entry, following the repo's pairing of
   a table migration with a hand-written grants migration (0004+0005, 0008+0009), and
   splitting the two grant blocks of the purge so that each approved file stays
   immutable (`packages/db/CLAUDE.md`; Q82). `043` owns `0011`; nothing is renumbered.
   - `0012_tenant_deletion`: the `tenant_deletion_marker` table (with its cancellation
     columns), its `CHECK` constraints, the `DEFAULT` of `requested_at` and `state`
     and the partial unique index (task 2.1).
   - `0013_tenant_deletion_grants`: the `tayzu_purge` and `tayzu_deletion_admin`
     roles (created here, guarded, as `0006` created `tayzu_app`) with their `USAGE`
     on `public`, the column-level `INSERT` grant and the tenant-isolation policy of
     the request role on the marker, `FORCE ROW LEVEL SECURITY`, the policies limited
     to due tenants on the catalog tables (`SELECT` and `DELETE`, each with its own
     policy) and the `SELECT` policy on the marker that lists them, and the amendment
     of the append-only trigger of `0001` (DELETE only for `tayzu_purge`) (task 2.2).
   - `0014_tenant_deletion_auth_grants`: the due-marker policies on the Better Auth
     tables, `USAGE` on `auth` for the purge role, the read-only `SELECT` policy of
     the purge role over every `auth.member` row and the permissive policy for
     `tayzu_auth` (task 2.3). No `SECURITY DEFINER` function (Resolved decisions Q48
     and Q49).
2. ⛔ **Checkpoint 3** also applies to every Cerbos policy file this change adds or
   edits (D6): the new `organization.yaml`, and `admin.yaml`, `member.yaml` (if needed)
   and `role_policies_test.yaml`; each presented with its `cerbos compile` test output,
   separately.
3. Deploy: migrations first (`db:migrate`, before the release that carries the marker
   lookup of D4 serves traffic), then the purge job with its two secrets (provisioned
   with `010`), each script with its telemetry environment names (Q79), and the window
   setting. Nothing is mounted until `043`'s gates are met.
4. The maintenance workflow (`.github/workflows/identity-maintenance.yml`, task 7.3)
   and `.github/CODEOWNERS` are added with no schema change, and the purge job and the
   reversal script join the scripts under `apps/api/scripts/`. From the first run of
   the workflow, `043`'s `_user` backfill and reconcile are started through it instead
   of as operator-started jobs.
5. Rollback: disable the purge job, and set `MOUNT_IDENTITY_ROUTES` off to remove the
   route (`043` D15). The migrations have down scripts, but a purge that already ran
   cannot be undone, and a tenant whose marker is pending stays closed until an
   operator runs the reversal.

## Resolved decisions (carried from `043`, asked and approved in chat, 2026-09-28, 2026-10-01 and 2026-10-07; this change's own, 2026-11-16)

Per `openspec/project.md` §20. The rows Q150 to Q157, at the end of the table, are this
change's own: the questions of its drift-check and VCDM pre-assessment (task 1.1), asked in
chat and answered by the human on 2026-11-16, each with the recommended option; they start
at Q150 because `043`'s own rows run to Q149. The rows before them are the decisions of
`043` that govern deletion, copied **verbatim** by Resolved decision Q103 and prefixed "(carried from 043
QNN)"; they keep `043`'s numbers (an unprefixed `Q<n>` here is such a row, and a
reference to one of `002`'s is written `002 Q<n>`). A mixed row is carried whole,
because the rest of its text is the context of the deletion part. Where a carried row
points at `043` as it was before the split, this is where it landed:

| In a carried row | Is now |
| ---------------- | ------ |
| `043` D9 (org deletion) | D1 to D3 here |
| `043` D13, the pending-deletion check | D4 here |
| `043` D5, the org-deletion notice | D5 here |
| `043` D10, the route and its confirmation | D6 here |
| `043` tasks 12.0, 12.1, 12.1b, 12.1c, 12.1d, 12.2 | tasks 1.3, 2.1, 2.2, 2.3, 2.4, 3.3 |
| `043` tasks 12.3, 12.4, 12.5, 12.5b, 12.6, 12.13 | tasks 5.1, 5.2, 5.3, 5.4, 5.6, 5.5 |
| `043` tasks 12.7 to 12.12, 12.16 | tasks 6.1 to 6.6, 6.7 |
| `043` tasks 12.14, 12.15, 12.14b, 12.14c | tasks 7.1, 7.2, 7.3, 7.4 |

| #   | Question | Decision |
| --- | -------- | -------- |
| Q1  | (carried from 043 Q1) Split point between `002` and `043`                                                                                                                           | This change owns exactly: 4-state user status lifecycle and invitations (+ invitation email, SEC11), service accounts, org API-credentials viewer/management, data retention & deletion policy + org deletion, credential rotation policy UX. Everything else stays with `002`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q6  | (carried from 043 Q6) Step-up for high-risk operations                                                                                                                              | A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q14 | (carried from 043 Q14) (Drift b6, VCDM B5, 2026-10-01) Org deletion                                                                                                                  | Two phases: access is revoked immediately and the tenant is marked pending deletion; after a 7-to-14-day window a job purges in idempotent steps (catalog data, then Better Auth rows). The purge of append-only rows goes through a `SECURITY DEFINER` function owned by `tayzu_migrator` that deletes only for a tenant marked for deletion (a migration, Checkpoint 3). **The `tayzu_migrator` owner is superseded by Q26, and Q48 then removed the function altogether**; the two phases and the window stand.                                                                                                                                                                                         |
| Q21 | (carried from 043 Q21) (Amendment question, 2026-10-01) Org-deletion window and reversal                                                                                             | Default 14 days, configurable between 7 and 14; reversal only by a platform operator clearing the marker through a documented runbook; no in-product cancel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q26 | (carried from 043 Q26) (VCDM re-run NB3 and drift Q-F, 2026-10-01) Purge privilege model | **The function wording is superseded by Q48 and the auth side by Q49** (no `SECURITY DEFINER` function; policies on the catalog and Better Auth rows); the role, the marker and the trigger guarantees stand. A dedicated `tayzu_purge` role with its own pool and secret, used only by the purge job, owns the purge function and has an RLS policy limited to tenants with a due marker. The marker is insert-only for `tayzu_app`, its window enforced by `CHECK` and `requested_at` set by the database. The append-only trigger allows DELETE only for `tayzu_purge`. A separate `SECURITY DEFINER` lister returns due tenants. (Migrations, Checkpoint 3.)                                                                                                                                                                                                                                                    |
| Q27 | (carried from 043 Q27) (VCDM re-run NB4, Q5, 2026-10-01) Deletion authority, notification and reversal                                                                               | Any Cerbos `admin` may request deletion; every org admin gets a fixed-template email; reversal is a script that tombstones the marker and emits `catalog.audit.org_deletion_cancelled` with the operator id, under JIT access (Azure PIM) and a named second approver.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q35 | (carried from 043 Q35) (Amendment Open Question 1, 2026-10-01) Role for the deletion-reversal script                                                                                 | A dedicated `tayzu_deletion_admin` role that may only tombstone a pending marker (update `state` and the cancellation fields), created in migration `0013` (Checkpoint 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q41 | (carried from 043 Q41) (Re-run H4, 2026-10-01) Where the reversal script and the `_user` backfill run | _Extended by Q49 (one Container Apps Job per script), Q55 (the GitHub settings checklist) and Q64 (inputs only through `env`, a fourth checklist item, `CODEOWNERS`, actions pinned by SHA)._ A manual `workflow_dispatch` GitHub Actions workflow with environment-required reviewers starts an Azure Container Apps Job through OIDC, enforcing the second approver and recording the operator identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q47 | (carried from 043 Q47) (Amendment choices confirmed by the human, 2026-10-01) Details settled while applying Q38-Q45 | (1) An acceptance request with no `Origin` header is rejected. (2) The org-deletion confirmation travels in the query (`?confirmation=`), which telemetry already drops. (3) Rotation is also serialized per credential for integrations with no service account. (4) Invitation cancel uses Better Auth's `cancelInvitation` with the admin's forwarded session headers, like `invite` (Q42). |
| Q48 | (carried from 043 Q48) (Drift N1, 2026-10-01) Catalog-side purge ownership | No `SECURITY DEFINER` functions: the purge job logs in as `tayzu_purge` and deletes under per-table RLS policies limited to tenants with a due marker and the amended append-only trigger; listing due tenants is a `SELECT` policy on the marker for `tayzu_purge`. Supersedes Q26's function wording; every other Q26 guarantee stands. |
| Q49 | (carried from 043 Q49) (VCDM G7, 2026-10-01) Auth-side purge privileges | _Refined: the Better Auth side is migration `0014` after the split (Q82)._ _The visibility of a user's other memberships to the purge role is settled by Q65._ A narrow mechanism gated on a due marker for the Better Auth rows, in migration `0014` (Checkpoint 3), and one Container Apps Job per script.|
| Q53 | (carried from 043 Q53) (VCDM G1, 2026-10-01) Notice-email abuse controls | All three templates are under the kill switch and the per-recipient bucket, with a per-tenant notice cap and at most 20 recipients per notice (truncation logged). |
| Q55 | (carried from 043 Q55) (VCDM G8, 2026-10-01) GitHub settings for the maintenance workflow | _Extended by Q64: a fourth checklist item, the federated identity's Azure role limited to starting the named jobs._ Required reviewers with "prevent self-review", deployment branch limited to `master`, OIDC subject pinned to the environment, recorded in a settings checklist the human applies. |
| Q58 | (carried from 043 Q58) (Amendment Open Question 1, 2026-10-01) Per-tenant notice-email cap | 60 per hour per tenant (three full notices of 20 recipients). |
| Q59 | (carried from 043 Q59) (Amendment Open Question 2, 2026-10-01) Scoping Better Auth rows for the purge | _Refined: the Better Auth side is migration `0014` after the split (Q82)._ **Reworded by Q65: `tayzu_auth` keeps a permissive policy (`USING (true)`) on those tables, and the due-tenant restriction applies to the purge role (which also gets a read-only `SELECT` over every `auth.member` row); the first wording, below, would have locked Better Auth out of every other tenant.** RLS on those tables with a permissive policy letting `tayzu_auth` act on rows of tenants with a due marker only, the same shape as Q48 and no functions (migration `0014`, Checkpoint 3).|
| Q64 | (carried from 043 Q64) (VCDM NB-3, 2026-10-01) Maintenance workflow inputs and OIDC scope | Inputs are `choice` or regex-validated and reach the job only through `env`; a test fails on `${{ inputs.* }}`, `github.event.*` or `github.head_ref` inside `run:`; the federated identity's Azure role only starts the named jobs (a fourth item in the Q55 checklist); CODEOWNERS covers the workflow and `apps/api/scripts/**`; actions are pinned by SHA. |
| Q65 | (carried from 043 Q65) (Drift B1, 2026-10-01) Purge visibility of a user's memberships | The purge role gets read-only `SELECT` on every `auth.member` row; its deletes stay limited to tenants with a due marker. Q59 is reworded accordingly: `tayzu_auth` keeps a permissive policy, and the due-tenant restriction applies to the purge role. |
| Q68 | (carried from 043 Q68) (VCDM Q-C, 2026-10-01) Pre-purge warning and orphan-marker alert | A first-deployment gate for `010`, which owns alerting. |
| Q70 | (carried from 043 Q70) (Amendment Open Question 1, 2026-10-01) `onBehalfOf` principal for maintenance scripts | `gh:<numeric GitHub actor id>` with actor type `user`; it fits 002's id pattern, is authenticated by the workflow and changes nothing in 002. |
| Q72 | (carried from 043 Q72) (Amendment, 2026-10-01) CODEOWNERS owner | `@nahuex` (the repository owner) owns the maintenance workflow and `apps/api/scripts/**`. |
| Q79 | (carried from 043 Q79) (Drift B6, 2026-10-01) Telemetry in maintenance scripts | Each script starts telemetry, emits its audit events and flushes before exit; the environment names are documented. |
| Q82 | (carried from 043 Q82) (Sixth-pass Open Question 1, drift B7, 2026-10-07) Approving the two purge-grant blocks | Split into `0013_tenant_deletion_grants` (task 12.1b, catalog side) and `0014_tenant_deletion_auth_grants` (task 12.1c, Better Auth side), each approved separately at Checkpoint 3 and never edited afterwards. Four migrations in total. |
| Q91 | (carried from 043 Q91) (Drift C1, 2026-10-07) The bootstrap CLI in production | Operator-run out of band, as in 002, outside the maintenance workflow; stated in D9. |
| Q103 | (carried from 043 Q103) (Drift C4, 2026-10-07) Change size against the roadmap budget | Org deletion and data retention (the two-phase purge, the deletion marker, the purge and deletion-admin roles, migrations `0012`-`0014`, the reversal and purge jobs and the maintenance workflow) move to a new change, `045-org-deletion-and-data-retention`, which depends on `002` and `043`, gets its own Checkpoint 1 and reviews, and executes after `044` (`002 -> 043 -> 044 -> 045 -> 003`). The decisions about it recorded here (Q14, Q21, Q26-Q27, Q35, Q41, Q48-Q49, Q55, Q59, Q64-Q65, Q68, Q82 and the deletion parts of others) carry over to `045` unchanged. |
| Q150 | (Drift-check conflict C1, 2026-11-16) Identifier families of `auth.verification` that this change did not classify | Follow `044` D18. `mfa-reenrol:<userId>` joins the user predicate of migration `0014` and is deleted before the user in step 2; `invitation-shed:<invitationId>` (from `043`) is deleted with the invitation tokens, before the invitations; `password-reset:<id>` is exempt as 30-minute state. _Rejected:_ `invitation-shed:` exempt as short-lived; deleting all three, with `password-reset:` matched by reading `value`. |
| Q151 | (Drift-check conflict C2, 2026-11-16) `auth.rate_limit` after a purge | The table stays exempt, with the reason and the erasure statement corrected: a row is a count and a timestamp under an unsalted SHA-256 of a tenant id, a user id, an IP or a keyed email hash, with no personal data in clear; `tayzu_purge` gets no new grant; `044`'s ticket "Prune `auth.rate_limit`" is linked. _Rejected:_ the purge deleting the rows by recomputing the keys; relying on the pruning item as the mechanism. |
| Q152 | (Drift-check conflict C3, 2026-11-16) Password reset for a user of a tenant pending deletion | The password-reset routes are left untouched: the account is global, a reset grants no access to the closed tenant, and a user of another tenant keeps recovery. One test case proves that a reset during the window does not reopen the tenant. _Rejected:_ eligibility ignoring pending tenants; phase 1 disabling every `_user`. |
| Q153 | (VCDM pre-assessment, 2026-11-16) Who the second approver is | A second human, added as a reviewer of the workflow's environment and as a code owner before the first deployment; until then the workflow cannot be enabled. _Rejected:_ a bot account for the agent; single-person operation with self-review. |
| Q154 | (VCDM pre-assessment, 2026-11-16) Human attestations of the SSA | Deferred to `010`'s full SSA, as `043` Q17. _Rejected:_ answering now; deferring all but the open-ticket review. |
| Q155 | (VCDM pre-assessment, 2026-11-16) `044`'s `recover-admin-mfa` break-glass CLI and the maintenance workflow | It stays out of band under just-in-time access (Azure PIM). The spec, D3, the SEC13 row and task 7.3 name two out-of-band CLIs (the bootstrap CLI and `recover-admin-mfa`), and the workflow's `choice` input lists neither. _Rejected:_ moving it into the workflow; a ticket to revisit. |
| Q156 | (VCDM pre-assessment, 2026-11-16) Backup and security-log retention in the erasure statement | 7 days of PostgreSQL backup retention, so purged data is gone at most 21 days after the request with the default window, and 12 months of security-log retention as the target `010` implements. _Rejected:_ 14 days; 35 days. |
| Q157 | (VCDM pre-assessment, 2026-11-16) The start-template override of a Container Apps Job | Confirmed in `010`'s sandbox rehearsal and, if it holds, recorded as an accepted risk covered by `CODEOWNERS`, the environment approval and the workflow's text tests; a gate and a ticket. _Rejected:_ a custom Azure role first; accepting now without a rehearsal. |
| Q158 | (Checkpoint 3 of migration `0012`, 2026-11-17) Names of the two purge-step timestamps of `tenant_deletion_marker` | `catalog_purged_at` (step 1, the catalog rows) and `auth_purged_at` (step 2, the Better Auth rows); tasks 2.2, 6.1 and 6.2 use them. The human approved the SQL of `0012` in the same answer. _Rejected:_ `step1_at` and `step2_at`, which say nothing of what was removed. |
| Q159 | (Checkpoint 3 of migration `0012`, 2026-11-17) Where the marker's row-level security lives | In `0013`, as D1 and the Migration Plan say: `0012` creates the table with no row-level security, and `0013` runs `ENABLE` and `FORCE ROW LEVEL SECURITY` and creates the `tenant_isolation` policy `TO tayzu_app` with the grants, so the whole access model of the table is one Checkpoint 3 review. _Rejected:_ the policy in `0012`, as `0008` did. |
| Q160 | (Checkpoint 3 of migration `0012`, 2026-11-17) A primary key on `tenant_deletion_marker` | None. A row is addressed by `tenant_id` with `state = 'pending'`, which the partial unique index makes unique; cancelled and purged rows are tombstones read by tenant. _Rejected:_ a surrogate `uuid` with `DEFAULT gen_random_uuid()`, against the catalog's rule of UUIDv7 ids generated in the application, and outside the column-level `INSERT` grant of 2.2. |
| Q161 | (Checkpoint 3 of migration `0013`, 2026-11-17) The access model of the marker and the purge on the catalog side | The human approved the SQL of `0013` with these choices, none of which the design had fixed: (1) a `SELECT` policy is also checked against the new row of an `UPDATE` with `WHERE` or `RETURNING`, so `purge_due_select` also admits `state = 'purged' AND auth_purged_at = now()` and `deletion_admin_select` also admits `state = 'cancelled' AND cancelled_at = now()`, the row the transaction itself writes (another transaction has another `now()`); (2) the purge therefore writes `auth_purged_at = now()` and `state = 'purged'` in one transaction, only after `catalog_purged_at`, and the reversal writes `cancelled_at = now()` with a non-null `cancelled_by`; (3) both roles are created `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` with no password, and `createrole_self_grant` is cleared during their creation so the creating role keeps an admin-only membership; (4) the catalog tables' purge policies restate the due predicate instead of relying on the marker's visibility; (5) the down script ends with `DROP ROLE`, as `0006`. Validated on PostgreSQL 18.7 (ADR-0024). _Rejected:_ matching `xmin` against the current transaction id, since system columns are not reliable in a `WITH CHECK`. |
| Q162 | (Checkpoint 3 of migration `0014`, 2026-11-17) The Better Auth side of the purge | The human approved the SQL of `0014`: row-level security on the nine tables, a permissive `auth_full_access` policy `TO tayzu_auth` on each (Better Auth unchanged), `USAGE` on `auth` and an explicit `SELECT, DELETE` per table for `tayzu_purge` and nothing else, the organization predicate, the user predicate (at least one membership and none in a tenant that is not due, read through `purge_read_all` on `member`), the session rule (a due active organization or the user predicate), and one disjunct per `auth.verification` family by exact prefix with `password-reset:` exempt. Each table's policies are created before its row-level security is enabled; no `FORCE ROW LEVEL SECURITY` on the `auth` tables, because `tayzu_auth` is unrestricted by design; tables and the marker are schema-qualified. Validated on PostgreSQL 18.7. _Rejected:_ a policy per family on `verification`; `FORCE ROW LEVEL SECURITY` on the `auth` tables. |
| Q163 | (Checkpoint 3 of migration `0014`, 2026-11-17) Order of purge step 2 | The tenant's invitation tokens and shed records, then its invitations, are deleted **before any user**, because a user's deletion cascades to the invitations that user sent and would leave their tokens unjoinable by their policy. D2 and task 6.2 say so. _Rejected:_ keeping the earlier order and accepting orphaned verification rows until they expire. |
| Q164 | (Checkpoint 3 of migration `0014`, 2026-11-17) A purged user's invitation in a tenant that is not due | Accepted and documented in Risks: Better Auth's `invitation_inviter_id_fk ON DELETE CASCADE` removes it, as on any user deletion. _Rejected:_ a ticket to change the foreign key to `SET NULL` (Better Auth's schema is outside this change); excluding such users from the purge, which would leave their account. |
| Q165 | (Checkpoint 3 of the Cerbos policy of task 3.3, 2026-11-17) `has()` guards on `tenantId` in `organization.yaml` | The cross-tenant deny reads `R.attr.tenantId != P.attr.tenantId` unguarded, the form every existing resource policy and the `same_tenant` derived role use; a missing tenant still ends in deny under strict evaluation, which `organization_test.yaml` asserts ("Admin without a tenant attribute fails closed"). D6's general rule of guarding attribute references with `has()` is read as satisfied by that tested fail-closed behaviour for this attribute. The human approved the policy diffs of tasks 3.2 and 3.3. _Rejected:_ the guarded form `!has(R.attr.tenantId) \|\| !has(P.attr.tenantId) \|\| R.attr.tenantId != P.attr.tenantId`, the same decision written differently from the other policies. |
| Q166 | (Implementation, task 5.1, 2026-11-17) When the procedure joins the router's pinned lists | Task 5.1 registers `identity.organization.delete` in the identity router, because groups 1 to 7 exercise it through `createRouterClient`; the tests that pin the router's procedure list (`identity-input.int.test.ts`, `identity-authorization-matrix.http.int.test.ts`, `mount-gate.int.test.ts`, `identity-openapi.test.ts`) and the committed `openapi/identity.openapi.json` therefore move with it in 5.1, with the new procedure's entry and no assertion loosened, so every commit stays green. Group 8 adds its own assertions (8.1-8.7) on top. **Taken by the orchestrator, not asked in chat; the human may overrule it at Checkpoint 2.** _Rejected:_ keeping the pins at fourteen until group 8, which would leave the suite red between 5.1 and 8.3. |
| Q167 | (Implementation, task 5.2, 2026-11-17) The variable of the deletion window | `ORG_DELETION_WINDOW_DAYS` (`Config.orgDeletionWindowDays`), an integer from 7 to 14 with the default 14 of Q21, read like the other integer variables; a value outside the range, zero, negative, fractional or not a number fails startup naming only the variable. It reaches the identity router as `orgDeletionWindowDays` through `createApp` and `createAppFromEnv`; `docs/security/secrets.md` lists it in task 10.6. **Named by the orchestrator (D1 says only "configurable"), told to the human in chat; it may be renamed at Checkpoint 2.** _Rejected:_ a window in hours or a fixed 14 days. |
| Q168 | (Implementation, task 5.3, 2026-11-17) The answer of `identity.organization.delete` and the moment of its audit event | The operation answers `{ purgeAfter }`, the pending marker's purge date in ISO 8601 with an offset, for the first request and for a repeat (the spec's "returns the original date"). The marker is recorded with `ON CONFLICT (tenant_id) WHERE state = 'pending' DO NOTHING` and then read, so two concurrent first requests end with one marker and the same date. `catalog.audit.org_deletion_requested` is emitted right after this call inserts the marker, before the revocations, so a request that fails half-way still leaves its event and a marker never exists without one; a repeat emits none (its event is 5.4's). **Chosen by the orchestrator (D6 names no response body); may be revised at Checkpoint 2.** _Rejected:_ an empty answer; emitting the event after the revocations. |
| Q169 | (Implementation, task 6.4, 2026-11-18) `entities_removed` of `catalog.audit.org_deletion_completed` on a resumed purge | The event reports the entities removed by the run that emits it: a run that resumes after step 1 was recorded in an earlier run reports 0, and the design says so. The full count of step 1 is on the span `identity.organization.purge` of step 1 (`tayzu.identity.org_deletion.step` = `catalog`, `tayzu.identity.org_deletion.entities_removed`). No migration. The human answered in chat on 2026-11-18 with the recommended option. _Rejected:_ a new `catalog_entities_removed` column on the marker (a migration `0015` and a Checkpoint 3); omitting the attribute when unknown. |
| Q170 | (Implementation, task 6.7, 2026-11-18) Where the `sso-reauth-state:` and `sso-reauth-result:` rows of a deleted tenant are removed | `identity.organization.delete` deletes them in the same operation that deletes the tenant's sessions, on the `tayzu_auth` pool, keyed by the tokens of those sessions (`sso-reauth-result:<token>`, and `sso-reauth-state:` rows whose value starts with that token), so a never-consumed `id_token` (personal data) cannot outlive the purge. Step 2 cannot do it: the request already deleted the sessions, so no due session token is left to join. No migration. _Rejected:_ exempting them as short-lived state (an expired, never-consumed row stays in the table indefinitely); a migration `0015` policy for step 2 (nothing left to join to at purge time). |
| Q171 | (Implementation, task 7.1, 2026-11-18) What the reversal role reads, so the script can name its four refusal reasons | Migration `0013` (not yet on master) is amended: `deletion_admin_select` reads every `pending` marker, whatever its purge steps or purge date, plus the tombstone its own transaction writes; it still reads no earlier tombstone and no purged marker. `deletion_admin_tombstone` is unchanged, so the database still refuses to tombstone a marker with a recorded step or a passed purge date. The human approved the amended SQL at Checkpoint 3 on 2026-11-18. _Rejected:_ a new migration `0015` for a migration never deployed; merging `no_pending_marker`, `purge_begun` and `purge_date_passed` into one reason (a spec, design and 9.1 change, and a less useful refusal). |
| Q172 | (Implementation, task 7.1, 2026-11-18; orchestrator choice, open to Checkpoint 2) How the reversal script receives the tenant id | The CLI reads it from `TAYZU_TENANT_ID` (`TENANT_ID_VARIABLE` in `apps/api/scripts/cancel-org-deletion.ts`), the fixed variable name the maintenance workflow passes (7.3, 7.4). It is the script's input, not its configuration: it is not declared in `script-config.ts`, so a malformed or missing id reaches the shape check and is refused and logged as `invalid_tenant` instead of failing at the configuration load. _Rejected:_ a command-line argument (7.4 forbids `--args` overrides on the job start); a `script-config.ts` variable (a malformed id would fail before the logged refusal). |
| Q173 | (Implementation, task 7.3, 2026-11-18; orchestrator choice, open to Checkpoint 2) How `identity-maintenance-workflow.test.ts` reads the workflow rules | (1) "Its only steps are a pinned Azure login and the call that starts the named job" (spec) is read together with 7.4's tenant-id check "in a first step that fails the run": the test requires exactly one `azure/login` step and one `az containerapp job start` call, and allows other `run` steps only if they run no repository code (no checkout, `git` fetch, package manager, `node`, `tsx`). (2) "No `secrets.` value other than the environment's" is read as: `secrets.` references only inside the job that declares the environment, and only the three Azure OIDC identifiers (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`), because environment and repository secrets look the same in the file. (3) `azure/login` is pinned to the v3.1.0 commit `a641126d1b8aa4d1fa005f4f92df94a3a4c4c906` (2026-09-10). Open for Checkpoint 2: `043`'s `backfill-user-blueprint` reads no `TAYZU_OPERATOR_ID` (it writes as the system actor `backfill-user-blueprint`), so the workflow hands it an operator id it ignores. |
| Q174 | (Implementation, task 7.4, 2026-11-18; orchestrator choice, open to Checkpoint 2) How strict the 7.4 workflow rules are | Stricter than the task's wording: the `az containerapp job start` flags are an allowlist (`--name`/`-n`, `--resource-group`/`-g`, `--env-vars`, `--subscription`, `--output`/`-o`, `--only-show-errors`), because flags such as `--yaml`, `--container-name`, `--cpu` or `--registry-*` also shape the execution template; each `--env-vars` value is read from the shell variable of the same name; a non-choice input read anywhere outside an `env` mapping fails; environment names are compared case-insensitively. A tenant-id input counts as validated when a step before the Azure login, with no `if:` or `continue-on-error`, reads its variable, contains the tenant-id pattern and `exit 1`; the workflow checks it only for `cancel-org-deletion`, the one job that passes it to `az`. Open for Checkpoint 2: if `010`'s rehearsal (Q157) shows that `--env-vars` needs `--container-name`, the allowlist and this row change. |
| Q175 | (Implementation, task 9.2, 2026-11-18; orchestrator choice, open to Checkpoint 2) How a refused reversal fails its span | `IdentitySpanHandle` (`@tayzu/auth`) gains `fail(errorType)`, which sets status ERROR and a bounded `error.type` with no exception event, because `withIdentitySpan` only fails a span on a throw and would record the lowercase refusal reasons as `internal`. A refused `identity.organization.cancel_deletion` span carries the refusal reason (`invalid_tenant`, `no_pending_marker`, `purge_begun`, `purge_date_passed`) as `error.type`; it carries `tayzu.tenant.id` only after the shape check. The purge span lets a step's error cross it (`error.type internal`, one sanitized exception) and `purgeTenant` catches it as before. |
| Q176 | (Implementation, task 9.3, 2026-11-18; orchestrator choice, open to Checkpoint 2) Which actor attribute the deletion events carry | The log-event table wins over the prose "in every audit event `tayzu.actor.id` is the admin": `org_deletion_requested` and `org_deletion_repeated` carry `tayzu.actor.id` (the admin who acted); `org_deletion_cancelled` carries `tayzu.identity.operator.id` (the workflow's authenticated operator) and no `tayzu.actor.id`; `org_deletion_completed` and `org_deletion_failed` carry no actor, because the purge acts on no one's request at run time. `identity-events.int.test.ts` requires the declared attributes, rejects the `system` actor type on all five, and allows an actor id only if it is absent or the admin or operator. |
| Q177 | (VCDM Mode A re-run, task 10.9, gap B1, 2026-11-18) A re-run of the maintenance workflow by another person | The workflow refuses it: its first step, before the Azure login, compares `github.triggering_actor` with `github.actor` (both through `env`) and fails the run when they differ, because `github.actor_id`, the operator id, is the actor of the initial run. A re-run by someone else must be dispatched again. _Rejected:_ forbidding re-runs only by procedure until `010`; accepting the misattribution and relying on GitHub's approval log. |
| Q178 | (VCDM Mode A re-run, task 10.9, gap NB-D9, 2026-11-18) The purge and the reversal with telemetry disabled | Both scripts refuse to run with `TAYZU_TELEMETRY_DISABLED=true` or without an OTLP endpoint, like `044`'s `recover-admin-mfa`, before any pool or event, because their audit events are the only durable record of an irreversible purge or a reversal. _Rejected:_ a ticket for `010`; the shared rule of `043`. |
| Q179 | (VCDM Mode A re-run, task 10.9, gap B2 and question 3, 2026-11-18) Administrator bypass and the scope of code-owner review | The GitHub settings checklist in `docs/security/secrets.md` gains a sixth row: administrator bypass off on the `identity-maintenance` environment and no bypass actors on the `master` ruleset or branch protection, so the second approver cannot be skipped by the sole admin account the agent acts with; applying it is a `010` first-deployment gate, owned by the human. Code-owner review stays on every path of `CODEOWNERS`: every pull request touching `.github/**` or `apps/api/scripts/**` waits for the second human (Q153). _Rejected:_ recording the bypass only among `010`'s gates; limiting code-owner review to the workflow and `CODEOWNERS`. |
| Q180 | (Task 10.8, 2026-11-18) The `pnpm audit` advisory GHSA-fc5q-39xc-vjpf (`picomatch` <=4.0.7, high) | Waived through the audited waiver path of `docs/security/dependencies.md` (`pnpm.auditConfig.ignoreGhsas`, a row with justification, owner `@nahuex` and expiry 2027-02-18): no patched release exists, and the only path is `better-auth > vitest > picomatch`, test tooling not loaded at runtime, with no glob built from user input. Not caused by `045`. _Rejected:_ waiting for a patch with a red audit; a separate pull request to `master`. |

## Open Questions

None. The seventh pass's questions were answered in `043` (Q99-Q102), the human approved
the split itself in Q103, and the questions of this change's own drift-check and VCDM
pre-assessment were answered on 2026-11-16 (Q150-Q157).
