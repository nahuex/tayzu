# Design: 043-identity-lifecycle-and-org-admin

## Context

- This change is authored to the exact split the human approved in chat on
  2026-09-28 (Q1 of the `002`/`043` decision set — see "Resolved decisions"
  below). It depends on `002-auth-and-rbac` for: Better Auth (`organization`,
  `admin`, `api-key`, `two-factor` plugins), Cerbos wiring, the three-tier
  RBAC baseline, the `_user`/`_team` system blueprints with `status` defined
  at least as `Active`/`Disabled`, the machine-token exchange mechanism
  (organization-owned API key → short-lived access token), the first HTTP
  listener, and the `x-tayzu-risk: high` step-up-MFA mechanism.
- **Split again on 2026-10-07 (Resolved decision Q103).** Org deletion and data
  retention (the two-phase purge, the deletion marker, the `tayzu_purge` and
  `tayzu_deletion_admin` roles, migrations `0012`-`0014`, the purge and reversal
  jobs (the lister was removed by Q48), the maintenance workflow and its `CODEOWNERS` entry, the org-deletion notice and
  the pending-deletion check of the resolver) moved to
  `045-org-deletion-and-data-retention`, which depends on `002` and on this change and
  executes after `044` (`002 -> 043 -> 044 -> 045 -> 003`). The amendment notes below
  that described that design (and the decisions Q14, Q21, Q26-Q27, Q35, Q48, Q55, Q59,
  Q64-Q65, Q68, Q72 and Q82, which `045` carries verbatim (Q41, Q49 and the other rows
  marked 'deletion part moved' are carried whole and stay in force here for their other
  parts)) were taken out with it (the decision rows themselves stay in the table below,
  marked "(moved to 045 by Q103)");
  where this change still touches the subject it points to `045`. This change keeps one
  migration, `0011`, and no migration is renumbered. The task groups after the old group
  12 moved up by one, though, so `002`'s references to `043`'s "group 14 (hand-offs)"
  (`002` Q73 and its residual risks) and "task 14.2" (`002` Q84) mean group 13 and task
  13.2 here, and group 14 is the mount group (Risks, "Hand-offs from `002`: traceability").
- **Reconciled against `002`'s actual `design.md` on 2026-09-28.** This
  change was originally drafted in parallel with `002`, before `002`'s own
  `design.md` existed, from the shared research notes
  (`scratchpad/p002/r1-port.md`, `r2-better-auth.md`, `r3-cerbos.md`,
  `r4-data-http.md`, `r5-carryover-security.md`). The package-layout
  assumption held exactly: `002` D1 confirms `packages/auth`/`@tayzu/auth`,
  `packages/authz`/`@tayzu/authz`, and the `user` Cerbos resource kind. Four
  substantive corrections were made then: the `_user.status` value casing
  matches `002`'s `Active`/`Disabled` exactly; the ADRs this change adds are
  numbered in 0017-0020 (0017, 0018 and 0020; ADR-0019 is reserved for `045`, Q104)
  to avoid colliding with `002`'s own 0013-0016;
  `AUTH_STEP_UP_REQUIRED` reuses `002`'s existing code (403); and the
  service-account credential mechanism reuses `002`'s single
  `machine-credential` apiKey config.
- **Re-reconciled against the merged `002` code on 2026-10-01** (task 1.1,
  drift-check, plus the VCDM Mode A pre-assessment, task 1.2). Mechanical
  drift was fixed in place; every scope or design conflict was asked in chat
  and recorded as Resolved decisions Q8-Q17. The mechanical fixes, so that a
  reader of the older text is not surprised:
  - `nextStatus` returns a package-local error with
    `code = 'CATALOG_VALIDATION_FAILED'`, because `@tayzu/auth` has no
    `@tayzu/catalog` dependency (D2).
  - `_user` is created per tenant, create-only and idempotent, and its
    `status` enum is `['Active','Disabled']`: the change updates
    `USER_BLUEPRINT` for new tenants and runs `blueprints.update` once per
    existing tenant, and it widens the enum (D1).
  - The role property is `portRole`; the identity router passes
    `accountKind`, `portRole`, `moderatedBlueprints` and the **target's real
    tenant** as Cerbos resource attributes, and new rules are `EFFECT_DENY`
    (D3).
  - Credential metadata is `{ actorKind, role: 'member', userId }`, because
    token exchange rejects any credential without `role === 'member'` (D6).
  - Better Auth stores `canceled` and never stores `expired`: the boundary
    maps `canceled` to `cancelled` and derives `expired` from `expiresAt` (D4).
  - `otel-smoke-check` reads the `@tayzu/auth` contract in addition to the
    `@tayzu/authz` one (**superseded by Q74**: the identity names live in a separate
    identity contract module that `otel-smoke-check` also imports, and the auth
    contract is untouched), and the duplicate `step_up_denials` metric is dropped
    (Observability contract).
  - Step-up runs only in the OpenAPI interceptor, keyed on the route spec, so
    every procedure declares `.route({ method, path, spec })` and step-up is
    tested over HTTP only (D10).
  - Rate limits use service-level buckets for the invitation caps, with the
    defaults in `apps/api/src/config.ts` (D4). The first draft of this fix used a
    path-keyed in-memory `createRateLimit` preHandler for the public route; that
    is superseded: the accept route also uses the DB-backed store (D4).
  - `docs/security/secrets.md`, `attack-surfaces.md` and `crypto-inventory.md`
    are the docs this change updates (D12).
- **Amended again on 2026-10-01** after Resolved decisions Q18-Q34, a second
  drift-check and a second VCDM pass. Mechanical fixes, so that a reader of the
  older text is not surprised:
  - The acceptance route is a plain Fastify route, not an oRPC procedure, and an
    existing account accepts with a session (D4, Q18, Q24).
  - With the switch off, an unauthenticated call to an identity route answers
    like any unknown `/v1` path (401), not 404 (D15).
  - The identity router and the orchestration live in `apps/api`, with
    structural ports and the pure parts in `@tayzu/auth` (D10, Q30). There are
    fourteen routes, the three existing procedures included (Q31; fifteen with `045`'s).
  - `setStatus` is tenant-scoped and writes through the internal adapter, not
    Better Auth's `banUser` (D13, Q25); the ban hook goes through the state machine
    (D2; **superseded** by the seventh amendment and Q102: the hook cannot see the old
    value and writes only `admin_disable`, for `banned === true`).
  - Org keys are created headerless, with `admin` granted `apiKey` access (Q29),
    and the per-key rate limit is plugin-level configuration (D8).
  - New resource policies carry the explicit cross-tenant deny and guard every
    attribute with `has()` (D3). An absent `accountKind` is `standard` (D1).
  
  - The link origin is `INVITATION_LINK_BASE_URL` (Q32), emails the entity
    identifier cannot hold are rejected (Q33), and the password policy and the
    breached-password check apply (Q22, Q23).
  - The invitation caps and the accept limiter reuse `002`'s DB-backed store
    (D4); `docs/catalog/auth-and-rbac.md` is a doc this change updates (D12).
  - Stale references to the five earlier open questions were replaced by Q18-Q22.
- **Amended a third time on 2026-10-01** after Resolved decisions Q38-Q45, a third
  drift-check and a third VCDM pass. Mechanical fixes, so that a reader of the
  older text is not surprised:
  - Existing-account acceptance no longer requires a verified email (nothing in
    `002` ever verifies one) and sets it on success (D4, Q38). An accepted
    `admin` invitation notifies every other admin (D4, D5, Q39).
  - A service account holds exactly one active credential, deleting it revokes
    every bound credential, and the resolver and token exchange reject a token
    whose bound `_user` is absent or not `Active` (D6, D8, D13, Q40).
  - `invite` forwards the admin's session headers into Better Auth (D4, Q42). Org
    keys are created headerless with the acting admin's Better Auth user id as
    `body.userId`, the `organization` plugin defines all three roles, and key
    reads are adapter-level (D8).
  - The identity router's authorization is a mandatory wrapper,
    `defineIdentityOperation`, backed by a route-table-driven HTTP matrix (D10,
    Q45). The thirteen procedures get a second committed OpenAPI document (D10,
    Q43). The per-key rate limit is 60 per hour, configurable (D8, Q44).
  - The `_user` backfill and reconcile run as operator-started jobs (D9); the
    reviewed `workflow_dispatch` workflow of Q41 moved to `045`.
  - The status hooks reach `_user` through an adapter in `apps/api` that the app
    and the bootstrap script must wire (D2). The human `_user` status read of
    D13 is new code with its own cache. The accept limiter uses the DB-backed
    store through an exported helper (D4), the accept route performs its own
    `Origin` check and wires the SSO re-authorization (D4), and every limiter
    answers with `Retry-After` (D4). `authz_denied` is emitted through
    `@tayzu/catalog` (Observability contract).
  - Superseded decision rows are annotated, not deleted (Q9, Q11, Q14, Q24).
- **Amended a fourth time on 2026-10-01** after Resolved decisions Q48-Q57, a
  fourth drift-check and a fourth VCDM pass. Mechanical fixes, so that a reader of
  the older text is not surprised:
  - Each maintenance script is its own Container Apps Job (D9, Q49); the purge, which
    uses no `SECURITY DEFINER` function, moved to `045` (Q48).
  - The `_user` backfill is a repeatable reconcile that also creates the missing
    `_user` rows, and a member without one is rejected with the reason
    `user_missing` (D1, D13, Q46, Q50). The bootstrap CLI moves to
    `apps/api/scripts` (D2, Q51).
  - The identity OpenAPI document carries paths, methods, path parameters and
    `x-tayzu-risk` only (D10, Q52). `defineIdentityOperation` keeps `002`'s
    caller-tenant-first and fail-closed guarantees (D10, Q57).
  - The emails share the kill switch and the per-recipient bucket, with a
    per-tenant notice cap and at most 20 recipients per notice (D4, D5, Q53; the
    org-deletion notice joins them in `045`; since Q101 the notices count in a
    per-recipient bucket of their own). A banned user's sign-in fails like any
    other failure (D13, Q54).
    Service accounts and credentials are capped per tenant (D6, D8, Q56).
  - Other fixes: `identity.users.create` and the membership hook no longer write
    the status twice (D2); the limiters' `Retry-After` goes through oRPC's
    `ResponseHeadersPlugin` and is uniform across the invitation caps (D4); the
    rate-limit scope enum of `002` is amended, not only widened (D4); the
    canonical-email function lives in `apps/api` (D4); credential reads page over
    the text `metadata` column (D7); the password is NFC-normalized inside the hash
    and verify functions (tasks 8.1d); the breached-password check is stubbed for
    every integration test (tasks 8.1a); the test harness gains the `tayzu_auth` login
    role (tasks 2.0b); the tests of the scripts live in `src/` (tasks 1.4).
- **Amended a fifth time on 2026-10-01** after Resolved decisions Q62-Q69, a fifth
  drift-check and a fifth VCDM pass. Mechanical fixes, so that a reader of the
  older text is not surprised:
  - Every `service_account` route answers `CATALOG_NOT_FOUND` for a target that is
    not a service account, and `accountKind` reaches Cerbos with a deny (D3, D6,
    D14, Q62). Acceptance fails unless the inviter is still an active, non-banned
    admin member (the admin-role part is a Cerbos `user`/`invite` decision since Q108,
    D4 step 2), and disabling a user cancels the invitations that user created
    (D4, D13, Q63).
  - The invitation caps keep 002's reset-after-a-quiet-window semantics, pinned by
    a test (D4, Q66). A real email sender outside production needs a
    recipient-domain allowlist (D5, Q67) (**superseded by Q96 and Q99**: mandatory
    only for a real provider under `NODE_ENV=test`, honored wherever it is set). One
    `auth-repository.ts` in `apps/api` serves every identity read of `apikey`,
    `invitation` and `member`, with a lint ban on direct adapter access (D14, Q69).
  - The breached-password check sees an NFC password: the body fields are
    normalized in a `before` hook that runs ahead of the plugin, because the plugin
    wraps the hash function from the outside; `PASSWORD_CHECK_PATHS` stays the rate
    limiter's list and is not reused (tasks 8.1b, 8.1d). The breached-password stub
    is a `setupFiles` entry of the integration project, not the `globalSetup`
    (tasks 8.1a).
  - The bootstrap file is split: `bootstrapAdmin()` moves to `packages/auth/src/`
    and the CLI to `apps/api/scripts/`; the membership hook is the only writer of the
    bootstrap admin's `_user`; `UserSyncInput` has two definitions, both edited, and
    `refreshDisplayData` never creates a row (D2, tasks 4.1, 4.1c, 4.6, 4.6b). Every
    existing human-session fixture gets a `_user` row before the resolver starts
    rejecting a missing one (task 11.0). The machine-credential test helpers that
    pass session headers are migrated (task 9.1b).
  
  - The resolver checks branch on the credential (bearer or cookie), never on
    `actor.type`, which the lint rule bans outside three files (D13). The reconcile
    runs before the release that carries the `user_missing` rejection reaches an
    environment that has members, because the rejection also applies to the catalog
    `/v1` routes (Gates, Migration Plan). Stale counts (`Q1-Q57`, "four Open
    Questions", `PUBLIC` `EXECUTE`) were corrected.
  - Non-blocking VCDM items folded in: key creator attribution, role check before
    input parsing, `044` in the Gates, a generic answer for every create and link
    conflict, denylist provenance, three more log events (D5, D6, D7, D10, tasks
    9.2, 13.3, 1.3, 15.1); the rest are tickets (Risks, Tickets).
- **Amended a sixth time on 2026-10-01 and 2026-10-07** after Resolved decisions
  Q70-Q85, a sixth drift-check and a sixth VCDM pass. Mechanical fixes, so that a reader of the older
  text is not surprised:
  - An SSO link that an admin recorded does not survive into a second tenant: the
    linking tenant is recorded in an `auth.verification` marker and every
    admin-recorded link of another tenant is shed at existing-account acceptance and
    in `afterAddMember` (D4, D14, Q73; **superseded by Q86-Q88**: provenance is
    positive and the shed revokes sessions, see the seventh amendment). The
    invitation acceptance runs in one Better Auth transaction (`transaction: true`),
    with the `_user` write in `afterAddMember` failing closed; the reconcile removes
    an orphan `_user` (D1, D2, D4, Q75; **the single transaction is superseded by
    Q89**, see the seventh amendment, and since Q112 the acceptance's own `_user` step
    makes that write, see the ninth amendment).
  - The identity telemetry names live in a separate identity contract module that
    `otel-smoke-check` also imports; `contract.test.ts` of `002` is untouched
    (Observability contract, Q74). The `_user` is written only by the membership hook
    (for a membership outside the acceptance; since Q112 and Q120 the acceptance's own
    `_user` step writes its member's row, see the ninth and tenth amendments),
    the two direct-write tests of `user-sync.int.test.ts` are rewritten and the hook
    passes an intent that the adapter turns into an event, with `expectedVersion` and
    a bounded retry (D2, Q76). A `Disabled` or missing human `_user` is rejected with
    `401 CATALOG_CONTEXT_REQUIRED` (D13, Q77; widened by Q105 to every status other
    than `Active`, see the eighth amendment). The machine-credential functions are
    exported only on `@tayzu/auth/machine-credentials` (D8, Q78). Each maintenance
    script starts and flushes telemetry (D9, Q79). A tenant list keeps demo tenants
    from sending real mail, and the SHA-1 prefix is a recorded exception (D5, Q80,
    Q81).
  
  - Stale text corrected: `Q1-Q69` and "two Open Questions pending". Smaller fixes: the
    `ENTITY_IDENTIFIER_PATTERN` has two private copies and `identifiers.ts` is the
    source (D4); `USER_BLUEPRINT` and its builder are exported for the backfill
    (D1); the breached-password stub is an `.mjs` file that the whole `dast.sh up`
    loads (D11); the accept route reads `user.banned` and the temporary-password
    marker itself (D4); `Retry-After` needs a change in the error mapping (D4);
    single caps use `optionalPositiveInt` and the mount switch needs a boolean
    parser (tasks 9.5d, 10.8, 14.3); the scripts read a separate configuration
    loader (task 2.0b); the viewer returns the credential id and a page as large as
    the credential cap (D7); every operation has a fixed opaque resource id (D3);
    the identity repository also covers `session`, `user` and `account` (D14). Q85
    fixed the names and values the amendment introduced
    (`ACS_CONNECTION_STRING`, `EMAIL_PROVIDER`, Better Auth's 256-unit password
    bound, the viewer page of 200, the fifth Q55 checklist item and the
    `sso-link:<accountId>` marker identifier, which Q87 then pins to the `account`
    row's own id).
- **Amended a seventh time on 2026-10-07** after Resolved decisions Q86-Q98, a
  seventh drift-check against the merged `002` and a seventh VCDM pass. Mechanical
  fixes, so that a reader of the older text is not surprised:
  - Joining a second tenant (the shed) and an admin unlink revoke the user's
    sessions, so a session issued through the link cannot reach the joined tenant
    (Q86). Link provenance is positive: a marker is written for the links the user
    makes, keyed by the `account` row's id, every unmarked link counts as
    admin-recorded and is shed, and one advisory lock per user closes the race
    between a link and a join (Q87). An admin cannot record a link on an admin or an
    owner (Q88) (D4 step 7, D14).
  - The acceptance has **no single transaction**: Q75's `transaction: true` is
    superseded by idempotent steps with the token consumed last, a compensation for
    what the attempt itself created, and the reconcile for orphans, which now waits a
    one-hour grace period (D1, D4, Q89; **measured from the row's `updatedAt` since
    Q124**, see the eleventh amendment).
  - A service account's id is its `svc-…` identifier (Q90). The bootstrap CLI is
    operator-run out of band, as `002` designed it (Q91). Password, MFA
    and email-change notifications go to `044` (Q92). The per-recipient cap key is an
    HMAC under `IDENTITY_TOKEN_HMAC_SECRET` (Q93). ADR-0013 gets a note on Better
    Auth's `ac` roles (Q94). `002`'s gate items are restated in the Gates (Q95).
    "Production" is `NODE_ENV !== 'test'` (Q96). A banned or expired-marker sign-in is
    made uniform after the password was verified (Q97). The `NODE_ENV=test` refusal
    lives in `createAppFromEnv` (Q98).
  - Drift fixes against the merged `002`: the ban hook cannot see the old value, so a
    redundant event is a no-op (D2); the status adapter reads, writes with
    `expectedVersion` and creates through `entities.create` (D2); the accept route
    peeks the session without refreshing it, and a tenant holds at most 100 members
    (D4); every script's own role assertion (D9); the
    identity router joins the catalog router in one handler (D10); spans and counters
    go through `@tayzu/auth` helpers, and the new rate-limit scopes reach `002`'s
    metric and log event (Observability contract, D4); and the stale "Q99"
    references, the amendment header and the overlap of `Q70`-`Q84` with `002`'s own
    numbering were corrected (Resolved decisions).
- **Amended an eighth time on 2026-10-07** after Resolved decisions Q105-Q110, an eighth
  VCDM pass and an eighth drift-check, and with Q101 and Q102 (answered with the seventh
  amendment) folded in. So that a reader of the older text is not surprised:
  - A failed or retried existing-account acceptance still sheds (Q105): the
    existing-account path deletes the membership it created when a later step fails
    (**narrowed by Q118**: only when the failing step comes before the `_user` step; see
    the tenth amendment), the acceptance runs the shed as an explicit idempotent step of every attempt once the
    membership exists, `resolveContext` admits a human only when the `_user` status in the
    active tenant is `Active` (the "`Disabled` or missing" rule of Q25, Q46 and Q77 is
    superseded: `Invited` and `Staged` are rejected too), and the reconcile sheds before
    it creates a `_user` for a member of two or more tenants (D1, D4 steps 4 and 7, D13).
  - The ban hook (`databaseHooks.user.update.after`, which receives the new row with its
    `id` but not the old row) writes only `admin_disable`, for `banned === true`, and
    never `admin_enable`; re-enabling is `setStatus` only (D2, Q102).
  - The SSO callback refuses a session through an account that no longer exists or that
    is unmarked while its user belongs to two or more tenants, the shed sweeps the
    sessions a second time after its deletion commits, and when the shed removed a link
    the accepting session is revoked too, after the acceptance commits (**moved by Q122**
    to right after the attempt's `_user` step; see the eleventh amendment), which amends
    Q86's exemption (D4 step 7, Q106).
  - Catalog spans carry a fixed placeholder instead of a `_user` identifier
    (Observability contract, Q107); the inviter re-check is a Cerbos `user`/`invite`
    decision, not a local role mapping (D4 step 2, Q108); the startup role assertion
    covers `machine_credential_revocation` in this change, so the Gates no longer depend
    on `045` for it (Q109); and `identity.users.create` cancels a pending invitation of
    the same email in the tenant with the reason `user_created` (D4, Q110).
  - Non-blocking items folded in: the notices count in a per-recipient bucket of their
    own, under a new rate-limit scope `notice_recipient`, which makes six new scopes in all (D4, Q101); the account-linking
    configuration is pinned, a self-service link with a different provider email is
    refused, and a failed marker write deletes the link it was written for (D4 step 7);
    `invitation_cancelled` carries the tenant and the actor and `invitation_resent` the
    actor type (Observability contract); deleting a service account takes the
    per-service-account lock, and creating one is refused while a credential is still
    bound to its identifier (D6); two tickets (one Visma Connect link per user, and the
    shed on a future member-role change).
  - Drift fixes against the merged `002`: the shed lives in `apps/api` and reaches
    `afterAddMember` through a structural port (D4 step 7); `emitSessionRevoked` is
    exported with its reason as a parameter, and `sso_link_shed` amends `002`'s closed
    reason enum (D13, Observability contract); a banned sign-in is refused by the admin
    plugin before any session exists, so the uniform failure rewrites that error and logs
    `login_failed` with `account_disabled` (D13); `tayzu.identity.service_account.id` is
    the `svc-…` identifier (Q90, Observability contract); the role check before parsing is
    true today only for `create` (D10); the Gates cite `002` Q58, `002` Q62 and `002` Q84; and the
    stale "pending Q99", "fifteen routes", "lister", "nothing is renumbered" and
    "deletion-marker lookups" texts were corrected.
- **Amended a ninth time on 2026-10-08** after Resolved decisions Q111-Q115 (the eighth
  amendment's Open Question 1, a ninth VCDM pass and a ninth drift-check). So that a
  reader of the older text is not surprised:
  - The first-sign-in hook activates a `_user` only for a user who holds exactly one
    membership; for a user of two or more tenants it writes nothing, so a second tenant's
    `Invited` or `Staged` row stays rejected by the resolver (D2, Q111). Its repair is a
    retry of the same invitation within 48 hours or the operator repair of Q100.
  - The `_user` of a joined tenant is activated only after the shed: inside the
    acceptance's shared context `afterAddMember` makes no `_user` write (**scoped by
    Q120** to the acceptance's own member; see the tenth amendment) and the
    acceptance's own `_user` step runs after the shed, and on the other membership paths
    the hook runs the shed before its `_user` write (D2, D4 steps 3, 4 and 7, Q112). The
    "shed failed, then compensation failed" residual is therefore the fail-closed
    `Invited` case of Q111 (Risks).
  - `catalog.audit.mutation` carries the placeholder of Q107 instead of a `_user`
    identifier (Observability contract, Q113).
  - One shed core in `apps/api` runs on the `tayzu_auth` pool with parameterized SQL
    inside the `withUserLock` transaction, for all three shed paths, so the reconcile
    builds no Better Auth instance and holds no `BETTER_AUTH_SECRET` (D1, D4 step 7, D9,
    Q114).
  - Low gaps folded in (Q115): the stale group number of
    `docs/security/attack-surfaces.md` (task 16.6), the SSO callback failing closed when
    it recorded no account and the pin of `account.updateAccountOnSignIn` (D4 step 7), a
    logged failure of the post-commit revocation of the accepting session (**after the
    `_user` step since Q122**; see the eleventh amendment), and a declared
    `catalog.security.identity_conflict_refused` event (Observability contract); two
    tickets, TK9-1 and TK9-2 (Tickets).
  - Mechanical fixes of the ninth drift-check (N2 and N4-N9, no new decision): Better
    Auth's hook context is ambient, so the marker hooks fall back to
    `(await auth.$context).adapter` outside an endpoint and the self-link events are
    emitted by route path, not by the presence of a context (D2, D4 step 7); the uniform
    sign-in failure is a returned `Response`, because a thrown `APIError` keeps the
    original status (D13); `/link-social` updates an existing row of the same `sub` and
    writes no marker, so an unshed pre-dating link of a user already in two tenants is
    repaired by an unlink, then a link (D4 step 7, Risks); the `auth` repository holds a
    tenant-keyed `member` delete and names its only exceptions (D14); and the DAST link
    origin (task 6.7b), the order of the `NODE_ENV=test` refusal (task 13.8) and the
    tasks header were corrected.
  - Consistency fixes after the ninth amendment (no new decision): the compensation's
    rationale (D4 step 4) and the list of status writers (D2, D6) follow Q105 and Q112,
    the identifier rule of the Observability contract names `catalog.audit.mutation`
    (Q113), every reference to a decision of `002` carries the `002` prefix, D16 counts
    twelve path templates for the fourteen routes, and the tasks run after what their
    tests use, the reconcile becoming task 4.2b (it was 2.2b; tasks header).
  - A second consistency check (no new decision; it left one open question): an
    assertion that needs a later task's code is that later task's case (tasks header);
    the hand-off rule names every closing task outside group 13 (Hand-offs, Gates);
    `identity.users.setStatus` is in the list of status writers (Goals); D14 lists every
    internal-adapter exception of the `auth` repository and says that the maintenance
    scripts are not its clients (D13, D14); and the rule that `tayzu.actor.id` is the
    admin who acted is scoped to the operations an admin initiates, while the actor of
    an acceptance and of the bootstrap was Open Question 1 (Observability contract, D2,
    D4 step 3; answered by Q116, see the tenth amendment).
  - A third consistency check (no new decision; it left a second open question): the
    `auth` repository gains `globalInvitationById` and `globalMembershipTenantsOf`, the
    two reads of tenant-keyed models that are global by nature, and a tenant-keyed
    `session` delete for the tenant-scoped disable (D13, D14); `credentials.list` has
    the fixed resource id `list` (D3); a rotated key's metadata records `rotatedAt` and
    the rotating admin (D8); the identity telemetry helpers and the then empty identity
    contract module exist from task 2.0c, before the first task that emits an identity
    signal (Observability contract); the SEC16 posture scopes the actor rule as the
    Observability contract does; and which status changes
    `catalog.audit.user_status_changed` records when no admin acts, and with which
    actor, was Open Question 2 (Observability contract; answered by Q117, see the tenth
    amendment).
- **Amended a tenth time on 2026-10-08** after Resolved decisions Q116-Q121 (the ninth
  amendment's two open questions, a tenth VCDM pass, G10-1 to G10-4, and the tenth
  drift-check's items D-1 to D-4). So that a reader of the older text is not surprised:
  - The acceptance names the invitee: its `catalog.audit.invitation_accepted` carries
    the invitee's Better Auth user id as `tayzu.actor.id` (actor type `user`), the same
    id as the `onBehalfOf` of its `_user` step on both paths. The bootstrap CLI requires
    the operator's opaque id from its environment, validated like the reconcile's and
    refused when absent, and records it as `tayzu.identity.operator.id` on its
    `user_created` and as the `onBehalfOf` of the hook's `_user` write (D2, D4 step 3,
    D9, Observability contract, Q116).
  - `catalog.audit.user_status_changed` records every status change: the adapter of D2
    emits it after every write that changes a status, naming the principal that the
    write has (the admin, the operator, the user on first sign-in, the invitee on
    acceptance, none for the ban hook) and carrying the bounded status event as
    `tayzu.identity.user.status.event` (D2, Observability contract, Q117).
  - On the existing-account path a failure after the acceptance's `_user` step no longer
    deletes the membership: the attempt fails, the token stays valid and a retry
    completes the acceptance; the compensation covers only the steps before the `_user`
    step (D4 step 4, Risks, Q118).
  - For a `_user` entity the catalog sends the placeholder of Q107 as the Cerbos
    `resource.id`, `redactUnreadable` sends positional ids, and the route-template
    rewrite of D16 also covers the catalog entity routes whose blueprint is `_user`;
    D3's claim that only opaque ids reach Cerbos's decision log is corrected (D3, D12,
    D16, Observability contract, Q119).
  - The acceptance's shared context carries its `(tenantId, userId)`, so the two ports
    skip only for that member, and the self-link marker is written only on the callback
    route (D2, D4 step 7, Q120).
  - The high `source-map-js` advisory that failed `pnpm audit` on master is fixed outside
    this change (commit `c133f21`), so task 16.9 is not blocked by it (Q121).
  - A consistency fix within Q106 (no new decision): when an acceptance attempt's shed
    removed a link and the attempt then failed, the retry's shed removed nothing, so no
    session was revoked, although the session that attempt kept may have come through
    the shed link. A shed that removes a link at acceptance now records the session it
    kept, in the same transaction, and the acceptance that commits revokes that session
    and its own (**every attempt, right after its `_user` step, since Q122**; D4 step 7,
    task 8.5m). The case of an attempt that fails after its
    `_user` step and is never retried was Open Question 1 (answered by Q122, see the
    eleventh amendment).
  - Two mechanical fixes of the tenth drift-check (no new decision). Every catalog
    write of the backfill and the reconcile is authorized by Cerbos like any other, the
    `system` actor included, so each script declares `CERBOS_ADDRESS` and each job runs
    its own Cerbos sidecar with the `apps/api` revision's policy bundle, on the loopback
    link of `002` Q8 (D9, D12, Gates, Migration Plan; tasks 2.0b, 2.2, 4.2b, 8.5l, 16.7
    and 16.8; drift D-1). The two `account` reads of the existing link procedures, which
    called the internal adapter, become the repository's `globalAccountByKey` and
    `globalAccountsOf`, and the lint ban covers the internal adapter's `account` reads
    (D14; tasks 5.1b and 5.1c; drift D-4).
  - A consistency check of the tenth amendment (no new decision): every passage on the
    shared context names the acceptance's own member (Q120; D4 step 3, tasks 4.2, 8.2,
    8.5b, 8.5h and 8.5i); the serialized-attempts ticket and the retried-acceptance
    scenario follow Q118; `catalog.audit.service_account_created` is in the spec's list
    of logged events and tested by task 10.3; `docs/catalog/catalog-core.md` records the
    `_user` route templates in task 15.5 (D12); and Open Question 1 names every passage
    its answer amends (the answer is Q122, applied in the eleventh amendment).
- **Amended an eleventh time on 2026-10-08** after Resolved decisions Q122-Q126 (the
  tenth amendment's Open Question 1, the eleventh VCDM pass's G11-1 and G11-5, the
  eleventh drift-check's N-1 and a confirmation of the tenth amendment's choice of
  subject). So that a reader of the older text is not surprised:
  - On the existing-account path, what is owed to a join runs as soon as the attempt's
    `_user` step has run, before the `emailVerified` write and the consumption of the
    token, not after the acceptance commits: every attempt revokes its own accepting
    session and the session an earlier attempt's shed recorded, when its shed removed a
    link or the record exists, and deletes the record after a successful revocation; and
    the attempt whose `_user` step activated the row sends the admin notice, so a retry
    sends none. An attempt that fails after its `_user` step and is never retried, or
    whose token delete removes no row because a concurrent resend replaced the digest,
    therefore leaves nothing owed to the join undone. On the new-account path the notice
    still follows the commit, so there a consumption that changes no row after the
    `_user` step leaves the join standing with no notice (the twelfth amendment's Open
    Question 1, answered by Q127, which sends the notice for such a consumption too; see
    the thirteenth amendment). The residual, a crash between the activation and the
    notice, is in Risks (D4 steps 4, 6 and 7, D12, Observability contract, Tickets, Q122;
    it amends Q86, Q106 and Q115).
  - The acceptance sets the invitation's status to `accepted` in the same `tayzu_auth`
    transaction as the digest-conditioned token delete, through a tenant-keyed write of
    the `auth` repository conditioned on `pending`; resend, cancel and the `user_disabled`
    and `inviter_disabled` cancellations skip an invitation that is not `pending`, an
    accepted invitation no longer counts toward the pending limit, and a replay is
    logged as `already_accepted` (D4 steps 1 and 5, D4 "Resend", D13, D14, Q123).
  - The orphan grace period of the reconcile is measured from the `_user` row's
    `updatedAt` (its activation), not its `createdAt`, so a failed new-account
    acceptance of an invitation older than one hour stays protected while a retry is in
    flight (D1, Risks, Q124; it amends Q84 and Q89).
  - Task 4.1d rewrites the existing case of `packages/authz/src/redaction.test.ts`,
    whose assertion becomes "the ids are positions and no candidate id is in the
    request", and the PR calls it out (Q125, which follows Q119).
  - The `catalog.audit.user_status_changed` of the invitation hook's `created_invited`
    write names its subject by `tayzu.identity.invitation.id` in the contract, D2, task
    4.1e and the spec (Q126, a consistency check).
  - Mechanical fixes of the eleventh drift-check and the eleventh pass's low gaps (no
    new decision). The `UserSyncPort` input gains `userId`, the Better Auth user id that
    the membership hook, the ban hook and the first sign-in pass (and
    `refreshDisplayData`, named by the thirteenth amendment; absent only for the
    `created_invited` write, which passes the optional `invitationId` instead, added by
    the twelfth amendment), without which the adapter could not compare the
    acceptance's `(tenantId, userId)` (Q120) or name the subject of a hook write (Q117)
    (D2, tasks 4.1, 4.1e, 4.4, 4.5; N-2). The shed's `invitation-shed:<invitationId>`
    record is written by a delete and an insert, not an upsert, because `identifier` has
    no unique index (D4 step 7, task 8.5m; N-3). Task 4.1 names a new catalog
    `user-sync.int.test.ts`, since no test of `createUserSync` exists (N-4). The
    per-referrer `update` check of a delete sends the placeholder for a `_user` referrer
    (D3, Observability contract, task 4.1d; N-5, G11-3). A gate verifies with `010` that
    a job run completes while its Cerbos sidecar keeps running (D9, Gates; G11-2). Task
    15.5 adds `%40`-encoded paths (D16; G11-4). The dev-toolchain advisories are the
    ticket TK11-1 (Tickets; G11-6).
- **Amended a twelfth time on 2026-10-08** after a consistency check of the eleventh
  amendment, in three passes. Its fixes take no new decision; three points that only the
  human can decide were its Open Questions 1 to 3, answered on 2026-10-09 by Q127, Q128
  and Q129 and applied by the thirteenth amendment (below). So that a reader of the older
  text is not surprised:
  - The `UserSyncPort` input also gains an optional **`invitationId`**, the
    `invitation.id` that `afterCreateInvitation` receives, which the invitation hook
    passes for its `created_invited` write in place of `userId`, so that the adapter can
    emit the subject that Q126 fixes, `tayzu.identity.invitation.id` (D2, D4 "Hooks",
    tasks 4.1, 4.1e and 7.3). Tasks 7.3 and 15.1 cite Q126 for that subject, not only
    Q117.
  - A consumption whose `accepted` write changes no row because a concurrent
    cancellation committed first takes the lost-race path too (Q123), and the rationale
    of that path covers the cases with no winner, a concurrent resend or cancellation,
    which the flow cannot tell from a lost race (Q122) (D4 steps 1 and 4, task 8.1e). A
    Risks bullet records that such a cancellation leaves the join standing under a
    `cancelled` invitation.
  - Open Question 1: on the new-account path such a consumption compensates nothing, so
    the join stands, but the admin notice, which follows the commit, is never sent (D4
    step 6; answered by Q127). Open Question 2: the `pending` check of resend and cancel
    (Q123) is a read before the write, not atomic with the acceptance's conditioned write
    (D4 "Resend"; answered by Q128).
  - Second pass. A lost race to consume the token (a token delete or an `accepted`
    write that changes no row) is a rejected acceptance: it answers the uniform
    rejection (`CATALOG_NOT_FOUND`) on either path and logs
    `catalog.security.invitation_acceptance_denied` with a new denial reason,
    `consume_conflict`, because the flow cannot tell a winner from a concurrent resend
    or cancellation; the compensation of the new-account path (D4 step 3) states that it
    excludes such a race, as D4 step 4 and task 8.1e already did (D4 steps 3, 4 and 5,
    Observability contract, spec "Invitation acceptance", tasks 8.1e, 8.3, 8.5m, 8.7,
    8.15 and 15.1).
  - Second pass. The refused resend of an invitation that is not `pending` answers
    `CATALOG_VALIDATION_FAILED` with one fixed message, the answer the change gives to an
    operation that its target's state forbids (D2, D8); what the cancel of such an
    invitation answers was Open Question 3 (D4 "Resend", spec "Invitation lifecycle",
    tasks 7.6, 7.7 and 8.10; answered by Q129).
  - Second pass. Open Question 1 also names D4 "Notice emails", whose parenthetical its
    recommended option would change, and Open Question 2 names, for its options 2 and 3,
    D4 "Reaching Better Auth" and "`users.create` and a pending invitation", D14, the
    Q42, Q47 and Q110 rows and tasks 5.1b, 7.2, 7.5 and 8.3, which the tasks header
    kept unticked until the answer (Q128 chose option 1, so those passages and tasks
    stay as they are and the hold is released; see the thirteenth amendment).
  - Third pass. Open Question 2 also names the proposal ("Invitations") and, for its
    options 2 and 3, the proposal ("Mandatory authorization", the repository's writes),
    and quotes the spec's current refusal of a resend; task 7.6 waited for Open Questions
    2 and 3 (answered by Q128 and Q129). On the new-account path a compensated failure after the `_user` step leaves
    the `_user` that the invitation hook created `Active` with no membership, because the
    compensation deletes only what the attempt created: a retry's `_user` step is a no-op
    and, with no retry, the reconcile removes the row one hour after its activation (D1,
    Q124), not only after a failed compensation (D4 step 3, spec "Invitation acceptance",
    task 8.1e). The proposal states the lost-race exception of the compensation and that
    the sessions are revoked only when a shed of the invitation removed a link (D4 step 7),
    the sixth amendment's "written only by the membership hook" is annotated for Q112
    and Q120, and task 6.5 cites Q99 for the allowlist under `NODE_ENV=test`.
- **Amended a thirteenth time on 2026-10-09** after Resolved decisions Q127-Q130 (the
  twelfth amendment's Open Questions 1 to 3, answered with their recommended options, and
  the twelfth drift-check's N12-1), with the mechanical items of the twelfth pass and
  drift-check. No question is open any more (Open Questions). So that a reader of the
  older text is not surprised:
  - On the new-account path the admin notice is sent after the acceptance commits (the
    token consumed) **or when the consumption changes no row** (D4 step 1), which takes
    the lost-race path, compensates nothing and leaves the join standing; a failure that
    is compensated (D4 step 3) sends none. On that path this holds whether or not the
    attempt's own `_user` step activated the row, so a new-account retry after a
    compensated failure still announces the join; the existing-account path keeps Q122's
    rule (the attempt whose `_user` step activated the row sends it). Two residuals are
    in Risks (a third, the concurrent duplicate, is named by the third pass below): a
    crash between the zero-row consumption and the notice loses the notice, and an
    attempt compensated on the new-account path whose retry runs the
    existing-account path, because an account for the email was created meanwhile, sends
    none (twelfth-pass VCDM G12-2) (D4 steps 4 and 6 and "Notice emails", Risks, Q122
    annotated, proposal, spec "Invitation acceptance", tasks 8.1e and 8.15; Q127).
  - The window between the `pending` check of resend and cancel (and of the
    `user_created`, `user_disabled` and `inviter_disabled` cancellations) and the
    acceptance's `accepted` write is a documented residual: a cancel or a resend that
    read `pending` just before an acceptance committed still cancels or re-tokens that
    invitation, never touching the membership or the `_user`, and Better Auth's re-invite
    cancel keeps the same window. The spec's skips hold "except for a cancel or resend
    that races the consumption (Risks)", and the structural fix is the new ticket TK12-1
    ("Serialized invitation writes"), which extends TK9-2's per-invitation lock (D4
    "Resend", D13, Risks, Tickets, Q123 annotated, proposal, spec "Invitation
    lifecycle"; no task gains a case; tasks 7.6, 7.7 and 8.10 cite it; Q128).
  - An admin's cancel of an invitation that is not `pending` is refused like the resend:
    `CATALOG_VALIDATION_FAILED` with the same fixed message, nothing changed and nothing
    logged; the internal cancellations (`user_created`, `user_disabled`,
    `inviter_disabled`) answer nothing and only skip, and a missing or foreign invitation
    still answers `CATALOG_NOT_FOUND` (D14). Under Q128 the refusal is best-effort inside
    the race window (D4 "Resend", Q123 annotated, proposal, spec "Invitation lifecycle",
    tasks 7.6 and 8.10; Q129).
  - Q125's rewrite extends to the catalog's `002` redaction fixture,
    `packages/catalog/src/service/__fixtures__/redaction-authz.ts`, which keeps answering
    by the `resource.id` it receives (a position for the redaction batch, while the
    operation's own single-resource check keeps its identifier, so only its header
    comment changes; corrected by the fourteenth amendment), and to the `batches[].ids`
    assertions of three catalog integration tests, `entities-delete.int.test.ts`,
    `blueprints.int.test.ts` and `blueprints-update.int.test.ts` (in
    `packages/catalog/src/service/`), each of which
    becomes "the ids are positions and no candidate identifier is in the request"; the
    `referrers`, `notVisible` and no-leak assertions stay, and the PR calls the rewrite
    out (Q125 annotated, proposal, task 4.1d; Q130). The readable positions are
    deterministic where the candidates are ordered by identifier
    (`entities-delete.int.test.ts` and `blueprints.int.test.ts`); in
    `blueprints-update.int.test.ts` the compatibility check streams them in `id` order
    over `randomUUID()` ids, so that test derives them from the seeded rows read back in
    `id` order (corrected by the fourteenth amendment; G13-1).
  - The tasks header releases the hold that kept tasks 7.6, 7.7, 7.13, 8.1e, 8.10, 8.15,
    11.4 and 11.4b (and, for Open Question 2's other options, 5.1b, 7.2, 7.5 and 8.3)
    unticked until the answers.
  - Mechanical fixes of the twelfth drift-check and the twelfth pass's low gaps (no new
    decision). The adapter's entry point that the acceptance's `_user` step calls
    returns the status event it wrote, or none (`invitation_accepted` or
    `created_active` means that the attempt activated the row), so the existing-account
    admin notice of Q122 is sent only on an activating result; the hook-facing
    `UserSyncPort.upsertUser` stays `Promise<void>` (D2, D4 steps 4 and 6, tasks 4.1 and
    8.15; N12-2). `refreshDisplayData`, the `upsertUser` caller in `auth.ts` beside the
    hooks, passes its `account.userId`, so `userId` stays absent only for the
    `created_invited` write (Q126) (D2, task 4.1; N12-3). The ticket "Alerts for `010`"
    adds `catalog.security.invitation_acceptance_denied` with the reason
    `consume_conflict`, whose every event is an attempt that keeps its join without
    committing its acceptance, and points at TK12-1 as the structural fix (except for
    the `re_invite` cancellation, which keeps its window, Q42) (Risks, Tickets; G12-1).
    The residual of an attempt compensated on the new-account path whose retry runs the
    existing-account path is named in Risks (Q127; G12-2). The
    fallbacks to a per-job Cerbos sidecar put the simpler ones first, Cerbos as a child
    process inside the job container or the job reaching Cerbos over TLS (`002` Q8), and
    the script ending the replica itself last (D9, Gates; the G11-2 follow-up).
  - Consistency check of the thirteenth amendment (no new decision). The viewer's page
    is the configured credential cap of D8 (200 by default), not a literal 200, since
    the cap is configurable (Q56) and a smaller page would hide non-revoked credentials
    (D7, Q85 annotated, task 9.2). The spec's admin-notice requirement names its two
    residuals (Risks, Q122 and Q127; a third, the concurrent duplicate, is added by the
    third pass below), and its scenario's retry that sends the notice is a new-account
    one (proposal, spec "Invitation acceptance"). The Non-Goals list of
    `002` code this change edits names the later edits too, and D4 step 2 names
    `toCerbosRole` (Goals / Non-Goals, D4 step 2, proposal). The kill switch's need for
    a new revision is recorded in `docs/security/data-retention.md`, as D4 says (D12,
    task 16.5). Task 10.7 resolves its target through 10.7b's resolver only once that
    exists, as 9.5b does. Two findings-to-coverage rows that pointed at the removed
    Open Questions are annotated.
  - Consistency check of the thirteenth amendment, second pass (no new decision). D12,
    task 16.5, task 6.5b and D5 "Sender selection" cite Q99 for the recipient-domain
    allowlist beside Q67 and Q96, as task 6.5 does since the twelfth amendment's third
    pass, and task 16.5 states Q99's rule (mandatory only for a real provider under
    `NODE_ENV=test`, honored wherever it is set). The bootstrap CLI declares the roles
    `tayzu_auth` (the `AUTH_DATABASE_URL` pool) and `tayzu_app` (the `DATABASE_URL`
    pool) for the role assertion of task 2.0, and its test covers a pool connected as
    an undeclared role being refused before any write (D9, task 4.6b). The Q6 row is
    annotated with D10's ten-operation high-risk set (Q19, Q31, VCDM B11), with
    `organization.delete` being `045`'s.
  - Consistency check of the thirteenth amendment, third pass (no new decision). Task
    4.1 asserts the result of the acceptance's entry point only for explicit
    `StatusEvent` inputs, and task 4.1e only the subject of an explicit port input: the
    entry point's result for the `membership_added` intent and the membership hook's
    `userId` subject need 4.2's derivation, so they are cases of 4.2 (tasks header,
    tasks 4.1, 4.1e and 4.2). Because acceptance attempts are not serialized (TK9-2), a
    new-account attempt and a concurrent existing-account attempt of the same invitation
    (the invitee signing in with the password the first attempt set, before that
    attempt's `_user` step) can each send the admin notice, a harmless duplicate that
    follows from Q122 and Q127; it is named beside their residuals and among what
    TK12-1 would close (D4 step 6, Risks, Tickets, proposal, spec "Invitation
    acceptance"). The Q123 row is annotated for the twelfth amendment's lost-race path of
    a zero-row `accepted` write and for Q127. Task 8.10 asserts the refusals of Q123 and
    Q129 for a cancelled and a rejected invitation too, not only an accepted one.
- **Amended a fourteenth time on 2026-10-09** with the mechanical fixes of a final
  consistency check of the thirteenth amendment (C-1 to C-10), of the thirteenth
  drift-check (N13-1 to N13-3, N13-1 being the thirteenth pass's G13-1) and of the
  thirteenth pass's V13-note, all within Resolved decisions Q1-Q130 (no new decision),
  and with Resolved decision Q131, which answers its own drift-check's N14-2 (the last
  bullet below); no question is open (Open Questions). So that a reader of the older
  text is not surprised:
  - `toCerbosRole` is exported from `context-resolver.ts` and added to the `@tayzu/auth`
    package index, as `isIdle` is, because the acceptance that rebuilds the inviter's
    principal lives in `apps/api` and `@tayzu/auth`'s `exports` map has no entry for
    `context-resolver.ts` (only its index and, from task 9.1c, the `machine-credentials`
    subpath of Q78) (Goals / Non-Goals, D4 step 2, proposal, task 8.5f; C-1, N13-3).
  - The referrer redaction sends positional ids for every candidate, whatever its
    blueprint; only the single-entity checks of other blueprints' entities (the
    operation's own check and `mayUpdateReferrer`) keep their identifiers (Observability
    contract, Q119 annotated, spec "Telemetry contract", task 4.1d; C-2). The catalog's
    redaction fixture keeps answering by the `resource.id` it receives (only its header
    comment changes, to say that it answers an entity operation's own check and
    `mayUpdateReferrer`'s by identifier (the fixed placeholder for a `_user` entity,
    Q119) and the redaction batch by position, while a blueprint operation's own
    `catalog_blueprint` check still reaches the real policies; N14-1), so the tests
    pass it the readable positions together with the identifiers of the single-resource
    checks that keep theirs (`team-a` in `entities-delete.int.test.ts`, the deleted entity's own
    check), and `blueprints-update.int.test.ts` derives its readable positions from the
    seeded rows read back in `id` order, the order in which the compatibility check
    streams them, because `seedEntity` gives each row a random id (Q130 annotated, the
    thirteenth amendment's Q130 bullet, proposal, task 4.1d; C-3, N13-1 and G13-1,
    N13-2).
  - Task 7.13 and the spec scenario "Creating a user cancels a pending invitation of the
    same email" assert that the `user_created` cancellation leaves an invitation of the
    same email that is already `cancelled` or `rejected` as it is and logs no
    `catalog.audit.invitation_cancelled` with the reason `user_created` for it (Q129;
    C-4). Task 8.2 no longer says that every failure is compensated: a lost consume race
    compensates nothing (8.1e, Q127; C-5).
  - TK12-1's lock does not close the `re_invite` variant of the G12-1 cancel race,
    because Better Auth makes that cancellation inside `createInvitation`, outside the
    lock (the thirteenth amendment, Risks, Tickets, Q128 annotated; C-6). The Q127 row,
    the thirteenth amendment's first bullet and the first pass of its consistency check
    name the third residual, the concurrent duplicate notice (C-7). The Observability
    contract names `002`'s `auth.security.login_failed`, whose already declared reason
    `account_disabled` the uniform banned sign-in logs (D13, task 13.4b; C-8). The record of Q128 says that no task gains a race case while tasks
    7.6, 7.7 and 8.10 cite the residual (the thirteenth amendment's Q128 bullet, the
    findings-to-coverage table, Q128 annotated, tasks header; C-9). The proposal states
    the service-account and credential caps as configurable defaults (Q56; C-10).
  - If `010` picks Cerbos as a child process inside the job container, the Cerbos binary
    stays pinned to the same image digest as the sidecar's, tracked by task 13.12's
    Dependabot, and the policy bundle is the `apps/api` revision's, shipped through the
    same SHA-pinned pipeline (`002` SEC13) (D9, Gates; V13-note). The pass counts name
    thirteen passes (proposal, Security considerations, tasks 1.1, 1.2 and 16.10).
  - A follow-up consistency check of this amendment made five more mechanical fixes: the
    tasks header cites task 7.13 under Q129 and task 7.13's skip case cites Q129 alone
    (its cancellation stays under Q110), because Q129 decided the `user_created` skip
    (a later fix removed it from Q123's task list: of the internal cancellations, Q123
    names only `user_disabled` and `inviter_disabled`); this
    Context and the findings-to-coverage table say that `@tayzu/auth`'s `exports` map
    has no entry for `context-resolver.ts` (only its index and, from task 9.1c, the `machine-credentials`
    subpath of Q78) instead of saying that it exports only its index; the THEN line of
    the spec scenario "Creating a user cancels a pending invitation of the same email"
    names the pending `t1` invitation; task 4.1d, the tasks header, the proposal's
    G13-1 line and the Q125 annotation say that Q130 rewrites the three tests while the
    fixture keeps its logic and has only its header comment corrected; and task 4.1d's
    Verify clause says that a blocked delete sends positional ids whatever the
    referrers' blueprint (completing C-2).
  - A drift-check of this amendment found two more items. N14-1 (mechanical, within
    Q130): the fixture's header comment must say that it answers an entity operation's
    own check and `mayUpdateReferrer`'s by identifier (the fixed placeholder for a
    `_user` entity, Q119) and the redaction batch by position, while a blueprint
    operation's own `catalog_blueprint` check still reaches the real policies; the
    second bullet above, the Q130 annotation, the proposal and task 4.1d say so. N14-2
    (Q131, answered with its recommended option): once the uniform banned sign-in logs
    `account_disabled` (C-8), task 15.2 drives a banned local sign-in and the `002` smoke check's assertion at
    `apps/api/src/otel-smoke-check.int.test.ts:1008-1012` becomes the exact set
    `{bad_credentials, mfa_failed, account_disabled}`, which is stricter; no contract
    name or value is added, `002`'s `contract.test.ts` stays untouched, and the PR calls
    the rewrite out (Observability contract, Q74 annotated, proposal, spec "Telemetry
    contract", tasks header, tasks 1.1, 1.2, 13.4b, 15.1 and 15.2).
- Reused, not redefined: `CatalogContext`/`Principal`/`onBehalfOf`
  (`001` design D3), the mandatory-declaration pattern of the catalog operation
  pipeline (`defineCatalogOperation` is not exported from `@tayzu/catalog`, so D10
  builds `defineIdentityOperation` on the same pattern), the `catalog.audit.*`/`catalog.security.*`
  naming convention and the shared `@tayzu/observability/semconv` attribute
  keys (`001` design, Observability contract; `001` R15).
- Per `docs/references/platform-engineering/README.md:58` (the row naming
  `002-auth-and-rbac`), this change is where "an audit trail for
  authentication" (`CDE` L92, L104-106) and "explicit rules for agent
  principals" (`SPE4` L226,234,442) extend concretely to invitations and
  service accounts — the row was written for `002`'s broader original scope
  before the `002`/`043` split; the parts of it about invitation/credential
  lifecycle land here.
- Per `docs/references/port/roadmap-analysis.md:40-59` (the `002-auth-and-rbac`
  row, written before the split), the capabilities this change actually
  implements are: "User/Team... service accounts, a 4-state invitation
  lifecycle... org API-credentials viewer." The rest of that row (Better Auth/Cerbos/RLS bootstrap,
  three-tier RBAC, `$team`/ownership) stays with `002`, and its "data retention/deletion
  policy and org deletion" moved to `045` (Q103).

## Goals / Non-Goals

**Goals:**

- Complete the Port-shaped user status model (`Staged`/`Invited`/`Active`/
  `Disabled`) as one canonical field on the `_user` entity, written only
  through one state machine by every writer (hooks, `identity.users.create`,
  the acceptance's own `_user` step, the reconcile, `identity.serviceAccounts.create`,
  `identity.users.setStatus`, the ban hook, the sign-in hook) — never reconstructed from raw invitation
  history at read time (human decisions Q4 and Q11).
- Authorize every sensitive operation this change adds (invite, status
  change, service-account creation and deletion, credential creation,
  rotation and revocation) through Cerbos, never through an
  `actor.type`/origin check, and bind every target to the caller's tenant on
  the server (D14).
- Make disable, rotate and revoke effective within seconds, not at token expiry
  (D13, Resolved decisions Q13 and Q25).
- Add exactly **one SQL migration**, a Checkpoint 3 item: `0011` (a composite
  `(tenant_id, credential_id)` key on the revocation list). `045` owns `0012` to `0014`; no migration is renumbered. The `_user`
  blueprint evolution itself stays a data-plane change.
- Ship SEC11-hardened invitation email as this change's first outbound-email
  capability, and the first public (unauthenticated) route, the invitation
  accept route, with strict limits.
- Keep the whole surface unreachable over HTTP until `002`'s hand-offs are
  done, enforced by a switch and a test (D15).

**Non-Goals:**

- No SSO/SCIM-provisioned lifecycle (`025`). No "view as a different user"
  (`003`/`014`). No org-wide audit-log **product surface**, its retention or
  export tooling (`015`, `010` own those; this change only emits events for
  them to eventually consume). No multi-org UX (`042`). No per-tenant Cerbos
  scopes (still deferred past `042`, per `project.md` §23 D7).
- No role-editing operation: nothing here changes a user's role or
  `moderatedBlueprints` (Resolved decision Q16). The member-management
  procedures `002` D18 anticipated (`updateMemberRole`, `removeMember`,
  `setActiveOrganization`) are **deferred** past this change; off-boarding in
  this change is the `Disabled` status (D13). Recorded as a ticket.
- No grace-period orchestration for credential rotation (old and new
  credential coexisting for a window) — v1 is an immediate cutover (ADR-0018).
  Org deletion and its purge, reversal and retention policy are not part
  of this change (`045`, Q103).
- No changes to `002`'s MFA, DB roles/RLS (beyond the composite key of migration `0011`), Cerbos engine wiring or three-tier RBAC baseline itself. This change
  does edit `002`'s Better Auth wiring and resolver where its decisions require it,
  and says so: `auth.ts` (the `organization` roles, the password configuration and
  hooks, the membership, ban, first-sign-in and account hooks, the uniform banned
  sign-in; D2, D4, D8, D13), the machine-token payload of `token-exchange.ts` (the
  `userId` claim, D6), the resolver checks of D13, the catalog pipeline's
  re-verification and the ownership items of tasks 13.6-13.6c, the migration and the policy files listed in D3,
  the `NODE_ENV=test` refusal and the runtime-role assertion of `bootstrap.ts` (Q98,
  Q109; tasks 13.8, 11.1c), the `_user` placeholder of the catalog spans, audit event
  and Cerbos requests (`entities.ts`, `pipeline.ts` and the catalog telemetry contract)
  and the positional ids of `packages/authz/src/redaction.ts` (Q107, Q113, Q119; task
  4.1d), the new rate-limit scopes and helper of `pre-auth-rate-limit.ts` (D4), the
  headerless `machine-credentials.ts` (D8) and the `toCerbosRole` export of
  `context-resolver.ts` and the package-index exports of `isIdle` (already exported by
  `session-idle.ts`) and `toCerbosRole` (D4 steps 4 and 2; tasks 8.5e, 8.5f); the
  complete file list is the proposal's Impact.

## Decisions

### D1. `_user` evolves: a four-value `status` and `accountKind`, per tenant

The `_user` system blueprint (owned by `002`) gains `accountKind`
(`"standard"` | `"service"`, default `"standard"`), and its `status` enum is
widened from `['Active','Disabled']` to the four values `Staged`, `Invited`,
`Active`, `Disabled` (`UserSyncInput.status` is replaced by a `StatusEvent`, D2).
Adding an optional property and widening an enum are the "compatible" cases
`001`'s safe-schema-evolution check (design D7) already proves out, and neither
needs an `ALTER TABLE`, because blueprint schemas live in a `schema jsonb`
column. `_user` is created per tenant and the system blueprint is create-only
and idempotent, so the change has two parts: `USER_BLUEPRINT` carries the new
schema for every **new** tenant (and the bootstrap constant), and a one-off,
idempotent `blueprints.update` run as the `system` actor, once **per existing
tenant**, brings existing tenants forward. Existing `_user` entities stay
valid. `blueprints.update` always bumps the blueprint's `version` and appends a
change event, so the script compares the tenant's `_user` schema with the builder's
output and skips a tenant that is already on the new schema: only that comparison
makes a second run a no-op (task 2.2). A second script, the **reconcile** (Resolved decision Q50), creates the
`_user` entity of every existing member that has none, through `created_active`,
and follows it with `admin_disable` when the member's Better Auth user is `banned`,
so a banned user is never revived as `Active` (Resolved decision Q62; the
resolver also rejects a banned user, so the instant between the two writes grants
nothing). Before it creates the `_user` of a member whose user holds **two or more
memberships**, it runs the shed of D4 step 7, with its session revocation and under the
per-user lock (Resolved decision Q105): the new row makes the member admissible (D13), and
an unmarked SSO link would otherwise reach the second tenant through it. It calls the shed
core directly on its `tayzu_auth` pool, so it builds no Better Auth instance and holds no
`BETTER_AUTH_SECRET` (Resolved decision Q114). It is repeatable (a second run changes nothing) and is also the repair
path for a member locked out by the rejection of D13 (`user_missing`), such as one
that predates this change. It also removes an **orphan** (Resolved decisions Q84 and Q89): a
human `_user` that is `Active`, has no membership in its tenant and was **last updated
more than a grace period of one hour ago** (measured from its `updatedAt`, the write that
activated it, `catalog_entity.updated_at`, not from its `createdAt`; Resolved decision
Q124, which amends Q84 and Q89), which a failed acceptance leaves
behind because the `_user` write is on another pool and no transaction spans the two
(D4); `Invited` and `Staged` rows and service accounts are never orphans. The grace
period keeps the reconcile from deleting the row of a member whose acceptance is
still in flight or about to be retried (the `_user` write and the membership are on two
pools with no transaction spanning them; since Q112 the acceptance writes the `_user` after
the membership and the shed, D4). It starts at the activation because on the new-account
path the row was created `Invited` by the invitation hook when the invitation was made
(D4 "Hooks"): measured from `createdAt`, a failed acceptance of an invitation older than
one hour would leave an `Active` row that the reconcile could delete while a retry is in
flight, and the member would then be rejected as `user_missing` until the next run. Without the
removal the orphan would block a later invitation of the same email, because `Active`
never moves back to `Invited` (D2). The removal deletes with `detachReferences`,
because a relation that targets the `_user` is a `RESTRICT` foreign key
(`catalog_entity_relation_target_fk`) that would otherwise fail it. Both scripts run as operator-started
jobs (D9), start telemetry and flush it before they exit (D9, Q79).
`USER_BLUEPRINT` and `bootstrapSystemBlueprints` are module-private today and absent
from the package index, and `blueprints.update` takes a full `CreateBlueprintInput`,
so `@tayzu/catalog` exports the constant and a builder for that input, and the
backfill updates each tenant with it (task 2.1).

A blueprint `default` is applied **on write only** (`entity-validator.ts`,
`001` spec), and `USER_BLUEPRINT` declares none today, so an existing `_user`
row does **not** read back `accountKind: "standard"` unless it is rewritten,
and the one-off update does not rewrite rows. Every reader, and the Cerbos
rule of D3, therefore treat an **absent** `accountKind` as `standard`. The
default `Staged` for `status` applies to an entity written without a status.

- _Alternative:_ a new `catalog_service_account` table. Rejected: it
  duplicates the `_user` blueprint's own attribution, status and RBAC
  plumbing for no benefit, and reintroduces exactly the "second way to model
  the same resource" problem `001`'s "Workflows are themselves entities"
  precedent (`project.md` §3) already argues against.

### D2. User status is a pure state machine; every writer goes through it

`packages/auth/src/identity/user-status.ts` exports a pure function
`nextStatus(current: UserStatus | null, event: StatusEvent): UserStatus`
that throws a package-local `StatusTransitionError` (carrying
`code = 'CATALOG_VALIDATION_FAILED'`, like `AuthContextError`; `@tayzu/auth`
does not depend on `@tayzu/catalog`) for a disallowed pair. `current` is
`null` for an entity that does not exist yet.

`StatusEvent` is `created_staged | created_invited | created_active |
invitation_accepted | first_sign_in | admin_disable | admin_enable`. The
allowed transitions are the whole table; every other `(status, event)` pair
is rejected:

| Event                 | From                          | To         |
| --------------------- | ----------------------------- | ---------- |
| `created_staged`      | none                          | `Staged`   |
| `created_invited`     | none, `Staged`, `Invited`     | `Invited`  |
| `created_active`      | none                          | `Active`   |
| `invitation_accepted` | `Invited`, `Staged`           | `Active`   |
| `first_sign_in`       | `Staged`, `Invited`           | `Active`   |
| `admin_disable`       | `Staged`, `Invited`, `Active` | `Disabled` |
| `admin_enable`        | `Disabled`                    | `Active`   |

So a `Disabled` user is never revived by a sign-in, by accepting a pending
invitation, or by a hook (multi-stage misuse found by the VCDM pre-assessment,
B4), and `Active` never goes back to `Invited` or `Staged`.

The status writers that exist in `002` bypass any such rule today:
`afterAddMember` writes `Active` (`packages/auth/src/auth.ts`), the ban hook
writes `Active`/`Disabled`, `identity.users.create` writes `Active` directly,
and so does the bootstrap script (`bootstrap-admin.ts`), all through
`UserSyncPort`, whose `UserSyncInput.status` is `'Active' | 'Disabled'`. Per
Resolved decision Q11 all of them, and the new sign-in hook for
`first_sign_in`, go through `nextStatus` via an event. The membership hook is the
**single writer** for a membership, and the `_user` is written **only** by the hook
(Resolved decision Q76, approved by the human, which reverses `002` task 18.5's
direct writes): `identity.users.create` and the bootstrap do not also upsert the
`_user` (today `create` writes twice, through the hook and through an explicit
upsert, and the second write would throw, because `created_active` is allowed only
from none), and every test that wrote through the catalog's `createUserSync` directly is
rewritten to build `auth` with `userSync`: the two direct-write cases of
`apps/api/src/user-sync.int.test.ts`, its first `describe` (which passes
`createUserSync` to `createAuth` and to `bootstrapAdmin`) and
`sso-jit-refresh.int.test.ts` (which passes it too). The `userSync` option of
`createIdentityRouter` and of `BootstrapAdminOptions` is removed, since nothing
writes through it. The acceptance and the reconcile (D1) are the exceptions. Inside the
acceptance's shared context (below, D4 step 7; Resolved decision Q112) the hook makes
**no** `_user` write for the acceptance's own member (Q120, below), and the acceptance's
own `_user` step writes it through the same
adapter and intent, after the shed of D4 step 7, so a new membership stays inert (D13,
Q105 part 3) until the shed is done; the reconcile (Q50) writes the `_user` of a member
that has none through the same adapter and intent, `created_active` followed by
`admin_disable` for a banned user (Q62), after the shed of D4 step 7 for a user of two
or more tenants. On every other membership path the hook runs the shed **before** its
`_user` write.
`UserSyncPort` has only `upsertUser`, so the hook cannot read the
current status and cannot derive the event itself: it passes an **intent**,
`membership_added` (with whether the member's user is `banned`), and the adapter of
Q30 reads the status and derives the event: none gives `created_active` (an
admin-created user, and the bootstrap admin), `Invited` or `Staged` gives
`invitation_accepted`, `Active` is no write, and `Disabled` is no write (a hook never
revives a user), and a banned member with no row gets `created_active` followed by
`admin_disable`. The ban hook writes only `admin_disable` (Resolved decision Q102, below). `UserSyncInput`
therefore carries a `change` (a `StatusEvent` or that intent), not a status, and
gains an optional `onBehalfOf`, because the sync's own actor is fixed today and
Resolved decision Q10 attributes an admin-initiated `_user` write to the admin. The
port's input also gains **`userId`**, the opaque id of the write's subject (a
consistency fix within Resolved decisions Q117 and Q120, no new decision): today it
carries no Better Auth user id (`auth.ts`), so the adapter could neither compare a hook
call with the acceptance's `(tenantId, userId)` (Q120, below) nor name the subject of a
hook write as `tayzu.identity.user.id` (Q117, below). It is the Better Auth user id of a
human, which the membership hook takes from `afterAddMember({ member, user })`'s `user`,
the ban hook from the row it receives (`SyncUserRow.id`), the first-sign-in hook from
the user who signed in and `refreshDisplayData` (`auth.ts:419-462`, the caller of the
port in `auth.ts` beside the hooks, its call at `:455`) from its `account.userId`
(`:434`, `:446`, `:452`), while the `apps/api` writers pass the id they already hold (the
target of `setStatus`, the member of the reconcile, the invitee of the acceptance); it
is the `svc-…` identifier of a service account (Q90); and it is absent only for the
invitation hook's `created_invited` write, whose subject is the invitation (Resolved
decision Q126). For that write the input carries instead an optional **`invitationId`**,
the `invitation.id` that `afterCreateInvitation` receives, which the adapter emits as
`tayzu.identity.invitation.id` (a consistency fix within Q126, no new decision: without
it the adapter would hold no invitation id to name). The
hook receives only `{ member, user, organization }` (`afterAddMember`), so the
identity operation hands the acting admin to it through an `AsyncLocalStorage`
(`node:async_hooks`, no dependency; one store in
`apps/api/src/identity/identity-context.ts`, which also carries the acceptance's shared
context of D4 step 7, and the principal of the bootstrap, Resolved decision Q116) that it
runs around its in-process `auth.api` call, and the adapter reads it. The hook itself lives in `packages/auth/src/auth.ts` and cannot import `apps/api`,
so it never reads the store: the `apps/api` implementations of its ports (the
`UserSyncPort` adapter here and the shed port of D4 step 7, whose implementation is the
shed core that works on the `tayzu_auth` pool alone and needs no Better Auth instance,
Resolved decision Q114) do. The acceptance's shared context carries the acceptance's
`(tenantId, userId)` (Resolved decision Q120), and both port entry points return without
writing (Q112) **only for that member**: a hook call for another membership that runs
inside the context (another user, or another tenant) writes its `_user` and sheds as on
any other membership path. The acceptance's own steps call the same implementations
directly, and the adapter's entry point that the acceptance's `_user` step calls
**returns the status event it wrote, or none** when it wrote nothing: `invitation_accepted`
or `created_active` means that this attempt's `_user` step activated the row, which is
what the existing-account admin notice turns on (D4 step 6, Resolved decision Q122). The
hook-facing `UserSyncPort.upsertUser` stays `Promise<void>`
(`packages/auth/src/auth.ts:505-515`), because no hook needs the result (a consistency
fix within Q122, no new decision). Nor can a Better Auth hook tell from its own `context`
argument which operation started it: the hook context is ambient
(`tryGetCurrentAuthEndpointContext()` in Better Auth's `with-hooks.mjs`), every endpoint
handler runs inside one (`runWithEndpointContext`), the server-only `addMember` included,
so `afterAddMember` and every hook that a write inside it fires see the context of
`addMember`, while a direct internal-adapter call outside any endpoint (the admin unlink,
the acceptance's own steps) sees none. D4 step 7 states what the account hooks do with
that. Admin-created users start `Active`; `Staged` is the default only for an entity
created without a status.

The adapter's read-derive-write is not atomic, so a concurrent ban, first sign-in and
add-member could revive a `Disabled` user: the adapter writes with the
`expectedVersion` of the row it read and, on a conflict, re-reads and retries a
bounded number of times (3) before failing closed (Q83). `UserSyncInput` has no
`expectedVersion` and `createUserSync` has no read path today, so both are added (the
sync passes the version to `entities.upsert` for an existing row, and the adapter
reads through the catalog's `entities.get`). For a row that does not exist yet the
write is `entities.create`, not an upsert with a version: a create race answers
`CATALOG_ALREADY_EXISTS`, not a version conflict, and the adapter counts both as a
conflict to re-read and retry.

**Every status change is audited** (Resolved decision Q117). Every status writer goes
through this adapter, so the adapter emits `catalog.audit.user_status_changed` after each
write that changes a status, a row created with its first status included, and emits
nothing for a write that leaves the status as it was (a redundant event, below, or a
re-invitation of an `Invited` user) or for a write that fails. The event carries the
status before (absent for a new row) and after, the bounded status event that the adapter
derived (`tayzu.identity.user.status.event`: one of the seven `StatusEvent` values, so a
`first_sign_in` self-activation is told apart from an `admin_enable`), and the principal
that the write already has, which the writer hands to the adapter with its kind: the
**admin** of an operation an admin initiates (`setStatus`, `invite`, `users.create`,
`serviceAccounts.create`), as `tayzu.actor.id`; the **operator** of the reconcile and of
the bootstrap, as `tayzu.identity.operator.id` in its place (Q116, D9); the **user** of
a first sign-in, their own Better Auth user id as `tayzu.actor.id`, which the
first-sign-in hook also passes as the `onBehalfOf` of its write (actor type `user`); the
**invitee** of an acceptance, as `tayzu.actor.id` (Q116); and **no actor** for the ban
hook, which mirrors a ban made elsewhere and has no principal of its own. The
`created_invited` write of the invitation hook identifies its subject by
`tayzu.identity.invitation.id`, taken from the input's `invitationId`, because the hook
knows the invitation and not a Better Auth user, and an invited email may have none yet
(the email is never logged; Resolved decision Q126).

There are **two** sync types and both change: `UserSyncPort` and its input in
`packages/auth/src/auth.ts` (the status becomes a `StatusEvent`), and
`UserSyncInput` in `packages/catalog/src/service/user-sync.ts` (today a two-value
`status`, a fixed actor and no `onBehalfOf`: it gains the four-value status of D1 and
the optional `onBehalfOf`). `refreshDisplayData` (`auth.ts`) upserts display fields
without a status and, with the new default `Staged`, would create a `Staged` row for
a member who has none, which the resolver rejects (D13, Q105) and which the reconcile,
which only creates missing rows, would never repair; so it updates display data only
for a row that exists and never creates one.

`createUserSync` lives in `@tayzu/catalog`, which cannot import `@tayzu/auth`
(where `nextStatus` is), and today nothing in `apps/api` builds it:
`createApp` passes no `userSync` to `createAuth`, so the hooks above are no-ops
in the running app, and the bootstrap script's `main()` calls
`bootstrapAdmin(auth, params)` without one, so no `_user` is written (`002` left
this as a follow-up). The Q30 adapter in `apps/api` therefore implements
`UserSyncPort`: it reads the current status, calls `nextStatus` and writes the
result through `createUserSync`. `createApp` and the bootstrap CLI both build it
and pass it in. `@tayzu/auth` depends only on `@tayzu/db` and
`@tayzu/observability`, so it cannot import the adapter: the CLI (`main()` and the
`bootstrap:admin` package script) therefore moves to
`apps/api/scripts/bootstrap-admin.ts` (Resolved decision Q51). Today
`bootstrapAdmin()` and `main()` share one file, `packages/auth/scripts/bootstrap-admin.ts`,
which `scripts/ci/zap-seed.ts` and two integration tests import, so the file is
split: `bootstrapAdmin()` moves to `packages/auth/src/bootstrap-admin.ts` and the
package index, and the CLI builds Better Auth the way `createApp` does (the
`tayzu_auth` pool, the `tayzu_app` pool and Cerbos), because the adapter needs
all of them. The bootstrap admin's `_user` is written by the membership hook, the
single writer (`createOrganization` fires `afterAddMember` for the owner whenever
`userSync` is passed to `createAuth`), so `bootstrapAdmin()` does **not** write it a
second time; it emits `catalog.audit.user_created` with source `bootstrap`. No admin
acts there; the operator who runs the CLI does (Resolved decision Q116). The CLI requires
the operator's opaque id from its environment, validated against the catalog's id pattern
as the reconcile's is and refused when absent (D9), and runs `bootstrapAdmin()` with it in
the store above, so the hook's `_user` write carries it as `onBehalfOf` (actor type
`user`), and `bootstrapAdmin()`, which takes it as an option, records it on
`user_created` as `tayzu.identity.operator.id` in place of `tayzu.actor.id` (Observability
contract).

The ban hook (`auth.ts`, `databaseHooks.user.update.after`) fires on **every**
`user.update` that carries a boolean `banned` and runs with an endpoint context, for
example `/two-factor/verify-totp`, which is allowlisted. It receives the new row, with
its `id`, but not the old row, so it cannot tell an unban from any other update. Per
Resolved decision Q102 it therefore writes **only `admin_disable`, and only when
`banned === true`**, to the `_user` of every membership of the user, and the adapter
treats that **redundant event as a no-op** for a user who is already `Disabled`: it
reads the current status first and writes nothing when the status already is the
event's target, while every other disallowed pair still throws (task 4.5). It **never
writes `admin_enable`**: an update with `banned: false` writes nothing. An
`admin_enable` sent for every membership would re-enable a user whom `setStatus`
disabled in one tenant only, as soon as that user enrolled a second factor from
another tenant where they are still a member (the hook cannot see that `banned` did
not change). Re-enabling goes through `setStatus` only (D13). The hook is skipped
without an endpoint context, which is the case for the internal-adapter call of D13,
so it stays as the safety net for any other path that sets `banned`.

The first-sign-in hook (`auth.ts`, task 4.4) writes `first_sign_in` through the same
adapter **only for a user who holds exactly one membership**, to that membership's
`_user` (Resolved decision Q111). For a user of two or more tenants it writes nothing. In
the normal flows a second tenant's `_user` is activated by the acceptance's own `_user`
step after the shed (D4 step 4, Q112) or by the membership hook after its shed, so an
`Invited` or `Staged` row beside another membership is what a failed acceptance whose
compensation also failed leaves (D4 step 4). Activating it on a sign-in would admit the
member to that tenant without the shed that Q105 requires, so the row stays rejected by the
resolver (D13, Q105 part 3). It is repaired by a retry of the same invitation within its
48 hours (the acceptance sheds on every attempt) or by the operator repair of Q100; a new
invitation (Better Auth refuses to invite a current member), the membership hook (it does
not fire for an existing membership) and the reconcile (it leaves an existing row
untouched, D1) do not reactivate an existing membership.

- _Alternative:_ let each call site independently decide the next status.
  Rejected: this is exactly how Port's own docs ended up needing a whole
  "forward-only" paragraph to describe emergent behavior — Tayzu encodes the
  invariant once.

### D3. Cerbos, not origin, gates every operation here — ADR-0020

Port's docs state "only users with a UI/API origin can invite users and
change their status" (`r1-port.md` §1.5) — i.e., they gate on _how_ the
request arrived, not _who_ is making it. Tayzu already committed to the
opposite principle (`project.md` §1: `actor.type` is data and never selects a
code path). This change adds these Cerbos-checked actions, all gated to the
`admin` role (`045` adds the `organization` kind with the action `delete`):

| Resource kind     | Actions                                                  |
| ----------------- | -------------------------------------------------------- |
| `user` (existing) | `invite` (also covers cancel and resend), `updateStatus` |
| `service_account` | `create`, `delete`                                       |
| `credential`      | `list`, `create`, `rotate`, `revoke`                     |


Policy-file mechanics, as `002` actually has them:

- `RESOURCE_KINDS` in `packages/authz/src/resource-kinds.ts` gains
  `service_account` and `credential`.
- `policies/role_policies/admin.yaml` lists kinds one by one (no wildcard) and
  is a ceiling, so it gains the two kinds, and
  `role_policies_test.yaml` (and `member.yaml` if a ceiling must be stated)
  is edited with it. Without that edit the admin is denied fail-closed and
  the feature is dead on arrival.
- `policies/resource_policies/user.yaml` already allows `*` to admin, so
  `invite` and `updateStatus` need no new allow. The new content on `user` is
  **only two `EFFECT_DENY` rules**: a self-deny (`updateStatus` when
  `R.id == P.id`, using `002`'s `R`/`P` shorthand), and the service-account
  ceiling below. Deny rules, not allow-narrowing, because an allow cannot
  override `*`.
- **`R.id` is the Better Auth user id for a human** (the `svc-…` identifier for a
  service account, Resolved decision Q90: it is not an email, not PII, and already the
  resolver's key), never the email: the `{user}` path carries
  an email, and a self-deny compared with an email would be vacuous against
  `P.id`. The resolved target supplies the id. The same rule keeps emails out
  of Cerbos's decision logs (`decisionLogsEnabled: true`) for the identity router: it
  sends only opaque ids as a resource id. The catalog's own checks did not (the claim
  that only opaque ids are ever sent is corrected by Resolved decision Q119): the
  `catalog_entity` checks of `entities.ts`, through the pipeline's Cerbos call
  (`pipeline.ts`), sent the entity identifier, which for a `_user` entity is the member's
  email, and the referrer redaction (`redactUnreadable`) sent the referrers' identifiers.
  Since Q119 the catalog sends the fixed placeholder of Q107 as the `resource.id` of a
  `_user` entity (no `catalog_entity` policy reads `R.id`), including the per-referrer
  `update` check of a delete (`mayUpdateReferrer` in `entities.ts`, `002` Q65), which
  calls Cerbos directly, outside the pipeline, with the referrer's raw identifier and so
  sends the placeholder when the referrer's blueprint is `_user` (a mechanical fix
  within Q119, no new decision), and `redactUnreadable` sends
  each candidate's position as its resource id and maps the decisions back in process, so
  no email reaches the decision log (task 4.1d). The resource id of each identity
  operation is fixed: the literal
  `new` for `invite`, `users.create`, `serviceAccounts.create` and
  `credentials.create` (no resource exists yet; `create` sends `new` today), the
  invitation id for cancel and resend, the Better Auth user id (or the `svc-…`
  identifier of a service account) for `setStatus`, `serviceAccounts.delete` and the
  SSO link and unlink, the `apikey` id for rotate and revoke, and the literal `list` for
  `credentials.list` (it has no target).
- Each **new** resource policy (`service_account.yaml`, `credential.yaml`)
  carries the explicit cross-tenant `EFFECT_DENY` that
  `002` D8 requires in every resource policy (as `user.yaml` has), in addition
  to importing `002` D7's `same_tenant` derived role. `same_tenant` alone is
  vacuous for catalog operations (`002`'s Known residual risks): it protects
  only if the caller passes the **target's real tenant** as the resource
  tenant. The identity router therefore resolves the target on the server
  (D14) and passes its real tenant (an invitation's `organizationId`, an API
  key's `referenceId`, the user's membership), together with `accountKind`,
  `portRole` and `moderatedBlueprints` as resource attributes. This is the
  attribute contract. `002`'s `assertMayOnUser` accepts only
  `'create' | 'update'` and sends no attributes (`apps/api/src/identity-router.ts`)
  and is called by hand in each handler, so this change replaces it with the
  mandatory wrapper of D10 (Resolved decision Q45), which carries the new actions
  and the attributes.
- **Service-account ceiling** (Resolved decisions Q7, Q16): a rule on `user`
  denies any action when `R.attr.accountKind == "service"` and
  (`R.attr.portRole != "member"` or `R.attr.moderatedBlueprints` is
  non-empty), where the attributes are the **resulting** values. `002` D7's
  `strictEvaluation: true` turns a CEL error into a deny of the whole action,
  and today's callers send attributes with none of these keys, so every
  attribute reference is guarded with `has()` (the precedent in
  `catalog_entity.yaml`); an absent `accountKind` is `standard` (D1) and the
  rule does not fire. The rule is a defensive layer independent of the input
  validation in `identity.serviceAccounts.create` (D6): no operation in this
  change edits a role or `moderatedBlueprints`, so the rule is proven at the
  policy level (`user_test.yaml`) and by a `system`-actor test, not by a new
  operation.
- **Service-account target type** (Resolved decision Q62): `service_account.yaml`
  carries an `EFFECT_DENY` for every action unless `R.attr.accountKind ==
  "service"`, guarded by `has()` (an absent `accountKind` is `standard`, so it
  denies). The attribute is the resolved target's `accountKind` (for `create` it is
  the `service` of the account being created); the first, target-less role check of
  the wrapper (D10) carries `accountKind: service` for this kind, so that it evaluates
  the caller's role and not a target type that does not exist yet. So a route of this
  kind can never act
  on a human `_user`, even if its server-side resolution (D14) were bypassed. It is
  proven at the policy level (`service_account_test.yaml`) and by the route test
  of D14.
- **Test files and fixtures.** The policy tests live in
  `policies/resource_policies/` beside `user_test.yaml` and `role_policies_test.yaml`,
  and the two new kinds need resource entries (and any principal entries they
  lack) in the shared `testdata/` files, which this change adds. The existing
  `same_tenant_test.yaml` is the "denied on every kind" suite (four kinds today), so
  each new kind's policy task extends it with its own kind, in addition to its own
  test file. A role-policy allow does nothing without a resource-policy allow, so the
  admin-allowed assertions of a kind are made when its resource policy exists, not
  with the ceilings.

- _Alternative:_ keep Port's origin-based rule as a secondary check on top of
  Cerbos. Rejected: it would be the actor/origin-as-code-path pattern
  `project.md` explicitly forbids, for no security benefit Cerbos's
  role-based deny doesn't already give.

### D4. Invitation lifecycle, public acceptance, roles and caps

Better Auth's `organization` plugin provides the invitation record
(`pending`/`accepted`/`rejected`/`canceled`, 48h `invitationExpiresIn`). It is
the state of the _invitation_, distinct from the state of the _user_. At the
boundary Tayzu maps `canceled` to `cancelled` and **derives** `expired` from
`expiresAt` (Better Auth never stores it; the schema default is `pending`).
Better Auth stores `accepted` only from its own accept route, which stays off (below),
so the acceptance writes that status itself, together with the consumption of the token
(step 1, Resolved decision Q123); without it an accepted invitation would stay `pending`
until it expired. `cancelPendingInvitationsOnReInvite: true` makes re-inviting a single call. The
plugin's default `invitationLimit` of 100 pending invitations per organization
is kept and stated here (an accepted invitation no longer counts toward it, Q123), and so is its default `membershipLimit` of 100 members per
organization: `addMember` answers FORBIDDEN past it, `identity.users.create` maps that
to `CATALOG_VALIDATION_FAILED` and the acceptance answers the uniform rejection with
the denial reason `member_limit`. Better Auth's own errors
(`USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION`, and the limit, which answers
FORBIDDEN `INVITATION_LIMIT_REACHED`) never reach the response as they are: they
map to `CATALOG_VALIDATION_FAILED` with no provider text, so the response does
not leak membership.

**Reaching Better Auth (Resolved decision Q42).** `/organization/invite-member`
requires a real session (`requireHeaders` and `orgSessionMiddleware`) and, unlike
`createApiKey`, has no `body.userId` bypass. The router context carries no
headers today (the server hands them over only as `__stepUpHeaders`), so the
server also puts the request's headers in the context, and `identity.users.invite`
forwards the admin's session headers into `auth.api.createInvitation`. The
re-invite cancel, the 100-invitation limit and `afterCreateInvitation` stay Better
Auth's, and tests mint a real session. Better Auth re-checks the session member's
role (`invitation:create`), which the access-control roles of D8 grant `admin`.
The other session-bound invitation call, cancel, uses the same forwarded headers.

**Roles (Resolved decisions Q9, Q19).** `identity.users.invite` accepts only the
organization roles `member` or `admin`, never `owner` (Better Auth's
`inviteMember` accepts any role and `afterAddMember` maps owner/admin to the
Cerbos `admin` role, so an unconstrained role is a privilege escalation).
Anything else is `CATALOG_VALIDATION_FAILED`. The role is parsed as exactly one of
those two strings: `inviteMember` accepts comma-separated strings and arrays and
the Cerbos role mapper splits them, so `member,owner`, `['owner']`, `Admin` and
`owner` are all rejected. The role is an attribute of
`catalog.audit.invitation_created`. `invite` is `x-tayzu-risk: high` for every
role (Q19), so every invitation requires a fresh step-up (D10).

**Email form (Resolved decision Q33).** One canonical form of the address (NFC,
trimmed, lower-cased) is the `_user` identifier, the Better Auth user email,
the invitation email and, hashed, the per-recipient cap key. The entity
identifier pattern (`ENTITY_IDENTIFIER_PATTERN`, `001`) cannot hold every valid
email, and an address with `/` cannot be a `{user}` path segment (D10). `invite`
and `identity.users.create` therefore reject, with
`CATALOG_VALIDATION_FAILED`, any address the pattern cannot hold or that
contains `/`, and the limitation is documented (no `001` change). This also
excludes `+` aliases, so the per-recipient cap below cannot be bypassed with
plus-addressing. The canonical-email function lives in
`apps/api/src/identity/email-canonical.ts`: `@tayzu/auth` has no use for it and
cannot import `@tayzu/catalog`, whose `ENTITY_IDENTIFIER_PATTERN` is a private
constant today, in two copies (`limits.ts` and `identifiers.ts`), so the catalog
exports it unchanged from one source, `identifiers.ts`, which `limits.ts` imports (an
additive export, no behavior change; Q60, task 7.9b).

**Hooks.** `afterCreateInvitation` → `_user.status = Invited` through
`created_invited` (creating the `_user` entity first if the email has none yet;
an existing `Disabled` user cannot be invited), through the Q30 adapter as `system`
with `onBehalfOf` the admin, which `identity.users.invite` hands over through the
`AsyncLocalStorage` of D2 that it runs around `createInvitation`, and with the
invitation's id, which the hook receives, as the port input's `invitationId` (D2,
Q126); the operation makes no `_user` write of its own (Q76). `afterAcceptInvitation` is
**not** used for status: acceptance is the in-process flow below, and it
writes through `invitation_accepted`. Rejecting or cancelling an invitation
does not touch `_user.status`.

**Acceptance (Resolved decisions Q8, Q18, Q24).** Sign-up is disabled (`002`
Q16), no email-verification flow exists, `resolveContext` rejects any session
without an active organization the user is a member of, and Better Auth's
native `/organization/accept-invitation` is off `002`'s D18 allowlist and stays
off. An invitee therefore cannot use any `/v1/*` route, so acceptance is a
dedicated **public, rate-limited route outside the tenant-context pipeline**,
`POST /v1/auth/invitations/accept`. It is a **plain Fastify route**, registered
before the `/v1/*` catch-all exactly like `002`'s token-exchange route
(`app.post(TOKEN_EXCHANGE_PATH)`): the catch-all runs `resolveContext` first and
answers 401 to any unauthenticated call, so an oRPC procedure could never be
public. It is therefore absent from the OpenAPI document and from the
`contract:check` input, is covered by a route-table test (D15) and
`attack-surfaces.md` instead, and its HTTP tests use the real server, not
`createRouterClient`; the service function behind it (in `apps/api`, Q30) is
tested in process. Its body carries the invitation id, the token and, for a
new account, the password; **nothing identifying travels in the path or
query**. The body is an allowlist of exactly those fields: any other field
(`role`, `email`, `organizationId`, `userId`, `tenantId`, `actor`) rejects the
request with `CATALOG_VALIDATION_FAILED`, a shape check that reveals nothing about
any invitation. The invitation id is checked for shape and length before any
lookup or logging; one that fails the check is logged as the constant `invalid`, never
as the value, because this route is public and the value is attacker-controlled: it is
the `tayzu.identity.invitation.id` of the `identity.invitation.accept` span and of
`catalog.security.invitation_acceptance_denied`, whose denial reason for a rejected body
or id shape is `malformed_request` (Observability contract).

1. _Token._ Issued at invite/resend: 256 bits from a CSPRNG, shown only in the
   email link. Only `sha256(token)` is stored, in the `auth.verification`
   table `002` already reuses for `jti` replay state (identifier
   `invitation-accept:<invitationId>`, `expiresAt` equal to the invitation's),
   so there is no new table. It is compared in constant time
   (`timingSafeEqual` over equal-length digests). The order is: verify the token
   **without consuming it**, check that the inviter still holds authority (step 2),
   check the password policy (new-account path), do the work of the path (steps 3 and
   4), and only **last** consume the token with one atomic delete **conditioned on
   the digest**, so a bad password with a valid token does not consume it, a failure
   before the last step does not burn it, and exactly one of two concurrent attempts
   succeeds. The same short `tayzu_auth` transaction as that delete **sets the
   invitation's status to `accepted`** (Resolved decision Q123), through a tenant-keyed
   write of the `auth` repository (D14) that is conditioned on the status still being
   `pending`; when the delete or the write changes no row (another attempt consumed the
   token, a concurrent resend replaced the digest, or a concurrent cancellation left the
   invitation no longer `pending`), the transaction changes
   nothing and the attempt takes the lost-race path (step 4), so the token is
   still consumed last (Q89) and an invitation is `accepted` exactly when its token is
   consumed; the transaction covers those two statements only. There is **no
   transaction around the acceptance** (Resolved decision
   Q89, which supersedes Q75's `transaction: true`): a Better Auth transaction would
   need `transaction: true` in `drizzleAdapter(...)` (`auth.ts` sets none) **and**
   `runWithTransaction` from `@better-auth/core`, which `better-auth` does not
   re-export and `@tayzu/auth` does not depend on, and `addMember` and
   `createOrganization` are not transactional anyway. So every step is
   **idempotent**, the token is consumed last, and what is left half-done is
   repaired: by a compensation for what this attempt itself created (steps 3 and 4) and, for
   an orphan `_user`, by the reconcile (D1). Resend issues a **new** token (the old one stops working)
   with the **same** expiry: the plaintext is not stored, so the same link
   cannot be re-sent.
2. _Tenant._ Derived on the server from the invitation record's
   `organizationId`. The body has no tenant field and a body that carries
   one is rejected. The route never reads `tenantId` or `actor` from input. `045`
   adds the rejection of an invitation of a tenant pending deletion to the rejections
   of step 5. **The inviter's authority is re-checked at acceptance**
   (Resolved decision Q63): an invitation outlives its inviter's authority
   otherwise, which is the usual incident sequence (a hijacked admin invites an
   accomplice, the organization disables the admin, and the 48-hour invitation
   stays valid). On both paths, after the token has verified and before it is
   consumed, the invitation's inviter must still be a member of the invitation's
   organization, whose Better Auth user is not `banned` and whose `_user` status in the
   tenant is `Active`, and **Cerbos must still allow the inviter to invite** (Resolved
   decision Q108, which keeps `002` D2's single decision point: the admin role is not
   mapped locally from the membership role): the acceptance builds the inviter's
   principal from the member row (the inviter's Better Auth user id, the roles the
   resolver derives from that membership role, through the same mapping,
   `toCerbosRole` of `context-resolver.ts`, exported for it from that module and the
   `@tayzu/auth` package index (task 8.5f), and the invitation's tenant) and asks Cerbos
   for the action `invite` on a `user` resource
   whose id is `new` and whose tenant is the invitation's `organizationId` (D3). A
   missing membership, a banned or non-`Active` inviter, a Cerbos deny and a Cerbos
   error each fail the acceptance with the uniform rejection below and the denial
   reason `inviter_not_active_admin`, and the token is not consumed. The check runs after the token, so it reveals nothing to a caller who
   does not hold a valid token, and it is the authoritative control: it does not
   depend on the cancellation at disable time (D13), which only makes the
   revocation visible and hygienic. The membership and `banned` reads go through the
   repository of D14 (`tayzu_auth`) and the `_user` status is read from `tayzu_app`,
   another pool, with no transaction around the acceptance (Q89): an inviter disabled
   between this check and the consumption of the token (the last step) can still be
   accepted, a race of a few seconds at most that is accepted (Risks).
3. _New account._ For an invited email with no Better Auth user, the flow
   creates the user (global role `user`, never an admin role), sets the password
   the invitee supplied under the password policy (Q22, Q23), marks the
   email verified (the token is proof of mailbox control, so no
   email-verification flow is needed), adds the membership with the invited
   role, writes `_user.status` through `invitation_accepted`, and **creates no
   session**; the invitee then signs in through the normal route, and MFA
   enrollment follows `002` Q43 (an invited `admin` is therefore blocked by the
   admin MFA gate on every `/v1` call until they enrol). The acceptance **never
   links** an account by the email claim from Visma Connect (`002` D24, `002` Q18):
   linking stays `sub`-keyed through `/link-social`, with step-up. An invitee who
   will only ever use Visma Connect is unsupported until `025` (`002` Q72): they
   need a local password first (Risks). The `_user` write is the acceptance's own
   `_user` step, made after `addMember` through the adapter of D2 with the
   `membership_added` intent on the `tayzu_app` pool: the acceptance sets its shared
   context of step 7 on both paths, inside which `afterAddMember` makes no `_user` write
   for the acceptance's own member (Q120) (Resolved decision Q112). It **fails closed**: if it throws, the attempt fails, the
   token is not consumed and the compensation below runs, so an acceptance never leaves a
   member with no `_user`, and an `Active` row is no write, so a retry's step is a no-op.
   No admin acts on this public route, so Q10's attribution to an admin does not apply;
   the invitee acts (Resolved decision Q116): on both paths this step's `system` write
   carries the invitee's Better Auth user id as `onBehalfOf` (actor type `user`), and
   `catalog.audit.invitation_accepted` names the same id as `tayzu.actor.id`, with
   `tayzu.actor.type` `user` (Observability contract), as does the
   `catalog.audit.user_status_changed` of the step's write (D2, Q117).
   The attempt **compensates what it created**: if any step after the user
   was created fails before the token is consumed (other than a lost consume race, a
   consumption whose token delete or `accepted` write changes no row, step 1, which
   compensates nothing, step 4), it deletes, in reverse order and
   each idempotently, the membership, the `_user` and the user that **it** created
   (never one it found), and logs `catalog.security.invitation_accept_compensation_failed`
   if a deletion fails. A retry with the same token therefore starts again from the
   `_user` row the invitation hook created, which the compensation does not delete
   because the attempt found it: after a failure past the `_user` step it stays `Active`
   with no membership, the retry's `_user` step is a no-op, and with no retry the
   reconcile removes it one hour after its activation (D1, Q124); without the
   compensation a retry would meet an existing account and, with no session, the
   uniform rejection, and the invitee would be stuck. A compensation that
   itself fails leaves a user with no membership; a stranded user is an operator repair
   (Q100).
4. _Existing account (Q18, Q24)._ For an email that already has an account,
   acceptance **never sets or changes the password** (an account takeover
   vector). It succeeds only when **all** of these hold, checked in this order:
   (a) the request carries a valid session cookie, read with Better Auth's
   `getSession` on the request headers with `disableRefresh: true`, as the resolver
   reads it (a plain `getSession` can refresh the session's `updatedAt` and so extend
   a session that is about to idle out; this is the only public route that reads a
   session; the step-up guard of (e) reads it again with a plain `getSession`,
   `step-up.ts`, but only for an `admin` invitation and only after (a)-(d) passed), and that session passes the idle-timeout check of `resolveContext`
   (`isIdle`, which `session-idle.ts` exports and the package index does not, so the
   index exports it for the route), a banned check that the route makes itself by
   reading `user.banned` (the resolver's own banned check arrives with D13, after the
   acceptance) and the temporary-password marker check of D13 (this route bypasses
   `resolveContext` and the `/api/auth` hook, so it applies them itself); (b) the request carries the CSRF custom header and an `Origin`
   header that is present and matches `ALLOWED_ORIGINS`. `/v1` has only the CSRF
   custom header, CORS preflight and SameSite=Lax, and Better Auth's origin
   check covers only `/api/auth/*`, so this route performs its own check, and a
   failure answers the uniform rejection below, not a plugin 403; (c) the
   session user's email equals the invitation email (Resolved decision Q38: there
   is **no** verified-email condition, because `email_verified` defaults to false
   and nothing in `002` sets it, so the condition would fail for every existing
   account; the session proves control of the account and the token proves the
   mailbox); (d) the token verifies; (e) when the invited role is `admin`, a fresh
   step-up verification exists (the same guard `002` uses in
   `packages/auth/src/step-up.ts`, answering `AUTH_STEP_UP_REQUIRED`), evaluated
   only after (a)-(d), so it reveals nothing to a caller without a valid token.
   The guard alone only rejects, so for a session that carries an `ssoSid` the
   route also calls `reauthorization.lookup` and `reauthorization.start` exactly
   as the OpenAPI interceptor does (`server.ts`), or an SSO-established admin
   could never complete it.
   It then adds only the membership with the invited role and **records whether its
   `addMember` created the membership** (an `addMember` that finds the user already a
   member is treated as done and as not created by this attempt), runs the shed of step 7
   as an explicit step (Resolved decision Q105), **only after the shed** activates
   the `_user` through `invitation_accepted`, then at once runs what is owed to the join,
   the session revocation of step 7 and the admin notice of step 6 (Resolved decision
   Q122, below), and then sets `emailVerified` on the user (Q38: the token proves the
   mailbox) and consumes the token (step 1). The order is Resolved decision Q112: inside the
   acceptance's shared context `afterAddMember` makes no `_user` write for the
   acceptance's member (Q120), so until the
   unmarked links are gone and the sessions revoked the new membership stays inert, its
   `_user` still `Invited` and the member rejected by the resolver (D13, Q105 part 3); a
   session issued through such a link that switches to the joined tenant through the
   allowlisted `/organization/set-active` in that window is still rejected on its next
   `/v1` call. **It compensates what it created before its `_user` step** (Q105, narrowed
   by Resolved decision Q118): if a step before the `_user` is activated fails (the shed or
   the `_user` write itself), it deletes the membership that this attempt
   created, idempotently, and never one it found, and it logs
   `catalog.security.invitation_accept_compensation_failed` if the deletion fails. A
   retry with the same token therefore adds the membership again and runs the shed
   again; without the compensation a failed attempt that is never retried would leave an
   inert membership behind (its `_user` still `Invited`); a retry still runs the explicit
   shed of step 7. A failure of the shed or of the `_user`
   step leaves the `_user` `Invited`, so even when the compensation fails too the member
   stays rejected (fail closed), and the first-sign-in hook does not activate that row
   (D2, Resolved decision Q111). **Once the `_user` step has run** (always after the
   shed), a later failure (the `emailVerified` write, or the consumption of the token
   failing for any reason other than a lost race) **no longer deletes the membership**
   (Resolved decision Q118): the attempt fails with the sanitized generic server error,
   the token stays valid, and a retry with the same token completes the
   acceptance: it finds the membership already there, runs the shed again (which removes
   nothing more), finds the `_user` `Active` (no write), revokes its own session and the
   recorded one only if step 7's record is still there (it is gone once the failed
   attempt's revocation succeeded), sends no notice (its `_user` step activated nothing
   and returned no status event, D2),
   sets `emailVerified` and consumes the token.
   Deleting the membership at that point would undo a join whose shed
   had already run and leave its `Active` `_user` as an orphan. **What is owed to the
   join runs as soon as the `_user` step has run** (Resolved decision Q122, which answers
   the tenth amendment's Open Question 1): the revocation of the accepting session and of
   the session that an earlier attempt's shed recorded (step 7) and, for an `admin`
   invitation, the admin notice (step 6) run before the `emailVerified` write and the
   consumption of the token, because Q118 makes the `_user` step the point after which
   an attempt never undoes the join, and the accepting request has already passed every
   session check, so revoking its session earlier changes nothing for it. An attempt
   that fails after its `_user` step and is never retried therefore leaves only the
   `emailVerified` write and the consumption of the token undone: the session that may
   have come through a shed link is already revoked, the other administrators are
   already told, and the invitation stays `pending` (Q123) until it expires. The same
   holds for a consumption whose token delete removes zero rows because a concurrent
   resend replaced the digest, which the flow cannot tell from a lost race and handles as
   one. A lost consume
   race (a consumption whose token delete or `accepted` write changes no row, step 1)
   compensates nothing, as on the new-account path: when another attempt consumed the
   token, the winner may rely on the membership the loser created, and the flow cannot
   tell that case from a concurrent resend or cancellation, where no attempt won (Q122,
   Q123), so it handles them all alike: it answers the uniform rejection of step 5
   (`CATALOG_NOT_FOUND`) and logs `catalog.security.invitation_acceptance_denied` with
   the reason `consume_conflict`, on either path, because it is a rejected acceptance,
   not one of the failures after the `_user` step that answer Q118's sanitized generic
   error. A cancellation that commits between the token
   check and the consumption therefore leaves the join standing under a `cancelled`
   invitation (Risks), and on either path such a join of an `admin` invitation is still
   announced: on this path the attempt whose `_user` step activated the row has already
   sent the admin notice, and on the new-account path the attempt sends it when its
   consumption changes no row, because that consumption undoes nothing (step 6, Resolved
   decision Q127). The existing-account acceptance never touches the password
   or the active organization, and it touches a linked account and the user's sessions, the request's
   own session (and a session that an earlier attempt's shed kept) included once the
   attempt's `_user` step has run (Q122), only to shed the
   admin-recorded SSO links of a user who now belongs to a second tenant (step 7); a `password` field
   in the body is ignored on this path. Success has the same status and
   body shape on both paths, and every failure of (a)-(d) answers the uniform
   rejection below, so a caller without a valid token learns nothing about
   whether an account exists. A caller who holds a valid token holds the
   mailbox, and that is the accepted extent of what the response can reveal.
5. _Errors._ Every rejected acceptance (nonexistent invitation, wrong state —
   expired, cancelled, rejected, already accepted, which its `accepted` status marks
   since Resolved decision Q123, so a replay is logged with the denial reason
   `already_accepted` — wrong token, a `Disabled` user, no session or a mismatched session for an
   existing account, a lost concurrent account creation, a lost race to consume the
   token, step 4) returns the same
   status, error code (`CATALOG_NOT_FOUND`) and body shape (an inviter who is no
   longer an active admin included). Two invitations of
   two tenants for the same new email accepted concurrently create one user; the
   loser's `createUser` fails on the unique email, it created nothing and so
   compensates nothing, and it answers the uniform rejection with its token
   unconsumed. A
   missing invitation still runs a dummy digest comparison so timing does not
   separate it from a wrong token. The reason is only in the
   `catalog.security.invitation_acceptance_denied` event. A password that fails
   the policy is reported only after the token has verified, so it reveals
   nothing to a caller who does not hold a valid token. The denial reasons
   include `csrf_rejected`, `origin_rejected`, `inviter_not_active_admin`,
   `member_limit` and `consume_conflict`.
6. _Admin notice (Resolved decision Q39)._ A new-account `admin` invitation is
   protected only by mailbox control at acceptance (a mistyped or hijacked
   address would yield a tenant admin who then enrols their own factor), a
   residual that is accepted. So when an invitation whose role is `admin` is
   accepted, on either path, the fixed `AdminAcceptedNotice` (D5) is sent to the other
   administrators of the organization, resolved on the server and through the
   notice controls below (Resolved decision Q53). The recipients include
   administrators whose `_user` is `Disabled`: a rogue admin could otherwise disable
   the others first and so silence the notice. **When it is sent** depends on the path
   (Resolved decision Q122). On the existing-account path the attempt whose `_user` step
   activated the row (the adapter's entry point returned `invitation_accepted` or
   `created_active` for it, D2) sends it as soon as that step has run, before the
   `emailVerified` write and the consumption of the token: an attempt that fails
   afterwards has already sent it, and a retry's `_user` step writes nothing and returns
   no status event, so a retry sends no second notice.
   On the new-account path it is sent after the acceptance commits (the token consumed),
   or when the consumption changes no row (step 1), which compensates nothing; a failure
   that is compensated (step 3) sends none (Resolved decision Q127, which answers the
   twelfth amendment's Open Question 1: a zero-row consumption takes the lost-race path
   of step 4 and leaves the join standing). On that path this holds whether or not the attempt's own `_user` step activated the row:
   the compensation keeps the `_user` that the invitation hook created, `Active` after a
   failure past the `_user` step, so a retry's `_user` step writes nothing, and a
   new-account retry after a compensated failure still announces the join when it
   commits. A new-account attempt whose consumption changed no row because a concurrent
   resend replaced the digest sends the notice, and the later acceptance with the resent
   token, which finds the account that attempt created and so runs the existing-account
   path, writes nothing at its `_user` step and sends none, so the join is announced
   once. A crash between the step after which the notice is owed (the activation on the
   existing-account path, the commit or the zero-row consumption on the new-account path)
   and the notice loses the notice, an attempt compensated on the new-account path
   whose retry runs the existing-account path, because an account for the email was
   created meanwhile, sends none, and a new-account attempt and a concurrent
   existing-account attempt of the same invitation (the invitee signing in with the
   password the first attempt set, before that attempt's `_user` step) can each send the
   notice, a harmless duplicate (Risks, Q122 and Q127; ticket TK12-1 would close it). A send
   failure never blocks the acceptance and is logged as
   `catalog.security.admin_notice_failed`.

7. _Admin-recorded SSO links (Resolved decisions Q73, Q86, Q87 and Q88)._
   `linkSsoAccount` takes an admin-chosen `sub` and writes an `account` row for the
   target user. Its cross-tenant control is a check at link time, which refuses a
   target with a membership in another tenant (D14) and, since Q88, a target that is
   an `admin` or an `owner` of the tenant (the generic rejection of task 13.3):
   admin accounts self-link through `/link-social`, which requires step-up, and
   SSO-only admins are unsupported anyway (`002` Q72), so every admin has a local
   account and can self-link; the refusal also removes the impersonation of a peer
   admin by recording one's own `sub` on them. An invitation from a second tenant
   would otherwise turn a link that a malicious or since-offboarded admin of the
   first tenant had recorded into a way into the second: the old `sub` signs in as
   the user, who reaches the second tenant through the allowlisted
   `/organization/set-active`.

   **Provenance is positive** (Q87, which supersedes Q73's admin-side marker: that one
   failed open, because a marker that was not written, had expired or was stale left an
   admin-recorded link looking user-made). `databaseHooks.account.create.after` writes
   a marker row in `auth.verification` for an account that is not the `credential`
   account only when it fires with an endpoint context whose **route path is the callback
   route** `/callback/:id` (Resolved decision Q120), where every link the user makes
   through `/link-social` or the SSO callback is created. The presence of a context alone
   is not enough, because the hook context is ambient (D2): an account that an
   internal-adapter call writes inside another endpoint handler (for example inside
   `addMember`) fires the hook with that handler's context, and a marker written for it
   would make a link the user did not make look user-made. `linkSsoAccount` goes through the
   internal adapter with no endpoint context, so its link carries **no marker**. The
   marker's identifier is `sso-link:<accountId>` where `<accountId>` is the
   **`account` row's own `id`**, not the provider's `accountId` column (which holds the
   SSO `sub`); its value is the constant `self` (no email, no tenant); and its
   `expiresAt` is a far-future sentinel, so Better Auth's cleanup of expired
   verification rows never removes it and a link never becomes admin-recorded by
   ageing. `databaseHooks.account.delete.after` deletes the marker on every deletion path
   that goes through Better Auth (the user's own `/unlink-account` and an admin unlink;
   the admin unlink calls the internal adapter outside any endpoint, so the hook has no
   endpoint context there and deletes through `(await auth.$context).adapter`, below),
   and the shed core deletes the markers of the rows it deletes itself, because its SQL
   runs no Better Auth hook (Resolved decision Q114), so on **every** path a later link of
   the same `sub` cannot inherit a stale marker. If the marker write
   fails, the hook deletes the `account` row it was written for (Better Auth has
   already inserted it when `create.after` runs, and no transaction would undo it), logs
   `catalog.security.sso_link_marker_failed` and throws, so the link fails and the state
   agrees with the failed response; and because an unmarked link counts as
   admin-recorded, a crash between the link and its marker is **fail-closed by
   construction**. A link that pre-dates this change has no marker and is shed too, at
   the user's next join or by the reconcile before it creates a missing row, and its
   user re-links through `/link-social`. A pre-dating link of a user who **already**
   belongs to two tenants is shed by no path (there is no join, and the reconcile sheds
   only before it creates a missing row), so the callback check below refuses every SSO
   sign-in through it, and `/link-social` cannot repair it: for an existing `account`
   row of the same `sub` and user, Better Auth's link calls `updateAccount` and never
   `createAccount` (`oauth2/link-account.mjs`), so `account.create.after` writes no
   marker. The repair is to unlink, then link (the runbook of task 16.5). The impact is
   limited, because no users exist before `010` (`002` Q78).

   The marker is sound only while every account created on the callback route is a
   link the user made. `auth.ts` sets `account.accountLinking.disableImplicitLinking:
   true` and neither `trustedProviders` nor `allowDifferentEmails`, so the SSO callback
   never links an account by its email and `/link-social` refuses a provider account
   whose email differs from the user's; a test pins the three settings, and a
   `/link-social` callback with a different provider email creates no account and no
   marker (task 8.5g).

   **The shed.** Whenever the user holds a membership in another tenant, every
   non-`credential` account of the user without a marker is deleted,
   `catalog.security.sso_link_shed` is emitted, and the user may re-link through
   `/link-social`, which requires step-up. Three paths run it. **The acceptance runs it
   as an explicit, idempotent step of every attempt** once the membership exists,
   including a retry whose `addMember` found the membership already there, before the
   token is consumed, and a shed that fails fails the attempt (Resolved decision Q105:
   `addMember` inserts the member and then calls `afterAddMember` with no transaction,
   and a second call answers `USER_IS_ALREADY_A_MEMBER` without calling the hook, so a
   shed that lived only in the hook was skipped by a failed or retried attempt). The
   acceptance sets the shared context of D2 on both paths, inside which the hook neither
   sheds nor writes the `_user` of the acceptance's own member (its `(tenantId, userId)`,
   Resolved decision Q120) and leaves both to the acceptance's own steps, the shed
   first (it reports the path `acceptance`) and the `_user` step after it (Resolved
   decision Q112, D4 step 4). **`afterAddMember` keeps its shed for every other membership
   path** (path `membership_hook`) and runs it **before** its `_user` write (Q112), so a
   shed that fails throws before the new row is activated and the membership stays inert,
   and **the reconcile runs it** before it creates a `_user` for a member of two or more
   tenants (D1, Q105; path `reconcile`). Idempotent means a re-run deletes the unmarked links
   that remain and does nothing more when none remains. **Sessions are revoked** (Q86,
   amended by Q106) whenever the shed removed a link: a session issued through the link
   would otherwise reach the second tenant through `/organization/set-active` once the
   membership exists, with the link already gone, and an SSO step-up of an `admin` is
   delegated to the identity provider, so it passes for the holder of the old `sub`.
   The shed therefore revokes every session of the user, not filtered on `ssoSid`
   (`002` Q83 admits SSO sessions created without one), by deleting the user's `session`
   rows (Resolved decision Q114: no secondary storage and no cookie cache are configured,
   so a deleted row is a revoked session, and a test pins that configuration), and emits
   `auth.security.session_revoked` with the new reason `sso_link_shed` for each, through
   the `emitSessionRevoked` that `@tayzu/auth` exports for it (D13); it
   **sweeps the sessions a second time after its deletion commits**, so a session that
   a callback created through the link while the deletion was in flight is revoked too
   (Q106). On the acceptance path the session that carries the acceptance request is
   kept until the attempt's `_user` step has run and, when the shed removed a link, **is
   revoked as soon as that step has run**, before the `emailVerified` write and the
   consumption of the token (Q106, which amends Q86's exemption: the accepting session
   may itself have come through the shed link; the timing is Resolved decision Q122's,
   which replaces Q106's "after the acceptance commits", so that an attempt that fails
   after its `_user` step and is never retried has already revoked it), so the user signs
   in again; the acceptance deletes that `session` row through the same core. **The removal is recorded
   with the attempt** (a consistency fix within Q106's intent, no new decision): an attempt
   whose shed removed a link can still fail before its `_user` step (such a failure is
   compensated, D4 step 4), and its retry's shed removes nothing, because the link
   is already gone, so "when the shed removed a link" would never hold for the retry that
   reaches its `_user` step, while the session that the first attempt kept, possibly issued
   through that link, stays alive. So when the shed removes a link on the acceptance path it also
   writes, in the same `withUserLock` transaction as the deletion, a record in
   `auth.verification` (no migration) whose identifier is `invitation-shed:<invitationId>`,
   whose value is the `session` row id of the session it kept (an opaque id, never the
   session token) and whose `expiresAt` is the invitation's, replacing any earlier record
   of the same invitation (a session that the earlier record names and that this shed
   does not keep has already been revoked by it). The write **deletes every
   `verification` row with that identifier and then inserts the new one** with an id
   that the core generates, inside the same `withUserLock` transaction (a mechanical
   fix, no migration): `identifier` has only a non-unique index and `id` is a text
   primary key with no default (`packages/db/migrations/0002_auth_schema.sql`,
   `packages/auth/src/persistence/schema.ts`), so an `ON CONFLICT (identifier)` upsert
   would fail. The record therefore commits exactly
   when the deletion does. **Every attempt, as soon as its `_user` step has run**
   (Resolved decision Q122), revokes through the core its own session and the session
   that the record names whenever its own shed removed a link or such a record exists,
   and deletes the record after a successful revocation; a retry with the same session
   thus revokes it, a retry with a new session revokes both that session and the one the
   earlier attempt kept, a retry after an attempt whose revocation succeeded revokes
   nothing more, and a retry after a crash between the shed and the revocation still
   finds the record. The join is final by then (Q118: nothing after the `_user` step is
   undone), so a failure of that revocation does not undo it and does not stop the
   acceptance: it is logged as
   `catalog.security.accepting_session_revocation_failed` (Resolved decision Q115, G9-5),
   with opaque ids only, the record is left in place to expire with the invitation (an
   attempt that then fails leaves it for its retry, which revokes again), and the failure
   is covered by the runbook of task 16.5 and the ticket
   "Alerts for `010`". An admin
   `unlinkSsoAccount` revokes every session of the target for the same reason and emits
   the same event. The cost, a re-sign-in on the user's devices when they join a second
   tenant with a link they did not make, is accepted. The deletion is the shed core's own
   SQL (Q114), so no Better Auth hook runs for it: the account hook's
   `auth.security.account_unlinked` with actor `self` is not emitted for it, and the shed
   is attributed by `sso_link_shed` alone.

   **Where the shed runs.** The hooks live in `packages/auth/src/auth.ts`
   (`afterAddMember` in the `organization` plugin's `organizationHooks`, the account
   hooks in `databaseHooks`), and `@tayzu/auth` cannot import `apps/api`. So the shed,
   with its session revocation and `withUserLock`, is implemented in `apps/api`
   (`apps/api/src/identity/sso-link-shed.ts`, Resolved decision Q30) as **one shed core**
   (Resolved decision Q114) that works directly on the `tayzu_auth` pool with
   parameterized SQL inside the `withUserLock` transaction: it reads the user's
   memberships and accounts, deletes the unmarked non-`credential` `account` rows and any
   marker keyed by their ids and, when it removed a link, deletes the user's `session`
   rows (except, on the acceptance path, the one that carries the acceptance, which it
   records in the `invitation-shed:<invitationId>` row above), emits the
   events and, after the commit, sweeps the sessions again; for an acceptance attempt
   whose `_user` step has run it also revokes the recorded and the accepting session and
   deletes the record (Q122).
   It builds no Better Auth instance and needs no
   `BETTER_AUTH_SECRET`, and all three shed paths use it. `afterAddMember` reaches it
   through a structural port, `SsoLinkShedPort` (`packages/auth/src/identity/ports.ts`),
   whose implementation is that core and which `createAuth` takes as the option
   `ssoLinkShed` the way it takes `userSync`; `createApp` and the bootstrap CLI build it
   from their `tayzu_auth` pool and pass it. The hook calls the port **before** its
   `_user` write (Resolved decision Q112), and the port's implementation reads the shared
   context of D2 and returns without shedding only for the acceptance's own member, the
   `(tenantId, userId)` that the context carries (Resolved decision Q120). The acceptance's
   explicit step and the reconcile call the same core directly, so the reconcile job holds
   no `BETTER_AUTH_SECRET` (D9). The core is valid only because `auth.ts` configures no
   `secondaryStorage` and no `session.cookieCache`, so a session that Better Auth no longer
   finds in its table no longer authenticates; a test pins both settings (task 8.5h).
   The marker hooks and the callback check below need nothing from `apps/api`: they stay
   in `auth.ts` and read and write `auth.verification`, `account` and `member` through
   the adapter of the hook's endpoint context when there is one, and through
   `(await auth.$context).adapter` when there is none (the admin unlink calls the
   internal adapter outside any endpoint, so `context.context.adapter` is absent for its
   marker delete). Because the hook context is ambient (D2), its presence says which
   endpoint is running, not that the user linked or unlinked: the self-link events of
   `002` D24 (`auth.security.account_linked` and `account_unlinked` with actor `self`,
   `emitSelfLink` in `auth.ts`) are therefore emitted **only** when the context's route
   path is the user's own `/unlink-account` (for `account_unlinked`) or the callback
   route `/callback/:id` (for `account_linked`), never on the presence of a context
   alone, so an account row that an internal-adapter call writes or deletes inside
   another endpoint handler (for example inside `addMember`) emits neither (task 8.5g),
   and the marker write of `account.create.after` checks the same callback route path
   (Resolved decision Q120, above).

   **The SSO callback refuses a session through a shed link** (Q106). A callback that
   read the account before the shed deleted it could otherwise still create its
   session afterwards. The callback's `session.create.before` therefore re-reads the
   account the callback signed in through (for example, the callback's
   `account.update.after`, which Better Auth runs for the token refresh before the
   session is created, stashes the account row's id for the request) and refuses to
   create the session when that account no longer exists, or when it has no marker
   while its user belongs to two or more tenants, with the callback's one uniform
   rejection, so no session is created (an unshed pre-dating link of a user already in
   two tenants is refused the same way, and is repaired by an unlink, then a link,
   above). It **fails closed** when no account id was
   stashed for the request (Resolved decision Q115, G9-3): it then cannot tell which
   account the callback signed in through, and refuses the same way. Better Auth runs
   that account update only when `account.updateAccountOnSignIn` is not `false`, so task
   8.5g pins that setting beside the three linking settings above.

   **One advisory lock per user** (Q87) closes the race between a link and a join:
   `linkSsoAccount` takes it around its membership check and its link, and the shed
   takes it around its read and its deletion, so a link that commits after a join's
   shed cannot exist (the join's membership commits before the shed takes the lock, so
   a later link sees two tenants and is refused, and an earlier link is shed). Every
   path takes the lock through the shed, exactly once: the acceptance in its explicit
   shed step, after `addMember` has returned (inside the shared context the hook does
   not shed the acceptance's member, so the lock is never taken twice), `afterAddMember`
   on the other membership
   paths, and the reconcile (Q105). The lock is
   a `pg_advisory_xact_lock` on a key derived from the user id, held by a short
   dedicated `tayzu_auth` transaction for the length of the critical section; the shed
   core runs its reads and deletes inside that same transaction (Q114).

**Invitation email caps (Resolved decision Q15).** `identity.users.invite` and
`identity.users.resendInvitation` share: **30 per hour per tenant**, **3 per 24
hours per recipient across all tenants** (keyed by an HMAC-SHA256 of the canonical
email under the server secret `IDENTITY_TOKEN_HMAC_SECRET`, never the address nor a
bare digest of it, Resolved decision Q93: an unsalted digest is a pseudonym that
anyone can recompute, and the key persists in `auth.rate_limit`, which `045`'s purge exempts), and a **global kill switch**
(`INVITATION_EMAIL_KILL_SWITCH`, an environment variable). Exceeding any of them
fails with `AUTH_RATE_LIMITED` (429), sends nothing, and emits
`catalog.security.invitation_rate_limited` with a bounded `limit_scope`
(`tenant`|`recipient`|`global`). `002` requires a `Retry-After` header on every
limiter, and `ORPCError` carries no header (the token limiter sets it by hand),
so a package-local `AuthRateLimitedError` (exported from the `@tayzu/auth` index)
carries `retryAfterSeconds`, `apps/api` registers oRPC's `ResponseHeadersPlugin` (it
ships in `@orpc/server`, so no new dependency) and the error mapping sets the header
through it: `errorMappingInterceptor` takes no context and `toOrpcError` drops the
value today, so both change to carry it. The accept route sets the header by hand
like token exchange. Every `AUTH_RATE_LIMITED` of the invitation
caps carries the **same** `Retry-After` (the shortest window, one hour), so the
header does not reveal which bucket tripped (Q61, always 1 hour). The buckets are service-level counters on a store interface (the key
needs the resolved tenant and the body's recipient, which a path-keyed
preHandler does not have). Defaults are enabled in code, live in
`apps/api/src/config.ts` following its `limitWithDefaults` positive-integer
pattern, and a disabled or zero value fails startup (`002` Q39). The store is in
memory in tests. In production the caps **and** the accept route's limiter use
`002`'s DB-backed atomic store (`auth.rate_limit`, hashed keys), which is shared
across replicas and needs **no migration**. The accept route's limiter is a
Fastify `preHandler` that consumes a bucket of that store (scope
`invitation_accept`), not the in-memory `createRateLimit` of the other routes,
whose per-replica budgets are the M13 problem. `consumeRateLimitBucket` is not
exported today and is tied to the Better Auth plugin's rule table
(`pre-auth-rate-limit.ts`), so this change exports a scope-generic helper from
`@tayzu/auth`, built from `(await auth.$context).adapter`, and adds rules for the
new scopes; the accept route's bucket is keyed by the hash of `request.ip` as Fastify resolves it
under the app's trust setting (`server.ts` trusts every private range today, and `002`
gates `TRUST_PROXY` on the exact ingress hop count, so behind the ingress the limiter
is only as good as that setting, Gates), and `hashBucketKey`, whose kinds are `'ip' | 'email' | 'user'` today, gains `'tenant'`
for the tenant buckets. The closed `RateLimitScope` union gains `invitation_accept`,
`invitation_tenant`, `invitation_recipient`, `notice_tenant` and `notice_recipient`
(the notices' own per-recipient bucket, Resolved decision Q101, below), and the
re-authorization callback adds `reauthorization_callback` in the hand-offs: six new
scopes in all. Neither executable telemetry contract enumerates scope values, so
in code only the TypeScript union changes, but `002`'s design and
`pre-auth-rate-limit.ts` declare the scope a closed three-value enum, on `002`'s
rate-limit metric and log event as well. This change **amends** that enum and records
the amendment in `docs/catalog/auth-and-rbac.md` (task 16.14): the generic helper
reports a bucket denial on `002`'s metric and log event with the new scope as an
attribute value (not a new instrument), besides the invitation-specific event
(task 6.10). A per-replica bucket would not enforce a per-recipient cap, which is why
the shared store is not optional.

Two properties of the per-recipient cap are accepted and documented in
`docs/security/data-retention.md`: one tenant can exhaust the cap for a victim
address and so block other tenants' legitimate invitations (a denial of
invitation, and a weak oracle, see Risks), and the kill switch is an
environment variable, so flipping it needs a new revision of the app; the
emergency procedure is in `docs/security/secrets.md`.

**What the windows mean (Resolved decision Q66).** `002`'s store resets a bucket
only after a full window passes with **no allowed request**, because every allowed
hit moves `lastRequest`, and the table has no window-start column. So the caps of "30 per
hour", "3 per 24 hours" and the notice cap of 60 per hour (the per-key limit of D8 is
Better Auth's own and is not affected) mean "N allowed requests while the gaps
between them stay shorter than the window": a slow trickle of one request every 59 minutes
never resets the bucket, so the count accumulates until the cap. That is stricter than the nominal rate and errs on the
restrictive side, so it is accepted and documented in
`docs/security/data-retention.md`; a test pins the slow-trickle case, and no
migration is added (a window-start column or a separate counter table is not built).
The same holds for the notices' own per-recipient bucket (below).

**Notice emails (Resolved decision Q53).** The admin-accepted notice (D5), and
the org-deletion notice that `045` adds, fan out one email per administrator, and a tenant admin
can create `admin` accounts at third-party addresses with `identity.users.create`,
so uncapped notices would be a mailbombing vector and a risk to the sender
domain's reputation. They therefore go through the controls of the invitation
email: the **global kill switch** (`INVITATION_EMAIL_KILL_SWITCH`, which stops
every template despite its name), a **per-recipient bucket of their own** (scope
`notice_recipient`, Resolved decision Q101: the 3 per 24 hours of Q15, which Q53 applies to the notices, keyed by the same
HMAC of the canonical email, Q93, but counted apart from the invitation bucket, so that
any tenant that invites an address three times cannot silence that person's notices and
the notices cannot exhaust that person's invitation budget) and a
**per-tenant notice cap** (scope `notice_tenant`, its own bucket, counted in emails
per hour, with its default in `apps/api/src/config.ts` and a disabled or zero value
failing startup; the default is 60 per hour, Q58). A notice goes to **at most 20
recipients**, the administrators who have been members the longest. A notice that
is suppressed or truncated never blocks the operation that triggered it (on the
existing-account path the attempt's `_user` step has already activated the row, and on
the new-account path the acceptance has already committed or its consumption has
changed no row, Resolved decisions Q122 and Q127, D4 step 6) and
is logged as `catalog.security.notice_suppressed` with the template, the
suppression reason (`global`, `tenant`, `recipient` or `truncated`) and the number
of emails dropped.

**Resend.** `identity.users.resendInvitation` does **not** call Better Auth's
`inviteMember` with `resend: true`, because that resets `expiresAt` to now + 48
hours. It replaces the token digest in `auth.verification` for the same
invitation, keeps its `expiresAt`, and sends the email. Resend and cancel **skip an
invitation whose status is not `pending`** (Resolved decision Q123): a resend of an
accepted, cancelled or rejected invitation is refused, mints no token, sends no email and
logs no `catalog.audit.invitation_resent`, and an admin's cancel of one is **refused the
same way** (Resolved decision Q129, which answers the twelfth amendment's Open Question
3): it changes nothing and logs nothing (no `catalog.audit.invitation_cancelled`). Both refusals
answer `CATALOG_VALIDATION_FAILED` with the same fixed message and no provider text, the
answer this change gives to an operation that its target's state forbids (a disallowed
status transition, D2; a refused rotation, D8; no new code, D10), so an admin who cancels
an invitation that was accepted meanwhile is told that the cancel did not take effect
(and, if they wanted the join stopped, disables the member, Risks); the status is read in
the handler, after the wrapper's checks and the resolution of the target (D10, D14), so a
missing or foreign invitation still answers `CATALOG_NOT_FOUND`. The internal
cancellations (`user_created` below, and `user_disabled` and `inviter_disabled`, D13)
answer nothing and only skip such an invitation. Both operations read the status through
the repository of D14 first, because Better Auth's `cancelInvitation` updates the status
without checking it (`crud-invites.mjs`), so it would turn an accepted invitation into a
cancelled one. That read is a statement of its own before the write, not atomic with the
acceptance's conditioned `accepted` write (step 1), so a cancel or a resend that read
`pending` just before an acceptance committed still cancels or re-tokens that
invitation: the cancel overwrites `accepted` with `canceled` and logs
`catalog.audit.invitation_cancelled`, and the resend mints a token for an accepted
invitation and emails it. **That window is accepted as a documented residual**
(Resolved decision Q128, which answers the twelfth amendment's Open Question 2; Risks):
it is the gap between one read and one write of an admin operation that lands within one
acceptance; it never reaches the membership or the `_user`; a token minted in it cannot
be used, because the acceptance refuses an invitation that is not `pending` (step 5);
and what it leaves, a stray email to the invitee or an `invitation_cancelled` record
beside the `invitation_accepted` of the same invitation, is in the audit log. The skips
of Q123 and the refusals of Q129 are therefore best-effort inside that window, and so
are the skips of the internal cancellations. Better Auth's own re-invite cancel
(`cancelPendingInvitationsOnReInvite`, kept Better Auth's by Q42) also writes `canceled`
with no condition after its own read of the pending invitations, and keeps its window
either way. The structural fix is ticket TK12-1 ("Serialized invitation writes",
Tickets), not built in this change.

**`users.create` and a pending invitation (Resolved decision Q110).** When
`identity.users.create` creates a user for an email that has a `pending` invitation in
the caller's tenant, it cancels that invitation once the user and the membership exist,
with the reason `user_created`, through Better Auth's `cancelInvitation` with the admin's
forwarded session headers like an explicit cancel (Q47), and emits the cancel span and
`catalog.audit.invitation_cancelled` with that reason. A stale invitation would otherwise
stay acceptable by the new account. A pending invitation of the same email in another
tenant is untouched.

- _Alternative:_ model Tayzu's own invitation record instead of Better Auth's.
  Rejected: duplicates a state machine Better Auth already implements
  correctly (expiry, single-pending-per-email via re-invite cancellation).
- _Alternative:_ allowlist the native accept route (reopens the gap `002` D18 closed),
  or only accept for users who already have an account (makes invitations
  nearly useless). Rejected by Resolved decision Q8.
- _Alternative:_ refuse an invitation to any email that already has an account,
  or accept an existing account with the token alone. Rejected by Resolved
  decisions Q18 and Q24: the first reverses Q18 and gives an "email exists"
  oracle, the second lets mailbox control alone grant a role to someone else's
  account.

### D5. Email: an `EmailSender` port, Azure Communication Services adapter

Better Auth's `sendInvitationEmail` callback has no default transport — Tayzu
must implement one. `packages/auth/src/identity/email/sender.ts` defines a
small port, `interface EmailSender { send(to: string, template: EmailTemplate):
Promise<void> }`, so the concrete provider is swappable. `EmailTemplate` is a closed union of two fixed templates, `InvitationEmail` and
`AdminAcceptedNotice`; `045` adds a third, `OrgDeletionNotice`.
`azure-communication-email.ts` implements it over `@azure/communication-email`
(`1.1.0`, verified via `npm view`, 2026-09-28), consistent with the Azure-first
stack and the Key Vault-backed secrets pattern `002` establishes.

**Authentication to ACS (Resolved decision Q28).** v1 uses the connection
string (`ACS_CONNECTION_STRING`, read from the environment only), stored in Key Vault, on a **dedicated send-only ACS resource**
restricted to the sender domain, with its rotation documented in
`docs/security/secrets.md`. Migrating to a managed identity is a
**first-deployment gate** (Gates), not a ticket: a leaked connection string
would let its holder send mail from the verified sender domain.

The invitation email's content is a fixed contract (VCDM B9, SEC11):

- **Exactly one recipient**: the port takes one address, validated to be a
  single plain address (no CR/LF, no display name, no list separators, at most
  254 characters), and has no CC, BCC or attachment field, so none can be set.
- **Fixed subject and fixed template.** Only two values are interpolated: the
  link and the 48-hour expiry text. The organization name, the inviter's name
  and any other tenant or inviter free text are **never** interpolated, so
  they cannot carry a phishing message or markup.
- **Link origin from trusted configuration** (Resolved decision Q32): a
  dedicated setting, `INVITATION_LINK_BASE_URL`, that must be `https` outside
  test and must be one of `ALLOWED_ORIGINS` (`apps/api/src/config.ts`), never
  `BETTER_AUTH_URL` (the API origin, which renders nothing for a person) and
  never the request `Host` or any forwarded header. The path is fixed
  (`/accept-invitation`), and the invitation id and token travel in the URL
  fragment (`#invitation=<id>&token=<token>`), so neither reaches a server log
  or an access log. Nothing renders that page until `003` builds it, so the link
  is **inert** until then; that is documented in `docs/security/attack-surfaces.md`
  and the first-deployment gates.
- Exactly one clickable link.
- **The token never leaves the email.** The token proves mailbox control (D4), so an
  inviter who could read it could accept as the invitee: the responses of `invite`
  and `resend`, every log record and what the non-sending sender keeps (it discards
  the message) never carry the token or the id-plus-token link.
- **Provider and page hygiene** (SEC11): the adapter disables ACS user-engagement
  and click tracking (a tracked link would be rewritten and would leak the
  fragment token) and sets no Reply-To, and the sender domain's DMARC is aligned
  (a first-deployment gate). The accept page that `003` builds must strip the
  fragment after reading it, send `Referrer-Policy: no-referrer` and load no
  third-party script; these are preconditions of the mount gate (Gates).
- **Sender selection** (Resolved decisions Q67, Q80, Q96 and Q99). The provider is chosen
  by `EMAIL_PROVIDER` (`acs` or `none`). "Production" means what `002` means by it:
  **`NODE_ENV !== 'test'`** (`config.ts`, `bootstrap.ts`, `telemetry.ts`), so every
  deployed environment counts. There startup fails unless `EMAIL_PROVIDER` is set
  (an unset value fails closed, and `none`, the non-sending sender, must be chosen
  explicitly: `dast.sh` exports `EMAIL_PROVIDER=none`, because it sets no `NODE_ENV`).
  Under `NODE_ENV=test` a real provider is allowed only together with a mandatory
  **recipient-domain allowlist** (`EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, a list of
  domains in `apps/api/src/config.ts`; startup fails when a real provider is
  configured under `NODE_ENV=test` without it), and the wrapper below enforces the
  list whenever it is set, in any environment, a deployed staging environment included
  (Resolved decision Q99), so a known demo login
  cannot be used to relay phishing to a third party. The existing tests that load the
  configuration with a `NODE_ENV` other than `test` set `EMAIL_PROVIDER=none`. A wrapper around the real
  sender refuses any recipient whose domain is not on the list, treated exactly like
  a provider failure (a sanitized refusal, the operation is not blocked beyond what a
  provider failure blocks) and logged as `catalog.security.email_recipient_blocked`
  with the template and no address. CI and DAST wire the non-sending `EmailSender`
  and tests the recording fake. **Demo tenants** need more than that: the sender is
  chosen once per process, so a production deployment that hosts a demo tenant, whose
  login is widely known, could send mail from the Tayzu sender domain. An
  `EMAIL_DISABLED_TENANT_IDS` list (tenant ids, validated at startup) is honored by
  the one gate that sends invitations and by the notice dispatcher: a listed tenant's
  email is suppressed before any cap is consumed, the operation is not blocked, and
  `catalog.security.email_tenant_blocked` is logged with the tenant and the template.
  The demo-tenant provisioning runbook adds each demo tenant to the list.

The **admin-accepted notice** (Resolved decision Q39, D4 step 6) is the second
fixed template: a fixed subject and body with **no link, no interpolated value**
and no tenant or actor free text, sent as one email per recipient to the other
administrators of the organization when an `admin`-role invitation is accepted,
through the same notice controls.

SEC11 answers recorded for the SSA (Resolved decision Q34): the platform sends
only these fixed templates (the invitation, the admin-accepted notice and, from `045`, the
org-deletion notice); the one clickable link is the invitation-accept
link, which is unavoidable for a no-account invitee and is mitigated by the
fragment token, single use, 48-hour expiry and the configured origin; only the
recipient address varies; there are no attachments.

- _Alternative:_ a generic SMTP client. Rejected: another credential shape
  (SMTP username/password) to manage in Key Vault for no benefit over a
  managed Azure service already in the stack's cloud. A managed identity for
  the provider needs `@azure/identity`, an unplanned dependency, so it is a
  first-deployment gate with its own design amendment (Resolved decision Q28).

### D6. Service accounts: `_user` sub-kind + org-owned machine credential — ADR-0017

A service account is a `_user` entity with `accountKind: "service"`, created
through one orchestrated operation (in `apps/api`, Resolved decision Q30): (1)
create the `_user` entity with `status: Active`, written through `created_active` by the
Q30 adapter (no invitation), role `member`
and an empty `moderatedBlueprints`, written as the `system` actor with
`onBehalfOf` set to the admin (Resolved decision Q10); (2) issue an
organization-owned Better Auth API key by reusing `002`'s single
`machine-credential` apiKey config (`references: "organization"`,
`defaultPrefix: "tayzu_mc_"`), headerless with `body.userId` the acting admin's
Better Auth user id (D8), with metadata
`{ actorKind: 'integration', role: 'member', userId, createdBy }` — `role` stays
`member` because token exchange rejects any credential without it, `userId` is the
service account's `svc-…` identifier (Resolved decision Q90: the `_user` is read by
identifier, `EntityOutput` has no row id, and the resolver, Cerbos and telemetry use
the same value, with no catalog contract change), and `createdBy` is the acting admin's opaque Better Auth
user id, recorded so that the viewer can show who created the credential (D7; a
disabled admin's service accounts and credentials otherwise have no visible
creator); (3) return `{ user, clientId, clientSecret }` once.
If issuing the key fails after the `_user` was written, the `_user` is removed
again (compensation) and the failure is recorded as the error of the
`identity.service_account.create` span (no new event), so no service account without a
credential is left behind. Service-account identifiers follow
`^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$` (not an email-shaped string), ADR-0017. A
tenant holds at most **50 service accounts** (Resolved decision Q56; configurable
in `apps/api/src/config.ts`, a disabled or zero value fails startup); creating one
beyond it fails with `CATALOG_VALIDATION_FAILED`, checked under a per-tenant
advisory lock so concurrent creates cannot overshoot.

**The principal of a service account is never read from its `_user`
(Resolved decision Q12).** `002` Q28 fixes every machine principal as
`{ roles: ['member'], teams: [], moderatedBlueprints: [] }`, built from the
signed token claim, and `002` treats that context contract as frozen. A
service account has no Better Auth user or member row, and `CLAUDE.md` bans
`actor.type` branches outside three files, so this change adds **no**
entity-sourced role, team or Moderator plumbing to `packages/authz`. `userId`
is added to the token only as an attribution claim (who the credential is
bound to), never as a source of authority: it is added where
`token-exchange.ts` builds the signed payload, and the payload parser in
`context-resolver.ts` ignores extra claims, so adding it is safe.
`exchangeMachineToken(auth, params)` takes no database pool today, and the
checks of D13 need the `_user` lookup, so its signature gains that port (the
deletion-marker lookup is `045`'s, its D4 and task 5.6). A tampered `_user` row therefore cannot raise a service
account above `member`.

**Ceiling (Resolved decisions Q7, Q16).** A service account holds `member`
and an empty `moderatedBlueprints`, always: `002`'s step-up gate exempts
`agent`/`integration`/`system` actors by design, so an elevated role bound to
a leaked secret would carry that power forever with no MFA layer. It is
enforced at creation (input validation rejects anything else before the
`_user` or the credential exists) and independently by the Cerbos rule in D3;
there is no operation that edits a role, so no update path exists to guard.

**One active credential per service account (Resolved decision Q40).** A service
account holds exactly one active credential. `identity.credentials.create` takes
an optional `userId`, which is resolved server-side to a service-account `_user`
of the caller's tenant (anything else is `CATALOG_NOT_FOUND`, D14) and is refused
when that service account already has an active credential. A revoked credential
may be rotated only when its service account has no active credential, and
creation, rotation and deletion are serialized per service account by one advisory
lock (D8), so two concurrent creates cannot both pass the check and a credential
created or rotated while the account is being deleted cannot survive the deletion.
Creating a service account is refused with `CATALOG_VALIDATION_FAILED` (the generic
answer of task 13.3) while a non-revoked key of the tenant still carries its identifier
as `metadata.userId`, for example one that survived the failed deletion of an earlier
service account of the same identifier: the new account would otherwise start with a
second active credential, against this rule, and the old key would resolve again as
soon as the new `_user` exists. The check runs under the same lock, over the paged
lookup of D7. A database constraint
on the invariant (a partial unique index over `apikey`) is a ticket, because it
needs a migration and `metadata` is a text column. The invariant is also enforced
on the request path: the resolver and token exchange reject a token whose
`userId` claim is present but whose bound `_user` is absent or not `Active`
(D13), so a surviving credential of a deleted or tampered service account cannot
resolve as a `member` of the tenant.

**Operations.** Disable and re-enable are `identity.users.setStatus` on the service account's `_user` identifier (D10, D13); a service account has no Better
Auth user, so `setStatus` writes only `_user.status` and the resolver check of
D13 enforces it. The service-account branch of `setStatus` is chosen by the
**resolved** `accountKind` of the target, never by the shape of the identifier alone.

**A service-account route never acts on a human (Resolved decision Q62).**
`identity.serviceAccounts.delete` runs as `system`, so without a target-type check
`DELETE /v1/service-accounts/alice@x.com`, or an admin's own address, would remove a
human's `_user` row: the human would be locked out with `user_missing` and no
`Disabled` state or `user_status_changed` event, the self-deny (which lives on
`updateStatus`) would not apply, and the reconcile would later recreate the row as
`Active`, reviving a user the admin had disabled. So every `service_account` route
resolves its target server-side and answers `CATALOG_NOT_FOUND`, identical to an
unknown id, unless the resolved `_user` has `accountKind == "service"` **and** an
identifier matching `^svc-`. This applies to the caller's own `_user` and to an
owner's too, and nothing is revoked, removed or emitted for a refused target.
`accountKind` also reaches Cerbos, whose deny of D3 is the second layer. The
optional `userId` of `credentials.create` goes through the same resolver, so a
human or a standard `_user` with an `svc-`-shaped identifier cannot be bound to a
credential either.

Deletion is `identity.serviceAccounts.delete`: a plain
`entities.delete` on `_user` is denied by the reserved-prefix rule, so an
explicit operation revokes **every** non-revoked credential bound to the service
account (every `apikey` with `referenceId = ctx.tenantId` and `metadata.userId`
equal to the service account's `svc-…` identifier (Q90), found by a paged scan of the tenant's keys (D7), through
the revocation list, permanent) and then removes
the `_user` entity as `system` with `onBehalfOf` the admin, holding the
per-service-account lock of credential creation and rotation for the whole operation.

- _Alternative:_ mint a synthetic `@service.tayzu.internal` email. Rejected: it
  invites accidental email delivery attempts and lookalike-phishing risk for no
  behavioral benefit.
- _Alternative considered (Q7 option 2):_ allow admin-role service accounts
  with a secondary approval/friction mechanism. Rejected: a new control to
  design and build for a capability nothing in the roadmap asks for.
- _Alternative considered (Q7 option 3/4):_ accept the design as-is, or
  document a residual risk. Rejected: the fix is cheap relative to the blast
  radius; a service account needs least privilege at the role layer, since it
  cannot have MFA.
- _Alternative:_ read `teams` (or role) from the `_user` entity through a new
  claim. Rejected by Resolved decision Q12: it changes `002`'s frozen resolver.

### D7. Org API-credentials viewer is a read model over Better Auth's `apikey` table

Better Auth's `listApiKeys` and `getApiKey` are bound to a session and have no
server-side `userId`, so the listing is an **adapter-level read** of the `apikey`
table (through the `tayzu_auth` pool), filtered to the caller's tenant
(`referenceId = ctx.tenantId`) and to the `machine-credential` `configId`, with a
bounded limit, and joined in the service layer to the `_user` entity via each
key's `metadata.userId` for service-account credentials. The kind is
`service_account` (a key bound to a service account), `agent` or `integration`
(keys without a `_user`, by their `actorKind`). The entry carries the key's opaque
`id`, which rotate and revoke take as `{credential}` (the view had none, so a
credential could not be addressed). The prefix is the constant `tayzu_mc_`, because
no first characters of a secret are stored (D8), so it identifies nothing; `enabled`,
`createdAt`, `lastRequest`, a computed `rotationDueAt` (from `metadata.rotatedAt`, or
from `createdAt` for a key never rotated; D8) and `createdBy` (the
opaque id the key's metadata records, absent for a key created before this change)
are returned;
the hashed `key` column is never selected into the response shape, so "never
re-exposes a secret" is a projection guarantee. `enabled` is derived: a
credential is shown disabled when its key is disabled, it is revoked, or its
bound service account is `Disabled`.

The viewer returns a page of at most the configured credential cap of D8 (**200** by
default), with the non-revoked credentials listed before the revoked ones and
`truncated: true` when revoked ones were left out, so no credential a tenant can hold is
hidden from an admin who must revoke it in an incident (a tenant holds at most the cap of
non-revoked ones, so a cap configured above 200 enlarges the page with it). Every
reader that must see **all** of a tenant's keys (service-account delete, rotate, the
one-credential check, the credential cap) pages through the tenant's keys to the end
and never reuses the viewer's limit, or a key beyond the limit would be skipped.
`apikey.metadata` is a `text` column in SQL (`persistence/schema.ts`), but the
adapter returns an object because of the plugin's `transform.output` (a raw SQL read
returns text), so the `metadata.userId` and `actorKind` filters are an
application-side filter over those pages, not a query on a JSON column; the reader
accepts both shapes and the viewer test pins that the adapter returns an object.
Every one of these reads goes through the single `auth-repository.ts` of D14.

- _Alternative:_ a denormalized read table Tayzu maintains itself. Rejected:
  Better Auth's `apikey` table is already the source of truth.

### D8. Credential create, rotate and revoke go through the revocation list — ADR-0018

Better Auth's `api-key` plugin has no rotate endpoint: rotation is "create a
new key, retire the old one", done at the application layer, and **retiring
means writing the revocation list**. Disabling a key through `updateApiKey`
alone would leave an already-issued 1-hour access token valid, against `002`
Q13's within-seconds rule, so rotation and revocation both use
`revokeMachineCredential`, which writes the `machine_credential_revocation` row
before disabling the key (an insert-only, permanent row).

`createMachineCredential` and `revokeMachineCredential`
(`packages/auth/src/machine-credentials.ts`) are library functions today: they
are not exported from the package index and no non-test code calls them, and
`002` registers **no** machine-credential routes. `identity.credentials.*` and
`identity.serviceAccounts.*` are their first callers, and there is no separate
machine-credential route to guard (D15). `apps/api` cannot import a file of
another package, so they are exported on a **subpath**, `@tayzu/auth/machine-credentials`
(an entry in the `exports` of `packages/auth/package.json`), and not from the main
index, and a lint rule limits their importers to `apps/api/src/identity/**` (test
files are exempt; Resolved decision Q78). The rule is a block that spreads the existing
restrictions of `eslint.config.js`, because a later flat-config block replaces the array.

**Org keys by an admin who is not the owner (Resolved decision Q29).** The
functions currently forward the caller's session `headers`, which makes Better
Auth run `checkOrgApiKeyPermission`, and by default only the organization
`owner` holds `apiKey` permissions: an admin allowed by Cerbos would be refused
by Better Auth, a second authorization path. So the `organization` plugin's
static access control grants the `admin` role `apiKey` create, read, update and
delete (a permission set that only Better Auth's own check reads: it is
**neutralized**, Cerbos stays the only decision point, and ADR-0013 records that,
Resolved decision Q94), and the calls are made **headerless** with `body.userId`.
Better Auth's organization-permission check still runs with `body.userId`
(`api-key/index.mjs`) and passes for any admin only because of that grant, so it never
refuses what Cerbos allowed, and Cerbos stays the real gate (its tests use an `admin`
member, not only the `owner`, D11). `CreateMachineCredentialParams`
(`machine-credentials.ts`) requires `headers` and fixes the key's metadata today, so
it changes: `headers` goes, `userId` (the acting admin's Better Auth user id) is
required, and the metadata (`userId`, `createdBy`) is supplied by the caller. Three
details make this work:

- `body.userId` must be the **acting admin's Better Auth user id** (a member of
  the organization with `apiKey` rights), not the service account's `svc-…`
  identifier (Q90) that goes in `metadata.userId`.
- `organization()` has no `ac` or `roles` today, and custom roles **replace** the
  defaults, so the change defines all three roles (`owner`, `admin`, `member`)
  from the default statements, adding `apiKey` to `admin` only, and keeps every
  default permission, including the `invitation` ones that Better Auth re-checks
  for the session member (D4).
- `getApiKey` and `listApiKeys` are session-bound (the headerless approach works
  only for create and update). Rotate and revoke read the key through an
  adapter-level lookup filtered by `referenceId` and `configId`, and the
  `getApiKey` call with headers in `machine-credentials.ts` is replaced by it.

A credential that belongs to another tenant is reported as `CATALOG_NOT_FOUND`
(D14): the helper's `AuthContextError` for a foreign credential is mapped to it.

- **Create** (`identity.credentials.create`, integration/agent credentials; a
  service account's first credential comes from D6, and binding a new credential
  to a service account follows Q40, D6): the per-key rate limit and the
  stored-secret-characters setting are **plugin-level configuration** of the `machine-credential` apiKey config (`rateLimit`,
  `startingCharactersConfig`: no first characters of the secret are stored),
  because `createApiKey` rejects per-key `rateLimit*` properties whenever it is
  given `headers` or a request (`SERVER_ONLY_PROPERTY`), which is why the call
  is headerless. Better Auth's default is 10 verifications per 24 hours; Resolved
  decision Q44 sets **60 verifications per hour per key**, configurable in
  `apps/api/src/config.ts` (`limitWithDefaults`; a disabled or zero value fails
  startup), because an integration needs about one exchange per hour and the IP
  bucket and 1-hour tokens bound the rest. The key has no hard expiry (Resolved
  decision Q20). The limit's `timeWindow` is in milliseconds (3 600 000 for the
  default) and is **copied into each key at creation**, so a later configuration
  change applies to new keys only. The plugin limits a key `name` to 32
  characters, while a service-account identifier can run to 63: a service
  account's key gets a fixed label as its `name` (the viewer shows the identifier
  from the `_user` join, D7), and an integration or agent credential's `name` is
  input of 1 to 32 characters of `[A-Za-z0-9 _.-]`. A tenant holds at most **200
  credentials** (non-revoked, service-account keys included; Resolved decision Q56;
  configurable in `apps/api/src/config.ts`, a disabled or zero value fails
  startup); creating one beyond it fails with `CATALOG_VALIDATION_FAILED`, checked
  under a per-tenant advisory lock. The key's metadata also records `createdBy`, the
  acting admin's opaque id (D6, D7); the new key of a rotation records the rotating
  admin.
- **Rotate**: create the new key, then revoke the old one, then return the new
  secret once. The new key's metadata copies the old key's `actorKind`, `role` and
  `userId`, records the rotating admin as `createdBy` and the rotation time as
  `rotatedAt` (below; task 9.6). If the revoke fails, the new key is revoked as compensation so no
  second usable credential survives; if compensation also fails,
  `catalog.security.credential_rotation_incomplete` is emitted. Rotation, the creation of a
  credential bound to a service account and the deletion of that service account (D6) are **serialized** per service account
  (per credential for an unbound integration or agent credential), for example by
  a Postgres advisory lock held for the whole operation: two concurrent rotations would otherwise each create a key and each
  revoke the old one, leaving two active credentials. The second one finds the old
  credential revoked and an active one present, and fails with
  `CATALOG_VALIDATION_FAILED`. A revoked credential may be rotated only when its
  service account has no active credential (Resolved decision Q40).
- **Revoke**: permanent; already-issued tokens are rejected within seconds
  because `resolveContext` consults the revocation list through a cache of at
  most 5 seconds, failing closed (`002` D21). The revocation lookup and its
  cache are keyed by `(tenantId, credentialId)` (D13, tasks 11.1 and 11.1b), not
  by the credential id alone.
- `rotatedAt` lives in the new key's `metadata`; the viewer computes `rotationDueAt`
  from it, or from `createdAt` for a key never rotated (D7), against a Tayzu-chosen
  default interval (90 days,
  configurable, in `docs/security/data-retention.md`). It is a documented
  policy default, not a hard-enforced expiry: no credential is force-disabled
  solely for being overdue (Resolved decision Q20).
- Because the revocation row is a permanent insert, "disable then re-enable" is
  not a credential operation. Pausing a service account is `setStatus`
  (D13), which is reversible; restoring a revoked credential is "rotate".

- _Alternative:_ a grace-period window (old key stays valid for N hours).
  Rejected for v1: real orchestration complexity for a benefit no Phase-1
  integration needs yet. Recorded as a Risk, not built.
- _Alternative (Q29):_ call Better Auth with an owner's `userId`, which silently
  elevates privilege, or write the `apikey` row directly, which reimplements key
  generation and hashing. Both rejected.

### D9. Maintenance scripts run as operator-started jobs; org deletion moved to `045`

Org deletion, its purge and its reversal were this section until Resolved decision Q103
moved them to `045-org-deletion-and-data-retention` (its D1 to D3). What stays here is
the mechanism of the scripts this change needs: the `_user` blueprint backfill and the
`_user` reconcile (D1), and the bootstrap CLI that `002` designed and Q51 moves.

Each of the backfill and the reconcile is its own Container Apps Job with its own
identity and secrets (Resolved decision Q49): it holds `tayzu_auth` (to list
organizations and members and, for the reconcile, to run the shed of D4 step 7, Q105)
and `tayzu_app`, and no other role. Neither holds `BETTER_AUTH_SECRET`: the reconcile
calls the shed core of D4 step 7 directly on its `tayzu_auth` pool and builds no Better
Auth instance (Resolved decision Q114), so the job cannot sign a session cookie or decrypt
the JWKS key. Each job also reaches **Cerbos**, because every catalog operation asks
Cerbos, the `system` actor included: the backfill's `blueprints.update`, and the
reconcile's `_user` writes through the adapter of D2 (which needs Cerbos, as the
bootstrap CLI below does) and its orphan removal, all go through the catalog's operation
pipeline. `002` runs Cerbos only as a loopback sidecar of the `apps/api` revision, and
every other Cerbos link needs TLS (`002` Q8), so each job runs **its own Cerbos
sidecar**, with the same policy bundle and configuration as the `apps/api` revision's,
reads its address as `CERBOS_ADDRESS` (task 2.0b) and builds its Cerbos client the way
`createApp` does (without TLS only on a loopback address). A sidecar does not exit when
the script does, and a job execution may not complete while a container of its replica
is still running, so whether a run completes when the script exits while its Cerbos
sidecar keeps running is verified with `010` before the first deployment (Gates);
otherwise the fallbacks are, simplest first, Cerbos run as a child process inside the job
container (on the same loopback link), or the job reaching Cerbos over TLS (`002` Q8)
instead of a sidecar, and only as the last resort the script ending the replica itself.
If `010` picks Cerbos as a child process inside the job container, the Cerbos binary
stays pinned to the same image digest as the sidecar's, tracked by task 13.12's
Dependabot, and the policy bundle is the `apps/api` revision's, shipped through the same
SHA-pinned pipeline (`002` SEC13) (the thirteenth pass's V13-note). Each script also
**asserts its own database role** at start (`current_user` against the role or roles it
declares), through the helper of task 2.0, and refuses to run otherwise: `002`'s
runtime-role assertion runs only in `createAppFromEnv` (`002` Q62), which no script goes
through. The scripts read a **separate configuration loader** (task 2.0b: `loadConfig`
requires `DATABASE_URL`, `AUTH_DATABASE_URL`, the secret and Cerbos for every caller,
which a script that holds one role, or no `BETTER_AUTH_SECRET`, cannot supply), and **each script starts telemetry,
emits its audit events and flushes before it exits** (Resolved decision Q79): telemetry
starts only in `apps/api/src/main.ts` today, so without a shared start-and-flush helper
the durable `catalog.audit.*` events of a short job (the reconcile's, and the
bootstrap's `user_created`) would be no-ops. The environment names are the ones the app
already reads (`OTEL_EXPORTER_OTLP_ENDPOINT` and `TAYZU_TELEMETRY_DISABLED`), documented
in `docs/security/secrets.md`.

**How they are started in this change.** The reviewed maintenance workflow is not built
here (it moved to `045`). Until it lands, an operator starts the backfill and the
reconcile as Container Apps Jobs inside the VNET, under just-in-time access (Azure PIM)
with a personal account, exactly as `002` designed the bootstrap CLI to be run
(Resolved decision Q91), and records the **named second approver** in the change record.
The operator's opaque id (`tayzu.identity.operator.id`, the `onBehalfOf` of the
reconcile's `system` writes, with the actor type `user`, one of the closed set of four,
Q70) is supplied through the job's environment as **`TAYZU_OPERATOR_ID`**, read through
the scripts' configuration loader (`apps/api/scripts/script-config.ts`), and validated
against the catalog's id pattern (`[A-Za-z0-9_.:-]{1,128}`, never an email); the script
refuses to run without it or with a malformed one. The id is not authenticated here: it is what the operator who starts the job sets,
and the PIM record and the named approver are the control. **The bootstrap CLI** stays
out of band as in `002`: an operator runs it once per environment, with no job and no
role of its own; it builds Better Auth the way `createApp` does, with the `tayzu_auth`
and `tayzu_app` pools, which it declares for the role assertion above (task 4.6b), under
just-in-time access like any other operator
access, and the first-deployment runbook records that. It takes the operator's opaque id
by the same mechanism (Resolved decision Q116): required from its environment under the
same name, `TAYZU_OPERATOR_ID`, validated against the same pattern and refused when absent
or malformed, recorded as `tayzu.identity.operator.id`
on the bootstrap's `catalog.audit.user_created` and as the `onBehalfOf` of the membership
hook's `_user` write of the bootstrap admin (actor type `user`, D2).

**How `045` extends this.** `045` adds the reviewed `workflow_dispatch` workflow
(Resolved decision Q41), which becomes the only way the backfill, the reconcile and its
own reversal script start in production, and derives the operator id from the workflow's
authenticated actor (`gh:<numeric GitHub actor id>`, Q70) instead of the environment an
operator sets by hand: the workflow sets the same `TAYZU_OPERATOR_ID`. The scripts
themselves do not change. The ordering constraint
stays here: the backfill and the reconcile run once per environment, after the code that
reads `accountKind` is deployed and before the release that carries the `user_missing`
rejection (D13) serves traffic in an environment that has members, and before the mount
switch is turned on (Gates, Migration Plan).

### D10. API contract

**Thirteen oRPC procedures and one plain Fastify route** on the server `002`
exposes: fourteen routes, all mounted behind the switch of D15 (`045` adds a
fourteenth oRPC procedure, `identity.organization.delete`). Each oRPC
procedure declares `.route({ method, path, spec, inputStructure: 'detailed' })`, with
`spec: markHighRisk` on the high-risk set below, like
`packages/catalog/src/api/contract.ts` (every identity procedure sets
`inputStructure: 'detailed'`, a per-route option, so every one of them receives the same
`{ params, query, body }` shape), because step-up runs only in the OpenAPI
interceptor keyed on the route spec (calls through `createRouterClient` skip it).
The identity router lives in `apps/api` (`apps/api/src/identity-router.ts`, and
`createApp` merges it with the catalog router into **one** router handed to the one
`OpenAPIHandler` of `server.ts`, so the interceptor chain (step-up, the error mapping,
`ResponseHeadersPlugin`) reaches both and no second handler exists; under
`inputStructure: 'detailed'` a procedure reads `input.params`, `input.query` and
`input.body`, and the shared parser of task 5.3d parses that shape), because
`@tayzu/auth` has no `@orpc/server` or `@tayzu/catalog` dependency; `@tayzu/auth`
holds the pure parts and the structural ports (Resolved decision Q30).
`apps/api/CLAUDE.md` and `002` D1 say that `apps/api` owns nothing domain-specific;
Q30 puts the identity orchestration there, and task 16.15 amends that rule.

| Procedure                                    | Route                                            | Notes                                                            |
| -------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `identity.users.invite`                      | `POST /v1/users/invitations`                     | high-risk                                                        |
| `identity.users.cancelInvitation`            | `POST /v1/users/invitations/{invitation}/cancel` |                                                                  |
| `identity.users.resendInvitation`            | `POST /v1/users/invitations/{invitation}/resend` |                                                                  |
| acceptance (plain Fastify route)             | `POST /v1/auth/invitations/accept`               | public, outside the tenant pipeline; not in the OpenAPI document |
| `identity.users.setStatus`                   | `PUT /v1/users/{user}/status`                    | high-risk                                                        |
| `identity.users.create` (existing)           | `POST /v1/users`                                 | high-risk                                                        |
| `identity.users.linkSsoAccount` (existing)   | `POST /v1/users/{user}/sso-account`              | high-risk                                                        |
| `identity.users.unlinkSsoAccount` (existing) | `DELETE /v1/users/{user}/sso-account`            | high-risk                                                        |
| `identity.serviceAccounts.create`            | `POST /v1/service-accounts`                      | high-risk                                                        |
| `identity.serviceAccounts.delete`            | `DELETE /v1/service-accounts/{user}`             | high-risk                                                        |
| `identity.credentials.list`                  | `GET /v1/credentials`                            |                                                                  |
| `identity.credentials.create`                | `POST /v1/credentials`                           | high-risk                                                        |
| `identity.credentials.rotate`                | `POST /v1/credentials/{credential}/rotate`       | high-risk                                                        |
| `identity.credentials.revoke`                | `POST /v1/credentials/{credential}/revoke`       | high-risk                                                        |

**Mandatory authorization (Resolved decisions Q45 and Q57).** `002`'s
`assertMayOnUser` is called by hand in each handler, and nothing makes the call
mandatory; thirteen procedures with that pattern is the scattered-access-control
risk the catalog pipeline avoided by making the declaration type-mandatory. So
every procedure of the identity router is built with `defineIdentityOperation({
authorization: { kind, action, resolveTarget }, handler })`. The wrapper keeps
`002`'s guarantees, in this order:

1. A **caller-tenant role check first**: Cerbos is asked with the caller's own
   tenant, the kind and the action and no target (a `service_account` check carries
   `accountKind: service`, because that kind's policy denies every action on any other
   value, D3, and an admin would otherwise be denied at this step on every
   service-account route; the target-type deny is enforced at step 3 with the resolved
   target), so an unauthorized caller gets the same `AUTH_FORBIDDEN` for any target and learns nothing about whether it
   exists. Without it a non-admin, a machine `member` token included, could tell a
   same-tenant target (403) from an unknown one (404).
2. Only then the input is parsed (the input contract below) and the target is
   resolved on the server (D14).
3. Cerbos is asked again with the target's real tenant and the attributes (D3),
   and `catalog.security.authz_denied` is emitted on a deny.
4. Only then the handler runs.

The wrapper **fails closed**: a Cerbos error, a malformed context or an empty role
list denies, and the handler never runs. Two tests pin the order and the
fail-closed behavior. Making the declaration mandatory is structural, not textual:
the wrapper brands what it returns, the identity router accepts only branded
procedures, the unwrapped base builder is not exported from its module, and the
structure test checks the brand, because a text scan for `.handler(` is bypassable
by chaining. A route-table-driven HTTP matrix covers each of the thirteen oRPC
routes: the admin allowed, a member 403, a machine `member` token 403, an
unauthenticated call 401 and a foreign target 404. The machine-token case matters
because service-account and integration actors skip step-up and had no denial
test.

**OpenAPI document (Resolved decisions Q43 and Q52).** The identity router is a
plain `os.$context` router with no contract, and the only committed document,
`openapi/catalog.openapi.json`, comes from `catalogContract` (and DAST scans only
that file). So `apps/api` generates a second committed document,
`openapi/identity.openapi.json`, listing the thirteen oRPC routes (not the plain
accept route), with its own `contract:generate` and `contract:check` package
scripts as a drift guard like the catalog's (`apps/api` has none today). The
router hand-parses its input and `apps/api` has no schema library, and a
dependency is added only when the design names it, so the document carries **paths,
methods, path parameters and `x-tayzu-risk` only**, with no request or response
schemas. The `x-tayzu-risk` assertions run on it. Its DAST value is therefore
limited until schemas exist (Risks), and extending the DAST scan to it stays a
first-deployment gate.

**`DELETE` routes.** They rely on the `inputStructure: 'detailed'` that every identity
procedure declares (above), so `DELETE` and `GET` routes read the query string at runtime. `DELETE /v1/service-accounts/{user}` and
`DELETE /v1/users/{user}/sso-account` take their target from the path; `045` adds
`DELETE /v1/organization`, whose confirmation travels in the query string.

The three procedures marked "existing" are `002`'s (Resolved decision Q31). Today
they have no `method` or `path` (`create` has no `.route` at all) and take a
Better Auth `userId`; they get these routes so that their step-up is tested over
HTTP, and the paths above are this design's choice. On them `{user}` is the
`_user` identifier, resolved on the server to the Better Auth user (D14), like
every other target. That changes their input from `{ userId }` to the `{user}`
identifier, and the five existing integration test files that build
`createIdentityRouter` with a `userId` body are migrated with them (task 5.3c).

`{user}` is the `_user` entity identifier (an email, or `svc-…`), sent
unencoded because `@` is legal in a path segment (Resolved decision Q12); an
address containing `/` cannot be a path segment, so `invite` and `create` reject
it (D4), and a path containing `%` is a 404 (`002` Q74). Such identifiers must
never reach telemetry (D16). There is no role or Moderator editing procedure
(Resolved decision Q16), so there is nothing to mark for it.

High-risk set (`x-tayzu-risk: high`, VCDM B11): `setStatus`,
`serviceAccounts.create`, `serviceAccounts.delete`, `credentials.create`,
`credentials.rotate`, `credentials.revoke`, `invite` and
`identity.users.create` for every invited or created role (Resolved decision
Q19), and the existing SSO `linkSsoAccount` and `unlinkSsoAccount`. Deleting a
service account is in the set because it revokes a credential, the same class as
`credentials.revoke`. The plain accept route has no route spec, so its step-up
(only when the invited role is `admin`, D4) is an explicit call to the same
guard (and, for an SSO session, the re-authorization calls, D4), tested over HTTP.

**What step-up means over HTTP** (`002` Q43, `002` Q51), because the tests must match:
the step-up marker records its **factor**, and a `password` marker satisfies the
guard only for a user with no enrolled second factor; a session that carries an
`ssoSid` delegates to a Visma Connect re-authorization instead of a local
verification; and the admin MFA gate answers `AUTH_STEP_UP_REQUIRED` to an admin
without an enrolled factor on **any** `/v1` call, so an invited admin is blocked
until they enrol. The tests therefore cover the local MFA case, the SSO case and
the unenrolled admin.

**Input contract.** The root rule on untrusted input applies to every procedure,
not only to the accept route. **The caller's role check of the wrapper comes before
the input is parsed** for every procedure. In today's `identity-router.ts` that order
holds only for `create`; `linkSsoAccount` and `unlinkSsoAccount` parse their input
first, and the wrapper changes that. So an unauthorized caller
learns nothing from a parse error and the tests of the input contract (task 14.10)
run as an admin. One shared parser in `apps/api` parses each input
into a null-prototype object, rejects `__proto__`, `constructor` and `prototype`
at every depth, rejects any field a procedure does not declare (today's
`parseInput` ignores unknown fields), and checks length limits before any lookup
or database work (a credential `name` of 1 to 32 characters, identifiers by their
patterns, the `{user}`, `{invitation}` and `{credential}` path values by shape and
length). The per-tenant caps of D6 and D8 (Resolved decision Q56) bound the data a
tenant can create.

Error codes reuse `001` design D11's table and `002`'s: `AUTH_FORBIDDEN` (403),
`AUTH_STEP_UP_REQUIRED` (403, not 409), `AUTH_RATE_LIMITED` (429, with a
`Retry-After` header, D4),
`CATALOG_NOT_FOUND` (404), `CATALOG_VALIDATION_FAILED` (400). All are already
mapped in `apps/api/src/error-mapping.ts`. The change introduces no new code.

### D11. Testing strategy

Unit tests (the D2 state machine, the password policy, pure). Integration tests
against a real PostgreSQL 16 and a real Cerbos test container (`002`'s harness),
exercising the actual Better Auth instance (no mocked `organization`/`api-key`
plugin — invitation expiry and re-invite cancellation are verified against the
real library). The `EmailSender` port is faked (a recording fake asserting "one
call, one recipient, one link"), never calling the real Azure Communication
Services API, and the breached-password check never reaches the real service: the plugin
hardcodes `api.pwnedpasswords.com` and also covers `/admin/create-user`, which 31
existing test files reach through `createAuth(` or `createUser`, so a shared stub
answers the range query for every integration test (task 8.1a) and the
breached-password test installs its own. The stub is a `setupFiles` entry of the
`int` project, which runs inside each test worker: the root `vitest.int.setup.ts`
is a `globalSetup`, which runs once in the main process and cannot patch `fetch`
in a worker. The stub is an `.mjs` module (a `.ts` file in `NODE_OPTIONS` depends on
loader ordering) listed in `turbo.json` `globalDependencies`. A child process (the
bootstrap that `zap-seed` spawns, and the API server that `dast.sh` starts and that
serves the forced password change, which also runs the breach plugin) never inherits
it, so a test that spawns one injects the stub with `NODE_OPTIONS=--import`, and
`dast.sh` sets it for the whole `dast.sh up` (a step shared with `ci:local`). It also
exports `EMAIL_PROVIDER=none` (Resolved decision Q96), and the seed's `--refresh`
call, which runs with `DATABASE_URL=unused`, needs none of the new variables (the
seed's configuration parser requires them for the seed run only).
Every existing human-session `/v1` integration test needs a `_user` row for its
member once the resolver rejects a missing one (D13), so the shared fixtures write
it (task 11.0).
The invite tests mint a real session, because `invite` forwards it (D4). `cerbos compile` (with its bundled test
suites) gates every policy file. Step-up is tested **over HTTP only** (D10), and
so is the plain accept route (it is not an oRPC procedure). Every route has a
cross-tenant test (D14). Org-owned key tests use a Better Auth `admin` member,
not only `owner`: after Resolved decision Q29 Better Auth always passes and
Cerbos is the only gate, and the test proves an `admin` is allowed by it and a
`member` is denied. The authorization of every route is also proven over HTTP by
the matrix of D10, so the wiring is tested and not only the policy.

### D12. Docs-as-Code and ADRs from this change

- `docs/adr/0017-service-account-identifier-convention.md` (D6)
- `docs/adr/0018-credential-rotation-immediate-cutover.md` (D8)
- `docs/adr/0020-cerbos-gates-invite-and-status-not-origin.md` (D3)

`002` claims 0013-0016 and 0021 is taken, so 0017-0020 are free (0019 is reserved for
`045`'s ADR on org deletion). This change amends
`docs/adr/0013-cerbos-as-sole-authorization-engine.md` (a note that Better Auth's static
`ac` roles of D8 are neutralized and Cerbos stays the only decision point, Resolved
decision Q94), and it updates `packages/authz/CLAUDE.md` ("Resource kinds are fixed" and
"empty scaffold... exports nothing yet") and `apps/api/CLAUDE.md` ("empty scaffold" and
"owns nothing domain-specific"), which would otherwise be stale. This change also writes
`docs/security/data-retention.md` (the credential rotation cadence; the invitation caps
and what their windows mean (Q66), the cross-tenant denial-of-invitation trade-off, that
the kill switch is an environment variable, so flipping it needs a new app revision (the
emergency flip is in `docs/security/secrets.md`, task 16.8), and ACS data location and
retention; the email policy (the recipient-domain allowlist, Q67,
Q96 and Q99, and the demo-tenant list, Q80); the off-boarding step for a disabled admin's
service accounts and credentials (listed by the `createdBy` of the viewer); the `_user`
reconcile runbook, with its orphan rule measured from the row's `updatedAt` (Q124); the operator repair of a user stranded by a failed acceptance
compensation, driven by the alert on `invitation_accept_compensation_failed` (Resolved
decision Q100), with the repair paths of a second tenant's `Invited` row (Q111) and the
handling of a failed revocation of the accepting session, which runs as soon as the
acceptance's `_user` step has run (Q115, Q122); `045`
extends the file with the retention policy, the erasure
statement and the reversal runbook), updates `docs/security/secrets.md` (the
Communication Services secret and its change procedure, the `IDENTITY_TOKEN_HMAC_SECRET`
of the cap keys with its owner and rotation (a rotation resets the recipient buckets,
Resolved decision Q93), the bootstrap CLI's out-of-band run (Q91), the kill switch and
its emergency flip, the `tayzu_auth` secret of the backfill and reconcile jobs, each job
with its own identity, neither holding `BETTER_AUTH_SECRET` (Q114) and each reaching its
own Cerbos sidecar at `CERBOS_ADDRESS` (D9), with owner and
rotation, the credential lifecycle),
`docs/security/attack-surfaces.md` (the fourteen routes, the public accept route and its
session binding, the inert link, and the mount gate state; it currently lists
`identity.*` as not mounted, and its hard rule still names the hand-offs "group 14 of
`043`", which is group 13 since Q103, Resolved decision Q115), `docs/security/crypto-inventory.md` (the invitation token,
the SHA-1 prefix sent to the Pwned Passwords range query as a protocol-mandated
exception (Resolved decision Q81), the HMAC-SHA256 of the per-recipient cap key and the
authentication to ACS) and `docs/security/dependencies.md` (license, `allowBuilds` and
SBOM review of `@azure/communication-email` and its transitives, the pinned image
digests, and the source and license of the bundled common-password denylist),
`docs/catalog/auth-and-rbac.md` (`002` D17: the resource-kind taxonomy, the telemetry
reference, the amended rate-limit scope enum and the amended reason enum of
`auth.security.session_revoked`), `docs/catalog/catalog-core.md` (its `## Telemetry`
section: the fixed placeholder that a catalog span carries instead of a `_user`
identifier, Resolved decision Q107, and that the `catalog.audit.mutation` log event
carries as `tayzu.catalog.resource.identifier` for a `_user` resource, Resolved decision
Q113, an amendment of `001`'s audit contract, and that the catalog sends as the Cerbos
resource id of a `_user` entity, with the positional ids of the referrer redaction and
the route templates of the catalog `_user` routes, Resolved decision Q119; tasks 4.1d and 15.5), and `docs/architecture/system-diagram.md`
(new external actors: the email provider, the invitee with their mailbox, the platform
operator; new arrows: invite → email, the public accept route, ACS egress over HTTPS, the
Pwned Passwords range query and the backfill and reconcile jobs, each with its Cerbos
sidecar, D9).

### D13. Disable, rotate and revoke take effect within seconds

Access tokens are stateless 1-hour JWTs, and `resolveContext`'s machine branch
checks neither the credential's `enabled` flag nor `_user.status`. Per Resolved
decisions Q13, Q11 and Q25, `resolveContext` and token exchange gain these
checks, all through the existing 5-second cache and **failing closed** on any
lookup failure:

- **A human is rejected when their Better Auth user is `banned` (task 13.4, the reason
  `user_banned`), and is
  admitted only when their `_user.status` in the _active tenant_ is `Active`**
  (Resolved decision Q105, which amends the rule of Q25, Q46 and Q77: the first
  wording rejected only a `Disabled` status and a missing row, so a member whose
  `_user` a failed acceptance had left `Invited` was admitted; the check now denies
  unless `Active`, like the machine branch below; task 11.8). A `Disabled`, `Invited`
  or `Staged` status is rejected with the reason `user_disabled`, which therefore means
  "present and not `Active`", as `service_account_disabled` does on the machine branch,
  and a missing row with `user_missing`. The status check is **new code**: `resolveContext`'s
  `_user` read (`readUserEntityGrants`) already reads `spec_properties`, so `status` is
  in the row it fetches, but the read has no cache and on a lookup failure it returns a
  principal-less context (which the pipeline answers with 403 `AUTH_FORBIDDEN`) instead
  of rejecting; there is no `_user` cache today (only membership and the revocation
  list are cached), so the "cached" of Q25's first wording is stale. Task 11.8 adds a
  5-second cache of the **status only** (the grants read stays uncached, as today),
  keyed by `(tenantId, userId)`, and a rejection when the lookup fails (fail closed); a
  failed lookup is never cached. The rejection is `401 CATALOG_CONTEXT_REQUIRED` with the reason only in the
  log, like `rejectMissingContext` (Resolved decision Q77); the existing test that
  asserts the principal-less context and 403 for a failed `_user` lookup is rewritten
  to this requirement, and the change is called out in the PR. A member with **no** `_user` row in
  the active tenant is rejected too (Resolved decision Q46, the reason
  `user_missing`); the reconcile (D1, Q50) creates the missing rows and is the
  repair path, and it runs before the first deployment so that no legitimate
  member is locked out. `setStatus` to `Disabled` writes `_user.status`
  through the state machine, revokes **only the sessions whose active
  organization is that tenant**, through the tenant-keyed `session` delete of the
  `auth` repository (D14) (each revocation emits `002`'s
  `auth.security.session_revoked` with the reason `admin_action`, as does the ban's
  deletion of all sessions; `emitSessionRevoked` is private in `auth.ts` today, with
  its reason fixed to `password_change`, so `@tayzu/auth` exports it from its index with
  the reason as a parameter, `password_change`, `admin_action` or `sso_link_shed`, task
  8.5h), and cancels the user's pending invitations of
  that tenant (reason `user_disabled`) **and the pending invitations that user
  created** (reason `inviter_disabled`, Resolved decision Q63; the acceptance check
  of D4 is the authoritative control and also covers a user disabled by a path that
  does not cancel, such as the ban hook); both cancellations skip any invitation whose
  status is not `pending`, so an accepted invitation stays `accepted` and logs no
  `catalog.audit.invitation_cancelled` (Resolved decision Q123), except for a cancellation
  that races the consumption, a documented residual (Resolved decision Q128, D4
  "Resend", Risks); `Active` writes the status back,
  restores no cancelled invitation and, for a user whom the disable banned (a single
  membership), clears `banned` through `internalAdapter.updateUser({ banned: false })`
  (the ban hook is skipped without an endpoint context, and since Q102 it writes
  nothing for `banned: false`). Only for a user with a **single**
  membership does the disable also set `banned` (and delete all their sessions), because
  a global ban would lock the user out of another tenant (a member of two tenants
  cannot otherwise be off-boarded by one tenant's admin, and removing a member is
  out of scope, Non-Goals; ticket "Member management"). The ban is made through the internal adapter
  (`internalAdapter.updateUser({ banned })` and `deleteUserSessions`, as
  `linkAccount` does in `identity-router.ts`; the ban, the unban and the session
  deletion are among the per-user internal-adapter exceptions that D14 names), **not** Better Auth's
  `banUser`/`unbanUser`: those routes use `adminMiddleware` and `hasPermission`
  on the global `user.role`, and every Tayzu user has the global role `user`
  (`002` Q37), so they would be refused even in process. Sign-in is blocked
  locally and through SSO, and a banned user's sign-in fails **exactly like any
  other failure** (Resolved decision Q54): Better Auth's admin plugin otherwise
  refuses a banned user with a distinct error after a correct password, a
  credential-validity oracle, so the failure is made uniform locally and in the SSO
  callback (task 13.4b). Per Resolved decision Q97 the refusal is made **after the
  credential was verified**, which is Better Auth's own ordering for a ban: the admin
  plugin's `session.create.before` hook throws FORBIDDEN `BANNED_USER` once the password
  has verified, so **no session is created** for a banned user, while the only
  session-aware hook, `hooks.before`, runs before the password is checked, so a
  pre-check would differ in timing and would refuse a banned user whatever the password.
  A `hooks.after` on `/sign-in/email` therefore rewrites that `BANNED_USER` error into
  the status, code and body of a wrong password; there is no session to delete. It does
  so by **returning a `Response`** that carries the wrong password's status, code and
  body, not by throwing a replacement `APIError`: when an after-hook throws, Better Auth
  keeps the status of the original result (`dispatch.mjs` passes `status: result.status`,
  and better-call's `toResponse` uses that status before the error's own
  `statusCode`), so a thrown error would answer the ban's 403 with a 401 body, while a
  returned `Response` keeps its own status and body (`to-response.mjs`). The
  SSO callback needs no rewrite: `auth.ts` already turns every callback failure, a ban
  included, into its one `401 AUTH_SSO_REJECTED`, so its part is a test. The response is
  uniform; the timing of a correct-password attempt (the ban is found after the hash
  comparison) may differ from a wrong password's, which is accepted and documented.
  `002` declares the reason `account_disabled` of `auth.security.login_failed` for this
  case (`002` design, Log events), while the existing sign-in hook logs every error of
  the route as `bad_credentials`: the rewrite makes it log `account_disabled` for a ban,
  as `002` declares. An expired temporary-password marker (Q36) is refused with the
  same uniform answer, also after the password was verified (task 13.5d); nothing
  refuses it before the session is created, so that case alone deletes the session the
  sign-in just created. It returns the same `Response`, because a thrown error would
  keep the success status of that sign-in; and since the context's response headers
  are still copied onto a returned `Response`, it also drops the `Set-Cookie` the
  sign-in set, so the answer carries no cookie of the session it deleted. The
  attempt itself is not invisible: it is logged internally,
with its channel (local or SSO) and the opaque user id and no email, as
`catalog.security.banned_sign_in_attempt`, while the response stays uniform.
- **The checks branch on the credential, never on `actor.type`.** The resolver
  treats a bearer machine token and a session cookie differently, and the lint rule
  bans comparing `actor.type` outside three files (`CLAUDE.md`); the human checks
  above run in the session-cookie branch and the machine checks below in the bearer
  branch, selected by how the request authenticated, so no new `actor.type`
  comparison is introduced.
- A machine principal whose token carries the `userId` attribution claim is
  rejected when the bound `_user` is **absent or not `Active`** (Resolved decision
  Q40), and token exchange refuses to mint a token for it. A deleted service
  account, one whose `_user` was tampered with or removed, and a `Disabled` one
  therefore never resolve as a `member` of the tenant, even if a credential
  survives. The revocation list is insert-only, so the cache check is what lets a
  disabled service account be re-enabled without a migration. A token without the
  claim (an integration or agent credential bound to no service account) is not
  affected.
- A principal of a tenant with a pending or purged deletion marker is rejected too;
  that check, and the marker lookup it needs in the resolver and in token exchange,
  belong to `045` (its D4).
- Revoked credentials are already covered by `002` D21 (D8). The revocation
  lookup is `WHERE tenant_id = $1 AND credential_id = $2`, but its **cache** is
  keyed by `credentialId` alone today, so a credential revoked in one tenant
  would poison the cache for the same id in another; task 11.1b keys the cache by
  `(tenantId, credentialId)` and task 11.1 adds the composite database key and
  corrects the stale comment on the key in `schema.ts`. In the
  machine principal `actor.id` is the API key id.

Each rejection emits `catalog.security.principal_rejected` and increments
`tayzu.identity.principal_rejections`. A disabled user's session would emit the
log on every request, so aggregating or rate-limiting that log (keeping the
counter) is a ticket (Risks). There is no last-active-admin guard in
this change (two admins can disable each other); it is a ticket (Risks).

### D14. Every target is resolved on the server and belongs to the caller's tenant

The `identity.*` data lives in the `auth` schema, which has no RLS (`tayzu_auth`,
`002` D6), and `same_tenant` is vacuous unless the real tenant is passed (D3).
So the tenant boundary for these routes is code, and it is stated as a rule:

- Every `{invitation}`, `{credential}` and `{user}` target (on a service-account
  route, `{user}` is the service account's `svc-…` identifier), and the optional `userId` of `credentials.create` (which
  must be a service-account `_user` of the tenant, D6), is resolved
  **server-side** and must belong to `ctx.tenantId`. Otherwise the answer is `CATALOG_NOT_FOUND`, identical to a
  nonexistent id (no existence oracle). A user belongs to the tenant when they
  have a membership in it, even if they also belong to another one.
- **A `service_account` target must also be a service account** (Resolved decision
  Q62): the `{user}` of a service-account route resolves to a `_user` with
  `accountKind == "service"` and an `svc-` identifier, otherwise the answer is the
  same `CATALOG_NOT_FOUND` (D6, D3).
- **One module reads the `auth` schema** (Resolved decision Q69). The `auth` schema
  has no row-level security, so the tenant filter of every read of `apikey`,
  `invitation`, `member` and `session` is code, and this change adds at least eight
  hand-written readers (the viewer, rotate, revoke, delete, the caps, acceptance, its
  inviter check and the notice recipients; the resolver's own reads stay in
  `@tayzu/auth`, which is not identity code of `apps/api`). They all go through one
  `apps/api/src/identity/auth-repository.ts` whose functions **require a
  `tenantId`** (apart from the `global…` functions below; a call without one does
  not type-check and fails at runtime; a `session` is filtered by
  `activeOrganizationId`). `user` and `account` hold no
  tenant, so the module reads them only through functions named `global…` for the
  reads that are global by nature (does this email have an account, which provider
  accounts does this user have), and a target that must belong to the tenant is read
  through a membership check. Among them are the two `account` reads of the existing
  link procedures, which call the internal adapter today (`identity-router.ts`):
  `globalAccountByKey(providerId, accountId)`, the "`sub` already linked" check of
  `linkSsoAccount` (`findAccountByKey` today), and `globalAccountsOf(userId)`, the
  account list of `unlinkSsoAccount` from which it takes the SSO accounts and checks
  that the user keeps a sign-in method (`findAccounts` today); both return plain read
  shapes. Two reads of tenant-keyed models are global by nature
  too, and are the only `global…` functions on those models:
  `globalInvitationById(invitationId)`, used only by the public accept route, which
  does not know the tenant before it reads the record and then derives the tenant from
  the record's `organizationId` (D4 step 2); and `globalMembershipTenantsOf(userId)`,
  which returns tenant ids only and serves the checks that look at a user's memberships
  in every tenant (the other-tenant refusal of `linkSsoAccount` and `unlinkSsoAccount`
  below, the single-membership test of the disable, D13, and the
  `target_in_other_tenant` cause of `identity.users.create`). The module is not
  read-only: it also holds three tenant-keyed writes. A **tenant-keyed `invitation`
  status write** (it requires a `tenantId`, filters by `organizationId` and the
  invitation id, and sets `accepted` only while the status is still `pending`) runs in
  the same `tayzu_auth` transaction as the digest-conditioned delete of the acceptance
  token, the last step of the acceptance (D4 step 1, Resolved decision Q123). A **tenant-keyed `member` delete**
  (it requires a `tenantId` and filters by `organizationId`) is the write that both
  compensations of the acceptance need (D4 step 4, Resolved decisions Q89 and Q105
  part 1), because Better Auth's `removeMember` needs a session; and a **tenant-keyed
  `session` delete** (it requires a `tenantId` and filters by `activeOrganizationId`
  and the user id) is the revocation of the tenant-scoped disable (D13), which must
  not reach the user's sessions of another tenant. The accesses that stay outside it by nature are its only exceptions,
  each acting on one user id that the caller has already resolved in its tenant (or, for
  the new-account compensation, has just created). They are Better Auth's
  **internal-adapter calls on that user**, which take a user id and name no model: the
  **per-user, cross-tenant session operations** (every session of a user, whatever its
  active organization) of an admin `unlinkSsoAccount` (D4 step 7) and of the
  single-membership disable (D13) (`listSessions` and `deleteUserSessions`),
  `updateUser` for the ban and the unban of D13 and for the acceptance's
  `emailVerified` write (D4 steps 3 and 4), the new-account compensation's deletion of
  the user it created (D4 step 3), and the account link of `linkSsoAccount` and the
  account deletion of the admin unlink (D4 step 7); the two procedures read `account`
  only through `globalAccountByKey` and `globalAccountsOf`. The other is the **shed core** of D4
  step 7, whose parameterized SQL on the `tayzu_auth` pool reads `member`, `account` and
  `session` rows and deletes `account`, `verification` and `session` rows inside the
  `withUserLock` transaction (Resolved decision Q114), and writes, reads and deletes the
  acceptance's `invitation-shed:<invitationId>` record in `verification` (D4 step 7). The maintenance scripts under
  `apps/api/scripts/` (D9) are not identity code and not clients of the module: the
  backfill lists `auth.organization`, and the reconcile lists organizations and members
  and reads `user.banned`, directly on their `tayzu_auth` pool, because enumerating
  every tenant is cross-tenant by nature and the reconcile builds no Better Auth
  instance (Q114). An ESLint rule
  bans direct, model-keyed adapter access to those six models from the identity code
  (`apps/api/src/identity/**` and `identity-router.ts`, whose `authorizeTarget` reads
  `member` today; the scripts are outside that file scope, and the internal-adapter
  calls above name no model, so the rule does not match them) outside that file, and
  bans there the internal adapter's `account` reads too (its `findAccount…` calls,
  among them `findAccountByKey` and `findAccounts`), which name no model either,
  spreading the existing `no-restricted-syntax`
  selectors from one shared module (a later flat-config block replaces the earlier
  setting of the same rule for the files it matches, so the restrictions of one file
  set are merged in that module, which also serves the machine-credentials import ban
  of D8), so a reader that forgets the tenant filter cannot be written by accident
  and the per-route cross-tenant tests check one place. `045`'s purge job reads under
  row-level policies and is not a client of the module.
- Cerbos receives the **target's** real tenant as the resource tenant, not
  `ctx.tenantId` echoed back, and the target's opaque id (never an email) as the
  resource id (D3).
- `tenantId` and `actor` are never read from input, path, query or body.
  Every Better Auth call (`createInvitation`, `cancelInvitation`, `createApiKey` and
  `updateApiKey`) is given the host tenant only, and the key and invitation reads are
  adapter-level through the repository (`045`'s `identity.organization.delete` compares
  its confirmation to `ctx.tenantId`, and its purge is SQL under row-level policies).
- A target with a membership in **another** tenant cannot be the target of an
  operation that acts on the global account: `linkSsoAccount` and
  `unlinkSsoAccount` refuse it (`002` VCDM M10: otherwise an admin of one tenant
  could link an SSO `sub` to a user and take the account over in another). The check
  holds at link time only, so a link recorded while the user was single-tenant is shed
  when the user later joins a second tenant (D4 step 7, Resolved decision Q73), and that
  join revokes the user's sessions (Q86). `linkSsoAccount` also refuses a target that is
  an `admin` or an `owner` of the tenant (Resolved decision Q88).
  `setStatus` is different by design: it is tenant-scoped (D13), so it works for a
  user of two tenants and affects only the caller's tenant.
- The one exception is the public accept route, whose tenant is derived from the
  invitation record that `globalInvitationById` reads (D4), never from the request.
- Each of the fourteen routes has a cross-tenant test (tasks, group 12).

### D15. Mount gate: the routes do not exist over HTTP until the hand-offs are done

`002` Q73 is a hard rule: `identity.*` and the machine-credential operations are
not reachable over HTTP before the hand-offs from `002` (tasks, group 13) are
done. There are no machine-credential routes in `002` (D8): the only HTTP path to
those operations is `identity.credentials.*` and `identity.serviceAccounts.*`, so
the gate covers exactly the fourteen routes of D10. Prose is not a gate, so it is
mechanical:

- A switch, `mountIdentityRoutes` (environment `MOUNT_IDENTITY_ROUTES`), is
  **off by default**. With it off, none of the fourteen routes is registered,
  including the plain accept route (which is registered before the `/v1/*`
  catch-all only when the switch is on). "As if it did not exist" has a precise
  meaning: the response is **the same as for an unknown `/v1` path**. The
  catch-all runs `resolveContext` first, so an **unauthenticated** call answers
  401 `CATALOG_CONTEXT_REQUIRED`, and only an authenticated caller reaches the
  router's 404. Only the accept route is a Fastify route: the other thirteen are procedures behind the single `app.all('/v1/*')`, so the test
  enumerates the route table **and** the router's procedures, fails if any
  identity route is registered or reachable outside the switch, and asserts each
  route answers like an unknown `/v1` path in both cases. This switch is also the rollback: turning it
  off removes the whole surface.
- With the switch **on**, a test enumerates the Fastify route table and fails for
  any route outside an explicit public allowlist (the accept route is on it) that
  is not behind `resolveContext`, so a new route cannot become public by accident
  (VCDM G4, task 14.3b).
- Task order matches: the group that registers the routes (group 14) comes
  **after** the hand-off group (group 13). No HTTP assertion about these routes
  is written before group 13 is done; earlier groups test in process. `002` Q73
  calls the hand-off group "`043`'s group 14", its number before the Q103 split moved
  the old group 12 out (the numbering note of the traceability section, Risks).
- The switch gates the **routes** only. The resolver checks of D13 (a human whose
  `_user` is not `Active`, a member with no `_user` row, a service account that is absent or not `Active`) apply to the existing catalog `/v1` routes
  from the deploy of this change, not from the mount, so the reconcile (D1) has to
  run before that deploy reaches an environment that has members (Gates, Migration
  Plan).
- Turning the switch on in a deployment is a first-deployment gate for `010`
  (Gates).

### D16. No identifier in a URL path reaches telemetry

`002` Q67 drops only `url.query`; the HTTP instrumentation still exports the
raw `url.path`, and `{user}` is an email. `apps/api/src/telemetry.ts` already
strips the query part of `url.full`, `http.url`, `http.target` and `url.path`
from spans (it strips only `?` and `#`). For the identity routes it additionally
replaces the path with its route template (`http.route`, for example
`/v1/users/{user}/status`), so no email, invitation id or credential id leaves
the process. It does the same for the **catalog entity routes whose `{blueprint}` is
`_user`** (Resolved decision Q119), whose `{entity}` is a member's email:
`/v1/blueprints/_user/entities/{entity}` (its `GET`, `PUT` and `DELETE`),
`/v1/blueprints/_user/entities/{entity}/status` and
`/v1/blueprints/_user/entities/{entity}/related`; the routes of every other blueprint keep
their paths and identifiers. Because `/v1/*` is one catch-all, no route template exists
upstream: the template is **computed by matching the parsed pathname** (the guards of `002`
read the parsed pathname, `002` Q74, never the raw request target) **against the twelve path templates of the fourteen routes of D10 and those three catalog templates**. The match
does not depend on how the identifier is spelled, so a path whose email is
percent-encoded (`a%40b`, as oRPC's generated client sends it, which `002` Q74 answers
with 404) also exports its template (task 15.5). The marker test runs through the real HTTP
instrumentation, not only the in-memory harness.

## Observability contract

Tracer/meter name `@tayzu/auth` (the package this change and `002` share),
version equal to the package version — a second instrumentation scope
alongside `001`'s `@tayzu/catalog`. Shared attribute keys (`tayzu.tenant.id`,
`tayzu.actor.type`, `tayzu.actor.id`) come from `@tayzu/observability/semconv`,
unchanged. The names of this change live in a **separate identity contract module**,
`packages/auth/src/telemetry/identity-contract.ts` (Resolved decision Q74), and not in
`packages/auth/src/telemetry/contract.ts`: that file already exists with `SPANS`,
`METRICS` and `LOG_EVENTS` that overlap the authz contract, and `contract.test.ts`
requires it to equal the authz contract's `auth.*` subset exactly and forbids any
`catalog.` name, so adding the names there would break five assertions that the
project rules forbid loosening (and `catalog.security.*` events emitted from
`@tayzu/auth` would not belong in it). `otel-smoke-check` imports only
`packages/authz/src/telemetry/contract.ts` today; it is extended to import the
identity module as well, so the new names are enforced. `apps/api` has no
`@opentelemetry/api-logs` dependency. `catalog.security.authz_denied` and
`tayzu.authz.decisions` already live in `@tayzu/catalog` (`pipeline.ts`,
`telemetry/instruments.ts`), which `apps/api` already depends on, so the identity
router emits the event and records every decision (the counter takes allow and deny
through its `decision` attribute) through a helper exported by `@tayzu/catalog` (no
duplicate instrument under the `@tayzu/auth` scope); every other log event, **every span and
every counter** of the identity operations is created through helpers exported by
`@tayzu/auth` (like `emitAccountLinkEvent`: an event emitter, a span helper and a
metric recorder over the `@tayzu/auth` tracer and meter, which task 2.0c builds, with
the then empty identity contract module, before the first task that emits an identity
signal), because `apps/api` has no `@opentelemetry/api` dependency and the design names
no new one. The maintenance scripts start telemetry and flush it before
they exit (D9, Q79), so their audit events are exported.
Neither contract enumerates the values of the rate-limit scope attribute
(`tayzu.auth.rate_limit.scope`), so only the `RateLimitScope` union gains the
values of D4 (the amendment of `002`'s closed enum is recorded by task 16.14), and
the generic helper reports a denial on `002`'s existing rate-limit metric and log event
with the new value (D4).

Identifier rules for every signal: `tayzu.identity.user.id` is the Better Auth
user id, `tayzu.identity.service_account.id` is the service account's `svc-…`
identifier (Resolved decision Q90: it is the account's opaque id, the same value as the
key's `metadata.userId` and Cerbos's `R.id`, and it is not an email; `EntityOutput` has
no row id), and no invited email, token,
credential name or secret appears anywhere. The `svc-…` identifier is replaced by the
placeholder of Q107 and Q113 only on the **catalog** spans, on `catalog.audit.mutation`
and in the catalog's Cerbos requests; like every identifier in a URL path, it leaves the
exported HTTP path of a route only as the route template of D16 (the identity routes,
and, per blueprint, the catalog `_user` routes, Q119).
`tayzu.identity.operator.id` is the
platform operator's opaque identifier, supplied as `TAYZU_OPERATOR_ID` through the
maintenance job's environment here, and through the bootstrap CLI's (D9, Q116), and never
an email;
`045`'s workflow derives it from its
authenticated actor (Q41): `gh:<numeric actor id>`. In every audit event of an
operation that an admin initiates, `tayzu.actor.id` is the **admin** who acted (the
`onBehalfOf` of the `system` write, Resolved decision Q10), never the `system` actor.
Where no admin acts, every audit event names the principal who did (Resolved decisions
Q116 and Q117). The reconcile's `catalog.audit.users_reconciled`
carries the operator's `tayzu.identity.operator.id` (the `onBehalfOf` of its `system`
writes, D9) and no `tayzu.actor.id`, and so does the bootstrap's
`catalog.audit.user_created` (source `bootstrap`): the CLI's operator id, the
`onBehalfOf` of the hook's `_user` write (D2, D9). The acceptance's
`catalog.audit.invitation_accepted` comes from a public route on which the invitee acts:
it carries `tayzu.actor.type` `user` and `tayzu.actor.id` the invitee's Better Auth user
id, the same value as its `tayzu.identity.user.id` and as the `onBehalfOf` of the
acceptance's `_user` step (D4 step 3). `catalog.audit.user_status_changed` records
**every status change**, emitted by the adapter of D2 after each write that changes a
status, with the principal that write has: the admin as `tayzu.actor.id` for
`setStatus`, `invite`, `users.create` and `serviceAccounts.create`; the operator as
`tayzu.identity.operator.id` in its place for the reconcile (`created_active` and
`admin_disable`) and the bootstrap (`created_active`); the user's own Better Auth user id
as `tayzu.actor.id` for the first-sign-in hook (`first_sign_in`), which is the user's own
act; the invitee as `tayzu.actor.id` for the acceptance's own `_user` step
(`invitation_accepted`); and neither attribute for the ban hook (`admin_disable`), which
has no principal of its own. Its `tayzu.identity.user.status.event` carries the bounded
status event, so a self-activation is told apart from an admin action.

**A catalog span never carries a `_user` identifier** (Resolved decision Q107). `001`'s
catalog contract (`packages/catalog/src/telemetry/contract.ts`) declares
`tayzu.catalog.entity.identifier` as a required attribute of the entity spans
(`catalog.entity.create`, `upsert`, `get`, `delete`, `status.write` and `related.list`),
and `entities.ts` sets it to the raw identifier, which for a `_user` entity is the
member's email (`user-sync.ts`). This change **amends that contract**: for an entity of
the reserved `_user` blueprint the attribute carries one fixed placeholder constant,
exported by the catalog telemetry contract, and never the identifier (task 4.1d). Q107
allows either omitting the attribute or replacing it; the placeholder is used because
the attribute is required on those spans and `otel-smoke-check` asserts required
attributes, so omitting it would loosen that assertion. It covers `002`'s existing sync,
which is latent today because `createApp` wires no `userSync`, and every `_user` write
this change adds, a service account's `svc-…` identifier included.

**Nor does the catalog audit event** (Resolved decision Q113, which extends Q107). Every
entity mutation also emits `001`'s `catalog.audit.mutation` log event after its
transaction commits (`packages/catalog/src/service/pipeline.ts`, declared in
`packages/catalog/src/telemetry/contract.ts`), whose `tayzu.catalog.resource.identifier`
is the raw identifier, so once task 4.1b wires the adapter every invite, acceptance,
status change, reconcile write and orphan removal would log the member's email. For a
`_user` resource the attribute carries the same fixed placeholder, the attribute stays
declared, and every other blueprint keeps its identifier (task 4.1d). Forensics lose
nothing: `tayzu.tenant.id` and `tayzu.catalog.change_event.seq` still find the change-event
row, which keeps the identifier in the database. This amends `001`'s audit contract, and
`docs/catalog/catalog-core.md` records it.

**Nor does a Cerbos decision log or a catalog HTTP span** (Resolved decision Q119, which
extends Q107 and Q113). The catalog's `catalog_entity` checks sent the entity identifier
as the Cerbos `resource.id`, so with `decisionLogsEnabled: true` every check of a `_user`
entity wrote the member's email to the decision log (D3). For an entity of the reserved
`_user` blueprint the catalog sends the same fixed placeholder as the resource id
(`entities.ts` and the pipeline's Cerbos call in `pipeline.ts`, and also the
per-referrer `update` check of a delete, `mayUpdateReferrer` in `entities.ts`, which
calls Cerbos directly and sends it for a referrer of the `_user` blueprint; no
`catalog_entity` policy reads `R.id`), and `redactUnreadable` (`packages/authz/src/redaction.ts`) sends
each candidate's position as its resource id and maps the decisions back to the
identifiers in process, so a referrer redaction sends no identifier either; every other
blueprint's single-entity checks (the operation's own check and `mayUpdateReferrer`) keep
their identifiers; the redaction batch is positional for every blueprint (Q130; task
4.1d). The catalog entity routes whose
`{blueprint}` is `_user` carry the member's email in their `{entity}` path segment, so
the route-template rewrite of D16 covers them too and exports their template, while the
routes of every other blueprint keep their paths (task 15.5). `docs/catalog/catalog-core.md`
records both (D12).

### Spans

| Span name                               | When   | Required attributes                                                                                                               | Conditional attributes                                               |
| --------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `identity.invitation.create`            | op     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role` (`member`\|`admin`)                                              | —                                                                    |
| `identity.invitation.accept`            | op     | `tayzu.identity.invitation.id` (the constant `invalid` for an id that fails its shape or length check, D4)                       | `tayzu.identity.invitation.path` (`new_account`\|`existing_account`) |
| `identity.invitation.cancel`            | op     | `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason` (`admin_cancel`\|`re_invite`\|`user_disabled`\|`inviter_disabled`\|`user_created`) | —                                                                    |
| `identity.invitation.resend`            | op     | `tayzu.identity.invitation.id`                                                                                                    | —                                                                    |
| `identity.user.set_status`              | op     | `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`                                                                | —                                                                    |
| `identity.service_account.create`       | op     | `tayzu.identity.service_account.id`                                                                                               | —                                                                    |
| `identity.service_account.delete`       | op     | `tayzu.identity.service_account.id`                                                                                               | —                                                                    |
| `identity.credential.list`              | op     | `tayzu.identity.credential.count`                                                                                                 | —                                                                    |
| `identity.credential.create`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.credential.rotate`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.credential.revoke`            | op     | `tayzu.identity.credential.kind`                                                                                                  | —                                                                    |
| `identity.user.reconcile` | script | `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.reconcile.created`, `tayzu.identity.reconcile.orphans` | — |

All spans are `INTERNAL`, one per operation, following `001` design's error and sanitization rules verbatim
(expected errors: `error.type` only, no exception event; unexpected errors:
sanitized exception, no message/SQL).

### Metrics

| Instrument                            | Type, unit              | Attributes                                                                                                                                                              | Purpose                                                                                                                               |
| ------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tayzu.identity.invitations`          | Counter, `{invitation}` | `tayzu.tenant.id`, `tayzu.identity.invitation.mutation` (`created`\|`accepted`\|`rejected`\|`cancelled`\|`expired`\|`rate_limited`)                                     | Invitation funnel                                                                                                                     |
| `tayzu.identity.user_status_changes`  | Counter, `{change}`     | `tayzu.tenant.id`, `tayzu.identity.user.status.to`, `tayzu.actor.type`                                                                                                  | Lifecycle churn                                                                                                                       |
| `tayzu.identity.service_accounts`     | Counter, `{account}`    | `tayzu.tenant.id`, `tayzu.identity.service_account.mutation` (`created`\|`disabled`\|`enabled`\|`deleted`)                                                              | Service-account volume                                                                                                                |
| `tayzu.identity.credential_mutations` | Counter, `{mutation}`   | `tayzu.tenant.id`, `tayzu.identity.credential.kind` (`service_account`\|`integration`\|`agent`), `tayzu.identity.credential.mutation` (`created`\|`rotated`\|`revoked`) | Credential hygiene signal                                                                                                             |
| `tayzu.identity.principal_rejections` | Counter, `{rejection}`  | `tayzu.identity.rejection.reason` (`user_disabled`\|`user_banned`\|`service_account_disabled`\|`service_account_missing`\|`user_missing`; `user_disabled` is a human `_user` present and not `Active`, Q105; `user_banned` is a human whose Better Auth user is `banned`, D13), `tayzu.actor.type`               | Enforcement of D13 is visible and alertable                                                                                           |

`tayzu.identity.step_up_denials` from the earlier draft is **dropped**: the
step-up guard already emits `auth.security.step_up_required` and
`tayzu.auth.step_up.required`.

**Cardinality budget**: `tayzu.tenant.id` stays under the same <20 bound `001`
ADR-0006 already assumes. Every other attribute above is a bounded enum.
Invited emails, invitation tokens, credential names, and credential secrets
are **never** attributes on any signal — the cardinality guard extends
`001`'s otel-smoke-check to this package's metrics too.

### Log events

| Event name                                        | Severity | Attributes                                                                                                                                                                                                                                                                                                  | Purpose                                                                                                          |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `catalog.audit.invitation_created`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.role`                                                                                                                                                                                   | Audit; the role is logged (VCDM B2)                                                                              |
| `catalog.audit.invitation_accepted`               | INFO     | same, plus `tayzu.identity.user.id` and `tayzu.identity.invitation.path`                                                                                                                                                                                                                                    | Audit; no admin acts on the public route: the invitee is the actor, `tayzu.actor.type` `user` and `tayzu.actor.id` the invitee's Better Auth user id, the same value as `tayzu.identity.user.id` (Q116) |
| `catalog.audit.invitation_cancelled`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                                                                                                                                                                                                          | Audit                                                                                                            |
| `catalog.audit.invitation_resent`                 | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`                                                                                                                                                                                                                                         | Audit (new)                                                                                                      |
| `catalog.audit.user_created`                      | INFO     | `tayzu.tenant.id`, `tayzu.actor.id` (the admin; for the source `bootstrap`, `tayzu.identity.operator.id` in its place, the operator who ran the CLI, Q116), `tayzu.identity.user.id`, `tayzu.identity.user.role` (`member`\|`admin`), `tayzu.identity.user.source` (`admin`\|`bootstrap`) | Audit for `identity.users.create` and bootstrap (`002` Q42, new) |
| `catalog.audit.user_status_changed`               | INFO     | `tayzu.tenant.id`; the principal of the write (Q117): `tayzu.actor.id` (the admin of `setStatus`, `invite`, `users.create` and `serviceAccounts.create`, the user of a first sign-in, the invitee of an acceptance) or, in its place, `tayzu.identity.operator.id` (the reconcile and the bootstrap), and neither for the ban hook; `tayzu.identity.user.id` (a human's Better Auth user id) or, in its place when `tayzu.identity.user.account_kind` is `service`, `tayzu.identity.service_account.id` (the `svc-…` identifier, Q90), and for the `created_invited` write of the invitation hook `tayzu.identity.invitation.id` (an invited email may have no Better Auth user yet); `tayzu.identity.user.status.from` (absent for a row created with its first status), `tayzu.identity.user.status.to`, `tayzu.identity.user.status.event` (`created_staged`\|`created_invited`\|`created_active`\|`invitation_accepted`\|`first_sign_in`\|`admin_disable`\|`admin_enable`, new), `tayzu.identity.user.account_kind` | Audit of every status change, emitted by the adapter of D2 after each write that changes a status, including service accounts disabled and enabled; the status event tells a self-activation from an admin action (Q117, new) |
| `catalog.audit.service_account_created`           | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id`                                                                                                                                                                                                                                    | Audit                                                                                                            |
| `catalog.audit.service_account_deleted`           | INFO     | same                                                                                                                                                                                                                                                                                                        | Audit (new)                                                                                                      |
| `catalog.audit.credential_created`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`, `tayzu.identity.credential.kind`                                                                                                                                                                                                       | Audit (`002` Q42, new)                                                                                           |
| `catalog.audit.credential_rotated`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                                                                 | Audit — opaque IDs only, never secrets                                                                           |
| `catalog.security.authz_denied`                   | WARN     | as already declared by `001`/`002`                                                                                                                                                                                                                                                                          | Reused: the identity router now emits it on every Cerbos deny (it threw silently before)                         |
| `catalog.security.invitation_acceptance_denied`   | WARN     | `tayzu.identity.invitation.id` (the constant `invalid` for a malformed id, D4), `tayzu.identity.invitation.denial_reason` (`malformed_request`\|`expired`\|`cancelled`\|`rejected`\|`already_accepted`\|`token_mismatch`\|`disabled_user`\|`not_found`\|`session_required`\|`email_mismatch`\|`account_conflict`\|`csrf_rejected`\|`origin_rejected`\|`inviter_not_active_admin`\|`member_limit`\|`consume_conflict`, the last for a lost race to consume the token, D4 step 4) | Misuse of dead/foreign invitations (SEC06/SEC11); the reason lives only here, never in the HTTP response         |
| `catalog.security.invitation_rate_limited`        | WARN     | `tayzu.tenant.id`, `tayzu.identity.invitation.limit_scope` (`tenant`\|`recipient`\|`global`)                                                                                                                                                                                                                | Invite/resend volume abuse signal; no invited email present                                                      |
| `catalog.security.self_status_change_denied`      | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`                                                                                                                                                                                                                                                                         | Self-service status tampering                                                                                    |
| `catalog.security.principal_rejected`             | WARN     | `tayzu.identity.rejection.reason` (the values of `tayzu.identity.principal_rejections`), `tayzu.actor.type`                                                                                                                                                                                                                                                       | A principal that is not `Active` (a human, Q105, or a service account) or is missing was refused (D13, new) |
| `catalog.security.credential_revoked`             | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`                                                                                                                                                                                                                                         | Security-relevant, not routine                                                                                   |
| `catalog.security.credential_rotation_incomplete` | WARN     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                                                                 | Overdue signal: a rotation left two usable credentials or none (new)                                             |
| `catalog.security.admin_notice_failed`            | WARN     | `tayzu.tenant.id`                                                                                                                                                                                                                                                                                           | The admin-accepted notice (Q39) could not be sent to an administrator; the acceptance is not blocked (new)       |
| `catalog.audit.users_reconciled` | INFO | `tayzu.tenant.id`, `tayzu.identity.operator.id`, `tayzu.identity.reconcile.created`, `tayzu.identity.reconcile.orphans` | The reconcile created the missing `_user` rows of a tenant and removed its orphans; the operator's opaque id is recorded (new) |
| `catalog.security.notice_suppressed` | WARN | `tayzu.tenant.id`, `tayzu.identity.notice.template` (`admin_accepted`), `tayzu.identity.notice.suppression` (`global`\|`tenant`\|`recipient`\|`truncated`), `tayzu.identity.notice.dropped` | A notice was suppressed or truncated by the kill switch, a cap or the 20-recipient limit; the operation is not blocked (new) |
| `catalog.security.email_recipient_blocked` | WARN | `tayzu.identity.email.template` (`invitation`\|`admin_accepted`) | The recipient-domain allowlist, wherever it is set, refused a recipient (Q67, Q99); no address is logged (new) |
| `catalog.security.banned_sign_in_attempt` | WARN | `tayzu.identity.user.id`, `tayzu.identity.sign_in.channel` (`local`\|`sso`) | A banned user tried to sign in; the response stays uniform (D13, Q54), the attempt is visible internally (new) |
| `catalog.security.email_tenant_blocked` | WARN | `tayzu.tenant.id`, `tayzu.identity.email.template` (`invitation`\|`admin_accepted`) | An email was suppressed because its tenant is on `EMAIL_DISABLED_TENANT_IDS` (D5, Q80); no address is logged (new) |
| `catalog.security.sso_link_shed` | WARN | `tayzu.tenant.id` (the tenant joined), `tayzu.identity.user.id`, `tayzu.identity.sso_link.path` (`acceptance`\|`membership_hook`\|`reconcile`) | An unmarked (admin-recorded) SSO link was deleted, and the user's sessions revoked, when the user joined a second tenant or before the reconcile created their `_user` (D4 step 7, Q73, Q86, Q87, Q105, Q106); no email or `sub` is logged (new) |
| `catalog.security.sso_link_marker_failed` | WARN | `tayzu.identity.user.id` | The provenance marker of a link the user made could not be written (D4 step 7, Q87); the link fails, and an unmarked link would be shed as admin-recorded (new) |
| `catalog.security.invitation_accept_compensation_failed` | WARN | `tayzu.identity.invitation.id` | A failed acceptance could not undo what it had created (D4 step 3, Q89; on the existing-account path, D4 step 4, Q105); the reconcile or an operator repairs it (new) |
| `catalog.security.accepting_session_revocation_failed` | WARN | `tayzu.tenant.id`, `tayzu.identity.invitation.id`, `tayzu.identity.user.id` | The session that carried an existing-account acceptance, or the one that an earlier attempt's shed kept, could not be revoked when the attempt's `_user` step had run (Q122), although a shed of this or an earlier attempt had removed a link (D4 step 7, Q106, Q115); the acceptance is not stopped, and an operator revokes it through the runbook (new) |
| `catalog.security.identity_conflict_refused` | WARN | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.conflict.reason` (`account_exists`\|`target_in_other_tenant`\|`sub_already_linked`\|`target_is_admin_or_owner`), `tayzu.identity.user.id` (the target's Better Auth user id, when the target account exists) | `identity.users.create` or `identity.users.linkSsoAccount` refused a conflict with its one generic answer (tasks 13.2b and 13.3, Q88, Q115); the cause lives only here, never in the response, and no email or `sub` is logged (new) |

Every event above is exempt from sampling and from any downstream filter/drop
rule, per `001`'s existing rule for `catalog.audit.*`/`catalog.security.*`
(`001` design, Sampling exemption) — `010` inherits this constraint unchanged.
The user, credential and bootstrap lifecycle events `002` Q42 deferred to this
change are `user_created`, `credential_created`/`credential_rotated`/
`credential_revoked`, and the bootstrap case of `user_created`; SSO link and
unlink already have `auth.security.account_linked` and `account_unlinked` (with actor
`self` they are emitted only on the callback route and `/unlink-account`, D4 step 7). These
events are declared in the identity contract module by task 13.3, before the routes
exist, because `002` Q42 forbids mounting an operation whose events are not declared;
the remaining names are declared by task 15.1. The reason `sso_link_shed` (Q86) is a
new value of the reason attribute of `002`'s `auth.security.session_revoked`, whose
design declares a closed two-value enum (`password_change`\|`admin_action`): this change
**amends** that enum, task 16.14 records the amendment in `docs/catalog/auth-and-rbac.md`,
and the identity contract module lists the value. Neither executable contract
enumerates the values (the authz contract lists the event's attribute keys only), so no
assertion changes. The event is emitted by `emitSessionRevoked`, which is private in
`auth.ts` today, with its reason fixed to `password_change`: `@tayzu/auth` exports it
from its index with the reason as a parameter (task 8.5h), so the revocations of
`setStatus` emit `admin_action` (declared by `002`, never emitted by its code) and those
of the shed and of an admin unlink emit `sso_link_shed`.

`002`'s `auth.security.login_failed` is reused unchanged: the uniform banned sign-in logs
its already declared reason `account_disabled` instead of `bad_credentials` (D13, task
13.4b), so no contract name or value is added; the smoke check's value-set assertion
gains `account_disabled` (Q131). Task 15.2 drives a banned local sign-in, and the `002`
assertion at `apps/api/src/otel-smoke-check.int.test.ts:1008-1012`, today the exact set
`{bad_credentials, mfa_failed}`, becomes the exact set
`{bad_credentials, mfa_failed, account_disabled}`, which is stricter: the smoke check
then also requires the value that `002` declares but never emitted. The PR calls the
rewrite out, as for Q76, Q77, Q125 and Q130.

## Security considerations (SSA SEC01-SEC16 posture)

This is this change's own SEC01-16 walk-through. The formal `vcdm-ssa-validator`
pre-assessment (Mode A, 2026-10-01) found 11 blocking gaps (B1-B11) against the
merged `002`, and a second pass over the amended change found five more (NB1-NB5),
resolved by Resolved decisions Q24-Q27 and the traceability table in the
Risks section, and a third pass found two more blocking gaps (R3-B1 and R3-B2)
and the questions H1-H4, resolved by Q38-Q45, and a fourth pass found no blocking gap and fourteen
non-blocking ones (G1-G14), resolved by Q48-Q57, tasks and tickets, and a fifth pass
(the re-assessment of 2026-10-01) found three blocking gaps (NB-1 to NB-3), eight
non-blocking ones (G-a to G-h) and the questions Q-A to Q-D, resolved by Q62-Q69,
tasks and tickets, and a sixth pass found one blocking gap (NB-4), fourteen
non-blocking ones (G6-1 to G6-14) and the questions Q-A to Q-C, resolved by Q73, Q80
and Q81, tasks and tickets, and a seventh pass found two blocking gaps (NB-5 and NB-6),
ten non-blocking ones (G7-1 to G7-10) and three questions, resolved by Q86-Q88, tasks
and tickets, and an eighth pass found two blocking gaps (NB-7 and NB-8) and ten
non-blocking ones (G8-1 to G8-9 and G8-12; its report assigns no G8-10 or G8-11),
resolved by Q101, Q102, Q105, Q106 and Q110, tasks and tickets, and a ninth pass found no
blocking gap and seven non-blocking ones (G9-1 to G9-7) and asked one question (the
eighth amendment's Open Question 1), resolved by Q111, Q112 and Q115, tasks and tickets,
and a tenth pass found no blocking gap and four non-blocking ones (G10-1 to G10-4, with the
tenth drift-check's D-2 and D-3), resolved by Q118-Q121 and tasks, while the ninth
amendment's two questions were answered by Q116 and Q117 and the tenth amendment's
question by Q122, and an eleventh pass's decided gaps G11-1 and G11-5 are resolved by
Q123 and Q124 and tasks, its low gaps G11-2, G11-3, G11-4 and G11-6 (with the eleventh
drift-check's mechanical items N-2 to N-5, N-5 being G11-3) by tasks, a gate and the
ticket TK11-1, with no new decision, and a consistency check of the eleventh amendment
(the twelfth amendment) fixed its passages with no new decision and raised Open
Questions 1 to 3 (the third in its second pass), answered by Q127, Q128 (with the
ticket TK12-1) and Q129 and applied, with the twelfth drift-check's N12-1 (Q130), by the
thirteenth amendment, which also folds a twelfth pass's low gaps G12-1 and G12-2 (G12-2
a residual of Q127), the twelfth drift-check's mechanical items N12-2 and N12-3 and a
follow-up of G11-2 into D2, D4, D9, the Risks, the ticket "Alerts for `010`", a gate
and tasks, with no new decision, and a thirteenth pass's low gap G13-1 (the thirteenth
drift-check's N13-1) and its V13-note, with the thirteenth drift-check's N13-2 and N13-3
and a final consistency check of the thirteenth amendment, are folded by the fourteenth
amendment into D4, D9, the Observability contract, the Risks, the Tickets, a gate, the
spec and tasks, with no new decision, and that amendment's own drift-check found N14-1
(mechanical) and N14-2 (Q131), folded into the Context, the Observability contract,
Q74 and Q130 annotated, Q131, Open Questions, the proposal, the spec and tasks; all
are folded below, and each is also a requirement or scenario
in the spec and a task, except the gaps that moved to `045` with org deletion (Q103),
which one row below lists and `045` closes. A joint pre-assessment with `002` (`002/ssa-pre-assessment.md`)
earlier found the seam gaps closed by D3/D6.

| Gap                                                                                   | Where it is closed                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 invitation acceptance cannot work                                                  | D4 (plain public accept route, token, tenant from the invitation, existing-account path), spec requirement "Invitation acceptance", tasks group 8             |
| B2 unconstrained invited role                                                         | D4 (`member`\|`admin`), spec "Invitation lifecycle", task 7.4                                                                                                 |
| B3 no server-side tenant binding                                                      | D14, spec "Targets belong to the caller's tenant", group 12 |
| B4 disable/rotate not immediate, state machine bypass                                 | D2, D8, D13, spec "Disabling a human takes effect immediately", groups 4, 9, 10, 11                                                                           |
| B5, NB3, NB4, NB-3, G7, G8, G6-2, G-g (org deletion, the purge and the maintenance workflow) | moved to `045` by Q103 (its design, Security considerations) |
| B6 `002` Q73 gate not enforced                                                        | D15, spec "Identity routes are unreachable until mounted", group 13 before 14, with every `002` hand-off item traced to a task or a recorded deferral (Risks) |
| B7 security logging gaps                                                              | Observability contract, spec "Security-relevant events are logged"                                                                                            |
| B8 paths leak identifiers                                                             | D16, spec "Telemetry contract", task 15.5                                                                                                                     |
| B9 email injection, origin, caps                                                      | D4, D5, spec "Invitation email is fixed and capped", group 6                                                                                                  |
| B10 service-account ceiling                                                           | D3, D6, spec "Service accounts", groups 5 and 10                                                                                                              |
| B11 step-up coverage                                                                  | D10, spec "Every high-risk operation requires step-up", task 14.2                                                                                             |
| NB1 existing-account acceptance decided but not specified (Q24)                       | D4 steps 4 and 5, spec "Invitation acceptance", tasks 8.5, 8.5b-8.5d, 14.7                                                                                    |
| NB2 a multi-tenant human cannot be off-boarded (Q25)                                  | D13, D14, spec "Disabling a human takes effect immediately", tasks 11.2, 11.8, 12.4                                                                           |
| NB5 `002` hand-off content incomplete                                                 | the traceability table (Risks), tasks group 13 |
| R3-B1 service-account lifecycle not closed (Q40)                                      | D6, D8, D13, spec "Service accounts" and "Credential creation, rotation and revocation", tasks 9.5b, 9.6b, 10.7, 11.6, 11.7                                   |
| R3-B2 deny-by-default not structural for the identity router (Q45)                    | D10, D3, spec "Every identity route declares its authorization", tasks 5.3b, 14.9                                                                             |
| R3 existing-account acceptance unattainable (Q38) and admin acceptance residual (Q39) | D4 steps 4 and 6, D5, spec "Invitation acceptance", tasks 8.5c, 8.15                                                                                          |
| G1 notice emails outside every cap and the kill switch (Q53) | D4, D5, spec "Invitation email is fixed and capped", tasks 6.12, 8.15 |
| G3 banned-sign-in credential-validity oracle (Q54) | D13, spec "Disabling a human takes effect immediately", task 13.4b |
| G4 wrapper contract incomplete (Q57) | D10, D15, spec "Every identity route declares its authorization", tasks 5.3b, 5.3b2, 5.3b3, 14.3b |
| G6 member without a `_user` row has no repair path (Q46, Q50) | D1, D13, spec "Every member has a `_user` row", tasks 4.2b, 11.8 |
| G12 no input contract, no per-tenant caps (Q56) | D6, D8, D10, tasks 5.3d, 9.5d, 10.8, 14.10 |
| G2, G5, G9, G10, G11, G13, G14 | tasks 6.8c, 9.5c, 4.2b, 8.1d, 9.2, 10.3b and the tickets in Risks (the deletion tasks of that set moved to `045`) |
| NB-1 a service-account route accepts a human target (Q62) | D3, D6, D14, spec "Service accounts" (scenario "A service-account route refuses a human target"), tasks 10.2, 10.7, 10.7b, 11.5, 4.2b |
| NB-2 a pending invitation outlives its inviter's authority (Q63) | D4 step 2, D13, spec "Invitation acceptance" and "Disabling a human takes effect immediately", tasks 8.5f, 11.4b |
| G-a creator of a service account or credential not visible | D6, D7, D8, tasks 9.2, 9.5, 10.3, 16.5 |
| G-b wrapper versus parse order | D10, spec "Every identity route declares its authorization", tasks 5.3b2, 14.10 |
| G-c `044` not in the Gates | Gates |
| G-d create and link cannot give "no oracle" | spec "Targets belong to the caller's tenant", task 13.3 |
| G-e denylist provenance | task 1.3 |
| G-f notice bucket drainable cross-tenant | Task 6.12b (Q101) |
| G-h banned-attempt log, notice recipients (the repeated-request log moved to `045`) | D4 step 6, D13, tasks 13.4b, 6.12 |
| Q-B email outside production (Q67) | D5, spec "Invitation email is fixed and capped", tasks 6.5, 6.5b |
| Q-D hand-written `auth`-schema readers (Q69) | D14, tasks 5.1b, 5.1c |
| NB-4 an admin-recorded SSO link survives into a second tenant (Q73) | D4 step 7, D14, spec "An SSO link that its user did not make does not survive into a second tenant", tasks 8.5b, 8.5g, 8.5h, 15.1 |
| G6-1 the invite and resend responses and the non-sending sender could expose the token | D5, spec "Invitation email is fixed and capped" (scenario "The invitation link never leaves the email"), tasks 6.5, 7.3, 7.7, 15.4 |
| G6-3 `credentials.create` `userId` resolver | D6, tasks 9.5b, 10.7b |
| G6-4 the accept route bypasses the temporary-password marker | D4 step 4, task 13.5c |
| G6-5 repository and lint ban cover only three models | D14, tasks 5.1b, 5.1c |
| G6-6 unsalted cap key (the `auth.rate_limit` hashes after a purge moved to `045`) | D4 (caps), task 6.7b (Q93), task 16.5 |
| G6-7 the inviter check mixes pools | D4 step 2, Risks, task 8.5f |
| G6-8 the accept route is in no OpenAPI document | Tickets ("DAST probe of the accept route") |
| G6-9 dot-alias and case variants of the recipient cap | Tickets ("Recipient-cap alias normalization") |
| G6-10 no notice on admin SSO link or unlink | Tickets ("User notifications", extended); the shed event covers part of it |
| G6-11 viewer limit below the credential cap | D7, task 9.2 |
| G6-12 diagram arrows without a protocol | task 16.7 |
| G6-13 stale text and the sixth pass not recorded | Context, proposal, tasks 1.1, 1.2, 16.10 |
| G6-14 demo tenants and the real sender (Q80) | D5, spec "Invitation email is fixed and capped", task 6.5c |
| Q-C SHA-1 prefix of the breached-password query (Q81) | tasks 16.8, Tickets ("Offline breached-password corpus"), SEC05 |
| NB-5 sessions issued through a shed or admin-unlinked SSO link survive (Q86) | D4 step 7, spec "An SSO link that its user did not make does not survive into a second tenant", tasks 8.5h, 8.5j |
| NB-6 link provenance fails open, races and goes stale (Q87) | D4 step 7, the same requirement, tasks 8.5g, 8.5i |
| G7-1 wrapper step 1 versus the `service_account` deny | D3, D10, tasks 5.3b2, 14.9 |
| G7-2 peer-admin impersonation by an admin-recorded link (Q88) | D4 step 7, D14, spec "Targets belong to the caller's tenant", task 13.2b |
| G7-3 links recorded by an admin outlive that admin | Tickets ("Off-boarding review by creator", "User notifications") |
| G7-4 no uniqueness of `member(organization, user)` | Tickets ("Member uniqueness") |
| G7-5 the reconcile's orphan removal races an in-flight acceptance | D1, task 4.2b |
| G7-6, G7-7, G7-8 user notifications, the notice bucket and bounce handling | Tickets; the notice bucket is task 6.12b (Q101) |
| G7-9, G7-10 tests of NB-5 and NB-6, the marker-failure event, 010 alerts | tasks 8.5g-8.5j, 15.1, Tickets ("Alerts for `010`") |
| Seventh drift-check (A1-A38 of `drift7.md`) | Context (seventh amendment), tasks 1.1, 1.2 and the tasks they name |
| NB-7 a failed or retried existing-account acceptance skips the shed and the session revocation (Q105) | D1, D4 steps 4 and 7, D13, spec "Invitation acceptance", "An SSO link that its user did not make does not survive into a second tenant", "Disabling a human takes effect immediately" and "Every member has a `_user` row", tasks 4.2b, 8.1e, 8.5b, 8.5h, 8.5i, 8.5l, 11.8 |
| NB-8 the ban hook re-enables a user disabled in one tenant (Q102) | D2, spec "User status has four states with forward-only transitions", task 4.5; the ticket "Ban-hook mirror" is resolved |
| G8-1, G8-2 sessions that the shed still misses (Q106) | D4 step 7, spec "An SSO link that its user did not make does not survive into a second tenant", task 8.5k |
| G8-3, G8-4 the marker's soundness rests on the linking configuration, and a failed marker write leaves the link | D4 step 7, spec "An SSO link that its user did not make does not survive into a second tenant", task 8.5g |
| G8-5 the notices share the invitation bucket (Q101) | D4, D5, spec "Invitation email is fixed and capped", tasks 6.10, 6.12b, 13.9, 16.14 |
| G8-6 `invitation_cancelled` and `invitation_resent` lack the tenant or the actor | Observability contract, spec "Security-relevant events are logged", tasks 15.1, 15.6 |
| G8-7 a deletion races credential creation, and a re-created identifier inherits a surviving key | D6, D8, spec "Service accounts are non-human users created API-only", tasks 10.3, 10.7 |
| G8-8 stale text | Context (eighth amendment), tasks 1.1, 1.2, 6.5, 8.1e, 16.10 |
| G8-9 (ticket TK-1) and the eighth-pass ticket TK-2: one Visma Connect link per user, and the shed on a member-role change (TK-3 and TK-4 are tasks 8.5k and 7.13, Q106 and Q110) | Tickets ("One Visma Connect link per user", "Member-role changes and SSO links") |
| Eighth drift-check A-1 to A-17 | Context (eighth amendment) and the sections and tasks it names |
| G8-12 `users.create` leaves a pending invitation of the same email (Q110) | D4, spec "Invitation lifecycle", task 7.13 |
| G8-10, G8-11 | Not assigned: the eighth pass's report numbers its ten non-blocking gaps G8-1 to G8-9 and G8-12, so no gap carries these ids |
| Eighth drift-check B-1 to B-3 (`_user` emails in catalog spans, the inviter re-check, the runtime-role assertion; Q107-Q109) | Observability contract, D4 step 2, Gates, spec "Telemetry contract", "Invitation acceptance" and "The hand-offs from the authentication baseline hold", tasks 4.1d, 8.5f, 11.1c, 15.4 |
| Ninth-pass question 1 (the eighth amendment's Open Question 1): the first-sign-in hook could activate a second tenant's `_user` without the shed (Q111) | D2, Risks, spec "User status has four states with forward-only transitions", tasks 3.2, 4.4, 8.1e, 16.5 |
| G9-1 the `_user` of a joined tenant was activated before the shed (Q112) | D2, D4 steps 3, 4 and 7, Risks, spec "Invitation acceptance" and "An SSO link that its user did not make does not survive into a second tenant", tasks 4.2, 8.1e, 8.2, 8.5b, 8.5h, 11.8 |
| G9-2 stale group number in `docs/security/attack-surfaces.md` (Q115) | D12, task 16.6 |
| G9-3 the SSO callback check depends on a stashed account id and on `account.updateAccountOnSignIn` (Q115) | D4 step 7, spec "An SSO link that its user did not make does not survive into a second tenant", tasks 8.5g, 8.5k |
| G9-4 a failed attempt's compensation can delete the membership a concurrent winner relied on | Tickets (TK9-2, "Serialized acceptance attempts") |
| G9-5 a failed post-commit revocation of the accepting session is silent (Q115) | D4 step 7, Observability contract, spec "Security-relevant events are logged", tasks 8.5k, 15.1, 15.6, 16.5, Tickets ("Alerts for `010`") |
| G9-6 the cause of a refused create or link is in no log (Q115) | Observability contract, spec "Targets belong to the caller's tenant" and "Security-relevant events are logged", tasks 13.2b, 13.3, 15.1, 15.6 |
| G9-7 a rejected `/organization/set-active` is restored silently (`002` surface) | Tickets (TK9-1, "Rejected active-organization switches") |
| Ninth drift-check N1 and N3 (`_user` identifiers in `catalog.audit.mutation`, the shed without `BETTER_AUTH_SECRET`; Q113, Q114) | Observability contract, D1, D4 step 7, D9, spec "Telemetry contract" and "Every member has a `_user` row", tasks 2.0b, 4.2b, 4.1d, 8.5h, 8.5i, 8.5l, 15.4, 16.8 |
| Ninth drift-check N2 and N4-N9 (mechanical, no new decision: the ambient hook context, the uniform sign-in failure as a returned `Response`, an unshed pre-dating link that `/link-social` cannot mark, the DAST link origin, the order of the `NODE_ENV=test` refusal, the repository's `member` delete and named exceptions, the parked pointers) | Context (ninth amendment), D2, D4 step 7, D13, D14, Observability contract, Risks, proposal, tasks 5.1b, 5.1c, 6.7b, 8.1e, 8.5g, 8.5h, 8.5j, 8.5k, 11.2, 13.4b, 13.5d, 13.8, 16.5 and the tasks header |
| Ninth-amendment questions 1 and 2: the actor of an acceptance and of the bootstrap (Q116), and which status changes `catalog.audit.user_status_changed` records (Q117) | D2, D4 step 3, D9, Observability contract, spec "Security-relevant events are logged", tasks 4.1e, 4.2b, 4.3, 4.4, 4.5, 4.6, 4.6b, 7.3, 8.1e, 8.2, 8.5b, 10.3, 11.2, 11.5, 13.3, 15.1, 15.6 |
| G10-1 a failure after the acceptance's `_user` step deleted a membership whose shed had run (Q118) | D4 step 4, Risks, spec "Invitation acceptance", task 8.1e; the never-retried case was the tenth amendment's Open Question 1, answered by Q122 (row below) |
| G10-2, drift D-2 and D-3: `_user` emails in Cerbos's decision log and in the catalog's HTTP spans (Q119) | D3, D16, Observability contract, spec "Telemetry contract", tasks 4.1d, 15.4, 15.5 |
| G10-3 the acceptance's shared context skipped every member, and a marker was written on any endpoint context (Q120) | D2, D4 step 7, spec "Invitation acceptance" and "An SSO link that its user did not make does not survive into a second tenant", tasks 8.1e, 8.5g, 8.5h |
| G10-4 the high `source-map-js` advisory on master (Q121) | Fixed outside this change (commit `c133f21`); task 16.9 |
| Tenth-pass consistency check (no new decision): a retry whose earlier attempt's shed removed a link revoked no session | D4 step 7, Observability contract, spec "An SSO link that its user did not make does not survive into a second tenant", task 8.5m |
| Tenth drift-check D-1 and D-4 (mechanical, no new decision: each job's own Cerbos sidecar at `CERBOS_ADDRESS`; the link procedures' account reads through `globalAccountByKey` and `globalAccountsOf` and the lint ban on the internal adapter's account reads) | Context (tenth amendment), D9, D12, D14, Gates, Migration Plan, tasks 2.0b, 2.2, 4.2b, 5.1b, 5.1c, 8.5l, 16.7, 16.8 |
| Tenth-amendment question 1: an existing-account attempt that fails after its `_user` step and is never retried left the session revocation and the admin notice undone (Q122) | Context (eleventh amendment), D4 steps 4, 6 and 7 and "Notice emails", D12, Observability contract, Risks, Tickets ("User notifications"), proposal, spec "Invitation acceptance" and "An SSO link that its user did not make does not survive into a second tenant", tasks 8.1e, 8.5b, 8.5h, 8.5k, 8.5m, 8.15, 16.5 |
| G11-1 an accepted invitation stayed `pending`, so it could be resent and cancelled, counted toward the pending limit and was replayed as `token_mismatch` (Q123) | D4 steps 1 and 5 and "Resend", D13, D14, proposal, spec "Invitation lifecycle", "Invitation acceptance" and "Disabling a human takes effect immediately", tasks 5.1b, 7.6, 7.7, 8.1e, 8.3, 8.10, 11.4, 11.4b |
| G11-5 the orphan grace period was measured from `createdAt`, so it did not protect a failed new-account acceptance of an invitation older than an hour (Q124) | D1, D12, Risks, proposal, spec "Every member has a `_user` row", tasks 4.2b, 16.5 |
| Eleventh drift-check N-1: Q119's positional ids contradict the existing case of `redaction.test.ts` (Q125) | Context (eleventh amendment), proposal, task 4.1d |
| G11-2 a Container Apps Job run may not complete while its Cerbos sidecar keeps running (mechanical, no new decision) | D9, Gates |
| G11-3 and drift N-5: the per-referrer `update` check of a delete (`mayUpdateReferrer`) sends a `_user` referrer's raw identifier to Cerbos (mechanical, within Q119) | D3, Observability contract, spec "Telemetry contract", task 4.1d |
| G11-4 the HTTP path test sends raw `@` paths only, not the `%40` that oRPC's generated client sends (mechanical, no new decision) | D16, spec "Telemetry contract", task 15.5 |
| G11-6 dev-toolchain advisories through `markdownlint-cli2` (outside `043`) | Tickets (TK11-1, "Dev-toolchain advisories"), task 16.9 |
| Eleventh drift-check N-2, N-3 and N-4 (mechanical, no new decision: the `UserSyncPort` input's `userId`, and for the `created_invited` write its optional `invitationId` (twelfth amendment), the shed record's delete-then-insert instead of an upsert, the new catalog `user-sync.int.test.ts`) | Context (eleventh and twelfth amendments), D2, D4 step 7, tasks 4.1, 4.1e, 4.4, 4.5, 7.3, 8.1e, 8.5m |
| Subject of the `created_invited` status event (Q126, a confirmation) | D2, Observability contract, proposal, spec "Security-relevant events are logged", tasks 4.1e, 7.3, 15.1 |
| Twelfth-amendment consistency check (no new decision): the `created_invited` write had no port field to carry the invitation id that Q126 names, and tasks 7.3 and 15.1 cited only Q117 for that subject | Context (twelfth amendment), D2, D4 "Hooks", tasks 4.1, 4.1e, 7.3, 15.1 |
| Twelfth-amendment consistency check (no new decision): the lost-race path also takes a concurrent cancellation (Q123), its rationale covers the cases with no winner (Q122), and a cancellation in that window leaves the join under a `cancelled` invitation | Context (twelfth amendment), D4 steps 1 and 4, Risks, task 8.1e |
| Twelfth-amendment question 1: a new-account consumption that changes no row after the `_user` step left an `admin` join with no notice (Q127) | Context (thirteenth amendment), D4 steps 4 and 6 and "Notice emails", Risks (with G12-2), Q122 annotated, proposal, spec "Invitation acceptance", tasks 8.1e, 8.15 |
| Twelfth-amendment question 2: the `pending` check of resend and cancel (Q123) is not atomic with the acceptance's conditioned write (Q128, a documented residual) | Context (thirteenth amendment), D4 "Resend", D13, Risks, Tickets (TK12-1, cross-referenced from TK9-2), Q123 annotated, proposal, spec "Invitation lifecycle"; no race case added (tasks 7.6, 7.7 and 8.10 cite the residual; 7.13, 11.4 and 11.4b unchanged by Q128), their hold released in the tasks header |
| Twelfth-amendment consistency check, second pass (no new decision): a lost race to consume the token had no stated answer or denial reason, the new-account compensation did not exclude it, the refused resend had no answer, and Open Questions 1 and 2 did not name every passage their answers change | Context (twelfth amendment), D4 steps 3, 4 and 5 and "Resend", Observability contract, Open Questions 1 and 2 (since answered by Q127 and Q128 and removed from Open Questions; Resolved decisions Q127 and Q128 and the "Twelfth-amendment question" rows above name their passages), spec "Invitation lifecycle" and "Invitation acceptance", tasks 7.7, 8.1e, 8.3, 8.5m, 8.7, 8.10, 8.15, 15.1 and the tasks header |
| Twelfth-amendment question 3: what an admin's cancel of an invitation that is not `pending` answers (Q129) | Context (thirteenth amendment), D4 "Resend", Q123 annotated, proposal, spec "Invitation lifecycle", tasks 7.6, 8.10 |
| Twelfth-amendment consistency check, third pass (no new decision): a compensated new-account failure after the `_user` step leaves an `Active` `_user` with no membership, which only a failed compensation was said to leave; the proposal missed the lost-race exception, the condition of the session revocation and Open Question 3; Open Question 2 did not name the proposal and misquoted the spec; task 7.6 waited for Open Question 3 only; task 6.5 cited Q67 alone | Context (sixth and twelfth amendments), D4 step 3, Security considerations, Open Question 2 (since answered by Q128 and removed from Open Questions; Resolved decision Q128 and the "Twelfth-amendment question 2" row above name its passages), proposal, spec "Invitation acceptance", tasks 6.5, 7.6, 8.1e |
| Twelfth drift-check N12-1: Q119's positional ids contradict the catalog's `002` redaction fixture and three catalog integration tests, beside the unit test of Q125 (Q130) | Context (thirteenth amendment), Q125 annotated, proposal, task 4.1d |
| Twelfth drift-check N12-2 and N12-3 (mechanical, no new decision: the `_user` step calls the adapter directly but `upsertUser` returns `void`, so nothing said whether the attempt activated the row; `refreshDisplayData`, the `upsertUser` caller in `auth.ts` beside the hooks, was not named as a source of `userId`) | Context (eleventh and thirteenth amendments), D2, D4 steps 4 and 6, tasks 4.1, 8.15 |
| G12-1 a cancellation that commits between the token check and the consumption leaves a join that no acceptance committed, and nothing alerts on its `consume_conflict` denial (mechanical, no new decision) | Context (thirteenth amendment), Risks, Tickets ("Alerts for `010`", pointing at TK12-1) |
| G12-2 an attempt compensated on the new-account path whose retry runs the existing-account path, because an account for the email was created meanwhile, sends no admin notice (a residual of Q127) | Context (thirteenth amendment), D4 step 6, Risks |
| G11-2 follow-up (twelfth pass, mechanical, no new decision): the fallbacks to a per-job Cerbos sidecar put the simpler ones first, Cerbos as a child process in the job container or Cerbos over TLS, and the script ending the replica last | Context (thirteenth amendment), D9, Gates |
| Thirteenth-amendment consistency check (no new decision): the viewer page was a literal 200 against a configurable cap; the spec's admin-notice MUST omitted Q127's residual; the Non-Goals list of edited `002` code missed later decisions; the kill switch's revision property was not in the file D4 names; task 10.7 used 10.7b's resolver before it exists; two coverage rows pointed at removed Open Questions | Context (thirteenth amendment), Goals / Non-Goals, D4 step 2, D7, D12, Q85 annotated, this table, proposal, spec "Invitation acceptance", tasks 9.2, 10.7, 16.5 |
| Thirteenth-amendment consistency check, second pass (no new decision): D12 and task 16.5 cited Q67 and Q96 but not Q99 for the allowlist (as did task 6.5b and D5 "Sender selection"); task 4.6b named no roles for the role assertion of task 2.0; the Q6 row listed a high-risk set that D10 contradicts | Context (thirteenth amendment), D5, D9, D12, Q6 annotated, tasks 4.6b, 6.5b, 16.5 |
| Thirteenth-amendment consistency check, third pass (no new decision): tasks 4.1 and 4.1e asserted code of 4.2 (the entry point's result for the `membership_added` intent and the membership hook's `userId` subject); a concurrent new- and existing-account attempt can each send the admin notice, which neither Risks nor the proposal's "once" named; the Q123 row said it did not interact with Q122 although its zero-row `accepted` write takes Q122's lost-race path and sends Q127's notice; task 8.10 asserted the refusals only for an accepted invitation | Context (thirteenth amendment), D4 step 6, Risks, Tickets (TK12-1), Q123 annotated, proposal, spec "Invitation acceptance", tasks header, 4.1, 4.1e, 4.2, 8.10 |
| Thirteenth-amendment consistency fix C-1 (no new decision): `toCerbosRole` was exported only from `context-resolver.ts`, which `apps/api` cannot import because `@tayzu/auth`'s `exports` map has no entry for `context-resolver.ts` (only its index and, from task 9.1c, the `machine-credentials` subpath of Q78) (`isIdle` is already exported by `session-idle.ts` and gains only its package-index export) | Context (fourteenth amendment), Goals / Non-Goals, D4 step 2, proposal, task 8.5f |
| Thirteenth-amendment consistency fix C-2 (no new decision): the spec, the Observability contract, task 4.1d and the Q119 row read as if the redaction batch (of one candidate or several) kept other blueprints' identifiers, against Q130's positional rewrite of `service`-blueprint batches; the Q119 annotation must keep the routes' meaning of "other blueprints keep their identifiers" | Context (fourteenth amendment), Observability contract, Q119 annotated, spec "Telemetry contract" (the requirement and the scenario "A `_user` email never reaches the Cerbos decision log"), task 4.1d |
| Thirteenth-amendment consistency fix C-3 (no new decision): "it decides by position" read as a positions-only set or an index-based fixture would deny the delete's own check on `team-a`, which keeps its identifier, so the delete would fail with `AUTH_FORBIDDEN` instead of `CATALOG_REFERENCE_VIOLATION` and the red step for the wrong reason; the fixture's only edit is its header comment (`:6-10`), which said that the operation's own check keeps hitting the real policies | Context (thirteenth and fourteenth amendments), Q130 annotated, proposal (What Changes and Impact), task 4.1d |
| Thirteenth-amendment consistency fix C-4 (no new decision): no task asserted that the `user_created` cancellation skips an invitation that is not `pending` (the assertion is scoped to the reason `user_created`, because the earlier cancel of 7.6 logs its own `invitation_cancelled`) | Context (fourteenth amendment), spec "Invitation lifecycle" (scenario "Creating a user cancels a pending invitation of the same email"), task 7.13 |
| Thirteenth-amendment consistency fix C-5 (no new decision): task 8.2 said every failure is compensated and leaves the token unconsumed, against the lost consume race of D4 steps 3 and 4, 8.1e and Q127 | Context (fourteenth amendment), task 8.2 |
| Thirteenth-amendment consistency fix C-6 (no new decision): TK12-1 claimed to close the whole G12-1 cancel race, whose `re_invite` variant Better Auth makes outside the lock | Context (thirteenth and fourteenth amendments), Risks, Tickets (TK12-1 and "Alerts for `010`"), Q128 annotated |
| Thirteenth-amendment consistency fix C-7 (no new decision): the Q127 row, the thirteenth amendment's first bullet and the first pass of its consistency check named two residuals, while D4 step 6, Risks, the spec and TK12-1 name three | Context (thirteenth and fourteenth amendments), Q127 annotated |
| Thirteenth-amendment consistency fix C-8 (no new decision): the Observability contract did not name `002`'s `auth.security.login_failed`, whose reason `account_disabled` the uniform banned sign-in logs | Context (fourteenth amendment), Observability contract |
| Thirteenth-amendment consistency fix C-9 (no new decision): the record of Q128 said that no task changed, although tasks 7.6, 7.7 and 8.10 cite its residual | Context (thirteenth and fourteenth amendments), this table, Q128 annotated, tasks header |
| Thirteenth-amendment consistency fix C-10 (no new decision): the proposal stated the service-account and credential caps as fixed maxima, although both are configurable defaults (Q56) | Context (fourteenth amendment), proposal |
| Thirteenth drift-check N13-1 and thirteenth-pass VCDM G13-1 (mechanical, within Q130): hard-coded readable positions would be flaky in `blueprints-update.int.test.ts`, whose `seedEntity` rows get `randomUUID()` ids and whose candidates stream `order by id` | Context (thirteenth and fourteenth amendments), Q130 annotated, task 4.1d |
| Thirteenth drift-check N13-2 (mechanical, within Q130; the same issue as C-3): the redaction fixture also answers the operation's own single-resource check, so the readable set keeps `team-a` beside the positions | Context (fourteenth amendment), Q130 annotated, proposal, task 4.1d |
| Thirteenth drift-check N13-3 (mechanical, no new decision; the same issue as C-1): `toCerbosRole` is private to `context-resolver.ts` and must also reach the package index | Context (fourteenth amendment), Goals / Non-Goals, D4 step 2, proposal, task 8.5f |
| Thirteenth-pass VCDM V13-note (mechanical, no new decision): a Cerbos child process inside a job container stays pinned to the sidecar's image digest and is tracked by task 13.12's Dependabot, and its policy bundle is the `apps/api` revision's, shipped through the SHA-pinned pipeline (`002` SEC13) | Context (fourteenth amendment), D9, Gates |
| Fourteenth-amendment consistency check (no new decision): the tasks header did not cite task 7.13 under Q129 (the `user_created` skip; of the internal cancellations, Q123 names only `user_disabled` and `inviter_disabled`); "`@tayzu/auth` exports only its index" contradicted the `machine-credentials` subpath of Q78 (task 9.1c); the THEN line of the spec scenario on the `user_created` cancellation did not say which `t1` invitation it meant once a non-pending one was added; task 4.1d's lead-in, the tasks header, the proposal's G13-1 line and the Q125 annotation still said the fixture was rewritten; task 4.1d's Verify clause did not say "whatever their blueprint" for a blocked delete | Context (fourteenth amendment), findings-to-coverage table (row C-1), Q125 annotated, proposal, spec, tasks header, task 4.1d, task 7.13 |
| Fourteenth drift-check N14-1 (mechanical, within Q130): the header comment prescribed for the redaction fixture (Context, Q130 annotated, proposal, task 4.1d) said only that it also answers the operation's own check (the fixture's current header, `:6-10`, says that check keeps hitting the real policies), not that it answers an entity operation's own check and `mayUpdateReferrer`'s by identifier (the fixed placeholder for a `_user` entity, Q119) and the redaction batch by position, while a blueprint operation's own `catalog_blueprint` check still reaches the real policies | Context (fourteenth amendment), Q130 annotated, proposal, task 4.1d |
| Fourteenth drift-check N14-2: the uniform banned sign-in logs `account_disabled` (C-8), but the `002` smoke check drove no banned sign-in, and its assertion at `apps/api/src/otel-smoke-check.int.test.ts:1008-1012`, the exact set `{bad_credentials, mfa_failed}`, did not require that declared value; it becomes the exact set `{bad_credentials, mfa_failed, account_disabled}` (Q131) | Context (fourteenth amendment), this table, Observability contract, Q74 annotated, Open Questions, proposal, spec "Telemetry contract", tasks header, tasks 1.1, 1.2, 13.4b, 15.1 and 15.2 |

| Section                 | Applies                | Posture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC01 Diagram           | Yes                    | New external actors (the email provider; the invitee with their mailbox; the platform operator) and new arrows (invite→email, the public accept route, ACS egress over HTTPS, the Pwned Passwords range query, the backfill and reconcile jobs with their Cerbos sidecars) added to `docs/architecture/system-diagram.md` (tasks 16.7, 16.13).                                                                                                                                                                                                                                                                                                                                                                                                 |
| SEC02 Attack surfaces   | Yes                    | Fourteen routes (D10), each with its actor, authentication (session, step-up-verified session, or none for the public accept route) and Cerbos check named in `docs/security/attack-surfaces.md` (task 16.6). The native Better Auth `inviteMember` and `accept-invitation` routes stay off `002`'s allowlist (D18 there). The accept route is the first unauthenticated route and a plain Fastify route: it derives the tenant from the invitation, is rate-limited, reads a session only for an existing account (with the CSRF header and its own `Origin` check), validates its body as an allowlist, never reveals why it failed, and sits behind the mount gate (D15).                                                                                                                                                       |
| SEC03 Access control    | Yes, core              | Every operation Cerbos-gated to `admin` (D3) with the target's real tenant; targets resolved server-side (D14); self-status-change denied; step-up on every high-risk operation (D10); invited role limited to `member`/`admin`; service accounts held to `member` by signed claim, creation validation and a Cerbos deny (D6), and every service-account route refusing a human target (Q62); an invitation is re-checked against its inviter's authority at acceptance, by Cerbos (Q63, Q108); a credential records its creator; an SSO link its user did not make is shed, and the user's sessions are revoked, when the user joins a second tenant, with positive provenance and a per-user lock (Q73, Q86, Q87), and an admin cannot record a link on an admin or an owner (Q88); the `_user` of a joined tenant is activated only after the shed (Q112), and a sign-in never activates a second tenant's row (Q111); disabled users and service accounts rejected within seconds, a human tenant-scoped so a member of two tenants can be off-boarded by either and admitted only when `Active` in the tenant (D13, Q105). Off-boarding is `Disabled`; role change and member removal are deferred (Non-Goals).  The human attestations (off-boarding procedure, training, access review) are deferred to `010`'s SSA (Resolved decision Q17). |
| SEC04 Password storage  | Yes                    | The acceptance flow is the first place a password is set outside sign-in: it applies the password policy (20-128 characters, every class, no harmful characters, a denylist, NFC-normalized at every password-verifying entry point; Q22) and the breached-password check (Q23), the hash is Better Auth's scrypt (`002`), and a token is required before any password is read. Service-account credentials reuse `002`'s API-key hashing.                                                                                                                                                                                                                                                                                                                                                                                        |
| SEC05 Crypto            | Partial                | The invitation token is 256 bits from a CSPRNG, stored only as a sha256 digest and compared in constant time (D4); `docs/security/crypto-inventory.md` also lists the SHA-1 prefix of the breached-password range query, the HMAC-SHA256 of the per-recipient cap key (Q93) and the ACS authentication; the SHA-1 prefix is a protocol-mandated exception (Q81): only five hex characters leave, SHA-1 is not used for storage or authentication, and an offline corpus is a ticket; credential secrets are hashed by `002`'s mechanism; TLS to Azure Communication Services is provider-managed. The token generator is ours, so no Better Auth invitation-id entropy claim is relied on.                                                                                                                                                                                                                                                                                              |
| SEC06 Misuse            | Yes                    | Dead invitations never succeed; acceptance errors are indistinguishable; a `Disabled` user cannot be revived by sign-in, acceptance or a hook (D2); re-invite cancels the previous invitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SEC07 Dependencies      | Yes                    | `@azure/communication-email` joins the Dependabot/`pnpm audit`/quarterly-EOL process; license, `allowBuilds` and SBOM review are recorded in `docs/security/dependencies.md` (task 1.3). The high `source-map-js` advisory that failed `pnpm audit` on master is fixed outside this change by a `pnpm.overrides` entry, recorded in the same file (Q121, task 16.9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC08 File upload       | N/A                    | No file upload surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SEC09/SEC10 Secrets     | Yes                    | The Communication Services connection string is a new Key Vault secret on a dedicated send-only ACS resource, with a change procedure in `docs/security/secrets.md`; a managed identity is a first-deployment gate (Q28). The `tayzu_auth` secret of the backfill and reconcile jobs is documented with owner and rotation, each job with its own identity and neither holding `BETTER_AUTH_SECRET` (the reconcile's shed is SQL on its `tayzu_auth` pool, Q114), and so is the `IDENTITY_TOKEN_HMAC_SECRET` of the cap keys (Q93).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC11 Phishing          | Yes, core new exposure | 48h expiry, one link, fixed subject and template with no tenant or inviter free text, link origin from `INVITATION_LINK_BASE_URL` only (Q32), exactly one recipient and no CC/BCC/attachments, ACS tracking disabled and no Reply-To, per-tenant, per-recipient and global caps (D4, D5); a second fixed notice tells the other admins, `Disabled` ones included, when an `admin` invitation is accepted (Q39); a real sender needs a mandatory recipient-domain allowlist under `NODE_ENV=test` and honors it wherever it is set (Q67, Q96, Q99), and a tenant on `EMAIL_DISABLED_TENANT_IDS` (a demo tenant) sends nothing (Q80); the notices share the kill switch, count in a per-recipient bucket of their own (Q101) and have a per-tenant notice cap and at most 20 recipients per notice (Q53). The SSA answers are Resolved decision Q34: one clickable link, unavoidable for a no-account invitee and mitigated by the fragment token, single use, 48-hour expiry and the configured origin; no attachments; only the recipient varies.                                                                                                                                                                                                    |
| SEC12 Testing           | Yes                    | Every requirement has a scenario-backed test; every route a cross-tenant test; `cerbos compile` gates policies. The identity OpenAPI document has no request schemas (Q52), so a scan of it has limited value until schemas exist. The OpenAPI-driven ZAP scan (`002` NB1) would hit `rotate`, `revoke` and `invite` (and `045`'s `organization.delete`), so it needs a sandbox tenant, a non-sending email sender and a destructive-route exclusion; because the switch is off by default, a sandbox scan with the switch **on** is required before the first deployment (ticket and gate, Risks).                                                                                                                                                                                                                                                                                                                                                               |
| SEC13 Deployment        | Partial                | The Communication Services connection string via Key Vault reference, `INVITATION_LINK_BASE_URL`, `INVITATION_EMAIL_KILL_SWITCH`, `MOUNT_IDENTITY_ROUTES`, and one Container Apps Job per maintenance script (Q49), the backfill and the reconcile, started by an operator under just-in-time access with a named second approver (D9; `045` adds the purge job and the reviewed `workflow_dispatch` workflow of Q41), so nothing runs against production from a workstation, except the bootstrap CLI, which an operator runs out of band as `002` designed it (Q91); a deployed environment fails startup without an explicit `EMAIL_PROVIDER` (Q96). |
| SEC14 Infra permissions | Yes                    | One migration (Checkpoint 3): `0011` (composite key); `045` owns `0012` to `0014` and the purge role (Q103). No `SECURITY DEFINER` function is created here (`045`'s Q48 also avoids one for the purge). The startup assertion on the runtime roles also fails when one owns `machine_credential_revocation` (Q109, task 11.1c). |
| SEC15 Network/host      | Partial                | Two new outbound calls, both HTTPS: Azure Communication Services, and the Pwned Passwords range query to `api.pwnedpasswords.com` (only the first five hex characters of the SHA-1 leave the system, Q23), plus the sender-domain DNS (SPF, DKIM, DMARC), recorded as egresses in the system diagram. ACS data location and retention are stated in `docs/security/data-retention.md`. DNS DDoS protection is deferred to `010`'s SSA (Q17).                                                                                                                                                                                                                                                                                                                                                                                      |
| SEC16 Logging           | Yes                    | Twenty-seven new log events (plus the reused `catalog.security.authz_denied`) in the contract, all sampling-exempt, opaque ids and enums only, with `tayzu.actor.id` pinned to the admin for every operation an admin initiates and every other audit event naming the principal who acted (the reconcile and the bootstrap record the operator id, the acceptance the invitee, and every status change its writer's principal and its bounded status event, Q116, Q117); `catalog.security.authz_denied` is emitted from the identity router; no identifier in a URL path reaches telemetry (D16), the catalog's `_user` routes included, and no `_user` email reaches Cerbos's decision log (Q119).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Divergences from Port (deliberate)

| Topic                              | Port                                                                   | Tayzu 043                                                                                                              | Why                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Invite/status-change authorization | Gated on request _origin_ (UI/API)                                     | Gated on Cerbos role (`admin`)                                                                                         | `project.md`'s "actor.type/origin never selects a code path" invariant (D3, ADR-0020)                             |
| Service-account identifier         | Real-looking email at a reserved domain (`serviceaccounts.getport.io`) | `^svc-...` non-email identifier                                                                                        | Tayzu's `_user.identifier` is not required to be email-shaped; avoids a lookalike-phishing surface (D6, ADR-0017) |
| Credential rotation                | Undocumented beyond "rotate if exposed"                                | Explicit immediate cutover through the revocation list, 90-day documented rotation cadence                             | Port leaves this as a gap (`r1-port.md` §8.1); Tayzu specifies it fully (D8, ADR-0018)                            |
| "View as" a different user         | Documented, admin-only                                                 | Not built in this change                                                                                               | Explicitly later-UI (`003`/`014`), not dropped                                                                    |
| Support-user audit exemption       | _"Support user actions are not logged"_                                | No such exemption anywhere in Tayzu                                                                                    | Every administrative action, including Tayzu's own operators, is logged uniformly (SEC16)                         |

## Risks / Trade-offs

- [Credential rotation has no grace period (D8); an integration polling with
  the old credential breaks within seconds of the rotation] → Documented in
  the rotation UX copy and `docs/security/data-retention.md`; revisit with a
  scheduled hard-revoke only if a real Phase-1 integration needs it.
- [The per-recipient cap across tenants is a weak oracle and a
  denial-of-invitation vector: an admin sees `AUTH_RATE_LIMITED` for an address
  that other tenants invited three times, and one tenant can exhaust the cap for
  a victim address] → Accepted and documented; the response is the same one a
  tenant cap gives, and the signal reveals no tenant. `+` aliases cannot bypass
  it (Q33). The kill switch is an environment variable, so flipping it needs a
  new revision; the emergency procedure is in `docs/security/secrets.md`. Ticket
  to revisit.
- [A new-account `admin` invitation is protected only by mailbox control at
  acceptance: a mistyped or hijacked address yields a tenant admin who then
  enrols their own factor] → Accepted (Resolved decision Q39); the other admins
  are told by a fixed-template notice the moment an `admin` invitation is accepted,
  through the notice controls of D4 step 6 (the kill switch, the caps and at most 20
  recipients, Q53).
- [A tenant admin can create a global account for any email with a temporary
  password they know (account squatting), now reachable over HTTP] → Ticket.
- [Step-up is keyed on the route, so a per-role step-up (admin invite only)
  would need a body-aware guard] → Resolved decision Q19: `invite` is high-risk
  for every role, so no body-aware guard is needed.
- [An SSO-only invitee] → `002` Q72: an organization that wants to invite someone
  who will only ever use Visma Connect is unsupported until `025`; they need a
  local password first, then link through `/link-social`. An invitee who already
  has an account accepts with their session (Q18, Q24). A service account has no
  Visma account to link and needs no change.
- [The invitation link is inert until `003` builds the accept page (Q32)] →
  Documented in `docs/security/attack-surfaces.md`; the mount switch stays off
  until then, and turning it on is a first-deployment gate.
- [An admin who is the only administrator can be disabled, or can disable another
  admin] → Last-active-admin protection is a ticket (the part about org deletion is
  `045`'s).
- [Raising the password minimum from 8 to 20 (Q22) breaks `002`'s test fixtures,
  and the breached-password check (Q23) fails closed when the Pwned Passwords
  service is unreachable, so no password can be set during an outage] → The
  fixtures are updated in task 8.1c and the breached-password check is stubbed for
  every integration test in task 8.1a; the outage behavior is the decided one and
  is documented.
- [A member can be left with no `_user` row (a member that predates `043`, or a row
  removed by hand) and is then rejected by the resolver] → Fail closed by decision
  (Q46); the repeatable reconcile of D1 (Q50) is the repair path and runs before the
  first deployment. An acceptance never leaves one: its `_user` write fails closed and the
  attempt compensates (Q89).
- [A failed acceptance can leave an orphan `_user` or, if its own compensation fails,
  a user with no membership, or, on the existing-account path, a membership whose
  compensation failed (Q105), because no transaction spans the two pools (Q89); an
  `Active` orphan would block a later invitation of the same email] → The reconcile
  removes the orphan `_user` after a one-hour grace period (D1, Q84), measured from the
  row's `updatedAt`, its activation, so that a retry in flight is protected even for an
  invitation older than an hour (Q124); a stranded user
  and a membership left by a failed compensation are an operator repair driven by the
  alert on `invitation_accept_compensation_failed` (Q100). A membership left by a failed
  existing-account compensation can carry an unshed SSO link and live sessions, but since
  Q112 the acceptance activates the `_user` only after the shed, so when the shed or the
  `_user` step was the step that failed the `_user` is still `Invited`: the resolver
  rejects the member in that tenant (Q105 part 3) and the first-sign-in hook does not
  activate the row for a user of two or more tenants (Q111), so the "shed failed, then
  compensation failed" double fault is fail-closed. (Since Q118, on the existing-account
  path, a failure after the `_user` step, the `emailVerified` write or the consumption
  of the token, compensates nothing: the membership and its `Active` `_user` stay, the
  shed has already run, the token stays valid and a retry with it completes the
  acceptance; since Q122 the session revocation and the admin notice owed to the join
  have run as soon as the `_user` step ran, so such an attempt that is never retried
  leaves only the `emailVerified` write and the consumption of the token undone.) The
  repair is a retry of the same invitation within its 48 hours, which sheds on every
  attempt and then activates the row, or Q100's operator repair, which removes the
  membership and ends the member's access to that tenant, after which the invitee can be
  invited again and that acceptance runs the shed with its session revocation (Q105 part
  2); a new invitation (Better Auth refuses one to a current member), the membership hook
  and the reconcile do not reactivate an existing membership (Q111).
- [The inviter check reads membership and `banned` from `tayzu_auth` and the `_user`
  status from `tayzu_app`, and asks Cerbos (Q108), with no transaction around the acceptance (Q89)] → A race of
  a few seconds at most: an inviter disabled between the check and the consumption of
  the token can still be accepted. Accepted and documented (D4 step 2); the cancellation at disable time (D13) and the
  rejection at the resolver bound it.
- [A cancellation (an admin's, `re_invite`, `user_disabled`, `inviter_disabled` or
  `user_created`) that commits between the token check and the consumption makes the
  acceptance's `accepted` write change no row, so the attempt fails as a lost race and
  keeps what it did (Q123): the membership and the `_user` it activated (on the
  new-account path, the user too) stay, under a `cancelled` invitation] → Documented; it
  follows from Q123's lost-race handling, in a window of the same few seconds as the
  inviter race above, which already covers `inviter_disabled`. A disable still writes
  `Disabled`, which no acceptance step revives (D2), so a `user_disabled` race leaves a
  member that the resolver rejects; after an admin's cancel or a `re_invite`, an admin
  who wanted the join stopped disables the member. Each such attempt logs
  `catalog.security.invitation_acceptance_denied` with the reason `consume_conflict`,
  which the ticket "Alerts for `010`" alerts on, and the structural fix is ticket TK12-1
  ("Serialized invitation writes") (except for the `re_invite` cancellation, which keeps
  its window, Q42) (twelfth-pass VCDM G12-1). Such a join of an `admin` invitation is
  still announced on either path: on the existing-account path the attempt whose `_user`
  step activated the row has already sent the admin notice (Q122), and on the new-account
  path the attempt sends it when its consumption changes no row (D4 step 6, Q127). The
  opposite order, a
  cancel or resend that read `pending` before the acceptance committed and writes after
  it, is the next bullet (Q128).
- [A cancel or a resend that read `pending` just before an acceptance committed writes
  after it, because the `pending` check of resend, the admin cancel and the
  `user_created`, `user_disabled` and `inviter_disabled` cancellations is a read before
  the write, not atomic with the acceptance's conditioned `accepted` write (Q123), and
  Better Auth's `cancelInvitation` updates the status with no condition: the cancel
  overwrites `accepted` with `canceled` and logs `catalog.audit.invitation_cancelled`,
  and the resend mints a token for an accepted invitation and emails it, against the
  skips of Q123 and the refusal of Q129. Better Auth's own re-invite cancel
  (`cancelPendingInvitationsOnReInvite`, Q42) writes `canceled` with no condition after
  its own read, so it has the same window] → Accepted and documented (Q128; D4
  "Resend"): the window is the gap between one read and one write of an operation that
  lands within one acceptance; it never reaches the membership or the `_user`; a token
  minted in it cannot be used, because the acceptance refuses an invitation that is not
  `pending` (D4 step 5); and what it leaves, a stray email to the invitee or an
  `invitation_cancelled` record beside the `invitation_accepted` of the same invitation,
  is in the audit log. The spec's skips and refusals hold except for a cancel or resend
  that races the consumption. The structural fix is ticket TK12-1 ("Serialized invitation
  writes"): one per-invitation lock, extending TK9-2's, that would close this window, the
  cancel race of the bullet above (twelfth-pass VCDM G12-1) except for its `re_invite`
  cancellation, and TK9-2, at the cost of one
  `tayzu_auth` connection per in-flight acceptance; the re-invite cancel keeps its window
  either way.
- [Every SSO link without a provenance marker is deleted, and the user's sessions are
  revoked, when the user joins a second tenant (Q73, Q86, Q87), so a legitimate
  multi-tenant SSO user loses a link made before this change and signs in again on
  every device, the one that accepted included (Q106)] → The user re-links through `/link-social`, which requires step-up; the shed event is the audit trail; a notice
  to the user on an admin link, unlink or shed is a ticket. A pre-dating unmarked link of
  a user who already belongs to two tenants is shed by no path, so the callback check
  (Q106) refuses every SSO sign-in through it, and `/link-social` cannot add the marker
  (it updates the existing row of the same `sub` and user and creates none): the runbook
  repair is an unlink, then a link (D4 step 7, task 16.5). The impact is limited, because
  no users exist before `010` (`002` Q78).
- [`auth.member` has no `UNIQUE (organization_id, user_id)`, so a concurrent acceptance
  and `addMember` could create two rows for one user, and the resolver's `memberRoleOf`
  reads one] → Ticket "Member uniqueness" (a migration, Checkpoint 3); the idempotent
  `addMember` step of the acceptance (Q89) narrows the window.
- [The notices consume a per-recipient bucket (Q53; since Q101 their own, not the
  invitation one): an admin who already got three notices in the window does not get
  the next one, and a notice that exceeds a cap is dropped] → Accepted; the operation is
  never blocked and the drop is logged as `catalog.security.notice_suppressed`. The kill switch stops every
  email, so flipping it also stops the notices (and `045`'s deletion notice).
- [On the existing-account path the admin notice is sent by the attempt whose `_user`
  step activated the row, right after that step (Q122), so a crash between the
  activation and the notice loses the notice: a retry's `_user` step writes nothing and
  sends none] → Accepted and documented (Q122): the window is two consecutive steps of
  one request, and the activation itself is still audited by
  `catalog.audit.user_status_changed` with the status event `invitation_accepted` (Q117).
  Sending the notice after the commit instead would lose it for every attempt that fails
  after its `_user` step and is never retried (Q118), which is the case Q39 exists for.
- [On the new-account path the admin notice is sent after the acceptance commits or when
  its consumption changes no row (Q127), so a crash between that zero-row consumption and
  the notice loses the notice, as in Q122; and an attempt compensated on the new-account
  path (its `_user` step activated the row, which the compensation keeps, D4 step 3)
  whose retry runs the existing-account path, because an account for the email was
  created meanwhile (by another tenant's acceptance or by `identity.users.create`), sends
  no notice, since the retry's `_user` step finds the row `Active` and writes nothing
  (twelfth-pass VCDM G12-2); and a new-account attempt and a concurrent existing-account
  attempt of the same invitation (the invitee signing in with the password the first
  attempt set, before that attempt's `_user` step) can each send the notice, a harmless
  duplicate: the second attempt's `_user` step activates the row and sends it (Q122), and
  the first sends it again when it commits or when its consumption changes no row
  (Q127)] → Accepted and documented (Q127): the first window is two consecutive steps of
  one request; the second needs a failure of the consumption that is not a lost race,
  then an account created for the same email before the retry, and an attacker cannot
  cause the failure; the third needs the invitee's own concurrent sign-in and costs each
  recipient one extra copy of the fixed notice, and the per-invitation lock of ticket
  TK12-1 would close it. In all three the activation is still audited by
  `catalog.audit.user_status_changed` with the status event `invitation_accepted` (Q117).
- [The invitation caps are stricter than their nominal rate (Q66): `002`'s store
  resets a bucket only after a full window with no allowed request, so a slow
  trickle never resets it] → Accepted and documented in
  `docs/security/data-retention.md`; a test pins the slow-trickle case; no
  migration. A window-start column would be a later change.
- [Any tenant's admin can drain a victim admin's per-recipient bucket with three
  invitations and so suppress their admin-accepted notice, and `045`'s deletion notice (the shared
  bucket of Q53 is now attacker-controllable)] → Closed by Q101 (task 6.12b): the
  notices count in a bucket of their own (scope `notice_recipient`), so invitations no
  longer drain it; only notices of a tenant where the person is an administrator count
  toward it, and a drop is still logged.
- [A disabled admin's service accounts and credentials stay valid, and the creator
  was visible only in change events and logs] → The key metadata records
  `createdBy` and the viewer shows it (D7); the off-boarding step in the runbook
  lists them by creator; a creator filter is a ticket.
- [A real email sender outside production could relay phishing through a known
  demo login (Q67)] → A recipient-domain allowlist is mandatory for a real sender
  under `NODE_ENV=test` and is honored wherever it is set (Q67, Q96, Q99); demo tenants are kept off a real sender by `EMAIL_DISABLED_TENANT_IDS`
  (Q80); CI and DAST use the non-sending sender.
- [The reconcile and the blueprint backfill list organizations and members
  through `tayzu_auth`, which has full CRUD on every tenant's auth data] → Each
  script is its own Container Apps Job with its own identity (Q49) and runs as an
  operator-started job under just-in-time access (D9; `045` puts it behind a reviewed
  workflow); a read-only role is a ticket and applies to the backfill only, because the
  reconcile also runs the shed (deletes `account` rows and their `verification` markers,
  revokes `session` rows and takes the advisory lock, Q105). Neither job holds
  `BETTER_AUTH_SECRET`: the reconcile's shed is parameterized SQL on its `tayzu_auth` pool
  and it builds no Better Auth instance (Q114).
- [Until `045`'s workflow lands, the operator id of the backfill and the reconcile is
  whatever the operator who starts the job sets, not an authenticated identity] →
  The named second approver and the Azure PIM record are the control (D9); `045`
  derives the id from the workflow's authenticated actor (Q41, Q70).
- [The identity OpenAPI document has no request or response schemas (Q52), so a
  DAST scan of it exercises paths and methods but not meaningful bodies] →
  Documented; the scan still checks authentication and routing, and schemas arrive
  with a later change that names the dependency.
- [Drift between this design and `002`'s implementation by the time `043`
  starts implementation] → Checked against the merged code on 2026-10-01 (task
  1.1); the findings are in the Context.
- [Sending a real invitation email in integration tests would be flaky and
  slow] → `EmailSender` is faked in every test except a single, explicitly
  optional manual smoke check against a real Communication Services sandbox
  (not part of CI).

### Hand-offs from `002` (`002` Q73): traceability

`002` design Q73 hands this change the items M5, M9-M15 and M17-M20 of `002`'s
VCDM re-assessment of 2026-10-01. M4 is **not** in `002`'s list; this change closes
it anyway (task 13.6), because it is the check-then-act of the catalog pipeline that
the identity operations share, and it is recorded here for traceability. The item
descriptions are recorded here so that the gate can be checked against the
repo. Every item is either a task in group 13 (or another named task) or an
explicit deferral with its justification. The items closed by group 13 are behind the
rule "no mount before group 13 is done"; the ones closed, wholly or in part, by named
tasks outside group 13 (M5: 8.1-8.1d; M9: 11.1, 15.6; M13: 6.10, 8.13; M19: 16.7,
16.13; M20: 11.2) are Checkpoint 2 items too: those numbered before group 13 run before
it in file order, and those after the mount group 14 (15.6, 16.7 and 16.13) gate the
switch through the first-deployment gates.

**Numbering.** `002`'s design was written before the Q103 split moved the old group 12
(org deletion) out of this file, so its references to this change's tasks are one group
off: "`043`'s group 14 (hand-offs from `002`)" in `002` Q73 and in `002`'s residual risks
is group 13 here, and "`043` task 14.2" in `002` Q84 (the multi-tenant identity case) is
task 13.2. Group 14 here is the mount group. `002` is not edited; this note is the
mapping. The migrations were not renumbered.

| Item | What it is                                                                                                                                                                                  | Where it is closed                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4 (not in `002`'s list; closed here) | Attributes are loaded and authorized in one transaction and the write runs in another (check-then-act)                                                                                      | Task 13.6                                                                                                                                                                                                                                                                                                                                                                                                         |
| M5   | Password policy: the minimum was 8, no breached-password check, only a rate limit                                                                                                           | Resolved decisions Q22, Q23; tasks 8.1, 8.1a, 8.1b, 8.1c, 8.1d, 13.5b                                                                                                                                                                                                                                                                                                                                             |
| M9   | Composite `(tenant_id, credential_id)` key, credential routes behind Cerbos, create/link existence oracles, the `002` Q42 audit events                                                      | Tasks 11.1, 13.1, 13.3, 15.6                                                                                                                                                                                                                                                                                                                                                                                      |
| M10  | Identity operations assume one tenant per user; a two-tenant user lets an admin link an SSO `sub` and take the account over                                                                 | Task 13.2 (D14)                                                                                                                                                                                                                                                                                                                                                                                                   |
| M11  | Temporary passwords have no forced change or expiry                                                                                                                                         | Tasks 13.5 (the forced change) and 13.5d (the expiry) (Q36); 13.5b is M5's generator                                                                                                                                                                                                                                                                                                                                                                                        |
| M12  | `NODE_ENV=test` relaxes the https, role-assertion and OTLP guards                                                                                                                           | Task 13.8                                                                                                                                                                                                                                                                                                                                                                                                         |
| M13  | Per-replica in-memory limiters; the re-auth callback has no limiter and deletes a row per hit; `reauthorization.start` inserts a row per blocked attempt                                    | Tasks 13.9 (the callback) and 13.9b (`start`); the invitation caps and the accept route use the DB-backed store (6.10, 8.13); **deferred** to `010` for the in-memory `@fastify/rate-limit` budgets of `/v1`, token exchange and back-channel logout: the multiplication by replica count is a deployment fact, there is no behavior to build here, and the shared-store check is a first-deployment gate (Gates) |
| M14  | A back-channel logout token with neither `sid` nor `sub` is accepted and consumes its `jti`; discovery and JWKS are fetched before the cheap claim checks; `typ: logout+jwt` is unconfirmed | Tasks 13.10, 13.11; the `typ` confirmation is added to `002`'s Q57 pre-deployment checklist (Gates)                                                                                                                                                                                                                                                                                                                   |
| M15  | `Inherited` ownership is unreachable and a `replace`-mode upsert without `ownerTeam` releases ownership                                                                                     | Task 13.6b (the upsert part); the `Inherited` part is Q37, task 13.6c                                                                                                                                                                                                                                                                                                                                             |
| M17  | The pinned image digests (`postgres`, Cerbos, ZAP) are not tracked by Dependabot                                                                                                            | Task 13.12                                                                                                                                                                                                                                                                                                                                                                                                        |
| M18  | DAST scope: no `VISMA_CONNECT_*`, so the SSO, back-channel and re-auth surfaces are unscanned; nothing asserts the API scan got 2xx                                                         | Task 13.13 for the assertion (extending the scan to `identity.openapi.json` is a first-deployment gate); **deferred** to `010` for the SSO surfaces: they need Visma Connect's test environment (`002` Q57), which this change cannot provide                                                                                                                                                                     |
| M19  | The diagram is Mermaid only (SEC01 wants a png or jpg), has no distinct Administrator, Support or Operations actors, and omits the `ghcr.io` pulls and the OTLP export                      | Tasks 16.7, 16.13                                                                                                                                                                                                                                                                                                                                                                                                 |
| M20  | `resolveContext` ignores `banned`; no test that a banned user cannot sign in or that a ban revokes sessions; no admin disable path                                                          | Tasks 13.4, 13.4b, 11.2                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q46 (`002`) | Notifications of password, MFA and email changes (`002` Q46 handed them to `043`/`044`) | **Deferred** to `044` with the ticket "Password, MFA and email-change notifications" (Resolved decision Q92): `043` adds password-setting paths and an email sender but builds none of these notices | 

`002` Q84 also hands this change or the gates the remaining low items: `NODE_ENV=test`
relaxing production checks is task 13.8 (the refusal lives in `createAppFromEnv`, Resolved decision Q98); `trustProxy` set to the exact ingress hop
count and the atomic back-channel replay guard are on `002`'s own first-deployment
list; the per-candidate `view` redaction is a ticket below (it concerns the catalog
read path, not an identity operation).

### Gates for the first deployment (`010`)

Human-owned. `002`'s own gate items are restated first (Resolved decision Q95), so
that this list is the whole list; each stays a gate of `002` as well:

- The manual TLS minimum and HSTS check on the public ingress (`002` task 11.12).
- A run against Visma Connect's test environment: `sid` present and preserved on
  `prompt=login`, the `form_post` callback under the production origin check,
  `typ: logout+jwt` on back-channel logout, and the SSO `sid`/`sub` hardening decided
  from that run (`002` Q57, `002` Q73, `002` Q83).
- A startup assertion that the runtime database roles are not superuser, owner or
  `BYPASSRLS` (task 11.1c makes it cover `machine_credential_revocation` in this change,
  Resolved decision Q109, so this gate does not depend on `045`, whose task 2.4 adds only
  its own marker table), and the real `MIGRATION_DATABASE_URL`
  wiring (`002` Q58, `002` Q62).
- `TRUST_PROXY` made configurable, set to the exact ingress hop count and verified
  against the Container Apps ingress peer range (`002` Q58, `002` Q84): the accept route's
  limiter keys on `request.ip`, which is only as trustworthy as this setting.
- The Cerbos audit log sent to stdout and on to Azure Monitor (`002` Q58).
- The SSO step-up callback bound to the browser that started it: `nonce`,
  `response_mode=query` and the session cookie at the callback (`002` Q71).
- The rate-limit stores shared across replicas (`002` Q73; the invitation caps and the
  accept route's limiter already use the DB-backed store).
- Dependabot tracks the pinned image digests (`postgres`, Cerbos, ZAP): task 13.12 adds
  that tracking, and the gate is that it is enabled in the repository (`002` Q73).
- scrypt cost parameters set to current OWASP guidance before the first user exists
  (`002` Q78).
- `NODE_ENV=test` refused with a non-local database (task 13.8) and the back-channel
  replay guard made atomic (`002` Q84).

This change's own gates:

- The invitation caps (Q15) and the accept-route limiter run on `002`'s
  DB-backed store (D4); confirm it in the deployed environment. The in-memory
  `@fastify/rate-limit` budgets of `/v1`, token exchange and back-channel logout
  multiply by the replica count until moved to a shared store (M13, `002` Q73
  gate).
- `MOUNT_IDENTITY_ROUTES` is turned on only after every task in group 13 is
  ticked, together with the other named tasks that close a `002` hand-off item (M5:
  8.1-8.1d; M9: 11.1, 15.6; M13: 6.10, 8.13; M19: 16.7, 16.13; M20: 11.2; the
  traceability table above; 15.6, 16.7 and 16.13 run after the mount group 14), and
  after `003` serves the accept page at `INVITATION_LINK_BASE_URL`.
- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the
  secret in Key Vault on a dedicated send-only ACS resource; the migration from
  the connection string to a managed identity is done (Q28).
- The DAST scan runs against a sandbox tenant with the mount switch **on**, a
  non-sending sender and without the destructive routes.
- One Container Apps Job per maintenance script, the backfill and the reconcile, with its
  own identity (Q49) and its own Cerbos sidecar, with the same policy bundle and
  configuration as the `apps/api` revision's, on the loopback link of `002` Q8 (D9), is
  provisioned (with `010`), and the just-in-time access and the
  named second approver for starting them are in place (D9). The backfill and the
  reconcile have run in every environment that has members **before the release
  carrying the `user_missing` rejection reaches it** (the rejection applies to the
  catalog `/v1` routes from the deploy, not from the mount; where no member exists yet,
  `002` Q78, they run at first deployment), and before the mount switch is turned on
  (Q46, Q50, D15). `045` adds the reviewed workflow and its own gates (the GitHub and
  Azure settings checklist, the purge job, the pre-purge warning and the marker alert).
- Verify with `010` that a Container Apps Job run completes when the script exits while
  its Cerbos sidecar keeps running; otherwise, simplest first, Cerbos runs as a child
  process inside the job container, or the job reaches Cerbos over TLS (`002` Q8), and
  only as the last resort the script ends the replica itself (D9; eleventh pass, G11-2,
  and its twelfth-pass follow-up). If `010` picks Cerbos as a child process inside the
  job container, the Cerbos binary stays pinned to the same image digest as the
  sidecar's, tracked by task 13.12's Dependabot, and the policy bundle is the `apps/api`
  revision's, shipped through the same SHA-pinned pipeline (`002` SEC13) (D9; the
  thirteenth pass's V13-note).
- A real email sender under `NODE_ENV=test` is configured only with its
  recipient-domain allowlist, which is honored wherever it is set (Q67, Q96, Q99); every deployed
  environment sets `EMAIL_PROVIDER` explicitly, and CI, DAST and demo tenants use the
  non-sending sender.
- `044` (the recovery path for a squatted account) ships before the mount switch is
  turned on (the account-squatting ticket depends on it).
- `db:migrate` reads `DATABASE_URL` and `MIGRATION_DATABASE_URL` is not wired yet
  (`002`'s first-deployment gate); migration `0011` runs with the migration role
  (`045`'s migrations need a role that holds `CREATEROLE`).
- `003`'s accept page strips the fragment after reading it, sends
  `Referrer-Policy: no-referrer` and loads no third-party script, and the ACS
  resource has engagement and click tracking disabled and DMARC aligned.
- The DAST scan is extended to `openapi/identity.openapi.json` (Q43), knowing that
  the document has no schemas (Q52); the accept route is not in either document and
  is scanned by hand until the ticket "DAST probe of the accept route" is done.
- `002`'s Q57 pre-deployment checklist gains: confirm that Visma Connect sends
  `typ: logout+jwt` (M14).
- The human attestations (off-boarding, training, access review, DNS DDoS, log
  hours, retention policy) are answered in `010`'s SSA (Resolved decision Q17).

### Tickets (non-blocking VCDM items, not built in this change)

| Ticket                                 | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last-active-admin protection           | Two admins can disable each other; the last admin can be disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Member management                      | `updateMemberRole`, `removeMember`, `setActiveOrganization` as Cerbos-gated procedures (`002` D18), after this change; a promotion to `admin` or `owner` must shed links (ticket "Member-role changes and SSO links").                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| User notifications                     | Status, role and credential changes, and an admin linking or unlinking an SSO identity or a shed removing one on the user's account, notify the user (SEC06). The shed is silent and also signs the user out of every device, the accepting one included once the acceptance's `_user` step has run (Q86, Q106, Q122), so this ticket's priority is raised. The shed event already covers part of the SSO case.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Service-account read scope             | A service account as `member` can list all users' emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Credential hygiene alerts | Alert on a credential whose `lastRequest` is stale or whose rotation is overdue: with no hard expiry (Q20) the rotation-due flag is only a display hint, and a more precise hygiene alert would combine both signals (SEC09/SEC10). |
| ZAP guards                             | Sandbox tenant, no-send email sender, destructive-route exclusion, and a sandbox scan with the mount switch on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SSO-only when linked                   | `002` Q44, for `025`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-recipient oracle                   | See Risks. Alias normalization is settled by Q33; the cross-tenant denial-of-invitation and the runtime kill-switch flip remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Email in the `{user}` path             | The `_user` identifier (an email) is a path segment (Resolved decision Q12), and so is the `{entity}` of the catalog routes of the `_user` blueprint. D16 keeps both out of the process's telemetry (the catalog routes since Q119), but the ingress and any proxy access log outside the process still see it. Consider an opaque-id route. oRPC's generated client also encodes path parameters with `encodeURIComponent`, so `a@b` becomes `a%40b`, which `002` Q74 answers with 404: the generated client cannot call a `{user}` route with an email until this is solved (the HTTP tests send raw paths and would not notice; the catalog `{entity}` path for `_user` emails has the same problem). |
| Account squatting                      | A tenant admin creates a global account for any email with a temporary password they know through `identity.users.create`. Consider an invitation-only or activation-link flow, or a notice to the address on creation (SEC04). `044` (the recovery path for a squatted account) shipping before the mount switch is a first-deployment gate (Gates).                                                                                                                                                                                                                                                                                                                                                               |
| HMAC of the per-recipient cap key (**built in this change by Q93, task 6.7b; it was a gate and is no longer one**) | Use an HMAC with a server secret instead of a bare sha256 of the email (SEC05).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Banned or disabled sign-in oracle | **Promoted to task 13.4b for the banned case (Resolved decision Q54).** Better Auth's admin plugin refuses a banned user with a distinct error after a correct password, a credential-validity oracle. The response should equal a wrong password's. |
| `principal_rejected` log flood         | A disabled user's session emits the WARN log on every request. Aggregate or rate-limit it and keep the counter (SEC16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ban-hook mirror (**resolved by Q102, task 4.5; no longer a ticket**) | The ban hook (D2) wrote `admin_enable` to every membership on a global unban, which could revert a tenant-scoped disable made by `setStatus`. It cannot see the old `banned` value, so any `user.update` that carries `banned: false` (enrolling a second factor, for example) sent `admin_enable` too, and the adapter's no-op covered only a user who was already `Active`: a user disabled in one of two tenants (not banned) would have been re-enabled there. Q102 settles it: the hook writes only `admin_disable`, for `banned === true`, and re-enabling goes through `setStatus` only. |
| One-active-credential constraint | A partial unique index over `apikey` on the "one active credential per service account" invariant, as defence in depth beside the advisory lock (needs a migration, Checkpoint 3, and `apikey.metadata` is a text column) (SEC03/SEC10). |
| Auth-schema repository module (**promoted into this change by Q69, tasks 5.1b and 5.1c**) | One repository module that requires `tenantId` for every adapter read of `apikey`, `invitation`, `member` and `session` (except the two reads that are global by nature, `globalInvitationById` and `globalMembershipTenantsOf`), and reads `user` and `account` only through `global…` functions (D14, sixth amendment), plus a lint ban on direct adapter access to those six models elsewhere, because the `auth` schema has no row-level security and the tenant filter is repeated by hand (SEC03/SEC14). |
| Bounce and complaint handling | Bounce, complaint and suppression handling for the ACS sender domain, with the operator procedure if the sender's reputation is hit (SEC11). |
| In-app invitation inbox | Revisit removing the emailed link once `003` offers an in-app invitation inbox (SEC11 Q2; the justification is Q34). |
| FQDN egress allowlist | FQDN egress allowlisting for ACS and `api.pwnedpasswords.com`, with `010` (SEC15). |
| DAST probe of the accept route | The public accept route is in no OpenAPI document, so DAST never sees it. A scripted probe or a hand-written OpenAPI fragment would let the scan cover the first unauthenticated route (SEC02/SEC12). |
| Recipient-cap alias normalization | A `+` alias is rejected (Q33), but dot-aliasing at providers such as Gmail and case variants outside the local part still bypass the per-recipient cap. Document the limit or normalize known providers (SEC06/SEC11). |
| Persistent per-tenant email-disable list | `EMAIL_DISABLED_TENANT_IDS` (Resolved decision Q80) is an environment variable, so changing it needs a new app revision. A persistent per-tenant setting, changed without a deploy, would make demo-tenant handling and an incident suppression faster (SEC11). |
| Offline breached-password corpus | Evaluate an offline corpus to remove the SHA-1 prefix egress to `api.pwnedpasswords.com` (Resolved decision Q81; SEC05/SEC15). |
| Per-candidate `view` redaction | The item `002` Q84 handed to a gate or a `043` ticket: per-candidate redaction in catalog `view` results. It concerns the catalog read path, not an identity operation. |
| Off-boarding review by creator | A disabled admin's service accounts and credentials stay valid, and so do the SSO links the admin recorded: they carry no creator (the provenance marker records only the links users made, Q87), so the creator is in the `auth.security.account_linked` events and a runbook step lists them. The viewer shows `createdBy`; add a creator filter and a runbook-driven review that lists and rotates or revokes everything a disabled admin created (SEC03/SEC10). |
| Read-only role for the maintenance scripts | The blueprint backfill needs only to read organizations; the reconcile also deletes `account` rows and their `verification` markers and revokes `session` rows for the shed (Q105), so a narrowed role for it must keep those deletes. Both hold `tayzu_auth` (full CRUD); a narrower auth role would limit them (SEC14). |
| Password, MFA and email-change notifications | `002` Q46 handed them to `043`/`044`. `043` adds password-setting paths and an email sender but builds none of these notices: **deferred to `044`** (Resolved decision Q92) (SEC06). |
| Member uniqueness | A `UNIQUE (organization_id, user_id)` index on `auth.member` (a migration, Checkpoint 3): a concurrent acceptance and `addMember` could otherwise create two rows for one user, and `memberRoleOf` reads one (SEC03). |
| Alerts for `010` | Alert on `catalog.security.sso_link_shed`, a volume of `catalog.security.principal_rejected`, `catalog.security.credential_rotation_incomplete`, `catalog.security.sso_link_marker_failed`, `catalog.security.invitation_accept_compensation_failed` and `catalog.security.accepting_session_revocation_failed` (Q115, G9-5), and on `catalog.security.invitation_acceptance_denied` with the reason `consume_conflict`, because every such event is an attempt that keeps its join without committing its acceptance (D4 step 4: a lost race, or a concurrent resend or cancellation that no attempt won; under a cancellation the join stands under a `cancelled` invitation, Risks); the structural fix is ticket TK12-1, "Serialized invitation writes", except for a `re_invite` cancellation, which keeps its window (Q42) (twelfth-pass VCDM G12-1). |
| One Visma Connect link per user | Eighth pass, TK-1. A user can hold more than one `visma-connect` account, and `ssoSidForSignIn` (`auth.ts`) reads the first `visma-connect` account of the user, not the account the callback signed in through, so a session's `ssoSid` can come from another link. `linkSsoAccount` should refuse a target that already has a `visma-connect` account, and `ssoSidForSignIn` should read the account the callback signed in through (SEC03). |
| Member-role changes and SSO links | Eighth pass, TK-2. The refusal of Q88 holds at link time only, so the future member management (ticket "Member management") must, when it promotes a member to `admin` or `owner`, shed that user's unmarked links and revoke their sessions, as a join does (D4 step 7), or a link an admin recorded on a plain member would survive the promotion (SEC03). |
| Rejected active-organization switches | Ninth pass, TK9-1 (G9-7, a `002` surface, with `010`). A rejected `/organization/set-active` is restored silently (`auth.ts`), and neither telemetry contract declares an event for it, although it is the probe that the window of G9-1 (closed by Q112) depended on. Log every rejected attempt (the opaque user id and the outcome, never a tenant id the caller supplied) and alert on repeated attempts (SEC16/SEC06). |
| Serialized acceptance attempts | Ninth pass, TK9-2 (G9-4). Attempt A inserts the membership, attempt B finds it there, sheds and consumes the token, and if A then fails before its `_user` step (since Resolved decision Q118 a later failure deletes nothing), A's compensation deletes the membership that B relied on; this is not the lost consume race that D4 step 4 exempts. It fails closed (the member has no membership and is invited again). Serialize the attempts of one invitation (an advisory lock keyed by the invitation id), or have the compensation re-check under that lock that the token is still unconsumed (SEC03, availability). Ticket TK12-1 ("Serialized invitation writes", Q128) extends this lock to resend and the cancellations and would close this race with them. |
| Serialized invitation writes | Twelfth pass, TK12-1 (Resolved decision Q128; the twelfth amendment's Open Question 2 and the twelfth-pass VCDM G12-1). One per-invitation lock, extending TK9-2's advisory lock: the acceptance takes it after its token verifies (so only a holder of a valid token can hold it) and holds it until the consumption commits, and resend, the admin cancel and the `user_created`, `user_disabled` and `inviter_disabled` cancellations take it before they read `pending`. It would close the window between their `pending` check and the acceptance's `accepted` write (D4 "Resend", Risks), the cancel race of G12-1 (a cancellation that commits between the token check and the consumption, Risks; not its `re_invite` variant, which Better Auth makes outside the lock), TK9-2 and the duplicate notice of concurrent new- and existing-account attempts (Risks), at the cost of one `tayzu_auth` connection per in-flight acceptance on a public, rate-limited route, so the pool must be sized for it. Better Auth's re-invite cancel keeps its window either way (Q42) (SEC03). |
| Dev-toolchain advisories | Eleventh pass, TK11-1 (G11-6, outside `043`). `pnpm audit` reports three advisories in dev dependencies reached through `markdownlint-cli2`: `braces` (high, GHSA-vfj7-8cjw-p6xm, no patched version), `smol-toml` (moderate, GHSA-r4xh-jqrq-34v2, fixed in 1.9.0 and later) and `katex` (low, GHSA-238p-pmpm-9mq7, fixed in 0.18.2 and later). Override `smol-toml` and `katex` through `pnpm.overrides`, or bump `markdownlint-cli2`, and record `braces` through the audited waiver path of `docs/security/dependencies.md`. The CI gate is `pnpm audit --prod` only, so none of them blocks this change or task 16.9 (SEC07). |

## Migration Plan

1. **One SQL migration, Checkpoint 3**, with its
   `migrations/down/0011_machine_credential_revocation_tenant_key.down.sql` (the full
   tag, as `down/0010_auth_session_sso_sid.down.sql`), `meta/0011_snapshot.json` and
   `_journal.json` entry:
   - `0011_machine_credential_revocation_tenant_key`: a composite
     `(tenant_id, credential_id)` key on `machine_credential_revocation`, with the
     matching change in `packages/catalog/src/persistence/schema.ts` (task 11.1).
   - `045` owns `0012` to `0014` (the deletion marker, the `tayzu_purge` and
     `tayzu_deletion_admin` roles and the row-level policies of the purge); no migration
     is renumbered.

   The blueprint evolution of `_user` (D1) is not a migration: it is a
   `blueprints.update` per existing tenant plus the new-tenant constant.
2. ⛔ **Checkpoint 3** also applies to every Cerbos policy file this change adds
   or edits (D3): the `user.yaml` deny rules; the new `service_account.yaml` (with
   its deny for any `accountKind` other than `service`, Q62) and `credential.yaml`;
   `admin.yaml`, `member.yaml` (if needed) and `role_policies_test.yaml`; and the
   `same_tenant_test.yaml` extension and the shared `testdata/` entries; each
   presented with its `cerbos compile` test output, separately.
3. Deploy: `@azure/communication-email` and its Key Vault secret
   (`ACS_CONNECTION_STRING`), `EMAIL_PROVIDER`, `IDENTITY_TOKEN_HMAC_SECRET` (a Key
   Vault secret, Q93), `INVITATION_LINK_BASE_URL`, the kill
   switch, `EMAIL_DISABLED_TENANT_IDS` and the mount switch (off or safe by default),
   each script with its telemetry environment names (Q79).
   Nothing is mounted until the gates above are met.
4. The scripts under `apps/api/scripts/` (the blueprint backfill, the `_user`
   reconcile and the moved bootstrap CLI, which an operator runs out of band,
   Resolved decision Q91) are added with no schema change. The blueprint backfill and
   the reconcile run once per environment, as operator-started Container Apps Jobs
   (D9, one job per script, each with its own Cerbos sidecar), after the code that
   reads `accountKind` is deployed and before the release that carries the `user_missing` rejection of D13 serves traffic
   in an environment that has members (the rejection applies to the catalog `/v1`
   routes from the deploy, not from the mount switch, so the jobs run from the new
   image before the new app revision takes traffic; where no member exists yet, `002`
   Q78, the order holds trivially at first deployment), and before the mount switch is
   turned on.
5. Rollback: set `MOUNT_IDENTITY_ROUTES` off to remove the whole HTTP surface
   (D15). The migration has a down script.

## Resolved decisions (asked and approved in chat, 2026-09-28, 2026-10-01, 2026-10-07, 2026-10-08 and 2026-10-09)

Rows marked "(moved to 045 by Q103)" are carried verbatim in
`045-org-deletion-and-data-retention`'s design, where they now govern; rows marked
"(deletion part moved to 045 by Q103)" are carried there whole too, and stay in force
here for their other parts. The one exception is Q85: its deletion part, "Require review
from Code Owners" as the fifth Q55 checklist item, is stated in `045`'s D3 and docs task
under Q55 and Q64, but `045`'s table does not carry the row; carrying it there is a `045`
edit, outside this change. A mention of org deletion, the purge, the marker or the
maintenance workflow inside a row of this table is therefore about `045`.

Per `openspec/project.md` §20, drawn from the shared `002`/`043` decision set
(`scratchpad/p002/decisions.md`) that specifically bears on this change. The numbers
here are this change's own: `002` uses Q70-Q84 for different decisions, so a reference
to one of `002`'s is always written `002 Q<n>`, and an unprefixed `Q<n>` is a row of
this table:

| #   | Question                                                                                                                                                      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | (deletion part moved to 045 by Q103) Split point between `002` and `043`                                                                                                                           | This change owns exactly: 4-state user status lifecycle and invitations (+ invitation email, SEC11), service accounts, org API-credentials viewer/management, data retention & deletion policy + org deletion, credential rotation policy UX. Everything else stays with `002`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q4  | Canonical user status field                                                                                                                                   | Stored as one field on `_user`, updated by hooks reacting to Better Auth events (`002` defines the field and `Active`/`Disabled` at minimum; this change completes `Staged`/`Invited` and the transition rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q5  | Machine credentials                                                                                                                                           | Long-lived client id + secret (revocable, rotatable, hashed) exchanged for a short-lived (1-hour) access token — this change's service accounts and credential viewer/rotation consume that mechanism, they do not redefine it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q6  | (deletion part moved to 045 by Q103) Step-up for high-risk operations                                                                                                                              | _Extended by Q19 and Q31 and D10 (VCDM B11): the high-risk set is D10's ten operations (`setStatus`, `invite`, `users.create`, `linkSsoAccount`, `unlinkSsoAccount`, `serviceAccounts.create`/`delete`, `credentials.create`/`rotate`/`revoke`); `organization.delete` is `045`'s._ A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q7  | (VCDM pre-assessment, 2026-09-28) Should service accounts be restricted from holding `admin`/broad `moderatedBlueprints`, given they never go through step-up | Restrict service accounts to `member` role only, enforced at creation/update validation and by an independent Cerbos rule on `accountKind: "service"` (D6, D3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q8  | (Drift-check and VCDM pre-assessment against merged 002, 2026-10-01) How an invitee without an account accepts                                                | The invitation link carries a single-use, constant-time-compared token. A public, rate-limited accept route outside the tenant-context pipeline derives the tenant from the invitation record, lets the invitee set a password, and treats the token as mailbox proof (email verified in-process); MFA enrollment then follows 002 Q43, and Visma Connect is linked later through `/link-social`, `sub`-keyed. Responses are enumeration-resistant. The native `/organization/accept-invitation` route stays off the `002` D18 allowlist.                                                                                                                                                                   |
| Q9  | (VCDM B2, 2026-10-01) Roles an invitation may carry                                                                                                           | `member` or `admin`, never `owner`; an `admin` invitation requires step-up and is logged with its role (consistent with 002 Q37). _Extended by Q19: every invitation requires step-up._                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q10 | (Drift b2, 2026-10-01) Attributing `_user` writes to the admin                                                                                                | _Q116 and Q117: where no admin acts, the write and its audit events name the principal who did: the invitee of an acceptance, the operator of the bootstrap and the reconcile, the user of a first sign-in, and none for the ban hook._ The identity procedure writes as `system` with `actor.onBehalfOf` set to the admin, in-process only; `reserved.ts` is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q11 | (Drift b8, 2026-10-01) Canonical disable mechanism and default status                                                                                         | _Q76 makes the membership hook the only writer of `_user`: `identity.users.create` and the bootstrap no longer upsert it themselves._ **Superseded in part by Q25** (the disable is tenant-scoped and uses the internal adapter; `banUser`/`unbanUser` are not called, D13); the state-machine part stands. `setStatus` calls Better Auth `banUser`/`unbanUser` and syncs `_user.status` through the `nextStatus` state machine; `afterAddMember`, the ban hook and `identity.users.create` go through it. Admin-created users start `Active`; `Staged` is the default only for an entity created without a status. Covers 043 task 13.4. |
| Q12 | (Drift b3/b4, VCDM, 2026-10-01) Service-account principal                                                                                                     | The signed machine claim stays `member` with no teams and no moderated blueprints (002 Q28); `userId` is added only as an attribution claim. Routes address a user by its `_user` entity identifier (email or `svc-…`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q13 | (Drift b5, VCDM B4, 2026-10-01) Immediacy of disable, rotate and revoke                                                                                       | Rotate and revoke write the revocation list (effective within seconds). Disable is a `_user.status` check on the resolver's machine branch with the 5-second cache, failing closed, so a disabled service account can be re-enabled without a migration.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q14 | (moved to 045 by Q103) (Drift b6, VCDM B5, 2026-10-01) Org deletion                                                                                                                  | Two phases: access is revoked immediately and the tenant is marked pending deletion; after a 7-to-14-day window a job purges in idempotent steps (catalog data, then Better Auth rows). The purge of append-only rows goes through a `SECURITY DEFINER` function owned by `tayzu_migrator` that deletes only for a tenant marked for deletion (a migration, Checkpoint 3). **The `tayzu_migrator` owner is superseded by Q26, and Q48 then removed the function altogether**; the two phases and the window stand.                                                                                                                                                                                         |
| Q15 | (VCDM B9, 2026-10-01) Invitation email abuse limits | _Extended by Q53: the kill switch and the per-recipient bucket also cover the two notice templates. Semantics of the windows on `002`'s store: Q66. Q101 gives the notices a per-recipient bucket of their own._ 30 per hour per tenant, 3 per 24 hours per recipient across all tenants (keyed by an HMAC, Q93), and a global kill switch (environment variable), on a shared store before the first deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q16 | (Drift b7, 2026-10-01) Testing the service-account role ceiling                                                                                               | The Cerbos rule stays as a defensive layer, tested at the policy level, plus a `system`-actor test; no new role-editing operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q17 | (VCDM, 2026-10-01) Human attestations                                                                                                                         | Deferred to `010`'s SSA, as `002` Q59 and `002` Q79.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q18 | (Amendment question, 2026-10-01) Invitation for an email that already has an account                                                                          | _Extended by Q73, Q86 and Q87: an SSO link without a provenance marker is shed at acceptance and the user's other sessions are revoked; Q105 makes the shed an explicit step of every attempt and compensates the membership when a step before the `_user` step fails (narrowed by Q118: a later failure keeps the membership and the token for a retry that completes the acceptance); Q106 also revokes the accepting session after the acceptance commits when a link was shed (Q122: as soon as the attempt's `_user` step has run)._ Acceptance requires an authenticated session of that same account plus the token; it adds only the membership, activates the `_user` and sets no password. |
| Q19 | (Amendment question, 2026-10-01) Step-up for `invite` and `users.create`                                                                                      | Both are marked `x-tayzu-risk: high` for every invited or created role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q20 | (Amendment question, 2026-10-01) Machine API-key expiry                                                                                                       | No hard expiry; only the 90-day rotation-due indicator (D8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q21 | (moved to 045 by Q103) (Amendment question, 2026-10-01) Org-deletion window and reversal                                                                                             | Default 14 days, configurable between 7 and 14; reversal only by a platform operator clearing the marker through a documented runbook; no in-product cancel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q22 | (Amendment question, 2026-10-01) Password policy                                                                                                              | Minimum **20** characters (the human's choice), at most 128 (bounds the hashing cost). Every character class is required: an upper-case letter, a lower-case letter, a digit and a symbol. Characters that can harm the system are rejected: control characters (U+0000-U+001F, U+007F-U+009F, NUL included), unpaired surrogates, and Unicode format characters (bidirectional overrides, zero-width characters); the password is NFC-normalized before the check and the hash. A bundled common-password denylist applies, with no external call and no new dependency, plus `002`'s existing backoff. Applies to invitation acceptance, temporary and bootstrap passwords, and `/change-password`. |
| Q23 | (Human, 2026-10-01) Breached-password check                                                                                                                   | _Refined (task 8.1b): at the boundary the failure is the sanitized `INTERNAL` (500) error, the only generic error the mapping has; no new code._ Added to Q22's policy: Better Auth's built-in `haveIBeenPwned` plugin (part of `better-auth@1.7.6`, so no new dependency) refuses any password found in the Pwned Passwords corpus. It sends only the first five hex characters of the password's SHA-1 (k-anonymity range query) to `https://api.pwnedpasswords.com`, a new outbound egress named in SEC15 and the system diagram. It fails closed: when the service is unreachable the password is not set and the caller gets a generic retryable error. It covers every path Q22 covers, including in-process acceptance and bootstrap. |
| Q24 | (VCDM re-run NB1, 2026-10-01) Specifying Q18's existing-account acceptance                                                                                    | **The verified-email condition is superseded by Q38.** A plain Fastify route behind the mount switch, with the CSRF custom header and the origin check; it requires a session whose verified email equals the invitation email, plus the token, and a fresh step-up when the invited role is `admin`; it adds only the membership, never touches the password or the active organization, and answers the same uniform rejection as every other failure.                                                                                                                                                                                                                                              |
| Q25 | (VCDM re-run NB2, 2026-10-01) Off-boarding a member who also belongs to another tenant                                                                        | _The rejection is `401 CATALOG_CONTEXT_REQUIRED` with the reason only in the log (Q77)._ _**The resolver rule is amended by Q105**: a human is admitted only when `_user.status` in the active tenant is `Active`, so `Invited` and `Staged` are rejected too, not only `Disabled`._ Tenant-scoped disable: `setStatus` writes `_user.status`; `resolveContext` rejects a human whose `_user.status` in the active tenant is `Disabled` (a new, cached, fail-closed `_user` status lookup: the "cached" of the first wording was stale, there is no `_user` cache before task 11.8); only that tenant's sessions are revoked. `banUser` (through the internal adapter, not the admin-plugin route) is used only for a single-membership user. |
| Q26 | (moved to 045 by Q103) (VCDM re-run NB3 and drift Q-F, 2026-10-01) Purge privilege model | **The function wording is superseded by Q48 and the auth side by Q49** (no `SECURITY DEFINER` function; policies on the catalog and Better Auth rows); the role, the marker and the trigger guarantees stand. A dedicated `tayzu_purge` role with its own pool and secret, used only by the purge job, owns the purge function and has an RLS policy limited to tenants with a due marker. The marker is insert-only for `tayzu_app`, its window enforced by `CHECK` and `requested_at` set by the database. The append-only trigger allows DELETE only for `tayzu_purge`. A separate `SECURITY DEFINER` lister returns due tenants. (Migrations, Checkpoint 3.)                                                                                                                                                                                                                                                    |
| Q27 | (moved to 045 by Q103) (VCDM re-run NB4, Q5, 2026-10-01) Deletion authority, notification and reversal                                                                               | Any Cerbos `admin` may request deletion; every org admin gets a fixed-template email; reversal is a script that tombstones the marker and emits `catalog.audit.org_deletion_cancelled` with the operator id, under JIT access (Azure PIM) and a named second approver.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q28 | (VCDM re-run Q6, 2026-10-01) ACS authentication                                                                                                               | Connection string in Key Vault, on a dedicated send-only ACS resource restricted to the sender domain, rotation documented; a managed identity is a first-deployment gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q29 | (Drift Q-A, 2026-10-01) Org API keys by a non-owner admin                                                                                                     | The organization plugin's access control grants the `admin` role `apiKey` create/read/update/delete, and Better Auth is called headerless with `body.userId`; Cerbos stays the real gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Q30 | (Drift Q-B, 2026-10-01) Where the identity operations live                                                                                                    | Orchestration in `apps/api` with structural ports in `@tayzu/auth` (the `UserSyncPort` pattern); pure parts (status machine, token, password policy, email port) stay in `packages/auth`. No new dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q31 | (Drift Q-C, 2026-10-01) The three existing identity procedures                                                                                                | _Q73's provenance marker on a link recorded through `linkSsoAccount` is superseded by Q87: the marker is written for the links users make, and `linkSsoAccount` refuses an admin or owner target (Q88)._ _(After Q103: 14 routes, 13 oRPC; the "fifteen" below counted `045`'s `organization.delete`.)_ `create`, `linkSsoAccount` and `unlinkSsoAccount` get HTTP routes and join the mounted set (fifteen routes), so their step-up is tested over HTTP. |
| Q32 | (Drift Q-D, 2026-10-01) Invitation link origin                                                                                                                | `INVITATION_LINK_BASE_URL` (https outside test, must be one of `ALLOWED_ORIGINS`) with a fixed path; the link stays inert until `003` builds the page, documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q33 | (Drift Q-E, 2026-10-01) Emails the entity identifier cannot hold                                                                                              | Rejected with `CATALOG_VALIDATION_FAILED` in `invite` and `create`, documented; no `001` change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q34 | (VCDM re-run Q7, 2026-10-01) SEC11 answers                                                                                                                    | Q1 yes. Q2: one clickable link, the invitation-accept link, unavoidable for a no-account invitee, mitigated by a fragment token, single use, 48-hour expiry and a configured origin. Q3 yes, only the recipient address varies. Q4 no attachments. Q5 fixed template, validated recipient.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q35 | (moved to 045 by Q103) (Amendment Open Question 1, 2026-10-01) Role for the deletion-reversal script                                                                                 | A dedicated `tayzu_deletion_admin` role that may only tombstone a pending marker (update `state` and the cancellation fields), created in migration `0013` (Checkpoint 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Q36 | (Amendment Open Question 2, M11, 2026-10-01) Forcing change and expiry of temporary and bootstrap passwords                                                   | A marker row in `auth.verification` (no migration), read by the resolver: a session whose user holds an unexpired marker reaches only `/change-password`; an expired marker blocks sign-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Q37 | (Amendment Open Question 3, M15, 2026-10-01) Unreachable `Inherited` ownership                                                                                | Fail closed: a non-admin cannot update an entity whose ownership is declared inherited until the chain is implemented; the catalog spec is corrected afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q38 | (Re-run H1/drift B1, 2026-10-01) Verified email for existing-account acceptance                                                                               | The "verified" condition is dropped. Acceptance still requires a session of the same account, email equality, the valid token, the CSRF header and origin check, and step-up for an `admin` role; on success `emailVerified` is set, since the token proves the mailbox.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q39 | (Re-run H2, 2026-10-01) New-account `admin` invitations                                                                                                       | The residual is accepted, and every other org admin gets a fixed-template notice (no link, no free text) when an `admin`-role invitation is accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q40 | (Re-run H3, VCDM B1, 2026-10-01) Credentials per service account                                                                                              | Exactly one active credential per service account: `credentials.create` refuses to bind to a service account with an active credential, a revoked credential may be rotated only when none is active, and rotation is serialized per service account. Deleting a service account revokes every bound credential; the resolver and token exchange reject a token whose bound `_user` is absent or not `Active`.                                                                                                                                                                                                                                                                                        |
| Q41 | (deletion part moved to 045 by Q103; here the backfill and the reconcile start as operator-started jobs until `045`'s workflow lands, D9) (Re-run H4, 2026-10-01) Where the reversal script and the `_user` backfill run | _Extended by Q49 (one Container Apps Job per script), Q55 (the GitHub settings checklist) and Q64 (inputs only through `env`, a fourth checklist item, `CODEOWNERS`, actions pinned by SHA)._ A manual `workflow_dispatch` GitHub Actions workflow with environment-required reviewers starts an Azure Container Apps Job through OIDC, enforcing the second approver and recording the operator identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q42 | (Drift B2, 2026-10-01) How `invite` reaches Better Auth                                                                                                       | The admin's session headers are forwarded into `auth.api.createInvitation` (headers in the context, like the step-up headers); re-invite cancel, the invitation limit and the hooks stay Better Auth's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q43 | (Drift B3, 2026-10-01) OpenAPI document for the identity routes | _Narrowed by Q52: paths, methods, path parameters and `x-tayzu-risk` only, no schemas._ A second committed document, `openapi/identity.openapi.json`, generated in `apps/api` with its own `contract:generate` and `contract:check`; the `x-tayzu-risk` assertions run on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q44 | (Drift B4, 2026-10-01) Per-key API rate limit                                                                                                                 | 60 verifications per hour per key, configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q45 | (VCDM B2, 2026-10-01) Mandatory authorization in the identity router | _Extended by Q57: the wrapper checks the caller's tenant first and fails closed._ _(After Q103: 13 oRPC routes, 14 in all; the "14 oRPC routes" below counted `045`'s `organization.delete`.)_ A `defineIdentityOperation({ authorization, handler })` wrapper resolves the target server-side, calls Cerbos and emits `authz_denied`; a test forbids a bare handler; a route-table-driven HTTP matrix covers each of the 14 oRPC routes (admin allowed, member 403, machine token 403, unauthenticated 401, foreign target 404).                                                                                                                                                                                                                                                                                                                                                                    |
| Q46 | (Amendment Open Question, 2026-10-01) A human member with no `_user` row in the active tenant | _The rejection is `401 CATALOG_CONTEXT_REQUIRED` with the reason only in the log (Q77)._ _Extended by Q50: the rejection reason is `user_missing` and the reconcile creates the missing rows._ _Q105 widens the rule: any status other than `Active` is rejected too, and the reconcile sheds before it creates a row for a member of two or more tenants._ `resolveContext` rejects it (fail closed); the `_user` backfill runs before the first deployment so no legitimate member is locked out. |
| Q47 | (deletion part moved to 045 by Q103) (Amendment choices confirmed by the human, 2026-10-01) Details settled while applying Q38-Q45 | (1) An acceptance request with no `Origin` header is rejected. (2) The org-deletion confirmation travels in the query (`?confirmation=`), which telemetry already drops. (3) Rotation is also serialized per credential for integrations with no service account. (4) Invitation cancel uses Better Auth's `cancelInvitation` with the admin's forwarded session headers, like `invite` (Q42). |
| Q48 | (moved to 045 by Q103) (Drift N1, 2026-10-01) Catalog-side purge ownership | No `SECURITY DEFINER` functions: the purge job logs in as `tayzu_purge` and deletes under per-table RLS policies limited to tenants with a due marker and the amended append-only trigger; listing due tenants is a `SELECT` policy on the marker for `tayzu_purge`. Supersedes Q26's function wording; every other Q26 guarantee stands. |
| Q49 | (deletion part moved to 045 by Q103; the one-Container-Apps-Job-per-script part stays in force here, D9) (VCDM G7, 2026-10-01) Auth-side purge privileges | _Refined: the Better Auth side is migration `0014` after the split (Q82)._ _The visibility of a user's other memberships to the purge role is settled by Q65._ A narrow mechanism gated on a due marker for the Better Auth rows, in migration `0014` (Checkpoint 3), and one Container Apps Job per script.|
| Q50 | (Drift N3, VCDM G6, 2026-10-01) `_user` backfill | _Extended by Q75: the reconcile also removes an orphan `_user` (an `Active` human row with no membership)._ A repeatable reconcile that creates every missing `_user` row through the state machine (`created_active`), with a `user_missing` rejection reason and a spec scenario; it is also the repair path for a Q46 lockout. |
| Q51 | (Drift N2, 2026-10-01) Bootstrap CLI location | The CLI moves to `apps/api/scripts/bootstrap-admin.ts`; `bootstrapAdmin()` and its test stay in `@tayzu/auth`. |
| Q52 | (Drift N4, 2026-10-01) Identity OpenAPI content | Paths, methods, path parameters and `x-tayzu-risk` only, no new dependency; DAST value is documented as limited until schemas exist. |
| Q53 | (deletion part moved to 045 by Q103) (VCDM G1, 2026-10-01) Notice-email abuse controls | _Q101: the notices' per-recipient bucket is their own, not the invitation one._ All three templates are under the kill switch and the per-recipient bucket, with a per-tenant notice cap and at most 20 recipients per notice (truncation logged). |
| Q54 | (VCDM G3, 2026-10-01) Banned-sign-in oracle | A group-13 task: a banned user's sign-in fails exactly like any other failure, local and SSO, with a banned case in the enumeration test. |
| Q55 | (moved to 045 by Q103) (VCDM G8, 2026-10-01) GitHub settings for the maintenance workflow | _Extended by Q64: a fourth checklist item, the federated identity's Azure role limited to starting the named jobs._ Required reviewers with "prevent self-review", deployment branch limited to `master`, OIDC subject pinned to the environment, recorded in a settings checklist the human applies. |
| Q56 | (VCDM G12, 2026-10-01) Per-tenant caps | 50 service accounts and 200 credentials per tenant, configurable in `apps/api/src/config.ts`; zero or a disabled value fails startup. |
| Q57 | (VCDM G4, 2026-10-01) Identity wrapper contract | `defineIdentityOperation` keeps 002's guarantees: a caller-tenant role check first (one answer for any target to an unauthorized caller), and fail closed on a Cerbos error, a malformed context or empty roles; two tests pin it. |
| Q58 | (deletion part moved to 045 by Q103) (Amendment Open Question 1, 2026-10-01) Per-tenant notice-email cap | 60 per hour per tenant (three full notices of 20 recipients). |
| Q59 | (moved to 045 by Q103) (Amendment Open Question 2, 2026-10-01) Scoping Better Auth rows for the purge | _Refined: the Better Auth side is migration `0014` after the split (Q82)._ **Reworded by Q65: `tayzu_auth` keeps a permissive policy (`USING (true)`) on those tables, and the due-tenant restriction applies to the purge role (which also gets a read-only `SELECT` over every `auth.member` row); the first wording, below, would have locked Better Auth out of every other tenant.** RLS on those tables with a permissive policy letting `tayzu_auth` act on rows of tenants with a due marker only, the same shape as Q48 and no functions (migration `0014`, Checkpoint 3).|
| Q60 | (Amendment Open Question 3, N16, 2026-10-01) `ENTITY_IDENTIFIER_PATTERN` in `apps/api` | _Refined (task 7.9b): there are two private copies, `identifiers.ts` is the source and `limits.ts` imports it._ `@tayzu/catalog` exports the constant unchanged, one source of truth; no `001` behavior change. |
| Q61 | (Amendment Open Question 4, G2, 2026-10-01) Uniform `Retry-After` on invitation caps | Always the shortest window, 1 hour. |
| Q62 | (VCDM NB-1, 2026-10-01) Service-account routes and human targets | Every `service_account` route resolves its target server-side and answers `CATALOG_NOT_FOUND` unless the `_user` has `accountKind == "service"` and an `svc-` identifier; `accountKind` reaches Cerbos with a deny for any other value (Checkpoint 3); the reconcile creates `Disabled` for a banned user. |
| Q63 | (VCDM NB-2, 2026-10-01) An invitation outliving its inviter's authority | _The admin-role part is decided by Cerbos (Q108): a `user`/`invite` check with the inviter as the principal, not a local mapping of the membership role._ Both: acceptance fails with the uniform rejection (reason `inviter_not_active_admin`) unless the inviter is still an active, non-banned admin member of the tenant, and disabling a user cancels the invitations they created (reason `inviter_disabled`). |
| Q64 | (moved to 045 by Q103) (VCDM NB-3, 2026-10-01) Maintenance workflow inputs and OIDC scope | Inputs are `choice` or regex-validated and reach the job only through `env`; a test fails on `${{ inputs.* }}`, `github.event.*` or `github.head_ref` inside `run:`; the federated identity's Azure role only starts the named jobs (a fourth item in the Q55 checklist); CODEOWNERS covers the workflow and `apps/api/scripts/**`; actions are pinned by SHA. |
| Q65 | (moved to 045 by Q103) (Drift B1, 2026-10-01) Purge visibility of a user's memberships | The purge role gets read-only `SELECT` on every `auth.member` row; its deletes stay limited to tenants with a due marker. Q59 is reworded accordingly: `tayzu_auth` keeps a permissive policy, and the due-tenant restriction applies to the purge role. |
| Q66 | (Drift B2, 2026-10-01) Invitation cap semantics on 002's store | Accepted and documented: a bucket resets only after a full window with no allowed request, which is stricter than nominal; a test pins the slow-trickle case; no migration. |
| Q67 | (VCDM Q-B, 2026-10-01) Email outside production | _Extended by Q80: demo tenants are also kept off a real sender by the `EMAIL_DISABLED_TENANT_IDS` list._ _Q96 redefines "production" as `NODE_ENV !== 'test'`, which empties "outside production"; settled by Q99: the allowlist is honored wherever it is set and is mandatory only for a real provider under `NODE_ENV=test`._ A real sender outside production requires a mandatory recipient-domain allowlist (startup fails without it); CI, DAST and demo tenants use the non-sending sender. |
| Q68 | (moved to 045 by Q103) (VCDM Q-C, 2026-10-01) Pre-purge warning and orphan-marker alert | A first-deployment gate for `010`, which owns alerting. |
| Q69 | (VCDM Q-D, 2026-10-01) Hand-written `auth`-schema readers | _Extended (G6-5, sixth amendment): also `session`, `user` and `account`, the last two through `global…` functions._ One `auth-repository.ts` in `apps/api` requiring `tenantId` on every read of `apikey`, `invitation` and `member`, plus a lint ban on direct adapter access to those models from the identity code. |
| Q70 | (deletion part moved to 045 by Q103) (Amendment Open Question 1, 2026-10-01) `onBehalfOf` principal for maintenance scripts | `gh:<numeric GitHub actor id>` with actor type `user`; it fits 002's id pattern, is authenticated by the workflow and changes nothing in 002. |
| Q71 | (Amendment Open Question 2, 2026-10-01) DAST seed and the breached-password check | _Refined (tasks 8.1a and 4.6b): the stub is an `.mjs` module, and `dast.sh` loads it for the whole `dast.sh up`, which includes the API server._ The CI step injects the range-API stub with `NODE_OPTIONS=--import`; no seam in production code. |
| Q72 | (moved to 045 by Q103) (Amendment, 2026-10-01) CODEOWNERS owner | `@nahuex` (the repository owner) owns the maintenance workflow and `apps/api/scripts/**`. |
| Q73 | (VCDM NB-4, 2026-10-01) Admin-recorded SSO links surviving into a second tenant | _Superseded in part by Q86, Q87 and Q88: the marker is not written by `linkSsoAccount` but for the links users make, and the shed also revokes sessions; the shed and its event stand._ `linkSsoAccount` records the linking tenant in an `auth.verification` marker (no migration). At existing-account acceptance, and in `afterAddMember` whenever the user already has another membership, every admin-recorded SSO link from a different tenant is deleted, `catalog.security.sso_link_shed` is emitted, and the user may re-link through `/link-social` with step-up. |
| Q74 | (Drift B1, 2026-10-01) Identity telemetry names | _Q131: `002`'s `contract.test.ts` stays untouched; the `otel-smoke-check` value-set assertion on the reasons of `auth.security.login_failed` is rewritten to the exact set `{bad_credentials, mfa_failed, account_disabled}` (task 15.2)._ A separate identity contract module that `otel-smoke-check` also imports; 002's contract assertions stay untouched. |
| Q75 | (Drift B2, 2026-10-01) Atomic invitation acceptance | _Superseded by Q89: no single transaction; idempotent steps, the token consumed last, a compensation and the reconcile._ Better Auth `transaction: true`; consuming the token and creating the user and member happen in one transaction; the `_user` write runs in `afterAddMember`, failing closed; the reconcile repairs an orphan `_user`. |
| Q76 | (Drift B3, 2026-10-01) Hook-only `_user` writes | _Amended by Q112: inside the acceptance's shared context the hook makes no `_user` write, and the acceptance's own `_user` step writes it after the shed; on every other path the hook stays the only writer and sheds before it writes._ _Q120: only for the acceptance's own `(tenantId, userId)`; any other membership inside the context is written and shed by the hook._ Approved by the human: `_user` is written only by the hook, reversing 002 task 18.5's direct writes; the two direct-write tests in `user-sync.int.test.ts` are rewritten to build `auth` with `userSync`, and task 4.6's wording is corrected. |
| Q77 | (Drift B4, 2026-10-01) Rejection code for a `Disabled` or missing human `_user` | _Q105 applies the same code to every human `_user` status other than `Active`._ `401 CATALOG_CONTEXT_REQUIRED` with the reason only in logs, like `rejectMissingContext`; approved by the human, the test at `context-resolver-principal.int.test.ts:364-390` is rewritten to this requirement and the change is called out in the PR. |
| Q78 | (Drift B5, 2026-10-01) Reaching the machine-credential functions | A subpath export `@tayzu/auth/machine-credentials`, with a lint rule limiting importers to `apps/api/src/identity/**`. |
| Q79 | (deletion part moved to 045 by Q103) (Drift B6, 2026-10-01) Telemetry in maintenance scripts | Each script starts telemetry, emits its audit events and flushes before exit; the environment names are documented. |
| Q80 | (VCDM Q-B, 2026-10-01) Demo tenants and the real sender | An `EMAIL_DISABLED_TENANT_IDS` list honored by the invitation and notice dispatcher; a listed tenant's emails are suppressed and logged as `catalog.security.email_tenant_blocked`. |
| Q81 | (VCDM Q-C, 2026-10-01) SHA-1 prefix of the breached-password query | Recorded in `crypto-inventory.md` as a protocol-mandated exception (five hex characters leave, SHA-1 is not used for storage or authentication), with a ticket to evaluate an offline corpus. |
| Q82 | (moved to 045 by Q103) (Sixth-pass Open Question 1, drift B7, 2026-10-07) Approving the two purge-grant blocks | _(043's old tasks 12.1b and 12.1c are `045`'s tasks 2.2 and 2.3; 043 keeps one migration, `0011`.)_ Split into `0013_tenant_deletion_grants` (task 12.1b, catalog side) and `0014_tenant_deletion_auth_grants` (task 12.1c, Better Auth side), each approved separately at Checkpoint 3 and never edited afterwards. Four migrations in total. |
| Q83 | (Sixth-pass Open Question 2, drift M12, 2026-10-07) Concurrent `_user` status writes | The status adapter writes with the `expectedVersion` of the row it read and retries at most 3 times before failing closed; a race never revives a `Disabled` user. |
| Q84 | (Sixth-pass Open Question 3, Q75 follow-up, 2026-10-07) Reconcile of an orphan `_user` | _Q89: an orphan is removed only when its `createdAt` is more than one hour old._ _**Amended by Q124**: the hour is measured from the row's `updatedAt` (its activation), not its `createdAt`._ The reconcile removes a human `_user` that is `Active` and has no `member` row in its tenant (never `Invited`, `Staged` or a service account), as `system` with `onBehalfOf` the operator, and counts it. |
| Q85 | (deletion part moved to 045 by Q103) (Amendment details confirmed by the human, 2026-10-07) Names and values fixed during the Q73-Q81 amendment | _The viewer page of 200 is the default of the credential cap of Q56, which is configurable: the page follows the configured cap, so a larger cap never hides a non-revoked credential (a consistency fix of the thirteenth amendment, no new decision; D7, task 9.2)._ `ACS_CONNECTION_STRING` and `EMAIL_PROVIDER` (`acs` or `none`); Better Auth's `maxPasswordLength` 256 (UTF-16 units) while Q22 keeps 128 code points; a credential-viewer page of 200; "Require review from Code Owners" as the fifth Q55 checklist item; SSO-link markers identified `sso-link:<accountId>` (Q87 pins `<accountId>` to the `account` row's own id, not the provider's `accountId` column). |
| Q86 | (VCDM NB-5, 2026-10-07) Sessions issued through a shed or admin-unlinked SSO link | _**The exemption of the accepting session is amended by Q106**: when the shed removed a link, the accepting session is revoked too, after the acceptance commits, and the shed sweeps the sessions a second time after its deletion commits._ _**Q122**: on the existing-account path that revocation runs as soon as the attempt's `_user` step has run, before the `emailVerified` write and the consumption of the token, not after the acceptance commits._ _Q114: the shed revokes by deleting the `session` rows itself, on the `tayzu_auth` pool._ On a shed and on an admin `unlinkSsoAccount`, every session of the user is revoked except the one carrying the acceptance request (the hook path revokes all), not filtered on `ssoSid`; `auth.security.session_revoked` gets the reason `sso_link_shed`. |
| Q87 | (VCDM NB-6, 2026-10-07) Fail-closed link provenance | _Q105: the acceptance takes the lock in its explicit shed step and the reconcile takes it in its own shed._ _Q120: the marker is written only when the endpoint context's route path is the callback route, not for any endpoint context._ _Q114: the shed's own SQL runs no Better Auth hook, so the shed core deletes the markers of the rows it deletes itself; `account.delete.after` still covers the other paths._ Positive provenance: a marker is written for self-service links (`account.create.after` with an endpoint context), keyed by `account.id`, deleted in `account.delete.after` on every path, with a far-future sentinel expiry; every unmarked link counts as admin-recorded and is shed. Link, acceptance and `afterAddMember` take one Postgres advisory lock per user id. Supersedes Q73's admin-side marker. |
| Q88 | (VCDM G7-2, 2026-10-07) Admin-recorded SSO links on admins or owners | Refused with the generic rejection; admin accounts self-link through `/link-social` with step-up. |
| Q89 | (Drift A1, 2026-10-07) Atomicity of acceptance | _**Amended by Q124**: the orphan grace period is measured from the `_user` row's `updatedAt`, not its `createdAt`._ _Q123: the consumption of the token also sets the invitation's status to `accepted`, in the same short `tayzu_auth` transaction, and the token is still consumed last._ Supersedes Q75's single transaction: every step is idempotent, the token is consumed last, and the reconcile repairs orphans; no new dependency. |
| Q90 | (Drift B1, 2026-10-07) A service account's opaque id | The `svc-…` identifier is the id (key metadata `userId`, Cerbos `R.id`, telemetry); no catalog contract change. |
| Q91 | (deletion part moved to 045 by Q103) (Drift C1, 2026-10-07) The bootstrap CLI in production | Operator-run out of band, as in 002, outside the maintenance workflow; stated in D9. |
| Q92 | (Drift C2, 2026-10-07) Password, MFA and email-change notifications (002 Q46) | Deferred to `044` with an explicit ticket and a line in the hand-off table. |
| Q93 | (Drift C3, 2026-10-07) HMAC of the email-cap keys | A task with its own secret `IDENTITY_TOKEN_HMAC_SECRET`; removed from the gates. |
| Q94 | (Drift C5, 2026-10-07) Better Auth static `ac` roles | A note in ADR-0013 that Better Auth `ac` is neutralized and Cerbos stays the only decision point. |
| Q95 | (Drift C6, 2026-10-07) 002 gate items | Each 002 gate item is restated in 043's gates, and task 13.12 adds Dependabot tracking of pinned image digests. |
| Q96 | (Drift D1, 2026-10-07) "Production" for the email sender | `NODE_ENV !== 'test'`, as 002; `dast.sh` exports `EMAIL_PROVIDER=none`. |
| Q97 | (Drift D2, 2026-10-07) Uniform banned and expired-marker sign-in failures | Checked after password verification, matching Better Auth's own ban ordering. |
| Q98 | (Drift D3, 2026-10-07) The `NODE_ENV=test` refusal | In `createAppFromEnv`, with test fixtures on a local host; `loadConfig` tests unchanged. |
| Q99 | (Seventh-pass Open Question 1, 2026-10-07) Recipient-domain allowlist after Q96 | The allowlist applies wherever it is set, and is mandatory only when a real email provider is configured with `NODE_ENV=test`. |
| Q100 | (Seventh-pass Open Question 2, 2026-10-07) A user stranded by a failed acceptance compensation | _Q111 and Q112: a membership left that way keeps an `Invited` `_user` when the shed or the `_user` step failed, which stays rejected; besides this repair, a retry of the same invitation within its 48 hours activates it._ Repaired by an operator, driven by an alert on `invitation_accept_compensation_failed` and a runbook. |
| Q101 | (Seventh-pass Open Question 3, G7-7, 2026-10-07) A separate per-recipient bucket for notices | A task before the mount switch. |
| Q102 | (Seventh-pass Open Question 4, 2026-10-07) The ban hook and `admin_enable` | The ban hook writes only `admin_disable`; re-enabling goes through `setStatus` only. |
| Q103 | (Drift C4, 2026-10-07) Change size against the roadmap budget | _(Row markers refine the list: Q41 and Q49 moved only in part, and Q72 moved too.)_ Org deletion and data retention (the two-phase purge, the deletion marker, the purge and deletion-admin roles, migrations `0012`-`0014`, the reversal and purge jobs and the maintenance workflow) move to a new change, `045-org-deletion-and-data-retention`, which depends on `002` and `043`, gets its own Checkpoint 1 and reviews, and executes after `044` (`002 -> 043 -> 044 -> 045 -> 003`). The decisions about it recorded here (Q14, Q21, Q26-Q27, Q35, Q41, Q48-Q49, Q55, Q59, Q64-Q65, Q68, Q82 and the deletion parts of others) carry over to `045` unchanged. |
| Q104 | (After the Q103 split, 2026-10-07) 043's size against the roadmap budget | Accepted: 043 keeps about 200 tasks, over the ~30-80 budget of `project.md` D9; splitting further would separate tightly coupled parts (invitations, status lifecycle, router authorization, credentials). The overrun is recorded in the proposal. The split choices made while applying Q103 (a minimal operator-run job for the `_user` backfill and reconcile until `045`'s workflow, a short D9 "maintenance scripts", `data-retention.md` created here and extended by `045`, ADR-0019 reserved for `045`, mixed decision rows copied to `045`, and the pending-deletion checks as `045` extensions) are confirmed. |
| Q105 | (Eighth-pass VCDM NB-7, H-2, 2026-10-07) A failed or retried existing-account acceptance must still shed | _Part 1 narrowed by Q118: the deletion covers only a failure before the `_user` step; after it, a failure deletes nothing and a retry completes the acceptance._ Four parts: (1) the existing-account path records whether `addMember` created the membership and, if a later step fails before the token is consumed, deletes it (idempotently, logging `invitation_accept_compensation_failed` if the delete fails); (2) the acceptance runs the shed, with its session revocation and under the per-user lock, as an explicit idempotent step on every attempt once the membership exists, including when `addMember` was already done, before the token is consumed, and a shed failure fails the attempt (the hook keeps its shed for other membership paths); (3) `resolveContext` admits a human only when `_user.status` in the active tenant is `Active` (deny unless `Active`, like the machine branch), amending the D13 rule of Q25, Q46 and Q77; (4) the reconcile runs the shed before creating a `_user` for a member whose user holds two or more memberships. |
| Q106 | (Eighth-pass VCDM G8-1, G8-2, H-1, 2026-10-07) Session paths the shed still misses | _Extended by Q115: the callback also fails closed when it recorded no account, `account.updateAccountOnSignIn` is pinned, and a failed post-commit revocation of the accepting session is logged as `catalog.security.accepting_session_revocation_failed`._ _Applied consistently by the tenth amendment (no new decision): a shed that removes a link at acceptance records the session it kept, and the acceptance that commits revokes that session and its own, so a retry whose own shed removes nothing still revokes them (task 8.5m); the attempt that fails after its `_user` step and is never retried is the tenth amendment's Open Question 1._ _**Amended by Q122** (the answer to that question): on the existing-account path every attempt revokes the accepting session and the recorded one as soon as its `_user` step has run, before the `emailVerified` write and the consumption of the token, and deletes the record after a successful revocation; "after the acceptance commits" below no longer holds for it._ One task before the mount switch: the SSO callback refuses to create a session through an account that no longer exists, or that is unmarked while its user belongs to two or more tenants; the shed sweeps the user's sessions a second time after its deletion commits; and when the shed removed a link, the accepting session is also revoked after the acceptance commits (amends Q86's exemption, since the accepting session may itself have come through the shed link). |
| Q107 | (Eighth-pass drift B-1, 2026-10-07) `_user` emails in catalog spans | _Extended by Q113 to the `catalog.audit.mutation` log event, and by Q119 to the Cerbos `resource.id` of a `_user` entity, the referrer redaction and the catalog `_user` routes' HTTP paths._ A 043 task: the catalog pipeline does not export `tayzu.catalog.entity.identifier` for reserved `_user` entities (omitted or replaced by a fixed placeholder), with a contract test; it also covers 002's existing sync. Latent in 002 (`userSync` is not wired in `createApp`) and reached by 043. |
| Q108 | (Eighth-pass drift B-2, 2026-10-07) The inviter re-check at acceptance | Cerbos decides it: a `user`/`invite` check with the inviter as the principal (roles from the member row, tenant from the invitation), keeping 002 D2's single decision point. |
| Q109 | (Eighth-pass drift B-3, 2026-10-07) `assertRuntimeRole` and `machine_credential_revocation` | A small 043 task beside migration `0011`: the startup assertion also fails when the runtime role owns `machine_credential_revocation`; `045` task 2.4 keeps only the marker table. This removes 043's last dependency on `045`. |
| Q110 | (Eighth-pass VCDM G8-12, 2026-10-07) `users.create` for an email with a pending invitation in the same tenant | `create` cancels that invitation with the reason `user_created`. |
| Q111 | (Eighth-amendment Open Question 1, 2026-10-08) May the first-sign-in hook activate a second tenant's `_user` without the shed? | No. The hook writes `first_sign_in` only for a user with exactly one membership; for a user of two or more tenants it writes nothing, so the resolver keeps rejecting that `_user` (Q105 part 3). The repair paths for such a row are a retry of the same invitation within its 48 hours (the acceptance sheds on every attempt) or Q100's operator repair; a new invitation, the membership hook and the reconcile do not reactivate an existing membership. |
| Q112 | (Ninth-pass VCDM G9-1, 2026-10-08) Order of `_user` activation and the shed | _Q120: the context carries the acceptance's `(tenantId, userId)`, and the hook skips only for that member._ Inside the acceptance's shared context, `afterAddMember` makes no `_user` write; the acceptance's own `_user` step runs after the shed, fail-closed. On the other membership paths the shed port runs before the `_user` write. A new membership therefore stays inert (Q105 part 3) until the links are gone and the sessions revoked, and the "shed failed, then compensation failed" residual becomes the fail-closed `Invited` case of Q111. A seam test calls `set-active` for the joined tenant between `addMember` and the shed and expects the resolver to reject it. |
| Q113 | (Ninth-pass drift N1, 2026-10-08) `_user` identifiers in `catalog.audit.mutation` | _Extended again by Q119 (the Cerbos resource id and the catalog `_user` routes' HTTP paths)._ Q107 is extended to that log event: for a `_user` resource, `tayzu.catalog.resource.identifier` carries the same fixed placeholder; tasks 4.1d and 15.4 cover it, and `docs/catalog/catalog-core.md` records the amendment to 001's audit contract. The change-event row (found by `tayzu.tenant.id` and `tayzu.catalog.change_event.seq`) keeps the identifier in the database. |
| Q114 | (Ninth-pass drift N3, 2026-10-08) The shed without `BETTER_AUTH_SECRET` | One shed core in `apps/api` works directly on the `tayzu_auth` pool with parameterized SQL inside the `withUserLock` transaction: it deletes the unmarked `account` rows and their markers, deletes the user's `session` rows and emits the events. All three shed paths use it; the reconcile builds no Better Auth instance and holds no `BETTER_AUTH_SECRET`. Valid because no secondary storage or cookie cache is configured, so a deleted session row is a revoked session; a test pins that configuration. |
| Q115 | (Ninth-pass VCDM, 2026-10-08) The remaining low gaps | _**Q122**: G9-5's "post-commit revocation" is a revocation as soon as the acceptance's `_user` step has run; its failure is still logged and does not undo the join._ Folded into existing tasks: G9-2 (the stale group number in `docs/security/attack-surfaces.md`, task 16.6), G9-3 (the SSO callback fails closed when no account id was stashed, and 8.5g pins `account.updateAccountOnSignIn`), G9-5 (a failed post-commit revocation of the accepting session is logged and in the runbook and the alerts ticket), G9-6 (a declared `catalog.security.identity_conflict_refused` event with a bounded reason and opaque ids, emitted by 13.2b and 13.3). G9-4 and G9-7 become tickets TK9-2 and TK9-1. |
| Q116 | (Ninth-amendment Open Question 1, 2026-10-08) Actor of an invitation acceptance and of the bootstrap | The acceptance names the invitee (`tayzu.actor.type` `user`, `tayzu.actor.id` the invitee's Better Auth id, the same id as `onBehalfOf` of the `_user` write). The bootstrap names the operator's opaque id, required from the environment, validated, and recorded as `tayzu.identity.operator.id` (D9's mechanism). |
| Q117 | (Ninth-amendment Open Question 2, 2026-10-08) What `catalog.audit.user_status_changed` records | Every status change, each naming the principal its write already has: the admin, the operator id, the user on first sign-in, the invitee on acceptance (Q116), and no actor for the ban hook. The event also carries the bounded status event (for example `first_sign_in`, `admin_disable`), so a self-activation is distinguishable from an admin action. |
| Q118 | (Tenth-pass VCDM G10-1, 2026-10-08) A failure after the acceptance's `_user` step | On the existing-account path, once the attempt's `_user` step has run (always after the shed), a later failure no longer deletes the membership: the attempt fails, the token stays valid, and a retry completes the acceptance. Compensation applies only to failures before the `_user` step. |
| Q119 | (Tenth-pass VCDM G10-2, drift D-2 and D-3, 2026-10-08) `_user` emails in Cerbos decision logs and catalog HTTP spans | _Fourteenth amendment (consistency fix, no new decision): "other blueprints keep their identifiers" below means, for the Cerbos requests, that every other blueprint's single-entity checks (the operation's own check and `mayUpdateReferrer`) keep their identifiers, the redaction batch being positional for every blueprint (Q130), and, for the routes, that other blueprints' routes keep their paths._ _Q125: the positional ids rewrite the existing case of `packages/authz/src/redaction.test.ts` (task 4.1d), and the PR calls it out._ Q107 and Q113 are extended: for `_user` entities the catalog sends the fixed placeholder as the Cerbos `resource.id` (no `catalog_entity` policy reads `R.id`), `redactUnreadable` uses positional ids, and the D16 route-template rewrite also covers the catalog entity routes whose `{blueprint}` is `_user` (`/v1/blueprints/_user/entities/{entity}`, `/status`, `/related`); other blueprints keep their identifiers. D3's claim is corrected; tasks 4.1d, 15.4 and 15.5 cover it. |
| Q120 | (Tenth-pass VCDM G10-3, 2026-10-08) The acceptance's shared context | The identity context carries the acceptance's `(tenantId, userId)`, and the ports skip only for that member; the self-link marker write checks the callback route path. A test each in 8.1e and 8.5g. |
| Q121 | (Tenth-pass VCDM G10-4, 2026-10-08) The high audit advisory on master | Fixed outside 043 by a `pnpm.overrides` entry `source-map-js` `^1.2.2` (commit `c133f21`), documented in `docs/security/dependencies.md`; task 16.9 is unblocked. |
| Q122 | (Tenth-amendment Open Question 1, 2026-10-08) What runs when an existing-account attempt fails after its `_user` step and is never retried | _**Extended by Q127** on the new-account path: the notice is sent after the acceptance commits or when the consumption changes no row (D4 step 1), which compensates nothing, whether or not the attempt's own `_user` step activated the row; only a compensated failure sends none, so "the admin notice stays after the commit" below now also covers a zero-row consumption. The existing-account rule below is unchanged._ Option 1. On the existing-account path both actions run as soon as the attempt's `_user` step has run, before the `emailVerified` write and the consumption of the token: every attempt revokes its own accepting session and the session an earlier attempt's shed recorded (task 8.5m) when its shed removed a link or a record exists, and deletes the record after a successful revocation; the attempt whose `_user` step activated the row sends the admin notice (a retry's step writes nothing, so no second notice is sent). On the new-account path the admin notice stays after the commit, because a failure there still compensates the whole join (D4 step 3). This also covers a token delete that removes zero rows because a concurrent resend replaced the digest, which the flow cannot tell from a lost race. Amends "after the acceptance commits" in Q106 (and the Q86 annotation), D4 steps 4 and 7 and the "Notice emails" paragraph, and the "post-commit revocation" of Q115 and D12. Residual, documented in Risks: a crash between the activation and the notice loses the notice. |
| Q123 | (Eleventh-pass VCDM G11-1, 2026-10-08) How the acceptance records that an invitation was accepted | _**Twelfth amendment and Q127**: an `accepted` write that changes no row takes the lost-race path of D4 step 4 (Q122's handling of a consumption with no winner), and on the new-account path that consumption sends the admin notice (Q127); "does not interact with Q118 or Q122" below means only that their rules are unchanged._ _**Q128**: the skips of resend, cancel and the disable-time cancellations are best-effort against an acceptance that commits between their `pending` read and their write, a documented residual (D4 "Resend", Risks; ticket TK12-1)._ _**Q129**: an admin's cancel of an invitation that is not `pending` is refused like the resend, `CATALOG_VALIDATION_FAILED` with the same fixed message, nothing changed and nothing logged; the internal cancellations only skip._ The acceptance sets the Better Auth invitation's status to `accepted` in the same `tayzu_auth` transaction as the digest-conditioned token delete: one tenant-keyed write in `auth-repository.ts`, conditioned on the status still being `pending`; a zero-row result keeps the lost-race handling. Resend, cancel and the `user_disabled` and `inviter_disabled` cancellations skip any invitation that is not `pending`, an accepted invitation no longer counts toward the pending limit, and a replay is logged as `already_accepted`. Tests in 8.3 and 8.10, plus a resend-after-acceptance case. Keeps Q89's "the token is consumed last" and does not interact with Q118 or Q122. |
| Q124 | (Eleventh-pass VCDM G11-5, 2026-10-08) Start of the orphan grace period | Q84 and Q89 are amended: the one-hour grace is measured from the `_user` row's `updatedAt` (its activation, `packages/catalog/src/persistence/schema.ts:100`; _the entity table's column is at `:173`, `catalogEntity.updatedAt`, and `:100` is the blueprint table's, a line reference corrected without changing the decision_), not its `createdAt`, so a failed new-account acceptance of an invitation older than one hour stays protected while a retry is in flight. A 4.2b case covers it. |
| Q125 | (Eleventh-pass drift N-1, 2026-10-08) Q119's positional ids against the existing 002 redaction test | _**Extended by Q130**: the same rewrite covers the catalog's redaction fixture `packages/catalog/src/service/__fixtures__/redaction-authz.ts` (for the fixture, only its header comment; Q130 annotated) and the `batches[].ids` assertions of `entities-delete.int.test.ts`, `blueprints.int.test.ts` and `blueprints-update.int.test.ts`._ The existing case in `packages/authz/src/redaction.test.ts` is rewritten: its mock decides by position, and its assertion (`:61-63`) changes from "the request ids equal the candidate ids" to "the ids are positions and no candidate id is in the request", which is stricter, not looser. Task 4.1d names the rewrite and the PR calls it out, as Q76 and Q77 did. |
| Q126 | (Tenth-amendment choice, confirmed 2026-10-08) Subject of the `created_invited` status event | The `catalog.audit.user_status_changed` event of the invitation hook's `created_invited` write identifies its subject by `tayzu.identity.invitation.id`, because an invited email may have no Better Auth user yet; every other write names `tayzu.identity.user.id` or, for a service account, `tayzu.identity.service_account.id` (Q117). |
| Q127 | (Twelfth-amendment Open Question 1, 2026-10-09) The admin notice of a new-account attempt whose consumption changes no row | _Fourteenth amendment (consistency fix C-7, no new decision; the residual was named by the thirteenth amendment's third consistency pass): a third residual, a duplicate notice when a new-account attempt and a concurrent existing-account attempt of the same invitation each send it, is named in Risks and D4 step 6; ticket TK12-1 would close it._ Option 1. On the new-account path the notice is sent after the acceptance commits (the token consumed) or when the consumption changes no row (D4 step 1), which compensates nothing and leaves the join standing; a failure that is compensated (D4 step 3) sends none. On the new-account path this holds whether or not the attempt's own `_user` step activated the row, so a new-account retry after a compensated failure still announces the join; the existing-account path keeps Q122's rule (the attempt whose `_user` step activated the row sends it). Task 8.15 adds a new-account `admin` attempt whose token delete removes zero rows because a resend replaced the digest after its `_user` step, sending exactly one notice, and the acceptance with the resent token sending none. Residuals, in Risks: a crash between the zero-row consumption and the notice loses the notice (as in Q122), and an attempt compensated on the new-account path whose retry runs the existing-account path, because an account for the email was created meanwhile, sends no notice (twelfth-pass VCDM G12-2). |
| Q128 | (Twelfth-amendment Open Question 2, 2026-10-09) The window between the `pending` check of resend and cancel and the acceptance's `accepted` write | _Fourteenth amendment (consistency fixes, no new decision): "the cancel race of the twelfth-pass VCDM G12-1" below excludes its `re_invite` variant, because Better Auth makes the re-invite cancellation inside `createInvitation`, outside TK12-1's lock, so that variant keeps its window (Q42; Risks, Tickets). "No task changes" below means that no task gains a race case: tasks 7.6, 7.7 and 8.10 cite the residual._ Option 1: accepted as a documented residual. D4 "Resend" and Risks state it, the spec qualifies the two requirements with "except for a cancel or resend that races the consumption (Risks)", and no task changes. The structural fix is ticket TK12-1: one per-invitation lock (extending TK9-2's advisory lock) taken by the acceptance after its token verifies and held until the consumption commits, and by resend, the admin cancel and the `user_created`, `user_disabled` and `inviter_disabled` cancellations before they read `pending`; it would close this window, the cancel race of the twelfth-pass VCDM G12-1 and TK9-2, at the cost of one `tayzu_auth` connection per in-flight acceptance. Better Auth's re-invite cancel keeps its window either way (Q42). |
| Q129 | (Twelfth-amendment Open Question 3, 2026-10-09) What an admin's cancel of an invitation that is not `pending` answers | Option 1: refused like the resend, `CATALOG_VALIDATION_FAILED` with the same fixed message, nothing changed and nothing logged; the internal cancellations (`user_created`, `user_disabled`, `inviter_disabled`) answer nothing and only skip. A missing or foreign invitation still answers `CATALOG_NOT_FOUND` (D14). Under Q128 the refusal is best-effort inside the race window. Task 8.10 asserts it. |
| Q130 | (Twelfth-pass drift N12-1, 2026-10-09) Q119's positional ids against the catalog's 002 redaction fixture and integration tests | _Fourteenth amendment (consistency fixes, the thirteenth drift-check's N13-1 and N13-2 and its own drift-check's N14-1, no new decision): "it decides by position" below means that the fixture keeps answering by the `resource.id` it receives, which for the redaction batch is now a position, and the tests pass it the readable positions together with the identifiers of single-resource checks that keep theirs (in `entities-delete.int.test.ts`, `team-a`, the deleted entity's own check, which the fixture also answers; its `readable.has(resource.id)` already works with such a mixed set, so its answering logic is unchanged and only its header comment changes, to say that it answers every all-`catalog_entity` batch by the `resource.id` it receives: an entity operation's own check and `mayUpdateReferrer`'s by identifier (the fixed placeholder for a `_user` entity, Q119), the redaction batch by position, while a blueprint operation's own `catalog_blueprint` check still reaches the real policies; N14-1). "Deterministic because ... the blueprint tests seed known lists" below holds for `entities-delete.int.test.ts` (`selectSpecReferrers` orders by identifier) and `blueprints.int.test.ts` (`selectBlueprintEntityIdentifiers` orders by identifier), not for `blueprints-update.int.test.ts`: `seedEntity` gives each row a `randomUUID()` id and the compatibility check streams entities `order by id`, so that test derives the readable positions from the seeded rows read back in `id` order (the stream order), with no helper or production code change (task 4.1d; G13-1)._ Q125 is extended to `packages/catalog/src/service/__fixtures__/redaction-authz.ts` (it decides by position; the tests pass the readable positions, which are deterministic because `selectSpecReferrers` orders referrers by identifier and the blueprint tests seed known lists), `entities-delete.int.test.ts`, `blueprints.int.test.ts` and `blueprints-update.int.test.ts`: each `batches[].ids` assertion becomes "the ids are positions and no candidate identifier is in the request", which is stricter, and the `referrers`, `notVisible` and no-leak assertions stay as they are. Task 4.1d names the four files, the PR calls out the rewrite, and the proposal's "one existing `002` unit test" becomes "one unit test, the catalog redaction fixture and three integration tests". |
| Q131 | (Fourteenth-amendment drift N14-2, 2026-10-09) The smoke check's `login_failed` reasons once a banned sign-in logs `account_disabled` | Option 1. Task 15.2 drives a banned local sign-in, and the `002` assertion at `apps/api/src/otel-smoke-check.int.test.ts:1008-1012` changes to the exact set `{bad_credentials, mfa_failed, account_disabled}`, which is stricter: the smoke check then also requires the value `002` declares (`002` design `:1050`) but never emitted. Task 15.2 names the rewrite and the PR calls it out, as Q76, Q77, Q125 and Q130 did. The Observability contract paragraph reads "no contract name or value is added; the smoke check's value-set assertion gains `account_disabled`". |
| Q132 | (Implementation question, task 1.3, 2026-10-09) Source of the bundled common-password denylist of Q22 | SecLists `Passwords/Common-Credentials/Pwdb_top-1000000.txt` (MIT), pinned to commit `27c08068f849227f2fc1c8f7f00afae365957b96` and filtered once into `packages/auth/src/identity/common-passwords.ts`: hashcat `$HEX[...]` entries decoded, NFC, only printable-ASCII entries of 20 to 128 code points (shorter ones already fail the length rule), lower-cased, de-duplicated and sorted (502 entries). Matching is exact, against the candidate after NFC and lower-casing. Source, file digest, license notice and derivation are in the file header and in `docs/security/dependencies.md` ("Bundled data"); the breached-password check of Q23 stays the main control. |
| Q133 | (Implementation question, task 4.4, 2026-10-09) The first-sign-in hook for a member with no `_user` row, and its interaction with the display refresh test of 4.1c | Option 1. For a user with exactly one membership whose `_user` row does not exist, the adapter treats `first_sign_in` as a no-op: it writes nothing and emits nothing, the sign-in succeeds, and the resolver still rejects the member as `user_missing` (Q46, Q105) until the reconcile creates the row (D1). Every other disallowed pair still throws (D2). The display-refresh test of 4.1c ("A member with a _user row has only its display fields updated, the status unchanged") is given a second membership in its setup, so the first-sign-in hook writes nothing (Q111) and the test isolates the refresh again; its assertions stay as they are. Task 4.4's Verify gains a case for a single-membership member with no `_user` row signing in locally: no row is created, no status write and no status event. |
| Q134 | (Implementation question, task 4.5, 2026-10-09) `002`'s ban and unban test against Q102 | Option 1. The `002` test "Disabling a user updates its `_user` entity status: banning sets Disabled, unbanning sets Active again" (`apps/api/src/user-sync.int.test.ts:177`, `002` task 12.2) is **rewritten** to Q102, not loosened: the ban still requires `Disabled`, and after the unban it requires that the status **stays `Disabled`** and that the unban writes nothing (re-enabling through `setStatus` is task 11.2's case). Task 4.5 names the rewrite and the PR calls it out, as for Q76, Q77, Q125, Q130 and Q131. |

## Open Questions

None is open. The ninth amendment's two questions were answered on 2026-10-08 (Q116,
Q117), and the tenth amendment's one question (what runs when an existing-account attempt
fails after its `_user` step and is never retried) was answered the same day with its
recommended option, recorded as Q122 and applied by the eleventh amendment (Context). The
three questions that the twelfth amendment's consistency check raised were answered on
2026-10-09 with their recommended options and applied by the thirteenth amendment
(Context): whether a new-account attempt whose consumption changes no row after its
`_user` step sends the admin notice (Q127: it does, and only a compensated failure sends
none), how the window between the `pending` check of resend and cancel and the
acceptance's `accepted` write is treated (Q128: a documented residual, with the ticket
TK12-1 as its structural fix), and what an admin's cancel of an invitation that is not
`pending` answers (Q129: the resend's `CATALOG_VALIDATION_FAILED`, with nothing changed
and nothing logged). The fourteenth amendment's mechanical fixes raised no question; the
one that its drift-check raised (N14-2: whether the smoke check's `login_failed`
assertion gains `account_disabled` once a banned sign-in logs it) was answered on
2026-10-09 with its recommended option and is recorded as Q131 (Context, fourteenth
amendment).
