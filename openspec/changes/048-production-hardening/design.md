# Design: 048-production-hardening

## Context

- **Why and what**: see `proposal.md`. This change is the code half of the first
  deployment. Roadmap decision D14 (`openspec/project.md` §23, 2026-11-27) split it from
  `046-azure-deployment-and-first-release`, which keeps the IaC, the pipeline, the sandbox
  rehearsal, the alerts, the retention settings and the release checklist. Execution order:
  `002 -> 043 -> 044 -> 045 -> 003 -> 048 -> 046`. Nothing here needs Azure access: every
  item is test-driven against the local stack (PostgreSQL 18, the pinned Cerbos image, the
  OIDC stub).
- **Source of the items.** The gate inventory of 2026-11-27 (81 gates across `002:1334-1358`,
  `043:3632-3717`, `044:1417-1460`, `045:914-949` and `003:1167-1194`, where `002` is
  `openspec/changes/archive/2026-10-15-002-auth-and-rbac/design.md` and the others are the
  archived designs of the same id) found ten that need application code. Item ids below
  (B1, D3, D7, D8, D10, C1, C2, F4, F6, F8, G3, G10, G12, G13) are the inventory's.
- **Decisions.** The human answered Q1 to Q16 in chat on 2026-11-27; Q17 to Q20 are the
  orchestrator's, open to Checkpoint 1 ("Resolved decisions"). The questions this design
  raised were asked in chat on 2026-11-27 and are recorded as Q21 to Q31.
- **Code state this design builds on** (repository at `ae89a3e`):
  - `db:migrate` (`packages/db/src/run-migrations.ts:9-22`) reads `DATABASE_URL`; the TLS
    error of `packages/db/src/connection-security.ts:52-53` names `DATABASE_URL` whatever
    variable held the URL; `turbo.json:43-46` passes only `DATABASE_URL`; `scripts/ci/e2e.sh:224-233`
    and `scripts/ci/dast.sh:168-204` export the image superuser URL as `DATABASE_URL` to
    migrate. The inverse check for runtime pools is `apps/api/src/bootstrap.ts:25-33`.
  - Fastify trusts every private range (`apps/api/src/server.ts:665-670`,
    `trustProxy: ['loopback', 'linklocal', 'uniquelocal']`); `request.ip` keys the
    back-channel, token-exchange, reset, `/v1` fallback, SPA fallback and accept limiters.
  - The step-up re-authorization (`apps/api/src/reauthorization.ts:1-11,168-271`) binds
    the callback to the session only through the single-use `state`; it sends no `nonce`
    and no `response_mode`, and the callback is mounted for `GET` and `POST`
    (`server.ts:978-1033`) with a scoped form parser.
  - Passwords are hashed by `better-auth/crypto` (`packages/auth/src/auth.ts:216-223,986-997`),
    which fixes scrypt at `N=16384, r=16, p=1`, normalizes NFKC inside, stores
    `<salt hex>:<key hex>` and compares with `===` (installed `@better-auth/utils@0.4.2`).
    It takes no cost option, so the cost can only change through a Tayzu-owned function.
  - `BETTER_AUTH_SECRET` is one key (`apps/api/src/config.ts:443-446`, `server.ts:91,432`,
    `apps/api/scripts/script-config.ts:16,47,120`). `better-auth@1.7.7` supports a versioned
    `secrets` option (`@better-auth/core` `init-options.d.mts:517-532`), but when only
    `secrets` is passed its context still takes the legacy decryption key from the ambient
    `BETTER_AUTH_SECRET` (`better-auth` `dist/context/create-context.mjs:70-81`). Cookie
    signing always uses the first entry (`dist/cookies/index.mjs:109,157,172`).
  - No CSP report directive or endpoint exists (`server.ts:276-309`; ADR-0026 point 9).
  - `config/cerbos.yaml:21-27` uses the `local` audit backend; it is the only Cerbos
    configuration.
  - Token exchange and back-channel logout use in-memory `@fastify/rate-limit` buckets keyed
    by IP (`server.ts:946-958,1046-1063`); token exchange is keyed by IP only (`002` Q56),
    while `auth-and-rbac` "Pre-authentication rate limiting" requires the IP and the client
    id: a drift this change closes (Q11).
  - The back-channel replay guard is one `insert ... where not exists` over a non-unique
    index (`server.ts:879-920`, `packages/db/migrations/0002_auth_schema.sql:150`), with the
    session delete outside any transaction; discovery and JWKS are fetched per token, and
    `exp - iat` is unbounded (`packages/auth/src/sso/backchannel-logout.ts`; `002:1324`).
  - No pre-purge warning exists; the marker has no `warned_at`
    (`packages/db/migrations/0012_tenant_deletion.sql`), and no role reads a marker 24 to
    48 hours before it is due (`0013`).
  - ACS is reached with `ACS_CONNECTION_STRING`
    (`packages/auth/src/identity/email/azure-communication-email.ts:56-82,115-127`,
    `config.ts:333-367`, `script-config.ts:22,57,76`). The installed `EmailClient`
    already accepts `(endpoint, TokenCredential)`.
  - The identity wrapper and the accept flow turn a Cerbos error into `false`
    (`apps/api/src/identity/define-operation.ts:145-170,186-191`,
    `apps/api/src/identity/accept-flow.ts:281-294`), so an outage is counted as `deny`.
  - A rejected `/organization/set-active` is restored silently (`auth.ts:1446-1459`).
  - `BETTER_AUTH_URL`'s origin is never checked against `ALLOWED_ORIGINS`
    (`config.ts:242-258`).
- **Cross-cutting constraints.** `config.test.ts:225-232` requires every secret variable to
  have a row in `docs/security/secrets.md`; the web bundle check reads the Secret-class names
  from that table; `turbo.json` runs in strict env mode; a new public Fastify route is a
  reviewed entry of `PUBLIC_ROUTE_ALLOWLIST` (`apps/api/src/public-routes.ts`) enforced by
  `route-auth-allowlist.int.test.ts`; the auth contract test requires
  `packages/auth/src/telemetry/contract.ts` to equal the `auth.*` subset of
  `packages/authz/src/telemetry/contract.ts`.
- **References.** No row of `docs/references/platform-engineering/README.md` names `048`
  or `046`, and no decision below relies on a report.

## Goals / Non-Goals

**Goals:**

- Close every code gate of the inventory that the proposal lists, so that `046` only
  configures and verifies them in the deployed environment.
- Change no externally visible behaviour beyond what the specs state: the routes, error
  codes and answers stay as they are, except the removed `POST` re-authorization callback
  and the new `POST /v1/csp-reports`.
- Keep every startup rule fail-closed: a missing or malformed new variable stops startup
  outside `NODE_ENV=test`, and every error names only the variable.

**Non-Goals:**

- Any value that depends on the deployed environment (hop counts, CIDRs, the replica
  ceiling, retention, the Visma Connect production client, the ACS resource and its Azure
  role assignment): `046`.
- The Visma Connect test-environment run (F2), the `sid`/`sub` decision after it (F5), the
  reset response-time floor (I5), the exporter and collector checks (G1, G2), the alerts and
  their KQL: `046`.
- Redis or any other new shared store (`004`); the `/v1` per-principal limiter and the SPA
  fallback stay per replica.
- Argon2id; `jose` (the back-channel verifier stays hand-rolled, `002` D26); automatic JWKS
  rotation; the `auth.rate_limit` prune janitor (still a ticket).
- Any Cerbos policy change.

## Decisions

### D1. Migrations run only as the migration role (B1, Q5)

- `packages/db/src/run-migrations.ts` gains a pure `resolveMigrationUrl(env)`: it reads
  `MIGRATION_DATABASE_URL` only; unset or blank throws the fixed
  `'MIGRATION_DATABASE_URL is not set: db:migrate needs the migration role's connection string.'`.
  It never reads `DATABASE_URL`, so no environment can migrate through the runtime URL by
  accident.
- Before `runMigrations`, `assertMigrationRole(pool)` runs `select current_user` and
  refuses when it is in `RUNTIME_DATABASE_ROLES`, a constant exported by `@tayzu/db`:
  `tayzu_app`, `tayzu_auth`, `tayzu_purge`, `tayzu_deletion_admin` and `tayzu_purge_warning`
  (D14). The message is fixed, `'db:migrate refuses to run as a runtime database role.'`, and
  names no role, user or host. This is the inverse of `assertRuntimeRole`; it still lets CI
  migrate as the image superuser, and `046` provisions `tayzu_migrator` with `CREATEROLE`
  and `CREATE` on the database (`0013` and `0017` create roles).
- `assertVerifiedTls(url, variable)` and `createPool(url, { variable })` take the name of the
  variable that held the URL, defaulting to `DATABASE_URL`, and the TLS message names it.
  The migration command passes `MIGRATION_DATABASE_URL`; the other pools may pass theirs.
- Wiring: `turbo.json` `db:migrate.env` becomes `["MIGRATION_DATABASE_URL"]`;
  `scripts/ci/e2e.sh` and `scripts/ci/dast.sh` export the owner URL they already use as
  `MIGRATION_DATABASE_URL` before `pnpm db:migrate` and no longer reuse `DATABASE_URL` for it.
  The test harness (`packages/db/src/harness.ts:241-300`) does not use the CLI and is
  unchanged except for the new role (D14).
- _Alternatives_: a fallback to `DATABASE_URL` under test (rejected, Q5: no silent path back
  to the runtime URL); requiring `current_user = 'tayzu_migrator'` (rejected: CI and the
  first run would have to pre-create a role that `0006` creates).

### D2. Proxy trust is explicit (D3, Q6)

- `config.ts` reads `TRUST_PROXY_HOPS`, an integer from 1 to 5, and `TRUST_PROXY_CIDRS`, a
  comma-separated list of IPv4 or IPv6 CIDR blocks (each validated with `node:net`
  `BlockList.addSubnet` inside a `try`; a bare address is accepted as a `/32` or `/128`).
  Outside `NODE_ENV=test` both are required; a missing or malformed value throws an error that
  names only the variable. Under test, both unset keeps today's list
  (`['loopback', 'linklocal', 'uniquelocal']`) so the existing suites, which inject from the
  loopback peer with a random `X-Forwarded-For`, keep working; both set is honoured; one set
  without the other fails, in every environment.
- `createTrustProxy({ hops, cidrs })` (`apps/api/src/trust-proxy.ts`) returns the
  `(address, hopIndex) => boolean` function Fastify accepts: `hopIndex < hops` and the
  address (an IPv4-mapped IPv6 address reduced to its IPv4 form first) is inside the
  `BlockList`. Fastify (through `proxy-addr`) evaluates hop 0 as the socket peer and walks
  `X-Forwarded-For` from the right, stopping at the first untrusted address, so a peer
  outside the CIDRs never has its header read, and at most `hops` entries are ever skipped.
- `CreateAppOptions` gains `trustProxy` (the function or the test list), set by
  `createAppFromEnv` from the configuration; `server.ts:665-670` uses it. `toWebRequest`
  keeps overwriting `x-forwarded-for` with `request.ip` before Better Auth, so Better Auth
  sees the same address.
- `scripts/ci/e2e.sh` and `scripts/ci/dast.sh` run with `NODE_ENV=production`, so they set
  `TRUST_PROXY_HOPS=1` and `TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128`. The deployed values
  (one hop from the Container Apps environment subnet with the ingress alone, two hops with
  Front Door in front, whose peers are public ranges) are `046`'s.
- _Alternatives_ (Q6): a hop count alone (trusts any peer for N hops); a CIDR list alone
  (does not bound multi-hop headers).

### D3. One public origin, checked at startup (D7, Q18)

`loadConfig` compares `new URL(BETTER_AUTH_URL).origin` with the parsed `ALLOWED_ORIGINS`
whenever `BETTER_AUTH_URL` is set (it is required outside test since `002` Q40) and throws
`'BETTER_AUTH_URL is malformed (its origin must be one of ALLOWED_ORIGINS).'`. The two link
base URLs already pass the same check (`config.ts:266-295`). Test fixtures that set a
`BETTER_AUTH_URL` outside their `ALLOWED_ORIGINS` are corrected by the test-writer, never by
loosening the rule.

### D4. Versioned authentication secrets (C2, Q9)

- **Format.** `BETTER_AUTH_SECRETS` is `<version>:<value>[,<version>:<value>...]`. A
  version is a decimal integer from 0 to 2^31-1 with no sign and no leading zero (except
  `0`); the value is everything after the first colon, trimmed, at least 32 characters,
  without a comma. Versions are unique; the first entry is the current one; at least one
  entry is required. One parser, `parseAuthSecrets(value, variable)` in
  `apps/api/src/auth-secrets.ts`, is used by `config.ts` and by `script-config.ts`; an error
  names only the variable. `Config.betterAuthSecret` becomes
  `betterAuthSecrets: readonly { version: number; value: string }[]`.
- **Retirement.** `BETTER_AUTH_SECRET` set (non-blank) fails startup in every environment
  with `'BETTER_AUTH_SECRET is retired: set BETTER_AUTH_SECRETS instead.'`; no deployed data
  exists, so nothing migrates.
- **Explicit options.** `createAuth` takes `secrets` and passes both
  `secrets: [...secrets]` and `secret: secrets[0].value` to `betterAuth`. Passing `secret`
  too is what keeps the context's legacy key (`options.secret || env.BETTER_AUTH_SECRET`)
  from being an ambient variable; with both passed, neither `BETTER_AUTH_SECRETS` nor
  `BETTER_AUTH_SECRET` in `process.env` can add, replace or remove a key. A unit test sets
  both in `process.env` and asserts that `(await auth.$context).secretConfig` holds exactly
  the configured map and current version.
- **What a rotation does.** Prepending version `n+1` keeps everything Better Auth encrypts
  with `symmetricEncrypt` readable (TOTP secrets, backup codes, OAuth tokens, the `jwt`
  private key), because the envelope names its key version. Cookie signing uses the current
  entry, so a rotation still signs every session out; Tayzu's own consumers
  (`packages/auth/src/rate-limit/pre-auth-rate-limit.ts:309`, which recomputes the cookie
  signature with `ctx.secret`, and `packages/auth/src/identity/reset-factor.ts`, which already
  uses `secretConfig`) follow the same rule. An integration test enrols TOTP under version 1
  and verifies a code after restarting with `2:...,1:...`.
- **Scripts.** `bootstrap-admin` declares `BETTER_AUTH_SECRETS`; every other script still
  declares no secret, and `recover-admin-mfa`'s list excludes both names (spec, MODIFIED
  "Operator recovery").
- **JWKS.** Manual rotation with a runbook in `docs/security/secrets.md`: access tokens live
  one hour (`packages/auth/src/token-exchange.ts`), and an automatic `rotationInterval` adds
  a key lifecycle nothing tests yet (Q9). The runbook says plainly that a secret rotation
  signs every session out.

### D5. The platform's password hash (F8, Q8) — ADR-0028 (written by task 5.5)

- **Function.** `packages/auth/src/password-hash.ts` exports `hashPassword(password)`,
  `verifyPassword({ hash, password })` and `needsRehash(hash)`. `hashPasswordNfc` stays the
  exported name used by the reset path (`apps/api/src/identity/password-reset-confirm.ts:295`)
  and becomes an alias of the new `hashPassword`; `emailAndPassword.password` in `auth.ts` uses
  the new pair.
- **Parameters.** scrypt (`node:crypto` `scrypt`, promisified), `N = 2^15`, `r = 8`, `p = 3`,
  a 16-byte salt from `randomBytes`, a 64-byte key, `maxmem` set explicitly to 64 MiB
  (`128 * N * r` is 32 MiB, which Node's default `maxmem` refuses), one of OWASP's
  equivalent scrypt settings with the same per-hash memory as today and about three times its
  CPU. The measured hash time on the CI runner is recorded in the ADR and
  `docs/security/crypto-inventory.md`.
- **Format.** A PHC-style string,
  `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, where `<salt>` and `<key>` are standard
  base64 without padding (`A-Za-z0-9+/`), for example
  `$scrypt$ln=15,r=8,p=3$<22 characters>$<86 characters>`. Parsing is strict: exactly five
  `$`-separated fields with an empty first one, the literal `scrypt`, the three parameters in
  that order as decimal integers with `ln` from 14 to 20, `r` from 1 to 16 and `p` from 1 to
  16, a salt of 16 to 64 bytes and a key of exactly 64 bytes. A string that fails the parse is
  not a platform hash.
- **Verification.** A platform hash is recomputed with its own parameters and compared with
  `timingSafeEqual` on equal-length buffers. A string matching `^[0-9a-f]{32}:[0-9a-f]{128}$`
  is a legacy Better Auth hash and is verified through `better-auth/crypto`'s
  `verifyPassword` with the NFC-normalized password (its own NFKC step stays inside, as
  today). Anything else fails, without throwing. **Normalization**: the new format applies
  NFC only (the `identity-lifecycle-and-org-admin` "Password policy" rule "inside the password
  hash and verify functions themselves" still holds).
- **Rehash on sign-in.** In `hooks.after` of `/sign-in/email`, on the success path only, after
  the `044` D7 reset-race comparison (`auth.ts:1470-1485`) has passed, when
  `needsRehash(hashBefore)` is true (a legacy hash, or platform parameters below the current
  ones), the hook writes `hashPassword(body.password)` with a compare-and-set:
  `update auth.account set password = $new where user_id = $1 and provider_id = 'credential'
  and password = $old`, through the `tayzu_auth` adapter's pool. A concurrent reset therefore
  always wins. The rehash also runs when a second factor is still pending (the password itself
  verified; see Resolved decision Q27). A failed sign-in never reaches this branch, so its answer,
  its timing and its telemetry are unchanged; a rehash error is swallowed after a sanitized
  `auth.internal_error`, and the sign-in still succeeds. The plaintext comes from `ctx.body`,
  already NFC-normalized by the `hooks.before` normalization of `043` Q22.
- _Alternatives_ (Q8): `N=2^17, r=8, p=1` (128 MiB per hash on a public route); Argon2id (a
  native dependency); refusing legacy hashes (the next upgrade would need this work anyway).

### D6. The SSO step-up callback is bound to the browser (F4, Q7)

- **Start.** `start` draws a 256-bit `nonce` (`randomBytes(32).toString('base64url')`) next to
  the `state` and the PKCE verifier, and stores
  `{"token":...,"verifier":...,"nonce":...}` in the `sso-reauth-state:<state>` row. The token
  stays the first key, because the pending-per-session bound matches the row's prefix
  (`reauthorization.ts:181-186`). The authorization URL gains `nonce` and
  `response_mode=query`.
- **Callback.** Only `GET REAUTH_CALLBACK_PATH` is registered; `scope.post` and its form
  parser are removed, so a `POST` reaches the `/v1/*` catch-all like any unknown route, and
  the path leaves the `/v1` media-type exemption. `PUBLIC_ROUTE_ALLOWLIST`'s entry becomes
  `GET` with the reason "authenticated by the single-use state, the nonce and the session
  cookie". The limiter (`043` task 13.9) still runs first.
- **Order inside `complete(params, headers)`:** (1) shape check of `code` and `state`
  (`invalid_state`); (2) the single-use consume of the state row (`invalid_state` when absent
  or expired); (3) the session token of the request's cookie, read with the existing
  `ssoSession(headers)` helper, compared with the bound token by `timingSafeEqual` over their
  SHA-256 digests (so unequal lengths leak nothing); no cookie or a different session is
  `session_mismatch` (WARN, the same 303 to `STEP_UP_FAILED_LOCATION`, or `400` without the
  web app); (4) the bound session still exists (`invalid_state`); (5) the code exchange
  (`exchange_failed`); (6) `verifyReauthorizationIdToken(idToken, { discoveryUrl, clientId,
  nonce })`, a new export of `packages/auth/src/sso/reauthorization.ts` that shares the
  verifier of `isValidReauthorization` and checks the signature, `iss`, `aud` and that
  `nonce` equals the bound value (constant time); a failure is `exchange_failed` (Q22) and
  stores nothing; (7) the result is stored. The D25 claim checks (`auth_time`, `acr`, `amr`,
  `sid`) stay in the step-up guard (`packages/auth/src/step-up.ts`, unchanged), so an
  insufficient token is still reported as `auth.security.step_up_insufficient`.
- Consuming the state before the cookie check is deliberate: a callback replayed into the
  victim's browser burns the attacker's state, and a state is never usable twice.
- **Cookie.** Better Auth's session cookie is `SameSite=Lax`, which a top-level `GET`
  redirect from Visma Connect carries and a cross-site `form_post` would not; that is why
  `response_mode=query` and the cookie requirement come together (`002` Q71).
- **Stub.** The OIDC stub fixture (`packages/auth/src/__fixtures__/oidc-stub.ts`) honours
  `response_mode=query` and echoes the `nonce` of the authorization request into the ID token,
  with a switch to echo a different one; it is test-writer work.
- **Telemetry.** `tayzu.auth.reauthorization.reason` gains `session_mismatch` in both auth
  contracts (`ATTRIBUTE_VALUES`).

### D7. Shared rate limits on the public edge (D10, Q11)

- **Token exchange.** The in-memory `app.createRateLimit` of `server.ts:1046-1063` is replaced
  by a pre-handler over `createRateLimitBucketStore` (the `auth.rate_limit` table, hashed
  keys, no migration). It consumes two buckets in order: `token_exchange`, kind `ip`, value
  `clientIpKey(request.ip)` (the existing scope, now shared, still keyed by the address alone
  so that a varying client id never opens a fresh address bucket, `002` Q56); then, when the
  body's client id passes the credential-id shape check (a string of at most 128 characters),
  `token_exchange_client`, kind `client`, the client id. Either refusal answers the existing
  `AUTH_RATE_LIMITED` 429 with `Retry-After`; a store error answers the sanitized `INTERNAL`
  500, like the accept limiter (`044` D16). `BucketKeyKind` gains `client`. Defaults: the
  existing `TOKEN_EXCHANGE_RATE_LIMIT_*` for the address bucket (30 per 60 s) and new
  `TOKEN_EXCHANGE_CLIENT_RATE_LIMIT_*` for the client bucket (60 per 60 s), read like every
  other limit (Q21).
- **Back-channel logout.** The route's `config.rateLimit` becomes the same pre-handler with
  scope `backchannel_logout`, kind `ip`, and the existing
  `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE` (600 per 60 s). It still runs before any token
  verification.
- **Stays per replica**: the `/v1` per-principal limiter and `GET /v1/me` (600 per 60 s per
  principal) and the SPA fallback (300 per minute per address, `003` D9, ADR-0025:65). Both are
  documented in `docs/security/attack-surfaces.md` as per-replica budgets, and `046` records
  the replica ceiling that multiplies them.
- The `RateLimitScope` union gains `token_exchange_client` and `backchannel_logout`; both
  reach `tayzu.auth.rate_limit.scope`. The `auth.rate_limit` prune janitor stays `044`'s
  ticket; the two new scopes add rows on public routes, which makes it more urgent (Tickets).
- _Alternatives_ (Q11): moving all four limiters (a database write on every `/v1` request);
  moving none and pinning one replica.

### D8. An atomic back-channel replay guard (F6, Q14) — migration `0016` (⛔ Checkpoint 3)

- **Migration `0016_backchannel_logout_replay_uq`.** A partial unique index declared on the
  `verification` table of `packages/auth/src/persistence/schema.ts`, so `drizzle-kit generate`
  writes it with its snapshot:
  `CREATE UNIQUE INDEX "verification_backchannel_logout_uq" ON "auth"."verification" USING btree ("identifier") WHERE starts_with("identifier", 'backchannel-logout:');`.
  No dedupe statement precedes it: if duplicate back-channel rows exist, the index build
  fails with a unique violation and the migration's transaction aborts, loudly, deleting
  nothing. A global unique index is not safe: other identifier families of
  `auth.verification` may repeat (`verification-families.int.test.ts`). The down script
  drops the index. The index needs no grant.
- **One transaction.** `handleLogoutToken` takes a client from `authPool`, runs `begin`, the
  insert
  `insert into auth.verification (id, identifier, value, expires_at) values ($1, $2, 'processed', to_timestamp($3)) on conflict (identifier) where starts_with(identifier, 'backchannel-logout:') do nothing`,
  returns `replay` (after `rollback`) when it inserted no row, then the existing `sid` or
  `sub` delete, then `commit`. A concurrent second delivery blocks on the index until the first
  commits, then conflicts and is a replay; a delete that fails rolls the record back, so a
  retry is processed. Outcomes (`revoked`, `no_match`, `replay`, `invalid`) are unchanged.
- **Cache.** `createLogoutKeyCache({ ttlSeconds: 600 })` in
  `packages/auth/src/sso/backchannel-logout.ts` keeps the discovery document and the key set
  for at most ten minutes. An unknown `kid` triggers at most one refresh per 60 seconds; a
  refresh failure with no unexpired copy rejects the token (`invalid`), never accepts it, and
  an expired copy is never used. The cheap claim checks still run before any fetch (`043`
  task 13.11). The re-authorization verifier keeps its per-call fetch (a ticket).
- **Lifetime bound.** `exp - iat` greater than 300 seconds is rejected as `invalid`, before
  any fetch and before the `jti` is recorded (Q25). The verifier stays hand-rolled (`002`
  D26).

### D9. CSP violation reports (D8, Q10)

- **Policy.** `CSP_DIRECTIVES` gains `'report-uri': ['/v1/csp-reports']` and
  `'report-to': ['csp-endpoint']`, and the `Permissions-Policy` hook also sets
  `Reporting-Endpoints: csp-endpoint="/v1/csp-reports"` on every response; the path is
  resolved against the response's own origin, so reports never leave it. `report-uri` is for
  Firefox and Safari, `report-to` for Chromium. `headers.int.test.ts` and
  `csp-nonce.http.int.test.ts` assert the new exact policy.
- **Route.** `POST /v1/csp-reports`, a plain Fastify route in its own encapsulated scope
  (like the Visma callbacks), on `PUBLIC_ROUTE_ALLOWLIST` with the reason "browser CSP
  violation reports: no session, counted by directive only (048 D9)". The `/v1` media-type
  hook exempts this path only for `application/csp-report` and `application/reports+json`;
  any other body type still gets the `415`. The scope registers a string parser for those two
  types with `bodyLimit: 8192`; its error handler maps the body-limit and parse errors to
  `204`. The handler never reads a cookie or a header other than the media type.
- **Parse.** The body is parsed into null-prototype objects by the shared strict parser of
  the identity procedures (refusing `__proto__`, `constructor` and `prototype` at every depth).
  For `application/csp-report`, the only field read is
  `csp-report["effective-directive"]`, falling back to `csp-report["violated-directive"]`'s
  first token; for `application/reports+json`, an array of at most 20 entries, each entry
  whose `type` is `csp-violation` contributes `body.effectiveDirective`. No other field is
  ever read: not `document-uri`, `blocked-uri`, `source-file`, `script-sample`, `referrer`,
  `status-code`, `disposition`, `url` or `user_agent`.
- **Mapping.** `script-src-elem` and `script-src-attr` count as `script-src`, `style-src-elem`
  and `style-src-attr` as `style-src`; any other value that is one of the 14 names of
  `CSP_DIRECTIVES` counts as itself; anything else as `other`. The closed value list is
  declared in the contract.
- **Budget.** An in-process per-address bucket of 60 reports per 60 seconds
  (`clientIpKey(request.ip)`, so it relies on D2), checked before parsing. A request over the
  budget is answered `204` and not counted, and emits no rate-limit event, because the
  endpoint is unauthenticated and spoofable and must not amplify a flood into the log (Q26).
- **Signal.** `tayzu.web.csp_violations` (Counter, `{report}`), one attribute,
  `tayzu.web.csp.directive`, declared in the identity contract module, which holds `003`'s
  server signals, and recorded through `recordIdentityMetric`. No log record per report. The
  HTTP server span of the route has the fixed path `/v1/csp-reports`. Anyone can send a report,
  so `046` alerts on trends only.
- **DAST.** The scripted probe of `scripts/ci/dast.sh` (`044` "The public routes without an
  OpenAPI document are scanned") adds the route: malformed, oversized and prototype-polluting
  reports must answer `204` and never `5xx` (Q29).

### D10. The Cerbos decision log reaches stdout in production (G3, Q15)

- `config/cerbos.production.yaml` equals `config/cerbos.yaml` except for the audit backend:
  `audit.backend: file` with `audit.file.path: stdout`, and no `audit.local` block.
  `decisionLogsEnabled: true`, `accessLogsEnabled: false`, strict evaluation and disk storage
  without watch stay. Local, CI, compose, the sandbox hook and the scratch copy keep `local`,
  so test logs stay readable. `046` mounts the production file.
- `packages/authz/src/config.test.ts` parses both files with its reader and asserts deep
  equality after removing `audit.backend`, `audit.local` and `audit.file`, then the production
  backend values. An integration test starts the pinned image (the digest of
  `authz-pipeline.int.test.ts`) with the production file and the real `policies/` tree, makes
  one check and asserts that a decision record appears on the container's standard output.
- **Closed attribute set.** `@tayzu/authz` exports `CERBOS_PRINCIPAL_ATTRIBUTE_KEYS`
  (`tenantId`, `teams`, `moderatedBlueprints`) and `CERBOS_RESOURCE_ATTRIBUTE_KEYS` (the keys
  the catalog pipeline's declarations and the identity wrapper send today, such as
  `tenantId`, `blueprintId`, `accountKind` and the ownership attributes, enumerated by task
  1.1's drift check). An `apps/api` integration test wraps the Cerbos client with a recorder,
  drives the catalog operations and the identity operations, and asserts every key is in the
  set and every value matches an identifier, role or flag shape, with a marker title,
  description and property value absent. A new key is then a reviewed constant change.
- Not a Checkpoint 3 item: it is engine configuration, not a policy (Q15).

### D11. An authorization-engine error is an internal error, not a denial (G12, Q16)

- `isAllowed` in `define-operation.ts` returns a tri-state, `allow`, `deny` or `error`. On
  `error` the wrapper emits `identity.internal_error` (ERROR, `tayzu.catalog.operation` = the
  procedure name, `error.type` = `authz_unavailable`), calls `recordAuthzError(kind, action)`
  and throws the same `IdentityForbiddenError` as today (fail closed, unchanged answer, Q28);
  it does **not** call `recordAuthzDecision`, so no `deny` and no
  `catalog.security.authz_denied` is recorded.
- `recordAuthzError` is exported by `@tayzu/catalog` next to `recordAuthzDecision` (one meter,
  `@tayzu/catalog`), over a new counter `tayzu.authz.errors` declared in
  `packages/authz/src/telemetry/contract.ts` beside `tayzu.authz.decisions`.
- The accept flow's `inviterMayStillInvite` wraps only the `checkResources` call: its error
  emits the same event (operation `identity.invitations.accept`) and counter (`user`,
  `invite`) and the acceptance gets the uniform rejection as today; a repository error in the
  same function keeps today's behaviour.
- `IdentityLogEventDeclaration.severity` gains `'ERROR'`.

### D12. A rejected tenant switch is logged (G13, Q17)

The `hooks.before` snapshot of `/organization/set-active` (`auth.ts:1320-1330`) also keeps
the session's user id. When `hooks.after` restores it, it emits
`auth.security.active_organization_rejected` (WARN, `tayzu.actor.id`,
`tayzu.auth.set_active.outcome` = `not_member` when Better Auth's error is its membership
refusal, else `other`) and adds `set_active_rejected` to `tayzu.auth.session.events`. The
`organizationId` of the body is never read for telemetry. Both auth contracts declare the
event and the value.

### D13. ACS through a managed identity (C1, Q13) — the design amendment `043` Q28 asked for

- **Dependency.** `@azure/identity` `4.14.1` (MIT, published 2026-10-29, older than the
  14-day rule), a dependency of `apps/api` only, pinned exactly. Its direct dependencies are
  `@azure/abort-controller`, `@azure/core-auth`, `@azure/core-client`, `@azure/core-process`,
  `@azure/core-rest-pipeline`, `@azure/core-tracing`, `@azure/core-util`, `@azure/logger`,
  `@azure/msal-browser`, `@azure/msal-node`, `open` and `tslib`. The setup task records each
  new package of the lockfile diff (license, install scripts) in
  `docs/security/dependencies.md`, and an install script is allowed only through an explicit
  `allowBuilds` entry with its reason; none is expected.
- **Adapter.** `AzureEmailConfig` becomes `{ endpoint, senderAddress }`; the adapter takes an
  injected credential typed from `EmailClient`'s own constructor
  (`ConstructorParameters<typeof EmailClient>[1]`), so `@tayzu/auth` gains no dependency and
  its tests stay offline with a stub credential.
- **Credentials.** The API and the jobs build
  `new ManagedIdentityCredential({ clientId })` when `AZURE_CLIENT_ID` is set (a user-assigned
  identity), else `new ManagedIdentityCredential()`; the operator CLI `recover-admin-mfa`
  builds `new AzureCliCredential()`, so it uses the operator's `az login` session under
  just-in-time access through PIM. The credential is built in `apps/api/src/email-sender.ts`
  and in the scripts, never in `@tayzu/auth`.
- **Configuration.** `ACS_ENDPOINT` (non-secret, an absolute `https` URL) replaces
  `ACS_CONNECTION_STRING` wherever `EMAIL_PROVIDER=acs`; `AZURE_CLIENT_ID` is optional.
  `ACS_CONNECTION_STRING` set fails startup of the API and of every script in every
  environment, naming only the variable. The real-token check is `046`'s sandbox step; the
  Azure role on the ACS resource is `046`'s IaC.
- _Alternatives_ (Q13): a hand-written token credential over the Container Apps identity
  endpoint (custom token code, and the CLI keeps a connection string); keeping the connection
  string as an accepted risk (reverses `043` Q28).

### D14. The pre-purge warning (G10, Q12) — migration `0017` (⛔ Checkpoint 3)

- **Migration `0017_tenant_deletion_warning`.** `warned_at timestamptz NULL` on
  `tenant_deletion_marker`, declared on the Drizzle table in
  `packages/catalog/src/persistence/schema.ts` and generated, with the role, grants and policy
  appended by hand to the same file before Checkpoint 3 (the precedent of `0015`):
  - `tayzu_purge_warning`, created guarded with `createrole_self_grant` cleared, exactly as
    `0013` creates `tayzu_purge`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
    NOBYPASSRLS`, no password;
  - `GRANT USAGE ON SCHEMA public`; `GRANT SELECT (tenant_id, purge_after, state, warned_at)`
    and `GRANT UPDATE (warned_at)` on the marker; nothing else;
  - `purge_warning_select` (`FOR SELECT TO tayzu_purge_warning`):
    `state = 'pending' AND purge_after > now() + interval '24 hours' AND purge_after <= now() + interval '48 hours'`;
  - `purge_warning_update` (`FOR UPDATE TO tayzu_purge_warning`): `USING` the same predicate
    and `warned_at IS NULL`, `WITH CHECK` the same predicate and `warned_at = now()`, so the
    database stamps the warned time with its own clock;
  - `tayzu_app`'s column-level `INSERT` grant (`0013`) does not name `warned_at`, so the request
    role cannot set it; `tayzu_purge` and `tayzu_deletion_admin` gain nothing.
  The down script drops the policies, revokes the grants, drops the column and leaves the role
  (as `0013`'s down leaves cluster-wide roles), with its journal entry and snapshot.
- **Job.** `apps/api/scripts/purge-warning-job.ts`, package script `identity:purge-warning`, a
  daily Container Apps Job provisioned by `046`. It declares `PURGE_WARNING_DATABASE_URL`
  (`tayzu_purge_warning`), `AUTH_DATABASE_URL` (`tayzu_auth`, to read the administrators'
  addresses through `authRepository.administratorsOf` and to hold the notice buckets of
  `auth.rate_limit`, as the request path does; Q23), `IDENTITY_TOKEN_HMAC_SECRET` (the
  per-recipient notice key), the email variables of D13, `EMAIL_DISABLED_TENANT_IDS`,
  `INVITATION_EMAIL_KILL_SWITCH` and the telemetry variables. It refuses to start, before any
  pool or email, with `TAYZU_TELEMETRY_DISABLED=true` or no OTLP endpoint (`045` Q178), and
  refuses a database role other than its own.
- **Run.** One statement claims the markers:
  `update tenant_deletion_marker set warned_at = now() where state = 'pending' and purge_after > now() + interval '24 hours' and purge_after <= now() + interval '48 hours' and warned_at is null returning tenant_id, purge_after`.
  Two overlapping runs therefore never claim one marker twice, and a claimed marker is never
  warned again (at most once, Q24). For each claimed marker, in its own `try`:
  `catalog.audit.org_deletion_marker_seen` (INFO, tenant id), then the fixed
  `OrgPurgeWarningNotice { purgeDate }` through the notice dispatcher of
  `apps/api/src/identity/notices.ts` (kill switch, disabled tenants, per-tenant notice cap,
  the notices' own per-recipient bucket, 20 longest-standing administrators, the suppression
  and truncation events), then `tayzu.identity.org_deletion_warnings` with `dispatched`, or,
  on any failure, `catalog.security.org_deletion_warning_failed` (WARN, tenant id) and the
  counter with `failed`. One span, `identity.organization.purge_warning`, per tenant. A
  failure never stops the other tenants; the job flushes telemetry before it exits.
- **Template.** `OrgPurgeWarningNotice` is the ninth fixed template: a fixed subject and body
  that state the organization will be permanently deleted on the purge date and that an
  administrator should contact the platform operator to stop it, with only the date
  interpolated, no link and no free text; the ACS adapter's switch and the non-sending sender
  gain it, and `tayzu.identity.email.template` and `tayzu.identity.notice.template` gain
  `org_deletion_warning`.
- **Orphan markers.** The per-marker event is what `046`'s alert joins against
  `catalog.audit.org_deletion_requested` for the same tenant over the last 15 days, 24 to 48
  hours before the purge, because a compromised request path could insert a marker silently
  (`045` SEC14).
- **Cadence.** A daily run with a 24-hour window sees each marker in one run; a run that is
  missed or late by more than its jitter can skip a marker (Risks). The window and the cadence
  are documented in `docs/security/data-retention.md`.

### D15. Testing strategy

- Every task is one red-green-refactor cycle: the `test-writer` writes the named test and its
  fixtures (the OIDC stub's `response_mode` and `nonce`, the recording Cerbos client, a stub
  token credential, harness roles), the `implementer` makes it pass. Unit tests are
  `*.test.ts` next to the code; integration tests `*.int.test.ts` on PostgreSQL 18 and the
  Cerbos container; HTTP tests `*.http.int.test.ts` through `inject` (with `remoteAddress`
  for the proxy-trust matrix).
- Concurrency (D8, D14) is tested with two connections that start their statements together,
  not with timing assumptions; the replica-sharing tests (D7) build two `createApp` instances
  over one database.
- The migrations get their own integration tests in `packages/db` (index predicate,
  duplicates refused, role privileges, `SET ROLE` refused, down scripts).
- `otel-smoke-check` (`apps/api/src/otel-smoke-check.int.test.ts`) drives each new signal once
  and the marker-leak checks cover the CSP report fields, the engine error message and the
  supplied organization id.

### D16. Docs-as-Code and ADRs

- New ADR **0028**, the Tayzu-owned scrypt password hash (D5); ADR-0026 point 9 rewritten for
  the report endpoint (D9).
- `docs/security/attack-surfaces.md`: the Pending rows this change closes (B1, D3, F4, G3,
  the replica half of the back-channel row, D10), the new route, the narrowed callback and the
  per-replica budgets; `secrets.md`: `MIGRATION_DATABASE_URL`, `BETTER_AUTH_SECRETS` with the
  rotation and JWKS runbook, `TRUST_PROXY_*`, `ACS_ENDPOINT`, `AZURE_CLIENT_ID`,
  `PURGE_WARNING_DATABASE_URL`, and the removal of `BETTER_AUTH_SECRET` and
  `ACS_CONNECTION_STRING`; `crypto-inventory.md`: the password hash and the ACS
  authentication; `data-retention.md`: the warning window, its cadence and the operator
  environment's credential; `dependencies.md`: `@azure/identity` and its packages;
  `docs/architecture/system-diagram.md`: the warning job and its two database connections and
  the ACS token flow; `docs/catalog/auth-and-rbac.md`: the new telemetry; `packages/auth/CLAUDE.md`
  and `apps/api/CLAUDE.md`: the secrets variable, the hash and the callback.

## Observability contract

Names follow `001`'s rules. Tracer and meter `@tayzu/auth` for the auth and identity names,
`@tayzu/catalog` for `tayzu.authz.errors` (the meter of `tayzu.authz.decisions`); versions
equal to the package versions; shared keys from `@tayzu/observability/semconv`. Where each
name is declared:

- `packages/auth/src/telemetry/contract.ts` **and** its mirror
  `packages/authz/src/telemetry/contract.ts`: `auth.security.active_organization_rejected`,
  the `session_mismatch` reason and the `set_active_rejected` value;
- `packages/authz/src/telemetry/contract.ts`: `tayzu.authz.errors`;
- `packages/auth/src/telemetry/identity-contract.ts` (and its fixture
  `packages/auth/src/__fixtures__/identity-contract-expected.ts`): `identity.internal_error`,
  `tayzu.web.csp_violations`, the warning job's span, counter and events, and the new template
  values.

**Forbidden on every signal**: any field of a CSP report other than its mapped directive, an
engine error message, a connection string or endpoint, a client id, a nonce, a state, a
password or hash, the organization id a caller supplied to `set-active`, and every name,
email and URL.

### Spans

| Span name                              | When | Required attributes | Conditional attributes |
| -------------------------------------- | ---- | ------------------- | ---------------------- |
| `identity.organization.purge_warning`  | job, one per claimed marker | `tayzu.tenant.id` | — |

`INTERNAL`, `001`'s error and sanitization rules verbatim. The HTTP server span of
`POST /v1/csp-reports` comes from the existing instrumentation with its fixed path; no other
span is added.

### Metrics

| Instrument | Type, unit | Attributes | Purpose |
| ---------- | ---------- | ---------- | ------- |
| `tayzu.web.csp_violations` | Counter, `{report}` | `tayzu.web.csp.directive` (`default-src`\|`script-src`\|`style-src`\|`img-src`\|`font-src`\|`connect-src`\|`media-src`\|`object-src`\|`frame-src`\|`worker-src`\|`manifest-src`\|`base-uri`\|`form-action`\|`frame-ancestors`\|`other`) | Browser-reported CSP violations; spoofable, trend alerts only (D9) |
| `tayzu.authz.errors` | Counter, `{error}` | `tayzu.authz.resource.kind`, `tayzu.authz.action` | An authorization-engine error in the identity pipeline, apart from denials (D11) |
| `tayzu.identity.org_deletion_warnings` | Counter, `{marker}` | `tayzu.identity.org_deletion_warning.outcome` (`dispatched`\|`failed`) | Pre-purge warnings handed to the notice dispatcher or failed (D14) |

Values added to existing instruments:

- `tayzu.auth.session.events`: `tayzu.auth.event` gains `set_active_rejected` (D12).
- `tayzu.auth.rate_limit.events` (and `auth.security.rate_limited`):
  `tayzu.auth.rate_limit.scope` gains `token_exchange_client` and `backchannel_logout`;
  `token_exchange` now comes from the shared store (D7).

**Cardinality budget**: every new attribute is a closed enum; `tayzu.tenant.id` stays under
`001` ADR-0006's bound.

### Log events

| Event name | Severity | Attributes | Purpose |
| ---------- | -------- | ---------- | ------- |
| `auth.security.active_organization_rejected` | WARN | `tayzu.actor.id`, `tayzu.auth.set_active.outcome` (`not_member`\|`other`) | A rejected tenant switch, for the repeated-attempt alert of `046` (D12) |
| `identity.internal_error` | ERROR | `tayzu.catalog.operation`, `error.type` (`authz_unavailable`) | An authorization-engine error in an identity operation, which still fails closed (D11) |
| `catalog.audit.org_deletion_marker_seen` | INFO | `tayzu.tenant.id` | The warning job claimed a pending marker; `046` joins it against `catalog.audit.org_deletion_requested` (D14) |
| `catalog.security.org_deletion_warning_failed` | WARN | `tayzu.tenant.id` | The pre-purge warning could not be handed to the provider (D14) |

Values added to existing events and attributes:

- `auth.security.reauthorization_failed`: `tayzu.auth.reauthorization.reason` gains
  `session_mismatch` (D6).
- `tayzu.identity.email.template` gains `org_deletion_warning` (the ninth template) and
  `tayzu.identity.notice.template` gains `org_deletion_warning`, so
  `catalog.security.notice_suppressed` and `catalog.security.email_tenant_blocked` name it.

**Sampling exemption**: every `auth.security.*`, `catalog.audit.*` and `catalog.security.*`
event above is exempt from sampling and from drop rules (`001`, `002`), and so is
`identity.internal_error`, because `046` alerts on it. `046` inherits the constraint for its
collector or exporter (G2). These names are declared by the first task of the group that
emits them, before the code, and `otel-smoke-check` enforces them.

## Security considerations (SSA SEC01-SEC16 posture)

| Gap | Where it is closed |
| --- | --- |
| B1 migrations run as the runtime URL (`002` Q58) | D1, auth-and-rbac "Schema migrations run only as the migration role", group 2 |
| D3 trust of every private range (`002` Q58, Q84) | D2, auth-and-rbac "The client address comes only from trusted proxy hops", group 3 |
| D7 one public origin (`003` gates) | D3, group 3 |
| C2 one key for cookies, second factors, tokens and JWKS (`002:1329`) | D4, auth-and-rbac "Authentication secrets are versioned", group 4 |
| F8 scrypt below OWASP guidance (`002` Q78, `043` O-4) | D5, password-reset "Passwords are stored with the platform's password hash", group 5 |
| F4 step-up callback not bound to the browser (`002` Q71) | D6, auth-and-rbac "Step-up authentication", group 6 |
| D10 per-replica budgets on public routes (`002` Q73, `043` M13) | D7, auth-and-rbac "Pre-authentication rate limiting", group 7 |
| F6 non-atomic replay guard, uncached keys, unbounded lifetime (`002` Q84, `002:1324`) | D8, auth-and-rbac "Back-channel logout", migration `0016`, group 7 |
| D8 no CSP violation reporting (`003` Q30) | D9, catalog-ui-core, group 8 |
| G3 Cerbos decision log not exported (`002:270-276`) | D10, auth-and-rbac "Authorization decisions are auditable", group 9 |
| G12 an engine outage counted as a deny (`043` O-1) | D11, identity-lifecycle, group 10 |
| G13 silent tenant-switch rejection (`043` TK9-1) | D12, auth-and-rbac "Tenant-switch membership", group 10 |
| C1 ACS connection string (`043` Q28) | D13, identity-lifecycle and password-reset, group 11 |
| G10 no pre-purge warning or orphan-marker signal (`045` Q68) | D14, org-deletion, migration `0017`, group 12 |

| Section | Applies | Posture |
| ------- | ------- | ------- |
| SEC01 Diagram | Yes | The warning job with its two database connections (`tayzu_purge_warning`, `tayzu_auth`) and its ACS connection, and the managed-identity token flow to ACS for the API, the jobs and the operator CLI, are added to `docs/architecture/system-diagram.md` (task 12.9). No new actor. |
| SEC02 Attack surfaces | Yes | One new public route, `POST /v1/csp-reports` (no session, 8 KiB, per-address budget, always `204`); the re-authorization callback narrowed to `GET`; the back-channel and token-exchange limits shared. Rows in `docs/security/attack-surfaces.md`. |
| SEC03 Access control | Yes | No policy change. The tenant switch rejection is now visible; an engine outage still fails closed. The warning role reads three columns of pending markers inside a 24-hour window and writes one. |
| SEC04 Password storage | Yes | Tayzu-owned scrypt at `N=2^15, r=8, p=3`, 64-byte key, constant-time comparison, self-describing format, rehash on sign-in, ADR-0028 (D5). |
| SEC05 Cryptography | Yes | Versioned authentication secrets (D4); a 256-bit `nonce` with constant-time comparison (D6); verified TLS for the migration and warning connections (D1, D14); no new primitive beyond the password hash. |
| SEC06 Misuse | Yes | Spoofed forwarded addresses no longer mint buckets (D2); shared budgets on token exchange and back-channel logout (D7); a CSP report flood is dropped silently (D9); a double back-channel delivery revokes once (D8). |
| SEC07 Dependencies | Yes | One runtime dependency, `@azure/identity` `4.14.1`, with its transitive packages reviewed, install scripts checked against `allowBuilds`, audited at high and above (task 1.2). |
| SEC08 File upload | N/A | No upload. |
| SEC09/SEC10 Secrets | Yes | `BETTER_AUTH_SECRETS` with a rotation runbook; `ACS_CONNECTION_STRING` removed and refused; `MIGRATION_DATABASE_URL` and `PURGE_WARNING_DATABASE_URL` documented with owner and rotation; ambient variables cannot change the auth keys. |
| SEC11 Phishing | Partial | The ninth fixed template carries only the purge date, no link and no free text, under the notice controls and the 20-recipient limit (D14). |
| SEC12 Testing | Yes | Each requirement has a scenario-backed test; the DAST probe covers the report route (D9); the proxy-trust spoofing matrix and the concurrency tests are integration tests. |
| SEC13 Deployment | Partial | The production Cerbos file is reviewed and tested here and mounted by `046`; the warning job is a scheduled job provisioned by `046`; the operator CLI authenticates with the operator's own identity under PIM. |
| SEC14 Infra permissions | Yes | Two migrations (Checkpoint 3): `0016` (an index) and `0017` (a column, a role with column-level grants and two policies); the purge role gains nothing; the migration command refuses every runtime role (D1). |
| SEC15 Network and host | Partial | No new listener; proxy trust is bounded by hop count and peer range; the deployed values are `046`'s. |
| SEC16 Logging | Yes | Four new events, three counters and new values, opaque ids and enums only; the engine's decision log reaches stdout with a closed attribute set (D10). |

## Risks / Trade-offs

- [A wrong `TRUST_PROXY_*` value in production] → Too few hops or the wrong range keys
  every request on the ingress address (one shared bucket, a self-inflicted lockout); too
  many trusts a spoofable header. Startup refuses a missing value, and `046` verifies the
  values against the deployed ingress before the first user.
- [A client-id bucket lets anyone exhaust a known client id's budget] → Client ids are not
  secret. The client bucket is higher than the address bucket and short (60 s), and the
  refusal reveals nothing about the credential (Q21).
- [The shared limiters add a write per public request] → Token exchange and back-channel
  logout are low-volume; `auth.rate_limit` grows until `044`'s prune ticket lands, now more
  urgent (Tickets).
- [A rehash races a second concurrent sign-in of the same user] → The second sign-in's
  reset-race check (`044` D7) sees a changed hash and refuses it like a wrong password. It
  happens at most once per user, on the first sign-in after an upgrade; the user retries.
- [scrypt at three times today's CPU on a public route] → The pre-authentication limits
  bound it; the memory per hash is unchanged (32 MiB). The measured time is recorded.
- [A daily warning job that misses or delays a run can skip a marker] → Each marker is in the
  24-hour window for one run. `046` alerts when the job did not run in 26 hours; the purge job
  is not enabled before the warning job runs (`045` Q68).
- [At most once: a failed send is not retried] → The failure event is the alert; the
  deletion notice was already sent at request time; a retry could double-send to a recipient
  whose first send partly succeeded (Q24).
- [CSP report counts are spoofable] → Trend alerts only; no log line per report; the budget
  drops floods.
- [Removing `form_post` if Visma Connect cannot return by query] → `002` Q71 already required
  `response_mode=query`; `046`'s F2 run against the test environment confirms it before the
  first deployment.
- [The cache keeps a revoked Visma Connect key for up to ten minutes] → A logout token is a
  revocation, not a grant; accepting a token signed by a just-rotated key only revokes
  sessions. The ID-token verifier is not cached.
- [A rotation still signs every session out] → Stated in the runbook; rotations are planned.
- [`@azure/identity` brings MSAL and `open` into the API image] → Reviewed in task 1.2; only
  `ManagedIdentityCredential` and `AzureCliCredential` are imported.

## Gates for the first deployment (`046`)

Human-owned. Each item below is now code; `046` configures and verifies it in the deployed
environment:

- **B1**: `tayzu_migrator` exists with `CREATEROLE` and `CREATE` on the database, its URL is
  in Key Vault as `MIGRATION_DATABASE_URL` for the pipeline only, and one deployment proves
  `db:migrate` refuses the runtime URL.
- **D3**: `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS` are set to the deployed ingress (with or
  without Front Door) and verified with a spoofed `X-Forwarded-For` from outside the range.
- **D7**: `BETTER_AUTH_URL`, `ALLOWED_ORIGINS` and both link bases name the one public origin
  (startup now refuses a mismatch of the first two).
- **C2**: `BETTER_AUTH_SECRETS` is in Key Vault with version 1, and a rotation is rehearsed
  in the sandbox with the runbook (TOTP still verifies; sessions are signed out).
- **F8**: nothing to set; the first users are created after the deployment, in the new format.
- **F4**: the F2 run against Visma Connect's test environment now checks `response_mode=query`,
  the `nonce` echo and the session cookie at the callback under the production cookie settings
  (the old `form_post` item of F2 is obsolete).
- **D10**: the replica ceiling is recorded, and with it the per-replica budgets of the `/v1`
  per-principal limiter and the SPA fallback.
- **F6**: migration `0016` runs before the release that carries the `on conflict` insert.
- **D8**: the ingress does not strip `Reporting-Endpoints`; the trend alert on
  `tayzu.web.csp_violations`.
- **G3**: Cerbos runs with `config/cerbos.production.yaml`, and its stdout reaches Azure
  Monitor with the security retention of Q4.
- **G10**: the warning job is a daily Container Apps Job with its own identity and the
  `tayzu_purge_warning` secret, enabled before the purge job; the orphan-marker alert and the
  missed-run alert exist.
- **C1**: the ACS resource grants the API's and the jobs' managed identities, and the
  operator's PIM group, the role that sends email, and a real token is obtained once in the
  sandbox.
- **G12, G13**: alerts on `identity.internal_error` / `tayzu.authz.errors` and on repeated
  `auth.security.active_organization_rejected`.

## Tickets (not built in this change)

| Ticket | Item |
| ------ | ---- |
| Prune `auth.rate_limit` (`044`) | More urgent: two new scopes write rows on public routes (D7). |
| Cache the re-authorization verifier's keys | The step-up guard still fetches discovery and JWKS per check (D8). |
| Identity internal errors for repository failures | The accept flow's repository errors still end in the uniform rejection with no internal-error event (D11). |
| A shared store for the `/v1` and SPA budgets | With `004`'s Redis, if `046`'s replica ceiling makes the per-replica budgets too loose (D7). |

## Migration Plan

1. **Two SQL migrations, both Checkpoint 3**, each with its
   `migrations/down/00NN_<tag>.down.sql`, `meta/00NN_snapshot.json` and `_journal.json`
   entry; the journal ends at idx 15 (`0015_catalog_entity_search`), and nothing is
   renumbered:
   - `0016_backchannel_logout_replay_uq` (D8, task 7.4);
   - `0017_tenant_deletion_warning` (D14, task 12.1).
2. No Cerbos policy changes. `config/cerbos.production.yaml` is engine configuration (Q15).
3. Deploy (`046`): run `db:migrate` with `MIGRATION_DATABASE_URL` before the release; set the
   new variables (`BETTER_AUTH_SECRETS`, `TRUST_PROXY_*`, `ACS_ENDPOINT`, optional
   `AZURE_CLIENT_ID`, `PURGE_WARNING_DATABASE_URL`) and remove the retired ones, which startup
   refuses; mount the production Cerbos file; enable the warning job before the purge job.
4. Rollback: the migrations have down scripts. Rolling back the release that removed the
   `POST` callback or the retired variables needs the old variables restored; no deployed
   environment exists yet, so the first deployment carries this change from the start.

## Resolved decisions (asked and approved in chat, 2026-11-27)

Per `openspec/project.md` §20. Q1 to Q16 were answered by the human in chat on 2026-11-27;
each row says whether the recommended option was taken. Q17 to Q20 are the orchestrator's
choices, open to Checkpoint 1. Q21 to Q28 (the design's open questions Q21 to Q26, Q27 and Q28)
were answered by the human in chat on 2026-11-27; Q29 to Q31 (Q29, Q30, Q31) are orchestrator
choices, open to Checkpoint 1. Q2 to Q4 govern `046` and are recorded here for traceability.

| # | Question | Decision |
| - | -------- | -------- |
| Q1 | Scope split of the first deployment | `048` takes the code gates and runs before `046`; `046` keeps the IaC, the pipeline, the sandbox rehearsal, the alerts, the retention and the release checklist (roadmap D14). Answered by the human in chat on 2026-11-27, recommended option. |
| Q2 | (for `046`) IaC tool | OpenTofu (ADR-0027). Answered by the human in chat on 2026-11-27, **not the recommended option** (Bicep was recommended). |
| Q3 | (for `046`) Deployment path | GitHub Actions with OIDC federated credentials to a sandbox subscription, each `apply` approved in a GitHub environment. Answered by the human in chat on 2026-11-27, recommended option. |
| Q4 | (for `046`) Security and audit log retention | 12 months interactive plus archive to 24 months (`001` R8). Answered by the human in chat on 2026-11-27, recommended option. |
| Q5 | B1: how strict `db:migrate` is | `MIGRATION_DATABASE_URL` is always required and never falls back to `DATABASE_URL`; the runner refuses, with a fixed message naming no role or host, when `current_user` is a runtime role (`tayzu_app`, `tayzu_auth`, `tayzu_purge`, `tayzu_deletion_admin` and the new warning role); CI, e2e and DAST scripts and `turbo.json` export it; the TLS error names the variable it was given. Answered by the human in chat on 2026-11-27, recommended option (D1). |
| Q6 | D3: shape of the proxy trust | `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS`; hop `i` trusted only when `i < hops` and the address is inside the CIDRs; startup fails without them outside `NODE_ENV=test`; under test, today's loopback, link-local and unique-local list by default; `046` sets the values. Answered by the human in chat on 2026-11-27, recommended option (D2). |
| Q7 | F4: binding the step-up callback | A 256-bit `nonce` drawn in `start`, stored in the binding, sent and verified against the ID token after the code exchange; `response_mode=query`; the `POST` callback and its form parser removed; the callback requires the session cookie and compares it in constant time with the bound session; a mismatch logs the new reason `session_mismatch` (WARN, the same 303 to the failure location) in both auth contracts; the OIDC stub honours `response_mode=query` and echoes the `nonce` (test-writer work). Answered by the human in chat on 2026-11-27, recommended option (D6). |
| Q8 | F8: password hash | Tayzu-owned scrypt `N=2^15, r=8, p=3`, 64-byte key, explicit `maxmem`, self-describing `$scrypt$` format, `timingSafeEqual`, NFC only in the new format; legacy Better Auth `salt:key` hashes verified through Better Auth's function and rewritten on the next successful local sign-in (`hooks.after` of `/sign-in/email`, without changing the answer or timing of a failed sign-in); the reset path uses the same function; the `password-reset-and-account-recovery` wording becomes "the platform's password hash function"; a new ADR. Answered by the human in chat on 2026-11-27, recommended option (D5). |
| Q9 | C2: versioned secrets | `BETTER_AUTH_SECRETS` (`<version>:<value>,...`, each value at least 32 characters, unique non-negative versions, the first current) parsed in `config.ts` and passed explicitly as `secrets` to Better Auth and the scripts; `BETTER_AUTH_SECRET` retired and refused if set; a test that an ambient `BETTER_AUTH_SECRETS` cannot change the instance's keys; an integration test that data encrypted under version 1 still decrypts after version 2 becomes current; manual JWKS rotation with a runbook in `docs/security/secrets.md` that says cookie signing still signs everyone out. Answered by the human in chat on 2026-11-27, recommended option (D4). |
| Q10 | D8: CSP violation reports | `POST /v1/csp-reports` on `PUBLIC_ROUTE_ALLOWLIST`, exempt from the `/v1` JSON media-type check only for `application/csp-report` and `application/reports+json`; the policy gains `report-uri` and `report-to` with a `Reporting-Endpoints` header; always `204`, even malformed; an 8 KiB body limit; a per-address in-process bucket; a null-prototype parse; only the effective or violated directive is read, mapped onto the fixed `CSP_DIRECTIVES` names plus `other`; the counter `tayzu.web.csp_violations` with one attribute; no log line per report; `document-uri`, `blocked-uri`, `source-file`, `script-sample` and `referrer` are never read; counts are spoofable, so `046` alerts on trends only; the `catalog-ui-core` CSP and telemetry requirements are MODIFIED. Answered by the human in chat on 2026-11-27, recommended option (D9). |
| Q11 | D10: which limiters move | Token exchange (with the client-id bucket the `auth-and-rbac` spec already requires, closing the drift from `002` Q56) and back-channel logout move to the shared `auth.rate_limit` store (no migration; new `RateLimitScope` values); the `/v1` per-principal limiter and the SPA fallback stay in memory, documented as per-replica budgets; `046` records the replica ceiling. Answered by the human in chat on 2026-11-27, recommended option (D7). |
| Q12 | G10: who sends the pre-purge warning | A separate daily job `identity:purge-warning` with its own narrow role (`tayzu_purge_warning`) and the email sender; it selects pending markers with `purge_after` in (now + 24 h, now + 48 h] and `warned_at` null, sets `warned_at`, sends a fixed template (purge date only) under the deletion notice's controls and 20-administrator ceiling; a send failure never blocks other tenants; one event per marker seen (tenant id, no free text), which `046` joins against `catalog.audit.org_deletion_requested`; migration `0017` (`warned_at`, the role, the narrow grant, the RLS policy) at Checkpoint 3; the purge role gains nothing. Answered by the human in chat on 2026-11-27, recommended option (D14). |
| Q13 | C1: ACS credential | `@azure/identity` `4.14.1` (MIT, published 2026-10-29, meets the 14-day rule; its direct dependencies listed and its install scripts reviewed against `allowBuilds`); `ManagedIdentityCredential` (optional `AZURE_CLIENT_ID` for a user-assigned identity) for the API and the jobs, `AzureCliCredential` for the operator CLI under PIM; `ACS_ENDPOINT` (non-secret) replaces `ACS_CONNECTION_STRING`, which is removed and refused at startup if set; the adapter takes an injected `TokenCredential`, so tests stay offline; the real-token check is a `046` sandbox step. This design is the amendment `043` Q28 asked for. Answered by the human in chat on 2026-11-27, recommended option (D13). |
| Q14 | F6: making the replay guard atomic | Migration `0016`, a partial unique index on `auth.verification(identifier)` `WHERE starts_with(identifier, 'backchannel-logout:')`, which fails loudly (never deletes) if duplicates exist; `insert ... on conflict (identifier) where ... do nothing`; the insert and the session delete in one `tayzu_auth` transaction; plus cached discovery and JWKS (bounded TTL, fail closed) and a bound on `exp - iat` (`002:1324`), keeping the hand-rolled verifier (no `jose`); Checkpoint 3. Answered by the human in chat on 2026-11-27, recommended option (D8). |
| Q15 | G3: Cerbos decision log | A new `config/cerbos.production.yaml` (audit backend `file`, path `stdout`), tested equal to `config/cerbos.yaml` except the audit backend; a test that the attribute keys Tayzu sends to Cerbos (principal and resource, catalog pipeline and identity wrapper) are a closed set with no tenant free text; not a Checkpoint 3 item (engine configuration, not a policy), as the human confirmed; local and CI keep `local`. Answered by the human in chat on 2026-11-27, recommended option (D10). |
| Q16 | G12: signal of an engine outage | A new ERROR event `identity.internal_error` (operation and `error.type` only) and a counter `tayzu.authz.errors` (resource kind, action); a Cerbos error in the identity wrapper (`define-operation.ts`) and in the accept flow's inviter re-check is no longer counted as a deny on `tayzu.authz.decisions`; it still fails closed. Answered by the human in chat on 2026-11-27, recommended option (D11). |
| Q17 | G13: shape of the rejected tenant-switch signal | `auth.security.active_organization_rejected` (WARN, `tayzu.actor.id` and a fixed outcome, never the caller-supplied organization id) and a `set_active_rejected` value on `tayzu.auth.session.events`, in the `packages/auth` contract and its `packages/authz` mirror. **Orchestrator choice, open to Checkpoint 1** (D12). |
| Q18 | D7: one public origin | Startup fails when `BETTER_AUTH_URL`'s origin is not in `ALLOWED_ORIGINS`. **Orchestrator choice, open to Checkpoint 1** (D3). |
| Q19 | Where the spec deltas go | Into the five existing capabilities, with no new capability. **Orchestrator choice, open to Checkpoint 1.** |
| Q20 | Migration numbers | `0016` (F6) and `0017` (G10), each with its down migration under `packages/db/migrations/down` per the existing convention. **Orchestrator choice, open to Checkpoint 1.** |
| Q21 | Shape of the token-exchange client-id bucket (D7, was OQ1) | Keep the address bucket (`002` Q56) and add a separate client-id bucket counted across addresses. Answered by the human in chat on 2026-11-27, recommended option. |
| Q22 | Reason logged when the ID token's `nonce` differs (D6, was OQ2) | `exchange_failed`, the reason of every other post-exchange failure; `session_mismatch` stays the only new reason. Answered by the human in chat on 2026-11-27, recommended option. |
| Q23 | How the warning job reads the administrators' addresses and the notice buckets (D14, was OQ3) | It also holds `tayzu_auth` (`AUTH_DATABASE_URL`) and `IDENTITY_TOKEN_HMAC_SECRET`, as the request path's deletion notice does; `0017` stays one column, one role and two policies. Answered by the human in chat on 2026-11-27, recommended option. |
| Q24 | Delivery semantics of the warning (D14, was OQ4) | At most once: `warned_at` is claimed before the send, and the failure event is the alert. Answered by the human in chat on 2026-11-27, recommended option. |
| Q25 | Bounds of the back-channel hardening (D8, was OQ5) | `exp - iat` at most 300 seconds, cache TTL 10 minutes, at most one unknown-`kid` refresh per 60 seconds, fixed in code and checked against Visma Connect's real tokens in `046`'s F2 run. Answered by the human in chat on 2026-11-27, recommended option. |
| Q26 | CSP report budget (D9, was OQ6) | 60 reports per 60 seconds per address, at most 20 entries counted per `reports+json` body, fixed in code, over-budget reports dropped with no event. Answered by the human in chat on 2026-11-27, recommended option. |
| Q27 | Rehash when the second factor is still pending (D5, was OQ9) | Yes, once the password has verified and the reset-race check has passed, whether or not a second factor follows. Answered by the human in chat on 2026-11-27, recommended option. |
| Q28 | Answer of an identity operation during an engine outage (D11, was OQ10) | Unchanged, `AUTH_FORBIDDEN`, as the `auth-and-rbac` scenario "Cerbos evaluation error denies rather than allows" states. Answered by the human in chat on 2026-11-27, recommended option. |
| Q29 | Is `POST /v1/csp-reports` in the scripted DAST probe (D9, was OQ7) | Yes: `044`'s probe of public routes without an OpenAPI document gains it. **Orchestrator choice, open to Checkpoint 1.** |
| Q30 | Spec home of B1 and D7 (was OQ8) | ADDED requirements in `auth-and-rbac` ("Schema migrations run only as the migration role", "The public origin is checked at startup"); the proposal's capability list names them. **Orchestrator choice, open to Checkpoint 1.** |
| Q31 | Names this design introduced (was OQ11) | The names listed in D9, D12, D14 and the Observability contract (`tayzu_purge_warning`, `PURGE_WARNING_DATABASE_URL`, `catalog.audit.org_deletion_marker_seen`, `catalog.security.org_deletion_warning_failed`, `tayzu.identity.org_deletion_warnings`, `identity.organization.purge_warning`, `org_deletion_warning`, `tayzu.web.csp.directive`, `tayzu.auth.set_active.outcome`, the scopes `token_exchange_client` and `backchannel_logout`, `TOKEN_EXCHANGE_CLIENT_RATE_LIMIT_*`). **Orchestrator choice, open to Checkpoint 1.** |

## Open Questions

None. Every question raised while writing this design was asked in chat on 2026-11-27 and is
recorded above (Q21 to Q31).
