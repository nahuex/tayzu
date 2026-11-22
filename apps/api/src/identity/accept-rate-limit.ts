/**
 * Limiter of the public invitation-accept route (`043` task 8.13, design D5).
 * A Fastify `preHandler` that consumes a bucket of the DB-backed store, so the
 * count is shared across replicas, and answers `AUTH_RATE_LIMITED` with
 * `Retry-After` before the handler (and any invitation lookup) runs. The
 * bucket key is `clientIpKey(request.ip)` (one /64 shares a bucket; `request.ip`
 * as Fastify resolves it under the app's trust setting); the store hashes it, and it never
 * reaches a signal or a response. A failing store or key fails closed: the pre-handler
 * itself answers the sanitized `INTERNAL` 500 (`044` design D16).
 */
import { ORPCError } from '@orpc/server';
import type { RateLimitBucketStore, RateLimitScope } from '@tayzu/auth';
import type { FastifyReply, preHandlerAsyncHookHandler } from 'fastify';

import { clientIpKey } from './client-ip-key.js';

export interface AcceptRateLimitOptions {
  readonly store: RateLimitBucketStore;
  /** The bucket scope; the accept route's own unless another public route reuses this limiter (13.9). */
  readonly scope?: RateLimitScope;
  /**
   * A route-specific answer to a refused request, in place of the JSON `AUTH_RATE_LIMITED`
   * 429; `Retry-After` is already set on `reply`. Omitted: the JSON 429 (`003` task 3.10
   * uses it for the re-authorization callback's redirect).
   */
  readonly onLimited?: (reply: FastifyReply) => FastifyReply;
}

export function createAcceptRateLimitPreHandler(
  options: AcceptRateLimitOptions,
): preHandlerAsyncHookHandler {
  const limited = new ORPCError('AUTH_RATE_LIMITED', {
    status: 429,
    message: 'Too many requests',
  });
  const internal = new ORPCError('INTERNAL', {
    status: 500,
    message: 'An internal error occurred',
  });
  return async (request, reply) => {
    let result;
    try {
      result = await options.store.consume({
        scope: options.scope ?? 'invitation_accept',
        kind: 'ip',
        value: clientIpKey(request.ip),
      });
    } catch {
      return reply.status(500).send(internal.toJSON());
    }
    if (!result.allowed) {
      reply.header('retry-after', String(result.retryAfterSeconds));
      return options.onLimited === undefined
        ? reply.status(429).send(limited.toJSON())
        : options.onLimited(reply);
    }
    return undefined;
  };
}
