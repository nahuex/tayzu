/**
 * `043` task 4.6b: the bootstrap CLI moves to `apps/api/scripts/bootstrap-admin.ts`
 * and builds Better Auth the way `createApp` does (design D2 and D9; Resolved
 * decisions Q51, Q116 and Q117).
 *
 * Scenario of `specs/identity-lifecycle-and-org-admin/spec.md`, requirement
 * "Security-relevant events are logged":
 *
 * - "The acceptance and the bootstrap name who acted" (the bootstrap half: its
 *   audit event names the operator's opaque id, and it refuses to run without an
 *   operator id).
 *
 * Also the Verify clause of 4.6b itself: the `_user` is written once through the
 * state machine, the role assertion refuses an undeclared role before any write,
 * and `packages/auth` no longer contains the script or its package script.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/bootstrap-admin.ts (today a scaffold whose `main()` takes no options)
 * export interface BootstrapAdminCliOptions {
 *   // Defaults to process.env. Read through loadScriptConfig('bootstrap-admin', env)
 *   // (DATABASE_URL, AUTH_DATABASE_URL, BETTER_AUTH_SECRET, CERBOS_ADDRESS,
 *   // TAYZU_OPERATOR_ID), plus ALLOWED_ORIGINS for the trusted origins and the
 *   // BOOTSTRAP_ORGANIZATION_NAME, BOOTSTRAP_ORGANIZATION_SLUG, BOOTSTRAP_ADMIN_NAME
 *   // and BOOTSTRAP_ADMIN_EMAIL of the organization, all from this same `env`.
 *   readonly env?: Readonly<Record<string, string | undefined>>;
 *   // Pools the host already built (the script then does not end them), as in
 *   // reconcile-users.ts: appPool runs as tayzu_app, authPool as tayzu_auth, and both
 *   // go to runScript as role checks.
 *   readonly appPool?: Pool;
 *   readonly authPool?: Pool;
 * }
 * export function main(options?: BootstrapAdminCliOptions): Promise<void>;
 * ```
 *
 * `main()` builds `createAuth({ db: <authPool>, userSync: createUserSyncAdapter(...), ... })`,
 * runs `bootstrapAdmin(auth, params, { operatorId })`, and hands the operator to the
 * adapter as the principal `{ kind: 'operator', id }` (and `onBehalfOf`
 * `{ type: 'user', id }`), so the membership hook's single `_user` write carries it.
 *
 * A run reads no other tenant's data, so it uses the shared test database with a
 * fresh random organization slug and admin email per test.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../scripts/bootstrap-admin.js';
import { getOwnerPool } from '../../../packages/db/src/harness.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const CERBOS_ADDRESS = 'localhost:3593';
const OPERATOR_ID = 'gh:424242';
const STATUS_EVENT = 'catalog.audit.user_status_changed';
const CREATED_EVENT = 'catalog.audit.user_created';

interface ChangeEventRow extends QueryResultRow {
  action: string;
  actor_type: string;
  on_behalf_of_type: string | null;
  on_behalf_of_id: string | null;
}

/** A pool whose every connection runs as `role` (a fixed literal, never input). */
function poolAs(role: 'tayzu_app' | 'tayzu_auth'): Pool {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const statement = role === 'tayzu_app' ? 'SET ROLE tayzu_app' : 'SET ROLE tayzu_auth';
  pool.on('connect', (client) => {
    void client.query(statement).catch(() => undefined);
  });
  pool.on('error', () => undefined);
  return pool;
}

describe('bootstrap-admin CLI (task 4.6b)', () => {
  let harness: TelemetryTestHarness;
  let ownerPool: Pool;
  let appPool: Pool;
  let authPool: Pool;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    ownerPool = await getOwnerPool();
    appPool = poolAs('tayzu_app');
    authPool = poolAs('tayzu_auth');
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await appPool.end();
    await authPool.end();
  });

  const fresh = () => ({
    slug: `bootstrap-cli-${randomUUID()}`,
    email: `bootstrap-cli-${randomUUID()}@example.test`,
  });

  const env = (
    organization: { slug: string; email: string },
    operatorId: string | null = OPERATOR_ID,
  ): Record<string, string> => ({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
    BETTER_AUTH_SECRET: TEST_SECRET,
    CERBOS_ADDRESS,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    BOOTSTRAP_ORGANIZATION_NAME: 'Bootstrap CLI Org',
    BOOTSTRAP_ORGANIZATION_SLUG: organization.slug,
    BOOTSTRAP_ADMIN_NAME: 'Bootstrap CLI Admin',
    BOOTSTRAP_ADMIN_EMAIL: organization.email,
    ...(operatorId === null ? {} : { TAYZU_OPERATOR_ID: operatorId }),
  });

  function silenceOutput(): void {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }

  async function organizationId(slug: string): Promise<string | undefined> {
    const result = await ownerPool.query<{ id: string }>(
      'select id from auth.organization where slug = $1',
      [slug],
    );
    return result.rows[0]?.id;
  }

  async function userRows(email: string): Promise<{ id: string }[]> {
    const result = await ownerPool.query<{ id: string }>(
      'select id from auth."user" where email = $1',
      [email],
    );
    return result.rows;
  }

  async function changeEvents(tenantId: string, email: string): Promise<ChangeEventRow[]> {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<ChangeEventRow>(
        `select action, actor_type, on_behalf_of_type, on_behalf_of_id
           from catalog_change_event
          where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
          order by seq`,
        [tenantId, email],
      );
      await client.query('commit');
      return result.rows;
    } finally {
      client.release();
    }
  }

  async function logRecords(eventName: string, tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === eventName && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  it('The acceptance and the bootstrap name who acted: the bootstrap _user exists, is Active through the state machine and was written once, for the operator', async () => {
    silenceOutput();
    const organization = fresh();

    await main({ env: env(organization), appPool, authPool });

    const tenantId = await organizationId(organization.slug);
    expect(tenantId).toBeDefined();
    if (tenantId === undefined) throw new Error('organization missing');

    const authz = createCerbosClient({ address: CERBOS_ADDRESS, tls: false });
    const row = await createUserSync({ pool: appPool, authz }).getUser({
      tenantId,
      email: organization.email,
    });
    expect(row?.status).toBe('Active');

    // Written once: the membership hook is the single writer, as the operator.
    const events = await changeEvents(tenantId, organization.email);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'created',
      on_behalf_of_type: 'user',
      on_behalf_of_id: OPERATOR_ID,
    });

    const statusChanges = await logRecords(STATUS_EVENT, tenantId);
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]?.attributes).toMatchObject({
      'tayzu.identity.operator.id': OPERATOR_ID,
      'tayzu.identity.user.status.event': 'created_active',
      'tayzu.identity.user.status.to': 'Active',
    });
    expect(statusChanges[0]?.attributes).not.toHaveProperty('tayzu.actor.id');
    expect(JSON.stringify(statusChanges[0]?.attributes)).not.toContain(organization.email);
  }, 120_000);

  it('The acceptance and the bootstrap name who acted: user_created (source bootstrap) carries the operator id as tayzu.identity.operator.id and no tayzu.actor.id', async () => {
    silenceOutput();
    const organization = fresh();

    await main({ env: env(organization), appPool, authPool });

    const tenantId = await organizationId(organization.slug);
    if (tenantId === undefined) throw new Error('organization missing');
    const created = await logRecords(CREATED_EVENT, tenantId);
    expect(created).toHaveLength(1);
    expect(created[0]?.attributes).toMatchObject({
      'tayzu.identity.user.source': 'bootstrap',
      'tayzu.identity.operator.id': OPERATOR_ID,
    });
    expect(created[0]?.attributes).not.toHaveProperty('tayzu.actor.id');
  }, 120_000);

  it('The bootstrap refuses to run without an operator id: nothing is written', async () => {
    silenceOutput();
    const organization = fresh();

    await expect(main({ env: env(organization, null), appPool, authPool })).rejects.toThrow(
      /TAYZU_OPERATOR_ID/,
    );

    expect(await organizationId(organization.slug)).toBeUndefined();
    expect(await userRows(organization.email)).toHaveLength(0);
  }, 120_000);

  it('The bootstrap refuses an email as the operator id: nothing is written', async () => {
    silenceOutput();
    const organization = fresh();

    await expect(
      main({ env: env(organization, 'operator@example.test'), appPool, authPool }),
    ).rejects.toThrow(/TAYZU_OPERATOR_ID/);

    expect(await organizationId(organization.slug)).toBeUndefined();
    expect(await userRows(organization.email)).toHaveLength(0);
  }, 120_000);

  it('The bootstrap refuses a pool that connects as a role it did not declare: nothing is written', async () => {
    silenceOutput();
    const organization = fresh();

    // The harness owner is neither tayzu_app nor tayzu_auth.
    await expect(main({ env: env(organization), appPool, authPool: ownerPool })).rejects.toThrow(
      /declared roles/,
    );
    await expect(main({ env: env(organization), appPool: ownerPool, authPool })).rejects.toThrow(
      /declared roles/,
    );

    expect(await organizationId(organization.slug)).toBeUndefined();
    expect(await userRows(organization.email)).toHaveLength(0);
  }, 120_000);

  it('The CLI lives in apps/api: packages/auth contains neither the script nor its package script', () => {
    const authPackage = fileURLToPath(new URL('../../../packages/auth/', import.meta.url));
    const apiPackage = fileURLToPath(new URL('../', import.meta.url));

    expect(existsSync(`${authPackage}scripts/bootstrap-admin.ts`)).toBe(false);
    const authScripts = (
      JSON.parse(readFileSync(`${authPackage}package.json`, 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    expect(authScripts ?? {}).not.toHaveProperty('bootstrap:admin');

    expect(existsSync(`${apiPackage}scripts/bootstrap-admin.ts`)).toBe(true);
    const apiScripts = (
      JSON.parse(readFileSync(`${apiPackage}package.json`, 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    expect(apiScripts?.['bootstrap:admin']).toBe('tsx scripts/bootstrap-admin.ts');
  });
});
