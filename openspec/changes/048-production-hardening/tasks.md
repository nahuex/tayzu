# Tasks: 048-production-hardening

**How to execute these tasks (Agentic TDD).** Every task below, except the tasks marked
_(setup)_, is **one self-contained red-green-refactor cycle**:

1. **Red.** The `test-writer` writes only the test named in the task's _Verify_ clause,
   with its fixtures, runs it and shows it **fails for the expected reason**: a missing
   behaviour, not a typo or a missing import.
2. **Green.** The `implementer` writes the minimum production code that makes the test
   pass, without changing the test.
3. **Refactor.** Clean up with every test green, then run `pnpm --filter <pkg> test`,
   `pnpm lint` and `pnpm typecheck`.
4. The orchestrator ticks the box and commits with the task number (for example
   `feat(api): 3.3 proxy trust function`).

A task marked **(Checkpoint 3)** adds a database migration: stop before applying it and
present the SQL in chat for the human's separate, explicit approval (root `CLAUDE.md`).
This change has two migrations (tasks 7.4 and 12.1) and no Cerbos policy change
(design D10, Q15); a policy change found necessary during implementation is asked in chat
first and stops at Checkpoint 3 before any file under `policies/` is written.

Tasks follow the Resolved decisions Q1 to Q35 of `design.md` (Q32 to Q35 answer task 1.1's
pre-assessment, `ssa-pre-assessment.md`). A later answer of the human becomes a row from Q36 on, and a task it changes is amended before it is started. After every group that adds
telemetry, the `observability-auditor` subagent checks that the declared names really exist.
Scenario names in quotes refer to `specs/<capability>/spec.md` of this change.

## 1. Pre-assessment and setup

- [x] 1.1 _(setup)_ First, at the start of implementation, run the `vcdm-ssa-validator` pre-assessment
      (Mode A) of this change's proposal, specs, design and tasks against SEC01-SEC16, and a
      drift-check of the files the design names against `master`: `packages/db/src/`
      (`run-migrations.ts`, `connection-security.ts`, `index.ts`, `harness.ts`),
      `apps/api/src/config.ts`, `server.ts` (proxy trust, the media-type hook, the
      back-channel route, the re-authorization callback, the token-exchange limiter, the
      CSP directives), `reauthorization.ts`, `bootstrap.ts`, `public-routes.ts`,
      `email-sender.ts`, `identity/define-operation.ts`, `identity/accept-flow.ts`,
      `identity/notices.ts`, `apps/api/scripts/script-config.ts`, `purge-job.ts`,
      `recover-admin-mfa.ts`, `packages/auth/src/auth.ts` (password options, the
      `set-active` and `/sign-in/email` hooks), `sso/reauthorization.ts`,
      `sso/backchannel-logout.ts`, `rate-limit/`, the three telemetry contract modules and the
      identity fixture, `identity/email/`, `config/cerbos.yaml`, `turbo.json`,
      `scripts/ci/e2e.sh`, `scripts/ci/dast.sh`, `.github/workflows/ci.yml` and the
      migrations journal. Enumerate the principal and resource attribute keys sent to
      Cerbos today for design D10. Fix mechanical drift in place in the Context of
      `design.md`; ask every scope or design conflict and every new question in chat with 2
      to 4 options and a recommendation, and record each answer as a Resolved decision from
      Q32 on. At implementation time it is repeated as a last
      drift-check against `master`, adjusting import paths, line references and attribute
      names only, with no scope change. Verify: the report is attached to the PR with zero
      open blocking gaps or an explicit deferral recorded, every question has a Resolved
      decision row, and a short note in the PR description states what was adjusted.
- [x] 1.2 _(setup)_ Add `@azure/identity` `4.14.1` to `apps/api/package.json` at the exact
      version (design D13), re-checking the 14-day rule on the day of the install. Review the
      lockfile diff: it adds only `@azure/identity` and its transitive packages, each with a
      row in `docs/security/dependencies.md` (license, publisher, install scripts); an
      install script is allowed only through an explicit `allowBuilds` entry in
      `pnpm-workspace.yaml` with its reason, and none is expected. Confirm with `pnpm why`
      that `@azure/core-auth` stays a single copy shared with `@azure/communication-email`.
      Verify: `pnpm install` succeeds with no ignored build script left unexplained,
      `pnpm audit --prod --audit-level=high` reports nothing, the SBOM of `scripts/ci/syft.sh`
      lists the new packages, and `pnpm lint` passes.
- [x] 1.3 _(setup)_ Scaffold the warning job: `apps/api/scripts/purge-warning-job.ts` (an
      empty `main` through `run-script.ts`), the package script `identity:purge-warning`, and
      the module in `scripts-smoke.test.ts`. Verify: `pnpm --filter @tayzu/api test` runs the
      smoke test green, and `pnpm lint` and `pnpm typecheck` cover the module.

## 2. Migrations run as the migration role (B1)

- [x] 2.1 `resolveMigrationUrl(env)` reads only `MIGRATION_DATABASE_URL` (design D1). Verify:
      `packages/db/src/run-migrations.test.ts` covers "The migration command needs its own
      variable": unset and blank fail with the fixed message naming only
      `MIGRATION_DATABASE_URL`, a set `DATABASE_URL` is never read, and a set value is
      returned unchanged.
- [x] 2.2 The TLS error names the variable it was given (design D1). Verify:
      `packages/db/src/connection-security.test.ts` covers "A TLS error names the variable it
      was given": `assertVerifiedTls` and `createPool` with `variable:
      'MIGRATION_DATABASE_URL'` name it, the default names `DATABASE_URL`, and no message holds
      the URL, the host or the user.
- [x] 2.3 The runner refuses a runtime role before migrating (design D1). Verify:
      `packages/db/src/run-migrations.int.test.ts` covers "The migration command refuses a
      runtime role" for `tayzu_app`, `tayzu_auth`, `tayzu_purge` and `tayzu_deletion_admin`
      (the harness login roles), with the fixed message naming no role, user or host and no
      migration applied, and the owner connection migrating (a no-op on the migrated
      database); `RUNTIME_DATABASE_ROLES` is exported by `@tayzu/db` (task 12.1a adds the
      warning role, task 12.2 its refusal case).
- [x] 2.4 _(setup)_ Wire `MIGRATION_DATABASE_URL`: `turbo.json` `db:migrate.env` becomes
      `["MIGRATION_DATABASE_URL"]`; `scripts/ci/e2e.sh` and `scripts/ci/dast.sh` export the
      owner URL as `MIGRATION_DATABASE_URL` before `pnpm db:migrate` and no longer set
      `DATABASE_URL` to it; `.github/workflows/ci.yml` passes it wherever a job migrates.
      Verify: `e2e-script.test.ts` and `dast-script.test.ts` (extended) assert the export
      before the migrate step, `pnpm e2e` and `bash scripts/ci/dast.sh` migrate and pass
      locally, and `pnpm db:migrate` with only `DATABASE_URL` set fails with the fixed
      message. Docs in the same task: `docs/security/secrets.md` "Migrations" names
      `MIGRATION_DATABASE_URL` (owner, rotation, pipeline-only, the runtime-role refusal), and
      the B1 row of the Pending table of `docs/security/attack-surfaces.md` is closed with a
      pointer to the gate that `046` keeps; `pnpm lint` passes and `config.test.ts`'s
      secrets-table assertion still holds.

## 3. Startup configuration: proxy trust and one public origin (D3, D7)

- [x] 3.1 `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS` are parsed and required outside test
      (design D2). Verify: `apps/api/src/config.test.ts` covers "Startup fails without the
      proxy trust outside the test environment": hops from 1 to 5, IPv4 and IPv6 blocks and
      bare addresses accepted, zero, six, fractional, a malformed block and one variable
      without the other refused in every environment, both unset refused outside test and
      defaulting to the loopback, link-local and unique-local list under test, every error
      naming only the variable. The same commit sets `TRUST_PROXY_HOPS=1` and
      `TRUST_PROXY_CIDRS=127.0.0.1/32,::1/128` in `scripts/ci/e2e.sh` and
      `scripts/ci/dast.sh`, asserted by `e2e-script.test.ts` and `dast-script.test.ts`.
- [x] 3.2 `createTrustProxy({ hops, cidrs })` trusts hop `i` only when `i < hops` and the
      address is inside the CIDRs (design D2). Verify: `apps/api/src/trust-proxy.test.ts`
      covers the spoofing matrix (a peer outside the range, a trusted peer, more forwarded
      values than hops, an IPv4-mapped IPv6 peer, an IPv6 range) by calling the function the
      way `proxy-addr` does.
- [x] 3.3 `createApp` and `createAppFromEnv` use the configured trust (design D2). Verify:
      `apps/api/src/trust-proxy.http.int.test.ts` covers "A spoofed forwarded address from an
      untrusted peer is ignored", "A forwarded address from the trusted ingress is used" and
      "Extra hops beyond the configured count are not trusted" through `inject` with
      `remoteAddress`, observed on the accept route's limiter;
      `apps/api/src/pre-auth-rate-limit.int.test.ts` and the suites that rely on the loopback default stay green.
- [x] 3.4 `BETTER_AUTH_URL`'s origin must be one of `ALLOWED_ORIGINS` (design D3). Verify:
      `apps/api/src/config.test.ts` covers "An authentication base URL outside the allowed
      origins is refused" (a different host, scheme or port refused, a path on an allowed
      origin accepted, the message naming both variables and no value); fixtures that set an
      unlisted origin are corrected by the test-writer.
- [x] 3.5 _(setup)_ Docs: `docs/security/secrets.md` lists `TRUST_PROXY_HOPS` and
      `TRUST_PROXY_CIDRS` as non-secret configuration with the values `046` must set; the
      "Configurable `TRUST_PROXY` (Q58)" row (D3) of the Pending table of `attack-surfaces.md`
      is closed with a pointer to `046`'s verification, and the "Client address" row (`:97`)
      and line 371, which also name `TRUST_PROXY`, follow; `apps/api/CLAUDE.md` states the
      trust rule. Verify: `pnpm lint` passes.

## 4. Versioned authentication secrets (C2)

- [x] 4.1 `BETTER_AUTH_SECRETS` is parsed and `BETTER_AUTH_SECRET` is refused (design D4).
      Verify: `apps/api/src/config.test.ts` covers "A malformed list is refused" and "The
      retired variable is refused" (duplicate, negative, signed, leading-zero and
      non-numeric versions, an empty value, a value under 32 characters, an empty list, the
      first entry current, a value containing a colon kept whole), and
      `apps/api/src/auth-secrets.test.ts` covers the shared parser. The same commit replaces
      `BETTER_AUTH_SECRET` with `BETTER_AUTH_SECRETS` in `scripts/ci/e2e.sh`,
      `scripts/ci/dast.sh` (including `:309`, the `BETTER_AUTH_SECRET=unused` of
      `zap-seed.ts --refresh`), `scripts/ci/zap-seed.ts:85,183` (which reads the secret and
      forwards it to `bootstrap-admin`) and the test fixtures, asserted by the script tests
      (`dast-script.test.ts` and `zap-seed.test.ts`).
- [x] 4.2 The instance receives `secrets` and `secret` explicitly (design D4). Verify:
      `packages/auth/src/auth-instance.test.ts` covers "An ambient variable cannot change the
      keys": with `BETTER_AUTH_SECRETS` and `BETTER_AUTH_SECRET` set in `process.env` to other
      values, `(await auth.$context).secretConfig` holds exactly the configured versions, the
      configured current version and the configured legacy key.
- [x] 4.3 A rotation keeps encrypted data readable (design D4). Verify:
      `packages/auth/src/secret-rotation.int.test.ts` covers "Encrypted data survives a
      rotation": a TOTP factor enrolled under `1:...` verifies after a restart with
      `2:...,1:...`, a backup code generated under version 1 still works, a session cookie
      signed under version 1 no longer resolves, and every Tayzu consumer of the signing key
      follows the current version (design D4): the pre-auth limiter's cookie signature
      (`pre-auth-rate-limit.ts:309`), the step-up-versus-login check of
      `packages/auth/src/auth.ts:1640-1643` (a re-sign-in with a current-version cookie is
      still a step-up) and `identity/reset-factor.ts`.
- [ ] 4.4 The scripts read `BETTER_AUTH_SECRETS` (design D4). Verify:
      `apps/api/src/script-config.test.ts` covers `bootstrap-admin` declaring and parsing
      `BETTER_AUTH_SECRETS`, every other script declaring neither name, a script refusing a set
      `BETTER_AUTH_SECRET`, and "The command holds no signing key" for `recover-admin-mfa`.
- [ ] 4.5 _(setup)_ Docs: `docs/security/secrets.md` replaces the `BETTER_AUTH_SECRET` row
      with `BETTER_AUTH_SECRETS` and its rotation runbook (prepend a version, keep the old one
      until no data needs it, the manual JWKS rotation steps checked against the installed
      `jwt` plugin, and the plain statement that a rotation signs every session out), and
      removes the residual-risk sentence it closes; `packages/auth/CLAUDE.md` names the new
      variable. Verify: `pnpm lint` passes, `config.test.ts`'s secrets-table assertion holds,
      and `apps/web/src/build-check/check-bundle.test.ts` reads the new name from the table
      fixture (`apps/web/src/build-check/__fixtures__/secrets.md`).

## 5. The platform's password hash (F8)

- [ ] 5.1 `hashPassword` writes the self-describing scrypt format (design D5). Verify:
      `packages/auth/src/password-hash.test.ts` covers the format
      (`$scrypt$ln=15,r=8,p=3$<salt>$<key>`, a 16-byte salt and a 64-byte key in unpadded
      base64, two hashes of one password differing), NFC normalization only (an NFD input and
      its NFC form hash to verifying values; an NFKC-only equivalent does not) and the
      explicit `maxmem`.
- [ ] 5.2 `verifyPassword` and `needsRehash` accept the platform and the legacy formats
      (design D5). Verify: `packages/auth/src/password-hash.test.ts` covers "A malformed stored
      hash fails closed" (unknown algorithm, parameters out of range or out of order, a short
      key, extra fields, padding), a legacy `salt:key` hash from `better-auth/crypto`
      verifying, a wrong password failing for both formats, the comparison going through
      `timingSafeEqual` (spied), and `needsRehash` true for legacy and lower-cost hashes only.
- [ ] 5.3 Every path that sets a password uses the platform hash (design D5). Verify:
      `packages/auth/src/auth-instance.test.ts` asserts `emailAndPassword.password` is the new
      pair, and `apps/api/src/password-nfc.int.test.ts` (extended) covers "A new password is
      stored in the current format" for acceptance, user creation, the bootstrap,
      `/change-password` and the reset, and "The reset stores the platform's current hash
      format".
- [ ] 5.4 A successful local sign-in rewrites a weaker hash (design D5). Verify:
      `packages/auth/src/password-rehash.int.test.ts` covers "A legacy hash still signs in and
      is upgraded" (with and without a pending second factor), "A failed sign-in does not
      touch the hash", "A rehash never overwrites a concurrent reset" (the compare-and-set
      keeps the reset's hash) and a rehash error that still completes the sign-in; and
      `packages/auth/src/enumeration-resistance.int.test.ts` (extended) shows a failed sign-in
      against a legacy hash answers the same status, code and body as before (its timing is
      task 5.4a's).
- [ ] 5.4a A failed check of a weaker hash costs the same as an unknown user (design D5,
      Q33). Verify: `packages/auth/src/password-hash.test.ts` covers "A failed sign-in against
      a weaker hash costs the same as an unknown user" at the function level (a failed legacy
      and a failed lower-cost platform hash each run exactly one current-cost `hashPassword`,
      spied; a successful check, a failed current-cost check and a malformed stored value run
      none; the answer stays `false`), and
      `packages/auth/src/enumeration-resistance.int.test.ts` (extended) shows a failed sign-in
      against a legacy hash in the same timing class as a sign-in for an unknown email.
- [ ] 5.5 _(setup)_ Docs: write `docs/adr/0028-tayzu-owned-scrypt-password-hash.md`
      (Context, Decision with the parameters and the format, Alternatives: `N=2^17, r=8, p=1`,
      Argon2id, refusing legacy hashes; Consequences: the rehash, the reset-race interaction,
      the equal failure cost of Q33, the residual `===` comparison of legacy hashes inside
      `better-auth/crypto` (`@better-auth/utils@0.4.2`; no legacy hash exists in production),
      the measured hash time on the CI runner); add the "amended by `048`" notes of design D16
      to ADR-0016:98 and ADR-0023:58,103; update the scrypt row of
      `docs/security/crypto-inventory.md` and the hash sentence of `packages/auth/CLAUDE.md`;
      design D5's heading links the ADR. Verify: `pnpm lint` passes and the ADR states the
      measured time.

## 6. The SSO step-up callback bound to the browser (F4)

- [ ] 6.1 Declare `session_mismatch` in `ATTRIBUTE_VALUES['tayzu.auth.reauthorization.reason']`
      of `packages/auth/src/telemetry/contract.ts` and its mirror in
      `packages/authz/src/telemetry/contract.ts`, before any code emits it. Verify:
      `packages/auth/src/telemetry/contract.test.ts` asserts the value in both modules and that
      the `auth.*` subsets stay equal, and `pnpm otel-smoke-check` stays green.
- [ ] 6.2 `start` draws a `nonce`, stores it in the binding and sends it with
      `response_mode=query` (design D6). The test-writer extends the OIDC stub
      (`packages/auth/src/__fixtures__/oidc-stub.ts`, with `oidc-stub.test.ts`) to honour
      `response_mode=query` and echo the request's `nonce`, with a switch to echo another one.
      Verify: `apps/api/src/step-up-sso-http.int.test.ts` covers "The re-authorization request
      is bound to the browser" (the URL's `nonce` is 43 base64url characters and differs per
      start, `response_mode=query` is present, the stored binding keeps the token as its first
      key so the pending-per-session bound still holds).
- [ ] 6.3 The callback requires and matches the session cookie (design D6). Verify:
      `apps/api/src/step-up-sso-http.int.test.ts` covers "A callback in another browser stores
      nothing" (no cookie and another session's cookie, each logging
      `auth.security.reauthorization_failed` with `session_mismatch`, the 303 to the failure
      location with the web app and the `400` without it, the state consumed), with the
      matching cookie still completing.
- [ ] 6.4 The ID token's `nonce` is verified before the result is stored (design D6).
      Verify: `apps/api/src/step-up-sso-http.int.test.ts` covers "A token with another nonce
      stores nothing" (the stub echoes another nonce: no `sso-reauth-result:` row, the reason
      `exchange_failed`, the next `blueprints.delete` failing with `AUTH_STEP_UP_REQUIRED`), and
      `packages/auth/src/step-up-sso.int.test.ts` (extended) shows
      `verifyReauthorizationIdToken` refusing a bad signature, issuer, audience or nonce while
      the guard's D25 checks are unchanged.
- [ ] 6.5 Only `GET` reaches the callback (design D6). Verify:
      `apps/api/src/reauthorize-redirect.http.int.test.ts` covers "A form-posted callback is
      not accepted" (a `POST` with a code and a state exchanges nothing, stores nothing and
      answers like an unknown `/v1` route), and `route-auth-allowlist.int.test.ts` asserts the
      allowlist entry is `GET` with its new reason; the `form_post` cases of both files are
      replaced, not skipped.
- [ ] 6.6 _(setup)_ Run the `observability-auditor` over group 6; update the doc comment of
      `apps/api/src/reauthorization.ts`, the "SSO step-up callback bound to the browser (Q71)"
      row (F4) of the Pending table of `attack-surfaces.md` (closed, with `046`'s F2 check of
      `response_mode=query`), the `form_post` mention of its "Verification against Visma
      Connect's test environment (Q57)" row, which F4 makes obsolete, and the callback row. Verify: the auditor reports no undeclared or missing name, and
      `pnpm lint` passes.

## 7. Shared limits and the atomic back-channel replay guard (D10, F6)

- [ ] 7.1 Token exchange consumes the shared `token_exchange` address bucket (design D7).
      Verify: `apps/api/src/token-exchange-rate-limit.int.test.ts` covers "The token-exchange
      budget is shared across replicas" (two `createApp` instances over one database) and
      "Machine token exchange is rate-limited independently of the authenticated bucket", with
      the 429 body and `Retry-After` unchanged and a failing store answering the sanitized
      500.
- [ ] 7.2 Token exchange also consumes a `token_exchange_client` bucket (design D7, Q21).
      Verify: `apps/api/src/token-exchange-rate-limit.int.test.ts` covers "One client id is
      limited across addresses", a varying client id from one address still limited by the
      address bucket, an oversized or missing client id counting the address bucket only,
      `TOKEN_EXCHANGE_CLIENT_RATE_LIMIT_*` parsed in `config.test.ts`, and the client id in no
      exported signal; `RateLimitScope` gains the scope and `BucketKeyKind` gains `client`.
- [ ] 7.3 Back-channel logout consumes the shared `backchannel_logout` bucket before any
      verification (design D7). Verify: `apps/api/src/backchannel-logout-http.int.test.ts`
      covers "The back-channel logout budget is shared across replicas" (no discovery or key
      fetch for a refused delivery) with the existing outcomes unchanged.
- [ ] 7.4 (Checkpoint 3) Migration `0016_backchannel_logout_replay_uq` (design D8): the
      partial unique index declared on the `verification` table of
      `packages/auth/src/persistence/schema.ts`, generated by `drizzle-kit generate`, with
      `packages/db/migrations/down/0016_backchannel_logout_replay_uq.down.sql`,
      `meta/0016_snapshot.json` and its `_journal.json` entry (the journal ends at idx 15).
      Verify: `packages/db/src/backchannel-replay-index.int.test.ts` covers the index and its
      exact predicate, a second `backchannel-logout:` row with the same identifier refused, two
      rows of another family with one identifier still accepted, the index build failing (and
      deleting nothing) over pre-existing duplicates, and the down script removing it;
      `schema.int.test.ts` passes with any index list it asserts updated. ⛔ **Checkpoint 3:
      present the SQL in chat and wait for the human's explicit approval before applying.**
- [ ] 7.5 The replay record and the session delete commit together (design D8). Verify:
      `apps/api/src/backchannel-logout.int.test.ts` covers "Concurrent deliveries of one token
      are processed once" (two connections, one `revoked` and one `replay`) and "A failed
      revocation does not consume the token" (a delete forced to fail rolls the record back,
      and the next delivery revokes), with "A replayed logout token is rejected without
      revoking anything twice" still green.
- [ ] 7.6 Discovery and the key set are cached for a bounded time and fail closed (design
      D8, Q25). Verify: `packages/auth/src/sso/backchannel-logout.test.ts` covers one fetch for
      several tokens within the TTL, a refetch after it, at most one unknown-`kid` refresh per
      60 seconds, an expired copy never used, and "Unavailable signing keys fail closed".
- [ ] 7.7 `exp - iat` above 300 seconds is rejected (design D8, Q25). Verify:
      `packages/auth/src/sso/backchannel-logout.test.ts` covers "A long-lived logout token is
      rejected" before any fetch, and `apps/api/src/backchannel-logout.int.test.ts` shows its
      `jti` unrecorded.
- [ ] 7.8 _(setup)_ Run the `observability-auditor` over group 7 (the two new scope values on
      `tayzu.auth.rate_limit.events` and `auth.security.rate_limited`); update
      `attack-surfaces.md`: the token-exchange and back-channel rows (shared, keyed by address
      and client id), the per-replica budgets of the `/v1` per-principal limiter and the SPA
      fallback with `046`'s replica ceiling, the "Back-channel logout and replicas (Q73)" row of
      the Pending table (F6 and the replica half of D10), and the back-channel residual risks
      of `002:1324` that this group closes. Verify: the auditor reports no undeclared or missing name, and
      `pnpm lint` passes.

## 8. CSP violation reports (D8)

- [ ] 8.1 Declare `tayzu.web.csp_violations` and the fifteen values of
      `tayzu.web.csp.directive` in `packages/auth/src/telemetry/identity-contract.ts`, before
      the route exists. Verify: `packages/auth/src/telemetry/identity-contract.test.ts`
      snapshot-asserts them against `identity-contract-expected.ts` (extended), and
      `pnpm otel-smoke-check` stays green.
- [ ] 8.2 The policy names the same-origin endpoint (design D9). Verify:
      `apps/api/src/headers.int.test.ts` and `csp-nonce.http.int.test.ts` (extended) cover
      "The app page carries the policy", "API responses carry the policy too" and "The policy
      reports violations to the app's own origin" with the new exact policy and the
      `Reporting-Endpoints` header on HTML, JSON, asset and `404` responses.
- [ ] 8.3 A report is reduced to its directive (design D9). Verify:
      `apps/api/src/csp-report.test.ts` covers the parse and the mapping: `csp-report` with
      `effective-directive` and with only `violated-directive`, a `reports+json` array (only
      `csp-violation` entries, at most 20), the level-3 sub-directives, "An unknown directive is
      counted as other", forbidden keys at every depth, and that no field other than the
      directive is read (a getter-trapped fixture).
- [ ] 8.4 `POST /v1/csp-reports` answers `204` and counts (design D9). Verify:
      `apps/api/src/csp-reports.http.int.test.ts` covers "A report is counted by its directive
      only" (the marker in no signal and no log record), "A Reporting API batch is counted per
      violation", "A malformed, hostile or oversized report still answers 204" and "The report
      route is public and reads no session".
- [ ] 8.5 The route's media types, size and budget (design D9, Q26). Verify:
      `apps/api/src/csp-reports.http.int.test.ts` covers "Other media types are refused like
      any `/v1` body" (`application/json` and `text/plain` each answer the hook's exact `415`
      body and count nothing), "A flood from one address is dropped" (keyed on `request.ip`
      under the configured trust), the bucket's bounded memory (many distinct addresses keep
      the store at its configured cap, design D9), and the `/v1` media-type hook unchanged for
      every other path; and
      `route-auth-allowlist.int.test.ts` asserts the new allowlist entry with its reason.
- [ ] 8.6 The scripted DAST probe covers the route (design D9, Q29). Verify:
      `apps/api/src/dast-probe.test.ts` (extended) asserts the probe sends malformed, oversized
      and prototype-polluting reports to `/v1/csp-reports` and fails the run on any answer but
      `204`, and `bash scripts/ci/dast.sh` passes locally.
- [ ] 8.7 _(setup)_ Run the `observability-auditor` over group 8; rewrite point 9 of
      `docs/adr/0026-strict-content-security-policy.md` (the endpoint, the directive-only
      counter, spoofable counts, trend alerts in `046`); add the route to
      `docs/security/attack-surfaces.md`. Verify: the auditor reports no undeclared or missing
      name, and `pnpm lint` passes.

## 9. The Cerbos decision log (G3)

- [ ] 9.1 `config/cerbos.production.yaml` equals the local file except for the audit backend
      (design D10). Verify: `packages/authz/src/config.test.ts` covers "The production engine
      configuration exports the decision log" (deep equality after removing the audit backend
      keys, `backend: file`, `file.path: stdout`, decision logs on, access logs off, strict
      evaluation, disk storage without watch, and the metadata keys set explicitly in both
      files so that no request metadata key is logged).
- [ ] 9.2 The pinned image accepts the production file and writes decisions to stdout
      (design D10). Verify: `packages/authz/src/cerbos-production-config.int.test.ts` starts the
      pinned image by digest (the digest of
      `packages/catalog/src/service/authz-pipeline.int.test.ts`) with the production file and
      `policies/`, makes one check (with request metadata set) and finds its decision record on
      the container's standard output, with no metadata key in it.
- [ ] 9.2a Caller-supplied identifiers are shape-guarded before the Cerbos call (design D10,
      Q32). Verify: `packages/catalog/src/service/authz-identifier-guard.int.test.ts` covers "A
      caller-supplied identifier that is not a valid identifier never reaches the decision
      log": through a recording Cerbos client around the real catalog services, a hostile
      `identifier` (a marker, a newline and an over-long string), `blueprint` and
      `spec.relations.ownerTeam` reach Cerbos as `_` in `authorize()` and in the entity
      referrer check, a valid identifier, the fixed ids and the masked `_user` placeholder
      pass unchanged, a `_` blueprint or team is denied (fail closed), and each operation's
      answer and error code are the same as without the guard
      (`pipeline-sanitize.int.test.ts` and `authz-pipeline.int.test.ts` stay green).
- [ ] 9.3 The attributes sent to Cerbos are a closed set (design D10). Verify:
      `apps/api/src/cerbos-attribute-keys.int.test.ts` covers "The decision log carries no
      tenant free text" over the catalog operations and the identity operations through a
      recording Cerbos client, with `CERBOS_PRINCIPAL_ATTRIBUTE_KEYS` and
      `CERBOS_RESOURCE_ATTRIBUTE_KEYS` exported by `@tayzu/authz` (the inventory of design
      D10), and with hostile values (Q32): a marker in the `identifier`, `blueprint` and
      `ownerTeam` inputs as well as in the title, description and properties, asserted absent
      from every attribute value, every resource id and every principal id, each of which
      matches an identifier, role or flag shape.
- [ ] 9.4 _(setup)_ Docs: the "Cerbos audit log (Q58)" row (G3) of the Pending table of
      `attack-surfaces.md` is closed with `046`'s mount step; the header comment of
      `config/cerbos.yaml` (lines 6-8, which cite a stale "task 7.2") points at the production
      file; `docs/security/data-retention.md` names the decision log's stdout path
      and the retention of Q4 that `046` sets. Verify: `pnpm lint` passes.

## 10. Telemetry for silent failures (G12, G13)

- [ ] 10.1 Declare the names before the code: `identity.internal_error` (ERROR, with
      `IdentityLogEventDeclaration.severity` gaining `'ERROR'`) in the identity contract;
      `tayzu.authz.errors` in `packages/authz/src/telemetry/contract.ts`;
      `auth.security.active_organization_rejected`, `tayzu.auth.set_active.outcome` and the
      `set_active_rejected` value in `packages/auth/src/telemetry/contract.ts` and its mirror.
      Verify: `contract.test.ts` and `identity-contract.test.ts` assert every name against
      their fixtures, the `auth.*` subsets stay equal, and `pnpm otel-smoke-check` stays green.
- [ ] 10.2 The identity wrapper reports an engine error as an internal error (design D11,
      Q28). Verify: `apps/api/src/identity/define-identity-operation-failclosed.test.ts`
      covers "An engine outage on an identity operation is not counted as a denial" for the
      caller check and the target check (`define-operation.ts:200-244`, whose denial records
      the second `recordAuthzDecision`), "An explicit denial is still a denial" and "The
      internal error carries no free text".
- [ ] 10.3 The accept flow's inviter re-check reports an engine error the same way (design
      D11). Verify: `apps/api/src/identity/accept-flow.int.test.ts` covers "An engine outage
      during an acceptance re-check fails closed", with a repository error still giving the
      uniform rejection and no internal-error event.
- [ ] 10.4 A rejected `/organization/set-active` is logged and counted (design D12). Verify:
      `packages/auth/src/active-org.int.test.ts` covers "A rejected tenant switch is logged
      without the supplied organization" (the `not_member` outcome, the counter value, the
      supplied organization id in no exported signal) and "Setting an active organization you
      are not a member of is rejected" still green.
- [ ] 10.5 _(setup)_ Run the `observability-auditor` over group 10; `otel-smoke-check`
      (`apps/api/src/otel-smoke-check.int.test.ts`) drives an engine outage on an identity
      operation and a rejected tenant switch once; update `docs/catalog/auth-and-rbac.md`'s
      telemetry reference with every name of groups 6 to 10. Verify: the auditor reports no
      undeclared or missing name, `pnpm otel-smoke-check` is green, and `pnpm lint` passes.

## 11. ACS through a managed identity (C1)

- [ ] 11.1 `ACS_ENDPOINT` replaces `ACS_CONNECTION_STRING` (design D13). Verify:
      `apps/api/src/config.test.ts` covers "The real sender needs its endpoint" and "A
      connection string is refused" (for `acs`, `none` and unset providers, under test and
      outside it), and `AZURE_CLIENT_ID` optional; the fixtures and the CI scripts stop setting
      the connection string.
- [ ] 11.2 The ACS adapter takes an injected token credential (design D13). Verify:
      `packages/auth/src/identity/email/azure-communication-email.test.ts` and
      `azure-email-sender.test.ts` cover "The real sender uses a token credential" with a stub
      credential (the client built from the endpoint and that credential, no connection string
      read, no network). The same commit moves the manual smoke script
      `packages/auth/scripts/acs-email-smoke.ts`, which would no longer typecheck, to
      `apps/api/scripts/acs-email-smoke.ts` (design D13, Q34): it builds an
      `AzureCliCredential` and the injected-credential adapter from `ACS_ENDPOINT` and the
      sender address, and refuses a set `ACS_CONNECTION_STRING`; `scripts-smoke.test.ts` loads
      it, and no file under `packages/auth/` reads `ACS_CONNECTION_STRING` except the refusal
      tests.
- [ ] 11.3 The API builds a managed-identity credential (design D13). Verify:
      `apps/api/src/email-sender.test.ts` covers "A user-assigned identity is selected by its
      client id" (a `ManagedIdentityCredential` for the configured client id, the
      system-assigned one without it), with `@azure/identity` mocked.
- [ ] 11.4 The operator CLI authenticates as the operator (design D13). Verify:
      `apps/api/src/script-config.test.ts` covers the declared lists (`ACS_ENDPOINT` in, the
      connection string refused when set by any script) and
      `apps/api/src/recover-admin-mfa.int.test.ts` covers "The command authenticates to the
      email provider as the operator" with an `AzureCliCredential` seam stubbed.
- [ ] 11.5 _(setup)_ Docs: `docs/security/secrets.md` removes the connection-string secret
      and its rotation section and adds `ACS_ENDPOINT`, `AZURE_CLIENT_ID` and the Azure role
      `046` assigns; `crypto-inventory.md` updates "Authentication to ACS";
      `data-retention.md` updates the operator environment (the `az login` under PIM) and the
      smoke script's new home; the bundle check's secret list follows the table, and its
      fixture `apps/web/src/build-check/__fixtures__/secrets.md` drops the connection string.
      Verify: `pnpm lint` passes and `apps/web/src/build-check/check-bundle.test.ts` and
      `config.test.ts`'s secrets-table assertion hold.

## 12. The pre-purge warning (G10)

- [ ] 12.1 (Checkpoint 3) Migration `0017_tenant_deletion_warning` (design D14, Q23):
      `warned_at` declared on the Drizzle table in `packages/catalog/src/persistence/schema.ts`
      and generated, with the guarded `tayzu_purge_warning` role, its `USAGE` on `public`, the
      column-level `SELECT` and `UPDATE` grants and the `purge_warning_select` and
      `purge_warning_update` policies appended by hand to the same file; with
      `packages/db/migrations/down/0017_tenant_deletion_warning.down.sql`,
      `meta/0017_snapshot.json` and its `_journal.json` entry. Verify:
      `packages/db/src/purge-warning-grants.int.test.ts` covers "The warning role is narrow"
      (markers at 23, 25, 47 and 49 hours and cancelled and purged markers, the requesting
      actor column refused, only `warned_at` writable and only to `now()`, the request role
      unable to set `warned_at`, the purge and reversal roles unchanged, no role able to
      `SET ROLE tayzu_purge_warning`) and the down script; `tenant-deletion-grants.int.test.ts`
      and `schema.int.test.ts` stay green with their lists updated. ⛔ **Checkpoint 3: present
      the SQL in chat and wait for the human's explicit approval before applying.**
- [ ] 12.1a `RUNTIME_DATABASE_ROLES` cannot drift from the roles the migrations create
      (design D1). Verify: `packages/db/src/runtime-database-roles.test.ts` reads the
      migrations under `packages/db/migrations/` and asserts that every role they create with
      `LOGIN`, other than `tayzu_migrator`, is in `RUNTIME_DATABASE_ROLES`; it fails for
      `tayzu_purge_warning` (created by `0017`) until the constant gains it.
- [ ] 12.2 _(setup)_ The harness and the configuration of the new role:
      `packages/db/src/harness.ts` creates the `tayzu_purge_warning` login role and its pool for
      tests; `run-migrations.int.test.ts` (task 2.3) adds it to the refused roles; `script-config.ts` declares `PURGE_WARNING_DATABASE_URL`,
      `AUTH_DATABASE_URL`, `IDENTITY_TOKEN_HMAC_SECRET`, the email variables, the kill switch and
      the disabled tenants for `purge-warning-job`. Verify: `pnpm --filter @tayzu/db test` and
      `pnpm --filter @tayzu/api test` stay green, and `script-config.test.ts` covers the new
      script reading only its own variables.
- [ ] 12.3 Declare the warning names before the job emits them: the span
      `identity.organization.purge_warning`, the counter `tayzu.identity.org_deletion_warnings`
      with its outcome attribute, the events `catalog.audit.org_deletion_marker_seen` and
      `catalog.security.org_deletion_warning_failed`, and `org_deletion_warning` in
      `tayzu.identity.email.template` and `tayzu.identity.notice.template`. Verify:
      `identity-contract.test.ts` snapshot-asserts them against the fixture, and
      `pnpm otel-smoke-check` stays green.
- [ ] 12.4 The fixed `OrgPurgeWarningNotice` template (design D14). Verify:
      `packages/auth/src/identity/email/org-purge-warning-notice-template.test.ts` covers "The
      warning carries no free text" (only the purge date interpolated, no link, a fixed
      subject), and the ACS adapter, the non-sending sender and the notice dispatcher's
      template list accept the new kind (`azure-communication-email.test.ts`,
      `non-sending-sender.test.ts`, `notices.test.ts`).
- [ ] 12.5 The job claims each marker in the window once (design D14, Q24). Verify:
      `apps/api/src/purge-warning-job.int.test.ts` covers "Only markers due in 24 to 48 hours
      are warned" and "A marker is warned once" (two runs in sequence and two concurrent runs),
      with `catalog.audit.org_deletion_marker_seen` emitted once per claimed marker before its
      send.
- [ ] 12.6 The warning goes through the notice controls (design D14). Verify:
      `apps/api/src/purge-warning-job.int.test.ts` covers "The warning is under the notice
      controls" (kill switch, per-tenant cap, recipient bucket, disabled tenant) and "The
      warning goes to at most 20 administrators".
- [ ] 12.7 A failed send never blocks other tenants (design D14). Verify:
      `apps/api/src/purge-warning-job.int.test.ts` covers "A failed send does not block other
      tenants", with the counter's `failed` and `dispatched` outcomes and the provider's error
      text in no signal.
- [ ] 12.8 The job needs telemetry and its own role, and flushes before it exits (design
      D14). Verify: `apps/api/src/purge-warning-job.int.test.ts` covers "The warning job needs
      telemetry" (under any `NODE_ENV`), a run under another database role refused before any
      claim, and the audit event exported by the time the process ends; and
      `apps/api/src/identity-events.int.test.ts` (extended) covers the two new events with
      their required attributes and no email, name or secret.
- [ ] 12.9 _(setup)_ Run the `observability-auditor` over group 12; update
      `docs/architecture/system-diagram.md` (the warning job with its `tayzu_purge_warning` and
      `tayzu_auth` connections and its ACS connection; the managed-identity token flow of
      group 11, with the token requests of the API and the jobs (managed-identity endpoint)
      and of the operator CLI (`az login`) to Entra ID; `POST /v1/csp-reports` from the
      browser to the API (HTTPS, group 8); the `reauthApi` node and its arrow narrowed to
      `GET` and `query` (`:66`, `:155`, group 6); and the Cerbos decision-log path (sidecar
      stdout, the Container Apps log sink, Azure Monitor, group 9); in the full diagram and in
      each trust zone's block, every arrow with its protocol), `docs/security/data-retention.md` (the 24-to-48-hour window, the daily
      cadence, the at-most-once delivery and the orphan-marker detection of `046`),
      `docs/security/secrets.md` (`PURGE_WARNING_DATABASE_URL`, its owner, rotation and its own
      job identity) and `docs/catalog/auth-and-rbac.md` (the warning names). Verify: the
      auditor reports no undeclared or missing name, every Mermaid block renders with
      `npx -y @mermaid-js/mermaid-cli`, `apps/api/src/system-diagram.test.ts` (extended)
      asserts each of the new and narrowed nodes and arrows, and `pnpm lint` passes.

## 13. Integration checks (Checkpoint 2 readiness)

- [ ] 13.1 `pnpm ci:local` is fully green (lint, typecheck, unit and integration tests,
      contract-check, otel-smoke-check, cerbos compile, audit, gitleaks, the web build and the
      bundle check, e2e). Verify: attach the command output to the PR description.
- [ ] 13.2 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against the implemented
      code, and resolve or explicitly defer every blocking gap. Verify: the report is attached
      to the PR with zero open blocking gaps.
- [ ] 13.3 Run `/security-review` on the branch and fix or justify every finding. Verify: the
      review output is attached to the PR.
- [ ] 13.4 `npx -y @fission-ai/openspec@1.13.2 validate 048-production-hardening --strict`
      passes, and design, specs and code agree (the design is updated only where an
      implementation finding forced a change, noted in the PR); then the PR moves from draft
      to ready for review for Checkpoint 2, with the change summary, the evidence of 13.1 to
      13.4, the two Checkpoint 3 approvals (`0016`, `0017`), the `tasks.md` checklist and the
      gates handed to `046` (design "Gates for the first deployment"). Verify: the validate
      output is attached, and the PR is ready for review with each item in its description.
