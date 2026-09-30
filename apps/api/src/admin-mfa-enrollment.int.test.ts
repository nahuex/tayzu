/**
 * Integration test for task 23.15 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q43 and D4; `specs/auth-and-rbac/spec.md`, requirement
 * "Multi-factor authentication").
 *
 * Task 23.15: "A user with the organization role `admin` or `owner` who has no
 * enrolled MFA factor gets a session limited to MFA enrollment; every other
 * operation fails with `AUTH_STEP_UP_REQUIRED` until a factor is enrolled."
 *
 * Scenarios covered (verbatim from the spec):
 * - "An unenrolled admin is limited to MFA enrollment": GIVEN a user with the
 *   organization role `admin` or `owner` and no enrolled MFA factor, WHEN they
 *   sign in with the correct password, THEN the session may only reach MFA
 *   enrollment, and every other operation fails with `AUTH_STEP_UP_REQUIRED`
 *   until a factor is enrolled.
 * - "Unenrolled user signs in with password alone": GIVEN a user with the
 *   organization role `member` and no enrolled MFA factor, WHEN they sign in
 *   with the correct password, THEN sign-in completes with no additional
 *   factor requested.
 * - Task verify clause: "an admin passing after enrolling".
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)` (the
 * `@tayzu/db` `createPool` mock hands out the harness pools, as in
 * `step-up-sso-http.int.test.ts`). Every request goes through Fastify
 * (`app.app.inject`) with a fresh random `x-forwarded-for`. Users are created
 * through the admin-creation path (`bootstrapTestTenant` gives the `owner`;
 * `addMember` adds an `admin` and a `member`).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `createApp` (`./server.js`) gains a guard, for `user` actors only, that
 *   reads the session's user, their organization role in the active
 *   organization and whether the user has an enrolled factor
 *   (`twoFactorEnabled`). For role `admin` or `owner` without a factor, every
 *   `/v1` operation answers `403` with body code `AUTH_STEP_UP_REQUIRED`
 *   (no Cerbos or catalog work is reached), while the MFA enrollment routes
 *   (`/api/auth/two-factor/enable`, `/api/auth/two-factor/verify-totp`, ...)
 *   stay reachable. Once a factor is enrolled the guard no longer applies.
 *   A `member` is never limited by it.
 * - Note for the implementer: existing tests that use an unenrolled
 *   `bootstrapTestTenant` owner for `/v1` calls will need the enrolled
 *   fixture (`__fixtures__/fresh-mfa.ts`); that is outside this test.
 * - No Cerbos policy change and no migration.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error(`invalid base32 character in TOTP secret: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bitsCollected += 5;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

describe('Admin and owner MFA enrollment gate (task 23.15, design Q43 and D4)', () => {
  let app: App;
  let account: AccountApiSurface;

  beforeAll(async () => {
    const pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
    });
    account = app.auth.api as AccountApiSurface;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  async function newOwner(): Promise<BootstrappedTenant> {
    return await bootstrapTestTenant(app.auth, {
      name: 'Mfa Gate Owner',
      email: `mfa-gate-owner-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Mfa Gate Org',
      organizationSlug: `mfa-gate-${randomUUID()}`,
      ip: randomIp(),
    });
  }

  /** An extra user of `organizationId` with the given organization role and no MFA factor. */
  async function newMemberOf(
    organizationId: string,
    role: 'member' | 'admin',
  ): Promise<{ email: string }> {
    const email = `mfa-gate-${role}-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: `Mfa Gate ${role}`,
      email,
      password: TEST_PASSWORD,
    });
    await account.addMember({ body: { userId: created.userId, organizationId, role } });
    return { email };
  }

  function signInHttp(email: string) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
  }

  function authPost(cookie: string, path: string, body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: `/api/auth${path}`,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify(body),
    });
  }

  function listBlueprints(cookie: string) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie, 'x-forwarded-for': randomIp() },
    });
  }

  function createBlueprint(cookie: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({
        identifier: `mfa-gate-${randomUUID().slice(0, 8)}`,
        title: { en: 'Gate' },
        schema: { properties: {}, required: [] },
      }),
    });
  }

  function codeOf(response: { body: string }): unknown {
    try {
      return (JSON.parse(response.body) as { code?: unknown }).code;
    } catch {
      return undefined;
    }
  }

  async function expectLimitedToEnrollment(cookie: string): Promise<void> {
    const listed = await listBlueprints(cookie);
    expect(listed.statusCode, listed.body).toBe(403);
    expect(codeOf(listed)).toBe('AUTH_STEP_UP_REQUIRED');
    const created = await createBlueprint(cookie);
    expect(created.statusCode, created.body).toBe(403);
    expect(codeOf(created)).toBe('AUTH_STEP_UP_REQUIRED');
  }

  it('An unenrolled admin is limited to MFA enrollment: owner, every other operation fails with AUTH_STEP_UP_REQUIRED', async () => {
    const owner = await newOwner();

    const signedIn = await signInHttp(owner.email);
    expect(signedIn.statusCode, 'the password sign-in itself completes').toBe(200);
    const cookie = cookieFrom(signedIn.headers['set-cookie']);
    expect(cookie, 'a session is established').not.toBe('');

    await expectLimitedToEnrollment(cookie);

    // MFA enrollment stays reachable.
    const enable = await authPost(cookie, '/two-factor/enable', {
      password: TEST_PASSWORD,
      method: 'totp',
    });
    expect(enable.statusCode, enable.body).toBe(200);
    expect(enable.json<{ totpURI?: unknown }>().totpURI).toEqual(expect.any(String));
  }, 60_000);

  it('An unenrolled admin is limited to MFA enrollment: admin, every other operation fails with AUTH_STEP_UP_REQUIRED', async () => {
    const owner = await newOwner();
    const admin = await newMemberOf(owner.organizationId, 'admin');

    const signedIn = await signInHttp(admin.email);
    expect(signedIn.statusCode, 'the password sign-in itself completes').toBe(200);
    const cookie = cookieFrom(signedIn.headers['set-cookie']);
    expect(cookie, 'a session is established').not.toBe('');

    await expectLimitedToEnrollment(cookie);

    const enable = await authPost(cookie, '/two-factor/enable', {
      password: TEST_PASSWORD,
      method: 'totp',
    });
    expect(enable.statusCode, enable.body).toBe(200);
  }, 60_000);

  it('Unenrolled user signs in with password alone: a member is not limited and no additional factor is requested', async () => {
    const owner = await newOwner();
    const member = await newMemberOf(owner.organizationId, 'member');

    const signedIn = await signInHttp(member.email);

    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(
      signedIn.json<{ twoFactorRedirect?: unknown }>().twoFactorRedirect,
      'no additional factor is requested',
    ).toBeUndefined();
    const cookie = cookieFrom(signedIn.headers['set-cookie']);
    expect(cookie, 'a session is established').not.toBe('');
    const listed = await listBlueprints(cookie);
    expect(codeOf(listed), 'the enrollment gate never applies to a member').not.toBe(
      'AUTH_STEP_UP_REQUIRED',
    );
  }, 60_000);

  it('An admin passes after enrolling: the gate lifts once a factor is enrolled', async () => {
    const owner = await newOwner();
    const admin = await newMemberOf(owner.organizationId, 'admin');
    const first = await signInHttp(admin.email);
    const enrollmentCookie = cookieFrom(first.headers['set-cookie']);
    await expectLimitedToEnrollment(enrollmentCookie);

    // Enroll TOTP through the (reachable) enrollment routes.
    const enable = await authPost(enrollmentCookie, '/two-factor/enable', {
      password: TEST_PASSWORD,
      method: 'totp',
    });
    expect(enable.statusCode, enable.body).toBe(200);
    const totpURI = enable.json<{ totpURI: string }>().totpURI;
    const secret = rawSecretFromTotpUri(totpURI);
    const enrolled = await authPost(enrollmentCookie, '/two-factor/verify-totp', {
      code: (await account.generateTOTP({ body: { secret } })).code,
    });
    expect(enrolled.statusCode, enrolled.body).toBe(200);

    // The next sign-in is challenged, and completing the challenge yields a session that passes.
    const challenge = await signInHttp(admin.email);
    expect(challenge.statusCode, challenge.body).toBe(200);
    expect(challenge.json<{ twoFactorRedirect?: unknown }>().twoFactorRedirect).toBe(true);
    const verified = await authPost(
      cookieFrom(challenge.headers['set-cookie']),
      '/two-factor/verify-totp',
      { code: (await account.generateTOTP({ body: { secret } })).code },
    );
    expect(verified.statusCode, verified.body).toBe(200);
    const cookie = cookieFrom(verified.headers['set-cookie']);

    const listed = await listBlueprints(cookie);
    expect(listed.statusCode, listed.body).toBe(200);
    const created = await createBlueprint(cookie);
    expect(created.statusCode, created.body).toBe(200);
  }, 60_000);
});
