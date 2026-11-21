/**
 * The SPA fallback (003 design D9 "SPA fallback" and "Rate limit", Q28, task 4.3): one
 * `GET /*` route, registered only when `webDistDir` is set (Fastify derives its `HEAD`).
 * An app path (`isSpaPath`) answers the in-memory `index.html` with `no-store`; any other
 * path that reaches `/*` answers `reply.callNotFound()`, exactly what the server answers
 * without a build. The Q74 hook runs first, so a target with `%`, `//` or a backslash
 * never gets here. The fallback never reads the session. Each answer carries the
 * response's own style nonce (D10, Q15, task 4.5) in place of the `index.html` placeholder.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isSpaPath } from './spa-paths.js';
import { styleNonceOf } from './style-nonce.js';

/** D9: 300 requests per minute per client address, per replica. */
export const DEFAULT_SPA_FALLBACK_RATE_LIMIT = { max: 300, timeWindowMs: 60_000 } as const;

const INDEX_HTML_UNREADABLE = 'WEB_DIST_DIR holds an index.html that is not readable.';
const INDEX_HTML_WITHOUT_NONCE_PLACEHOLDER =
  'WEB_DIST_DIR holds an index.html without the style nonce placeholder.';

/** Q45 (4): the `tayzu-style-nonce` meta's content in the build, replaced per response. */
const STYLE_NONCE_PLACEHOLDER = '__TAYZU_STYLE_NONCE__';

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

/**
 * Splits the page at the placeholder once, at startup, so each answer is a join with the
 * response's nonce. A page without the placeholder stops startup: serving it would leave
 * the scroll lock without a nonce.
 */
function splitAtNoncePlaceholder(indexHtml: string): readonly string[] {
  const parts = indexHtml.split(STYLE_NONCE_PLACEHOLDER);
  if (parts.length < 2) {
    throw new Error(INDEX_HTML_WITHOUT_NONCE_PLACEHOLDER);
  }
  return parts;
}

export async function registerSpaFallback(
  app: FastifyInstance,
  webDistDir: string,
  options: SpaFallbackOptions,
): Promise<void> {
  const indexHtmlParts = splitAtNoncePlaceholder(await readIndexHtml(webDistDir));
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
        .send(indexHtmlParts.join(styleNonceOf(reply.raw)));
    },
  );
}
