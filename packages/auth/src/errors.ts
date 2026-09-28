/**
 * The `@tayzu/auth`-local error `resolveContext` (`./context-resolver.ts`,
 * task 3.1, design D3) throws when it cannot establish a context. Per this
 * package's own `CLAUDE.md` ("When code and design disagree, stop and ask")
 * and `context-resolver.int.test.ts`'s own module doc comment,
 * `packages/auth/package.json` does not declare `@tayzu/catalog` as a
 * dependency, so this is a package-local error shaped the same way
 * `@tayzu/catalog`'s own `CatalogError` is (a stable `code` string property),
 * not an import of that class.
 *
 * Every rejection path that uses this error -- a missing/invalid credential,
 * and a session with no active organization -- carries the identical `code`
 * and `message`, with no other distinguishing detail in the error itself:
 * the spec's "fails exactly as `CATALOG_CONTEXT_REQUIRED`" wording applies
 * equally to both cases, and a caller must not be able to tell them apart
 * from the rejection alone.
 */
export class AuthContextError extends Error {
  readonly code = 'CATALOG_CONTEXT_REQUIRED';

  constructor() {
    super('Catalog context is missing or invalid');
    this.name = 'AuthContextError';
  }
}
