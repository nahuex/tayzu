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
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
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

async function signInOverHttp(app: App, email: string): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': randomIp(),
      origin: ALLOWED_ORIGIN,
    },
    payload: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
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
    const cookie = await signInOverHttp(app, tenant.email);
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
