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
  - Rate limits use service-level buckets for the invitation caps, with the
    defaults in `apps/api/src/config.ts` (D4). The first draft of this fix used a
    path-keyed in-memory `createRateLimit` preHandler for the public route; that
    is superseded: the accept route also uses the DB-backed store (D4).
  - `docs/security/secrets.md`, `attack-surfaces.md` and `crypto-inventory.md`
    are the docs this change updates (D12).
- **Amended again on 2026-10-01** after Resolved decisions Q18-Q34, a second
  drift-check and a second VCDM pass. Mechanical fixes, so that a reader of the
  older text is not surprised:
  - The acceptance route is a plain Fastify route, not an oRPC procedure, and an
    existing account accepts with a session (D4, Q18, Q24).
  - With the switch off, an unauthenticated call to an identity route answers
    like any unknown `/v1` path (401), not 404 (D15).
  - The identity router and the orchestration live in `apps/api`, with
    structural ports and the pure parts in `@tayzu/auth` (D10, Q30). There are
    fifteen routes, the three existing procedures included (Q31).
  - `setStatus` is tenant-scoped and writes through the internal adapter, not
    Better Auth's `banUser` (D13, Q25); the ban hook compares `banned` before and
    after (D2).
  - Org keys are created headerless, with `admin` granted `apiKey` access (Q29),
    and the per-key rate limit is plugin-level configuration (D8).
  - New resource policies carry the explicit cross-tenant deny and guard every
    attribute with `has()` (D3). An absent `accountKind` is `standard` (D1).
  - The purge uses a dedicated `tayzu_purge` role, an insert-only marker and an
    amended append-only trigger, in migrations `0011`-`0013` (D9, Q26). Reversal
    is an audited operator script and the admins are notified (Q27).
  - The link origin is `INVITATION_LINK_BASE_URL` (Q32), emails the entity
    identifier cannot hold are rejected (Q33), and the password policy and the
    breached-password check apply (Q22, Q23).
  - The invitation caps and the accept limiter reuse `002`'s DB-backed store
    (D4); `docs/catalog/auth-and-rbac.md` is a doc this change updates (D12).
  - Stale references to the five earlier open questions were replaced by Q18-Q22.
- **Amended a third time on 2026-10-01** after Resolved decisions Q38-Q45, a third
  drift-check and a third VCDM pass. Mechanical fixes, so that a reader of the
  older text is not surprised:
  - Existing-account acceptance no longer requires a verified email (nothing in
    `002` ever verifies one) and sets it on success (D4, Q38). An accepted
    `admin` invitation notifies every other admin (D4, D5, Q39).
  - A service account holds exactly one active credential, deleting it revokes
    every bound credential, and the resolver and token exchange reject a token
    whose bound `_user` is absent or not `Active` (D6, D8, D13, Q40).
  - `invite` forwards the admin's session headers into Better Auth (D4, Q42). Org
    keys are created headerless with the acting admin's Better Auth user id as
    `body.userId`, the `organization` plugin defines all three roles, and key
    reads are adapter-level (D8).
  - The identity router's authorization is a mandatory wrapper,
    `defineIdentityOperation`, backed by a route-table-driven HTTP matrix (D10,
    Q45). The fourteen procedures get a second committed OpenAPI document (D10,
    Q43). The per-key rate limit is 60 per hour, configurable (D8, Q44).
  - The reversal script and the `_user` backfill run only through a reviewed
    `workflow_dispatch` workflow (D9, Q41).
  - The status hooks reach `_user` through an adapter in `apps/api` that the app
    and the bootstrap script must wire (D2). The human `_user` status read of
    D13 is new code with its own cache. The accept limiter uses the DB-backed
    store through an exported helper (D4), the accept route performs its own
    `Origin` check and wires the SSO re-authorization (D4), and every limiter
    answers with `Retry-After` (D4). `authz_denied` is emitted through
    `@tayzu/catalog` (Observability contract).
  - Superseded decision rows are annotated, not deleted (Q9, Q11, Q14, Q24).
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
  at token expiry (D13, Resolved decisions Q13, Q14 and Q25).
- Add exactly **three SQL migrations**, each a Checkpoint 3 item, following the
  repo's table-plus-grants pairing: `0011` (a composite `(tenant_id,
credential_id)` key on the revocation list), `0012` (the tenant-deletion
  marker table) and `0013` (its grants, the `tayzu_purge` role, the row-level
  policies, the amended append-only trigger and the purge and lister functions).
  The `_user` blueprint evolution itself stays a data-plane change.
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
- No in-product way to cancel a pending org deletion: reversal is an audited
  operator action (D9, Resolved decisions Q21 and Q27).
- No changes to `002`'s Better Auth bootstrap, MFA, DB roles/RLS, Cerbos
  engine wiring, or the three-tier RBAC baseline itself, beyond the resolver
  checks of D13, the three migrations, and the policy files listed in D3.

## Decisions

### D1. `_user` evolves: a four-value `status` and `accountKind`, per tenant

The `_user` system blueprint (owned by `002`) gains `accountKind`
(`"standard"` | `"service"`, default `"standard"`), and its `status` enum is
widened from `['Active','Disabled']` to the four values `Staged`, `Invited`,
`Active`, `Disabled` (`UserSyncInput.status` is replaced by a `StatusEvent`, D2).
Adding an optional property and widening an enum are the "compatible" cases
`001`'s safe-schema-evolution check (design D7) already proves out, and neither
needs an `ALTER TABLE`, because blueprint schemas live in a `schema jsonb`
column. `_user` is created per tenant and the system blueprint is create-only
and idempotent, so the change has two parts: `USER_BLUEPRINT` carries the new
schema for every **new** tenant (and the bootstrap constant), and a one-off,
idempotent `blueprints.update` run as the `system` actor, once **per existing
tenant**, brings existing tenants forward. Existing `_user` entities stay
valid.

A blueprint `default` is applied **on write only** (`entity-validator.ts`,
`001` spec), and `USER_BLUEPRINT` declares none today, so an existing `_user`
row does **not** read back `accountKind: "standard"` unless it is rewritten,
and the one-off update does not rewrite rows. Every reader, and the Cerbos
rule of D3, therefore treat an **absent** `accountKind` as `standard`. The
default `Staged` for `status` applies to an entity written without a status.

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

| Event                 | From                          | To         |
| --------------------- | ----------------------------- | ---------- |
| `created_staged`      | none                          | `Staged`   |
| `created_invited`     | none, `Staged`, `Invited`     | `Invited`  |
| `created_active`      | none                          | `Active`   |
| `invitation_accepted` | `Invited`, `Staged`           | `Active`   |
| `first_sign_in`       | `Staged`, `Invited`           | `Active`   |
| `admin_disable`       | `Staged`, `Invited`, `Active` | `Disabled` |
| `admin_enable`        | `Disabled`                    | `Active`   |

So a `Disabled` user is never revived by a sign-in, by accepting a pending
invitation, or by a hook (multi-stage misuse found by the VCDM pre-assessment,
B4), and `Active` never goes back to `Invited` or `Staged`.

The status writers that exist in `002` bypass any such rule today:
`afterAddMember` writes `Active` (`packages/auth/src/auth.ts`), the ban hook
writes `Active`/`Disabled`, `identity.users.create` writes `Active` directly,
and so does the bootstrap script (`bootstrap-admin.ts`), all through
`UserSyncPort`, whose `UserSyncInput.status` is `'Active' | 'Disabled'`. Per
Resolved decision Q11 all of them, and the new sign-in hook for
`first_sign_in`, go through `nextStatus` via an event: `created_active` for an
admin-created user and for the bootstrap admin, `invitation_accepted` for the
first membership of an accepted invitation, `admin_disable`/`admin_enable` for
the ban hook. `UserSyncInput` therefore carries a `StatusEvent`, not a status,
and gains an optional `onBehalfOf`, because the sync's own actor is fixed today
and Resolved decision Q10 attributes an admin-initiated `_user` write to the
admin. Admin-created users start `Active`; `Staged` is the default only for an
entity created without a status.

`createUserSync` lives in `@tayzu/catalog`, which cannot import `@tayzu/auth`
(where `nextStatus` is), and today nothing in `apps/api` builds it:
`createApp` passes no `userSync` to `createAuth`, so the hooks above are no-ops
in the running app, and the bootstrap script's `main()` calls
`bootstrapAdmin(auth, params)` without one, so no `_user` is written (`002` left
this as a follow-up). The Q30 adapter in `apps/api` therefore implements
`UserSyncPort`: it reads the current status, calls `nextStatus` and writes the
result through `createUserSync`. `createApp` and the bootstrap script's `main()`
both build it and pass it in.

The ban hook (`auth.ts`) fires on **every** `user.update` that carries a
boolean `banned`, for example `/two-factor/enable`. With the state machine, a
write of `admin_enable` for an `Active` user would throw and break MFA
enrolment, so the hook compares `banned` before and after and writes an event
only when the value changed. It is skipped without an endpoint context, which
is the case for the internal-adapter call of D13, so it stays as the safety
net for any other path that flips `banned`.

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

| Resource kind     | Actions                                                  |
| ----------------- | -------------------------------------------------------- |
| `user` (existing) | `invite` (also covers cancel and resend), `updateStatus` |
| `service_account` | `create`, `delete`                                       |
| `credential`      | `list`, `create`, `rotate`, `revoke`                     |
| `organization`    | `delete`                                                 |

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
- **`R.id` is the Better Auth user id for a human** (the `_user` entity's
  opaque id for a service account), never the email: the `{user}` path carries
  an email, and a self-deny compared with an email would be vacuous against
  `P.id`. The resolved target supplies the id. The same rule keeps emails out
  of Cerbos's decision logs (`decisionLogsEnabled: true`): only opaque ids are
  ever sent as a resource id.
- Each **new** resource policy (`service_account.yaml`, `credential.yaml`,
  `organization.yaml`) carries the explicit cross-tenant `EFFECT_DENY` that
  `002` D8 requires in every resource policy (as `user.yaml` has), in addition
  to importing `002` D7's `same_tenant` derived role. `same_tenant` alone is
  vacuous for catalog operations (`002`'s Known residual risks): it protects
  only if the caller passes the **target's real tenant** as the resource
  tenant. The identity router therefore resolves the target on the server
  (D14) and passes its real tenant (an invitation's `organizationId`, an API
  key's `referenceId`, the user's membership), together with `accountKind`,
  `portRole` and `moderatedBlueprints` as resource attributes. This is the
  attribute contract. `002`'s `assertMayOnUser` accepts only
  `'create' | 'update'` and sends no attributes (`apps/api/src/identity-router.ts`)
  and is called by hand in each handler, so this change replaces it with the
  mandatory wrapper of D10 (Resolved decision Q45), which carries the new actions
  and the attributes.
- **Service-account ceiling** (Resolved decisions Q7, Q16): a rule on `user`
  denies any action when `R.attr.accountKind == "service"` and
  (`R.attr.portRole != "member"` or `R.attr.moderatedBlueprints` is
  non-empty), where the attributes are the **resulting** values. `002` D7's
  `strictEvaluation: true` turns a CEL error into a deny of the whole action,
  and today's callers send attributes with none of these keys, so every
  attribute reference is guarded with `has()` (the precedent in
  `catalog_entity.yaml`); an absent `accountKind` is `standard` (D1) and the
  rule does not fire. The rule is a defensive layer independent of the input
  validation in `identity.serviceAccounts.create` (D6): no operation in this
  change edits a role or `moderatedBlueprints`, so the rule is proven at the
  policy level (`user_test.yaml`) and by a `system`-actor test, not by a new
  operation.

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
`cancelPendingInvitationsOnReInvite: true` makes re-inviting a single call. The
plugin's default `invitationLimit` of 100 pending invitations per organization
is kept and stated here. Better Auth's own errors
(`USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION`, and the limit, which answers
FORBIDDEN `INVITATION_LIMIT_REACHED`) never reach the response as they are: they
map to `CATALOG_VALIDATION_FAILED` with no provider text, so the response does
not leak membership.

**Reaching Better Auth (Resolved decision Q42).** `/organization/invite-member`
requires a real session (`requireHeaders` and `orgSessionMiddleware`) and, unlike
`createApiKey`, has no `body.userId` bypass. The router context carries no
headers today (the server hands them over only as `__stepUpHeaders`), so the
server also puts the request's headers in the context, and `identity.users.invite`
forwards the admin's session headers into `auth.api.createInvitation`. The
re-invite cancel, the 100-invitation limit and `afterCreateInvitation` stay Better
Auth's, and tests mint a real session. Better Auth re-checks the session member's
role (`invitation:create`), which the access-control roles of D8 grant `admin`.
The other session-bound invitation call, cancel, uses the same forwarded headers.

**Roles (Resolved decisions Q9, Q19).** `identity.users.invite` accepts only the
organization roles `member` or `admin`, never `owner` (Better Auth's
`inviteMember` accepts any role and `afterAddMember` maps owner/admin to the
Cerbos `admin` role, so an unconstrained role is a privilege escalation).
Anything else is `CATALOG_VALIDATION_FAILED`. The role is parsed as exactly one of
those two strings: `inviteMember` accepts comma-separated strings and arrays and
the Cerbos role mapper splits them, so `member,owner`, `['owner']`, `Admin` and
`owner` are all rejected. The role is an attribute of
`catalog.audit.invitation_created`. `invite` is `x-tayzu-risk: high` for every
role (Q19), so every invitation requires a fresh step-up (D10).

**Email form (Resolved decision Q33).** One canonical form of the address (NFC,
trimmed, lower-cased) is the `_user` identifier, the Better Auth user email,
the invitation email and, hashed, the per-recipient cap key. The entity
identifier pattern (`ENTITY_IDENTIFIER_PATTERN`, `001`) cannot hold every valid
email, and an address with `/` cannot be a `{user}` path segment (D10). `invite`
and `identity.users.create` therefore reject, with
`CATALOG_VALIDATION_FAILED`, any address the pattern cannot hold or that
contains `/`, and the limitation is documented (no `001` change). This also
excludes `+` aliases, so the per-recipient cap below cannot be bypassed with
plus-addressing.

**Hooks.** `afterCreateInvitation` → `_user.status = Invited` through
`created_invited` (creating the `_user` entity first if the email has none yet;
an existing `Disabled` user cannot be invited). `afterAcceptInvitation` is
**not** used for status: acceptance is the in-process flow below, and it
writes through `invitation_accepted`. Rejecting or cancelling an invitation
does not touch `_user.status`.

**Acceptance (Resolved decisions Q8, Q18, Q24).** Sign-up is disabled (`002`
Q16), no email-verification flow exists, `resolveContext` rejects any session
without an active organization the user is a member of, and Better Auth's
native `/organization/accept-invitation` is off `002`'s D18 allowlist and stays
off. An invitee therefore cannot use any `/v1/*` route, so acceptance is a
dedicated **public, rate-limited route outside the tenant-context pipeline**,
`POST /v1/auth/invitations/accept`. It is a **plain Fastify route**, registered
before the `/v1/*` catch-all exactly like `002`'s token-exchange route
(`app.post(TOKEN_EXCHANGE_PATH)`): the catch-all runs `resolveContext` first and
answers 401 to any unauthenticated call, so an oRPC procedure could never be
public. It is therefore absent from the OpenAPI document and from the
`contract:check` input, is covered by a route-table test (D15) and
`attack-surfaces.md` instead, and its HTTP tests use the real server, not
`createRouterClient`; the service function behind it (in `apps/api`, Q30) is
tested in process. Its body carries the invitation id, the token and, for a
new account, the password; **nothing identifying travels in the path or
query**. The body is an allowlist of exactly those fields: any other field
(`role`, `email`, `organizationId`, `userId`, `tenantId`, `actor`) rejects the
request with `CATALOG_VALIDATION_FAILED`, a shape check that reveals nothing about
any invitation. The invitation id is checked for shape and length before any
lookup or logging; one that fails the check is logged as a constant, never as the
value, because this route is public and the value is attacker-controlled.

1. _Token._ Issued at invite/resend: 256 bits from a CSPRNG, shown only in the
   email link. Only `sha256(token)` is stored, in the `auth.verification`
   table `002` already reuses for `jti` replay state (identifier
   `invitation-accept:<invitationId>`, `expiresAt` equal to the invitation's),
   so there is no new table. It is compared in constant time
   (`timingSafeEqual` over equal-length digests). The order is: verify the token
   **without consuming it**, check the password policy (new-account path), then
   consume it with one atomic delete **conditioned on the digest**, so a bad
   password with a valid token does not consume it and exactly one of two
   concurrent attempts succeeds. The consumption and the creation of the
   `auth` rows share one `tayzu_auth` transaction, so a failed creation does not
   burn the token. Resend issues a **new** token (the old one stops working)
   with the **same** expiry: the plaintext is not stored, so the same link
   cannot be re-sent.
2. _Tenant._ Derived on the server from the invitation record's
   `organizationId`. The body has no tenant field and a body that carries
   one is rejected. The route never reads `tenantId` or `actor` from input. An
   invitation of a tenant with a deletion marker (D9) is rejected like any other
   dead invitation.
3. _New account._ For an invited email with no Better Auth user, the flow
   creates the user (global role `user`, never an admin role), sets the password
   the invitee supplied under the password policy (Q22, Q23), marks the
   email verified (the token is proof of mailbox control, so no
   email-verification flow is needed), adds the membership with the invited
   role, writes `_user.status` through `invitation_accepted`, and **creates no
   session**; the invitee then signs in through the normal route, and MFA
   enrollment follows `002` Q43 (an invited `admin` is therefore blocked by the
   admin MFA gate on every `/v1` call until they enrol). The acceptance **never
   links** an account by the email claim from Visma Connect (`002` D24, Q18):
   linking stays `sub`-keyed through `/link-social`, with step-up. An invitee who
   will only ever use Visma Connect is unsupported until `025` (`002` Q72): they
   need a local password first (Risks).
4. _Existing account (Q18, Q24)._ For an email that already has an account,
   acceptance **never sets or changes the password** (an account takeover
   vector). It succeeds only when **all** of these hold, checked in this order:
   (a) the request carries a valid session cookie, read with Better Auth's
   `getSession` on the request headers (the only public route that reads one),
   and that session passes the idle-timeout and banned checks that
   `resolveContext` applies (this route bypasses `resolveContext`, so it applies
   them itself); (b) the request carries the CSRF custom header and an `Origin`
   header that is present and matches `ALLOWED_ORIGINS`. `/v1` has only the CSRF
   custom header, CORS preflight and SameSite=Lax, and Better Auth's origin
   check covers only `/api/auth/*`, so this route performs its own check, and a
   failure answers the uniform rejection below, not a plugin 403; (c) the
   session user's email equals the invitation email (Resolved decision Q38: there
   is **no** verified-email condition, because `email_verified` defaults to false
   and nothing in `002` sets it, so the condition would fail for every existing
   account; the session proves control of the account and the token proves the
   mailbox); (d) the token verifies; (e) when the invited role is `admin`, a fresh
   step-up verification exists (the same guard `002` uses in
   `packages/auth/src/step-up.ts`, answering `AUTH_STEP_UP_REQUIRED`), evaluated
   only after (a)-(d), so it reveals nothing to a caller without a valid token.
   The guard alone only rejects, so for a session that carries an `ssoSid` the
   route also calls `reauthorization.lookup` and `reauthorization.start` exactly
   as the OpenAPI interceptor does (`server.ts`), or an SSO-established admin
   could never complete it.
   It then adds only the membership with the invited role, activates the `_user`
   through `invitation_accepted` and sets `emailVerified` on the user (Q38: the
   token proves the mailbox). It never touches the password, the session, the
   active organization or any linked account, and a `password` field in the body
   is ignored on this path. Success has the same status and
   body shape on both paths, and every failure of (a)-(d) answers the uniform
   rejection below, so a caller without a valid token learns nothing about
   whether an account exists. A caller who holds a valid token holds the
   mailbox, and that is the accepted extent of what the response can reveal.
5. _Errors._ Every rejected acceptance (nonexistent invitation, wrong state —
   expired, cancelled, rejected, already accepted — wrong token, a `Disabled`
   user, a tenant pending deletion, no session or a mismatched session for an
   existing account, a lost concurrent account creation) returns the same
   status, error code (`CATALOG_NOT_FOUND`) and body shape. Two invitations of
   two tenants for the same new email accepted concurrently create one user; the
   loser's `auth` transaction rolls back and it answers the uniform rejection. A
   missing invitation still runs a dummy digest comparison so timing does not
   separate it from a wrong token. The reason is only in the
   `catalog.security.invitation_acceptance_denied` event. A password that fails
   the policy is reported only after the token has verified, so it reveals
   nothing to a caller who does not hold a valid token. The denial reasons
   include `csrf_rejected` and `origin_rejected`.
6. _Admin notice (Resolved decision Q39)._ A new-account `admin` invitation is
   protected only by mailbox control at acceptance (a mistyped or hijacked
   address would yield a tenant admin who then enrols their own factor), a
   residual that is accepted. So when an invitation whose role is `admin` is
   accepted, on either path, the fixed `AdminAcceptedNotice` (D5) is sent to every
   other administrator of the organization, resolved on the server. A send
   failure never blocks the acceptance and is logged as
   `catalog.security.admin_notice_failed`.

**Invitation email caps (Resolved decision Q15).** `identity.users.invite` and
`identity.users.resendInvitation` share: **30 per hour per tenant**, **3 per 24
hours per recipient across all tenants** (keyed by the sha256 of the canonical
email, never the address), and a **global kill switch**
(`INVITATION_EMAIL_KILL_SWITCH`, an environment variable). Exceeding any of them
fails with `AUTH_RATE_LIMITED` (429), sends nothing, and emits
`catalog.security.invitation_rate_limited` with a bounded `limit_scope`
(`tenant`|`recipient`|`global`). `002` requires a `Retry-After` header on every
limiter, and `ORPCError` carries no header (the token limiter sets it by hand),
so a package-local `AuthRateLimitedError` carries `retryAfterSeconds` and the
error mapping sets the header; the accept route sets it by hand like token
exchange. The buckets are service-level counters on a store interface (the key
needs the resolved tenant and the body's recipient, which a path-keyed
preHandler does not have). Defaults are enabled in code, live in
`apps/api/src/config.ts` following its `limitWithDefaults` positive-integer
pattern, and a disabled or zero value fails startup (`002` Q39). The store is in
memory in tests. In production the caps **and** the accept route's limiter use
`002`'s DB-backed atomic store (`auth.rate_limit`, hashed keys), which is shared
across replicas and needs **no migration**. The accept route's limiter is a
Fastify `preHandler` that consumes a bucket of that store (scope
`invitation_accept`), not the in-memory `createRateLimit` of the other routes,
whose per-replica budgets are the M13 problem. `consumeRateLimitBucket` is not
exported today and is tied to the Better Auth plugin's rule table
(`pre-auth-rate-limit.ts`), so this change exports a scope-generic helper from
`@tayzu/auth` and adds rules for the new scopes. The closed `RateLimitScope`
union gains `invitation_accept`, `invitation_tenant` and `invitation_recipient`;
neither telemetry contract enumerates scope values, so only the TypeScript union
changes. A per-replica bucket would not enforce a per-recipient cap, which is why
the shared store is not optional.

Two properties of the per-recipient cap are accepted and documented in
`docs/security/data-retention.md`: one tenant can exhaust the cap for a victim
address and so block other tenants' legitimate invitations (a denial of
invitation, and a weak oracle, see Risks), and the kill switch is an
environment variable, so flipping it needs a new revision of the app; the
emergency procedure is in `docs/security/secrets.md`.

**Resend.** `identity.users.resendInvitation` does **not** call Better Auth's
`inviteMember` with `resend: true`, because that resets `expiresAt` to now + 48
hours. It replaces the token digest in `auth.verification` for the same
invitation, keeps its `expiresAt`, and sends the email.

- _Alternative:_ model Tayzu's own invitation record instead of Better Auth's.
  Rejected: duplicates a state machine Better Auth already implements
  correctly (expiry, single-pending-per-email via re-invite cancellation).
- _Alternative:_ allowlist the native accept route (reopens the gap D18 closed),
  or only accept for users who already have an account (makes invitations
  nearly useless). Rejected by Resolved decision Q8.
- _Alternative:_ refuse an invitation to any email that already has an account,
  or accept an existing account with the token alone. Rejected by Resolved
  decisions Q18 and Q24: the first reverses Q18 and gives an "email exists"
  oracle, the second lets mailbox control alone grant a role to someone else's
  account.

### D5. Email: an `EmailSender` port, Azure Communication Services adapter

Better Auth's `sendInvitationEmail` callback has no default transport — Tayzu
must implement one. `packages/auth/src/identity/email/sender.ts` defines a
small port, `interface EmailSender { send(to: string, template: EmailTemplate):
Promise<void> }`, so the concrete provider is swappable. `EmailTemplate` is a
closed union of three fixed templates, `InvitationEmail`, `OrgDeletionNotice`
and `AdminAcceptedNotice`.
`azure-communication-email.ts` implements it over `@azure/communication-email`
(`1.1.0`, verified via `npm view`, 2026-09-28), consistent with the Azure-first
stack and the Key Vault-backed secrets pattern `002` establishes.

**Authentication to ACS (Resolved decision Q28).** v1 uses the connection
string, stored in Key Vault, on a **dedicated send-only ACS resource**
restricted to the sender domain, with its rotation documented in
`docs/security/secrets.md`. Migrating to a managed identity is a
**first-deployment gate** (Gates), not a ticket: a leaked connection string
would let its holder send mail from the verified sender domain.

The invitation email's content is a fixed contract (VCDM B9, SEC11):

- **Exactly one recipient**: the port takes one address, validated to be a
  single plain address (no CR/LF, no display name, no list separators, at most
  254 characters), and has no CC, BCC or attachment field, so none can be set.
- **Fixed subject and fixed template.** Only two values are interpolated: the
  link and the 48-hour expiry text. The organization name, the inviter's name
  and any other tenant or inviter free text are **never** interpolated, so
  they cannot carry a phishing message or markup.
- **Link origin from trusted configuration** (Resolved decision Q32): a
  dedicated setting, `INVITATION_LINK_BASE_URL`, that must be `https` outside
  test and must be one of `ALLOWED_ORIGINS` (`apps/api/src/config.ts`), never
  `BETTER_AUTH_URL` (the API origin, which renders nothing for a person) and
  never the request `Host` or any forwarded header. The path is fixed
  (`/accept-invitation`), and the invitation id and token travel in the URL
  fragment (`#invitation=<id>&token=<token>`), so neither reaches a server log
  or an access log. Nothing renders that page until `003` builds it, so the link
  is **inert** until then; that is documented in `docs/security/attack-surfaces.md`
  and the first-deployment gates.
- Exactly one clickable link.
- **Provider and page hygiene** (SEC11): the adapter disables ACS user-engagement
  and click tracking (a tracked link would be rewritten and would leak the
  fragment token) and sets no Reply-To, and the sender domain's DMARC is aligned
  (a first-deployment gate). The accept page that `003` builds must strip the
  fragment after reading it, send `Referrer-Policy: no-referrer` and load no
  third-party script; these are preconditions of the mount gate (Gates).
- A real provider is required outside test: startup fails in production
  without one, and CI and DAST wire a non-sending `EmailSender`.

The **org-deletion notice** (D9, Resolved decision Q27) is the second fixed
template: a fixed subject and body whose only interpolated value is the purge
date, with **no link** and no tenant or actor free text. It is sent as one
email per recipient to every administrator of the organization, resolved on the
server from the tenant's memberships, once per deletion request (a repeated
request while pending sends nothing). A send failure never blocks the request
(access has already been revoked) and is logged as
`catalog.security.org_deletion_notice_failed`.

The **admin-accepted notice** (Resolved decision Q39, D4 step 6) is the third
fixed template: a fixed subject and body with **no link, no interpolated value**
and no tenant or actor free text, sent as one email per recipient to every other
administrator of the organization when an `admin`-role invitation is accepted.

SEC11 answers recorded for the SSA (Resolved decision Q34): the platform sends
only these three fixed templates; the one clickable link is the invitation-accept
link, which is unavoidable for a no-account invitee and is mitigated by the
fragment token, single use, 48-hour expiry and the configured origin; only the
recipient address varies; there are no attachments.

- _Alternative:_ a generic SMTP client. Rejected: another credential shape
  (SMTP username/password) to manage in Key Vault for no benefit over a
  managed Azure service already in the stack's cloud. A managed identity for
  the provider needs `@azure/identity`, an unplanned dependency, so it is a
  first-deployment gate with its own design amendment (Resolved decision Q28).

### D6. Service accounts: `_user` sub-kind + org-owned machine credential — ADR-0017

A service account is a `_user` entity with `accountKind: "service"`, created
through one orchestrated operation (in `apps/api`, Resolved decision Q30): (1)
create the `_user` entity with `status: Active` (no invitation), role `member`
and an empty `moderatedBlueprints`, written as the `system` actor with
`onBehalfOf` set to the admin (Resolved decision Q10); (2) issue an
organization-owned Better Auth API key by reusing `002`'s single
`machine-credential` apiKey config (`references: "organization"`,
`defaultPrefix: "tayzu_mc_"`), headerless with `body.userId` the acting admin's
Better Auth user id (D8), with metadata
`{ actorKind: 'integration', role: 'member', userId }` — `role` stays `member`
because token exchange rejects any credential without it, and `userId` is the
`_user` entity's opaque id; (3) return `{ user, clientId, clientSecret }` once.
Service-account identifiers follow `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$` (not an
email-shaped string), ADR-0017.

**The principal of a service account is never read from its `_user`
(Resolved decision Q12).** `002` Q28 fixes every machine principal as
`{ roles: ['member'], teams: [], moderatedBlueprints: [] }`, built from the
signed token claim, and `002` treats that context contract as frozen. A
service account has no Better Auth user or member row, and `CLAUDE.md` bans
`actor.type` branches outside three files, so this change adds **no**
entity-sourced role, team or Moderator plumbing to `packages/authz`. `userId`
is added to the token only as an attribution claim (who the credential is
bound to), never as a source of authority: it is added where
`token-exchange.ts` builds the signed payload, and the payload parser in
`context-resolver.ts` ignores extra claims, so adding it is safe.
`exchangeMachineToken(auth, params)` takes no database pool today, and the
checks of D13 need the `_user` and deletion-marker lookups, so its signature
gains those ports. A tampered `_user` row therefore cannot raise a service
account above `member`.

**Ceiling (Resolved decisions Q7, Q16).** A service account holds `member`
and an empty `moderatedBlueprints`, always: `002`'s step-up gate exempts
`agent`/`integration`/`system` actors by design, so an elevated role bound to
a leaked secret would carry that power forever with no MFA layer. It is
enforced at creation (input validation rejects anything else before the
`_user` or the credential exists) and independently by the Cerbos rule in D3;
there is no operation that edits a role, so no update path exists to guard.

**One active credential per service account (Resolved decision Q40).** A service
account holds exactly one active credential. `identity.credentials.create` takes
an optional `userId`, which is resolved server-side to a service-account `_user`
of the caller's tenant (anything else is `CATALOG_NOT_FOUND`, D14) and is refused
when that service account already has an active credential. A revoked credential
may be rotated only when its service account has no active credential, and
rotation is serialized per service account (D8). The invariant is also enforced
on the request path: the resolver and token exchange reject a token whose
`userId` claim is present but whose bound `_user` is absent or not `Active`
(D13), so a surviving credential of a deleted or tampered service account cannot
resolve as a `member` of the tenant.

**Operations.** Disable and re-enable are `identity.users.setStatus` on the
service account's `_user` identifier (D9, D13); a service account has no Better
Auth user, so `setStatus` writes only `_user.status` and the resolver check of
D13 enforces it. Deletion is `identity.serviceAccounts.delete`: a plain
`entities.delete` on `_user` is denied by the reserved-prefix rule, so an
explicit operation revokes **every** non-revoked credential bound to the service
account (every `apikey` with `referenceId = ctx.tenantId` and `metadata.userId`
equal to the `_user` id, through the revocation list, permanent) and then removes
the `_user` entity as `system` with `onBehalfOf` the admin.

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

Better Auth's `listApiKeys` and `getApiKey` are bound to a session and have no
server-side `userId`, so the listing is an **adapter-level read** of the `apikey`
table (through the `tayzu_auth` pool), filtered to the caller's tenant
(`referenceId = ctx.tenantId`) and to the `machine-credential` `configId`, with a
bounded limit, and joined in the service layer to the `_user` entity via each
key's `metadata.userId` for service-account credentials. The kind is
`service_account` (a key bound to a service account), `agent` or `integration`
(keys without a `_user`, by their `actorKind`). The prefix (`key.prefix`), `enabled`,
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

`createMachineCredential` and `revokeMachineCredential`
(`packages/auth/src/machine-credentials.ts`) are library functions today: they
are not exported from the package index and no non-test code calls them, and
`002` registers **no** machine-credential routes. `identity.credentials.*` and
`identity.serviceAccounts.*` are their first callers, and there is no separate
machine-credential route to guard (D15).

**Org keys by an admin who is not the owner (Resolved decision Q29).** The
functions currently forward the caller's session `headers`, which makes Better
Auth run `checkOrgApiKeyPermission`, and by default only the organization
`owner` holds `apiKey` permissions: an admin allowed by Cerbos would be refused
by Better Auth, a second authorization path. So the `organization` plugin's
static access control grants the `admin` role `apiKey` create, read, update and
delete, and the calls are made **headerless** with `body.userId`, so Better
Auth always passes and Cerbos stays the real gate (and its tests use an
`admin` member, not only the `owner`, D11). Three details make this work:

- `body.userId` must be the **acting admin's Better Auth user id** (a member of
  the organization with `apiKey` rights), not the `_user` id that goes in
  `metadata.userId`.
- `organization()` has no `ac` or `roles` today, and custom roles **replace** the
  defaults, so the change defines all three roles (`owner`, `admin`, `member`)
  from the default statements, adding `apiKey` to `admin` only, and keeps every
  default permission, including the `invitation` ones that Better Auth re-checks
  for the session member (D4).
- `getApiKey` and `listApiKeys` are session-bound (the headerless approach works
  only for create and update). Rotate and revoke read the key through an
  adapter-level lookup filtered by `referenceId` and `configId`, and the
  `getApiKey` call with headers in `machine-credentials.ts` is replaced by it.

A credential that belongs to another tenant is reported as `CATALOG_NOT_FOUND`
(D14): the helper's `AuthContextError` for a foreign credential is mapped to it.

- **Create** (`identity.credentials.create`, integration/agent credentials; a
  service account's first credential comes from D6, and binding a new credential
  to a service account follows Q40, D6): the per-key rate limit and the
  stored-secret-characters setting are **plugin-level configuration** of the `machine-credential` apiKey config (`rateLimit`,
  `startingCharactersConfig`: no first characters of the secret are stored),
  because `createApiKey` rejects per-key `rateLimit*` properties whenever it is
  given `headers` or a request (`SERVER_ONLY_PROPERTY`), which is why the call
  is headerless. Better Auth's default is 10 verifications per 24 hours; Resolved
  decision Q44 sets **60 verifications per hour per key**, configurable in
  `apps/api/src/config.ts` (`limitWithDefaults`; a disabled or zero value fails
  startup), because an integration needs about one exchange per hour and the IP
  bucket and 1-hour tokens bound the rest. The key has no hard expiry (Resolved
  decision Q20).
- **Rotate**: create the new key, then revoke the old one, then return the new
  secret once. If the revoke fails, the new key is revoked as compensation so no
  second usable credential survives; if compensation also fails,
  `catalog.security.credential_rotation_incomplete` is emitted. Rotation is
  **serialized** per service account (per credential for an unbound integration
  or agent credential), for example by a Postgres advisory lock held for the whole
  rotation: two concurrent rotations would otherwise each create a key and each
  revoke the old one, leaving two active credentials. The second one finds the old
  credential revoked and an active one present, and fails with
  `CATALOG_VALIDATION_FAILED`. A revoked credential may be rotated only when its
  service account has no active credential (Resolved decision Q40).
- **Revoke**: permanent; already-issued tokens are rejected within seconds
  because `resolveContext` consults the revocation list through a cache of at
  most 5 seconds, failing closed (`002` D21). The revocation lookup and its
  cache are keyed by `(tenantId, credentialId)` (D13, tasks 11.1 and 11.1b), not
  by the credential id alone.
- `rotatedAt`/`rotationDueAt` live in the new key's `metadata`; the viewer (D7)
  computes "rotation due" against a Tayzu-chosen default interval (90 days,
  configurable, in `docs/security/data-retention.md`). It is a documented
  policy default, not a hard-enforced expiry: no credential is force-disabled
  solely for being overdue (Resolved decision Q20).
- Because the revocation row is a permanent insert, "disable then re-enable" is
  not a credential operation. Pausing a service account is `setStatus`
  (D13), which is reversible; restoring a revoked credential is "rotate".

- _Alternative:_ a grace-period window (old key stays valid for N hours).
  Rejected for v1: real orchestration complexity for a benefit no Phase-1
  integration needs yet. Recorded as a Risk, not built.
- _Alternative (Q29):_ call Better Auth with an owner's `userId`, which silently
  elevates privilege, or write the `apikey` row directly, which reimplements key
  generation and hashing. Both rejected.

### D9. Org deletion is two-phase: revoke now, purge later — ADR-0019

Decision (Resolved decisions Q14, Q21, Q26, Q27), rewriting the earlier
synchronous design, which could not work as written: `catalog_change_event` is
append-only (a trigger rejects DELETE for every role, owner included, and
`tayzu_app` has no DELETE or TRUNCATE), `machine_credential_revocation` has no
DELETE grant, catalog tables run on `tayzu_app` and Better Auth tables on
`tayzu_auth` (two roles and pools cannot share a transaction), `apikey` has no
FK to the organization, and several catalog FKs are `RESTRICT`. The catalog
tables are also `FORCE ROW LEVEL SECURITY` with policies `TO tayzu_app`, so a
function owned by `tayzu_migrator` (no policy, no `BYPASSRLS`, `002` D6) would
see zero rows: it cannot be the purge mechanism. Resolved decision Q26 therefore supersedes the `tayzu_migrator` owner that Q14 named.

**Phase 1, request** (`identity.organization.delete`): Cerbos `organization.delete`
with the real tenant (any `admin` may request it, Resolved decision Q27),
step-up, and an explicit confirmation: the caller sends the organization's
identifier, and it must equal the **host** `ctx.tenantId` (never a value looked
up from input). The operation inserts a **deletion marker** for the tenant
(`tenant_deletion_marker`, migrations `0012` and `0013`, Checkpoint 3), revokes
every session whose active organization is the tenant, revokes every org-owned
credential (revocation list), cancels pending invitations, sends the
org-deletion notice to every administrator of the organization (D5), and emits
`catalog.audit.org_deletion_requested`. From that moment `resolveContext` and
token exchange reject every principal of the tenant, human or machine (D13), and
an invitation of the tenant is no longer acceptable (D4). The window is between 7
and 14 days (configurable, validated at startup; the default is 14, Resolved
decision Q21). Requesting it again while pending changes nothing and returns the
original date.

**The marker is a trust boundary** (Resolved decision Q26): a "due" check is
worthless if the role that serves requests can write the marker. So:

- The marker is **insert-only for `tayzu_app`**: it can insert the tenant's own
  row (RLS) and read it, and it has no UPDATE or DELETE. `requested_at` is set
  by the database (`DEFAULT now()`, not an input), and a `CHECK` constrains
  `purge_after` to between `requested_at + 7 days` and `requested_at + 14 days`,
  so a request-path compromise cannot insert a past-dated marker. One pending
  marker per tenant is a partial unique index. A marker has a `state`
  (`pending`, `cancelled`, `purged`), the timestamps of the two purge steps and
  `requested_by` (an opaque id).
- A dedicated role, **`tayzu_purge`**, created by migration `0013`, with its own
  pool and its own secret, is used **only** by the purge job. Only it can update
  the marker's progress, and only it can execute the purge function. `PUBLIC` has
  no `EXECUTE` on either function.
- `tayzu_purge` has DELETE on the tenant's tables, **named one by one** (not by a
  prefix): `catalog_blueprint`, `catalog_relation_definition`, `catalog_entity`,
  `catalog_entity_relation`, `catalog_change_event`, `catalog_tenant_sequence` and
  `machine_credential_revocation` (which has no `catalog_` prefix), each with its
  own policy limited to tenants **with a due marker** (`state = 'pending'` and
  `purge_after <= now()`), so row-level security itself enforces "only due
  tenants" even for the owner (FORCE).
- The append-only trigger on `catalog_change_event` (migration `0001`) is amended
  to allow DELETE **only when `current_user` is `tayzu_purge`**, tested as the
  function owner's identity, not a settable flag (a GUC would be spoofable). Every
  other path, including the table owner and `tayzu_app`, still raises.
- The purge function is `SECURITY DEFINER` with a fixed `search_path`,
  schema-qualified names and no dynamic SQL, and it deletes the append-only rows
  (`catalog_change_event` and the tenant's `machine_credential_revocation` rows)
  **only** for a tenant whose marker is due. A second `SECURITY DEFINER`
  function, the **lister**, returns the tenants with a due pending marker, so the
  job enumerates them across tenants without any blanket read of the marker
  table.

**Phase 2, purge** (a scheduled job; an Azure Container Apps Job provisioned
with `010`, with its entry point a `tsx` script in this change,
`apps/api/scripts/purge-job.ts` (`pnpm --filter @tayzu/api identity:purge`), no
HTTP listener). It must refuse to run as another role, and the existing
`assertRuntimeRole` of `apps/api/src/bootstrap.ts` cannot do that: it is private
and checks only superuser, `BYPASSRLS` and table ownership, so `tayzu_app` would
pass it. The job therefore adds a new check, `current_user = 'tayzu_purge'`. For
each tenant the lister returns, in
two idempotent steps with safe resume (progress is recorded on the marker):

1. **Catalog data** (`tayzu_purge`): ordered deletes of relations, entities,
   blueprints and the other `catalog_*` rows (the order respects the `RESTRICT`
   FKs), and the append-only rows through the purge function.
2. **Better Auth data** (`tayzu_auth`): the org's invitations, API keys
   (`referenceId`), invitation tokens in `auth.verification`, members, then
   each user who has no remaining membership in any other org together with
   that user's `account`, `session` and `twoFactor` rows and the
   `auth.verification` rows keyed by that user (`temp-password:`,
   `step-up-verified:`; global user data is not per-org, so deleting only
   `member`/`invitation`/`apikey` would orphan it), and the organization row last.

The job therefore needs two connection secrets, `tayzu_purge` and `tayzu_auth`,
both documented with an owner and a rotation in `docs/security/secrets.md`.

A **completeness test** is driven by the schema, not by a list: it enumerates
every table that has a `tenant_id` column (catalog), every `auth` table that
references an organization or a user **by foreign key or by column name**
(`apikey.reference_id` has no foreign key) and the `auth.verification` rows by
identifier pattern (`invitation-accept:`, `temp-password:`,
`step-up-verified:`, which are keyed by string, not by foreign key), and fails
unless each is deleted by a purge step or explicitly exempted with a reason, so a
later change that adds a table cannot silently escape the purge.

`catalog.audit.org_deletion_completed` is emitted by the purge itself
immediately before the organization row is deleted, **not** from Better Auth's
`afterDeleteOrganization` hook (the installed plugin also has
`beforeDeleteOrganization`, and the `after` hook runs after the delete). A
failed step emits `catalog.security.org_deletion_failed` (with the step) and
the next run resumes. The marker stays as a tombstone (tenant id, state and
timestamps only) so a later request finds nothing to purge.

**Reversal** (Resolved decisions Q21, Q27) is the pending window plus one
audited operator action, not point-in-time restore: server-level PITR cannot
restore one tenant out of a shared-schema database, and there is no in-product
cancel. A platform operator runs a `tsx` script that **tombstones** the marker
(`state = 'cancelled'`, a timestamp; the row is never deleted) and emits
`catalog.audit.org_deletion_cancelled` with the operator's opaque id. After that
the tenant's principals are accepted again and a later request inserts a new
marker. The script runs as the dedicated `tayzu_deletion_admin` role of Resolved
decision Q35 (migration `0013`), which can only tombstone a pending marker. It is
started **only** through a manual `workflow_dispatch` GitHub Actions workflow
whose environment has required reviewers, which starts an Azure Container Apps
Job through OIDC (Resolved decision Q41), so the named second approver is
enforced technically and the operator identity is authenticated: the opaque
operator id is derived from the workflow's authenticated actor and handed to the
job by the workflow, never typed as an argument. The job runs inside the VNET, so
no one connects to the production database from a workstation. The same
workflow starts the one-off `_user` backfill of D1. The runbook in
`docs/security/data-retention.md` still requires just-in-time access (Azure PIM)
for any other operator access with a personal account, and records the **named
second approver** in the change record. Backups keep purged data until the backup retention expires; the
erasure statement in `docs/security/data-retention.md` says so, and also names
what a purge does not remove by itself: Cerbos decision logs, Azure Monitor
data, Azure Communication Services records and backups. A compromised admin
session with a fresh MFA can no longer destroy a tenant irreversibly in one call,
and every org administrator is told within the request that it happened.

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

### D10. API contract

**Fourteen oRPC procedures and one plain Fastify route** on the server `002`
exposes: fifteen routes, all mounted behind the switch of D15. Each oRPC
procedure declares `.route({ method, path, spec: markHighRisk })` like
`packages/catalog/src/api/contract.ts`, because step-up runs only in the OpenAPI
interceptor keyed on the route spec (calls through `createRouterClient` skip it).
The identity router lives in `apps/api` (`apps/api/src/identity-router.ts`, and
`createApp` mounts it beside the catalog router), because `@tayzu/auth` has no
`@orpc/server` or `@tayzu/catalog` dependency; `@tayzu/auth` holds the pure parts
and the structural ports (Resolved decision Q30).

| Procedure                                    | Route                                            | Notes                                                            |
| -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `identity.users.invite`                      | `POST /v1/users/invitations`                     | high-risk                                                        |
| `identity.users.cancelInvitation`            | `POST /v1/users/invitations/{invitation}/cancel` |                                                                  |
| `identity.users.resendInvitation`            | `POST /v1/users/invitations/{invitation}/resend` |                                                                  |
| acceptance (plain Fastify route)             | `POST /v1/auth/invitations/accept`               | public, outside the tenant pipeline; not in the OpenAPI document |
| `identity.users.setStatus`                   | `PUT /v1/users/{user}/status`                    | high-risk                                                        |
| `identity.users.create` (existing)           | `POST /v1/users`                                 | high-risk                                                        |
| `identity.users.linkSsoAccount` (existing)   | `POST /v1/users/{user}/sso-account`              | high-risk                                                        |
| `identity.users.unlinkSsoAccount` (existing) | `DELETE /v1/users/{user}/sso-account`            | high-risk                                                        |
| `identity.serviceAccounts.create`            | `POST /v1/service-accounts`                      | high-risk                                                        |
| `identity.serviceAccounts.delete`            | `DELETE /v1/service-accounts/{user}`             | high-risk                                                        |
| `identity.credentials.list`                  | `GET /v1/credentials`                            |                                                                  |
| `identity.credentials.create`                | `POST /v1/credentials`                           | high-risk                                                        |
| `identity.credentials.rotate`                | `POST /v1/credentials/{credential}/rotate`       | high-risk                                                        |
| `identity.credentials.revoke`                | `POST /v1/credentials/{credential}/revoke`       | high-risk                                                        |
| `identity.organization.delete`               | `DELETE /v1/organization`                        | high-risk                                                        |

**Mandatory authorization (Resolved decision Q45).** `002`'s `assertMayOnUser` is
called by hand in each handler, and nothing makes the call mandatory; fourteen
procedures with that pattern is the scattered-access-control risk the catalog
pipeline avoided by making the declaration type-mandatory. So every procedure of
the identity router is built with `defineIdentityOperation({ authorization: {
kind, action, resolveTarget }, handler })`. The wrapper resolves the target on the
server (D14), builds the Cerbos attributes (D3), calls Cerbos with the target's
real tenant and emits `catalog.security.authz_denied` on a deny. A test forbids a
bare handler in the identity router, and a route-table-driven HTTP matrix covers
each of the fourteen oRPC routes: the admin allowed, a member 403, a machine
`member` token 403, an unauthenticated call 401 and a foreign target 404. The
machine-token case matters because service-account and integration actors skip
step-up and had no denial test.

**OpenAPI document (Resolved decision Q43).** The identity router is a plain
`os.$context` router with no contract, and the only committed document,
`openapi/catalog.openapi.json`, comes from `catalogContract` (and DAST scans only
that file). So `apps/api` generates a second committed document,
`openapi/identity.openapi.json`, listing the fourteen oRPC routes (not the plain
accept route), with its own `contract:generate` and `contract:check` scripts as a
drift guard like the catalog's. The `x-tayzu-risk` assertions run on it. Extending
the DAST scan to it stays a first-deployment gate.

**`DELETE` routes.** `apps/api` uses `inputStructure: 'detailed'` so `DELETE` and
`GET` routes read the query string at runtime. `DELETE /v1/organization` carries
its confirmation in the query string (`?confirmation=<organization identifier>`,
compared to the host tenant, D9); `DELETE /v1/service-accounts/{user}` and
`DELETE /v1/users/{user}/sso-account` take their target from the path. A
confirmation sent only in a body does not count.

The three procedures marked "existing" are `002`'s (Resolved decision Q31). Today
they have no `method` or `path` (`create` has no `.route` at all) and take a
Better Auth `userId`; they get these routes so that their step-up is tested over
HTTP, and the paths above are this design's choice. On them `{user}` is the
`_user` identifier, resolved on the server to the Better Auth user (D14), like
every other target.

`{user}` is the `_user` entity identifier (an email, or `svc-…`), sent
unencoded because `@` is legal in a path segment (Resolved decision Q12); an
address containing `/` cannot be a path segment, so `invite` and `create` reject
it (D4), and a path containing `%` is a 404 (`002` Q74). Such identifiers must
never reach telemetry (D16). There is no role or Moderator editing procedure
(Resolved decision Q16), so there is nothing to mark for it.

High-risk set (`x-tayzu-risk: high`, VCDM B11): `setStatus`,
`serviceAccounts.create`, `serviceAccounts.delete`, `credentials.create`,
`credentials.rotate`, `credentials.revoke`, `organization.delete`, `invite` and
`identity.users.create` for every invited or created role (Resolved decision
Q19), and the existing SSO `linkSsoAccount` and `unlinkSsoAccount`. Deleting a
service account is in the set because it revokes a credential, the same class as
`credentials.revoke`. The plain accept route has no route spec, so its step-up
(only when the invited role is `admin`, D4) is an explicit call to the same
guard (and, for an SSO session, the re-authorization calls, D4), tested over HTTP.

**What step-up means over HTTP** (`002` Q43, Q51), because the tests must match:
the step-up marker records its **factor**, and a `password` marker satisfies the
guard only for a user with no enrolled second factor; a session that carries an
`ssoSid` delegates to a Visma Connect re-authorization instead of a local
verification; and the admin MFA gate answers `AUTH_STEP_UP_REQUIRED` to an admin
without an enrolled factor on **any** `/v1` call, so an invited admin is blocked
until they enrol. The tests therefore cover the local MFA case, the SSO case and
the unenrolled admin.

Error codes reuse `001` design D11's table and `002`'s: `AUTH_FORBIDDEN` (403),
`AUTH_STEP_UP_REQUIRED` (403, not 409), `AUTH_RATE_LIMITED` (429, with a
`Retry-After` header, D4),
`CATALOG_NOT_FOUND` (404), `CATALOG_VALIDATION_FAILED` (400). All are already
mapped in `apps/api/src/error-mapping.ts`. The change introduces no new code.

### D11. Testing strategy

Unit tests (the D2 state machine, the password policy, pure). Integration tests
against a real PostgreSQL 16 and a real Cerbos test container (`002`'s harness),
exercising the actual Better Auth instance (no mocked `organization`/`api-key`
plugin — invitation expiry and re-invite cancellation are verified against the
real library). The `EmailSender` port is faked (a recording fake asserting "one
call, one recipient, one link"), never calling the real Azure Communication
Services API, and the breached-password check runs with the global `fetch` stubbed
(the plugin hardcodes `api.pwnedpasswords.com`), never against the real service.
The invite tests mint a real session, because `invite` forwards it (D4). `cerbos compile` (with its bundled test
suites) gates every policy file. Step-up is tested **over HTTP only** (D10), and
so is the plain accept route (it is not an oRPC procedure). Every route has a
cross-tenant test (D14). Org-owned key tests use a Better Auth `admin` member,
not only `owner`: after Resolved decision Q29 Better Auth always passes and
Cerbos is the only gate, and the test proves an `admin` is allowed by it and a
`member` is denied. The authorization of every route is also proven over HTTP by
the matrix of D10, so the wiring is tested and not only the policy.

### D12. Docs-as-Code and ADRs from this change

- `docs/adr/0017-service-account-identifier-convention.md` (D6)
- `docs/adr/0018-credential-rotation-immediate-cutover.md` (D8)
- `docs/adr/0019-org-deletion-two-phase-purge.md` (D9, including the purge role,
  the marker's integrity rules and the reversal control)
- `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md` (D3)

`002` claims 0013-0016 and 0021 is taken, so 0017-0020 are free. This change
also writes `docs/security/data-retention.md` (the purge window and the
erasure statement about backups, Cerbos decision logs, Azure Monitor and Azure
Communication Services records; the reversal runbook and its workflow; the credential rotation
cadence; the invitation caps, the cross-tenant denial-of-invitation trade-off
and ACS data location and retention; audit and security log retention of at
least 12 months, independent of tenant deletion, cross-referenced from
`010`/`015`), updates `docs/security/secrets.md` (the Communication Services
secret and its change procedure, the kill switch and its emergency flip, the
`tayzu_purge` and `tayzu_auth` secrets of the purge job with owner and
rotation, the OIDC federation and the environment reviewers of the maintenance workflow, the
credential lifecycle), `docs/security/attack-surfaces.md` (the
fifteen routes, the public accept route and its session binding, the inert link,
and the mount gate state; it currently lists `identity.*` as not mounted),
`docs/security/crypto-inventory.md` (the invitation token, the SHA-1 prefix sent
to the Pwned Passwords range query, the sha256 of the per-recipient cap key and
the authentication to ACS) and
`docs/security/dependencies.md` (license, `allowBuilds` and SBOM review of
`@azure/communication-email` and its transitives, the pinned image digests),
`docs/catalog/auth-and-rbac.md` (`002` D17: the resource-kind taxonomy and the
telemetry reference), and `docs/architecture/system-diagram.md` (new external
actors: the email provider, the invitee with their mailbox, the platform
operator; new arrows: invite → email, the public accept route, ACS egress over
HTTPS, the Pwned Passwords range query, the purge job with its two database
connections, the reversal script and the GitHub Actions workflow that starts it).

### D13. Disable, rotate, revoke and pending deletion take effect within seconds

Access tokens are stateless 1-hour JWTs, and `resolveContext`'s machine branch
checks neither the credential's `enabled` flag nor `_user.status`. Per Resolved
decisions Q13, Q11 and Q25, `resolveContext` and token exchange gain these
checks, all through the existing 5-second cache and **failing closed** on any
lookup failure:

- **A human is rejected when their Better Auth user is `banned` (task 14.4), or
  when their `_user.status` in the _active tenant_ is `Disabled`** (Resolved
  decision Q25; task 11.8). The status check is **new code**: `resolveContext`'s
  `_user` read (`readUserEntityGrants`) has no cache and does not select
  `status`, and on a lookup failure it returns a principal-less context instead of
  rejecting; only membership and the revocation list are cached today. Task 11.8
  adds the status read, a 5-second cache keyed by `(tenantId, userId)`, and a
  rejection when the lookup fails (fail closed). A member with **no** `_user` row
  is an Open Question. `setStatus` to `Disabled` writes `_user.status`
  through the state machine, revokes **only the sessions whose active
  organization is that tenant**, and cancels the user's pending invitations of
  that tenant; `Active` writes the status back. Only for a user with a **single**
  membership does it also set `banned` (and delete all their sessions), because
  a global ban would lock the user out of another tenant (a member of two tenants
  cannot otherwise be off-boarded by one tenant's admin, and removing a member is
  out of scope, Q16). The ban is made through the internal adapter
  (`internalAdapter.updateUser({ banned })` and `deleteUserSessions`, as
  `linkAccount` does in `identity-router.ts`), **not** Better Auth's
  `banUser`/`unbanUser`: those routes use `adminMiddleware` and `hasPermission`
  on the global `user.role`, and every Tayzu user has the global role `user`
  (`002` Q37), so they would be refused even in process. Sign-in is blocked
  locally and through SSO.
- A machine principal whose token carries the `userId` attribution claim is
  rejected when the bound `_user` is **absent or not `Active`** (Resolved decision
  Q40), and token exchange refuses to mint a token for it. A deleted service
  account, one whose `_user` was tampered with or removed, and a `Disabled` one
  therefore never resolve as a `member` of the tenant, even if a credential
  survives. The revocation list is insert-only, so the cache check is what lets a
  disabled service account be re-enabled without a migration. A token without the
  claim (an integration or agent credential bound to no service account) is not
  affected.
- A principal, human or machine, of a tenant with a **pending** or **purged**
  deletion marker is rejected (D9); a cancelled marker (tombstone) does not
  reject.
- Revoked credentials are already covered by `002` D21 (D8). The revocation
  lookup is `WHERE tenant_id = $1 AND credential_id = $2`, but its **cache** is
  keyed by `credentialId` alone today, so a credential revoked in one tenant
  would poison the cache for the same id in another; task 11.1b keys the cache by
  `(tenantId, credentialId)` and task 11.1 adds the composite database key. In the
  machine principal `actor.id` is the API key id.

Each rejection emits `catalog.security.principal_rejected` and increments
`tayzu.identity.principal_rejections`. A disabled user's session would emit the
log on every request, so aggregating or rate-limiting that log (keeping the
counter) is a ticket (Risks). There is no last-active-admin guard in
this change (two admins can disable each other); it is a ticket (Risks).

### D14. Every target is resolved on the server and belongs to the caller's tenant

The `identity.*` data lives in the `auth` schema, which has no RLS (`tayzu_auth`,
`002` D6), and `same_tenant` is vacuous unless the real tenant is passed (D3).
So the tenant boundary for these routes is code, and it is stated as a rule:

- Every `{invitation}`, `{credential}`, `{user}`, `{serviceAccount}` and
  organization target, and the optional `userId` of `credentials.create` (which
  must be a service-account `_user` of the tenant, D6), is resolved
  **server-side** and must belong to `ctx.tenantId`. Otherwise the answer is `CATALOG_NOT_FOUND`, identical to a
  nonexistent id (no existence oracle). A user belongs to the tenant when they
  have a membership in it, even if they also belong to another one.
- Cerbos receives the **target's** real tenant as the resource tenant, not
  `ctx.tenantId` echoed back, and the target's opaque id (never an email) as the
  resource id (D3).
- `tenantId` and `actor` are never read from input, path, query or body.
  `identity.organization.delete` compares its confirmation to `ctx.tenantId`, and
  every Better Auth call (`deleteOrganization`, `listApiKeys`, `inviteMember`) is
  given the host tenant only.
- A target with a membership in **another** tenant cannot be the target of an
  operation that acts on the global account: `linkSsoAccount` and
  `unlinkSsoAccount` refuse it (`002` VCDM M10: otherwise an admin of one tenant
  could link an SSO `sub` to a user and take the account over in another).
  `setStatus` is different by design: it is tenant-scoped (D13), so it works for a
  user of two tenants and affects only the caller's tenant.
- The one exception is the public accept route, whose tenant is derived from the
  invitation record (D4), never from the request.
- Each of the fifteen routes has a cross-tenant test (tasks, group 13).

### D15. Mount gate: the routes do not exist over HTTP until the hand-offs are done

`002` Q73 is a hard rule: `identity.*` and the machine-credential operations are
not reachable over HTTP before the hand-offs from `002` (tasks, group 14) are
done. There are no machine-credential routes in `002` (D8): the only HTTP path to
those operations is `identity.credentials.*` and `identity.serviceAccounts.*`, so
the gate covers exactly the fifteen routes of D10. Prose is not a gate, so it is
mechanical:

- A switch, `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), is
  **off by default**. With it off, none of the fifteen routes is registered,
  including the plain accept route (which is registered before the `/v1/*`
  catch-all only when the switch is on). "As if it did not exist" has a precise
  meaning: the response is **the same as for an unknown `/v1` path**. The
  catch-all runs `resolveContext` first, so an **unauthenticated** call answers
  401 `CATALOG_CONTEXT_REQUIRED`, and only an authenticated caller reaches the
  router's 404. Only the accept route is a Fastify route: the other
  fourteen are procedures behind the single `app.all('/v1/*')`, so the test
  enumerates the route table **and** the router's procedures, fails if any
  identity route is registered or reachable outside the switch, and asserts each
  route answers like an unknown `/v1` path in both cases. This switch is also the rollback: turning it
  off removes the whole surface.
- Task order matches: the group that registers the routes (group 15) comes
  **after** the hand-off group (group 14). No HTTP assertion about these routes
  is written before group 14 is done; earlier groups test in process.
- Turning the switch on in a deployment is a first-deployment gate for `010`
  (Risks).

### D16. No identifier in a URL path reaches telemetry

`002` Q67 drops only `url.query`; the HTTP instrumentation still exports the
raw `url.path`, and `{user}` is an email. `apps/api/src/telemetry.ts` already
strips the query part of `url.full`, `http.url`, `http.target` and `url.path`
from spans (it strips only `?` and `#`). For the identity routes it additionally
replaces the path with its route template (`http.route`, for example
`/v1/users/{user}/status`), so no email, invitation id or credential id leaves
the process. Because `/v1/*` is one catch-all, no route template exists
upstream: the template is **computed by matching the request path against the
fifteen paths of D10**. The marker test runs through the real HTTP
instrumentation, not only the in-memory harness.

## Observability contract

Tracer/meter name `@tayzu/auth` (the package this change and `002` share),
version equal to the package version — a second instrumentation scope
alongside `001`'s `@tayzu/catalog`. Shared attribute keys (`tayzu.tenant.id`,
`tayzu.actor.type`, `tayzu.actor.id`) come from `@tayzu/observability/semconv`,
unchanged. The contract lives in `packages/auth/src/telemetry/contract.ts`. That file
already exists with `SPANS`, `METRICS` and `LOG_EVENTS`, overlapping the authz
contract, and `otel-smoke-check` imports only
`packages/authz/src/telemetry/contract.ts` today; it is extended to import this
one as well, with aliased imports and a de-duplication of the shared names, so
the new names are enforced. `apps/api` has no `@opentelemetry/api-logs`
dependency. `catalog.security.authz_denied` and `tayzu.authz.decisions` already
live in `@tayzu/catalog` (`pipeline.ts`, `telemetry/instruments.ts`), which
`apps/api` already depends on, so the identity router emits them through a
helper exported by `@tayzu/catalog` (no duplicate instrument under the
`@tayzu/auth` scope); every other event emitted from the identity router goes
through a helper exported by `@tayzu/auth` (like `emitAccountLinkEvent`).
Neither contract enumerates the values of the rate-limit scope attribute
(`tayzu.auth.rate_limit.scope`), so only the `RateLimitScope` union gains the
values of D4.

Identifier rules for every signal: `tayzu.identity.user.id` is the Better Auth
user id, `tayzu.identity.service_account.id` is the `_user` entity's opaque id,
never the email or the `svc-…` identifier, and no invited email, token,
credential name or secret appears anywhere. `tayzu.identity.operator.id` is the
platform operator's opaque identifier, derived from the maintenance workflow's
authenticated actor and never self-asserted or an email (Q41). In every audit event
`tayzu.actor.id` is the **admin** who acted (the `onBehalfOf` of the `system`
write, Resolved decision Q10), never the `system` actor.

### Spans

| Span name                               | When   | Required attributes                                                                                                               | Conditional attributes                                               |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `identity.invitation.create`            | op     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role` (`member`\|`admin`)                                              | —                                                                    |
| `identity.invitation.accept`            | op     | `tayzu.identity.invitation.id`                                                                                                    | `tayzu.identity.invitation.path` (`new_account`\|`existing_account`) |
| `identity.invitation.cancel`            | op     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason` (`admin_cancel`\|`re_invite`\|`user_disabled`\|`org_deletion`) | —                                                                    |
| `identity.invitation.resend`            | op     | `tayzu.identity.invitation.id`                                                                                                    | —                                                                    |
| `identity.user.set_status`              | op     | `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`                                                                | —                                                                    |
| `identity.service_account.create`       | op     | `tayzu.identity.service_account.id`                                                                                               | —                                                                    |
| `identity.service_account.delete`       | op     | `tayzu.identity.service_account.id`                                                                                               | —                                                                    |
| `identity.credential.list`              | op     | `tayzu.identity.credential.count`                                                                                                 | —                                                                    |
| `identity.credential.create`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.credential.rotate`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.credential.revoke`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.organization.delete`          | op     | `tayzu.tenant.id`                                                                                                                 | —                                                                    |
| `identity.organization.cancel_deletion` | script | `tayzu.tenant.id`, `tayzu.identity.operator.id`                                                                                   | —                                                                    |
| `identity.organization.purge`           | job    | `tayzu.identity.org_deletion.step` (`catalog`\|`auth`), `tayzu.identity.org_deletion.entities_removed`                            | —                                                                    |

All spans are `INTERNAL`, one per operation (one per tenant and step for the
purge), following `001` design's error and sanitization rules verbatim
(expected errors: `error.type` only, no exception event; unexpected errors:
sanitized exception, no message/SQL).

### Metrics

| Instrument                            | Type, unit              | Attributes                                                                                                                                                              | Purpose                                                                                                                               |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tayzu.identity.invitations`          | Counter, `{invitation}` | `tayzu.tenant.id`, `tayzu.identity.invitation.mutation` (`created`\|`accepted`\|`rejected`\|`cancelled`\|`expired`\|`rate_limited`)                                     | Invitation funnel                                                                                                                     |
| `tayzu.identity.user_status_changes`  | Counter, `{change}`     | `tayzu.tenant.id`, `tayzu.identity.user.status.to`, `tayzu.actor.type`                                                                                                  | Lifecycle churn                                                                                                                       |
| `tayzu.identity.service_accounts`     | Counter, `{account}`    | `tayzu.tenant.id`, `tayzu.identity.service_account.mutation` (`created`\|`disabled`\|`enabled`\|`deleted`)                                                              | Service-account volume                                                                                                                |
| `tayzu.identity.credential_mutations` | Counter, `{mutation}`   | `tayzu.tenant.id`, `tayzu.identity.credential.kind` (`service_account`\|`integration`\|`agent`), `tayzu.identity.credential.mutation` (`created`\|`rotated`\|`revoked`) | Credential hygiene signal                                                                                                             |
| `tayzu.identity.org_deletions`        | Counter, `{deletion}`   | `tayzu.identity.org_deletion.outcome` (`requested`\|`completed`\|`failed`\|`cancelled`)                                                                                 | Rare, high-impact operation — always worth a signal (`denied_step_up` dropped: the guard already emits `tayzu.auth.step_up.required`) |
| `tayzu.identity.principal_rejections` | Counter, `{rejection}`  | `tayzu.identity.rejection.reason` (`user_disabled`\|`service_account_disabled`\|`service_account_missing`\|`tenant_pending_deletion`), `tayzu.actor.type`               | Enforcement of D13 is visible and alertable                                                                                           |

`tayzu.identity.step_up_denials` from the earlier draft is **dropped**: the
step-up guard already emits `auth.security.step_up_required` and
`tayzu.auth.step_up.required`.

**Cardinality budget**: `tayzu.tenant.id` stays under the same <20 bound `001`
ADR-0006 already assumes. Every other attribute above is a bounded enum.
Invited emails, invitation tokens, credential names, and credential secrets
are **never** attributes on any signal — the cardinality guard extends
`001`'s otel-smoke-check to this package's metrics too.

### Log events

| Event name                                        | Severity | Attributes                                                                                                                                                                                                                                                                                                  | Purpose                                                                                                          |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `catalog.audit.invitation_created`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role`                                                                                                                                                                                   | Audit; the role is logged (VCDM B2)                                                                              |
| `catalog.audit.invitation_accepted`               | INFO     | same, plus `tayzu.identity.user.id` and `tayzu.identity.invitation.path`                                                                                                                                                                                                                                    | Audit                                                                                                            |
| `catalog.audit.invitation_cancelled`              | INFO     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                                                                                                                                                                                                          | Audit                                                                                                            |
| `catalog.audit.invitation_resent`                 | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.invitation.id`                                                                                                                                                                                                                                         | Audit (new)                                                                                                      |
| `catalog.audit.user_created`                      | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.user.role` (`member`\|`admin`), `tayzu.identity.user.source` (`admin`\|`bootstrap`)                                                                                                                                          | Audit for `identity.users.create` and bootstrap (`002` Q42, new)                                                 |
| `catalog.audit.user_status_changed`               | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`, `tayzu.identity.user.account_kind`                                                                                                                                       | Audit of every status change, including service accounts disabled and enabled (new)                              |
| `catalog.audit.service_account_created`           | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id`                                                                                                                                                                                                                                    | Audit                                                                                                            |
| `catalog.audit.service_account_deleted`           | INFO     | same                                                                                                                                                                                                                                                                                                        | Audit (new)                                                                                                      |
| `catalog.audit.credential_created`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`, `tayzu.identity.credential.kind`                                                                                                                                                                                                       | Audit (`002` Q42, new)                                                                                           |
| `catalog.audit.credential_rotated`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                                                                 | Audit — opaque IDs only, never secrets                                                                           |
| `catalog.audit.org_deletion_requested`            | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                                                                                                                                                                         | Phase 1 started: access revoked, tenant marked (new)                                                             |
| `catalog.audit.org_deletion_cancelled`            | INFO     | `tayzu.tenant.id`, `tayzu.identity.operator.id`                                                                                                                                                                                                                                                             | The reversal script tombstoned a pending marker; the operator's opaque id is recorded (new)                      |
| `catalog.audit.org_deletion_completed`            | INFO     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.entities_removed`                                                                                                                                                                                                                                           | Durable record that the irreversible purge happened, emitted by the purge before the organization row is deleted |
| `catalog.security.authz_denied`                   | WARN     | as already declared by `001`/`002`                                                                                                                                                                                                                                                                          | Reused: the identity router now emits it on every Cerbos deny (it threw silently before)                         |
| `catalog.security.invitation_acceptance_denied`   | WARN     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.denial_reason` (`expired`\|`cancelled`\|`rejected`\|`already_accepted`\|`token_mismatch`\|`disabled_user`\|`not_found`\|`tenant_pending_deletion`\|`session_required`\|`email_mismatch`\|`account_conflict`\|`csrf_rejected`\|`origin_rejected`) | Misuse of dead/foreign invitations (SEC06/SEC11); the reason lives only here, never in the HTTP response         |
| `catalog.security.invitation_rate_limited`        | WARN     | `tayzu.tenant.id`, `tayzu.identity.invitation.limit_scope` (`tenant`\|`recipient`\|`global`)                                                                                                                                                                                                                | Invite/resend volume abuse signal; no invited email present                                                      |
| `catalog.security.self_status_change_denied`      | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                                                                                                                                                                         | Self-service status tampering                                                                                    |
| `catalog.security.principal_rejected`             | WARN     | `tayzu.identity.rejection.reason`, `tayzu.actor.type`                                                                                                                                                                                                                                                       | A disabled, revoked-tenant or pending-deletion principal was refused (D13, new)                                  |
| `catalog.security.credential_revoked`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`                                                                                                                                                                                                                                         | Security-relevant, not routine                                                                                   |
| `catalog.security.credential_rotation_incomplete` | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                                                                 | Overdue signal: a rotation left two usable credentials or none (new)                                             |
| `catalog.security.org_deletion_notice_failed`     | WARN     | `tayzu.tenant.id`                                                                                                                                                                                                                                                                                           | The org-deletion notice could not be sent to an administrator; the request itself is not blocked (new)           |
| `catalog.security.admin_notice_failed`            | WARN     | `tayzu.tenant.id`                                                                                                                                                                                                                                                                                           | The admin-accepted notice (Q39) could not be sent to an administrator; the acceptance is not blocked (new)       |
| `catalog.security.org_deletion_failed`            | WARN     | `tayzu.tenant.id`, `tayzu.identity.org_deletion.step` (`catalog`\|`auth`)                                                                                                                                                                                                                                   | A purge step failed; a failed deletion is no longer invisible (new)                                              |

Every event above is exempt from sampling and from any downstream filter/drop
rule, per `001`'s existing rule for `catalog.audit.*`/`catalog.security.*`
(`001` design, Sampling exemption) — `010` inherits this constraint unchanged.
The user, credential and bootstrap lifecycle events `002` Q42 deferred to this
change are `user_created`, `credential_created`/`credential_rotated`/
`credential_revoked`, and the bootstrap case of `user_created`; SSO link and
unlink already have `auth.security.account_linked` and `account_unlinked`. These
events are declared in the contract by task 14.3, before the routes exist, because
`002` Q42 forbids mounting an operation whose events are not declared; the
remaining names are declared by task 16.1.

## Security considerations (SSA SEC01-SEC16 posture)

This is this change's own SEC01-16 walk-through. The formal `vcdm-ssa-validator`
pre-assessment (Mode A, 2026-10-01) found 11 blocking gaps (B1-B11) against the
merged `002`, and a second pass over the amended change found five more (NB1-NB5),
resolved by Resolved decisions Q24-Q27 and the traceability table in the
Risks section, and a third pass found two more blocking gaps (R3-B1 and R3-B2)
and the questions H1-H4, resolved by Q38-Q45; all are folded below, and each is also a requirement or scenario
in the spec and a task. A joint pre-assessment with `002` (`002/ssa-pre-assessment.md`)
earlier found the seam gaps closed by D3/D6.

| Gap                                                                                   | Where it is closed                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 invitation acceptance cannot work                                                  | D4 (plain public accept route, token, tenant from the invitation, existing-account path), spec requirement "Invitation acceptance", tasks group 8             |
| B2 unconstrained invited role                                                         | D4 (`member`\|`admin`), spec "Invitation lifecycle", task 7.4                                                                                                 |
| B3 no server-side tenant binding                                                      | D14, spec "Targets belong to the caller's tenant", group 13                                                                                                   |
| B4 disable/rotate not immediate, state machine bypass                                 | D2, D8, D13, spec "Disabling a human takes effect immediately", groups 4, 9, 10, 11                                                                           |
| B5 org deletion impossible as written                                                 | D9, spec "Org deletion", group 12, migrations `0012` and `0013`                                                                                               |
| B6 Q73 gate not enforced                                                              | D15, spec "Identity routes are unreachable until mounted", group 14 before 15, with every `002` hand-off item traced to a task or a recorded deferral (Risks) |
| B7 security logging gaps                                                              | Observability contract, spec "Security-relevant events are logged"                                                                                            |
| B8 paths leak identifiers                                                             | D16, spec "Telemetry contract", task 16.5                                                                                                                     |
| B9 email injection, origin, caps                                                      | D4, D5, spec "Invitation email is fixed and capped", group 6                                                                                                  |
| B10 service-account ceiling                                                           | D3, D6, spec "Service accounts", groups 5 and 10                                                                                                              |
| B11 step-up coverage                                                                  | D10, spec "Every high-risk operation requires step-up", task 15.2                                                                                             |
| NB1 existing-account acceptance decided but not specified (Q24)                       | D4 steps 4 and 5, spec "Invitation acceptance", tasks 8.5, 8.5b-8.5d, 15.7                                                                                    |
| NB2 a multi-tenant human cannot be off-boarded (Q25)                                  | D13, D14, spec "Disabling a human takes effect immediately", tasks 11.2, 11.8, 13.4                                                                           |
| NB3 purge function and marker integrity (Q26)                                         | D9, spec "Deletion marker integrity", migrations `0012` and `0013`, tasks 12.1, 12.1b, 12.7                                                                   |
| NB4 reversal of a pending deletion unaudited (Q27)                                    | D9, D5, spec "Org deletion", tasks 12.13, 12.14, 12.15                                                                                                        |
| NB5 `002` hand-off content incomplete                                                 | the traceability table (Risks), tasks group 14                                                                                                                |
| R3-B1 service-account lifecycle not closed (Q40)                                      | D6, D8, D13, spec "Service accounts" and "Credential creation, rotation and revocation", tasks 9.5b, 9.6b, 10.7, 11.6, 11.7                                   |
| R3-B2 deny-by-default not structural for the identity router (Q45)                    | D10, D3, spec "Every identity route declares its authorization", tasks 5.3b, 15.9                                                                             |
| R3 existing-account acceptance unattainable (Q38) and admin acceptance residual (Q39) | D4 steps 4 and 6, D5, spec "Invitation acceptance", tasks 8.5c, 8.15                                                                                          |

| Section                 | Applies                | Posture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC01 Diagram           | Yes                    | New external actors (the email provider; the invitee with their mailbox; the platform operator) and new arrows (invite→email, the public accept route, ACS egress over HTTPS, the Pwned Passwords range query, the purge job with its two database connections, the reversal script and the workflow that starts it) added to `docs/architecture/system-diagram.md` (tasks 17.7, 17.13).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC02 Attack surfaces   | Yes                    | Fifteen routes (D10), each with its actor, authentication (session, step-up-verified session, or none for the public accept route) and Cerbos check named in `docs/security/attack-surfaces.md` (task 17.6). The native Better Auth `inviteMember` and `accept-invitation` routes stay off `002`'s allowlist (D18 there). The accept route is the first unauthenticated route and a plain Fastify route: it derives the tenant from the invitation, is rate-limited, reads a session only for an existing account (with the CSRF header and its own `Origin` check), validates its body as an allowlist, never reveals why it failed, and sits behind the mount gate (D15).                                                                                                                                                       |
| SEC03 Access control    | Yes, core              | Every operation Cerbos-gated to `admin` (D3) with the target's real tenant; targets resolved server-side (D14); self-status-change denied; step-up on every high-risk operation (D10); invited role limited to `member`/`admin`; service accounts held to `member` by signed claim, creation validation and a Cerbos deny (D6); disabled users and service accounts rejected within seconds, a human tenant-scoped so a member of two tenants can be off-boarded by either (D13). Off-boarding is `Disabled`; role change and member removal are deferred (Non-Goals). Any admin may request org deletion, every admin is notified and reversal is an audited, JIT-gated operator action (D9, Q27). The human attestations (off-boarding procedure, training, access review) are deferred to `010`'s SSA (Resolved decision Q17). |
| SEC04 Password storage  | Yes                    | The acceptance flow is the first place a password is set outside sign-in: it applies the password policy (20-128 characters, every class, no harmful characters, a denylist, NFC-normalized at every password-verifying entry point; Q22) and the breached-password check (Q23), the hash is Better Auth's scrypt (`002`), and a token is required before any password is read. Service-account credentials reuse `002`'s API-key hashing.                                                                                                                                                                                                                                                                                                                                                                                        |
| SEC05 Crypto            | Partial                | The invitation token is 256 bits from a CSPRNG, stored only as a sha256 digest and compared in constant time (D4); `docs/security/crypto-inventory.md` also lists the SHA-1 prefix of the breached-password range query, the sha256 of the per-recipient cap key and the ACS authentication (HMAC of the cap key is a ticket); credential secrets are hashed by `002`'s mechanism; TLS to Azure Communication Services is provider-managed. The token generator is ours, so no Better Auth invitation-id entropy claim is relied on.                                                                                                                                                                                                                                                                                              |
| SEC06 Misuse            | Yes                    | Dead invitations never succeed; acceptance errors are indistinguishable; a `Disabled` user cannot be revived by sign-in, acceptance or a hook (D2); re-invite cancels the previous invitation; org deletion is idempotent and reversible during the window (D9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SEC07 Dependencies      | Yes                    | `@azure/communication-email` joins the Dependabot/`pnpm audit`/quarterly-EOL process; license, `allowBuilds` and SBOM review are recorded in `docs/security/dependencies.md` (task 1.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC08 File upload       | N/A                    | No file upload surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SEC09/SEC10 Secrets     | Yes                    | The Communication Services connection string is a new Key Vault secret on a dedicated send-only ACS resource, with a change procedure in `docs/security/secrets.md`; a managed identity is a first-deployment gate (Q28). The purge job's `tayzu_purge` and `tayzu_auth` secrets are documented with owner and rotation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC11 Phishing          | Yes, core new exposure | 48h expiry, one link, fixed subject and template with no tenant or inviter free text, link origin from `INVITATION_LINK_BASE_URL` only (Q32), exactly one recipient and no CC/BCC/attachments, ACS tracking disabled and no Reply-To, per-tenant, per-recipient and global caps (D4, D5); a third fixed notice tells every other admin when an `admin` invitation is accepted (Q39). The SSA answers are Resolved decision Q34: one clickable link, unavoidable for a no-account invitee and mitigated by the fragment token, single use, 48-hour expiry and the configured origin; no attachments; only the recipient varies.                                                                                                                                                                                                    |
| SEC12 Testing           | Yes                    | Every requirement has a scenario-backed test; every route a cross-tenant test; `cerbos compile` gates policies. The OpenAPI-driven ZAP scan (`002` NB1) would hit `organization.delete`, `rotate`, `revoke` and `invite`, so it needs a sandbox tenant, a non-sending email sender and a destructive-route exclusion; because the switch is off by default, a sandbox scan with the switch **on** is required before the first deployment (ticket and gate, Risks).                                                                                                                                                                                                                                                                                                                                                               |
| SEC13 Deployment        | Partial                | The Communication Services connection string via Key Vault reference, `INVITATION_LINK_BASE_URL`, `INVITATION_EMAIL_KILL_SWITCH`, `MOUNT_IDENTITY_ROUTES`, the purge window, and a scheduled job provisioned with `010` that holds the `tayzu_purge` and `tayzu_auth` secrets, and a reviewed `workflow_dispatch` workflow (environment reviewers, OIDC) for the reversal script and the `_user` backfill (Q41), so nothing runs against production from a workstation; production startup fails without a real `EmailSender`.                                                                                                                                                                                                                                                                                                    |
| SEC14 Infra permissions | Yes                    | Three migrations (Checkpoint 3): `0011` (composite key), `0012` and `0013` (the marker table, the `tayzu_purge` role, the row-level policies, the amended append-only trigger and the hardened purge and lister functions). The marker is insert-only for `tayzu_app`, the roles stay separate (`tayzu_app`, `tayzu_auth`, `tayzu_purge`, `tayzu_migrator`) and `PUBLIC` gets no `EXECUTE`, and a test proves no role can `SET ROLE tayzu_purge` (D9, Q26). The resolver rejects a `purged` marker as well as a `pending` one.                                                                                                                                                                                                                                                                                                    |
| SEC15 Network/host      | Partial                | Two new outbound calls, both HTTPS: Azure Communication Services, and the Pwned Passwords range query to `api.pwnedpasswords.com` (only the first five hex characters of the SHA-1 leave the system, Q23), plus the sender-domain DNS (SPF, DKIM, DMARC), recorded as egresses in the system diagram. ACS data location and retention are stated in `docs/security/data-retention.md`. DNS DDoS protection is deferred to `010`'s SSA (Q17).                                                                                                                                                                                                                                                                                                                                                                                      |
| SEC16 Logging           | Yes                    | Twenty-two new log events (plus the reused `catalog.security.authz_denied`) in the contract, all sampling-exempt, opaque ids and enums only, with `tayzu.actor.id` pinned to the admin; `catalog.security.authz_denied` is emitted from the identity router; no identifier in a URL path reaches telemetry (D16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Divergences from Port (deliberate)

| Topic                              | Port                                                                   | Tayzu 043                                                                                                              | Why                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Invite/status-change authorization | Gated on request _origin_ (UI/API)                                     | Gated on Cerbos role (`admin`)                                                                                         | `project.md`'s "actor.type/origin never selects a code path" invariant (D3, ADR-0020)                             |
| Service-account identifier         | Real-looking email at a reserved domain (`serviceaccounts.getport.io`) | `^svc-...` non-email identifier                                                                                        | Tayzu's `_user.identifier` is not required to be email-shaped; avoids a lookalike-phishing surface (D6, ADR-0017) |
| Org deletion recovery              | Described as a 14-day internal backup process, mechanics undocumented  | A pending window (7 to 14 days) during which access is revoked and the tenant can still be reversed, then a job purges | Server PITR cannot restore one tenant; the window is a real, testable mechanism (D9, ADR-0019)                    |
| Credential rotation                | Undocumented beyond "rotate if exposed"                                | Explicit immediate cutover through the revocation list, 90-day documented rotation cadence                             | Port leaves this as a gap (`r1-port.md` §8.1); Tayzu specifies it fully (D8, ADR-0018)                            |
| "View as" a different user         | Documented, admin-only                                                 | Not built in this change                                                                                               | Explicitly later-UI (`003`/`014`), not dropped                                                                    |
| Support-user audit exemption       | _"Support user actions are not logged"_                                | No such exemption anywhere in Tayzu                                                                                    | Every administrative action, including Tayzu's own operators, is logged uniformly (SEC16)                         |

## Risks / Trade-offs

- [Credential rotation has no grace period (D8); an integration polling with
  the old credential breaks within seconds of the rotation] → Documented in
  the rotation UX copy and `docs/security/data-retention.md`; revisit with a
  scheduled hard-revoke only if a real Phase-1 integration needs it.
- [A pending org deletion is reversible only through the operator script (D9,
  Resolved decisions Q21 and Q27), and the purge removes the data for good;
  backups keep it until their own retention expires] → The erasure statement in
  `docs/security/data-retention.md` says so; the Azure backup retention is an
  infrastructure setting to confirm when the server is provisioned. A
  compromised admin session can still request a deletion, but every admin is
  notified at once and the window is at least 7 days.
- [The deletion marker and the purge function are the most privileged new
  surface] → The marker is insert-only for `tayzu_app` with a database-set
  `requested_at` and a `CHECK` on the window, the purge runs as a dedicated
  `tayzu_purge` role with its own secret under a row-level policy limited to due
  tenants, the append-only trigger admits only that role, and the functions are
  hardened (D9, Resolved decision Q26). Checkpoint 3 reviews every grant and the
  trigger amendment. Recorded for `010`.
- [The per-recipient cap across tenants is a weak oracle and a
  denial-of-invitation vector: an admin sees `AUTH_RATE_LIMITED` for an address
  that other tenants invited three times, and one tenant can exhaust the cap for
  a victim address] → Accepted and documented; the response is the same one a
  tenant cap gives, and the signal reveals no tenant. `+` aliases cannot bypass
  it (Q33). The kill switch is an environment variable, so flipping it needs a
  new revision; the emergency procedure is in `docs/security/secrets.md`. Ticket
  to revisit.
- [A new-account `admin` invitation is protected only by mailbox control at
  acceptance: a mistyped or hijacked address yields a tenant admin who then
  enrols their own factor] → Accepted (Resolved decision Q39); every other admin
  is told by a fixed-template notice the moment an `admin` invitation is accepted.
- [A tenant admin can create a global account for any email with a temporary
  password they know (account squatting), now reachable over HTTP] → Ticket.
- [Step-up is keyed on the route, so a per-role step-up (admin invite only)
  would need a body-aware guard] → Resolved decision Q19: `invite` is high-risk
  for every role, so no body-aware guard is needed.
- [An SSO-only invitee] → `002` Q72: an organization that wants to invite someone
  who will only ever use Visma Connect is unsupported until `025`; they need a
  local password first, then link through `/link-social`. An invitee who already
  has an account accepts with their session (Q18, Q24). A service account has no
  Visma account to link and needs no change.
- [The invitation link is inert until `003` builds the accept page (Q32)] →
  Documented in `docs/security/attack-surfaces.md`; the mount switch stays off
  until then, and turning it on is a first-deployment gate.
- [An admin who is the only administrator can be disabled, or can disable another
  admin, and any admin can request deletion of an organization with an `owner`]
  → Last-active-admin protection is a ticket; Resolved decision Q27 accepts that
  any `admin` may request deletion, mitigated by the notice to every admin and the
  window.
- [Raising the password minimum from 8 to 20 (Q22) breaks `002`'s test fixtures,
  and the breached-password check (Q23) fails closed when the Pwned Passwords
  service is unreachable, so no password can be set during an outage] → The
  fixtures are updated in task 8.1c; the outage behavior is the decided one and
  is documented.
- [Drift between this design and `002`'s implementation by the time `043`
  starts implementation] → Checked against the merged code on 2026-10-01 (task
  1.1); the findings are in the Context.
- [Sending a real invitation email in integration tests would be flaky and
  slow] → `EmailSender` is faked in every test except a single, explicitly
  optional manual smoke check against a real Communication Services sandbox
  (not part of CI).

### Hand-offs from `002` (Q73): traceability

`002` design Q73 hands this change the items M5, M9-M15 and M17-M20 of `002`'s
VCDM re-assessment of 2026-10-01 (M4 was added to the group earlier). The item
descriptions are recorded here so that the gate can be checked against the
repo. Every item is either a task in group 14 (or another named task) or an
explicit deferral with its justification; the rule "no mount before group 14 is
done" therefore covers all of them.

| Item | What it is                                                                                                                                                                                  | Where it is closed                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4   | Attributes are loaded and authorized in one transaction and the write runs in another (check-then-act)                                                                                      | Task 14.6                                                                                                                                                                                                                                                                                                                                                                                                         |
| M5   | Password policy: the minimum was 8, no breached-password check, only a rate limit                                                                                                           | Resolved decisions Q22, Q23; tasks 8.1, 8.1b, 8.1c, 8.1d, 14.5, 14.5b                                                                                                                                                                                                                                                                                                                                             |
| M9   | Composite `(tenant_id, credential_id)` key, credential routes behind Cerbos, create/link existence oracles, the Q42 audit events                                                            | Tasks 11.1, 14.1, 14.3, 16.6                                                                                                                                                                                                                                                                                                                                                                                      |
| M10  | Identity operations assume one tenant per user; a two-tenant user lets an admin link an SSO `sub` and take the account over                                                                 | Task 14.2 (D14)                                                                                                                                                                                                                                                                                                                                                                                                   |
| M11  | Temporary passwords have no forced change or expiry                                                                                                                                         | Tasks 14.5 and 14.5b (Q36)                                                                                                                                                                                                                                                                                                                                                                                        |
| M12  | `NODE_ENV=test` relaxes the https, role-assertion and OTLP guards                                                                                                                           | Task 14.8                                                                                                                                                                                                                                                                                                                                                                                                         |
| M13  | Per-replica in-memory limiters; the re-auth callback has no limiter and deletes a row per hit; `reauthorization.start` inserts a row per blocked attempt                                    | Tasks 14.9 (the callback) and 14.9b (`start`); the invitation caps and the accept route use the DB-backed store (6.10, 8.13); **deferred** to `010` for the in-memory `@fastify/rate-limit` budgets of `/v1`, token exchange and back-channel logout: the multiplication by replica count is a deployment fact, there is no behavior to build here, and the shared-store check is a first-deployment gate (Gates) |
| M14  | A back-channel logout token with neither `sid` nor `sub` is accepted and consumes its `jti`; discovery and JWKS are fetched before the cheap claim checks; `typ: logout+jwt` is unconfirmed | Tasks 14.10, 14.11; the `typ` confirmation is added to the Q57 pre-deployment checklist (Gates)                                                                                                                                                                                                                                                                                                                   |
| M15  | `Inherited` ownership is unreachable and a `replace`-mode upsert without `ownerTeam` releases ownership                                                                                     | Task 14.6b (the upsert part); the `Inherited` part is Q37, task 14.6c                                                                                                                                                                                                                                                                                                                                             |
| M17  | The pinned image digests (`postgres`, Cerbos, ZAP) are not tracked by Dependabot                                                                                                            | Task 14.12                                                                                                                                                                                                                                                                                                                                                                                                        |
| M18  | DAST scope: no `VISMA_CONNECT_*`, so the SSO, back-channel and re-auth surfaces are unscanned; nothing asserts the API scan got 2xx                                                         | Task 14.13 for the assertion (extending the scan to `identity.openapi.json` is a first-deployment gate); **deferred** to `010` for the SSO surfaces: they need Visma Connect's test environment (`002` Q57), which this change cannot provide                                                                                                                                                                     |
| M19  | The diagram is Mermaid only (SEC01 wants a png or jpg), has no distinct Administrator, Support or Operations actors, and omits the `ghcr.io` pulls and the OTLP export                      | Tasks 17.7, 17.13                                                                                                                                                                                                                                                                                                                                                                                                 |
| M20  | `resolveContext` ignores `banned`; no test that a banned user cannot sign in or that a ban revokes sessions; no admin disable path                                                          | Tasks 14.4, 11.2                                                                                                                                                                                                                                                                                                                                                                                                  |

### Gates for the first deployment (`010`)

Human-owned, next to `002`'s own list:

- The invitation caps (Q15) and the accept-route limiter run on `002`'s
  DB-backed store (D4); confirm it in the deployed environment. The in-memory
  `@fastify/rate-limit` budgets of `/v1`, token exchange and back-channel logout
  multiply by the replica count until moved to a shared store (M13, `002` Q73
  gate).
- `MOUNT_IDENTITY_ROUTES` is turned on only after every task in group 14 is
  ticked, and after `003` serves the accept page at `INVITATION_LINK_BASE_URL`.
- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the
  secret in Key Vault on a dedicated send-only ACS resource; the migration from
  the connection string to a managed identity is done (Q28).
- The DAST scan runs against a sandbox tenant with the mount switch **on**, a
  non-sending sender and without the destructive routes.
- The purge job is provisioned with its two secrets, the purge window and Azure
  backup retention are confirmed, and the reversal runbook's JIT access and named
  approver are in place.
- The maintenance workflow (reversal script and `_user` backfill, Q41) has its
  GitHub environment with required reviewers, its OIDC federated identity and its
  Azure Container Apps Job provisioned (with `010`), and the first run is
  rehearsed in a sandbox.
- `003`'s accept page strips the fragment after reading it, sends
  `Referrer-Policy: no-referrer` and loads no third-party script, and the ACS
  resource has engagement and click tracking disabled and DMARC aligned.
- The DAST scan is extended to `openapi/identity.openapi.json` (Q43); the accept
  route is not in either document and is scanned by hand.
- The Q57 pre-deployment checklist gains: confirm that Visma Connect sends
  `typ: logout+jwt` (M14).
- The human attestations (off-boarding, training, access review, DNS DDoS, log
  hours, retention policy) are answered in `010`'s SSA (Resolved decision Q17).

### Tickets (non-blocking VCDM items, not built in this change)

| Ticket                                 | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last-active-admin protection           | Two admins can disable each other; the last admin can be disabled; any admin can request deletion of an organization with an `owner`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Member management                      | `updateMemberRole`, `removeMember`, `setActiveOrganization` as Cerbos-gated procedures (`002` D18), after this change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Retention windows                      | Accepted, expired and cancelled `invitation` rows keep the invitee's email; a `_user` left at `Invited` after expiry stays; define windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| User notifications                     | Status, role and credential changes notify the user (SEC06; `002` Q46). The org-deletion notice to every admin is built here (D5, Q27).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Service-account read scope             | A service account as `member` can list all users' emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Credential hygiene alerts              | Alert on a credential whose `lastRequest` is stale or whose rotation is overdue: with no hard expiry (Q20) the rotation-due flag is only a display hint (SEC09/SEC10).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ZAP guards                             | Sandbox tenant, no-send email sender, destructive-route exclusion, and a sandbox scan with the mount switch on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SSO-only when linked                   | `002` Q44, for `025`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-recipient oracle                   | See Risks. Alias normalization is settled by Q33; the cross-tenant denial-of-invitation and the runtime kill-switch flip remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Email in the `{user}` path             | The `_user` identifier (an email) is a path segment (Resolved decision Q12). D16 keeps it out of the process's telemetry, but the ingress and any proxy access log outside the process still see it. Consider an opaque-id route. oRPC's generated client also encodes path parameters with `encodeURIComponent`, so `a@b` becomes `a%40b`, which `002` Q74 answers with 404: the generated client cannot call a `{user}` route with an email until this is solved (the HTTP tests send raw paths and would not notice; the catalog `{entity}` path for `_user` emails has the same problem). |
| Account squatting                      | A tenant admin creates a global account for any email with a temporary password they know through `identity.users.create`. Consider an invitation-only or activation-link flow, or a notice to the address on creation (SEC04).                                                                                                                                                                                                                                                                                                                                                               |
| Pre-purge warning and marker detection | The job warns the admins 24 to 48 hours before a purge, and alerts on a marker with no matching `catalog.audit.org_deletion_requested` event, because a compromised request path could insert a marker silently (SEC14).                                                                                                                                                                                                                                                                                                                                                                      |
| HMAC of the per-recipient cap key      | Use an HMAC with a server secret instead of a bare sha256 of the email (SEC05).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Banned or disabled sign-in oracle      | Better Auth's admin plugin refuses a banned user with a distinct error after a correct password, a credential-validity oracle. The response should equal a wrong password's.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `principal_rejected` log flood         | A disabled user's session emits the WARN log on every request. Aggregate or rate-limit it and keep the counter (SEC16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ban-hook mirror                        | The ban hook (D2) writes `admin_enable` to every membership on a global unban, which can revert a tenant-scoped disable made by `setStatus`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cerbos decision logs                   | `decisionLogsEnabled: true` records the resource id and attributes; this change sends only opaque ids (D3), but the content and retention of those logs need a policy (SEC16).                                                                                                                                                                                                                                                                                                                                                                                                                |

## Migration Plan

1. **Three SQL migrations, all Checkpoint 3**, each with its
   `migrations/down/00NN.down.sql`, `meta/00NN_snapshot.json` and `_journal.json`
   entry, following the repo's pairing of a table migration with a hand-written
   grants migration (0004+0005, 0008+0009):
   - `0011_machine_credential_revocation_tenant_key`: a composite
     `(tenant_id, credential_id)` key on `machine_credential_revocation`, with the
     matching change in `packages/catalog/src/persistence/schema.ts` (task 11.1).
   - `0012_tenant_deletion`: the `tenant_deletion_marker` table, its `CHECK`
     constraints, the database-set `requested_at`, the partial unique index and its
     row-level-security policy for `tayzu_app` (task 12.1).
   - `0013_tenant_deletion_grants`: the `tayzu_purge` role (created here, as
     `0006` created `tayzu_app`), the grants and `FORCE ROW LEVEL SECURITY`, the
     policies limited to due tenants, the amendment of the append-only trigger of
     `0001` (DELETE only for `tayzu_purge`), and the hardened purge and lister
     `SECURITY DEFINER` functions with `EXECUTE` revoked from `PUBLIC` (task 12.1b).
     The blueprint evolution of `_user` (D1) is not a migration: it is a
     `blueprints.update` per existing tenant plus the new-tenant constant.
2. ⛔ **Checkpoint 3** also applies to every Cerbos policy file this change adds
   or edits (D3): the `user.yaml` deny rules; the new `service_account.yaml`,
   `credential.yaml` and `organization.yaml`; and `admin.yaml`,
   `member.yaml` (if needed) and `role_policies_test.yaml`; each presented with
   its `cerbos compile` test output, separately.
3. Deploy: `@azure/communication-email` and its Key Vault secret,
   `INVITATION_LINK_BASE_URL`, the kill switch and the mount switch (off or safe
   by default), and the purge job with its two secrets (provisioned with `010`).
   Nothing is mounted until the gates above are met.
4. The maintenance workflow (`.github/workflows/identity-maintenance.yml`, task
   12.14b) and the three scripts under `apps/api/scripts/` (the `_user` backfill,
   the purge job and the reversal) are added with no schema change. The `_user`
   backfill runs once per environment through the workflow, after the code that
   reads `accountKind` is deployed.
5. Rollback: set `MOUNT_IDENTITY_ROUTES` off to remove the whole HTTP surface
   (D15); disable the purge job. The migrations have down scripts, but a purge
   that already ran cannot be undone.

## Resolved decisions (asked and approved in chat, 2026-09-28 and 2026-10-01)

Per `openspec/project.md` §20, drawn from the shared `002`/`043` decision set
(`scratchpad/p002/decisions.md`) that specifically bears on this change:

| #   | Question                                                                                                                                                      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Split point between `002` and `043`                                                                                                                           | This change owns exactly: 4-state user status lifecycle and invitations (+ invitation email, SEC11), service accounts, org API-credentials viewer/management, data retention & deletion policy + org deletion, credential rotation policy UX. Everything else stays with `002`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q4  | Canonical user status field                                                                                                                                   | Stored as one field on `_user`, updated by hooks reacting to Better Auth events (`002` defines the field and `Active`/`Disabled` at minimum; this change completes `Staged`/`Invited` and the transition rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q5  | Machine credentials                                                                                                                                           | Long-lived client id + secret (revocable, rotatable, hashed) exchanged for a short-lived (1-hour) access token — this change's service accounts and credential viewer/rotation consume that mechanism, they do not redefine it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q6  | Step-up for high-risk operations                                                                                                                              | A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q7  | (VCDM pre-assessment, 2026-09-28) Should service accounts be restricted from holding `admin`/broad `moderatedBlueprints`, given they never go through step-up | Restrict service accounts to `member` role only, enforced at creation/update validation and by an independent Cerbos rule on `accountKind: "service"` (D6, D3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q8  | (Drift-check and VCDM pre-assessment against merged 002, 2026-10-01) How an invitee without an account accepts                                                | The invitation link carries a single-use, constant-time-compared token. A public, rate-limited accept route outside the tenant-context pipeline derives the tenant from the invitation record, lets the invitee set a password, and treats the token as mailbox proof (email verified in-process); MFA enrollment then follows 002 Q43, and Visma Connect is linked later through `/link-social`, `sub`-keyed. Responses are enumeration-resistant. The native `/organization/accept-invitation` route stays off the D18 allowlist.                                                                                                                                                                   |
| Q9  | (VCDM B2, 2026-10-01) Roles an invitation may carry                                                                                                           | `member` or `admin`, never `owner`; an `admin` invitation requires step-up and is logged with its role (consistent with 002 Q37). _Extended by Q19: every invitation requires step-up._                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q10 | (Drift b2, 2026-10-01) Attributing `_user` writes to the admin                                                                                                | The identity procedure writes as `system` with `actor.onBehalfOf` set to the admin, in-process only; `reserved.ts` is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q11 | (Drift b8, 2026-10-01) Canonical disable mechanism and default status                                                                                         | **Superseded in part by Q25** (the disable is tenant-scoped and uses the internal adapter; `banUser`/`unbanUser` are not called, D13); the state-machine part stands. `setStatus` calls Better Auth `banUser`/`unbanUser` and syncs `_user.status` through the `nextStatus` state machine; `afterAddMember`, the ban hook and `identity.users.create` go through it. Admin-created users start `Active`; `Staged` is the default only for an entity created without a status. Covers 043 task 14.4.                                                                                                                                                                                                   |
| Q12 | (Drift b3/b4, VCDM, 2026-10-01) Service-account principal                                                                                                     | The signed machine claim stays `member` with no teams and no moderated blueprints (002 Q28); `userId` is added only as an attribution claim. Routes address a user by its `_user` entity identifier (email or `svc-…`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q13 | (Drift b5, VCDM B4, 2026-10-01) Immediacy of disable, rotate and revoke                                                                                       | Rotate and revoke write the revocation list (effective within seconds). Disable is a `_user.status` check on the resolver's machine branch with the 5-second cache, failing closed, so a disabled service account can be re-enabled without a migration.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q14 | (Drift b6, VCDM B5, 2026-10-01) Org deletion                                                                                                                  | Two phases: access is revoked immediately and the tenant is marked pending deletion; after a 7-to-14-day window a job purges in idempotent steps (catalog data, then Better Auth rows). The purge of append-only rows goes through a `SECURITY DEFINER` function owned by `tayzu_migrator` that deletes only for a tenant marked for deletion (a migration, Checkpoint 3). **The `tayzu_migrator` owner is superseded by Q26** (the function is owned by `tayzu_purge`); the two phases and the window stand.                                                                                                                                                                                         |
| Q15 | (VCDM B9, 2026-10-01) Invitation email abuse limits                                                                                                           | 30 per hour per tenant, 3 per 24 hours per recipient across all tenants, and a global kill switch (environment variable), on a shared store before the first deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q16 | (Drift b7, 2026-10-01) Testing the service-account role ceiling                                                                                               | The Cerbos rule stays as a defensive layer, tested at the policy level, plus a `system`-actor test; no new role-editing operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q17 | (VCDM, 2026-10-01) Human attestations                                                                                                                         | Deferred to `010`'s SSA, as 002 Q59 and Q79.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q18 | (Amendment question, 2026-10-01) Invitation for an email that already has an account                                                                          | Acceptance requires an authenticated session of that same account plus the token; it adds only the membership, activates the `_user` and sets no password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q19 | (Amendment question, 2026-10-01) Step-up for `invite` and `users.create`                                                                                      | Both are marked `x-tayzu-risk: high` for every invited or created role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q20 | (Amendment question, 2026-10-01) Machine API-key expiry                                                                                                       | No hard expiry; only the 90-day rotation-due indicator (D8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q21 | (Amendment question, 2026-10-01) Org-deletion window and reversal                                                                                             | Default 14 days, configurable between 7 and 14; reversal only by a platform operator clearing the marker through a documented runbook; no in-product cancel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q22 | (Amendment question, 2026-10-01) Password policy                                                                                                              | Minimum **20** characters (the human's choice), at most 128 (bounds the hashing cost). Every character class is required: an upper-case letter, a lower-case letter, a digit and a symbol. Characters that can harm the system are rejected: control characters (U+0000-U+001F, U+007F-U+009F, NUL included), unpaired surrogates, and Unicode format characters (bidirectional overrides, zero-width characters); the password is NFC-normalized before the check and the hash. A bundled common-password denylist applies, with no external call and no new dependency, plus `002`'s existing backoff. Applies to invitation acceptance, temporary and bootstrap passwords, and `/change-password`. |
| Q23 | (Human, 2026-10-01) Breached-password check                                                                                                                   | Added to Q22's policy: Better Auth's built-in `haveIBeenPwned` plugin (part of `better-auth@1.7.6`, so no new dependency) refuses any password found in the Pwned Passwords corpus. It sends only the first five hex characters of the password's SHA-1 (k-anonymity range query) to `https://api.pwnedpasswords.com`, a new outbound egress named in SEC15 and the system diagram. It fails closed: when the service is unreachable the password is not set and the caller gets a generic retryable error. It covers every path Q22 covers, including in-process acceptance and bootstrap.                                                                                                           |
| Q24 | (VCDM re-run NB1, 2026-10-01) Specifying Q18's existing-account acceptance                                                                                    | **The verified-email condition is superseded by Q38.** A plain Fastify route behind the mount switch, with the CSRF custom header and the origin check; it requires a session whose verified email equals the invitation email, plus the token, and a fresh step-up when the invited role is `admin`; it adds only the membership, never touches the password or the active organization, and answers the same uniform rejection as every other failure.                                                                                                                                                                                                                                              |
| Q25 | (VCDM re-run NB2, 2026-10-01) Off-boarding a member who also belongs to another tenant                                                                        | Tenant-scoped disable: `setStatus` writes `_user.status`; `resolveContext` rejects a human whose `_user.status` in the active tenant is `Disabled` (its cached, fail-closed `_user` lookup); only that tenant's sessions are revoked. `banUser` (through the internal adapter, not the admin-plugin route) is used only for a single-membership user.                                                                                                                                                                                                                                                                                                                                                 |
| Q26 | (VCDM re-run NB3 and drift Q-F, 2026-10-01) Purge privilege model                                                                                             | A dedicated `tayzu_purge` role with its own pool and secret, used only by the purge job, owns the purge function and has an RLS policy limited to tenants with a due marker. The marker is insert-only for `tayzu_app`, its window enforced by `CHECK` and `requested_at` set by the database. The append-only trigger allows DELETE only for `tayzu_purge`. A separate `SECURITY DEFINER` lister returns due tenants. (Migrations, Checkpoint 3.)                                                                                                                                                                                                                                                    |
| Q27 | (VCDM re-run NB4, Q5, 2026-10-01) Deletion authority, notification and reversal                                                                               | Any Cerbos `admin` may request deletion; every org admin gets a fixed-template email; reversal is a script that tombstones the marker and emits `catalog.audit.org_deletion_cancelled` with the operator id, under JIT access (Azure PIM) and a named second approver.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q28 | (VCDM re-run Q6, 2026-10-01) ACS authentication                                                                                                               | Connection string in Key Vault, on a dedicated send-only ACS resource restricted to the sender domain, rotation documented; a managed identity is a first-deployment gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q29 | (Drift Q-A, 2026-10-01) Org API keys by a non-owner admin                                                                                                     | The organization plugin's access control grants the `admin` role `apiKey` create/read/update/delete, and Better Auth is called headerless with `body.userId`; Cerbos stays the real gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q30 | (Drift Q-B, 2026-10-01) Where the identity operations live                                                                                                    | Orchestration in `apps/api` with structural ports in `@tayzu/auth` (the `UserSyncPort` pattern); pure parts (status machine, token, password policy, email port) stay in `packages/auth`. No new dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q31 | (Drift Q-C, 2026-10-01) The three existing identity procedures                                                                                                | `create`, `linkSsoAccount` and `unlinkSsoAccount` get HTTP routes and join the mounted set (fifteen routes), so their step-up is tested over HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q32 | (Drift Q-D, 2026-10-01) Invitation link origin                                                                                                                | `INVITATION_LINK_BASE_URL` (https outside test, must be one of `ALLOWED_ORIGINS`) with a fixed path; the link stays inert until `003` builds the page, documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q33 | (Drift Q-E, 2026-10-01) Emails the entity identifier cannot hold                                                                                              | Rejected with `CATALOG_VALIDATION_FAILED` in `invite` and `create`, documented; no `001` change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q34 | (VCDM re-run Q7, 2026-10-01) SEC11 answers                                                                                                                    | Q1 yes. Q2: one clickable link, the invitation-accept link, unavoidable for a no-account invitee, mitigated by a fragment token, single use, 48-hour expiry and a configured origin. Q3 yes, only the recipient address varies. Q4 no attachments. Q5 fixed template, validated recipient.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q35 | (Amendment Open Question 1, 2026-10-01) Role for the deletion-reversal script                                                                                 | A dedicated `tayzu_deletion_admin` role that may only tombstone a pending marker (update `state` and the cancellation fields), created in migration `0013` (Checkpoint 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q36 | (Amendment Open Question 2, M11, 2026-10-01) Forcing change and expiry of temporary and bootstrap passwords                                                   | A marker row in `auth.verification` (no migration), read by the resolver: a session whose user holds an unexpired marker reaches only `/change-password`; an expired marker blocks sign-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Q37 | (Amendment Open Question 3, M15, 2026-10-01) Unreachable `Inherited` ownership                                                                                | Fail closed: a non-admin cannot update an entity whose ownership is declared inherited until the chain is implemented; the catalog spec is corrected afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q38 | (Re-run H1/drift B1, 2026-10-01) Verified email for existing-account acceptance                                                                               | The "verified" condition is dropped. Acceptance still requires a session of the same account, email equality, the valid token, the CSRF header and origin check, and step-up for an `admin` role; on success `emailVerified` is set, since the token proves the mailbox.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q39 | (Re-run H2, 2026-10-01) New-account `admin` invitations                                                                                                       | The residual is accepted, and every other org admin gets a fixed-template notice (no link, no free text) when an `admin`-role invitation is accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q40 | (Re-run H3, VCDM B1, 2026-10-01) Credentials per service account                                                                                              | Exactly one active credential per service account: `credentials.create` refuses to bind to a service account with an active credential, a revoked credential may be rotated only when none is active, and rotation is serialized per service account. Deleting a service account revokes every bound credential; the resolver and token exchange reject a token whose bound `_user` is absent or not `Active`.                                                                                                                                                                                                                                                                                        |
| Q41 | (Re-run H4, 2026-10-01) Where the reversal script and the `_user` backfill run                                                                                | A manual `workflow_dispatch` GitHub Actions workflow with environment-required reviewers starts an Azure Container Apps Job through OIDC, enforcing the second approver and recording the operator identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q42 | (Drift B2, 2026-10-01) How `invite` reaches Better Auth                                                                                                       | The admin's session headers are forwarded into `auth.api.createInvitation` (headers in the context, like the step-up headers); re-invite cancel, the invitation limit and the hooks stay Better Auth's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q43 | (Drift B3, 2026-10-01) OpenAPI document for the identity routes                                                                                               | A second committed document, `openapi/identity.openapi.json`, generated in `apps/api` with its own `contract:generate` and `contract:check`; the `x-tayzu-risk` assertions run on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q44 | (Drift B4, 2026-10-01) Per-key API rate limit                                                                                                                 | 60 verifications per hour per key, configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q45 | (VCDM B2, 2026-10-01) Mandatory authorization in the identity router                                                                                          | A `defineIdentityOperation({ authorization, handler })` wrapper resolves the target server-side, calls Cerbos and emits `authz_denied`; a test forbids a bare handler; a route-table-driven HTTP matrix covers each of the 14 oRPC routes (admin allowed, member 403, machine token 403, unauthenticated 401, foreign target 404).                                                                                                                                                                                                                                                                                                                                                                    |
| Q46 | (Amendment Open Question, 2026-10-01) A human member with no `_user` row in the active tenant | `resolveContext` rejects it (fail closed); the `_user` backfill runs before the first deployment so no legitimate member is locked out. |
| Q47 | (Amendment choices confirmed by the human, 2026-10-01) Details settled while applying Q38-Q45 | (1) An acceptance request with no `Origin` header is rejected. (2) The org-deletion confirmation travels in the query (`?confirmation=`), which telemetry already drops. (3) Rotation is also serialized per credential for integrations with no service account. (4) Invitation cancel uses Better Auth's `cancelInvitation` with the admin's forwarded session headers, like `invite` (Q42). |

## Open Questions

None. The last open question was answered on 2026-10-01 (Q46).
