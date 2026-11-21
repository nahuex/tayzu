# Catalog UI

The web app of OpenSpec change
[`003-catalog-ui-core`](../../openspec/changes/003-catalog-ui-core/design.md):
a single-page React app in `apps/web` (`@tayzu/web`), built by Vite and served
by `apps/api` on the API's own origin
([ADR-0025](../adr/0025-same-origin-web-hosting.md)). It shows the catalog of
[Catalog core](catalog-core.md) through the routes and the checks of
[Authentication and authorization](auth-and-rbac.md). The server decides
everything; the UI only shows its answers. Where the code and an older
sentence of the design differ, this page describes the code. The package's
working rules are in `apps/web/CLAUDE.md`, and the per-route security view is
in [Attack surfaces](../security/attack-surfaces.md#web-ui-003).

## Pages and routes

TanStack Router's code-based tree, in `apps/web/src/app/router.tsx`. Every
search parameter goes through a Zod schema in `src/app/search-params.ts`: an
invalid value falls back to its default, never to an error page, and the
table and entity routes strip their default values from the URL.

| Route                         | Access                | What it shows                                                                                                                                          | Search parameters                                                                                        |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `/sign-in`                    | Public                | Email and password, then a TOTP or backup code when the account has MFA; "Sign in with Visma Connect"; a link to `/forgot-password`                    | `returnTo` (an in-app path), `error` (`sso` only)                                                        |
| `/forgot-password`            | Public                | One email field and the same "if an account exists" message for every answer but a rate limit                                                          | None                                                                                                     |
| `/reset-password`             | Public                | New password and confirmation, from the `#reset=…&token=…` link of the reset email; a factor field when the account has MFA                            | None (the values come from the fragment)                                                                 |
| `/accept-invitation`          | Public                | "Create a new account" or "I already have an account" (an embedded sign-in), or "Accept" when signed in, from the `#invitation=…&token=…` link         | None (the values come from the fragment)                                                                 |
| `/step-up/complete`           | Public                | Where the Visma Connect re-authorization callback lands: it returns to the stored page, or shows a failure                                             | `result` (`failed` or `rate_limited`)                                                                    |
| `/change-password`            | Session, gate page    | The temporary-password change form (gate `password_change_required`), or the "ask an administrator" page (gate `password_expired`)                     | `returnTo`                                                                                               |
| `/mfa/enrol`                  | Session, gate page    | TOTP enrolment: password, QR code and secret, backup codes, then a code check (gate `mfa_enrolment_required`, or from the user menu when not enrolled) | `returnTo`                                                                                               |
| `/`                           | Session, in the shell | The shell with an empty main region: the blueprint list is the sidebar                                                                                 | None                                                                                                     |
| `/catalog/$blueprint`         | Session, in the shell | The entity table of one blueprint: columns from the blueprint schema, sortable identifier, title and updated columns, keyset paging                    | `sort` (`identifier`, `title`, `updatedAt`), `order` (`asc`, `desc`), `pageSize` (25, 50, 100), `cursor` |
| `/catalog/$blueprint/$entity` | Session, in the shell | The entity page: header, Details tab (spec and status), Related tab (`entities.listRelated`), delete                                                   | `tab` (`details`, `related`)                                                                             |
| `/search`                     | Session, in the shell | Up to 50 results of `GET /v1/search/entities` for the query in the URL                                                                                 | `q` (at most 100 characters)                                                                             |
| Any other path                | Public                | The not-found page. Another tenant's blueprint or entity shows the same not-found page inside the shell                                                | None                                                                                                     |

- **The session gate** (`src/app/session-gate.ts`). The protected routes read
  `GET /v1/me` before their page renders. A `401` sends them to
  `/sign-in?returnTo=<path>`; a gate other than `none` sends them to the gate's
  page. The public pages never read the session, so the reset and invitation
  fragments are gone before any request is made. A `5xx` or a network failure
  fails closed on an error state.
- **The shell** (`src/app/app-shell.tsx`) wraps only the four signed-in routes:
  a header (product name, the search trigger, the locale selector, the theme
  toggle and the user menu with name, organization, role, MFA enrolment and
  sign-out), a sidebar of the tenant's blueprints (`blueprints.list`, one page
  of 500, the `_`-prefixed system blueprints last), a skip link, landmark
  regions, the step-up dialog and the command dialog.
- **Search.** `Ctrl`+`K` or `Cmd`+`K`, anywhere, or the header button, opens
  the command dialog: blueprints filtered locally, then entities from
  `GET /v1/search/entities` (`limit` 10) once the query has 2 characters,
  250 ms after the last keystroke, each request aborting the one before. "See
  all results" opens `/search?q=`.
- **Sign-out** posts `/api/auth/sign-out`, clears the query cache and the
  session-bound stores, and goes to `/sign-in` whatever the answer. Any
  `unauthenticated` answer of a query or a mutation does the same, with
  `returnTo`.
- **Errors.** Only the error kind, issue paths and counts are shown, with
  localized text; a server `message` is never shown. The error boundary shows
  a generic message with a reload action, never an error text or stack.

## Internationalization

i18next with react-i18next, in `src/i18n/i18n.ts`. The locales are `en` and
`es`, and the namespaces are `common`, `auth`, `catalog` and `search`, one JSON
file each under `src/i18n/locales/<locale>/<namespace>.json`. Each file is its
own Vite chunk on the same origin: `common` loads at start, the others when a
page asks for them. There is no HTTP backend and no i18next log output.

- **Locale.** The stored choice (`localStorage` `tayzu.locale`, counted only
  when it is exactly `en` or `es`), else `navigator.language` reduced to its
  language, else `en`. The selector stores the choice, and `<html lang>`
  follows it. The locale lives in the i18next instance, not in a Zustand store.
- **Catalog text.** A blueprint or property title or description is a
  `{ en, es? }` value, shown in Spanish when `es` exists and in English
  otherwise (`localizedText`).
- **Dates and numbers** use `Intl.DateTimeFormat` (`dateStyle: 'medium'`,
  `timeStyle: 'short'`, the browser's time zone) and `Intl.NumberFormat`.

### Adding a key

1. Add the key to the `en` file of its namespace and the same key to the `es`
   file. Every value is a non-empty string.
2. Use it with `useTranslation('<namespace>')` and `t('<key>')`. Any
   `{{placeholder}}` must be the same in both languages.
3. A plural takes `count` (`t('<key>', { count })`) and gets one key per CLDR
   plural category of each language: `_one` and `_other` in English, and
   `_one`, `_many` and `_other` in Spanish. Spanish needs `_many` even when its
   text equals `_other`.
4. Run `pnpm --filter @tayzu/web test`. The parity test, "key parity between
   en and es for every namespace" in `src/i18n/i18n.test.ts`, compares the keys
   without their plural suffix, requires a key to be plural in both languages
   or in neither, requires every category that `Intl.PluralRules` lists for
   each language, and requires the same placeholders.

A new namespace or locale also changes `NAMESPACES` or `LOCALES` and the
lists the parity test expects, which is a test change for the `test-writer`.

## Theme

`system` (the default), `light` or `dark`, stored in `localStorage` under
`tayzu.theme` (`src/state/theme.ts`). The `dark` class on `<html>` drives
Tailwind's `dark` variant, with the color tokens in `src/index.css`.

- **Before first paint.** `index.html` loads `/theme-init.js` as a blocking
  external classic script in `<head>`, so the CSP needs no nonce or hash for
  it. Its commented source is `src/state/theme-init.js`; the
  `tayzu:theme-init` plugin of `vite.config.ts` minifies it (which drops every
  comment) and emits it unhashed at the build root. Never move it to
  `public/`.
- **After start.** The Zustand theme store applies the same rule and, while the
  theme is `system`, follows changes of the operating system's color scheme.
- **Contrast.** Both themes meet the WCAG 2.2 AA contrast ratios, checked by
  axe in both themes on every page (`apps/web/e2e/a11y.spec.ts`). The shadcn
  `--destructive` and light `--muted-foreground` tokens were adjusted for this
  (Q94).

Storage that throws never breaks the theme or the locale: the choice then
holds for the session only.

## Content Security Policy

`apps/api` sends one policy on every response
([ADR-0026](../adr/0026-strict-content-security-policy.md)):

```text
default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<n>';
img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none';
object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

`<n>` is a fresh 128-bit nonce per response. The API writes it into the
`<meta name="tayzu-style-nonce">` of `index.html` (the build holds the
placeholder `__TAYZU_STYLE_NONCE__`), and `src/main.tsx` hands it to
`get-nonce`'s `setNonce`. The e2e CSP tour found exactly one runtime `<style>`
element, Radix's dialog and menu scroll lock (`react-remove-scroll` through
`react-style-singleton`), always carrying that nonce, so the nonce stays
(Q94).

### Keeping a component within the policy

- **No inline script and no inline style in `index.html`.** The bundle check
  fails on either.
- **No inline `style` attributes** in markup, and no code that builds a
  `<style>` element or a `style` attribute from text. Style with Tailwind
  classes. A React `style` prop is applied through the CSSOM, which the policy
  does not restrict, but no component uses one today; keep it that way unless
  a value can only be computed at runtime.
- **A library that inserts a `<style>` element** must read the nonce through
  `get-nonce`, as Radix does. Check a new one with the CSP tour
  (`apps/web/e2e/csp.spec.ts`), which fails on any violation and records every
  runtime `<style>` element in `$E2E_STATE_DIR/runtime-style-record.json`.
- **No evaluated code.** `eval`, `new Function`, `Function(...)`,
  `document.write`, `document.writeln`, `innerHTML`, `outerHTML` and
  `dangerouslySetInnerHTML` are banned by lint. Zod 4 probes for `new Function`
  when its first object schema is created, which the policy reports even when
  caught, so `src/lib/zod-config.ts` sets `z.config({ jitless: true })` and must
  stay the first import of `main.tsx` (Q91).
- **Same origin only.** No CDN, web font, third-party script or image: icons
  come from `lucide-react`, bundled, and markdown images are not rendered.
  The QR code of `/mfa/enrol` is an inline SVG with no `style`.
- **Leaving the origin** happens only through `src/lib/navigate-away.ts`
  (`navigateToExternal`), for an absolute `https:` Visma Connect URL the API
  returned, after a click.

The Vite dev server has its own looser policy, for `vite serve` only (see
[Running the app](#running-the-app)).

## Browser storage inventory

Design D15. This is the complete list, checked with a search over
`apps/web/src` for `localStorage`, `sessionStorage`, `indexedDB`,
`document.cookie` and persisted stores:

| Storage          | Key                     | Value                                                   | Written by                                                             | Lifetime                                  |
| ---------------- | ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `localStorage`   | `tayzu.theme`           | `system`, `light` or `dark`                             | The theme toggle (`src/state/theme.ts`); read by `/theme-init.js` too  | Until changed; kept on sign-out           |
| `localStorage`   | `tayzu.locale`          | `en` or `es`                                            | The locale selector (`src/i18n/i18n.ts`)                               | Until changed; kept on sign-out           |
| `sessionStorage` | `tayzu.stepUp.returnTo` | An in-app path, validated by `safeReturnPath` both ways | The "Continue with Visma Connect" click (`src/auth/step-up-return.ts`) | Deleted when `/step-up/complete` reads it |

Nothing else is stored: no token, password, TOTP secret, backup code,
invitation or reset token, search query or tenant data, and no cookie is read
or written by script (the session cookie is HTTP-only). The query cache is in
memory only and is never persisted. The stored step-up path is `/search`
without its query, and on the accept page only `/`. Every storage access is
wrapped in `try`/`catch`, and the app works when storage throws.

## Bundle budget

`pnpm --filter @tayzu/web check:bundle` (`src/build-check/check-bundle.ts`)
runs after the build in CI and in `pnpm ci:local`. It fails when:

- the initial JavaScript is over **350 kB gzip**: every `<script src>` and
  `<link rel="modulepreload">` that `index.html` references, summed (lazy
  chunks, such as the locale files, do not count);
- `index.html` has an inline `<script>` or a `<style>` element, or references
  an `http:` or `https:` origin;
- any file of `dist/` names a Secret-class variable of
  [Secrets](../security/secrets.md);
- a source file reads `import.meta.env.VITE_*`.

A gitleaks scan of `dist/` runs next to it. The build of 2026-11-21 has about
287 kB gzip of initial JavaScript, almost all of it the one entry chunk.

## Entity identifiers in URLs

The entity page's path holds the identifier as one segment,
`/catalog/$blueprint/$entity`. The API's request-target rule refuses any path
holding `%` (`002` Q74), so the identifier must travel unencoded (Q36):

- **`@`, `:` and `=` open normally.** The router is created with
  `pathParamsAllowedCharacters: ['@', ':', '=']`, and the API client
  (`src/api/client.ts`) undoes only the `%40`, `%3A` and `%3D` escapes that
  oRPC's `encodeURIComponent` writes. So `team@example.com:prod=1` and a
  `_user` email open. Every other escape stays, `%25` included.
- **An identifier holding `/`, or made only of dots, cannot be opened**
  (`isAddressableIdentifier` in `src/catalog/columns.ts`): the first would need
  `%2F`, and the browser normalizes the second away. Such an entity is listed,
  but its link (`EntityLink`) is a disabled link with no `href` and a visible
  localized note, in the table, the related rows, the command dialog and the
  search page.
- **Telemetry never sees the path.** Every app path exports the span route
  `/{spa}`, so an email in the address bar never reaches a span.

## Running the app

The app needs a built `apps/web/dist` served by `apps/api`, or the Vite dev
server in front of a local API. Node `>=22.22.2` (the root `engines`).

```sh
pnpm --filter @tayzu/web build          # tsc -b, then vite build into apps/web/dist
pnpm --filter @tayzu/web check:bundle   # the bundle check above
pnpm --filter @tayzu/web test           # component tests (Vitest, jsdom)
```

**Served by the API.** Set `WEB_DIST_DIR` to the absolute path of
`apps/web/dist` and start the API as usual (see
[Secrets](../security/secrets.md)). Startup fails unless the directory holds
an `index.html` with the nonce placeholder. Outside the test harness every
origin is `https:`, so a production-like stack needs TLS in front of the API:
the e2e stack below is the way to run one locally.

### The dev server

```sh
pnpm --filter @tayzu/web dev    # http://127.0.0.1:5173
```

- It listens on `127.0.0.1:5173` only, with `strictPort` and
  `server.fs.strict`; never start it with `--host`.
- It proxies `/v1` and `/api/auth` to a local API at `http://127.0.0.1:3000`
  and sends a development-only policy: `script-src 'self' 'unsafe-eval'` plus
  the hash of the React Refresh preamble (no `'unsafe-inline'` scripts),
  `style-src 'self' 'unsafe-inline'`, `ws://127.0.0.1:5173` in `connect-src`,
  and `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and
  `X-Frame-Options: DENY`. The build and `vite preview` never carry it.
- The proxy keeps the browser's `Origin`, so an API behind it must list
  `http://127.0.0.1:5173` in `ALLOWED_ORIGINS`, which `loadConfig` accepts
  only with `NODE_ENV=test`. No script starts that combination and no test
  covers it, so a sign-in through the dev server is not a supported path yet.
  For the pages behind a session, use the e2e stack.

### The end-to-end suite

Playwright 1.63.0, Chromium only, specs in `apps/web/e2e/*.spec.ts`, run
against the real stack of `scripts/ci/e2e.sh` (Q91):

```sh
pnpm e2e                         # e2e.sh all: up, test, down
bash scripts/ci/e2e.sh up        # start the stack and seed it
bash scripts/ci/e2e.sh test      # run the whole suite against it
bash scripts/ci/e2e.sh down      # stop everything
```

It needs Docker, `openssl`, a running Cerbos (`scripts/dev/start-cerbos.sh`
or `docker compose up -d --wait cerbos`) and the Playwright Chromium:
preinstalled in the cloud sandbox (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
revision 1243), or `pnpm --filter @tayzu/web exec playwright install chromium`.
Without Docker `e2e.sh` exits 77, and `pnpm ci:local` reports a `SKIP`, as it
does without a Playwright Chromium. A full run takes about 8 minutes.

- **The stack.** `up` builds the app, starts PostgreSQL 18 behind verified TLS
  (`sslmode=verify-full`), migrates it, gives the runtime roles random
  passwords, and starts the OIDC stub of `@tayzu/auth` as Visma Connect and the
  API from `main.ts` with `NODE_ENV=production`, `WEB_DIST_DIR` and
  `MOUNT_IDENTITY_ROUTES=true`, both on `127.0.0.1` over plain HTTP.
- **The TLS proxy.** `scripts/ci/e2e-tls-proxy.ts`, a `node:https` proxy used
  only here, serves the app at `https://localhost:8443` and the stub at
  `https://127.0.0.1:8444`, a different site, as Visma Connect is in
  production (Q92). One throwaway CA per run signs the PostgreSQL and proxy
  certificates and its key is deleted. Node trusts it through
  `NODE_EXTRA_CA_CERTS`, and Chromium trusts only that CA and the proxy's
  certificate, by their SPKI hashes (`playwright.config.ts`), never through
  `ignoreHTTPSErrors`.
- **The seed.** `apps/web/e2e/fixtures/seed.ts` creates two tenants through the
  real services (the bootstrap CLI and an in-process app with the recording
  email sender): an admin with TOTP, a member without MFA, a user under a
  temporary password, a Visma Connect user, an invitation, a reset request and
  the catalog data, all with random credentials. It writes them and the
  captured links to `$E2E_STATE_DIR/seed.json` (mode 0600, never printed;
  default state directory `${RUNNER_TEMP:-/tmp}/tayzu-e2e`). A green `all`
  deletes it. Each single-use item belongs to one spec, so after a partial run
  start again with `up` (Q93).
- **The guard** (`e2e/fixtures/test.ts`). Specs import `test` and `expect` from
  there, never from `@playwright/test`. A test fails on any
  `securitypolicyviolation`, any console or page error, any `4xx` or `5xx`
  from the app's origin it did not declare, and any request to another origin
  (the stub's only with `allowOidcOrigin`).
- **Expected errors** (Q92). Chromium logs every error answer as a console
  error, including the ones a flow requires (the gate's `401` from
  `GET /v1/me`, a step-up `403`, a not-found `404`). A test declares those as
  `status` and exact pathname pairs, with `test.use({ expectedApiErrors })` or
  `guard.expectApiError(status, path)` before the action. Only a declared
  `4xx` on the app's origin is exempt; a `5xx` never is.
- **Sign-in pacing** (Q93). The stack keeps the production limit of 10 local
  sign-ins per 60-second window per address, and the whole suite shares one
  address. The fixture records each sign-in in a ledger in the state directory
  and, before a test, waits for a quiet window when the sign-ins the test
  declares (`test.use({ signInBudget })`, one by default) would not fit. The
  TOTP step-up spec also waits out the five-minute freshness of its own
  sign-in.
- **Reports.** One worker, no retry, a trace and a screenshot only on
  failure, written under the state directory, outside the repository. A trace
  can hold the run's credentials, so CI uploads the report only on failure and
  keeps it 3 days. The repository is public, so that artifact can be downloaded
  by anyone for those 3 days; this is accepted because every credential is
  random per run and the stack is thrown away when the job ends (D2, D16).
