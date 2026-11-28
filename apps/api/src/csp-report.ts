/**
 * A CSP violation report reduced to its directive (048 design D9 "Parse" and "Mapping",
 * Q10, Q26). The body goes through the shared strict parser of the identity procedures
 * (null-prototype objects, forbidden keys refused at every depth, bounded nesting), and only
 * the directive of each report is ever read: never its URLs, sample, referrer, status,
 * disposition or any other field. Nothing here throws; a body with no readable directive
 * counts nothing.
 */
import { cloneScreened } from './identity/parse-input.js';

/** The closed value list of `tayzu.web.csp.directive` (identity contract, task 8.1). */
const CSP_DIRECTIVE_VALUES = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'object-src',
  'frame-src',
  'worker-src',
  'manifest-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
  'other',
] as const;

export type CspDirective = (typeof CSP_DIRECTIVE_VALUES)[number];

const CSP_REPORT = 'application/csp-report';
const REPORTS_JSON = 'application/reports+json';

/** Q26: at most 20 entries of one `reports+json` body are read. */
const MAX_REPORTING_ENTRIES = 20;

/**
 * D9 "Mapping": the level-3 sub-directives count under their parent, the 14 policy
 * directives as themselves. A `Map`, so that a value such as `constructor` or `__proto__`
 * never resolves through a prototype.
 */
const DIRECTIVE_BY_NAME: ReadonlyMap<string, CspDirective> = new Map<string, CspDirective>([
  ...CSP_DIRECTIVE_VALUES.filter((value) => value !== 'other').map(
    (value) => [value, value] as const,
  ),
  ['script-src-elem', 'script-src'],
  ['script-src-attr', 'script-src'],
  ['style-src-elem', 'style-src'],
  ['style-src-attr', 'style-src'],
]);

function mapDirective(name: string): CspDirective {
  return DIRECTIVE_BY_NAME.get(name) ?? 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one own property, so that nothing is looked up through a prototype. */
function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A directive name, or `undefined` when the value is not a non-empty string. */
function directiveName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name === '' ? undefined : name;
}

/** `csp-report["effective-directive"]`, else the first token of `violated-directive`. */
function readLegacyReport(report: unknown): readonly CspDirective[] {
  if (!isRecord(report)) return [];
  const inner = ownField(report, 'csp-report');
  if (!isRecord(inner)) return [];
  const effective = directiveName(ownField(inner, 'effective-directive'));
  if (effective !== undefined) return [mapDirective(effective)];
  const violated = directiveName(ownField(inner, 'violated-directive'));
  const firstToken = violated?.split(/\s+/u)[0];
  return firstToken === undefined ? [] : [mapDirective(firstToken)];
}

/** `body.effectiveDirective` of each `csp-violation` entry among the first 20. */
function readReportingEntries(report: unknown): readonly CspDirective[] {
  if (!Array.isArray(report)) return [];
  const entries: readonly unknown[] = report;
  const counted: CspDirective[] = [];
  const end = Math.min(entries.length, MAX_REPORTING_ENTRIES);
  for (let index = 0; index < end; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry) || ownField(entry, 'type') !== 'csp-violation') continue;
    const body = ownField(entry, 'body');
    if (!isRecord(body)) continue;
    const effective = directiveName(ownField(body, 'effectiveDirective'));
    if (effective !== undefined) counted.push(mapDirective(effective));
  }
  return counted;
}

/**
 * The extraction and mapping over an already-screened value: one directive per counted
 * violation, in body order. `contentType` is the bare media type; any other type counts
 * nothing.
 */
export function readCspDirectives(contentType: string, report: unknown): readonly CspDirective[] {
  if (contentType === CSP_REPORT) return readLegacyReport(report);
  if (contentType === REPORTS_JSON) return readReportingEntries(report);
  return [];
}

/**
 * Parses a raw report body strictly and reduces it to its directives. A malformed, hostile
 * or over-deep body counts nothing; this never throws.
 */
export function parseCspReport(contentType: string, body: string): readonly CspDirective[] {
  try {
    return readCspDirectives(contentType, cloneScreened(JSON.parse(body)));
  } catch {
    return [];
  }
}
