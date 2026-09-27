# Proposal: 001-catalog-core

## Why

Every other Tayzu capability depends on the software catalog: the "context
assembly" layer of the ADP. That includes workflows (which are themselves
entities), scorecards, integrations, the MCP server, and AI agents. The
catalog's data model is the most expensive thing to change later. Tenant
scoping, the `spec`/`status` split, and localized blueprint metadata are cheap
to build in now and costly to retrofit once real blueprints and entities
exist. So the catalog core comes first, before auth, UI, or workflows.

## What Changes

- **New `catalog-core` capability**: a tenant-scoped, schema-driven catalog
  built from four concepts.
  - **Blueprint**: a tenant-defined type. It has a stable identifier,
    localized title and description (`en` required, `es` optional), a
    property schema for `spec`, an optional property schema for `status`, and
    relation definitions.
  - **Property**: a typed field declared in a blueprint. It uses a restricted,
    safe JSON Schema subset: string (with formats), number, integer, boolean,
    enum, array of primitives, and shallow object. Remote `$ref` and
    unbounded regex engines are not allowed.
  - **Entity**: an instance of a blueprint. It separates **`spec`** (desired
    state, written by humans and agents) from **`status`** (observed state,
    written by integrations through a separate operation), in the Kubernetes
    style. Entities carry `generation` and `observedGeneration`.
  - **Relation**: a typed, directed link between entities. It is declared on
    the source blueprint, is single or many, and is optional or required.
    Referential integrity holds within one tenant, and relations can be
    traversed forward and backward.
- **Tenant isolation from the first migration.** Every table has `tenant_id`.
  Every operation requires an explicit tenant context and fails closed
  without one. Cross-tenant access looks exactly like "not found".
- **Safe schema evolution.** A blueprint update is accepted only if every
  existing entity stays valid under the new schema. Otherwise it is rejected
  with the offending entities listed. There are no silent data rewrites.
- **Unified, actor-agnostic audit trail.** Every mutation records the acting
  principal (`user`, `agent`, `integration`, or `system`). The same record is
  appended to a transactional change-event log in the same transaction. This
  log is the future source for `event` workflow triggers (004). Humans and
  agents take the exact same code path.
- **Typed API contract.** The API is a set of oRPC procedures with a generated
  OpenAPI 3.1 document that is committed and contract-checked in CI. The
  procedures are **not exposed over the network** in this change. Mounting
  them behind authentication happens in `002-auth-and-rbac`.
- **Observability contract** (spans, metrics, security log events) declared
  in `design.md` and enforced by an automated `otel-smoke-check` test.
- **Minimal workspace foundation** that this capability needs: pnpm +
  Turborepo monorepo, TypeScript, Vitest, Drizzle, a PostgreSQL 16 test
  harness, a CI pipeline (lint, typecheck, test, contract-check,
  otel-smoke-check), and hierarchical `CLAUDE.md` files.

Out of scope, and assigned to later changes: authentication, Cerbos policies,
and Postgres RLS policies (002). Catalog UI, page layouts, and global search
(003). Workflows and the reserved `_workflow` blueprint (004). Scorecards
(007). Integrations and how they map to `status` (008). Mirror, calculation,
and aggregation properties. Deployment to Azure.

## Capabilities

### New Capabilities
- `catalog-core`: blueprints, properties, entities (`spec`/`status`), and
  relations, all tenant-scoped, with safe schema evolution, referential
  integrity, an actor-attributed change log, and a declared telemetry
  contract.

### Modified Capabilities
<!-- None. This is the first capability; openspec/specs/ has no capability specs yet. -->

## Impact

- **New code**: `packages/catalog` (domain, persistence, service, oRPC
  router), `packages/db` (Drizzle config and SQL migrations),
  `packages/observability` (OTel bootstrap and test helpers). There are no
  apps yet.
- **Database**: the first migration creates `catalog_blueprint`,
  `catalog_relation_definition`, `catalog_entity`, `catalog_entity_relation`,
  and `catalog_change_event`. ⛔ **Checkpoint 3 applies.** This migration
  needs its own explicit approval, separate from the PR.
- **API**: a new `openapi/catalog.openapi.json` contract artifact. It is not
  served over the network yet.
- **Dependencies**: `drizzle-orm`, `drizzle-kit`, `pg`, `@orpc/*`, `zod`,
  `ajv` (+ `ajv-formats`), `re2js`, `uuidv7`, `@opentelemetry/*`, `vitest`,
  `turbo`.
- **Downstream contracts this change freezes**: the entity shape (`spec`,
  `status`, `generation`), the tenant context object, the actor model, the
  change-event schema, and the reserved `_` identifier prefix. 002, 003, 004,
  and 008 build directly on these.
- **Security**: pre-assessed against SSA SEC01-SEC16 by the
  `vcdm-ssa-validator` agent. Findings are folded into `design.md` under
  "Security considerations".
