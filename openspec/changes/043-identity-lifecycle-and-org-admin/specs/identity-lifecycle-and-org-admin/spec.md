# Spec Delta

## Purpose

Identity lifecycle and org administration completes Tayzu's identity model on
top of `002-auth-and-rbac`'s baseline: the full 4-state user lifecycle with
invitations, service accounts, org API-credential visibility and rotation,
and org-level data deletion, all attributed and audited the same way as every
other catalog mutation.

## ADDED Requirements

### Requirement: User status has four states with forward-only transitions
The `_user` system blueprint's `status` property MUST take one of four
values: `staged`, `invited`, `active`, `disabled`. A user is `staged` when
created without an explicit invite (default for a `_user` entity created with
no `status` or `status: staged`). A user is `invited` when an admin
explicitly invites them, whether via the invite operation or a `_user` entity
created with `status: invited`. Both `staged` and `invited` users transition
to `active` on their first successful sign-in. A user's status MUST NOT
transition from `active` back to `invited` or `staged` under any operation.
Any status MUST be able to transition to `disabled` through an explicit
admin action, and a `disabled` user MUST be able to transition back to
`active` through an explicit admin action (never automatically).

#### Scenario: New user without an invite starts staged
- **WHEN** a `_user` entity is created with no `status` given
- **THEN** its status is `staged`

#### Scenario: Explicit invite starts a user as invited
- **WHEN** an admin invites `alice@example.com`
- **THEN** a `_user` entity for `alice@example.com` exists with status `invited`

#### Scenario: First sign-in activates a staged or invited user
- **GIVEN** a `_user` entity with status `staged`
- **WHEN** that user signs in successfully for the first time
- **THEN** its status becomes `active`

#### Scenario: Active never regresses to invited or staged
- **GIVEN** a `_user` entity with status `active`
- **WHEN** any operation is attempted that would set its status to `invited` or `staged`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED`

#### Scenario: Disable and re-enable
- **GIVEN** a `_user` entity with status `active`
- **WHEN** an admin disables the user, and later re-enables them
- **THEN** the status becomes `disabled` and then `active`, in each case attributed to the admin

### Requirement: Only an admin may invite a user or change another user's status
Inviting a user and changing a user's status (disable, re-enable) MUST be
authorized by Cerbos against the acting principal's role, never by branching
on `actor.type`. A user MUST NOT be able to change their own status. An
attempt to do either without the required grant MUST fail with
`CATALOG_CONTEXT_REQUIRED`'s access-control counterpart (a Cerbos deny,
surfaced as the operation's standard authorization-denied error) and MUST be
logged as a security event.

#### Scenario: Non-admin cannot invite
- **WHEN** an actor without the invite grant attempts to invite a user
- **THEN** the operation is denied and no invitation is created

#### Scenario: A user cannot disable themselves
- **GIVEN** an admin user `u1`
- **WHEN** `u1` attempts to change their own status to `disabled`
- **THEN** the operation is denied, `u1` stays `active`, and a `catalog.security.self_status_change_denied` event is logged

### Requirement: Invitation lifecycle
An invitation MUST record the invited email, the inviting actor, an
expiry 48 hours after creation, and one of the states `pending`, `accepted`,
`rejected`, `cancelled`, `expired`. Creating an invitation for an email that
already has a `pending` invitation MUST cancel the previous invitation before
creating the new one. Accepting an invitation MUST require the accepting
session's email to match the invited email exactly. Only a `pending`,
non-expired invitation MUST be acceptable; accepting a `rejected`,
`cancelled`, `expired`, or already-`accepted` invitation MUST fail and MUST
NOT change the invited user's status.

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

#### Scenario: Admin can cancel a pending invitation
- **GIVEN** a pending invitation to `bob@example.com`
- **WHEN** the admin cancels it
- **THEN** its state becomes `cancelled` and it can no longer be accepted

#### Scenario: Resending a pending invitation does not change its expiry
- **GIVEN** a pending invitation to `bob@example.com` created 10 hours ago
- **WHEN** the admin resends it
- **THEN** another email is sent to `bob@example.com` with the same invitation link
- **AND** the invitation's expiry is still 48 hours from its original creation, not from the resend

### Requirement: Service accounts are non-human users created API-only
A service account MUST be a `_user` entity with `accountKind: "service"`
(as opposed to `"standard"` for a human user). Creating a service account
MUST be authorized to admins only, MUST set its status to `active`
immediately with no invitation email sent, and MUST atomically issue one
organization-owned machine credential (`clientId`/`clientSecret`) for it. The
credential's secret MUST be returned exactly once, in the creation response,
and MUST NOT be retrievable again afterward. Disabling a service account
MUST also disable its credential, so that no new access token can be issued
from it. Re-enabling reverses both. Deleting a service account's `_user`
entity MUST also revoke (not merely disable) its credential.

#### Scenario: Service account is active immediately, no email
- **WHEN** an admin creates service account `ci-github` for tenant `t1`
- **THEN** the returned `_user` entity has status `active` and `accountKind: "service"`
- **AND** no invitation email is sent
- **AND** the response includes a `clientId` and a `clientSecret` that never appear in any later read of the account

#### Scenario: A non-admin cannot create a service account
- **WHEN** an actor without the grant attempts to create a service account
- **THEN** the operation is denied and no `_user` entity or credential is created

#### Scenario: Disabling a service account disables its credential
- **GIVEN** service account `ci-github` is `active` with an enabled credential
- **WHEN** an admin disables `ci-github`
- **THEN** its status becomes `disabled` and its credential can no longer produce an access token

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
