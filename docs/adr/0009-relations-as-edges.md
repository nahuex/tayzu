# ADR-0009: Entity relations stored as edges, not inside the entity document

- **Status**: Accepted
- **Date**: 2026-09-28
- **Change**: [`001-catalog-core`](../../openspec/changes/001-catalog-core/design.md) (design D4)

## Context

An entity's relations (`spec.relations` and, since R4, `status.relations`)
point to other entities in the same tenant. They could be stored as a JSON
map inside the entity row, the way the API returns them, or as rows in a
separate table.

The catalog must guarantee referential integrity. A relation never points
to a missing entity or to another tenant's entity. Deleting a referenced
entity is rejected unless the reference is optional and detached. Backward
traversal ("which entities point to this one?") is a core UI and API
operation.

## Decision

1. Relations are stored **only** as rows in `catalog_entity_relation`,
   one row per edge:
   `(tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)`.
   `scope` is `spec` (desired) or `status` (observed), and `position`
   keeps the order of a `many` relation as written.
2. `spec.relations` and `status.relations` in API responses are assembled
   from the edges. They are never stored in the entity's JSON columns, so
   there is a single source of truth.
3. Every foreign key includes `tenant_id`. `source` is `ON DELETE CASCADE`,
   while `target` and `relation_definition` are `ON DELETE RESTRICT`.
4. An index on `(tenant_id, target_entity_id)` serves backward traversal.

## Alternatives considered

- **Relations as `jsonb` inside the entity, validated by the
  application.** Rejected. A delete racing a write can leave dangling
  references (a time-of-check to time-of-use gap). Backward traversal
  needs a scan or a GIN index over every entity. And only application
  code protects tenant isolation.
- **Both: `jsonb` for reads plus edges for integrity.** Rejected. Two
  copies of the same data drift, and every write pays twice.

## Consequences

- The database enforces referential integrity and tenant isolation of
  relations, even if a service bug slips through (defense in depth, SEC03).
  `RESTRICT` gives "cannot delete a referenced entity" with no race window.
- Reading an entity costs one extra indexed query to assemble its
  relations.
- Writing a relation replaces that relation's edges inside the entity's
  transaction.
- Observed relations reuse the same table and definitions, so integrations
  (`004`) only add writers, not a new model.
