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
- Tenant isolation enforced in three layers from day one: service scoping,
  composite foreign keys, and a per-transaction `app.tenant_id` seam that
  002's RLS policies can plug into without touching catalog code.
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
interface CatalogContext { tenantId: string; actor: { type: ActorType; id: string } }
```

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
The actor-parity test and a lint rule (`no-restricted-syntax` banning
`actor.type ===` outside `domain/reserved.ts` and `service/pipeline.ts`) guard
this.

### D4. Data model (first migration)

The `tenant_id` column is `text NOT NULL` in every table. It is `text`, not
`uuid`, because Better Auth's `organization.id` is a string ID. Timestamps are
`timestamptz` in UTC. Row IDs are UUIDv7, generated in the application.

| Table | Key columns | Constraints |
|---|---|---|
| `catalog_blueprint` | `id`, `tenant_id`, `identifier`, `title jsonb`, `description jsonb`, `icon`, `schema jsonb`, `status_schema jsonb NULL`, `version int`, `created_at/by_type/by_id`, `updated_*` | `UNIQUE (tenant_id, identifier)`, `UNIQUE (tenant_id, id)` (FK target) |
| `catalog_relation_definition` | `id`, `tenant_id`, `source_blueprint_id`, `identifier`, `title jsonb`, `target_blueprint_id`, `many bool`, `required bool` | `UNIQUE (tenant_id, source_blueprint_id, identifier)`; FKs `(tenant_id, source_blueprint_id)` → blueprint `ON DELETE CASCADE` and `(tenant_id, target_blueprint_id)` → blueprint `ON DELETE RESTRICT`; `CHECK (NOT (many AND required))` |
| `catalog_entity` | `id`, `tenant_id`, `blueprint_id`, `identifier`, `title`, `icon`, `spec_properties jsonb`, `status_properties jsonb NULL`, `status_observed_generation int NULL`, `status_observed_at`, `status_source`, `generation int`, `version int`, audit columns | `UNIQUE (tenant_id, blueprint_id, identifier)`, `UNIQUE (tenant_id, id)`; FK `(tenant_id, blueprint_id)` → blueprint `RESTRICT` |
| `catalog_entity_relation` | `tenant_id`, `source_entity_id`, `relation_definition_id`, `target_entity_id`, `position int` | PK `(tenant_id, source_entity_id, relation_definition_id, target_entity_id)`; FK source `CASCADE`, target `RESTRICT`, definition `RESTRICT`, all composite with `tenant_id`; index `(tenant_id, target_entity_id)` for backward traversal |
| `catalog_change_event` | `tenant_id`, `seq bigint`, `occurred_at`, `actor_type`, `actor_id`, `action`, `resource_kind`, `blueprint_identifier`, `resource_identifier`, `version`, `changed_fields text[]`, `trace_id NULL` | PK `(tenant_id, seq)` |
| `catalog_tenant_sequence` | `tenant_id` PK, `last_seq bigint` | per-tenant counter for `seq` |

- **Relations are stored only as edges**, never also inside `spec` JSON.
  `spec.relations` in API responses is assembled from the edges, ordered by
  `position`. There is a single source of truth, the database enforces
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
- No GIN indexes on jsonb yet. 003 adds them together with filtering.

### D5. Tenant transaction seam for RLS

`withTenantTransaction(ctx, fn)` opens a transaction and runs:

```sql
SET LOCAL app.tenant_id = $1
SET LOCAL statement_timeout = $2
```

`$2` defaults to 5 s. Repositories still filter by `tenant_id` explicitly in
every query. In 002, RLS policies such as
`USING (tenant_id = current_setting('app.tenant_id'))` are added under a
non-owner app role. Catalog code does not change, and the existing isolation
tests become RLS tests with no rewrite. The value is always passed as a bind
parameter (`set_config('app.tenant_id', $1, true)`), never interpolated.

### D6. Property schema subset and validation engine

- **Meta-validation** of blueprint definitions uses a strict Zod
  discriminated union on `type` (`.strict()` everywhere, so unknown keywords
  such as `$ref`, `$id`, `$defs`, `if`, and nested object schemas fail with a
  JSON-Pointer path). The same module is exported for 003's form generator.
- **Entity validation** uses Ajv (draft 2020-12) with `strict: true`,
  `allErrors: true`, and `code.regExp` set to an **RE2** adapter over `re2js`,
  a pure-JS linear-time engine that needs no native build. The Ajv schema is
  *derived* from the meta-validated definition, so Ajv never sees user JSON
  directly. Formats come from `ajv-formats`, limited to `date-time`, `email`,
  and `uri` (exposed as `url`). `markdown` and `yaml` are presentation hints
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

- **Upsert** loads the current row `FOR UPDATE`, computes the next spec (a
  pure `applyWrite(current, input, mode)` function), applies defaults, and
  validates. It then compares canonical JSON (sorted keys, relation order
  preserved) of `title`, `icon`, and `spec` to detect `unchanged`, and only
  then writes the row, the edges (delete + insert for changed relations), and
  the change event.
- `generation` increments only when `spec` changes. `version` increments on
  any change.
- **Create** relies on the unique constraint: a `23505` error maps to
  `CATALOG_ALREADY_EXISTS`. There is no read-then-insert race.
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
| `entities.listRelated` | `GET /v1/blueprints/{blueprint}/entities/{entity}/related?direction=forward\|backward` |

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

The error body is `{ code, message, issues? , details? }`. Unknown errors
become a generic `INTERNAL` with no message detail. The original error goes
to the span (`recordException`) and to the `catalog.internal_error` log only.

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

It also writes the capability doc `docs/catalog/catalog-core.md`: the concepts,
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
| `catalog.entity.status.write` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.status.source` | — |
| `catalog.entity.related.list` | op | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.related.direction` | `tayzu.catalog.result.count` |
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
  `internal` errors call `recordException`.
- **Forbidden on any signal**: property values, entity or blueprint titles and
  descriptions, validation messages, and SQL bind values.

### Metrics

| Instrument | Type, unit | Attributes (the complete allowed set) | Purpose |
|---|---|---|---|
| `tayzu.catalog.operation.duration` | Histogram, `s` (buckets 0.005…10) | `tayzu.catalog.operation`, `tayzu.catalog.outcome` (`success`\|`client_error`\|`server_error`), `error.type` (on error), `tayzu.tenant.id` | Latency, throughput, and error rate per operation (RED) |
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

### Log events (OTel Logs API, structured)

| Event name | Severity | Attributes | Purpose |
|---|---|---|---|
| `catalog.audit.mutation` | INFO | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.mutation`, `tayzu.catalog.resource.kind`, `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.resource.identifier`, `tayzu.catalog.version`, `tayzu.catalog.change_event.seq` | Security audit trail shipped to centralized logging, separate from the app database (SEC16 integrity) |
| `catalog.security.context_rejected` | WARN | `tayzu.catalog.operation`, `tayzu.catalog.context.reason` | Detect callers that bypass context wiring |
| `catalog.security.reserved_identifier_denied` | WARN | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.blueprint.identifier` | Detect attempts to tamper with platform blueprints |
| `catalog.internal_error` | ERROR | `tayzu.catalog.operation`, `exception.type`, `exception.message`, `exception.stacktrace` | Diagnose 500s without leaking them to callers |

Every log record carries the active `trace_id` and `span_id`, which the OTel
Logs API does automatically. Every `catalog_change_event` row stores the same
`trace_id`, so an audit entry, its trace, and its database event can be
joined.

## Security considerations (SSA pre-assessment)

A pre-assessment against SSA SEC01-SEC16 was run with the
`vcdm-ssa-validator` agent (`.claude/agents/vcdm-ssa-validator.md`, skill
`.agents/skills/ssa-validator/`). Items that only a human can confirm are
listed in Open Questions. They are not answered here.

| Section | Applies | How this change addresses it |
|---|---|---|
| SEC01 System diagram | Partial | No new network component. The catalog data store is added to the product diagram when the first diagram is drawn (HUMAN). |
| SEC02 Attack surfaces | Partial | **No new attack surface**: the API is not served (D2). The future `/v1` catalog surface is recorded for 002. |
| SEC03 Access control | Yes | Deny by default: no context → `CATALOG_CONTEXT_REQUIRED`. Tenant isolation in three layers (D3–D5). Cross-tenant access returns not found (no existence oracle). Status write is a separate operation so it can be authorized separately. Reserved `_` blueprints. Authorization (Cerbos) is explicitly 002, which is why the API is not exposed. Access control lives in one place, the pipeline (anti-pattern "scattered access control" avoided). |
| SEC05 Crypto | N/A | No cryptography. UUIDv7 IDs are **not** relied on for secrecy (IDOR protection comes from tenant scoping, not unguessable IDs). |
| SEC06 Misuse | Yes | SQL injection: Drizzle parameterized queries only, `sql` template tags with bind parameters, a lint ban on `sql.raw`. ReDoS: RE2-only patterns (D6). SSRF: no `$ref` or remote schemas. DoS: size and count limits before any work, plus `statement_timeout`. Prototype pollution: identifiers must start with a letter (no `__proto__`), and undeclared keys are rejected before merge. AI misuse: `agent` actors take the identical validation path and are treated as untrusted input. Markdown is stored raw; **003 must sanitize on render (XSS)**, which is recorded as a requirement for 003. |
| SEC07 Dependencies | Yes | Lockfile committed, `pnpm audit --prod --audit-level=high` in CI, Dependabot for npm and GitHub Actions. `re2js` chosen over native `re2` (no prebuilt binaries to trust). |
| SEC09 Secrets in code | Yes | `DATABASE_URL` only from the environment. `.env*` git-ignored. `gitleaks` step in CI. The CI Postgres service uses ephemeral credentials that are not secrets. |
| SEC10 Secret management | Partial | No production secrets in 001. The production DB credential and managed identity are defined in 002 or 010 (Key Vault). |
| SEC12 Testing & QA | Yes | Security behaviors are first-class tests: tenant isolation, fail-closed context, reserved identifiers, ReDoS, `$ref`, limits, error sanitization, and telemetry leak. |
| SEC13 Secure deployment | Partial | GitHub Actions (managed). Actions pinned by commit SHA. Minimal `permissions: contents: read`. No deployment in 001. |
| SEC14 Infra permissions | Partial | Migration role vs runtime role separation, and `REVOKE UPDATE, DELETE` on `catalog_change_event` for the runtime role, **land in 002** together with RLS, because they need the app role. Recorded as a 002 requirement. |
| SEC16 Security logging | Yes | Audit and security log events above. They are centralized through OTel, not only in the app database. Retention of at least 12 months is configured with the Azure Monitor workspace (HUMAN, 010). |
| SEC04, SEC08, SEC11, SEC15 | N/A | No passwords (Better Auth, 002), no file upload, no outbound messaging, PaaS only. |

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
- [Freezing the `spec`/`status` contract before 008 has been designed] →
  Status holds only properties now. Adding status relations later is
  additive. Recorded as an open question.
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

## Open Questions

These can safely wait. None of them changes the specs or the task breakdown.

- Will 008 need relations in `status` (observed relations), or will
  integrations write `spec` relations? Adding status relations would be
  additive.
- For the human, from the SSA pre-assessment:
  - Is GitHub secret scanning with push protection enabled on `nahuex/tayzu`?
  - Who owns the product system diagram (SEC01)?
  - Is there a target retention period beyond 12 months for security logs
    (SEC16)?
- Should `list` sort by `updatedAt` as an alternative ordering? That is a
  003 concern, and it is additive.
