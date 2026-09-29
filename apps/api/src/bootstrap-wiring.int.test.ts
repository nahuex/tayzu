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
import { createMachineCredential } from '../../../packages/auth/src/machine-credentials.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

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
  BETTER_AUTH_SECRET: TEST_SECRET,
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

/**
 * Task 11.16 (design D5, D20; `specs/auth-and-rbac/spec.md`, requirement
 * "Machine credentials").
 *
 * Task 11.16: "`POST /v1/auth/token` handler calling `exchangeMachineToken`
 * behind its IP/client-id rate limit (5.3, 11.13), plus the JWKS route design
 * D5 names. Verify: `bootstrap-wiring.int.test.ts` covers 'Machine token
 * exchange works over HTTP on the production app'."
 *
 * Spec scenarios exercised over HTTP (verbatim):
 * - "Valid client id and secret exchange for an access token": GIVEN an active
 *   `integration`-kind machine credential, WHEN its client id and secret are
 *   posted to `POST /v1/auth/token`, THEN an access token is returned that
 *   resolves to `actor.type` `integration`.
 * - "Wrong secret is rejected": WHEN a valid client id is posted with an
 *   incorrect secret, THEN it fails with `AUTH_INVALID_CREDENTIALS`.
 *
 * ## Production symbols expected
 *
 * - `createApp`/`createAppFromEnv` mount `POST /v1/auth/token` (body
 *   `{ clientId, clientSecret }`) calling `@tayzu/auth`'s `exchangeMachineToken`
 *   with the Better Auth instance. Success: 200 `{ accessToken: string }`, no
 *   refresh token. Failure: 401 with body `code: 'AUTH_INVALID_CREDENTIALS'`
 *   (the mapping of `AuthInvalidCredentialsError`). The route is reachable
 *   without a session and is behind the 11.13 limiter.
 * - The `jwt` plugin's public key set is served at `GET /api/auth/jwks`
 *   (design D5: "exposed at `/jwks`"; `/jwks` joins `ALLOWED_AUTH_ROUTES`).
 *   The exact public path is an assumption (design gives only `/jwks`; the
 *   Better Auth mount is `/api/auth`); confirm before implementing.
 *
 * ## Why this fails right now
 *
 * `server.ts` mounts no handler for `POST /v1/auth/token` (404) and the
 * allowlist keeps `/jwks` unreachable (404): assertion failures.
 */
describe('production app wiring: machine token exchange (task 11.16, D5)', () => {
  let app: App;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    app = await createAppFromEnv(ENV);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  async function newIntegrationCredential(): Promise<{
    id: string;
    secret: string;
    organizationId: string;
  }> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Token Wiring Admin',
      email: `token-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Token Wiring Org ${suffix}`,
      organizationSlug: `token-wiring-${suffix}`,
      ip: randomIp(),
    });
    const created = await createMachineCredential(app.auth, {
      headers: new Headers({ cookie: tenant.cookie }),
      organizationId: tenant.organizationId,
      name: 'Token wiring credential',
      actorKind: 'integration',
    });
    return { id: created.id, secret: created.secret, organizationId: tenant.organizationId };
  }

  function postToken(clientId: string, clientSecret: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId, clientSecret }),
    });
  }

  function decodePayload(token: string): {
    tenantId?: unknown;
    actor?: { type?: unknown; id?: unknown };
  } {
    const segment = token.split('.')[1];
    if (segment === undefined) {
      throw new Error('expected a JWT');
    }
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      tenantId?: unknown;
      actor?: { type?: unknown; id?: unknown };
    };
  }

  it('Machine token exchange works over HTTP on the production app', async () => {
    // GIVEN an active integration-kind machine credential.
    const credential = await newIntegrationCredential();

    // WHEN its client id and secret are posted to POST /v1/auth/token.
    const response = await postToken(credential.id, credential.secret);

    // THEN an access token is returned...
    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken?: unknown; refreshToken?: unknown }>();
    expect(typeof body.accessToken).toBe('string');
    expect(body.refreshToken, 'no refresh token is returned').toBeUndefined();
    const accessToken = body.accessToken as string;

    // ... that resolves to actor.type integration.
    const payload = decodePayload(accessToken);
    expect(payload.actor?.type).toBe('integration');
    expect(payload.actor?.id).toBe(credential.id);
    expect(payload.tenantId).toBe(credential.organizationId);

    // The token is accepted as a bearer credential on /v1 (context resolves;
    // the unknown blueprint is a plain 404, not a context failure).
    const used = await app.app.inject({
      method: 'GET',
      url: `/v1/blueprints/token-wiring-${randomUUID().slice(0, 8)}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(used.statusCode).toBe(404);
  }, 60_000);

  it('Machine token exchange rejects a wrong secret over HTTP with AUTH_INVALID_CREDENTIALS', async () => {
    // GIVEN a valid client id; WHEN it is posted with an incorrect secret.
    const credential = await newIntegrationCredential();
    const wrongSecret = `wrong-secret-${randomUUID()}`;
    const response = await postToken(credential.id, wrongSecret);

    // THEN it fails with AUTH_INVALID_CREDENTIALS.
    expect(response.statusCode).toBe(401);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(response.body).not.toContain(wrongSecret);
    expect(response.body).not.toContain(credential.secret);
  }, 60_000);

  it('The JWKS route publishes the key that signed the exchanged token', async () => {
    const credential = await newIntegrationCredential();
    const exchanged = await postToken(credential.id, credential.secret);
    expect(exchanged.statusCode, 'precondition: the exchange succeeds').toBe(200);
    const token = exchanged.json<{ accessToken: string }>().accessToken;
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { kid?: unknown };

    const jwks = await app.app.inject({ method: 'GET', url: '/api/auth/jwks' });

    expect(jwks.statusCode).toBe(200);
    const keys = jwks.json<{ keys?: { kid?: unknown }[] }>().keys ?? [];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.map((key) => key.kid)).toContain(header.kid);
  }, 60_000);
});
