# Design: 002-auth-and-rbac

## Context

- `001-catalog-core` shipped the domain layer, the operation pipeline
  (`defineCatalogOperation`), and a tenant-transaction seam
  (`withTenantTransaction`) that sets `app.tenant_id` but activates no RLS
  policy yet (`design.md` D5). It also shipped `ActorType`/`Principal`/
  `onBehalfOf` (D3), the reserved-`_`-prefix rule (spec "Reserved system
  identifiers"), and the `x-tayzu-risk: high` marker on `blueprints.update`,
  `blueprints.delete`, and `entities.delete` (D11) — with no consumer until
  now. See `proposal.md` (Why) for the roadmap pressure this relieves and the
  scope split.
- Fixed stack decisions this design builds on (`openspec/project.md` §2, §6,
  §23): Better Auth (`organization`, `admin`, `api-key`, `two-factor`
  plugins), Cerbos, shared schema + `tenant_id` + RLS (ADR-0006), Fastify +
  oRPC, Drizzle, PostgreSQL 16, Azure Container Apps, OpenTelemetry → Azure
  Monitor.
- Package/version facts below are verified against `npm view` and the
  installed lockfile as of 2026-09-28 (research notes
  `scratchpad/p002/r2-better-auth.md`, `r3-cerbos.md`, `r4-data-http.md`),
  not training-data memory, because Better Auth and Cerbos are exactly the
  "new/niche" libraries `project.md` §17 flags for this treatment. Better
  Auth 1.7 split `api-key`, `sso`, `mcp`, and their satellites into separate
  packages from `better-auth` core — `project.md` §2's line naming a single
  "Better Auth (plugins: ...)" dependency needs two `package.json` entries,
  not one.
- Port reference: `docs/references/port/roadmap-analysis.md:40-59` (the 002
  row) and the exhaustive extraction in `scratchpad/p002/r1-port.md`. Per
  `project.md` §22, `docs/references/platform-engineering/README.md:58`
  is this change's reference row; its "environment" RBAC dimension and
  "generic OIDC federation" items are addressed in Resolved decisions
  below (OQ-1, and the `025` split respectively), not silently adopted.

## Goals / Non-Goals

**Goals:**
- Every catalog operation — human, agent, or integration — passes through
  exactly one authentication resolver and exactly one authorization engine
  (Cerbos), reusing 001's "same path" pipeline rather than adding a second one.
- Tenant isolation becomes a database-enforced guarantee, not only an
  application-level discipline: RLS with `FORCE ROW LEVEL SECURITY` under a
  non-owner runtime role, so 001's own isolation tests become RLS tests with
  no rewrite (001 D5's stated precondition).
- The first network listener ships with the defenses a public-facing API
  needs from day one (CORS, CSRF, security headers, size limits, rate
  limiting, DAST), not as later hardening.
- A design that `043-identity-lifecycle-and-org-admin` can build on directly:
  the `_user`/`_team` blueprint shape, the machine-credential mechanism, and
  the Cerbos resource kinds are frozen here.

**Non-Goals:**
- No 4-state user status/invitation lifecycle, no invitation email, no
  service accounts, no org API-credentials viewer UI, no data
  retention/deletion policy, no org deletion. All `043`.
- No generic OIDC/SAML/SCIM federation, no group-sync, no "automatic user
  access" toggle. All `025-sso-and-identity-federation`.
- No permission simulator, no "view as", no per-page ACLs, no workflow
  execute-permission model. All `014-governance-and-policy-simulation` /
  `006-workflow-engine-core`.
- No multi-org UX (org switcher, per-org independent sessions). `project.md`
  §23 D7 keeps 002 at "few known tenants, no org switcher"; `042-multi-org`.
- No Cerbos `scope` (scoped policies) for tenant hierarchy — `tenantId` is a
  plain attribute, not a Cerbos scope (Resolved decision, below).
- No impersonation ("view as"). Better Auth's `admin` plugin ships it, but it
  is not in the roadmap's 002 scope and is deferred implicitly to `014`.

## Decisions

### D1. Package layout

```
apps/
  api/                     # first application: Fastify bootstrap
packages/
  auth/        @tayzu/auth   # Better Auth instance, schema, hooks, context resolver
  authz/       @tayzu/authz  # Cerbos client, attribute builders, resource-kind constants
  catalog/     @tayzu/catalog  # unchanged package, HTTP-transport fixes only (D13)
  db/          @tayzu/db       # gains role/RLS migration helpers
  observability/                # unchanged
policies/                    # Cerbos policy YAML + test suites, not an npm package
  derived_roles/
  role_policies/
  resource_policies/
    testdata/
docs/adr/                    # ADR-0013 onward
```

`apps/api` is the first `apps/*` package (001 had none, D2 there). It depends
on `@tayzu/auth`, `@tayzu/authz`, and `@tayzu/catalog`, and owns nothing
domain-specific itself — it is bootstrap glue (Fastify server, route
mounting, process lifecycle), consistent with "the UI a thin layer over the
API" reasoning `docs/references/platform-engineering/README.md:59` gives for
`003`, applied here to the API host.

- *Alternative:* fold the HTTP bootstrap into `@tayzu/catalog`. Rejected:
  `@tayzu/catalog` is still consumed in-process by tests and (later) by
  workers that never need Fastify; keeping the listener in its own app avoids
  pulling `fastify` into every consumer's dependency tree.

### D2. Better Auth instance

`@tayzu/auth` registers `organization`, `admin`, `two-factor` (all bundled in
`better-auth@1.7.6`), `jwt` (bundled — needed here, not deferred to `026`, see
D5), and `apiKey` from the separate `@better-auth/api-key@1.7.6` package.
Database access uses `@better-auth/drizzle-adapter@1.7.6` (the dedicated
package, not the bundled `better-auth/adapters/drizzle` export — it is the
one whose own docs page covers `schemaName` in depth, which D6 needs) with
`schemaName: "auth"`, so every Better Auth table lives in its own Postgres
schema, never `public`. `dynamicAccessControl` stays off: Better Auth's roles
are read by Cerbos as plain input attributes (`member.role`), and Cerbos is
the only place an authorization decision is made — running both would be the
literal "multiple ways to do access control" SEC03 anti-pattern.
`session.cookieCache` stays off (no revocation-latency gap to explain in the
SSA). Better Auth's own `teams` plugin option stays disabled: `_team` is a
catalog system blueprint (D9), not a second, Better-Auth-native notion of
team membership Cerbos policies would have to reconcile with catalog
relations.

- *Alternative considered (O1 in `r2-better-auth.md`):* let Better Auth's
  `ac`/custom roles do some authorization work directly. Rejected for the
  reason above.

### D3. Tenant and session resolution

`tenantId = session.activeOrganizationId`, persisted on the session row (not
client-only): project.md §6 already assumes "few known tenants," so there is
no multi-tab/multi-org switching concern this trades away. `session.expiresIn`
= 7 days (Better Auth default, kept), `session.updateAge` = 1 day (kept, this
is the rolling-refresh granularity, not the idle-timeout granularity). The
12-hour idle timeout (Resolved decision Q7) is enforced separately: every
session row's `updatedAt` is checked against "now" on each use; a session
whose last use exceeds 12 hours is treated as expired even though Better
Auth's own `expiresIn` has not elapsed. `changePassword` is called with
`revokeOtherSessions: true`.

### D4. Multi-factor authentication and step-up

`two-factor` plugin (TOTP as the default factor, backup codes). Step-up
(Resolved decision Q6) is implemented as an oRPC-level guard, not a Better
Auth feature: every procedure whose `route.spec` carries `x-tayzu-risk: high`
is wrapped so that, for a `user` actor only, the guard calls
`auth.api.verifyTwoFactor`'s underlying freshness check (a
`twoFactorVerifiedAt` timestamp stored on the session, updated whenever
`/two-factor/verify` succeeds) and rejects with `AUTH_STEP_UP_REQUIRED` if
older than 5 minutes or absent. `agent`/`integration`/`system` actors skip
this guard entirely (Cerbos already decided whether they may act; step-up is
a human-specific control, matching the spec's own restriction).

### D5. Machine credentials

Resolved decision Q5 asks for a client-credentials-style exchange (long-lived
client id/secret → short-lived access token), which is Port's own machine-auth
pattern (`r1-port.md` §8.2) adapted to a 1-hour token instead of Port's 3
hours. Mechanism:
- The long-lived credential is an `apiKey` plugin key, config
  `machine-credential` (`references: "organization"`, `defaultPrefix:
  "tayzu_mc_"`), created by an admin. Its `id` is the client id; its
  generated key is the client secret, shown once, hashed thereafter (Better
  Auth default — `disableKeyHashing` is never set).
- A new procedure, `POST /v1/auth/token`, is **not** part of Better Auth's
  own route set. It calls `auth.api.verifyApiKey({ body: { key } })`; on
  success it mints a 1-hour token via the `jwt` plugin
  (`auth.api.getToken`-equivalent, scoped to `{ tenantId: key.referenceId,
  actor: { type: key.metadata.actorKind, id: key.id } }`), signed with the
  `jwt` plugin's own key (exposed at `/jwks` for future `026-mcp-server`
  reuse, per `r2-better-auth.md` §10 — adopting `jwt` now instead of
  deferring it is the one place this design revises that earlier research
  note). On failure it returns `AUTH_INVALID_CREDENTIALS`.
- `actorKind` (`integration` or `agent`) is fixed at credential-creation time
  via the config's `metadata`, never chosen by the caller of `/v1/auth/token`.
- Rotation is revoke-and-recreate (Better Auth ships no rotate endpoint,
  `r2-better-auth.md` §6) — the admin-facing rotation *policy* (reminders,
  UX) is `043`; 002 only guarantees the mechanism exists.
- *Alternative considered:* use the raw `apiKey` as a bearer token directly
  (no exchange step), matching `enableSessionForAPIKeys` for user-owned keys.
  Rejected for machine credentials specifically: Q5 explicitly asks for a
  short-lived derived token, and organization-owned keys cannot use
  `enableSessionForAPIKeys` at all (`r2-better-auth.md` §6) — the exchange
  step is not optional here.

### D6. Postgres roles, grants, and RLS

Three roles (`r4-data-http.md` Part (a), Resolved decision Q9):

| Role | Owns | RLS |
|---|---|---|
| `tayzu_migrator` | catalog + `auth`-schema tables (DDL) | Bypasses (owner); never used at runtime |
| `tayzu_app` | nothing; `SELECT/INSERT/UPDATE/DELETE` on catalog tables only, `SELECT/INSERT` only on `catalog_change_event` | Subject to, and `FORCE`d |
| `tayzu_auth` | nothing; full CRUD on `auth`-schema tables only, no grants on any `catalog_*` table | Not applicable — Better Auth's own tables are never tenant-scoped rows (D2) |

Every catalog table gets `pgPolicy('tenant_isolation', { to: tayzu_app, for:
'all', using: sql`tenant_id = current_setting('app.tenant_id', true)`,
withCheck: <same> })` (Drizzle's `pgRole`/`pgPolicy`, `r4-data-http.md` a.5).
`GRANT`/`REVOKE`/`FORCE ROW LEVEL SECURITY` are not expressible through
Drizzle and land as one hand-written custom SQL migration, the same pattern
001 used for the append-only trigger. `tayzu_auth` never runs inside
`withTenantTransaction` — Better Auth's own tables have no `tenant_id`
column to scope by (`organization` itself is the tenant and needs no parent
scope; `user`/`session`/`account` are cross-org by design).

The test harness (`getTestDatabase()`, `@tayzu/db`) applies migrations as
`tayzu_migrator` and hands back a pool connected as `tayzu_app` for actual
test queries, so 001's isolation tests become RLS tests unchanged (001 D5's
stated precondition) plus one new test: a query with `app.tenant_id` unset
returns/affects zero rows (never an error), and a negative-control test
confirms `tayzu_migrator` itself is not reachable from any runtime code path.

### D7. Cerbos engine wiring

Container `ghcr.io/cerbos/cerbos:0.55.0`, pinned by digest, deployed as an
Azure Container Apps sidecar in the same revision as `apps/api` (`r3-cerbos.md`
§7.3) — no TLS on that loopback link (Resolved decision Q8: ACA sidecar
containers share a network namespace with no external reachability; TLS
stays mandatory for every other Cerbos link Tayzu might add later). Storage
driver: **disk**, policies baked into the deploy artifact from the same
`policies/` tree reviewed at Checkpoint 3 — no git or database storage driver
(Tayzu doesn't need runtime-mutable policies in Phase 1). `engine.
strictEvaluation: true` (Resolved decision Q9 — a CEL error denies the whole
action, not just the one rule, matching the fail-closed invariant more
completely than v0.55's own per-DENY-rule default). `audit.decisionLogsEnabled
= true`, `accessLogsEnabled = false` (denies are visible; full access-log
volume is not needed yet); every decision log's `cerbosCallId` is attached to
the calling operation's span (D14). `@cerbos/grpc@0.29.1` is the client (lower
overhead than the HTTP gateway); `@cerbos/orm-drizzle@0.1.0` turns
`PlanResources` results into Drizzle `WHERE` clauses for every list operation
(`entities.list`). No Cerbos `scope` is used (Resolved decision Q9/OQ-1's
sibling question, D-C in `r3-cerbos.md`): `tenantId` is a plain attribute, per
Cerbos's own "dynamic context" pattern for multi-tenancy
(`r3-cerbos.md` §3.1, §11 D-A), which is also the pattern that keeps
`/policies` small enough to hand-review at Checkpoint 3 rather than minting a
resource-kind file per blueprint.

Resource kinds (Conventions in `specs/auth-and-rbac/spec.md`): `catalog_
blueprint`, `catalog_entity`, `team`, `user`. A derived role `same_tenant`
(`parentRoles: ["*"]`, condition `R.attr.tenantId == P.attr.tenantId`) is
imported into every resource policy's every rule, so a rule that forgets an
explicit tenant check still can't cross tenants — defense in depth on top of
D6's RLS, not instead of it (`r3-cerbos.md` §3.2, and the same "Cerbos has no
visibility into Postgres" caveat: `PlanResources`'s `ALWAYS_ALLOWED` result is
never treated as "skip the tenant filter," it composes with the mandatory
tenant scope via `and(...)`).

### D8. Role and ownership policies

Role policies (`r3-cerbos.md` §3.3): `admin` (`parentRoles: ["member"]`,
`allowActions: ["*"]` on every resource kind) and `member` (`view`, `list`,
`create`, `update` on `catalog_entity`; `view`, `list` only on
`catalog_blueprint`). Moderator is a derived role, `moderates_blueprint`,
condition `R.attr.blueprintId in P.attr.moderatedBlueprints`, imported by
`catalog_entity`'s resource policy and granted every action there. Team
ownership is a second derived role, `owning_team_member`, condition
`R.attr.ownerTeam in P.attr.teams` (`r3-cerbos.md` §3.4) — `ownerTeam` is
computed by the service layer *before* the Cerbos call (D9), never by Cerbos
walking a relation chain itself.

Every action a role policy lists is cross-checked against the matching
resource policy at Checkpoint 3 review time (`r3-cerbos.md`'s own
documented #1 pitfall: a role-policy allow does nothing without a matching
resource-policy allow) — a `cerbos compile` test asserts the *combination*,
not each file type in isolation, per resource kind.

### D9. Ownership resolution (None / Direct / Inherited)

The catalog service, not Cerbos, resolves `effectiveOwnerTeam` for an entity
before every Cerbos call: `None` if no ownership is configured, the entity's
own team relation for `Direct`, or the value read along the blueprint's
declared relation chain for `Inherited`. The conflict rule (Port's own,
`r1-port.md` §4.5) is applied here: a blueprint configured with both
`Inherited` ownership and a direct team relation resolves as `Direct` — the
inherited path is never consulted once a direct relation exists. This mirrors
001 D3's line that Cerbos consumes attributes and never computes domain
logic; the service already has the entity and its blueprint loaded, so
walking the chain in Cerbos would duplicate work the service does anyway and
would need Cerbos to understand catalog relations, which it must not.

### D10. Dynamic ABAC

The static-policy/dynamic-context pattern (`r3-cerbos.md` §3.1, §3.5): a
tenant admin's rule is stored as a CEL condition attached to the existing
`catalog_entity` resource policy at deploy time (Checkpoint 3, same as every
other policy change) — there is no runtime "write a policy" API in Phase 1.
This keeps the promise in the spec's Dynamic ABAC requirement (a rule adds to,
never replaces, role/ownership checks) trivially true: it is one more `OR`ed
rule in the same file, evaluated by the same engine, with the same
default-deny fallback.

### D11. Authorization wrapping the operation pipeline

001's `defineCatalogOperation` (D3 there) already runs: context validation →
span → limits → `withTenantTransaction` → error mapping → telemetry. 002
inserts a Cerbos check immediately after context validation and before the
transaction opens, as a new pipeline stage (not a second entry point — the
same function every operation already calls through). For a single-resource
operation (`get`, `create`, `update`, `delete`, `writeStatus`) it calls
`CheckResources` with the resource attributes the operation already has
in hand (or, for `create`, the attributes the entity *would* have — mirroring
Port's own `register`-time simulation, `r1-port.md` §4.4). For `list`, it
calls `PlanResources` and folds the result into the same Drizzle query that
already applies the tenant scope (D7). A deny raises `AUTH_FORBIDDEN` before
any database work happens, recording `catalog.security.authz_denied` (D14)
and incrementing `tayzu.authz.decisions`. This keeps 001's actor-parity
principle intact: the wrapper runs identically for every `actor.type`; only
the attributes Cerbos receives (role, team, moderatedBlueprints) differ, and
they differ as data, never as a branch in code.

### D12. Redaction of unreadable identifiers (R3)

Where 001 already lists offending/referring entity identifiers
(`CATALOG_SCHEMA_INCOMPATIBLE`, `CATALOG_REFERENCE_VIOLATION`), the service
now runs a batch `CheckResources(read)` over the candidate list before
formatting the error, using the same Cerbos client D11 already wires in. Any
identifier the caller cannot read is dropped from the named list and rolled
into a `+N not visible` count. This is a formatting step inside 001's already
-fixed error-mapping path (D11 there): it changes what goes into the message,
not the error code, and it runs whether or not the operation itself is
ultimately allowed to proceed (the redaction protects information disclosure
about *other* entities' existence, which is orthogonal to whether the
current caller may perform the delete/update).

### D13. HTTP listener (Fastify + oRPC)

`apps/api` mounts two handlers behind one Fastify instance: Better Auth's own
catch-all route (`/api/auth/*`, `auth.handler`) and the catalog's
`OpenAPIHandler` (`/v1/*`). Fixes 001 flagged as follow-ups
(`r4-data-http.md` Part (b), verified against installed `@orpc/*@1.15.4`
source, not the docs site's v2-beta default):
- **Query-string parity**: `entities.delete`'s route (and any other
  non-`GET` route with a query-declared field) sets `inputStructure:
  'detailed'`, so the runtime reads `query`/`params`/`body` exactly as the
  generated OpenAPI document already describes them. `moveBodyFieldsToQuery`
  (001's document-only patch) is deleted; it never fixed the runtime.
- **HTTP error-status parity**: an `OpenAPIHandler`-level `clientInterceptors`
  entry catches any thrown `CatalogError`, reads the `status`/`code`/`data`
  `toApiError` already computed, and throws a real `ORPCError` with them —
  confined to this one bootstrap file, so `packages/catalog`'s existing
  `errors.ts` and its in-process tests are untouched.
- **CORS**: `CORSPlugin`, explicit origin allowlist, `credentials: true`
  (required for Better Auth's cookie).
- **CSRF**: `SimpleCsrfProtectionHandlerPlugin` (custom-header check) on
  every mutating route, defense-in-depth alongside the session cookie's
  `SameSite=Lax`.
- **Security headers**: `@fastify/helmet`, `contentSecurityPolicy: false`
  (this is a JSON API; CSP is `003`'s concern).
- **Body size limits**: Fastify's native `bodyLimit` (oRPC's own
  `BodyLimitPlugin` does not exist for the Fastify adapter, confirmed against
  installed package exports), composing with 001's own `CatalogLimits`
  byte-size check as a second, cheaper layer.
- **Rate limiting**: `@fastify/rate-limit@^11.2.0` (Resolved decision Q9 over
  the experimental `@orpc/experimental-ratelimit`), keyed by
  `${tenantId}:${actor.type}:${actor.id}` — never exported to telemetry as an
  attribute, only used as an internal bucket key.

### D14. Observability wiring becomes real

001 depended on the OTel API only, with no SDK/exporter (its D2, Non-Goals).
002 is where `apps/api` first configures the SDK and an OTLP exporter toward
Azure Monitor, plus `@opentelemetry/instrumentation-http` /
`instrumentation-pg` with `enhancedDatabaseReporting: false` carried forward
from 001's own Postgres-span discipline, so inbound request bodies/headers
are never recorded verbatim. See the Observability contract below for the
new spans, metrics, and log events this change adds on top of 001's.

### D15. Secrets and Key Vault

The runtime (`tayzu_app`) and migration (`tayzu_migrator`) role passwords,
`BETTER_AUTH_SECRET`, and the `jwt` plugin's signing key all move to Azure
Key Vault, referenced natively by Azure Container Apps
(`project.md` §7) rather than read from `.env` in any deployed environment;
the local/test harness keeps using `.env`/environment variables directly,
consistent with 001's "Secrets: configuration comes from the environment
only" invariant, which Key Vault-backed env vars still satisfy.

### D16. DAST

An OWASP ZAP baseline (passive) scan runs in CI against a running `apps/api`
instance with a throwaway test tenant and session, using the action's own
`ZAP_AUTH_HEADER` support to reach authenticated routes
(`r4-data-http.md` §b.9). This complements, and does not replace, the active
DAST tool (Escape) named for `022-integrations-security-batch` — recorded
explicitly so the split isn't mistaken for full DAST coverage.

### D17. Docs-as-Code and ADRs from this change

- `0013-cerbos-as-sole-authorization-engine.md` (D2, D8)
- `0014-postgres-roles-and-forced-rls.md` (D6)
- `0015-cerbos-dynamic-context-not-scoped-policies.md` (D7)
- `0016-machine-credential-token-exchange.md` (D5)

`docs/architecture/system-diagram.md` gains three components: the Fastify
listener (now actually serving traffic, previously a dashed/planned node),
the Cerbos sidecar (an internal component with no external arrow — nothing
outside the trust boundary talks to it directly), and Key Vault (an external
actor supplying secrets to the deployment pipeline and the running
container). `docs/catalog/auth-and-rbac.md` documents the resource-kind
taxonomy, the role/ownership model, and the telemetry reference, mirroring
001's `docs/catalog/catalog-core.md`.

## Observability contract

`packages/authz/src/telemetry/contract.ts` is this section's executable
mirror, following the same pattern 001's `packages/catalog/src/telemetry/
contract.ts` established. The `otel-smoke-check` (extended, not duplicated)
runs every new operation once on success and once per new error class.
Shared attribute keys (`tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`)
are imported from `@tayzu/observability/semconv` (001 D13/T5b), not
redefined.

### Spans

| Span name | When | Required attributes | Conditional attributes |
|---|---|---|---|
| `authz.check` | child of every catalog operation span, before the transaction | `tayzu.authz.resource.kind`, `tayzu.authz.action` | `tayzu.authz.cerbos.call_id` |
| `authz.plan` | child, for `entities.list` only | `tayzu.authz.resource.kind` | `tayzu.authz.plan.kind` (`always_allowed`\|`always_denied`\|`conditional`) |
| `auth.token.exchange` | `POST /v1/auth/token` | `tayzu.auth.credential.kind` (`integration`\|`agent`) | — |
| `auth.session.step_up_check` | any `x-tayzu-risk: high` operation invoked by a `user` actor | — | `tayzu.auth.step_up.fresh` (bool) |

### Metrics

| Instrument | Type, unit | Attributes | Purpose |
|---|---|---|---|
| `tayzu.authz.decisions` | Counter, `{decision}` | `tayzu.tenant.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action`, `tayzu.authz.decision` (`allow`\|`deny`) | Authorization volume and deny rate |
| `tayzu.authz.check.duration` | Histogram, `s` | `tayzu.authz.resource.kind` | Cerbos call latency |
| `tayzu.auth.session.events` | Counter, `{event}` | `tayzu.auth.event` (`login_succeeded`\|`login_failed`\|`logout`\|`session_revoked`) | Authentication security signal |
| `tayzu.auth.mfa.events` | Counter, `{event}` | `tayzu.auth.event` (`challenge_issued`\|`verified`\|`failed`) | MFA usage and failure signal |
| `tayzu.auth.step_up.required` | Counter, `{event}` | `tayzu.catalog.operation` | Step-up friction signal |
| `tayzu.auth.token.exchanges` | Counter, `{exchange}` | `tayzu.auth.credential.kind`, `tayzu.auth.exchange.outcome` (`success`\|`invalid_credentials`) | Machine-credential usage and abuse signal |

- **Cardinality budget**: `tayzu.auth.credential.kind` and
  `tayzu.authz.resource.kind` are closed enums (at most 4 values). Actor IDs,
  credential IDs, and entity identifiers are never metric attributes, per
  001's existing cardinality guard, which this change extends rather than
  relaxes.

### Log events (OTel Logs API)

| Event name | Severity | Attributes | Purpose |
|---|---|---|---|
| `auth.security.login_succeeded` | INFO | `tayzu.tenant.id`, `tayzu.actor.id` | Auth audit trail |
| `auth.security.login_failed` | WARN | `tayzu.auth.failure_reason` (`bad_credentials`\|`mfa_failed`\|`account_disabled`) | Brute-force / misuse signal |
| `auth.security.session_revoked` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.revocation.reason` (`password_change`\|`admin_action`) | Auth audit trail |
| `catalog.security.authz_denied` | WARN | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action` | Distinguishes a Cerbos deny from a validation error or a not-found (SEC16) |
| `auth.security.step_up_required` | WARN | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.catalog.operation` | High-risk-operation friction and misuse signal |
| `auth.security.token_exchange_failed` | WARN | `tayzu.auth.credential.kind` | Machine-credential abuse signal |

- **Sampling exemption**: every event above, plus 001's own
  `catalog.security.*` events, MUST be exempt from sampling and from filter
  or drop rules in any downstream pipeline (extends 001 D13's exemption list,
  same rule, same rationale — `010` inherits it as a Collector-configuration
  constraint).
- **Forbidden on any signal**: the same list 001 already bans (property
  values, titles, descriptions, validation messages, SQL bind values), plus:
  client secrets, access tokens, session tokens, TOTP codes, and backup
  codes, in raw or hashed form.

## Security considerations (SSA pre-assessment)

Pre-assessed by the `vcdm-ssa-validator` agent before Checkpoint 1, building
directly on the analysis already done in `scratchpad/p002/r5-carryover-
security.md` §5 (which itself extended 001's own per-section table). Per
-section posture:

| Section | Applies | Posture after this design |
|---|---|---|
| SEC01 Diagram | Yes | Fastify listener (now live), Cerbos sidecar, Key Vault added (D17). |
| SEC02 Attack surfaces | Yes, first real assessment | Every Better Auth endpoint, every catalog route, `/v1/auth/token`, and the org-scoped machine credential each get an explicit authentication + authorization row (D2-D5, D11). One key per org, never shared across tenants. |
| SEC03 Access control | Yes, core of this change | Cerbos deny-by-default (D7-D11); a deny is distinct from not-found (spec); server-side only, never trusted from the browser; step-up for `x-tayzu-risk: high` (D4). |
| SEC04 Password storage | Yes | Better Auth default `scrypt`. No second password store exists in this change. |
| SEC05 Crypto | Yes | TLS on the ACA ingress (inbound edge, new); no TLS on the Cerbos sidecar loopback (Q8, explicit exception); session token opaque, not a JWT; access tokens are `jwt`-plugin-signed (asymmetric, short-lived); API-key hash-at-rest algorithm not independently source-verified (r2 O7) — recorded as an open verification item, not a claim. |
| SEC06 Misuse | Yes | Notifications on password/MFA change built on Better Auth hooks (no library default); invitation acceptance/expiry state-machine hardening is `043`'s concern, not 002's (002 has no invitations). |
| SEC07 Dependencies | Yes | Better Auth, Cerbos SDKs, and their transitive deps added to 001's existing Dependabot/`pnpm audit`/quarterly-EOL gate (R7 there). |
| SEC08 File upload | N/A | No upload surface. |
| SEC09/SEC10 Secrets | Yes | Key Vault for DB role passwords, `BETTER_AUTH_SECRET`, `jwt` signing key (D15). Change procedure documented per secret. |
| SEC11 Phishing | Partial | If `requireEmailVerification` is enabled, its link is the only clickable link 002 sends (no invitation email — that's `043`); constrained to a "log in and check" pattern elsewhere. |
| SEC12 Testing | Yes | `cerbos compile`'s test suite as the CI gate for authorization logic, alongside 001's `contract:check`; OWASP ZAP baseline DAST (D16, first real DAST job). |
| SEC13 Deployment | Yes | Cerbos policy bundle ships through the same pinned, SHA-pinned pipeline 001 established; Cerbos image pinned by digest. |
| SEC14 Infra permissions | Yes, this is T3's core | Three roles (D6): `tayzu_migrator` (DDL only), `tayzu_app` (CRUD only, no bypass), `tayzu_auth` (auth schema only, no catalog grants). No account shared between migration and CRUD. |
| SEC15 Network/host | Partial | PaaS-only, no new host surface; Key Vault access via managed identity, not a stored credential. |
| SEC16 Logging | Yes | New `auth.security.*`/`catalog.security.authz_denied` events, same sampling-exemption discipline as 001. |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 002 | Why |
|---|---|---|---|
| Dynamic-permission fail mode | A failing query/JQ condition is silently ignored (fail-open) | A Cerbos evaluation error denies the action (fail-closed, `strictEvaluation: true`) | `project.md`'s non-negotiable fail-closed invariant |
| Cross-tenant vs. in-tenant-denied | Undocumented whether these are distinguished | Explicitly distinct: cross-tenant is `CATALOG_NOT_FOUND`; in-tenant deny is `AUTH_FORBIDDEN` | Cerbos and Postgres RLS are separate, composable layers; conflating them would hide real deny events from SEC16's audit trail |
| Dynamic-permission DSL | Two incompatible DSLs (workflow `policy.rules` vs. action `policy.queries`+`conditions`) | One engine, one DSL (Cerbos CEL), reused by every later change (`006`'s workflow execute permissions included) | Avoids importing Port's own unreconciled duplication |
| Workflow/automation privilege | Runs with organization-level (often elevated) privilege, not the creator's own | Deferred to `006`; not decided here | Named explicitly so `006` makes this call deliberately, not by silent inheritance from Port |
| Machine token lifetime | ~3 hours | 1 hour | Resolved decision Q5; higher-value credential, shorter blast radius, no other secondary signal (unlike human MFA) |

## Risks / Trade-offs

- [Cerbos sidecar failure takes down authorization for that ACA instance] →
  Cerbos's own health/readiness endpoints gate the Fastify instance's own
  readiness probe; a Cerbos-down instance stops receiving traffic rather than
  failing open. `strictEvaluation` already ensures a reachable-but-erroring
  Cerbos denies rather than allows.
- [The redaction batch check (D12) adds one more `CheckResources` call per
  conflict-error path] → Bounded by the same 10-identifier cap 001 already
  applies before redaction runs; not a hot path (only taken on the error
  branch of an already-rare operation).
- [`jwt` plugin adoption in 002, ahead of `026-mcp-server`'s original
  timeline for it] → No new risk: the plugin is additive, and `026` reuses
  the same signing key/`/jwks` endpoint rather than standing up a second one.
- [API-key hash algorithm not independently source-verified (SEC05)] →
  Tracked as a pre-Checkpoint-2 verification task (11.x in `tasks.md`), not
  asserted as a fact until confirmed against the package source.
- [Two Checkpoint-3 migrations plus a Checkpoint-3 policy tree in one change]
  → Each is presented separately in chat, in the order Migration Plan lists,
  so no single approval bundles unrelated risk.

## Migration Plan

1. **Better Auth schema migration**: `npx @better-auth/cli generate` (schema
   definitions) → `drizzle-kit generate` (SQL), landing in
   `packages/db/migrations/000N_auth_schema.sql`, creating the `auth` Postgres
   schema and every Better Auth/plugin table inside it, plus `CREATE ROLE
   tayzu_auth` and its grants (hand-written custom SQL, since Drizzle cannot
   express `GRANT`). ⛔ **Checkpoint 3**: presented and approved separately,
   before continuing.
2. **Catalog roles/RLS migration**: a Drizzle-generated migration adding
   `pgPolicy`/`pgRole` to every catalog table (D6), followed by a hand-written
   custom SQL migration for `GRANT`/`REVOKE`/`FORCE ROW LEVEL SECURITY` and
   `CREATE ROLE tayzu_migrator`/`tayzu_app` where not already provisioned by
   infrastructure. ⛔ **Checkpoint 3**: presented and approved separately,
   after step 1's approval, before continuing.
3. **Cerbos policy tree** (`policies/`): derived roles, role policies,
   resource policies, and their test suites, compiled and tested by `cerbos
   compile` in CI. ⛔ **Checkpoint 3**: every policy file is presented and
   approved separately, distinct from both migrations and from the PR review.
4. Deploy: `apps/api` and the Cerbos sidecar ship together in one ACA
   revision (D7); there is no environment before this one, so this is the
   first real deployment, not a promotion.
5. Rollback: this is still a low-data-volume deployment (`project.md` §6,
   "few known tenants"); rollback is reverting the ACA revision and, if the
   migrations already ran, a generated `down` script for each (kept next to
   the migration, same convention as 001).

## Resolved decisions (asked and approved in chat, 2026-09-28)

Recorded from `scratchpad/p002/decisions.md`, per `project.md` §20 ("every
open question is asked in chat, never only written in a file... nothing
counts as approved until the human answers").

| # | Question | Decision |
|---|---|---|
| Q1 | Scope split between 002 and a second identity/org-admin change | Split as this proposal states. New id `043-identity-lifecycle-and-org-admin` (not a renumbering), executed immediately after 002. |
| Q2 | How Better Auth org roles map to Port's Admin/Moderator/Member | `owner`/`admin` → `admin`; `member` → `member`; Moderator is an additional per-blueprint grant on the `_user` entity's `moderatedBlueprints` list, not a fourth role. Cerbos is the only decision point. |
| Q3 | Is Team a Better Auth concept or a catalog concept | Catalog system blueprint `_team`; ownership uses catalog relations; Better Auth's own `teams` plugin option is disabled. |
| Q4 | User status field | A canonical Port-shaped status field on `_user`, updated by hooks on Better Auth events. 002 defines the field and `Active`/`Disabled` at minimum; the full lifecycle is `043`. |
| Q5 | Machine credential shape | Long-lived client id/secret (revocable, rotatable, hashed) exchanged for a short-lived (1-hour) access token. |
| Q6 | Step-up for high-risk operations | Required: a recent MFA verification (fresh within 5 minutes) or `AUTH_STEP_UP_REQUIRED`. |
| Q7 | Human session policy | 7-day rolling expiry, 12-hour idle timeout, revoke all sessions on password change. |
| Q8 | TLS on the Cerbos sidecar loopback link | Not required inside the same ACA revision; documented exception. TLS mandatory for every other Cerbos link. |
| Q9 | A cluster of implementation-shaping calls | Better Auth tables in their own `auth` schema under `tayzu_auth`, no grants on catalog tables, never inside `withTenantTransaction`; `dynamicAccessControl` off; Cerbos fixed resource kinds with per-blueprint attributes; `strictEvaluation` on; no Cerbos scopes before `042`; Cerbos decision logs on; `@fastify/rate-limit` keyed per principal; HTTP error-status fix via an oRPC interceptor; no "environment" permission dimension yet (`024`); `activeOrganizationId` persisted on the session; `session.cookieCache` off. |

No open questions remain for this change.
