# Design: 044-password-reset-and-account-recovery

## Context

See `proposal.md` for the motivation. The state this design starts from, all read
from the repository at the merge of `043` (`b22cfb8`), its archive (`a68008f`) and the
archive of `002` (`e3f5771`):

- **There is no way back for a locked-out person.** Sign-in is email plus password,
  with TOTP and backup codes (`002`, Better Auth `twoFactor()` with defaults,
  `packages/auth/src/auth.ts:1057`). Better Auth's `/request-password-reset`,
  `/reset-password` and `/reset-password/:token` are off the `/api/auth` allowlist
  (`packages/auth/src/http/allowed-routes.ts`; the drift test
  `apps/api/src/auth-route-allowlist.test.ts` lists them as blocked at lines 60-66 and
  asserts it at lines 259-261). `/two-factor/disable` is blocked too, so a user who
  loses the authenticator and the backup codes has no path.
- **Better Auth's reset is unfit as it stands** (installed `better-auth@1.7.6`,
  `dist/api/routes/password.mjs`): the token is `generateId(24)` stored in clear in
  `verification.identifier` (`:74-79`), the emailed link goes through a GET callback
  that redirects with the token in a query string (`:92-128`), the known-user branch
  awaits the send while the unknown-user branch does not (`:60-90`, with
  `runInBackgroundOrAwait` in `dist/context/create-context.mjs:215-225`), it checks
  neither `banned` nor the `credential` account (it creates one, `:161-166`), and it
  neither deletes earlier tokens nor revokes sessions unless
  `revokeSessionsOnPasswordReset` is set (`:169`). The `haveIBeenPwned` plugin lists
  `/reset-password` in `BREACH_CHECKED_PATHS` (`auth.ts:129-136`), but its check runs
  inside `password.hash` and keys on the endpoint path
  (`dist/plugins/haveibeenpwned/index.mjs`).
- **The Better Auth adapter is not transactional here.** `auth.ts:920` builds
  `drizzleAdapter(options.db, { provider: 'pg', schemaName: 'auth' })` with no
  `transaction: true`; the installed `@better-auth/drizzle-adapter@1.7.6`
  (`dist/index.mjs:559`) then reports no transaction support and
  `@better-auth/core` (`dist/db/adapter/factory.mjs:421-425`) falls back to a wrapper that
  runs the callback on the same non-transactional adapter. `adapter.transaction(...)` is
  therefore a no-op today, which is why the completion of a reset is written as
  parameterized SQL on the connection that holds the per-user lock (D7, Q13).
- **`043` built the pattern to follow**: a public Fastify route outside the tenant
  pipeline (`POST /v1/auth/invitations/accept`, `apps/api/src/server.ts`), a token of
  256 bits whose sha256 digest is stored in `auth.verification` and verified in
  constant time (`packages/auth/src/identity/invitation-token.ts`), a DB-backed
  per-IP limiter (`apps/api/src/identity/accept-rate-limit.ts`), an explicit
  public-route allowlist (`apps/api/src/public-routes.ts`), the `MOUNT_IDENTITY_ROUTES`
  switch, the `EmailSender` port with a closed `EmailTemplate` union
  (`packages/auth/src/identity/email/sender.ts`), the shared cap store and HMAC
  recipient key (`email-cap-store.ts`, `recipient-key.ts`), the per-user advisory lock
  (`apps/api/src/identity/user-lock.ts`), the identity operation wrapper
  (`apps/api/src/identity/define-operation.ts`) and the identity telemetry
  contract module (`packages/auth/src/telemetry/identity-contract.ts`).
- **The `043` tenant-keyed email gate cannot serve an anonymous request**:
  `EmailTenantGate.admit` takes a `tenantId` and throws `AuthRateLimitedError` on a cap
  hit (`apps/api/src/identity/email-tenant-gate.ts`), which for an unauthenticated
  caller would reveal that an address was requested recently. The notice dispatcher
  never throws but is typed to one template and a tenant (`notices.ts`).
- **A temporary password that expires locks its owner out**: `hooks.before` rejects a
  session under an expired `temp-password:<userId>` marker and `hooks.after` rewrites
  the sign-in to a wrong-password answer (`auth.ts`, the `hasExpiredTemporaryPasswordMarker`
  branches at `:1394`), and only `/change-password` deletes the marker.
- **The client address is `request.ip` under a fixed trust setting.** `server.ts:445`
  builds Fastify with `trustProxy: ['loopback', 'linklocal', 'uniquelocal']`. There is no
  `TRUST_PROXY` variable: a configurable one is a pending first-deployment gate
  (`002` Q58; `docs/security/attack-surfaces.md:77` and `:365`). The existing limiters key
  on the raw `request.ip` (`accept-rate-limit.ts`), and nothing in the repository
  normalizes an IPv6 address.
- **Roadmap and hand-offs**: `openspec/project.md:412` and D10 (`:444-449`) define the
  scope; `002` design Q14 and Q46, `043` Q92, its Gate (`044` before the mount switch)
  and its tickets "Account squatting", "Password, MFA and email-change notifications" and
  "DAST probe of the accept route" are the hand-offs (table at the end).

### References and Port

- **The Platform Engineering reports state nothing on password reset, account recovery,
  MFA recovery or enumeration.** The relevance matrix has no row for `044`
  (`docs/references/platform-engineering/README.md:55-71`; the nearest rows are
  `002-auth-and-rbac` at `:58` and `project-wide` at `:71`). What the reports do say is
  general and is cited below as support, not as a source of any recovery rule:
  `idp-reference-architecture-azure.md:182` says security "is always on"
  (secure by default; applying it to recovery is an inference);
  `idp-reference-architecture-azure.md:440-442` says identity management must make actions
  auditable (audit of reset events is an inference from it);
  `building-the-sovereign-idp.md:873-894` lists logging all authentication events and
  short-lived credentials (the report says it; mapping it to a 30-minute reset token is an
  inference); `vulnerability-management-for-platform-engineers-2026-01-30.md:196` says to
  provide "controlled escape hatches with clear audit trails" (the admin MFA reset and the
  break-glass runbook are an inference from it).
- **The requirements come from sources outside the repository**, named as such because
  they were not re-fetched for this design: OWASP/NIST (external, not re-fetched), that is,
  the OWASP Forgot Password and Multifactor Authentication cheat sheets and NIST SP 800-63B
  (memorized secrets, account recovery, look-up secrets, session management); and the VCDM
  Security Self-Assessment skill (`.claude/skills/ssa-validator`). No figure from them is
  cited as fact beyond what each decision says.
- **Port**: its public documentation describes multi-factor authentication only as
  encouraged and delegated to the SSO provider
  (`docs.port.io` security page, "Multi-factor authentication", lines 193-195 of the copy
  fetched on 2026-10-14) and says nothing about a forgot-password flow, a reset token or
  MFA recovery in the pages searched. Absence from the public docs is not evidence that
  Port lacks the feature (ADR-0022), so the statement is "Port's public docs say nothing",
  and `044` has no Port parity target: it is a Tayzu-original design, as the "Divergences
  from Port" section says.

## Goals / Non-Goals

**Goals:**

- A person who forgot their password recovers by mailbox control, without the mailbox
  ever being enough to remove or bypass a second factor.
- The request surface leaks nothing about which addresses have accounts, in status, body,
  headers or time, and a request the controls suppress changes nothing.
- A squatted account and an expired temporary password both have a recovery path, and the
  address owner is told when an account is created for their address.
- A member who lost both factors is recovered by an audited, step-up-gated admin action;
  an admin, an owner, a member of several tenants or a member whose factor a squatter
  enrolled by an out-of-band operator runbook with a named second approver.
- Every new path is the same code path for humans and agents, tenant-isolated, bounded by
  caps, free of tenant text in telemetry, and fails closed.
- No migration, one dependency already in the lockfile, one Cerbos change.

**Non-Goals** (design-level boundaries; the product-level ones are in `proposal.md`):

- No Better Auth reset route is allowlisted, and no `/api/auth` plugin is added.
- No server-rendered page, and no session created by a reset.
- No change to the sign-in, step-up or session policies of `002`, beyond one fence that
  refuses a sign-in a reset overtook (D7).
- No new table or column, and no change to migrations `0012`-`0014`, which stay `045`'s.
- No attempt at constant-work equalization of the request path beyond a minimum response
  duration and a detached send (D4 explains the limit; a ticket tracks the rest).
- No revocation of machine credentials or SSO links by a reset (Q21).

## Decisions

Decisions D1-D20 are this design's. Q1-Q33 at the end are the human's approved
answers (Q1-Q11 on 2026-10-14, Q12-Q31 on 2026-10-15, Q32-Q33 on 2026-10-21); each D names
the Q it implements.

### D1. Tayzu owns both reset routes; Better Auth's stay closed (Q2)

Two plain Fastify routes in `apps/api`, modeled on the accept route, replace Better
Auth's three. Better Auth's remain off the allowlist and keep answering the byte-identical
`404` of any unknown path. The drift test already lists them as blocked
(`auth-route-allowlist.test.ts:60-66`) and asserts it (`:259-261`), so the spec scenario
"Better Auth's own reset routes stay closed" is covered by that test as it stands and this
change does not touch it. The final password write
uses Better Auth's exported password hash function (D7, Q13), so hashing, NFC
normalization, the password policy (`validatePassword`) and the breached-password check
all apply.

- _Why:_ Better Auth's token is stored in clear, travels in a query string and a redirect,
  and its request path times differently for known and unknown addresses and ignores
  caps, `banned`, `credential` accounts and the mount switch (Context). Each is fixable
  with hooks, but the result would be a custom flow inside an `/api/auth/*` surface that
  the mount switch does not cover (`apps/api/CLAUDE.md`: Better Auth routes are always
  mounted).
- _Alternatives:_ **B** Better Auth's routes behind the allowlist plus `sendResetPassword`,
  `onPasswordReset`, `revokeSessionsOnPasswordReset` and hooks: fewer lines, but the token
  weaknesses stay and the routes sit outside the switch. **C** its request route and a
  custom confirm: a mix with the library's token shape. Both rejected by Q2.

### D2. The routes: paths, bodies, answers

| Route                                 | Method | Auth                       | Body                                                                          | Success                            |
| ------------------------------------- | ------ | -------------------------- | ----------------------------------------------------------------------------- | ---------------------------------- |
| `/v1/auth/password-reset/request`     | `POST` | none (public, allowlisted) | `{ "email": string }`                                                         | `200 { "accepted": true }`         |
| `/v1/auth/password-reset/confirm`     | `POST` | token in the body          | `{ "id": string, "token": string, "newPassword": string, "factor"?: { "kind": "totp" \| "backup_code", "code": string } }` | `200 { "completed": true }` |
| `/v1/users/{user}/mfa/reset` (D10)    | `POST` | session, Cerbos, step-up   | `{ "reason": "lost_both_factors" \| "device_replaced" \| "suspected_compromise" \| "identity_verified_request" }` | `200 { "reset": true }` |

- **Registration.** The two public routes are registered in `server.ts` next to the accept
  route, inside the same `if (options.mountIdentityRoutes === true)` block, before the
  `/v1/*` catch-all, and added to `PUBLIC_ROUTE_ALLOWLIST` each with a `reason`
  (Q9). Each route's allowlist entry is added by the task that registers the route (6.1,
  8.3), because the existing allowlist tests fail on a public route with no entry and on an
  entry with no route. With the switch off they do not exist: an unauthenticated call hits
  the catch-all and answers 401 `CATALOG_CONTEXT_REQUIRED`, an authenticated one 404, as
  `043` D15 states. `mount-gate.int.test.ts` and `route-auth-allowlist.int.test.ts` gain the
  routes with the same tasks (6.1, 8.3, 10.5). Neither public route is in an OpenAPI document (like the accept route), which
  is why D17 adds the DAST probe.
- **Order of work, request route:** the per-IP limiter (a `preHandler`, before the
  handler) → CSRF header and `Origin` check → strict parse and limits → canonical address
  → eligibility (D4) → **the mailer's admission** (kill switch, recipient-domain allowlist,
  disabled tenants, then the recipient, IP and global caps, D5) → only for an admitted request, token issue (D3) and the
  detached send → pad the response to the minimum duration (D4) → the uniform answer. A
  request the mailer does not admit issues no token and deletes none (D5, review
  correction C1): the user's earlier link stays valid until it expires.
- **Order of work, confirm route:** limiter → CSRF and `Origin` → strict parse → token
  lookup and constant-time check (D3) → eligibility re-check (D4) → an enrolled user with
  no `factor` in the body gets `AUTH_STEP_UP_REQUIRED` (D6) → password policy and
  breached-password check (D7, Q19) → under the per-user advisory lock, one transaction on
  the lock's own connection: the factor check and its accounting (D6), then the token
  consume and every effect (D7) → notice (D8) → answer.
- **CSRF and `Origin`.** Both routes require `x-csrf-token: orpc` and an `Origin` in
  `ALLOWED_ORIGINS`. This is stricter than the accept route, which reads a session only
  when they are present: these routes never read a session, so a request lacking either
  is always rejected, before any lookup. The confirm route rejects with the uniform `404`
  (reason `csrf_rejected` or `origin_rejected`, internal only); the request route rejects
  with `CATALOG_VALIDATION_FAILED`, which depends on the request's own headers and never on
  an account. `@fastify/cors` answers the preflight for the allowed origins
  (`cors.int.test.ts` is extended).
- **Request-route refusals (Q24).** Malformed, cross-site and over-limit requests answer
  `400` or `429`: those answers depend only on the request, so they are not an oracle. Only
  the account-dependent states are uniform (Q2 is read as "every account- or
  token-dependent refusal"). Rejected: answering everything with the uniform 200, which
  hides client bugs from the page and adds nothing against enumeration.
- **Parsing.** The shared strict parser of `043` (`parse-input.ts`) parses into
  null-prototype objects, rejects `__proto__`, `constructor` and `prototype` at every
  depth, rejects undeclared fields (`redirectTo` and `callbackURL` included) and checks
  lengths before anything else: `email` at most 254 characters and the shape of
  `isValidIdentityEmail`; `id` 22 characters of base64url; `token` 43 characters of
  base64url; `newPassword` at most 512 code units (the policy maximum is 128 code points,
  checked by `validatePassword`); `factor.code` at most 32 characters. The route-level
  `bodyLimit` of the app applies.
- **Answers.** The uniform rejection of the confirm route is `CATALOG_NOT_FOUND`, 404, with
  the text of the catalog's own not-found (the accept route's `AcceptanceNotFoundError`
  precedent). A malformed confirm body, which depends only on the request, answers
  `CATALOG_VALIDATION_FAILED` (400) with the denial reason `malformed_request`, as the accept
  route does (`accept-flow.ts:611-633`); Q24's reading ("only account- or token-dependent
  refusals are uniform") covers it. `AUTH_STEP_UP_REQUIRED` (403) answers a missing, invalid or unsatisfiable
  factor. `CATALOG_VALIDATION_FAILED` (400) answers a policy or breach refusal with only the
  rule name. `AUTH_RATE_LIMITED` (429, `Retry-After`) answers the IP limiter. A breach-service
  outage and a limiter-store failure answer the sanitized `INTERNAL` 500. No new error code
  is introduced.
- **No caching.** Every response of both routes, success or refusal, the limiter's `429` and
  the fail-closed `500` included, carries `Cache-Control: no-store` and `Pragma: no-cache`,
  so a shared cache or a browser never keeps an answer or a body. The app already adds
  `Cache-Control: no-store` to every response that sets none (`server.ts:483-487`); the
  routes add `Pragma: no-cache` through one helper (tasks 6.7, 8.3). `D17`'s probe asserts
  the headers.
- _Alternative:_ one route with a `?mode=` switch, or `GET` for the link. Rejected: a `GET`
  that consumes or reflects a token is prefetchable, and two routes keep the
  enumeration-sensitive one trivially small.

### D3. The token

- **Shape.** `id` = 16 random bytes and `token` = 32 random bytes, both from `randomBytes`
  and base64url (22 and 43 characters). The id is a public lookup handle, the token is the
  secret. 256 bits exceed the at-least-128-bit guidance of the OWASP Forgot Password
  cheat sheet (OWASP/NIST, external, not re-fetched).
- **Storage.** One row of `auth.verification` per token, written by parameterized SQL in
  the auth repository module (`apps/api/src/identity/auth-repository.ts`, Q13):
  `identifier = 'password-reset:' + id`, `value = 'v1:' + digest + ':' + userId + ':' +
  failures` where `digest` is the lowercase hex sha256 of the token and `failures` an
  integer, `expires_at` = issue time + 30 minutes. Only the digest is stored; the token is
  in no column. No new table and no migration (the column types do not change). A
  reset-token module in `packages/auth/src/identity/` mirrors `invitation-token.ts`:
  `generateResetToken`, `digestResetToken`, `verifyResetToken` (a constant-time
  `timingSafeEqual`, and one comparison against a dummy digest when no row matches), plus a
  strict codec for `value` (an unknown version, a malformed value or a `userId` that
  contains `:` is a non-match; Better Auth ids never contain it). The token's API in
  `apps/api/src/identity/reset-token-store.ts` (`issue`, `lookup`, `recordFailure`,
  `consume`) calls that repository section and holds no SQL of its own.
- **Lifetime.** 30 minutes, a constant (Q3, Q23), shown to the user as "30 minutes". Not
  configurable: a configurable lifetime is a knob that can only be set wrong.
- **Newest wins, for an admitted send only.** Issuing runs in one `authPool` transaction
  holding the per-user advisory lock of `user-lock.ts` (`createWithUserLock`): delete the
  user's rows (`identifier like 'password-reset:%' and split_part(value, ':', 3) = $userId`),
  delete expired `password-reset:` rows (opportunistic cleanup, so no janitor is needed),
  insert the new row. Bind parameters only. The route calls `issue` only after the mailer
  admitted the send (D5), so a request that is suppressed by the kill switch, the allowlist,
  the disabled tenants or a cap deletes nothing: an attacker who fills a victim's recipient cap cannot
  evict the link the victim already has. The prefix scan is bounded: a row exists only for
  an admitted send, so live rows never exceed the global cap (600 per hour by default) plus
  the expired rows the next issue purges; if the janitor ticket is ever triggered, an
  index on the user id is the first option.
- **Consumption.** `delete from auth.verification where identifier = $1 returning value`
  inside the completion transaction (D7), on the lock's connection; zero rows is the
  lost-race rejection.
- **Failure budget.** A failed factor (D6) is counted by one atomic conditional statement:
  `update ... set value = <the same value with failures + 1> where identifier = $1 and
  failures < 5 returning failures`, and a following delete removes the row once the count
  reaches 5. There is no read-modify-write and no retry, so concurrent failures cannot lose
  a count. The counter lives in `value`, so no second identifier family is needed.
- **Link.** `<PASSWORD_RESET_LINK_BASE_URL>/reset-password#reset=<id>&token=<token>`: the
  origin comes only from configuration (D9), the path is fixed, id and token are in the
  fragment and so never reach a server or an access log. Built by
  `apps/api/src/identity/password-reset-link.ts`, modeled on `invitation-link.ts`.
- **Identifier families.** This change writes exactly two in `auth.verification`:
  `password-reset:<id>` (short-lived, keyed by a random id, value holds the user id) and
  `mfa-reenrol:<userId>` (D11). `045`'s completeness test must classify both (D18);
  a test in this change (`verification-families.int.test.ts`) enumerates the prefixes the
  code writes so that `045` has the list and an unlisted prefix fails here first.
- _Alternatives:_ **(a)** BA's `reset-password:<token>` with `verification.storeIdentifier`
  hashed by prefix (config only, no migration): rejected with Q2 because the route shape,
  redirect and timing problems remain. **(b)** `password-reset:<userId>` (one row per user,
  newest wins by upsert): rejected because the confirm request has no user id, so the
  lookup would scan `value`. **(c)** an HMAC of the token under `IDENTITY_TOKEN_HMAC_SECRET`
  instead of a bare digest: rejected, a 256-bit random token needs no keyed hash (OWASP,
  NIST), and the secret would couple reset to a key whose rotation invalidates caps.

### D4. Eligibility, uniformity and timing (Q4)

- **Eligibility** (`apps/api/src/identity/recovery-eligibility.ts`, reading only through the
  auth-schema repository module and the `UserSyncAdapter`): the canonical address has a
  Better Auth user; that user has a `credential` account (`globalAccountsOf`); is not banned
  (a new `globalUserBanned` read); and has at least one membership
  (`globalMembershipTenantsOf`) whose `_user` status (`userSync.readStatus({ tenantId,
  email })`) is not `Disabled`. A membership with no `_user` row does not count. The tenants
  come from the user's memberships, never from the request (root `CLAUDE.md`, host-supplied
  context). The result is an internal enum used only for signals and the decision to admit
  and issue: `eligible | unknown_address | no_credential_account | banned |
  disabled_everywhere | no_membership`. A user linked to Visma Connect who also has a local
  password is eligible (Q22): the reset restores the password sign-in that `002` D23 already
  allows them.
- **Uniform answer.** The request route always answers `200 { "accepted": true }` for a
  well-formed, same-site, within-limit request; the confirm route's token- and
  account-dependent rejections are all the one `404`. The internal reason goes to
  `catalog.security.recovery_email_suppressed` (request) or
  `catalog.security.password_reset_denied` (confirm), never to the caller.
- **Detached send.** After the mailer admitted the request and the token row committed, the
  send is started detached (D5): the handler does not await it, and a rejection is swallowed
  and counted. The mailer tracks in-flight sends and `app.close` drains them, so a graceful
  shutdown does not drop mail. A failure of the token store after admission is logged
  (reason `token_issue_failure`) and answered with the uniform `200`, like a provider
  failure, so an outage is not an oracle.
- **Padding.** The handler computes its answer, then waits until `PASSWORD_RESET_MIN_RESPONSE_MS`
  (default 400, D9) have elapsed since it started (`performance.now()`, a timer, no
  busy-wait) before replying, for every branch. A branch that exceeds the minimum (a slow
  database) is not padded, which is the limit of this control and is recorded as a Risk. A
  test with a fake clock and a 2-second sender proves the response neither waits for the
  sender nor returns early.
- _Alternatives:_ **constant-work path** (do the same inserts and reads for an unknown
  address against a decoy): rejected as more code than the gain, since the padding already
  hides differences smaller than the minimum; a ticket records it. **Queue the send in
  BullMQ**: rejected, no worker exists in this change's scope and a detached promise is the
  smallest thing that removes the send from the response time. **Await the send and pad
  to its worst case**: rejected, a provider timeout would be user-visible latency.

### D5. The email path of an anonymous reset (Q8, Q20, Q32)

A new `apps/api/src/identity/recovery-mailer.ts` is the single place a 044 email is sent.
It is built in `createApp` next to the gate and the dispatcher, over the same
`EmailSender` (so the recipient-domain allowlist wrapper and `EMAIL_PROVIDER` apply to it
unchanged), the same `EmailCapStore` (one DB-backed store shared across replicas) and the
same HMAC key.

- **Admission before issue.** The reset email has two steps. `admitResetEmail({ address,
  userId, tenantIds, ipKey })` runs the controls in this order and returns `{ admitted:
  false }` (after logging the suppression once) or `{ admitted: true, send(link) }`:
  kill switch (`INVITATION_EMAIL_KILL_SWITCH`) → recipient-domain allowlist (a pure check of
  the address's domain against `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, the same
  `isRecipientDomainAllowed` function the sender wrapper uses, so a refused domain changes no
  token) → every tenant of the user is on `EMAIL_DISABLED_TENANT_IDS` (suppressed; the list is
  read from the same configuration as `043`'s) → recipient cap (HMAC of the canonical address,
  `recipient-key.ts`) → IP cap (the normalized key of D16) → global cap. The three
  counters run narrowest first, so a request refused by a narrower control consumes none of the
  wider buckets: the 600-per-hour global bucket can be spent only by requests that already
  passed the recipient and the IP caps, which makes it dearer to exhaust than if it came first
  (the cost is that a request refused by the global cap has already spent one
  recipient and one IP unit, which it would not have been mailed anyway). The allowlist
  refusal is logged as `recovery_email_suppressed` (`recipient_domain_blocked`) and, because
  `043`'s alerts key on it, also as the existing `catalog.security.email_recipient_blocked`
  with the template. Only an admitted request reaches the token store
  (D3); `send(link)` then starts the detached send. Every refusal returns normally; none
  throws; each is logged once as `catalog.security.recovery_email_suppressed` with the
  template and a closed reason, and the user id when there is one. **A refused request
  changes no token**: the controls run before the issue transaction, so the earlier link
  the user already holds stays valid until it expires (review correction C1: issuing first let
  anyone who knows an address evict the victim's mailed link). The buckets are
  consumed at admission even if the token store then fails.
- **What a failed send leaves.** A provider failure happens after the token was issued: the
  new token exists and is unmailed, and the earlier one is already deleted. The mailer logs
  it as `provider_failure`. The user requests again; this is the only case where a request
  can leave a user with no mailed link, and it needs a provider fault, not an attacker
  action. The allowlist is no longer such a case: it is decided at admission, so a
  recipient domain off the list can no longer evict a link; the sender wrapper
  stays as the second line and, if it ever refuses at send time, the case is this one.
- **Caps.** Own scopes in the closed `RateLimitScope` union and own rows in the cap store's
  `BUCKETS` table: `reset_email_recipient` (kind `email`), `reset_email_ip` (kind `ip`),
  `reset_email_global` (a new kind `global`, one constant key), `recovery_notice_recipient`
  (kind `email`) for every notice, and, for the account-created notice only (Q20),
  `account_created_notice_tenant` (kind `tenant`) and `account_created_notice_global` (kind
  `global`). The route limiters of D2 have their own scopes, `password_reset_request` and
  `password_reset_confirm` (kind `ip`). Recipient and IP caps are consumed only for an
  eligible account, so random addresses do not allocate bucket rows beyond the route
  limiter's per-IP row.
- **Fixed windows for the two global caps (Q32).** `reset_email_global` and
  `account_created_notice_global` each have one key for the whole platform, so `002`'s window
  semantics (a bucket resets only after a full window with no allowed request, `043` Q66)
  would turn steady legitimate traffic at the cap into a platform-wide stop for a whole idle
  window. For these two buckets only, the DB cap store (`apps/api/src/identity/email-cap-store.ts`)
  appends the index of the current fixed window to the bucket value, `<key>:<floor(now /
  window)>`, using the window of the configured cap (passed by `createApp`; the clock is
  injectable for tests), so each window starts a new row at zero and the cap means N per
  fixed window. Every other bucket keeps `002`'s semantics. No migration: the row of a past
  window is an ordinary expired `auth.rate_limit` row, covered by the pruning item of D16.
  Telemetry is unchanged.
- **Notices** (D8) go through the same mailer: kill switch → all tenants disabled →
  `recovery_notice_recipient` cap → send. The account-created notice, which a tenant admin
  aims at an address of the admin's choosing, adds two caps in front of the recipient cap
  (Q20): the per-tenant cap of the creating tenant (20 per day by default) and a global
  cap (1000 per day by default). Notices never throw into the operation that triggered
  them.
- **Why not `EmailTenantGate.admit`:** it requires a tenant and throws on a cap hit (Context);
  reusing it with a synthetic tenant would make a 429 an oracle (Q8's rejected option). Why
  not extend the notice dispatcher: it is typed to one admin-notice template and a tenant list.
  The mailer reuses their parts (store, key, sender, switch, list), not their
  signatures.
- **The operator CLI does not use the mailer** (D12): it holds no cap store and sends its one
  notice through the sender, the kill switch and the disabled-tenant list, behind the
  `RecoveryNoticePort` that the shared MFA-reset service takes (tasks 10.3, 11.2).
- **No tracking, no Reply-To, one link.** The ACS adapter already disables tracking and sets no
  Reply-To for every template (`azure-communication-email.ts`); the reset email has one
  link, the notices none.
- **Configuration** is D9.

### D6. Confirmation for a user with a second factor (Q1, Q18, Q19, Q33)

**What "enrolled" means, failing closed.** The confirm route reads the user's state through
the auth repository module (`globalTwoFactorStateOf(userId)`: `user.two_factor_enabled` and
the user's `two_factor` rows with `verified`, `failed_verification_count`, `locked_until`).

| State | Meaning | Answer |
| ----- | ------- | ------ |
| `two_factor_enabled` is true **and** a row with `verified` not false | enrolled, consistent | the factor is required |
| `two_factor_enabled` is true **or** a row with `verified` not false, but not both | enrolled, inconsistent (a flag with no verified row, or a verified row with the flag off: a partial write, a crash, a row older than the `verified` column) | `AUTH_STEP_UP_REQUIRED` that no factor can satisfy, nothing consumed or counted, internal reason `factor_state_inconsistent`; the admin MFA reset or the operator CLI repairs it (D10, D12) |
| flag not true and no row, or only a row with `verified` false | not enrolled (an enrolment still in progress counts as not enrolled) | the link is enough |

The inconsistent row exists so that no partial state turns "enrolled" into "not enrolled":
the check fails toward the stricter side (the draft used AND, so an inconsistent state would
have let the link alone change a password).

- **No factor enrolled:** the link is enough (Q1).
- **The predicate is evaluated twice, and the second decides.** The read before the lock
  (D2) is a fast fail only. Inside the lock, on the lock's connection, the predicate is
  evaluated again (D7 step 3), so a factor enrolled between the two reads is not bypassed by
  a confirm that carried no factor: it answers `AUTH_STEP_UP_REQUIRED` and consumes nothing.
- **Enrolled and no `factor` in the body:** answer `AUTH_STEP_UP_REQUIRED` (403), change
  nothing, do not consume the token, do not count a failure. This discloses "this account
  has a second factor" only to a holder of a valid token, who is entitled to it. It runs
  before the password policy and breach check, which need not run for a request that cannot
  complete.
- **Enrolled and a `factor`:** the check runs inside the lock section of D7, after the
  password policy and the breach check (Q19), so a policy, breach or race failure never
  burns a backup code.
  - `totp`: the verifier decrypts `secret` with Better Auth's `symmetricDecrypt` and the
    instance's `secretConfig` (`(await auth.$context).secretConfig`, passed in by the route)
    and verifies with `createOTP(secret, { period: 30, digits: 6 }).verify(code)` from
    `@better-auth/utils/otp`, the calls the installed plugin makes in
    `dist/plugins/two-factor/totp/index.mjs:188`. `@better-auth/utils@0.4.2` is already in the
    lockfile as Better Auth's own dependency; this design names it and adds it as a direct
    dependency of `@tayzu/auth` at that exact version (task 1.2, Q18), the one dependency of
    the change.
  - `backup_code`: the verifier decrypts with `symmetricDecrypt` from `better-auth/crypto` and a
    guarded JSON parse, which is what Better Auth's `getBackupCodes` does for the plugin's
    default `storeBackupCodes: "encrypted"` (`getBackupCodes` is declared but not exported at
    runtime in 1.7.6, Q33), compares each
    stored code with `timingSafeEqual` (the plugin's `verifyBackupCode` uses `includes`, not
    constant time) and, on a match, returns the re-encrypted remaining codes. The spend is a
    compare-and-swap `update` of `backup_codes` **inside the completion transaction** (D7), so a
    double spend is impossible and a refused password or a lost race leaves the code intact
    (Q19).
- **Where the verifier lives.** One place each: the pure verifier (decrypt, compare, OTP, new
  encrypted code list; no database) is `packages/auth/src/identity/reset-factor.ts`;
  `packages/auth` cannot import `apps/api`, so every read and write of `two_factor` and
  `user` is a function of the auth repository module in `apps/api` (`globalTwoFactorStateOf`,
  the atomic failure counter, the backup-code CAS; task 8.2). The route passes
  `secretConfig` and the repository rows to the verifier.
- **Serialization and accounting (no parallel guessing).** The lock check, the verification
  and the failure accounting of one user are never interleaved with another confirm of the
  same user: they run under the same per-user advisory lock as the completion (D7). Each
  count is also a single atomic statement, so the budget holds even without the lock:
  - the account counter is `update auth.two_factor set failed_verification_count =
    coalesce(failed_verification_count, 0) + 1 where id = $1 returning ...`, followed by
    setting `locked_until` (900 seconds) once the count reaches 10, the plugin's defaults
    (`verify-two-factor.mjs:130-181`); an expired lock is cleared lazily first, as the plugin
    does;
  - the token budget is the single conditional update of D3 (5 failures).
  A locked account (`locked_until` in the future) is not verified: the request answers
  `AUTH_STEP_UP_REQUIRED` and counts one failure against the token only. A success resets the
  account counter inside the completion transaction. An invalid or missing factor always
  answers the same `AUTH_STEP_UP_REQUIRED`. The test "many parallel wrong factors consume
  exactly the budget" (task 8.7) fails if any gap between check and count returns.
- **Interplay with sign-in, accepted.** The account counter is the one sign-in uses, so
  someone who holds a valid token (a mailbox compromise) can fail enough guesses, with up to
  five emails an hour, to lock the owner's TOTP sign-in for 15 minutes at a time. It needs the
  mailbox; it is recorded in Risks and alertable through `attempts_exhausted` (Gate 6).
- **TOTP replay inside the window, a recorded residual.** The verifier does not record the
  last accepted time step, so a code observed in real time can be replayed once within its
  validity window. Better Auth's own sign-in verification has the same property, a third
  identifier family or a column would be needed to close it for both paths, and the replay
  needs the attacker to hold the user's valid reset token as well. It is recorded as a ticket
  for both paths together (Tickets), not built here.
- **Drift guard.** A test drives the installed `/two-factor/verify-totp` endpoint and the
  new verifier with the same secret and codes (current, previous and next window, wrong) and
  fails when they disagree, so a Better Auth upgrade cannot silently change one side.
- _Alternatives:_ **(a)** drive Better Auth's verify endpoints in process: they need a
  session or a signed pending-sign-in cookie, so the reset would have to forge a challenge.
  **(b)** a separate `verify-factor` route before confirm: a second public surface that
  reveals "this token is valid" separately. **(c)** a hand-written RFC 6238 HMAC-SHA1 with
  `node:crypto`: rejected (Q18), custom crypto beside a vetted implementation already
  installed. **(d)** backup codes only at confirm: rejected (Q18). **(e)** require the factor
  for every user (including unenrolled): meaningless.

### D7. The completed reset: policy, hash, one transaction (Q5, Q13, Q19)

Before taking any lock or consuming anything, in this order: `validatePassword` (NFC,
length, classes, denylist; refusal names only the rule), then `isPasswordCompromised` from
Better Auth's `haveibeenpwned` module (k-anonymity; a failure to reach the service answers
the sanitized 500 and consumes nothing). Both run before the transaction and before any
factor is checked or spent, so a refusal never burns the token or a backup code (Better
Auth's own route burns the token first, Context). The new requirement extends the
"Password policy" requirement of `identity-lifecycle-and-org-admin` (`043` task 8.1): the reset is one more
entry point of it, and the breach check sees the NFC form.

**One transaction, written as SQL (Q13).** Better Auth's adapter is not transactional here
(Context), and `internalAdapter` would take a second pooled connection while the lock is
held (the hazard `043` removed in Q147/Q148). So the completion is parameterized SQL of the
auth repository module, run on the connection that holds the per-user lock
(`createWithUserLock(authPool)`, `user-lock.ts`); no other pooled connection is taken while
it is held. Q2's "through Better Auth's internal adapter" is read as "with Better Auth's hash
function, NFC normalization and schema" (Q13).

Inside the lock, in this order (any thrown error rolls the whole transaction back):

1. re-read the token row by id (found, the digest unchanged, `failures` below 5); anything
   else is the uniform rejection (`consume_conflict` or `not_found`);
2. re-read `banned` and the `credential` account of the user; a banned or credential-less
   user is `not_eligible` (the eligibility check before the lock can be overtaken by a ban);
3. evaluate the enrolled predicate of D6 again; if the user is enrolled and the body has no
   factor, answer `AUTH_STEP_UP_REQUIRED` with nothing consumed; if the user is enrolled and
   there is a factor, check it with its accounting (D6). A failure writes its counters,
   commits those writes only, and answers `AUTH_STEP_UP_REQUIRED`; nothing below runs.

Steps 1-3 and every write below run on the connection the lock holds: each repository
function takes an optional `db` (the lock's client), as `markInvitationAccepted(..., db?)`
does (`auth-repository.ts:93-97`, `:329`), and a test with a pool of one connection proves
that no second pooled connection is taken (tasks 2.4, 5.1, 8.2, 8.7, 8.10).
4. hash the password with the exported function that `emailAndPassword.password.hash`
   uses (`auth.ts:960`: NFC, then `hashPassword`; exported as one symbol, task 1.5, so the
   config and the reset cannot diverge). The `haveIBeenPwned` wrapper around
   `context.password.hash` is deliberately not used: it keys on the endpoint path and would
   throw outside an endpoint, and the check already ran explicitly. A test proves the stored
   hash verifies through a real `/sign-in/email`;
5. consume the token (`delete ... returning`); zero rows aborts as `consume_conflict`;
6. update the `credential` row of `auth.account` (`password`, `updated_at`); exactly one row
   must change, else abort;
7. delete the user's other `password-reset:` rows;
8. delete `temp-password:<userId>` by its identifier (the marker `/change-password` deletes in
   `hooks.after`; its `value` is an ISO expiry, `temporary-password.ts:121`, so a value match
   cannot find it), and delete the user's pending two-factor challenge rows (`2fa-<random>`) and
   `trust-device-*` rows by `value` = user id (the installed plugin stores the user id as the
   value of both: `better-auth/dist/plugins/two-factor/index.mjs:294-298` and
   `verify-two-factor.mjs:49-56`), so a challenge opened before the commit cannot finish a
   sign-in after it. The sibling `2fa-attempts-2fa-<random>` rows hold the value `0`
   (`index.mjs:299-303`), are not matched and expire with their challenge (10 minutes,
   `index.mjs:290`); the test expects them to remain. `mfa-reenrol:<userId>` is **not**
   deleted: a reset does not give back a factor that was reset;
9. set `emailVerified` to true on `auth.user`;
10. if a backup code was used, the compare-and-swap spend of D6; a lost swap (a sign-in spent
    the same code at the same moment) aborts and answers `AUTH_STEP_UP_REQUIRED`;
11. reset the account's failure counter if a factor was checked;
12. delete every session of the user in every tenant with `returning`, so the events know how
    many and in which tenant. A session's `active_organization_id` is nullable
    (`persistence/schema.ts:92`), so a returned row may have no tenant, and
    `emitSessionRevoked` takes an optional tenant (`auth.ts:391-402`): the event then omits
    `tayzu.tenant.id`.

If any step throws, the transaction rolls back: the old password signs in, the sessions
live and the token is intact (spec scenario "A failed write leaves everything as it was").
After the commit: emit `auth.security.session_revoked` (reason `password_reset`) once per
returned session row, `catalog.audit.password_reset_completed`, record the metric, and send
the password-changed notice (D8). The route does not create a session or set a cookie. Banned
and `Disabled` states are not written by the write path, which is how "a reset never clears
`banned` and never re-enables a `_user`" holds by construction.

**Persistence after a reset (Q21).** Machine credentials (`apikey` rows, service accounts) and
SSO links are not touched: a service account is tenant property, and unlinking an identity
provider is a decision for the organization. The fixed password-changed notice therefore
says, as fixed text, to review service accounts, credentials and linked sign-ins. Two
tickets record the follow-ups (admin rotation from `043`'s viewer, and an audit count of the
user's SSO links and credentials). Rejected: unlinking SSO identities, and revoking
credentials, which would silently break automation.

**A sign-in that the reset overtook is refused (state: refused).** The session deletion is
inside the transaction, but a sign-in that verified the old password just before the commit
could insert its session just after it. Two controls close that, and one residual remains:

- `hooks.before` on `/sign-in/email` reads the credential account's stored hash for the
  address in one lookup that runs the same way for a known and an unknown address (an unknown
  address finds no row; there is no branch on existence), and keeps it in a request-scoped
  `WeakMap`, like `activeOrganizationBeforeAttempt` (`auth.ts:265`), so the fence adds no
  difference to the status, code or body shape that `002`'s enumeration requirement fixes
  (task 8.13 tests it); `hooks.after`, after a successful sign-in, reads it again and, if it
  changed, deletes the new session, clears the new-session slot and the cookie and answers
  the same wrong-password response the expired-temporary-password branch gives
  (`auth.ts:1394`). A hash cannot change by a clock, so the comparison needs no clock
  tolerance. This covers password-only users and the first step of an enrolled user's
  sign-in (the two-factor plugin's challenge is created after our hook);
- the reset deletes the user's pending `2fa-` challenge rows (step 8), so an enrolled user's
  challenge opened before the commit cannot complete after it.
- **Residual:** a two-factor verification that had already consumed its challenge and is
  between that read and its session insert when the reset commits can still create one
  session. The window is a single request, it needs the old password and a valid factor, and
  the owner has just been mailed the password-changed notice. Recorded in Risks.

- _Alternative:_ call Better Auth's `resetPassword` in process after verifying the token:
  rejected, it expects its own `reset-password:<token>` row and consumes before hashing.
  _Alternatives to the SQL transaction (rejected by Q13):_ `transaction: true` for the whole
  Better Auth instance (changes every Better Auth flow), and non-atomic writes with
  compensation.
- **Reset for a tenant pending deletion (`045`).** A reset needs only mailbox control and an
  eligible account; `045`'s tenant closure blocks sessions and routes of that tenant and is
  unaffected. A user whose only tenant is pending deletion has a `_user` that `045` handles;
  if `045` marks it `Disabled` the user is ineligible by D4, otherwise the reset is
  harmless.

### D8. The notices (Q7, Q16, Q20, Q21, Q30)

Five new members join the closed `EmailTemplate` union
(`packages/auth/src/identity/email/sender.ts`), each with a renderer in
`packages/auth/src/identity/email/`, an entry in `TEMPLATE_NAMES` of `email-allowlist.ts`
and `email-tenant-gate.ts` (the compiler forces both), the ACS adapter's `switch`, and a
value in the `tayzu.identity.email.template` set (D15). `045` adds `OrgDeletionNotice` to
the same union after this change merges and rebases (D18).

| Template (`kind`)       | Name              | Interpolated values   | Link | Sent when                                                                                         |
| ----------------------- | ----------------- | --------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `PasswordResetEmail`    | `password_reset`  | link, expiry text     | 1    | an admitted request (D5)                                                                          |
| `PasswordChangedNotice` | `password_changed`| none                  | 0    | a completed reset, and a successful `/change-password`; its fixed text tells the user to review their service accounts, credentials and linked sign-ins (Q21) |
| `MfaChangedNotice`      | `mfa_changed`     | none                  | 0    | a TOTP factor becomes verified for a session user, or backup codes are regenerated                |
| `MfaResetNotice`        | `mfa_reset`       | none                  | 0    | an admin or operator MFA reset (D10, D12): tells the user to sign in and enrol again, and, as fixed text, to review their service accounts, credentials and linked sign-ins (Q30) |
| `AccountCreatedNotice`  | `account_created` | none                  | 0    | `identity.users.create` committed: "an account was created for this address"; no link; says to use the forgot-password page if the person does not expect it, and to contact the platform operator if a reset asks for a code they never set up (Q16) |

Fixed subject and body per template, no tenant, actor or organization text, one recipient,
no attachment, plain address validated by the sender port. A notice is addressed to the
user's canonical address read from the auth-schema repository module (never from request
input) and goes through the mailer (D5), except the operator CLI's (D12).

- **Hook points.** `@tayzu/auth` has the `EmailSender` port but not the caps, so
  `CreateAuthOptions` gains an `accountNotices?: AccountNoticePort` (`notify(kind, { userId
  })`, never throws, structural like `UserSyncPort`). `hooks.after` calls it for
  `/change-password` success (next to the existing marker delete and `session_revoked`
  emit), for `/two-factor/verify-totp` when a session exists and `hooks.before` recorded
  `twoFactorEnabled` as not true (enrolment, not the sign-in challenge, which has no
  session), and for `/two-factor/generate-backup-codes`. The reset confirm route calls the mailer directly. The MFA reset service takes a
  `RecoveryNoticePort.send(kind, userId)`, implemented by the mailer's notice path for the admin
  form and by an adapter over the sender, the kill switch and the disabled-tenant list for the CLI (D12). `identity.users.create` receives the mailer through
  `CreateIdentityRouterOptions.recoveryMailer` and notifies after its `addMember` succeeds
  and before it returns; a failure or suppression of the notice never fails the creation.
- **The squatter-enrolled factor (Q16).** `identity.users.create` hands a temporary password
  to the admin, so an admin who creates an account for someone else's address could sign in,
  change the password and enrol a TOTP factor first. The rightful owner's reset would then
  ask for a code they never set up. 043's creation is not changed (an "unclaimed" marker that
  ignores the factor was rejected, Q16). The owner is told by the account-created notice's
  fixed text to contact the platform operator, and the operator CLI (D12) accepts any
  member as a target. The residual risk is in Risks.
- **Not built:** the email-change notice (no email-change path exists; ticket), a notice on
  backup-code use (ticket), a notice on unusual sign-in locations (ticket), and `043`'s SSO
  link, unlink, shed and status notices (they stay in `043`'s "User notifications" ticket).
- _Alternatives:_ **all notices** and **only the reset ones** were rejected by Q7.

### D9. Configuration

Parsed in `apps/api/src/config.ts` with the existing helpers; values are never echoed in an
error; `NODE_ENV !== 'test'` is production, as in `002` and `043`. The defaults are Q23's:
they stand as drafted, with no configuration for the 30 minutes or the budget of 5.

| Variable                                                                        | Default            | Rule |
| ------------------------------------------------------------------------------- | ------------------ | ---- |
| `PASSWORD_RESET_LINK_BASE_URL`                                                  | none               | Parsed like `loadInvitationLinkBaseUrl`: required outside test; `https`; one of `ALLOWED_ORIGINS`; in test optional and `http` or `https`. The path (`/reset-password`) is fixed in code. |
| `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                      | 10 per 60 s per IP | `limitWithDefaults` (the accept route's `DEFAULT_PUBLIC_ROUTE_LIMIT`); a non-integer or zero value fails startup. The IP is the normalized key of D16. |
| `PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                      | 10 per 60 s per IP | the same |
| `PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                    | 5 per 3600 s       | per recipient (HMAC key); the shared bucket semantics apply (a bucket resets only after a full window with no allowed request) |
| `PASSWORD_RESET_IP_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                           | 10 per 3600 s      | emails per normalized IP |
| `PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                       | 600 per 3600 s     | emails across the platform |
| `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                   | 10 per 86 400 s    | per recipient, all five notices, apart from the other buckets |
| `ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`               | 20 per 86 400 s    | account-created notices per creating tenant (Q20) |
| `ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`               | 1000 per 86 400 s  | account-created notices across the platform (Q20; the default 1000 is confirmed by Q28) |
| `PASSWORD_RESET_MIN_RESPONSE_MS`                                                | 400                | a positive integer between 1 and 5000, else startup fails |

Every limit is parsed like the other caps: a missing value takes the default, a non-integer,
zero or negative value fails startup.

Shared and unchanged: `MOUNT_IDENTITY_ROUTES`, `INVITATION_EMAIL_KILL_SWITCH` (its name
says "invitation" but it stops every email; renaming is a breaking change, so a ticket
records it and `secrets.md` says so), `EMAIL_PROVIDER`, `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`,
`EMAIL_DISABLED_TENANT_IDS`, `IDENTITY_TOKEN_HMAC_SECRET`, `ALLOWED_ORIGINS`. No new secret
exists: the recipient key reuses `IDENTITY_TOKEN_HMAC_SECRET`.

**There is no `TRUST_PROXY` variable.** The trust setting is the fixed list in `server.ts:445`
(`['loopback', 'linklocal', 'uniquelocal']`); making it configurable and verifying it against
the Container Apps ingress peer range is a pending first-deployment gate (`002` Q58,
`attack-surfaces.md:77` and `:365`). Every per-IP control here (the route limiters and the
`reset_email_ip` cap) is only as trustworthy as that gate (Gates).

**Startup failure rules.** `createApp` throws (naming the variable only) when
`mountIdentityRoutes` is on and any of these is missing: the recipient key secret
(existing rule), `PASSWORD_RESET_LINK_BASE_URL`, an email sender. `createAppFromEnv` passes
every value above to `createApp`, and `createApp` applies the same defaults when an option
is omitted, so no limiter or cap is ever off (the Q140 lesson of `043`). The DAST script's
environment gains the new variables where `dast.sh` sets them. `docs/security/secrets.md`
lists them, and lists the operator CLI's own variable set (D12).

### D10. The admin MFA reset (Q6, Q12, Q15, Q28, Q30)

`identity.users.resetMfa`, a branded procedure of the identity router built with
`defineIdentityOperation({ authorization: { kind: RESOURCE_KINDS.user, action: 'resetMfa',
resolveTarget }, route, handler })`, `POST /v1/users/{user}/mfa/reset`, `x-tayzu-risk:
high`, `inputStructure: 'detailed'`, behind the mount switch and listed in
`openapi/identity.openapi.json` (regenerated by `contract:generate`, drift-checked by
`contract:check`). `{user}` is the `_user` identifier, resolved on the server to the Better
Auth user (`043` D14); the exported path is the route template (`043` D16 adds this
template to its list). The body is `{ reason }`, a **mandatory reason code from a closed
enum** (`lost_both_factors`, `device_replaced`, `suspected_compromise`,
`identity_verified_request`; the four values are confirmed by Q28), recorded by the audit event
(Q15).

- **Targets: members only (Q15).** A tenant admin may reset the factor of a **member** of
  the tenant. Another admin, or an owner, can be reset only by the operator CLI with a named
  approver (D12). A second-approver flow for admin-initiated resets stays a ticket. Rejected:
  members and admins but not owners; anyone in the tenant (one compromised admin could strip
  every other admin's factor).
- **Authorization** (the wrapper's four steps, unchanged): the caller-tenant role check
  first; then the input is parsed and the target resolved on the server; then Cerbos with
  the target's real tenant; then the handler. A target not in the caller's tenant, or not
  existing, is `CATALOG_NOT_FOUND`, identical (`043` D14). Machine `member` tokens are
  refused at step 1. For a human, step-up runs before the role check (`043` Q147, O-3), so a
  non-admin human without a fresh verification sees `AUTH_STEP_UP_REQUIRED` first; the
  spec's "member cannot reset" scenario is stated with a fresh verification.
- **Cerbos (Checkpoint 3, task 10.1).** The resource kind is the existing `user`; the action
  is `resetMfa`. What exists today is not a new grant but a hardening of an existing one: the
  `user` policy already allows `'*'` to a same-tenant `admin`
  (`policies/resource_policies/user.yaml`), and its only self-target deny is the
  `updateStatus` rule (`R.id == P.id`). The change adds, for `resetMfa`: (1) the self-target
  deny, by adding the action to that rule; (2) a deny when the target is not a plain member:
  the wrapper supplies the target's tenant role as a new resource attribute `memberRole`
  (the raw role string, from `memberOf` in the target resolver, task 10.2), and the rule
  denies `resetMfa` unless `R.attr.memberRole == "member"`. Two goals meet in that one rule:
  it must fail closed when the attribute is absent on a target check, and it must leave the
  wrapper's targetless caller check alone. That check is the first step of every operation:
  it names the resource id `new` and carries no `memberRole` (`define-operation.ts:174`,
  `identity-attributes.ts:56-59`), so a rule that denied on an absent attribute alone would
  deny every admin at step 1 and make the operation unusable. The rule therefore reads
  `R.id != "new" && (!has(R.attr.memberRole) || R.attr.memberRole != "member")`, or the
  equivalent the policy-writer proves, and the roles are comma-separated strings
  (`context-resolver.ts:318`), so a composite `admin,owner` or `member,admin` is not equal to
  `member` and is denied (a generated user id is never `new`); and (3) test cases in
  `policies/resource_policies/user_test.yaml`: a same-tenant admin on a member allowed; a
  member denied; an admin of another tenant denied (cross-tenant deny); an admin on
  themselves denied; an admin on another admin denied; an admin on an owner denied; an admin on
  resource id `new` allowed and a member on `new` denied (the targetless caller check); a
  target whose role is `admin,owner` denied, one whose role is `member,admin` denied, and a
  target with no `memberRole` denied.
  **This is a Cerbos policy change and a Checkpoint 3 stop** (task 10.1, `policy-writer`,
  `pnpm policy:compile`, presented in chat with its compile output, approved separately
  before tasks 10.2 onward). The wrapper's self-target signal (`STATUS_ACTION`,
  `define-operation.ts:37`, used at `:228`) becomes a set of two actions so a self-target
  `resetMfa` denial logs `catalog.security.self_mfa_reset_denied`.
- **The service checks too (defence in depth).** `apps/api/src/identity/mfa-reset.ts` repeats
  the self-target, target-role and multi-tenant checks on the admin path, so the protections
  hold whatever the deploy order of the policy bundle (Migration Plan).
- **One refusal path (Q12).** On the admin path the service reads, unconditionally and in a
  fixed order, every predicate: the target has no enrolled factor (the OR predicate of D6, so
  an inconsistent state can be repaired), the target has a membership outside the caller's
  tenant, the target's role is not `member`, the target is the actor. It then calls one
  `refuse(internalReason)` if any holds. All refusals are the same `CATALOG_VALIDATION_FAILED`
  with the same status, code, message and body shape, and nothing depends on which predicate
  failed: the reads do not short-circuit, so neither the ordering nor the time separates
  them. The internal reason goes only to the log: `catalog.security.identity_conflict_refused`
  with `target_in_other_tenant`, `target_is_admin_or_owner` or the new `no_enrolled_factor`, or
  `catalog.security.self_mfa_reset_denied` for the actor. (When Cerbos is deployed it denies
  the self, admin and owner cases earlier with `AUTH_FORBIDDEN`, which reveals nothing the
  caller does not know: their own id, and the roles of their own tenant. So the answer code of
  those three cases is `AUTH_FORBIDDEN` with the bundle deployed and `CATALOG_VALIDATION_FAILED`
  without it, and the "same body" rule above covers the service-level predicates: no factor,
  other tenant, role and self; the spec and tasks 10.4 and 10.6 state both codes.) An admin therefore never
  learns that a member also belongs to another organization. **The multi-tenant refusal
  belongs to the admin path only** (Q12): the operator CLI recovers such users. Rejected: a
  global effect from one tenant's admin; requiring approval from the other tenants.
- **Effects, in one `authPool` transaction under the per-user lock, on the lock's
  connection:** delete the user's `two_factor` rows; set `two_factor_enabled` false; write
  `mfa-reenrol:<userId>` (D11); delete the user's sessions with `returning` and emit
  `auth.security.session_revoked` with the new reason `mfa_reset` once per returned row; delete
  the user's `2fa-` challenge rows and `trust-device-*` rows (value = user id; the sign-in
  flow already refuses `trustDevice`, `auth.ts:1299-1302`, so the second kind should not exist).
  It leaves the user's `password-reset:` rows alone: the operator runbook of D12 relies on a
  link requested before the run still working after it.
  After the commit: `MfaResetNotice` to the target (D8), `catalog.audit.mfa_reset` (form
  `admin`, with the reason code), the metric. Machine credentials, service accounts and SSO
  links of the target are left untouched, as for a password reset (Q21, Q30, including when the
  reason is `suspected_compromise`); the fixed notice tells the target to review them, and the
  two tickets of Q21 cover the MFA reset too.
- **Self-service stays as `002` shipped it.** The target recovers with the password and the
  enrolment of D11. The admin never sees a secret, a code or a password.
- _Alternatives:_ **email-only MFA reset** (a mailbox would defeat MFA), **backup codes
  only**, and **splitting MFA recovery into its own change** were rejected by Q6. A **new
  resource kind** (`mfa`) was rejected: `user` already carries the tenant, ownership and
  self-target attributes, and a new kind is a larger Cerbos change for no gain.

### D11. Forced re-enrolment after an MFA reset (Q6, Q17)

"Forces re-enrolment at the next sign-in" needs a mechanism, because a member with no
enrolled factor signs in with the password alone (`auth-and-rbac`, "Multi-factor
authentication"). The mechanism mirrors the temporary-password marker (Q17):

- `mfa-reenrol:<userId>` in `auth.verification`, value a constant, `expires_at` the same
  far-future sentinel the SSO-link and temporary-password markers use (`043` Q142; `9999-12-31`,
  `temporary-password.ts:96`), so Better Auth's opportunistic cleanup of expired rows keeps
  it. It has **one writer**: `writeMfaReenrolMarker(userId, db?)` in the auth repository module
  (SQL on the lock's connection), called by the shared MFA reset service for both the admin
  form and the operator CLI, which hold no Better Auth instance (D12). `@tayzu/auth` owns
  only the constants (identifier, value, the sentinel exported from `temporary-password.ts`)
  and the adapter-based reader and clearer its hooks use (task 9.1). It is cleared on
  enrolment. It is an
  identifier family that `045`'s completeness test must classify (D18).
- `hooks.before`: a session whose user holds the marker may reach only
  `/two-factor/enable`, `/two-factor/verify-totp`, `/get-session` and `/sign-out`; anything
  else answers like the temporary-password gate (a fixed refusal code). A failed lookup
  refuses (fail closed), as the temporary-password branch does.
- `context-resolver.ts`: a held marker rejects like a missing context on `/v1`, exactly as
  the temporary-password marker does.
- `hooks.after` on `/two-factor/verify-totp`: when the user's `twoFactorEnabled` has become
  true, delete the marker.
- An admin target is already confined to enrolment by `002` Q43; the marker makes the same
  true of a member.
- **The window after a reset.** After an MFA reset the target has no factor, so (Q1) the link
  alone suffices for a password reset, and the marker means no sign-in can do anything but
  enrol: there is no password-only path to the platform, which closes the window the draft
  review found (whoever held the password reached the platform in the meantime). What is
  left is who enrols first: someone with the password who signs in before the real member
  enrols their own authenticator. The mitigations are the `MfaResetNotice` to the member's
  mailbox, the reason code and audit event, the admin-only-members rule (Q15), and the
  runbook step that the member signs in and enrols in a supervised session straight after.
  Recorded in Risks.
- _Alternative:_ rely on the next admin to ask the member to enrol: rejected, an unconfirmed
  convention is not "forces". _Alternative:_ require a factor of everyone: out of scope
  (`002` decides who must have one). _Rejected (Q17):_ no marker.

### D12. Break-glass for an admin, an owner, a multi-tenant member or a squatted factor (Q6, Q14, Q15, Q16, Q29, Q30, Q31)

An admin cannot ask another admin to reset them when they are the last one, an owner and an
admin target are outside the admin operation (Q15), a member of several tenants is outside it
too (Q12), and a squatter-enrolled factor needs someone the squatter does not control (Q16).
All four are recovered out of band, like `043`'s bootstrap CLI
(`apps/api/scripts/bootstrap-admin.ts`, `043` D9, Q91):

- **The command.** A `tsx` CLI, `apps/api/scripts/recover-admin-mfa.ts` (package script
  `recover:admin-mfa`), never mounted, using `runScript` and `loadScriptConfig`. Arguments
  (`node:util` `parseArgs`): `--organization-slug <slug>`, `--email <address>` and
  `--approver <opaque id>`. No secret is printed. It refuses an unknown organization and a
  user who is not a member of it (without printing account detail). Any member is a valid
  target, whatever the role, in one tenant or several (Q12, Q15, Q16); there is no
  self-target, role or multi-tenant refusal on this path.
- **Operator and approver (Q14).** The operator id comes from `TAYZU_OPERATOR_ID`, read by
  `loadScriptConfig` (`apps/api/scripts/script-config.ts`, `043` Q116), not from an argument.
  `--approver` is required, uses the operator id's charset (`OPERATOR_ID_PATTERN`,
  1 to 128 of `A-Z a-z 0-9 _ . : -`, declared but not exported at `script-config.ts:41`; task
  11.1 exports it) and must differ from the operator id; the CLI refuses to
  run otherwise. The audit event `catalog.audit.mfa_reset` (form `operator`) carries
  `tayzu.identity.operator.id` and `tayzu.identity.approver.id`. Both are self-asserted
  opaque ids, not authenticated: the Azure PIM record of the run and the person who approves
  are the control; the audit event is the second record. It is not tamper-proof against
  someone who can run the CLI (the `tayzu_auth` role can write `auth.*` directly), and Risks
  says so.
- **Secrets (Q14).** The shared service `apps/api/src/identity/mfa-reset.ts` takes a
  repository/SQL port and no Better Auth instance (the MFA reset only deletes `two_factor`
  rows, flips `two_factor_enabled`, writes a marker and deletes sessions: parameterized SQL on
  the `tayzu_auth` pool). The CLI therefore **never loads `BETTER_AUTH_SECRET`**, the `043` Q114
  rule that a script that cannot sign a cookie must not hold the signing key. Its declared
  variable list in `script-config.ts` (`SCRIPT_VARIABLES['recover-admin-mfa']`) is
  `AUTH_DATABASE_URL`, `TAYZU_OPERATOR_ID` and the email variables below; it has no
  `DATABASE_URL`, no `CERBOS_ADDRESS` and no `IDENTITY_TOKEN_HMAC_SECRET`. A test asserts the
  list. `docs/security/secrets.md` lists the CLI with its variables and the `tayzu_auth`
  identity's use (task 15.2).
- **Email (Q14).** The CLI sends the fixed `MfaResetNotice` to the user. It declares
  `EMAIL_PROVIDER`, `EMAIL_SENDER_ADDRESS`, `ACS_CONNECTION_STRING` (required only for
  `acs`), `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST` (required for a real provider),
  `EMAIL_DISABLED_TENANT_IDS` and `INVITATION_EMAIL_KILL_SWITCH` (both optional), builds its
  sender with `createEmailSender` (`apps/api/src/email-sender.ts:17`; the allowlist wrapper
  applies), whose parameter becomes the four-field slice of `Config` it reads
  (`emailProvider`, `acsConnectionString`, `emailSenderAddress`,
  `emailRecipientDomainAllowlist`), a type-only change so that the script needs no full
  `Config` (task 11.2), and honors the kill switch and the disabled-tenant list. It has no cap
  store (that needs a Better Auth adapter), so its single notice is outside the recipient
  caps; the supervised run is the control. The completion line below says whether the notice
  was sent, suppressed or failed, so the operator knows if the owner was not told. The CLI is also the
  first script to hold `ACS_CONNECTION_STRING`, a send-as-the-platform-domain secret; its
  handling is part of the runbook and `secrets.md` (task 15.2). Rejected: no email from the
  CLI; a runbook with no code.
- **Telemetry guard and completion line (Q29, amended by Q31).** The audit event is the only durable record of
  who approved removing a second factor, and the operator sets the CLI's environment, so
  the shared script rule ("a script refuses to run without an OTLP endpoint unless
  `TAYZU_TELEMETRY_DISABLED=true`", `secrets.md:212-217`, `telemetry.ts:134-146`, which also
  lets a run proceed with the flag set and an endpoint present) is stricter here. The guard lives
  in the command's entry point, its `main()`, and ignores `NODE_ENV` entirely (Q31): `main()`
  refuses to start, before any database or email work, when `TAYZU_TELEMETRY_DISABLED` is true
  **or** no OTLP endpoint variable is set, whatever `NODE_ENV` says, so no environment variable
  can switch the audit event off in a real run (the endpoint list at `telemetry.ts:24-29`
  becomes one exported helper that `startTelemetry` and this guard share). The tests call the
  exported run function with an injected `env` and never read `process.env` for the guard,
  because `startTelemetry` falls back to `process.env['NODE_ENV']` (and returns `undefined`
  under `test`), so the tests must not depend on it. It exits non-zero when the final flush fails: `runScript` awaits `shutdown()`
  in a `finally` (`run-script.ts:44-46`), so a rejection reaches the entry point, which sets
  `process.exitCode = 1` as `bootstrap-admin.ts` does; the stderr text is fixed and says the
  audit event may be missing. The reset itself is committed by then and is not undone, so the
  completion line is printed inside the `runScript` callback, before the flush, and is the
  operator's record in that case; `RunScriptOptions.telemetry` is the seam a test uses to supply
  the handle, since `startTelemetry` returns `undefined` under test. On completion the command
  prints exactly one line on stdout, `mfa-reset operator=<id> approver=<id> user=<opaque user
  id> sessions_revoked=<n> notice=<sent|suppressed|failed>`, which the operator attaches to the PIM
  record; the ids use the pattern's charset, which has no space or `=`, so the line cannot be
  forged by an id, and it carries no address and no secret (task 11.3). Rejected: refusing
  only the opt-out, without the flush check and the line; PIM as the only evidence.
- **Machine credentials (Q30).** The command leaves the target's machine credentials,
  service accounts and SSO links untouched, as the password reset does (Q21); the fixed
  `MfaResetNotice` tells the user to review them. Rejected: revoking the user's credentials
  when the reason is `suspected_compromise`.
- **Where it runs (Q14).** A production run happens only from the production-network
  operator environment under Azure PIM with a personal account, never from a laptop. The
  runbook and Gate 5 say so.
- **The runbook** (`docs/security/secrets.md`, "Maintenance jobs and the bootstrap CLI", gains
  a section; the full text is task 15.2) states: who may run it; identity verification out
  of band (video call or an employer-confirmed request) with a named **second approver**
  recorded before the run and passed as `--approver`; just-in-time access like `043` D9; how
  the operator obtains `AUTH_DATABASE_URL` and `ACS_CONNECTION_STRING` (a Key Vault read under
  the PIM role, held in the process environment only, never typed into a shell, written to a
  file or left in a history); the squatting path (an owner who reports a reset asking for a
  code they never set up); the completion line attached to the PIM record; and that the run
  is reviewed afterwards from the audit event. **The order of the recovery matters, because
  after the run the factor is gone and a password is the only thing between the account and
  the next person to enrol** (the account is confined to enrolment by D11, but whoever signs
  in first can enrol): (1) the verified person requests a reset link **before** the run (it is
  valid for 30 minutes) and keeps the page open; (2) the operator runs the command; (3) the
  person confirms the reset at once, with the link alone because no factor is enrolled any
  more, which replaces the password and ends every session, so a squatter's or a thief's
  knowledge of the old password dies; (4) the person signs in with the new password and
  enrols a second factor in a supervised session while the operator waits; (5) only then is
  the account handed back and the operator tells the person that the run is over. If step 3
  answers a factor request, someone enrolled in the window of step 2 to 3, and the operator
  repeats the run and the confirmation. The window of step 2 to 3 is as short as one
  request, and it is recorded in Risks.
- The CLI cannot reset a password: an admin who forgot the password and lost the factor first
  has the factor reset by the runbook, then uses the reset flow.
- _Alternative:_ a Container Apps Job and a workflow like `045`'s reversal: rejected for this
  change, since `010` provisions jobs and the CLI is the same shape as the bootstrap's;
  `010` can wrap it. Recorded as a Gate and a ticket.

### D13. Mount switch and route allowlists (Q9)

The same `MOUNT_IDENTITY_ROUTES`, off by default, gates the two public routes and
`identity.users.resetMfa`. The `043` rule "no HTTP assertion about these routes before the
hand-off group" does not apply: the hand-offs are done. `ALLOWED_AUTH_ROUTES` is unchanged
and the drift test is not touched. `PUBLIC_ROUTE_ALLOWLIST` gains two entries, one with each
route's task (6.1, 8.3).
The `identity.openapi.json` document gains the oRPC route (no schemas, as `043` Q52).
Turning the switch on is a Gate that includes the TLS and DNS checks of Q25 (Gates).
_Alternative:_ a separate `MOUNT_RECOVERY_ROUTES`: rejected by Q9.

### D14. The link target and the page (Q10, Q26)

The link points at `PASSWORD_RESET_LINK_BASE_URL` plus the fixed path `/reset-password`
and a fragment (D3). The client never supplies a `redirectTo`; the request schema rejects
the field. The page is `003`'s: until it serves `/reset-password` at that origin the link
is inert. Its preconditions are `043`'s accept-page preconditions (Q10's three: it strips the
fragment after reading it, sends `Referrer-Policy: no-referrer`, loads no third-party
script) plus the two of Q26: it never submits the new password without the user's action,
and it shows a factor field when the confirm route answers `AUTH_STEP_UP_REQUIRED`. They are
Gates. _Alternatives:_ accept a validated `redirectTo` (rejected by Q10); Q10's three only
(rejected by Q26).

### D15. Observability contract

Tracer, meter and logger are `@tayzu/auth`'s (`INSTRUMENTATION_SCOPE_NAME`). All names are
declared in `packages/auth/src/telemetry/identity-contract.ts` (extending `IDENTITY_SPANS`,
`IDENTITY_METRICS`, `IDENTITY_LOG_EVENTS` and `IDENTITY_ATTRIBUTE_VALUES`), mirrored in
`packages/auth/src/__fixtures__/identity-contract-expected.ts`, and enforced by the extended
`otel-smoke-check`. `apps/api` emits through the existing helpers (`emitIdentityEvent`,
`recordIdentityMetric`, `withIdentitySpan`), which sanitize span errors. `002`'s `contract.ts`
stays unchanged. **No signal carries an email, a token, a link, a password, a backup code, an
IP, a request path with an identifier or tenant free text**; `tayzu.identity.user.id`,
`tayzu.tenant.id`, `tayzu.identity.operator.id` and `tayzu.identity.approver.id` are opaque
ids and allowed; an unknown address produces no identifier.

**Spans**

| Name                               | Required attributes                  | Where |
| ---------------------------------- | ------------------------------------ | ----- |
| `identity.password_reset.request`  | none                                 | the request route handler (the uniform path is the same span for every branch) |
| `identity.password_reset.confirm`  | none; `tayzu.identity.reset.mfa` is conditional: set once the factor step has run, absent on a rejection before it (malformed request, cross-site, unknown token, ineligible account) | the confirm route handler |
| `identity.mfa.reset`               | `tayzu.identity.mfa_reset.path`      | the MFA reset service, admin and operator |

**Metrics** (counters, `{event}`)

| Name                                  | Attributes                                                         |
| ------------------------------------- | ------------------------------------------------------------------ |
| `tayzu.identity.password_reset_requests` | `tayzu.identity.reset.request_outcome`                          |
| `tayzu.identity.password_reset_confirms` | `tayzu.identity.reset.confirm_outcome`                          |
| `tayzu.identity.mfa_resets`           | `tayzu.tenant.id`, `tayzu.identity.mfa_reset.path`                 |
| `tayzu.identity.recovery_emails`      | `tayzu.identity.email.template`, `tayzu.identity.email.outcome`    |

**Log events**

| Name                                          | Severity | Attributes                                                                                                   |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `catalog.audit.password_reset_requested`      | INFO     | `tayzu.identity.user.id` (only when a token was issued)                                                      |
| `catalog.audit.password_reset_completed`      | INFO     | `tayzu.identity.user.id`, `tayzu.identity.reset.mfa`, `tayzu.identity.sessions.revoked`                      |
| `catalog.audit.mfa_reset`                     | INFO     | form `admin`: `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.mfa_reset.reason`, `tayzu.identity.sessions.revoked`; form `operator`: `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.approver.id`, `tayzu.identity.user.id`, `tayzu.identity.sessions.revoked` |
| `catalog.security.password_reset_denied`      | WARN     | `tayzu.identity.reset.denial_reason`; conditional `tayzu.identity.user.id` (absent when the id/token matched no row) |
| `catalog.security.recovery_email_suppressed`  | WARN     | `tayzu.identity.email.template`, `tayzu.identity.recovery.suppression`; conditional `tayzu.identity.user.id` (absent for `unknown_address`) |
| `catalog.security.self_mfa_reset_denied`      | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                           |

For the operator form, `tayzu.tenant.id` is the tenant of the organization named on the
command line; a user of several tenants has one event per run, not per tenant. The operator
command's completion line (D12) is stdout for the operator's PIM record, not a signal.

Reused unchanged: `auth.security.session_revoked` (gains the reasons `password_reset` and
`mfa_reset` in `SessionRevocationReason`, `identity-contract.ts` and the fixture),
`auth.security.rate_limited` (the closed scope union gains eight values, D16),
`catalog.security.email_recipient_blocked`, `catalog.security.email_tenant_blocked` (not
used by the mailer, which reports `tenants_email_disabled` instead because a user has many
tenants), `catalog.security.identity_conflict_refused` (the single internal record of an
MFA reset refusal, with the reasons `target_in_other_tenant` and `target_is_admin_or_owner`,
existing, and `no_enrolled_factor`, new), `catalog.security.authz_denied` and
`tayzu.authz.decisions` (from the wrapper).

**Closed value sets added to `IDENTITY_ATTRIBUTE_VALUES`**

| Attribute                                  | Values |
| ------------------------------------------ | ------ |
| `tayzu.identity.reset.mfa`                 | `not_enrolled`, `totp`, `backup_code` |
| `tayzu.identity.reset.request_outcome`     | `issued`, `ineligible`, `suppressed` |
| `tayzu.identity.reset.confirm_outcome`     | `completed`, `rejected`, `factor_required`, `policy_refused`, `breach_check_unavailable` |
| `tayzu.identity.reset.denial_reason`       | `malformed_request`, `csrf_rejected`, `origin_rejected`, `not_found`, `expired`, `token_mismatch`, `not_eligible`, `factor_invalid`, `factor_state_inconsistent`, `attempts_exhausted`, `policy_violation`, `breached`, `breach_check_unavailable`, `consume_conflict` |
| `tayzu.identity.recovery.suppression`      | `unknown_address`, `no_credential_account`, `banned`, `disabled_everywhere`, `no_membership`, `kill_switch`, `recipient_domain_blocked`, `tenants_email_disabled`, `recipient_cap`, `ip_cap`, `global_cap`, `tenant_cap`, `provider_failure`, `token_issue_failure` |
| `tayzu.identity.mfa_reset.path`            | `admin`, `operator` |
| `tayzu.identity.mfa_reset.reason`          | `lost_both_factors`, `device_replaced`, `suspected_compromise`, `identity_verified_request` |
| `tayzu.identity.conflict.reason`           | the existing `account_exists`, `target_in_other_tenant`, `sub_already_linked`, `target_is_admin_or_owner`, plus `no_enrolled_factor` |
| `tayzu.identity.email.template`            | `invitation`, `admin_accepted`, `password_reset`, `password_changed`, `mfa_changed`, `mfa_reset`, `account_created` |
| `tayzu.identity.email.outcome`             | `sent`, `suppressed`, `failed` |
| `tayzu.auth.revocation.reason`             | `sso_link_shed`, `password_reset`, `mfa_reset` |

`recipient_domain_blocked` is the admission-time refusal of a recipient domain off the allowlist
(D5; the mailer also logs the existing `email_recipient_blocked` with the template);
`provider_failure` is a provider fault after the token was issued, and also covers the
sender wrapper's own refusal if it ever fires at send time. `tenant_cap` and `global_cap` apply to the
account-created notice as well as, for `global_cap`, the reset email.
`tayzu.identity.sessions.revoked` is an integer. `tayzu.identity.notice.template` is not
extended (the recovery emails use `tayzu.identity.email.template`), so `045`'s extension of
the notice set does not conflict with this change.

**Correlation for forensics.** No signal carries an IP (above). Every audit and denial event
is emitted inside the route's or the operation's active span, so it carries the trace id as
the correlation key (a test asserts it), and the container-app ingress logs in Azure Monitor
are the source for the source IP of a reset abuse investigation; `attack-surfaces.md` says
so (task 15.1).

**Exported path.** `apps/api/src/telemetry.ts` already strips `?` and `#` from paths and
replaces the identity routes with their templates (`043` D16). The two reset routes carry no
identifier in the path, so the path is exported as is; `/v1/users/{user}/mfa/reset` is added
to the list of templates (the `{user}` is an email). The fragment never reaches the server.

**Enforcement.** `identity-contract.test.ts` pins the declarations to the fixture;
`otel-smoke-check` is extended to drive every operation once with each denial reason under
an in-memory exporter and to assert every declared name is observed and none undeclared;
a marker test (`recovery-telemetry.http.int.test.ts`) drives the real HTTP instrumentation
with a marker email, token and password and finds none of them in any exported signal; and
`catalog.audit.*` and `catalog.security.*` events stay sampling-exempt like `043`'s.

### D16. Rate-limit scopes and the client key

`RateLimitScope` gains `password_reset_request`, `password_reset_confirm`,
`reset_email_recipient`, `reset_email_ip`, `reset_email_global`, `recovery_notice_recipient`,
`account_created_notice_tenant` and `account_created_notice_global`; `BucketKeyKind` gains
`global`. `createRateLimitBucketStore` keeps throwing "Unknown rate-limit scope" for a scope
with no rule. The cap store's `BUCKETS` table gains six rows (`reset_recipient`, `reset_ip`,
`reset_global`, `recovery_notice_recipient`, `account_created_tenant`,
`account_created_global`). `server.ts` builds the rules from `Config`. Keys are hashed by the
store; the IP and the HMAC key never reach a signal.

- **The IP key is normalized.** A single IPv6 /64 holds 2^64 addresses, so keying on the raw
  `request.ip` would let one attacker with ordinary IPv6 access rotate through the route
  limiters and the `reset_email_ip` cap. `apps/api/src/identity/client-ip-key.ts` maps an
  IPv4 address to itself (a /32), an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or its hex
  form `::ffff:102:304`) to its IPv4 form, and any other IPv6 address to its first 64 bits in
  expanded form, dropping a zone id (`fe80::1%eth0`). It is used by the route limiter's
  pre-handler (which `043`'s accept route shares, so that route changes with it, Q28) and by
  the mailer's IP cap.
  The sign-in limiter of `002` keeps the raw address; normalizing it is a ticket.
- **A limiter-store failure fails closed.** If `store.consume` throws, the pre-handler
  answers the sanitized `INTERNAL` 500 itself (not the framework's default error reply) and
  no handler, lookup or email follows.
- **`auth.rate_limit` growth.** Each distinct key writes a row, and nothing prunes expired
  rows (`packages/db/migrations/0004_rate_limit_table.sql`); the /64 key bounds the growth an
  attacker can cause. Pruning rows whose `last_request` is older than the longest window is a
  data-retention item (`docs/security/data-retention.md`, task 15.3) and a ticket.
- The trust setting behind `request.ip` is the pending gate of D9, not a variable.

### D17. The DAST probe (Q11)

`scripts/ci/dast-probe.ts`, called by `scripts/ci/dast.sh` after the ZAP scan and against
the same sandbox tenant, non-sending sender (`EMAIL_PROVIDER=none`) and mount switch on. It
sends, to the accept route and both reset routes: well-formed and malformed JSON, an
oversized body, `__proto__` and `constructor` keys, a wrong content type, a missing CSRF
header and a bad `Origin`, a replayed token, an unknown and a known address (the request
route), and a burst past the limiter. It fails the run on any 5xx, on a stack trace or
reflected input in a body, when a reset route answers without `Cache-Control: no-store`,
and when the request route's answers for a known and an
unknown address differ in status, headers (names) or body. `dast-coverage.ts`'s coverage
rule is extended to count probe responses. The probe has no OpenAPI dependency; a
hand-written OpenAPI fragment was rejected because the routes' bodies are not in any
generated document and a second schema source would drift. Closes `043`'s ticket "DAST
probe of the accept route". `scripts/ci/dast.sh` does not set `MOUNT_IDENTITY_ROUTES` today;
task 14.2 adds it for the probe.

### D18. No migration; what `045` must classify

No table, column or policy of the database changes, and migrations `0012`-`0014` stay
reserved for `045`. The two identifier families of D3 and D11 are the only persistent
additions. `045`'s completeness test (its design, "completeness test", and its task 6.7)
classifies every `auth.verification` family by pattern and fails on an unlisted one.

**Hand-off note to `045`.** `044` adds no migration, and its two families in
`auth.verification` need a classification there:

| Family                | Recommended classification | Reason |
| --------------------- | -------------- | ------ |
| `password-reset:<id>` | exempt as short-lived state (30 minutes, a random id, a digest, and a user id in `value`; purged opportunistically by the next issue) | the identifier holds neither a tenant nor a user, so a purge policy that joins by identifier family cannot join it, and it does not need to |
| `mfa-reenrol:<userId>`| purge step: delete with the user's other `verification` markers (`temp-password:`, `sso-link:`) before the row its policy joins | keyed by user id; far-future `expires_at`, so nothing else removes it |

Also for `045`: `auth.rate_limit` now holds hashed reset caps and IP keys (pseudonymous, no
tenant; exempt as `045` already treats the table), and the `EmailTemplate` union and the
`tayzu.identity.email.template` set are extended here first, so `045`'s `OrgDeletionNotice`
rebases onto them (a textual merge only). `044` lands first (`002 -> 043 -> 044 -> 045`);
`045`'s artifacts are not edited by this change, so the note is carried in this design, in
`docs/security/data-retention.md` and in the PR description (task 16.5). This change's
`verification-families.int.test.ts` is the early-warning list.

### D19. Docs and the ADR

- **ADR-0023** (`docs/adr/0023-password-reset-is-tayzu-owned-and-mfa-aware.md`; `0019` is
  reserved for `045`, `0022` is the last used). **An ADR is warranted**: the decisions are hard
  to reverse and later changes build on them (`045` classifies the identifier families, `003`
  serves the page). It records that Tayzu owns the reset routes (D1); that the mailbox alone
  never changes an MFA-enrolled user's password or removes a second factor (D6, D10); that a
  reset is allowed only for credential accounts (D4); that the completion is one SQL
  transaction on the lock's connection because Better Auth's adapter here is not
  transactional (D7, Q13); and that the break-glass is a CLI with a named approver that
  refuses to run with telemetry off (D12, Q14, Q29, Q31). It is dated **2026-10-14**, the day the
  first of these decisions (Q1, Q2) was approved, and carries an "Amended 2026-10-15" line for
  Q12-Q31, the day the rest were approved. It is task 1.1, the first task, so that the record
  exists before the code it describes (root `CLAUDE.md`: ADRs the same day a decision is
  made).
- `docs/security/attack-surfaces.md`: the "Public accept route" section becomes "Public
  routes" with the reset rows; "Blocked routes" notes that Better Auth's three reset routes
  stay blocked and why; "Email and phishing (SEC11)" no longer says the invitation email is
  the only email and records the SEC11 answers of D5; the rate-limit row; the source of IP
  forensics (the ingress logs); the `tayzu_auth` identity's use (SEC14); "Pending", whose TLS
  row (`:362`) points at Gate 9. `docs/security/dependencies.md` already holds the `002` task
  11.12 record (its section "TLS and HSTS posture on the public ACA ingress", `:163-190`, with the
  check table), so Q25's record lives there and gains one line for the DNS provider's
  DDoS-protection state (task 15.1).
- `docs/security/secrets.md`: the new variables (D9), the shared kill switch's wider scope,
  the operator CLI's variables, the CLI as a second reader of `ACS_CONNECTION_STRING` and
  `AUTH_DATABASE_URL` with their rotation text, how the operator obtains them, the
  break-glass section (D12), the `tayzu_auth` use (task 15.2).
- `docs/security/data-retention.md` and `docs/security/crypto-inventory.md` (token
  generation and digest, backup-code and TOTP decryption path, reuse of the password hash).
- `docs/catalog/auth-and-rbac.md` (the auth reference): the reset flow, the re-enrolment
  gate and the new allowlist notes.
- `docs/architecture/system-diagram.md` (Mermaid) and its image: two new public routes on
  the API app, the end user's mail client as the receiver of reset and notice mail, the
  operator as an actor of the break-glass CLI, and the `auth.verification` writes. Every new
  arrow names its protocol (HTTPS/JSON, HTTPS to the ACS email API, SQL over TLS, SMTP/IMAP
  to the user's mail client), and the Pwned Passwords range call from the confirm route is
  drawn as an external arrow. The `system-diagram.test.ts` check stays green.
- `apps/api/CLAUDE.md` and `packages/auth/CLAUDE.md`: layout lines for the new modules and
  the rule that Better Auth's reset routes stay closed.

### D20. Order of work and the Checkpoint 3 stop

Group 10 starts with the policy task; no later task of group 10 begins before the human
approves it. Everything else is code and tests. No database migration exists in this change,
so the only Checkpoint 3 item is the Cerbos change. Groups 1-9 do not depend on the policy.
Tasks run in order, so every task from 10.2 on waits for the approval, and the CLI (group 11)
waits with them because it uses the service of 10.3 and its operator form of 10.4, which sit in
group 10 behind the stop. Groups 12-14 emit and probe the MFA reset and so also come after it.
Only task 10.6 (the matrix over HTTP with the approved bundle) needs the policy itself; the
others wait because the human approves the group's policy before any code of the operation
exists, which is the rule of root `CLAUDE.md`.

## Observability contract

See D15 for the full contract (spans, metrics, log events, value sets and enforcement).

## Security considerations (SSA SEC01-SEC16 posture)

Read at design time against `.claude/skills/ssa-validator`. The draft's three reviews of
2026-10-15 (consistency, threat model, and the VCDM Mode A pre-assessment) were folded in;
what each decided is in the decisions Q12-Q31. The formal re-run is task 16.2 (the
`vcdm-ssa-validator` subagent, before Checkpoint 2). A GAP in tenant isolation, access
control, injection, secrets or logging would block.

| Section | Posture | Where |
| ------- | ------- | ----- |
| SEC01 System diagram | applies | D19: routes, mail client actor, operator actor, protocols on every arrow |
| SEC02 Attack surfaces | applies | D2, D13, D19: two unauthenticated routes, authenticated by token possession, limited and mounted behind the switch; Better Auth's closed |
| SEC03 Access control | applies | D10: Cerbos action, step-up, wrapper order, cross-tenant 404, one refusal path, members-only targets, self-target deny; the public routes are justified exceptions with limits, listed in the allowlist test |
| SEC04 Password storage | applies | D7: one hash function shared with sign-in; no SSO-only password creation (D4); users linked to Visma Connect with a local password may reset (Q22); squatted-account recovery |
| SEC05 Cryptography | applies | D3: 256-bit CSPRNG token, sha256 digest (high entropy, no salt needed), constant-time compare; D5: HMAC recipient key reused; D6: Better Auth's symmetric decrypt and OTP; the TLS gate (Q25) |
| SEC06 Application misuse | applies | D8 notices (password, MFA changes), enumeration (D4), replay and out-of-order confirm (D3, D2), rate limits (D5, D16), admission before issue (D5), lockout side effect (Risks) |
| SEC07 Dependencies | applies | one direct dependency, already locked (D6, Q18) |
| SEC08 File upload | N/A | no upload surface |
| SEC09 Secrets in code | applies (light) | fixtures generate tokens; nothing real-looking; `DATABASE_URL` never printed |
| SEC10 Secret management | applies | no new secret; D9 variables and the CLI's in `secrets.md`; the CLI holds no signing key (D12) but is the second reader of `ACS_CONNECTION_STRING` and `AUTH_DATABASE_URL`, with its rotation steps and how the operator obtains them in the runbook (task 15.2); link base URL is not a secret |
| SEC11 Phishing | applies, core | one clickable link, justified (the OWASP-permitted forgot-password link), fixed templates, single recipient, no attachments, no tracking, config-only origin, caps including the account-created notice's per-tenant and global ones (Q20), kill switch, allowlist, demo suppression (D5, D8). Extends `043`'s recorded answers; it does not replace them |
| SEC12 Testing/QA | applies | tasks 6-11 scenario tests, the DAST probe (D17), actor parity row; training and monitoring in Mode B (Q27) |
| SEC13 Secure deployment | partial | D9 config and the Gates; the CLI runs only from the production-network operator environment under PIM (D12) |
| SEC14 Infra permissions | partial | no migration and no grant, but the `tayzu_auth` identity gains two users: the unauthenticated reset routes and the operator CLI. It writes `auth.verification`, `auth.rate_limit`, `auth.two_factor`, `auth.session`, `auth.user` and `auth.account` here; it has full CRUD on the `auth` schema (`0003`), and narrowing it is `043`'s O-7, now with these two users (ticket) |
| SEC15 Network/host | partial | no new egress: ACS and Pwned Passwords as before; FQDN allowlist stays `043`'s ticket; the DNS provider's DDoS protection state is recorded at the gate (Q25) |
| SEC16 Security logging | applies | D15: audit and security events, opaque ids, trace-id correlation, sampling-exempt; IP forensics from the ingress logs; the break-glass CLI cannot run with telemetry off and exits non-zero on a failed flush (D12, Q29) |

### SSA notes (Q27)

- **Off-boarding of internal users (SEC03).** Answered as for `043` (Q147): the runbook in
  `docs/security/data-retention.md`, whose internal-staff part, including the PIM groups
  for the break-glass CLI, `010` owns.
- **Open items of `002` and `043`, reviewed now.** The items below were reviewed on
  2026-10-15; the ones `044` touches are linked.

| Item | Disposition in this change |
| ---- | -------------------------- |
| `043` O-10 (per-tenant cap on `identity.users.create`) | **Partially closed:** the account-created notice has a per-tenant and a global cap (Q20); the cap on creation itself stays the ticket |
| `043` O-7 (narrow `tayzu_auth`, pin the Postgres image) | Open; now cross-referenced by the two new users of the role (SEC14 row, ticket) |
| `043` O-11 (Cerbos audit backend in production) | Open (`010`); the new `resetMfa` decisions depend on it |
| `043` O-9 (password, MFA and email-change notices; `044` before the mount switch) | Closed here, except the email-change notice (ticket) |
| `043` O-3 (step-up before the role check) | Documented; stated in the spec scenario of the admin reset |
| `043` O-4 (password hash parameters) | Open; the reset shares the one hash function, so the ticket covers it |
| `043` O-6 (temporary password on the operator terminal) | Not touched: the CLI prints no secret |
| `043` O-1, O-2 | Open; O-2 (explicit admin actions) is not widened by `resetMfa` |
| `002` task 11.12 (TLS and HSTS on the ingress) | Becomes a Gate for turning on `MOUNT_IDENTITY_ROUTES` (Q25) |
| `002` Q58 (configurable `TRUST_PROXY`) | Still a pending gate (D9); the new per-IP controls depend on it |

- **Mode B items (Checkpoint 2).** SEC12 training and monitoring, the SEC13 access review,
  and SEC16 log provision, incident hours, review of suspicious behavior and retention are
  answered in Mode B at Checkpoint 2, in the VCDM re-run task (task 16.2).

## Divergences from Port (deliberate)

| Topic | Port | Tayzu | Why |
| ----- | ---- | ----- | --- |
| Password reset and MFA recovery | public docs describe neither (MFA "encouraged", SSO-delegated) | a full flow, D1-D12 | Tayzu keeps local credentials (`002`, ADR-0021 has Visma Connect as the primary IdP but local sign-in coexists); there is no Port analogue to copy, so the design follows OWASP, NIST and the SSA |

## Risks / Trade-offs

- **Silent denial of recovery by cap exhaustion** → an attacker who knows an address can
  burn its 5 emails per hour, and a distributed one the global 600. A suppressed request
  changes no token, so the link the victim already holds keeps working until it expires
  (D5): the attack costs the victim new mail, not the old link. Mitigated by IP caps on the
  /64 prefix, the short window, alerts on `recipient_cap` and `global_cap` (a Gate for
  `010`), the kill switch as a manual lever, and a ticket for proof-of-work. The counters run
  narrowest first (recipient, IP, global; D5), so a capped recipient cannot be used to spend the
  global bucket. Chosen over a visible 429, which is an oracle. Someone who has the victim's address can still make the
  victim receive up to five reset emails an hour; each admitted one replaces the last.
- **The minimum response duration is not constant work** → under a slow database, or under
  contention on the per-user lock, the eligible branch can exceed 400 ms and become
  distinguishable. Mitigated by calibrating the value against the eligible branch's p99
  under concurrency in staging (a Gate) and a ticket for a constant-work path.
- **A detached send can be lost on a crash or a provider fault** → the new token is valid and
  unmailed and the earlier one is gone; the user requests again. Graceful shutdown drains
  in-flight sends.
- **Mailbox compromise changes the password of a user without a second factor** → inherent
  to email recovery (NIST treats email as a weak authenticator); mitigated by session
  revocation, the password-changed notice to the same mailbox, and Q1 for enrolled users.
  An admin or owner without an enrolled factor (a new admin, or one whose factor an operator
  reset) is not protected by Q1: a link-only reset is possible for them, and until they
  enrol they are only confined to enrolment (`server.ts:945-953` answers
  `AUTH_STEP_UP_REQUIRED` on `/v1`; `002` Q43 does not guarantee a factor). A mistyped address given by an admin to
  `identity.users.create` hands the account to the mailbox owner on their first reset; the
  account-created notice goes to that same mailbox. Inherent.
- **A compromised admin with a fresh step-up can reset a member's factor** → mitigated by the
  member notice, the mandatory reason code and audit event with the admin id, the forced
  re-enrolment confinement, the self-target deny, and members-only targets (Q15): an admin or
  an owner cannot be reset by a peer. The OWASP "second approver or delay" is a ticket.
- **The window after an MFA reset** → there is no password-only path to the platform (D11), but
  whoever holds the password and signs in before the real member enrols can enrol their own
  authenticator. Mitigations in D11; accepted.
- **The window after an operator recovery** → after the command removes the factor, the old
  password (a squatter's temporary one, or a stolen one) still signs in until the person
  confirms the reset, and that sign-in is confined to enrolment but can enrol. The runbook
  order (D12) closes it to one request: the link is requested before the run, the confirmation
  follows at once and replaces the password and ends every session, and a confirmation that
  asks for a factor means someone enrolled in the window, so the run is repeated. A squatter
  who watches the account can still try to win that race each time; the supervised enrolment
  and the audit review are the controls, and the residual is accepted.
- **A squatter-enrolled factor** → an admin who created an account for someone else's address
  can enrol a factor first, and the rightful owner's reset then asks for a code they never set
  up (Q16). Recovery is the operator CLI, which accepts any member; the account-created
  notice tells the owner to contact the platform operator. Residual: until the owner
  reports, the squatter holds the account. 043's temporary-password creation is not changed.
- **A reset does not evict persistence** → SSO links and machine credentials survive a password
  reset (Q21) and an admin or operator MFA reset (Q30), including when the reason is
  `suspected_compromise`. The fixed notices say to review them; two tickets follow.
- **A user linked to Visma Connect with a local password can reset** (Q22) → as their password
  sign-in already is allowed under `002`; a per-organization policy is a ticket for `025`.
- **TOTP replay within the window** → a code observed in real time can be replayed once within
  its validity window, here and on Better Auth's sign-in alike; a ticket for both paths.
- **The reset locks the owner's TOTP sign-in** → failed factors count on the account counter
  sign-in uses, so a mailbox holder can lock the owner out for 15 minutes at a time; alertable
  by `attempts_exhausted`.
- **A sign-in racing the commit** → closed for password-only users by the hash fence and for
  pending challenges by their deletion (D7); a single two-factor verification already past its
  challenge read can still create one session. Residual, one request wide.
- **The factor verifier duplicates Better Auth's check** → drift guarded by a test against
  the installed endpoint (D6); a Better Auth upgrade runs it.
- **A reset burns a breach-service outage into "cannot reset"** → the token is not consumed,
  the error is sanitized, and a retry works. Availability depends on `api.pwnedpasswords.com`
  as sign-up already does (`043` ticket "Offline breached-password corpus").
- **Notices fail quiet under their caps** → 10 per recipient per day, 20 per tenant and 1000
  globally per day for the account-created one are above normal; a suppression is logged and
  alertable. A raised cap is a configuration change.
- **`auth.verification` is shared** → the two new families are prefix-distinct and the
  prefix test (D3) prevents a collision with Better Auth's.
- **The reset link is inert until `003`** → documented, and a Gate.
- **The operator path has a global effect and a self-asserted audit** → for a user of several
  tenants it revokes their sessions in all of them (Q12: the admin path refuses these users, the
  operator path serves them). The operator and approver ids are not authenticated and the
  `tayzu_auth` role can write `auth.*` directly, so the audit event is not tamper-proof; PIM,
  the second approver, the review of the event and the completion line attached to the PIM
  record are the controls. The cheaper bypass, running the command with telemetry switched off,
  is closed by Q29 and Q31 (the entry point refuses to start, whatever `NODE_ENV` says, and the
  command exits non-zero on a failed flush); no environment variable switches the audit event
  off in a real run. What remains is someone who can edit the code, run another entry point
  than `main()`, or write `auth.*` directly.
- **Unnormalized sign-in limiter** → the reset limiters use the /64 key; `002`'s sign-in limiter
  still keys the raw IPv6 address (ticket).
- **Dot-alias and case variants of an address bypass the per-recipient cap** → known, shared
  with `043`'s ticket "Recipient-cap alias normalization".
- **Per-IP controls trust the proxy setting** → the fixed `trustProxy` list is verified against
  the ingress at the gate (D9).

## Migration Plan

- **Database:** none. State it in the PR: no migration, no `0012`-`0014` change.
- **Policy:** one Cerbos change (D10), shipped through the SHA-pinned pipeline with the app
  revision. It hardens an existing grant: until the bundle deploys, the existing `'*'` allow
  to a same-tenant admin applies to `resetMfa`, and the protections are the service's own
  checks (self-target, target role, multi-tenant, no factor; D10), which hold whatever the
  deploy order. The Checkpoint 3 presentation says so, so the reviewer is not surprised that
  `resetMfa` was reachable by an admin before the policy.
- **Deploy order:** policy bundle with or before the app; `PASSWORD_RESET_LINK_BASE_URL`
  and the other variables set before `MOUNT_IDENTITY_ROUTES` is turned on (startup fails
  otherwise, D9).
- **Rollback:** turning the switch off removes the three routes at once (`043` D15). The
  token rows expire by themselves; the `mfa-reenrol` markers persist (and keep confining
  those users to enrolment) until cleared, which is intended. A rollback of the app revision
  leaves the policy rules in place harmlessly.

## Gates

Human-owned, for the first deployment (`010`). `043`'s list stays in force; those that bear
on this change are restated, then this change's own.

**Inherited from `043` and `002` (apply to the new routes):**

- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the connection
  string in Key Vault (`043` Q28), with the managed-identity alternative of that gate now
  covering the operator CLI too (it is the second holder of the string);
  `EMAIL_PROVIDER` set explicitly in every deployed environment; CI, DAST and demo tenants use
  the non-sending sender.
- A configurable trust-proxy setting (`002` Q58; there is no `TRUST_PROXY` variable today,
  D9) set to the exact ingress hop count: the route and email IP limiters key on
  `request.ip`.
- The rate-limit stores shared across replicas (the reset limiters and caps already use the
  DB-backed store).

**This change's own, before `MOUNT_IDENTITY_ROUTES` is turned on:**

1. `044` is merged and its tasks are ticked, so the recovery path for a squatted account
   (`043` Gate) exists.
2. `003` serves the reset page at `PASSWORD_RESET_LINK_BASE_URL` with the preconditions of
   D14 (Q10's three and Q26's two).
3. The Cerbos change of task 10.1 is approved (Checkpoint 3) and deployed.
4. The DAST probe of D17 passes against the sandbox with the switch on.
5. The break-glass runbook of D12 is adopted: named approvers, just-in-time access in place,
   and production runs only from the production-network operator environment under Azure PIM
   with a personal account, never from a laptop; that environment can reach an OTLP endpoint
   (the CLI refuses to start without one, whatever `NODE_ENV` says, Q29 and Q31) and the operator attaches the completion line to
   the PIM record; `010` decides whether to wrap the CLI in a job.
6. Alerts (with `010`) on `catalog.security.recovery_email_suppressed` with the reasons
   `recipient_cap`, `ip_cap`, `global_cap` and `provider_failure`, on
   `catalog.security.password_reset_denied` with `attempts_exhausted`, `consume_conflict` and
   `factor_state_inconsistent`, and on `catalog.audit.mfa_reset`.
7. `PASSWORD_RESET_MIN_RESPONSE_MS` is set above the p99 of the eligible request branch
   measured in staging under concurrent load.
8. `INVITATION_EMAIL_KILL_SWITCH` is documented to operators as the stop for every email.
9. (Q25, from `002` task 11.12) TLS 1.0 and 1.1 are disabled and HSTS is set at the ingress,
   the SSL Labs result is recorded in the table of `docs/security/dependencies.md` ("TLS and
   HSTS posture on the public ACA ingress", `:163-190`, the file that already holds the `002`
   task 11.12 record), and the state of the DNS provider's DDoS protection for the link origin
   and the sender domain is recorded on the same page.

## Tickets

| Ticket | Item |
| ------ | ---- |
| Email-change notice | No email-change path exists; when one does, it needs re-authentication and a notice to the old address (OWASP; SEC06). |
| Backup-code-use notice | A used backup code could notify the user (SEC06). |
| Unusual-login notice | Notify or limit a sign-in from an unusual location (SEC06). |
| Second approver or delay for admin MFA reset | OWASP suggests a delay or a second approver; a second-approver flow for admin-initiated resets (Q15) is evaluated after the first use (SEC03). |
| Constant-work request path | Replace the minimum-duration padding with equal work for known and unknown addresses (SEC06). |
| Proof-of-work or CAPTCHA on the request route | A bounded, privacy-respecting add-on against cap exhaustion (SEC06). |
| Rename `INVITATION_EMAIL_KILL_SWITCH` | It now stops every email; a rename is breaking, so deprecate-and-alias (SEC11). |
| SSO-only password setting | `025` decides whether an SSO-only user may add a local password (`002` Q44). |
| Reset for users linked to Visma Connect | A per-organization policy in `025` on whether a user linked to Visma Connect may reset a local password (Q22, SEC04). |
| Reset-row janitor | If `auth.verification` accumulates `password-reset:` rows between requests, add a scheduled delete (D3 cleans opportunistically) and an index on the user id. |
| Prune `auth.rate_limit` | Delete rows whose `last_request` is older than the longest window (D16); the table is shared with sign-in. |
| IPv6 /64 key for the sign-in limiter | Apply `client-ip-key.ts` to `002`'s pre-auth limiter (SEC06). |
| Remaining-backup-codes display | `003` could show how many codes are left; Better Auth exposes no count endpoint (the only listing, `viewBackupCodes`, is server-only: `dist/plugins/two-factor/backup-codes/index.mjs:318`). |
| TOTP replay within the window | Record the last accepted step per user, for sign-in and reset together (SEC06, D6). |
| Admin rotation from `043`'s viewer | Let an admin rotate or revoke the credentials a user owns after a password reset or an admin or operator MFA reset (Q21, Q30, SEC03). |
| Audit count of SSO links and credentials | Emit the count of a user's SSO links and live machine credentials at password-reset and MFA-reset time (Q21, Q30, SEC06). |
| Per-tenant cap on `identity.users.create` | `043` Q147 O-10: partially closed by the account-created notice's caps (Q20); the cap on creation remains. |
| `tayzu_auth` least privilege | `043` O-7, with the unauthenticated reset routes and the operator CLI now users of the role (SEC14). |
| Security log retention and IP forensics | The retention of security events (12 months minimum) and the ingress-log source of IPs (SEC16); `043` O-11 on the Cerbos audit backend is related. |
| Admin MFA reset as a job | `010` may wrap the CLI of D12 in a Container Apps Job with the `045`-style reviewed workflow. |

## Hand-offs from `002` and `043` closed by this change

| Source | Item | Closed by |
| ------ | ---- | --------- |
| `002` ticket 9 (VCDM pre-assessment of `002`, SEC06) | Explicit scope for forgot-password and reset, with enumeration resistance | D2, D4; spec "The reset request answers identically for every address" |
| `002` Q14 | Where reset lives: a new change `044` reusing `043`'s email sender | D1, D5 |
| `002` Q46, task 23.16 and `043` Q92, ticket "Password, MFA and email-change notifications" | Notices for password, MFA and email changes | D8 (password and MFA built); the email-change part is a ticket |
| `043` Gate: "`044` ships before the mount switch is turned on" | Recovery path for a squatted account | D7, D8, D12 and Gates 1 and 3 |
| `043` ticket "Account squatting" | A notice to the address on creation (SEC04) | `AccountCreatedNotice`, D8, with its own caps (Q20); the squatter-enrolled factor path is D12 (Q16); the per-tenant cap on `users.create` stays a ticket |
| `043` ticket "DAST probe of the accept route" | A scripted probe for the first unauthenticated route | D17 |
| `043` temp-password expiry dead end (`auth.ts` expired-marker branches) | A user with an expired temporary password has no way back | D7 step 8 |
| `043` Gate: `003` page hygiene | Fragment stripping, `Referrer-Policy`, no third-party script | D14 extends it to the reset page |
| `043` D5 | `EmailTemplate` is a closed union to which later changes add | D8 adds five; `045` adds one after |
| `043` D15 | The mount switch is also the rollback | D13 |
| `002` task 11.12 | TLS and HSTS on the ingress | Gate 9 (Q25) |
| `045` design, completeness test | New identifier families must be classified | D18 hand-off note |

Not closed here: `043`'s "User notifications" (SSO link, unlink, shed, status), "Per-recipient
oracle" (the invitation gate's visible 429 stays; the reset path avoids it by design),
"Recipient-cap alias normalization", "Persistent per-tenant email-disable list" and
"Bounce and complaint handling".

## Resolved decisions (asked and approved in chat, 2026-10-14, 2026-10-15 and 2026-10-21)

Q1-Q11 were approved by the human on 2026-10-14 with the recommended option, Q12-Q31 on
2026-10-15 and Q32-Q33 on 2026-10-21, each with the recommended option. The text below is the approved text; Q12-Q31 amend
how Q1-Q11 are read where they say so. Where Q2, Q13 and Q19 say "the 8.1 password policy",
that is `043`'s password policy (`043` task 8.1), not this change's own task 8.1.

### Q1. Reset for a user with MFA enrolled

The emailed link alone never changes the password of an MFA-enrolled user. The new password
takes effect only after a TOTP or a backup code is verified in the same confirm request. A
user with no MFA needs only the link. _Rejected:_ the link alone, with MFA enforced at the
next sign-in. _Implemented by:_ D6.

### Q2. Routes

Tayzu owns both routes, request and confirm, in `apps/api`, modeled on 043's public accept
route:

- the token travels in the URL fragment;
- only its sha256 digest is stored, and it is verified in constant time with a dummy
  comparison when nothing matches;
- every refusal gets the uniform answer;
- the CSRF custom header and the `Origin` checks apply;
- a DB-backed limiter runs before any lookup;
- both routes are on the explicit public-route allowlist and behind the mount switch.

The final password write goes through Better Auth's internal adapter (hashing, NFC, `043`'s
password policy (`043` task 8.1) and the breach check apply), and Better Auth's built-in
`/request-password-reset` and `/reset-password` stay off the `/api/auth` allowlist.
_Rejected:_ Better Auth's built-in routes with hooks (plaintext token in a query string,
timing differences, outside the mount switch), and a mix of the two. _Implemented by:_ D1,
D2, D3, D7, D13.

### Q3. Token

The token is 256-bit random, stored as a sha256 digest only, single use, and valid for 30
minutes. A new request deletes the user's earlier unused reset tokens, so the newest wins.
It is stored in `auth.verification` under a new identifier family, with no migration, and
045's completeness test must classify that family. _Rejected:_ 15 minutes and 1 hour.
_Implemented by:_ D3, D18.

### Q4. Eligibility and enumeration resistance

Only an account that has a `credential` account, is not banned, and is not `Disabled` in
every tenant it belongs to receives a reset email. Unknown, SSO-only, banned and
Disabled-everywhere addresses get the identical public response and no email. The send is
asynchronous or timing-equalized, so the response time does not depend on the account state.
A reset never clears `banned` and never re-enables a `_user`. A completed reset clears the
temporary-password marker, which makes the reset the recovery path for an expired temporary
password and for a squatted account. _Rejected:_ letting SSO-only users create a password,
and mailing banned or Disabled accounts. _Implemented by:_ D4, D7.

### Q5. Effects of a completed reset

- It revokes every session of the user, in every tenant, with a new
  `auth.security.session_revoked` reason, `password_reset`.
- It deletes the user's other reset tokens and clears the temporary-password marker.
- It sets `emailVerified` to true.
- It sends the fixed "your password was changed" notice.
- It does not sign the user in: the user signs in with the new password and MFA.

_Rejected:_ the same, plus signing the user in. _Implemented by:_ D7, D8.

### Q6. MFA recovery

- **Backup codes** are the self-service recovery (002's two-factor plugin).
- **Admin reset:** for a member who lost both the authenticator and the backup codes, a
  tenant admin starts an audited MFA reset. This is a new identity operation through
  `defineIdentityOperation`, gated by Cerbos (a new policy action, so a Checkpoint 3 stop)
  and step-up. It removes the member's second factor, revokes every session, notifies the
  member at the registered address, and forces re-enrolment at the next sign-in.
  Cross-tenant and self-target rules follow 043's wrapper.
- **Last admin:** an operator break-glass runbook, run out of band like 043's bootstrap CLI,
  covers the last admin of an organization.

_Rejected:_ an email-only MFA reset (a mailbox would defeat MFA), backup codes only, and
splitting MFA recovery into its own change. _Implemented by:_ D10, D11, D12.

### Q7. Notifications (043's Q92 ticket)

044 builds fixed templates, with no tenant free text and no link, sent through 043's sender
and controls:

- password changed or reset;
- MFA changed or reset by an admin;
- "an account was created for this address", sent by `identity.users.create`. It warns the
  address owner of a squatted account and closes 043's gate on the account-squatting ticket.

The SSO-link and status notices stay in 043's "User notifications" ticket. The email-change
notice is deferred, because no email-change path exists today (record it as a ticket).
_Rejected:_ building all notices, and building only the reset ones. _Implemented by:_ D8.

### Q8. Email controls for an anonymous reset

- **Sender and store:** the reset path has its own entry through 043's sender and its shared
  DB-backed `EmailCapStore`.
- **Caps:** its own caps, per recipient (the HMAC key of 043's 6.7b), per IP and global.
- **Shared controls:** the shared kill switch and the shared recipient-domain allowlist.
- **Disabled tenants:** the reset email is suppressed when every tenant of the user is on
  `EMAIL_DISABLED_TENANT_IDS`, so a demo login cannot be used to send mail.
- **Refusals:** every refusal (cap, kill switch, suppression, provider failure) is silent and
  keeps the uniform answer, so nothing becomes an oracle.

_Rejected:_ reusing the invitation gate's `admit` unchanged, because its 429 is an oracle.
_Implemented by:_ D5, D9, D16.

### Q9. Mount switch

The same `MOUNT_IDENTITY_ROUTES`, off by default, gates every new route. 043's gate says 044
ships before the switch is turned on. _Rejected:_ a separate switch. _Implemented by:_ D13.

### Q10. Link target

The reset link points at a fixed, server-configured URL, a new base URL validated like
`INVITATION_LINK_BASE_URL` (https, in `ALLOWED_ORIGINS`). The client never supplies a
`redirectTo`.

- **The page:** it is `003`'s. The link stays inert until 003 serves the page, under the same
  page preconditions as the accept page: the page strips the fragment, sends
  `Referrer-Policy: no-referrer` and loads no third-party script.
- **The routes:** they are API-only, like the accept route.

_Rejected:_ accepting `redirectTo` validated against the allowed origins. _Implemented by:_
D3, D9, D14.

### Q11. DAST

044 adds a scripted DAST probe for the public routes that have no OpenAPI document: 043's
accept route and the two reset routes. It runs against the sandbox tenant with the
non-sending sender, which closes 043's ticket "DAST probe of the accept route". _Rejected:_
leaving it as a ticket. _Implemented by:_ D17.

Also decided on 2026-10-14: `002` is archived with its task 11.12 (TLS and HSTS on the
deployed ingress) deferred to `010`; `044`'s branch work starts after the archive PR of
`002` and `043` merges.

### Q12. An admin may not reset the second factor of a multi-tenant member (answers the draft's OQ1; 2026-10-15)

An admin may not reset the second factor of a member who also belongs to another tenant.
The refusal is indistinguishable from every other refusal of the operation (same status,
code, message and body shape) and does not reveal the other membership. Only the internal
log carries the reason. The check runs on the same single refusal path as the others, so
neither ordering nor timing separates them. The operator break-glass CLI recovers such
users, so the multi-tenant refusal belongs to the admin path only. _Rejected:_ allowing a
global effect; requiring approval from the other tenants. _Implemented by:_ D10, D12.

### Q13. Atomic completion of a reset (2026-10-15)

The confirm's final writes run as one transaction on the client that holds the per-user
advisory lock, through parameterized SQL in the auth repository module: the password update
in `auth.account` using Better Auth's exported password hash function, the token consume,
the deletion of every session with `returning` (one `session_revoked` per row), the marker
deletions, `emailVerified`, and the backup-code spend (Q19). Q2's "through Better Auth's
internal adapter" is read as "with Better Auth's hash function, NFC normalization and
schema". `043`'s password policy (`043` task 8.1) and the breach check still run before the transaction. No
second pooled connection is taken while the lock is held (`043` Q147/Q148). _Rejected:_
enabling `transaction: true` for the whole Better Auth instance; non-atomic writes with
compensation. _Implemented by:_ D7.

### Q14. The break-glass CLI (2026-10-15)

- **Approver:** `--approver <opaque id>` is required, uses the operator id's charset and must
  differ from the operator id. The CLI refuses to run otherwise. The `catalog.audit.mfa_reset`
  event (operator form) carries `tayzu.identity.approver.id`.
- **Secrets:** the shared mfa-reset service takes an SQL or repository port and no Better
  Auth instance, so the CLI never loads `BETTER_AUTH_SECRET`. A test asserts its declared
  variable list.
- **Email:** the CLI declares the email variables and sends the fixed MFA-reset notice to
  the user.
- **Documentation:** `docs/security/secrets.md` lists the CLI with its variables.
- **Where it runs:** the runbook states that a production run happens only from the
  production-network operator environment under Azure PIM with a personal account, never from
  a laptop. Gate 5 says so too.

_Rejected:_ no email from the CLI; a runbook with no code. _Implemented by:_ D12, D15, Gates.

### Q15. Targets of the admin MFA reset (2026-10-15)

A tenant admin may reset the factor of **members only**, and must give a mandatory reason
code from a closed enum (`lost_both_factors`, `device_replaced`, `suspected_compromise`,
`identity_verified_request`; the values are confirmed by Q28), which the audit event records. Another admin or an owner can be
reset only by the operator CLI with an approver (Q14). The spec and the Cerbos test cases
state this. A second-approver flow for admin-initiated resets stays a ticket. _Rejected:_
members and admins but not owners; anyone in the tenant. _Implemented by:_ D10, D12.

### Q16. The squatter-enrolled factor (2026-10-15)

Q1 is accepted as is. The scenario "a squatter enrolled a factor on an account created for
my address" is added, with recovery through the operator CLI, which accepts any member
target. The fixed `AccountCreatedNotice` text tells the owner to contact the platform
operator if a reset asks for a code they never set up. The residual risk goes in Risks.
_Rejected:_ an "unclaimed" marker that ignores the factor; changing `043`'s temporary-password
creation. _Implemented by:_ D8, D12, Risks.

### Q17. The `mfa-reenrol` marker (2026-10-15)

Accepted. After an admin or operator MFA reset, a `mfa-reenrol:<userId>` marker in
`auth.verification` confines the session to the enrolment routes until a factor is enrolled.
It uses the far-future sentinel `expiresAt` of the SSO-link and temporary-password markers
(`043` Q142) and is cleared on enrolment. It is an identifier family that `045`'s
completeness test must classify. _Rejected:_ no marker. _Implemented by:_ D11, D18.

### Q18. The `@better-auth/utils` dependency (2026-10-15)

`@better-auth/utils@0.4.2`, already in the lockfile, becomes a direct dependency for the TOTP
check at confirm, with a drift test against the installed Better Auth endpoint. _Rejected:_
backup codes only at confirm; a hand-rolled RFC 6238 implementation. _Implemented by:_ D6.

### Q19. Order at confirm (2026-10-15)

At confirm, `043`'s password policy (`043` task 8.1) and the breach check run before the factor is spent. The
backup code is spent inside the Q13 transaction, so a policy, breach or race failure never
burns it. _Rejected:_ leaving the order and documenting the burn. _Implemented by:_ D6, D7.

### Q20. Account-created notice volume (2026-10-15)

That notice gets a per-tenant cap (20 per day by default, configurable, parsed like the other
caps) and a global cap, in addition to the per-recipient one. The global default (1000 per
day) was the spec-writer's number inside this decision and is confirmed by Q28. _Rejected:_ per-recipient only;
dropping the notice. _Implemented by:_ D5, D9, D16.

### Q21. Persistence after a reset (2026-10-15)

A completed reset does not revoke machine credentials or SSO links. The fixed "password
changed" notice says, as fixed text, to review your service accounts, credentials and linked
sign-ins. Two tickets are opened: admin rotation from `043`'s viewer, and an audit count of
the user's SSO links and credentials. _Rejected:_ unlinking SSO identities; revoking
credentials. _Implemented by:_ D7, D8, Tickets.

### Q22. Users linked to Visma Connect with a local password (2026-10-15)

The reset is allowed, as their password sign-in already is under `002`. A ticket records a
per-organization policy for `025`. _Rejected:_ refusing the reset when an SSO link exists.
_Implemented by:_ D4, Tickets.

### Q23. Defaults (2026-10-15)

The drafted defaults stand: 5/h per recipient, 10/h per IP, 600/h global, notices 10 per day,
the routes 10 per minute, 400 ms response padding, 5 failures per token, a fixed 30-minute
token. _Rejected:_ no global cap; making the 30 minutes and the budget configurable.
_Implemented by:_ D3, D9.

### Q24. Request-route refusals (2026-10-15)

Malformed, cross-site and over-limit requests answer `400` or `429`. Only the
account-dependent states are uniform. _Rejected:_ answering everything with the uniform 200.
_Implemented by:_ D2.

### Q25. The TLS gate (2026-10-15)

`002` task 11.12 becomes a Gate for turning on `MOUNT_IDENTITY_ROUTES`: TLS 1.0/1.1
disabled, HSTS at the ingress, the SSL Labs result recorded, and the DNS provider's DDoS
protection state recorded. The record is the table of `docs/security/dependencies.md`
("TLS and HSTS posture on the public ACA ingress", `:163-190`), the file that already holds
the `002` task 11.12 record; Gate 9 and task 15.1 say so. _Rejected:_ keeping it only in `010`. _Implemented by:_ Gates (9).

### Q26. Page preconditions for `003` (2026-10-15)

Keep the two additions on top of Q10's three: the page never submits without a user action,
and it shows a factor field on `AUTH_STEP_UP_REQUIRED`. _Rejected:_ Q10's three only.
_Implemented by:_ D14, Gates (2).

### Q27. SSA attestations (2026-10-15)

- **Off-boarding:** answered as for `043` (Q147): the runbook in
  `docs/security/data-retention.md`, with the internal-staff part, including the PIM groups of
  the break-glass CLI, owned by `010`.
- **Open items:** the open items of `002` and `043` are reviewed now, and the design links the
  ones `044` closes (O-10 partially, through Q20).
- **Mode B:** SEC12 training and monitoring, the SEC13 access review, and SEC16 log
  provision, incident hours, review of suspicious behavior and retention are answered in
  Mode B at Checkpoint 2 (the VCDM re-run task).

_Implemented by:_ "SSA notes (Q27)", task 16.2.

### Q28. Behaviour changes from the reviews (2026-10-15)

All four are confirmed as written:

- **IPv6 limiter keys:** the limiters key IPv6 clients by their /64 prefix and IPv4 clients by
  /32, and a limiter-store failure fails closed. The shared pre-handler changes with them, so
  `043`'s accept route changes too.
- **Sign-in fence:** a fence on sign-in, so that a sign-in racing a reset commit cannot keep a
  session on the old password.
- **Admin MFA-reset reason codes:** `lost_both_factors`, `device_replaced`,
  `suspected_compromise` and `identity_verified_request`.
- **Account-created notice cap:** a global default of 1000 per day, configurable.

_Rejected:_ dropping the fence; keeping `002` and `043`'s behaviour byte for byte; other values.
_Implemented by:_ D16, D7, D10, D5, D9; tasks 1.6, 8.13, 10.5, 4.2.

### Q29. Break-glass CLI and telemetry (2026-10-15)

_Amended by Q31: the guard no longer depends on `NODE_ENV`, and the completion line reports the notice as sent, suppressed or failed._ The CLI refuses to start when `TAYZU_TELEMETRY_DISABLED` is true or no
OTLP endpoint is set. It exits non-zero when the final telemetry flush fails. On completion it
prints one line, which the operator attaches to the PIM record: operator id, approver id, the
target's opaque user id, the number of sessions revoked, and whether the notice was sent or
suppressed. The line carries no address and no secret. _Rejected:_ refusing the opt-out only,
without the flush check and the line; PIM as the only evidence. _Implemented by:_ D12, Risks,
Gate 5; tasks 11.3, 15.2.

### Q30. Machine credentials after an admin or operator MFA reset (2026-10-15)

They are left untouched, as Q21 does for the password reset. `MfaResetNotice` gains the same
fixed sentence: review your service accounts, credentials and linked sign-ins. The two Q21
tickets (admin rotation from `043`'s viewer, and an audit count of SSO links and credentials)
are extended to the MFA reset. _Rejected:_ revoking the user's credentials when the reason is
`suspected_compromise`; leaving it as is. _Implemented by:_ D8, D10, D12, Tickets; tasks 3.3,
10.3.

### Q31. Break-glass CLI telemetry guard in the entry point (2026-10-15)

The guard lives in the CLI's entry point (its `main()`) and ignores `NODE_ENV` entirely: it
refuses to start when `TAYZU_TELEMETRY_DISABLED` is true or no OTLP endpoint variable is set,
whatever `NODE_ENV` says, so no environment variable can switch the audit event off in a real
run. The tests call the exported run function with an injected `env` and never read
`process.env` for the guard, because `startTelemetry` falls back to `process.env['NODE_ENV']`.
This amends Q29: its "outside `NODE_ENV=test`" no longer applies to the CLI's guard, and its
completion line reports the notice as sent, suppressed or failed. _Rejected:_ keeping Q29 as
approved and stating the `NODE_ENV=test` residual in Risks. _Implemented by:_ D12, Risks,
Gate 5; tasks 11.3, 15.2.

### Q32. Fixed windows for the two global caps (2026-10-21)

The reset-email global cap (600 per hour by default) and the account-created global cap
(1000 per day by default) count in fixed windows: the bucket value carries the index of the
current window, so each hour or day starts at zero, and steady traffic at the cap holds new
sends back only until the window ends, never for a full idle window. Found during
implementation, when the shared test database's single global row passed 600 and never reset
under `043` Q66's semantics. No migration; one task (5.7) brings the count to 85.
_Rejected:_ keeping Q66's semantics for the global caps and documenting the platform-wide
stop; fixed windows for every `044` cap (over the 85-task limit, and a departure from `043`'s
buckets). _Implemented by:_ D5; tasks 5.7, 15.3.

### Q33. Backup-code decryption without `getBackupCodes` (2026-10-21)

Better Auth 1.7.6 declares `getBackupCodes` in its two-factor type declarations but does not
export it at runtime (`dist/plugins/two-factor/index.mjs:349` exports only
`TWO_FACTOR_ERROR_CODES`, `twoFactor` and `twoFactorClient`). D6's verifier therefore decrypts
with `symmetricDecrypt` from `better-auth/crypto` and a guarded JSON parse, which is what
`getBackupCodes` does for the plugin's default `storeBackupCodes: "encrypted"`
(`dist/plugins/two-factor/index.mjs:26`, `dist/plugins/two-factor/backup-codes/index.mjs:44-51`),
the mode Tayzu's `twoFactor()` instance uses. D6 is corrected to say so; the code of task 8.1
is unchanged. _Rejected:_ a vendored copy of the four-line function. _Implemented by:_ D6;
task 8.1.

### Size (2026-10-15)

`044` stays one change (Q6). The task budget may go slightly over 80; the rule is to stop at
85 and ask before adding more. `tasks.md` had 84; Q32 adds task 5.7, so it has 85, the limit.

### Review corrections folded in (not decisions)

The three reviews of the draft (consistency, threat model, VCDM Mode A, 2026-10-15) also
found defects that needed no human decision; they are corrected in the artifacts. C3 (the
IPv6 /64 limiter key and the fail-closed limiter) and C5 (the sign-in fence) changed archived
behaviour, so they were put to the human and are Q28 above, not corrections:

| Id | Correction | Where |
| -- | ---------- | ----- |
| C1 | The mailer's admission (kill switch, allowlist, tenants, caps) runs before the token is issued; a suppressed request changes no token | D2, D3, D5; spec "The reset token is secret, single use and short lived" |
| C2 | The factor step is serialized under the per-user lock and each count is an atomic statement | D3, D6 |
| C4 | "Enrolled" is an OR with a stricter answer for inconsistent state | D6 |
| C6 | `Cache-Control: no-store` and `Pragma: no-cache` on both routes | D2, D17 |
| C7 | The service repeats the self-target and role checks; the Migration Plan states the true state of the policy | D10, Migration Plan |
| C8 | Facts fixed: `TRUST_PROXY` does not exist; the commit hashes of the Context; the research notes are no longer cited | Context, D9 |

## Open Questions

None. The draft's only open question (OQ1, whether an admin may reset the factor of a member
who also belongs to another tenant) is resolved by Q12.
