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
- `@fastify/helmet` with `contentSecurityPolicy: false`; `CORSPlugin` with an
  explicit origin allowlist and `credentials: true`;
  `SimpleCsrfProtectionHandlerPlugin` on every mutating route.

## Tests

- Integration tests (`*.int.test.ts`) need a real PostgreSQL 16
  (`DATABASE_URL`) and a running Cerbos container (`compose.yaml`'s `cerbos`
  service, or CI's).
- The allowlist-drift test (`auth-route-allowlist.test.ts`) enumerates Better
  Auth's actual mounted routes against the allowlist constant — keep it
  green whenever a Better Auth plugin version bump adds a route.
