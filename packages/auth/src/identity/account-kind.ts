/** The two kinds of `_user` account (design D1). */
export type AccountKind = 'standard' | 'service';

/** The structural shape of a `_user` entity as the readers see it. */
interface AccountKindSource {
  readonly spec: { readonly properties: Readonly<Record<string, unknown>> };
}

/**
 * Resolves a `_user`'s `accountKind`. A blueprint default applies on write only,
 * so an existing row may lack the property; an absent value is `standard` (D1).
 */
export function resolveAccountKind(entity: AccountKindSource): AccountKind {
  return entity.spec.properties['accountKind'] === 'service' ? 'service' : 'standard';
}
