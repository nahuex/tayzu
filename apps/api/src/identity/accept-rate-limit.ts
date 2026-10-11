/**
 * Limiter of the public invitation-accept route (`043` task 8.13, design D5).
 * A Fastify `preHandler` that consumes a bucket of the DB-backed store, so the
 * count is shared across replicas, and answers `AUTH_RATE_LIMITED` with
 * `Retry-After` before the handler (and any invitation lookup) runs. The
 * bucket key is `request.ip` as Fastify resolves it under the app's trust
 * setting; the store hashes it, and it never reaches a signal or a response.
 */
import { ORPCError } from '@orpc/server';
import type { RateLimitBucketStore } from '@tayzu/auth';
import type { preHandlerAsyncHookHandler } from 'fastify';

export interface AcceptRateLimitOptions {
  readonly store: RateLimitBucketStore;
}

export function createAcceptRateLimitPreHandler(
  options: AcceptRateLimitOptions,
): preHandlerAsyncHookHandler {
  const limited = new ORPCError('AUTH_RATE_LIMITED', {
    status: 429,
    message: 'Too many requests',
  });
  return async (request, reply) => {
    const result = await options.store.consume({
      scope: 'invitation_accept',
      kind: 'ip',
      value: request.ip,
    });
    if (!result.allowed) {
      return reply
        .status(429)
        .header('retry-after', String(result.retryAfterSeconds))
        .send(limited.toJSON());
    }
    return undefined;
  };
}
