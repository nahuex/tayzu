# Spec Delta

## Purpose

Identity lifecycle and org administration completes Tayzu's identity model on
top of `002-auth-and-rbac`'s baseline: the full 4-state user lifecycle with
invitations, service accounts, org API-credential visibility and rotation,
all attributed and audited the same way as every other catalog mutation. Org-level
data deletion and data retention are the capability of
`045-org-deletion-and-data-retention`.

## Conventions

- **New Cerbos resource kinds**: `service_account` and `credential`. `user.invite` (which also covers cancelling and resending an
  invitation) and `user.updateStatus` are new actions on
  `002-auth-and-rbac`'s existing `user` resource kind, not a new kind.
- **Reused error codes**: this capability introduces no new error codes. A
  Cerbos deny on any operation added here surfaces as `002`'s `AUTH_FORBIDDEN`
  (403). The step-up gate on every high-risk operation surfaces as `002`'s
  existing `AUTH_STEP_UP_REQUIRED` (403). Invitation caps surface as `002`'s
  existing `AUTH_RATE_LIMITED` (429) with a `Retry-After` header, the same value for
  every invitation cap. A target that does not exist, or that
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
- **Routes**: fourteen routes, thirteen oRPC procedures and the plain Fastify
  invitation-accept route (`045` adds `DELETE /v1/organization`), all registered only behind the mount switch. The
  accept route is not in the OpenAPI document of the identity router
  (`openapi/identity.openapi.json`, committed and checked for drift; it carries
  paths, methods, path parameters and risk markers only, no schemas).
- **Canonical email**: the invited or created email is NFC-normalized, trimmed and
  lower-cased, and is the same string in the `_user` identifier, the Better Auth
  user, the invitation and (as an HMAC) the per-recipient cap key.
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
invitation, or by any hook. The ban hook MUST only ever disable: it MUST write the
disable event, to every membership of the user, only for an update that sets the user
banned, and MUST write nothing for an update that leaves the user not banned, so that
no account update (an unban, or enrolling a second factor from another tenant) can
re-enable a user disabled in one tenant.

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

#### Scenario: The ban hook never re-enables a user

- **GIVEN** a user who belongs to `t1` and `t2`, disabled in `t1` by an admin of `t1` and not banned
- **WHEN** the user enrols a second factor from a session of `t2`, or any other update leaves the user not banned
- **THEN** the user stays `Disabled` in `t1` and `Active` in `t2`, and the hook writes nothing

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

Every procedure of the identity router MUST be built through the one wrapper, and
the wrapper MUST work in this order: first a Cerbos check of the caller's role in
the caller's own tenant with no target, so that an unauthorized caller gets the same
`AUTH_FORBIDDEN` for any target and for any body; then the parsing of the input and the
server-side resolution of the target;
then a Cerbos check with the target's real tenant and the Cerbos attributes, which
emits `catalog.security.authz_denied` on a deny; and only then the handler. The
wrapper MUST fail closed: a Cerbos error, a malformed context or an empty role list
MUST deny and MUST NOT run the handler. A procedure built without the wrapper MUST
fail a test, and the check MUST NOT be bypassable by chaining or by importing an
unwrapped builder. Over HTTP each of the thirteen oRPC routes MUST allow an admin,
refuse a `member` and a machine `member` token with `AUTH_FORBIDDEN`, refuse an
unauthenticated caller with 401 and answer a foreign target exactly as an unknown
one.

#### Scenario: A route built without the wrapper is rejected

- **WHEN** a procedure is added to the identity router without the authorization wrapper, including by chaining or by an unwrapped builder
- **THEN** the structure test fails

#### Scenario: An unauthorized caller cannot tell a target from a missing one

- **GIVEN** a caller without the grant, a same-tenant target and an unknown target
- **WHEN** the caller invokes the operation on each
- **THEN** both answers are the same `AUTH_FORBIDDEN`, and the target was not resolved

#### Scenario: An unauthorized caller gets no parse error

- **GIVEN** a caller without the grant
- **WHEN** the caller invokes an operation with a malformed body, a body with an undeclared field and a valid body
- **THEN** all three answers are the same `AUTH_FORBIDDEN`, and the input was not parsed

#### Scenario: The wrapper fails closed


- **WHEN** Cerbos errors, the context is malformed or the caller has no roles
- **THEN** the operation is denied and the handler does not run

#### Scenario: Each identity route enforces its authorization over HTTP

- **GIVEN** the mounted server and the thirteen oRPC routes
- **WHEN** each route is called by an admin (with a fresh step-up where required), a member, a machine `member` token, an unauthenticated caller, and, where it has a target, with a foreign target
- **THEN** the admin is allowed, the member and the machine token get `AUTH_FORBIDDEN` (403), the unauthenticated caller gets 401, and the foreign target gets the same 404 as an unknown one

### Requirement: Disabling a human takes effect immediately

Disabling a human user MUST be scoped to the acting admin's tenant: it MUST write
the `_user` status of that tenant through the state machine, revoke every one of
the user's sessions whose active organization is that tenant (logging each as
`auth.security.session_revoked` with the reason `admin_action`), cancel the
user's pending invitations of that tenant, and cancel the pending invitations that
user created in that tenant. Only for a user whose single membership
is that tenant MUST it also ban the user and revoke all their sessions. The ban
MUST NOT use Better Auth's admin-plugin ban routes, which the global role `user`
cannot call. `resolveContext` MUST reject a banned user, and MUST admit a human only
when their `_user` status in the active tenant is `Active`: a `Disabled`, `Invited` or
`Staged` status and a missing `_user` row (reason `user_missing`) MUST be rejected, with
the answer `CATALOG_CONTEXT_REQUIRED` (401) and the reason only in the log, so that an existing
session and any new sign-in, local or through SSO, stop granting access. A banned user's
sign-in MUST fail with the same status, error code and body as any other sign-in
failure, locally and through SSO, after the credential was verified (as Better Auth
refuses a ban), so that the response never confirms a correct password. Enabling
the user MUST reverse only what disabling did in that tenant. Every rejection by
these checks MUST be logged as `catalog.security.principal_rejected` and counted.

#### Scenario: A disabled user's sessions stop working

- **GIVEN** an `Active` user with a single membership and a live session
- **WHEN** an admin disables the user
- **THEN** the next request on that session is rejected with `CATALOG_CONTEXT_REQUIRED` (401) and no reason in the body, a new sign-in (local or SSO) is refused, and `catalog.security.principal_rejected` is logged with the reason

#### Scenario: An `Invited` member is rejected by the resolver

- **GIVEN** a member of `t1` whose `_user` in `t1` is `Invited`, as a failed acceptance can leave it, or `Staged`
- **WHEN** the member calls any `/v1` route in `t1`
- **THEN** the call is rejected with `CATALOG_CONTEXT_REQUIRED` (401) and no reason in the body, `catalog.security.principal_rejected` is logged, and the same user is accepted in a tenant where their `_user` is `Active`

#### Scenario: A banned user's sign-in is indistinguishable from a wrong password

- **GIVEN** a banned user
- **WHEN** they sign in with the correct password, locally or through the SSO callback
- **THEN** the response has the same status, error code and body as a sign-in with a wrong password

#### Scenario: A member of two tenants is disabled in one only

- **GIVEN** an `Active` user who belongs to `t1` and `t2`, with a session in each
- **WHEN** the admin of `t1` disables the user
- **THEN** the user's `t1` session is rejected and their `_user` status in `t1` is `Disabled`
- **AND** their `t2` session, `_user` status and global account are unchanged, and re-enabling in `t1` restores only `t1`

#### Scenario: Disabling cancels pending invitations

- **GIVEN** a pending invitation to `bob@example.com` from this tenant and an existing `bob`
- **WHEN** an admin disables `bob`
- **THEN** the invitation's state becomes `cancelled` with reason `user_disabled`

#### Scenario: Disabling cancels the invitations the user created

- **GIVEN** an admin who created two pending invitations to other people, and another admin's pending invitation
- **WHEN** the first admin is disabled
- **THEN** their two invitations become `cancelled` with reason `inviter_disabled`, the other admin's stays `pending`, and re-enabling restores none


### Requirement: Every member has a `_user` row

A human member with no `_user` row in the active tenant MUST be rejected by
`resolveContext` (`CATALOG_CONTEXT_REQUIRED`, 401) and logged with the reason
`user_missing`. A repeatable reconcile, run only as an operator-started job (the reviewed workflow
that later starts it is `045`'s), MUST create the `_user` entity of every member that has none, through the
state machine as `created_active`, MUST leave an existing row untouched (a second run
changes nothing), MUST create a `Disabled` row for a member whose user is banned, MUST
remove an orphan (a human `_user` that is `Active`, has no membership in its tenant and
is more than one hour old, which a failed acceptance leaves behind; never an `Invited`
or `Staged` row, a younger row or a service account), and MUST attribute its writes to the operator whose id the job's environment
supplies, refusing to run without one. Before it creates the `_user` of a member whose user
belongs to two or more tenants, the reconcile MUST shed the SSO links that user did not make,
with the session revocation of the requirement on SSO links, and MUST NOT create the row
when the shed fails.

#### Scenario: A member with no `_user` row is rejected

- **GIVEN** a member of `t1` whose `_user` row does not exist
- **WHEN** the member calls any `/v1` route in `t1`
- **THEN** the call is rejected and `catalog.security.principal_rejected` is logged with the reason `user_missing`

#### Scenario: The reconcile does not revive a banned user

- **GIVEN** a banned member with no `_user` row
- **WHEN** the reconcile runs
- **THEN** the member's row is created and ends `Disabled`, not `Active`

#### Scenario: The reconcile removes an orphan

- **GIVEN** an `Active` human `_user` with no member in its tenant that is more than an hour old, one that is younger (an acceptance in flight), an `Invited` one, a `Staged` one and a service account
- **WHEN** the reconcile runs
- **THEN** only the older `Active` human row is removed, the removal is attributed to the operator, and a later invitation of that email succeeds

#### Scenario: The reconcile sheds before it creates a `_user`

- **GIVEN** a member of `t1` and `t2` with no `_user` row in `t2` and an SSO link they did not make
- **WHEN** the reconcile runs
- **THEN** the link is shed, the user's sessions are revoked and `catalog.security.sso_link_shed` is logged before the row is created, a single-tenant member's links are left alone, and a failed shed leaves the row uncreated

#### Scenario: The reconcile repairs a member and is repeatable

- **GIVEN** a member with no `_user` row and a member with an `Active` one
- **WHEN** the reconcile runs twice
- **THEN** the first run creates the missing row as `Active` through the state machine and leaves the other untouched, the second run changes nothing, and the member is accepted again

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
tenant. Only a `pending`, non-expired invitation MUST be acceptable. Creating a user
through `identity.users.create` for an email that has a `pending` invitation in the
caller's tenant MUST cancel that invitation, with the reason `user_created`, once the
user and the membership exist, and MUST leave an invitation of another tenant untouched.

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

#### Scenario: Creating a user cancels a pending invitation of the same email

- **GIVEN** a pending invitation of `t1` to `bob@example.com` and another of `t2` to the same address
- **WHEN** an admin of `t1` creates the user `bob@example.com` through `identity.users.create`
- **THEN** the `t1` invitation becomes `cancelled` with the reason `user_created` and `catalog.audit.invitation_cancelled` is logged with that reason, the `t2` invitation stays `pending`, and a creation that fails leaves the `t1` invitation `pending`

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
before it is consumed and then consumed last, by one atomic delete conditioned on its
digest, and MUST work exactly once; a resend MUST invalidate the previous token. The
tenant MUST be derived on the server from the invitation record; a body that
carries a tenant or an actor MUST be rejected. On both paths, after the token has verified and before it is consumed, the invitation's
inviter MUST still be a member of the organization, MUST NOT be banned and MUST have the
`_user` status `Active` in the tenant, and Cerbos MUST still allow the inviter, as a
principal built from their membership in the invitation's tenant, to invite a user there
(the admin role is never decided by a local mapping of the membership role); otherwise,
and also when Cerbos fails, the acceptance fails with the uniform rejection and the
token is not consumed.
For an invited email with no account,
acceptance MUST create the user with the least global role, set the password the
invitee supplied under the password policy, mark the email verified (the token is
proof of mailbox control), add the membership with the invited role, write the
status through the state machine, and MUST NOT create a session. The acceptance
MUST NOT depend on a single transaction: its steps MUST be idempotent, the token MUST
be consumed last, the `_user` write MUST fail closed (if it fails, the token is not
consumed and what the attempt created MUST be undone, so that a retry with the same
token starts from nothing), and an orphan `_user` that a double failure leaves MUST be
repaired by the reconcile. For an email that
already has an account, acceptance MUST require a valid session of that same
account, which MUST be read without refreshing it and MUST pass the idle-timeout and
banned checks and the
temporary-password marker check that the authenticated pipeline applies, and whose
email MUST equal the invitation email (there is no
verified-email condition, because no account's email is verified by anything else),
together with the token; the request MUST carry the CSRF custom header and an
`Origin` header that is present and in the allowed origins; when the invited role is
`admin` it MUST also require a fresh step-up verification (and, for a session of
the identity provider, its re-authorization), checked only after the session, the
email and the token have matched. It MUST add only the membership, activate the
`_user` and mark the email verified, and MUST NOT set, change or compare a
password or change the active organization, and MUST NOT touch a linked account or a
session, the request's own included, except to shed the SSO links its user did not make
and, when a link was shed, revoke the user's sessions, the one that carried the
acceptance only after the acceptance has committed (see the requirement on SSO links).
If a step after the membership was added fails before the token is consumed, the
membership that the attempt created MUST be deleted, and a membership that existed
before the attempt MUST NOT be. Acceptance
MUST NOT link an account by the email claim from Visma Connect. The body MUST be an
allowlist of the invitation id, the token and, for a new account, the password; any
other field MUST be rejected with `CATALOG_VALIDATION_FAILED`, and an invitation id
that fails a shape and length check MUST NOT be logged. Every rejected
acceptance (nonexistent invitation, expired, cancelled, rejected or already-accepted
invitation, wrong token, a `Disabled` user, an inviter who is no longer an
active admin, a tenant at its member limit, no or mismatched session for an existing account, a failed CSRF or origin check, or a lost
concurrent account creation)
MUST return the same status, error code and body shape, and a nonexistent invitation
MUST take the same comparison work as a wrong token; the specific reason MUST be
recorded only in the `catalog.security.invitation_acceptance_denied` event. A
password that fails the policy MUST be reported only after the token has verified,
without consuming the token. When an invitation whose role is `admin` is accepted, a
fixed notice with no link and no free text MUST be sent to every other
administrator of the organization, `Disabled` administrators included; a send failure MUST NOT block the acceptance and
MUST be logged.

#### Scenario: A new person accepts and can then sign in

- **GIVEN** a pending invitation to `bob@example.com`, who has no account
- **WHEN** `bob` presents the invitation id, the token and a policy-compliant password
- **THEN** `bob` has an account with a verified email, a membership with the invited role and status `Active`, and no session exists
- **AND** the token cannot be used a second time

#### Scenario: A failed `_user` write undoes the acceptance

- **GIVEN** a pending invitation to `bob@example.com`, who has no account, and a `_user` write that fails
- **WHEN** `bob` presents the invitation id, the token and a policy-compliant password
- **THEN** no user, no membership and no `_user` exist, the token is not consumed and still verifies, the answer is the sanitized generic server error, and a retry with the same token succeeds

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

- **GIVEN** a pending invitation to `carol@example.com`, who has an account, a session and no SSO link she did not make
- **WHEN** `carol` presents the token with her session, the CSRF custom header and an allowed origin
- **THEN** she gains the membership with the invited role and her `_user` becomes `Active`
- **AND** her email is now marked verified, even if it was not before
- **AND** her password, session, active organization and linked accounts are unchanged, and the response has the same status and shape as a new person's acceptance

#### Scenario: A failed existing-account acceptance leaves no membership

- **GIVEN** a pending invitation to `carol@example.com`, who has an account and a session, and a step after the membership was added that fails
- **WHEN** `carol` presents the token with her session
- **THEN** she has no membership of the tenant, the token is not consumed and still verifies, a retry with the same token adds the membership again, and a membership she held before the attempt is never deleted by it

#### Scenario: A session of another account cannot accept

- **GIVEN** a pending invitation to `carol@example.com`
- **WHEN** it is accepted with the valid token and a session of another user
- **THEN** the answer is the uniform rejection and nothing changes

#### Scenario: A banned, idle or temporary-password session cannot accept

- **GIVEN** a pending invitation to `carol@example.com`
- **WHEN** it is accepted with the valid token and a session of `carol` that is banned, past its idle timeout or held by a user with an unexpired temporary-password marker
- **THEN** the answer is the uniform rejection and nothing changes

#### Scenario: An admin invitation to an existing account needs step-up

- **GIVEN** a pending `admin` invitation to `carol@example.com` and her matching session
- **WHEN** she presents the valid token without a fresh step-up verification
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED` and nothing changes
- **AND** a caller with a wrong token gets the uniform rejection, not `AUTH_STEP_UP_REQUIRED`
- **AND** a session of the identity provider is sent to its re-authorization instead of a local verification, and completes after it

#### Scenario: An accepted admin invitation notifies the other admins

- **GIVEN** an organization with an owner, two admins and a `Disabled` admin
- **WHEN** an invitation with the role `admin` is accepted, on either path
- **THEN** the owner, the two admins and the `Disabled` admin each receive exactly one fixed-template notice with no link and no free text, the new admin receives none, and a failing send does not stop the acceptance

#### Scenario: An invitation does not outlive its inviter's authority

- **GIVEN** a pending invitation whose inviter is then disabled, banned, demoted to `member` or no longer a member
- **WHEN** it is accepted with its valid token, on the new-account path and on the existing-account path
- **THEN** each answers the uniform rejection, `catalog.security.invitation_acceptance_denied` records the reason `inviter_not_active_admin`, and the token is not consumed
- **AND** an invitation whose inviter is still an active `admin` or `owner` is accepted, and a wrong token with a disabled inviter answers the same uniform rejection

#### Scenario: The inviter re-check is a Cerbos decision

- **GIVEN** a pending invitation whose inviter is still an active, non-banned member of the tenant
- **WHEN** it is accepted with its valid token while Cerbos denies the inviter `invite` in the invitation's tenant, or fails
- **THEN** the answer is the uniform rejection, the reason `inviter_not_active_admin` is recorded and the token is not consumed, and the check was made with the inviter as the principal and the invitation's tenant

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

- **GIVEN** a nonexistent invitation, an expired invitation, a pending invitation with a wrong token, and a pending invitation of a `Disabled` user
- **WHEN** each acceptance attempt is made
- **THEN** all fail with the same status, error code and body shape, and the specific reason appears only in `catalog.security.invitation_acceptance_denied`

#### Scenario: The accept route is rate-limited

- **WHEN** a caller exceeds the configured acceptance rate
- **THEN** further requests fail with `AUTH_RATE_LIMITED` and a `Retry-After` header before any invitation lookup, and the count is shared across replicas

### Requirement: An SSO link that its user did not make does not survive into a second tenant

The platform MUST record the provenance of every SSO link positively: a link that the
user makes through the self-service link route or the SSO callback MUST carry a marker,
keyed by the link's own row identifier (never by the identity provider's subject),
written when the link is created and removed whenever the link is removed, by any
path, and a link without a marker MUST count as recorded by an admin. A marker MUST NOT
expire and MUST carry no email, subject or tenant. A failed marker write MUST fail the
link and MUST be logged. An admin MUST NOT be able to record a link on a user who is an
`admin` or an `owner` of the tenant. At existing-account acceptance, whenever a
membership is added to a user who already belongs to another tenant, and before the
reconcile creates a `_user` for a member of two or more tenants, every unmarked link
of that user MUST be deleted (the shed) and `catalog.security.sso_link_shed` MUST be
logged with opaque identifiers only. At acceptance the shed MUST run as an explicit step
of every attempt once the membership exists, including a retry that finds the membership
already added, before the token is consumed, and a shed that fails MUST fail the attempt.
When the shed removed a link, every session of the user MUST be revoked, whether or not
the session was established through the identity provider, each revocation being logged
as `auth.security.session_revoked` with the reason `sso_link_shed`; the session that
carries the acceptance request MUST be kept while the acceptance runs and MUST be revoked
once it has committed; and the shed MUST sweep the user's sessions a second time after its
deletion commits. The SSO callback MUST NOT create a session through an account that no
longer exists, or that carries no marker while its user belongs to two or more tenants. An
admin unlinking an SSO identity MUST revoke every session of that user in the same way. A
link and a join for one user MUST NOT interleave: one lock per user MUST serialize the link
and the shed, so that a link that commits after a join cannot remain on a user of two
tenants. The user MAY link the identity again through the self-service route, which
requires a fresh step-up verification.

#### Scenario: An SSO link its user did not make does not survive into a second tenant

- **GIVEN** a user who belongs only to `t1`, with an SSO link recorded by an admin of `t1`
- **WHEN** the user accepts an invitation of `t2` on the existing-account path, or a membership of `t2` is added to them directly
- **THEN** the link and any marker are gone, `catalog.security.sso_link_shed` is logged once, and signing in with that `sub` no longer reaches the user

#### Scenario: A session established through a shed link cannot reach the joined tenant

- **GIVEN** a session minted through an admin-recorded link before the user joins `t2`
- **WHEN** the user joins `t2`, by acceptance or by a membership added directly
- **THEN** that session is revoked, so `/organization/set-active` for `t2` and any `/v1` call with it are rejected, `auth.security.session_revoked` is logged with the reason `sso_link_shed`, and on the acceptance path the acceptance carried by another session completes

#### Scenario: A retried acceptance still sheds the link and revokes the sessions

- **GIVEN** a user of `t1` with an SSO link they did not make, and an existing-account acceptance of `t2` whose first attempt failed after the membership was added and left it in place
- **WHEN** the acceptance is retried with the same token and finds the membership already added
- **THEN** the link is shed, the user's sessions are revoked and `catalog.security.sso_link_shed` is logged before the token is consumed, and a shed that fails fails the attempt without consuming the token

#### Scenario: A sign-in through a shed link creates no session

- **GIVEN** an SSO sign-in through a link the user did not make that is in flight while the user joins a second tenant, or a link without a marker on a user of two tenants
- **WHEN** the callback is about to create its session after the shed deleted the link, or through the unmarked link
- **THEN** the callback fails with its uniform rejection and no session exists

#### Scenario: A session created during the shed is swept

- **GIVEN** a session created through the link after the shed's first sweep and before its deletion commits
- **WHEN** the deletion commits
- **THEN** a second sweep revokes that session and logs `auth.security.session_revoked` with the reason `sso_link_shed`

#### Scenario: The accepting session is revoked when the shed removed a link

- **GIVEN** a user with an SSO link they did not make who accepts an invitation of a second tenant with a session on the existing-account path
- **WHEN** the acceptance commits
- **THEN** the acceptance succeeded, the session that carried it is revoked afterwards and the user signs in again, and a user whose only link they made keeps that session

#### Scenario: An admin unlink revokes the user's sessions

- **GIVEN** a session minted through an admin-recorded link
- **WHEN** an admin unlinks that identity
- **THEN** every session of the user is rejected afterwards and `auth.security.session_revoked` is logged with the reason `sso_link_shed`

#### Scenario: A link the user made survives

- **GIVEN** a user with an SSO link made through the self-service link route, which carries a marker keyed by the link's row identifier
- **WHEN** the user joins a second tenant
- **THEN** the link and its sessions are unchanged and nothing is logged

#### Scenario: A link that pre-dates the marker is treated as admin-recorded

- **GIVEN** a user with an SSO link that has no marker, for example one made before this capability existed
- **WHEN** the user joins a second tenant
- **THEN** the link is shed, and the user may link again through the self-service route

#### Scenario: A failed marker write fails closed

- **GIVEN** the marker write fails while a user links through the self-service route
- **WHEN** the link is attempted
- **THEN** the link fails and `catalog.security.sso_link_marker_failed` is logged, and an unmarked link left behind would be shed like an admin-recorded one

#### Scenario: A marker does not outlive its link

- **WHEN** a link is removed by the user's own unlink, by an admin unlink or by the shed, and later the same subject is linked again
- **THEN** each removal also removed the marker, and the new link carries a fresh marker and not a stale one

#### Scenario: A link cannot race a join

- **GIVEN** a user who is single-tenant, a link being recorded and a second membership being added at the same time
- **WHEN** both complete
- **THEN** either the link was refused because the user already belongs to two tenants, or it was shed, and no unmarked link remains on a user of two tenants

#### Scenario: The user can link again

- **GIVEN** a user whose link was shed
- **WHEN** the user links the identity through the self-service route with a fresh step-up verification
- **THEN** the link exists and carries a marker

### Requirement: Invitation email is fixed and capped

The invitation email MUST be sent to exactly one recipient, a single plain
address with no line breaks, display name or list separator, and MUST have no
CC, BCC or attachment. Its subject and template MUST be fixed: only the link
and the expiry text are interpolated, and no organization name, inviter name or
other tenant or inviter free text appears. The link origin MUST come from
the dedicated trusted setting `INVITATION_LINK_BASE_URL` (`https` outside test and
one of the allowed origins), never from `BETTER_AUTH_URL`, the request `Host` or a
forwarded header, and the link MUST carry the invitation id and token in the
URL fragment, on a fixed path. The only other email this capability sends is the notice to the other admins when an
`admin` invitation is accepted, a fixed template with no interpolated value, with no link
or any tenant, actor or invitee free text (`045` adds the org-deletion notice to the
same controls). Every notice MUST go through the same global kill switch and
per-recipient cap as the invitation email, MUST be capped per tenant, and MUST go to
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

### Requirement: Service accounts are non-human users created API-only

A service account MUST be a `_user` entity with `accountKind: "service"`
(as opposed to `"standard"` for a human user), identified by
`^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`. Creating a service account MUST be
authorized to admins only, MUST require a fresh step-up verification, MUST set
its status to `Active` immediately with no invitation email sent, and MUST
atomically issue one organization-owned machine credential
(`clientId`/`clientSecret`) for it. The credential's secret MUST be returned
exactly once, in the creation response, and MUST NOT be retrievable again.
Every service-account route MUST resolve its target on the server and MUST answer
`CATALOG_NOT_FOUND`, identical to an unknown id, unless the target's `_user` has
`accountKind: "service"` and an `svc-` identifier, including for the caller's own `_user`
and an owner's; Cerbos MUST also deny any action on a `service_account` resource whose
`accountKind` is not `service`. A service account MUST hold exactly one active credential: creating a credential
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
`_user` entity. If issuing the credential fails after the `_user` was written, the
`_user` MUST be removed again. A tenant MUST NOT hold more than 50 service accounts
(configurable, a disabled or zero value fails startup), and the creation of one
beyond the cap MUST fail with `CATALOG_VALIDATION_FAILED`, including under
concurrent creates.

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

#### Scenario: A failed credential issue leaves no orphan service account

- **GIVEN** the key creation fails after the `_user` entity was written
- **WHEN** an admin creates a service account
- **THEN** the operation fails and no `_user` entity of that service account remains

#### Scenario: A service-account route refuses a human target

- **GIVEN** a human `_user` such as `alice@example.com`, the admin's own address and an owner
- **WHEN** an admin deletes or changes the status of any of them through a service-account route
- **THEN** each answers the same `CATALOG_NOT_FOUND` as an unknown id, the human's row and status are intact, no credential is revoked and no event is emitted

#### Scenario: The per-tenant service-account cap holds


- **GIVEN** a tenant with 50 service accounts
- **WHEN** an admin creates another, or two admins create the 50th at the same time
- **THEN** the creation beyond the cap fails with `CATALOG_VALIDATION_FAILED` and the tenant never holds more than 50

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

#### Scenario: Concurrent credential creation for one service account yields one

- **GIVEN** a service account with no active credential
- **WHEN** two admins create a credential bound to it at the same time
- **THEN** exactly one succeeds, the other fails with `CATALOG_VALIDATION_FAILED`, and exactly one credential is active

### Requirement: Org API-credentials viewer never re-exposes a secret

Listing an organization's API credentials (service accounts, integrations and
agents) MUST return, per credential: its opaque id (the identifier that rotate and
revoke take), a name, its kind, a non-secret prefix (a constant, because no leading
characters of a secret are stored), creation time, last-used time (when known), enabled/disabled state,
whether it is past its rotation-due threshold, and the opaque id of the admin who
created it (when known). A credential MUST be shown
disabled when its key is disabled, it is revoked, or its bound service account
is `Disabled`. It MUST NOT return the secret value or any stored secret
characters under any circumstance after creation. This listing MUST be
authorized to admins only and MUST contain only credentials of the caller's
tenant. A page MUST be at least as large as the credential cap and MUST list the
non-revoked credentials before the revoked ones, so that no credential a tenant can hold
is hidden from an admin who needs to revoke it, and MUST say when revoked ones were left
out.

#### Scenario: Listing never includes the secret

- **GIVEN** an organization with 3 API credentials
- **WHEN** an admin lists them
- **THEN** each entry has a prefix, not the full secret, and no field in the response ever equals a credential's secret value

#### Scenario: The viewer shows every credential a tenant can hold

- **GIVEN** a tenant with 200 non-revoked and 30 revoked credentials
- **WHEN** an admin lists them
- **THEN** all 200 non-revoked credentials are listed, each with an id that `rotate` accepts, and the page says that revoked ones were left out

#### Scenario: The viewer shows who created a credential

- **GIVEN** a credential created by an admin through the identity operations
- **WHEN** an admin lists the credentials
- **THEN** its entry carries the creating admin's opaque id and no email

#### Scenario: Non-admin cannot list credentials

- **WHEN** an actor without the grant lists credentials
- **THEN** the operation is denied

### Requirement: Credential creation, rotation and revocation take effect within seconds

Creating an integration or agent credential MUST be authorized to admins only,
MUST require a fresh step-up verification, MUST set a per-key rate limit
explicitly (60 verifications per hour by default, configurable, and a disabled or
zero value MUST fail startup), and MUST NOT store any leading characters of the
secret. A `userId` it takes MUST resolve on the server to a service account of the
caller's tenant. The credential `name` MUST be 1 to 32 characters, and a tenant
MUST NOT hold more than 200 non-revoked credentials (configurable, a disabled or
zero value fails startup); creating one beyond the cap MUST fail with
`CATALOG_VALIDATION_FAILED`. The rate limit is copied into each key at creation, so
a later configuration change MUST apply to new keys only. Reads that must see every
credential of a tenant (delete, rotate, the one-credential check, the cap) MUST NOT
stop at the viewer's page limit. Rotating a
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

#### Scenario: The credential cap and the name limit hold

- **GIVEN** a tenant with 200 non-revoked credentials
- **WHEN** an admin creates another, or creates one with a name of 33 characters
- **THEN** the creation fails with `CATALOG_VALIDATION_FAILED` and nothing is created

#### Scenario: Delete and rotate see credentials beyond the viewer's limit

- **GIVEN** a service account whose credential is beyond the viewer's page limit among the tenant's keys
- **WHEN** an admin rotates or deletes it
- **THEN** the credential is found and revoked

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

Every invitation, credential, user and service account targeted
by an operation in this capability MUST be resolved on the server and MUST
belong to the host's `tenantId`; otherwise the operation MUST fail with
`CATALOG_NOT_FOUND`, identical to a nonexistent id. Cerbos MUST receive the
target's real tenant, not the caller's echoed back. Every Better Auth
call MUST be given the host tenant only.

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

#### Scenario: An admin cannot record an SSO link on an admin or an owner

- **GIVEN** another admin and an owner of `t1`
- **WHEN** an admin of `t1` links an SSO `sub` to either of them
- **THEN** the operation is refused with the same generic rejection as every other link conflict, no account is written and no session is revoked, and they can still link their own identity through the self-service route with a fresh step-up verification

#### Scenario: A user's self-deny uses the resolved identity

- **GIVEN** an admin addressed by their email in the path
- **WHEN** the admin changes their own status through that email
- **THEN** the self-deny applies, because Cerbos compares the resolved opaque user id and never the email

#### Scenario: Create and link give one generic answer to every conflict

- **WHEN** an admin creates a user for an email that already has an account in this tenant or in another tenant, or links a `sub` that is already linked, or links a `sub` to an admin or an owner
- **THEN** every cause answers with the same `CATALOG_VALIDATION_FAILED` and a fixed message, and no state changes, so a failed probe leaves no partial state

### Requirement: Every high-risk operation requires step-up

These operations MUST carry `x-tayzu-risk: high` on their route, so that the
step-up gate in the OpenAPI interceptor applies: `identity.users.setStatus`,
`identity.users.invite`, `identity.users.create`,
`identity.serviceAccounts.create`, `identity.serviceAccounts.delete`,
`identity.credentials.create`, `identity.credentials.rotate`,
`identity.credentials.revoke`, and the
existing SSO link and unlink operations (which have their own routes). The
acceptance route has no route spec and MUST call the same guard explicitly when the
invited role is `admin`. An admin session without a fresh
verification MUST receive `AUTH_STEP_UP_REQUIRED` and nothing MUST change. The
step-up gate runs only over HTTP, so it MUST be tested over HTTP. The OpenAPI
document generated from the identity router MUST be committed as
`openapi/identity.openapi.json` (paths, methods, path parameters and risk markers,
with no schemas), and a check MUST fail when it drifts from the router.

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
one. The routes are the fourteen of this capability: the machine-credential create and
revoke operations are library functions with no route of their own, reachable only
through them, exported only on a package subpath and importable only from the identity
code. The task that
registers the routes MUST come after every hand-off task from `002`. With the
switch on, every Fastify route outside an explicit public allowlist MUST be behind
the authenticated context resolution.

#### Scenario: Routes answer like an unknown path while the switch is off

- **GIVEN** the switch is off, which is the default
- **WHEN** any identity route (including the public accept route) is called, with and without authentication
- **THEN** each answers exactly as an unknown `/v1` path does

#### Scenario: A new Fastify route cannot be public by accident

- **GIVEN** the switch is on
- **WHEN** the Fastify route table is enumerated
- **THEN** every route outside the public allowlist is behind the authenticated context resolution, and a route added outside both fails the test

#### Scenario: No route is registered outside the switch

- **WHEN** the Fastify route table and the router's procedures are enumerated
- **THEN** every identity and credential route is registered or reachable only behind the switch

### Requirement: Security-relevant events are logged

Every Cerbos deny, status change, service-account disable, enable and
deletion, invitation resend, user creation (including the bootstrap user),
credential creation, rotation and revocation, rejected principal, rate-limit
excess, an invitation cancelled by a user creation, a failed admin-accepted notice, a suppressed or truncated notice, a
recipient refused by the non-production allowlist, an email suppressed for a disabled
tenant, an SSO link shed (and the session revocations it causes), a provenance marker write that
failed, an acceptance compensation that failed, a banned user's sign-in attempt and a
reconcile run, MUST be logged as the
corresponding `catalog.audit.*` or `catalog.security.*` event declared in the
Observability contract, with opaque identifiers and enumerated values only, and the
actor of an audit event MUST be the admin who acted, never the `system` actor of the
write.

#### Scenario: Each lifecycle action emits its declared event

- **WHEN** each of the actions above is executed once
- **THEN** its declared event is observed with its required attributes and no email, token, name or secret

#### Scenario: A maintenance script's audit event is exported before it exits

- **WHEN** the reconcile script emits its `catalog.audit.*` event and finishes, or fails
- **THEN** the event has been exported (flushed) by the time the script's process ends

### Requirement: Telemetry contract

Every operation added by this capability MUST emit the spans, metrics, and
log events declared in this change's Observability contract, using the
declared names and attributes. The names MUST be declared in a contract module of their
own that the telemetry smoke check also enforces, and the authentication contract of
`002` MUST stay unchanged. Telemetry MUST NOT contain invited email
addresses, invitation tokens, credential names, credential secrets, `_user`
identifiers, or any other tenant-supplied free text, and no identifier in a URL
path (an email, an invitation id or a credential id) MUST reach any exported
span, metric or log: for the routes of this capability the exported path MUST
be the route template. A catalog span of a `_user` entity MUST carry a fixed placeholder
instead of the entity identifier (an email, or the `svc-` identifier of a service
account), while the entities of other blueprints keep theirs. Opaque identifiers and
enumerated values (status, invitation state, account kind, credential kind) are permitted.

#### Scenario: Declared telemetry is emitted

- **WHEN** each operation in this capability is executed once, successfully and with a denied/failed case, under an in-memory telemetry exporter
- **THEN** every span, metric and log event declared in the contract is observed with its required attributes

#### Scenario: Invited email never reaches telemetry

- **WHEN** `marker-user@example.com` is invited, and later fails to accept an expired invitation
- **THEN** that email string appears in no exported span, metric, or log attribute

#### Scenario: A `_user` email never reaches a catalog span

- **WHEN** a `_user` entity whose identifier is `marker-user@example.com` is created, read, updated, deleted or listed through the catalog, including through the existing user sync
- **THEN** each catalog span carries the fixed placeholder as its entity identifier and the email appears in no exported attribute, and an entity of another blueprint keeps its identifier

#### Scenario: A path identifier never reaches telemetry over HTTP

- **WHEN** `PUT /v1/users/marker-user@example.com/status` and a credential route with a marker id are called through the real HTTP server and instrumentation
- **THEN** neither marker appears in any exported span, metric or log attribute, and the exported path is the route template

#### Scenario: The email provider's failure never leaks

- **WHEN** the email provider fails with an error that contains the recipient address
- **THEN** that address appears in no exported signal and no error response

### Requirement: Password policy

Every password the system sets or changes (invitation acceptance, temporary
and bootstrap passwords, `/change-password`) MUST be NFC-normalized, and every
password verification MUST normalize the same way, inside the password hash and
verify functions themselves so that no entry point (sign-in, `/verify-password`,
`/two-factor/enable`, `/change-password`, `/two-factor/generate-backup-codes` or a
future one) can be missed, and then be 20 to 128 characters long (counted as Unicode code points), contain an upper-case letter, a lower-case
letter, a digit and a symbol, contain no control character, unpaired
surrogate or Unicode format character, and not appear on the bundled
common-password denylist. The breached-password check MUST see the NFC form, so the
password-bearing body fields are normalized before the check runs. A generated temporary password MUST satisfy the same
policy by construction (every character class is guaranteed, not left to chance), and MUST force a change at first sign-in and expire. A refusal MUST name only the failed rule and never
echo the password.

#### Scenario: A password verifies in any normalization form

- **GIVEN** a password set through acceptance
- **WHEN** it is presented in its decomposed (NFD) form at sign-in, `/verify-password`, `/two-factor/enable`, `/change-password` or `/two-factor/generate-backup-codes`
- **THEN** it verifies

#### Scenario: A breached password is refused in any normalization form

- **GIVEN** a password that appears in the Pwned Passwords corpus
- **WHEN** it is presented in its decomposed (NFD) form on acceptance or `/change-password`
- **THEN** it is refused, because the breach check sees the NFC form

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
- **THEN** the password is not set and the caller gets the sanitized generic server error, with no provider text

### Requirement: Identity procedures parse untrusted input strictly

Every procedure of the identity router MUST parse its input into a null-prototype
object, MUST reject `__proto__`, `constructor` and `prototype` at every depth, MUST
reject any field the procedure does not declare, and MUST enforce its length limits
before any lookup or database work.

#### Scenario: Hostile or oversized input is rejected before any work

- **WHEN** any procedure receives a body with a `__proto__`, `constructor` or `prototype` key at any depth, an undeclared field, or a value over its length limit
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` before any lookup, and nothing is created or changed

### Requirement: The hand-offs from the authentication baseline hold

Before the routes are mounted, the platform MUST refuse to start with `NODE_ENV=test`
and a non-local database host (the check lives in the application's startup path, not in
the configuration loader); the startup check of the runtime database roles MUST also fail
when a runtime role owns the machine-credential revocation table; the public re-authorization callback MUST be
rate-limited before it touches the database, and `reauthorization.start` MUST be
bounded per session; a back-channel logout token with neither `sid` nor `sub` MUST be
rejected without consuming its `jti`, and its cheap claim checks MUST run before any
outbound discovery or key fetch; the DAST API scan MUST fail when it sees no 2xx
operation response.

#### Scenario: A test environment cannot point at a remote database

- **WHEN** the platform starts with `NODE_ENV=test` and a non-local database host
- **THEN** startup fails

#### Scenario: A runtime role that owns the revocation table is refused at startup

- **WHEN** the platform starts, outside the test environment, with a runtime database role that owns `machine_credential_revocation`
- **THEN** startup fails with a fixed message that carries no connection detail

#### Scenario: A malformed logout token is cheap to refuse

- **WHEN** a back-channel logout token without `sid` and `sub` arrives
- **THEN** it is rejected, its `jti` is not consumed, and no discovery or key fetch happens

#### Scenario: The re-authorization callback is limited

- **WHEN** a caller exceeds the callback's limit
- **THEN** further requests are refused before any database access
