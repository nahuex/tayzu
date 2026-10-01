/**
 * `otel-smoke-check` (tasks 10.1, 10.2, 10.3, openspec/changes/archive/2026-09-28-001-catalog-core;
 * design.md, "Observability contract"; spec "Telemetry contract").
 *
 * **This file is what `pnpm otel-smoke-check` runs.** `packages/catalog/package.json`
 * does not yet declare an `otel-smoke-check` script (task 10.1 is still red);
 * once it does, it MUST be exactly:
 *
 * ```json
 * "otel-smoke-check": "vitest run src/telemetry/otel-smoke-check.int.test.ts"
 * ```
 *
 * so that the root `pnpm otel-smoke-check` (`turbo run otel-smoke-check`,
 * `package.json`) and CI's dedicated job (task 1.7) both exercise exactly
 * this test, never a different or partial one. `contract.ts` (task 6.1) is
 * this test's executable mirror of design.md's "Observability contract"
 * section: every assertion below is *derived* from `SPANS`, `METRICS` and
 * `LOG_EVENTS`, so the design and this check stay in one place, and
 * `observability-auditor` only has to compare `contract.ts` against the
 * design once.
 *
 * ## What this test does
 *
 * 1. **Task 10.1** ("Declared telemetry is emitted"): drives every one of the
 *    12 public catalog operations, through the real, in-process API router
 *    (`../api/router.ts`'s `createCatalogRouter`, called with
 *    `createRouterClient`, design D2 — never an HTTP listener), once on the
 *    happy path and once per applicable `CATALOG_*` error class (validation,
 *    not found, already exists, version conflict, reference violation,
 *    schema incompatible, reserved identifier, limit exceeded, context
 *    required), plus a forced, unmapped Postgres constraint error for the
 *    tenth, `internal`, class. Every span and metric `contract.ts` declares
 *    is then asserted present with its required attributes (and its
 *    conditional attributes, on the specific scenario whose condition makes
 *    them apply), and every log event is asserted present with its declared
 *    attributes.
 * 2. **Task 10.2** (cardinality guard): every metric data point captured
 *    during the whole run carries only attribute keys from that metric's
 *    *complete* allowed set in `contract.ts` — no more, no fewer keys than
 *    declared are permitted as extras. An undeclared key (design.md's own
 *    example, `tayzu.catalog.entity.identifier`) fails this test.
 * 3. **Task 10.3** (marker leak, spec "Property values never reach
 *    telemetry"): creates an entity with a property value
 *    `"secret-marker-123"` and a title `"Title-marker-456"`, forces a real,
 *    unmapped database constraint error on a later write of that same
 *    entity, and asserts neither marker string appears anywhere in any
 *    exported span (name, attribute, or event — including the raw `pg.*`
 *    spans `@opentelemetry/instrumentation-pg` emits, task 1.4's deferred
 *    check), metric attribute, or log record (body or attributes), across
 *    the *entire* run, not just this scenario's own slice.
 *
 * ## Why a real Postgres constraint error, forced without touching production code
 *
 * Every mutating operation's handler ends with `appendChangeEvent`
 * (`../persistence/change-events.ts`), whose own insert has no
 * `throwMappedXError` catching it (design D9's constraint-name mapping only
 * ever covers a write's *own* table). `forceChangeEventPkCollision` below
 * reads the tenant's current `catalog_tenant_sequence.last_seq` and plants a
 * phantom `catalog_change_event` row at exactly the `seq` value the next
 * mutation's own `appendChangeEvent` will compute and try to insert. That
 * insert then collides on the real `catalog_change_event_pkey` (tenant_id,
 * seq) constraint — a genuine, unmapped Postgres error (design D3 step 5) —
 * deterministically, on a brand-new tenant that has not mutated anything
 * else yet, with no timing race and no change to any production file.
 *
 * ## Import order (design D1)
 *
 * `../service/__fixtures__/registered-harness.js` registers the telemetry
 * test harness — and, inside it, constructs `PgInstrumentation` — while this
 * file's module graph loads. It must be the first same-package import below:
 * `@tayzu/db` (`runMigrations`) and
 * `../service/__fixtures__/blueprint-test-helpers.js` (via
 * `drizzle-orm/node-postgres`) both transitively load the `pg` module, and
 * `../api/router.ts` -> `../service/blueprints.ts` / `../service/entities.ts`
 * -> `../service/pipeline.ts` -> `../telemetry/instruments.ts` all create
 * their tracer, meter instruments and logger at import time: the OTel
 * metrics API has no proxy meter provider, so any of that happening before
 * registration would make every later instrument a permanent no-op.
 */
import { ADMIN_PRINCIPAL, authz } from '../service/__fixtures__/authz-test-helpers.js';
import {
  registration,
  type TelemetryTestHarness,
} from '../service/__fixtures__/registered-harness.js';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { createRouterClient } from '@orpc/server';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from '../service/__fixtures__/blueprint-test-helpers.js';
import {
  finishedLogRecords,
  finishedSpans,
  sumDataPoints,
} from '../service/__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import { isCatalogError } from '../domain/errors.js';
import { createBlueprintService, type BlueprintService } from '../service/blueprints.js';
import { createEntityService, type EntityService } from '../service/entities.js';
import { createCatalogRouter } from '../api/router.js';
import {
  COMMON_OPERATION_SPAN_ATTRIBUTES,
  LOG_EVENTS,
  METRICS,
  SPANS,
  type LogEventContract,
} from './contract.js';

type SpanExporterLike = TelemetryTestHarness['spanExporter'];
type ReadableSpanLike = ReturnType<SpanExporterLike['getFinishedSpans']>[number];
type MetricExporterLike = TelemetryTestHarness['metricExporter'];

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'smoke-user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor, principal: ADMIN_PRINCIPAL };
}

/** Every data point of `name`, across every metric export collected so far, regardless of instrument type. */
function allMetricDataPointAttributes(exporter: MetricExporterLike, name: string): Attributes[] {
  const attributes: Attributes[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name === name) {
          for (const dataPoint of metric.dataPoints) {
            attributes.push(dataPoint.attributes);
          }
        }
      }
    }
  }
  return attributes;
}

const SEVERITY_NUMBER_BY_NAME: Record<LogEventContract['severity'], SeverityNumber> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

/**
 * `catalog.audit.mutation`'s on-behalf-of attributes are documented in
 * design.md as present "when present" (an actor delegate), not on every
 * record. None of this file's scenarios use `actor.onBehalfOf`, so they are
 * the only two declared attribute keys this test does not require present on
 * every captured record of that event.
 */
const CONDITIONAL_LOG_ATTRIBUTES: ReadonlySet<string> = new Set([
  'tayzu.actor.on_behalf_of.type',
  'tayzu.actor.on_behalf_of.id',
]);

/** Tracks new spans of `name` appended after this call, without depending on a `forceFlush()` (`SimpleSpanProcessor` exports synchronously on `span.end()`). */
function spanTracker(exporter: SpanExporterLike, name: string): () => ReadableSpanLike {
  const startIndex = finishedSpans(exporter, name).length;
  return () => {
    const spans = finishedSpans(exporter, name);
    const span = spans[startIndex];
    if (span === undefined) {
      throw new Error(
        `expected a new "${name}" span to have been captured since this tracker started`,
      );
    }
    return span;
  };
}

/** As above, for a single new log record of `eventName`. */
function logTracker(
  exporter: TelemetryTestHarness['logExporter'],
  eventName: string,
): () => ReturnType<TelemetryTestHarness['logExporter']['getFinishedLogRecords']>[number] {
  const startIndex = finishedLogRecords(exporter, eventName).length;
  return () => {
    const records = finishedLogRecords(exporter, eventName);
    const record = records[startIndex];
    if (record === undefined) {
      throw new Error(
        `expected a new "${eventName}" log record to have been captured since this tracker started`,
      );
    }
    return record;
  };
}

/** design.md, "Blueprint" table: a trivial relation target with no properties or relations of its own. */
function teamDefinition() {
  return {
    identifier: 'team',
    title: { en: 'Team' },
    schema: { properties: {}, required: [] },
  };
}

interface WidgetDefinitionOptions {
  /** Default `true`: a required `name` string property. */
  readonly includeName?: boolean;
  /** Default `false`: an additional, always-optional `note` string property. */
  readonly includeNote?: boolean;
}

/**
 * The main entity blueprint this file drives almost every entity operation
 * against: a `name` (required, by default) and `tag` (always optional)
 * property, a `health` status property, and an optional `owner` relation to
 * `team()`. `includeName: false` is what task 7.4/D7's "removing a property
 * that has values is incompatible" scenario needs to force
 * `CATALOG_SCHEMA_INCOMPATIBLE`.
 */
function widgetDefinition(options: WidgetDefinitionOptions = {}) {
  const includeName = options.includeName ?? true;
  const includeNote = options.includeNote ?? false;

  const properties: Record<string, unknown> = {
    tag: { type: 'string', title: { en: 'Tag' } },
  };
  const required: string[] = [];
  if (includeName) {
    properties['name'] = { type: 'string', title: { en: 'Name' } };
    required.push('name');
  }
  if (includeNote) {
    properties['note'] = { type: 'string', title: { en: 'Note' } };
  }

  return {
    identifier: 'widget',
    title: { en: 'Widget' },
    schema: { properties, required },
    statusSchema: {
      properties: { health: { type: 'string', title: { en: 'Health' } } },
      required: [],
    },
    relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false } },
  };
}

/**
 * Forces a genuine, unmapped Postgres constraint error on `tenantId`'s next
 * mutation (see the module doc comment's "Why a real Postgres constraint
 * error" section): plants a phantom `catalog_change_event` row occupying the
 * exact `seq` value `appendChangeEvent`'s own `nextSeq()` will compute for
 * this tenant's very next mutation, so that mutation's own insert into
 * `catalog_change_event` collides on `catalog_change_event_pkey` (tenant_id,
 * seq). Call this immediately before the one operation call that must fail,
 * against a tenant that has not mutated anything else since.
 */
async function forceChangeEventPkCollision(
  pool: TestDb['$client'],
  tenantId: string,
): Promise<void> {
  const { rows } = await pool.query<{ last_seq: string }>(
    'select last_seq from catalog_tenant_sequence where tenant_id = $1',
    [tenantId],
  );
  const currentLastSeq = rows[0] ? BigInt(rows[0].last_seq) : 0n;
  const nextSeq = (currentLastSeq + 1n).toString();

  await pool.query(
    `insert into catalog_change_event
       (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
        blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
     values
       ($1, $2, now(), 'system', 'sys', 'created', 'entity', 'phantom', 'phantom', 1, '{}'::text[], '{}'::jsonb)`,
    [tenantId, nextSeq],
  );
}

describe('otel-smoke-check (tasks 10.1, 10.2, 10.3; design.md "Observability contract"; spec "Telemetry contract")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createCatalogRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    // Migrations need the owner connection: tayzu_app has no DDL privilege
    // (task 6.3, design D6 Q1a). `db` is also `forceChangeEventPkCollision`'s
    // connection below: that helper runs raw selects/inserts outside
    // withTenantTransaction, with no app.tenant_id session setting, so the
    // owner connection is the only one that can see and plant those rows
    // under RLS.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    harness = registeredHarness();

    // The services under test run through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
    const blueprints: BlueprintService = createBlueprintService({ pool, authz });
    const entities: EntityService = createEntityService({ pool, authz });
    const router = createCatalogRouter({ blueprints, entities });
    client = createRouterClient(router, { context: (raw: Record<string, unknown>) => raw });
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('runs every operation once successfully and once per applicable error class, and every declared span, metric and log event is observed with its required (and, where the condition holds, conditional) attributes (spec "Declared telemetry is emitted"; task 10.1)', async () => {
    const tenantId = randomTenantId();
    const hostContext = ctx(tenantId);

    // ---------------------------------------------------------------
    // Success matrix: every one of the 12 procedures, plus every child
    // span's trigger condition (a compiled validator's entity write, a
    // blueprint update, a relation write).
    // ---------------------------------------------------------------

    // 1. blueprints.create (team: the relation target).
    const captureTeamCreate = spanTracker(harness.spanExporter, 'catalog.blueprint.create');
    await client.blueprints.create(teamDefinition(), { context: hostContext });
    const teamCreateSpan = captureTeamCreate();
    expect(teamCreateSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('team');
    for (const key of COMMON_OPERATION_SPAN_ATTRIBUTES) {
      expect(
        teamCreateSpan.attributes[key],
        `catalog.blueprint.create missing common attribute ${key}`,
      ).not.toBeUndefined();
    }

    // 1 (again). blueprints.create (widget: the main entity blueprint).
    const captureWidgetCreate = spanTracker(harness.spanExporter, 'catalog.blueprint.create');
    const widgetV1 = await client.blueprints.create(widgetDefinition(), { context: hostContext });
    captureWidgetCreate();
    expect(widgetV1.version).toBe(1);

    // 2. blueprints.get
    const captureGet = spanTracker(harness.spanExporter, 'catalog.blueprint.get');
    await client.blueprints.get({ identifier: 'widget' }, { context: hostContext });
    const getSpan = captureGet();
    expect(getSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('widget');

    // 3. blueprints.list -- conditional tayzu.catalog.result.count.
    const captureList = spanTracker(harness.spanExporter, 'catalog.blueprint.list');
    const blueprintPage = await client.blueprints.list({ pageSize: 10 }, { context: hostContext });
    const listSpan = captureList();
    expect(blueprintPage.items.map((item) => item.identifier)).toEqual(
      expect.arrayContaining(['team', 'widget']),
    );
    expect(listSpan.attributes['tayzu.catalog.page.size']).toBe(10);
    expect(listSpan.attributes['tayzu.catalog.result.count']).toBe(blueprintPage.items.length);

    // 5 (before 4). entities.create -- the relation targets.
    const captureTeamACreate = spanTracker(harness.spanExporter, 'catalog.entity.create');
    await client.entities.create(
      { blueprint: 'team', identifier: 'team-a', title: 'Team A' },
      { context: hostContext },
    );
    const teamACreateSpan = captureTeamACreate();
    // No relation on `team`: the conditional attribute, and the child
    // `catalog.relations.resolve` span, are both correctly absent here.
    expect(teamACreateSpan.attributes['tayzu.catalog.relation.target.count']).toBeUndefined();

    await client.entities.create(
      { blueprint: 'team', identifier: 'team-b', title: 'Team B' },
      { context: hostContext },
    );

    // 5 (again). entities.create (widget-1) -- a relation is written:
    // conditional tayzu.catalog.relation.target.count on the create span,
    // the child catalog.entity.validate span, and the child
    // catalog.relations.resolve span.
    const captureWidget1Create = spanTracker(harness.spanExporter, 'catalog.entity.create');
    const captureValidate = spanTracker(harness.spanExporter, 'catalog.entity.validate');
    const captureResolve = spanTracker(harness.spanExporter, 'catalog.relations.resolve');
    await client.entities.create(
      {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { properties: { name: 'Widget One', tag: 'alpha' }, relations: { owner: 'team-a' } },
      },
      { context: hostContext },
    );
    const widget1CreateSpan = captureWidget1Create();
    const validateSpan = captureValidate();
    const resolveSpan = captureResolve();
    expect(widget1CreateSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('widget');
    expect(widget1CreateSpan.attributes['tayzu.catalog.entity.identifier']).toBe('widget-1');
    expect(widget1CreateSpan.attributes['tayzu.catalog.relation.target.count']).toBe(1);
    expect(validateSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('widget');
    // A successful validation: the conditional issue-count attribute is
    // correctly absent.
    expect(validateSpan.attributes['tayzu.catalog.validation.issue.count']).toBeUndefined();
    expect(resolveSpan.attributes['tayzu.catalog.relation.target.count']).toBe(1);
    expect(resolveSpan.attributes['tayzu.catalog.relation.missing.count']).toBeUndefined();

    // 6. entities.get
    const captureEntityGet = spanTracker(harness.spanExporter, 'catalog.entity.get');
    await client.entities.get(
      { blueprint: 'widget', identifier: 'widget-1' },
      { context: hostContext },
    );
    const entityGetSpan = captureEntityGet();
    expect(entityGetSpan.attributes['tayzu.catalog.entity.identifier']).toBe('widget-1');

    // 7. entities.list -- conditional tayzu.catalog.result.count.
    const captureEntityList = spanTracker(harness.spanExporter, 'catalog.entity.list');
    const entityPage = await client.entities.list(
      { blueprint: 'widget', pageSize: 10 },
      { context: hostContext },
    );
    const entityListSpan = captureEntityList();
    expect(entityListSpan.attributes['tayzu.catalog.result.count']).toBe(entityPage.items.length);
    expect(entityPage.items.length).toBeGreaterThan(0);

    // 8. entities.upsert -- created, then updated, then unchanged: the
    // conditional tayzu.catalog.mutation attribute must record all three
    // (design.md: "(`created`|`updated`|`unchanged`)").
    const captureUpsertCreated = spanTracker(harness.spanExporter, 'catalog.entity.upsert');
    const widget2Created = await client.entities.upsert(
      {
        blueprint: 'widget',
        identifier: 'widget-2',
        title: 'Widget Two',
        mode: 'replace',
        spec: { properties: { name: 'Widget Two' }, relations: { owner: 'team-b' } },
      },
      { context: hostContext },
    );
    const upsertCreatedSpan = captureUpsertCreated();
    expect(widget2Created.outcome).toBe('created');
    expect(upsertCreatedSpan.attributes['tayzu.catalog.upsert.mode']).toBe('replace');
    expect(upsertCreatedSpan.attributes['tayzu.catalog.mutation']).toBe('created');

    const captureUpsertUpdated = spanTracker(harness.spanExporter, 'catalog.entity.upsert');
    const widget2Updated = await client.entities.upsert(
      {
        blueprint: 'widget',
        identifier: 'widget-2',
        title: 'Widget Two',
        mode: 'replace',
        spec: { properties: { name: 'Widget Two', tag: 'beta' }, relations: { owner: 'team-b' } },
      },
      { context: hostContext },
    );
    const upsertUpdatedSpan = captureUpsertUpdated();
    expect(widget2Updated.outcome).toBe('updated');
    expect(upsertUpdatedSpan.attributes['tayzu.catalog.mutation']).toBe('updated');

    const captureUpsertUnchanged = spanTracker(harness.spanExporter, 'catalog.entity.upsert');
    const widget2Unchanged = await client.entities.upsert(
      {
        blueprint: 'widget',
        identifier: 'widget-2',
        title: 'Widget Two',
        mode: 'replace',
        spec: { properties: { name: 'Widget Two', tag: 'beta' }, relations: { owner: 'team-b' } },
      },
      { context: hostContext },
    );
    const upsertUnchangedSpan = captureUpsertUnchanged();
    expect(widget2Unchanged.outcome).toBe('unchanged');
    // This is the enumerated 'unchanged' value design.md's own Spans table
    // names for this exact attribute -- not an optional extra, but one of
    // the three values the conditional attribute must be able to record.
    expect(
      upsertUnchangedSpan.attributes['tayzu.catalog.mutation'],
      'catalog.entity.upsert must record tayzu.catalog.mutation = "unchanged" on an idempotent upsert, exactly as it does for "created" and "updated"',
    ).toBe('unchanged');

    // 9. entities.writeStatus -- relations are written: conditional
    // tayzu.catalog.relation.target.count.
    const captureStatusWrite = spanTracker(harness.spanExporter, 'catalog.entity.status.write');
    const widget2Status = await client.entities.writeStatus(
      {
        blueprint: 'widget',
        identifier: 'widget-2',
        properties: { health: 'green' },
        relations: { owner: 'team-b' },
        observedGeneration: widget2Updated.generation,
        source: 'github',
      },
      { context: hostContext },
    );
    const statusWriteSpan = captureStatusWrite();
    expect(statusWriteSpan.attributes['tayzu.catalog.status.source']).toBe('github');
    expect(statusWriteSpan.attributes['tayzu.catalog.relation.target.count']).toBe(1);
    expect(widget2Status.status?.properties['health']).toBe('green');

    // 10. entities.listRelated -- conditional tayzu.catalog.result.count.
    const captureRelatedList = spanTracker(harness.spanExporter, 'catalog.entity.related.list');
    const related = await client.entities.listRelated(
      { blueprint: 'widget', identifier: 'widget-2', direction: 'forward' },
      { context: hostContext },
    );
    const relatedListSpan = captureRelatedList();
    expect(relatedListSpan.attributes['tayzu.catalog.related.direction']).toBe('forward');
    expect(relatedListSpan.attributes['tayzu.catalog.related.scope']).toBe('both');
    expect(related.items.length).toBeGreaterThan(0);
    expect(relatedListSpan.attributes['tayzu.catalog.result.count']).toBe(related.items.length);

    // 11. entities.delete, with detachReferences -- conditional
    // tayzu.catalog.detached.count: widget-1's optional `owner` relation to
    // team-a is detached.
    const captureDetachDelete = spanTracker(harness.spanExporter, 'catalog.entity.delete');
    await client.entities.delete(
      { blueprint: 'team', identifier: 'team-a', detachReferences: true },
      { context: hostContext },
    );
    const detachDeleteSpan = captureDetachDelete();
    expect(detachDeleteSpan.attributes['tayzu.catalog.detach_references']).toBe(true);
    expect(detachDeleteSpan.attributes['tayzu.catalog.detached.count']).toBe(1);

    // entities.create + entities.delete, without detachReferences: the
    // conditional detached.count is correctly absent.
    await client.entities.create(
      {
        blueprint: 'widget',
        identifier: 'widget-scratch',
        title: 'Scratch Widget',
        spec: { properties: { name: 'Scratch' } },
      },
      { context: hostContext },
    );
    const captureScratchDelete = spanTracker(harness.spanExporter, 'catalog.entity.delete');
    await client.entities.delete(
      { blueprint: 'widget', identifier: 'widget-scratch' },
      { context: hostContext },
    );
    const scratchDeleteSpan = captureScratchDelete();
    expect(scratchDeleteSpan.attributes['tayzu.catalog.detach_references']).toBe(false);
    expect(scratchDeleteSpan.attributes['tayzu.catalog.detached.count']).toBeUndefined();

    // 12. blueprints.delete (an unreferenced, throwaway blueprint).
    await client.blueprints.create(
      { identifier: 'scratch', title: { en: 'Scratch' }, schema: { properties: {}, required: [] } },
      { context: hostContext },
    );
    const captureBlueprintDelete = spanTracker(harness.spanExporter, 'catalog.blueprint.delete');
    await client.blueprints.delete({ identifier: 'scratch' }, { context: hostContext });
    const blueprintDeleteSpan = captureBlueprintDelete();
    expect(blueprintDeleteSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('scratch');

    // 4. blueprints.update -- a compatible change (adds an optional
    // property): the child catalog.blueprint.compatibility_check span
    // records entities_checked, and its conditional violation.count is
    // correctly absent, since nothing is incompatible.
    const captureUpdate = spanTracker(harness.spanExporter, 'catalog.blueprint.update');
    const captureCompatibilityCheck = spanTracker(
      harness.spanExporter,
      'catalog.blueprint.compatibility_check',
    );
    const widgetV2 = await client.blueprints.update(
      { ...widgetDefinition({ includeNote: true }), expectedVersion: widgetV1.version },
      { context: hostContext },
    );
    const updateSpan = captureUpdate();
    const compatibilityCheckSpan = captureCompatibilityCheck();
    expect(widgetV2.version).toBe(widgetV1.version + 1);
    expect(updateSpan.attributes['tayzu.catalog.blueprint.identifier']).toBe('widget');
    expect(updateSpan.attributes['tayzu.catalog.compatibility.violation.count']).toBeUndefined();
    expect(
      compatibilityCheckSpan.attributes['tayzu.catalog.compatibility.entities_checked'],
    ).toBeGreaterThanOrEqual(2);
    expect(
      compatibilityCheckSpan.attributes['tayzu.catalog.compatibility.violation.count'],
    ).toBeUndefined();

    // ---------------------------------------------------------------
    // Error matrix: one scenario per applicable CATALOG_* code, plus the
    // context-required rejection (no span at all) and the forced,
    // unmapped internal error (below, its own scenario).
    // ---------------------------------------------------------------

    // context required (no span starts at all, design D3 step 1).
    const blueprintListSpansBefore = finishedSpans(
      harness.spanExporter,
      'catalog.blueprint.list',
    ).length;
    await expectCatalogErrorCode(
      client.blueprints.list({ pageSize: 1 }, { context: {} }),
      'CATALOG_CONTEXT_REQUIRED',
    );
    expect(finishedSpans(harness.spanExporter, 'catalog.blueprint.list')).toHaveLength(
      blueprintListSpansBefore,
    );
    // (tayzu.catalog.context.rejections is asserted below, generically,
    // against the flushed exporter at the end of this test.)

    // validation failed (a leading digit is an invalid blueprint identifier).
    const captureValidationError = spanTracker(harness.spanExporter, 'catalog.blueprint.create');
    const validationError = await expectCatalogErrorCode(
      client.blueprints.create(
        { identifier: '1bad', title: { en: 'Bad' }, schema: { properties: {}, required: [] } },
        { context: hostContext },
      ),
      'CATALOG_VALIDATION_FAILED',
    );
    const validationErrorSpan = captureValidationError();
    expect(validationErrorSpan.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(validationErrorSpan.attributes['error.type']).toBe('CATALOG_VALIDATION_FAILED');
    expect(validationError.code).toBe('CATALOG_VALIDATION_FAILED');

    // not found.
    const captureNotFound = spanTracker(harness.spanExporter, 'catalog.blueprint.get');
    await expectCatalogErrorCode(
      client.blueprints.get({ identifier: 'does-not-exist' }, { context: hostContext }),
      'CATALOG_NOT_FOUND',
    );
    const notFoundSpan = captureNotFound();
    expect(notFoundSpan.attributes['error.type']).toBe('CATALOG_NOT_FOUND');

    // already exists.
    const captureAlreadyExists = spanTracker(harness.spanExporter, 'catalog.blueprint.create');
    await expectCatalogErrorCode(
      client.blueprints.create(
        {
          identifier: 'team',
          title: { en: 'Duplicate' },
          schema: { properties: {}, required: [] },
        },
        { context: hostContext },
      ),
      'CATALOG_ALREADY_EXISTS',
    );
    const alreadyExistsSpan = captureAlreadyExists();
    expect(alreadyExistsSpan.attributes['error.type']).toBe('CATALOG_ALREADY_EXISTS');

    // version conflict.
    const captureVersionConflict = spanTracker(harness.spanExporter, 'catalog.blueprint.update');
    await expectCatalogErrorCode(
      client.blueprints.update(
        { ...widgetDefinition({ includeNote: true }), expectedVersion: 999 },
        { context: hostContext },
      ),
      'CATALOG_VERSION_CONFLICT',
    );
    const versionConflictSpan = captureVersionConflict();
    expect(versionConflictSpan.attributes['error.type']).toBe('CATALOG_VERSION_CONFLICT');

    // reference violation (blueprint-level: a relation to a nonexistent target blueprint).
    const captureBlueprintRefViolation = spanTracker(
      harness.spanExporter,
      'catalog.blueprint.create',
    );
    await expectCatalogErrorCode(
      client.blueprints.create(
        {
          identifier: 'orphan',
          title: { en: 'Orphan' },
          schema: { properties: {}, required: [] },
          relations: {
            link: {
              title: { en: 'Link' },
              target: 'does-not-exist-blueprint',
              many: false,
              required: false,
            },
          },
        },
        { context: hostContext },
      ),
      'CATALOG_REFERENCE_VIOLATION',
    );
    const blueprintRefViolationSpan = captureBlueprintRefViolation();
    expect(blueprintRefViolationSpan.attributes['error.type']).toBe('CATALOG_REFERENCE_VIOLATION');

    // reference violation (entity-level: a relation to a nonexistent target
    // entity), which also exercises catalog.relations.resolve's conditional
    // tayzu.catalog.relation.missing.count.
    const captureEntityRefViolation = spanTracker(harness.spanExporter, 'catalog.entity.create');
    const captureMissingResolve = spanTracker(harness.spanExporter, 'catalog.relations.resolve');
    await expectCatalogErrorCode(
      client.entities.create(
        {
          blueprint: 'widget',
          identifier: 'bad-relation-entity',
          title: 'Bad Relation',
          spec: { properties: { name: 'X' }, relations: { owner: 'does-not-exist-team' } },
        },
        { context: hostContext },
      ),
      'CATALOG_REFERENCE_VIOLATION',
    );
    const entityRefViolationSpan = captureEntityRefViolation();
    const missingResolveSpan = captureMissingResolve();
    expect(entityRefViolationSpan.attributes['error.type']).toBe('CATALOG_REFERENCE_VIOLATION');
    expect(missingResolveSpan.attributes['tayzu.catalog.relation.missing.count']).toBe(1);

    // schema incompatible (spec "Removing a property that has values is
    // incompatible": widget-1 and widget-2 both still have a value for
    // `name`), which also exercises the child compatibility_check span's
    // conditional violation.count.
    const captureIncompatibleUpdate = spanTracker(harness.spanExporter, 'catalog.blueprint.update');
    const captureIncompatibleCheck = spanTracker(
      harness.spanExporter,
      'catalog.blueprint.compatibility_check',
    );
    const incompatibleError = await expectCatalogErrorCode(
      client.blueprints.update(
        {
          ...widgetDefinition({ includeName: false, includeNote: true }),
          expectedVersion: widgetV2.version,
        },
        { context: hostContext },
      ),
      'CATALOG_SCHEMA_INCOMPATIBLE',
    );
    const incompatibleUpdateSpan = captureIncompatibleUpdate();
    const incompatibleCheckSpan = captureIncompatibleCheck();
    expect(incompatibleUpdateSpan.attributes['error.type']).toBe('CATALOG_SCHEMA_INCOMPATIBLE');
    expect(
      incompatibleUpdateSpan.attributes['tayzu.catalog.compatibility.violation.count'],
    ).toBeGreaterThan(0);
    expect(
      incompatibleCheckSpan.attributes['tayzu.catalog.compatibility.violation.count'],
    ).toBeGreaterThan(0);
    expect(incompatibleError.details?.['violations']).toBeDefined();

    // reserved identifier -- also emits the WARN log
    // catalog.security.reserved_identifier_denied.
    const captureReserved = spanTracker(harness.spanExporter, 'catalog.blueprint.create');
    const captureReservedLog = logTracker(
      harness.logExporter,
      'catalog.security.reserved_identifier_denied',
    );
    await expectCatalogErrorCode(
      client.blueprints.create(
        {
          identifier: '_reserved',
          title: { en: 'Reserved' },
          schema: { properties: {}, required: [] },
        },
        { context: hostContext },
      ),
      'CATALOG_RESERVED_IDENTIFIER',
    );
    const reservedSpan = captureReserved();
    const reservedLog = captureReservedLog();
    expect(reservedSpan.attributes['error.type']).toBe('CATALOG_RESERVED_IDENTIFIER');
    expect(reservedLog.severityNumber).toBe(SeverityNumber.WARN);
    expect(reservedLog.attributes['tayzu.catalog.blueprint.identifier']).toBe('_reserved');

    // limit exceeded (page size over the default 500 limit).
    const captureLimitExceeded = spanTracker(harness.spanExporter, 'catalog.blueprint.list');
    await expectCatalogErrorCode(
      client.blueprints.list({ pageSize: 501 }, { context: hostContext }),
      'CATALOG_LIMIT_EXCEEDED',
    );
    const limitExceededSpan = captureLimitExceeded();
    expect(limitExceededSpan.attributes['error.type']).toBe('CATALOG_LIMIT_EXCEEDED');

    // validation failed (entity-level: an entity property fails the
    // compiled Ajv schema), which also exercises catalog.entity.validate's
    // conditional tayzu.catalog.validation.issue.count.
    const captureEntityValidationError = spanTracker(harness.spanExporter, 'catalog.entity.create');
    const captureFailedValidate = spanTracker(harness.spanExporter, 'catalog.entity.validate');
    await expectCatalogErrorCode(
      client.entities.create(
        {
          blueprint: 'widget',
          identifier: 'bad-entity',
          title: 'Bad',
          spec: { properties: { name: 123 } },
        },
        { context: hostContext },
      ),
      'CATALOG_VALIDATION_FAILED',
    );
    const entityValidationErrorSpan = captureEntityValidationError();
    const failedValidateSpan = captureFailedValidate();
    expect(entityValidationErrorSpan.attributes['error.type']).toBe('CATALOG_VALIDATION_FAILED');
    expect(failedValidateSpan.attributes['tayzu.catalog.validation.issue.count']).toBeGreaterThan(
      0,
    );

    // ---------------------------------------------------------------
    // internal (a forced, unmapped Postgres constraint error), in its own
    // fresh tenant so `forceChangeEventPkCollision` can compute the next
    // seq deterministically.
    // ---------------------------------------------------------------
    const internalTenantId = randomTenantId();
    const internalContext = ctx(internalTenantId);
    await client.blueprints.create(
      {
        identifier: 'gadget',
        title: { en: 'Gadget' },
        schema: { properties: { note: { type: 'string', title: { en: 'Note' } } }, required: [] },
      },
      { context: internalContext },
    );
    await client.entities.create(
      {
        blueprint: 'gadget',
        identifier: 'gadget-1',
        title: 'Gadget One',
        spec: { properties: { note: 'x' } },
      },
      { context: internalContext },
    );
    await forceChangeEventPkCollision(db.$client, internalTenantId);

    const captureInternalUpsert = spanTracker(harness.spanExporter, 'catalog.entity.upsert');
    const captureInternalLog = logTracker(harness.logExporter, 'catalog.internal_error');
    const internalThrown = await client.entities
      .upsert(
        {
          blueprint: 'gadget',
          identifier: 'gadget-1',
          title: 'Gadget One',
          mode: 'replace',
          spec: { properties: { note: 'y' } },
        },
        { context: internalContext },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(internalThrown, 'the forced constraint error must reject the call').toBeDefined();
    expect(
      isCatalogError(internalThrown),
      'an unmapped database error must not be fabricated into a CatalogError',
    ).toBe(false);

    const internalUpsertSpan = captureInternalUpsert();
    const internalLog = captureInternalLog();
    expect(internalUpsertSpan.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    expect(internalUpsertSpan.attributes['error.type']).toBe('internal');
    const internalExceptionEvents = internalUpsertSpan.events.filter(
      (event) => event.name === 'exception',
    );
    expect(internalExceptionEvents).toHaveLength(1);
    expect(Object.keys(internalExceptionEvents[0]?.attributes ?? {}).sort()).toEqual(
      [
        'db.response.status_code',
        'exception.stacktrace',
        'exception.type',
        'tayzu.db.constraint',
      ].sort(),
    );
    expect(internalLog.severityNumber).toBe(SeverityNumber.ERROR);
    expect(internalLog.attributes['exception.type']).toBeDefined();

    // ---------------------------------------------------------------
    // Contract-driven completeness sweep (design.md, "Observability
    // contract"; the executable mirror is contract.ts). This is what makes
    // "removing one span in a scratch branch" (task 10.1's Verify clause)
    // fail: every name SPANS/METRICS/LOG_EVENTS declares must have been
    // observed at least once by this point, with its required attributes
    // (plus the common operation-span attributes, for an 'operation' span).
    // ---------------------------------------------------------------
    await harness.forceFlush();

    for (const spanContract of SPANS) {
      const spans = finishedSpans(harness.spanExporter, spanContract.name);
      expect(
        spans.length,
        `expected at least one span named "${spanContract.name}" (contract.ts)`,
      ).toBeGreaterThan(0);
      const span = spans[spans.length - 1];
      if (span === undefined) throw new Error('unreachable: length was just asserted > 0');
      const requiredKeys =
        spanContract.kind === 'operation'
          ? [...COMMON_OPERATION_SPAN_ATTRIBUTES, ...spanContract.requiredAttributes]
          : spanContract.requiredAttributes;
      for (const key of requiredKeys) {
        expect(
          span.attributes[key],
          `span "${spanContract.name}" is missing required attribute "${key}"`,
        ).not.toBeUndefined();
      }
    }

    for (const metricContract of METRICS) {
      const points = allMetricDataPointAttributes(harness.metricExporter, metricContract.name);
      expect(
        points.length,
        `expected at least one "${metricContract.name}" metric data point (contract.ts)`,
      ).toBeGreaterThan(0);
    }

    for (const logEventContract of LOG_EVENTS) {
      const records = finishedLogRecords(harness.logExporter, logEventContract.name);
      expect(
        records.length,
        `expected at least one "${logEventContract.name}" log record (contract.ts)`,
      ).toBeGreaterThan(0);
      const record = records[records.length - 1];
      if (record === undefined) throw new Error('unreachable: length was just asserted > 0');
      expect(record.severityNumber, `log "${logEventContract.name}" has the wrong severity`).toBe(
        SEVERITY_NUMBER_BY_NAME[logEventContract.severity],
      );
      for (const key of logEventContract.attributes) {
        if (CONDITIONAL_LOG_ATTRIBUTES.has(key)) continue;
        expect(
          record.attributes[key],
          `log "${logEventContract.name}" is missing declared attribute "${key}"`,
        ).not.toBeUndefined();
      }
    }

    // Named anchor checks for the two counters this test's error scenarios
    // specifically drove (design.md, Metrics table: allowed error.type
    // values), in addition to the generic sweep above.
    const rejectionPoints = sumDataPoints(
      harness.metricExporter,
      'tayzu.catalog.context.rejections',
    );
    expect(
      rejectionPoints.some(
        (point) =>
          point.attributes['tayzu.catalog.operation'] === 'blueprint.list' &&
          point.attributes['tayzu.catalog.context.reason'] === 'missing_tenant',
      ),
      'expected a tayzu.catalog.context.rejections data point for the context-required rejection above',
    ).toBe(true);

    const validationFailurePoints = sumDataPoints(
      harness.metricExporter,
      'tayzu.catalog.validation.failures',
    );
    for (const expectedErrorType of [
      'CATALOG_VALIDATION_FAILED',
      'CATALOG_REFERENCE_VIOLATION',
      'CATALOG_SCHEMA_INCOMPATIBLE',
      'CATALOG_LIMIT_EXCEEDED',
      'CATALOG_RESERVED_IDENTIFIER',
    ]) {
      expect(
        validationFailurePoints.some(
          (point) => point.attributes['error.type'] === expectedErrorType,
        ),
        `expected a tayzu.catalog.validation.failures data point with error.type = ${expectedErrorType}`,
      ).toBe(true);
    }
  }, 120_000);

  it('every metric data point carries only attribute keys in its declared allowed set — the cardinality guard (design.md, "Cardinality budget"; task 10.2)', async () => {
    // Reads the cumulative state the previous test already flushed
    // (the harness is never reset() in this file): every data point
    // recorded by *any* of the scenarios above is in scope.
    await harness.forceFlush();

    for (const metricContract of METRICS) {
      const points = allMetricDataPointAttributes(harness.metricExporter, metricContract.name);
      for (const attributes of points) {
        for (const key of Object.keys(attributes)) {
          expect(
            metricContract.attributes,
            `metric "${metricContract.name}" carries the undeclared attribute key "${key}". ` +
              `Its complete allowed set (contract.ts) is [${metricContract.attributes.join(', ')}].`,
          ).toContain(key);
        }
      }
    }
  });

  it('property values never reach any exported span, metric or log, including after a forced database constraint error (spec "Property values never reach telemetry"; task 10.3)', async () => {
    const MARKER_PROPERTY_VALUE = 'secret-marker-123';
    const MARKER_TITLE = 'Title-marker-456';

    const tenantId = randomTenantId();
    const hostContext = ctx(tenantId);

    await client.blueprints.create(
      {
        identifier: 'marker-bp',
        title: { en: 'Marker' },
        schema: {
          properties: { secretText: { type: 'string', title: { en: 'Secret' } } },
          required: [],
        },
      },
      { context: hostContext },
    );
    await client.entities.create(
      {
        blueprint: 'marker-bp',
        identifier: 'marker-entity',
        title: MARKER_TITLE,
        spec: { properties: { secretText: MARKER_PROPERTY_VALUE } },
      },
      { context: hostContext },
    );

    // Force a real, unmapped database constraint error on the *next*
    // write of this same entity (see forceChangeEventPkCollision's doc
    // comment).
    await forceChangeEventPkCollision(db.$client, tenantId);

    const thrown = await client.entities
      .upsert(
        {
          blueprint: 'marker-bp',
          identifier: 'marker-entity',
          title: MARKER_TITLE,
          mode: 'replace',
          spec: { properties: { secretText: `${MARKER_PROPERTY_VALUE}-updated` } },
        },
        { context: hostContext },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown, 'the forced constraint error must reject the call').toBeDefined();
    expect(
      isCatalogError(thrown),
      'an unmapped database error must not be fabricated into a CatalogError',
    ).toBe(false);

    await harness.forceFlush();

    // Task 1.4's deferred check: real pg.* spans (from
    // @opentelemetry/instrumentation-pg, enhancedDatabaseReporting: false)
    // must actually reach the exporter through this harness.
    const pgSpans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith('pg.'));
    expect(
      pgSpans.length,
      'expected at least one pg.* span from the real Postgres writes this scenario issued (task 1.4\'s deferred "pg spans reach the exporter" check)',
    ).toBeGreaterThan(0);

    // The forced failure must have gone through the pipeline's internal-
    // error path (design D3 step 5), which is what design.md forbids
    // leaking property values through in the first place.
    expect(
      finishedLogRecords(harness.logExporter, 'catalog.internal_error').length,
    ).toBeGreaterThan(0);

    // Every span, in full (name, attributes, every event's name and
    // attributes, and status), across the *entire* run so far -- not just
    // this scenario's own slice, per the spec scenario's "neither marker
    // appears in any exported span, metric, or log attribute".
    const allSpansText = JSON.stringify(
      harness.spanExporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
        status: span.status,
      })),
    );
    const allMetricsText = JSON.stringify(
      harness.metricExporter
        .getMetrics()
        .flatMap((resourceMetrics) =>
          resourceMetrics.scopeMetrics.flatMap((scopeMetrics) =>
            scopeMetrics.metrics.flatMap((metric) =>
              metric.dataPoints.map((dataPoint) => dataPoint.attributes),
            ),
          ),
        ),
    );
    const allLogsText = JSON.stringify(
      [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
        body: record.body,
        attributes: record.attributes,
      })),
    );

    for (const marker of [MARKER_PROPERTY_VALUE, MARKER_TITLE]) {
      expect(
        allSpansText,
        `the marker "${marker}" must never reach any exported span`,
      ).not.toContain(marker);
      expect(
        allMetricsText,
        `the marker "${marker}" must never reach any metric attribute`,
      ).not.toContain(marker);
      expect(allLogsText, `the marker "${marker}" must never reach any log record`).not.toContain(
        marker,
      );
    }
  }, 60_000);

  it('authz.check and authz.plan spans, the cerbos call id correlation and the tayzu.authz.check.duration histogram appear on a representative operation (design "Observability contract"; task 9.4)', async () => {
    const tenantId = randomTenantId();
    const hostContext = ctx(tenantId);

    await client.blueprints.create(teamDefinition(), { context: hostContext });
    await client.entities.create(
      { blueprint: 'team', identifier: 'team-authz', title: 'Team Authz' },
      { context: hostContext },
    );

    const parentSpanId = (span: ReadableSpanLike): string | undefined => {
      const withParent = span as unknown as {
        parentSpanContext?: { spanId?: string };
        parentSpanId?: string;
      };
      return withParent.parentSpanContext?.spanId ?? withParent.parentSpanId;
    };

    // authz.check: child of the operation span, with its required attributes
    // and the conditional Cerbos call id.
    const checksBefore = finishedSpans(harness.spanExporter, 'authz.check').length;
    const captureGet = spanTracker(harness.spanExporter, 'catalog.entity.get');
    await client.entities.get(
      { blueprint: 'team', identifier: 'team-authz' },
      { context: hostContext },
    );
    const operationSpan = captureGet();
    const checkSpans = finishedSpans(harness.spanExporter, 'authz.check').slice(checksBefore);
    expect(checkSpans, 'exactly one authz.check span per operation').toHaveLength(1);
    const checkSpan = checkSpans[0];
    if (checkSpan === undefined) throw new Error('unreachable: length was just asserted');

    expect(parentSpanId(checkSpan), 'authz.check must be a child of the operation span').toBe(
      operationSpan.spanContext().spanId,
    );
    expect(checkSpan.attributes['tayzu.authz.resource.kind']).toBe('catalog_entity');
    expect(checkSpan.attributes['tayzu.authz.action']).toBe('view');
    const callId = checkSpan.attributes['tayzu.authz.cerbos.call_id'];
    expect(typeof callId).toBe('string');
    expect(callId).not.toBe('');

    // cerbosCallId correlation onto the enclosing operation span (design D14).
    expect(
      operationSpan.attributes['tayzu.authz.cerbos.call_id'],
      'the operation span must carry the same Cerbos call id as its authz.check child',
    ).toBe(callId);

    // authz.plan: child of entities.list only, with the plan kind.
    const plansBefore = finishedSpans(harness.spanExporter, 'authz.plan').length;
    const checksBeforeList = finishedSpans(harness.spanExporter, 'authz.check').length;
    const captureList = spanTracker(harness.spanExporter, 'catalog.entity.list');
    await client.entities.list({ blueprint: 'team', pageSize: 10 }, { context: hostContext });
    const listSpan = captureList();
    const planSpans = finishedSpans(harness.spanExporter, 'authz.plan').slice(plansBefore);
    expect(planSpans, 'entities.list emits exactly one authz.plan span').toHaveLength(1);
    const planSpan = planSpans[0];
    if (planSpan === undefined) throw new Error('unreachable: length was just asserted');
    expect(parentSpanId(planSpan), 'authz.plan must be a child of the list operation span').toBe(
      listSpan.spanContext().spanId,
    );
    expect(planSpan.attributes['tayzu.authz.resource.kind']).toBe('catalog_entity');
    expect(['always_allowed', 'always_denied', 'conditional']).toContain(
      planSpan.attributes['tayzu.authz.plan.kind'],
    );

    // authz.plan is for entities.list only: no other operation emits one.
    expect(
      finishedSpans(harness.spanExporter, 'authz.check').length,
      'entities.list still runs its authz.check',
    ).toBeGreaterThanOrEqual(checksBeforeList);
    const plansAfterList = finishedSpans(harness.spanExporter, 'authz.plan').length;
    await client.entities.get(
      { blueprint: 'team', identifier: 'team-authz' },
      { context: hostContext },
    );
    expect(finishedSpans(harness.spanExporter, 'authz.plan')).toHaveLength(plansAfterList);

    // tayzu.authz.check.duration: recorded, with only tayzu.authz.resource.kind.
    await harness.forceFlush();
    const durationPoints = allMetricDataPointAttributes(
      harness.metricExporter,
      'tayzu.authz.check.duration',
    );
    expect(durationPoints.length).toBeGreaterThan(0);
    expect(
      durationPoints.some(
        (attributes) => attributes['tayzu.authz.resource.kind'] === 'catalog_entity',
      ),
    ).toBe(true);
    for (const attributes of durationPoints) {
      expect(Object.keys(attributes)).toEqual(['tayzu.authz.resource.kind']);
    }
  }, 60_000);
});
