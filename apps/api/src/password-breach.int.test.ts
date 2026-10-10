/**
 * Task 8.1b of openspec/changes/043-identity-lifecycle-and-org-admin (design Q23;
 * spec "Password policy", scenarios "A breached password is refused" and "The
 * breach check fails closed").
 *
 * ## Production symbols expected
 *
 * - `packages/auth/src/auth.ts`: `createAuth` adds Better Auth's built-in
 *   `haveIBeenPwned` plugin (`better-auth/plugins`, no new dependency), so a
 *   password set through `auth.api.createUser` (`/admin/create-user`) is checked
 *   against the Pwned Passwords range API. A breached password is refused with the
 *   plugin's `PASSWORD_COMPROMISED` `APIError` (400); an unreachable service makes
 *   the plugin throw its fail-closed 500 `APIError`.
 * - `identity.users.create` (temporary password) and `bootstrapAdmin` (bootstrap
 *   password) already create the user through `auth.api.createUser`, so the plugin
 *   covers them; nothing else is expected to change for them.
 * - `toOrpcError` (`./error-mapping.js`, existing) turns the 500 `APIError` into the
 *   generic `INTERNAL` (500) error: no new code, no provider text.
 *
 * The test installs its own `fetch` over the shared stub of task 8.1a
 * (`vitest.int.stub.mjs`) with `vi.stubGlobal`, only inside each test and after the
 * tenant setup, so the setup passwords never meet it. The temporary and bootstrap
 * passwords are random; `node:crypto`'s `randomBytes(24)` (the generator of both)
 * is made deterministic here so the stubbed range can contain their SHA-1 suffix.
 */
import { createHash, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { toOrpcError } from './error-mapping.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createIdentityRouter } from './identity-router.js';
import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { bootstrapAdmin } from '../../../packages/auth/src/bootstrap-admin.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

/** The generator of the temporary and bootstrap passwords, fixed for this file. */
const FIXED_RANDOM_BYTES = 24;
const FIXED_TEMPORARY_PASSWORD = Buffer.alloc(FIXED_RANDOM_BYTES, 7).toString('base64url');

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer =>
      size === 24 ? Buffer.alloc(24, 7) : actual.randomBytes(size),
  };
});

const OPERATOR_ID = 'gh:424242';
const BREACHED_PASSWORD = 'Correct-Horse-Battery-Staple-2026!';
const CLEAN_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';

function sha1Upper(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase();
}

interface RangeStub {
  readonly urls: string[];
  readonly requests: { readonly url: string; readonly init: string }[];
}

/** A stub of the range query: the given passwords are "breached"; anything else gets decoys only. */
function stubRangeService(breached: readonly string[]): RangeStub {
  const stub: RangeStub = { urls: [], requests: [] };
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    stub.urls.push(url);
    stub.requests.push({ url, init: JSON.stringify(init ?? {}) });
    const prefix = new URL(url).pathname.split('/').pop() ?? '';
    const lines = [
      '0000000000000000000000000000000000A:3',
      '1111111111111111111111111111111111B:9',
    ];
    for (const password of breached) {
      const hash = sha1Upper(password);
      if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:42`);
    }
    return Promise.resolve(new Response(lines.join('\r\n'), { status: 200 }));
  });
  return stub;
}

function stubUnreachableService(): RangeStub {
  const stub: RangeStub = { urls: [], requests: [] };
  vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
    stub.urls.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    return Promise.reject(
      new TypeError('fetch failed: getaddrinfo ENOTFOUND provider-detail.example'),
    );
  });
  return stub;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface CreateUserSurface {
  createUser(args: { body: { name: string; email: string; password: string } }): Promise<{
    user: { id: string; email: string };
  }>;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('The breached-password check (task 8.1b, design Q23)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    client = createRouterClient(
      createIdentityRouter({ auth, authz: cerbos, authRepository: createAuthRepository(authPool) }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Breach Org', slug: `breach-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  async function countUsers(email: string): Promise<number> {
    const result = await drizzle(authPool, { schema: authSchema }).execute<{ count: string }>(sql`
      select count(*)::text as count from auth."user" where email = ${email}
    `);
    return Number(result.rows[0]?.count ?? '0');
  }

  function createUserApi(): CreateUserSurface {
    return auth.api as CreateUserSurface;
  }

  it('A breached password is refused when set through auth.api.createUser, naming the rule and not echoing it', async () => {
    const email = `breached-${randomUUID()}@example.test`;
    stubRangeService([BREACHED_PASSWORD]);

    const error = await caught(
      createUserApi().createUser({
        body: { name: 'Breached', email, password: BREACHED_PASSWORD },
      }),
    );

    expect(error, 'the breached password is refused').toBeDefined();
    expect((error as { body?: { code?: string } }).body?.code).toBe('PASSWORD_COMPROMISED');
    expect(JSON.stringify(error)).not.toContain(BREACHED_PASSWORD);
    expect((error as Error).message).not.toContain(BREACHED_PASSWORD);
    expect(await countUsers(email), 'no user is created').toBe(0);
  });

  it('A clean password is accepted, and the range service was asked', async () => {
    const email = `clean-${randomUUID()}@example.test`;
    const stub = stubRangeService([BREACHED_PASSWORD]);

    const created = await createUserApi().createUser({
      body: { name: 'Clean', email, password: CLEAN_PASSWORD },
    });

    expect(created.user.email).toBe(email);
    expect(await countUsers(email)).toBe(1);
    expect(stub.urls, 'the check ran: exactly one range query').toHaveLength(1);
  });

  it('Only the 5-character SHA-1 prefix is ever sent', async () => {
    const email = `prefix-${randomUUID()}@example.test`;
    const stub = stubRangeService([BREACHED_PASSWORD]);

    await caught(
      createUserApi().createUser({ body: { name: 'Prefix', email, password: BREACHED_PASSWORD } }),
    );

    const hash = sha1Upper(BREACHED_PASSWORD);
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      const url = new URL(request.url);
      expect(url.hostname).toBe('api.pwnedpasswords.com');
      expect(url.pathname).toBe(`/range/${hash.slice(0, 5)}`);
      expect(url.search).toBe('');
      const sent = `${request.url} ${request.init}`.toUpperCase();
      expect(sent).not.toContain(hash.slice(5, 15));
      expect(sent).not.toContain(hash);
      expect(sent).not.toContain(BREACHED_PASSWORD.toUpperCase());
    }
  });

  it('A breached temporary password is refused through identity.users.create', async () => {
    const tenantId = await freshTenantId();
    const email = `temp-${randomUUID()}@example.test`;
    stubRangeService([FIXED_TEMPORARY_PASSWORD]);

    const error = await caught(
      client.identity.users.create(
        { email, name: 'Temporary', role: 'member' },
        {
          context: {
            tenantId,
            actor: { type: 'user', id: `admin-${randomUUID()}` },
            principal: { roles: ['admin'] },
          },
        },
      ),
    );

    expect(error, 'the breached temporary password is refused').toBeDefined();
    expect(JSON.stringify(error)).not.toContain(FIXED_TEMPORARY_PASSWORD);
    expect(await countUsers(email), 'no user is created').toBe(0);
  }, 60_000);

  it('A breached bootstrap password is refused and nothing is created', async () => {
    const email = `bootstrap-${randomUUID()}@example.test`;
    const slug = `breach-bootstrap-${randomUUID()}`;
    stubRangeService([FIXED_TEMPORARY_PASSWORD]);

    const error = await caught(
      bootstrapAdmin(
        auth,
        {
          organizationName: 'Breach Bootstrap',
          organizationSlug: slug,
          adminName: 'Bootstrap Admin',
          adminEmail: email,
        },
        { operatorId: OPERATOR_ID },
      ),
    );

    expect(error, 'the bootstrap does not succeed with a breached password').toBeDefined();
    expect(JSON.stringify(error)).not.toContain(FIXED_TEMPORARY_PASSWORD);
    expect(await countUsers(email), 'no admin user is created').toBe(0);
    const orgs = await drizzle(authPool, { schema: authSchema }).execute<{ count: string }>(sql`
      select count(*)::text as count from auth.organization where slug = ${slug}
    `);
    expect(Number(orgs.rows[0]?.count ?? '0'), 'no organization is created').toBe(0);
  });

  it('The breach check fails closed: an unreachable service refuses the password with the plugin 500', async () => {
    const email = `down-${randomUUID()}@example.test`;
    const stub = stubUnreachableService();

    const error = await caught(
      createUserApi().createUser({ body: { name: 'Down', email, password: CLEAN_PASSWORD } }),
    );

    expect(stub.urls.length, 'the check was attempted').toBeGreaterThan(0);
    expect(error, 'the password is not set').toBeDefined();
    expect((error as { statusCode?: number }).statusCode).toBe(500);
    expect(await countUsers(email), 'no user is created').toBe(0);
  });

  it('At the boundary an unreachable service is the sanitized generic INTERNAL error, with no provider text', async () => {
    const email = `down-boundary-${randomUUID()}@example.test`;
    stubUnreachableService();

    const error = await caught(
      createUserApi().createUser({ body: { name: 'Down', email, password: CLEAN_PASSWORD } }),
    );
    expect(error).toBeDefined();
    const mapped = toOrpcError(error);

    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.status).toBe(500);
    const serialized = JSON.stringify({
      code: mapped.code,
      message: mapped.message,
      data: mapped.data,
    });
    for (const leaked of [
      'pwnedpasswords',
      'Failed to check password',
      'provider-detail',
      'fetch failed',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('An unreachable service refuses a temporary password through identity.users.create with the generic error', async () => {
    const tenantId = await freshTenantId();
    const email = `temp-down-${randomUUID()}@example.test`;
    stubUnreachableService();

    const error = await caught(
      client.identity.users.create(
        { email, name: 'Temporary', role: 'member' },
        {
          context: {
            tenantId,
            actor: { type: 'user', id: `admin-${randomUUID()}` },
            principal: { roles: ['admin'] },
          },
        },
      ),
    );

    expect(error).toBeDefined();
    const mapped = toOrpcError(error);
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.status).toBe(500);
    expect(await countUsers(email)).toBe(0);
  }, 60_000);
});
