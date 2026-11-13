# Attack surfaces

SSA section SEC02, for `002-auth-and-rbac` (VCDM pre-assessment, ticket 6;
design D13, D18, D22-D26), `043-identity-lifecycle-and-org-admin` (design
D10, D15) and `044-password-reset-and-account-recovery` (design D2, D13, D16).
It lists every route the API application
(`apps/api`) exposes, with the actor category that reaches it, how the caller
is authenticated, and which authorization check applies. The system diagram
in [`docs/architecture/system-diagram.md`](../architecture/system-diagram.md)
uses the same surface names.

## How this list was derived

From the code, not from the design. The routes are those that
`createApp` in `apps/api/src/server.ts` registers, plus the two route lists
they read from: `ALLOWED_AUTH_ROUTES` in
`packages/auth/src/http/allowed-routes.ts` and the catalog contract in
`packages/catalog/src/api/contract.ts`. The identity routes come from
`apps/api/src/identity-router.ts` and the accept route from `createApp`. The
authorization column is read from
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
6. `POST /v1/auth/invitations/accept`, the public invitation acceptance, and
   `POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`,
   the two public password-reset routes. All three are registered only when
   `MOUNT_IDENTITY_ROUTES` is `true`, see [Mount gate](#mount-gate).
7. `ALL /v1/*`, which is the `OpenAPIHandler` of the one router that merges the
   catalog router with the identity router. The identity procedures are behind
   the same switch.
8. Fastify's own `404` for every other path.

The `404` in item 8 is verified against the code, with one nuance. A path under
`/api/auth` that is not allowlisted, any path outside the groups above and any
request target the request-target rule below refuses all get Fastify's own
`404`. A path under `/v1` that no route of the merged router matches is not Fastify's
`404`: the `/v1/*` catch-all answers `401` without a valid credential and the
oRPC `404` with one (see [Catalog routes](#catalog-routes-v1)). The catch-all
accepts only the methods the router routes (`GET`, `POST`, `PUT`, `PATCH` and
`DELETE`), so `QUERY` and any other method answer Fastify's own `404` (Q141).

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

| Control                          | Applies to                                                                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request-target rule              | Every request                                                                     | On (Q74). The first `onRequest` hook of all: a request target that is not origin-form (it does not start with a single `/`, so an absolute URI, `*` or `//host` form), or whose path before the query holds a percent-encoded byte (`%`), a backslash or `//`, answers Fastify's own `404` through `callNotFound()` before any other hook or the router can decode or normalize it. A raw-socket regression matrix covers every guarded surface.                                                                                             |
| Security headers (`helmet`)      | Every route                                                                       | On. HSTS for one year with subdomains. No CSP (this is a JSON API, `003`'s concern).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Cache-Control: no-store`        | Every response, including Fastify's `404`                                         | On, unless the handler already set its own `Cache-Control` (Better Auth's `get-session` does).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CORS                             | Every route                                                                       | On. Exact-match origin allowlist from `ALLOWED_ORIGINS`, credentials only for an allowed origin, no CORS headers for any other. Outside test, startup fails unless every origin is `https` and wildcard-free.                                                                                                                                                                                                                                                                                                                                |
| Origin check and cookies         | `/api/auth/*`                                                                     | On in every environment: `disableOriginCheck: false`, `useSecureCookies: true`, and `ALLOWED_ORIGINS` as Better Auth's trusted origins.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Client address                   | Every route                                                                       | `trustProxy` for loopback, link-local and private addresses only, so a public caller cannot spoof `X-Forwarded-For`. `toWebRequest` overwrites `x-forwarded-for` with Fastify's resolved `request.ip` before Better Auth sees the request, so whatever header the caller sent never picks a limiter bucket. A configurable `TRUST_PROXY` is a first-deployment gate.                                                                                                                                                                         |
| Route allowlist                  | `/api/auth/*`                                                                     | On, deny by default. Any path not in the allowlist gets Fastify's own `404`, never `403`. The hook, like every other guard in `createApp` (the `/v1` media-type check, the `idToken` refusal, the link and unlink step-up, the token-exchange limiter), keys on the parsed pathname (the target without its query), never on the raw `request.url` (Q74). The `onRequest` hook returns the reply after `callNotFound()`, so an unlisted mutating route never reaches Better Auth and has no side effect (Q68).                               |
| Body size limit                  | Every route                                                                       | On. Fastify `bodyLimit`, default 1 MiB (`BODY_LIMIT_BYTES`), with `413` before any handler. The catch-all body parser skips that limit for non-JSON types, so a body-bearing `/v1/*` request whose media type is not `application/json` gets `415 UNSUPPORTED_MEDIA_TYPE` in `onRequest`, before any body is read (Q66). Only the two Visma Connect form-encoded callbacks are exempt, and they have their own scoped parsers.                                                                                                               |
| CSRF header                      | Mutating `/v1/*` catalog routes                                                   | On. The oRPC simple CSRF check requires the custom header on every catalog route that is not `GET` or `HEAD`. `POST /v1/auth/token`, the back-channel logout and the re-authorization callback are plain Fastify routes with no cookie and no CSRF header: the credential, the `logout_token` and the single-use `state` are their proof.                                                                                                                                                                                                    |
| Per-principal rate limit         | `/v1/*` catalog routes                                                            | On. Default 600 per 60 seconds, keyed `tenant:actor type:actor id` (`unauthenticated:` plus the IP when the context does not resolve). Internal key only, never exported. `POST /v1/auth/token` is exempt.                                                                                                                                                                                                                                                                                                                                   |
| Token-exchange rate limit        | `POST /v1/auth/token`                                                             | On. Default 30 per 60 seconds, keyed by IP only, so varying the client id cannot mint a fresh bucket. `429 AUTH_RATE_LIMITED` with `Retry-After`.                                                                                                                                                                                                                                                                                                                                                                                            |
| Pre-authentication rate limit    | `POST /api/auth/sign-in/email`, `/two-factor/verify-totp`, `-backup-code`, `-otp` | On. One budget, default 10 per 60 seconds, for all four routes. Sign-in has an IP bucket and a normalized-email bucket; the two-factor routes have an IP bucket and, when the request carries a session (a step-up), a per-user bucket of 5 failures in 5 minutes (Q80). Keys are SHA-256 hashes in `auth.rate_limit`. Password-checking routes (`/verify-password`, `/change-password`, `/two-factor/enable`, `/two-factor/generate-backup-codes`, `/link-social`) share a separate budget, default 10 per 60 seconds, per IP and per user. |
| Password-reset route rate limits | `POST /v1/auth/password-reset/request` and `/confirm`                             | On (044 D9, D16). Two separate buckets, each default 10 per 60 seconds per caller IP (`PASSWORD_RESET_REQUEST_RATE_LIMIT_*`, `PASSWORD_RESET_CONFIRM_RATE_LIMIT_*`). The key is the normalized client IP: an IPv4 address as is, an IPv6 address by its first 64 bits. A limiter-store failure answers the sanitized `500`, never a pass. `429 AUTH_RATE_LIMITED` with `Retry-After`.                                                                                                                                                        |
| Reset and notice email caps      | The reset email and the notices                                                   | On (044 D5, D9). Per recipient (default 5 per hour for a reset email), per normalized IP (10 per hour) and for the platform (600 per hour, fixed window). Notices have their own per-recipient cap, and the account-created notice a per-tenant and a global one. A cap refusal is silent: the answer stays uniform.                                                                                                                                                                                                                         |
| Back-channel logout rate limit   | `POST /v1/auth/visma-connect/backchannel-logout`                                  | On. Default 600 per minute per source IP (`BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Step-up guard                    | Every `/v1/*` catalog operation                                                   | On. An interceptor runs `createStepUpGuard` after the context resolves and before the operation. It acts only on operations marked `x-tayzu-risk: high` and only for `user` actors, see [Step-up](#step-up).                                                                                                                                                                                                                                                                                                                                 |
| Admin MFA enrollment gate        | Every `/v1/*` catalog route                                                       | On. A caller whose roles include `admin` and whose session user has no enrolled factor gets `403 AUTH_STEP_UP_REQUIRED` and can only reach the `/api/auth/two-factor/*` enrollment routes. It reads the local `twoFactorEnabled` flag, so an admin signed in through Visma Connect needs a local factor too. An admin who can sign in only through Visma Connect is therefore locked out of `/v1`: SSO-only admins are unsupported until `025` (Q72).                                                                                        |
| Sanitized logging and telemetry  | Better Auth and the OTLP exporter                                                 | On (Q67). Better Auth's logger is a no-op and its `onAPIError` turns a non-API error into a bare `500`, so no raw error text, stack or driver message is written. The span exporter drops `url.query` and cuts the query and fragment from `url.full`, `http.url`, `http.target` and `url.path`, so OAuth `code`, `state` and tokens are never exported.                                                                                                                                                                                     |
| Idle timeout on `/api/auth/*`    | Session-bearing `/api/auth/*` routes                                              | On (Q75, task 27.3). A Better Auth `before` hook peeks at the session with `disableRefresh: true` and refuses a session idle for more than 12 hours with `401`, so a stale cookie cannot reach Better Auth's refresh-on-read and reset the idle clock. Sign-in routes (`/sign-in/*`, `/callback/*`) are exempt. It is the same peek `resolveContext` runs for `/v1`.                                                                                                                                                                         |
| Runtime role assertion           | Process startup                                                                   | On outside test (Q62, task 25.3). `createAppFromEnv` checks `current_user` of both pools and aborts with a fixed message when the role is a superuser, has `BYPASSRLS` or owns a `catalog_*` table. Skipped when `NODE_ENV=test`.                                                                                                                                                                                                                                                                                                            |
| Error sanitizing                 | `/v1/*` and the plain routes                                                      | On. An error with no table code becomes a generic `INTERNAL` `500` with no message from the thrown value. Input-validation failures keep only JSON Pointer paths and a fixed message. `createApp` also sets a Fastify error handler (Q67): an unmapped error that reaches Fastify, for example a database failure in the admin MFA gate or the re-authorization callback, answers the same generic `500 INTERNAL`. Only 4xx errors that Fastify and its plugins raise on purpose keep their status and body.                                 |

## Better Auth routes (`/api/auth/*`, allowlisted)

All methods are mounted (`app.all`), and Better Auth answers a method it does
not define. The method column is the one Better Auth defines. The list is
`ALLOWED_AUTH_ROUTES` as it stands today. The cookie is
Better Auth's session cookie. No route here reads `tenantId` or `actor` from
its input, and none of them runs through Cerbos: Better Auth's own checks
apply, and every mutation of membership or credentials is kept off this list
on purpose (see [Blocked routes](#blocked-routes)).

| Route                                        | Method        | Actor category                              | Authentication                                                                                | Authorization check                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/sign-in/email`                    | `POST`        | Anonymous                                   | Email and password (`scrypt`). Same failure for a wrong password and an unknown account.      | None needed. Sign-up is disabled, so the account already exists. Limited per IP and per normalized email (pre-authentication budget).                                                                                                                                                                                                                                                                                                                                     |
| `/api/auth/sign-out`                         | `POST`        | `user`                                      | Session cookie                                                                                | Acts on the caller's own session only.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/api/auth/get-session`                      | `GET`, `POST` | `user`                                      | Session cookie                                                                                | Returns the caller's own session. The 12-hour idle timeout applies, as on every session-bearing `/api/auth/*` route (Q75), and `session.updateAge` is one hour so an active session keeps `updatedAt` fresh and stays valid past 12 hours of age (Q69).                                                                                                                                                                                                                   |
| `/api/auth/two-factor/enable`                | `POST`        | `user`                                      | Session cookie and password                                                                   | Own account only. Returns the TOTP URI, which is why `get-totp-uri` is not allowlisted.                                                                                                                                                                                                                                                                                                                                                                                   |
| `/api/auth/two-factor/verify-totp`           | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                            | Own account only. A body with `trustDevice: true` is refused with `400 TRUST_DEVICE_NOT_SUPPORTED`, so every sign-in of an enrolled user is MFA-checked (Q61). Success writes an `mfa` step-up marker for the resulting session. It logs `login_succeeded` when it creates a new session and `step_up_succeeded` when it verifies an existing one (Q77). Limited per IP (pre-authentication budget) and, on an existing session, per user, 5 failures in 5 minutes (Q80). |
| `/api/auth/two-factor/generate-backup-codes` | `POST`        | `user`                                      | Session cookie and password                                                                   | Own account only. Refused with `AUTH_STEP_UP_REQUIRED` unless the session has a fresh `mfa` marker: a password alone never suffices. Codes are shown once.                                                                                                                                                                                                                                                                                                                |
| `/api/auth/two-factor/verify-backup-code`    | `POST`        | `user`                                      | Session cookie or the pending two-factor challenge                                            | Own account only. Same marker and limit as `verify-totp`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/api/auth/organization/set-active`          | `POST`        | `user`                                      | Session cookie                                                                                | Better Auth refuses an organization the caller is not a member of, and `resolveContext` independently re-checks membership on every request (fails closed).                                                                                                                                                                                                                                                                                                               |
| `/api/auth/sign-in/social`                   | `POST`        | Anonymous                                   | None; starts the flow with `provider: visma-connect`                                          | Registered only when SSO is configured. Authorization code with PKCE (`S256`), `state` and `nonce`. A body carrying `idToken` is refused with `400 BAD_REQUEST` before Better Auth, so a client-submitted ID token cannot bypass the code callback (Q60).                                                                                                                                                                                                                 |
| `/api/auth/callback/visma-connect`           | `GET`, `POST` | Visma Connect, through the caller's browser | The `code` and `state` Visma Connect returns (`form_post` or query), then a verified ID token | The Visma Connect `sub` must already be linked to a Tayzu user. Every failure is one identical `401 AUTH_SSO_REJECTED`. Never creates a user. The session stores the token's `sid`.                                                                                                                                                                                                                                                                                       |
| `/api/auth/link-social`                      | `POST`        | `user`                                      | Session cookie                                                                                | Links Visma Connect to the caller's own account. A body carrying `idToken` is refused with `400 BAD_REQUEST` (Q60). A Fastify pre-handler requires a fresh step-up marker first (`mfa`, or `password` when the caller has no enrolled factor), else `403 AUTH_STEP_UP_REQUIRED`, also when there is no valid session.                                                                                                                                                     |
| `/api/auth/unlink-account`                   | `POST`        | `user`                                      | Session cookie                                                                                | Own account only. Same step-up pre-handler as `link-social`. Refused if it would leave no sign-in method.                                                                                                                                                                                                                                                                                                                                                                 |
| `/api/auth/list-accounts`                    | `GET`         | `user`                                      | Session cookie                                                                                | Read-only, own account only.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/api/auth/verify-password`                  | `POST`        | `user`                                      | Session cookie and current password                                                           | Own account only. Success writes a `password` step-up marker (5 minutes) unless a fresh `mfa` marker already exists. This is the step-up for a user without MFA.                                                                                                                                                                                                                                                                                                          |
| `/api/auth/change-password`                  | `POST`        | `user`                                      | Session cookie and current password                                                           | Own account only. A user with an enrolled factor needs a fresh `mfa` step-up marker, else `403 AUTH_STEP_UP_REQUIRED`, so the password alone never suffices (Q70). A user without MFA is unaffected. `revokeOtherSessions` is forced on, so every other session of the user ends.                                                                                                                                                                                         |
| `/api/auth/jwks`                             | `GET`         | Anonymous                                   | None; public by design                                                                        | Publishes the public keys of the `jwt` plugin, which signs the machine access tokens (`EdDSA`). No private material.                                                                                                                                                                                                                                                                                                                                                      |

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

| Route                                                      | Operation              | Cerbos kind and action          | Who is allowed, inside the caller's own tenant                                                                                               | CSRF header | Step-up                                            |
| ---------------------------------------------------------- | ---------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------- |
| `POST /v1/blueprints`                                      | `blueprints.create`    | `catalog_blueprint`, `create`   | `admin`                                                                                                                                      | Yes         | No                                                 |
| `GET /v1/blueprints`                                       | `blueprints.list`      | `catalog_blueprint`, `list`     | `admin`, `member`                                                                                                                            | No          | No                                                 |
| `GET /v1/blueprints/{blueprint}`                           | `blueprints.get`       | `catalog_blueprint`, `view`     | `admin`, `member`                                                                                                                            | No          | No                                                 |
| `PUT /v1/blueprints/{blueprint}`                           | `blueprints.update`    | `catalog_blueprint`, `update`   | `admin`                                                                                                                                      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `DELETE /v1/blueprints/{blueprint}`                        | `blueprints.delete`    | `catalog_blueprint`, `delete`   | `admin`                                                                                                                                      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/blueprints/{blueprint}/entities`                 | `entities.create`      | `catalog_entity`, `create`      | `admin`; a `member` when the entity has no owner team; a member of the owner team; a moderator of the blueprint                              | Yes         | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities`                  | `entities.list`        | `catalog_entity`, `list` (plan) | `admin`, `member`. The plan is folded into the tenant-scoped query.                                                                          | No          | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.get`         | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                            | No          | No                                                 |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}`         | `entities.upsert`      | `catalog_entity`, `update`      | `admin`; a `member` when there is no owner team; a member of the owner team; a moderator. Denied to non-admins when `locked` is true.        | Yes         | No                                                 |
| `DELETE /v1/blueprints/{blueprint}/entities/{entity}`      | `entities.delete`      | `catalog_entity`, `delete`      | `admin`; a moderator of the blueprint; a `member` who created the entity. With `detachReferences`, also `update` on every distinct referrer. | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `PUT /v1/blueprints/{blueprint}/entities/{entity}/status`  | `entities.writeStatus` | `catalog_entity`, `update`      | The same rule as `entities.upsert`                                                                                                           | Yes         | No                                                 |
| `GET /v1/blueprints/{blueprint}/entities/{entity}/related` | `entities.listRelated` | `catalog_entity`, `view`        | `admin`, `member`                                                                                                                            | No          | No                                                 |

With `detachReferences: true`, `entities.delete` asks Cerbos for `catalog_entity` `update` on each distinct referrer, with its loaded attributes, before it detaches any spec-scope edge (Q65). One deny fails closed with the existing redacted reference violation and nothing is detached. Status-scope edges are system-written and point at the entity being deleted, so they are detached without a check on their observers (Q81).

Any other path under `/v1` is answered `401` when it has no valid credential
and `404` when it does. Blueprint identifiers beginning with `_` are reserved
for the `system` actor, which no HTTP credential can be.

### Step-up

The three operations marked `x-tayzu-risk: high` (`blueprints.update`,
`blueprints.delete`, `entities.delete`) need a fresh verification when a `user`
actor calls them. `createApp` applies `createStepUpGuard` to every `/v1`
operation through an interceptor, and the guard acts only on the marked ones.
Agents and integrations are never gated by step-up.

Step-up runs before the role check. The interceptor sits ahead of the
operation, and the operation is where Cerbos is asked, so a `member` calling a
high-risk route (including the high-risk identity routes below) sees the
step-up error first and `403 AUTH_FORBIDDEN` only after a successful step-up.
The order reveals nothing about the target and grants nothing.

| Session                                             | What the guard accepts                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local, user with an enrolled factor                 | A `step-up-verified` marker with factor `mfa`, written by a successful `/two-factor/verify-*` in the last 5 minutes. A `password` marker does not satisfy it.            |
| Local, user without an enrolled factor              | An `mfa` or a `password` marker, the latter written by `/verify-password`, in the last 5 minutes.                                                                        |
| Established through Visma Connect (`ssoSid` is set) | An ID token from a Visma Connect re-authorization (`max_age=300`, `prompt=login`, `acr_values=urn:idp:vismaconnect:mfa`) whose `auth_time`, `acr`, `amr` and `sid` pass. |

`/api/auth/change-password` follows the local rule for an enrolled user too (Q70), as a Better Auth hook rather than the oRPC guard. A failure is `403 AUTH_STEP_UP_REQUIRED`. For a Visma Connect session, when SSO
is configured, the error carries `data.reauthorizationUrl`, built on
`BETTER_AUTH_URL` (the first entry of `ALLOWED_ORIGINS` only when it is unset,
in test), never on a request header (Q64). A marker is keyed by the
session token, so it never carries over to another session.

## Identity routes (`/v1`, behind the mount gate)

Thirteen oRPC procedures of `identity-router.ts` (design D10), served by the
same `ALL /v1/*` handler as the catalog routes, so the context resolution, the
error mapping, the CSRF check and the per-principal limit of the catalog routes
apply to them. They are registered only when the mount gate is on, see
[Mount gate](#mount-gate). Every one is reachable only with a Better Auth
session cookie or a machine access token, and is allowed for an `admin` of the
caller's own tenant alone: a `member`, a machine `member` token included, gets
`403 AUTH_FORBIDDEN`. Every procedure is built with `defineIdentityOperation`
(Q45, Q57), which asks Cerbos first with the caller's tenant and no target, then
parses the input, resolves the target on the server inside the caller's tenant
(D14) and asks Cerbos again with the target's real tenant and attributes before
the handler runs. It fails closed. A cross-tenant or unknown target is
`404 CATALOG_NOT_FOUND`. `tenantId` and `actor` are never read from the input.
The Cerbos policies are `policies/resource_policies/user.yaml`,
`service_account.yaml` and `credential.yaml`, and the gating by action rather
than by the origin of the account is in
[ADR 0020](../adr/0020-cerbos-gates-invite-and-status-not-origin.md).

| Route                                            | Operation                | Cerbos kind and action      | CSRF header | Step-up                                            |
| ------------------------------------------------ | ------------------------ | --------------------------- | ----------- | -------------------------------------------------- |
| `POST /v1/users/invitations`                     | `users.invite`           | `user`, `invite`            | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/users/invitations/{invitation}/cancel` | `users.cancelInvitation` | `user`, `invite`            | Yes         | No                                                 |
| `POST /v1/users/invitations/{invitation}/resend` | `users.resendInvitation` | `user`, `invite`            | Yes         | No                                                 |
| `PUT /v1/users/{user}/status`                    | `users.setStatus`        | `user`, `updateStatus`      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/users`                                 | `users.create`           | `user`, `create`            | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/users/{user}/sso-account`              | `users.linkSsoAccount`   | `user`, `update`            | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `DELETE /v1/users/{user}/sso-account`            | `users.unlinkSsoAccount` | `user`, `update`            | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/service-accounts`                      | `serviceAccounts.create` | `service_account`, `create` | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `DELETE /v1/service-accounts/{user}`             | `serviceAccounts.delete` | `service_account`, `delete` | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `GET /v1/credentials`                            | `credentials.list`       | `credential`, `list`        | No          | No                                                 |
| `POST /v1/credentials`                           | `credentials.create`     | `credential`, `create`      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/credentials/{credential}/rotate`       | `credentials.rotate`     | `credential`, `rotate`      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |
| `POST /v1/credentials/{credential}/revoke`       | `credentials.revoke`     | `credential`, `revoke`      | Yes         | Yes, `x-tayzu-risk: high`, see [Step-up](#step-up) |

`{user}` is the `_user` identifier (an email, or `svc-…`), sent unencoded, and a
path holding `%` is Fastify's `404` (`002` Q74). Such identifiers never reach
telemetry (D16). Every procedure parses its input with one shared parser that
builds null-prototype objects, rejects `__proto__`, `constructor` and
`prototype` at every depth, rejects an undeclared field and checks length
limits before any lookup.

The fourteenth route is the public acceptance below, so the change exposes
fourteen routes in all (`045` adds `identity.organization.delete`).

### Public accept route

`POST /v1/auth/invitations/accept` is the first unauthenticated route that
changes data. It is a plain Fastify route, outside the tenant pipeline and not
in any OpenAPI document, and it is on the public-route allowlist of
`apps/api/src/public-routes.ts`. The invitation token is the credential. The
route derives the tenant from the invitation, never from the request, and
validates its body as an allowlist.

- **Rate limit.** A database-backed bucket per caller IP, default 10 requests
  per 60 seconds (`INVITATION_ACCEPT_RATE_LIMIT_MAX` and
  `INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS`, Q138, Q140). The limiter is
  never off.
- **Session binding.** A new person needs no session. An existing account is
  accepted only with a valid session cookie (read without refreshing it, and
  passing the idle timeout, the banned check and the temporary-password check)
  whose user email equals the invitation email, so the session proves control of
  the account and the token proves the mailbox (Q38). The acceptance never sets
  or changes a password for an existing account.
- **CSRF header and origin check.** The session is read only when the request
  carries the custom header `x-csrf-token: orpc` and an `Origin` header that is
  present and exact-matches `ALLOWED_ORIGINS` (Q24, Q38, Q47). `/v1` has only
  the custom header and Better Auth's origin check covers only `/api/auth/*`,
  so the route performs its own check. A request that fails it is treated as
  having no session, and an existing account gets the uniform rejection.
- **Step-up.** Only when the invited role is `admin`, and evaluated after the
  token verifies: the same guard as the catalog operations, with the
  Visma Connect re-authorization for an SSO session.
- **Failure shape.** One uniform rejection that never reveals why the
  acceptance failed.

### Public password-reset routes

`POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`
(`044` D1, D2) are the second and third unauthenticated routes that act on an
account. Both are plain Fastify routes outside the tenant pipeline, are not in
any OpenAPI document, and are on the public-route allowlist of
`apps/api/src/public-routes.ts` with a reason each. They exist only when
`MOUNT_IDENTITY_ROUTES` is `true`. With the switch off they answer like an
unknown `/v1` path, see [Mount gate](#mount-gate).

- **Request route.** Body `{ "email" }`. It answers `200 { "accepted": true }`
  for every address, with a minimum response time
  (`PASSWORD_RESET_MIN_RESPONSE_MS`, default 400 ms), so a known and an unknown
  address, a banned user and a user with no local password look the same. Only
  an admitted request issues a token and sends mail (kill switch,
  recipient-domain allowlist, disabled tenants, then the recipient, IP and
  global caps). A refused request changes no earlier token. Malformed,
  cross-site and over-limit requests answer `400` or `429`, which depend on the
  request alone.
- **Confirm route.** Body `{ "id", "token", "newPassword", "factor"? }`. The
  token, 256 bits of CSPRNG output stored as a digest, is the credential and
  travels in the body, never in a URL. Every account- or token-dependent
  refusal is one uniform `404 CATALOG_NOT_FOUND`. A user with a second factor
  must send it in the same request (`AUTH_STEP_UP_REQUIRED` otherwise), and a
  wrong factor spends the token's attempt budget. A completed reset changes the
  password, consumes the token and revokes every session in one transaction,
  then sends a notice.
- **CSRF header and origin check.** Both routes require
  `x-csrf-token: orpc` and an `Origin` in `ALLOWED_ORIGINS` before any lookup.
  They never read a session, so a request without either is always rejected.
- **Rate limits.** The per-IP buckets above. They are only as trustworthy as the
  pending `TRUST_PROXY` item under [Pending](#pending).
- **Parsing and caching.** The strict `043` parser (null-prototype objects,
  `__proto__`, `constructor` and `prototype` rejected at every depth,
  undeclared fields such as `redirectTo` rejected, lengths checked first).
  Every response carries `Cache-Control: no-store` and `Pragma: no-cache`.
- **No client-supplied redirect.** The link in the email is built from
  `PASSWORD_RESET_LINK_BASE_URL` and the fixed path `/reset-password`, with the
  identifier and token in the URL fragment. Until `003` serves that page the
  link is inert.
- **Source IPs for forensics (SEC16).** No signal carries the caller IP. The
  source of IP forensics for these routes is the Container Apps ingress logs,
  correlated with the trace id of the security events
  (`catalog.security.password_reset_denied`, `recovery_email_suppressed`). Their
  retention is a first-deployment item for `010`.
- **Admin route.** `POST /v1/users/{user}/mfa/reset` (`identity.users.resetMfa`)
  is an authenticated oRPC procedure behind the same switch, with Cerbos and
  step-up. It is not a public route.

### Inert invitation link

The email carries a link built from `INVITATION_LINK_BASE_URL` (outside test it
is required, `https` and one of `ALLOWED_ORIGINS`, Q32) and the fixed path
`/accept-invitation`. The invitation identifier and token travel in the URL
fragment, which browsers never send to a server. No page serves that path until
`003` builds one, so the link is inert today: following it reaches nothing that
accepts the invitation. The accept route is called by that future page.

### Mount gate

`MOUNT_IDENTITY_ROUTES` (`mountIdentityRoutes`) is **off by default** (D15). With
it off, none of the fourteen routes is registered, and each answers like an
unknown `/v1` path: `401 CATALOG_CONTEXT_REQUIRED` without a valid credential
and the oRPC `404` with one. State today: the switch is off, `identity.*` is not
mounted over HTTP, and the routes are exercised in process and by tests only. The
hard rule (`002` Q73) is that they are not mounted before the hand-offs from
`002` (group 13 of `043`) are done. Turning the switch on in a deployment is a
first-deployment gate for `010`.

### Identity OpenAPI document

`openapi/identity.openapi.json` lists the thirteen oRPC routes (not the accept
route) with paths, methods, path parameters and `x-tayzu-risk` only, with no
request or response schemas (Q52): the router hand-parses its input and the
change adds no schema dependency. A DAST scan of that document therefore
exercises route reachability and status codes, not the shape of any body, and
its value is limited until schemas exist. Extending the DAST scan to it stays a
first-deployment gate.

## Health, machine credential, back-channel and re-authorization routes

| Route                                         | Method        | Actor category                              | Authentication                                                                                                                                                                                         | Authorization check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`                                    | `GET`         | Anonymous                                   | None, by design                                                                                                                                                                                        | Liveness only. Answers `200 {"status":"ok"}` with no dependency check and no detail. Not rate limited. It shares the headers, CORS and `no-store` controls of every route.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/v1/auth/token`                              | `POST`        | `agent`, `integration`                      | Client id and secret of a machine credential in the JSON body, checked with `verifyApiKey`. A missing or non-string field is `400`. Any other failure is one identical `401 AUTH_INVALID_CREDENTIALS`. | Per-IP rate limit (30 per 60 seconds by default). Mints a 1-hour `jwt`-plugin token for the credential's tenant, actor and fixed `member` role; a credential without the `member` role fails closed. Revocation is checked on use within 5 seconds. Exempt from the per-principal limiter and from the CSRF check.                                                                                                                                                                                                                                                                 |
| `/v1/auth/visma-connect/backchannel-logout`   | `POST`        | Visma Connect (unauthenticated)             | None, by design. The caller is Visma Connect's infrastructure, so there is no cookie and no CSRF header. The `logout_token` is the only proof.                                                         | Answers `404` when SSO is not configured. Fail-closed validation in the order the code runs it: `typ` `logout+jwt`, `iss`, `aud`, `iat` and `exp` (30 seconds of skew), the back-channel `events` member, no `nonce`, a `sid` or `sub`, then the signature against the discovered JWKS (`RS256`) last, so a token that fails a cheap check triggers no outbound fetch, and finally `jti` replay. Rate limited per source IP. Answers `200` for every well-formed request whatever the outcome, and `400` only when `logout_token` is missing. Revokes only Visma Connect sessions. |
| `/v1/auth/visma-connect/reauthorize/callback` | `GET`, `POST` | Visma Connect, through the caller's browser | None. The single-use, unguessable `state` (10 minutes) is bound to the session that started the re-authorization, so no cookie is needed. `code` arrives in the query or a `form_post` body.           | Exchanges the `code` for an ID token and stores it under that session for the step-up guard, which validates it. Answers a bare `200`, or `400` for any failure, with nothing from the provider in the body. Always registered; without SSO configured it can only answer `400`.                                                                                                                                                                                                                                                                                                   |

## Blocked routes

These answer `404`, the same as a path that does not exist. They must never
be added to `ALLOWED_AUTH_ROUTES`. The reasons are the design decisions
named.

| Route or group                                                                                                            | Why it is blocked                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-up/email`                                                                                            | Public self sign-up is disabled (D22). It is off in Better Auth too, so an in-process call is refused as well.                                                                                                                                                                                                       |
| `POST /api/auth/admin/create-user`                                                                                        | Users are created only by `identity.users.create` or the bootstrap script, both in-process (D22).                                                                                                                                                                                                                    |
| `/api/auth/organization/invite-member`, `/update-member-role`, `/remove-member`, `/create`, `/delete`                     | A second, ungoverned authorization path next to Cerbos (D18). Membership changes go through Cerbos-gated procedures that call `auth.api.*` in-process.                                                                                                                                                               |
| `/api/auth/api-key/create`, `/get`, `/list`, `/update`, `/delete`                                                         | Machine credentials are created and revoked through Cerbos-gated code, never through the plugin's own routes (D18, D5).                                                                                                                                                                                              |
| `/api/auth/token` (the `jwt` plugin's session-bound route)                                                                | Needs a session and signs the user, not a machine credential. The machine access token is minted by `POST /v1/auth/token`. (`/api/auth/jwks` is allowlisted.)                                                                                                                                                        |
| `/api/auth/two-factor/get-totp-uri`, `/api/auth/send-verification-email`, `/api/auth/verify-email`                        | Removed from the allowlist. `/two-factor/enable` already returns the TOTP URI, and no email-verification flow exists (Q52, Q56).                                                                                                                                                                                     |
| Better Auth's own reset routes (`/api/auth/request-password-reset`, `/api/auth/reset-password` and the callback by token) | Replaced by the two Tayzu routes (`044` D1, Q2): Better Auth's token is stored in clear, travels in a query string and a redirect, and its request path ignores the caps, `banned` users and the mount switch. They stay off the allowlist and answer the same `404` as an unknown path, asserted by the drift test. |
| Every other `/api/auth/*` path                                                                                            | Deny by default (D18). A CI test enumerates Better Auth's mounted routes against the allowlist and fails when a new one appears unlisted.                                                                                                                                                                            |

## Not reachable over the network

| Capability                                                                                        | How it is reached                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `identity.*` procedure                                                                      | In-process through `createRouterClient`. Over HTTP only when `MOUNT_IDENTITY_ROUTES` is `true`, which is off by default, see [Mount gate](#mount-gate). Cerbos-gated on the `user`, `service_account` or `credential` kind.                                                                                                                                               |
| Machine credential creation and revocation (`createMachineCredential`, `revokeMachineCredential`) | In-process only. The only HTTP path is `identity.credentials.*` and `identity.serviceAccounts.*`, behind the same switch.                                                                                                                                                                                                                                                 |
| Hard rule (Q73)                                                                                   | `identity.*` and the machine-credential routes are not mounted over HTTP before group 13 of `043` (hand-offs from `002`) is done.                                                                                                                                                                                                                                         |
| Break-glass MFA recovery CLI (`recover:admin-mfa`)                                                | Run out of band by an operator from the production-network operator environment under Azure PIM (`044` D12). Never mounted. It connects as `tayzu_auth` and loads no Better Auth signing key.                                                                                                                                                                             |
| First-admin bootstrap script                                                                      | Run out of band by an operator. Calls the same `auth.api.createUser` path. Idempotent.                                                                                                                                                                                                                                                                                    |
| Cerbos PDP                                                                                        | gRPC from `apps/api`, with TLS unless `CERBOS_ADDRESS` is `localhost`, `127.0.0.1` or `[::1]` (the sidecar case, no TLS). Nothing outside the boundary can reach a loopback sidecar.                                                                                                                                                                                      |
| PostgreSQL                                                                                        | Outbound from `apps/api` over TLS with `sslmode=verify-full` (`createPool` refuses anything else), as `tayzu_app` for the catalog and `tayzu_auth` for Better Auth. Outside test, startup asserts neither role is privileged (Q62). The `tayzu_auth` identity has two more users in `044` (SEC14), see [Identity use of `tayzu_auth`](#identity-use-of-tayzu_auth-sec14). |

## Outbound calls to an external system

| Destination                  | Calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visma Connect                | HTTPS (`https` is required outside test). Discovery at startup, which fails startup when the provider cannot be discovered, then the authorize redirect, the token exchange, the JWKS and userinfo. A failure at sign-in time is a rejected sign-in and never a partial one, and a userinfo failure does not block a sign-in. The step-up re-authorization adds one token exchange with a 5-second timeout.                                                                                                                                                |
| Pwned Passwords              | HTTPS to `api.pwnedpasswords.com`, the range query of Better Auth's `haveIBeenPwned` plugin (Q23). Only the first five hex characters of the password's SHA-1 leave the system (k-anonymity), see [Cryptography inventory](crypto-inventory.md). It runs wherever a password is set: the invitation acceptance, `identity.users.create`, the bootstrap script, a password change and the password-reset confirm route (`044` D7). It fails closed: when the service is unreachable the password is not set and the caller gets the generic `500 INTERNAL`. |
| Azure Communication Services | HTTPS, from the `EmailSender` adapter that sends the invitation email (D5), the reset email and the notices (`044` D5, D8), and from the `recover:admin-mfa` CLI for its one notice (`044` D12), when `EMAIL_PROVIDER` is `acs`. The recipient is validated and gated first (kill switch, disabled tenants, caps and the recipient-domain allowlist). The template is fixed and carries no attachment.                                                                                                                                                     |
| OTLP collector               | OpenTelemetry export of traces, metrics and logs to the `OTEL_EXPORTER_OTLP_*` endpoints. Outside test, startup fails without an endpoint unless `TAYZU_TELEMETRY_DISABLED=true`.                                                                                                                                                                                                                                                                                                                                                                          |

`044` adds no new destination: the confirm route reuses the Pwned Passwords range call and the mail path reuses Azure Communication Services.

## Email and phishing (SEC11)

The answers of Resolved decision Q34 of `043` for the invitation email, extended
by `044` (D5, D8) for the reset email and the notices. The platform now sends
several kinds of email.

1. The platform sends email: yes. The invitation, the password-reset email and
   four notices (password changed, MFA changed, MFA reset, account created).
2. The invitation email and the reset email each hold one clickable link. The
   notices hold none.
   - The invitation link is unavoidable for an invitee who has no account yet.
     It is mitigated by the token in the URL fragment, single use, a 48-hour
     expiry and a configured origin (`INVITATION_LINK_BASE_URL`).
   - The reset link is the single justified link of the reset path, the form
     OWASP's forgot-password guidance permits. It is mitigated by the token in
     the fragment, single use, a 30-minute expiry, a fixed path and a configured
     origin (`PASSWORD_RESET_LINK_BASE_URL`, one of `ALLOWED_ORIGINS`), and the
     request schema rejects any client-supplied `redirectTo`.
3. The content is the same for every recipient: only the recipient address
   varies (and, for the two link emails, the link and the expiry text).
4. There are no attachments. The ACS adapter disables tracking and sets no
   Reply-To for every template.
5. Each template is fixed and the recipient is validated. A notice goes to the
   account's own address read from the auth schema, never from request input.
6. Volume is bounded by the caps under
   [Controls](#controls-that-apply-before-a-route-runs), the recipient-domain
   allowlist, the disabled-tenant list and the kill switch.
   `INVITATION_EMAIL_KILL_SWITCH` keeps its name but now stops every email
   (renaming it is a ticket).

## Identity use of `tayzu_auth` (SEC14)

`044` adds no migration and no grant, but the `tayzu_auth` database identity
gains two users, both listed here so `043`'s O-7 (narrowing the role) covers
them:

| User                                               | What it touches                                                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The unauthenticated reset routes (`apps/api`)      | `auth.verification` (reset and attempt rows), `auth.rate_limit` (route and email caps), `auth.user`, `auth.account` and `auth.session` (the completed reset), `auth.two_factor` (the factor check). |
| The `recover:admin-mfa` CLI (operator environment) | `auth.two_factor`, `auth.session`, `auth.user` and the re-enrolment marker; it reads membership to resolve its target.                                                                              |

The role has full CRUD on the `auth` schema (`0003`). Narrowing it, with these
two users now in scope, is `043` O-7 and a ticket of `044`.

## Pending

Human-owned and deployment-coupled items. Each one is a gate for the first
deployment (`010`), next to task 11.12, in the design's "Gates for the first
deployment".

| Item                                                        | State                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS minimum and HSTS on the public ingress (task 11.12)     | Pending. HSTS is set by the application, but the ingress belongs to `010`. It is now Gate 9 of `044` before `MOUNT_IDENTITY_ROUTES` is turned on (Q25): the record is the table in [Dependencies](dependencies.md#tls-and-hsts-posture-on-the-public-aca-ingress-task-1112-sec05). |
| Verification against Visma Connect's test environment (Q57) | Pending. `sid` present and preserved on `prompt=login`, and the `form_post` callback under the production origin check.                                                                                                                                                            |
| `MIGRATION_DATABASE_URL` wiring (Q58)                       | Pending. The runtime role assertion is done (task 25.3), but `db:migrate` still reads `DATABASE_URL`, see [Secrets](secrets.md).                                                                                                                                                   |
| Configurable `TRUST_PROXY` (Q58)                            | Pending. The trusted proxy ranges are fixed in code and must be verified against the ACA ingress peer range.                                                                                                                                                                       |
| SSO step-up callback bound to the browser (Q71)             | Pending. `nonce`, `response_mode=query` and the session cookie at the callback, tested with Q57 against Visma Connect's test environment.                                                                                                                                          |
| Back-channel logout and replicas (Q73)                      | Pending. Confirm Visma Connect sends `typ: logout+jwt`, and that the rate-limit stores are shared across replicas.                                                                                                                                                                 |
| Cerbos audit log (Q58)                                      | Pending. It must go to stdout and on to Azure Monitor.                                                                                                                                                                                                                             |

## Where the code differs from the design

The code is authoritative. Each row is a design or task sentence the running
code does not match yet, recorded so the design or the code can be reconciled
before Checkpoint 2.

| Design says                                                                         | The code does                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 23.2, Known residual risks: `R.attr.tenantId` comes from the loaded entity row | The catalog pipeline sends `ctx.tenantId` as `R.attr.tenantId` for every operation (`buildAttributes` drops any `tenantId` in the extra attributes). The loaded row supplies `ownerTeam`, `createdBy` and `locked`, not the tenant. |
