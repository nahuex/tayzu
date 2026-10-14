# Proposal: 045-org-deletion-and-data-retention

## Why

`043-identity-lifecycle-and-org-admin` grew to 227 tasks, far past the ~30-80
TDD-task sizing the roadmap targets (`docs/references/port/roadmap-analysis.md:9-12`),
and its seventh drift-check flagged that (item C4). The human decided on
2026-10-07 (Resolved decision Q103 of `043`) to split the org-deletion half
out. It is the most privileged and the most self-contained part of `043`:
nothing else in `043` depends on it, it owns three of `043`'s four migrations
(`0012`-`0014`), two database roles, the only function-free purge mechanism in
the platform and a reviewed maintenance workflow, and it deserves its own
Checkpoint 1 and its own Checkpoint 2 review instead of being buried in a
change that is mostly about invitations, service accounts and credentials.

`045` ships it after `043` and `044`, before `003` builds catalog UI on top
(`002 -> 043 -> 044 -> 045 -> 003`). It depends on `002` (Better Auth, Cerbos,
the database roles and row-level security, the machine-credential revocation
list, the `x-tayzu-risk: high` step-up mechanism) and on `043` (the email
sender and the notice controls, the identity router wrapper, the mount switch,
the identity telemetry contract module, the script helpers and the status
state machine). Every decision about deletion that `043` recorded
(Q14, Q21, Q26-Q27, Q35, Q41, Q48-Q49, Q55, Q59, Q64-Q65, Q68, Q82 and the
deletion parts of others) carries over unchanged; the table in `design.md`
copies each one verbatim.

## What Changes

- **Org deletion, in two phases.** An admin-only, step-up-gated
  `identity.organization.delete` (`DELETE /v1/organization`, the confirmation
  in the query string and equal to the host tenant) that revokes access
  immediately and records a deletion marker, then a scheduled purge after a
  7-to-14-day window (default 14), in two idempotent steps with safe resume
  (catalog data, then Better Auth rows). Phase 1 revokes every session whose
  active organization is the tenant, revokes every org-owned credential through
  the revocation list and cancels pending invitations; a repeated request
  inserts no second marker, sends no second notice, returns the original date
  and re-runs the idempotent revocations.
- **The deletion marker and the purge role.** The marker
  (`tenant_deletion_marker`) is insert-only for the request role, with a
  column-level `INSERT` grant limited to the tenant id, `purge_after` and the
  requesting actor, a `CHECK` on the window and one pending marker per tenant.
  The purge runs as a dedicated `tayzu_purge` role under row-level policies
  limited to due tenants, for the catalog rows and for the Better Auth rows
  alike (it may read every membership, read-only, to know whether a user
  belongs elsewhere), with no `SECURITY DEFINER` function. The append-only
  trigger of `catalog_change_event` admits only that role. A dedicated
  `tayzu_deletion_admin` role can only tombstone a pending marker.
- **Pending deletion closes the tenant.** `resolveContext` and token exchange
  (extended from `043`'s checks) reject every principal, human or machine, of a
  tenant with a pending or purged marker, through the existing 5-second cache,
  failing closed, and an invitation of such a tenant answers the uniform
  acceptance rejection.
- **Deletion notice.** The third fixed template, `OrgDeletionNotice`, joins
  the two of `043` (only the purge date is interpolated, no link, no free text) and goes to the
  administrators of the organization (at most 20) once per request through
  `043`'s notice controls (kill switch, per-recipient bucket, per-tenant notice
  cap, the demo-tenant list).
- **Reversal.** An audited operator script that tombstones the marker (never
  deletes it), refuses a tenant whose purge has begun or whose date has
  passed, and runs as `tayzu_deletion_admin`. It starts only through a
  reviewed manual `workflow_dispatch` workflow (`identity-maintenance`) that
  runs from `master`, requires a second approver, reaches Azure through OIDC
  and derives the operator id from the workflow's authenticated actor. The
  workflow's inputs reach the job only through `env`, its actions are pinned
  by SHA, it has no checkout, and `CODEOWNERS` covers it; its GitHub and Azure
  settings are a checklist the human applies. The same workflow takes over
  starting `043`'s `_user` backfill and reconcile, which `043` runs as
  operator-started jobs in the meantime.
- **Retention policy and erasure statement.** The purge window, what a purge
  does not remove by itself (backups, Cerbos decision logs, Azure Monitor
  data, Azure Communication Services records, `auth.rate_limit` hashes) and
  the reversal runbook, in `docs/security/data-retention.md`, which `043`
  creates for its own operational policies and `045` extends.
- **Security logging.** `catalog.audit.org_deletion_requested`,
  `org_deletion_cancelled` and `org_deletion_completed`, and
  `catalog.security.org_deletion_notice_failed`, `org_deletion_failed` and
  `org_deletion_repeated`, with the `tayzu.identity.org_deletions` counter, the
  purge, reversal and request spans and the new attribute values, in `043`'s
  identity contract module. Each maintenance script starts telemetry and
  flushes it before it exits, through `043`'s helper.
- **Mandatory authorization and the mount gate, reused.** The procedure is
  built with `043`'s `defineIdentityOperation` wrapper, carries
  `x-tayzu-risk: high`, appears in the committed `openapi/identity.openapi.json`
  and is registered only behind `043`'s mount switch. Its cross-tenant test
  and its row in the authorization matrix are tasks here.

Out of scope, staying with `043`: the user status lifecycle, invitations and
their acceptance, the invitation email and the notice controls, service
accounts, the credentials viewer and rotation, disable-takes-effect, the
`_user` reconcile and blueprint backfill, mandatory authorization, the mount
gate, the hand-offs from `002` and the password policy. Also out of scope: an
in-product cancel of a pending deletion (reversal is an operator action),
point-in-time restore of one tenant, a last-active-admin guard (a ticket), the
pre-purge warning and the orphan-marker alert (a first-deployment gate owned
by `010`), and the org-wide audit-log product surface (`015`).

## Capabilities

### New Capabilities

- `org-deletion-and-data-retention`: the two-phase, audited, reversible-during-
  the-window deletion of an organization and the retention policy around it,
  as tenant-scoped, actor-attributed operations reusing `043`'s identity
  pipeline and `002`'s Cerbos, Better Auth and database-role wiring.

### Modified Capabilities

<!-- None. 002-auth-and-rbac and 043-identity-lifecycle-and-org-admin have not
     been archived yet at the time this change is authored, so there is no
     existing `openspec/specs/` capability path to target with a MODIFIED delta.
     045 only ever ADDs. Where it extends a behavior that 043 specifies (the
     resolver checks, the acceptance rejection, the notice templates, the
     telemetry contract, the OpenAPI document), the extension is an ADDED
     requirement of its own; design.md Context says which 043 requirement each
     one extends. -->

## Impact

- **New code**: in `apps/api`, `src/identity/org-deletion.ts` (the request, its
  revocations and the notice), the `identity.organization.delete` procedure in
  the identity router `043` creates, `scripts/purge-job.ts` and
  `scripts/cancel-org-deletion.ts` (and their package scripts), and the
  maintenance workflow `.github/workflows/identity-maintenance.yml` plus a
  `CODEOWNERS` file. It edits `packages/auth/src/identity/email/` (the
  `OrgDeletionNotice` template joins the `EmailTemplate` union),
  `packages/auth/src/context-resolver.ts` and `token-exchange.ts` (the marker
  lookup), `packages/authz/src/resource-kinds.ts` (the `organization` kind),
  `packages/catalog/src/persistence/schema.ts` (the marker table),
  `apps/api/src/bootstrap.ts` (the runtime-role assertion), the identity
  contract module `043` creates, the test harness `packages/db/src/harness.ts`
  and `apps/api/scripts/script-config.ts`.
- **Database**: **three migrations, each a Checkpoint 3 item** (`043` keeps
  `0011`; nothing is renumbered). `0012` adds the tenant-deletion marker table;
  `0013` adds its grants, the dedicated `tayzu_purge` and `tayzu_deletion_admin`
  roles, the row-level policies of the catalog rows and the amended append-only
  trigger (an explicit, narrow exception for the append-only rows); `0014` adds
  the row-level policies of the Better Auth rows. None creates a function.
- **Cerbos**: the new resource kind `organization` with the action `delete`
  (with the explicit cross-tenant deny), and its entries in `admin.yaml`,
  `member.yaml` (if a ceiling must be stated) and `role_policies_test.yaml`.
  ⛔ **Checkpoint 3 applies** to each, separately.
- **Dependencies**: none. The design names no new dependency.
- **Security**: pre-assessed against SSA SEC01-SEC16 by the
  `vcdm-ssa-validator` agent as the first task of this change, before
  Checkpoint 1. The findings that the seven passes over `043` recorded about
  deletion (B5, NB3, NB4, G7, G8, NB-3, G6-2, Q-C and the related ones) are
  carried into `design.md` under "Security considerations". New surface: a
  privileged purge role, row-level security on tables `002` owns, and a
  workflow that holds an OIDC token able to start jobs that run as the purge
  and reversal roles.
- **Docs**: an ADR (`docs/adr/0019-org-deletion-two-phase-purge.md`, the number
  `043` reserved for it), an amendment of
  `docs/adr/0014-postgres-roles-and-forced-rls.md`, the retention and erasure
  sections of `docs/security/data-retention.md`, and updates to
  `secrets.md`, `attack-surfaces.md`, `docs/catalog/auth-and-rbac.md` and
  `docs/architecture/system-diagram.md`.
