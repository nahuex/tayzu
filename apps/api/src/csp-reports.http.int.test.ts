/**
 * Task 8.4 of `openspec/changes/048-production-hardening` (design D9, Resolved decisions Q10
 * and Q26): "`POST /v1/csp-reports` answers `204` and counts (design D9). Verify:
 * `apps/api/src/csp-reports.http.int.test.ts` covers "A report is counted by its directive
 * only" (the marker in no signal and no log record), "A Reporting API batch is counted per
 * violation", "A malformed, hostile or oversized report still answers 204" and "The report
 * route is public and reads no session"."
 *
 * Spec `specs/catalog-ui-core/spec.md`, requirement "Content Security Policy violation reports
 * are counted without their content" (quoted from the file):
 *
 * > #### Scenario: A report is counted by its directive only
 * >
 * > - **WHEN** a browser posts a `csp-report` whose `effective-directive` is `script-src-elem`
 * >   and whose `document-uri`, `blocked-uri` and `script-sample` hold a marker string
 * > - **THEN** the answer is `204`, `tayzu.web.csp_violations` is incremented once with the
 * >   directive `script-src`, and the marker appears in no exported span, metric or log
 * >   attribute and in no log record
 *
 * > #### Scenario: A Reporting API batch is counted per violation
 * >
 * > - **WHEN** a browser posts an `application/reports+json` array with two `csp-violation`
 * >   reports and one report of another type
 * > - **THEN** the answer is `204` and the counter is incremented twice, once per violation's
 * >   directive
 *
 * > #### Scenario: A malformed, hostile or oversized report still answers 204
 * >
 * > - **WHEN** a report is not JSON, holds a `__proto__`, `constructor` or `prototype` key at
 * >   any depth, or exceeds 8 KiB
 * > - **THEN** the answer is `204`, nothing is counted, and no internal error is logged
 *
 * > #### Scenario: The report route is public and reads no session
 * >
 * > - **WHEN** the reviewed public-route list and the route are checked
 * > - **THEN** `POST /v1/csp-reports` is on the list with its reason, and a request with a
 * >   session cookie is counted the same way as one without
 *
 * The requirement text adds: "It MUST answer `204` with no body to every report it accepts,
 * whether the body is well formed, malformed or larger than its 8 KiB limit", "check the size
 * limit before parsing", "Each report MUST increment the `tayzu.web.csp_violations` counter
 * once", and "The route MUST write no log record per report".
 *
 * Design D9: the route scope "registers a string parser for those two types with
 * `bodyLimit: 8192`; its error handler maps the body-limit and parse errors to `204`" (so an
 * oversized body is never a `413`), and "The handler never reads a cookie or a header other
 * than the media type". Signal: `tayzu.web.csp_violations` (Counter, `{report}`), one
 * attribute, `tayzu.web.csp.directive`, recorded through `recordIdentityMetric`; "No log
 * record per report".
 *
 * ## Not covered here
 *
 * - "Other media types are refused like any `/v1` body", "A flood from one address is
 *   dropped", the bucket's bounded memory and the allowlist entry with its reason (the first
 *   half of the last scenario's THEN) are task 8.5.
 * - "An unknown directive is counted as other" is covered by task 8.3's unit test.
 *
 * ## Harness
 *
 * The real server (`createApp`, `app.inject`, never a listener) over the in-memory telemetry
 * harness, registered by `./__fixtures__/link-telemetry.js` as the first same-package import
 * (the OTel metrics API has no proxy meter provider). `harness.reset()` runs before every case,
 * so each case reads only its own signals (delta temporality). Every request carries a fresh
 * random `x-forwarded-for` (trusted under the test list of 048 D2), so the per-address budget
 * of Q26 never interferes. Requests carry no `Origin` and no CSRF header, like a browser's
 * report.
 *
 * ## Production symbols expected (the red phase)
 *
 * `createApp` (`./server.js`) mounts `POST /v1/csp-reports`. Until it does, the `/v1`
 * media-type hook answers `415` to both report media types, so every `204` assertion fails.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const ROUTE = '/v1/csp-reports';
const CSP_REPORT = 'application/csp-report';
const REPORTS_JSON = 'application/reports+json';
const METRIC = 'tayzu.web.csp_violations';
const DIRECTIVE = 'tayzu.web.csp.directive';
/** D9: the route scope's `bodyLimit`, 8 KiB. */
const BODY_LIMIT = 8192;

type Attributes = Readonly<Record<string, unknown>>;

interface CounterPoint {
  readonly attributes: Attributes;
  readonly value: number;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `the telemetry test harness failed to register while the module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

/** A legacy `csp-report` body of exactly `bytes` bytes (ASCII), whose directive is readable. */
function legacyReportOfSize(bytes: number): string {
  const base = JSON.stringify({
    'csp-report': { 'effective-directive': 'img-src', 'script-sample': '' },
  });
  const padding = 'a'.repeat(bytes - base.length);
  const body = JSON.stringify({
    'csp-report': { 'effective-directive': 'img-src', 'script-sample': padding },
  });
  if (Buffer.byteLength(body) !== bytes) {
    throw new Error(
      `fixture error: built ${String(Buffer.byteLength(body))} bytes, not ${String(bytes)}`,
    );
  }
  return body;
}

/** A `reports+json` body of exactly `bytes` bytes (ASCII), with one readable violation. */
function reportingBatchOfSize(bytes: number): string {
  const build = (sample: string): string =>
    JSON.stringify([
      {
        type: 'csp-violation',
        age: 0,
        url: 'https://app.tayzu.test/',
        user_agent: 'test',
        body: { effectiveDirective: 'img-src', sample },
      },
    ]);
  const body = build('a'.repeat(bytes - build('').length));
  if (Buffer.byteLength(body) !== bytes) {
    throw new Error(
      `fixture error: built ${String(Buffer.byteLength(body))} bytes, not ${String(bytes)}`,
    );
  }
  return body;
}

describe('POST /v1/csp-reports answers 204 and counts (048 task 8.4, design D9)', () => {
  let harness: TelemetryTestHarness;
  let app: App;
  let owner: BootstrappedTenant;

  beforeAll(async () => {
    harness = registeredHarness();
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
    });
    const id = randomUUID();
    owner = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Csp Report Owner ${id}`,
      email: `csp-report-owner-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Csp Report Org ${id}`,
      organizationSlug: `csp-report-${id}`,
      ip: randomIp(),
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.reset();
  });

  function post(contentType: string, payload: string, extraHeaders: Record<string, string> = {}) {
    return app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': contentType, 'x-forwarded-for': randomIp(), ...extraHeaders },
      payload,
    });
  }

  /** The `tayzu.web.csp_violations` points exported since the last `reset()`. */
  async function counterPoints(): Promise<CounterPoint[]> {
    await harness.forceFlush();
    const points: CounterPoint[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== METRIC) continue;
          for (const point of metric.dataPoints) {
            points.push({ attributes: point.attributes, value: Number(point.value) });
          }
        }
      }
    }
    return points;
  }

  /** The total counted per directive since the last `reset()`. */
  async function countsByDirective(): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const point of await counterPoints()) {
      const directive = String(point.attributes[DIRECTIVE]);
      totals[directive] = (totals[directive] ?? 0) + point.value;
    }
    return totals;
  }

  /** Every exported span, metric point and log record since the last `reset()`, serialized. */
  async function exportedSignals(): Promise<string[]> {
    await harness.forceFlush();
    const serialized: string[] = [];
    for (const span of harness.spanExporter.getFinishedSpans()) {
      serialized.push(
        JSON.stringify({
          span: span.name,
          attributes: span.attributes,
          status: span.status,
          events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
          links: span.links.map((link) => link.attributes),
        }),
      );
    }
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const point of metric.dataPoints) {
            serialized.push(
              JSON.stringify({ metric: metric.descriptor.name, attributes: point.attributes }),
            );
          }
        }
      }
    }
    for (const record of harness.logExporter.getFinishedLogRecords()) {
      serialized.push(
        JSON.stringify({
          log: record.eventName,
          severity: record.severityText,
          body: record.body,
          attributes: record.attributes,
        }),
      );
    }
    return serialized;
  }

  async function logRecordCount(): Promise<number> {
    await harness.forceFlush();
    return harness.logExporter.getFinishedLogRecords().length;
  }

  describe('Scenario: A report is counted by its directive only', () => {
    it('answers 204, counts once with only the directive script-src, and the marker reaches no span, metric or log record', async () => {
      const marker = `CspReportMarker-${randomUUID()}`;
      const response = await post(
        CSP_REPORT,
        JSON.stringify({
          'csp-report': {
            'document-uri': `https://app.tayzu.test/catalog/${marker}`,
            referrer: `https://app.tayzu.test/${marker}`,
            'violated-directive': 'script-src-elem',
            'effective-directive': 'script-src-elem',
            'original-policy': "script-src 'self'; report-uri /v1/csp-reports",
            disposition: 'enforce',
            'blocked-uri': `https://evil.example.test/${marker}.js`,
            'source-file': `https://app.tayzu.test/assets/${marker}.js`,
            'script-sample': `alert("${marker}")`,
            'status-code': 200,
          },
        }),
      );

      expect(response.statusCode, response.body).toBe(204);
      expect(response.body).toBe('');

      const points = await counterPoints();
      expect(points, 'exactly one data point, with only the mapped directive').toEqual([
        { attributes: { [DIRECTIVE]: 'script-src' }, value: 1 },
      ]);

      const signals = await exportedSignals();
      const leaking = signals.filter((entry) => entry.includes(marker));
      expect(leaking, 'the marker must appear in no exported span, metric or log record').toEqual(
        [],
      );
      expect(await logRecordCount(), 'the route writes no log record per report').toBe(0);
      expect(JSON.stringify(response.headers)).not.toContain(marker);
    });
  });

  describe('Scenario: A Reporting API batch is counted per violation', () => {
    it('answers 204 and counts the two csp-violation reports once each, by their directives, and not the report of another type', async () => {
      const marker = `CspBatchMarker-${randomUUID()}`;
      const response = await post(
        REPORTS_JSON,
        JSON.stringify([
          {
            type: 'csp-violation',
            age: 10,
            url: `https://app.tayzu.test/catalog/${marker}`,
            user_agent: `Mozilla/5.0 ${marker}`,
            body: {
              documentURL: `https://app.tayzu.test/catalog/${marker}`,
              blockedURL: `https://evil.example.test/${marker}.png`,
              effectiveDirective: 'img-src',
              originalPolicy: "img-src 'self'",
              sample: marker,
              disposition: 'enforce',
              statusCode: 200,
            },
          },
          {
            type: 'deprecation',
            age: 10,
            url: `https://app.tayzu.test/catalog/${marker}`,
            user_agent: `Mozilla/5.0 ${marker}`,
            body: { id: 'SomeDeprecation', message: marker, effectiveDirective: 'font-src' },
          },
          {
            type: 'csp-violation',
            age: 12,
            url: `https://app.tayzu.test/catalog/${marker}`,
            user_agent: `Mozilla/5.0 ${marker}`,
            body: {
              documentURL: `https://app.tayzu.test/catalog/${marker}`,
              blockedURL: `https://evil.example.test/${marker}`,
              effectiveDirective: 'connect-src',
              originalPolicy: "connect-src 'self'",
              sample: marker,
              disposition: 'enforce',
              statusCode: 200,
            },
          },
        ]),
      );

      expect(response.statusCode, response.body).toBe(204);
      expect(response.body).toBe('');

      expect(await countsByDirective()).toEqual({ 'img-src': 1, 'connect-src': 1 });
      for (const point of await counterPoints()) {
        expect(Object.keys(point.attributes), 'one attribute only').toEqual([DIRECTIVE]);
      }
      const leaking = (await exportedSignals()).filter((entry) => entry.includes(marker));
      expect(leaking, 'no field but the directive reaches a signal').toEqual([]);
    });
  });

  describe('Scenario: A malformed, hostile or oversized report still answers 204', () => {
    const cases: readonly (readonly [label: string, contentType: string, payload: string])[] = [
      ['a csp-report that is not JSON', CSP_REPORT, 'this is not json at all'],
      ['a truncated csp-report', CSP_REPORT, '{"csp-report":{"effective-directive":"img-src"'],
      ['a reports+json body that is not JSON', REPORTS_JSON, '[{"type":"csp-violation",'],
      [
        'a csp-report with a top-level __proto__ key',
        CSP_REPORT,
        '{"__proto__":{"effective-directive":"img-src"},"csp-report":{"effective-directive":"img-src"}}',
      ],
      [
        'a csp-report with a nested __proto__ key',
        CSP_REPORT,
        '{"csp-report":{"effective-directive":"img-src","x":{"y":{"__proto__":{"polluted":true}}}}}',
      ],
      [
        'a csp-report with a constructor key',
        CSP_REPORT,
        '{"csp-report":{"effective-directive":"img-src","constructor":{"prototype":{"polluted":true}}}}',
      ],
      [
        'a csp-report with a nested prototype key',
        CSP_REPORT,
        '{"csp-report":{"effective-directive":"img-src","a":[{"prototype":{}}]}}',
      ],
      [
        'a reports+json entry with a __proto__ key in its body',
        REPORTS_JSON,
        '[{"type":"csp-violation","body":{"effectiveDirective":"img-src","__proto__":{"polluted":true}}}]',
      ],
      [
        'a reports+json entry with a constructor key',
        REPORTS_JSON,
        '[{"type":"csp-violation","constructor":{},"body":{"effectiveDirective":"img-src"}}]',
      ],
      ['a csp-report of 8 KiB and one byte', CSP_REPORT, legacyReportOfSize(BODY_LIMIT + 1)],
      ['a csp-report of 64 KiB', CSP_REPORT, legacyReportOfSize(64 * 1024)],
      [
        'a reports+json body of 8 KiB and one byte',
        REPORTS_JSON,
        reportingBatchOfSize(BODY_LIMIT + 1),
      ],
    ];

    it.each(cases)(
      '%s answers 204 with no body, counts nothing and logs nothing',
      async (_label, contentType, payload) => {
        const response = await post(contentType, payload);

        expect(response.statusCode, response.body).toBe(204);
        expect(response.body).toBe('');
        expect(await counterPoints(), 'nothing is counted').toEqual([]);
        expect(await logRecordCount(), 'no internal error (no record at all) is logged').toBe(0);
        expect(({} as Record<string, unknown>)['polluted'], 'no prototype was polluted').toBe(
          undefined,
        );
      },
    );

    it('the limit is 8 KiB: a well-formed report of exactly 8192 bytes is still counted, in both formats', async () => {
      const legacy = await post(CSP_REPORT, legacyReportOfSize(BODY_LIMIT));
      expect(legacy.statusCode, legacy.body).toBe(204);
      const batch = await post(REPORTS_JSON, reportingBatchOfSize(BODY_LIMIT));
      expect(batch.statusCode, batch.body).toBe(204);

      expect(await countsByDirective()).toEqual({ 'img-src': 2 });
    });
  });

  describe('Scenario: The report route is public and reads no session', () => {
    it('a request without a cookie and one with a valid session cookie both answer 204 with no body, are counted the same way, and no session is looked up', async () => {
      const api = app.auth.api as { getSession(args: unknown): Promise<unknown> };
      const getSession = vi.spyOn(api, 'getSession');
      const report = JSON.stringify({
        'csp-report': { 'effective-directive': 'frame-ancestors' },
      });

      const anonymous = await post(CSP_REPORT, report);
      const withSession = await post(CSP_REPORT, report, {
        cookie: owner.cookie,
        authorization: 'Bearer not-a-real-token',
      });

      for (const [label, response] of [
        ['without a cookie', anonymous],
        ['with a session cookie', withSession],
      ] as const) {
        expect(response.statusCode, `${label}: ${response.body}`).toBe(204);
        expect(response.body, label).toBe('');
      }
      expect(getSession, 'the route never looks a session up').not.toHaveBeenCalled();

      const points = await counterPoints();
      expect(await countsByDirective()).toEqual({ 'frame-ancestors': 2 });
      for (const point of points) {
        expect(point.attributes, 'no tenant or actor even with a session').toEqual({
          [DIRECTIVE]: 'frame-ancestors',
        });
      }

      // The spy does observe a session lookup: the same cookie on `GET /v1/me` is read.
      const me = await app.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { cookie: owner.cookie, 'x-forwarded-for': randomIp() },
      });
      expect(me.statusCode, me.body).toBe(200);
      expect(
        getSession,
        'control: /v1/me reads the session through the spied API',
      ).toHaveBeenCalled();
    });
  });
});
