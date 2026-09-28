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
  `Disabled`), with the forward-only transition rule (a user never moves back
  from `Active` to `Invited`/`Staged`) and the Staged-vs-Invited origin
  distinction (blueprint-entity creation vs. an explicit invite).
- **Invitations.** Admin-initiated invite by email, backed by Better Auth's
  `organization` plugin invitation record (pending/accepted/rejected/canceled,
  48-hour expiry); an invitation email (new outbound-email capability, SEC11
  hardened: single link, no other clickable links, matching-email-before-accept);
  resend and cancel; a state-machine guard so accepting an expired, cancelled
  or rejected invitation always fails.
- **Service accounts.** A `_user` sub-kind for non-human actors, API-only
  creation (Admin only), `Active` at creation with no invitation email, backed
  by an organization-owned Better Auth API key (the machine-credential
  mechanism `002` builds) whose `clientId`/`clientSecret` are returned exactly
  once. Disabling the service account also disables its credential.
- **Org API-credentials viewer.** A read surface over org-scoped API keys
  (service accounts and integrations) showing name, kind, prefix, created,
  last used, enabled/disabled and rotation-due status — never the secret
  itself after creation.
- **Credential rotation policy UX.** A documented rotation cadence, a rotate
  action (issue a new credential, immediately disable the old one — Better
  Auth has no built-in rotate endpoint), and a rotation-due indicator in the
  viewer.
- **Data retention and org deletion.** A documented retention policy per data
  category (`docs/security/data-retention.md`), and an admin-only,
  step-up-gated org deletion operation that revokes access immediately,
  deletes the tenant's catalog data and Better Auth org/member/invitation/
  API-key rows, and relies on the underlying Azure Database for PostgreSQL
  Flexible Server backup window (not a second application-level staged-delete
  queue) for the recovery period.
- **Observability.** New `catalog.audit.*`/`catalog.security.*` log events and
  `tayzu.identity.*` metrics for every mutation above, exempt from sampling
  like `002`'s own auth events.

Out of scope, staying with `002`: Better Auth bootstrap itself, MFA, DB roles
and RLS, the first HTTP listener, Cerbos engine wiring, the three-tier RBAC
baseline, `$team`/ownership, and the machine-token exchange mechanism itself
(043 only *consumes* it for service accounts). Also out of scope: "view as a
different user" (later-UI, `003`/`014`), SSO/SCIM-provisioned lifecycle
(`025`), the org-wide audit log **product surface** and its retention/export
tooling (`015`, `010` — `043` only emits the events), and multi-org UX
(`042`).

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
     target with a MODIFIED delta. 043 only ever ADDs: an optional property on
     the `_user` system blueprint (safe schema evolution per 001's D7) and new,
     independent operations. See design.md Context for how this coordinates
     with 002's actual shape once it lands. -->

## Impact

- **New code**: extends the identity/auth module `002` introduces (assumed
  `packages/auth`, `@tayzu/auth`, per the `002` research notes — confirmed
  against `002`'s actual `design.md` before task 1.1 starts) with an
  `identity/` subtree (user-status state machine, invitations, service
  accounts, credential viewer/rotation, org deletion, an `EmailSender` port
  and an Azure Communication Services adapter). Adds oRPC procedures to the
  router `002` mounts.
- **Database**: **no new migration.** The `_user` blueprint gains one optional
  property (`accountKind`) through the catalog's existing blueprint-update
  operation (a data-plane change, not DDL, per `001` design D7). Everything
  else reuses tables `002` creates (Better Auth's `organization`, `invitation`,
  `apikey`).
- **Cerbos**: new policy rules for `user.invite`, `user.updateStatus`,
  `service_account.create`, `credential.rotate`, `credential.revoke`, and
  `org.delete`. ⛔ **Checkpoint 3 applies** to every one of these.
- **Dependencies**: `@azure/communication-email` (`1.1.0` as of 2026-09-28,
  verified via `npm view`) for invitation email delivery.
- **Security**: pre-assessed against SSA SEC01-SEC16 by the
  `vcdm-ssa-validator` agent, with SEC11 (phishing) as the section this change
  newly exercises in depth. Findings are folded into `design.md` under
  "Security considerations".
