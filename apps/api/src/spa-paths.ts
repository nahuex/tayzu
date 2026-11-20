/**
 * The one predicate that decides "an app path" (003 design D9 "SPA fallback", Q28, Q27 B1):
 * the SPA fallback answers `index.html` for it, and the span template of the
 * Observability contract exports it as `/{spa}`.
 *
 * It reads the raw pathname (undecoded, without the query) and is case-sensitive, like
 * Fastify's router. There is no file-extension rule: `_user` identifiers are emails.
 */
import { ROOT_BUILD_FILES } from './web-static.js';

/** Matched as whole segments: the path itself, or the path followed by `/...`. */
const NON_APP_PREFIXES: readonly string[] = ['/v1', '/api', '/assets'];

/** Matched exactly: the liveness probe and each root build file at the build root. */
const NON_APP_PATHS: ReadonlySet<string> = new Set([
  '/healthz',
  ...Object.keys(ROOT_BUILD_FILES).map((name) => `/${name}`),
]);

export function isSpaPath(pathname: string): boolean {
  if (NON_APP_PATHS.has(pathname)) {
    return false;
  }
  return !NON_APP_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
