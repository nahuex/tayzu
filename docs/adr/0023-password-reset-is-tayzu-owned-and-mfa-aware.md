# ADR-0023: Password reset is Tayzu-owned and MFA-aware

- **Status**: Accepted
- **Date**: 2026-10-14 (Amended 2026-10-15)
- **Change**: [`044-password-reset-and-account-recovery`](../../openspec/changes/044-password-reset-and-account-recovery/design.md) (design D1, D4, D6, D7, D10, D12; Resolved decisions Q1, Q2, Q6, Q13, Q29)

Amended 2026-10-15: Q12 to Q30 refined the decisions below (the SQL
transaction, the members-only admin reset, the approver and the telemetry
guard of the break-glass command). Q1 to Q11 were approved on 2026-10-14, the
date of this ADR. The ADR is written before the code it describes.

Number `0019` is reserved for `045-org-deletion-and-data-retention`, so this is
the next free number after `0022`.

## Context

Sign-in is email and password with TOTP and backup codes (`002`). Better Auth's
`/request-password-reset`, `/reset-password` and `/reset-password/:token` are
off the `/api/auth` allowlist, and `/two-factor/disable` is blocked too. A
person who forgets the password, or who loses the authenticator and the backup
codes, has no way back.

Better Auth's own reset is unfit as it stands (`better-auth@1.7.6`). The token
is stored in clear in `verification.identifier` and travels in a query string
through a redirect. The known-user branch awaits the send and the unknown-user
branch does not, so the response time reveals the address. It checks neither
`banned` nor the `credential` account, ignores the email caps and the mount
switch, and revokes sessions only when configured to. Its routes sit under
`/api/auth/*`, which the `MOUNT_IDENTITY_ROUTES` switch does not cover.

Two further facts shape the design. The Better Auth adapter is not
transactional in Tayzu (`drizzleAdapter` is built without `transaction: true`),
so `adapter.transaction(...)` is a no-op, and taking a second pooled connection
while the per-user advisory lock is held is the hazard `043` removed. And a
mailbox is a weaker thing than a second factor: if the emailed link alone could
change the password of, or remove a factor from, an enrolled user, a compromised
mailbox would defeat MFA.

`045` and `003` build on these decisions, so they are recorded here.

## Decision

1. **Tayzu owns both reset routes; Better Auth's stay closed (D1, Q2).** Two
   plain Fastify routes in `apps/api`, `POST /v1/auth/password-reset/request`
   and `POST /v1/auth/password-reset/confirm`, are modeled on `043`'s public
   accept route. They sit on the explicit public-route allowlist, behind the
   mount switch, with the CSRF header and `Origin` checks and a database-backed
   per-IP limiter that runs before any lookup. Better Auth's three reset routes
   stay off the allowlist and keep answering the byte-identical `404` of any
   unknown path. The token is 256 bits, travels in the URL fragment, and is
   stored only as a sha256 digest, verified in constant time. The request route
   answers the same `200` for every account state (D4, Q4): only an account
   with a `credential` account, not banned and not `Disabled` in every tenant
   it belongs to is mailed, the send is detached, and the response is padded to
   a minimum duration, so neither status, body, headers nor time depend on the
   account. A suppressed request issues no token, so it cannot evict the link
   the user already holds. The final password write
   uses Better Auth's exported password hash function, so NFC normalization,
   the password policy and the breached-password check apply.

2. **A mailbox never changes an MFA-enrolled user's password and never removes
   a factor (D6, D10, Q1, Q6).**
   - **Password reset.** For a user with an enrolled second factor, the link
     alone does nothing. The new password takes effect only when a TOTP code or
     a backup code is verified in the same confirm request. A user with no
     factor needs only the link. A flag with no verified factor row, or the
     reverse, is treated as enrolled and fails closed, so no partial state turns
     "enrolled" into "not enrolled".
   - **Factor removal.** No email-only path removes a second factor. A member
     who lost both factors is recovered by an audited admin action,
     `identity.users.resetMfa` (D10), or by the break-glass command (item 5).
     After either, a `mfa-reenrol:<userId>` marker confines the next sign-in to
     enrolment (D11).

3. **The completion is one SQL transaction on the lock's connection (D7,
   Q13).** The factor check, the token consume, the credential password
   update, the deletion of the user's other reset tokens, temporary-password
   marker, two-factor challenges and trusted-device rows, `emailVerified`, the
   backup-code spend and the deletion of every session in every tenant run as
   parameterized SQL in the auth repository module, on the connection that
   holds the per-user advisory lock. Any thrown error rolls the whole thing
   back. The password policy and the breach check run before the lock, so a
   refusal never burns the token or a backup code. A reset never signs the user
   in, never clears `banned` and never re-enables a `_user`. A sign-in that a
   reset overtook is refused by a fence on `/sign-in/email`.

4. **The admin reset reaches members only, through one refusal path (D10, Q12,
   Q15).** A tenant admin may reset the factor of a member of the tenant, with
   a mandatory reason code from a closed set. The resource policy denies the
   action on oneself and on any target whose role is not exactly `member`, and
   the service repeats those checks. An admin or owner, a member of several
   tenants and a member whose factor a squatter enrolled are recovered only by
   the break-glass command. The refusals of the admin form (no enrolled
   factor, another tenant, role, self) read every predicate and answer with one
   indistinguishable error, so an admin never learns that a member belongs to
   another organization. The policy change is a Checkpoint 3 item of its own.

5. **The break-glass command needs a named approver and leaves durable
   evidence (D12, Q14, Q29, Q31).** `apps/api/scripts/recover-admin-mfa.ts`
   runs out of band, only from the production-network operator environment
   under Azure PIM. It shares the MFA-reset service with the admin form, which
   takes a repository port and no Better Auth instance, so the command never
   loads `BETTER_AUTH_SECRET`. It requires `--approver`, an opaque id that
   differs from the operator id, and accepts any member as a target. Because
   the audit event is the only durable record of who approved removing a
   factor, the command is stricter than the shared script rule: its `main()`
   refuses to start when `TAYZU_TELEMETRY_DISABLED` is true or no OTLP endpoint
   is set, whatever `NODE_ENV` says, and exits non-zero when the final
   telemetry flush fails. On completion it prints one line with the operator,
   the approver, the opaque user id, the number of sessions revoked and
   whether the notice was `sent`, `suppressed` or `failed`, and no address or
   secret, for the operator to attach to the PIM record.

## Alternatives considered

- **Better Auth's built-in routes with hooks, or a mix of its request route
  and a custom confirm (Q2).** Rejected: the token stays in clear in a query
  string, the known and unknown paths time differently, and the routes sit
  outside the mount switch. Each defect is fixable with a hook, but the result
  would be a custom flow inside a surface the switch does not cover.
- **The emailed link alone for an enrolled user, with MFA enforced at the next
  sign-in (Q1).** Rejected: a compromised mailbox would set the password, and
  the second factor would then be the only barrier, which is the barrier the
  reset was meant to respect.
- **An email-only MFA reset, backup codes only as the recovery, or a separate
  change for MFA recovery (Q6).** Rejected: a mailbox would defeat MFA, a
  member who loses both has no way back, and the password and factor flows
  share the eligibility, notice and session-revocation machinery.
- **Enabling `transaction: true` for the whole Better Auth instance, or
  non-atomic writes with compensation (Q13).** Rejected: the first changes
  every Better Auth flow and takes a second pooled connection while the lock is
  held, and the second has no atomic outcome if a step fails midway.
- **Refusing only the telemetry opt-out in the command, with no flush check
  and no completion line, or relying on the PIM record alone (Q29).**
  Rejected: the operator sets the command's environment, so an opt-out or a
  failed flush would silently drop the only durable record of the approval.
  Q31 moved the guard into `main()` and made it ignore `NODE_ENV`, because a
  guard that depended on `NODE_ENV` could be switched off in a real run.
- **Letting a tenant admin reset any member of the tenant, or any user
  including admins and owners (Q15).** Rejected: one compromised admin could
  strip every other admin's factor.

## Consequences

- No migration and no new table. The change adds two identifier families to
  `auth.verification`, `password-reset:<id>` and `mfa-reenrol:<userId>`, which
  `045`'s completeness test must classify. A test in this change enumerates the
  prefixes the code writes, so `045` has the list.
- `003` serves `/reset-password` at the configured link origin. Until it does,
  the link is inert. The page strips the fragment after reading it, sends
  `Referrer-Policy: no-referrer`, loads no third-party script, never submits
  the new password without the user's action, and shows a factor field when the
  confirm route answers `AUTH_STEP_UP_REQUIRED`.
- The change adds one direct dependency, `@better-auth/utils@0.4.2`, already
  in the lockfile, for the TOTP check at confirm (Q18). A drift test compares
  it with the installed `/two-factor/verify-totp` endpoint.
- The admin MFA reset is a hardening of the existing `'*'` admin grant of the
  `user` resource policy, not a new grant, and it is a Checkpoint 3 stop.
- The reset does not touch machine credentials, service accounts or SSO links
  (Q21, Q30). The fixed password-changed and MFA-reset notices tell the user to
  review them.
- The audit event of the operator form is not tamper-proof against someone who
  can run the command, because the `tayzu_auth` role can write `auth.*`
  directly. The Azure PIM record and the named approver are the control, and
  the audit event is the second record.
- Remaining risks, for example a mailbox holder who locks the owner's TOTP
  sign-in for 15 minutes at a time, a TOTP code replayed once inside its
  window, and a squatter who enrols a factor on an account created for someone
  else's address, are listed in the Risks section of the design, with the
  runbook that bounds the last one.
- Every per-IP control here is only as trustworthy as the pending
  first-deployment gate on the proxy trust setting (`002` Q58).
