# Proposal: 043-identity-lifecycle-and-org-admin

## Why

`002-auth-and-rbac` ships only the load-bearing half of Tayzu's identity
model: the auth/RBAC baseline every later change (`003`, `004`, `005`, `025`,
...) actually depends on. Splitting the rest out was the human's own decision
(2026-09-28, Q1 of the `002`/`043` decision set): a 4-state Port-style user
lifecycle with invitations, service accounts, an org API-credentials viewer,
a credential rotation policy, and data-retention/org-deletion guarantees are
real product depth, but nothing in the roadmap's dependency graph blocks on
them the way it blocks on `002`'s RBAC baseline. Batching all of it into one
change would have pushed `002` past the ~30-80 TDD-task sizing the roadmap
targets (`docs/references/port/roadmap-analysis.md:9-12`) and delayed
Checkpoint 2 on work nothing else needs first. `043` ships this depth
immediately after `002`, before `003` builds catalog UI on top of the
`_user`/`_team` surfaces `002` and `043` together define.

## What Changes

- **4-state user status lifecycle.** `002` defines the Port-shaped `status`
  field on the `_user` system blueprint with `Active`/`Disabled` at minimum.
  `043` completes it to the full Port set (`Staged`, `Invited`, `Active`,
  `Disabled`) behind one state machine that **every** status writer goes
  through (hooks, `identity.users.create`, the ban hook, first sign-in), with
  the forward-only rule (a user never moves back from `Active` to
  `Invited`/`Staged`, and a `Disabled` user is never revived by a sign-in or a
  pending invitation).
- **Invitations.** Admin-initiated invite by email for the roles `member` or
  `admin` (never `owner`), backed by Better Auth's `organization` plugin
  invitation record (48-hour expiry); resend and cancel; a state-machine guard
  so accepting an expired, cancelled or rejected invitation always fails, with
  indistinguishable error responses across every rejection reason.
- **Invitation acceptance.** Because sign-up is disabled and no email
  verification exists, a person with no account accepts through a new public,
  rate-limited plain Fastify route outside the tenant-context pipeline: a
  single-use token in the link proves mailbox control, the tenant comes from the
  invitation record, and the invitee sets a password under a 20-character policy
  with a breached-password check. A person who already has an account accepts with
  their own session plus the token (CSRF header, origin check, matching verified
  email, step-up for an `admin` role) and only gains the membership. This is the
  first unauthenticated route and needs its own SSA row.
- **Invitation email (SEC11-hardened).** A new outbound-email capability with a
  fixed template and subject, exactly one recipient and one link, the link
  origin from a dedicated trusted setting (`INVITATION_LINK_BASE_URL`), and caps per
  tenant (30 per hour), per recipient across tenants (3 per 24 hours) and a global
  kill switch, on the existing DB-backed rate-limit store. A second fixed template
  notifies every admin of a pending org deletion.
- **Service accounts.** A `_user` sub-kind for non-human actors, API-only
  creation (admin only, step-up), `Active` at creation with no invitation
  email, backed by an organization-owned machine credential whose
  `clientId`/`clientSecret` are returned exactly once. A service account is
  always `member` with no teams and no moderated blueprints, taken from the
  signed machine claim (never from its `_user`), with an independent Cerbos
  deny rule as a second layer. Disable is enforced on the request path within
  seconds and is reversible; delete is an explicit operation that revokes the
  credential.
- **Org API-credentials viewer.** A read surface over org-scoped API keys
  (service accounts and integrations) showing name, kind, prefix, created,
  last used, enabled/disabled and rotation-due status, never a secret.
- **Credential create, rotate and revoke.** Create and rotate set a per-key
  rate limit explicitly; rotate and revoke both write the revocation list, so
  they take effect within seconds; rotation is an immediate cutover with a
  compensating revoke on failure.
- **Immediate effect of disable and deletion.** `resolveContext` and token
  exchange reject a banned user, a human disabled in the active tenant (disabling
  is tenant-scoped, so a member of two tenants can be off-boarded by either), a
  machine principal whose service account is `Disabled`, and any principal of a
  tenant pending deletion, through the existing 5-second cache, failing closed.
- **Data retention and org deletion, in two phases.** A documented retention
  policy (`docs/security/data-retention.md`) and an admin-only, step-up-gated
  org deletion that revokes access immediately and marks the tenant, then
  purges after a 7-to-14-day window through a scheduled job in two idempotent
  steps (catalog data, then Better Auth rows). The purge runs as a dedicated
  `tayzu_purge` role under a row-level policy limited to due tenants, the marker is
  insert-only for the request role, and the append-only trigger admits only the
  purge role. Every admin is notified, and reversal is an audited operator script
  under just-in-time access. Recovery is the pending window, not point-in-time
  restore.
- **Tenant binding and mount gate.** Every target of every route is resolved on
  the server and must belong to the caller's tenant; each route has a
  cross-tenant test. The routes are not mounted over HTTP until `002`'s
  hand-offs are done, enforced by a switch that is off by default and a test.
- **Step-up and security logging.** Every high-risk operation carries
  `x-tayzu-risk: high` on its route (tested over HTTP). New
  `catalog.audit.*`/`catalog.security.*` log events and `tayzu.identity.*`
  metrics for every mutation and denial, exempt from sampling like `002`'s own
  auth events; no identifier in a URL path reaches telemetry.
- **Hand-offs from `002` (Q73).** Every item (M5, M9-M15, M17-M20) is a task in
  group 14 or a recorded deferral: composite credential-revocation key, Cerbos in
  front of the machine-credential operations, the SSO-link tenant check, no
  existence oracle, banned-user rejection, temporary-password rules, the
  ownership items, the startup and limiter fixes, and the CI and diagram items.
  The existing `create`, `linkSsoAccount` and `unlinkSsoAccount` procedures get
  routes and join the mounted set (fifteen routes in all).

Out of scope, staying with `002`: Better Auth bootstrap itself, MFA, DB roles
and RLS, the first HTTP listener, Cerbos engine wiring, the three-tier RBAC
baseline, `$team`/ownership, and the machine-token exchange mechanism itself
(043 only *consumes* it for service accounts and adds the resolver checks
above). Also out of scope: role or Moderator editing, member removal and
`setActiveOrganization` (deferred, off-boarding is `Disabled`), a last-active-
admin guard, "view as a different user" (later-UI, `003`/`014`), SSO/SCIM-
provisioned lifecycle (`025`), the org-wide audit log **product surface** and
its retention/export tooling (`015`, `010` — `043` only emits the events), and
multi-org UX (`042`).

## Capabilities

### New Capabilities
- `identity-lifecycle-and-org-admin`: the full user status lifecycle and
  invitations, service accounts, the org API-credentials viewer, credential
  rotation, and org deletion — all as tenant-scoped, actor-attributed
  operations reusing `001`'s catalog operation pipeline and `002`'s Cerbos/
  Better Auth wiring.

### Modified Capabilities
<!-- None. 002-auth-and-rbac has not been archived yet at the time this change
     is authored, so there is no existing `openspec/specs/` capability path to
     target with a MODIFIED delta. 043 only ever ADDs: an optional property and a
     widened `status` enum on the `_user` system blueprint (safe schema
     evolution per 001's D7) and new,
     independent operations. See design.md Context for how this was reconciled
     with 002's merged code. -->

## Impact

- **New code**: the pure parts and the structural ports live in an `identity/`
  subtree of `packages/auth` (`@tayzu/auth`: the user-status state machine, the
  invitation token, the password policy, the `EmailSender` port and an Azure
  Communication Services adapter), and the orchestration and the routers live in
  `apps/api` (`@tayzu/auth` has no `@orpc/server` or `@tayzu/catalog` dependency):
  invitations, service accounts, credential viewer and rotation, org deletion, the
  purge job and the reversal script. Adds oRPC procedures to the identity router
  `002` already has, plus one plain Fastify route (the invitation accept).
- **Database**: **three migrations, each a Checkpoint 3 item.** `0011` adds a
  composite `(tenant_id, credential_id)` key to
  `machine_credential_revocation`; `0012` adds the tenant-deletion marker table;
  `0013` adds its grants, the dedicated `tayzu_purge` role, the row-level policies,
  the amended append-only trigger and the hardened purge and lister functions (an
  explicit, narrow exception for the append-only rows). The `_user` blueprint gains
  `accountKind` and a four-value `status` through the catalog's
  blueprint-update operation, run once per existing tenant (a data-plane
  change, not DDL, per `001` design D7). Everything else reuses tables `002`
  creates (Better Auth's `organization`, `invitation`, `apikey`,
  `verification`).
- **Cerbos**: new resource kinds `service_account`, `credential` and
  `organization`, rules for `user.invite`, `user.updateStatus`,
  `service_account.create`/`delete`, `credential.list`/`create`/`rotate`/
  `revoke` and `organization.delete` (each new policy with the explicit
  cross-tenant deny), the `user.yaml` deny rules (self-status
  and the service-account ceiling), and the `admin.yaml`, `member.yaml` and
  `role_policies_test.yaml` ceilings. ⛔ **Checkpoint 3 applies** to every one
  of these, separately.
- **Dependencies**: `@azure/communication-email` (`1.1.0` as of 2026-09-28,
  verified via `npm view`) for invitation email delivery. No other dependency:
  the password denylist is bundled, the token digest uses `node:crypto` and the
  breached-password check is Better Auth's built-in `haveIBeenPwned` plugin (one
  new egress, `api.pwnedpasswords.com`, k-anonymity).
- **Security**: pre-assessed against SSA SEC01-SEC16 by the
  `vcdm-ssa-validator` agent, with SEC11 (phishing) as the section this change
  newly exercises in depth, plus a second, adversarial pass run jointly with
  `002` (`002/ssa-pre-assessment.md`) and a Mode A pre-assessment against the
  merged `002` (2026-10-01) that found eleven blocking gaps (B1-B11), and a second
  pass over the amended change that found five more (NB1-NB5). All are folded into
  `design.md` under "Security considerations", into the spec and into the tasks.
  New surface: the first public route, the first outbound email, a privileged
  purge role and the Pwned Passwords egress.
- **Docs**: `docs/security/data-retention.md` (new), and updates to
  `secrets.md`, `attack-surfaces.md`, `crypto-inventory.md`, `dependencies.md`,
  `docs/catalog/auth-and-rbac.md` and `docs/architecture/system-diagram.md`.
