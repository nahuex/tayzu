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
  `r4-data-http.md`, `r5-carryover-security.md`). The package-layout
  assumption held exactly: `002` D1 confirms `packages/auth`/`@tayzu/auth`,
  `packages/authz`/`@tayzu/authz`, and the `user` Cerbos resource kind. Four
  substantive corrections were made then: the `_user.status` value casing
  matches `002`'s `Active`/`Disabled` exactly; the ADRs this change adds are
  numbered 0017-0020 to avoid colliding with `002`'s own 0013-0016;
  `AUTH_STEP_UP_REQUIRED` reuses `002`'s existing code (403); and the
  service-account credential mechanism reuses `002`'s single
  `machine-credential` apiKey config.
- **Re-reconciled against the merged `002` code on 2026-10-01** (task 1.1,
  drift-check, plus the VCDM Mode A pre-assessment, task 1.2). Mechanical
  drift was fixed in place; every scope or design conflict was asked in chat
  and recorded as Resolved decisions Q8-Q17. The mechanical fixes, so that a
  reader of the older text is not surprised:
  - `nextStatus` returns a package-local error with
    `code = 'CATALOG_VALIDATION_FAILED'`, because `@tayzu/auth` has no
    `@tayzu/catalog` dependency (D2).
  - `_user` is created per tenant, create-only and idempotent, and its
    `status` enum is `['Active','Disabled']`: the change updates
    `USER_BLUEPRINT` for new tenants and runs `blueprints.update` once per
    existing tenant, and it widens the enum (D1).
  - The role property is `portRole`; the identity router passes
    `accountKind`, `portRole`, `moderatedBlueprints` and the **target's real
    tenant** as Cerbos resource attributes, and new rules are `EFFECT_DENY`
    (D3).
  - Credential metadata is `{ actorKind, role: 'member', userId }`, because
    token exchange rejects any credential without `role === 'member'` (D6).
  - Better Auth stores `canceled` and never stores `expired`: the boundary
    maps `canceled` to `cancelled` and derives `expired` from `expiresAt` (D4).
  - `otel-smoke-check` reads the `@tayzu/auth` contract in addition to the
    `@tayzu/authz` one, and the duplicate `step_up_denials` metric is dropped
    (Observability contract).
  - Step-up runs only in the OpenAPI interceptor, keyed on the route spec, so
    every procedure declares `.route({ method, path, spec })` and step-up is
    tested over HTTP only (D10).
  - Rate limits use path-keyed `createRateLimit` preHandlers for the public
    route and service-level buckets for the invitation caps, with the
    defaults in `apps/api/src/config.ts` (D4).
  - `docs/security/secrets.md`, `attack-surfaces.md` and `crypto-inventory.md`
    are the docs this change updates (D12).
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
  `Disabled`) as one canonical field on the `_user` entity, written only
  through one state machine by every writer (hooks, `identity.users.create`,
  the ban hook, the sign-in hook) — never reconstructed from raw invitation
  history at read time (human decisions Q4 and Q11).
- Authorize every sensitive operation this change adds (invite, status
  change, service-account creation and deletion, credential creation,
  rotation and revocation, org deletion) through Cerbos, never through an
  `actor.type`/origin check, and bind every target to the caller's tenant on
  the server (D14).
- Make disable, rotate, revoke and org deletion effective within seconds, not
  at token expiry (D13, Resolved decisions Q13 and Q14).
- Add exactly **two SQL migrations**, each a Checkpoint 3 item: `0011` (a
  composite `(tenant_id, credential_id)` key on the revocation list) and
  `0012` (the tenant-deletion marker and the purge function). The `_user`
  blueprint evolution itself stays a data-plane change.
- Ship SEC11-hardened invitation email as this change's first outbound-email
  capability, and the first public (unauthenticated) route, the invitation
  accept route, with strict limits.
- Keep the whole surface unreachable over HTTP until `002`'s hand-offs are
  done, enforced by a switch and a test (D15).

**Non-Goals:**

- No SSO/SCIM-provisioned lifecycle (`025`). No "view as a different user"
  (`003`/`014`). No org-wide audit-log **product surface**, its retention or
  export tooling (`015`, `010` own those; this change only emits events for
  them to eventually consume). No multi-org UX (`042`). No per-tenant Cerbos
  scopes (still deferred past `042`, per `project.md` §23 D7).
- No role-editing operation: nothing here changes a user's role or
  `moderatedBlueprints` (Resolved decision Q16). The member-management
  procedures `002` D18 anticipated (`updateMemberRole`, `removeMember`,
  `setActiveOrganization`) are **deferred** past this change; off-boarding in
  this change is the `Disabled` status (D13). Recorded as a ticket.
- No grace-period orchestration for credential rotation (old and new
  credential coexisting for a window) — v1 is an immediate cutover (ADR-0018).
  No BullMQ-based deletion queue — the purge is a scheduled job (D9).
- No in-product way to cancel a pending org deletion (see Open Question 4).
- No changes to `002`'s Better Auth bootstrap, MFA, DB roles/RLS, Cerbos
  engine wiring, or the three-tier RBAC baseline itself, beyond the resolver
  checks of D13, the two migrations, and the policy files listed in D3.

## Decisions

### D1. `_user` evolves: a four-value `status` and `accountKind`, per tenant

The `_user` system blueprint (owned by `002`) gains `accountKind`
(`"standard"` | `"service"`, default `"standard"`), and its `status` enum is
widened from `['Active','Disabled']` to the four values `Staged`, `Invited`,
`Active`, `Disabled` (`UserSyncInput.status` is widened with it). Adding an
optional property and widening an enum are the "compatible" cases `001`'s
safe-schema-evolution check (design D7) already proves out, and neither needs
an `ALTER TABLE`, because blueprint schemas live in a `schema jsonb` column.
`_user` is created per tenant and the system blueprint is create-only and
idempotent, so the change has two parts: `USER_BLUEPRINT` carries the new
schema for every **new** tenant (and the bootstrap constant), and a one-off,
idempotent `blueprints.update` run as the `system` actor, once **per existing
tenant**, brings existing tenants forward. Existing `_user` entities stay
valid and read back `accountKind: "standard"`.

- _Alternative:_ a new `catalog_service_account` table. Rejected: it
  duplicates the `_user` blueprint's own attribution, status and RBAC
  plumbing for no benefit, and reintroduces exactly the "second way to model
  the same resource" problem `001`'s "Workflows are themselves entities"
  precedent (`project.md` §3) already argues against.

### D2. User status is a pure state machine; every writer goes through it

`packages/auth/src/identity/user-status.ts` exports a pure function
`nextStatus(current: UserStatus | null, event: StatusEvent): UserStatus`
that throws a package-local `StatusTransitionError` (carrying
`code = 'CATALOG_VALIDATION_FAILED'`, like `AuthContextError`; `@tayzu/auth`
does not depend on `@tayzu/catalog`) for a disallowed pair. `current` is
`null` for an entity that does not exist yet.

`StatusEvent` is `created_staged | created_invited | created_active |
invitation_accepted | first_sign_in | admin_disable | admin_enable`. The
allowed transitions are the whole table; every other `(status, event)` pair
is rejected:

| Event                 | From                           | To         |
| --------------------- | ------------------------------ | ---------- |
| `created_staged`      | none                           | `Staged`   |
| `created_invited`     | none, `Staged`, `Invited`      | `Invited`  |
| `created_active`      | none                           | `Active`   |
| `invitation_accepted` | `Invited`, `Staged`            | `Active`   |
| `first_sign_in`       | `Staged`, `Invited`            | `Active`   |
| `admin_disable`       | `Staged`, `Invited`, `Active`  | `Disabled` |
| `admin_enable`        | `Disabled`                     | `Active`   |

So a `Disabled` user is never revived by a sign-in, by accepting a pending
invitation, or by a hook (multi-stage misuse found by the VCDM pre-assessment,
B4), and `Active` never goes back to `Invited` or `Staged`.

The status writers that exist in `002` bypass any such rule today:
`afterAddMember` writes `Active` (`packages/auth/src/auth.ts`), the ban hook
writes `Active`/`Disabled`, and `identity.users.create` writes `Active`
directly. Per Resolved decision Q11 all of them, and the new sign-in hook for
`first_sign_in`, go through `nextStatus` (via an event: `created_active` for an
admin-created user, `invitation_accepted` for the first membership of an
accepted invitation, `admin_disable`/`admin_enable` for the ban hook).
Admin-created users start `Active`; `Staged` is the default only for an
entity created without a status.

- _Alternative:_ let each call site independently decide the next status.
  Rejected: this is exactly how Port's own docs ended up needing a whole
  "forward-only" paragraph to describe emergent behavior — Tayzu encodes the
  invariant once.

### D3. Cerbos, not origin, gates every operation here — ADR-0020

Port's docs state "only users with a UI/API origin can invite users and
change their status" (`r1-port.md` §1.5) — i.e., they gate on _how_ the
request arrived, not _who_ is making it. Tayzu already committed to the
opposite principle (`project.md` §1: `actor.type` is data and never selects a
code path). This change adds these Cerbos-checked actions, all gated to the
`admin` role:

| Resource kind     | Actions                                                       |
| ----------------- | ------------------------------------------------------------- |
| `user` (existing) | `invite` (also covers cancel and resend), `updateStatus`      |
| `service_account` | `create`, `delete`                                            |
| `credential`      | `list`, `create`, `rotate`, `revoke`                          |
| `organization`    | `delete`                                                      |

Policy-file mechanics, as `002` actually has them:

- `RESOURCE_KINDS` in `packages/authz/src/resource-kinds.ts` gains
  `service_account`, `credential` and `organization`.
- `policies/role_policies/admin.yaml` lists kinds one by one (no wildcard) and
  is a ceiling, so it gains the three kinds, and
  `role_policies_test.yaml` (and `member.yaml` if a ceiling must be stated)
  is edited with it. Without that edit the admin is denied fail-closed and
  the feature is dead on arrival.
- `policies/resource_policies/user.yaml` already allows `*` to admin, so
  `invite` and `updateStatus` need no new allow. The new content on `user` is
  **only two `EFFECT_DENY` rules**: a self-deny (`updateStatus` when
  `R.id == P.id`, using `002`'s `R`/`P` shorthand), and the service-account
  ceiling below. Deny rules, not allow-narrowing, because an allow cannot
  override `*`.
- Every new rule imports `002` D7's `same_tenant` derived role. That role is
  vacuous for catalog operations (`002`'s Known residual risks): it protects
  only if the caller passes the **target's real tenant** as the resource
  tenant. The identity router therefore resolves the target on the server
  (D14) and passes its real tenant (an invitation's `organizationId`, an API
  key's `referenceId`, the user's membership), together with `accountKind`,
  `portRole` and `moderatedBlueprints` as resource attributes (`002`'s router
  passes only `tenantId` today). This is the attribute contract.
- **Service-account ceiling** (Resolved decisions Q7, Q16): a rule on `user`
  denies any action when `R.attr.accountKind == "service"` and
  (`R.attr.portRole != "member"` or `R.attr.moderatedBlueprints` is
  non-empty), where the attributes are the **resulting** values. It is a
  defensive layer independent of the input validation in
  `identity.serviceAccounts.create` (D6): no operation in this change edits a
  role or `moderatedBlueprints`, so the rule is proven at the policy level
  (`user_test.yaml`) and by a `system`-actor test, not by a new operation.

- _Alternative:_ keep Port's origin-based rule as a secondary check on top of
  Cerbos. Rejected: it would be the actor/origin-as-code-path pattern
  `project.md` explicitly forbids, for no security benefit Cerbos's
  role-based deny doesn't already give.

### D4. Invitation lifecycle, public acceptance, roles and caps

Better Auth's `organization` plugin provides the invitation record
(`pending`/`accepted`/`rejected`/`canceled`, 48h `invitationExpiresIn`). It is
the state of the _invitation_, distinct from the state of the _user_. At the
boundary Tayzu maps `canceled` to `cancelled` and **derives** `expired` from
`expiresAt` (Better Auth never stores it; the schema default is `pending`).
`cancelPendingInvitationsOnReInvite: true` makes re-inviting a single call.

**Roles (Resolved decision Q9).** `identity.users.invite` accepts only the
organization roles `member` or `admin`, never `owner` (Better Auth's
`inviteMember` accepts any role and `afterAddMember` maps owner/admin to the
Cerbos `admin` role, so an unconstrained role is a privilege escalation).
Anything else is `CATALOG_VALIDATION_FAILED`. The role is an attribute of
`catalog.audit.invitation_created`. An `admin` invitation requires step-up
(D10, Open Question 2 decides the granularity).

**Hooks.** `afterCreateInvitation` → `_user.status = Invited` through
`created_invited` (creating the `_user` entity first if the email has none yet;
an existing `Disabled` user cannot be invited). `afterAcceptInvitation` is
**not** used for status: acceptance is the in-process flow below, and it
writes through `invitation_accepted`. Rejecting or cancelling an invitation
does not touch `_user.status`.

**Acceptance (Resolved decision Q8).** Sign-up is disabled (`002` Q16), no
email-verification flow exists, `resolveContext` rejects any session without
an active organization the user is a member of, and Better Auth's native
`/organization/accept-invitation` is off `002`'s D18 allowlist and stays off.
An invitee therefore cannot use any `/v1/*` route, so acceptance is a
dedicated **public, rate-limited route outside the tenant-context pipeline**,
`POST /v1/auth/invitations/accept`, shaped like `002`'s token-exchange route
(path-keyed `createRateLimit` preHandler, no session, no tenant context). Its
body carries the invitation id, the token and the new password; **nothing
identifying travels in the path or query**.

1. _Token._ Issued at invite/resend: 256 bits from a CSPRNG, shown only in the
   email link. Only `sha256(token)` is stored, in the `auth.verification`
   table `002` already reuses for `jti` replay state (identifier
   `invitation-accept:<invitationId>`, `expiresAt` equal to the invitation's),
   so there is no new table. It is compared in constant time
   (`timingSafeEqual` over equal-length digests) and consumed with one atomic
   delete-and-return, so it works exactly once. Resend therefore issues a
   **new** token (the old one stops working) with the **same** expiry: the
   plaintext is not stored, so the same link cannot be re-sent.
2. _Tenant._ Derived on the server from the invitation record's
   `organizationId`. The body has no tenant field and a body that carries
   one is rejected. The route never reads `tenantId` or `actor` from input.
3. _Account._ For an invited email with no Better Auth user, the flow creates
   the user (global role `user`, never an admin role), sets the password the
   invitee supplied under the password policy (Q22), marks the
   email verified (the token is proof of mailbox control, so no
   email-verification flow is needed), adds the membership with the invited
   role, writes `_user.status` through `invitation_accepted`, and **creates no
   session**; the invitee then signs in through the normal route, and MFA
   enrollment follows `002` Q43. The acceptance **never links** an account by
   the email claim from Visma Connect (`002` D24, Q18): linking stays
   `sub`-keyed through `/link-social`, with step-up. Acceptance **never sets or
   changes the password of an account that already exists** (an account takeover
   vector); what happens instead for an existing account is Open Question 1.
   An invitee who will only ever use Visma Connect is unsupported until `025`
   (`002` Q72): they need a local password first (Risks).
4. _Errors._ Every rejected acceptance (nonexistent invitation, wrong state —
   expired, cancelled, rejected, already accepted — wrong token, or a
   `Disabled` user) returns the same status, error code (`CATALOG_NOT_FOUND`)
   and body shape. A missing invitation still runs a dummy digest comparison so
   timing does not separate it from a wrong token. The reason is only in the
   `catalog.security.invitation_acceptance_denied` event. A password that fails
   the policy is reported only after the token has verified, so it reveals
   nothing to a caller who does not hold a valid token.

**Invitation email caps (Resolved decision Q15).** `identity.users.invite` and
`identity.users.resendInvitation` share: **30 per hour per tenant**, **3 per 24
hours per recipient across all tenants** (keyed by the sha256 of the
normalized email, never the address), and a **global kill switch**
(`INVITATION_EMAIL_KILL_SWITCH`, an environment variable). Exceeding any of them
fails with `AUTH_RATE_LIMITED` (429), sends nothing, and emits
`catalog.security.invitation_rate_limited` with a bounded `limit_scope`
(`tenant`|`recipient`|`global`). The buckets are service-level counters on a
store interface (the key needs the resolved tenant and the body's recipient,
which a path-keyed preHandler does not have); the public accept route uses a
path-keyed `createRateLimit` preHandler keyed on the parsed pathname, like
token exchange. Defaults are enabled in code, live in
`apps/api/src/config.ts`, and a disabled or zero value fails startup (`002`
Q39). The store is in memory in tests; **a shared store is a first-deployment
gate** (Risks), because a per-replica bucket does not enforce a per-recipient
cap.

- _Alternative:_ model Tayzu's own invitation record instead of Better Auth's.
  Rejected: duplicates a state machine Better Auth already implements
  correctly (expiry, single-pending-per-email via re-invite cancellation).
- _Alternative:_ allowlist the native accept route (reopens the gap D18 closed),
  or only accept for users who already have an account (makes invitations
  nearly useless). Rejected by Resolved decision Q8.

### D5. Invitation email: an `EmailSender` port, Azure Communication Services adapter

Better Auth's `sendInvitationEmail` callback has no default transport — Tayzu
must implement one. `packages/auth/src/identity/email/sender.ts` defines a
small port, `interface EmailSender { send(to: string, template:
InvitationEmail): Promise<void> }`, so the concrete provider is swappable.
`azure-communication-email.ts` implements it over `@azure/communication-email`
(`1.1.0`, verified via `npm view`, 2026-09-28), consistent with the Azure-first
stack and the Key Vault-backed secrets pattern `002` establishes (the
connection string is one more Key Vault secret). The email's content is a
fixed contract (VCDM B9, SEC11):

- **Exactly one recipient**: the port takes one address, validated to be a
  single plain address (no CR/LF, no display name, no list separators, at most
  254 characters), and has no CC, BCC or attachment field, so none can be set.
- **Fixed subject and fixed template.** Only two values are interpolated: the
  link and the 48-hour expiry text. The organization name, the inviter's name
  and any other tenant or inviter free text are **never** interpolated, so
  they cannot carry a phishing message or markup.
- **Link origin from trusted configuration** (`BETTER_AUTH_URL`), never from
  the request `Host` or any forwarded header. The link carries the invitation
  id and token in the URL fragment, so neither reaches a server log or an
  access log.
- Exactly one clickable link.
- A real provider is required outside test: startup fails in production
  without one, and CI and DAST wire a non-sending `EmailSender`.

- _Alternative:_ a generic SMTP client. Rejected: another credential shape
  (SMTP username/password) to manage in Key Vault for no benefit over a
  managed Azure service already in the stack's cloud. A managed identity for
  the provider instead of a connection string is a ticket (Risks).

### D6. Service accounts: `_user` sub-kind + org-owned machine credential — ADR-0017

A service account is a `_user` entity with `accountKind: "service"`, created
through one orchestrated operation: (1) create the `_user` entity with
`status: Active` (no invitation), role `member` and an empty
`moderatedBlueprints`, written as the `system` actor with `onBehalfOf` set to
the admin (Resolved decision Q10); (2) issue an organization-owned Better Auth
API key by reusing `002`'s single `machine-credential` apiKey config
(`references: "organization"`, `defaultPrefix: "tayzu_mc_"`), with metadata
`{ actorKind: 'integration', role: 'member', userId }` — `role` stays
`member` because token exchange rejects any credential without it, and
`userId` is the `_user` entity's opaque id; (3) return `{ user, clientId,
clientSecret }` once. Service-account identifiers follow
`^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$` (not an email-shaped string), ADR-0017.

**The principal of a service account is never read from its `_user`
(Resolved decision Q12).** `002` Q28 fixes every machine principal as
`{ roles: ['member'], teams: [], moderatedBlueprints: [] }`, built from the
signed token claim, and `002` treats that context contract as frozen. A
service account has no Better Auth user or member row, and `CLAUDE.md` bans
`actor.type` branches outside three files, so this change adds **no**
entity-sourced role, team or Moderator plumbing to `packages/authz`. `userId`
is added to the token only as an attribution claim (who the credential is
bound to), never as a source of authority. A tampered `_user` row therefore
cannot raise a service account above `member`.

**Ceiling (Resolved decisions Q7, Q16).** A service account holds `member`
and an empty `moderatedBlueprints`, always: `002`'s step-up gate exempts
`agent`/`integration`/`system` actors by design, so an elevated role bound to
a leaked secret would carry that power forever with no MFA layer. It is
enforced at creation (input validation rejects anything else before the
`_user` or the credential exists) and independently by the Cerbos rule in D3;
there is no operation that edits a role, so no update path exists to guard.

**Operations.** Disable and re-enable are `identity.users.setStatus` on the
service account's `_user` identifier (D9, D13); a service account has no Better
Auth user, so `setStatus` writes only `_user.status` and the resolver check of
D13 enforces it. Deletion is `identity.serviceAccounts.delete`: a plain
`entities.delete` on `_user` is denied by the reserved-prefix rule, so an
explicit operation revokes the credential (revocation list, permanent) and then
removes the `_user` entity as `system` with `onBehalfOf` the admin.

- _Alternative:_ mint a synthetic `@service.tayzu.internal` email. Rejected: it
  invites accidental email delivery attempts and lookalike-phishing risk for no
  behavioral benefit.
- _Alternative considered (Q4 option 2):_ allow admin-role service accounts
  with a secondary approval/friction mechanism. Rejected: a new control to
  design and build for a capability nothing in the roadmap asks for.
- _Alternative considered (Q4 option 3/4):_ accept the design as-is, or
  document a residual risk. Rejected: the fix is cheap relative to the blast
  radius; a service account needs least privilege at the role layer, since it
  cannot have MFA.
- _Alternative:_ read `teams` (or role) from the `_user` entity through a new
  claim. Rejected by Resolved decision Q12: it changes `002`'s frozen resolver.

### D7. Org API-credentials viewer is a read model over Better Auth's `apikey` table

Listing is `auth.api.listApiKeys` (or the equivalent org-scoped query)
filtered to the caller's tenant (`referenceId = ctx.tenantId`), joined in the
service layer to the `_user` entity via each key's `metadata.userId` for
service-account credentials (integration-only keys, without a `_user`, show
kind `integration` and no joined user). The prefix (`key.prefix`), `enabled`,
`createdAt`, `lastRequest`, and a computed `rotationDueAt` (D8) are returned;
the hashed `key` column is never selected into the response shape, so "never
re-exposes a secret" is a projection guarantee. `enabled` is derived: a
credential is shown disabled when its key is disabled, it is revoked, or its
bound service account is `Disabled`.

- _Alternative:_ a denormalized read table Tayzu maintains itself. Rejected:
  Better Auth's `apikey` table is already the source of truth.

### D8. Credential create, rotate and revoke go through the revocation list — ADR-0018

Better Auth's `api-key` plugin has no rotate endpoint: rotation is "create a
new key, retire the old one", done at the application layer, and **retiring
means writing the revocation list**. Disabling a key through `updateApiKey`
alone would leave an already-issued 1-hour access token valid, against `002`
Q13's within-seconds rule, so rotation and revocation both use
`revokeMachineCredential`, which writes the `machine_credential_revocation` row
before disabling the key (an insert-only, permanent row).

- **Create** (`identity.credentials.create`, integration/agent credentials; a
  service account's first credential comes from D6): sets the per-key rate
  limit explicitly (Better Auth's default is 10 verifications per 24 hours,
  about 10 token exchanges a day), does not store the first characters of the
  secret, and applies the expiry decided in Open Question 3.
- **Rotate**: create the new key, then revoke the old one, then return the new
  secret once. If the revoke fails, the new key is revoked as compensation so no
  second usable credential survives; if compensation also fails,
  `catalog.security.credential_rotation_incomplete` is emitted. Rotation of a
  credential that is already revoked simply issues a new one.
- **Revoke**: permanent; already-issued tokens are rejected within seconds
  because `resolveContext` consults the revocation list through a cache of at
  most 5 seconds, failing closed (`002` D21).
- `rotatedAt`/`rotationDueAt` live in the new key's `metadata`; the viewer (D7)
  computes "rotation due" against a Tayzu-chosen default interval (90 days,
  configurable, in `docs/security/data-retention.md`). It is a documented
  policy default, not a hard-enforced expiry: no credential is force-disabled
  solely for being overdue (Open Question 3 revisits key expiry).
- Because the revocation row is a permanent insert, "disable then re-enable" is
  not a credential operation. Pausing a service account is `setStatus`
  (D13), which is reversible; restoring a revoked credential is "rotate".

- _Alternative:_ a grace-period window (old key stays valid for N hours).
  Rejected for v1: real orchestration complexity for a benefit no Phase-1
  integration needs yet. Recorded as a Risk, not built.

### D9. Org deletion is two-phase: revoke now, purge later — ADR-0019

Decision (Resolved decision Q14), rewriting the earlier synchronous design,
which could not work as written: `catalog_change_event` is append-only (a
trigger rejects DELETE for every role, and `tayzu_app` has no DELETE or
TRUNCATE), `machine_credential_revocation` has no DELETE grant, catalog tables
run on `tayzu_app` and Better Auth tables on `tayzu_auth` (two roles and pools
cannot share a transaction), `apikey` has no FK to the organization, and
several catalog FKs are `RESTRICT`.

**Phase 1, request** (`identity.organization.delete`): Cerbos `organization.delete`
with the real tenant, step-up, and an explicit confirmation: the caller sends
the organization's identifier, and it must equal the **host** `ctx.tenantId`
(never a value looked up from input). The operation inserts a **deletion marker**
for the tenant (a new table, migration `0012`, Checkpoint 3) with a
`purge_after` date, revokes every session whose active organization is the tenant,
revokes every org-owned credential (revocation list), cancels pending
invitations, and emits `catalog.audit.org_deletion_requested`. From that moment
`resolveContext` and token exchange reject every principal of the tenant, human
or machine (D13). The window is between 7 and 14 days (configurable, validated
at startup; the default is Open Question 4). Requesting it again while pending
changes nothing and returns the original date.

**Phase 2, purge** (a scheduled job; an Azure Container Apps Job provisioned
with `010`, with its entry point and a `tsx` script in this change, no HTTP
listener): for each tenant whose `purge_after` has passed, in two idempotent
steps with safe resume (progress is recorded on the marker):

1. **Catalog data** (`tayzu_app`): ordered deletes of relations, entities,
   blueprints and the other `catalog_*` rows (the order respects the `RESTRICT`
   FKs), and for the append-only rows (`catalog_change_event`, the tenant's
   `machine_credential_revocation` rows) a `SECURITY DEFINER` function owned by
   `tayzu_migrator` that deletes **only** for a tenant whose marker is due. The
   append-only guarantee holds for every other path, and `PUBLIC` has no
   `EXECUTE` (which role may execute it is part of the Checkpoint 3 review;
   the proposal is `tayzu_app` only).
2. **Better Auth data** (`tayzu_auth`): the org's invitations, API keys
   (`referenceId`), invitation tokens in `auth.verification`, members, then
   each user who has no remaining membership in any other org together with
   that user's `account`, `session` and `twoFactor` rows (global user data is not
   per-org, so deleting only `member`/`invitation`/`apikey` would orphan it),
   and the organization row last.

`catalog.audit.org_deletion_completed` is emitted by the purge itself
immediately before the organization row is deleted, **not** from Better Auth's
`afterDeleteOrganization` hook (the installed plugin also has
`beforeDeleteOrganization`, and the `after` hook runs after the delete). A
failed step emits `catalog.security.org_deletion_failed` (with the step) and
the next run resumes. The marker stays as a tombstone (tenant id and
timestamps only) so a later request finds nothing.

**Recovery** is the pending window, not point-in-time restore: server-level
PITR cannot restore one tenant out of a shared-schema database. Backups keep
purged data until the backup retention expires; the erasure statement in
`docs/security/data-retention.md` says so. A compromised admin session with a
fresh MFA can no longer destroy a tenant irreversibly in one call.

- _Alternative:_ immediate hard delete as the first draft had it, with a
  point-in-time restore runbook. Rejected by Resolved decision Q14.
- _Alternative:_ keep change events and pseudonymize snapshots. Rejected: it
  keeps the tamper-resistance but partially defeats erasure of the `_user`
  emails the snapshots hold.

### D10. API contract

New oRPC procedures on the router `002` exposes. Each declares
`.route({ method, path, spec: markHighRisk })` like
`packages/catalog/src/api/contract.ts`, because step-up runs only in the
OpenAPI interceptor keyed on the route spec (calls through
`createRouterClient` skip it).

| Procedure                             | Route                                  | Notes                                |
| ------------------------------------- | -------------------------------------- | ------------------------------------ |
| `identity.users.invite`               | `POST /v1/users/invitations`           | high-risk (Open Question 2)          |
| `identity.users.cancelInvitation`     | `POST /v1/users/invitations/{invitation}/cancel` |                            |
| `identity.users.resendInvitation`     | `POST /v1/users/invitations/{invitation}/resend` |                            |
| `identity.users.acceptInvitation`     | `POST /v1/auth/invitations/accept`     | public, outside the tenant pipeline  |
| `identity.users.setStatus`            | `PUT /v1/users/{user}/status`          | high-risk                            |
| `identity.serviceAccounts.create`     | `POST /v1/service-accounts`            | high-risk                            |
| `identity.serviceAccounts.delete`     | `DELETE /v1/service-accounts/{user}`   | high-risk                            |
| `identity.credentials.list`           | `GET /v1/credentials`                  |                                      |
| `identity.credentials.create`         | `POST /v1/credentials`                 | high-risk                            |
| `identity.credentials.rotate`         | `POST /v1/credentials/{credential}/rotate` | high-risk                        |
| `identity.credentials.revoke`         | `POST /v1/credentials/{credential}/revoke` | high-risk                        |
| `identity.organization.delete`        | `DELETE /v1/organization`              | high-risk                            |

`{user}` is the `_user` entity identifier (an email, or `svc-…`), sent
unencoded because `@` is legal in a path segment (Resolved decision Q12); a
path containing `%` is a 404 (`002` Q74). Such identifiers must never reach
telemetry (D16). The two `002` procedures that mint power are marked too:
`identity.users.create` (Open Question 2) and the existing `linkSsoAccount`/
`unlinkSsoAccount` stay high-risk. There is no role or Moderator editing
procedure (Resolved decision Q16), so there is nothing to mark for it.

High-risk set (`x-tayzu-risk: high`, VCDM B11): `setStatus`,
`serviceAccounts.create`, `serviceAccounts.delete`, `credentials.create`,
`credentials.rotate`, `credentials.revoke`, `organization.delete`, plus
`invite` and `identity.users.create` as decided in Open Question 2. Deleting a
service account is in the set because it revokes a credential, the same class
as `credentials.revoke`.

Error codes reuse `001` design D11's table and `002`'s: `AUTH_FORBIDDEN` (403),
`AUTH_STEP_UP_REQUIRED` (403, not 409), `AUTH_RATE_LIMITED` (429),
`CATALOG_NOT_FOUND` (404), `CATALOG_VALIDATION_FAILED` (400). All are already
mapped in `apps/api/src/error-mapping.ts`. The change introduces no new code.

### D11. Testing strategy

Unit tests (the D2 state machine, pure). Integration tests against a real
PostgreSQL 16 and a real Cerbos test container (`002`'s harness), exercising
the actual Better Auth instance (no mocked `organization`/`api-key` plugin —
invitation expiry and re-invite cancellation are verified against the real
library). The `EmailSender` port is faked (a recording fake asserting "one
call, one recipient, one link"), never calling the real Azure Communication
Services API. `cerbos compile` (with its bundled test suites) gates every
policy file. Step-up is tested **over HTTP only** (D10). Every route has a
cross-tenant test (D14). Org-owned key tests use a Better Auth `admin`
member, not only `owner`, because Better Auth's own authorization on those
keys is owner-only and is a second authorization path (`002` residual risk);
Cerbos goes in front of it before any mount.

### D12. Docs-as-Code and ADRs from this change

- `docs/adr/0017-service-account-identifier-convention.md` (D6)
- `docs/adr/0018-credential-rotation-immediate-cutover.md` (D8)
- `docs/adr/0019-org-deletion-two-phase-purge.md` (D9)
- `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md` (D3)

`002` claims 0013-0016 and 0021 is taken, so 0017-0020 are free. This change
also writes `docs/security/data-retention.md` (the purge window and the
erasure statement about backups; the credential rotation cadence; the
invitation caps; audit and security log retention of at least 12 months,
independent of tenant deletion, cross-referenced from `010`/`015`), updates
`docs/security/secrets.md` (the Communication Services secret and its change
procedure, the kill switch, the credential lifecycle), `docs/security/
attack-surfaces.md` (the twelve routes, the public accept route, and the mount
gate state; it currently lists `identity.*` as not mounted),
`docs/security/crypto-inventory.md` (the invitation token) and `docs/security/
dependencies.md` (license, `allowBuilds` and SBOM review of
`@azure/communication-email` and its transitives), and updates
`docs/architecture/system-diagram.md` (new external actors: the email provider
and the invitee with their mailbox; new arrows: invite → email, the public
accept route, ACS egress over HTTPS, the purge job).

### D13. Disable, rotate, revoke and pending deletion take effect within seconds

Access tokens are stateless 1-hour JWTs, and `resolveContext`'s machine branch
checks neither the credential's `enabled` flag nor `_user.status`. Per Resolved
decision Q13 (and Q11), `resolveContext` and token exchange gain these checks,
all through the existing 5-second cache and **failing closed** on any lookup
failure:

- A human whose Better Auth user is `banned` is rejected (this is task 14.4;
  `resolveContext` did not check it). `setStatus` to `Disabled` calls
  `banUser`, which also revokes the user's sessions, and cancels the user's
  pending invitations; `Active` calls `unbanUser`. Sign-in is blocked locally
  and through SSO.
- A machine principal whose bound `_user` (from the `userId` attribution claim)
  is `Disabled` is rejected, and token exchange refuses to mint a token for it.
  The revocation list is insert-only, so the cache check is what lets a
  disabled service account be re-enabled without a migration.
- A principal, human or machine, of a tenant with a deletion marker is rejected
  (D9).
- Revoked credentials are already covered by `002` D21 (D8).

Each rejection emits `catalog.security.principal_rejected` and increments
`tayzu.identity.principal_rejections`. There is no last-active-admin guard in
this change (two admins can disable each other); it is a ticket (Risks).

### D14. Every target is resolved on the server and belongs to the caller's tenant

The `identity.*` data lives in the `auth` schema, which has no RLS (`tayzu_auth`,
`002` D6), and `same_tenant` is vacuous unless the real tenant is passed (D3).
So the tenant boundary for these routes is code, and it is stated as a rule:

- Every `{invitation}`, `{credential}`, `{user}`, `{serviceAccount}` and
  organization target is resolved **server-side** and must belong to
  `ctx.tenantId`. Otherwise the answer is `CATALOG_NOT_FOUND`, identical to a
  nonexistent id (no existence oracle).
- Cerbos receives the **target's** real tenant as the resource tenant, not
  `ctx.tenantId` echoed back.
- `tenantId` and `actor` are never read from input, path, query or body.
  `identity.organization.delete` compares its confirmation to `ctx.tenantId`, and
  every Better Auth call (`deleteOrganization`, `listApiKeys`, `inviteMember`) is
  given the host tenant only.
- The one exception is the public accept route, whose tenant is derived from the
  invitation record (D4), never from the request.
- Each of the twelve routes has a cross-tenant test (tasks, group 13).

### D15. Mount gate: the routes do not exist over HTTP until the hand-offs are done

`002` Q73 is a hard rule: `identity.*` and the machine-credential routes are
not mounted over HTTP before the hand-offs from `002` (tasks, group 14) are
done. Prose is not a gate, so it is mechanical:

- A switch, `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), is
  **off by default**. With it off, every route of D10 (including the public
  accept route and any credential create/revoke route) answers 404, as if it did
  not exist. A test enumerates the route table and fails if any identity or
  credential route is registered outside the switch. This switch is also the
  rollback: turning it off removes the whole surface.
- Task order matches: the group that registers the routes (group 15) comes
  **after** the hand-off group (group 14). No HTTP assertion about these routes
  is written before group 14 is done; earlier groups test in process.
- Turning the switch on in a deployment is a first-deployment gate for `010`
  (Risks).

### D16. No identifier in a URL path reaches telemetry

`002` Q67 drops only `url.query`; the HTTP instrumentation still exports the
raw `url.path`, and `{user}` is an email. `apps/api/src/telemetry.ts` already
strips the query part of `url.full`, `http.url`, `http.target` and `url.path`
from spans. For the identity routes it additionally replaces the path with its
route template (`http.route`, for example `/v1/users/{user}/status`), so no
email, invitation id or credential id leaves the process. The marker test runs
through the real HTTP instrumentation, not only the in-memory harness.

## Observability contract

Tracer/meter name `@tayzu/auth` (the package this change and `002` share),
version equal to the package version — a second instrumentation scope
alongside `001`'s `@tayzu/catalog`. Shared attribute keys (`tayzu.tenant.id`,
`tayzu.actor.type`, `tayzu.actor.id`) come from `@tayzu/observability/semconv`,
unchanged. The contract lives in `packages/auth/src/telemetry/contract.ts`;
`otel-smoke-check` (which imports `packages/authz/src/telemetry/contract.ts`
today) is extended to import this one as well, so the new names are enforced.

Identifier rules for every signal: `tayzu.identity.user.id` is the Better Auth
user id, `tayzu.identity.service_account.id` is the `_user` entity's opaque id,
never the email or the `svc-…` identifier, and no invited email, token,
credential name or secret appears anywhere.

### Spans

| Span name                         | When | Required attributes                                                                  | Conditional attributes |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------ | ---------------------- |
| `identity.invitation.create`      | op   | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role` (`member`\|`admin`) | —                      |
| `identity.invitation.accept`      | op   | `tayzu.identity.invitation.id`                                                       | —                      |
| `identity.invitation.cancel`      | op   | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason` (`admin_cancel`\|`re_invite`\|`user_disabled`\|`org_deletion`) | — |
| `identity.invitation.resend`      | op   | `tayzu.identity.invitation.id`                                                       | —                      |
| `identity.user.set_status`        | op   | `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`                   | —                      |
| `identity.service_account.create` | op   | `tayzu.identity.service_account.id`                                                  | —                      |
| `identity.service_account.delete` | op   | `tayzu.identity.service_account.id`                                                  | —                      |
| `identity.credential.list`        | op   | `tayzu.identity.credential.count`                                                    | —                      |
| `identity.credential.create`      | op   | `tayzu.identity.credential.kind`                                                     | —                      |
| `identity.credential.rotate`      | op   | `tayzu.identity.credential.kind`                                                     | —                      |
| `identity.credential.revoke`      | op   | `tayzu.identity.credential.kind`                                                     | —                      |
| `identity.organization.delete`    | op   | `tayzu.tenant.id`                                                                    | —                      |
| `identity.organization.purge`     | job  | `tayzu.identity.org_deletion.step` (`catalog`\|`auth`), `tayzu.identity.org_deletion.entities_removed` | —   |

All spans are `INTERNAL`, one per operation (one per tenant and step for the
purge), following `001` design's error and sanitization rules verbatim
(expected errors: `error.type` only, no exception event; unexpected errors:
sanitized exception, no message/SQL).

### Metrics

| Instrument                            | Type, unit                | Attributes                                                                                                                                                                | Purpose                                                                                             |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tayzu.identity.invitations`          | Counter, `{invitation}`   | `tayzu.tenant.id`, `tayzu.identity.invitation.mutation` (`created`\|`accepted`\|`rejected`\|`cancelled`\|`expired`\|`rate_limited`)                                       | Invitation funnel                                                                                   |
| `tayzu.identity.user_status_changes`  | Counter, `{change}`       | `tayzu.tenant.id`, `tayzu.identity.user.status.to`, `tayzu.actor.type`                                                                                                    | Lifecycle churn                                                                                     |
| `tayzu.identity.service_accounts`     | Counter, `{account}`      | `tayzu.tenant.id`, `tayzu.identity.service_account.mutation` (`created`\|`disabled`\|`enabled`\|`deleted`)                                                                | Service-account volume                                                                              |
| `tayzu.identity.credential_mutations` | Counter, `{mutation}`     | `tayzu.tenant.id`, `tayzu.identity.credential.kind` (`service_account`\|`integration`), `tayzu.identity.credential.mutation` (`created`\|`rotated`\|`revoked`)            | Credential hygiene signal                                                                           |
| `tayzu.identity.org_deletions`        | Counter, `{deletion}`     | `tayzu.identity.org_deletion.outcome` (`requested`\|`completed`\|`failed`)                                                                                                | Rare, high-impact operation — always worth a signal (`denied_step_up` dropped: the guard already emits `tayzu.auth.step_up.required`) |
| `tayzu.identity.principal_rejections` | Counter, `{rejection}`    | `tayzu.identity.rejection.reason` (`user_disabled`\|`service_account_disabled`\|`tenant_pending_deletion`), `tayzu.actor.type`                                            | Enforcement of D13 is visible and alertable                                                         |

`tayzu.identity.step_up_denials` from the earlier draft is **dropped**: the
step-up guard already emits `auth.security.step_up_required` and
`tayzu.auth.step_up.required`.

**Cardinality budget**: `tayzu.tenant.id` stays under the same <20 bound `001`
ADR-0006 already assumes. Every other attribute above is a bounded enum.
Invited emails, invitation tokens, credential names, and credential secrets
are **never** attributes on any signal — the cardinality guard extends
`001`'s otel-smoke-check to this package's metrics too.

### Log events

| Event name                                      | Severity | Attributes                                                                                                                                                  | Purpose                                                                                                   |
| ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `catalog.audit.invitation_created`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role`                                   | Audit; the role is logged (VCDM B2)                                                                       |
| `catalog.audit.invitation_accepted`             | INFO     | same, plus `tayzu.identity.user.id`                                                                                                                         | Audit                                                                                                     |
| `catalog.audit.invitation_cancelled`            | INFO     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                                                          | Audit                                                                                                     |
| `catalog.audit.invitation_resent`               | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.invitation.id`                                                                                         | Audit (new)                                                                                               |
| `catalog.audit.user_created`                    | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.user.role` (`member`\|`admin`), `tayzu.identity.user.source` (`admin`\|`bootstrap`) | Audit for `identity.users.create` and bootstrap (`002` Q42, new)                                    |
| `catalog.audit.user_status_changed`             | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`, `tayzu.identity.user.account_kind` | Audit of every status change, including service accounts disabled and enabled (new)       |
| `catalog.audit.service_account_created`         | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id`                                                                                    | Audit                                                                                                     |
| `catalog.audit.service_account_deleted`         | INFO     | same                                                                                                                                                        | Audit (new)                                                                                               |
| `catalog.audit.credential_created`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`, `tayzu.identity.credential.kind`                                                       | Audit (`002` Q42, new)                                                                                    |
| `catalog.audit.credential_rotated`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                 | Audit — opaque IDs only, never secrets                                                                    |
| `catalog.audit.org_deletion_requested`          | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                         | Phase 1 started: access revoked, tenant marked (new)                                                      |
| `catalog.audit.org_deletion_completed`          | INFO     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.entities_removed`                                                                                           | Durable record that the irreversible purge happened, emitted by the purge before the organization row is deleted |
| `catalog.security.authz_denied`                 | WARN     | as already declared by `001`/`002`                                                                                                                          | Reused: the identity router now emits it on every Cerbos deny (it threw silently before)                 |
| `catalog.security.invitation_acceptance_denied` | WARN     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.denial_reason` (`expired`\|`cancelled`\|`rejected`\|`already_accepted`\|`token_mismatch`\|`disabled_user`\|`not_found`) | Misuse of dead/foreign invitations (SEC06/SEC11); the reason lives only here, never in the HTTP response |
| `catalog.security.invitation_rate_limited`      | WARN     | `tayzu.tenant.id`, `tayzu.identity.invitation.limit_scope` (`tenant`\|`recipient`\|`global`)                                                                | Invite/resend volume abuse signal; no invited email present                                               |
| `catalog.security.self_status_change_denied`    | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                         | Self-service status tampering                                                                             |
| `catalog.security.principal_rejected`           | WARN     | `tayzu.identity.rejection.reason`, `tayzu.actor.type`                                                                                                       | A disabled, revoked-tenant or pending-deletion principal was refused (D13, new)                           |
| `catalog.security.credential_revoked`           | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`                                                                                         | Security-relevant, not routine                                                                            |
| `catalog.security.credential_rotation_incomplete` | WARN   | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                 | Overdue signal: a rotation left two usable credentials or none (new)                                      |
| `catalog.security.org_deletion_failed`          | WARN     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.step` (`catalog`\|`auth`)                                                                                   | A purge step failed; a failed deletion is no longer invisible (new)                                       |

Every event above is exempt from sampling and from any downstream filter/drop
rule, per `001`'s existing rule for `catalog.audit.*`/`catalog.security.*`
(`001` design, Sampling exemption) — `010` inherits this constraint unchanged.
The user, credential and bootstrap lifecycle events `002` Q42 deferred to this
change are `user_created`, `credential_created`/`credential_rotated`/
`credential_revoked`, and the bootstrap case of `user_created`; SSO link and
unlink already have `auth.security.account_linked` and `account_unlinked`.

## Security considerations (SSA SEC01-SEC16 posture)

This is this change's own SEC01-16 walk-through. The formal `vcdm-ssa-validator`
pre-assessment (Mode A, 2026-10-01) found 11 blocking gaps (B1-B11) against the
merged `002`, all folded below; each is also a requirement or scenario in the
spec and a task. A joint pre-assessment with `002` (`002/ssa-pre-assessment.md`)
earlier found the seam gaps closed by D3/D6.

| Gap | Where it is closed |
| --- | --- |
| B1 invitation acceptance cannot work | D4 (public accept route, token, tenant from the invitation), spec requirement "Invitation acceptance", tasks group 8 |
| B2 unconstrained invited role | D4 (`member`\|`admin`), spec "Invitation lifecycle", task 7.4 |
| B3 no server-side tenant binding | D14, spec "Targets belong to the caller's tenant", group 13 |
| B4 disable/rotate not immediate, state machine bypass | D2, D8, D13, spec "Disabling a human takes effect immediately", groups 4, 9, 10, 11 |
| B5 org deletion impossible as written | D9, spec "Org deletion", group 12, migration `0012` |
| B6 Q73 gate not enforced | D15, spec "Identity routes are unreachable until mounted", group 14 before 15 |
| B7 security logging gaps | Observability contract, spec "Security-relevant events are logged" |
| B8 paths leak identifiers | D16, spec "Telemetry contract", task 16.5 |
| B9 email injection, origin, caps | D4, D5, spec "Invitation email is fixed and capped", group 6 |
| B10 service-account ceiling | D3, D6, spec "Service accounts", groups 5 and 10 |
| B11 step-up coverage | D10, spec "Every high-risk operation requires step-up", task 15.2 |

| Section | Applies | Posture |
| --- | --- | --- |
| SEC01 Diagram | Yes | New external actors (the email provider; the invitee with their mailbox) and new arrows (invite→email, the public accept route, ACS egress over HTTPS, the purge job) added to `docs/architecture/system-diagram.md` (task 17.7). |
| SEC02 Attack surfaces | Yes | Twelve routes (D10), each with its actor, authentication (session, step-up-verified session, or none for the public accept route) and Cerbos check named in `docs/security/attack-surfaces.md` (task 17.6). The native Better Auth `inviteMember` and `accept-invitation` routes stay off `002`'s allowlist (D18 there). The accept route is the first unauthenticated route: it derives the tenant from the invitation, is rate-limited, never reveals why it failed, and sits behind the mount gate (D15). |
| SEC03 Access control | Yes, core | Every operation Cerbos-gated to `admin` (D3) with the target's real tenant; targets resolved server-side (D14); self-status-change denied; step-up on every high-risk operation (D10); invited role limited to `member`/`admin`; service accounts held to `member` by signed claim, creation validation and a Cerbos deny (D6); disabled users and service accounts rejected within seconds (D13). Off-boarding is `Disabled`; role change and member removal are deferred (Non-Goals). The human attestations (off-boarding procedure, training, access review) are deferred to `010`'s SSA (Resolved decision Q17). |
| SEC04 Password storage | Yes | The acceptance flow is the first place a password is set outside sign-in: it applies the password policy (Q22), the hash is Better Auth's scrypt (`002`), and a token is required before any password is read. Service-account credentials reuse `002`'s API-key hashing. |
| SEC05 Crypto | Partial | The invitation token is 256 bits from a CSPRNG, stored only as a sha256 digest and compared in constant time (D4); credential secrets are hashed by `002`'s mechanism; TLS to Azure Communication Services is provider-managed. The token generator is ours, so no Better Auth invitation-id entropy claim is relied on. |
| SEC06 Misuse | Yes | Dead invitations never succeed; acceptance errors are indistinguishable; a `Disabled` user cannot be revived by sign-in, acceptance or a hook (D2); re-invite cancels the previous invitation; org deletion is idempotent and reversible during the window (D9). |
| SEC07 Dependencies | Yes | `@azure/communication-email` joins the Dependabot/`pnpm audit`/quarterly-EOL process; license, `allowBuilds` and SBOM review are recorded in `docs/security/dependencies.md` (task 1.3). |
| SEC08 File upload | N/A | No file upload surface. |
| SEC09/SEC10 Secrets | Yes | The Communication Services connection string is a new Key Vault secret with a change procedure in `docs/security/secrets.md`; a managed identity instead is a ticket. |
| SEC11 Phishing | Yes, core new exposure | 48h expiry, one link, fixed subject and template with no tenant or inviter free text, link origin from `BETTER_AUTH_URL` only, exactly one recipient and no CC/BCC/attachments, per-tenant, per-recipient and global caps (D4, D5). |
| SEC12 Testing | Yes | Every requirement has a scenario-backed test; every route a cross-tenant test; `cerbos compile` gates policies. The OpenAPI-driven ZAP scan (`002` NB1) would hit `organization.delete`, `rotate`, `revoke` and `invite`, so it needs a sandbox tenant, a non-sending email sender and a destructive-route exclusion (ticket, Risks). |
| SEC13 Deployment | Partial | One env var (Communication Services connection string via Key Vault reference), `INVITATION_EMAIL_KILL_SWITCH`, `MOUNT_IDENTITY_ROUTES`, the purge window, and a scheduled job provisioned with `010`; production startup fails without a real `EmailSender`. |
| SEC14 Infra permissions | Yes | Two migrations (Checkpoint 3): `0011` and `0012` add a deletion-marker table and a `SECURITY DEFINER` purge function owned by `tayzu_migrator`; the roles stay separate (`tayzu_app`, `tayzu_auth`, `tayzu_migrator`) and `PUBLIC` gets no `EXECUTE`. |
| SEC15 Network/host | Partial | One new outbound call (Azure Communication Services, HTTPS) and the sender-domain DNS (SPF, DKIM, DMARC), recorded as an egress in the system diagram. DNS DDoS protection is deferred to `010`'s SSA (Q17). |
| SEC16 Logging | Yes | Nineteen new log events (plus the reused `catalog.security.authz_denied`) in the contract, all sampling-exempt, opaque ids and enums only; `catalog.security.authz_denied` is emitted from the identity router; no identifier in a URL path reaches telemetry (D16). |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 043 | Why |
| --- | --- | --- | --- |
| Invite/status-change authorization | Gated on request _origin_ (UI/API) | Gated on Cerbos role (`admin`) | `project.md`'s "actor.type/origin never selects a code path" invariant (D3, ADR-0020) |
| Service-account identifier | Real-looking email at a reserved domain (`serviceaccounts.getport.io`) | `^svc-...` non-email identifier | Tayzu's `_user.identifier` is not required to be email-shaped; avoids a lookalike-phishing surface (D6, ADR-0017) |
| Org deletion recovery | Described as a 14-day internal backup process, mechanics undocumented | A pending window (7 to 14 days) during which access is revoked and the tenant can still be reversed, then a job purges | Server PITR cannot restore one tenant; the window is a real, testable mechanism (D9, ADR-0019) |
| Credential rotation | Undocumented beyond "rotate if exposed" | Explicit immediate cutover through the revocation list, 90-day documented rotation cadence | Port leaves this as a gap (`r1-port.md` §8.1); Tayzu specifies it fully (D8, ADR-0018) |
| "View as" a different user | Documented, admin-only | Not built in this change | Explicitly later-UI (`003`/`014`), not dropped |
| Support-user audit exemption | _"Support user actions are not logged"_ | No such exemption anywhere in Tayzu | Every administrative action, including Tayzu's own operators, is logged uniformly (SEC16) |

## Risks / Trade-offs

- [Credential rotation has no grace period (D8); an integration polling with
  the old credential breaks within seconds of the rotation] → Documented in
  the rotation UX copy and `docs/security/data-retention.md`; revisit with a
  scheduled hard-revoke only if a real Phase-1 integration needs it.
- [A pending org deletion is reversible only out of band (Open Question 4),
  and the purge removes the data for good; backups keep it until their own
  retention expires] → The erasure statement in
  `docs/security/data-retention.md` says so; the Azure backup retention is an
  infrastructure setting to confirm when the server is provisioned.
- [The deletion marker and the purge function are the most privileged new
  surface: a compromised app role that can write a marker and execute the
  function could purge another tenant] → Checkpoint 3 reviews the grants; the
  function checks the marker is due, and only the operation writes it behind
  Cerbos, step-up and the host-tenant confirmation. Recorded for `010`.
- [Per-recipient cap across tenants is a weak oracle: an admin sees
  `AUTH_RATE_LIMITED` for an address that other tenants invited three times]
  → Accepted; the response is the same one a tenant cap gives, and the signal
  reveals no tenant. Ticket to revisit.
- [Step-up is keyed on the route, so a per-role step-up (admin invite only)
  would need a body-aware guard] → Open Question 2.
- [An existing-account invitee, an SSO-only invitee] → Open Question 1 and
  `002` Q72: an organization that wants to invite someone who will only ever
  use Visma Connect is unsupported until `025`; they need a local password
  first, then link through `/link-social`. A service account has no Visma
  account to link and needs no change.
- [Drift between this design and `002`'s implementation by the time `043`
  starts implementation] → Checked against the merged code on 2026-10-01 (task
  1.1); the findings are in the Context.
- [Sending a real invitation email in integration tests would be flaky and
  slow] → `EmailSender` is faked in every test except a single, explicitly
  optional manual smoke check against a real Communication Services sandbox
  (not part of CI).

### Gates for the first deployment (`010`)

Human-owned, next to `002`'s own list:

- The invitation caps (Q15) and the accept-route limiter on a **shared store**
  across replicas (`002` Q73 gate, extended to these buckets).
- `MOUNT_IDENTITY_ROUTES` is turned on only after every task in group 14 is
  ticked.
- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the
  secret in Key Vault; the DAST scan runs against a sandbox tenant with a
  non-sending sender and without the destructive routes.
- The purge job is provisioned and the purge window and Azure backup
  retention are confirmed.
- The human attestations (off-boarding, training, access review, DNS DDoS, log
  hours, retention policy) are answered in `010`'s SSA (Resolved decision Q17).

### Tickets (non-blocking VCDM items, not built in this change)

| Ticket | Item |
| --- | --- |
| Last-active-admin protection | Two admins can disable each other; the last admin can be disabled. |
| Member management | `updateMemberRole`, `removeMember`, `setActiveOrganization` as Cerbos-gated procedures (`002` D18), after this change. |
| Retention windows | Accepted, expired and cancelled `invitation` rows keep the invitee's email; a `_user` left at `Invited` after expiry stays; define windows. |
| User notifications | Status, role and credential changes notify the user (SEC06; `002` Q46). |
| Service-account read scope | A service account as `member` can list all users' emails. |
| ACS managed identity | Prefer a managed identity to a connection string (SEC10/SEC14). |
| ZAP guards | Sandbox tenant, no-send email sender, destructive-route exclusion. |
| SSO-only when linked | `002` Q44, for `025`. |
| Per-recipient oracle | See Risks. |
| Email in the `{user}` path | The `_user` identifier (an email) is a path segment (Resolved decision Q12). D16 keeps it out of the process's telemetry, but the ingress and any proxy access log outside the process still see it. Consider an opaque-id route. |
| `002` hand-off traceability | Q73 hands 043 items M9, M12-M14 and M17-M19; group 14 maps M4, M5, M10, M11, M15 and M20 only, and the others are not recorded in the repo. |

## Migration Plan

1. **Two SQL migrations, both Checkpoint 3**, each with its
   `migrations/down/00NN.down.sql`, `meta/00NN_snapshot.json` and `_journal.json`
   entry: `0011_machine_credential_revocation_tenant_key` (a composite
   `(tenant_id, credential_id)` key; task 11.1) and `0012_tenant_deletion` (the
   marker table and the `SECURITY DEFINER` purge function; task 12.1). The
   blueprint evolution of `_user` (D1) is not a migration: it is a
   `blueprints.update` per existing tenant plus the new-tenant constant.
2. ⛔ **Checkpoint 3** also applies to every Cerbos policy file this change adds
   or edits (D3): the `user.yaml` deny rules; the new `service_account.yaml`,
   `credential.yaml` and `organization.yaml`; and `admin.yaml`,
   `member.yaml` (if needed) and `role_policies_test.yaml`; each presented with
   its `cerbos compile` test output, separately.
3. Deploy: `@azure/communication-email` and its Key Vault secret, the kill
   switch and the mount switch (both off or safe by default), and the purge job
   (provisioned with `010`). Nothing is mounted until the gates above are met.
4. Rollback: set `MOUNT_IDENTITY_ROUTES` off to remove the whole HTTP surface
   (D15); disable the purge job. The migrations have down scripts, but a purge
   that already ran cannot be undone.

## Resolved decisions (asked and approved in chat, 2026-09-28 and 2026-10-01)

Per `openspec/project.md` §20, drawn from the shared `002`/`043` decision set
(`scratchpad/p002/decisions.md`) that specifically bears on this change:

| #   | Question                                                                                                                                                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Split point between `002` and `043`                                                                                                                       | This change owns exactly: 4-state user status lifecycle and invitations (+ invitation email, SEC11), service accounts, org API-credentials viewer/management, data retention & deletion policy + org deletion, credential rotation policy UX. Everything else stays with `002`.                                                                                                                                                                                                                                                                                           |
| Q4  | Canonical user status field                                                                                                                               | Stored as one field on `_user`, updated by hooks reacting to Better Auth events (`002` defines the field and `Active`/`Disabled` at minimum; this change completes `Staged`/`Invited` and the transition rules).                                                                                                                                                                                                                                                                                                                                                          |
| Q5  | Machine credentials                                                                                                                                       | Long-lived client id + secret (revocable, rotatable, hashed) exchanged for a short-lived (1-hour) access token — this change's service accounts and credential viewer/rotation consume that mechanism, they do not redefine it.                                                                                                                                                                                                                                                                                                                                            |
| Q6  | Step-up for high-risk operations                                                                                                                          | A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10).                                                                                                                                                                                                                                                                                                                                              |
| Q7  | (VCDM pre-assessment, 2026-09-28) Should service accounts be restricted from holding `admin`/broad `moderatedBlueprints`, given they never go through step-up | Restrict service accounts to `member` role only, enforced at creation/update validation and by an independent Cerbos rule on `accountKind: "service"` (D6, D3).                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q8  | (Drift-check and VCDM pre-assessment against merged 002, 2026-10-01) How an invitee without an account accepts                                            | The invitation link carries a single-use, constant-time-compared token. A public, rate-limited accept route outside the tenant-context pipeline derives the tenant from the invitation record, lets the invitee set a password, and treats the token as mailbox proof (email verified in-process); MFA enrollment then follows 002 Q43, and Visma Connect is linked later through `/link-social`, `sub`-keyed. Responses are enumeration-resistant. The native `/organization/accept-invitation` route stays off the D18 allowlist.                                          |
| Q9  | (VCDM B2, 2026-10-01) Roles an invitation may carry                                                                                                       | `member` or `admin`, never `owner`; an `admin` invitation requires step-up and is logged with its role (consistent with 002 Q37).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q10 | (Drift b2, 2026-10-01) Attributing `_user` writes to the admin                                                                                            | The identity procedure writes as `system` with `actor.onBehalfOf` set to the admin, in-process only; `reserved.ts` is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q11 | (Drift b8, 2026-10-01) Canonical disable mechanism and default status                                                                                     | `setStatus` calls Better Auth `banUser`/`unbanUser` and syncs `_user.status` through the `nextStatus` state machine; `afterAddMember`, the ban hook and `identity.users.create` go through it. Admin-created users start `Active`; `Staged` is the default only for an entity created without a status. Covers 043 task 14.4.                                                                                                                                                                                                                                              |
| Q12 | (Drift b3/b4, VCDM, 2026-10-01) Service-account principal                                                                                                 | The signed machine claim stays `member` with no teams and no moderated blueprints (002 Q28); `userId` is added only as an attribution claim. Routes address a user by its `_user` entity identifier (email or `svc-…`).                                                                                                                                                                                                                                                                                                                                                    |
| Q13 | (Drift b5, VCDM B4, 2026-10-01) Immediacy of disable, rotate and revoke                                                                                   | Rotate and revoke write the revocation list (effective within seconds). Disable is a `_user.status` check on the resolver's machine branch with the 5-second cache, failing closed, so a disabled service account can be re-enabled without a migration.                                                                                                                                                                                                                                                                                                                  |
| Q14 | (Drift b6, VCDM B5, 2026-10-01) Org deletion                                                                                                              | Two phases: access is revoked immediately and the tenant is marked pending deletion; after a 7-to-14-day window a job purges in idempotent steps (catalog data, then Better Auth rows). The purge of append-only rows goes through a `SECURITY DEFINER` function owned by `tayzu_migrator` that deletes only for a tenant marked for deletion (a migration, Checkpoint 3).                                                                                                                                                                                                  |
| Q15 | (VCDM B9, 2026-10-01) Invitation email abuse limits                                                                                                       | 30 per hour per tenant, 3 per 24 hours per recipient across all tenants, and a global kill switch (environment variable), on a shared store before the first deployment.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q16 | (Drift b7, 2026-10-01) Testing the service-account role ceiling                                                                                           | The Cerbos rule stays as a defensive layer, tested at the policy level, plus a `system`-actor test; no new role-editing operation.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Q17 | (VCDM, 2026-10-01) Human attestations                                                                                                                     | Deferred to `010`'s SSA, as 002 Q59 and Q79.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q18 | (Open Question 1, 2026-10-01) Invitation for an email that already has an account | Acceptance requires an authenticated session of that same account plus the token; it adds only the membership, activates the `_user` and sets no password. |
| Q19 | (Open Question 2, 2026-10-01) Step-up for `invite` and `users.create` | Both are marked `x-tayzu-risk: high` for every invited or created role. |
| Q20 | (Open Question 3, 2026-10-01) Machine API-key expiry | No hard expiry; only the 90-day rotation-due indicator (D8). |
| Q21 | (Open Question 4, 2026-10-01) Org-deletion window and reversal | Default 14 days, configurable between 7 and 14; reversal only by a platform operator clearing the marker through a documented runbook; no in-product cancel. |
| Q22 | (Open Question 5, 2026-10-01) Password policy | Minimum **20** characters (the human's choice), at most 128 (bounds the hashing cost). Every character class is required: an upper-case letter, a lower-case letter, a digit and a symbol. Characters that can harm the system are rejected: control characters (U+0000-U+001F, U+007F-U+009F, NUL included), unpaired surrogates, and Unicode format characters (bidirectional overrides, zero-width characters); the password is NFC-normalized before the check and the hash. A bundled common-password denylist applies, with no external call and no new dependency, plus `002`'s existing backoff. Applies to invitation acceptance, temporary and bootstrap passwords, and `/change-password`. |
| Q23 | (Human, 2026-10-01) Breached-password check | Added to Q22's policy: Better Auth's built-in `haveIBeenPwned` plugin (part of `better-auth@1.7.6`, so no new dependency) refuses any password found in the Pwned Passwords corpus. It sends only the first five hex characters of the password's SHA-1 (k-anonymity range query) to `https://api.pwnedpasswords.com`, a new outbound egress named in SEC15 and the system diagram. It fails closed: when the service is unreachable the password is not set and the caller gets a generic retryable error. It covers every path Q22 covers, including in-process acceptance and bootstrap. |

## Open Questions

None. The five questions raised by the amendment were answered on 2026-10-01 (Q18-Q22).
