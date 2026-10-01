/**
 * Integration tests for task 9.2 (openspec/changes/002-auth-and-rbac, design
 * D7 and D11, Resolved decisions Q26/Q27; spec auth-and-rbac, "Authorization
 * is decided by Cerbos and fails closed").
 *
 * Runs end-to-end through `createEntityService({ pool, authz }).list`, a real
 * PostgreSQL and the real Cerbos container on localhost:3593. The Cerbos
 * client is wrapped in a recording proxy that can override `planResources`
 * with a crafted plan, and the pool is wrapped so every SQL statement the
 * operation sends to Postgres is captured. That is how the tests prove the
 * authorization filter is inside the database query rather than applied after
 * a scan.
 *
 * ## Production symbols assumed
 *
 * - `entities.list` calls `authz.planResources({ principal, resource: { kind:
 *   'catalog_entity' }, action: 'list' })` exactly once (D11), with the
 *   principal id / roles from the host-supplied context, and turns the result
 *   into a Drizzle `WHERE` through `@cerbos/orm-drizzle`, composed with the
 *   tenant scope by `and(...)` in every plan-result branch.
 * - The plan-variable-to-column mapping is `request.resource.attr.createdBy`
 *   -> `catalog_entity.created_by_id` (the attribute names in
 *   `policies/resource_policies/catalog_entity.yaml`).
 * - `entities.list` does not scan-and-check: it makes no `checkResources`
 *   call naming any listed entity.
 */
import { runMigrations } from '@tayzu/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Import order is load-bearing: the harness must register before any module
// that creates instruments at import time (see pipeline.int.test.ts).
import { registration } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { authz } from './__fixtures__/authz-test-helpers.js';
import { blueprintInput, ctx, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';

interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A fake `PlanResources` result, duck-typed like `@cerbos/core`'s response. */
type FakePlan =
  | { readonly kind: 'KIND_ALWAYS_ALLOWED' }
  | { readonly kind: 'KIND_ALWAYS_DENIED' }
  | { readonly kind: 'KIND_CONDITIONAL'; readonly condition: unknown };

const CREATED_BY_EQ = (userId: string): FakePlan => ({
  kind: 'KIND_CONDITIONAL',
  condition: {
    operator: 'eq',
    operands: [{ name: 'request.resource.attr.createdBy' }, { value: userId }],
  },
});

/** Wraps the real Cerbos client, recording calls and optionally faking the plan. */
function recordingAuthz(plan?: FakePlan) {
  const planCalls: unknown[] = [];
  const checkCalls: unknown[] = [];
  const client = new Proxy(authz, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === 'planResources') {
        return async (request: unknown) => {
          planCalls.push(request);
          if (plan === undefined) {
            return (target.planResources as (r: unknown) => Promise<unknown>).call(target, request);
          }
          return { cerbosCallId: 'test', requestId: 'test', validationErrors: [], ...plan };
        };
      }
      if (prop === 'checkResources' || prop === 'checkResource') {
        return (...args: unknown[]) => {
          checkCalls.push(args[0]);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { client: client, planCalls, checkCalls };
}

/** Wraps a pool so every statement sent through a checked-out client is recorded. */
function recordingPool(real: Pool, statements: RecordedStatement[]): Pool {
  const wrapClient = (client: object): object =>
    new Proxy(client, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (prop === 'query') {
          return (...args: unknown[]) => {
            const first = args[0];
            const text =
              typeof first === 'string' ? first : ((first as { text?: string }).text ?? '');
            // pg accepts (text, values) and (config, values); drizzle passes the
            // bind values as the second argument next to a config object.
            const values = Array.isArray(args[1])
              ? (args[1] as unknown[])
              : typeof first === 'string'
                ? []
                : ((first as { values?: unknown[] }).values ?? []);
            statements.push({ text, values });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === 'connect') {
        return async () => wrapClient(await target.connect());
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** The statements that read `catalog_entity` rows (the list's page query). */
function entityReads(statements: readonly RecordedStatement[]): RecordedStatement[] {
  return statements.filter(
    (s) =>
      /\bfrom\s+(?:"[\w]+"\.)?"?catalog_entity"?(?!\w)/i.test(s.text) && /^\s*select/i.test(s.text),
  );
}

describe('entities.list uses the Cerbos query plan (task 9.2)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const seedBlueprints = createBlueprintService({ pool, authz });
  const seedEntities = createEntityService({ pool, authz });

  beforeAll(async () => {
    if ('error' in registration) throw new Error('harness registration failed');
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  beforeEach(() => {
    // The registered harness only needs to be imported; nothing to reset here.
  });

  async function seed(
    tenantId: string,
    blueprint: string,
    creators: Record<string, string>,
  ): Promise<void> {
    await seedBlueprints.create(ctx(tenantId), blueprintInput(blueprint));
    for (const [identifier, userId] of Object.entries(creators)) {
      await seedEntities.create(
        ctx(tenantId, { type: 'user', id: userId }),
        entityInput(blueprint, identifier),
      );
    }
  }

  describe('List results are filtered by the query plan, not by scanning and checking', () => {
    it('List results are filtered by the query plan, not by scanning and checking: only the entities the plan admits are returned and the SQL carries the filter', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', { 'a-1': 'user-a', 'a-2': 'user-a', 'b-1': 'user-b' });

      const statements: RecordedStatement[] = [];
      const spy = recordingAuthz(CREATED_BY_EQ('user-a'));
      const entities = createEntityService({
        pool: recordingPool(pool, statements),
        authz: spy.client,
      });

      const page = await entities.list(ctx(tenantId), { blueprint: 'service' });

      // Only what the plan admits comes back.
      expect(page.items.map((item) => item.identifier)).toEqual(['a-1', 'a-2']);

      // The plan was requested once, for this principal and the entity kind.
      expect(spy.planCalls).toHaveLength(1);
      expect(spy.planCalls[0]).toMatchObject({
        principal: { id: 'user-1', roles: ['admin'] },
        resource: { kind: 'catalog_entity' },
        action: 'list',
      });

      // The database query itself carries the authorization filter (on the
      // creator column), alongside the tenant scope.
      const reads = entityReads(statements);
      expect(reads.length).toBeGreaterThan(0);
      const pageQuery = reads.find((s) => /created_by_id/i.test(s.text));
      expect(pageQuery, 'no catalog_entity read filters on created_by_id').toBeDefined();
      expect(pageQuery?.text).toMatch(/tenant_id/i);
      expect(pageQuery?.values).toContain('user-a');
      expect(pageQuery?.values).toContain(tenantId);
    });

    it('List results are filtered by the query plan, not by scanning and checking: no per-entity CheckResources scan happens', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', { 'a-1': 'user-a', 'b-1': 'user-b' });

      const spy = recordingAuthz(CREATED_BY_EQ('user-a'));
      const entities = createEntityService({ pool, authz: spy.client });

      await entities.list(ctx(tenantId), { blueprint: 'service' });

      const checkedIds = JSON.stringify(spy.checkCalls);
      expect(checkedIds).not.toContain('a-1');
      expect(checkedIds).not.toContain('b-1');
    });

    it('List results are filtered by the query plan, not by scanning and checking: an unmodified real plan for an admin lists every entity of the blueprint', async () => {
      const tenantId = randomTenantId();
      await seed(tenantId, 'service', { 'a-1': 'user-a', 'b-1': 'user-b' });

      const spy = recordingAuthz();
      const entities = createEntityService({ pool, authz: spy.client });

      const page = await entities.list(ctx(tenantId), { blueprint: 'service' });

      expect(page.items.map((item) => item.identifier)).toEqual(['a-1', 'b-1']);
      expect(spy.planCalls).toHaveLength(1);
    });
  });

  describe('An ALWAYS_ALLOWED plan still carries the tenant scope', () => {
    it('An ALWAYS_ALLOWED plan still carries the tenant scope: the SQL keeps the mandatory tenant_id predicate', async () => {
      const tenantId = randomTenantId();
      const otherTenantId = randomTenantId();
      await seed(tenantId, 'service', { 'mine-1': 'user-a' });
      await seed(otherTenantId, 'service', { 'theirs-1': 'user-a' });

      const statements: RecordedStatement[] = [];
      const spy = recordingAuthz({ kind: 'KIND_ALWAYS_ALLOWED' });
      const entities = createEntityService({
        pool: recordingPool(pool, statements),
        authz: spy.client,
      });

      const page = await entities.list(ctx(tenantId), { blueprint: 'service' });

      // The plan was consulted and answered "always allowed"...
      expect(spy.planCalls).toHaveLength(1);
      expect(page.items.map((item) => item.identifier)).toEqual(['mine-1']);

      // ...and the entity read still has its own tenant predicate bound to the
      // caller's tenant, independent of Postgres RLS.
      const reads = entityReads(statements);
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.text).toMatch(/tenant_id/i);
        expect(read.values).toContain(tenantId);
        expect(read.values).not.toContain(otherTenantId);
      }
    });
  });
});
