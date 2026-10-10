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

Tasks follow the Resolved decisions Q1 and Q4-Q131 in `design.md` (there is no Q2 or
Q3). The ninth amendment's two open questions are Q116 (the invitee is the actor of an
acceptance, and the bootstrap records the operator's opaque id) and Q117
(`catalog.audit.user_status_changed` records every status change, with the principal of
its write and the status event), applied to tasks 4.1e, 4.2b, 4.3, 4.4, 4.5, 4.6, 4.6b,
7.3, 8.1e, 8.2, 8.5b, 10.3, 11.2, 11.5, 13.3, 15.1 and 15.6. The twelfth amendment's
three open questions are answered (design, thirteenth amendment; no question is open):
Q127 (on the new-account path the admin notice is sent after the acceptance commits or
when the consumption changes no row, whether or not the attempt's own `_user` step
activated the row, and a compensated failure sends none) is applied to tasks 8.1e and
8.15; Q128 (the window between the `pending` check of resend and cancel and the
acceptance's `accepted` write is a documented residual, with the ticket TK12-1 as its
structural fix) adds no race case to any task: tasks 7.6, 7.7 and 8.10 cite the
residual, tasks 7.13, 11.4 and 11.4b are unchanged by it, and tasks 5.1b, 7.2, 7.5 and
8.3 stay as they are; Q129 (an admin's cancel of an invitation that is not `pending`
answers the resend's `CATALOG_VALIDATION_FAILED` with the same fixed message, changes
nothing and logs nothing, and the internal cancellations, `user_created` included, only
skip it) is applied to tasks 7.6, 7.13 and 8.10; and Q130 (Q125's rewrite
extends to three catalog integration tests, and the catalog's redaction fixture they use
has only its header comment corrected) to task 4.1d. The hold that kept tasks 7.6, 7.7, 7.13, 8.1e,
8.10, 8.15, 11.4 and 11.4b unticked until those answers is released. Q131 (the
fourteenth amendment's drift N14-2: once a banned sign-in logs `account_disabled`, the
`002` smoke check's assertion on the reasons of `auth.security.login_failed` becomes the
exact set `{bad_credentials, mfa_failed, account_disabled}`) is applied to task 15.2,
and tasks 13.4b and 15.1 point to it. The tenth
amendment's Open Question 1 is Q122: on the existing-account
path the revocation of the accepting session and of the session an earlier attempt's
shed recorded, and the admin notice, run as soon as the attempt's `_user` step has run,
before the `emailVerified` write and the consumption of the token (on the new-account
path the notice follows the commit or, since Q127, a consumption that changes no row),
applied to tasks 8.1e, 8.5b, 8.5h, 8.5k,
8.5m, 8.15 and 16.5. Q123 (the acceptance marks the invitation `accepted` with the
consumption of its token, and resend, cancel and the disable-time cancellations skip an
invitation that is not `pending`) is applied to tasks 5.1b, 7.6, 7.7, 8.1e, 8.3,
8.10, 11.4 and 11.4b; Q124 (the orphan grace period runs from the `_user` row's `updatedAt`) to tasks
4.2b and 16.5; Q125 (the rewrite of the existing case of `redaction.test.ts`, extended
by Q130) to task 4.1d; and Q126 (the subject of the `created_invited` status event) is the existing
wording of tasks 4.1e, 7.3 and 15.1, with the optional `invitationId` of task 4.1's port
input carrying that subject to the adapter (twelfth amendment, no new decision).
The eighth amendment's Open Question 1 is Q111, applied to design D2, the Risks
bullet on failed acceptances and the spec, and to tasks 3.2, 4.4, 8.1e and 16.5. Org deletion and data retention (the old group 12 of this file) moved to `045-org-deletion-and-data-retention` by Q103: no task here covers them.

The one migration of this change is `0011`; `045` owns `0012` to `0014` and no migration
is renumbered. The task groups after the old group 12 moved up by one: `002`'s references
to `043`'s group 14 (the hand-offs, `002` Q73 and its residual risks) and to task 14.2
(`002` Q84) mean group 13 and task 13.2 here, and group 14 is the mount group (design,
"Hand-offs from `002`: traceability"). Every migration and every Cerbos task is marked **(Checkpoint 3)** and stops for the human's separate approval. A task
numbered with a letter (`8.5b`) was added by an amendment and is a full cycle of
its own unless it is marked _(setup)_ (2.0b, 8.1a). Tasks run in file order, which is
not always the order of their letters, so that every task runs after what its test
uses: 4.1b runs after 4.2, whose derivation of the `membership_added` intent its wiring
test exercises; 14.1c runs before 14.1b, whose Verify reads the `contract:check` input
that 14.1c creates; 6.8b runs before 6.6, whose cap throws its `AuthRateLimitedError`; 6.7b runs
before 6.7, whose key it computes; 8.5i runs before 8.5g, because the shed core of 8.5h
runs inside its `withUserLock` transaction; and 11.2b runs after 11.8, whose resolver
status check it asserts. Where a behavior spans tasks, the assertion that needs a later
task's code is that later task's case, never the earlier one's: the breached-password
stub of `dast.sh` is 8.1a's and the DAST seed's policy-compliant password 13.5b's (not
4.6b's), the notice of a tenant on `EMAIL_DISABLED_TENANT_IDS` is 6.12's (6.5c tests its
gate on fakes), the acceptance cases of the breach check and of the NFC normalization are
8.12's and 8.2's (8.1b and 8.1d set the password through `auth.api.createUser`), the
key create and revoke through the identity operation are 9.5's and 9.9's (9.1b calls the
helpers directly), an `id` that `rotate` accepts is 9.6's (9.2 asserts the id), a
surviving key of an identifier with no `_user` not resolving is 11.6's and 11.7's (10.3
asserts the refused creation), the one fixed message of every conflict is 13.3's (10.3
and 13.2b assert `CATALOG_VALIDATION_FAILED`), the result of the acceptance's entry
point for the `membership_added` intent and the membership hook's `userId` subject are
4.2's (the tests of 4.1 and 4.1e pass explicit `StatusEvent` inputs and port inputs),
and the route list of the generated identity document is 14.1c's (14.1 calls the
procedures). The
`_user` reconcile, which writes through the adapter of 4.1 and the `membership_added`
intent of 4.2, is task 4.2b; it was numbered 2.2b, so `045`'s reference to `043`'s task
2.2b means task 4.2b here (`045` is not edited; this note is the mapping).

**Order matters.** Group 13 (the hand-offs from `002`) comes before group 14,
the only group that registers routes over HTTP (`002` Q73, design D15). Groups 1
to 12 test in process through `createRouterClient` or the service layer, and no
HTTP assertion about an identity route is written before group 13 is done.

Scenario names in quotes refer to
`specs/identity-lifecycle-and-org-admin/spec.md`. Test files live next to the
code as `*.test.ts`. Integration tests are named `*.int.test.ts` and need
`DATABASE_URL` plus a running Cerbos test container, per `002`'s own harness.

## 1. Setup and coordination with `002`

- [ ] 1.1 _(setup)_ The drift-check against the merged `002` was run on
      2026-10-01 and its mechanical fixes are in `design.md` (Context); the second to fourteenth drift-checks and the second to thirteenth VCDM passes (2026-10-01, 2026-10-07, 2026-10-08 and 2026-10-09) are folded in too. At
      implementation time this task is a last drift-check of the files the design
      names (`user-sync.ts`, `identity-router.ts`, `context-resolver.ts`,
      `token-exchange.ts`, `server.ts`, `policies/`) and adjusts import paths and
      attribute names only if drift is found, with no scope change. Verify: a short
      note in the PR description states what, if anything, was adjusted.
- [ ] 1.2 _(setup)_ The `vcdm-ssa-validator` pre-assessment in Mode A against the
      merged `002` was run on 2026-10-01 and its eleven blocking gaps (B1-B11) are
      folded into `design.md`, the spec and these tasks, together with the five gaps
      (NB1-NB5) of the second pass, resolved by Q24-Q27, the two gaps and four
      questions of the third pass, resolved by Q38-Q45, the fourteen non-blocking
      gaps (G1-G14) of the fourth pass, resolved by Q48-Q57, tasks and tickets, the
      three blocking gaps (NB-1 to NB-3), the eight non-blocking gaps (G-a to G-h)
      and the four questions (Q-A to Q-D) of the fifth pass, resolved by Q62-Q69,
      tasks and tickets, and the blocking gap NB-4, the fourteen non-blocking gaps
      (G6-1 to G6-14) and the three questions (Q-A to Q-C) of the sixth pass,
      resolved by Q73, Q80 and Q81, tasks and tickets. The sixth drift-check's seven
      decisions (B1-B7) are resolved by Q74-Q79 and Q82-Q84 (Q82 now governs `045`'s migrations). The seventh pass (the blocking
      gaps NB-5 and NB-6, the ten non-blocking gaps G7-1 to G7-10 and three questions) is
      resolved by Q86-Q88, tasks and tickets, and the seventh drift-check's decisions
      (A1, B1, C1-C3, C5, C6, D1-D3) by Q89-Q98; C4 (the task count) is resolved by Q103, which moved org deletion and data retention to `045`.
      The eighth pass (the blocking gaps NB-7 and NB-8 and the ten non-blocking gaps
      G8-1 to G8-9 and G8-12; its report assigns no G8-10 or G8-11) and the eighth drift-check's decisions (B-1 to B-3) are resolved by Q101,
      Q102 and Q105-Q110, tasks and tickets. The eighth amendment's Open Question 1 is
      resolved by Q111, the ninth pass (no blocking gap and the seven non-blocking gaps
      G9-1 to G9-7) by Q112, Q115, tasks and the tickets TK9-1 and TK9-2, and the ninth
      drift-check's decisions (N1 and N3) by Q113 and Q114; its mechanical items (N2 and
      N4-N9) need no decision and are folded into the design and these tasks. The ninth
      amendment's two open questions are resolved by Q116 and Q117, and the tenth pass (no
      blocking gap and the four non-blocking gaps G10-1 to G10-4, with the tenth
      drift-check's D-2 and D-3) by Q118-Q121 and tasks; its mechanical items (D-1 and
      D-4) need no decision and are folded into the design and these tasks. The tenth
      amendment's Open Question 1 is resolved by Q122, the eleventh pass's G11-1 and
      G11-5 by Q123 and Q124, the eleventh drift-check's N-1 by Q125, and Q126 confirms
      the subject of the `created_invited` status event; the eleventh pass's low gaps
      (G11-2, G11-3, G11-4 and G11-6) and the eleventh drift-check's mechanical items
      (N-2 to N-5, N-5 being G11-3) need no decision and are folded into the design,
      these tasks, the Gates and the ticket TK11-1. The twelfth amendment's consistency
      check folds its fixes into the design and these tasks with no new decision, and
      its Open Questions 1 to 3 are resolved by Q127, Q128 (with the ticket TK12-1) and
      Q129, and the twelfth drift-check's N12-1 by Q130 (the thirteenth amendment); the
      twelfth pass's low gaps (G12-1, and G12-2, a residual of Q127), the twelfth
      drift-check's mechanical items (N12-2 and N12-3) and a follow-up of G11-2 need no
      decision and are folded into the design, these tasks, the Gates and the ticket
      "Alerts for `010`"; a consistency check of the thirteenth amendment folds its
      fixes into the design, the spec and these tasks with no new decision. The
      thirteenth pass's low gap G13-1 (the thirteenth drift-check's N13-1) and its
      V13-note, the thirteenth drift-check's N13-2 and N13-3 and a final consistency check
      of the thirteenth amendment (C-1 to C-10) need no decision and are folded into the
      design, the spec, these tasks and the Gates by the fourteenth amendment, and that
      amendment's drift-check's N14-1 needs no decision and its N14-2 is resolved by
      Q131 (task 15.2). Attach the reports to the PR. Verify: the report is attached to the PR with zero open
      blocking gaps or an explicit deferral recorded.
- [x] 1.3 _(setup)_ Add `@azure/communication-email` (`1.1.0`) to
      `packages/auth/package.json`, and add the Communication Services connection
      string as a Key Vault secret reference, following `002`'s existing pattern
      for the database credential. Check its license, its install scripts (keep
      them blocked unless `allowBuilds` in `pnpm-workspace.yaml` must allow one) and
      its transitive dependencies. Verify: `pnpm install` succeeds, and
      `docs/security/dependencies.md` lists the new package with the license, the
      `allowBuilds` decision and the SBOM review, and with the source and license of the bundled common-password denylist of 8.1 (it is data, not a dependency, so its provenance has to be on record).
- [x] 1.4 _(setup)_ Scaffold the homes of the identity code (Resolved decision
      Q30): `packages/auth/src/identity/` for the pure parts and the structural ports
      (empty modules for `user-status.ts`, `invitation-token.ts`, `password-policy.ts`,
      `email/sender.ts`, `ports.ts`), `apps/api/src/identity/` for the
      orchestration and the routers (empty modules for `invitations.ts`,
      `service-accounts.ts`, `credentials.ts`), and
      `apps/api/scripts/` for the `tsx` scripts (`backfill-user-blueprint.ts`,
      `reconcile-users.ts` and `bootstrap-admin.ts`, which is its future home: the CLI
      moves there in 4.6b) with the package scripts `identity:backfill-user-blueprint`
      and `identity:reconcile-users` (`045` adds the purge job and the reversal script). Vitest includes only `src/**`
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

- [x] 2.0 Every maintenance script starts telemetry, emits its audit events and
      flushes before it exits (Resolved decision Q79). Telemetry starts only in
      `apps/api/src/main.ts` today, so the durable `catalog.audit.*` events of a
      short job (`users_reconciled` and the bootstrap's `user_created`; `045`'s
      `org_deletion_completed` and `org_deletion_cancelled` use the same helper) would be
      no-ops.
      A shared `runScript(name, fn)` in `apps/api/scripts/run-script.ts` starts the
      SDK the way `apps/api/src/telemetry.ts` does, runs the script and shuts the
      SDK down, which flushes the exporters, in a `finally`, on success and on
      failure. It also **asserts the script's database role** before the script runs:
      the script declares the role or roles it expects and the helper compares them with
      `current_user` of each pool it is given, refusing to run otherwise (`002`'s
      runtime-role assertion runs only in `createAppFromEnv`, `002` Q62, which no script
      goes through; `045`'s purge job and reversal use the same helper for `tayzu_purge` and
      `tayzu_deletion_admin`).
      It reads the environment names the app already reads,
      `OTEL_EXPORTER_OTLP_ENDPOINT` (and the per-signal variants) and
      `TAYZU_TELEMETRY_DISABLED`, which are documented for the jobs in
      `docs/security/secrets.md` (16.8). Verify: `run-script.test.ts` (in
      `apps/api/src/`, importing `../scripts/run-script.js`) covers an event emitted
      by a script being in an in-memory exporter after `runScript` returns, the
      flush happening when the script throws, telemetry being refused outside test
      unless `TAYZU_TELEMETRY_DISABLED=true`, and each of the scripts of 1.4 (the backfill,
      the reconcile and the bootstrap CLI) starting through it (a test that reads the
      three script modules), and a script that
      runs as a role it did not declare being refused before it does any work.
- [x] 2.0b _(setup)_ The scripts read a **separate configuration loader**, and the test
      harness gains the role they need. `loadConfig` in `apps/api/src/config.ts` requires
      `DATABASE_URL`, `AUTH_DATABASE_URL`, the secret and Cerbos for every caller, which a
      script that holds one role, or no `BETTER_AUTH_SECRET`, cannot supply, so the scripts read
      `apps/api/scripts/script-config.ts`, which reads only what a script declares it
      needs; `loadConfig` gains only what the app needs (for example 6.3, 6.5, 6.5c, 6.6,
      6.7, 6.7b, 6.8, 6.9, 6.12, 8.13, 9.4, 9.5, 9.5d, 10.8 and 14.3) and nothing for the
      scripts. `packages/db/src/harness.ts` sets up only
      `tayzu_migrator` and `tayzu_app` today, so tests that run as `tayzu_auth` (the
      backfill and the reconcile list organizations and members through it, and the
      reconcile also runs the shed of 8.5l through it, Resolved decision Q105) need a login
      role, a pool and membership grants of their own (the harness's bare `GRANT ... TO
      current_user` carries `set_option` and `inherit_option`). `045` extends both for its
      `tayzu_purge` and `tayzu_deletion_admin` roles. The reconcile's shed is the shed core
      of 8.5h, parameterized SQL on its `tayzu_auth` pool, and it builds no Better Auth
      instance, so `script-config.ts` gives neither script `BETTER_AUTH_SECRET` (Resolved
      decision Q114). Both do declare `CERBOS_ADDRESS`: every catalog operation asks
      Cerbos, the `system` actor included, so the backfill's `blueprints.update` (2.2) and
      the reconcile's `_user` writes through the adapter of 4.1 and its orphan removal
      (4.2b) reach it. In production the address is the job's own Cerbos sidecar (design
      D9, `002` Q8), and the scripts build the Cerbos client the way `createApp` does
      (without TLS only on a loopback address). The reconcile (4.2b) and the bootstrap CLI
      (4.6b) also declare `TAYZU_OPERATOR_ID`, the operator's opaque id, validated against
      the catalog's id pattern (`[A-Za-z0-9_.:-]{1,128}`, never an email; design D9,
      Resolved decision Q116). Verify: `pnpm --filter @tayzu/db
      test` and `pnpm --filter @tayzu/api test` stay green, and `script-config.test.ts`
      covers a script reading only its own variables, a missing one failing only the
      script that needs it, neither the backfill nor the reconcile declaring or reading
      `BETTER_AUTH_SECRET`, each of the two declaring `CERBOS_ADDRESS` and refusing to
      start without it, and the reconcile and the bootstrap CLI each declaring
      `TAYZU_OPERATOR_ID` and refusing to start when it is missing.
- [x] 2.0c `@tayzu/auth` exports the helpers through which `apps/api` creates every
      identity log event, span and counter, before the first task that emits one
      (design, Observability contract): an event emitter, a span helper and a metric
      recorder over the `@tayzu/auth` tracer and meter, like `emitAccountLinkEvent`,
      because `apps/api` has no `@opentelemetry/api` dependency and the design names
      none. It also creates the separate identity contract module,
      `packages/auth/src/telemetry/identity-contract.ts` (Resolved decision Q74),
      exported from the package and declaring no name yet: 13.3 declares the four `002`
      Q42 names in it and 15.1 the rest, and `telemetry/contract.ts` and its
      `contract.test.ts` are not edited. Verify: `identity-telemetry.test.ts` (in
      `packages/auth/src/telemetry/`) covers, under in-memory exporters, the event
      emitter exporting a log record with the name, severity and attributes it is given
      under the `@tayzu/auth` scope, the span helper recording a thrown error on its span
      and rethrowing it, the metric recorder adding to a counter under that scope, and
      the identity contract module being importable from the package index with no name
      declared.
- [x] 2.1 `USER_BLUEPRINT` carries the optional `accountKind` (`"standard"` |
      `"service"`, default `"standard"`, applied on write only) and a four-value
      `status` enum (`Staged`, `Invited`, `Active`, `Disabled`, default `Staged`)
      for every new tenant. `USER_BLUEPRINT` and `bootstrapSystemBlueprints` are
      module-private in `packages/catalog/src/service/system-blueprints.ts` today
      and absent from the package index, so `@tayzu/catalog` also exports the
      constant and a builder for the full `CreateBlueprintInput` that
      `blueprints.update` takes (it takes a full input, not a patch), which the
      backfill of 2.2 uses. Verify: `user-blueprint.int.test.ts` covers that a new
      tenant's `_user` blueprint has both, and "New entity without a status starts
      staged", and `system-blueprints.test.ts` (in `packages/catalog`) covers the
      index exporting the constant and the input builder and the built input
      validating.
- [x] 2.2 A one-off, idempotent `tsx` script
      (`apps/api/scripts/backfill-user-blueprint.ts`, started through the helper of 2.0)
      runs `blueprints.update` as the `system` actor once per existing tenant to bring
      `_user` forward, with the full input built from the `USER_BLUEPRINT` that 2.1
      exports. `blueprints.update` always bumps the blueprint's `version` and appends a
      change event, so the script compares each tenant's `_user` schema with the
      builder's output and skips a tenant that is already on it; that comparison is what
      makes a second run a no-op. It declares the roles `tayzu_auth` and `tayzu_app`
      for 2.0, and it reaches Cerbos at `CERBOS_ADDRESS` (2.0b), because
      `blueprints.update` asks Cerbos for the `system` actor too; in production that is
      the job's own Cerbos sidecar (design D9). It lists the
      tenants from `auth.organization` through the `tayzu_auth` pool, because
      row-level security blocks enumerating tenants through `tayzu_app`, and writes
      each tenant through `tayzu_app`. In production it runs as an operator-started
      Container Apps Job under just-in-time access (Azure PIM; design D9); `045`'s maintenance workflow
      later takes over starting it (Resolved decision Q41). Verify:
      `backfill-user-blueprint.int.test.ts` (in `apps/api/src/identity/`, importing
      `../../scripts/backfill-user-blueprint.js`) seeds two tenants with the old schema, asserts the
      script finds both without enumerating through `tayzu_app`, and covers adding
      `accountKind` and widening `status` being a compatible change: the update succeeds,
      existing `_user` entities stay valid and are not rewritten, and a second run
      changes nothing: no version bump and no new change event. The script reaches the
      Cerbos test container through `CERBOS_ADDRESS`, and a run whose `CERBOS_ADDRESS`
      is unreachable updates no tenant (the pipeline fails closed).
- [x] 2.3 Every reader of `accountKind` treats an absent value as `standard`,
      because a blueprint default applies only on write (design D1). Verify:
      `account-kind.test.ts` covers a `_user` read without the property resolving to
      `standard` (the Cerbos attribute built from such an entity is 5.1's case).

## 3. User status state machine (pure)

- [x] 3.1 `nextStatus(current, event)` for the creation events
      (`created_staged` from none → `Staged`, `created_invited` from none, `Staged`
      or `Invited` → `Invited`, `created_active` from none → `Active`). Verify:
      `user-status.test.ts` covers "New entity without a status starts staged",
      "Explicit invite starts a user as invited" and "A user created by an admin is
      active" at the pure level.
- [x] 3.2 `nextStatus` for `first_sign_in` and `invitation_accepted` from
      `Staged` and `Invited` → `Active`, and rejection of both from `Disabled`. The pure
      transition is unchanged by Resolved decision Q111: limiting `first_sign_in` to a
      user who holds exactly one membership is the hook's rule (4.4), not the table's.
      Verify: `user-status.test.ts` covers "First sign-in activates a staged or
      invited user", "A disabled user is not revived by signing in" and "A disabled
      user is not revived by a pending invitation" at the pure level.
- [x] 3.3 `nextStatus` rejects any transition from `Active` to `Invited` or
      `Staged` by throwing a package-local `StatusTransitionError` whose
      `code` is `CATALOG_VALIDATION_FAILED` (no `@tayzu/catalog` dependency).
      Verify: `user-status.test.ts` covers "Active never regresses to invited or
      staged" and the error code.
- [x] 3.4 `nextStatus` for `admin_disable` (from `Staged`, `Invited` and
      `Active`) and `admin_enable` (from `Disabled` only). Verify:
      `user-status.test.ts` covers "Disable and re-enable" and rejects
      `admin_enable` from a non-`Disabled` status.
- [x] 3.5 `nextStatus` is exhaustive: every `(status, event)` pair not
      explicitly allowed throws `StatusTransitionError`, never returns
      `undefined`. Verify: `user-status.test.ts` iterates the full matrix (`null`
      and the four statuses against the seven events) and asserts every cell is
      either an allowed transition or an explicit rejection.

## 4. Every status writer goes through the state machine

- [x] 4.1 The status writers take a `StatusEvent`. There are **two** sync types and
      both change (Resolved decision Q10, design D2). In `@tayzu/auth`,
      `UserSyncPort` and its input (`auth.ts`) replace the two-value `status`
      (`'Active' | 'Disabled'`) with a `change`, which is a `StatusEvent` or the
      intent `membership_added` (carrying whether the member's Better Auth user is
      `banned`), and accept an optional `onBehalfOf`. The port's input also gains
      `userId` (design D2; a consistency fix within Resolved decisions Q117 and Q120, no
      new decision), because today it carries no Better Auth user id, so the adapter
      could neither compare a hook call with the acceptance's `(tenantId, userId)` (Q120,
      8.1e) nor name the subject of a hook write (Q117, 4.1e): it is the Better Auth user
      id of a human, which the membership hook passes from
      `afterAddMember({ member, user })`'s `user`, the ban hook from the row it receives
      (`SyncUserRow.id`), the first-sign-in hook of 4.4 from the user who signed in and
      `refreshDisplayData` (4.1c, the `upsertUser` caller in `auth.ts` beside the
      hooks) from its `account.userId`, while the `apps/api` writers pass the id they
      hold; it is the `svc-…` identifier of a service account (Resolved decision Q90);
      and it is absent only for the invitation hook's `created_invited` write, which
      passes the optional **`invitationId`** (the `invitation.id` that
      `afterCreateInvitation` receives) instead (Resolved decision Q126; a consistency
      fix within it, no new decision). The port has only
      `upsertUser`, so a hook cannot read the current status: `afterAddMember`
      passes the intent and the adapter derives the event (4.2). In
      `@tayzu/catalog`, `UserSyncInput` in
      `packages/catalog/src/service/user-sync.ts` (today a two-value `status`, a
      fixed actor and no `onBehalfOf`) gains the four-value status of D1 and the
      optional `onBehalfOf`. `createUserSync` lives in `@tayzu/catalog`, which
      cannot import `@tayzu/auth`, so the Q30 adapter in
      `apps/api/src/identity/user-sync-adapter.ts` implements `UserSyncPort`: it
      reads the current status and the entity version, calls `nextStatus` and writes
      the resulting status, never a raw one. The adapter's entry point that the
      acceptance's `_user` step calls (8.1e) **returns the status event it wrote, or
      none** when it wrote nothing: `invitation_accepted` or `created_active` means that
      the attempt activated the row, which decides the existing-account admin notice of
      8.15 (Resolved decision Q122); the hook-facing `UserSyncPort.upsertUser` stays
      `Promise<void>` (design D2; a consistency fix within Q122, no new decision).
      `UserSyncInput` also gains an optional
      `expectedVersion` and `createUserSync` a read path (`entities.get`, which the
      adapter uses): for an existing row the write passes the version it read as
      `expectedVersion` to `entities.upsert`, and for a missing row it is
      `entities.create` (a create race answers `CATALOG_ALREADY_EXISTS`, not a version
      conflict). On either conflict the adapter re-reads and retries a bounded number of
      times (3) before failing closed, so a concurrent ban, first sign-in and add-member
      cannot revive a `Disabled` user (Q83). A **redundant event is a no-op**: when the
      status already is the event's target (`admin_enable` for `Active`, `admin_disable`
      for `Disabled`) the adapter writes nothing (4.5). Verify: `user-sync.int.test.ts` (in
      `apps/api`) covers a write for each allowed event, a rejected `Active` →
      `Staged` write, a write with `onBehalfOf` carrying the admin on the change
      event, a concurrent `admin_disable` between the adapter's read and its write
      never being overwritten (the user stays `Disabled`), a create race for a missing
      row (`CATALOG_ALREADY_EXISTS`) being retried like a version conflict, a redundant
      event writing nothing and a write failing closed once the retries are exhausted, the
      acceptance's entry point, given explicit `StatusEvent` inputs, returning the status
      event it wrote (`invitation_accepted` for an `Invited` row it activates,
      `created_active` for a missing row it creates) and no status event for a redundant
      event that writes nothing (its result for the `membership_added` intent, whose
      derivation is 4.2's, is a case of 4.2), and a
      new `packages/catalog/src/service/user-sync.int.test.ts` (no test of
      `createUserSync` exists in `@tayzu/catalog` today) covers `createUserSync` with the
      four-value status, the read path, `expectedVersion` and `onBehalfOf`. Every test
      that passes `createUserSync` to `createAuth` or `bootstrapAdmin` (the first
      `describe` of `user-sync.int.test.ts` and `sso-jit-refresh.int.test.ts` around
      line 179 among them) migrates to the adapter, because the port's input no longer
      has a `status`.
- [x] 4.1c `refreshDisplayData` (`auth.ts`) upserts a member's display fields
      without a status. With the new default `Staged` it would create a `Staged` row
      for a member who has none, which the resolver rejects (11.8, Resolved decision
      Q105) and which the reconcile, which only creates missing rows, would never
      repair; so it updates the display fields of a row that exists and never creates
      one or writes a status. Verify: `display-data.int.test.ts` covers a member with no
      `_user` row still having none after a profile refresh, and a member with a row
      having only its display fields updated, the status unchanged.
- [x] 4.1d No catalog span and no catalog audit event carries a `_user` identifier
      (Resolved decisions Q107 and Q113; design, Observability contract). `packages/catalog/src/service/entities.ts` sets
      `tayzu.catalog.entity.identifier` to the raw identifier on `catalog.entity.create`,
      `upsert`, `get`, `delete`, `status.write` and `related.list`, and a `_user`
      identifier is the member's email (`user-sync.ts`), so once 4.1b wires the adapter
      every status write would export it (it is latent in `002` only because `createApp`
      wires no `userSync`). For an entity of the reserved `_user` blueprint the attribute
      carries one fixed placeholder constant, exported by
      `packages/catalog/src/telemetry/contract.ts`, instead of the identifier, and every
      other blueprint keeps its identifier. The attribute stays required on those spans:
      Q107 allows omitting it, but `otel-smoke-check` asserts required attributes and
      omitting it would loosen that assertion. This amends `001`'s catalog telemetry
      contract, and `docs/catalog/catalog-core.md` (its `## Telemetry` section) records
      the placeholder for `_user` entities. The same holds for `001`'s
      `catalog.audit.mutation` log event (Resolved decision Q113, which extends Q107):
      `emitAuditMutationLog` in `packages/catalog/src/service/pipeline.ts` sets
      `tayzu.catalog.resource.identifier` to the raw identifier after every committed
      mutation, so for a `_user` resource it carries the same placeholder, the attribute
      stays declared in `LOG_EVENTS`, and every other blueprint keeps its identifier; the
      change-event row, found by `tayzu.tenant.id` and `tayzu.catalog.change_event.seq`,
      keeps the identifier in the database. `docs/catalog/catalog-core.md` records this
      amendment of `001`'s audit contract in the same section, beside its log-event table.
      The same holds for the catalog's Cerbos requests (Resolved decision Q119, which
      extends Q107 and Q113): `decisionLogsEnabled: true` writes the resource id to
      Cerbos's decision log, so for an entity of the `_user` blueprint the `catalog_entity`
      checks of `entities.ts` (the `resourceId` of their authorization declarations, which
      the pipeline's Cerbos call in `pipeline.ts` sends as `resource.id`) carry the same
      placeholder instead of the identifier (no `catalog_entity` policy reads `R.id`), and
      so does the per-referrer `update` check of a delete, `mayUpdateReferrer` in
      `entities.ts` (`002` Q65), which calls `checkResources` directly with the
      referrer's raw identifier and therefore sends the placeholder when the referrer's
      blueprint is `_user` (a mechanical fix within Q119, no new decision), and
      `redactUnreadable` (`packages/authz/src/redaction.ts`, which the catalog's referrer
      redaction calls) sends each candidate's position as its resource id and maps the
      decisions back to the identifiers in process. Every other blueprint's single-entity
      checks (the operation's own check and `mayUpdateReferrer`) keep their identifiers;
      the redaction batch is positional for every blueprint (Q130).
      `docs/catalog/catalog-core.md` records this as well.
      Verify: `contract.test.ts` (in
      `packages/catalog/src/telemetry/`) covers the contract exporting the placeholder,
      the six entity spans still declaring `tayzu.catalog.entity.identifier` as a required
      attribute and `catalog.audit.mutation` still declaring
      `tayzu.catalog.resource.identifier`, and `user-identifier-telemetry.int.test.ts` (in
      `packages/catalog/src/service/`) covers "A `_user` email never reaches a catalog
      span": under an in-memory exporter, a `_user` entity whose identifier is a marker
      email, written through `createUserSync` (`002`'s existing sync) and read, upserted,
      deleted and listed through the catalog operations as the `system` actor, exports the placeholder on each
      of the six spans and the marker in no exported attribute, a service account's
      `svc-…` identifier is replaced the same way, and a non-reserved entity's spans
      still carry its identifier; and "A `_user` email never reaches the catalog audit
      event": each of those writes exports a `catalog.audit.mutation` whose
      `tayzu.catalog.resource.identifier` is the placeholder, the marker in none of its
      attributes, its `tayzu.catalog.change_event.seq` finding the change-event row that
      still holds the identifier, and a non-reserved entity's event still carrying its
      identifier; "A `_user` email never reaches the Cerbos decision log": a recording
      Cerbos client around the real one shows every request of those operations on the
      marker `_user` entity carrying the placeholder as `resource.id` and the marker in no
      field, the same request for an entity of another blueprint carrying its identifier,
      a delete with `detachReferences` whose referrer is a `_user` entity (seeded with a
      relation to the deleted entity) sending the placeholder as that referrer's
      `resource.id` in its `update` check and the marker in no field, while a referrer of
      another blueprint is checked with its identifier, and a delete blocked by referrers
      sending positional ids whatever their blueprint; `redaction.test.ts` (in
      `packages/authz/src/`) covers the candidates being sent as positional ids, the
      readable identifiers coming back in their original order and a candidate missing
      from the response still counting as not visible. Its existing case ("N identifiers
      become a count when unreadable") contradicts Q119 and is **rewritten** (Resolved
      decision Q125), not loosened: its mock decides by position instead of by
      identifier, and its assertion at `:61-63` changes from "the request ids equal the
      candidate ids" to "the request ids are the candidates' positions and no candidate
      id appears in the request", which is stricter; the PR description calls the rewrite
      out, as Q76 and Q77 did for theirs. Three catalog integration tests contradict Q119
      the same way and are **rewritten** too (Resolved decision Q130, which extends Q125),
      not loosened, and the catalog's `002` redaction fixture they use keeps its logic and
      has only its header comment corrected:
      `packages/catalog/src/service/__fixtures__/redaction-authz.ts` records each
      request's `resource.id` and answers `readable.has(resource.id)` (`:50`, `:57`), so
      it keeps answering by the `resource.id` it receives, which for the redaction batch
      is now a position, and the tests pass it the readable positions together with the
      identifiers of single-resource checks that keep theirs (in
      `entities-delete.int.test.ts`, `team-a`, the deleted entity's own check: the
      fixture answers every batch whose resources are all `catalog_entity` (`:43-58`),
      an entity operation's own check of `pipeline.ts` included, so the readable sets of `:646`
      and `:670` keep `team-a` beside the positions; `readable.has(resource.id)` already
      works with such a mixed set, and the fixture's answering logic is unchanged; its
      only edit is its header comment (`:6-10`), which must say that every batch whose
      resources are all `catalog_entity` is answered from `readable` by the `resource.id`
      it receives: by identifier (the fixed placeholder for a `_user` entity, Q119)
      for an entity operation's own check (`pipeline.ts:372`) and for
      `mayUpdateReferrer`'s check (`entities.ts:884`), by position for the
      redaction batch, while a blueprint operation's own check (`catalog_blueprint`)
      still reaches the real policies). The readable positions are
      deterministic only where the candidates come in a known order:
      `selectSpecReferrers` orders referrers by identifier
      (`packages/catalog/src/persistence/entities-repository.ts:409-424`) for
      `entities-delete.int.test.ts`, and `selectBlueprintEntityIdentifiers` orders them by
      identifier (`packages/catalog/src/persistence/blueprints-repository.ts:214`) for
      `blueprints.int.test.ts`. `blueprints-update.int.test.ts` seeds through `seedEntity`,
      whose row ids are `randomUUID()`
      (`packages/catalog/src/service/__fixtures__/blueprint-test-helpers.ts:195`), and the
      compatibility check streams entities `order by id` (`streamBlueprintEntities`,
      `blueprints-repository.ts:334-340` and `:406`), an order `checkCompatibility` keeps
      (`packages/catalog/src/domain/compatibility.ts:141-153`), so hard-coded positions
      would be flaky: that test derives the readable positions from the seeded rows read
      back in `id` order (the stream order), and no helper or production code changes
      (Resolved decision Q130); and each `batches[].ids` assertion of
      `entities-delete.int.test.ts` (`:659`, `:683`), `blueprints.int.test.ts` (`:521`)
      and `blueprints-update.int.test.ts` (`:321`), all in `packages/catalog/src/service/`,
      changes from "the batch ids equal the candidate identifiers" to "the ids are
      positions and no candidate identifier is in the request", which is stricter, while
      their `referrers`, `notVisible` and no-leak assertions stay as they are; the PR
      description calls out these rewrites with the one above, and the three tests pass
      after them. `redaction.int.test.ts` stays
      green; `docs-telemetry.test.ts` stays green and `docs/catalog/catalog-core.md`
      names the placeholder for the span attribute, the audit event and the Cerbos
      resource id, and the positional ids of the referrer redaction.
- [x] 4.1e The adapter of 4.1 audits every status change (Resolved decision Q117; design
      D2, Observability contract). After each write that changes a status, a row created
      with its first status included, it emits `catalog.audit.user_status_changed`
      (declared in 15.1) through the helpers of 2.0c, and it emits nothing for a write
      that leaves the status as it was (a redundant event of 4.1, or `created_invited` for
      an `Invited` row) or that fails. The event carries `tayzu.tenant.id`,
      `tayzu.identity.user.status.from` (absent for a new row),
      `tayzu.identity.user.status.to`, the derived `StatusEvent` as
      `tayzu.identity.user.status.event`, `tayzu.identity.user.account_kind`, the subject
      from the port input of 4.1 (its `userId` as `tayzu.identity.user.id`, or as
      `tayzu.identity.service_account.id` for a service
      account, or, for the `created_invited` write of the invitation hook, which knows the
      invitation and not a Better Auth user, its `invitationId` as
      `tayzu.identity.invitation.id`, Resolved decision Q126) and the
      principal that the writer hands the adapter with its kind: an admin, the user of a
      first sign-in or the invitee of an acceptance as `tayzu.actor.id`, the operator as
      `tayzu.identity.operator.id` in its place, or none (the ban hook), which emits
      neither attribute. Which principal each writer hands over is that writer's own
      task's case (4.2b, 4.3, 4.4, 4.5, 4.6b, 7.3, 8.1e, 10.3, 11.2 and 11.5). Verify:
      `user-sync.int.test.ts` (in `apps/api`) covers, under an in-memory log exporter,
      one event per status-changing write with its `from`, `to` and status event, a
      created row's event carrying no `from`, a redundant event and a failed write
      emitting none, each principal kind mapping to its attribute (an admin and a user to
      `tayzu.actor.id`, an operator to `tayzu.identity.operator.id` with no
      `tayzu.actor.id`, no principal to neither), a service account carrying
      `tayzu.identity.service_account.id`, a `created_invited` write whose input carries
      an `invitationId` and no `userId` naming that id as `tayzu.identity.invitation.id`
      with no `tayzu.identity.user.id`, an input's `userId` becoming
      `tayzu.identity.user.id` (the membership hook's, the ban hook's and the first
      sign-in's are cases of 4.2, 4.5 and 4.4), and no email in any attribute.
- [x] 4.2 `afterAddMember` is the **single writer** for a membership (Resolved
      decisions Q11 and Q76, design D2), except for the acceptance's own member (the
      `(tenantId, userId)` that the acceptance's shared context carries, Resolved
      decision Q120), for whom it makes no `_user` write and the acceptance's own `_user`
      step writes it after the shed (Resolved decision Q112; 8.1e and 8.5h build that
      context, the order and the hook's shed, which runs before its `_user` write); for
      any other membership added inside that context it writes, and sheds, as outside it
      (Q120; 8.1e and 8.5h test it). It cannot read the status (the port has
      only `upsertUser`), so it passes the intent `membership_added` and the adapter
      of 4.1 derives the event from the current status: none gives `created_active`,
      `Invited` or `Staged` gives `invitation_accepted`, `Active` is no write and
      `Disabled` is no write, so adding a membership never revives a `Disabled` user
      and never throws on a second write. For a member whose Better Auth user is
      `banned` and who has no row, the adapter writes `created_active` and then
      `admin_disable`, keeping the `Disabled` it writes for a banned member today
      (Resolved decision Q62). The hook passes as the port's `userId` the Better Auth id
      of `afterAddMember`'s `user` (4.1), and the acceptance's entry point of 4.1, which
      the acceptance's `_user` step calls with the same intent (8.1e), returns the event
      that this derivation wrote, or none. Verify: `auth-hooks.int.test.ts` covers "A disabled
      user is not revived by a hook" and one case per current status (none,
      `Invited`, `Staged`, `Active`, `Disabled`), asserting the event written or the
      absence of a write, a banned member with no row ending `Disabled`, and, under an
      in-memory log exporter, a membership added through an `auth` built with the adapter
      naming its user's Better Auth id from `afterAddMember`'s `user` as
      `tayzu.identity.user.id` (4.1e); and `user-sync.int.test.ts` (in `apps/api`) covers
      the acceptance's entry point, given the `membership_added` intent, returning
      `invitation_accepted` for an `Invited` row it activates, `created_active` for a
      missing row it creates and no status event for an `Active` row it leaves as it is.
- [x] 4.1b `createApp` builds the adapter of 4.1 and passes it to `createAuth` as
      `userSync` (today it passes none, so every status hook is a no-op in the running
      app). It runs after 4.2, whose derivation of the `membership_added` intent the
      wiring test exercises (tasks header). Verify: `user-sync-wiring.int.test.ts` boots
      `createApp` and covers a membership added through Better Auth writing the `_user`
      entity through the state machine.
- [x] 4.2b A repeatable `_user` reconcile script
      (`apps/api/scripts/reconcile-users.ts`, `pnpm --filter @tayzu/api
      identity:reconcile-users`, started through the helper of 2.0; Resolved
      decision Q50) creates the `_user` entity of every existing member that has
      none, through the Q30 adapter and the `membership_added` intent of 4.2 (so
      `created_active`, with the input `afterAddMember` builds), and leaves an
      existing row untouched. For a member whose Better Auth user is `banned` it
      follows `created_active` with `admin_disable`, so the row is `Disabled` and a
      banned user is never revived as `Active` (Resolved decision Q62). Before it
      creates the `_user` of a member whose user holds two or more memberships it runs
      the shed of 8.5h, which 8.5l adds to this script once the shed exists (Resolved
      decision Q105); it calls the shed core directly on its `tayzu_auth` pool, so it
      builds no Better Auth instance and holds no `BETTER_AUTH_SECRET` (Resolved decision
      Q114). It also
      removes an **orphan**: a human `_user` with status `Active`, no `member` row in
      its tenant and an `updatedAt` **more than one hour old** (its activation; not its
      `createdAt`, Resolved decision Q124, which amends Q84 and Q89), which is what a failed
      acceptance leaves behind, because its `_user` write is on another pool and no
      transaction spans the two (Resolved decisions Q84 and Q89; `Invited` and
      `Staged` rows and service accounts are never orphans). The grace period keeps the
      reconcile from deleting the row of a member whose acceptance is in flight or about
      to be retried, because the `_user` write and the membership are on two pools with no
      transaction spanning them (since Q112 the acceptance writes the `_user` after the
      membership and the shed, 8.1e); it runs from the activation because on the
      new-account path the row was created `Invited` when the invitation was made (7.3),
      possibly more than an hour before the acceptance. The removal is a `system`
      write with `onBehalfOf` the operator (Q84), made with `detachReferences` because a
      relation that targets the `_user` is a `RESTRICT` foreign key
      (`catalog_entity_relation_target_fk`) that would otherwise fail it. It lists organizations and members
      through the `tayzu_auth` pool and writes through `tayzu_app`, as its own
      Container Apps Job (Resolved decision Q49), and declares those two roles for 2.0.
      It reaches Cerbos at `CERBOS_ADDRESS` (2.0b): its `_user` writes go through the
      adapter of 4.1, which needs Cerbos (4.6b), and its orphan removal through the
      catalog's operation pipeline, which asks Cerbos for the `system` actor too; in
      production that is the job's own Cerbos sidecar (design D9). Its change events carry the
      operator id as `onBehalfOf`, taken from the job's environment as
      `TAYZU_OPERATOR_ID` through `script-config.ts` (2.0b; design D9: an opaque id
      validated against the catalog's id pattern `[A-Za-z0-9_.:-]{1,128}`, never an
      email, recorded with the named second approver; `045`'s workflow later sets the
      same variable to `gh:<numeric actor id>`, actor type `user`, Q70), and the script
      refuses to run without it. Each of its status writes emits
      `catalog.audit.user_status_changed` through the adapter (4.1e) with the operator's
      `tayzu.identity.operator.id` in place of `tayzu.actor.id` (Resolved decision Q117).
      It emits the span
      `identity.user.reconcile` and the audit event `catalog.audit.users_reconciled`
      per tenant, with the number of rows created and of orphans removed (declared
      in 15.1). In production it runs as an operator-started job (design D9), before
      the release that carries the `user_missing` rejection (11.8) serves traffic in
      an environment that has members and before the mount switch is turned on
      (design D15, Migration Plan). It is also the repair path for a member rejected
      with `user_missing` (11.8), such as one that predates `043` or whose `_user`
      row was removed by hand (an acceptance never leaves one: its `_user` step
      fails closed, 8.2). Verify: `reconcile-users.int.test.ts` (in
      `apps/api/src/identity/`, importing the script) covers "The reconcile repairs
      a member and is repeatable": two tenants seeded with a member that has no
      `_user` row and a member that has an `Active` one, the first run creating the
      missing row as `Active` with `onBehalfOf` the operator and leaving the other
      untouched, the second run changing nothing, the repaired member being accepted
      by `resolveContext`, the created row's `catalog.audit.user_status_changed` carrying
      the operator id as `tayzu.identity.operator.id`, the status event `created_active`
      and no `tayzu.actor.id`, and the script refusing to run with no operator id; "The
      reconcile does not revive a banned user": a banned member with no row ends
      `Disabled`, not `Active`, with both writes attributed to the operator and two
      status events (`created_active`, then `admin_disable`), each carrying the operator
      id; and
      "The reconcile removes an orphan": an `Active` human `_user` with no member whose
      `updatedAt` is older than the grace period is removed (also when a relation targets
      it), one updated within the grace period, an `Invited` one, a `Staged` one and a
      service account are kept, and the removal is attributed to the operator; a failed
      new-account acceptance of an invitation older than one hour (an `Active` row with no
      member whose `createdAt` is more than an hour old and whose `updatedAt`, its
      activation, is within the hour, seeded directly) is not deleted while it is within
      one hour of its activation, and is removed by a run made after that hour (a clock
      seam); and a run whose
      `CERBOS_ADDRESS` is unreachable creating and removing no `_user` row (the pipeline
      fails closed).
- [x] 4.3 `identity.users.create` performs **no** `_user` write of its own: the hook
      of 4.2 writes it (today the operation writes twice, through the hook and
      through an explicit upsert, and the second write would throw because
      `created_active` is allowed only from none). The operation hands the acting
      admin to the hook through an `AsyncLocalStorage` (`node:async_hooks`, no
      dependency) that it runs around its in-process `auth.api` call, because
      `afterAddMember` receives only `{ member, user, organization }`, so the change
      event carries `onBehalfOf`, and the hook's write emits
      `catalog.audit.user_status_changed` (4.1e) with the admin as `tayzu.actor.id`
      (Resolved decision Q117). The `userSync` option of `createIdentityRouter` is
      removed, since nothing writes through it any more (Resolved decision Q76).
      Verify: `identity-router.int.test.ts` covers "A user created by an admin is
      active" with exactly one `_user` write, status `Active`, the change event
      carrying the admin as `onBehalfOf` and one `catalog.audit.user_status_changed`
      with the admin as `tayzu.actor.id` and the status event `created_active`, and `createIdentityRouter` no longer
      accepting a `userSync` (a `@ts-expect-error` case).
- [x] 4.4 A first-sign-in hook writes `first_sign_in`, through the adapter of 4.1, **only
      for a user who holds exactly one membership**, to that membership's `_user`: a
      `Staged` or `Invited` user becomes `Active`, and a `Disabled` user stays `Disabled`.
      For a user of two or more memberships it writes nothing (Resolved decision Q111;
      design D2): a second tenant's `Invited` or `Staged` row is what a failed acceptance
      whose compensation also failed leaves, and activating it on a sign-in would admit
      the member without the shed of 8.5h, so the resolver keeps rejecting it (11.8). Its
      repair is a retry of the same invitation within 48 hours, which sheds on every
      attempt, or the operator repair of 16.5. The hook hands the adapter the user's own
      Better Auth user id as the principal of its write (the `onBehalfOf` of the change
      event, actor type `user`), so its `catalog.audit.user_status_changed` names the user
      as `tayzu.actor.id`, with the status event `first_sign_in` (Resolved decision Q117,
      4.1e). Verify:
      `first-sign-in.int.test.ts` covers "First sign-in activates a staged or
      invited user" (a user whose only membership has a `Staged` `_user`, and one whose
      only membership has an `Invited` one, each ending `Active` through the state
      machine, with the change event's `onBehalfOf` and the status event's
      `tayzu.actor.id` both the user's own id, the status event `first_sign_in` and the
      hook's port input carrying that id as `userId`, so the event's
      `tayzu.identity.user.id` is it too) and "First sign-in does not activate a second tenant's `_user`": a user
      who belongs to `t1`, where the `_user` is `Active`, and to `t2`, where the `_user`
      is `Invited` (seeded directly, as a failed acceptance whose compensation failed
      leaves it), signs in locally, both rows are unchanged and no status write or status
      event happens, and the same holds for a `Staged` row in `t2`; and (Resolved
      decision Q133) a member whose single membership has no `_user` row signs in
      locally with no row created, no status write and no status event, while the
      display-refresh test of 4.1c gains a second membership in its setup so that it
      isolates the refresh again, its assertions unchanged.
- [x] 4.5 The ban hook (`databaseHooks.user.update.after` in `auth.ts`) writes through
      the state machine instead of `Disabled`/`Active` directly, and **only ever
      disables** (Resolved decision Q102; design D2). It fires on every `user.update`
      that carries a boolean `banned` and runs with an endpoint context (for example
      `/two-factor/verify-totp`, which is allowlisted), and it receives the new row, with
      its `id`, but not the old row, so it cannot tell an unban from any other update. It
      writes `admin_disable` to the `_user` of every membership of the user only when
      `banned === true`, and the adapter treats that redundant event for a `Disabled`
      user as a no-op (4.1). It **never writes `admin_enable`**: an update with
      `banned: false` writes nothing, because an `admin_enable` for every membership
      would re-enable a user whom `setStatus` disabled in one tenant only; re-enabling
      goes through `setStatus` only (11.2). It is skipped without an endpoint context.
      It has no principal of its own, so each of its writes emits
      `catalog.audit.user_status_changed` (4.1e) with the status event `admin_disable` and
      neither `tayzu.actor.id` nor `tayzu.identity.operator.id` (Resolved decision Q117).
      Verify: `ban-hook.int.test.ts` covers "The ban hook never re-enables a user":
      banning sets `Disabled` on every membership, each write emitting one
      `catalog.audit.user_status_changed` with `admin_disable`, the banned user's id (the
      hook's `userId`, from `SyncUserRow.id`) as `tayzu.identity.user.id` and no actor
      attribute, a
      repeated `banned: true` for a `Disabled` user is a no-op and emits none, an update with `banned: false` (an unban included)
      writes nothing and leaves every status as it was, enrolling a second factor for an
      `Active` user does not throw and leaves the status `Active`, and a user who belongs
      to `t1` and `t2`, `Disabled` in `t1` only (written through the adapter with
      `admin_disable`, as `setStatus` of 11.2 does, and not banned), who enrols TOTP from
      a session of `t2` stays `Disabled` in `t1` and `Active` in `t2`. `002`'s test
      "banning sets Disabled, unbanning sets Active again" (`user-sync.int.test.ts:177`)
      contradicts Q102 and is **rewritten** (Resolved decision Q134), not loosened: after
      the unban the status stays `Disabled` and nothing is written; the PR calls it out.
- [x] 4.6 `bootstrapAdmin()` moves out of the script file into
      `packages/auth/src/bootstrap-admin.ts` and the package index (design D2):
      today it shares `packages/auth/scripts/bootstrap-admin.ts` with the CLI
      `main()`, and `bootstrap.int.test.ts`, `user-sync.int.test.ts`,
      `scripts/ci/zap-seed.ts` and `zap-seed.test.ts` import it from there, so those
      imports are updated. It does **not** write the admin's `_user` itself: the
      membership hook is the single writer (design D2, Resolved decision Q76),
      because `createOrganization` fires `afterAddMember` for the owner whenever
      `userSync` is passed to `createAuth`, and a second write would throw
      (`created_active` is allowed only from none). The `userSync` option of
      `BootstrapAdminOptions` is removed. It emits `catalog.audit.user_created` with
      source `bootstrap` (declared in 13.3), carrying the operator's opaque id, which
      `BootstrapAdminOptions` gains as a required option, as `tayzu.identity.operator.id`
      in place of `tayzu.actor.id` (Resolved decision Q116; the CLI of 4.6b supplies the
      id and also hands it to the hook's `_user` write), and the callers that import it
      (`bootstrap.int.test.ts`, `user-sync.int.test.ts`, `scripts/ci/zap-seed.ts` and
      `zap-seed.test.ts`) pass a fixed operator id of the catalog's id shape. It applies
      the password policy of 8.1 and the forced change
      of 13.5 once those exist (8.1b and 13.5b test them on the bootstrap; they run
      later). Verify: `bootstrap.int.test.ts` (in
      `packages/auth/src/`, the existing test) covers that `bootstrapAdmin()`, run
      against an `auth` built with a recording `UserSyncPort`, yields exactly one
      `created_active` write for the admin and no second write, and emits the audit
      event with source `bootstrap`, `tayzu.identity.operator.id` the operator id it was
      given and no `tayzu.actor.id`, a call without an operator id not type-checking (a
      `@ts-expect-error` case); and `user-sync.int.test.ts` (in
      `apps/api/src/`) is **rewritten** (Resolved decision Q76): its two
      direct-write cases (`002` task 18.5) built `auth` without `userSync` and
      asserted an explicit write by `identity.users.create` and by
      `bootstrapAdmin()`, and they now build `auth` with `userSync` and assert the
      hook's single write. Its first `describe` (the `createUserSync` at the top of the
      file and its `bootstrapAdmin` calls) and `sso-jit-refresh.int.test.ts` (around
      line 179) pass the catalog `createUserSync` too and migrate to the adapter of 4.1. The PR description calls out that this reverses `002`
      task 18.5.
- [x] 4.6b The bootstrap CLI (`main()` and the `bootstrap:admin` package script,
      today in `packages/auth/scripts/bootstrap-admin.ts`) moves to
      `apps/api/scripts/bootstrap-admin.ts` (Resolved decision Q51), because
      `@tayzu/auth` depends only on `@tayzu/db` and `@tayzu/observability` and
      cannot import the adapter of 4.1. Today `main()` builds Better Auth on one
      `DATABASE_URL` pool with no `AUTH_DATABASE_URL` and no Cerbos, while the
      adapter needs a `tayzu_app` pool and Cerbos: the CLI builds Better Auth the
      way `createApp` does (the `tayzu_auth` pool, the `tayzu_app` pool and Cerbos)
      and passes the adapter as `userSync`, so the hook writes the `_user` (4.6;
      `002` left this as a follow-up). It therefore needs `DATABASE_URL` (the
      `tayzu_app` pool), `AUTH_DATABASE_URL`, `CERBOS_ADDRESS` and the allowed
      origins, and it starts through the helper of 2.0 and declares the roles
      `tayzu_auth` (the `AUTH_DATABASE_URL` pool) and `tayzu_app` (the `DATABASE_URL`
      pool) for its role assertion. It also requires the operator's
      opaque id (Resolved decision Q116; design D9), read through `script-config.ts`
      (2.0b) under the same name as the reconcile's, `TAYZU_OPERATOR_ID`, and validated
      against the same id pattern (`[A-Za-z0-9_.:-]{1,128}`, never an email), and refuses to run without
      it or with a malformed one; it runs `bootstrapAdmin()` with that id as the option of
      4.6 and as the principal (kind operator) in the store of 4.3, so the adapter writes
      the bootstrap admin's `_user` with the operator id as `onBehalfOf` (actor type
      `user`) and its `catalog.audit.user_status_changed` carries it as
      `tayzu.identity.operator.id` (4.1e, Resolved decision Q117). The `bootstrap:admin`
      package script moves to `apps/api/package.json`, and `packages/auth` no longer
      contains the script or its package script. The CI seed follows the new
      location: `scripts/ci/zap-seed.ts` (its `ZapSeedConfig` and the command that
      runs `pnpm --filter @tayzu/auth exec tsx <script>` today) runs the moved
      script through `@tayzu/api` with those variables, and `scripts/ci/dast.sh`
      (which runs the seed with `DATABASE_URL=$AUTH_DATABASE_URL` today) passes the
      `tayzu_app` `DATABASE_URL` and `AUTH_DATABASE_URL` separately, with the Cerbos
      address, the origins and a fixed CI operator id as `TAYZU_OPERATOR_ID`. The seed's `--refresh` call (`dast.sh` runs `zap-seed.ts --refresh` with
      `DATABASE_URL=unused`, through `parseZapSeedConfig`) only refreshes tokens, so the
      new variables are required **for the seed run only**: `parseZapSeedConfig`
      requires them per mode, and `--refresh` keeps parsing with `DATABASE_URL=unused`,
      or `api-scan` would break. `dast.sh` also exports `EMAIL_PROVIDER=none` (6.5,
      Resolved decision Q96; 6.7b adds `IDENTITY_TOKEN_HMAC_SECRET` and
      `INVITATION_LINK_BASE_URL`, because `dast.sh` sets no `NODE_ENV`). The CLI itself is run by an operator out of band, as `002`
      designed it, and is not one of the scripts that `045`'s maintenance workflow starts
      (Resolved decision Q91); `docs/security/secrets.md` (16.8) records how. Two parts
      of the seed need code that later tasks build, so they are those tasks' cases: the
      breached-password stub that `dast.sh` loads for the bootstrap child and the API
      server is 8.1a's (Resolved decision Q71), and the seed's password, which satisfies
      the policy of 8.1 through the generator of 13.5b and honors the forced change of
      13.5, is 13.5b's. Verify:
      `bootstrap-admin.int.test.ts` (in `apps/api/src/`, importing
      `../scripts/bootstrap-admin.js`) runs `main()` and covers that the bootstrap
      `_user` exists, is `Active` through the state machine and was written once, with
      the operator id as the change event's `onBehalfOf` and both
      `catalog.audit.user_created` (source `bootstrap`) and
      `catalog.audit.user_status_changed` carrying it as `tayzu.identity.operator.id` and
      no `tayzu.actor.id`, that a run with no operator id, or with an email as the
      operator id, is refused before any write, that a run whose pool connects as a role
      it did not declare is refused before any write, and that `packages/auth` contains
      neither the script nor its package script;
      `zap-seed.test.ts` covers the seed using the moved CLI, its four variables and the
      operator id,
      and `--refresh` still parsing with `DATABASE_URL=unused`
      and none of the new variables; and `dast-script.test.ts` (in `apps/api/src/`,
      reading `scripts/ci/dast.sh` as text, like `zap-seed.test.ts`) covers the seed
      receiving distinct `DATABASE_URL` and `AUTH_DATABASE_URL`, and
      `EMAIL_PROVIDER=none` being exported.

## 5. Cerbos foundations, ⛔ Checkpoint 3

- [x] 5.1 `RESOURCE_KINDS` gains `service_account` and
      `credential`, and the Cerbos attributes are built from a resolved target
      (`assertMayOnUser` in `apps/api/src/identity-router.ts` is today `'create' |
'update'` with empty attributes, and is replaced by the wrapper of 5.3b):
      `accountKind`, `portRole`, `moderatedBlueprints` and the target's **real
      tenant** (an invitation's `organizationId`, an API key's `referenceId`, the
      user's membership), never `ctx.tenantId` echoed back. The Cerbos resource id is
      the Better Auth user id for a human (the `svc-…` identifier for a service
      account, Resolved decision Q90), never the email. The resource id of every operation is opaque and
      fixed: the literal `new` for `invite`, `users.create`, `serviceAccounts.create`
      and `credentials.create` (no resource exists yet), the invitation id for cancel
      and resend, the Better Auth user id (or the `svc-…` identifier of a service
      account) for `setStatus`, `serviceAccounts.delete` and the SSO link and unlink,
      the `apikey` id for rotate and revoke, and the literal `list` for
      `credentials.list` (it has no target) (`045` adds the tenant id for
      `organization.delete`). Verify: `identity-attributes.test.ts` covers that the
      attributes carry the target's tenant and the three attributes and that the
      resource id is the opaque id for an email-addressed target, that a `service_account` resource carries the resolved `accountKind` (and `service` for a create), a `_user` read without `accountKind` being sent as `standard` (through the reader of 2.3), the resource id of every operation being the one named above, and
      `resource-kinds.test.ts` that the kinds exist.
- [x] 5.1b `apps/api/src/identity/auth-repository.ts` (Resolved decision Q69; design
      D14) is the only module through which the identity code reads `apikey`,
      `invitation`, `member`, `session`, `user` and `account`. Every function that
      reads a tenant-keyed model **requires a `tenantId`** and filters by it
      (`referenceId` for `apikey`, `organizationId` for `invitation` and `member`,
      `activeOrganizationId` for `session`), because the `auth` schema has no
      row-level security and the tenant filter would otherwise be repeated by hand
      in at least eight readers. `user` and `account` hold no tenant: their
      functions take a user id, an email or an account's provider key, are named
      `global…` (for example `globalUserByEmail`) and exist only for reads that are
      global by nature, and a target that must belong to the tenant is read through a
      membership check (`userInTenant`, which reads `member`). Among them are the two
      `account` reads of the existing link procedures, which call the internal adapter
      in `identity-router.ts` today: `globalAccountByKey(providerId, accountId)` replaces
      `findAccountByKey` in the "`sub` already linked" check of `linkSsoAccount`, and
      `globalAccountsOf(userId)` replaces `findAccounts` in `unlinkSsoAccount`, which takes
      the SSO accounts from that list and checks that the user keeps a sign-in method
      (`wouldLeaveNoSignInMethod`). Two reads of tenant-keyed models are global
      by nature and are the only `global…` functions on those models:
      `globalInvitationById(invitationId)`, used only by the public accept route (8.4),
      which does not know the tenant before it reads the record and then derives the
      tenant from the record's `organizationId`; and `globalMembershipTenantsOf(userId)`,
      which returns tenant ids only and serves the checks that look at a user's
      memberships in every tenant (the other-tenant refusal of `linkSsoAccount` and
      `unlinkSsoAccount`, 13.2 and 8.5i, the single-membership test of the disable, 11.2
      and 11.2b, and the `target_in_other_tenant` cause of `identity.users.create`,
      13.3). The module offers a paged key listing that reaches the end (9.2),
      a key lookup by id, an invitation lookup by id within a tenant, a member listing,
      a membership lookup and the session reads of the disable operation, returns plain
      read shapes and never selects the hashed `key` column. It also holds two
      tenant-keyed writes. The write the acceptance's compensations need (8.1e, Resolved
      decision Q105 part 1) is a **tenant-keyed `member` delete** that requires a
      `tenantId`, filters by `organizationId` and deletes only the membership row it is
      given, because Better Auth's `removeMember` needs a session and both compensations
      run without one. The revocation of the tenant-scoped disable (11.2, design D13) is a
      **tenant-keyed `session` delete** that requires a `tenantId` and filters by
      `activeOrganizationId` and the user id, so it never reaches the user's sessions of
      another tenant. A third tenant-keyed write, the acceptance's **`invitation` status
      write** (Resolved decision Q123), is added to the module by 8.3, which tests it. The
      accesses that stay outside the module by nature are its only exceptions, each
      acting on one user id that the caller has already resolved in its tenant (or, for
      the new-account compensation, has just created): Better Auth's
      **internal-adapter calls on that user**, which name no model, namely the
      **per-user, cross-tenant session operations** (every session of a user, whatever
      its active organization) of the admin unlink (8.5j) and of the single-membership
      disable (11.2) (`listSessions`, `deleteUserSessions`), `updateUser` for the ban and
      the unban of 11.2 and for the acceptance's `emailVerified` write (8.2, 8.5b), the
      new-account compensation's deletion of the user it created (8.1e), and the account
      link of `linkSsoAccount` and the account deletion of the admin unlink (the two
      procedures read `account` only through `globalAccountByKey` and
      `globalAccountsOf`); and the
      **shed core** of 8.5h, whose parameterized SQL on the `tayzu_auth` pool reads and
      deletes inside the `withUserLock` transaction (Resolved decision Q114), and writes,
      reads and deletes the acceptance's `invitation-shed:<invitationId>` record (8.5m). The
      maintenance scripts under `apps/api/scripts/` are not identity code and not
      clients of the module: the backfill (2.2) lists `auth.organization`, and the
      reconcile (4.2b) lists organizations and members and reads `user.banned`, directly
      on their `tayzu_auth` pool, because enumerating every tenant is cross-tenant by
      nature and the reconcile builds no Better Auth instance. Verify:
      `auth-repository.int.test.ts` covers each tenant-keyed function returning only
      the rows of the tenant it is given, with a second tenant's rows seeded to
      match on every other field, a missing or empty `tenantId` throwing, a
      `@ts-expect-error` case showing that a call without a `tenantId` does not
      type-check, a `session` read filtered by `activeOrganizationId`, the `member`
      delete removing the membership of the tenant it is given and leaving the same
      user's membership of a second tenant in place, the `session` delete removing only
      the sessions of the tenant it is given (a session of the same user whose active
      organization is a second tenant surviving), `globalInvitationById` returning an
      invitation of any tenant with its `organizationId`, `globalMembershipTenantsOf`
      returning the tenant ids of every membership of the user and nothing else of
      them, `globalAccountByKey` returning the account of a provider key whatever the
      tenants of its user and nothing for an unknown key, `globalAccountsOf` returning
      every account of the user and none of another user's, and the global functions
      (the `user` and `account` readers, `globalAccountByKey` and `globalAccountsOf`
      among them, `globalInvitationById` and `globalMembershipTenantsOf`) being the only
      ones without a `tenantId`; and the existing `account-linking.int.test.ts` (in
      `apps/api/src/`) staying green, with its "sub already linked" and "only sign-in
      method" cases now served by the two readers.
- [x] 5.1c A lint rule bans direct adapter access to the `apikey`, `invitation`,
      `member`, `session`, `user` and `account` models from
      `apps/api/src/identity/**` and from `apps/api/src/identity-router.ts` (whose
      `authorizeTarget` reads `member` today, outside the `identity/` folder)
      outside `auth-repository.ts` (Resolved decision Q69; the maintenance scripts under
      `apps/api/scripts/` are outside that file scope, 5.1b): a `no-restricted-syntax`
      selector on adapter calls whose model is one of the six (the internal-adapter
      calls that 5.1b names take a user id and name no model), a selector on the
      internal adapter's `account` reads (its `findAccount…` calls, among them
      `findAccountByKey` and `findAccounts`, which name no model either and which 5.1b's
      `globalAccountByKey` and `globalAccountsOf` replace), and a restriction on
      importing the adapter factory there. The block is added to `eslint.config.js`
      by **spreading** the existing `no-restricted-syntax` selectors (the `sql.raw`
      and `actor.type` bans, lines 91 and 97 of `eslint.config.js`), because a later
      flat-config block replaces the array and would silently drop them.
      `eslint.config.js` has no `no-restricted-imports` entry yet, and this task and 9.1c
      would both add one for `identity-router.ts`, which both match: the later block
      would replace the earlier. So the selectors and the import restrictions of both
      tasks live in **one module** (`eslint/identity-restrictions.js`) that the config
      imports and that merges them per file set, and 9.1c adds its restriction to that
      module instead of a block of its own. Verify: `auth-repository-lint.test.ts` (in
      `apps/api/src/identity/`) lints scratch sources with ESLint's `ESLint#lintText`
      (no `Linter` is used anywhere in the repository yet, and `eslint` is a root
      devDependency that `apps/api` resolves from the root, so no dependency is added)
      with a `filePath` under the scoped folder, over the restriction module of this
      task (typed rules need `projectService` and a real file in the TypeScript project,
      and the restrictions under test are not typed rules, so the test turns the typed
      rules off), and covers a direct `apikey` read in
      `credentials.ts` failing, a direct `member` read in `identity-router.ts`
      failing, the same read inside `auth-repository.ts` passing, a read of another
      model passing, internal-adapter `deleteUserSessions` and `updateUser` calls
      (exceptions that 5.1b names) passing, internal-adapter `findAccountByKey` and
      `findAccounts` calls in `identity-router.ts` failing and the same calls inside
      `auth-repository.ts` passing, the `sql.raw` and `actor.type` bans still firing on a scratch
      source inside the scoped paths, and `pnpm lint` staying green on the real
      tree.
- [x] 5.2 Every target of an `identity.*` operation is resolved on the server by
      one helper (which reads `apikey`, `invitation` and `member` only through the repository of 5.1b), and a target of another tenant answers `CATALOG_NOT_FOUND`,
      identical to a nonexistent id; `tenantId` and `actor` are never read from
      input. Verify: `identity-target.int.test.ts` covers a foreign and an unknown
      invitation, credential and user answering the same, and a body with a
      `tenantId` field being rejected.
- [x] 5.3 The identity router emits `catalog.security.authz_denied` on every Cerbos
      deny (it threw silently before) and records every decision on
      `tayzu.authz.decisions` (the catalog's counter takes allow and deny through
      its `decision` attribute, `pipeline.ts`), through a helper exported by
      `@tayzu/catalog`, which already owns both (`pipeline.ts`,
      `telemetry/instruments.ts`) and which `apps/api` depends on, so no duplicate
      instrument appears under the `@tayzu/auth` scope. Verify:
      `identity-router.int.test.ts` covers that a denied call logs the event and
      records one `deny` decision and an allowed call one `allow`, with no email or
      identifier of the target.
- [x] 5.3b `defineIdentityOperation({ authorization: { kind, action,
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
      checks the brand or a registry). `002`'s test "The Cerbos check uses the target
      user's real tenant, and a principal of another tenant is denied"
      (`account-linking.int.test.ts:389`) is **rewritten** to 5.2 (Resolved decision
      Q135), not loosened: the cross-tenant attempt answers `CATALOG_NOT_FOUND` and no
      Cerbos request carries a resource of the other tenant; the PR calls it out.
- [x] 5.3b2 The wrapper checks the **caller's role in the caller's own tenant
      first**, with no target (Resolved decision Q57; `002`'s `assertMayOnUser` did),
      then resolves the target, then re-checks with the target's real tenant. For the
      `service_account` kind the first check carries `accountKind: service`, because
      that kind's policy denies every action on any other value (10.2) and an admin would
      otherwise be denied at this step on every service-account route. Verify:
      `define-identity-operation-order.test.ts` covers "An unauthorized caller cannot
      tell a target from a missing one": a caller without the grant gets the same
      `AUTH_FORBIDDEN` for a same-tenant target and for an unknown one, with the
      target resolver never called, and an authorized caller still gets
      `CATALOG_NOT_FOUND` for the unknown one; "An unauthorized caller gets no parse
      error": a caller without the grant sending a malformed body, a body with an
      undeclared field and a valid body gets the same `AUTH_FORBIDDEN` each time, with
      the procedure's input parser (today's `parseInput`, the shared parser of 5.3d once
      it replaces it) never called; and a recording Cerbos client showing the first
      check of a `service_account` operation carrying `accountKind: service`.
- [x] 5.3b3 The wrapper fails closed (Resolved decision Q57): a Cerbos error, a
      malformed context and an empty role list each deny and never run the handler.
      Verify: `define-identity-operation-failclosed.test.ts` covers "The wrapper
      fails closed" for each of the three, with a Cerbos client that throws, a context
      with no tenant or no actor, and a principal with an empty role list, asserting
      the denial and that the handler was never called.
- [x] 5.3c The three existing procedures take the `{user}` identifier (Resolved
      decision Q31), resolved on the server to the Better Auth user, instead of a
      Better Auth `userId`, and the five existing integration test files that build
      `createIdentityRouter` with a `userId` body (`account-linking`,
      `admin-user-creation`, `link-social-step-up`, `otel-smoke-check` and `user-sync`,
      all `*.int.test.ts`) are migrated to address the target by its identifier.
      Verify: those five files, updated, pass against the new input, and
      `identity-router.int.test.ts` covers an unknown identifier and a `userId` body
      each being rejected.
- [x] 5.3d One shared input parser for the identity router
      (`apps/api/src/identity/parse-input.ts`; design D10, the root untrusted-input
      rule) replaces today's `parseInput`, which ignores unknown fields, and parses the
      `inputStructure: 'detailed'` shape (`{ params, query, body }`) of the merged
      router (D10): a null-prototype object, `__proto__`, `constructor` and `prototype` rejected at
      every depth, undeclared fields rejected, and length limits checked before any
      lookup. Verify: `parse-input.test.ts` covers each rejection at depth 1 and at
      depth 3, an undeclared field, an over-length value being refused before any
      lookup spy is called, and a clean body being parsed.
- [x] 5.4 (Checkpoint 3) Cerbos policy: `user.invite` (which also covers cancel
      and resend) and `user.updateStatus` on resource kind `user`, importing
      `002`'s `same_tenant` derived role. `user.yaml` already allows `*` to admin,
      so the new content is an `EFFECT_DENY` for `updateStatus` when `R.id == P.id`
      (`R.id` being the opaque user id, design D3). Verify: `cerbos compile` runs `policies/resource_policies/user_test.yaml` covering both actions ×
      admin/non-admin × self/non-self × same/other tenant. ⛔ **Stop for
      Checkpoint 3 approval of the policy diff before continuing.**
- [x] 5.5 (Checkpoint 3) Cerbos policy: an `EFFECT_DENY` rule on `user.yaml` for
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
- [x] 5.6 (Checkpoint 3) Role ceilings: `policies/role_policies/admin.yaml` lists
      `service_account` and `credential` (including `create`) explicitly, `member.yaml` states the ceiling if one is needed, and
      `role_policies_test.yaml` is extended. A role-policy allow does nothing
      without a resource-policy allow, and the resource policies of the two kinds
      arrive in 9.1 and 10.2, so the admin-allowed assertions are made there.
      Verify: `cerbos compile` runs
      `policies/resource_policies/role_policies_test.yaml` (the shared `testdata/`
      principals and resources gain the two new kinds) showing a member denied on
      each new kind and action and the admin ceiling accepted by the compiler. ⛔
      **Stop for Checkpoint 3 approval of the policy diff before continuing.**

## 6. Invitation email and caps

- [x] 6.1 `EmailSender` port (one `send(to, template)` over a closed union of two
      fixed templates, `InvitationEmail` and `AdminAcceptedNotice`, which `045` extends
      with `OrgDeletionNotice`; no CC, BCC or attachment field) with a recording fake,
      and a recipient validator: a single plain address, no CR/LF, no display name, no
      list separator, at most 254 characters. Verify: `email-sender.test.ts` covers
      "Injection through the invited address is impossible" for each rejected shape,
      and that the fake records `to`, link and expiry text.
- [x] 6.2 The invitation email template has a fixed subject and a fixed body,
      interpolates only the link and the expiry text, and contains exactly one
      clickable link. Verify: `invitation-email-template.test.ts` covers "The
      template carries no free text" (an organization named `<b>Pay now</b>` and a
      markup-bearing inviter name never appear) and "Invite sends exactly one email
      with exactly one link" by parsing the rendered HTML and text.
- [x] 6.3 The link origin comes from the dedicated `INVITATION_LINK_BASE_URL`
      setting (Resolved decision Q32), never from `BETTER_AUTH_URL`, `Host` or a
      forwarded header; it must be `https` outside test and one of `ALLOWED_ORIGINS`,
      and the path is fixed (`/accept-invitation`) with the invitation id and token in
      the URL fragment. Verify: `invitation-link.test.ts` covers "The link origin
      ignores the request headers" with forged `Host` and `X-Forwarded-Host`, asserts
      the id and token are after the `#`, and `config.test.ts` (in `apps/api`) covers
      an `http` value outside test and a value outside `ALLOWED_ORIGINS` failing
      startup.
- [x] 6.4 `AzureCommunicationEmailSender` (the real adapter over
      `@azure/communication-email`), constructed from the Key Vault-backed
      connection string, never called in CI, with provider errors sanitized so no
      address or message text leaves it, ACS user-engagement and click tracking
      disabled (a tracked link would be rewritten and would leak the fragment token)
      and no Reply-To. Verify: `azure-email-sender.test.ts` covers construction and
      config parsing (no network call), the payload sent to a stubbed client having
      tracking disabled and no Reply-To, and "The email provider's failure never
      leaks" with a stubbed client whose error contains the recipient; a documented
      manual smoke-check script exists for a real sandbox account outside CI.
- [x] 6.5 "Production" is `NODE_ENV !== 'test'`, as in `002` (Resolved decision Q96), so
      every deployed environment counts: startup fails there unless `EMAIL_PROVIDER` is
      set (an unset value fails closed, and `none`, the explicit non-sending sender, is
      what `dast.sh` exports because it sets no `NODE_ENV`). The provider is chosen by
      `EMAIL_PROVIDER` (`acs` or `none`) and the Communication Services
      connection string is read from `ACS_CONNECTION_STRING`, from the environment
      only, for a dedicated send-only resource (Resolved decision Q28); both are
      read by `apps/api/src/config.ts` and documented in `docs/security/secrets.md`.
      Under `NODE_ENV=test` a real sender is allowed only with a mandatory
      recipient-domain allowlist (`EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, Resolved
      decisions Q67 and Q99): startup fails when a real provider is configured under
      `NODE_ENV=test` without it, and the wrapper of 6.5b enforces the list whenever it
      is set, in any environment, a deployed staging environment included (Resolved
      decision Q99). CI, DAST and demo tenants wire a non-sending
      `EmailSender` (`none`), which discards the message and records nothing about
      it, and a demo tenant in a deployment that has a real sender is also kept off
      it by 6.5c (Resolved decision Q80). Verify: `config.test.ts` (in `apps/api`)
      covers a deployed environment (a `NODE_ENV` other than `test`) with no
      `EMAIL_PROVIDER` throwing and `none` and `acs` starting there, a real provider
      under `NODE_ENV=test` without the allowlist throwing and with it starting, the
      existing tests that load the configuration with a `NODE_ENV` other than `test`
      (`config.test.ts`, the runtime-role suite of `bootstrap-wiring.int.test.ts`, around
      line 1379, and `production-cookies.int.test.ts`, around lines 234-248) setting
      `EMAIL_PROVIDER=none` and passing, the test
      configuration selecting the recording fake and the DAST configuration
      selecting the non-sending sender, and `non-sending-sender.test.ts` that the
      non-sending sender neither retains nor logs the message, the link or the
      token.
- [x] 6.5b A wrapper around the real sender refuses a recipient whose domain is not on
      the allowlist of 6.5, wherever it is set (Resolved decisions Q67 and Q99): the
      refusal is sanitized, is
      handled exactly like a provider failure and logs
      `catalog.security.email_recipient_blocked` (declared in 15.1) with the template
      and no address. Verify: `email-allowlist.test.ts` covers a recipient on the list
      reaching the stubbed provider, one off the list never reaching it, the sanitized
      refusal and the logged event carrying no address (the domain compared after the
      canonicalization of 7.10 is 7.10's case).
- [x] 6.5c An `EMAIL_DISABLED_TENANT_IDS` list (a comma-separated list of tenant
      ids, each checked against the catalog's tenant-id pattern at startup, read by
      `apps/api/src/config.ts`; Resolved decision Q80) is honored by the one gate
      that sends invitation emails (7.3 and 7.7) and by the notice dispatcher of
      6.12. For a listed tenant the email is suppressed before any cap is consumed,
      nothing reaches the sender, the operation is not blocked, and
      `catalog.security.email_tenant_blocked` (declared in 15.1) is logged with the
      tenant and the template and no address. It is how a demo tenant, whose login
      is widely known, is kept from sending real mail in a deployment that has a
      real sender; the demo-tenant provisioning runbook lists them (16.5). The caps (6.6
      to 6.8 and 6.10), the notice template (6.11) and the dispatcher (6.12) run after
      this task, so the gate takes its cap store and its sender as ports and is tested on
      fakes; the notice case is 6.12's. Verify: `email-tenant-gate.test.ts` covers, with
      a recording fake cap store and the recording `EmailSender` fake of 6.1, a listed
      tenant's invitation email not reaching the sender and consuming no bucket of the
      fake store, an unlisted tenant's email reaching the sender, the event carrying the
      tenant and the template and no address, the gate returning normally (the operation
      is not blocked), and `config.test.ts` a malformed tenant id in the list failing
      startup.
- [x] 6.8b Every limiter of this change answers with a `Retry-After` header, as
      `002` requires (design D4). `ORPCError` carries no header and `errors.ts` has
      no `AuthRateLimitedError`, so `@tayzu/auth` gains that class with
      `retryAfterSeconds` and exports it from its index, and the three caps of 6.6,
      6.7 and 6.8, which run after this task, throw it. The error mapping of `apps/api` turns it into a 429 `AUTH_RATE_LIMITED`
      carrying the header: `errorMappingInterceptor` takes no context today and
      `toOrpcError` drops `retryAfterSeconds`, so the mapping keeps the value and
      sets the header through oRPC's `ResponseHeadersPlugin` (it ships in
      `@orpc/server`, so no new dependency, and `server.ts` registers no such plugin
      today). Verify: `error-mapping.test.ts` covers the class mapping to status
      429, code `AUTH_RATE_LIMITED` and a `Retry-After` equal to its
      `retryAfterSeconds` (the HTTP twin is in 14.5).
- [x] 6.6 A per-tenant cap of 30 invitation emails per hour, shared by invite and
      resend, on a store interface (in memory in tests), with its default in
      `apps/api/src/config.ts` following its `limitWithDefaults` pattern. Exceeding it
      fails with `AUTH_RATE_LIMITED` (the `AuthRateLimitedError` of 6.8b), sends
      nothing and logs `catalog.security.invitation_rate_limited` with scope
      `tenant`. Verify: `invitation-caps.test.ts` covers "Exceeding the per-tenant
      cap blocks further invites", asserting the `EmailSender` fake recorded no
      further call.
- [x] 6.7b The per-recipient key is an **HMAC-SHA256** of the canonical email (7.10)
      under a server secret, `IDENTITY_TOKEN_HMAC_SECRET` (Resolved decision Q93), not a
      bare sha256: an unsalted digest is a pseudonym that anyone can recompute from an
      email, and the key persists in `auth.rate_limit` (`045`'s purge exempts it and its erasure
      statement says so).
      `apps/api/src/identity/recipient-key.ts` computes it (`node:crypto`, no
      dependency), and the cap of 6.7 and the notices' own per-recipient bucket (6.12b)
      use it. The secret is read by `apps/api/src/config.ts` from the environment only,
      is required outside `NODE_ENV=test` (a deployed environment without it fails
      startup), must be at least 32 bytes, is never printed and is documented with an
      owner and a rotation procedure in `docs/security/secrets.md` (16.8; a rotation
      resets the recipient buckets, which is accepted). Because it is required outside
      test, every test that loads the configuration with a `NODE_ENV` other than `test`
      (the three of 6.5) sets a fixed 32-byte test value, and `scripts/ci/dast.sh`, which
      sets no `NODE_ENV`, generates one the way it generates `BETTER_AUTH_SECRET` and
      exports it; the same tests and `dast.sh` also set `INVITATION_LINK_BASE_URL` (6.3;
      `dast.sh` to `https://localhost:${API_PORT}`, the exact value of its
      `ALLOWED_ORIGINS` at `scripts/ci/dast.sh:157`: a bare `https://localhost` is not in
      that list, so the rule of 6.3 would fail startup).
      Verify: `recipient-key.test.ts`
      covers the same canonical email giving the same key, a different secret giving a
      different key, the key not being the sha256 of the email, and no address or
      secret appearing in the key, `config.test.ts` covers a missing or short
      secret failing startup outside test and the test configuration needing none, the
      three tests of 6.5 pass with the new variables, and `dast-script.test.ts` (4.6b)
      covers `dast.sh` exporting `IDENTITY_TOKEN_HMAC_SECRET` and
      `INVITATION_LINK_BASE_URL`, the latter equal to its `ALLOWED_ORIGINS` value, port
      included.
- [x] 6.7 A per-recipient cap of 3 per 24 hours across all tenants, keyed by the
      HMAC of the canonical email (6.7b, 7.10). Verify: `invitation-caps.test.ts` covers
      "Exceeding the per-recipient cap blocks repeat invites across tenants",
      asserting scope `recipient` and that no address is in the event or the key
      store.
- [x] 6.8 A global kill switch (`INVITATION_EMAIL_KILL_SWITCH`). Verify:
      `invitation-caps.test.ts` covers "The global kill switch stops all invitation
      email" with scope `global`.
- [x] 6.8c Every `AUTH_RATE_LIMITED` of the invitation caps (tenant, recipient and
      global) carries the **same** `Retry-After` (the shortest window, one hour), so
      the header does not reveal which bucket tripped (VCDM G2; Q61).
      Verify: `invitation-caps.test.ts` covers "Every cap answers with the same
      Retry-After": the tenant, recipient and kill-switch rejections carry an equal
      `retryAfterSeconds`.
- [x] 6.9 A disabled or zero cap fails startup (`002` Q39). Verify:
      `config.test.ts` covers a zero or disabled value for each invitation cap throwing
      at startup (the notice cap's is 6.12's case).
- [x] 6.10 The production store for the caps and the accept route's limiter is
      `002`'s DB-backed atomic store (`auth.rate_limit`, hashed keys, no migration).
      `consumeRateLimitBucket` is not exported today and is tied to the Better Auth
      plugin's rule table (`pre-auth-rate-limit.ts`), so `@tayzu/auth` exports a
      scope-generic helper with rules for the new scopes, built from the adapter of
      `(await auth.$context).adapter`, and the closed `RateLimitScope` union gains
      `invitation_accept`, `invitation_tenant`, `invitation_recipient` and
      `notice_tenant` (6.12b adds `notice_recipient` and 13.9 adds
      `reauthorization_callback`, six new scopes in all).
      `hashBucketKey` has the kinds `'ip' | 'email' | 'user'` only, so it gains
      `'tenant'`. Neither executable telemetry contract enumerates the values, but
      `002`'s design and `pre-auth-rate-limit.ts` declare the scope a closed
      three-value enum, so this amends it and 16.14 records the amendment: the generic helper reports a bucket
      denial on `002`'s existing rate-limit metric and log event with the new scope as an
      attribute value (no new instrument), besides the invitation-specific event. Verify:
      `invitation-rate-limit-store.int.test.ts` covers two store instances over the
      same database sharing one count per scope, a key being stored only as a hash
      (the `tenant` kind included), and the new scopes being accepted by the helper
      while an unknown scope is refused, and a denial being reported on `002`'s rate-limit
      metric and log event with the new scope value.
- [x] 6.10b The cap windows have the semantics of `002`'s store, which is accepted
      and documented (Resolved decision Q66): a bucket resets only after a full window
      with **no allowed request**, because every allowed hit moves `lastRequest` and the
      table has no window-start column, so the caps are stricter than their nominal rate
      and no migration is added. Verify: `invitation-rate-limit-store.int.test.ts` covers
      "A slow trickle never resets a bucket": with a clock seam, requests spaced just
      under the window keep accumulating to the cap of 3 per 24 hours, the next one is
      refused, and a gap of a full window resets the bucket.
- [x] 6.11 The `AdminAcceptedNotice` template (Resolved decision Q39) has a fixed
      subject and body with no interpolated value, no link and no tenant, actor or
      invitee free text. Verify: `admin-accepted-notice-template.test.ts` covers "The
      admin notice carries no free text" (an organization named `<b>Pay now</b>` and a
      markup-bearing invitee name never appear, and the rendered HTML and text contain
      no link) by parsing both.

- [x] 6.12 A notice dispatcher (`apps/api/src/identity/notices.ts`; Resolved
      decision Q53) is the only way a notice is sent: the
      `AdminAcceptedNotice` here, and `045`'s `OrgDeletionNotice` through it. It applies the global kill switch, the
      per-recipient bucket of 6.7 (keyed by the HMAC of the canonical email, 6.7b; 6.12b
      then moves the notices to a bucket of their own, Resolved decision Q101) and a
      per-tenant notice cap (scope `notice_tenant`, emails per hour, default 60 in
      `apps/api/src/config.ts` per Q58), applies the tenant list of 6.5c before any
      of them, sends to at most 20
      recipients (the administrators who have been members the longest, `Disabled` ones
      included so that a rogue admin cannot silence the notice by disabling the others,
      the invitee excluded) and never throws into its caller: a suppressed or truncated notice
      logs `catalog.security.notice_suppressed` (declared in 15.1) with the template,
      the reason and the number dropped. Verify: `notices.test.ts` covers "The
      notices are under the kill switch and the caps" (the kill switch on, the notice
      cap exhausted and a full per-recipient bucket each suppressing exactly the
      affected emails with the right reason and no address in the event), "A notice
      goes to at most 20 recipients" (25 admins, 20 emails to the longest-standing
      ones, a `truncated` event) the dispatcher never throwing, a `Disabled` admin being among the recipients, and a
      notice of a tenant on the list of 6.5c being suppressed before any bucket is
      consumed, with nothing sent and `catalog.security.email_tenant_blocked` logged with
      the tenant and the template `admin_accepted` and no address; `config.test.ts`
      covers a zero notice cap failing startup.
- [x] 6.12b Notices get their own per-recipient bucket (scope `notice_recipient`, a new
      value of the closed `RateLimitScope` union and a rule of the helper of 6.10, keyed
      by the HMAC of 6.7b, with the limit of 3 per 24 hours of Q15 (applied to the notices by Q53)), separate from
      the invitation bucket of 6.7, so that notices cannot exhaust a person's invitation
      budget and invitations cannot silence a notice (Resolved decision Q101; before the
      mount switch). The dispatcher of 6.12 consumes this bucket instead of the one of
      6.7, and a full one still suppresses with the reason `recipient`. Verify:
      `notices.test.ts` covers "Notices and invitations count in separate recipient
      buckets": an exhausted invitation bucket not suppressing a notice to the same
      person, an exhausted notice bucket suppressing the notice with the reason
      `recipient` and not blocking an invitation; and
      `invitation-rate-limit-store.int.test.ts` (6.10) covers the new scope accepted by
      the helper, its key stored only as a hash, and a denial reported on `002`'s
      rate-limit metric and log event with the value `notice_recipient`.

## 7. Invitation lifecycle

- [x] 7.1 `invitation-token.ts`: 256 bits from a CSPRNG, `sha256` digest for
      storage, constant-time comparison over equal-length digests, and a dummy
      comparison for a missing record. Verify: `invitation-token.test.ts` covers
      token length and uniqueness, that only the digest is derivable for storage,
      that comparison is constant-time (`timingSafeEqual`) and that a missing record
      still performs one comparison.
- [x] 7.2 Configure Better Auth's `organization` invitation options
      (`invitationExpiresIn` 48 hours, `cancelPendingInvitationsOnReInvite: true`;
      `requireEmailVerificationOnInvitation` is not used because the native accept
      route stays off the allowlist), and the boundary mapper (`canceled` →
      `cancelled`, `expired` derived from `expiresAt`). Verify:
      `invitation-config.int.test.ts` asserts the 48-hour `expiresAt` on a real
      invitation and the mapped states.
- [x] 7.3 `identity.users.invite` (in `apps/api`) calls
      `auth.api.createInvitation` in process **with the admin's session headers**
      (Resolved decision Q42): `/organization/invite-member` requires a real session
      and has no `userId` bypass, so the server puts the request headers in the router
      context (like `__stepUpHeaders` today) and the re-invite cancel and the
      100-invitation limit stay Better Auth's. It stores the token digest in
      `auth.verification` (identifier `invitation-accept:<invitationId>`, same expiry)
      and sends exactly one email through the gate of 6.5c. It makes no `_user` write
      of its own (Resolved decision Q76): `afterCreateInvitation` (Better Auth's hook)
      writes the `_user` to `Invited` through `created_invited` (creating the entity
      first if the email has none yet, design D4 "Hooks"), via the Q30 adapter of 4.1,
      as `system` with `onBehalfOf` the admin, handed over through the
      `AsyncLocalStorage` of D2 that `invite` runs around `createInvitation`, and with the
      invitation's id, which the hook receives, as the port input's `invitationId` (4.1).
      The hook's
      write emits `catalog.audit.user_status_changed` (4.1e) with the admin as
      `tayzu.actor.id`, the status event `created_invited` and the invitation id as its
      subject, because an invited email may have no Better Auth user yet (Resolved
      decisions Q117 and Q126). The response of
      `invite` never carries the token or the link (the token proves mailbox control,
      so an inviter who saw it could accept as the invitee). Verify:
      `invitations.int.test.ts` mints a real session and covers "Invite sends exactly
      one email with exactly one link" and "Explicit invite starts a user as invited"
      (one `_user` write, made by the hook, whose change event carries the admin as
      `onBehalfOf`, and one `catalog.audit.user_status_changed` with the admin, the
      status event `created_invited`, `tayzu.identity.invitation.id` equal to the created
      invitation's id and no email) using
      the recording fake, "The invitation link never leaves the email" (neither
      the token nor the id-plus-token link in the response, in any log record or in
      what the non-sending sender keeps) and a call whose context carries no valid
      session headers failing closed with nothing created.
- [x] 7.4 The invited role is exactly the string `member` or `admin`, never
      `owner`, and is logged on `catalog.audit.invitation_created`. Better Auth's
      `inviteMember` accepts comma-separated strings and arrays and the Cerbos role
      mapper splits them, so the validation is an exact match. Verify:
      `invitations.int.test.ts` covers "Inviting with the owner role is rejected" for
      `owner`, `member,owner`, `['owner']`, `Admin` and an arbitrary value, each with
      nothing created, and "An admin invitation is logged with its role".
- [x] 7.5 Re-inviting an email that has a `pending` invitation cancels the
      previous invitation (reason `re_invite`) and creates a fresh one. Verify:
      `invitations.int.test.ts` covers "Re-inviting cancels the previous
      invitation".
- [x] 7.6 `identity.users.cancelInvitation`, Cerbos-gated to admins through
      `user.invite`, resolving the invitation on the server and cancelling through
      Better Auth's `cancelInvitation` with the same forwarded session headers (it is
      session-bound too). It skips an invitation that is not `pending`, which 8.10 adds
      once 8.3 marks an accepted invitation (Resolved decision Q123): such a cancel is
      refused like the resend of 7.7, with `CATALOG_VALIDATION_FAILED` and the same
      fixed message, changes nothing and logs nothing (Resolved decision Q129; design D4
      "Resend"), and a missing or foreign invitation still answers `CATALOG_NOT_FOUND`
      (D14). The window between its `pending` read and the acceptance's `accepted` write
      is a documented residual with no race case (Resolved decision Q128; design Risks,
      ticket TK12-1). Verify:
      `invitations.int.test.ts` covers "Admin can cancel a pending invitation".
- [x] 7.7 `identity.users.resendInvitation` issues a **new** token (the old one
      stops working), keeps the original expiry and sends one email, and does **not**
      use Better Auth's `inviteMember` with `resend: true`, which resets `expiresAt`
      to now + 48 hours. Its response never carries the token or the link, and it sends
      through the gate of 6.5c. It refuses an invitation that is not `pending` with
      `CATALOG_VALIDATION_FAILED` and one fixed message (design D4 "Resend"), which 8.10
      adds once 8.3 marks an accepted invitation (Resolved decision Q123); the window
      between its `pending` read and the acceptance's `accepted` write is a documented
      residual with no race case (Resolved decision Q128). Verify: `invitations.int.test.ts` covers "Resending
      issues a new link and keeps the expiry", asserting the invitation's `expiresAt`
      is unchanged after the resend, the old token no longer verifies and the response
      carries neither the token nor the link.
- [x] 7.8 An invitation for an email whose existing user is `Disabled` is
      refused and sends nothing. Verify: `invitations.int.test.ts` covers "A
      disabled user cannot be invited".
- [x] 7.9 A non-admin attempting `identity.users.invite` is denied with
      `AUTH_FORBIDDEN`, no invitation is created and `catalog.security.authz_denied`
      is logged. Verify: `invitations.int.test.ts` covers "Non-admin cannot invite"
      against the real Cerbos container.
- [x] 7.9b `@tayzu/catalog` exports `ENTITY_IDENTIFIER_PATTERN` unchanged (Resolved
      decision Q60), from one source of truth. The constant exists as two private
      copies today (`packages/catalog/src/domain/limits.ts` and
      `packages/catalog/src/domain/identifiers.ts`): `identifiers.ts` is the source,
      `limits.ts` imports it and the package index exports it, with no change of
      behavior. Verify: `identifier-pattern.test.ts` (in `packages/catalog`) covers
      the exported pattern accepting and rejecting the same table of values as
      before (an email, an `svc-` identifier, a value with `/`, an over-length
      value), `limits.ts` and `identifiers.ts` using the same constant, and `pnpm
      --filter @tayzu/catalog test` staying green.
- [x] 7.10 The canonical email form (NFC, trimmed, lower-cased) is one pure
      function in `apps/api/src/identity/email-canonical.ts` (`@tayzu/auth` has no use
      for it and cannot import `@tayzu/catalog`; the `ENTITY_IDENTIFIER_PATTERN` it
      validates against is the one `@tayzu/catalog` exports in 7.9b, Q60), used for the `_user` identifier, the Better Auth email, the invitation
      email, the cap key and the domain that the allowlist wrapper of 6.5b compares, and
      a validator rejects an address the entity identifier pattern cannot hold or that
      contains `/` (Resolved decision Q33). Verify:
      `email-canonical.test.ts` covers `Alice@Example.com ` and its NFC variant
      canonicalizing identically, `a+b@example.com` and `a/b@example.com` rejected,
      and a plain address accepted, and `email-allowlist.test.ts` (6.5b) covers a
      recipient written `Bob@Allowed.Example ` reaching the stubbed provider when
      `allowed.example` is on the list.
- [ ] 7.11 `identity.users.invite` and `identity.users.create` reject such an
      address with `CATALOG_VALIDATION_FAILED`, before any invitation, user, email or
      cap increment. Verify: `email-boundary.int.test.ts` covers both operations
      refusing `a+b@example.com` and `a/b@example.com` with nothing created, and a
      plus-alias therefore not reaching the per-recipient cap.
- [ ] 7.12 Better Auth's own errors never reach the response as they are:
      `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION` and the default
      `invitationLimit` of 100 pending invitations per organization (a FORBIDDEN
      `INVITATION_LIMIT_REACHED`) map to `CATALOG_VALIDATION_FAILED` with no provider
      text, and so does the default `membershipLimit` of 100 members per organization
      (`addMember` answers FORBIDDEN past it) for `identity.users.create`; the
      acceptance answers the uniform rejection with the denial reason `member_limit`
      (8.7). Verify: `invitations.int.test.ts` covers inviting an existing member and
      exceeding 100 pending invitations, asserting the generic code and no membership
      information in the response, and `identity.users.create` in an organization with
      100 members answering `CATALOG_VALIDATION_FAILED`.
- [ ] 7.13 `identity.users.create` for an email that has a `pending` invitation in the
      caller's tenant cancels that invitation once the user and the membership exist, with
      the reason `user_created` (Resolved decision Q110; design D4), through Better Auth's
      `cancelInvitation` with the admin's forwarded session headers, like 7.6, and emits
      the span `identity.invitation.cancel` and `catalog.audit.invitation_cancelled` with
      that reason (declared in 15.1). Verify: `invitations.int.test.ts` covers "Creating
      a user cancels a pending invitation of the same email": a pending invitation of `t1`
      to `bob@example.com`, followed by `identity.users.create` for `bob@example.com` in
      `t1`, leaves the invitation `cancelled` with the reason `user_created` and the event
      emitted with it; a pending invitation of `t2` to the same email stays `pending`;
      a `create` refused at the member limit of 7.12 leaves the invitation `pending`; and
      an invitation of `t1` to the same email that is already `cancelled` (by an earlier
      cancel of 7.6) or seeded directly as `rejected` stays as it is, and the creation
      logs no `catalog.audit.invitation_cancelled` with the reason `user_created` for it
      (Resolved decision Q129).

## 8. Invitation acceptance

- [ ] 8.1 A password policy module (design Q22): NFC-normalized, 20 to 128
      characters (counted as Unicode code points after normalization), at least one
      upper-case letter, lower-case letter, digit and symbol, no control characters
      (U+0000-U+001F, U+007F-U+009F), unpaired surrogates or Unicode format
      characters (bidi overrides, zero-width), and not on a bundled common-password
      denylist; no external call and no new dependency. Applied to invitation
      acceptance, temporary and bootstrap passwords, and `/change-password`. Verify:
      `password-policy.test.ts` covers 19 and 129 characters refused (a password of
      astral characters counted by code point, not by UTF-16 unit), each missing
      class refused, a NUL, a control character, a bidi override and a zero-width
      character refused, a denylisted password refused, a compliant 20-character
      password accepted, and the refusal naming only the failed rule, never the
      password.
- [ ] 8.1a _(setup)_ A shared stub for the breached-password range query, as a
      `setupFiles` entry of the `int` project in `vitest.shared.ts` (a new
      `vitest.int.stub.mjs` beside it; an `.mjs` file, because a `.ts` file in
      `NODE_OPTIONS` depends on loader ordering). The root `vitest.int.setup.ts` is
      a `globalSetup`, which runs once in the main process and cannot patch `fetch`
      inside a test worker, so it is not the home. The `haveIBeenPwned` plugin also
      covers `/admin/create-user`, and 31 existing test files reach it through
      `createAuth(` or `createUser`, so without a stub each would call
      `api.pwnedpasswords.com` or fail closed. The stub answers the range query for
      that host with an empty range and passes every other request through; a test
      that needs a breached or an unreachable answer installs its own over it
      (8.1b). A child process never inherits it (the bootstrap that
      `scripts/ci/zap-seed.ts` spawns, the API server that `dast.sh` starts, and any
      test that spawns one), so the same module is loaded with
      `NODE_OPTIONS=--import` for those, and it is listed in `turbo.json`
      `globalDependencies` so that a change to it invalidates the cached test runs. The
      stub must reach both processes of the DAST run that run the breach plugin, the
      bootstrap child of the seed (moved by 4.6b) and the API server that `dast.sh`
      starts and that serves the forced `/api/auth/change-password`, so `dast.sh` sets
      `NODE_OPTIONS=--import` to the `.mjs` stub for the **whole** `dast.sh up`; that
      step is shared with `ci:local` (Resolved decision Q71).
      Verify: `pnpm --filter @tayzu/auth test` and `pnpm --filter @tayzu/api test`
      pass, a spy shows no request to `api.pwnedpasswords.com` leaving a test
      worker, a child process started with the `--import` option shows none either,
      `dast-script.test.ts` (4.6b) covers the stub being imported through
      `NODE_OPTIONS` before the API server and the seed start, and `turbo.json` lists
      the file.
- [ ] 8.1b Breached-password check (design Q23): Better Auth's built-in
      `haveIBeenPwned` plugin is enabled for every path the policy covers, with a
      sanitized refusal and fail-closed behavior. The plugin checks only the endpoint
      paths in its list (it covers `/admin/create-user`) and silently skips a hash
      call outside one, so acceptance, temporary-password and bootstrap creation go
      through a covered endpoint such as `auth.api.createUser`, or call the check
      explicitly through the password module. Verify: `password-breach.int.test.ts`
      installs its own stub of the global `fetch` over the shared one of 8.1a (the plugin
      hardcodes `api.pwnedpasswords.com`) and
      covers a password whose SHA-1 suffix is in the stubbed range being refused **when
      set through `auth.api.createUser`** (the covered endpoint that the acceptance of
      8.1e and 8.2 uses; the acceptance case itself is 8.12's), **on a temporary password
      and on bootstrap**, a clean one accepted,
      only the 5-character prefix ever being sent, and an unreachable service
      refusing the password (the plugin's fail-closed 500 `APIError`) with the sanitized
      generic `INTERNAL` (500) error at the boundary, the only generic error the mapping
      has, so no new code is introduced and no provider text leaks.
- [ ] 8.1c Better Auth's own password configuration enforces the policy on its
      routes: `minPasswordLength` 20 and `maxPasswordLength` 256 (Better Auth counts
      UTF-16 units of the raw string, and 128 code points can take 256 units, so its
      bounds must never reject a compliant password; the exact bounds in code points
      are the policy module's), the policy hook on `/change-password`, and `002`'s test fixtures that used the old 8-character
      default are updated. Admin `createUser` enforces only the maximum length, so the
      minimum there comes from Tayzu's password policy module, applied by
      `identity.users.create`. Verify: `password-policy.int.test.ts` covers
      `/change-password` refusing a 19-character and a denylisted password and
      accepting a compliant one (including one of 128 astral code points), `identity.users.create` refusing a 19-character
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
      through `auth.api.createUser` (the endpoint the acceptance uses; a password set
      through the acceptance itself is 8.2's case) signing in, passing `/verify-password`, enabling a second
      factor, changing it with `/change-password` and generating backup codes when
      presented in its NFD form, a breached password presented in its NFD form being
      refused (the stubbed range is keyed on the NFC form, so this fails unless the hook
      runs before the plugin), an endpoint outside any list verifying in NFD too (the
      normalization is in the function), and the hook leaving a body without those
      fields untouched.
- [ ] 8.1e The acceptance runs as a sequence of **idempotent steps with no
      transaction around it** (Resolved decision Q89, which supersedes Q75's
      `transaction: true`: a Better Auth transaction would need `transaction: true` in
      `drizzleAdapter(...)`, which `auth.ts` sets nowhere, **and** `runWithTransaction`
      from `@better-auth/core`, which `better-auth` does not re-export and `@tayzu/auth`
      does not depend on, and `addMember` and `createOrganization` are not
      transactional anyway; no dependency is added). `apps/api/src/identity/accept-flow.ts`
      orders the steps of design D4: verify the token without consuming it, check the
      inviter (8.5f), check the password policy, do the work of the path (create the
      user and set its password and verified email, add the membership and write the
      `_user`; for an existing account, add the membership, run the explicit shed of
      8.5h, and only then write the `_user`, run at once the step for what the join owes
      (the session revocation that 8.5k and 8.5m add and the admin notice that 8.15 adds,
      Resolved decision Q122), and set `emailVerified`) and **consume the token last**
      (the delete conditioned on its digest, which 8.3 puts in one short `tayzu_auth`
      transaction with the invitation's `accepted` write, Resolved decision Q123); on the
      new-account path the admin notice of 8.15 follows that commit or a consumption that
      changes no row, whether or not the attempt's own `_user` step activated the row,
      and a compensated failure sends none (Resolved decision Q127). The flow sets the acceptance's shared context
      (`apps/api/src/identity/identity-context.ts`) on both paths, inside which
      `afterAddMember` makes **no** `_user` write (Resolved decision Q112) for the
      acceptance's own member: the context carries the acceptance's `(tenantId,
      userId)`, and the `UserSyncPort` adapter skips only for that member, comparing it
      with the `tenantId` and the `userId` of the hook's port input (4.1) (Resolved
      decision Q120; so does the shed port of 8.5h), so a membership of another user, or
      of the same user in another tenant, added while the context is set is written (and,
      from 8.5h, shed) as on any other path. The `_user` is
      written by the acceptance's own `_user` step, through the adapter of 4.1 with the
      `membership_added` intent, as `system` with the invitee's Better Auth user id as
      `onBehalfOf` (actor type `user`) on both paths (Resolved decision Q116), so its
      `catalog.audit.user_status_changed` names the invitee as `tayzu.actor.id` with the
      status event `invitation_accepted` (4.1e), and on the existing-account path a new
      membership stays
      inert (its `_user` still `Invited`, rejected by 11.8) until the shed is done. Each step is idempotent: an
      `addMember` for a user who already is a member is treated as done (and recorded as
      not created by this attempt), and an `Active` `_user` is no write. The `_user`
      step **fails closed**: if it throws, the attempt fails and
      the token is not consumed. A failure after the attempt **created** the user
      compensates, in reverse order and each idempotently, the membership, the `_user`
      and the user it created (never one it found), so a retry with the same token
      adds them again and finds the `_user`, which the invitation hook created and the
      compensation therefore keeps, `Active` (no write) when the failure came after the
      `_user` step; a compensation that fails logs
      `catalog.security.invitation_accept_compensation_failed` (declared in 15.1). **On
      the existing-account path** (Resolved decision Q105, part 1, narrowed by Q118) the
      attempt records whether its `addMember` created the membership and, if a step
      before the `_user` is activated fails (the shed of 8.5h or the `_user` step),
      deletes the membership it created, idempotently and never one it found,
      logging the same event if the deletion fails (both paths delete a membership
      through the tenant-keyed `member` delete of 5.1b, because `removeMember` needs a
      session); without it a failed attempt that is never retried would leave an inert
      membership (its `_user` still `Invited`); a retry still runs the explicit shed of
      8.5h. Once the `_user` step has run, a later failure (the `emailVerified` write, or
      a consumption of the token that fails other than by losing the race) deletes
      nothing (Resolved decision Q118): the attempt fails with the sanitized generic error
      and the token still valid, and a retry with the same token finds the membership,
      sheds again (removing nothing more), makes no `_user` write (so it sends no second
      notice, 8.15), sets `emailVerified` and consumes the token. Such an attempt has
      already run what the join owes, because that runs right after the `_user` step
      (Resolved decision Q122), so when it is never retried it leaves only the
      `emailVerified` write and the consumption of the token undone, and the invitation
      stays `pending` until it expires. A failure of the shed or of the
      `_user` step leaves the `_user` `Invited`, so
      even when the compensation fails too the member stays rejected (fail closed), and
      the first-sign-in hook of 4.4 does not activate that row (Resolved decision Q111). A lost consume race (another attempt consumed the token first, so the
      token delete changes no row; from 8.3, also the `accepted` write, and the
      transaction then changes nothing, Q123) compensates
      nothing, on either path: when another attempt consumed the token, the winner's
      state is final and may rest on the membership the loser created, and the flow
      cannot tell that case from a token delete that removes zero rows because a
      concurrent resend replaced the digest (Q122), or from an `accepted` write that
      changes no row because a concurrent cancellation committed first (Q123), where no
      attempt won, so it handles them all alike and the join stands (design Risks; on the
      new-account path the attempt then still sends the admin notice of 8.15, because its
      consumption undid nothing, Resolved decision Q127); it answers the uniform rejection
      (`CATALOG_NOT_FOUND`) and logs `catalog.security.invitation_acceptance_denied`
      with the reason `consume_conflict` (design D4 steps 4 and 5; declared in 15.1),
      not the sanitized generic error of the other failures after the `_user` step. The
      `Active` `_user` with no membership that a compensated new-account failure after
      the `_user` step leaves, when no retry follows, is the reconcile's (4.2b, one hour
      after its activation, Q124), and a user left with no
      membership is an operator repair (Resolved decision Q100: driven by the alert on
      `catalog.security.invitation_accept_compensation_failed` and the runbook of 16.5). Verify: `accept-flow.int.test.ts` covers a failure
      injected after `createUser` leaving no user row, a `userSync` that throws at the
      acceptance's `_user` step leaving no user, no member, and the `_user` still
      `Invited`, with the token still valid and a retry then succeeding, `afterAddMember` making no `_user` write
      inside the acceptance (the adapter writes the `_user` exactly once, from the
      acceptance's own step), an `addMember` that already happened being
      treated as done, a failing compensation emitting the event, and a lost consume
      race deleting nothing the other attempt created and answering the uniform
      rejection with the reason `consume_conflict`; and "A failed existing-account
      acceptance leaves no membership": an existing account whose acceptance fails after
      `addMember` inserted the member (a `userSync` that throws at the `_user` step; the
      failing shed is 8.5h's case) ends with no membership of the tenant and the
      token still valid, a retry with the same token adding the membership again, a
      membership that existed before the attempt (seeded directly) never being deleted
      by a failed attempt, and a failing deletion emitting
      `invitation_accept_compensation_failed`; "A failure after the `_user` step keeps the
      membership for a retry": an existing account whose attempt fails at the
      `emailVerified` write (a failure seam) keeping its membership and its `Active`
      `_user`, deleting nothing, emitting no `invitation_accept_compensation_failed` and
      leaving the token valid, and a retry with the same token completing the acceptance
      (the token consumed, `emailVerified` set, no second `_user` write), the slot for
      what the join owes running after the `_user` step and before the `emailVerified`
      write (a recording seam on the steps; its revocation and notice are 8.5m's and
      8.15's cases), and a consumption whose token delete removes zero rows because a
      resend replaced the digest after the `_user` step (a seam) being handled as a lost
      race: the attempt answers the uniform rejection with the reason `consume_conflict`,
      deletes nothing and keeps the membership and the `Active` `_user`, and an
      acceptance with the resent token completes; on the new-account path the same seam
      after the `_user` step leaving the user, the membership and the `Active` `_user` in
      place (nothing compensated), answering the uniform rejection with the reason
      `consume_conflict` and running the slot for the admin notice after that zero-row
      consumption, while a new-account failure that is compensated does not run it (the
      recording seam; the notice itself is 8.15's case, Resolved decision Q127); the acceptance's
      `_user` step writing with the invitee's Better Auth user id as `onBehalfOf` on both
      paths, its `catalog.audit.user_status_changed` naming the invitee; and "The
      acceptance holds back only its own member's hooks": a test-only seam that adds,
      while the shared context is set, a membership of another user and one of the same
      user in another tenant, each of whose `afterAddMember` writes its `_user` as
      outside the context, while the acceptance's own member gets no hook write (the
      shed port's half is 8.5h's case).
- [ ] 8.2 The acceptance service function (in `apps/api`, served by the plain route
      of 14.1b) for an email with no account runs the steps of 8.1e: it verifies
      the token, creates the user (global role `user`), sets the
      password the invitee supplied under the policy, marks the email verified, adds
      the membership with the invited role, writes the status through
      `invitation_accepted` (by the acceptance's own `_user` step, which fails closed;
      inside the acceptance's shared context the membership hook makes no `_user` write
      for the acceptance's own member (Q120), Resolved decision Q112) and creates **no
      session**. A failure of any step after the user is created, the `_user` write
      included, other than a lost consume race (which compensates nothing, 8.1e, Resolved
      decision Q127), is compensated (8.1e) and leaves the token unconsumed. Verify:
      `invitation-accept.int.test.ts` covers "A new person accepts and can then sign
      in" (sign-in through the normal route succeeds afterward, also with the password
      presented in its NFD form, the normalization of 8.1d) and "A failed
      `_user` write undoes the acceptance": with a `userSync` that throws, no user, no
      member, and the `_user` still `Invited`, the token still verifies, a retry with the same token
      succeeds and the acceptance answers
      the sanitized `INTERNAL` error; and a successful acceptance emitting
      `catalog.audit.invitation_accepted` with `tayzu.actor.type` `user` and
      `tayzu.actor.id` the new user's Better Auth user id, the same value as its
      `tayzu.identity.user.id` (Resolved decision Q116).
- [ ] 8.3 The token is verified without consuming it and then consumed **last** (8.1e),
      with one atomic delete **conditioned on its digest**, so it
      works exactly once. The same short `tayzu_auth` transaction sets the invitation's
      status to `accepted` (Resolved decision Q123; design D4 step 1) through a third
      tenant-keyed write of the repository of 5.1b, which requires a `tenantId`, filters
      by `organizationId` and the invitation id and updates only while the status is
      still `pending` (parameterized SQL, no migration); when the token delete or that
      write changes no row, the transaction changes nothing and the attempt takes the
      lost-race path of 8.1e, answering the uniform rejection (`CATALOG_NOT_FOUND`) with
      the denial reason `consume_conflict` (design D4 steps 4 and 5). A later acceptance
      of the invitation is then denied with
      the reason `already_accepted` (both declared in the design's Observability contract), not
      `token_mismatch`. Verify:
      `invitation-accept.int.test.ts` covers a second acceptance with the same
      token failing, including two concurrent attempts where exactly one succeeds and
      the losing one, held by a seam before its consumption until the winner has
      committed (on the existing-account path, so that both reach the consumption),
      answers the uniform rejection with
      `catalog.security.invitation_acceptance_denied` recording `consume_conflict`; a
      successful acceptance leaving the invitation `accepted`, the status written in the
      same transaction as the token delete (a seam that fails the transaction after the
      delete leaves the token row in place and the invitation `pending`); a consumption
      whose `accepted` write changes no row (the invitation cancelled by a seam after the
      token verified) leaving the token row and the cancelled status untouched and
      failing as a lost race with the same answer and reason; the repository write
      refusing a call without a `tenantId`
      and changing no invitation of another tenant; and "A replayed acceptance is recorded
      as already accepted": the same request sent again after a success answering the
      uniform rejection with `catalog.security.invitation_acceptance_denied` recording
      `already_accepted`, and nothing changing.
- [ ] 8.4 The tenant is derived from the invitation record, and the body is an
      allowlist of exactly the invitation id, the token and, for a new account, the
      password: a body that carries a tenant, an actor, `role`, `email`,
      `organizationId` or `userId` is rejected with `CATALOG_VALIDATION_FAILED`
      (null-prototype parse, `__proto__`, `constructor` and `prototype` rejected at
      every depth). The invitation id is checked for shape and length before any lookup
      or logging, and one that fails the check is logged as the constant `invalid`, never
      as the value: `tayzu.identity.invitation.id` is `invalid` on the
      `identity.invitation.accept` span and on
      `catalog.security.invitation_acceptance_denied`, whose denial reason for a rejected
      body or id shape is `malformed_request` (design D4, Observability contract).
      Verify: `invitation-accept.int.test.ts` covers "The tenant comes from the
      invitation", each extra field being rejected with nothing created and
      `invitation_acceptance_denied` logged with the reason `malformed_request`, and an
      over-long or malformed id never appearing in a log record, the id attribute being
      `invalid`.
- [ ] 8.5 For an email that already has an account and a request **without** a
      session, acceptance never sets or changes a password and answers the uniform
      rejection (Resolved decisions Q18 and Q24). Verify:
      `invitation-accept.int.test.ts` covers "Acceptance does not touch an existing
      account", including a `password` in the body being ignored.
- [ ] 8.5b For an existing account with a session of that same account and the valid
      token, acceptance adds only the membership with the invited role and, **after** its
      explicit shed step (8.5h), activates the `_user` through `invitation_accepted` and
      sets `emailVerified` (Resolved decision Q38: the token proves the mailbox; Resolved
      decision Q112: the `_user` step runs after the shed, and `afterAddMember` makes no
      `_user` write for the acceptance's own member (Q120) inside the acceptance's shared
      context, 8.1e); it never touches the password,
      the request's own session, the active organization or any linked account,
      except that its explicit shed step (8.5h) removes the SSO links its user did not
      make and, when it removed one, revokes the user's other sessions at once (8.5h);
      when it or an earlier attempt's shed of the invitation removed one (the
      `invitation-shed:<invitationId>` record of 8.5m), it revokes the accepting session
      and any session that an earlier attempt's shed kept only once its `_user` step has
      run, before the `emailVerified` write and the consumption of the token (8.5k, 8.5m;
      Resolved decisions Q73, Q86, Q105, Q106 and Q122). Its success has the same
      status and body shape as the new-account path.
      Verify: `invitation-accept.int.test.ts` covers "An existing account accepts
      with its session", including `emailVerified` being true afterward, the `_user`
      of the tenant being written once, by the acceptance's `_user` step after the shed
      step (a recording seam on the two steps), and `catalog.audit.invitation_accepted`
      naming the invitee (`tayzu.actor.type` `user`, `tayzu.actor.id` her Better Auth
      user id, Resolved decision Q116).
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
- [ ] 8.5e The session read by the accept route is subject to the idle-timeout check
      of `resolveContext` (`isIdle`, exported by `session-idle.ts` and added to the package index for the
      route), is read with `disableRefresh: true` as the resolver reads it (a plain
      `getSession` can refresh `updatedAt` and so extend a session about to idle out), and to a banned check that the route makes itself by reading
      `user.banned`, because `resolveContext` has no banned check until 13.4, after
      this group. The temporary-password marker is honored by 13.5c. Verify:
      `invitation-accept.int.test.ts` covers a banned user's session and an
      idle-expired session each answering the uniform rejection (`denial_reason`
      `session_required`) with nothing created, and a successful acceptance of a
      `member` invitation leaving the session's `updatedAt` unchanged (for an `admin`
      invitation the step-up guard of 8.5d reads the session again with a plain
      `getSession`, `step-up.ts`, which may refresh it, so the assertion covers `member`
      invitations only).
- [ ] 8.5f At acceptance, on both paths, after the token has verified and before it
      is consumed, the invitation's inviter must still be a member of the
      invitation's organization, whose Better Auth user is not `banned` and whose
      `_user` status in the tenant is `Active`, and **Cerbos must still allow the
      inviter `invite` on a `user` resource** (Resolved decision Q108, which replaces a
      local mapping of the membership role and keeps `002` D2's single decision point):
      the principal is built from the inviter's member row (the inviter's Better Auth
      user id, the roles `resolveContext` derives from that membership role, through the
      same mapping, `toCerbosRole` in `context-resolver.ts`, exported for it and added to
      the package index (as 8.5e does for `isIdle`), and the invitation's tenant), and
      the resource has the id `new` and the invitation's `organizationId` as its tenant.
      A missing membership, a banned or non-`Active` inviter, a Cerbos deny and a Cerbos error each answer the uniform rejection with
      the denial reason `inviter_not_active_admin`, and the token is not consumed
      (Resolved decision Q63; design D4 step 2). The reads go through
      the repository of 5.1b (`tayzu_auth`) and the `_user` status is read from
      `tayzu_app`, a different pool, with no transaction around the acceptance (8.1e),
      so an inviter disabled between the check and the consumption of the token can
      still be accepted (a race of a few seconds at most, accepted and recorded in
      Risks). Verify: `invitation-accept.int.test.ts` covers "An
      invitation does not outlive its inviter's authority": an invitation accepted
      on each path after its inviter was disabled, banned, demoted to `member` or
      had the membership removed by a direct write, each answering the uniform
      rejection with `denial_reason` `inviter_not_active_admin` and the token still
      valid afterwards; an `admin` inviter and an `owner` inviter still being
      accepted; a wrong token with a disabled inviter answering the same uniform
      rejection; and "The inviter re-check is a Cerbos decision": a recording Cerbos
      client showing one `user`/`invite` check with the inviter as the principal and the
      invitation's tenant as the principal's and the resource's tenant, and a Cerbos
      client that denies, or that throws, for an otherwise active admin inviter
      answering the same uniform rejection with the token still valid.
- [ ] 8.5i One Postgres advisory lock per user id closes the race between linking and
      joining (Resolved decision Q87). `apps/api/src/identity/user-lock.ts` exposes
      `withUserLock(userId, fn)` (in `apps/api`, used by `linkSsoAccount` and by the shed
      of 8.5h, both in `apps/api`; the hooks of `auth.ts` reach it only through the shed
      port of 8.5h): a short dedicated `tayzu_auth` transaction takes
      `pg_advisory_xact_lock` on a key derived from the user id (a bound parameter,
      never interpolated) and holds it while `fn` runs; `fn` receives that transaction,
      inside which the shed core of 8.5h runs its reads and deletes (Resolved decision
      Q114). `linkSsoAccount` takes it around
      its membership check and its link, and the shed of 8.5h takes it around its read
      and its deletion. Every path takes the lock once, through the shed: the acceptance
      in its explicit shed step, after `addMember` has returned (inside the acceptance's
      shared context the hook does not shed the acceptance's own member, Resolved decision
      Q120), `afterAddMember` on the other membership
      paths and the reconcile (8.5l), so no path takes it twice (the lock is not
      re-entered across connections; Resolved decision Q105). Verify:
      `user-lock.int.test.ts` covers two concurrent `withUserLock` calls for one user
      running one after the other and for two users running in parallel, `fn` running on
      the transaction that holds the lock, and `linkSsoAccount` running its membership
      check and its link inside the lock (a spy on `withUserLock`); the interleavings of
      a link and a join need the shed and are 8.5h's `sso-link-race.int.test.ts`.
- [ ] 8.5g **Positive provenance of SSO links** (Resolved decision Q87, which
      supersedes Q73's admin-side marker). `databaseHooks.account.create.after` writes a
      marker row in `auth.verification` (no migration) for an account that is not the
      `credential` account, only when the hook fires with an endpoint context whose route
      path is the callback route `/callback/:id`, where every link a user makes through
      `/link-social` or the SSO callback is created (Resolved decision Q120): the hook
      context is ambient, so an account written through the internal adapter inside
      another endpoint handler (for example inside `addMember`) fires the hook with that
      handler's context and is not marked. The identifier
      is `sso-link:<accountId>` with `<accountId>` the **`account` row's own `id`** (not
      the provider's `accountId` column, which holds the SSO `sub`), the value is the
      constant `self` (no email, no tenant), and `expiresAt` is a far-future sentinel,
      so Better Auth's cleanup of expired verification rows never removes it.
      `identity.users.linkSsoAccount` goes through the internal adapter with no
      endpoint context, so its link has **no marker**: an unmarked link counts as
      admin-recorded, and so does every link that pre-dates this change.
      `databaseHooks.account.delete.after` deletes the marker on every deletion path
      that goes through Better Auth (the user's own `/unlink-account` and an admin
      unlink), and the shed core of 8.5h deletes the markers of the rows it deletes
      itself, because its SQL runs no Better Auth hook (Resolved decision Q114), so on
      **every** path a later link of the same `sub` cannot inherit a stale marker. The
      hook context is ambient (design D2: `tryGetCurrentAuthEndpointContext()`, and every
      endpoint handler, the server-only `addMember` included, runs inside one), so the
      marker hooks use the adapter of their endpoint context when there is one and fall
      back to `(await auth.$context).adapter` when there is none: the admin unlink
      (`identity-router.ts`) calls the internal adapter outside any endpoint, so
      `context.context.adapter` is absent for its marker delete. For the same reason
      `emitSelfLink` (`auth.ts`) emits `auth.security.account_linked` and
      `account_unlinked` with the actor `self` only when the context's route path is the
      callback route `/callback/:id` (a link) or `/unlink-account` (an unlink), not
      whenever a context exists, so an account row written or deleted by an
      internal-adapter call inside another endpoint handler (for example inside
      `addMember`, whose context `afterAddMember` inherits) emits neither. If the marker write fails,
      the hook deletes the `account` row it was written for (Better Auth has already
      inserted it when `create.after` runs), logs `catalog.security.sso_link_marker_failed`
      (declared in 15.1) and throws, so the link fails and no link is left behind that
      the failed response does not report; a crash between the link and its marker
      leaves an unmarked link, which is shed as admin-recorded: the failure is closed by
      construction. The marker is sound only while every account created on the
      callback route is a link the user made, so the account-linking configuration of
      `auth.ts` is pinned: `account.accountLinking.disableImplicitLinking: true`, no
      `trustedProviders` and `allowDifferentEmails` unset (the SSO callback never links
      by email, and `/link-social` refuses a provider account whose email differs from
      the user's), and so is `account.updateAccountOnSignIn`, which must not be `false`:
      Better Auth runs the account update of an SSO sign-in, whose `account.update.after`
      records the account for the callback check of 8.5k, only when it is not `false`
      (Resolved decision Q115, G9-3). Verify: `sso-link-provenance.int.test.ts`
      covers a link through `/link-social` writing exactly one marker keyed by the
      `account` row's id (not the `sub`) with the value `self`, a link through
      `linkSsoAccount` writing none, the marker's `expiresAt` being the far-future
      sentinel and surviving Better Auth's expired-row cleanup, a user's own
      `/unlink-account` and an admin unlink each removing the marker (the admin unlink,
      which has no endpoint context, through the fallback adapter; the shed's own marker
      deletion is 8.5h's case), a
      re-link of the same `sub` after an unlink getting a fresh marker and not a stale
      one, `account_unlinked` with the actor `self` emitted once for the user's own
      `/unlink-account` and not for an admin unlink, `account_linked` with the actor
      `self` emitted once for a `/link-social` callback and not for `linkSsoAccount`, and
      an account row deleted through the internal adapter from inside an `addMember`
      call (a test-only `afterAddMember` seam) emitting no self-link event, "An account
      written inside another operation gets no marker": an account row written through
      the internal adapter from inside an `addMember` call (the same seam) getting **no**
      marker and emitting no self-link event while the callback route still writes one
      (Resolved decision Q120), a marker write that fails making the link fail with the event emitted and no
      `account` row of that link remaining, "A link to a provider account with another
      email is refused": a `/link-social` callback whose provider email differs from the
      user's being refused with no new `account` row and no marker, and an SSO sign-in
      whose email matches another user creating no link, and the marker carrying no
      email; and `account-linking-config.test.ts` (in `packages/auth/src/`) pins the
      four settings on the options `createAuth` builds, failing if
      `disableImplicitLinking` is not `true`, if `trustedProviders` is set or non-empty,
      if `allowDifferentEmails` is set, or if `updateAccountOnSignIn` is `false`.
- [ ] 8.5h An SSO link that its user did not make does not survive into a second
      tenant, and the sessions issued through it do not either (Resolved decisions Q73,
      Q86, Q87, Q105, Q112 and Q114). Whenever the user holds a membership in another
      tenant, the shed deletes every non-`credential` account of the user without a
      marker (8.5g), and any marker keyed by those rows' ids, emits
      `catalog.security.sso_link_shed` (declared in 15.1) with the tenant
      joined, the path (`acceptance`, `membership_hook` or, from 8.5l, `reconcile`) and
      the opaque user id and no email, and, **when it removed a link, revokes every
      session of the user** (not filtered on `ssoSid`, because `002` Q83 admits SSO
      sessions created without one) by deleting the user's `session` rows, each
      revocation emitting `auth.security.session_revoked` with the reason
      `sso_link_shed`. It is **one shed core** (Resolved decision Q114) that works directly
      on the `tayzu_auth` pool with parameterized SQL (bound parameters only, never
      `sql.raw`) inside the `withUserLock` transaction of 8.5i, used by all three shed
      paths: it builds no Better Auth instance and needs no `BETTER_AUTH_SECRET`. Its
      reads of `member`, `account` and `session` and its deletes of `account`,
      `verification` and `session` rows run inside that transaction and are the other
      exception that 5.1b names. Its SQL
      runs no Better Auth hook, so `auth.security.account_unlinked` with the actor `self`
      is not emitted for the shed and the marker hook of 8.5g does not run for it, which
      is why the core deletes the markers itself. A deleted `session` row is a revoked
      session only because `auth.ts` configures no `secondaryStorage` and leaves
      `session.cookieCache` off, so that configuration is pinned; it is idempotent:
      a re-run deletes the unmarked links that remain and does nothing more when none
      remains. The event goes through `emitSessionRevoked`, which is private in `auth.ts`
      today with its reason fixed to `password_change`: `@tayzu/auth` exports it from its
      index with the reason as a parameter (`password_change`, `admin_action` or
      `sso_link_shed`), keeping the `password_change` emission of `002` unchanged, and
      11.2 and 8.5j use it too. **Where the shed runs** (design D4 step 7): the hooks live
      in `packages/auth/src/auth.ts`, which cannot import `apps/api`, so the shed, with
      its session revocation and the lock of 8.5i, is implemented in
      `apps/api/src/identity/sso-link-shed.ts` (Resolved decision Q30), and
      `afterAddMember` reaches it through a structural port, `SsoLinkShedPort` in
      `packages/auth/src/identity/ports.ts`, that `createAuth` takes as the option
      `ssoLinkShed` the way it takes `userSync` and whose implementation is the shed core;
      `createApp` and the bootstrap CLI build it from their `tayzu_auth` pool and pass
      it (as 4.1b and 4.6b pass `userSync`), the hook calls it **before** its `_user`
      write (Resolved decision Q112), so a shed that fails throws before the new row is
      activated and the membership stays inert, and its implementation reads the shared
      context and returns without shedding only for the acceptance's own `(tenantId,
      userId)` (Resolved decision Q120; 8.1e tests the `_user` half). **At existing-account acceptance the shed is an explicit step of every
      attempt** once the membership exists, including a retry whose `addMember` found the
      membership already there, run before the token is consumed, and a shed that fails
      fails the attempt, which then compensates the membership (8.1e; Resolved decision
      Q105, part 2: `addMember` calls `afterAddMember` only when it inserts, so a shed that
      lived only in the hook was skipped by a failed or retried attempt). The acceptance
      sets the shared context (`apps/api/src/identity/identity-context.ts`), inside which
      the hook leaves the shed to that step and makes no `_user` write for the
      acceptance's own member (Q120; 8.1e); the step
      keeps the session that carries the acceptance until the attempt's `_user` step has
      run (8.5k revokes it right after that step, Resolved decision Q122, and 8.5m records
      it when the step removed a link) and
      reports the path `acceptance`, and the
      acceptance's `_user` step runs only after it (Resolved decision Q112), so until the
      links are gone and the sessions revoked the new membership is inert: its `_user` is
      still `Invited` and the resolver rejects it (11.8). **`afterAddMember` keeps its
      shed** for every other membership path (path `membership_hook`, every session
      revoked), before its `_user` write.
      The user may re-link through `/link-social`, which requires step-up. Without it an
      admin of tenant A could link their own identity-provider `sub` to a single-tenant
      user, and a later invitation from tenant B would turn that link, or a session
      already issued through it, into a way into B. Verify: `sso-link-shed.int.test.ts`
      covers "An SSO link its user did not make does not survive into a second tenant":
      a user who is single-tenant in `t1` with a link recorded by `linkSsoAccount`,
      accepting an invitation of `t2` on the existing-account path, ends with no such
      `account` row and no marker, the event emitted once and a sign-in through that
      `sub` no longer reaching the user; the same through `afterAddMember` for a
      membership added directly; a link made through `/link-social` surviving with its
      marker; a link that pre-dates this change (no marker, seeded directly) being shed;
      "A session established through a shed link cannot reach the joined tenant": a
      session minted through the link before the join, with the user then joining `t2`,
      fails `/api/auth/organization/set-active` for `t2` and the `/v1` calls after the
      join on both paths, while on the acceptance path the acceptance carried by another
      session of the user completes (the shed step does not revoke that session; its
      revocation right after the `_user` step is 8.5k's case), each revocation emitting `auth.security.session_revoked` with the reason
      `sso_link_shed` and none emitting `account_unlinked` with the actor `self` for the
      shed link; "A retried acceptance still sheds the link and revokes the sessions": an
      existing-account acceptance of `t2` whose first attempt fails after `addMember`
      inserted the member and before its shed removed the link, with its compensation
      failing too (a failure seam), so the membership stays, and whose retry with the same token finds the membership already
      there, ends with the unmarked link shed, the user's other sessions revoked and the
      event emitted with the path `acceptance` before the token is consumed, and a shed
      that fails fails the attempt with the token unconsumed and the membership it created
      deleted (8.1e), the `_user` of `t2` staying `Invited` while the membership is left
      by the failed compensation; a membership added directly whose hook's shed fails
      leaving its `_user` unwritten (the hook sheds before its `_user` write, Resolved
      decision Q112; the resolver's rejection of the joined tenant before the shed is
      11.8's "A joined tenant stays unreachable until the shed is done"); the shed
      deleting any marker keyed by a row it deletes, and a link left unmarked by a crash
      between the link and its marker (8.5g, seeded directly) being shed at the next
      join; the shed's deletes running on the `tayzu_auth` pool with no Better Auth
      instance (a shed core
      built in a test with only that pool and no `BETTER_AUTH_SECRET` shedding the link
      and revoking the sessions, a revoked session failing `/api/auth/get-session`); and
      the user re-linking through `/link-social` with step-up; "The acceptance holds back
      only its own member's hooks" for the shed: inside an acceptance's shared context, a
      membership of another user with an unmarked link, and one of the same user in
      another tenant, added by the seam of 8.1e, each shed by its hook as outside the
      context (path `membership_hook`), while the acceptance's own member is shed only by
      the acceptance's explicit step;
      `sso-link-race.int.test.ts` covers the interleavings: a link that starts while a
      join is adding the second membership ends refused (it sees two tenants) or shed
      (it committed first), never an unmarked link left on a two-tenant user, over
      repeated runs of both orders, and an existing-account acceptance, whose
      `afterAddMember` runs inside its shared context, taking the lock of 8.5i exactly
      once (a spy on `withUserLock`); and
      `user-sync-wiring.int.test.ts` (4.1b) covers `createApp` passing the port, a
      membership added through Better Auth to a user of another tenant shedding the
      user's unmarked link; and `session-storage-config.test.ts` (new, in
      `packages/auth/src/`) pins, on the options `createAuth` builds, that no
      `secondaryStorage` is set and `session.cookieCache` is not enabled, failing if
      either is. `session-revoked-telemetry.test.ts` (new, in `packages/auth/src/`) covers
      the exported `emitSessionRevoked` emitting the reason it is given, each of the three,
      and the `password_change` revocation of `/change-password` still emitting
      `password_change`.
- [ ] 8.5j An admin `unlinkSsoAccount` revokes every session of the target user
      (Resolved decision Q86), through the internal adapter (`listSessions` and
      `deleteUserSessions`, one of the per-user exceptions that 5.1b names), because a
      session already issued through the link would otherwise outlive the unlink; each
      revocation emits `auth.security.session_revoked` with the reason `sso_link_shed`
      through the exported `emitSessionRevoked` of 8.5h (Q86 gives that one reason to the
      shed and to the admin unlink), and the marker is removed by the hook of 8.5g,
      through its fallback adapter, because this path has no endpoint context. Verify: `sso-unlink-sessions.int.test.ts` covers a session minted
      through the link before an admin unlink being rejected after it (an
      `/api/auth/get-session` and a `/v1` call), the user's session on a second device
      being gone too, the event emitted with the reason, and the unlink of a link that
      does not exist revoking nothing.
- [ ] 8.5k The session paths that the shed still missed are closed, before the mount
      switch (Resolved decision Q106; design D4 step 7). (1) The SSO callback refuses to
      create a session through an account that no longer exists, or that has no marker
      (8.5g) while its user belongs to two or more tenants: a callback that read the
      account before the shed deleted it could otherwise create its session afterwards.
      For example, the callback's `account.update.after` (Better Auth refreshes the linked
      account's tokens before it creates the session) stashes the account row's id for the
      request, and `session.create.before` re-reads that account and its marker and
      refuses with the callback's one uniform rejection, so no session row is written.
      This also refuses every SSO sign-in through a link that pre-dates this change on a
      user who already belongs to two tenants, which no path sheds (no join, and 8.5l
      sheds only before it creates a missing row), and `/link-social` cannot repair such
      a link: for an existing `account` row of the same `sub` and user Better Auth's link
      calls `updateAccount` and never `createAccount` (`oauth2/link-account.mjs`), so the
      marker hook of 8.5g does not run; the repair is an unlink, then a link, in the
      runbook of 16.5 (design D4 step 7; no users exist before `010`, `002` Q78).
      When no account id was stashed for the request it **fails closed** and refuses the
      same way (Resolved decision Q115, G9-3): it cannot tell which account the callback
      signed in through; 8.5g pins `account.updateAccountOnSignIn`, on which the stash
      depends. (2) The shed of 8.5h sweeps the user's sessions a second time after its deletion
      commits, so a session created through the link while the deletion was in flight is
      revoked too. (3) When the shed removed a link at acceptance, the session that carried
      the acceptance is revoked too, as soon as the attempt's `_user` step has run, before
      the `emailVerified` write and the consumption of the token (Resolved decision Q122,
      which replaces Q106's "after the acceptance commits", so that an attempt that fails
      after its `_user` step and is never retried has already revoked it):
      this amends Q86's exemption, because the accepting session may itself have come
      through the shed link; when no shed of the invitation removed a link, the accepting
      session keeps working (a link removed by an earlier attempt's shed is 8.5m's case).
      The acceptance deletes that `session` row through the shed core of 8.5h, in the slot
      that 8.1e runs right after the `_user` step.
      The join is final by then (Resolved decision Q118), so a failure of that revocation
      does not undo it and does not stop the acceptance: the
      failure is logged as `catalog.security.accepting_session_revocation_failed` (declared
      in 15.1) with the tenant, the invitation id and the opaque user id and no email
      (Resolved decision Q115, G9-5), and the runbook of 16.5 and the ticket "Alerts for
      `010`" cover it. Each revocation emits `auth.security.session_revoked` with the reason
      `sso_link_shed`. Verify: `sso-link-shed-sessions.int.test.ts` covers "A sign-in
      through a shed link creates no session" (a callback held by a seam between its
      account read and its session creation while the shed deletes the link, then
      resumed, failing with the uniform rejection and leaving no session row; a callback
      through an unmarked link of a user of two tenants, seeded directly as a link that
      pre-dates this change, refused the same way, a `/link-social` of the same `sub` by
      that user writing no marker and the callback still being refused, and the same user
      after an unlink and a new `/link-social` having a marked link and signing in; a
      callback for which no account id was
      stashed, by a seam that suppresses the stash, refused the same way with no session
      row; and a callback through a marked link of
      the same user succeeding), "A session created during the shed is swept" (a session
      created through the link between the shed's first sweep and its deletion commit, by
      a seam, being revoked by the second sweep, with the event emitted), and "The
      accepting session is revoked when the shed removed a link" (the session revoked
      after the `_user` step and before the `emailVerified` write and the token
      consumption, a recording seam on the steps showing the order, the acceptance
      answering success and its session then failing `/api/auth/get-session` and a `/v1`
      call, with the event emitted, and an acceptance by a user whose only link they made
      keeping its session), and "A failed revocation of the accepting session is logged" (a
      seam that makes the deletion after the `_user` step fail: the join is not undone,
      the acceptance completes and
      `catalog.security.accepting_session_revocation_failed` is emitted with opaque ids
      only).
- [ ] 8.5l The reconcile of 4.2b runs the shed of 8.5h, with its session revocation and
      under the lock of 8.5i, **before** it creates the `_user` of a member whose user holds
      two or more memberships (Resolved decision Q105, part 4; design D1): the new row
      makes the member admissible (11.8), and an unmarked link would otherwise reach the
      second tenant through it. The script calls the shed core of 8.5h directly on its
      `tayzu_auth` pool (Resolved decision Q114): it builds **no Better Auth instance** and
      holds no `BETTER_AUTH_SECRET`, so the job cannot sign a session cookie or decrypt the
      JWKS key (it still reaches Cerbos, at its own sidecar, for the `_user` write that
      follows the shed; 2.0b, design D9), and the shed reports the path
      `reconcile` (declared in 15.1). A shed that fails leaves that member's row uncreated
      (fail closed: the member stays rejected with `user_missing` until a later run).
      Verify: `reconcile-users.int.test.ts` covers "The reconcile sheds before it creates
      a `_user`": a member of `t1` and `t2` with no `_user` in `t2` and an unmarked link
      ends with the link shed, the user's sessions revoked and the event emitted with the
      path `reconcile`, and only then the row created; a single-tenant member's unmarked
      link being left alone; a marked link being kept; a failing shed leaving the row
      uncreated; and the script doing all of it with no `BETTER_AUTH_SECRET` in its
      environment and without building Better Auth (a spy on `createAuth` never called).
- [ ] 8.5m A retried acceptance revokes the session that an earlier attempt's shed kept
      (design D4 step 7; a consistency fix within Resolved decision Q106, no new
      decision; its timing is Resolved decision Q122). An attempt whose shed removed a
      link can fail before its `_user` step (8.1e compensates such a failure), and the
      retry's shed removes nothing, so the condition of 8.5k (3) never holds for the retry
      that reaches its `_user` step, while the session that the first attempt kept,
      possibly issued through the shed link, survives. So when the shed core of 8.5h removes a link on the acceptance path,
      it also writes, in the same `withUserLock` transaction as the deletion
      (parameterized SQL, no migration), an `auth.verification` row whose identifier is
      `invitation-shed:<invitationId>`, whose value is the `session` row id of the session
      it kept (never the session token) and whose `expiresAt` is the invitation's, so the
      record commits exactly when the deletion does; a later shed of the same invitation
      that removes a link replaces it (a session that the earlier record names and that
      shed does not keep has already been revoked by it). The write **deletes every
      `verification` row with that identifier and then inserts the new row** with an id
      that the core generates (design D4 step 7; a mechanical fix, no new decision):
      `identifier` has only a non-unique index and `id` is a text primary key with no
      default (`packages/db/migrations/0002_auth_schema.sql`,
      `packages/auth/src/persistence/schema.ts`), so an `ON CONFLICT (identifier)` upsert
      would fail. **Every attempt, as soon as its
      `_user` step has run** and before the `emailVerified` write and the consumption of
      the token (Resolved decision Q122), revokes through the core its own session and the
      session that the record names whenever its own shed removed a link or the record
      exists, each revocation emitting `auth.security.session_revoked` with the reason
      `sso_link_shed`, and deletes the record after a successful revocation, so a later
      retry revokes nothing more and a retry after a crash between the shed and the
      revocation still finds the record; a failed revocation logs
      `catalog.security.accepting_session_revocation_failed` (8.5k), does not stop the
      acceptance and leaves the record to expire with the invitation. Verify: `sso-link-shed-sessions.int.test.ts` covers
      "A retried acceptance revokes the session an earlier attempt's shed kept": an
      existing-account acceptance of `t2` by a user of `t1` with an unmarked link, whose
      first attempt sheds the link and then fails at the `_user` step (a failure seam;
      8.1e compensates the membership), leaving the record with that attempt's session
      id, and whose retry with the same session sheds nothing and commits, ending with
      that session failing `/api/auth/get-session` and a `/v1` call, the event emitted and
      the record gone; the same retry made with a new session of the user, signed in
      after the first attempt, revoking both that session and the first attempt's; a
      second attempt whose shed removes an unmarked link recorded again after the first
      attempt (seeded directly, as an admin's `linkSsoAccount` records one), and that
      also fails at the `_user` step, leaving exactly one
      `verification` row with that identifier, naming the second attempt's session (the
      delete-then-insert above); an
      acceptance whose attempts never removed a link writing no record and keeping its
      session; a revocation that fails (a seam) leaving the record in place and
      emitting `catalog.security.accepting_session_revocation_failed`; "An attempt that
      fails after its `_user` step has already revoked the sessions": an attempt whose
      shed removes the link and that then fails at the `emailVerified` write (a failure
      seam) having already revoked its own session and the session a previous attempt's
      record named, the events emitted and the record gone, with no retry needed, and a
      retry with a new session of the user then revoking nothing more and completing the
      acceptance; and a consumption whose token delete removes zero rows because a resend
      replaced the digest after the `_user` step (a seam), the attempt failing as a lost
      race (the uniform rejection, reason `consume_conflict`) with its session and the
      recorded one already revoked and the record gone.
- [ ] 8.6 Acceptance never links an account by an email claim. Verify:
      `invitation-accept.int.test.ts` covers "Acceptance does not link an SSO
      account by email" (no `account` row for the SSO provider exists afterward).
- [ ] 8.7 Every rejected acceptance (nonexistent, expired, cancelled, rejected,
      already accepted, wrong token, `Disabled` user, an inviter who is no longer an active admin, a tenant at its 100-member
      limit, no or mismatched session for an existing account, a lost race to consume the
      token, whose case is 8.3's) returns the same status, error
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
      leaves the invitation `pending`. An accepted invitation, which 8.3 marks
      `accepted`, and a cancelled or rejected one are skipped by resend (7.7) and cancel
      (7.6), which read its status
      through the repository of 5.1b and act only on a `pending` invitation (Resolved
      decision Q123; Better Auth's `cancelInvitation` does not check the status), and it
      no longer counts toward the 100 pending invitations of 7.12. The status read is not
      atomic with the `accepted` write of 8.3; that window is a documented residual and
      adds no race case here (Resolved decision Q128; design Risks, ticket TK12-1). The
      refused resend answers `CATALOG_VALIDATION_FAILED` with one fixed message (design
      D4 "Resend"), and the refused cancel answers the same code with the same message,
      changing nothing and logging nothing (Resolved decision Q129). Verify:
      `invitation-accept.int.test.ts`
      covers "Accepting a cancelled or already-accepted invitation fails" (the accepted
      one denied with the reason `already_accepted`) and "A
      wrong token fails"; and `invitations.int.test.ts` covers "An accepted invitation is
      not resent or cancelled": after an acceptance, a resend is refused with
      `CATALOG_VALIDATION_FAILED`, its fixed message and no provider text, with no new
      token row, no email to the recording fake and no `catalog.audit.invitation_resent`,
      an explicit cancel is refused with `CATALOG_VALIDATION_FAILED` and the same fixed
      message, with no provider text, changes nothing and logs nothing (no
      `catalog.audit.invitation_cancelled` and no other log event of the cancel), the
      invitation staying `accepted` throughout, the same two refusals, with nothing
      changed and nothing logged, for an invitation already `cancelled` by an earlier
      cancel and for one seeded directly as `rejected` (Resolved decisions Q123 and
      Q129), a cancel of a missing or foreign invitation still answering
      `CATALOG_NOT_FOUND`, and an organization holding 99
      pending invitations and that accepted one (seeded directly) still allowing a new
      invitation, its 100th pending one.
- [ ] 8.11 A pending invitation of a user who was disabled afterward does not
      revive them. Verify: `invitation-accept.int.test.ts` covers "A disabled user
      is not revived by a pending invitation".
- [ ] 8.12 A password that fails the policy is reported only after the token
      has verified. Verify: `invitation-accept.int.test.ts` asserts a bad password
      with a wrong token returns the generic rejection, and with a valid token
      returns `CATALOG_VALIDATION_FAILED` without consuming the token (a second
      attempt with a compliant password and the same token then succeeds), and that a
      password whose SHA-1 suffix is in the stubbed range of 8.1b, with a valid token,
      is refused on acceptance naming the breached-password rule, with nothing created
      and the token not consumed (spec "A breached password is refused").
- [ ] 8.13 The public accept route has its own limiter, a Fastify `preHandler`
      that consumes a bucket of the DB-backed store through the helper of 6.10 (scope
      `invitation_accept`, keyed by the hash of `request.ip` as Fastify resolves it under the app's trust
      setting, a first-deployment gate: `server.ts` trusts every private range today), so
      it is shared across replicas; it is not the
      in-memory `createRateLimit` of the other routes. It answers `AUTH_RATE_LIMITED`
      with `Retry-After` (6.8b), with its default in `apps/api/src/config.ts`. Verify:
      `accept-rate-limit.test.ts` covers "The accept route is rate-limited" on the
      preHandler alone with an in-memory store, asserting the limit fires before any
      invitation lookup (the route is not mounted here), and
      `invitation-rate-limit-store.int.test.ts` (6.10) the shared count.
- [ ] 8.14 Two invitations of two tenants for the same new email accepted
      concurrently create exactly one user. Verify: `invitation-accept.int.test.ts`
      covers "A concurrent account creation yields one user": the
      loser answers the uniform rejection (`denial_reason` `account_conflict`), its
      `createUser` fails on the unique email, it created nothing and so compensates
      nothing, and its token is not consumed.
- [ ] 8.15 When an invitation whose role is `admin` is accepted, on either path,
      the fixed `AdminAcceptedNotice` (6.11) is sent through the dispatcher of 6.12 to the
      other administrators of the organization (`Disabled` ones included, at most 20), one email per recipient,
      resolved on the server (Resolved decisions Q39 and Q53); a send failure never
      blocks the acceptance and logs `catalog.security.admin_notice_failed`, and a
      suppression logs `catalog.security.notice_suppressed`. **When** it is sent depends
      on the path (Resolved decision Q122; design D4 step 6): on the existing-account path
      the attempt whose `_user` step activated the row (the adapter's entry point of 4.1
      returning `invitation_accepted` or `created_active`; on no status event it sends
      none) sends it in the slot that 8.1e
      runs right after that step, before the `emailVerified` write and the consumption of
      the token, and a retry, whose `_user` step writes nothing, sends none; on the
      new-account path it is sent after the acceptance commits (the token consumed), or
      when the consumption changes no row (8.1e), which compensates nothing, whether or
      not the attempt's own `_user` step activated the row, and a failure that is
      compensated sends none (Resolved decision Q127; design D4 step 6). Verify:
      `invitation-accept-notice.int.test.ts` covers "An accepted admin invitation
      notifies the other admins" with the recording fake (an owner, two admins other
      than the invitee and a `Disabled` admin each receive exactly one email, a plain member and the invitee
      none, a `member` invitation sends none) and a failing sender not stopping the
      acceptance; "A failure after the `_user` step has already notified the other
      admins": an existing-account `admin` acceptance whose attempt fails at the
      `emailVerified` write (a failure seam) having already sent exactly one notice per
      recipient, with no retry needed, and a retry with the same token, whose `_user`
      step returns no status event, completing the acceptance with no second notice, while a new-account `admin` acceptance whose
      attempt fails and is compensated sends none and its retry that commits sends one;
      and "A token replaced by a concurrent resend leaves nothing owed": an
      existing-account `admin` attempt whose token delete removes zero rows because a
      resend replaced the digest after its `_user` step (a seam) having already sent the
      notice and answering the uniform rejection with the reason `consume_conflict`, the
      invitation staying `pending`, and the acceptance with the resent token completing
      with no second notice; and "A new-account join whose token was replaced by a
      concurrent resend notifies the other admins" (Resolved decision Q127): a
      new-account `admin` attempt whose token delete removes zero rows because a resend
      replaced the digest after its `_user` step (a seam) answering the uniform rejection
      with the reason `consume_conflict` and sending exactly one notice per recipient,
      and the acceptance with the resent token (which runs the existing-account path,
      the account now existing) completing with no second notice, while a new-account
      `admin` attempt that fails and is compensated sends none.

## 9. Org API credentials: viewer, create, rotate and revoke

- [ ] 9.1 (Checkpoint 3) Cerbos policy: `credential.list`, `create`, `rotate` and
      `revoke` on resource kind `credential`, importing `002`'s `same_tenant`
      derived role and carrying the explicit cross-tenant `EFFECT_DENY` of `002` D8,
      `admin`-only. Verify: `cerbos compile` runs `policies/resource_policies/credential_test.yaml` (with its resources in the shared `testdata/resources.yaml`) covering
      each action × admin/non-admin × same/other tenant, including the explicit
      cross-tenant deny and the admin being allowed, and extends `same_tenant_test.yaml`
      (the existing "denied on every kind" suite) with kind `credential`. ⛔ **Stop for
      Checkpoint 3 approval of the policy diff before continuing.**
- [ ] 9.1b The `organization` plugin defines all three roles (`owner`, `admin`,
      `member`) with their default statements, because custom roles replace the
      defaults and `organization()` has no `ac` or `roles` today, and adds `apiKey`
      create, read, update and delete to `admin` only. `createMachineCredential` and
      `revokeMachineCredential` are called headerless with `body.userId` the acting
      admin's Better Auth user id (not the `metadata.userId` of the key). Better Auth's
      organization-permission check still runs with `body.userId` and passes for an
      admin only because of the `apiKey` grant, so it never refuses what Cerbos allowed
      and Cerbos is the real gate (Resolved decision Q29). `CreateMachineCredentialParams`
      (`machine-credentials.ts`) requires `headers` and fixes the key's metadata today,
      so it changes: `headers` goes, `userId` is required and the metadata (`userId` and
      `createdBy`) is supplied by the caller. `RevokeMachineCredentialParams` also
      requires `headers` today, and `revokeMachineCredential` calls the session-bound
      `getApiKey` and `updateApiKey` with them, so it changes the same way: `headers`
      goes, the acting admin's `userId` is required, the key is read through the
      adapter-level key lookup of the repository of 5.1b (filtered by `referenceId` and
      `configId`; 9.11 adds the mapping of a foreign or unknown id to
      `CATALOG_NOT_FOUND`) instead of `getApiKey`, and `updateApiKey` is called headerless with `body.userId`. The grant is a permission set that only
      Better Auth's check reads: it is neutralized, and ADR-0013 records that (16.3,
      Resolved decision Q94). The identity operations that call the helpers are 9.5 and
      9.9, so the create and revoke through an operation are their cases. Verify:
      `org-api-key-access.int.test.ts` covers a Better Auth
      `admin` member who is not the owner creating and revoking an org key by calling the
      changed `createMachineCredential` and `revokeMachineCredential` directly, headerless
      with `body.userId`, an `owner` doing the same (custom roles replace the
      defaults, so the owner's `apiKey` permissions are asserted too), the three roles still holding every default permission (an
      `admin` can still create and cancel an invitation, a `member` cannot manage keys),
      the key's `body.userId` being the admin's id, and that neither helper forwards
      session headers any more (`@ts-expect-error` cases show that
      `CreateMachineCredentialParams` and `RevokeMachineCredentialParams` take none), a
      revoke of another tenant's key still throwing `AuthContextError` without a
      revocation row. The five existing integration tests that call the
      helpers with session headers (`bootstrap-wiring`, `otel-smoke-check`,
      `machine-credentials`, `token-exchange` and `context-resolver`, all
      `*.int.test.ts`) are migrated to the headerless call with `body.userId`, and pass.
- [ ] 9.1c The machine-credential functions are exported only on a subpath,
      `@tayzu/auth/machine-credentials` (a new entry in the `exports` of
      `packages/auth/package.json` pointing at `./src/machine-credentials.ts`, like
      the other just-in-time exports), and not from the package index, and a lint
      rule limits their importers to `apps/api/src/identity/**` (Resolved decision
      Q78). The rule is added to the one restriction module of 5.1c
      (`eslint/identity-restrictions.js`), which merges it with the 5.1c restrictions for
      the files both match (`identity-router.ts`), because a later flat-config block
      replaces the earlier setting of the same rule; `eslint.config.js` has no
      `no-restricted-imports` entry yet, so this is where the rule is introduced. It
      covers the subpath and a relative path to the file, with test files exempt; the two tests in `apps/api` that
      import the file by a relative
      `../../../packages/auth/src/machine-credentials.js` path
      (`bootstrap-wiring.int.test.ts` and `otel-smoke-check.int.test.ts`) switch to
      the subpath. Verify: `machine-credentials-import-lint.test.ts` (in
      `apps/api/src/identity/`) lints scratch sources with `ESLint#lintText` over the restriction module of 5.1c
      (5.1c explains the setup) and covers an import from `apps/api/src/server.ts`
      failing (the subpath and the relative path), an import from
      `apps/api/src/identity/credentials.ts` passing, an import from a test file
      passing, `identity-router.ts` getting both this restriction and the adapter
      restriction of 5.1c (an import and a direct `member` read each failing), and
      `pnpm lint` staying green on the real tree; and `pnpm --filter
      @tayzu/api test` passes with the two migrated tests.
- [ ] 9.2 `identity.credentials.list`: projects org-owned API keys to `{ id, name,
      kind, prefix, createdAt, lastRequest, enabled, rotationDueAt, createdBy }`.
      `id` is the opaque key id that rotate and revoke take as `{credential}` (the
      view had no id to address a credential by), `prefix` is the constant
      `tayzu_mc_` because no first characters of a secret are stored (9.5), and
      `createdBy` is the opaque id of the creating admin that the key's metadata
      records (absent for a key created without it). `kind` is one of
      `service_account`, `integration` and `agent`. `listApiKeys` is session-bound
      and has no server-side `userId`, so the read is an adapter-level query,
      through the repository of 5.1b, of the `apikey` table filtered by `referenceId
      = ctx.tenantId` and the `machine-credential` `configId`. The page is at most
      the configured credential cap of 9.5d (**200** by default), with the
      non-revoked credentials listed before the revoked ones and `truncated: true`
      when revoked ones were left out, so no credential a tenant can hold is hidden
      from an admin who needs to revoke it (a tenant holds at most the cap of
      non-revoked ones). `apikey.metadata` is a
      `text` column in SQL, but the adapter returns an object because of the
      plugin's `transform.output` (a raw SQL read returns text), so the
      `metadata.userId` and `actorKind` filters are an application-side filter over
      pages, and every reader that must see **all** of a tenant's keys, 9.5b, 9.11,
      10.7 and the caps, uses a paged lookup that reaches the end and never this
      limit. It joins `metadata.userId` to the `_user` entity for service-account
      keys and never selects the hashed `key` column into the response shape.
      Verify: `credentials.int.test.ts` covers "Listing never includes the secret",
      "Non-admin cannot list credentials", the page limit applying, a tenant with
      200 non-revoked and 30 revoked credentials listing all 200 non-revoked ones
      with `truncated` set, with the cap configured to a value other than 200 every
      non-revoked credential up to that cap being listed, an `id` in each entry equal to the key's opaque `apikey` id
      (that `rotate` accepts it is 9.6's case), `createdBy`
      being the creating admin's opaque id, the adapter's `metadata` shape (an
      object) being pinned by an assertion while the reader accepts both an object
      and a JSON string, and the paged lookup finding a key beyond the limit (a
      tenant seeded with more keys than the limit).
- [ ] 9.3 A credential is shown disabled when its key is disabled, it is
      revoked, or its bound service account is `Disabled`. Verify:
      `credentials.int.test.ts` covers each of the three cases.
- [ ] 9.4 `rotationDueAt` is computed from the credential's `metadata.rotatedAt`, or
      from its `createdAt` for a credential never rotated, plus the configured interval
      (default 90 days). Verify: `credentials.test.ts` (pure) covers a credential
      rotated 91 days ago flagged due and one rotated yesterday not, and a credential
      never rotated, created 91 days ago, flagged due and one created yesterday not.
- [ ] 9.5 `identity.credentials.create` (integration and agent credentials): the
      per-key rate limit of **60 verifications per hour**, configurable in
      `apps/api/src/config.ts` with `limitWithDefaults` (a disabled or zero value fails
      startup; Resolved decision Q44), and the no-stored-secret-characters setting are
      plugin-level configuration of the `machine-credential` apiKey config (`rateLimit`,
      `startingCharactersConfig`), because `createApiKey` rejects per-key `rateLimit*`
      properties when given `headers` or a request; the call is headerless (9.1b). No
      hard expiry is applied (Resolved decision Q20), and the metadata is
      `{ actorKind, role: 'member', userId?, createdBy }`, `userId` being the `svc-…` identifier of the bound service account (Resolved decision
      Q90) and `createdBy` the acting admin's opaque id (design D6, D7). The limit's `timeWindow` is in
      milliseconds and is copied into each key at creation, so a later configuration
      change applies to new keys only. The key `name` is 1 to 32 characters of
      `[A-Za-z0-9 _.-]` (the plugin allows 32 and service-account identifiers run to
      63, so a service account's key gets a fixed label, 10.3). Verify: `credentials.int.test.ts`
      covers "Creating a credential requires step-up and bounds its use" at the
      service level (the key's metadata records `createdBy`): the created key has the configured limit (60 per hour by default,
      and a configured value is honored) and stores no secret characters, a changed limit
      applying only to keys created afterwards, a 33-character name refused, a Better
      Auth `admin` member who is not the owner and an `owner` each creating a key
      through the operation with the headerless call of 9.1b, and
      `config.test.ts` a zero or disabled limit failing startup (the step-up part is
      asserted over HTTP in 14.4).
- [ ] 9.5b The optional `userId` of `identity.credentials.create` is resolved
      server-side within the caller's tenant to a service-account `_user`, through
      the service-account resolver of 10.7b once that exists (a lookup of the same
      shape until then); a human, an unknown id or another tenant's service account
      answers `CATALOG_NOT_FOUND`, and a service account that already has an active
      credential is refused with `CATALOG_VALIDATION_FAILED` (Resolved decision Q40:
      exactly one active credential per service account). Verify:
      `credentials.int.test.ts` covers "A credential cannot be bound to a user
      outside the tenant or to a human" and "A service account holds one active
      credential": a second create for a service account with an active credential
      is refused, and one for a service account whose credential was revoked
      succeeds.
- [ ] 9.5c Creation of a credential bound to a service account takes a
      **per-service-account advisory lock**, introduced here, that rotation (9.6b) and
      deletion (10.7) also take, so the check-then-insert
      of Q40 cannot be raced by two concurrent creates (the partial unique index of the
      same invariant is a ticket). Verify: `credentials.int.test.ts` covers
      "Concurrent credential creation for one service account yields one": two
      concurrent creates bound to one service account with no active credential,
      exactly one succeeding, the other refused with `CATALOG_VALIDATION_FAILED`, and
      exactly one active credential afterward.
- [ ] 9.5d A tenant holds at most 200 non-revoked credentials (Resolved decision
      Q56), configurable in `apps/api/src/config.ts` as a single cap with the
      `optionalPositiveInt` parser (`limitWithDefaults` takes a maximum and a window
      pair, which a cap is not), its default in code and a disabled or zero value
      failing startup. `identity.credentials.create` and the key issued by
      `identity.serviceAccounts.create` count them through the paged lookup and
      refuse the creation beyond the cap with `CATALOG_VALIDATION_FAILED`, under a
      per-tenant advisory lock so concurrent creates cannot overshoot. Verify:
      `credentials.int.test.ts` covers "The credential cap and the name limit hold"
      (200 seeded keys, the 201st refused, two concurrent creates at 199 yielding
      one success, a revoked key not counting) and `config.test.ts` a zero or
      disabled cap failing startup.
- [ ] 9.6 `identity.credentials.rotate`: creates the new credential, whose metadata
      copies the old key's `actorKind`, `role` and `userId`, records the rotating admin
      as `createdBy` and the rotation time as `rotatedAt` (design D8), revokes the
      old one through `revokeMachineCredential` (the revocation list), and returns
      the new secret once. Verify: `credentials.int.test.ts` covers "Rotating
      replaces the usable credential", addressing the old credential by the `id` that
      `identity.credentials.list` (9.2) returns for it and asserting the old credential's already-issued
      token and any new exchange are rejected within the cache window, the new key's
      metadata carrying the old key's `actorKind`, `role` and `userId`, `rotatedAt` and
      the rotating admin's opaque id as `createdBy`, and its `rotationDueAt` (9.4)
      computed from that `rotatedAt`.
- [ ] 9.6b Rotation is serialized per service account: it takes the
      per-service-account lock of 9.5c for the whole rotation (per credential for an
      unbound integration or agent credential), and a revoked credential may be rotated only when its
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
      `credentials.int.test.ts` covers "Revoking a credential is permanent", and a Better
      Auth `admin` member who is not the owner and an `owner` each revoking a key through
      the operation with the headerless call of 9.1b.
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
      admin, and extends `same_tenant_test.yaml` (the existing "denied on every kind"
      suite) with kind `service_account`, and `service-account-wrapper.int.test.ts` runs the
      wrapper of 5.3b2 against the real Cerbos container: an admin passes both checks
      for `create` and `delete` (the first check carries `accountKind: service`) and a
      member is denied at the first. ⛔ **Stop for Checkpoint 3 approval of the
      policy diff before continuing.**
- [ ] 10.3 `identity.serviceAccounts.create` (in `apps/api`): writes the `_user` entity
      (`status: Active`, written through `created_active` by the Q30 adapter,
      `accountKind: "service"`, role `member`, empty
      `moderatedBlueprints`) as `system` with `onBehalfOf` the admin, and issues an
      organization-owned key by reusing `002`'s `machine-credential` apiKey config,
      headerless with `body.userId` the acting admin's id (metadata `{ actorKind:
'integration', role: 'member', userId, createdBy }`, `userId` being the service account's `svc-…` identifier (Resolved decision Q90) and
      `createdBy` the acting admin's),
      returning `clientId`/`clientSecret` once. The key's `name` is a fixed label,
      because the plugin limits it to 32 characters and the identifier can run to 63;
      the viewer shows the identifier through the `_user` join (9.2). Under the
      per-service-account lock of 9.5c it first looks for a non-revoked key of the tenant
      whose `metadata.userId` is the new identifier (the paged lookup of 9.11), for example
      one that survived the failed deletion of an earlier service account of the same
      identifier, and refuses the creation with `CATALOG_VALIDATION_FAILED` (13.3 later
      gives every conflict one fixed message) when one exists, before anything is written: the new account would
      otherwise start with a second active credential (Resolved decision Q40; design D6)
      and the old key would resolve again. Its `created_active` write emits
      `catalog.audit.user_status_changed` (4.1e) with the admin as `tayzu.actor.id` and
      the `svc-…` identifier as `tayzu.identity.service_account.id` (Resolved decision
      Q117), and the creation emits `catalog.audit.service_account_created` (declared in
      15.1) with the same two attributes (design, Observability contract). Verify:
      `service-accounts.int.test.ts`
      covers "Service account is active immediately, no email", asserting the
      `EmailSender` fake recorded zero calls, that the key's metadata records the creating
      admin as `createdBy`, that a later read never includes the secret and that one
      `catalog.audit.user_status_changed` names the admin and the `svc-…` identifier, and
      one `catalog.audit.service_account_created` carrying the admin as `tayzu.actor.id`
      and the `svc-…` identifier, and "A new
      service account does not inherit a surviving credential": with a non-revoked key
      bound to `svc-ci-github` seeded directly and no such `_user`, the creation of
      `svc-ci-github` is refused with nothing created, and it succeeds once that key is
      revoked (that the surviving key does not resolve is 11.6's and 11.7's case).
- [ ] 10.3b If issuing the key fails after the `_user` was written, the `_user`
      entity is removed again (compensation) and the failure is recorded as the error
      of the `identity.service_account.create` span (no new event; design D6), so no
      service account without a credential is left behind. Verify: `service-accounts.int.test.ts`
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
      the port for the `_user` lookup that 11.7 needs (`045` adds the deletion-marker lookup);
      the principal stays `{ roles: ['member'], teams: [], moderatedBlueprints: [] }`
      from the signed claim. Verify: `token-exchange.int.test.ts` covers "A tampered
      `_user` row does not raise the principal".
- [ ] 10.7 `identity.serviceAccounts.delete`: revokes **every** non-revoked
      `apikey` with `referenceId = ctx.tenantId` and `metadata.userId` equal to the
      service account's `svc-…` identifier (Q90) through the revocation list (found by the paged adapter-level lookup of 9.11, never limited like the viewer, not only "the" credential), after the target has been resolved through the service-account resolver of 10.7b once that exists (a lookup of the same shape through the target helper of 5.2 until then; the refusal of a human target is 10.7b's case), then removes the
      `_user` entity as `system` with `onBehalfOf` the admin (Resolved decision Q40), with
      `detachReferences`, because a relation that targets the `_user` is a `RESTRICT`
      foreign key (`catalog_entity_relation_target_fk`) that would otherwise fail the
      delete. The whole deletion holds the **same per-service-account advisory lock** as
      the creation and the rotation of its credentials (9.5c, 9.6b; design D6, D8), so a
      credential created or rotated while the account is being deleted cannot survive the
      deletion.
      Verify: `service-accounts.int.test.ts` covers "A credential created during a
      deletion does not survive it": a `credentials.create` bound to the service account
      and a rotation of its credential, each started while the deletion holds the lock (a
      seam), ending with no non-revoked key bound to the deleted identifier; and "Deleting a service account
      revokes its credential", asserting the credential cannot be restored, and
      "Deleting a service account revokes every bound credential": a service account
      with two non-revoked credentials (seeded directly, as before the one-credential
      rule) is deleted and both are rejected within the 5-second cache window, and a service account that a
      relation targets being deleted all the same.
- [ ] 10.7b Every `service_account` route (`serviceAccounts.delete`; `setStatus`
      reaches the service-account branch only for a resolved service account, 11.5)
      and the `userId` of
      `credentials.create` (9.5b) resolve their target through one server-side
      resolver that answers `CATALOG_NOT_FOUND`, identical to an unknown id, unless
      the resolved `_user` has `accountKind == "service"` **and** an `svc-`
      identifier (Resolved decision Q62; design D6, D14), including for the caller's
      own `_user` and an owner's, and that passes the resolved `accountKind` to
      Cerbos (10.2). Without it `DELETE /v1/service-accounts/alice@x.com` would
      remove a human's `_user` row as `system`: the human would be locked out with
      `user_missing`, no `Disabled` state or `user_status_changed` event would exist
      and the reconcile would later recreate the row as `Active`. Reads go through
      the repository of 5.1b. Verify: `service-accounts.int.test.ts` covers "A
      service-account route refuses a human target": a delete of another human, of
      the admin's own address and of an owner each answering the same
      `CATALOG_NOT_FOUND` as an unknown id, with the human's `_user` row and status
      intact, no credential revoked and no event emitted, and a standard `_user`
      with an `svc-`-shaped identifier (seeded directly) refused too;
      `credentials.int.test.ts` covers a `credentials.create` bound to such a
      `_user` and to a human being refused with the same answer.

- [ ] 10.8 A tenant holds at most 50 service accounts (Resolved decision Q56),
      configurable in `apps/api/src/config.ts` as a single cap with the
      `optionalPositiveInt` parser (a cap is not a maximum and window pair), its
      default in code and a disabled or zero value failing startup.
      `identity.serviceAccounts.create` counts the tenant's `_user` entities with
      `accountKind: "service"` and refuses the creation beyond the cap with
      `CATALOG_VALIDATION_FAILED`, under a per-tenant advisory lock. Verify:
      `service-accounts.int.test.ts` covers "The per-tenant service-account cap
      holds" (50 seeded, the 51st refused with nothing created, two concurrent
      creates at 49 yielding one success) and `config.test.ts` a zero or disabled
      cap failing startup.

## 11. Disable takes effect immediately, ⛔ Checkpoint 3 (migration `0011`)

- [ ] 11.0 _(setup)_ Every existing human-session `/v1` integration test needs a
      `_user` row for its member, because 11.8 makes the resolver reject a member
      with none. No fixture writes one today: `admin-user.ts` and the fixtures under
      `apps/api/src/__fixtures__/` create Better Auth users and memberships only,
      and of the 23 test files that call `createAuth(` only two pass `userSync`. The
      shared fixtures write the member's `_user` row with status `Active`: the
      fixtures in `apps/api` through the adapter of 4.1 and those in
      `@tayzu/catalog` through `createUserSync`, while `@tayzu/auth` has no
      dependency on either (task 1.4 forbids adding one), so its fixtures
      (`admin-user.ts`: `createAdminUser`, `signInAdminUser` and `bootstrapTestTenant`,
      which take only `auth` today, so they gain a `tayzu_app` pool parameter and every
      caller passes one) insert the entity with parameterized SQL on that pool, with the
      tenant set through `set_config`, as test data only: the statements insert the
      `_user` entity row against the tenant's `_user` blueprint row (inserted too when
      the tenant has none) and the entity's `created` change event, so that the entity,
      blueprint and history rows stay consistent.
      Every test file that builds its members by hand migrates to them. Verify:
      `pnpm --filter @tayzu/auth test`, `pnpm --filter @tayzu/api test` and `pnpm
      --filter @tayzu/catalog test` stay green with the rejection of 11.8 applied in
      a scratch branch (a member without a row fails, a member with one passes).
- [ ] 11.1 (Checkpoint 3) Migration `0011_machine_credential_revocation_tenant_key`:
      `machine_credential_revocation` gets a composite `(tenant_id, credential_id)`
      key, with `migrations/down/0011_machine_credential_revocation_tenant_key.down.sql`,
      `meta/0011_snapshot.json` and its
      `_journal.json` entry (the revocation lookup already filters on both columns,
      `credential_id = $1 and tenant_id = $2` in `context-resolver.ts`, so what changes
      is the key itself and the stale comment on the old key in `schema.ts`).
      The matching change in `packages/catalog/src/persistence/schema.ts` is part of
      this task. Verify: `revocation-key.int.test.ts` covers that a row for `(t2, c1)`
      neither blocks nor shadows `(t1, c1)`, and that a lookup for `t1` ignores `t2`'s
      row. ⛔ **Stop for Checkpoint 3 approval of the SQL before continuing.**
- [ ] 11.1b The revocation **cache** in `resolveContext` is keyed by
      `(tenantId, credentialId)`, not by `credentialId` alone. Verify:
      `context-resolver.int.test.ts` covers a revocation in one tenant not poisoning
      the cache of another: credential id `c1` revoked in `t2` and cached, then a `t1`
      principal with the same id is still accepted.
- [ ] 11.1c The startup assertion on the runtime database roles covers
      `machine_credential_revocation` (Resolved decision Q109). `assertRuntimeRole` in
      `apps/api/src/bootstrap.ts` fails for a superuser, for `BYPASSRLS` and for the owner
      of a relation whose name matches `catalog\_%`, which `machine_credential_revocation`
      (whose key 11.1 changes) does not, so a runtime role that owned it would pass. The
      check lists that table by name as well. This removes `043`'s last dependency on
      `045` (whose task 2.4 adds only its own marker table) and closes that part of the
      first-deployment gate here (design, Gates). Verify: `bootstrap-wiring.int.test.ts`
      (in `apps/api/src/`, whose runtime-role suite runs `createAppFromEnv` with a
      `NODE_ENV` other than `test`) covers startup failing when a runtime role owns
      `machine_credential_revocation`, with the fixed message and no connection detail,
      and still starting with the real `tayzu_app` and `tayzu_auth` roles.
- [ ] 11.2 `identity.users.setStatus` for a human is **tenant-scoped** (Resolved
      decision Q25): it validates through `nextStatus`, checks the Cerbos grant, writes
      `_user.status` as `system` with `onBehalfOf` the admin (appending a change
      event) and revokes only the sessions whose active organization is the tenant,
      through the tenant-keyed `session` delete of 5.1b, each
      revocation emitting `auth.security.session_revoked` with the reason `admin_action`
      (`002`'s declared event, through the exported `emitSessionRevoked` of 8.5h). For
      a user with a **single** membership (counted through `globalMembershipTenantsOf`
      of 5.1b) it also sets `banned` and deletes all their
      sessions through the internal adapter (`internalAdapter.updateUser({ banned })`
      and `deleteUserSessions`, per-user exceptions that 5.1b names, not
      Better Auth's `banUser`/`unbanUser`, which the global role `user` cannot call). `setStatus` to `Active`, for a user whom the
      disable banned (a single membership), clears `banned` through
      `internalAdapter.updateUser({ banned: false })` (an exception that 5.1b names too; the ban hook is skipped without an
      endpoint context, and since Q102 it writes nothing for `banned: false`). Each status
      write emits `catalog.audit.user_status_changed` (4.1e) with the admin as
      `tayzu.actor.id` and the status event `admin_disable` or `admin_enable` (Resolved
      decision Q117). Verify:
      `user-status-op.int.test.ts` covers "Disable and re-enable" (each write emitting one
      `catalog.audit.user_status_changed` with the admin and its status event) and the revocation part
      of "A disabled user's sessions stop working" (the next request on a deleted session
      answering 401 `CATALOG_CONTEXT_REQUIRED`; a session the deletion did not reach is
      13.4's) for a single-membership user through the operation pipeline, with the `auth.security.session_revoked` event (reason `admin_action`)
      emitted for each revoked session, and a re-enabled single-membership user is no
      longer `banned`, is accepted by `resolveContext` and can sign in.
- [ ] 11.3 A user attempting to change their own status is denied and a
      `catalog.security.self_status_change_denied` event is logged. Verify:
      `user-status-op.int.test.ts` covers "A user cannot disable themselves" through
      the email-addressed `{user}` identifier, proving the self-deny compares the
      resolved Better Auth user id and is not vacuous.
- [ ] 11.4 Disabling a user cancels their pending invitations **of that tenant**
      (reason `user_disabled`), skipping any invitation whose status is not `pending`
      (Resolved decision Q123). Verify: `user-status-op.int.test.ts` covers "Disabling
      cancels pending invitations", including an accepted invitation of the same user
      staying `accepted`, with no `catalog.audit.invitation_cancelled` logged for it.
- [ ] 11.4b Disabling a user also cancels the pending invitations that user
      **created** in that tenant (reason `inviter_disabled`, Resolved decision Q63;
      design D13), and enabling restores none; an invitation whose status is not
      `pending` is skipped (Resolved decision Q123). The acceptance check of 8.5f stays the
      authoritative control; this makes the revocation visible. Verify:
      `user-status-op.int.test.ts` covers "Disabling cancels the invitations the user
      created": an admin who created two pending invitations and one that its invitee
      accepted is disabled, the two pending ones become
      `cancelled` with reason `inviter_disabled`, the accepted one stays `accepted` with no
      `catalog.audit.invitation_cancelled` logged for it, an invitation created by another admin
      stays pending, an invitation created by the same user in another tenant stays
      pending, and re-enabling restores none.
- [ ] 11.5 `identity.users.setStatus` for a service account (its `svc-…`
      identifier) writes only `_user.status` (it has no Better Auth user). The branch is chosen by the
      resolved `accountKind` of the target (10.7b), never by the shape of the identifier
      alone. Verify:
      `user-status-op.int.test.ts` covers disable and enable of a service account
      changing only the `_user` entity, each emitting `catalog.audit.user_status_changed`
      with the admin as `tayzu.actor.id` and the `svc-…` identifier as
      `tayzu.identity.service_account.id` (4.1e, Resolved decision Q117), and a human
      target never taking the service-account branch.
- [ ] 11.6 `resolveContext`'s machine branch rejects a principal whose token
      carries a `userId` claim (the service account's `svc-…` identifier, Resolved decision
      Q90) when the bound `_user` is **absent or not `Active`**
      (`Disabled`, or removed by a delete or a tamper; Resolved decision Q40), through
      the 5-second cache, failing closed on any lookup failure, and logs
      `catalog.security.principal_rejected` (reason `service_account_disabled` or
      `service_account_missing`) and increments `tayzu.identity.principal_rejections`.
      A token without the claim is unaffected. The check is selected by the credential branch (a bearer machine token), never by comparing `actor.type`, which lint bans outside three files (design D13). Verify: `context-resolver.int.test.ts`
      covers "Disabling a service account takes effect within seconds" for an
      already-issued token, "A token for a deleted service account is rejected" (a
      credential that survives the delete still does not resolve), a non-revoked key
      bound to an identifier that has no `_user` (seeded as in 10.3) not resolving, and a
      lookup failure rejecting.
- [ ] 11.7 Token exchange refuses to mint a token for a service account whose
      `_user` is `Disabled`, absent or otherwise not `Active`, and re-enabling
      restores the same credential. Verify: `token-exchange.int.test.ts` covers the
      refusal for a `Disabled` and for a deleted service account and for a non-revoked
      key bound to an identifier that has no `_user` (seeded as in 10.3), and
      "Re-enabling restores access without a new credential".
- [ ] 11.8 `resolveContext` admits a **human** only when their `_user.status` in the
      active tenant is `Active` (Resolved decision Q105, part 3, which amends the
      "`Disabled` only" rule of Q25: deny unless `Active`, like the machine branch of
      11.6). Every other status (`Disabled`, `Invited`, `Staged`) is rejected with the
      reason `user_disabled` (which therefore means "present and not `Active`"), answering
      `401 CATALOG_CONTEXT_REQUIRED` with the reason only in the log, like
      `rejectMissingContext` (Resolved decision Q77). This is new code:
      `resolveContext`'s `_user` read (`readUserEntityGrants`) already reads
      `spec_properties`, so `status` is in the row, but it has no cache and on a lookup
      failure it returns a principal-less context, which the pipeline answers with 403
      `AUTH_FORBIDDEN`. The task adds a 5-second cache of the **status only** (the
      grants read stays uncached, as today) keyed by `(tenantId, userId)` and a
      rejection on failure (fail closed); a failed lookup is never cached. It logs
      `catalog.security.principal_rejected` and increments
      `tayzu.identity.principal_rejections`. A member with no `_user` row in the
      active tenant is rejected the same way with the reason `user_missing`, logged
      and counted (Resolved decisions Q46 and Q50; 4.2b repairs it). The check is
      selected by the credential branch (a session cookie), never by comparing
      `actor.type`, which lint bans outside three files (design D13). The test at
      `context-resolver-principal.int.test.ts` (around lines 364-390) asserts today
      the principal-less context and 403 `AUTH_FORBIDDEN` for a failed `_user`
      lookup: it is **rewritten** to this requirement (Resolved decision Q77), and
      the PR description calls the change out. Verify:
      `context-resolver.int.test.ts` covers "A member of two tenants is disabled in
      one only" (the `_user` `Disabled` in `t1` and `Active` in `t2`, seeded directly):
      the same user accepted in `t2`, a second request within 5
      seconds not repeating the lookup, "An `Invited` member is rejected by the
      resolver" (a member whose `_user` in the tenant is `Invited`, as a failed
      acceptance leaves it, and one whose `_user` is `Staged`, each rejected with 401
      `CATALOG_CONTEXT_REQUIRED` and the reason `user_disabled` in the log, while the same
      user is accepted in a tenant where the row is `Active`), a lookup failure rejecting and not being cached (the next request looks again,
      `context-resolver-principal.int.test.ts` around line 384), every rejection
      answering 401 `CATALOG_CONTEXT_REQUIRED` with no reason in the body, and a
      member with no `_user` row in the active tenant rejected with `user_missing`
      (Q46, Q50); `sso-link-shed.int.test.ts` (8.5h) covers "A joined tenant stays
      unreachable until the shed is done" (Resolved decision Q112): a session minted
      through the unmarked link, during an existing-account acceptance of `t2` held by a
      seam between `addMember` and the shed, calls `/api/auth/organization/set-active`
      for `t2` and then a `/v1` route, and the resolver rejects that call (401
      `CATALOG_CONTEXT_REQUIRED`, the `_user` of `t2` not yet `Active`), and after the
      seam is released the shed revokes that session; the same for a membership added
      directly, whose `_user` is written only after the hook's shed; and the rewritten
      case of `context-resolver-principal.int.test.ts` passes.
- [ ] 11.2b For a user with memberships in two tenants, disabling in `t1` revokes
      only the sessions of `t1` and does not set `banned`, so the same user keeps
      working in `t2`; enabling in `t1` restores only `t1`. Verify:
      `user-status-op.int.test.ts` covers "A member of two tenants is disabled in one
      only" and the two-tenant case of "A disabled user is not revived by signing in": a
      sign-in of that user leaves the `Disabled` status of `t1` unchanged and the
      resolver still rejects the user in `t1`.

## 12. Cross-tenant matrix (one test per route, in process; the HTTP twin is 14.8)

All tests live in `cross-tenant.int.test.ts` and seed two tenants.

- [ ] 12.1 `identity.users.invite` creates the invitation only in the host
      tenant and rejects a body that names an organization. Verify: an invitation
      created by `t1`'s admin has `organizationId = t1`, and a body with an
      organization or tenant field is rejected.
- [ ] 12.2 `identity.users.cancelInvitation` and `resendInvitation` on another
      tenant's invitation answer `CATALOG_NOT_FOUND`, the same as an unknown id.
      Verify: "Another tenant's invitation cannot be cancelled or resent"
      for cancel and resend, asserting the invitation is unchanged and no email was
      sent.
- [ ] 12.3 The acceptance of an invitation of `t2`, for a new and for an existing
      account (with its session), creates the membership only in `t2`. Verify: the
      accept of `t2`'s invitation leaves `t1` without a new member and no cross-tenant
      write.
- [ ] 12.4 `identity.users.setStatus` on a user whose only membership is in
      another tenant answers `CATALOG_NOT_FOUND`, and on a user with memberships in two
      tenants it acts on the caller's tenant only (Resolved decision Q25). Verify:
      "Another tenant's user cannot have its status changed" and "A member of two
      tenants is disabled in one only" (the other tenant's status, sessions and `banned`
      are untouched).
- [ ] 12.5 `identity.serviceAccounts.create` creates only in the host tenant, and
      `delete` of another tenant's service account answers `CATALOG_NOT_FOUND`.
      Verify: the created entity and key are in `t1`, and the foreign delete leaves
      the service account and its credential intact.
- [ ] 12.6 `identity.credentials.list` and `create`: the list omits other
      tenants' credentials and create writes only the host tenant's `referenceId`, and
      a `userId` of another tenant answers `CATALOG_NOT_FOUND`. Verify: "Another
      tenant's credential cannot be listed, rotated or revoked" for list, the created
      key's `referenceId` being `t1`, and a create bound to `t2`'s service account
      being refused.
- [ ] 12.7 `identity.credentials.rotate` and `revoke` on another tenant's
      credential answer `CATALOG_NOT_FOUND`. Verify: the same scenario for rotate
      and revoke, asserting the credential is still usable and no revocation row was
      written.
- [ ] 12.8 Cerbos receives the target's real tenant, not the caller's (Resolved
      decision Q135): the resource tenant comes from the resolved record, never from
      `ctx.tenantId`. Verify: with a recording Cerbos client, a call on a target of the
      caller's tenant reaches Cerbos with the resource tenant taken from the record, and
      a call whose target belongs to `t2` answers `CATALOG_NOT_FOUND` with no Cerbos
      request carrying a resource of `t2`; the `same_tenant` denial of a principal of
      one tenant on a resource of another is pinned by the Cerbos policy tests.
- [ ] 12.9 `identity.users.create`, `linkSsoAccount` and `unlinkSsoAccount` (the
      three routes `002` already had, Resolved decision Q31): `create` writes only the
      host tenant, a target of another tenant answers `CATALOG_NOT_FOUND`, and a target
      with a membership in two tenants is refused for link and unlink (`002` VCDM
      M10). Verify: "A user with memberships in two tenants cannot be linked" for link and
      unlink, and the foreign target answering the same as an unknown one.

## 13. Hand-offs from 002 (002 design Q73; mount gate)

`identity.*` and the machine-credential operations are not reachable over HTTP
before every task in this group is done. Group 14 is the only place a route is
registered. `002` Q73 hands this change the items M5, M9-M15 and M17-M20 of `002`'s
VCDM re-assessment (M4 is not in that list and is closed here too, 13.6); `002` Q46
(the password, MFA and email-change notifications) is deferred to `044` (Resolved
decision Q92); `design.md` (Risks, "Hand-offs from `002` (`002` Q73): traceability")
records each item and where it is closed. The
items closed by another group are listed, with the tasks that close them, in that
traceability table (M5: 8.1-8.1d; M9: 11.1, 15.6; M13: 6.10, 8.13; M19: 16.7, 16.13;
M20: 11.2); the two
explicit deferrals (the in-memory `@fastify/rate-limit` budgets of M13 and the
SSO surfaces of M18) are recorded there with their justification.

- [ ] 13.1 The machine-credential create and revoke operations (library functions in
      `packages/auth/src/machine-credentials.ts`: `002` registers no routes for them
      and no non-test code calls them) are reachable only through
      `identity.credentials.*` and `identity.serviceAccounts.*`, behind Cerbos (the
      `credential` policy of 9.1) and with the headerless call of 9.1b (`002`
      residual risk; M9). They are exported only on the subpath
      `@tayzu/auth/machine-credentials` and imported only from
      `apps/api/src/identity/**` (9.1c, Resolved decision Q78). Verify:
      `machine-credentials.int.test.ts` covers a non-admin denied create and revoke
      and a Better Auth `admin` member (not only `owner`) allowed through Cerbos
      only; `machine-credential-surface.test.ts` asserts the two functions are not
      exported from the `@tayzu/auth` index, are exported from the subpath, and have
      no caller outside `apps/api/src/identity/**` and the tests. The composite key
      is 11.1 and the high-risk marker is 14.2.
- [ ] 13.2 Identity operations that act on the global account refuse a target that
      has a membership outside the caller's tenant, so an admin of one tenant cannot
      link an SSO `sub` to a user who also belongs to another tenant (`002` VCDM M10;
      `setStatus` is tenant-scoped instead, Resolved decision Q25). The target's
      memberships in other tenants are read through `globalMembershipTenantsOf` of 5.1b.
      Verify:
      `identity-router.int.test.ts` covers `linkSsoAccount` and `unlinkSsoAccount` on a
      two-tenant user being refused. A link recorded while the user was single-tenant
      does not survive into a second tenant (8.5g, 8.5h).
- [ ] 13.2b `identity.users.linkSsoAccount` refuses a target that is an `admin` or an
      `owner` of the tenant (Resolved decision Q88), with the generic rejection of
      13.3, because an admin who records their own `sub` on a peer admin would hold a
      session as that admin and pass the SSO step-up with their own identity (identity
      laundering: no gain of role, but the audit attributes the actions to the victim).
      Admin accounts self-link through `/link-social`, which requires step-up, and
      SSO-only admins are unsupported (`002` Q72), so every admin has a local account
      and can self-link. The role is the target's membership role in the tenant, read
      through the repository of 5.1b. The refusal logs
      `catalog.security.identity_conflict_refused` (declared in 15.1) with the reason
      `target_is_admin_or_owner`, the tenant, the acting admin and the target's opaque
      user id, and no email or `sub` (Resolved decision Q115, G9-6). Verify:
      `identity-router.int.test.ts` covers a
      link on an `admin` and on an `owner` being refused with
      `CATALOG_VALIDATION_FAILED` (that it answers like every other conflict is 13.3's
      case), with no
      `account` row written and no session revoked, the event emitted with the reason
      `target_is_admin_or_owner` and no email or `sub`, a link on a plain `member` still
      succeeding, and an admin linking their own identity through `/link-social` with
      step-up.
- [ ] 13.3 `createUser` and `linkSsoAccount` give one generic answer to every
      conflict (an account that already exists in this tenant, one in another
      tenant, a `sub` that is already linked, an `admin` or `owner` target of a link, 13.2b): `CATALOG_VALIDATION_FAILED`, a fixed
      message and no state change, so a failed probe leaves no partial state and the
      cause appears in no response (a successful create or link differs from a
      rejection by construction, so "indistinguishable from success" is not the
      requirement). The cause is logged only internally, as
      `catalog.security.identity_conflict_refused` (declared in 15.1; Resolved decision
      Q115, G9-6) with a bounded reason (`account_exists` for an account that already
      exists in this tenant or in none, `target_in_other_tenant` for an account or a link
      target with a membership in another tenant, `sub_already_linked` and
      `target_is_admin_or_owner`, 13.2b), the tenant, the acting admin and the target's
      opaque user id when the target account exists, and never an email or a `sub`. The
      user, credential and bootstrap lifecycle events (`002`
      Q42; M9) are declared here, before any route exists, because `002` Q42 forbids
      mounting an operation whose events are not declared. They are declared in the
      **separate identity contract module** that 2.0c created,
      `packages/auth/src/telemetry/identity-contract.ts` (Resolved decision Q74),
      and not in `telemetry/contract.ts`, whose `contract.test.ts` requires it to
      equal the authz contract's `auth.*` subset exactly and forbids any `catalog.`
      name, so that file and its test stay untouched. The module is exported from
      the package (2.0c), and `otel-smoke-check` imports it (15.1). Log events, spans and
      counters of the identity operations, in this task and in every earlier one, are
      all created through the helpers of 2.0c; this task declares the four `002` Q42
      names in the module. The events are
      `catalog.audit.user_created` (whose `bootstrap` form carries the operator's
      `tayzu.identity.operator.id` in place of `tayzu.actor.id`, Resolved decision Q116,
      4.6),
      `catalog.audit.credential_created`, `catalog.audit.credential_rotated` and
      `catalog.security.credential_revoked`; the operations emit them (the rest of
      the contract is 15.1). Verify: `identity-router.int.test.ts` covers "Create
      and link give one generic answer to every conflict" (each conflict cause
      answering identically, with no row written, no session revoked and no account
      changed afterwards, and each cause emitting `identity_conflict_refused` with its own
      reason and no email or `sub`), and each lifecycle action emitting its declared event,
      and `identity-contract.test.ts` (a new file in `packages/auth/src/telemetry/`;
      `contract.test.ts` is not edited)
      asserts the four names are declared in the module, with both forms of
      `catalog.audit.user_created`.
- [ ] 13.4 `resolveContext` rejects a disabled (`banned`) user, with the same
      rejection as 11.8 (401 `CATALOG_CONTEXT_REQUIRED`, the reason only in the log;
      Resolved decision Q77), logging `catalog.security.principal_rejected` with the
      reason `user_banned` and incrementing `tayzu.identity.principal_rejections`, so
      existing sessions and any new sign-in, local or
      through SSO, stop granting access, and a ban revokes the user's sessions
      (`002` VCDM M20; the tenant-scoped check is 11.8). Verify:
      `context-resolver.int.test.ts` covers "A disabled user's sessions stop
      working" and `catalog.security.principal_rejected` being logged, a banned user
      whose `_user` is still `Active` being rejected with the reason `user_banned`, and
      `banned-sign-in.int.test.ts` covers a banned user being refused at local
      sign-in and at the SSO callback.
- [ ] 13.4b A banned user's sign-in fails exactly like any other sign-in failure
      (Resolved decision Q54, VCDM G3). Better Auth's admin plugin refuses a banned
      user with a distinct error after a correct password, a credential-validity oracle
      that would break `002`'s rule that sign-in failures are identical, and it becomes
      live the moment `setStatus` mounts. The failure is made uniform at local sign-in
      and at the SSO callback, **after the credential was verified** (Resolved decision
      Q97), which is Better Auth's own ordering for a ban: the admin plugin's
      `session.create.before` throws FORBIDDEN `BANNED_USER` once the password has
      verified, so no session is created, while the only session-aware hook,
      `hooks.before`, runs before the password is checked, so a pre-check would differ in
      timing and refuse a banned user whatever the password. A `hooks.after` on
      `/sign-in/email` rewrites that `BANNED_USER` error into the same status, error code
      and body as a wrong password (there is no session to delete) by **returning a
      `Response`** with them, not by throwing a replacement `APIError`: when an
      after-hook throws, Better Auth keeps the original result's status (`dispatch.mjs`
      passes `status: result.status`, and better-call's `toResponse` prefers it to the
      error's `statusCode`), so a thrown error would answer 403 with a 401 body, and only a
      returned `Response` keeps its own status and body (design D13); the timing of a
      correct-password attempt may differ from a wrong password's, which is accepted and
      documented. The SSO callback needs no rewrite: `auth.ts` already turns every
      callback failure, a ban included, into its one `401 AUTH_SSO_REJECTED`, so that part
      is a test. The existing sign-in hook logs every error of the route as
      `auth.security.login_failed` with the reason `bad_credentials`, while `002` declares
      `account_disabled` for this case (`002` design, Log events): the rewrite logs
      `account_disabled` for a ban. The attempt itself is logged internally as
      `catalog.security.banned_sign_in_attempt` (declared in 15.1) with its channel and
      the opaque user id and no email, while the response stays uniform (design D13).
      The smoke check drives no banned sign-in before 15.2, so `002`'s exact-set
      assertion on the reasons of `login_failed` stays green here; 15.2 drives one and
      rewrites that assertion (Resolved decision Q131). Verify: `enumeration-resistance.int.test.ts` (in `packages/auth/src/`)
      gains a banned case, in which a banned user with the correct password, a wrong
      password and an unknown email get responses with the same status, error code and body at local sign-in through
      `auth.handler` (the response's own status compared, not only the body; the timing
      is not asserted), no session row existing for the banned user and
      `auth.security.login_failed` carrying the reason `account_disabled` for the banned
      attempt and `bad_credentials` for the wrong password,
      and `banned-sign-in.int.test.ts` covers the SSO callback giving the same uniform
      `401 AUTH_SSO_REJECTED` as any other callback failure, and the event being emitted
      once per banned attempt on each channel with no email in it.
- [ ] 13.5 Temporary and bootstrap passwords force a change at first sign-in,
      through a marker row in `auth.verification` (identifier
      `temp-password:<userId>`, `expiresAt` equal to the expiry; Resolved decision
      Q36, no migration). Two places honor it: `resolveContext` for `/v1`, and,
      for `/api/auth/*`, a session-aware `hooks.before` in `auth.ts` like the idle
      check, because `isAllowedAuthPath` is a static, session-blind set and cannot
      know about the marker. A session whose user holds an unexpired marker reaches
      only the change-password route, plus `/sign-out` and `/get-session` (without
      them the user could not even end the session or learn they must change the
      password), until it is cleared (`002` VCDM M11). Verify:
      `temporary-password.int.test.ts` covers that a temporary password grants only
      the change-password route, `/sign-out` and `/get-session` on both `/v1` (where
      only the change is reachable) and `/api/auth/*`, and that changing it clears
      the marker.
- [ ] 13.5b The generated temporary password satisfies the password policy of 8.1 by
      construction. Today it is `randomBytes(24)` as base64url, whose only symbols are
      `-` and `_`, so about 36% of draws contain no symbol and fail the policy, and the
      generator exists twice (`identity-router.ts` and `bootstrap-admin.ts`). One shared
      generator in `@tayzu/auth` (the password module) guarantees the length and every
      character class from a CSPRNG, both call sites use it, and the policy applies to
      bootstrap passwords (`002` VCDM M5). The DAST seed (`scripts/ci/zap-seed.ts`, which
      runs the CLI that 4.6b moved) therefore uses a password that satisfies the policy
      of 8.1, from this generator, and honors the forced change of 13.5. Verify:
      `temporary-password.test.ts` covers
      1000 generated passwords all passing the policy (each with a symbol, a digit and
      both cases), the two call sites using the shared generator, and a bootstrap
      password failing the policy being refused; and `zap-seed.test.ts` (4.6b) covers the
      seed using a policy-compliant password.
- [ ] 13.5c The accept route honors the temporary-password marker (VCDM G6-4). The
      route reads the session directly and bypasses both `resolveContext` and the
      `/api/auth` hook, so a session whose user holds an unexpired marker could
      otherwise gain a membership. It calls the same marker check as 13.5 and
      answers the uniform rejection (`denial_reason` `session_required`). Verify:
      `invitation-accept.int.test.ts` covers a session of a user with an unexpired
      marker answering the uniform rejection with nothing created, and the same user
      accepting once the marker is cleared.
- [ ] 13.5d An **expired** temporary-password marker blocks sign-in (Resolved
      decision Q36), and it does so with the uniform sign-in failure: the status,
      error code and body equal those of a wrong password (`auth.ts`, the same `hooks.after`
      as 13.4b, after the password was verified, Resolved decision Q97; nothing refuses an
      expired marker before the session is created, so here, and only here, the hook
      deletes the session the sign-in just created), so an expired
      temporary password is not a credential-validity oracle. Here the sign-in succeeded,
      so the hook **returns a `Response`** with the wrong password's status, code and
      body, as in 13.4b: a thrown `APIError` would keep the success status of the sign-in
      (design D13). The context's response headers are still copied onto a returned
      `Response`, so the hook also drops the `Set-Cookie` that the sign-in set for the
      session it deleted. Verify: `temporary-password.int.test.ts` covers a sign-in with the
      correct temporary password after the marker expired answering exactly like a
      wrong password (the HTTP response's own status, error code and body, and no
      session cookie set) with no session row remaining, and the user able to sign in again after an admin sets a new
      temporary password.
- [ ] 13.6 Authorization and the write run against the same state: the handler
      re-verifies `ownerTeam`, `locked` and `createdBy` inside its own transaction,
      after `FOR UPDATE`, so a concurrent ownership or lock change is seen and an
      `upsert` authorized as `create` cannot land as an update (`002` VCDM M4).
      Verify: `pipeline-recheck.int.test.ts` covers a concurrent ownership change
      between the authorization and the write failing closed, and the upsert case.
- [ ] 13.6b A `replace`-mode `upsert` without `ownerTeam` cannot silently release
      ownership (`002` VCDM M15). Verify: `entities-upsert-ownership.int.test.ts`
      covers an owning-team member's `replace` upsert without `ownerTeam` being
      refused or keeping the owner, per `001`'s ownership spec.
- [ ] 13.6c `Inherited` ownership is unreachable today (`readInherited` returns
      nothing); until a chain can be declared, an entity whose ownership is `Inherited`
      is not updatable by a non-admin (fail closed; Resolved decision Q37) and the `002` spec correction is recorded for a `002` follow-up (`002`
      VCDM M15). Verify: `inherited-ownership.int.test.ts` covers a non-admin member's
      update of such an entity being denied and an admin's allowed.
- [ ] 13.7 Keys created through `002`'s machine-credential path get the
      plugin-level per-key rate limit (60 per hour, configurable, Q44) and no stored
      first characters (`002` residual risk; 9.5), with the headerless call. Verify:
      `machine-credentials.int.test.ts` covers the configured limit and an empty stored
      start on a created key.
- [ ] 13.8 Startup refuses `NODE_ENV=test` together with a non-local database host,
      because `NODE_ENV=test` relaxes the https checks, the role assertion and the OTLP
      requirement (`002` VCDM M12). The refusal lives in **`createAppFromEnv`**
      (`apps/api/src/bootstrap.ts`), not in `loadConfig` (Resolved decision Q98), so the
      `loadConfig` unit tests (`config.test.ts`, which use `db.invalid` under
      `NODE_ENV=test`) stay as they are and no assertion is loosened. `config.test.ts`
      also holds one `createAppFromEnv` case (around lines 121-131): `db.invalid` under
      `NODE_ENV=test` with no `BETTER_AUTH_SECRET`, expecting the `BETTER_AUTH_SECRET`
      error and no `createPool` call. It stays unchanged and green only because of the
      order inside `createAppFromEnv`, which this task sets: the host refusal runs
      **after** `loadConfig` (`bootstrap.ts`, around line 35, which throws for the missing
      secret first) and **before** the first `createPool` (around lines 41-43), so a
      refused host builds no pool either. A host is local
      when it is `localhost`, `127.0.0.1` or `[::1]`, for both `DATABASE_URL` and
      `AUTH_DATABASE_URL`. Every test that goes through `createAppFromEnv` with a
      remote-looking fixture host under `NODE_ENV=test` moves its fixture to a local host
      (an address with no listener), which changes a fixture and no assertion. They use
      `db.invalid`: `bootstrap.test.ts`, `main.int.test.ts` and `sso-startup.int.test.ts`,
      and in `apps/api/src/` also `admin-mfa-enrollment`, `auth-route-allowlist`,
      `backchannel-logout`, `backchannel-logout-http`, `bootstrap-wiring` (its shared
      environment around lines 94-95; its `@tayzu/db` mock around line 63 maps a URL to a
      pool by its role name only, so the host can change; its runtime-role suite runs
      with `NODE_ENV=production` and is not affected), `context-resolver-principal`,
      `link-social-step-up`, `otel-export`, `otel-export-query` (its fixture around
      lines 56-57, reached through `main.ts` `start()`), `pre-auth-rate-limit`,
      `production-cookies` (its `NODE_ENV=test` cases), `sso-token-storage` and
      `step-up-sso-http` (all
      `*.int.test.ts`); the test-writer re-runs `grep -l db.invalid apps/api/src` and moves
      every one that reaches `createAppFromEnv` under `NODE_ENV=test`. Verify:
      `bootstrap.test.ts` covers `createAppFromEnv`
      with `NODE_ENV=test` and a remote `DATABASE_URL` host throwing with no
      `createPool` call, the same for `AUTH_DATABASE_URL`, a local host starting and the
      database TLS check being unaffected, every test file listed above and every other one the `grep` finds
      reaching `createAppFromEnv` passes with its local fixture host, and
      `config.test.ts` is unchanged and green, its `createAppFromEnv` case included (the
      missing secret still reported before the host refusal).
- [ ] 13.9 The public re-authorization callback has its own limiter on the
      DB-backed store (a sixth new `RateLimitScope` value, `reauthorization_callback`,
      in the TypeScript union, after the four of 6.10 and the `notice_recipient` of 6.12b; neither executable telemetry contract enumerates the values,
      but `002`'s design declares the enum closed, so this amends it, recorded in
      16.14), firing before
      the database `delete` it performs per hit (`002` VCDM M13). Verify:
      `reauthorization-limits.int.test.ts` covers the callback being rate-limited with
      no database access once the limit is hit.
- [ ] 13.9b `reauthorization.start` is bounded per session, so a blocked attempt no
      longer inserts an unbounded number of rows (`002` VCDM M13). Verify:
      `reauthorization-limits.int.test.ts` covers repeated blocked attempts of one
      session inserting at most the configured number of rows.
- [ ] 13.10 A back-channel logout token with neither `sid` nor `sub` is rejected
      and does not consume its `jti` (`002` VCDM M14). Verify:
      `backchannel-logout.int.test.ts` covers such a token being refused and the same
      `jti` still usable afterwards in a valid token.
- [ ] 13.11 The cheap claim checks of back-channel logout run before discovery and
      JWKS are fetched, so a malformed RS256-shaped token triggers no outbound call
      (`002` VCDM M14). Verify: `backchannel-logout.int.test.ts` covers a token failing
      a cheap check with the discovery and JWKS fetchers recording zero calls.
- [ ] 13.12 Dependabot tracks the pinned image digests (`postgres`, Cerbos and ZAP in
      `ci.yml`, the compose file and `scripts/ci/dast.sh`; `.github/dependabot.yml` lists
      npm and github-actions only today), as `002`'s gate asks (`002` VCDM M17, Resolved
      decision Q95): the file gains the `docker` ecosystem and, where a pin sits in a
      script or in a workflow `docker run` that Dependabot cannot read, the pin moves to
      a file it does read (a compose file or a Dockerfile under `scripts/ci/` that the
      script references). Verify: `dependabot-config.test.ts` (in `apps/api/src`, like
      `zap-seed.test.ts`, because `.github` is outside every package) reads
      `.github/dependabot.yml` and fails unless the `docker` ecosystem covers each
      directory that holds a pinned digest, and fails for a digest pinned only where no
      entry reads it; `pnpm lint` passes and `docs/security/dependencies.md` lists each
      pinned digest with its tracking mechanism and owner.
- [ ] 13.13 The DAST API scan asserts that it received 2xx responses on
      operations, so a scan that only ever sees 401 or 415 fails instead of passing
      silently (`002` VCDM M18; the SSO, back-channel and re-auth surfaces are
      deferred to `010`, design Risks). The check is `scripts/ci/dast-coverage.ts`, and
      its test sits in `apps/api/src`, like `zap-seed.test.ts`, because Vitest projects
      are `packages/*` and `apps/*` only and `scripts/ci` is outside every package.
      Verify: `apps/api/src/dast-coverage.test.ts` covers a fixture ZAP report with no
      2xx operation response failing the check and one with 2xx responses passing, and
      `dast.sh api-scan` runs the check on its report.

## 14. API contract and mount gate

- [ ] 14.1 oRPC procedures for the thirteen operations of design D10 (the three
      existing procedures `create`, `linkSsoAccount` and `unlinkSsoAccount` gain their
      `.route` and are addressed by the `{user}` identifier, Resolved decision Q31),
      each built with the wrapper of 5.3b and declaring `.route({ method, path, spec })`
      like `packages/catalog/src/api/contract.ts`, with `inputStructure: 'detailed'` on
      every route (`.route({ ..., inputStructure: 'detailed' })`), in the identity router of `apps/api`, **merged with the catalog router into one
      router** handed to the one `OpenAPIHandler` (`server.ts` has one handler and one
      interceptor chain, so step-up, the error mapping and `ResponseHeadersPlugin` reach
      both and no second handler is created); the procedures read `input.params`,
      `input.query` and `input.body` under `inputStructure: 'detailed'`. Verify: `router.int.test.ts` calls each procedure once on its
      happy path through `createRouterClient` (the route list of the generated document
      is 14.1c's case, because 14.1c creates the generator), and
      `merged-router.int.test.ts` covers one handler
      serving a catalog route and an identity route, the step-up interceptor and the
      error mapping applying to both, and a `Retry-After` set through
      `ResponseHeadersPlugin` on an identity 429 and absent from a catalog answer.
- [ ] 14.1c A second committed OpenAPI document, `openapi/identity.openapi.json`, is
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
      first-deployment gate. Verify: `identity-openapi.test.ts` (in `apps/api/src/`; `identity-contract.test.ts`
      is the telemetry file of 13.3) covers `contract:generate` producing the committed file, `contract:check` passing
      on it, `contract:check` failing after a route's path or risk spec is changed in a
      scratch edit, the generated document listing the thirteen routes with their
      methods and paths and **not** the accept route, and the document containing no
      schema object.
- [ ] 14.1b The acceptance is a **plain Fastify route**, `POST
      /v1/auth/invitations/accept`, registered before the `/v1/*` catch-all like
      `app.post(TOKEN_EXCHANGE_PATH)` (the catch-all would answer an unauthenticated
      call 401), parsing the body into a null-prototype object and subject to the
      body limit, with the DB-backed limiter of 8.13, which is keyed by
      `request.ip`. The route sits outside the catch-all, so the CSRF custom-header
      check of the existing-account path (14.7) is made by the route itself, with
      the configured header name (default `x-csrf-token: orpc`). Verify:
      `accept-route.http.int.test.ts` covers "A new person accepts and can then sign
      in" over HTTP, without a session, and the route being absent from the OpenAPI document and from the
      `contract:check` input.
- [ ] 14.2 `x-tayzu-risk: high` on every operation in the set (`setStatus`,
      `invite`, `identity.users.create`, `serviceAccounts.create`/`delete`,
      `credentials.create`/`rotate`/`revoke`, and the SSO
      `linkSsoAccount` and `unlinkSsoAccount`), per Resolved decisions Q19 and Q31.
      Verify: `openapi.test.ts` covers "Every route in the high-risk set is marked",
      reading the committed `openapi/identity.openapi.json` of 14.1c.
- [ ] 14.3 `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), **off by
      default**: with it off none of the fourteen routes is registered (the accept
      route included), and each answers **like an unknown `/v1` path**: 401
      `CATALOG_CONTEXT_REQUIRED` for an unauthenticated call (the catch-all resolves
      the context first) and the router's 404 for an authenticated one. Only the
      accept route is a Fastify route; the other thirteen are procedures behind the
      single `app.all('/v1/*')`. `config.ts` has no parser for the switch, so a
      boolean parser follows the precedent of `TAYZU_TELEMETRY_DISABLED` (unset or
      `false` is off, `true` is on, anything else fails startup), and the value is
      wired through `Config`, `bootstrap.ts` and `createApp`. Verify:
      `mount-gate.int.test.ts` covers "Routes answer like an unknown path while the
      switch is off" for both callers and "No route is registered outside the
      switch" by enumerating the Fastify route table **and** the router's
      procedures, and `config.test.ts` covers the default being off, `true` and
      `false` being accepted and any other value failing startup.
- [ ] 14.3b With the switch **on**, every Fastify route outside an explicit public
      allowlist is behind `resolveContext` (VCDM G4), so a new
      route cannot become public by accident. The allowlist is explicit and reviewed
      (the accept route and the routes `002` leaves public). Verify:
      `route-auth-allowlist.int.test.ts` enumerates the Fastify route table of the
      server with the switch on, fails for a route that is neither on the allowlist nor
      behind `resolveContext`, and fails when a scratch route is added to the server
      outside both.
- [ ] 14.4 Step-up over HTTP with the switch on: an admin session without a fresh
      verification gets `AUTH_STEP_UP_REQUIRED` for each high-risk route and nothing
      changes. Verify: `step-up.http.int.test.ts` covers "A hijacked admin session
      without a fresh MFA cannot mint power" over the mounted server, a `password`
      marker satisfying the guard only for a user with no enrolled factor, a session
      with an `ssoSid` being sent to the Visma Connect re-authorization instead of a
      local verification, and an admin without an enrolled factor getting
      `AUTH_STEP_UP_REQUIRED` on any `/v1` call (an invited admin starts blocked until
      they enrol).
- [ ] 14.5 Error mapping over HTTP: `AUTH_FORBIDDEN` and `AUTH_STEP_UP_REQUIRED`
      are 403, `AUTH_RATE_LIMITED` is 429 **with a `Retry-After` header** (the caps and
      the accept route's limiter), a foreign or unknown target is 404. Verify:
      `errors.http.int.test.ts` covers each over the mounted server, the header on each
      429, and that the accept route's rejections are all the same 404.
- [ ] 14.6 `{user}` is the `_user` entity identifier (an email or `svc-…`) sent
      unencoded, and a path containing `%` answers 404 (`002` Q74). Verify:
      `user-path.http.int.test.ts` covers `PUT /v1/users/{email}/status` and
      `PUT /v1/users/svc-ci-github/status` resolving, and a `%` path being 404,
      including the `a%40b` that oRPC's generated client sends (a known limitation,
      recorded in the "Email in the `{user}` path" ticket).
- [ ] 14.6b The `DELETE` routes (`DELETE /v1/service-accounts/{user}` and
      `DELETE /v1/users/{user}/sso-account`) rely on the `inputStructure: 'detailed'`
      that every identity route declares (14.1) and take
      their target from the path (`045` adds `DELETE /v1/organization`, whose
      confirmation travels in the query string). Verify: `delete-routes.http.int.test.ts`
      covers each `DELETE` route reading its target from the path, and a foreign or
      unknown target answering the same `CATALOG_NOT_FOUND` with nothing changed.
- [ ] 14.7 The existing-account acceptance over HTTP (Resolved decisions Q24 and
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
- [ ] 14.8 A cross-tenant request per route over HTTP, called by `t1`'s admin: each
      route with a target (cancel, resend, setStatus, link, unlink,
      `serviceAccounts.delete`, rotate, revoke, `credentials.create` with a `userId`,
      and accept with a `t2` invitation) answers like an unknown target. The
      target-less routes assert the HTTP twin of 12.1, 12.5, 12.6 and 12.9:
      host-tenant-only writes, and foreign rows omitted from the list. Verify:
      `cross-tenant.http.int.test.ts` covers one request per route over the mounted
      server, compares each response of a route with a target of `t2` to the
      unknown-id response, and for the target-less routes (invite, `users.create`,
      `serviceAccounts.create`, `credentials.list`) asserts that the write lands only in
      `t1` and that the list omits `t2`'s credentials.
- [ ] 14.9 A route-table-driven authorization matrix over HTTP (Resolved decision
      Q45), built from the router's own procedure list so a new route cannot be
      forgotten: for each of the thirteen oRPC routes, the admin (with a fresh step-up
      where the route is high-risk) is allowed (the service-account routes included: the
      first, target-less check must not deny an admin there, 5.3b2), a `member` gets `AUTH_FORBIDDEN` 403, a
      machine `member` token gets 403 (service-account and integration actors skip
      step-up and had no denial test), an unauthenticated call gets 401 and, for a route
      with a target, a foreign target gets the same 404 as an unknown one. Verify:
      `identity-authorization-matrix.http.int.test.ts` runs the matrix over the mounted
      server and fails when a procedure of the router is missing from it, with the
      admin-allowed case of `serviceAccounts.create` and `serviceAccounts.delete`
      asserted by name.

- [ ] 14.10 Every procedure of the identity router is covered by the input contract
      of 5.3d, driven by the router's own procedure list so a new procedure cannot be
      forgotten. Verify: `identity-input.int.test.ts` calls each of the thirteen procedures through `createRouterClient` **as an admin** (the wrapper's role check
      comes before the input is parsed, design D10, so any other caller would get
      `AUTH_FORBIDDEN` instead of a parse error) with a `__proto__`, a `constructor` and a
      `prototype` key at depth 1 and 3, an undeclared field and an over-length value,
      asserting `CATALOG_VALIDATION_FAILED` and no lookup or write, and fails when a
      procedure of the router is missing from it.

## 15. Telemetry contract enforcement

- [ ] 15.1 Extend the telemetry contract of the identity change with every remaining
      span, metric and log event from design.md's Observability contract (the user
      and credential lifecycle events were declared by 13.3), in the separate
      identity contract module of 2.0c,
      `packages/auth/src/telemetry/identity-contract.ts` (Resolved decision Q74).
      `telemetry/contract.ts` and `contract.test.ts` are not edited: that test pins
      the file to the authz contract's `auth.*` subset and forbids `catalog.` names.
      The additions include `identity.user.reconcile`, `catalog.audit.users_reconciled`,
      `catalog.security.notice_suppressed`,
      `catalog.security.admin_notice_failed`,
      `catalog.security.email_recipient_blocked`,
      `catalog.security.email_tenant_blocked`, `catalog.security.sso_link_shed`,
      `catalog.security.banned_sign_in_attempt`,
      `catalog.security.sso_link_marker_failed`,
      `catalog.security.invitation_accept_compensation_failed`,
      `catalog.security.accepting_session_revocation_failed` (8.5k) and
      `catalog.security.identity_conflict_refused` (13.2b, 13.3; both Resolved decision
      Q115) and the new attributes
      (credential kind `agent`, rejection reasons `service_account_missing`,
      `user_missing` and `user_banned` (13.4), the constant `invalid` of `tayzu.identity.invitation.id` and the denial reasons
      `malformed_request` (8.4), `csrf_rejected`, `origin_rejected`,
      `inviter_not_active_admin`, `member_limit`, `already_accepted` (8.3, Resolved
      decision Q123) and `consume_conflict` (8.1e, 8.3), invitation cancel reasons `inviter_disabled`
      and `user_created` (7.13, Resolved decision Q110),
      `tayzu.identity.email.template`, `tayzu.identity.sign_in.channel`,
      `tayzu.identity.sso_link.path` with its values `acceptance`, `membership_hook` and
      `reconcile` (8.5l, Resolved decision Q105), `tayzu.identity.reconcile.orphans` and
      `tayzu.identity.conflict.reason` with its values `account_exists`,
      `target_in_other_tenant`, `sub_already_linked` and `target_is_admin_or_owner`),
      the attributes `tayzu.tenant.id` and `tayzu.actor.id` of
      `catalog.audit.invitation_cancelled` and `tayzu.actor.type` of
      `catalog.audit.invitation_resent` (design, Observability contract),
      `tayzu.identity.service_account.id` (the `svc-…` identifier, Resolved decision
      Q90) in place of `tayzu.identity.user.id` on `catalog.audit.user_status_changed`
      when `tayzu.identity.user.account_kind` is `service`, the other forms of that event
      (Resolved decisions Q117 and Q126, 4.1e): its new attribute `tayzu.identity.user.status.event`
      with the seven `StatusEvent` values, `tayzu.identity.user.status.from` absent for a
      created row, `tayzu.identity.invitation.id` as the subject of the `created_invited`
      write, and its principal as `tayzu.actor.id`, as `tayzu.identity.operator.id` in its
      place, or as neither for the ban hook; `tayzu.actor.type` `user` and the invitee's
      id as `tayzu.actor.id` on `catalog.audit.invitation_accepted` (Resolved decision
      Q116); and the new
      value `sso_link_shed` of the reason attribute of `002`'s
      `auth.security.session_revoked`. The authz contract lists that event's attribute
      keys, not their values, so it is not edited; the amendment of `002`'s closed
      two-value reason enum is recorded by 16.14. `002`'s `auth.security.login_failed`
      and its reason `account_disabled`, which the banned sign-in of 13.4b logs, are
      already declared, so neither module gains a name or a value for them; only the
      smoke check's value-set assertion gains `account_disabled` (15.2, Resolved
      decision Q131).
      `otel-smoke-check` imports the module in addition to `@tayzu/authz`'s
      contract. Verify: `identity-contract.test.ts` snapshot-asserts every declared
      name and the attributes of every declared event (the invitation events above,
      every form of `catalog.audit.user_status_changed` and both forms of
      `catalog.audit.user_created` included), and
      `otel-smoke-check.int.test.ts` fails when a declared name is missing from the
      imported module.
- [ ] 15.2 Extend `otel-smoke-check` to run every operation in this change once
      successfully and once per applicable error or denial class. Among them it drives
      a banned user's local sign-in with the correct password, which logs
      `auth.security.login_failed` with `002`'s declared reason `account_disabled`
      (13.4b), so the `002` case "login_failed covers bad_credentials and mfa_failed"
      (`apps/api/src/otel-smoke-check.int.test.ts:1008-1012` today; earlier tasks (5.3c,
      9.1b, 9.1c, 11.0 and 15.1) edit the same file first, so the case is found by its
      title), whose
      assertion is today the exact set `{bad_credentials, mfa_failed}`, is
      **rewritten** (Resolved decision Q131), not loosened: its assertion becomes the
      exact set `{bad_credentials, mfa_failed, account_disabled}`, which is stricter,
      because the smoke check then also requires the value that `002` declares but
      never emitted, and its title names the three reasons ("login_failed covers
      bad_credentials, mfa_failed and account_disabled").
      No contract name or value is added (15.1). The PR description calls the rewrite
      out, as Q76, Q77, Q125 and Q130 did for theirs. Verify:
      `pnpm otel-smoke-check` is green, and removing one declared span in a scratch
      branch makes it fail; the rewritten case asserts that the values of
      `tayzu.auth.failure_reason` on `auth.security.login_failed` equal exactly
      `{bad_credentials, mfa_failed, account_disabled}`, and logging the banned sign-in
      as `bad_credentials` in a scratch branch makes it fail.
- [ ] 15.3 Extend the cardinality guard to `tayzu.identity.*` metrics: no
      attribute key outside the contract's allowed set. Verify: `otel-smoke-check`
      fails when a deliberately added `tayzu.identity.invitation.email` metric
      attribute is introduced in a scratch branch.
- [ ] 15.4 Marker-leak test across this change's signals, in memory. Verify:
      `otel-smoke-check` covers "Invited email never reaches telemetry" for an
      invite, an expired-acceptance attempt, a rate-limited invite, a credential
      rotation (secret value as the marker), an acceptance carrying a marker
      password and a marker token (neither appears in any signal or error response),
      "The invitation link never leaves the email" (a marker token and the
      id-plus-token link appear in no signal, in no response of `invite` or `resend`
      and in nothing the non-sending sender keeps), "The email provider's
      failure never leaks", and the catalog spans of the `_user` writes that an invite,
      an acceptance and a status change make carrying the placeholder of 4.1d and never
      the invited email (Resolved decision Q107), as do the `catalog.audit.mutation`
      events of those writes in `tayzu.catalog.resource.identifier` (Resolved decision
      Q113), so no exported log record of the run holds the marker email; and no Cerbos
      request that those writes and reads make holds it either (a recording Cerbos client
      around the real one, which sees what the decision log records): a `_user` entity is
      checked with the placeholder of 4.1d as its resource id (Resolved decision Q119).
- [ ] 15.5 For the routes of this capability, and for the catalog entity routes whose
      `{blueprint}` is `_user` (Resolved decision Q119), the exported HTTP path is the
      route template, so no email, invitation id or credential id leaves the process;
      because `/v1/*` is one catch-all, the template is computed by matching the parsed
      pathname (as the guards of `002` read it, `002` Q74) against the twelve path
      templates of the fourteen routes of design D10 and the three catalog templates
      `/v1/blueprints/_user/entities/{entity}`, `/v1/blueprints/_user/entities/{entity}/status`
      and `/v1/blueprints/_user/entities/{entity}/related`, while the catalog routes of
      every other blueprint keep their paths and identifiers, and the
      marker test runs through the real HTTP server and instrumentation.
      `docs/catalog/catalog-core.md` (its `## Telemetry` section) records that the three
      catalog `_user` routes export their route template (design D12). Verify: `telemetry-paths.http.int.test.ts`
      covers "A path identifier never reaches telemetry over HTTP" for
      `PUT /v1/users/{marker-email}/status` and a credential route with a marker id,
      "A `_user` email never reaches a catalog HTTP span" for
      `GET /v1/blueprints/_user/entities/{marker-email}`, `PUT` of its `/status` and
      `GET` of its `/related`, each exporting its template with the marker in no
      attribute, while a `GET /v1/blueprints/{blueprint}/entities/{entity}` of another
      blueprint keeps its path, "A percent-encoded path identifier never reaches
      telemetry over HTTP" for `PUT /v1/users/{marker-email}/status` and
      `GET /v1/blueprints/_user/entities/{marker-email}` sent with the marker's `@`
      encoded as `%40` (as oRPC's generated client sends it, design Tickets "Email in the
      `{user}` path"; `002` Q74 answers such a path with 404), each exporting its route
      template as the HTTP span path with neither the encoded nor the decoded marker in
      any attribute, and the template matcher covering every route of D10 and
      the three `_user` templates (fifteen templates); and `docs/catalog/catalog-core.md`
      names the three `_user` route templates.
- [ ] 15.6 Every lifecycle action emits its declared event: user and bootstrap
      creation, status change, service-account creation, disable, enable and deletion,
      invitation resend and every invitation cancellation (each with the tenant and the
      acting admin), credential creation, rotation and revocation, a banned sign-in
      attempt, a recipient refused by the recipient-domain allowlist, an email suppressed
      for a disabled demo tenant, an SSO link shed (and the `auth.security.session_revoked` events with the reason
      `sso_link_shed`, also for an admin unlink), a provenance marker write that failed,
      an acceptance compensation that failed, a failed revocation of the accepting
      session, a refused create or link conflict (with its reason), an invitation cancelled by
      `identity.users.create` (reason `user_created`), a reconcile run
      (`catalog.audit.users_reconciled`, with the operator id) and a suppressed or
      truncated notice (the user, credential and
      bootstrap events are declared and first tested in 13.3). In every audit event of an
      operation that an admin initiates, `tayzu.actor.id` is the admin who acted (the
      `onBehalfOf` of the `system` write), never the `system` actor; the reconcile's
      event and the bootstrap's `user_created` carry the operator's
      `tayzu.identity.operator.id` instead, `catalog.audit.invitation_accepted` names the
      invitee (`tayzu.actor.type` `user`, Resolved decision Q116), and
      `catalog.audit.user_status_changed` is emitted for every status change with the
      principal of its write and its status event (Resolved decision Q117: the admin, the
      operator, the user on first sign-in, the invitee on acceptance, and no actor for
      the ban hook). Verify:
      `identity-events.int.test.ts` covers "Each lifecycle action emits its declared
      event", the actor id being the admin for every admin-initiated action, the
      reconcile's event and the bootstrap's `user_created` carrying the operator id,
      `invitation_accepted` naming the invitee ("The acceptance and the bootstrap name
      who acted"; the bootstrap's refusal without an operator id is 4.6b's case), and
      "Every status change names its principal": one `user_status_changed` for each status writer (`setStatus`, the
      invitation hook, `users.create`, `serviceAccounts.create`, the first sign-in, the
      acceptance, the ban hook, the reconcile and the bootstrap), each with its principal
      and its status event and no email.

## 16. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 16.1 Write `docs/adr/0017-service-account-identifier-convention.md`
      (design D6). Verify: the file exists with Context/Decision/Alternatives/
      Consequences, and design D6 links to it.
- [ ] 16.2 Write `docs/adr/0018-credential-rotation-immediate-cutover.md`
      (design D8). Verify: same structure, linked from design D8.
- [ ] 16.3 Amend `docs/adr/0013-cerbos-as-sole-authorization-engine.md` (Resolved
      decision Q94) with a dated note that Better Auth's static `ac` roles of the
      `organization` plugin (9.1b), which grant `admin` the `apiKey` permissions, are
      **neutralized** and do no authorization work of Tayzu's: they are a permission set
      that only Better Auth's own check reads, and Cerbos stays the only decision point
      (`002` D1 rejects Better Auth `ac` doing authorization work). Verify: `pnpm lint`
      passes and the ADR carries the note and links design D8.
- [ ] 16.4 Write `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md`
      (design D3). Verify: same structure, linked from design D3.
- [ ] 16.5 Write `docs/security/data-retention.md` (the file `045` later extends with the
      retention policy and the erasure statement of org deletion): the credential
      rotation cadence; the invitation caps, what their windows mean (a bucket resets
      only after a full window with no allowed request, Resolved decision Q66) and the
      cross-tenant denial-of-invitation trade-off; that the kill switch is an
      environment variable, so flipping it needs a new app revision (the emergency flip
      is in `docs/security/secrets.md`, 16.8); the email policy (the
      recipient-domain allowlist, mandatory only for a real provider under
      `NODE_ENV=test` and honored wherever it is set, Resolved decisions Q67, Q96 and
      Q99, the explicit `EMAIL_PROVIDER`, and ACS data location and retention) and the
      demo-tenant provisioning runbook, which adds each demo tenant to `EMAIL_DISABLED_TENANT_IDS`
      (Resolved decision Q80); the `_user` reconcile as the repair for a member rejected
      with `user_missing`, and the operator-started job that runs it (design D9), with its
      orphan rule: an `Active` human `_user` with no membership is removed only once its
      `updatedAt`, its activation, is more than one hour old, whatever its `createdAt`
      (Resolved decisions Q84, Q89 and Q124); the
      off-boarding step that lists a disabled admin's service accounts and credentials
      by the viewer's `createdBy` and revokes or rotates them, and the SSO links the
      admin recorded (unmarked links, found through the `auth.security.account_linked`
      events); the operator repair of an acceptance whose compensation failed (Resolved
      decision Q100): the alert on `catalog.security.invitation_accept_compensation_failed`
      starts it, and the runbook finds and removes a user left with no membership, or a
      membership left by a failed existing-account compensation, so that the invitee can
      be invited again (on the existing-account path a compensation runs only for a
      failure before the `_user` step;
      since Resolved decision Q118 an attempt that failed after it keeps its membership and
      its `Active` `_user` on purpose, for a retry of the same invitation, and is not
      repaired, and since Resolved decision Q122 it has already revoked the accepting
      session and the recorded one and sent the admin notice, so a never-retried attempt
      leaves only the `emailVerified` write and the consumption of the token undone and
      needs no operator step; such a compensated membership can carry an unshed SSO link and live
      sessions, but its `_user` stays `Invited` when the shed or the `_user` step failed,
      because the acceptance activates it only after the shed, Resolved decision Q112, so
      the resolver rejects the member and the first-sign-in hook does not activate the
      row, Resolved decision Q111; the two repairs are a retry of the same invitation
      within its 48 hours, which sheds on every attempt and then activates the row, and
      the removal of the membership, after which the new acceptance runs the shed with its
      session revocation, Resolved decision Q105; a new invitation, the membership hook
      and the reconcile do not reactivate an existing membership); the response to
      `catalog.security.accepting_session_revocation_failed` (Resolved decision Q115,
      G9-5; the revocation runs right after the acceptance's `_user` step, Resolved
      decision Q122, and its failure does not stop the acceptance): the alert of the ticket "Alerts for `010`" starts it, and the operator revokes
      that user's sessions, found by the opaque user id the event carries, and deletes the
      `invitation-shed:<invitationId>` record of 8.5m, found by the invitation id it
      carries, so that neither the accepting session nor the one an earlier attempt kept
      can outlive the shed; the repair of an SSO link that pre-dates
      this change on a user who already belongs to two tenants (design D4 step 7): no path
      sheds it and the SSO callback refuses every sign-in through it (8.5k), and a
      `/link-social` of the same `sub` only updates the existing row and writes no
      marker, so the user unlinks it, then links it again through `/link-social` with
      step-up, which creates a marked row; the first-deployment runbook of the bootstrap CLI, which an operator runs
      out of band (Resolved decision Q91); the canonical email form and the addresses
      that are rejected (Resolved decision Q33); and the keyed hash (the HMAC of 6.7b) of
      an invited email that `auth.rate_limit` keeps. Verify: `pnpm lint` passes and the
      runbook is reachable from the file, with its steps for a second tenant's `Invited`
      row, for a failed revocation of the accepting session and for the unlink, then link
      of an unshed pre-dating SSO link, and states the reconcile's orphan rule by
      `updatedAt` and that an existing-account attempt that failed after its `_user` step
      needs no operator step.
- [ ] 16.6 Update `docs/security/attack-surfaces.md`: the fourteen routes with
      actor, authentication and Cerbos check, the public accept route with its session
      binding, CSRF header and origin check, the inert invitation link until `003`
      (Resolved decision Q32), the egress to `api.pwnedpasswords.com`, the SEC11 answers
      of Resolved decision Q34, the limited value of a scan of the schema-less identity document (Resolved decision
      Q52) and the mount gate state (it lists `identity.*` as not mounted today), and
      corrects its stale group number (Resolved decision Q115, G9-2): the hard rule (`002` Q73)
      at `docs/security/attack-surfaces.md:200` says the routes are not mounted "before
      group 14 of `043` (hand-offs from `002`) is done", and since Q103 moved the old group
      12 out the hand-offs are group 13. Verify: `pnpm lint` passes, every route of design
      D10 has a row, and the file names the hand-offs group 13 of `043` and no longer says
      "group 14 of `043`".
- [ ] 16.7 Update `docs/architecture/system-diagram.md`: the email provider, the
      invitee with their mailbox and the platform operator as actors, and arrows for
      invite → email, the public accept route, ACS egress over HTTPS, the Pwned
      Passwords range query, credential rotation, and the backfill and reconcile jobs
      (`tayzu_auth`, `tayzu_app` and each job's own Cerbos sidecar on a loopback link
      without TLS, `002` Q8, design D9) that the platform operator starts (`045` adds
      the purge job, the reversal script and the workflow that starts it). Verify: the
      Mermaid block still renders with `npx -y @mermaid-js/mermaid-cli`, every new route
      from design D10 appears, each of the two jobs appears with its own Cerbos sidecar,
      and every new arrow carries its protocol (SEC01), asserted by a test that reads
      the Mermaid source.
- [ ] 16.8 Update `docs/security/secrets.md` (the Communication Services secret
      `ACS_CONNECTION_STRING` on a dedicated send-only resource and its change
      procedure, `IDENTITY_TOKEN_HMAC_SECRET` (Resolved decision Q93) with its owner and
      rotation (a rotation resets the recipient buckets), the out-of-band run of the
      bootstrap CLI (Resolved decision Q91), the kill switch and its emergency flip (a new app revision),
      `EMAIL_PROVIDER`, `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST` and
      `EMAIL_DISABLED_TENANT_IDS`, the `tayzu_auth` secret of the backfill and
      reconcile jobs, each job with its own identity and the operator-started run of the
      two (design D9), each job's `CERBOS_ADDRESS`, which points at its own Cerbos
      sidecar on the loopback link of `002` Q8, with the same policy bundle and
      configuration as the `apps/api` revision's (design D9), and the fact that neither
      job holds `BETTER_AUTH_SECRET`, because
      the reconcile's shed is parameterized SQL on its `tayzu_auth` pool and builds no
      Better Auth instance (Resolved decision Q114; only the app and the out-of-band
      bootstrap CLI hold it), the telemetry environment names every script reads
      (`OTEL_EXPORTER_OTLP_ENDPOINT` and `TAYZU_TELEMETRY_DISABLED`, Resolved decision
      Q79), the operator id `TAYZU_OPERATOR_ID` that the reconcile and the bootstrap CLI
      read (an opaque id, never an email, set by the operator who starts the run until
      `045`'s workflow sets it; design D9, Resolved decision Q116), each with owner and
      rotation, the credential lifecycle) and
      `docs/security/crypto-inventory.md` (the invitation token, the SHA-1 prefix
      sent to the Pwned Passwords range query as a **protocol-mandated exception**:
      only the first five hex characters of the hash leave the system, SHA-1 is not
      used for storage or authentication, and the range API requires it, with the
      offline-corpus ticket linked, Resolved decision Q81; the HMAC-SHA256 of the
      per-recipient cap key and the authentication to ACS). Verify: `pnpm lint`
      passes, each secret names its owner and rotation procedure, each job's entry lists
      its `CERBOS_ADDRESS`, the reconcile job's entry lists no `BETTER_AUTH_SECRET`, the
      reconcile job's and the bootstrap CLI's entries list `TAYZU_OPERATOR_ID`, and
      the crypto
      inventory entry states the exception and links the ticket.
- [ ] 16.9 `pnpm ci:local` is fully green (lint, typecheck, unit and integration
      tests, contract-check, otel-smoke-check, cerbos compile, audit, gitleaks). The high
      `source-map-js` advisory (GHSA-68fv-2mgg-jv7q) that failed `pnpm audit` on master
      is fixed outside this change by the `pnpm.overrides` entry `source-map-js`
      `^1.2.2` (commit `c133f21`), documented in `docs/security/dependencies.md`, so the
      audit step does not block this task (Resolved decision Q121). The dev-toolchain
      advisories reached through `markdownlint-cli2` (`braces`, `smol-toml`, `katex`) are
      the design's ticket TK11-1, outside this change, and do not block it either, because
      the audit step runs with `--prod`.
      Verify: attach the command output to the PR description.
- [ ] 16.10 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against the
      implemented code, and resolve or explicitly defer every blocking gap (the thirteen
      passes folded into this change before implementation are listed in 1.2).
      Verify: the report is attached to the PR with zero open blocking gaps.
- [ ] 16.11 Run `/security-review` on the branch and fix or justify every
      finding. Verify: the review output is attached to the PR.
- [ ] 16.12 `openspec validate 043-identity-lifecycle-and-org-admin --strict`
      passes, and design/specs/code agree (update design only if an implementation
      finding forced a change, noted in the PR). Verify: the command output is
      attached to the PR.
- [ ] 16.13 Render the system diagram to an image for the SSA (SEC01 asks for a
      png or jpg, `002` VCDM M19) and make the diagram show distinct Administrator and
      Platform operator actors, the `ghcr.io` image pulls and the OTLP export from
      `apps/api`. Verify: `npx -y @mermaid-js/mermaid-cli -i
docs/architecture/system-diagram.md -o` produces a png, and each of the three
      additions appears in the Mermaid source.
- [ ] 16.14 Update `docs/catalog/auth-and-rbac.md` (`002` D17): the two new
      resource kinds and their actions in the taxonomy, the new spans, metrics and
      log events in the telemetry reference (with a pointer to the identity contract
      module, Resolved decision Q74), the amendment of the closed rate-limit
      scope enum (`invitation_accept`, `invitation_tenant`, `invitation_recipient`,
      `notice_tenant`, `notice_recipient` and `reauthorization_callback`, which also reach
      `002`'s rate-limit metric and log event as attribute values), and the amendment of
      the closed reason enum of `auth.security.session_revoked` (`002` declares
      `password_change` and `admin_action`; this change adds `sso_link_shed`, and the
      exported `emitSessionRevoked` of 8.5h emits `admin_action` and `sso_link_shed`,
      which `002`'s code never emitted). Verify: `pnpm lint` passes
      and every resource kind of design D3, every event of the Observability
      contract, the six new scopes and the three reasons are listed.
- [ ] 16.15 Update the package rules that this change makes stale.
      `packages/authz/CLAUDE.md` says "Resource kinds are fixed" (four) and "empty
      scaffold... exports nothing yet", while `RESOURCE_KINDS` gains two and the
      package exports the resource kinds and attributes; and `apps/api/CLAUDE.md` says
      "empty scaffold" and that `apps/api` owns nothing domain-specific (as does `002`
      D1), while `apps/api` now holds the identity orchestration, the router, the scripts (Resolved decision Q30). Both are
      updated, with the new package homes of design D10 (Resolved decision Q30, task 1.4). Verify: `pnpm lint`
      (markdownlint covers every `CLAUDE.md`) passes and neither file contains any of
      the stale statements.
