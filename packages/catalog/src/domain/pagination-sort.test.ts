/**
 * Assumed API of `./pagination.js` (task 3.2; design D6, Resolved decision Q37):
 *
 * ```ts
 * type EntitySortField = 'identifier' | 'title' | 'updatedAt';
 * type EntitySortOrder = 'asc' | 'desc';
 *
 * function encodeSortCursor(position: {
 *   sort: EntitySortField;
 *   order: EntitySortOrder;
 *   id: string; // the last row's UUID
 * }): string;
 *
 * function decodeSortCursor(
 *   cursor: string,
 *   expected: { sort: EntitySortField; order: EntitySortOrder },
 *   limits: CatalogLimits,
 * ): { kind: 'v2'; id: string } | { kind: 'v1'; key: string };
 * ```
 *
 * `encodeSortCursor` returns the base64url encoding of the JSON
 * `{ "v": 2, "s": <sort>, "o": <order>, "id": <uuid> }`: the position of the
 * last row only, with no sort value and no tenant (D6). The repository of
 * task 3.4 reads the anchor row by that id inside the tenant transaction.
 *
 * `decodeSortCursor` first checks `cursor.length` against
 * `limits.cursor.maxLength` (512 by default) and fails with
 * `CATALOG_LIMIT_EXCEEDED` naming `cursor.maxLength`, exactly like
 * `assertCursorLength`, before it decodes anything. Then:
 * - a version-2 cursor whose `s` and `o` equal `expected` and whose `id` is a
 *   UUID yields `{ kind: 'v2', id }`;
 * - a version-1 cursor `{ "k": <identifier> }` (what `encodeCursor` writes,
 *   and `blueprints.list` keeps using) yields `{ kind: 'v1', key }` for the
 *   default sort only, `identifier` `asc`;
 * - anything else (another sort or order, a non-UUID `id`, malformed base64url
 *   or JSON, wrong types, an unsafe key `__proto__`, `constructor` or
 *   `prototype`) fails with `CATALOG_VALIDATION_FAILED` and the single issue
 *   path `/cursor`, the same error the version-1 `decodeCursor` throws today.
 */
import { uuidv7 } from 'uuidv7';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCatalogError, type CatalogError, type CatalogErrorCode } from './errors.js';
import { defaultCatalogLimits, mergeCatalogLimits } from './limits.js';
import { decodeCursor, decodeSortCursor, encodeCursor, encodeSortCursor } from './pagination.js';

type SortField = 'identifier' | 'title' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

const SORTS: readonly SortField[] = ['identifier', 'title', 'updatedAt'];
const ORDERS: readonly SortOrder[] = ['asc', 'desc'];
const COMBINATIONS: readonly { sort: SortField; order: SortOrder }[] = SORTS.flatMap((sort) =>
  ORDERS.map((order) => ({ sort, order })),
);

/** spec Conventions, "Default limits": "Pagination cursor | 512 characters". */
const CURSOR_MAX_LENGTH = 512;

const limits = defaultCatalogLimits;

/** base64url-encodes raw text, so a test can craft any cursor payload. */
function rawCursor(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** base64url-encodes `JSON.stringify(value)`. */
function jsonCursor(value: unknown): string {
  return rawCursor(JSON.stringify(value));
}

/** Decodes a cursor's payload without going through the module under test. */
function payloadOf(cursor: string): unknown {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

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
 * The version-1 cursor's failure, reused for every rejected version-2 cursor:
 * `CATALOG_VALIDATION_FAILED` with the one issue path `/cursor`, and nothing of
 * the cursor itself echoed in the message or the issues.
 */
function expectInvalidCursor(cursor: string, expected: { sort: SortField; order: SortOrder }) {
  const error = expectCode(
    () => decodeSortCursor(cursor, expected, limits),
    'CATALOG_VALIDATION_FAILED',
  );
  expect(error.issues?.map((issue) => issue.path)).toEqual(['/cursor']);
  if (cursor.length > 0) {
    expect(error.message).not.toContain(cursor);
    for (const issue of error.issues ?? []) expect(issue.message).not.toContain(cursor);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('version-2 cursor round trip (design D6, Q37)', () => {
  it.each(COMBINATIONS)('round-trips the last row id for sort $sort, order $order', (bound) => {
    const id = uuidv7();
    const cursor = encodeSortCursor({ ...bound, id });

    expect(decodeSortCursor(cursor, bound, limits)).toEqual({ kind: 'v2', id });
  });

  it.each(COMBINATIONS)(
    'encodes exactly { v: 2, s, o, id } as base64url JSON for sort $sort, order $order',
    ({ sort, order }) => {
      const id = uuidv7();
      const cursor = encodeSortCursor({ sort, order, id });

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(payloadOf(cursor)).toStrictEqual({ v: 2, s: sort, o: order, id });
    },
  );
});

describe('"A cursor of another sort is rejected": a version-2 cursor is bound to its sort and order', () => {
  const mismatches = COMBINATIONS.flatMap((issued) =>
    COMBINATIONS.filter(
      (expected) => expected.sort !== issued.sort || expected.order !== issued.order,
    ).map((expected) => ({ issued, expected })),
  );

  it.each(mismatches)(
    'rejects a cursor issued for $issued.sort $issued.order when used with $expected.sort $expected.order',
    ({ issued, expected }) => {
      const cursor = encodeSortCursor({ ...issued, id: uuidv7() });

      expectInvalidCursor(cursor, expected);
    },
  );

  it('rejects a title cursor sent with a list sorted by identifier (the spec scenario)', () => {
    const cursor = encodeSortCursor({ sort: 'title', order: 'asc', id: uuidv7() });

    expectInvalidCursor(cursor, { sort: 'identifier', order: 'asc' });
  });

  it('rejects a cursor of the same sort but the other order', () => {
    const cursor = encodeSortCursor({ sort: 'title', order: 'desc', id: uuidv7() });

    expectInvalidCursor(cursor, { sort: 'title', order: 'asc' });
  });
});

describe('a version-2 cursor whose id is not a UUID is rejected', () => {
  const uuid = uuidv7();
  it.each([
    { label: 'a word', id: 'not-a-uuid' },
    { label: 'an empty string', id: '' },
    { label: 'an entity identifier', id: 'payments-api' },
    { label: 'a UUID with a trailing character', id: `${uuid}x` },
    { label: 'a UUID with a leading space', id: ` ${uuid}` },
    {
      label: 'a UUID-shaped string with non-hex characters',
      id: 'zzzzzzzz-zzzz-7zzz-8zzz-zzzzzzzzzzzz',
    },
    { label: 'a UUID truncated by one character', id: uuid.slice(0, -1) },
    { label: 'an SQL fragment', id: "' OR 1=1 --" },
  ])('rejects $label', ({ id }) => {
    expectInvalidCursor(jsonCursor({ v: 2, s: 'title', o: 'asc', id }), {
      sort: 'title',
      order: 'asc',
    });
  });
});

describe('a malformed cursor is rejected', () => {
  /** Crafted by hand, so that the table is built without calling the module under test. */
  const valid = jsonCursor({ v: 2, s: 'title', o: 'asc', id: uuidv7() });

  it.each([
    { label: 'an empty cursor', cursor: '' },
    { label: 'characters outside base64url', cursor: '!!!!****' },
    { label: 'base64url of text that is not JSON', cursor: rawCursor('not json') },
    { label: 'base64url of truncated JSON', cursor: rawCursor('{"v":2,"s":"title"') },
    { label: 'a truncated valid cursor', cursor: valid.slice(0, Math.floor(valid.length / 2)) },
    {
      label: 'base64url of invalid UTF-8',
      cursor: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'),
    },
  ])('rejects $label', ({ cursor }) => {
    expectInvalidCursor(cursor, { sort: 'title', order: 'asc' });
  });
});

describe('a cursor with wrong types is rejected', () => {
  const id = uuidv7();
  it.each([
    { label: 'a JSON null', payload: null },
    { label: 'a JSON array', payload: [2, 'title', 'asc', id] },
    { label: 'a JSON string', payload: id },
    { label: 'a JSON number', payload: 2 },
    { label: 'an empty object', payload: {} },
    { label: 'v as a string', payload: { v: '2', s: 'title', o: 'asc', id } },
    { label: 'an unknown version', payload: { v: 3, s: 'title', o: 'asc', id } },
    { label: 'a missing version', payload: { s: 'title', o: 'asc', id } },
    { label: 'an unknown sort', payload: { v: 2, s: 'name', o: 'asc', id } },
    { label: 'a numeric sort', payload: { v: 2, s: 1, o: 'asc', id } },
    { label: 'a missing sort', payload: { v: 2, o: 'asc', id } },
    { label: 'an unknown order', payload: { v: 2, s: 'title', o: 'up', id } },
    { label: 'a boolean order', payload: { v: 2, s: 'title', o: true, id } },
    { label: 'a missing order', payload: { v: 2, s: 'title', id } },
    { label: 'a numeric id', payload: { v: 2, s: 'title', o: 'asc', id: 42 } },
    { label: 'a null id', payload: { v: 2, s: 'title', o: 'asc', id: null } },
    { label: 'an id array', payload: { v: 2, s: 'title', o: 'asc', id: [id] } },
    { label: 'an id object', payload: { v: 2, s: 'title', o: 'asc', id: { id } } },
    { label: 'a missing id', payload: { v: 2, s: 'title', o: 'asc' } },
  ])('rejects $label', ({ payload }) => {
    expectInvalidCursor(jsonCursor(payload), { sort: 'title', order: 'asc' });
  });

  it.each([
    { label: 'a numeric k', payload: { k: 42 } },
    { label: 'a null k', payload: { k: null } },
    { label: 'an array k', payload: { k: ['a'] } },
  ])('rejects a version-1 cursor with $label for the default sort', ({ payload }) => {
    expectInvalidCursor(jsonCursor(payload), { sort: 'identifier', order: 'asc' });
  });
});

describe('unsafe keys in the cursor JSON are rejected', () => {
  const id = uuidv7();
  const v2 = `"v":2,"s":"title","o":"asc","id":"${id}"`;
  const v1 = `"k":"payments-api"`;

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects a version-2 cursor carrying a top-level "%s" key',
    (key) => {
      expectInvalidCursor(rawCursor(`{${v2},"${key}":{"polluted":true}}`), {
        sort: 'title',
        order: 'asc',
      });
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects a version-2 cursor carrying a nested "%s" key',
    (key) => {
      expectInvalidCursor(rawCursor(`{${v2},"x":{"${key}":{"polluted":true}}}`), {
        sort: 'title',
        order: 'asc',
      });
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects a version-1 cursor carrying a top-level "%s" key for the default sort',
    (key) => {
      expectInvalidCursor(rawCursor(`{${v1},"${key}":{"polluted":true}}`), {
        sort: 'identifier',
        order: 'asc',
      });
    },
  );

  it('does not pollute Object.prototype while rejecting', () => {
    expectInvalidCursor(rawCursor(`{${v2},"__proto__":{"polluted":true}}`), {
      sort: 'title',
      order: 'asc',
    });

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('the 512-character limit is checked before decoding', () => {
  /** A real version-2 cursor, padded with JSON whitespace past the limit: decodable but too long. */
  function overLengthValidCursor(bound: { sort: SortField; order: SortOrder }): string {
    const json = JSON.stringify({ v: 2, s: bound.sort, o: bound.order, id: uuidv7() });
    const padded = `${json.slice(0, -1)}${' '.repeat(CURSOR_MAX_LENGTH)}}`;
    const cursor = rawCursor(padded);
    expect(cursor.length).toBeGreaterThan(CURSOR_MAX_LENGTH);
    expect(JSON.parse(padded)).toMatchObject({ v: 2 });
    return cursor;
  }

  it('rejects an over-length cursor that would otherwise decode, with CATALOG_LIMIT_EXCEEDED naming the limit', () => {
    const bound = { sort: 'title', order: 'asc' } as const;
    const error = expectCode(
      () => decodeSortCursor(overLengthValidCursor(bound), bound, limits),
      'CATALOG_LIMIT_EXCEEDED',
    );

    expect(error.details).toMatchObject({ limit: 'cursor.maxLength' });
  });

  it('rejects a 513-character malformed cursor as over-length, not as malformed', () => {
    const error = expectCode(
      () =>
        decodeSortCursor(
          'a'.repeat(CURSOR_MAX_LENGTH + 1),
          { sort: 'title', order: 'asc' },
          limits,
        ),
      'CATALOG_LIMIT_EXCEEDED',
    );

    expect(error.details).toMatchObject({ limit: 'cursor.maxLength' });
  });

  it('rejects a 513-character cursor carrying unsafe keys as over-length, not as unsafe', () => {
    const json = `{"__proto__":{"polluted":true},"pad":"${'x'.repeat(CURSOR_MAX_LENGTH)}"}`;
    const cursor = rawCursor(json);
    expect(cursor.length).toBeGreaterThan(CURSOR_MAX_LENGTH);

    expectCode(
      () => decodeSortCursor(cursor, { sort: 'identifier', order: 'asc' }, limits),
      'CATALOG_LIMIT_EXCEEDED',
    );
  });

  it('never parses an over-length cursor', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const bound = { sort: 'updatedAt', order: 'desc' } as const;
    const cursor = overLengthValidCursor(bound);
    parse.mockClear();

    expectCode(() => decodeSortCursor(cursor, bound, limits), 'CATALOG_LIMIT_EXCEEDED');

    expect(parse).not.toHaveBeenCalled();
  });

  it('lets a 512-character cursor through the length check, to fail as malformed', () => {
    expectInvalidCursor('a'.repeat(CURSOR_MAX_LENGTH), { sort: 'title', order: 'asc' });
  });

  it('uses the cursor limit of the CatalogLimits it is given', () => {
    const small = mergeCatalogLimits({ cursor: { maxLength: 40 } });
    const bound = { sort: 'title', order: 'asc' } as const;
    const cursor = encodeSortCursor({ ...bound, id: uuidv7() });
    expect(cursor.length).toBeGreaterThan(40);

    const error = expectCode(
      () => decodeSortCursor(cursor, bound, small),
      'CATALOG_LIMIT_EXCEEDED',
    );
    expect(error.details).toMatchObject({ limit: 'cursor.maxLength' });
  });
});

describe('a version-1 cursor stays valid for the default sort only (D6)', () => {
  const identifier = 'payments-api';

  it('accepts a version-1 cursor written by encodeCursor for identifier asc', () => {
    expect(
      decodeSortCursor(encodeCursor(identifier), { sort: 'identifier', order: 'asc' }, limits),
    ).toEqual({ kind: 'v1', key: identifier });
  });

  it.each(COMBINATIONS.filter((c) => !(c.sort === 'identifier' && c.order === 'asc')))(
    'rejects a version-1 cursor for sort $sort, order $order',
    (bound) => {
      expectInvalidCursor(encodeCursor(identifier), bound);
    },
  );

  it('leaves the version-1 functions of blueprints.list unchanged', () => {
    const cursor = encodeCursor(identifier);

    expect(payloadOf(cursor)).toStrictEqual({ k: identifier });
    expect(decodeCursor(cursor)).toBe(identifier);
  });
});

describe('"Long titles and identifiers still page": the cursor stays under the limit for every sort', () => {
  const row = {
    id: uuidv7(),
    identifier: 'i'.repeat(256),
    title: 'T'.repeat(256),
  };

  it.each(COMBINATIONS)(
    'stays at most 512 characters after a row with a 256-character title and identifier, for sort $sort, order $order',
    (bound) => {
      expect(row.identifier).toHaveLength(256);
      expect(row.title).toHaveLength(256);

      const cursor = encodeSortCursor({ ...bound, id: row.id });

      expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
      expect(payloadOf(cursor)).toStrictEqual({ v: 2, s: bound.sort, o: bound.order, id: row.id });
      expect(decodeSortCursor(cursor, bound, limits)).toEqual({ kind: 'v2', id: row.id });
    },
  );
});
