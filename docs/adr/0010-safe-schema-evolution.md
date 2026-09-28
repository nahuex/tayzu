# ADR-0010: Safe schema evolution for blueprints

- **Status**: Accepted
- **Date**: 2026-09-28
- **Change**: [`001-catalog-core`](../../openspec/changes/archive/2026-09-28-001-catalog-core/design.md) (design D7)

## Context

Tenants change blueprint schemas while entities of that blueprint already
exist. A new required property, a removed property, a narrower type or a
retargeted relation can make existing entities invalid. Port does not
document what happens in that case. Tayzu needs a rule that is explicit,
testable, and safe for both humans and agents, who take the same path.

## Decision

1. A blueprint update is accepted **only if every existing entity stays
   valid** under the proposed definition. The check covers spec and
   status properties, spec and status relations, cardinality, and
   requiredness (requiredness applies to spec only).
2. Otherwise the update fails with `CATALOG_SCHEMA_INCOMPATIBLE`, lists up
   to 10 offending entities with their issues, and leaves the blueprint
   unchanged. Data is never rewritten silently.
3. Changing an existing relation's target is rejected while any entity
   holds a value for that relation.
4. **Concurrency**: the update locks the blueprint row `FOR UPDATE`, and
   entity writes lock it `FOR SHARE`. An entity write can therefore never
   commit against a stale schema.
5. The check streams entities in batches of 500 and stops after 10
   violations. Its cost is visible on the
   `catalog.blueprint.compatibility_check` span.
6. Clients can send `expectedVersion`; a stale value fails with
   `CATALOG_VERSION_CONFLICT`.

## Alternatives considered

- **Versioned schemas with lazy migration** (each entity keeps the schema
  version it was written with). Rejected for 001: every reader would have
  to handle N schema versions. It can still be added later behind the
  same spec.
- **Accept the change and flag invalid entities.** Rejected: the catalog
  would then contain data that violates its own schema, which breaks
  scorecards, workflows and agents that trust it.
- **Automatic data migration** (defaults, type coercion). Rejected: it
  rewrites tenant data silently. Explicit migrations can come in a later
  change.

## Consequences

- Schema changes on a populated blueprint may require fixing the data
  first. The error lists exactly which entities to fix.
- The check is O(entities of the blueprint). This is acceptable for
  Phase 1 volumes; if it becomes a problem, it moves to an asynchronous,
  validated migration job.
- Entity writes on a blueprint block while a schema update on that same
  blueprint runs. This is a deliberate choice of correctness over
  availability: schema updates are rare and done by admins.
