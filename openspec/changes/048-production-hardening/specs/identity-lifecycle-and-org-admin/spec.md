## ADDED Requirements

### Requirement: An authorization-engine error in the identity pipeline is an internal error, not a denial

When the authorization engine cannot answer a check of an identity operation (the caller's
check, the target's check, or the inviter re-check of an invitation acceptance), the
operation MUST still fail closed with the answer it gives today, and the error MUST be
logged as `identity.internal_error`, carrying only the operation name and a bounded error
type, and counted on `tayzu.authz.errors` by resource kind and action. Such an error MUST
NOT be counted as a `deny` on the authorization-decision counter and MUST NOT be logged as
an authorization denial, so that a denial rate and an outage are told apart. No message,
address, connection detail or tenant free text from the error MUST reach any signal.

#### Scenario: An engine outage on an identity operation is not counted as a denial

- **GIVEN** the authorization engine fails every check
- **WHEN** an admin calls an identity operation
- **THEN** it fails with `AUTH_FORBIDDEN` as before, `identity.internal_error` is logged with the operation and the error type, `tayzu.authz.errors` is incremented for the resource kind and action, and neither a `deny` decision nor `catalog.security.authz_denied` is recorded

#### Scenario: An explicit denial is still a denial

- **GIVEN** the authorization engine answers a check with a deny
- **WHEN** a member calls an admin-only identity operation
- **THEN** it fails with `AUTH_FORBIDDEN`, a `deny` decision is counted and no internal error is logged

#### Scenario: An engine outage during an acceptance re-check fails closed

- **GIVEN** a valid pending invitation and an authorization engine that fails the inviter re-check
- **WHEN** the invitee accepts it
- **THEN** the acceptance is refused with the uniform rejection, no user or membership is created, and `identity.internal_error` and `tayzu.authz.errors` are recorded

#### Scenario: The internal error carries no free text

- **GIVEN** an engine error whose message holds a marker string
- **WHEN** it is logged
- **THEN** the marker appears in no exported span, metric or log attribute

### Requirement: The email provider is reached through a managed identity

The platform's real email sender MUST authenticate to the provider with a cloud identity
token, never with a stored connection string or access key: the API and the scheduled jobs
with the managed identity of the environment they run in (a user-assigned identity when its
client id is configured, else the system-assigned one), and the operator command with the
operator's own signed-in identity. The provider's endpoint is configuration, not a secret.
Where the real sender is selected, startup MUST fail unless the endpoint is set and is an
`https` URL, and in every environment startup MUST fail when the retired connection string
variable is set, naming only the variable. The sender MUST receive its credential from its
host, so that its tests run with no network access.

#### Scenario: The real sender uses a token credential

- **GIVEN** the real email provider is selected with an endpoint and a sender address
- **WHEN** an invitation email is sent
- **THEN** the provider client is built with the endpoint and the injected token credential, and no connection string is read

#### Scenario: A connection string is refused

- **WHEN** the platform or a job starts with the retired connection string variable set, whatever the provider and the environment
- **THEN** startup fails, naming only that variable

#### Scenario: The real sender needs its endpoint

- **WHEN** the platform starts with the real provider selected and no endpoint, or an endpoint that is not an `https` URL
- **THEN** startup fails, naming only the endpoint variable

#### Scenario: A user-assigned identity is selected by its client id

- **WHEN** the API starts with the real provider and an identity client id configured
- **THEN** the managed-identity credential is built for that client id, and without one it is built for the system-assigned identity
