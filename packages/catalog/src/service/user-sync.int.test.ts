/**
 * Integration tests for task 4.1 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (spec "User status has four states with forward-only transitions"; design D2;
 * Resolved decision Q10).
 *
 * No test of `createUserSync` existed in `@tayzu/catalog` before this file.
 *
 * ## Production behavior assumed (design D2, task 4.1)
 *
 * - `UserSyncInput.status` takes the four values of D1: `'Staged' | 'Invited' |
 *   'Active' | 'Disabled'` (today `'Active' | 'Disabled'`).
 * - `UserSyncInput` gains an optional `onBehalfOf` (a principal, `{ type, id }`).
 *   The write is still made by the `system` actor, and the change event records
 *   `onBehalfOf` beside it.
 * - `UserSyncInput` gains an optional `expectedVersion`. For an existing row it
 *   is passed to `entities.upsert`; a stale one rejects `CATALOG_VERSION_CONFLICT`.
 * - `UserSync` gains a read path: `getUser({ tenantId, email })`, which returns
 *   `{ status, version }` of the tenant's `_user` entity addressed by that
 *   email, or `null` when the entity does not exist. It reads through
 *   `entities.get`.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authz } from './__fixtures__/authz-test-helpers.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
} from './__fixtures__/blueprint-test-helpers.js';
import { createEntityService } from './entities.js';
import { createUserSync } from './user-sync.js';

type Status = 'Staged' | 'Invited' | 'Active' | 'Disabled';

describe('createUserSync with the four-value status (task 4.1; design D2)', () => {
  const url = databaseUrl();
  const pool = connect(url).$client;
  const ownerDb = connectAsOwner(url);
  const userSync = createUserSync({ pool, authz });
  const entities = createEntityService({ pool, authz });

  beforeAll(async () => {
    await runMigrations(ownerDb.$client);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(ownerDb.$client);
  });

  function fresh(): { tenantId: string; email: string } {
    return { tenantId: randomTenantId(), email: `u-${randomUUID()}@example.test` };
  }

  async function readStatus(tenantId: string, email: string): Promise<unknown> {
    const entity = await entities.get(
      {
        tenantId,
        actor: { type: 'system', id: 'user-sync-test' },
        principal: { roles: ['admin'] },
      },
      { blueprint: '_user', identifier: email },
    );
    return entity.spec.properties['status'];
  }

  it.each<Status>(['Staged', 'Invited', 'Active', 'Disabled'])(
    'writes the status %s for a new `_user` entity',
    async (status) => {
      const { tenantId, email } = fresh();

      await userSync.upsertUser({ tenantId, email, name: 'Some Person', status });

      expect(await readStatus(tenantId, email)).toBe(status);
    },
  );

  it('the read path returns null for a `_user` entity that does not exist', async () => {
    const { tenantId, email } = fresh();

    expect(await userSync.getUser({ tenantId, email })).toBeNull();
  });

  it('the read path returns the stored status and the entity version', async () => {
    const { tenantId, email } = fresh();
    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Invited' });

    const first = await userSync.getUser({ tenantId, email });
    expect(first).toEqual({ status: 'Invited', version: expect.any(Number) as number });

    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Active' });
    const second = await userSync.getUser({ tenantId, email });
    expect(second?.status).toBe('Active');
    expect(second?.version).toBeGreaterThan(first?.version ?? Number.MAX_SAFE_INTEGER);
  });

  it('the read path of another tenant looks exactly like a missing row', async () => {
    const owner = fresh();
    await userSync.upsertUser({
      tenantId: owner.tenantId,
      email: owner.email,
      name: 'Some Person',
      status: 'Active',
    });

    expect(await userSync.getUser({ tenantId: randomTenantId(), email: owner.email })).toBeNull();
  });

  it('a write with the current expectedVersion succeeds', async () => {
    const { tenantId, email } = fresh();
    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Invited' });
    const read = await userSync.getUser({ tenantId, email });
    if (read === null) throw new Error('the row was just written');

    await userSync.upsertUser({
      tenantId,
      email,
      name: 'Some Person',
      status: 'Active',
      expectedVersion: read.version,
    });

    expect(await readStatus(tenantId, email)).toBe('Active');
  });

  it('a write with a stale expectedVersion is rejected with CATALOG_VERSION_CONFLICT and changes nothing', async () => {
    const { tenantId, email } = fresh();
    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Invited' });
    const read = await userSync.getUser({ tenantId, email });
    if (read === null) throw new Error('the row was just written');
    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Disabled' });

    await expectCatalogErrorCode(
      userSync.upsertUser({
        tenantId,
        email,
        name: 'Some Person',
        status: 'Active',
        expectedVersion: read.version,
      }),
      'CATALOG_VERSION_CONFLICT',
    );

    expect(await readStatus(tenantId, email)).toBe('Disabled');
  });

  it('onBehalfOf is recorded on the change event, beside the system actor that makes the write', async () => {
    const { tenantId, email } = fresh();
    const adminId = `admin-${randomUUID()}`;
    await userSync.upsertUser({ tenantId, email, name: 'Some Person', status: 'Active' });

    await userSync.upsertUser({
      tenantId,
      email,
      name: 'Some Person',
      status: 'Disabled',
      onBehalfOf: { type: 'user', id: adminId },
    });

    const events = await ownerDb.$client.query<{
      actor_type: string;
      on_behalf_of_type: string | null;
      on_behalf_of_id: string | null;
    }>(
      `select actor_type, on_behalf_of_type, on_behalf_of_id
       from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
       order by seq`,
      [tenantId, email],
    );
    const last = events.rows.at(-1);
    expect(last?.actor_type).toBe('system');
    expect(last?.on_behalf_of_type).toBe('user');
    expect(last?.on_behalf_of_id).toBe(adminId);
    const first = events.rows[0];
    expect(first?.on_behalf_of_id, 'a write without onBehalfOf records none').toBeNull();
  });
});
