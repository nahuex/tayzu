# Proposal: 044-password-reset-and-account-recovery

**Status:** approved at Checkpoint 1 by the human on 2026-10-15.

## Why

Tayzu has no way back for a person who cannot sign in. `002-auth-and-rbac` ships
password and Visma Connect sign-in, TOTP and backup codes, and deliberately no
forgot-password flow (VCDM pre-assessment of `002`, ticket 9; decision D10 of the
roadmap). `043-identity-lifecycle-and-org-admin` then made three gaps worse:
an admin creates a *global* account with a temporary password the admin knows
(account squatting), a temporary password that expires after 48 hours locks its
owner out for good, and a member who loses the authenticator and the backup codes
has no recovery at all (`/two-factor/disable` is not reachable). `043` also
promised, and did not build, the notices that tell a person their password or
second factor changed (`002` Q46, `043` Q92), and its first-deployment gate says
the recovery path for a squatted account ships before `MOUNT_IDENTITY_ROUTES` is
turned on. This change closes those hand-offs. It runs right after `043`
(`002 -> 043 -> 044 -> 045 -> 003`).

The Platform Engineering reference reports contain no guidance on password reset
or account recovery, and Port's public documentation says nothing on either (see
design.md, "References and Port"). The requirements therefore come from the
OWASP Forgot Password and Multifactor Authentication cheat sheets, NIST SP
800-63B and the VCDM Security Self-Assessment, and every design choice was
approved by the human on 2026-10-14 and 2026-10-15 (design.md, "Resolved decisions",
Q1-Q31).

## What Changes

- **Forgot-password request and confirm routes.** Two public, API-only Fastify
  routes in `apps/api`, modeled on `043`'s invitation accept route:
  `POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`.
  They sit on the explicit public-route allowlist and behind the existing
  `MOUNT_IDENTITY_ROUTES` switch. Better Auth's built-in `/request-password-reset`
  and `/reset-password` stay off the `/api/auth` allowlist.
- **Reset token.** 256 bits from the CSPRNG, travelling in the URL fragment,
  stored only as a sha256 digest in `auth.verification` under a new identifier
  family (no migration), verified in constant time, single use, valid for 30
  minutes, and replaced by the next request of the same user that the email
  controls admit: a request they suppress issues no token and deletes none.
- **Enumeration resistance.** One identical public answer, in status, body shape
  and time, for an unknown address, an SSO-only account, a banned account, an
  account `Disabled` in every tenant, a capped or suppressed send and a provider
  failure. Only an account that has a `credential` account, is not banned and is
  not `Disabled` everywhere receives mail. The send is detached and the response
  time is padded. Limiter keys use the IPv6 /64 prefix, and a limiter failure fails
  closed.
- **MFA-aware confirmation.** For a user with a second factor enrolled, the new
  password takes effect only after a TOTP or an unused backup code is verified in
  the same confirm request. The password policy and the breach check run first, so
  a refusal never burns a backup code; "enrolled" fails closed on an inconsistent
  state; and the factor check and its counts are serialized, so parallel guesses
  cannot exceed the budget.
- **Effects of a completed reset.** One SQL transaction on the connection that holds
  the per-user lock writes the password with Better Auth's exported hash function
  (under the existing password policy and breach check, which run first); every
  session of the user in every tenant is revoked (`auth.security.session_revoked`
  reason `password_reset`); the user's other reset tokens, the temporary-password
  marker and pending second-factor challenges are deleted; `emailVerified` becomes
  true; a fixed "your password was changed" notice, which tells the user to review
  service accounts, credentials and linked sign-ins, is sent; the user is not signed
  in. A sign-in the reset overtook is refused. A reset never clears `banned`, never
  re-enables a `_user` and does not revoke machine credentials or SSO links.
- **MFA recovery.** Backup codes remain the self-service path. For a member who
  lost both factors, a new high-risk identity operation, `identity.users.resetMfa`
  (`POST /v1/users/{user}/mfa/reset`), lets a tenant admin remove the member's
  second factor under step-up and Cerbos, with a mandatory reason code, revoke their
  sessions, notify them and force re-enrolment at the next sign-in. It serves
  members only, and every refusal of the service looks the same. A break-glass
  operator runbook with a CLI, which needs a named approver, covers an admin, an
  owner, a member of several tenants and a member whose factor a squatter enrolled.
  The CLI refuses to start with telemetry switched off, exits non-zero if the final
  flush fails, and prints one completion line for the operator's PIM record. The
  runbook orders the recovery so that no one who knew the old password can enrol
  first: the person requests the link before the run and confirms at once after it.
- **Notices** (`043` Q92 ticket): fixed templates with no link and no tenant free
  text for a changed or reset password, a changed or reset second factor (the
  password-changed and MFA-reset notices tell the user to review service accounts,
  credentials and linked sign-ins; neither reset revokes them), and
  "an account was created for this address", which `identity.users.create` now
  sends. They go through `043`'s sender with their own caps (the account-created notice
  also per tenant and globally), the shared kill switch, the shared recipient-domain
  allowlist and the disabled-tenant list.
- **Email path for an anonymous reset.** A dedicated mailer over `043`'s sender
  and shared DB-backed cap store, with caps per recipient (HMAC key), per IP and
  global, admitted before any token is issued, and silent refusals so no cap
  becomes an oracle.
- **Reset link target.** A fixed, server-configured base URL
  (`PASSWORD_RESET_LINK_BASE_URL`), validated like `INVITATION_LINK_BASE_URL`; the
  client never supplies a `redirectTo`. The page is `003`'s.
- **DAST.** A scripted DAST probe covers the public routes that have no OpenAPI
  document: `043`'s accept route and the two reset routes, run against the sandbox
  tenant with the non-sending sender.
- **Telemetry and docs.** New names in the identity telemetry contract module;
  updates to `attack-surfaces.md`, `secrets.md`, `data-retention.md`,
  `crypto-inventory.md`, the `auth-and-rbac` reference doc and the system
  diagram; one ADR.

## Capabilities

### New Capabilities

- `password-reset-and-account-recovery`: the forgot-password flow, the reset
  token, enumeration resistance, MFA-aware confirmation, the effects of a
  completed reset, MFA recovery (backup codes, admin reset, break-glass), the
  recovery notices, the email controls of the anonymous path, the mount and
  public-route rules, the telemetry rules and the DAST probe.

### Modified Capabilities

- `auth-and-rbac`: "Authentication responses resist account enumeration" no longer
  defers forgot-password to this change; it points at the new capability and keeps
  its sign-in scope.
- `identity-lifecycle-and-org-admin`: "Invitation email is fixed and capped" stated
  that the admin-accepted notice is the only other email the capability sends;
  `identity.users.create` now also sends the account-created notice defined by the
  new capability.

## Impact

- **Code.** `packages/auth` (reset token module, the pure factor verifier, new
  email templates and renderers, the `mfa-reenrol` marker, `auth.ts` hooks for the
  new notices, the re-enrolment gate and the sign-in fence, scope and reason enums,
  the exported password hasher, the identity telemetry contract); `apps/api` (the
  two routes, the recovery mailer and eligibility reader, the recovery and
  completion sections of the auth repository module, the client IP key (also used by
  `043`'s accept route through the shared pre-handler, so that route changes with it),
  `identity.users.resetMfa` and its service, the wrapper's self-target set and the
  target role attribute in `identity/define-operation.ts`, `identity-attributes.ts`
  and `identity-target.ts`, `identity.users.create`'s notice, config, public-route
  allowlist, wiring in `createApp` and `createAppFromEnv`, the operator CLI and its
  `script-config.ts` entry, `scripts/run-script.ts` (a telemetry seam),
  `email-sender.ts` (a narrower `createEmailSender` parameter), `telemetry.ts` (the
  shared OTLP endpoint helper), the DAST probe); `policies/` (Checkpoint 3). There is
  no change to `packages/authz`: actions are plain strings in the operation
  declaration.
- **Dependencies.** One: `@better-auth/utils@0.4.2`, already in the lockfile as
  Better Auth's own dependency, added as a direct dependency of `@tayzu/auth` for
  the TOTP check (design D6).
- **Database.** No migration. The token and the new markers live in
  `auth.verification`; migrations `0012`-`0014` stay reserved for `045`.
- **Policy.** One Cerbos change (`resetMfa` on `user`: self-target deny and a
  members-only target rule, hardening the existing admin grant), Checkpoint 3.
- **Other changes.** `045` classifies the new identifier families in its
  verification-family completeness test and extends the same closed
  email-template union; `003` serves the reset page.
- **Operations.** New environment variables, listed in design D9, and the operator
  CLI's own variable set (design D12); a new first-deployment gate list in
  design.md, "Gates", including the TLS and DNS checks of `002` task 11.12.

## Non-goals

- The reset page and the MFA entry page are `003`'s. The reset link stays inert
  until `003` serves the page.
- The email-change notice is a ticket: no email-change path exists today.
- SSO-only users (no `credential` account) are out: a reset never creates a
  password for them.
- Self-service MFA removal and e-mail-based second factors (`otp`) are not built.
- The SSO link/unlink/shed and status-change notices stay in `043`'s "User
  notifications" ticket.
- No new HTTP listener, no `redirectTo` from the client, no CAPTCHA.

## Sizing

The roadmap budget is about 30-80 TDD tasks. `043` overran it (227 tasks) and had
to split (Q103). `044` plans 85 tasks in 16 groups (tasks.md), slightly over 80 with the
human's agreement (design, "Size"); Q32's task 5.7 reached the limit of 85. It keeps to that by reusing
`043`'s email sender, cap store, kill switch, allowlist, public-route pattern, wrapper and
telemetry helpers, by adding no migration and by leaving every page to `003`.
