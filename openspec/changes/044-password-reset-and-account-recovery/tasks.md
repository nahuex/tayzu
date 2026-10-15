# Tasks: 044-password-reset-and-account-recovery

**How to execute these tasks (Agentic TDD).** Every task below, except the
tasks marked _(setup)_, is **one self-contained red-green-refactor cycle**:

1. **Red.** Write only the test named in the task's _Verify_ clause. Run it
   and see it **fail for the expected reason**: a missing behavior, not a
   typo or a missing import. With the `test-writer`/`implementer` split, this
   step belongs to `test-writer`.
2. **Green.** Write the minimum production code that makes the test pass.
   Do not change the test. This step belongs to `implementer`.
3. **Refactor.** Clean up with every test green. Run
   `pnpm --filter <pkg> test`, `pnpm lint` and `pnpm typecheck`.
4. Tick the box only when all three steps are done, and commit with the task
   number (for example `feat(auth): 6.1 reset request answers uniformly`).
   Subagents never commit; the orchestrator does.

A task marked **(Checkpoint 3)** adds or changes a Cerbos policy: it is written
by `policy-writer` under `policies/` only, proved with `pnpm policy:compile`, and
the policy with its compile output is presented in chat for the human's separate
approval before any later task that depends on it begins (root `CLAUDE.md`). This
change has no migration, so task 9.1 is its only Checkpoint 3 item.

After each implementer step, `observability-auditor` checks that the telemetry
declared in design D15 exists for that task's code. Scenario names in _Verify_
clauses are the `####` scenarios of
`specs/password-reset-and-account-recovery/spec.md` (and, where stated, of the
two delta specs). Tasks follow design D1-D20 and the Resolved decisions Q1-Q11.
Open Question OQ1 (design) affects tasks 9.4 and the spec scenario "A member of
several tenants is refused"; the tasks are written for its recommended option and
change only if the human answers otherwise.

## 1. Setup and shared enums

- [ ] 1.1 _(setup)_ Add `@better-auth/utils` at exactly `0.4.2` (the version already locked for Better Auth) as a direct dependency of `@tayzu/auth`. Verify: `pnpm install --frozen-lockfile` succeeds, `git diff pnpm-lock.yaml` shows only the new importer entry, `pnpm audit --prod` is clean, `pnpm --filter @tayzu/auth typecheck` passes, and `docs/security/dependencies.md` lists the dependency with the reason "TOTP check of the reset confirmation (044 D6)".
- [ ] 1.2 Extend `RateLimitScope` with `password_reset_request`, `password_reset_confirm`, `reset_email_recipient`, `reset_email_ip`, `reset_email_global` and `recovery_notice_recipient`, and `BucketKeyKind` with `global`. Verify: `packages/auth/src/rate-limit/invitation-rate-limit-store.int.test.ts`, new case "the six 044 scopes consume under their rules, a `global` key is one bucket, and a scope with no rule still throws 'Unknown rate-limit scope'".
- [ ] 1.3 Add `password_reset` and `mfa_reset` to `SessionRevocationReason` and to the `tayzu.auth.revocation.reason` value set. Verify: `packages/auth/src/session-revoked-telemetry.test.ts`, new cases "`emitSessionRevoked` accepts `password_reset` and `mfa_reset` and the log event carries the reason" and "the reason set equals `sso_link_shed`, `password_reset`, `mfa_reset`".
- [ ] 1.4 Export from `packages/auth/src/auth.ts` the one password-hash function (NFC, then `hashPassword`) that `emailAndPassword.password.hash` already uses, and make the config use that export. Verify: `packages/auth/src/auth-instance.test.ts`, new case "the exported hasher's output verifies through the instance's `password.verify`, and NFC and non-NFC spellings of one password verify each other".

## 2. Reset token (pure module and store; no migration)

- [ ] 2.1 `packages/auth/src/identity/reset-token.ts`: generate a 128-bit id and a 256-bit token (base64url), digest (sha256 hex), constant-time verify with one dummy comparison when the record is missing or malformed. Verify: `packages/auth/src/identity/reset-token.test.ts`, cases "id is 22 and token 43 base64url characters from distinct random draws", "verify accepts the right token and rejects a wrong one", "a missing digest still performs one `timingSafeEqual` and returns false".
- [ ] 2.2 The strict codec of the stored value `v1:<digest>:<userId>:<failures>`: format, parse, reject an unknown version, a malformed digest, a negative or non-integer counter. Verify: `packages/auth/src/identity/reset-token-value.test.ts`, cases "round trip", "unknown version is a non-match", "malformed digest or counter is a non-match".
- [ ] 2.3 `apps/api/src/identity/reset-token-store.ts` `issue`: in one `authPool` transaction under the per-user advisory lock, delete the user's earlier `password-reset:` rows and every expired `password-reset:` row, then insert `password-reset:<id>` with the value of 2.2 and a 30-minute expiry. Verify: `apps/api/src/identity/reset-token-store.int.test.ts`, scenarios "The newest link wins" (store level), "Only a digest is stored" (no row holds the token in identifier or value) and a case "expired rows are purged by the next issue".
- [ ] 2.4 `reset-token-store` `lookup`: read by id, check the digest in constant time, report `found | not_found | expired | token_mismatch` for internal reasons only. Verify: `apps/api/src/identity/reset-token-store.int.test.ts`, scenario "A token expires after 30 minutes" with a token issued 30 minutes and one second ago, and cases for an unknown id and a wrong token.
- [ ] 2.5 `reset-token-store` `recordFailure`: compare-and-swap rewrite of the counter, deletion of the row at the fifth failure. Verify: `apps/api/src/identity/reset-token-store.int.test.ts`, case "five failures delete the row, concurrent failures are not lost" (scenario "Five wrong factors burn the token", store level).
- [ ] 2.6 `reset-token-store` `consume`: `delete ... returning` inside the caller's transaction, zero rows means conflict. Verify: `apps/api/src/identity/reset-token-store.int.test.ts`, scenarios "A token is single use" and "A concurrent double submit completes once" (store level, two parallel consumes, exactly one wins).
- [ ] 2.7 `apps/api/src/identity/verification-families.int.test.ts`: enumerate the `auth.verification` identifier prefixes this change writes (`password-reset:`, `mfa-reenrol:`) by running each writer once, and fail on any other new prefix. Verify: that file, cases "the reset writers produce only the two declared prefixes" and "no row's identifier or value contains a raw token". It is the list `045`'s completeness test consumes (design D18).

## 3. Email templates and the reset link

- [ ] 3.1 Add the five `kind`s (`PasswordResetEmail`, `PasswordChangedNotice`, `MfaChangedNotice`, `MfaResetNotice`, `AccountCreatedNotice`) to the closed `EmailTemplate` union and to both `TEMPLATE_NAMES` tables. Verify: `packages/auth/src/identity/email/email-sender.test.ts`, case "the recording sender, the non-sending sender and the allowlist wrapper accept each of the five kinds, and the allowlist wrapper's refusal log names each by its `tayzu.identity.email.template` value".
- [ ] 3.2 Renderer of `PasswordResetEmail`: fixed subject, exactly one link, only the link and the expiry text interpolated, HTML escaped. Verify: `packages/auth/src/identity/email/password-reset-email-template.test.ts`, scenario "The template carries no free text" (an organization named `<b>Pay now</b>` appears nowhere) and the case "the body holds exactly one link".
- [ ] 3.3 Renderers of the four notices: constant text, no link, no interpolated value. Verify: `packages/auth/src/identity/email/recovery-notice-templates.test.ts`, scenario "A notice carries no free text" for `AccountCreatedNotice` and `MfaResetNotice`, and cases "each notice has a fixed subject, no URL, no placeholder" for all four.
- [ ] 3.4 The Azure adapter renders the five kinds through the shared renderers, with tracking disabled and no Reply-To. Verify: `packages/auth/src/identity/email/azure-communication-email.test.ts`, cases "each of the five kinds is sent with the rendered subject and body", "engagement and click tracking are off and no Reply-To is set".
- [ ] 3.5 `apps/api/src/identity/password-reset-link.ts`: the link from the configured base URL, the fixed path `/reset-password` and the fragment `#reset=<id>&token=<token>`. Verify: `apps/api/src/identity/password-reset-link.test.ts`, scenario "The link carries the token in the fragment on the configured origin" (forged `Host` and `X-Forwarded-Host` are ignored; id and token appear only in the fragment).

## 4. Configuration and email caps

- [ ] 4.1 `PASSWORD_RESET_LINK_BASE_URL` in `config.ts`, parsed like `INVITATION_LINK_BASE_URL`. Verify: `apps/api/src/config.test.ts`, cases "outside test it is required, `https` and one of `ALLOWED_ORIGINS`", "under test it is optional and `http` or `https`", "an error names the variable and never its value".
- [ ] 4.2 The limits and the minimum response: `PASSWORD_RESET_REQUEST_`, `_CONFIRM_`, `_RECIPIENT_`, `_IP_`, `_GLOBAL_RATE_LIMIT_MAX`/`_WINDOW_SECONDS`, `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_MAX`/`_WINDOW_SECONDS` and `PASSWORD_RESET_MIN_RESPONSE_MS`, with the defaults of design D9. Verify: `apps/api/src/config.test.ts`, cases "every default equals design D9", "a zero, negative or non-integer value fails startup", "`PASSWORD_RESET_MIN_RESPONSE_MS` outside 1..5000 fails startup" and scenario "A zero limit fails startup".
- [ ] 4.3 Four rows in the cap store's `BUCKETS` table (`reset_recipient`, `reset_ip`, `reset_global`, `recovery_notice_recipient`) and the rules built from `Config` in `createApp`. Verify: `apps/api/src/identity/email-cap-store.int.test.ts`, scenario "Reset caps and invitation caps are counted apart" and cases "an unsupported scope still throws" and "the four buckets hold under two store instances over one database".

## 5. Eligibility and the recovery mailer

- [ ] 5.1 `globalUserBanned` in the auth-schema repository module (parameterized SQL, user-only read). Verify: `apps/api/src/identity/auth-repository.int.test.ts`, cases "true for a banned user, false for an unbanned one, `undefined` for no user" and the lint test `auth-repository-lint.test.ts` still passes.
- [ ] 5.2 `apps/api/src/identity/recovery-eligibility.ts`: the enum of design D4 from the repository reads and `userSync.readStatus` for each membership tenant. Verify: `apps/api/src/identity/recovery-eligibility.int.test.ts`, scenarios "An SSO-only user gets no password through a reset", "Disabled everywhere is not recoverable, disabled somewhere is", "The address is canonicalized", and cases for a banned user and a user with no membership.
- [ ] 5.3 `apps/api/src/identity/recovery-mailer.ts` reset email: kill switch, all-tenants-disabled, global, IP and recipient caps in the order of design D5, silent refusals with `catalog.security.recovery_email_suppressed`, detached send with tracked in-flight work and a `drain()`. Verify: `apps/api/src/identity/recovery-mailer.test.ts`, scenarios "A per-recipient cap is silent", "A provider failure is invisible to the caller" and cases "the order is kill switch, tenants, global, IP, recipient", "a refused send consumes no later bucket", "`drain()` waits for an in-flight send".
- [ ] 5.4 The mailer's shared controls: recipient-domain allowlist wrapper and disabled-tenant list. Verify: `apps/api/src/identity/recovery-mailer.test.ts`, scenarios "A demo login cannot send mail" (all tenants disabled suppresses, one enabled tenant sends) and "The kill switch and the allowlist apply".
- [ ] 5.5 The mailer's notice path: kill switch, tenants, `recovery_notice_recipient` cap, never throws. Verify: `apps/api/src/identity/recovery-mailer.test.ts`, scenarios "A full notice bucket suppresses and logs" and "A failing provider never breaks the operation" (notice level).

## 6. The request route

- [ ] 6.1 `POST /v1/auth/password-reset/request`: strict parse, canonical address, eligibility, token issue, detached send, uniform `200 { "accepted": true }`, registered inside the mount block. Verify: `apps/api/src/password-reset-request.http.int.test.ts`, scenarios "An unknown address and an eligible account get the same answer" and "A malformed request fails before any lookup".
- [ ] 6.2 The uniform answer for every ineligible or suppressed state. Verify: `apps/api/src/password-reset-request.http.int.test.ts`, scenario "Every refusal state gets the same answer" (SSO-only, banned, disabled everywhere, full cap, kill switch, failing provider), asserting equal status, header names and body.
- [ ] 6.3 The minimum response duration and the detached send. Verify: `apps/api/src/password-reset-request.http.int.test.ts`, scenario "A slow provider does not slow the response" with a fake clock, and a case "an unknown and an eligible address both return at the minimum duration, not before".
- [ ] 6.4 CSRF header, `Origin` and `redirectTo` handling on the request route. Verify: `apps/api/src/password-reset-request.http.int.test.ts`, scenarios "A cross-site request is refused before any lookup" and "The client cannot choose where the link points".
- [ ] 6.5 The per-IP limiter of the request route, shared across replicas. Verify: `apps/api/src/password-reset-limits.http.int.test.ts`, scenario "The eleventh request in a minute is limited" (429 `AUTH_RATE_LIMITED` with `Retry-After`, before any account lookup) and a case "two app instances over one database share the bucket".
- [ ] 6.6 Public-route allowlist entries for both reset routes, the mount-switch behavior and Better Auth's closed routes. Verify: `apps/api/src/mount-gate.int.test.ts` scenario "Off by default"; `apps/api/src/route-auth-allowlist.int.test.ts` scenario "A route outside the allowlist cannot be public"; `apps/api/src/auth-route-allowlist.test.ts` scenario "Better Auth's own reset routes stay closed" (the three paths stay blocked and answer `404`; only the comments change)); `route-auth-allowlist.int.test.ts` also scenario "No email-only removal of a second factor exists" (no public route or allowlisted Better Auth route disables or removes a second factor).

## 7. The confirm route

- [ ] 7.1 `packages/auth/src/identity/reset-factor.ts` TOTP check: decrypt with the instance's `secretConfig`, verify with `createOTP`, treat an unverified enrolment as not enrolled. Verify: `packages/auth/src/identity/reset-factor.int.test.ts`, scenario "A valid TOTP code completes the reset" (verifier level) and the drift case "for the current, previous and next windows and a wrong code, the verifier and the installed `/two-factor/verify-totp` agree".
- [ ] 7.2 Backup-code check: decrypt, constant-time comparison of each stored code, spend by compare-and-swap. Verify: `packages/auth/src/identity/reset-factor.int.test.ts`, scenario "A backup code completes the reset and is spent" and a case "two parallel uses of one code spend it once".
- [ ] 7.3 Failure accounting: the account's `failedVerificationCount` and `lockedUntil` with Better Auth's 10 and 900 seconds, reset on success. Verify: `packages/auth/src/identity/reset-factor.int.test.ts`, cases "ten failures lock the account for sign-in too" and "a success resets the counter".
- [ ] 7.4 `POST /v1/auth/password-reset/confirm` skeleton: limiter, strict parse and limits, token lookup, eligibility re-check, the uniform `404`. Verify: `apps/api/src/password-reset-confirm.http.int.test.ts`, scenarios "Every token problem looks the same" and "Cheap checks run first", plus `mount-gate.int.test.ts` and `route-auth-allowlist.int.test.ts` now covering the confirm route.
- [ ] 7.5 CSRF header and `Origin` on the confirm route. Verify: `apps/api/src/password-reset-confirm.http.int.test.ts`, scenario "A cross-site confirmation is rejected the same way" (the token stays unconsumed).
- [ ] 7.6 The factor gate. Verify: `apps/api/src/password-reset-confirm.http.int.test.ts`, scenarios "The link alone does not change an enrolled user's password", "A user without a second factor needs only the link" and "A reset keeps the second factor".
- [ ] 7.7 The per-token failure budget over HTTP. Verify: `apps/api/src/password-reset-confirm.http.int.test.ts`, scenario "Five wrong factors burn the token" (five `AUTH_STEP_UP_REQUIRED`, then the uniform `404` even with the right factor).
- [ ] 7.8 Password policy and breached-password check before consumption. Verify: `apps/api/src/password-reset-confirm.http.int.test.ts`, scenarios "A weak password is refused and the token survives", "A breached password is refused and the token survives" and "A breach-service outage does not burn the token".
- [ ] 7.9 The completion transaction of design D7: consume, hash and write the password, delete other tokens and the temporary-password marker, set `emailVerified`, delete every session of the user, emit `session_revoked` per session. If the adapter does not join the ambient transaction this test fails red; stop and present the fallback of D7 in chat before coding. Verify: `apps/api/src/password-reset-effects.int.test.ts`, scenarios "Every session in every tenant ends", "The new password signs in", "A reset does not sign the user in" and "A failed write leaves everything as it was".
- [ ] 7.10 Concurrency. Verify: `apps/api/src/password-reset-effects.int.test.ts`, scenarios "A token is single use" and "A concurrent double submit completes once" over HTTP.
- [ ] 7.11 The recovery and invariant scenarios. Verify: `apps/api/src/password-reset-effects.int.test.ts`, scenarios "A reset is the way out of an expired temporary password", "A reset recovers a squatted account", "A reset never revives a banned or disabled user" and "Machine credentials are untouched".

## 8. Recovery notices

- [ ] 8.1 `AccountNoticePort` in `CreateAuthOptions`, and the password-changed notice after a successful `/change-password`. Verify: `packages/auth/src/account-notices.int.test.ts`, scenario "A password change is announced" and the case "a failed change sends none".
- [ ] 8.2 The second-factor notices: a TOTP factor becoming verified for a session user, and regenerated backup codes; never on the sign-in challenge. Verify: `packages/auth/src/account-notices.int.test.ts`, scenario "A second-factor change is announced" (enrolment and regeneration) and the case "a sign-in challenge sends none".
- [ ] 8.3 The password-changed notice after a completed reset, sent after the commit. Verify: `apps/api/src/password-reset-notice.int.test.ts`, cases "one `PasswordChangedNotice` is sent to the user's address after the commit", "none is sent when the transaction rolls back" and, for scenario "A failing provider never breaks the operation", "a failing provider leaves the completed reset completed".
- [ ] 8.4 `identity.users.create` sends the account-created notice after `addMember`, through `CreateIdentityRouterOptions.recoveryMailer`; the response and the failure behavior are unchanged. Verify: `apps/api/src/admin-user-creation.int.test.ts`, scenario "A squatted address is warned" and cases "the response body equals the pre-044 body" and "a failing notice does not fail the creation".
- [ ] 8.5 The notice buckets are apart from `043`'s. Verify: `apps/api/src/identity/recovery-notice-buckets.int.test.ts`, the `identity-lifecycle-and-org-admin` delta scenario "Creating a user sends the account-created notice outside these buckets" and the scenario "Notices and reset emails count apart".

## 9. Admin MFA reset

- [ ] 9.1 **(Checkpoint 3)** `policy-writer`: add `resetMfa` to the self-target deny rule of `policies/resource_policies/user.yaml` and its cases to `user_test.yaml` (a same-tenant admin allowed, a member denied, an admin of another tenant denied, an admin on themselves denied). Verify: `pnpm policy:compile` passes and prints the new cases; present the policy and the compile output in chat and wait for the human's approval before tasks 9.2-9.7.
- [ ] 9.2 `RESOURCE_KINDS`/operation name for `users.resetMfa`, and the wrapper's self-target signal as a set of two actions. Verify: `apps/api/src/identity/define-identity-operation.test.ts` and `identity-attributes.test.ts`, scenario "Self-target is refused" (refusal plus `catalog.security.self_mfa_reset_denied` with the tenant and the actor id) and the existing `updateStatus` case unchanged.
- [ ] 9.3 `apps/api/src/identity/mfa-reset.ts`, the service shared by the admin operation and the CLI: one transaction under the per-user lock deleting the `twoFactor` row, clearing `twoFactorEnabled`, writing `mfa-reenrol:<userId>`, deleting the user's sessions (reason `mfa_reset`) and any `trust-device-%` rows, then the notice, `catalog.audit.mfa_reset` and the metric. Verify: `apps/api/src/identity/mfa-reset.int.test.ts`, scenario "An admin resets a member's lost factor" (factor gone, sessions rejected, marker written, `MfaResetNotice` sent, audit event with the admin id and the member's opaque id) and a case "the operator form logs `tayzu.identity.operator.id`".
- [ ] 9.4 The refusals of the service. Verify: `apps/api/src/identity/mfa-reset.int.test.ts`, scenarios "A target with no second factor is refused" and "A member of several tenants is refused" (the latter per OQ1 option A; logs `catalog.security.identity_conflict_refused` with `target_in_other_tenant`), nothing changes in either.
- [ ] 9.5 `identity.users.resetMfa` as a branded procedure: `POST /v1/users/{user}/mfa/reset`, high-risk, `inputStructure: 'detailed'`, behind the mount switch, in `openapi/identity.openapi.json`. Verify: `apps/api/src/identity/identity-router-structure.test.ts` (the procedure is branded) and `apps/api/src/identity-openapi.test.ts` (route listed with `x-tayzu-risk: high`), and `pnpm --filter @tayzu/api contract:generate` then `contract:check` report no drift.
- [ ] 9.6 The authorization matrix over HTTP. Verify: `apps/api/src/identity-authorization-matrix.http.int.test.ts`, new rows for scenarios "A member cannot reset anyone's factor" (member and machine `member` token, existing and unknown targets alike), "Step-up is required", "A target in another tenant looks like a missing one" (same body as an unknown address), "An admin resets a member's lost factor" and "Humans and agents take the same path".
- [ ] 9.7 The exported path of the new route is its template. Verify: `apps/api/src/telemetry-paths.http.int.test.ts`, scenario-style case "`POST /v1/users/marker-user@example.com/mfa/reset` and its percent-encoded form export `/v1/users/{user}/mfa/reset` and no marker".

## 10. Forced re-enrolment and the break-glass CLI

- [ ] 10.1 The `mfa-reenrol:<userId>` marker module in `@tayzu/auth` (write with the far-future sentinel expiry, has, clear). Verify: `packages/auth/src/identity/mfa-reenrol-marker.int.test.ts`, cases "write then has is true", "clear removes it", "Better Auth's opportunistic cleanup does not remove it".
- [ ] 10.2 The confinement: `hooks.before` limits a marker session to `/two-factor/enable`, `/two-factor/verify-totp`, `/get-session` and `/sign-out`, and the context resolver rejects a `/v1` call as a missing context. Verify: `packages/auth/src/mfa-reenrol.int.test.ts`, scenario "The next sign-in is confined to enrolment".
- [ ] 10.3 Verified enrolment clears the marker. Verify: `packages/auth/src/mfa-reenrol.int.test.ts`, scenario "Enrolment lifts the confinement".
- [ ] 10.4 `apps/api/scripts/recover-admin-mfa.ts` and the `recover:admin-mfa` package script, built like the bootstrap CLI, calling the service of 9.3 with the operator form, refusing an unknown organization or a non-member without printing account detail. Verify: `apps/api/src/recover-admin-mfa.int.test.ts` (imports `../scripts/recover-admin-mfa.js`), scenarios "The operator resets the last admin's factor" and "The command refuses a user outside the organization", plus a case that no secret or email appears on stdout or stderr.

## 11. Telemetry contract enforcement

- [ ] 11.1 Declare the spans, metrics, log events and value sets of design D15 in `identity-contract.ts` and the fixture. Verify: `packages/auth/src/telemetry/identity-contract.test.ts`, cases "every declared name and attribute equals the expected fixture", "the value sets equal design D15", "`tayzu.identity.notice.template` is unchanged", and `contract.test.ts` (002's contract) still passes unchanged.
- [ ] 11.2 Each operation emits its declared names. Verify: `apps/api/src/password-reset-events.int.test.ts`, scenario "Declared telemetry is emitted" for the request route (each suppression reason), the confirm route (each denial reason and each confirm outcome) and the MFA reset (admin and operator forms).
- [ ] 11.3 Extend `otel-smoke-check`. Verify: `apps/api/src/otel-smoke-check.int.test.ts` (`pnpm --filter @tayzu/api otel-smoke-check`), new case "every declared 044 name is observed once and no undeclared name appears".
- [ ] 11.4 No sensitive data on any signal. Verify: `apps/api/src/recovery-telemetry.http.int.test.ts`, scenarios "No sensitive value reaches telemetry", "The token never leaves the email" (response, logs, spans, metrics and the non-sending sender's record) and "An unknown address leaves no identifier", and the case "a provider failure containing the recipient address leaks it nowhere".

## 12. Production wiring (through `createAppFromEnv`)

- [ ] 12.1 The request and confirm routes work through the production start. Verify: `apps/api/src/password-reset-wiring.int.test.ts` (every case built with `createAppFromEnv`, `MOUNT_IDENTITY_ROUTES=true` and the recording sender `createEmailSender` selects), cases "a request sends one `PasswordResetEmail` whose link starts with `PASSWORD_RESET_LINK_BASE_URL`" and "the emailed id and token complete a reset", and "closing the app drains an in-flight send".
- [ ] 12.2 The controls work through the production start. Verify: `apps/api/src/password-reset-wiring.int.test.ts`, cases "the recipient, IP and global caps, the kill switch, the disabled-tenant list and the recipient-domain allowlist suppress silently with the uniform answer", "two app instances share the caps" and "the configured defaults are applied when no override is set".
- [ ] 12.3 Fail-closed startup. Verify: `apps/api/src/password-reset-wiring.int.test.ts`, scenario "Mounting without the email path fails startup" for each of the link base URL, the recipient key secret and the sender, naming the variable and never its value.
- [ ] 12.4 The notices and the MFA reset work through the production start. Verify: `apps/api/src/identity-wiring.int.test.ts`, new cases "a password change sends one `PasswordChangedNotice`", "`identity.users.create` sends one `AccountCreatedNotice`" and "`identity.users.resetMfa` over HTTP sends one `MfaResetNotice`".

## 13. DAST probe

- [ ] 13.1 `scripts/ci/dast-probe.ts`: the requests of design D17 against the accept route and both reset routes, failing on 5xx, a stack trace, reflected input or a known/unknown difference. Verify: `apps/api/src/dast-probe.test.ts` (against an in-process app), scenario "The probe covers the three routes" and a case "the probe fails when a route reflects its input".
- [ ] 13.2 Wire the probe into `scripts/ci/dast.sh` with `EMAIL_PROVIDER=none`, the mount switch on, the new variables, and count its responses in `dast-coverage.ts`. Verify: `apps/api/src/dast-script.test.ts` and `apps/api/src/dast-coverage.test.ts`, scenario "The probe sends no mail" and cases "the script runs the probe after the ZAP scan" and "coverage fails when the probe saw no 2xx on the request route".

## 14. Docs, ADR and diagram

- [ ] 14.1 `docs/adr/0023-password-reset-is-tayzu-owned-and-mfa-aware.md` (Status, Date, Change, Context, Decision, Alternatives, Consequences), written the day the first decision lands. Verify: `pnpm lint` (markdownlint) passes and the file states D1, D4 and D6 with the alternatives of Q2 and Q1.
- [ ] 14.2 Update `docs/security/attack-surfaces.md`: public routes, blocked routes, email and phishing (SEC11, the single justified link), rate-limit row, pending list. Verify: `pnpm lint`, and the section "Email and phishing (SEC11)" no longer says the invitation email is the only email (a grep in the PR description).
- [ ] 14.3 Update `docs/security/secrets.md`: the variables of design D9, the widened scope of `INVITATION_EMAIL_KILL_SWITCH`, and the break-glass runbook of D12 (who may run it, out-of-band identity check, the named second approver, just-in-time access, the follow-up reset, review from the audit event). Verify: `pnpm lint`, and every variable of design D9 appears in the document (a script-free checklist in the PR description).
- [ ] 14.4 Update `docs/security/data-retention.md` (the two identifier families, their lifetimes, the hashed reset caps in `auth.rate_limit`) and `docs/security/crypto-inventory.md` (token generation and digest, the TOTP and backup-code decryption path, the shared password hash). Verify: `pnpm lint`, and the families named match `verification-families.int.test.ts` (task 2.7).
- [ ] 14.5 Update `docs/catalog/auth-and-rbac.md` (the reset flow, the re-enrolment gate, the closed Better Auth routes) and the layout lines of `apps/api/CLAUDE.md` and `packages/auth/CLAUDE.md`. Verify: `pnpm lint` (markdownlint covers every `CLAUDE.md`).
- [ ] 14.6 Update `docs/architecture/system-diagram.md` (Mermaid) and regenerate its image: the two public routes, the mail client as the receiver of reset and notice mail, the operator and the break-glass CLI, the `auth.verification` writes. Verify: `apps/api/src/system-diagram.test.ts` passes and the diagram names every new route and actor.

## 15. Final checks (Checkpoint 2 readiness)

- [ ] 15.1 Run `pnpm ci:local` (lint, typecheck, unit and integration tests, contract check, otel-smoke-check, policy compile). Verify: the command exits 0 and its output is attached to the PR.
- [ ] 15.2 Re-run the VCDM pre-assessment with the `vcdm-ssa-validator` subagent in Mode A over `proposal.md`, `specs/`, `design.md`, `tasks.md` and the code. Verify: the report lists every SEC section as APPLIES/PARTIAL/N/A with a reason and has no open blocking GAP; any HUMAN item goes to the human in chat.
- [ ] 15.3 Run `/security-review` on the branch. Verify: no unresolved finding of severity medium or higher; findings are fixed by new red-green tasks or recorded as tickets in design.md.
- [ ] 15.4 Run `npx -y @fission-ai/openspec@1.13.2 validate 044-password-reset-and-account-recovery --strict`. Verify: it reports the change valid.
- [ ] 15.5 Prepare the PR for Checkpoint 2: the summary, the evidence of 15.1-15.4, the approved policy of 9.1, the Gates list of the design (including that `MOUNT_IDENTITY_ROUTES` stays off until they hold), and a check that every row of the design's hand-off table points at a ticked task. Verify: the PR description contains each item and the checklist of this file is fully ticked.
