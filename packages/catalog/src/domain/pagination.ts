/**
 * Keyset pagination cursor (design D10). List operations sort by a single
 * ascending key (`identifier` for blueprints) and paginate with
 * `WHERE <key> > <cursor>`. The cursor is an opaque base64url-encoded JSON
 * value `{ "k": "<last key>" }`. It carries no tenant: it is always applied
 * inside the caller's own tenant scope, so tampering with it can only move
 * within the caller's own data. A malformed cursor fails with
 * `CATALOG_VALIDATION_FAILED`.
 */
import { CatalogError } from './errors.js';
import type { CatalogLimits } from './limits.js';

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
