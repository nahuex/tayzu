# Spec Delta

## Purpose

Org deletion and data retention gives an organization a way to leave Tayzu:
an admin requests the deletion, access is revoked at once, and the tenant's
data is purged for good after a pending window during which a platform
operator can still reverse it. It also fixes what the platform keeps and
for how long. It builds on the identity pipeline of
`043-identity-lifecycle-and-org-admin` and the authentication baseline of
`002-auth-and-rbac`, and every step is attributed and audited the same way as
every other catalog mutation.

## Conventions

- **New Cerbos resource kind**: `organization`, with the action `delete`.
- **Reused error codes**: this capability introduces no new error codes. A
  Cerbos deny surfaces as `002`'s `AUTH_FORBIDDEN` (403). The step-up gate
  surfaces as `002`'s `AUTH_STEP_UP_REQUIRED` (403). A confirmation that does
  not name the host tenant surfaces as `CATALOG_VALIDATION_FAILED`.
- **Deletion marker states**: `pending`, `cancelled` and `purged`. A
  `cancelled` marker is a tombstone and does not close the tenant.
- **Host-supplied context**: `tenantId` and `actor` come only from the trusted
  host. No operation in this capability reads either from input, path, query
  or body. The confirmation of the organization's identifier is compared to
  the host tenant and is never a source of the tenant.
- **Routes**: one oRPC route, `DELETE /v1/organization`, registered only behind
  the mount switch of `043`. With it, the identity routes number fifteen
  (`043` has fourteen: thirteen oRPC procedures and the plain Fastify
  invitation-accept route).
- **Extended requirements of `043`**: the resolver checks of "Disabling a human
  takes effect immediately", the rejection list of "Invitation acceptance",
  the notice controls of "Invitation email is fixed and capped", "Every
  high-risk operation requires step-up", "Identity routes are unreachable until
  mounted" and "Telemetry contract" apply to this capability's route, event and
  template exactly as they do to `043`'s own; the requirements below state only
  what is new.
- **Principal attribution**: the operator of the reversal is identified by an
  opaque id, `gh:<numeric GitHub actor id>`, with the actor type `user`.

## ADDED Requirements

### Requirement: Org deletion revokes access immediately and purges tenant data after a window

Deleting an organization MUST be authorized to admins only, MUST require a
fresh step-up verification, and MUST require the caller to confirm the
organization's identifier, which MUST equal the host tenant. The operation
MUST be in two phases. In phase 1 it MUST record a deletion marker with a
purge date between 7 and 14 days away (computed in SQL from the database's own clock),
revoke every session whose active organization is the tenant (logging each as
`auth.security.session_revoked` with the reason `admin_action`), revoke every org-owned credential, cancel pending
invitations, send the fixed org-deletion notice to the administrators of the
organization, under the notice controls (a send failure or suppression MUST NOT block the request and MUST be logged), and log
`catalog.audit.org_deletion_requested` with the admin as actor. Requesting deletion again while pending MUST insert no second marker, send no
second notice and return the original date, MUST re-run the idempotent revocations of
phase 1, and MUST be logged as `catalog.security.org_deletion_repeated`. In phase 2 a scheduled job MUST, for a
tenant whose purge date has passed, delete in two idempotent steps with safe
resume: first the tenant's catalog data (including the append-only change
events and revocation rows, which the purge role may delete only for a tenant
whose marker is due), then the tenant's Better Auth data (invitations, API
keys, invitation tokens, members, each user left with no other membership
together with that user's accounts, sessions and second-factor rows, and the
organization row last). `catalog.audit.org_deletion_completed` MUST be logged
before the organization row is removed, and a failed step MUST log
`catalog.security.org_deletion_failed` and be retried by the next run. A pending deletion MUST be
reversible only by a platform operator, through an audited script that tombstones
the marker (never deletes it) and logs `catalog.audit.org_deletion_cancelled` with
the operator's opaque id; there is no in-product cancel. The reversal MUST be
refused for a tenant whose purge has begun or whose purge date has passed, and it
does not restore the credentials phase 1 revoked.

#### Scenario: Deletion without step-up fails

- **GIVEN** an admin session without a fresh MFA verification
- **WHEN** that admin requests org deletion
- **THEN** the operation fails with a step-up-required error and nothing changes

#### Scenario: Requesting deletion revokes access at once

- **GIVEN** organization `t1` with blueprints, entities, members and API credentials
- **WHEN** an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
- **THEN** every member's session and every `t1` credential, human or machine, is rejected within seconds, a marker with a purge date 7 to 14 days away exists, and the data is still there

#### Scenario: A platform operator reverses a pending deletion

- **GIVEN** `t1` has a pending deletion
- **WHEN** a platform operator runs the reversal script
- **THEN** the marker is tombstoned (never deleted), `catalog.audit.org_deletion_cancelled` is logged with the operator's opaque id, and the tenant's principals are accepted again
- **AND** a later deletion request creates a new marker

#### Scenario: A reversal is refused once the purge has begun

- **GIVEN** `t1` has a pending marker with a purge step recorded, or whose purge date has passed
- **WHEN** a platform operator runs the reversal script
- **THEN** it refuses, the marker is unchanged, and the database refuses the same tombstone from the reversal role

#### Scenario: Requesting deletion twice returns the original date

- **GIVEN** `t1` has a pending deletion
- **WHEN** the deletion is requested again, in process
- **THEN** no second marker or notice is created, the original purge date is returned, and `catalog.security.org_deletion_repeated` is logged

#### Scenario: A repeated request completes a half-failed first one

- **GIVEN** a first request that recorded the marker but failed before revoking a credential
- **WHEN** the deletion is requested again
- **THEN** the credential is revoked

#### Scenario: Purge removes tenant data after the window

- **GIVEN** `t1`'s purge date has passed
- **WHEN** the purge job runs
- **THEN** `t1`'s catalog entities, blueprints, relations, change events, credential revocation rows, invitations, API keys, members and organization row are gone
- **AND** a `catalog.audit.org_deletion_completed` event was logged before the organization row was removed

#### Scenario: A purge does not touch a tenant whose window has not passed

- **GIVEN** `t1`'s purge date is in the future and `t2` has no marker
- **WHEN** the purge job runs
- **THEN** nothing of `t1` or `t2` is deleted, and the purge role is refused when it tries to delete the append-only rows of either

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

### Requirement: A tenant with a pending or purged deletion is closed to every principal

From the moment a deletion marker is `pending` or `purged`, `resolveContext` and
token exchange MUST reject every principal of the tenant, human or machine, through
the existing 5-second cache and failing closed on any lookup failure, and MUST log
`catalog.security.principal_rejected` with the reason `tenant_pending_deletion` and
count the rejection, with the reason only in the log. Token exchange MUST refuse to mint a token for a credential of
such a tenant. An invitation of such a tenant MUST NOT be acceptable and MUST answer
the same uniform rejection as every other dead invitation, with the denial reason
`tenant_pending_deletion` only in the log. A `cancelled` marker MUST NOT reject.

#### Scenario: A purged tenant stays rejected

- **GIVEN** `t1` was purged and its marker remains as a tombstone in state `purged`
- **WHEN** a principal of `t1` is resolved
- **THEN** it is rejected, while a tenant whose marker is `cancelled` is accepted

#### Scenario: An already-issued machine token and a fresh exchange are refused

- **GIVEN** a tenant with a pending marker, a machine token issued before the request and a credential that was not revoked
- **WHEN** the token is used, and the credential is exchanged for a new token
- **THEN** both are refused, and the rejection is logged with the reason `tenant_pending_deletion`

#### Scenario: Accepting an invitation of a tenant pending deletion fails

- **GIVEN** a pending invitation with a valid token in a tenant with a pending marker
- **WHEN** the invitation is accepted
- **THEN** the answer is the same uniform rejection as for a nonexistent invitation, and the reason `tenant_pending_deletion` appears only in `catalog.security.invitation_acceptance_denied`

### Requirement: The deletion marker and the purge are protected from the request path

The deletion marker MUST be insert-only for the role that serves requests, and that role
MUST have no privilege on any marker column other than the tenant, the purge date and the
requesting actor, so that `requested_at`, the state, the purge-step timestamps and the
cancellation fields always take the database's own values; a database constraint MUST keep
`purge_after` between 7 and 14 days after `requested_at`, and only one pending
marker per tenant MAY exist. The purge MUST run as a dedicated role, used only by
the purge job with its own secret, that can act only on tenants with a due pending
marker, on the catalog rows and on the Better Auth rows alike (it may also read every
membership row, read-only, so that it can see a user's memberships in tenants that are
not due), and the due-tenant
condition MUST be enforced by row-level policies, not by a function or by code; the
append-only change-event rows MUST be deletable only by that role. No
`SECURITY DEFINER` function MUST take part in the purge, and each maintenance
script MUST run as its own job with its own identity and secrets and MUST refuse to run
under a database role other than the one it declares. A schema-driven test MUST fail when a
table carrying tenant data is neither purged nor explicitly exempted.

#### Scenario: The request role cannot back-date a marker

- **WHEN** the role that serves requests inserts a marker that names `requested_at`, a `state` or a purge-step timestamp, or a `purge_after` outside 7 to 14 days
- **THEN** the database refuses each, and the request role can neither update nor delete a marker

#### Scenario: The Better Auth rows of a tenant that is not due cannot be purged

- **GIVEN** a tenant with a pending marker whose date has not passed, and one with a due marker
- **WHEN** the purge role tries to delete the Better Auth rows of both
- **THEN** only the rows of the due tenant, and only the users whose memberships are all in due tenants, are deleted (a user who also belongs to a tenant that is not due is kept, because the purge role can read that membership), and the role that serves authentication keeps its access to every tenant

#### Scenario: Only due tenants can be purged, and only by the purge role

- **GIVEN** a tenant with a pending marker whose date has not passed, and one with a due marker
- **WHEN** the purge role and the request role each try to delete the append-only rows of both
- **THEN** only the purge role, and only for the due tenant, succeeds; every other path is refused, including the table owner

#### Scenario: No role can become the purge role

- **WHEN** any other role of the platform attempts `SET ROLE` to the purge role
- **THEN** it is refused, and no membership of another application role grants it the ability (the creating role's admin-only membership has no set or inherit option)

#### Scenario: A new table cannot escape the purge

- **WHEN** a table with a `tenant_id` column, an `auth` table that references an organization or a user (by foreign key or by column), or a new `auth.verification` identifier pattern is added that no purge step covers
- **THEN** the completeness test fails until it is covered or exempted with a reason

### Requirement: The reversal runs only through a reviewed workflow

The reversal script MUST run only through a reviewed manual workflow, runnable only
from the main branch, whose environment requires a second approver, and the
operator's id MUST derive from that workflow's authenticated actor, never from an
argument. The same workflow MUST also start `043`'s `_user` backfill and reconcile,
whose operator id then derives from it too. Every workflow input MUST be a fixed
choice or validated against the tenant-id pattern and MUST reach the job only
through the environment, never through an expression inside a `run:` script; every
third-party action MUST be pinned by commit SHA; the workflow MUST have no checkout
and no setup step and MUST NOT override the job's command, arguments or image; the
workflow and the scripts MUST be covered by `CODEOWNERS`; and the federated
identity's cloud role MUST be limited to starting the named jobs. The bootstrap
command is the one script outside that workflow: an operator runs it out of band,
as the authentication baseline designed it.

#### Scenario: The workflow does not interpolate its inputs

- **WHEN** the maintenance workflow file is read
- **THEN** no `run:` contains `${{ inputs.* }}`, `github.event.*` or `github.head_ref`, every input is a choice or validated, every `uses:` is pinned by a 40-character SHA, and `CODEOWNERS` covers the workflow and `apps/api/scripts/**`

#### Scenario: The reversal records the authenticated operator

- **WHEN** the reversal is started without the operator id that the reviewed workflow supplies
- **THEN** the script refuses to run and nothing is tombstoned

#### Scenario: The workflow starts only the named jobs without overrides

- **WHEN** the workflow file is read
- **THEN** its only steps are a pinned Azure login and the call that starts the named job, the call carries no command, arguments, image or environment override other than the fixed variable names, it is runnable only from `master`, and no other workflow names the same environment

### Requirement: The deletion notice is fixed and capped

The org-deletion notice MUST be a fixed template whose only interpolated value is the
purge date, with no link and no tenant, actor or organization free text. It MUST be sent
as one email per recipient to the administrators of the organization, resolved on the
server from the tenant's memberships, at most 20 of them (the administrators who have
been members the longest), once per deletion request, and MUST go through the same
notice controls as every other notice: the global kill switch, the per-recipient cap, the
per-tenant notice cap and the list of disabled tenants. A suppressed or truncated notice
MUST NOT block the request and MUST be logged as `catalog.security.notice_suppressed`; a
send failure MUST NOT block it and MUST be logged as
`catalog.security.org_deletion_notice_failed`.

#### Scenario: Every admin is notified of a pending deletion

- **GIVEN** an organization with an owner, two admins and a member
- **WHEN** an admin requests deletion
- **THEN** each of the three administrators receives exactly one fixed-template email and the member receives none, and a repeated request sends nothing

#### Scenario: The deletion notice carries no free text

- **GIVEN** an organization named `<b>Pay now</b>` and an admin with a markup-bearing name
- **WHEN** the org-deletion notice is sent
- **THEN** neither string appears, the notice has no link, and its only variable is the purge date

#### Scenario: The deletion notice is under the kill switch and the caps

- **GIVEN** the kill switch is on, or the per-tenant notice cap is exhausted, or a recipient's per-recipient bucket is full
- **WHEN** an organization deletion is requested
- **THEN** the request succeeds, no email goes to the affected recipients, and `catalog.security.notice_suppressed` is logged with the template `org_deletion` and the reason

#### Scenario: The deletion notice goes to at most 20 recipients

- **GIVEN** an organization with 25 administrators
- **WHEN** an organization deletion is requested
- **THEN** exactly 20 emails are sent, to the administrators who have been members the longest, and the truncation is logged

#### Scenario: A demo tenant sends no deletion notice

- **GIVEN** a tenant on the list of disabled tenants and a real sender
- **WHEN** an organization deletion is requested
- **THEN** nothing reaches the sender, no cap bucket is consumed, the request succeeds, and `catalog.security.email_tenant_blocked` is logged with the tenant and the template `org_deletion` and no address

### Requirement: The deletion route is authorized, step-up gated, tenant-bound and mounted behind the switch

`identity.organization.delete` MUST be built through the identity router's one
authorization wrapper, so that the caller's role is checked first and an unauthorized
caller learns nothing, and MUST carry `x-tayzu-risk: high` on its route
(`DELETE /v1/organization`), which MUST appear in the committed identity OpenAPI
document with that marker. The confirmation MUST travel in the query string and MUST
equal the host tenant; a confirmation sent only in a body, or one that names another
tenant, MUST fail with `CATALOG_VALIDATION_FAILED` and change nothing. The target of
the Cerbos check MUST be the host tenant, passed as the real tenant. The route MUST be
registered only while the mount switch is on and, with it off, MUST answer exactly as an
unknown `/v1` path does. Over HTTP a `member` and a machine `member` token MUST be refused with
`AUTH_FORBIDDEN` and an unauthenticated caller MUST get 401.

#### Scenario: Org deletion targets only the host tenant

- **WHEN** an admin of `t1` requests org deletion with `t2`'s identifier as the confirmation
- **THEN** the operation fails with `CATALOG_VALIDATION_FAILED` and nothing of `t1` or `t2` changes

#### Scenario: The confirmation must be in the query

- **WHEN** an admin with a fresh step-up verification calls the route with the confirmation only in a body, and then with a wrong value in the query
- **THEN** each fails with `CATALOG_VALIDATION_FAILED` and nothing changes, while the right value in the query is honored

#### Scenario: The route is marked high-risk and documented

- **WHEN** the committed identity OpenAPI document is read
- **THEN** it lists `DELETE /v1/organization` with `x-tayzu-risk: high`, and the drift check fails when the route changes without regenerating the document

#### Scenario: A non-admin cannot request deletion

- **WHEN** a `member`, a machine `member` token and an unauthenticated caller call the route over HTTP
- **THEN** the first two get `AUTH_FORBIDDEN` (403) and the third gets 401, and nothing changes

#### Scenario: The route does not exist until mounted

- **GIVEN** the mount switch is off, which is the default
- **WHEN** the route is called with and without authentication
- **THEN** each answers exactly as an unknown `/v1` path does

### Requirement: Org deletion events are logged and exported

Org-deletion request, repeated request, completion, failure, cancellation and notice
failure MUST be logged as the corresponding `catalog.audit.*` or `catalog.security.*`
event declared in the Observability contract, with opaque identifiers and enumerated
values only, and the actor of an audit event MUST be the admin who acted, or for a
cancellation the operator, never the `system` actor of the write. A failed org deletion
MUST NOT be invisible. The purge and the reversal MUST start telemetry and flush it
before the process exits, so that their audit events are exported. No organization name,
email or tenant free text MUST reach any exported signal, and the exported path of the
route MUST be its route template.

#### Scenario: Each deletion action emits its declared event

- **WHEN** a deletion is requested, requested again, reversed, purged and, separately, a purge step fails
- **THEN** `catalog.audit.org_deletion_requested`, `catalog.security.org_deletion_repeated`, `catalog.audit.org_deletion_cancelled`, `catalog.audit.org_deletion_completed` and `catalog.security.org_deletion_failed` are each observed with their required attributes and no email, name or secret

#### Scenario: A failed deletion is logged

- **WHEN** a purge step fails
- **THEN** `catalog.security.org_deletion_failed` is logged with the step

#### Scenario: A maintenance script's audit event is exported before it exits

- **WHEN** the purge or the reversal script emits its `catalog.audit.*` event and finishes, or fails
- **THEN** the event has been exported (flushed) by the time the script's process ends

#### Scenario: The organization name never reaches telemetry

- **GIVEN** an organization named with a marker string
- **WHEN** it is deleted, reversed or purged
- **THEN** the marker appears in no exported span, metric or log attribute, and the exported path of `DELETE /v1/organization` is the route template
