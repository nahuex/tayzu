/**
 * Unit test for task 8.3 of change `048-production-hardening` (design D9, Resolved decisions
 * Q10 and Q26): a CSP violation report is reduced to its directive.
 *
 * Task 8.3: "A report is reduced to its directive (design D9). Verify:
 * `apps/api/src/csp-report.test.ts` covers the parse and the mapping: `csp-report` with
 * `effective-directive` and with only `violated-directive`, a `reports+json` array (only
 * `csp-violation` entries, at most 20), the level-3 sub-directives, "An unknown directive is
 * counted as other", forbidden keys at every depth, and that no field other than the
 * directive is read (a getter-trapped fixture)."
 *
 * Design D9 "Parse": "The body is parsed into null-prototype objects by the shared strict
 * parser of the identity procedures (refusing `__proto__`, `constructor` and `prototype` at
 * every depth). For `application/csp-report`, the only field read is
 * `csp-report["effective-directive"]`, falling back to `csp-report["violated-directive"]`'s
 * first token; for `application/reports+json`, an array of at most 20 entries, each entry
 * whose `type` is `csp-violation` contributes `body.effectiveDirective`. No other field is
 * ever read: not `document-uri`, `blocked-uri`, `source-file`, `script-sample`, `referrer`,
 * `status-code`, `disposition`, `url` or `user_agent`."
 *
 * Design D9 "Mapping": "`script-src-elem` and `script-src-attr` count as `script-src`,
 * `style-src-elem` and `style-src-attr` as `style-src`; any other value that is one of the 14
 * names of `CSP_DIRECTIVES` counts as itself; anything else as `other`."
 *
 * Q26: "at most 20 entries counted per `reports+json` body".
 *
 * Spec `catalog-ui-core` "Content Security Policy violation reports are counted without their
 * content" (excerpt): "It MUST parse a body into null-prototype objects, refusing
 * `__proto__`, `constructor` and `prototype` at every depth [...] and read only the effective
 * or violated directive of each report, never its document, blocked or source URL, sample,
 * referrer, status, disposition or any other field. [...] a report [...] with no readable
 * directive, MUST be dropped without being counted."
 *
 * > #### Scenario: An unknown directive is counted as other
 * >
 * > - **WHEN** a report names a directive that is not in the policy
 * > - **THEN** the counter is incremented with the directive `other`
 *
 * > #### Scenario: A malformed, hostile or oversized report still answers 204
 * >
 * > - **WHEN** a report is not JSON, holds a `__proto__`, `constructor` or `prototype` key at
 * >   any depth, or exceeds 8 KiB
 * > - **THEN** the answer is `204`, nothing is counted, and no internal error is logged
 *
 * (The `204`, the 8 KiB limit and the counter itself are the route's, tasks 8.4 and 8.5; this
 * test pins the pure part: "nothing is counted" is an empty result, and the parse never
 * throws.)
 *
 * ## API assumed (D9 names no module or function)
 *
 * `apps/api/src/csp-report.ts` exports:
 *
 * - `parseCspReport(contentType: string, body: string): readonly CspDirective[]`: the raw
 *   body (the route's string parser hands it over as text) through the shared strict parse
 *   and the extraction; one element per counted violation, in body order. Never throws.
 * - `readCspDirectives(contentType: string, report: unknown): readonly CspDirective[]`: the
 *   extraction and mapping step over an already-screened value (what `parseCspReport` calls
 *   after the strict parse). It exists so that the getter-trapped fixture can prove that no
 *   field other than the directive (and, for `reports+json`, the entry's `type`) is read.
 * - `type CspDirective`: the 15 values of `tayzu.web.csp.directive` in the identity contract.
 *
 * `contentType` is the bare media type, `application/csp-report` or
 * `application/reports+json` (the route refuses every other type before parsing, D9 "Route").
 */
import { describe, expect, it } from 'vitest';

import { parseCspReport, readCspDirectives } from './csp-report.js';
import type { CspDirective } from './csp-report.js';

const CSP_REPORT = 'application/csp-report';
const REPORTS_JSON = 'application/reports+json';

/** The closed value list of `tayzu.web.csp.directive` (identity contract, task 8.1). */
const DIRECTIVE_VALUES: readonly CspDirective[] = [
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
];

/** The 14 names of `CSP_DIRECTIVES` that count as themselves (D9 "Mapping"). */
const POLICY_DIRECTIVES = DIRECTIVE_VALUES.filter((value) => value !== 'other');

const MARKER = 'csp-report-marker-7f3a';

/** A legacy `application/csp-report` body, as Firefox and Safari send it. */
function legacyReport(fields: Record<string, unknown>): string {
  return JSON.stringify({
    'csp-report': {
      'document-uri': `https://app.example/${MARKER}`,
      referrer: `https://ref.example/${MARKER}`,
      'blocked-uri': `https://evil.example/${MARKER}`,
      'original-policy': `default-src 'self' ${MARKER}`,
      disposition: 'enforce',
      'status-code': 200,
      'source-file': `https://app.example/${MARKER}.js`,
      'script-sample': MARKER,
      'line-number': 1,
      'column-number': 2,
      ...fields,
    },
  });
}

/** One Reporting API entry, as Chromium sends it inside an `application/reports+json` array. */
function reportingEntry(type: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    age: 10,
    type,
    url: `https://app.example/${MARKER}`,
    user_agent: `Mozilla/5.0 ${MARKER}`,
    body: {
      documentURL: `https://app.example/${MARKER}`,
      referrer: `https://ref.example/${MARKER}`,
      blockedURL: `https://evil.example/${MARKER}`,
      originalPolicy: `default-src 'self' ${MARKER}`,
      disposition: 'enforce',
      statusCode: 200,
      sourceFile: `https://app.example/${MARKER}.js`,
      sample: MARKER,
      lineNumber: 1,
      columnNumber: 2,
      ...body,
    },
  };
}

function violation(effectiveDirective: string): Record<string, unknown> {
  return reportingEntry('csp-violation', { effectiveDirective });
}

/** Runs `fn` and fails the test, rather than throwing out of it, if `fn` throws. */
function neverThrows<T>(fn: () => T): T {
  let result: T | undefined;
  expect(() => {
    result = fn();
  }).not.toThrow();
  return result as T;
}

describe('parseCspReport: application/csp-report', () => {
  it('reads effective-directive', () => {
    expect(parseCspReport(CSP_REPORT, legacyReport({ 'effective-directive': 'img-src' }))).toEqual([
      'img-src',
    ]);
  });

  it('prefers effective-directive over violated-directive', () => {
    const body = legacyReport({
      'effective-directive': 'img-src',
      'violated-directive': "script-src 'self'",
    });
    expect(parseCspReport(CSP_REPORT, body)).toEqual(['img-src']);
  });

  it('falls back to the first token of violated-directive when effective-directive is absent', () => {
    expect(
      parseCspReport(CSP_REPORT, legacyReport({ 'violated-directive': "script-src 'self'" })),
    ).toEqual(['script-src']);
  });

  it('maps the first token of a violated-directive that is a level-3 sub-directive', () => {
    expect(
      parseCspReport(
        CSP_REPORT,
        legacyReport({ 'violated-directive': "style-src-attr 'self' 'nonce-abc'" }),
      ),
    ).toEqual(['style-src']);
  });

  it('counts a bare violated-directive with no source list', () => {
    expect(parseCspReport(CSP_REPORT, legacyReport({ 'violated-directive': 'frame-src' }))).toEqual(
      ['frame-src'],
    );
  });

  it.each(POLICY_DIRECTIVES)('counts the policy directive %s as itself', (directive) => {
    expect(parseCspReport(CSP_REPORT, legacyReport({ 'effective-directive': directive }))).toEqual([
      directive,
    ]);
  });

  it('counts nothing when the report has no directive at all', () => {
    expect(neverThrows(() => parseCspReport(CSP_REPORT, legacyReport({})))).toEqual([]);
  });
});

describe('parseCspReport: application/reports+json', () => {
  it('counts only the csp-violation entries, one per violation, in order', () => {
    const body = JSON.stringify([
      violation('script-src'),
      reportingEntry('deprecation', { effectiveDirective: 'img-src', id: 'x', message: MARKER }),
      violation('connect-src'),
      reportingEntry('intervention', { effectiveDirective: 'font-src' }),
    ]);
    expect(parseCspReport(REPORTS_JSON, body)).toEqual(['script-src', 'connect-src']);
  });

  it('counts at most 20 entries of one body', () => {
    const body = JSON.stringify(Array.from({ length: 25 }, () => violation('img-src')));
    const counted = neverThrows(() => parseCspReport(REPORTS_JSON, body));
    expect(counted).toHaveLength(20);
    expect(counted).toEqual(Array.from({ length: 20 }, () => 'img-src'));
  });

  it('counts all 20 entries of a body of exactly 20', () => {
    const body = JSON.stringify(Array.from({ length: 20 }, () => violation('media-src')));
    expect(parseCspReport(REPORTS_JSON, body)).toHaveLength(20);
  });

  it('counts nothing for an array with no csp-violation entry', () => {
    const body = JSON.stringify([
      reportingEntry('deprecation', { effectiveDirective: 'img-src' }),
      reportingEntry('crash', { effectiveDirective: 'img-src' }),
    ]);
    expect(parseCspReport(REPORTS_JSON, body)).toEqual([]);
  });

  it('skips a csp-violation entry whose body has no effectiveDirective', () => {
    const body = JSON.stringify([reportingEntry('csp-violation', {}), violation('worker-src')]);
    expect(parseCspReport(REPORTS_JSON, body)).toEqual(['worker-src']);
  });

  it('counts nothing for an empty array', () => {
    expect(parseCspReport(REPORTS_JSON, '[]')).toEqual([]);
  });
});

describe('parseCspReport: level-3 sub-directives count under their parent', () => {
  it.each([
    ['script-src-elem', 'script-src'],
    ['script-src-attr', 'script-src'],
    ['style-src-elem', 'style-src'],
    ['style-src-attr', 'style-src'],
  ] as const)('%s counts as %s', (sub, parent) => {
    expect(parseCspReport(CSP_REPORT, legacyReport({ 'effective-directive': sub }))).toEqual([
      parent,
    ]);
    expect(parseCspReport(REPORTS_JSON, JSON.stringify([violation(sub)]))).toEqual([parent]);
  });
});

describe('An unknown directive is counted as other', () => {
  const unknown = [
    'require-trusted-types-for',
    'trusted-types',
    'prefetch-src',
    'navigate-to',
    'not-a-directive',
    MARKER,
    // Values, not keys: a lookup through an ordinary object must not turn these into
    // something other than `other`.
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ];

  it.each(unknown)('effective-directive %s counts as other (csp-report)', (directive) => {
    expect(parseCspReport(CSP_REPORT, legacyReport({ 'effective-directive': directive }))).toEqual([
      'other',
    ]);
  });

  it.each(unknown)('effectiveDirective %s counts as other (reports+json)', (directive) => {
    expect(parseCspReport(REPORTS_JSON, JSON.stringify([violation(directive)]))).toEqual(['other']);
  });

  it('the first token of an unknown violated-directive counts as other', () => {
    expect(
      parseCspReport(CSP_REPORT, legacyReport({ 'violated-directive': "trusted-types 'none'" })),
    ).toEqual(['other']);
  });

  it('every counted value is one of the declared values of tayzu.web.csp.directive', () => {
    const body = JSON.stringify([
      violation('script-src-elem'),
      violation('img-src'),
      violation(MARKER),
      violation('sandbox'),
    ]);
    const counted = parseCspReport(REPORTS_JSON, body);
    expect(counted).toHaveLength(4);
    for (const directive of counted) expect(DIRECTIVE_VALUES).toContain(directive);
  });
});

describe('parseCspReport: forbidden keys at every depth count nothing', () => {
  const forbidden = ['__proto__', 'constructor', 'prototype'] as const;

  it.each(forbidden)('%s at the top level of a csp-report body', (key) => {
    const body = `{"${key}":{"x":1},"csp-report":{"effective-directive":"img-src"}}`;
    expect(neverThrows(() => parseCspReport(CSP_REPORT, body))).toEqual([]);
  });

  it.each(forbidden)('%s inside the csp-report object', (key) => {
    const body = `{"csp-report":{"effective-directive":"img-src","${key}":{"polluted":true}}}`;
    expect(neverThrows(() => parseCspReport(CSP_REPORT, body))).toEqual([]);
  });

  it.each(forbidden)('%s deep inside a field that is never read (csp-report)', (key) => {
    const body =
      `{"csp-report":{"effective-directive":"img-src",` +
      `"extra":{"a":[{"b":{"${key}":{"polluted":true}}}]}}}`;
    expect(neverThrows(() => parseCspReport(CSP_REPORT, body))).toEqual([]);
  });

  it.each(forbidden)('%s in one entry of a reports+json array counts no entry', (key) => {
    const body =
      `[{"type":"csp-violation","body":{"effectiveDirective":"img-src"}},` +
      `{"type":"csp-violation","body":{"effectiveDirective":"font-src","${key}":{"x":1}}}]`;
    expect(neverThrows(() => parseCspReport(REPORTS_JSON, body))).toEqual([]);
  });

  it.each(forbidden)('%s deep inside a non-violation entry of a reports+json array', (key) => {
    const body =
      `[{"type":"csp-violation","body":{"effectiveDirective":"img-src"}},` +
      `{"type":"deprecation","body":{"nested":[[{"${key}":1}]]}}]`;
    expect(neverThrows(() => parseCspReport(REPORTS_JSON, body))).toEqual([]);
  });

  it('leaves Object.prototype untouched after a __proto__ body', () => {
    const body = '{"csp-report":{"__proto__":{"polluted":"yes"},"effective-directive":"img-src"}}';
    neverThrows(() => parseCspReport(CSP_REPORT, body));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('parseCspReport: malformed bodies and wrong shapes count nothing and never throw', () => {
  const csp: readonly (readonly [string, string])[] = [
    ['not JSON', 'not json at all'],
    ['truncated JSON', '{"csp-report":{"effective-directive":"img-src"'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['a number', '42'],
    ['a string', '"script-src"'],
    ['an array', '[{"csp-report":{"effective-directive":"img-src"}}]'],
    ['an object without csp-report', '{"effective-directive":"img-src"}'],
    ['csp-report null', '{"csp-report":null}'],
    ['csp-report a string', '{"csp-report":"img-src"}'],
    ['csp-report an array', '{"csp-report":[{"effective-directive":"img-src"}]}'],
    ['effective-directive a number', '{"csp-report":{"effective-directive":7}}'],
    ['effective-directive an object', '{"csp-report":{"effective-directive":{"a":"img-src"}}}'],
    ['effective-directive an array', '{"csp-report":{"effective-directive":["img-src"]}}'],
    ['violated-directive a number', '{"csp-report":{"violated-directive":7}}'],
  ];

  it.each(csp)('csp-report: %s', (_label, body) => {
    expect(neverThrows(() => parseCspReport(CSP_REPORT, body))).toEqual([]);
  });

  const reports: readonly (readonly [string, string])[] = [
    ['not JSON', '[{"type":'],
    ['an empty body', ''],
    ['JSON null', 'null'],
    [
      'an object instead of an array',
      '{"type":"csp-violation","body":{"effectiveDirective":"img-src"}}',
    ],
    ['a string', '"csp-violation"'],
    ['an array of non-objects', '[1,"csp-violation",null,true,["img-src"]]'],
    ['an entry with no type', '[{"body":{"effectiveDirective":"img-src"}}]'],
    ['an entry whose type is not a string', '[{"type":7,"body":{"effectiveDirective":"img-src"}}]'],
    ['an entry with no body', '[{"type":"csp-violation"}]'],
    ['an entry whose body is null', '[{"type":"csp-violation","body":null}]'],
    ['an entry whose body is a string', '[{"type":"csp-violation","body":"img-src"}]'],
    ['an entry whose body is an array', '[{"type":"csp-violation","body":["img-src"]}]'],
    [
      'an effectiveDirective that is not a string',
      '[{"type":"csp-violation","body":{"effectiveDirective":{"x":"img-src"}}}]',
    ],
  ];

  it.each(reports)('reports+json: %s', (_label, body) => {
    expect(neverThrows(() => parseCspReport(REPORTS_JSON, body))).toEqual([]);
  });

  it('a body nested far deeper than any report counts nothing and does not throw', () => {
    const depth = 10_000;
    const body = `{"csp-report":{"effective-directive":"img-src","x":${'['.repeat(depth)}${']'.repeat(depth)}}}`;
    expect(neverThrows(() => parseCspReport(CSP_REPORT, body))).toEqual([]);
  });

  it('the result of a malformed body is an array, never undefined', () => {
    expect(Array.isArray(neverThrows(() => parseCspReport(CSP_REPORT, '{')))).toBe(true);
    expect(Array.isArray(neverThrows(() => parseCspReport(REPORTS_JSON, '{')))).toBe(true);
  });
});

/**
 * The getter-trapped fixture: every field the design says is never read is an accessor that
 * records its name when read. `readCspDirectives` gets the object directly (the step after
 * the strict parse), so a read of any of them shows up in `reads`.
 */
function trap(
  target: Record<string, unknown>,
  names: readonly string[],
  reads: string[],
  prefix: string,
): Record<string, unknown> {
  for (const name of names) {
    Object.defineProperty(target, name, {
      enumerable: true,
      configurable: true,
      get() {
        reads.push(`${prefix}${name}`);
        return MARKER;
      },
    });
  }
  return target;
}

function nullObject(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, fields);
}

const LEGACY_UNREAD = [
  'document-uri',
  'referrer',
  'blocked-uri',
  'original-policy',
  'disposition',
  'status-code',
  'source-file',
  'script-sample',
  'line-number',
  'column-number',
] as const;

const REPORTING_UNREAD = ['age', 'url', 'user_agent'] as const;

const REPORTING_BODY_UNREAD = [
  'documentURL',
  'referrer',
  'blockedURL',
  'originalPolicy',
  'disposition',
  'statusCode',
  'sourceFile',
  'sample',
  'lineNumber',
  'columnNumber',
] as const;

describe('readCspDirectives: no field other than the directive is read', () => {
  it('csp-report with effective-directive reads none of the trapped fields', () => {
    const reads: string[] = [];
    const inner = trap(
      nullObject({ 'effective-directive': 'script-src-elem' }),
      LEGACY_UNREAD,
      reads,
      'csp-report.',
    );
    const report = trap(nullObject({ 'csp-report': inner }), ['other-field'], reads, '');

    expect(readCspDirectives(CSP_REPORT, report)).toEqual(['script-src']);
    expect(reads).toEqual([]);
  });

  it('csp-report with only violated-directive reads none of the trapped fields', () => {
    const reads: string[] = [];
    const inner = trap(
      nullObject({ 'violated-directive': "img-src 'self'" }),
      LEGACY_UNREAD,
      reads,
      'csp-report.',
    );
    const report = nullObject({ 'csp-report': inner });

    expect(readCspDirectives(CSP_REPORT, report)).toEqual(['img-src']);
    expect(reads).toEqual([]);
  });

  it('reports+json reads only type and body.effectiveDirective of a csp-violation entry', () => {
    const reads: string[] = [];
    const entry = (directive: string): Record<string, unknown> =>
      trap(
        nullObject({
          type: 'csp-violation',
          body: trap(
            nullObject({ effectiveDirective: directive }),
            REPORTING_BODY_UNREAD,
            reads,
            'body.',
          ),
        }),
        REPORTING_UNREAD,
        reads,
        '',
      );

    expect(
      readCspDirectives(REPORTS_JSON, [entry('style-src-attr'), entry('frame-ancestors')]),
    ).toEqual(['style-src', 'frame-ancestors']);
    expect(reads).toEqual([]);
  });

  it('reports+json never reads the body of an entry of another type', () => {
    const reads: string[] = [];
    const other = trap(
      nullObject({ type: 'deprecation' }),
      ['body', ...REPORTING_UNREAD],
      reads,
      '',
    );

    expect(readCspDirectives(REPORTS_JSON, [other])).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('reports+json never reads an entry past the twentieth', () => {
    const reads: string[] = [];
    const entries: unknown[] = Array.from({ length: 20 }, () =>
      nullObject({ type: 'csp-violation', body: nullObject({ effectiveDirective: 'img-src' }) }),
    );
    for (let index = 20; index < 25; index += 1) {
      entries.push(trap(nullObject({}), ['type', 'body'], reads, `[${String(index)}].`));
    }

    const counted = readCspDirectives(REPORTS_JSON, entries);
    expect(counted).toHaveLength(20);
    expect(reads).toEqual([]);
  });
});
