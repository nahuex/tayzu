# Tasks: 043-identity-lifecycle-and-org-admin

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
   number (for example `feat(auth): 4.2 invite creates invited user`).

A task marked **(Checkpoint 3)** adds or changes a database migration or a
Cerbos policy: stop before it and present the SQL or the policy, with its
`cerbos compile` output, for the human's separate approval (root `CLAUDE.md`).

Tasks follow the Resolved decisions Q1-Q69 in `design.md`. Its two Open
Questions are pending the human, and the tasks use their recommended option until
they are answered.

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

- [ ] 1.1 _(setup)_ The drift-check against the merged `002` was run on
      2026-10-01 and its mechanical fixes are in `design.md` (Context); the third, fourth and fifth drift-checks and VCDM passes of the same day are folded in too. At
      implementation time this task is a last drift-check of the files the design
      names (`user-sync.ts`, `identity-router.ts`, `context-resolver.ts`,
      `token-exchange.ts`, `server.ts`, `policies/`) and adjusts import paths and
      attribute names only if drift is found, with no scope change. Verify: a short
      note in the PR description states what, if anything, was adjusted.
- [ ] 1.2 _(setup)_ The `vcdm-ssa-validator` pre-assessment in Mode A against
      the merged `002` was run on 2026-10-01 and its eleven blocking gaps (B1-B11)
      are folded into `design.md`, the spec and these tasks, together with the five
      gaps (NB1-NB5) of the second pass, resolved by Q24-Q27, and the two gaps and
      four questions of the third pass, resolved by Q38-Q45, and the fourteen non-blocking gaps (G1-G14) of the fourth
      pass, resolved by Q48-Q57, tasks and tickets, and the three blocking gaps (NB-1 to NB-3), the eight non-blocking gaps (G-a to G-h) and the four questions (Q-A to Q-D) of the fifth pass, resolved by Q62-Q69, tasks and tickets. Attach the reports to the PR. Verify: the report is attached to the PR with zero open blocking gaps
      or an explicit deferral recorded.
- [ ] 1.3 _(setup)_ Add `@azure/communication-email` (`1.1.0`) to
      `packages/auth/package.json`, and add the Communication Services connection
      string as a Key Vault secret reference, following `002`'s existing pattern
      for the database credential. Check its license, its install scripts (keep
      them blocked unless `allowBuilds` in `pnpm-workspace.yaml` must allow one) and
      its transitive dependencies. Verify: `pnpm install` succeeds, and
      `docs/security/dependencies.md` lists the new package with the license, the
      `allowBuilds` decision and the SBOM review, and with the source and license of the bundled common-password denylist of 8.1 (it is data, not a dependency, so its provenance has to be on record).
- [ ] 1.4 _(setup)_ Scaffold the homes of the identity code (Resolved decision
      Q30): `packages/auth/src/identity/` for the pure parts and the structural ports
      (empty modules for `user-status.ts`, `invitation-token.ts`, `password-policy.ts`,
      `email/sender.ts`, `ports.ts`), `apps/api/src/identity/` for the
      orchestration and the routers (empty modules for `invitations.ts`,
      `service-accounts.ts`, `credentials.ts`, `org-deletion.ts`), and
      `apps/api/scripts/` for the `tsx` scripts (`backfill-user-blueprint.ts`,
      `reconcile-users.ts`, `purge-job.ts`, `cancel-org-deletion.ts`, and
      `bootstrap-admin.ts`, which is its future home: the CLI moves there in 4.6b)
      with the package scripts `identity:backfill-user-blueprint`,
      `identity:reconcile-users`, `identity:purge` and
      `identity:cancel-org-deletion`. Vitest includes only `src/**`
      (`vitest.shared.ts`) and `apps/api/tsconfig.json` includes only `src`, so a
      script has no test beside it: its tests live in `apps/api/src/` and import
      `../scripts/<name>.js` (the precedent is `packages/auth/src/bootstrap.int.test.ts`),
      and a trivial `scripts-smoke.test.ts` in `apps/api/src/` imports each script
      module. The `tsconfig.json` of `apps/api` and ESLint also cover
      `apps/api/scripts`. `@tayzu/auth` gains no `@orpc/server` or `@tayzu/catalog`
      dependency. Verify: `pnpm --filter @tayzu/auth test` and
      `pnpm --filter @tayzu/api test` run their smoke tests green, and `pnpm lint`
      and `pnpm typecheck` cover `apps/api/scripts`.

## 2. `_user` blueprint extension (no migration)

- [ ] 2.1 `USER_BLUEPRINT` carries the optional `accountKind` (`"standard"` |
      `"service"`, default `"standard"`, applied on write only) and a four-value
      `status` enum (`Staged`, `Invited`, `Active`, `Disabled`, default `Staged`) for
      every new tenant. Verify: `user-blueprint.int.test.ts` covers that a new
      tenant's `_user` blueprint has both, and "New entity without a status starts
      staged".
- [ ] 2.2 A one-off, idempotent `tsx` script
      (`apps/api/scripts/backfill-user-blueprint.ts`) runs `blueprints.update` as the
      `system` actor once per existing tenant to bring `_user` forward. It lists the
      tenants from `auth.organization` through the `tayzu_auth` pool, because
      row-level security blocks enumerating tenants through `tayzu_app`, and writes
      each tenant through `tayzu_app`. In production it runs only through the
      maintenance workflow of 12.14b (Resolved decision Q41). Verify:
      `backfill-user-blueprint.int.test.ts` (in `apps/api/src/identity/`, importing
      `../../scripts/backfill-user-blueprint.js`) seeds two tenants with the old schema, asserts the
      script finds both without enumerating through `tayzu_app`, and covers "adding
      accountKind and widening status is a compatible change": the update succeeds,
      existing `_user` entities stay valid and are not rewritten, and a second run
      changes nothing.
- [ ] 2.2b A repeatable `_user` reconcile script
      (`apps/api/scripts/reconcile-users.ts`, `pnpm --filter @tayzu/api
identity:reconcile-users`; Resolved decision Q50) creates the `_user` entity
      of every existing member that has none, through the Q30 adapter and
      `created_active` with the input `afterAddMember` builds, and leaves an
      existing row untouched. For a member whose Better Auth user is `banned` it
      follows `created_active` with `admin_disable`, so the row is `Disabled` and a
      banned user is never revived as `Active` (Resolved decision Q62;
      `afterAddMember` writes `Disabled` for a banned member today). It lists
      organizations and members through the `tayzu_auth` pool and writes through
      `tayzu_app`, as its own Container Apps Job (Resolved decision Q49). Its change
      events carry the operator id as `onBehalfOf`, taken from the environment the
      maintenance workflow sets (12.14b; `gh:<numeric actor id>`, actor type `user`,
      Open Question 1, recommended option), and the script refuses to run without it.
      It emits the span `identity.user.reconcile` and the audit event
      `catalog.audit.users_reconciled` per tenant (declared in 16.1). In production
      it runs only through the maintenance workflow, before the release that carries
      the `user_missing` rejection (11.8) serves traffic in an environment that has
      members and before the mount switch is turned on (design D15, Migration Plan).
      It is also the repair path for a member rejected with `user_missing` (11.8),
      including one whose `_user` write was lost after an acceptance committed (8.2).
      Verify: `reconcile-users.int.test.ts` (in `apps/api/src/identity/`, importing
      the script) covers "The reconcile repairs a member and is repeatable": two
      tenants seeded with a member that has no `_user` row (as after a lost write)
      and a member that has an `Active` one, the first run creating the missing row
      as `Active` with `onBehalfOf` the operator and leaving the other untouched, the
      second run changing nothing, the repaired member being accepted by
      `resolveContext`, and the script refusing to run with no operator id; and "The
      reconcile does not revive a banned user": a banned member with no row ends
      `Disabled`, not `Active`, with both writes attributed to the operator.
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

- [ ] 4.1 The status writers take a `StatusEvent`. There are **two** sync types and
      both change (Resolved decision Q10, design D2). In `@tayzu/auth`, `UserSyncPort`
      and its input (`auth.ts`) replace the two-value `status` (`'Active' |
'Disabled'`) with a `StatusEvent` and accept an optional `onBehalfOf`. In
      `@tayzu/catalog`, `UserSyncInput` in `packages/catalog/src/service/user-sync.ts`
      (today a two-value `status`, a fixed actor and no `onBehalfOf`) gains the
      four-value status of D1 and the optional `onBehalfOf`. `createUserSync` lives in
      `@tayzu/catalog`, which cannot import `@tayzu/auth`, so the Q30 adapter in
      `apps/api/src/identity/user-sync-adapter.ts` implements `UserSyncPort`: it reads
      the current status, calls `nextStatus` and writes the resulting status, never a
      raw one. Verify: `user-sync.int.test.ts` (in `apps/api`) covers a write for each
      allowed event, a rejected `Active` → `Staged` write, and a write with
      `onBehalfOf` carrying the admin on the change event, and the existing test of
      `createUserSync` in `@tayzu/catalog` is extended for the four-value status and
      `onBehalfOf`.
- [ ] 4.1b `createApp` builds the adapter of 4.1 and passes it to `createAuth` as
      `userSync` (today it passes none, so every status hook is a no-op in the running
      app). Verify: `user-sync-wiring.int.test.ts` boots `createApp` and covers a
      membership added through Better Auth writing the `_user` entity through the
      state machine.
- [ ] 4.1c `refreshDisplayData` (`auth.ts`) upserts a member's display fields
      without a status. With the new default `Staged` it would create a `Staged` row
      for a member who has none and so bypass the `user_missing` rejection of 11.8,
      so it updates the display fields of a row that exists and never creates one or
      writes a status. Verify: `display-data.int.test.ts` covers a member with no
      `_user` row still having none after a profile refresh, and a member with a row
      having only its display fields updated, the status unchanged.
- [ ] 4.2 `afterAddMember` is the **single writer** for a membership and derives
      the event from the current status (Resolved decision Q11, design D2): none gives
      `created_active`, `Invited` or `Staged` gives `invitation_accepted`, `Active` is
      no write and `Disabled` is no write, so adding a membership never revives a
      `Disabled` user and never throws on a second write. For a member whose Better
      Auth user is `banned` and who has no row, the hook writes `created_active` and
      then `admin_disable`, keeping the `Disabled` it writes for a banned member today
      (Resolved decision Q62). Verify:
      `auth-hooks.int.test.ts` covers "A disabled user is not revived by a hook" and
      one case per current status (none, `Invited`, `Staged`, `Active`, `Disabled`), asserting the event written or the absence of a write, and a banned member with no row ending `Disabled`.
- [ ] 4.3 `identity.users.create` performs **no** `_user` write of its own: the hook
      of 4.2 writes it (today the operation writes twice, through the hook and through
      an explicit upsert, and the second write would throw because `created_active` is
      allowed only from none), and the operation hands the acting admin to the hook
      through a per-call value, so the change event carries `onBehalfOf`. Verify:
      `identity-router.int.test.ts` covers "A user created by an admin is active" with
      exactly one `_user` write, status `Active`, and the change event carrying the
      admin as `onBehalfOf`.
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
- [ ] 4.6 `bootstrapAdmin()` moves out of the script file into
      `packages/auth/src/bootstrap-admin.ts` and the package index (design D2): today it
      shares `packages/auth/scripts/bootstrap-admin.ts` with the CLI `main()`, and
      `bootstrap.int.test.ts`, `user-sync.int.test.ts`, `scripts/ci/zap-seed.ts` and
      `zap-seed.test.ts` import it from there, so those imports are updated. It does
      **not** write the admin's `_user` itself: the membership hook is the single
      writer (design D2), because `createOrganization` fires `afterAddMember` for the
      owner whenever `userSync` is passed to `createAuth`, and a second write would
      throw (`created_active` is allowed only from none). It emits
      `catalog.audit.user_created` with source `bootstrap` (declared in 14.3) and
      applies the password policy of 8.1 and the forced change of 14.5. Verify:
      `bootstrap.int.test.ts` (in `packages/auth/src/`, the existing test) covers that
      `bootstrapAdmin()`, run against an `auth` built with a recording `UserSyncPort`,
      yields exactly one `created_active` write for the admin and no second write, and
      emits the audit event with source `bootstrap`, and `user-sync.int.test.ts` keeps
      passing with the new import.
- [ ] 4.6b The bootstrap CLI (`main()` and the `bootstrap:admin` package script,
      today in `packages/auth/scripts/bootstrap-admin.ts`) moves to
      `apps/api/scripts/bootstrap-admin.ts` (Resolved decision Q51), because
      `@tayzu/auth` depends only on `@tayzu/db` and `@tayzu/observability` and cannot
      import the adapter of 4.1. Today `main()` builds Better Auth on one
      `DATABASE_URL` pool with no `AUTH_DATABASE_URL` and no Cerbos, while the adapter
      needs a `tayzu_app` pool and Cerbos: the CLI builds Better Auth the way `createApp`
      does (the `tayzu_auth` pool, the `tayzu_app` pool and Cerbos) and passes the
      adapter as `userSync`, so the hook writes the `_user` (4.6; `002` left this as a
      follow-up). The `bootstrap:admin` package script moves to `apps/api/package.json`,
      `packages/auth` no longer contains the script or its package script, and
      `scripts/ci/zap-seed.ts` and its test follow the new location, the seed using a
      password that satisfies the policy of 8.1 (the generator of 14.5b) and honoring
      the forced change of 14.5. The seed's child process gets the breached-password
      stub through `NODE_OPTIONS=--import` in the CI step (8.1a; Open Question 2,
      recommended option). Verify: `bootstrap-admin.int.test.ts` (in `apps/api/src/`,
      importing `../scripts/bootstrap-admin.js`) runs `main()` and covers that the
      bootstrap `_user` exists, is `Active` through the state machine and was written
      once, and that `packages/auth` contains neither the script nor its package script;
      `zap-seed.test.ts` covers the seed using the moved CLI and a policy-compliant
      password.

## 5. Cerbos foundations, ⛔ Checkpoint 3

- [ ] 5.1 `RESOURCE_KINDS` gains `service_account`, `credential` and
      `organization`, and the Cerbos attributes are built from a resolved target
      (`assertMayOnUser` in `apps/api/src/identity-router.ts` is today `'create' |
'update'` with empty attributes, and is replaced by the wrapper of 5.3b):
      `accountKind`, `portRole`, `moderatedBlueprints` and the target's **real
      tenant** (an invitation's `organizationId`, an API key's `referenceId`, the
      user's membership), never `ctx.tenantId` echoed back. The Cerbos resource id is
      the Better Auth user id for a human (the opaque `_user` id for a service
      account), never the email. Verify: `identity-attributes.test.ts` covers that the
      attributes carry the target's tenant and the three attributes and that the
      resource id is the opaque id for an email-addressed target, that a `service_account` resource carries the resolved `accountKind` (and `service` for a create), and
      `resource-kinds.test.ts` that the kinds exist.
- [ ] 5.1b `apps/api/src/identity/auth-repository.ts` (Resolved decision Q69;
      design D14) is the only module through which the identity code reads `apikey`,
      `invitation` and `member`, and every function **requires a `tenantId`** and
      filters by it (`referenceId` for `apikey`, `organizationId` for `invitation` and
      `member`), because the `auth` schema has no row-level security and the tenant
      filter would otherwise be repeated by hand in at least eight readers. It offers a
      paged key listing that reaches the end (9.2), a key lookup by id, an invitation
      lookup by id, a member listing and a membership lookup, returns plain read shapes
      and never selects the hashed `key` column. Verify: `auth-repository.int.test.ts`
      covers each function returning only the rows of the tenant it is given, with a
      second tenant's rows seeded to match on every other field, a missing or empty
      `tenantId` throwing, and a `@ts-expect-error` case showing that a call without a
      `tenantId` does not type-check.
- [ ] 5.1c A lint rule bans direct adapter access to the `apikey`, `invitation` and
      `member` models from `apps/api/src/identity/**` outside `auth-repository.ts`
      (Resolved decision Q69): a `no-restricted-syntax` selector on adapter calls whose
      model is one of the three, and a restriction on importing the adapter factory
      there, added to `eslint.config.js`. Verify: `auth-repository-lint.test.ts` (in
      `apps/api/src/identity/`) lints scratch sources with ESLint's `Linter` and the
      repository's configuration and covers a direct `apikey` read in `credentials.ts`
      failing, the same read inside `auth-repository.ts` passing and a read of another
      model passing, and `pnpm lint` stays green on the real tree.
- [ ] 5.2 Every target of an `identity.*` operation is resolved on the server by
      one helper (which reads `apikey`, `invitation` and `member` only through the repository of 5.1b), and a target of another tenant answers `CATALOG_NOT_FOUND`,
      identical to a nonexistent id; `tenantId` and `actor` are never read from
      input. Verify: `identity-target.int.test.ts` covers a foreign and an unknown
      invitation, credential and user answering the same, and a body with a
      `tenantId` field being rejected.
- [ ] 5.3 The identity router emits `catalog.security.authz_denied` and
      increments `tayzu.authz.decisions` on every Cerbos deny (it threw silently
      before), through a helper exported by `@tayzu/catalog`, which already owns both
      (`pipeline.ts`, `telemetry/instruments.ts`) and which `apps/api` depends on, so
      no duplicate instrument appears under the `@tayzu/auth` scope. Verify:
      `identity-router.int.test.ts` covers that a denied call logs the event and
      increments the metric once, with no email or identifier of the target.
- [ ] 5.3b `defineIdentityOperation({ authorization: { kind, action,
resolveTarget }, handler })` in `apps/api/src/identity/define-operation.ts`
      (Resolved decisions Q45 and Q57) is the only way to build an identity
      procedure: it brands what it returns, resolves the target with the helper of
      5.2, builds the attributes of 5.1, calls Cerbos with the target's real tenant and
      emits the event of 5.3 on a deny, and only then runs the handler. The unwrapped
      base builder is not exported from its module. The three existing procedures
      (`create`, `linkSsoAccount`, `unlinkSsoAccount`) move to it, keeping their
      `userId` input until 5.3c, and `assertMayOnUser` is removed. Verify:
      `define-identity-operation.test.ts` covers a denial never running the handler
      and the attributes carrying the target's tenant, and
      `identity-router-structure.test.ts` fails when a procedure of the identity
      router is not branded, including one built by chaining and one built from an
      unwrapped builder (a text scan for a bare `.handler(` is bypassable, so the test
      checks the brand or a registry).
- [ ] 5.3b2 The wrapper checks the **caller's role in the caller's own tenant
      first**, with no target (Resolved decision Q57; `002`'s `assertMayOnUser` did),
      then resolves the target, then re-checks with the target's real tenant. Verify:
      `define-identity-operation-order.test.ts` covers "An unauthorized caller cannot
      tell a target from a missing one": a caller without the grant gets the same
      `AUTH_FORBIDDEN` for a same-tenant target and for an unknown one, with the
      target resolver never called, and an authorized caller still gets
      `CATALOG_NOT_FOUND` for the unknown one.
- [ ] 5.3b3 The wrapper fails closed (Resolved decision Q57): a Cerbos error, a
      malformed context and an empty role list each deny and never run the handler.
      Verify: `define-identity-operation-failclosed.test.ts` covers "The wrapper
      fails closed" for each of the three, with a Cerbos client that throws, a context
      with no tenant or no actor, and a principal with an empty role list, asserting
      the denial and that the handler was never called.
- [ ] 5.3c The three existing procedures take the `{user}` identifier (Resolved
      decision Q31), resolved on the server to the Better Auth user, instead of a
      Better Auth `userId`, and the five existing integration test files that build
      `createIdentityRouter` with a `userId` body (`account-linking`,
      `admin-user-creation`, `link-social-step-up`, `otel-smoke-check` and `user-sync`,
      all `*.int.test.ts`) are migrated to address the target by its identifier.
      Verify: those five files, updated, pass against the new input, and
      `identity-router.int.test.ts` covers an unknown identifier and a `userId` body
      each being rejected.
- [ ] 5.3d One shared input parser for the identity router
      (`apps/api/src/identity/parse-input.ts`; design D10, the root untrusted-input
      rule) replaces today's `parseInput`, which ignores unknown fields: a
      null-prototype object, `__proto__`, `constructor` and `prototype` rejected at
      every depth, undeclared fields rejected, and length limits checked before any
      lookup. Verify: `parse-input.test.ts` covers each rejection at depth 1 and at
      depth 3, an undeclared field, an over-length value being refused before any
      lookup spy is called, and a clean body being parsed.
- [ ] 5.4 (Checkpoint 3) Cerbos policy: `user.invite` (which also covers cancel
      and resend) and `user.updateStatus` on resource kind `user`, importing
      `002`'s `same_tenant` derived role. `user.yaml` already allows `*` to admin,
      so the new content is an `EFFECT_DENY` for `updateStatus` when `R.id == P.id`
      (`R.id` being the opaque user id, design D3). Verify: `cerbos compile` runs `policies/resource_policies/user_test.yaml` covering both actions ×
      admin/non-admin × self/non-self × same/other tenant. ⛔ **Stop for
      Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 5.5 (Checkpoint 3) Cerbos policy: an `EFFECT_DENY` rule on `user.yaml` for
      any action when `R.attr.accountKind == "service"` and (`R.attr.portRole !=
"member"` or `R.attr.moderatedBlueprints` is non-empty), using the resulting
      values, with every attribute reference guarded by `has()` because
      `strictEvaluation: true` turns a CEL error into a deny of the whole action
      (design D3, Resolved decisions Q7 and Q16). Verify: `cerbos compile` runs
      `policies/resource_policies/user_test.yaml`'s cases for a call with **none** of the attributes (today's
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
      `policies/resource_policies/role_policies_test.yaml` (the shared `testdata/` principals and resources gain the three new kinds) showing an admin is allowed and a member is denied
      on each new kind and action. ⛔ **Stop for Checkpoint 3 approval of the policy
      diff before continuing.**

## 6. Invitation email and caps

- [ ] 6.1 `EmailSender` port (one `send(to, template)` over a closed union of three
      fixed templates, `InvitationEmail`, `OrgDeletionNotice` and
      `AdminAcceptedNotice`; no CC, BCC or attachment field) with a recording fake,
      and a recipient validator: a single plain address, no CR/LF, no display name, no
      list separator, at most 254 characters. Verify: `email-sender.test.ts` covers
      "Injection through the invited address is impossible" for each rejected shape,
      and that the fake records `to`, link and expiry text.
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
      address or message text leaves it, ACS user-engagement and click tracking
      disabled (a tracked link would be rewritten and would leak the fragment token)
      and no Reply-To. Verify: `azure-email-sender.test.ts` covers construction and
      config parsing (no network call), the payload sent to a stubbed client having
      tracking disabled and no Reply-To, and "The email provider's failure never
      leaks" with a stubbed client whose error contains the recipient; a documented
      manual smoke-check script exists for a real sandbox account outside CI.
- [ ] 6.5 In production startup fails without a real `EmailSender` (the ACS
      connection string is read from the environment only, for a dedicated send-only
      resource, Resolved decision Q28). Outside production a real sender is allowed
      only with a mandatory recipient-domain allowlist
      (`EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, Resolved decision Q67): startup fails when a
      real provider is configured outside production without it. CI, DAST and demo
      tenants wire a non-sending `EmailSender`. Verify: `config.test.ts` (in
      `apps/api`) covers production without a provider throwing, a real provider
      outside production without the allowlist throwing and with it starting, the test
      configuration selecting the recording fake and the DAST configuration selecting
      the non-sending sender.
- [ ] 6.5b A wrapper around the real sender refuses a recipient whose domain is not on
      the allowlist of 6.5 (Resolved decision Q67): the refusal is sanitized, is
      handled exactly like a provider failure and logs
      `catalog.security.email_recipient_blocked` (declared in 16.1) with the template
      and no address. Verify: `email-allowlist.test.ts` covers a recipient on the list
      reaching the stubbed provider, one off the list never reaching it (the domain
      compared after the canonicalization of 7.10), the sanitized refusal and the
      logged event carrying no address.
- [ ] 6.6 A per-tenant cap of 30 invitation emails per hour, shared by invite and
      resend, on a store interface (in memory in tests), with its default in
      `apps/api/src/config.ts` following its `limitWithDefaults` pattern. Exceeding it
      fails with `AUTH_RATE_LIMITED` (the `AuthRateLimitedError` of 6.8b), sends
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
- [ ] 6.8b Every limiter of this change answers with a `Retry-After` header, as
      `002` requires (design D4). `ORPCError` carries no header and `errors.ts` has no
      `AuthRateLimitedError`, so `@tayzu/auth` gains that class with
      `retryAfterSeconds`, the three caps throw it, and the error mapping of `apps/api` turns it into a 429 `AUTH_RATE_LIMITED`
      carrying the header through oRPC's `ResponseHeadersPlugin` (it ships in
      `@orpc/server`, so no new dependency; `ORPCError` carries no headers and
      `server.ts` registers no such plugin today). Verify:
      `error-mapping.test.ts` covers the class mapping to status 429, code
      `AUTH_RATE_LIMITED` and a `Retry-After` equal to its `retryAfterSeconds` (the
      HTTP twin is in 15.5).
- [ ] 6.8c Every `AUTH_RATE_LIMITED` of the invitation caps (tenant, recipient and
      global) carries the **same** `Retry-After` (the shortest window, one hour), so
      the header does not reveal which bucket tripped (VCDM G2; Q61).
      Verify: `invitation-caps.test.ts` covers "Every cap answers with the same
      Retry-After": the tenant, recipient and kill-switch rejections carry an equal
      `retryAfterSeconds`.
- [ ] 6.9 A disabled or zero cap fails startup (`002` Q39). Verify:
      `config.test.ts` covers a zero or disabled value for each cap, the notice cap of 6.13
      included, throwing at startup.
- [ ] 6.10 The production store for the caps and the accept route's limiter is
      `002`'s DB-backed atomic store (`auth.rate_limit`, hashed keys, no migration).
      `consumeRateLimitBucket` is not exported today and is tied to the Better Auth
      plugin's rule table (`pre-auth-rate-limit.ts`), so `@tayzu/auth` exports a
      scope-generic helper with rules for the new scopes, and the closed
      `RateLimitScope` union gains `invitation_accept`, `invitation_tenant`,
      `invitation_recipient` and `notice_tenant`. Neither executable telemetry
      contract enumerates the values, but `002`'s design and `pre-auth-rate-limit.ts`
      declare the scope a closed three-value enum, so this amends it and 17.14
      records the amendment. Verify:
      `invitation-rate-limit-store.int.test.ts` covers two store instances over the
      same database sharing one count per scope, a key being stored only as a hash,
      and the new scopes being accepted by the helper while an unknown scope is
      refused.
- [ ] 6.10b The cap windows have the semantics of `002`'s store, which is accepted
      and documented (Resolved decision Q66): a bucket resets only after a full window
      with **no allowed request**, because every allowed hit moves `lastRequest` and the
      table has no window-start column, so the caps are stricter than their nominal rate
      and no migration is added. Verify: `invitation-rate-limit-store.int.test.ts` covers
      "A slow trickle never resets a bucket": with a clock seam, requests spaced just
      under the window keep accumulating to the cap of 3 per 24 hours, the next one is
      refused, and a gap of a full window resets the bucket.
- [ ] 6.11 The `OrgDeletionNotice` template (Resolved decision Q27) has a fixed
      subject and body, interpolates only the purge date, contains no link and no
      tenant or actor free text. Verify: `org-deletion-notice-template.test.ts` covers
      "The deletion notice carries no free text" (an organization named
      `<b>Pay now</b>` and a markup-bearing actor name never appear) by parsing the
      rendered HTML and text.
- [ ] 6.12 The `AdminAcceptedNotice` template (Resolved decision Q39) has a fixed
      subject and body with no interpolated value, no link and no tenant, actor or
      invitee free text. Verify: `admin-accepted-notice-template.test.ts` covers "The
      admin notice carries no free text" (an organization named `<b>Pay now</b>` and a
      markup-bearing invitee name never appear, and the rendered HTML and text contain
      no link) by parsing both.

- [ ] 6.13 A notice dispatcher (`apps/api/src/identity/notices.ts`; Resolved
      decision Q53) is the only way the `OrgDeletionNotice` and the
      `AdminAcceptedNotice` are sent. It applies the global kill switch, the
      per-recipient bucket of 6.7 (keyed by the sha256 of the canonical email) and a
      per-tenant notice cap (scope `notice_tenant`, emails per hour, default 60 in
      `apps/api/src/config.ts` per Q58), sends to at most 20
      recipients (the administrators who have been members the longest, `Disabled` ones
      included so that a rogue admin cannot silence the notice by disabling the others,
      the invitee excluded) and never throws into its caller: a suppressed or truncated notice
      logs `catalog.security.notice_suppressed` (declared in 16.1) with the template,
      the reason and the number dropped. Verify: `notices.test.ts` covers "The
      notices are under the kill switch and the caps" (the kill switch on, the notice
      cap exhausted and a full per-recipient bucket each suppressing exactly the
      affected emails with the right reason and no address in the event), "A notice
      goes to at most 20 recipients" (25 admins, 20 emails to the longest-standing
      ones, a `truncated` event) the dispatcher never throwing, and a `Disabled` admin being among the recipients; `config.test.ts`
      covers a zero notice cap failing startup.

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
- [ ] 7.3 `identity.users.invite` (in `apps/api`) calls
      `auth.api.createInvitation` in process **with the admin's session headers**
      (Resolved decision Q42): `/organization/invite-member` requires a real session
      and has no `userId` bypass, so the server puts the request headers in the router
      context (like `__stepUpHeaders` today) and the re-invite cancel, the
      100-invitation limit and `afterCreateInvitation` stay Better Auth's. It stores
      the token digest in `auth.verification` (identifier
      `invitation-accept:<invitationId>`, same expiry), creates or updates the `_user`
      entity to `Invited` through `created_invited` as `system` with `onBehalfOf` the
      admin, and sends exactly one email. Verify: `invitations.int.test.ts` mints a
      real session and covers "Invite sends exactly one email with exactly one link"
      and "Explicit invite starts a user as invited" using the recording fake, and a
      call whose context carries no valid session headers failing closed with nothing
      created.
- [ ] 7.4 The invited role is exactly the string `member` or `admin`, never
      `owner`, and is logged on `catalog.audit.invitation_created`. Better Auth's
      `inviteMember` accepts comma-separated strings and arrays and the Cerbos role
      mapper splits them, so the validation is an exact match. Verify:
      `invitations.int.test.ts` covers "Inviting with the owner role is rejected" for
      `owner`, `member,owner`, `['owner']`, `Admin` and an arbitrary value, each with
      nothing created, and "An admin invitation is logged with its role".
- [ ] 7.5 Re-inviting an email that has a `pending` invitation cancels the
      previous invitation (reason `re_invite`) and creates a fresh one. Verify:
      `invitations.int.test.ts` covers "Re-inviting cancels the previous
      invitation".
- [ ] 7.6 `identity.users.cancelInvitation`, Cerbos-gated to admins through
      `user.invite`, resolving the invitation on the server and cancelling through
      Better Auth's `cancelInvitation` with the same forwarded session headers (it is
      session-bound too). Verify: `invitations.int.test.ts` covers "Admin can cancel a
      pending invitation".
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
      function in `apps/api/src/identity/email-canonical.ts` (`@tayzu/auth` has no use
      for it and cannot import `@tayzu/catalog`; `@tayzu/catalog` exports its private
      `ENTITY_IDENTIFIER_PATTERN` unchanged, Q60), used for the `_user` identifier, the Better Auth email, the invitation
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
      `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` and the default
      `invitationLimit` of 100 pending invitations per organization (a FORBIDDEN
      `INVITATION_LIMIT_REACHED`) map to `CATALOG_VALIDATION_FAILED` with no provider
      text. Verify: `invitations.int.test.ts` covers inviting an existing member and
      exceeding 100 pending invitations, asserting the generic code and no membership
      information in the response.

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
- [ ] 8.1a _(setup)_ A shared stub for the breached-password range query, as a
      `setupFiles` entry of the `int` project in `vitest.shared.ts` (a new
      `vitest.int.stub.ts` beside it). The root `vitest.int.setup.ts` is a
      `globalSetup`, which runs once in the main process and cannot patch `fetch` inside
      a test worker, so it is not the home. The `haveIBeenPwned` plugin also covers
      `/admin/create-user`, and 31 existing test files reach it through `createAuth(` or
      `createUser`, so without a stub each would call `api.pwnedpasswords.com` or fail
      closed. The stub answers the range query for that host with an empty range and
      passes every other request through; a test that needs a breached or an unreachable
      answer installs its own over it (8.1b). A child process never inherits it (the
      bootstrap that `scripts/ci/zap-seed.ts` spawns, and any test that spawns one), so
      the stub module can also be loaded with `NODE_OPTIONS=--import` for those.
      Verify: `pnpm --filter @tayzu/auth test` and `pnpm --filter @tayzu/api test` pass,
      a spy shows no request to `api.pwnedpasswords.com` leaving a test worker, and a
      child process started with the `--import` option shows none either.
- [ ] 8.1b Breached-password check (design Q23): Better Auth's built-in
      `haveIBeenPwned` plugin is enabled for every path the policy covers, with a
      sanitized refusal and fail-closed behavior. The plugin checks only the endpoint
      paths in its list (it covers `/admin/create-user`) and silently skips a hash
      call outside one, so acceptance, temporary-password and bootstrap creation go
      through a covered endpoint such as `auth.api.createUser`, or call the check
      explicitly through the password module. Verify: `password-breach.int.test.ts`
      installs its own stub of the global `fetch` over the shared one of 8.1a (the plugin
      hardcodes `api.pwnedpasswords.com`) and
      covers a password whose SHA-1 suffix is in the stubbed range being refused **on
      acceptance, on a temporary password and on bootstrap**, a clean one accepted,
      only the 5-character prefix ever being sent, and an unreachable service
      refusing the password (the plugin's fail-closed 500 `APIError`) with the generic
      retryable error at the boundary.
- [ ] 8.1c Better Auth's own password configuration enforces the policy on its
      routes: `minPasswordLength` 20 and `maxPasswordLength` 128, the policy hook on
      `/change-password`, and `002`'s test fixtures that used the old 8-character
      default are updated. Admin `createUser` enforces only the maximum length, so the
      minimum there comes from Tayzu's password policy module, applied by
      `identity.users.create`. Verify: `password-policy.int.test.ts` covers
      `/change-password` refusing a 19-character and a denylisted password and
      accepting a compliant one, `identity.users.create` refusing a 19-character
      password, and `pnpm --filter @tayzu/auth test` still passing with the updated
      fixtures.
- [ ] 8.1d The password is NFC-normalized in **two layers**. (1) Inside the hash and
      verify functions (Better Auth's `emailAndPassword.password.hash` and `.verify`,
      wrapping its own scrypt functions; `auth.ts` has no override today), so that every
      verifying path is covered without a list (a password hashed in NFC fails to sign in
      when typed in another normalization form): sign-in, `/verify-password`,
      `/two-factor/enable`, `/change-password` (its `currentPassword`),
      `/two-factor/generate-backup-codes` and any path added later. (2) A `hooks.before`
      in `auth.ts` NFC-normalizes the password-bearing body fields (`password`,
      `newPassword`, `currentPassword`) of every `/api/auth/*` request **before Better
      Auth's plugins run**: the `haveIBeenPwned` plugin wraps `ctx.password.hash` as the
      outer layer and sees the raw string, so a breached password typed in NFD would
      pass the check and be stored as the NFC hash. The hook selects by field name, not
      by a path list. `PASSWORD_CHECK_PATHS` in `pre-auth-rate-limit.ts` is the rate
      limiter's coverage list (it includes `/link-social` on purpose, `002` Q52 and
      omits `/sign-in/email`, which has its own rule), so it is **not** exported,
      reused or changed here. Verify: `password-nfc.int.test.ts` covers a password set
      through acceptance signing in, passing `/verify-password`, enabling a second
      factor, changing it with `/change-password` and generating backup codes when
      presented in its NFD form, a breached password presented in its NFD form being
      refused (the stubbed range is keyed on the NFC form, so this fails unless the hook
      runs before the plugin), an endpoint outside any list verifying in NFD too (the
      normalization is in the function), and the hook leaving a body without those
      fields untouched.
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
- [ ] 8.4 The tenant is derived from the invitation record, and the body is an
      allowlist of exactly the invitation id, the token and, for a new account, the
      password: a body that carries a tenant, an actor, `role`, `email`,
      `organizationId` or `userId` is rejected with `CATALOG_VALIDATION_FAILED`
      (null-prototype parse, `__proto__`, `constructor` and `prototype` rejected at
      every depth). The invitation id is checked for shape and length before any lookup
      or logging, and one that fails the check is logged as a constant, never as the
      value. Verify: `invitation-accept.int.test.ts` covers "The tenant comes from the
      invitation", each extra field being rejected with nothing created, and an
      over-long or malformed id never appearing in a log record.
- [ ] 8.5 For an email that already has an account and a request **without** a
      session, acceptance never sets or changes a password and answers the uniform
      rejection (Resolved decisions Q18 and Q24). Verify:
      `invitation-accept.int.test.ts` covers "Acceptance does not touch an existing
      account", including a `password` in the body being ignored.
- [ ] 8.5b For an existing account with a session of that same account and the
      valid token, acceptance adds only the membership with the invited role,
      activates the `_user` through `invitation_accepted` and sets `emailVerified`
      (Resolved decision Q38: the token proves the mailbox); it never touches the
      password, the session, the active organization or any linked account, and its
      success has the same status and body shape as the new-account path. Verify:
      `invitation-accept.int.test.ts` covers "An existing account accepts with its
      session", including `emailVerified` being true afterward.
- [ ] 8.5c The session user's email must equal the invitation email, with **no**
      verified-email condition (Resolved decision Q38: `email_verified` is false for
      every account, so the condition would fail for all of them), and the session is
      read only on this path. Verify: `invitation-accept.int.test.ts` covers "A session
      of another account cannot accept" (a different user's session) answering the
      uniform rejection with `denial_reason` `email_mismatch` or `session_required`, and
      an existing account whose email was never verified accepting successfully.
- [ ] 8.5d When the invited role is `admin`, an existing-account acceptance
      additionally requires a fresh step-up, checked with the guard of
      `packages/auth/src/step-up.ts` only after the session, the email and the token
      have all passed, so it answers `AUTH_STEP_UP_REQUIRED` to nobody without a valid
      token. The guard alone only rejects, so for a session that carries an `ssoSid`
      the service function also calls `reauthorization.lookup` and
      `reauthorization.start` the way the OpenAPI interceptor does (`server.ts`),
      and an SSO-established admin can complete it. Verify:
      `invitation-accept.int.test.ts` covers an `admin` invitation with and without a
      fresh marker, an SSO session being sent to the re-authorization and completing
      after it, and a wrong token with no marker answering the uniform rejection, not
      `AUTH_STEP_UP_REQUIRED`.
- [ ] 8.5e The session read by the accept route is subject to the idle-timeout and
      banned checks that `resolveContext` applies (the route reads `getSession`
      directly and bypasses `resolveContext`). Verify: `invitation-accept.int.test.ts`
      covers a banned user's session and an idle-expired session each answering the
      uniform rejection (`denial_reason` `session_required`) with nothing created.
- [ ] 8.5f At acceptance, on both paths, after the token has verified and before it
      is consumed, the invitation's inviter must still be a member of the invitation's
      organization with the `admin` Cerbos role (a membership role of `owner` or
      `admin`), whose Better Auth user is not `banned` and whose `_user` status in the
      tenant is `Active`; otherwise the acceptance answers the uniform rejection with the
      denial reason `inviter_not_active_admin` and the token is not consumed (Resolved
      decision Q63; design D4 step 2). The reads go through the repository of 5.1b.
      Verify: `invitation-accept.int.test.ts` covers "An invitation does not outlive its
      inviter's authority": an invitation accepted on each path after its inviter was
      disabled, banned, demoted to `member` or had the membership removed by a direct
      write, each answering the uniform rejection with `denial_reason`
      `inviter_not_active_admin` and the token still valid afterwards; an `admin`
      inviter and an `owner` inviter still being accepted; and a wrong token with a
      disabled inviter answering the same uniform rejection.
- [ ] 8.6 Acceptance never links an account by an email claim. Verify:
      `invitation-accept.int.test.ts` covers "Acceptance does not link an SSO
      account by email" (no `account` row for the SSO provider exists afterward).
- [ ] 8.7 Every rejected acceptance (nonexistent, expired, cancelled, rejected,
      already accepted, wrong token, `Disabled` user, an inviter who is no longer an active admin, no or
      mismatched session for an existing account) returns the same status, error
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
- [ ] 8.13 The public accept route has its own limiter, a Fastify `preHandler`
      that consumes a bucket of the DB-backed store through the helper of 6.10 (scope
      `invitation_accept`, hashed key), so it is shared across replicas; it is not the
      in-memory `createRateLimit` of the other routes. It answers `AUTH_RATE_LIMITED`
      with `Retry-After` (6.8b), with its default in `apps/api/src/config.ts`. Verify:
      `accept-rate-limit.test.ts` covers "The accept route is rate-limited" on the
      preHandler alone with an in-memory store, asserting the limit fires before any
      invitation lookup (the route is not mounted here), and
      `invitation-rate-limit-store.int.test.ts` (6.10) the shared count.
- [ ] 8.14 Two invitations of two tenants for the same new email accepted
      concurrently create exactly one user. Verify: `invitation-accept.int.test.ts`
      covers "A concurrent account creation for the same email yields one user": the
      loser answers the uniform rejection (`denial_reason` `account_conflict`), its
      `auth` rows roll back and its token is not consumed.
- [ ] 8.15 When an invitation whose role is `admin` is accepted, on either path,
      the fixed `AdminAcceptedNotice` (6.12) is sent through the dispatcher of 6.13 to the
      other administrators of the organization (`Disabled` ones included, at most 20), one email per recipient,
      resolved on the server (Resolved decisions Q39 and Q53); a send failure never
      blocks the acceptance and logs `catalog.security.admin_notice_failed`, and a
      suppression logs `catalog.security.notice_suppressed`. Verify:
      `invitation-accept-notice.int.test.ts` covers "An accepted admin invitation
      notifies the other admins" with the recording fake (an owner, two admins other
      than the invitee and a `Disabled` admin each receive exactly one email, a plain member and the invitee
      none, a `member` invitation sends none) and a failing sender not stopping the
      acceptance.

## 9. Org API credentials: viewer, create, rotate and revoke

- [ ] 9.1 (Checkpoint 3) Cerbos policy: `credential.list`, `create`, `rotate` and
      `revoke` on resource kind `credential`, importing `002`'s `same_tenant`
      derived role and carrying the explicit cross-tenant `EFFECT_DENY` of `002` D8,
      `admin`-only. Verify: `cerbos compile` runs `policies/resource_policies/credential_test.yaml` (with its resources in the shared `testdata/resources.yaml`) covering
      each action × admin/non-admin × same/other tenant, including the explicit
      cross-tenant deny. ⛔ **Stop for Checkpoint 3 approval of the policy diff before
      continuing.**
- [ ] 9.1b The `organization` plugin defines all three roles (`owner`, `admin`,
      `member`) with their default statements, because custom roles replace the
      defaults and `organization()` has no `ac` or `roles` today, and adds `apiKey`
      create, read, update and delete to `admin` only. `createMachineCredential` and
      `revokeMachineCredential` are called headerless with `body.userId` the acting
      admin's Better Auth user id (not the `_user` id of `metadata.userId`), so Better
      Auth's owner-only check no longer runs and Cerbos is the real gate (Resolved
      decision Q29). Verify: `org-api-key-access.int.test.ts` covers a Better Auth
      `admin` member who is not the owner creating and revoking an org key through the
      identity operation, an `owner` doing the same (custom roles replace the
      defaults, so the owner's `apiKey` permissions are asserted too), the three roles still holding every default permission (an
      `admin` can still create and cancel an invitation, a `member` cannot manage keys),
      the key's `body.userId` being the admin's id, and that the helper no longer
      forwards session headers. The five existing integration tests that call the
      helpers with session headers (`bootstrap-wiring`, `otel-smoke-check`,
      `machine-credentials`, `token-exchange` and `context-resolver`, all
      `*.int.test.ts`) are migrated to the headerless call with `body.userId`, and pass.
- [ ] 9.2 `identity.credentials.list`: projects org-owned API keys to
      `{ name, kind, prefix, createdAt, lastRequest, enabled, rotationDueAt, createdBy }`, `createdBy` being the opaque id of the creating admin that the key's metadata records (absent for a key created without it), with
      `kind` one of `service_account`, `integration` and `agent`. `listApiKeys` is
      session-bound and has no server-side `userId`, so the read is an adapter-level
      query, through the repository of 5.1b, of the `apikey` table filtered by `referenceId = ctx.tenantId` and the
      `machine-credential` `configId`, with a bounded page (`apikey.metadata` is a `text` column, so the `metadata.userId`
      and `actorKind` filters are an application-side filter over pages, or a JSON cast
      the test proves, and every reader that must see **all** of a tenant's keys, 9.5b,
      9.11, 10.7 and the caps, uses a paged lookup that reaches the end and never this
      limit); it joins `metadata.userId`
      to the `_user` entity for service-account keys and never selects the hashed
      `key` column into the response shape. Verify: `credentials.int.test.ts` covers
      "Listing never includes the secret", "Non-admin cannot list credentials", the limit applying, `createdBy` being the creating admin's opaque id, the adapter's
      `metadata` shape (a JSON string or an object, which the raw adapter returns is
      not known from the code) being pinned by an assertion while the reader accepts
      both, and the paged lookup finding a key beyond the limit (a tenant seeded with
      more keys than the limit).
- [ ] 9.3 A credential is shown disabled when its key is disabled, it is
      revoked, or its bound service account is `Disabled`. Verify:
      `credentials.int.test.ts` covers each of the three cases.
- [ ] 9.4 `rotationDueAt` is computed from the credential's `metadata.rotatedAt`
      plus the configured interval (default 90 days). Verify: `credentials.test.ts`
      (pure) covers a credential rotated 91 days ago flagged due and one rotated
      yesterday not.
- [ ] 9.5 `identity.credentials.create` (integration and agent credentials): the
      per-key rate limit of **60 verifications per hour**, configurable in
      `apps/api/src/config.ts` with `limitWithDefaults` (a disabled or zero value fails
      startup; Resolved decision Q44), and the no-stored-secret-characters setting are
      plugin-level configuration of the `machine-credential` apiKey config (`rateLimit`,
      `startingCharactersConfig`), because `createApiKey` rejects per-key `rateLimit*`
      properties when given `headers` or a request; the call is headerless (9.1b). No
      hard expiry is applied (Resolved decision Q20), and the metadata is
      `{ actorKind, role: 'member', userId?, createdBy }`, `createdBy` being the acting admin's opaque id (design D6, D7). The limit's `timeWindow` is in
      milliseconds and is copied into each key at creation, so a later configuration
      change applies to new keys only. The key `name` is 1 to 32 characters of
      `[A-Za-z0-9 _.-]` (the plugin allows 32 and service-account identifiers run to
      63, so a service account's key gets a fixed label, 10.3). Verify: `credentials.int.test.ts`
      covers "Creating a credential requires step-up and bounds its use" at the
      service level (the key's metadata records `createdBy`): the created key has the configured limit (60 per hour by default,
      and a configured value is honored) and stores no secret characters, a changed limit
      applying only to keys created afterwards, a 33-character name refused, and
      `config.test.ts` a zero or disabled limit failing startup (the step-up part is
      asserted over HTTP in 15.4).
- [ ] 9.5b The optional `userId` of `identity.credentials.create` is resolved
      server-side within the caller's tenant to a service-account `_user`; a human, an
      unknown id or another tenant's service account answers `CATALOG_NOT_FOUND`, and a
      service account that already has an active credential is refused with
      `CATALOG_VALIDATION_FAILED` (Resolved decision Q40: exactly one active
      credential per service account). Verify: `credentials.int.test.ts` covers
      "A credential cannot be bound to a user outside the tenant or to a human" and "A
      service account holds one active credential": a second create for a service
      account with an active credential is refused, and one for a service account whose
      credential was revoked succeeds.
- [ ] 9.5c Creation of a credential bound to a service account takes the **same
      per-service-account advisory lock as rotation** (9.6b), so the check-then-insert
      of Q40 cannot be raced by two concurrent creates (the partial unique index of the
      same invariant is a ticket). Verify: `credentials.int.test.ts` covers
      "Concurrent credential creation for one service account yields one": two
      concurrent creates bound to one service account with no active credential,
      exactly one succeeding, the other refused with `CATALOG_VALIDATION_FAILED`, and
      exactly one active credential afterward.
- [ ] 9.5d A tenant holds at most 200 non-revoked credentials (Resolved decision
      Q56), configurable in `apps/api/src/config.ts` with `limitWithDefaults` (a
      disabled or zero value fails startup). `identity.credentials.create` and the
      key issued by `identity.serviceAccounts.create` count them through the paged
      lookup and refuse the creation beyond the cap with
      `CATALOG_VALIDATION_FAILED`, under a per-tenant advisory lock so concurrent
      creates cannot overshoot. Verify: `credentials.int.test.ts` covers "The
      credential cap and the name limit hold" (200 seeded keys, the 201st refused, two
      concurrent creates at 199 yielding one success, a revoked key not counting) and
      `config.test.ts` a zero or disabled cap failing startup.
- [ ] 9.6 `identity.credentials.rotate`: creates the new credential, revokes the
      old one through `revokeMachineCredential` (the revocation list), and returns
      the new secret once. Verify: `credentials.int.test.ts` covers "Rotating
      replaces the usable credential", asserting the old credential's already-issued
      token and any new exchange are rejected within the cache window.
- [ ] 9.6b Rotation is serialized per service account (per credential for an
      unbound integration or agent credential), for example by an advisory lock held
      for the whole rotation, and a revoked credential may be rotated only when its
      service account has no active credential (Resolved decision Q40). Verify:
      `credentials.int.test.ts` covers "Concurrent rotation leaves exactly one active
      credential" (two concurrent rotations of one credential: exactly one succeeds,
      the other fails with `CATALOG_VALIDATION_FAILED`, and exactly one credential is
      usable afterward) and rotating a revoked credential being refused while another
      is active.
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
      identity operation maps it. The key is read through an adapter-level lookup (the repository of 5.1b)
      filtered by `referenceId` and `configId` and paged to the end, never limited like
      the viewer (the `getApiKey` call with headers in
      `machine-credentials.ts` is session-bound and is replaced by it). Verify:
      `credentials.int.test.ts` covers rotate and revoke of another tenant's
      credential and of an unknown id returning the same `CATALOG_NOT_FOUND`, and the
      lookup being filtered by `referenceId`.

## 10. Service accounts

- [ ] 10.1 Service-account identifier pattern `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`,
      validated at creation. Verify: `service-accounts.test.ts` covers acceptance
      of `svc-ci-github` and rejection of `ci-github` (missing prefix) and an
      over-length identifier.
- [ ] 10.2 (Checkpoint 3) Cerbos policy: `service_account.create` and `delete`
      on resource kind `service_account`, importing `002`'s `same_tenant` derived
      role and carrying the explicit cross-tenant `EFFECT_DENY` of `002` D8,
      `admin`-only, plus an `EFFECT_DENY` for every action unless
      `R.attr.accountKind == "service"`, guarded by `has()` (Resolved decision Q62: an
      absent `accountKind` is `standard` and denies; for `create` the attribute is the
      `service` of the account being created). Verify: `cerbos compile` runs
      `policies/resource_policies/service_account_test.yaml` (with its resources in the
      shared `testdata/resources.yaml`) covering each action × admin/non-admin ×
      same/other tenant, including the explicit cross-tenant deny, and a `standard` or
      absent `accountKind` denied for every action while `service` is allowed for an
      admin. ⛔ **Stop for
      Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 10.3 `identity.serviceAccounts.create` (in `apps/api`): writes the `_user` entity
      (`status: Active`, `accountKind: "service"`, role `member`, empty
      `moderatedBlueprints`) as `system` with `onBehalfOf` the admin, and issues an
      organization-owned key by reusing `002`'s `machine-credential` apiKey config,
      headerless with `body.userId` the acting admin's id (metadata `{ actorKind:
'integration', role: 'member', userId, createdBy }`, `userId` being the entity's opaque id and
      `createdBy` the acting admin's),
      returning `clientId`/`clientSecret` once. The key's `name` is a fixed label,
      because the plugin limits it to 32 characters and the identifier can run to 63;
      the viewer shows the identifier through the `_user` join (9.2). Verify: `service-accounts.int.test.ts`
      covers "Service account is active immediately, no email", asserting the
      `EmailSender` fake recorded zero calls, that the key's metadata records the creating
      admin as `createdBy` and that a later read never includes the secret.
- [ ] 10.3b If issuing the key fails after the `_user` was written, the `_user`
      entity is removed again (compensation) and the failure is logged, so no service
      account without a credential is left behind. Verify: `service-accounts.int.test.ts`
      covers "A failed credential issue leaves no orphan service account" with a
      failure seam on the key creation: the operation fails, no `_user` of that
      identifier remains and no key exists.
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
- [ ] 10.7 `identity.serviceAccounts.delete`: revokes **every** non-revoked
      `apikey` with `referenceId = ctx.tenantId` and `metadata.userId` equal to the
      service account's `_user` id through the revocation list (found by the paged adapter-level lookup of 9.11, never limited like the viewer, not only "the" credential), after the target has been resolved by the service-account resolver of 10.7b, then removes the
      `_user` entity as `system` with `onBehalfOf` the admin (Resolved decision Q40).
      Verify: `service-accounts.int.test.ts` covers "Deleting a service account
      revokes its credential", asserting the credential cannot be restored, and
      "Deleting a service account revokes every bound credential": a service account
      with two non-revoked credentials (seeded directly, as before the one-credential
      rule) is deleted and both are rejected within the 5-second cache window.
- [ ] 10.7b Every `service_account` route (`serviceAccounts.delete` and the
      service-account branch of `setStatus` of 11.5) resolves its target through one
      server-side resolver that answers `CATALOG_NOT_FOUND`, identical to an unknown id,
      unless the resolved `_user` has `accountKind == "service"` **and** an `svc-`
      identifier (Resolved decision Q62; design D6, D14), including for the caller's own
      `_user` and an owner's, and that passes the resolved `accountKind` to Cerbos
      (10.2). Without it `DELETE /v1/service-accounts/alice@x.com` would remove a human's
      `_user` row as `system`: the human would be locked out with `user_missing`, no
      `Disabled` state or `user_status_changed` event would exist and the reconcile would
      later recreate the row as `Active`. Reads go through the repository of 5.1b.
      Verify: `service-accounts.int.test.ts` covers "A service-account route refuses a
      human target": a delete of another human, of the admin's own address and of an
      owner each answering the same `CATALOG_NOT_FOUND` as an unknown id, with the
      human's `_user` row and status intact, no credential revoked and no event emitted,
      and a standard `_user` with an `svc-`-shaped identifier (seeded directly) refused
      too.

- [ ] 10.8 A tenant holds at most 50 service accounts (Resolved decision Q56),
      configurable in `apps/api/src/config.ts` with `limitWithDefaults` (a disabled or
      zero value fails startup). `identity.serviceAccounts.create` counts the tenant's
      `_user` entities with `accountKind: "service"` and refuses the creation beyond
      the cap with `CATALOG_VALIDATION_FAILED`, under a per-tenant advisory lock.
      Verify: `service-accounts.int.test.ts` covers "The per-tenant service-account cap
      holds" (50 seeded, the 51st refused with nothing created, two concurrent creates
      at 49 yielding one success) and `config.test.ts` a zero or disabled cap failing
      startup.

## 11. Disable takes effect immediately, ⛔ Checkpoint 3 (migration `0011`)

- [ ] 11.0 _(setup)_ Every existing human-session `/v1` integration test needs a
      `_user` row for its member, because 11.8 makes the resolver reject a member with
      none. No fixture writes one today: `admin-user.ts` and the fixtures under
      `apps/api/src/__fixtures__/` create Better Auth users and memberships only, and of
      the 23 test files that call `createAuth(` only two pass `userSync`. The shared
      fixtures write the member's `_user` row with status `Active` through the adapter of
      4.1 (or `createUserSync` where a package cannot depend on it), and every test file
      that builds its members by hand migrates to them. Verify: `pnpm --filter
      @tayzu/auth test`, `pnpm --filter @tayzu/api test` and `pnpm --filter
      @tayzu/catalog test` stay green with the rejection of 11.8 applied in a scratch
      branch (a member without a row fails, a member with one passes).
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
- [ ] 11.4b Disabling a user also cancels the pending invitations that user
      **created** in that tenant (reason `inviter_disabled`, Resolved decision Q63;
      design D13), and enabling restores none. The acceptance check of 8.5f stays the
      authoritative control; this makes the revocation visible. Verify:
      `user-status-op.int.test.ts` covers "Disabling cancels the invitations the user
      created": an admin who created two pending invitations is disabled, both become
      `cancelled` with reason `inviter_disabled`, an invitation created by another admin
      stays pending, an invitation created by the same user in another tenant stays
      pending, and re-enabling restores none.
- [ ] 11.5 `identity.users.setStatus` for a service account (its `svc-…`
      identifier) writes only `_user.status` (it has no Better Auth user). The branch is chosen by the
      resolved `accountKind` of the target (10.7b), never by the shape of the identifier
      alone. Verify:
      `user-status-op.int.test.ts` covers disable and enable of a service account
      changing only the `_user` entity, and a human target never taking the service-account
      branch.
- [ ] 11.6 `resolveContext`'s machine branch rejects a principal whose token
      carries a `userId` claim when the bound `_user` is **absent or not `Active`**
      (`Disabled`, or removed by a delete or a tamper; Resolved decision Q40), through
      the 5-second cache, failing closed on any lookup failure, and logs
      `catalog.security.principal_rejected` (reason `service_account_disabled` or
      `service_account_missing`) and increments `tayzu.identity.principal_rejections`.
      A token without the claim is unaffected. The check is selected by the credential branch (a bearer machine token), never by comparing `actor.type`, which lint bans outside three files (design D13). Verify: `context-resolver.int.test.ts`
      covers "Disabling a service account takes effect within seconds" for an
      already-issued token, "A token for a deleted service account is rejected" (a
      credential that survives the delete still does not resolve), and a lookup
      failure rejecting.
- [ ] 11.7 Token exchange refuses to mint a token for a service account whose
      `_user` is `Disabled`, absent or otherwise not `Active`, and re-enabling
      restores the same credential. Verify: `token-exchange.int.test.ts` covers the
      refusal for a `Disabled` and for a deleted service account, and "Re-enabling
      restores access without a new credential".
- [ ] 11.8 `resolveContext` rejects a **human** whose `_user.status` in the active
      tenant is `Disabled` (Resolved decision Q25). This is new code: `resolveContext`'s
      `_user` read (`readUserEntityGrants`) has no cache and does not select `status`,
      and on a lookup failure it returns a principal-less context instead of rejecting.
      The task adds the status read, a 5-second cache keyed by `(tenantId, userId)` and
      a rejection on failure (fail closed), logging `catalog.security.principal_rejected`
      and incrementing `tayzu.identity.principal_rejections`. A member with no `_user`
      row in the active tenant is rejected with the reason `user_missing`, logged and
      counted (Resolved decisions Q46 and Q50; 2.2b repairs it). The check is selected by the credential branch (a session cookie), never by comparing `actor.type`, which lint bans outside three files (design D13). Verify: `context-resolver.int.test.ts` covers "A disabled member is
      rejected in their tenant only": the same user accepted in `t2`, a second request
      within 5 seconds not repeating the lookup, a lookup failure rejecting, and a
      member with no `_user` row in the active tenant rejected with `user_missing`
      (Q46, Q50).

## 12. Org deletion, two phases, ⛔ Checkpoint 3 (migrations `0012` and `0013`)

- [ ] 12.0 _(setup)_ Extend the test harness and the configuration for the new
      roles. `packages/db/src/harness.ts` sets up only `tayzu_migrator` and `tayzu_app`
      today, so tests that run as `tayzu_purge`, `tayzu_deletion_admin` or `tayzu_auth`
      need login roles, pools and membership grants of their own; the `config.ts` of
      `apps/api` has no environment name for the purge and reversal connections, so it
      gains `PURGE_DATABASE_URL` and `REVERSAL_DATABASE_URL` (read only by the two
      scripts, never printed, `sslmode=verify-full` outside test like `DATABASE_URL`).
      The by-name lists of public tables in the harness (`harness.ts`,
      `harness-ownership.int.test.ts`) and the exact table list asserted by
      `schema.int.test.ts` gain `tenant_deletion_marker` in 12.1, when the table
      exists. Verify: `pnpm --filter @tayzu/db test` and `pnpm --filter @tayzu/api test`
      stay green, and `config.test.ts` covers the two new variables being read and a
      missing one failing only the script that needs it.
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
      `requested_at` having no effect, a second pending marker for one tenant
      refused, and the harness table lists and `schema.int.test.ts` updated for the new
      table (12.0). ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 12.1b (Checkpoint 3) Migration `0013_tenant_deletion_grants` (hand-written,
      like `0009`), catalog side (Resolved decision Q48): creates the `tayzu_purge`
      role (own pool and secret, used only by the purge job; guarded and with no
      password, like `0006`) and the `tayzu_deletion_admin` role (Q35, only able to
      tombstone a pending marker: update `state` and the cancellation timestamp, under
      a policy that also requires that no purge step is recorded and `purge_after >
      now()`); grants `tayzu_app` `INSERT` and `SELECT` on the marker under a
      tenant-isolation policy and **no** `UPDATE` or `DELETE`; `FORCE ROW LEVEL
      SECURITY`; gives `tayzu_purge` a `SELECT` policy on the marker limited to due
      pending markers (the listing of due tenants, with no function), `UPDATE` of the
      progress columns and of `state` to `purged`, and `SELECT` **and** `DELETE` on the
      tenant's tables, **named one by one**: `catalog_blueprint`,
      `catalog_relation_definition`, `catalog_entity`, `catalog_entity_relation`,
      `catalog_change_event`, `catalog_tenant_sequence` and
      `machine_credential_revocation` (which has no `catalog_` prefix), each under its
      own `SELECT` and `DELETE` policies limited to tenants with a due pending marker (a
      `DELETE ... WHERE tenant_id` needs the `SELECT` privilege and a `SELECT` policy as
      well as the `DELETE` ones, and the `entities_removed` count needs reads); and
      amends the append-only trigger of `0001` to allow `DELETE` only when
      `current_user` is `tayzu_purge`. It creates **no function** and transfers no
      ownership. It carries `migrations/down/0013.down.sql`, `meta/0013_snapshot.json`
      and its `_journal.json` entry (the Better Auth side is 12.1c, the second statement
      block of the same migration; each is presented separately). Verify:
      `tenant-deletion-grants.int.test.ts` covers that `tayzu_app` can insert its own
      tenant's marker but cannot update, delete or read another tenant's and cannot
      back-date one; that `tayzu_purge` sees only due pending markers (the listing) and
      cannot read or delete the rows of a tenant without a due marker; that a due
      tenant's change events and revocation rows are read, counted and deleted by
      `tayzu_purge`; that a direct `DELETE` by `tayzu_app`, by the table owner and by
      `tayzu_purge` outside a due tenant is still refused by the trigger or the policy,
      on each of the seven tables; that no role can `SET ROLE tayzu_purge` (no
      `pg_auth_members` row grants it to `tayzu_app`, `tayzu_auth`, `tayzu_migrator` or
      `tayzu_deletion_admin`) and that `tayzu_purge` owns no object; that
      `tayzu_deletion_admin` can tombstone a pending marker with no purge step and a
      future date and cannot once a step is recorded or the date has passed, and cannot
      read or delete tenant data; and that the migration creates no `SECURITY DEFINER`
      function. ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 12.1c (Checkpoint 3) Migration `0013`, Better Auth side (Resolved decisions Q49,
      Q59 and Q65): row-level security on the Better Auth tables that purge step 2
      deletes from, **named one by one**, with a permissive policy `TO tayzu_auth`
      (`USING (true) WITH CHECK (true)`, so Better Auth's behavior is unchanged: the
      due-tenant restriction applies to the purge role, not to `tayzu_auth`) and
      due-marker policies for `tayzu_purge`: `DELETE` (and the `SELECT` it needs) on an
      organization-keyed row only when its organization has a due pending marker, on a
      user-keyed row only for a user whose memberships are all in due tenants and who has
      at least one, and a **read-only `SELECT` policy over every `auth.member` row**, so
      that the predicate can see a user's memberships in tenants that are not due while
      the `DELETE` on `member` stays limited to due tenants. `tayzu_purge` gets nothing
      else on the `auth` schema. The exact predicates are presented at Checkpoint 3.
      Verify: `tenant-deletion-auth-grants.int.test.ts` covers that `tayzu_purge` deletes
      the Better Auth rows of a due tenant and of a user whose memberships are all in due
      tenants; can read but not delete a `member` row of a tenant that is not due; cannot
      delete the rows of a tenant that is not due, of a user who also belongs to a tenant
      that is not due (the predicate sees the other membership), or of a user with no
      membership; cannot touch any other `auth` table; and that `tayzu_auth` keeps full
      access to every tenant's rows, so `pnpm --filter @tayzu/auth test` stays green.
      ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 12.2 (Checkpoint 3) Cerbos policy: `organization.delete` on resource kind
      `organization`, importing `002`'s `same_tenant` derived role and carrying the
      explicit cross-tenant `EFFECT_DENY` of `002` D8, `admin`-only (any admin may
      request it, Resolved decision Q27). Verify: `cerbos compile` runs
      `policies/resource_policies/organization_test.yaml` (with its resources in the
      shared `testdata/resources.yaml`) covering admin/non-admin × same/other tenant, including
      the explicit cross-tenant deny. ⛔ **Stop for Checkpoint 3 approval of the policy
      diff before continuing.**
- [ ] 12.3 `identity.organization.delete` requires the caller to send the
      organization's identifier, which must equal the host `ctx.tenantId`; over HTTP it
      travels in the query string (`DELETE` routes use `inputStructure: 'detailed'`,
      design D10). Verify: `org-deletion.int.test.ts` covers "Org deletion targets only
      the host tenant" and a missing or wrong confirmation returning
      `CATALOG_VALIDATION_FAILED`, asserting nothing changes.
- [ ] 12.4 Phase 1 records the marker (as `tayzu_app`, insert-only) with a
      `purge_after` inside the configured window (7 to 14 days, validated at startup,
      default 14), revokes every session whose active organization is the tenant,
      revokes every org-owned credential through the revocation list, cancels pending
      invitations, and logs `catalog.audit.org_deletion_requested` with the admin as
      `tayzu.actor.id`. Verify: `org-deletion.int.test.ts` covers the data-still-present
      and marker parts of "Requesting deletion revokes access at once", and a window
      outside 7 to 14 failing startup.
- [ ] 12.5 Requesting deletion again while pending inserts no second marker, sends no
      second notice and returns the original date, but **re-runs the idempotent
      revocations** of phase 1 (sessions, credentials, invitations), so that a first
      request that failed half-way is completed and a later reversal cannot leave a
      session or credential alive (design D9). Verify: `org-deletion.int.test.ts` covers
      "Requesting deletion twice returns the original date" (one marker, the original
      date, no second notice), in process, and "A repeated request completes a
      half-failed first one": a first request that failed after the marker was recorded
      (a failure seam on the credential revocation) leaves a live credential, and the
      repeat revokes it.
- [ ] 12.5b A repeated deletion request is logged as
      `catalog.security.org_deletion_repeated` (declared in 16.1) with the tenant and the
      admin as actor. Verify: `org-deletion.int.test.ts` covers the event on the second
      request and not on the first, with no email or free text in it.
- [ ] 12.6 `resolveContext` and token exchange reject every principal, human or
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
- [ ] 12.7 Purge step 1 (`tayzu_purge`): ordered deletes of the tenant's
      relations, entities, blueprints and other `catalog_*` rows that respect the
      `RESTRICT` foreign keys, and the append-only rows, which the amended trigger and the policies admit for
      `tayzu_purge` and a due tenant (12.1b),
      recording progress on the marker. Verify: `org-purge-catalog.int.test.ts` covers
      "Purge removes tenant data after the window" for the catalog side on a tenant
      seeded with relations, entities, blueprints and change events.
- [ ] 12.8 Purge step 2 (`tayzu_purge`, under the policies of 12.1c): each user with
      no other membership together with their `account`, `session` and `twoFactor` rows
      and the `auth.verification` rows keyed by that user (`temp-password:<userId>`),
      deleted while their membership still exists so that the policy can evaluate it, each
      user in **one transaction that re-checks the user's memberships** (the read-only
      `member` visibility of 12.1c), so a membership added in between is seen;
      the `step-up-verified:<sessionToken>` markers, which are keyed by the **session
      token** and not by the user (`packages/auth/src/step-up.ts`), so the step
      collects the tokens of those sessions first and deletes the markers before the
      sessions; then the tenant's invitations, API keys (`referenceId`), invitation
      tokens in `auth.verification` and members, and the organization row last. Verify:
      `org-purge-auth.int.test.ts` covers "Users with no other membership are removed,
      others are kept", including their verification rows, a `step-up-verified:` marker
      of one of their sessions being gone, and a user with a second membership keeping
      theirs, including a membership added between the check and the delete (a seam)
      keeping the user.
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
- [ ] 12.12 The purge job entry point, `apps/api/scripts/purge-job.ts`
      (`pnpm --filter @tayzu/api identity:purge`): a `tsx` script run by a scheduled job
      (its own Container Apps Job, Resolved decision Q49), with no HTTP listener, that
      connects **only** as `tayzu_purge` (`PURGE_DATABASE_URL`, 12.0), lists the due
      tenants through the marker policy and runs one pass. It refuses to start under
      another role with a **new** check, `current_user = 'tayzu_purge'`, because the
      existing `assertRuntimeRole` in `bootstrap.ts` is private and checks only
      superuser, `BYPASSRLS` and table ownership, so `tayzu_app` would pass it. Verify:
      `purge-job.int.test.ts` (in `apps/api/src/`, importing `../scripts/purge-job.js`,
      1.4) runs the script once against a due tenant, asserts it is purged, asserts the
      process opened no listener and no connection other than `tayzu_purge`, and
      asserts it refuses to start as `tayzu_app` (which passes `assertRuntimeRole`) and
      as `tayzu_auth`.
- [ ] 12.13 Phase 1 sends the fixed `OrgDeletionNotice` through the dispatcher of
      6.13 to the administrators of the organization (at most 20), one email per
      recipient, resolved on the server from the tenant's memberships; a send failure
      never blocks the request and logs `catalog.security.org_deletion_notice_failed`,
      and a suppression logs `catalog.security.notice_suppressed` (Resolved decisions
      Q27 and Q53). Verify:
      `org-deletion-notice.int.test.ts` covers "Every admin is notified of a pending
      deletion" with the recording fake (an owner and two admins each receive exactly
      one email, a plain member none) a failing sender and a suppressed notice not stopping the request.
- [ ] 12.14 The reversal script (`apps/api/scripts/cancel-org-deletion.ts`,
      `pnpm --filter @tayzu/api identity:cancel-org-deletion`, with the role of Q35)
      tombstones a pending marker (`state = 'cancelled'`, a timestamp; the row is never
      deleted) and refuses a tenant with no pending marker, a tenant whose purge has begun (a step
      timestamp is recorded) and a tenant whose purge date has passed (the reversal
      role's policy of 12.1b enforces the same). The operator's opaque id
      comes from the environment the maintenance workflow of 12.14b sets from its
      authenticated actor, never from an argument, and the script refuses to run
      without it (Resolved decision Q41). Verify: `cancel-org-deletion.int.test.ts`
      (in `apps/api/src/`, importing `../scripts/cancel-org-deletion.js`, 1.4) covers
      "A reversal is refused once the purge has begun" (a recorded step and a passed
      date, the marker unchanged) and "A platform operator reverses a pending deletion": the tenant's
      principals are accepted again, the row is still present as a tombstone, the
      script's role cannot delete or read tenant data, and the script refuses to run
      with no operator id.
- [ ] 12.14b The maintenance workflow, `.github/workflows/identity-maintenance.yml`
      (Resolved decision Q41): the only way the reversal script, the `_user` blueprint backfill (2.2) and the
      reconcile (2.2b) reach production, one Container Apps Job per script chosen by a
      `choice` input. It is `workflow_dispatch` only, runs only from `master` (a job condition on the ref; the environment's deployment
      branches are limited to `master` by the human-owned settings of Resolved decision
      Q55, 17.8), declares a GitHub `environment` whose required reviewers enforce the
      named second approver, uses
      OIDC (`id-token: write`, no stored cloud secret) to start an Azure Container Apps
      Job, and passes `gh:` plus the numeric actor id (`github.actor_id`, never the login, which
      can be a bot name such as `x[bot]` that the catalog id pattern rejects) to the job
      through `env` as the operator id (Open Question 1, recommended option). Verify: `identity-maintenance-workflow.test.ts` (in `apps/api/src`, like
      `zap-seed.test.ts`, because `.github` is outside every package) reads the file as
      text and fails unless the only trigger is `workflow_dispatch`, a condition restricts the job
      to `refs/heads/master`, an `environment` is declared, `id-token: write` is the only elevated permission, no `secrets.` value
      other than the environment's is referenced, and the operator id is `gh:` plus `github.actor_id`, passed through `env`.
- [ ] 12.14c The workflow's inputs and supply chain are hardened (Resolved decision
      Q64; design D9): every input is a `choice` (the job) or validated against the
      catalog's tenant-id regular expression (the tenant id, checked in a first step that
      fails the run) and reaches the job only through `env` or the job's
      environment-variable arguments; every `uses:` is pinned by a 40-character commit
      SHA; and `.github/CODEOWNERS` covers `.github/workflows/identity-maintenance.yml`
      and `apps/api/scripts/**` (the owner handle is the one the human supplies with the
      Q55 checklist, because the repository has no `CODEOWNERS` today). Verify:
      `identity-maintenance-workflow.test.ts` (in `apps/api/src`, 12.14b) gains cases that
      fail on `${{ inputs.* }}`, `github.event.*` or `github.head_ref` inside any `run:`
      (a scratch workflow text with each is rejected), on a `uses:` pinned by a tag or a
      branch, on a tenant-id input with no validation, and on a `CODEOWNERS` that lacks
      either path.
- [ ] 12.15 The reversal emits `catalog.audit.org_deletion_cancelled` with the
      operator's opaque id (the authenticated workflow actor, not a self-asserted
      value) and increments `tayzu.identity.org_deletions` with outcome `cancelled`,
      and a later deletion request after a reversal inserts a new marker. Verify:
      `cancel-org-deletion.int.test.ts` covers the event and its attributes with no
      email, the metric, and "Requesting deletion again after a reversal creates a new
      marker".
- [ ] 12.16 A completeness test driven by the schema's columns and the
      identifier patterns, not by foreign keys alone: every table that has a
      `tenant_id` column (catalog), every `auth` table that references an organization
      or a user by foreign key **or by column** (`apikey.reference_id` has no foreign
      key) and the `auth.verification` rows by identifier pattern (`invitation-accept:`,
      `temp-password:`, `step-up-verified:`, which are keyed by string) is deleted by a
      purge step or explicitly exempted with a reason, so a later change that adds a
      table or a pattern cannot escape the purge. Verify: `purge-coverage.int.test.ts`
      enumerates the tables from the database catalog, fails for a table added in a
      scratch migration that no step covers and for an unlisted identifier pattern,
      and passes on the real schema. The test's table also classifies every identifier family and table `002` writes: `sso-reauth-state:` and `sso-reauth-result:` (deleted by step 2 or exempt, each with its reason), `backchannel-logout:<client>:<jti>` (exempt), `auth.rate_limit` and `auth.jwks` (exempt), so that it passes on the real schema (design D9).

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
      tenants' credentials and create writes only the host tenant's `referenceId`, and
      a `userId` of another tenant answers `CATALOG_NOT_FOUND`. Verify: "Another
      tenant's credential cannot be listed, rotated or revoked" for list, the created
      key's `referenceId` being `t1`, and a create bound to `t2`'s service account
      being refused.
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
- [ ] 14.3 `createUser` and `linkSsoAccount` give one generic answer to every conflict (an
      account that already exists in this tenant, one in another tenant, a `sub` that is
      already linked): `CATALOG_VALIDATION_FAILED`, a fixed message and no state change, so
      a failed probe leaves no partial state and the cause appears in no response (a successful create or link differs from a rejection by construction, so
      "indistinguishable from success" is not the requirement), and the user, credential and bootstrap lifecycle events (`002` Q42; M9)
      are declared in `packages/auth/src/telemetry/contract.ts` here, before any route
      exists, because `002` Q42 forbids mounting an operation whose events are not
      declared: `catalog.audit.user_created` (with its `bootstrap` source),
      `catalog.audit.credential_created`, `catalog.audit.credential_rotated` and
      `catalog.security.credential_revoked`. They are emitted by the operations (the
      rest of the contract is 16.1). Verify: `identity-router.int.test.ts` covers
      "Create and link give one generic answer to every conflict" (each conflict cause
      answering identically, with no row written, no session revoked and no account
      changed afterwards), and each lifecycle action emitting its declared event, and `contract.test.ts` asserts the four names are declared.
- [ ] 14.4 `resolveContext` rejects a disabled (`banned`) user, so existing
      sessions and any new sign-in, local or through SSO, stop granting access, and a
      ban revokes the user's sessions (`002` VCDM M20; the tenant-scoped check is
      11.8). Verify: `context-resolver.int.test.ts` covers "A disabled user's sessions
      stop working" and `catalog.security.principal_rejected` being logged, and
      `banned-sign-in.int.test.ts` covers a banned user being refused at local sign-in
      and at the SSO callback.
- [ ] 14.4b A banned user's sign-in fails exactly like any other sign-in failure
      (Resolved decision Q54, VCDM G3). Better Auth's admin plugin refuses a banned
      user with a distinct error after a correct password, a credential-validity oracle
      that would break `002`'s rule that sign-in failures are identical, and it becomes
      live the moment `setStatus` mounts. The failure is made uniform at local sign-in
      and at the SSO callback: the status, error code and body equal those of a wrong
      password. The attempt itself is logged internally as
      `catalog.security.banned_sign_in_attempt` (declared in 16.1) with its channel and
      the opaque user id and no email, while the response stays uniform (design D13). Verify: `enumeration-resistance.int.test.ts` (in `packages/auth/src/`)
      gains a banned case, in which a banned user with the correct password, a wrong
      password and an unknown email get indistinguishable responses at local sign-in,
      and `banned-sign-in.int.test.ts` covers the SSO callback giving the same uniform
      failure, and the event being emitted once per banned attempt on each channel with
      no email in it.
- [ ] 14.5 Temporary and bootstrap passwords force a change at first sign-in and
      expire, through a marker row in `auth.verification` (identifier
      `temp-password:<userId>`, `expiresAt` equal to the expiry; Q36,
      recommended option, no migration). Two places honor it: `resolveContext` for
      `/v1`, and, for `/api/auth/*`, a session-aware `hooks.before` in `auth.ts` like
      the idle check, because `isAllowedAuthPath` is a static, session-blind set and
      cannot know about the marker. A session whose user holds an unexpired marker
      reaches only the change-password route until it is cleared (`002` VCDM M11).
      Verify: `temporary-password.int.test.ts` covers that a temporary password grants
      only the change-password route on both `/v1` and `/api/auth/*`, that changing it
      clears the marker, and that it expires.
- [ ] 14.5b The generated temporary password satisfies the password policy of 8.1 by
      construction. Today it is `randomBytes(24)` as base64url, whose only symbols are
      `-` and `_`, so about 36% of draws contain no symbol and fail the policy, and the
      generator exists twice (`identity-router.ts` and `bootstrap-admin.ts`). One shared
      generator in `@tayzu/auth` (the password module) guarantees the length and every
      character class from a CSPRNG, both call sites use it, and the policy applies to
      bootstrap passwords (`002` VCDM M5). Verify: `temporary-password.test.ts` covers
      1000 generated passwords all passing the policy (each with a symbol, a digit and
      both cases), the two call sites using the shared generator, and a bootstrap
      password failing the policy being refused.
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
      is not updatable by a non-admin (fail closed; Q37, recommended
      option) and the `002` spec correction is recorded for a `002` follow-up (`002`
      VCDM M15). Verify: `inherited-ownership.int.test.ts` covers a non-admin member's
      update of such an entity being denied and an admin's allowed.
- [ ] 14.7 Keys created through `002`'s machine-credential path get the
      plugin-level per-key rate limit (60 per hour, configurable, Q44) and no stored
      first characters (`002` residual risk; 9.5), with the headerless call. Verify:
      `machine-credentials.int.test.ts` covers the configured limit and an empty stored
      start on a created key.
- [ ] 14.8 Startup refuses `NODE_ENV=test` together with a non-local database
      host, because `NODE_ENV=test` relaxes the https checks, the role assertion and
      the OTLP requirement (`002` VCDM M12). Verify: `config.test.ts` (in `apps/api`)
      covers `NODE_ENV=test` with a remote `DATABASE_URL` host throwing at startup, a
      local host starting, and the database TLS check being unaffected.
- [ ] 14.9 The public re-authorization callback has its own limiter on the
      DB-backed store (a new `RateLimitScope` value, `reauthorization_callback`, in the
      TypeScript union; neither executable telemetry contract enumerates the values,
      but `002`'s design declares the enum closed, so this amends it, recorded in
      17.14), firing before
      the database `delete` it performs per hit (`002` VCDM M13). Verify:
      `reauthorization-limits.int.test.ts` covers the callback being rate-limited with
      no database access once the limit is hit.
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
- [ ] 14.12 _(setup)_ Record that Dependabot does not track the pinned image
      digests (`postgres`, Cerbos, ZAP in `ci.yml` and `scripts/ci/dast.sh`; its
      config lists npm and github-actions only) and add them to the quarterly review
      of the existing dependency process (`002` VCDM M17). Verify: `pnpm lint` passes
      and `docs/security/dependencies.md` lists each pinned digest with its review
      cadence and owner.
- [ ] 14.13 The DAST API scan asserts that it received 2xx responses on
      operations, so a scan that only ever sees 401 or 415 fails instead of passing
      silently (`002` VCDM M18; the SSO, back-channel and re-auth surfaces are
      deferred to `010`, design Risks). The check is `scripts/ci/dast-coverage.ts`, and
      its test sits in `apps/api/src`, like `zap-seed.test.ts`, because Vitest projects
      are `packages/*` and `apps/*` only and `scripts/ci` is outside every package.
      Verify: `apps/api/src/dast-coverage.test.ts` covers a fixture ZAP report with no
      2xx operation response failing the check and one with 2xx responses passing, and
      `dast.sh api-scan` runs the check on its report.

## 15. API contract and mount gate

- [ ] 15.1 oRPC procedures for the fourteen operations of design D10 (the three
      existing procedures `create`, `linkSsoAccount` and `unlinkSsoAccount` gain their
      `.route` and are addressed by the `{user}` identifier, Resolved decision Q31),
      each built with the wrapper of 5.3b and declaring `.route({ method, path, spec })`
      like `packages/catalog/src/api/contract.ts`, with `inputStructure: 'detailed'` for
      the `DELETE` routes, in the identity router of `apps/api` mounted beside the
      catalog router. Verify: `router.int.test.ts` calls each procedure once on its
      happy path through `createRouterClient`, and `openapi.test.ts` asserts the
      document generated from the router lists the fourteen routes with their methods
      and paths and **not** the accept route.
- [ ] 15.1c A second committed OpenAPI document, `openapi/identity.openapi.json`, is
      generated from the identity router in `apps/api` by a small generator over the
      router's `.route` declarations (method, path, `spec`), using only dependencies
      `apps/api` already has, with its own `contract:generate` and `contract:check`
      package scripts as a drift guard like the catalog's (`apps/api/package.json` has
      none today, and it has no `zod`, `@orpc/zod` or `@orpc/contract`; the router
      hand-parses its input). Per Resolved decisions Q43 and Q52 the document carries
      **paths, methods, path parameters and `x-tayzu-risk` only**, with no request or
      response schemas, and its DAST value is limited until schemas exist (recorded in
      the Risks and in `docs/security/attack-surfaces.md`); the root
      `contract:generate` and `contract:check` pick it up. DAST scanning of it stays the
      first-deployment gate. Verify: `identity-contract.test.ts` (in `apps/api/src/`)
      covers `contract:generate` producing the committed file, `contract:check` passing
      on it, `contract:check` failing after a route's path or risk spec is changed in a
      scratch edit, and the document containing no schema object.
- [ ] 15.1b The acceptance is a **plain Fastify route**, `POST
/v1/auth/invitations/accept`, registered before the `/v1/*` catch-all like
      `app.post(TOKEN_EXCHANGE_PATH)` (the catch-all would answer an unauthenticated
      call 401), parsing the body into a null-prototype object and subject to the body
      limit, with the DB-backed limiter of 8.13. Verify: `accept-route.http.int.test.ts`
      covers "A new person accepts over HTTP without a session" and the route being
      absent from the OpenAPI document and from the `contract:check` input.
- [ ] 15.2 `x-tayzu-risk: high` on every operation in the set (`setStatus`,
      `invite`, `identity.users.create`, `serviceAccounts.create`/`delete`,
      `credentials.create`/`rotate`/`revoke`, `organization.delete`, and the SSO
      `linkSsoAccount` and `unlinkSsoAccount`), per Resolved decisions Q19 and Q31.
      Verify: `openapi.test.ts` covers "Every route in the high-risk set is marked",
      reading the committed `openapi/identity.openapi.json` of 15.1c.
- [ ] 15.3 `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), **off by
      default**: with it off none of the fifteen routes is registered (the accept route
      included), and each answers **like an unknown `/v1` path**: 401
      `CATALOG_CONTEXT_REQUIRED` for an unauthenticated call (the catch-all resolves the
      context first) and the router's 404 for an authenticated one. Only the accept
      route is a Fastify route; the other fourteen are procedures behind the single
      `app.all('/v1/*')`. Verify: `mount-gate.int.test.ts` covers "Routes answer like an
      unknown path while the switch is off" for both callers and "No route is
      registered outside the switch" by enumerating the Fastify route table **and** the
      router's procedures.
- [ ] 15.3b With the switch **on**, every Fastify route outside an explicit public
      allowlist is behind `resolveContext` (Resolved decision Q57, VCDM G4), so a new
      route cannot become public by accident. The allowlist is explicit and reviewed
      (the accept route and the routes `002` leaves public). Verify:
      `route-auth-allowlist.int.test.ts` enumerates the Fastify route table of the
      server with the switch on, fails for a route that is neither on the allowlist nor
      behind `resolveContext`, and fails when a scratch route is added to the server
      outside both.
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
      are 403, `AUTH_RATE_LIMITED` is 429 **with a `Retry-After` header** (the caps and
      the accept route's limiter), a foreign or unknown target is 404. Verify:
      `errors.http.int.test.ts` covers each over the mounted server, the header on each
      429, and that the accept route's rejections are all the same 404.
- [ ] 15.6 `{user}` is the `_user` entity identifier (an email or `svc-…`) sent
      unencoded, and a path containing `%` answers 404 (`002` Q74). Verify:
      `user-path.http.int.test.ts` covers `PUT /v1/users/{email}/status` and
      `PUT /v1/users/svc-ci-github/status` resolving, and a `%` path being 404,
      including the `a%40b` that oRPC's generated client sends (a known limitation,
      recorded in the "Email in the `{user}` path" ticket).
- [ ] 15.6b The `DELETE` routes use `inputStructure: 'detailed'`:
      `DELETE /v1/organization` reads its confirmation from the query string
      (`?confirmation=<organization identifier>`) and compares it to the host tenant,
      and the two other `DELETE` routes take their target from the path; a confirmation
      sent only in a body does not count. Verify: `delete-routes.http.int.test.ts`
      covers the confirmation in the query being honored, a body-only confirmation and
      a wrong query value each answering `CATALOG_VALIDATION_FAILED` with nothing
      changed.
- [ ] 15.7 The existing-account acceptance over HTTP (Resolved decisions Q24 and
      Q38): the route reads the session cookie, requires the CSRF custom header and
      performs its own `Origin` check (`/v1` has only the CSRF header, CORS and
      SameSite=Lax, and Better Auth's origin check covers only `/api/auth/*`), which
      needs the `Origin` header to be **present and in `ALLOWED_ORIGINS`**; a failure
      answers the uniform 404, not a plugin 403. The step-up for an invited `admin` is
      an explicit call of the guard plus, for an SSO session, the re-authorization calls
      of 8.5d. Verify: `accept-existing.http.int.test.ts` covers a request without the
      CSRF header, one from a foreign origin and one with no `Origin` header each being
      refused with the uniform rejection, a request with no session for an existing
      account answering the same 404 as a wrong token, a matching session plus the token
      succeeding with the same status and body shape as the new-account path (for an
      account whose email was never verified), and an `admin` invitation answering
      `AUTH_STEP_UP_REQUIRED` only after the token and the session matched.
- [ ] 15.8 A cross-tenant request per route over HTTP: each of the fifteen routes,
      called by `t1`'s admin with a target of `t2`, answers the same response as an
      unknown target. Verify: `cross-tenant.http.int.test.ts` covers one request per
      route over the mounted server and compares each response to the unknown-id
      response.
- [ ] 15.9 A route-table-driven authorization matrix over HTTP (Resolved decision
      Q45), built from the router's own procedure list so a new route cannot be
      forgotten: for each of the fourteen oRPC routes, the admin (with a fresh step-up
      where the route is high-risk) is allowed, a `member` gets `AUTH_FORBIDDEN` 403, a
      machine `member` token gets 403 (service-account and integration actors skip
      step-up and had no denial test), an unauthenticated call gets 401 and, for a route
      with a target, a foreign target gets the same 404 as an unknown one. Verify:
      `identity-authorization-matrix.http.int.test.ts` runs the matrix over the mounted
      server and fails when a procedure of the router is missing from it.

- [ ] 15.10 Every procedure of the identity router is covered by the input contract
      of 5.3d, driven by the router's own procedure list so a new procedure cannot be
      forgotten. Verify: `identity-input.int.test.ts` calls each of the fourteen
      procedures through `createRouterClient` **as an admin** (the wrapper's role check
      comes before the input is parsed, design D10, so any other caller would get
      `AUTH_FORBIDDEN` instead of a parse error) with a `__proto__`, a `constructor` and a
      `prototype` key at depth 1 and 3, an undeclared field and an over-length value,
      asserting `CATALOG_VALIDATION_FAILED` and no lookup or write, and fails when a
      procedure of the router is missing from it.

## 16. Telemetry contract enforcement

- [ ] 16.1 Extend `@tayzu/auth`'s `telemetry/contract.ts` (which already exists
      with `SPANS`, `METRICS` and `LOG_EVENTS` that overlap the authz contract) with
      every remaining span, metric and log event from design.md's Observability
      contract (the user and credential lifecycle events were declared by 14.3),
      including `identity.organization.cancel_deletion`, `identity.user.reconcile`,
      `catalog.audit.users_reconciled`, `catalog.security.notice_suppressed`,
      `catalog.audit.org_deletion_cancelled`,
      `catalog.security.org_deletion_notice_failed`,
      `catalog.security.admin_notice_failed`, `catalog.security.email_recipient_blocked`,
      `catalog.security.banned_sign_in_attempt`, `catalog.security.org_deletion_repeated`
      and the new attributes (credential kind `agent`, rejection reasons
      `service_account_missing` and `user_missing`, denial reasons `csrf_rejected`,
      `origin_rejected` and `inviter_not_active_admin`, invitation cancel reason
      `inviter_disabled`, `tayzu.identity.email.template` and
      `tayzu.identity.sign_in.channel`), and make `otel-smoke-check` import it in
      addition to `@tayzu/authz`'s contract with aliased imports and a de-duplication
      of shared names. Verify: `contract.test.ts` snapshot-asserts every declared name,
      and `otel-smoke-check.int.test.ts` fails when a declared name is missing from the
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
      invitation resend, credential creation, rotation and revocation, org deletion requested, repeated, completed, failed and cancelled, a banned sign-in
      attempt, a recipient refused by the non-production allowlist, a reconcile run
      (`catalog.audit.users_reconciled`, with the operator id) and a suppressed or
      truncated notice (the user, credential and
      bootstrap events are declared and first tested in 14.3). In every audit event
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
      operator runbook to reverse a pending deletion (the maintenance workflow of
      12.14b with its environment reviewers as the named second approver, just-in-time
      access through Azure PIM with a personal account for any other operator access,
      the script of 12.14, which refuses a tenant whose purge has begun and does not
      restore the credentials phase 1 revoked, so the admins rotate each one); the
      `_user` reconcile as the repair for a member rejected with `user_missing`; the
      credential rotation cadence; the invitation caps, what their windows mean (a bucket resets only after a full
      window with no allowed request, Resolved decision Q66) and the cross-tenant
      denial-of-invitation trade-off; the email policy outside production (the mandatory
      recipient-domain allowlist, Resolved decision Q67); the off-boarding step that lists
      a disabled admin's service accounts and credentials by the viewer's `createdBy` and
      revokes or rotates them; the canonical email form and the
      addresses that are rejected (Resolved decision Q33); and the retention of audit
      and security logs (at least 12 months, independent of tenant deletion,
      cross-referencing `010`/`015`). Verify: `pnpm lint` passes and the runbook is
      reachable from the file.
- [ ] 17.6 Update `docs/security/attack-surfaces.md`: the fifteen routes with
      actor, authentication and Cerbos check, the public accept route with its session
      binding, CSRF header and origin check, the inert invitation link until `003`
      (Resolved decision Q32), the egress to `api.pwnedpasswords.com`, the SEC11 answers
      of Resolved decision Q34, the limited value of a scan of the schema-less identity document (Resolved decision
      Q52) and the mount gate state (it lists `identity.*` as not mounted today). Verify: `pnpm lint` passes and every route of design D10 has a
      row.
- [ ] 17.7 Update `docs/architecture/system-diagram.md`: the email provider, the
      invitee with their mailbox and the platform operator as actors, and arrows for
      invite → email, the public accept route, ACS egress over HTTPS, the Pwned
      Passwords range query, credential rotation, the purge job with its one database
      connection (`tayzu_purge`), the reconcile job (`tayzu_auth` and `tayzu_app`), the reversal script and the GitHub
      Actions maintenance workflow that starts it through OIDC. Verify: the Mermaid
      block still renders with `npx -y @mermaid-js/mermaid-cli`, and every new route
      from design D10 appears.
- [ ] 17.8 Update `docs/security/secrets.md` (the Communication Services secret on
      a dedicated send-only resource and its change procedure, the kill switch and its
      emergency flip (a new app revision), the `tayzu_purge` secret of the purge job, the `tayzu_auth` secret of the reconcile
      job and the reversal role's secret, each job with its own identity, the OIDC
      federation, and the GitHub settings checklist of the maintenance workflow that
      the human applies (Resolved decision Q55: required reviewers with "prevent
      self-review", deployment branches limited to `master`, the OIDC federated
      credential's subject pinned to the environment, and, Resolved decision Q64, the
      federated identity's Azure role limited to the action that starts the named jobs,
      with the `CODEOWNERS` owner handle the human supplies), each with owner and rotation, the
      credential lifecycle) and `docs/security/crypto-inventory.md` (the invitation
      token, the SHA-1 prefix sent to the Pwned Passwords range query, the sha256 of the
      per-recipient cap key and the authentication to ACS). Verify: `pnpm lint` passes
      each names its owner and rotation procedure, and the settings checklist lists the
      four settings.
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
      resource kinds and their actions in the taxonomy, the new spans, metrics and log
      events in the telemetry reference, and the amendment of the closed rate-limit scope
      enum (`invitation_accept`, `invitation_tenant`, `invitation_recipient`,
      `notice_tenant` and `reauthorization_callback`). Verify: `pnpm lint` passes and every
      resource kind of design D3 and every event of the Observability contract is
      listed.
