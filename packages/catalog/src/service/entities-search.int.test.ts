/**
 * Integration tests for 003 task 3.6 (openspec/changes/003-catalog-ui-core,
 * design D5, Resolved decisions Q19 and Q52; catalog-core delta spec,
 * requirement "Cross-blueprint entity search").
 *
 * Every search goes through the catalog router, `client.search.entities`,
 * with the host-supplied context (`createRouterClient(router, { context })`,
 * the same in-process pattern as `../api/router.int.test.ts`), so these tests
 * also prove the router wiring of the procedure 3.3 declared. Seeding goes
 * through the real blueprint and entity services. A real PostgreSQL (as
 * `tayzu_app`, under row-level security) and the real Cerbos container on
 * localhost:3593 back every call. Each test seeds its own fresh tenant, and
 * every assertion is scoped to it.
 *
 * ## Contract assumed for the implementer
 *
 * - `EntityService` (`./entities.js`) gains
 *   `search(rawContext: unknown, input: SearchEntitiesInput): Promise<SearchEntitiesOutput>`,
 *   where `SearchEntitiesInput` is `{ q: string; limit?: number }` and
 *   `SearchEntitiesOutput` is
 *   `{ items: readonly { blueprint, identifier, title, match: 'identifier' | 'title' }[] }`.
 *   It is declared with `defineCatalogOperation<SearchEntitiesInput,
 *   SearchEntitiesOutput>({ name: 'entity.search', pool, authz,
 *   authorization: PLAN_AUTHORIZED, handler })`.
 * - `createCatalogRouter({ blueprints, entities })` keeps its signature and
 *   implements `search.entities` by calling `services.entities.search`.
 * - `parseSearchQuery` (3.5) runs before the tenant transaction opens, so a
 *   rejected query or limit makes no database round trip at all.
 * - The `catalog_entity` `list` plan (`planEntityList`, unchanged) is folded
 *   into one parameterized cross-blueprint query; a denied plan returns
 *   `{ items: [] }`, never an error.
 *
 * ## Ranking (design D5)
 *
 * "an exact identifier match (case-insensitive) first, then an identifier
 * prefix, then a title prefix, then trigram similarity descending; ties by
 * blueprint identifier, then entity identifier." Similarity orders only the
 * similarity tier: rows of the exact, identifier-prefix and title-prefix tiers
 * are ties within their tier, so they are ordered by blueprint, then
 * identifier, whatever their title similarity is. `match` is `identifier`
 * when the identifier matched (exact or prefix), and `title` otherwise.
 *
 * ## Fixture notes
 *
 * - Blueprint and entity identifiers whose relative order is asserted use
 *   lowercase letters only (no `-`, `_`), so the expected order is the same
 *   under the C collation and under a linguistic default collation.
 * - The trigram similarities the fixtures rely on were measured with
 *   `similarity()` at `pg_trgm`'s default threshold, 0.3: `Paymnets` 0.38,
 *   `Paymentz` 0.64 and `Payments e` 0.82 against `Payments`, while
 *   `payments store with a very long descriptive title` is 0.18 (a title
 *   prefix only); `Payments Gateway` is 0.62 against `Paymnets Gateway`.
 * - A caller whose plan is narrower than the repository policies emit (they
 *   yield ALWAYS_ALLOWED for `member` on `list`) gets a fake `planResources`
 *   answer through a Proxy over the real client, the same pattern as
 *   `entities-list-query-plan.int.test.ts`; the plan mapper under test is the
 *   production one. The moderator and the team-only viewer use real plans.
 * - "No database query is made" is asserted on the spans
 *   `@opentelemetry/instrumentation-pg` records (`pg.*`, `pg-pool.*`), which
 *   the telemetry test harness registers before `pg` loads (import order
 *   below, design D1 of `001`); a positive control proves those spans are
 *   recorded for a valid search in this file.
 */
import { authz } from './__fixtures__/authz-test-helpers.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';

import type { InferContractRouterInputs, InferContractRouterOutputs } from '@orpc/contract';
import { createRouterClient } from '@orpc/server';
import type { CerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput } from './__fixtures__/entity-a-test-helpers.js';
import type { catalogContract } from '../api/contract.js';
import { createCatalogRouter } from '../api/router.js';
import { createBlueprintService, type BlueprintService } from './blueprints.js';
import { createEntityService, type EntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

type SearchInput = InferContractRouterInputs<typeof catalogContract>['search']['entities'];
type SearchOutput = InferContractRouterOutputs<typeof catalogContract>['search']['entities'];
type SearchItem = SearchOutput['items'][number];

type HostContext = Record<string, unknown>;

type Principal = {
  readonly roles: readonly string[];
  readonly teams?: readonly string[];
  readonly moderatedBlueprints?: readonly string[];
};

const ADMIN: Principal = { roles: ['admin'] };

/** The system actor that seeds `_user` and `_team` entities (only it may write them). */
const SYSTEM_SEED_ACTOR_ID = 'search-seed';

function hostContext(tenantId: string, actorId: string, principal: Principal): HostContext {
  return { tenantId, actor: { type: 'user', id: actorId }, principal };
}

const adminCtx = (tenantId: string): HostContext => hostContext(tenantId, 'admin-1', ADMIN);

function systemCtx(tenantId: string): HostContext {
  return { tenantId, actor: { type: 'system', id: SYSTEM_SEED_ACTOR_ID }, principal: ADMIN };
}

/** A duck-typed `PlanResources` result, like `@cerbos/core`'s response. */
type FakePlan = { readonly kind: string; readonly condition?: unknown };

const conditional = (condition: unknown): FakePlan => ({ kind: 'KIND_CONDITIONAL', condition });
const attr = (name: string) => ({ name: `request.resource.attr.${name}` });
const ALWAYS_DENIED: FakePlan = { kind: 'KIND_ALWAYS_DENIED' };

/** Wraps the real client; `planResources` answers `plan` instead. */
function withPlan(real: CerbosClient, plan: FakePlan): CerbosClient {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'planResources') {
        return () =>
          Promise.resolve({
            cerbosCallId: 'test',
            requestId: 'test',
            validationErrors: [],
            ...plan,
          });
      }
      return method.bind(target);
    },
  });
}

/** Any span `@opentelemetry/instrumentation-pg` records: a query, a connect, a pool connect. */
const isDatabaseSpan = (name: string): boolean => /^pg[.-]/.test(name);

const item = (
  blueprint: string,
  identifier: string,
  title: string,
  match: SearchItem['match'],
): SearchItem => ({ blueprint, identifier, title, match });

describe('search.entities (003 task 3.6, design D5, Q19, Q52)', () => {
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;

  beforeAll(async () => {
    // Migrations need the owner connection: tayzu_app has no DDL privilege.
    const ownerDb = connectAsOwner(databaseUrl());
    await runMigrations(ownerDb.$client);
    await endQuietly(ownerDb.$client);
    pool = connect(databaseUrl()).$client;
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool, authz });
    entities = createEntityService({ pool, authz });
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  /** A router client whose entity service authorizes through `authzClient`. */
  function routerClient(authzClient: CerbosClient = authz) {
    const router = createCatalogRouter({
      blueprints,
      entities: createEntityService({ pool, authz: authzClient }),
    });
    return createRouterClient(router, { context: (raw: HostContext) => raw });
  }

  type Client = ReturnType<typeof routerClient>;

  /** Calls `search.entities` through the router with the host-supplied `context`. */
  async function search(
    context: HostContext,
    input: SearchInput,
    client: Client = routerClient(),
  ): Promise<SearchOutput> {
    return client.search.entities(input, { context });
  }

  async function createBlueprints(
    tenantId: string,
    identifiers: readonly string[],
    withOwnerTeam = false,
  ): Promise<void> {
    for (const identifier of identifiers) {
      await blueprints.create(
        adminCtx(tenantId),
        blueprintInput(
          identifier,
          withOwnerTeam
            ? { relations: { ownerTeam: { title: { en: 'Owner team' }, target: '_team' } } }
            : {},
        ),
      );
    }
  }

  async function createEntity(
    tenantId: string,
    blueprint: string,
    identifier: string,
    title: string,
    options: { readonly creator?: string; readonly ownerTeam?: string } = {},
  ): Promise<void> {
    await entities.create(hostContext(tenantId, options.creator ?? 'user-1', ADMIN), {
      blueprint,
      identifier,
      title,
      spec: {
        properties: {},
        relations: options.ownerTeam === undefined ? {} : { ownerTeam: options.ownerTeam },
      },
    });
  }

  describe('Identifier prefix across blueprints', () => {
    it('Identifier prefix across blueprints: payments-api (service) and payments-db (database) are both returned for "paym" with match identifier, ordered by blueprint identifier', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service', 'database']);
      await createEntity(tenantId, 'service', 'payments-api', 'Payments API');
      await createEntity(tenantId, 'database', 'payments-db', 'Payments DB');
      await createEntity(tenantId, 'service', 'ledger', 'Ledger');

      const result = await search(adminCtx(tenantId), { q: 'paym' });

      expect(result).toEqual({
        items: [
          item('database', 'payments-db', 'Payments DB', 'identifier'),
          item('service', 'payments-api', 'Payments API', 'identifier'),
        ],
      });
    });
  });

  describe('Title similarity finds a typo', () => {
    it('Title similarity finds a typo: an entity titled "Payments Gateway" is returned for "Paymnets Gateway" with match title', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'pgw', 'Payments Gateway');
      await createEntity(tenantId, 'service', 'ledger', 'Ledger Service');

      const result = await search(adminCtx(tenantId), { q: 'Paymnets Gateway' });

      expect(result).toEqual({ items: [item('service', 'pgw', 'Payments Gateway', 'title')] });
    });
  });

  describe('Wildcards match literally', () => {
    it('Wildcards match literally: "a_" returns a_b (titled First) and not axb (titled Second)', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'a_b', 'First');
      await createEntity(tenantId, 'service', 'axb', 'Second');

      const result = await search(adminCtx(tenantId), { q: 'a_' });

      expect(result).toEqual({ items: [item('service', 'a_b', 'First', 'identifier')] });
    });

    it('Wildcards match literally: "100%" matches the title "100% uptime target" and not "1000 requests per second budget"', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'uptime', '100% uptime target');
      await createEntity(tenantId, 'service', 'requests', '1000 requests per second budget');

      const result = await search(adminCtx(tenantId), { q: '100%' });

      expect(result).toEqual({
        items: [item('service', 'uptime', '100% uptime target', 'title')],
      });
    });

    it('Wildcards match literally: "C:\\t" matches the title "C:\\temp folder" and not "C:tools for nightly maintenance windows"', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'temp', 'C:\\temp folder');
      await createEntity(tenantId, 'service', 'tools', 'C:tools for nightly maintenance windows');

      const result = await search(adminCtx(tenantId), { q: 'C:\\t' });

      expect(result).toEqual({ items: [item('service', 'temp', 'C:\\temp folder', 'title')] });
    });
  });

  describe('Search shows only what the caller may list', () => {
    /**
     * Teams `platform` and `other`; blueprints `service` and `database`, both
     * with an `ownerTeam` relation; every seeded entity matches the prefix
     * `pay`, across both blueprints and both teams, plus one unowned.
     */
    async function seedOwnedEntities(): Promise<string> {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);
      for (const team of ['platform', 'other']) {
        await entities.create(systemCtx(tenantId), {
          blueprint: '_team',
          identifier: team,
          title: team,
        });
      }
      await createBlueprints(tenantId, ['service', 'database'], true);
      await createEntity(tenantId, 'service', 'payplatformsvc', 'Platform service', {
        ownerTeam: 'platform',
      });
      await createEntity(tenantId, 'database', 'payplatformdb', 'Platform database', {
        ownerTeam: 'platform',
      });
      await createEntity(tenantId, 'service', 'payothersvc', 'Other service', {
        ownerTeam: 'other',
      });
      await createEntity(tenantId, 'database', 'payotherdb', 'Other database', {
        ownerTeam: 'other',
      });
      await createEntity(tenantId, 'service', 'payunowned', 'Unowned service');
      return tenantId;
    }

    it('Search shows only what the caller may list: a member who may read only their team-owned entities sees exactly those, across blueprints', async () => {
      const tenantId = await seedOwnedEntities();
      const member: Principal = { roles: ['member'], teams: ['platform'] };
      const teamPlan = conditional({
        operator: 'in',
        operands: [attr('ownerTeam'), { value: ['platform'] }],
      });

      const result = await search(
        hostContext(tenantId, 'member-1', member),
        { q: 'pay' },
        routerClient(withPlan(authz, teamPlan)),
      );

      expect(result).toEqual({
        items: [
          item('database', 'payplatformdb', 'Platform database', 'identifier'),
          item('service', 'payplatformsvc', 'Platform service', 'identifier'),
        ],
      });
    });

    it('Search shows only what the caller may list: the same prefix shows an admin every matching entity of every team (control)', async () => {
      const tenantId = await seedOwnedEntities();

      const result = await search(adminCtx(tenantId), { q: 'pay' });

      expect(result).toEqual({
        items: [
          item('database', 'payotherdb', 'Other database', 'identifier'),
          item('database', 'payplatformdb', 'Platform database', 'identifier'),
          item('service', 'payothersvc', 'Other service', 'identifier'),
          item('service', 'payplatformsvc', 'Platform service', 'identifier'),
          item('service', 'payunowned', 'Unowned service', 'identifier'),
        ],
      });
    });

    it("Search shows only what the caller may list: a moderator of one blueprint (real plan) sees only that blueprint's entities", async () => {
      const tenantId = await seedOwnedEntities();
      // No base role: the only list grant is the moderates_blueprint derived role.
      const moderator: Principal = {
        roles: ['viewer'],
        teams: [],
        moderatedBlueprints: ['service'],
      };

      const result = await search(hostContext(tenantId, 'moderator-1', moderator), { q: 'pay' });

      expect(result).toEqual({
        items: [
          item('service', 'payothersvc', 'Other service', 'identifier'),
          item('service', 'payplatformsvc', 'Platform service', 'identifier'),
          item('service', 'payunowned', 'Unowned service', 'identifier'),
        ],
      });
    });
  });

  describe('A denied plan returns no items', () => {
    it('A denied plan returns no items: an ALWAYS_DENIED plan answers { items: [] }, not an error', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'payments-api', 'Payments API');
      const member: Principal = { roles: ['member'] };

      const result = await search(
        hostContext(tenantId, 'member-1', member),
        { q: 'payments' },
        routerClient(withPlan(authz, ALWAYS_DENIED)),
      );

      expect(result).toEqual({ items: [] });
    });

    it('A denied plan returns no items: a caller with no list grant (real ALWAYS_DENIED plan) gets { items: [] }', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'payments-api', 'Payments API');
      const viewer: Principal = { roles: ['viewer'], teams: ['platform'], moderatedBlueprints: [] };

      const result = await search(hostContext(tenantId, 'viewer-1', viewer), { q: 'payments' });

      expect(result).toEqual({ items: [] });
    });
  });

  describe("Another tenant's entity is never found", () => {
    it("Another tenant's entity is never found: secret-svc exists only in t1, and a t2 caller searching for secret gets an empty result", async () => {
      const t1 = randomTenantId();
      const t2 = randomTenantId();
      await createBlueprints(t1, ['service']);
      await createEntity(t1, 'service', 'secret-svc', 'Secret service');
      // t2 has the same blueprint and its own, non-matching entity.
      await createBlueprints(t2, ['service']);
      await createEntity(t2, 'service', 'public-svc', 'Public service');

      // Control: t1 finds its own entity.
      expect(await search(adminCtx(t1), { q: 'secret' })).toEqual({
        items: [item('service', 'secret-svc', 'Secret service', 'identifier')],
      });
      expect(await search(adminCtx(t2), { q: 'secret' })).toEqual({ items: [] });
    });
  });

  describe('Limits are checked before the database', () => {
    beforeEach(async () => {
      await harness.reset();
    });

    /** The database spans recorded since the last `reset()`. */
    async function databaseSpanNames(): Promise<string[]> {
      await harness.forceFlush();
      return harness.spanExporter
        .getFinishedSpans()
        .map((span) => span.name)
        .filter(isDatabaseSpan);
    }

    const rejectedQueries: readonly { readonly name: string; readonly q: string }[] = [
      { name: 'a 101-character query', q: 'a'.repeat(101) },
      { name: 'a 1-character query', q: 'a' },
      { name: 'a query of 1 character after trimming', q: '  a  ' },
      { name: 'a query with a control character', q: 'pay\u0000ments' },
    ];

    for (const { name, q } of rejectedQueries) {
      it(`Limits are checked before the database: ${name} fails with CATALOG_VALIDATION_FAILED on /q and no database query is made`, async () => {
        const tenantId = randomTenantId();
        const error = await expectCatalogErrorCode(
          search(adminCtx(tenantId), { q }),
          'CATALOG_VALIDATION_FAILED',
        );
        expect(error.issues?.map((issue) => issue.path)).toEqual(['/q']);
        expect(await databaseSpanNames()).toEqual([]);
      });
    }

    it('Limits are checked before the database: a limit of 51 fails with CATALOG_LIMIT_EXCEEDED naming search.maxLimit and no database query is made', async () => {
      const tenantId = randomTenantId();
      const error = await expectCatalogErrorCode(
        search(adminCtx(tenantId), { q: 'payments', limit: 51 }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(error.details?.['limit']).toBe('search.maxLimit');
      expect(await databaseSpanNames()).toEqual([]);
    });

    for (const limit of [0, -1]) {
      it(`Limits are checked before the database: a limit of ${String(limit)} fails with CATALOG_VALIDATION_FAILED on /limit (Q52) and no database query is made`, async () => {
        const tenantId = randomTenantId();
        const error = await expectCatalogErrorCode(
          search(adminCtx(tenantId), { q: 'payments', limit }),
          'CATALOG_VALIDATION_FAILED',
        );
        expect(error.issues?.map((issue) => issue.path)).toEqual(['/limit']);
        expect(await databaseSpanNames()).toEqual([]);
      });
    }

    it('Limits are checked before the database: a 100-character query with a limit of 50 is accepted and does query the database (control)', async () => {
      const tenantId = randomTenantId();
      const result = await search(adminCtx(tenantId), { q: 'p'.repeat(100), limit: 50 });
      expect(result).toEqual({ items: [] });
      expect((await databaseSpanNames()).length).toBeGreaterThan(0);
    });
  });

  describe('The _user and _team system blueprints are searched under the plan (Q19)', () => {
    async function seedSystemEntities(): Promise<string> {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);
      await entities.create(systemCtx(tenantId), {
        blueprint: '_team',
        identifier: 'payments-team',
        title: 'Payments Team',
      });
      await entities.create(systemCtx(tenantId), {
        blueprint: '_user',
        identifier: 'payments.owner@example.com',
        title: 'Pat Owner',
        spec: { properties: { portRole: 'member' } },
      });
      await createBlueprints(tenantId, ['service']);
      await createEntity(tenantId, 'service', 'payments-api', 'Payments API', {
        creator: 'user-a',
      });
      return tenantId;
    }

    const teamItem = item('_team', 'payments-team', 'Payments Team', 'identifier');
    const userItem = item('_user', 'payments.owner@example.com', 'Pat Owner', 'identifier');
    const serviceItem = item('service', 'payments-api', 'Payments API', 'identifier');

    it('Q19: an admin finds _user and _team entities next to the other blueprints', async () => {
      const tenantId = await seedSystemEntities();

      const result = await search(adminCtx(tenantId), { q: 'payments' });

      expect(result.items).toHaveLength(3);
      expect(result.items).toEqual(expect.arrayContaining([teamItem, userItem, serviceItem]));
    });

    it('Q19: a member (real ALWAYS_ALLOWED plan) finds _user and _team entities too', async () => {
      const tenantId = await seedSystemEntities();
      const member: Principal = { roles: ['member'] };

      const result = await search(hostContext(tenantId, 'member-1', member), { q: 'payments' });

      expect(result.items).toHaveLength(3);
      expect(result.items).toEqual(expect.arrayContaining([teamItem, userItem, serviceItem]));
    });

    it('Q19: the plan narrows _user and _team entities like any other (createdBy plans keep or drop them)', async () => {
      const tenantId = await seedSystemEntities();
      const member: Principal = { roles: ['member'] };
      const createdBy = (actorId: string) =>
        routerClient(
          withPlan(
            authz,
            conditional({ operator: 'eq', operands: [attr('createdBy'), { value: actorId }] }),
          ),
        );

      const systemOnly = await search(
        hostContext(tenantId, 'member-1', member),
        { q: 'payments' },
        createdBy(SYSTEM_SEED_ACTOR_ID),
      );
      expect(systemOnly.items).toHaveLength(2);
      expect(systemOnly.items).toEqual(expect.arrayContaining([teamItem, userItem]));

      const userAOnly = await search(
        hostContext(tenantId, 'member-1', member),
        { q: 'payments' },
        createdBy('user-a'),
      );
      expect(userAOnly).toEqual({ items: [serviceItem] });
    });
  });

  describe('Ranking and tie order (design D5)', () => {
    /**
     * Blueprints `database`, `queue` and `service`. For `q = 'Payments'`:
     * - exact identifier (case-insensitive): database/payments, service/payments;
     * - identifier prefix: database/paymentsarchive, database/paymentsledger,
     *   service/paymentsapi (titled `Payments`, the highest similarity, yet
     *   last of its tier by blueprint);
     * - title prefix: database/store (similarity 0.18), queue/events (0.82);
     * - similarity only: service/x `Paymentz` (0.64), then database/gw and
     *   queue/gw `Paymnets` (0.38 each, tied, so by blueprint);
     * - no match: service/ledger.
     */
    async function seedRanking(): Promise<string> {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service', 'queue', 'database']);
      await createEntity(tenantId, 'service', 'ledger', 'Ledger');
      await createEntity(tenantId, 'queue', 'gw', 'Paymnets');
      await createEntity(tenantId, 'database', 'gw', 'Paymnets');
      await createEntity(tenantId, 'service', 'x', 'Paymentz');
      await createEntity(tenantId, 'queue', 'events', 'Payments e');
      await createEntity(
        tenantId,
        'database',
        'store',
        'payments store with a very long descriptive title',
      );
      await createEntity(tenantId, 'service', 'paymentsapi', 'Payments');
      await createEntity(tenantId, 'database', 'paymentsledger', 'Zulu');
      await createEntity(tenantId, 'database', 'paymentsarchive', 'Zulu');
      await createEntity(tenantId, 'service', 'payments', 'Zulu');
      await createEntity(tenantId, 'database', 'payments', 'Zulu');
      return tenantId;
    }

    const RANKED: readonly SearchItem[] = [
      item('database', 'payments', 'Zulu', 'identifier'),
      item('service', 'payments', 'Zulu', 'identifier'),
      item('database', 'paymentsarchive', 'Zulu', 'identifier'),
      item('database', 'paymentsledger', 'Zulu', 'identifier'),
      item('service', 'paymentsapi', 'Payments', 'identifier'),
      item('database', 'store', 'payments store with a very long descriptive title', 'title'),
      item('queue', 'events', 'Payments e', 'title'),
      item('service', 'x', 'Paymentz', 'title'),
      item('database', 'gw', 'Paymnets', 'title'),
      item('queue', 'gw', 'Paymnets', 'title'),
    ];

    it('ranks exact identifier, identifier prefix, title prefix, then similarity descending, with ties by blueprint then identifier', async () => {
      const tenantId = await seedRanking();

      const result = await search(adminCtx(tenantId), { q: 'Payments' });

      expect(result).toEqual({ items: RANKED });
    });

    it('applies the limit after ranking: limit 3 returns the first three ranked items', async () => {
      const tenantId = await seedRanking();

      const result = await search(adminCtx(tenantId), { q: 'Payments', limit: 3 });

      expect(result).toEqual({ items: RANKED.slice(0, 3) });
    });

    it('trims the query before matching', async () => {
      const tenantId = await seedRanking();

      const result = await search(adminCtx(tenantId), { q: '  Payments  ' });

      expect(result).toEqual({ items: RANKED });
    });
  });

  describe('The result limit defaults to 20 and is at most 50', () => {
    it('returns 20 items without a limit, and all 22 matches with a limit of 50', async () => {
      const tenantId = randomTenantId();
      await createBlueprints(tenantId, ['service']);
      const identifiers = Array.from(
        { length: 22 },
        (_, index) => `item${String(index).padStart(2, '0')}`,
      );
      for (const identifier of identifiers) {
        await createEntity(tenantId, 'service', identifier, 'Zulu');
      }
      const expected = identifiers.map((identifier) =>
        item('service', identifier, 'Zulu', 'identifier'),
      );

      expect(await search(adminCtx(tenantId), { q: 'item' })).toEqual({
        items: expected.slice(0, 20),
      });
      expect(await search(adminCtx(tenantId), { q: 'item', limit: 50 })).toEqual({
        items: expected,
      });
    });
  });
});
