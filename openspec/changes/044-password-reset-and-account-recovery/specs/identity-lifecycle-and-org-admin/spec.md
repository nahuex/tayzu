# Spec Delta: identity-lifecycle-and-org-admin

## MODIFIED Requirements

### Requirement: Invitation email is fixed and capped

The invitation email MUST be sent to exactly one recipient, a single plain
address with no line breaks, display name or list separator, and MUST have no
CC, BCC or attachment. Its subject and template MUST be fixed: only the link
and the expiry text are interpolated, and no organization name, inviter name or
other tenant or inviter free text appears. The link origin MUST come from
the dedicated trusted setting `INVITATION_LINK_BASE_URL` (`https` outside test and
one of the allowed origins), never from `BETTER_AUTH_URL`, the request `Host` or a
forwarded header, and the link MUST carry the invitation id and token in the
URL fragment, on a fixed path. The only other email this capability sends through these controls is the notice to the
other admins when an `admin` invitation is accepted, a fixed template with no interpolated
value, with no link or any tenant, actor or invitee free text (`045` adds the org-deletion
notice to the same controls). `identity.users.create` also sends the fixed account-created
notice to the address of the account it creates; that notice, like the password-reset email
and the password and second-factor notices, belongs to the
`password-reset-and-account-recovery` capability and is counted in buckets of its own, so
it neither consumes nor is limited by the buckets of this requirement. Every notice MUST go through the same global kill switch as the
invitation email and through a per-recipient cap of its own, with the same limit of 3 per
24 hours and the same keyed hash of the normalized email, counted apart from the
invitation cap, so that invitations cannot exhaust a person's notice budget and notices
cannot exhaust their invitation budget; every notice MUST be capped per tenant, and MUST go to
at most 20 recipients, the administrators who have been members the longest; a
suppressed or truncated notice MUST NOT block the operation that triggered it and
MUST be logged as `catalog.security.notice_suppressed`. The token and the link MUST NOT appear in the response of the operation
that sends an invitation or resends it, in any log record, or in anything the
non-sending sender keeps, because the token proves mailbox control. The provider MUST
NOT track clicks or engagement, and the message MUST have no Reply-To. Creating and resending invitations MUST be capped at 30 per hour
per tenant, 3 per 24 hours per recipient across all tenants (keyed by an HMAC of
the normalized email under a server secret, never the address nor a bare digest of it), and by a global kill switch. A
disabled or zero cap MUST fail startup. A bucket MUST reset only after a full window with
no allowed request (the semantics of the shared rate-limit store), so the caps are
stricter than their nominal rate. Exceeding any cap MUST fail the
operation with `AUTH_RATE_LIMITED` and a `Retry-After` header that is the same for
every invitation cap, send no email, and log
`catalog.security.invitation_rate_limited` with its scope. Where
`NODE_ENV` is not `test`, startup MUST fail unless the email provider is set explicitly
(the non-sending sender is an explicit choice, and CI and DAST MUST use it). Under
`NODE_ENV=test` a real provider MUST be configured only together with a
recipient-domain allowlist, and startup MUST fail without it; wherever an allowlist is
set, a recipient whose domain is not on it MUST be refused like a provider failure and
logged as `catalog.security.email_recipient_blocked`. An email of a tenant on the configured list of disabled tenants (the
demo tenants) MUST be suppressed before any cap is consumed, MUST NOT block the operation,
and MUST be logged as `catalog.security.email_tenant_blocked` with the tenant and the
template.

#### Scenario: The invitation link never leaves the email

- **WHEN** an admin invites or resends an invitation to `bob@example.com`
- **THEN** the response, every log record and anything the non-sending sender keeps contain neither the token nor the id-plus-token link, which only the email carries

#### Scenario: A demo tenant sends no email

- **GIVEN** a tenant on the list of disabled tenants and a real sender
- **WHEN** an admin of that tenant invites a user, or an `admin` invitation is accepted
- **THEN** nothing reaches the sender, no cap bucket is consumed, the operation succeeds, and `catalog.security.email_tenant_blocked` is logged with the tenant and the template and no address

#### Scenario: Injection through the invited address is impossible

- **WHEN** an admin invites an address containing a line break, a display name, a list separator or more than 254 characters
- **THEN** the operation fails and no email is sent

#### Scenario: The template carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an inviter with a markup-bearing name
- **WHEN** an invitation is sent
- **THEN** neither string appears in the subject or body, and the subject is the fixed one

#### Scenario: The link origin ignores the request headers

- **WHEN** an invitation is created from a request with a forged `Host` and `X-Forwarded-Host`
- **THEN** the emailed link starts with the configured `INVITATION_LINK_BASE_URL`, and its id and token are in the fragment

#### Scenario: The admin notice carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an invitee with a markup-bearing name
- **WHEN** the notice to the other admins is sent
- **THEN** neither string appears, the notice has no link, and it has no interpolated value

#### Scenario: The notices are under the kill switch and the caps

- **GIVEN** the kill switch is on, or the per-tenant notice cap is exhausted, or a recipient's per-recipient bucket is full
- **WHEN** an `admin` invitation is accepted
- **THEN** the operation succeeds, no email goes to the affected recipients, and `catalog.security.notice_suppressed` is logged with the template and the reason

#### Scenario: Notices and invitations count in separate recipient buckets

- **GIVEN** two administrators of a tenant, the first with a full invitation bucket after three invitations from other tenants, the second with a full notice bucket after three notices
- **WHEN** an `admin` invitation is accepted in that tenant, and another tenant then invites the second administrator
- **THEN** the first administrator receives the notice, the second one's notice is suppressed with the reason `recipient`, and the invitation of the second one is sent

#### Scenario: A notice goes to at most 20 recipients

- **GIVEN** an organization with 25 administrators
- **WHEN** an `admin` invitation is accepted
- **THEN** exactly 20 emails are sent, to the administrators who have been members the longest (the new admin excluded), and the truncation is logged

#### Scenario: Every cap answers with the same Retry-After

- **WHEN** the per-tenant cap and the per-recipient cap each reject an invitation
- **THEN** both answers carry the same `Retry-After` value

#### Scenario: A slow trickle never resets a bucket

- **GIVEN** a per-recipient bucket of 3 per 24 hours and requests spaced just under 24 hours apart
- **WHEN** the fourth request arrives
- **THEN** it is refused, because only a full window with no allowed request resets the bucket

#### Scenario: A deployed environment must choose its email provider

- **WHEN** the platform starts with a `NODE_ENV` other than `test` and no explicit email provider
- **THEN** startup fails

#### Scenario: A real sender under the test environment needs an allowlist

- **WHEN** the platform starts with `NODE_ENV=test`, a real email provider and no recipient-domain allowlist
- **THEN** startup fails
- **AND** with the allowlist, an invitation to a recipient off it sends nothing and logs `catalog.security.email_recipient_blocked` without the address

#### Scenario: Exceeding the per-tenant cap blocks further invites

- **GIVEN** a tenant that has already created or resent 30 invitations in the current hour
- **WHEN** an admin attempts one more invite or resend
- **THEN** the operation fails with `AUTH_RATE_LIMITED`, no email is sent, and `catalog.security.invitation_rate_limited` is logged with scope `tenant`

#### Scenario: Exceeding the per-recipient cap blocks repeat invites across tenants

- **GIVEN** three invitations to `victim@example.com` in 24 hours from any tenants
- **WHEN** another tenant invites `victim@example.com`
- **THEN** the operation fails with `AUTH_RATE_LIMITED`, no email is sent, and the event has scope `recipient` and no email address

#### Scenario: The global kill switch stops all invitation email

- **GIVEN** `INVITATION_EMAIL_KILL_SWITCH` is on
- **WHEN** any invite or resend is attempted
- **THEN** it fails with `AUTH_RATE_LIMITED` and no email is sent

#### Scenario: Creating a user sends the account-created notice outside these buckets

- **GIVEN** an address whose invitation bucket and admin-notice bucket are both full
- **WHEN** an admin creates a user for that address through `identity.users.create`
- **THEN** the operation succeeds and the fixed account-created notice is sent, because it is counted in the recovery-notice bucket
