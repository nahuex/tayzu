/**
 * Unit test for task 4.3 of change `003-catalog-ui-core` (design D9 "SPA fallback", Q28,
 * Q27 B1): the shared predicate `isSpaPath(pathname)`.
 *
 * Task 4.3: "the shared predicate `isSpaPath(pathname)` (true for a path not under `/v1`,
 * `/api` or `/assets`, not `/healthz` and not a root build file) [...] Verify:
 * `spa-paths.test.ts` covers the predicate on `/`, `/catalog/_user/alice@example.com`,
 * `/catalog/service/v1.2`, `/v1/x`, `/api/x`, `/apix`, `/assets/x.js`, `/healthz` and the
 * root build files".
 *
 * Design D9 (excerpt): "A `GET` or `HEAD` whose path is not under `/v1`, `/api` or
 * `/assets`, is not `/healthz` and is not a root build file answers `index.html` [...],
 * whatever the path holds: a `_user` page (`/catalog/_user/alice@example.com`) and an
 * identifier such as `v1.2` have a dot, so no "file extension" rule is used. [...] One
 * predicate, `isSpaPath(pathname)` in `apps/api`, decides "an app path" for the fallback
 * and for the span template of the Observability contract (Q27, B1)."
 *
 * ## Decisions this test pins (beyond the task's list)
 *
 * - "Under `/v1`" means the segment: `/v1` itself and `/v1/...`, never `/v1x`. The same for
 *   `/api` and `/assets`. So `/apix`, `/v1x` and `/assetsx` are app paths.
 * - `/healthz` and the root build files are exact paths: `/healthz/` and `/healthzx` are app
 *   paths, as is `/catalog/theme-init.js` (a root build file lives at the root only) and
 *   `/favicon.ico` (the list is explicit; there is no extension rule, Q28).
 * - Trailing slashes: `/v1/`, `/api/` and `/assets/` are under their prefix (not app paths);
 *   `/catalog/` is an app path.
 * - Case-sensitive, like Fastify's router: `/V1/x` does not reach the `/v1/*` catch-all, so
 *   it is an app path (and its span is exported as `/{spa}`, which keeps a raw path out of
 *   telemetry, Q27 B1). The same for `/API/auth/x`, `/Assets/x.js` and `/HEALTHZ`.
 * - No decoding: the predicate reads the raw pathname. `/catalog/_user/a%40b.com` is an app
 *   path (task 4.6 exports its span as `/{spa}`; the Q74 hook still refuses it before the
 *   fallback, which `spa-fallback.http.int.test.ts` covers).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `isSpaPath(pathname: string): boolean` exported from `./spa-paths.js`
 *   (`apps/api/src/spa-paths.ts`). It takes a pathname without the query.
 * - It reads the root build files from `ROOT_BUILD_FILES` (`./web-static.js`), so a file
 *   added to that list stops being an app path.
 *
 * ## Why this fails right now
 *
 * `./spa-paths.js` does not exist.
 */
import { describe, expect, it } from 'vitest';

import { isSpaPath } from './spa-paths.js';
import { ROOT_BUILD_FILES } from './web-static.js';

function expectSpa(paths: readonly string[], expected: boolean): void {
  for (const path of paths) {
    expect(isSpaPath(path), path).toBe(expected);
  }
}

describe('isSpaPath (task 4.3, design D9, Q28)', () => {
  it('the root and app pages are app paths', () => {
    expectSpa(['/', '/catalog', '/catalog/service', '/accept-invitation', '/reset-password'], true);
  });

  it('a user page with an email in its path and an identifier with a dot are app paths', () => {
    expectSpa(
      [
        '/catalog/_user/alice@example.com',
        '/catalog/service/v1.2',
        '/catalog/service/payments.api',
        '/catalog/service/x/index.html',
      ],
      true,
    );
  });

  it('a path under /v1 is not an app path', () => {
    expectSpa(['/v1', '/v1/', '/v1/x', '/v1/me', '/v1/auth/token', '/v1/catalog/_user/a.b'], false);
  });

  it('a path under /api is not an app path, not only /api/auth', () => {
    expectSpa(['/api', '/api/', '/api/x', '/api/auth', '/api/auth/get-session'], false);
  });

  it('a path under /assets is not an app path', () => {
    expectSpa(['/assets', '/assets/', '/assets/x.js', '/assets/index-Fx7Wd1Aa.js'], false);
  });

  it('/healthz is not an app path', () => {
    expectSpa(['/healthz'], false);
  });

  it('each root build file is not an app path', () => {
    expectSpa(['/theme-init.js', '/favicon.svg'], false);
    const names = Object.keys(ROOT_BUILD_FILES);
    expect(names.length).toBeGreaterThan(0);
    expectSpa(
      names.map((name) => `/${name}`),
      false,
    );
  });

  it('a prefix is a whole segment: /apix, /v1x and /assetsx are app paths', () => {
    expectSpa(['/apix', '/v1x', '/v1.2', '/assetsx', '/apix/auth', '/v1x/y'], true);
  });

  it('/healthz and the root build files are exact paths, not prefixes', () => {
    expectSpa(
      [
        '/healthz/',
        '/healthzx',
        '/healthz/x',
        '/theme-init.js/',
        '/theme-init.js.map',
        '/catalog/theme-init.js',
        '/catalog/favicon.svg',
        '/favicon.ico',
      ],
      true,
    );
  });

  it('a trailing slash on an app page keeps it an app path', () => {
    expectSpa(['/catalog/', '/catalog/service/', '/accept-invitation/'], true);
  });

  it('the predicate is case-sensitive, like the router: /V1/x is an app path', () => {
    expectSpa(['/V1/x', '/V1', '/API/auth/x', '/Api', '/Assets/x.js', '/HEALTHZ'], true);
  });

  it('the predicate reads the raw pathname without decoding it', () => {
    expectSpa(['/catalog/_user/a%40b.com'], true);
    expectSpa(['/v1/auth/%74oken', '/api/auth/%6Frganization/create', '/assets/%2e%2e/x'], false);
  });
});
