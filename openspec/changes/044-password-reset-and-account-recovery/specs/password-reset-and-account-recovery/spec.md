# Spec Delta: password-reset-and-account-recovery

## Purpose

Lets a person who cannot sign in recover their account without weakening the
platform: an emailed, single-use, short-lived reset link whose request answers
identically for every address, MFA-aware confirmation, session revocation, an
audited admin reset of a lost second factor, an operator break-glass for every
case the admin operation does not cover, and fixed notices that tell people when
their password or second factor changed.

## ADDED Requirements

### Requirement: The reset request answers identically for every address

`POST /v1/auth/password-reset/request` MUST accept exactly `{ email }` and MUST answer
`200` with the body `{ "accepted": true }` for every well-formed, same-site, within-limit
address, whatever the state of the account: no account, an account without a `credential`
account (SSO-only), a banned account, an account `Disabled` in every tenant it belongs to,
an eligible account, a send suppressed by a cap, the kill switch, the recipient-domain
allowlist or the disabled-tenant list, and a provider failure. The status, the body and the
headers MUST NOT depend on that state, the send MUST NOT be awaited by the response, and the
response MUST NOT be returned before a fixed minimum duration (a branch slower than that
minimum is outside this requirement and is a recorded risk). A malformed body or address,
a missing `x-csrf-token: orpc` header or an `Origin` that is not an allowed origin MUST fail
with `CATALOG_VALIDATION_FAILED` before any lookup, and an over-limit request MUST answer
`AUTH_RATE_LIMITED`; those answers depend only on the request itself. The reason a request
produced no mail MUST be recorded only on internal signals, never in the response.

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
membership MUST NOT be eligible. A user linked to Visma Connect who also has a
`credential` account MUST be eligible. A completed reset MUST NOT clear `banned`, MUST NOT
change the status of any `_user` and MUST NOT create a `credential` account. The
address MUST be put in its canonical form (NFC, trimmed, lower-cased) before any lookup,
cap or key.

#### Scenario: An SSO-only user gets no password through a reset

- **GIVEN** a user with a linked Visma Connect account and no `credential` account
- **WHEN** the address is posted to the request route
- **THEN** no token is created, no email is sent, and the answer is the uniform one

#### Scenario: A user linked to Visma Connect with a local password can reset

- **GIVEN** a user with a linked Visma Connect account and a `credential` account
- **WHEN** the address is posted to the request route
- **THEN** a token is created and one `PasswordResetEmail` is sent

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
record matches. The token MUST be usable once. A new token issued for a user MUST delete that
user's earlier unused reset tokens, so only the newest works. A token MUST be issued only for a
request the email controls admitted: a request that is suppressed by the kill switch, the
recipient-domain allowlist, the disabled-tenant list or a cap MUST issue no token and MUST NOT
delete or change any earlier token. The token and the link MUST NOT appear in any response, log record, span, metric, or in
anything the non-sending sender keeps. The link MUST be the only link in the email.

#### Scenario: The newest link wins

- **GIVEN** an eligible user who requested a reset twice
- **WHEN** the first link is submitted
- **THEN** the answer is the uniform rejection, and the second link still works

#### Scenario: A suppressed request leaves the earlier link valid

- **GIVEN** an eligible user who holds a valid link, and then a full recipient cap, a kill switch turned on, every tenant of the user on the disabled-tenant list, or a recipient domain that is not on the allowlist
- **WHEN** the address is posted again
- **THEN** the answer is the uniform one, no email is sent, no token is issued, and the earlier link still works

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
network call; a malformed body, which depends only on the request, MUST answer
`CATALOG_VALIDATION_FAILED` (the answer of the invitation accept route) and not the uniform
rejection.

#### Scenario: Every token problem looks the same

- **GIVEN** an unknown id, a wrong token for a real id, an expired token, a used token and a token of a banned account
- **WHEN** each is submitted to the confirm route
- **THEN** all five answers have the same status, code and body shape

#### Scenario: A cross-site confirmation is rejected the same way

- **WHEN** a valid token is submitted without the `x-csrf-token` header, or from an `Origin` that is not allowed
- **THEN** the answer is the uniform rejection and the token is not consumed

#### Scenario: Cheap checks run first

- **WHEN** the confirm route receives an oversized body, an unknown field or a `constructor` key
- **THEN** it answers `CATALOG_VALIDATION_FAILED` before any database, hash or breached-password lookup

### Requirement: A user with a second factor must prove it to reset the password

A user MUST be treated as enrolled when `twoFactorEnabled` is true or the user has a
verified `twoFactor` row (an enrolment still in progress is not enrolled). When the
account is enrolled, the confirm route MUST NOT change the password unless the same
request carries a valid TOTP code or an unused backup code in `factor`. A request without a
factor, or with an invalid one, MUST change nothing, MUST NOT consume the token and MUST
answer `AUTH_STEP_UP_REQUIRED`. An inconsistent state (the flag true with no verified row,
or a verified row with the flag off) MUST fail closed: the answer MUST be
`AUTH_STEP_UP_REQUIRED` for every request and nothing MUST change. The enrolled decision MUST be taken again under the per-user lock, on the connection that
holds it, before the password changes, so that a factor enrolled between the first read and
the lock is not bypassed. A used backup code MUST be spent inside the transaction that
completes the reset. Failed factors MUST count against
the account's second-factor lockout and against a budget of 5 per token, after which the
token MUST be deleted; the check, the count and the lockout MUST hold under concurrent
requests, so that parallel wrong factors consume exactly the budget. A user with no
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

#### Scenario: Parallel wrong factors cannot exceed the budget

- **WHEN** 50 requests with the right token and a wrong factor are submitted at the same time
- **THEN** exactly 5 are counted and answer `AUTH_STEP_UP_REQUIRED`, the token is then deleted, the others are the uniform rejection, and the account's failure counter did not pass 5

#### Scenario: An inconsistent factor state fails closed

- **GIVEN** a user whose `twoFactorEnabled` is true but who has no verified `twoFactor` row, and a valid token
- **WHEN** the token and a compliant password are submitted, with or without a factor
- **THEN** the answer is `AUTH_STEP_UP_REQUIRED`, the password is unchanged, the token is not consumed and no failure is counted

#### Scenario: A factor enrolled during the request is not bypassed

- **GIVEN** a user with no factor, a valid token, and a factor enrolled after the route's first read and before the lock
- **WHEN** the token and a compliant password are submitted without a factor
- **THEN** the answer is `AUTH_STEP_UP_REQUIRED`, the password is unchanged and the token is not consumed

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
consumed and before any factor is spent. The reset is one more entry point of the
"Password policy" requirement of `identity-lifecycle-and-org-admin`, which it extends, and
the breached-password check MUST see the NFC form. A refusal MUST name only the failed
rule, never the password. When the breached-password service cannot be reached, the route
MUST fail closed with a sanitized internal error and MUST NOT consume the token. The
password MUST be hashed with Better Auth's own hash function and written to the
`credential` account, so the stored hash is the one a sign-in verifies.

#### Scenario: A weak password is refused and the token survives

- **WHEN** a valid token is submitted with a password that fails the policy
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` naming only the rule, and the same token still works with a compliant password

#### Scenario: A breached password is refused and the token survives

- **WHEN** a valid token is submitted with a password in the breach corpus
- **THEN** the answer is `CATALOG_VALIDATION_FAILED`, the password is unchanged and the token is not consumed

#### Scenario: A breached password in a decomposed form is refused

- **WHEN** a valid token is submitted with the NFD spelling of a password whose NFC form is in the breach corpus
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and the token is not consumed

#### Scenario: A breach-service outage does not burn the token

- **GIVEN** the range service is unreachable
- **WHEN** a valid token and a compliant password are submitted
- **THEN** the answer is a sanitized internal error, the password is unchanged and the token is not consumed

#### Scenario: A refused password does not spend the backup code

- **GIVEN** an enrolled user, a valid token and an unused backup code
- **WHEN** the token, the backup code and a weak or breached password are submitted
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and the same backup code still completes a reset with a compliant password

#### Scenario: The new password signs in

- **WHEN** a reset completes with a compliant password
- **THEN** a sign-in with the new password succeeds (with the second factor, if enrolled) and a sign-in with the old password fails

### Requirement: A completed reset revokes access and tells the user

A completed reset MUST, in one transaction with the password write: consume the token and
delete every other reset token of the user; delete the temporary-password marker of the
user; delete the user's pending second-factor challenges; set `emailVerified` to true; spend
the backup code when one was used; and revoke every session of the user in every tenant,
emitting `auth.security.session_revoked` with the reason `password_reset` for each. If
any of these writes fails, the password MUST be unchanged and the token MUST remain
usable. A sign-in that verified the old password before the commit and would create its session
after it MUST be refused, and the check that does so MUST NOT make the sign-in answer differ
for a known and an unknown address. After the commit the system MUST send the fixed password-changed
notice, whose fixed text tells the user to review their service accounts, credentials and
linked sign-ins. The reset MUST NOT sign the user in and MUST NOT touch machine credentials,
service accounts or SSO links.

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
- **THEN** the old password still signs in, the sessions are still live, the token still works and a backup code that was presented is not spent

#### Scenario: A sign-in that began before the reset does not survive it

- **GIVEN** a sign-in that has verified the old password and is held before it creates its session
- **WHEN** a reset completes and the held sign-in then continues
- **THEN** the sign-in is refused like a wrong password, no session exists and no usable second-factor challenge exists

#### Scenario: The sign-in fence does not reveal an account

- **GIVEN** an address with a password and an address with no account
- **WHEN** each is submitted to the sign-in route
- **THEN** both answers have the same status, code and body shape, and the fence performs the same single credential lookup for each

#### Scenario: A reset leaves linked sign-ins and credentials, and the notice says to review them

- **GIVEN** a user with a linked Visma Connect account and a service account with a credential
- **WHEN** the user completes a reset
- **THEN** the link and the credential are unchanged, and the password-changed notice tells the user, in its fixed text, to review service accounts, credentials and linked sign-ins

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
with it off MUST answer exactly as an unknown `/v1` path does. Every response of both
routes MUST carry `Cache-Control: no-store` and `Pragma: no-cache`. Better Auth's
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

#### Scenario: Reset responses are not cacheable

- **WHEN** either reset route answers a success, a refusal or a rate-limit response
- **THEN** the response carries `Cache-Control: no-store` and `Pragma: no-cache`

#### Scenario: Mounting without the email path fails startup

- **WHEN** the switch is on and the reset link base URL, the recipient key secret or the email sender is not configured
- **THEN** startup fails naming the variable and never its value

#### Scenario: The client cannot choose where the link points

- **WHEN** the request route receives a `redirectTo` or `callbackURL` field
- **THEN** it answers `CATALOG_VALIDATION_FAILED`

### Requirement: Reset traffic is limited before any lookup

Each reset route MUST run a DB-backed per-IP limiter before the handler, default 10
requests per 60 seconds, answering `AUTH_RATE_LIMITED` with `Retry-After`; the limiter
state MUST be shared across replicas. The limiter key MUST be the client address
normalized to its IPv6 /64 prefix (an IPv4 address is its own /32, an IPv4-mapped IPv6
address is its IPv4 form), here and in the per-IP email cap, so that one /64 shares a
bucket. If the limiter store fails, the route MUST fail closed with a sanitized internal
error and MUST run no lookup and send no email. The invitation accept route shares this
pre-handler and so shares the key and the failure behavior. The limits MUST be configurable, and a
disabled or zero limit MUST fail startup. The limiter key MUST NOT appear in any signal
or response.

#### Scenario: The eleventh request in a minute is limited

- **WHEN** one IP posts 11 requests to the request route within 60 seconds
- **THEN** the eleventh answers `429` `AUTH_RATE_LIMITED` with `Retry-After`, before any account lookup

#### Scenario: Two addresses in one /64 share a bucket

- **WHEN** 6 requests come from `2001:db8:1:2::1` and 5 from `2001:db8:1:2:ffff::9` within 60 seconds, and one from another /64
- **THEN** the eleventh from the first /64 answers `429`, and the request from the other /64 is accepted

#### Scenario: A limiter failure fails closed

- **GIVEN** a rate-limit store that throws
- **WHEN** either reset route is called
- **THEN** the answer is a sanitized internal error, no account lookup runs and no email is sent

#### Scenario: The invitation accept route shares the key and the failure behavior

- **WHEN** 6 requests come from `2001:db8:1:2::1` and 5 from `2001:db8:1:2:ffff::9` within 60 seconds to the accept route, and the rate-limit store then throws
- **THEN** the eleventh request of that /64 is limited like any other route's, and the call during the failure answers a sanitized internal error with no acceptance attempted

#### Scenario: A zero limit fails startup

- **WHEN** `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX=0`
- **THEN** startup fails

### Requirement: The reset email is sent through controls that never become an oracle

A reset email MUST go through the platform's email sender and shared cap store with
its own caps: per recipient (keyed by the HMAC of the canonical address, never the
address or a bare digest), per IP and global, with defaults of 5 per hour per recipient,
10 per hour per IP and 600 per hour globally. It MUST obey the shared kill switch
(`INVITATION_EMAIL_KILL_SWITCH`) and the shared recipient-domain allowlist, and MUST be
suppressed when every tenant of the user is on `EMAIL_DISABLED_TENANT_IDS`. These controls
MUST be applied in this order, all before the token is issued: the kill switch, the
recipient-domain allowlist, the disabled-tenant list, then the per-recipient, the per-IP and
the global caps, so that a request refused by a narrower control consumes none of the wider
buckets. A request they refuse changes no token; the allowlist is decided at admission, not
when the message is handed to the provider. Every refusal (a cap, the kill switch, the
allowlist, a disabled tenant, a provider failure) MUST be silent: the response stays the
uniform one, and the refusal MUST be logged only with a closed reason and no address. A
refused request MUST NOT consume the token's single use.

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
- **THEN** nothing is sent, no token is issued, the answer is the uniform one, and the allowlist case logs `catalog.security.email_recipient_blocked` with the template and no address, and `catalog.security.recovery_email_suppressed` with the reason `recipient_domain_blocked`

#### Scenario: A provider failure is invisible to the caller

- **GIVEN** a provider that fails with an error containing the recipient address
- **WHEN** the address is posted
- **THEN** the answer is the uniform one and the address appears in no signal

#### Scenario: A narrower refusal consumes no wider bucket

- **GIVEN** an address whose recipient cap is full, and an IP and a global bucket with room
- **WHEN** the address is posted
- **THEN** no email is sent and the IP and global buckets are unchanged

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
remove the second factor of a **member** of the same tenant who lost both the authenticator
and the backup codes. The request MUST carry a reason code from the closed set
`lost_both_factors`, `device_replaced`, `suspected_compromise`, `identity_verified_request`,
and the audit event MUST record it. It MUST be a high-risk operation (step-up required), MUST
go through the identity operation wrapper (the caller's role is checked before the input is
parsed, the target is resolved on the server, Cerbos decides with the resource kind
`user` and the action `resetMfa`, and any Cerbos error denies), and MUST be behind the
mount switch. A target that is not a member of the caller's tenant, or does not exist,
MUST answer `CATALOG_NOT_FOUND`, identical for both. An admin MUST NOT reset their own
second factor, and MUST NOT reset the factor of another admin or of an owner: those attempts
are refused, nothing changes, and the policy and the service both enforce it. With the policy
bundle deployed, the policy answers `AUTH_FORBIDDEN` for the self, admin and owner targets,
which reveals only the caller's own id and the roles of the caller's own tenant; without it,
the service answers them with `CATALOG_VALIDATION_FAILED`. A target with no enrolled factor, a
target who also belongs to another tenant, and a target who is not a plain member MUST each be
refused by the service with the same `CATALOG_VALIDATION_FAILED` answer, identical in status,
code, message and body shape, decided after every check has been evaluated, so that neither
the order nor the time of the refusal reveals which held; only the internal log carries the
reason, and the response MUST NOT reveal a membership in another tenant. On success the
operation MUST delete the target's second factor, revoke every session of the target, mark the
target for re-enrolment, send the fixed MFA-reset notice to the target's registered address,
and emit the audit event. It MUST NOT revoke or change machine credentials, service accounts or
SSO links of the target.

#### Scenario: An admin resets a member's lost factor

- **GIVEN** a member with TOTP enrolled and an admin of the same tenant with a fresh MFA verification
- **WHEN** the admin calls `identity.users.resetMfa` for the member with the reason `lost_both_factors`
- **THEN** the member's second factor is gone, the member's sessions are rejected, the member receives the MFA-reset notice, and `catalog.audit.mfa_reset` is logged with the admin's id, the reason and the member's opaque id

#### Scenario: A member cannot reset anyone's factor

- **GIVEN** a `member` with a fresh MFA verification, and a machine `member` token
- **WHEN** either calls the operation
- **THEN** the answer is `AUTH_FORBIDDEN` for any target, existing or not

#### Scenario: Step-up is required

- **WHEN** an admin without a fresh MFA verification calls the operation
- **THEN** the answer is `AUTH_STEP_UP_REQUIRED` and nothing changes

#### Scenario: A reason code is required

- **WHEN** an admin calls the operation with no reason, or with a value outside the closed set
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and nothing changes

#### Scenario: A target in another tenant looks like a missing one

- **GIVEN** a member of tenant `t2`
- **WHEN** an admin of `t1` calls the operation for that member, and for an address with no account
- **THEN** both answers are `CATALOG_NOT_FOUND` with the same body

#### Scenario: Self-target is refused

- **WHEN** an admin calls the operation for their own account
- **THEN** it is refused, nothing changes, and `catalog.security.self_mfa_reset_denied` is logged with the tenant and the admin's id, whether or not the policy bundle is deployed
- **AND** the answer is `AUTH_FORBIDDEN` with the policy bundle deployed and `CATALOG_VALIDATION_FAILED` without it

#### Scenario: An admin or owner target is refused

- **GIVEN** a second admin and an owner of the same tenant, both with a second factor
- **WHEN** an admin calls the operation for each
- **THEN** it is refused, nothing changes, and only the operator command can reset them
- **AND** the answer is `AUTH_FORBIDDEN` with the policy bundle deployed and `CATALOG_VALIDATION_FAILED` without it

#### Scenario: A member of several tenants is refused

- **GIVEN** a member of `t1` who also belongs to `t2`
- **WHEN** an admin of `t1` calls the operation
- **THEN** the answer is `CATALOG_VALIDATION_FAILED`, nothing changes, and `catalog.security.identity_conflict_refused` is logged with the reason `target_in_other_tenant`

#### Scenario: A target with no second factor is refused

- **WHEN** an admin calls the operation for a member with no enrolled factor
- **THEN** the answer is `CATALOG_VALIDATION_FAILED` and nothing changes

#### Scenario: The refusals are indistinguishable

- **GIVEN** a member with no enrolled factor, a member of two tenants, and a member of two tenants with no factor
- **WHEN** an admin calls the operation for each
- **THEN** the three responses have the same status, code, message and body bytes, and the three internal records carry their own reasons

#### Scenario: An MFA reset leaves credentials and linked sign-ins, and the notice says to review them

- **GIVEN** a member with a second factor, a linked Visma Connect account and a service account with a credential
- **WHEN** an admin, or the operator command, resets the member's second factor
- **THEN** the link and the credential are unchanged, and the MFA-reset notice tells the member, in its fixed text, to review service accounts, credentials and linked sign-ins

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

### Requirement: Operator recovery covers every target the admin operation does not

The platform MUST provide an operator command, run out of band and never mounted on a
route, that resets the second factor of a named member of a named organization with the
same effects as the admin operation (second factor removed, sessions revoked, member
marked for re-enrolment, notice sent) and an audit event that names the operator and the
approver, not an admin. The target MAY be of any role (an admin, an owner or a member), in
one tenant or several, and MAY be a user whose factor a third party enrolled. The command MUST
require an approver id, of the operator id's form, that differs from the operator id, and MUST
refuse to run otherwise. It MUST refuse an unknown organization or a user who is not a member
of it. It MUST NOT load the Better Auth signing secret: it works through SQL on the
`tayzu_auth` role and its declared variable list MUST exclude `BETTER_AUTH_SECRET`. It MUST
send the fixed notice through the sender, the kill switch and the disabled-tenant list.
Its entry point MUST refuse to start, whatever `NODE_ENV` says, before any database or email work, when
`TAYZU_TELEMETRY_DISABLED` is true or no OTLP endpoint is set, so that its audit event cannot be
switched off by the person it audits, and it MUST exit non-zero when the final telemetry flush
fails. On completion it MUST print exactly one line, for the operator to attach to the
just-in-time access record, holding the operator id, the approver id, the target's opaque user id,
the number of sessions revoked and whether the notice was sent, suppressed or failed, and no address and
no secret. The line MUST be printed before the final telemetry flush, so that a failed flush does not lose it. A runbook MUST state who may run it, that a production run happens only from the
production-network operator environment under just-in-time access with a personal account and
never from a laptop, the identity verification and the second approver it requires, and the order
of the recovery: the person requests the reset link before the run, the operator runs the
command, the person confirms the reset at once and then enrols a second factor in a supervised
session, and the account is handed back only after the enrolment, so that no one who knew the old
password has a window to enrol first; if the confirmation asks for a factor, the run is repeated.

#### Scenario: The operator resets the last admin's factor

- **GIVEN** an organization whose only admin lost the authenticator and the backup codes
- **WHEN** the operator runs the command for that admin with an approver
- **THEN** the admin's factor is gone, their sessions are revoked, they are marked for re-enrolment, they receive the MFA-reset notice, and `catalog.audit.mfa_reset` is logged with the operator's id and the approver's id

#### Scenario: The command refuses a user outside the organization

- **WHEN** the operator names a user who is not a member of the organization
- **THEN** the command fails, changes nothing and prints no account detail

#### Scenario: The command requires a second approver

- **WHEN** the command runs with no approver, or with the operator's own id as the approver
- **THEN** it fails before any database or email work and changes nothing

#### Scenario: The command holds no signing key

- **WHEN** the command's declared variable list is read
- **THEN** it contains `AUTH_DATABASE_URL`, `TAYZU_OPERATOR_ID` and the email variables, and not `BETTER_AUTH_SECRET`, `DATABASE_URL` or `CERBOS_ADDRESS`

#### Scenario: The command refuses to run without telemetry

- **GIVEN** any value of `NODE_ENV`, including `test`
- **WHEN** the command's entry point starts with `TAYZU_TELEMETRY_DISABLED=true`, or with no OTLP endpoint set
- **THEN** it exits non-zero before any database or email work and changes nothing

#### Scenario: A failed telemetry flush fails the run

- **WHEN** the final telemetry flush of a completed run fails
- **THEN** the command exits non-zero with a fixed message that says the audit event may be missing, and the completion line was already printed

#### Scenario: The command prints one completion line

- **WHEN** the command completes
- **THEN** it prints exactly one line holding the operator id, the approver id, the target's opaque user id, the number of sessions revoked and whether the notice was sent, suppressed or failed, and no address and no secret

#### Scenario: The completion line reports a failed notice

- **WHEN** the command completes and the email provider fails on the notice
- **THEN** the run still completes and the line says the notice failed, so the operator knows the owner was not told

#### Scenario: The operator resets a member of several tenants

- **GIVEN** a member of two organizations whose admin was refused by the admin operation
- **WHEN** the operator runs the command for that member with an approver
- **THEN** the factor is gone, the member's sessions in both organizations are revoked, and the notice is sent

#### Scenario: A squatter enrolled a factor on an account created for my address

- **GIVEN** an admin created an account for `victim@example.com`, signed in with the temporary password and enrolled a TOTP factor, and the victim's reset now asks for a code the victim never set up
- **WHEN** the victim contacts the platform operator, requests a reset link before the run, the operator runs the command for that member with an approver, and the victim confirms with the link at once
- **THEN** the squatter's factor and sessions are gone, the victim completes the reset with the link alone, and the old password no longer signs in

#### Scenario: A squatter who re-enrols in the window is removed by a repeat run

- **GIVEN** the state after the command ran in the scenario above, and the squatter signs in with the old password before the victim confirms
- **WHEN** the squatter's session calls a `/v1` route and then enrols a TOTP factor, and the victim's confirmation then asks for a factor
- **THEN** the `/v1` call is rejected as a missing context, the confirmation answers `AUTH_STEP_UP_REQUIRED`, and a second run of the command followed at once by the victim's confirmation completes the reset

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
recipient. The password-changed notice and the MFA-reset notice MUST each tell the user, in
the same fixed sentence, to review their service accounts, credentials and linked sign-ins.
The account-created notice MUST tell the owner to use the forgot-password page
if they do not expect the account and to contact the platform operator if a reset asks for a
code they never set up. A notice MUST NOT block the operation that triggered it and MUST NOT be
sent when the operation fails.

#### Scenario: A squatted address is warned

- **WHEN** an admin creates an account for `victim@example.com` through `identity.users.create`
- **THEN** `victim@example.com` receives the fixed account-created notice, with no link, no organization name and the operator-contact sentence, and the response of the operation is unchanged

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
from the invitation, admin-notice and reset-email buckets. The account-created notice MUST
also be capped per creating tenant (default 20 per 24 hours) and globally (default 1000 per
24 hours), each configurable and failing startup when zero. A suppressed notice MUST be
logged as `catalog.security.recovery_email_suppressed` with the template and the reason,
and never an address. The break-glass command's one notice is the exception to the caps: it goes through the sender, the kill switch and the disabled-tenant list and has no cap store, so it is outside the per-recipient cap (the supervised run is its control).

#### Scenario: A full notice bucket suppresses and logs

- **GIVEN** a recipient with a full recovery-notice bucket
- **WHEN** a notice is due
- **THEN** it is not sent, the operation succeeds, and the suppression is logged with the reason `recipient_cap`

#### Scenario: Notices and reset emails count apart

- **GIVEN** a recipient who received 10 notices in a day
- **WHEN** they request a reset
- **THEN** the reset email is sent

#### Scenario: The account-created notice has its own tenant and global caps

- **GIVEN** a tenant whose admins created 20 users in the day, and then a platform that sent 1000 account-created notices in the day
- **WHEN** an admin of that tenant creates another user, and then an admin of another tenant creates one
- **THEN** both creations succeed, neither notice is sent, and the suppressions are logged with the reasons `tenant_cap` and `global_cap` and no address

### Requirement: Recovery operations are logged and exported without sensitive data

Every operation of this capability MUST emit the spans, metrics and log events declared in
this change's Observability contract, with the declared names and attributes, in the
identity contract module that the telemetry smoke check also enforces. No span, metric,
log record or error response MAY carry an email address, a reset token or link, a
password, a backup code, an IP address, a tenant-supplied free text, or an identifier of
a URL path; the exported path of a reset route MUST be its route template. Opaque user,
tenant, operator and approver ids and enumerated values are permitted. An unknown address
MUST produce no identifier on any signal. Every audit and denial event MUST be emitted in the
active span of its request or operation, so that it carries the trace id.

#### Scenario: Declared telemetry is emitted

- **WHEN** each operation of this capability runs once, successfully and with each denial reason, under an in-memory exporter
- **THEN** every declared span, metric and log event is observed with its required attributes

#### Scenario: No sensitive value reaches telemetry

- **WHEN** a reset is requested and completed for `marker-user@example.com` with a marker token and password
- **THEN** none of those strings appears in any exported span, metric, log attribute or response

#### Scenario: An unknown address leaves no identifier

- **WHEN** a reset is requested for an address with no account
- **THEN** the only signals are counters and a suppression event with the reason `unknown_address`, carrying no user id

#### Scenario: Audit and denial events carry the trace id

- **WHEN** a reset is completed, a confirm is denied and an MFA reset is performed
- **THEN** each of the audit and denial log records carries the trace id of its request or operation

### Requirement: The public routes without an OpenAPI document are scanned

A scripted DAST probe MUST exercise the public routes that appear in no OpenAPI document:
the invitation accept route and the two reset routes. It MUST run against a sandbox tenant
with the non-sending sender and fail the run when a route answers 5xx, reflects input,
discloses a stack, omits `Cache-Control: no-store` on a reset route or answers differently for
an unknown and a known address.

#### Scenario: The probe covers the three routes

- **WHEN** the DAST script runs against the sandbox
- **THEN** the probe sends malformed, oversized, prototype-polluting and replayed requests to the accept route and both reset routes and reports no finding

#### Scenario: The probe sends no mail

- **WHEN** the probe runs
- **THEN** the non-sending sender discards every message
