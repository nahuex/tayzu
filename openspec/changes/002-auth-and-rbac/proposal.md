# Proposal: 002-auth-and-rbac

## Why

`001-catalog-core` built the domain model, the operation pipeline, and a
tenant-transaction seam for RLS, but deliberately shipped with no
authentication, no authorization engine, and no network listener (ADR-0011).
Every later capability's roadmap dependency on "002" (`003` needs a
permission model to build pages against, `004`-`006` need it to gate
mutations, `025` needs the org model to federate into) is a dependency on
this change specifically. Without it, nothing in Tayzu can be exposed safely,
and the RLS seam and the `x-tayzu-risk: high` marker 001 already built have no
consumer.

This change is the load-bearing half of Port's full auth/RBAC surface. A
research pass (`docs/references/port/roadmap-analysis.md:40-59`) sized the
full surface at 100-140 TDD tasks, well past the project's 30-80 task budget,
so it was split in two. The human approved the split and every scope
question it raised on 2026-09-28 (recorded below as Resolved decisions in
`design.md`). The other half — 4-state user status and invitations, service
accounts, the org API-credentials viewer, data retention/deletion, and
credential-rotation UX — is `043-identity-lifecycle-and-org-admin`, which
depends on this change and runs immediately after it.

## What Changes

- **Authentication** via Better Auth: email/password with `organization`
  (`organization.id` = `tenant_id`, matching ADR-0006), `admin`, and
  `two-factor` (MFA) plugins, backed by its own Postgres schema (`auth`) and
  its own database role (`tayzu_auth`), never routed through
  `withTenantTransaction`.
- **Session policy**: 7-day rolling expiry, 12-hour idle timeout, all other
  sessions revoked on password change, session cookie cache off.
- **Machine credentials**: a long-lived, revocable, rotatable client
  id/secret pair (Better Auth `api-key` plugin, org-owned) exchanged for a
  short-lived (1-hour) signed access token, for `integration` and `agent`
  actors — Port's own client-credentials pattern, adapted.
- **Step-up authentication**: an operation carrying `x-tayzu-risk: high`
  (001 D11) requires a fresh MFA verification from a human caller, or fails
  with a step-up-required error.
- **Postgres RLS under a non-owner runtime role** (001's T3 follow-up):
  a `tayzu_migrator` (owner) / `tayzu_app` (runtime) role split, `REVOKE
  UPDATE, DELETE, TRUNCATE` on `catalog_change_event` from the runtime role,
  `FORCE ROW LEVEL SECURITY` on every catalog table, and 001's tenant-isolation
  tests re-run as the non-owner role.
- **Cerbos as the sole authorization engine**: a small, fixed set of resource
  kinds (`catalog_blueprint`, `catalog_entity`, `team`, `user`), the
  three-tier RBAC baseline (Admin / Member, with Moderator as an additional
  per-blueprint grant), team ownership (`$team`, Owning Teams, ownership
  None/Direct/Inherited with the inherited-conflict rule), and dynamic ABAC
  through the static-policy/dynamic-context pattern. `tenant_id` is the first
  attribute of every check.
- **`User` and `Team` as core system blueprints** (`_user`, `_team`), with the
  minimal Port-shaped status field (`Active`/`Disabled` at least; the full
  4-state lifecycle and invitations are `043`).
- **The first HTTP listener** (Fastify + oRPC), with the fixes 001 flagged as
  follow-ups: `inputStructure: 'detailed'` so `DELETE`/`GET` read the query
  string at runtime (not just in the generated document), and an HTTP-boundary
  `clientInterceptors` fix so `CatalogError` status codes survive the wire
  instead of collapsing to a generic 500.
- **Redaction of conflict errors to a count**: `CATALOG_SCHEMA_INCOMPATIBLE`,
  `CATALOG_REFERENCE_VIOLATION`, and detach-referrer listings now redact any
  entity identifier the caller cannot read (per Cerbos) to a count of
  "+N not visible".
- **DAST**: an OWASP ZAP baseline scan in CI, the first time Tayzu has any.
- **Key Vault seam**: the runtime and migration DB role passwords, and Better
  Auth's own secrets, move off `.env` and are referenced natively by Azure
  Container Apps.

Out of scope, and assigned to `043-identity-lifecycle-and-org-admin` (new id,
not a renumbering, executed immediately after this change): the full 4-state
user status/invitation lifecycle and invitation email, service accounts, the
org API-credentials viewer, data retention/deletion policy and org deletion,
and credential-rotation policy UX. Also out of scope: generic OIDC/SAML/SCIM
federation (`025`), the permission simulator, "view as", per-page ACLs, and
workflow execute permissions (`014`/`006`), and any multi-org UX (`042`).

## Capabilities

### New Capabilities
- `auth-and-rbac`: authentication, session and MFA policy, machine
  credentials, Postgres RLS enforcement, and Cerbos-based authorization
  (RBAC + team ownership + dynamic ABAC) for every catalog operation.

### Modified Capabilities
- `catalog-core`: the published API contract now includes an HTTP transport
  that must match the committed OpenAPI document (error status codes,
  `DELETE`/`GET` query-string inputs); conflict-listing errors now redact
  entities the caller cannot read to a count.

## Impact

- **New code**: `packages/auth` (`@tayzu/auth`: Better Auth instance, schema,
  hooks), `packages/authz` (`@tayzu/authz`: Cerbos client, attribute
  builders, resource-kind constants), `apps/api` (the first application:
  Fastify bootstrap mounting Better Auth's handler and the catalog's oRPC
  handler), `policies/` (Cerbos policy YAML and their test suites, not a
  package).
- **Database**: two Checkpoint-3 migrations — (1) Better Auth's generated
  schema in its own `auth` Postgres schema, plus the `tayzu_auth` role; (2)
  the `tayzu_migrator`/`tayzu_app` role split, `GRANT`/`REVOKE`, and `FORCE
  ROW LEVEL SECURITY` on every catalog table. ⛔ **Checkpoint 3 applies to
  both, separately.**
- **Policies**: the first `policies/` tree (derived roles, resource policies,
  role policies). ⛔ **Checkpoint 3 applies to every policy file**, separately
  from the PR and from the migrations.
- **API**: the catalog's oRPC procedures are served over HTTP for the first
  time, behind Better Auth session/API-key authentication and Cerbos
  authorization. New procedures: machine-credential token exchange, MFA
  enrollment/verification, step-up verification.
- **Dependencies**: `better-auth@1.7.6`, `@better-auth/api-key@1.7.6`,
  `@better-auth/drizzle-adapter@1.7.6`, `@cerbos/grpc@0.29.1`,
  `@cerbos/orm-drizzle@0.1.0`, `fastify@^5.12.5`, `@fastify/cors@^11.3.0`,
  `@fastify/helmet@^13.1.1`, `@fastify/rate-limit@^11.2.0`, the
  `ghcr.io/cerbos/cerbos:0.55.0` container image (pinned by digest).
- **Downstream contracts this change freezes**: the `AUTH_FORBIDDEN` error
  code and its distinction from `CATALOG_NOT_FOUND` (an authorization deny
  inside your own tenant is not "not found"; a cross-tenant read still is);
  the Cerbos resource-kind taxonomy; the `CatalogContext` resolution rules
  for session vs. machine-token callers. `003`, `004`-`006`, and `025` build
  directly on these.
- **Security**: pre-assessed against SSA SEC01-SEC16 by the
  `vcdm-ssa-validator` agent. Findings are folded into `design.md` under
  "Security considerations".
