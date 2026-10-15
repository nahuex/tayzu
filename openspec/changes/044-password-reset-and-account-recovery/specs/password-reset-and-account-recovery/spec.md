# Spec Delta: password-reset-and-account-recovery

## Purpose

Lets a person who cannot sign in recover their account without weakening the
platform: an emailed, single-use, short-lived reset link whose request answers
identically for every address, MFA-aware confirmation, session revocation, an
audited admin reset of a lost second factor, an operator break-glass for the last
admin, and fixed notices that tell people when their password or second factor
changed.

## ADDED Requirements

### Requirement: The reset request answers identically for every address

`POST /v1/auth/password-reset/request` MUST accept exactly `{ email }` and MUST answer
`200` with the body `{ "accepted": true }` for every well-formed address, whatever the
state of the account: no account, an account without a `credential` account (SSO-only),
a banned account, an account `Disabled` in every tenant it belongs to, an eligible
account, a send suppressed by a cap, the kill switch, the recipient-domain allowlist or
the disabled-tenant list, and a provider failure. The status, the body, the headers and
the response time MUST NOT depend on that state: the send MUST NOT be awaited by the
response and the response MUST NOT be returned before a fixed minimum duration. A
malformed body or address, a missing `x-csrf-token: orpc` header or an `Origin` that is not
an allowed origin MUST fail with `CATALOG_VALIDATION_FAILED` before any lookup; that answer
depends only on the request itself. The reason a request produced no
mail MUST be recorded only on internal signals, never in the response.

#### Scenario: An unknown address and an eligible account get the same answer

- **GIVEN** `known@example.com` with a password and no second factor, and `ghost@example.com` with no account
- **WHEN** each address is posted to the request route
- **THEN** both answers have status `200` and the body `{ "accepted": true }`, with the same header names
- **AND** exactly one `PasswordResetEmail` is sent, to `known@example.com`

#### Scenario: Every refusal state gets the same answer

- **GIVEN** an SSO-only account, a banned account, an account `Disabled` in its only tenant, an address on a full recipient cap, a kill switch turned on, and a provider that fails
- **WHEN** each is posted to the request route in turn
- **THEN** every answer equals the answer for an eligible account and for an unknown address, and no response names the state

#### Scenario: A slow provider does not slow the response

- **GIVEN** an eligible account and a sender that takes two seconds to answer
- **WHEN** the address is posted to the request route
- **THEN** the response is returned without waiting for the sender, and no sooner than the fixed minimum duration

#### Scenario: A cross-site request is refused before any lookup

- **WHEN** the request route receives a valid body without the CSRF header, or from an `Origin` that is not allowed
- **THEN** it answers `CATALOG_VALIDATION_FAILED`, performs no account lookup and sends no email

#### Scenario: A malformed request fails before any lookup

- **WHEN** the request route receives a body with an unknown field, a non-string email, an email longer than 254 characters or a `__proto__` key
- **THEN** it answers `CATALOG_VALIDATION_FAILED` and performs no account lookup

### Requirement: Only a recoverable account receives a reset email

A reset email MUST be sent only to an account that has a `credential` account, is not
banned and is not `Disabled` in every tenant it belongs to. An account that is
`Disabled` in one tenant and not in another MUST be eligible. An account with no
membership MUST NOT be eligible. A completed reset MUST NOT clear `banned`, MUST NOT
change the status of any `_user` and MUST NOT create a `credential` account. The
address MUST be put in its canonical form (NFC, trimmed, lower-cased) before any lookup,
cap or key.

#### Scenario: An SSO-only user gets no password through a reset

- **GIVEN** a user with a linked Visma Connect account and no `credential` account
- **WHEN** the address is posted to the request route
- **THEN** no token is created, no email is sent, and the answer is the uniform one

#### Scenario: Disabled everywhere is not recoverable, disabled somewhere is

- **GIVEN** a user `Disabled` in tenants `t1` and `t2`, and another user `Disabled` in `t1` and `Active` in `t3`
- **WHEN** both addresses are posted
- **THEN** the first gets no email and the second gets one

#### Scenario: A reset never revives a banned or disabled user

- **GIVEN** an eligible user who is then banned before the link is used
- **WHEN** the link is submitted to the confirm route
- **THEN** the answer is the uniform rejection, the password is unchanged, and `banned` is still true

#### Scenario: The address is canonicalized

- **WHEN** `  Known@Example.COM ` is posted
- **THEN** the lookup, the recipient cap key and the email recipient use `known@example.com`

### Requirement: The reset token is secret, single use and short lived

The token MUST be 256 bits from the cryptographically secure generator, MUST travel in
the URL fragment of the emailed link (`#reset=<id>&token=<token>`) on a fixed path and
a base URL taken only from configuration, and MUST be valid for exactly 30 minutes.
Only the sha256 digest of the token MUST be stored, in `auth.verification` under the
identifier family `password-reset:` (no new table and no migration), and a presented
token MUST be checked against it in constant time, with a dummy comparison when no
record matches. The token MUST be usable once. A new request for a user MUST delete that
user's earlier unused reset tokens, so only the newest works. The token and the link
MUST NOT appear in any response, log record, span, metric, or in anything the
non-sending sender keeps. The link MUST be the only link in the email.

#### Scenario: The newest link wins

- **GIVEN** an eligible user who requested a reset twice
- **WHEN** the first link is submitted
- **THEN** the answer is the uniform rejection, and the second link still works

#### Scenario: A token is single use

- **WHEN** a valid token completes a reset and is submitted again
- **THEN** the second submission is the uniform rejection and changes nothing

#### Scenario: A token expires after 30 minutes

- **GIVEN** a token issued 30 minutes and one second ago
- **WHEN** it is submitted
- **THEN** the answer is the uniform rejection

#### Scenario: Only a digest is stored

- **WHEN** a reset is requested for an eligible user
- **THEN** the `auth.verification` row for the token holds the sha256 digest and not the token, and no row holds the token in its identifier or value

#### Scenario: The link carries the token in the fragment on the configured origin

- **WHEN** a reset email is sent from a request with a forged `Host` and `X-Forwarded-Host`
- **THEN** the link starts with the configured `PASSWORD_RESET_LINK_BASE_URL`, and the id and token are in the fragment and nowhere else

#### Scenario: The token never leaves the email

- **WHEN** a reset is requested and completed
- **THEN** neither the token nor the link appears in a response, a log record, a span or a metric attribute

### Requirement: A reset confirmation fails with one uniform rejection

`POST /v1/auth/password-reset/confirm` MUST accept exactly
`{ id, token, newPassword, factor? }`. Every refusal that depends on the token or on the
account (an unknown id, a token that does not match, an expired or used token, a token
whose account is no longer eligible, a cross-site request, a lost consumption race)
MUST answer the same status, `CATALOG_NOT_FOUND` code and body shape as an unknown
resource, and the reason MUST be logged internally with a closed reason set. The
request MUST carry the header `x-csrf-token: orpc` and an `Origin` that is one of the
allowed origins, or it is rejected the same way. The shape and the limits of the body
MUST be checked, and the per-IP limiter MUST have run, before any lookup, hash or
network call.

#### Scenario: Every token problem looks the same

- **GIVEN** an unknown id, a wrong token for a real id, an expired token, a used token and a token of a banned account
- **WHEN** each is submitted to the confirm route
- **THEN** all five answers have the same status, code and body shape

#### Scenario: A cross-site confirmation is rejected the same way

- **WHEN** a valid token is submitted without the `x-csrf-token` header, or from an `Origin` that is not allowed
- **THEN** the answer is the uniform rejection and the token is not consumed

#### Scenario: Cheap checks run first

- **WHEN** the confirm route receives an oversized body, an unknown field or a `constructor` key
- **THEN** it fails before any database, hash or breached-password lookup

### Requirement: A user with a second factor must prove it to reset the password

When the account has a second factor enrolled, the confirm route MUST NOT change the
password unless the same request carries a valid TOTP code or an unused backup code in
`factor`. A request without a factor, or with an invalid one, MUST change nothing,
MUST NOT consume the token and MUST answer `AUTH_STEP_UP_REQUIRED`. A used backup code
MUST be spent. Failed factors MUST count against the account's second-factor lockout and
against a budget of 5 per token, after which the token MUST be deleted. A user with no
second factor MUST need only the link. A reset MUST NOT remove, disable or change the
enrolled second factor.

#### Scenario: The link alone does not change an enrolled user's password

- **GIVEN** a user with TOTP enrolled and a valid token
- **WHEN** the token and a new password are submitted without a factor
- **THEN** the answer is `AUTH_STEP_UP_REQUIRED`, the password is unchanged and the token is still valid

#### Scenario: A valid TOTP code completes the reset

- **WHEN** the same request carries the current TOTP code
- **THEN** the reset completes and the token is consumed

#### Scenario: A backup code completes the reset and is spent

- **WHEN** the request carries an unused backup code
- **THEN** the reset completes, and the same backup code is refused on the next sign-in

#### Scenario: Five wrong factors burn the token

- **WHEN** five requests with the right token and a wrong factor are submitted
- **THEN** each answers `AUTH_STEP_UP_REQUIRED` and the sixth, with a correct factor, is the uniform rejection

#### Scenario: A user without a second factor needs only the link

- **GIVEN** a user with no enrolled factor
- **WHEN** a valid token and a compliant password are submitted
- **THEN** the reset completes

#### Scenario: A reset keeps the second factor

- **WHEN** an enrolled user completes a reset
- **THEN** the next sign-in with the new password still requires the second factor

### Requirement: The new password meets the password policy before the token is spent

The confirm route MUST apply the same password policy as every other path that sets a
password (NFC normalization, the length bounds, character classes, refused characters,
the denylist) and the breached-password check, and MUST do so before the token is
consumed. A refusal MUST name only the failed rule, never the password. When the
breached-password service cannot be reached, the route MUST fail closed with a sanitized
internal error and MUST NOT consume the token. The password MUST be hashed and written
through Better Auth's own hashing and adapter, so the stored hash is the one a sign-in
verifies.

#### Scenario: A weak password is refused and the token survives

- **WHEN** a valid token is submitted with a password that fails the policy
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` naming only the rule, and the same token still works with a compliant password

#### Scenario: A breached password is refused and the token survives

- **WHEN** a valid token is submitted with a password in the breach corpus
- **THEN** the answer is `CATALOG_VALIDATION_FAILED`, the password is unchanged and the token is not consumed

#### Scenario: A breach-service outage does not burn the token

- **GIVEN** the range service is unreachable
- **WHEN** a valid token and a compliant password are submitted
- **THEN** the answer is a sanitized internal error, the password is unchanged and the token is not consumed

#### Scenario: The new password signs in

- **WHEN** a reset completes with a compliant password
- **THEN** a sign-in with the new password succeeds (with the second factor, if enrolled) and a sign-in with the old password fails

### Requirement: A completed reset revokes access and tells the user

A completed reset MUST, atomically with the password write: delete the token and every
other reset token of the user; delete the temporary-password marker of the user; set
`emailVerified` to true; and revoke every session of the user in every tenant,
emitting `auth.security.session_revoked` with the reason `password_reset` for each. If
any of these writes fails, the password MUST be unchanged and the token MUST remain
usable. After the commit the system MUST send the fixed password-changed notice. The
reset MUST NOT sign the user in and MUST NOT touch machine credentials or service
accounts.

#### Scenario: Every session in every tenant ends

- **GIVEN** a user with live sessions in two tenants
- **WHEN** a reset completes
- **THEN** both sessions are rejected, and one `auth.security.session_revoked` event with the reason `password_reset` is logged per session

#### Scenario: A reset does not sign the user in

- **WHEN** a reset completes
- **THEN** the response sets no cookie and creates no session

#### Scenario: A reset is the way out of an expired temporary password

- **GIVEN** a user whose 48-hour temporary password expired
- **WHEN** they complete a reset
- **THEN** the temporary-password marker is gone and they sign in with the new password and reach the platform without a forced change

#### Scenario: A reset recovers a squatted account

- **GIVEN** an admin created an account for `victim@example.com` with a temporary password the admin knows, and the admin has a live session on it
- **WHEN** the victim completes a reset
- **THEN** the admin's session and knowledge of the temporary password are both useless, and the victim receives the password-changed notice

#### Scenario: A failed write leaves everything as it was

- **GIVEN** a failure injected after the password write and before the commit
- **WHEN** a valid token is submitted
- **THEN** the old password still signs in, the sessions are still live and the token still works

#### Scenario: Machine credentials are untouched

- **GIVEN** a user who owns a service account with a credential
- **WHEN** the user completes a reset
- **THEN** the credential still exchanges for a token

#### Scenario: A concurrent double submit completes once

- **WHEN** the same valid token is submitted twice at the same time
- **THEN** exactly one completes and the other is the uniform rejection

### Requirement: The reset routes are public, API-only and behind the mount switch

Both reset routes MUST be plain Fastify routes on the explicit public-route allowlist,
each with a reason, MUST be registered only when `MOUNT_IDENTITY_ROUTES` is on, and
with it off MUST answer exactly as an unknown `/v1` path does. Better Auth's
`/request-password-reset`, `/reset-password` and `/reset-password/:token` MUST stay off
the `/api/auth` allowlist and answer `404`. Mounting the routes MUST fail startup unless
the email path, the recipient key secret and the reset link base URL are configured.
The platform MUST NOT serve a reset page and MUST NOT accept a `redirectTo` from a
client.

#### Scenario: Off by default

- **GIVEN** `MOUNT_IDENTITY_ROUTES` is unset
- **WHEN** either reset route is called, with or without authentication
- **THEN** it answers exactly as an unknown `/v1` path does

#### Scenario: Better Auth's own reset routes stay closed

- **WHEN** `POST /api/auth/request-password-reset`, `POST /api/auth/reset-password` or `GET /api/auth/reset-password/some-token` is called
- **THEN** each answers `404`, identical to a path that does not exist

#### Scenario: A route outside the allowlist cannot be public

- **GIVEN** the switch is on
- **WHEN** the Fastify route table is enumerated
- **THEN** the two reset routes are the only new public entries, each with a reason, and any other route outside the allowlist answers an anonymous call like the `/v1/*` catch-all

#### Scenario: Mounting without the email path fails startup

- **WHEN** the switch is on and the reset link base URL, the recipient key secret or the email sender is not configured
- **THEN** startup fails naming the variable and never its value

#### Scenario: The client cannot choose where the link points

- **WHEN** the request route receives a `redirectTo` or `callbackURL` field
- **THEN** it answers `CATALOG_VALIDATION_FAILED`

### Requirement: Reset traffic is limited before any lookup

Each reset route MUST run a DB-backed per-IP limiter before the handler, default 10
requests per 60 seconds, answering `AUTH_RATE_LIMITED` with `Retry-After`; the limiter
state MUST be shared across replicas. The limits MUST be configurable, and a disabled or
zero limit MUST fail startup. The limiter key MUST NOT appear in any signal or response.

#### Scenario: The eleventh request in a minute is limited

- **WHEN** one IP posts 11 requests to the request route within 60 seconds
- **THEN** the eleventh answers `429` `AUTH_RATE_LIMITED` with `Retry-After`, before any account lookup

#### Scenario: A zero limit fails startup

- **WHEN** `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX=0`
- **THEN** startup fails

### Requirement: The reset email is sent through controls that never become an oracle

A reset email MUST go through the platform's email sender and shared cap store with
its own caps: per recipient (keyed by the HMAC of the canonical address, never the
address or a bare digest), per IP and global, with defaults of 5 per hour per recipient,
10 per hour per IP and 600 per hour globally. It MUST obey the shared kill switch
(`INVITATION_EMAIL_KILL_SWITCH`) and the shared recipient-domain allowlist, and MUST be
suppressed when every tenant of the user is on `EMAIL_DISABLED_TENANT_IDS`. Every
refusal (a cap, the kill switch, the allowlist, a disabled tenant, a provider failure)
MUST be silent: the response stays the uniform one, no token is left usable by a
refused send beyond its own expiry, and the refusal MUST be logged only with a closed
reason and no address. A refused send MUST NOT consume the token's single use.

#### Scenario: A per-recipient cap is silent

- **GIVEN** an address that already received 5 reset emails in the hour
- **WHEN** it is posted again
- **THEN** the answer is the uniform one, no email is sent, and `catalog.security.recovery_email_suppressed` is logged with the reason `recipient_cap` and no address

#### Scenario: A demo login cannot send mail

- **GIVEN** a user whose only tenant is on `EMAIL_DISABLED_TENANT_IDS` and a real sender
- **WHEN** the address is posted
- **THEN** nothing reaches the sender, and the answer is the uniform one

#### Scenario: The kill switch and the allowlist apply

- **GIVEN** the kill switch is on, or a recipient whose domain is not on the allowlist
- **WHEN** the address is posted
- **THEN** nothing is sent, the answer is the uniform one, and the allowlist case logs `catalog.security.email_recipient_blocked` with the template and no address

#### Scenario: A provider failure is invisible to the caller

- **GIVEN** a provider that fails with an error containing the recipient address
- **WHEN** the address is posted
- **THEN** the answer is the uniform one and the address appears in no signal

#### Scenario: Reset caps and invitation caps are counted apart

- **GIVEN** an address with a full invitation bucket
- **WHEN** it requests a reset
- **THEN** the reset email is sent

### Requirement: The reset email is fixed

The reset email MUST go to exactly one recipient, MUST have a fixed subject and
template in which only the link and the expiry text are interpolated, and MUST contain no
organization, tenant, admin or other free text, no attachment, no CC or BCC and no
Reply-To. The provider MUST NOT track clicks or engagement. The email MUST contain
exactly one clickable link.

#### Scenario: The template carries no free text

- **GIVEN** a user in an organization named `<b>Pay now</b>`
- **WHEN** a reset email is rendered
- **THEN** that string appears in neither the subject nor the body, and the body holds exactly one link

### Requirement: An admin can reset a member's lost second factor

`identity.users.resetMfa` (`POST /v1/users/{user}/mfa/reset`) MUST let an admin of a tenant
remove the second factor of a member of the same tenant who lost both the authenticator
and the backup codes. It MUST be a high-risk operation (step-up required), MUST go
through the identity operation wrapper (the caller's role is checked before the input is
parsed, the target is resolved on the server, Cerbos decides with the resource kind
`user` and the action `resetMfa`, and any Cerbos error denies), and MUST be behind the
mount switch. A target that is not a member of the caller's tenant, or does not exist,
MUST answer `CATALOG_NOT_FOUND`, identical for both. An admin MUST NOT reset their own
second factor: the attempt is refused and logged. A target who also belongs to another
tenant MUST be refused with `CATALOG_VALIDATION_FAILED` and changed in no way. On success
the operation MUST delete the target's second factor, revoke every session of the target,
mark the target for re-enrolment, send the fixed MFA-reset notice to the target's
registered address, and emit the audit event. A target with no enrolled factor MUST be
refused with `CATALOG_VALIDATION_FAILED`.

#### Scenario: An admin resets a member's lost factor

- **GIVEN** a member with TOTP enrolled and an admin of the same tenant with a fresh MFA verification
- **WHEN** the admin calls `identity.users.resetMfa` for the member
- **THEN** the member's second factor is gone, the member's sessions are rejected, the member receives the MFA-reset notice, and `catalog.audit.mfa_reset` is logged with the admin's id and the member's opaque id

#### Scenario: A member cannot reset anyone's factor

- **WHEN** a `member` or a machine `member` token calls the operation
- **THEN** the answer is `AUTH_FORBIDDEN` for any target, existing or not

#### Scenario: Step-up is required

- **WHEN** an admin without a fresh MFA verification calls the operation
- **THEN** the answer is `AUTH_STEP_UP_REQUIRED` and nothing changes

#### Scenario: A target in another tenant looks like a missing one

- **GIVEN** a member of tenant `t2`
- **WHEN** an admin of `t1` calls the operation for that member, and for an address with no account
- **THEN** both answers are `CATALOG_NOT_FOUND` with the same body

#### Scenario: Self-target is refused

- **WHEN** an admin calls the operation for their own account
- **THEN** it is refused, nothing changes, and `catalog.security.self_mfa_reset_denied` is logged with the tenant and the admin's id

#### Scenario: A member of several tenants is refused

- **GIVEN** a member of `t1` who also belongs to `t2`
- **WHEN** an admin of `t1` calls the operation
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and nothing changes

#### Scenario: A target with no second factor is refused

- **WHEN** an admin calls the operation for a member with no enrolled factor
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and nothing changes

#### Scenario: Humans and agents take the same path

- **WHEN** the actor-parity matrix runs the operation as a human admin and as a machine token (a machine principal always holds `member`)
- **THEN** the machine token is refused by the role check like any `member`, and no code path of the operation reads `actor.type`, except the step-up guard, which applies to `user` actors only

### Requirement: A reset second factor must be enrolled again before use

After an admin or operator MFA reset, the target's next sign-in with the password MUST
yield a session confined to second-factor enrolment (enable, verify, get-session,
sign-out), and every other authenticated route, `/v1` included, MUST answer as for a
missing context until a factor is verified. Verified enrolment MUST clear the
confinement. The reset MUST NOT leave a password-only path to the platform for a user
who had a second factor.

#### Scenario: The next sign-in is confined to enrolment

- **GIVEN** a member whose factor an admin reset
- **WHEN** the member signs in with the password and calls a `/v1` route, and then the second-factor enable route
- **THEN** the `/v1` call is rejected as a missing context and the enrolment route is reachable

#### Scenario: Enrolment lifts the confinement

- **WHEN** the member enrols and verifies a new TOTP factor
- **THEN** the next `/v1` call succeeds

### Requirement: The last admin of an organization recovers through an operator runbook

The platform MUST provide an operator command, run out of band and never mounted on a
route, that resets the second factor of a named member of a named organization with the
same effects as the admin operation (second factor removed, sessions revoked, member
marked for re-enrolment, notice sent) and an audit event that names the operator, not an
admin. A runbook MUST state who may run it, the identity verification and the second
approver it requires, and that the member then sets a password through the reset flow.
It MUST refuse an unknown organization or a user who is not a member of it.

#### Scenario: The operator resets the last admin's factor

- **GIVEN** an organization whose only admin lost the authenticator and the backup codes
- **WHEN** the operator runs the command for that admin
- **THEN** the admin's factor is gone, their sessions are revoked, they are marked for re-enrolment, they receive the MFA-reset notice, and `catalog.audit.mfa_reset` is logged with the operator's id

#### Scenario: The command refuses a user outside the organization

- **WHEN** the operator names a user who is not a member of the organization
- **THEN** the command fails, changes nothing and prints no account detail

### Requirement: Backup codes remain the self-service recovery for a lost authenticator

A user with an unused backup code MUST be able to sign in with it and to complete a
password reset with it, and a backup code MUST NOT be usable twice. The platform MUST
NOT offer any self-service path that removes a second factor from an email link alone.

#### Scenario: No email-only removal of a second factor exists

- **WHEN** every public route is enumerated
- **THEN** none removes or disables a second factor without a session and a fresh verification

### Requirement: Recovery notices are fixed and carry no link

The platform MUST send a fixed notice to the registered address of a user when: their
password is changed through a completed reset or through a password change; their
second factor is enrolled or their backup codes are regenerated; an admin or operator
resets their second factor; and an account is created for their address through
`identity.users.create`. Each notice MUST have a fixed subject and body, no interpolated
value, no link, no organization, actor or other tenant free text, and exactly one
recipient. A notice MUST NOT block the operation that triggered it and MUST NOT be
sent when the operation fails.

#### Scenario: A squatted address is warned

- **WHEN** an admin creates an account for `victim@example.com` through `identity.users.create`
- **THEN** `victim@example.com` receives the fixed account-created notice, with no link and no organization name, and the response of the operation is unchanged

#### Scenario: A password change is announced

- **WHEN** a user changes their password with the current password
- **THEN** the user receives the password-changed notice, and a failed change sends none

#### Scenario: A second-factor change is announced

- **WHEN** a user verifies a new TOTP factor, regenerates their backup codes, or an admin resets their factor
- **THEN** the user receives the matching fixed notice

#### Scenario: A notice carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an admin whose name carries markup
- **WHEN** the account-created and MFA-reset notices are rendered
- **THEN** neither string appears, no template has a link, and no template has an interpolated value

#### Scenario: A failing provider never breaks the operation

- **GIVEN** a provider that fails
- **WHEN** a user changes their password
- **THEN** the change succeeds and a suppression is logged without an address

### Requirement: Recovery notices are capped and suppressible

Recovery notices MUST go through the shared kill switch, the shared recipient-domain
allowlist, the disabled-tenant list (suppressed when every tenant of the recipient is
disabled) and a per-recipient cap of their own, default 10 per 24 hours, counted apart
from the invitation, admin-notice and reset-email buckets. A suppressed notice MUST be
logged as `catalog.security.recovery_email_suppressed` with the template and the reason,
and never an address.

#### Scenario: A full notice bucket suppresses and logs

- **GIVEN** a recipient with a full recovery-notice bucket
- **WHEN** a notice is due
- **THEN** it is not sent, the operation succeeds, and the suppression is logged with the reason `recipient_cap`

#### Scenario: Notices and reset emails count apart

- **GIVEN** a recipient who received 10 notices in a day
- **WHEN** they request a reset
- **THEN** the reset email is sent

### Requirement: Recovery operations are logged and exported without sensitive data

Every operation of this capability MUST emit the spans, metrics and log events declared in
this change's Observability contract, with the declared names and attributes, in the
identity contract module that the telemetry smoke check also enforces. No span, metric,
log record or error response MAY carry an email address, a reset token or link, a
password, a backup code, an IP address, a tenant-supplied free text, or an identifier of
a URL path; the exported path of a reset route MUST be its route template. Opaque user
and tenant ids and enumerated values are permitted. An unknown address MUST produce no
identifier on any signal.

#### Scenario: Declared telemetry is emitted

- **WHEN** each operation of this capability runs once, successfully and with each denial reason, under an in-memory exporter
- **THEN** every declared span, metric and log event is observed with its required attributes

#### Scenario: No sensitive value reaches telemetry

- **WHEN** a reset is requested and completed for `marker-user@example.com` with a marker token and password
- **THEN** none of those strings appears in any exported span, metric, log attribute or response

#### Scenario: An unknown address leaves no identifier

- **WHEN** a reset is requested for an address with no account
- **THEN** the only signals are counters and a suppression event with the reason `unknown_address`, carrying no user id

### Requirement: The public routes without an OpenAPI document are scanned

A scripted DAST probe MUST exercise the public routes that appear in no OpenAPI document:
the invitation accept route and the two reset routes. It MUST run against a sandbox tenant
with the non-sending sender and fail the run when a route answers 5xx, reflects input,
discloses a stack or answers differently for an unknown and a known address.

#### Scenario: The probe covers the three routes

- **WHEN** the DAST script runs against the sandbox
- **THEN** the probe sends malformed, oversized, prototype-polluting and replayed requests to the accept route and both reset routes and reports no finding

#### Scenario: The probe sends no mail

- **WHEN** the probe runs
- **THEN** the non-sending sender discards every message
