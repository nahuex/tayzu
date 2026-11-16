import type { FastifyReply } from 'fastify';

/**
 * Adds `Pragma: no-cache` next to the `Cache-Control: no-store` the app sets on every response
 * (design D2, constraint C6). Reused by the confirm route.
 */
export function applyNoCacheHeaders(reply: FastifyReply): void {
  void reply.header('pragma', 'no-cache');
}
