/**
 * Integration test for task 3.10 of change `003-catalog-ui-core` (design D11 "The
 * re-authorization redirect", Resolved decision Q14; `specs/catalog-ui-core/spec.md`).
 *
 * Scenario (verbatim):
 * - "The callback redirect is fixed": GIVEN the API is started with a build directory,
 *   WHEN the re-authorization callback completes successfully, fails, or is refused by
 *   its rate limit, THEN it answers `303` to `/step-up/complete`,
 *   `/step-up/complete?result=failed` or `/step-up/complete?result=rate_limited`,
 *   whatever the request carried.
 *
 * Task 3.10 adds: `Retry-After` is kept on the rate-limited redirect, and without the web
 * app every answer is unchanged (`200 {}`, the `400` body, the JSON `429`).
 *
 * ## Harness
 *
 * Two apps built with `createApp` over the harness pools, with SSO pointed at the local
 * OIDC stub so the callback route is mounted: one with `webDistDir` set to the committed
 * fixture `__fixtures__/web-dist/` (read only; nothing is written to it), one without.
 * The callback's limiter is set low so the rate-limit case is reachable; every test uses
 * its own random `x-forwarded-for`, so the buckets of the other cases are never touched. A successful callback is driven like
 * `step-up-sso-http.int.test.ts`: an SSO-session owner's high-risk call hands out the
 * re-authorization URL, the stub auto-approves it, and the code and state it returns reach
 * the callback as a `GET` query or as a `form_post` `POST`. A failed exchange presents a
 * real (single-use) state with a code the stub never issued.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `CreateAppOptions` (`apps/api/src/server.ts`) gains the optional
 *   `webDistDir?: string`, the absolute path of the web build (`WEB_DIST_DIR`, design D9,
 *   Q21; `createAppFromEnv` passes it from `Config` once task 4.1 adds the setting).
 * - With it set, `GET` and `POST /v1/auth/visma-connect/reauthorize/callback` answer `303`
 *   with the constant `Location` `/step-up/complete` (success),
 *   `/step-up/complete?result=failed` (any failure) or
 *   `/step-up/complete?result=rate_limited` plus `Retry-After` (the callback limiter
 *   refuses). The target is never derived from the request or the OIDC state.
 * - Without it, the answers are those of today (`server.ts:869-932`).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';
const LIMIT = 2;
const FIXTURE_WEB_DIST = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));

const COMPLETE = '/step-up/complete';
const FAILED = '/step-up/complete?result=failed';
const RATE_LIMITED = '/step-up/complete?result=rate_limited';

/** Values an attacker could plant in a callback request; none may reach `Location`. */
const EVIL_HOST = 'evil.example';
const ATTACKER_PARAMS = {
  redirect: `https://${EVIL_HOST}/steal`,
  returnTo: `//${EVIL_HOST}/steal`,
  redirect_uri: `https://${EVIL_HOST}/cb`,
} as const;
const ATTACKER_HEADERS = {
  host: EVIL_HOST,
  'x-forwarded-host': EVIL_HOST,
  'x-forwarded-proto': 'http',
} as const;

type Method = 'GET' | 'POST';
type Injected = Awaited<ReturnType<App['app']['inject']>>;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

let stub: OidcStub;
let pools: Awaited<ReturnType<typeof harnessPools>>;

async function buildApp(withWeb: boolean): Promise<App> {
  return createApp({
    appPool: pools.appPool,
    authPool: pools.authPool,
    authSecret: TEST_SECRET,
    cerbosAddress: 'localhost:3593',
    allowedOrigins: [ORIGIN],
    sso: {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    },
    reauthorizationCallbackRateLimit: { max: LIMIT, window: 60 },
    ...(withWeb ? { webDistDir: FIXTURE_WEB_DIST } : {}),
  });
}

beforeAll(async () => {
  pools = await harnessPools();
  stub = await startOidcStub();
}, 60_000);

afterAll(async () => {
  await stub.close();
}, 60_000);

/** Drives one app: the SSO session, the started re-authorization and the callback. */
function driver(getApp: () => App) {
  /** An org owner whose session was established through Visma Connect (`sso_sid` set). */
  async function ssoSessionUser(): Promise<{ cookie: string; sid: string }> {
    const app = getApp();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Reauth Redirect User',
      email: `reauth-redirect-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Reauth Redirect Org',
      organizationSlug: `reauth-redirect-${randomUUID()}`,
      ip: randomIp(),
    });
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    const sid = `sid-${randomUUID()}`;
    await pools.authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      tenant.userId,
    ]);
    return { cookie, sid };
  }

  /** A high-risk call; the step-up interceptor runs first, so the blueprint need not exist. */
  function highRiskCall(cookie: string): Promise<Injected> {
    return getApp().app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/reauth-redirect-${randomUUID().slice(0, 8)}`,
      headers: { cookie, origin: ORIGIN, 'x-forwarded-for': randomIp(), ...csrfHeaders('DELETE') },
    });
  }

  /**
   * Starts a re-authorization for a fresh SSO session with qualifying claims and lets the
   * stub approve it. Returns the code and state the stub sends back, and the session.
   */
  async function approvedReauthorization(): Promise<{
    code: string;
    state: string;
    cookie: string;
  }> {
    const user = await ssoSessionUser();
    stub.setSubject({
      sub: `reauth-redirect-sub-${randomUUID()}`,
      sid: user.sid,
      claims: { auth_time: Math.floor(Date.now() / 1000) - 5, acr: 3, amr: ['pwd', 'otp'] },
    });
    const refused = await highRiskCall(user.cookie);
    expect(refused.statusCode, refused.body).toBe(403);
    const raw = refused.json<{ data?: { reauthorizationUrl?: unknown } }>().data
      ?.reauthorizationUrl;
    if (typeof raw !== 'string') {
      throw new Error('precondition: the step-up refusal carries data.reauthorizationUrl');
    }
    const approval = await fetch(raw, { redirect: 'manual' });
    const location = approval.headers.get('location');
    if (location === null) {
      throw new Error('precondition: the OIDC stub redirects back with the code');
    }
    const back = new URL(location);
    const code = back.searchParams.get('code');
    const state = back.searchParams.get('state');
    if (code === null || state === null) {
      throw new Error('precondition: the stub returned a code and a state');
    }
    return { code, state, cookie: user.cookie };
  }

  /** The callback, as the browser lands on it: a query `GET` or a `form_post` `POST`. */
  function callback(
    method: Method,
    params: Readonly<Record<string, string>>,
    options: { readonly ip?: string; readonly headers?: Readonly<Record<string, string>> } = {},
  ): Promise<Injected> {
    const encoded = new URLSearchParams(params).toString();
    const headers = {
      'x-forwarded-for': options.ip ?? randomIp(),
      origin: ORIGIN,
      ...options.headers,
    };
    return method === 'GET'
      ? getApp().app.inject({ method: 'GET', url: `${CALLBACK_PATH}?${encoded}`, headers })
      : getApp().app.inject({
          method: 'POST',
          url: CALLBACK_PATH,
          headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
          payload: encoded,
        });
  }

  /** Exhausts the callback bucket of one IP, then returns the first refused answer. */
  async function refusedByLimit(
    method: Method,
    extra: Readonly<Record<string, string>> = {},
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Injected> {
    const ip = randomIp();
    for (let i = 0; i < LIMIT; i += 1) {
      await callback(method, { code: 'c', state: `unknown-${randomUUID()}` }, { ip });
    }
    return callback(
      method,
      { code: 'c', state: `unknown-${randomUUID()}`, ...extra },
      {
        ip,
        headers,
      },
    );
  }

  /** After a successful callback the session passes step-up: the call is past the guard. */
  async function expectStepUpSatisfied(cookie: string): Promise<void> {
    const retried = await highRiskCall(cookie);
    expect(retried.statusCode, 'the re-authorization was recorded').not.toBe(403);
  }

  return { approvedReauthorization, callback, refusedByLimit, expectStepUpSatisfied };
}

function expectFixedRedirect(response: Injected, target: string): void {
  expect(response.statusCode, response.body).toBe(303);
  const location = response.headers.location;
  expect(location).toBe(target);
  expect(typeof location === 'string' && location.startsWith('/')).toBe(true);
  expect(typeof location === 'string' && location.startsWith('//')).toBe(false);
  expect(String(location)).not.toContain(EVIL_HOST);
}

describe('The callback redirect is fixed (task 3.10, design D11, Q14): with a build directory', () => {
  let app: App;
  const drive = driver(() => app);

  beforeAll(async () => {
    app = await buildApp(true);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it.each(['GET', 'POST'] as const)(
    'a successful callback answers 303 to /step-up/complete (%s)',
    async (method) => {
      const { code, state, cookie } = await drive.approvedReauthorization();

      const response = await drive.callback(method, { code, state });

      expectFixedRedirect(response, COMPLETE);
      await drive.expectStepUpSatisfied(cookie);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback with an unknown state answers 303 to /step-up/complete?result=failed (%s)',
    async (method) => {
      const response = await drive.callback(method, {
        code: 'c',
        state: `unknown-${randomUUID()}`,
      });

      expectFixedRedirect(response, FAILED);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback whose token exchange fails answers 303 to /step-up/complete?result=failed (%s)',
    async (method) => {
      const { state } = await drive.approvedReauthorization();

      // A real, unconsumed state, but a code the stub never issued: the exchange fails.
      const response = await drive.callback(method, { code: `not-issued-${randomUUID()}`, state });

      expectFixedRedirect(response, FAILED);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback refused by its rate limit answers 303 to /step-up/complete?result=rate_limited with Retry-After (%s)',
    async (method) => {
      const refused = await drive.refusedByLimit(method);

      expectFixedRedirect(refused, RATE_LIMITED);
      expect(refused.headers['retry-after']).toMatch(/^\d+$/);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a successful callback carrying redirect, returnTo and a Host value still answers the fixed path (%s)',
    async (method) => {
      const { code, state } = await drive.approvedReauthorization();

      const response = await drive.callback(
        method,
        { code, state, ...ATTACKER_PARAMS },
        { headers: ATTACKER_HEADERS },
      );

      expectFixedRedirect(response, COMPLETE);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a failed callback carrying redirect, returnTo and a Host value still answers the fixed path (%s)',
    async (method) => {
      const response = await drive.callback(
        method,
        { code: 'c', state: `unknown-${randomUUID()}`, ...ATTACKER_PARAMS },
        { headers: ATTACKER_HEADERS },
      );

      expectFixedRedirect(response, FAILED);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a rate-limited callback carrying redirect, returnTo and a Host value still answers the fixed path (%s)',
    async (method) => {
      const refused = await drive.refusedByLimit(method, ATTACKER_PARAMS, ATTACKER_HEADERS);

      expectFixedRedirect(refused, RATE_LIMITED);
      expect(refused.headers['retry-after']).toMatch(/^\d+$/);
    },
    60_000,
  );
});

describe('Without the web app the callback answers are unchanged (task 3.10, design D11)', () => {
  let app: App;
  const drive = driver(() => app);

  beforeAll(async () => {
    app = await buildApp(false);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it.each(['GET', 'POST'] as const)(
    'a successful callback answers 200 {} with no Location (%s)',
    async (method) => {
      const { code, state, cookie } = await drive.approvedReauthorization();

      const response = await drive.callback(method, { code, state });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({});
      expect(response.headers.location).toBeUndefined();
      await drive.expectStepUpSatisfied(cookie);
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback with an unknown state answers the 400 body with no Location (%s)',
    async (method) => {
      const response = await drive.callback(method, {
        code: 'c',
        state: `unknown-${randomUUID()}`,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({ defined: false, code: 'BAD_REQUEST', status: 400 });
      expect(response.headers.location).toBeUndefined();
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback whose token exchange fails answers the 400 body with no Location (%s)',
    async (method) => {
      const { state } = await drive.approvedReauthorization();

      const response = await drive.callback(method, { code: `not-issued-${randomUUID()}`, state });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({ defined: false, code: 'BAD_REQUEST', status: 400 });
      expect(response.headers.location).toBeUndefined();
    },
    60_000,
  );

  it.each(['GET', 'POST'] as const)(
    'a callback refused by its rate limit answers the JSON 429 with Retry-After and no Location (%s)',
    async (method) => {
      const refused = await drive.refusedByLimit(method);

      expect(refused.statusCode, refused.body).toBe(429);
      expect(refused.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
      expect(refused.headers['retry-after']).toMatch(/^\d+$/);
      expect(refused.headers.location).toBeUndefined();
    },
    60_000,
  );
});
