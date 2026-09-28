# Catalog core

The catalog core (`@tayzu/catalog`, OpenSpec change
[`001-catalog-core`](../../openspec/changes/001-catalog-core/)) is Tayzu's
tenant-scoped software catalog. Tenants define **blueprints**: types with
typed properties and relations. Humans, AI agents and integrations then
create **entities** of those blueprints. Each entity keeps its desired
state (`spec`) separate from its observed state (`status`).

## Concepts

| Concept         | What it is                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blueprint       | A tenant-defined type. It has an identifier, a localized `title` and `description` (`en` required, `es` optional), a `schema` for spec properties, an optional `statusSchema`, and relation definitions. Identifiers starting with `_` are reserved for platform blueprints; only the `system` actor may write them. |
| Property        | A typed field in a restricted JSON Schema subset: `string` (formats `date-time`, `url`, `email`, `markdown`, `yaml`), `number`, `integer`, `boolean`, `array` of primitives, and free-form `object`. See [ADR-0008](../adr/0008-catalog-property-schema-subset.md).                                                  |
| Entity          | An instance of a blueprint. `spec` holds desired `properties` and `relations`. `status` holds observed `properties` and `relations`, plus `observedGeneration`, `observedAt` and `source`, or is `null`. `generation` increments only when `spec` changes; `version` increments on every change.                     |
| Relation        | A typed, directed link declared on the source blueprint (`many`, `required`), stored as edges with a `spec` or `status` scope. See [ADR-0009](../adr/0009-relations-as-edges.md).                                                                                                                                    |
| Catalog context | `{ tenantId, actor: { type, id, onBehalfOf? } }`. The trusted host always supplies it; it is never part of a request. Actor types are `user`, `agent`, `integration` and `system`, and every type takes the same code path.                                                                                          |
| Change event    | An append-only record of every mutation, with the actor, action, changed fields, a snapshot of the resulting state and the trace ID.                                                                                                                                                                                 |

Schema changes on a blueprint that already has entities are accepted only if
every entity stays valid. See [ADR-0010](../adr/0010-safe-schema-evolution.md).

## API

The API is an oRPC router described by the OpenAPI 3.1 document
[`openapi/catalog.openapi.json`](../../openapi/catalog.openapi.json).
CI checks that document for drift (`pnpm contract:check`). In 001 the API
is called in-process only; it is not served over the network until 002
([ADR-0011](../adr/0011-api-not-exposed-before-auth.md)).

| Procedure              | Route                                                                                          | Risk |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `blueprints.create`    | `POST /v1/blueprints`                                                                          |      |
| `blueprints.list`      | `GET /v1/blueprints?pageSize=&cursor=`                                                         |      |
| `blueprints.get`       | `GET /v1/blueprints/{blueprint}`                                                               |      |
| `blueprints.update`    | `PUT /v1/blueprints/{blueprint}`                                                               | high |
| `blueprints.delete`    | `DELETE /v1/blueprints/{blueprint}`                                                            | high |
| `entities.create`      | `POST /v1/blueprints/{blueprint}/entities`                                                     |      |
| `entities.list`        | `GET /v1/blueprints/{blueprint}/entities?pageSize=&cursor=`                                    |      |
| `entities.get`         | `GET /v1/blueprints/{blueprint}/entities/{entity}`                                             |      |
| `entities.upsert`      | `PUT /v1/blueprints/{blueprint}/entities/{entity}`                                             |      |
| `entities.delete`      | `DELETE /v1/blueprints/{blueprint}/entities/{entity}?detachReferences=`                        | high |
| `entities.writeStatus` | `PUT /v1/blueprints/{blueprint}/entities/{entity}/status`                                      |      |
| `entities.listRelated` | `GET /v1/blueprints/{blueprint}/entities/{entity}/related?direction=&scope=&pageSize=&cursor=` |      |

- Entity identifiers may contain `/`. In a path, they are percent-encoded
  as a single segment.
- Operations marked `high` carry `x-tayzu-risk: high` in the OpenAPI
  document. Authorization (002) and human-in-the-loop for agents (014)
  use that marker.
- List operations use keyset pagination. The `cursor` is opaque, the
  default page size is 50 and the maximum is 500.

### Errors

Errors have the shape `{ code, message, issues?, details? }`. `issues` is a
list of `{ path, message }`, where `path` is a JSON Pointer into the
request.

| Code                          | HTTP | When                                                                                             |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `CATALOG_CONTEXT_REQUIRED`    | 401  | The host supplied no valid catalog context.                                                      |
| `CATALOG_RESERVED_IDENTIFIER` | 403  | A non-`system` actor writes a reserved `_` blueprint or its entities.                            |
| `CATALOG_NOT_FOUND`           | 404  | The resource does not exist in the caller's tenant. Other tenants' data looks exactly like this. |
| `CATALOG_ALREADY_EXISTS`      | 409  | The identifier already exists in the tenant.                                                     |
| `CATALOG_VERSION_CONFLICT`    | 409  | `expectedVersion` does not match the current version.                                            |
| `CATALOG_SCHEMA_INCOMPATIBLE` | 409  | A blueprint update would make existing entities invalid. The first 10 offenders are listed.      |
| `CATALOG_VALIDATION_FAILED`   | 400  | The input violates the schema, an identifier rule or a text limit.                               |
| `CATALOG_REFERENCE_VIOLATION` | 422  | A relation target is missing, or a delete would break references.                                |
| `CATALOG_LIMIT_EXCEEDED`      | 422  | A size or count limit was exceeded. The limit is named in `details`.                             |
| any other error               | 500  | Returned as a generic `INTERNAL` error, with no SQL, stack or database message.                  |

### Examples

Create a blueprint:

```json
{
  "identifier": "service",
  "title": { "en": "Service", "es": "Servicio" },
  "schema": {
    "properties": {
      "language": { "type": "string", "title": { "en": "Language" } },
      "tier": {
        "type": "string",
        "enum": ["gold", "silver", "bronze"],
        "default": "bronze",
        "title": { "en": "Tier" }
      }
    },
    "required": ["language"]
  },
  "relations": {
    "owner": { "title": { "en": "Owner" }, "target": "team", "required": true }
  }
}
```

Upsert an entity in `merge` mode. Keys not given are kept, and `null`
removes a value:

```json
{
  "mode": "merge",
  "title": "Payments",
  "spec": { "properties": { "tier": "silver" }, "relations": { "owner": "team-a" } },
  "expectedVersion": 2
}
```

The result reports `outcome`: `created`, `updated` or `unchanged`. An
`unchanged` write appends no change event and does not bump `version`.

## Telemetry

The catalog emits OpenTelemetry signals under the instrumentation scope
`@tayzu/catalog`. The library depends on the OTel API only, so the host app
configures the SDK and exporters. The executable mirror of this contract is
`packages/catalog/src/telemetry/contract.ts`. `pnpm otel-smoke-check`
verifies that every signal below is emitted with its attributes, that
metrics carry no undeclared attribute, and that no tenant data reaches
telemetry.

Telemetry never contains property values, entity or blueprint titles and
descriptions, validation messages, SQL text or bind values. Internal errors
are recorded with their type, SQLSTATE and constraint name only.

### Spans

Every operation span carries these common attributes: `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.operation`. Failed
operations set the span status to `ERROR`, with `error.type` set to the
catalog error code, or to `internal` for unexpected errors.

| Span                                    | Kind      | Required attributes                                                                                                                       | Conditional attributes                        |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `catalog.blueprint.create`              | operation | `tayzu.catalog.blueprint.identifier`                                                                                                      | —                                             |
| `catalog.blueprint.get`                 | operation | `tayzu.catalog.blueprint.identifier`                                                                                                      | —                                             |
| `catalog.blueprint.list`                | operation | `tayzu.catalog.page.size`                                                                                                                 | `tayzu.catalog.result.count`                  |
| `catalog.blueprint.update`              | operation | `tayzu.catalog.blueprint.identifier`                                                                                                      | `tayzu.catalog.compatibility.violation.count` |
| `catalog.blueprint.delete`              | operation | `tayzu.catalog.blueprint.identifier`                                                                                                      | —                                             |
| `catalog.entity.create`                 | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`                                                                   | `tayzu.catalog.relation.target.count`         |
| `catalog.entity.upsert`                 | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.upsert.mode`                                      | `tayzu.catalog.mutation`                      |
| `catalog.entity.get`                    | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`                                                                   | —                                             |
| `catalog.entity.list`                   | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.page.size`                                                                           | `tayzu.catalog.result.count`                  |
| `catalog.entity.delete`                 | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.detach_references`                                | `tayzu.catalog.detached.count`                |
| `catalog.entity.status.write`           | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.status.source`                                    | `tayzu.catalog.relation.target.count`         |
| `catalog.entity.related.list`           | operation | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.entity.identifier`, `tayzu.catalog.related.direction`, `tayzu.catalog.related.scope` | `tayzu.catalog.result.count`                  |
| `catalog.schema.compile`                | child     | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.blueprint.version`                                                                   | —                                             |
| `catalog.blueprint.compatibility_check` | child     | `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.compatibility.entities_checked`                                                      | `tayzu.catalog.compatibility.violation.count` |
| `catalog.entity.validate`               | child     | `tayzu.catalog.blueprint.identifier`                                                                                                      | `tayzu.catalog.validation.issue.count`        |
| `catalog.relations.resolve`             | child     | `tayzu.catalog.relation.target.count`                                                                                                     | `tayzu.catalog.relation.missing.count`        |

Database spans (`pg.*`) come from `@opentelemetry/instrumentation-pg`, with
`enhancedDatabaseReporting: false`, so bind values are never recorded.

### Metrics

Each metric carries only the attributes listed here. Entity identifiers and
actor IDs are never metric attributes.

| Metric                                  | Instrument | Unit          | Allowed attributes                                                                                      |
| --------------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `tayzu.catalog.operation.duration`      | histogram  | `s`           | `tayzu.catalog.operation`, `tayzu.catalog.outcome`, `error.type`, `tayzu.tenant.id`, `tayzu.actor.type` |
| `tayzu.catalog.entity.mutations`        | counter    | `{mutation}`  | `tayzu.tenant.id`, `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.mutation`, `tayzu.actor.type`   |
| `tayzu.catalog.blueprint.mutations`     | counter    | `{mutation}`  | `tayzu.tenant.id`, `tayzu.catalog.mutation`, `tayzu.actor.type`                                         |
| `tayzu.catalog.validation.failures`     | counter    | `{failure}`   | `tayzu.tenant.id`, `tayzu.catalog.operation`, `error.type`                                              |
| `tayzu.catalog.context.rejections`      | counter    | `{rejection}` | `tayzu.catalog.operation`, `tayzu.catalog.context.reason`                                               |
| `tayzu.catalog.schema.cache.lookups`    | counter    | `{lookup}`    | `tayzu.cache.result`                                                                                    |
| `tayzu.catalog.schema.compile.duration` | histogram  | `s`           | —                                                                                                       |

SLIs, derived from `tayzu.catalog.operation.duration` per operation and
tenant:

- **Availability**: the share of operations whose `tayzu.catalog.outcome` is
  not `server_error`.
- **Latency**: p99 of `tayzu.catalog.operation.duration` for successful
  operations.

### Log events

| Event                                         | Severity | Attributes                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.audit.mutation`                      | INFO     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.actor.on_behalf_of.type`, `tayzu.actor.on_behalf_of.id`, `tayzu.catalog.mutation`, `tayzu.catalog.resource.kind`, `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.resource.identifier`, `tayzu.catalog.version`, `tayzu.catalog.change_event.seq` |
| `catalog.security.context_rejected`           | WARN     | `tayzu.catalog.operation`, `tayzu.catalog.context.reason`                                                                                                                                                                                                                                                              |
| `catalog.security.reserved_identifier_denied` | WARN     | `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.catalog.blueprint.identifier`                                                                                                                                                                                                                          |
| `catalog.internal_error`                      | ERROR    | `tayzu.catalog.operation`, `exception.type`, `db.response.status_code`, `tayzu.db.constraint`, `exception.stacktrace`                                                                                                                                                                                                  |

Every log record carries the active trace and span IDs. `catalog_change_event`
rows store the same `trace_id`, so an audit entry, its trace and its database
event can be joined. The durable audit record is the append-only
`catalog_change_event` table; `catalog.audit.mutation` is a best-effort copy
for centralized logging.

These signals must never be sampled or dropped by a downstream pipeline:
`catalog.audit.mutation`, `catalog.security.context_rejected`, `catalog.security.reserved_identifier_denied`, `tayzu.catalog.context.rejections`, `tayzu.catalog.validation.failures`.

### Example queries (Application Insights, KQL)

With the Azure Monitor OpenTelemetry exporter, operation spans (`INTERNAL`
kind) land in the `dependencies` table, metrics in `customMetrics` and log
records in `traces`. Attributes appear under `customDimensions`.

Error rate per operation over the last hour:

```kusto
customMetrics
| where timestamp > ago(1h) and name == "tayzu.catalog.operation.duration"
| extend operation = tostring(customDimensions["tayzu.catalog.operation"]),
         outcome = tostring(customDimensions["tayzu.catalog.outcome"])
| summarize calls = sum(valueCount),
            serverErrors = sumif(valueCount, outcome == "server_error") by operation
| extend errorRate = todouble(serverErrors) / calls
```

Callers without a valid catalog context (security signal):

```kusto
traces
| where timestamp > ago(24h) and message == "catalog.security.context_rejected"
| summarize count() by tostring(customDimensions["tayzu.catalog.operation"]),
                     tostring(customDimensions["tayzu.catalog.context.reason"])
```

Everything an agent changed in a tenant, with its trace:

```kusto
traces
| where message == "catalog.audit.mutation"
| where customDimensions["tayzu.tenant.id"] == "<tenant>"
    and customDimensions["tayzu.actor.type"] == "agent"
| project timestamp, operation_Id,
          actor = tostring(customDimensions["tayzu.actor.id"]),
          onBehalfOf = tostring(customDimensions["tayzu.actor.on_behalf_of.id"]),
          mutation = tostring(customDimensions["tayzu.catalog.mutation"]),
          resource = tostring(customDimensions["tayzu.catalog.resource.identifier"])
```
