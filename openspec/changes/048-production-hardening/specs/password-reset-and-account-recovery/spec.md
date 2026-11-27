## ADDED Requirements

### Requirement: Passwords are stored with the platform's password hash

Every password the platform stores MUST be hashed by the platform's own password hash
function: scrypt with `N = 2^15`, `r = 8`, `p = 3`, a random salt of at least 16 bytes and a
64-byte derived key, in a self-describing format that names the algorithm and its cost
parameters, and compared in constant time. The function MUST NFC-normalize the password
before hashing and before verifying, and MUST apply no other normalization. A stored hash in
the authentication library's earlier `salt:key` format MUST still verify, through that
library's own verification, and a successful local sign-in that verifies a hash in that
format, or in the platform's format with a lower cost than the current one, MUST rewrite it
in the current format. The rewrite MUST NOT overwrite a hash that changed since the sign-in
read it, and MUST NOT change the answer, the timing or the telemetry of a failed sign-in.
A stored value in neither format MUST fail verification.

#### Scenario: A new password is stored in the current format

- **WHEN** a password is set through acceptance, user creation, the bootstrap, `/change-password` or a reset
- **THEN** the stored hash names scrypt with `N = 2^15`, `r = 8` and `p = 3` and verifies at sign-in

#### Scenario: A legacy hash still signs in and is upgraded

- **GIVEN** a user whose stored hash is in the earlier `salt:key` format
- **WHEN** they sign in with the correct password
- **THEN** the sign-in succeeds and the stored hash is now in the current format, and the next sign-in still succeeds

#### Scenario: A failed sign-in does not touch the hash

- **GIVEN** a user whose stored hash is in the earlier format
- **WHEN** they sign in with a wrong password
- **THEN** the answer is the uniform sign-in failure, the stored hash is unchanged, and no rehash event or write happens

#### Scenario: A rehash never overwrites a concurrent reset

- **GIVEN** a sign-in with the old password whose hash read happens before a reset commits
- **WHEN** the sign-in's rehash runs after the reset
- **THEN** the reset's hash is kept, and the sign-in is refused as it is today

#### Scenario: A malformed stored hash fails closed

- **WHEN** a stored hash names an unknown algorithm, has malformed parameters or has a truncated key
- **THEN** verification fails and the sign-in is refused like a wrong password

## MODIFIED Requirements

### Requirement: The new password meets the password policy before the token is spent

The confirm route MUST apply the same password policy as every other path that sets a
password (NFC normalization, the length bounds, character classes, refused characters,
the denylist) and the breached-password check, and MUST do so before the token is
consumed and before any factor is spent. The reset is one more entry point of the
"Password policy" requirement of `identity-lifecycle-and-org-admin`, which it extends, and
the breached-password check MUST see the NFC form. A refusal MUST name only the failed
rule, never the password. When the breached-password service cannot be reached, the route
MUST fail closed with a sanitized internal error and MUST NOT consume the token. The
password MUST be hashed with the platform's password hash function, the same one every
other path that sets a password uses, and written to the `credential` account, so the
stored hash is the one a sign-in verifies.

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

#### Scenario: The reset stores the platform's current hash format

- **WHEN** a reset completes with a compliant password
- **THEN** the stored hash of the `credential` account is in the platform's current self-describing format with the current cost parameters

### Requirement: Operator recovery covers every target the admin operation does not

The platform MUST provide an operator command, run out of band and never mounted on a
route, that resets the second factor of a named member of a named organization with the
same effects as the admin operation (second factor removed, sessions revoked, member
marked for re-enrolment, notice sent) and an audit event that names the operator and the
approver, not an admin. The target MAY be of any role (an admin, an owner or a member), in
one tenant or several, and MAY be a user whose factor a third party enrolled. The command MUST
require an approver id, of the operator id's form, that differs from the operator id, and MUST
refuse to run otherwise. It MUST refuse an unknown organization or a user who is not a member
of it. It MUST NOT load the Better Auth secrets: it works through SQL on the
`tayzu_auth` role and its declared variable list MUST exclude `BETTER_AUTH_SECRETS` and the
retired `BETTER_AUTH_SECRET`. It MUST
send the fixed notice through the sender, the kill switch and the disabled-tenant list, and
it MUST reach the email provider with the operator's own signed-in cloud identity, held under
just-in-time access, never with a stored connection string.
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
- **THEN** it contains `AUTH_DATABASE_URL`, `TAYZU_OPERATOR_ID` and the email variables, among them the provider's endpoint, and not `BETTER_AUTH_SECRETS`, `BETTER_AUTH_SECRET`, `ACS_CONNECTION_STRING`, `DATABASE_URL` or `CERBOS_ADDRESS`

#### Scenario: The command authenticates to the email provider as the operator

- **GIVEN** a real email provider configured for the command
- **WHEN** the command sends its notice
- **THEN** the provider is reached with a token from the operator's own signed-in cloud identity, and the command refuses to start when a connection string variable is set

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
