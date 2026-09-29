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
- **Visma Connect SSO moved into 002's scope on 2026-09-28** (`project.md`
  §23, decision D11): the human decided Tayzu's primary human IdP is Visma
  Connect, and that this belongs in the load-bearing auth change rather than
  waiting for `025-sso-and-identity-federation` (which keeps per-organization
  SSO — customer-brought SAML/OIDC, enforcement, SCIM). The reference docs
  Tayzu's implementation is grounded in are saved in
  `docs/references/visma-connect/README.md` (source pages under
  `docs.connect.visma.com`); D23-D26 below cite it. Package facts for this
  addition are verified the same way as the rest of this design (§ above):
  `better-auth@1.7.6`'s installed `generic-oauth` plugin source
  (`node_modules/better-auth/dist/plugins/generic-oauth/types.d.mts`) and
  core account-linking routes (`node_modules/@better-auth/core/dist/.../
  account.d.mts`), not the docs site, since `project.md` §17 flags Better
  Auth for source-verification treatment.

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
- No *per-organization* SSO: no customer-brought SAML/OIDC identity
  provider, no group-sync, no "automatic user access" toggle, no
  per-tenant enforcement of which sign-in methods are allowed, no SCIM.
  All `025-sso-and-identity-federation` (Resolved decision Q21). Visma
  Connect — Tayzu's own, single, primary IdP for every tenant — is in
  scope here (D23-D26); it is not a customer-configurable federation and
  is not the thing `025` adds.
- No login-screen UI presenting the local-vs-Visma-Connect choice to the
  user — 002 ships no UI package (Impact). It exposes both authentication
  routes (`/sign-in/email`, `/sign-in/social?provider=visma-connect`) as
  reachable; `003-catalog-ui-core` builds the screen that offers the
  choice.
- No permission simulator, no "view as", no per-page ACLs, no workflow
  execute-permission model. All `014-governance-and-policy-simulation` /
  `006-workflow-engine-core`.
- No multi-org UX (org switcher, per-org independent sessions). `project.md`
  §23 D7 keeps 002 at "few known tenants, no org switcher"; `042-multi-org`.
- No Cerbos `scope` (scoped policies) for tenant hierarchy — `tenantId` is a
  plain attribute, not a Cerbos scope (Resolved decision, below).
- No impersonation ("view as"). Better Auth's `admin` plugin ships it, but it
  is not in the roadmap's 002 scope and is deferred implicitly to `014`.
- No forgot-password/account-recovery flow. `043` does not naturally absorb
  it either — it owns identity *lifecycle* (invitations, service accounts,
  credential rotation, org deletion), not a second authentication flow.
  Deferred to a new, explicitly named future change,
  `044-password-reset-and-account-recovery` (VCDM pre-assessment, ticket 9).
  Sign-up and sign-in, which do ship in 002, still carry the
  enumeration-resistance requirement below.

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

See [ADR-0013](../../../docs/adr/0013-cerbos-as-sole-authorization-engine.md).

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

`CatalogContext.actor.onBehalfOf` (001 D3) is reused, not redefined, but is
**not reachable over HTTP in 002's scope** (VCDM pre-assessment, ticket 10):
`resolveContext(headers)` never reads an `onBehalfOf` value from a header,
body, path, or query string, and any such client-supplied field is ignored
even if present. There is no in-scope caller (human session or machine token)
that is trusted to attribute an action to a different principal in this
change; a future change that needs it (e.g. `026-mcp-server` proxying on a
user's behalf) must add an authenticated claim for it, never a bare
client-supplied field.

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
| `tayzu_migrator` | catalog + `auth`-schema tables (DDL) | Subject to `FORCE ROW LEVEL SECURITY` like any role, but never used at runtime to issue DML, so RLS applicability is moot in practice (corrected wording, VCDM pre-assessment ticket 13: `FORCE ROW LEVEL SECURITY` applies to the table owner too, unless the owner separately holds `BYPASSRLS`, which `tayzu_migrator` does not) |
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
the calling operation's span (D14). **Decision-log retention and monitoring
(VCDM pre-assessment, ticket 14, explicit rather than folded silently into
"Yes"):** Cerbos decision logs stream to stdout, captured by the ACA log
sink and forwarded to Azure Monitor with the same retention as every other
application log in this environment (no Cerbos-side retention policy of its
own, since `010`/`015` own that platform's retention/export tooling, not this
change); Azure Monitor alerting on the `tayzu.authz.decisions` metric's
`deny` rate is a `010`-owned dashboard concern, named here so it is not
mistaken for something 002 ships. `@cerbos/grpc@0.29.1` is the client (lower
overhead than the HTTP gateway); `@cerbos/orm-drizzle@0.1.0` turns
`PlanResources` results into Drizzle `WHERE` clauses for every list operation
(`entities.list`). No Cerbos `scope` is used (Resolved decision Q9/OQ-1's
sibling question, D-C in `r3-cerbos.md`): `tenantId` is a plain attribute, per
Cerbos's own "dynamic context" pattern for multi-tenancy
(`r3-cerbos.md` §3.1, §11 D-A), which is also the pattern that keeps
`/policies` small enough to hand-review at Checkpoint 3 rather than minting a
resource-kind file per blueprint.

See [ADR-0015](../../../docs/adr/0015-cerbos-dynamic-context-not-scoped-policies.md).

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

Role policies (`r3-cerbos.md` §3.3) are a **ceiling**, not a grant: an action
reaches a principal only if the role policy allows it *and* a resource-policy
rule grants it. In Cerbos, `parentRoles` on a role policy *narrows* the role to
its parent's permissions; it does not inherit them. So `admin.yaml` has no
`parentRoles` and sets `allowActions: ["*"]` on every resource kind. `member.yaml`
allows `view`, `list`, `create`, `update`, and `delete` on `catalog_entity` (the
ceiling includes `delete` so that the Moderator grant and ABAC grants can reach
it), `view` and `list` only on `catalog_blueprint`, and `view` and `list` only
on `user` and `team` (Resolved decision Q24). No resource-policy rule grants
`delete` to a plain member: it is reachable only through
`moderates_blueprint` or an ABAC grant rule (D10).

The default deny is Cerbos's implicit deny plus an explicit cross-tenant deny
rule in every resource policy (`R.attr.tenantId != P.attr.tenantId`). A
wildcard deny rule is not used because it would override `admin`.

A resource policy for `catalog_entity` receives these attributes: `tenantId`,
`blueprintId`, `ownerTeam`, `createdBy`, and `locked`. `ownerTeam` is *absent*
(not null) when the entity has no owner (D9), so conditions test presence
(`has(R.attr.ownerTeam)`) rather than comparing against null. Members may
create and update an entity with no owner team; an entity with an owner team is
updatable only by a member of that team (`owning_team_member`), a moderator of
its blueprint (`moderates_blueprint`), or an admin (Resolved decision Q23).
Moderator is a derived role, `moderates_blueprint`,
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

No new hook into this policy layer is needed for `043`'s service-account
role restriction (Resolved decision Q4, VCDM pre-assessment): D10's
static-policy/dynamic-context (dynamic ABAC) pattern already lets a
resource-policy rule condition on any attribute the service layer passes in,
so `043` adding a rule conditioning on the `_user` entity's `accountKind`
attribute is exactly the pattern D10 already generalizes for, not a new
mechanism this change must build.

See [ADR-0013](../../../docs/adr/0013-cerbos-as-sole-authorization-engine.md)
and [ADR-0015](../../../docs/adr/0015-cerbos-dynamic-context-not-scoped-policies.md).

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
This keeps the promise in the spec's Dynamic ABAC requirement consistent: a
*grant* rule adds an allowance and stays inside the role-policy ceiling (D8), so
it is one more allow rule in the same file, evaluated by the same engine, with
the same default-deny fallback. A *deny* rule is an explicit, documented
exception that removes an allowance, and must name the principals it exempts
(an admin stays exempt). The two worked examples (Resolved decision Q22) are a
grant of `delete` where `resource.createdBy == principal.id`, and a deny of
`update` for non-admin principals where `resource.locked == true`.

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


**Principal and client wiring (resolved decisions Q26/Q27).** `CatalogContext`
gains a host-supplied `principal` (`roles`, `teams`, `moderatedBlueprints`)
that only `resolveContext` fills; every service factory takes the Cerbos
client as its `authz` option; and every catalog operation declares its
`authorization` (kind, action, id, attributes), which the pipeline checks
right after context validation. A missing principal is a deny, never a
default role.

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
- `0021-visma-connect-as-primary-idp.md` (D22-D26) — next free ADR number
  after `043`'s own `0017`-`0020` (checked against both designs and
  `docs/adr/` to avoid a collision, 2026-09-28).

`docs/architecture/system-diagram.md` gains four components: the Fastify
listener (now actually serving traffic, previously a dashed/planned node),
the Cerbos sidecar (an internal component with no external arrow — nothing
outside the trust boundary talks to it directly), Key Vault (an external
actor supplying secrets to the deployment pipeline and the running
container), and **Visma Connect** (a new external actor, outside the trust
boundary, with two arrows: an outbound/inbound pair for the sign-in and
callback round trip initiated by `apps/api`, and a separate *inbound-only*
arrow for the back-channel logout POST that Visma Connect's own
infrastructure initiates against Tayzu). `docs/catalog/auth-and-rbac.md`
documents the resource-kind taxonomy, the role/ownership model, and the
telemetry reference, mirroring 001's `docs/catalog/catalog-core.md`, and now
also documents the two sign-in methods and the account-linking model
(D22-D26).

### D18. Better Auth native route allowlist (Resolved decision Q10)

The `vcdm-ssa-validator` pre-assessment (`ssa-pre-assessment.md`, folded here
2026-09-28) found that mounting Better Auth's entire `/api/auth/*` catch-all
(D13) exposes the `organization` plugin's own native `inviteMember`,
`updateMemberRole`, `removeMember`, `setActiveOrganization`, `create`/`delete`
organization endpoints, and the `apiKey` plugin's own key-management routes —
a second, ungoverned authorization path that contradicts D2's own invariant
("Cerbos is the only place an authorization decision is made"). The human
chose the recommended fix (Q1a): these routes are blocked at the Fastify
routing layer with an **allowlist** of mounted `/api/auth/*` routes, deny by
default. A Fastify `onRoute`/pre-handler check runs before `auth.handler` is
reached: the request's path is matched against a fixed allowlist (sign-up,
sign-in, sign-out, session read, two-factor enroll/verify, email
verification, and any other route this design explicitly names as needed by
002's own scenarios); any `/api/auth/*` path not on the allowlist — including
every organization-member-mutation and apiKey-management route above —
returns `404`, identical to an unknown route, never a `403` (a `403` would
confirm the route exists). Every organization-membership mutation instead
goes through a Cerbos-gated oRPC procedure (`identity.*` in `043`, and any
002-owned equivalent) that calls `auth.api.inviteMember`/`updateMemberRole`/
`removeMember`/`setActiveOrganization`/etc. **in-process**, after its own
Cerbos check — Better Auth's own API surface remains the mechanism, Cerbos
remains the sole decision point in front of it. The allowlist is a single
exported `const` (`packages/auth/src/http/allowed-routes.ts`) so the CI
allowlist test (task 11.9) can enumerate Better Auth's actual mounted routes
against it and fail when a new plugin route appears unlisted, rather than
silently trusting the allowlist to stay current as Better Auth or its
plugins add routes.

- *Alternative considered (Q1 option 2):* a Cerbos pre-handler in front of
  `auth.handler` for these sub-routes, keeping them reachable. Rejected: it
  keeps a second authorization seam alive (one more place `002`'s Cerbos
  wiring must be replicated correctly, for routes 002 doesn't otherwise
  exercise), for no benefit over routing the same mutation through the
  oRPC procedure that already needs a Cerbos check for its own audit
  logging (`043`'s `identity.users.invite`, for instance).
- *Alternative considered (Q1 option 3):* trust Better Auth's own
  owner/admin checks with no additional gate. Rejected: this is the literal
  SEC03 "multiple ways to do access control" anti-pattern D2 already
  disavows, and it left `043`'s carefully audited invite path bypassable by
  the native route (VCDM Summary #1).

### D19. Tenant-switch membership re-verification (Resolved decision Q11)

`tenantId = session.activeOrganizationId` (D3) is the value RLS and Cerbos
both key off — the single most consequential trust root in this design. The
VCDM pre-assessment found no task verifying that Better Auth's
`setActiveOrganization` endpoint (reachable, per D18's allowlist, since
switching one's own active org is a legitimate self-service action, not a
membership mutation) refuses to set an organization the caller is not a
member of. The human chose defense in depth (Q2a): in addition to a test
asserting non-membership is rejected, `resolveContext()`'s session-cookie
branch independently re-verifies that `session.activeOrganizationId` names an
organization the session's user actually has a `member` row for — a direct
lookup against Better Auth's own membership table (`tayzu_auth`-scoped,
outside `withTenantTransaction`, D6), not a re-derivation of Better Auth's
internal check. The lookup result is cached in-process for at most a few
seconds (bounded the same way D21's revocation cache is, so this doesn't
become a second unbounded-cache design) to avoid a membership round trip on
every request; a cache miss or lookup failure **fails closed**, resolving
exactly as `CATALOG_CONTEXT_REQUIRED` — the same response an unauthenticated
or non-member caller already gets, so this adds no new distinguishable
failure mode for an attacker to probe.

- *Alternative considered (Q2 option 2):* add the test only, trust Better
  Auth's own logic with no extra code. Rejected: cheap defense in depth is
  proportionate to this value's blast radius (Summary #2); a defense-in-depth
  check that never fires in the passing case costs nothing at runtime beyond
  the cached lookup.

### D20. Pre-authentication brute-force protection (Resolved decision Q12)

The only rate limiting this design had (D13's `@fastify/rate-limit`, keyed
per already-authenticated principal) cannot apply before a caller is
authenticated — sign-in, two-factor verification, and `/v1/auth/token` all
run with no established actor, the textbook credential-stuffing gap (VCDM
Summary #3). The human chose a second, pre-authentication layer (Q3a):
- Better Auth's own `rateLimit` config is enabled with `storage: "database"`
  (multi-replica safe — an in-memory bucket would not be shared across ACA
  replicas) and `customRules` for `/sign-in/email`, `/two-factor/verify`, and
  any sign-up/verification route, each keyed by **both** the caller's IP and
  a normalized (lowercased, trimmed) email, so neither key alone can be used
  to starve the other tenant's legitimate traffic. Better Auth's own
  `storage: "database"` mode provisions its rate-limit table as part of the
  Better Auth schema generation (task 2.2's existing migration, D2/D6) — it
  is not a second Checkpoint-3 migration, it is one more table inside the
  already-gated `auth` schema, and task 2.2's Checkpoint 3 review covers it.
- `POST /v1/auth/token` (D5, not a Better Auth route, so Better Auth's own
  `rateLimit` config does not cover it) gets its own `@fastify/rate-limit`
  bucket, keyed by IP and by the client id supplied in the request body —
  separate from D13's authenticated-principal bucket, since a token-exchange
  caller has no `tenantId`/`actor` yet to key on.
- Every one of these limiters returns `429` with a `Retry-After` header, and
  a rejected sign-in never distinguishes "wrong password" from "no such
  account" in its response body or timing budget (composes with the
  enumeration-resistance requirement below) — the rate limit itself must not
  become a new account-existence oracle.
- `auth.security.rate_limited` (log event, WARN) and `tayzu.auth.rate_limit.
  events` (counter, `{event}`, attribute `tayzu.auth.rate_limit.scope`
  (`sign_in`\|`two_factor_verify`\|`token_exchange`)) are added to the
  Observability contract below. Neither the caller's IP nor their email
  appears on either signal — the scope enum is the only attribute, matching
  001's existing no-tenant-free-text-in-telemetry invariant.

- *Alternative considered (Q3 option 3):* defer to an infrastructure WAF
  (Azure Front Door). Rejected for Phase 1: no such component is provisioned
  yet, and account-takeover protection on the first internet-facing listener
  shouldn't wait for a later change to add the infrastructure.
- *Alternative considered (Q3 option 4):* accept the residual risk as
  documented. Rejected: this is the textbook credential-stuffing gap the SSA
  specifically flags, and the fix is proportionate (existing Better Auth
  config plus one more `@fastify/rate-limit` bucket), not a large addition.

### D21. Machine credential revocation list (Resolved decision Q13)

The spec's "Revoked credential is rejected" scenario only covers the
token-**exchange** endpoint (`POST /v1/auth/token`); nothing before this
decision guaranteed a token **already issued** before revocation stopped
working within its 1-hour lifetime, since the access token is a stateless
signed JWT (D5) with no server-side lookup on every use (VCDM Summary #4).
The human chose immediate revocation effect (Q5a): a Postgres table,
`machine_credential_revocation` (`credential_id`, `revoked_at`, `tenant_id`),
in the catalog schema (granted to `tayzu_app`, subject to the same
`tenant_isolation` `pgPolicy`/`FORCE ROW LEVEL SECURITY` treatment as every
other catalog table, D6) — this is a **new migration**, separate from D6's
role/RLS migration and from D2's Better Auth schema migration, ⛔
**Checkpoint 3 applies separately**. The machine-token branch of
`resolveContext()` (D5's token-exchange consumer) consults this table on
every machine-token request, through an in-process cache keyed by
`credential_id` with a TTL of **at most 5 seconds** (bounded so the residual
window after an admin revokes a credential is seconds, not the token's full
remaining hour) — a cache miss re-queries Postgres; a lookup **failure**
(the table or the database is unreachable) **fails closed**, rejecting the
token exactly as `CATALOG_CONTEXT_REQUIRED`, never falling back to "assume
not revoked." Revocation itself (D5's existing revoke procedure) writes one
row here in the same operation that disables the underlying `apiKey`
config row, so the two can never disagree about whether a credential is
revoked.

- *Alternative considered:* shorten the access-token lifetime further instead
  of adding a revocation check. Rejected: this only shrinks the window, it
  doesn't close it, and Q5a's own wording ("revoked machine credentials take
  effect immediately") asks for immediate effect, not a shorter delay.
- *Alternative considered:* a distributed cache (Redis) instead of an
  in-process TTL cache. Rejected for Phase 1: no such component exists in
  the stack yet (`project.md` §2), and a 5-second in-process TTL bounds the
  cross-replica staleness window to the same 5 seconds a shared cache would,
  at the cost of one extra Postgres read per cache miss per replica, which
  is proportionate to "few known tenants."

### D22. Public self sign-up is disabled; users are created only by an admin or a bootstrap script (Resolved decision Q16)

The human decided (2026-09-28) that public self sign-up is disabled under
every circumstance, closing an account-creation surface the original design
left open by default. Mechanism:
- `emailAndPassword.disableSignUp: true` on the Better Auth instance (D2) —
  confirmed against the installed `@better-auth/core@1.7.6` option type
  (`BetterAuthOptions.emailAndPassword.disableSignUp`), not the docs site.
- Better Auth's sign-up route (`/sign-up/email`) is **not** added to D18's
  allowlist: it is unreachable over HTTP, returning `404` like any other
  non-allowlisted route, not a `403` (same reasoning D18 already gives —
  a `403` would confirm the route exists).
- `POST /admin/create-user` (Better Auth's `admin` plugin, `auth.api.
  createUser`) is *also* not added to the allowlist as a directly-reachable
  route — creating this native route alongside D18's SEC03 invariant would
  be the same ungoverned-second-path mistake D18 already forecloses for
  `inviteMember`/`apiKey` management. Instead, a new Cerbos-gated oRPC
  procedure, `identity.users.create` (`admin` role required by
  `user.yaml`'s resource policy, D8), calls `auth.api.createUser` **in
  -process**, matching D18's established pattern exactly. It sets a
  system-generated temporary password, returned once in the creation
  response and never emailed (002 ships no email sender — D5, `043`'s
  scope) — the same "shown once" discipline D5's machine-credential secret
  already uses, applied here because there is no invitation flow yet to
  carry a credential to the new user any other way.
- A first-admin bootstrap script (`packages/auth/scripts/bootstrap-admin.ts`,
  run out-of-band by an operator, never HTTP-reachable) creates the first
  organization and its first `admin`-role user for a new tenant, calling the
  same `auth.api.createUser` path as `identity.users.create` rather than a
  third code path — idempotent (re-running it for an already-bootstrapped
  tenant is a no-op, not a duplicate).
- Both paths still upsert the matching `_user` entity through the `system`
  actor (spec "User and Team system blueprints"), now triggered by
  `identity.users.create`/the bootstrap script instead of a sign-up hook —
  the hook trigger point in task group 12 moves, the mechanism (system-actor
  upsert) does not.

This closes the account-enumeration surface the spec's "Authentication
responses resist account enumeration" requirement covered for sign-up: with
no sign-up, there is nothing left to enumerate through it, so that
requirement is narrowed to sign-in only (spec updated below).

- *Alternative considered:* keep sign-up reachable but gated by an
  organization invite token (a lightweight invitation, ahead of `043`).
  Rejected: `043` already owns the full invitation lifecycle design
  (Better Auth's `organization` plugin invitation record, expiry,
  re-invite-cancellation, SEC11-hardened email) and doing a partial version
  here would create exactly the kind of drift `043`'s own design guards
  against (its Context, "Drift between this design and `002`'s
  implementation").

### D23. Visma Connect SSO via Better Auth's `genericOAuth` plugin (Resolved decision Q17)

Visma Connect (OIDC) is added as a second, non-exclusive sign-in method:
local email+password (D2, still available) and Visma Connect SSO, chosen by
the user on whatever login screen `003` builds (Non-Goals). No new dependency
is added — `genericOAuth` is bundled in `better-auth@1.7.6` (confirmed
against the installed package: `node_modules/better-auth/dist/plugins/
generic-oauth/index.d.mts` exports `genericOAuth` directly from the package
already in `project.md` §2/002's own dependency list).

Configuration (`packages/auth/src/sso/visma-connect.ts`), grounded in
`docs/references/visma-connect/README.md` (server-side-web-applications,
id-token, security-considerations, usage-of-state-for-redirects):

| Option | Value | Why |
|---|---|---|
| `providerId` | `"visma-connect"` | Fixed identifier used everywhere this design references the provider (allowlist, telemetry enum, account-table `providerId` column). |
| `discoveryUrl` | `https://connect.visma.com/.well-known/openid-configuration` | Authorization/token/userinfo/JWKS endpoints and the issuer are read from discovery, never hand-entered — reduces drift if Visma rotates endpoints. |
| `requireIdTokenVerification` | `true` | Forces discovery to supply the issuer and JWKS before this provider registers, so ID-token signature verification (needed for D25's step-up claim checks) can never silently downgrade to unverified decoding. |
| `pkce` | `true` (default) | Authorization code + PKCE S256, matching `server-side-web-applications.md` Step 1 and OAuth 2.1. |
| `responseMode` | `"form_post"` | The Visma-recommended default (`server-side-web-applications.md`), avoids leaking `code`/`state` in browser history/referrer headers via a query string. |
| `scopes` | `["openid", "email", "profile"]` | The minimum Identity Scopes needed for D24's JIT display-data refresh; no `offline_access` (no refresh token — a Visma Connect session, not a long-lived grant, is what this design wants, consistent with D5's own "no refresh token" choice for machine tokens). |
| `clientId` / `clientSecret` | Environment / Key Vault (D15) | Same secret-handling discipline as every other 002 secret; never `.env` in a deployed environment. |
| `disableImplicitSignUp` | `true` | A sign-in for a `sub` with no existing linked account does not create one. |
| `disableSignUp` | `true` | Belt-and-suspenders with the line above — SSO never creates a Tayzu user, full stop, matching D22's "users are created only by an admin or bootstrap" invariant. Confirmed present on `GenericOAuthConfig` in the installed package (`types.d.mts`), not assumed from docs. |
| `overrideUserInfo` | `false` (default, left off) | Explicit non-default choice — see D24: this option would let Better Auth overwrite the **core** `user.email` field automatically, which is exactly what D24 forbids (email is display data, never an identity key). JIT refresh is implemented as an explicit hook instead (D24), not this flag. |
| state, nonce | Better Auth's own defaults | `genericOAuth` already generates and validates `state` (CSRF, `usage-of-state-for-redirects.md`) and `nonce` (replay, `id-token.md`) for a discovery-configured, JWKS-publishing provider; `disableIdTokenNonceBinding` is left `false` (its default) so nonce binding stays on — Visma Connect does return the `nonce` claim, so there is no reason to weaken it. |

Account identity (`accountSubject`): left at Better Auth's default, which —
for a discovery-configured provider — is the verified ID token's `sub`
claim, not `id`, per the installed type's own doc comment ("OpenID Connect
discovery providers use the verified profile's `sub` field by default").
This is exactly the immutable UserID `userid-and-email-for-a-connect-
account.md` requires linking on; no custom `accountSubject` resolver is
written, because Better Auth's default already does the right thing and a
custom resolver is one more place D24's "never key on email" invariant
could be gotten wrong.

Routes this adds to D18's allowlist (all are Better Auth **core** routes,
not `organization`/`apiKey` plugin routes, so they are outside D18's
original deny list, but still need an explicit allow entry under its
deny-by-default policy): `/sign-in/social` (initiates the flow for
`provider: "visma-connect"`), `/callback/visma-connect` (the OAuth
callback), `/link-social` and `/unlink-account` (D24's path (a)), and
`/list-accounts` (lets a signed-in user see which methods are linked to
their own account — read-only, self-scoped, no membership/credential
mutation). None of these are organization-membership or apiKey-management
routes, so they do not reopen the SEC03 gap D18 closed.

- *Alternative considered:* a dedicated `@better-auth/sso` or
  hand-rolled OIDC client instead of `genericOAuth`. Rejected: the human's
  decision names `genericOAuth` explicitly (no new dependency), and it is
  already the bundled, source-verified mechanism for exactly this shape of
  provider (discovery-based OIDC, authorization code + PKCE).

### D24. Account linking is explicit, sub-keyed, never email-keyed (Resolved decision Q18)

Per `userid-and-email-for-a-connect-account.md`'s own warning ("Email should
never be used for matching... may lead to unauthorized access to the wrong
account"), linking a Tayzu user to a Visma Connect account is **always**
keyed on the immutable `sub` claim (D23's `accountSubject`), through exactly
two explicit paths — never implicit, never by matching email:

**(a) Self-service linking from an authenticated local session.** A user
already signed in locally calls Better Auth's own `/link-social` endpoint
(`linkSocialAccount`, `requireHeaders: true` — confirmed in the installed
`@better-auth/core` types, `api/routes/account.d.mts`) with `provider:
"visma-connect"`; the resulting OAuth round trip creates an `account` row
(`providerId: "visma-connect"`, `accountId: sub`) linked to the *caller's
own* `userId` — Better Auth's own table, no new migration. **Step-up is
required for this operation when the caller has an enrolled MFA factor**:
`/link-social` is a Better Auth native route, not an oRPC procedure, so
D4's `route.spec`-based guard (which only wraps catalog/authz procedures)
does not reach it. A Fastify pre-handler specific to this one route —
structurally the same kind of pre-handler D18 already adds for the
allowlist — reuses D4's existing `twoFactorVerifiedAt` freshness check (not
a second implementation of step-up) and rejects with `AUTH_STEP_UP_REQUIRED`
when the caller has 2FA enrolled but no fresh verification, before letting
the request reach `auth.handler`.

**(b) Admin-recorded linking.** An org admin records a user's Visma Connect
UserID on the Tayzu user directly, via a new Cerbos-gated oRPC procedure,
`identity.users.linkSsoAccount` (`admin` role, `user.yaml` resource policy,
audited — D8/D10's existing pattern, no new Cerbos mechanism). This writes
the same `account` row shape as path (a) but for a *target* user chosen by
the admin, using the auth package's internal adapter directly (Better
Auth's own `/link-social` is scoped to "link my own currently-authenticated
account," per its `requireHeaders` session dependency — it has no
admin-links-someone-else's-account mode) — never Better Auth's public API
surface for this specific write, same reasoning as D18's "native route
blocked, in-process call instead."

**Rejection.** A Visma Connect sign-in whose `sub` has no linked Tayzu
`account` row — because `disableImplicitSignUp`/`disableSignUp` (D23) both
refuse to create one — fails. The callback handler maps **every** failure
mode of this flow (unlinked `sub`, `state` mismatch, invalid/unverifiable
`id_token`) to the **same** generic rejection: `AUTH_SSO_REJECTED` (spec
Conventions), identical status and body regardless of cause. This is
enforced in code, not left to Better Auth's own per-failure error shape,
because those *do* differ internally (that distinction is exactly what the
telemetry-only `sso_unlinked`/`sso_state_mismatch`/`sso_token_invalid`
failure-reason enum is for — recorded on the log event, never in the HTTP
response).

**JIT refresh (display data only, never identity).** On every successful
Visma Connect sign-in, the callback handler calls `/connect/userinfo`
(`userinfo-endpoint.md`) with the fresh access token and writes the
returned `name`/`email` into the linked user's **display-only** fields: the
`_user` catalog entity's `title` (name) and a `contactEmail` property —
**never** Better Auth's core `user.email` column, and never the value used
to resolve which account signed in (that stays `sub`, D23). `overrideUserInfo`
is deliberately left `false` (D23) because it would let Better Auth
overwrite `user.email` directly, which is also the local email+password
sign-in identifier — if Visma's current email for this `sub` were
reassigned to a different person in the future (the exact scenario
`userid-and-email-for-a-connect-account.md` warns about) or happened to
already belong to a different Tayzu user, an automatic overwrite could
silently change or collide with a local sign-in identity. Writing the
refreshed name/email only to display-only fields, through the `system`
actor path (same discipline as D22/the `_user` sync hooks), avoids that
class of bug entirely.

**Unlinking and the last-method invariant.** An admin can call
`identity.users.unlinkSsoAccount` (same Cerbos gating as (b)), or a user
can call Better Auth's own `/unlink-account` (D23's allowlist addition,
self-scoped, no step-up needed — removing a *second* factor is lower risk
than adding one). Either path is refused with a new validation error if it
would leave the user with zero sign-in methods (no password set **and** no
linked SSO account) — a user must always keep at least one way to sign in.

- *Alternative considered (Q2 option, email-assisted linking as a
  convenience):* offer to pre-fill or suggest a link based on matching
  email on first SSO sign-in. Rejected outright — this is the literal
  anti-pattern Visma's own docs warn against, and the human's decision is
  explicit that email matching is forbidden, not merely discouraged.

### D25. Step-up for a Visma-Connect-established session delegates to Visma Connect (Resolved decision Q19)

D4's step-up guard (`twoFactorVerifiedAt` freshness, local TOTP) assumes
every session was established locally. That is no longer true once D23
ships. The guard now branches on **how the current session was
established**, using a new nullable column, `ssoSid`, added to Better
Auth's `session` table via `session.additionalFields` (Better Auth's own
extension mechanism — not a hand-rolled column): populated with the Visma
Connect `sid` claim (`id-token.md`) whenever a session is created or
refreshed through the Visma Connect sign-in flow (D23), left `null` for a
session established by local email+password (D2). `ssoSid IS NOT NULL` is
therefore both "this session came from Visma Connect" (consumed here) and
the join key D26's back-channel logout needs (consumed there) — one column,
two consumers, not two mechanisms. This is a schema change to an
already-migrated table (task 2.2's migration already ran), so it lands as
its own migration. ⛔ **Checkpoint 3 applies.**

For a session with `ssoSid` set, the step-up guard (D4's same wrapper,
extended, not replaced) does not check `twoFactorVerifiedAt` at all —
instead it initiates a fresh Visma Connect re-authorization:
`&max_age=300&prompt=login&acr_values=urn:idp:vismaconnect:mfa`
(`re-authentication-and-step-up-authentication.md`'s own step-up example,
`max_age` fixed at 300 seconds — the same 5-minute freshness threshold the
spec's Conventions already state for local step-up, kept identical across
both session kinds so the spec's single "fresh within 5 minutes" line stays
true regardless of method). Because, per Visma's own explicit warning,
"the Step-Up mechanism can be subverted by the end-user simply stripping
the parameters as it passes through the web browser," the guard never
trusts that the redirect happened — it validates the **returned ID
token's** `auth_time`, `acr`, and `amr` claims after the round trip:
- `auth_time` within the last 300 seconds (server-computed skew tolerance:
  ±30 seconds, matching D26's back-channel-logout skew for consistency).
- `acr >= 3` (Level of Assurance 3, `id-token.md`'s ACR table — "LoA-2 + One
  time token... or Security key").
- `amr` contains at least one of the accepted MFA methods
  (`id-token.md`'s own list): `otp`, `push`, `pop`, `hwk`, `face_fpt`, `sms`,
  `mfa`, `pwdless`, plus the electronic-ID methods (`nbid`, `nbid-biometric`,
  `sbid`, `sbid-mobile`, `mitid`, `mitid-erhverv`, `mitid:*`, `fbid`,
  `fbid:method:*`) — any of these independently satisfies "a fresh MFA
  verification," since each is at least LoA3 in Visma's own ACR table.

A claim set that fails any of these checks is treated identically to "no
fresh step-up": `AUTH_STEP_UP_REQUIRED`, recording `step_up_insufficient`
as the failure reason (telemetry contract, below) — the request is never
retried automatically, matching the general "the guard rejects, the caller
decides whether to retry" shape D4 already established. Local sessions
(`ssoSid` null) keep D4's existing `twoFactorVerifiedAt` check unchanged.

- *Alternative considered:* require a local TOTP enrollment on every
  Tayzu user regardless of sign-in method, so step-up is always local.
  Rejected: this defeats the purpose of SSO (a Visma-Connect-only user
  would need to additionally enroll a Tayzu-local factor solely for
  step-up), and Visma Connect's own MFA is already a stronger,
  independently-audited control than anything 002 would build locally.

### D26. Back-channel logout (Resolved decision Q20)

A public endpoint, `POST /v1/auth/visma-connect/backchannel-logout`
(outside `/api/auth/*`, so D18's allowlist is not the gating mechanism here
— this route is public by design, per the OIDC Back-Channel Logout spec,
and D18's allowlist is unrelated to it), receives Visma Connect's
`logout_token` (`single-sign-out.md`: `POST`, `x-www-form-urlencoded`, one
field, `logout_token`). Validation, in order, fails closed at the first
failing step (never partially processes a token that fails a later check):

1. **Signature**: verified against the key named by the token's `kid`,
   fetched from the discovery document's JWKS (same discovery Better Auth
   already resolved for D23 — the JWKS is not fetched a second time from a
   hand-entered URL).
2. **`typ` header** must be `logout+jwt` (`single-sign-out.md`).
3. **`iss`** must equal the discovered issuer; **`aud`** must equal this
   application's Visma Connect client id.
4. **`iat`/`exp`** checked with a small clock-skew allowance (±30 seconds,
   matching D25); a token whose `exp` has passed is rejected — Visma's own
   tokens are issued to expire 300 seconds after `iat`
   (`single-sign-out.md`'s own example payload).
5. **`events`** must contain the
   `http://schemas.openid.net/event/backchannel-logout` member (declares
   this is genuinely a logout token, not a repurposed ID token).
6. **No `nonce` claim** is present (a logout token that carries one is
   rejected — `nonce` belongs to an authentication response, never a
   logout token, per the OIDC Back-Channel Logout spec this design follows).
7. **`jti` replay check**: the token's `jti` must not have been seen before.

**Where `jti` replay state lives.** Reusing an existing table, not adding
one: Better Auth's own `verification` table (`identifier`, `value`,
`expiresAt` — already created by task 2.2's migration, generic-purpose,
used internally for things like email-verification tokens) stores one row
per accepted `logout_token`: `identifier = "backchannel-logout:{aud}:
{jti}"`, `expiresAt = logout_token.exp + skew`. A lookup hit means "already
processed," rejected as replay; a miss means "first time," processed and
then recorded. **No new table** — the instruction to prefer reuse is
satisfied structurally, not just in spirit: this is the same table, same
schema, same Postgres role grants (`tayzu_auth`, D6) already approved at
Checkpoint 3 for task 2.2, so this piece of D26 needs no separate
Checkpoint-3 migration.

**Session matching and revocation**: matched primarily by `sid` — every
session whose `ssoSid` column (D25) equals the token's `sid` claim is
revoked. When the token carries `sub` but no `sid` (the spec's "and/or"),
every session belonging to the Tayzu user linked (D24) to that `sub` with a
non-null `ssoSid` is revoked — local (non-SSO) sessions for that same user
are **not** revoked by a Visma Connect logout event, since D23's whole
premise is that the two methods coexist independently. Revocation writes
`auth.security.session_revoked` (existing log event, D3/3.3's precedent)
with `tayzu.auth.revocation.reason: "backchannel_logout"` (new enum value,
telemetry contract below).

**Rate limiting and information exposure**: `@fastify/rate-limit` on this
route, keyed by source IP only (there is no caller identity to key on — the
caller is Visma Connect's own infrastructure, not a Tayzu principal),
generous enough not to drop legitimate high-volume logout events but
present as a floor against abuse. The endpoint's response **never reveals
anything**: `200` for "processed" (accepted, replay, and "no matching
session" all return the same `200`, distinguishable only internally via
`tayzu.auth.backchannel_logout.events`) and a generic `4xx` only for a
structurally malformed request body (missing `logout_token` field
entirely) — never a status that would let a third party probe which `sid`/
`sub` values correspond to real sessions.

- *Alternative considered:* Front-Channel Logout (`single-sign-out.md`'s
  iframe-based alternative) instead of, or alongside, Back-Channel. Rejected
  for Phase 1: Visma's own docs state "Implementation of Back-channel logout
  is recommended," and 002 ships no UI (Non-Goals) for a front-channel
  iframe to live in — `003` can add it later if a specific UX need arises,
  without changing this endpoint.
- *Alternative considered:* a new dedicated `backchannel_logout_jti` table
  instead of reusing `verification`. Rejected: reuse satisfies the same
  requirement (unique lookup, TTL-bounded, tenant-independent — replay
  state is not tenant data, it belongs to the IdP relationship) with zero
  new schema surface and zero new Checkpoint-3 approval for this specific
  piece.

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
| `auth.session.step_up_check` | any `x-tayzu-risk: high` operation invoked by a `user` actor | `tayzu.auth.method` (`local`\|`visma_connect`) | `tayzu.auth.step_up.fresh` (bool) |
| `auth.sso.callback` | every Visma Connect `/callback/visma-connect` request | `tayzu.auth.method` (`visma_connect`) | `tayzu.auth.sso.outcome` (`success`\|`rejected`) |
| `auth.backchannel_logout.received` | every `POST /v1/auth/visma-connect/backchannel-logout` request | — | `tayzu.auth.backchannel_logout.outcome` (`revoked`\|`replay`\|`invalid`\|`no_match`) |

### Metrics

| Instrument | Type, unit | Attributes | Purpose |
|---|---|---|---|
| `tayzu.authz.decisions` | Counter, `{decision}` | `tayzu.tenant.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action`, `tayzu.authz.decision` (`allow`\|`deny`) | Authorization volume and deny rate |
| `tayzu.authz.check.duration` | Histogram, `s` | `tayzu.authz.resource.kind` | Cerbos call latency |
| `tayzu.auth.session.events` | Counter, `{event}` | `tayzu.auth.event` (`login_succeeded`\|`login_failed`\|`logout`\|`session_revoked`) | Authentication security signal |
| `tayzu.auth.mfa.events` | Counter, `{event}` | `tayzu.auth.event` (`challenge_issued`\|`verified`\|`failed`) | MFA usage and failure signal |
| `tayzu.auth.step_up.required` | Counter, `{event}` | `tayzu.catalog.operation` | Step-up friction signal |
| `tayzu.auth.token.exchanges` | Counter, `{exchange}` | `tayzu.auth.credential.kind`, `tayzu.auth.exchange.outcome` (`success`\|`invalid_credentials`) | Machine-credential usage and abuse signal |
| `tayzu.auth.rate_limit.events` | Counter, `{event}` | `tayzu.auth.rate_limit.scope` (`sign_in`\|`two_factor_verify`\|`token_exchange`) | Pre-authentication brute-force signal (design D20) |
| `tayzu.auth.token.revocation_checks` | Counter, `{check}` | `tayzu.auth.credential.kind`, `tayzu.auth.revocation.result` (`allowed`\|`rejected`\|`lookup_failed`) | Revocation-check volume and fail-closed signal (design D21) |
| `tayzu.auth.sso.events` | Counter, `{event}` | `tayzu.auth.event` (`sso_initiated`\|`sso_succeeded`\|`sso_rejected`) | Visma Connect sign-in volume and rejection signal (design D23/D24) |
| `tayzu.auth.account_link.events` | Counter, `{event}` | `tayzu.auth.event` (`linked`\|`unlinked`), `tayzu.auth.link.actor` (`self`\|`admin`) | Account-linking audit signal (design D24) |
| `tayzu.auth.backchannel_logout.events` | Counter, `{event}` | `tayzu.auth.backchannel_logout.outcome` (`revoked`\|`replay`\|`invalid`\|`no_match`) | Back-channel logout volume, replay-rejection, and fail-closed signal (design D26) |

- **Cardinality budget**: `tayzu.auth.credential.kind` and
  `tayzu.authz.resource.kind` are closed enums (at most 4 values). Actor IDs,
  credential IDs, and entity identifiers are never metric attributes, per
  001's existing cardinality guard, which this change extends rather than
  relaxes. `tayzu.auth.rate_limit.scope` is a closed enum; the rate-limited
  caller's IP address and email are never metric attributes.
  `tayzu.auth.method`, `tayzu.auth.link.actor`, and
  `tayzu.auth.backchannel_logout.outcome` are likewise closed enums (at most
  2-4 values each); the Visma Connect `sub`, `sid`, and the caller's IP
  address are never metric attributes on any signal this section adds.

### Log events (OTel Logs API)

| Event name | Severity | Attributes | Purpose |
|---|---|---|---|
| `auth.security.login_succeeded` | INFO | `tayzu.actor.id`; `tayzu.tenant.id` when the new session has an active organization (D3) | Auth audit trail |
| `auth.security.login_failed` | WARN | `tayzu.auth.failure_reason` (`bad_credentials`\|`mfa_failed`\|`account_disabled`) | Brute-force / misuse signal |
| `auth.security.session_revoked` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.revocation.reason` (`password_change`\|`admin_action`) | Auth audit trail |
| `catalog.security.authz_denied` | WARN | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.authz.resource.kind`, `tayzu.authz.action` | Distinguishes a Cerbos deny from a validation error or a not-found (SEC16) |
| `auth.security.step_up_required` | WARN | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.catalog.operation` | High-risk-operation friction and misuse signal |
| `auth.security.token_exchange_failed` | WARN | `tayzu.auth.credential.kind` | Machine-credential abuse signal |
| `auth.security.rate_limited` | WARN | `tayzu.auth.rate_limit.scope` (`sign_in`\|`two_factor_verify`\|`token_exchange`) | Pre-authentication brute-force signal (design D20); no IP or email attribute |
| `auth.security.revoked_token_rejected` | WARN | `tayzu.tenant.id`, `tayzu.auth.credential.kind` | Confirms revocation takes effect against an already-issued token (design D21, SEC03) |
| `auth.security.sso_sign_in_failed` | WARN | `tayzu.auth.failure_reason` (`sso_unlinked`\|`sso_state_mismatch`\|`sso_token_invalid`) | Distinguishes *why* a Visma Connect sign-in was rejected, internally only — the caller always receives the same `AUTH_SSO_REJECTED` (design D24, SEC06) |
| `auth.security.account_linked` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor` (`self`\|`admin`) | Account-linking audit trail (design D24) |
| `auth.security.account_unlinked` | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor` (`self`\|`admin`) | Account-linking audit trail (design D24) |
| `auth.security.step_up_insufficient` | WARN | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.method` (`local`\|`visma_connect`) | A Visma Connect re-authorization returned, but `auth_time`/`acr`/`amr` did not satisfy the freshness threshold (design D25) |
| `auth.security.backchannel_logout_received` | INFO | `tayzu.auth.backchannel_logout.outcome` (`revoked`\|`replay`\|`invalid`\|`no_match`) | Back-channel logout audit trail; no `sub`, `sid`, or session id attribute (design D26) |

- **Sampling exemption**: every event above, plus 001's own
  `catalog.security.*` events, MUST be exempt from sampling and from filter
  or drop rules in any downstream pipeline (extends 001 D13's exemption list,
  same rule, same rationale — `010` inherits it as a Collector-configuration
  constraint).
- **Forbidden on any signal**: the same list 001 already bans (property
  values, titles, descriptions, validation messages, SQL bind values), plus:
  client secrets, access tokens, session tokens, TOTP codes, and backup
  codes, in raw or hashed form; and, per D20, the rate-limited caller's IP
  address and submitted email, in raw, hashed, or partial form. Per D23-D26:
  the Visma Connect `sub`, `sid`, `id_token`/`access_token`/`logout_token`
  (raw or decoded), and the caller's email or IP address on the SSO/
  back-channel-logout signals above, in raw, hashed, or partial form.

## Security considerations (SSA pre-assessment)

Pre-assessed by the `vcdm-ssa-validator` agent before Checkpoint 1, building
directly on the analysis already done in `scratchpad/p002/r5-carryover-
security.md` §5 (which itself extended 001's own per-section table), and then
by a second, adversarial Mode A pre-assessment run jointly against this
change and `043` (`ssa-pre-assessment.md`, committed alongside this design),
which found five blocking gaps at the seam between the two changes. Every
blocking gap and every non-blocking ticket from that report is folded into
this design (D18-D21, the Non-Goals password-reset deferral, the SEC05/SEC06
items below) and recorded in that report's own "Resolution" section. Per
-section posture:

| Section | Applies | Posture after this design |
|---|---|---|
| SEC01 Diagram | Yes | Fastify listener (now live), Cerbos sidecar, Key Vault added (D17). |
| SEC02 Attack surfaces | Yes, first real assessment | Every Better Auth endpoint, every catalog route, `/v1/auth/token`, the org-scoped machine credential, the Visma Connect sign-in/callback/link/unlink routes, and the public back-channel logout endpoint each get an explicit authentication + authorization row (D2-D5, D11, D23-D26), committed as `docs/security/attack-surfaces.md` (task 16.4). Better Auth's native organization/API-key management routes are blocked by allowlist, deny by default (D18); the Better Auth sign-up route is not allowlisted at all (D22) — no second, ungoverned authorization path, and no public account-creation surface. One key per org, never shared across tenants. Visma Connect is a new external actor in the attack surface: an inbound arrow (the sign-in/callback round trip) and an *unauthenticated inbound* arrow (back-channel logout, D26) that this design treats as hostile-until-validated by construction (signature, issuer, audience, replay). |
| SEC03 Access control | Yes, core of this change | Cerbos deny-by-default (D7-D11); a deny is distinct from not-found (spec); server-side only, never trusted from the browser; step-up for `x-tayzu-risk: high` (D4), extended to delegate to Visma Connect re-authorization for a session it established, with server-side `auth_time`/`acr`/`amr` validation because the client-supplied step-up parameters can be stripped (D25); tenant-switch membership independently re-verified (D19); pre-authentication brute-force protection on sign-in/two-factor/token-exchange (D20); a revoked machine credential's already-issued tokens stop working within a 5-second TTL, fail-closed (D21); account linking is explicit and `sub`-keyed only, never implicit and never email-keyed, with step-up required to add a link when the caller has MFA (D24); public self sign-up is disabled under every circumstance — users are created only by a Cerbos-gated admin procedure or an out-of-band bootstrap script (D22). |
| SEC04 Password storage | Yes | Better Auth default `scrypt`. No second password store exists in this change. Admin-created and bootstrap-created users (D22) get a system-generated temporary password through the same store, shown once, never emailed. |
| SEC05 Crypto | Yes | TLS on the ACA ingress (inbound edge, new; HSTS and disabled TLS 1.0/1.1 verified by task 11.12); no TLS on the Cerbos sidecar loopback (Q8, explicit exception); session token opaque, not a JWT; access tokens are `jwt`-plugin-signed (asymmetric, short-lived); API-key hash-at-rest algorithm independently source-verified against `@better-auth/api-key`'s installed source (task 11.11, closing the open item r2 O7 flagged). Visma Connect's ID token and the back-channel `logout_token` are both verified against the provider's own discovered JWKS (RS256, asymmetric) — Tayzu never accepts an unverified or `alg: none` token from Visma Connect (D23, D26). |
| SEC06 Misuse | Yes | Notifications on password/MFA change built on Better Auth hooks (no library default); invitation acceptance/expiry state-machine hardening is `043`'s concern, not 002's (002 has no invitations); sign-up/sign-in responses resist account enumeration for the sign-in surface that remains once sign-up is disabled (D22), and forgot-password/reset is explicitly out of scope, deferred to `044-password-reset-and-account-recovery` (spec "Authentication responses resist account enumeration"). A Visma Connect sign-in for an unlinked `sub` is rejected with one generic response regardless of cause — no account-existence or email oracle through the SSO path either (D24). The back-channel logout endpoint never distinguishes "revoked a real session" from "no matching session" in its response (D26). |
| SEC07 Dependencies | Yes | Better Auth, Cerbos SDKs, and their transitive deps added to 001's existing Dependabot/`pnpm audit`/quarterly-EOL gate (R7 there). |
| SEC08 File upload | N/A | No upload surface. |
| SEC09/SEC10 Secrets | Yes | Key Vault for DB role passwords, `BETTER_AUTH_SECRET`, `jwt` signing key (D15), and now the Visma Connect `clientSecret` (D23) — same environment/Key-Vault-reference discipline, never `.env` in a deployed environment. Change procedure documented per secret. |
| SEC11 Phishing | Partial | If `requireEmailVerification` is enabled, its link is the only clickable link 002 sends (no invitation email — that's `043`); constrained to a "log in and check" pattern elsewhere. |
| SEC12 Testing | Yes | `cerbos compile`'s test suite as the CI gate for authorization logic, alongside 001's `contract:check`; OWASP ZAP baseline DAST (D16, first real DAST job). |
| SEC13 Deployment | Yes | Cerbos policy bundle ships through the same pinned, SHA-pinned pipeline 001 established; Cerbos image pinned by digest. |
| SEC14 Infra permissions | Yes, this is T3's core | Three roles (D6): `tayzu_migrator` (DDL only), `tayzu_app` (CRUD only, no bypass), `tayzu_auth` (auth schema only, no catalog grants). No account shared between migration and CRUD. |
| SEC15 Network/host | Partial | PaaS-only, no new host surface; Key Vault access via managed identity, not a stored credential. |
| SEC16 Logging | Yes | New `auth.security.*`/`catalog.security.authz_denied` events, same sampling-exemption discipline as 001; Cerbos decision-log retention and Azure Monitor post-launch monitoring stated explicitly, not folded silently into "Yes" (D7). SSO/back-channel-logout events (D23-D26) carry the same discipline: internal failure-reason enums for triage, no `sub`/`sid`/token/email/IP on any exported signal. |

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
  Tracked as a pre-Checkpoint-2 verification task (task 11.11 in
  `tasks.md`), not asserted as a fact until confirmed against the package
  source.
- [Three Checkpoint-3 migrations plus a Checkpoint-3 policy tree in one
  change] → Each is presented separately in chat, in the order Migration Plan
  lists, so no single approval bundles unrelated risk.
- [The 5-second revocation-check cache (D21) means a revoked machine
  credential's token can still succeed for up to 5 seconds after revocation]
  → Accepted explicitly: Q5a asks for "immediate" in the sense of bounded
  seconds, not zero latency; a lookup failure fails closed rather than
  extending this window silently.
- [The independent membership re-check (D19) adds one cached lookup to every
  session-cookie-resolved request] → Bounded the same way (a few seconds'
  cache), so the added latency and Postgres load are proportional to "few
  known tenants," not a per-request round trip in the common case.
- [Visma Connect's `logout_token` can be delivered out of order, delayed, or
  duplicated by the network, and the receiving instance may not hold the
  session it names] → Every outcome (`revoked`, `replay`, `invalid`,
  `no_match`) returns the same `200`, so retries and duplicates are
  harmless and never distinguishable to the caller; the `jti` replay check
  (D26) makes duplicate delivery idempotent by construction.
- [The `ssoSid` column (D25/D26) is sticky for a session's whole lifetime,
  so a session that started via Visma Connect and later somehow persisted
  past a `sub`'s account being unlinked (D24) would still resolve
  `tayzu.auth.method: visma_connect` for step-up purposes] → Unlinking
  (D24) revokes no existing sessions by itself (only back-channel logout
  and the existing session-policy triggers do), but this is bounded by the
  same 7-day/12-hour session policy (D3) every other session already has;
  accepted as proportionate rather than adding a third revocation trigger
  for an edge case with a short natural expiry.
- [The Visma Connect discovery document, JWKS, and userinfo endpoint are
  external dependencies on Visma Connect's own uptime] → A discovery/JWKS
  fetch failure at provider-registration time fails Tayzu's own
  `apps/api` readiness probe (same "fail closed, don't silently start
  degraded" posture the Cerbos-sidecar risk above already states); a
  transient userinfo failure during JIT refresh (D24) does not block
  sign-in itself — the session is still established from the already
  -verified ID token, and the display-data refresh is retried on the next
  sign-in, since display data staleness is not a security property.

## Migration Plan

1. **Better Auth schema migration**: `npx @better-auth/cli generate` (schema
   definitions) → `drizzle-kit generate` (SQL), landing in
   `packages/db/migrations/000N_auth_schema.sql`, creating the `auth` Postgres
   schema and every Better Auth/plugin table inside it — including the
   `rateLimit` plugin's own table once `storage: "database"` is configured
   (D20), so this remains one migration, not two — plus `CREATE ROLE
   tayzu_auth` and its grants (hand-written custom SQL, since Drizzle cannot
   express `GRANT`). ⛔ **Checkpoint 3**: presented and approved separately,
   before continuing.
2. **Catalog roles/RLS migration**: a Drizzle-generated migration adding
   `pgPolicy`/`pgRole` to every catalog table (D6), followed by a hand-written
   custom SQL migration for `GRANT`/`REVOKE`/`FORCE ROW LEVEL SECURITY` and
   `CREATE ROLE tayzu_migrator`/`tayzu_app` where not already provisioned by
   infrastructure. ⛔ **Checkpoint 3**: presented and approved separately,
   after step 1's approval, before continuing.
3. **Machine credential revocation list migration** (D21): a Drizzle-generated
   migration adding `machine_credential_revocation` with the same
   `tenant_isolation` `pgPolicy`/`FORCE ROW LEVEL SECURITY` treatment as every
   catalog table. ⛔ **Checkpoint 3**: presented and approved separately,
   after step 2's approval, before continuing.
4. **Cerbos policy tree** (`policies/`): derived roles, role policies,
   resource policies, and their test suites, compiled and tested by `cerbos
   compile` in CI. ⛔ **Checkpoint 3**: every policy file is presented and
   approved separately, distinct from every migration and from the PR review.
5. **Session `ssoSid` column migration** (D25/D26): a Drizzle-generated
   `ALTER TABLE auth.session ADD COLUMN sso_sid` migration, added via
   Better Auth's `session.additionalFields` — this alters a table already
   created by step 1's migration, so it is its own, separate migration, not
   a rider on step 1. ⛔ **Checkpoint 3**: presented and approved separately,
   after step 4's approval, before continuing. (D26's `jti` replay check
   reuses the existing `auth.verification` table from step 1 — no
   migration of its own.)
6. Deploy: `apps/api` and the Cerbos sidecar ship together in one ACA
   revision (D7); there is no environment before this one, so this is the
   first real deployment, not a promotion. The Visma Connect client is
   registered in the Visma Developer Portal (redirect URI, post-logout
   redirect URI, back-channel logout URI) as an out-of-band, one-time setup
   step before this deploy, documented in `docs/references/visma-connect/
   README.md` rather than expressed as code.
7. Rollback: this is still a low-data-volume deployment (`project.md` §6,
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
| Q10 | (VCDM pre-assessment, 2026-09-28) Neutralizing Better Auth's native org-management/apiKey endpoints | Blocked at the Fastify routing layer with a deny-by-default allowlist of mounted `/api/auth/*` routes; every membership mutation instead goes through a Cerbos-gated oRPC procedure calling `auth.api.*` in-process (D18). |
| Q11 | (VCDM pre-assessment, 2026-09-28) Independent re-verification of `activeOrganizationId`/tenant-switch membership | Add both a test asserting non-membership is rejected, and a defense-in-depth re-check inside `resolveContext()`, independent of Better Auth's own logic, cached briefly, failing closed (D19). |
| Q12 | (VCDM pre-assessment, 2026-09-28) Pre-authentication credential-stuffing/brute-force protection | A second, IP-and-email-keyed rate-limit layer (Better Auth `rateLimit`, database storage) for sign-in/two-factor/sign-up, plus a separate IP-and-client-id-keyed `@fastify/rate-limit` bucket for `/v1/auth/token` (D20). |
| Q13 | (VCDM pre-assessment, 2026-09-28) Revoked machine credentials invalidating already-issued tokens | A Postgres revocation list, consulted by `resolveContext()` on every machine-token request through a cache of at most 5 seconds TTL, failing closed on lookup failure (D21). New table, Checkpoint 3 applies. |
| Q14 | (VCDM pre-assessment, ticket 9, 2026-09-28) Where forgot-password/reset lives | A new change, `044-password-reset-and-account-recovery`, executed after `043` (reuses its email sender). `002` ships no reset flow; its sign-up/sign-in responses still resist account enumeration. Recorded as `project.md` §23 D10. |
| Q15 | (Task 2.5, Checkpoint 3, 2026-09-28) How D20's pre-authentication limiter is built | Better Auth 1.7.6's built-in `rateLimit` keys only by IP and path and its blocked response cannot carry `Retry-After` or `AUTH_RATE_LIMITED`, so D20 is implemented as a small Better Auth plugin (`packages/auth/src/rate-limit/`) with IP and normalized-email buckets, keys stored as sha256 hashes, atomic conditional increments; the built-in limiter is disabled. Its table `auth.rate_limit` ships in new migrations `0004`/`0005` (approved at Checkpoint 3), not inside `0002` as D20 first stated. |
| Q16 | (2026-09-28) Is public self sign-up available under any circumstance | No, disabled under every circumstance: `emailAndPassword.disableSignUp: true`, the Better Auth sign-up route is not in D18's allowlist (unreachable, 404), and in-process sign-up is refused too. Users are created only by an org admin (Cerbos-gated `identity.users.create` calling `auth.api.createUser` in-process) or a bootstrap script for an organization's first admin. Invitations are `043`'s (D22). |
| Q17 | (2026-09-28) Add Visma Connect SSO to 002 | Yes, as a second, non-exclusive sign-in method alongside local email+password; the user chooses on the login screen `003` builds. Better Auth's bundled `genericOAuth` plugin, `providerId: "visma-connect"`, discovery-based, authorization code + PKCE S256, state + nonce, `scopes: openid email profile`, `disableImplicitSignUp`/`disableSignUp: true` (SSO never creates users), secrets from environment/Key Vault (D15) (D23). |
| Q18 | (2026-09-28) How Tayzu links a Tayzu user to a Visma Connect account | Explicit only, always keyed on the immutable Visma Connect UserID (`sub`), never on email. Two paths: self-service linking from an authenticated local session (Better Auth's `/link-social`, step-up required if the caller has MFA), or an admin recording a user's Visma Connect UserID on the Tayzu user (Cerbos-gated, audited). An unlinked `sub` is rejected with one generic error. Email is JIT-refreshed from `/connect/userinfo` as display data only, never as an identity key; a user must always keep at least one sign-in method (D24). |
| Q19 | (2026-09-28) How step-up works for a session Visma Connect established | Delegated to Visma Connect: a re-authorization with `acr_values=urn:idp:vismaconnect:mfa` and `max_age=300`, with the returned ID token's `auth_time`/`acr`/`amr` validated server-side (never trusting that the client-supplied parameters survived the round trip). Local sessions keep D4's local TOTP step-up. A new `ssoSid` session column (Checkpoint 3) tells the guard which kind of session it is and doubles as D26's back-channel-logout join key (D25). |
| Q20 | (2026-09-28) Back-channel logout | A public, rate-limited endpoint validates Visma Connect's `logout_token` per the OIDC Back-Channel Logout spec (signature via discovered JWKS, `iss`/`aud`/`iat`/`exp`, `events`, no `nonce`, `jti` replay) and revokes the matching Tayzu sessions by `sid` and/or `sub`. `jti` replay state reuses the existing `auth.verification` table (no new table); the `ssoSid` session column (Q19/D25) is the new schema this piece needs (Checkpoint 3) (D26). |
| Q21 | (2026-09-28) Does 002 also take on enforcing SSO per organization | No — out of scope, stays with `025-sso-and-identity-federation` (customer-brought SAML/OIDC, per-tenant enforcement, group-sync, SCIM). Visma Connect is Tayzu's own single primary IdP for every tenant, not a customer-configurable federation; `025` is unaffected in scope, only in sequencing relative to `002` (Non-Goals). |

No open questions remain for this change.
| Q22 | (Checkpoint 3, 2026-09-29) The worked dynamic-ABAC example | Replaces the region example with two scenarios: a grant (a member deletes an entity where `resource.createdBy == principal.id`, permitted although the member role alone does not grant `delete`) and a deny (non-admin `update` on `catalog_entity` where `resource.locked == true` fails with `AUTH_FORBIDDEN`, while an admin can still update). A grant adds within the role ceiling; a deny is an explicit, documented exception (D8, D10). |
| Q23 | (Checkpoint 3, 2026-09-29) Who can update entities | An entity with no owner team can be created and updated by any member of the tenant. An entity with an owner team can be updated only by a member of that team or a moderator of its blueprint, plus admin. |
| Q24 | (Checkpoint 3, 2026-09-29) Member access to users and teams | Members can view and list users and teams (resource kinds `user` and `team`) of their own tenant. Create, update, delete, and role changes stay admin-only. |
| Q25 | (Checkpoint 3, 2026-09-29) Cerbos semantics corrections found by the policy-writer | Role policies are a ceiling; `parentRoles` narrows to the parent's permissions rather than inheriting, so `admin.yaml` has no `parentRoles`. `member.yaml`'s ceiling on `catalog_entity` includes `delete`, while no resource-policy rule grants `delete` to a plain member. The default deny is Cerbos's implicit deny plus an explicit cross-tenant deny rule in every resource policy (a wildcard deny would override admin). `catalog_entity` gains the attributes `createdBy` and `locked`; `ownerTeam` is absent, not null, without an owner (D8). |
| Q26 | (Task 9.1, 2026-09-29) Where the principal's roles and attributes travel | A host-supplied `principal: { roles, teams?, moderatedBlueprints? }` field on `CatalogContext`, filled only by `resolveContext` (Better Auth member role mapped owner/admin -> `admin`, plus the `_user` entity's teams and moderated blueprints), never from input. Missing or empty `principal` makes Cerbos deny, so the operation fails closed with `AUTH_FORBIDDEN`. `actor` keeps its 002 shape. |
| Q27 | (Task 9.1, 2026-09-29) How the pipeline reaches Cerbos | Each service factory receives the Cerbos client (`authz` option), and `defineCatalogOperation` requires an `authorization` declaration (resource kind, action, resource id and attributes) on every operation; the type makes it mandatory. Pipeline unit tests use an explicit test declaration. |
