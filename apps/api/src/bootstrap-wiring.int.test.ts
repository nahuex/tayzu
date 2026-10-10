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
import { connect, createServer } from 'node:net';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
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

import { enrolledAdminSession, sessionTokenOfCookie } from './__fixtures__/fresh-mfa.js';
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
  INVITATION_LINK_BASE_URL: ORIGIN,
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
  let stepUpAuthPool: import('pg').Pool;
  let authHandler: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    stepUpAuthPool = authPool;
    app = await createAppFromEnv(ENV);
    totp = app.auth.api as TwoFactorApiSurface;
    authHandler = (app.auth as unknown as { handler: (request: Request) => Promise<Response> })
      .handler;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  /** An unenrolled org owner, as `bootstrapTestTenant` creates it. */
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

  /**
   * Q43: an MFA-enrolled org admin whose session carries no fresh verification: enrolled and
   * signed in through a TOTP challenge, then its freshness marker is expired.
   */
  async function newEnrolledAdminWithoutFreshMfa(): Promise<{ cookie: string }> {
    const admin = await newAdmin();
    const enrolled = await enrolledAdminSession(app, admin, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
    await stepUpAuthPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(enrolled.cookie)}`,
    ]);
    return { cookie: enrolled.cookie };
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
    const { cookie } = await newEnrolledAdminWithoutFreshMfa();
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
          origin: ORIGIN,
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

/**
 * Task 11.17 (design D13, D20, D23, D26, Q32; `specs/auth-and-rbac/spec.md`).
 *
 * Task 11.17: "`createAppFromEnv` wires Visma Connect SSO (from its environment
 * variables; absent configuration disables SSO explicitly and its routes return
 * 404), the pre-auth, per-principal and token-exchange rate limits, the body
 * limit and the back-channel logout processing. Verify: `bootstrap-wiring.int.
 * test.ts` covers each of these being active on the production app."
 *
 * Scenarios exercised over HTTP on an app built by `createAppFromEnv`:
 * - "Repeated failed sign-ins from the same source are rate-limited" (pre-auth).
 * - "One principal is rate-limited while a different principal is unaffected"
 *   (per-principal, D13).
 * - "Machine token exchange is rate-limited independently of the authenticated
 *   bucket" (D20).
 * - "A request body over the configured limit is rejected" (D13 body limit).
 * - "A valid logout token revokes the matching session" and the Q32 rate limit
 *   (back-channel logout, D26).
 * - Visma Connect SSO is registered from the environment, and absent
 *   configuration disables it: `/api/auth/sign-in/social` for the provider and
 *   the back-channel logout route answer 404.
 *
 * ## Production symbols expected (ASSUMED names: the design names only the last)
 *
 * `loadConfig` (`./config.js`) reads, and `createAppFromEnv` forwards to
 * `createApp` as `sso`, `rateLimit`, `tokenExchangeRateLimit`, `bodyLimit` and
 * Better Auth's pre-auth `rateLimit.signIn` (seconds window):
 * - `VISMA_CONNECT_DISCOVERY_URL`, `VISMA_CONNECT_CLIENT_ID`,
 *   `VISMA_CONNECT_CLIENT_SECRET`: all three or none (none = SSO disabled).
 * - `PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX`, `PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS`
 * - `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS` (per principal, `/v1/*`)
 * - `TOKEN_EXCHANGE_RATE_LIMIT_MAX`, `TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS`
 * - `BODY_LIMIT_BYTES`
 * - `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE` (Q32: positive integer, default
 *   600, anything else fails startup naming the variable). `createApp` must
 *   accept it (an option such as `backchannelLogoutRateLimitPerMinute`).
 * - With SSO disabled, `POST /v1/auth/visma-connect/backchannel-logout` is not
 *   registered (404).
 *
 * ## Why this fails right now
 *
 * `loadConfig` reads none of these variables, so the limits and SSO are never
 * active (assertion failures), and the logout route answers even without SSO.
 */
const LOGOUT_ROUTE = '/v1/auth/visma-connect/backchannel-logout';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

function ssoEnv(stub: OidcStub): Record<string, string> {
  return {
    VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
    VISMA_CONNECT_CLIENT_ID: stub.clientId,
    VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
  };
}

describe('production app wiring: Visma Connect SSO and back-channel logout (task 11.17, D23, D26)', () => {
  let app: App;
  let stub: OidcStub;
  let authPool: import('pg').Pool;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({ ...ENV, ...ssoEnv(stub) });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  async function ssoTenant(sid: string): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Wiring SSO',
      email: `wiring-sso-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Wiring SSO Org ${suffix}`,
      organizationSlug: `wiring-sso-${suffix}`,
      ip: randomIp(),
    });
    // Q43: enrolling revokes the bootstrap session, so the SSO-marked one comes from a TOTP sign-in.
    const enrolled = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
    await authPool.query('update auth.session set sso_sid = $1 where token = $2', [
      sid,
      sessionTokenOfCookie(enrolled.cookie),
    ]);
    return enrolled.cookie;
  }

  it('Visma Connect SSO is registered from its environment variables: sign-in initiation redirects to the discovered provider', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ provider: 'visma-connect', callbackURL: '/' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ url?: string }>().url?.startsWith(stub.issuer)).toBe(true);
  }, 60_000);

  it('A valid logout token revokes the matching session on the production app', async () => {
    const sid = `sid-${randomUUID()}`;
    const cookie = await ssoTenant(sid);
    const use = () => app.app.inject({ method: 'GET', url: '/v1/blueprints', headers: { cookie } });
    expect((await use()).statusCode, 'the SSO session works before').toBe(200);
    const now = Math.floor(Date.now() / 1000);
    const token = stub.signJwt(
      {
        iss: stub.issuer,
        aud: stub.clientId,
        sub: `wiring-sub-${randomUUID()}`,
        sid,
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
        events: { [LOGOUT_EVENT]: {} },
      },
      { typ: 'logout+jwt' },
    );

    const response = await app.app.inject({
      method: 'POST',
      url: LOGOUT_ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: new URLSearchParams({ logout_token: token }).toString(),
    });

    expect(response.statusCode).toBe(200);
    const revoked = await use();
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code?: unknown }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
  }, 60_000);
});

describe('production app wiring: absent SSO configuration disables SSO (task 11.17, D23)', () => {
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

  it('the Visma Connect sign-in and back-channel logout routes return 404', async () => {
    const signIn = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ provider: 'visma-connect', callbackURL: '/' }),
    });
    const logout = await app.app.inject({
      method: 'POST',
      url: LOGOUT_ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: new URLSearchParams({ logout_token: 'a.b.c' }).toString(),
    });

    expect(signIn.statusCode).toBe(404);
    expect(logout.statusCode).toBe(404);
  }, 60_000);
});

describe('production app wiring: startup validation of the Q32 variable (task 11.17)', () => {
  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  }, 60_000);

  afterAll(() => {
    state.pools.clear();
  });

  it.each(['0', '-1', 'abc', '1.5', ''])(
    'BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE=%j fails startup naming the variable',
    async (value) => {
      const outcome = await createAppFromEnv({
        ...ENV,
        BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: value,
      }).then(
        async (started) => {
          await started.close();
          return 'started';
        },
        (error: unknown) => (error instanceof Error ? error.message : 'non-error rejection'),
      );
      expect(outcome, 'startup fails instead of starting').not.toBe('started');
      expect(outcome).toMatch(/BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE/);
    },
    60_000,
  );
});

describe('production app wiring: rate limits and body limit from the environment (task 11.17, D13, D20)', () => {
  const MAX = 2;
  const BODY_LIMIT = 4096;
  let app: App;
  let stub: OidcStub;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      ...ENV,
      ...ssoEnv(stub),
      PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX: String(MAX),
      PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_MAX: String(MAX),
      RATE_LIMIT_WINDOW_SECONDS: '60',
      TOKEN_EXCHANGE_RATE_LIMIT_MAX: String(MAX),
      TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS: '60',
      BODY_LIMIT_BYTES: String(BODY_LIMIT),
      BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: String(MAX),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  async function newCookie(): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Limits Wiring',
      email: `limits-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Limits Wiring Org ${suffix}`,
      organizationSlug: `limits-wiring-${suffix}`,
      ip: randomIp(),
    });
    return (await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN }))
      .cookie;
  }

  it('Repeated failed sign-ins from the same source are rate-limited over HTTP', async () => {
    const ip = randomIp();
    const email = `nobody-${randomUUID()}@example.test`;
    const signIn = () =>
      app.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          'x-forwarded-for': ip,
        },
        payload: JSON.stringify({ email, password: `wrong-${randomUUID()}` }),
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await signIn()).statusCode).not.toBe(429);
    }

    const limited = await signIn();

    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('One principal is rate-limited while a different principal is unaffected on the production app', async () => {
    const cookie = await newCookie();
    const other = await newCookie();
    const probe = (who: string) =>
      app.app.inject({
        method: 'GET',
        url: `/v1/blueprints/limits-probe-${randomUUID()}`,
        headers: { cookie: who },
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await probe(cookie)).statusCode).toBe(404);
    }

    const limited = await probe(cookie);

    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    expect((await probe(other)).statusCode).toBe(404);
  }, 60_000);

  it('Machine token exchange is rate-limited on the production app', async () => {
    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;
    const exchange = () =>
      app.app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-forwarded-for': ip,
          ...csrfHeaders('POST'),
        },
        payload: JSON.stringify({ clientId, clientSecret: `wrong-${randomUUID()}` }),
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await exchange()).statusCode).not.toBe(429);
    }

    const limited = await exchange();

    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);

  it('A request body over the configured limit is rejected with 413 on the production app', async () => {
    const cookie = await newCookie();

    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: ORIGIN,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({
        identifier: `big-${randomUUID().slice(0, 8)}`,
        title: { en: 'x'.repeat(BODY_LIMIT * 2) },
        schema: { properties: {}, required: [] },
      }),
    });

    expect(response.statusCode).toBe(413);
  }, 60_000);

  it('The back-channel logout route is rate-limited per source IP from BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE', async () => {
    const ip = randomIp();
    const post = () =>
      app.app.inject({
        method: 'POST',
        url: LOGOUT_ROUTE,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
        payload: new URLSearchParams({ logout_token: 'a.b.c' }).toString(),
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await post()).statusCode).toBe(200);
    }

    expect((await post()).statusCode).toBe(429);
    expect(
      (
        await app.app.inject({
          method: 'POST',
          url: LOGOUT_ROUTE,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': randomIp(),
          },
          payload: new URLSearchParams({ logout_token: 'a.b.c' }).toString(),
        })
      ).statusCode,
      'another source IP has its own bucket',
    ).toBe(200);
  }, 60_000);
});

/**
 * Task 11.19: the wiring guard (design D13, D18, D20, D23, D26, Q33).
 *
 * Task 11.19: "A wiring guard: a test that builds the app from a complete
 * environment and asserts every protection this design declares is active
 * (step-up, the four rate limiters, CSRF, CORS, helmet, body limit, route
 * allowlist, SSO, back-channel logout, health route). Verify:
 * `bootstrap-wiring.int.test.ts` fails if any of them is removed from
 * `createAppFromEnv`."
 *
 * Coverage map on an app built by `createAppFromEnv` (earlier blocks in this
 * file already cover step-up (11.15), the sign-in, per-principal, token-exchange
 * and back-channel-logout limiters, body limit, SSO and back-channel logout
 * (11.17)). This block adds the protections that had no wiring test on the
 * production app: CSRF, CORS, helmet, the route allowlist, the health route and
 * the two-factor and email-verification pre-auth limiters (11.18).
 *
 * ## Production symbols expected
 *
 * None new: `createAppFromEnv` (`./bootstrap.js`) forwarding everything to
 * `createApp`. These tests may already pass; they are a regression guard so
 * that removing any of these from the production bootstrap fails the suite.
 */
describe('production app wiring guard: remaining protections (task 11.19)', () => {
  const MAX = 2;
  let app: App;
  let stub: OidcStub;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      ...ENV,
      ...ssoEnv(stub),
      PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX: String(MAX),
      PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: '60',
      RATE_LIMIT_MAX: '1000',
      RATE_LIMIT_WINDOW_SECONDS: '60',
      TOKEN_EXCHANGE_RATE_LIMIT_MAX: '1000',
      TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS: '60',
      BODY_LIMIT_BYTES: '1048576',
      BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: '1000',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  async function newCookie(): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Guard Wiring',
      email: `guard-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Guard Wiring Org ${suffix}`,
      organizationSlug: `guard-wiring-${suffix}`,
      ip: randomIp(),
    });
    return (await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN }))
      .cookie;
  }

  it('The health route answers GET /healthz unauthenticated with only a status (Q33)', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  }, 60_000);

  it('helmet is active on the production app: security headers and HSTS are sent, no CSP', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  }, 60_000);

  it('CORS is active on the production app: an allowed origin is echoed with credentials, a disallowed one gets nothing', async () => {
    const allowed = await app.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: ORIGIN },
    });
    const denied = await app.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect(denied.headers['access-control-allow-credentials']).toBeUndefined();
  }, 60_000);

  it('CSRF protection is active on the production app: a mutating /v1 request without the header is 403 and does not run', async () => {
    const cookie = await newCookie();
    const identifier = `csrf-${randomUUID().slice(0, 8)}`;
    const payload = JSON.stringify({
      identifier,
      title: { en: 'Csrf' },
      schema: { properties: {}, required: [] },
    });
    const headers = { cookie, 'content-type': 'application/json', origin: ORIGIN };

    const rejected = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers,
      payload,
    });
    const accepted = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: { ...headers, ...csrfHeaders('POST') },
      payload,
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode, 'the same request with the header is accepted').toBe(200);
  }, 60_000);

  it.each([
    '/api/auth/organization/invite-member',
    '/api/auth/organization/create',
    '/api/auth/api-key/create',
    '/api/auth/sign-up/email',
  ])(
    'The route allowlist is active on the production app: %s is a plain 404',
    async (url) => {
      const cookie = await newCookie();
      const unknown = await app.app.inject({
        method: 'POST',
        url: `/api/auth/definitely-not-a-route-${randomUUID()}`,
        headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        payload: '{}',
      });

      const blocked = await app.app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        payload: '{}',
      });

      expect(blocked.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(blocked.headers['content-type']).toEqual(unknown.headers['content-type']);
    },
    60_000,
  );

  it('Repeated failed two-factor verifications are rate-limited on the production app', async () => {
    const ip = randomIp();
    const verify = () =>
      app.app.inject({
        method: 'POST',
        url: '/api/auth/two-factor/verify-totp',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          'x-forwarded-for': ip,
        },
        payload: JSON.stringify({ code: '000000' }),
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await verify()).statusCode).not.toBe(429);
    }

    const limited = await verify();

    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
  }, 60_000);

  it('Repeated wrong-password sign-ins are rate-limited on the production app', async () => {
    const ip = randomIp();
    const email = `nobody-${randomUUID()}@example.test`;
    const send = () =>
      app.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          'x-forwarded-for': ip,
        },
        payload: JSON.stringify({ email, password: `wrong-${randomUUID()}` }),
      });
    for (let i = 0; i < MAX; i += 1) {
      expect((await send()).statusCode).not.toBe(429);
    }

    const limited = await send();

    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
  }, 60_000);
});

/**
 * Task 23.11 (design Q39, D20, D13): a minimal production environment (no limit
 * variables at all) still has every limiter and the body limit active, and an
 * invalid override fails startup.
 *
 * ## Production symbols expected
 *
 * `loadConfig` supplies enabled defaults for the pre-auth sign-in, per-principal
 * and token-exchange limiters and the body limit, so `createAppFromEnv` always
 * forwards them. The design states no numeric values, so bursts here use
 * generous ceilings (sign-in 200, others 2000 requests in a minute); a default
 * above these would fail the test and must then be reported.
 */
describe('production app wiring: minimal environment keeps every limiter active (task 23.11, Q39)', () => {
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

  async function firstLimited(
    ceiling: number,
    send: () => Promise<{ statusCode: number }>,
  ): Promise<number | undefined> {
    for (let i = 1; i <= ceiling; i += 1) {
      if ((await send()).statusCode === 429) {
        return i;
      }
    }
    return undefined;
  }

  it('the pre-auth sign-in limiter is active with no limit variables set', async () => {
    const ip = randomIp();
    const email = `nobody-${randomUUID()}@example.test`;
    const limitedAt = await firstLimited(200, () =>
      app.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          'x-forwarded-for': ip,
        },
        payload: JSON.stringify({ email, password: `wrong-${randomUUID()}` }),
      }),
    );
    expect(limitedAt, 'a 429 within the ceiling').toBeDefined();
  }, 120_000);

  it('the token-exchange limiter is active with no limit variables set', async () => {
    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;
    const limitedAt = await firstLimited(2000, () =>
      app.app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-forwarded-for': ip,
          ...csrfHeaders('POST'),
        },
        payload: JSON.stringify({ clientId, clientSecret: `wrong-${randomUUID()}` }),
      }),
    );
    expect(limitedAt, 'a 429 within the ceiling').toBeDefined();
  }, 120_000);

  it('the per-principal limiter is active with no limit variables set', async () => {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Default Limits',
      email: `default-limits-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Default Limits Org ${suffix}`,
      organizationSlug: `default-limits-${suffix}`,
      ip: randomIp(),
    });
    const limitedAt = await firstLimited(2000, () =>
      app.app.inject({
        method: 'GET',
        url: `/v1/blueprints/limits-probe-${randomUUID()}`,
        headers: { cookie: tenant.cookie },
      }),
    );
    expect(limitedAt, 'a 429 within the ceiling').toBeDefined();
  }, 120_000);

  it('the body limit is active with no BODY_LIMIT_BYTES set', async () => {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Default Body',
      email: `default-body-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Default Body Org ${suffix}`,
      organizationSlug: `default-body-${suffix}`,
      ip: randomIp(),
    });
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie: tenant.cookie,
        'content-type': 'application/json',
        origin: ORIGIN,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({
        identifier: `big-${randomUUID().slice(0, 8)}`,
        title: { en: 'x'.repeat(64 * 1024 * 1024) },
        schema: { properties: {}, required: [] },
      }),
    });
    expect(response.statusCode).toBe(413);
  }, 120_000);
});

describe('production app wiring: invalid limit overrides fail startup (task 23.11, Q39)', () => {
  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  }, 60_000);

  afterAll(() => {
    state.pools.clear();
  });

  it.each([
    ['PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX', '0'],
    ['RATE_LIMIT_MAX', 'off'],
    ['TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS', '-1'],
    ['BODY_LIMIT_BYTES', '0'],
  ])(
    '%s=%j fails startup naming the variable',
    async (name, value) => {
      const outcome = await createAppFromEnv({ ...ENV, [name]: value }).then(
        async (started) => {
          await started.close();
          return 'started';
        },
        (error: unknown) => (error instanceof Error ? error.message : 'non-error rejection'),
      );
      expect(outcome, 'startup fails instead of starting').not.toBe('started');
      expect(outcome).toContain(name);
    },
    60_000,
  );
});

/**
 * Task 24.12 (design Q39, Q52, D20): `createAppFromEnv` enables the
 * password-check limiter of 24.2 (`rateLimit.passwordCheck`) from
 * `Config.preAuthPasswordCheckRateLimit`, by default and tuned by
 * `PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX` / `_WINDOW_SECONDS`. Repeated wrong
 * passwords on `/verify-password` are answered `429 AUTH_RATE_LIMITED`.
 * Requests carry a fresh random `x-forwarded-for`, so the per-user bucket is
 * what limits (the IP bucket never reaches its ceiling).
 *
 * Production symbols expected: `createAppFromEnv` forwards
 * `preAuthRateLimit.passwordCheck` to `createApp`.
 */
describe('production app wiring: password-check limiter (task 24.12, Q39, Q52)', () => {
  const MAX = 2;

  async function verifyWrongPassword(app: App, cookie: string) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/verify-password',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        cookie,
      },
      payload: JSON.stringify({ password: `wrong-${randomUUID()}` }),
    });
  }

  async function signedInCookie(app: App): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Password Check Wiring',
      email: `pwcheck-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Password Check Wiring Org ${suffix}`,
      organizationSlug: `pwcheck-wiring-${suffix}`,
      ip: randomIp(),
    });
    return tenant.cookie;
  }

  describe('with the limit tuned by the environment', () => {
    let app: App;

    beforeAll(async () => {
      const { appPool, authPool } = await harnessPools();
      state.pools.set('app', appPool);
      state.pools.set('auth', authPool);
      app = await createAppFromEnv({
        ...ENV,
        PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX: String(MAX),
        PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_WINDOW_SECONDS: '60',
      });
    }, 60_000);

    afterAll(async () => {
      await app.close();
      state.pools.clear();
    }, 60_000);

    it('Repeated wrong passwords on /verify-password are answered 429 AUTH_RATE_LIMITED', async () => {
      const cookie = await signedInCookie(app);
      for (let i = 0; i < MAX; i += 1) {
        expect((await verifyWrongPassword(app, cookie)).statusCode).not.toBe(429);
      }

      const limited = await verifyWrongPassword(app, cookie);

      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('with no password-check variable set', () => {
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

    it('the password-check limiter is active by default', async () => {
      const cookie = await signedInCookie(app);
      let limitedAt: number | undefined;
      for (let i = 1; i <= 200 && limitedAt === undefined; i += 1) {
        if ((await verifyWrongPassword(app, cookie)).statusCode === 429) {
          limitedAt = i;
        }
      }
      expect(limitedAt, 'a 429 within the ceiling').toBeDefined();
    }, 120_000);
  });
});

/**
 * Task 25.3 (design Q62, D6): outside test, startup fails when the role behind
 * `DATABASE_URL` or `AUTH_DATABASE_URL` is a superuser, has `BYPASSRLS`, or
 * owns a catalog table. The task cites no spec scenario; the behavior comes
 * from design Q62 and D6 (`tayzu_app` and `tayzu_auth` own nothing and bypass
 * nothing).
 *
 * ## Harness
 *
 * "Outside test" is `NODE_ENV=production` in the passed env (the signal
 * `config.ts`/`telemetry.ts` already use); the rest of the production
 * environment is complete (https `BETTER_AUTH_URL` and origins, telemetry
 * explicitly disabled). `createPool` is mocked as above, so the pool the
 * bootstrap receives stands for the role behind each URL; each pool is a real
 * connection as that role:
 * - `tayzu_app` / `tayzu_auth`: pools running `SET ROLE` to them (the harness
 *   pattern), so `current_user` is the role.
 * - A role that bypasses RLS: the plain `DATABASE_URL` owner pool. That role
 *   is a superuser in CI and `BYPASSRLS` (not a superuser) in the sandbox, so
 *   the superuser and BYPASSRLS tests use the same pool and each fails startup
 *   in whichever way the cluster makes that role privileged.
 * - A role owning catalog tables: a pool running `SET ROLE tayzu_migrator`
 *   (owns the catalog tables; neither superuser nor BYPASSRLS).
 * The check must therefore judge `current_user`, not the login role.
 *
 * "No listener bound" is observed through `start` (main.ts) on a pre-picked
 * free port that must still refuse connections. The URL passwords are
 * distinctive, and the error must not contain them, the host or any URL.
 *
 * ## Production symbols expected
 *
 * `createAppFromEnv` (`./bootstrap.js`) rejects, when `NODE_ENV` is not `test`
 * and before `createApp` or any listener, with an `Error` whose message holds
 * no connection string, password or host, if either pool's current role is a
 * superuser, has `BYPASSRLS`, or owns a catalog table. The pools it opened are
 * closed (`end`) on that failure. It is a startup check in the same spirit as
 * the ones in `config.ts`/`telemetry.ts`; no migration.
 *
 * ## Why this fails right now
 *
 * Nothing inspects the roles, so `createAppFromEnv` starts with a privileged
 * role behind either URL (assertion failure: "started"). The `tayzu_app` and
 * `tayzu_auth` test already passes.
 */
describe('production app wiring: runtime database roles are checked at startup (task 25.3, Q62, D6)', () => {
  const APP_PASSWORD = `app-pw-${randomUUID()}`;
  const AUTH_PASSWORD = `auth-pw-${randomUUID()}`;
  const PRODUCTION_ENV: Record<string, string> = {
    ...ENV,
    DATABASE_URL: `postgres://tayzu_app:${APP_PASSWORD}@db.invalid:5432/tayzu?sslmode=verify-full`,
    AUTH_DATABASE_URL: `postgres://tayzu_auth:${AUTH_PASSWORD}@db.invalid:5432/tayzu?sslmode=verify-full`,
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'none',
    BETTER_AUTH_URL: 'https://api.tayzu.test',
    TAYZU_TELEMETRY_DISABLED: 'true',
  };

  let appRole: import('pg').Pool;
  let authRole: import('pg').Pool;
  let migratorRole: import('pg').Pool;
  let bypassingRole: import('pg').Pool;
  const ownPools: import('pg').Pool[] = [];

  function poolAs(role: string | undefined): import('pg').Pool {
    const pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
    if (role !== undefined) {
      pool.on('connect', (client) => {
        void client.query(`SET ROLE ${role}`).catch(() => undefined);
      });
    }
    ownPools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    const { authPool } = await harnessPools();
    bypassingRole = authPool;
    // Test-only: the cluster role may only inherit tayzu_auth; acting as it needs the SET option.
    await authPool.query(
      `do $$ begin execute format('grant tayzu_auth to %I with set true', current_user); end $$`,
    );
    appRole = poolAs('tayzu_app');
    authRole = poolAs('tayzu_auth');
    migratorRole = poolAs('tayzu_migrator');
    for (const [pool, expected] of [
      [appRole, 'tayzu_app'],
      [authRole, 'tayzu_auth'],
      [migratorRole, 'tayzu_migrator'],
    ] as const) {
      const row = await pool.query<{ current_user: string }>('select current_user');
      expect(row.rows[0]?.current_user, 'precondition: the pool acts as the role').toBe(expected);
    }
  }, 60_000);

  afterAll(async () => {
    state.pools.clear();
    await Promise.all(ownPools.map((pool) => pool.end()));
  }, 60_000);

  async function startOutcome(): Promise<{ started: boolean; message: string }> {
    return createAppFromEnv(PRODUCTION_ENV).then(
      async (app) => {
        await app.close();
        return { started: true, message: '' };
      },
      (error: unknown) => ({
        started: false,
        message: error instanceof Error ? error.message : 'non-error rejection',
      }),
    );
  }

  function expectSanitized(message: string): void {
    expect(message).not.toBe('');
    expect(message).not.toBe('non-error rejection');
    expect(message).not.toContain(APP_PASSWORD);
    expect(message).not.toContain(AUTH_PASSWORD);
    expect(message).not.toContain('db.invalid');
    expect(message).not.toContain('postgres://');
  }

  it.each([
    ['DATABASE_URL', 'app'],
    ['AUTH_DATABASE_URL', 'auth'],
  ] as const)(
    'a superuser role behind %s fails startup with a sanitized error',
    async (_variable, slot) => {
      state.pools.set('app', appRole);
      state.pools.set('auth', authRole);
      state.pools.set(slot, bypassingRole);

      const outcome = await startOutcome();

      expect(outcome.started, 'startup fails instead of starting').toBe(false);
      expectSanitized(outcome.message);
    },
    60_000,
  );

  it.each([
    ['DATABASE_URL', 'app'],
    ['AUTH_DATABASE_URL', 'auth'],
  ] as const)(
    'a BYPASSRLS role behind %s fails startup with a sanitized error',
    async (_variable, slot) => {
      state.pools.set('app', appRole);
      state.pools.set('auth', authRole);
      state.pools.set(slot, bypassingRole);

      const outcome = await startOutcome();

      expect(outcome.started, 'startup fails instead of starting').toBe(false);
      expectSanitized(outcome.message);
    },
    60_000,
  );

  it.each([
    ['DATABASE_URL', 'app'],
    ['AUTH_DATABASE_URL', 'auth'],
  ] as const)(
    'a role owning a catalog table behind %s fails startup with a sanitized error',
    async (_variable, slot) => {
      state.pools.set('app', appRole);
      state.pools.set('auth', authRole);
      state.pools.set(slot, migratorRole);

      const outcome = await startOutcome();

      expect(outcome.started, 'startup fails instead of starting').toBe(false);
      expectSanitized(outcome.message);
    },
    60_000,
  );

  it('a failed role check binds no listener', async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        resolve((probe.address() as { port: number }).port);
      });
    });
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    state.pools.set('app', bypassingRole);
    state.pools.set('auth', authRole);
    const { start } = await import('./main.js');

    const outcome = await start({ ...PRODUCTION_ENV, HOST: '127.0.0.1', PORT: String(port) }).then(
      async (server) => {
        await server.close();
        return 'started';
      },
      (error: unknown) => (error instanceof Error ? error.message : 'non-error rejection'),
    );

    expect(outcome, 'startup fails instead of starting').not.toBe('started');
    expectSanitized(outcome);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        resolve(true);
      });
    });
    expect(refused, 'nothing listens on the configured port').toBe(true);
  }, 60_000);

  it('tayzu_app and tayzu_auth start normally', async () => {
    state.pools.set('app', appRole);
    state.pools.set('auth', authRole);

    const outcome = await startOutcome();

    expect(outcome, 'startup succeeds with the two runtime roles').toEqual({
      started: true,
      message: '',
    });
  }, 60_000);
});
