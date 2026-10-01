# Spec Delta

## Purpose

Identity lifecycle and org administration completes Tayzu's identity model on
top of `002-auth-and-rbac`'s baseline: the full 4-state user lifecycle with
invitations, service accounts, org API-credential visibility and rotation,
and org-level data deletion, all attributed and audited the same way as every
other catalog mutation.

## Conventions

- **New Cerbos resource kinds**: `service_account`, `credential`,
  `organization`. `user.invite` (which also covers cancelling and resending an
  invitation) and `user.updateStatus` are new actions on
  `002-auth-and-rbac`'s existing `user` resource kind, not a new kind.
- **Reused error codes**: this capability introduces no new error codes. A
  Cerbos deny on any operation added here surfaces as `002`'s `AUTH_FORBIDDEN`
  (403). The step-up gate on every high-risk operation surfaces as `002`'s
  existing `AUTH_STEP_UP_REQUIRED` (403). Invitation caps surface as `002`'s
  existing `AUTH_RATE_LIMITED` (429). A target that does not exist, or that
  belongs to another tenant, surfaces as `CATALOG_NOT_FOUND`.
- **`_user.status` values**: `Staged`, `Invited`, `Active`, `Disabled` — the
  same capitalization `002-auth-and-rbac` already establishes for
  `Active`/`Disabled`.
- **Invitation states**: `pending`, `accepted`, `rejected`, `cancelled`,
  `expired`. The boundary maps Better Auth's stored `canceled` to `cancelled`,
  and derives `expired` from the expiry time (it is never stored).
- **Host-supplied context**: `tenantId` and `actor` come only from the trusted
  host. No operation in this capability reads either from input, path, query
  or body. The one exception to "a tenant context exists" is the public
  invitation-accept route, which derives the tenant from the invitation record.
- **Principal attribution**: a `_user` write made by an admin operation is
  written as the `system` actor with `actor.onBehalfOf` set to the admin, in
  process only (`reserved.ts` is unchanged).

## ADDED Requirements

### Requirement: User status has four states with forward-only transitions
The `_user` system blueprint's `status` property MUST take one of four
values: `Staged`, `Invited`, `Active`, `Disabled`. Every writer of the status
(the invitation hooks, `identity.users.create`, the first-membership hook, the
ban hook, the first-sign-in hook and `identity.users.setStatus`) MUST go
through one state machine, never write a status directly. A `_user` entity
created without a `status` MUST be `Staged`; a user created through
`identity.users.create` MUST be `Active`. A user is `Invited` when an admin
explicitly invites them. Both `Staged` and `Invited` users transition to
`Active` on their first successful sign-in or on accepting an invitation. A
user's status MUST NOT transition from `Active` back to `Invited` or `Staged`
under any operation. Any non-`Disabled` status MUST be able to transition to
`Disabled` through an explicit admin action, and a `Disabled` user MUST be able
to transition back to `Active` only through an explicit admin action. A
`Disabled` user MUST NOT become `Active` by signing in, by accepting a pending
invitation, or by any hook.

#### Scenario: New entity without a status starts staged
- **WHEN** a `_user` entity is created with no `status` given
- **THEN** its status is `Staged`

#### Scenario: Explicit invite starts a user as invited
- **WHEN** an admin invites `alice@example.com`
- **THEN** a `_user` entity for `alice@example.com` exists with status `Invited`

#### Scenario: A user created by an admin is active
- **WHEN** an admin creates a user through `identity.users.create`
- **THEN** the user's status is `Active`, written through the state machine

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
- **THEN** the status becomes `Disabled` and then `Active`, and in each case the change event is written as `system` with `onBehalfOf` set to the admin

#### Scenario: A disabled user is not revived by signing in
- **GIVEN** a `_user` entity with status `Disabled`
- **WHEN** that user attempts to sign in
- **THEN** sign-in is refused and the status stays `Disabled`

#### Scenario: A disabled user is not revived by a pending invitation
- **GIVEN** a pending invitation to `bob@example.com`, and `bob` is then disabled
- **WHEN** the invitation is accepted with its valid token
- **THEN** the acceptance fails in the same way as any other rejected acceptance and `bob` stays `Disabled`

### Requirement: Only an admin may invite a user or change another user's status
Inviting, cancelling or resending an invitation, and changing a user's status
(disable, re-enable) MUST be authorized by Cerbos against the acting
principal's role, never by branching on `actor.type`. A user MUST NOT be able to
change their own status. An attempt to do either without the required grant
MUST fail with `AUTH_FORBIDDEN` and MUST be logged as the security event
`catalog.security.authz_denied`, which the identity pipeline MUST emit on every
Cerbos deny (and increment the authorization-decision metric).

#### Scenario: Non-admin cannot invite
- **WHEN** an actor without the invite grant attempts to invite a user
- **THEN** the operation is denied with `AUTH_FORBIDDEN`, no invitation is created and `catalog.security.authz_denied` is logged

#### Scenario: A user cannot disable themselves
- **GIVEN** an admin user `u1`
- **WHEN** `u1` attempts to change their own status to `Disabled`
- **THEN** the operation is denied with `AUTH_FORBIDDEN`, `u1` stays `Active`, and a `catalog.security.self_status_change_denied` event is logged

### Requirement: Disabling a human takes effect immediately
Disabling a human user MUST ban the user, revoke every one of their sessions,
and cancel their pending invitations. `resolveContext` MUST reject a banned
user, so that an existing session and any new sign-in, local or through SSO,
stop granting access. Enabling the user MUST unban them. Every rejection by
this check MUST be logged as `catalog.security.principal_rejected` and counted.

#### Scenario: A disabled user's sessions stop working
- **GIVEN** an `Active` user with a live session
- **WHEN** an admin disables the user
- **THEN** the next request on that session is rejected, a new sign-in (local or SSO) is refused, and `catalog.security.principal_rejected` is logged

#### Scenario: Disabling cancels pending invitations
- **GIVEN** a pending invitation to `bob@example.com` and an existing `bob`
- **WHEN** an admin disables `bob`
- **THEN** the invitation's state becomes `cancelled` with reason `user_disabled`

### Requirement: Invitation lifecycle
An invitation MUST record the invited email, the inviting actor, the invited
role, an expiry 48 hours after creation, and one of the states `pending`,
`accepted`, `rejected`, `cancelled`, `expired`. The invited role MUST be
`member` or `admin`; `owner` and any other value MUST be rejected with
`CATALOG_VALIDATION_FAILED`, and the role MUST be logged on
`catalog.audit.invitation_created`. Creating an invitation for an email that
already has a `pending` invitation MUST cancel the previous invitation before
creating the new one. An invitation for an email whose existing user is
`Disabled` MUST be refused. Cancelling and resending MUST resolve the
invitation on the server and MUST apply only to an invitation of the caller's
tenant. Only a `pending`, non-expired invitation MUST be acceptable.

#### Scenario: Invite sends exactly one email with exactly one link
- **WHEN** an admin invites `bob@example.com`
- **THEN** exactly one email is sent to `bob@example.com`
- **AND** the email contains exactly one clickable link, the invitation-accept link, and states the 48-hour expiry

#### Scenario: Inviting with the owner role is rejected
- **WHEN** an admin invites `bob@example.com` with role `owner`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and no invitation, `_user` entity or email is created

#### Scenario: An admin invitation is logged with its role
- **WHEN** an admin, with a fresh step-up verification, invites `bob@example.com` with role `admin`
- **THEN** `catalog.audit.invitation_created` is logged with role `admin`

#### Scenario: Re-inviting cancels the previous invitation
- **GIVEN** a `pending` invitation to `bob@example.com`
- **WHEN** the admin invites `bob@example.com` again
- **THEN** the first invitation's state becomes `cancelled` and a new `pending` invitation is created with a fresh 48-hour expiry

#### Scenario: Admin can cancel a pending invitation
- **GIVEN** a pending invitation to `bob@example.com`
- **WHEN** the admin cancels it
- **THEN** its state becomes `cancelled` and it can no longer be accepted

#### Scenario: Resending issues a new link and keeps the expiry
- **GIVEN** a pending invitation to `bob@example.com` created 10 hours ago
- **WHEN** the admin resends it
- **THEN** another email is sent to `bob@example.com` whose link works and whose earlier link no longer works
- **AND** the invitation's expiry is still 48 hours from its original creation, not from the resend

#### Scenario: A disabled user cannot be invited
- **GIVEN** a `Disabled` user `bob@example.com`
- **WHEN** an admin invites `bob@example.com`
- **THEN** the operation fails and no email is sent

### Requirement: Invitation acceptance
Accepting an invitation MUST be a public, rate-limited operation outside the
tenant-context pipeline (`POST /v1/auth/invitations/accept`), reachable only
with the invitation identifier and a single-use token carried in the request
body, with nothing identifying in the path or query. The token MUST be 256 bits
from a CSPRNG, MUST be stored only as a sha256 digest, MUST be compared in
constant time, and MUST work exactly once; a resend MUST invalidate the previous
token. The tenant MUST be derived on the server from the invitation record; a
body that carries a tenant or an actor MUST be rejected. For an invited email
with no account, acceptance MUST create the user with the least global role,
set the password the invitee supplied under the password policy, mark the email
verified (the token is proof of mailbox control), add the membership with the
invited role, write the status through the state machine, and MUST NOT create a
session. Acceptance MUST NOT set or change the password of an account that
already exists, and MUST NOT link an account by the email claim from Visma
Connect. Every rejected acceptance (nonexistent invitation, expired, cancelled,
rejected or already-accepted invitation, wrong token, or a `Disabled` user) MUST
return the same status, error code and body shape, and a nonexistent invitation
MUST take the same comparison work as a wrong token; the specific reason MUST
be recorded only in the `catalog.security.invitation_acceptance_denied` event.
A password that fails the policy MUST be reported only after the token has
verified.

#### Scenario: A new person accepts and can then sign in
- **GIVEN** a pending invitation to `bob@example.com`, who has no account
- **WHEN** `bob` presents the invitation id, the token and a policy-compliant password
- **THEN** `bob` has an account with a verified email, a membership with the invited role and status `Active`, and no session exists
- **AND** the token cannot be used a second time

#### Scenario: The tenant comes from the invitation
- **WHEN** the accept body carries a `tenantId` or an `actor` field
- **THEN** the request is rejected and nothing is created

#### Scenario: Acceptance does not touch an existing account
- **GIVEN** a pending invitation to an email that already has an account
- **WHEN** the invitation is accepted with its valid token and a password
- **THEN** the existing account's password is unchanged and no password is set

#### Scenario: Acceptance does not link an SSO account by email
- **WHEN** an invitation is accepted
- **THEN** no Visma Connect account is linked, and linking stays `sub`-keyed through the self-service link route with step-up

#### Scenario: Accepting an expired invitation fails
- **GIVEN** an invitation to `bob@example.com` past its 48-hour expiry
- **WHEN** it is accepted with its token
- **THEN** the acceptance fails, the invitation reads as `expired`, and `bob`'s user status is unchanged

#### Scenario: Accepting a cancelled or already-accepted invitation fails
- **GIVEN** an invitation cancelled by re-invite or by explicit cancel, and another already accepted
- **WHEN** each is accepted with its token
- **THEN** both fail and no status change occurs

#### Scenario: A wrong token fails
- **GIVEN** a pending invitation to `bob@example.com`
- **WHEN** it is accepted with a token that is not the issued one
- **THEN** the acceptance fails and the invitation stays `pending`

#### Scenario: Acceptance errors do not reveal which failure occurred
- **GIVEN** a nonexistent invitation, an expired invitation, a pending invitation with a wrong token, and a pending invitation of a `Disabled` user
- **WHEN** each acceptance attempt is made
- **THEN** all fail with the same status, error code and body shape, and the specific reason appears only in `catalog.security.invitation_acceptance_denied`

#### Scenario: The accept route is rate-limited
- **WHEN** a caller exceeds the configured acceptance rate
- **THEN** further requests fail with `AUTH_RATE_LIMITED` before any invitation lookup

### Requirement: Invitation email is fixed and capped
The invitation email MUST be sent to exactly one recipient, a single plain
address with no line breaks, display name or list separator, and MUST have no
CC, BCC or attachment. Its subject and template MUST be fixed: only the link
and the expiry text are interpolated, and no organization name, inviter name or
other tenant or inviter free text appears. The link origin MUST come from
trusted configuration (`BETTER_AUTH_URL`), never from the request `Host` or a
forwarded header, and the link MUST carry the invitation id and token in the
URL fragment. Creating and resending invitations MUST be capped at 30 per hour
per tenant, 3 per 24 hours per recipient across all tenants (keyed by a digest
of the normalized email, never the address), and by a global kill switch. A
disabled or zero cap MUST fail startup. Exceeding any cap MUST fail the
operation with `AUTH_RATE_LIMITED`, send no email, and log
`catalog.security.invitation_rate_limited` with its scope. Outside test, startup
MUST fail without a real email provider.

#### Scenario: Injection through the invited address is impossible
- **WHEN** an admin invites an address containing a line break, a display name, a list separator or more than 254 characters
- **THEN** the operation fails and no email is sent

#### Scenario: The template carries no free text
- **GIVEN** an organization named `<b>Pay now</b>` and an inviter with a markup-bearing name
- **WHEN** an invitation is sent
- **THEN** neither string appears in the subject or body, and the subject is the fixed one

#### Scenario: The link origin ignores the request headers
- **WHEN** an invitation is created from a request with a forged `Host` and `X-Forwarded-Host`
- **THEN** the emailed link starts with the configured `BETTER_AUTH_URL`

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

### Requirement: Service accounts are non-human users created API-only
A service account MUST be a `_user` entity with `accountKind: "service"`
(as opposed to `"standard"` for a human user), identified by
`^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`. Creating a service account MUST be
authorized to admins only, MUST require a fresh step-up verification, MUST set
its status to `Active` immediately with no invitation email sent, and MUST
atomically issue one organization-owned machine credential
(`clientId`/`clientSecret`) for it. The credential's secret MUST be returned
exactly once, in the creation response, and MUST NOT be retrievable again.
Disabling a service account MUST be enforced on the request path: a token
already issued for it MUST be rejected within seconds and no new token MUST be
issued, and re-enabling restores access without a new credential. Deleting a
service account MUST be an explicit operation that revokes (not merely
disables) its credential and then removes its `_user` entity.

A service account's principal MUST always be `member` with no teams and no
moderated blueprints, built from the signed machine claim and never read from
its `_user` entity; `userId` MUST be an attribution claim only. A service
account MUST NOT hold the `admin` role and MUST NOT hold a Moderator grant:
creation MUST reject any requested role other than `member` or any non-empty
`moderatedBlueprints` before anything is created, and an independent Cerbos
deny rule MUST refuse any action on a `user` resource whose `accountKind` is
`service` and whose resulting `portRole` is not `member` or whose resulting
`moderatedBlueprints` is non-empty. No operation in this capability edits a
user's role or `moderatedBlueprints`.

#### Scenario: Creating a service account with an elevated role is rejected
- **WHEN** an admin attempts to create a service account with role `admin`, or with a non-empty `moderatedBlueprints`
- **THEN** the operation fails and no `_user` entity or credential is created

#### Scenario: The Cerbos ceiling denies an elevated service-account resource
- **GIVEN** a `user` resource with `accountKind: "service"` and `portRole: "admin"`, or a non-empty `moderatedBlueprints`
- **WHEN** any action is checked against it
- **THEN** Cerbos denies it, while an equivalent standard account is unaffected, and the decision is the same when the check is made as the `system` actor

#### Scenario: A tampered `_user` row does not raise the principal
- **GIVEN** a service account whose `_user` entity has been given the `admin` role by a direct write
- **WHEN** it exchanges its credential and calls an operation
- **THEN** its principal is `member` with no teams and no moderated blueprints

#### Scenario: Service account is active immediately, no email
- **WHEN** an admin with a fresh step-up verification creates service account `svc-ci-github` for tenant `t1`
- **THEN** the returned `_user` entity has status `Active` and `accountKind: "service"`
- **AND** no invitation email is sent
- **AND** the response includes a `clientId` and a `clientSecret` that never appear in any later read of the account

#### Scenario: A non-admin cannot create a service account
- **WHEN** an actor without the grant attempts to create a service account
- **THEN** the operation is denied and no `_user` entity or credential is created

#### Scenario: Disabling a service account takes effect within seconds
- **GIVEN** service account `svc-ci-github` is `Active`, with an access token already issued
- **WHEN** an admin disables it
- **THEN** its status becomes `Disabled`, the issued token is rejected within the cache window, and a new exchange is refused

#### Scenario: Re-enabling restores access without a new credential
- **GIVEN** a `Disabled` service account
- **WHEN** an admin re-enables it
- **THEN** its status becomes `Active` and the same credential exchanges a token again

#### Scenario: Deleting a service account revokes its credential
- **GIVEN** service account `svc-ci-github` with an enabled credential
- **WHEN** an admin deletes it
- **THEN** the credential is revoked and cannot be restored, and the `_user` entity is gone

### Requirement: Org API-credentials viewer never re-exposes a secret
Listing an organization's API credentials (service accounts and
integrations) MUST return, per credential: a name, its kind, a non-secret
prefix, creation time, last-used time (when known), enabled/disabled state,
and whether it is past its rotation-due threshold. A credential MUST be shown
disabled when its key is disabled, it is revoked, or its bound service account
is `Disabled`. It MUST NOT return the secret value or any stored secret
characters under any circumstance after creation. This listing MUST be
authorized to admins only and MUST contain only credentials of the caller's
tenant.

#### Scenario: Listing never includes the secret
- **GIVEN** an organization with 3 API credentials
- **WHEN** an admin lists them
- **THEN** each entry has a prefix, not the full secret, and no field in the response ever equals a credential's secret value

#### Scenario: Non-admin cannot list credentials
- **WHEN** an actor without the grant lists credentials
- **THEN** the operation is denied

### Requirement: Credential creation, rotation and revocation take effect within seconds
Creating an integration or agent credential MUST be authorized to admins only,
MUST require a fresh step-up verification, MUST set a per-key rate limit
explicitly, and MUST NOT store any leading characters of the secret. Rotating a
credential MUST create a new credential for the same service account or
integration, return its secret exactly once, and revoke the old credential
through the revocation list in the same operation, so only one of the two is
usable afterward and the old one's issued tokens are rejected within seconds. If
retiring the old credential fails, the new one MUST be revoked, and if that also
fails `catalog.security.credential_rotation_incomplete` MUST be logged.
Revoking a credential MUST be permanent. Rotation and revocation MUST be
authorized to admins only, MUST require step-up, and MUST be logged with
opaque identifiers only, never secrets.

#### Scenario: Creating a credential requires step-up and bounds its use
- **WHEN** an admin without a fresh step-up verification creates a credential
- **THEN** the operation fails with `AUTH_STEP_UP_REQUIRED`; with a fresh verification the created key has the configured rate limit and stores no secret characters

#### Scenario: Rotating replaces the usable credential
- **GIVEN** service account `svc-ci-github` with credential `c1`, enabled, and an access token issued from it
- **WHEN** an admin rotates its credential
- **THEN** a new credential `c2` is returned once with its secret, `c1` is revoked, and `c1`'s issued token and any new exchange with `c1` are rejected within seconds

#### Scenario: A failed rotation leaves no second usable credential
- **GIVEN** retiring the old credential fails
- **WHEN** an admin rotates
- **THEN** the new credential is revoked, the operation fails, and no second usable credential exists

#### Scenario: A rotation that cannot compensate is signalled
- **GIVEN** retiring the old credential and revoking the new one both fail
- **WHEN** an admin rotates
- **THEN** `catalog.security.credential_rotation_incomplete` is logged with both opaque identifiers

#### Scenario: Revoking a credential is permanent
- **GIVEN** an enabled credential `c1`
- **WHEN** an admin revokes it
- **THEN** `c1` can never be restored, and only a new rotation or a new credential creation can restore access

### Requirement: Targets belong to the caller's tenant
Every invitation, credential, user, service account and organization targeted
by an operation in this capability MUST be resolved on the server and MUST
belong to the host's `tenantId`; otherwise the operation MUST fail with
`CATALOG_NOT_FOUND`, identical to a nonexistent id. Cerbos MUST receive the
target's real tenant, not the caller's echoed back. `identity.organization.delete`
MUST compare its confirmation to the host tenant, and every Better Auth call MUST
be given the host tenant only.

#### Scenario: Another tenant's invitation cannot be cancelled, resent or accepted
- **GIVEN** a pending invitation of tenant `t2`
- **WHEN** an admin of tenant `t1` cancels or resends it by its id
- **THEN** the operation fails with `CATALOG_NOT_FOUND`, the same as for an unknown id, and the invitation is unchanged

#### Scenario: Another tenant's credential cannot be listed, rotated or revoked
- **GIVEN** a credential of tenant `t2`
- **WHEN** an admin of `t1` lists, rotates or revokes it
- **THEN** the list omits it and rotate and revoke fail with `CATALOG_NOT_FOUND`

#### Scenario: Another tenant's user cannot have its status changed
- **GIVEN** a user whose membership is only in tenant `t2`
- **WHEN** an admin of `t1` calls `setStatus` for it, or deletes a service account of `t2`
- **THEN** the operation fails with `CATALOG_NOT_FOUND` and nothing changes

#### Scenario: A user with memberships in two tenants is refused
- **GIVEN** a user who belongs to `t1` and `t2`
- **WHEN** an admin of `t1` links an SSO `sub` to it, or changes its status
- **THEN** the operation is refused and nothing changes

#### Scenario: Org deletion targets only the host tenant
- **WHEN** an admin of `t1` requests org deletion with `t2`'s identifier as the confirmation
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and nothing of `t1` or `t2` changes

#### Scenario: Create and link give no existence oracle
- **WHEN** an admin creates a user for an email that exists and for one that does not, or links an `sub` that exists and one that does not
- **THEN** both answer identically

### Requirement: Org deletion revokes access immediately and purges tenant data after a window
Deleting an organization MUST be authorized to admins only, MUST require a
fresh step-up verification, and MUST require the caller to confirm the
organization's identifier, which MUST equal the host tenant. The operation
MUST be in two phases. In phase 1 it MUST record a deletion marker with a
purge date between 7 and 14 days away, revoke every session whose active
organization is the tenant, revoke every org-owned credential, cancel pending
invitations, and log `catalog.audit.org_deletion_requested`; from then on
`resolveContext` and token exchange MUST reject every principal of the tenant,
human or machine. Requesting deletion again while pending MUST change nothing
and MUST return the original date. In phase 2 a scheduled job MUST, for a
tenant whose purge date has passed, delete in two idempotent steps with safe
resume: first the tenant's catalog data (including the append-only change
events and revocation rows, through a function that deletes only for a tenant
whose marker is due), then the tenant's Better Auth data (invitations, API
keys, invitation tokens, members, each user left with no other membership
together with that user's accounts, sessions and second-factor rows, and the
organization row last). `catalog.audit.org_deletion_completed` MUST be logged
before the organization row is removed, and a failed step MUST log
`catalog.security.org_deletion_failed` and be retried by the next run.

#### Scenario: Deletion without step-up fails
- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** that admin requests org deletion
- **THEN** the operation fails with a step-up-required error and nothing changes

#### Scenario: Requesting deletion revokes access at once
- **GIVEN** organization `t1` with blueprints, entities, members and API credentials
- **WHEN** an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
- **THEN** every member's session and every `t1` credential, human or machine, is rejected within seconds, a marker with a purge date 7 to 14 days away exists, and the data is still there

#### Scenario: Requesting deletion twice returns the original date
- **GIVEN** `t1` has a pending deletion
- **WHEN** the deletion is requested again, in process
- **THEN** nothing changes and the original purge date is returned

#### Scenario: Purge removes tenant data after the window
- **GIVEN** `t1`'s purge date has passed
- **WHEN** the purge job runs
- **THEN** `t1`'s catalog entities, blueprints, relations, change events, credential revocation rows, invitations, API keys, members and organization row are gone
- **AND** a `catalog.audit.org_deletion_completed` event was logged before the organization row was removed

#### Scenario: A purge does not touch a tenant whose window has not passed
- **GIVEN** `t1`'s purge date is in the future and `t2` has no marker
- **WHEN** the purge job runs
- **THEN** nothing of `t1` or `t2` is deleted, and the purge function refuses to delete the append-only rows of either

#### Scenario: Users with no other membership are removed, others are kept
- **GIVEN** a user who belongs only to `t1` and another who belongs to `t1` and `t2`
- **WHEN** `t1` is purged
- **THEN** the first user and their account, session and second-factor rows are gone, and the second user keeps their account and their membership in `t2`

#### Scenario: A failed purge step is visible and resumes
- **GIVEN** the Better Auth step fails after the catalog step succeeded
- **WHEN** the purge job runs again
- **THEN** `catalog.security.org_deletion_failed` was logged for the failure, the catalog step is not repeated, and the run completes the Better Auth step

#### Scenario: A repeated purge is safe
- **GIVEN** `t1` was already purged
- **WHEN** the purge job runs again
- **THEN** it deletes nothing and does not fail

### Requirement: Every high-risk operation requires step-up
These operations MUST carry `x-tayzu-risk: high` on their route, so that the
step-up gate in the OpenAPI interceptor applies: `identity.users.setStatus`,
`identity.users.invite`, `identity.users.create`,
`identity.serviceAccounts.create`, `identity.serviceAccounts.delete`,
`identity.credentials.create`, `identity.credentials.rotate`,
`identity.credentials.revoke`, `identity.organization.delete`, and the
existing SSO link and unlink operations. An admin session without a fresh
verification MUST receive `AUTH_STEP_UP_REQUIRED` and nothing MUST change. The
step-up gate runs only over HTTP, so it MUST be tested over HTTP.

#### Scenario: A hijacked admin session without a fresh MFA cannot mint power
- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** it invites an `admin`, creates a user, creates a service account or creates a credential
- **THEN** each fails with `AUTH_STEP_UP_REQUIRED` over HTTP and nothing is created

#### Scenario: Every route in the high-risk set is marked
- **WHEN** the generated OpenAPI document is read
- **THEN** every route in the set above carries `x-tayzu-risk: high`

### Requirement: Identity routes are unreachable until mounted
No route of this capability, nor the machine-credential create and revoke
routes, MUST be reachable over HTTP while the mount switch
(`MOUNT_IDENTITY_ROUTES`) is off, and the switch MUST be off by default. With
it off, every such route MUST answer 404 as if it did not exist. The task that
registers the routes MUST come after every hand-off task from `002`.

#### Scenario: Routes answer 404 while the switch is off
- **GIVEN** the switch is off, which is the default
- **WHEN** any identity route (including the public accept route) or a machine-credential create or revoke route is called
- **THEN** it answers 404

#### Scenario: No route is registered outside the switch
- **WHEN** the route table is enumerated
- **THEN** every identity and credential route is registered only behind the switch

### Requirement: Security-relevant events are logged
Every Cerbos deny, status change, service-account disable, enable and
deletion, invitation resend, user creation (including the bootstrap user),
credential creation, rotation and revocation, rejected principal, rate-limit
excess, and org-deletion request, completion and failure MUST be logged as the
corresponding `catalog.audit.*` or `catalog.security.*` event declared in the
Observability contract, with opaque identifiers and enumerated values only. A
failed org deletion MUST NOT be invisible.

#### Scenario: Each lifecycle action emits its declared event
- **WHEN** each of the actions above is executed once
- **THEN** its declared event is observed with its required attributes and no email, token, name or secret

#### Scenario: A failed deletion is logged
- **WHEN** a purge step fails
- **THEN** `catalog.security.org_deletion_failed` is logged with the step

### Requirement: Telemetry contract
Every operation added by this capability MUST emit the spans, metrics, and
log events declared in this change's Observability contract, using the
declared names and attributes. Telemetry MUST NOT contain invited email
addresses, invitation tokens, credential names, credential secrets, `_user`
identifiers, or any other tenant-supplied free text, and no identifier in a URL
path (an email, an invitation id or a credential id) MUST reach any exported
span, metric or log: for the routes of this capability the exported path MUST
be the route template. Opaque identifiers and enumerated values (status,
invitation state, account kind, credential kind) are permitted.

#### Scenario: Declared telemetry is emitted
- **WHEN** each operation in this capability is executed once, successfully and with a denied/failed case, under an in-memory telemetry exporter
- **THEN** every span, metric and log event declared in the contract is observed with its required attributes

#### Scenario: Invited email never reaches telemetry
- **WHEN** `marker-user@example.com` is invited, and later fails to accept an expired invitation
- **THEN** that email string appears in no exported span, metric, or log attribute

#### Scenario: A path identifier never reaches telemetry over HTTP
- **WHEN** `PUT /v1/users/marker-user@example.com/status` and a credential route with a marker id are called through the real HTTP server and instrumentation
- **THEN** neither marker appears in any exported span, metric or log attribute, and the exported path is the route template

#### Scenario: The email provider's failure never leaks
- **WHEN** the email provider fails with an error that contains the recipient address
- **THEN** that address appears in no exported signal and no error response

### Requirement: Password policy
Every password the system sets or changes (invitation acceptance, temporary
and bootstrap passwords, `/change-password`) MUST be NFC-normalized and then
be 20 to 128 characters long, contain an upper-case letter, a lower-case
letter, a digit and a symbol, contain no control character, unpaired
surrogate or Unicode format character, and not appear on the bundled
common-password denylist. A refusal MUST name only the failed rule and never
echo the password.

#### Scenario: A short password is refused
- **WHEN** an invitee accepts with a 19-character password that meets every other rule
- **THEN** the acceptance fails naming the length rule
- **AND** no user is created

#### Scenario: A password with a harmful character is refused
- **WHEN** a password contains a NUL, a control character, a bidirectional override or a zero-width character
- **THEN** it is refused naming the character rule, without echoing the password

