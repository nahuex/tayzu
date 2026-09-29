/**
 * Integration test for task 11.15 (openspec/changes/002-auth-and-rbac; design
 * D4, D13; `specs/auth-and-rbac/spec.md`, requirement "Step-up authentication
 * for high-risk operations").
 *
 * Task 11.15: "Wire the step-up guard (4.2, 21.3) into every `/v1` route
 * marked `x-tayzu-risk: high` in the production app. Verify:
 * `bootstrap-wiring.int.test.ts` covers 'A high-risk route without a fresh
 * MFA verification is blocked over HTTP' and 'A high-risk route with a fresh
 * verification succeeds', on an app built by `createAppFromEnv`."
 *
 * Scenarios covered (verbatim from the spec):
 * - "High-risk operation without a fresh MFA verification is blocked": GIVEN a
 *   user signed in without verifying MFA in the last 5 minutes, WHEN they call
 *   `blueprints.delete`, THEN it fails with `AUTH_STEP_UP_REQUIRED` and the
 *   blueprint is not deleted.
 * - "High-risk operation with a fresh MFA verification succeeds": GIVEN a user
 *   verified an MFA factor 1 minute ago, WHEN they call `blueprints.delete` on
 *   an otherwise-deletable blueprint, THEN the deletion proceeds.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)` with a
 * complete environment. `@tayzu/db`'s `createPool` is mocked to hand out the
 * harness pools (production URLs need `sslmode=verify-full`); `end` is a no-op
 * so the shared harness pools survive `app.close()`. Requests go through
 * `app.app.inject`, so no port is bound. Every Better Auth request carries a
 * fresh random `x-forwarded-for`. Users are org owners (mapped to `admin`, so
 * Cerbos allows the delete); Cerbos runs at `localhost:3593`.
 *
 * "Fresh MFA verification" is a real TOTP enrollment followed by a real TOTP
 * challenge on sign-in, which is what writes the freshness marker.
 *
 * ## Production symbols expected
 *
 * - `createAppFromEnv` / `createApp` (`./bootstrap.js` / `./server.js`) apply
 *   `@tayzu/auth`'s `createStepUpGuard` to every `/v1` operation whose route
 *   carries `x-tayzu-risk: high`, after context resolution and before the
 *   operation runs, answering `403` with body code `AUTH_STEP_UP_REQUIRED`
 *   (same mapping as `/link-social`). Behavior only is observed here.
 *
 * ## Why this fails right now
 *
 * `server.ts` never applies the step-up guard to `/v1` routes, so the
 * unverified user's `DELETE /v1/blueprints/{blueprint}` succeeds instead of
 * returning 403 (assertion failure). The fresh-verification test already passes.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
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
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const TEST_PASSWORD = 'correct horse battery staple';

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  BETTER_AUTH_SECRET: 'bootstrap-wiring-int-test-only-secret-0123456789-abcdef',
  CERBOS_ADDRESS: 'localhost:3593',
  ALLOWED_ORIGINS: ORIGIN,
};

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface TwoFactorApiSurface {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error('invalid base32 character in TOTP secret');
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret');
  if (secret === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secret));
}

function cookieHeaderOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

describe('production app wiring: step-up on high-risk /v1 routes (task 11.15, D4)', () => {
  let app: App;
  let totp: TwoFactorApiSurface;
  let authHandler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    app = await createAppFromEnv(ENV);
    totp = app.auth.api as TwoFactorApiSurface;
    authHandler = (app.auth as unknown as { handler: (request: Request) => Promise<Response> })
      .handler;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  async function newAdmin(): Promise<{ email: string; cookie: string }> {
    const suffix = randomUUID();
    const email = `wiring-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Wiring User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Wiring Org ${suffix}`,
      organizationSlug: `wiring-${suffix}`,
      ip: randomIp(),
    });
    return { email, cookie: tenant.cookie };
  }

  async function createBlueprint(cookie: string): Promise<string> {
    const identifier = `risk-${randomUUID().slice(0, 8)}`;
    const created = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: ORIGIN,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({
        identifier,
        title: { en: 'Risky' },
        schema: { properties: {}, required: [] },
      }),
    });
    expect(created.statusCode, 'precondition: the blueprint is created').toBe(200);
    return identifier;
  }

  function deleteBlueprint(cookie: string, identifier: string) {
    return app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/${identifier}`,
      headers: { cookie, origin: ORIGIN, ...csrfHeaders('DELETE') },
    });
  }

  function getBlueprint(cookie: string, identifier: string) {
    return app.app.inject({
      method: 'GET',
      url: `/v1/blueprints/${identifier}`,
      headers: { cookie },
    });
  }

  it('A high-risk route without a fresh MFA verification is blocked over HTTP', async () => {
    // GIVEN a user signed in without verifying MFA in the last 5 minutes.
    const { cookie } = await newAdmin();
    const identifier = await createBlueprint(cookie);

    // WHEN they call blueprints.delete over HTTP.
    const response = await deleteBlueprint(cookie, identifier);

    // THEN it fails with AUTH_STEP_UP_REQUIRED...
    expect(response.statusCode).toBe(403);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
    // AND the blueprint is not deleted.
    expect((await getBlueprint(cookie, identifier)).statusCode).toBe(200);
  }, 60_000);

  it('A high-risk route with a fresh verification succeeds', async () => {
    // GIVEN a user who verified an MFA factor moments ago (real TOTP challenge).
    const { email, cookie: enrollmentCookie } = await newAdmin();
    const enrollHeaders = new Headers({ cookie: enrollmentCookie });
    const enabled = await totp.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers: enrollHeaders,
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    await totp.verifyTOTP({
      body: { code: (await totp.generateTOTP({ body: { secret } })).code },
      headers: enrollHeaders,
    });
    const challenge = await authHandler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      }),
    );
    expect(challenge.status, 'the sign-in is challenged').toBe(200);
    const verified = await authHandler(
      new Request(`${AUTH_BASE_URL}/two-factor/verify-totp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          cookie: cookieHeaderOf(challenge),
        },
        body: JSON.stringify({ code: (await totp.generateTOTP({ body: { secret } })).code }),
      }),
    );
    expect(verified.status, 'the TOTP challenge is verified').toBe(200);
    const freshCookie = cookieHeaderOf(verified);
    const identifier = await createBlueprint(freshCookie);

    // WHEN they call blueprints.delete on an otherwise-deletable blueprint.
    const response = await deleteBlueprint(freshCookie, identifier);

    // THEN the deletion proceeds.
    expect(response.statusCode).toBeLessThan(300);
    expect((await getBlueprint(freshCookie, identifier)).statusCode).toBe(404);
  }, 60_000);
});
