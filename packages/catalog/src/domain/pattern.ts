/**
 * `pattern` keyword validation (spec, "Property types"; design D6, ADR-0008).
 * Patterns are compiled with RE2 (`re2js`), a linear-time engine that never
 * backtracks: it rejects backreferences and lookaround by construction,
 * which covers catastrophic-backtracking constructs such as `(a+)+\1`.
 */
import { RE2JS } from 're2js';
import { CatalogError } from './errors.js';
import { defaultCatalogLimits } from './limits.js';

function invalidPattern(path: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Pattern is invalid', {
    issues: [{ path, message: 'Pattern is invalid' }],
  });
}

/**
 * Validates a `pattern` string against `maxLength` (default
 * `defaultCatalogLimits.pattern.maxLength`) and compiles it with RE2.
 * Returns the pattern unchanged on success.
 */
export function parsePattern(value: unknown, path: string, maxLength?: number): string {
  const limit = maxLength ?? defaultCatalogLimits.pattern.maxLength;

  if (typeof value !== 'string' || value.length > limit) {
    invalidPattern(path);
  }

  try {
    RE2JS.compile(value);
  } catch {
    invalidPattern(path);
  }

  return value;
}
