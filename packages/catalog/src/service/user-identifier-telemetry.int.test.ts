/**
 * Integration tests for task 4.1d of openspec/changes/043-identity-lifecycle-and-org-admin
 * (Resolved decisions Q107, Q113, Q119, Q130; spec "Telemetry contract" scenarios
 * "A `_user` email never reaches a catalog span", "... the catalog audit event" and
 * "... the Cerbos decision log"; design, Observability contract).
 *
 * ## Production behavior assumed
 *
 * - `../telemetry/contract.js` exports `USER_ENTITY_IDENTIFIER_PLACEHOLDER`, one fixed
 *   non-empty string that is not an email.
 * - For an entity of the reserved `_user` blueprint, `tayzu.catalog.entity.identifier`
 *   (the six entity spans), `tayzu.catalog.resource.identifier` (`catalog.audit.mutation`)
 *   and the Cerbos `resource.id` of every `catalog_entity` check (the operation's own
 *   check and the per-referrer `update` check of a delete) carry that placeholder.
 *   Every other blueprint keeps its identifier.
 * - The referrer redaction batch sends positions (`'0'`, `'1'`, ...) as resource ids for
 *   every blueprint (`redactUnreadable`).
 * - The change-event row keeps the real identifier.
 */
import { randomUUID } from 'node:crypto';

import { sharedAttributeKeys } from '@tayzu/observability';
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authz } from './__fixtures__/authz-test-helpers.js';
// Import order is load-bearing: see `entity-status.int.test.ts`.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput, ctx, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import { selectChangeEventActors } from './__fixtures__/entity-b-test-helpers.js';
import { finishedLogRecords, finishedSpans } from './__fixtures__/telemetry-assertions.js';
import { USER_ENTITY_IDENTIFIER_PLACEHOLDER } from '../telemetry/contract.js';
import type { CerbosClient } from '@tayzu/authz';
import { createBlueprintService, type BlueprintService } from './blueprints.js';
import { createEntityService, type EntityService } from './entities.js';
import { buildUserBlueprintInput } from './system-blueprints.js';
import { createUserSync, type UserSync } from './user-sync.js';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const SYSTEM_ACTOR = { type: 'system' as const, id: 'user-identifier-telemetry-test' };
const ENTITY_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.entity.identifier';
const RESOURCE_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.resource.identifier';
const SIX_ENTITY_SPANS = [
  'catalog.entity.create',
  'catalog.entity.upsert',
  'catalog.entity.get',
  'catalog.entity.delete',
  'catalog.entity.status.write',
  'catalog.entity.related.list',
] as const;

interface RecordedResource {
  readonly kind: string;
  readonly id: string;
  readonly actions: readonly string[];
}

interface RecordedRequest {
  readonly resources: readonly RecordedResource[];
  readonly raw: unknown;
}

/** Wraps the real Cerbos client and records what it is asked (what a decision log would hold). */
function recordingAuthz(): {
  readonly client: CerbosClient;
  readonly raw: unknown[];
  readonly checks: () => RecordedRequest[];
  readonly clear: () => void;
} {
  const raw: unknown[] = [];
  const client = new Proxy(authz, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (prop === 'checkResources' || prop === 'planResources') raw.push(args[0]);
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
  const checks = (): RecordedRequest[] =>
    raw.flatMap((request) => {
      const resources = (
        request as {
          resources?: readonly {
            resource: { kind: string; id: string };
            actions: readonly string[];
          }[];
        }
      ).resources;
      if (resources === undefined) return [];
      return [
        {
          raw: request,
          resources: resources.map((entry) => ({
            kind: entry.resource.kind,
            id: entry.resource.id,
            actions: entry.actions,
          })),
        },
      ];
    });
  return {
    client,
    raw,
    checks,
    clear: () => {
      raw.splice(0);
    },
  };
}

describe('A `_user` identifier never reaches catalog telemetry (task 4.1d)', () => {
  const url = databaseUrl();
  let pool: TestDb['$client'];
  let ownerDb: TestDb;
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;
  let userSync: UserSync;

  beforeAll(async () => {
    ownerDb = connectAsOwner(url);
    await runMigrations(ownerDb.$client);
    pool = connect(url).$client;
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool, authz });
    entities = createEntityService({ pool, authz });
    userSync = createUserSync({ pool, authz });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  }, 60_000);

  function freshMarker(): string {
    return `marker-${randomUUID()}@example.test`;
  }

  /** Creates, updates, reads, lists, relates, status-writes and deletes the marker `_user` entity. */
  async function exerciseUserEntity(
    tenantId: string,
    email: string,
    services: { entities: EntityService; userSync: UserSync },
  ): Promise<void> {
    const system = ctx(tenantId, SYSTEM_ACTOR);
    await services.userSync.upsertUser({
      tenantId,
      email,
      name: 'Marker Person',
      status: 'Invited',
      createOnly: true,
    });
    await services.userSync.upsertUser({
      tenantId,
      email,
      name: 'Marker Person',
      status: 'Active',
    });
    await services.entities.get(system, { blueprint: '_user', identifier: email });
    await services.entities.list(system, { blueprint: '_user' });
    await services.entities.listRelated(system, {
      blueprint: '_user',
      identifier: email,
      direction: 'forward',
    });
    await services.entities.writeStatus(system, {
      blueprint: '_user',
      identifier: email,
      observedGeneration: 1,
      source: 'identity',
    });
    await services.entities.delete(system, { blueprint: '_user', identifier: email });
  }

  function tenantSpans(tenantId: string, name: string) {
    return finishedSpans(harness.spanExporter, name).filter(
      (span) => span.attributes[sharedAttributeKeys.tenantId] === tenantId,
    );
  }

  function tenantAuditRecords(tenantId: string) {
    return finishedLogRecords(harness.logExporter, 'catalog.audit.mutation').filter(
      (record) => record.attributes[sharedAttributeKeys.tenantId] === tenantId,
    );
  }

  it('A `_user` email never reaches a catalog span', async () => {
    // GIVEN a `_user` entity whose identifier is a marker email, and an entity of another blueprint
    const tenantId = randomTenantId();
    const email = freshMarker();
    await blueprints.create(ctx(tenantId), blueprintInput('service'));
    await entities.create(ctx(tenantId), entityInput('service', 'payments-api'));
    await entities.get(ctx(tenantId), { blueprint: 'service', identifier: 'payments-api' });

    // WHEN it is created, read, updated, deleted and listed, through the existing user sync
    await exerciseUserEntity(tenantId, email, { entities, userSync });

    // THEN each of the six spans carries the fixed placeholder as its entity identifier
    for (const name of SIX_ENTITY_SPANS) {
      const userSpans = tenantSpans(tenantId, name).filter(
        (span) => span.attributes['tayzu.catalog.blueprint.identifier'] === '_user',
      );
      expect(userSpans.length, `a ${name} span for the _user entity`).toBeGreaterThan(0);
      for (const span of userSpans) {
        expect(span.attributes[ENTITY_IDENTIFIER_ATTRIBUTE]).toBe(
          USER_ENTITY_IDENTIFIER_PLACEHOLDER,
        );
      }
    }

    // AND the email appears in no exported attribute of any span of the tenant
    const exported = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.attributes[sharedAttributeKeys.tenantId] === tenantId)
      .map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
        status: span.status,
      }));
    expect(JSON.stringify(exported)).not.toContain(email);

    // AND an entity of another blueprint keeps its identifier
    const created = tenantSpans(tenantId, 'catalog.entity.create').filter(
      (span) => span.attributes['tayzu.catalog.blueprint.identifier'] === 'service',
    );
    expect(created.map((span) => span.attributes[ENTITY_IDENTIFIER_ATTRIBUTE])).toEqual([
      'payments-api',
    ]);
    const got = tenantSpans(tenantId, 'catalog.entity.get').filter(
      (span) => span.attributes['tayzu.catalog.blueprint.identifier'] === 'service',
    );
    expect(got.map((span) => span.attributes[ENTITY_IDENTIFIER_ATTRIBUTE])).toEqual([
      'payments-api',
    ]);
  });

  it("A service account's `svc-` identifier is replaced the same way", async () => {
    const tenantId = randomTenantId();
    const serviceIdentifier = `svc-${randomUUID()}`;
    await userSync.upsertUser({
      tenantId,
      email: freshMarker(),
      name: 'Bootstrap',
      status: 'Active',
    });

    await entities.create(
      ctx(tenantId, SYSTEM_ACTOR),
      entityInput('_user', serviceIdentifier, {
        spec: { properties: { accountKind: 'service', status: 'Active' } },
      }),
    );

    const spans = tenantSpans(tenantId, 'catalog.entity.create').filter(
      (span) =>
        span.attributes['tayzu.catalog.entity.identifier'] === USER_ENTITY_IDENTIFIER_PLACEHOLDER,
    );
    expect(spans.length).toBeGreaterThan(0);
    const exported = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.attributes[sharedAttributeKeys.tenantId] === tenantId)
      .map((span) => span.attributes);
    expect(JSON.stringify(exported)).not.toContain(serviceIdentifier);
  });

  it('A `_user` email never reaches the catalog audit event', async () => {
    // GIVEN a `_user` entity with a marker email and an entity of another blueprint
    const tenantId = randomTenantId();
    const email = freshMarker();
    await blueprints.create(ctx(tenantId), blueprintInput('service'));
    await entities.create(ctx(tenantId), entityInput('service', 'payments-api'));

    // WHEN the `_user` entity is created, updated, status-written and deleted
    await exerciseUserEntity(tenantId, email, { entities, userSync });

    // THEN each entity mutation event of the `_user` blueprint carries the placeholder
    const records = tenantAuditRecords(tenantId);
    const userEvents = records.filter(
      (record) =>
        record.attributes['tayzu.catalog.resource.kind'] === 'entity' &&
        record.attributes['tayzu.catalog.blueprint.identifier'] === '_user',
    );
    expect(userEvents.length).toBeGreaterThanOrEqual(4);
    for (const record of userEvents) {
      expect(record.attributes[RESOURCE_IDENTIFIER_ATTRIBUTE]).toBe(
        USER_ENTITY_IDENTIFIER_PLACEHOLDER,
      );
    }

    // AND the email is in none of the attributes of any event of the tenant
    expect(JSON.stringify(records.map((record) => record.attributes))).not.toContain(email);

    // AND the tenant and sequence number find the stored change events, which keep the identifier
    const stored = await selectChangeEventActors(ownerDb, tenantId, email);
    expect(stored.length).toBeGreaterThanOrEqual(4);
    expect(
      userEvents
        .map((record) => String(Number(record.attributes['tayzu.catalog.change_event.seq'])))
        .sort(),
    ).toEqual(stored.map((row) => row.seq).sort());

    // AND an entity of another blueprint keeps its identifier in the event
    const serviceEvents = records.filter(
      (record) =>
        record.attributes['tayzu.catalog.resource.kind'] === 'entity' &&
        record.attributes['tayzu.catalog.blueprint.identifier'] === 'service',
    );
    expect(serviceEvents.map((record) => record.attributes[RESOURCE_IDENTIFIER_ATTRIBUTE])).toEqual(
      ['payments-api'],
    );
  });

  describe('A `_user` email never reaches the Cerbos decision log', () => {
    /** Seeds `platform` (team), `checkout` (service) and the marker `_user`, both referring to `platform`. */
    async function seedReferrers(tenantId: string, email: string): Promise<void> {
      const system = ctx(tenantId, SYSTEM_ACTOR);
      await userSync.upsertUser({ tenantId, email: freshMarker(), name: 'Seed', status: 'Active' });
      await blueprints.create(ctx(tenantId), blueprintInput('team'));
      await blueprints.create(
        ctx(tenantId),
        blueprintInput('service', {
          relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false } },
        }),
      );
      await blueprints.update(system, {
        ...buildUserBlueprintInput(),
        relations: { memberOf: { title: { en: 'Member of' }, target: 'team', many: false } },
      });
      await entities.create(ctx(tenantId), entityInput('team', 'platform'));
      await entities.create(
        ctx(tenantId),
        entityInput('service', 'checkout', { spec: { relations: { owner: 'platform' } } }),
      );
      await entities.create(
        system,
        entityInput('_user', email, {
          spec: { properties: { status: 'Active' }, relations: { memberOf: 'platform' } },
        }),
      );
    }

    it('every request of the operations on a `_user` entity carries the placeholder as resource id', async () => {
      const tenantId = randomTenantId();
      const email = freshMarker();
      const recorder = recordingAuthz();
      const recordedEntities = createEntityService({ pool, authz: recorder.client });
      const recordedSync = createUserSync({ pool, authz: recorder.client });
      await blueprints.create(ctx(tenantId), blueprintInput('service'));

      await exerciseUserEntity(tenantId, email, {
        entities: recordedEntities,
        userSync: recordedSync,
      });
      // AND the same operations on an entity of another blueprint
      await recordedEntities.create(ctx(tenantId), entityInput('service', 'payments-api'));
      await recordedEntities.get(ctx(tenantId), {
        blueprint: 'service',
        identifier: 'payments-api',
      });

      // THEN the email is in no field of any request
      expect(JSON.stringify(recorder.raw)).not.toContain(email);

      // AND every catalog_entity check of the `_user` operations used the placeholder
      const entityChecks = recorder
        .checks()
        .flatMap((request) => request.resources)
        .filter((resource) => resource.kind === 'catalog_entity');
      const userChecks = entityChecks.filter((resource) => resource.id !== 'payments-api');
      expect(userChecks.length).toBeGreaterThan(0);
      for (const resource of userChecks) {
        expect(resource.id).toBe(USER_ENTITY_IDENTIFIER_PLACEHOLDER);
      }

      // AND the entity of another blueprint is checked with its identifier
      expect(entityChecks.filter((resource) => resource.id === 'payments-api').length).toBe(2);
    });

    it('a delete that detaches references sends the placeholder for a `_user` referrer and the identifier for another', async () => {
      const tenantId = randomTenantId();
      const email = freshMarker();
      await seedReferrers(tenantId, email);
      const recorder = recordingAuthz();
      const recordedEntities = createEntityService({ pool, authz: recorder.client });

      await recordedEntities.delete(ctx(tenantId), {
        blueprint: 'team',
        identifier: 'platform',
        detachReferences: true,
      });

      // THEN the referrers' `update` checks use the placeholder and the identifier respectively
      const updateChecks = recorder
        .checks()
        .flatMap((request) => request.resources)
        .filter((resource) => resource.actions.includes('update'));
      expect(updateChecks.map((resource) => resource.id).sort()).toEqual(
        [USER_ENTITY_IDENTIFIER_PLACEHOLDER, 'checkout'].sort(),
      );
      // AND the email is in no field
      expect(JSON.stringify(recorder.raw)).not.toContain(email);
    });

    it('a delete blocked by referrers sends positional ids whatever their blueprint', async () => {
      const tenantId = randomTenantId();
      const email = freshMarker();
      await seedReferrers(tenantId, email);
      const recorder = recordingAuthz();
      const recordedEntities = createEntityService({ pool, authz: recorder.client });

      await expectCatalogErrorCode(
        recordedEntities.delete(ctx(tenantId), { blueprint: 'team', identifier: 'platform' }),
        'CATALOG_REFERENCE_VIOLATION',
      );

      // THEN the redaction batch (the one request with two resources) carries positions
      const batches = recorder.checks().filter((request) => request.resources.length === 2);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.resources.map((resource) => resource.id)).toEqual(['0', '1']);
      // AND neither referrer's identifier is in any request
      const serialized = JSON.stringify(recorder.raw);
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain('checkout');
    });
  });
});
