/**
 * The SPA fallback (003 design D9 "SPA fallback" and "Rate limit", Q28, task 4.3): one
 * `GET /*` route, registered only when `webDistDir` is set (Fastify derives its `HEAD`).
 * An app path (`isSpaPath`) answers the in-memory `index.html` with `no-store`; any other
 * path that reaches `/*` answers `reply.callNotFound()`, exactly what the server answers
 * without a build. The Q74 hook runs first, so a target with `%`, `//` or a backslash
 * never gets here. The fallback never reads the session.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isSpaPath } from './spa-paths.js';

/** D9: 300 requests per minute per client address, per replica. */
export const DEFAULT_SPA_FALLBACK_RATE_LIMIT = { max: 300, timeWindowMs: 60_000 } as const;

const INDEX_HTML_UNREADABLE = 'WEB_DIST_DIR holds an index.html that is not readable.';

export interface SpaFallbackOptions {
  readonly rateLimit: { readonly max: number; readonly timeWindowMs: number };
  /** The `429` body; it carries no part of the bucket key. */
  readonly rateLimitedBody: () => object;
}

/** Q74: the path of the request target, without its query. */
function isAppRequest(request: FastifyRequest): boolean {
  return isSpaPath(request.url.split('?', 1)[0] ?? '');
}

/**
 * Reads `index.html` once. A failure stops startup with fixed text: the fs error is never
 * rethrown, because its message carries the path (Q21).
 */
async function readIndexHtml(webDistDir: string): Promise<string> {
  try {
    return await readFile(join(webDistDir, 'index.html'), 'utf8');
  } catch {
    throw new Error(INDEX_HTML_UNREADABLE);
  }
}

export async function registerSpaFallback(
  app: FastifyInstance,
  webDistDir: string,
  options: SpaFallbackOptions,
): Promise<void> {
  const indexHtml = await readIndexHtml(webDistDir);
  app.get(
    '/*',
    {
      config: {
        rateLimit: {
          max: options.rateLimit.max,
          timeWindow: options.rateLimit.timeWindowMs,
          // Only a request answered with the app counts against the bucket.
          allowList: (request: FastifyRequest): boolean => !isAppRequest(request),
          // Internal bucket key only: never logged, returned or exported.
          keyGenerator: (request: FastifyRequest): string => `spa-fallback:${request.ip}`,
          errorResponseBuilder: options.rateLimitedBody,
        },
      },
    },
    (request, reply) => {
      if (!isAppRequest(request)) {
        reply.callNotFound();
        return reply;
      }
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(indexHtml);
    },
  );
}
