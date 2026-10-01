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

Scenario names in quotes refer to
`specs/identity-lifecycle-and-org-admin/spec.md`. Test files live next to the
code as `*.test.ts`. Integration tests are named `*.int.test.ts` and need
`DATABASE_URL` plus a running Cerbos test container, per `002`'s own harness.

## 1. Setup and coordination with `002`

- [ ] 1.1 *(setup)* This change's proposal/design/specs/tasks were already
  reconciled against `002-auth-and-rbac`'s actual `design.md` at the
  OpenSpec-planning level on 2026-09-28 (package layout matched; status
  casing, ADR numbers 0017-0020, the `AUTH_STEP_UP_REQUIRED` code, and the
  service-account credential mechanism were corrected — see design.md
  Context). At implementation time, this task is a final drift-check against
  the merged `002` code (package layout, `_user` blueprint shape, Cerbos
  resource-kind names), not first-time discovery. Adjust import paths and
  attribute names only if drift is found — no scope change. Verify: a short
  note in the PR description states what, if anything, was adjusted.
- [ ] 1.2 *(setup)* Run the `vcdm-ssa-validator` pre-assessment in Mode A
  against this proposal, specs and design, and fold every blocking finding
  into `design.md`'s Security considerations before Checkpoint 1. Verify:
  the report is attached to the PR with zero open blocking gaps or an
  explicit deferral recorded.
- [ ] 1.3 *(setup)* Add `@azure/communication-email` (`1.1.0`) to
  `packages/auth/package.json`, and add the Communication Services
  connection string as a Key Vault secret reference, following `002`'s
  existing pattern for the database credential. Verify: `pnpm install`
  succeeds, and `docs/security/dependencies.md`'s dependency list includes
  the new package.
- [ ] 1.4 *(setup)* Scaffold `packages/auth/src/identity/` (empty modules for
  `user-status.ts`, `invitations.ts`, `service-accounts.ts`, `credentials.ts`,
  `org-deletion.ts`, `email/sender.ts`) with a trivial `smoke.test.ts`.
  Verify: `pnpm --filter @tayzu/auth test` runs the smoke test green.

## 2. `_user` blueprint extension (no migration)

- [ ] 2.1 Add the optional `accountKind` (`"standard"` | `"service"`,
  default `"standard"`) property to the `_user` system blueprint via the
  catalog's `blueprints.update` operation, run as the `system` actor. Verify:
  `user-blueprint.int.test.ts` covers "adding accountKind is a compatible
  change" (existing `_user` entities stay valid, `blueprints.update`
  succeeds) and asserts a `_user` entity created before this task reads back
  with `accountKind: "standard"`.

## 3. User status state machine (pure)

- [ ] 3.1 `nextStatus(current, event)` for the creation events
  (`created_staged` → `Staged`, `created_invited` → `Invited`). Verify:
  `user-status.test.ts` covers "New user without an invite starts staged"
  and "Explicit invite starts a user as invited" at the pure level.
- [ ] 3.2 `nextStatus` for `first_sign_in` from both `Staged` and `Invited`.
  Verify: `user-status.test.ts` covers "First sign-in activates a staged or
  invited user" for both starting states.
- [ ] 3.3 `nextStatus` rejects any transition from `Active` to `Invited` or
  `Staged`, returning `CATALOG_VALIDATION_FAILED`. Verify: `user-status.test.ts`
  covers "Active never regresses to invited or staged".
- [ ] 3.4 `nextStatus` for `admin_disable` (from any status) and
  `admin_enable` (from `Disabled` only). Verify: `user-status.test.ts` covers
  "Disable and re-enable" and rejects `admin_enable` from a non-`Disabled`
  status.
- [ ] 3.5 `nextStatus` is exhaustive: every `(status, event)` pair not
  explicitly allowed returns `CATALOG_VALIDATION_FAILED`, never `undefined`.
  Verify: `user-status.test.ts` iterates the full 4×5 matrix and asserts
  every cell is either an allowed transition or an explicit rejection.

## 4. Invitation lifecycle

- [ ] 4.1 Configure Better Auth's `organization` plugin invitation options:
  `invitationExpiresIn` 48 hours, `requireEmailVerificationOnInvitation:
  true`, `cancelPendingInvitationsOnReInvite: true`. Verify:
  `invitation-config.int.test.ts` asserts the configured values by creating
  an invitation and reading back its `expiresAt`.
- [ ] 4.2 `identity.users.invite`: creates a Better Auth invitation and, via
  `afterCreateInvitation`, creates or updates the `_user` entity to `Invited`
  and sends exactly one email through the `EmailSender` port. Verify:
  `invitations.int.test.ts` covers "Invite sends exactly one email with
  exactly one link" using a recording `EmailSender` fake, and asserts the
  `_user` entity's status.
- [ ] 4.3 Re-inviting an already-`pending`-invited email cancels the previous
  invitation and creates a fresh one with a new 48-hour expiry. Verify:
  `invitations.int.test.ts` covers "Re-inviting cancels the previous
  invitation".
- [ ] 4.4 `identity.users.acceptInvitation`: requires the accepting session's
  email to equal the invited email, and on success sets `_user.status =
  Active` via `afterAcceptInvitation`. Verify: `invitations.int.test.ts`
  covers "Accepting with a mismatched session email fails" and (positive
  case) that acceptance activates the user.
- [ ] 4.5 Accepting an expired invitation fails and does not change the
  user's status; the invitation's state is reported as `expired`. Verify:
  `invitations.int.test.ts` covers "Accepting an expired invitation fails",
  using a clock seam to advance past 48 hours.
- [ ] 4.6 Accepting a cancelled or already-accepted invitation fails.
  Verify: `invitations.int.test.ts` covers "Accepting a cancelled invitation
  fails" and a second acceptance of an already-`accepted` invitation.
- [ ] 4.7 `identity.users.cancelInvitation`, Cerbos-gated to admins. Verify:
  `invitations.int.test.ts` covers "Admin can cancel a pending invitation"
  and "Non-admin cannot invite" (reused for cancel: a non-admin actor is
  denied and the invitation stays `pending`).
- [ ] 4.8 `identity.users.resendInvitation`: re-sends the invitation email
  without changing the invitation's expiry. Verify: `invitations.int.test.ts`
  covers "Resending a pending invitation does not change its expiry".
- [ ] 4.9 Invitation-acceptance failures (nonexistent invitation, wrong
  state, mismatched email) all return the same status, error code, and body
  shape, while `catalog.security.invitation_acceptance_denied`'s
  `denial_reason` still records the specific reason (design D4, VCDM
  pre-assessment ticket 11). Verify: `invitations.int.test.ts` covers
  "Invitation-acceptance errors do not reveal which failure occurred".
- [ ] 4.10 A per-tenant `@fastify/rate-limit` bucket, keyed by `tenantId`,
  shared by `identity.users.invite` and `identity.users.resendInvitation`
  (design D4, VCDM pre-assessment ticket 12). Verify:
  `invitation-rate-limit.int.test.ts` covers "Exceeding the per-tenant invite
  rate limit blocks further invites", asserting the `EmailSender` fake
  recorded no additional call and that `catalog.security.invitation_rate_
  limited` is logged.

## 5. Invitation email delivery

- [ ] 5.1 `EmailSender` port and a recording fake implementation for tests.
  Verify: `email-sender.test.ts` covers that the fake records `to` and the
  rendered template's link and expiry text.
- [ ] 5.2 `AzureCommunicationEmailSender` (real adapter over
  `@azure/communication-email`), constructed from the Key Vault-backed
  connection string, never called in CI. Verify: `azure-email-sender.test.ts`
  covers construction/config-parsing only (no network call), and a
  documented manual smoke-check script exists for a real sandbox account
  outside CI.
- [ ] 5.3 The invitation email template contains exactly one clickable link
  (the accept-invitation URL) and states the 48-hour expiry. Verify:
  `invitation-email-template.test.ts` covers "email contains exactly one
  link" by parsing the rendered HTML/text for anchor/URL occurrences.

## 6. Cerbos: invite and status-change authorization, ⛔ Checkpoint 3

- [ ] 6.1 Cerbos policy: `user.invite` and `user.updateStatus` actions on
  resource kind `user` (`002`'s existing kind, not a new one), importing
  `002`'s `same_tenant` derived role in every rule, allowed only for the
  `admin` role, with a condition denying `user.updateStatus` when `R.id ==
  P.id` (self-status-change, using `002`'s own `R`/`P` CEL shorthand
  convention). Verify: `cerbos compile` runs the policy's own test suite
  (`user_test.yaml`) covering both actions × admin/non-admin × self/non-self.
  **Stop for Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 6.2 `identity.users.setStatus`: validates the transition through
  `nextStatus` (group 3), checks the Cerbos grant, requires step-up
  (`x-tayzu-risk: high`), and appends a change event. Verify:
  `user-status-op.int.test.ts` covers a successful disable/re-enable through
  the full operation pipeline.
- [ ] 6.3 A user attempting to change their own status is denied and a
  `catalog.security.self_status_change_denied` event is logged. Verify:
  `user-status-op.int.test.ts` covers "A user cannot disable themselves".
- [ ] 6.4 A non-admin attempting `identity.users.invite` is denied and no
  invitation is created. Verify: `invitations.int.test.ts` covers "Non-admin
  cannot invite" at the operation level (Cerbos deny, not just the pure
  state machine).
- [ ] 6.5 A rule on `002`'s existing `user.yaml` resource policy denies any
  action that would leave a `resource.attr.accountKind == "service"` entity
  with role `admin` or a non-empty `moderatedBlueprints` (design D3/D6,
  Resolved decision Q7). ⛔ **Stop for Checkpoint 3 approval of the policy
  diff before continuing.** Verify: `cerbos compile` runs `user_test.yaml`'s
  extended cases covering a service-account entity denied `admin` role and
  denied a non-empty `moderatedBlueprints`, while an equivalent standard
  account is unaffected.

## 7. Service accounts

- [ ] 7.1 Service-account identifier pattern
  `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`, validated at creation. Verify:
  `service-accounts.test.ts` covers acceptance of `svc-ci-github` and
  rejection of `ci-github` (missing prefix) and an over-length identifier.
- [ ] 7.2 `identity.serviceAccounts.create`: creates the `_user` entity
  (`status: Active`, `accountKind: "service"`) and issues an
  organization-owned Better Auth API key by reusing `002`'s existing
  `machine-credential` apiKey config directly (`actorKind: "integration"`
  fixed, `metadata.userId` bound to the new `_user` entity — not a new key
  config) in one orchestrated call, returning `clientId`/`clientSecret` once.
  Verify: `service-accounts.int.test.ts` covers "Service account is active
  immediately, no email", asserting the `EmailSender` fake recorded zero
  calls and that a later read of the account never includes the secret.
- [ ] 7.3 Cerbos policy: `service_account.create` on resource kind
  `service_account`, importing `002`'s `same_tenant` derived role,
  `admin`-only. ⛔ **Checkpoint 3.** Verify: `cerbos
  compile` runs `service_account_test.yaml` covering admin/non-admin, and
  `service-accounts.int.test.ts` covers "A non-admin cannot create a service
  account".
- [ ] 7.4 Disabling a service account (via `identity.users.setStatus`) also
  disables its credential. Verify: `service-accounts.int.test.ts` covers
  "Disabling a service account disables its credential", asserting the
  credential can no longer produce an access token afterward.
- [ ] 7.5 Re-enabling a disabled service account re-enables its credential.
  Verify: `service-accounts.int.test.ts` covers the enable direction of the
  same scenario.
- [ ] 7.6 Deleting a service account's `_user` entity revokes (not merely
  disables) its credential. Verify: `service-accounts.int.test.ts` covers
  "Deleting a service account revokes its credential", asserting the
  credential cannot be re-enabled afterward.
- [ ] 7.7 `identity.serviceAccounts.create` validates the requested role and
  `moderatedBlueprints` at input: only `member` and an empty list are
  accepted (design Q7). Verify: `service-accounts.int.test.ts` covers
  "Creating a service account with an elevated role is rejected", asserting
  no `_user` entity or credential is created.
- [ ] 7.8 The Cerbos-layer role restriction (task 6.5) is exercised through
  the full operation pipeline, independent of 7.7's input validation (design
  Q7). Verify: `service-accounts.int.test.ts` covers "Granting an existing
  service account a Moderator grant is rejected", asserting
  `moderatedBlueprints` stays empty.

## 8. Org API-credentials viewer

- [ ] 8.1 `identity.credentials.list`: projects org-owned API keys to
  `{ name, kind, prefix, createdAt, lastRequest, enabled, rotationDueAt }`,
  joining `metadata.userId` to the `_user` entity for service-account keys,
  and never selects the hashed `key` column into the response shape.
  Verify: `credentials.int.test.ts` covers "Listing never includes the
  secret" by asserting no field in the response ever equals a seeded
  credential's known secret value.
- [ ] 8.2 Cerbos policy: `credential.list` on resource kind `credential`,
  importing `002`'s `same_tenant` derived role, `admin`-only. ⛔ **Checkpoint 3.** Verify: `cerbos compile` runs
  `credential_test.yaml`, and `credentials.int.test.ts` covers "Non-admin
  cannot list credentials".
- [ ] 8.3 `rotationDueAt` is computed from the credential's
  `metadata.rotatedAt` plus the configured rotation interval (default 90
  days). Verify: `credentials.test.ts` (pure) covers a credential rotated 91
  days ago is flagged due, and one rotated yesterday is not.

## 9. Credential rotation and revocation

- [ ] 9.1 `identity.credentials.rotate`: creates a new credential, returns
  its secret once, and disables the old credential in the same operation.
  Verify: `credentials.int.test.ts` covers "Rotating replaces the usable
  credential", asserting the old credential can no longer produce an access
  token and the new one can.
- [ ] 9.2 Cerbos policy: `credential.rotate` and `credential.revoke` on
  resource kind `credential`, importing `002`'s `same_tenant` derived role,
  `admin`-only, both requiring step-up
  (`x-tayzu-risk: high`). ⛔ **Checkpoint 3.** Verify: `cerbos compile` runs
  `credential_test.yaml`'s rotate/revoke cases, and `credentials.int.test.ts`
  covers a step-up-required denial for rotation without a fresh
  verification.
- [ ] 9.3 `identity.credentials.revoke`: permanently disables a credential;
  it can never be re-enabled afterward. Verify: `credentials.int.test.ts`
  covers "Revoking a credential is permanent".
- [ ] 9.4 Rotation and revocation log events carry only opaque credential
  identifiers, never a secret value, even under a forced serialization of
  the full credential object. Verify: `credentials.int.test.ts` covers a
  marker-leak check: a credential secret string never appears in the
  `catalog.audit.credential_rotated` or `catalog.security.credential_revoked`
  log record.

## 10. Org deletion

- [ ] 10.1 Cerbos policy: `organization.delete` on resource kind
  `organization`, importing `002`'s `same_tenant` derived role, `admin`-only.
  ⛔ **Checkpoint 3.** Verify: `cerbos compile`
  runs `organization_test.yaml` covering admin/non-admin.
- [ ] 10.2 `identity.organization.delete` requires a fresh step-up
  verification and requires the caller to supply the organization's own
  identifier as confirmation. Verify: `org-deletion.int.test.ts` covers
  "Deletion without step-up fails" and a mismatched-confirmation-identifier
  case, asserting nothing is deleted in either case.
- [ ] 10.3 Confirmed deletion revokes every member's active sessions,
  disables every org-owned API key, deletes every `catalog_*` row scoped to
  the tenant, and deletes Better Auth's `member`/`invitation`/`apikey` rows
  for the org, in one operation. Verify: `org-deletion.int.test.ts` covers
  "Confirmed deletion removes tenant data and access", seeding blueprints,
  entities, members and credentials first and asserting all are gone.
- [ ] 10.4 `catalog.audit.org_deletion_completed` is logged before the
  organization row itself is removed (via Better Auth's
  `afterDeleteOrganization` hook). Verify: `org-deletion.int.test.ts` asserts
  the log record's timestamp precedes the organization row's disappearance,
  using the telemetry harness's in-memory log exporter.
- [ ] 10.5 Deleting an already-deleted organization fails with
  `CATALOG_NOT_FOUND` and performs no further deletion. Verify:
  `org-deletion.int.test.ts` covers "Deleting an already-deleted organization
  is safe".
- [ ] 10.6 The organization's own identifier, not a boolean flag, is required
  as the deletion confirmation payload. Verify: `org-deletion.int.test.ts`
  covers a request with the confirmation field omitted or wrong, asserting
  `CATALOG_VALIDATION_FAILED` and no deletion.

## 11. API contract

- [ ] 11.1 oRPC procedures and routes for all ten operations in design D10,
  with `x-tayzu-risk: high` on `setStatus`, `credentials.rotate`,
  `credentials.revoke`, and `organization.delete`. Verify:
  `router.int.test.ts` calls each procedure once on its happy path through
  `createRouterClient`, and asserts the four high-risk procedures carry the
  marker in the generated OpenAPI document.
- [ ] 11.2 `002`'s existing `AUTH_STEP_UP_REQUIRED` maps to HTTP 403 for all
  four of this change's high-risk procedures. Verify: `errors.int.test.ts`
  covers the mapping over the mounted HTTP server for a session without a
  fresh MFA verification calling a high-risk procedure.

## 12. Telemetry contract enforcement

- [ ] 12.1 Extend `@tayzu/auth`'s `telemetry/contract.ts` with every span,
  metric and log event from design.md's Observability contract. Verify:
  `contract.test.ts` snapshot-asserts every declared name, and the
  `observability-auditor` review compares the two.
- [ ] 12.2 Extend `otel-smoke-check` to run every operation in this change
  once successfully and once per applicable error/denial class. Verify:
  `pnpm otel-smoke-check` is green, and removing one declared span in a
  scratch branch makes it fail.
- [ ] 12.3 Extend the cardinality guard to `tayzu.identity.*` metrics: no
  attribute key outside the contract's allowed set. Verify:
  `otel-smoke-check` fails when a deliberately added
  `tayzu.identity.invitation.email` metric attribute is introduced in a
  scratch branch.
- [ ] 12.4 Marker-leak test across this change's signals. Verify:
  `otel-smoke-check` covers "Invited email never reaches telemetry" for an
  invite, an expired-acceptance attempt, a rate-limited invite attempt, and a
  credential rotation (secret value as the marker for the last one).

## 13. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 13.1 Write `docs/adr/0017-service-account-identifier-convention.md`
  (design D6). Verify: the file exists with Context/Decision/Alternatives/
  Consequences, and design D6 links to it.
- [ ] 13.2 Write `docs/adr/0018-credential-rotation-immediate-cutover.md`
  (design D8). Verify: same structure, linked from design D8.
- [ ] 13.3 Write `docs/adr/0019-org-deletion-backup-window-recovery.md`
  (design D9). Verify: same structure, linked from design D9.
- [ ] 13.4 Write `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md`
  (design D3). Verify: same structure, linked from design D3.
- [ ] 13.5 Write `docs/security/data-retention.md`: retention windows per
  data category (org-deletion backup window, credential rotation cadence,
  the per-tenant invitation rate-limit default), cross-referencing `010`/
  `015` for audit/security log retention rather than redefining it. Verify:
  `pnpm lint:md` passes.
- [ ] 13.6 Update `docs/architecture/system-diagram.md`: add the email
  provider as a new external actor, and arrows for invite→email, credential
  rotation, and org deletion. Verify: the Mermaid block still renders with
  `npx -y @mermaid-js/mermaid-cli`, and every new attack-surface route from
  design D10 appears in the diagram.
- [ ] 13.7 `pnpm ci:local` is fully green (lint, typecheck, unit and
  integration tests, contract-check, otel-smoke-check, cerbos compile,
  audit, gitleaks). Verify: attach the command output to the PR description.
- [ ] 13.8 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against
  the implemented code, and resolve or explicitly defer every blocking gap.
  Verify: the report is attached to the PR with zero open blocking gaps.
- [ ] 13.9 Run `/security-review` on the branch and fix or justify every
  finding. Verify: the review output is attached to the PR.
- [ ] 13.10 `openspec validate 043-identity-lifecycle-and-org-admin --strict`
  passes, and design/specs/code agree (update design only if an
  implementation finding forced a change, noted in the PR). Verify: the
  command output is attached to the PR.

## 14. Hand-offs from 002 (002 design Q73; mount gate)

`identity.*` and the machine-credential routes are not mounted over HTTP
before every task in this group is done.

- [ ] 14.1 `machine_credential_revocation` gets a composite `(tenant_id,
  credential_id)` key (a migration, Checkpoint 3), and machine-credential
  create and revoke go through Cerbos and are marked `x-tayzu-risk: high`.
  Verify: a cross-tenant pre-insert of a known id is refused, and a non-admin
  is denied create and revoke.
- [ ] 14.2 Identity operations refuse a target that has a membership outside
  the caller's tenant, so an admin of one tenant cannot link an SSO `sub` to,
  or otherwise act on, a user who also belongs to another tenant (002 VCDM
  M10). Verify: `linkSsoAccount` on a two-tenant user is refused.
- [ ] 14.3 `createUser` and `linkSsoAccount` give no email or `sub`
  existence oracle, and the Q42 audit events (user, credential and bootstrap
  lifecycle) are emitted. Verify: an existing and an unknown email answer
  identically, and each lifecycle action emits its declared event.
- [ ] 14.4 `resolveContext` rejects a disabled (`banned`) user, disabling a
  user revokes its sessions, and an admin-initiated disable (off-boarding)
  path exists (002 VCDM M20). Verify: a banned user cannot sign in locally or
  through SSO, and existing sessions stop working.
- [ ] 14.5 Temporary and bootstrap passwords force a change at first sign-in
  and expire, and the password policy is decided (minimum length,
  breached-password check, backoff or lockout) (002 VCDM M5, M11). Verify:
  a temporary password grants only the change-password route.
- [ ] 14.6 Inherited ownership is reachable or explicitly removed from the
  spec, and a `replace`-mode upsert without `ownerTeam` cannot silently
  release ownership; authorization and the write run in one transaction
  (002 VCDM M4, M15). Verify: the corresponding scenarios pass.

