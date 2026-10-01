# Spec Delta

## Purpose

Identity lifecycle and org administration completes Tayzu's identity model on
top of `002-auth-and-rbac`'s baseline: the full 4-state user lifecycle with
invitations, service accounts, org API-credential visibility and rotation,
and org-level data deletion, all attributed and audited the same way as every
other catalog mutation.

## Conventions

- **New Cerbos resource kinds**: `service_account`, `credential`,
  `organization`. `user.invite` and `user.updateStatus` are new actions on
  `002-auth-and-rbac`'s existing `user` resource kind, not a new kind.
- **Reused error codes**: this capability introduces no new error codes. A
  Cerbos deny on any operation added here surfaces as `002`'s `AUTH_FORBIDDEN`
  (403). The step-up gate on `setStatus`, `credentials.rotate`,
  `credentials.revoke`, and `organization.delete` surfaces as `002`'s
  existing `AUTH_STEP_UP_REQUIRED` (403). The per-tenant invitation rate
  limit surfaces as `002`'s existing `AUTH_RATE_LIMITED` (429).
- **`_user.status` values**: `Staged`, `Invited`, `Active`, `Disabled` — the
  same capitalization `002-auth-and-rbac` already establishes for
  `Active`/`Disabled`.

## ADDED Requirements

### Requirement: User status has four states with forward-only transitions
The `_user` system blueprint's `status` property MUST take one of four
values: `Staged`, `Invited`, `Active`, `Disabled` (the same capitalization
`002-auth-and-rbac` already uses for `Active`/`Disabled`). A user is `Staged`
when created without an explicit invite (default for a `_user` entity created
with no `status` or `status: Staged`). A user is `Invited` when an admin
explicitly invites them, whether via the invite operation or a `_user` entity
created with `status: Invited`. Both `Staged` and `Invited` users transition
to `Active` on their first successful sign-in. A user's status MUST NOT
transition from `Active` back to `Invited` or `Staged` under any operation.
Any status MUST be able to transition to `Disabled` through an explicit
admin action, and a `Disabled` user MUST be able to transition back to
`Active` through an explicit admin action (never automatically).

#### Scenario: New user without an invite starts staged
- **WHEN** a `_user` entity is created with no `status` given
- **THEN** its status is `Staged`

#### Scenario: Explicit invite starts a user as invited
- **WHEN** an admin invites `alice@example.com`
- **THEN** a `_user` entity for `alice@example.com` exists with status `Invited`

#### Scenario: First sign-in activates a staged or invited user
- **GIVEN** a `_user` entity with status `Staged`
- **WHEN** that user signs in successfully for the first time
- **THEN** its status becomes `Active`

#### Scenario: Active never regresses to invited or staged
- **GIVEN** a `_user` entity with status `Active`
- **WHEN** any operation is attempted that would set its status to `Invited` or `Staged`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED`

#### Scenario: Disable and re-enable
- **GIVEN** a `_user` entity with status `Active`
- **WHEN** an admin disables the user, and later re-enables them
- **THEN** the status becomes `Disabled` and then `Active`, in each case attributed to the admin

### Requirement: Only an admin may invite a user or change another user's status
Inviting a user and changing a user's status (disable, re-enable) MUST be
authorized by Cerbos against the acting principal's role, never by branching
on `actor.type`. A user MUST NOT be able to change their own status. An
attempt to do either without the required grant MUST fail with
`AUTH_FORBIDDEN` (`002-auth-and-rbac`'s Cerbos-deny error code) and MUST be
logged as a security event.

#### Scenario: Non-admin cannot invite
- **WHEN** an actor without the invite grant attempts to invite a user
- **THEN** the operation is denied with `AUTH_FORBIDDEN` and no invitation is created

#### Scenario: A user cannot disable themselves
- **GIVEN** an admin user `u1`
- **WHEN** `u1` attempts to change their own status to `Disabled`
- **THEN** the operation is denied with `AUTH_FORBIDDEN`, `u1` stays `Active`, and a `catalog.security.self_status_change_denied` event is logged

### Requirement: Invitation lifecycle
An invitation MUST record the invited email, the inviting actor, an
expiry 48 hours after creation, and one of the states `pending`, `accepted`,
`rejected`, `cancelled`, `expired`. Creating an invitation for an email that
already has a `pending` invitation MUST cancel the previous invitation before
creating the new one. Accepting an invitation MUST require the accepting
session's email to match the invited email exactly. Only a `pending`,
non-expired invitation MUST be acceptable; accepting a `rejected`,
`cancelled`, `expired`, or already-`accepted` invitation MUST fail and MUST
NOT change the invited user's status. Every rejected-acceptance case
(nonexistent invitation, wrong state, and mismatched email) MUST return the
same status, error code, and body shape to the caller, so the response
itself cannot be used to enumerate valid invitations or their state; the
specific reason is recorded only in the
`catalog.security.invitation_acceptance_denied` security log event, never in
the HTTP response.

#### Scenario: Invite sends exactly one email with exactly one link
- **WHEN** an admin invites `bob@example.com`
- **THEN** exactly one email is sent to `bob@example.com`
- **AND** the email contains exactly one clickable link, the invitation-accept link, and states the 48-hour expiry

#### Scenario: Re-inviting cancels the previous invitation
- **GIVEN** a `pending` invitation to `bob@example.com`
- **WHEN** the admin invites `bob@example.com` again
- **THEN** the first invitation's state becomes `cancelled` and a new `pending` invitation is created with a fresh 48-hour expiry

#### Scenario: Accepting an expired invitation fails
- **GIVEN** an invitation to `bob@example.com` past its 48-hour expiry
- **WHEN** `bob@example.com` attempts to accept it
- **THEN** the acceptance fails, the invitation's state becomes (or already is) `expired`, and `bob`'s user status is unchanged

#### Scenario: Accepting a cancelled invitation fails
- **GIVEN** an invitation cancelled by re-invite or by explicit cancel
- **WHEN** the invited email attempts to accept it
- **THEN** the acceptance fails and no status change occurs

#### Scenario: Accepting with a mismatched session email fails
- **GIVEN** a pending invitation to `bob@example.com`
- **WHEN** a session authenticated as `carol@example.com` attempts to accept it
- **THEN** the acceptance fails

#### Scenario: Invitation-acceptance errors do not reveal which failure occurred
- **GIVEN** three invitations to `bob@example.com`: one that does not exist, one expired, and one pending but accepted by a mismatched session email
- **WHEN** each acceptance attempt is made
- **THEN** all three fail with the same status, error code, and body shape, none of which reveals which specific reason caused the failure

#### Scenario: Admin can cancel a pending invitation
- **GIVEN** a pending invitation to `bob@example.com`
- **WHEN** the admin cancels it
- **THEN** its state becomes `cancelled` and it can no longer be accepted

#### Scenario: Resending a pending invitation does not change its expiry
- **GIVEN** a pending invitation to `bob@example.com` created 10 hours ago
- **WHEN** the admin resends it
- **THEN** another email is sent to `bob@example.com` with the same invitation link
- **AND** the invitation's expiry is still 48 hours from its original creation, not from the resend

### Requirement: Per-tenant invitation rate limiting
Creating and resending invitations MUST be rate-limited per tenant, so a
single organization cannot use the invitation-email surface to send bulk,
phishing-style messages through Tayzu's outbound email capability. Exceeding
the configured limit MUST fail the invite or resend operation with
`AUTH_RATE_LIMITED`, without sending an email, and MUST be logged as a
security-relevant signal distinguishable from an ordinary Cerbos deny.

#### Scenario: Exceeding the per-tenant invite rate limit blocks further invites
- **GIVEN** a tenant that has already created or resent the configured maximum number of invitations in the current window
- **WHEN** an admin attempts one more invite or resend
- **THEN** the operation fails, no email is sent, and the excess-invitation attempt is logged

### Requirement: Service accounts are non-human users created API-only
A service account MUST be a `_user` entity with `accountKind: "service"`
(as opposed to `"standard"` for a human user). Creating a service account
MUST be authorized to admins only, MUST set its status to `Active`
immediately with no invitation email sent, and MUST atomically issue one
organization-owned machine credential (`clientId`/`clientSecret`) for it. The
credential's secret MUST be returned exactly once, in the creation response,
and MUST NOT be retrievable again afterward. Disabling a service account
MUST also disable its credential, so that no new access token can be issued
from it. Re-enabling reverses both. Deleting a service account's `_user`
entity MUST also revoke (not merely disable) its credential.

A service account MUST NOT hold the `admin` role and MUST NOT hold a
Moderator grant over any blueprint (`moderatedBlueprints` MUST stay empty):
it is restricted to `member` only, always, because service accounts
authenticate as `integration`-kind actors and, per `002-auth-and-rbac`'s
step-up requirement, never go through step-up MFA — an elevated role bound
to a leaked service-account secret would otherwise have no MFA layer at all,
unlike the human `admin` it would mirror. Creating or updating a `_user`
entity with `accountKind: "service"` and a role or `moderatedBlueprints`
value that would grant it more than `member` MUST fail, both at input
validation and, independently, as a Cerbos deny.

#### Scenario: Creating a service account with an elevated role is rejected
- **WHEN** an admin attempts to create a service account with role `admin`
- **THEN** the operation fails and no `_user` entity or credential is created

#### Scenario: Granting an existing service account a Moderator grant is rejected
- **GIVEN** service account `ci-github` with role `member` and no Moderator grant
- **WHEN** an admin attempts to add a blueprint to its `moderatedBlueprints` list
- **THEN** the operation fails and `ci-github`'s `moderatedBlueprints` stays empty

#### Scenario: Service account is active immediately, no email
- **WHEN** an admin creates service account `ci-github` for tenant `t1`
- **THEN** the returned `_user` entity has status `Active` and `accountKind: "service"`
- **AND** no invitation email is sent
- **AND** the response includes a `clientId` and a `clientSecret` that never appear in any later read of the account

#### Scenario: A non-admin cannot create a service account
- **WHEN** an actor without the grant attempts to create a service account
- **THEN** the operation is denied and no `_user` entity or credential is created

#### Scenario: Disabling a service account disables its credential
- **GIVEN** service account `ci-github` is `Active` with an enabled credential
- **WHEN** an admin disables `ci-github`
- **THEN** its status becomes `Disabled` and its credential can no longer produce an access token

#### Scenario: Deleting a service account revokes its credential
- **GIVEN** service account `ci-github` with an enabled credential
- **WHEN** its `_user` entity is deleted
- **THEN** the credential is revoked, not merely disabled, and cannot be re-enabled

### Requirement: Org API-credentials viewer never re-exposes a secret
Listing an organization's API credentials (service accounts and
integrations) MUST return, per credential: a name, its kind, a non-secret
prefix, creation time, last-used time (when known), enabled/disabled state,
and whether it is past its rotation-due threshold. It MUST NOT return the
secret value under any circumstance after creation. This listing MUST be
authorized to admins only.

#### Scenario: Listing never includes the secret
- **GIVEN** an organization with 3 API credentials
- **WHEN** an admin lists them
- **THEN** each entry has a prefix, not the full secret, and no field in the response ever equals a credential's secret value

#### Scenario: Non-admin cannot list credentials
- **WHEN** an actor without the grant lists credentials
- **THEN** the operation is denied

### Requirement: Credential rotation issues a new credential and disables the old one
Rotating a credential MUST create a new credential associated with the same
logical service account or integration, return its secret exactly once, and
disable the old credential in the same operation, so only one of the two is
usable afterward. Rotation MUST be authorized to admins only and MUST be
logged with both credentials' opaque identifiers, never their secrets.

#### Scenario: Rotating replaces the usable credential
- **GIVEN** service account `ci-github` with credential `c1`, enabled
- **WHEN** an admin rotates its credential
- **THEN** a new credential `c2` is returned once with its secret, and `c1` is disabled and can no longer produce an access token

#### Scenario: Revoking a credential is permanent
- **GIVEN** an enabled credential `c1`
- **WHEN** an admin revokes it
- **THEN** `c1` can never be re-enabled, and only a new rotation or a new credential creation can restore access

### Requirement: Org deletion revokes access immediately and deletes tenant data
Deleting an organization MUST be authorized to admins only, MUST require a
fresh step-up verification (this operation carries `x-tayzu-risk: high`), and
MUST require the caller to confirm the organization's identifier explicitly
before it proceeds. Once confirmed, the organization's members MUST lose
access immediately, and the operation MUST delete, within the same
operation: every catalog entity, blueprint, relation and change event scoped
to that tenant; the organization's Better Auth `member`, `invitation` and
`apikey` rows; and the organization row itself. The operation MUST be
idempotent against being invoked twice for the same (already-deleted)
organization, returning `CATALOG_NOT_FOUND` on the second call rather than
deleting anything.

#### Scenario: Deletion without step-up fails
- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** that admin requests org deletion
- **THEN** the operation fails with a step-up-required error and nothing is deleted

#### Scenario: Confirmed deletion removes tenant data and access
- **GIVEN** organization `t1` with blueprints, entities, members and API credentials
- **WHEN** an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
- **THEN** every member's session for `t1` stops granting access
- **AND** `t1`'s catalog entities, blueprints and API credentials are gone
- **AND** a `catalog.audit.org_deletion_completed` event was logged before the organization row itself was removed

#### Scenario: Deleting an already-deleted organization is safe
- **GIVEN** organization `t1` was already deleted
- **WHEN** its deletion is requested again
- **THEN** it fails with `CATALOG_NOT_FOUND` and nothing else is attempted

### Requirement: Telemetry contract
Every operation added by this capability MUST emit the spans, metrics, and
log events declared in this change's Observability contract, using the
declared names and attributes. Telemetry MUST NOT contain invited email
addresses, invitation tokens, credential names, credential secrets, or any
other tenant-supplied free text. Opaque identifiers and enumerated values
(status, invitation state, account kind, credential kind) are permitted.

#### Scenario: Declared telemetry is emitted
- **WHEN** each operation in this capability is executed once, successfully and with a denied/failed case, under an in-memory telemetry exporter
- **THEN** every span, metric and log event declared in the contract is observed with its required attributes

#### Scenario: Invited email never reaches telemetry
- **WHEN** `marker-user@example.com` is invited, and later fails to accept an expired invitation
- **THEN** that email string appears in no exported span, metric, or log attribute
