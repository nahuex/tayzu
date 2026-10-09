/**
 * Integration tests for task 2.1 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (spec "User status has four states with forward-only transitions"; design D1).
 *
 * ## Production behavior assumed
 *
 * `bootstrapSystemBlueprints` (`./system-blueprints.js`) creates, for a new
 * tenant, a `_user` blueprint whose schema has:
 * - `accountKind`: enum `standard` | `service`, `default: 'standard'`;
 * - `status`: enum `Staged` | `Invited` | `Active` | `Disabled`, `default: 'Staged'`.
 * Defaults are applied on write only.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ADMIN_PRINCIPAL, authz } from './__fixtures__/authz-test-helpers.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

function systemCtx(tenantId: string): Record<string, unknown> {
  return { tenantId, actor: { type: 'system', id: 'system-1' }, principal: ADMIN_PRINCIPAL };
}

describe('`_user` blueprint of a new tenant (task 2.1)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const blueprints = createBlueprintService({ pool, authz });
  const entities = createEntityService({ pool, authz });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  });

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  type Prop = { enum?: readonly string[]; default?: unknown };

  it("a new tenant's `_user` blueprint carries accountKind (standard | service, default standard)", async () => {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz }, tenantId);

    const user = await blueprints.get(systemCtx(tenantId), { identifier: '_user' });
    const properties = user.schema.properties as Record<string, Prop>;
    expect(properties['accountKind']?.enum).toEqual(['standard', 'service']);
    expect(properties['accountKind']?.default).toBe('standard');
  });

  it("a new tenant's `_user` blueprint carries the four-value status enum, default Staged", async () => {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz }, tenantId);

    const user = await blueprints.get(systemCtx(tenantId), { identifier: '_user' });
    const properties = user.schema.properties as Record<string, Prop>;
    expect([...(properties['status']?.enum ?? [])].sort()).toEqual(
      ['Active', 'Disabled', 'Invited', 'Staged'].sort(),
    );
    expect(properties['status']?.default).toBe('Staged');
  });

  it('New entity without a status starts staged', async () => {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz }, tenantId);

    const email = `${randomUUID()}@example.com`;
    const created = await entities.create(systemCtx(tenantId), {
      blueprint: '_user',
      identifier: email,
      title: 'Some User',
      spec: { properties: { portRole: 'member' } },
    });
    expect(created.spec.properties['status']).toBe('Staged');

    const read = await entities.get(systemCtx(tenantId), { blueprint: '_user', identifier: email });
    expect(read.spec.properties['status']).toBe('Staged');
    expect(read.spec.properties['accountKind']).toBe('standard');
  });

  it('accepts every one of the four status values on write', async () => {
    const tenantId = randomTenantId();
    await bootstrapSystemBlueprints({ pool, authz }, tenantId);

    for (const status of ['Staged', 'Invited', 'Active', 'Disabled']) {
      const email = `${randomUUID()}@example.com`;
      const entity = await entities.create(systemCtx(tenantId), {
        blueprint: '_user',
        identifier: email,
        title: 'Some User',
        spec: { properties: { status } },
      });
      expect(entity.spec.properties['status']).toBe(status);
    }
  });
});
