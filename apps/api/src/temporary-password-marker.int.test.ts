/**
 * `043` task 14.19: `identity.users.create` and the bootstrap CLI write the
 * temporary-password marker that 13.5, 13.5c and 13.5d honor (Resolved decisions
 * Q36, Q138, Q139 and Q142; `002` VCDM M11).
 *
 * Scenario of `specs/identity-lifecycle-and-org-admin/spec.md`, quoted:
 *
 * #### Scenario: A temporary password grants only a password change
 * - GIVEN a user created with a temporary password
 * - WHEN they sign in with it
 * - THEN the session reaches only the change-password route until they set a
 *   policy-compliant password, and the temporary password expires if not changed
 *
 * The task's Verify clause: a user created through `identity.users.create` with no
 * hand-seeded marker, signing in with the returned password, reaching only the routes
 * of 13.5 and holding a marker whose expiry is 48 hours after the creation; a failing
 * marker write leaving no membership; and the same for an admin created by the
 * bootstrap CLI's `main()`.
 *
 * ## The marker (13.5e)
 *
 * A row of `auth.verification` with identifier `temp-password:<userId>`, `expiresAt`
 * the far-future sentinel `9999-12-31T23:59:59Z` and `value` the real expiry as an
 * ISO-8601 timestamp, 48 hours after the creation.
 *
 * ## Production symbols expected
 *
 * No new symbol: `identity.users.create` (`./identity-router.js`) and `main()`
 * (`../scripts/bootstrap-admin.js`) write the marker right after `createUser` and
 * before `addMember` / `createOrganization`, so the user never joins a tenant without
 * it. The marker is written through whatever seam they choose; the failure is injected
 * below with a database trigger that refuses the marker insert for one test email, so
 * the test does not depend on how the row is written.
 *
 * Harness: `auth.handler(new Request(...))` with a fresh random `x-forwarded-for` per
 * request; a fresh random tenant, user and slug per test. The triggers only match a
 * random email, so concurrently running test files are not affected.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createContextResolver, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { getOwnerPool } from '../../../packages/db/src/harness.js';
import { main } from '../scripts/bootstrap-admin.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const CERBOS_ADDRESS = 'localhost:3593';
const OPERATOR_ID = 'gh:141919';
const SENTINEL = '9999-12-31T23:59:59.000Z';
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const TOLERANCE_MS = 5 * 60 * 1000;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface MarkerRow {
  readonly value: string;
  readonly expires_at: Date;
}

describe('the creation paths write the temporary-password marker (task 14.19, Q36, Q142)', () => {
  let authPool: Pool;
  let ownerPool: Pool;
  let auth: AuthInstance;
  let resolveContext: (headers: Headers) => Promise<unknown>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  let appPool: Pool;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    appPool = pools.appPool;
    ownerPool = await getOwnerPool();
    await runMigrations(authPool);
    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
    resolveContext = createContextResolver({ auth, revocationPool: appPool });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: createCerbosClient({ address: CERBOS_ADDRESS, tls: false }),
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Marker Org', slug: `marker-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function adminContext(tenantId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles: ['admin'] },
    };
  }

  async function markerOf(userId: string): Promise<MarkerRow[]> {
    const result = await ownerPool.query<MarkerRow>(
      'select value, expires_at from auth.verification where identifier = $1',
      [`temp-password:${userId}`],
    );
    return result.rows;
  }

  async function userIdOf(email: string): Promise<string | undefined> {
    const result = await ownerPool.query<{ id: string }>(
      'select id from auth."user" where email = $1',
      [email],
    );
    return result.rows[0]?.id;
  }

  async function membershipCount(email: string): Promise<number> {
    const result = await ownerPool.query<{ n: string }>(
      `select count(*)::text as n from auth.member m
         join auth."user" u on u.id = m.user_id where u.email = $1`,
      [email],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** The marker of 13.5e with its real expiry 48 hours after a creation inside [before, after]. */
  async function expectMarker(userId: string, before: number, after: number): Promise<void> {
    const rows = await markerOf(userId);
    expect(rows, 'exactly one marker row').toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('marker missing');
    expect(row.expires_at.toISOString(), 'far-future sentinel in expiresAt').toBe(SENTINEL);
    const expiry = new Date(row.value);
    expect(expiry.toISOString(), 'value is an ISO-8601 timestamp').toBe(row.value);
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + FORTY_EIGHT_HOURS_MS - TOLERANCE_MS);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + FORTY_EIGHT_HOURS_MS + TOLERANCE_MS);
  }

  function authRequest(
    path: string,
    cookie: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}${path}`, {
        method,
        headers: {
          cookie,
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  /** Signs in with the temporary password and checks the session reaches only the routes of 13.5. */
  async function expectRestrictedSession(
    userId: string,
    email: string,
    password: string,
  ): Promise<void> {
    const signedIn = await signInAdminUser(auth, { email, password, ip: randomIp() });
    expect(signedIn.userId).toBe(userId);
    const { cookie } = signedIn;

    const session = await authRequest('/get-session', cookie, 'GET');
    expect(session.status, '/get-session stays reachable').toBe(200);

    const listAccounts = await authRequest('/list-accounts', cookie, 'GET');
    expect(listAccounts.status, '/list-accounts is refused').toBeGreaterThanOrEqual(400);
    expect(listAccounts.status).toBeLessThan(500);

    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });

    const changed = await authRequest('/change-password', cookie, 'POST', {
      currentPassword: password,
      newPassword: `Changed-${randomUUID()}-Aa1!`,
    });
    expect(changed.status, 'change-password is reachable').toBe(200);
    expect(await markerOf(userId), 'changing the password clears the marker').toHaveLength(0);
  }

  /**
   * Refuses, in the database, any insert of a `temp-password:` marker for the user with
   * `email`. Matches by the email, which no other test uses.
   */
  async function refuseMarkerWriteFor(email: string): Promise<void> {
    if (!/^[a-z0-9@.+-]+$/.test(email)) throw new Error('unexpected test email');
    const name = `refuse_marker_${randomUUID().replaceAll('-', '_')}`;
    await ownerPool.query(`
      create function auth.${name}() returns trigger language plpgsql as $body$
      begin
        if new.identifier like 'temp-password:%' and exists (
          select 1 from auth."user" u
           where 'temp-password:' || u.id = new.identifier and u.email = '${email}'
        ) then
          raise exception 'marker write refused';
        end if;
        return new;
      end
      $body$`);
    await ownerPool.query(
      `create trigger ${name} before insert on auth.verification
         for each row execute function auth.${name}()`,
    );
    cleanups.push(async () => {
      await ownerPool.query(`drop trigger if exists ${name} on auth.verification`);
      await ownerPool.query(`drop function if exists auth.${name}()`);
    });
  }

  it('A user created through identity.users.create holds the marker: it signs in with the returned password, reaches only the routes of 13.5, and the expiry is 48 hours after the creation', async () => {
    const tenantId = await freshTenantId();
    const email = `marker-create-${randomUUID()}@example.test`;

    const before = Date.now();
    const created = await client.identity.users.create(
      { body: { email, name: 'Marker Create', role: 'member' } },
      { context: adminContext(tenantId) },
    );
    const after = Date.now();

    await expectMarker(created.userId, before, after);
    await expectRestrictedSession(created.userId, email, created.temporaryPassword);
  }, 120_000);

  it('A failing marker write in identity.users.create fails the operation and leaves no membership', async () => {
    const tenantId = await freshTenantId();
    const email = `marker-fail-${randomUUID()}@example.test`;
    await refuseMarkerWriteFor(email);

    const thrown: unknown = await client.identity.users
      .create(
        { body: { email, name: 'Marker Fail', role: 'member' } },
        { context: adminContext(tenantId) },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown, 'the operation fails').toBeDefined();
    expect(await membershipCount(email), 'the user never joined the tenant').toBe(0);
    const userId = await userIdOf(email);
    if (userId !== undefined) expect(await markerOf(userId)).toHaveLength(0);
  }, 120_000);

  describe('the bootstrap CLI', () => {
    function poolAs(role: 'tayzu_app' | 'tayzu_auth'): Pool {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      pool.on('connect', (connection) => {
        void connection.query(`SET ROLE ${role}`).catch(() => undefined);
      });
      pool.on('error', () => undefined);
      return pool;
    }

    let cliAppPool: Pool;
    let cliAuthPool: Pool;

    beforeAll(() => {
      cliAppPool = poolAs('tayzu_app');
      cliAuthPool = poolAs('tayzu_auth');
    });

    afterAll(async () => {
      await cliAppPool.end();
      await cliAuthPool.end();
    });

    const fresh = () => ({
      slug: `marker-cli-${randomUUID()}`,
      email: `marker-cli-${randomUUID()}@example.test`,
    });

    const env = (organization: { slug: string; email: string }): Record<string, string> => ({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS,
      ALLOWED_ORIGINS: 'http://localhost:3000',
      TAYZU_OPERATOR_ID: OPERATOR_ID,
      BOOTSTRAP_ORGANIZATION_NAME: 'Marker CLI Org',
      BOOTSTRAP_ORGANIZATION_SLUG: organization.slug,
      BOOTSTRAP_ADMIN_NAME: 'Marker CLI Admin',
      BOOTSTRAP_ADMIN_EMAIL: organization.email,
    });

    function captureOutput(): string[] {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      return lines;
    }

    it('An admin created by the bootstrap CLI holds the marker: it signs in with the printed password, reaches only the routes of 13.5, and the expiry is 48 hours after the creation', async () => {
      const lines = captureOutput();
      const organization = fresh();

      const before = Date.now();
      await main({
        env: env(organization),
        appPool: cliAppPool,
        authPool: cliAuthPool,
      });
      const after = Date.now();

      const printed = lines.find((line) => line.includes('temporary password'));
      const password = printed?.trim().split(/\s+/).at(-1);
      expect(password, 'the one-time password is printed').toBeTruthy();
      const userId = await userIdOf(organization.email);
      if (userId === undefined || password === undefined) throw new Error('admin missing');

      await expectMarker(userId, before, after);
      await expectRestrictedSession(userId, organization.email, password);
    }, 120_000);

    it('A failing marker write in the bootstrap CLI fails the run and leaves no membership', async () => {
      captureOutput();
      const organization = fresh();
      await refuseMarkerWriteFor(organization.email);

      await expect(
        main({ env: env(organization), appPool: cliAppPool, authPool: cliAuthPool }),
      ).rejects.toThrow();

      expect(await membershipCount(organization.email), 'the admin never joined').toBe(0);
      const userId = await userIdOf(organization.email);
      if (userId !== undefined) expect(await markerOf(userId)).toHaveLength(0);
    }, 120_000);
  });
});
