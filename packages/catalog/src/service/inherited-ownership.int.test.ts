/**
 * Integration test for task 13.6c of openspec/changes/043-identity-lifecycle-and-org-admin
 * (002 VCDM M15; Resolved decisions Q37 and Q137).
 *
 * `Inherited` ownership is unreachable in production today (`readInherited`
 * returns nothing). Until a chain can be declared, an entity whose resolved
 * ownership is `Inherited` is not updatable by a non-admin: the attributes sent to
 * Cerbos carry `locked: true`, so the deny of task 8.6 applies. The state is built
 * through the optional `ownership` option of `createEntityService`
 * (`{ config: OwnershipConfig, readInherited }`), against a real Cerbos.
 */
import { createCerbosClient, type OwnershipConfig } from '@tayzu/authz';
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

type Principal = { roles: string[]; teams?: string[] };

function ctx(tenantId: string, actorId: string, principal: Principal): Record<string, unknown> {
  return { tenantId, actor: { type: 'user', id: actorId }, principal };
}

const ADMIN: Principal = { roles: ['admin'] };

const OWNERSHIP_CONFIG: OwnershipConfig = {
  directTeamRelation: 'ownerTeam',
  inheritedChain: ['parent'],
};

describe('an entity with Inherited ownership is not updatable by a non-admin (task 13.6c, Q37, Q137)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const authz = createCerbosClient({ address: 'localhost:3593', tls: false });
  const blueprints = createBlueprintService({ pool, authz });
  const defaultEntities = createEntityService({ pool, authz });
  const inheritedEntities = createEntityService({
    pool,
    authz,
    ownership: { config: OWNERSHIP_CONFIG, readInherited: () => 'platform' },
  });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  async function newTenant(): Promise<string> {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz }, tenantId);
    await defaultEntities.create(
      { tenantId, actor: { type: 'system', id: 'ownership-seed' }, principal: ADMIN },
      { blueprint: '_team', identifier: 'platform', title: 'platform' },
    );
    await blueprints.create(
      ctx(tenantId, 'admin-1', ADMIN),
      blueprintInput('service', {
        schema: { properties: {}, required: [] },
        statusSchema: { properties: {} },
        relations: { ownerTeam: { title: { en: 'Owner team' }, target: '_team' } },
      }),
    );
    return tenantId;
  }

  async function createInherited(tenantId: string): Promise<void> {
    await inheritedEntities.create(ctx(tenantId, 'admin-1', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
      title: 'payments',
      spec: { properties: {}, relations: {} },
    });
  }

  const update = (
    service: typeof inheritedEntities,
    who: Record<string, unknown>,
    title: string,
    relations: Record<string, unknown> = {},
  ) =>
    service.upsert(who, {
      blueprint: 'service',
      identifier: 'payments',
      title,
      mode: 'replace',
      spec: { properties: {}, relations },
    } as never);

  const outcome = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => 'written',
      (error: unknown) => (error as { code?: unknown }).code,
    );

  it("a member of the inherited owning team's update is denied with AUTH_FORBIDDEN", async () => {
    const tenantId = await newTenant();
    await createInherited(tenantId);
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    expect(await outcome(update(inheritedEntities, member, 'by team member'))).toBe(
      'AUTH_FORBIDDEN',
    );
    const stored = await inheritedEntities.get(ctx(tenantId, 'admin-2', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stored.title).toBe('payments');
  });

  it("a member with no team's update is denied with AUTH_FORBIDDEN", async () => {
    const tenantId = await newTenant();
    await createInherited(tenantId);
    const member = ctx(tenantId, 'member-b', { roles: ['member'], teams: [] });

    expect(await outcome(update(inheritedEntities, member, 'by teamless member'))).toBe(
      'AUTH_FORBIDDEN',
    );
  });

  it("an admin's update of an Inherited-owned entity is allowed", async () => {
    const tenantId = await newTenant();
    await createInherited(tenantId);

    await update(inheritedEntities, ctx(tenantId, 'admin-2', ADMIN), 'by admin');

    const stored = await inheritedEntities.get(ctx(tenantId, 'admin-2', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stored.title).toBe('by admin');
  });

  it('control: a Direct-owned entity is still updatable by its team member', async () => {
    const tenantId = await newTenant();
    await inheritedEntities.create(ctx(tenantId, 'admin-1', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
      title: 'payments',
      spec: { properties: {}, relations: { ownerTeam: 'platform' } },
    });
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    await update(inheritedEntities, member, 'by team member', { ownerTeam: 'platform' });

    const stored = await inheritedEntities.get(ctx(tenantId, 'admin-2', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stored.title).toBe('by team member');
  });
});
