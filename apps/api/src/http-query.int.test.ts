/**
 * Integration test for task 11.2 (design D13; `specs/catalog-core/spec.md`
 * delta, "Query-string input on a non-GET route is read from the query
 * string").
 *
 * Task 11.2: "`inputStructure: 'detailed'` on `entities.delete`'s route;
 * `moveBodyFieldsToQuery` deleted. Verify: `http-query.int.test.ts` covers
 * 'Query-string input on a non-GET route is read from the query string'
 * (`DELETE .../entities/{entity}?detachReferences=true` reaching the service
 * layer with the flag set)."
 *
 * Scenario: "WHEN `DELETE .../entities/{entity}?detachReferences=true` is
 * called over HTTP / THEN the operation runs with `detachReferences` true,
 * without reading the request body for it".
 *
 * The service layer is observed through its behavior: with the flag set, a
 * referenced entity is deleted and its optional referrers are detached; with
 * the flag absent (control) the same delete is rejected by default. The
 * request carries no body at all, so the flag can only come from the query.
 *
 * ## Production symbols expected
 *
 * - `createApp` / `App` from `./server.js` (exists since 11.1).
 * - The `entities.delete` route in `@tayzu/catalog`'s contract declares
 *   `inputStructure: 'detailed'` so the OpenAPI handler reads `query` at
 *   runtime and coerces `detachReferences=true` to the boolean `true`
 *   (query values arrive as strings; the boolean schema must accept them).
 *
 * ## Why this fails right now
 *
 * With the default (compact) input structure, a DELETE reads its non-path
 * fields from the JSON body, so the query string is ignored:
 * `detachReferences` stays unset and the delete is rejected with
 * `CATALOG_REFERENCE_VIOLATION` instead of succeeding. That is an assertion
 * failure, not a harness problem.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession, freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';

/** A fresh random IP per request so no rate limiter ever interferes. */
function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

async function provisionTenant(app: App): Promise<BootstrappedTenant> {
  const suffix = randomUUID();
  return bootstrapTestTenant(app.auth, {
    name: 'HTTP Query User',
    email: `query-${suffix}@example.test`,
    password: TEST_PASSWORD,
    organizationName: `Query Org ${suffix}`,
    organizationSlug: `query-org-${suffix}`,
    ip: randomIp(),
  });
}

async function post(app: App, cookie: string, url: string, body: unknown): Promise<void> {
  const response = await app.app.inject({
    method: 'POST',
    url,
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN,
      ...csrfHeaders('POST'),
    },
    payload: JSON.stringify(body),
  });
  expect(response.statusCode).toBe(200);
}

/** Team `team-a` referenced by service `payments` through an optional `owner` relation. */
async function seedReferencedEntity(app: App, cookie: string): Promise<void> {
  await post(app, cookie, '/v1/blueprints', {
    identifier: 'team',
    title: { en: 'Team' },
    schema: { properties: {}, required: [] },
  });
  await post(app, cookie, '/v1/blueprints', {
    identifier: 'service',
    title: { en: 'Service' },
    schema: { properties: {}, required: [] },
    relations: {
      owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
    },
  });
  await post(app, cookie, '/v1/blueprints/team/entities', {
    identifier: 'team-a',
    title: 'Team A',
  });
  await post(app, cookie, '/v1/blueprints/service/entities', {
    identifier: 'payments',
    title: 'Payments',
    spec: { relations: { owner: 'team-a' } },
  });
}

interface EntityBody {
  readonly identifier: string;
  readonly spec: { readonly relations: Record<string, unknown> };
}

describe('apps/api query-string input (task 11.2)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('Query-string input on a non-GET route is read from the query string', async () => {
    const tenant = await provisionTenant(app);
    // entities.delete is high-risk: the acting user needs a fresh MFA verification.
    const cookie = await freshMfaSessionCookie(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
      origin: ALLOWED_ORIGIN,
    });
    await seedReferencedEntity(app, cookie);

    // WHEN DELETE .../entities/{entity}?detachReferences=true is called over HTTP (no body).
    const deleted = await app.app.inject({
      method: 'DELETE',
      url: '/v1/blueprints/team/entities/team-a?detachReferences=true',
      headers: { cookie, origin: ALLOWED_ORIGIN, ...csrfHeaders('DELETE') },
    });

    // THEN the operation runs with detachReferences true.
    expect(deleted.statusCode).toBeGreaterThanOrEqual(200);
    expect(deleted.statusCode).toBeLessThan(300);

    const gone = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints/team/entities/team-a',
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);

    // AND the optional referrer was detached, which only happens with the flag set.
    const referrer = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints/service/entities/payments',
      headers: { cookie },
    });
    expect(referrer.statusCode).toBe(200);
    expect(referrer.json<EntityBody>().spec.relations['owner']).toBeUndefined();
  }, 60_000);

  it('control: the same DELETE without the query flag is rejected and deletes nothing', async () => {
    const tenant = await provisionTenant(app);
    // The acting admin must be MFA-enrolled (Q43); the session also carries a fresh verification.
    const { cookie } = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ALLOWED_ORIGIN,
    });
    await seedReferencedEntity(app, cookie);

    const deleted = await app.app.inject({
      method: 'DELETE',
      url: '/v1/blueprints/team/entities/team-a',
      headers: { cookie, origin: ALLOWED_ORIGIN, ...csrfHeaders('DELETE') },
    });

    // The exact status/code mapping belongs to task 11.3; here only "rejected".
    expect(deleted.statusCode).toBeGreaterThanOrEqual(400);

    const still = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints/team/entities/team-a',
      headers: { cookie },
    });
    expect(still.statusCode).toBe(200);
  }, 60_000);
});

/**
 * Task 24.11 (design D11, D13; DAST finding from 24.9).
 *
 * Over HTTP an integer query field such as `pageSize` arrives as a string.
 * Integer query fields must be read from the query string like
 * `detachReferences`, and a request failing a procedure's input schema must
 * answer `400 CATALOG_VALIDATION_FAILED` with the offending JSON Pointer
 * paths, a fixed message and no submitted value.
 *
 * ## Production symbols expected
 *
 * - `@tayzu/catalog` contract: an integer query preprocess (like
 *   `queryBooleanSchema`) on `pageSize` of the blueprint, entity and related
 *   list procedures.
 * - `apps/api/src/error-mapping.ts`: maps oRPC's input-validation
 *   `ORPCError` (`BAD_REQUEST`) to `CATALOG_VALIDATION_FAILED` / 400 with
 *   `data.issues[].path` JSON Pointers, a fixed message and no input value.
 *
 * ## Why this fails right now
 *
 * `?pageSize=1` is rejected as a string (so the list answers 500 `INTERNAL`
 * instead of one item), and input-validation errors are not mapped.
 */
interface ListBody {
  readonly items: readonly { readonly identifier: string }[];
  readonly cursor?: string;
}

interface ErrBody {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly data?: { readonly issues?: readonly { readonly path: string }[] };
}

describe('apps/api integer query fields and input-validation errors (task 24.11)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function session(): Promise<string> {
    const tenant = await provisionTenant(app);
    const { cookie } = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ALLOWED_ORIGIN,
    });
    return cookie;
  }

  async function get(cookie: string, url: string) {
    return app.app.inject({ method: 'GET', url, headers: { cookie } });
  }

  /** Pages through `url` with `pageSize=1`, returning every identifier in order. */
  async function pageAll(cookie: string, url: string): Promise<string[]> {
    const first = await get(cookie, `${url}?pageSize=1`);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<ListBody>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.cursor).toBeDefined();
    const second = await get(
      cookie,
      `${url}?pageSize=10&cursor=${encodeURIComponent(firstBody.cursor ?? '')}`,
    );
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<ListBody>();
    return [...firstBody.items, ...secondBody.items].map((item) => item.identifier);
  }

  it('GET /v1/blueprints?pageSize=1 returns one item and a cursor whose next page returns the rest', async () => {
    const cookie = await session();
    for (const identifier of ['alpha', 'beta', 'gamma']) {
      await post(app, cookie, '/v1/blueprints', {
        identifier,
        title: { en: identifier },
        schema: { properties: {}, required: [] },
      });
    }
    const identifiers = await pageAll(cookie, '/v1/blueprints');
    expect(identifiers.filter((id) => ['alpha', 'beta', 'gamma'].includes(id)).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  }, 60_000);

  it('GET /v1/blueprints/{blueprint}/entities?pageSize=1 returns one item and a cursor whose next page returns the rest', async () => {
    const cookie = await session();
    await post(app, cookie, '/v1/blueprints', {
      identifier: 'team',
      title: { en: 'Team' },
      schema: { properties: {}, required: [] },
    });
    for (const identifier of ['team-a', 'team-b', 'team-c']) {
      await post(app, cookie, '/v1/blueprints/team/entities', { identifier, title: identifier });
    }
    const identifiers = await pageAll(cookie, '/v1/blueprints/team/entities');
    expect([...identifiers].sort()).toEqual(['team-a', 'team-b', 'team-c']);
  }, 60_000);

  it('?pageSize=abc answers 400 CATALOG_VALIDATION_FAILED naming /pageSize without echoing abc', async () => {
    const cookie = await session();
    const secret = 'abcSubmittedValue';
    const response = await get(cookie, `/v1/blueprints?pageSize=${secret}`);
    expect(response.statusCode).toBe(400);
    const body = response.json<ErrBody>();
    expect(body.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(body.status).toBe(400);
    expect(body.data?.issues?.map((issue) => issue.path)).toContain('/pageSize');
    expect(response.body).not.toContain(secret);
  }, 60_000);

  it('a malformed JSON body on a POST answers 400, never 500', async () => {
    const cookie = await session();
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        ...csrfHeaders('POST'),
      },
      payload: '{"identifier": ',
    });
    expect(response.statusCode).toBe(400);
  }, 60_000);
});
