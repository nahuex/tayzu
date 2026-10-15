# Data retention and identity runbooks

Design D12 of `openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/design.md`
(task 16.5). This file holds the policies and operator runbooks of the identity
lifecycle: the credential rotation cadence, the invitation caps, the email
policy, the repairs for a failed acceptance, the off-boarding step and the
first-deployment run of the bootstrap CLI. Change `045-org-deletion-and-data-retention`
extends it with the retention policy, the erasure statement of org deletion and
the reversal runbook; nothing about org deletion is stated here yet.

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

**Start.** Until `045` adds the reviewed workflow, an operator starts the job as
a Container Apps Job inside the VNET, under just-in-time access (Azure PIM)
with a personal account, and records a **named second approver** in the change
record. The entry point is `pnpm --filter @tayzu/api identity:reconcile-users`.
The job:

- holds `tayzu_app` and `tayzu_auth`, and no `BETTER_AUTH_SECRET`;
- reaches its own Cerbos sidecar at `CERBOS_ADDRESS` (loopback, no TLS);
- takes the operator's opaque id as `TAYZU_OPERATOR_ID` (1 to 128 of
  `A-Z a-z 0-9 _ . : -`, never an email) and refuses to run without it; the id
  is the `onBehalfOf` of its writes and is not authenticated, so the PIM record
  and the second approver are the control.

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
