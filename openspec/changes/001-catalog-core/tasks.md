# Tasks: 001-catalog-core

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
   number (for example `feat(catalog): 4.3 relation value validation`).

Scenario names in quotes refer to `specs/catalog-core/spec.md`. Test files
live next to the code as `*.test.ts`. Integration tests are named
`*.int.test.ts` and need `DATABASE_URL`.

## 1. Workspace foundation

- [ ] 1.1 *(setup)* Create the root workspace:
  - `package.json` (private, `packageManager: pnpm@10`, scripts `build`,
    `test`, `lint`, `lint:md` (markdownlint-cli2), `typecheck`,
    `contract:generate`, `contract:check`,
    `otel-smoke-check`, `db:migrate`, `ci:local`), `pnpm-workspace.yaml`,
    `turbo.json`, and `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
    ESM, Node 22).
  - `eslint.config.js` (typescript-eslint `strictTypeChecked`, ban on
    `sql.raw`, ban on `actor.type ===` outside the allowlisted files per
    design D3), `.prettierrc`, `vitest.config.ts` with projects, and a
    `.gitignore` that covers `.env*`.
  - Verify: `pnpm install && pnpm lint && pnpm typecheck` succeed on the
    empty packages.
- [ ] 1.2 *(setup)* Scaffold empty `packages/observability`, `packages/db` and
  `packages/catalog` (each with `package.json`, `tsconfig.json`, `src/index.ts`)
  plus a trivial `smoke.test.ts` each. Verify: `pnpm test` runs 3 passing
  smoke tests through Turborepo.
- [ ] 1.3 *(setup)* Write a root `CLAUDE.md` (global conventions: English-only
  artifacts, TDD cycle, Checkpoints 1-3, no network exposure before 002) and
  one `CLAUDE.md` per package with its local conventions. Verify: the files
  exist, and the root one is under 150 lines (stable and cacheable).
- [ ] 1.4 Telemetry test harness in `@tayzu/observability`:
  `createTelemetryTestHarness()` returns in-memory span, metric and log
  exporters registered on global providers, with `reset()` and `shutdown()`.
  Verify: `harness.test.ts` emits a span, a counter and a log record through
  the OTel **API** and asserts all three are captured.
- [ ] 1.5 Postgres harness in `@tayzu/db`:
  - `createPool(url)` and `runMigrations(pool)`.
  - A test helper `getTestDatabase()` that applies migrations once per run
    and throws an explicit error when `DATABASE_URL` is unset. Outside the test
    harness, `createPool` refuses a connection string without
    `sslmode=verify-full`.
  - Verify: `harness.int.test.ts` runs `select 1`, and `harness.test.ts`
    asserts the explicit error message when the URL is missing, and that a
    non-TLS URL is refused outside test mode.
- [ ] 1.6 *(setup)* Add the SessionStart hook `.claude/hooks/session-start.sh`
  and register it in `.claude/settings.json`. The hook starts the local
  PostgreSQL 16 cluster in the cloud sandbox, creates the `tayzu_test`
  database and exports `DATABASE_URL`, and it is idempotent. Verify: running
  the script twice leaves `pg_isready` succeeding and
  `pnpm --filter @tayzu/db test` green.
- [ ] 1.7 *(setup)* Add `.github/workflows/ci.yml` with these jobs:
  - install
  - lint + typecheck
  - test, with a `postgres:16` service
  - `contract:check`
  - `otel-smoke-check`
  - `pnpm audit --prod --audit-level=high`
  - gitleaks

  The workflow sets `permissions: contents: read` and pins actions by SHA.
  Also add `.github/dependabot.yml` (npm + github-actions, weekly) and
  `docs/security/dependencies.md` (critical fixes within 7 days, high within
  30 days, quarterly EOL review). Verify:
  `pnpm ci:local` runs the same steps locally and succeeds, and the workflow
  passes on the PR.

- [ ] 1.8 *(setup)* Create `docs/architecture/system-diagram.md` as a Mermaid
  flowchart. It shows the product boundary, the current components
  (`@tayzu/catalog`, `@tayzu/db`, PostgreSQL, the CI pipeline), the planned
  ones as dashed nodes (API server, workers, Redis, Azure Monitor, Key
  Vault), and every actor type (user, agent, integration, system, developer,
  CI), with arrows from initiator to target labeled with their protocol.
  Verify: markdownlint passes, the Mermaid block renders with
  `npx -y @mermaid-js/mermaid-cli -i docs/architecture/system-diagram.md -o /tmp/d.svg`,
  and every attack-surface name used in the design appears in the diagram.

## 2. Domain primitives (pure, `@tayzu/catalog/src/domain`)

- [ ] 2.1 `CatalogError` with the stable codes, `issues` (JSON Pointer paths)
  and `details`, plus the `isCatalogError` guard. Verify: `errors.test.ts`
  checks that each code is constructible, that `issues` is preserved, and
  that the code list matches the spec's Conventions list exactly.
- [ ] 2.2 `parseCatalogContext` fails closed, enforcing the `tenantId`
  pattern, the opaque `actor.id` pattern and the optional `onBehalfOf`.
  Verify: `context.test.ts` covers "Operation without tenant context is
  rejected", "Unknown actor type is rejected" and "Malformed tenant or actor
  ID is rejected", plus an empty `actor.id`, a 65-character `tenantId` and an
  invalid `onBehalfOf`. It also asserts the rejection reason
  (`missing_tenant` or `invalid_actor`).
- [ ] 2.3 Identifier validators (blueprint, property and relation
  identifiers, and entity identifiers). Verify: `identifiers.test.ts`
  covers "Invalid identifier", the boundary lengths (64 and 256), and the
  rejection of `__proto__`, spaces, and a leading digit. It also checks
  that an entity identifier accepts `org/repo` and rejects `a/../b`, `./a`,
  `/a`, `a/` and `a//b`.
- [ ] 2.4 `LocalizedText` schema. Verify: `localized-text.test.ts` covers
  "Missing English title is rejected" and "Unsupported locale is
  rejected", and checks the per-locale length limits (256 for titles,
  4096 for descriptions).
- [ ] 2.5 `CatalogLimits` with every spec default (including the blueprint
  size, `enum` entries, nesting depth, icon, formatted-string, detach and
  cursor limits) and a validated overrides
  merge. Verify: `limits.test.ts` asserts every default from the spec
  table and that an invalid override (for example a negative value) is
  rejected.

- [ ] 2.6 Safe input parsing. Rebuild all input objects as null-prototype
  objects and reject `__proto__`, `constructor` and `prototype` at every
  depth, including locale keys and keys inside `object` values. Enforce the
  nesting-depth limit. Verify: `safe-parse.test.ts` covers "Unsafe keys are
  rejected", checks that `Object.prototype` is untouched after parsing a
  malicious payload, and rejects depth 17.

## 3. Blueprint definition meta-validation (pure)

- [ ] 3.1 Property definition subset for every allowed type, format and
  keyword (Zod, `.strict()`). Verify: `property-schema.test.ts` covers
  "Supported property types are accepted", with one case per type and
  format.
- [ ] 3.2 Reject disallowed constructs: `$ref`, `$id`, `$defs`,
  `if`/`then`/`else`, nested object schemas, and unknown formats and
  keywords, each reported with its JSON-Pointer path. Verify:
  `property-schema.test.ts` covers "Remote reference is rejected", and a
  spy asserts that no network or `fetch` call is made.
- [ ] 3.3 RE2 pattern validation through `re2js`, with a maximum of 512
  characters. Verify: `pattern.test.ts` covers "Catastrophic-backtracking
  pattern is rejected", backreference and lookaround rejection, a
  513-character pattern, and a valid pattern that is accepted.
- [ ] 3.4 Cross-field rules. A `default` must be valid against its own
  definition. `required` may only name declared properties. Identifiers must
  be unique across `schema`, `statusSchema` and `relations`. Verify:
  `blueprint-definition.test.ts` covers "Invalid default is rejected",
  "Required names an undeclared property", and the collision cases.
- [ ] 3.5 Relation definition shape, including defaults for `many` and
  `required`. Verify: `relation-definition.test.ts` covers "Required many
  relation is rejected" and checks that the defaults are applied.
- [ ] 3.6 The reserved `_` prefix rule as a pure function of the blueprint
  identifier, the operation (blueprint write or entity write) and the actor.
  Verify: `reserved.test.ts` rejects the `user`, `agent` and `integration`
  actors for both blueprint and entity writes, allows `system`, and always
  allows reads.
- [ ] 3.7 Blueprint-level count limits (properties and relations). Verify:
  `blueprint-definition.test.ts` accepts 200 properties, rejects 201 with
  `CATALOG_LIMIT_EXCEEDED`, and applies the same bounds to relations
  (50 and 51).
- [ ] 3.8 Write ADR `docs/adr/0008-catalog-property-schema-subset.md`
  (design D6). Verify: the ADR exists with Context, Decision, Alternatives
  and Consequences sections, and the design D6 links to it.

## 4. Entity validation and write semantics (pure)

- [ ] 4.1 Derive an Ajv schema from a validated blueprint definition, with
  `additionalProperties: false`, the RE2 `regExp` adapter and restricted
  formats. Verify: `entity-validator.test.ts` covers "Spec violating the
  schema is rejected" and "Undeclared property is rejected", with the exact
  paths `/spec/properties/<name>`. It also covers "Non-HTTP URL value is
  rejected" (`javascript:`, `data:`, `ftp:`) and the 2048-character cap on
  formatted strings, which is checked before the format itself (ajv-formats
  in `fast` mode).
- [ ] 4.2 Apply defaults on write. Verify: `entity-validator.test.ts`
  covers "Default is applied" and checks that an explicitly given value
  wins over the default.
- [ ] 4.3 Relation value shape validation: cardinality, the required
  relation, undeclared keys, uniqueness within `many`, and a maximum of 1000
  targets. The validator is parameterized by scope: `required` is enforced
  for `spec` and ignored for `status`. Verify: `relation-values.test.ts` covers "Missing required
  relation", "Wrong cardinality" and "Too many relation targets" (the pure
  part), and rejects duplicate targets.
- [ ] 4.4 `applyWrite(current, input, mode)` for the `replace` and `merge`
  modes, where `null` removes a key. Verify: `apply-write.test.ts` covers
  "Merge keeps unspecified keys" and "Merge with null removes a value", and
  checks that `replace` drops keys that are not given.
- [ ] 4.5 Canonical equality (sorted keys, relation order preserved) for
  detecting `unchanged` writes. Verify: `canonical.test.ts` treats key order
  as irrelevant and `many` relation order as significant.
- [ ] 4.6 Size limits evaluated before validation or compilation. Verify:
  `limits.test.ts` covers "Oversized spec is rejected", and a spy shows the
  compiler is not invoked.
- [ ] 4.7 Pure compatibility checker `checkCompatibility(newDefinition,
  entitiesAsyncIterable)` that stops after 10 violations. Verify:
  `compatibility.test.ts` covers the three compatibility scenarios from the
  spec at the pure level, and checks the early exit with 15 bad entities
  (10 reported, iteration stopped).
- [ ] 4.8 Validator LRU cache keyed by `(tenantId, blueprintId, version)`,
  with hit and miss callbacks. Verify: `validator-cache.test.ts` shows that
  a second lookup is a hit, a version bump is a miss, and eviction happens
  at 500 entries.

## 5. Persistence (`@tayzu/catalog/src/persistence`, `@tayzu/db`), ⛔ Checkpoint 3

- [ ] 5.1 Drizzle table definitions for the 6 tables in design D4, including
  composite tenant FKs, the `scope` column on the edge table (with its check
  and its place in the PK), the `CHECK (NOT (many AND required))` constraint and
  the indexes. Generate `0000_catalog_core.sql` (and its down script) with
  `drizzle-kit generate`. Verify: `schema.int.test.ts` applies the migration
  to an empty database and asserts through `information_schema`/`pg_catalog`
  that the tables, unique constraints, FKs (with their `ON DELETE` actions)
  the check constraint, and the append-only trigger on
  `catalog_change_event` exist. **Stop for Checkpoint 3 approval of the SQL
  before continuing.**
- [ ] 5.2 `withTenantTransaction(ctx, fn)` sets `app.tenant_id` through
  `set_config($1, true)` and sets `statement_timeout`. Verify:
  `tenant-tx.int.test.ts` shows that `current_setting('app.tenant_id')`
  inside the transaction equals the tenant, that it is unset after commit,
  and that a quote-containing tenant ID is stored literally (no injection).
- [ ] 5.3 Database-level isolation guard. Verify: `db-isolation.int.test.ts`
  runs a raw insert of a `catalog_entity_relation` edge whose target belongs
  to another tenant and shows it fails with an FK violation, which is
  defense in depth independent of the service layer.
- [ ] 5.4 Change-event appender with a per-tenant gap-free `seq`. Verify:
  `change-events.int.test.ts` shows that the sequence increments per tenant
  independently, that a rolled-back transaction leaves no event and no sequence
  gap, and it covers "Change events cannot be altered" (raw `UPDATE`,
  `DELETE` and `TRUNCATE` all raise).
- [ ] 5.5 Write ADR `docs/adr/0009-relations-as-edges.md` (design D4).
  Verify: the file exists and is linked from design D4.

## 6. Operation pipeline and telemetry primitives (`@tayzu/catalog/src/service`, `src/telemetry`)

- [ ] 6.1 `telemetry/contract.ts` mirrors the design's Observability contract
  (span names, metric names and units, allowed attribute keys, log event
  names). Verify: `contract.test.ts` snapshot-asserts every name in the
  design tables, and the `observability-auditor` review compares the two.
- [ ] 6.2 `defineCatalogOperation`: context validation, operation span with
  the common attributes, the `operation.duration` histogram with an outcome
  class, and error mapping in which an unknown error becomes `INTERNAL` with a
  **sanitized** exception (type, SQLSTATE and constraint only, and the
  stack without its message line), while a `CATALOG_*` error gets no
  exception event. On
  context failure it also records `context.rejections` and the
  `catalog.security.context_rejected` log. Verify: `pipeline.int.test.ts`
  uses a dummy operation and the telemetry harness.
- [ ] 6.3 The pipeline emits `catalog.audit.mutation` for successful
  mutations, and a `trace_id` is stored on the change event. Verify:
  `pipeline.int.test.ts` shows that the log record, the span and the event
  row share the same trace ID.

## 7. Blueprint operations (integration, real Postgres)

- [ ] 7.1 `blueprints.create`, with attribution, `version` 1, a UTC
  timestamp and a change event. Verify: `blueprints.int.test.ts` covers
  "Create a blueprint with localized title", "Duplicate blueprint
  identifier", "Relation to an existing blueprint", "Self relation" and
  "Relation to a missing blueprint", and checks the span, the
  `blueprint.mutations` counter and "Timestamps are returned in UTC".
- [ ] 7.2 Reserved identifiers through the service. Verify:
  `blueprints.int.test.ts` covers "Tenant cannot create a reserved
  blueprint" (and the WARN log) and "System actor can create a reserved
  blueprint".
- [ ] 7.3 `blueprints.get` and `blueprints.list` with keyset pagination and
  opaque cursors. Verify: `blueprints.int.test.ts` covers "List blueprints
  with pagination", checks that a malformed cursor fails with
  `CATALOG_VALIDATION_FAILED`, and checks the page size limit of 500.
- [ ] 7.4 `blueprints.update` with the D7 compatibility check (`FOR UPDATE`,
  batched streaming), the relation-target-change rule, and `expectedVersion`.
  Verify: `blueprints-update.int.test.ts` covers "Adding an optional property
  is compatible", "Adding a required property without values is
  incompatible", "Removing a property that has values is incompatible" and
  "Stale expected version", and checks the `compatibility_check` span
  attributes.
- [ ] 7.5 `blueprints.delete`. Verify: `blueprints.int.test.ts` covers
  "Blueprint with entities cannot be deleted", "Relation target blueprint
  cannot be deleted" and "Unused blueprint is deleted".
- [ ] 7.6 Blueprint tenant isolation. Verify: `isolation.int.test.ts` covers
  "Same identifiers coexist across tenants", and checks that `get`,
  `update` and `delete` of another tenant's blueprint return
  `CATALOG_NOT_FOUND`.
- [ ] 7.7 Write ADR `docs/adr/0010-safe-schema-evolution.md` (design D7).
  Verify: the file exists and is linked from design D7.

## 8. Entity operations (integration, real Postgres)

- [ ] 8.1 `entities.create`, with validation, defaults, `generation` and
  `version` 1, `status` null, and a change event. Verify:
  `entities.int.test.ts` covers "Create an entity", "Entity of a missing
  blueprint" and "Create on existing identifier" (a unique violation mapped
  to `CATALOG_ALREADY_EXISTS` by constraint name). It also covers
  "Tenant cannot write entities of a reserved blueprint", and checks that a
  forced FK violation (`23503`) on a known constraint maps to
  `CATALOG_REFERENCE_VIOLATION` while an unknown constraint maps to
  `INTERNAL`.
- [ ] 8.2 Relation resolution and referential integrity on write, with the
  `catalog.relations.resolve` span. Verify: `entity-relations.int.test.ts`
  covers "Valid single relation", "Missing relation target" and "Many
  relation keeps order".
- [ ] 8.3 `entities.upsert` in both modes, `unchanged` detection,
  `expectedVersion`, and the rule that status is never touched. Verify:
  `entities-upsert.int.test.ts` covers "Upsert creates then replaces",
  "Idempotent upsert is unchanged" (no event, no version bump) and "Spec
  changes do not touch status", and checks the `entity.mutations` counter.
- [ ] 8.4 `entities.writeStatus` with properties and relations, replacing the
  whole snapshot. Verify: `entity-status.int.test.ts` covers "Integration
  reports status", "Integration reports observed relations", "Observed
  relation to a missing target is rejected", "Status write replaces the
  snapshot" and "Observed generation from the future is rejected", checks that a
  blueprint without a `statusSchema` rejects a non-empty status, and checks
  that a `source` of `Git Hub!` is rejected.
- [ ] 8.5 `entities.get` and `entities.list` with keyset pagination. Verify:
  `entities.int.test.ts` covers pagination, and checks that the list never
  includes entities of another blueprint.
- [ ] 8.6 `entities.delete` with `detachReferences`. Verify:
  `entities-delete.int.test.ts` covers "Delete an unreferenced entity",
  "Delete a referenced entity is rejected by default", "Detach optional
  references on delete", "Required references block detach" "Detach on
  delete records every affected entity", "Observed references never block
  delete", and the 1000-referrer limit
  (`CATALOG_LIMIT_EXCEEDED`).
- [ ] 8.7 `entities.listRelated` in the forward and backward directions,
  with the `scope` filter and pagination. Verify: `entity-related.int.test.ts`
  covers "Forward and backward relations" and "Traversal distinguishes
  desired and observed".
- [ ] 8.8 Entity tenant isolation. Verify: `isolation.int.test.ts` covers
  "Cross-tenant read looks like not found", "Cross-tenant relation target
  is rejected" and "Listing never leaks other tenants' data".
- [ ] 8.9 Concurrency: an entity write racing a blueprint update (two
  connections) must commit against the new schema or be rejected, and must
  never persist an invalid entity. Verify: `concurrency.int.test.ts`, run
  deterministically with explicit lock ordering using a barrier.
- [ ] 8.10 Actor parity and the audit trail. Verify: `actor-parity.int.test.ts`
  covers "Agent and human writes are attributed identically", "Every
  mutation behaves the same for every actor type" (the full matrix),
  "Delegated agent write records the principal" (in `updatedBy`, the change
  event and the audit log) and "Failed mutation appends nothing".

## 9. API contract (`@tayzu/catalog/src/api`)

- [ ] 9.1 oRPC contract with Zod input and output for all 12 procedures, the
  routes from design D11 (percent-encoded entity identifiers), and a router
  bound to the services. Verify: `router.int.test.ts` calls every procedure
  once on the happy path through `createRouterClient`, checks that an
  identifier containing `/` round-trips, and checks that the three
  high-risk procedures carry `x-tayzu-risk: high`.
- [ ] 9.2 Error mapping to HTTP status codes, and sanitization of internal
  errors. Verify: `errors.int.test.ts` covers "Internal errors are not
  leaked", using a simulated database failure (no SQL or stack trace in the
  body, while the span holds the exception), and checks each code-to-status
  mapping in design D11.
- [ ] 9.3 `contract:generate` and `contract:check` scripts, with the
  committed `openapi/catalog.openapi.json`. Verify: `contract-check.test.ts`
  covers "Contract drift fails CI" by mutating a copy of an input schema and
  asserting the check exits non-zero, covers "Contract cannot carry the tenant", and the committed document
  passes.
- [ ] 9.4 Write ADR `docs/adr/0011-api-not-exposed-before-auth.md` (design
  D2) and the API section of `docs/catalog/catalog-core.md` (routes, error
  codes, examples). Verify: the docs build is not configured yet, so run
  `pnpm lint:md` (markdownlint) over `docs/`.

## 10. Telemetry contract enforcement

- [ ] 10.1 `otel-smoke-check`. It runs every operation once successfully and
  once per applicable error class, and asserts that every declared span,
  metric and log event appears with its required attributes. This covers
  "Declared telemetry is emitted". Verify: `pnpm otel-smoke-check` is green,
  and removing one span in a scratch branch makes it fail.
- [ ] 10.2 Cardinality guard: the catalog metrics carry **no** attribute key
  outside the allowed set in the contract. Verify: `otel-smoke-check`
  includes the guard, and a deliberately added `tayzu.catalog.entity.identifier`
  metric attribute makes it fail.
- [ ] 10.3 Marker-leak test. Verify: `otel-smoke-check` covers "Property
  values never reach telemetry" across spans (including `pg` spans),
  metrics and logs, including after a forced database constraint error.
- [ ] 10.4 Document the telemetry reference in `docs/catalog/catalog-core.md`
  (signals, attributes, and example queries against the Application Insights
  schema). Verify: markdownlint passes, and every name in the doc exists in
  `contract.ts` (checked by `contract.test.ts`).

## 11. Integration checks before the PR (Checkpoint 2 readiness)

- [ ] 11.1 `pnpm ci:local` is fully green (lint, typecheck, unit and
  integration tests, contract-check, otel-smoke-check, audit, gitleaks).
  Verify: attach the command output to the PR description.
- [ ] 11.2 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against
  the implemented code, and resolve or explicitly defer every blocking GAP.
  Verify: the report is attached to the PR, with zero open blocking GAPs.
- [ ] 11.3 Run `/security-review` on the branch and fix or justify every
  finding, then update `docs/architecture/system-diagram.md` if the
  implementation changed any component or arrow. Verify: the review output
  and the diagram diff are attached to the PR.
- [ ] 11.4 `openspec validate 001-catalog-core --strict` passes, and the
  design, spec and code agree (update the design only if an implementation
  finding forced a change, and note it in the PR). Verify: the command
  output is attached to the PR.
