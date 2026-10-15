# Design: 044-password-reset-and-account-recovery

## Context

See `proposal.md` for the motivation. The state this design starts from, all read
from the repository at the merge of `043` (`a68008f`) and the archive of `002`
(`e3f5771`):

- **There is no way back for a locked-out person.** Sign-in is email plus password,
  with TOTP and backup codes (`002`, Better Auth `twoFactor()` with defaults,
  `packages/auth/src/auth.ts`). Better Auth's `/request-password-reset`,
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
  `revokeSessionsOnPasswordReset` is set. The `haveIBeenPwned` plugin lists
  `/reset-password` in `BREACH_CHECKED_PATHS` (`auth.ts:129-136`), but its check runs
  inside `password.hash` and keys on the endpoint path
  (`dist/plugins/haveibeenpwned/index.mjs`).
- **`043` built the pattern to follow**: a public Fastify route outside the tenant
  pipeline (`POST /v1/auth/invitations/accept`, `apps/api/src/server.ts`), a token of
  256 bits whose sha256 digest is stored in `auth.verification` and verified in
  constant time (`packages/auth/src/identity/invitation-token.ts`), a DB-backed
  per-IP limiter (`apps/api/src/identity/accept-rate-limit.ts`), an explicit
  public-route allowlist (`apps/api/src/public-routes.ts`), the `MOUNT_IDENTITY_ROUTES`
  switch, the `EmailSender` port with a closed `EmailTemplate` union
  (`packages/auth/src/identity/email/sender.ts`), the shared cap store and HMAC
  recipient key (`email-cap-store.ts`, `recipient-key.ts`), the identity operation
  wrapper (`apps/api/src/identity/define-operation.ts`) and the identity telemetry
  contract module (`packages/auth/src/telemetry/identity-contract.ts`).
- **The `043` tenant-keyed email gate cannot serve an anonymous request**:
  `EmailTenantGate.admit` takes a `tenantId` and throws `AuthRateLimitedError` on a cap
  hit (`apps/api/src/identity/email-tenant-gate.ts`), which for an unauthenticated
  caller would reveal that an address was requested recently. The notice dispatcher
  never throws but is typed to one template and a tenant (`notices.ts`).
- **A temporary password that expires locks its owner out**: `hooks.before` rejects a
  session under an expired `temp-password:<userId>` marker and `hooks.after` rewrites
  the sign-in to a wrong-password answer (`auth.ts`, the `hasExpiredTemporaryPasswordMarker`
  branches), and only `/change-password` deletes the marker.
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
  they were not re-fetched for this design: the OWASP Forgot Password and Multifactor
  Authentication cheat sheets, NIST SP 800-63B (memorized secrets, account recovery,
  look-up secrets, session management) and the VCDM Security Self-Assessment skill
  (`.claude/skills/ssa-validator`). The research reports they were read through are
  `r3-references.md` section 4 (not fetched live) and section 5; the figures in them are
  not cited as fact.
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
  headers or time.
- A squatted account and an expired temporary password both have a recovery path, and the
  address owner is told when an account is created for their address.
- A member who lost both factors is recovered by an audited, step-up-gated admin action;
  the last admin by an out-of-band operator runbook.
- Every new path is the same code path for humans and agents, tenant-isolated, bounded by
  caps, free of tenant text in telemetry, and fails closed.
- No migration, one dependency already in the lockfile, one Cerbos change.

**Non-Goals** (design-level boundaries; the product-level ones are in `proposal.md`):

- No Better Auth reset route is allowlisted, and no `/api/auth` plugin is added.
- No server-rendered page, and no session created by a reset.
- No change to the sign-in, step-up or session policies of `002`.
- No new table or column, and no change to migrations `0012`-`0014`, which stay `045`'s.
- No attempt at constant-work equalization of the request path beyond a minimum response
  duration and a detached send (D4 explains the limit; a ticket tracks the rest).

## Decisions

Decisions D1-D20 are this design's. Q1-Q11 at the end are the human's approved
answers, recorded verbatim; each D names the Q it implements.

### D1. Tayzu owns both reset routes; Better Auth's stay closed (Q2)

Two plain Fastify routes in `apps/api`, modeled on the accept route, replace Better
Auth's three. Better Auth's remain off the allowlist and keep answering the byte-identical
`404` of any unknown path; the drift test keeps listing them as blocked (its comment
changes from "no reset flow yet" to "Tayzu-owned routes, D1"). The final password write
still goes through Better Auth's internal adapter (D7), so hashing, NFC normalization,
the password policy (`validatePassword`) and the breached-password check all apply.

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
| `/v1/users/{user}/mfa/reset` (D10)    | `POST` | session, Cerbos, step-up   | none                                                                          | `200 { "reset": true }`            |

- **Registration.** The two public routes are registered in `server.ts` next to the accept
  route, inside the same `if (options.mountIdentityRoutes === true)` block, before the
  `/v1/*` catch-all, and added to `PUBLIC_ROUTE_ALLOWLIST` each with a `reason`
  (Q9). With the switch off they do not exist: an unauthenticated call hits the catch-all
  and answers 401 `CATALOG_CONTEXT_REQUIRED`, an authenticated one 404, as `043` D15
  states. `mount-gate.int.test.ts` and `route-auth-allowlist.int.test.ts` gain the three
  routes. Neither public route is in an OpenAPI document (like the accept route), which
  is why D17 adds the DAST probe.
- **Order of work, request route:** the per-IP limiter (a `preHandler`, before the
  handler) → CSRF header and `Origin` check → strict parse and limits → canonical address
  → eligibility (D4) → token issue and detached send (D3, D5) → pad the response to the
  minimum duration (D4) → the uniform answer.
- **Order of work, confirm route:** limiter → CSRF and `Origin` → strict parse → token
  lookup and constant-time check (D3) → eligibility re-check (D4) → factor check if
  enrolled (D6) → password policy and breached-password check (D7) → one transaction that
  consumes the token and applies the effects (D7) → notice (D8) → answer.
- **CSRF and `Origin`.** Both routes require `x-csrf-token: orpc` and an `Origin` in
  `ALLOWED_ORIGINS`. This is stricter than the accept route, which reads a session only
  when they are present: these routes never read a session, so a request lacking either
  is always rejected, before any lookup. The confirm route rejects with the uniform `404`
  (reason `csrf_rejected` or `origin_rejected`, internal only); the request route rejects
  with `CATALOG_VALIDATION_FAILED`, which depends on the request's own headers and never on
  an account. `@fastify/cors` answers the preflight for the allowed origins
  (`cors.int.test.ts` is extended).
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
  precedent). `AUTH_STEP_UP_REQUIRED` (403) answers a missing or invalid factor.
  `CATALOG_VALIDATION_FAILED` (400) answers a policy or breach refusal with only the rule
  name. `AUTH_RATE_LIMITED` (429, `Retry-After`) answers the IP limiter. A breach-service
  outage answers the sanitized `INTERNAL` 500. No new error code is introduced.
- _Alternative:_ one route with a `?mode=` switch, or `GET` for the link. Rejected: a `GET`
  that consumes or reflects a token is prefetchable, and two routes keep the
  enumeration-sensitive one trivially small.

### D3. The token

- **Shape.** `id` = 16 random bytes and `token` = 32 random bytes, both from `randomBytes`
  and base64url (22 and 43 characters). The id is a public lookup handle, the token is the
  secret. 256 bits meet the OWASP cheat sheet's recommendation of at least 128 bits (not
  re-fetched; r3 section 4.1).
- **Storage.** One row of `auth.verification` per token, written through the auth-schema
  repository module: `identifier = 'password-reset:' + id`, `value = 'v1:' + digest + ':' +
  userId + ':' + failures` where `digest` is the lowercase hex sha256 of the token and
  `failures` an integer, `expires_at` = issue time + 30 minutes. Only the digest is stored;
  the token is in no column. No new table and no migration (the column types do not change).
  A new reset-token module in `packages/auth/src/identity/` mirrors
  `invitation-token.ts`: `generateResetToken`, `digestResetToken`, `verifyResetToken` (a
  constant-time `timingSafeEqual`, and one comparison against a dummy digest when no row
  matches), plus a strict codec for `value` (an unknown version or a malformed value is a
  non-match).
- **Lifetime.** 30 minutes, a constant (Q3), shown to the user as "30 minutes". Not
  configurable: a configurable lifetime is a knob that can only be set wrong.
- **Newest wins.** Issuing a token runs in one `authPool` transaction holding the per-user
  advisory lock of `user-lock.ts` (`createWithUserLock`): delete the user's rows (`identifier
  like 'password-reset:%' and split_part(value, ':', 3) = $userId`), delete expired
  `password-reset:` rows (opportunistic cleanup, so no janitor is needed), insert the new
  row. Bind parameters only.
- **Consumption.** `delete from auth.verification where identifier = $1 returning value`
  inside the final transaction (D7); zero rows is the lost-race rejection.
- **Failure budget.** A failed factor (D6) rewrites `value` with `failures + 1` by a
  compare-and-swap (`update ... where identifier = $1 and value = $old`, retried once); at 5
  failures the row is deleted. The counter lives in `value`, so no second identifier family
  is needed.
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
  context). The result is an internal enum used only for signals and the decision to issue:
  `eligible | unknown_address | no_credential_account | banned | disabled_everywhere |
  no_membership`.
- **Uniform answer.** The request route always answers `200 { "accepted": true }` for a
  well-formed, same-site request; the confirm route's rejections are all the one `404`.
  The internal reason goes to `catalog.security.recovery_email_suppressed` (request) or
  `catalog.security.password_reset_denied` (confirm), never to the caller.
- **Detached send.** After the token row commits, the mailer's send is started detached
  (D5): the handler does not await it, and a rejection is swallowed and counted. The mailer
  tracks in-flight sends and `app.close` drains them, so a graceful shutdown does not drop
  mail.
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

### D5. The email path of an anonymous reset (Q8)

A new `apps/api/src/identity/recovery-mailer.ts` is the single place a 044 email is sent.
It is built in `createApp` next to the gate and the dispatcher, over the same
`EmailSender` (so the recipient-domain allowlist wrapper and `EMAIL_PROVIDER` apply to it
unchanged), the same `EmailCapStore` (one DB-backed store shared across replicas) and the
same HMAC key.

- **Reset email, in order:** kill switch (`INVITATION_EMAIL_KILL_SWITCH`) → every tenant of
  the user is on `EMAIL_DISABLED_TENANT_IDS` (suppressed; the list is read from the same
  configuration as `043`'s) → global cap → IP cap → recipient cap (HMAC of the canonical
  address, `recipient-key.ts`) → send. Every refusal returns normally; none throws; each
  is logged once as `catalog.security.recovery_email_suppressed` with the template and a
  closed reason, and the user id when there is one. A refused send leaves the token row in
  place (it expires by itself) and consumes no single use.
- **Caps.** Own scopes in the closed `RateLimitScope` union and own rows in the cap store's
  `BUCKETS` table: `reset_email_recipient` (kind `email`), `reset_email_ip` (kind `ip`),
  `reset_email_global` (a new kind `global` added to `BucketKeyKind`, one constant key),
  and, for notices, `recovery_notice_recipient` (kind `email`). The route limiters of D2
  have their own scopes, `password_reset_request` and `password_reset_confirm` (kind `ip`).
  Recipient and IP caps are consumed only for an eligible account, so random addresses do
  not allocate bucket rows beyond the route limiter's per-IP row.
- **Notices** (D8) go through the same mailer: kill switch → all tenants disabled →
  `recovery_notice_recipient` cap → send. They never throw into the operation that
  triggered them.
- **Why not `EmailTenantGate.admit`:** it requires a tenant and throws on a cap hit (Context);
  reusing it with a synthetic tenant would make a 429 an oracle (Q8's rejected option). Why
  not extend the notice dispatcher: it is typed to one admin-notice template and a tenant list.
  The mailer reuses their parts (store, key, sender, switch, list), not their
  signatures.
- **No tracking, no Reply-To, one link.** The ACS adapter already disables tracking and sets no
  Reply-To for every template (`azure-communication-email.ts`); the reset email has one
  link, the notices none.
- **Configuration** is D9.

### D6. Confirmation for a user with a second factor (Q1)

The confirm route checks, after the token and eligibility, `user.twoFactorEnabled === true`
and a verified `twoFactor` row (an enrolment still in progress is "not enrolled").

- **No factor enrolled:** the link is enough (Q1).
- **Enrolled and no `factor` in the body:** answer `AUTH_STEP_UP_REQUIRED` (403), change
  nothing, do not consume the token, do not count a failure. This discloses "this account
  has a second factor" only to a holder of a valid token, who is entitled to it.
- **Enrolled and a `factor`:**
  - `totp`: read the `twoFactor` row through the repository module, decrypt `secret` with
    Better Auth's `symmetricDecrypt` and the instance's `secretConfig`
    (`(await auth.$context).secretConfig`), and verify with `createOTP(secret, { period: 30,
    digits: 6 }).verify(code)` from `@better-auth/utils/otp`, the calls the installed plugin
    makes in `dist/plugins/two-factor/totp/index.mjs`. `@better-auth/utils@0.4.2` is
    already in the lockfile as Better Auth's own dependency; this design names it and adds
    it as a direct dependency of `@tayzu/auth` at that exact version (task 1.1), the one
    dependency of the change.
  - `backup_code`: decrypt with Better Auth's `getBackupCodes`, compare each stored code
    with `timingSafeEqual`, and spend the code with a compare-and-swap update of
    `backupCodes` (the approach of the plugin's `verifyBackupCode`, which uses `includes`,
    not constant time; the CAS makes a double spend impossible).
  - **Accounting:** a failure increments the same `failedVerificationCount` and sets the
    same `lockedUntil` as sign-in (10 failures, 900 seconds, the plugin's defaults), reusing
    the row's columns, and increments the token's `failures` (D3). A locked account answers
    `AUTH_STEP_UP_REQUIRED` like any failure. A success resets the account counter.
  - An invalid or missing factor always answers the same `AUTH_STEP_UP_REQUIRED`.
- **Drift guard.** A test drives the installed `/two-factor/verify-totp` endpoint and the
  new verifier with the same secret and codes (current, previous and next window, wrong) and
  fails when they disagree, so a Better Auth upgrade cannot silently change one side.
- _Alternatives:_ **(a)** drive Better Auth's verify endpoints in process: they need a
  session or a signed pending-sign-in cookie, so the reset would have to forge a challenge.
  **(b)** a separate `verify-factor` route before confirm: a second public surface that
  reveals "this token is valid" separately. **(c)** a hand-written RFC 6238 HMAC-SHA1 with
  `node:crypto`: rejected, custom crypto beside a vetted implementation already installed.
  **(d)** require the factor for every user (including unenrolled): meaningless.

### D7. The completed reset: policy, hash, one transaction (Q5)

Before consuming anything, in this order: `validatePassword` (NFC, length, classes,
denylist; refusal names only the rule), then `isPasswordCompromised` from Better Auth's
`haveibeenpwned` module (k-anonymity; a failure to reach the service answers the sanitized
500 and consumes nothing). Both run before the transaction, so a refusal never burns the
token (Better Auth's own route burns it first, Context).

The transaction (Better Auth's `adapter.transaction`, which its `internalAdapter` joins
through `getCurrentAdapter`, plus the per-user advisory lock around it):

1. consume the token (`delete ... returning`); zero rows aborts as `consume_conflict`;
2. write the password: hash with the exported function the `emailAndPassword.password.hash`
   option already uses (NFC then `hashPassword`, exported from `auth.ts` as one symbol so
   the config and the reset cannot diverge), then `internalAdapter.updatePassword(userId,
   hash)`. The `haveIBeenPwned` wrapper around `context.password.hash` is deliberately not
   used: it keys on the endpoint path and would throw outside an endpoint, and the check
   already ran explicitly. A test proves the stored hash verifies through a real
   `/sign-in/email`;
3. delete the user's other `password-reset:` rows;
4. delete `temp-password:<userId>` (the same `deleteMany` on `temporaryPasswordMarkerIdentifier`
   that `/change-password` runs in `hooks.after`);
5. set `emailVerified` to true (`internalAdapter.updateUser`);
6. delete every session of the user in every tenant (`internalAdapter.deleteUserSessions`;
   not the tenant-scoped `deleteSessionsOf`), keeping the user ids and the count for the
   events.

If any step throws, the transaction rolls back: the old password signs in, the sessions
live and the token is intact (spec scenario "A failed write leaves everything as it was").
If the installed adapter turns out not to join the ambient transaction, task 7.9 fails
red and the fallback, decided there with the human before code, is the order consume →
sessions → password with a compensating re-issue; it is not chosen in advance because the
test is cheap and the fallback is worse.

After the commit: emit `auth.security.session_revoked` (reason `password_reset`) once per
revoked session, `catalog.audit.password_reset_completed`, record the metric, and send the
password-changed notice (D8). The route does not create a session or set a cookie.
Machine credentials (`apikey` rows, service accounts) are not touched. Banned and
`Disabled` states are not read or written by the write path, which is how "a reset never
clears `banned` and never re-enables a `_user`" holds by construction; the eligibility
re-check before the transaction refuses them.

- _Alternative:_ call Better Auth's `resetPassword` in process after verifying the token:
  rejected, it expects its own `reset-password:<token>` row and consumes before hashing.
- **Reset for a tenant pending deletion (`045`).** A reset needs only mailbox control and an
  eligible account; `045`'s tenant closure blocks sessions and routes of that tenant and is
  unaffected. A user whose only tenant is pending deletion has a `_user` that `045` handles;
  if `045` marks it `Disabled` the user is ineligible by D4, otherwise the reset is
  harmless.

### D8. The notices (Q7)

Five new members join the closed `EmailTemplate` union
(`packages/auth/src/identity/email/sender.ts`), each with a renderer in
`packages/auth/src/identity/email/`, an entry in `TEMPLATE_NAMES` of `email-allowlist.ts`
and `email-tenant-gate.ts` (the compiler forces both), the ACS adapter's `switch`, and a
value in the `tayzu.identity.email.template` set (D15). `045` adds `OrgDeletionNotice` to
the same union after this change merges and rebases (D18).

| Template (`kind`)       | Name              | Interpolated values   | Link | Sent when                                                                                         |
| ----------------------- | ----------------- | --------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `PasswordResetEmail`    | `password_reset`  | link, expiry text     | 1    | an eligible request (D5)                                                                          |
| `PasswordChangedNotice` | `password_changed`| none                  | 0    | a completed reset, and a successful `/change-password`                                            |
| `MfaChangedNotice`      | `mfa_changed`     | none                  | 0    | a TOTP factor becomes verified for a session user, or backup codes are regenerated                |
| `MfaResetNotice`        | `mfa_reset`       | none                  | 0    | an admin or operator MFA reset (D10, D12): tells the user to sign in and enrol again              |
| `AccountCreatedNotice`  | `account_created` | none                  | 0    | `identity.users.create` committed: "an account was created for this address"; the notice has no link and says to use the forgot-password page if the person does not expect it |

Fixed subject and body per template, no tenant, actor or organization text, one recipient,
no attachment, plain address validated by the sender port. A notice is addressed to the
user's canonical address read from the auth-schema repository module (never from request
input) and goes through the mailer (D5).

- **Hook points.** `@tayzu/auth` has the `EmailSender` port but not the caps, so
  `CreateAuthOptions` gains an `accountNotices?: AccountNoticePort` (`notify(kind, { userId
  })`, never throws, structural like `UserSyncPort`). `hooks.after` calls it for
  `/change-password` success (next to the existing marker delete and `session_revoked`
  emit), for `/two-factor/verify-totp` when a session exists and `hooks.before` recorded
  `twoFactorEnabled` as not true (enrolment, not the sign-in challenge, which has no
  session), and for `/two-factor/generate-backup-codes`. The reset confirm route and the
  MFA reset call the mailer directly. `identity.users.create` receives the mailer through
  `CreateIdentityRouterOptions.recoveryMailer` and notifies after its `addMember` succeeds
  and before it returns; a failure of the notice never fails the creation.
- **Not built:** the email-change notice (no email-change path exists; ticket), a notice on
  backup-code use (ticket), and `043`'s SSO link, unlink, shed and status notices (they stay in
  `043`'s "User notifications" ticket).
- _Alternatives:_ **all notices** and **only the reset ones** were rejected by Q7.

### D9. Configuration

Parsed in `apps/api/src/config.ts` with the existing helpers; values are never echoed in an
error; `NODE_ENV !== 'test'` is production, as in `002` and `043`.

| Variable                                                                        | Default            | Rule |
| ------------------------------------------------------------------------------- | ------------------ | ---- |
| `PASSWORD_RESET_LINK_BASE_URL`                                                  | none               | Parsed like `loadInvitationLinkBaseUrl`: required outside test; `https`; one of `ALLOWED_ORIGINS`; in test optional and `http` or `https`. The path (`/reset-password`) is fixed in code. |
| `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                      | 10 per 60 s per IP | `limitWithDefaults` (the accept route's `DEFAULT_PUBLIC_ROUTE_LIMIT`); a non-integer or zero value fails startup. |
| `PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                      | 10 per 60 s per IP | the same |
| `PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                    | 5 per 3600 s       | per recipient (HMAC key); the shared bucket semantics apply (a bucket resets only after a full window with no allowed request) |
| `PASSWORD_RESET_IP_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                           | 10 per 3600 s      | emails per IP |
| `PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                       | 600 per 3600 s     | emails across the platform |
| `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_MAX`, `_WINDOW_SECONDS`                   | 10 per 86 400 s    | per recipient, all five notices, apart from the other buckets |
| `PASSWORD_RESET_MIN_RESPONSE_MS`                                                | 400                | a positive integer between 1 and 5000, else startup fails |

Shared and unchanged: `MOUNT_IDENTITY_ROUTES`, `INVITATION_EMAIL_KILL_SWITCH` (its name
says "invitation" but it stops every email; renaming is a breaking change, so a ticket
records it and `secrets.md` says so), `EMAIL_PROVIDER`, `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`,
`EMAIL_DISABLED_TENANT_IDS`, `IDENTITY_TOKEN_HMAC_SECRET`, `ALLOWED_ORIGINS`, `TRUST_PROXY`.
No new secret exists: the recipient key reuses `IDENTITY_TOKEN_HMAC_SECRET`.

**Startup failure rules.** `createApp` throws (naming the variable only) when
`mountIdentityRoutes` is on and any of these is missing: the recipient key secret
(existing rule), `PASSWORD_RESET_LINK_BASE_URL`, an email sender. `createAppFromEnv` passes
every value above to `createApp`, and `createApp` applies the same defaults when an option
is omitted, so no limiter or cap is ever off (the Q140 lesson of `043`). The DAST script's
environment gains the new variables where `dast.sh` sets them. `docs/security/secrets.md`
lists them.

### D10. The admin MFA reset (Q6)

`identity.users.resetMfa`, a branded procedure of the identity router built with
`defineIdentityOperation({ authorization: { kind: RESOURCE_KINDS.user, action: 'resetMfa',
resolveTarget }, route, handler })`, `POST /v1/users/{user}/mfa/reset`, `x-tayzu-risk:
high`, `inputStructure: 'detailed'`, behind the mount switch and listed in
`openapi/identity.openapi.json` (regenerated by `contract:generate`, drift-checked by
`contract:check`). `{user}` is the `_user` identifier, resolved on the server to the Better
Auth user (`043` D14); the exported path is the route template (`043` D16 adds this
template to its list).

- **Authorization** (the wrapper's four steps, unchanged): the caller-tenant role check
  first; then the input is parsed and the target resolved on the server; then Cerbos with
  the target's real tenant; then the handler. A target not in the caller's tenant, or not
  existing, is `CATALOG_NOT_FOUND`, identical (`043` D14). Machine `member` tokens are
  refused at step 1.
- **Cerbos.** The resource kind is the existing `user`; the new action is `resetMfa`. The
  `user` policy already grants `'*'` to a same-tenant `admin` and denies by default for
  `member`; the change adds `resetMfa` to the self-target deny rule (`actions:
  [updateStatus, resetMfa]`, condition `R.id == P.id`) and test cases in
  `policies/resource_policies/user_test.yaml`, so the self-target deny is stated by policy
  and not only by the wrapper. **This is a Cerbos policy change and a Checkpoint 3 stop**
  (task 9.1, `policy-writer`, `pnpm policy:compile`, presented in chat with its compile
  output, approved separately before tasks 9.2 onward). The wrapper's self-target signal
  (`STATUS_ACTION`) becomes a set of two actions so a self-target `resetMfa` denial logs
  `catalog.security.self_mfa_reset_denied`.
- **Effects, in one `authPool` transaction under the per-user lock:** refuse if the target
  has no verified second factor (`CATALOG_VALIDATION_FAILED`) or belongs to any other
  tenant (`CATALOG_VALIDATION_FAILED`, event `catalog.security.identity_conflict_refused`
  with the existing reason `target_in_other_tenant`; see Open Questions); delete the
  `twoFactor` row; set `twoFactorEnabled` false; write `mfa-reenrol:<userId>` (D11); delete
  the user's sessions (`deleteUserSessions`) and emit `auth.security.session_revoked` with
  the new reason `mfa_reset` once per session; delete any `trust-device-%` rows of the user
  as defence in depth (the sign-in flow already refuses `trustDevice`, `auth.ts`, so none
  should exist). After the commit: `MfaResetNotice` to the target (D8), `catalog.audit.mfa_reset`
  (form `admin`), the metric.
- **Self-service stays as `002` shipped it.** The target recovers with the password and the
  enrolment of D11. The admin never sees a secret, a code or a password.
- _Alternatives:_ **email-only MFA reset** (a mailbox would defeat MFA), **backup codes
  only**, and **splitting MFA recovery into its own change** were rejected by Q6. A **new
  resource kind** (`mfa`) was rejected: `user` already carries the tenant, ownership and
  self-target attributes, and a new kind is a larger Cerbos change for no gain.

### D11. Forced re-enrolment after an MFA reset (Q6)

"Forces re-enrolment at the next sign-in" needs a mechanism, because a member with no
enrolled factor signs in with the password alone (`auth-and-rbac`, "Multi-factor
authentication"). The mechanism mirrors the temporary-password marker:

- `mfa-reenrol:<userId>` in `auth.verification`, value a constant, `expires_at` the same
  far-future sentinel the temp-password marker uses (so Better Auth's opportunistic cleanup
  keeps it), written by the MFA reset and the operator CLI.
- `hooks.before`: a session whose user holds the marker may reach only
  `/two-factor/enable`, `/two-factor/verify-totp`, `/get-session` and `/sign-out`; anything
  else answers like the temporary-password gate (a fixed refusal code).
- `context-resolver.ts`: a held marker rejects like a missing context on `/v1`, exactly as
  the temporary-password marker does.
- `hooks.after` on `/two-factor/verify-totp`: when the user's `twoFactorEnabled` has become
  true, delete the marker.
- An admin target is already confined to enrolment by `002` Q43; the marker makes the same
  true of a member.
- _Alternative:_ rely on the next admin to ask the member to enrol: rejected, an unconfirmed
  convention is not "forces". _Alternative:_ require a factor of everyone: out of scope
  (`002` decides who must have one).

### D12. Last-admin break-glass (Q6)

The last admin of an organization cannot ask another admin. Out of band, like `043`'s
bootstrap CLI (`apps/api/scripts/bootstrap-admin.ts`, `043` D9, Q91):

- A `tsx` CLI, `apps/api/scripts/recover-admin-mfa.ts` (package script
  `recover:admin-mfa`), never mounted, built the way the bootstrap CLI builds Better Auth
  (the `tayzu_auth` pool, `runScript`, `loadScriptConfig`). Inputs: the organization slug
  and the admin's email, from arguments; no secret is printed.
- It refuses an unknown organization and a user who is not a member of it (without
  printing account detail), and otherwise runs the same service function as D10
  (`apps/api/src/identity/mfa-reset.ts`), with the operator in place of the admin: the
  audit event is `catalog.audit.mfa_reset` form `operator` (`tayzu.identity.operator.id`
  from the CLI's `--operator` argument, an opaque id, as the bootstrap does).
- The runbook (`docs/security/secrets.md`, "Maintenance jobs and the bootstrap CLI", gains a
  section; the full text is task 14.3) states: who may run it; identity verification out
  of band (video call or an employer-confirmed request) with a named **second approver**
  recorded before the run; just-in-time access to the job like `043` D9; that the admin then
  sets a password through the reset flow (the MFA is gone, so the link alone suffices) and
  is confined to enrolment on first sign-in (D11); and that the run is reviewed afterwards
  from the audit event.
- The CLI cannot reset a password: a last admin who forgot the password and lost the factor
  first has the factor reset by the runbook, then uses the reset flow.
- _Alternative:_ a Container Apps Job and a workflow like `045`'s reversal: rejected for this
  change, since `010` provisions jobs and the CLI is the same shape as the bootstrap's;
  `010` can wrap it. Recorded as a Gate.

### D13. Mount switch and route allowlists (Q9)

The same `MOUNT_IDENTITY_ROUTES`, off by default, gates the two public routes and
`identity.users.resetMfa`. The `043` rule "no HTTP assertion about these routes before the
hand-off group" does not apply: the hand-offs are done. `ALLOWED_AUTH_ROUTES` is unchanged
and the drift test only changes its comments. `PUBLIC_ROUTE_ALLOWLIST` gains two entries.
The `identity.openapi.json` document gains the oRPC route (no schemas, as `043` Q52).
_Alternative:_ a separate `MOUNT_RECOVERY_ROUTES`: rejected by Q9.

### D14. The link target and the page (Q10)

The link points at `PASSWORD_RESET_LINK_BASE_URL` plus the fixed path `/reset-password`
and a fragment (D3). The client never supplies a `redirectTo`; the request schema rejects
the field. The page is `003`'s: until it serves `/reset-password` at that origin the link
is inert. Its preconditions are `043`'s accept-page preconditions plus two: it strips the
fragment after reading it, sends `Referrer-Policy: no-referrer`, loads no third-party
script, **and** it never submits the new password without the user's action, and it shows a
factor field when the confirm route answers `AUTH_STEP_UP_REQUIRED`. They are Gates.
_Alternative:_ accept a validated `redirectTo`: rejected by Q10.

### D15. Observability contract

Tracer, meter and logger are `@tayzu/auth`'s (`INSTRUMENTATION_SCOPE_NAME`). All names are
declared in `packages/auth/src/telemetry/identity-contract.ts` (extending `IDENTITY_SPANS`,
`IDENTITY_METRICS`, `IDENTITY_LOG_EVENTS` and `IDENTITY_ATTRIBUTE_VALUES`), mirrored in
`packages/auth/src/__fixtures__/identity-contract-expected.ts`, and enforced by the extended
`otel-smoke-check`. `apps/api` emits through the existing helpers (`emitIdentityEvent`,
`recordIdentityMetric`, `withIdentitySpan`), which sanitize span errors. `002`'s `contract.ts`
stays unchanged. **No signal carries an email, a token, a link, a password, a backup code, an
IP, a request path with an identifier or tenant free text**; `tayzu.identity.user.id` and
`tayzu.tenant.id` are opaque ids and allowed; an unknown address produces no identifier.

**Spans**

| Name                               | Required attributes                  | Where |
| ---------------------------------- | ------------------------------------ | ----- |
| `identity.password_reset.request`  | none                                 | the request route handler (the uniform path is the same span for every branch) |
| `identity.password_reset.confirm`  | `tayzu.identity.reset.mfa` (set after the factor step) | the confirm route handler |
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
| `catalog.audit.mfa_reset`                     | INFO     | form `admin`: `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.sessions.revoked`; form `operator`: `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.user.id`, `tayzu.identity.sessions.revoked` |
| `catalog.security.password_reset_denied`      | WARN     | `tayzu.identity.reset.denial_reason`; conditional `tayzu.identity.user.id` (absent when the id/token matched no row) |
| `catalog.security.recovery_email_suppressed`  | WARN     | `tayzu.identity.email.template`, `tayzu.identity.recovery.suppression`; conditional `tayzu.identity.user.id` (absent for `unknown_address`) |
| `catalog.security.self_mfa_reset_denied`      | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                           |

Reused unchanged: `auth.security.session_revoked` (gains the reasons `password_reset` and
`mfa_reset` in `SessionRevocationReason`, `identity-contract.ts` and the fixture),
`auth.security.rate_limited` (the closed scope union gains six values, D5),
`catalog.security.email_recipient_blocked`, `catalog.security.email_tenant_blocked` (not
used by the mailer, which reports `tenants_email_disabled` instead because a user has many
tenants), `catalog.security.identity_conflict_refused` (reason `target_in_other_tenant`,
existing), `catalog.security.authz_denied` and `tayzu.authz.decisions` (from the wrapper).

**Closed value sets added to `IDENTITY_ATTRIBUTE_VALUES`**

| Attribute                                  | Values |
| ------------------------------------------ | ------ |
| `tayzu.identity.reset.mfa`                 | `not_enrolled`, `totp`, `backup_code` |
| `tayzu.identity.reset.request_outcome`     | `issued`, `ineligible`, `suppressed` |
| `tayzu.identity.reset.confirm_outcome`     | `completed`, `rejected`, `factor_required`, `policy_refused`, `breach_check_unavailable` |
| `tayzu.identity.reset.denial_reason`       | `malformed_request`, `csrf_rejected`, `origin_rejected`, `not_found`, `expired`, `token_mismatch`, `not_eligible`, `factor_invalid`, `attempts_exhausted`, `policy_violation`, `breached`, `breach_check_unavailable`, `consume_conflict` |
| `tayzu.identity.recovery.suppression`      | `unknown_address`, `no_credential_account`, `banned`, `disabled_everywhere`, `no_membership`, `kill_switch`, `tenants_email_disabled`, `recipient_cap`, `ip_cap`, `global_cap`, `provider_failure` |
| `tayzu.identity.mfa_reset.path`            | `admin`, `operator` |
| `tayzu.identity.email.template`            | `invitation`, `admin_accepted`, `password_reset`, `password_changed`, `mfa_changed`, `mfa_reset`, `account_created` |
| `tayzu.identity.email.outcome`             | `sent`, `suppressed`, `failed` |
| `tayzu.auth.revocation.reason`             | `sso_link_shed`, `password_reset`, `mfa_reset` |

`tayzu.identity.sessions.revoked` is an integer. `tayzu.identity.notice.template` is not
extended (the recovery emails use `tayzu.identity.email.template`), so `045`'s extension of
the notice set does not conflict with this change.

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

### D16. Rate-limit scopes

`RateLimitScope` gains `password_reset_request`, `password_reset_confirm`,
`reset_email_recipient`, `reset_email_ip`, `reset_email_global` and
`recovery_notice_recipient`; `BucketKeyKind` gains `global`. `createRateLimitBucketStore`
keeps throwing "Unknown rate-limit scope" for a scope with no rule. The cap store's
`BUCKETS` table gains four rows (`reset_recipient`, `reset_ip`, `reset_global`,
`recovery_notice_recipient`). `server.ts` builds the rules from `Config`. Keys are
hashed by the store; the IP and the HMAC key never reach a signal. `TRUST_PROXY` makes the
IP-keyed limiters (route and email) as trustworthy as it is configured (a Gate inherited from
`043`).

### D17. The DAST probe (Q11)

`scripts/ci/dast-probe.ts`, called by `scripts/ci/dast.sh` after the ZAP scan and against
the same sandbox tenant, non-sending sender (`EMAIL_PROVIDER=none`) and mount switch on. It
sends, to the accept route and both reset routes: well-formed and malformed JSON, an
oversized body, `__proto__` and `constructor` keys, a wrong content type, a missing CSRF
header and a bad `Origin`, a replayed token, an unknown and a known address (the request
route), and a burst past the limiter. It fails the run on any 5xx, on a stack trace or
reflected input in a body, and when the request route's answers for a known and an
unknown address differ in status, headers (names) or body. `dast-coverage.ts`'s coverage
rule is extended to count probe responses. The probe has no OpenAPI dependency; a
hand-written OpenAPI fragment was rejected because the routes' bodies are not in any
generated document and a second schema source would drift. Closes `043`'s ticket "DAST
probe of the accept route".

### D18. No migration; what `045` must classify

No table, column or policy of the database changes, and migrations `0012`-`0014` stay
reserved for `045`. The two identifier families of D3 and D11 are the only persistent
additions. `045`'s completeness test (its design, "completeness test") classifies every
`auth.verification` family by pattern and fails on an unlisted one; it must add:

| Family                | Classification | Reason |
| --------------------- | -------------- | ------ |
| `password-reset:<id>` | purge step: delete rows whose `value` carries a user id of the deleted tenant's sole members, or exempt as short-lived (30 minutes) keyed by a random id | the row holds a user id, not a tenant |
| `mfa-reenrol:<userId>`| purge step: delete with the user's other `verification` markers (`temp-password:`, `sso-link:`) | keyed by user id |

`044` lands first, so `045`'s task for the test adds these two lines when it rebases; this
change's `verification-families.int.test.ts` is the early-warning list. `docs/security/data-retention.md`
documents both families, their lifetimes and the fact that `auth.rate_limit` now also holds
hashed reset caps (pseudonymous, no tenant, exempt as `045` already treats the table).

### D19. Docs and the ADR

- **ADR-0023** (`docs/adr/0023-password-reset-is-tayzu-owned-and-mfa-aware.md`; `0019` is
  reserved for `045`, `0022` is the last used): Tayzu owns the reset routes (D1); the mailbox
  alone never changes an MFA-enrolled user's password or removes a second factor (D6, D10);
  a reset is allowed only for credential accounts (D4). Written the same day the first
  decision lands (task 14.1).
- `docs/security/attack-surfaces.md`: the "Public accept route" section becomes "Public
  routes" with the reset rows; "Blocked routes" notes that Better Auth's three reset routes
  stay blocked and why; "Email and phishing (SEC11)" no longer says the invitation email is
  the only email and records the SEC11 answers of D5; the rate-limit row; "Pending".
- `docs/security/secrets.md`: the new variables (D9), the shared kill switch's wider scope,
  the break-glass section (D12).
- `docs/security/data-retention.md` and `docs/security/crypto-inventory.md` (token
  generation and digest, backup-code and TOTP decryption path, reuse of the password hash).
- `docs/catalog/auth-and-rbac.md` (the auth reference): the reset flow, the re-enrolment
  gate and the new allowlist notes.
- `docs/architecture/system-diagram.md` (Mermaid) and its image: two new public routes on
  the API app, the end user's mail client as the receiver of reset and notice mail, the
  operator as an actor of the break-glass CLI, and the `auth.verification` writes. The
  `system-diagram.test.ts` check stays green.
- `apps/api/CLAUDE.md` and `packages/auth/CLAUDE.md`: layout lines for the new modules and
  the rule that Better Auth's reset routes stay closed.

### D20. Order of work and the Checkpoint 3 stop

Group 9 starts with the policy task; no later task of group 9 begins before the human
approves it. Everything else is code and tests. No database migration exists in this change,
so the only Checkpoint 3 item is the Cerbos change.

## Observability contract

See D15 for the full contract (spans, metrics, log events, value sets and enforcement).

## Security considerations (SSA SEC01-SEC16 posture)

Read at design time against `.claude/skills/ssa-validator` through `r3-references.md` section
5; the formal pre-assessment is task 15.2 (the `vcdm-ssa-validator` subagent, before
Checkpoint 2). A GAP in tenant isolation, access control, injection, secrets or logging would
block.

| Section | Posture | Where |
| ------- | ------- | ----- |
| SEC01 System diagram | applies | D19: routes, mail client actor, operator actor |
| SEC02 Attack surfaces | applies | D2, D13, D19: two unauthenticated routes, authenticated by token possession, limited and mounted behind the switch; Better Auth's closed |
| SEC03 Access control | applies | D10: Cerbos action, step-up, wrapper order, cross-tenant 404, self-target deny; the public routes are justified exceptions with limits, listed in the allowlist test |
| SEC04 Password storage | applies | D7: one hash function shared with sign-in; no SSO-only password creation (D4); squatted-account recovery |
| SEC05 Cryptography | applies | D3: 256-bit CSPRNG token, sha256 digest (high entropy, no salt needed), constant-time compare; D5: HMAC recipient key reused; D6: Better Auth's symmetric decrypt and OTP |
| SEC06 Application misuse | applies | D8 notices (password, MFA changes), enumeration (D4), replay and out-of-order confirm (D3, D2), rate limits (D5, D16) |
| SEC07 Dependencies | applies | one direct dependency, already locked (D6) |
| SEC08 File upload | N/A | no upload surface |
| SEC09 Secrets in code | applies (light) | fixtures generate tokens; nothing real-looking; `DATABASE_URL` never printed |
| SEC10 Secret management | applies | no new secret; D9 variables in `secrets.md`; link base URL is not a secret |
| SEC11 Phishing | applies, core | one clickable link, justified (the OWASP-permitted forgot-password link), fixed templates, single recipient, no attachments, no tracking, config-only origin, caps, kill switch, allowlist, demo suppression (D5, D8). Extends `043`'s recorded answers; it does not replace them |
| SEC12 Testing/QA | applies | tasks 6-11 scenario tests, the DAST probe (D17), actor parity row |
| SEC13 Secure deployment | partial | D9 config and the Gates |
| SEC14 Infra permissions | N/A for the change | no migration, no grant; `tayzu_auth` already has CRUD on `auth.verification` |
| SEC15 Network/host | partial | no new egress: ACS and Pwned Passwords as before; FQDN allowlist stays `043`'s ticket |
| SEC16 Security logging | applies | D15: audit and security events, opaque ids, sampling-exempt |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu | Why |
| ----- | ---- | ----- | --- |
| Password reset and MFA recovery | public docs describe neither (MFA "encouraged", SSO-delegated) | a full flow, D1-D12 | Tayzu keeps local credentials (`002`, ADR-0021 has Visma Connect as the primary IdP but local sign-in coexists); there is no Port analogue to copy, so the design follows OWASP, NIST and the SSA |

## Risks / Trade-offs

- **Silent denial of recovery by cap exhaustion** → an attacker who knows an address can
  burn its 5 emails per hour, and a distributed one the global 600. Mitigated by IP caps,
  the short window, alerts on `recipient_cap` and `global_cap` (a Gate for `010`), the kill
  switch as a manual lever, and a ticket for proof-of-work. Chosen over a visible 429, which
  is an oracle.
- **The minimum response duration is not constant work** → under a slow database the
  eligible branch can exceed 400 ms and become distinguishable. Mitigated by calibrating the
  value against the eligible branch's p99 in staging (a Gate) and a ticket for a
  constant-work path.
- **A detached send can be lost on a crash** → the token is valid and unmailed; the user
  requests again (the newest token wins). Graceful shutdown drains in-flight sends.
- **Mailbox compromise changes the password of a user without a second factor** → inherent
  to email recovery (NIST treats email as a weak authenticator); mitigated by session
  revocation, the password-changed notice to the same mailbox, and Q1 for enrolled users.
  Admins always have a factor (`002` Q43).
- **A compromised admin with a fresh step-up can reset a member's factor** → mitigated by the
  member notice, the audit event with the admin id, the forced re-enrolment confinement and
  the self-target deny; the OWASP "second approver or delay" is a ticket.
- **The factor verifier duplicates Better Auth's check** → drift guarded by a test against
  the installed endpoint (D6); a Better Auth upgrade runs it.
- **A reset burns a breach-service outage into "cannot reset"** → the token is not consumed,
  the error is sanitized, and a retry works. Availability depends on `api.pwnedpasswords.com`
  as sign-up already does (`043` ticket "Offline breached-password corpus").
- **Notices fail quiet under their cap** → 10 per day is above normal; a suppression is
  logged and alertable. A raised cap is a configuration change.
- **`auth.verification` is shared** → the two new families are prefix-distinct and the
  prefix test (D3) prevents a collision with Better Auth's.
- **The reset link is inert until `003`** → documented, and a Gate.
- **Multi-tenant members** → see Open Questions.
- **Dot-alias and case variants of an address bypass the per-recipient cap** → known, shared
  with `043`'s ticket "Recipient-cap alias normalization".

## Migration Plan

- **Database:** none. State it in the PR: no migration, no `0012`-`0014` change.
- **Policy:** one Cerbos change (D10), shipped through the SHA-pinned pipeline with the app
  revision; the new action is denied for everyone but a same-tenant admin until the bundle
  deploys, so an app deployed before its policy simply denies.
- **Deploy order:** policy bundle with or before the app; `PASSWORD_RESET_LINK_BASE_URL`
  and the other variables set before `MOUNT_IDENTITY_ROUTES` is turned on (startup fails
  otherwise, D9).
- **Rollback:** turning the switch off removes the three routes at once (`043` D15). The
  token rows expire by themselves; the `mfa-reenrol` markers persist (and keep confining
  those users to enrolment) until cleared, which is intended. A rollback of the app revision
  leaves the policy action in place harmlessly.

## Gates

Human-owned, for the first deployment (`010`). `043`'s list stays in force; those that bear
on this change are restated, then this change's own.

**Inherited from `043` and `002` (apply to the new routes):**

- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the connection
  string in Key Vault (`043` Q28); `EMAIL_PROVIDER` set explicitly in every deployed
  environment; CI, DAST and demo tenants use the non-sending sender.
- `TRUST_PROXY` configurable and set to the exact ingress hop count: the route and email IP
  limiters key on `request.ip`.
- The rate-limit stores shared across replicas (the reset limiters and caps already use the
  DB-backed store).

**This change's own, before `MOUNT_IDENTITY_ROUTES` is turned on:**

1. `044` is merged and its tasks are ticked, so the recovery path for a squatted account
   (`043` Gate) exists.
2. `003` serves the reset page at `PASSWORD_RESET_LINK_BASE_URL` with the preconditions of
   D14.
3. The Cerbos change of task 9.1 is approved (Checkpoint 3) and deployed.
4. The DAST probe of D17 passes against the sandbox with the switch on.
5. The break-glass runbook of D12 is adopted: named approvers and just-in-time access in
   place; `010` decides whether to wrap the CLI in a job.
6. Alerts (with `010`) on `catalog.security.recovery_email_suppressed` with the reasons
   `recipient_cap`, `ip_cap`, `global_cap` and `provider_failure`, on
   `catalog.security.password_reset_denied` with `attempts_exhausted` and `consume_conflict`,
   and on `catalog.audit.mfa_reset`.
7. `PASSWORD_RESET_MIN_RESPONSE_MS` is set above the p99 of the eligible request branch
   measured in staging.
8. `INVITATION_EMAIL_KILL_SWITCH` is documented to operators as the stop for every email.

## Tickets

| Ticket | Item |
| ------ | ---- |
| Email-change notice | No email-change path exists; when one does, it needs re-authentication and a notice to the old address (OWASP; SEC06). |
| Backup-code-use notice | A used backup code could notify the user (SEC06). |
| Second approver or delay for admin MFA reset | OWASP suggests a delay or a second approver; evaluate after the first use (SEC03). |
| Constant-work request path | Replace the minimum-duration padding with equal work for known and unknown addresses (SEC06). |
| Proof-of-work or CAPTCHA on the request route | A bounded, privacy-respecting add-on against cap exhaustion (SEC06). |
| Rename `INVITATION_EMAIL_KILL_SWITCH` | It now stops every email; a rename is breaking, so deprecate-and-alias (SEC11). |
| SSO-only password setting | `025` decides whether an SSO-only user may add a local password (`002` Q44). |
| Reset-row janitor | If `auth.verification` accumulates `password-reset:` rows between requests, add a scheduled delete (D3 cleans opportunistically). |
| Remaining-backup-codes display | `003` could show how many codes are left; Better Auth exposes no count (r1 section 2.1). |
| Per-tenant cap on `identity.users.create` | Unchanged from `043` Q147 O-10; the account-created notice reduces but does not remove the squatting flood. |
| Admin MFA reset as a job | `010` may wrap the CLI of D12 in a Container Apps Job with the `045`-style reviewed workflow. |

## Hand-offs from `002` and `043` closed by this change

| Source | Item | Closed by |
| ------ | ---- | --------- |
| `002` ticket 9 (VCDM pre-assessment of `002`, SEC06) | Explicit scope for forgot-password and reset, with enumeration resistance | D2, D4; spec "The reset request answers identically for every address" |
| `002` Q14 | Where reset lives: a new change `044` reusing `043`'s email sender | D1, D5 |
| `002` Q46, task 23.16 and `043` Q92, ticket "Password, MFA and email-change notifications" | Notices for password, MFA and email changes | D8 (password and MFA built); the email-change part is a ticket |
| `043` Gate: "`044` ships before the mount switch is turned on" | Recovery path for a squatted account | D7, D8 and Gates 1 and 3 |
| `043` ticket "Account squatting" | A notice to the address on creation (SEC04) | `AccountCreatedNotice`, D8; the per-tenant cap on `users.create` stays a ticket |
| `043` ticket "DAST probe of the accept route" | A scripted probe for the first unauthenticated route | D17 |
| `043` temp-password expiry dead end (`auth.ts` expired-marker branches) | A user with an expired temporary password has no way back | D7 step 4 |
| `043` Gate: `003` page hygiene | Fragment stripping, `Referrer-Policy`, no third-party script | D14 extends it to the reset page |
| `043` D5 | `EmailTemplate` is a closed union to which later changes add | D8 adds five; `045` adds one after |
| `043` D15 | The mount switch is also the rollback | D13 |
| `045` design, completeness test | New identifier families must be classified | D18 |

Not closed here: `043`'s "User notifications" (SSO link, unlink, shed, status), "Per-recipient
oracle" (the invitation gate's visible 429 stays; the reset path avoids it by design),
"Recipient-cap alias normalization", "Persistent per-tenant email-disable list" and
"Bounce and complaint handling".

## Resolved decisions (asked and approved in chat, 2026-10-14)

All eleven were approved by the human on 2026-10-14 with the recommended option. The text
below is the approved text.

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

The final password write goes through Better Auth's internal adapter (hashing, NFC, the 8.1
password policy and the breach check apply), and Better Auth's built-in
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

## Open Questions

One question remains for the human. It changes the specs (one scenario) and one task, so it
is asked in chat before `tasks.md` is final; the artifacts are written for the recommended
option.

**OQ1. May an admin of one tenant reset the second factor of a member who also belongs to
another tenant?** A user and their second factor are global to Better Auth, so the reset
affects the user in every tenant, not only the admin's.

- **Option A (recommended): refuse.** The operation answers `CATALOG_VALIDATION_FAILED` when
  the target has any membership outside the caller's tenant, logs
  `catalog.security.identity_conflict_refused` (`target_in_other_tenant`) and changes nothing;
  such a user is recovered by the operator runbook (D12). _Why:_ one tenant's admin must not
  change a credential that protects the user in other tenants; `043` already limits the ban
  write to single-membership users for the same reason (`identity-router.ts`, `setStatus`).
  Costs: multi-tenant members need an operator, which is rare today and `042-multi-org` can
  revisit.
- **Option B: allow, global effect.** Any admin of any of the user's tenants may reset;
  the user is notified and confined to re-enrolment everywhere. Simpler to operate, but a
  tenant admin gains control over a credential that other tenants rely on.
- **Option C: allow only when every other tenant also has an admin approval.** Strongest,
  but it needs a cross-tenant approval flow that does not exist.
