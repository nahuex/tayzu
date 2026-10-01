/**
 * Integration test for task 27.1 (design Q74, D18).
 *
 * Task 27.1: "A first `onRequest` hook in `createApp`, ahead of every other
 * hook, answers `404` (the allowlist's own response) to any request whose
 * target is not origin-form or whose path (before the query) contains `%`,
 * `//` or a backslash (design Q74, D18). Verify: a new
 * `request-target.int.test.ts` sends, over a raw TCP socket to a listening
 * app, an absolute-form `POST http://x/api/auth/organization/update-member-role`,
 * `/api/auth/%6Frganization/create`, `//api/auth/...` and
 * `/v1/auth/%74oken`, each answering `404` with no side effect, and an
 * ordinary request still answering normally."
 *
 * Design Q74: "A first `onRequest` hook rejects any request target that is not
 * origin-form (does not start with a single `/`) or whose path holds a
 * percent-encoded byte, before any other hook."
 *
 * The requests go over a raw TCP socket because `app.inject` and `fetch` both
 * normalize the target, so they cannot send an absolute-form or a
 * non-normalized request line.
 *
 * ## Production symbols expected
 *
 * Only `createApp` (existing, `./server.js`) changes: its first `onRequest`
 * hook answers Fastify's own `404` (`reply.callNotFound()`, the same response
 * as the D18 allowlist) for the targets above. No new export.
 *
 * ## Why this fails right now
 *
 * Today the hooks read the raw `request.url`, so `/v1/auth/%74oken` is decoded
 * by the router and reaches the token-exchange handler (answers 400/401, not
 * 404). Targets that already answer 404 through the allowlist or the router
 * pass today; they are regression guards for the new hook.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';

/** A fresh random IP per request so no rate limiter ever interferes. */
function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface RawResponse {
  readonly statusCode: number;
  readonly body: string;
}

/** Sends one HTTP/1.1 request, byte for byte, and reads the response until the server closes. */
function rawRequest(
  port: number,
  method: string,
  target: string,
  headers: Readonly<Record<string, string>>,
  payload: string,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const headerLines: string[] = Object.entries({
      host: `127.0.0.1:${port.toString(10)}`,
      connection: 'close',
      'x-forwarded-for': randomIp(),
      origin: ALLOWED_ORIGIN,
      'content-length': Buffer.byteLength(payload).toString(10),
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`);
    socket.on('connect', () => {
      socket.write(`${method} ${target} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n${payload}`);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (statusMatch?.[1] === undefined) {
        reject(new Error('no HTTP status line in the response'));
        return;
      }
      resolve({
        statusCode: Number(statusMatch[1]),
        body: text.slice(text.indexOf('\r\n\r\n') + 4),
      });
    });
  });
}

describe('apps/api request-target hook (task 27.1, design Q74 and D18)', () => {
  let app: App;
  let pools: HarnessPools;
  let tenant: BootstrappedTenant;
  let port: number;

  beforeAll(async () => {
    pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      tokenExchangeRateLimit: { max: 1000, timeWindowMs: 60_000 },
    });
    const suffix = randomUUID();
    tenant = await bootstrapTestTenant(app.auth, {
      name: 'Request Target User',
      email: `request-target-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Request Target Org ${suffix}`,
      organizationSlug: `request-target-org-${suffix}`,
      ip: randomIp(),
    });
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function organizationCount(slug: string): Promise<number> {
    const result = await pools.authPool.query<{ count: string }>(
      'select count(*) as count from auth.organization where slug = $1',
      [slug],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  const signedHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    cookie: tenant.cookie,
  });

  it('An absolute-form POST to a native organization-mutation route answers 404 with no side effect', async () => {
    const payload = JSON.stringify({
      organizationId: tenant.organizationId,
      memberId: tenant.userId,
      role: 'member',
    });
    const response = await rawRequest(
      port,
      'POST',
      'http://x/api/auth/organization/update-member-role',
      signedHeaders(),
      payload,
    );

    expect(response.statusCode).toBe(404);
    // No side effect: the owner's role is unchanged.
    const roles = await pools.authPool.query<{ role: string }>(
      'select role from auth.member where organization_id = $1 and user_id = $2',
      [tenant.organizationId, tenant.userId],
    );
    expect(roles.rows[0]?.role).toBe('owner');
  }, 60_000);

  it('A percent-encoded segment in /api/auth/ answers 404 with no side effect', async () => {
    const slug = `request-target-created-${randomUUID()}`;
    const response = await rawRequest(
      port,
      'POST',
      '/api/auth/%6Frganization/create',
      signedHeaders(),
      JSON.stringify({ name: 'Smuggled Org', slug }),
    );

    expect(response.statusCode).toBe(404);
    expect(await organizationCount(slug)).toBe(0);
  }, 60_000);

  it('A double-slash path //api/auth/... answers 404 with no side effect', async () => {
    const slug = `request-target-double-${randomUUID()}`;
    const response = await rawRequest(
      port,
      'POST',
      '//api/auth/organization/create',
      signedHeaders(),
      JSON.stringify({ name: 'Double Slash Org', slug }),
    );

    expect(response.statusCode).toBe(404);
    expect(await organizationCount(slug)).toBe(0);
  }, 60_000);

  it('A percent-encoded /v1/auth/%74oken answers 404 and never reaches the token exchange', async () => {
    const response = await rawRequest(
      port,
      'POST',
      '/v1/auth/%74oken',
      { 'content-type': 'application/json', 'x-csrf-token': 'orpc' },
      JSON.stringify({ clientId: `client-${randomUUID()}`, clientSecret: 'wrong-secret' }),
    );

    // Today the router decodes it to /v1/auth/token (400/401 from the exchange).
    expect(response.statusCode).toBe(404);
  }, 60_000);

  it('A backslash in the path answers 404', async () => {
    const response = await rawRequest(
      port,
      'POST',
      '/api/auth\\organization/create',
      signedHeaders(),
      JSON.stringify({ name: 'Backslash Org', slug: `request-target-bs-${randomUUID()}` }),
    );

    expect(response.statusCode).toBe(404);
  }, 60_000);

  it('An ordinary request still answers normally', async () => {
    const response = await rawRequest(port, 'GET', '/healthz', {}, '');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  }, 60_000);

  it('A percent sign in the query string, not the path, is an ordinary request', async () => {
    const response = await rawRequest(port, 'GET', '/healthz?q=%41', {}, '');

    expect(response.statusCode).toBe(200);
  }, 60_000);
});

/**
 * Task 27.2 (design Q74): "Every guard in `apps/api` (allowlist, 415, `idToken`
 * refusal, link/unlink step-up, token-exchange predicate and limiter) reads the
 * parsed pathname instead of the raw `request.url`. Verify: the same test file
 * covers each guard still applying to its route when the request carries a
 * query string, and the token-exchange limiter answering `429` on the routed
 * path."
 *
 * ## Production symbols expected
 *
 * None new. Every guard in `./server.ts` derives its path from one parsed
 * pathname (no raw `request.url` comparison). Behavior is unchanged, so these
 * are regression guards: they pass today because each guard already strips
 * the query with `split('?')`, and they must stay green through the refactor.
 */
describe('apps/api guards still apply with a query string (task 27.2, design Q74)', () => {
  const QUERY = '?probe=1&other=%41';
  let app: App;
  let pools: HarnessPools;
  let tenant: BootstrappedTenant;
  let port: number;
  let limitedApp: App;
  let limitedPort: number;

  beforeAll(async () => {
    pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      tokenExchangeRateLimit: { max: 1000, timeWindowMs: 60_000 },
    });
    const suffix: string = randomUUID();
    tenant = await bootstrapTestTenant(app.auth, {
      name: 'Query Guard User',
      email: `query-guard-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Query Guard Org ${suffix}`,
      organizationSlug: `query-guard-org-${suffix}`,
      ip: randomIp(),
    });
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.app.server.address() as AddressInfo).port;

    limitedApp = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      tokenExchangeRateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    await limitedApp.app.listen({ host: '127.0.0.1', port: 0 });
    limitedPort = (limitedApp.app.server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await limitedApp.close();
  }, 60_000);

  const jsonHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    cookie: tenant.cookie,
  });

  function codeOf(response: RawResponse): unknown {
    try {
      return (JSON.parse(response.body) as { code?: unknown }).code;
    } catch {
      return undefined;
    }
  }

  it('Allowlist: an unlisted /api/auth route answers 404 with a query string, and no side effect', async () => {
    const slug: string = `query-guard-created-${randomUUID()}`;
    const created: RawResponse = await rawRequest(
      port,
      'POST',
      `/api/auth/organization/create${QUERY}`,
      jsonHeaders(),
      JSON.stringify({ name: 'Query Org', slug }),
    );
    expect(created.statusCode).toBe(404);
    const count = await pools.authPool.query<{ count: string }>(
      'select count(*) as count from auth.organization where slug = $1',
      [slug],
    );
    expect(Number(count.rows[0]?.count ?? '0')).toBe(0);

    const roleChange: RawResponse = await rawRequest(
      port,
      'POST',
      `/api/auth/organization/update-member-role${QUERY}`,
      jsonHeaders(),
      JSON.stringify({
        organizationId: tenant.organizationId,
        memberId: tenant.userId,
        role: 'member',
      }),
    );
    expect(roleChange.statusCode).toBe(404);
    const roles = await pools.authPool.query<{ role: string }>(
      'select role from auth.member where organization_id = $1 and user_id = $2',
      [tenant.organizationId, tenant.userId],
    );
    expect(roles.rows[0]?.role).toBe('owner');
  }, 60_000);

  it('Allowlist: a listed /api/auth route is still served with a query string', async () => {
    const response: RawResponse = await rawRequest(
      port,
      'GET',
      `/api/auth/get-session${QUERY}`,
      { cookie: tenant.cookie },
      '',
    );
    expect(response.statusCode).toBe(200);
  }, 60_000);

  it('415: a non-JSON body on a /v1 route is refused with a query string', async () => {
    const response: RawResponse = await rawRequest(
      port,
      'POST',
      `/v1/blueprints/query-guard${QUERY}`,
      { 'content-type': 'text/plain', 'x-csrf-token': 'orpc' },
      'not json',
    );
    expect(response.statusCode).toBe(415);
    expect(codeOf(response)).toBe('UNSUPPORTED_MEDIA_TYPE');
  }, 60_000);

  it('idToken refusal: sign-in/social and link-social refuse a body with idToken with a query string', async () => {
    const payload: string = JSON.stringify({
      provider: 'visma-connect',
      idToken: { token: 'client-submitted' },
      callbackURL: '/',
    });
    for (const route of ['/api/auth/sign-in/social', '/api/auth/link-social']) {
      const response: RawResponse = await rawRequest(
        port,
        'POST',
        `${route}${QUERY}`,
        jsonHeaders(),
        payload,
      );
      expect(response.statusCode, route).toBe(400);
      expect(codeOf(response), route).toBe('BAD_REQUEST');
    }
  }, 60_000);

  it('Link/unlink step-up: link-social and unlink-account without a fresh step-up answer 403 AUTH_STEP_UP_REQUIRED with a query string', async () => {
    for (const route of ['/api/auth/link-social', '/api/auth/unlink-account']) {
      const response: RawResponse = await rawRequest(
        port,
        'POST',
        `${route}${QUERY}`,
        jsonHeaders(),
        JSON.stringify({
          provider: 'visma-connect',
          providerId: 'visma-connect',
          callbackURL: '/',
        }),
      );
      expect(response.statusCode, `${route}: ${response.body}`).toBe(403);
      expect(codeOf(response), route).toBe('AUTH_STEP_UP_REQUIRED');
    }
  }, 60_000);

  it('Token-exchange limiter: answers 429 AUTH_RATE_LIMITED on the routed path, whether or not the request carries a query string', async () => {
    const ip: string = randomIp();
    const exchange = (target: string): Promise<RawResponse> =>
      rawRequest(
        limitedPort,
        'POST',
        target,
        {
          'content-type': 'application/json',
          'x-csrf-token': 'orpc',
          'x-forwarded-for': ip,
        },
        JSON.stringify({ clientId: `client-${randomUUID()}`, clientSecret: 'wrong-secret' }),
      );

    // Both spellings of the route share one bucket (max 2), so the query string
    // neither escapes the limiter nor the predicate that names the route.
    expect((await exchange(`/v1/auth/token${QUERY}`)).statusCode).not.toBe(429);
    expect((await exchange('/v1/auth/token')).statusCode).not.toBe(429);
    const limited: RawResponse = await exchange(`/v1/auth/token${QUERY}`);
    expect(limited.statusCode).toBe(429);
    expect(codeOf(limited)).toBe('AUTH_RATE_LIMITED');
    expect((await exchange('/v1/auth/token')).statusCode).toBe(429);
  }, 60_000);
});
