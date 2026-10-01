/**
 * Integration tests for task 12.1 (openspec/changes/002-auth-and-rbac; spec
 * auth-and-rbac, "User and Team system blueprints"; catalog-core reserved
 * identifier rule, design D3).
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `./system-blueprints.js` exports `bootstrapSystemBlueprints({ pool, authz
 *   }, tenantId): Promise<void>`. It creates the `_user` and `_team`
 *   blueprints in the tenant through the real blueprint service as the
 *   `system` actor (`{ type: 'system', id: <any> }`). It is idempotent:
 *   running it twice for one tenant does not throw and does not duplicate.
 * - `_user` schema properties (at least): `status` (enum containing `Active`
 *   and `Disabled`), `portRole` (enum containing `admin` and `member`),
 *   `moderatedBlueprints`. `_team` needs no extra property. `identifier` and
 *   `title` are entity-level fields, so they are not schema properties.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { authz, ADMIN_PRINCIPAL } from './__fixtures__/authz-test-helpers.js';
import { createBlueprintService } from './blueprints.js';
import { createEntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

type ActorType = 'user' | 'agent' | 'integration' | 'system';

function ctx(tenantId: string, type: ActorType): Record<string, unknown> {
  return { tenantId, actor: { type, id: `${type}-1` }, principal: ADMIN_PRINCIPAL };
}

describe('User and Team system blueprints (task 12.1)', () => {
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

  describe('System blueprints are created by the system actor at tenant bootstrap', () => {
    it('creates `_user` and `_team` in the tenant, attributed to the system actor', async () => {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);

      const user = await blueprints.get(ctx(tenantId, 'user'), { identifier: '_user' });
      const team = await blueprints.get(ctx(tenantId, 'user'), { identifier: '_team' });
      expect(user.identifier).toBe('_user');
      expect(team.identifier).toBe('_team');
      expect(user.createdBy.type).toBe('system');
      expect(team.createdBy.type).toBe('system');
    });

    it('`_user` carries status (Active/Disabled), portRole (admin/member) and moderatedBlueprints', async () => {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);

      const user = await blueprints.get(ctx(tenantId, 'user'), { identifier: '_user' });
      const properties = user.schema.properties as Record<string, { enum?: readonly string[] }>;
      expect(properties['status']?.enum).toEqual(expect.arrayContaining(['Active', 'Disabled']));
      expect(properties['portRole']?.enum).toEqual(expect.arrayContaining(['admin', 'member']));
      expect(properties).toHaveProperty('moderatedBlueprints');
    });

    it('is tenant-scoped: another tenant has no `_user` until it is bootstrapped', async () => {
      const tenantA = randomTenantId();
      const tenantB = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantA);

      await expectCatalogErrorCode(
        blueprints.get(ctx(tenantB, 'user'), { identifier: '_user' }),
        'CATALOG_NOT_FOUND',
      );
    });

    it('is idempotent: bootstrapping the same tenant twice does not fail', async () => {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);

      const user = await blueprints.get(ctx(tenantId, 'user'), { identifier: '_user' });
      expect(user.identifier).toBe('_user');
    });

    it('the system actor can write a `_user` entity', async () => {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);

      const email = `${randomUUID()}@example.com`;
      const entity = await entities.upsert(ctx(tenantId, 'system'), {
        blueprint: '_user',
        identifier: email,
        title: 'Some User',
        mode: 'replace',
        spec: { properties: { status: 'Active', portRole: 'member' } },
      });
      expect(entity.identifier).toBe(email);
      expect(entity.createdBy.type).toBe('system');
    });
  });

  describe('Direct write to `_user` by a non-system actor is rejected', () => {
    it.each(['user', 'agent'] as const)(
      'Direct write to `_user` by a non-system actor is rejected: a %s actor upsert fails with CATALOG_RESERVED_IDENTIFIER',
      async (type) => {
        const tenantId = randomTenantId();
        await bootstrapSystemBlueprints({ pool, authz }, tenantId);

        await expectCatalogErrorCode(
          entities.upsert(ctx(tenantId, type), {
            blueprint: '_user',
            identifier: 'intruder@example.com',
            title: 'Intruder',
            mode: 'replace',
            spec: { properties: { status: 'Active', portRole: 'admin' } },
          }),
          'CATALOG_RESERVED_IDENTIFIER',
        );
      },
    );

    it('Direct write to `_user` by a non-system actor is rejected: nothing is written', async () => {
      const tenantId = randomTenantId();
      await bootstrapSystemBlueprints({ pool, authz }, tenantId);

      await expectCatalogErrorCode(
        entities.create(ctx(tenantId, 'user'), {
          blueprint: '_user',
          identifier: 'intruder@example.com',
          title: 'Intruder',
        }),
        'CATALOG_RESERVED_IDENTIFIER',
      );
      await expectCatalogErrorCode(
        entities.get(ctx(tenantId, 'system'), {
          blueprint: '_user',
          identifier: 'intruder@example.com',
        }),
        'CATALOG_NOT_FOUND',
      );
    });
  });
});
