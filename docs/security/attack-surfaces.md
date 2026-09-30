# Attack surfaces

SSA section SEC02, for `002-auth-and-rbac` (VCDM pre-assessment, ticket 6;
design D13, D18, D22-D26). It lists every route the API application
(`apps/api`) exposes, with the actor category that reaches it, how the caller
is authenticated, and which authorization check applies. The system diagram
in [`docs/architecture/system-diagram.md`](../architecture/system-diagram.md)
uses the same surface names.

## How this list was derived

From the code, not from the design. The routes are those that
`createApp` in `apps/api/src/server.ts` registers, plus the two route lists
they read from: `ALLOWED_AUTH_ROUTES` in
`packages/auth/src/http/allowed-routes.ts` and the catalog contract in
`packages/catalog/src/api/contract.ts`. The authorization column is read from
`policies/` and from each operation's `authorization` declaration. Where the
code and the design differ, this page follows the code and the difference is
listed under [Where the code differs from the design](#where-the-code-differs-from-the-design).

`createApp` registers these route groups and nothing else:

1. `GET /healthz`, liveness only.
2. `ALL /api/auth/*`, guarded by the allowlist below.
3. `POST /v1/auth/visma-connect/backchannel-logout`.
4. `GET` and `POST /v1/auth/visma-connect/reauthorize/callback`, the SSO
   step-up re-authorization callback.
5. `POST /v1/auth/token`, the machine credential exchange.
6. `ALL /v1/*`, which is the catalog `OpenAPIHandler`.
7. Fastify's own `404` for every other path.

There is no readiness, metrics, documentation or OpenAPI-serving route.
`apps/api/src/main.ts` is the process entry point: it starts the OpenTelemetry
SDK, builds the app with `createAppFromEnv` and listens on `HOST` and `PORT`.

## Actor categories

| Category               | Who                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Anonymous              | A caller with no credential yet: someone signing in, or a script probing the API.               |
| `user`                 | A human with a Better Auth session cookie, signed in locally or through Visma Connect.          |
| `agent`, `integration` | A machine holding an access token exchanged from a machine credential.                          |
| Visma Connect          | The external identity provider, calling Tayzu or redirecting a browser back to it.              |
| `system`               | Tayzu's own automation. Never reachable over HTTP and never mapped from an external credential. |

## Controls that apply before a route runs

State as `createAppFromEnv` (the only production bootstrap) wires them.
`createApp` alone enables a limiter only when the host passes its option; the
defaults below come from `apps/api/src/config.ts`, and the environment only
tunes them (see [Secrets](secrets.md#rate-limits-and-request-size)).

| Control                        | Applies to                                                                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security headers (`helmet`)    | Every route                                                                       | On. HSTS for one year with subdomains. No CSP (this is a JSON API, `003`'s concern).                                                                                                                                                                                                                                                                                                                                                      |
| `Cache-Control: no-store`      | Every response, including Fastify's `404`                                         | On, unless the handler already set its own `Cache-Control` (Better Auth's `get-session` does).                                                                                                                                                                                                                                                                                                                                            |
| CORS                           | Every route                                                                       | On. Exact-match origin allowlist from `ALLOWED_ORIGINS`, credentials only for an allowed origin, no CORS headers for any other. Outside test, startup fails unless every origin is `https` and wildcard-free.                                                                                                                                                                                                                             |
| Origin check and cookies       | `/api/auth/*`                                                                     | On in every environment: `disableOriginCheck: false`, `useSecureCookies: true`, and `ALLOWED_ORIGINS` as Better Auth's trusted origins.                                                                                                                                                                                                                                                                                                   |
| Client address                 | Every route                                                                       | `trustProxy` for loopback, link-local and private addresses only, so a public caller cannot spoof `X-Forwarded-For`. The address handed to Better Auth's limiter replaces whatever header the caller sent. A configurable `TRUST_PROXY` is a first-deployment gate.                                                                                                                                                                       |
| Route allowlist                | `/api/auth/*`                                                                     | On, deny by default. Any path not in the allowlist gets Fastify's own `404`, never `403`.                                                                                                                                                                                                                                                                                                                                                 |
| Body size limit                | Every route                                                                       | On. Fastify `bodyLimit`, default 1 MiB (`BODY_LIMIT_BYTES`), with `413` before any handler.                                                                                                                                                                                                                                                                                                                                               |
| CSRF header                    | Mutating `/v1/*` catalog routes                                                   | On. The oRPC simple CSRF check requires the custom header on every catalog route that is not `GET` or `HEAD`. `POST /v1/auth/token`, the back-channel logout and the re-authorization callback are plain Fastify routes with no cookie and no CSRF header: the credential, the `logout_token` and the single-use `state` are their proof.                                                                                                 |
| Per-principal rate limit       | `/v1/*` catalog routes                                                            | On. Default 600 per 60 seconds, keyed `tenant:actor type:actor id` (`unauthenticated:` plus the IP when the context does not resolve). Internal key only, never exported. `POST /v1/auth/token` is exempt.                                                                                                                                                                                                                                |
| Token-exchange rate limit      | `POST /v1/auth/token`                                                             | On. Default 30 per 60 seconds, keyed by IP only, so varying the client id cannot mint a fresh bucket. `429 AUTH_RATE_LIMITED` with `Retry-After`.                                                                                                                                                                                                                                                                                         |
| Pre-authentication rate limit  | `POST /api/auth/sign-in/email`, `/two-factor/verify-totp`, `-backup-code`, `-otp` | On. One budget, default 10 per 60 seconds, for all four routes. Sign-in has an IP bucket and a normalized-email bucket; the two-factor routes have an IP bucket only. Keys are SHA-256 hashes in `auth.rate_limit`. Password-checking routes (`/verify-password`, `/change-password`, `/two-factor/enable`, `/two-factor/generate-backup-codes`, `/link-social`) share a separate budget, default 10 per 60 seconds, per IP and per user. |
| Back-channel logout rate limit | `POST /v1/auth/visma-connect/backchannel-logout`                                  | On. Default 600 per minute per source IP (`BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`).                                                                                                                                                                                                                                                                                                                                                    |
| Step-up guard                  | Every `/v1/*` catalog operation                                                   | On. An interceptor runs `createStepUpGuard` after the context resolves and before the operation. It acts only on operations marked `x-tayzu-risk: high` and only for `user` actors, see [Step-up](#step-up).                                                                                                                                                                                                                              |
| Admin MFA enrollment gate      | Every `/v1/*` catalog route                                                       | On. A caller whose roles include `admin` and whose session user has no enrolled factor gets `403 AUTH_STEP_UP_REQUIRED` and can only reach the `/api/auth/two-factor/*` enrollment routes. It reads the local `twoFactorEnabled` flag, so an admin signed in through Visma Connect needs a local factor too.                                                                                                                              |
| Error sanitizing               | `/v1/*` and the plain routes                                                      | On. An error with no table code becomes a generic `INTERNAL` `500` with no message from the thrown value. Input-validation failures keep only JSON Pointer paths and a fixed message.                                                                                                                                                                                                                                                     |

## Better Auth routes (`/api/auth/*`, allowlisted)

All methods are mounted (`app.all`), and Better Auth answers a method it does
not define. The method column is the one Better Auth defines. The list is
`ALLOWED_AUTH_ROUTES` as it stands today. The cookie is
Better Auth's session cookie. No route here reads `tenantId` or `actor` from
its input, and none of them runs through Cerbos: Better Auth's own checks
apply, and every mutation of membership or credentials is kept off this list
on purpose (see [Blocked routes](#blocked-routes)).

| Route                                        | Method        | Actor category                              | Authentication                                                                                | Authorization check                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/sign-in/email`                    | `POST`        | Anonymous                                   | Email and password (`scrypt`). Same failure for a wrong password and an unknown account.      | None needed. Sign-up is disabled, so the account already exists. Limited per IP and per normalized email (pre-authentication budget).                                                                                                              |
| `/api/auth/sign-out`                         | `POST`        | `user`                                      | Session cookie                                                                                | Acts on the caller's own session only.                                                                                                                                                                                                             |
| `/api/auth/get-session`                      | `GET`, `POST` | `user`                                      | Session cookie                                                                                | Returns the caller's own session. The 12-hour idle timeout applies.                                                                                                                                                                                |
| `/api/auth/two-factor/enable`                | `POST`        | `user`                                      | Session cookie and password                                                                   | Own account only. Returns the TOTP URI, which is why `get-totp-uri` is not allowlisted.                                                                                                                                                            |
| `/api/auth/two-factor/verify-totp`           | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                            | Own account only. Success writes an `mfa` step-up marker for the resulting session and logs `login_succeeded`. Limited per IP (pre-authentication budget).                                                                                         |
| `/api/auth/two-factor/generate-backup-codes` | `POST`        | `user`                                      | Session cookie and password                                                                   | Own account only. Refused with `AUTH_STEP_UP_REQUIRED` unless the session has a fresh `mfa` marker: a password alone never suffices. Codes are shown once.                                                                                         |
| `/api/auth/two-factor/verify-backup-code`    | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                            | Own account only. Same marker and limit as `verify-totp`.                                                                                                                                                                                          |
| `/api/auth/organization/set-active`          | `POST`        | `user`                                      | Session cookie                                                                                | Better Auth refuses an organization the caller is not a member of, and `resolveContext` independently re-checks membership on every request (fails closed).                                                                                        |
| `/api/auth/sign-in/social`                   | `POST`        | Anonymous                                   | None; starts the flow with `provider: visma-connect`                                          | Registered only when SSO is configured. Authorization code with PKCE (`S256`), `state` and `nonce`.                                                                                                                                                |
| `/api/auth/callback/visma-connect`           | `GET`, `POST` | Visma Connect, through the caller's browser | The `code` and `state` Visma Connect returns (`form_post` or query), then a verified ID token | The Visma Connect `sub` must already be linked to a Tayzu user. Every failure is one identical `401 AUTH_SSO_REJECTED`. Never creates a user. The session stores the token's `sid`.                                                                |
| `/api/auth/link-social`                      | `POST`        | `user`                                      | Session cookie                                                                                | Links Visma Connect to the caller's own account. A Fastify pre-handler requires a fresh step-up marker first (`mfa`, or `password` when the caller has no enrolled factor), else `403 AUTH_STEP_UP_REQUIRED`, also when there is no valid session. |
| `/api/auth/unlink-account`                   | `POST`        | `user`                                      | Session cookie                                                                                | Own account only. Same step-up pre-handler as `link-social`. Refused if it would leave no sign-in method.                                                                                                                                          |
| `/api/auth/list-accounts`                    | `GET`         | `user`                                      | Session cookie                                                                                | Read-only, own account only.                                                                                                                                                                                                                       |
| `/api/auth/verify-password`                  | `POST`        | `user`                                      | Session cookie and current password                                                           | Own account only. Success writes a `password` step-up marker (5 minutes) unless a fresh `mfa` marker already exists. This is the step-up for a user without MFA.                                                                                   |
| `/api/auth/change-password`                  | `POST`        | `user`                                      | Session cookie and current password                                                           | Own account only. `revokeOtherSessions` is forced on, so every other session of the user ends.                                                                                                                                                     |
| `/api/auth/jwks`                             | `GET`         | Anonymous                                   | None; public by design                                                                        | Publishes the public keys of the `jwt` plugin, which signs the machine access tokens (`EdDSA`). No private material.                                                                                                                               |

## Catalog routes (`/v1`)

Served by `ALL /v1/*` through the catalog `OpenAPIHandler`. Every route takes
the same two credentials: a Better Auth session cookie, or
`Authorization: Bearer` with a machine access token, so every route here is
reachable by the `user`, `agent` and `integration` categories and by nobody
else. A missing, expired or invalid credential, a session with no active
organization, a failed membership re-check and a revoked machine credential
all answer `401 CATALOG_CONTEXT_REQUIRED`, before any handler. `tenantId`,
`actor` and `onBehalfOf` are never read from the request.

After the context is resolved, each operation asks Cerbos (`authz.check`, or
`authz.plan` for the list) before any database work, then runs inside a tenant
transaction under row-level security. A deny is `403 AUTH_FORBIDDEN`. A
cross-tenant target is `404 CATALOG_NOT_FOUND`. The roles and rules are in
[Authentication and authorization](../catalog/auth-and-rbac.md#role-and-ownership-model).

| Route                                                      | Operation              | Cerbos kind and action          | Who is allowed, inside the caller's own tenant                                                                                        | CSRF header | Step-up                                            |
| ---------------------------------------------------------- | ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------- |
| `POST /v1/blueprints`                                      | `blueprints.create`    | `catalog_blueprint`, `create`   | `admin`                                                                                                                               | Yes         | No                                                 |
| `GET /v1/blueprints`                                       | `blueprints.list`      | `catalog_blueprint`, `list`     | `admin`, `member`                                                                                                                     | No          | No                                                 |
| `GET /v1/blueprints/{blueprint}`                           | `blueprints.get`       | `catalog_blueprint`, `view`     | `admin`, `member`                                                                                                                     | No          | No                                                 |
| `PUT /v1/blueprints/{blueprint}`                           | `blueprints.update`    | `catalog_blueprint`, `update`   | `admin`                                                                                                                               | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `DELETE /v1/blueprints/{blueprint}`                        | `blueprints.delete`    | `catalog_blueprint`, `delete`   | `admin`                                                                                                                               | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/blueprints/{blueprint}/entities`                 | `entities.create`      | `catalog_entity`, `create`      | `admin`; a `member` when the entity has no owner team; a member of the owner team; a moderator of the blueprint                       | Yes         | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities`                  | `entities.list`        | `catalog_entity`, `list` (plan) | `admin`, `member`. The plan is folded into the tenant-scoped query.                                                                   | No          | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.get`         | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                     | No          | No                                                 |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.upsert`      | `catalog_entity`, `update`      | `admin`; a `member` when there is no owner team; a member of the owner team; a moderator. Denied to non-admins when `locked` is true. | Yes         | No                                                 |
| `DELETE /v1/blueprints/{blueprint}/entities/{entity}`      | `entities.delete`      | `catalog_entity`, `delete`      | `admin`; a moderator of the blueprint; a `member` who created the entity                                                              | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}/status`  | `entities.writeStatus` | `catalog_entity`, `update`      | The same rule as `entities.upsert`                                                                                                    | Yes         | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities/{entity}/related` | `entities.listRelated` | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                     | No          | No                                                 |

Any other path under `/v1` is answered `401` when it has no valid credential
and `404` when it does. Blueprint identifiers beginning with `_` are reserved
for the `system` actor, which no HTTP credential can be.

### Step-up

The three operations marked `x-tayzu-risk: high` (`blueprints.update`,
`blueprints.delete`, `entities.delete`) need a fresh verification when a `user`
actor calls them. `createApp` applies `createStepUpGuard` to every `/v1`
operation through an interceptor, and the guard acts only on the marked ones.
Agents and integrations are never gated by step-up.

| Session                                             | What the guard accepts                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local, user with an enrolled factor                 | A `step-up-verified` marker with factor `mfa`, written by a successful `/two-factor/verify-*` in the last 5 minutes. A `password` marker does not satisfy it.            |
| Local, user without an enrolled factor              | An `mfa` or a `password` marker, the latter written by `/verify-password`, in the last 5 minutes.                                                                        |
| Established through Visma Connect (`ssoSid` is set) | An ID token from a Visma Connect re-authorization (`max_age=300`, `prompt=login`, `acr_values=urn:idp:vismaconnect:mfa`) whose `auth_time`, `acr`, `amr` and `sid` pass. |

A failure is `403 AUTH_STEP_UP_REQUIRED`. For a Visma Connect session, when SSO
is configured, the error carries `data.reauthorizationUrl`, built on
`BETTER_AUTH_URL` (the first entry of `ALLOWED_ORIGINS` only when it is unset,
in test), never on a request header (Q64). A marker is keyed by the
session token, so it never carries over to another session.

## Health, machine credential, back-channel and re-authorization routes

| Route                                         | Method        | Actor category                              | Authentication                                                                                                                                                                                         | Authorization check                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`                                    | `GET`         | Anonymous                                   | None, by design                                                                                                                                                                                        | Liveness only. Answers `200 {"status":"ok"}` with no dependency check and no detail. Not rate limited. It shares the headers, CORS and `no-store` controls of every route.                                                                                                                                                                                                                                                                        |
| `/v1/auth/token`                              | `POST`        | `agent`, `integration`                      | Client id and secret of a machine credential in the JSON body, checked with `verifyApiKey`. A missing or non-string field is `400`. Any other failure is one identical `401 AUTH_INVALID_CREDENTIALS`. | Per-IP rate limit (30 per 60 seconds by default). Mints a 1-hour `jwt`-plugin token for the credential's tenant, actor and fixed `member` role; a credential without the `member` role fails closed. Revocation is checked on use within 5 seconds. Exempt from the per-principal limiter and from the CSRF check.                                                                                                                                |
| `/v1/auth/visma-connect/backchannel-logout`   | `POST`        | Visma Connect (unauthenticated)             | None, by design. The caller is Visma Connect's infrastructure, so there is no cookie and no CSRF header. The `logout_token` is the only proof.                                                         | Answers `404` when SSO is not configured. Fail-closed validation in order: signature against the discovered JWKS (`RS256`), `typ` `logout+jwt`, `iss`, `aud`, `iat` and `exp` (30 seconds of skew), the back-channel `events` member, no `nonce`, `jti` replay. Rate limited per source IP. Answers `200` for every well-formed request whatever the outcome, and `400` only when `logout_token` is missing. Revokes only Visma Connect sessions. |
| `/v1/auth/visma-connect/reauthorize/callback` | `GET`, `POST` | Visma Connect, through the caller's browser | None. The single-use, unguessable `state` (10 minutes) is bound to the session that started the re-authorization, so no cookie is needed. `code` arrives in the query or a `form_post` body.           | Exchanges the `code` for an ID token and stores it under that session for the step-up guard, which validates it. Answers a bare `200`, or `400` for any failure, with nothing from the provider in the body. Always registered; without SSO configured it can only answer `400`.                                                                                                                                                                  |

## Blocked routes

These answer `404`, the same as a path that does not exist. They must never
be added to `ALLOWED_AUTH_ROUTES`. The reasons are the design decisions
named.

| Route or group                                                                                        | Why it is blocked                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-up/email`                                                                        | Public self sign-up is disabled (D22). It is off in Better Auth too, so an in-process call is refused as well.                                                |
| `POST /api/auth/admin/create-user`                                                                    | Users are created only by `identity.users.create` or the bootstrap script, both in-process (D22).                                                             |
| `/api/auth/organization/invite-member`, `/update-member-role`, `/remove-member`, `/create`, `/delete` | A second, ungoverned authorization path next to Cerbos (D18). Membership changes go through Cerbos-gated procedures that call `auth.api.*` in-process.        |
| `/api/auth/api-key/create`, `/get`, `/list`, `/update`, `/delete`                                     | Machine credentials are created and revoked through Cerbos-gated code, never through the plugin's own routes (D18, D5).                                       |
| `/api/auth/token` (the `jwt` plugin's session-bound route)                                            | Needs a session and signs the user, not a machine credential. The machine access token is minted by `POST /v1/auth/token`. (`/api/auth/jwks` is allowlisted.) |
| `/api/auth/two-factor/get-totp-uri`, `/api/auth/send-verification-email`, `/api/auth/verify-email`    | Removed from the allowlist. `/two-factor/enable` already returns the TOTP URI, and no email-verification flow exists (Q52, Q56).                              |
| Every other `/api/auth/*` path                                                                        | Deny by default (D18). A CI test enumerates Better Auth's mounted routes against the allowlist and fails when a new one appears unlisted.                     |

## Not reachable over the network

| Capability                                                                                        | How it is reached                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity.users.create`, `identity.users.linkSsoAccount`, `identity.users.unlinkSsoAccount`       | In-process only, through `createRouterClient`. Cerbos-gated on the `user` kind. `createApp` does not mount the identity router.                                                      |
| Machine credential creation and revocation (`createMachineCredential`, `revokeMachineCredential`) | In-process only. No HTTP route mounts them yet.                                                                                                                                      |
| First-admin bootstrap script                                                                      | Run out of band by an operator. Calls the same `auth.api.createUser` path. Idempotent.                                                                                               |
| Cerbos PDP                                                                                        | gRPC from `apps/api`, with TLS unless `CERBOS_ADDRESS` is `localhost`, `127.0.0.1` or `[::1]` (the sidecar case, no TLS). Nothing outside the boundary can reach a loopback sidecar. |
| PostgreSQL                                                                                        | Outbound from `apps/api` over TLS with `sslmode=verify-full` (`createPool` refuses anything else), as `tayzu_app` for the catalog and `tayzu_auth` for Better Auth.                  |

## Outbound calls to an external system

| Destination    | Calls                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visma Connect  | HTTPS (`https` is required outside test). Discovery at startup, which fails startup when the provider cannot be discovered, then the authorize redirect, the token exchange, the JWKS and userinfo. A failure at sign-in time is a rejected sign-in and never a partial one, and a userinfo failure does not block a sign-in. The step-up re-authorization adds one token exchange with a 5-second timeout. |
| OTLP collector | OpenTelemetry export of traces, metrics and logs to the `OTEL_EXPORTER_OTLP_*` endpoints. Outside test, startup fails without an endpoint unless `TAYZU_TELEMETRY_DISABLED=true`.                                                                                                                                                                                                                           |

No other outbound call exists in this change.

## Pending

Human-owned and deployment-coupled items. Each one is a gate for the first
deployment (`010`), next to task 11.12, in the design's "Gates for the first
deployment".

| Item                                                        | State                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS minimum and HSTS on the public ingress (task 11.12)     | Pending. HSTS is set by the application, but the ingress belongs to `010`.                                                                                                |
| Verification against Visma Connect's test environment (Q57) | Pending. `sid` present and preserved on `prompt=login`, and the `form_post` callback under the production origin check.                                                   |
| Runtime role assertion and `MIGRATION_DATABASE_URL` (Q58)   | Pending. No startup assertion yet that the runtime roles are not superuser, owner or `BYPASSRLS`, and `db:migrate` still reads `DATABASE_URL`, see [Secrets](secrets.md). |
| Configurable `TRUST_PROXY` (Q58)                            | Pending. The trusted proxy ranges are fixed in code and must be verified against the ACA ingress peer range.                                                              |
| Cerbos audit log (Q58)                                      | Pending. It must go to stdout and on to Azure Monitor.                                                                                                                    |

## Where the code differs from the design

The code is authoritative. Each row is a design or task sentence the running
code does not match yet, recorded so the design or the code can be reconciled
before Checkpoint 2.

| Design says                                                                         | The code does                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 23.2, Known residual risks: `R.attr.tenantId` comes from the loaded entity row | The catalog pipeline sends `ctx.tenantId` as `R.attr.tenantId` for every operation (`buildAttributes` drops any `tenantId` in the extra attributes). The loaded row supplies `ownerTeam`, `createdBy` and `locked`, not the tenant. |
