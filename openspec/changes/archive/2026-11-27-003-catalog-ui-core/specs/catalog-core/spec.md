# Spec Delta

## MODIFIED Requirements

### Requirement: Entity read, list and delete

The system MUST get an entity by blueprint and identifier, or fail with
`CATALOG_NOT_FOUND`. It MUST list the entities of a blueprint ordered by
identifier ascending by default, with cursor pagination. The list operation MUST
also accept a sort key, `identifier`, `title` or `updatedAt`, and an order, `asc` or
`desc`; rows with an equal sort key MUST be ordered by identifier in the same
direction, so that paging returns every row exactly once. The cursor MUST be bound
to the sort key and order it was issued for and MUST NOT exceed the cursor length
limit for any sort; it MUST carry no tenant and no sort value, only the position of
the last row, whose sort key the server reads inside the caller's tenant under the
same authorization as the list. A cursor used with another sort key or order, a
malformed cursor, or one whose row is gone, is in another blueprint or tenant, or is
not readable by the caller, MUST fail with `CATALOG_VALIDATION_FAILED`, and a cursor
issued before sorting existed MUST stay valid for the default sort. Sorting
MUST NOT change which entities the caller may see. The list operation MAY accept
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

#### Scenario: List sorted by title descending pages without gaps

- **GIVEN** blueprint `service` has entities titled `Alpha`, `Beta`, `Beta` and `Gamma`
- **WHEN** they are listed sorted by `title` in `desc` order with a page size of 2, and the next page is requested with the returned cursor
- **THEN** the first page holds `Gamma` and one `Beta`, the second page holds the other `Beta` and `Alpha`, and the two `Beta` rows are ordered by identifier

#### Scenario: Sort by update time

- **GIVEN** entity `a` was updated after entity `b`
- **WHEN** the entities are listed sorted by `updatedAt` in `desc` order
- **THEN** `a` comes before `b`

#### Scenario: A cursor of another sort is rejected

- **GIVEN** a cursor returned by a list sorted by `title`
- **WHEN** it is sent with a list sorted by `identifier`
- **THEN** the list fails with `CATALOG_VALIDATION_FAILED` on `/cursor`

#### Scenario: Long titles and identifiers still page

- **GIVEN** entities with 256-character titles and 256-character identifiers
- **WHEN** they are listed sorted by `title` and the next page is requested
- **THEN** every returned cursor is at most 512 characters and the second page continues the order

#### Scenario: A cursor anchored on an unreadable entity is rejected

- **GIVEN** a cursor crafted to point at an entity the caller cannot read
- **WHEN** it is sent with a list sorted by `title`
- **THEN** the list fails with `CATALOG_VALIDATION_FAILED` on `/cursor` and reveals nothing about that entity

#### Scenario: Sorting does not widen visibility

- **GIVEN** a member who can read 3 of the 5 entities of a blueprint
- **WHEN** the member lists them sorted by `updatedAt`
- **THEN** exactly those 3 are returned

## ADDED Requirements

### Requirement: Cross-blueprint entity search

The system MUST offer a search operation that returns, across every blueprint of the
caller's tenant, the entities whose identifier or title starts with the query,
case-insensitively, or whose title is similar to it by trigram similarity. The query
MUST be between 2 and 100 characters after trimming and normalization, with no control
character, and the result limit MUST default to 20 and be at most 50; these limits MUST
be checked before any database work, failing with `CATALOG_VALIDATION_FAILED` for the
query and `CATALOG_LIMIT_EXCEEDED` for the limit. The characters `%`, `_` and `\` in the
query MUST match literally. Results MUST be ranked exact identifier match first, then
identifier prefix, then title prefix, then similarity, and ties MUST be ordered by
blueprint and then entity identifier. Each result MUST carry the blueprint identifier,
the entity identifier, the title and whether the identifier or the title matched. The
search MUST be narrowed by the same authorization plan as the list operation, MUST
return no result rather than an error when that plan denies, and MUST NOT return an
entity of another tenant. The query text MUST NOT reach any telemetry signal; the
operation's span MUST carry only the query length, the limit and the result count, and
the list operation's span MUST carry the sort key and order.

#### Scenario: Identifier prefix across blueprints

- **GIVEN** entity `payments-api` of blueprint `service` and entity `payments-db` of blueprint `database`
- **WHEN** the caller searches for `paym`
- **THEN** both are returned with `match` `identifier`, ordered by blueprint identifier

#### Scenario: Title similarity finds a typo

- **GIVEN** an entity titled `Payments Gateway`
- **WHEN** the caller searches for `Paymnets Gateway`
- **THEN** it is returned with `match` `title`

#### Scenario: Wildcards match literally

- **GIVEN** entities `a_b` titled `First` and `axb` titled `Second`
- **WHEN** the caller searches for `a_`
- **THEN** `a_b` is returned and `axb` is not

#### Scenario: Search shows only what the caller may list

- **GIVEN** a member who may read only the entities owned by their team
- **WHEN** the member searches for a prefix that matches entities of several teams
- **THEN** only their team's entities are returned

#### Scenario: Another tenant's entity is never found

- **GIVEN** entity `secret-svc` exists only in tenant `t1`
- **WHEN** a caller of tenant `t2` searches for `secret`
- **THEN** the result is empty

#### Scenario: Limits are checked before the database

- **WHEN** the caller searches for a 101-character query, or with a limit of 51
- **THEN** the search fails with `CATALOG_VALIDATION_FAILED` or `CATALOG_LIMIT_EXCEEDED` and no database query is made

#### Scenario: The query text never reaches telemetry

- **GIVEN** a query that contains a unique marker string
- **WHEN** the search runs and its telemetry is exported
- **THEN** no span, metric or log carries the marker, and the span carries the query length
