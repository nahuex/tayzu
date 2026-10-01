# ADR-0016: Machine credentials are exchanged for short-lived tokens

- **Status**: Accepted
- **Date**: 2026-09-29
- **Change**: [`002-auth-and-rbac`](../../openspec/changes/002-auth-and-rbac/design.md) (design D5, D20, D21; Resolved decisions Q5, Q13, Q28)

## Context

Agents and integrations call the API without a browser session. They need a
credential that an admin can create, revoke and rotate, that is safe at rest,
and that limits the damage of a leak. Better Auth's organization-owned
`apiKey` cannot be used as a bearer token directly: organization-owned keys
do not support `enableSessionForAPIKeys`. Resolved decision Q5 also asks for
a short-lived derived token.

A stateless signed token has a second problem: revoking the long-lived
credential does not stop a token that was already issued.

## Decision

1. **The long-lived credential is a Better Auth `apiKey`** under the config
   `machine-credential` (`references: "organization"`, prefix `tayzu_mc_`).
   The key's `id` is the client id, and the generated key is the client
   secret, shown once and stored hashed. The key's metadata fixes the
   `actorKind` (`integration` or `agent`) and the role at creation time. The
   caller of the exchange never chooses either.

2. **`POST /v1/auth/token` is not a Better Auth route.** It verifies the
   client id and secret with `auth.api.verifyApiKey`, scoped to the
   `machine-credential` config, and mints a token with the `jwt` plugin's
   server-only `signJWT`: the session-bound `getToken` route cannot be used
   because the caller has no session. The token is asymmetric-signed, expires
   one hour after issuance, and has no refresh token. Its claims carry the
   tenant (the key's organization), the actor kind and id, and the role.
   `sub` is the client id, because the plugin's verifier rejects a token
   without it. Any failure returns `AUTH_INVALID_CREDENTIALS` (401), and
   an unknown client id, a wrong secret and a revoked credential are
   indistinguishable to the caller.

3. **Every machine credential is `member`.** The role is stored on the
   credential, carried in the token and never `admin`, because machine actors
   skip step-up (Q28). A credential without a stored role fails closed.
   `resolveContext` builds the principal from the token's role, never from
   input. Cerbos then decides what that `member` may do, the same as for any
   other actor.

4. **Rotation is revoke-and-recreate.** Better Auth ships no rotate endpoint.
   The rotation policy (reminders, UX) belongs to `043`.

5. **Revocation takes effect within 5 seconds.** Revoking a credential
   disables the `apiKey` row and, in the same operation, inserts a row into
   `machine_credential_revocation` (`credential_id`, `revoked_at`,
   `tenant_id`), a catalog-schema table under the same RLS and `FORCE` rules
   as every catalog table (`tayzu_app` has `SELECT` and `INSERT` only). The
   machine-token branch of `resolveContext` checks this table on every
   machine-token request through an in-process cache keyed by
   `credential_id`, with a TTL of 5 seconds. A lookup failure rejects the
   request as `CATALOG_CONTEXT_REQUIRED`; it never assumes "not revoked".

6. **Pre-authentication throttling.** The exchange has no tenant or actor
   yet, so it gets its own `@fastify/rate-limit` bucket keyed by source IP and
   the client id from the body (hashed for the bucket key), separate from the
   per-principal bucket. A blocked request returns `429`
   `AUTH_RATE_LIMITED` with `Retry-After`.

7. **Telemetry.** `auth.token.exchange` span, `tayzu.auth.token.exchanges`
   and `tayzu.auth.token.revocation_checks` counters, and the
   `auth.security.token_exchange_failed` and
   `auth.security.revoked_token_rejected` log events. None carries the client
   id, the secret, the token or the caller's IP.

## Alternatives considered

- **Use the raw API key as the bearer token.** Rejected: organization-owned
  keys cannot use `enableSessionForAPIKeys`, and it would make the
  long-lived secret the per-request credential.
- **A shorter access-token lifetime instead of a revocation list.** Rejected:
  it shrinks the window but does not close it, and Q13 asks for immediate
  effect, bounded by seconds.
- **A shared cache such as Redis for the revocation check.** Rejected for
  now: no such component exists in the stack, and a 5-second in-process TTL
  bounds cross-replica staleness to the same 5 seconds.
- **A per-credential role chosen at creation.** Rejected for 002: `member`
  only, so no machine credential can reach admin-only actions, and `043`
  can widen this deliberately.

## Consequences

- A leaked access token is useful for at most one hour, and for at most 5
  seconds after an admin revokes its credential. A leaked client secret is
  useful until revoked.
- The revocation table is a new Checkpoint 3 migration (`0008` and `0009`),
  separate from the roles and RLS migration
  ([ADR-0014](0014-postgres-roles-and-forced-rls.md)).
- Each replica reads Postgres at most once per credential per 5 seconds
  while that credential is in use.
- The signing key is the `jwt` plugin's own, published by the plugin for
  `026-mcp-server` to reuse. It is protected by `BETTER_AUTH_SECRET`, so
  rotating that secret is a scheduled event
  ([`docs/security/secrets.md`](../security/secrets.md)).
- **Implementation state at the time of writing.** The exchange logic
  (`exchangeMachineToken` in `@tayzu/auth`), the token branch of
  `resolveContext`, the revocation list and the exchange rate-limit hook all
  exist. `apps/api/src/server.ts` does not yet mount a handler for
  `POST /v1/auth/token`, and it does not expose the plugin's `/jwks` route
  (not on the allowlist). Both are listed in
  [`docs/security/attack-surfaces.md`](../security/attack-surfaces.md) as
  pending.
