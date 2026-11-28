# @tayzu/api

Tayzu's first application: the Fastify bootstrap mounting Better Auth's
handler and one oRPC handler over the catalog and identity routers. Global rules are in the root
`CLAUDE.md`. The design is `openspec/changes/archive/2026-10-15-002-auth-and-rbac/design.md`
(D13, D18-D21); the behavior is `specs/auth-and-rbac/spec.md` in the same
change. Change `043` (design D10, Resolved decision Q30) adds the identity
orchestration described below. When code and design disagree, stop and ask.

## Layout

- `src/server.ts` (`createApp`) and `src/main.ts` (process entry point) are
  the Fastify bootstrap; `src/index.ts` is still the empty entry point.
- `src/identity/` holds the identity orchestration of change `043`
  (invitations, acceptance, service accounts, credentials, the SSO link shed,
  the user-sync adapter, `defineIdentityOperation`).
- `src/identity-router.ts` is the `identity.*` router. `createApp` merges it
  with the catalog router into **one** router handed to the one
  `OpenAPIHandler`, so the interceptor chain (step-up, error mapping) reaches
  both (D10).
- `src/identity/` also holds the recovery of change `044`: the public
  password-reset request and confirm routes (`password-reset-request.ts`,
  `password-reset-confirm.ts`), the token store (`reset-token-store.ts`), the
  mailer with its caps (`recovery-mailer.ts`), the MFA reset service
  (`mfa-reset.ts`, behind `identity.users.resetMfa`) and the auth repository
  module (`auth-repository.ts`), the only place that writes `auth.*` SQL for
  the reset. Both public routes sit behind `MOUNT_IDENTITY_ROUTES`.
- Change `003` (design D8 to D11) adds the web app's server side:
  - `src/web-static.ts` serves the Vite build of `apps/web` when
    `WEB_DIST_DIR` is set: the hashed files under `/assets/` through
    `@fastify/static` (`wildcard: false`, one route per file read once at
    startup, `dotfiles: 'deny'`, `immutable`), and the explicit root build
    files `/theme-init.js` and `/favicon.svg`, read into memory once
    (`no-cache`). Nothing else in the build root is ever served.
  - `src/spa-fallback.ts` is the SPA fallback, one `GET /*` route that answers
    the in-memory `index.html` (`no-store`, the response's style nonce in place
    of `__TAYZU_STYLE_NONCE__`) for an app path, and `callNotFound()` for any
    other path. It never reads the session, and it has its own rate-limit
    bucket of 300 per minute per address.
  - `src/spa-paths.ts` exports `isSpaPath(pathname)`, the one predicate for
    "an app path": not `/v1`, `/api` or `/assets` (whole segments), not
    `/healthz` and not a root build file, case-sensitive, with no
    file-extension rule. The fallback and the `/{spa}` span template of
    `src/telemetry.ts` both use it; never write a second one.
  - `src/style-nonce.ts` draws the 128-bit style nonce per response.
  - `GET /v1/me` (in `server.ts`) answers the shell's view of its own session
    through `createSessionStateResolver` of `@tayzu/auth`. It is a plain
    Fastify route registered before the `/v1/*` catch-all, reads the session
    cookie only (never the path, query, body or a bearer token), answers every
    rejection with the catch-all's uniform `401`, and uses the per-principal
    bucket.
  - With `WEB_DIST_DIR` set, the Visma Connect re-authorization callback
    answers `303` to the constant `/step-up/complete` paths instead of JSON.
  - `WEB_DIST_DIR` is optional and validated by `loadConfig` (an absolute path
    to a readable directory containing `index.html`); unset, none of the web
    routes exists. Every web route is a reviewed entry of
    `PUBLIC_ROUTE_ALLOWLIST` in `src/public-routes.ts`.
- `scripts/` holds the `tsx` scripts (`bootstrap-admin.ts`,
  `backfill-user-blueprint.ts`, `reconcile-users.ts`, the break-glass `recover-admin-mfa.ts`, the identity contract
  generate and check scripts). Vitest includes only `src/**`, so a script has
  no test beside it: its tests live in `src/` and import `../scripts/<name>.js`.

## Boundaries

- Catalog domain logic belongs in `@tayzu/catalog`, and the pure identity
  parts (status machine, invitation token, password policy, email port and
  the structural ports) in `packages/auth/src/identity/`. This app is
  bootstrap glue (Fastify server, route mounting, process lifecycle) plus,
  since change `043`, the identity orchestration and router: `@tayzu/auth`
  has no `@orpc/server` or `@tayzu/catalog` dependency, so the code that needs
  them lives here, behind the structural ports of `@tayzu/auth` (the
  `UserSyncPort` pattern; Resolved decision Q30). `002` D1 said this app owns
  nothing domain-specific; `043` amends that.
- Better Auth's native organization-management and `apiKey` management
  routes are **not reachable** through this app: a deny-by-default allowlist
  at the Fastify routing layer returns `404` for them (D18). Every membership
  or credential mutation instead goes through a Cerbos-gated oRPC procedure
  calling `auth.api.*` in-process. Better Auth's three password-reset routes
  stay closed too: Tayzu's own routes replace them (044 D1).
- `resolveContext` (from `@tayzu/auth`) is the only way a request becomes a
  `CatalogContext`. Nothing else in this app resolves `tenantId` or `actor`.
- No HTTP listener existed before this change (ADR-0011) — this is genuinely
  the first one. Keep the defenses a public-facing API needs from day one:
  CORS, CSRF, security headers, body size limits, rate limiting.

## Conventions

- `inputStructure: 'detailed'` so `DELETE`/`GET` routes read the query string
  at runtime, not just in the generated OpenAPI document (D13, 001 follow-up).
- An `OpenAPIHandler`-level `clientInterceptors` entry converts a thrown
  `CatalogError`/`AuthError` into a real `ORPCError` carrying its
  `status`/`code`/`data` — no collapsing to a generic 500.
- Rate limiting (`@fastify/rate-limit`) is keyed by
  `${tenantId}:${actorType}:${actorId}` for authenticated traffic, and
  separately by IP alone for `POST /v1/auth/token` (D20). Neither key
  component is ever logged or exported as a telemetry attribute.
- `@fastify/helmet` sets the strict self-only CSP of `003` D10 (ADR-0026) on
  every response, HTML, JSON, assets and `404`s alike, with
  `useDefaults: false` and a `style-src` nonce read from `style-nonce.ts`,
  plus `X-Frame-Options: DENY`, COEP `require-corp` and HSTS; a hook beside it
  sets `Permissions-Policy`. Helmet and that hook are registered just before
  the Q74 hook, which stays the first hook that reads the request, so its
  `404`s carry the headers too. `CORSPlugin` with an explicit origin allowlist
  and `credentials: true`; `SimpleCsrfProtectionHandlerPlugin` on every
  mutating route.
- `@fastify/rate-limit` runs with `global: false`: a route opts in to its own
  bucket through `config.rateLimit`.
- The client address (`request.ip`) is trusted only through `trustProxy`
  built by `createTrustProxy` from `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS`
  (`048` design D2): a hop counts only within the count and from a peer
  inside the ranges. Never key a limiter on a raw `X-Forwarded-For` header.

## Tests

- Integration tests (`*.int.test.ts`) need a real PostgreSQL 18
  (`DATABASE_URL`) and a running Cerbos container (`compose.yaml`'s `cerbos`
  service, or CI's).
- The allowlist-drift test (`auth-route-allowlist.test.ts`) enumerates Better
  Auth's actual mounted routes against the allowlist constant — keep it
  green whenever a Better Auth plugin version bump adds a route.
