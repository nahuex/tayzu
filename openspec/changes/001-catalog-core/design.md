# Design: 001-catalog-core

## Context

- The repository is greenfield. It has only OpenSpec scaffolding and the
  project master prompt. There is no application code, no `package.json`, and
  no `docs/adr/`. This change therefore also lays down the minimum workspace
  this capability needs.
- Fixed stack decisions this design builds on, which are not debated here:
  - TypeScript monorepo (pnpm + Turborepo).
  - Fastify + oRPC (OpenAPI 3.1), Drizzle ORM, PostgreSQL 16.
  - Shared schema + `tenant_id` + RLS (ADR-0006).
  - `tenant_id` = Better Auth `organization.id`.
  - Cerbos for authorization.
  - OpenTelemetry → Azure Monitor.
  - Vitest.
- Auth, Cerbos, and RLS policies arrive in `002-auth-and-rbac`. Until then
  nothing can authenticate a caller, which shapes decision D2.
- Motivation: see `proposal.md` (Why). Behavior: see
  `specs/catalog-core/spec.md`. This document only covers *how*.
- Port reference: docs.port.io was not reachable from the sandbox (proxy 403).
  The model was checked against a public mirror of the Port docs source (last
  updated July 2025). The "Divergences from Port" section lists every
  deliberate difference.

## Goals / Non-Goals

**Goals:**
- A domain layer (validation, schema compatibility, merge semantics) that is
  pure, I/O-free, and exhaustively unit-testable.
- Tenant isolation from day one. Two layers are active in 001:
  - explicit `tenant_id` scoping in every query;
  - composite `tenant_id` foreign keys, which protect writes and references
    but not reads.

  A third layer is prepared: a per-transaction `app.tenant_id` seam that
  002's RLS policies plug into without touching catalog code. That layer only
  takes effect once 002 adds a non-owner runtime role and
  `FORCE ROW LEVEL SECURITY`.
- A single operation pipeline, so every operation gets context checks, the
  tenant transaction, error mapping, and telemetry the same way. This is the
  structural guarantee behind "same path for humans and agents".
- A telemetry contract that is machine-checked, not just documented.

**Non-Goals (design-level):**
- No HTTP listener, Fastify app, or `apps/*` package. Procedures are invoked
  in-process only (D2).
- No RLS policies, database roles, or grants. They ship in 002, where the
  non-owner application role they depend on is created.
- No consumer of the change-event log. 004 adds it.
- No filtering, full-text search, or search rules in `list`. 003 adds them.
- No OTel SDK/exporter wiring to Azure Monitor. The host app adds it in 002
  or 010. The catalog depends on the OTel **API** only.

## Decisions

### D1. Package layout

```
package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json
eslint.config.js · .prettierrc · vitest.config.ts (projects) · CLAUDE.md
.github/workflows/ci.yml · .claude/hooks/session-start.sh
openapi/catalog.openapi.json            # committed contract (D11)
docs/adr/                               # ADRs from this change (D13)
docs/catalog/                           # capability docs (Docs-as-Code)
packages/
  observability/   @tayzu/observability  # OTel test harness + SDK bootstrap helper
  db/              @tayzu/db             # pg pool, tenant tx helper, migration runner, migrations/
  catalog/         @tayzu/catalog
    src/domain/       # pure: types, errors, context, identifiers, meta-schema,
                      #       entity validation, merge, compatibility, limits
    src/persistence/  # Drizzle table definitions + repositories
    src/service/      # operation pipeline + use cases
    src/api/          # oRPC contract + router + error mapping
    src/telemetry/    # contract.ts (names/attributes) + instruments
```

- Each capability owns its Drizzle table definitions. `@tayzu/db` owns the
  migration directory and its ordering: `drizzle.config.ts` globs
  `packages/*/src/persistence/schema.ts`, so `@tayzu/db` never imports a
  capability package and there are no dependency cycles.
- *Alternative considered:* a single `packages/core`. Rejected because 002
  and 004 need `@tayzu/db` and `@tayzu/observability` without pulling in the
  catalog.

### D2. The oRPC router exists and is contract-checked, but is not served over the network

The catalog procedures, the input and output Zod schemas, error mapping, and
the OpenAPI document all land in this change. Tests call them in-process with
`createRouterClient(router, { context })`. No Fastify listener mounts them
until 002 puts authentication and Cerbos in front.

- *Why:* exposing a catalog API with no authentication would need a test-only
  tenant header or similar. That is exactly the kind of bypass the governance
  principle forbids, and SSA SEC02/SEC03 flag it. Keeping the API off the
  network means zero new attack surface in 001.
- *Alternative:* a dev-only header resolver. Rejected: it is a backdoor that
  someone will eventually deploy by accident.
- *Alternative:* no API layer until 002. Rejected: the OpenAPI contract-check
  is mandatory in CI (Agentic TDD), and 003 needs a frozen contract.

### D3. Catalog context and the operation pipeline

```ts
type ActorType = 'user' | 'agent' | 'integration' | 'system';
interface Principal { type: ActorType; id: string }            // id: opaque, ^[A-Za-z0-9_.:-]{1,128}$
interface CatalogContext { tenantId: string; actor: Principal & { onBehalfOf?: Principal } }
```

The context is a **host-supplied** argument (`createRouterClient(router, {
context })` in 001; the auth middleware in 002). It is never part of a
procedure's input schema, and `contract:check` rejects any `tenantId` or
`actor` field in the OpenAPI document. `onBehalfOf` exists so that an agent's
write can be traced to the human or run that triggered it. The Tayzu
principle "same audit trail" needs the delegation chain, not only the last
hop.

Every service operation is declared through one function,
`defineCatalogOperation(name, handler)`. The runtime flow is:

1. Validate the context. On failure, count
   `tayzu.catalog.context.rejections`, emit the
   `catalog.security.context_rejected` log, and throw
   `CATALOG_CONTEXT_REQUIRED`.
2. Start span `catalog.<name>` with the common attributes.
3. Run cheap limit checks (D8).
4. Run `withTenantTransaction(ctx, fn)` (D5).
5. Map errors to a `CatalogError`.
6. Record span status and the `operation.duration` histogram.
7. Emit the audit log for mutations.

There is **no** second entry point. Actor type only ever appears as data
(attribution, the reserved-identifier rule). It never selects a code path.
The main guard is the actor-parity test **matrix**: every mutation × every
actor type × success and failure. A lint rule (`no-restricted-syntax` on
`actor.type` member access outside `domain/reserved.ts` and
`service/pipeline.ts`) is a secondary aid only. It can be bypassed, for
example by destructuring, so it is not relied on.

### D4. Data model (first migration)

The `tenant_id` column is `text NOT NULL` in every table. It is `text`, not
`uuid`, because Better Auth's `organization.id` is a string ID. Timestamps are
`timestamptz` in UTC. Row IDs are UUIDv7, generated in the application.

| Table | Key columns | Constraints |
|---|---|---|
| `catalog_blueprint` | `id`, `tenant_id`, `identifier`, `title jsonb`, `description jsonb`, `icon`, `schema jsonb`, `status_schema jsonb NULL`, `version int`, `created_at/by_type/by_id`, `updated_*` | `UNIQUE (tenant_id, identifier)`, `UNIQUE (tenant_id, id)` (FK target) |
| `catalog_relation_definition` | `id`, `tenant_id`, `source_blueprint_id`, `identifier`, `title jsonb`, `target_blueprint_id`, `many bool`, `required bool` | `UNIQUE (tenant_id, source_blueprint_id, identifier)`; FKs `(tenant_id, source_blueprint_id)` → blueprint `ON DELETE CASCADE` and `(tenant_id, target_blueprint_id)` → blueprint `ON DELETE RESTRICT`; `CHECK (NOT (many AND required))` |
| `catalog_entity` | `id`, `tenant_id`, `blueprint_id`, `identifier`, `title`, `icon`, `spec_properties jsonb`, `status_properties jsonb NULL`, `status_observed_generation int NULL`, `status_observed_at`, `status_source`, `generation int`, `version int`, audit columns | `UNIQUE (tenant_id, blueprint_id, identifier)`, `UNIQUE (tenant_id, id)`; FK `(tenant_id, blueprint_id)` → blueprint `RESTRICT` |
| `catalog_entity_relation` | `tenant_id`, `source_entity_id`, `relation_definition_id`, `scope` (`spec`\|`status`), `target_entity_id`, `position int` | PK `(tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id)`; `CHECK (scope IN ('spec','status'))`; FK source `CASCADE`, target `RESTRICT`, definition `RESTRICT`, all composite with `tenant_id`; index `(tenant_id, target_entity_id)` for backward traversal |
| `catalog_change_event` | `tenant_id`, `seq bigint`, `occurred_at`, `actor_type`, `actor_id`, `on_behalf_of_type NULL`, `on_behalf_of_id NULL`, `action`, `resource_kind`, `blueprint_identifier`, `resource_identifier`, `version`, `changed_fields text[]`, `snapshot jsonb`, `trace_id NULL` | PK `(tenant_id, seq)`; trigger `catalog_change_event_append_only` (`BEFORE UPDATE OR DELETE` row-level, plus `BEFORE TRUNCATE` statement-level) raises an exception |
| `catalog_tenant_sequence` | `tenant_id` PK, `last_seq bigint` | per-tenant counter for `seq` |

- **Relations are stored only as edges**, never also inside `spec` or
  `status` JSON. `spec.relations` and `status.relations` in API responses are
  assembled from the edges with the matching `scope`, ordered by `position`. There is a single source of truth, the database enforces
  referential integrity (`RESTRICT` gives "cannot delete a referenced entity"
  for free, with no race window), and backward traversal is an index lookup.
  - *Alternative:* keeping relations in `spec` jsonb and validating them in
    the application. Rejected because of the time-of-check/time-of-use race on
    delete and slow backward queries.
- **Composite FKs that include `tenant_id`** make a cross-tenant edge
  impossible even if a service bug slips through (defense in depth under
  SEC03).
- The **`spec`/`status` split** is expressed as separate columns rather than
  one document. This lets the status write be a narrow `UPDATE` that
  physically cannot touch spec columns.
- The **append-only trigger** makes the change-event log tamper-resistant
  in 001 without needing database roles. In 002 it is complemented by
  `REVOKE UPDATE, DELETE, TRUNCATE` for the runtime role. The trigger stays
  as a second layer, because a table owner can still disable it.
- No GIN indexes on jsonb yet. 003 adds them together with filtering.

### D5. Tenant transaction seam for RLS

`withTenantTransaction(ctx, fn)` opens a transaction and runs:

```sql
SELECT set_config('app.tenant_id', $1, true),
       set_config('statement_timeout', $2, true)
```

`SET LOCAL` cannot take bind parameters, so `set_config(..., true)` (which is
transaction-local) is the only allowed form.

`$2` defaults to 5 s. Repositories still filter by `tenant_id` explicitly in
every query. In 002, RLS policies such as
`USING (tenant_id = current_setting('app.tenant_id'))` are added under a
non-owner app role. Catalog code does not change, and the existing isolation
tests become RLS tests with no rewrite. The value is always passed as a bind
parameter, never interpolated. It has also already been validated against
`^[A-Za-z0-9_-]{1,64}$`. The RLS tests only carry over to 002 unchanged if
002 runs them as the non-owner role with `FORCE ROW LEVEL SECURITY` (recorded
as a 002 requirement).

Outside tests, `createPool` requires TLS (`sslmode=verify-full`) and refuses
to start otherwise. Only the test harness may connect to a local database
without TLS.

### D6. Property schema subset and validation engine

Recorded as [ADR-0008](../../../docs/adr/0008-catalog-property-schema-subset.md).

- **Meta-validation** of blueprint definitions uses a strict Zod
  discriminated union on `type` (`.strict()` everywhere, so unknown keywords
  such as `$ref`, `$id`, `$defs`, `if`, and nested object schemas fail with a
  JSON-Pointer path). The same module is exported for 003's form generator.
- **Entity validation** uses Ajv (draft 2020-12) with `strict: true`,
  `allErrors: true`, and `code.regExp` set to an **RE2** adapter over `re2js`,
  a pure-JS linear-time engine that needs no native build. The Ajv schema is
  *derived* from the meta-validated definition, so Ajv never sees user JSON
  directly. Formats come from `ajv-formats` in `mode: 'fast'`, limited to
  `date-time`, `email`, and `uri` (exposed as `url`). A `url` additionally
  passes a custom keyword that allows only the `http` and `https` schemes,
  which blocks `javascript:` and `data:`. Format regexes are not RE2, so every
  formatted string is capped at 2048 characters before any format check
  runs. `markdown` and `yaml` are presentation hints
  validated as plain strings. They are **never parsed server-side**, which
  avoids YAML bombs.
- `pattern` is compiled with RE2 at definition time. Compile errors
  (backreferences, lookaround) become `CATALOG_VALIDATION_FAILED`.
- **Compiled-validator cache**: an in-process LRU (500 entries) keyed by
  `(tenantId, blueprintId, version)`. Keys are immutable, so there is no
  invalidation logic beyond the version bump. Cache misses emit
  `catalog.schema.compile`.
- *Alternative:* `@cfworker/json-schema`, which does no code generation.
  Rejected because it is slower on hot paths and less mature. The code
  generation risk is contained because Ajv only ever compiles our derived
  subset.
- *Alternative:* full JSON Schema, like Port. Rejected. Remote `$ref` is SSRF,
  and arbitrary keywords make compatibility checking (D7) and form generation
  (003) intractable. The subset can grow additively.

### D7. Schema-compatibility check

On blueprint update the service does the following:

1. Lock the blueprint row `FOR UPDATE`.
2. Compile the proposed validator.
3. Stream the blueprint's entities in batches of 500, with relations assembled.
4. Validate each entity against the proposed definition, and stop after 10
   violations.
5. Reject any change to a relation's `target` if that relation has any edge.

Entity writes lock their blueprint row `FOR SHARE`. As a result, an entity
write can never interleave with a schema change and commit against a stale
schema. The check is O(entities of that blueprint). That is acceptable for
Phase 1 volumes. See Risks.

- *Alternative:* versioned schemas with lazy migration (entities keep the
  version they were written with). Rejected for 001 because it forces every
  reader to handle N schema versions. It can be added later behind the same
  spec.

### D8. Limits

Limits live in a single `CatalogLimits` object (spec defaults, overridable
through configuration). The order of checks is:

1. Byte size of the raw input (`Buffer.byteLength(JSON.stringify(...))`).
2. Counts.
3. Identifier and text rules.
4. Schema compilation.
5. Database.

Nothing expensive runs on oversized input.

### D9. Write semantics

- **Unsafe keys**: all input objects are rebuilt as null-prototype objects
  (`Object.create(null)`) during parsing, and `applyWrite` merges into them.
  It never uses `Object.assign` or spread onto `{}`. `__proto__`,
  `constructor` and `prototype` are rejected at every depth during parsing
  (spec Conventions).
- **Upsert** loads the current row `FOR UPDATE`, computes the next spec (a
  pure `applyWrite(current, input, mode)` function), applies defaults, and
  validates. It then compares canonical JSON (sorted keys, relation order
  preserved) of `title`, `icon`, and `spec` to detect `unchanged`, and only
  then writes the row, the edges (delete + insert for changed relations), and
  the change event.
- `generation` increments only when `spec` changes. `version` increments on
  any change.
- **Create** relies on the unique constraint. There is no read-then-insert
  race. Database errors are mapped by **constraint name**, never by SQLSTATE
  alone:
  - `23505` on `catalog_entity_tenant_blueprint_identifier_uq` (and the
    equivalent blueprint constraint) → `CATALOG_ALREADY_EXISTS`;
  - `23503` on the edge target, blueprint or relation-definition FKs →
    `CATALOG_REFERENCE_VIOLATION`;
  - anything else → `INTERNAL`.
- **Status write** replaces the observed snapshot: it updates the
  `status_*` columns and deletes and re-inserts the `scope = 'status'` edges.
  The `spec` columns and edges are never touched (a narrow `UPDATE`, plus
  deletes filtered by `scope`).
- **Delete** always removes the `scope = 'status'` edges pointing to the
  deleted entity first. Observed links never block a delete. Each affected
  referrer gets a `version` bump and a `status_updated` event.
- **Delete with `detachReferences`** does the following in one transaction:
  1. Find the referrers.
  2. Fail if any referrer uses a required relation.
  3. Delete their optional edges and bump the referrers' `version` and
     `generation`, appending one `updated` event per referrer.
  4. Delete the entity and append a `deleted` event.
- **Change events**: `seq` is assigned with
  `UPDATE catalog_tenant_sequence ... RETURNING last_seq`, inserting the row
  on the first write. This gives a gap-free sequence in commit order per
  tenant, which 004's outbox consumer needs.

### D10. Pagination

List operations sort by `identifier` ascending, and relations by
`(blueprint, relation, identifier)`. They use keyset pagination
(`WHERE identifier > $cursor`). The cursor is an opaque base64url JSON value,
`{ "k": "<last key>" }`, and a malformed cursor returns
`CATALOG_VALIDATION_FAILED`. The cursor carries no tenant: it is always
applied inside the context's tenant, so tampering with it can only move
within the caller's own data.

### D11. API contract and error mapping

| Procedure | OpenAPI route |
|---|---|
| `blueprints.create` | `POST /v1/blueprints` |
| `blueprints.list` | `GET /v1/blueprints` |
| `blueprints.get` | `GET /v1/blueprints/{blueprint}` |
| `blueprints.update` | `PUT /v1/blueprints/{blueprint}` |
| `blueprints.delete` | `DELETE /v1/blueprints/{blueprint}` |
| `entities.create` | `POST /v1/blueprints/{blueprint}/entities` |
| `entities.list` | `GET /v1/blueprints/{blueprint}/entities` |
| `entities.get` | `GET /v1/blueprints/{blueprint}/entities/{entity}` |
| `entities.upsert` | `PUT /v1/blueprints/{blueprint}/entities/{entity}` (body `mode: replace\|merge`) |
| `entities.delete` | `DELETE /v1/blueprints/{blueprint}/entities/{entity}?detachReferences=` |
| `entities.writeStatus` | `PUT /v1/blueprints/{blueprint}/entities/{entity}/status` |
| `entities.listRelated` | `GET /v1/blueprints/{blueprint}/entities/{entity}/related?direction=forward\|backward&scope=spec\|status` |

Entity identifiers may contain `/`, so they are percent-encoded as a single
path segment.

| Error code | HTTP |
|---|---|
| `CATALOG_CONTEXT_REQUIRED` | 401 |
| `CATALOG_RESERVED_IDENTIFIER` | 403 |
| `CATALOG_NOT_FOUND` | 404 |
| `CATALOG_ALREADY_EXISTS`, `CATALOG_VERSION_CONFLICT`, `CATALOG_SCHEMA_INCOMPATIBLE` | 409 |
| `CATALOG_VALIDATION_FAILED` | 400 |
| `CATALOG_REFERENCE_VIOLATION`, `CATALOG_LIMIT_EXCEEDED` | 422 |
| any other error | 500 `INTERNAL` |

High-risk procedures (`blueprints.update`, `blueprints.delete`,
`entities.delete`) carry `x-tayzu-risk: high` in the OpenAPI document. 002
(Cerbos) and 014 (human-in-the-loop for agents) consume that marker.

The error body is `{ code, message, issues? , details? }`. Unknown errors
become a generic `INTERNAL` with no message detail. The internal error is
recorded on the span and in the `catalog.internal_error` log in **sanitized**
form only: `exception.type`, SQLSTATE and constraint name. The Postgres
message, `detail` and `where` fields, and bind parameters all embed row
values, so they are dropped. The stack trace is kept with its first line (the
message) removed.

`pnpm contract:generate` writes `openapi/catalog.openapi.json` with the oRPC
`OpenAPIGenerator`, using stable key order. `pnpm contract:check` regenerates
it to a temp file and fails on any diff.

### D12. Testing strategy

- **Unit tests** (domain): pure, no database, most of the test count.
- **Integration tests** (persistence, service, api): run against a **real
  PostgreSQL 16** through `DATABASE_URL`. Migrations are applied once per run.
  Isolation is *tenant-per-test*: each test generates a random `tenantId`, so
  tests can run in parallel without truncation, and every test implicitly
  exercises tenant scoping. CI uses a `postgres:16` service container. The
  cloud sandbox starts the preinstalled local cluster from a SessionStart
  hook. The harness fails fast with an explicit message if `DATABASE_URL` is
  missing.
  - *Alternative:* PGlite. Rejected because it cannot validate the RLS
    behavior 002 depends on, and its engine differences would erode trust in
    the tests.
  - *Alternative:* Testcontainers. Not needed, since both environments
    already provide Postgres, and it adds startup cost.
- **Contract**: `contract:check` (D11).
- **Telemetry**: `otel-smoke-check` (see the Observability contract below).

### D13. Docs-as-Code and ADRs from this change

This change writes the following ADRs in `docs/adr/`:

- `0008-catalog-property-schema-subset.md` (D6)
- `0009-relations-as-edges.md` (D4)
- `0010-safe-schema-evolution.md` (D7)
- `0011-api-not-exposed-before-auth.md` (D2)

It also creates the system diagram `docs/architecture/system-diagram.md`
(Mermaid, R6) and the dependency policy `docs/security/dependencies.md` (R7),
and writes the capability doc `docs/catalog/catalog-core.md`: the concepts,
the error codes, and the telemetry reference. ADR-0001 to ADR-0007 from the
master prompt are not in the repository yet. Backfilling them is proposed
separately and is not part of this change.

## Observability contract

This section is the declared contract under Observability-Driven Development.
`packages/catalog/src/telemetry/contract.ts` is its executable mirror (a
single source of names and attributes). The **otel-smoke-check** runs every
operation once on success and once per applicable error class, using the
in-memory span, metric, and log exporters from `@tayzu/observability`. It
fails if any declared signal or required attribute is missing, if any
**undeclared attribute key** appears on a catalog metric (the cardinality
guard), or if the marker-leak test finds tenant free text in any signal. The
`observability-auditor` subagent compares `contract.ts` against this section.

- **Instrumentation scope**: tracer and meter name `@tayzu/catalog`, version
  equal to the package version. The library depends only on
  `@opentelemetry/api` and `@opentelemetry/api-logs`. The SDK and exporters
  are configured by the host app.
- **Naming**: span names and attribute keys are lowercase, dot-separated, and
  in English. Custom attributes use the `tayzu.` namespace. Standard
  semantic-convention keys (`error.type`, `db.*`, `exception.*`) are reused
  where they exist.

### Spans

All operation spans are `INTERNAL`, with one span per operation. Database
spans come from `@opentelemetry/instrumentation-pg`, configured by the host
app with `enhancedDatabaseReporting: false` so bind values are never
recorded. The same configuration applies in the test harness.

| Span name | When | Required attributes (in addition to common) | Conditional attributes |
|---|---|---|---|
| `catalog.blueprint.create` | op | `tayzu.catalog.blueprint.identifier` | — |
| `catalog.blueprint.get` | op | `tayzu.catalog.blueprint.identifier` | — |
| `catalog.blueprint.list` | op | `tayzu.catalog.page.size` | `tayzu.catalog.result.count` |
| `catalog.blueprint.update` | op | `tayzu.catalog.blueprint.identifier` | `tayzu.catalog.compatibility.violation.count` |
| `catalog.blueprint.delete` | op | `tayzu.catalog.blueprint.identifier` | — |
| `catalog.entity.create` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier` | `tayzu.catalog.relation.target.count` |
| `catalog.entity.upsert` | op | same as above + `tayzu.catalog.upsert.mode` | `tayzu.catalog.mutation` (`created`\|`updated`\|`unchanged`) |
| `catalog.entity.get` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier` | — |
| `catalog.entity.list` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.page.size` | `tayzu.catalog.result.count` |
| `catalog.entity.delete` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.detach_references` | `tayzu.catalog.detached.count` |
| `catalog.entity.status.write` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.status.source` | `tayzu.catalog.relation.target.count` |
| `catalog.entity.related.list` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.related.direction`, `tayzu.catalog.related.scope` | `tayzu.catalog.result.count` |
| `catalog.schema.compile` | child, validator cache miss | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.blueprint.version` | — |
| `catalog.blueprint.compatibility_check` | child of update | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.compatibility.entities_checked` | `tayzu.catalog.compatibility.violation.count` |
| `catalog.entity.validate` | child of entity writes | `tayzu.catalog.blueprint.identifier` | `tayzu.catalog.validation.issue.count` |
| `catalog.relations.resolve` | child, when relations are written | `tayzu.catalog.relation.target.count` | `tayzu.catalog.relation.missing.count` |

- **Common attributes** on every operation span: `tayzu.tenant.id`,
  `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.operation` (for
  example `entity.upsert`).
- **Errors**: span status `ERROR`, with `error.type` set to the catalog error
  code, or to `internal`. Expected errors (`CATALOG_*`) do **not** record an
  exception event, only `error.type` and, for validation, the issue count.
  `internal` errors
  record a sanitized exception event (see D11): no message, no `detail`.
- **Forbidden on any signal**: property values, entity or blueprint titles and
  descriptions, validation messages, and SQL bind values.

### Metrics

| Instrument | Type, unit | Attributes (the complete allowed set) | Purpose |
|---|---|---|---|
| `tayzu.catalog.operation.duration` | Histogram, `s` (buckets 0.005…10) | `tayzu.catalog.operation`, `tayzu.catalog.outcome` (`success`\|`client_error`\|`server_error`), `error.type` (on error), `tayzu.tenant.id`, `tayzu.actor.type` | Latency, throughput, and error rate per operation (RED) |
| `tayzu.catalog.entity.mutations` | Counter, `{mutation}` | `tayzu.tenant.id`, `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.mutation` (`created`\|`updated`\|`status_updated`\|`deleted`\|`detached`), `tayzu.actor.type` | Write volume by blueprint and actor type (human vs agent vs integration) |
| `tayzu.catalog.blueprint.mutations` | Counter, `{mutation}` | `tayzu.tenant.id`, `tayzu.catalog.mutation` (`created`\|`updated`\|`deleted`), `tayzu.actor.type` | Schema churn |
| `tayzu.catalog.validation.failures` | Counter, `{failure}` | `tayzu.tenant.id`, `tayzu.catalog.operation`, `error.type` (`CATALOG_VALIDATION_FAILED`\|`CATALOG_REFERENCE_VIOLATION`\|`CATALOG_SCHEMA_INCOMPATIBLE`\|`CATALOG_LIMIT_EXCEEDED`\|`CATALOG_RESERVED_IDENTIFIER`) | Client-quality and misuse signal (SEC06) |
| `tayzu.catalog.context.rejections` | Counter, `{rejection}` | `tayzu.catalog.operation`, `tayzu.catalog.context.reason` (`missing_tenant`\|`invalid_actor`) | Security signal: callers without a valid context (SEC03, SEC16) |
| `tayzu.catalog.schema.cache.lookups` | Counter, `{lookup}` | `tayzu.cache.result` (`hit`\|`miss`) | Cache effectiveness |
| `tayzu.catalog.schema.compile.duration` | Histogram, `s` | — | Compile cost |

- **Cardinality budget**: `tayzu.tenant.id` has fewer than 20 values (a small
  number of private tenants, per ADR-0006), and
  `tayzu.catalog.blueprint.identifier` has at most 200 per tenant. Entity
  identifiers and actor IDs are **never** metric attributes. The cardinality
  guard in the otel-smoke-check enforces this.

### Shared attribute keys

The cross-capability keys (`tayzu.tenant.id`, `tayzu.actor.type`,
`tayzu.actor.id`, `tayzu.actor.on_behalf_of.type`,
`tayzu.actor.on_behalf_of.id`) are defined once in
`@tayzu/observability/semconv`. The catalog's `contract.ts` imports them and
defines only the `tayzu.catalog.*` keys. Later capabilities (002, 004, 008)
reuse the same module, so all of Tayzu shares one vocabulary.

### SLIs

These SLIs need no new instruments; they are derived from
`tayzu.catalog.operation.duration`, per `tayzu.catalog.operation` and
`tayzu.tenant.id`:

- **Availability**: the share of operations whose `tayzu.catalog.outcome` is
  not `server_error`. `client_error` counts as available, because it is the
  catalog correctly rejecting bad input.
- **Latency**: p99 of `tayzu.catalog.operation.duration` for successful
  operations.

SLO targets and error-budget alerts are set in 010, together with T5b.

### Sampling exemption

The `catalog.audit.mutation` and `catalog.security.*` log events, and the
counters that T5b alerts on (`tayzu.catalog.context.rejections`,
`tayzu.catalog.validation.failures`), MUST be exempt from sampling and from
filter or drop rules in any downstream telemetry pipeline. 010 inherits this
as a constraint on its Collector or exporter configuration.

### Log events (OTel Logs API, structured)

| Event name | Severity | Attributes | Purpose |
|---|---|---|---|
| `catalog.audit.mutation` | INFO | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.actor.on_behalf_of.type`, `tayzu.actor.on_behalf_of.id` (when present), `tayzu.catalog.mutation`, `tayzu.catalog.resource.kind`, `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.resource.identifier`, `tayzu.catalog.version`, `tayzu.catalog.change_event.seq` | Best-effort copy of the audit trail to centralized logging. It is emitted after commit, so a crash can lose it, and it has no exporter until the host app wires one. The durable audit record is `catalog_change_event` (append-only trigger). |
| `catalog.security.context_rejected` | WARN | `tayzu.catalog.operation`, `tayzu.catalog.context.reason` | Detect callers that bypass context wiring |
| `catalog.security.reserved_identifier_denied` | WARN | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.blueprint.identifier` | Detect attempts to tamper with platform blueprints |
| `catalog.internal_error` | ERROR | `tayzu.catalog.operation`, `exception.type`, `db.response.status_code` (SQLSTATE), `tayzu.db.constraint`, `exception.stacktrace` (with the message line removed) | Diagnose 500s without leaking them to callers |

Every log record carries the active `trace_id` and `span_id`, which the OTel
Logs API does automatically. Every `catalog_change_event` row stores the same
`trace_id`, so an audit entry, its trace, and its database event can be
joined.

## Security considerations (SSA pre-assessment)

The `vcdm-ssa-validator` agent pre-assessed this change against SSA
SEC01-SEC16 in Mode A (`.claude/agents/vcdm-ssa-validator.md`, skill
`.agents/skills/ssa-validator/`) before Checkpoint 1. The first run found
**8 blocking gaps (B1-B8)** and 11 non-blocking ones (N1-N11). All of them
are folded into the spec and this design, as the table shows. Items only a
human could answer were asked in chat and are recorded in Resolved decisions. The pre-assessment runs again
against the code in task 11.2.

| Finding | Resolution |
|---|---|
| B1 `SET LOCAL` cannot take bind parameters, so the tenant value would be interpolated | D5 uses `set_config($1, true)`. `tenantId` has a strict pattern (spec Conventions). There is an injection test. |
| B2 Where the context comes from was undefined, and anyone could claim `system` | The context is host-supplied only and never part of procedure input. `contract:check` forbids `tenantId` and `actor` fields (D3, D11). |
| B3 Entities of reserved `_` blueprints were writable by any actor | Entity writes on `_` blueprints are reserved to `system` (spec "Reserved system identifiers"). |
| B4 Postgres error messages (row values) could reach spans and logs | Errors are sanitized to type, SQLSTATE and constraint (D11), and the marker-leak test covers forced database errors. |
| B5 Free text in `status.source` and `actor.id` could reach telemetry | Both have strict patterns. `actor.id` is an opaque ID, never an email. |
| B6 An agent's delegating principal was not recorded | `actor.onBehalfOf` is stored in attribution, change events and the audit log. |
| B7 Prototype pollution: `constructor`/`prototype` matched the identifier pattern | Unsafe keys are rejected at every depth, and null-prototype objects are used in merges (D9). |
| B8 The change log was mutable, and the OTel audit log was treated as durable | Append-only trigger (D4). The DB table is the durable record; the OTel copy is best-effort. |
| N1 `url` format accepted `javascript:` and `data:` | Only `http` and `https` are allowed (D6). |
| N2 Several inputs had no limit | Limits added for blueprint size, `enum` entries, nesting depth, icon, detach referrers and cursor length. |
| N3 `.`/`..` segments in entity identifiers could confuse routing | Forbidden by the entity identifier pattern rule. |
| N4 The parity test was too narrow, and the lint rule could be bypassed | Parity matrix over every mutation × actor type × outcome. The lint rule is secondary (D3). |
| N5 SQLSTATE-only error mapping | Errors are mapped by constraint name (D9). |
| N6 No marker for high-risk operations | `x-tayzu-risk: high` in OpenAPI (D11). |
| N7 The claim of SHA-pinned actions was false for the existing Copilot workflow | Only the new `ci.yml` is pinned. The Copilot workflow is follow-up T6. |
| N8 Database connections could be non-TLS | `sslmode=verify-full` is required outside tests (D5). |
| N9 Missing tests for these controls | Covered in `tasks.md`. |
| N10 The "three layers" isolation claim was overstated | Goals corrected: two layers active, RLS seam prepared. |
| N11 ajv-formats regexes do not go through RE2 | `mode: 'fast'`, plus a 2048-character cap on formatted strings (D6). |

Per-section posture:

| Section | Applies | Posture after resolution |
|---|---|---|
| SEC01 Diagram | Partial | Mermaid diagram in `docs/architecture/system-diagram.md`, maintained by every change (R6, task 1.8). |
| SEC02 Attack surfaces | Partial | No network surface in 001 (D2). |
| SEC03 Access control | Yes | Deny by default. Host-supplied context. Cross-tenant access returns not found. Composite FKs. Reserved blueprints. A single pipeline. Cerbos in 002. |
| SEC04 / SEC08 / SEC11 / SEC15 | N/A | No passwords, no uploads, no messaging, PaaS only. |
| SEC05 Crypto | Partial | TLS to the database outside tests. No other cryptography. IDs are not secrets. |
| SEC06 Misuse | Yes | Parameterized SQL (`sql.raw` banned). RE2. No `$ref`. Limits checked before work. Unsafe keys rejected. URL schemes restricted. Agents take the same path. 003 must sanitize markdown and URLs on render. |
| SEC07 Dependencies | Yes | Lockfile, `pnpm audit`, Dependabot, pure-JS `re2js`. Dependency SLA and quarterly EOL review (R7). License review, audited waivers and an SBOM artifact (R14). |
| SEC09 / SEC10 Secrets | Yes / Partial | Env-only `DATABASE_URL`, `.env*` ignored, gitleaks. Push protection enabled by the human (R5). Key Vault in 002/010. |
| SEC12 Testing | Yes | Every control above has a test in `tasks.md`. Q1: security tests + VCDM + `/security-review` + Semgrep SAST in CI (R14) + DAST from 002 (R9). Q2: trained (R10). Q3: nonexistent, ticket T5b (R11). |
| SEC13 Deployment | Partial | Managed GitHub Actions, SHA-pinned, `contents: read`. |
| SEC14 Infra permissions | Partial | Trigger in 001. Roles, `REVOKE` and `FORCE RLS` in 002 (T3). |
| SEC16 Logging | Yes | Durable append-only change log plus centralized OTel audit and security events. Retention 12 months + archive to 24 (R8). 24-hour log delivery (R12). |

**Follow-ups outside this change** (to be carried into the named change's
proposal):

- T3 → 002: runtime and migration roles; `REVOKE UPDATE, DELETE, TRUNCATE`
  on `catalog_change_event`; `FORCE ROW LEVEL SECURITY`; RLS tests run as
  the non-owner role; `system` never mapped from an external credential.
- T3 (addendum) → 002: redact entity identifiers the caller cannot read
  from `CATALOG_SCHEMA_INCOMPATIBLE` and `CATALOG_REFERENCE_VIOLATION` to a
  count (R3). Add an OWASP ZAP baseline DAST job once the API is served (R9).
- T4 → 003: sanitize markdown and URL values on render; strict CSP.
- T5 → 010: Log Analytics retention of 12 months interactive plus archive
  to 24 (R8); a KQL export runbook in `docs/security/incident-log-export.md`
  that meets the 24-hour target (R12).
- T5b → 010: Azure Monitor alerts on `tayzu.catalog.context.rejections`,
  `catalog.security.reserved_identifier_denied`, spikes in
  `tayzu.catalog.validation.failures`, and `server_error` outcomes (R11).
- T6: pin `.github/workflows/copilot-setup-steps.yml` (`actions/checkout`
  SHA and the `@fission-ai/openspec` version).
- T7: backfill ADR-0001 to ADR-0007 in `docs/adr/`.

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 001 | Why |
|---|---|---|---|
| Entity identifier mutability | Mutable | Immutable | Stable references for edges, audit, and future workflow runs |
| Identifier when omitted | Auto-generated | Required | Idempotent upserts from integrations need caller-chosen IDs. Generation can be added later. |
| Delete of referenced entity | `delete_dependents=true` cascades deletes | Reject, or `detachReferences` for optional relations; never cascade-deletes | No silent mass deletion. Safer default for agents. |
| Missing relation targets | `create_missing_related_entities` | Rejected | Revisit in 008 for out-of-order syncs |
| Blueprint identifier | `^[A-Za-z0-9@_.:/=-]+$`, max 30 | `^[A-Za-z][A-Za-z0-9_-]{0,63}$` | Safe in URLs, metric attributes, and object keys. `_` prefix reserved. |
| JSON Schema | Broad subset + formats `user`, `team`, `timer`, `proto`, `ipv4/6` | Narrower subset | `user`/`team` depend on 002. Others are additive later. |
| Mirror, calculation, aggregation properties | Yes | No | Later changes |
| Schema change on populated blueprint | Undocumented | Explicit compatibility check | Spec'd behavior instead of surprise |
| Spec vs status | Single `properties` bag | `spec` / `status` split | Project decision (Kubernetes model) |

## Risks / Trade-offs

- [The compatibility check is O(N) on large blueprints (e.g. 100k entities)]
  → Batched streaming, early exit after 10 violations, `statement_timeout`
  raised only for this operation (30 s). The `compatibility_check` span
  exposes the cost. If it becomes a problem, move to an async validated
  migration job (a later change).
- [The per-tenant sequence row serializes that tenant's writes] → Each
  transaction is short (single-digit ms). This is acceptable for Phase 1
  volumes, and bursty integration syncs are the real test. Watch the
  `operation.duration` p99. Fallback: order by `pg_current_xact_id()` plus a
  commit-time relay in 004.
- [Holding the blueprint `FOR SHARE` lock on every entity write blocks writes
  during a long schema update] → A deliberate correctness-over-availability
  choice. Schema updates are rare and admin-driven.
- [The Ajv code generation cache grows with blueprints × versions] → LRU
  bound (500), and the compile-duration metric is observed.
- [Freezing the `spec`/`status` contract, including `status.relations`,
  before 008 has been designed] → Status relations reuse the relation
  definitions and the same edge table (with a `scope` column), so 008 only
  adds writers, not a new model.
- [Tests depend on a real Postgres] → The fast-fail message explains how to
  start it. The domain layer (most tests) needs no database.

## Migration Plan

1. The first migration, `packages/db/migrations/0000_catalog_core.sql`, is
   generated by `drizzle-kit generate` from the table definitions and is never
   hand-written. It creates the six tables above. It contains no roles,
   grants, or RLS policies (those are 002).
2. ⛔ **Checkpoint 3**: the migration SQL is presented for explicit approval,
   separately from the PR review.
3. Deploy: there are no environments yet. Applying the migration runs through
   `pnpm db:migrate` in CI and in the test harness only.
4. Rollback: this is a greenfield database, so rollback is dropping the six
   tables. A generated `down` script is kept next to the migration for
   completeness.

## Resolved decisions (asked and approved in chat, 2026-09-27)

Following `openspec/project.md` §20, every open question was asked to the
human with options. The answers:

| # | Question | Decision |
|---|---|---|
| R1 | Entity identifiers (which may contain `@`) in telemetry | Kept on **spans**, never on metrics (as designed). |
| R2 | Audit reads as well as writes? | No in 001, mutations only. Revisit for every actor type in 014. |
| R3 | Conflict errors listing entities the caller cannot read (002) | **Redact to a count** ("+N not visible") once Cerbos exists. Carried as follow-up T3. |
| R4 | Observed relations in `status` | **Added in 001**: `status.relations`, stored as `scope = 'status'` edges (D4, D9, spec). |
| R5 | SEC09 push protection | The human enables Secret Protection + push protection on `nahuex/tayzu`. gitleaks in CI stays as a second layer. |
| R6 | SEC01 system diagram | Claude maintains it as **Mermaid** docs-as-code in `docs/architecture/system-diagram.md`, ready for Docusaurus (`@docusaurus/theme-mermaid`). Every change updates it (task 1.8). |
| R7 | SEC07 dependency process | Dependabot weekly (npm + Actions). Fix SLA: critical 7 days, high 30 days. `pnpm audit` blocks CI on high. Quarterly EOL review. Documented in `docs/security/dependencies.md` (task 1.7). |
| R8 | SEC16 security-log retention | 12 months interactive in Log Analytics, archive to 24 months (010, as IaC). The Postgres change log does not expire. |
| R9 | SEC12 Q1 security testing | Security tests per control, VCDM pre-assessment at Checkpoints 1 and 2, `/security-review` on every PR, plus **DAST** (OWASP ZAP baseline, later Escape in 009) once an API is served (002). |
| R10 | SEC12 Q2 training | Yes, the team is trained. |
| R11 | SEC12 Q3 post-launch monitoring | Nonexistent today (nothing deployed). Ticket T5b for 010. |
| R12 | SEC16 Q4 time to deliver logs | 24 hours, backed by a KQL export runbook in 010 (T5). |

| R13 | Value-level history of catalog state (raised by the Platform Engineering references, `RA-AZ` L178, `SPE4` L366) | Every change event stores a `snapshot jsonb` of the resulting state (the last state for a delete). This gives point-in-time views and diffs without revision tables. |
| R14 | Extra CI supply-chain controls (`RA-AZ` L426-L430, `VULN` L190-L196, L224, `SOV` L266-L302) | Semgrep OSS SAST (pinned, blocking on high severity); a Syft SBOM as a non-blocking artifact; a license review and an audited waiver path for `pnpm audit` in `docs/security/dependencies.md`. |
| R15 | Observability contract additions (`RA-AZ` L190, `SPE4` L238-L250, L818-L826, `OBS` L100-L102, L216, L224) | SLIs on `operation.duration`; `tayzu.actor.type` on that histogram; shared attribute keys in `@tayzu/observability/semconv`; audit and security signals exempt from sampling. |
| R16 | Blueprint definitions as code (`SOV` L709-L711, `RA-AZ` L174) | A contract test: blueprint read output, minus server-managed fields, is accepted unchanged by create and update. |

No open questions remain for this change.
