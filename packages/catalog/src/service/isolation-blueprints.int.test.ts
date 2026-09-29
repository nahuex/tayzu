/**
 * Integration tests for task 7.6 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3, D5; spec "Tenant data isolation"). See `blueprints.int.test.ts` for
 * `./blueprints.js`'s full assumed API (`createBlueprintService`,
 * `BlueprintService`, `CreateBlueprintInput`, `BlueprintOutput`); this file
 * adds nothing to that contract, it only exercises it across two tenants.
 *
 * Named `isolation-blueprints.int.test.ts` rather than `isolation.int.test.ts`
 * (as `tasks.md` 7.6 literally says) because task 8.8 also names
 * `isolation.int.test.ts` for the entity-isolation scenarios: splitting by
 * resource (`isolation-blueprints.int.test.ts` here,
 * `isolation-entities.int.test.ts` for 8.8) avoids two unrelated tasks
 * fighting over the same file.
 *
 * This file needs no telemetry harness: none of its assertions inspect a
 * span, metric or log record, only `BlueprintService`'s return values and
 * thrown errors, so it skips `./__fixtures__/registered-harness.js`
 * entirely (the OTel API instruments `./blueprints.js` creates at import
 * time simply run against whatever no-op providers are active, exactly as
 * they would in any other module that never registers a harness).
 */
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
} from './__fixtures__/blueprint-test-helpers.js';
import type { CatalogContext } from '../domain/context.js';
import {
  createBlueprintService,
  type BlueprintOutput,
  type BlueprintService,
  type CreateBlueprintInput,
} from './blueprints.js';

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor };
}

function blueprintInput(
  identifier: string,
  overrides: Partial<CreateBlueprintInput> = {},
): CreateBlueprintInput {
  return {
    identifier,
    title: { en: identifier },
    schema: { properties: {}, required: [] },
    ...overrides,
  };
}

describe('blueprint tenant isolation (task 7.6; spec "Tenant data isolation")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let service: BlueprintService;

  beforeAll(async () => {
    // Migrations need the owner connection: tayzu_app has no DDL privilege
    // (task 6.3, design D6 Q1a). Every check in this file goes through the
    // real blueprint service below, so no other raw connection is needed.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The service under test runs through the real tenant_isolation RLS
    // policy, exactly like production: cross-tenant reads are now blocked by
    // two independent layers, application scoping and RLS.
    pool = connect(databaseUrl()).$client;
    service = createBlueprintService({ pool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('Same identifiers coexist across tenants', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();

    await service.create(
      ctx(tenantA),
      blueprintInput('service', { title: { en: 'Tenant A service' } }),
    );
    const created = await service.create(
      ctx(tenantB),
      blueprintInput('service', { title: { en: 'Tenant B service' } }),
    );
    expect(created.identifier).toBe('service');

    const fromA = await service.get(ctx(tenantA), { identifier: 'service' });
    const fromB = await service.get(ctx(tenantB), { identifier: 'service' });
    expect(fromA.title).toEqual({ en: 'Tenant A service' });
    expect(fromB.title).toEqual({ en: 'Tenant B service' });

    const listA = await service.list(ctx(tenantA), {});
    expect(listA.items.map((item: BlueprintOutput) => item.identifier)).toEqual(['service']);
    const listB = await service.list(ctx(tenantB), {});
    expect(listB.items.map((item: BlueprintOutput) => item.identifier)).toEqual(['service']);
  });

  it('get of another tenant blueprint fails with CATALOG_NOT_FOUND', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();
    await service.create(ctx(tenantA), blueprintInput('service'));

    await expectCatalogErrorCode(
      service.get(ctx(tenantB), { identifier: 'service' }),
      'CATALOG_NOT_FOUND',
    );
  });

  it('update of another tenant blueprint fails with CATALOG_NOT_FOUND', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();
    await service.create(ctx(tenantA), blueprintInput('service'));

    await expectCatalogErrorCode(
      service.update(ctx(tenantB), {
        identifier: 'service',
        title: { en: 'hijacked' },
        schema: { properties: {}, required: [] },
      }),
      'CATALOG_NOT_FOUND',
    );
  });

  it('delete of another tenant blueprint fails with CATALOG_NOT_FOUND', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();
    await service.create(ctx(tenantA), blueprintInput('service'));

    await expectCatalogErrorCode(
      service.delete(ctx(tenantB), { identifier: 'service' }),
      'CATALOG_NOT_FOUND',
    );

    // Tenant A's own blueprint must be unaffected by tenant B's rejected attempt.
    const stillThere = await service.get(ctx(tenantA), { identifier: 'service' });
    expect(stillThere.identifier).toBe('service');
  });
});
