# @tayzu/authz

The Cerbos gRPC client wrapper, attribute builders, resource-kind constants,
and ownership resolution. Global rules are in the root `CLAUDE.md`. The
design is `openspec/changes/002-auth-and-rbac/design.md` (D7-D11); the
behavior is `specs/auth-and-rbac/spec.md` in the same change. Change `043`
(D3) adds two resource kinds. When code and design disagree, stop and ask.

## Exports

`src/index.ts` exports the Cerbos client (`createCerbosClient`), the
resource-kind constants (`RESOURCE_KINDS`, `ResourceKind`), the attribute
builder (`buildAttributes`), ownership resolution
(`resolveEffectiveOwnerTeam`), the `PlanResources` filter (`planToFilter`) and
the redaction helper (`redactUnreadable`). The telemetry contract of this
package lives in `src/telemetry/contract.ts`.

## Boundaries

- Cerbos is the **only** authorization decision point (D2, D7). This package
  never computes an allow/deny itself; it builds attributes, calls Cerbos,
  and maps the result.
- Resource kinds are a closed set, declared once in `RESOURCE_KINDS`
  (`src/resource-kinds.ts`): `catalog_blueprint`, `catalog_entity`, `team`,
  `user`, plus `service_account` and `credential` from change `043` (design
  D3). A new kind is a design decision with its own Cerbos policy
  (Checkpoint 3), never an ad-hoc string. `tenantId` is the first attribute of every check, and is a plain
  attribute, never a Cerbos `scope` (D7) — the `same_tenant` derived role
  (`policies/derived_roles/`) is the defense-in-depth layer on top of
  Postgres RLS, not a replacement for it.
- Ownership resolution (`effectiveOwnerTeam`: None, Direct, or Inherited,
  direct-relation-wins) happens **here**, in the service layer, before every
  Cerbos call (D9). Cerbos never walks a relation chain itself.
- `PlanResources` results (`entities.list`) always compose with the mandatory
  tenant scope via `and(...)`. An `ALWAYS_ALLOWED` plan result is never
  treated as "skip the tenant filter" (D7).

## Conventions

- `@cerbos/grpc@0.29.1` is the client; `@cerbos/orm-drizzle@0.1.0` turns
  `PlanResources` output into Drizzle `WHERE` clauses.
- `engine.strictEvaluation: true`: a Cerbos evaluation error denies the whole
  action, never falls back to allow (D7, project.md's fail-closed invariant).
- No TLS on the Cerbos sidecar's loopback link in Azure Container Apps
  (Resolved decision Q8, explicit exception) — TLS stays mandatory for every
  other Cerbos link.
- The redaction helper (`CheckResources(view)` in batch, replacing unreadable
  identifiers in a candidate list with a count) is a pure, mockable unit
  against the Cerbos client — no live Cerbos call needed to test it.

## Tests

- `client.test.ts` and other integration tests need a running Cerbos
  container (`compose.yaml`'s `cerbos` service, or CI's).
- `ownership-resolution.test.ts` and `redaction.test.ts` are pure unit tests
  (no Cerbos, no database).
- Cerbos policies themselves (`policies/`) are compiled and tested by
  `pnpm policy:compile`, not by this package's own test suite.
