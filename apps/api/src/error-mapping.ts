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
import type { ResponseHeadersPluginContext } from '@orpc/server/plugins';
import { AuthRateLimitedError } from '@tayzu/auth';
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

const VALIDATION_MESSAGE = 'The request input is invalid';
const ISSUE_MESSAGE = 'Invalid value';
const MAX_ISSUES = 50;

/** RFC 6901 escaping of one path segment. */
function pointerSegment(segment: unknown): string {
  const raw =
    typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment;
  const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  return text.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * oRPC's input-validation failure (`BAD_REQUEST`, also raised for a malformed
 * body) becomes `CATALOG_VALIDATION_FAILED` / 400. Only the JSON Pointer paths
 * survive; validator messages and submitted values are dropped (design D11).
 */
function validationError(error: ORPCError<string, unknown>): ORPCError<string, unknown> {
  const raw = (error.data as { issues?: unknown } | null | undefined)?.issues;
  const issues = (Array.isArray(raw) ? (raw as unknown[]) : [])
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const path = (issue as { path?: unknown } | null)?.path;
      const segments = Array.isArray(path) ? (path as unknown[]) : [];
      return {
        path: segments.map((segment) => `/${pointerSegment(segment)}`).join(''),
        message: ISSUE_MESSAGE,
      };
    });
  return new ORPCError('CATALOG_VALIDATION_FAILED', {
    status: 400,
    message: VALIDATION_MESSAGE,
    data: { issues, details: undefined },
  });
}

export function toOrpcError(error: unknown): ORPCError<string, unknown> {
  // The SSO step-up interceptor (Q36) already built this one, carrying the
  // re-authorization URL as `data`; it holds no tenant text.
  if (error instanceof ORPCError && error.code === 'AUTH_STEP_UP_REQUIRED') {
    return error as ORPCError<string, unknown>;
  }
  if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
    return validationError(error as ORPCError<string, unknown>);
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
export async function errorMappingInterceptor<T>({
  next,
  context,
}: {
  next: () => Promise<T>;
  context: ResponseHeadersPluginContext;
}): Promise<T> {
  try {
    return await next();
  } catch (error) {
    // `ORPCError` carries no header: the value goes through `ResponseHeadersPlugin`.
    if (error instanceof AuthRateLimitedError) {
      context.resHeaders?.set('Retry-After', String(error.retryAfterSeconds));
    }
    throw toOrpcError(error);
  }
}
