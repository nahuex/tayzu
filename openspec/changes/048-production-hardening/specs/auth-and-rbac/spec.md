## ADDED Requirements

### Requirement: The client address comes only from trusted proxy hops

The address that every per-address rate limit, cap and security check keys on MUST be
derived from a forwarded header only within a configured number of proxy hops, and only
while each trusted hop's peer address lies inside a configured list of network ranges. A
forwarded address supplied by a peer outside those ranges, or beyond the configured hop
count, MUST be ignored, and the connection's own peer address MUST be used instead. The
hop count and the ranges MUST come from the trusted host's configuration, and outside the
test environment the platform MUST refuse to start when either is missing or malformed,
with an error that names only the variable. IPv4-mapped IPv6 peer addresses MUST be
compared as their IPv4 form.

#### Scenario: A spoofed forwarded address from an untrusted peer is ignored

- **GIVEN** the platform trusts one hop from the range `10.0.0.0/16`
- **WHEN** a request arrives from the peer `203.0.113.7` with `X-Forwarded-For: 198.51.100.1`
- **THEN** the request is keyed on `203.0.113.7`, so exhausting a per-address limit with varying forwarded values still limits that peer

#### Scenario: A forwarded address from the trusted ingress is used

- **GIVEN** the platform trusts one hop from the range `10.0.0.0/16`
- **WHEN** a request arrives from the peer `10.0.4.2` with `X-Forwarded-For: 198.51.100.1`
- **THEN** the request is keyed on `198.51.100.1`

#### Scenario: Extra hops beyond the configured count are not trusted

- **GIVEN** the platform trusts one hop from the range `10.0.0.0/16`
- **WHEN** a request arrives from the peer `10.0.4.2` with `X-Forwarded-For: 198.51.100.9, 10.0.4.3, 198.51.100.1`
- **THEN** the request is keyed on `198.51.100.1`, the right-most forwarded value, and never on an address further left

#### Scenario: Startup fails without the proxy trust outside the test environment

- **WHEN** the platform starts with `NODE_ENV` other than `test` and without the hop count or the ranges, or with a malformed range
- **THEN** startup fails with a message that names only the variable

### Requirement: Schema migrations run only as the migration role

The migration command MUST read its connection string only from a variable of its own,
distinct from every runtime role's variable, and MUST NOT fall back to any other variable
when it is unset. Before it applies any migration, it MUST refuse to run, with a fixed
message that names no role, user or host, when it is connected as any runtime database
role of the platform. Its TLS requirement MUST hold as for every other connection, and an
error about that requirement MUST name the variable that held the connection string.

#### Scenario: The migration command needs its own variable

- **GIVEN** the migration role's variable is unset and the runtime role's variable is set
- **WHEN** the migration command runs
- **THEN** it fails before connecting, with a message that names only the migration role's variable

#### Scenario: The migration command refuses a runtime role

- **WHEN** the migration command is given a connection string for any runtime database role
- **THEN** it applies nothing and fails with a fixed message that names no role, user or host

#### Scenario: A TLS error names the variable it was given

- **WHEN** the migration command is given a non-local connection string without verified TLS
- **THEN** it fails before connecting, and the message names the migration role's variable, not the runtime one

### Requirement: The public origin is checked at startup

The origin of the authentication base URL MUST be one of the allowed origins; when it is
set and its origin is not in the allowed list, the platform MUST refuse to start with a
message that names only the two variables and no value.

#### Scenario: An authentication base URL outside the allowed origins is refused

- **WHEN** the platform starts with an authentication base URL whose origin is not in the allowed origins
- **THEN** startup fails, and the message names the two variables and no value

### Requirement: Authentication secrets are versioned and come only from the host

The authentication secret MUST be a versioned list, each entry a non-negative version and
a value of at least 32 characters, with unique versions, the first entry being the current
one, read only from the trusted host's configuration and passed to the authentication
library explicitly, so that no ambient environment variable can add, replace or remove a
key. The retired single-secret variable MUST be refused at startup when it is set. Data
the library encrypts (second-factor secrets, backup codes, provider tokens and the token
signing key) MUST stay readable after a new version becomes current while the earlier
version is still listed. A malformed list MUST fail startup with a message that names only
the variable.

#### Scenario: Encrypted data survives a rotation

- **GIVEN** a user whose TOTP factor was enrolled while version `1` was current
- **WHEN** the platform restarts with version `2` current and version `1` still listed
- **THEN** that user's TOTP code still verifies at sign-in

#### Scenario: An ambient variable cannot change the keys

- **GIVEN** the platform's configured list holds version `1` only
- **WHEN** the process environment also carries another versioned list or the retired single secret
- **THEN** the authentication instance uses exactly the configured keys

#### Scenario: The retired variable is refused

- **WHEN** the platform starts with the retired single-secret variable set
- **THEN** startup fails, naming only that variable

#### Scenario: A malformed list is refused

- **WHEN** the list has a duplicated version, a negative or non-numeric version, an entry without a value, or a value under 32 characters
- **THEN** startup fails with a message that names only the variable and no value

## MODIFIED Requirements

### Requirement: Tenant-switch membership is independently re-verified
Setting a session's active organization MUST be rejected when the caller is
not a member of that organization. In addition to Better Auth's own
membership check on `setActiveOrganization`, `resolveContext()`'s
session-cookie branch MUST independently re-verify, via a membership-row
lookup, that `session.activeOrganizationId` names an organization the
session's user currently belongs to, using a cache no older than a few
seconds. A failed or unavailable re-verification MUST fail closed, with the
same status and body as `CATALOG_CONTEXT_REQUIRED`. Every rejected attempt to
set the active organization MUST be logged as a security event and counted,
carrying the caller's opaque user id and a fixed outcome, and never the
organization id the caller supplied.

#### Scenario: Setting an active organization you are not a member of is rejected
- **GIVEN** a signed-in user who is not a member of organization `t2`
- **WHEN** they attempt to set their active organization to `t2`
- **THEN** the request is rejected and their active organization is unchanged

#### Scenario: Context resolution independently rejects a stale non-membership
- **GIVEN** a session whose `activeOrganizationId` names an organization the user is no longer a member of
- **WHEN** a catalog operation is called with that session
- **THEN** it fails exactly as `CATALOG_CONTEXT_REQUIRED`

#### Scenario: A rejected tenant switch is logged without the supplied organization
- **GIVEN** a signed-in user who is not a member of organization `t2`
- **WHEN** they attempt to set their active organization to `t2`
- **THEN** `auth.security.active_organization_rejected` is logged with the user's opaque id and a fixed outcome, the session-event counter records the rejection, and `t2` appears in no exported signal

### Requirement: Back-channel logout from Visma Connect revokes the matching sessions
The system MUST expose a public endpoint that accepts a Visma Connect
back-channel logout token, validates it per the OIDC Back-Channel Logout
specification (signature, issuer, audience, expiry, event type, absence of a
`nonce` claim, and replay protection on the token's unique id), and revokes
every Tayzu session established through Visma Connect that matches the
token's session id or subject. A token that fails validation, or a replayed
token, MUST NOT revoke any session. This endpoint's response MUST NOT reveal
whether a matching session existed. The replay record MUST be enforced by a
database uniqueness constraint, not by a check followed by an insert, and the
replay record and the session revocation MUST commit together or not at all.
A token whose lifetime (`exp` minus `iat`) exceeds the platform's bound MUST be
rejected. The provider's discovery document and signing keys MUST be cached
for a bounded time; when they are neither cached nor retrievable, the token
MUST be rejected, never accepted.

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

#### Scenario: Concurrent deliveries of one token are processed once
- **GIVEN** a valid logout token
- **WHEN** it is delivered twice at the same time
- **THEN** exactly one delivery records it and revokes the matching sessions, and the other is a replay

#### Scenario: A failed revocation does not consume the token
- **GIVEN** a valid logout token whose session revocation fails after the replay record was written
- **WHEN** the same token is delivered again
- **THEN** the second delivery is not a replay and revokes the matching sessions

#### Scenario: A long-lived logout token is rejected
- **WHEN** a logout token whose `exp` is further from its `iat` than the platform's bound is received
- **THEN** it is rejected, its `jti` is not recorded and no session is revoked

#### Scenario: Unavailable signing keys fail closed
- **GIVEN** no cached discovery document or key set, and a provider that cannot be reached
- **WHEN** a logout token is received
- **THEN** it is rejected and no session is revoked

### Requirement: Pre-authentication rate limiting protects against credential stuffing
Sign-in, two-factor verification, and any sign-up or email-verification route
MUST be rate-limited before a caller is authenticated, keyed by both the
caller's IP address and a normalized form of the submitted email, using
storage shared across every running replica. `POST /v1/auth/token` MUST be
separately rate-limited, keyed by both the caller's IP address and the
submitted client id, each in its own bucket of the same shared storage,
independent of the per-authenticated-actor rate limit this capability also
has; a varying client id MUST NOT open a fresh address bucket. The
back-channel logout endpoint MUST be limited per caller address in the same
shared storage. The per-authenticated-actor limit MAY be counted per replica,
and its budget MUST then be documented as a per-replica budget. Exceeding any
of these limits MUST fail with `AUTH_RATE_LIMITED` and a `Retry-After` header,
and MUST NOT reveal whether the underlying account or credential exists. Every
rate-limit rejection MUST be recorded as a security log event and a metric,
neither of which carries the caller's IP address, email or client id.

#### Scenario: Repeated failed sign-ins from the same source are rate-limited
- **GIVEN** a caller who has exceeded the configured sign-in attempt limit for their IP and email
- **WHEN** they attempt to sign in again
- **THEN** it fails with `AUTH_RATE_LIMITED` and a `Retry-After` header, and the `auth.security.rate_limited` event is logged

#### Scenario: Machine token exchange is rate-limited independently of the authenticated bucket
- **GIVEN** a caller who has exceeded the configured attempt limit for `POST /v1/auth/token` keyed by their IP and client id
- **WHEN** they attempt another token exchange
- **THEN** it fails with `AUTH_RATE_LIMITED`, regardless of any authenticated-actor rate-limit bucket's state

#### Scenario: The token-exchange budget is shared across replicas
- **GIVEN** two running replicas over the same database
- **WHEN** one caller address spends half of the token-exchange limit on each replica
- **THEN** its next exchange on either replica fails with `AUTH_RATE_LIMITED`

#### Scenario: One client id is limited across addresses
- **WHEN** one client id is submitted from many addresses beyond its own limit
- **THEN** further exchanges for that client id fail with `AUTH_RATE_LIMITED`, and the client id reaches no signal

#### Scenario: The back-channel logout budget is shared across replicas
- **GIVEN** two running replicas over the same database
- **WHEN** one caller address exceeds the back-channel logout limit across both
- **THEN** further deliveries from it fail with `AUTH_RATE_LIMITED` before any token is verified

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
re-authorization request MUST NOT satisfy this requirement. The
re-authorization MUST be bound to the browser session that started it: its
request MUST carry a single-use `state`, a fresh unguessable `nonce` and
`response_mode=query`; its callback MUST accept only a top-level `GET`, MUST
require the session cookie of the session that started it, compared in
constant time, and MUST verify that the returned ID token carries the same
`nonce` before any result is stored. A callback without that cookie, with
another session's cookie, or with a token whose `nonce` differs MUST store no
result, MUST be logged as a re-authorization failure with a bounded reason,
and MUST answer exactly as any other failed callback.

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

#### Scenario: The re-authorization request is bound to the browser
- **WHEN** a Visma Connect session starts a re-authorization
- **THEN** the authorization URL carries a single-use `state`, a `nonce` of at least 256 bits that no other start returned, and `response_mode=query`

#### Scenario: A callback in another browser stores nothing
- **GIVEN** a re-authorization started by session `A`
- **WHEN** its callback arrives with no session cookie, or with the cookie of session `B`
- **THEN** no result is stored for either session, the failure is logged with the reason `session_mismatch`, and the answer is the same as for any failed callback

#### Scenario: A token with another nonce stores nothing
- **GIVEN** a re-authorization started by a session that holds its cookie at the callback
- **WHEN** the returned ID token's `nonce` differs from the one the start sent
- **THEN** no result is stored and the next high-risk call still fails with `AUTH_STEP_UP_REQUIRED`

#### Scenario: A form-posted callback is not accepted
- **WHEN** a `POST` with a code and a state arrives at the re-authorization callback path
- **THEN** no code is exchanged and no result is stored

### Requirement: Authorization decisions are auditable
Every Cerbos deny and every step-up requirement MUST be recorded as a
security log event, distinguishable from a catalog validation error,
carrying the tenant, actor, resource kind, and action, and never the
entity's title, description, or property values. In production, the
authorization engine's own decision log MUST be written to standard output,
so that it is collected with the platform's other logs, from a production
configuration that differs from the reviewed local configuration only in the
audit backend. The principal and resource attributes the platform sends to
the authorization engine MUST be a closed, declared set of keys whose values
are identifiers, roles and enumerated flags, never tenant free text. A
caller-supplied resource identifier, blueprint or owner team that does not
match its identifier pattern MUST be replaced with a fixed placeholder
before the authorization engine is called, so that it never reaches the
decision log; the placeholder matches no grant, and the operation's answer
is unchanged.

#### Scenario: A denied action is logged as a security event
- **WHEN** an action is denied by Cerbos
- **THEN** a security log event records the tenant, actor, resource kind, and action, with no entity property values

#### Scenario: A step-up requirement is logged as a security event
- **WHEN** an action fails with `AUTH_STEP_UP_REQUIRED`
- **THEN** a security log event records the tenant, actor, and the operation name

#### Scenario: The production engine configuration exports the decision log
- **WHEN** the production and the local engine configurations are compared
- **THEN** they are equal except for the audit backend, and the production one writes decision logs to standard output with access logs off

#### Scenario: The decision log carries no tenant free text
- **GIVEN** an entity whose title, description and properties hold a marker string
- **WHEN** it is created, read, updated and deleted through the catalog, and an identity operation targets a user
- **THEN** every principal and resource attribute key sent to the authorization engine is in the declared set, and the marker appears in no attribute value, no resource id and no principal id

#### Scenario: A caller-supplied identifier that is not a valid identifier never reaches the decision log
- **GIVEN** a catalog request whose entity identifier, blueprint and owner team hold a marker string that is not a valid identifier
- **WHEN** the request is authorized
- **THEN** the authorization engine receives the fixed placeholder in their place, the marker appears in no resource id and no attribute sent to it, the check fails closed, and the answer is the same as without the placeholder
