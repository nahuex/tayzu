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
 * // Reads `api_messages.json`, which scripts/ci/zap-api-hook.py writes from
 * // ZAP's history (`core.messages`): `{ messages: [{ requestHeader,
 * // responseHeader }] }`, each the first line of the raw header (the request
 * // line `GET http://host/v1/x HTTP/1.1`, the status line). The `-J` report
 * // has no headers and ZAP's alert reports never list a 2xx. Only messages
 * // whose request path starts with `/v1/` are operations.
 * export function measureDastCoverage(report: unknown): DastCoverage;
 * // Throws an Error when `successResponses` is 0 (including an empty or
 * // malformed report, or one with no `responseHeader` field at all: fail
 * // closed). The message carries counts only, never a
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
import {
  assertDastCoverage,
  assertProbeCoverage,
  measureDastCoverage,
} from '../../../scripts/ci/dast-coverage.js';

const ORIGIN = 'http://localhost:3000';

function instance(method: string, path: string, status: number, reason: string): Message {
  return {
    requestHeader: `${method} ${ORIGIN}${path} HTTP/1.1`,
    responseHeader: `HTTP/1.1 ${String(status)} ${reason}`,
  };
}

/** The shape of a trimmed real `api_messages.json` (ZAP 2.17 `core.messages`). */
type Message = Record<string, string>;

/** A site-tree node ZAP lists without ever having sent it: status `0`. */
const unsent: Message = {
  requestHeader: `GET ${ORIGIN}/v1/blueprints HTTP/1.1`,
  responseHeader: 'HTTP/1.0 0',
};

function report(messages: Message[]): unknown {
  return { messages };
}

const onlyRefusals = report([
  unsent,
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
        requestHeader: `GET ${ORIGIN}/v1/entities HTTP/1.1`,
        responseHeader: 'x-note: HTTP/1.1 200 OK',
      },
    ]);
    expect(() => assertDastCoverage(forged)).toThrow();
  });

  it('fails closed when the report has no header fields at all', () => {
    // The shape of ZAP's `-J` report: alert instances without any header.
    const noHeaders = {
      site: [
        {
          alerts: [
            { instances: [{ uri: `${ORIGIN}/v1/entities`, method: 'GET', attack: '', param: '' }] },
          ],
        },
      ],
    };
    expect(() => assertDastCoverage(noHeaders)).toThrow('no response header fields');
    expect(() => assertDastCoverage(report([{ uri: `${ORIGIN}/v1/entities` }]))).toThrow(
      'no response header fields',
    );
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

/**
 * 044 task 14.2 (design D17): `dast-coverage.ts`'s rule counts the probe's
 * responses. Expected production symbol, in `scripts/ci/dast-coverage.ts`:
 *
 * ```ts
 * export interface ProbeCoverage {
 *   responses: number;                // every response in the probe result
 *   requestRouteSuccesses: number;    // of those, 2xx on /v1/auth/password-reset/request
 * }
 * // Input: the probe result `{ findings, responses: [{ path, status }] }`.
 * // Throws when requestRouteSuccesses is 0 (fail closed on a malformed input);
 * // the message starts with `DAST probe` (`DAST probe saw no 2xx ...` for the
 * // rule) and carries counts only.
 * export function assertProbeCoverage(result: unknown): ProbeCoverage;
 * ```
 *
 * `main` accepts `--probe <file>` to check a probe result file with it.
 */
describe('probe coverage (044 task 14.2)', () => {
  const REQUEST = '/v1/auth/password-reset/request';
  const probeResult = (responses: { path: string; status: number }[]): unknown => ({
    findings: [],
    responses,
  });

  it('counts the probe responses and passes with a 2xx on the request route', () => {
    const coverage = assertProbeCoverage(
      probeResult([
        { path: '/v1/auth/invitations/accept', status: 400 },
        { path: REQUEST, status: 202 },
        { path: REQUEST, status: 429 },
        { path: '/v1/auth/password-reset/confirm', status: 400 },
      ]),
    );
    expect(coverage.responses).toBe(4);
    expect(coverage.requestRouteSuccesses).toBe(1);
  });

  it('coverage fails when the probe saw no 2xx on the request route', () => {
    const refusals = probeResult([
      { path: '/v1/auth/invitations/accept', status: 200 },
      { path: '/v1/auth/password-reset/confirm', status: 200 },
      { path: REQUEST, status: 403 },
      { path: REQUEST, status: 429 },
    ]);
    expect(() => assertProbeCoverage(refusals)).toThrow(/^DAST probe saw no 2xx/);
  });

  it('fails closed on an empty or malformed probe result', () => {
    for (const bad of [{}, null, 'oops', 42, probeResult([]), { responses: 'x' }]) {
      expect(() => assertProbeCoverage(bad)).toThrow(/^DAST probe/);
    }
  });

  it('the failure message carries counts only, never a path or value', () => {
    let message = '';
    try {
      assertProbeCoverage(probeResult([{ path: REQUEST, status: 429 }]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^DAST probe/);
    expect(message).not.toContain('/v1/');
    expect(message).not.toContain('password-reset');
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

  it('invokes scripts/ci/dast-coverage.ts on api_messages.json inside api_scan', () => {
    expect(body).not.toBe('');
    expect(body).toContain('scripts/ci/dast-coverage.ts');
    expect(body).toContain('api_messages.json');
    expect(body).toContain('--hook');
  });
});
