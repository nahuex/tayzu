/**
 * Postgres error inspection for constraint-name error mapping (design D9): a
 * unique-constraint or foreign-key violation is mapped to a `CatalogError` by
 * the *name* of the violated constraint, never by SQLSTATE alone. `code`
 * (SQLSTATE) and `constraint` may live on `error.cause` rather than on the
 * thrown value itself -- drizzle-orm wraps the underlying `pg` `DatabaseError`
 * in its own `DrizzleQueryError` -- so both are read through the same
 * `.cause`-unwrapping loop `persistence/db-isolation.int.test.ts` already
 * uses for the same reason.
 */

export interface PgErrorInfo {
  readonly code?: string;
  readonly constraint?: string;
}

/** SQLSTATE for a unique-constraint violation. */
export const UNIQUE_VIOLATION_SQLSTATE = '23505';
/** SQLSTATE for a foreign-key-constraint violation. */
export const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';

function hasStringProperty<K extends string>(
  candidate: unknown,
  key: K,
): candidate is Record<K, string> {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    key in candidate &&
    typeof (candidate as Record<string, unknown>)[key] === 'string'
  );
}

/** Unwraps `error.cause` until an object with a string `code` (SQLSTATE) is found. */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  let candidate: unknown = error;
  while (candidate !== undefined && candidate !== null) {
    if (hasStringProperty(candidate, 'code')) {
      return {
        code: candidate.code,
        constraint: hasStringProperty(candidate, 'constraint') ? candidate.constraint : undefined,
      };
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return {};
}
