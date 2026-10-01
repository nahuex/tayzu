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
  existing `AUTH_RATE_LIMITED` (429) with a `Retry-After` header. A target that does not exist, or that
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
- **Routes**: fifteen routes, fourteen oRPC procedures and the plain Fastify
  invitation-accept route, all registered only behind the mount switch. The
  accept route is not in the OpenAPI document of the identity router
  (`openapi/identity.openapi.json`, committed and checked for drift).
- **Canonical email**: the invited or created email is NFC-normalized, trimmed and
  lower-cased, and is the same string in the `_user` identifier, the Better Auth
  user, the invitation and (hashed) the per-recipient cap key.
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

### Requirement: Every identity route declares its authorization

Every procedure of the identity router MUST be built through the one wrapper that
resolves the target on the server, builds the Cerbos attributes, calls Cerbos with
the target's real tenant and emits `catalog.security.authz_denied` on a deny, and
only then runs the handler. A procedure built without the wrapper MUST fail a test.
Over HTTP each of the fourteen oRPC routes MUST allow an admin, refuse a `member`
and a machine `member` token with `AUTH_FORBIDDEN`, refuse an unauthenticated
caller with 401 and answer a foreign target exactly as an unknown one.

#### Scenario: A route built without the wrapper is rejected

- **WHEN** a procedure is added to the identity router without the authorization wrapper
- **THEN** the structure test fails

#### Scenario: Each identity route enforces its authorization over HTTP

- **GIVEN** the mounted server and the fourteen oRPC routes
- **WHEN** each route is called by an admin (with a fresh step-up where required), a member, a machine `member` token, an unauthenticated caller, and, where it has a target, with a foreign target
- **THEN** the admin is allowed, the member and the machine token get `AUTH_FORBIDDEN` (403), the unauthenticated caller gets 401, and the foreign target gets the same 404 as an unknown one

### Requirement: Disabling a human takes effect immediately

Disabling a human user MUST be scoped to the acting admin's tenant: it MUST write
the `_user` status of that tenant through the state machine, revoke every one of
the user's sessions whose active organization is that tenant, and cancel the
user's pending invitations of that tenant. Only for a user whose single membership
is that tenant MUST it also ban the user and revoke all their sessions. The ban
MUST NOT use Better Auth's admin-plugin ban routes, which the global role `user`
cannot call. `resolveContext` MUST reject a banned user, and MUST reject a human
whose `_user` status in the active tenant is `Disabled`, so that an existing
session and any new sign-in, local or through SSO, stop granting access. Enabling
the user MUST reverse only what disabling did in that tenant. Every rejection by
these checks MUST be logged as `catalog.security.principal_rejected` and counted.

#### Scenario: A disabled user's sessions stop working

- **GIVEN** an `Active` user with a single membership and a live session
- **WHEN** an admin disables the user
- **THEN** the next request on that session is rejected, a new sign-in (local or SSO) is refused, and `catalog.security.principal_rejected` is logged

#### Scenario: A member of two tenants is disabled in one only

- **GIVEN** an `Active` user who belongs to `t1` and `t2`, with a session in each
- **WHEN** the admin of `t1` disables the user
- **THEN** the user's `t1` session is rejected and their `_user` status in `t1` is `Disabled`
- **AND** their `t2` session, `_user` status and global account are unchanged, and re-enabling in `t1` restores only `t1`

#### Scenario: Disabling cancels pending invitations

- **GIVEN** a pending invitation to `bob@example.com` from this tenant and an existing `bob`
- **WHEN** an admin disables `bob`
- **THEN** the invitation's state becomes `cancelled` with reason `user_disabled`

### Requirement: Invitation lifecycle

An invitation MUST record the invited email, the inviting actor, the invited
role, an expiry 48 hours after creation, and one of the states `pending`,
`accepted`, `rejected`, `cancelled`, `expired`. The invited role MUST be
exactly the string `member` or `admin`; `owner`, a comma-separated string, an array,
a different case and any other value MUST be rejected with
`CATALOG_VALIDATION_FAILED`, and the role MUST be logged on
`catalog.audit.invitation_created`. Creating an invitation for an email that
already has a `pending` invitation MUST cancel the previous invitation before
creating the new one. An invitation for an email whose existing user is
`Disabled` MUST be refused. An email the entity identifier cannot hold, or that
contains `/`, MUST be rejected with `CATALOG_VALIDATION_FAILED` by `invite` and by
`identity.users.create`, before anything is created. Better Auth's own errors (an
existing member, the per-organization pending limit) MUST NOT reach the response
as they are. Cancelling and resending MUST resolve the
invitation on the server and MUST apply only to an invitation of the caller's
tenant. Only a `pending`, non-expired invitation MUST be acceptable.

#### Scenario: Invite sends exactly one email with exactly one link

- **WHEN** an admin invites `bob@example.com`
- **THEN** exactly one email is sent to `bob@example.com`
- **AND** the email contains exactly one clickable link, the invitation-accept link, and states the 48-hour expiry

#### Scenario: Inviting with the owner role is rejected

- **WHEN** an admin invites `bob@example.com` with role `owner`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and no invitation, `_user` entity or email is created

#### Scenario: A role that is not exactly member or admin is rejected

- **WHEN** an admin invites with the role `member,owner`, `['owner']`, `Admin` or `owner`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and nothing is created

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
- **AND** the invitation's expiry is still 48 hours from its original creation, not from the resend (a resend does not reset it)

#### Scenario: An address the platform cannot hold is rejected

- **WHEN** an admin invites, or creates a user for, `a+b@example.com` or `a/b@example.com`
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and no invitation, user, email or cap increment results

#### Scenario: A disabled user cannot be invited

- **GIVEN** a `Disabled` user `bob@example.com`
- **WHEN** an admin invites `bob@example.com`
- **THEN** the operation fails and no email is sent

### Requirement: Invitation acceptance

Accepting an invitation MUST be a public, rate-limited operation outside the
tenant-context pipeline, served by a plain route (`POST /v1/auth/invitations/accept`)
registered before the authenticated catch-all, reachable only with the invitation
identifier and a single-use token carried in the request body, with nothing
identifying in the path or query. The token MUST be 256 bits from a CSPRNG, MUST be
stored only as a sha256 digest, MUST be compared in constant time, MUST be verified
before it is consumed and then consumed by one atomic delete conditioned on its
digest, and MUST work exactly once; a resend MUST invalidate the previous token. The
tenant MUST be derived on the server from the invitation record; a body that
carries a tenant or an actor MUST be rejected, and an invitation of a tenant with a
pending deletion MUST NOT be acceptable. For an invited email with no account,
acceptance MUST create the user with the least global role, set the password the
invitee supplied under the password policy, mark the email verified (the token is
proof of mailbox control), add the membership with the invited role, write the
status through the state machine, and MUST NOT create a session. For an email that
already has an account, acceptance MUST require a valid session of that same
account, which MUST pass the idle-timeout and banned checks that the authenticated
pipeline applies, and whose email MUST equal the invitation email (there is no
verified-email condition, because no account's email is verified by anything else),
together with the token; the request MUST carry the CSRF custom header and an
`Origin` header that is present and in the allowed origins; when the invited role is
`admin` it MUST also require a fresh step-up verification (and, for a session of
the identity provider, its re-authorization), checked only after the session, the
email and the token have matched. It MUST add only the membership, activate the
`_user` and mark the email verified, and MUST NOT set, change or compare a
password, the session, the active organization or any linked account. Acceptance
MUST NOT link an account by the email claim from Visma Connect. The body MUST be an
allowlist of the invitation id, the token and, for a new account, the password; any
other field MUST be rejected with `CATALOG_VALIDATION_FAILED`, and an invitation id
that fails a shape and length check MUST NOT be logged. Every rejected
acceptance (nonexistent invitation, expired, cancelled, rejected or already-accepted
invitation, wrong token, a `Disabled` user, a tenant pending deletion, no or
mismatched session for an existing account, a failed CSRF or origin check, or a lost
concurrent account creation)
MUST return the same status, error code and body shape, and a nonexistent invitation
MUST take the same comparison work as a wrong token; the specific reason MUST be
recorded only in the `catalog.security.invitation_acceptance_denied` event. A
password that fails the policy MUST be reported only after the token has verified,
without consuming the token. When an invitation whose role is `admin` is accepted, a
fixed notice with no link and no free text MUST be sent to every other
administrator of the organization; a send failure MUST NOT block the acceptance and
MUST be logged.

#### Scenario: A new person accepts and can then sign in

- **GIVEN** a pending invitation to `bob@example.com`, who has no account
- **WHEN** `bob` presents the invitation id, the token and a policy-compliant password
- **THEN** `bob` has an account with a verified email, a membership with the invited role and status `Active`, and no session exists
- **AND** the token cannot be used a second time

#### Scenario: Unknown body fields are rejected

- **WHEN** the accept body carries `role`, `email`, `organizationId` or `userId`, or an invitation id of the wrong shape or length
- **THEN** the request is rejected with `CATALOG_VALIDATION_FAILED`, nothing is created, and a malformed id is not logged

#### Scenario: The tenant comes from the invitation

- **WHEN** the accept body carries a `tenantId` or an `actor` field
- **THEN** the request is rejected and nothing is created

#### Scenario: Acceptance does not touch an existing account

- **GIVEN** a pending invitation to an email that already has an account
- **WHEN** the invitation is accepted with its valid token and a password, without a session
- **THEN** the existing account's password is unchanged, no password is set, and the answer is the uniform rejection

#### Scenario: An existing account accepts with its session

- **GIVEN** a pending invitation to `carol@example.com`, who has an account and a session
- **WHEN** `carol` presents the token with her session, the CSRF custom header and an allowed origin
- **THEN** she gains the membership with the invited role and her `_user` becomes `Active`
- **AND** her email is now marked verified, even if it was not before
- **AND** her password, session, active organization and linked accounts are unchanged, and the response has the same status and shape as a new person's acceptance

#### Scenario: A session of another account cannot accept

- **GIVEN** a pending invitation to `carol@example.com`
- **WHEN** it is accepted with the valid token and a session of another user
- **THEN** the answer is the uniform rejection and nothing changes

#### Scenario: A banned or idle session cannot accept

- **GIVEN** a pending invitation to `carol@example.com`
- **WHEN** it is accepted with the valid token and a session of `carol` that is banned or past its idle timeout
- **THEN** the answer is the uniform rejection and nothing changes

#### Scenario: An admin invitation to an existing account needs step-up

- **GIVEN** a pending `admin` invitation to `carol@example.com` and her matching session
- **WHEN** she presents the valid token without a fresh step-up verification
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED` and nothing changes
- **AND** a caller with a wrong token gets the uniform rejection, not `AUTH_STEP_UP_REQUIRED`
- **AND** a session of the identity provider is sent to its re-authorization instead of a local verification, and completes after it

#### Scenario: An accepted admin invitation notifies the other admins

- **GIVEN** an organization with an owner and two admins
- **WHEN** an invitation with the role `admin` is accepted, on either path
- **THEN** the owner and the two admins each receive exactly one fixed-template notice with no link and no free text, the new admin receives none, and a failing send does not stop the acceptance

#### Scenario: A cross-site request cannot accept

- **WHEN** an existing-account acceptance arrives without the CSRF custom header, with no `Origin` header, or from a disallowed origin
- **THEN** the answer is the uniform rejection and nothing changes

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

#### Scenario: A concurrent account creation yields one user

- **GIVEN** two pending invitations to the same new email from two tenants
- **WHEN** both are accepted at the same time
- **THEN** exactly one user is created, and the other attempt gets the uniform rejection without consuming its token

#### Scenario: Acceptance errors do not reveal which failure occurred

- **GIVEN** a nonexistent invitation, an expired invitation, a pending invitation with a wrong token, a pending invitation of a `Disabled` user, and a pending invitation of a tenant pending deletion
- **WHEN** each acceptance attempt is made
- **THEN** all fail with the same status, error code and body shape, and the specific reason appears only in `catalog.security.invitation_acceptance_denied`

#### Scenario: The accept route is rate-limited

- **WHEN** a caller exceeds the configured acceptance rate
- **THEN** further requests fail with `AUTH_RATE_LIMITED` and a `Retry-After` header before any invitation lookup, and the count is shared across replicas

### Requirement: Invitation email is fixed and capped

The invitation email MUST be sent to exactly one recipient, a single plain
address with no line breaks, display name or list separator, and MUST have no
CC, BCC or attachment. Its subject and template MUST be fixed: only the link
and the expiry text are interpolated, and no organization name, inviter name or
other tenant or inviter free text appears. The link origin MUST come from
the dedicated trusted setting `INVITATION_LINK_BASE_URL` (`https` outside test and
one of the allowed origins), never from `BETTER_AUTH_URL`, the request `Host` or a
forwarded header, and the link MUST carry the invitation id and token in the
URL fragment, on a fixed path. The only other emails this capability sends are the
org-deletion notice, a fixed template whose only interpolated value is the purge
date, and the notice to the other admins when an `admin` invitation is accepted, a
fixed template with no interpolated value; neither has a link or any tenant, actor
or invitee free text. The provider MUST NOT track clicks or engagement, and the
message MUST have no Reply-To. Creating and resending invitations MUST be capped at 30 per hour
per tenant, 3 per 24 hours per recipient across all tenants (keyed by a digest
of the normalized email, never the address), and by a global kill switch. A
disabled or zero cap MUST fail startup. Exceeding any cap MUST fail the
operation with `AUTH_RATE_LIMITED` and a `Retry-After` header, send no email, and log
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
- **THEN** the emailed link starts with the configured `INVITATION_LINK_BASE_URL`, and its id and token are in the fragment

#### Scenario: The deletion notice carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an admin with a markup-bearing name
- **WHEN** the org-deletion notice is sent
- **THEN** neither string appears, the notice has no link, and its only variable is the purge date

#### Scenario: The admin notice carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an invitee with a markup-bearing name
- **WHEN** the notice to the other admins is sent
- **THEN** neither string appears, the notice has no link, and it has no interpolated value

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
A service account MUST hold exactly one active credential: creating a credential
bound to a service account that already has an active one MUST be refused, a
revoked credential MUST be rotatable only when its service account has no active
credential, and rotation MUST be serialized per service account.
Disabling a service account MUST be enforced on the request path: a token
already issued for it MUST be rejected within seconds and no new token MUST be
issued, and re-enabling restores access without a new credential. A token whose
bound `_user` is absent or not `Active` MUST be rejected, and no token MUST be
issued for it, so a surviving credential of a deleted service account never
resolves. Deleting a service account MUST be an explicit operation that revokes
(not merely disables) **every** credential bound to it and then removes its
`_user` entity.

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

#### Scenario: Deleting a service account revokes every bound credential

- **GIVEN** a service account with two non-revoked credentials, for example seeded before the one-credential rule
- **WHEN** an admin deletes it
- **THEN** both credentials are rejected within the cache window

#### Scenario: A token for a deleted service account is rejected

- **GIVEN** a service account that was deleted while a credential and an issued token survive
- **WHEN** the token is used, or the credential is exchanged
- **THEN** the call is rejected and no token is issued

#### Scenario: A service account holds one active credential

- **GIVEN** a service account with an active credential
- **WHEN** an admin creates another credential bound to it
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED`, and after the first is revoked a new one can be created

### Requirement: Org API-credentials viewer never re-exposes a secret

Listing an organization's API credentials (service accounts, integrations and
agents) MUST return, per credential: a name, its kind, a non-secret
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
explicitly (60 verifications per hour by default, configurable, and a disabled or
zero value MUST fail startup), and MUST NOT store any leading characters of the
secret. A `userId` it takes MUST resolve on the server to a service account of the
caller's tenant. Rotating a
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

#### Scenario: A credential cannot be bound to a user outside the tenant or to a human

- **WHEN** an admin creates a credential with a `userId` that is a human, unknown, or a service account of another tenant
- **THEN** the operation fails with `CATALOG_NOT_FOUND` and nothing is created

#### Scenario: An admin who is not the owner can manage organization keys

- **GIVEN** a Better Auth `admin` member who is not the organization `owner`
- **WHEN** they create and revoke an organization credential through the identity operations
- **THEN** both succeed because Cerbos allows them, and a `member` is denied by Cerbos
- **AND** the admin keeps every other permission a Better Auth `admin` has by default

#### Scenario: Rotating replaces the usable credential

- **GIVEN** service account `svc-ci-github` with credential `c1`, enabled, and an access token issued from it
- **WHEN** an admin rotates its credential
- **THEN** a new credential `c2` is returned once with its secret, `c1` is revoked, and `c1`'s issued token and any new exchange with `c1` are rejected within seconds

#### Scenario: Concurrent rotation leaves exactly one active credential

- **GIVEN** a service account with one active credential
- **WHEN** two admins rotate it at the same time
- **THEN** exactly one rotation succeeds, the other fails, and exactly one credential is usable afterward

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

#### Scenario: A user with memberships in two tenants cannot be linked

- **GIVEN** a user who belongs to `t1` and `t2`
- **WHEN** an admin of `t1` links or unlinks an SSO `sub` for it
- **THEN** the operation is refused and nothing changes (changing its status is tenant-scoped and is covered by "A member of two tenants is disabled in one only")

#### Scenario: Org deletion targets only the host tenant

- **WHEN** an admin of `t1` requests org deletion with `t2`'s identifier as the confirmation
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and nothing of `t1` or `t2` changes

#### Scenario: A user's self-deny uses the resolved identity

- **GIVEN** an admin addressed by their email in the path
- **WHEN** the admin changes their own status through that email
- **THEN** the self-deny applies, because Cerbos compares the resolved opaque user id and never the email

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
invitations, send the fixed org-deletion notice to every administrator of the
organization (a send failure MUST NOT block the request and MUST be logged), and log
`catalog.audit.org_deletion_requested` with the admin as actor; from then on
`resolveContext` and token exchange MUST reject every principal of the tenant,
human or machine, while the marker is pending or purged. Requesting deletion again while pending MUST change nothing
and MUST return the original date. In phase 2 a scheduled job MUST, for a
tenant whose purge date has passed, delete in two idempotent steps with safe
resume: first the tenant's catalog data (including the append-only change
events and revocation rows, through a function that deletes only for a tenant
whose marker is due), then the tenant's Better Auth data (invitations, API
keys, invitation tokens, members, each user left with no other membership
together with that user's accounts, sessions and second-factor rows, and the
organization row last). `catalog.audit.org_deletion_completed` MUST be logged
before the organization row is removed, and a failed step MUST log
`catalog.security.org_deletion_failed` and be retried by the next run. A pending deletion MUST be
reversible only by a platform operator, through an audited script that tombstones
the marker (never deletes it) and logs `catalog.audit.org_deletion_cancelled` with
the operator's opaque id; there is no in-product cancel. The script, and the
one-off `_user` backfill, MUST run only through a reviewed manual workflow whose
environment requires a second approver, and the operator's id MUST derive from that
workflow's authenticated actor, never from an argument.

#### Scenario: Deletion without step-up fails

- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** that admin requests org deletion
- **THEN** the operation fails with a step-up-required error and nothing changes

#### Scenario: Requesting deletion revokes access at once

- **GIVEN** organization `t1` with blueprints, entities, members and API credentials
- **WHEN** an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
- **THEN** every member's session and every `t1` credential, human or machine, is rejected within seconds, a marker with a purge date 7 to 14 days away exists, and the data is still there

#### Scenario: Every admin is notified of a pending deletion

- **GIVEN** an organization with an owner, two admins and a member
- **WHEN** an admin requests deletion
- **THEN** each of the three administrators receives exactly one fixed-template email and the member receives none, and a repeated request sends nothing

#### Scenario: A platform operator reverses a pending deletion

- **GIVEN** `t1` has a pending deletion
- **WHEN** a platform operator runs the reversal script
- **THEN** the marker is tombstoned (never deleted), `catalog.audit.org_deletion_cancelled` is logged with the operator's opaque id, and the tenant's principals are accepted again
- **AND** a later deletion request creates a new marker

#### Scenario: The reversal records the authenticated operator

- **WHEN** the reversal is started without the operator id that the reviewed workflow supplies
- **THEN** the script refuses to run and nothing is tombstoned

#### Scenario: A purged tenant stays rejected

- **GIVEN** `t1` was purged and its marker remains as a tombstone in state `purged`
- **WHEN** a principal of `t1` is resolved
- **THEN** it is rejected, while a tenant whose marker is `cancelled` is accepted

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

### Requirement: The deletion marker and the purge are protected from the request path

The deletion marker MUST be insert-only for the role that serves requests: its
`requested_at` MUST be set by the database, a database constraint MUST keep
`purge_after` between 7 and 14 days after `requested_at`, and only one pending
marker per tenant MAY exist. The purge MUST run as a dedicated role, used only by
the purge job with its own secret, that can act only on tenants with a due pending
marker; the append-only change-event rows MUST be deletable only by that role, and
the purge and due-tenant listing functions MUST be hardened (a fixed `search_path`,
no dynamic SQL, no `EXECUTE` for `PUBLIC`). A schema-driven test MUST fail when a
table carrying tenant data is neither purged nor explicitly exempted.

#### Scenario: The request role cannot back-date a marker

- **WHEN** the role that serves requests inserts a marker with a past or caller-supplied `requested_at`, or a `purge_after` outside 7 to 14 days
- **THEN** the database ignores the first and refuses the second, and the request role can neither update nor delete a marker

#### Scenario: Only due tenants can be purged, and only by the purge role

- **GIVEN** a tenant with a pending marker whose date has not passed, and one with a due marker
- **WHEN** the purge role and the request role each try to delete the append-only rows of both
- **THEN** only the purge role, and only for the due tenant, succeeds; every other path is refused, including the table owner

#### Scenario: No role can become the purge role

- **WHEN** any other role of the platform attempts `SET ROLE` to the purge role
- **THEN** it is refused, and no role membership grants it

#### Scenario: A new table cannot escape the purge

- **WHEN** a table with a `tenant_id` column, an `auth` table that references an organization or a user (by foreign key or by column), or a new `auth.verification` identifier pattern is added that no purge step covers
- **THEN** the completeness test fails until it is covered or exempted with a reason

### Requirement: Every high-risk operation requires step-up

These operations MUST carry `x-tayzu-risk: high` on their route, so that the
step-up gate in the OpenAPI interceptor applies: `identity.users.setStatus`,
`identity.users.invite`, `identity.users.create`,
`identity.serviceAccounts.create`, `identity.serviceAccounts.delete`,
`identity.credentials.create`, `identity.credentials.rotate`,
`identity.credentials.revoke`, `identity.organization.delete`, and the
existing SSO link and unlink operations (which have their own routes). The
acceptance route has no route spec and MUST call the same guard explicitly when the
invited role is `admin`. An admin session without a fresh
verification MUST receive `AUTH_STEP_UP_REQUIRED` and nothing MUST change. The
step-up gate runs only over HTTP, so it MUST be tested over HTTP. The OpenAPI
document generated from the identity router MUST be committed as
`openapi/identity.openapi.json`, and a check MUST fail when it drifts from the
router.

#### Scenario: A hijacked admin session without a fresh MFA cannot mint power

- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** it invites an `admin`, creates a user, creates a service account or creates a credential
- **THEN** each fails with `AUTH_STEP_UP_REQUIRED` over HTTP and nothing is created

#### Scenario: The step-up honors the factor and the identity provider

- **GIVEN** a user with an enrolled second factor holding only a password step-up marker, and a session that carries an SSO session id
- **WHEN** each calls a high-risk route
- **THEN** the first fails with `AUTH_STEP_UP_REQUIRED`, and the second is sent to the identity provider's re-authorization instead of a local verification

#### Scenario: An admin without an enrolled factor is blocked

- **GIVEN** an admin, invited or not, who has not enrolled a second factor
- **WHEN** they call any `/v1` route
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED` until they enrol

#### Scenario: Every route in the high-risk set is marked

- **WHEN** the committed identity OpenAPI document is read
- **THEN** every route in the set above carries `x-tayzu-risk: high`

#### Scenario: A drifted identity document fails the check

- **WHEN** a route's path or risk spec changes without regenerating the document
- **THEN** the contract check fails

### Requirement: Identity routes are unreachable until mounted

No route of this capability MUST be reachable over HTTP while the mount switch
(`MOUNT_IDENTITY_ROUTES`) is off, and the switch MUST be off by default. With
it off, every such route MUST answer exactly as an unknown `/v1` path does: 401
`CATALOG_CONTEXT_REQUIRED` for an unauthenticated caller and 404 for an authenticated
one. The routes are the fifteen of this capability: the machine-credential create and
revoke operations are library functions with no route of their own, reachable only
through them. The task that
registers the routes MUST come after every hand-off task from `002`.

#### Scenario: Routes answer like an unknown path while the switch is off

- **GIVEN** the switch is off, which is the default
- **WHEN** any identity route (including the public accept route) is called, with and without authentication
- **THEN** each answers exactly as an unknown `/v1` path does

#### Scenario: No route is registered outside the switch

- **WHEN** the Fastify route table and the router's procedures are enumerated
- **THEN** every identity and credential route is registered or reachable only behind the switch

### Requirement: Security-relevant events are logged

Every Cerbos deny, status change, service-account disable, enable and
deletion, invitation resend, user creation (including the bootstrap user),
credential creation, rotation and revocation, rejected principal, rate-limit
excess, and org-deletion request, completion, failure, cancellation and notice failure, and a failed admin-accepted notice, MUST be logged as the
corresponding `catalog.audit.*` or `catalog.security.*` event declared in the
Observability contract, with opaque identifiers and enumerated values only, and the
actor of an audit event MUST be the admin who acted, never the `system` actor of the
write. A failed org deletion MUST NOT be invisible.

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
and bootstrap passwords, `/change-password`) MUST be NFC-normalized, and every
password-verifying entry point (sign-in, `/verify-password`, `/two-factor/enable`,
`/change-password` and `/two-factor/generate-backup-codes`) MUST normalize the same
way, and then be 20 to 128 characters long, contain an upper-case letter, a lower-case
letter, a digit and a symbol, contain no control character, unpaired
surrogate or Unicode format character, and not appear on the bundled
common-password denylist. A generated temporary password MUST satisfy the same
policy, and MUST force a change at first sign-in and expire. A refusal MUST name only the failed rule and never
echo the password.

#### Scenario: A password verifies in any normalization form

- **GIVEN** a password set through acceptance
- **WHEN** it is presented in its decomposed (NFD) form at sign-in, `/verify-password`, `/two-factor/enable`, `/change-password` or `/two-factor/generate-backup-codes`
- **THEN** it verifies

#### Scenario: A temporary password grants only a password change

- **GIVEN** a user created with a temporary password
- **WHEN** they sign in with it
- **THEN** the session reaches only the change-password route until they set a policy-compliant password, and the temporary password expires if not changed

#### Scenario: A short password is refused

- **WHEN** an invitee accepts with a 19-character password that meets every other rule
- **THEN** the acceptance fails naming the length rule
- **AND** no user is created

#### Scenario: A password with a harmful character is refused

- **WHEN** a password contains a NUL, a control character, a bidirectional override or a zero-width character
- **THEN** it is refused naming the character rule, without echoing the password

#### Scenario: A breached password is refused

- **WHEN** a password appears in the Pwned Passwords corpus, on invitation acceptance, as a temporary password or as the bootstrap password
- **THEN** it is refused naming the breached-password rule, without echoing the password
- **AND** only the first five characters of its SHA-1 hash left the system

#### Scenario: The breach check fails closed

- **WHEN** the Pwned Passwords service is unreachable
- **THEN** the password is not set and the caller gets a generic retryable error

### Requirement: The hand-offs from the authentication baseline hold

Before the routes are mounted, the platform MUST refuse to start with `NODE_ENV=test`
and a non-local database host; the public re-authorization callback MUST be
rate-limited before it touches the database, and `reauthorization.start` MUST be
bounded per session; a back-channel logout token with neither `sid` nor `sub` MUST be
rejected without consuming its `jti`, and its cheap claim checks MUST run before any
outbound discovery or key fetch; the DAST API scan MUST fail when it sees no 2xx
operation response.

#### Scenario: A test environment cannot point at a remote database

- **WHEN** the platform starts with `NODE_ENV=test` and a non-local database host
- **THEN** startup fails

#### Scenario: A malformed logout token is cheap to refuse

- **WHEN** a back-channel logout token without `sid` and `sub` arrives
- **THEN** it is rejected, its `jti` is not consumed, and no discovery or key fetch happens

#### Scenario: The re-authorization callback is limited

- **WHEN** a caller exceeds the callback's limit
- **THEN** further requests are refused before any database access
