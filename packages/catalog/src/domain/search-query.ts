/**
 * The `entities.search` query (design D5): normalizes `q`, checks it and the
 * result `limit` against `CatalogLimits.search`, and builds the escaped
 * prefix pattern. Pure, so the service runs it before any database work.
 * Errors never echo `q` or `limit`: both are caller input.
 */
import { CatalogError } from './errors.js';
import type { CatalogLimits } from './limits.js';

export interface SearchQueryInput {
  q: string;
  limit?: number;
}

export interface ParsedSearchQuery {
  /** Trimmed, then NFC-normalized; the value the trigram match uses. */
  q: string;
  /** `input.limit`, or `limits.search.defaultLimit` when absent. */
  limit: number;
  /** `q` with `\`, `%` and `_` escaped by `\`, then `%` (`ILIKE ... ESCAPE '\'`). */
  prefixPattern: string;
}

/** Any Unicode `Cc` character: C0, DEL and C1. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** The `LIKE` metacharacters under `ESCAPE '\'`, the escape character included. */
const LIKE_METACHARACTER = /[\\%_]/g;

function invalidInput(path: string, message: string, issueMessage: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', message, {
    issues: [{ path, message: issueMessage }],
  });
}

function parseQueryText(raw: string, limits: CatalogLimits['search']): string {
  const q = raw.trim().normalize('NFC');
  if (
    q.length < limits.minQueryLength ||
    q.length > limits.maxQueryLength ||
    CONTROL_CHARACTER.test(q)
  ) {
    // Fixed text and the configured bounds only, never derived from `q`.
    invalidInput(
      '/q',
      'Query is rejected',
      `Query length must be ${String(limits.minQueryLength)} to ${String(limits.maxQueryLength)}, with no control code points`,
    );
  }
  return q;
}

function parseLimit(raw: number | undefined, limits: CatalogLimits['search']): number {
  if (raw === undefined) return limits.defaultLimit;
  // Q52: a limit below 1 is malformed input, not an exceeded limit. A
  // non-integer is malformed too, so it never reaches SQL `LIMIT`.
  if (!Number.isInteger(raw) || raw < 1) {
    invalidInput('/limit', 'Search limit is invalid', 'Limit must be a positive integer');
  }
  if (raw > limits.maxLimit) {
    throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Search limit exceeds the limit', {
      details: { limit: 'search.maxLimit' },
    });
  }
  return raw;
}

/** Parses and checks a search query; throws `CatalogError` on any violation. */
export function parseSearchQuery(
  input: SearchQueryInput,
  limits: CatalogLimits,
): ParsedSearchQuery {
  const q = parseQueryText(input.q, limits.search);
  const limit = parseLimit(input.limit, limits.search);
  return { q, limit, prefixPattern: `${q.replace(LIKE_METACHARACTER, '\\$&')}%` };
}
