/**
 * Stable catalog error codes and the `CatalogError` shape (spec Conventions,
 * "Error codes"). Every domain and service module throws this error, never a
 * plain `Error`, so operations fail closed with a machine-readable code.
 */

/** The stable, exhaustive list of catalog error codes (spec Conventions). */
export const CATALOG_ERROR_CODES = [
  'CATALOG_CONTEXT_REQUIRED',
  'CATALOG_VALIDATION_FAILED',
  'CATALOG_NOT_FOUND',
  'CATALOG_ALREADY_EXISTS',
  'CATALOG_VERSION_CONFLICT',
  'CATALOG_REFERENCE_VIOLATION',
  'CATALOG_SCHEMA_INCOMPATIBLE',
  'CATALOG_RESERVED_IDENTIFIER',
  'CATALOG_LIMIT_EXCEEDED',
] as const;

export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

/** A single validation issue, `path` being a JSON Pointer into the input. */
export interface CatalogErrorIssue {
  path: string;
  message: string;
}

export interface CatalogErrorOptions {
  issues?: readonly CatalogErrorIssue[];
  details?: Record<string, unknown>;
}

/**
 * The one error type every catalog operation throws. `issues` carries
 * JSON-Pointer-addressed validation failures; `details` carries any other
 * machine-readable data (for example a rejection `reason` or a limit name).
 * Neither ever holds tenant free text beyond what the caller explicitly
 * passes in.
 */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly issues?: readonly CatalogErrorIssue[];
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CatalogErrorCode, message: string, options?: CatalogErrorOptions) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.issues = options?.issues;
    this.details = options?.details;
  }
}

/** Type guard distinguishing a `CatalogError` from any other thrown value. */
export function isCatalogError(error: unknown): error is CatalogError {
  return error instanceof CatalogError;
}

/**
 * Raised by the pipeline's authorization stage when Cerbos denies an action
 * (002 design D11). Distinct from `CatalogError` and from
 * `CATALOG_NOT_FOUND`: an in-tenant deny is visible as such. It carries no
 * message detail beyond the fixed text.
 */
export class AuthorizationError extends Error {
  readonly code = 'AUTH_FORBIDDEN' as const;

  constructor() {
    super('Action is not permitted');
    this.name = 'AuthorizationError';
  }
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return error instanceof AuthorizationError;
}
