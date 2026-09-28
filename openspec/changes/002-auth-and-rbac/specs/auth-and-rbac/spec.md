# Spec Delta

## Purpose

Authenticates every human and machine caller of Tayzu, and authorizes every
catalog operation through Cerbos so that role, team ownership, and dynamic
attributes — never the caller's actor type — decide what an operation is
allowed to do.

## Conventions

- **New error codes**: `AUTH_FORBIDDEN` (403, Cerbos denied the action),
  `AUTH_STEP_UP_REQUIRED` (403, the action needs a fresh MFA verification, or
  a fresh Visma Connect re-authorization for a session it established),
  `AUTH_INVALID_CREDENTIALS` (401, the machine-token exchange rejected the
  client id/secret), `AUTH_RATE_LIMITED` (429), `AUTH_SSO_REJECTED` (401, a
  Visma Connect sign-in was rejected — for every possible cause: an unlinked
  account, a `state`/`nonce` mismatch, or an invalid token; the response
  never distinguishes which). A missing or invalid session/access token
  surfaces identically to catalog-core's `CATALOG_CONTEXT_REQUIRED`, because
  both mean "no valid context was established" — this capability does not
  introduce a second "unauthenticated" code.
- **Sign-in methods**: local email+password and Visma Connect SSO
  (`providerId: "visma-connect"`) both resolve to the same
  `{ tenantId, actor: { type: 'user', id } }` context shape; neither method
  is exclusive, and a user may have one or both linked to their account. A
  Tayzu user is linked to a Visma Connect account only by that account's
  immutable UserID (the ID token's `sub` claim), never by email — an email
  address is display data only, refreshed just-in-time from Visma Connect on
  each sign-in, and is never used to resolve, match, or create an account
  link.
- **Cerbos resource kinds**: `catalog_blueprint`, `catalog_entity` (carrying a
  `blueprintId` attribute for per-blueprint variation), `team`, `user`. Every
  principal and every resource carries `tenantId` as its first attribute.
- **Roles**, as Cerbos sees them, are data derived from Better Auth
  organization membership: `admin` (Better Auth `owner` or `admin`), `member`
  (Better Auth `member`). Moderator is not a role; it is derived from whether
  the resource's `blueprintId` appears in the principal's `moderatedBlueprints`
  attribute.
- **Step-up freshness**: an MFA verification is "fresh" for 5 minutes.
- **Machine access tokens** are valid for 1 hour from issuance and carry no
  refresh token; the client must re-exchange its client id/secret. A revoked
  credential's already-issued tokens MUST also stop working within a bounded
  revocation-check TTL (at most 5 seconds), not only at the next exchange
  attempt.

## ADDED Requirements

### Requirement: HTTP requests resolve to a catalog context or fail exactly like a missing context
Every HTTP-served catalog and auth-and-rbac procedure MUST accept exactly two
forms of caller credential: a Better Auth session cookie, or a machine access
token (`Authorization: Bearer`). A valid session cookie MUST resolve to
`{ tenantId: session.activeOrganizationId, actor: { type: 'user', id: user.id } }`.
A valid machine access token MUST resolve to
`{ tenantId, actor: { type: 'integration'|'agent', id } }` per the token's own
claims. A request with neither credential, a session with no active
organization, or an invalid or expired token MUST be rejected with the same
status and body as `CATALOG_CONTEXT_REQUIRED`. This resolution MUST run before
the catalog operation pipeline, and it MUST NOT read `tenantId` or `actor`
from the request body, path, or query string. It MUST also NOT read
`actor.onBehalfOf` from the request body, path, query string, or any header:
this capability does not accept a client-supplied attribution override, so a
request carrying such a value MUST have it ignored, not honored.

#### Scenario: Session cookie resolves a human context
- **GIVEN** a signed-in user with an active organization
- **WHEN** they call a catalog operation over HTTP
- **THEN** it runs with `actor.type` `user` and `tenantId` equal to their active organization

#### Scenario: Missing credential is rejected like a missing context
- **WHEN** a catalog operation is called over HTTP with no session cookie and no `Authorization` header
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: Session without an active organization is rejected
- **WHEN** a signed-in user with no active organization calls a catalog operation
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: Expired machine access token is rejected
- **WHEN** a catalog operation is called with an access token issued more than 1 hour ago
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: A client-supplied onBehalfOf value is ignored
- **GIVEN** a valid session cookie or machine access token
- **WHEN** the caller additionally supplies an `onBehalfOf` value in the request body, path, query string, or a header
- **THEN** the resolved context's `actor.onBehalfOf` is not set from that value, and the operation is attributed to the resolved actor alone

### Requirement: Only an allowlisted set of Better Auth routes is reachable over HTTP
`apps/api` mounts Better Auth's `/api/auth/*` catch-all handler behind a
Fastify route allowlist, deny by default. Every route the organization
plugin exposes for mutating organization membership (invite member, update
member role, remove member, set active organization, create organization,
delete organization) and every route the `apiKey` plugin exposes for
managing keys directly MUST NOT be reachable through this allowlist; a
request to any such route MUST receive the same `404` response as a request
to a path that does not exist. Every organization-membership or
machine-credential mutation this capability or a later change needs MUST
instead be exposed as a Cerbos-gated oRPC procedure that calls the
corresponding `auth.api.*` method in-process.

#### Scenario: A native organization-mutation route is not reachable
- **WHEN** a caller sends a request directly to Better Auth's native `inviteMember`, `updateMemberRole`, `removeMember`, or organization create/delete route
- **THEN** the response is `404`, identical to a request for a path that does not exist

#### Scenario: A native API-key management route is not reachable
- **WHEN** a caller sends a request directly to a Better Auth `apiKey` plugin route for creating, listing, or revoking a key
- **THEN** the response is `404`

#### Scenario: An unlisted Better Auth route fails the allowlist test
- **GIVEN** Better Auth's actual set of mounted `/api/auth/*` routes
- **WHEN** a route exists that the allowlist does not explicitly name
- **THEN** the allowlist test fails, rather than silently allowing or blocking it by default

### Requirement: Tenant-switch membership is independently re-verified
Setting a session's active organization MUST be rejected when the caller is
not a member of that organization. In addition to Better Auth's own
membership check on `setActiveOrganization`, `resolveContext()`'s
session-cookie branch MUST independently re-verify, via a membership-row
lookup, that `session.activeOrganizationId` names an organization the
session's user currently belongs to, using a cache no older than a few
seconds. A failed or unavailable re-verification MUST fail closed, with the
same status and body as `CATALOG_CONTEXT_REQUIRED`.

#### Scenario: Setting an active organization you are not a member of is rejected
- **GIVEN** a signed-in user who is not a member of organization `t2`
- **WHEN** they attempt to set their active organization to `t2`
- **THEN** the request is rejected and their active organization is unchanged

#### Scenario: Context resolution independently rejects a stale non-membership
- **GIVEN** a session whose `activeOrganizationId` names an organization the user is no longer a member of
- **WHEN** a catalog operation is called with that session
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

### Requirement: Session policy
A session MUST expire 7 days after its last use and MUST roll forward on use,
up to that 7-day cap. It MUST additionally expire after 12 hours of
inactivity, whichever limit is reached first. A password change MUST revoke
every other active session belonging to that user.

#### Scenario: Idle session expires after 12 hours
- **GIVEN** a session last used 13 hours ago, within its 7-day window
- **WHEN** it is used again
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: Active session rolls forward up to 7 days
- **GIVEN** a session used every day for 10 days
- **WHEN** it is used on day 10
- **THEN** it is still valid

#### Scenario: Password change revokes other sessions
- **GIVEN** a user signed in on two devices
- **WHEN** they change their password from the first device
- **THEN** the second device's session fails exactly as `CATALOG_CONTEXT_REQUIRED` on its next use

### Requirement: Visma Connect SSO sign-in
The system MUST let a human user sign in through Visma Connect (OIDC,
authorization code with PKCE) as an alternative to local email+password,
neither method excluding the other. A successful Visma Connect sign-in for a
`sub` already linked to a Tayzu user MUST resolve to that user's context. A
Visma Connect sign-in for a `sub` with no linked Tayzu user MUST be rejected
with `AUTH_SSO_REJECTED`, and MUST NOT create a new user account under any
circumstance. Every rejection of this flow — an unlinked account, a `state`
or `nonce` mismatch, or an invalid or unverifiable token — MUST return the
same status, error code, and body shape, regardless of cause.

#### Scenario: Sign-in with a linked Visma Connect account succeeds
- **GIVEN** a Tayzu user whose account is linked to a Visma Connect `sub`
- **WHEN** that person completes sign-in through Visma Connect
- **THEN** it resolves to `actor.type` `user` for the linked Tayzu user

#### Scenario: Sign-in with an unlinked Visma Connect account is rejected generically
- **GIVEN** a Visma Connect `sub` with no linked Tayzu user
- **WHEN** that person completes sign-in through Visma Connect
- **THEN** it fails with `AUTH_SSO_REJECTED`, and no user account is created

#### Scenario: A mismatched state value is rejected the same way as an unlinked account
- **GIVEN** a Visma Connect callback whose `state` does not match the value the sign-in was initiated with
- **WHEN** the callback is processed
- **THEN** it fails with the same `AUTH_SSO_REJECTED` status, error code, and body shape as an unlinked account

### Requirement: Account linking to Visma Connect is explicit and keyed on the Visma Connect UserID
Linking a Tayzu user to a Visma Connect account MUST happen only through one
of two explicit paths: a user, signed in locally, linking their own account;
or an org admin recording a user's Visma Connect UserID on that user's
account. Neither path, nor any sign-in flow, MUST link or match an account by
email. The link MUST be keyed on the Visma Connect account's immutable
UserID. Linking from an authenticated session MUST require a fresh MFA
verification when the caller has an enrolled MFA factor. An admin MUST be
able to unlink an account. Neither linking nor unlinking MUST be permitted to
leave a user with no sign-in method at all.

#### Scenario: A signed-in user links their own Visma Connect account
- **GIVEN** a user signed in locally with a fresh MFA verification
- **WHEN** they link their Visma Connect account
- **THEN** their account is linked, keyed on the Visma Connect UserID

#### Scenario: Linking without a fresh MFA verification is blocked for an MFA-enrolled user
- **GIVEN** a user signed in locally with an enrolled MFA factor but no fresh verification
- **WHEN** they attempt to link their Visma Connect account
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED`

#### Scenario: An admin records a user's Visma Connect UserID
- **GIVEN** a caller with the `admin` role
- **WHEN** they record a Visma Connect UserID on another user's account
- **THEN** that account is linked, keyed on the Visma Connect UserID, and the action is audited

#### Scenario: Unlinking the only sign-in method is rejected
- **GIVEN** a user whose only sign-in method is their linked Visma Connect account, with no password set
- **WHEN** an admin attempts to unlink it
- **THEN** the request is rejected and the account remains linked

### Requirement: Display data from Visma Connect is refreshed just-in-time and never used as an identity key
On every successful Visma Connect sign-in, the linked user's display name and
email MUST be refreshed from Visma Connect's current profile data. This
refreshed email MUST be stored and used only as display data; it MUST NOT
become or replace the value used to resolve which account signed in, and it
MUST NOT be used for local email+password sign-in identity resolution.

#### Scenario: Display name and email are refreshed on sign-in
- **GIVEN** a linked user whose name at Visma Connect has changed since their last sign-in
- **WHEN** they sign in through Visma Connect again
- **THEN** their Tayzu display name reflects the new value

#### Scenario: A changed Visma Connect email does not alter local sign-in identity
- **GIVEN** a user with both a local password and a linked Visma Connect account
- **WHEN** their email at Visma Connect changes and they sign in through Visma Connect
- **THEN** their local email+password sign-in identity is unchanged

### Requirement: Back-channel logout from Visma Connect revokes the matching sessions
The system MUST expose a public endpoint that accepts a Visma Connect
back-channel logout token, validates it per the OIDC Back-Channel Logout
specification (signature, issuer, audience, expiry, event type, absence of a
`nonce` claim, and replay protection on the token's unique id), and revokes
every Tayzu session established through Visma Connect that matches the
token's session id or subject. A token that fails validation, or a replayed
token, MUST NOT revoke any session. This endpoint's response MUST NOT reveal
whether a matching session existed.

#### Scenario: A valid logout token revokes the matching session
- **GIVEN** an active Tayzu session established through Visma Connect
- **WHEN** a valid back-channel logout token naming that session's Visma Connect session id is received
- **THEN** that session fails exactly as `CATALOG_CONTEXT_REQUIRED` on its next use

#### Scenario: A replayed logout token is rejected without revoking anything twice
- **GIVEN** a back-channel logout token already processed once
- **WHEN** the same token is received again
- **THEN** it is rejected as a replay and no further session state changes

#### Scenario: An invalid signature is rejected without revealing session existence
- **GIVEN** a logout token with an invalid signature
- **WHEN** it is received
- **THEN** it is rejected, and the response is identical in shape to a valid token naming a session that does not exist

### Requirement: Multi-factor authentication
The system MUST let a human user enroll a TOTP factor and generate backup
codes. Once a factor is enrolled, sign-in MUST require a valid TOTP code or an
unused backup code in addition to the password. A user with no enrolled
factor MUST be able to sign in with password alone. A backup code MUST NOT be
usable more than once.

#### Scenario: Enrolled user must supply a TOTP code to sign in
- **GIVEN** a user has enrolled a TOTP factor
- **WHEN** they sign in with the correct password but no TOTP code
- **THEN** sign-in does not complete and a TOTP code is requested

#### Scenario: Backup code is single-use
- **GIVEN** a user has an unused backup code
- **WHEN** they sign in with it once, then attempt to sign in with it again
- **THEN** the first attempt succeeds and the second is rejected

#### Scenario: Unenrolled user signs in with password alone
- **GIVEN** a user has no enrolled MFA factor
- **WHEN** they sign in with the correct password
- **THEN** sign-in completes with no additional factor requested

### Requirement: Authentication responses resist account enumeration
Sign-in responses MUST NOT reveal whether an email address has an account. A
failed sign-in MUST return the same status, error code, and body shape
whether the account does not exist, the password is wrong, or the account is
disabled. There is no sign-up surface to protect (see "Public self sign-up is
not available"). A forgot-password/account-recovery flow is out of scope for
this capability (deferred to `044-password-reset-and-account-recovery`); this
requirement covers only the sign-in surface this capability ships.

#### Scenario: Sign-in failure looks the same for an unknown account and a wrong password
- **GIVEN** one email with no account and one email with an account and a known password
- **WHEN** sign-in is attempted for the first with any password, and for the second with the wrong password
- **THEN** both attempts fail with the same status, error code, and body shape

### Requirement: Public self sign-up is not available
Sign-up MUST be disabled under every circumstance, over HTTP and in-process
alike. A Tayzu user account MUST be created only by an organization admin
through a Cerbos-gated procedure, or by a one-time bootstrap script creating
an organization's first admin. Neither path MUST send the new user's
credential anywhere other than the creating admin's or operator's own
response/output; there is no invitation email in this capability (invitations
are `043-identity-lifecycle-and-org-admin`'s).

#### Scenario: Self sign-up is not available
- **WHEN** a request is sent to Better Auth's sign-up route over HTTP
- **THEN** it fails with the same `404` response as a request to a path that does not exist

#### Scenario: In-process sign-up is refused
- **WHEN** the sign-up handler is invoked in-process, bypassing HTTP entirely
- **THEN** it is refused and no user account is created

#### Scenario: An org admin can create a user
- **GIVEN** a caller with the `admin` role
- **WHEN** they create a user with an email and a fixed actor kind
- **THEN** a Tayzu user account exists, and a temporary credential is returned once in the response

#### Scenario: A member cannot create a user
- **GIVEN** a caller with only the `member` role
- **WHEN** they attempt to create a user
- **THEN** it fails with `AUTH_FORBIDDEN`

#### Scenario: Bootstrapping an organization's first admin is idempotent
- **GIVEN** an organization that has already been bootstrapped with a first admin
- **WHEN** the bootstrap script is run again for that same organization
- **THEN** no duplicate organization or user is created

### Requirement: Pre-authentication rate limiting protects against credential stuffing
Sign-in, two-factor verification, and any sign-up or email-verification route
MUST be rate-limited before a caller is authenticated, keyed by both the
caller's IP address and a normalized form of the submitted email, using
storage shared across every running replica. `POST /v1/auth/token` MUST be
separately rate-limited, keyed by both the caller's IP address and the
submitted client id, independent of the per-authenticated-actor rate limit
this capability also has. Exceeding any of these limits MUST fail with
`AUTH_RATE_LIMITED` and a `Retry-After` header, and MUST NOT reveal whether
the underlying account or credential exists. Every rate-limit rejection MUST
be recorded as a security log event and a metric, neither of which carries
the caller's IP address or email.

#### Scenario: Repeated failed sign-ins from the same source are rate-limited
- **GIVEN** a caller who has exceeded the configured sign-in attempt limit for their IP and email
- **WHEN** they attempt to sign in again
- **THEN** it fails with `AUTH_RATE_LIMITED` and a `Retry-After` header, and the `auth.security.rate_limited` event is logged

#### Scenario: Machine token exchange is rate-limited independently of the authenticated bucket
- **GIVEN** a caller who has exceeded the configured attempt limit for `POST /v1/auth/token` keyed by their IP and client id
- **WHEN** they attempt another token exchange
- **THEN** it fails with `AUTH_RATE_LIMITED`, regardless of any authenticated-actor rate-limit bucket's state

### Requirement: Step-up authentication for high-risk operations
An operation whose OpenAPI route carries `x-tayzu-risk: high`, when invoked by
a `user` actor, MUST additionally require an MFA verification fresh within
the threshold in Conventions. Without one, it MUST fail with
`AUTH_STEP_UP_REQUIRED` and MUST NOT perform the operation. This requirement
applies only to human (`user`) callers; `agent`, `integration`, and `system`
actors are governed by Cerbos policy alone. For a session established
through Visma Connect, freshness MUST instead be established by a Visma
Connect re-authorization requesting its MFA authentication context, with the
returned token's authentication time, context class, and method claims
validated by the server — a client-stripped or otherwise unvalidated
re-authorization request MUST NOT satisfy this requirement.

#### Scenario: A fresh Visma Connect re-authorization with an MFA method satisfies step-up
- **GIVEN** a user whose session was established through Visma Connect, re-authorizing with an MFA method within the freshness threshold
- **WHEN** they call `blueprints.delete`
- **THEN** the deletion proceeds

#### Scenario: A Visma Connect re-authorization without a qualifying MFA claim does not satisfy step-up
- **GIVEN** a user whose session was established through Visma Connect, completing a re-authorization whose returned claims do not include a qualifying MFA method or authentication context level
- **WHEN** they call `blueprints.delete`
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED` and the blueprint is not deleted

#### Scenario: High-risk operation without a fresh MFA verification is blocked
- **GIVEN** a user signed in without verifying MFA in the last 5 minutes
- **WHEN** they call `blueprints.delete`
- **THEN** it fails with `AUTH_STEP_UP_REQUIRED` and the blueprint is not deleted

#### Scenario: High-risk operation with a fresh MFA verification succeeds
- **GIVEN** a user verified an MFA factor 1 minute ago
- **WHEN** they call `blueprints.delete` on an otherwise-deletable blueprint
- **THEN** the deletion proceeds

#### Scenario: High-risk operation by an integration actor is not gated by step-up
- **GIVEN** an `integration` actor authorized by Cerbos to delete a blueprint
- **WHEN** it calls `blueprints.delete`
- **THEN** the deletion proceeds without any step-up check

### Requirement: Machine credentials
The system MUST let an organization admin create a named machine credential
of a fixed kind (`integration` or `agent`, chosen at creation): a client id
and a client secret, generated once, returned only in the creation response,
and stored hashed thereafter. The admin MUST be able to revoke a credential;
there is no in-place rotation, only revoke-and-recreate. `POST /v1/auth/token`
with a valid, non-revoked client id and its matching secret MUST return an
access token valid for 1 hour and MUST NOT return a refresh token. An invalid
or revoked credential MUST fail with `AUTH_INVALID_CREDENTIALS`. Revoking a
credential MUST also take effect against any access token already issued
from it, within a bounded revocation-check TTL of at most 5 seconds — a
still-unexpired token from a revoked credential MUST be rejected once that
TTL has elapsed, exactly as `CATALOG_CONTEXT_REQUIRED`. A revocation-check
failure (the revocation list is unreachable) MUST fail closed, rejecting the
token, never treating an unreachable check as "not revoked."

#### Scenario: Valid client id and secret exchange for an access token
- **GIVEN** an active `integration`-kind machine credential
- **WHEN** its client id and secret are posted to `POST /v1/auth/token`
- **THEN** an access token is returned that resolves to `actor.type` `integration`

#### Scenario: Revoked credential is rejected
- **GIVEN** a machine credential that has been revoked
- **WHEN** its client id and secret are posted to `POST /v1/auth/token`
- **THEN** it fails with `AUTH_INVALID_CREDENTIALS`

#### Scenario: Wrong secret is rejected
- **WHEN** a valid client id is posted with an incorrect secret
- **THEN** it fails with `AUTH_INVALID_CREDENTIALS`

#### Scenario: Credential is shown only once
- **WHEN** a machine credential is created
- **THEN** its secret appears in the creation response and in no later read of that credential

#### Scenario: Access token expires after 1 hour
- **GIVEN** an access token issued at time `T`
- **WHEN** it is used at `T` + 61 minutes
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: A token issued before revocation is rejected within the revocation TTL
- **GIVEN** an access token issued from an active machine credential, still within its 1-hour lifetime
- **WHEN** an admin revokes the credential, and the token is used again after the revocation-check TTL has elapsed
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

### Requirement: Tenant isolation is enforced by the database independent of application code
Every catalog table MUST have row-level security enabled and forced, with a
policy that permits a row only when its `tenant_id` matches the
session-local `app.tenant_id` setting. The runtime database role MUST NOT
hold the bypass-RLS attribute, MUST NOT own the tables it operates on, and
MUST NOT hold `UPDATE`, `DELETE`, or `TRUNCATE` on `catalog_change_event`. A
query executed with no `app.tenant_id` set MUST return zero rows on read and
affect zero rows on write, never an error.

#### Scenario: Query without a tenant setting sees no rows
- **GIVEN** catalog tables containing data for tenant `t1`
- **WHEN** a query runs as the runtime role with `app.tenant_id` unset
- **THEN** it returns zero rows and, if a write, affects zero rows

#### Scenario: Runtime role cannot alter the change-event log
- **WHEN** the runtime role attempts `UPDATE`, `DELETE`, or `TRUNCATE` on `catalog_change_event`
- **THEN** Postgres rejects the statement on privilege grounds

#### Scenario: Runtime role cannot bypass row-level security
- **GIVEN** a row belonging to tenant `t2`
- **WHEN** the runtime role queries with `app.tenant_id` set to `t1`
- **THEN** the `t2` row is not returned, even by a query with no `tenant_id` predicate of its own

### Requirement: Authorization is decided by Cerbos and fails closed
Every catalog and auth-and-rbac mutation and read MUST be checked against
Cerbos before it runs, using the resource kind, action, and attributes for
that operation, with `tenantId` as the first-checked attribute. An action
with no matching Cerbos rule MUST be denied. A Cerbos evaluation error MUST
also deny the action, never allow it. A denied check MUST fail with
`AUTH_FORBIDDEN`, which MUST be distinguishable from `CATALOG_NOT_FOUND`: a
deny inside the caller's own tenant is not the same outcome as a cross-tenant
lookup. Listing operations MUST use Cerbos's query-plan API to push the
authorization filter into the database query, in addition to, never instead
of, the tenant scope.

#### Scenario: Action with no matching rule is denied
- **GIVEN** a resource kind and action with no rule granting it to the caller's role
- **WHEN** the caller attempts that action
- **THEN** it fails with `AUTH_FORBIDDEN`

#### Scenario: Cerbos evaluation error denies rather than allows
- **GIVEN** a policy condition that raises an evaluation error for this request
- **WHEN** the action is checked
- **THEN** it fails with `AUTH_FORBIDDEN`

#### Scenario: Denied action is distinct from not found
- **GIVEN** entity `payments` exists in the caller's own tenant but the caller's role does not permit reading it
- **WHEN** the caller gets `payments`
- **THEN** it fails with `AUTH_FORBIDDEN`, not `CATALOG_NOT_FOUND`

#### Scenario: List results are filtered by the query plan, not by scanning and checking
- **GIVEN** a tenant with entities the caller may and may not read
- **WHEN** the caller lists entities of that blueprint
- **THEN** only the entities the query plan admits are returned, and the database query carries the authorization filter

### Requirement: Three-tier role baseline
The system MUST recognize two Cerbos roles derived from Better Auth
organization membership: `admin` (organization `owner` or `admin`) and
`member` (organization `member`). An `admin` MUST be permitted every catalog
and auth-and-rbac action within their own tenant. A `member` MUST be
permitted to read every blueprint and entity and to create and update
entities, but MUST NOT be permitted to create, update, or delete blueprints,
invite users, or manage machine credentials, except where a Moderator grant
or team ownership additionally permits an entity-level action.

#### Scenario: Admin can manage blueprints
- **GIVEN** a caller with the `admin` role
- **WHEN** they create, update, or delete a blueprint
- **THEN** the action is permitted

#### Scenario: Member cannot manage blueprints
- **GIVEN** a caller with only the `member` role
- **WHEN** they attempt to create, update, or delete a blueprint
- **THEN** it fails with `AUTH_FORBIDDEN`

#### Scenario: Member can create and update entities
- **GIVEN** a caller with only the `member` role
- **WHEN** they create or update an entity of an existing blueprint
- **THEN** the action is permitted

### Requirement: Moderator grant
An admin MUST be able to grant a user Moderator status over one or more
specific blueprints, recorded on that user's `_user` entity's
`moderatedBlueprints` list. A user with a Moderator grant over a blueprint
MUST be permitted every entity-level action on that blueprint's entities, in
addition to whatever their base role already permits, regardless of team
ownership.

#### Scenario: Moderator can update entities of a moderated blueprint
- **GIVEN** a `member` whose `moderatedBlueprints` includes `service`
- **WHEN** they update an entity of blueprint `service` owned by a team they do not belong to
- **THEN** the action is permitted

#### Scenario: Moderator has no extra permission on a non-moderated blueprint
- **GIVEN** a `member` whose `moderatedBlueprints` includes `service` only
- **WHEN** they update an entity of blueprint `deployment`, which they do not moderate and do not own
- **THEN** it fails with `AUTH_FORBIDDEN`

### Requirement: Team ownership
An entity's owning team MUST resolve to exactly one of: no ownership
(`None`), a team recorded directly on the entity (`Direct`), or a team
inherited along a designated relation chain declared on the entity's
blueprint (`Inherited`). Configuring both `Inherited` ownership and a direct
team relation on the same blueprint MUST make `Direct` win silently: the
direct relation is kept and inherited ownership is dropped. A member of an
entity's owning team MUST be permitted to read and update that entity even
without a Moderator grant. Creating an entity owned by a team MUST be
permitted only if the creating member is themselves a member of that team.

#### Scenario: Owning team member can update an owned entity
- **GIVEN** entity `payments` is directly owned by team `platform`
- **WHEN** a `member` of `platform` updates `payments`
- **THEN** the action is permitted

#### Scenario: Non-owning member cannot update another team's entity
- **GIVEN** entity `payments` is directly owned by team `platform`
- **WHEN** a `member` who does not belong to `platform` and has no Moderator grant updates `payments`
- **THEN** it fails with `AUTH_FORBIDDEN`

#### Scenario: Direct ownership wins over a conflicting inherited configuration
- **GIVEN** a blueprint configured with both `Inherited` ownership and a direct team relation
- **WHEN** an entity of that blueprint is read
- **THEN** its owning team is the one from the direct relation, and inherited ownership plays no part

#### Scenario: Creating an entity owned by a team the caller does not belong to is denied
- **GIVEN** a `member` who does not belong to team `platform`
- **WHEN** they create an entity directly owned by `platform`
- **THEN** it fails with `AUTH_FORBIDDEN`

### Requirement: Dynamic attribute-based access control
The system MUST let a tenant admin express an authorization rule over
attributes already available to Cerbos — for example the requesting user's
own `_user` properties, or an entity's `spec` properties — without deploying
a new Cerbos resource kind or a policy file per blueprint. Such a rule MUST
be evaluated in addition to, never in place of, the role and ownership checks
above; it MUST NOT be able to grant an action that a static resource policy
does not also permit for at least one matching principal shape.

#### Scenario: Attribute-based rule grants access a role alone would not
- **GIVEN** a rule permitting `read` on entities where `resource.region == principal.region`
- **WHEN** a `member` whose `region` attribute matches the entity's `region` reads it
- **THEN** the read is permitted even though no role or ownership grant applies

#### Scenario: Attribute-based rule denies access a role alone would have granted
- **GIVEN** the same rule as above
- **WHEN** a `member` whose `region` attribute does not match reads that entity
- **THEN** it fails with `AUTH_FORBIDDEN`

### Requirement: User and Team system blueprints
The `_user` and `_team` system blueprints MUST exist in every tenant, created
by the `system` actor per catalog-core's reserved-identifier rule. `_user`
MUST carry at least `identifier` (the user's email), `title` (the user's
name), `status` (`Active` or `Disabled`, at minimum — the full lifecycle is
`043-identity-lifecycle-and-org-admin`), `portRole` (`admin` or `member`),
and `moderatedBlueprints`. `_team` MUST carry at least `identifier` and
`title`. An admin-created user, a bootstrap-created first admin, a role
change, or a ban/unban event MUST upsert the matching `_user` entity through
the `system` actor path. No actor other than `system` MUST be able to write
`_user` or `_team` entities directly.

#### Scenario: Creating a user creates a matching `_user` entity
- **WHEN** an org admin creates a new user, or the bootstrap script creates an organization's first admin
- **THEN** a `_user` entity exists for them with `status` `Active`

#### Scenario: Disabling a user updates its `_user` entity status
- **WHEN** an admin bans a user
- **THEN** that user's `_user` entity `status` becomes `Disabled`

#### Scenario: Direct write to `_user` by a non-system actor is rejected
- **WHEN** a `user` or `agent` actor attempts to upsert a `_user` entity directly through the catalog API
- **THEN** it fails with `CATALOG_RESERVED_IDENTIFIER`

### Requirement: Authorization decisions are auditable
Every Cerbos deny and every step-up requirement MUST be recorded as a
security log event, distinguishable from a catalog validation error,
carrying the tenant, actor, resource kind, and action, and never the
entity's title, description, or property values.

#### Scenario: A denied action is logged as a security event
- **WHEN** an action is denied by Cerbos
- **THEN** a security log event records the tenant, actor, resource kind, and action, with no entity property values

#### Scenario: A step-up requirement is logged as a security event
- **WHEN** an action fails with `AUTH_STEP_UP_REQUIRED`
- **THEN** a security log event records the tenant, actor, and the operation name
