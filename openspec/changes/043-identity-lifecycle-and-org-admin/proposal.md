# Proposal: 043-identity-lifecycle-and-org-admin

## Why

`002-auth-and-rbac` ships only the load-bearing half of Tayzu's identity
model: the auth/RBAC baseline every later change (`003`, `004`, `005`, `025`,
...) actually depends on. Splitting the rest out was the human's own decision
(2026-09-28, Q1 of the `002`/`043` decision set): a 4-state Port-style user
lifecycle with invitations, service accounts, an org API-credentials viewer,
and a credential rotation policy are real product depth, but nothing in the
roadmap's dependency graph blocks on them the way it blocks on `002`'s RBAC
baseline. Batching all of it into one
change would have pushed `002` past the ~30-80 TDD-task sizing the roadmap
targets (`docs/references/port/roadmap-analysis.md:9-12`) and delayed
Checkpoint 2 on work nothing else needs first. `043` ships this depth
immediately after `002`, before `003` builds catalog UI on top of the
`_user`/`_team` surfaces `002` and `043` together define.

The human split `043` once more on 2026-10-07 (Resolved decision Q103): with 227
tasks it was still far past that budget, and the data-retention and org-deletion
half (the two-phase purge, the deletion marker, the purge and deletion-admin roles,
migrations `0012`-`0014`, the reversal and purge jobs and the maintenance
workflow) is the most self-contained part. It is now
`045-org-deletion-and-data-retention`, which depends on `002` and on this change
and executes after `044` (`002 -> 043 -> 044 -> 045 -> 003`).


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
indistinguishable error responses across every rejection reason. An invitation does
not outlive its inviter's authority: acceptance fails unless the inviter is still an
active, non-banned admin member, and disabling a user cancels the invitations they
created.
- **Invitation acceptance.** Because sign-up is disabled and no email
  verification exists, a person with no account accepts through a new public,
  rate-limited plain Fastify route outside the tenant-context pipeline: a
  single-use token in the link proves mailbox control, the tenant comes from the
  invitation record, and the invitee sets a password under a 20-character policy
  with a breached-password check. A person who already has an account accepts with
  their own session plus the token (CSRF header, its own origin check, matching
  email, step-up for an `admin` role) and only gains the membership. Every other
  admin is notified when an `admin` invitation is accepted. The steps of the acceptance
  are idempotent, the token is consumed last, the `_user` write fails closed and what
  a failed attempt created is undone (there is no single transaction). An SSO link its
  user did not make (every link without a provenance marker) is shed, and the user's
  other sessions are revoked, when the user joins a second tenant, so an invitation
  cannot turn it, or a session issued through it, into a way into the second tenant;
  an admin cannot record such a link on an admin or an owner. This is the first unauthenticated route and needs its
  own SSA row.
- **Invitation email (SEC11-hardened).** A new outbound-email capability with a
  fixed template and subject, exactly one recipient and one link, the link
  origin from a dedicated trusted setting (`INVITATION_LINK_BASE_URL`), and caps per
  tenant (30 per hour), per recipient across tenants (3 per 24 hours, keyed by an HMAC under a server
  secret) and a global kill switch, on the existing DB-backed rate-limit store (a bucket resets only after a
full window with no allowed request, which is stricter than the nominal rate), and
every limiter answers with `Retry-After`. A deployed environment must choose its
email provider explicitly, a real sender under the test environment needs a mandatory
recipient-domain allowlist (honored wherever it is set), CI and DAST use the
non-sending sender, and a list of disabled tenants keeps demo tenants from sending real
mail. A second fixed template tells the other admins of an accepted
  `admin` invitation; the notices share the kill switch and the per-recipient
  bucket, with a per-tenant notice cap and at most 20 recipients per notice (the
  org-deletion notice of `045` joins them), and the invitation caps answer with one
  uniform `Retry-After`.
- **Service accounts.** A `_user` sub-kind for non-human actors, API-only
  creation (admin only, step-up), `Active` at creation with no invitation
  email, backed by an organization-owned machine credential whose
  `clientId`/`clientSecret` are returned exactly once. A service account is
  always `member` with no teams and no moderated blueprints, taken from the
  signed machine claim (never from its `_user`), with an independent Cerbos
  deny rule as a second layer. A service account holds exactly one active credential, and a tenant holds at most
  50 service accounts and 200 credentials. Every service-account route refuses a human
  target with the answer for an unknown id, and a credential records the admin who
  created it.
  Disable is enforced on the request path within seconds and is reversible; delete
  is an explicit operation that revokes every bound credential, and a token whose
  service account is absent or not `Active` is rejected.
- **Org API-credentials viewer.** A read surface over org-scoped API keys
  (service accounts and integrations) showing name, kind, prefix, created,
  last used, enabled/disabled and rotation-due status, never a secret.
- **Credential create, rotate and revoke.** Create and rotate set a per-key
  rate limit explicitly (60 per hour, configurable), and rotation is serialized per
  service account; rotate and revoke both write the revocation list, so
  they take effect within seconds; rotation is an immediate cutover with a
  compensating revoke on failure.
- **Immediate effect of disable.** `resolveContext` and token
  exchange reject a banned user, a human disabled in the active tenant (disabling
  is tenant-scoped, so a member of two tenants can be off-boarded by either; the
  answer is `CATALOG_CONTEXT_REQUIRED`, 401) and a
  machine principal whose service account is `Disabled`, through the existing
  5-second cache, failing closed (`045` adds the principals of a tenant pending
  deletion).
- **Every member has a `_user` row.** A member with no `_user` row is rejected
  (reason `user_missing`), and a repeatable reconcile, run as an operator-started job, creates every missing row through the state machine and removes an orphan
  row that a rolled-back acceptance leaves; it is also the repair path for a member
  that predates this change. A banned user's sign-in fails exactly like any other
  failure, and every identity procedure parses its input strictly.
- **Org deletion and data retention** are not part of this change: the two-phase
  org deletion, the purge, the reversal, the maintenance workflow and the retention
  policy moved to `045-org-deletion-and-data-retention` (Resolved decision Q103).
  This change keeps a minimal mechanism for the maintenance scripts it still needs,
  the `_user` backfill and reconcile: operator-started Container Apps Jobs under
  just-in-time access, which `045`'s reviewed workflow later takes over.
- **Mandatory authorization.** Every procedure of the identity router is built with
  one wrapper that checks the caller's role first, resolves the target, calls Cerbos,
  fails closed and emits `authz_denied`, and a route-table-driven HTTP matrix proves
  each of the thirteen oRPC routes. One repository module in `apps/api` serves every
  identity read of `apikey`, `invitation`, `member`, `session`, `user` and `account`,
  requiring the tenant wherever the model has one, with a lint ban on direct adapter
  access. The machine-credential functions are exported only on a package subpath and
  importable only from the identity code. Their OpenAPI document is committed
  (`openapi/identity.openapi.json`, paths and risk markers only) with its own drift
  check.
- **Tenant binding and mount gate.** Every target of every route is resolved on
  the server and must belong to the caller's tenant; each route has a
  cross-tenant test. The routes are not mounted over HTTP until `002`'s
  hand-offs are done, enforced by a switch that is off by default and a test.
- **Step-up and security logging.** Every high-risk operation carries
  `x-tayzu-risk: high` on its route (tested over HTTP). New
  `catalog.audit.*`/`catalog.security.*` log events and `tayzu.identity.*`
  metrics for every mutation and denial, exempt from sampling like `002`'s own
  auth events; no identifier in a URL path reaches telemetry.
- **Hand-offs from `002` (`002` Q73).** Every item (M5, M9-M15, M17-M20) is a task in
  group 13 or a recorded deferral: composite credential-revocation key, Cerbos in
  front of the machine-credential operations, the SSO-link tenant check, no
  existence oracle, banned-user rejection, temporary-password rules, the
  ownership items, the startup and limiter fixes, and the CI and diagram items
  (`002` Q46, the password, MFA and email-change notifications, is deferred to `044`).
  The existing `create`, `linkSsoAccount` and `unlinkSsoAccount` procedures get
  routes and join the mounted set (fourteen routes in all).

Out of scope, staying with `002`: MFA, DB roles and RLS (beyond the composite key of
migration `0011`), the first HTTP listener, Cerbos engine wiring, the
three-tier RBAC baseline, `$team`/ownership, and the machine-token exchange mechanism
itself. `043` does edit `002`'s Better Auth wiring, the token payload and the resolver
where its decisions need it (see Impact), and adds the resolver checks above. Also out of scope: role or Moderator editing, member removal and
`setActiveOrganization` (deferred, off-boarding is `Disabled`), a last-active-
admin guard, "view as a different user" (later-UI, `003`/`014`), SSO/SCIM-
provisioned lifecycle (`025`), the org-wide audit log **product surface** and
its retention/export tooling (`015`, `010` — `043` only emits the events), and
multi-org UX (`042`), and org deletion with data retention (`045`).


## Capabilities

### New Capabilities

- `identity-lifecycle-and-org-admin`: the full user status lifecycle and
  invitations, service accounts, the org API-credentials viewer, and credential rotation — all as tenant-scoped, actor-attributed
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
  the `auth` repository module, invitations, service accounts, credential viewer and rotation, the `_user` backfill
  and reconcile. Adds oRPC procedures to
  the identity router `002` already has, plus one plain Fastify route (the
  invitation accept), two `tsx` scripts under `apps/api/scripts/` (and the moved
  bootstrap CLI, with `bootstrapAdmin()` moving into `packages/auth/src/`). It also edits
  `packages/catalog/src/service/user-sync.ts` (the four-value status and
  `onBehalfOf`), `packages/catalog/src/service/system-blueprints.ts` and the catalog
  index (which export `USER_BLUEPRINT` with its input builder and
  `ENTITY_IDENTIFIER_PATTERN`), `packages/authz/src/resource-kinds.ts` (two new
  kinds), `packages/auth/package.json` (the `@tayzu/auth/machine-credentials` subpath
  export), a new identity contract module under `packages/auth/src/telemetry/`, the
  shared test fixtures, which gain a `_user` row per member, `scripts/ci/dast.sh` and
  `scripts/ci/zap-seed.ts`, and the stale statements of `packages/authz/CLAUDE.md` and
  `apps/api/CLAUDE.md`. It also edits `002`'s own code where its decisions require it:
  `packages/auth/src/auth.ts` (the `organization` roles, the password configuration, the
  membership, ban, first-sign-in and account hooks, the uniform banned sign-in and
  the transaction-free acceptance support), `context-resolver.ts`, `token-exchange.ts`
  and `pre-auth-rate-limit.ts` (the resolver checks, the `userId` claim and the new
  rate-limit scopes), `session-idle.ts` and the package index (`isIdle`),
  `machine-credentials.ts` (headerless calls), `apps/api/src/server.ts`, `config.ts`,
  `bootstrap.ts`, `identity-router.ts` and `telemetry/` (the merged router, the new
  settings, the `createAppFromEnv` refusal and the route-template paths),
  `eslint.config.js` and a new restriction module, `vitest.shared.ts` and `turbo.json`
  (the breached-password stub), the test harness `packages/db/src/harness.ts`,
  `packages/catalog/src/persistence/schema.ts`, `.github/dependabot.yml`, and ADR-0013.
- **Database**: **one migration, a Checkpoint 3 item.** `0011` adds a
  composite `(tenant_id, credential_id)` key to `machine_credential_revocation`.
  `045` owns `0012`-`0014` (the deletion marker, the purge and deletion-admin
  roles and the row-level policies); nothing is renumbered. The `_user`
  blueprint gains `accountKind` and a four-value `status` through the catalog's
  blueprint-update operation, run once per existing tenant (a data-plane
  change, not DDL, per `001` design D7). Everything else reuses tables `002`
  creates (Better Auth's `organization`, `invitation`, `apikey`,
  `verification`).
- **Cerbos**: new resource kinds `service_account` and `credential`, rules for
  `user.invite`, `user.updateStatus`, `service_account.create`/`delete` and
  `credential.list`/`create`/`rotate`/`revoke` (each new policy with the explicit
  cross-tenant deny), the `user.yaml` deny rules (self-status and the
  service-account ceiling), and the `admin.yaml`, `member.yaml` and
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
  merged `002` (2026-10-01) that found eleven blocking gaps (B1-B11), a second
  pass over the amended change that found five more (NB1-NB5), a third pass that found two more (service-account lifecycle and mandatory
  authorization), a fourth pass that found fourteen non-blocking gaps, and a fifth pass
  that found three blocking ones (a service-account route accepting a human target, an
  invitation outliving its inviter's authority, and the maintenance workflow's inputs and
  cloud role, which moved to `045`), eight non-blocking ones and four questions, and a sixth pass that found
  one blocking one (an SSO link recorded by one tenant's admin surviving into a second
  tenant), fourteen non-blocking ones and three questions, and a seventh pass that found two
  blocking ones (the sessions issued through that link surviving, and the link's
  provenance failing open), ten non-blocking ones and three questions. All are folded into
  `design.md` under "Security considerations", into the spec and into the tasks.
  New surface: the first public route, the first outbound email and the Pwned
  Passwords egress.
- **Docs**: `docs/security/data-retention.md` (new, for the operational policies; `045`
  extends it with the retention policy), and updates to
  `secrets.md`, `attack-surfaces.md`, `crypto-inventory.md`, `dependencies.md`,
  `docs/catalog/auth-and-rbac.md` and `docs/architecture/system-diagram.md`, and
  an amendment of `docs/adr/0013-cerbos-as-sole-authorization-engine.md` (Better Auth's
  `ac` roles are neutralized).
