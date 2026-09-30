/**
 * Converts a thrown `CatalogError`/auth error into a real `ORPCError` carrying
 * its table `status`, `code` and `data` (task 11.3, design D11/D13), so the
 * HTTP response status matches the declared code instead of collapsing to 500.
 *
 * Anything without a table code becomes a generic `INTERNAL` error, reading
 * nothing off the thrown value: no message, stack or property reaches the
 * response.
 */
import { ORPCError } from '@orpc/server';
import { CATALOG_ERROR_HTTP_STATUS } from '@tayzu/catalog';

/** design D11's full code -> HTTP status table: every `CATALOG_*` plus the `AUTH_*` codes. */
const ERROR_HTTP_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...CATALOG_ERROR_HTTP_STATUS,
  AUTH_FORBIDDEN: 403,
  AUTH_STEP_UP_REQUIRED: 403,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_RATE_LIMITED: 429,
});

const INTERNAL_MESSAGE = 'An internal error occurred';

function internalError(): ORPCError<string, unknown> {
  return new ORPCError('INTERNAL', { status: 500, message: INTERNAL_MESSAGE });
}

export function toOrpcError(error: unknown): ORPCError<string, unknown> {
  // The SSO step-up interceptor (Q36) already built this one, carrying the
  // re-authorization URL as `data`; it holds no tenant text.
  if (error instanceof ORPCError && error.code === 'AUTH_STEP_UP_REQUIRED') {
    return error as ORPCError<string, unknown>;
  }
  if (typeof error !== 'object' || error === null || !(error instanceof Error)) {
    return internalError();
  }
  const { code } = error as { code?: unknown };
  if (typeof code !== 'string' || !Object.hasOwn(ERROR_HTTP_STATUS, code)) {
    return internalError();
  }
  const status = ERROR_HTTP_STATUS[code];
  if (status === undefined) {
    return internalError();
  }
  const { issues, details } = error as { issues?: unknown; details?: unknown };
  const isCatalog = Object.hasOwn(CATALOG_ERROR_HTTP_STATUS, code);
  return new ORPCError(code, {
    status,
    message: error.message,
    ...(isCatalog ? { data: { issues, details } } : {}),
  });
}

/** The `OpenAPIHandler` `clientInterceptors` entry. */
export async function errorMappingInterceptor<T>({ next }: { next: () => Promise<T> }): Promise<T> {
  try {
    return await next();
  } catch (error) {
    throw toOrpcError(error);
  }
}
