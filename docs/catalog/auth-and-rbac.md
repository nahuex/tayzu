# Authentication and authorization

Authentication (`@tayzu/auth`, Better Auth) and authorization (`@tayzu/authz`,
Cerbos) are OpenSpec change
[`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md). They
sit in front of the catalog described in [Catalog core](catalog-core.md).
Every catalog operation, whether it comes from a human, an agent or an
integration, passes through exactly one authentication resolver
(`resolveContext`) and exactly one authorization engine (Cerbos). Where the
implementation and an older sentence in the design differ, this page describes
the implementation.

The per-route view (who can reach what, and how it is checked) is in
[Attack surfaces](../security/attack-surfaces.md).

## How a request becomes a decision

1. `apps/api` receives the request. Anything under `/api/auth/*` that is not
   on the route allowlist gets `404` before Better Auth is reached.
2. `resolveContext` turns the credential into a catalog context
   `{ tenantId, actor, principal }`. Nothing in the body, path, query string
   or a header is ever read for `tenantId`, `actor` or `actor.onBehalfOf`.
3. The catalog operation pipeline validates the context, then asks Cerbos
   (`CheckResources`, or `PlanResources` for `entities.list`). A deny raises
   `AUTH_FORBIDDEN` before any database work.
4. The operation opens a tenant transaction that sets `app.tenant_id`, and
   PostgreSQL row-level security applies as the last layer
   ([ADR-0014](../adr/0014-postgres-roles-and-forced-rls.md)).

`actor.type` is data. Cerbos receives the same kind of attributes for every
actor, and no code path branches on it except step-up, which applies to
`user` actors only.

### Credentials and sign-in methods

| Caller               | Credential                                                     | Resolves to                                                                           |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Human, local sign-in | Better Auth session cookie (email and password, optional TOTP) | `{ tenantId: activeOrganizationId, actor: { type: 'user', id } }`                     |
| Human, Visma Connect | The same session cookie, established through Visma Connect     | The same shape as a local sign-in                                                     |
| Agent or integration | `Authorization: Bearer` machine access token                   | `{ tenantId, actor: { type: 'agent' \| 'integration', id } }` from the token's claims |

A request with no credential, a session with no active organization, an
expired or invalid token, a revoked machine credential, or a failed
membership re-check all fail exactly as `CATALOG_CONTEXT_REQUIRED`. There is
no second "unauthenticated" code.

- **Sessions** last 7 days on a rolling basis and expire after 12 hours of
  inactivity. Changing a password revokes every other session.
- **The tenant** is the session's active organization. `resolveContext`
  re-checks that the user is still a member of it, through a cache of at most
  5 seconds, and fails closed.
- **Sign-up is disabled.** Users are created only by an admin
  (`identity.users.create`, in-process) or by the bootstrap script for an
  organization's first admin. The temporary password is shown once and never
  emailed.
- **Visma Connect** is a second, non-exclusive sign-in method
  ([ADR-0021](../adr/0021-visma-connect-as-primary-idp.md)). A Tayzu user is
  linked to a Visma Connect account only by its immutable `sub`, never by
  email. A failed sign-in is always the same `401 AUTH_SSO_REJECTED`.
- **Machine credentials** are exchanged for 1-hour access tokens, always with
  the `member` role, and revoking one takes effect within 5 seconds
  ([ADR-0016](../adr/0016-machine-credential-token-exchange.md)).
- **Step-up.** An operation marked `x-tayzu-risk: high` needs a fresh
  verification (within 5 minutes) when a `user` actor calls it. A local
  session uses its TOTP. A session established through Visma Connect
  delegates to Visma Connect, and the returned `auth_time`, `acr` and `amr`
  are validated on the server. Agents, integrations and the system are not
  gated by step-up. The marked operations are `blueprints.update`,
  `blueprints.delete` and `entities.delete`.

## Resource kinds

Cerbos knows six fixed resource kinds (constants in
`packages/authz/src/resource-kinds.ts`). Blueprints do not get a kind each:
the blueprint is an attribute of the entity resource. Change
[`043-identity-lifecycle-and-org-admin`](../../openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/design.md)
(D3) added `service_account` and `credential`.

| Kind                | What it stands for                                       | Attributes sent to Cerbos                                                                                                 |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `catalog_blueprint` | A blueprint (a tenant-defined type)                      | `tenantId`                                                                                                                |
| `catalog_entity`    | An entity of any blueprint                               | `tenantId`, `blueprintId`, `ownerTeam` (absent when the entity has no owner, never null), `createdBy`, `locked`           |
| `team`              | A team (the `_team` system blueprint)                    | `tenantId`                                                                                                                |
| `user`              | A user (the `_user` system blueprint)                    | `tenantId`. The identity operations also send `accountKind`, and `portRole` and `moderatedBlueprints` when they are known |
| `service_account`   | A service account (a `_user` of `accountKind` `service`) | `tenantId`, `accountKind` (always `service` for a valid target)                                                           |
| `credential`        | An organization API credential (a Better Auth `apikey`)  | `tenantId`                                                                                                                |

For the identity kinds the attributes describe the target, resolved on the
server (D14): `tenantId` is the target's real tenant, never the caller's
echoed back. The resource id is opaque: the literal `new` for `invite`,
`users.create`, `serviceAccounts.create` and `credentials.create`, the
literal `list` for `credentials.list`, the invitation id for cancel and
resend, the Better Auth user id (or the `svc-…` identifier of a service
account) for a status change, a service-account deletion and an SSO link or
unlink, and the `apikey` id for rotate and revoke. An email is never a
resource id, so it never reaches Cerbos's decision log.

The principal carries `tenantId`, `roles`, `teams` and `moderatedBlueprints`.
It is filled only by `resolveContext`. A missing or empty principal is a
deny, never a default role.

## Role and ownership model

### Roles

| Cerbos role | Source                                             | Notes                                                   |
| ----------- | -------------------------------------------------- | ------------------------------------------------------- |
| `admin`     | Better Auth `owner` or `admin`                     | May do everything on every kind, inside its own tenant. |
| `member`    | Better Auth `member`, and every machine credential | The baseline. Machine credentials are never `admin`.    |

**Moderator is not a role.** A principal moderates a blueprint when that
blueprint's identifier is in the principal's `moderatedBlueprints`, a list on
its `_user` entity. It is a per-blueprint grant.

**Team ownership** is resolved by the catalog service, not by Cerbos, before
each check. An entity's effective owner team is `None`, its own team relation
(`Direct`), or a team read along the blueprint's declared relation chain
(`Inherited`). If a blueprint has both, `Direct` wins.

### Policies

Role policies are a **ceiling**: an action reaches a principal only if the
role policy allows it and a resource-policy rule grants it. See
[ADR-0013](../adr/0013-cerbos-as-sole-authorization-engine.md). Each resource
policy starts with an explicit deny when `R.attr.tenantId != P.attr.tenantId`,
and imports the `same_tenant` derived role, so a rule that forgets a tenant
check still cannot cross tenants. Tenancy is a plain attribute, not a Cerbos
scope ([ADR-0015](../adr/0015-cerbos-dynamic-context-not-scoped-policies.md)).

| Kind                | `admin` | `member`                                                                                                                                                                                         |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog_blueprint` | All     | `view`, `list`                                                                                                                                                                                   |
| `catalog_entity`    | All     | `view`, `list` on every entity of the tenant. `create` and `update` when the entity has no owner team. `delete` only where `createdBy` is the principal. Everything the derived roles below add. |
| `team`              | All     | `view`, `list`                                                                                                                                                                                   |
| `user`              | All     | `view`, `list`                                                                                                                                                                                   |
| `service_account`   | All     | None                                                                                                                                                                                             |
| `credential`        | All     | None                                                                                                                                                                                             |

The new content of change 043 on `user` is two explicit `EFFECT_DENY` rules
(an allow cannot narrow the admin's `*`): `updateStatus` is denied when the
target is the caller (`R.id == P.id`), and every action is denied on a
service account whose resulting `portRole` is not `member` or whose
`moderatedBlueprints` is not empty. `service_account` denies every action
unless the resolved target's `accountKind` is `service`, so a route of that
kind can never act on a human. Both new policies carry the explicit
cross-tenant deny of every resource policy.

Derived roles on `catalog_entity`:

| Derived role          | Condition                                                              | Grants                               |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `owning_team_member`  | The entity's `ownerTeam` is in the principal's `teams`                 | `view`, `update`, `create`           |
| `moderates_blueprint` | The entity's `blueprintId` is in the principal's `moderatedBlueprints` | Every action the role ceiling allows |

Two dynamic attribute rules are worked examples of the same pattern:

- **Grant.** A member may `delete` an entity whose `createdBy` is their own
  id, although the member role alone does not grant `delete`.
- **Deny.** A non-admin may not `update` an entity whose `locked` is `true`.
  This covers `update`, upsert and status writes, because all three ask for
  the `update` action. An admin still can.

A Cerbos evaluation error denies the action (`strictEvaluation: true`), so
the system fails closed rather than open. Policies are compiled and tested
with `pnpm policy:compile`, and every policy change is a Checkpoint 3 review.

### Action each operation asks for

| Operation                                                            | Kind                | Cerbos action                                             |
| -------------------------------------------------------------------- | ------------------- | --------------------------------------------------------- |
| `blueprints.create`                                                  | `catalog_blueprint` | `create`                                                  |
| `blueprints.get`                                                     | `catalog_blueprint` | `view`                                                    |
| `blueprints.list`                                                    | `catalog_blueprint` | `list`                                                    |
| `blueprints.update`                                                  | `catalog_blueprint` | `update`                                                  |
| `blueprints.delete`                                                  | `catalog_blueprint` | `delete`                                                  |
| `entities.create`                                                    | `catalog_entity`    | `create`                                                  |
| `entities.get`, `entities.listRelated`                               | `catalog_entity`    | `view`                                                    |
| `entities.list`                                                      | `catalog_entity`    | `list` (a query plan folded into the tenant-scoped query) |
| `entities.upsert`, `entities.writeStatus`                            | `catalog_entity`    | `update`                                                  |
| `entities.delete`                                                    | `catalog_entity`    | `delete`                                                  |
| `identity.users.create`                                              | `user`              | `create`                                                  |
| `identity.users.invite`                                              | `user`              | `invite`                                                  |
| `identity.users.cancelInvitation`, `identity.users.resendInvitation` | `user`              | `invite`                                                  |
| `identity.users.setStatus`                                           | `user`              | `updateStatus`                                            |
| `identity.users.linkSsoAccount`, `identity.users.unlinkSsoAccount`   | `user`              | `update`                                                  |
| `identity.serviceAccounts.create`                                    | `service_account`   | `create`                                                  |
| `identity.serviceAccounts.delete`                                    | `service_account`   | `delete`                                                  |
| `identity.credentials.list`                                          | `credential`        | `list`                                                    |
| `identity.credentials.create`                                        | `credential`        | `create`                                                  |
| `identity.credentials.rotate`                                        | `credential`        | `rotate`                                                  |
| `identity.credentials.revoke`                                        | `credential`        | `revoke`                                                  |

The identity actions are all gated to the `admin` role. The public
invitation acceptance is not an `identity.*` procedure and has no Cerbos
check: it authenticates by the invitation token (change 043, D4).

The `identity.*` procedures are called in-process. Their routes are mounted
over HTTP only when `MOUNT_IDENTITY_ROUTES` is `true` (off by default, 043
D15). Where an operation names an entity the caller cannot read, the error
lists only the readable identifiers and rolls the rest into a `+N not
visible` count.

## Error codes

| Code                       | HTTP | Meaning                                                                                                                                               |
| -------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CATALOG_CONTEXT_REQUIRED` | 401  | No valid context was established: no or invalid credential, no active organization, a failed membership re-check, or a revoked or unverifiable token. |
| `AUTH_FORBIDDEN`           | 403  | Cerbos denied the action inside the caller's own tenant.                                                                                              |
| `AUTH_STEP_UP_REQUIRED`    | 403  | The action needs a fresh MFA verification, or a fresh Visma Connect re-authorization for a session it established.                                    |
| `AUTH_INVALID_CREDENTIALS` | 401  | The machine-token exchange rejected the client id and secret. Unknown, wrong and revoked look the same.                                               |
| `AUTH_RATE_LIMITED`        | 429  | A rate limit was exceeded. The response carries `Retry-After`.                                                                                        |
| `AUTH_SSO_REJECTED`        | 401  | A Visma Connect sign-in failed. One identical response for an unlinked account, a `state` mismatch and an invalid token.                              |
| `CATALOG_NOT_FOUND`        | 404  | The target does not exist, **or belongs to another tenant**. The two are indistinguishable.                                                           |

An in-tenant deny (`AUTH_FORBIDDEN`) is deliberately different from a
cross-tenant access (`CATALOG_NOT_FOUND`), so denies stay visible in the
audit trail without confirming that another tenant's data exists. The
catalog's own codes (`CATALOG_VALIDATION_FAILED`, `CATALOG_ALREADY_EXISTS`
and the rest) are listed in [Catalog core](catalog-core.md#errors). Any error
that has no table code becomes a generic `INTERNAL` (500) with no detail.

## Telemetry

The executable mirror of the contract below is
`packages/authz/src/telemetry/contract.ts`, checked by its `contract.test.ts`
and exercised by `pnpm otel-smoke-check`. `@tayzu/auth` keeps its own,
narrower `packages/auth/src/telemetry/contract.ts` for the signals it emits
itself. The catalog's own signals are in [Catalog core](catalog-core.md#telemetry).

Forbidden on every signal: property values, titles, descriptions, validation
messages and SQL bind values, plus client secrets, access, session and ID
tokens, TOTP and backup codes, the Visma Connect `sub` and `sid`, and the
caller's email address and IP address, in raw, hashed or partial form.
Attributes are closed enums or shared keys, and identifiers are never metric
attributes.

### Spans

| Span                               | When                                                          | Required attributes                               | Conditional attributes                  |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| `authz.check`                      | Child of every catalog operation span, before the transaction | `tayzu.authz.resource.kind`, `tayzu.authz.action` | `tayzu.authz.cerbos.call_id`            |
| `authz.plan`                       | Child, for `entities.list` only                               | `tayzu.authz.resource.kind`                       | `tayzu.authz.plan.kind`                 |
| `auth.token.exchange`              | Machine-token exchange                                        | `tayzu.auth.credential.kind`                      | none                                    |
| `auth.session.step_up_check`       | A `user` actor invokes an `x-tayzu-risk: high` operation      | `tayzu.auth.method`                               | `tayzu.auth.step_up.fresh`              |
| `auth.sso.callback`                | Every Visma Connect callback request                          | `tayzu.auth.method`                               | `tayzu.auth.sso.outcome`                |
| `auth.backchannel_logout.received` | Every back-channel logout request                             | none                                              | `tayzu.auth.backchannel_logout.outcome` |

### Metrics

| Metric                                 | Instrument, unit      | Allowed attributes                                                                           | Purpose                                           |
| -------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `tayzu.authz.decisions`                | Counter, `{decision}` | `tayzu.tenant.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action`, `tayzu.authz.decision` | Authorization volume and deny rate                |
| `tayzu.authz.check.duration`           | Histogram, `s`        | `tayzu.authz.resource.kind`                                                                  | Cerbos call latency                               |
| `tayzu.auth.session.events`            | Counter, `{event}`    | `tayzu.auth.event`                                                                           | Authentication security signal                    |
| `tayzu.auth.mfa.events`                | Counter, `{event}`    | `tayzu.auth.event`                                                                           | MFA usage and failure signal                      |
| `tayzu.auth.step_up.required`          | Counter, `{event}`    | `tayzu.catalog.operation`                                                                    | Step-up friction signal                           |
| `tayzu.auth.token.exchanges`           | Counter, `{exchange}` | `tayzu.auth.credential.kind`, `tayzu.auth.exchange.outcome`                                  | Machine-credential usage and abuse signal         |
| `tayzu.auth.rate_limit.events`         | Counter, `{event}`    | `tayzu.auth.rate_limit.scope`                                                                | Pre-authentication brute-force signal             |
| `tayzu.auth.token.revocation_checks`   | Counter, `{check}`    | `tayzu.auth.credential.kind`, `tayzu.auth.revocation.result`                                 | Revocation-check volume and fail-closed signal    |
| `tayzu.auth.sso.events`                | Counter, `{event}`    | `tayzu.auth.event`                                                                           | Visma Connect sign-in volume and rejection signal |
| `tayzu.auth.account_link.events`       | Counter, `{event}`    | `tayzu.auth.event`, `tayzu.auth.link.actor`                                                  | Account-linking audit signal                      |
| `tayzu.auth.backchannel_logout.events` | Counter, `{event}`    | `tayzu.auth.backchannel_logout.outcome`                                                      | Back-channel logout volume and replay signal      |

Values of the closed enums: `tayzu.authz.decision` is `allow` or `deny`.
`tayzu.auth.method` is `local` or `visma_connect`. `tayzu.auth.rate_limit.scope`
is `sign_in`, `two_factor_verify` or `token_exchange`, plus the six values
change 043 adds (see [Amendments by change 043](#amendments-by-change-043)).
`tayzu.auth.backchannel_logout.outcome` is `revoked`, `replay`, `invalid` or
`no_match`. `tayzu.auth.link.actor` is `self` or `admin`.
`tayzu.auth.credential.kind` is `integration` or `agent`.

### Log events

| Event                                       | Severity | Attributes                                                                                                 | Purpose                                                             |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `auth.security.login_succeeded`             | INFO     | `tayzu.actor.id`, `tayzu.tenant.id` when the session has an active organization                            | Authentication audit trail                                          |
| `auth.security.step_up_succeeded`           | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.method` (`local`)                                         | A fresh step-up verification on an existing session, not a login    |
| `auth.internal_error`                       | ERROR    | `error.type`, `db.response.status_code` (SQLSTATE) when present                                            | An unmapped error, sanitized: no message, stack text or bind values |
| `auth.security.login_failed`                | WARN     | `tayzu.auth.failure_reason`                                                                                | Brute-force and misuse signal                                       |
| `auth.security.session_revoked`             | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.revocation.reason`                                        | Session revocation audit trail                                      |
| `catalog.security.authz_denied`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action` | Tells a Cerbos deny apart from a validation error or a not-found    |
| `auth.security.step_up_required`            | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.catalog.operation`                                             | High-risk operation friction and misuse                             |
| `auth.security.step_up_insufficient`        | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.method`                                                   | A Visma Connect re-authorization did not meet the threshold         |
| `auth.security.token_exchange_failed`       | WARN     | `tayzu.auth.credential.kind`                                                                               | Machine-credential abuse signal                                     |
| `auth.security.revoked_token_rejected`      | WARN     | `tayzu.tenant.id`, `tayzu.auth.credential.kind`                                                            | Confirms revocation reaches an already-issued token                 |
| `auth.security.rate_limited`                | WARN     | `tayzu.auth.rate_limit.scope`                                                                              | Pre-authentication brute-force signal, no IP or email               |
| `auth.security.sso_sign_in_failed`          | WARN     | `tayzu.auth.failure_reason`                                                                                | Why a Visma Connect sign-in was rejected, internally only           |
| `auth.security.account_linked`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor`                                               | Account-linking audit trail                                         |
| `auth.security.account_unlinked`            | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor`                                               | Account-linking audit trail                                         |
| `auth.security.backchannel_logout_received` | INFO     | `tayzu.auth.backchannel_logout.outcome`                                                                    | Back-channel logout audit trail, no `sub`, `sid` or session id      |

`tayzu.auth.failure_reason` is `bad_credentials`, `mfa_failed` or
`account_disabled` on `login_failed`, and `sso_unlinked`, `sso_state_mismatch`
or `sso_token_invalid` on `sso_sign_in_failed`. It is the only place the real
cause of an SSO rejection is recorded, because the HTTP response never says.

`tayzu.auth.revocation.reason` is `password_change` or `admin_action` as
`002` declares them, plus `sso_link_shed` (see below).

Every log event above, and the catalog's own `catalog.security.*` events,
must never be sampled, filtered or dropped by a downstream pipeline.

### Amendments by change 043

Change 043 amends two closed enums that `002` declared. Neither executable
telemetry contract enumerates the values (the authz contract lists attribute
keys only), so no contract assertion changes. The values are listed in
`IDENTITY_ATTRIBUTE_VALUES` of the identity contract module and in the
`RateLimitScope` union of `packages/auth/src/rate-limit/pre-auth-rate-limit.ts`.

**Rate-limit scope.** `tayzu.auth.rate_limit.scope` was the closed three-value
enum `sign_in`, `two_factor_verify`, `token_exchange`. It gains six values:

| Scope                      | Limits                                             |
| -------------------------- | -------------------------------------------------- |
| `invitation_accept`        | The public invitation acceptance route             |
| `invitation_tenant`        | Invitations created or resent per tenant           |
| `invitation_recipient`     | Invitations sent to one recipient                  |
| `notice_tenant`            | Admin-accepted notices sent per tenant             |
| `notice_recipient`         | Admin-accepted notices sent to one recipient       |
| `reauthorization_callback` | The public Visma Connect re-authorization callback |

The generic helper reports a bucket denial on `002`'s existing
`tayzu.auth.rate_limit.events` metric and `auth.security.rate_limited` log
event with the new scope as the attribute value. There is no new instrument.
The invitation caps also log `catalog.security.invitation_rate_limited`
(below). A bucket key is stored only as a SHA-256 hash, the new `tenant` key
kind included.

**Session revocation reason.** `auth.security.session_revoked` declared the
closed two-value reason `password_change` and `admin_action`. It gains
`sso_link_shed`. `@tayzu/auth` now exports `emitSessionRevoked` with the
reason as a parameter. `002`'s code only ever emitted `password_change`; since
change 043 `identity.users.setStatus` emits `admin_action`, and the SSO link
shed and an admin unlink emit `sso_link_shed`.

### Identity lifecycle signals (change 043)

The names below live in the identity contract module
`packages/auth/src/telemetry/identity-contract.ts`, not in
`packages/auth/src/telemetry/contract.ts` (change 043, Resolved decision Q74):
the older file must equal the authz contract's `auth.*` subset and contain no
`catalog.` name. `otel-smoke-check` imports both modules. The tracer and meter
scope is `@tayzu/auth`. `apps/api` creates every span, counter and event
through helpers that `@tayzu/auth` exports. `catalog.security.authz_denied`
and `tayzu.authz.decisions` are reused from the tables above, and the identity
router now emits them on every Cerbos decision.

Forbidden here, as on every signal: invited emails, invitation tokens,
credential names and secrets, and the SSO `sub`. A `svc-…` identifier is the
account's opaque id and is allowed in the identity signals.

#### Identity spans

All are `INTERNAL`, one per operation.

| Span                              | When               | Required attributes                                                                                                     |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `identity.invitation.create`      | Operation          | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role`                                                        |
| `identity.invitation.accept`      | Operation          | `tayzu.identity.invitation.id`                                                                                          |
| `identity.invitation.cancel`      | Operation          | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                      |
| `identity.invitation.resend`      | Operation          | `tayzu.identity.invitation.id`                                                                                          |
| `identity.user.set_status`        | Operation          | `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`                                                      |
| `identity.service_account.create` | Operation          | `tayzu.identity.service_account.id`                                                                                     |
| `identity.service_account.delete` | Operation          | `tayzu.identity.service_account.id`                                                                                     |
| `identity.credential.list`        | Operation          | `tayzu.identity.credential.count`                                                                                       |
| `identity.credential.create`      | Operation          | `tayzu.identity.credential.kind`                                                                                        |
| `identity.credential.rotate`      | Operation          | `tayzu.identity.credential.kind`                                                                                        |
| `identity.credential.revoke`      | Operation          | `tayzu.identity.credential.kind`                                                                                        |
| `identity.user.reconcile`         | Maintenance script | `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.reconcile.created`, `tayzu.identity.reconcile.orphans` |

`tayzu.identity.invitation.id` is the constant `invalid` on
`identity.invitation.accept` for an id that fails its shape or length check.
`tayzu.identity.invitation.path` (`new_account` or `existing_account`) is a
conditional attribute of `identity.invitation.accept`.

#### Identity metrics

| Metric                                | Instrument, unit        | Allowed attributes                                                                        | Purpose                                 |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `tayzu.identity.invitations`          | Counter, `{invitation}` | `tayzu.tenant.id`, `tayzu.identity.invitation.mutation`                                   | Invitation funnel                       |
| `tayzu.identity.user_status_changes`  | Counter, `{change}`     | `tayzu.tenant.id`, `tayzu.identity.user.status.to`, `tayzu.actor.type`                    | Lifecycle churn                         |
| `tayzu.identity.service_accounts`     | Counter, `{account}`    | `tayzu.tenant.id`, `tayzu.identity.service_account.mutation`                              | Service-account volume                  |
| `tayzu.identity.credential_mutations` | Counter, `{mutation}`   | `tayzu.tenant.id`, `tayzu.identity.credential.kind`, `tayzu.identity.credential.mutation` | Credential hygiene signal               |
| `tayzu.identity.principal_rejections` | Counter, `{rejection}`  | `tayzu.identity.rejection.reason`, `tayzu.actor.type`                                     | Enforcement of "disabled means refused" |

Values of the closed enums, as the implementation settles them:

- `tayzu.identity.invitation.mutation` is `created`, `accepted`, `rejected`,
  `cancelled`, `expired` or `rate_limited`. `expired` is counted once per
  refused acceptance of an expired invitation, where
  `catalog.security.invitation_acceptance_denied` is logged with the denial
  reason `expired` (Better Auth never stores `expired`; it is derived from
  `expiresAt`), so one invitation tried three times counts three. `rejected`
  is declared but **not produced by change 043**: no reject path is reachable
  (Better Auth's reject endpoint is not on the `/api/auth` allowlist and no
  procedure calls it) until a later change adds one (Q143).
- `tayzu.actor.type` of `tayzu.identity.user_status_changes` is `user` when
  the principal of the status write is an admin, a user on a first sign-in or
  an invitee on an acceptance, and `system` for the reconcile, the bootstrap
  (both run as the `system` actor on behalf of the operator) and the ban hook
  (Q144).
- `tayzu.identity.service_account.mutation` is `created`, `disabled`,
  `enabled` or `deleted`.
- `tayzu.identity.credential.kind` is `service_account`, `integration` or
  `agent`, and `tayzu.identity.credential.mutation` is `created`, `rotated` or
  `revoked`. The key that `identity.serviceAccounts.create` issues counts as a
  `created` mutation of kind `service_account`, and the rotation and
  revocation of a service account's key carry the same kind. The keys of
  `identity.credentials.create` keep `integration` or `agent` (Q145).
- `tayzu.identity.rejection.reason` is `user_disabled` (a human `_user` that
  is present and not `Active`), `user_banned` (a human whose Better Auth user
  is `banned`), `service_account_disabled`, `service_account_missing` or
  `user_missing`.

#### Identity log events

Every event below is exempt from sampling and from any downstream filter or
drop rule, like the other `catalog.audit.*` and `catalog.security.*` events.
`tayzu.actor.id` of an audit event of an admin operation is the admin who
acted, never the `system` actor.

| Event                                                    | Severity | Attributes                                                                                                                                                                                                                                                             | Purpose                                                                    |
| -------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `catalog.audit.invitation_created`                       | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role`                                                                                                                                              | Audit, the role is logged                                                  |
| `catalog.audit.invitation_accepted`                      | INFO     | The same, plus `tayzu.identity.user.id` and `tayzu.identity.invitation.path`                                                                                                                                                                                           | Audit. The invitee is the actor: type `user`, id the invitee's user id     |
| `catalog.audit.invitation_cancelled`                     | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                                                                                                                                | Audit                                                                      |
| `catalog.audit.invitation_resent`                        | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`                                                                                                                                                                                | Audit                                                                      |
| `catalog.audit.user_created`                             | INFO     | `tayzu.tenant.id`, `tayzu.actor.id` (for source `bootstrap`, `tayzu.identity.operator.id` in its place), `tayzu.identity.user.id`, `tayzu.identity.user.role`, `tayzu.identity.user.source`                                                                            | Audit of `identity.users.create` and of the bootstrap                      |
| `catalog.audit.user_status_changed`                      | INFO     | `tayzu.tenant.id`, the principal of the write (see below), the subject id, `tayzu.identity.user.status.from` (absent for a row created with its first status), `tayzu.identity.user.status.to`, `tayzu.identity.user.status.event`, `tayzu.identity.user.account_kind` | Audit of every status change, service accounts included                    |
| `catalog.audit.service_account_created`                  | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id`                                                                                                                                                                                               | Audit                                                                      |
| `catalog.audit.service_account_deleted`                  | INFO     | The same                                                                                                                                                                                                                                                               | Audit                                                                      |
| `catalog.audit.credential_created`                       | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`, `tayzu.identity.credential.kind`                                                                                                                                                                  | Audit                                                                      |
| `catalog.audit.credential_rotated`                       | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                            | Audit, opaque ids only                                                     |
| `catalog.audit.users_reconciled`                         | INFO     | `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.reconcile.created`, `tayzu.identity.reconcile.orphans`                                                                                                                                                | The reconcile of one tenant, recorded with the operator's opaque id        |
| `catalog.security.invitation_acceptance_denied`          | WARN     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.denial_reason`                                                                                                                                                                                              | Misuse of dead or foreign invitations. The reason is never in the response |
| `catalog.security.invitation_rate_limited`               | WARN     | `tayzu.tenant.id`, `tayzu.identity.invitation.limit_scope`                                                                                                                                                                                                             | Invite and resend volume abuse, no email                                   |
| `catalog.security.self_status_change_denied`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                                                                                                                                    | Self-service status tampering                                              |
| `catalog.security.principal_rejected`                    | WARN     | `tayzu.identity.rejection.reason`, `tayzu.actor.type`                                                                                                                                                                                                                  | A principal that is not `Active`, or is missing, was refused               |
| `catalog.security.credential_revoked`                    | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`                                                                                                                                                                                                    | A revocation is security-relevant, not routine                             |
| `catalog.security.credential_rotation_incomplete`        | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                            | A rotation left two usable credentials or none                             |
| `catalog.security.admin_notice_failed`                   | WARN     | `tayzu.tenant.id`                                                                                                                                                                                                                                                      | The admin-accepted notice could not be sent. The acceptance goes on        |
| `catalog.security.notice_suppressed`                     | WARN     | `tayzu.tenant.id`, `tayzu.identity.notice.template`, `tayzu.identity.notice.suppression`, `tayzu.identity.notice.dropped`                                                                                                                                              | A notice was suppressed or truncated by a switch or a cap                  |
| `catalog.security.email_recipient_blocked`               | WARN     | `tayzu.identity.email.template`                                                                                                                                                                                                                                        | The recipient-domain allowlist refused a recipient, no address logged      |
| `catalog.security.email_tenant_blocked`                  | WARN     | `tayzu.tenant.id`, `tayzu.identity.email.template`                                                                                                                                                                                                                     | An email was suppressed for a tenant on `EMAIL_DISABLED_TENANT_IDS`        |
| `catalog.security.banned_sign_in_attempt`                | WARN     | `tayzu.identity.user.id`, `tayzu.identity.sign_in.channel`                                                                                                                                                                                                             | A banned user tried to sign in. The response stays uniform                 |
| `catalog.security.sso_link_shed`                         | WARN     | `tayzu.tenant.id`, `tayzu.identity.user.id`, `tayzu.identity.sso_link.path`                                                                                                                                                                                            | An admin-recorded SSO link was deleted and the user's sessions revoked     |
| `catalog.security.sso_link_marker_failed`                | WARN     | `tayzu.identity.user.id`                                                                                                                                                                                                                                               | The provenance marker of a user-made link could not be written             |
| `catalog.security.invitation_accept_compensation_failed` | WARN     | `tayzu.identity.invitation.id`                                                                                                                                                                                                                                         | A failed acceptance could not undo what it had created                     |
| `catalog.security.accepting_session_revocation_failed`   | WARN     | `tayzu.tenant.id`, `tayzu.identity.invitation.id`, `tayzu.identity.user.id`                                                                                                                                                                                            | The accepting session could not be revoked. An operator revokes it         |
| `catalog.security.identity_conflict_refused`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.conflict.reason`, `tayzu.identity.user.id` when the target account exists                                                                                                                                         | A conflict was refused with one generic answer. The cause lives only here  |

The principal of `catalog.audit.user_status_changed` is the admin as
`tayzu.actor.id` for `setStatus`, `invite`, `users.create` and
`serviceAccounts.create`; the operator as `tayzu.identity.operator.id` in its
place for the reconcile and the bootstrap; the user's own id as
`tayzu.actor.id` for the first sign-in; the invitee for an acceptance; and
neither for the ban hook. The subject is `tayzu.identity.user.id`, or
`tayzu.identity.service_account.id` for a service account, or
`tayzu.identity.invitation.id` for the `created_invited` write of an
invitation (the invited email may have no user yet).
`tayzu.identity.user.status.event` is `created_staged`, `created_invited`,
`created_active`, `invitation_accepted`, `first_sign_in`, `admin_disable` or
`admin_enable`, so a self-activation is told apart from an admin action.

Values of the other closed enums:

- `tayzu.identity.invitation.role`: `member` or `admin`.
- `tayzu.identity.invitation.reason`: `admin_cancel`, `re_invite`,
  `user_disabled`, `inviter_disabled` or `user_created`.
- `tayzu.identity.invitation.path`: `new_account` or `existing_account`.
- `tayzu.identity.invitation.limit_scope`: `tenant`, `recipient` or `global`.
- `tayzu.identity.invitation.denial_reason`: `malformed_request`, `expired`,
  `cancelled`, `rejected`, `already_accepted`, `token_mismatch`,
  `disabled_user`, `not_found`, `session_required`, `email_mismatch`,
  `account_conflict`, `csrf_rejected`, `origin_rejected`,
  `inviter_not_active_admin`, `member_limit` or `consume_conflict`.
- `tayzu.identity.user.role`: `member` or `admin`. `tayzu.identity.user.source`:
  `admin` or `bootstrap`.
- `tayzu.identity.notice.template`: `admin_accepted`.
  `tayzu.identity.notice.suppression`: `global`, `tenant`, `recipient` or
  `truncated`. `tayzu.identity.email.template`: `invitation` or
  `admin_accepted`.
- `tayzu.identity.sign_in.channel`: `local` or `sso`.
  `tayzu.identity.sso_link.path`: `acceptance`, `membership_hook` or
  `reconcile`.
- `tayzu.identity.conflict.reason`: `account_exists`,
  `target_in_other_tenant`, `sub_already_linked` or `target_is_admin_or_owner`.

`auth.security.login_failed` is reused unchanged: a banned sign-in logs the
reason `account_disabled` that `002` already declared, so the response is the
same as for bad credentials and the cause is visible only internally.

Catalog spans and audit events never carry a `_user` identifier (it is a
member's email): they carry one fixed placeholder instead. That rule is in
[Catalog core](catalog-core.md#telemetry).

### Exporting traces (OpenTelemetry SDK)

`apps/api` starts the OpenTelemetry SDK in `main.ts`, before the app is
built, and only when `OTEL_EXPORTER_OTLP_ENDPOINT` (or one of the
`OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` variables) is set. It
exports traces, metrics and logs over OTLP/HTTP. The HTTP instrumentation
records no bodies and no headers, and the pg instrumentation runs with
`enhancedDatabaseReporting: false`, so no bind value is exported.

Manual smoke script (one trace from an inbound request to its Postgres span):

1. Start any OTLP/HTTP collector or trace UI, for example Jaeger:
   `docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one`.
2. Start the API with the usual environment plus
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and
   `OTEL_SERVICE_NAME=tayzu-api`, with `pnpm --filter @tayzu/api start`.
3. Send a request that reaches the database, for example
   `curl -i -X POST http://localhost:3000/api/auth/sign-in/email -H 'content-type: application/json' -H 'origin: <allowed origin>' -d '{"email":"nobody@example.test","password":"x"}'`.
4. Open the UI at `http://localhost:16686`, pick the `tayzu-api` service and
   open the latest trace. It has one `POST` server span with a `pg.query`
   child span below it, all in the same trace.
5. Check that no span attribute holds the email, the password, a cookie or a
   token.
