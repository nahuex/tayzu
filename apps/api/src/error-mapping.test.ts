/**
 * Task 6.8b (043, design D4): every limiter answers with a `Retry-After`
 * header. `@tayzu/auth` gains `AuthRateLimitedError` (`retryAfterSeconds`),
 * and the error mapping turns it into a 429 `AUTH_RATE_LIMITED` carrying that
 * header through oRPC's `ResponseHeadersPlugin`.
 *
 * ## Production symbols expected
 *
 * - `AuthRateLimitedError` exported from `@tayzu/auth` (`packages/auth/src/errors.ts`,
 *   re-exported by `packages/auth/src/index.ts`): `new AuthRateLimitedError(retryAfterSeconds: number)`,
 *   `code = 'AUTH_RATE_LIMITED'`, a readonly `retryAfterSeconds` property.
 * - `errorMappingInterceptor` (`./error-mapping.js`) sets `Retry-After` on the
 *   `resHeaders` of the `ResponseHeadersPlugin` context.
 */
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { os } from '@orpc/server';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { AuthRateLimitedError } from '@tayzu/auth';
import { describe, expect, it } from 'vitest';

import { errorMappingInterceptor } from './error-mapping.js';

interface ErrorBody {
  readonly code?: unknown;
}

function buildHandler(retryAfterSeconds: number) {
  const router = {
    limited: os
      .handler(() => {
        throw new AuthRateLimitedError(retryAfterSeconds);
      })
      .route({ method: 'GET', path: '/scratch/limited' }),
    plain: os
      .handler(() => {
        throw new Error('boom');
      })
      .route({ method: 'GET', path: '/scratch/plain' }),
  };
  return new OpenAPIHandler(router, {
    plugins: [new ResponseHeadersPlugin()],
    clientInterceptors: [errorMappingInterceptor],
  });
}

async function call(handler: ReturnType<typeof buildHandler>, path: string) {
  const result = await handler.handle(new Request(`http://localhost${path}`), { context: {} });
  if (!result.matched) {
    throw new Error('route not matched');
  }
  return result.response;
}

describe('AuthRateLimitedError mapping', () => {
  it('maps to 429 AUTH_RATE_LIMITED with a Retry-After equal to retryAfterSeconds', async () => {
    const response = await call(buildHandler(3600), '/scratch/limited');
    expect(response.status).toBe(429);
    expect(((await response.json()) as ErrorBody).code).toBe('AUTH_RATE_LIMITED');
    expect(response.headers.get('retry-after')).toBe('3600');
  });

  it('carries the value of the error, not a constant', async () => {
    const response = await call(buildHandler(17), '/scratch/limited');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
  });

  it('does not set Retry-After on other errors', async () => {
    const response = await call(buildHandler(3600), '/scratch/plain');
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
