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
  parts)) were taken out with it;
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
    Q89**, see the seventh amendment).
  - The identity telemetry names live in a separate identity contract module that
    `otel-smoke-check` also imports; `contract.test.ts` of `002` is untouched
    (Observability contract, Q74). The `_user` is written only by the membership hook,
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
    one-hour grace period (D1, D4, Q89).
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
    existing-account path deletes the membership it created when a later step fails, the
    acceptance runs the shed as an explicit idempotent step of every attempt once the
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
    the accepting session is revoked too, after the acceptance commits, which amends
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
    true today only for `create` (D10); the Gates cite `002` Q58, Q62 and Q84; and the
    stale "pending Q99", "fifteen routes", "lister", "nothing is renumbered" and
    "deletion-marker lookups" texts were corrected.
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
  the ban hook, the sign-in hook) — never reconstructed from raw invitation
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
  re-verification and the ownership items of tasks 13.6-13.6c, the migration and the policy files listed in D3.

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
an unmarked SSO link would otherwise reach the second tenant through it. It is repeatable (a second run changes nothing) and is also the repair
path for a member locked out by the rejection of D13 (`user_missing`), such as one
that predates this change. It also removes an **orphan** (Resolved decisions Q84 and Q89): a
human `_user` that is `Active`, has no membership in its tenant and is **older than a
grace period of one hour** (by its `createdAt`), which a failed acceptance leaves
behind because the `_user` write is on another pool and no transaction spans the two
(D4); `Invited` and `Staged` rows and service accounts are never orphans. The grace
period keeps the reconcile from deleting the row of a member whose acceptance is
still in flight (the `_user` write commits before the membership does). Without the
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
writes through it. `UserSyncPort` has only `upsertUser`, so the hook cannot read the
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
hook receives only `{ member, user, organization }` (`afterAddMember`), so the
identity operation hands the acting admin to it through an `AsyncLocalStorage`
(`node:async_hooks`, no dependency; one store in
`apps/api/src/identity/identity-context.ts`, which also carries the shed context of
D4 step 7) that it runs around its in-process `auth.api` call, and the adapter reads
it. The hook itself lives in `packages/auth/src/auth.ts` and cannot import `apps/api`,
so it never reads the store: the `apps/api` implementations of its ports (the
`UserSyncPort` adapter here and the shed port of D4 step 7) do. Admin-created users start `Active`; `Staged` is the default only for an entity
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
second time; it emits `catalog.audit.user_created` with source `bootstrap`.

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
  of Cerbos's decision logs (`decisionLogsEnabled: true`): only opaque ids are
  ever sent as a resource id. The resource id of each operation is fixed: the literal
  `new` for `invite`, `users.create`, `serviceAccounts.create` and
  `credentials.create` (no resource exists yet; `create` sends `new` today), the
  invitation id for cancel and resend, the Better Auth user id (or the `svc-…`
  identifier of a service account) for `setStatus`, `serviceAccounts.delete` and the
  SSO link and unlink, and the `apikey` id for rotate and revoke.
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
`cancelPendingInvitationsOnReInvite: true` makes re-inviting a single call. The
plugin's default `invitationLimit` of 100 pending invitations per organization
is kept and stated here, and so is its default `membershipLimit` of 100 members per
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
`AsyncLocalStorage` of D2 that it runs around `createInvitation`; the operation makes
no `_user` write of its own (Q76). `afterAcceptInvitation` is
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
   succeeds. There is **no transaction around the acceptance** (Resolved decision
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
   resolver derives from that membership role, through the same mapping, and the
   invitation's tenant) and asks Cerbos for the action `invite` on a `user` resource
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
   need a local password first (Risks). The `_user` write is made by
   `afterAddMember` on the `tayzu_app` pool and **fails closed**: if it throws, the
   attempt fails, the token is not consumed and the compensation below runs, so an
   acceptance never leaves a member with no `_user`. The flow then ensures the `_user`
   explicitly with the same intent (an `Active` row is no write, so the second call is
   a no-op). The attempt **compensates what it created**: if any step after the user
   was created fails before the token is consumed, it deletes, in reverse order and
   each idempotently, the membership, the `_user` and the user that **it** created
   (never one it found), and logs `catalog.security.invitation_accept_compensation_failed`
   if a deletion fails. A retry with the same token therefore starts from nothing;
   without the compensation a retry would meet an existing account and, with no
   session, the uniform rejection, and the invitee would be stuck. A compensation that
   itself fails leaves a user with no membership or an orphan `_user`, which the
   reconcile removes after its grace period (D1, Resolved decision Q89) for the
   `_user`; a stranded user is an operator repair (Q100).
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
   It then adds only the membership with the invited role, activates the `_user`
   through `invitation_accepted` and sets `emailVerified` on the user (Q38: the
   token proves the mailbox). It **records whether its `addMember` created the
   membership** (an `addMember` that finds the user already a member is treated as done
   and as not created by this attempt), and then runs the shed of step 7 as an explicit
   step (Resolved decision Q105). **It compensates what it created** (Q105): if any step
   after the membership was added fails before the token is consumed (the `_user` write,
   the shed, the `emailVerified` write), it deletes the membership that this attempt
   created, idempotently, and never one it found, and it logs
   `catalog.security.invitation_accept_compensation_failed` if the deletion fails. A
   retry with the same token therefore adds the membership again and runs the shed
   again; without the compensation a retry would find the membership, treat it as done,
   never reach the hook and succeed with no shed. The `_user` it activated is not reverted: a retry finds it `Active` (no
   write), and without a retry it is an orphan for the reconcile (D1). A lost consume
   race compensates nothing, as on the new-account path, because the winner may rely on
   the membership the loser created. It never touches the password or the active
   organization, and it touches a linked account and the user's sessions, the request's
   own session included once the acceptance has committed, only to shed the
   admin-recorded SSO links of a user who now belongs to a second tenant (step 7); a `password` field
   in the body is ignored on this path. Success has the same status and
   body shape on both paths, and every failure of (a)-(d) answers the uniform
   rejection below, so a caller without a valid token learns nothing about
   whether an account exists. A caller who holds a valid token holds the
   mailbox, and that is the accepted extent of what the response can reveal.
5. _Errors._ Every rejected acceptance (nonexistent invitation, wrong state —
   expired, cancelled, rejected, already accepted — wrong token, a `Disabled` user, no session or a mismatched session for an
   existing account, a lost concurrent account creation) returns the same
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
   include `csrf_rejected`, `origin_rejected`, `inviter_not_active_admin` and
   `member_limit`.
6. _Admin notice (Resolved decision Q39)._ A new-account `admin` invitation is
   protected only by mailbox control at acceptance (a mistyped or hijacked
   address would yield a tenant admin who then enrols their own factor), a
   residual that is accepted. So when an invitation whose role is `admin` is
   accepted, on either path, the fixed `AdminAcceptedNotice` (D5) is sent to the other
   administrators of the organization, resolved on the server and through the
   notice controls below (Resolved decision Q53). The recipients include
   administrators whose `_user` is `Disabled`: a rogue admin could otherwise disable
   the others first and so silence the notice. A send
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
   account whenever it fires with an endpoint context, which is every link the user
   makes through `/link-social` or the SSO callback. `linkSsoAccount` goes through the
   internal adapter with no endpoint context, so its link carries **no marker**. The
   marker's identifier is `sso-link:<accountId>` where `<accountId>` is the
   **`account` row's own `id`**, not the provider's `accountId` column (which holds the
   SSO `sub`); its value is the constant `self` (no email, no tenant); and its
   `expiresAt` is a far-future sentinel, so Better Auth's cleanup of expired
   verification rows never removes it and a link never becomes admin-recorded by
   ageing. `databaseHooks.account.delete.after` deletes the marker for **every**
   deletion path (the user's own `/unlink-account`, an admin unlink and the shed), so a
   later link of the same `sub` cannot inherit a stale marker. If the marker write
   fails, the hook deletes the `account` row it was written for (Better Auth has
   already inserted it when `create.after` runs, and no transaction would undo it), logs
   `catalog.security.sso_link_marker_failed` and throws, so the link fails and the state
   agrees with the failed response; and because an unmarked link counts as
   admin-recorded, a crash between the link and its marker is **fail-closed by
   construction**. A link that pre-dates this change has no marker and is shed too, and
   its user re-links through `/link-social`.

   The marker is sound only while every account created with an endpoint context is a
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
   acceptance sets the shared context of D2, inside which the hook leaves the shed to
   the acceptance's own step, which reports the path `acceptance`. **`afterAddMember`
   keeps its shed for every other membership path** (path `membership_hook`), and **the
   reconcile runs it** before it creates a `_user` for a member of two or more tenants
   (D1, Q105; path `reconcile`). Idempotent means a re-run deletes the unmarked links
   that remain and does nothing more when none remains. **Sessions are revoked** (Q86,
   amended by Q106) whenever the shed removed a link: a session issued through the link
   would otherwise reach the second tenant through `/organization/set-active` once the
   membership exists, with the link already gone, and an SSO step-up of an `admin` is
   delegated to the identity provider, so it passes for the holder of the old `sub`.
   The shed therefore revokes every session of the user, not filtered on `ssoSid`
   (`002` Q83 admits SSO sessions created without one), and emits
   `auth.security.session_revoked` with the new reason `sso_link_shed` for each, through
   the `emitSessionRevoked` that `@tayzu/auth` exports for it (D13); it
   **sweeps the sessions a second time after its deletion commits**, so a session that
   a callback created through the link while the deletion was in flight is revoked too
   (Q106). On the acceptance path the session that carries the acceptance request is
   kept while the acceptance runs and, when the shed removed a link, **is revoked after
   the acceptance commits** (Q106, which amends Q86's exemption: the accepting session
   may itself have come through the shed link), so the user signs in again. An admin
   `unlinkSsoAccount` revokes every session of the target for the same reason and emits
   the same event. The cost, a re-sign-in on the user's devices when they join a second
   tenant with a link they did not make, is accepted. The deletion goes through the
   internal adapter inside the shared context, so the account hook's own
   `auth.security.account_unlinked` with actor `self` is not emitted for it: the shed
   is attributed by `sso_link_shed` alone.

   **Where the shed runs.** The hooks live in `packages/auth/src/auth.ts`
   (`afterAddMember` in the `organization` plugin's `organizationHooks`, the account
   hooks in `databaseHooks`), and `@tayzu/auth` cannot import `apps/api`. So the shed,
   with its session revocation and `withUserLock`, is implemented in `apps/api`
   (`apps/api/src/identity/sso-link-shed.ts`, Resolved decision Q30), and `afterAddMember`
   reaches it through a structural port, `SsoLinkShedPort`
   (`packages/auth/src/identity/ports.ts`), which `createAuth` takes as the option
   `ssoLinkShed` the way it takes `userSync`; `createApp` and the bootstrap CLI pass it.
   The hook calls the port after its `_user` write, and the port's implementation reads
   the shared context of D2 and returns without shedding inside an acceptance. The
   acceptance's explicit step and the reconcile call the same implementation directly.
   The marker hooks and the callback check below need nothing from `apps/api`: they stay
   in `auth.ts` and read and write `auth.verification`, `account` and `member` through
   the hook's own adapter context.

   **The SSO callback refuses a session through a shed link** (Q106). A callback that
   read the account before the shed deleted it could otherwise still create its
   session afterwards. The callback's `session.create.before` therefore re-reads the
   account the callback signed in through (for example, the callback's
   `account.update.after`, which Better Auth runs for the token refresh before the
   session is created, stashes the account row's id for the request) and refuses to
   create the session when that account no longer exists, or when it has no marker
   while its user belongs to two or more tenants, with the callback's one uniform
   rejection, so no session is created.

   **One advisory lock per user** (Q87) closes the race between a link and a join:
   `linkSsoAccount` takes it around its membership check and its link, and the shed
   takes it around its read and its deletion, so a link that commits after a join's
   shed cannot exist (the join's membership commits before the shed takes the lock, so
   a later link sees two tenants and is refused, and an earlier link is shed). Every
   path takes the lock through the shed, exactly once: the acceptance in its explicit
   shed step, after `addMember` has returned (inside the shared context the hook does
   not shed, so the lock is never taken twice), `afterAddMember` on the other membership
   paths, and the reconcile (Q105). The lock is
   a `pg_advisory_xact_lock` on a key derived from the user id, held by a short
   dedicated `tayzu_auth` transaction for the length of the critical section.

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
is suppressed or truncated never blocks the operation that triggered it (the
acceptance has already committed) and
is logged as `catalog.security.notice_suppressed` with the template, the
suppression reason (`global`, `tenant`, `recipient` or `truncated`) and the number
of emails dropped.

**Resend.** `identity.users.resendInvitation` does **not** call Better Auth's
`inviteMember` with `resend: true`, because that resets `expiresAt` to now + 48
hours. It replaces the token digest in `auth.verification` for the same
invitation, keeps its `expiresAt`, and sends the email.

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
- _Alternative:_ allowlist the native accept route (reopens the gap D18 closed),
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
- **Sender selection** (Resolved decisions Q67, Q80 and Q96). The provider is chosen
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
create the `_user` entity with `status: Active` (no invitation), role `member`
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

The viewer returns a page of at most **200** entries, the credential cap of D8, with
the non-revoked credentials listed before the revoked ones and `truncated: true` when
revoked ones were left out, so no credential a tenant can hold is hidden from an admin
who must revoke it in an incident (a tenant holds at most 200 non-revoked). Every
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
  secret once. If the revoke fails, the new key is revoked as compensation so no
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
and `tayzu_app`, and no other role. Each script also
**asserts its own database role** at start (`current_user` against the role or roles it
declares), through the helper of task 2.0, and refuses to run otherwise: `002`'s
runtime-role assertion runs only in `createAppFromEnv` (`002` Q62), which no script goes
through. The scripts read a **separate configuration loader** (task 2.0b: `loadConfig`
requires `DATABASE_URL`, `AUTH_DATABASE_URL`, the secret and Cerbos for every caller,
which a script that holds one role cannot supply), and **each script starts telemetry,
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
Q70) is supplied through the job's environment and validated against the catalog's id
pattern (`[A-Za-z0-9_.:-]{1,128}`, never an email); the script refuses to run without
it. The id is not authenticated here: it is what the operator who starts the job sets,
and the PIM record and the named approver are the control. **The bootstrap CLI** stays
out of band as in `002`: an operator runs it once per environment, with no job and no
role of its own; it builds Better Auth the way `createApp` does, with the `tayzu_auth`
and `tayzu_app` pools (task 4.6b), under just-in-time access like any other operator
access, and the first-deployment runbook records that.

**How `045` extends this.** `045` adds the reviewed `workflow_dispatch` workflow
(Resolved decision Q41), which becomes the only way the backfill, the reconcile and its
own reversal script start in production, and derives the operator id from the workflow's
authenticated actor (`gh:<numeric GitHub actor id>`, Q70) instead of the environment an
operator sets by hand. The scripts themselves do not change. The ordering constraint
stays here: the backfill and the reconcile run once per environment, after the code that
reads `accountKind` is deployed and before the release that carries the `user_missing`
rejection (D13) serves traffic in an environment that has members, and before the mount
switch is turned on (Gates, Migration Plan).

### D10. API contract

**Thirteen oRPC procedures and one plain Fastify route** on the server `002`
exposes: fourteen routes, all mounted behind the switch of D15 (`045` adds a
fourteenth oRPC procedure, `identity.organization.delete`). Each oRPC
procedure declares `.route({ method, path, spec: markHighRisk, inputStructure: 'detailed' })`
like `packages/catalog/src/api/contract.ts` (every identity procedure sets
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

**What step-up means over HTTP** (`002` Q43, Q51), because the tests must match:
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
and what their windows mean (Q66), the cross-tenant denial-of-invitation trade-off and
ACS data location and retention; the email policy (the recipient-domain allowlist, Q67
and Q96, and the demo-tenant list, Q80); the off-boarding step for a disabled admin's
service accounts and credentials (listed by the `createdBy` of the viewer); the `_user`
reconcile runbook; the operator repair of a user stranded by a failed acceptance
compensation, driven by the alert on `invitation_accept_compensation_failed` (Resolved
decision Q100); `045` extends the file with the retention policy, the erasure
statement and the reversal runbook), updates `docs/security/secrets.md` (the
Communication Services secret and its change procedure, the `IDENTITY_TOKEN_HMAC_SECRET`
of the cap keys with its owner and rotation (a rotation resets the recipient buckets,
Resolved decision Q93), the bootstrap CLI's out-of-band run (Q91), the kill switch and
its emergency flip, the `tayzu_auth` secret of the backfill and reconcile jobs, each job
with its own identity, with owner and rotation, the credential lifecycle),
`docs/security/attack-surfaces.md` (the fourteen routes, the public accept route and its
session binding, the inert link, and the mount gate state; it currently lists
`identity.*` as not mounted), `docs/security/crypto-inventory.md` (the invitation token,
the SHA-1 prefix sent to the Pwned Passwords range query as a protocol-mandated
exception (Resolved decision Q81), the HMAC-SHA256 of the per-recipient cap key and the
authentication to ACS) and `docs/security/dependencies.md` (license, `allowBuilds` and
SBOM review of `@azure/communication-email` and its transitives, the pinned image
digests, and the source and license of the bundled common-password denylist),
`docs/catalog/auth-and-rbac.md` (`002` D17: the resource-kind taxonomy, the telemetry
reference, the amended rate-limit scope enum and the amended reason enum of
`auth.security.session_revoked`), `docs/catalog/catalog-core.md` (its `## Telemetry`
section: the fixed placeholder that a catalog span carries instead of a `_user`
identifier, Resolved decision Q107, task 4.1d), and `docs/architecture/system-diagram.md`
(new external actors: the email provider, the invitee with their mailbox, the platform
operator; new arrows: invite → email, the public accept route, ACS egress over HTTPS, the
Pwned Passwords range query and the reconcile job).

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
  organization is that tenant** (each revocation emits `002`'s
  `auth.security.session_revoked` with the reason `admin_action`, as does the ban's
  deletion of all sessions; `emitSessionRevoked` is private in `auth.ts` today, with
  its reason fixed to `password_change`, so `@tayzu/auth` exports it from its index with
  the reason as a parameter, `password_change`, `admin_action` or `sso_link_shed`, task
  8.5h), and cancels the user's pending invitations of
  that tenant (reason `user_disabled`) **and the pending invitations that user
  created** (reason `inviter_disabled`, Resolved decision Q63; the acceptance check
  of D4 is the authoritative control and also covers a user disabled by a path that
  does not cancel, such as the ban hook); `Active` writes the status back,
  restores no cancelled invitation and, for a user whom the disable banned (a single
  membership), clears `banned` through `internalAdapter.updateUser({ banned: false })`
  (the ban hook is skipped without an endpoint context, and since Q102 it writes
  nothing for `banned: false`). Only for a user with a **single**
  membership does the disable also set `banned` (and delete all their sessions), because
  a global ban would lock the user out of another tenant (a member of two tenants
  cannot otherwise be off-boarded by one tenant's admin, and removing a member is
  out of scope, Non-Goals; ticket "Member management"). The ban is made through the internal adapter
  (`internalAdapter.updateUser({ banned })` and `deleteUserSessions`, as
  `linkAccount` does in `identity-router.ts`), **not** Better Auth's
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
  the status, code and body of a wrong password; there is no session to delete. The
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
  sign-in just created. The
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
  `tenantId`** (a call without one does not type-check and fails at runtime; a
  `session` is filtered by `activeOrganizationId`). `user` and `account` hold no
  tenant, so the module reads them only through functions named `global…` for the
  reads that are global by nature (does this email have an account, which provider
  accounts does this user have), and a target that must belong to the tenant is read
  through a membership check. An ESLint rule
  bans direct adapter access to those six models from the identity code
  (`apps/api/src/identity/**` and `identity-router.ts`, whose `authorizeTarget` reads
  `member` today) outside that file, spreading the existing `no-restricted-syntax`
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
  invitation record (D4), never from the request.
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
the process. Because `/v1/*` is one catch-all, no route template exists
upstream: the template is **computed by matching the parsed pathname** (the guards of `002`
read the parsed pathname, `002` Q74, never the raw request target) **against the fourteen paths of D10**. The marker test runs through the real HTTP
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
`@tayzu/auth` (like `emitAccountLinkEvent`: a span helper and a metric recorder over
the `@tayzu/auth` tracer and meter), because `apps/api` has no `@opentelemetry/api`
dependency and the design names no new one. The maintenance scripts start telemetry and flush it before
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
placeholder of Q107 only on the **catalog** spans, whose rule is per blueprint (below). `tayzu.identity.operator.id` is the
platform operator's opaque identifier, supplied through the maintenance
job's environment here (D9) and never an email; `045`'s workflow derives it from its
authenticated actor (Q41): `gh:<numeric actor id>`. In every audit event
`tayzu.actor.id` is the **admin** who acted (the `onBehalfOf` of the `system`
write, Resolved decision Q10), never the `system` actor.

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
| `catalog.audit.invitation_accepted`               | INFO     | same, plus `tayzu.identity.user.id` and `tayzu.identity.invitation.path`                                                                                                                                                                                                                                    | Audit                                                                                                            |
| `catalog.audit.invitation_cancelled`              | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.invitation.id`, `tayzu.identity.invitation.reason`                                                                                                                                                                                                                                          | Audit                                                                                                            |
| `catalog.audit.invitation_resent`                 | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id`                                                                                                                                                                                                                                         | Audit (new)                                                                                                      |
| `catalog.audit.user_created`                      | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id`, `tayzu.identity.user.role` (`member`\|`admin`), `tayzu.identity.user.source` (`admin`\|`bootstrap`)                                                                                                                                          | Audit for `identity.users.create` and bootstrap (`002` Q42, new)                                                 |
| `catalog.audit.user_status_changed`               | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.user.id` (a human's Better Auth user id) or, in its place when `tayzu.identity.user.account_kind` is `service`, `tayzu.identity.service_account.id` (the `svc-…` identifier, Q90), `tayzu.identity.user.status.from`, `tayzu.identity.user.status.to`, `tayzu.identity.user.account_kind` | Audit of every status change, including service accounts disabled and enabled (new)                              |
| `catalog.audit.service_account_created`           | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.service_account.id`                                                                                                                                                                                                                                    | Audit                                                                                                            |
| `catalog.audit.service_account_deleted`           | INFO     | same                                                                                                                                                                                                                                                                                                        | Audit (new)                                                                                                      |
| `catalog.audit.credential_created`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.id`, `tayzu.identity.credential.kind`                                                                                                                                                                                                       | Audit (`002` Q42, new)                                                                                           |
| `catalog.audit.credential_rotated`                | INFO     | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id`, `tayzu.identity.credential.new_id`                                                                                                                                                                                                 | Audit — opaque IDs only, never secrets                                                                           |
| `catalog.security.authz_denied`                   | WARN     | as already declared by `001`/`002`                                                                                                                                                                                                                                                                          | Reused: the identity router now emits it on every Cerbos deny (it threw silently before)                         |
| `catalog.security.invitation_acceptance_denied`   | WARN     | `tayzu.identity.invitation.id` (the constant `invalid` for a malformed id, D4), `tayzu.identity.invitation.denial_reason` (`malformed_request`\|`expired`\|`cancelled`\|`rejected`\|`already_accepted`\|`token_mismatch`\|`disabled_user`\|`not_found`\|`session_required`\|`email_mismatch`\|`account_conflict`\|`csrf_rejected`\|`origin_rejected`\|`inviter_not_active_admin`\|`member_limit`) | Misuse of dead/foreign invitations (SEC06/SEC11); the reason lives only here, never in the HTTP response         |
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

Every event above is exempt from sampling and from any downstream filter/drop
rule, per `001`'s existing rule for `catalog.audit.*`/`catalog.security.*`
(`001` design, Sampling exemption) — `010` inherits this constraint unchanged.
The user, credential and bootstrap lifecycle events `002` Q42 deferred to this
change are `user_created`, `credential_created`/`credential_rotated`/
`credential_revoked`, and the bootstrap case of `user_created`; SSO link and
unlink already have `auth.security.account_linked` and `account_unlinked`. These
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
resolved by Q101, Q102, Q105, Q106 and Q110, tasks and tickets; all
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
| G6 member without a `_user` row has no repair path (Q46, Q50) | D1, D13, spec "Every member has a `_user` row", tasks 2.2b, 11.8 |
| G12 no input contract, no per-tenant caps (Q56) | D6, D8, D10, tasks 5.3d, 9.5d, 10.8, 14.10 |
| G2, G5, G9, G10, G11, G13, G14 | tasks 6.8c, 9.5c, 2.2b, 8.1d, 9.2, 10.3b and the tickets in Risks (the deletion tasks of that set moved to `045`) |
| NB-1 a service-account route accepts a human target (Q62) | D3, D6, D14, spec "Service accounts" (scenario "A service-account route refuses a human target"), tasks 10.2, 10.7, 10.7b, 11.5, 2.2b |
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
| G7-5 the reconcile's orphan removal races an in-flight acceptance | D1, task 2.2b |
| G7-6, G7-7, G7-8 user notifications, the notice bucket and bounce handling | Tickets; the notice bucket is task 6.12b (Q101) |
| G7-9, G7-10 tests of NB-5 and NB-6, the marker-failure event, 010 alerts | tasks 8.5g-8.5j, 15.1, Tickets ("Alerts for `010`") |
| Seventh drift-check (A1-A38 of `drift7.md`) | Context (seventh amendment), tasks 1.1, 1.2 and the tasks they name |
| NB-7 a failed or retried existing-account acceptance skips the shed and the session revocation (Q105) | D1, D4 steps 4 and 7, D13, spec "Invitation acceptance", "An SSO link that its user did not make does not survive into a second tenant", "Disabling a human takes effect immediately" and "Every member has a `_user` row", tasks 2.2b, 8.1e, 8.5b, 8.5h, 8.5i, 8.5l, 11.8 |
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

| Section                 | Applies                | Posture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC01 Diagram           | Yes                    | New external actors (the email provider; the invitee with their mailbox; the platform operator) and new arrows (invite→email, the public accept route, ACS egress over HTTPS, the Pwned Passwords range query, the reconcile job) added to `docs/architecture/system-diagram.md` (tasks 16.7, 16.13).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC02 Attack surfaces   | Yes                    | Fourteen routes (D10), each with its actor, authentication (session, step-up-verified session, or none for the public accept route) and Cerbos check named in `docs/security/attack-surfaces.md` (task 16.6). The native Better Auth `inviteMember` and `accept-invitation` routes stay off `002`'s allowlist (D18 there). The accept route is the first unauthenticated route and a plain Fastify route: it derives the tenant from the invitation, is rate-limited, reads a session only for an existing account (with the CSRF header and its own `Origin` check), validates its body as an allowlist, never reveals why it failed, and sits behind the mount gate (D15).                                                                                                                                                       |
| SEC03 Access control    | Yes, core              | Every operation Cerbos-gated to `admin` (D3) with the target's real tenant; targets resolved server-side (D14); self-status-change denied; step-up on every high-risk operation (D10); invited role limited to `member`/`admin`; service accounts held to `member` by signed claim, creation validation and a Cerbos deny (D6), and every service-account route refusing a human target (Q62); an invitation is re-checked against its inviter's authority at acceptance, by Cerbos (Q63, Q108); a credential records its creator; an SSO link its user did not make is shed, and the user's sessions are revoked, when the user joins a second tenant, with positive provenance and a per-user lock (Q73, Q86, Q87), and an admin cannot record a link on an admin or an owner (Q88); disabled users and service accounts rejected within seconds, a human tenant-scoped so a member of two tenants can be off-boarded by either and admitted only when `Active` in the tenant (D13, Q105). Off-boarding is `Disabled`; role change and member removal are deferred (Non-Goals).  The human attestations (off-boarding procedure, training, access review) are deferred to `010`'s SSA (Resolved decision Q17). |
| SEC04 Password storage  | Yes                    | The acceptance flow is the first place a password is set outside sign-in: it applies the password policy (20-128 characters, every class, no harmful characters, a denylist, NFC-normalized at every password-verifying entry point; Q22) and the breached-password check (Q23), the hash is Better Auth's scrypt (`002`), and a token is required before any password is read. Service-account credentials reuse `002`'s API-key hashing.                                                                                                                                                                                                                                                                                                                                                                                        |
| SEC05 Crypto            | Partial                | The invitation token is 256 bits from a CSPRNG, stored only as a sha256 digest and compared in constant time (D4); `docs/security/crypto-inventory.md` also lists the SHA-1 prefix of the breached-password range query, the HMAC-SHA256 of the per-recipient cap key (Q93) and the ACS authentication; the SHA-1 prefix is a protocol-mandated exception (Q81): only five hex characters leave, SHA-1 is not used for storage or authentication, and an offline corpus is a ticket; credential secrets are hashed by `002`'s mechanism; TLS to Azure Communication Services is provider-managed. The token generator is ours, so no Better Auth invitation-id entropy claim is relied on.                                                                                                                                                                                                                                                                                              |
| SEC06 Misuse            | Yes                    | Dead invitations never succeed; acceptance errors are indistinguishable; a `Disabled` user cannot be revived by sign-in, acceptance or a hook (D2); re-invite cancels the previous invitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SEC07 Dependencies      | Yes                    | `@azure/communication-email` joins the Dependabot/`pnpm audit`/quarterly-EOL process; license, `allowBuilds` and SBOM review are recorded in `docs/security/dependencies.md` (task 1.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC08 File upload       | N/A                    | No file upload surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SEC09/SEC10 Secrets     | Yes                    | The Communication Services connection string is a new Key Vault secret on a dedicated send-only ACS resource, with a change procedure in `docs/security/secrets.md`; a managed identity is a first-deployment gate (Q28). The `tayzu_auth` secret of the backfill and reconcile jobs is documented with owner and rotation, each job with its own identity, and so is the `IDENTITY_TOKEN_HMAC_SECRET` of the cap keys (Q93).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SEC11 Phishing          | Yes, core new exposure | 48h expiry, one link, fixed subject and template with no tenant or inviter free text, link origin from `INVITATION_LINK_BASE_URL` only (Q32), exactly one recipient and no CC/BCC/attachments, ACS tracking disabled and no Reply-To, per-tenant, per-recipient and global caps (D4, D5); a second fixed notice tells the other admins, `Disabled` ones included, when an `admin` invitation is accepted (Q39); a real sender needs a mandatory recipient-domain allowlist under `NODE_ENV=test` and honors it wherever it is set (Q67, Q96, Q99), and a tenant on `EMAIL_DISABLED_TENANT_IDS` (a demo tenant) sends nothing (Q80); the notices share the kill switch, count in a per-recipient bucket of their own (Q101) and have a per-tenant notice cap and at most 20 recipients per notice (Q53). The SSA answers are Resolved decision Q34: one clickable link, unavoidable for a no-account invitee and mitigated by the fragment token, single use, 48-hour expiry and the configured origin; no attachments; only the recipient varies.                                                                                                                                                                                                    |
| SEC12 Testing           | Yes                    | Every requirement has a scenario-backed test; every route a cross-tenant test; `cerbos compile` gates policies. The identity OpenAPI document has no request schemas (Q52), so a scan of it has limited value until schemas exist. The OpenAPI-driven ZAP scan (`002` NB1) would hit `rotate`, `revoke` and `invite` (and `045`'s `organization.delete`), so it needs a sandbox tenant, a non-sending email sender and a destructive-route exclusion; because the switch is off by default, a sandbox scan with the switch **on** is required before the first deployment (ticket and gate, Risks).                                                                                                                                                                                                                                                                                                                                                               |
| SEC13 Deployment        | Partial                | The Communication Services connection string via Key Vault reference, `INVITATION_LINK_BASE_URL`, `INVITATION_EMAIL_KILL_SWITCH`, `MOUNT_IDENTITY_ROUTES`, and one Container Apps Job per maintenance script (Q49), the backfill and the reconcile, started by an operator under just-in-time access with a named second approver (D9; `045` adds the purge job and the reviewed `workflow_dispatch` workflow of Q41), so nothing runs against production from a workstation, except the bootstrap CLI, which an operator runs out of band as `002` designed it (Q91); a deployed environment fails startup without an explicit `EMAIL_PROVIDER` (Q96). |
| SEC14 Infra permissions | Yes                    | One migration (Checkpoint 3): `0011` (composite key); `045` owns `0012` to `0014` and the purge role (Q103). No `SECURITY DEFINER` function is created here (`045`'s Q48 also avoids one for the purge). The startup assertion on the runtime roles also fails when one owns `machine_credential_revocation` (Q109, task 11.1c). |
| SEC15 Network/host      | Partial                | Two new outbound calls, both HTTPS: Azure Communication Services, and the Pwned Passwords range query to `api.pwnedpasswords.com` (only the first five hex characters of the SHA-1 leave the system, Q23), plus the sender-domain DNS (SPF, DKIM, DMARC), recorded as egresses in the system diagram. ACS data location and retention are stated in `docs/security/data-retention.md`. DNS DDoS protection is deferred to `010`'s SSA (Q17).                                                                                                                                                                                                                                                                                                                                                                                      |
| SEC16 Logging           | Yes                    | Twenty-five new log events (plus the reused `catalog.security.authz_denied`) in the contract, all sampling-exempt, opaque ids and enums only, with `tayzu.actor.id` pinned to the admin; `catalog.security.authz_denied` is emitted from the identity router; no identifier in a URL path reaches telemetry (D16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
  enrols their own factor] → Accepted (Resolved decision Q39); every other admin
  is told by a fixed-template notice the moment an `admin` invitation is accepted.
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
  removes the orphan `_user` after a one-hour grace period (D1, Q84); a stranded user
  and a membership left by a failed compensation are an operator repair driven by the
  alert on `invitation_accept_compensation_failed` (Q100). A membership left by a failed
  existing-account compensation can carry an unshed SSO link and live sessions: its
  `_user` is `Active` when the shed was the step that failed, so the resolver admits the
  member in that tenant until the repair, or `Invited` when the `_user` write failed,
  which the resolver rejects (Q105 part 3) unless the first-sign-in hook activates it
  (Open Question 1). The repair removes the membership, which ends the member's access
  to that tenant, and the invitee is invited again, whose acceptance runs the shed with
  its session revocation (Q105 part 2).
- [The inviter check reads membership and `banned` from `tayzu_auth` and the `_user`
  status from `tayzu_app`, and asks Cerbos (Q108), with no transaction around the acceptance (Q89)] → A race of
  a few seconds at most: an inviter disabled between the check and the consumption of
  the token can still be accepted. Accepted and documented (D4 step 2); the cancellation at disable time (D13) and the
  rejection at the resolver bound it.
- [Every SSO link without a provenance marker is deleted, and the user's sessions are
  revoked, when the user joins a second tenant (Q73, Q86, Q87), so a legitimate
  multi-tenant SSO user loses a link made before this change and signs in again on
  every device, the one that accepted included (Q106)] → The user re-links through `/link-social`, which requires step-up; the shed event is the audit trail; a notice
  to the user on an admin link, unlink or shed is a ticket.
- [`auth.member` has no `UNIQUE (organization_id, user_id)`, so a concurrent acceptance
  and `addMember` could create two rows for one user, and the resolver's `memberRoleOf`
  reads one] → Ticket "Member uniqueness" (a migration, Checkpoint 3); the idempotent
  `addMember` step of the acceptance (Q89) narrows the window.
- [The notices consume a per-recipient bucket (Q53; since Q101 their own, not the
  invitation one): an admin who already got three notices in the window does not get
  the next one, and a notice that exceeds a cap is dropped] → Accepted; the operation is
  never blocked and the drop is logged as `catalog.security.notice_suppressed`. The kill switch stops every
  email, so flipping it also stops the notices (and `045`'s deletion notice).
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
  revokes `session` rows and takes the advisory lock, Q105).
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
rule "no mount before group 13 is done"; the ones closed by other named tasks (M19:
16.7, 16.13) are Checkpoint 2 items and gate the switch through the first-deployment
gates.

**Numbering.** `002`'s design was written before the Q103 split moved the old group 12
(org deletion) out of this file, so its references to this change's tasks are one group
off: "`043`'s group 14 (hand-offs from `002`)" in `002` Q73 and in `002`'s residual risks
is group 13 here, and "`043` task 14.2" in `002` Q84 (the multi-tenant identity case) is
task 13.2. Group 14 here is the mount group. `002` is not edited; this note is the
mapping. The migrations were not renumbered.

| Item | What it is                                                                                                                                                                                  | Where it is closed                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4 (not in `002`'s list; closed here) | Attributes are loaded and authorized in one transaction and the write runs in another (check-then-act)                                                                                      | Task 13.6                                                                                                                                                                                                                                                                                                                                                                                                         |
| M5   | Password policy: the minimum was 8, no breached-password check, only a rate limit                                                                                                           | Resolved decisions Q22, Q23; tasks 8.1, 8.1a, 8.1b, 8.1c, 8.1d, 13.5, 13.5b                                                                                                                                                                                                                                                                                                                                             |
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
  from that run (`002` Q57, Q73, Q83).
- A startup assertion that the runtime database roles are not superuser, owner or
  `BYPASSRLS` (task 11.1c makes it cover `machine_credential_revocation` in this change,
  Resolved decision Q109, so this gate does not depend on `045`, whose task 2.4 adds only
  its own marker table), and the real `MIGRATION_DATABASE_URL`
  wiring (`002` Q58, Q62).
- `TRUST_PROXY` made configurable, set to the exact ingress hop count and verified
  against the Container Apps ingress peer range (`002` Q58, Q84): the accept route's
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
  ticked, together with the other named tasks that close a `002` hand-off item (M19:
  16.7, 16.13; the traceability table above), and after `003` serves the accept page
  at `INVITATION_LINK_BASE_URL`.
- A verified Communication Services sender domain (SPF, DKIM, DMARC) and the
  secret in Key Vault on a dedicated send-only ACS resource; the migration from
  the connection string to a managed identity is done (Q28).
- The DAST scan runs against a sandbox tenant with the mount switch **on**, a
  non-sending sender and without the destructive routes.
- One Container Apps Job per maintenance script, the backfill and the reconcile, with its
  own identity (Q49), is provisioned (with `010`), and the just-in-time access and the
  named second approver for starting them are in place (D9). The backfill and the
  reconcile have run in every environment that has members **before the release
  carrying the `user_missing` rejection reaches it** (the rejection applies to the
  catalog `/v1` routes from the deploy, not from the mount; where no member exists yet,
  `002` Q78, they run at first deployment), and before the mount switch is turned on
  (Q46, Q50, D15). `045` adds the reviewed workflow and its own gates (the GitHub and
  Azure settings checklist, the purge job, the pre-purge warning and the marker alert).
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
| User notifications                     | Status, role and credential changes, and an admin linking or unlinking an SSO identity or a shed removing one on the user's account, notify the user (SEC06). The shed is silent and also signs the user out of every device, the accepting one included once the acceptance commits (Q86, Q106), so this ticket's priority is raised. The shed event already covers part of the SSO case.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Service-account read scope             | A service account as `member` can list all users' emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Credential hygiene alerts | Alert on a credential whose `lastRequest` is stale or whose rotation is overdue: with no hard expiry (Q20) the rotation-due flag is only a display hint, and a more precise hygiene alert would combine both signals (SEC09/SEC10). |
| ZAP guards                             | Sandbox tenant, no-send email sender, destructive-route exclusion, and a sandbox scan with the mount switch on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SSO-only when linked                   | `002` Q44, for `025`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Per-recipient oracle                   | See Risks. Alias normalization is settled by Q33; the cross-tenant denial-of-invitation and the runtime kill-switch flip remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Email in the `{user}` path             | The `_user` identifier (an email) is a path segment (Resolved decision Q12). D16 keeps it out of the process's telemetry, but the ingress and any proxy access log outside the process still see it. Consider an opaque-id route. oRPC's generated client also encodes path parameters with `encodeURIComponent`, so `a@b` becomes `a%40b`, which `002` Q74 answers with 404: the generated client cannot call a `{user}` route with an email until this is solved (the HTTP tests send raw paths and would not notice; the catalog `{entity}` path for `_user` emails has the same problem). |
| Account squatting                      | A tenant admin creates a global account for any email with a temporary password they know through `identity.users.create`. Consider an invitation-only or activation-link flow, or a notice to the address on creation (SEC04). `044` (the recovery path for a squatted account) shipping before the mount switch is a first-deployment gate (Gates).                                                                                                                                                                                                                                                                                                                                                               |
| HMAC of the per-recipient cap key (**built in this change by Q93, task 6.7b; it was a gate and is no longer one**) | Use an HMAC with a server secret instead of a bare sha256 of the email (SEC05).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Banned or disabled sign-in oracle | **Promoted to task 13.4b for the banned case (Resolved decision Q54).** Better Auth's admin plugin refuses a banned user with a distinct error after a correct password, a credential-validity oracle. The response should equal a wrong password's. |
| `principal_rejected` log flood         | A disabled user's session emits the WARN log on every request. Aggregate or rate-limit it and keep the counter (SEC16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ban-hook mirror (**resolved by Q102, task 4.5; no longer a ticket**) | The ban hook (D2) wrote `admin_enable` to every membership on a global unban, which could revert a tenant-scoped disable made by `setStatus`. It cannot see the old `banned` value, so any `user.update` that carries `banned: false` (enrolling a second factor, for example) sent `admin_enable` too, and the adapter's no-op covered only a user who was already `Active`: a user disabled in one of two tenants (not banned) would have been re-enabled there. Q102 settles it: the hook writes only `admin_disable`, for `banned === true`, and re-enabling goes through `setStatus` only. |
| One-active-credential constraint | A partial unique index over `apikey` on the "one active credential per service account" invariant, as defence in depth beside the advisory lock (needs a migration, Checkpoint 3, and `apikey.metadata` is a text column) (SEC03/SEC10). |
| Auth-schema repository module (**promoted into this change by Q69, tasks 5.1b and 5.1c**) | One repository module that requires `tenantId` for every adapter read of `apikey`, `invitation`, `member` and `session`, and reads `user` and `account` only through `global…` functions (D14, sixth amendment), plus a lint ban on direct adapter access to those six models elsewhere, because the `auth` schema has no row-level security and the tenant filter is repeated by hand (SEC03/SEC14). |
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
| Alerts for `010` | Alert on `catalog.security.sso_link_shed`, a volume of `catalog.security.principal_rejected`, `catalog.security.credential_rotation_incomplete`, `catalog.security.sso_link_marker_failed` and `catalog.security.invitation_accept_compensation_failed`. |
| One Visma Connect link per user | Eighth pass, TK-1. A user can hold more than one `visma-connect` account, and `ssoSidForSignIn` (`auth.ts`) reads the first `visma-connect` account of the user, not the account the callback signed in through, so a session's `ssoSid` can come from another link. `linkSsoAccount` should refuse a target that already has a `visma-connect` account, and `ssoSidForSignIn` should read the account the callback signed in through (SEC03). |
| Member-role changes and SSO links | Eighth pass, TK-2. The refusal of Q88 holds at link time only, so the future member management (ticket "Member management") must, when it promotes a member to `admin` or `owner`, shed that user's unmarked links and revoke their sessions, as a join does (D4 step 7), or a link an admin recorded on a plain member would survive the promotion (SEC03). |

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
   (D9, one job per script), after the code that reads `accountKind` is deployed and
   before the release that carries the `user_missing` rejection of D13 serves traffic
   in an environment that has members (the rejection applies to the catalog `/v1`
   routes from the deploy, not from the mount switch, so the jobs run from the new
   image before the new app revision takes traffic; where no member exists yet, `002`
   Q78, the order holds trivially at first deployment), and before the mount switch is
   turned on.
5. Rollback: set `MOUNT_IDENTITY_ROUTES` off to remove the whole HTTP surface
   (D15). The migration has a down script.

## Resolved decisions (asked and approved in chat, 2026-09-28, 2026-10-01 and 2026-10-07)

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
| Q6  | (deletion part moved to 045 by Q103) Step-up for high-risk operations                                                                                                                              | A fresh MFA verification (or a step-up-required error) gates any operation marked `x-tayzu-risk: high` — this change marks `setStatus`, `credentials.rotate`, `credentials.revoke`, and `organization.delete` that way (D10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Q7  | (VCDM pre-assessment, 2026-09-28) Should service accounts be restricted from holding `admin`/broad `moderatedBlueprints`, given they never go through step-up | Restrict service accounts to `member` role only, enforced at creation/update validation and by an independent Cerbos rule on `accountKind: "service"` (D6, D3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q8  | (Drift-check and VCDM pre-assessment against merged 002, 2026-10-01) How an invitee without an account accepts                                                | The invitation link carries a single-use, constant-time-compared token. A public, rate-limited accept route outside the tenant-context pipeline derives the tenant from the invitation record, lets the invitee set a password, and treats the token as mailbox proof (email verified in-process); MFA enrollment then follows 002 Q43, and Visma Connect is linked later through `/link-social`, `sub`-keyed. Responses are enumeration-resistant. The native `/organization/accept-invitation` route stays off the D18 allowlist.                                                                                                                                                                   |
| Q9  | (VCDM B2, 2026-10-01) Roles an invitation may carry                                                                                                           | `member` or `admin`, never `owner`; an `admin` invitation requires step-up and is logged with its role (consistent with 002 Q37). _Extended by Q19: every invitation requires step-up._                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q10 | (Drift b2, 2026-10-01) Attributing `_user` writes to the admin                                                                                                | The identity procedure writes as `system` with `actor.onBehalfOf` set to the admin, in-process only; `reserved.ts` is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Q11 | (Drift b8, 2026-10-01) Canonical disable mechanism and default status                                                                                         | _Q76 makes the membership hook the only writer of `_user`: `identity.users.create` and the bootstrap no longer upsert it themselves._ **Superseded in part by Q25** (the disable is tenant-scoped and uses the internal adapter; `banUser`/`unbanUser` are not called, D13); the state-machine part stands. `setStatus` calls Better Auth `banUser`/`unbanUser` and syncs `_user.status` through the `nextStatus` state machine; `afterAddMember`, the ban hook and `identity.users.create` go through it. Admin-created users start `Active`; `Staged` is the default only for an entity created without a status. Covers 043 task 13.4. |
| Q12 | (Drift b3/b4, VCDM, 2026-10-01) Service-account principal                                                                                                     | The signed machine claim stays `member` with no teams and no moderated blueprints (002 Q28); `userId` is added only as an attribution claim. Routes address a user by its `_user` entity identifier (email or `svc-…`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Q13 | (Drift b5, VCDM B4, 2026-10-01) Immediacy of disable, rotate and revoke                                                                                       | Rotate and revoke write the revocation list (effective within seconds). Disable is a `_user.status` check on the resolver's machine branch with the 5-second cache, failing closed, so a disabled service account can be re-enabled without a migration.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q14 | (moved to 045 by Q103) (Drift b6, VCDM B5, 2026-10-01) Org deletion                                                                                                                  | Two phases: access is revoked immediately and the tenant is marked pending deletion; after a 7-to-14-day window a job purges in idempotent steps (catalog data, then Better Auth rows). The purge of append-only rows goes through a `SECURITY DEFINER` function owned by `tayzu_migrator` that deletes only for a tenant marked for deletion (a migration, Checkpoint 3). **The `tayzu_migrator` owner is superseded by Q26, and Q48 then removed the function altogether**; the two phases and the window stand.                                                                                                                                                                                         |
| Q15 | (VCDM B9, 2026-10-01) Invitation email abuse limits | _Extended by Q53: the kill switch and the per-recipient bucket also cover the two notice templates. Semantics of the windows on `002`'s store: Q66. Q101 gives the notices a per-recipient bucket of their own._ 30 per hour per tenant, 3 per 24 hours per recipient across all tenants (keyed by an HMAC, Q93), and a global kill switch (environment variable), on a shared store before the first deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Q16 | (Drift b7, 2026-10-01) Testing the service-account role ceiling                                                                                               | The Cerbos rule stays as a defensive layer, tested at the policy level, plus a `system`-actor test; no new role-editing operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q17 | (VCDM, 2026-10-01) Human attestations                                                                                                                         | Deferred to `010`'s SSA, as 002 Q59 and Q79.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Q18 | (Amendment question, 2026-10-01) Invitation for an email that already has an account                                                                          | _Extended by Q73, Q86 and Q87: an SSO link without a provenance marker is shed at acceptance and the user's other sessions are revoked; Q105 makes the shed an explicit step of every attempt and compensates the membership; Q106 also revokes the accepting session after the acceptance commits when a link was shed._ Acceptance requires an authenticated session of that same account plus the token; it adds only the membership, activates the `_user` and sets no password. |
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
| Q74 | (Drift B1, 2026-10-01) Identity telemetry names | A separate identity contract module that `otel-smoke-check` also imports; 002's contract assertions stay untouched. |
| Q75 | (Drift B2, 2026-10-01) Atomic invitation acceptance | _Superseded by Q89: no single transaction; idempotent steps, the token consumed last, a compensation and the reconcile._ Better Auth `transaction: true`; consuming the token and creating the user and member happen in one transaction; the `_user` write runs in `afterAddMember`, failing closed; the reconcile repairs an orphan `_user`. |
| Q76 | (Drift B3, 2026-10-01) Hook-only `_user` writes | Approved by the human: `_user` is written only by the hook, reversing 002 task 18.5's direct writes; the two direct-write tests in `user-sync.int.test.ts` are rewritten to build `auth` with `userSync`, and task 4.6's wording is corrected. |
| Q77 | (Drift B4, 2026-10-01) Rejection code for a `Disabled` or missing human `_user` | _Q105 applies the same code to every human `_user` status other than `Active`._ `401 CATALOG_CONTEXT_REQUIRED` with the reason only in logs, like `rejectMissingContext`; approved by the human, the test at `context-resolver-principal.int.test.ts:364-390` is rewritten to this requirement and the change is called out in the PR. |
| Q78 | (Drift B5, 2026-10-01) Reaching the machine-credential functions | A subpath export `@tayzu/auth/machine-credentials`, with a lint rule limiting importers to `apps/api/src/identity/**`. |
| Q79 | (deletion part moved to 045 by Q103) (Drift B6, 2026-10-01) Telemetry in maintenance scripts | Each script starts telemetry, emits its audit events and flushes before exit; the environment names are documented. |
| Q80 | (VCDM Q-B, 2026-10-01) Demo tenants and the real sender | An `EMAIL_DISABLED_TENANT_IDS` list honored by the invitation and notice dispatcher; a listed tenant's emails are suppressed and logged as `catalog.security.email_tenant_blocked`. |
| Q81 | (VCDM Q-C, 2026-10-01) SHA-1 prefix of the breached-password query | Recorded in `crypto-inventory.md` as a protocol-mandated exception (five hex characters leave, SHA-1 is not used for storage or authentication), with a ticket to evaluate an offline corpus. |
| Q82 | (moved to 045 by Q103) (Sixth-pass Open Question 1, drift B7, 2026-10-07) Approving the two purge-grant blocks | _(043's old tasks 12.1b and 12.1c are `045`'s tasks 2.2 and 2.3; 043 keeps one migration, `0011`.)_ Split into `0013_tenant_deletion_grants` (task 12.1b, catalog side) and `0014_tenant_deletion_auth_grants` (task 12.1c, Better Auth side), each approved separately at Checkpoint 3 and never edited afterwards. Four migrations in total. |
| Q83 | (Sixth-pass Open Question 2, drift M12, 2026-10-07) Concurrent `_user` status writes | The status adapter writes with the `expectedVersion` of the row it read and retries at most 3 times before failing closed; a race never revives a `Disabled` user. |
| Q84 | (Sixth-pass Open Question 3, Q75 follow-up, 2026-10-07) Reconcile of an orphan `_user` | _Q89: an orphan is removed only when its `createdAt` is more than one hour old._ The reconcile removes a human `_user` that is `Active` and has no `member` row in its tenant (never `Invited`, `Staged` or a service account), as `system` with `onBehalfOf` the operator, and counts it. |
| Q85 | (deletion part moved to 045 by Q103) (Amendment details confirmed by the human, 2026-10-07) Names and values fixed during the Q73-Q81 amendment | `ACS_CONNECTION_STRING` and `EMAIL_PROVIDER` (`acs` or `none`); Better Auth's `maxPasswordLength` 256 (UTF-16 units) while Q22 keeps 128 code points; a credential-viewer page of 200; "Require review from Code Owners" as the fifth Q55 checklist item; SSO-link markers identified `sso-link:<accountId>` (Q87 pins `<accountId>` to the `account` row's own id, not the provider's `accountId` column). |
| Q86 | (VCDM NB-5, 2026-10-07) Sessions issued through a shed or admin-unlinked SSO link | _**The exemption of the accepting session is amended by Q106**: when the shed removed a link, the accepting session is revoked too, after the acceptance commits, and the shed sweeps the sessions a second time after its deletion commits._ On a shed and on an admin `unlinkSsoAccount`, every session of the user is revoked except the one carrying the acceptance request (the hook path revokes all), not filtered on `ssoSid`; `auth.security.session_revoked` gets the reason `sso_link_shed`. |
| Q87 | (VCDM NB-6, 2026-10-07) Fail-closed link provenance | _Q105: the acceptance takes the lock in its explicit shed step and the reconcile takes it in its own shed._ Positive provenance: a marker is written for self-service links (`account.create.after` with an endpoint context), keyed by `account.id`, deleted in `account.delete.after` on every path, with a far-future sentinel expiry; every unmarked link counts as admin-recorded and is shed. Link, acceptance and `afterAddMember` take one Postgres advisory lock per user id. Supersedes Q73's admin-side marker. |
| Q88 | (VCDM G7-2, 2026-10-07) Admin-recorded SSO links on admins or owners | Refused with the generic rejection; admin accounts self-link through `/link-social` with step-up. |
| Q89 | (Drift A1, 2026-10-07) Atomicity of acceptance | Supersedes Q75's single transaction: every step is idempotent, the token is consumed last, and the reconcile repairs orphans; no new dependency. |
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
| Q100 | (Seventh-pass Open Question 2, 2026-10-07) A user stranded by a failed acceptance compensation | Repaired by an operator, driven by an alert on `invitation_accept_compensation_failed` and a runbook. |
| Q101 | (Seventh-pass Open Question 3, G7-7, 2026-10-07) A separate per-recipient bucket for notices | A task before the mount switch. |
| Q102 | (Seventh-pass Open Question 4, 2026-10-07) The ban hook and `admin_enable` | The ban hook writes only `admin_disable`; re-enabling goes through `setStatus` only. |
| Q103 | (Drift C4, 2026-10-07) Change size against the roadmap budget | _(Row markers refine the list: Q41 and Q49 moved only in part, and Q72 moved too.)_ Org deletion and data retention (the two-phase purge, the deletion marker, the purge and deletion-admin roles, migrations `0012`-`0014`, the reversal and purge jobs and the maintenance workflow) move to a new change, `045-org-deletion-and-data-retention`, which depends on `002` and `043`, gets its own Checkpoint 1 and reviews, and executes after `044` (`002 -> 043 -> 044 -> 045 -> 003`). The decisions about it recorded here (Q14, Q21, Q26-Q27, Q35, Q41, Q48-Q49, Q55, Q59, Q64-Q65, Q68, Q82 and the deletion parts of others) carry over to `045` unchanged. |
| Q104 | (After the Q103 split, 2026-10-07) 043's size against the roadmap budget | Accepted: 043 keeps about 200 tasks, over the ~30-80 budget of `project.md` D9; splitting further would separate tightly coupled parts (invitations, status lifecycle, router authorization, credentials). The overrun is recorded in the proposal. The split choices made while applying Q103 (a minimal operator-run job for the `_user` backfill and reconcile until `045`'s workflow, a short D9 "maintenance scripts", `data-retention.md` created here and extended by `045`, ADR-0019 reserved for `045`, mixed decision rows copied to `045`, and the pending-deletion checks as `045` extensions) are confirmed. |
| Q105 | (Eighth-pass VCDM NB-7, H-2, 2026-10-07) A failed or retried existing-account acceptance must still shed | Four parts: (1) the existing-account path records whether `addMember` created the membership and, if a later step fails before the token is consumed, deletes it (idempotently, logging `invitation_accept_compensation_failed` if the delete fails); (2) the acceptance runs the shed, with its session revocation and under the per-user lock, as an explicit idempotent step on every attempt once the membership exists, including when `addMember` was already done, before the token is consumed, and a shed failure fails the attempt (the hook keeps its shed for other membership paths); (3) `resolveContext` admits a human only when `_user.status` in the active tenant is `Active` (deny unless `Active`, like the machine branch), amending the D13 rule of Q25, Q46 and Q77; (4) the reconcile runs the shed before creating a `_user` for a member whose user holds two or more memberships. |
| Q106 | (Eighth-pass VCDM G8-1, G8-2, H-1, 2026-10-07) Session paths the shed still misses | One task before the mount switch: the SSO callback refuses to create a session through an account that no longer exists, or that is unmarked while its user belongs to two or more tenants; the shed sweeps the user's sessions a second time after its deletion commits; and when the shed removed a link, the accepting session is also revoked after the acceptance commits (amends Q86's exemption, since the accepting session may itself have come through the shed link). |
| Q107 | (Eighth-pass drift B-1, 2026-10-07) `_user` emails in catalog spans | A 043 task: the catalog pipeline does not export `tayzu.catalog.entity.identifier` for reserved `_user` entities (omitted or replaced by a fixed placeholder), with a contract test; it also covers 002's existing sync. Latent in 002 (`userSync` is not wired in `createApp`) and reached by 043. |
| Q108 | (Eighth-pass drift B-2, 2026-10-07) The inviter re-check at acceptance | Cerbos decides it: a `user`/`invite` check with the inviter as the principal (roles from the member row, tenant from the invitation), keeping 002 D2's single decision point. |
| Q109 | (Eighth-pass drift B-3, 2026-10-07) `assertRuntimeRole` and `machine_credential_revocation` | A small 043 task beside migration `0011`: the startup assertion also fails when the runtime role owns `machine_credential_revocation`; `045` task 2.4 keeps only the marker table. This removes 043's last dependency on `045`. |
| Q110 | (Eighth-pass VCDM G8-12, 2026-10-07) `users.create` for an email with a pending invitation in the same tenant | `create` cancels that invitation with the reason `user_created`. |

## Open Questions

The four open questions left by the seventh amendment were answered on 2026-10-07
(Q99-Q102); the seventh VCDM pass's three questions are Q86-Q88; the split of org
deletion into `045` was approved the same day (Q103), and the eighth pass's and the
eighth drift-check's decisions are Q105-Q110. A consistency check after applying them
left one point that only the human can decide. It is also asked in chat, and nothing
below counts as approved until the human answers; the answer is then recorded as a
Resolved decision and applied to D2, the Risks bullet on failed acceptances, tasks 3.2,
4.4 and 16.5, and the spec ("User status has
four states with forward-only transitions" and its scenario "First sign-in activates a
staged or invited user"). Until then those passages keep their current wording.

**Open Question 1: may the first-sign-in hook activate the `_user` of a second tenant
without the shed (Q105)?** Q105 part 3 rejects an `Invited` or `Staged` member in the
resolver, and the spec scenario "An `Invited` member is rejected by the resolver" names
a failed acceptance as the case. But the first-sign-in hook (D2, task 4.4) moves a
`Staged` or `Invited` `_user` to `Active` on the user's next sign-in, is not scoped to a
tenant and runs no shed. If an existing-account acceptance fails at its `_user` write
and its compensation fails too (D4 step 4, Q105 part 1), the membership remains, its
`_user` is `Invited` and an unmarked SSO link can still be in place (the SSO callback
refuses a session through it, Q106, but a local sign-in does not). One local sign-in then
activates the row, and the member is admitted to the second tenant without the shed that
Q105 requires. In the normal flows the hook is never needed for a second tenant: the
membership hook already writes `invitation_accepted` (D2). Options:

1. **(Recommended)** The hook writes `first_sign_in` only for a user who holds exactly
   one membership, to that membership's `_user`; for a user of two or more tenants it
   writes nothing, so such a `_user` stays rejected by the resolver (Q105 part 3) until
   a path that sheds activates it (a new acceptance, the membership hook or the
   reconcile) or the operator repair of Q100 removes the membership. Task 4.4 gains a
   two-tenant case. Why: the hook is reached for a second tenant only in a failure
   state, for which Q100 already chose an operator repair; this adds no shed caller, no
   session revocation inside a sign-in and no new attribute value, and the spec
   sentence stays true for a single-tenant user (it gains "of a single tenant").
2. For a user of two or more tenants the hook first runs the shed of D4 step 7 through
   `SsoLinkShedPort`, with its session revocation (which can revoke the session the
   sign-in is creating) and under the per-user lock, and activates only when the shed
   succeeded; `tayzu.identity.sso_link.path` gains the value `first_sign_in`, and task
   4.4 gains a two-tenant case. The spec sentence stays as written for every user, at
   the cost of a fourth shed caller on the sign-in path.
3. Drop `Invited` from the `first_sign_in` row, so that `Invited` reaches `Active` only
   through `invitation_accepted`. The smallest change to the table, but a `Staged`
   `_user` beside another membership is still activated without the shed, and the spec
   sentence and task 3.2 change.

The residual that no option removes, the same double fault with an `Active` `_user`
(the shed failed, then the compensation failed), is named in Risks and in the runbook of
task 16.5 under Q100.
