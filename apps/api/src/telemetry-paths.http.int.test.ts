/**
 * Task 15.5 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design D16,
 * Resolved decisions Q119 and Q74 of 002).
 *
 * Scenarios (spec.md, requirement "Telemetry"):
 * - "A path identifier never reaches telemetry over HTTP"
 * - "A `_user` email never reaches a catalog HTTP span"
 * - "A percent-encoded path identifier never reaches telemetry over HTTP"
 *
 * Plus the task's Verify clause: the template matcher covers every route of D10 (twelve
 * path templates) and the three `_user` catalog templates (fifteen), and
 * `docs/catalog/catalog-core.md` names the three `_user` route templates.
 *
 * ## Harness
 *
 * The real OTel SDK (`startTelemetry`) exports over OTLP/HTTP to an in-process receiver;
 * `createApp` (identity routes mounted, harness pools) listens on 127.0.0.1 with an
 * ephemeral port and is driven with `fetch`, so the real HTTP instrumentation sees every
 * request. A fresh MFA-enrolled admin (fresh tenant) signs the requests, each with a fresh
 * `x-forwarded-for`. Every request is made in `beforeAll`; the SDK is then shut down
 * (flushing) and the tests read what the receiver got.
 *
 * ## Production symbols expected
 *
 * - `apps/api/src/telemetry.ts` exports
 *   `routeTemplate(pathname: string): string | undefined`: the route template of a parsed
 *   pathname among the fifteen templates (identifier segments match any non-empty
 *   segment, percent-encoded or not), `undefined` for any other path.
 * - The span exporter of `startTelemetry` replaces the path attributes (`url.path`,
 *   `http.target`, `url.full`, `http.url`) of a matching request with the template.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { routeTemplate, startTelemetry } from './telemetry.js';

const ORIGIN = 'https://app.tayzu.test';

const USER_STATUS = '/v1/users/{user}/status';
const CATALOG_USER = '/v1/blueprints/_user/entities/{entity}';
const CATALOG_USER_STATUS = '/v1/blueprints/_user/entities/{entity}/status';
const CATALOG_USER_RELATED = '/v1/blueprints/_user/entities/{entity}/related';
const CREDENTIAL_ROTATE = '/v1/credentials/{credential}/rotate';

interface JsonAttribute {
  key: string;
  value: { stringValue?: string };
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

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
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

function pathOf(span: JsonSpan): string | undefined {
  return attr(span, 'url.path') ?? attr(span, 'http.target');
}

function methodOf(span: JsonSpan): string | undefined {
  return attr(span, 'http.request.method') ?? attr(span, 'http.method');
}

describe('identifiers in URL paths never reach telemetry over HTTP (task 15.5)', () => {
  const suffix = randomUUID();
  const statusMarker = `marker-status-${suffix}@example.test`;
  const credentialMarker = `cred-marker-${suffix}`;
  const catalogGetMarker = `marker-get-${suffix}@example.test`;
  const catalogStatusMarker = `marker-cstatus-${suffix}@example.test`;
  const catalogRelatedMarker = `marker-related-${suffix}@example.test`;
  const encodedStatusMarker = `marker-enc-status-${suffix}@example.test`;
  const encodedCatalogMarker = `marker-enc-get-${suffix}@example.test`;
  const otherBlueprintEntity = `keep-${suffix}`;
  const MFA_RESET = '/v1/users/{user}/mfa/reset';
  const resetRawMarker = `marker-user-${suffix}@example.com`;
  const resetEncodedMarker = `marker-enc-user-${suffix}@example.com`;
  const otherBlueprintPath = `/v1/blueprints/component/entities/${otherBlueprintEntity}`;

  let spans: JsonSpan[] = [];
  let everything = '';

  async function call(
    base: string,
    cookie: string,
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await response.arrayBuffer();
  }

  beforeAll(async () => {
    const receiver = await startReceiver();
    const telemetry = startTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_SERVICE_NAME: 'tayzu-api-test',
    });
    expect(telemetry, 'the SDK starts when an endpoint is set').toBeDefined();
    try {
      const pools = await harnessPools();
      // Imported after the SDK starts so `http` is patched when Fastify builds its server.
      const { createApp } = await import('./server.js');
      const app = await createApp({
        ...pools,
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: [ORIGIN],
        ...{
          mountIdentityRoutes: true,
          ...{ identityTokenHmacSecret: 'mount-wiring-test-only-secret-0123456789-abcdef' },
          identity: {
            emailGate: createEmailTenantGate({
              disabledTenantIds: [],
              recipientKeySecret: TEST_SECRET,
              capStore: createInMemoryEmailCapStore({
                tenant: { max: 20, windowSeconds: 3600 },
                recipient: { max: 20, windowSeconds: 3600 },
              }),
              sender: createRecordingEmailSender(),
            }),
            invitationLinkBaseUrl: ORIGIN,
          },
        },
      });
      try {
        await app.app.listen({ host: '127.0.0.1', port: 0 });
        const { port } = app.app.server.address() as AddressInfo;
        const base = `http://127.0.0.1:${String(port)}`;

        const id = randomUUID();
        const tenant = await bootstrapTestTenant(app.auth, {
          pool: testAppPool(),
          name: 'Telemetry Paths Admin',
          email: `telemetry-paths-${id}@example.test`,
          password: TEST_PASSWORD,
          organizationName: `Telemetry Paths Org ${id}`,
          organizationSlug: `telemetry-paths-${id}`,
          ip: randomIp(),
        });
        const { cookie } = await enrolledAdminSession(app, tenant, {
          password: TEST_PASSWORD,
          origin: ORIGIN,
        });

        await call(base, cookie, 'PUT', `/v1/users/${statusMarker}/status`, {
          status: 'Disabled',
        });
        await call(base, cookie, 'POST', `/v1/credentials/${credentialMarker}/rotate`, {});
        await call(base, cookie, 'GET', `/v1/blueprints/_user/entities/${catalogGetMarker}`);
        await call(
          base,
          cookie,
          'PUT',
          `/v1/blueprints/_user/entities/${catalogStatusMarker}/status`,
          {
            status: 'Disabled',
          },
        );
        await call(
          base,
          cookie,
          'GET',
          `/v1/blueprints/_user/entities/${catalogRelatedMarker}/related`,
        );
        await call(base, cookie, 'GET', otherBlueprintPath);
        await call(
          base,
          cookie,
          'PUT',
          `/v1/users/${encodeURIComponent(encodedStatusMarker)}/status`,
          {
            status: 'Disabled',
          },
        );
        await call(
          base,
          cookie,
          'GET',
          `/v1/blueprints/_user/entities/${encodeURIComponent(encodedCatalogMarker)}`,
        );
        // 044 task 10.5: the admin MFA reset path, in its raw and percent-encoded spelling.
        // It shares this SDK and receiver: a second `startTelemetry` in one process cannot
        // register its exporter, so a separate describe would find no spans.
        for (const target of [resetRawMarker, encodeURIComponent(resetEncodedMarker)]) {
          await call(base, cookie, 'POST', `/v1/users/${target}/mfa/reset`, {
            reason: 'device_replaced',
          });
        }
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

  function serverSpans(method: string, path: string): JsonSpan[] {
    return spans.filter((s) => s.kind === 2 && methodOf(s) === method && pathOf(s) === path);
  }

  function expectTemplateExported(method: string, template: string): void {
    const found = serverSpans(method, template);
    expect(found.length, `a ${method} server span exports ${template}`).toBeGreaterThan(0);
    for (const span of found) {
      for (const key of ['url.full', 'http.url']) {
        const value = attr(span, key);
        if (value !== undefined) expect(value.endsWith(template), `${key}: ${value}`).toBe(true);
      }
    }
  }

  function expectNoMarker(...markers: string[]): void {
    for (const marker of markers) {
      expect(everything).not.toContain(marker);
    }
  }

  it('A path identifier never reaches telemetry over HTTP', () => {
    expectTemplateExported('PUT', USER_STATUS);
    expectTemplateExported('POST', CREDENTIAL_ROTATE);
    expectNoMarker(statusMarker, credentialMarker);
  });

  it('`POST /v1/users/marker-user@example.com/mfa/reset` and its percent-encoded form export `/v1/users/{user}/mfa/reset` and no marker', () => {
    const found = serverSpans('POST', MFA_RESET);
    expect(
      found.length,
      'a POST server span per spelling exports the template',
    ).toBeGreaterThanOrEqual(2);
    expectTemplateExported('POST', MFA_RESET);
    expectNoMarker(resetRawMarker, resetEncodedMarker, encodeURIComponent(resetEncodedMarker));
  });

  it('A `_user` email never reaches a catalog HTTP span', () => {
    expectTemplateExported('GET', CATALOG_USER);
    expectTemplateExported('PUT', CATALOG_USER_STATUS);
    expectTemplateExported('GET', CATALOG_USER_RELATED);
    expectNoMarker(catalogGetMarker, catalogStatusMarker, catalogRelatedMarker);
    // A route of another blueprint keeps its path and identifier.
    expect(serverSpans('GET', otherBlueprintPath).length).toBeGreaterThan(0);
    expect(everything).toContain(otherBlueprintEntity);
  });

  it('A percent-encoded path identifier never reaches telemetry over HTTP', () => {
    expectTemplateExported('PUT', USER_STATUS);
    expectTemplateExported('GET', CATALOG_USER);
    expectNoMarker(
      encodedStatusMarker,
      encodeURIComponent(encodedStatusMarker),
      encodedCatalogMarker,
      encodeURIComponent(encodedCatalogMarker),
    );
  });

  it('every identity or `_user` server span exports a template, never an identifier path', () => {
    const templates = new Set([
      USER_STATUS,
      CREDENTIAL_ROTATE,
      CATALOG_USER,
      CATALOG_USER_STATUS,
      CATALOG_USER_RELATED,
      MFA_RESET,
    ]);
    const candidates = spans.filter((s) => {
      const path = pathOf(s) ?? '';
      return s.kind === 2 && (path.startsWith('/v1/users/') || path.includes('/_user/'));
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const span of candidates) {
      expect(templates.has(pathOf(span) ?? ''), pathOf(span)).toBe(true);
    }
  });
});

describe('the route template matcher (task 15.5)', () => {
  const cases: readonly [string, string][] = [
    ['/v1/users/invitations', '/v1/users/invitations'],
    ['/v1/users/invitations/inv-1/cancel', '/v1/users/invitations/{invitation}/cancel'],
    ['/v1/users/invitations/inv-1/resend', '/v1/users/invitations/{invitation}/resend'],
    ['/v1/auth/invitations/accept', '/v1/auth/invitations/accept'],
    ['/v1/users/a@b.test/status', USER_STATUS],
    ['/v1/users', '/v1/users'],
    ['/v1/users/a@b.test/sso-account', '/v1/users/{user}/sso-account'],
    ['/v1/service-accounts', '/v1/service-accounts'],
    ['/v1/service-accounts/svc-ci', '/v1/service-accounts/{user}'],
    ['/v1/credentials', '/v1/credentials'],
    ['/v1/credentials/c-1/rotate', CREDENTIAL_ROTATE],
    ['/v1/credentials/c-1/revoke', '/v1/credentials/{credential}/revoke'],
    ['/v1/blueprints/_user/entities/a@b.test', CATALOG_USER],
    ['/v1/blueprints/_user/entities/a@b.test/status', CATALOG_USER_STATUS],
    ['/v1/blueprints/_user/entities/a@b.test/related', CATALOG_USER_RELATED],
  ];

  it('covers the twelve identity templates and the three `_user` templates', () => {
    expect(new Set(cases.map(([, template]) => template)).size).toBe(15);
    for (const [path, template] of cases) {
      expect(routeTemplate(path), path).toBe(template);
    }
  });

  it('matches whatever the identifier spelling, percent-encoded included', () => {
    expect(routeTemplate('/v1/users/a%40b/status')).toBe(USER_STATUS);
    expect(routeTemplate('/v1/blueprints/_user/entities/a%40b')).toBe(CATALOG_USER);
  });

  it('leaves the routes of other blueprints and other paths unmatched', () => {
    expect(routeTemplate('/v1/blueprints/component/entities/x')).toBeUndefined();
    expect(routeTemplate('/v1/blueprints/component/entities/x/status')).toBeUndefined();
    expect(routeTemplate('/healthz')).toBeUndefined();
  });
});

describe('docs/catalog/catalog-core.md (task 15.5)', () => {
  it('names the three `_user` route templates', () => {
    const doc = readFileSync(
      new URL('../../../docs/catalog/catalog-core.md', import.meta.url),
      'utf8',
    );
    for (const template of [CATALOG_USER, CATALOG_USER_STATUS, CATALOG_USER_RELATED]) {
      expect(doc).toContain(template);
    }
  });
});

/** 044 task 10.5: the template matcher covers the admin MFA reset route. */
describe('the admin MFA reset template matcher (044 task 10.5)', () => {
  const MFA_RESET = '/v1/users/{user}/mfa/reset';

  it('the template matcher covers the reset route whatever the identifier spelling', () => {
    expect(routeTemplate('/v1/users/a@b.test/mfa/reset')).toBe(MFA_RESET);
    expect(routeTemplate('/v1/users/a%40b.test/mfa/reset')).toBe(MFA_RESET);
  });
});
