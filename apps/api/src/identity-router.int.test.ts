/**
 * Task 4.3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "A user created by an admin is active"; design D2; Resolved decisions Q76
 * and Q117).
 *
 * Task 4.3: "`identity.users.create` performs no `_user` write of its own: the
 * hook of 4.2 writes it. The operation hands the acting admin to the hook
 * through an `AsyncLocalStorage` that it runs around its in-process `auth.api`
 * call, so the change event carries `onBehalfOf`, and the hook's write emits
 * `catalog.audit.user_status_changed` with the admin as `tayzu.actor.id`. The
 * `userSync` option of `createIdentityRouter` is removed."
 *
 * Scenario (verbatim from the spec):
 * - "A user created by an admin is active": WHEN an admin creates a user
 *   through `identity.users.create`, THEN the user's status is `Active`,
 *   written through the state machine.
 *
 * ## Harness
 *
 * `auth` is built with the real adapter of 4.1 (`createUserSyncAdapter` over
 * `createUserSync`) as its `userSync`, exactly as `createApp` does, so the
 * membership hook of 4.2 is the only writer. The router is built with
 * `{ auth, authz }` and no `userSync`. Each test uses a fresh organization (the
 * tenant) and a fresh admin caller id. The `_user` writes are counted from
 * `catalog_change_event`, the status event is read from the in-memory log
 * exporter.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`./identity-router.js`) no longer declares a
 *   `userSync` option and makes no `_user` write of its own.
 * - `apps/api/src/identity/identity-context.ts` (design D2) holds the
 *   `AsyncLocalStorage` store; the router runs its `auth.api` calls inside it
 *   with the acting admin, and `createUserSyncAdapter` reads it to set the
 *   write's `onBehalfOf` (`{ type: 'user', id }`) and `principal`
 *   (`tayzu.actor.id`). This test imports none of that: it asserts the effects.
 *
 * ## Why this fails right now
 *
 * The router still takes a `userSync` and upserts a second time when one is
 * given; the hook's write carries no `onBehalfOf` and the status event names
 * no `tayzu.actor.id` (assertion failures).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance, type UserSyncPort } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

const EVENT_NAME = 'catalog.audit.user_status_changed';

describe('identity.users.create writes the _user through the membership hook only (task 4.3)', () => {
  let harness: TelemetryTestHarness;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    client = createRouterClient(createIdentityRouter({ auth, authz: cerbos }), {
      context: (raw: Record<string, unknown>) => raw,
    });
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Identity Router Org', slug: `identity-router-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function context(tenantId: string, adminId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: adminId },
      principal: { roles: ['admin'] },
    };
  }

  it('A user created by an admin is active: exactly one _user write, status Active, onBehalfOf the admin, one status event created_active naming the admin', async () => {
    const tenantId = await freshTenantId();
    const adminId = `admin-${randomUUID()}`;
    const email = `created-${randomUUID()}@example.test`;

    // WHEN an admin creates a user through `identity.users.create`.
    const created = await client.identity.users.create(
      { email, name: 'Created By Admin', role: 'member' },
      { context: context(tenantId, adminId) },
    );

    // THEN the user's status is `Active`...
    const row = await userSync.getUser({ tenantId, email });
    expect(row, 'a _user entity exists for the created user').not.toBeNull();
    expect(row?.status).toBe('Active');

    // ...written once, with the admin as `onBehalfOf` of the change event.
    const events = await authPool.query<{
      actor_type: string;
      on_behalf_of_type: string | null;
      on_behalf_of_id: string | null;
    }>(
      `select actor_type, on_behalf_of_type, on_behalf_of_id from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
       order by seq`,
      [tenantId, email],
    );
    expect(events.rows, 'exactly one _user write').toHaveLength(1);
    expect(events.rows[0]?.actor_type).toBe('system');
    expect(events.rows[0]?.on_behalf_of_type).toBe('user');
    expect(events.rows[0]?.on_behalf_of_id).toBe(adminId);

    // ...and one status event, `created_active`, with the admin as the actor.
    await harness.forceFlush();
    const statusEvents = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === EVENT_NAME &&
        record.attributes['tayzu.tenant.id'] === tenantId &&
        record.attributes['tayzu.identity.user.id'] === created.userId,
    );
    expect(statusEvents).toHaveLength(1);
    const attributes = statusEvents[0]?.attributes;
    expect(attributes?.['tayzu.identity.user.status.event']).toBe('created_active');
    expect(attributes?.['tayzu.identity.user.status.to']).toBe('Active');
    expect(attributes?.['tayzu.actor.id']).toBe(adminId);
    expect(JSON.stringify(attributes)).not.toContain(email);
  }, 60_000);

  it('createIdentityRouter no longer accepts a userSync: a stub handed to it is never called', async () => {
    const tenantId = await freshTenantId();
    const email = `no-user-sync-${randomUUID()}@example.test`;
    const calls: unknown[] = [];
    const stub: UserSyncPort = {
      upsertUser: (input) => {
        calls.push(input);
        return Promise.resolve();
      },
    };

    // @ts-expect-error -- task 4.3 (Q76): the `userSync` option is removed.
    const router = createIdentityRouter({ auth, authz: cerbos, userSync: stub });
    const stubbed = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    });
    await stubbed.identity.users.create(
      { email, name: 'No Second Write', role: 'member' },
      { context: context(tenantId, `admin-${randomUUID()}`) },
    );

    expect(calls, 'the router writes nothing through a userSync').toEqual([]);
  }, 60_000);
});
