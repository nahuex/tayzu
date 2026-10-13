/**
 * Unit test for `043` task 13.13 (spec requirement "The hand-offs from the
 * authentication baseline hold", `002` VCDM M18): the DAST API scan MUST fail
 * when it sees no 2xx operation response, so a scan that only ever received
 * 401 or 415 cannot pass silently. The SSO, back-channel and re-auth surfaces
 * are deferred to `010` (design Risks).
 *
 * This file lives in `apps/api/src` only because the Vitest projects glob
 * `src/**`; `scripts/ci` is outside every package (like `zap-seed.test.ts`).
 *
 * ## Production symbols expected
 *
 * ```ts
 * // scripts/ci/dast-coverage.ts (does not exist yet)
 * export interface DastCoverage {
 *   operationResponses: number; // responses to `/v1/*` operation requests in the report
 *   successResponses: number;   // of those, the ones with a 2xx status
 * }
 * // Reads the ZAP JSON report (`-J`, `site[].alerts[].instances[]`, each
 * // instance carrying `uri`, `method` and the raw `responseheader` whose first
 * // line is the status line). Only instances whose URI path starts with `/v1/`
 * // are operations.
 * export function measureDastCoverage(report: unknown): DastCoverage;
 * // Throws an Error when `successResponses` is 0 (including an empty or
 * // malformed report: fail closed). The message carries counts only, never a
 * // URI, header or body.
 * export function assertDastCoverage(report: unknown): DastCoverage;
 * ```
 *
 * `main` (guarded like zap-seed.ts) reads the file named by argv[2], exits
 * non-zero when `assertDastCoverage` throws, and `dast.sh api-scan` runs it
 * on `api_report_json.json`.
 *
 * ## Why this fails right now
 *
 * `../../../scripts/ci/dast-coverage.js` does not exist ("Cannot find module"
 * is the only cause).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The module under test. Does not exist yet.
import { assertDastCoverage, measureDastCoverage } from '../../../scripts/ci/dast-coverage.js';

const ORIGIN = 'http://localhost:3000';

function instance(
  method: string,
  path: string,
  status: number,
  reason: string,
): Record<string, string> {
  return {
    uri: `${ORIGIN}${path}`,
    method,
    requestheader: `${method} ${path} HTTP/1.1\r\nhost: localhost:3000\r\n`,
    responseheader: `HTTP/1.1 ${String(status)} ${reason}\r\ncontent-type: application/json\r\n`,
  };
}

function report(instances: Record<string, string>[]): unknown {
  return {
    '@programName': 'ZAP',
    site: [
      {
        '@name': ORIGIN,
        alerts: [{ pluginid: '10049', name: 'Storable and Cacheable Content', instances }],
      },
    ],
  };
}

const onlyRefusals = report([
  instance('GET', '/v1/entities', 401, 'Unauthorized'),
  instance('POST', '/v1/entities', 415, 'Unsupported Media Type'),
  instance('DELETE', '/v1/entities/abc', 401, 'Unauthorized'),
]);

const withSuccess = report([
  instance('GET', '/v1/entities', 401, 'Unauthorized'),
  instance('GET', '/v1/entities', 200, 'OK'),
  instance('POST', '/v1/entities', 201, 'Created'),
]);

describe('DAST API scan: 2xx coverage check (task 13.13)', () => {
  it('fails a report whose operation responses are all 401 or 415', () => {
    expect(() => assertDastCoverage(onlyRefusals)).toThrow();
    const coverage = measureDastCoverage(onlyRefusals);
    expect(coverage.operationResponses).toBe(3);
    expect(coverage.successResponses).toBe(0);
  });

  it('passes a report with 2xx operation responses', () => {
    const coverage = assertDastCoverage(withSuccess);
    expect(coverage.operationResponses).toBe(3);
    expect(coverage.successResponses).toBe(2);
  });

  it('does not count a 2xx on a non-operation URL (health check, static page)', () => {
    const nonOperation = report([
      instance('GET', '/healthz', 200, 'OK'),
      instance('GET', '/', 200, 'OK'),
      instance('GET', '/v1/entities', 401, 'Unauthorized'),
    ]);
    expect(measureDastCoverage(nonOperation).successResponses).toBe(0);
    expect(() => assertDastCoverage(nonOperation)).toThrow();
  });

  it('does not count 3xx, 4xx or 5xx as success', () => {
    const noSuccess = report([
      instance('GET', '/v1/a', 301, 'Moved Permanently'),
      instance('GET', '/v1/b', 404, 'Not Found'),
      instance('GET', '/v1/c', 500, 'Internal Server Error'),
    ]);
    expect(() => assertDastCoverage(noSuccess)).toThrow();
  });

  it('fails closed on an empty or malformed report', () => {
    for (const bad of [{}, { site: [] }, report([]), null, 'oops', 42, { site: 'x' }]) {
      expect(() => assertDastCoverage(bad)).toThrow();
    }
  });

  it('fails closed on a 2xx-looking response that is not a status line', () => {
    const forged = report([
      {
        uri: `${ORIGIN}/v1/entities`,
        method: 'GET',
        responseheader: 'x-note: HTTP/1.1 200 OK\r\n',
      },
    ]);
    expect(() => assertDastCoverage(forged)).toThrow();
  });

  it('the failure message carries counts only, never a URI or header', () => {
    let message = '';
    try {
      assertDastCoverage(onlyRefusals);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('/v1/');
    expect(message).not.toContain('localhost');
    expect(message).not.toContain('content-type');
  });
});

describe('dast.sh api-scan runs the check on its report (task 13.13)', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../../../scripts/ci/dast.sh', import.meta.url)),
    'utf8',
  );
  const start = script.indexOf('api_scan() {');
  const end = script.indexOf('\ndown() {');
  const body = start >= 0 && end > start ? script.slice(start, end) : '';

  it('invokes scripts/ci/dast-coverage.ts on api_report_json.json inside api_scan', () => {
    expect(body).not.toBe('');
    expect(body).toContain('scripts/ci/dast-coverage.ts');
    expect(body).toContain('api_report_json.json');
  });
});
