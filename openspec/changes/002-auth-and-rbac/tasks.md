# Tasks: 002-auth-and-rbac

**How to execute these tasks (Agentic TDD).** Every task below, except the
scaffolding tasks in group 1 marked *(setup)*, is **one self-contained
red-green-refactor cycle**:

1. **Red.** Write only the test named in the task's *Verify* clause. Run it
   and see it **fail for the expected reason**: a missing behavior, not a
   typo or a missing import. With the `test-writer`/`implementer` split, this
   step belongs to `test-writer`.
2. **Green.** Write the minimum production code that makes the test pass.
   Do not change the test.
3. **Refactor.** Clean up with every test green. Run
   `pnpm --filter <pkg> test`, `pnpm lint` and `pnpm typecheck`.
4. Tick the box only when all three steps are done, and commit with the task
   number (for example `feat(authz): 8.3 three-tier role baseline`).

Cerbos policies are written and tested by the `policy-writer` subagent
(`.claude/agents/policy-writer.md` if configured, else the orchestrator
follows the same discipline directly): a policy YAML file and its
`*_test.yaml` land together, and `cerbos compile` is the red/green cycle for
that layer, parallel to but distinct from `test-writer`/`implementer`'s cycle
for application code.

Scenario names in quotes refer to `specs/auth-and-rbac/spec.md` and the
`catalog-core` delta in this change. Test files live next to the code as
`*.test.ts`. Integration tests are named `*.int.test.ts` and need
`DATABASE_URL` and a running Cerbos container. ⛔ marks a Checkpoint 3 stop:
work must not continue past that task until the human approves the SQL or
policy diff shown in chat, separately from the rest of the PR.

## 1. Workspace and dependency setup

- [x] 1.1 *(setup)* Add dependencies at the verified versions: `better-auth@1.7.6`,
  `@better-auth/api-key@1.7.6`, `@better-auth/drizzle-adapter@1.7.6`,
  `@cerbos/grpc@0.29.1`, `@cerbos/orm-drizzle@0.1.0`, `fastify@^5.12.5`,
  `@fastify/cors@^11.3.0`, `@fastify/helmet@^13.1.1`,
  `@fastify/rate-limit@^11.2.0`. Verify: `pnpm install` succeeds and
  `pnpm audit --prod --audit-level=high` passes.
- [x] 1.2 *(setup)* Scaffold empty `packages/auth`, `packages/authz`, and
  `apps/api` (each with `package.json`, `tsconfig.json`, `src/index.ts`, a
  trivial `smoke.test.ts`). Verify: `pnpm test` runs 3 new passing smoke
  tests through Turborepo.
- [x] 1.3 *(setup)* Scaffold the `policies/` tree (`derived_roles/`,
  `role_policies/`, `resource_policies/`, `resource_policies/testdata/`) and
  a `policy:compile` root script invoking `cerbos compile /policies` against
  the pinned `ghcr.io/cerbos/cerbos:0.55.0` image. Verify: `pnpm
  policy:compile` runs and reports "no policies" cleanly (nothing authored
  yet).
- [x] 1.4 *(setup)* Write `packages/auth/CLAUDE.md`, `packages/authz/CLAUDE.md`,
  and `apps/api/CLAUDE.md` with local conventions. Verify: the files exist
  and `pnpm lint:md` passes.
- [x] 1.5 *(setup)* Add a `cerbos` service (pinned by digest, disk driver over
  `/policies`, `watchForChanges: false`) next to the existing `postgres:16`
  service in `.github/workflows/ci.yml` and the local dev-environment
  scripts. Verify: `pnpm ci:local` starts both containers, and the Cerbos
  health endpoint responds.

## 2. Better Auth bootstrap

- [x] 2.1 `packages/auth`: a `betterAuth` instance with `organization`,
  `admin`, `two-factor`, `jwt` (all bundled) and `apiKey` (separate package)
  registered, `drizzleAdapter(db, { schemaName: "auth" })`,
  `dynamicAccessControl` and `teams` left unconfigured (off). Verify:
  `auth-instance.test.ts` introspects `auth.api` and asserts the
  organization, admin, two-factor, apiKey and jwt handlers are present, and
  that no dynamic-access-control or teams handler exists.
- [x] 2.2 Generate the Better Auth schema (`npx @better-auth/cli generate` +
  `drizzle-kit generate`) into `packages/db/migrations/0002_auth_schema.sql`,
  creating Postgres schema `auth` and every Better Auth/plugin table inside
  it. Hand-write the companion custom SQL creating role `tayzu_auth` with
  full CRUD on schema `auth` only, no grants on any `catalog_*` table.
  Verify: `schema.int.test.ts` applies both migrations to an empty database
  and asserts through `information_schema`/`pg_catalog` that every table
  lives under schema `auth` and that `tayzu_auth` has zero privileges on any
  `catalog_*` relation. ⛔ **Stop here for Checkpoint 3 approval of both
  migrations' SQL before continuing.**
- [x] 2.3 Mount Better Auth's sign-up and sign-in behind `apps/api` (built in
  group 11, stubbed here with an in-process handler call). Verify:
  `auth-flow.int.test.ts` covers "Signing up creates a matching `_user`
  entity" precondition (an organization and a Better Auth user exist) and
  "Sign in with the correct password succeeds".
- [x] 2.4 Wire `auth.security.login_succeeded`/`login_failed` log events and
  the `tayzu.auth.session.events` counter on sign-in. Verify:
  `auth-flow.int.test.ts` covers both outcomes emitting the declared signal.
- [x] 2.5 Better Auth `rateLimit` config: `storage: "database"`, `customRules`
  for `/sign-in/email`, `/two-factor/verify`, and any sign-up/email-verification
  route, each keyed by IP and by normalized email (design D20). Verify:
  `pre-auth-rate-limit.int.test.ts` covers "Repeated failed sign-ins from the
  same source are rate-limited" (`AUTH_RATE_LIMITED`, `Retry-After` header),
  and the `auth.security.rate_limited` log event plus
  `tayzu.auth.rate_limit.events` counter, with neither IP nor email present on
  either signal.
- [x] 2.6 Sign-in/sign-up failure responses are identical in status, error
  code, and body shape regardless of whether the account exists (design
  Non-Goals: password reset itself is deferred to
  `044-password-reset-and-account-recovery`). Verify:
  `enumeration-resistance.int.test.ts` covers "Sign-in failure looks the same
  for an unknown account and a wrong password".

## 3. Session and tenant resolution

- [x] 3.1 `resolveContext(headers)` in `packages/auth`: the session-cookie
  branch resolves `{ tenantId: session.activeOrganizationId, actor: { type:
  'user', id: user.id } }`. Verify: `context-resolver.int.test.ts` covers
  "Session cookie resolves a human context", "Missing credential is rejected
  like a missing context", and "Session without an active organization is
  rejected" (all three failing exactly as `CATALOG_CONTEXT_REQUIRED`).
- [x] 3.2 A 12-hour idle timeout layered on top of Better Auth's own 7-day
  `expiresIn`/1-day `updateAge`. Verify: `session-policy.int.test.ts` covers
  "Idle session expires after 12 hours" and "Active session rolls forward up
  to 7 days".
- [x] 3.3 `changePassword` called with `revokeOtherSessions: true`. Verify:
  `session-policy.int.test.ts` covers "Password change revokes other
  sessions", and the resulting `auth.security.session_revoked` log event.
- [x] 3.4 `resolveContext(headers)` never reads `actor.onBehalfOf` from the
  request body, path, query string, or any header; any client-supplied value
  is ignored (design D3). Verify: `context-resolver.int.test.ts` covers "A
  client-supplied onBehalfOf value is ignored".
- [x] 3.5 Better Auth's `setActiveOrganization` rejects setting an
  organization the caller is not a member of (design D19). Verify:
  `active-org.int.test.ts` covers "Setting an active organization you are not
  a member of is rejected".
- [x] 3.6 `resolveContext()`'s session-cookie branch independently
  re-verifies `session.activeOrganizationId` against a membership-row lookup,
  cached for at most a few seconds, failing closed on a miss or lookup
  failure (design D19). Verify: `context-resolver.int.test.ts` covers
  "Context resolution independently rejects a stale non-membership", using a
  membership row removed after the session was established.

## 4. Multi-factor authentication and step-up

- [x] 4.1 TOTP enrollment and backup-code generation via the `two-factor`
  plugin. Verify: `mfa.int.test.ts` covers "Enrolled user must supply a TOTP
  code to sign in", "Backup code is single-use", and "Unenrolled user signs
  in with password alone".
- [x] 4.2 A step-up guard reading `x-tayzu-risk: high` off the invoked
  procedure's route and a `twoFactorVerifiedAt` freshness check (5-minute
  threshold), applied only to `user` actors. Verify: `step-up.int.test.ts`
  covers "High-risk operation without a fresh MFA verification is blocked",
  "High-risk operation with a fresh MFA verification succeeds", and
  "High-risk operation by an integration actor is not gated by step-up", plus
  the `auth.security.step_up_required` log event and
  `tayzu.auth.step_up.required` counter on the blocked case.

## 5. Machine credentials

- [x] 5.1 An `apiKey` plugin config `machine-credential`
  (`references: "organization"`), and an admin-only creation procedure fixing
  `actorKind` (`integration`\|`agent`) at creation. Verify:
  `machine-credentials.int.test.ts` covers "Credential is shown only once".
- [x] 5.2 A revoke procedure (no in-place rotation). Verify:
  `machine-credentials.int.test.ts` covers that a revoked credential's id can
  no longer authenticate at the token endpoint (used together with 5.3).
- [x] 5.3 `POST /v1/auth/token`: `verifyApiKey` then a 1-hour access token
  minted through the `jwt` plugin, scoped to the credential's `tenantId` and
  `actorKind`. Verify: `token-exchange.int.test.ts` covers "Valid client id
  and secret exchange for an access token", "Wrong secret is rejected", and
  "Revoked credential is rejected" (`AUTH_INVALID_CREDENTIALS`), plus the
  `auth.token.exchange` span and `tayzu.auth.token.exchanges` counter.
- [x] 5.4 The access-token branch of `resolveContext`, enforcing the 1-hour
  expiry. Verify: `context-resolver.int.test.ts` covers "Expired machine
  access token is rejected" and a fresh-token success case resolving
  `actor.type` from the credential's fixed kind.
- [x] 5.5 A new migration creating `machine_credential_revocation`
  (`credential_id`, `revoked_at`, `tenant_id`), granted to `tayzu_app` with
  the same `tenant_isolation` `pgPolicy`/`FORCE ROW LEVEL SECURITY` treatment
  as every catalog table (design D21). Verify:
  `revocation-schema.int.test.ts` asserts the table, its policy, and the
  `FORCE` flag via `pg_policy`/`information_schema`. ⛔ **Stop here for
  Checkpoint 3 approval of this migration's SQL before continuing.**
- [x] 5.6 The revoke procedure (5.2) additionally writes a
  `machine_credential_revocation` row in the same operation that disables the
  underlying `apiKey` config row. Verify: `machine-credentials.int.test.ts`
  covers "Revocation is recorded in the revocation list, not only disabled at
  the apiKey layer".
- [x] 5.7 The machine-token branch of `resolveContext` consults the
  revocation list on every request through an in-process cache keyed by
  `credential_id` with a TTL of at most 5 seconds, failing closed (rejecting
  the token) on a lookup failure (design D21). Verify:
  `context-resolver.int.test.ts` covers "A token issued before revocation is
  rejected within the revocation TTL" and "Revocation-lookup failure fails
  closed" (simulated lookup error).

## 6. Database roles and row-level security

- [x] 6.1 `pgRole`/`pgPolicy` additions (`tenant_isolation`, `for: 'all'`) on
  every catalog table in `packages/catalog/src/persistence/schema.ts`.
  Generate the migration. Verify: `schema.int.test.ts` asserts, via
  `pg_policy`, that the policy and `ENABLE ROW LEVEL SECURITY` exist on every
  catalog table.
- [x] 6.2 A hand-written custom SQL migration: `CREATE ROLE tayzu_migrator`/
  `tayzu_app` where not already infrastructure-provisioned, `GRANT`s for
  `tayzu_app` on every catalog table, `REVOKE UPDATE, DELETE, TRUNCATE ON
  catalog_change_event FROM tayzu_app`, and `FORCE ROW LEVEL SECURITY` on
  every catalog table. Verify: `roles.int.test.ts` asserts the exact grants
  and the `FORCE` flag via `information_schema`/`pg_catalog`. ⛔ **Stop here
  for Checkpoint 3 approval of this migration's SQL before continuing.**
- [x] 6.3 Update `getTestDatabase()` (`@tayzu/db`) to migrate as
  `tayzu_migrator` and hand back a pool connected as `tayzu_app`. Verify:
  001's existing isolation tests (`isolation-blueprints.int.test.ts`,
  `isolation-entities.int.test.ts`, `db-isolation.int.test.ts`) pass unchanged
  against the new pool.
- [x] 6.4 New RLS-specific tests. Verify: `rls-isolation.int.test.ts` covers
  "Query without a tenant setting sees no rows" (read returns zero rows, a
  write affects zero rows, neither raises); `db-isolation.int.test.ts`
  (extended) covers "Runtime role cannot alter the change-event log" and
  "Runtime role cannot bypass row-level security", plus a negative-control
  assertion that `tayzu_migrator` is reachable from no runtime code path.

## 7. Cerbos engine wiring

- [x] 7.1 `packages/authz`: a Cerbos gRPC client wrapper, resource-kind
  constants (`catalog_blueprint`, `catalog_entity`, `team`, `user`), and a
  `tenantId`-first attribute builder. Verify: `client.test.ts` asserts the
  client connects to the CI Cerbos container and a trivial `CheckResources`
  call round-trips.
- [x] 7.2 Cerbos deployment config with `engine.strictEvaluation: true`,
  `audit.decisionLogsEnabled: true`, `audit.accessLogsEnabled: false`.
  Verify: `config.test.ts` asserts the rendered configuration file matches
  these settings.
- [x] 7.3 Wire `pnpm policy:compile` as a required CI job, running before
  `pnpm --filter @tayzu/catalog test`. Verify: `pnpm ci:local` runs it, and
  it fails non-zero when a scratch policy file in a throwaway branch is made
  invalid.

## 8. Role and ownership Cerbos policies

- [x] 8.1 Derived role `same_tenant` (`parentRoles: ["*"]`, condition
  `R.attr.tenantId == P.attr.tenantId`), imported into every resource
  policy's rules. Verify: `same_tenant_test.yaml` covers a cross-tenant
  request being denied even when the principal otherwise holds a matching
  role.
- [x] 8.2 Resource policies `catalog_blueprint.yaml`, `catalog_entity.yaml`,
  `team.yaml`, `user.yaml`, each with Cerbos's implicit deny plus an explicit cross-tenant deny rule
  (no wildcard deny, which would override admin; design D8). Verify: each has a
  `*_test.yaml` covering "Action with no matching rule is denied" for that
  resource kind.
- [x] 8.3 Role policies are a ceiling; `parentRoles` narrows rather than
  inherits. `admin.yaml` (no `parentRoles`, `allowActions: ["*"]` on every
  resource kind) and `member.yaml` (`view`, `list`, `create`, `update`,
  `delete` on `catalog_entity`, so moderator and ABAC grants can reach
  `delete`; `view`, `list` only on `catalog_blueprint`, `user`, and `team`).
  No resource-policy rule grants `delete` to a plain member. Verify:
  `role_policies_test.yaml` covers "Admin can manage blueprints", "Member
  cannot manage blueprints", "Member can create and update entities that have
  no owner team", "Member can view and list users and teams", "Member cannot
  create, update, or delete users or teams, or change roles", and "Member
  cannot delete an entity by role alone".
- [x] 8.4 Derived role `moderates_blueprint` (condition `R.attr.blueprintId in
  P.attr.moderatedBlueprints`), imported into `catalog_entity.yaml` and
  granted every action there. Verify: `moderator_test.yaml` covers "Moderator
  can update entities of a moderated blueprint" and "Moderator has no extra
  permission on a non-moderated blueprint".
- [x] 8.5 Derived role `owning_team_member` (condition `R.attr.ownerTeam in
  P.attr.teams`) imported into `catalog_entity.yaml`, plus the `register`-time
  rule restricting entity creation to a team the creator belongs to (or a
  moderator of the blueprint, or an admin). `ownerTeam` is absent, not null,
  for an entity with no owner. Verify: `ownership_test.yaml` covers "Owning
  team member can update an owned entity", "Non-owning member cannot update
  another team's entity", "Any member can update an entity with no owner
  team", "Admin can update an owned entity", and "Creating an entity owned by a team the caller does not belong to is
  denied".
- [x] 8.6 Two worked dynamic-ABAC resource-policy rules on `catalog_entity`
  (static-policy/dynamic-context pattern), documented as the pattern later
  blueprint-specific rules follow: a grant permitting `delete` where
  `resource.createdBy == principal.id`, and a deny of `update` for non-admin
  principals where `resource.locked == true` (an explicit, documented
  exception; an admin stays exempt). Verify: `dynamic_abac_test.yaml` covers "Attribute-based rule
  grants access a role alone would not" and "Attribute-based rule denies
  access a role alone would have granted". ⛔ **Stop here for Checkpoint 3
  approval of every policy file authored in 8.1-8.6 before continuing.**
- [x] 8.7 Service-layer ownership resolution (`effectiveOwnerTeam`: None,
  Direct, or Inherited, with the direct-relation-wins conflict rule) in
  `packages/authz`, computed before every Cerbos call. Verify:
  `ownership-resolution.test.ts` is a pure unit test (no Cerbos) covering
  "Direct ownership wins over a conflicting inherited configuration".
- [x] 8.8 Write ADR `docs/adr/0013-cerbos-as-sole-authorization-engine.md` and
  `docs/adr/0015-cerbos-dynamic-context-not-scoped-policies.md`. Verify: both
  files exist with Context, Decision, Alternatives and Consequences sections,
  and design D2/D7/D8 link to them.

## 9. Authorization pipeline integration

- [x] 9.1 A Cerbos `CheckResources` stage inserted into
  `defineCatalogOperation` (001) immediately after context validation and
  before the tenant transaction opens, raising `AUTH_FORBIDDEN` on deny and
  emitting `catalog.security.authz_denied` plus `tayzu.authz.decisions`.
  Verify: `authz-pipeline.int.test.ts` covers "Action with no matching rule
  is denied" and "Denied action is distinct from not found", exercised
  end-to-end through a real catalog operation.
- [x] 9.2 A `PlanResources` + `@cerbos/orm-drizzle` wrapper for
  `entities.list`, composed with the existing tenant scope via `and(...)` in
  every plan-result branch. Verify: `authz-list.int.test.ts` covers "List
  results are filtered by the query plan, not by scanning and checking", and
  a dedicated test asserting the `ALWAYS_ALLOWED` branch still carries the
  mandatory tenant `WHERE` clause.
- [x] 9.3 The evaluation-error path denies rather than allows. Verify:
  `authz-pipeline.int.test.ts` covers "Cerbos evaluation error denies rather
  than allows", using a scratch policy condition that raises a CEL error for
  the test's request shape.
- [x] 9.4 `authz.check`/`authz.plan` spans (with `cerbosCallId` correlation
  onto the enclosing operation span) and the `tayzu.authz.check.duration`
  histogram. Verify: `otel-smoke-check` (extended) asserts both spans appear
  with their required attributes on a representative operation.

- [x] 9.5 `resolveContext` fills `CatalogContext.principal` for every
  resolved actor: a session user gets `roles` from the Better Auth member role
  (`owner`/`admin` -> `admin`, else `member`) and `teams`/`moderatedBlueprints`
  from its `_user` entity (empty until group 12 syncs them); a machine token
  gets the role fixed on its credential (resolved decision Q26). Verify:
  `context-resolver.int.test.ts` covers "An admin session resolves the admin
  role", "A member session resolves the member role", and "A client cannot
  supply its own roles".

## 10. Redaction of unreadable identifiers

- [x] 10.1 A batch `CheckResources(read)` redaction helper in
  `packages/authz` that replaces unreadable identifiers in a candidate list
  with a count. Verify: `redaction.test.ts` (a pure unit test against a
  mocked Cerbos client) covers "N identifiers become a count when
  unreadable".
- [x] 10.2 Wire the helper into blueprint deletion's referrer list and
  blueprint update's compatibility-violation list. Verify:
  `blueprints.int.test.ts` gains "Referring entities the caller cannot read
  are redacted to a count", and `blueprints-update.int.test.ts` gains
  "Incompatible entities the caller cannot read are redacted".
- [x] 10.3 Wire the helper into entity deletion's referrer list (both the
  blocking case and the `detachReferences` case). Verify:
  `entities-delete.int.test.ts` gains "Delete-blocking referrers the caller
  cannot read are redacted to a count".

## 11. HTTP listener

- [x] 11.1 `apps/api`'s Fastify bootstrap mounts Better Auth's `/api/auth/*`
  catch-all route and the catalog's `OpenAPIHandler` at `/v1/*`, with
  `resolveContext` (groups 3, 5) wired as the handler's `context` function.
  Verify: `server.int.test.ts` covers one full request round trip for a
  representative procedure, authenticated by a real session cookie.
- [x] 11.2 `inputStructure: 'detailed'` on `entities.delete`'s route;
  `moveBodyFieldsToQuery` deleted. Verify: `http-query.int.test.ts` covers
  "Query-string input on a non-GET route is read from the query string"
  (`DELETE .../entities/{entity}?detachReferences=true` reaching the
  service layer with the flag set).
- [x] 11.3 An `OpenAPIHandler`-level `clientInterceptors` entry converting a
  thrown `CatalogError` into a real `ORPCError` carrying its `status`/`code`/
  `data`. Verify: `http-errors.int.test.ts` covers "HTTP error status matches
  the declared code" for every `CATALOG_*` and `AUTH_*` code in the design's
  mapping table.
- [x] 11.4 `CORSPlugin` with an explicit origin allowlist and
  `credentials: true`. Verify: `cors.int.test.ts` covers an allowed origin
  receiving CORS headers and a disallowed origin not receiving them.
- [x] 11.5 `SimpleCsrfProtectionHandlerPlugin` on every mutating route.
  Verify: `csrf.int.test.ts` covers a mutating request missing the required
  header being rejected, and one carrying it succeeding.
- [x] 11.6 `@fastify/helmet` registered with `contentSecurityPolicy: false`.
  Verify: `headers.int.test.ts` asserts the expected security headers are
  present on a response.
- [x] 11.7 Fastify's native `bodyLimit` configured, composing with 001's
  `CatalogLimits` byte-size check. Verify: `body-limit.int.test.ts` covers an
  oversized request being rejected by Fastify before `CatalogLimits` runs (a
  spy shows the catalog validator is never invoked).
- [x] 11.8 `@fastify/rate-limit`, keyed by
  `${tenantId}:${actorType}:${actorId}`, never logged or exported as a
  telemetry attribute. Verify: `rate-limit.int.test.ts` covers one
  principal's requests being rate-limited (`AUTH_RATE_LIMITED`, 429) while a
  different principal's bucket is unaffected.
- [x] 11.9 A Fastify pre-handler allowlist for `/api/auth/*` (design D18):
  Better Auth's native organization-membership-mutation routes
  (`inviteMember`, `updateMemberRole`, `removeMember`, organization
  create/delete) and every `apiKey` plugin management route return `404`;
  every other allowlisted route (sign-up, sign-in, sign-out, session read,
  two-factor enroll/verify, `setActiveOrganization`, email verification)
  remains reachable. Verify: `auth-route-allowlist.int.test.ts` covers "A
  native organization-mutation route is not reachable" and "A native API-key
  management route is not reachable", both asserting a plain `404`.
- [x] 11.10 An allowlist-drift test enumerating Better Auth's actual mounted
  routes against the allowlist constant. Verify:
  `auth-route-allowlist.test.ts` covers "An unlisted Better Auth route fails
  the allowlist test", introducing a scratch route in a throwaway branch and
  confirming the test fails, then reverting it.
- [x] 11.11 *(setup)* Verify the Better Auth `apiKey` plugin's hash-at-rest
  algorithm against `@better-auth/api-key`'s installed source (not the docs
  site), resolving the open item design's Risks section flags (SEC05).
  Verify: a short note in `docs/security/dependencies.md` records the
  confirmed algorithm and the source location checked.
- [ ] 11.12 TLS/HSTS posture on the public ACA ingress: HSTS present, TLS 1.0
  and 1.1 disabled. Verify: `headers.int.test.ts` (extended) asserts the HSTS
  header on a response, and `docs/security/dependencies.md` records the
  manual SSL-Labs-equivalent check run once against the deployed ingress.
- [x] 11.13 `@fastify/rate-limit` on `POST /v1/auth/token`, keyed by IP and by
  the request's client id, independent of 11.8's authenticated-principal
  bucket (design D20). Verify: `token-exchange-rate-limit.int.test.ts` covers
  "Machine token exchange is rate-limited independently of the authenticated
  bucket".

## 12. User and Team system blueprints

- [x] 12.1 `_user` (identifier, title, status, portRole, moderatedBlueprints)
  and `_team` (identifier, title) blueprints, created by the `system` actor
  at tenant bootstrap. Verify: `system-blueprints.int.test.ts` covers
  creation via the `system` actor succeeding and "Direct write to `_user` by
  a non-system actor is rejected" (`CATALOG_RESERVED_IDENTIFIER`).
- [x] 12.2 Better Auth hooks (sign-up, organization-member add, ban/unban)
  upsert the matching `_user` entity through the `system` actor path.
  Verify: `user-sync.int.test.ts` covers "Signing up creates a matching
  `_user` entity" (with `status` `Active`) and "Disabling a user updates its
  `_user` entity status".

## 13. Telemetry contract enforcement

- [ ] 13.1 `packages/authz/src/telemetry/contract.ts` mirrors this design's
  Observability contract (span names, metric names and units, allowed
  attribute keys, log event names), importing the shared keys from
  `@tayzu/observability/semconv`. Verify: `contract.test.ts` snapshot-asserts
  every name in the design's tables, and the `observability-auditor` review
  compares the two.
- [ ] 13.2 Extend `otel-smoke-check` to run every new auth/authz operation
  once on success and once per new error class, asserting every declared
  span, metric, and log event appears with its required attributes, and that
  no undeclared attribute key appears on any `tayzu.auth.*`/`tayzu.authz.*`
  metric. Verify: `pnpm otel-smoke-check` is green, and a deliberately added
  disallowed attribute in a scratch branch makes it fail.
- [ ] 13.3 Marker-leak test extension. Verify: `otel-smoke-check` covers a
  forced sign-in failure, MFA failure, and token-exchange failure, and
  asserts client secrets, access tokens, session tokens, TOTP codes, and
  backup codes never appear in any exported span, metric, or log attribute;
  extended (design D20) to assert a rate-limited request's caller IP and
  submitted email never appear on `auth.security.rate_limited` or
  `tayzu.auth.rate_limit.events`.
- [ ] 13.4 Wire the OTel SDK and an OTLP exporter in `apps/api`, plus
  `@opentelemetry/instrumentation-http`/`-pg` with
  `enhancedDatabaseReporting: false`. Verify: a documented manual smoke
  script in `docs/catalog/auth-and-rbac.md` produces one exported trace
  spanning an inbound HTTP request through to its Postgres span.

- [ ] 13.5 Extend `packages/authz/src/telemetry/contract.ts` with the SSO,
  account-linking, and back-channel-logout spans, metrics, and log events
  (design D23-D26: `auth.sso.callback`, `auth.backchannel_logout.received`,
  `tayzu.auth.sso.events`, `tayzu.auth.account_link.events`,
  `tayzu.auth.backchannel_logout.events`,
  `auth.security.sso_sign_in_failed`, `auth.security.account_linked`,
  `auth.security.account_unlinked`, `auth.security.step_up_insufficient`,
  `auth.security.backchannel_logout_received`). Verify: `contract.test.ts`
  (extended) snapshot-asserts every new name, and `otel-smoke-check`
  (extended) exercises `auth.sso.callback`, `auth.backchannel_logout.
  received`, and the step-up-insufficient path once each, asserting the
  Visma Connect `sub`/`sid`/tokens/email/IP never appear on any of them.

## 14. Secrets and Key Vault seam

- [ ] 14.1 Runtime/migration DB role passwords, `BETTER_AUTH_SECRET`, and the
  `jwt` plugin's signing key are read from environment variables designed to
  be Key-Vault-referenced in the Azure Container Apps deployment
  configuration, and from `.env` locally. Verify: a config-loading test
  asserts the app refuses to start with any required secret missing, and
  `docs/security/dependencies.md` (or a new `docs/security/secrets.md`)
  documents the change procedure for each new secret.

## 15. DAST

- [ ] 15.1 An OWASP ZAP baseline scan job in CI (`zaproxy/action-baseline`,
  pinned by commit SHA) against a running `apps/api` instance, using a
  throwaway test tenant/session via `ZAP_AUTH_HEADER`. Verify:
  `pnpm ci:local`'s equivalent job runs the scan, and it fails the build when
  a scratch branch seeds one known high-severity finding (reverted after
  confirming the gate works).

## 16. Docs-as-Code, ADRs, and the system diagram

- [ ] 16.1 Write ADR `docs/adr/0014-postgres-roles-and-forced-rls.md` and
  `docs/adr/0016-machine-credential-token-exchange.md`. Verify: both files
  exist with Context, Decision, Alternatives and Consequences sections, and
  design D5/D6 link to them.
- [ ] 16.2 Update `docs/architecture/system-diagram.md`: add the Fastify
  listener (now live, not dashed), the Cerbos sidecar (no external arrow),
  Key Vault (an external actor feeding the deployment pipeline and the
  running container), and Visma Connect (a new external actor with an
  outbound/inbound sign-in-and-callback arrow pair from `apps/api`, and a
  separate inbound-only arrow for the back-channel logout endpoint it calls,
  design D17/D23/D26). Verify: markdownlint passes, the Mermaid block
  renders, and every new attack-surface name in this design appears in the
  diagram.
- [ ] 16.3 Write `docs/catalog/auth-and-rbac.md` (resource kinds, the
  role/ownership model, error codes, and the telemetry reference). Verify:
  `pnpm lint:md` passes, and every name in the doc exists in
  `packages/authz/src/telemetry/contract.ts` (checked by `contract.test.ts`,
  task 13.1).
- [ ] 16.4 Write `docs/security/attack-surfaces.md`: every Better Auth
  allowlisted route, every catalog route, `/v1/auth/token`, the Visma
  Connect sign-in/callback/link/unlink routes, and the public back-channel
  logout endpoint, each with its actor category, authentication mechanism,
  and Cerbos/authorization check (VCDM pre-assessment, ticket 6; design
  D18/D23-D26). Verify: `pnpm lint:md` passes, and every route in the
  design's D13/D18/D23/D26 tables and `specs/auth-and-rbac/spec.md` appears
  in the doc.
- [ ] 16.5 Write ADR `docs/adr/0021-visma-connect-as-primary-idp.md`. Verify:
  the file exists with Context, Decision, Alternatives and Consequences
  sections, and design D23-D26 link to it.
- [ ] 16.6 *(setup)* Write `docs/references/visma-connect/README.md`: a
  concise summary of what Tayzu's implementation uses from the Visma Connect
  docs (server-side web applications, ID token, UserID/email, re
  -authentication and step-up, session management, single sign-out, security
  considerations, usage of state for redirects, userinfo endpoint, token
  revocation), each with its source URL under `docs.connect.visma.com`.
  Verify: `pnpm lint:md` passes, and every citation in design D23-D26 (`docs/
  references/visma-connect/README.md`) resolves to a section that exists in
  the file.

## 17. Integration checks before the PR (Checkpoint 2 readiness)

- [ ] 17.1 `pnpm ci:local` is fully green (lint, typecheck, unit and
  integration tests, contract-check, `policy:compile`, otel-smoke-check,
  audit, gitleaks, ZAP baseline). Verify: attach the command output to the
  PR description.
- [ ] 17.2 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against
  the implemented code, and resolve or explicitly defer every blocking GAP.
  Verify: the report is attached to the PR, with zero open blocking GAPs.
- [ ] 17.3 Run `/security-review` on the branch and fix or justify every
  finding, then re-check `docs/architecture/system-diagram.md` against the
  implementation. Verify: the review output and any diagram diff are
  attached to the PR.
- [ ] 17.4 `openspec validate 002-auth-and-rbac --strict` passes, and the
  design, specs and code agree (update the design only if an implementation
  finding forced a change, and note it in the PR). Verify: the command
  output is attached to the PR.

## 18. Public self sign-up disabled; admin and bootstrap user creation

- [x] 18.1 A test-only helper (e.g. `createAdminUser`/`bootstrapTestTenant`)
  in the test harness that creates users through the admin-creation path
  instead of Better Auth sign-up, and migrate every existing fixture that
  called sign-up (groups 2-4's integration tests) to use it (design D22).
  Verify: `auth-instance.test.ts` (extended) asserts
  `auth.options.emailAndPassword.disableSignUp === true`, initially failing
  since the flag is not yet set (green in 18.2); the migrated fixtures in
  `auth-flow.int.test.ts`, `mfa.int.test.ts`, `step-up.int.test.ts`,
  `session-policy.int.test.ts`, `context-resolver.int.test.ts`,
  `active-org.int.test.ts`, and `enumeration-resistance.int.test.ts` keep
  passing unchanged in behavior.
- [x] 18.2 `emailAndPassword.disableSignUp: true` on the Better Auth
  instance; the sign-up route is not added to D18's allowlist (design D22).
  Verify: `signup-disabled.int.test.ts` covers "Self sign-up is not
  available" (a plain `404`, identical to an unknown route) and "In-process
  sign-up is refused".
- [x] 18.3 `identity.users.create`: a Cerbos-gated oRPC procedure (`admin`
  role, `user.yaml` resource policy) calling `auth.api.createUser`
  in-process, fixing the created user's initial role and returning a
  system-generated temporary password once, in the creation response only
  (design D22). Verify: `admin-user-creation.int.test.ts` covers "An org
  admin can create a user" and "A member cannot create a user"
  (`AUTH_FORBIDDEN`).
- [x] 18.4 `packages/auth/scripts/bootstrap-admin.ts`: an idempotent,
  non-HTTP-reachable script creating an organization and its first `admin`
  -role user, via the same `auth.api.createUser` call as 18.3 (design D22).
  Verify: `bootstrap.int.test.ts` covers "Bootstrapping an organization's
  first admin is idempotent" (running it twice creates no duplicate
  organization or user).
- [x] 18.5 Wire `identity.users.create` and the bootstrap script to upsert
  the matching `_user` entity through the `system` actor path, replacing the
  sign-up-triggered hook task group 12 assumed (design D22, spec "User and
  Team system blueprints"). Verify: `user-sync.int.test.ts` covers "Creating
  a user creates a matching `_user` entity" for both the admin-created and
  bootstrap-created cases.

## 19. Visma Connect SSO

- [x] 19.1 *(setup)* A local OIDC provider test stub/fixture (its own RSA
  keypair, discovery document, JWKS, and authorization/token/userinfo
  endpoints) so no test in this or later groups calls the real Visma
  Connect. Verify: `pnpm --filter @tayzu/auth test` runs the stub's own
  smoke test, standing it up and tearing it down cleanly.
- [x] 19.2 `packages/auth/src/sso/visma-connect.ts`: the `genericOAuth`
  plugin configured per design D23 (`providerId: "visma-connect"`,
  `discoveryUrl` pointed at the task-19.1 stub in tests, `requireIdToken
  Verification: true`, PKCE S256, `responseMode: "form_post"`, `scopes:
  ["openid", "email", "profile"]`, `disableImplicitSignUp: true`,
  `disableSignUp: true`, `overrideUserInfo: false`, `clientId`/`clientSecret`
  from the environment). Verify: `sso-config.test.ts` asserts the registered
  provider's options match the design D23 table, and that no `accountSubject`
  resolver is configured (Better Auth's own discovery-default `sub`
  resolution is relied on, not reimplemented).
- [x] 19.3 Add `/sign-in/social`, `/callback/visma-connect`, `/link-social`,
  `/unlink-account`, and `/list-accounts` to D18's allowlist (design D23).
  Verify: `auth-route-allowlist.int.test.ts` (extended) covers all five
  routes remaining reachable, and `auth-route-allowlist.test.ts` (extended,
  task 11.10's drift test) still fails when an unlisted route is introduced.
- [ ] 19.4 The `/callback/visma-connect` handler maps every failure mode
  (unlinked `sub`, `state`/`nonce` mismatch, invalid or unverifiable
  `id_token`) to the same `AUTH_SSO_REJECTED` response, recording the
  internal cause only on `auth.security.sso_sign_in_failed` (design D24).
  Verify: `sso-sign-in.int.test.ts` covers "Sign-in with an unlinked Visma
  Connect account is rejected generically" and "A mismatched state value is
  rejected the same way as an unlinked account", asserting byte-identical
  status/error-code/body shape across both.
- [ ] 19.5 A successful sign-in for a `sub` already linked to a Tayzu user
  resolves to that user's context (design D23/D24). Verify:
  `sso-sign-in.int.test.ts` covers "Sign-in with a linked Visma Connect
  account succeeds", plus the `auth.sso.callback` span and
  `tayzu.auth.sso.events` counter on both the success and rejected paths.

## 20. Account linking

- [ ] 20.1 `identity.users.linkSsoAccount` / `identity.users.
  unlinkSsoAccount`: Cerbos-gated oRPC procedures (`admin` role) writing or
  removing an `account` row for a target user, keyed on the Visma Connect
  `sub`, using `@tayzu/auth`'s internal adapter directly rather than Better
  Auth's session-scoped `/link-social` (design D24). Verify:
  `account-linking.int.test.ts` covers "An admin records a user's Visma
  Connect UserID".
- [ ] 20.2 A Fastify pre-handler on `/link-social` reusing task 4.2's
  `twoFactorVerifiedAt` freshness check, requiring a fresh MFA verification
  when the caller has an enrolled factor (design D24). Verify:
  `link-social-step-up.int.test.ts` covers "A signed-in user links their own
  Visma Connect account" and "Linking without a fresh MFA verification is
  blocked for an MFA-enrolled user" (`AUTH_STEP_UP_REQUIRED`).
- [ ] 20.3 A last-sign-in-method guard, shared by `identity.users.
  unlinkSsoAccount` and Better Auth's own `/unlink-account`/password-removal
  paths, rejecting an unlink or password removal that would leave the user
  with zero sign-in methods (design D24). Verify: `account-linking.int.
  test.ts` covers "Unlinking the only sign-in method is rejected".
- [ ] 20.4 `auth.security.account_linked`/`account_unlinked` log events and
  the `tayzu.auth.account_link.events` counter on both linking paths (design
  D24). Verify: `account-linking.int.test.ts` (extended) asserts both
  signals on the admin-recorded case, and `link-social-step-up.int.test.ts`
  (extended) asserts them on the self-service case.

## 21. JIT display-data refresh and step-up for SSO sessions

- [ ] 21.1 On every successful Visma Connect sign-in, call `/connect/
  userinfo` and write the returned name/email to the `_user` entity's
  `title`/`contactEmail` display fields only, through the `system` actor
  path — never Better Auth's `user.email` column (design D24). Verify:
  `sso-jit-refresh.int.test.ts` covers "Display name and email are
  refreshed on sign-in" and "A changed Visma Connect email does not alter
  local sign-in identity".
- [ ] 21.2 A migration adding `session.additionalFields.ssoSid` (nullable
  text) to the already-migrated `auth.session` table, populated from the
  Visma Connect `sid` claim on sign-in/refresh and left `null` for local
  sessions (design D25). Verify: `session-schema.int.test.ts` asserts the
  column via `information_schema`. ⛔ **Stop here for Checkpoint 3 approval
  of this migration's SQL before continuing.**
- [ ] 21.3 The step-up guard (task 4.2) branches on `ssoSid`: `null` keeps
  D4's existing local `twoFactorVerifiedAt` check unchanged; non-null
  initiates a Visma Connect re-authorization
  (`max_age=300&prompt=login&acr_values=urn:idp:vismaconnect:mfa`) and
  validates the returned ID token's `auth_time` (within 300s ± 30s skew),
  `acr` (>= 3), and `amr` (containing an accepted MFA method) server-side
  (design D25). Verify: `step-up-sso.int.test.ts` covers "A fresh Visma
  Connect re-authorization with an MFA method satisfies step-up" and "A
  Visma Connect re-authorization without a qualifying MFA claim does not
  satisfy step-up", plus the `auth.security.step_up_insufficient` log event
  on the failing case.

## 22. Back-channel logout

- [ ] 22.1 `POST /v1/auth/visma-connect/backchannel-logout`: a public route
  outside `/api/auth/*`, parsing the `logout_token` form field and
  validating, in order, its signature (via the discovered JWKS), `typ`,
  `iss`, `aud`, `iat`/`exp` (±30s skew), `events`, and the absence of a
  `nonce` claim, failing closed at the first failing check (design D26).
  Verify: `backchannel-logout.int.test.ts` covers "An invalid signature is
  rejected without revealing session existence", using task 19.1's stub
  keys for both a validly-signed and a tampered token.
- [ ] 22.2 `jti` replay protection reusing the existing `auth.verification`
  table (`identifier: "backchannel-logout:{aud}:{jti}"`, `expiresAt`
  bounded by the token's own `exp` plus skew) — no new table (design D26).
  Verify: `backchannel-logout.int.test.ts` covers "A replayed logout token
  is rejected without revoking anything twice".
- [ ] 22.3 Session revocation matching primarily by `sid` (via the `ssoSid`
  column, task 21.2) and, when the token omits `sid`, by `sub` via the
  linked `account` row — revoking only that user's Visma-Connect
  -established sessions, never their local sessions (design D26). Verify:
  `backchannel-logout.int.test.ts` covers "A valid logout token revokes the
  matching session", asserting the session fails as `CATALOG_CONTEXT_
  REQUIRED` afterward while a same-user local session remains valid.
- [ ] 22.4 `@fastify/rate-limit` on this route keyed by source IP only
  (there is no caller identity to key on); every outcome (revoked, replay,
  invalid, no-match) returns the identical `200` response shape (design
  D26). Verify: `backchannel-logout.int.test.ts` (extended) asserts response
  -shape identity across all four outcomes, plus the `auth.backchannel_
  logout.received` span and `tayzu.auth.backchannel_logout.events` counter,
  with no `sub`/`sid`/token/email/IP attribute on either signal.
