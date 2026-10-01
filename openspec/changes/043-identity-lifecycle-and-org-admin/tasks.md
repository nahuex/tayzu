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

Tasks are written to the **recommended** option of each of the three Open
Questions in `design.md`. If the human picks another option, only the tasks the
question names change: 12.1b and 12.14 and Open Question 1 (the role of the
reversal script), 14.5 and Open Question 2 (the temporary-password mechanism),
14.6c and Open Question 3 (`Inherited` ownership). Everything else follows the
Resolved decisions Q1-Q34.

Migrations follow the repo's pairing of a table migration with a hand-written
grants migration and start at `0011`; every migration and every Cerbos task is
marked **(Checkpoint 3)** and stops for the human's separate approval. A task
numbered with a letter (`8.5b`) was added by an amendment and is a full cycle of
its own.

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
  are folded into `design.md`, the spec and these tasks, together with the five
  gaps (NB1-NB5) of the second pass, resolved by Q24-Q27. Attach the reports to
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
- [ ] 1.4 *(setup)* Scaffold the two homes of the identity code (Resolved decision
  Q30): `packages/auth/src/identity/` for the pure parts and the structural ports
  (empty modules for `user-status.ts`, `invitation-token.ts`, `password-policy.ts`,
  `email/sender.ts`, `ports.ts`) and `apps/api/src/identity/` for the
  orchestration and the routers (empty modules for `invitations.ts`,
  `service-accounts.ts`, `credentials.ts`, `org-deletion.ts`), each with a trivial
  `smoke.test.ts`. `@tayzu/auth` gains no `@orpc/server` or `@tayzu/catalog`
  dependency. Verify: `pnpm --filter @tayzu/auth test` and
  `pnpm --filter @tayzu/api test` run their smoke tests green.

## 2. `_user` blueprint extension (no migration)

- [ ] 2.1 `USER_BLUEPRINT` carries the optional `accountKind` (`"standard"` |
  `"service"`, default `"standard"`, applied on write only) and a four-value
  `status` enum (`Staged`, `Invited`, `Active`, `Disabled`, default `Staged`) for
  every new tenant. Verify: `user-blueprint.int.test.ts` covers that a new
  tenant's `_user` blueprint has both, and "New entity without a status starts
  staged".
- [ ] 2.2 A one-off, idempotent `tsx` script runs `blueprints.update` as the
  `system` actor once per existing tenant to bring `_user` forward. Verify:
  `user-blueprint.int.test.ts` seeds a tenant with the old schema and covers
  "adding accountKind and widening status is a compatible change": the update
  succeeds, existing `_user` entities stay valid and are not rewritten, and a
  second run changes nothing.
- [ ] 2.3 Every reader of `accountKind` treats an absent value as `standard`,
  because a blueprint default applies only on write (design D1). Verify:
  `account-kind.test.ts` covers a `_user` read without the property resolving to
  `standard`, and `identity-attributes.int.test.ts` (5.1) sending `standard` for
  such an entity.

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

- [ ] 4.1 `UserSyncInput.status` (today `'Active' | 'Disabled'`) is replaced by a
  `StatusEvent`, and `userSync` writes the result of `nextStatus`, never a raw
  status; it also accepts an optional `onBehalfOf` (Resolved decision Q10), since
  its own actor is fixed today. Verify: `user-sync.int.test.ts` covers a write for
  each allowed event, a rejected `Active` → `Staged` write, and a write with
  `onBehalfOf` carrying the admin on the change event.
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
  state machine instead of `Disabled`/`Active` directly, and only when the
  `banned` value actually changed (it fires on every `user.update` that carries a
  boolean `banned`, for example `/two-factor/enable`), and it is skipped without an
  endpoint context. Verify: `ban-hook.int.test.ts` covers that banning sets
  `Disabled`, unbanning sets `Active`, unbanning a `Staged` user is rejected, and
  that enrolling a second factor for an `Active` user (an update with an unchanged
  `banned: false`) does not throw and leaves the status `Active`.
- [ ] 4.6 The bootstrap script (`bootstrap-admin.ts`) writes its admin through
  `created_active` instead of `status: 'Active'` directly. Verify:
  `bootstrap-admin.int.test.ts` covers that the bootstrap `_user` is `Active`
  through the state machine and that the script emits `catalog.audit.user_created`
  with source `bootstrap` (the event itself is declared in 16.6).

## 5. Cerbos foundations, ⛔ Checkpoint 3

- [ ] 5.1 `RESOURCE_KINDS` gains `service_account`, `credential` and
  `organization`, and `assertMayOnUser` in `apps/api/src/identity-router.ts`
  (today `'create' | 'update'` with empty attributes) is extended with the actions
  `invite` and `updateStatus` and builds Cerbos attributes from a resolved target:
  `accountKind`, `portRole`, `moderatedBlueprints` and the target's **real
  tenant** (an invitation's `organizationId`, an API key's `referenceId`, the
  user's membership), never `ctx.tenantId` echoed back. The Cerbos resource id is
  the Better Auth user id for a human (the opaque `_user` id for a service
  account), never the email. Verify: `identity-attributes.test.ts` covers that the
  attributes carry the target's tenant and the three attributes and that the
  resource id is the opaque id for an email-addressed target, and
  `resource-kinds.test.ts` that the kinds exist.
- [ ] 5.2 Every target of an `identity.*` operation is resolved on the server by
  one helper, and a target of another tenant answers `CATALOG_NOT_FOUND`,
  identical to a nonexistent id; `tenantId` and `actor` are never read from
  input. Verify: `identity-target.int.test.ts` covers a foreign and an unknown
  invitation, credential and user answering the same, and a body with a
  `tenantId` field being rejected.
- [ ] 5.3 The identity router emits `catalog.security.authz_denied` and
  increments `tayzu.authz.decisions` on every Cerbos deny (it threw silently
  before), through a helper exported by `@tayzu/auth` because `apps/api` has no
  `@opentelemetry/api-logs` dependency. Verify: `identity-router.int.test.ts`
  covers that a denied call logs the event, with no email or identifier of the
  target.
- [ ] 5.4 (Checkpoint 3) Cerbos policy: `user.invite` (which also covers cancel
  and resend) and `user.updateStatus` on resource kind `user`, importing
  `002`'s `same_tenant` derived role. `user.yaml` already allows `*` to admin,
  so the new content is an `EFFECT_DENY` for `updateStatus` when `R.id == P.id`
  (`R.id` being the opaque user id, design D3). Verify: `cerbos compile` runs `user_test.yaml` covering both actions ×
  admin/non-admin × self/non-self × same/other tenant. ⛔ **Stop for
  Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 5.5 (Checkpoint 3) Cerbos policy: an `EFFECT_DENY` rule on `user.yaml` for
  any action when `R.attr.accountKind == "service"` and (`R.attr.portRole !=
  "member"` or `R.attr.moderatedBlueprints` is non-empty), using the resulting
  values, with every attribute reference guarded by `has()` because
  `strictEvaluation: true` turns a CEL error into a deny of the whole action
  (design D3, Resolved decisions Q7 and Q16). Verify: `cerbos compile` runs
  `user_test.yaml`'s cases for a call with **none** of the attributes (today's
  callers) staying allowed for an admin, and for a service-account resource denied `admin`
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

- [ ] 6.1 `EmailSender` port (one `send(to, template)` over a closed union of two
  fixed templates, `InvitationEmail` and `OrgDeletionNotice`; no CC, BCC or
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
- [ ] 6.3 The link origin comes from the dedicated `INVITATION_LINK_BASE_URL`
  setting (Resolved decision Q32), never from `BETTER_AUTH_URL`, `Host` or a
  forwarded header; it must be `https` outside test and one of `ALLOWED_ORIGINS`,
  and the path is fixed (`/accept-invitation`) with the invitation id and token in
  the URL fragment. Verify: `invitation-link.test.ts` covers "The link origin
  ignores the request headers" with forged `Host` and `X-Forwarded-Host`, asserts
  the id and token are after the `#`, and `config.test.ts` (in `apps/api`) covers
  an `http` value outside test and a value outside `ALLOWED_ORIGINS` failing
  startup.
- [ ] 6.4 `AzureCommunicationEmailSender` (the real adapter over
  `@azure/communication-email`), constructed from the Key Vault-backed
  connection string, never called in CI, with provider errors sanitized so no
  address or message text leaves it. Verify: `azure-email-sender.test.ts`
  covers construction and config parsing (no network call) and "The email
  provider's failure never leaks" with a stubbed client whose error contains the
  recipient; a documented manual smoke-check script exists for a real sandbox
  account outside CI.
- [ ] 6.5 Outside test, startup fails without a real `EmailSender` (the ACS
  connection string is read from the environment only, for a dedicated send-only
  resource, Resolved decision Q28), and CI and
  DAST wire a non-sending one. Verify: `config.test.ts` (in `apps/api`) covers
  that production configuration without a provider throws at startup and that
  the test configuration selects the recording fake.
- [ ] 6.6 A per-tenant cap of 30 invitation emails per hour, shared by invite and
  resend, on a store interface (in memory in tests), with its default in
  `apps/api/src/config.ts` following its `limitWithDefaults` pattern. Exceeding it fails with `AUTH_RATE_LIMITED`, sends
  nothing and logs `catalog.security.invitation_rate_limited` with scope
  `tenant`. Verify: `invitation-caps.test.ts` covers "Exceeding the per-tenant
  cap blocks further invites", asserting the `EmailSender` fake recorded no
  further call.
- [ ] 6.7 A per-recipient cap of 3 per 24 hours across all tenants, keyed by the
  sha256 of the canonical email (7.10). Verify: `invitation-caps.test.ts` covers
  "Exceeding the per-recipient cap blocks repeat invites across tenants",
  asserting scope `recipient` and that no address is in the event or the key
  store.
- [ ] 6.8 A global kill switch (`INVITATION_EMAIL_KILL_SWITCH`). Verify:
  `invitation-caps.test.ts` covers "The global kill switch stops all invitation
  email" with scope `global`.
- [ ] 6.9 A disabled or zero cap fails startup (`002` Q39). Verify:
  `config.test.ts` covers a zero or disabled value for each cap throwing at
  startup.
- [ ] 6.10 The production store for the caps and the accept route's limiter is
  `002`'s DB-backed atomic store (`auth.rate_limit`, hashed keys, no migration):
  the closed `RateLimitScope` enum gains `invitation_accept`, `invitation_tenant`
  and `invitation_recipient`, and the matching attribute in the authz telemetry
  contract is extended. Verify: `invitation-rate-limit-store.int.test.ts` covers
  two store instances over the same database sharing one count per scope, a key
  being stored only as a hash, and `contract.test.ts` (authz) the new scope
  values.
- [ ] 6.11 The `OrgDeletionNotice` template (Resolved decision Q27) has a fixed
  subject and body, interpolates only the purge date, contains no link and no
  tenant or actor free text. Verify: `org-deletion-notice-template.test.ts` covers
  "The deletion notice carries no free text" (an organization named
  `<b>Pay now</b>` and a markup-bearing actor name never appear) by parsing the
  rendered HTML and text.

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
- [ ] 7.3 `identity.users.invite` (in `apps/api`): creates a Better Auth invitation, stores the
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
  stops working), keeps the original expiry and sends one email, and does **not**
  use Better Auth's `inviteMember` with `resend: true`, which resets `expiresAt`
  to now + 48 hours. Verify: `invitations.int.test.ts` covers "Resending issues a
  new link and keeps the expiry", asserting the invitation's `expiresAt` is
  unchanged after the resend and the old token no longer verifies.
- [ ] 7.8 An invitation for an email whose existing user is `Disabled` is
  refused and sends nothing. Verify: `invitations.int.test.ts` covers "A
  disabled user cannot be invited".
- [ ] 7.9 A non-admin attempting `identity.users.invite` is denied with
  `AUTH_FORBIDDEN`, no invitation is created and `catalog.security.authz_denied`
  is logged. Verify: `invitations.int.test.ts` covers "Non-admin cannot invite"
  against the real Cerbos container.
- [ ] 7.10 The canonical email form (NFC, trimmed, lower-cased) is one pure
  function used for the `_user` identifier, the Better Auth email, the invitation
  email and the cap key, and a validator rejects an address the entity identifier
  pattern cannot hold or that contains `/` (Resolved decision Q33). Verify:
  `email-canonical.test.ts` covers `Alice@Example.com ` and its NFC variant
  canonicalizing identically, `a+b@example.com` and `a/b@example.com` rejected,
  and a plain address accepted.
- [ ] 7.11 `identity.users.invite` and `identity.users.create` reject such an
  address with `CATALOG_VALIDATION_FAILED`, before any invitation, user, email or
  cap increment. Verify: `email-boundary.int.test.ts` covers both operations
  refusing `a+b@example.com` and `a/b@example.com` with nothing created, and a
  plus-alias therefore not reaching the per-recipient cap.
- [ ] 7.12 Better Auth's own errors never reach the response as they are:
  `USER_IS_ALREADY_A_MEMBER` and the default `invitationLimit` of 100 pending
  invitations per organization map to `CATALOG_VALIDATION_FAILED` with no
  provider text. Verify: `invitations.int.test.ts` covers inviting an existing
  member and exceeding 100 pending invitations, asserting the generic code and no
  membership information in the response.

## 8. Invitation acceptance

- [ ] 8.1 A password policy module (design Q22): NFC-normalized, 20 to 128
  characters, at least one upper-case letter, lower-case letter, digit and
  symbol, no control characters (U+0000-U+001F, U+007F-U+009F), unpaired
  surrogates or Unicode format characters (bidi overrides, zero-width), and
  not on a bundled common-password denylist; no external call and no new
  dependency. Applied to invitation acceptance, temporary and bootstrap
  passwords, and `/change-password`. Verify: `password-policy.test.ts` covers
  19 and 129 characters refused, each missing class refused, a NUL, a control
  character, a bidi override and a zero-width character refused, a
  denylisted password refused, a compliant 20-character password accepted,
  and the refusal naming only the failed rule, never the password.
- [ ] 8.1b Breached-password check (design Q23): Better Auth's built-in
  `haveIBeenPwned` plugin is enabled for every path the policy covers, with
  a sanitized refusal and fail-closed behavior. Verify:
  `password-breach.int.test.ts`, against a local stub of the range API, covers
  a password whose SHA-1 suffix is in the stub's range being refused, a clean
  one accepted, only the 5-character prefix ever being sent, and an
  unreachable service refusing the password with a generic retryable error.
- [ ] 8.1c Better Auth's own password configuration enforces the policy on its
  routes: `minPasswordLength` 20 and `maxPasswordLength` 128, the policy hook on
  `/change-password`, and `002`'s test fixtures that used the old 8-character
  default are updated. Verify: `password-policy.int.test.ts` covers
  `/change-password` refusing a 19-character and a denylisted password and
  accepting a compliant one, and `pnpm --filter @tayzu/auth test` still passes
  with the updated fixtures.
- [ ] 8.1d The password is NFC-normalized at **every** password-verifying entry
  point, not only where it is set (a password hashed in NFC fails to sign in when
  typed in another normalization form): sign-in, `/verify-password` and
  `/two-factor/enable`. Verify: `password-nfc.int.test.ts` covers a password set
  through acceptance signing in, passing `/verify-password` and enabling a second
  factor when presented in its NFD form.
- [ ] 8.2 The acceptance service function (in `apps/api`, served by the plain
  route of 15.1b) for an email with no account: verifies the token, creates the
  user (global role `user`), sets the password the invitee supplied under the
  policy, marks the email verified, adds the membership with the invited role,
  writes the status through `invitation_accepted` and creates **no session**. Verify:
  `invitation-accept.int.test.ts` covers "A new person accepts and can then sign
  in" (sign-in through the normal route succeeds afterward).
- [ ] 8.3 The token is verified without consuming it and then consumed with one
  atomic delete **conditioned on its digest**, so it works exactly once. Verify:
  `invitation-accept.int.test.ts` covers a second acceptance with the same
  token failing, including two concurrent attempts where exactly one succeeds.
- [ ] 8.4 The tenant is derived from the invitation record, and a body that
  carries a tenant or an actor is rejected (null-prototype parse, `__proto__`,
  `constructor` and `prototype` rejected at every depth). Verify:
  `invitation-accept.int.test.ts` covers "The tenant comes from the invitation".
- [ ] 8.5 For an email that already has an account and a request **without** a
  session, acceptance never sets or changes a password and answers the uniform
  rejection (Resolved decisions Q18 and Q24). Verify:
  `invitation-accept.int.test.ts` covers "Acceptance does not touch an existing
  account", including a `password` in the body being ignored.
- [ ] 8.5b For an existing account with a session of that same account and the
  valid token, acceptance adds only the membership with the invited role and
  activates the `_user` through `invitation_accepted`; it never touches the
  password, the session, the active organization or any linked account, and its
  success has the same status and body shape as the new-account path. Verify:
  `invitation-accept.int.test.ts` covers "An existing account accepts with its
  session".
- [ ] 8.5c The session user's email must be verified and equal the invitation
  email, and the session is read only on this path. Verify:
  `invitation-accept.int.test.ts` covers "A session of another account cannot
  accept" (a different user's session, and an unverified email) answering the
  uniform rejection with `denial_reason` `email_mismatch` or `session_required`.
- [ ] 8.5d When the invited role is `admin`, an existing-account acceptance
  additionally requires a fresh step-up, checked with the guard of
  `packages/auth/src/step-up.ts` only after the session, the email and the token
  have all passed, so it answers `AUTH_STEP_UP_REQUIRED` to nobody without a valid
  token. Verify: `invitation-accept.int.test.ts` covers an `admin` invitation
  with and without a fresh marker, and a wrong token with no marker answering the
  uniform rejection, not `AUTH_STEP_UP_REQUIRED`.
- [ ] 8.6 Acceptance never links an account by an email claim. Verify:
  `invitation-accept.int.test.ts` covers "Acceptance does not link an SSO
  account by email" (no `account` row for the SSO provider exists afterward).
- [ ] 8.7 Every rejected acceptance (nonexistent, expired, cancelled, rejected,
  already accepted, wrong token, `Disabled` user, no or mismatched session for an
  existing account) returns the same status, error
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
  returns `CATALOG_VALIDATION_FAILED` without consuming the token (a second
  attempt with a compliant password and the same token then succeeds).
- [ ] 8.13 The public accept route has its own path-keyed `createRateLimit`
  preHandler keyed on the parsed pathname, like token exchange, with its default
  in `apps/api/src/config.ts`. Verify: `accept-rate-limit.test.ts` covers "The
  accept route is rate-limited" on the preHandler alone, asserting the limit
  fires before any invitation lookup (the route is not mounted here).
- [ ] 8.14 Two invitations of two tenants for the same new email accepted
  concurrently create exactly one user. Verify: `invitation-accept.int.test.ts`
  covers "A concurrent account creation for the same email yields one user": the
  loser answers the uniform rejection (`denial_reason` `account_conflict`), its
  `auth` rows roll back and its token is not consumed.

## 9. Org API credentials: viewer, create, rotate and revoke

- [ ] 9.1 (Checkpoint 3) Cerbos policy: `credential.list`, `create`, `rotate` and
  `revoke` on resource kind `credential`, importing `002`'s `same_tenant`
  derived role and carrying the explicit cross-tenant `EFFECT_DENY` of `002` D8,
  `admin`-only. Verify: `cerbos compile` runs `credential_test.yaml` covering
  each action × admin/non-admin × same/other tenant, including the explicit
  cross-tenant deny. ⛔ **Stop for Checkpoint 3 approval of the policy diff before
  continuing.**
- [ ] 9.1b The `organization` plugin's static access control grants the `admin`
  role `apiKey` create, read, update and delete, and `createMachineCredential`
  and `revokeMachineCredential` are called headerless with `body.userId`, so
  Better Auth's owner-only check no longer runs and Cerbos is the real gate
  (Resolved decision Q29). Verify: `org-api-key-access.int.test.ts` covers a Better
  Auth `admin` member who is not the owner creating and revoking an org key through
  the identity operation, and that the helper no longer forwards session headers.
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
  the per-key rate limit (not Better Auth's 10 per 24 hours) and the
  no-stored-secret-characters setting are plugin-level configuration of the
  `machine-credential` apiKey config (`rateLimit`, `startingCharactersConfig`),
  because `createApiKey` rejects per-key `rateLimit*` properties when given
  `headers` or a request; the call is headerless (9.1b). No hard expiry is applied
  (Resolved decision Q20), and the metadata is `{ actorKind, role: 'member',
  userId? }`. Verify: `credentials.int.test.ts` covers "Creating a credential
  requires step-up and bounds its use" at the service level: the created key has
  the configured limit and stores no secret characters (the step-up part is
  asserted over HTTP in 15.4).
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
- [ ] 9.11 A foreign or unknown credential id answers `CATALOG_NOT_FOUND`: the
  helper throws `AuthContextError` for a foreign credential today, and the
  identity operation maps it. Verify: `credentials.int.test.ts` covers rotate and
  revoke of another tenant's credential and of an unknown id returning the same
  `CATALOG_NOT_FOUND`.

## 10. Service accounts

- [ ] 10.1 Service-account identifier pattern `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`,
  validated at creation. Verify: `service-accounts.test.ts` covers acceptance
  of `svc-ci-github` and rejection of `ci-github` (missing prefix) and an
  over-length identifier.
- [ ] 10.2 (Checkpoint 3) Cerbos policy: `service_account.create` and `delete`
  on resource kind `service_account`, importing `002`'s `same_tenant` derived
  role and carrying the explicit cross-tenant `EFFECT_DENY` of `002` D8,
  `admin`-only. Verify: `cerbos compile` runs `service_account_test.yaml`
  covering each action × admin/non-admin × same/other tenant, including the
  explicit cross-tenant deny. ⛔ **Stop for
  Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 10.3 `identity.serviceAccounts.create` (in `apps/api`): writes the `_user` entity
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
- [ ] 10.6 Token exchange adds `userId` as an attribution claim only, at the
  place `token-exchange.ts` builds the signed payload (the payload parser of
  `context-resolver.ts` ignores extra claims), and `exchangeMachineToken` gains
  the ports for the `_user` and deletion-marker lookups that 11.7 and 12.6 need;
  the principal stays `{ roles: ['member'], teams: [], moderatedBlueprints: [] }`
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
  The matching change in `packages/catalog/src/persistence/schema.ts` is part of
  this task. Verify: `revocation-key.int.test.ts` covers that a row for `(t2, c1)`
  neither blocks nor shadows `(t1, c1)`, and that a lookup for `t1` ignores `t2`'s
  row. ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 11.1b The revocation **cache** in `resolveContext` is keyed by
  `(tenantId, credentialId)`, not by `credentialId` alone. Verify:
  `context-resolver.int.test.ts` covers "A revocation in one tenant does not
  poison the cache of another": credential id `c1` revoked in `t2` and cached,
  then a `t1` principal with the same id is still accepted.
- [ ] 11.2 `identity.users.setStatus` for a human is **tenant-scoped** (Resolved
  decision Q25): it validates through `nextStatus`, checks the Cerbos grant, writes
  `_user.status` as `system` with `onBehalfOf` the admin (appending a change
  event) and revokes only the sessions whose active organization is the tenant. For
  a user with a **single** membership it also sets `banned` and deletes all their
  sessions through the internal adapter (`internalAdapter.updateUser({ banned })`
  and `deleteUserSessions`, not Better Auth's `banUser`/`unbanUser`, which the
  global role `user` cannot call). Verify: `user-status-op.int.test.ts` covers
  "Disable and re-enable" and "A disabled user's sessions stop working" for a
  single-membership user through the operation pipeline.
- [ ] 11.2b For a user with memberships in two tenants, disabling in `t1` revokes
  only the sessions of `t1` and does not set `banned`, so the same user keeps
  working in `t2`; enabling in `t1` restores only `t1`. Verify:
  `user-status-op.int.test.ts` covers "A member of two tenants is disabled in one
  only".
- [ ] 11.3 A user attempting to change their own status is denied and a
  `catalog.security.self_status_change_denied` event is logged. Verify:
  `user-status-op.int.test.ts` covers "A user cannot disable themselves" through
  the email-addressed `{user}` identifier, proving the self-deny compares the
  resolved Better Auth user id and is not vacuous.
- [ ] 11.4 Disabling a user cancels their pending invitations **of that tenant**
  (reason `user_disabled`). Verify: `user-status-op.int.test.ts` covers "Disabling
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
- [ ] 11.8 `resolveContext` rejects a **human** whose `_user.status` in the active
  tenant is `Disabled`, through the existing cached, fail-closed `_user` lookup,
  logging `catalog.security.principal_rejected` and incrementing
  `tayzu.identity.principal_rejections` (Resolved decision Q25). Verify:
  `context-resolver.int.test.ts` covers "A disabled member is rejected in their
  tenant only": the same user accepted in `t2`, and a lookup failure rejecting.

## 12. Org deletion, two phases, ⛔ Checkpoint 3 (migrations `0012` and `0013`)

- [ ] 12.1 (Checkpoint 3) Migration `0012_tenant_deletion`: the
  `tenant_deletion_marker` table (tenant id, `requested_at` with `DEFAULT now()`
  and no input path, `purge_after`, the requesting actor's opaque id, `state` in
  `pending`/`cancelled`/`purged`, the timestamps of the two purge steps), a
  `CHECK` that `purge_after` is between `requested_at + 7 days` and
  `requested_at + 14 days`, a partial unique index allowing one pending marker per
  tenant, and the Drizzle table in `packages/catalog/src/persistence/schema.ts`. It
  carries `migrations/down/0012.down.sql`, `meta/0012_snapshot.json` and its
  `_journal.json` entry. Verify: `tenant-deletion-migration.int.test.ts` covers a
  `purge_after` of 6 and of 15 days refused, a past-dated or caller-supplied
  `requested_at` having no effect, and a second pending marker for one tenant
  refused. ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 12.1b (Checkpoint 3) Migration `0013_tenant_deletion_grants`
  (hand-written, like `0009`): creates the `tayzu_purge` role (own pool and secret,
  used only by the purge job) and the role of Open Question 1 (recommended:
  `tayzu_deletion_admin`, only able to update `state` and the cancellation
  timestamp of a pending marker); grants `tayzu_app` `INSERT` and `SELECT` on the
  marker under a tenant-isolation policy and **no** `UPDATE` or `DELETE`;
  `FORCE ROW LEVEL SECURITY`; gives `tayzu_purge` `DELETE` on the tenant's
  `catalog_*` tables under a policy limited to tenants with a due pending marker;
  amends the append-only trigger of `0001` to allow `DELETE` only when
  `current_user` is `tayzu_purge`; and creates the purge function
  (`SECURITY DEFINER`, fixed `search_path`, schema-qualified, no dynamic SQL, owned
  by `tayzu_purge`, deleting `catalog_change_event` and the tenant's
  `machine_credential_revocation` rows only for a due tenant) and the lister
  (`SECURITY DEFINER`, returning the due pending tenants), with `PUBLIC` denied
  `EXECUTE` on both. It carries `migrations/down/0013.down.sql`,
  `meta/0013_snapshot.json` and its `_journal.json` entry. Verify:
  `tenant-deletion-grants.int.test.ts` covers that `tayzu_app` can insert its own
  tenant's marker but cannot update, delete or read another tenant's, that it
  cannot back-date one; that a tenant without a due marker cannot be purged and a
  due tenant's change events and revocation rows are removed; that a direct
  `DELETE` by `tayzu_app`, by the table owner and by `tayzu_purge` outside a due
  tenant is still refused by the trigger or the policy; that `PUBLIC` cannot
  execute either function; that the lister returns only due tenants; and that the
  function ignores a manipulated `search_path`. ⛔ **Stop for Checkpoint 3 approval
  of the SQL before continuing.**
- [ ] 12.2 (Checkpoint 3) Cerbos policy: `organization.delete` on resource kind
  `organization`, importing `002`'s `same_tenant` derived role and carrying the
  explicit cross-tenant `EFFECT_DENY` of `002` D8, `admin`-only (any admin may
  request it, Resolved decision Q27). Verify: `cerbos compile` runs
  `organization_test.yaml` covering admin/non-admin × same/other tenant, including
  the explicit cross-tenant deny. ⛔ **Stop for Checkpoint 3 approval of the policy
  diff before continuing.**
- [ ] 12.3 `identity.organization.delete` requires the caller to send the
  organization's identifier, which must equal the host `ctx.tenantId`. Verify:
  `org-deletion.int.test.ts` covers "Org deletion targets only the host
  tenant" and a missing or wrong confirmation returning
  `CATALOG_VALIDATION_FAILED`, asserting nothing changes.
- [ ] 12.4 Phase 1 records the marker (as `tayzu_app`, insert-only) with a
  `purge_after` inside the configured window (7 to 14 days, validated at startup,
  default 14), revokes every session whose active organization is the tenant,
  revokes every org-owned credential through the revocation list, cancels pending
  invitations, and logs `catalog.audit.org_deletion_requested` with the admin as
  `tayzu.actor.id`. Verify: `org-deletion.int.test.ts` covers the data-still-present
  and marker parts of "Requesting deletion revokes access at once", and a window
  outside 7 to 14 failing startup.
- [ ] 12.5 Requesting deletion again while pending changes nothing, returns the
  original date and sends no second notice. Verify: `org-deletion.int.test.ts`
  covers "Requesting deletion twice returns the original date", in process.
- [ ] 12.6 `resolveContext` and token exchange reject every principal, human or
  machine, of a tenant with a **pending** deletion marker (a cancelled marker does
  not reject), logging `catalog.security.principal_rejected` with reason
  `tenant_pending_deletion`, and the acceptance of an invitation of such a tenant
  answers the uniform rejection (`denial_reason` `tenant_pending_deletion`).
  Verify: `org-deletion.int.test.ts` covers the access part of "Requesting deletion
  revokes access at once" for a session and an already-issued machine token, and
  `invitation-accept.int.test.ts` the rejected acceptance.
- [ ] 12.7 Purge step 1 (`tayzu_purge`): ordered deletes of the tenant's
  relations, entities, blueprints and other `catalog_*` rows that respect the
  `RESTRICT` foreign keys, and the append-only rows through the function of 12.1b,
  recording progress on the marker. Verify: `org-purge-catalog.int.test.ts` covers
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
  (tenant id, state and timestamps only) remains, and a repeated purge deletes
  nothing. Verify: `org-purge-resume.int.test.ts` covers "A purge does not touch
  a tenant whose window has not passed" and "A repeated purge is safe".
- [ ] 12.12 The purge job entry point: a `tsx` script run by a scheduled job,
  with no HTTP listener, that connects only as `tayzu_purge` and `tayzu_auth`,
  reuses the `assertRuntimeRole` startup guard of `apps/api/src/bootstrap.ts`,
  enumerates the due tenants through the lister, and runs one pass. Verify:
  `purge-job.int.test.ts` runs the script once against a due tenant, asserts it is
  purged, asserts the process opened no listener, and asserts it refuses to start
  under another role.
- [ ] 12.13 Phase 1 sends the fixed `OrgDeletionNotice` to every administrator of
  the organization, one email per recipient, resolved on the server from the
  tenant's memberships; a send failure never blocks the request and logs
  `catalog.security.org_deletion_notice_failed` (Resolved decision Q27). Verify:
  `org-deletion-notice.int.test.ts` covers "Every admin is notified of a pending
  deletion" with the recording fake (an owner and two admins each receive exactly
  one email, a plain member none) and a failing sender not stopping the request.
- [ ] 12.14 The reversal script (`tsx`, run by a platform operator, with the role
  of Open Question 1) tombstones a pending marker (`state = 'cancelled'`, a
  timestamp; the row is never deleted) and refuses a tenant with no pending
  marker. Verify: `cancel-org-deletion.int.test.ts` covers "A platform operator
  reverses a pending deletion": the tenant's principals are accepted again, the
  row is still present as a tombstone, and the script's role cannot delete or read
  tenant data.
- [ ] 12.15 The reversal emits `catalog.audit.org_deletion_cancelled` with the
  operator's opaque id and increments `tayzu.identity.org_deletions` with outcome
  `cancelled`, and a later deletion request after a reversal inserts a new
  marker. Verify: `cancel-org-deletion.int.test.ts` covers the event and its
  attributes with no email, the metric, and "Requesting deletion again after a
  reversal creates a new marker".
- [ ] 12.16 A schema-driven completeness test: every table that has a `tenant_id`
  column (catalog) and every `auth` table that references an organization or a
  user is deleted by a purge step or explicitly exempted with a reason, so a later
  change that adds a table cannot escape the purge. Verify:
  `purge-coverage.int.test.ts` enumerates the tables from the database catalog,
  fails for a table added in a scratch migration that no step covers, and passes
  on the real schema.

## 13. Cross-tenant matrix (one test per route, in process; the HTTP twin is 15.8)

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
- [ ] 13.3 The acceptance of an invitation of `t2`, for a new and for an existing
  account (with its session), creates the membership only in `t2`. Verify: the
  accept of `t2`'s invitation leaves `t1` without a new member and no cross-tenant
  write.
- [ ] 13.4 `identity.users.setStatus` on a user whose only membership is in
  another tenant answers `CATALOG_NOT_FOUND`, and on a user with memberships in two
  tenants it acts on the caller's tenant only (Resolved decision Q25). Verify:
  "Another tenant's user cannot have its status changed" and "A member of two
  tenants is disabled in one only" (the other tenant's status, sessions and `banned`
  are untouched).
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
- [ ] 13.10 `identity.users.create`, `linkSsoAccount` and `unlinkSsoAccount` (the
  three routes `002` already had, Resolved decision Q31): `create` writes only the
  host tenant, a target of another tenant answers `CATALOG_NOT_FOUND`, and a target
  with a membership in two tenants is refused for link and unlink (`002` VCDM
  M10). Verify: "A user with memberships in two tenants is refused" for link and
  unlink, and the foreign target answering the same as an unknown one.

## 14. Hand-offs from 002 (002 design Q73; mount gate)

`identity.*` and the machine-credential operations are not reachable over HTTP
before every task in this group is done. Group 15 is the only place a route is
registered. Q73 hands this change the items M5, M9-M15 and M17-M20 of `002`'s
VCDM re-assessment (and M4 was added earlier); `design.md` (Risks, "Hand-offs
from `002` (Q73): traceability") records each item and where it is closed. The
items closed by another group are named in the task they appear in; the two
explicit deferrals (the in-memory `@fastify/rate-limit` budgets of M13 and the
SSO surfaces of M18) are recorded there with their justification.

- [ ] 14.1 The machine-credential create and revoke operations (library functions
  in `packages/auth/src/machine-credentials.ts`: `002` registers no routes for
  them, they are not exported from the package index and no non-test code calls
  them) are reachable only through `identity.credentials.*` and
  `identity.serviceAccounts.*`, behind Cerbos (the `credential` policy of 9.1) and
  with the headerless call of 9.1b (`002` residual risk; M9). Verify:
  `machine-credentials.int.test.ts` covers a non-admin denied create and revoke
  and a Better Auth `admin` member (not only `owner`) allowed through Cerbos only;
  `machine-credential-surface.test.ts` asserts the two functions are not exported
  from the `@tayzu/auth` index and have no caller outside the identity operations.
  The composite key is 11.1 and the high-risk marker is 15.2.
- [ ] 14.2 Identity operations that act on the global account refuse a target that
  has a membership outside the caller's tenant, so an admin of one tenant cannot
  link an SSO `sub` to a user who also belongs to another tenant (`002` VCDM M10;
  `setStatus` is tenant-scoped instead, Resolved decision Q25). Verify:
  `identity-router.int.test.ts` covers `linkSsoAccount` and `unlinkSsoAccount` on a
  two-tenant user being refused.
- [ ] 14.3 `createUser` and `linkSsoAccount` give no email or `sub` existence
  oracle, and the user, credential and bootstrap lifecycle events declared in
  the contract are emitted (`002` Q42; M9). Verify: `identity-router.int.test.ts`
  covers "Create and link give no existence oracle", and each lifecycle action
  emitting its declared event.
- [ ] 14.4 `resolveContext` rejects a disabled (`banned`) user, so existing
  sessions and any new sign-in, local or through SSO, stop granting access, and a
  ban revokes the user's sessions (`002` VCDM M20; the tenant-scoped check is
  11.8). Verify: `context-resolver.int.test.ts` covers "A disabled user's sessions
  stop working" and `catalog.security.principal_rejected` being logged, and
  `banned-sign-in.int.test.ts` covers a banned user being refused at local sign-in
  and at the SSO callback.
- [ ] 14.5 Temporary and bootstrap passwords force a change at first sign-in and
  expire, through a marker row in `auth.verification` (identifier
  `temp-password:<userId>`, `expiresAt` equal to the expiry; Open Question 2,
  recommended option, no migration) that the resolver and the route allowlist
  honor so the session reaches only the change-password route until it is cleared
  (`002` VCDM M11). Verify: `temporary-password.int.test.ts` covers that a
  temporary password grants only the change-password route, that changing it
  clears the marker, and that it expires.
- [ ] 14.5b The generated temporary password (today `randomBytes(24)` as base64url)
  satisfies the password policy of 8.1 (20 to 128 characters and every character
  class), and the policy applies to bootstrap passwords (`002` VCDM M5). Verify:
  `temporary-password.test.ts` covers 1000 generated passwords all passing the
  policy and a bootstrap password failing it being refused.
- [ ] 14.6 Authorization and the write run against the same state: the handler
  re-verifies `ownerTeam`, `locked` and `createdBy` inside its own transaction,
  after `FOR UPDATE`, so a concurrent ownership or lock change is seen and an
  `upsert` authorized as `create` cannot land as an update (`002` VCDM M4).
  Verify: `pipeline-recheck.int.test.ts` covers a concurrent ownership change
  between the authorization and the write failing closed, and the upsert case.
- [ ] 14.6b A `replace`-mode `upsert` without `ownerTeam` cannot silently release
  ownership (`002` VCDM M15). Verify: `entities-upsert-ownership.int.test.ts`
  covers an owning-team member's `replace` upsert without `ownerTeam` being
  refused or keeping the owner, per `001`'s ownership spec.
- [ ] 14.6c `Inherited` ownership is unreachable today (`readInherited` returns
  nothing); until a chain can be declared, an entity whose ownership is `Inherited`
  is not updatable by a non-admin (fail closed; Open Question 3, recommended
  option) and the `002` spec correction is recorded for a `002` follow-up (`002`
  VCDM M15). Verify: `inherited-ownership.int.test.ts` covers a non-admin member's
  update of such an entity being denied and an admin's allowed.
- [ ] 14.7 Keys created through `002`'s machine-credential path get the
  plugin-level per-key rate limit and no stored first characters (`002` residual
  risk; 9.5), with the headerless call. Verify: `machine-credentials.int.test.ts`
  covers the configured limit and an empty stored start on a created key.
- [ ] 14.8 Startup refuses `NODE_ENV=test` together with a non-local database
  host, because `NODE_ENV=test` relaxes the https checks, the role assertion and
  the OTLP requirement (`002` VCDM M12). Verify: `config.test.ts` (in `apps/api`)
  covers `NODE_ENV=test` with a remote `DATABASE_URL` host throwing at startup, a
  local host starting, and the database TLS check being unaffected.
- [ ] 14.9 The public re-authorization callback has its own limiter on the
  DB-backed store (a new `RateLimitScope` value, `reauthorization_callback`, in the
  authz contract too), firing before the database `delete` it performs per hit
  (`002` VCDM M13). Verify: `reauthorization-limits.int.test.ts` covers the
  callback being rate-limited with no database access once the limit is hit.
- [ ] 14.9b `reauthorization.start` is bounded per session, so a blocked attempt no
  longer inserts an unbounded number of rows (`002` VCDM M13). Verify:
  `reauthorization-limits.int.test.ts` covers repeated blocked attempts of one
  session inserting at most the configured number of rows.
- [ ] 14.10 A back-channel logout token with neither `sid` nor `sub` is rejected
  and does not consume its `jti` (`002` VCDM M14). Verify:
  `backchannel-logout.int.test.ts` covers such a token being refused and the same
  `jti` still usable afterwards in a valid token.
- [ ] 14.11 The cheap claim checks of back-channel logout run before discovery and
  JWKS are fetched, so a malformed RS256-shaped token triggers no outbound call
  (`002` VCDM M14). Verify: `backchannel-logout.int.test.ts` covers a token failing
  a cheap check with the discovery and JWKS fetchers recording zero calls.
- [ ] 14.12 *(setup)* Record that Dependabot does not track the pinned image
  digests (`postgres`, Cerbos, ZAP in `ci.yml` and `scripts/ci/dast.sh`; its
  config lists npm and github-actions only) and add them to the quarterly review
  of the existing dependency process (`002` VCDM M17). Verify: `pnpm lint` passes
  and `docs/security/dependencies.md` lists each pinned digest with its review
  cadence and owner.
- [ ] 14.13 The DAST API scan asserts that it received 2xx responses on
  operations, so a scan that only ever sees 401 or 415 fails instead of passing
  silently (`002` VCDM M18; the SSO, back-channel and re-auth surfaces are
  deferred to `010`, design Risks). Verify: `scripts/ci/dast-coverage.test.ts`
  covers a fixture ZAP report with no 2xx operation response failing the check and
  one with 2xx responses passing, and `dast.sh api-scan` runs the check on its
  report.

## 15. API contract and mount gate

- [ ] 15.1 oRPC procedures for the fourteen operations of design D10 (the three
  existing procedures `create`, `linkSsoAccount` and `unlinkSsoAccount` gain their
  `.route` and are addressed by the `{user}` identifier, Resolved decision Q31),
  each declaring `.route({ method, path, spec })` like
  `packages/catalog/src/api/contract.ts`, in the identity router of `apps/api`
  mounted beside the catalog router. Verify: `router.int.test.ts` calls each
  procedure once on its happy path through `createRouterClient`, and
  `openapi.test.ts` asserts the generated document lists the fourteen routes with
  their methods and paths and **not** the accept route.
- [ ] 15.1b The acceptance is a **plain Fastify route**, `POST
  /v1/auth/invitations/accept`, registered before the `/v1/*` catch-all like
  `app.post(TOKEN_EXCHANGE_PATH)` (the catch-all would answer an unauthenticated
  call 401), parsing the body into a null-prototype object and subject to the body
  limit, with the path-keyed limiter of 8.13. Verify: `accept-route.http.int.test.ts`
  covers "A new person accepts over HTTP without a session" and the route being
  absent from the OpenAPI document and from the `contract:check` input.
- [ ] 15.2 `x-tayzu-risk: high` on every operation in the set (`setStatus`,
  `invite`, `identity.users.create`, `serviceAccounts.create`/`delete`,
  `credentials.create`/`rotate`/`revoke`, `organization.delete`, and the SSO
  `linkSsoAccount` and `unlinkSsoAccount`), per Resolved decisions Q19 and Q31.
  Verify: `openapi.test.ts` covers "Every route in the high-risk set is marked".
- [ ] 15.3 `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), **off by
  default**: with it off none of the fifteen routes is registered (the accept route
  included), and each answers **like an unknown `/v1` path**: 401
  `CATALOG_CONTEXT_REQUIRED` for an unauthenticated call (the catch-all resolves the
  context first) and the router's 404 for an authenticated one. Verify:
  `mount-gate.int.test.ts` covers "Routes answer like an unknown path while the
  switch is off" for both callers and "No route is registered outside the switch"
  by enumerating the route table.
- [ ] 15.4 Step-up over HTTP with the switch on: an admin session without a fresh
  verification gets `AUTH_STEP_UP_REQUIRED` for each high-risk route and nothing
  changes. Verify: `step-up.http.int.test.ts` covers "A hijacked admin session
  without a fresh MFA cannot mint power" over the mounted server, a `password`
  marker satisfying the guard only for a user with no enrolled factor, a session
  with an `ssoSid` being sent to the Visma Connect re-authorization instead of a
  local verification, and an admin without an enrolled factor getting
  `AUTH_STEP_UP_REQUIRED` on any `/v1` call (an invited admin starts blocked until
  they enrol).
- [ ] 15.5 Error mapping over HTTP: `AUTH_FORBIDDEN` and `AUTH_STEP_UP_REQUIRED`
  are 403, `AUTH_RATE_LIMITED` is 429, a foreign or unknown target is 404.
  Verify: `errors.http.int.test.ts` covers each over the mounted server, and
  that the accept route's rejections are all the same 404.
- [ ] 15.6 `{user}` is the `_user` entity identifier (an email or `svc-…`) sent
  unencoded, and a path containing `%` answers 404 (`002` Q74). Verify:
  `user-path.http.int.test.ts` covers `PUT /v1/users/{email}/status` and
  `PUT /v1/users/svc-ci-github/status` resolving, and a `%` path being 404.
- [ ] 15.7 The existing-account acceptance over HTTP (Resolved decision Q24): the
  route reads the session cookie, requires the CSRF custom header and passes the
  origin check, and the step-up for an invited `admin` is an explicit call of the
  guard. Verify: `accept-existing.http.int.test.ts` covers a request without the
  CSRF header and one from a foreign origin being refused with the uniform
  rejection, a request with no session for an existing account answering the same
  404 as a wrong token, a matching session plus the token succeeding with the
  same status and body shape as the new-account path, and an `admin` invitation
  answering `AUTH_STEP_UP_REQUIRED` only after the token and the session matched.
- [ ] 15.8 A cross-tenant request per route over HTTP: each of the fifteen routes,
  called by `t1`'s admin with a target of `t2`, answers the same response as an
  unknown target. Verify: `cross-tenant.http.int.test.ts` covers one request per
  route over the mounted server and compares each response to the unknown-id
  response.

## 16. Telemetry contract enforcement

- [ ] 16.1 Extend `@tayzu/auth`'s `telemetry/contract.ts` (which already exists
  with `SPANS`, `METRICS` and `LOG_EVENTS` that overlap the authz contract) with
  every span, metric and log event from design.md's Observability contract,
  including `identity.organization.cancel_deletion`,
  `catalog.audit.org_deletion_cancelled`,
  `catalog.security.org_deletion_notice_failed` and the new attributes, and make
  `otel-smoke-check` import it in addition to `@tayzu/authz`'s contract with
  aliased imports and a de-duplication of shared names. Verify: `contract.test.ts`
  snapshot-asserts every declared name, and `otel-smoke-check.int.test.ts` fails
  when a declared name is missing from the imported contract.
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
  rotation (secret value as the marker), an acceptance carrying a marker password
  and a marker token (neither appears in any signal or error response), and "The
  email provider's failure never leaks".
- [ ] 16.5 For the routes of this capability the exported HTTP path is the route
  template, so no email, invitation id or credential id leaves the process; because
  `/v1/*` is one catch-all, the template is computed by matching the request path
  against the fifteen paths of design D10, and the marker test runs through the
  real HTTP server and instrumentation. Verify: `telemetry-paths.http.int.test.ts`
  covers "A path identifier never reaches telemetry over HTTP" for
  `PUT /v1/users/{marker-email}/status` and a credential route with a marker id,
  and the template matcher covering all fifteen paths.
- [ ] 16.6 Every lifecycle action emits its declared event: user and bootstrap
  creation, status change, service-account disable, enable and deletion,
  invitation resend, credential creation, rotation and revocation, and org
  deletion requested, completed, failed and cancelled. In every audit event
  `tayzu.actor.id` is the admin who acted (the `onBehalfOf` of the `system` write),
  never the `system` actor. Verify: `identity-events.int.test.ts` covers "Each
  lifecycle action emits its declared event", the actor id being the admin, and "A
  failed deletion is logged".

## 17. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 17.1 Write `docs/adr/0017-service-account-identifier-convention.md`
  (design D6). Verify: the file exists with Context/Decision/Alternatives/
  Consequences, and design D6 links to it.
- [ ] 17.2 Write `docs/adr/0018-credential-rotation-immediate-cutover.md`
  (design D8). Verify: same structure, linked from design D8.
- [ ] 17.3 Write `docs/adr/0019-org-deletion-two-phase-purge.md` (design D9),
  covering the purge role, the marker's integrity rules and the reversal control.
  Verify: same structure, linked from design D9.
- [ ] 17.4 Write `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md`
  (design D3). Verify: same structure, linked from design D3.
- [ ] 17.5 Write `docs/security/data-retention.md`: the purge window; the erasure
  statement about backups, Cerbos decision logs, Azure Monitor data and Azure
  Communication Services records (with ACS data location and retention); the
  operator runbook to reverse a pending deletion (just-in-time access through Azure
  PIM with a personal account, a named second approver, the script of 12.14); the
  credential rotation cadence; the invitation caps with the cross-tenant
  denial-of-invitation trade-off; the canonical email form and the addresses that
  are rejected (Resolved decision Q33); and the retention of audit and security
  logs (at least 12 months, independent of tenant deletion, cross-referencing
  `010`/`015`). Verify: `pnpm lint` passes and the runbook is reachable from the
  file.
- [ ] 17.6 Update `docs/security/attack-surfaces.md`: the fifteen routes with
  actor, authentication and Cerbos check, the public accept route with its session
  binding, CSRF header and origin check, the inert invitation link until `003`
  (Resolved decision Q32), the egress to `api.pwnedpasswords.com`, the SEC11 answers
  of Resolved decision Q34, and the mount gate state (it lists `identity.*` as not
  mounted today). Verify: `pnpm lint` passes and every route of design D10 has a
  row.
- [ ] 17.7 Update `docs/architecture/system-diagram.md`: the email provider, the
  invitee with their mailbox and the platform operator as actors, and arrows for
  invite → email, the public accept route, ACS egress over HTTPS, the Pwned
  Passwords range query, credential rotation, the purge job with its two database
  connections (`tayzu_purge` and `tayzu_auth`) and the reversal script. Verify: the
  Mermaid block still renders with `npx -y @mermaid-js/mermaid-cli`, and every new
  route from design D10 appears.
- [ ] 17.8 Update `docs/security/secrets.md` (the Communication Services secret on
  a dedicated send-only resource and its change procedure, the kill switch and its
  emergency flip (a new app revision), the `tayzu_purge` and `tayzu_auth` secrets of
  the purge job and the reversal role, each with owner and rotation, the credential
  lifecycle) and `docs/security/crypto-inventory.md` (the invitation token). Verify:
  `pnpm lint` passes and each names its owner and rotation procedure.
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
- [ ] 17.13 Render the system diagram to an image for the SSA (SEC01 asks for a
  png or jpg, `002` VCDM M19) and make the diagram show distinct Administrator and
  Platform operator actors, the `ghcr.io` image pulls and the OTLP export from
  `apps/api`. Verify: `npx -y @mermaid-js/mermaid-cli -i
  docs/architecture/system-diagram.md -o` produces a png, and each of the three
  additions appears in the Mermaid source.
- [ ] 17.14 Update `docs/catalog/auth-and-rbac.md` (`002` D17): the three new
  resource kinds and their actions in the taxonomy, and the new spans, metrics and
  log events in the telemetry reference. Verify: `pnpm lint` passes and every
  resource kind of design D3 and every event of the Observability contract is
  listed.
