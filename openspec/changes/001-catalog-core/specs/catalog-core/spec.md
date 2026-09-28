# Spec Delta: catalog-core

## Purpose

The catalog core is Tayzu's tenant-scoped, schema-driven software catalog.
Tenants define **blueprints** (types with typed **properties** and **relations**),
and humans, AI agents, and integrations create **entities** of those types. Each
entity keeps its desired state (`spec`) separate from its observed state
(`status`). It is the context-assembly layer every later capability builds on.

## Conventions

- Key words: MUST, MUST NOT, SHALL, SHOULD, SHOULD NOT and MAY are to be
  interpreted as described in RFC 2119. Each requirement's normative core is
  stated with MUST or SHALL. SHOULD and MAY clauses inside a requirement qualify
  it. They are recommendations or permitted latitude, and tests MUST NOT assert
  against behavior a MAY clause permits.
- **Catalog context**: every operation runs with a catalog context
  `{ tenantId, actor: { type, id, onBehalfOf? } }`.
  - `tenantId` matches `^[A-Za-z0-9_-]{1,64}$`.
  - `actor.type` is one of `user`, `agent`, `integration`, `system`.
  - `actor.id` is an opaque identifier matching `^[A-Za-z0-9_.:-]{1,128}$`.
    It is never an email or display name.
  - The optional `actor.onBehalfOf` `{ type, id }` follows the same rules and
    names the principal an `agent` or `integration` acts for.
  - The context MUST be supplied only by the trusted host, meaning an
    in-process caller or, from 002, the authentication middleware. No
    procedure input, path, query or body MAY carry `tenantId` or `actor`.
    The `system` actor type MUST NOT be derivable from any external
    credential.
- **Unsafe keys**: the keys `__proto__`, `constructor` and `prototype` are
  rejected with `CATALOG_VALIDATION_FAILED` in every key position of catalog
  input. This includes identifiers, property and relation keys, locale keys,
  and keys nested inside `object`-typed values.
- **Error codes**: operations fail with one of the stable codes
  `CATALOG_CONTEXT_REQUIRED`, `CATALOG_VALIDATION_FAILED`, `CATALOG_NOT_FOUND`,
  `CATALOG_ALREADY_EXISTS`, `CATALOG_VERSION_CONFLICT`,
  `CATALOG_REFERENCE_VIOLATION`, `CATALOG_SCHEMA_INCOMPATIBLE`,
  `CATALOG_RESERVED_IDENTIFIER`, `CATALOG_LIMIT_EXCEEDED`. Validation errors carry
  a list of `{ path, message }` issues, where `path` is a JSON Pointer.
- **Default limits** (configurable per deployment):

  | Limit | Default |
  |---|---|
  | Property and relation identifier | `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
  | Blueprint identifier | `^_?[A-Za-z][A-Za-z0-9_-]{0,63}$` (a leading `_` marks a reserved system blueprint) |
  | Entity identifier | `^[A-Za-z0-9@_.:/=-]{1,256}$`, with no `.` or `..` path segment and no leading, trailing or repeated `/` |
  | Localized text, per locale | 256 characters (titles), 4096 (descriptions) |
  | Properties per blueprint (spec + status) | 200 |
  | Relation definitions per blueprint | 50 |
  | Targets per `many` relation on one entity | 1000 |
  | Serialized `spec` or `status` of one entity | 256 KiB |
  | `pattern` keyword length | 512 characters |
  | List page size | default 50, max 500 |
| Serialized blueprint definition | 256 KiB |
| `enum` entries per property | 500 |
| Nesting depth of `object` values | 16 |
| Blueprint and entity `icon` | 64 characters |
| String values with a `format` | 2048 characters |
| Status `source` label | property and relation identifier pattern |
| Referrers detached by one delete | 1000 |
| Pagination cursor | 512 characters |

## ADDED Requirements

### Requirement: Tenant context is mandatory and fails closed
Every catalog operation MUST require a catalog context that satisfies the
Conventions rules (`tenantId` pattern, allowed actor type, opaque actor ID, and
the same rules for an optional `onBehalfOf`). An operation invoked without a valid
context MUST fail with `CATALOG_CONTEXT_REQUIRED`. It MUST NOT read or write any
data and MUST NOT fall back to a default tenant.

#### Scenario: Operation without tenant context is rejected
- **GIVEN** a catalog containing blueprints for tenant `t1`
- **WHEN** any catalog operation is invoked with no `tenantId`
- **THEN** it fails with `CATALOG_CONTEXT_REQUIRED`
- **AND** no data is read or written

#### Scenario: Unknown actor type is rejected
- **WHEN** an operation is invoked with actor `{ type: "robot", id: "x" }`
- **THEN** it fails with `CATALOG_CONTEXT_REQUIRED`

#### Scenario: Malformed tenant or actor ID is rejected
- **WHEN** an operation is invoked with `tenantId` `x'; --` or with actor ID `alice@example.com`
- **THEN** it fails with `CATALOG_CONTEXT_REQUIRED`

### Requirement: Tenant data isolation
All catalog data MUST be owned by exactly one tenant. An operation MUST only
read, write, or reference data owned by the context's tenant. Data owned by
another tenant MUST be indistinguishable from data that does not exist. Such
operations fail with `CATALOG_NOT_FOUND` (or `CATALOG_REFERENCE_VIOLATION` for
relation targets), never with an authorization-style error that would reveal
that the resource exists. Identifiers MUST be unique per tenant, not globally.

#### Scenario: Same identifiers coexist across tenants
- **GIVEN** tenant `t1` has a blueprint `service`
- **WHEN** tenant `t2` creates a blueprint `service`
- **THEN** the creation succeeds
- **AND** each tenant sees only its own `service` blueprint

#### Scenario: Cross-tenant read looks like not found
- **GIVEN** tenant `t1` has entity `payments` of blueprint `service`
- **WHEN** tenant `t2` gets entity `payments` of blueprint `service`
- **THEN** it fails with `CATALOG_NOT_FOUND`

#### Scenario: Cross-tenant relation target is rejected
- **GIVEN** tenant `t1` has entity `team-a` of blueprint `team`
- **AND** tenant `t2` has blueprint `service` with relation `owner` targeting its own blueprint `team`
- **WHEN** tenant `t2` creates a `service` entity with relation `owner` = `team-a`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`

#### Scenario: Listing never leaks other tenants' data
- **GIVEN** tenants `t1` and `t2` each have 3 entities of blueprint `service`
- **WHEN** tenant `t1` lists entities of `service`
- **THEN** exactly its own 3 entities are returned

### Requirement: Blueprint definition
The system MUST allow a tenant to create a blueprint with the following fields.
- `identifier`: required, matching the blueprint identifier pattern, and
  immutable after creation.
- `title`: a required localized text.
- `description`: an optional localized text.
- `icon`: an optional string of at most 64 characters.
- `schema`: the spec property schema, `{ properties, required }`.
- `statusSchema`: an optional status property schema with the same shape.
- `relations`: relation definitions keyed by relation identifier.

A localized text MUST be an object keyed by supported locale (`en`, `es`) with
`en` required. Unknown locale keys MUST be rejected with
`CATALOG_VALIDATION_FAILED`. Creating a blueprint whose identifier already exists
in the tenant MUST fail with `CATALOG_ALREADY_EXISTS`. A created blueprint MUST
report `version` = 1 and UTC `createdAt`/`updatedAt` timestamps (ISO 8601 with
`Z`), plus `createdBy`/`updatedBy` actors. The system MAY accept additional
supported locales once they are configured, but it MUST NOT make any locale
other than `en` required.

#### Scenario: Create a blueprint with localized title
- **WHEN** tenant `t1` creates blueprint `service` with title `{ "en": "Service", "es": "Servicio" }` and a property `language` of type string
- **THEN** the blueprint is returned with `version` 1, the given title, and `createdBy` equal to the context actor

#### Scenario: Missing English title is rejected
- **WHEN** a blueprint is created with title `{ "es": "Servicio" }`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at path `/title/en`

#### Scenario: Unsupported locale is rejected
- **WHEN** a blueprint is created with title `{ "en": "Service", "xx": "?" }`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at path `/title/xx`

#### Scenario: Duplicate blueprint identifier
- **GIVEN** tenant `t1` has blueprint `service`
- **WHEN** tenant `t1` creates blueprint `service` again
- **THEN** it fails with `CATALOG_ALREADY_EXISTS`

#### Scenario: Invalid identifier
- **WHEN** a blueprint is created with identifier `1service` or `service name`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at path `/identifier`

### Requirement: Reserved system identifiers
Blueprint identifiers starting with `_` are reserved for platform-defined
blueprints, such as the future `_workflow`. Create, update, and delete requests
from any actor other than `system` for a blueprint whose identifier starts with
`_` MUST fail with `CATALOG_RESERVED_IDENTIFIER`. Entity create, upsert, status
write and delete on such a blueprint MUST also fail with
`CATALOG_RESERVED_IDENTIFIER` for non-`system` actors, until the change that
owns that blueprint defines its write path. Reading reserved blueprints
and their entities MUST follow the same rules as any other blueprint.

#### Scenario: Tenant cannot create a reserved blueprint
- **WHEN** an actor of type `user` creates blueprint `_workflow`
- **THEN** it fails with `CATALOG_RESERVED_IDENTIFIER`

#### Scenario: Tenant cannot write entities of a reserved blueprint
- **GIVEN** a `system` actor created blueprint `_workflow` for tenant `t1`
- **WHEN** an actor of type `agent` upserts an entity of `_workflow`
- **THEN** it fails with `CATALOG_RESERVED_IDENTIFIER`

#### Scenario: System actor can create a reserved blueprint
- **WHEN** an actor of type `system` creates blueprint `_workflow` for tenant `t1`
- **THEN** the creation succeeds

### Requirement: Property types
A blueprint property definition MUST be a restricted JSON Schema fragment with a
required `title` (localized text) and one of the following types.
- `string`, optionally with a `format` of `date-time`, `url`, `email`,
  `markdown`, or `yaml`, and the keywords `minLength`, `maxLength`, `pattern`,
  `enum`, `default`.
- `number` or `integer`, with `minimum`, `maximum`, `enum`, `default`.
- `boolean`, with `default`.
- `array`, whose `items` is a string, number, integer, or boolean definition,
  with `minItems`, `maxItems`, `uniqueItems`.
- `object`, a free-form JSON object. Its keys and values are not validated
  beyond the size limit.

Values of format `url` MUST be absolute URLs with the `http` or `https`
scheme. Definitions using any other type, format, or keyword MUST be rejected with
`CATALOG_VALIDATION_FAILED`. This explicitly includes `$ref`, `$id`, `$defs`,
`if`/`then`/`else`, and nested object schemas. A `pattern` MUST be validated at
definition time as a linear-time (RE2-compatible) regular expression of at most
512 characters. Patterns using backreferences or lookaround MUST be rejected. A
`default` MUST itself be valid against its property definition. Every name in
`required` MUST be a declared property. Property identifiers MUST be unique
across `schema` and `statusSchema` of the same blueprint.

#### Scenario: Unsafe keys are rejected
- **WHEN** a blueprint title uses locale key `__proto__`, or an entity is written with `spec.properties` containing `constructor`, or an `object` value contains a nested `__proto__` key
- **THEN** each write fails with `CATALOG_VALIDATION_FAILED`

#### Scenario: Supported property types are accepted
- **WHEN** a blueprint declares properties of type string (format `url`), integer (minimum 0), boolean, array of strings, and object
- **THEN** the blueprint is created

#### Scenario: Remote reference is rejected
- **WHEN** a property definition contains `"$ref": "https://example.com/schema.json"`
- **THEN** the blueprint is rejected with `CATALOG_VALIDATION_FAILED`
- **AND** no network request is made

#### Scenario: Catastrophic-backtracking pattern is rejected
- **WHEN** a string property declares `"pattern": "(a+)+\\1"`
- **THEN** the blueprint is rejected with `CATALOG_VALIDATION_FAILED` with an issue at that property's `/pattern`

#### Scenario: Non-HTTP URL value is rejected
- **GIVEN** property `docs` of type string with format `url`
- **WHEN** an entity is written with `docs` = `"javascript:alert(1)"`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at `/spec/properties/docs`

#### Scenario: Invalid default is rejected
- **WHEN** an integer property declares `"minimum": 1, "default": 0`
- **THEN** the blueprint is rejected with `CATALOG_VALIDATION_FAILED`

#### Scenario: Required names an undeclared property
- **WHEN** a blueprint declares `required: ["owner"]` but no property `owner`
- **THEN** the blueprint is rejected with `CATALOG_VALIDATION_FAILED` with an issue at `/schema/required/0`

### Requirement: Relation definitions
A relation definition MUST have the following fields.
- A localized `title`.
- A `target`, which is the identifier of a blueprint of the same tenant. It MAY
  be the source blueprint itself.
- `many` (boolean, default `false`).
- `required` (boolean, default `false`).

A definition with both `many: true` and `required: true` MUST be rejected with
`CATALOG_VALIDATION_FAILED`. A definition whose target does not exist in the tenant MUST be rejected with
`CATALOG_REFERENCE_VIOLATION`. Relation identifiers MUST be unique within the
source blueprint and MUST NOT collide with its property identifiers.

#### Scenario: Relation to an existing blueprint
- **GIVEN** tenant `t1` has blueprint `team`
- **WHEN** tenant `t1` creates blueprint `service` with relation `owner` targeting `team`, `many: false`, `required: true`
- **THEN** the blueprint is created with that relation

#### Scenario: Self relation
- **WHEN** tenant `t1` creates blueprint `service` with relation `dependsOn` targeting `service` and `many: true`
- **THEN** the blueprint is created

#### Scenario: Required many relation is rejected
- **WHEN** a blueprint declares a relation with `many: true` and `required: true`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED`

#### Scenario: Relation to a missing blueprint
- **WHEN** a blueprint declares a relation targeting blueprint `nonexistent`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`

### Requirement: Blueprint read and list
The system MUST return a blueprint by identifier, or fail with
`CATALOG_NOT_FOUND`. It MUST list the tenant's blueprints ordered by identifier
ascending, with cursor-based pagination that honors the page-size limits.

#### Scenario: List blueprints with pagination
- **GIVEN** tenant `t1` has 3 blueprints `a`, `b`, `c`
- **WHEN** it lists blueprints with page size 2
- **THEN** the first page contains `a`, `b` and a cursor
- **AND** requesting the next page with that cursor returns `c` and no cursor

### Requirement: Safe blueprint schema evolution
A blueprint update MUST replace its mutable fields (`title`, `description`,
`icon`, `schema`, `statusSchema`, `relations`) and increment `version` by 1.
Before committing, the system MUST validate every existing entity of the
blueprint against the proposed definition. This covers spec properties, status
properties, spec and status relations, and relation cardinality and
requiredness (requiredness applies to spec relations only). If any entity would
become invalid, the update MUST fail with `CATALOG_SCHEMA_INCOMPATIBLE`, list up
to 10 offending entity identifiers with their issues, and leave the blueprint
unchanged. Changing an existing relation's `target` MUST be rejected with
`CATALOG_SCHEMA_INCOMPATIBLE` while any entity has a spec or status value for that relation.
Clients SHOULD send `expectedVersion`. When provided and different from the
current version, the update MUST fail with `CATALOG_VERSION_CONFLICT`.

#### Scenario: Adding an optional property is compatible
- **GIVEN** blueprint `service` (version 1) has 5 entities
- **WHEN** an optional property `tier` is added
- **THEN** the update succeeds with `version` 2
- **AND** the existing entities are unchanged

#### Scenario: Adding a required property without values is incompatible
- **GIVEN** blueprint `service` has entities that have no `tier` value
- **WHEN** `tier` is added and listed in `required`
- **THEN** it fails with `CATALOG_SCHEMA_INCOMPATIBLE` listing those entities
- **AND** the blueprint stays at its previous version

#### Scenario: Removing a property that has values is incompatible
- **GIVEN** entity `payments` has spec property `language` = `"go"`
- **WHEN** property `language` is removed from blueprint `service`
- **THEN** it fails with `CATALOG_SCHEMA_INCOMPATIBLE` listing `payments`

#### Scenario: Stale expected version
- **GIVEN** blueprint `service` is at version 3
- **WHEN** it is updated with `expectedVersion` 2
- **THEN** it fails with `CATALOG_VERSION_CONFLICT`

### Requirement: Blueprint deletion
Deleting a blueprint MUST fail with `CATALOG_REFERENCE_VIOLATION` if the
blueprint still has entities, or if another blueprint of the tenant declares a
relation targeting it. Otherwise it MUST remove the blueprint and its relation
definitions.

#### Scenario: Blueprint with entities cannot be deleted
- **GIVEN** blueprint `service` has 1 entity
- **WHEN** blueprint `service` is deleted
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`

#### Scenario: Relation target blueprint cannot be deleted
- **GIVEN** blueprint `service` has relation `owner` targeting `team`, and `team` has no entities
- **WHEN** blueprint `team` is deleted
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`

#### Scenario: Unused blueprint is deleted
- **GIVEN** blueprint `sandbox` has no entities and is not a relation target
- **WHEN** it is deleted
- **THEN** getting blueprint `sandbox` fails with `CATALOG_NOT_FOUND`

### Requirement: Entity shape with spec and status
An entity MUST have the following fields.
- `blueprint`: an identifier.
- `identifier`: unique per tenant and blueprint, matching the entity identifier
  pattern, and immutable.
- `title`: a plain string of 1-256 characters. Entity titles are user data and
  are not localized.
- `icon`: optional.
- `spec`: `{ properties, relations }`, the desired state.
- `status`: `{ properties, relations, observedGeneration, observedAt, source }` or `null`,
  the observed state.
- `generation`: an integer that starts at 1 and increments only when `spec`
  changes.
- `version`: an integer that increments on any change.
- `createdAt`/`createdBy`/`updatedAt`/`updatedBy`.

`spec.properties` MUST be valid against the blueprint's `schema`. When a
property is omitted and its definition has a `default`, the default MUST be
applied on write. Undeclared properties MUST be rejected. An entity that has
never had its status reported MUST have `status` = `null`.

#### Scenario: Create an entity
- **GIVEN** blueprint `service` with required string property `language`
- **WHEN** entity `payments` is created with title `Payments`, `spec.properties` `{ "language": "go" }`
- **THEN** it is returned with `generation` 1, `version` 1, `status` null, and `createdBy` equal to the context actor

#### Scenario: Spec violating the schema is rejected
- **WHEN** entity `payments` is created with `spec.properties` `{ "language": 42 }`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at `/spec/properties/language`

#### Scenario: Undeclared property is rejected
- **WHEN** an entity is created with `spec.properties` `{ "language": "go", "colour": "red" }` and `colour` is not declared
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at `/spec/properties/colour`

#### Scenario: Default is applied
- **GIVEN** property `tier` has `"default": "bronze"`
- **WHEN** an entity is created without `tier`
- **THEN** the stored and returned `spec.properties.tier` is `"bronze"`

#### Scenario: Entity of a missing blueprint
- **WHEN** an entity is created for blueprint `nonexistent`
- **THEN** it fails with `CATALOG_NOT_FOUND`

### Requirement: Entity create and upsert semantics
The system MUST provide these write operations.
- **create**: fails with `CATALOG_ALREADY_EXISTS` if the identifier exists.
- **upsert in `replace` mode**: creates the entity, or replaces its whole
  `title`, `icon`, and `spec`.
- **upsert in `merge` mode**: creates the entity, or shallow-merges the given
  `spec.properties` and `spec.relations` keys into the existing spec. A key
  explicitly set to `null` removes that property or relation value.

The upsert result MUST report `outcome` as `created`, `updated` or `unchanged`.
A write that produces an identical title, icon, and spec MUST be `unchanged`. It
MUST NOT increment `generation` or `version`, and MUST NOT append a change event.
Clients SHOULD send `expectedVersion` on updates. When provided and different
from the current version, the write MUST fail with `CATALOG_VERSION_CONFLICT`.
Upsert MUST never modify `status`.

#### Scenario: Upsert creates then replaces
- **WHEN** entity `payments` is upserted in `replace` mode with `{ "language": "go", "tier": "gold" }`
- **AND** it is upserted again in `replace` mode with `{ "language": "rust" }`
- **THEN** the second outcome is `updated`, `generation` is 2, and `spec.properties` is `{ "language": "rust" }` plus any defaults

#### Scenario: Merge keeps unspecified keys
- **GIVEN** entity `payments` with `{ "language": "go", "tier": "gold" }`
- **WHEN** it is upserted in `merge` mode with `{ "tier": "silver" }`
- **THEN** `spec.properties` is `{ "language": "go", "tier": "silver" }`

#### Scenario: Merge with null removes a value
- **GIVEN** entity `payments` with optional property `tier` = `"gold"`
- **WHEN** it is upserted in `merge` mode with `{ "tier": null }`
- **THEN** `spec.properties` no longer contains `tier`

#### Scenario: Idempotent upsert is unchanged
- **GIVEN** entity `payments` at `version` 2
- **WHEN** it is upserted with exactly its current title and spec
- **THEN** the outcome is `unchanged`, `version` stays 2, and no change event is appended

#### Scenario: Create on existing identifier
- **GIVEN** entity `payments` exists
- **WHEN** entity `payments` is created with the create operation
- **THEN** it fails with `CATALOG_ALREADY_EXISTS`

### Requirement: Status is written only through the status operation
The system MUST provide a status operation that writes `status.properties` and
`status.relations`, and it MUST be the only way to change `status`. Each status
write replaces the whole observed snapshot: properties and relations that are
not given are cleared. The following rules apply.
- `status.properties` MUST be validated against the blueprint's
  `statusSchema`. A blueprint without a `statusSchema` rejects any non-empty
    status properties with `CATALOG_VALIDATION_FAILED`.
- `status.relations` MUST use the relation definitions of the blueprint, with
  the same shape, cardinality, limit and referential-integrity rules as
  `spec.relations`, except that `required` does not apply (an observation may
  lack a relation).
- The operation MUST set `observedAt` to the server's current UTC time.
- It MUST set `source` to the caller-supplied source label, which MUST match
  the property and relation identifier pattern (for example `github`).
- It MUST set `observedGeneration` to the caller-supplied generation the
  observation corresponds to. That value MUST be ≤ the entity's current
  `generation`, otherwise the operation fails with `CATALOG_VALIDATION_FAILED`.
- A status write MUST NOT change `spec` or `generation`. It MUST increment
  `version`.

The operation is a separate operation (not a flag on upsert) so that 002 can
authorize it separately.

#### Scenario: Integration reports status
- **GIVEN** blueprint `service` has `statusSchema` with property `lastDeployAt` (string, `date-time`), and entity `payments` at `generation` 2
- **WHEN** an `integration` actor writes status `{ "lastDeployAt": "2026-09-01T10:00:00Z" }` with `observedGeneration` 2 and source `github`
- **THEN** `status.properties.lastDeployAt` is stored, `status.source` is `github`, and `spec` and `generation` are unchanged

#### Scenario: Integration reports observed relations
- **GIVEN** blueprint `service` has relation `dependsOn` (`many: true`) targeting `service`, and entities `ledger` and `auth` exist
- **WHEN** an `integration` actor writes status with `relations` `{ "dependsOn": ["ledger"] }`
- **THEN** `status.relations.dependsOn` is `["ledger"]` and `spec.relations` is unchanged

#### Scenario: Observed relation to a missing target is rejected
- **WHEN** status is written with `relations` `{ "dependsOn": ["ghost"] }`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`

#### Scenario: Status write replaces the snapshot
- **GIVEN** entity `payments` with status relations `{ "dependsOn": ["ledger"] }`
- **WHEN** status is written with properties only and no `relations`
- **THEN** `status.relations` is empty

#### Scenario: Observed generation from the future is rejected
- **GIVEN** entity `payments` at `generation` 2
- **WHEN** status is written with `observedGeneration` 3
- **THEN** it fails with `CATALOG_VALIDATION_FAILED`

#### Scenario: Spec changes do not touch status
- **GIVEN** entity `payments` with a reported status
- **WHEN** it is upserted with a new spec
- **THEN** its `status` is identical to before and `generation` increments

### Requirement: Entity relations and referential integrity
`spec.relations` (and, per the status requirement, `status.relations`) MUST map relation identifiers to a single target entity
identifier (for `many: false`) or an array of unique identifiers (for
`many: true`, at most 1000). Every target MUST be an existing entity of the
relation's target blueprint in the same tenant. Otherwise the write fails with
`CATALOG_REFERENCE_VIOLATION`, naming the relation and the missing identifiers.
A `required` relation (always single-valued) MUST have a value.
The order of a `many` relation's targets MUST be preserved as written.
Undeclared relation keys MUST be rejected with `CATALOG_VALIDATION_FAILED`.

#### Scenario: Valid single relation
- **GIVEN** blueprint `service` has relation `owner` targeting `team`, and entity `team-a` of `team` exists
- **WHEN** entity `payments` is created with `spec.relations` `{ "owner": "team-a" }`
- **THEN** the entity is created with that relation

#### Scenario: Missing relation target
- **WHEN** entity `payments` is created with `{ "owner": "ghost-team" }`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION` naming relation `owner` and `ghost-team`

#### Scenario: Missing required relation
- **GIVEN** relation `owner` is `required: true`
- **WHEN** entity `payments` is created without `owner`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED` with an issue at `/spec/relations/owner`

#### Scenario: Many relation keeps order
- **WHEN** entity `payments` is created with `{ "dependsOn": ["ledger", "auth"] }` and both exist
- **THEN** getting `payments` returns `dependsOn` as `["ledger", "auth"]`

#### Scenario: Wrong cardinality
- **GIVEN** relation `owner` has `many: false`
- **WHEN** an entity is written with `{ "owner": ["team-a", "team-b"] }`
- **THEN** it fails with `CATALOG_VALIDATION_FAILED`

### Requirement: Related entities traversal
The system MUST list, for a given entity, its directly related entities in
both directions.
- **Forward**: the entities it targets, grouped by relation.
- **Backward**: the entities whose relations target it, grouped by source
  blueprint and relation.

Every result item MUST state its `scope`, `spec` (desired) or `status`
(observed). The operation MUST accept an optional `scope` filter (`spec`,
`status` or both, defaulting to both).

Both lists are limited to depth 1 and use cursor pagination. Traversal MUST
never cross tenants.

#### Scenario: Forward and backward relations
- **GIVEN** `payments` and `billing` both have `owner` = `team-a`
- **WHEN** related entities of `team-a` are listed in the backward direction
- **THEN** the result contains `payments` and `billing` under source blueprint `service`, relation `owner`
- **AND** listing `payments` in the forward direction returns `team-a` under relation `owner` with scope `spec`

#### Scenario: Traversal distinguishes desired and observed
- **GIVEN** `payments` has `spec.relations.dependsOn` = `["ledger"]` and `status.relations.dependsOn` = `["auth"]`
- **WHEN** related entities of `payments` are listed forward with `scope` = `status`
- **THEN** only `auth` is returned, with scope `status`

### Requirement: Entity read, list and delete
The system MUST get an entity by blueprint and identifier, or fail with
`CATALOG_NOT_FOUND`. It MUST list the entities of a blueprint ordered by
identifier ascending, with cursor pagination. The list operation MAY accept
additional filters in later changes, but it MUST NOT return entities of other
blueprints or tenants.

Deleting an entity that is the target of any **spec** relation MUST fail with
`CATALOG_REFERENCE_VIOLATION`, listing up to 10 referring entities, unless the
request sets `detachReferences: true` (at most 1000 referrers; more fails with
`CATALOG_LIMIT_EXCEEDED`). In that case, the entity is removed from
every optional relation that references it, in the same transaction, and each
modified referrer gets a new `version` and `generation`. The delete MUST still
fail if any referrer holds it in a `required` relation. Observed (**status**)
relations never block a delete. They are always removed in the same
transaction, and each affected referrer gets a new `version` (not
`generation`) and a `status_updated` change event.

#### Scenario: Delete an unreferenced entity
- **GIVEN** entity `sandbox-svc` is not the target of any relation
- **WHEN** it is deleted
- **THEN** getting it fails with `CATALOG_NOT_FOUND`

#### Scenario: Delete a referenced entity is rejected by default
- **GIVEN** `payments.owner` = `team-a`
- **WHEN** `team-a` is deleted without `detachReferences`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION` listing `payments`

#### Scenario: Detach optional references on delete
- **GIVEN** optional relation `dependsOn` on `payments` = `["ledger", "auth"]`
- **WHEN** `ledger` is deleted with `detachReferences: true`
- **THEN** `ledger` is deleted and `payments.spec.relations.dependsOn` becomes `["auth"]`

#### Scenario: Observed references never block delete
- **GIVEN** only `status.relations.dependsOn` of `payments` references `ledger`
- **WHEN** `ledger` is deleted without `detachReferences`
- **THEN** `ledger` is deleted and `payments.status.relations.dependsOn` no longer contains it

#### Scenario: Required references block detach
- **GIVEN** required relation `owner` on `payments` = `team-a`
- **WHEN** `team-a` is deleted with `detachReferences: true`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION` and nothing is changed

### Requirement: Actor attribution and change events
Every successful mutation MUST do the following.
- Record the context actor, including `onBehalfOf` when present, as
  `updatedBy`, and as `createdBy` on creation.
  This applies to blueprint create, update, and delete, and to entity create,
  upsert (except `unchanged`), status write, and delete (including referrers
  detached by a delete).
- Append exactly one change event per affected resource, in the same
  transaction. The event contains a monotonically increasing sequence per
  tenant, `tenantId`, `occurredAt` (UTC), the actor, the action (`created`,
  `updated`, `status_updated`, `deleted`), the resource kind (`blueprint` or
  `entity`), the blueprint identifier, the resource identifier, the resulting
  `version`, the list of changed top-level fields, the `onBehalfOf` principal
  when present, the current trace ID when one exists, and a **snapshot** of the
  resource's resulting state. For an entity, the snapshot holds `title`, `icon`,
  `spec` and `status`. For a blueprint, it holds the full definition. For a
  delete, it holds the last state before deletion.

Change-event snapshots contain tenant data. They MUST NOT be copied into
telemetry or error responses, and they are stored only in the tenant-scoped
change-event log.

The same code path MUST be used for every actor type. There MUST NOT be any
operation variant that skips validation, attribution, or event recording for a
particular actor type. Change events MUST be append-only. No catalog operation
updates or deletes them, and the database MUST reject `UPDATE`, `DELETE` and
`TRUNCATE` on the change-event log. A mutation that fails MUST NOT
append any event.

#### Scenario: Agent and human writes are attributed identically
- **WHEN** a `user` actor `u1` upserts entity `a`, and an `agent` actor `ag1` upserts entity `b`, with identical payload shapes
- **THEN** both entities pass the same validation, `a.updatedBy` is `{ user, u1 }`, `b.updatedBy` is `{ agent, ag1 }`
- **AND** each write appended one change event naming its actor

#### Scenario: Every mutation behaves the same for every actor type
- **WHEN** each mutation (blueprint create, update and delete; entity create, upsert, status write and delete) is executed once successfully and once with a validation error, by each of the actor types `user`, `agent` and `integration`
- **THEN** the outcomes, error codes, attribution fields and change events differ only in the recorded actor

#### Scenario: Delegated agent write records the principal
- **WHEN** actor `{ type: "agent", id: "ag1", onBehalfOf: { type: "user", id: "u1" } }` upserts an entity
- **THEN** `updatedBy` and the change event both record `ag1` acting on behalf of `u1`

#### Scenario: Change events cannot be altered
- **WHEN** a direct SQL `UPDATE` or `DELETE` is issued against the change-event log
- **THEN** the database rejects it

#### Scenario: Change events record resulting values
- **GIVEN** entity `payments` with `spec.properties.tier` = `"gold"`
- **WHEN** it is upserted in `merge` mode with `{ "tier": "silver" }`, then deleted
- **THEN** the `updated` event's snapshot has `spec.properties.tier` = `"silver"`
- **AND** the `deleted` event's snapshot holds the last state, with `tier` = `"silver"`
- **AND** the state of `payments` at any past `version` can be read from its events

#### Scenario: Failed mutation appends nothing
- **WHEN** an entity write fails with `CATALOG_VALIDATION_FAILED`
- **THEN** the tenant's change-event sequence is unchanged

#### Scenario: Detach on delete records every affected entity
- **WHEN** `ledger` is deleted with `detachReferences: true` and `payments` referenced it
- **THEN** change events `deleted` (for `ledger`) and `updated` (for `payments`) are appended in the same transaction

### Requirement: Limits protect the catalog
The system MUST enforce the default limits in the Conventions table, or the
deployment's configured overrides. Exceeding a size or count limit MUST fail
with `CATALOG_LIMIT_EXCEEDED` and name the limit. Violating an identifier or
text-length constraint MUST fail with `CATALOG_VALIDATION_FAILED`. Limits MUST
be checked before any expensive work (schema compilation or database writes).

#### Scenario: Oversized spec is rejected
- **WHEN** an entity is written whose serialized `spec` exceeds 256 KiB
- **THEN** it fails with `CATALOG_LIMIT_EXCEEDED` naming `entity.spec.maxBytes`

#### Scenario: Too many relation targets
- **WHEN** a `many` relation is written with 1001 targets
- **THEN** it fails with `CATALOG_LIMIT_EXCEEDED`

### Requirement: Timestamps are UTC
All timestamps that the catalog stores or returns MUST be UTC instants. API
responses MUST serialize them as ISO 8601 strings with a `Z` suffix. The catalog
MUST NOT apply or store any time-zone conversion.

#### Scenario: Timestamps are returned in UTC
- **WHEN** an entity is created from a client in any time zone
- **THEN** `createdAt` ends with `Z` and equals the server's UTC time of the write

### Requirement: Published API contract
The catalog operations MUST be described by a machine-readable OpenAPI 3.1
document that is committed to the repository. CI MUST fail when the
implementation's generated document differs from the committed one. Error
responses MUST expose the stable error code and validation issues, and MUST NOT expose stack traces, SQL, or other internal details. Internal
errors MUST be recorded only as their error type, SQLSTATE and constraint name.
The error message, database `detail` and `where` fields, and bind parameters
MUST be dropped, because database messages embed row values. No procedure input
MAY declare a `tenantId` or `actor` field. The contract check MUST fail if the
document contains one. A blueprint's read output, without its server-managed
fields, MUST be valid input to blueprint create and update, so definitions
can be exported from one instance and applied to another.

#### Scenario: Blueprint definitions round-trip
- **GIVEN** a non-reserved blueprint read with the get operation
- **WHEN** its output, without the server-managed fields (`version`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`), is sent to the create operation in another tenant and to the update operation in the same tenant
- **THEN** both are accepted unchanged, and a new get returns an equal definition

#### Scenario: Contract drift fails CI
- **GIVEN** the committed OpenAPI document
- **WHEN** a procedure's input schema changes without regenerating the document
- **THEN** the contract-check step fails

#### Scenario: Contract cannot carry the tenant
- **WHEN** a procedure input declares a field named `tenantId`
- **THEN** the contract-check step fails

#### Scenario: Internal errors are not leaked
- **WHEN** an unexpected database error occurs during an operation
- **THEN** the caller receives a generic internal error with no SQL text or stack trace
- **AND** the operation's span records the error type and SQLSTATE, but not the database message

### Requirement: Telemetry contract
Every catalog operation MUST emit the spans, metrics, and security log events
declared in the change's observability contract, using the declared names and
attributes. Telemetry MUST NOT contain property values, entity titles,
descriptions, or any other tenant-supplied free text. Identifiers and
enumerated values are permitted.

#### Scenario: Declared telemetry is emitted
- **WHEN** each catalog operation is executed once, successfully and with an error, under an in-memory telemetry exporter
- **THEN** every span and metric declared in the contract is observed with its required attributes

#### Scenario: Property values never reach telemetry
- **WHEN** an entity is created with a property value `"secret-marker-123"` and title `"Title-marker-456"`
- **THEN** neither marker appears in any exported span, metric, or log attribute
- **AND** the same holds when a later write of that entity fails with a forced database constraint error
