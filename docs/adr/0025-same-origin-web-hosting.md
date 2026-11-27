# ADR-0025: The web app is served by the API container, on the API's origin

- **Status**: Accepted
- **Date**: 2026-11-21
- **Change**: [`003-catalog-ui-core`](../../openspec/changes/archive/2026-11-27-003-catalog-ui-core/design.md) (design D9; Resolved decisions Q2, Q21, Q28, Q39, Q58)

## Context

`003-catalog-ui-core` adds Tayzu's first browser app, a Vite single-page
app. The API that `002-auth-and-rbac` and its follow-ups put on the network
already has a browser security model built around one origin:

- the Better Auth session cookie is host-only and `SameSite=Lax`, and is
  never readable by script;
- the CSRF defense is a custom header (`x-csrf-token: orpc` on every non-`GET`
  oRPC call) plus Better Auth's origin check against `ALLOWED_ORIGINS`;
- the Visma Connect sign-in and re-authorization callbacks are `form_post`
  requests to this origin (`002` D13, D23, D25);
- the invitation and password-reset emails link to
  `INVITATION_LINK_BASE_URL` and `PASSWORD_RESET_LINK_BASE_URL`, which must
  be one of `ALLOWED_ORIGINS`.

`openspec/project.md` §7 already plans one Azure Container Apps app for web
and API with external ingress. The question was where the built app is served
from, and how the API finds it.

## Decision

1. **The API container serves the build, on its own origin.** Fastify serves
   the Vite build next to `/v1` and `/api/auth`, so every call the app makes
   is same-origin and the cookie, CSRF and callback rules above stay as they
   are. The app needs no CORS; `ALLOWED_ORIGINS` keeps its rules and contains
   the app's origin, and the two link base URLs are that origin.
2. **An optional `WEB_DIST_DIR`** (Q21) is the absolute path of the build.
   Unset, no app route is registered and the API answers exactly as before
   (the security headers of ADR-0026 apply either way). Set, startup fails
   unless it is an absolute path to a readable directory that contains
   `index.html`; the error names the variable, never its value
   (`apps/api/src/config.ts`).
3. **Assets** (`apps/api/src/web-static.ts`): `@fastify/static` 10.1.10
   serves `<WEB_DIST_DIR>/assets/` at `/assets/` with `wildcard: false` (the
   file list is read once at startup, one route per file, so no request
   reaches the file system with a client path), `dotfiles: 'deny'`,
   `index: false`, `decorateReply: false` and
   `Cache-Control: public, max-age=31536000, immutable`, because Vite's file
   names carry a content hash. A missing asset is Fastify's own 404.
4. **Root build files** (Q28, Q58): only `theme-init.js` and `favicon.svg`,
   each an explicit `GET` route whose file is read into memory once at
   startup by its fixed name, served with its fixed content type and
   `Cache-Control: no-cache`. A file the build does not ship gets no route;
   nothing else in the build root can be served.
5. **The SPA fallback** (`apps/api/src/spa-fallback.ts`, Q28): one `GET /*`
   route (Fastify derives `HEAD`). For an app path it answers the in-memory
   `index.html` as `text/html; charset=utf-8` with `Cache-Control: no-store`,
   with the response's style nonce substituted for the build's placeholder
   (ADR-0026); any other path that reaches it is the usual 404. One predicate,
   `isSpaPath(pathname)` in `apps/api/src/spa-paths.ts`, decides "an app
   path": not under `/v1`, `/api` or `/assets` (as whole segments), not
   `/healthz`, and not a root build file. There is no file-extension rule,
   because `_user` identifiers are email addresses and identifiers such as
   `v1.2` hold a dot. The same predicate gives the span template `/{spa}`.
   The fallback never reads the session, and the Q74 request-target hook runs
   first, so a path with `%`, `//` or a backslash never reaches it.
6. **Rate limit.** The fallback has its own in-memory bucket keyed by the
   client address (300 requests per minute per replica, never logged).
   Hashed assets and root build files get no in-process limit; the ingress
   limit is a gate of the first deployment (`046`).
7. **Allowlist** (Q39). `PUBLIC_ROUTE_ALLOWLIST` (`apps/api/src/public-routes.ts`)
   has a reviewed entry with a reason ("static, public by nature, no data")
   for the `/assets/` prefix, the fallback and each root build file.
   `route-auth-allowlist.int.test.ts` starts a second harness app with a
   fixture build and `WEB_DIST_DIR`, so those entries are registered routes
   there while the first app keeps proving every other route closed.
8. **The step-up return lands in the app.** With `WEB_DIST_DIR` set, the
   Visma Connect re-authorization callback answers a `303` to one of three
   fixed paths (`/step-up/complete`, with `?result=failed` or
   `?result=rate_limited`), constants that are never derived from the request
   or the OIDC state (design D11).

## Alternatives considered

- **A static host or CDN on a sibling subdomain** (Azure Static Web Apps, for
  example) with CORS (Q2). Every API call would become cross-origin: CORS with
  credentials on the API, a second trusted origin for Better Auth and the
  accept and reset routes, and callbacks that land on the API's origin and
  must hand the browser back to the app's. Rejected.
- **A separate Container Apps app for the web build** (Q2). A second
  deployable with the same cross-origin problems, or a reverse proxy in front
  of both. Rejected.
- **A fixed path inside the image, always served** (Q21). The API alone
  could no longer run without a build (the API-only DAST and the existing
  tests). A separate `MOUNT_WEB_APP` switch next to the path was also
  rejected: two settings for one fact.
- **A "no file extension" rule for the fallback** (Q28). It broke every
  `_user` entity page and any identifier with a dot. An allowlist of app
  route patterns on the server was rejected too: it would duplicate the
  router.
- **A second `@fastify/static` instance with `allowedPath` for the root
  files** (Q58). Rejected for two in-memory routes with fixed names.

## Consequences

- One deployable: the app and the API ship and roll back together, and the
  app is always served next to the API version it was built against.
- The browser security model of `002` stays unchanged, and the app adds no
  CORS origin.
- The API process now serves HTML and static files. Each route is a reviewed
  public entry, listed in `docs/security/attack-surfaces.md`, and the DAST
  baseline spiders the pages and assets with `WEB_DIST_DIR` set.
- `index.html` is `no-store` and the assets are immutable, so a new image is
  picked up on the next page load. A tab opened before a deploy can still ask
  for a hashed chunk that the new build no longer ships; it gets a 404 and
  the page must be reloaded.
- `isSpaPath` is shared by the fallback and the telemetry span template, so a
  new top-level server prefix must be added to it. Otherwise an unmatched path
  under that prefix answers `index.html` instead of a 404, and its span is
  named `/{spa}`.
