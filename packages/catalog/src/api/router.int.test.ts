/**
 * Integration tests for task 9.1 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D2, D3, D11; spec "Published API contract").
 *
 * ## Module under test and assumed API
 *
 * `./router.ts` and `./contract.ts` do not exist yet (red phase). This test
 * assumes the following exported shape.
 *
 * ```ts
 * // ./contract.ts (@orpc/contract's `oc` builder; task 9.3 also targets this
 * // module, so router.ts and contract.ts are expected to be committed
 * // together with errors.ts, task 9.2)
 * export const catalogContract: AnyContractRouter; // grouped { blueprints: {...}, entities: {...} },
 *   // one leaf per design D11 row, each with `.input(zodSchema).output(zodSchema)`
 *   // and `.route({ method, path })` matching the D11 table exactly:
 *   //   blueprints.create  -> POST   /v1/blueprints
 *   //   blueprints.list    -> GET    /v1/blueprints
 *   //   blueprints.get     -> GET    /v1/blueprints/{blueprint}
 *   //   blueprints.update  -> PUT    /v1/blueprints/{blueprint}
 *   //   blueprints.delete  -> DELETE /v1/blueprints/{blueprint}
 *   //   entities.create    -> POST   /v1/blueprints/{blueprint}/entities
 *   //   entities.list      -> GET    /v1/blueprints/{blueprint}/entities
 *   //   entities.get       -> GET    /v1/blueprints/{blueprint}/entities/{entity}
 *   //   entities.upsert    -> PUT    /v1/blueprints/{blueprint}/entities/{entity}
 *   //   entities.delete    -> DELETE /v1/blueprints/{blueprint}/entities/{entity}
 *   //   entities.writeStatus  -> PUT  /v1/blueprints/{blueprint}/entities/{entity}/status
 *   //   entities.listRelated  -> GET  /v1/blueprints/{blueprint}/entities/{entity}/related
 *   // The three high-risk leaves (`blueprints.update`, `blueprints.delete`,
 *   // `entities.delete`, design D11) additionally set `x-tayzu-risk: high` on
 *   // the OpenAPI Operation Object, through `.route({ spec: (op) => ({ ...op,
 *   // 'x-tayzu-risk': 'high' }) })` or equivalent. No other leaf sets it.
 *   // Every input/output field name mirrors the plain TS shapes
 *   // `../service/blueprints.ts` and `../service/entities.ts` already declare
 *   // (`CreateBlueprintInput`, `BlueprintOutput`, `CreateEntityInput`,
 *   // `EntityOutput`, `UpsertEntityOutput`, `WriteEntityStatusInput`,
 *   // `ListRelatedInput`/`ListRelatedOutput`, etc.) -- the contract's Zod
 *   // schemas are structurally equivalent, field for field. In particular an
 *   // entity's `identifier` is a plain string field carried in the JSON
 *   // payload (it is only percent-encoded as a path segment once an actual
 *   // HTTP transport exists, from 002 onward; design D2 -- there is no
 *   // network layer in 001).
 *
 * export function generateOpenApiDocument(
 *   router?: AnyContractRouter | AnyRouter, // defaults to `catalogContract`
 * ): Promise<OpenAPI.Document>; // OpenAPIV3_1.Document (@orpc/contract's re-exported `OpenAPI`),
 *   // built with `@orpc/openapi`'s `OpenAPIGenerator` and
 *   // `@orpc/zod/zod4`'s `ZodToJsonSchemaConverter`.
 *
 * // ./router.ts
 * export interface CatalogRouterServices {
 *   readonly blueprints: BlueprintService; // ../service/blueprints.js
 *   readonly entities: EntityService;      // ../service/entities.js
 * }
 * export function createCatalogRouter(services: CatalogRouterServices): AnyRouter;
 *   // Implements `catalogContract` (`implement(catalogContract)`), one handler
 *   // per leaf, each calling the matching `services.<group>.<verb>(context, input)`
 *   // and converting any thrown error through `./errors.js`'s `toApiError`
 *   // before rethrowing (task 9.2). `context` is the raw, unvalidated,
 *   // host-supplied value handed to `createRouterClient`/the client call --
 *   // `defineCatalogOperation` (`../service/pipeline.js`) is the only place
 *   // that ever calls `parseCatalogContext` (design D3).
 * ```
 *
 * ## Why this test connects, calls and asserts the way it does
 *
 * Design D2: "Tests call them in-process with `createRouterClient(router, {
 * context })`. No Fastify listener mounts them until 002." This test never
 * imports an HTTP adapter and never opens a socket. The context is supplied
 * as a per-call factory (`context: (raw) => raw`, the identity function),
 * which is the standard oRPC way to let a server-side client forward a
 * *different* client-supplied value on every call (`@orpc/server`'s
 * `CreateProcedureClientOptions.context` accepts a `Value<..., [clientContext]>`)
 * -- exactly what a real host (in-process today, HTTP middleware from 002)
 * does per request; it is not a network header or any other bypass.
 *
 * Same raw-`Pool`-against-`DATABASE_URL` connection pattern and
 * `./__fixtures__/registered-harness.js` import-order requirement (design D1)
 * as every other int test in this package, reused from
 * `../service/__fixtures__/*.js` per the task instructions.
 */
import { createRouterClient } from '@orpc/server';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above (design D1).
import {
  registration,
  type TelemetryTestHarness,
} from '../service/__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from '../service/__fixtures__/blueprint-test-helpers.js';
import type { CatalogContext } from '../domain/context.js';
import { createBlueprintService, type BlueprintService } from '../service/blueprints.js';
import { createEntityService, type EntityService } from '../service/entities.js';
import { catalogContract, generateOpenApiDocument } from './contract.js';
import { createCatalogRouter } from './router.js';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor };
}

/** Narrows an unknown OpenAPI Operation Object field access without widening every read to `any`. */
function operationExtension(document: unknown, path: string, method: string, key: string): unknown {
  const doc = document as { paths?: Record<string, Record<string, Record<string, unknown>>> };
  return doc.paths?.[path]?.[method]?.[key];
}

describe('catalog API router (design D2, D3, D11; task 9.1)', () => {
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;
  // `client`'s context type is the raw, unvalidated host-supplied value
  // (design D3): a plain record, not a validated `CatalogContext`, so a test
  // can also exercise a deliberately invalid one.
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createCatalogRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    // Migrations need the owner connection: tayzu_app has no DDL privilege
    // (task 6.3, design D6 Q1a). No raw introspection follows in this file,
    // so the owner connection is closed right after migrating.
    const ownerDb = connectAsOwner(databaseUrl());
    await runMigrations(ownerDb.$client);
    await endQuietly(ownerDb.$client);
    // The router under test runs through the real tenant_isolation RLS
    // policy, exactly like production.
    const db = connect(databaseUrl());
    pool = db.$client;
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool });
    entities = createEntityService({ pool });
    const router = createCatalogRouter({ blueprints, entities });
    client = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    });
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  it('calls every one of the 12 procedures once on the happy path, and an entity identifier containing "/" round-trips', async () => {
    const tenantId = randomTenantId();
    const hostContext = ctx(tenantId);

    // 1. blueprints.create -- a plain relation target, no properties.
    const team = await client.blueprints.create(
      { identifier: 'team', title: { en: 'Team' }, schema: { properties: {}, required: [] } },
      { context: hostContext },
    );
    expect(team.identifier).toBe('team');
    expect(team.version).toBe(1);

    // 1 (again). blueprints.create -- the blueprint entities are created against.
    const serviceInputV1 = {
      identifier: 'service',
      title: { en: 'Service' },
      schema: {
        properties: { language: { type: 'string' as const, title: { en: 'Language' } } },
        required: [],
      },
      statusSchema: {
        properties: {
          lastDeployAt: {
            type: 'string' as const,
            title: { en: 'Last deploy' },
            format: 'date-time' as const,
          },
        },
        required: [],
      },
      relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true } },
    };
    const serviceV1 = await client.blueprints.create(serviceInputV1, { context: hostContext });
    expect(serviceV1.identifier).toBe('service');
    expect(serviceV1.relations['owner']).toEqual({
      title: { en: 'Owner' },
      target: 'team',
      many: false,
      required: true,
    });

    // A dedicated, always-unreferenced blueprint for the `blueprints.delete` happy path below.
    await client.blueprints.create(
      { identifier: 'scratch', title: { en: 'Scratch' }, schema: { properties: {}, required: [] } },
      { context: hostContext },
    );

    // 2. blueprints.get
    const fetchedService = await client.blueprints.get(
      { identifier: 'service' },
      { context: hostContext },
    );
    expect(fetchedService.identifier).toBe('service');
    expect(fetchedService.version).toBe(1);

    // 3. blueprints.list
    const blueprintPage = await client.blueprints.list({ pageSize: 10 }, { context: hostContext });
    expect(blueprintPage.items.map((item: { identifier: string }) => item.identifier)).toEqual([
      'scratch',
      'service',
      'team',
    ]);

    // 4. blueprints.update -- adds an optional property, bumps the version.
    const serviceV2 = await client.blueprints.update(
      {
        ...serviceInputV1,
        schema: {
          properties: {
            ...serviceInputV1.schema.properties,
            tier: { type: 'string' as const, title: { en: 'Tier' } },
          },
          required: [],
        },
        expectedVersion: 1,
      },
      { context: hostContext },
    );
    expect(serviceV2.version).toBe(2);

    // 5. entities.create -- the relation target.
    const teamA = await client.entities.create(
      { blueprint: 'team', identifier: 'team-a', title: 'Team A' },
      { context: hostContext },
    );
    expect(teamA.identifier).toBe('team-a');
    expect(teamA.generation).toBe(1);
    expect(teamA.version).toBe(1);

    // An always-unreferenced entity for the `entities.delete` happy path below.
    await client.entities.create(
      { blueprint: 'team', identifier: 'sandbox', title: 'Sandbox' },
      { context: hostContext },
    );

    // 5 (again). entities.create -- an identifier containing "/".
    const created = await client.entities.create(
      {
        blueprint: 'service',
        identifier: 'org/repo',
        title: 'Payments',
        spec: { properties: { language: 'go' }, relations: { owner: 'team-a' } },
      },
      { context: hostContext },
    );
    expect(created.identifier).toBe('org/repo');
    expect(created.spec.properties['language']).toBe('go');
    expect(created.spec.relations['owner']).toBe('team-a');

    // 6. entities.get -- the "/" round-trips unchanged through the API layer.
    const fetchedEntity = await client.entities.get(
      { blueprint: 'service', identifier: 'org/repo' },
      { context: hostContext },
    );
    expect(fetchedEntity.identifier).toBe('org/repo');

    // 7. entities.list
    const entityPage = await client.entities.list(
      { blueprint: 'service', pageSize: 10 },
      { context: hostContext },
    );
    expect(entityPage.items.map((item: { identifier: string }) => item.identifier)).toEqual([
      'org/repo',
    ]);

    // 8. entities.upsert
    const upserted = await client.entities.upsert(
      {
        blueprint: 'service',
        identifier: 'org/repo',
        title: 'Payments',
        mode: 'replace',
        spec: { properties: { language: 'rust' }, relations: { owner: 'team-a' } },
      },
      { context: hostContext },
    );
    expect(upserted.outcome).toBe('updated');
    expect(upserted.generation).toBe(2);
    expect(upserted.spec.properties['language']).toBe('rust');

    // 9. entities.writeStatus
    const statusWritten = await client.entities.writeStatus(
      {
        blueprint: 'service',
        identifier: 'org/repo',
        properties: { lastDeployAt: '2026-01-01T00:00:00Z' },
        observedGeneration: 2,
        source: 'github',
      },
      { context: hostContext },
    );
    expect(statusWritten.status?.properties['lastDeployAt']).toBe('2026-01-01T00:00:00Z');
    expect(statusWritten.status?.source).toBe('github');

    // 10. entities.listRelated
    const related = await client.entities.listRelated(
      { blueprint: 'service', identifier: 'org/repo', direction: 'forward' },
      { context: hostContext },
    );
    expect(related.items).toContainEqual(
      expect.objectContaining({
        relation: 'owner',
        scope: 'spec',
        entity: expect.objectContaining({ identifier: 'team-a' }),
      }),
    );

    // 11. entities.delete -- an unreferenced entity.
    await client.entities.delete(
      { blueprint: 'team', identifier: 'sandbox' },
      { context: hostContext },
    );
    await expectCatalogErrorCode(
      client.entities.get({ blueprint: 'team', identifier: 'sandbox' }, { context: hostContext }),
      'CATALOG_NOT_FOUND',
    );

    // 12. blueprints.delete -- an unused blueprint.
    await client.blueprints.delete({ identifier: 'scratch' }, { context: hostContext });
    await expectCatalogErrorCode(
      client.blueprints.get({ identifier: 'scratch' }, { context: hostContext }),
      'CATALOG_NOT_FOUND',
    );
  });

  it('marks exactly the three high-risk procedures with x-tayzu-risk: high (design D11)', async () => {
    const document = await generateOpenApiDocument(catalogContract);

    expect(operationExtension(document, '/v1/blueprints/{blueprint}', 'put', 'x-tayzu-risk')).toBe(
      'high',
    );
    expect(
      operationExtension(document, '/v1/blueprints/{blueprint}', 'delete', 'x-tayzu-risk'),
    ).toBe('high');
    expect(
      operationExtension(
        document,
        '/v1/blueprints/{blueprint}/entities/{entity}',
        'delete',
        'x-tayzu-risk',
      ),
    ).toBe('high');

    // No blanket marking: a non-high-risk procedure never carries it.
    expect(operationExtension(document, '/v1/blueprints', 'post', 'x-tayzu-risk')).toBeUndefined();
    expect(
      operationExtension(document, '/v1/blueprints/{blueprint}', 'get', 'x-tayzu-risk'),
    ).toBeUndefined();
    expect(
      operationExtension(
        document,
        '/v1/blueprints/{blueprint}/entities/{entity}',
        'get',
        'x-tayzu-risk',
      ),
    ).toBeUndefined();
  });

  it('Blueprint definitions round-trip (spec "Published API contract")', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();

    await client.blueprints.create(
      {
        identifier: 'library',
        title: { en: 'Library', es: 'Biblioteca' },
        description: { en: 'A reusable definition' },
        icon: 'book',
        schema: {
          properties: { name: { type: 'string', title: { en: 'Name' } } },
          required: ['name'],
        },
      },
      { context: ctx(tenantA) },
    );

    // GIVEN a non-reserved blueprint read with the get operation.
    const read = await client.blueprints.get({ identifier: 'library' }, { context: ctx(tenantA) });

    // WHEN its output, without the server-managed fields (`version`,
    // `createdAt`, `createdBy`, `updatedAt`, `updatedBy`), is sent to create
    // in another tenant...
    const portableDefinition = {
      identifier: read.identifier,
      title: read.title,
      description: read.description,
      icon: read.icon,
      schema: read.schema,
      statusSchema: read.statusSchema,
      relations: read.relations,
    };

    const createdElsewhere = await client.blueprints.create(portableDefinition, {
      context: ctx(tenantB),
    });
    expect(createdElsewhere.identifier).toBe('library');
    expect(createdElsewhere.title).toEqual(read.title);
    expect(createdElsewhere.description).toEqual(read.description);
    expect(createdElsewhere.icon).toBe(read.icon);
    expect(createdElsewhere.schema).toEqual(read.schema);
    expect(createdElsewhere.relations).toEqual(read.relations);

    // ...and to update in the same tenant...
    const updated = await client.blueprints.update(
      { ...portableDefinition, expectedVersion: read.version },
      { context: ctx(tenantA) },
    );
    expect(updated.identifier).toBe('library');

    // THEN both are accepted unchanged, and a new get returns an equal definition.
    const readAgain = await client.blueprints.get(
      { identifier: 'library' },
      { context: ctx(tenantA) },
    );
    expect(readAgain.title).toEqual(read.title);
    expect(readAgain.description).toEqual(read.description);
    expect(readAgain.icon).toBe(read.icon);
    expect(readAgain.schema).toEqual(read.schema);
    expect(readAgain.relations).toEqual(read.relations);

    const readElsewhereAgain = await client.blueprints.get(
      { identifier: 'library' },
      { context: ctx(tenantB) },
    );
    expect(readElsewhereAgain.title).toEqual(read.title);
    expect(readElsewhereAgain.schema).toEqual(read.schema);
  });
});
