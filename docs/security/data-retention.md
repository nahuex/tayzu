# Data retention and identity runbooks

Design D12 of `openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/design.md`
(task 16.5). This file holds the policies and operator runbooks of the identity
lifecycle: the credential rotation cadence, the invitation caps, the email
policy, the repairs for a failed acceptance, the off-boarding step and the
first-deployment run of the bootstrap CLI. Change `045-org-deletion-and-data-retention`
extends it with the retention policy, the erasure statement of org deletion and
the reversal runbook, in [Org deletion and data retention](#org-deletion-and-data-retention).

Secrets, their owners and the emergency flip of the kill switch are in
[Secrets](secrets.md). The routes and the egresses are in
[Attack surfaces](attack-surfaces.md). Alerts named below are the ticket
"Alerts for `010`" of the design, which is not built in this change.

## Credential rotation cadence

A machine credential (a service account's key or an unbound integration or
agent key) is rotated every **90 days**. The org credentials viewer computes
`rotationDueAt` from the key's `rotatedAt` metadata, or from its `createdAt` for
a key never rotated, against that default (`DEFAULT_ROTATION_INTERVAL_DAYS` in
`apps/api/src/identity/credentials.ts`). The interval is a parameter of the
computation; no environment variable sets it today.

The cadence is a documented policy default, not an enforced expiry: no
credential is force-disabled for being overdue (Resolved decision Q20).
Rotation cuts over immediately: the old key is revoked in the same operation
and its already-issued tokens are rejected within seconds
([ADR-0018](../adr/0018-credential-rotation-immediate-cutover.md)). There is
no grace window, so the integration that holds the key must be updated at the
moment of rotation.

## Invitation and notice caps

Defaults live in `apps/api/src/config.ts` and are tuned by the environment. A
set value must be a positive integer, and a zero or disabled value fails
startup.

| Scope                                  | Default                    | Variables                                                                                       |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `invitation_tenant` (per tenant)       | 30 emails per hour         | `INVITATION_TENANT_RATE_LIMIT_MAX`, `INVITATION_TENANT_RATE_LIMIT_WINDOW_SECONDS`               |
| `invitation_recipient` (per recipient) | 3 emails per 24 hours      | `INVITATION_RECIPIENT_RATE_LIMIT_MAX`, `INVITATION_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS`         |
| `notice_tenant` (per tenant)           | 60 emails per hour         | `NOTICE_TENANT_RATE_LIMIT_MAX`, `NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS`                       |
| `notice_recipient` (per recipient)     | 3 emails per 24 hours      | The same defaults as `invitation_recipient`, counted in a bucket of its own (Q101).             |
| `invitation_accept` (per IP)           | 10 requests per 60 seconds | `INVITATION_ACCEPT_RATE_LIMIT_MAX`, `INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS` (Q140)        |
| `reauthorization_callback` (per IP)    | 10 requests per 60 seconds | `REAUTHORIZATION_CALLBACK_RATE_LIMIT_MAX`, `REAUTHORIZATION_CALLBACK_RATE_LIMIT_WINDOW_SECONDS` |

The buckets live in the shared `auth.rate_limit` table (the DB-backed store of
`002`), so they hold across replicas.

### What a window means (Resolved decision Q66)

The store resets a bucket only after a **full window with no allowed
request**. Every allowed request moves the bucket's last-request time and the
table has no window-start column. A cap of "3 per 24 hours" therefore means
"3 allowed requests while the gaps between them stay shorter than 24 hours": a
slow trickle of one request every 23 hours never resets the bucket, and the
count accumulates until the cap. That is stricter than the nominal rate. It
errs on the restrictive side, so it is accepted; a test pins the slow-trickle
case, and no window-start column or counter table is built.

### Cross-tenant denial of invitation

The per-recipient cap is keyed by the address, not by the tenant. One tenant's
admin can send three invitations to a victim address and so exhaust the
cap, and other tenants' legitimate invitations to that address are denied until
the bucket resets. This is a denial of invitation, and a weak oracle for
whether an address was invited recently. Both are accepted. The notices have a bucket of their own (`notice_recipient`),
so invitations cannot drain a person's admin notices and the reverse
(Resolved decision Q101).

A denied send logs `catalog.security.invitation_rate_limited`; a suppressed or
truncated notice logs `catalog.security.notice_suppressed` with the template,
the reason (`global`, `tenant`, `recipient` or `truncated`) and the number of
emails dropped. Neither carries an address.

### Kill switch

`INVITATION_EMAIL_KILL_SWITCH` (`true` or `false`, unset is off) stops every
email template despite its name, the notices included, before any cap is
consumed. It is an **environment variable**, so flipping it needs a **new app
revision**; there is no runtime toggle. The emergency procedure is in
[Secrets](secrets.md).

## Password reset and recovery

Design D3, D5, D11, D16 and D18 of
`openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery/design.md`. The change
adds no table, no column and no migration; `0012`-`0014` stay reserved for `045`.

### Identifier families in `auth.verification`

The change writes exactly two families. A test
(`apps/api/src/identity/verification-families.int.test.ts`) runs each writer once
and fails on any other prefix, so the list below is the one the test declares.

| Family                 | Written by                                                          | Lifetime                                                                                                 | Removed by                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `password-reset:<id>`  | The reset-token store, only after the mailer admitted the send (D3) | 30 minutes, a constant                                                                                   | The confirm that consumes it; a newer admitted request for the same user; the opportunistic purge of expired rows in the next issue; the budget of 5 failed factors    |
| `mfa-reenrol:<userId>` | `writeMfaReenrolMarker`, the only writer (D11)                      | Far-future sentinel `expires_at` (`9999-12-31`), shared with the temporary-password and SSO-link markers | The user's enrolment of a factor (`hooks.after` on `/two-factor/verify-totp`). A password reset does not delete it: a reset does not give back a factor that was reset |

The `password-reset:<id>` row holds the lowercase hex SHA-256 digest of the
token, the user id and a failure count in `value`; the token is in no column.
The identifier holds a random id, neither a tenant nor a user.

A completed reset also deletes the user's `temp-password:<userId>` marker, the
user's pending `2fa-<random>` challenge rows and `trust-device-*` rows (both
matched by `value` = user id). The sibling `2fa-attempts-2fa-<random>` rows have
the value `0`, are not matched, and expire with their challenge (10 minutes).

### Reset caps in `auth.rate_limit`

The caps added by this change are keyed by hashed values, so `auth.rate_limit`
holds no address or email in clear: the recipient caps use the HMAC of the
canonical address under `IDENTITY_TOKEN_HMAC_SECRET`, and the IP keys are the
normalized client key of D16 (an IPv4 address, or the first 64 bits of an IPv6
one). Both are pseudonymous and carry no tenant.

| Scope                                             | Default                                 | Variables                                                                                                 |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `password_reset_request` (route, per IP)          | 10 requests per 60 seconds              | `PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX`, `PASSWORD_RESET_REQUEST_RATE_LIMIT_WINDOW_SECONDS`               |
| `password_reset_confirm` (route, per IP)          | 10 requests per 60 seconds              | `PASSWORD_RESET_CONFIRM_RATE_LIMIT_MAX`, `PASSWORD_RESET_CONFIRM_RATE_LIMIT_WINDOW_SECONDS`               |
| `reset_email_recipient` (per recipient)           | 5 emails per hour                       | `PASSWORD_RESET_RECIPIENT_RATE_LIMIT_MAX`, `PASSWORD_RESET_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS`           |
| `reset_email_ip` (per normalized IP)              | 10 emails per hour                      | `PASSWORD_RESET_IP_RATE_LIMIT_MAX`, `PASSWORD_RESET_IP_RATE_LIMIT_WINDOW_SECONDS`                         |
| `reset_email_global` (platform)                   | 600 emails per hour, fixed window       | `PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX`, `PASSWORD_RESET_GLOBAL_RATE_LIMIT_WINDOW_SECONDS`                 |
| `recovery_notice_recipient` (per recipient)       | 10 emails per 24 hours                  | `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_MAX`, `RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS`         |
| `account_created_notice_tenant` (creating tenant) | 20 notices per 24 hours                 | `ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_MAX`, `ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS` |
| `account_created_notice_global` (platform)        | 1000 notices per 24 hours, fixed window | `ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_MAX`, `ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_WINDOW_SECONDS` |

**Fixed windows for the two global caps (Resolved decision Q32).** The two
platform-wide buckets have one key each. Under the window semantics of `002`
(a bucket resets only after a full window with no allowed request) steady
traffic at the cap would stop the whole platform for a whole idle window. For
these two buckets only, the cap store appends the index of the current window to
the bucket value, `<key>:<floor(now / window)>`, so each hour or day starts a new
row at zero and the cap means N per fixed window. Every other bucket keeps the
semantics of `002`. The row of a past window is an ordinary expired
`auth.rate_limit` row, covered by the pruning item below.

### Pruning expired `auth.rate_limit` rows

Nothing prunes `auth.rate_limit` today: each distinct key writes a row, and an
expired row stays (`packages/db/migrations/0004_rate_limit_table.sql`). The
normalized IP key bounds the growth an attacker can cause, and the fixed-window
rows of the two global caps add one row per window. Pruning the rows whose
`last_request` is older than the longest window is a data-retention item with a
ticket (design D16), not built in this change. Until it is, the table grows with
the number of distinct keys.

### Hand-off note to `045` (closed)

**Closed by `045`, Resolved decision Q150.** Both families are classified as
recommended below: `mfa-reenrol:<userId>` is deleted by purge step 2 before the
user, and `password-reset:<id>` is exempt as 30-minute state. `045`'s
completeness test (`apps/api/src/purge-coverage.int.test.ts`) holds both lines,
and `auth.rate_limit` stays exempt for the reason Resolved decision Q151
corrects ([What a purge does not remove](#what-a-purge-does-not-remove)). The
note below is kept as the record of the hand-off.

`044` adds no migration. Its two families need a classification in the
completeness test of `045`, which classifies every `auth.verification` family by
pattern and fails on an unlisted one:

| Family                 | Recommended classification                                                                                                            | Reason                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `password-reset:<id>`  | Exempt as short-lived state (30 minutes, a random id, a digest, and a user id in `value`; purged opportunistically by the next issue) | The identifier holds neither a tenant nor a user, so a purge policy that joins by identifier family cannot join it, and it does not need to |
| `mfa-reenrol:<userId>` | Purge step: delete with the user's other `verification` markers (`temp-password:`, `sso-link:`) before the row its policy joins       | Keyed by user id; far-future `expires_at`, so nothing else removes it                                                                       |

Also for `045`: `auth.rate_limit` now holds the hashed reset caps and IP keys
above (pseudonymous, no tenant; exempt as `045` already treats the table), and
the `EmailTemplate` union and the `tayzu.identity.email.template` set are
extended by `044` first, so the `OrgDeletionNotice` of `045` rebases onto them.
`verification-families.int.test.ts` is the early-warning list.

## Org deletion and data retention

Design D1 to D3 of `openspec/changes/045-org-deletion-and-data-retention/design.md`
(task 10.3). Org deletion has two phases: the request revokes access at once and
records a deletion marker, and a scheduled job purges the tenant's data once the
window has passed. Server-level point-in-time restore cannot restore one tenant
out of the shared-schema database, so the only way back is the operator's
reversal while the deletion is pending:
[Runbook: reversing a pending deletion](#runbook-reversing-a-pending-deletion).

### The purge window

`ORG_DELETION_WINDOW_DAYS` (`apps/api/src/config.ts`) is an integer from **7 to
14 days**, and the default is **14 days** (Resolved decisions Q21 and Q167). A
value outside the range, zero, negative, fractional or not a number fails
startup naming only the variable. It is an environment variable, so a change
needs a new app revision.

The request computes the purge date in SQL, `now() + make_interval(days => $1)`,
from the same transaction clock as the database-set `requested_at`, and a
`CHECK` on `tenant_deletion_marker` keeps `purge_after` between 7 and 14 days
after `requested_at`. During the window every principal of the tenant, human or
machine, is rejected, an invitation of the tenant cannot be accepted, and the
data is still there. There is no in-product cancel.

Once `purge_after` has passed, the purge job
(`pnpm --filter @tayzu/api identity:purge`, a Container Apps Job that runs as `tayzu_purge` and holds no
other role) purges the tenant on its next scheduled run, in two idempotent steps
that resume where a failed run stopped: the catalog data (the append-only change
events and the revocation rows included), then the Better Auth data (invitation
tokens and shed records, invitations, each user left with no other membership
with that user's accounts, sessions, second-factor and `verification` rows, API
keys, the tenant's remaining sessions, members, and the organization row last).
It logs `catalog.audit.org_deletion_completed` before it deletes the
organization row, and `catalog.security.org_deletion_failed` with the step when
a step fails.

### What the request removes at once

Phase 1 (`identity.organization.delete`, `DELETE /v1/organization`) records the
marker, revokes every session whose active organization is the tenant, revokes
every org-owned credential, cancels the pending invitations, sends the
org-deletion notice to at most 20 administrators and logs
`catalog.audit.org_deletion_requested`. In the same operation that deletes the
tenant's sessions it also deletes, on the `tayzu_auth` pool, the
`sso-reauth-state:` and `sso-reauth-result:` rows keyed by the tokens of those
sessions (Resolved decision Q170). A `sso-reauth-result:` row can hold a
never-consumed `id_token`, which is personal data, and purge step 2 cannot find
it later: the sessions it would join are already gone.

A repeated request while the deletion is pending inserts no second marker,
sends no second notice and returns the original date, but runs the idempotent
revocations again, and logs `catalog.security.org_deletion_repeated`.

### Backups

The PostgreSQL backup retention is **7 days** (Resolved decision Q156); `010`
sets it when the server is provisioned, a first-deployment gate. A backup keeps
a purged tenant's rows until that retention expires, so purged data is gone from
the backups at most **21 days** after the request with the default window (14
days of window and 7 of backup retention), and at most 14 days with the 7-day
window. Both figures count the purge on its due date; the purge job's schedule
adds at most the time to its next run. A backup is not a reversal path: it
cannot restore one tenant.

### What a purge does not remove

The erasure statement: the purge deletes the tenant's catalog and Better Auth
data, and these stay after it, each until the point named.

| Data                                                | What it holds                                                                                                                                                                                                                                                                          | Stays until                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL backups                                  | A copy of the database, the purged tenant's rows included                                                                                                                                                                                                                              | The backup retention of 7 days expires ([Backups](#backups))                                                                                                                                         |
| Cerbos decision logs                                | `decisionLogsEnabled: true` (`config/cerbos.yaml`) records each check's principal and resource ids and attributes; `043` sends only opaque ids                                                                                                                                         | Their content and retention have no policy yet (`045` design, Tickets, "Cerbos decision logs")                                                                                                       |
| Azure Monitor data                                  | The telemetry the app exported: spans, metrics and log events with tenant ids and opaque actor ids, never tenant free text                                                                                                                                                             | The backend's retention, set by `010`; the security events among them follow [Audit and security log retention](#audit-and-security-log-retention)                                                   |
| Azure Communication Services records                | The provider's message records and delivery logs of the tenant's emails, the org-deletion notice included: the recipient address and the fixed subject and body                                                                                                                        | The provider's retention, which the operator records in [Azure Communication Services: data location and retention](#azure-communication-services-data-location-and-retention) before `010` deploys  |
| `password-reset:<id>` rows                          | `044`'s reset token: a random id, a digest and a user id in `value`                                                                                                                                                                                                                    | 30 minutes, or the next issue's opportunistic purge of expired rows (Resolved decision Q150)                                                                                                         |
| `auth-state:<state>` rows                           | Better Auth's OAuth state of an SSO sign-in, keyed by a random value                                                                                                                                                                                                                   | 10 minutes, or the callback that consumes it                                                                                                                                                         |
| `2fa-<random>` and `2fa-attempts-2fa-<random>` rows | Better Auth's two-factor challenge of an enrolled sign-in and its attempt counter, keyed by a random value                                                                                                                                                                             | Their own expiry, 10 minutes                                                                                                                                                                         |
| `backchannel-logout:<client>:<jti>` rows            | Replay state keyed by the identity provider's client and token id, not by tenant                                                                                                                                                                                                       | The logout token's expiry plus a skew                                                                                                                                                                |
| `auth.rate_limit` rows                              | A count and a timestamp under an unsalted SHA-256 of a scope and a tenant id, a user id, an IP or the keyed (HMAC) hash of an email (`043`'s task 6.7b): no personal data in clear. A tenant-keyed bucket's key can be recomputed from the tenant id, which the tombstone keeps anyway | `044`'s ticket "Prune `auth.rate_limit`" (`044` design, Tickets) removes old rows; `tayzu_purge` has no grant on the table (Resolved decision Q151, [Pruning](#pruning-expired-authrate_limit-rows)) |
| `auth.jwks` rows                                    | The platform's signing keys, not per tenant                                                                                                                                                                                                                                            | Key rotation                                                                                                                                                                                         |
| The marker's tombstone                              | The `tenant_deletion_marker` row: the tenant id, the state, the timestamps (`requested_at`, `purge_after`, the two step timestamps, `cancelled_at`) and the opaque `requested_by` and `cancelled_by` ids; no name or email                                                             | Kept, so that a later run finds nothing to purge                                                                                                                                                     |

Each exemption, and its reason, is a line of the completeness test
(`apps/api/src/purge-coverage.int.test.ts`), which fails on any tenant table,
`auth` table or `auth.verification` family that no purge step deletes and no
line exempts.

### Runbook: reversing a pending deletion

A reversal tombstones a pending marker, so that the tenant's principals are
accepted again. It is possible only while the marker is `pending`, no purge step
is recorded and `purge_after` is in the future.

**Access.** The maintenance workflow, `.github/workflows/identity-maintenance.yml`
("Identity maintenance"), is the only way the reversal reaches production
(Resolved decision Q41). Its GitHub environment, `identity-maintenance`, has
required reviewers with "prevent self-review", and those reviewers are the
**named second approver**: a second human, who is also a code owner (Resolved
decision Q153). Until that person is added, the workflow cannot be enabled, and
neither a bot account nor self-review stands in. Any other operator access, such
as reading the marker or the job's logs, is just-in-time access through Azure PIM
with a personal account. No one connects to the production database from a
workstation.

1. Start the workflow from `master` (a job condition refuses any other ref) with
   the inputs `job=cancel-org-deletion` and `tenant_id=<tenant id>`. The workflow
   refuses a tenant id that does not match `^[A-Za-z0-9_-]{1,64}$`, and the input
   reaches its steps only through `env`.
2. A reviewer of the environment approves the run.
3. The workflow logs in to Azure through OIDC and starts the Container Apps Job
   `tayzu-cancel-org-deletion` with two fixed variables: `TAYZU_TENANT_ID` and
   `TAYZU_OPERATOR_ID`, which is `gh:<numeric GitHub actor id>` of the
   workflow's authenticated actor, never typed and never the login.
4. The job runs `apps/api/scripts/cancel-org-deletion.ts`
   (`pnpm --filter @tayzu/api identity:cancel-org-deletion`) inside the VNET as
   `tayzu_deletion_admin` (Resolved decision Q35), which can only tombstone a
   pending marker and reads no tenant data. It asserts that role at start and
   refuses to run without an operator id. It sets `state = 'cancelled'`,
   `cancelled_at` and `cancelled_by` (the row is never deleted), logs
   `catalog.audit.org_deletion_cancelled` with the tenant and the operator's
   opaque id, and increments `tayzu.identity.org_deletions` with the outcome
   `cancelled`.
5. Check the job's result. A refusal exits non-zero, writes
   `cancel-org-deletion refused: <reason>` to standard error and logs
   `catalog.security.org_deletion_cancel_refused` with the operator's opaque id
   and the reason; the marker is unchanged.
6. Tell the organization's administrators to rotate every credential (below),
   and record the run, the approver and the operator id in the change record.

**Refusals.** The script refuses with one of four reasons (Resolved decision
Q171). The tombstone policy of `tayzu_deletion_admin` refuses the same marker in
the database. A missing or malformed operator id fails at the configuration load
instead, with no event.

| Reason              | When                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_tenant`    | The tenant id is missing or does not match the catalog's tenant-id pattern; the event carries no tenant (Resolved decision Q172) |
| `no_pending_marker` | The tenant has no pending marker: never requested, already cancelled or already purged, or another run tombstoned it first       |
| `purge_begun`       | A purge step timestamp is recorded, so a half-purged tenant is never revived with its catalog data gone                          |
| `purge_date_passed` | `purge_after` is past by the database clock, so the purge job may start at its next run                                          |

**What a reversal does not restore.** Phase 1's revocations are permanent. Every
org-owned credential stays revoked, so the administrators rotate each one: they
issue a new key and update the integration that held the old one
([Credential rotation cadence](#credential-rotation-cadence)). The revoked
sessions are gone, so members sign in again, and the cancelled invitations stay
cancelled, so administrators invite again.

**A later request.** After a reversal the tombstone stays, and a new deletion
request inserts a new marker beside it (only one `pending` marker per tenant is
unique), with a new window from that request, a new notice and a new
`catalog.audit.org_deletion_requested` event.

### The `_user` backfill and reconcile

`043`'s `_user` blueprint backfill and [`_user` reconcile](#the-_user-reconcile)
are now started through the same workflow, with `job=backfill-user-blueprint` or
`job=reconcile-users` and no tenant id, so the environment's reviewers are their
named second approver too and their operator id is derived from the workflow's
authenticated actor (Resolved decision Q41). The workflow starts nothing else:
the bootstrap CLI and `044`'s break-glass `recover-admin-mfa` stay out of band,
run by an operator under just-in-time access (Resolved decisions Q91 and Q155).

### Audit and security log retention

Audit and security logs (the `catalog.audit.*`, `catalog.security.*` and
`auth.security.*` log events, the deletion's own events included) are kept for
**12 months**, independent of tenant deletion: a purge deletes none of them. They
carry tenant ids and opaque ids, never tenant free text. This is the target that
`010` implements (Resolved decision Q156), a first-deployment gate, and it matches
the 1 year of [Security log retention](#security-log-retention). The org-wide audit-log
product surface, with its own retention and export tooling, is `015`.

## Security log retention

Security events (the `catalog.security.*`, `catalog.audit.*` and
`auth.security.*` log events, and the infrastructure security logs) are kept for
1 year (`044` design, Resolved decision Q34). The application only emits them;
the log backend that stores them, enforces the 1 year and exports them on
request is defined by `010`, and until it exists the retention is a ticket
(`044` design, Tickets, "Security log retention and IP forensics" and "Log
export procedure"). The estimate to hand logs to the GSOC in an incident is 48
hours.

## Email policy

- **Provider.** `EMAIL_PROVIDER` is `acs` or `none` (the non-sending sender).
  "Production" means `NODE_ENV !== 'test'`, as in `002`: every deployed
  environment must set `EMAIL_PROVIDER` explicitly, and an unset value fails
  startup (Resolved decision Q96). CI and DAST use `none`; `dast.sh` exports
  it. Tests use the recording fake.
- **Recipient-domain allowlist** (`EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, Resolved
  decisions Q67, Q96 and Q99). It is **mandatory only** when a real provider is
  configured under `NODE_ENV=test`: startup fails without it. It is **honored
  wherever it is set**, a deployed staging environment included. A recipient
  whose domain is not on the list is refused like a provider failure
  (sanitized, the operation is not blocked beyond that) and logged as
  `catalog.security.email_recipient_blocked` with the template and no address.
  Its purpose is that a known demo login cannot be used to relay phishing to a
  third party.
- **Fixed content.** Two fixed templates exist: the invitation and the
  admin-accepted notice. Exactly one recipient, no CC, BCC, attachment or
  Reply-To, and no tenant or inviter free text. The invitation token travels in
  the URL fragment and never leaves the email: no response, log record or
  sender record carries it.
- **Notices.** A notice goes to at most 20 administrators, the longest-standing
  members first, through the same kill switch and tenant list and caps as the
  invitation, and never blocks the operation that triggered it.

### Azure Communication Services: data location and retention

The adapter sends over HTTPS through a connection string on a **dedicated
send-only** ACS resource restricted to the verified sender domain (SPF, DKIM
and DMARC aligned), with engagement and click tracking disabled. What leaves the
system for ACS is the recipient address, the fixed subject and body, and, for
an invitation, the accept link with its single-use token. Anyone who can read
the provider's message records can therefore read a live invitation token until
it is consumed or expires after 48 hours.

The data location of the ACS resource is fixed when the resource is created,
and the provider's own retention of message content and delivery logs is set by
Azure, not by Tayzu. Neither value is known to this repository. **Before the
first deployment (`010`), the operator records here the data location chosen
for the resource and the retention that Azure applies to message content and
delivery logs.** Until then this section is incomplete, and it is a gate, not
a statement of fact. Tayzu keeps no copy of an email's body: the non-sending
sender discards the message and the real sender stores nothing.

### Demo-tenant provisioning runbook

A demo tenant has a widely known login, so it must never cause a real send from
the Tayzu sender domain.

1. Provision the demo tenant.
2. Add its tenant id to `EMAIL_DISABLED_TENANT_IDS` (comma-separated, each
   entry a valid tenant id; a malformed entry fails startup).
3. Deploy a new app revision with the updated list. The list is read at
   startup.
4. Check that an invitation in the demo tenant logs
   `catalog.security.email_tenant_blocked` and sends nothing.

A listed tenant's email is suppressed before any cap is consumed and the
operation is not blocked (Resolved decision Q80).

## Canonical email form and rejected addresses

One canonical form of an address is used for the `_user` identifier, the Better
Auth email, the invitation email, the per-recipient cap key and the allowlist
domain: Unicode NFC, trimmed, lower-cased (`apps/api/src/identity/email-canonical.ts`).
`identity.users.invite` and `identity.users.create` answer
`CATALOG_VALIDATION_FAILED` for an address that the catalog's entity identifier
pattern cannot hold or that contains `/` (it cannot be a path segment). That
also excludes `+` aliases, so the per-recipient cap cannot be bypassed with
plus-addressing (Resolved decision Q33). It is a known limitation: some valid
addresses cannot be invited.

## Keyed hash of an invited email

`auth.rate_limit` persists the per-recipient bucket key, and it must not hold an
address or a bare digest, which anyone could recompute. The key is the
lowercase hex **HMAC-SHA256 of the canonical email** under
`IDENTITY_TOKEN_HMAC_SECRET` (`apps/api/src/identity/recipient-key.ts`,
Resolved decision Q93). The table then keeps that keyed hash, hashed again with
the scope into the bucket key. Rotating the secret changes every key, so every
recipient bucket resets; the owner and the rotation are in [Secrets](secrets.md).

## The `_user` reconcile

A member whose tenant has no usable `_user` row is rejected by the context
resolver with `user_missing` (Resolved decisions Q46 and Q50). The repair is the
`_user` reconcile, an operator-started job (design D9).

**Start.** Since `045`, the job is started only through the maintenance
workflow, with `job=reconcile-users`
([The `_user` backfill and reconcile](#the-_user-backfill-and-reconcile)): the
environment's reviewers are the **named second approver**, and the workflow
derives the operator id from its authenticated actor. Before `045`, an operator
started the job by hand as a Container Apps Job inside the VNET, under
just-in-time access (Azure PIM) with a personal account, and recorded the named
second approver in the change record. The entry point is `pnpm --filter @tayzu/api identity:reconcile-users`.
The job:

- holds `tayzu_app` and `tayzu_auth`, and no `BETTER_AUTH_SECRET`;
- reaches its own Cerbos sidecar at `CERBOS_ADDRESS` (loopback, no TLS);
- takes the operator's opaque id as `TAYZU_OPERATOR_ID` (1 to 128 of
  `A-Z a-z 0-9 _ . : -`, never an email) and refuses to run without it; the id
  is the `onBehalfOf` of its writes. The workflow sets it to
  `gh:<numeric GitHub actor id>` of its authenticated actor; set by hand before
  `045`, it was not authenticated, and the PIM record and the second approver
  were the control.

**What it does**, per tenant:

1. For every member with no `_user` row, it first runs the SSO link shed when
   the member holds two or more memberships, then creates the row through the
   adapter (a banned user ends `Disabled`).
2. It leaves an existing row untouched.
3. It removes **orphans**, counted in its result.

**Orphan rule.** An orphan is a human `_user` that is `Active` and has no
`member` row in its tenant. It is never an `Invited` or `Staged` row, nor a
service account. It is removed only once its **`updatedAt`**, which is its
activation, is **more than one hour old**, whatever its `createdAt` (Resolved
decisions Q84, Q89 and Q124). A failed new-account acceptance of an invitation
older than an hour therefore stays protected while a retry is in flight.

**Order.** The backfill and the reconcile run once per environment, after the
code that reads `accountKind` is deployed and before the release that carries
the `user_missing` rejection serves traffic in an environment that has
members, and before the mount switch is turned on.

## Off-boarding a disabled administrator

Disabling an administrator does not touch what they created. After the status
change:

1. **Service accounts and credentials.** List the credentials by the viewer's
   `createdBy` (the key's metadata records the admin who created or rotated
   it). For each, decide whether the integration still needs it; revoke it,
   or rotate it so that the new key is owned by a current admin.
2. **SSO links the admin recorded.** An admin can record an SSO `sub` on another
   user's account. Such a link has no provenance marker (a link the user made
   through the callback route has one). Find them through the
   `auth.security.account_linked` events whose `tayzu.auth.link.actor` is
   `admin` and whose `tayzu.actor.id` is the disabled admin, and unlink each
   one that is not wanted. A link that is left is shed when its user joins a
   second tenant, or refused at the SSO callback (see the last runbook below).

A filter of the viewer by creator is a ticket, not built.

## Failed acceptances

An acceptance has two paths (design D4). On the **new-account** path any
failure compensates the whole join. On the **existing-account** path a
compensation runs only for a failure **before the attempt's `_user` step**.

### Existing-account attempt that failed after its `_user` step

Since Resolved decision Q118 such an attempt keeps its membership and its
`Active` `_user` on purpose, so that a retry of the same invitation completes
it. It is **not repaired**. Since Resolved decision Q122 the attempt has
already revoked the accepting session and the one a previous attempt recorded,
and has sent the admin notice. A never-retried attempt leaves only the
`emailVerified` write and the consumption of the token undone, and **needs no
operator step**: the invitation expires after 48 hours.

### Compensation that failed

The alert on `catalog.security.invitation_accept_compensation_failed` starts
this runbook (Resolved decision Q100). The event carries only the invitation id.

1. Read the invitation by that id in `auth.invitation` for the organization
   and the email.
2. Find the user and the member rows for that email and organization.
3. If the invitation was on the **new-account** path and the user has **no
   membership**, remove the user, so that the invitee can be invited again.
4. If the invitation was on the **existing-account** path and a membership was
   left by the failed compensation, remove that membership.
5. Check that no `_user` row of the tenant stays `Active` for a user with no
   membership; the reconcile removes it after its grace hour.

### A second tenant's `Invited` row

A membership that a failed existing-account compensation left can carry an
unshed SSO link and live sessions. Its `_user` stays `Invited` when the shed or
the `_user` step failed, because the acceptance activates the row only after
the shed (Resolved decision Q112). The resolver rejects that member, and the
first-sign-in hook does not activate the row for a user of two or more tenants
(Resolved decision Q111). Choose one of the two repairs:

- **Retry** the same invitation within its 48 hours. The acceptance sheds the
  links on every attempt and then activates the row.
- **Remove the membership.** The new acceptance then runs the shed with its
  session revocation (Resolved decision Q105).

A new invitation, the membership hook and the reconcile do not reactivate an
existing membership.

### Revocation of the accepting session failed

The revocation runs right after the acceptance's `_user` step and its failure
does not stop the acceptance (Resolved decisions Q115 and Q122). The alert on
`catalog.security.accepting_session_revocation_failed` starts this runbook. The
event carries the tenant, the invitation id and an opaque user id.

1. Revoke the sessions of that user id (delete the user's rows in
   `auth.session`; each deleted row should be recorded as an
   `auth.security.session_revoked` event).
2. Delete the `invitation-shed:<invitationId>` record in `auth.verification`,
   found by the invitation id the event carries.
3. Check that no session of the user outlives the shed: neither the accepting
   session nor the one an earlier attempt kept.

### An SSO link that pre-dates this change on a user of two tenants

A link without a provenance marker is shed when its user joins a second tenant.
A user who **already** belongs to two tenants has no join, and the reconcile
sheds only before it creates a missing row, so no path sheds the link. The SSO
callback refuses every sign-in through an unmarked link of such a user. A
`/link-social` of the same `sub` only updates the existing row and writes no
marker, so it does not repair it. The repair (design D4 step 7):

1. The user **unlinks** the account (`/unlink-account`).
2. The user **links it again** through `/link-social`, which requires step-up.
   The new row is created from the callback route and carries a marker.
3. The user signs in through SSO again.

Users exist only after `010` (`002` Q78), so the impact is limited.

## First deployment: the bootstrap CLI

The bootstrap CLI creates the first administrator of an environment. It stays
**out of band**: an operator runs it once per environment, with no job and no
role of its own, under just-in-time access like any other operator access
(Resolved decision Q91).

1. Obtain just-in-time access with a personal account and record a named second
   approver.
2. Set the environment of the CLI: `DATABASE_URL` (`tayzu_app`),
   `AUTH_DATABASE_URL` (`tayzu_auth`), `BETTER_AUTH_SECRET`, `CERBOS_ADDRESS` and
   `TAYZU_OPERATOR_ID` (Resolved decision Q116). The CLI refuses to run
   without the operator id or with a malformed one, and it asserts its
   database roles at start. Never print these values.
3. Run `pnpm --filter @tayzu/api bootstrap:admin`.
4. The operator id is recorded as `tayzu.identity.operator.id` on the
   `catalog.audit.user_created` event and as the `onBehalfOf` of the membership
   hook's `_user` write for the bootstrap admin.
5. Record the run, the approver and the operator id in the change record.

The CLI prints a one-time temporary password, which the operator hands over
out of band and the administrator changes at once. A marker restricts the
session to the password change until then, and an expired marker blocks sign-in;
it expires 48 hours after creation (Resolved decisions Q36 and Q139).
