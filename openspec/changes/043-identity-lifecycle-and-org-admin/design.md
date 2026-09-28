# Design: 043-identity-lifecycle-and-org-admin

## Context

- This change is authored to the exact split the human approved in chat on
  2026-09-28 (Q1 of the `002`/`043` decision set — see "Resolved decisions"
  below). It depends on `002-auth-and-rbac` for: Better Auth (`organization`,
  `admin`, `api-key`, `two-factor` plugins), Cerbos wiring, the three-tier
  RBAC baseline, the `_user`/`_team` system blueprints with `status` defined
  at least as `Active`/`Disabled`, the machine-token exchange mechanism
  (organization-owned API key → short-lived access token), the first HTTP
  listener, and the `x-tayzu-risk: high` step-up-MFA mechanism.
- **Reconciled against `002`'s actual `design.md` on 2026-09-28.** This
  change was originally drafted in parallel with `002`, before `002`'s own
  `design.md` existed, from the shared research notes
  (`scratchpad/p002/r1-port.md`, `r2-better-auth.md`, `r3-cerbos.md`,
  `r4-data-http.md`, `r5-carryover-security.md`). Now that `002` is final,
  this document has been checked against it directly. The package-layout
  assumption held exactly: `002` D1 confirms `packages/auth`/`@tayzu/auth`,
  `packages/authz`/`@tayzu/authz`, and the `user` Cerbos resource kind, so no
  import-path changes were needed. Four substantive corrections were made as
  part of this reconciliation: the `_user.status` value casing now matches
  `002`'s `Active`/`Disabled` exactly (D2, Goals); the ADRs this change adds
  are renumbered 0017-0020 to avoid colliding with `002`'s own 0013-0016
  (D3, D6, D8, D9, D12); `AUTH_STEP_UP_REQUIRED` is corrected to reuse `002`'s
  existing code (403), not a newly invented 409 (D10); and the service-account
  credential mechanism (D6) is corrected to reuse `002`'s single
  `machine-credential` apiKey config rather than a config `002` never
  actually defines. Task 1.1 remains in `tasks.md` as a final drift-check at
  implementation time, not a first-time discovery step.
- Reused, not redefined: `CatalogContext`/`Principal`/`onBehalfOf`
  (`001` design D3), the catalog operation pipeline
  (`defineCatalogOperation`), the `catalog.audit.*`/`catalog.security.*`
  naming convention and the shared `@tayzu/observability/semconv` attribute
  keys (`001` design, Observability contract; `001` R15).
- Per `docs/references/platform-engineering/README.md:58` (the row naming
  `002-auth-and-rbac`), this change is where "an audit trail for
  authentication" (`CDE` L92, L104-106) and "explicit rules for agent
  principals" (`SPE4` L226,234,442) extend concretely to invitations and
  service accounts — the row was written for `002`'s broader original scope
  before the `002`/`043` split; the parts of it about invitation/credential
  lifecycle land here.
- Per `docs/references/port/roadmap-analysis.md:40-59` (the `002-auth-and-rbac`
  row, written before the split), the capabilities this change actually
  implements are: "User/Team... service accounts, a 4-state invitation
  lifecycle... org API-credentials viewer; data retention/deletion policy and
  org deletion." The rest of that row (Better Auth/Cerbos/RLS bootstrap,
  three-tier RBAC, `$team`/ownership) stays with `002`.

## Goals / Non-Goals

**Goals:**
- Complete the Port-shaped user status model (`Staged`/`Invited`/`Active`/
  `Disabled`) as one canonical field on the `_user` entity, updated by hooks
  reacting to Better Auth events — never reconstructed from raw invitation
  history at read time (per the human's decision Q4, and `r5-carryover-security.md`
  OQ-3 recommendation B).
- Authorize every sensitive operation this change adds (invite, status
  change, service-account creation, credential rotation/revocation, org
  deletion) through Cerbos, never through an `actor.type`/origin check —
  Port's own docs gate these on request *origin* (UI/API), which is exactly
  the kind of actor-type-as-code-path shortcut `project.md` forbids outside
  the two reserved files.
- Keep this change to **zero new database migrations**. Every new field or
  record this change needs already fits inside a mechanism `001`/`002`
  provide (a blueprint-schema property addition, Better Auth's own
  `apikey.metadata`, an in-memory step-up check).
- Ship SEC11-hardened invitation email as this change's first outbound-email
  capability, and data-retention/org-deletion guarantees before any real
  tenant's data volume makes deletion expensive.

**Non-Goals:**
- No SSO/SCIM-provisioned lifecycle (`025`). No "view as a different user"
  (`003`/`014`). No org-wide audit-log **product surface**, its retention or
  export tooling (`015`, `010` own those; this change only emits events for
  them to eventually consume). No multi-org UX (`042`). No per-tenant Cerbos
  scopes (still deferred past `042`, per `project.md` §23 D7).
- No grace-period orchestration for credential rotation (old and new
  credential coexisting for a window) — v1 is an immediate two-credential
  cutover (ADR-0018). No BullMQ-based asynchronous deletion queue — org
  deletion executes synchronously in one operation (no worker infrastructure
  is wired yet at this point in the roadmap).
- No changes to `002`'s Better Auth bootstrap, MFA, DB roles/RLS, Cerbos
  engine wiring, or the three-tier RBAC baseline itself.

## Decisions

### D1. `_user` gains one optional property, added as a data-plane operation
The `_user` system blueprint (owned by `002`) gains `accountKind`
(`"standard"` | `"service"`, default `"standard"`). Adding an optional
property to an existing blueprint is exactly the "compatible" case `001`'s
safe-schema-evolution check (design D7) already proves out — every existing
entity stays valid, no entity needs revalidation work, and it requires no
`ALTER TABLE`, because blueprint schemas live in a `schema jsonb` column. The
operation that adds it runs as the `system` actor, through the ordinary
`blueprints.update` procedure `001`/`002` already expose, not a bespoke
migration.
- *Alternative:* a new `catalog_service_account` table. Rejected: it
  duplicates the `_user` blueprint's own attribution, status and RBAC
  plumbing for no benefit, and reintroduces exactly the "second way to model
  the same resource" problem `001`'s "Workflows are themselves entities"
  precedent (`project.md` §3) already argues against.

### D2. User status is a pure state machine over four values
`packages/auth/src/identity/user-status.ts` (package path per the Context
note's assumption) exports a pure function
`nextStatus(current: UserStatus, event: StatusEvent): UserStatus | CatalogError`,
where `StatusEvent` is `created_staged | created_invited | first_sign_in |
admin_disable | admin_enable`. It is a total function over the 4×5 matrix; any
transition not in the Requirement's allowed set (spec "User status has four
states...") returns `CATALOG_VALIDATION_FAILED`. Keeping this pure and
table-driven (rather than a chain of `if`s scattered across the invitation
and sign-in call sites) means the forward-only rule is enforced in exactly
one place and is exhaustively unit-testable without a database or Better
Auth.
- *Alternative:* let each call site (accept-invitation hook, sign-in hook,
  disable endpoint) independently decide the next status. Rejected: this is
  exactly how Port's own docs ended up needing a whole "forward-only"
  paragraph to describe emergent behavior — Tayzu encodes the invariant once.

### D3. Cerbos, not origin, gates invite/status-change/service-account/credential/org-deletion — ADR-0020
Port's docs state "only users with a UI/API origin can invite users and
change their status" (`r1-port.md` §1.5) — i.e., they gate on *how* the
request arrived, not *who* is making it. Tayzu already committed to the
opposite principle (`project.md` §1: "humans and AI agents execute exactly
the same workflow path... `actor.type` is data and never selects a code
path"). This change instead adds seven Cerbos-checked actions, all gated to
the `admin` role via a role policy (mirroring `r3-cerbos.md` §3.3's pattern):
`user.invite`, `user.updateStatus` (with a derived-role condition that denies
when the resource's identifier equals the principal's own — "a user cannot
disable themselves"), `service_account.create`, `credential.rotate`,
`credential.revoke`, `credential.list`, and `organization.delete`. Reusing
`002`'s existing `user` resource kind for the first two, and adding
`service_account`, `credential`, and `organization` as new, small, fixed
resource kinds (per `002`'s own "static policy / dynamic context" pattern,
`r3-cerbos.md` §3.1) keeps this in the same small, reviewable policy-file set
`002` already establishes. Every rule in every one of these new resource
policies (`service_account.yaml`, `credential.yaml`, `organization.yaml`) and
in `user.yaml`'s new rules imports `002` D7's `same_tenant` derived role,
exactly as `002` already requires of every resource policy — this change
introduces no second tenant-isolation mechanism.
- *Alternative:* keep Port's origin-based rule as a secondary check on top of
  Cerbos. Rejected: it would be the actor/origin-as-code-path pattern
  `project.md` explicitly forbids, for no security benefit Cerbos's
  role-based deny doesn't already give.

### D4. Invitation lifecycle wraps Better Auth's `organization` plugin, synced to `_user.status` by hooks
Better Auth's own invitation record (`pending`/`accepted`/`rejected`/
`canceled`, 48h default `invitationExpiresIn`) is the state of the
*invitation*, distinct from the state of the *user* (`r5-carryover-security.md`
OQ-3). This change wires `afterCreateInvitation` → set `_user.status =
Invited` (creating the `_user` entity first if the email has none yet),
`afterAcceptInvitation` → set `_user.status = Active`, and leaves
`afterRejectInvitation`/`afterCancelInvitation` as no-ops on `_user.status`
(rejecting or cancelling an invitation does not retroactively disable a
user — an admin re-invites, which is already a supported path, or explicitly
disables). `cancelPendingInvitationsOnReInvite: true` is set so re-inviting
the same email is a single call, matching the spec's "Re-inviting cancels the
previous invitation" scenario, instead of Tayzu hand-rolling the cancel step.
`requireEmailVerificationOnInvitation: true` is set explicitly (not left to
Better Auth's default inference) so acceptance always requires the accepting
session's email to match the invited email, per the spec's mismatched-email
scenario — `r2-better-auth.md` §5 flags this as worth setting explicitly
rather than relying on the opaque-ID-implies-optional default.
- *Alternative:* model Tayzu's own invitation record instead of Better Auth's.
  Rejected: duplicates a state machine Better Auth already implements
  correctly (expiry, single-pending-per-email via re-invite cancellation),
  for a resource that is app-owned and tenant-scoped either way.

### D5. Invitation email: an `EmailSender` port, Azure Communication Services adapter
Better Auth's `sendInvitationEmail` callback has no default transport
(`r2-better-auth.md` §5, `r5-carryover-security.md` §4.1) — Tayzu must
implement one. `packages/auth/src/identity/email/sender.ts` defines a small
port, `interface EmailSender { send(to: string, template: InvitationEmail):
Promise<void> }`, so the concrete provider is swappable without touching the
invitation-lifecycle code. `azure-communication-email.ts` implements it over
`@azure/communication-email` (`1.1.0`, verified via `npm view`, 2026-09-28) —
consistent with the Azure-first stack (`project.md` §2, §7) and the existing
Key Vault-backed secrets pattern `002` establishes for the DB credential
(the Communication Services connection string is one more Key Vault secret,
not a new secrets mechanism). The email itself contains exactly one
clickable link (the invitation-accept URL) and states the 48-hour expiry —
no other link, per SEC11 (`r1-port.md` §1.4's invite flow plus
`r5-carryover-security.md` §5 SEC11).
- *Alternative:* a generic SMTP client. Rejected: another credential shape
  (SMTP username/password) to manage in Key Vault for no benefit over a
  managed Azure service already in the stack's cloud.

### D6. Service accounts: `_user` sub-kind + org-owned machine credential, Tayzu's own identifier convention — ADR-0017
A service account is a `_user` entity with `accountKind: "service"`, created
through one orchestrated operation: (1) create the `_user` entity with
`status: Active` (no invitation, per the spec), (2) issue an
organization-owned Better Auth API key by reusing `002`'s existing
`machine-credential` apiKey config directly (`references: "organization"`,
`defaultPrefix: "tayzu_mc_"`, per `002` design D5) — there is no separate
"service-account" config; `002` defines exactly one, and a service account is
functionally an `integration`-kind credential with a bound catalog identity,
consistent with the decision record's Q5 ("integration/agent actors
authenticate with that token" — no third actor kind), (3) return `{ user,
clientId, clientSecret }` once. Port fakes an email at a reserved domain
(`serviceaccounts.getport.io`, `r1-port.md` §1.6) because Port's
`_user.identifier` **is** an email address company-wide; Tayzu has no
equivalent single public domain per tenant, so this change instead gives
service-account identifiers their own pattern,
`^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$` (fits inside `001`'s existing entity
identifier length limit), documented as ADR-0017, rather than manufacturing a
fake email address that would read as a real one to anything downstream. The
credential's `metadata` field records `{ userId, actorKind: "integration" }`
— `actorKind` fixed exactly as `002` D5 already does for any machine
credential, `userId` new. Listing (D7) uses `userId` to join the two. Because
a service account's requests resolve to `actor.type: integration` under
`002`'s frozen context-resolution contract (not `actor.type: user`), this
change additively extends `packages/authz`'s attribute builder: when an
`integration`-actor request's underlying credential carries a bound
`metadata.userId`, the builder also sources `role`/`team`/`moderatedBlueprints`
from that `_user` entity, exactly as it already does for a `user`-type actor.
This is new plumbing 043 adds on top of `002`'s mechanism — it changes
neither `002`'s actor-type enum nor its tenant/context resolution contract.
- *Alternative:* mint a synthetic `@service.tayzu.internal` email, closer to
  Port's literal convention. Rejected: it invites exactly the kind of
  confusion an actual email-shaped string causes (accidental email delivery
  attempts, phishing-adjacent lookalike risk) for no behavioral benefit,
  since Tayzu's `_user.identifier` does not have to be email-shaped the way
  Port's does.

### D7. Org API-credentials viewer is a read model over Better Auth's `apikey` table
Listing is `auth.api.listApiKeys` (or the equivalent org-scoped query)
filtered to `organizationId = tenantId`, joined in the service layer to the
`_user` entity via each key's `metadata.userId` for service-account
credentials (integration-only keys, without a `_user`, show kind
`integration` and no joined user). The prefix (`key.prefix`), `enabled`,
`createdAt`, `lastRequest`, and a computed `rotationDueAt` (D8) are returned;
the hashed `key` column is never selected into the response shape at all, so
"never re-exposes a secret" is a projection guarantee, not a
redaction-after-the-fact one.
- *Alternative:* a denormalized read table Tayzu maintains itself. Rejected:
  Better Auth's `apikey` table is already the source of truth; a second copy
  is a sync-drift risk for a page that only needs to read one org's rows at
  a time (bounded, not a hot path).

### D8. Credential rotation is an immediate two-credential cutover — ADR-0018
Better Auth's `api-key` plugin has no rotate endpoint (`r2-better-auth.md`
§6): rotation is "create a new key, disable the old one," done at the
application layer. This change implements exactly that, atomically (new key
created, old key `enabled: false`, in the same service call), with no grace
period where both are simultaneously valid. A `rotatedAt`/`rotationDueAt`
pair lives in the new key's `metadata` (Better Auth's free-form JSON field);
the viewer (D7) computes "rotation due" by comparing `rotationDueAt` to now,
using a Tayzu-chosen default interval (90 days, configurable per deployment,
recorded in `docs/security/data-retention.md` alongside the other retention
numbers) — this is a documented policy default, not a hard-enforced expiry:
no credential is force-disabled solely for being overdue, since that would
silently break an integration outside the platform's control.
- *Alternative:* a grace-period window (old key stays valid for N hours after
  rotation so in-flight processes can pick up the new one). Rejected for v1:
  real orchestration complexity (a scheduled hard-revoke) for a benefit that
  matters only once a tenant runs unattended automation against a Tayzu
  credential, which is not yet true of any Phase-1 integration. Recorded as a
  Risk below, not built.

### D9. Org deletion: synchronous cascading delete, backup-window as the recovery mechanism — ADR-0019
Deleting an organization runs as one operation: revoke every active session
for the org (Better Auth `admin.revokeUserSessions` per member, or an
org-scoped equivalent), disable every org-owned API key, delete every
`catalog_*` row scoped to `tenant_id = organizationId` (a set of ordinary
tenant-scoped `DELETE`s — `001`'s composite tenant FKs and `ON DELETE
CASCADE`/`RESTRICT` rules already make this safe and ordered), delete Better
Auth's `member`/`invitation`/`apikey` rows for that org, log
`catalog.audit.org_deletion_completed`, then delete the `organization` row
itself (Better Auth's `afterDeleteOrganization` hook is where the log event
fires, so it is guaranteed to run before the row disappears). Recoverability
after that point depends entirely on Azure Database for PostgreSQL Flexible
Server's own backup retention window — documented as **14 days** in
`docs/security/data-retention.md` (matching the number Port itself documents
for the same guarantee, `r1-port.md` §12, chosen here as a reasonable Tayzu
default, not copied because Port requires it), an infrastructure setting
configured when the Azure resource is provisioned, not application code.
- *Alternative:* an application-level soft-delete flag plus a scheduled purge
  job N days later. Rejected: it is a second, app-owned retention mechanism
  duplicating what the database's own backup already provides, and it needs
  worker infrastructure (BullMQ) this point in the roadmap does not yet wire
  up for this purpose. Revisit only if Tayzu ever needs a *shorter* or
  *tenant-configurable* recovery window than the database-wide backup
  policy gives.
- Gated by `x-tayzu-risk: high` and an explicit confirmation (the caller
  supplies the organization's identifier back, not just a boolean), per the
  spec's step-up scenario — reusing `002`'s step-up-MFA mechanism exactly as
  `001` anticipated it would be consumed (`001` design D11: "002 (Cerbos) and
  014... consume that marker").

### D10. API contract
New oRPC procedures, mounted on the router `002` exposes over HTTP:

| Procedure | Route |
|---|---|
| `identity.users.invite` | `POST /v1/users/invitations` |
| `identity.users.cancelInvitation` | `POST /v1/users/invitations/{invitation}/cancel` |
| `identity.users.resendInvitation` | `POST /v1/users/invitations/{invitation}/resend` |
| `identity.users.acceptInvitation` | `POST /v1/users/invitations/{invitation}/accept` |
| `identity.users.setStatus` | `PUT /v1/users/{user}/status` |
| `identity.serviceAccounts.create` | `POST /v1/service-accounts` |
| `identity.credentials.list` | `GET /v1/credentials` |
| `identity.credentials.rotate` | `POST /v1/credentials/{credential}/rotate` |
| `identity.credentials.revoke` | `POST /v1/credentials/{credential}/revoke` |
| `identity.organization.delete` | `DELETE /v1/organization` |

`identity.users.setStatus`, `identity.credentials.rotate`,
`identity.credentials.revoke`, and `identity.organization.delete` carry
`x-tayzu-risk: high` (D9's step-up gate applies to all four, not only org
deletion — disabling a user or revoking a live credential is exactly the
"high-risk functionality" SEC03 asks step-up for, `r5-carryover-security.md`
§5 SEC03 Q5). Error codes and HTTP-status mapping reuse `001` design D11's
table (`CATALOG_VALIDATION_FAILED` → 400, `CATALOG_NOT_FOUND` → 404, etc.);
the step-up gate reuses `002`'s existing `AUTH_STEP_UP_REQUIRED` code (403)
verbatim — it is not new here, and 002 already fixes its status at 403, not
409.

### D11. Testing strategy
Unit tests (the D2 state machine, pure). Integration tests against a real
PostgreSQL 16 and a real Cerbos test container (`002`'s own harness,
reused — `r3-cerbos.md` §7.2), exercising the actual Better Auth instance
(no mocked `organization`/`api-key` plugin — Better Auth's own in-memory or
test-database adapter mode, so invitation expiry and re-invite-cancellation
behavior is verified against the real library, not an assumption about it).
The `EmailSender` port is faked in tests (a recording fake, asserting "one
call, one recipient, one link"), never calling the real Azure Communication
Services API. `cerbos compile` (with its bundled test suites) gates every
new policy file in CI, exactly as `r3-cerbos.md` §6.2/§6.4 establishes for
`002`.

### D12. Docs-as-Code and ADRs from this change
- `docs/adr/0017-service-account-identifier-convention.md` (D6)
- `docs/adr/0018-credential-rotation-immediate-cutover.md` (D8)
- `docs/adr/0019-org-deletion-backup-window-recovery.md` (D9)
- `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md` (D3)

These numbers were reconciled against `002`'s actual `design.md` on
2026-09-28: `002` claims 0013-0016 (its D17), so this change's four ADRs are
0017-0020, with no collision against `002` or the existing `docs/adr/0008`-
`0012` range. This change also writes
`docs/security/data-retention.md` (retention windows per data category: org
deletion's 14-day backup recovery window (D9), credential rotation's 90-day
default cadence (D8); Cerbos and audit-log retention numbers are cross-referenced
from `010`/`015`, not redefined here) and updates
`docs/architecture/system-diagram.md` (new external actor: the email
provider; new arrows: invite → email, credential rotation, org deletion).

## Observability contract

Tracer/meter name `@tayzu/auth` (the package this change and `002` share),
version equal to the package version — a second instrumentation scope
alongside `001`'s `@tayzu/catalog`, per `001`'s own one-scope-per-package
precedent. Shared attribute keys (`tayzu.tenant.id`, `tayzu.actor.type`,
`tayzu.actor.id`) come from `@tayzu/observability/semconv`, unchanged.

### Spans

| Span name | When | Required attributes | Conditional attributes |
|---|---|---|---|
| `identity.invitation.create` | op | `tayzu.identity.invitation.id` | — |
| `identity.invitation.accept` | op | `tayzu.identity.invitation.id` | — |
| `identity.invitation.cancel` | op | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason` (`admin_cancel`\|`re_invite`) | — |
| `identity.invitation.resend` | op | `tayzu.identity.invitation.id` | — |
| `identity.user.set_status` | op | `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to` | — |
| `identity.service_account.create` | op | `tayzu.identity.service_account.id` | — |
| `identity.credential.list` | op | `tayzu.identity.credential.count` | — |
| `identity.credential.rotate` | op | `tayzu.identity.credential.kind` | — |
| `identity.credential.revoke` | op | `tayzu.identity.credential.kind` | — |
| `identity.organization.delete` | op | `tayzu.identity.org_deletion.entities_removed` | — |

All spans are `INTERNAL`, one per operation, following `001` design's error
and sanitization rules verbatim (expected errors: `error.type` only, no
exception event; unexpected errors: sanitized exception, no message/SQL).

### Metrics

| Instrument | Type, unit | Attributes | Purpose |
|---|---|---|---|
| `tayzu.identity.invitations` | Counter, `{invitation}` | `tayzu.tenant.id`, `tayzu.identity.invitation.mutation` (`created`\|`accepted`\|`rejected`\|`cancelled`\|`expired`) | Invitation funnel |
| `tayzu.identity.user_status_changes` | Counter, `{change}` | `tayzu.tenant.id`, `tayzu.identity.user.status.to`, `tayzu.actor.type` | Lifecycle churn |
| `tayzu.identity.service_accounts` | Counter, `{account}` | `tayzu.tenant.id`, `tayzu.identity.service_account.mutation` (`created`\|`disabled`\|`enabled`\|`deleted`) | Service-account volume |
| `tayzu.identity.credential_mutations` | Counter, `{mutation}` | `tayzu.tenant.id`, `tayzu.identity.credential.kind` (`service_account`\|`integration`), `tayzu.identity.credential.mutation` (`created`\|`rotated`\|`revoked`) | Credential hygiene signal |
| `tayzu.identity.org_deletions` | Counter, `{deletion}` | `tayzu.identity.org_deletion.outcome` (`completed`\|`denied_step_up`) | Rare, high-impact operation — always worth a signal |
| `tayzu.identity.step_up_denials` | Counter, `{denial}` | `tayzu.catalog.operation` | Security signal: how often step-up blocks a high-risk op |

**Cardinality budget**: `tayzu.tenant.id` stays under the same <20 bound `001`
ADR-0006 already assumes. Every other attribute above is a bounded enum.
Invited emails, invitation tokens, credential names, and credential secrets
are **never** attributes on any signal — the cardinality guard extends
`001`'s otel-smoke-check to this package's metrics too.

### Log events

| Event name | Severity | Attributes | Purpose |
|---|---|---|---|
| `catalog.audit.invitation_created` | INFO | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id` | Audit |
| `catalog.audit.invitation_accepted` | INFO | same, plus `tayzu.identity.user.id` | Audit |
| `catalog.audit.invitation_cancelled` | INFO | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason` | Audit |
| `catalog.security.invitation_acceptance_denied` | WARN | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.denial_reason` (`expired`\|`cancelled`\|`rejected`\|`already_accepted`\|`email_mismatch`) | Detect misuse of dead/foreign invitations (SEC06/SEC11) |
| `catalog.security.self_status_change_denied` | WARN | `tayzu.tenant.id`, `tayzu.actor.id` | Detect self-service status tampering attempts |
| `catalog.audit.service_account_created` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id` | Audit |
| `catalog.audit.credential_rotated` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id` | Audit — opaque IDs only, never secrets |
| `catalog.security.credential_revoked` | WARN | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id` | Security-relevant, not routine |
| `catalog.audit.org_deletion_completed` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.org_deletion.entities_removed` | Durable record that this irreversible action happened, emitted before the org row is gone |

Every event above is exempt from sampling and from any downstream filter/drop
rule, per `001`'s existing rule for `catalog.audit.*`/`catalog.security.*`
(`001` design, Sampling exemption) — `010` inherits this constraint
unchanged, it does not need to relearn it for this change's new event names.

## Security considerations (SSA SEC01-SEC16 posture)

This is this change's own SEC01-16 walk-through, informed by
`r5-carryover-security.md`'s already-completed mapping for the (then
unsplit) `002`. The formal `vcdm-ssa-validator` pre-assessment (Mode A) is
task 1.2 below, run before this proposal reaches Checkpoint 1, and its
findings — if any — get folded in the same way `001`'s B1-B8/N1-N11 findings
were.

| Section | Applies | Posture |
|---|---|---|
| SEC01 Diagram | Yes | New external actor (email provider) and new arrows (invite→email, rotation, org deletion) added to `docs/architecture/system-diagram.md` (task in group 8). |
| SEC02 Attack surfaces | Yes | Ten new routes (D10), each with its actor, auth mechanism (session or step-up-verified session) and Cerbos check named in the SEC02 table. |
| SEC03 Access control | Yes, core of this change | Every operation Cerbos-gated to `admin` (D3); self-status-change explicitly denied; four operations require step-up (D10); fail-closed on missing grant, same as `001`/`002`. |
| SEC04 Password storage | N/A | No new password store; service-account credentials reuse `002`'s Better Auth `api-key` hashing. |
| SEC05 Crypto | Partial | Invitation tokens are Better Auth's own opaque IDs; credential secrets are hashed by `002`'s mechanism; TLS to Azure Communication Services (managed service, TLS enforced by the provider). |
| SEC06 Misuse | Yes | Expired/cancelled/rejected-invitation acceptance always fails (state-machine test); re-invite cancellation prevents duplicate-pending confusion; org deletion is idempotent against a second call. |
| SEC07 Dependencies | Yes | `@azure/communication-email` added to the existing Dependabot/`pnpm audit`/quarterly-EOL process (`001` R7) — no new gate. |
| SEC08 File upload | N/A | No file upload surface. |
| SEC09/SEC10 Secrets | Yes | Azure Communication Services connection string is a new Key Vault secret, with a documented change procedure in `docs/security/data-retention.md`'s companion secrets note (reusing `002`'s Key Vault seam, not a new mechanism). |
| SEC11 Phishing | Yes, this change's core new exposure | 48h expiry, single link, session-email-must-match-invited-email, re-invite invalidates the old link (D4/D5). |
| SEC12 Testing | Yes | Every requirement has a scenario-backed test; `cerbos compile` gates new policies; existing ZAP baseline (`002`) covers the new routes automatically, no new DAST job needed. |
| SEC13 Deployment | Partial | One new env var (Communication Services connection string via Key Vault reference), no new deploy step. |
| SEC14 Infra permissions | N/A, no change | No new DB roles or grants — this change touches only tables `002` already grants `tayzu_app`/`tayzu_auth` access to. |
| SEC15 Network/host | Partial | One new outbound call (Azure Communication Services) from the app; documented as an egress in the system diagram. |
| SEC16 Logging | Yes | Nine new log events (Observability contract), all sampling-exempt, following `001`'s naming and redaction rules. |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 043 | Why |
|---|---|---|---|
| Invite/status-change authorization | Gated on request *origin* (UI/API) | Gated on Cerbos role (`admin`) | `project.md`'s "actor.type/origin never selects a code path" invariant (D3, ADR-0020) |
| Service-account identifier | Real-looking email at a reserved domain (`serviceaccounts.getport.io`) | `^svc-...` non-email identifier | Tayzu's `_user.identifier` is not required to be email-shaped; avoids a lookalike-phishing surface (D6, ADR-0017) |
| Org deletion recovery window | Described as a 14-day internal backup process, mechanics undocumented | Same 14-day number, explicitly sourced to Azure Database for PostgreSQL Flexible Server's backup retention setting, not an app-level queue | Reuses infrastructure Tayzu already has instead of building a second retention mechanism (D9, ADR-0019) |
| Credential rotation | Undocumented beyond "rotate if exposed" | Explicit immediate two-credential cutover, 90-day documented rotation cadence | Port leaves this as a gap (`r1-port.md` §8.1); Tayzu specifies it fully (D8, ADR-0018) |
| "View as" a different user | Documented, admin-only | Not built in this change | Explicitly later-UI (`003`/`014`), not dropped |
| Support-user audit exemption | *"Support user actions are not logged"* | No such exemption anywhere in Tayzu | Every administrative action, including Tayzu's own operators, is logged uniformly (SEC16) |

## Risks / Trade-offs

- [Credential rotation has no grace period (D8); an integration polling with
  the old credential breaks the instant it's rotated] → Documented in the
  rotation UX copy and `docs/security/data-retention.md`; revisit with a
  scheduled hard-revoke only if a real Phase-1 integration needs it.
- [Org deletion recovery depends on an Azure-level setting (D9) this change's
  code cannot verify at runtime] → The 14-day figure is documented as an
  infrastructure requirement to confirm when the Azure Database for
  PostgreSQL Flexible Server resource is actually provisioned (a later
  deployment change); flagged here so it is not silently assumed true.
- [Drift between this design and `002`'s implementation by the time `043`
  starts implementation] → The package-layout assumption was already checked
  against `002`'s actual `design.md` during OpenSpec planning (2026-09-28,
  see Context) and matched; task 1.1 remains as a final drift-check against
  the merged code, not a first-time discovery step.
- [Sending a real invitation email in integration tests would be flaky and
  slow] → `EmailSender` is faked in every test except a single, explicitly
  optional manual smoke check against a real Communication Services sandbox
  (not part of CI).

## Migration Plan

1. **No SQL migration.** The one schema change (`_user.accountKind`) is a
   blueprint-schema update through the catalog's own `blueprints.update`
   operation, run by the `system` actor once, as an ordinary (non-Checkpoint-3)
   data-plane change — `001` design D7 already proves this class of change
   safe by construction (adding an optional property is always compatible).
2. ⛔ **Checkpoint 3** still applies to every new Cerbos policy file this
   change adds (D3): `user.invite`/`user.updateStatus` extensions, and the
   new `service_account`, `credential`, and `organization` resource-kind
   policies, each presented with its `cerbos compile` test output for
   separate approval.
3. Deploy: no new environment or infrastructure component beyond the Azure
   Communication Services connection string (a Key Vault secret reference,
   following `002`'s existing pattern for the DB credential).
4. Rollback: disabling the new oRPC procedures (feature-flagging them off at
   the router) is sufficient rollback, since there is no schema to reverse.

## Resolved decisions (asked and approved in chat, 2026-09-28)

Per `openspec/project.md` §20, drawn from the shared `002`/`043` decision set
(`scratchpad/p002/decisions.md`) that specifically bears on this change:

| # | Question | Decision |
|---|---|---|
| Q1 | Split point between `002` and `043` | This change owns exactly: 4-state user status lifecycle and invitations (+ invitation email, SEC11), service accounts, org API-credentials viewer/management, data retention & deletion policy + org deletion, credential rotation policy UX. Everything else stays with `002`. |
| Q4 | Canonical user status field | Stored as one field on `_user`, updated by hooks reacting to Better Auth events (`002` defines the field and `Active`/`Disabled` at minimum; this change completes `Staged`/`Invited` and the transition rules). |
| Q5 | Machine credentials | Long-lived client id + secret (revocable, rotatable, hashed) exchanged for a short-lived (1-hour) access token — this change's service accounts and credential viewer/rotation consume that mechanism, they do not redefine it. |
| Q6 | Step-up for high-risk operations | A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10). |

## Open Questions

None. Every genuinely open item from the research notes that would have
changed this change's scope, approach, or task breakdown (the `002`/`043`
split itself, the canonical-status-field decision, the step-up mechanism) was
already asked and answered in the shared decision set before this document
was written. The package-layout assumption (Context) and the credential
rotation grace-period (Risks) are deferred deliberately but do not change
scope, so they are not open questions — they are documented risks with a
stated resolution path.
