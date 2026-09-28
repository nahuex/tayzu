# @tayzu/api

Tayzu's first application: the Fastify bootstrap mounting Better Auth's
handler and the catalog's oRPC handler. Global rules are in the root
`CLAUDE.md`. The design is `openspec/changes/002-auth-and-rbac/design.md`
(D13, D18-D21); the behavior is `specs/auth-and-rbac/spec.md` in the same
change. When code and design disagree, stop and ask.

## Scaffolding state

Currently an empty scaffold (task 1.2): `src/index.ts` exports nothing yet,
and `src/smoke.test.ts` only checks the entry point loads. Group 11 fills
this in, task by task, per `tasks.md`.

## Boundaries

- This app owns nothing domain-specific: it is bootstrap glue (Fastify
  server, route mounting, process lifecycle) over `@tayzu/auth`,
  `@tayzu/authz` and `@tayzu/catalog` (D1). Domain logic belongs in those
  packages, not here.
- Better Auth's native organization-management and `apiKey` management
  routes are **not reachable** through this app: a deny-by-default allowlist
  at the Fastify routing layer returns `404` for them (D18). Every membership
  or credential mutation instead goes through a Cerbos-gated oRPC procedure
  calling `auth.api.*` in-process.
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
  separately by IP + client id for `POST /v1/auth/token` (D20). Neither key
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
