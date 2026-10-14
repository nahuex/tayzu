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

/**
 * `./step-up.ts` (task 4.2, design D4) throws this when a `user` actor
 * invokes an `x-tayzu-risk: high` operation without a fresh (within 5
 * minutes) MFA verification. Same package-local, structural-shape
 * convention as `AuthContextError` above, for the same reason (no
 * `@tayzu/catalog` dependency).
 */
export class AuthStepUpError extends Error {
  readonly code = 'AUTH_STEP_UP_REQUIRED';

  constructor() {
    super('A fresh multi-factor verification is required for this operation');
    this.name = 'AuthStepUpError';
  }
}

/**
 * `./token-exchange.ts` (task 5.3, design D5) throws this on every failing
 * `POST /v1/auth/token` exchange -- an unknown client id, a mismatched
 * secret, or a revoked credential all fail identically, with no detail that
 * would let a caller distinguish which. Same package-local, structural-shape
 * convention as `AuthContextError`/`AuthStepUpError` above.
 */
export class AuthInvalidCredentialsError extends Error {
  readonly code = 'AUTH_INVALID_CREDENTIALS';

  constructor() {
    super('The supplied client credentials are invalid');
    this.name = 'AuthInvalidCredentialsError';
  }
}

/**
 * Thrown by every limiter of the identity-lifecycle change (043, design D4).
 * `retryAfterSeconds` feeds the `Retry-After` header of the 429 answer; the
 * `apps/api` error mapping sets it.
 */
export class AuthRateLimitedError extends Error {
  readonly code = 'AUTH_RATE_LIMITED';

  constructor(readonly retryAfterSeconds: number) {
    super('Too many requests');
    this.name = 'AuthRateLimitedError';
  }
}
