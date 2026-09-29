/**
 * Error mapping to HTTP status codes, and sanitization of internal errors
 * (task 9.2; design D3, D11; spec "Published API contract"). `./router.ts`
 * calls `toApiError` on every error a service operation throws before it
 * rethrows, so a caller of `createRouterClient` receives one stable shape.
 *
 * `defineCatalogOperation` (`../service/pipeline.ts`, design D3 step 5) has
 * already recorded the sanitized exception on the active span before this
 * function ever runs. Its only job is keeping the original, unmapped value
 * off the caller-facing error: nothing is read from it beyond the
 * `isCatalogError` check.
 *
 * Deviation from the literal shape sketched in `router.int.test.ts`'s module
 * doc comment: a `CatalogError` is *augmented* in place with `status` and
 * `data`, not replaced by a fresh `ORPCError`. `router.int.test.ts` itself
 * reuses `../service/__fixtures__/blueprint-test-helpers.ts`'s
 * `expectCatalogErrorCode`, which asserts `isCatalogError(thrown)` (a strict
 * `instanceof CatalogError` check, `domain/errors.ts`). Wrapping into a fresh
 * `ORPCError` -- which does not, and must not, extend `CatalogError` -- would
 * make that assertion fail. Augmenting preserves `instanceof CatalogError`
 * for that shared helper while still giving `errors.int.test.ts`'s
 * `ApiErrorLike` the `status`/`data` fields it reads structurally (no
 * `instanceof` check there). Only the genuinely unknown-error branch
 * constructs a real `ORPCError`, since there is no `CatalogError` to
 * preserve.
 */
import { ORPCError } from '@orpc/contract';

import {
  AuthorizationError,
  isCatalogError,
  type CatalogError,
  type CatalogErrorCode,
} from '../domain/errors.js';

/** A `CatalogError`, augmented with the public fields `router.ts`'s callers read off a rejected call. */
export type ApiCatalogError = CatalogError & {
  readonly status: number;
  readonly data: {
    readonly issues?: CatalogError['issues'];
    readonly details?: CatalogError['details'];
  };
};

/** design D11's error-code -> HTTP status table, verbatim. */
export const CATALOG_ERROR_HTTP_STATUS: Readonly<Record<CatalogErrorCode, number>> = {
  CATALOG_CONTEXT_REQUIRED: 401,
  CATALOG_RESERVED_IDENTIFIER: 403,
  CATALOG_NOT_FOUND: 404,
  CATALOG_ALREADY_EXISTS: 409,
  CATALOG_VERSION_CONFLICT: 409,
  CATALOG_SCHEMA_INCOMPATIBLE: 409,
  CATALOG_VALIDATION_FAILED: 400,
  CATALOG_REFERENCE_VIOLATION: 422,
  CATALOG_LIMIT_EXCEEDED: 422,
};

export const INTERNAL_ERROR_CODE = 'INTERNAL';
export const INTERNAL_ERROR_STATUS = 500;

/**
 * A fixed, generic string, never derived from the thrown value in any way
 * (design D11: "Unknown errors become a generic INTERNAL with no message
 * detail").
 */
export const INTERNAL_ERROR_MESSAGE = 'An internal error occurred';

/**
 * Maps a `CatalogError` to its public HTTP status and data, in place (see the
 * module doc comment for why). Anything else -- including the raw, unmapped
 * value a database failure propagates as (design D3 step 5) -- becomes a
 * generic `INTERNAL` `ORPCError`, reading nothing off it: not its
 * `.message`, not its `.stack`, not any other own property.
 */
export function toApiError(
  error: unknown,
): ApiCatalogError | AuthorizationError | ORPCError<string, unknown> {
  // An in-tenant deny carries only a fixed message; the HTTP layer maps its
  // `AUTH_FORBIDDEN` code (design D11), so it must not collapse to INTERNAL.
  if (error instanceof AuthorizationError) {
    return error;
  }

  if (isCatalogError(error)) {
    return Object.assign(error, {
      status: CATALOG_ERROR_HTTP_STATUS[error.code],
      data: { issues: error.issues, details: error.details },
    });
  }

  return new ORPCError(INTERNAL_ERROR_CODE, {
    status: INTERNAL_ERROR_STATUS,
    message: INTERNAL_ERROR_MESSAGE,
  });
}
