# ADR-0026: A strict, self-only Content Security Policy on every response

- **Status**: Accepted
- **Date**: 2026-11-21
- **Change**: [`003-catalog-ui-core`](../../openspec/changes/003-catalog-ui-core/design.md) (design D10; Resolved decisions Q5, Q15, Q22, Q25, Q30, Q45, Q46, Q60, Q61, Q91, Q94)

## Context

Until `003-catalog-ui-core` the API served only JSON, and `002-auth-and-rbac`
ran `@fastify/helmet` with `contentSecurityPolicy: false`. `003` serves a
single-page app from the same origin (ADR-0025). The app renders tenant data
(titles, descriptions, property values, markdown) and holds a session that
can change the catalog, so a script injected into a page could act as the
signed-in user. A Content Security Policy is the browser-side limit on what
such a script could load or run.

The human asked for a strict, self-only policy (Q5): `default-src 'self'`, no
inline script, no `'unsafe-inline'`, self-hosted fonts and icons,
`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`,
`form-action 'self'` with the Visma Connect origin only if needed, a looser
policy only in the Vite dev server, and a green DAST scan.

Two facts of the stack shaped the details:

- Radix's dialog and menu scroll lock (`react-remove-scroll`, through
  `react-style-singleton`) inserts a `<style>` element at runtime, whose
  content depends on the measured scrollbar width;
- Vite's dev server needs `eval`, an inline React Refresh preamble, inline
  styles and an HMR WebSocket.

## Decision

1. **One enforced policy on every response** (HTML, JSON, assets and 404s),
   whether or not `WEB_DIST_DIR` is set. `@fastify/helmet` runs with
   `contentSecurityPolicy.useDefaults: false` and the exact directive list
   `CSP_DIRECTIVES` in `apps/api/src/server.ts`, so no helmet default (such
   as `upgrade-insecure-requests` or `script-src-attr`) is added:

   ```text
   default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<n>';
   img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none';
   object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self';
   base-uri 'none'; form-action 'self'; frame-ancestors 'none'
   ```

   Helmet sends it with no space after each `;`. It is never report-only.
   Helmet and the `Permissions-Policy` hook are registered before the Q74
   request-target hook, because a 404 that hook answers skips every later
   `onRequest` hook; neither reads the request (Q60).

2. **`script-src 'self'`, with no nonce and no hash.** `index.html` has no
   inline script. Vite emits external module scripts, and the theme is
   applied before first paint by the external classic script
   `/theme-init.js`, which the build minifies and emits without comments
   (Q46). Zod 4 probes for `eval` with `new Function` when its first object
   schema is created, which the policy reports even when caught, so
   `apps/web/src/lib/zod-config.ts` sets `z.config({ jitless: true })` as the
   first import of `main.tsx` (Q91). `upgrade-insecure-requests` is left out:
   production is HTTPS-only with HSTS already, and the directive would break
   the HTTP e2e and DAST stacks on `localhost`.
3. **The style nonce** (Q15). Each response gets a fresh 128-bit nonce from
   `crypto.randomBytes(16)`, base64-encoded, drawn by Tayzu's own `onRequest`
   hook (`apps/api/src/style-nonce.ts`) and read by a `style-src` directive
   function. Helmet's `enableCSPNonces` is not used: it emits hex and adds the
   nonce to `script-src` too. The SPA fallback substitutes the same nonce for
   the `__TAYZU_STYLE_NONCE__` placeholder of
   `<meta name="tayzu-style-nonce">` in `index.html`, and startup fails if the
   build has no placeholder. `main.tsx` reads the meta and hands the nonce to
   `get-nonce`'s `setNonce`, which the scroll lock reads for its `<style>`
   element. Non-HTML responses carry a nonce that nothing uses. React's
   `style` props go through the CSSOM, which CSP does not restrict, so no
   `'unsafe-inline'` and no style hash is needed.
4. **The nonce's removal condition, and its outcome.** Design D10 kept the
   nonce only if the e2e CSP check (task 10.8) found a runtime `<style>`
   element; with none, the nonce would go and `style-src` would be `'self'`.
   The check (`apps/web/e2e/csp.spec.ts`) tours every route and dialog in
   both themes and records every `<style>` element a document gains. It found
   one, Radix's scroll lock, inserted when a menu or dialog opens and always
   carrying the page's nonce, and no violation (Q94). **So the nonce stays.**
   The condition still holds for the future: if a later change removes the
   last component that inserts a `<style>` element and the tour records none,
   the nonce, its hook, the meta, the placeholder and `get-nonce` are removed
   and `style-src` becomes `'self'`.
5. **`form-action 'self'`, without the Visma Connect origin** (Q25). The app
   never submits a native form to Visma Connect: sign-in and step-up start
   with a JSON call that returns a URL, and the browser then navigates to it,
   which `form-action` does not govern. The auto-submitting `form_post` page
   is Visma Connect's own document, under its own policy, posting to this
   origin. The Visma Connect tests of the e2e suite, against the OIDC stub on
   another site, raise no violation. Adding the Visma Connect origin would be
   a new question to the human before the policy changes.
6. **Other headers** (design D10): `X-Frame-Options: DENY` (helmet's default
   is `SAMEORIGIN`), matching `frame-ancestors 'none'`;
   `Cross-Origin-Embedder-Policy: require-corp`, since every resource is
   same-origin; `Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`
   and `X-Content-Type-Options: nosniff`; and
   `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`,
   without `interest-cohort`, which Chromium reports as a console error. HSTS
   stays as `002` set it, and `Cache-Control: no-store` stays the default for
   everything but the hashed assets.
7. **The development policy** applies to the Vite dev server only. It is set
   in `apps/web/vite.config.ts` (`DEV_CONTENT_SECURITY_POLICY`) for
   `vite serve`, and never for `vite preview` or the build:

   ```text
   default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-<preamble>';
   style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self';
   connect-src 'self' ws://127.0.0.1:5173; media-src 'none'; object-src 'none';
   frame-src 'none'; worker-src 'none'; manifest-src 'self'; base-uri 'none';
   form-action 'self'; frame-ancestors 'none'
   ```

   The `sha256-` source is the hash of the React Refresh preamble that
   `@vitejs/plugin-react` inlines, computed from the plugin's exported
   `preambleCode`, so even the dev `script-src` has no `'unsafe-inline'`
   (Q45). The dev server also sends `Referrer-Policy: no-referrer`,
   `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, listens on
   `127.0.0.1:5173` only (`strictPort`, `server.fs.strict`), and proxies `/v1`
   and `/api/auth` to a local API on `127.0.0.1:3000`. The build never
   carries this policy: the bundle check refuses any inline `<script>` or
   `<style>` in the built `index.html`, and `apps/api/src/headers.int.test.ts`
   asserts that the served `script-src` is exactly `'self'`.

8. **DAST stays green** (Q22, Q46, Q61). `scripts/ci/dast.sh` builds the app
   and starts the API with `WEB_DIST_DIR`, so the ZAP baseline runs its CSP
   and header rules against the pages and assets. Only 10109 "Modern Web
   Application", which fires on any single-page app, is set to `INFO` in
   `.zap/rules.tsv`; 10027 (a comment in `theme-init.js`) was fixed by
   shipping that file minified, not by ignoring the rule.
9. **No violation reporting yet** (Q30). The policy has no `report-to` or
   `report-uri`. A same-origin report endpoint with a sanitized log is a gate
   of the first deployment (`046`).

## Alternatives considered

- **`style-src 'self' 'unsafe-inline'`** (Q15). It allows any injected style,
  and ZAP flags it (10055). Rejected.
- **A style hash instead of a nonce.** The scroll lock's CSS holds the
  measured scrollbar width, so its hash cannot be known at build time.
  Rejected.
- **Avoiding every component that inserts styles** (Q15), for example a
  custom dialog without Radix's scroll lock. More code to own for the same
  policy. Rejected.
- **Helmet's `enableCSPNonces`.** Hex nonces, and a nonce on `script-src`
  that no script needs. Rejected.
- **A script nonce with `'strict-dynamic'`.** Useful when inline scripts are
  unavoidable; here there are none, so it would only add per-response
  rewriting of script tags. Rejected.
- **Relaxing `script-src` for zod's `eval` probe** (Q91). Rejected: jitless
  mode removes the probe.
- **The Visma Connect origin in `form-action` now** (Q25). Not needed by any
  flow the app has. Rejected.
- **The same loose policy in development and production** (Q5). Rejected.
- **A report-only policy first.** It would leave production unprotected while
  it collects reports. Rejected; the e2e CSP tour finds violations before
  release instead.

## Consequences

- Every component and page must stay within the policy: no inline script or
  event handler, no `eval` or `new Function`, no external origin (fonts and
  icons are bundled), and no `<style>` element without the nonce. The web
  lint rules ban the script sinks, the bundle check refuses inline script and
  style in `index.html`, and the e2e suite fails on any
  `securitypolicyviolation` and on any request to another origin.
- A new library that inserts `<style>` elements must take the nonce through
  `get-nonce` or it fails the e2e CSP check.
- `frame-src 'none'` and `worker-src 'none'` exclude the sandboxed plugin
  iframes of `openspec/project.md` §5 and any web worker. The change that
  first needs either amends this ADR.
- The nonce is per response and never stored or logged. It belongs in
  `docs/security/crypto-inventory.md` with its source, size and lifetime
  (task 11.7).
- Two `002`-era assertions changed with this decision:
  `apps/api/src/headers.int.test.ts` (`SAMEORIGIN`, and no CSP) and
  `apps/api/src/bootstrap-wiring.int.test.ts` (no CSP, Q60).
- No test starts the Vite dev server and reads its headers, so the dev
  policy is checked only by review of `vite.config.ts`; the tests prove only
  that the build and the served policy never carry it.
