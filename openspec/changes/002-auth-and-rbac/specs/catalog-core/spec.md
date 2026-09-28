# Spec Delta

## MODIFIED Requirements

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

Once the catalog is served over HTTP, every stable error code MUST map to the
same fixed HTTP status code the committed document declares, for every
procedure, not only in-process callers. A non-`GET` procedure whose document
declares a field as `in: query` (for example `entities.delete`'s
`detachReferences`) MUST read that field from the request's query string at
runtime, matching the document, not from the request body.

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

#### Scenario: HTTP error status matches the declared code
- **WHEN** a catalog operation fails with `CATALOG_NOT_FOUND` and is called over HTTP
- **THEN** the HTTP response status is 404 and the body's `code` is `CATALOG_NOT_FOUND`

#### Scenario: Query-string input on a non-GET route is read from the query string
- **WHEN** `DELETE .../entities/{entity}?detachReferences=true` is called over HTTP
- **THEN** the operation runs with `detachReferences` true, without reading the request body for it

### Requirement: Safe blueprint schema evolution
A blueprint update MUST replace its mutable fields (`title`, `description`,
`icon`, `schema`, `statusSchema`, `relations`) and increment `version` by 1.
Before committing, the system MUST validate every existing entity of the
blueprint against the proposed definition. This covers spec properties, status
properties, spec and status relations, and relation cardinality and
requiredness (requiredness applies to spec relations only). If any entity would
become invalid, the update MUST fail with `CATALOG_SCHEMA_INCOMPATIBLE`, list up
to 10 offending entity identifiers with their issues, and leave the blueprint
unchanged. An offending entity the caller cannot read (per the
auth-and-rbac capability's authorization check) MUST be redacted from that
list and counted instead, as "+N not visible". Changing an existing relation's
`target` MUST be rejected with
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

#### Scenario: Incompatible entities the caller cannot read are redacted
- **GIVEN** blueprint `service` has 2 incompatible entities the caller can read and 3 incompatible entities owned by a team the caller cannot read
- **WHEN** the caller updates blueprint `service` with an incompatible schema change
- **THEN** it fails with `CATALOG_SCHEMA_INCOMPATIBLE`, naming the 2 readable entities and reporting "+3 not visible"

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

### Requirement: Entity read, list and delete
The system MUST get an entity by blueprint and identifier, or fail with
`CATALOG_NOT_FOUND`. It MUST list the entities of a blueprint ordered by
identifier ascending, with cursor pagination. The list operation MAY accept
additional filters in later changes, but it MUST NOT return entities of other
blueprints or tenants.

Deleting an entity that is the target of any **spec** relation MUST fail with
`CATALOG_REFERENCE_VIOLATION`, listing up to 10 referring entities, unless the
request sets `detachReferences: true` (at most 1000 referrers; more fails with
`CATALOG_LIMIT_EXCEEDED`). A referring entity the caller cannot read (per the
auth-and-rbac capability's authorization check) MUST be redacted from that
list and counted instead, as "+N not visible", in both the blocking-error case
and the `detachReferences` case. In that case, the entity is removed from
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

#### Scenario: Delete-blocking referrers the caller cannot read are redacted to a count
- **GIVEN** entity `team-a` is referenced by 1 entity the caller can read and 4 entities owned by a team the caller cannot read
- **WHEN** `team-a` is deleted without `detachReferences`
- **THEN** it fails with `CATALOG_REFERENCE_VIOLATION`, naming the 1 readable referrer and reporting "+4 not visible"
