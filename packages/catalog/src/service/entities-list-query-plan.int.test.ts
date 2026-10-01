/**
 * Integration test for task 23.3 (openspec/changes/002-auth-and-rbac; design
 * Q34, D7, D9, D11; spec auth-and-rbac, requirements "Team ownership",
 * "Moderator role scoped to blueprints", "Dynamic attribute-based access
 * control" and "Authorization is decided by Cerbos and fails closed").
 *
 * Runs through the real `createEntityService({ pool, authz }).list`, a real
 * PostgreSQL and the real Cerbos container on localhost:3593. Where the repo's
 * policies never emit a given plan operand for `list` (they yield
 * ALWAYS_ALLOWED for `member`, ALWAYS_DENIED for a team-only principal), the
 * `PlanResources` result is overridden with the plan the policy WOULD emit,
 * through a Proxy over the real client; the mapper under test is the same.
 *
 * ## Production symbols assumed
 *
 * - `ENTITY_PLAN_MAPPER` in `entities.ts` (or its replacement) maps, besides
 *   `createdBy` and `tenantId`:
 *   - `request.resource.attr.blueprintId` -> the row's blueprint IDENTIFIER
 *     (the value `moderatedBlueprints` holds), not the uuid column;
 *   - `request.resource.attr.ownerTeam` -> the effective owner team
 *     identifier (direct `ownerTeam` relation edge; absent/NULL when none);
 *   - `request.resource.attr.locked` -> `spec.properties.locked` (boolean).
 *   The mapping is a SQL expression inside the page query (parameterized).
 * - An unmapped attribute or unsupported operator still throws, so the list
 *   is denied: no row is returned.
 * - Direct ownership is the `ownerTeam` relation, as in
 *   `entity-authz-attributes.int.test.ts`.
 */
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput } from './__fixtures__/entity-a-test-helpers.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

type Principal = {
  roles: string[];
  teams?: string[];
  moderatedBlueprints?: string[];
};

const ADMIN: Principal = { roles: ['admin'] };

function ctx(tenantId: string, actorId: string, principal: Principal): Record<string, unknown> {
  return { tenantId, actor: { type: 'user', id: actorId }, principal };
}

/** A duck-typed `PlanResources` result, like `@cerbos/core`'s response. */
type FakePlan = { readonly kind: string; readonly condition?: unknown };

/** Wraps the real client; `plan` (when given) replaces the `planResources` answer. */
function withPlan(real: CerbosClient, plan?: FakePlan): CerbosClient {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'planResources' && plan !== undefined) {
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

const conditional = (condition: unknown): FakePlan => ({ kind: 'KIND_CONDITIONAL', condition });
const attr = (name: string) => ({ name: `request.resource.attr.${name}` });

describe('entities.list query-plan mapper (task 23.3, Q34, D11)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const real = createCerbosClient({ address: 'localhost:3593', tls: false });
  const blueprints = createBlueprintService({ pool, authz: real });
  const seed = createEntityService({ pool, authz: real });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  /**
   * Tenant with teams `platform`/`other`, blueprints `service` and
   * `deployment` (each with `ownerTeam` and boolean `locked`), and `service`
   * entities:
   *   platform-1 (team platform, creator user-a), platform-2 (platform, creator user-b, locked),
   *   other-1 (team other, creator user-a), unowned-1 (no team, creator user-b);
   * and `deployment` entity deploy-1 (team platform, creator user-a).
   */
  async function newTenant(): Promise<string> {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz: real }, tenantId);
    const system = {
      tenantId,
      actor: { type: 'system', id: 'query-plan-seed' },
      principal: ADMIN,
    };
    for (const team of ['platform', 'other']) {
      await seed.create(system, { blueprint: '_team', identifier: team, title: team });
    }
    for (const identifier of ['service', 'deployment']) {
      await blueprints.create(
        ctx(tenantId, 'admin-1', ADMIN),
        blueprintInput(identifier, {
          schema: {
            properties: { locked: { type: 'boolean', title: { en: 'Locked' } } },
            required: [],
          },
          statusSchema: { properties: {} },
          relations: { ownerTeam: { title: { en: 'Owner team' }, target: '_team' } },
        }),
      );
    }
    const create = (
      blueprint: string,
      identifier: string,
      creator: string,
      team?: string,
      locked?: boolean,
    ) =>
      seed.create(ctx(tenantId, creator, ADMIN), {
        blueprint,
        identifier,
        title: identifier,
        spec: {
          properties: locked === undefined ? {} : { locked },
          relations: team === undefined ? {} : { ownerTeam: team },
        },
      });
    await create('service', 'platform-1', 'user-a', 'platform');
    await create('service', 'platform-2', 'user-b', 'platform', true);
    await create('service', 'other-1', 'user-a', 'other');
    await create('service', 'unowned-1', 'user-b');
    await create('deployment', 'deploy-1', 'user-a', 'platform');
    return tenantId;
  }

  async function identifiers(
    tenantId: string,
    who: Principal,
    blueprint: string,
    plan?: FakePlan,
  ): Promise<string[]> {
    const entities = createEntityService({ pool, authz: withPlan(real, plan) });
    const page = await entities.list(ctx(tenantId, 'lister', who), { blueprint });
    return page.items.map((item) => item.identifier).sort();
  }

  it('Team member lists entities: a member with a team membership sees every entity (real plan)', async () => {
    const tenantId = await newTenant();
    const member: Principal = { roles: ['member'], teams: ['platform'] };
    expect(await identifiers(tenantId, member, 'service')).toEqual([
      'other-1',
      'platform-1',
      'platform-2',
      'unowned-1',
    ]);
  });

  it('Team member lists entities: a plan conditional on ownerTeam returns exactly the rows the team owns', async () => {
    const tenantId = await newTenant();
    const member: Principal = { roles: ['member'], teams: ['platform'] };
    const plan = conditional({
      operator: 'in',
      operands: [attr('ownerTeam'), { value: ['platform'] }],
    });
    expect(await identifiers(tenantId, member, 'service', plan)).toEqual([
      'platform-1',
      'platform-2',
    ]);
    // A plan for another team narrows to that team only; unowned rows never match.
    const otherPlan = conditional({
      operator: 'eq',
      operands: [attr('ownerTeam'), { value: 'other' }],
    });
    expect(await identifiers(tenantId, member, 'service', otherPlan)).toEqual(['other-1']);
  });

  it('Moderator lists entities: a moderator of one blueprint sees its entities and nothing of another (real plan)', async () => {
    const tenantId = await newTenant();
    // No base role: the only list grant is the moderates_blueprint derived role.
    const moderator: Principal = { roles: ['viewer'], teams: [], moderatedBlueprints: ['service'] };
    expect(await identifiers(tenantId, moderator, 'service')).toEqual([
      'other-1',
      'platform-1',
      'platform-2',
      'unowned-1',
    ]);
    expect(await identifiers(tenantId, moderator, 'deployment')).toEqual([]);
  });

  it('Admin lists entities: an admin sees every entity of the blueprint (real plan)', async () => {
    const tenantId = await newTenant();
    expect(await identifiers(tenantId, ADMIN, 'service')).toEqual([
      'other-1',
      'platform-1',
      'platform-2',
      'unowned-1',
    ]);
    expect(await identifiers(tenantId, ADMIN, 'deployment')).toEqual(['deploy-1']);
  });

  it('Attribute-based list filters: createdBy narrows to the creator, and a locked plan narrows to locked entities', async () => {
    const tenantId = await newTenant();
    const member: Principal = { roles: ['member'], teams: [] };
    const createdBy = conditional({
      operator: 'eq',
      operands: [attr('createdBy'), { value: 'user-a' }],
    });
    expect(await identifiers(tenantId, member, 'service', createdBy)).toEqual([
      'other-1',
      'platform-1',
    ]);
    const locked = conditional({ operator: 'eq', operands: [attr('locked'), { value: true }] });
    expect(await identifiers(tenantId, member, 'service', locked)).toEqual(['platform-2']);
  });

  it('A combined plan (team OR moderated blueprint) is filtered as a whole, tenant scope intact', async () => {
    const tenantId = await newTenant();
    const otherTenant = await newTenant();
    const member: Principal = { roles: ['member'], teams: ['other'], moderatedBlueprints: [] };
    const plan = conditional({
      operator: 'or',
      operands: [
        { operator: 'eq', operands: [attr('ownerTeam'), { value: 'other' }] },
        { operator: 'eq', operands: [attr('createdBy'), { value: 'user-b' }] },
      ],
    });
    const got = await identifiers(tenantId, member, 'service', plan);
    expect(got).toEqual(['other-1', 'platform-2', 'unowned-1']);
    // The other tenant has identical identifiers; none leak across.
    expect(await identifiers(otherTenant, member, 'service', plan)).toEqual(got);
  });

  it('An unsupported plan operator still fails closed: the list rejects and returns no rows', async () => {
    const tenantId = await newTenant();
    const member: Principal = { roles: ['member'], teams: ['platform'] };
    const entities = createEntityService({
      pool,
      authz: withPlan(
        real,
        conditional({
          operator: 'not-a-real-operator',
          operands: [attr('ownerTeam'), { value: 'x' }],
        }),
      ),
    });
    const outcome = await entities
      .list(ctx(tenantId, 'lister', member), { blueprint: 'service' })
      .then(
        (page) => ({ rows: page.items.length }),
        () => ({ rejected: true }),
      );
    expect(outcome).toEqual({ rejected: true });
  });

  it('An unmapped plan attribute still fails closed: the list rejects and returns no rows', async () => {
    const tenantId = await newTenant();
    const member: Principal = { roles: ['member'], teams: ['platform'] };
    const entities = createEntityService({
      pool,
      authz: withPlan(
        real,
        conditional({ operator: 'eq', operands: [attr('somethingElse'), { value: 'x' }] }),
      ),
    });
    const outcome = await entities
      .list(ctx(tenantId, 'lister', member), { blueprint: 'service' })
      .then(
        (page) => ({ rows: page.items.length }),
        () => ({ rejected: true }),
      );
    expect(outcome).toEqual({ rejected: true });
  });
});
