/**
 * The oRPC client of the catalog API (design D4, Q36, Q62).
 *
 * `OpenAPILink` reads the REST routes of `catalogContract` at runtime and
 * calls the page's own origin. `SimpleCsrfProtectionLinkPlugin` adds
 * `x-csrf-token: orpc` to every call (the server checks it on every mutating one with its
 * `SimpleCsrfProtectionHandlerPlugin`). Requests keep the browser's
 * default `credentials: 'same-origin'`, so the session cookie travels without
 * script ever reading it, and no `Authorization` header is sent.
 */
import { createORPCClient } from '@orpc/client';
import { SimpleCsrfProtectionLinkPlugin } from '@orpc/client/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { catalogContract, type CatalogContractClient } from '@tayzu/catalog/contract';

export type ApiClient = CatalogContractClient;

export interface ApiClientOptions {
  /** Defaults to the global `fetch`. Called with the final `Request`. */
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Q36: oRPC 1.15.4 encodes every path parameter with `encodeURIComponent`,
 * and the server refuses any `%` in the path (002 Q74). `@`, `:` and `=` are
 * valid unencoded in a path segment, so only their escapes are undone. Every
 * other escape stays, `%25` included, so a literal `%40` stays `%2540`.
 */
function decodePathSafeEscapes(pathname: string): string {
  return pathname.replace(/%(?:40|3A|3D)/gi, (escape) => decodeURIComponent(escape));
}

/** Rewrites only the pathname; the query and everything else are untouched. */
function withPathSafeEscapesDecoded(request: Request): Request {
  const url = new URL(request.url);
  const pathname = decodePathSafeEscapes(url.pathname);
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const send =
    options.fetch ?? ((request: Request, init?: RequestInit) => globalThis.fetch(request, init));
  const link = new OpenAPILink(catalogContract, {
    url: window.location.origin,
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
    fetch: (request, init) => send(withPathSafeEscapesDecoded(request), init),
  });
  return createORPCClient(link);
}
