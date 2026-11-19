/**
 * Keyset pagination cursor (design D10). List operations sort by a single
 * ascending key (`identifier` for blueprints) and paginate with
 * `WHERE <key> > <cursor>`. The cursor is an opaque base64url-encoded JSON
 * value `{ "k": "<last key>" }`. It carries no tenant: it is always applied
 * inside the caller's own tenant scope, so tampering with it can only move
 * within the caller's own data. A malformed cursor fails with
 * `CATALOG_VALIDATION_FAILED`.
 *
 * `entities.list` uses the version-2, sort-bound cursor (003 design D6, Q37):
 * `{ "v": 2, "s": <sort>, "o": <order>, "id": <uuid of the last row> }`. It
 * carries neither the sort value nor the tenant; the repository reads the
 * anchor row's sort key inside the tenant transaction.
 */
import { CatalogError } from './errors.js';
import type { CatalogLimits } from './limits.js';
import { parseSafeInput } from './safe-parse.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCursor(): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Pagination cursor is invalid', {
    issues: [{ path: '/cursor', message: 'Pagination cursor is invalid' }],
  });
}

/**
 * spec Conventions, "Default limits" ("Pagination cursor | 512 characters");
 * design D8: limits are checked before any expensive work. Callers run this
 * before decoding, so an over-length cursor fails with `CATALOG_LIMIT_EXCEEDED`
 * naming the limit rather than falling through to a decode failure.
 */
export function assertCursorLength(cursor: string, limits: CatalogLimits): void {
  if (cursor.length > limits.cursor.maxLength) {
    throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Pagination cursor exceeds the length limit', {
      details: { limit: 'cursor.maxLength' },
    });
  }
}

/** Encodes `key` (the last item's sort key on the current page) as an opaque cursor. */
export function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ k: key }), 'utf8').toString('base64url');
}

/** Decodes `cursor` back to its sort key, or fails with `CATALOG_VALIDATION_FAILED`. */
export function decodeCursor(cursor: string): string {
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    invalidCursor();
  }

  if (!isRecord(parsed) || typeof parsed['k'] !== 'string') {
    invalidCursor();
  }

  return parsed['k'];
}

/** The sort keys of `entities.list` (003 design D6). */
export type EntitySortField = 'identifier' | 'title' | 'updatedAt';

/** The sort directions of `entities.list` (003 design D6). */
export type EntitySortOrder = 'asc' | 'desc';

/** A decoded `entities.list` cursor: a version-2 anchor row id, or a version-1 identifier key. */
export type SortCursorPosition = { kind: 'v2'; id: string } | { kind: 'v1'; key: string };

const SORT_CURSOR_VERSION = 2;

/** The canonical 8-4-4-4-12 hexadecimal UUID text form, as row ids are written. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

/**
 * Decodes the base64url JSON payload into null-prototype objects, rejecting
 * unsafe keys at every depth. Every failure is the one `invalidCursor` error.
 */
function parseCursorPayload(cursor: string): unknown {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return parseSafeInput(JSON.parse(decoded));
  } catch {
    return invalidCursor();
  }
}

/** Encodes the last row of a sorted `entities.list` page as a version-2 cursor. */
export function encodeSortCursor(position: {
  sort: EntitySortField;
  order: EntitySortOrder;
  id: string;
}): string {
  const payload = { v: SORT_CURSOR_VERSION, s: position.sort, o: position.order, id: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes an `entities.list` cursor issued for `expected`. The length limit
 * is checked first (`CATALOG_LIMIT_EXCEEDED`); every other rejection (another
 * sort or order, a non-UUID id, malformed or unsafe JSON) is
 * `CATALOG_VALIDATION_FAILED` on `/cursor`. A version-1 `{ "k" }` cursor is
 * accepted for the default sort, `identifier` `asc`, only.
 */
export function decodeSortCursor(
  cursor: string,
  expected: { sort: EntitySortField; order: EntitySortOrder },
  limits: CatalogLimits,
): SortCursorPosition {
  assertCursorLength(cursor, limits);

  const parsed = parseCursorPayload(cursor);
  if (!isRecord(parsed)) invalidCursor();

  if (hasExactKeys(parsed, ['k'])) {
    const key = parsed['k'];
    if (expected.sort !== 'identifier' || expected.order !== 'asc' || typeof key !== 'string') {
      invalidCursor();
    }
    return { kind: 'v1', key };
  }

  if (!hasExactKeys(parsed, ['v', 's', 'o', 'id'])) invalidCursor();

  // Comparing `s` and `o` to the typed `expected` also rejects unknown values and wrong types.
  const { v, s, o, id } = parsed;
  if (
    v !== SORT_CURSOR_VERSION ||
    s !== expected.sort ||
    o !== expected.order ||
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id)
  ) {
    invalidCursor();
  }

  return { kind: 'v2', id };
}
