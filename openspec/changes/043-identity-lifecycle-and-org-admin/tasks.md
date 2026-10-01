# Tasks: 043-identity-lifecycle-and-org-admin

**How to execute these tasks (Agentic TDD).** Every task below, except the
tasks marked *(setup)*, is **one self-contained red-green-refactor cycle**:

1. **Red.** Write only the test named in the task's *Verify* clause. Run it
   and see it **fail for the expected reason**: a missing behavior, not a
   typo or a missing import. With the `test-writer`/`implementer` split, this
   step belongs to `test-writer`.
2. **Green.** Write the minimum production code that makes the test pass.
   Do not change the test.
3. **Refactor.** Clean up with every test green. Run
   `pnpm --filter <pkg> test`, `pnpm lint` and `pnpm typecheck`.
4. Tick the box only when all three steps are done, and commit with the task
   number (for example `feat(auth): 4.2 invite creates invited user`).

A task marked **(Checkpoint 3)** adds or changes a database migration or a
Cerbos policy: stop before it and present the SQL or the policy, with its
`cerbos compile` output, for the human's separate approval (root `CLAUDE.md`).

Tasks are written to the **recommended** option of each Open Question in
`design.md`. If the human picks another option, only the tasks the question names
change: task 9.5 and Question 3 (key expiry), 8.1 and 14.5 and Question 5
(password policy), 8.5 and Question 1 (existing-account invitee), 12.4 and
Question 4 (window default), 15.2 and Question 2 (step-up granularity).

**Order matters.** Group 14 (the hand-offs from `002`) comes before group 15,
the only group that registers routes over HTTP (`002` Q73, design D15). Groups 1
to 13 test in process through `createRouterClient` or the service layer, and no
HTTP assertion about an identity route is written before group 14 is done.

Scenario names in quotes refer to
`specs/identity-lifecycle-and-org-admin/spec.md`. Test files live next to the
code as `*.test.ts`. Integration tests are named `*.int.test.ts` and need
`DATABASE_URL` plus a running Cerbos test container, per `002`'s own harness.

## 1. Setup and coordination with `002`

- [ ] 1.1 *(setup)* The drift-check against the merged `002` was run on
  2026-10-01 and its mechanical fixes are in `design.md` (Context). At
  implementation time this task is a last drift-check of the files the design
  names (`user-sync.ts`, `identity-router.ts`, `context-resolver.ts`,
  `token-exchange.ts`, `server.ts`, `policies/`) and adjusts import paths and
  attribute names only if drift is found, with no scope change. Verify: a short
  note in the PR description states what, if anything, was adjusted.
- [ ] 1.2 *(setup)* The `vcdm-ssa-validator` pre-assessment in Mode A against
  the merged `002` was run on 2026-10-01 and its eleven blocking gaps (B1-B11)
  are folded into `design.md`, the spec and these tasks. Attach the report to
  the PR. Verify: the report is attached to the PR with zero open blocking gaps
  or an explicit deferral recorded.
- [ ] 1.3 *(setup)* Add `@azure/communication-email` (`1.1.0`) to
  `packages/auth/package.json`, and add the Communication Services connection
  string as a Key Vault secret reference, following `002`'s existing pattern
  for the database credential. Check its license, its install scripts (keep
  them blocked unless `allowBuilds` in `pnpm-workspace.yaml` must allow one) and
  its transitive dependencies. Verify: `pnpm install` succeeds, and
  `docs/security/dependencies.md` lists the new package with the license, the
  `allowBuilds` decision and the SBOM review.
- [ ] 1.4 *(setup)* Scaffold `packages/auth/src/identity/` (empty modules for
  `user-status.ts`, `invitations.ts`, `invitation-token.ts`,
  `service-accounts.ts`, `credentials.ts`, `org-deletion.ts`, `email/sender.ts`)
  with a trivial `smoke.test.ts`. Verify: `pnpm --filter @tayzu/auth test` runs
  the smoke test green.

## 2. `_user` blueprint extension (no migration)

- [ ] 2.1 `USER_BLUEPRINT` carries the optional `accountKind` (`"standard"` |
  `"service"`, default `"standard"`) and a four-value `status` enum (`Staged`,
  `Invited`, `Active`, `Disabled`, default `Staged`) for every new tenant.
  Verify: `user-blueprint.int.test.ts` covers that a new tenant's `_user`
  blueprint has both, and "New entity without a status starts staged".
- [ ] 2.2 A one-off, idempotent `tsx` script runs `blueprints.update` as the
  `system` actor once per existing tenant to bring `_user` forward. Verify:
  `user-blueprint.int.test.ts` seeds a tenant with the old schema and covers
  "adding accountKind and widening status is a compatible change": the update
  succeeds, existing `_user` entities stay valid and read back
  `accountKind: "standard"`, and a second run changes nothing.

## 3. User status state machine (pure)

- [ ] 3.1 `nextStatus(current, event)` for the creation events
  (`created_staged` from none → `Staged`, `created_invited` from none, `Staged`
  or `Invited` → `Invited`, `created_active` from none → `Active`). Verify:
  `user-status.test.ts` covers "New entity without a status starts staged",
  "Explicit invite starts a user as invited" and "A user created by an admin is
  active" at the pure level.
- [ ] 3.2 `nextStatus` for `first_sign_in` and `invitation_accepted` from
  `Staged` and `Invited` → `Active`, and rejection of both from `Disabled`.
  Verify: `user-status.test.ts` covers "First sign-in activates a staged or
  invited user" and "A disabled user is not revived by signing in or by a
  pending invitation" at the pure level.
- [ ] 3.3 `nextStatus` rejects any transition from `Active` to `Invited` or
  `Staged` by throwing a package-local `StatusTransitionError` whose
  `code` is `CATALOG_VALIDATION_FAILED` (no `@tayzu/catalog` dependency).
  Verify: `user-status.test.ts` covers "Active never regresses to invited or
  staged" and the error code.
- [ ] 3.4 `nextStatus` for `admin_disable` (from `Staged`, `Invited` and
  `Active`) and `admin_enable` (from `Disabled` only). Verify:
  `user-status.test.ts` covers "Disable and re-enable" and rejects
  `admin_enable` from a non-`Disabled` status.
- [ ] 3.5 `nextStatus` is exhaustive: every `(status, event)` pair not
  explicitly allowed throws `StatusTransitionError`, never returns
  `undefined`. Verify: `user-status.test.ts` iterates the full matrix (`null`
  and the four statuses against the seven events) and asserts every cell is
  either an allowed transition or an explicit rejection.

## 4. Every status writer goes through the state machine

- [ ] 4.1 `UserSyncInput.status` is widened to the four values and `userSync`
  takes a `StatusEvent` and writes the result of `nextStatus`, never a raw
  status. Verify: `user-sync.int.test.ts` covers a write for each allowed event
  and a rejected `Active` → `Staged` write.
- [ ] 4.2 `afterAddMember` writes through `invitation_accepted` (or
  `created_active` for an admin-added member) instead of `Active` directly, so
  adding a membership never revives a `Disabled` user. Verify:
  `auth-hooks.int.test.ts` covers "A disabled user is not revived by a hook".
- [ ] 4.3 `identity.users.create` writes through `created_active`. Verify:
  `identity-router.int.test.ts` covers "A user created by an admin is active".
- [ ] 4.4 A first-sign-in hook writes `first_sign_in` for a `Staged` or
  `Invited` user, and leaves a `Disabled` user `Disabled`. Verify:
  `first-sign-in.int.test.ts` covers "First sign-in activates a staged or
  invited user".
- [ ] 4.5 The ban hook writes `admin_disable` and `admin_enable` through the
  state machine instead of `Disabled`/`Active` directly. Verify:
  `ban-hook.int.test.ts` covers that banning sets `Disabled`, unbanning sets
  `Active`, and unbanning a `Staged` user is rejected.

## 5. Cerbos foundations, ⛔ Checkpoint 3

- [ ] 5.1 `RESOURCE_KINDS` gains `service_account`, `credential` and
  `organization`, and the identity router builds Cerbos attributes from a
  resolved target: `accountKind`, `portRole`, `moderatedBlueprints` and the
  target's **real tenant** (an invitation's `organizationId`, an API key's
  `referenceId`, the user's membership), never `ctx.tenantId` echoed back.
  Verify: `identity-attributes.test.ts` covers that the attributes carry the
  target's tenant and the three attributes, and `resource-kinds.test.ts` that
  the kinds exist.
- [ ] 5.2 Every target of an `identity.*` operation is resolved on the server by
  one helper, and a target of another tenant answers `CATALOG_NOT_FOUND`,
  identical to a nonexistent id; `tenantId` and `actor` are never read from
  input. Verify: `identity-target.int.test.ts` covers a foreign and an unknown
  invitation, credential and user answering the same, and a body with a
  `tenantId` field being rejected.
- [ ] 5.3 The identity router emits `catalog.security.authz_denied` and
  increments `tayzu.authz.decisions` on every Cerbos deny (it threw silently
  before). Verify: `identity-router.int.test.ts` covers that a denied call logs
  the event, with no email or identifier of the target.
- [ ] 5.4 (Checkpoint 3) Cerbos policy: `user.invite` (which also covers cancel
  and resend) and `user.updateStatus` on resource kind `user`, importing
  `002`'s `same_tenant` derived role. `user.yaml` already allows `*` to admin,
  so the new content is an `EFFECT_DENY` for `updateStatus` when `R.id == P.id`.
  Verify: `cerbos compile` runs `user_test.yaml` covering both actions ×
  admin/non-admin × self/non-self × same/other tenant. ⛔ **Stop for
  Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 5.5 (Checkpoint 3) Cerbos policy: an `EFFECT_DENY` rule on `user.yaml` for
  any action when `R.attr.accountKind == "service"` and (`R.attr.portRole !=
  "member"` or `R.attr.moderatedBlueprints` is non-empty), using the resulting
  values (design D3, Resolved decisions Q7 and Q16). Verify: `cerbos compile`
  runs `user_test.yaml`'s cases for a service-account resource denied `admin`
  and denied a non-empty `moderatedBlueprints` while an equivalent standard
  account is unaffected, and `service-account-ceiling.int.test.ts` runs the
  same inputs against the real Cerbos container, including as the `system`
  actor ("The Cerbos ceiling denies an elevated service-account resource").
  ⛔ **Stop for Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 5.6 (Checkpoint 3) Role ceilings: `policies/role_policies/admin.yaml`
  lists `service_account`, `credential` (including `create`) and
  `organization` explicitly, `member.yaml` states the ceiling if one is needed,
  and `role_policies_test.yaml` is extended. Verify: `cerbos compile` runs
  `role_policies_test.yaml` showing an admin is allowed and a member is denied
  on each new kind and action. ⛔ **Stop for Checkpoint 3 approval of the policy
  diff before continuing.**

## 6. Invitation email and caps

- [ ] 6.1 `EmailSender` port (one `send(to, template)`; no CC, BCC or
  attachment field) with a recording fake, and a recipient validator: a single
  plain address, no CR/LF, no display name, no list separator, at most 254
  characters. Verify: `email-sender.test.ts` covers "Injection through the
  invited address is impossible" for each rejected shape, and that the fake
  records `to`, link and expiry text.
- [ ] 6.2 The invitation email template has a fixed subject and a fixed body,
  interpolates only the link and the expiry text, and contains exactly one
  clickable link. Verify: `invitation-email-template.test.ts` covers "The
  template carries no free text" (an organization named `<b>Pay now</b>` and a
  markup-bearing inviter name never appear) and "Invite sends exactly one email
  with exactly one link" by parsing the rendered HTML and text.
- [ ] 6.3 The link origin comes from `BETTER_AUTH_URL`, never from `Host` or a
  forwarded header, and the invitation id and token travel in the URL
  fragment. Verify: `invitation-link.test.ts` covers "The link origin ignores
  the request headers" with forged `Host` and `X-Forwarded-Host`, and asserts
  the id and token are after the `#`.
- [ ] 6.4 `AzureCommunicationEmailSender` (the real adapter over
  `@azure/communication-email`), constructed from the Key Vault-backed
  connection string, never called in CI, with provider errors sanitized so no
  address or message text leaves it. Verify: `azure-email-sender.test.ts`
  covers construction and config parsing (no network call) and "The email
  provider's failure never leaks" with a stubbed client whose error contains the
  recipient; a documented manual smoke-check script exists for a real sandbox
  account outside CI.
- [ ] 6.5 Outside test, startup fails without a real `EmailSender`, and CI and
  DAST wire a non-sending one. Verify: `config.test.ts` (in `apps/api`) covers
  that production configuration without a provider throws at startup and that
  the test configuration selects the recording fake.
- [ ] 6.6 A per-tenant cap of 30 invitation emails per hour, shared by invite and
  resend, on a store interface (in memory in tests), with its default in
  `apps/api/src/config.ts`. Exceeding it fails with `AUTH_RATE_LIMITED`, sends
  nothing and logs `catalog.security.invitation_rate_limited` with scope
  `tenant`. Verify: `invitation-caps.test.ts` covers "Exceeding the per-tenant
  cap blocks further invites", asserting the `EmailSender` fake recorded no
  further call.
- [ ] 6.7 A per-recipient cap of 3 per 24 hours across all tenants, keyed by the
  sha256 of the normalized email. Verify: `invitation-caps.test.ts` covers
  "Exceeding the per-recipient cap blocks repeat invites across tenants",
  asserting scope `recipient` and that no address is in the event or the key
  store.
- [ ] 6.8 A global kill switch (`INVITATION_EMAIL_KILL_SWITCH`). Verify:
  `invitation-caps.test.ts` covers "The global kill switch stops all invitation
  email" with scope `global`.
- [ ] 6.9 A disabled or zero cap fails startup (`002` Q39). Verify:
  `config.test.ts` covers a zero or disabled value for each cap throwing at
  startup.

## 7. Invitation lifecycle

- [ ] 7.1 `invitation-token.ts`: 256 bits from a CSPRNG, `sha256` digest for
  storage, constant-time comparison over equal-length digests, and a dummy
  comparison for a missing record. Verify: `invitation-token.test.ts` covers
  token length and uniqueness, that only the digest is derivable for storage,
  that comparison is constant-time (`timingSafeEqual`) and that a missing record
  still performs one comparison.
- [ ] 7.2 Configure Better Auth's `organization` invitation options
  (`invitationExpiresIn` 48 hours, `cancelPendingInvitationsOnReInvite: true`;
  `requireEmailVerificationOnInvitation` is not used because the native accept
  route stays off the allowlist), and the boundary mapper (`canceled` →
  `cancelled`, `expired` derived from `expiresAt`). Verify:
  `invitation-config.int.test.ts` asserts the 48-hour `expiresAt` on a real
  invitation and the mapped states.
- [ ] 7.3 `identity.users.invite`: creates a Better Auth invitation, stores the
  token digest in `auth.verification` (identifier
  `invitation-accept:<invitationId>`, same expiry), creates or updates the
  `_user` entity to `Invited` through `created_invited` as `system` with
  `onBehalfOf` the admin, and sends exactly one email. Verify:
  `invitations.int.test.ts` covers "Invite sends exactly one email with exactly
  one link" and "Explicit invite starts a user as invited", using the recording
  fake.
- [ ] 7.4 The invited role is `member` or `admin`, never `owner`, and is
  logged on `catalog.audit.invitation_created`. Verify: `invitations.int.test.ts`
  covers "Inviting with the owner role is rejected" (and any other value) and
  "An admin invitation is logged with its role".
- [ ] 7.5 Re-inviting an email that has a `pending` invitation cancels the
  previous invitation (reason `re_invite`) and creates a fresh one. Verify:
  `invitations.int.test.ts` covers "Re-inviting cancels the previous
  invitation".
- [ ] 7.6 `identity.users.cancelInvitation`, Cerbos-gated to admins through
  `user.invite`, resolving the invitation on the server. Verify:
  `invitations.int.test.ts` covers "Admin can cancel a pending invitation".
- [ ] 7.7 `identity.users.resendInvitation` issues a **new** token (the old one
  stops working), keeps the original expiry and sends one email. Verify:
  `invitations.int.test.ts` covers "Resending issues a new link and keeps the
  expiry".
- [ ] 7.8 An invitation for an email whose existing user is `Disabled` is
  refused and sends nothing. Verify: `invitations.int.test.ts` covers "A
  disabled user cannot be invited".
- [ ] 7.9 A non-admin attempting `identity.users.invite` is denied with
  `AUTH_FORBIDDEN`, no invitation is created and `catalog.security.authz_denied`
  is logged. Verify: `invitations.int.test.ts` covers "Non-admin cannot invite"
  against the real Cerbos container.

## 8. Invitation acceptance

- [ ] 8.1 A password policy module: minimum 12 characters and a bundled
  common-password denylist, with no external call and no new dependency
  (Open Question 5). Verify: `password-policy.test.ts` covers a short password, a
  denylisted one and a compliant one.
- [ ] 8.2 `identity.users.acceptInvitation` for an email with no account: verifies
  the token, creates the user (global role `user`), sets the password the
  invitee supplied under the policy, marks the email verified, adds the
  membership with the invited role, writes the status through
  `invitation_accepted` and creates **no session**. Verify:
  `invitation-accept.int.test.ts` covers "A new person accepts and can then sign
  in" (sign-in through the normal route succeeds afterward).
- [ ] 8.3 The token works exactly once (one atomic delete-and-return). Verify:
  `invitation-accept.int.test.ts` covers a second acceptance with the same
  token failing, including two concurrent attempts where exactly one succeeds.
- [ ] 8.4 The tenant is derived from the invitation record, and a body that
  carries a tenant or an actor is rejected (null-prototype parse, `__proto__`,
  `constructor` and `prototype` rejected at every depth). Verify:
  `invitation-accept.int.test.ts` covers "The tenant comes from the invitation".
- [ ] 8.5 For an email that already has an account, acceptance never sets or
  changes a password and answers like any rejected acceptance. Verify:
  `invitation-accept.int.test.ts` covers "Acceptance does not touch an existing
  account". (The authenticated second variant of Open Question 1 is built only
  after the human answers.)
- [ ] 8.6 Acceptance never links an account by an email claim. Verify:
  `invitation-accept.int.test.ts` covers "Acceptance does not link an SSO
  account by email" (no `account` row for the SSO provider exists afterward).
- [ ] 8.7 Every rejected acceptance (nonexistent, expired, cancelled, rejected,
  already accepted, wrong token, `Disabled` user) returns the same status, error
  code (`CATALOG_NOT_FOUND`) and body shape, while
  `catalog.security.invitation_acceptance_denied` records the specific
  `denial_reason`. Verify: `invitation-accept.int.test.ts` covers "Acceptance
  errors do not reveal which failure occurred" over the full matrix.
- [ ] 8.8 A nonexistent invitation performs the same digest comparison as a wrong
  token. Verify: `invitation-accept.int.test.ts` spies on the comparison and
  asserts one comparison in both cases.
- [ ] 8.9 Accepting an expired invitation fails, the invitation reads as
  `expired` and the user's status is unchanged. Verify:
  `invitation-accept.int.test.ts` covers "Accepting an expired invitation
  fails", using a clock seam to advance past 48 hours.
- [ ] 8.10 A cancelled or already-accepted invitation fails, and a wrong token
  leaves the invitation `pending`. Verify: `invitation-accept.int.test.ts`
  covers "Accepting a cancelled or already-accepted invitation fails" and "A
  wrong token fails".
- [ ] 8.11 A pending invitation of a user who was disabled afterward does not
  revive them. Verify: `invitation-accept.int.test.ts` covers "A disabled user
  is not revived by a pending invitation".
- [ ] 8.12 A password that fails the policy is reported only after the token
  has verified. Verify: `invitation-accept.int.test.ts` asserts a bad password
  with a wrong token returns the generic rejection, and with a valid token
  returns `CATALOG_VALIDATION_FAILED` without consuming the token.
- [ ] 8.13 The public accept route has its own path-keyed `createRateLimit`
  preHandler keyed on the parsed pathname, like token exchange, with its default
  in `apps/api/src/config.ts`. Verify: `accept-rate-limit.test.ts` covers "The
  accept route is rate-limited" on the preHandler alone, asserting the limit
  fires before any invitation lookup (the route is not mounted here).

## 9. Org API credentials: viewer, create, rotate and revoke

- [ ] 9.1 (Checkpoint 3) Cerbos policy: `credential.list`, `create`, `rotate` and
  `revoke` on resource kind `credential`, importing `002`'s `same_tenant`
  derived role, `admin`-only. Verify: `cerbos compile` runs
  `credential_test.yaml` covering each action × admin/non-admin × same/other
  tenant. ⛔ **Stop for Checkpoint 3 approval of the policy diff before
  continuing.**
- [ ] 9.2 `identity.credentials.list`: projects org-owned API keys to
  `{ name, kind, prefix, createdAt, lastRequest, enabled, rotationDueAt }`,
  filtered to `referenceId = ctx.tenantId`, joining `metadata.userId` to the
  `_user` entity for service-account keys, and never selecting the hashed `key`
  column into the response shape. Verify: `credentials.int.test.ts` covers
  "Listing never includes the secret" and "Non-admin cannot list credentials".
- [ ] 9.3 A credential is shown disabled when its key is disabled, it is
  revoked, or its bound service account is `Disabled`. Verify:
  `credentials.int.test.ts` covers each of the three cases.
- [ ] 9.4 `rotationDueAt` is computed from the credential's `metadata.rotatedAt`
  plus the configured interval (default 90 days). Verify: `credentials.test.ts`
  (pure) covers a credential rotated 91 days ago flagged due and one rotated
  yesterday not.
- [ ] 9.5 `identity.credentials.create` (integration and agent credentials):
  sets the per-key rate limit explicitly (not Better Auth's 10 per 24 hours),
  does not store the first characters of the secret, applies no hard expiry
  (Open Question 3), and uses metadata `{ actorKind, role: 'member', userId? }`.
  Verify: `credentials.int.test.ts` covers "Creating a credential requires
  step-up and bounds its use": the created key has the configured limit and
  stores no secret characters.
- [ ] 9.6 `identity.credentials.rotate`: creates the new credential, revokes the
  old one through `revokeMachineCredential` (the revocation list), and returns
  the new secret once. Verify: `credentials.int.test.ts` covers "Rotating
  replaces the usable credential", asserting the old credential's already-issued
  token and any new exchange are rejected within the cache window.
- [ ] 9.7 If revoking the old credential fails, the new one is revoked and the
  operation fails. Verify: `credentials.int.test.ts` covers "A failed rotation
  leaves no second usable credential" with a failure seam on the revoke.
- [ ] 9.8 If compensation also fails,
  `catalog.security.credential_rotation_incomplete` is logged with both opaque
  identifiers. Verify: `credentials.int.test.ts` covers "A rotation that cannot
  compensate is signalled".
- [ ] 9.9 `identity.credentials.revoke`: permanent; the credential can never be
  restored, and revoking an already revoked credential is a no-op. Verify:
  `credentials.int.test.ts` covers "Revoking a credential is permanent".
- [ ] 9.10 Rotation and revocation log events carry only opaque credential
  identifiers, never a secret, even under a forced serialization of the full
  credential object. Verify: `credentials.int.test.ts` covers a marker-leak
  check: a credential secret string never appears in the
  `catalog.audit.credential_rotated` or `catalog.security.credential_revoked`
  record.

## 10. Service accounts

- [ ] 10.1 Service-account identifier pattern `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`,
  validated at creation. Verify: `service-accounts.test.ts` covers acceptance
  of `svc-ci-github` and rejection of `ci-github` (missing prefix) and an
  over-length identifier.
- [ ] 10.2 (Checkpoint 3) Cerbos policy: `service_account.create` and `delete`
  on resource kind `service_account`, importing `002`'s `same_tenant` derived
  role, `admin`-only. Verify: `cerbos compile` runs `service_account_test.yaml`
  covering each action × admin/non-admin × same/other tenant. ⛔ **Stop for
  Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 10.3 `identity.serviceAccounts.create`: writes the `_user` entity
  (`status: Active`, `accountKind: "service"`, role `member`, empty
  `moderatedBlueprints`) as `system` with `onBehalfOf` the admin, and issues an
  organization-owned key by reusing `002`'s `machine-credential` apiKey config
  (metadata `{ actorKind: 'integration', role: 'member', userId }`, `userId`
  being the entity's opaque id), returning `clientId`/`clientSecret` once.
  Verify: `service-accounts.int.test.ts` covers "Service account is active
  immediately, no email", asserting the `EmailSender` fake recorded zero calls
  and that a later read never includes the secret.
- [ ] 10.4 Creation validates the requested role and `moderatedBlueprints`: only
  `member` and an empty list are accepted, before the `_user` or the credential
  exists. Verify: `service-accounts.int.test.ts` covers "Creating a service
  account with an elevated role is rejected", asserting nothing is created.
- [ ] 10.5 A non-admin attempting `identity.serviceAccounts.create` is denied.
  Verify: `service-accounts.int.test.ts` covers "A non-admin cannot create a
  service account" against the real Cerbos container.
- [ ] 10.6 Token exchange adds `userId` as an attribution claim only, and the
  principal stays `{ roles: ['member'], teams: [], moderatedBlueprints: [] }`
  from the signed claim. Verify: `token-exchange.int.test.ts` covers "A tampered
  `_user` row does not raise the principal".
- [ ] 10.7 `identity.serviceAccounts.delete`: revokes the credential through the
  revocation list, then removes the `_user` entity as `system` with `onBehalfOf`
  the admin. Verify: `service-accounts.int.test.ts` covers "Deleting a service
  account revokes its credential", asserting the credential cannot be restored.

## 11. Disable takes effect immediately, ⛔ Checkpoint 3 (migration `0011`)

- [ ] 11.1 (Checkpoint 3) Migration `0011_machine_credential_revocation_tenant_key`:
  `machine_credential_revocation` gets a composite `(tenant_id, credential_id)`
  key, with `migrations/down/0011.down.sql`, `meta/0011_snapshot.json` and its
  `_journal.json` entry, and the revocation lookups key on both columns.
  Verify: `revocation-key.int.test.ts` covers that a row for `(t2, c1)` neither
  blocks nor shadows `(t1, c1)`, and that a lookup for `t1` ignores `t2`'s row.
  ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 11.2 `identity.users.setStatus` for a human: validates through
  `nextStatus`, checks the Cerbos grant, calls `banUser`/`unbanUser` (which
  revokes the user's sessions), and writes `_user.status` as `system` with
  `onBehalfOf` the admin, appending a change event. Verify:
  `user-status-op.int.test.ts` covers "Disable and re-enable" and "A disabled
  user's sessions stop working" through the operation pipeline.
- [ ] 11.3 A user attempting to change their own status is denied and a
  `catalog.security.self_status_change_denied` event is logged. Verify:
  `user-status-op.int.test.ts` covers "A user cannot disable themselves".
- [ ] 11.4 Disabling a user cancels their pending invitations (reason
  `user_disabled`). Verify: `user-status-op.int.test.ts` covers "Disabling
  cancels pending invitations".
- [ ] 11.5 `identity.users.setStatus` for a service account (its `svc-…`
  identifier) writes only `_user.status` (it has no Better Auth user). Verify:
  `user-status-op.int.test.ts` covers disable and enable of a service account
  changing only the `_user` entity.
- [ ] 11.6 `resolveContext`'s machine branch rejects a principal whose bound
  `_user` (from the `userId` claim) is `Disabled`, through the 5-second cache,
  failing closed on any lookup failure, and logs
  `catalog.security.principal_rejected` and increments
  `tayzu.identity.principal_rejections`. Verify: `context-resolver.int.test.ts`
  covers "Disabling a service account takes effect within seconds" for an
  already-issued token, and a lookup failure rejecting.
- [ ] 11.7 Token exchange refuses to mint a token for a `Disabled` service
  account, and re-enabling restores the same credential. Verify:
  `token-exchange.int.test.ts` covers the refusal and "Re-enabling restores
  access without a new credential".

## 12. Org deletion, two phases, ⛔ Checkpoint 3 (migration `0012`)

- [ ] 12.1 (Checkpoint 3) Migration `0012_tenant_deletion`: a deletion-marker
  table (tenant id, requested-at, `purge_after`, the requesting actor's opaque
  id, step progress) and a `SECURITY DEFINER` function owned by
  `tayzu_migrator` that deletes a tenant's append-only rows
  (`catalog_change_event` and `machine_credential_revocation`) **only** when
  that tenant's marker is due, with `PUBLIC` denied `EXECUTE` and the
  executing role chosen at the review (proposal: `tayzu_app` only). It carries
  `migrations/down/0012.down.sql`, `meta/0012_snapshot.json` and its
  `_journal.json` entry. Verify: `tenant-deletion-migration.int.test.ts` covers
  that a tenant without a due marker cannot be purged, that a due tenant's change
  events and revocation rows are removed, that a direct `DELETE` by `tayzu_app`
  is still refused, and that `PUBLIC` cannot execute the function. ⛔ **Stop for
  Checkpoint 3 approval of the SQL before continuing.**
- [ ] 12.2 (Checkpoint 3) Cerbos policy: `organization.delete` on resource kind
  `organization`, importing `002`'s `same_tenant` derived role, `admin`-only.
  Verify: `cerbos compile` runs `organization_test.yaml` covering
  admin/non-admin × same/other tenant. ⛔ **Stop for Checkpoint 3 approval of
  the policy diff before continuing.**
- [ ] 12.3 `identity.organization.delete` requires the caller to send the
  organization's identifier, which must equal the host `ctx.tenantId`. Verify:
  `org-deletion.int.test.ts` covers "Org deletion targets only the host
  tenant" and a missing or wrong confirmation returning
  `CATALOG_VALIDATION_FAILED`, asserting nothing changes.
- [ ] 12.4 Phase 1 records the marker with a `purge_after` inside the configured
  window (7 to 14 days, validated at startup, default 14), revokes every
  session whose active organization is the tenant, revokes every org-owned
  credential through the revocation list, cancels pending invitations, and logs
  `catalog.audit.org_deletion_requested`. Verify: `org-deletion.int.test.ts`
  covers the data-still-present and marker parts of "Requesting deletion
  revokes access at once", and a window outside 7 to 14 failing startup.
- [ ] 12.5 Requesting deletion again while pending changes nothing and returns
  the original date. Verify: `org-deletion.int.test.ts` covers "Requesting
  deletion twice returns the original date", in process.
- [ ] 12.6 `resolveContext` and token exchange reject every principal, human or
  machine, of a tenant with a deletion marker, logging
  `catalog.security.principal_rejected` with reason `tenant_pending_deletion`.
  Verify: `org-deletion.int.test.ts` covers the access part of "Requesting
  deletion revokes access at once" for a session and an already-issued machine
  token.
- [ ] 12.7 Purge step 1 (`tayzu_app`): ordered deletes of the tenant's relations,
  entities, blueprints and other `catalog_*` rows that respect the `RESTRICT`
  foreign keys, and the append-only rows through the function of 12.1, recording
  progress on the marker. Verify: `org-purge-catalog.int.test.ts` covers
  "Purge removes tenant data after the window" for the catalog side on a tenant
  seeded with relations, entities, blueprints and change events.
- [ ] 12.8 Purge step 2 (`tayzu_auth`): the tenant's invitations, API keys
  (`referenceId`), invitation tokens in `auth.verification`, members, each user
  with no other membership together with their `account`, `session` and
  `twoFactor` rows, and the organization row last. Verify:
  `org-purge-auth.int.test.ts` covers "Users with no other membership are
  removed, others are kept".
- [ ] 12.9 `catalog.audit.org_deletion_completed` is emitted by the purge
  immediately before the organization row is deleted (not from Better Auth's
  `afterDeleteOrganization`). Verify: `org-purge-auth.int.test.ts` asserts the
  log record precedes the row's disappearance, using the telemetry harness's
  in-memory log exporter.
- [ ] 12.10 A failed step logs `catalog.security.org_deletion_failed` with the
  step, and the next run resumes without repeating a completed step. Verify:
  `org-purge-resume.int.test.ts` covers "A failed purge step is visible and
  resumes" with a failure seam after step 1.
- [ ] 12.11 A tenant whose window has not passed is never purged, a tombstone
  (tenant id and timestamps only) remains, and a repeated purge deletes
  nothing. Verify: `org-purge-resume.int.test.ts` covers "A purge does not touch
  a tenant whose window has not passed" and "A repeated purge is safe".
- [ ] 12.12 The purge job entry point: a `tsx` script run by a scheduled job,
  with no HTTP listener, that runs one pass over the due tenants. Verify:
  `purge-job.int.test.ts` runs the script once against a due tenant, asserts it
  is purged, and asserts the process opened no listener.

## 13. Cross-tenant matrix (one test per route, in process)

All tests live in `cross-tenant.int.test.ts` and seed two tenants.

- [ ] 13.1 `identity.users.invite` creates the invitation only in the host
  tenant and rejects a body that names an organization. Verify: an invitation
  created by `t1`'s admin has `organizationId = t1`, and a body with an
  organization or tenant field is rejected.
- [ ] 13.2 `identity.users.cancelInvitation` and `resendInvitation` on another
  tenant's invitation answer `CATALOG_NOT_FOUND`, the same as an unknown id.
  Verify: "Another tenant's invitation cannot be cancelled, resent or accepted"
  for cancel and resend, asserting the invitation is unchanged and no email was
  sent.
- [ ] 13.3 `identity.users.acceptInvitation` for an invitation of `t2` creates
  the membership only in `t2`. Verify: the accept of `t2`'s invitation leaves
  `t1` without a new member and no cross-tenant write.
- [ ] 13.4 `identity.users.setStatus` on another tenant's user, or on a user with
  memberships in two tenants, is refused. Verify: "Another tenant's user cannot
  have its status changed" and "A user with memberships in two tenants is
  refused".
- [ ] 13.5 `identity.serviceAccounts.create` creates only in the host tenant, and
  `delete` of another tenant's service account answers `CATALOG_NOT_FOUND`.
  Verify: the created entity and key are in `t1`, and the foreign delete leaves
  the service account and its credential intact.
- [ ] 13.6 `identity.credentials.list` and `create`: the list omits other
  tenants' credentials and create writes only the host tenant's `referenceId`.
  Verify: "Another tenant's credential cannot be listed, rotated or revoked" for
  list, and the created key's `referenceId` is `t1`.
- [ ] 13.7 `identity.credentials.rotate` and `revoke` on another tenant's
  credential answer `CATALOG_NOT_FOUND`. Verify: the same scenario for rotate
  and revoke, asserting the credential is still usable and no revocation row was
  written.
- [ ] 13.8 `identity.organization.delete` with another tenant's identifier fails
  and `deleteOrganization` is given the host tenant only. Verify: "Org deletion
  targets only the host tenant", asserting neither tenant has a marker.
- [ ] 13.9 Cerbos receives the target's real tenant, not the caller's. Verify: a
  call whose target belongs to `t2` reaches Cerbos with resource tenant `t2`
  (a recording Cerbos client), and the `same_tenant` policy denies it.

## 14. Hand-offs from 002 (002 design Q73; mount gate)

`identity.*` and the machine-credential routes are not mounted over HTTP before
every task in this group is done. Group 15 is the only place a route is
registered.

- [ ] 14.1 The `002` machine-credential create and revoke operations go through
  Cerbos (the `credential` policy of 9.1) and are marked `x-tayzu-risk: high`,
  and a Better Auth `admin` member (not only `owner`) is tested because Better
  Auth's own check is owner-only (`002` residual risk). The composite key is
  11.1. Verify: `machine-credentials.int.test.ts` covers a non-admin denied
  create and revoke, and a Better Auth `admin` member allowed through Cerbos
  only.
- [ ] 14.2 Identity operations refuse a target that has a membership outside the
  caller's tenant, so an admin of one tenant cannot link an SSO `sub` to, or
  otherwise act on, a user who also belongs to another tenant (`002` VCDM
  M10). Verify: `identity-router.int.test.ts` covers `linkSsoAccount` on a
  two-tenant user being refused.
- [ ] 14.3 `createUser` and `linkSsoAccount` give no email or `sub` existence
  oracle, and the user, credential and bootstrap lifecycle events declared in
  the contract are emitted (`002` Q42). Verify: `identity-router.int.test.ts`
  covers "Create and link give no existence oracle", and each lifecycle action
  emitting its declared event.
- [ ] 14.4 `resolveContext` rejects a disabled (`banned`) user, so existing
  sessions and any new sign-in, local or through SSO, stop granting access
  (`002` VCDM M20). Verify: `context-resolver.int.test.ts` covers "A disabled
  user's sessions stop working" and `catalog.security.principal_rejected` being
  logged.
- [ ] 14.5 Temporary and bootstrap passwords force a change at first sign-in and
  expire, and the password policy of 8.1 applies to them (`002` VCDM M5,
  M11). Verify: `temporary-password.int.test.ts` covers that a temporary
  password grants only the change-password route and expires.
- [ ] 14.6 Inherited ownership is reachable or explicitly removed from the spec,
  and a `replace`-mode upsert without `ownerTeam` cannot silently release
  ownership; authorization and the write run in one transaction (`002` VCDM
  M4, M15). Verify: the corresponding scenarios pass.
- [ ] 14.7 Keys created by `002`'s machine-credential path get the explicit
  per-key rate limit and no stored first characters (`002` residual risk).
  Verify: `machine-credentials.int.test.ts` covers the configured limit and an
  empty stored start on a created key.

## 15. API contract and mount gate

- [ ] 15.1 oRPC procedures for all twelve operations in design D10, each
  declaring `.route({ method, path, spec })` like
  `packages/catalog/src/api/contract.ts`. Verify: `router.int.test.ts` calls each
  procedure once on its happy path through `createRouterClient`, and
  `openapi.test.ts` asserts the generated document lists the twelve routes with
  their methods and paths.
- [ ] 15.2 `x-tayzu-risk: high` on every operation in the set (`setStatus`,
  `invite`, `identity.users.create`, `serviceAccounts.create`/`delete`,
  `credentials.create`/`rotate`/`revoke`, `organization.delete`, and the
  existing SSO link and unlink), per Open Question 2's recommended option.
  Verify: `openapi.test.ts` covers "Every route in the high-risk set is marked".
- [ ] 15.3 `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), **off by
  default**: with it off every identity route (including the public accept
  route) and the machine-credential create and revoke routes answer 404, and no
  such route is registered outside the switch. Verify: `mount-gate.int.test.ts`
  covers "Routes answer 404 while the switch is off" and "No route is registered
  outside the switch" by enumerating the route table.
- [ ] 15.4 Step-up over HTTP with the switch on: an admin session without a fresh
  MFA verification gets `AUTH_STEP_UP_REQUIRED` for each high-risk route and
  nothing changes. Verify: `step-up.http.int.test.ts` covers "A hijacked admin
  session without a fresh MFA cannot mint power" over the mounted server.
- [ ] 15.5 Error mapping over HTTP: `AUTH_FORBIDDEN` and `AUTH_STEP_UP_REQUIRED`
  are 403, `AUTH_RATE_LIMITED` is 429, a foreign or unknown target is 404.
  Verify: `errors.http.int.test.ts` covers each over the mounted server, and
  that the accept route's rejections are all the same 404.
- [ ] 15.6 `{user}` is the `_user` entity identifier (an email or `svc-…`) sent
  unencoded, and a path containing `%` answers 404 (`002` Q74). Verify:
  `user-path.http.int.test.ts` covers `PUT /v1/users/{email}/status` and
  `PUT /v1/users/svc-ci-github/status` resolving, and a `%` path being 404.

## 16. Telemetry contract enforcement

- [ ] 16.1 Extend `@tayzu/auth`'s `telemetry/contract.ts` with every span, metric
  and log event from design.md's Observability contract, and make
  `otel-smoke-check` import it in addition to `@tayzu/authz`'s contract.
  Verify: `contract.test.ts` snapshot-asserts every declared name, and
  `otel-smoke-check.int.test.ts` fails when a declared name is missing from the
  imported contract.
- [ ] 16.2 Extend `otel-smoke-check` to run every operation in this change once
  successfully and once per applicable error or denial class. Verify:
  `pnpm otel-smoke-check` is green, and removing one declared span in a scratch
  branch makes it fail.
- [ ] 16.3 Extend the cardinality guard to `tayzu.identity.*` metrics: no
  attribute key outside the contract's allowed set. Verify: `otel-smoke-check`
  fails when a deliberately added `tayzu.identity.invitation.email` metric
  attribute is introduced in a scratch branch.
- [ ] 16.4 Marker-leak test across this change's signals, in memory. Verify:
  `otel-smoke-check` covers "Invited email never reaches telemetry" for an
  invite, an expired-acceptance attempt, a rate-limited invite, a credential
  rotation (secret value as the marker), and "The email provider's failure never
  leaks".
- [ ] 16.5 For the routes of this capability the exported HTTP path is the route
  template, so no email, invitation id or credential id leaves the process, and
  the marker test runs through the real HTTP server and instrumentation.
  Verify: `telemetry-paths.http.int.test.ts` covers "A path identifier never
  reaches telemetry over HTTP" for `PUT /v1/users/{marker-email}/status` and a
  credential route with a marker id.
- [ ] 16.6 Every lifecycle action emits its declared event: user and bootstrap
  creation, status change, service-account disable, enable and deletion,
  invitation resend, credential creation, rotation and revocation, and org
  deletion requested, completed and failed. Verify:
  `identity-events.int.test.ts` covers "Each lifecycle action emits its declared
  event" and "A failed deletion is logged".

## 17. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 17.1 Write `docs/adr/0017-service-account-identifier-convention.md`
  (design D6). Verify: the file exists with Context/Decision/Alternatives/
  Consequences, and design D6 links to it.
- [ ] 17.2 Write `docs/adr/0018-credential-rotation-immediate-cutover.md`
  (design D8). Verify: same structure, linked from design D8.
- [ ] 17.3 Write `docs/adr/0019-org-deletion-two-phase-purge.md` (design D9).
  Verify: same structure, linked from design D9.
- [ ] 17.4 Write `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md`
  (design D3). Verify: same structure, linked from design D3.
- [ ] 17.5 Write `docs/security/data-retention.md`: the purge window and the
  erasure statement about backups, the operator runbook to clear a deletion
  marker, the credential rotation cadence, the invitation caps, and the
  retention of audit and security logs (at least 12 months, independent of
  tenant deletion, cross-referencing `010`/`015`). Verify: `pnpm lint` passes
  and the runbook is reachable from the file.
- [ ] 17.6 Update `docs/security/attack-surfaces.md`: the twelve routes with
  actor, authentication and Cerbos check, the public accept route, and the mount
  gate state (it lists `identity.*` as not mounted today). Verify: `pnpm lint`
  passes and every route of design D10 has a row.
- [ ] 17.7 Update `docs/architecture/system-diagram.md`: the email provider and
  the invitee with their mailbox as external actors, and arrows for invite →
  email, the public accept route, ACS egress over HTTPS, credential rotation and
  the purge job. Verify: the Mermaid block still renders with
  `npx -y @mermaid-js/mermaid-cli`, and every new route from design D10 appears.
- [ ] 17.8 Update `docs/security/secrets.md` (the Communication Services secret
  and its change procedure, the kill switch, the credential lifecycle) and
  `docs/security/crypto-inventory.md` (the invitation token). Verify: `pnpm
  lint` passes and each names its owner and rotation procedure.
- [ ] 17.9 `pnpm ci:local` is fully green (lint, typecheck, unit and integration
  tests, contract-check, otel-smoke-check, cerbos compile, audit, gitleaks).
  Verify: attach the command output to the PR description.
- [ ] 17.10 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against the
  implemented code, and resolve or explicitly defer every blocking gap. Verify:
  the report is attached to the PR with zero open blocking gaps.
- [ ] 17.11 Run `/security-review` on the branch and fix or justify every
  finding. Verify: the review output is attached to the PR.
- [ ] 17.12 `openspec validate 043-identity-lifecycle-and-org-admin --strict`
  passes, and design/specs/code agree (update design only if an implementation
  finding forced a change, noted in the PR). Verify: the command output is
  attached to the PR.
