/**
 * Builds a Cerbos attribute map with `tenantId` as the first key. `tenantId`
 * is a plain attribute, never a Cerbos scope (D7). It is placed last in the
 * spread so `extra` can never override it.
 */
export function buildAttributes<T extends Record<string, unknown>>(
  tenantId: string,
  extra?: T,
): { tenantId: string } & Omit<T, 'tenantId'> {
  const attrs = Object.create(null) as Record<string, unknown>;
  attrs['tenantId'] = tenantId;
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (key !== 'tenantId') attrs[key] = extra[key];
    }
  }
  return attrs as { tenantId: string } & Omit<T, 'tenantId'>;
}
