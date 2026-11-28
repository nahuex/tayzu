/**
 * Integration test for task 23.7 (openspec/changes/archive/2026-10-15-002-auth-and-rbac; design
 * Resolved decision Q35 and D26; `specs/auth-and-rbac/spec.md`, requirement
 * "Back-channel logout from Visma Connect revokes the matching sessions").
 *
 * Scenario covered (verbatim from the spec):
 *
 * - "A valid logout token revokes the matching session": GIVEN an active Tayzu
 *   session established through Visma Connect, WHEN a valid back-channel logout
 *   token naming that session's Visma Connect session id is received, THEN that
 *   session fails exactly as `CATALOG_CONTEXT_REQUIRED` on its next use.
 *
 * Task 23.7: the session is created by the REAL SSO sign-in of 23.6 (no
 * `update auth.session set sso_sid`), through Fastify on the app built by the
 * production bootstrap (`createAppFromEnv`), with SSO pointed at the task-19.1
 * local OIDC stub. A same-user local session must stay valid.
 *
 * ## Production symbols expected
 *
 * - The Visma sign-in stores the ID token `sid` in `auth.session.sso_sid`
 *   (task 23.5), the callback works over Fastify (task 23.6), and the SSO
 *   session resolves a catalog context (`GET /v1/blueprints` answers 200).
 * - `POST /v1/auth/visma-connect/backchannel-logout` (task 22.x) revokes that
 *   session. If the whole scenario already passes, the earlier tasks already
 *   deliver 23.7 and no production change is needed.
 *
 * # Task 7.3 of `openspec/changes/048-production-hardening` (design D7, Resolved decision Q11)
 *
 * Scenario (verbatim from `specs/auth-and-rbac/spec.md` of the change, MODIFIED requirement
 * "Pre-authentication rate limiting protects against credential stuffing"):
 *
 * "The back-channel logout budget is shared across replicas"
 * - GIVEN two running replicas over the same database
 * - WHEN one caller address exceeds the back-channel logout limit across both
 * - THEN further deliveries from it fail with `AUTH_RATE_LIMITED` before any token is verified
 *
 * Requirement text: "Exceeding any of these limits MUST fail with `AUTH_RATE_LIMITED` and a
 * `Retry-After` header".
 *
 * Design D7: "The route's `config.rateLimit` becomes the same pre-handler with scope
 * `backchannel_logout`, kind `ip`, and the existing `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`
 * (600 per 60 s). It still runs before any token verification." The pre-handler is
 * `createAcceptRateLimitPreHandler` over `createRateLimitBucketStore` (the `auth.rate_limit`
 * table, hashed keys), as token exchange uses since tasks 7.1 and 7.2. Observability contract:
 * `RateLimitScope` gains `backchannel_logout`.
 *
 * ## Harness (task 7.3)
 *
 * Two apps built by the production bootstrap (`createAppFromEnv`, which builds `createApp`)
 * from one environment with a small `BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE`, both over the
 * harness pools (the `@tayzu/db` mock below), so over one database. Fresh random caller
 * addresses (`X-Forwarded-For` from the loopback peer, trusted by `TEST_TRUST_PROXY`) keep
 * every test in its own bucket. "Before any token is verified" is observed as zero discovery
 * and JWKS fetches (`globalThis.fetch`, the verifier's only outbound path, filtered to the
 * stub's origin, as `backchannel-logout.int.test.ts` task 13.11 does), as no replay record for
 * the refused token's `jti` and as no session revoked, with a control from a fresh address
 * that does fetch and revoke. The existing outcomes (`revoked`, `replay`, `no_match`,
 * `invalid`) are observed through their database effects, split across both replicas.
 *
 * ## Production symbols expected (task 7.3)
 *
 * - `RateLimitScope` gains `'backchannel_logout'` (in
 *   `packages/auth/src/rate-limit/pre-auth-rate-limit.ts`); this file's
 *   `hashBucketKey('backchannel_logout', 'ip', ...)` only typechecks once it exists.
 * - A refusal answers the mapped `AUTH_RATE_LIMITED` error the pre-handler sends
 *   (`new ORPCError('AUTH_RATE_LIMITED', { status: 429, message: 'Too many requests' }).toJSON()`,
 *   the body token exchange answers) with `Retry-After` a positive integer number of seconds
 *   within the window, as the route's `Retry-After` is today.
 *
 * ## Why the task 7.3 case fails right now
 *
 * The route's limiter is `@fastify/rate-limit` per-replica memory: two deliveries on each
 * replica leave each replica's bucket at half the budget, so the fifth delivery is not
 * refused, and no `auth.rate_limit` row is written.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { ORPCError } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { hashBucketKey } from '../../../packages/auth/src/rate-limit/pre-auth-rate-limit.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const poolState = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

// `createPool` hands out the harness pools (production URLs need
// `sslmode=verify-full`); `end` is a no-op so the shared pools survive.
vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const real = poolState.pools.get(url.includes('tayzu_auth') ? 'auth' : 'app') as object;
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

const ORIGIN = 'http://localhost:3000';
const PROVIDER_ID = 'visma-connect';
const ROUTE = '/v1/auth/visma-connect/backchannel-logout';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

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

describe('back-channel logout over HTTP after a real SSO sign-in (task 23.7, design Q35, D26)', () => {
  let app: App;
  let stub: OidcStub;
  let pools: Awaited<ReturnType<typeof harnessPools>>;

  beforeAll(async () => {
    pools = await harnessPools();
    poolState.pools.set('app', pools.appPool);
    poolState.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    poolState.pools.clear();
  }, 60_000);

  function post(url: string, headers: Record<string, string>, payload: string) {
    return app.app.inject({
      method: 'POST',
      url,
      headers: {
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        ...headers,
      },
      payload,
    });
  }

  /** Runs the whole SSO round trip through Fastify; returns the final response. */
  async function ssoSignIn(): Promise<Awaited<ReturnType<typeof post>>> {
    const initiated = await post(
      '/api/auth/sign-in/social',
      { 'content-type': 'application/json' },
      JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    );
    expect(initiated.statusCode, initiated.body).toBe(200);
    const { url } = initiated.json<{ url: string }>();
    const page = await (await fetch(url, { redirect: 'manual' })).text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const code = inputs['code'];
    const state = inputs['state'];
    if (code === undefined || state === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state,
      ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
    });
    const cookie = cookieFrom(initiated.headers['set-cookie']);
    const posted = await post(
      `/api/auth/callback/${PROVIDER_ID}`,
      {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
      },
      params.toString(),
    );
    const location = posted.headers.location;
    if (
      posted.statusCode >= 300 &&
      posted.statusCode < 400 &&
      typeof location === 'string' &&
      new URL(location, ORIGIN).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      const target = new URL(location, ORIGIN);
      return app.app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: {
          'x-forwarded-for': randomIp(),
          host: 'localhost:3000',
          ...(cookie === '' ? {} : { cookie }),
        },
      });
    }
    return posted;
  }

  function useSession(cookie: string) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie, 'x-forwarded-for': randomIp() },
    });
  }

  function logoutClaims(sid: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `bcl-http-sub-${randomUUID()}`,
      sid,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      events: { [LOGOUT_EVENT]: {} },
    };
  }

  it('A valid logout token revokes the matching session: the cookie of the real SSO sign-in fails as CATALOG_CONTEXT_REQUIRED while a same-user local session stays valid', async () => {
    const suffix = randomUUID();
    const email = `bcl-http-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Backchannel Http Person',
      email,
      password: TEST_PASSWORD,
      organizationName: `Backchannel Http Org ${suffix}`,
      organizationSlug: `bcl-http-${suffix}`,
      ip: randomIp(),
    });
    // Q43: an unenrolled admin/owner is limited to MFA enrollment on /v1, so enroll TOTP first.
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const sub = `bcl-http-link-${suffix}`;
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    const sid = `sid-${randomUUID()}`;
    stub.setSubject({ sub, email: `other-${suffix}@example.test`, name: 'Linked', sid });

    // GIVEN an active session established through Visma Connect (real sign-in).
    const signedIn = await ssoSignIn();
    expect(signedIn.statusCode, signedIn.body).toBeLessThan(400);
    const ssoCookie = cookieFrom(signedIn.headers['set-cookie']);
    expect(ssoCookie, 'a session cookie is issued').toContain('session_token');
    const stored = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1 and sso_sid = $2',
      [tenant.userId, sid],
    );
    expect(Number(stored.rows[0]?.n ?? 0), 'the SSO session carries the token sid').toBe(1);

    // AND a same-user local session.
    const localCookie = await signInWithTotp(app, {
      email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    const localSessions = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1 and sso_sid is null',
      [tenant.userId],
    );
    expect(
      Number(localSessions.rows[0]?.n ?? 0),
      'the local session belongs to the same user',
    ).toBeGreaterThan(0);

    expect((await useSession(ssoCookie)).statusCode, 'the SSO session works before').toBe(200);
    expect((await useSession(localCookie)).statusCode, 'the local session works before').toBe(200);

    // WHEN a valid back-channel logout token naming that sid is received.
    const response = await app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: new URLSearchParams({
        logout_token: stub.signJwt(logoutClaims(sid), { typ: 'logout+jwt' }),
      }).toString(),
    });
    expect(response.statusCode).toBe(200);

    // THEN the SSO session fails exactly as CATALOG_CONTEXT_REQUIRED.
    const revoked = await useSession(ssoCookie);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect((await useSession(localCookie)).statusCode, 'the local session stays valid').toBe(200);
  }, 60_000);
});

/** Even, so that "half of the limit on each replica" is exact. */
const BACKCHANNEL_MAX = 4;
const BACKCHANNEL_WINDOW_SECONDS = 60;

/** The body the shared pre-handler answers over budget (`identity/accept-rate-limit.ts`). */
const EXPECTED_LIMITED_BODY: unknown = JSON.parse(
  JSON.stringify(
    new ORPCError('AUTH_RATE_LIMITED', { status: 429, message: 'Too many requests' }).toJSON(),
  ),
);

/** Same header, same signature, another payload: the signature no longer verifies. */
function tamperPayload(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('not a compact JWS');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  const tampered = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
  return `${header}.${tampered}.${signature}`;
}

describe('back-channel logout shares one budget across replicas (048 task 7.3, design D7, Q11)', () => {
  let replicaA: App;
  let replicaB: App;
  let stub: OidcStub;
  let pools: Awaited<ReturnType<typeof harnessPools>>;

  function environment(): Record<string, string> {
    return {
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
      BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: String(BACKCHANNEL_MAX),
    };
  }

  beforeAll(async () => {
    pools = await harnessPools();
    poolState.pools.set('app', pools.appPool);
    poolState.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    // GIVEN two running replicas over the same database.
    replicaA = await createAppFromEnv(environment());
    replicaB = await createAppFromEnv(environment());
  }, 60_000);

  afterAll(async () => {
    await replicaA.close();
    await replicaB.close();
    await stub.close();
    poolState.pools.clear();
  }, 60_000);

  function postOn(app: App, url: string, headers: Record<string, string>, payload: string) {
    return app.app.inject({
      method: 'POST',
      url,
      headers: {
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        ...headers,
      },
      payload,
    });
  }

  function deliver(app: App, logoutToken: string, ip: string) {
    return app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      payload: new URLSearchParams({ logout_token: logoutToken }).toString(),
    });
  }

  /** The SSO round trip of the 23.7 suite above, through Fastify on `app`. */
  async function ssoSignInOn(app: App): Promise<void> {
    const initiated = await postOn(
      app,
      '/api/auth/sign-in/social',
      { 'content-type': 'application/json' },
      JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    );
    expect(initiated.statusCode, initiated.body).toBe(200);
    const { url } = initiated.json<{ url: string }>();
    const page = await (await fetch(url, { redirect: 'manual' })).text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const code = inputs['code'];
    const state = inputs['state'];
    if (code === undefined || state === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state,
      ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
    });
    const cookie = cookieFrom(initiated.headers['set-cookie']);
    const posted = await postOn(
      app,
      `/api/auth/callback/${PROVIDER_ID}`,
      {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
      },
      params.toString(),
    );
    const location = posted.headers.location;
    let final = posted;
    if (
      posted.statusCode >= 300 &&
      posted.statusCode < 400 &&
      typeof location === 'string' &&
      new URL(location, ORIGIN).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      const target = new URL(location, ORIGIN);
      final = await app.app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: {
          'x-forwarded-for': randomIp(),
          host: 'localhost:3000',
          ...(cookie === '' ? {} : { cookie }),
        },
      });
    }
    expect(final.statusCode, final.body).toBeLessThan(400);
  }

  /** A tenant owner linked to a Visma Connect subject; returns the link's `sub`. */
  async function linkedUser(): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(replicaA.auth, {
      pool: testAppPool(),
      name: 'Backchannel Shared Person',
      email: `bcl-shared-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Backchannel Shared Org ${suffix}`,
      organizationSlug: `bcl-shared-${suffix}`,
      ip: randomIp(),
    });
    const sub = `bcl-shared-link-${suffix}`;
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    return sub;
  }

  /** Signs the linked subject in through Visma Connect on `app` with session id `sid`. */
  async function ssoSessionOn(app: App, sub: string, sid: string): Promise<void> {
    stub.setSubject({ sub, email: `other-${randomUUID()}@example.test`, name: 'Linked', sid });
    await ssoSignInOn(app);
    expect(await sessionsWithSid(sid), 'the SSO session carries the token sid').toBe(1);
  }

  async function sessionsWithSid(sid: string): Promise<number> {
    const result = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where sso_sid = $1',
      [sid],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async function replayRecords(jti: string): Promise<number> {
    const result = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.verification where identifier = $1',
      [`backchannel-logout:${stub.clientId}:${jti}`],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async function bucketRows(ip: string): Promise<number> {
    const result = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.rate_limit where key = $1',
      [hashBucketKey('backchannel_logout', 'ip', ip)],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  function logoutClaims(sid: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `bcl-shared-sub-${randomUUID()}`,
      sid,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      events: { [LOGOUT_EVENT]: {} },
    };
  }

  function expectLimitedAnswer(
    response: Awaited<ReturnType<typeof deliver>>,
    secrets: readonly string[],
  ): void {
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual(EXPECTED_LIMITED_BODY);
    const header = response.headers['retry-after'];
    expect(typeof header).toBe('string');
    expect(String(header)).toMatch(/^[1-9]\d*$/);
    expect(Number(header)).toBeLessThanOrEqual(BACKCHANNEL_WINDOW_SECONDS);
    for (const secret of secrets) {
      expect(response.body).not.toContain(secret);
      expect(JSON.stringify(response.headers)).not.toContain(secret);
    }
  }

  it('The back-channel logout budget is shared across replicas: further deliveries fail with AUTH_RATE_LIMITED before any token is verified', async () => {
    const ip = randomIp();
    const sub = await linkedUser();
    const sid = `sid-${randomUUID()}`;
    await ssoSessionOn(replicaA, sub, sid);
    const claims = logoutClaims(sid);
    const jti = claims['jti'] as string;
    // A token that, once verified, would revoke the session above.
    const validToken = stub.signJwt(claims, { typ: 'logout+jwt' });

    // WHEN one caller address exceeds the limit across both: half of it on each replica.
    const first = await deliver(replicaA, `x.${randomUUID()}.z`, ip);
    expect(first.statusCode, 'replica A, 0').toBe(200);
    for (let i = 1; i < BACKCHANNEL_MAX / 2; i += 1) {
      expect(
        (await deliver(replicaA, `x.${randomUUID()}.z`, ip)).statusCode,
        `replica A, ${String(i)}`,
      ).toBe(200);
    }
    for (let i = 0; i < BACKCHANNEL_MAX / 2; i += 1) {
      expect(
        (await deliver(replicaB, `x.${randomUUID()}.z`, ip)).statusCode,
        `replica B, ${String(i)}`,
      ).toBe(200);
    }

    const stubOrigin = new URL(stub.discoveryUrl).origin;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const outboundCalls = (): number =>
        fetchSpy.mock.calls.filter(([input]) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          return url.startsWith(stubOrigin);
        }).length;

      // THEN further deliveries from it fail with AUTH_RATE_LIMITED on either replica ...
      const before = outboundCalls();
      expectLimitedAnswer(await deliver(replicaA, validToken, ip), [ip, sid, validToken]);
      expectLimitedAnswer(await deliver(replicaB, validToken, ip), [ip, sid, validToken]);

      // ... before any token is verified: no discovery or JWKS fetch, no replay record, no revocation.
      expect(outboundCalls() - before, 'a refused delivery fetches no discovery or JWKS').toBe(0);
      expect(await replayRecords(jti), 'a refused delivery records no jti').toBe(0);
      expect(await sessionsWithSid(sid), 'a refused delivery revokes nothing').toBe(1);

      // The budget lives in the shared store, keyed by the address (hashed).
      expect(await bucketRows(ip), 'one shared backchannel_logout address bucket').toBe(1);

      // Control: the same token from another address is verified (it fetches) and revokes.
      const controlBefore = outboundCalls();
      const control = await deliver(replicaB, validToken, randomIp());
      expect(control.statusCode, 'another address is not affected').toBe(200);
      expect(control.body, 'the response shape is unchanged').toBe(first.body);
      expect(
        outboundCalls() - controlBefore,
        'an admitted delivery reaches discovery and the JWKS',
      ).toBeGreaterThanOrEqual(2);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await sessionsWithSid(sid), 'the admitted delivery revokes the session').toBe(0);
    expect(await replayRecords(jti), 'the admitted delivery records its jti').toBe(1);
  }, 120_000);

  it('The existing outcomes are unchanged across both replicas: revoked, replay, no_match and invalid answer the same 200', async () => {
    const sub = await linkedUser();

    // revoked, on replica A.
    const revokedSid = `sid-${randomUUID()}`;
    await ssoSessionOn(replicaA, sub, revokedSid);
    const revokedClaims = logoutClaims(revokedSid);
    const revokedToken = stub.signJwt(revokedClaims, { typ: 'logout+jwt' });
    const revoked = await deliver(replicaA, revokedToken, randomIp());
    expect(revoked.statusCode).toBe(200);
    expect(await sessionsWithSid(revokedSid), 'revoked: the matching session is gone').toBe(0);
    expect(await replayRecords(revokedClaims['jti'] as string), 'revoked: jti recorded').toBe(1);

    // replay, on replica B: the same token again revokes nothing, even a new session with that sid.
    await ssoSessionOn(replicaB, sub, revokedSid);
    const replay = await deliver(replicaB, revokedToken, randomIp());
    expect(replay.statusCode).toBe(200);
    expect(replay.body, 'replay answers like every other outcome').toBe(revoked.body);
    expect(await sessionsWithSid(revokedSid), 'replay: nothing is revoked').toBe(1);
    expect(await replayRecords(revokedClaims['jti'] as string), 'replay: one record').toBe(1);

    // no_match, on replica B: a valid token naming no session.
    const noMatchClaims = logoutClaims(`sid-missing-${randomUUID()}`);
    const noMatch = await deliver(
      replicaB,
      stub.signJwt(noMatchClaims, { typ: 'logout+jwt' }),
      randomIp(),
    );
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.body, 'no_match answers like every other outcome').toBe(revoked.body);
    expect(await replayRecords(noMatchClaims['jti'] as string), 'no_match: jti recorded').toBe(1);

    // invalid, on replica A: a tampered signature names a live session and revokes nothing.
    const invalidSid = `sid-${randomUUID()}`;
    await ssoSessionOn(replicaA, sub, invalidSid);
    const invalidClaims = logoutClaims(`sid-other-${randomUUID()}`);
    const invalidToken = tamperPayload(stub.signJwt(invalidClaims, { typ: 'logout+jwt' }), {
      sid: invalidSid,
    });
    const invalid = await deliver(replicaA, invalidToken, randomIp());
    expect(invalid.statusCode).toBe(200);
    expect(invalid.body, 'invalid answers like every other outcome').toBe(revoked.body);
    expect(await sessionsWithSid(invalidSid), 'invalid: nothing is revoked').toBe(1);
    expect(await replayRecords(invalidClaims['jti'] as string), 'invalid: no jti recorded').toBe(0);

    // A missing logout_token stays the generic 400.
    const malformed = await replicaB.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: '',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ defined: false, code: 'BAD_REQUEST', status: 400 });
  }, 120_000);
});
