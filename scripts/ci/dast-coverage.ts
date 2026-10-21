/**
 * DAST API scan coverage check (task 13.13, `002` VCDM M18). A ZAP report in
 * which no `/v1/*` operation answered 2xx means the scan only ever met 401 or
 * 415, so it must fail instead of passing silently. Failure messages carry
 * counts only, never a URI, header or body.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface DastCoverage {
  /** Responses to `/v1/*` operation requests found in the report. */
  operationResponses: number;
  /** Of those, the ones with a 2xx status. */
  successResponses: number;
}

const STATUS_LINE = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})(?:[ \t]|$)/;
const REQUEST_LINE = /^[A-Z]+[ \t]+(\S+)[ \t]+HTTP\/\d/;

/**
 * The report is `api_messages.json`, written by `zap-api-hook.py` from ZAP's
 * own history (`core.messages`): `{ messages: [{ requestHeader, responseHeader }] }`,
 * each field holding the first line of the raw header (request or status line).
 * The `-J` report has no headers, and a 2xx raises no alert, so no ZAP report
 * template would list it.
 */
function messages(report: unknown): Record<string, unknown>[] {
  if (typeof report !== 'object' || report === null) return [];
  const list = (report as Record<string, unknown>)['messages'];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

function operationPath(requestHeader: unknown): string | undefined {
  if (typeof requestHeader !== 'string') return undefined;
  const target = REQUEST_LINE.exec(requestHeader.split(/\r?\n/, 1)[0] ?? '')?.[1];
  if (target === undefined) return undefined;
  try {
    const { pathname } = new URL(target);
    return pathname.startsWith('/v1/') ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/** The status of a raw response header block; only its first line counts. */
function statusOf(responseHeader: unknown): number | undefined {
  if (typeof responseHeader !== 'string') return undefined;
  const firstLine = responseHeader.split(/\r?\n/, 1)[0] ?? '';
  const match = STATUS_LINE.exec(firstLine);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function measureDastCoverage(report: unknown): DastCoverage {
  let operationResponses = 0;
  let successResponses = 0;
  for (const message of messages(report)) {
    if (operationPath(message['requestHeader']) === undefined) continue;
    const status = statusOf(message['responseHeader']);
    if (status === undefined) continue;
    operationResponses += 1;
    if (status >= 200 && status < 300) successResponses += 1;
  }
  return { operationResponses, successResponses };
}

export function assertDastCoverage(report: unknown): DastCoverage {
  // Fail closed: a report without any header field is a format change (or a
  // hook that did not run), never a scan result.
  if (!messages(report).some((message) => typeof message['responseHeader'] === 'string')) {
    throw new Error('DAST API scan report has no response header fields');
  }
  const coverage = measureDastCoverage(report);
  if (coverage.successResponses === 0) {
    throw new Error(
      `DAST API scan saw no 2xx operation response (${String(coverage.operationResponses)} operation responses, 0 successful)`,
    );
  }
  return coverage;
}

export interface ProbeCoverage {
  /** Every response in the probe result. */
  responses: number;
  /** Of those, the 2xx answers of the password-reset request route. */
  requestRouteSuccesses: number;
}

const PROBE_REQUEST_ROUTE = '/v1/auth/password-reset/request';

/** Counts the DAST probe's responses (044 task 14.2); fails closed, with counts only. */
export function assertProbeCoverage(result: unknown): ProbeCoverage {
  const list =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)['responses']
      : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('DAST probe result has no responses');
  }
  let requestRouteSuccesses = 0;
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, status } = item as Record<string, unknown>;
    if (
      path === PROBE_REQUEST_ROUTE &&
      typeof status === 'number' &&
      status >= 200 &&
      status < 300
    ) {
      requestRouteSuccesses += 1;
    }
  }
  if (requestRouteSuccesses === 0) {
    throw new Error(
      `DAST probe saw no 2xx on the request route (${String(list.length)} responses, 0 successful)`,
    );
  }
  return { responses: list.length, requestRouteSuccesses };
}

function mainProbe(path: string): void {
  try {
    const coverage = assertProbeCoverage(JSON.parse(readFileSync(path, 'utf8')));
    console.log(
      `DAST probe coverage: ${String(coverage.responses)} responses, ${String(coverage.requestRouteSuccesses)} 2xx on the request route.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('DAST probe')
        ? error.message
        : 'DAST probe result could not be read',
    );
    process.exit(1);
  }
}

function main(): void {
  if (process.argv[2] === '--probe' && process.argv[3] !== undefined) {
    mainProbe(process.argv[3]);
    return;
  }
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: dast-coverage.ts <api_messages.json>');
    process.exit(2);
  }
  try {
    const coverage = assertDastCoverage(JSON.parse(readFileSync(path, 'utf8')));
    console.log(
      `DAST API scan coverage: ${String(coverage.successResponses)} of ${String(coverage.operationResponses)} operation responses were 2xx.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('DAST API scan')
        ? error.message
        : 'DAST API scan report could not be read',
    );
    process.exit(1);
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  main();
}
