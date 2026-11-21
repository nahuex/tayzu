/**
 * Task 3.8 of openspec/changes/003-catalog-ui-core (design D5 "Search API", D6 "Sorting
 * `entities.list`"; catalog-core delta spec, requirements "Cross-blueprint entity search" and the
 * sorted `entities.list`).
 *
 * Task 3.8: "Search and sort over HTTP: `GET /v1/search/entities` and the `sort` and `order`
 * query of `GET /v1/blueprints/{blueprint}/entities` through the merged router, with the
 * authenticated rate limit, the same answers for a `user` session and an `integration` token with
 * the same grants, a cross-tenant search returning nothing, and the exported HTTP span carrying no
 * `q`. Verify: `search.http.int.test.ts` covers these cases, and `actor-parity.int.test.ts` and
 * `cross-tenant.http.int.test.ts` gain the search rows."
 *
 * Scenarios quoted from `specs/catalog-core/spec.md`:
 *
 * - "Identifier prefix across blueprints": GIVEN entity `payments-api` of blueprint `service` and
 *   entity `payments-db` of blueprint `database`; WHEN the caller searches for `paym`; THEN both
 *   are returned with `match` `identifier`, ordered by blueprint identifier.
 * - "Another tenant's entity is never found": GIVEN entity `secret-svc` exists only in tenant
 *   `t1`; WHEN a caller of tenant `t2` searches for `secret`; THEN the result is empty.
 * - "Limits are checked before the database": WHEN the caller searches for a 101-character query,
 *   or with a limit of 51; THEN the search fails with `CATALOG_VALIDATION_FAILED` or
 *   `CATALOG_LIMIT_EXCEEDED` (over HTTP: design D11's status table, 400 and 422).
 * - "The query text never reaches telemetry": GIVEN a query that contains a unique marker string;
 *   WHEN the search runs and its telemetry is exported; THEN no span, metric or log carries the
 *   marker, and the span carries the query length.
 * - "List sorted by title descending pages without gaps": GIVEN blueprint `service` has entities
 *   titled `Alpha`, `Beta`, `Beta` and `Gamma`; WHEN they are listed sorted by `title` in `desc`
 *   order with a page size of 2, and the next page is requested with the returned cursor; THEN the
 *   first page holds `Gamma` and one `Beta`, the second page holds the other `Beta` and `Alpha`,
 *   and the two `Beta` rows are ordered by identifier.
 * - "Sort by update time": GIVEN entity `a` was updated after entity `b`; WHEN the entities are
 *   listed sorted by `updatedAt` in `desc` order; THEN `a` comes before `b`.
 * - "A cursor of another sort is rejected": GIVEN a cursor returned by a list sorted by `title`;
 *   WHEN it is sent with a list sorted by `identifier`; THEN the list fails with
 *   `CATALOG_VALIDATION_FAILED` on `/cursor`.
 *
 * Plus Resolved decision Q52: a `limit` below 1 is `CATALOG_VALIDATION_FAILED` on `/limit`.
 *
 * ## Harness
 *
 * The telemetry block runs first and on its own app: the real OTel SDK (`startTelemetry`)
 * exports over OTLP/HTTP to an in-process receiver, and `createApp` listens on 127.0.0.1 with an
 * ephemeral port, driven with `fetch`, so the real HTTP instrumentation sees every request (the
 * `telemetry-paths.http.int.test.ts` pattern). `./server.js` is imported dynamically, after the SDK
 * starts, so `http` is patched when Fastify builds its server; the later blocks reuse that module.
 * The other blocks use Fastify injection with a fresh `x-forwarded-for` per request, a fresh
 * tenant per test, an MFA-enrolled admin who seeds over HTTP, a `member` session and an
 * `integration` token (a machine credential is always `member`, Q28), so the two callers hold
 * the same grants. The rate-limit block builds its app with a low per-principal budget, the
 * `rate-limit.int.test.ts` pattern.
 *
 * ## Production symbols expected
 *
 * None new: `createApp` (`./server.js`) with its `rateLimit` option, `startTelemetry`
 * (`./telemetry.js`), and the catalog procedures `search.entities` and `entities.list` (3.4, 3.6).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMachineCredential } from '@tayzu/auth/machine-credentials';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import type { App } from './server.js';
import { startTelemetry } from './telemetry.js';

const ORIGIN = 'https://app.tayzu.test';
const SEARCH = '/v1/search/entities';

type Method = 'GET' | 'POST' | 'PUT';

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

/** The credentials a request is sent with. */
type Caller =
  | { readonly kind: 'cookie'; readonly cookie: string }
  | { readonly kind: 'bearer'; readonly token: string };

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
  readonly json: Record<string, unknown>;
}

interface SearchItem {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly match: string;
}

interface ListedEntity {
  readonly identifier: string;
  readonly title: string;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function searchUrl(params: Record<string, string>): string {
  return `${SEARCH}?${new URLSearchParams(params).toString()}`;
}

function listUrl(blueprint: string, params: Record<string, string>): string {
  return `/v1/blueprints/${blueprint}/entities?${new URLSearchParams(params).toString()}`;
}

function itemsOf(answer: Answer): readonly SearchItem[] {
  return answer.json['items'] as readonly SearchItem[];
}

function listedOf(answer: Answer): readonly ListedEntity[] {
  return answer.json['items'] as readonly ListedEntity[];
}

function cursorOf(answer: Answer): string | undefined {
  const cursor = answer.json['cursor'];
  return typeof cursor === 'string' ? cursor : undefined;
}

function issuePaths(answer: Answer): readonly string[] {
  const data = answer.json['data'] as { issues?: readonly { path: string }[] } | undefined;
  return (data?.issues ?? []).map((issue) => issue.path);
}

function expectOk(answer: Answer, label: string): void {
  expect(answer.status, `${label}: ${answer.body}`).toBe(200);
}

/** Builds an app the way every other HTTP test of this package does; `server.js` loads lazily. */
async function buildApp(extra: { rateLimit?: { max: number; timeWindowMs: number } } = {}) {
  const { createApp } = await import('./server.js');
  return await createApp({
    ...(await harnessPools()),
    authSecret: TEST_SECRET,
    cerbosAddress: 'localhost:3593',
    allowedOrigins: [ORIGIN],
    ...extra,
  });
}

async function freshAdmin(app: App, label: string): Promise<BootstrappedTenant> {
  const suffix = randomUUID();
  const tenant = await bootstrapTestTenant(app.auth, {
    pool: testAppPool(),
    name: `Search Http ${label}`,
    email: `search-http-${label}-${suffix}@example.test`,
    password: TEST_PASSWORD,
    organizationName: `Search Http ${label} ${suffix}`,
    organizationSlug: `search-http-${label}-${suffix}`,
    ip: randomIp(),
  });
  return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
}

async function inject(
  app: App,
  caller: Caller,
  method: Method,
  url: string,
  body?: Record<string, unknown>,
  ip: string = randomIp(),
): Promise<Answer> {
  const authHeaders: Record<string, string> =
    caller.kind === 'cookie'
      ? { cookie: caller.cookie, origin: ORIGIN }
      : { authorization: `Bearer ${caller.token}` };
  const response = await app.app.inject({
    method,
    url,
    headers: {
      ...authHeaders,
      'x-forwarded-for': ip,
      ...csrfHeaders(method),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = response.json<Record<string, unknown>>();
  } catch {
    // A non-JSON body leaves the object empty.
  }
  return { status: response.statusCode, body: response.body, headers: response.headers, json };
}

async function seedBlueprint(app: App, admin: BootstrappedTenant, identifier: string) {
  const answer = await inject(
    app,
    { kind: 'cookie', cookie: admin.cookie },
    'POST',
    '/v1/blueprints',
    {
      identifier,
      title: { en: identifier },
      schema: { properties: {}, required: [] },
    },
  );
  expectOk(answer, `create blueprint ${identifier}`);
}

async function seedEntity(
  app: App,
  admin: BootstrappedTenant,
  blueprint: string,
  identifier: string,
  title: string,
) {
  const answer = await inject(
    app,
    { kind: 'cookie', cookie: admin.cookie },
    'POST',
    `/v1/blueprints/${blueprint}/entities`,
    { identifier, title },
  );
  expectOk(answer, `create entity ${blueprint}/${identifier}`);
}

// ---- The exported HTTP span carries no `q` (runs first: it starts the SDK) ----------------------

interface JsonAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string | number };
}
interface JsonSpan {
  kind?: number;
  name?: string;
  attributes?: JsonAttribute[];
}
interface Received {
  readonly path: string;
  readonly body: string;
}

async function startReceiver(): Promise<{
  endpoint: string;
  received: Received[];
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function spansOf(received: readonly Received[]): JsonSpan[] {
  const spans: JsonSpan[] = [];
  for (const item of received.filter((r) => r.path.endsWith('/v1/traces'))) {
    const parsed = JSON.parse(item.body) as {
      resourceSpans?: { scopeSpans?: { spans?: JsonSpan[] }[] }[];
    };
    for (const rs of parsed.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
    }
  }
  return spans;
}

function attr(span: JsonSpan, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value.stringValue;
}

function intAttr(span: JsonSpan, key: string): number | undefined {
  const value = span.attributes?.find((a) => a.key === key)?.value.intValue;
  return value === undefined ? undefined : Number(value);
}

function pathOf(span: JsonSpan): string | undefined {
  return attr(span, 'url.path') ?? attr(span, 'http.target');
}

function methodOf(span: JsonSpan): string | undefined {
  return attr(span, 'http.request.method') ?? attr(span, 'http.method');
}

describe('the exported HTTP span of GET /v1/search/entities carries no q (task 3.8)', () => {
  // Lowercase letters and digits only: the same spelling raw and percent-encoded.
  const marker = `qmark${randomUUID().replaceAll('-', '')}`;
  const longMarker = `${marker}${'z'.repeat(101 - marker.length)}`;
  let searchStatus = 0;
  let rejectedStatus = 0;
  let spans: JsonSpan[] = [];
  let everything = '';

  beforeAll(async () => {
    const receiver = await startReceiver();
    const telemetry = startTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_SERVICE_NAME: 'tayzu-api-test',
    });
    expect(telemetry, 'the SDK starts when an endpoint is set').toBeDefined();
    try {
      // Built after the SDK starts so `http` is patched when Fastify builds its server.
      const app = await buildApp();
      try {
        await app.app.listen({ host: '127.0.0.1', port: 0 });
        const { port } = app.app.server.address() as AddressInfo;
        const base = `http://127.0.0.1:${String(port)}`;
        const admin = await freshAdmin(app, 'otel');
        const call = async (path: string): Promise<number> => {
          const response = await fetch(`${base}${path}`, {
            headers: { cookie: admin.cookie, origin: ORIGIN, 'x-forwarded-for': randomIp() },
          });
          await response.arrayBuffer();
          return response.status;
        };
        searchStatus = await call(searchUrl({ q: marker, limit: '5' }));
        rejectedStatus = await call(searchUrl({ q: longMarker }));
      } finally {
        await app.close();
      }
    } finally {
      await telemetry?.shutdown();
      await receiver.close();
    }
    spans = spansOf(receiver.received);
    everything = receiver.received.map((r) => r.body).join('\n');
  }, 240_000);

  afterAll(() => {
    spans = [];
  });

  function searchServerSpans(): JsonSpan[] {
    return spans.filter((s) => s.kind === 2 && methodOf(s) === 'GET' && pathOf(s) === SEARCH);
  }

  it('The query text never reaches telemetry: no span, metric or log carries the marker, and the search span carries the query length', () => {
    expect(searchStatus, 'the search reached the handler').toBe(200);
    expect(rejectedStatus, 'the over-long query reached the handler').toBe(400);
    expect(searchServerSpans().length, 'a GET server span per search').toBeGreaterThanOrEqual(2);

    for (const value of [marker, longMarker, `q=${marker}`, 'q=']) {
      expect(everything).not.toContain(value);
    }

    const operation = spans.filter((s) => s.name === 'catalog.entity.search');
    expect(operation.length, 'the catalog search span is exported').toBeGreaterThan(0);
    expect(
      operation.map((s) => intAttr(s, 'tayzu.catalog.search.query_length')),
      'the span carries the query length',
    ).toContain(marker.length);
  });

  it('the HTTP server span of the search strips url.query and keeps no query in url.full', () => {
    const found = searchServerSpans();
    expect(found.length).toBeGreaterThan(0);
    for (const span of found) {
      const keys = (span.attributes ?? []).map((a) => a.key);
      expect(keys, 'url.query is stripped').not.toContain('url.query');
      for (const key of ['url.full', 'http.url', 'http.target', 'url.path']) {
        const value = attr(span, key);
        if (value !== undefined) {
          expect(value, key).not.toContain('?');
          expect(value.endsWith(SEARCH), `${key}: ${value}`).toBe(true);
        }
      }
    }
  });
});

// ---- Search and sort over HTTP ------------------------------------------------------------------

describe('search and sort over HTTP through the merged router (task 3.8)', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function asAdmin(admin: BootstrappedTenant): Caller {
    return { kind: 'cookie', cookie: admin.cookie };
  }

  /** A `member` session of the admin's tenant (signed in after the membership exists). */
  async function memberSession(admin: BootstrappedTenant): Promise<Caller> {
    const created = await createAdminUser(app.auth, {
      name: 'Search Http Member',
      email: `search-http-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    const signedIn = await signInAdminUser(app.auth, {
      email: created.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { kind: 'cookie', cookie: signedIn.cookie };
  }

  /** An `integration` token of the admin's tenant: a machine credential is always `member`. */
  async function integrationToken(admin: BootstrappedTenant): Promise<Caller> {
    const credential = await createMachineCredential(app.auth, {
      userId: admin.userId,
      organizationId: admin.organizationId,
      name: 'Search Http integration',
      actorKind: 'integration',
    });
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId: credential.id, clientSecret: credential.secret }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const token = response.json<{ accessToken?: unknown }>().accessToken;
    if (typeof token !== 'string') throw new Error('no access token');
    return { kind: 'bearer', token };
  }

  /** `payments-api` of `service`, `payments-db` of `database`, and an unrelated `ledger`. */
  async function seedPayments(admin: BootstrappedTenant): Promise<void> {
    await seedBlueprint(app, admin, 'service');
    await seedBlueprint(app, admin, 'database');
    await seedEntity(app, admin, 'service', 'payments-api', 'Payments API');
    await seedEntity(app, admin, 'database', 'payments-db', 'Payments DB');
    await seedEntity(app, admin, 'service', 'ledger', 'Ledger');
  }

  /** Blueprint `service` with entities titled `Alpha`, `Beta`, `Beta` and `Gamma`. */
  async function seedTitles(admin: BootstrappedTenant): Promise<void> {
    await seedBlueprint(app, admin, 'service');
    await seedEntity(app, admin, 'service', 'alpha', 'Alpha');
    await seedEntity(app, admin, 'service', 'betaone', 'Beta');
    await seedEntity(app, admin, 'service', 'betatwo', 'Beta');
    await seedEntity(app, admin, 'service', 'gamma', 'Gamma');
  }

  it('Identifier prefix across blueprints: GET /v1/search/entities?q=paym returns both entities with match identifier, ordered by blueprint identifier, for a user session', async () => {
    const admin = await freshAdmin(app, 'prefix');
    await seedPayments(admin);

    const answer = await inject(app, asAdmin(admin), 'GET', searchUrl({ q: 'paym' }));

    expectOk(answer, 'search');
    expect(answer.json).toEqual({
      items: [
        {
          blueprint: 'database',
          identifier: 'payments-db',
          title: 'Payments DB',
          match: 'identifier',
        },
        {
          blueprint: 'service',
          identifier: 'payments-api',
          title: 'Payments API',
          match: 'identifier',
        },
      ],
    });
  }, 120_000);

  it('the limit query bounds the ranked list over HTTP: limit=1 returns the first item only', async () => {
    const admin = await freshAdmin(app, 'limit');
    await seedPayments(admin);

    const answer = await inject(app, asAdmin(admin), 'GET', searchUrl({ q: 'paym', limit: '1' }));

    expectOk(answer, 'search limit=1');
    expect(itemsOf(answer).map((item) => item.identifier)).toEqual(['payments-db']);
    expect(answer.json['cursor'], 'a ranked top-N list carries no cursor').toBeUndefined();
  }, 120_000);

  it('Limits are checked before the database over HTTP: a 101-character or a 1-character query is 400 CATALOG_VALIDATION_FAILED on /q, a limit of 51 is 422 CATALOG_LIMIT_EXCEEDED naming search.maxLimit, and a limit of 0 is 400 on /limit', async () => {
    const admin = await freshAdmin(app, 'limits');
    const caller = asAdmin(admin);

    for (const q of ['a'.repeat(101), 'a', '  a  ']) {
      const answer = await inject(app, caller, 'GET', searchUrl({ q }));
      expect(answer.status, `q of ${String(q.length)}: ${answer.body}`).toBe(400);
      expect(answer.json['code']).toBe('CATALOG_VALIDATION_FAILED');
      expect(issuePaths(answer)).toContain('/q');
    }

    const tooMany = await inject(app, caller, 'GET', searchUrl({ q: 'paym', limit: '51' }));
    expect(tooMany.status, tooMany.body).toBe(422);
    expect(tooMany.json['code']).toBe('CATALOG_LIMIT_EXCEEDED');
    expect((tooMany.json['data'] as { details?: unknown } | undefined)?.details).toMatchObject({
      limit: 'search.maxLimit',
    });

    const zero = await inject(app, caller, 'GET', searchUrl({ q: 'paym', limit: '0' }));
    expect(zero.status, zero.body).toBe(400);
    expect(zero.json['code']).toBe('CATALOG_VALIDATION_FAILED');
    expect(issuePaths(zero)).toContain('/limit');

    const fifty = await inject(app, caller, 'GET', searchUrl({ q: 'paym', limit: '50' }));
    expectOk(fifty, 'a limit of 50 is accepted');

    const missing = await inject(app, caller, 'GET', SEARCH);
    expect(missing.status, missing.body).toBe(400);
    expect(missing.json['code']).toBe('CATALOG_VALIDATION_FAILED');
  }, 120_000);

  it('List sorted by title descending pages without gaps over HTTP, and the cursor round-trips', async () => {
    const admin = await freshAdmin(app, 'title-desc');
    await seedTitles(admin);
    const caller = asAdmin(admin);
    const params = { sort: 'title', order: 'desc', pageSize: '2' };

    const first = await inject(app, caller, 'GET', listUrl('service', params));
    expectOk(first, 'first page');
    expect(listedOf(first).map((e) => [e.title, e.identifier])).toEqual([
      ['Gamma', 'gamma'],
      ['Beta', 'betatwo'],
    ]);
    const cursor = cursorOf(first);
    expect(cursor, 'the first page returns a cursor').toBeDefined();

    const second = await inject(
      app,
      caller,
      'GET',
      listUrl('service', { ...params, cursor: cursor ?? '' }),
    );
    expectOk(second, 'second page');
    expect(listedOf(second).map((e) => [e.title, e.identifier])).toEqual([
      ['Beta', 'betaone'],
      ['Alpha', 'alpha'],
    ]);
    const after = cursorOf(second);
    if (after !== undefined) {
      const third = await inject(
        app,
        caller,
        'GET',
        listUrl('service', { ...params, cursor: after }),
      );
      expectOk(third, 'third page');
      expect(listedOf(third)).toEqual([]);
    }
  }, 120_000);

  it('Sort by update time over HTTP: a, updated after b, comes first with sort=updatedAt&order=desc', async () => {
    const admin = await freshAdmin(app, 'updated');
    await seedBlueprint(app, admin, 'service');
    await seedEntity(app, admin, 'service', 'a', 'Zulu');
    await seedEntity(app, admin, 'service', 'b', 'Yankee');
    const updated = await inject(app, asAdmin(admin), 'PUT', '/v1/blueprints/service/entities/a', {
      title: 'Zulu updated',
      mode: 'merge',
    });
    expectOk(updated, 'update a');

    const answer = await inject(
      app,
      asAdmin(admin),
      'GET',
      listUrl('service', { sort: 'updatedAt', order: 'desc' }),
    );

    expectOk(answer, 'list by updatedAt desc');
    expect(listedOf(answer).map((e) => e.identifier)).toEqual(['a', 'b']);
  }, 120_000);

  it('A cursor of another sort is rejected over HTTP: a title cursor sent with sort=identifier is 400 CATALOG_VALIDATION_FAILED on /cursor', async () => {
    const admin = await freshAdmin(app, 'cursor');
    await seedTitles(admin);
    const caller = asAdmin(admin);

    const first = await inject(
      app,
      caller,
      'GET',
      listUrl('service', { sort: 'title', pageSize: '2' }),
    );
    expectOk(first, 'first page');
    const cursor = cursorOf(first);
    expect(cursor).toBeDefined();

    const answer = await inject(
      app,
      caller,
      'GET',
      listUrl('service', { sort: 'identifier', pageSize: '2', cursor: cursor ?? '' }),
    );

    expect(answer.status, answer.body).toBe(400);
    expect(answer.json['code']).toBe('CATALOG_VALIDATION_FAILED');
    expect(issuePaths(answer)).toContain('/cursor');
  }, 120_000);

  it('an unknown sort or order value over HTTP is 400 CATALOG_VALIDATION_FAILED', async () => {
    const admin = await freshAdmin(app, 'enum');
    await seedBlueprint(app, admin, 'service');

    const invalid: readonly Record<string, string>[] = [
      { sort: 'createdAt' },
      { order: 'sideways' },
    ];
    for (const params of invalid) {
      const answer = await inject(app, asAdmin(admin), 'GET', listUrl('service', params));
      expect(answer.status, `${JSON.stringify(params)}: ${answer.body}`).toBe(400);
      expect(answer.json['code']).toBe('CATALOG_VALIDATION_FAILED');
    }
  }, 120_000);

  it('a user session and an integration token with the same grants get the same search answer', async () => {
    const admin = await freshAdmin(app, 'parity-search');
    await seedPayments(admin);
    const member = await memberSession(admin);
    const integration = await integrationToken(admin);

    for (const q of ['paym', 'payments-api', 'Ledger']) {
      const asUser = await inject(app, member, 'GET', searchUrl({ q }));
      const asIntegration = await inject(app, integration, 'GET', searchUrl({ q }));
      expectOk(asUser, `member session, q=${q}`);
      expectOk(asIntegration, `integration token, q=${q}`);
      expect(itemsOf(asUser).length, `q=${q} finds something`).toBeGreaterThan(0);
      expect(asIntegration.body, `q=${q}`).toBe(asUser.body);
    }
  }, 120_000);

  it('a user session and an integration token with the same grants get the same sorted pages, and a cursor of one continues for the other', async () => {
    const admin = await freshAdmin(app, 'parity-sort');
    await seedTitles(admin);
    const member = await memberSession(admin);
    const integration = await integrationToken(admin);
    const params = { sort: 'title', order: 'desc', pageSize: '2' };

    const userFirst = await inject(app, member, 'GET', listUrl('service', params));
    const integrationFirst = await inject(app, integration, 'GET', listUrl('service', params));
    expectOk(userFirst, 'member first page');
    expectOk(integrationFirst, 'integration first page');
    expect(listedOf(integrationFirst)).toEqual(listedOf(userFirst));
    expect(cursorOf(integrationFirst)).toBe(cursorOf(userFirst));

    const cursor = cursorOf(userFirst) ?? '';
    const userSecond = await inject(app, member, 'GET', listUrl('service', { ...params, cursor }));
    const integrationSecond = await inject(
      app,
      integration,
      'GET',
      listUrl('service', { ...params, cursor }),
    );
    expectOk(userSecond, 'member second page');
    expectOk(integrationSecond, 'integration second page');
    expect(listedOf(userSecond).map((e) => e.identifier)).toEqual(['betaone', 'alpha']);
    expect(listedOf(integrationSecond)).toEqual(listedOf(userSecond));
  }, 120_000);

  it("Another tenant's entity is never found over HTTP: a caller of t2 searching for secret gets an empty result", async () => {
    const t1 = await freshAdmin(app, 't1');
    const t2 = await freshAdmin(app, 't2');
    await seedBlueprint(app, t1, 'service');
    await seedEntity(app, t1, 'service', 'secret-svc', 'Secret Service');

    // Not vacuous: t1 itself finds the entity.
    const own = await inject(app, asAdmin(t1), 'GET', searchUrl({ q: 'secret' }));
    expectOk(own, 't1 search');
    expect(itemsOf(own).map((item) => item.identifier)).toEqual(['secret-svc']);

    for (const q of ['secret', 'secret-svc', 'Secret Service']) {
      const foreign = await inject(app, asAdmin(t2), 'GET', searchUrl({ q }));
      expectOk(foreign, `t2 search q=${q}`);
      expect(foreign.json, `q=${q}`).toEqual({ items: [] });
      expect(foreign.body).not.toContain('secret-svc');
    }
  }, 120_000);
});

// ---- The authenticated rate limit applies to the search route ----------------------------------

describe('the per-principal rate limit applies to GET /v1/search/entities (task 3.8)', () => {
  const MAX_REQUESTS = 3;
  const SHARED_CLIENT_IP = '10.78.78.78';
  let app: App;

  beforeAll(async () => {
    app = await buildApp({ rateLimit: { max: MAX_REQUESTS, timeWindowMs: 60_000 } });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('a principal over its budget gets 429 AUTH_RATE_LIMITED on the search route while another principal is unaffected', async () => {
    const limited = await freshAdmin(app, 'rl-a');
    const other = await freshAdmin(app, 'rl-b');
    const search = (admin: BootstrappedTenant) =>
      inject(
        app,
        { kind: 'cookie', cookie: admin.cookie },
        'GET',
        searchUrl({ q: 'paym' }),
        undefined,
        SHARED_CLIENT_IP,
      );

    for (let i = 0; i < MAX_REQUESTS; i += 1) {
      const answer = await search(limited);
      expectOk(answer, `request ${String(i + 1)} within the budget`);
    }

    const over = await search(limited);
    expect(over.status, over.body).toBe(429);
    expect(over.json['code']).toBe('AUTH_RATE_LIMITED');
    const retryAfter = Number(over.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(over.body).not.toContain(limited.organizationId);
    expect(over.body).not.toContain(limited.userId);

    expect((await search(limited)).status, 'still limited').toBe(429);
    expectOk(await search(other), 'another principal, same IP');
  }, 120_000);
});
