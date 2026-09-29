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

Cerbos knows four fixed resource kinds (constants in
`packages/authz/src/resource-kinds.ts`). Blueprints do not get a kind each:
the blueprint is an attribute of the entity resource.

| Kind                | What it stands for                    | Attributes sent to Cerbos                                                                                       |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `catalog_blueprint` | A blueprint (a tenant-defined type)   | `tenantId`                                                                                                      |
| `catalog_entity`    | An entity of any blueprint            | `tenantId`, `blueprintId`, `ownerTeam` (absent when the entity has no owner, never null), `createdBy`, `locked` |
| `team`              | A team (the `_team` system blueprint) | `tenantId`                                                                                                      |
| `user`              | A user (the `_user` system blueprint) | `tenantId`                                                                                                      |

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

| Operation                                                          | Kind                | Cerbos action                                             |
| ------------------------------------------------------------------ | ------------------- | --------------------------------------------------------- |
| `blueprints.create`                                                | `catalog_blueprint` | `create`                                                  |
| `blueprints.get`                                                   | `catalog_blueprint` | `view`                                                    |
| `blueprints.list`                                                  | `catalog_blueprint` | `list`                                                    |
| `blueprints.update`                                                | `catalog_blueprint` | `update`                                                  |
| `blueprints.delete`                                                | `catalog_blueprint` | `delete`                                                  |
| `entities.create`                                                  | `catalog_entity`    | `create`                                                  |
| `entities.get`, `entities.listRelated`                             | `catalog_entity`    | `view`                                                    |
| `entities.list`                                                    | `catalog_entity`    | `list` (a query plan folded into the tenant-scoped query) |
| `entities.upsert`, `entities.writeStatus`                          | `catalog_entity`    | `update`                                                  |
| `entities.delete`                                                  | `catalog_entity`    | `delete`                                                  |
| `identity.users.create`                                            | `user`              | `create`                                                  |
| `identity.users.linkSsoAccount`, `identity.users.unlinkSsoAccount` | `user`              | `update`                                                  |

The `identity.*` procedures are called in-process only. No HTTP route mounts
them. Where an operation names an entity the caller cannot read, the error
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
is `sign_in`, `two_factor_verify` or `token_exchange`.
`tayzu.auth.backchannel_logout.outcome` is `revoked`, `replay`, `invalid` or
`no_match`. `tayzu.auth.link.actor` is `self` or `admin`.
`tayzu.auth.credential.kind` is `integration` or `agent`.

### Log events

| Event                                       | Severity | Attributes                                                                                                 | Purpose                                                          |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `auth.security.login_succeeded`             | INFO     | `tayzu.actor.id`, `tayzu.tenant.id` when the session has an active organization                            | Authentication audit trail                                       |
| `auth.security.login_failed`                | WARN     | `tayzu.auth.failure_reason`                                                                                | Brute-force and misuse signal                                    |
| `auth.security.session_revoked`             | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.revocation.reason`                                        | Session revocation audit trail                                   |
| `catalog.security.authz_denied`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action` | Tells a Cerbos deny apart from a validation error or a not-found |
| `auth.security.step_up_required`            | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.catalog.operation`                                             | High-risk operation friction and misuse                          |
| `auth.security.step_up_insufficient`        | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.method`                                                   | A Visma Connect re-authorization did not meet the threshold      |
| `auth.security.token_exchange_failed`       | WARN     | `tayzu.auth.credential.kind`                                                                               | Machine-credential abuse signal                                  |
| `auth.security.revoked_token_rejected`      | WARN     | `tayzu.tenant.id`, `tayzu.auth.credential.kind`                                                            | Confirms revocation reaches an already-issued token              |
| `auth.security.rate_limited`                | WARN     | `tayzu.auth.rate_limit.scope`                                                                              | Pre-authentication brute-force signal, no IP or email            |
| `auth.security.sso_sign_in_failed`          | WARN     | `tayzu.auth.failure_reason`                                                                                | Why a Visma Connect sign-in was rejected, internally only        |
| `auth.security.account_linked`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor`                                               | Account-linking audit trail                                      |
| `auth.security.account_unlinked`            | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor`                                               | Account-linking audit trail                                      |
| `auth.security.backchannel_logout_received` | INFO     | `tayzu.auth.backchannel_logout.outcome`                                                                    | Back-channel logout audit trail, no `sub`, `sid` or session id   |

`tayzu.auth.failure_reason` is `bad_credentials`, `mfa_failed` or
`account_disabled` on `login_failed`, and `sso_unlinked`, `sso_state_mismatch`
or `sso_token_invalid` on `sso_sign_in_failed`. It is the only place the real
cause of an SSO rejection is recorded, because the HTTP response never says.

Every log event above, and the catalog's own `catalog.security.*` events,
must never be sampled, filtered or dropped by a downstream pipeline.
