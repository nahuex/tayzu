/**
 * `044` tasks 9.2 and 9.3: the `mfa-reenrol:<userId>` marker confines a session to
 * second-factor enrolment, and verified enrolment lifts the confinement (design D11,
 * Resolved decision Q17).
 *
 * Scenarios of `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * #### Scenario: The next sign-in is confined to enrolment
 * - GIVEN a member whose factor an admin reset
 * - WHEN the member signs in with the password and calls a `/v1` route, and then the
 *   second-factor enable route
 * - THEN the `/v1` call is rejected as a missing context and the enrolment route is reachable
 *
 * #### Scenario: Enrolment lifts the confinement
 * - WHEN the member enrols and verifies a new TOTP factor
 * - THEN the next `/v1` call succeeds
 *
 * ## Production symbols expected
 *
 * - `hooks.before` in `packages/auth/src/auth.ts`: a session whose user holds the marker
 *   reaches only `/two-factor/enable`, `/two-factor/verify-totp`, `/get-session` and
 *   `/sign-out`; every other route is refused (4xx, the code is a fixed one the spec leaves
 *   open, so only the status class is asserted).
 * - `createContextResolver` rejects a held marker as `CATALOG_CONTEXT_REQUIRED`.
 * - `hooks.after` on `/two-factor/verify-totp` clears the marker once `twoFactorEnabled`
 *   is true.
 * - The marker is written by `createAuthRepository(authPool).writeMfaReenrolMarker`
 *   (exists), standing in for the reset until 10.3.
 *
 * Harness: `auth.handler(new Request(...))` with a fresh random `x-forwarded-for` per
 * request; a fresh random tenant, owner, member and slug per test.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, createContextResolver, type AuthInstance } from '@tayzu/auth';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createAdminUser,
  seedUserRow,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { getOwnerPool } from '../../../packages/db/src/harness.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

interface AuthApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' };
  }): Promise<unknown>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
}

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') break;
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) throw new Error(`invalid base32 character in TOTP secret: ${char}`);
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
  if (secretParam === null) throw new Error('expected a secret query parameter on the TOTP URI');
  return new TextDecoder().decode(decodeBase32(secretParam));
}

describe('A reset second factor must be enrolled again before use (tasks 9.2, 9.3, D11)', () => {
  let authPool: Pool;
  let appPool: Pool;
  let ownerPool: Pool;
  let auth: AuthInstance;
  let api: AuthApiSurface;
  let resolveContext: (headers: Headers) => Promise<unknown>;
  let writeMarker: (userId: string) => Promise<void>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    appPool = pools.appPool;
    ownerPool = await getOwnerPool();
    await runMigrations(authPool);
    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
    api = auth.api as AuthApiSurface;
    resolveContext = createContextResolver({ auth, revocationPool: appPool });
    const repository = createAuthRepository(authPool);
    writeMarker = (userId) => repository.writeMfaReenrolMarker(userId);
  }, 120_000);

  /** A fresh tenant with an owner, and a member of it with no factor and an Active `_user` row. */
  async function freshMember(): Promise<{
    userId: string;
    email: string;
    tenantId: string;
  }> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Reenrol Owner',
      email: `reenrol-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Reenrol Org', slug: `reenrol-${id}`, userId: owner.userId },
    });
    const email = `reenrol-member-${id}@example.test`;
    const member = await createAdminUser(auth, {
      name: 'Reenrol Member',
      email,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: member.userId, organizationId: org.id, role: 'member' },
    });
    await seedUserRow(appPool, { tenantId: org.id, email, name: 'Reenrol Member' });
    return { userId: member.userId, email, tenantId: org.id };
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

  async function markerCount(userId: string): Promise<number> {
    const result = await ownerPool.query<{ n: string }>(
      'select count(*)::text as n from auth.verification where identifier = $1',
      [`mfa-reenrol:${userId}`],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function signIn(email: string): Promise<string> {
    return (await signInAdminUser(auth, { email, password: TEST_PASSWORD, ip: randomIp() })).cookie;
  }

  it('The next sign-in is confined to enrolment: the /v1 call is rejected as a missing context and the enrolment route is reachable', async () => {
    const member = await freshMember();

    // Control: before the reset marker the same session reaches `/v1`.
    const before = await signIn(member.email);
    await expect(resolveContext(new Headers({ cookie: before }))).resolves.toMatchObject({
      tenantId: member.tenantId,
    });

    await writeMarker(member.userId);
    const cookie = await signIn(member.email);

    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });

    const session = await authRequest('/get-session', cookie, 'GET');
    expect(session.status, '/get-session stays reachable').toBe(200);

    const listAccounts = await authRequest('/list-accounts', cookie, 'GET');
    expect(listAccounts.status, '/list-accounts is refused').toBeGreaterThanOrEqual(400);
    expect(listAccounts.status).toBeLessThan(500);

    const changePassword = await authRequest('/change-password', cookie, 'POST', {
      currentPassword: TEST_PASSWORD,
      newPassword: `Changed-${randomUUID()}-Aa1!`,
    });
    expect(changePassword.status, '/change-password is refused').toBeGreaterThanOrEqual(400);
    expect(changePassword.status).toBeLessThan(500);

    const enable = await authRequest('/two-factor/enable', cookie, 'POST', {
      password: TEST_PASSWORD,
    });
    expect(enable.status, '/two-factor/enable is reachable').toBe(200);
    const enabled = (await enable.json()) as { totpURI?: string };
    expect(enabled.totpURI).toBeTruthy();

    expect(await markerCount(member.userId), 'enable alone keeps the marker').toBe(1);
    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });

    const signOut = await authRequest('/sign-out', cookie, 'POST', {});
    expect(signOut.status, '/sign-out stays reachable').toBe(200);
  }, 120_000);

  it('Enrolment lifts the confinement: after a verified TOTP the next /v1 call succeeds and the marker is gone', async () => {
    const member = await freshMember();
    await writeMarker(member.userId);
    expect(await markerCount(member.userId)).toBe(1);
    const cookie = await signIn(member.email);

    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });

    const enable = await authRequest('/two-factor/enable', cookie, 'POST', {
      password: TEST_PASSWORD,
    });
    expect(enable.status).toBe(200);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = rawSecretFromTotpUri(totpURI);

    const { code } = await api.generateTOTP({ body: { secret } });
    const verified = await authRequest('/two-factor/verify-totp', cookie, 'POST', { code });
    expect(verified.status, '/two-factor/verify-totp is reachable and succeeds').toBe(200);

    expect(await markerCount(member.userId), 'verified enrolment clears the marker').toBe(0);

    const refreshed = verified.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
    const next = refreshed.length > 0 ? refreshed : cookie;
    await expect(resolveContext(new Headers({ cookie: next }))).resolves.toMatchObject({
      tenantId: member.tenantId,
    });
  }, 120_000);
});
