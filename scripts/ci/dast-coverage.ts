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

function records(value: unknown, key: string): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

function operationPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  try {
    const { pathname } = new URL(uri);
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
  for (const site of records(report, 'site')) {
    for (const alert of records(site, 'alerts')) {
      for (const instance of records(alert, 'instances')) {
        if (operationPath(instance['uri']) === undefined) continue;
        const status = statusOf(instance['responseheader']);
        if (status === undefined) continue;
        operationResponses += 1;
        if (status >= 200 && status < 300) successResponses += 1;
      }
    }
  }
  return { operationResponses, successResponses };
}

export function assertDastCoverage(report: unknown): DastCoverage {
  const coverage = measureDastCoverage(report);
  if (coverage.successResponses === 0) {
    throw new Error(
      `DAST API scan saw no 2xx operation response (${String(coverage.operationResponses)} operation responses, 0 successful)`,
    );
  }
  return coverage;
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: dast-coverage.ts <zap-report.json>');
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
