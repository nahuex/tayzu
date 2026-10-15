/**
 * Integration test for task 13.6 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
 * (002 VCDM M4; the hand-off table in design.md, "Hand-offs from 002").
 *
 * Authorization and the write must run against the same state: the handler
 * re-verifies `ownerTeam`, `locked` and `createdBy` inside its own transaction,
 * after `FOR UPDATE`, so a concurrent change made between the Cerbos check and
 * the write is seen, and an `upsert` authorized as `create` cannot land as an
 * update.
 *
 * The interleaving is deterministic: the Cerbos client is wrapped so that, right
 * after the first `catalog_entity` decision of the operation under test comes
 * back (the operation has been authorized, its write has not started), a
 * competing change is committed by another actor. Everything else is the real
 * catalog operations, a real PostgreSQL and the real Cerbos container.
 *
 * Expectation (nothing in the spec pins the code beyond "fails closed"): the
 * racing operation is refused with `AUTH_FORBIDDEN` and writes nothing.
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

interface CheckRequest {
  readonly resources: readonly {
    readonly resource: { kind: string };
  }[];
}

type Principal = {
  roles: string[];
  teams?: string[];
  moderatedBlueprints?: string[];
};

function ctx(tenantId: string, actorId: string, principal: Principal): Record<string, unknown> {
  return { tenantId, actor: { type: 'user', id: actorId }, principal };
}

const ADMIN: Principal = { roles: ['admin'] };

async function thrownCode(promise: Promise<unknown>): Promise<unknown> {
  const thrown: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown, 'expected the operation to reject').toBeDefined();
  return (thrown as { code?: unknown }).code;
}

describe('the write re-verifies what the authorization decided on (task 13.6, 002 VCDM M4)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const real = createCerbosClient({ address: 'localhost:3593', tls: false });

  /** Runs once, after the next `catalog_entity` decision has been returned to the pipeline. */
  let afterNextDecision: (() => Promise<void>) | undefined;

  const authz: CerbosClient = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (prop === 'checkResources') {
        return async (request: CheckRequest) => {
          const result = await (method.call(target, request) as Promise<unknown>);
          const isEntityCheck = request.resources.some(
            (entry) => entry.resource.kind === 'catalog_entity',
          );
          if (isEntityCheck && afterNextDecision !== undefined) {
            const race = afterNextDecision;
            afterNextDecision = undefined;
            await race();
          }
          return result;
        };
      }
      return method.bind(target);
    },
  });

  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  /** A tenant with a `service` blueprint (`ownerTeam`, boolean `locked`) and teams `platform` and `other`. */
  async function newTenant(): Promise<string> {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz: real }, tenantId);
    const system = {
      tenantId,
      actor: { type: 'system', id: 'recheck-seed' },
      principal: ADMIN,
    };
    for (const team of ['platform', 'other']) {
      await entities.create(system, { blueprint: '_team', identifier: team, title: team });
    }
    await blueprints.create(
      ctx(tenantId, 'admin-1', ADMIN),
      blueprintInput('service', {
        schema: {
          properties: { locked: { type: 'boolean', title: { en: 'Locked' } } },
          required: [],
        },
        statusSchema: { properties: {} },
        relations: { ownerTeam: { title: { en: 'Owner team' }, target: '_team' } },
      }),
    );
    return tenantId;
  }

  const admin = (tenantId: string) => ctx(tenantId, 'admin-2', ADMIN);

  const createService = (
    tenantId: string,
    identifier: string,
    options: { team?: string; actorId?: string } = {},
  ) =>
    entities.create(ctx(tenantId, options.actorId ?? 'admin-1', ADMIN), {
      blueprint: 'service',
      identifier,
      title: identifier,
      spec: {
        properties: {},
        relations: options.team === undefined ? {} : { ownerTeam: options.team },
      },
    });

  const adminUpsert = (
    tenantId: string,
    identifier: string,
    spec: { properties: Record<string, unknown>; relations: Record<string, unknown> },
  ) =>
    entities.upsert(admin(tenantId), {
      blueprint: 'service',
      identifier,
      title: `${identifier} by admin`,
      mode: 'merge',
      spec,
    } as never);

  const memberUpsert = (who: Record<string, unknown>, identifier: string) =>
    entities.upsert(who, {
      blueprint: 'service',
      identifier,
      title: `${identifier} by member`,
      mode: 'merge',
      spec: { properties: {}, relations: {} },
    });

  const getAsAdmin = (tenantId: string, identifier: string) =>
    entities.get(admin(tenantId), { blueprint: 'service', identifier });

  it('a concurrent ownership change between the authorization and the write fails closed', async () => {
    const tenantId = await newTenant();
    await createService(tenantId, 'payments', { team: 'platform' });
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    afterNextDecision = () =>
      adminUpsert(tenantId, 'payments', { properties: {}, relations: { ownerTeam: 'other' } }).then(
        () => undefined,
      );
    expect(await thrownCode(memberUpsert(member, 'payments'))).toBe('AUTH_FORBIDDEN');
    expect(afterNextDecision, 'the competing change ran').toBeUndefined();

    // The racing write landed nothing: only the admin's change is stored.
    const stored = await getAsAdmin(tenantId, 'payments');
    expect(stored.title).toBe('payments by admin');
    expect(stored.spec.relations['ownerTeam']).toBe('other');
    expect(stored.version).toBe(2);
  });

  it('a concurrent lock between the authorization and the write fails closed', async () => {
    const tenantId = await newTenant();
    await createService(tenantId, 'frozen-soon');
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: [] });

    afterNextDecision = () =>
      adminUpsert(tenantId, 'frozen-soon', {
        properties: { locked: true },
        relations: {},
      }).then(() => undefined);
    expect(await thrownCode(memberUpsert(member, 'frozen-soon'))).toBe('AUTH_FORBIDDEN');
    expect(afterNextDecision, 'the competing change ran').toBeUndefined();

    const stored = await getAsAdmin(tenantId, 'frozen-soon');
    expect(stored.title).toBe('frozen-soon by admin');
    expect(stored.spec.properties['locked']).toBe(true);
    expect(stored.version).toBe(2);
  });

  it('a concurrent replacement by another creator between the authorization and the delete fails closed', async () => {
    const tenantId = await newTenant();
    await createService(tenantId, 'mine', { actorId: 'member-creator' });
    const creator = ctx(tenantId, 'member-creator', { roles: ['member'], teams: [] });

    afterNextDecision = async () => {
      await entities.delete(admin(tenantId), { blueprint: 'service', identifier: 'mine' });
      await createService(tenantId, 'mine', { actorId: 'someone-else' });
    };
    expect(
      await thrownCode(entities.delete(creator, { blueprint: 'service', identifier: 'mine' })),
    ).toBe('AUTH_FORBIDDEN');
    expect(afterNextDecision, 'the competing change ran').toBeUndefined();

    // The replacement, created by another actor, is still there.
    const stored = await getAsAdmin(tenantId, 'mine');
    expect(stored.version).toBe(1);
  });

  it('an upsert authorized as create cannot land as an update of an entity created meanwhile', async () => {
    const tenantId = await newTenant();
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    // The entity does not exist when the member is authorized (as `create`, no
    // owner team); before the write, an admin creates it owned by `other`, a
    // team the member does not belong to.
    afterNextDecision = () =>
      createService(tenantId, 'racy', { team: 'other' }).then(() => undefined);
    expect(await thrownCode(memberUpsert(member, 'racy'))).toBe('AUTH_FORBIDDEN');
    expect(afterNextDecision, 'the competing change ran').toBeUndefined();

    const stored = await getAsAdmin(tenantId, 'racy');
    expect(stored.title).toBe('racy');
    expect(stored.spec.relations['ownerTeam']).toBe('other');
    expect(stored.version).toBe(1);
  });

  it('control: without a concurrent change the same upserts succeed', async () => {
    const tenantId = await newTenant();
    await createService(tenantId, 'payments', { team: 'platform' });
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    await memberUpsert(member, 'payments');
    expect((await getAsAdmin(tenantId, 'payments')).title).toBe('payments by member');

    await memberUpsert(ctx(tenantId, 'member-b', { roles: ['member'], teams: [] }), 'brand-new');
    expect((await getAsAdmin(tenantId, 'brand-new')).version).toBe(1);
  });
});
