/**
 * Canonical equality for detecting an `unchanged` write (design D9: "compares
 * canonical JSON (sorted keys, relation order preserved) of `title`, `icon`,
 * and `spec`"). Object keys are sorted recursively at every depth; array
 * element order (in particular a `many` relation's target list) is
 * preserved and significant. Neither function mutates its input or performs
 * any I/O.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));

  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }

  return value;
}

/** Serializes `value` to JSON with every object's keys sorted, recursively. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** `true` when `a` and `b` have the same canonical JSON form. */
export function areCanonicallyEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
