# Tasks: 045-org-deletion-and-data-retention

**How to execute these tasks (Agentic TDD).** Every task below, except the
tasks marked _(setup)_, is **one self-contained red-green-refactor cycle**:

1. **Red.** Write only the test named in the task's _Verify_ clause. Run it
   and see it **fail for the expected reason**: a missing behavior, not a
   typo or a missing import. With the `test-writer`/`implementer` split, this
   step belongs to `test-writer`.
2. **Green.** Write the minimum production code that makes the test pass.
   Do not change the test.
3. **Refactor.** Clean up with every test green. Run
   `pnpm --filter <pkg> test`, `pnpm lint` and `pnpm typecheck`.
4. Tick the box only when all three steps are done, and commit with the task
   number (for example `feat(api): 5.2 org deletion records the marker`).

A task marked **(Checkpoint 3)** adds or changes a database migration or a
Cerbos policy: stop before it and present the SQL or the policy, with its
`cerbos compile` output, for the human's separate approval (root `CLAUDE.md`).

Tasks follow the Resolved decisions in `design.md`, which are carried from
`043` (Q1-Q103); there are no open questions.

This change depends on `002` and on `043` and executes after `044`. A reference
to a task of `043` is to that change's `tasks.md` as it stands after the split
(its old group 12, the org-deletion group, is this change). Migrations run from
`0012` to `0014` (`043` owns `0011`; nothing is renumbered), follow the repo's
pairing of a table migration with a hand-written grants migration, and every
migration and every Cerbos task is marked **(Checkpoint 3)** and stops for the
human's separate approval.

**Order matters.** The route of group 8 is registered behind the mount switch of
`043`, which is off by default, and no HTTP assertion about it is written before
`043`'s hand-offs from `002` (its group 13) are done. Groups 1 to 7 test in
process through `createRouterClient`, the service layer or the scripts.

Scenario names in quotes refer to
`specs/org-deletion-and-data-retention/spec.md`. Test files live next to the
code as `*.test.ts`. Integration tests are named `*.int.test.ts` and need
`DATABASE_URL` plus a running Cerbos test container, per `002`'s own harness.

## 1. Setup and coordination with `002` and `043`

- [ ] 1.1 _(setup)_ Before Checkpoint 1, run the `vcdm-ssa-validator`
      pre-assessment (Mode A) of this change's proposal, spec, design and tasks
      against SEC01-SEC16, and a drift-check of the files the design names
      (`context-resolver.ts`, `token-exchange.ts`, `identity-router.ts` and its
      wrapper, `server.ts` and the mount switch, the identity contract module,
      `bootstrap.ts`, `packages/db/src/harness.ts` and the migrations journal)
      against the merged `002` and, as far as it is built, `043`. Mechanical drift
      is fixed in place in the Context of `design.md`; every scope or design
      conflict and every open question is asked in chat with 2 to 4 options and a
      recommendation and recorded in "Resolved decisions" as a row after Q103 (root
      `CLAUDE.md`). The human approves the proposal only after this task. At
      implementation time it is repeated as a last drift-check against `043` as
      merged, and adjusts import paths and attribute names only if drift is found,
      with no scope change. Verify: the report is attached to the PR with zero open
      blocking gaps or an explicit deferral recorded, and a short note in the PR
      description states what, if anything, was adjusted.
- [ ] 1.2 _(setup)_ Scaffold the homes of the deletion code:
      `apps/api/src/identity/org-deletion.ts` (an empty module) and, in
      `apps/api/scripts/`, `purge-job.ts` and `cancel-org-deletion.ts`, with the
      package scripts `identity:purge` and `identity:cancel-org-deletion`. Vitest
      includes only `src/**`, so a script has no test beside it: its tests live in
      `apps/api/src/` and import `../scripts/<name>.js` (`043`'s task 1.4), and the
      `scripts-smoke.test.ts` of `043` gains the two modules. Verify: `pnpm --filter
      @tayzu/api test` runs the smoke test green, and `pnpm lint` and `pnpm
      typecheck` cover the new modules.
- [ ] 1.3 _(setup)_ Extend the test harness and the script configuration for the two
      new roles. `packages/db/src/harness.ts` (which `043`'s task 2.0b extends with the
      `tayzu_auth` login role) sets up neither `tayzu_purge` nor `tayzu_deletion_admin`,
      so tests that run as them need login roles, pools and membership grants of their
      own (the harness's bare `GRANT ... TO current_user` carries `set_option` and
      `inherit_option`, which the assertion of 2.2 filters out by member). The script
      loader of `043` (`apps/api/scripts/script-config.ts`) gains `PURGE_DATABASE_URL` and
      `REVERSAL_DATABASE_URL` (read only by the two scripts, never printed,
      `sslmode=verify-full` outside test like `DATABASE_URL`). The harness's
      `reassignAuthOwnership` list (`harness.ts`) and the assertions of the db package's
      `harness-ownership.int.test.ts` (around lines 94 and 150), which are the by-name
      lists of tables (`CATALOG_TABLES` in `harness.ts` is the `tenant_isolation` set, not
      a by-name list, and is not the place), and the exact table list asserted by
      `packages/catalog/src/persistence/schema.int.test.ts` gain
      `tenant_deletion_marker` in 2.1, when the table exists. Verify: `pnpm --filter
      @tayzu/db test` and `pnpm --filter @tayzu/api test` stay green, and
      `script-config.test.ts` covers the two new variables being read, a script reading
      only its own variables, and a missing one failing only the script that needs it.


## 2. Deletion marker and database roles, ⛔ Checkpoint 3 (migrations `0012`, `0013` and `0014`)

- [ ] 2.1 (Checkpoint 3) Migration `0012_tenant_deletion`: the
      `tenant_deletion_marker` table (tenant id, `requested_at` with `DEFAULT
      now()`, `purge_after`, the requesting actor's opaque id, `state` in
      `pending`/`cancelled`/`purged` defaulting to `pending`, the timestamps of the
      two purge steps, and the cancellation fields `cancelled_at` and
      `cancelled_by`, the operator's opaque id), a `CHECK` that `purge_after` is
      between `requested_at + 7 days` and `requested_at + 14 days`, a partial unique
      index allowing one pending marker per tenant, and the Drizzle table in
      `packages/catalog/src/persistence/schema.ts`. The request computes `purge_after` in
      SQL as `now() + make_interval(days => $1)` (5.2), so it and the database-set
      `requested_at` come from one transaction clock, and a date computed in the
      application cannot be refused by the 14-day bound under clock skew. A `DEFAULT`
      does not ignore an
      explicit value, so what keeps the request role from setting `requested_at`,
      `state` or a step timestamp is the column-level `INSERT` grant of 2.2. It
      carries `migrations/down/0012_tenant_deletion.down.sql`,
      `meta/0012_snapshot.json` and its `_journal.json` entry. Verify:
      `tenant-deletion-migration.int.test.ts` covers a `purge_after` of 6 and of 15
      days refused and one computed as `now() + make_interval(days => 14)` accepted, a second pending marker for one tenant refused, the defaults
      (`requested_at` now, `state` `pending`) applying to an insert that omits them,
      and the harness table lists and `schema.int.test.ts` updated for the new table
      (1.3). ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 2.2 (Checkpoint 3) Migration `0013_tenant_deletion_grants` (hand-written,
      like `0009`), catalog side (Resolved decision Q48): creates the `tayzu_purge`
      role (own pool and secret, used only by the purge job; guarded and with no
      password, like `0006`) and the `tayzu_deletion_admin` role (Q35, only able to
      tombstone a pending marker: update `state`, `cancelled_at` and `cancelled_by`,
      under a policy that also requires that no purge step is recorded and
      `purge_after > now()`, and holding `SELECT` on the marker under a policy with the
      same predicate, because an `UPDATE ... WHERE` and its `RETURNING` need one and the
      predicate keeps it from reading any other marker). Schema `public` is granted per role (`0006`), so each
      new role gets `USAGE` on `public`, and `tayzu_purge` gets no `USAGE` on `auth`
      here (2.3) and `tayzu_deletion_admin` none at all. It grants `tayzu_app`
      `SELECT` on the marker and a **column-level** `INSERT` limited to the tenant
      id, `purge_after` and the requesting actor (so `requested_at`, `state`, the
      step timestamps and the cancellation fields always take their defaults), under
      a tenant-isolation policy and **no** `UPDATE` or `DELETE`; `FORCE ROW LEVEL
      SECURITY`; gives `tayzu_purge` a `SELECT` policy on the marker limited to due
      pending markers (the listing of due tenants, with no function), `UPDATE` of
      the progress columns and of `state` to `purged`, and `SELECT` **and** `DELETE`
      on the tenant's tables, **named one by one**: `catalog_blueprint`,
      `catalog_relation_definition`, `catalog_entity`, `catalog_entity_relation`,
      `catalog_change_event`, `catalog_tenant_sequence` and
      `machine_credential_revocation` (which has no `catalog_` prefix), each under
      its own `SELECT` and `DELETE` policies limited to tenants with a due pending
      marker (a `DELETE ... WHERE tenant_id` needs the `SELECT` privilege and a
      `SELECT` policy as well as the `DELETE` ones, and the `entities_removed` count
      needs reads); and amends the append-only trigger of `0001` to allow `DELETE`
      only when `current_user` is `tayzu_purge`. It creates **no function** and
      transfers no ownership. It carries
      `migrations/down/0013_tenant_deletion_grants.down.sql`,
      `meta/0013_snapshot.json` and its `_journal.json` entry; the Better Auth side
      is its own migration, 2.3, so that each approved file stays immutable (Resolved
      decision Q82). Verify: `tenant-deletion-grants.int.test.ts`
      covers that `tayzu_app` can insert its own tenant's marker but cannot update,
      delete or read another tenant's, and cannot back-date one: an insert that
      names `requested_at`, `state` or a step timestamp is refused for lack of the
      column privilege; that `tayzu_purge` sees only due pending markers (the
      listing) and cannot read or delete the rows of a tenant without a due marker;
      that a due tenant's change events and revocation rows are read, counted and
      deleted by `tayzu_purge`; that a direct `DELETE` by `tayzu_app`, by the table
      owner and by `tayzu_purge` outside a due tenant is still refused by the
      trigger or the policy, on each of the seven tables; that no role can `SET ROLE
      tayzu_purge` (a `SET ROLE` attempt by `tayzu_app`, `tayzu_auth`,
      `tayzu_migrator` and `tayzu_deletion_admin` fails, and every `pg_auth_members`
      row that names it as the granted role and one of those four roles as the member
      has `set_option` and `inherit_option` false, because PostgreSQL 16 gives the
      creating role an admin-only membership; the harness's own bare
      `GRANT ... TO current_user` carries both options and names the connecting test
      role, so the rows are filtered by member) and that `tayzu_purge`
      owns no object; that `tayzu_deletion_admin` can tombstone a pending marker
      with no purge step and a future date and cannot once a step is recorded or the
      date has passed, reads no marker other than a pending one with no recorded step and a future date
      (the tombstone's `UPDATE ... WHERE ... RETURNING` working), cannot read or delete
      tenant data and has no `USAGE` on `auth`; and that the migration creates no `SECURITY DEFINER` function. ⛔
      **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 2.3 (Checkpoint 3) Migration `0014_tenant_deletion_auth_grants`
      (hand-written), Better Auth side (Resolved decisions Q49, Q59 and Q65):
      row-level security on the Better Auth tables that purge step 2 deletes from,
      **named one by one** (`organization`, `member`, `invitation`, `apikey`, `session`,
      `user`, `account`, `two_factor` and `verification`), each with an explicit
      table-level `GRANT SELECT, DELETE` to `tayzu_purge` (a policy grants nothing without
      the privilege), with a permissive policy `TO tayzu_auth` (`USING (true)
      WITH CHECK (true)`, so Better Auth's behavior is unchanged: the due-tenant
      restriction applies to the purge role, not to `tayzu_auth`) and due-marker
      policies for `tayzu_purge`. The `auth` schema has `REVOKE ALL ... FROM PUBLIC`
      and `USAGE` only for `tayzu_auth` (`0003`), so `tayzu_purge` also gets `USAGE`
      on `auth`. Its `DELETE` (and the `SELECT` it needs) is allowed on an
      organization-keyed row only when its organization has a due pending marker
      (`invitation`, `member`, `apikey` by `reference_id`, the organization, and a
      `session` by `active_organization_id`, which has no foreign key); on a
      user-keyed row only for a user whose memberships are all in due tenants and
      who has at least one; and on an `auth.verification` row by its identifier
      family, joined to the row it names: an `invitation-accept:<invitationId>` row
      when that invitation's organization is due, a
      `step-up-verified:<sessionToken>` row when that session is deleted by the
      step, a `temp-password:<userId>` row and an `sso-link:<accountId>` row by the
      user predicate. A verification row is therefore deleted before the row its
      policy joins (an `sso-link:<accountId>` row, keyed by the `account` row's id, before
      the account, and a `temp-password:<userId>` row before the user; 6.2). The migration also grants a **read-only `SELECT` policy
      over every `auth.member` row**, so that the user predicate can see a user's
      memberships in tenants that are not due while the `DELETE` on `member` stays
      limited to due tenants. `tayzu_purge` gets nothing else on the `auth` schema.
      The exact predicates are presented at Checkpoint 3. It carries
      `migrations/down/0014_tenant_deletion_auth_grants.down.sql`,
      `meta/0014_snapshot.json` and its `_journal.json` entry. Verify:
      `tenant-deletion-auth-grants.int.test.ts` covers that `tayzu_purge` deletes
      the Better Auth rows of a due tenant and of a user whose memberships are all
      in due tenants, and the verification rows by family; can read but not delete a
      `member` row of a tenant that is not due; cannot delete the rows of a tenant
      that is not due, of a user who also belongs to a tenant that is not due (the
      predicate sees the other membership), or of a user with no membership; cannot
      touch any other `auth` table (each of the nine tables carries its own explicit
      grant); and that `tayzu_auth` keeps full access to every
      tenant's rows, so `pnpm --filter @tayzu/auth test` stays green. ⛔ **Stop for
      Checkpoint 3 approval of the SQL before continuing.**
- [ ] 2.4 The runtime-role assertion at startup covers the new tables.
      `assertRuntimeRole` in `apps/api/src/bootstrap.ts` checks ownership only for
      relations whose name matches `catalog\_%`, which `tenant_deletion_marker` and
      `machine_credential_revocation` do not, so a runtime role that owned either
      would pass. The check lists them by name as well, and the assertion is exported as a function the
      test can call, because the startup call is skipped under `NODE_ENV=test`
      (`bootstrap.ts`). Verify: `bootstrap-wiring.int.test.ts` (in `apps/api/src/`, whose
      runtime-role suite already exists; `bootstrap.test.ts` is the unit file) calls it
      and covers it failing when the runtime role owns `tenant_deletion_marker`, failing
      when it owns `machine_credential_revocation`, and still passing for the real
      roles.

## 3. Cerbos foundations, ⛔ Checkpoint 3

- [ ] 3.1 `RESOURCE_KINDS` (`packages/authz/src/resource-kinds.ts`) gains `organization`,
      and the Cerbos attributes of the identity wrapper (`043`'s tasks 5.1 and 5.3b) are
      built for it: the target of `organization.delete` is the host tenant, so the real
      tenant and the opaque resource id are both the tenant id (never the organization's
      name or any value read from input). Verify: `resource-kinds.test.ts` covers the kind
      existing, and `identity-attributes.test.ts` covers the resource tenant and the
      resource id of `organization.delete` being the host tenant id.
- [ ] 3.2 (Checkpoint 3) Role ceilings: `policies/role_policies/admin.yaml` lists
      `organization` explicitly, `member.yaml` states the ceiling if one is needed, and
      `role_policies_test.yaml` is extended (the shared `testdata/` gains the kind). A
      role-policy allow does nothing without a resource-policy allow, so the
      admin-allowed assertion is made in 3.3. Verify: `cerbos compile` runs
      `policies/resource_policies/role_policies_test.yaml` showing a member denied on
      `organization.delete` and the admin ceiling accepted by the compiler. ⛔ **Stop for
      Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 3.3 (Checkpoint 3) Cerbos policy: `organization.delete` on resource kind
      `organization`, importing `002`'s `same_tenant` derived role and carrying the
      explicit cross-tenant `EFFECT_DENY` of `002` D8, `admin`-only (any admin may
      request it, Resolved decision Q27). Verify: `cerbos compile` runs
      `policies/resource_policies/organization_test.yaml` (with its resources in the
      shared `testdata/resources.yaml`) covering admin/non-admin × same/other tenant, including
      the explicit cross-tenant deny and the admin being allowed, and extends
      `same_tenant_test.yaml` (the existing "denied on every kind" suite) with kind
      `organization`. ⛔ **Stop for Checkpoint 3 approval of the policy diff before
      continuing.**

## 4. Deletion notice

- [ ] 4.1 The `OrgDeletionNotice` template (Resolved decision Q27) joins the closed
      `EmailTemplate` union of `043`'s task 6.1 (`InvitationEmail` and
      `AdminAcceptedNotice`) and has a fixed subject and body, interpolates only the
      purge date, and contains no link and no tenant or actor free text. Verify:
      `org-deletion-notice-template.test.ts` covers "The deletion notice carries no free
      text" (an organization named `<b>Pay now</b>` and a markup-bearing actor name never
      appear) by parsing the rendered HTML and text, and `email-sender.test.ts` (extended)
      covers the union accepting the template while the port still takes exactly one
      recipient.

## 5. Phase 1: the deletion request

- [ ] 5.1 `identity.organization.delete` requires the caller to send the
      organization's identifier, which must equal the host `ctx.tenantId`; over HTTP it
      travels in the query string (`DELETE` routes use `inputStructure: 'detailed'`,
      design D6). Verify: `org-deletion.int.test.ts` covers "Org deletion targets only
      the host tenant" and a missing or wrong confirmation returning
      `CATALOG_VALIDATION_FAILED`, asserting nothing changes.
- [ ] 5.2 Phase 1 records the marker (as `tayzu_app`, insert-only) with a
      `purge_after` inside the configured window (7 to 14 days, validated at startup,
      default 14; computed in SQL, 2.1), revokes every session whose active organization
      is the tenant (each revocation emitting `auth.security.session_revoked` with the
      reason `admin_action`), revokes every org-owned credential through the revocation list, cancels pending
      invitations, and logs `catalog.audit.org_deletion_requested` with the admin as
      `tayzu.actor.id`. Verify: `org-deletion.int.test.ts` covers the data-still-present
      and marker parts of "Requesting deletion revokes access at once", the `auth.security.session_revoked` event for each revoked session, and a window
      outside 7 to 14 failing startup.
- [ ] 5.3 Requesting deletion again while pending inserts no second marker, sends no
      second notice and returns the original date, but **re-runs the idempotent
      revocations** of phase 1 (sessions, credentials, invitations), so that a first
      request that failed half-way is completed and a later reversal cannot leave a
      session or credential alive (design D1). Verify: `org-deletion.int.test.ts` covers
      "Requesting deletion twice returns the original date" (one marker, the original
      date, no second notice), in process, and "A repeated request completes a
      half-failed first one": a first request that failed after the marker was recorded
      (a failure seam on the credential revocation) leaves a live credential, and the
      repeat revokes it.
- [ ] 5.4 A repeated deletion request is logged as
      `catalog.security.org_deletion_repeated` (declared in 9.1) with the tenant and the
      admin as actor. Verify: `org-deletion.int.test.ts` covers the event on the second
      request and not on the first, with no email or free text in it.
- [ ] 5.5 Phase 1 sends the fixed `OrgDeletionNotice` through the dispatcher of
      `043`'s task 6.12 to the administrators of the organization (at most 20), one email per
      recipient, resolved on the server from the tenant's memberships; a send failure
      never blocks the request and logs `catalog.security.org_deletion_notice_failed`,
      and a suppression logs `catalog.security.notice_suppressed` (Resolved decisions
      Q27 and Q53). Verify:
      `org-deletion-notice.int.test.ts` covers "Every admin is notified of a pending
      deletion" with the recording fake (an owner and two admins each receive exactly
      one email, a plain member none) a failing sender and a suppressed notice not stopping the request.
- [ ] 5.6 `resolveContext` and token exchange reject every principal, human or
      machine, of a tenant with a **pending** or a **purged** deletion marker (a
      cancelled marker does not reject), logging `catalog.security.principal_rejected`
      with reason `tenant_pending_deletion`, and the acceptance of an invitation of
      such a tenant answers the uniform rejection (`denial_reason`
      `tenant_pending_deletion`). Verify: `org-deletion.int.test.ts` covers the access
      part of "Requesting deletion revokes access at once" for a session and an
      already-issued machine token, a tenant whose marker is `purged` being rejected
      too and a cancelled one accepted, `token-exchange.int.test.ts` a **fresh** exchange of a credential of a pending and of a
      purged tenant being refused (not only an already-issued token being rejected), and
      `invitation-accept.int.test.ts` the rejected acceptance.

## 6. Phase 2: the purge

- [ ] 6.1 Purge step 1 (`tayzu_purge`): ordered deletes of the tenant's
      relations, entities, blueprints and other `catalog_*` rows that respect the
      `RESTRICT` foreign keys, and the append-only rows, which the amended trigger and the policies admit for
      `tayzu_purge` and a due tenant (2.2),
      recording progress on the marker. Verify: `org-purge-catalog.int.test.ts` covers
      "Purge removes tenant data after the window" for the catalog side on a tenant
      seeded with relations, entities, blueprints and change events.
- [ ] 6.2 Purge step 2 (`tayzu_purge`, under the policies of 2.3): each user with
      no other membership together with their `account`, `session` and `two_factor`
      rows and the `auth.verification` rows keyed by that user
      (`temp-password:<userId>`, and `sso-link:<accountId>` keyed by the `account` row's
      id; the verification rows go first, because their policies join the user and the
      account), deleted while their
      membership still exists so that the policy can evaluate it, each user in **one
      transaction that re-checks the user's memberships** (the read-only `member`
      visibility of 2.3), so a membership added in between is seen; the
      `step-up-verified:<sessionToken>` markers, which are keyed by the **session
      token** and not by the user (`packages/auth/src/step-up.ts`), so the step
      collects the tokens of those sessions first and deletes the markers before the
      sessions; then, in this order, the tenant's invitation tokens in
      `auth.verification` **before** the invitations (their policy joins
      `invitation`, so the invitation must still exist), the invitations, the API
      keys (`referenceId`), the sessions whose `active_organization_id` is the
      tenant (those of users who stay), the members, and the organization row last.
      Verify: `org-purge-auth.int.test.ts` covers "Users with no other membership
      are removed, others are kept", including their verification rows (an `sso-link:` row going before its account), a
      `step-up-verified:` marker of one of their sessions being gone, an invitation
      token being gone and a user with a second membership keeping theirs, including
      a membership added between the check and the delete (a seam) keeping the user,
      and a remaining session of a staying user whose active organization is the
      purged tenant being deleted.
- [ ] 6.3 `catalog.audit.org_deletion_completed` is emitted by the purge
      immediately before the organization row is deleted (not from Better Auth's
      `afterDeleteOrganization`), and the script flushes it before it exits (the
      helper of `043`'s task 2.0, Resolved decision Q79). Verify: `org-purge-auth.int.test.ts`
      asserts the log record precedes the row's disappearance, using the telemetry
      harness's in-memory log exporter, and that it is exported by the time the
      script's run returns.
- [ ] 6.4 A failed step logs `catalog.security.org_deletion_failed` with the
      step, and the next run resumes without repeating a completed step. Verify:
      `org-purge-resume.int.test.ts` covers "A failed purge step is visible and
      resumes" with a failure seam after step 1.
- [ ] 6.5 A tenant whose window has not passed is never purged, a tombstone
      (tenant id, state and timestamps only) remains, and a repeated purge deletes
      nothing. Verify: `org-purge-resume.int.test.ts` covers "A purge does not touch
      a tenant whose window has not passed" and "A repeated purge is safe".
- [ ] 6.6 The purge job entry point, `apps/api/scripts/purge-job.ts`
      (`pnpm --filter @tayzu/api identity:purge`): a `tsx` script run by a scheduled job
      (its own Container Apps Job, Resolved decision Q49), started through the helper
      of `043`'s task 2.0, with no HTTP listener, that connects **only** as `tayzu_purge`
      (`PURGE_DATABASE_URL`, read by the script loader of `043`'s task 2.0b, extended in 1.3), lists the due
      tenants through the marker policy and runs one pass. It refuses to start under
      another role with a **new** check, `current_user = 'tayzu_purge'` (the `tayzu_purge` case of the helper of `043`'s task 2.0, which
      every script uses), because the existing `assertRuntimeRole` in `bootstrap.ts` is
      private and checks only
      superuser, `BYPASSRLS` and table ownership, so `tayzu_app` would pass it. Verify:
      `purge-job.int.test.ts` (in `apps/api/src/`, importing `../scripts/purge-job.js`,
      1.2) runs the script once against a due tenant, asserts it is purged, asserts the
      process opened no listener and no connection other than `tayzu_purge`, and
      asserts it refuses to start as `tayzu_app` (which passes `assertRuntimeRole`) and
      as `tayzu_auth`.
- [ ] 6.7 A completeness test driven by the schema's columns and the identifier
      patterns, not by foreign keys alone: every table that has a `tenant_id` column
      (catalog), every `auth` table that references an organization or a user by
      foreign key **or by column** (`apikey.reference_id` and
      `session.active_organization_id` have no foreign key) and the
      `auth.verification` rows by identifier pattern (`invitation-accept:`,
      `temp-password:`, `sso-link:` and `step-up-verified:`, which are keyed by
      string) is deleted by a purge step or explicitly exempted with a reason, so a
      later change that adds a table or a pattern cannot escape the purge. Verify:
      `purge-coverage.int.test.ts` enumerates the tables from the database catalog,
      fails for a table added in a scratch migration that no step covers and for an
      unlisted identifier pattern, and passes on the real schema. The test's table
      also classifies every identifier family and table `002` and Better Auth write,
      so that it passes on the real schema (design D2): `sso-reauth-state:` and
      `sso-reauth-result:` (deleted by step 2 or exempt, each with its reason),
      `backchannel-logout:<client>:<jti>` (exempt), `2fa-<random>` and
      `2fa-attempts-2fa-<random>` (written by Better Auth's two-factor plugin on
      every enrolled sign-in; exempt as short-lived state keyed by a random value,
      with its own expiry), the OAuth state identifiers if an SSO sign-in in the
      test shows Better Auth writes any to `auth.verification`, `auth.rate_limit`
      (exempt: hashed keys with no tenant, which can include a pseudonymous email
      hash that persists, stated in the erasure statement of 10.3) and `auth.jwks`
      (exempt).

## 7. Reversal and the maintenance workflow

- [ ] 7.1 The reversal script (`apps/api/scripts/cancel-org-deletion.ts`,
      `pnpm --filter @tayzu/api identity:cancel-org-deletion`, with the role of Q35,
      started through the helper of `043`'s task 2.0) tombstones a pending marker (`state =
      'cancelled'`, `cancelled_at` and `cancelled_by`; the row is never deleted) and refuses a tenant with no pending marker, a tenant whose purge has begun (a step
      timestamp is recorded) and a tenant whose purge date has passed (the reversal
      role's policy of 2.2 enforces the same). The operator's opaque id
      comes from the environment the maintenance workflow of 7.3 sets from its
      authenticated actor, never from an argument, and the script refuses to run
      without it (Resolved decision Q41). Verify: `cancel-org-deletion.int.test.ts`
      (in `apps/api/src/`, importing `../scripts/cancel-org-deletion.js`, 1.2) covers
      "A reversal is refused once the purge has begun" (a recorded step and a passed
      date, the marker unchanged) and "A platform operator reverses a pending deletion": the tenant's
      principals are accepted again, the row is still present as a tombstone, the
      script's role cannot delete or read tenant data, and the script refuses to run
      with no operator id.
- [ ] 7.2 The reversal emits `catalog.audit.org_deletion_cancelled`, flushed
      before the script exits (`043`'s task 2.0), with the operator's opaque id (the authenticated
      workflow actor, not a self-asserted value) and increments `tayzu.identity.org_deletions` with outcome `cancelled`,
      and a later deletion request after a reversal inserts a new marker. Verify:
      `cancel-org-deletion.int.test.ts` covers the event and its attributes with no
      email, the metric, and "Requesting deletion again after a reversal creates a new
      marker".
- [ ] 7.3 The maintenance workflow, `.github/workflows/identity-maintenance.yml`
      (Resolved decision Q41): the only way the reversal script reaches
      production and, from this task on, the way `043`'s `_user` blueprint backfill
      (`043`'s task 2.2) and reconcile (`043`'s task 2.2b) are started, which `043` runs as
      operator-started Container Apps Jobs, with the operator id set by hand, until
      then. It is one Container Apps Job per script, chosen by a `choice` input, and it
      **extends** that mechanism by deriving the operator id of all three from the
      workflow's authenticated actor. It is
      `workflow_dispatch` only, runs only from `master` (a job condition on the ref;
      the environment's deployment branches are limited to `master` by the
      human-owned settings of Resolved decision Q55, 10.6), declares a GitHub
      `environment` whose required reviewers enforce the named second approver, uses
      OIDC (`id-token: write`, no stored cloud secret) to start an Azure Container
      Apps Job, and passes `gh:` plus the numeric actor id (`github.actor_id`, never
      the login, which can be a bot name such as `x[bot]` that the catalog id
      pattern rejects) to the job through `env` as the operator id (Q70). It has
      **no checkout and no setup step**: its only steps are a SHA-pinned Azure login
      and the `az` call that starts the job, so no repository code runs on a runner
      that holds the OIDC token. The bootstrap CLI is **not** started by it (Resolved
      decision Q91): an operator runs it out of band, as `002` designed. Verify: `identity-maintenance-workflow.test.ts` (in
      `apps/api/src`, like `zap-seed.test.ts`, because `.github` is outside every
      package) reads the file as text and fails unless the only trigger is
      `workflow_dispatch`, a condition restricts the job to `refs/heads/master`, an
      `environment` is declared, `id-token: write` is the only elevated permission,
      no `secrets.` value other than the environment's is referenced, there is no
      checkout or setup step, and the operator id is `gh:` plus `github.actor_id`,
      passed through `env`, and the `choice` input listing exactly the reversal, the blueprint backfill and the reconcile (no bootstrap CLI, which is out of band, and no purge, which is scheduled).
- [ ] 7.4 The workflow's inputs and supply chain are hardened (Resolved decision
      Q64; design D3): every input is a `choice` (the job) or validated against the
      catalog's tenant-id regular expression (the tenant id, checked in a first step
      that fails the run) and reaches the job only through `env` or the job's
      environment-variable arguments; every `uses:` is pinned by a 40-character
      commit SHA, and none is a local action (`./.github/actions/setup`, which a SHA
      test would mis-handle and which `CODEOWNERS` would not cover as a workflow);
      the `az` call starts the named job with **no** `--command`, `--args`,
      `--image` or `--env-vars` override other than the fixed variable names (the
      operator id and the tenant id), because a start request can carry an execution
      template that replaces the job's command; and `.github/CODEOWNERS` covers
      `.github/workflows/**`, `.github/actions/**`, itself and `apps/api/scripts/**`
      (owner `@nahuex`, Q72; the repository has no `CODEOWNERS` today). Verify:
      `identity-maintenance-workflow.test.ts` (in `apps/api/src`, 7.3) gains
      cases that fail on `${{ inputs.* }}`, `github.event.*` or `github.head_ref`
      inside any `run:` (a scratch workflow text with each is rejected), on a
      `uses:` pinned by a tag or a branch and on a local `uses: ./`, on a tenant-id
      input with no validation, on an `az` call with `--command`, `--args`,
      `--image` or an `--env-vars` name outside the fixed ones, on a `CODEOWNERS`
      that lacks any of the four paths, and on any other workflow file naming the
      same GitHub `environment`.

## 8. API contract, cross-tenant tests and mount gate

- [ ] 8.1 `identity.organization.delete` is an oRPC procedure of the identity router,
      built with `defineIdentityOperation` (`043`'s task 5.3b) for kind `organization`
      and action `delete`, declaring `.route({ method: 'DELETE', path: '/v1/organization',
      spec: markHighRisk })` with `inputStructure: 'detailed'`, and merged with the other
      procedures into the one router handed to the one `OpenAPIHandler`. Verify:
      `router.int.test.ts` (extended) calls the procedure once on its happy path through
      `createRouterClient` as an admin, `identity-router-structure.test.ts` (`043`'s task
      5.3b) passes with the procedure present (it is branded), and
      `define-identity-operation-order.test.ts` covers a non-admin getting
      `AUTH_FORBIDDEN` before the confirmation is parsed.
- [ ] 8.2 The route carries `x-tayzu-risk: high` and the committed
      `openapi/identity.openapi.json` is regenerated with `DELETE /v1/organization`
      (paths, methods, path parameters and the risk marker only, no schema), so its drift
      check covers it (`043`'s tasks 14.1c and 14.2). Verify: `openapi.test.ts` covers
      "The route is marked high-risk and documented" (the committed document lists it
      with the marker), and `identity-openapi.test.ts` covers `contract:check` failing
      after the route's path or risk spec is changed in a scratch edit and passing on the
      regenerated file.
- [ ] 8.3 The route is registered only behind the mount switch (`043`'s task 14.3): with
      it off it answers exactly as an unknown `/v1` path does, for an unauthenticated and
      for an authenticated caller, and the route table and the procedure list that the
      gate's test enumerates include it. Verify: `mount-gate.int.test.ts` (extended)
      covers "The route does not exist until mounted" for `DELETE /v1/organization`, and
      fails when the procedure is registered outside the switch (a scratch registration).
- [ ] 8.4 Over HTTP the confirmation of `DELETE /v1/organization` is read from the query
      string and compared to the host tenant (`inputStructure: 'detailed'`, design D6);
      a confirmation sent only in a body does not count. Verify:
      `delete-routes.http.int.test.ts` (extended) covers the confirmation in the query
      being honored, a body-only confirmation and a wrong query value each answering
      `CATALOG_VALIDATION_FAILED` with nothing changed.
- [ ] 8.5 `identity.organization.delete` with another tenant's identifier fails and
      `deleteOrganization` is given the host tenant only. Verify: `cross-tenant.int.test.ts`
      (`043`'s group 12, extended) covers "Org deletion targets only the host tenant",
      asserting neither tenant has a marker.
- [ ] 8.6 The HTTP matrices of `043` include the route. Verify:
      `identity-authorization-matrix.http.int.test.ts` (extended) covers
      `organization.delete` by name: the admin with a fresh step-up allowed, a `member` and
      a machine `member` token getting `AUTH_FORBIDDEN` (403) and an unauthenticated call
      getting 401 (the test fails when the procedure is missing from the matrix);
      `step-up.http.int.test.ts` covers "A hijacked admin session without a fresh MFA
      cannot mint power" for the route, nothing being recorded; and
      `cross-tenant.http.int.test.ts` covers a confirmation naming `t2`, called by `t1`'s
      admin, answering the same response as any wrong confirmation (the route has no
      target in its path).
- [ ] 8.7 The route-template matcher of `043`'s task 15.5 covers the path of the route, so
      that nothing about it but its template is exported. Verify:
      `telemetry-paths.http.int.test.ts` (extended) covers the matcher resolving
      `DELETE /v1/organization` to its template and a marker organization identifier sent
      as the confirmation appearing in no exported span, metric or log attribute.

## 9. Telemetry contract enforcement

- [ ] 9.1 Extend `043`'s identity contract module,
      `packages/auth/src/telemetry/identity-contract.ts`, with the names of the
      Observability contract of this change: the spans `identity.organization.delete`,
      `identity.organization.cancel_deletion` and `identity.organization.purge`, the
      counter `tayzu.identity.org_deletions`, the log events
      `catalog.audit.org_deletion_requested`, `catalog.audit.org_deletion_cancelled`,
      `catalog.audit.org_deletion_completed`, `catalog.security.org_deletion_notice_failed`,
      `catalog.security.org_deletion_failed` and `catalog.security.org_deletion_repeated`,
      and the new attribute values (the rejection reason `tenant_pending_deletion`, the
      denial reason `tenant_pending_deletion`, the invitation cancel reason `org_deletion`,
      the email and notice template `org_deletion`, `tayzu.identity.org_deletion.outcome`
      and `tayzu.identity.org_deletion.step`). `otel-smoke-check` already imports the
      module. Verify: `identity-contract.test.ts` snapshot-asserts every added name, and
      `otel-smoke-check.int.test.ts` fails when a declared name is missing from the
      module.
- [ ] 9.2 `otel-smoke-check` runs the request, the repeated request, the reversal and the
      purge once successfully and once per applicable error or denial class, the
      cardinality guard rejects an attribute outside the contract's allowed set, and the
      marker-leak test covers the organization's name. Verify: `pnpm otel-smoke-check` is
      green, removing one declared span in a scratch branch makes it fail, a deliberately
      added `tayzu.identity.org_deletion.name` metric attribute makes it fail, and an
      organization named with a marker string appears in no signal of a request, a
      reversal and a purge.
- [ ] 9.3 Every deletion action emits its declared event, with `tayzu.actor.id` the admin
      who acted (the operator for the cancellation), never the `system` actor. Verify:
      `identity-events.int.test.ts` (`043`'s task 15.6, extended) covers "Each deletion
      action emits its declared event" for the request, the repeated request, the
      reversal, the completed purge and a failed step, the actor id being the admin or the
      operator, and "A failed deletion is logged".

## 10. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 10.1 Write `docs/adr/0019-org-deletion-two-phase-purge.md` (design D1 to D3),
      covering the purge role, the marker's integrity rules and the reversal control
      (`043` reserved the number). Verify: the file exists with Context/Decision/
      Alternatives/Consequences, and design D1 links to it.
- [ ] 10.2 Amend `docs/adr/0014-postgres-roles-and-forced-rls.md` (Resolved decisions Q48,
      Q49 and Q65). It says "Three roles" and records row-level security on the
      `tayzu_auth` tables as "Not applicable" (`002` design D6 says the same), while this
      change adds two roles (`tayzu_purge` and `tayzu_deletion_admin`) and row-level
      security with a permissive `tayzu_auth` policy on the Better Auth tables, and
      migrations `0013` and `0014` carry the grants. The amendment is a dated addendum that
      links ADR-0019. Verify: `pnpm lint` passes and the ADR names the five roles and the
      Better Auth row-level security, with a link to ADR-0019.
- [ ] 10.3 Extend `docs/security/data-retention.md` (which `043` creates for its own
      operational policies) with the retention policy and the erasure statement: the purge
      window; what a purge does not remove by itself (backups, Cerbos decision logs, Azure
      Monitor data, Azure Communication Services records, for which `043`'s file states the ACS data location and retention), and `auth.rate_limit`, whose hashed keys have no tenant, can include a
      keyed hash (the HMAC of `043`'s task 6.7b) of an invited email and are exempt from the
      purge, so they persist; the operator runbook to reverse a pending deletion (the
      maintenance workflow of 7.3 with its environment reviewers as the named second
      approver, just-in-time access through Azure PIM with a personal account for any other
      operator access, the script of 7.1, which refuses a tenant whose purge has begun and
      does not restore the credentials phase 1 revoked, so the admins rotate each one); the
      note that `043`'s `_user` backfill and reconcile are now started through the same
      workflow; and the retention of audit and security logs (at least 12 months,
      independent of tenant deletion, cross-referencing `010`/`015`). Verify: `pnpm lint`
      passes and the runbook is reachable from the file.
- [ ] 10.4 Update `docs/security/attack-surfaces.md`: the route `DELETE /v1/organization`
      with its actor, authentication (a step-up-verified session), Cerbos check and the
      mount gate state. Verify: `pnpm lint` passes and the route has a row.
- [ ] 10.5 Update `docs/architecture/system-diagram.md`: the platform operator's reversal,
      the purge job with its one database connection (`tayzu_purge`), the reversal script
      and the GitHub Actions maintenance workflow that starts it through OIDC, and render
      it again for the SSA (`043`'s task 16.13). Verify: the Mermaid block still renders
      with `npx -y @mermaid-js/mermaid-cli`, every new arrow carries its protocol
      (SEC01), asserted by the test of `043`'s task 16.7 that reads the Mermaid source.
- [ ] 10.6 Update `docs/security/secrets.md`: the `tayzu_purge` secret of the purge job and
      the reversal role's secret, each job with its own identity, with owner and rotation;
      the telemetry environment names every script reads (`OTEL_EXPORTER_OTLP_ENDPOINT` and
      `TAYZU_TELEMETRY_DISABLED`, Resolved decision Q79); the OIDC federation; and the
      GitHub settings checklist of the maintenance workflow that the human applies:
      required reviewers with "prevent self-review" (Resolved decision Q55), deployment
      branches limited to `master`, the OIDC federated credential's subject pinned to the
      environment, the federated identity's Azure role limited to the action that starts
      the named jobs and scoped to those job resources only, with `@nahuex` as the
      `CODEOWNERS` owner (Resolved decisions Q64 and Q72), and branch protection on
      `master` with "Require review from Code Owners", without which `CODEOWNERS` has no
      effect; the checklist also records that the human confirms whether a job start can
      override the job's command, arguments or image and narrows the role if it can.
      Verify: `pnpm lint` passes, each secret names its owner and rotation procedure, and
      the settings checklist lists the five settings.
- [ ] 10.7 Update `docs/catalog/auth-and-rbac.md` (`002` D17): the `organization` kind
      and its action in the taxonomy, and the new spans, metric and log events in the
      telemetry reference (with a pointer to the identity contract module). Verify: `pnpm
      lint` passes and the kind and every event of the Observability contract are listed.
- [ ] 10.8 `pnpm ci:local` is fully green (lint, typecheck, unit and integration tests,
      contract-check, otel-smoke-check, cerbos compile, audit, gitleaks). Verify: attach
      the command output to the PR description.
- [ ] 10.9 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against the
      implemented code, and resolve or explicitly defer every blocking gap (the
      pre-assessment of task 1.1 and the seven passes over `043` are folded in before
      implementation). Verify: the report is attached to the PR with zero open blocking
      gaps.
- [ ] 10.10 Run `/security-review` on the branch and fix or justify every finding.
      Verify: the review output is attached to the PR.
- [ ] 10.11 `openspec validate 045-org-deletion-and-data-retention --strict` passes, and
      design/specs/code agree (update design only if an implementation finding forced a
      change, noted in the PR). Verify: the command output is attached to the PR.
