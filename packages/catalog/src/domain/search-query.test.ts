/**
 * Assumed API of `./search-query.js` (task 3.5; design D5):
 *
 * ```ts
 * interface SearchQueryInput {
 *   q: string;
 *   limit?: number;
 * }
 *
 * interface ParsedSearchQuery {
 *   q: string; // trimmed, then NFC-normalized (the value the trigram match uses)
 *   limit: number; // `input.limit`, or `limits.search.defaultLimit` when absent
 *   prefixPattern: string; // `q` with `\`, `%` and `_` escaped by `\`, then `%`
 * }
 *
 * function parseSearchQuery(input: SearchQueryInput, limits: CatalogLimits): ParsedSearchQuery;
 * ```
 *
 * `CatalogLimits` gains `search: { minQueryLength: number; maxQueryLength:
 * number; defaultLimit: number; maxLimit: number }`, defaulting to
 * `{ minQueryLength: 2, maxQueryLength: 100, defaultLimit: 20, maxLimit: 50 }`
 * (D5) and overridable through `mergeCatalogLimits` like every other entry.
 *
 * Failures (D5, "Limits, checked before any database work"):
 * - a `q` that, after the trim and NFC normalization, is shorter than
 *   `minQueryLength`, longer than `maxQueryLength`, or holds a control
 *   character fails with `CATALOG_VALIDATION_FAILED` and the single issue path
 *   `/q`, never echoing the query text;
 * - a `limit` of 0 or below fails with `CATALOG_VALIDATION_FAILED` and the
 *   single issue path `/limit`, never echoing the value (Q52: malformed input,
 *   not an exceeded limit);
 * - a `limit` above `maxLimit` fails with `CATALOG_LIMIT_EXCEEDED` and
 *   `details.limit` `'search.maxLimit'`, the form `pageSize` uses
 *   (`details: { limit: 'pagination.maxPageSize' }`).
 *
 * The service of task 3.6 calls `parseSearchQuery` before the transaction and
 * hands `q`, `prefixPattern` and `limit` to the repository, which matches
 * `identifier ILIKE $prefix ESCAPE '\'`, `title ILIKE $prefix ESCAPE '\'` and
 * `title % $q`.
 */
import { describe, expect, it } from 'vitest';
import { isCatalogError, type CatalogError, type CatalogErrorCode } from './errors.js';
import { defaultCatalogLimits, mergeCatalogLimits } from './limits.js';
import { parseSearchQuery } from './search-query.js';

const limits = defaultCatalogLimits;

/** `e` followed by U+0301 COMBINING ACUTE ACCENT; its NFC form is `é` (U+00E9). */
const DECOMPOSED_E_ACUTE = 'é';
const COMPOSED_E_ACUTE = 'é';

function catchError(run: () => unknown): CatalogError {
  let thrown: unknown;
  try {
    run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected the call to throw').toBeDefined();
  expect(isCatalogError(thrown), `expected a CatalogError, got ${String(thrown)}`).toBe(true);
  if (!isCatalogError(thrown)) throw new Error('unreachable: isCatalogError was just asserted');
  return thrown;
}

function expectCode(run: () => unknown, code: CatalogErrorCode): CatalogError {
  const error = catchError(run);
  expect(error.code).toBe(code);
  return error;
}

/**
 * D5: "A shorter or longer query fails with `CATALOG_VALIDATION_FAILED` (issue
 * path `/q`)". The query is tenant free text, so it is never echoed back.
 */
function expectInvalidQuery(q: string, overrideLimits = limits): CatalogError {
  const error = expectCode(
    () => parseSearchQuery({ q }, overrideLimits),
    'CATALOG_VALIDATION_FAILED',
  );
  expect(error.issues?.map((issue) => issue.path)).toEqual(['/q']);
  const marker = q.trim();
  if (marker.length > 0) {
    expect(error.message).not.toContain(marker);
    for (const issue of error.issues ?? []) expect(issue.message).not.toContain(marker);
  }
  return error;
}

/** D5: "a larger limit with `CATALOG_LIMIT_EXCEEDED` (`search.maxLimit`)". */
function expectLimitExceeded(limit: number, overrideLimits = limits): CatalogError {
  const error = expectCode(
    () => parseSearchQuery({ q: 'payments', limit }, overrideLimits),
    'CATALOG_LIMIT_EXCEEDED',
  );
  expect(error.details).toMatchObject({ limit: 'search.maxLimit' });
  return error;
}

/**
 * Q52: "A `limit` of 0 or below is rejected with `CATALOG_VALIDATION_FAILED`
 * and issue path `/limit`, before the database". The value is never echoed.
 * For a negative value the check looks for the number as a standalone token;
 * `0` is not checked that way because a message may legitimately state the
 * bound ("greater than 0", "between 1 and 50").
 */
function expectInvalidLimit(limit: number): CatalogError {
  const error = expectCode(
    () => parseSearchQuery({ q: 'payments', limit }, limits),
    'CATALOG_VALIDATION_FAILED',
  );
  expect(error.issues?.map((issue) => issue.path)).toEqual(['/limit']);
  if (limit < 0) {
    const echo = new RegExp(`(?<![0-9])${String(limit)}(?![0-9])`);
    expect(error.message).not.toMatch(echo);
    for (const issue of error.issues ?? []) expect(issue.message).not.toMatch(echo);
  }
  return error;
}

describe('CatalogLimits.search defaults (design D5)', () => {
  it('is { minQueryLength: 2, maxQueryLength: 100, defaultLimit: 20, maxLimit: 50 }', () => {
    expect(defaultCatalogLimits.search).toEqual({
      minQueryLength: 2,
      maxQueryLength: 100,
      defaultLimit: 20,
      maxLimit: 50,
    });
  });
});

describe('query normalization: trimmed, then NFC-normalized (design D5)', () => {
  it('trims leading and trailing whitespace from q', () => {
    expect(parseSearchQuery({ q: '  payments \t\n' }, limits).q).toBe('payments');
  });

  it('keeps inner whitespace and the case of q', () => {
    expect(parseSearchQuery({ q: ' Payments Gateway ' }, limits).q).toBe('Payments Gateway');
  });

  it('turns a decomposed é into the composed form', () => {
    const parsed = parseSearchQuery({ q: `caf${DECOMPOSED_E_ACUTE}` }, limits);

    expect(parsed.q).toBe(`caf${COMPOSED_E_ACUTE}`);
    expect(parsed.q).toBe(parsed.q.normalize('NFC'));
  });

  it('measures the minimum length after the trim', () => {
    expectInvalidQuery('   a   ');
  });

  it('measures the minimum length after NFC normalization (a decomposed é alone is 1 character)', () => {
    expect(DECOMPOSED_E_ACUTE).toHaveLength(2);

    expectInvalidQuery(DECOMPOSED_E_ACUTE);
  });

  it('measures the maximum length after NFC normalization (100 decomposed é are accepted)', () => {
    const q = DECOMPOSED_E_ACUTE.repeat(100);
    expect(q).toHaveLength(200);

    expect(parseSearchQuery({ q }, limits).q).toBe(COMPOSED_E_ACUTE.repeat(100));
  });

  it('measures the maximum length after the trim (100 characters plus surrounding spaces are accepted)', () => {
    const core = 'a'.repeat(100);

    expect(parseSearchQuery({ q: `   ${core}   ` }, limits).q).toBe(core);
  });
});

describe('query bounds: 2 to 100 characters, no control character (design D5)', () => {
  it('rejects a 1-character query with CATALOG_VALIDATION_FAILED on /q', () => {
    expectInvalidQuery('a');
  });

  it('accepts a 2-character query', () => {
    expect(parseSearchQuery({ q: 'ab' }, limits).q).toBe('ab');
  });

  it('accepts a 100-character query', () => {
    const q = 'a'.repeat(100);

    expect(parseSearchQuery({ q }, limits).q).toBe(q);
  });

  it('"Limits are checked before the database": rejects a 101-character query with CATALOG_VALIDATION_FAILED on /q', () => {
    expectInvalidQuery('a'.repeat(101));
  });

  it('rejects an empty query', () => {
    expectInvalidQuery('');
  });

  it('rejects a whitespace-only query after the trim', () => {
    expectInvalidQuery('   \t\n  ');
  });

  it.each([
    { name: 'NUL (U+0000)', char: '\u0000' },
    { name: 'BEL (U+0007)', char: '\u0007' },
    { name: 'LF (U+000A)', char: '\n' },
    { name: 'TAB (U+0009)', char: '\t' },
    { name: 'US (U+001F)', char: '\u001f' },
    { name: 'DEL (U+007F)', char: '\u007f' },
    { name: 'C1 NEL (U+0085)', char: '\u0085' },
    { name: 'C1 APC (U+009F)', char: '\u009f' },
  ])('rejects a query holding the control character $name', ({ char }) => {
    expectInvalidQuery(`pay${char}ments`);
  });
});

describe('result limit: checked against CatalogLimits.search (design D5)', () => {
  it('defaults to 20 when no limit is given', () => {
    expect(parseSearchQuery({ q: 'payments' }, limits).limit).toBe(20);
  });

  it('keeps a given limit within bounds', () => {
    expect(parseSearchQuery({ q: 'payments', limit: 7 }, limits).limit).toBe(7);
  });

  it('accepts the maximum limit of 50', () => {
    expect(parseSearchQuery({ q: 'payments', limit: 50 }, limits).limit).toBe(50);
  });

  it('"Limits are checked before the database": rejects a limit of 51 with CATALOG_LIMIT_EXCEEDED naming search.maxLimit', () => {
    expectLimitExceeded(51);
  });

  it.each([
    { name: '0', limit: 0 },
    { name: '-1', limit: -1 },
    { name: 'a large negative value', limit: Number.MIN_SAFE_INTEGER },
  ])('rejects a limit of $name with CATALOG_VALIDATION_FAILED on /limit (Q52)', ({ limit }) => {
    expectInvalidLimit(limit);
  });
});

describe('"Wildcards match literally": the escaped prefix pattern (design D5)', () => {
  it('appends % to a query with no special character', () => {
    expect(parseSearchQuery({ q: 'paym' }, limits).prefixPattern).toBe('paym%');
  });

  it('escapes _ with a backslash', () => {
    expect(parseSearchQuery({ q: 'a_' }, limits).prefixPattern).toBe('a\\_%');
  });

  it('escapes % with a backslash', () => {
    expect(parseSearchQuery({ q: '50%' }, limits).prefixPattern).toBe('50\\%%');
  });

  it('escapes the backslash itself', () => {
    expect(parseSearchQuery({ q: 'a\\b' }, limits).prefixPattern).toBe('a\\\\b%');
  });

  it('escapes every %, _ and \\ in one query, each exactly once', () => {
    expect(parseSearchQuery({ q: '\\%_x_%\\' }, limits).prefixPattern).toBe(
      '\\\\\\%\\_x\\_\\%\\\\%',
    );
  });

  it('builds the pattern from the trimmed, NFC-normalized query', () => {
    expect(parseSearchQuery({ q: `  caf${DECOMPOSED_E_ACUTE}_ ` }, limits).prefixPattern).toBe(
      `caf${COMPOSED_E_ACUTE}\\_%`,
    );
  });

  it('keeps q itself unescaped for the trigram match', () => {
    expect(parseSearchQuery({ q: 'a_%\\' }, limits).q).toBe('a_%\\');
  });
});

describe('limit overrides through mergeCatalogLimits change the bounds (design D5)', () => {
  it('a lower maxQueryLength rejects a query the default accepts', () => {
    const overridden = mergeCatalogLimits({ search: { maxQueryLength: 10 } });

    expect(parseSearchQuery({ q: 'a'.repeat(10) }, overridden).q).toBe('a'.repeat(10));
    expectInvalidQuery('a'.repeat(11), overridden);
    expect(parseSearchQuery({ q: 'a'.repeat(11) }, limits).q).toBe('a'.repeat(11));
  });

  it('a higher minQueryLength rejects a query the default accepts', () => {
    const overridden = mergeCatalogLimits({ search: { minQueryLength: 3 } });

    expectInvalidQuery('ab', overridden);
    expect(parseSearchQuery({ q: 'abc' }, overridden).q).toBe('abc');
  });

  it('a lower maxLimit rejects a limit the default accepts', () => {
    const overridden = mergeCatalogLimits({ search: { maxLimit: 10 } });

    expect(parseSearchQuery({ q: 'payments', limit: 10 }, overridden).limit).toBe(10);
    expectLimitExceeded(11, overridden);
    expect(parseSearchQuery({ q: 'payments', limit: 11 }, limits).limit).toBe(11);
  });

  it('a higher maxLimit accepts a limit the default rejects', () => {
    const overridden = mergeCatalogLimits({ search: { maxLimit: 100 } });

    expect(parseSearchQuery({ q: 'payments', limit: 51 }, overridden).limit).toBe(51);
  });

  it('a defaultLimit override is used when no limit is given', () => {
    const overridden = mergeCatalogLimits({ search: { defaultLimit: 5 } });

    expect(parseSearchQuery({ q: 'payments' }, overridden).limit).toBe(5);
  });

  it('an override keeps the other search defaults', () => {
    expect(mergeCatalogLimits({ search: { maxLimit: 10 } }).search).toEqual({
      minQueryLength: 2,
      maxQueryLength: 100,
      defaultLimit: 20,
      maxLimit: 10,
    });
  });
});
