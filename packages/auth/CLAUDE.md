# @tayzu/auth

Better Auth instance, its own Postgres schema, and the `resolveContext`
context resolver. Global rules are in the root `CLAUDE.md`. The design is
`openspec/changes/002-auth-and-rbac/design.md` (D1-D6, D18-D21); the behavior
is `specs/auth-and-rbac/spec.md` in the same change. When code and design
disagree, stop and ask.

## Layout

`auth.ts` (the Better Auth instance), `context-resolver.ts`, `step-up.ts`,
`rate-limit/`, `persistence/schema.ts` (tables in schema `auth`) and
`telemetry/` (the package's executable telemetry contract). `tasks.md` in
002 lists what each remaining group adds.

## Boundaries

- Own Postgres schema `auth`, own database role `tayzu_auth` (full CRUD on
  `auth` only, zero grants on any `catalog_*` table). Better Auth's tables
  never live in `public` and are never queried through
  `withTenantTransaction` — that seam is `@tayzu/db`'s, for catalog tables
  only.
- `drizzleAdapter(db, { schemaName: "auth" })` from
  `@better-auth/drizzle-adapter` (the dedicated package, not the bundled
  `better-auth/adapters/drizzle` export). `dynamicAccessControl` and `teams`
  stay off: Cerbos is the only authorization decision point, and `_team` is a
  catalog system blueprint, not a Better-Auth-native notion (D2).
- `tenantId = session.activeOrganizationId`. `resolveContext(headers)` never
  reads `actor.onBehalfOf` from a header, body, path or query string, even if
  a client supplies one (D3) — that field stays host-resolved only.

## Conventions

- Session policy: Better Auth's own 7-day `expiresIn` / 1-hour `updateAge` (Q69),
  plus a 12-hour idle timeout layered on top (checked against the session
  row's `updatedAt`, not a Better Auth option). `changePassword` always calls
  `revokeOtherSessions: true` (D3).
- Step-up (D4) is an oRPC-level guard, not a Better Auth feature: it reads
  `x-tayzu-risk: high` off the procedure's route and requires an MFA
  verification in the last 5 minutes, for `user` actors only. Better Auth has
  no verified-at field, so the freshness marker is a row in its
  `verification` table (`step-up.ts`).
- Machine credentials (D5): the `apiKey` plugin config `machine-credential`,
  exchanged at `POST /v1/auth/token` for a 1-hour `jwt`-signed access token.
  Revocation writes to `machine_credential_revocation` (`@tayzu/db`, RLS-
  scoped like every catalog table), not only to the `apiKey` row.
- Rate limiting (D20, resolved decision Q15): the plugin in `rate-limit/`,
  with one IP bucket and one normalized-email bucket per route, keys stored
  as sha256 hashes in `auth.rate_limit`, and atomic increments. Better Auth's
  built-in `rateLimit` stays disabled; it cannot key by email or return
  `Retry-After` with `AUTH_RATE_LIMITED`.
- Secrets (`BETTER_AUTH_SECRET`, the `jwt` signing key, DB role passwords)
  come from the environment only, Key-Vault-referenced in the Azure Container
  Apps deployment. Never log or print them.

## Tests

- Integration tests (`*.int.test.ts`) need a real PostgreSQL 16
  (`DATABASE_URL`) and a running Cerbos container once group 7+ code calls
  into `@tayzu/authz`.
- Self sign-up does not exist: users are created by an org admin or the
  first-admin bootstrap. Sign-in failures must be identical in status, error
  code and body shape whether or not the account exists.
