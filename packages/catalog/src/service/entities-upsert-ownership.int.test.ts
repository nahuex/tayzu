/**
 * Integration test for task 13.6b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
 * (002 VCDM M15, the upsert part).
 *
 * "An entity with an owner team MUST be updatable only by a member of that team,
 * by a Moderator of its blueprint, or by an admin" (002 auth-and-rbac, Team
 * ownership). A `replace`-mode `upsert` that omits `ownerTeam` replaces the whole
 * spec, so it must not silently turn an owned entity into an unowned one, which
 * any member could then edit. The spec leaves open whether the write is refused
 * or the owner is kept, so the test accepts either and pins only the invariant:
 * the entity is still owned by its team afterwards.
 */
import { createCerbosClient } from '@tayzu/authz';
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

describe('a replace-mode upsert without ownerTeam cannot silently release ownership (task 13.6b, 002 VCDM M15)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const authz = createCerbosClient({ address: 'localhost:3593', tls: false });
  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });

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
    const system = {
      tenantId,
      actor: { type: 'system', id: 'ownership-seed' },
      principal: ADMIN,
    };
    await entities.create(system, {
      blueprint: '_team',
      identifier: 'platform',
      title: 'platform',
    });
    await blueprints.create(
      ctx(tenantId, 'admin-1', ADMIN),
      blueprintInput('service', {
        schema: { properties: {}, required: [] },
        statusSchema: { properties: {} },
        relations: { ownerTeam: { title: { en: 'Owner team' }, target: '_team' } },
      }),
    );
    await entities.create(ctx(tenantId, 'admin-1', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
      title: 'payments',
      spec: { properties: {}, relations: { ownerTeam: 'platform' } },
    });
    return tenantId;
  }

  const replaceUpsert = (
    who: Record<string, unknown>,
    relations: Record<string, unknown>,
    title: string,
  ) =>
    entities.upsert(who, {
      blueprint: 'service',
      identifier: 'payments',
      title,
      mode: 'replace',
      spec: { properties: {}, relations },
    } as never);

  it("an owning-team member's replace upsert without ownerTeam is refused or keeps the owner", async () => {
    const tenantId = await newTenant();
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    // Either outcome is allowed by the spec: a refusal or a write that keeps the owner.
    await replaceUpsert(member, {}, 'payments by member').then(
      () => undefined,
      () => undefined,
    );

    const stored = await entities.get(ctx(tenantId, 'admin-2', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stored.spec.relations['ownerTeam']).toBe('platform');

    // The entity is therefore still not updatable by a member outside the team.
    const outsider = ctx(tenantId, 'member-b', { roles: ['member'], teams: [] });
    const outsiderResult: unknown = await replaceUpsert(
      outsider,
      { ownerTeam: 'platform' },
      'payments by outsider',
    ).then(
      () => 'written',
      (error: unknown) => (error as { code?: unknown }).code,
    );
    expect(outsiderResult).toBe('AUTH_FORBIDDEN');
  });

  it('control: a replace upsert that names the same ownerTeam succeeds for the owning team member', async () => {
    const tenantId = await newTenant();
    const member = ctx(tenantId, 'member-a', { roles: ['member'], teams: ['platform'] });

    await replaceUpsert(member, { ownerTeam: 'platform' }, 'payments by member');

    const stored = await entities.get(ctx(tenantId, 'admin-2', ADMIN), {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stored.title).toBe('payments by member');
    expect(stored.spec.relations['ownerTeam']).toBe('platform');
  });
});
