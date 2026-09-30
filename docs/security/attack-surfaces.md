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

`createApp` registers exactly four route groups and nothing else:

1. `ALL /api/auth/*`, guarded by the allowlist below.
2. `POST /v1/auth/visma-connect/backchannel-logout`.
3. `ALL /v1/*`, which is the catalog `OpenAPIHandler`.
4. Fastify's own `404` for every other path.

There is no health, readiness, metrics, documentation or OpenAPI-serving
route today.

## Actor categories

| Category               | Who                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Anonymous              | A caller with no credential yet: someone signing in, or a script probing the API.               |
| `user`                 | A human with a Better Auth session cookie, signed in locally or through Visma Connect.          |
| `agent`, `integration` | A machine holding an access token exchanged from a machine credential.                          |
| Visma Connect          | The external identity provider, calling Tayzu or redirecting a browser back to it.              |
| `system`               | Tayzu's own automation. Never reachable over HTTP and never mapped from an external credential. |

## Controls that apply before a route runs

| Control                       | Applies to                      | State                                                                                                                                                                 |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security headers (`helmet`)   | Every route                     | On. HSTS for one year with subdomains. No CSP (this is a JSON API, `003`'s concern).                                                                                  |
| CORS                          | Every route                     | On. Exact-match origin allowlist from `ALLOWED_ORIGINS`, credentials only for an allowed origin. A disallowed origin gets no CORS headers.                            |
| Client address                | Every route                     | `trustProxy` for loopback, link-local and private addresses only, so a public caller cannot spoof `X-Forwarded-For`.                                                  |
| Route allowlist               | `/api/auth/*`                   | On, deny by default. Any path not in the allowlist gets Fastify's own `404`, never `403`.                                                                             |
| Body size limit               | Every route                     | Fastify `bodyLimit`, default 1 MiB, with `413` before any handler. `createApp` accepts a value, `createAppFromEnv` passes none.                                       |
| CSRF header                   | Mutating `/v1/*` catalog routes | On. The oRPC simple CSRF check requires the custom header on every route that is not `GET` or `HEAD`. Better Auth routes use Better Auth's own origin checks.         |
| Per-principal rate limit      | `/v1/*`                         | Supported, keyed `tenant:actor type:actor id` (internal key only, never exported). Off unless the host passes `rateLimit`; `createAppFromEnv` does not.               |
| Token-exchange rate limit     | `POST /v1/auth/token`           | Supported, keyed by IP and client id. Off unless the host passes `tokenExchangeRateLimit`; `createAppFromEnv` does not.                                               |
| Pre-authentication rate limit | `POST /api/auth/sign-in/email`  | The limiter plugin exists (IP and normalized email, hashed keys) but is inactive unless the host passes Better Auth's `rateLimit` option, which `createApp` does not. |
| Error sanitizing              | `/v1/*`                         | On. An error with no table code becomes a generic `INTERNAL` `500` with no message from the thrown value.                                                             |

## Better Auth routes (`/api/auth/*`, allowlisted)

All methods are mounted (`app.all`), and Better Auth answers a method it does
not define. The method column is the one Better Auth defines. The cookie is
Better Auth's session cookie. No route here reads `tenantId` or `actor` from
its input, and none of them runs through Cerbos: Better Auth's own checks
apply, and every mutation of membership or credentials is kept off this list
on purpose (see [Blocked routes](#blocked-routes)).

| Route                                        | Method        | Actor category                              | Authentication                                                                           | Authorization check                                                                                                                                                          |
| -------------------------------------------- | ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/sign-in/email`                    | `POST`        | Anonymous                                   | Email and password (`scrypt`). Same failure for a wrong password and an unknown account. | None needed. Sign-up is disabled, so the account already exists. Pre-authentication limiter when the host enables it.                                                        |
| `/api/auth/sign-out`                         | `POST`        | `user`                                      | Session cookie                                                                           | Acts on the caller's own session only.                                                                                                                                       |
| `/api/auth/get-session`                      | `GET`, `POST` | `user`                                      | Session cookie                                                                           | Returns the caller's own session. The 12-hour idle timeout applies.                                                                                                          |
| `/api/auth/two-factor/enable`                | `POST`        | `user`                                      | Session cookie and password                                                              | Own account only.                                                                                                                                                            |
| `/api/auth/two-factor/get-totp-uri`          | `POST`        | `user`                                      | Session cookie and password                                                              | Own account only.                                                                                                                                                            |
| `/api/auth/two-factor/verify-totp`           | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                       | Own account only. Success stamps the freshness time used by step-up.                                                                                                         |
| `/api/auth/two-factor/generate-backup-codes` | `POST`        | `user`                                      | Session cookie and password                                                              | Own account only. Codes are shown once.                                                                                                                                      |
| `/api/auth/two-factor/verify-backup-code`    | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                       | Own account only.                                                                                                                                                            |
| `/api/auth/organization/set-active`          | `POST`        | `user`                                      | Session cookie                                                                           | Better Auth refuses an organization the caller is not a member of, and `resolveContext` independently re-checks membership on every request (fails closed).                  |
| `/api/auth/send-verification-email`          | `POST`        | Anonymous                                   | None                                                                                     | None needed. 002 sends no other email.                                                                                                                                       |
| `/api/auth/verify-email`                     | `GET`         | Anonymous                                   | Signed verification token in the link                                                    | The token names the account it verifies.                                                                                                                                     |
| `/api/auth/sign-in/social`                   | `POST`        | Anonymous                                   | None; starts the flow with `provider: visma-connect`                                     | Registered only when SSO is configured. Authorization code with PKCE, `state` and `nonce`.                                                                                   |
| `/api/auth/callback/visma-connect`           | `GET`, `POST` | Visma Connect, through the caller's browser | The `code` and `state` Visma Connect returns, then a verified ID token                   | The Visma Connect `sub` must already be linked to a Tayzu user. Every failure is one identical `401 AUTH_SSO_REJECTED`. Never creates a user.                                |
| `/api/auth/link-social`                      | `POST`        | `user`                                      | Session cookie                                                                           | Links Visma Connect to the caller's own account. A pre-handler requires a fresh MFA verification first when the caller has an enrolled factor, else `AUTH_STEP_UP_REQUIRED`. |
| `/api/auth/unlink-account`                   | `POST`        | `user`                                      | Session cookie                                                                           | Own account only. Refused if it would leave no sign-in method. No step-up.                                                                                                   |
| `/api/auth/list-accounts`                    | `GET`         | `user`                                      | Session cookie                                                                           | Read-only, own account only.                                                                                                                                                 |

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

| Route                                                      | Operation              | Cerbos kind and action          | Who is allowed, inside the caller's own tenant                                                                                        | CSRF header | Step-up                                |
| ---------------------------------------------------------- | ---------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------- |
| `POST /v1/blueprints`                                      | `blueprints.create`    | `catalog_blueprint`, `create`   | `admin`                                                                                                                               | Yes         | No                                     |
| `GET /v1/blueprints`                                       | `blueprints.list`      | `catalog_blueprint`, `list`     | `admin`, `member`                                                                                                                     | No          | No                                     |
| `GET /v1/blueprints/{blueprint}`                           | `blueprints.get`       | `catalog_blueprint`, `view`     | `admin`, `member`                                                                                                                     | No          | No                                     |
| `PUT /v1/blueprints/{blueprint}`                           | `blueprints.update`    | `catalog_blueprint`, `update`   | `admin`                                                                                                                               | Yes         | Marked `x-tayzu-risk: high`, see below |
| `DELETE /v1/blueprints/{blueprint}`                        | `blueprints.delete`    | `catalog_blueprint`, `delete`   | `admin`                                                                                                                               | Yes         | Marked `x-tayzu-risk: high`, see below |
| `POST /v1/blueprints/{blueprint}/entities`                 | `entities.create`      | `catalog_entity`, `create`      | `admin`; a `member` when the entity has no owner team; a member of the owner team; a moderator of the blueprint                       | Yes         | No                                     |
| `GET /v1/blueprints/{blueprint}/entities`                  | `entities.list`        | `catalog_entity`, `list` (plan) | `admin`, `member`. The plan is folded into the tenant-scoped query.                                                                   | No          | No                                     |
| `GET /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.get`         | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                     | No          | No                                     |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.upsert`      | `catalog_entity`, `update`      | `admin`; a `member` when there is no owner team; a member of the owner team; a moderator. Denied to non-admins when `locked` is true. | Yes         | No                                     |
| `DELETE /v1/blueprints/{blueprint}/entities/{entity}`      | `entities.delete`      | `catalog_entity`, `delete`      | `admin`; a moderator of the blueprint; a `member` who created the entity                                                              | Yes         | Marked `x-tayzu-risk: high`, see below |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}/status`  | `entities.writeStatus` | `catalog_entity`, `update`      | The same rule as `entities.upsert`                                                                                                    | Yes         | No                                     |
| `GET /v1/blueprints/{blueprint}/entities/{entity}/related` | `entities.listRelated` | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                     | No          | No                                     |

Any other path under `/v1` is answered `401` when it has no valid credential
and `404` when it does. Blueprint identifiers beginning with `_` are reserved
for the `system` actor, which no HTTP credential can be.

Step-up: the three operations marked `x-tayzu-risk: high` are meant to need a
fresh MFA verification when a `user` actor calls them. That guard exists in
`@tayzu/auth` and is tested, but `apps/api` does not apply it to these routes
yet (see below). Agents and integrations are never gated by step-up.

## Machine credential and back-channel routes

| Route                                       | Method | Actor category                  | Authentication                                                                                                                                 | Authorization check                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/auth/token`                            | `POST` | `agent`, `integration`          | Client id and secret of a machine credential, checked with `verifyApiKey`. Any failure is `401 AUTH_INVALID_CREDENTIALS`.                      | Pending. The exchange logic and its rate-limit hook exist, but no handler is mounted, so the path currently falls through to `/v1/*`. Once mounted: a rate limit by IP and client id, and a 1-hour, `member`-only token whose revocation is checked within 5 seconds.                                                                                                                                          |
| `/v1/auth/visma-connect/backchannel-logout` | `POST` | Visma Connect (unauthenticated) | None, by design. The caller is Visma Connect's infrastructure, so there is no cookie and no CSRF header. The `logout_token` is the only proof. | Fail-closed validation in order: signature against the discovered JWKS, `typ` `logout+jwt`, `iss`, `aud`, `iat` and `exp` (30 seconds of skew), the back-channel `events` member, no `nonce`, `jti` replay. Rate limited per source IP (600 per minute). Answers `200` for every well-formed request whatever the outcome, and `400` only when `logout_token` is missing. Revokes only Visma Connect sessions. |

## Blocked routes

These answer `404`, the same as a path that does not exist. They must never
be added to `ALLOWED_AUTH_ROUTES`. The reasons are the design decisions
named.

| Route or group                                                                                        | Why it is blocked                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-up/email`                                                                        | Public self sign-up is disabled (D22). It is off in Better Auth too, so an in-process call is refused as well.                                                          |
| `POST /api/auth/admin/create-user`                                                                    | Users are created only by `identity.users.create` or the bootstrap script, both in-process (D22).                                                                       |
| `/api/auth/organization/invite-member`, `/update-member-role`, `/remove-member`, `/create`, `/delete` | A second, ungoverned authorization path next to Cerbos (D18). Membership changes go through Cerbos-gated procedures that call `auth.api.*` in-process.                  |
| `/api/auth/api-key/create`, `/get`, `/list`, `/update`, `/delete`                                     | Machine credentials are created and revoked through Cerbos-gated code, never through the plugin's own routes (D18, D5).                                                 |
| `/api/auth/jwks` and `/api/auth/token` (the `jwt` plugin's routes)                                    | Not needed by 002. The machine access token is minted by `/v1/auth/token`. Design D5 expected the key set to be published for `026-mcp-server`; that has not been done. |
| Every other `/api/auth/*` path                                                                        | Deny by default (D18). A CI test enumerates Better Auth's mounted routes against the allowlist and fails when a new one appears unlisted.                               |

## Not reachable over the network

| Capability                                                                                        | How it is reached                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.users.create`, `identity.users.linkSsoAccount`, `identity.users.unlinkSsoAccount`       | In-process only, through `createRouterClient`. Cerbos-gated on the `user` kind. No HTTP route mounts them.                               |
| Machine credential creation and revocation (`createMachineCredential`, `revokeMachineCredential`) | In-process only. No HTTP route mounts them yet.                                                                                          |
| First-admin bootstrap script                                                                      | Run out of band by an operator. Calls the same `auth.api.createUser` path. Idempotent.                                                   |
| Cerbos PDP                                                                                        | gRPC on loopback inside the same Container Apps revision, with no TLS (documented exception). Nothing outside the boundary can reach it. |
| PostgreSQL                                                                                        | Outbound from `apps/api` over TLS with `sslmode=verify-full`, as `tayzu_app` for the catalog and `tayzu_auth` for Better Auth.           |

## Outbound calls to an external system

`apps/api` calls Visma Connect over HTTPS for discovery, the authorize
redirect, the token exchange, the JWKS and userinfo. A failure at sign-in
time is a rejected sign-in and never a partial one, and a userinfo failure
does not block a sign-in. No other outbound call exists in this change.

## Pending

| Item                                                | State                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and readiness route                          | Pending. No such route exists in `apps/api`. Task 11.14 expects the process to "answer the health route" but names neither its path nor its authentication, and the design's Risks section expects a readiness probe that reflects Cerbos and Visma Connect discovery. When it lands it is an unauthenticated surface: add a row here and to the diagram. |
| OWASP ZAP baseline job (task 15.1)                  | Done. The `dast-zap` CI job and `pnpm ci:local` run `scripts/ci/dast.sh`: an authenticated baseline (passive) scan of a running `apps/api`, failing on any alert. The active DAST tool stays with `022` (D16).                                                                                                                                            |
| Process entry point and `start` script (task 11.14) | Pending. Nothing listens on a port yet, and the OpenTelemetry SDK is not started (task 13.4 is open).                                                                                                                                                                                                                                                     |
| `POST /v1/auth/token` handler                       | Pending, see above.                                                                                                                                                                                                                                                                                                                                       |
| TLS and HSTS on the public ingress (task 11.12)     | Pending. HSTS is set by the application, but the ingress belongs to `010`.                                                                                                                                                                                                                                                                                |

## Where the code differs from the design

The code is authoritative. Each row is a design sentence the running code does
not match yet. They are recorded so the design or the code can be reconciled
before Checkpoint 2.

| Design says                                                                                             | The code does                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4, D25: every `x-tayzu-risk: high` operation is step-up gated for `user` actors                        | `createStepUpGuard` exists and is exported, but `apps/api/src/server.ts` never applies it. Only the `/link-social` pre-handler enforces step-up over HTTP.              |
| D5: `POST /v1/auth/token` mints the token and `/jwks` publishes the key                                 | No handler is mounted for the exchange, and `/jwks` is not on the allowlist.                                                                                            |
| D20: pre-authentication limits on sign-in, two-factor verification and the other unauthenticated routes | The plugin has one rule, `/sign-in/email`, and `createApp` does not supply its limits, so it is inactive. Nothing limits `/two-factor/verify-*` or verification routes. |
| D13, D20: per-principal and token-exchange limits, and a body limit                                     | Supported by `createApp` options. `createAppFromEnv`, the only production bootstrap, passes none of them.                                                               |
| D23: Visma Connect SSO is registered                                                                    | `createAppFromEnv` does not pass `sso`, so the SSO routes are allowlisted but no provider is registered. Back-channel logout then answers `200` without processing.     |
| Q32: back-channel rate limit configurable through `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`            | The limit is a fixed 600 per minute. The variable is read nowhere.                                                                                                      |
