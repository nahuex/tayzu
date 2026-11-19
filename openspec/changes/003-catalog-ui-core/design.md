# Design: 003-catalog-ui-core

## Context

- **What this change is.** The first browser application of Tayzu, over the catalog
  API of `001` and the identity surface of `002`, `043` and `044`. The human reduced
  its roadmap scope on 2026-11-18 (Resolved decisions Q1, Q8 and Q9, recorded as
  roadmap decision D13 in `openspec/project.md` §23): `003` is the core (shell, every
  authentication page, i18n, the catalog table, the entity page with Details and
  Related tabs, minimal search), `047-catalog-ui-customization` takes layouts, saved
  views, branding, the banner, icons and enum colors, and
  `046-azure-deployment-and-first-release` takes the first deployment. `003` depends
  on `001` and `002` and executes after `045`
  (`002 -> 043 -> 044 -> 045 -> 003 -> 046`).
- **Decisions.** The rows Q1 to Q11 of "Resolved decisions" are the human's answers of
  2026-11-18, each with what was rejected. The fifteen assumptions this design first
  had to make without a human decision (OQ1 to OQ15) were asked in chat and answered by
  the human the same day as Q12 to Q26, each with the recommended option. Task 1.1
  raised seventeen more, answered on 2026-11-18 and 2026-11-19 as Q27 to Q43, each with
  the recommended option. This change has no Open Questions; a new question becomes a
  row from Q44 on.
- **Task 1.1 (VCDM Mode A pre-assessment and drift-check against `master`,
  2026-11-18/19).** The pre-assessment found two blocking gaps, both SEC16: B1, an app
  path that the fallback does not answer (a `POST`, a refused `%40` path, a 404) kept its
  raw path, so a `_user` email could reach an exported span; and B2, a Visma Connect
  step-up was never logged as succeeded and a failed re-authorization callback left no
  trace. The human kept Checkpoint 1 approved on condition of their fixes (Q27): the
  path-shape `/{spa}` template shared with the fallback (Q28, Observability contract,
  task 4.6) and the step-up telemetry of task 3.11 (Q29). Its non-blocking gaps and the
  questions only the human could answer (Q30 to Q35) are folded into the posture table,
  the Gates, the Tickets and the tasks. The drift-check found six design conflicts,
  decided as Q36 to Q43, a set of design-only fixes (the step-up dialog keyed on the
  sign-in method, the `GET /v1/me` export, the header details, the tooling details, the
  error model and the `defineCatalogOperation` call form), and the mechanical drift
  corrected in the "Current state" bullets below. `packages/catalog/CLAUDE.md` still
  shows the old positional `defineCatalogOperation(name, handler)` form; task 11.8 fixes
  it.
- **Where the earlier changes are.** `001`, `002`, `043`, `044` and `045` are archived:
  `openspec/changes/archive/2026-09-28-001-catalog-core/`,
  `openspec/changes/archive/2026-10-15-002-auth-and-rbac/`,
  `openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin/`,
  `openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery/` and
  `openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention/`. A
  reference such as "`002` D25" is to the design in that folder.
- **What earlier changes left to this one.**
  - `001` T4: "sanitize markdown and URL values on render; strict CSP" (`001` design
    line 603; SEC06 row, line 583). `001` T7: backfill ADR-0001 to ADR-0007 (line 612);
    this change writes the two that concern it, ADR-0004 and ADR-0007 (Q11).
  - `001` design lines 51 and 177 say "003 adds" filtering, full-text search and GIN
    indexes, while the roadmap gives search and query to `005`, which depends on `003`
    (`roadmap-analysis.md:61-76`). Q4 settles it: `003` adds a minimal search and the
    meta-field sort; the filter language and full-text search stay in `005`.
  - `002`: the login screen offering local sign-in or Visma Connect (Non-Goals, lines
    77-81, Q17); "CSP is `003`'s concern" (D13, lines 444-445); front-channel logout
    "`003` can add later" (line 986), which this change does not add.
  - `043` Q32 and design lines 1972-1990: the `/accept-invitation` page, which must
    strip the fragment after reading it, send `Referrer-Policy: no-referrer` and load
    no third-party script; until it exists the invitation link is inert.
  - `044` D14 (lines 987-997), Q10 and Q26: the `/reset-password` page, with the same
    three rules plus "never submits without the user's action" and "shows a factor
    field when the confirm route answers `AUTH_STEP_UP_REQUIRED`"; both pages are
    gates for turning on `MOUNT_IDENTITY_ROUTES` (`044` Gates, line 1439).
- **References** (`openspec/project.md` §22). The relevance-matrix row of this change
  is `docs/references/platform-engineering/README.md:59`; its takeaway at `:78` is
  "keep 003 thin, put the effort into 004 and 008".
  - `RA-AZ` (`idp-reference-architecture-azure.md`) L306-L314 states that the portal
    is the user interface over the platform layers (catalog, deployment dashboards,
    resource views) and that the trend is a single pane with observability. This
    change builds only the catalog view; the rest is later work.
  - `SPE4` (`state-of-platform-engineering-vol-4-2025.md`) L190 states the "portal
    trap". The inference for `003` is a thin UI with no business logic of its own: every
    rule stays in the API (D4, D15).
  - `SOV` (`building-the-sovereign-idp.md`) L443 states that a self-hosted portal stays
    available during a network partition. The inference is no runtime dependency on a
    third-party CDN, font or script host (D10), which Q5 also requires.
  - `OBS` (`observability-for-platform-engineers.md`) L70 and L104 state RUM and trace
    correlation from the browser. Q6 defers RUM to `016` (a ticket).
  - `VULN` (`vulnerability-management-for-platform-engineers-2026-01-30.md`) L87 and
    L176 ("shift down", insights where developers already work) apply to later views,
    not to `003`.
  - Port: `docs/references/port/roadmap-analysis.md:61-76` (the `003` section) and the
    parity rows of `docs/references/port/ui-parity-matrix.md` 22.1-22.3, 23.1-23.3,
    23.8, 28.1-28.3, 1.1-1.3, 2.1 and 4.1. Every demo-observation cell of those rows is
    still empty, so nothing here relies on how Port's UI looks; this change implements
    behaviour only, in Tayzu's own visual identity, and copies no Port code, text,
    logo or asset (ADR-0022). Two inconsistencies of the analysis are noted, not acted
    on: its mapping table (`roadmap-analysis.md:653`) sends export to `024`, and the
    inventory (`port-capability-inventory.md:288`) splits the table toolkit across
    `003`, `005`, `011` and `024`; after Q1 the toolkit beyond sort and pagination is
    `005` and `047`.
- **Current state, verified against `master` on 2026-11-18.**
  - Workspace: there is no `apps/web`. `pnpm-workspace.yaml` already globs `apps/*`
    and lists `esbuild` and `protobufjs` as `false` in `allowBuilds`. `turbo.json` gives
    every task `outputs: []` (Just-in-Time packages, no build output).
    `tsconfig.base.json` has `lib: ["ES2023"]` and `types: ["node"]`.
    `eslint.config.js` lints `**/*.{js,ts}` only (line 92), so a `.tsx` file is not
    linted. `vitest.shared.ts` globs `src/**/*.test.ts` in a `node` environment. The
    root already has `vite` `^8.3.3` as a dev dependency (Vitest's).
    `.claude/hooks/tdd-path-guard.sh` (line 13) treats `*.test.ts`, `*.test.tsx`,
    `*.int.test.ts` and fixtures as tests, and nothing else.
  - The browser in the cloud sandbox is Chromium revision 1243 at `/opt/pw-browsers`
    (`PLAYWRIGHT_BROWSERS_PATH`), installed by `playwright-core` 1.63.0
    (`/opt/node-tools/node_modules/playwright-core/browsers.json`), and is already used
    to render Mermaid (`docs/dev-environment/README.md:21`).
  - API (`apps/api/src/server.ts`): Better Auth's `trustedOrigins` (line 336) and the
    `Origin` checks of the accept and reset routes (1014-1016, 1116-1118, 1145-1147)
    refuse an `http:` origin outside test; the step-up interceptor throws
    `AUTH_STEP_UP_REQUIRED` with `data.reauthorizationUrl` for an SSO session, and
    without it when `start()` returns `null` (514-551, the throw at 537-549);
    `SimpleCsrfProtectionHandlerPlugin` requires `x-csrf-token: orpc` on every non-`GET`
    route (554-564); the first `onRequest` hook refuses a target that is not
    origin-form or whose path holds `%`, `//` or a backslash (`002` Q74, 575-584, the
    test at 581); helmet runs with `contentSecurityPolicy: false` (601-606); an `onSend`
    hook sets `Cache-Control: no-store` on every response that has none (607-614); CORS
    is an exact-match allowlist with credentials (615-627); `@fastify/rate-limit` runs
    with `global: false` (634), so a route has a limit only if it opts in; the
    re-authorization callback's limiter answers a JSON `429` (869-880); the callback scope
    (881-913, handler 895-903, routes 904-911) answers `200 {}` or `400
    {defined:false, code:'BAD_REQUEST', status:400}` as JSON, which leaves a browser on
    a JSON page after the `form_post`; the `/v1/*` catch-all (1188-1226) refuses an admin
    without an enrolled factor with `AUTH_STEP_UP_REQUIRED` (1201-1211). Every Fastify
    route is either in `PUBLIC_ROUTE_ALLOWLIST` (`apps/api/src/public-routes.ts:17-68`)
    or answers an anonymous call with `401 CATALOG_CONTEXT_REQUIRED`, which
    `route-auth-allowlist.int.test.ts` enforces; its lines 208-220 also reject an entry
    that is not a registered route. Exported HTTP spans drop the query string and
    replace seventeen identifier-carrying paths by their templates
    (`apps/api/src/telemetry.ts:48-124`, the templates at 56-74).
    `apps/api/src/headers.int.test.ts` asserts `X-Frame-Options: SAMEORIGIN` (83-84) and
    the absence of a CSP (103-106); D10 changes both.
  - Step-up telemetry (`packages/auth`): `emitStepUpSucceeded` hard-codes
    `tayzu.auth.method` `local` (`auth.ts:346-361`); the SSO branch of `step-up.ts`
    (316-337) emits only the required and insufficient outcomes, and a TOTP or password
    verification never satisfies an SSO session (316-334); `sso/reauthorization.ts` has
    no telemetry at all, and its `start()` returns `null` when five states are already
    pending for the session or discovery fails (96-127). `auth.security.step_up_succeeded`
    is declared in `002`'s contract (`telemetry/contract.ts:137`, attributes tenant,
    actor and `tayzu.auth.method`).
  - Catalog contract (`packages/catalog/src/api/contract.ts`): contract-first
    (`oc.router`, lines 405-463, twelve procedures), so the procedure types exist without
    the router; but the module imports `node:fs/promises`, `node:path` and `node:url`
    (lines 35-37) for document generation and drift checking, so a browser bundle cannot
    import it. `@orpc/client` and `@orpc/openapi-client` 1.15.4 are already in the
    lockfile as transitive dependencies; the OpenAPI link encodes every path parameter
    with `encodeURIComponent`, so an identifier with `@`, `:` or `=` reaches the server
    percent-encoded and the Q74 hook refuses it (Q36). Catalog issues are
    `{ path, message }` (`api/errors.ts:23-26`); there is no issue code.
  - Catalog list: keyset pagination on `identifier` only
    (`packages/catalog/src/domain/pagination.ts`, cursor `{ "k": <identifier> }`;
    `entities-repository.ts:84-107`); default page 50, maximum 500
    (`domain/limits.ts`). No sort, no filter, no free text, no cross-blueprint search,
    no count. The operation is declared as
    `defineCatalogOperation<I, O>({ name, pool, authz, authorization: PLAN_AUTHORIZED,
    handler })` (`service/entities.ts:1655-1659`). The Cerbos `list` plan is built
    without a blueprint (`planEntityList`, 282-304; `runEntityListPlan`, 306-323) and its
    mapper expressions are per row (249-276: `BLUEPRINT_IDENTIFIER_SQL`,
    `OWNER_TEAM_SQL`), so the same filter narrows a query over several blueprints. No
    migration creates an extension; the migrations live in `packages/db/migrations/`
    and the journal ends at idx 14, so `0015` is next.
  - Entity identifiers match `^[A-Za-z0-9@_.:/=-]{1,256}$`
    (`packages/catalog/src/domain/identifiers.ts:22`). One containing `/` needs `%2F` in
    a URL path, which the Q74 hook refuses, so such an entity is unreachable over HTTP
    today (Q18); `@`, `:` and `=` are valid unencoded in a path segment, so those
    identifiers become reachable once the client stops encoding them (Q36). `_user`
    identifiers are emails, so they always hold `@` and a dot.
  - Identity: the Better Auth allowlist (`packages/auth/src/http/allowed-routes.ts:10-35`)
    holds `/sign-in/email`, `/sign-out`, `/get-session`, `/two-factor/enable`,
    `/two-factor/verify-totp`, `/two-factor/generate-backup-codes`,
    `/two-factor/verify-backup-code`, `/organization/set-active`, `/sign-in/social`,
    `/callback/visma-connect`, `/link-social`, `/unlink-account`, `/list-accounts`,
    `/verify-password`, `/change-password` and `/jwks`; there is no route listing
    organizations (decision D7, no org switcher). A session under the
    temporary-password marker may reach only `/change-password`, `/sign-out` and
    `/get-session` (`packages/auth/src/identity/temporary-password.ts:45-49`); under the
    re-enrolment marker only `/two-factor/enable`, `/two-factor/verify-totp`,
    `/get-session` and `/sign-out` (`identity/mfa-reenrol-marker.ts:20-25`).
    `resolveContext` checks both markers (`context-resolver.ts:704-717`) before the
    membership, the open-tenant and the `_user` checks (719-762), rejects every case
    with the same uniform error, and keeps those helpers private; a membership role can be
    a comma-separated list, and `toCerbosRole` folds `owner` into `admin` (336-339). So
    a `/v1` call cannot tell the browser which gate applies (D8). The invitation link is
    `/accept-invitation#invitation=<id>&token=<token>`
    (`apps/api/src/identity/invitation-link.ts`), accepted with
    `{ invitationId, token, password? }` (`identity/accept-flow.ts:172-178`); the reset
    link is `/reset-password#reset=<id>&token=<token>`
    (`apps/api/src/identity/password-reset-link.ts`), confirmed with
    `{ id, token, newPassword, factor?: { kind: 'totp' | 'backup_code', code } }`
    (`identity/password-reset-confirm.ts:38-54, 91-105`).
  - Tooling: `eslint.config.js:154` holds a test-file override that matches `*.test.ts`
    and misses `*.test.tsx`; typescript-eslint's `projectService` finds only a file's
    nearest `tsconfig.json`, so a sibling `tsconfig.node.json` is not seen;
    `eslint-plugin-jsx-a11y` 6.10.2 declares ESLint peers only up to 9 while the
    repository runs ESLint 10.11.0, and it depends on `axe-core` (MPL-2.0) (Q40);
    `allowBuilds` lists `esbuild` as `false`; jsdom 30.1.3 requires Node `^22.22.2`, the
    root `engines` says `>=22.12.0`, and the sandbox runs Node 22.23.4.
  - DAST: the ZAP baseline targets the API on `localhost:3000`
    (`scripts/ci/dast.sh`); `.zap/rules.tsv` sets only rule 10049 to `INFO`, and every
    other alert fails the job.
- **Two pieces of drift outside this change, noted and not changed here.** (1) The
  first-deployment gates of `002` to `045` name "`010`", the pre-renumbering id of the
  observability-dogfood change, which is `016` in §23, while §23's `010` is
  `010-workflow-self-service-forms`; Q8 gives those gates to `046` and a ticket repoints
  them. (2) `043` Q32 says `INVITATION_LINK_BASE_URL` is "never `BETTER_AUTH_URL`",
  because the API origin rendered nothing for a person. Under Q2 the app and the API
  share one origin, so the two settings hold the same origin; the rule that the link
  base is its own setting, never derived from `BETTER_AUTH_URL` or a request header,
  still holds and is unchanged.

## Goals / Non-Goals

**Goals:**

- A browser application that a member, an admin and an invited person can use end to
  end: sign in (locally or through Visma Connect), pass every gate the API enforces
  (temporary password, MFA enrolment and re-enrolment, step-up), browse the catalog
  per blueprint, open an entity, follow its relations, and search.
- Serve it from the API's own origin under a strict, self-only CSP, so the cookie,
  CSRF and SSO designs of `002` hold unchanged and DAST covers the pages (D9, D10).
- Build every page that `002`, `043` and `044` left to this change, with their page
  rules, so that `MOUNT_IDENTITY_ROUTES` can be turned on in `046` (D11).
- Add only the server surface the UI cannot do without: search, sort, `GET /v1/me`
  and the re-authorization redirect, each tenant-scoped, Cerbos-narrowed and in the
  telemetry contract (D5 to D8).
- Accessibility to WCAG 2.2 A and AA, checked by axe-core in the e2e suite, and
  keyboard operation of every page (D16).

**Non-Goals:**

- Page layouts, saved views, column configuration, branding, the announcement banner,
  the icon library, enum colors and their storage (`047`, Q1). The table shows the
  default columns and nothing is persisted per user or per organization.
- The filter language, full-text search, admin-chosen search indexing, the "My" and
  "My Teams" filters, group-by and export (`005`, `024`; Q1, Q4).
- Entity and blueprint create and edit forms, the JSON Schema form generator and the
  Builder mode (Q12; `project.md` §5).
- Browser telemetry of any kind, and CSP violation reporting (Q6; ticket to `016`).
- An organization switcher (`042`, decision D7), a profile locale field (Q10), a
  timezone setting (`project.md` §15), and front-channel logout.
- Any Azure resource, image build or deployment (`046`, Q8). Nothing here is deployed.

## Decisions

### D1. Package layout

```text
apps/
  api/        @tayzu/api   gains the static routes, the CSP, GET /v1/me, the callback redirect
  web/        @tayzu/web   new: the SPA
    index.html             no inline script or style
    public/theme-init.js   applies the stored theme before first paint (external file)
    src/
      main.tsx             entry: providers, router
      api/                 the oRPC client, the auth client, the error model
      app/                 shell, sidebar, header, session gate, error boundary
      auth/                sign-in, change-password, mfa-enrol, step-up, forgot, reset, accept
      catalog/             table, columns, cells, entity page, details, related
      search/              command dialog, search page
      i18n/                i18next setup, locales/en/*.json, locales/es/*.json
      state/               Zustand stores (theme, locale, step-up)
      components/ui/       shadcn/ui components, copied (components.json at the package root)
      lib/                 safe rendering (links, markdown), formatting, return paths
      __fixtures__/        setup-tests.ts (jest-dom matchers) and test fixtures
      build-check/         the bundle check of task 2.8 (Node)
    e2e/                   Playwright specs (*.spec.ts); fixtures/ holds the seed script
    tsconfig.json          solution-style: references tsconfig.app.json and tsconfig.node.json
    vite.config.ts, playwright.config.ts, CLAUDE.md
packages/
  catalog/    gains src/api/contract-definition.ts (browser-safe) and the search code
```

`apps/web/CLAUDE.md` (named by `project.md` §16.6) states the package rules: no
business rule in the UI, no `tenantId` anywhere, no `console`, no
`dangerouslySetInnerHTML`, every server string rendered as text unless it passes
through `lib/` renderers, and the TDD split for component and e2e tests.

**TDD ownership of the test infrastructure.** The Vitest setup file
`apps/web/src/__fixtures__/setup-tests.ts` and the e2e seed `apps/web/e2e/fixtures/seed.ts`
are test fixtures: the `test-writer` writes them (the first matches the guard's
`*/__fixtures__/*` today, the second once task 2.6 lands), and the `implementer` never
edits them. `playwright.config.ts`, `scripts/ci/e2e.sh` and the TLS proxy of D16 are
setup files written by the orchestrator in their setup tasks.

`@tayzu/web` depends on `@tayzu/catalog` only through its `./contract` subpath (D4).
It never imports `@tayzu/api`, `@tayzu/auth` or `@tayzu/db`, so no Node-only module
can reach the bundle; a lint rule enforces it (task 2.3), and the contract module's own
import graph is checked by a test (task 2.7).

### D2. Tooling changes

- **TypeScript.** `tsconfig.base.json` is unchanged. `apps/web/tsconfig.json` is
  solution-style (`files: []` and `references` to `tsconfig.app.json` and
  `tsconfig.node.json`), because typescript-eslint's `projectService` resolves only a
  file's nearest `tsconfig.json` and follows its references. `tsconfig.app.json`
  extends the base for `src/` and overrides `lib` to `["ES2023", "DOM",
  "DOM.Iterable"]`, `types` to `["vite/client"]` (no `node`, so a Node API in browser
  code fails to typecheck), and sets `jsx: "react-jsx"`; `tsconfig.node.json` covers
  `vite.config.ts`, `playwright.config.ts`, `e2e/` and the build check
  `src/build-check/` (task 2.8) with `types: ["node"]`, and `tsconfig.app.json` excludes
  those paths. The package's `typecheck` runs `tsc -b`. TypeScript stays at `~6.0.3`.
- **ESLint.** A block for `apps/web/**/*.tsx` and `apps/web/**/*.ts` adds
  `eslint-plugin-react-hooks` (recommended) and `eslint-plugin-jsx-a11y` (strict),
  keeps `strictTypeChecked`, and adds `no-console: error`, a `no-restricted-syntax`
  entry banning the JSX attribute `dangerouslySetInnerHTML`, `document.cookie`, `eval`,
  `new Function`, `document.write` and assignments to `innerHTML` or `outerHTML`, and a
  `no-restricted-imports` entry that allows `@tayzu/catalog/contract` and no other
  workspace package. Because a later block replaces the rule's array, the web
  `no-restricted-syntax` entry re-spreads the `sql.raw` and actor-type selectors (web
  code never compares `actor.type`), as the identity block does. The root file glob
  grows from `**/*.{js,ts}` to `**/*.{js,ts,tsx}`, and the test-file override at
  `eslint.config.js:154` gains `*.test.tsx`. `eslint-plugin-jsx-a11y` 6.10.2 declares
  ESLint peers only up to 9, so the root `package.json` gains a
  `pnpm.peerDependencyRules.allowedVersions` entry for it and ESLint 10, with its reason,
  and a lint test proves its rules fire on ESLint 10 (Q40).
- **Vitest.** `vitest.shared.ts` gains `defineWebPackageConfig(name)`: one project,
  `<name> (unit)`, environment `jsdom`, include `src/**/*.test.{ts,tsx}`, a setup file
  that loads `@testing-library/jest-dom` matchers; there is no `int` project in the web
  package. The root `vitest.config.ts` already includes `apps/*`.
- **Turborepo.** `apps/web/turbo.json` (a package configuration) gives `build` the
  outputs `dist/**`; the root gains an `e2e` task (`cache: false`, depends on `build`
  of `@tayzu/web`) and the root script `"e2e": "bash scripts/ci/e2e.sh all"`. `build`
  of every other package stays a typecheck.
- **pnpm `allowBuilds`.** It lists `esbuild` and `protobufjs`, both `false`. It is
  unchanged unless `pnpm install` reports an ignored build script for a new package.
  Then the entry is added as `false` (or `true` only with a stated reason), in the task
  that adds the package; Tailwind's native engine and Playwright are the candidates.
  Playwright browsers are never downloaded by an install script: CI runs `playwright
  install --with-deps chromium` as an explicit step, and the sandbox uses
  `/opt/pw-browsers`.
- **Node.** jsdom 30.1.3 requires Node `^22.22.2`; the root `engines.node` becomes
  `>=22.22.2` (the sandbox runs 22.23.4, CI's `setup-node` reads `engines`), and
  `docs/dev-environment/README.md` records it.
- **Dependabot** (`.github/dependabot.yml`): a `cooldown` of 14 days for npm updates, and
  an `ignore` for `@playwright/test` and `playwright-core`, which move only together with
  the sandbox browser (Q43).
- **The Vite dev server** binds `server.host: '127.0.0.1'` with `strictPort: true`, keeps
  `server.fs.strict` on and is never started with `--host`; the pinned Vite has no open
  `server.fs` advisory.
- **The TDD path guard** (`.claude/hooks/tdd-path-guard.sh`) treats
  `apps/web/e2e/**/*.spec.ts` and `apps/web/e2e/fixtures/**` as test files. It is a
  change to the agent harness, not to product code: task 2.6 stops, shows the diff to
  the human, and the human applies or approves it (Q7).
- **CI.** `.github/workflows/ci.yml` gains a job `e2e` (checkout with
  `persist-credentials: false`, PostgreSQL 18 service, the pinned Cerbos image, the
  browsers installed by the pinned Playwright, the stack of `scripts/ci/e2e.sh`). A
  Playwright trace or report holds the cookies, form values and seeded credentials of the
  run, so the seed generates random credentials per run (D16), and the report is uploaded
  only on failure with `retention-days: 3`. The `dast-zap` job builds the web app first
  (D10). `scripts/ci/local.sh` gains `pnpm --filter @tayzu/web build` after `typecheck`
  and the e2e step after `dast`, skipping with an explicit `SKIP` when Docker or the
  browser is missing, like the DAST step.

### D3. Dependencies

A dependency may be added only when the design names it (root `CLAUDE.md`). These are
all of them. Every version is pinned exactly at the task that adds it (Q43): the latest
release published at least 14 days earlier, compatible with the rest, re-checked at task
2.1. The table below is the drift-check's pinned starting point (2026-11-19); Vite stays
at the latest 8.3.x published before the cutoff (8.3.8, of 2026-11-11, is too new), and
`@hookform/resolvers` takes the latest major that supports Zod 4 and is at least 14
days old. Each package is recorded with its license in
`docs/security/dependencies.md` (task 2.2). Libraries that end up in the bundle are
`dependencies` of `@tayzu/web`, so `pnpm audit --prod --audit-level=high` covers what
ships; build and test tools are `devDependencies`, and a non-blocking `pnpm audit
--audit-level=critical` over every dependency covers the build chain.

| Group | Versions |
| ----- | -------- |
| React and data | `react` / `react-dom` 19.3.1; `@tanstack/react-query` 5.106.0; `zustand` 5.0.16; `@tanstack/react-router` 1.170.46; `react-hook-form` 7.91.0; `zod` 4.6.7 |
| i18n | `i18next` 26.7.1; `react-i18next` 17.1.12 |
| API client | `@orpc/client` and `@orpc/openapi-client` 1.15.4 |
| Radix | `dialog` 1.3.1, `dropdown-menu` 2.2.1, `popover` 1.3.1, `tabs` 1.2.1, `select` 2.4.1, `label` 2.1.17, `slot` 1.5.0, `tooltip` 1.4.1, `separator` 1.2.0 |
| UI helpers | `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 1.68.0, `cmdk` 1.1.1, `react-markdown` 10.1.0, `qrcode.react` 4.2.0, `get-nonce` 1.0.1 (one copy, checked with `pnpm why get-nonce`) |
| Build | `tailwindcss` and `@tailwindcss/vite` 4.3.4, `tw-animate-css` 1.4.0, `@vitejs/plugin-react` 6.2.1, `@types/react` and `@types/react-dom` 19.3.0, `eslint-plugin-react-hooks` 7.1.1 |
| Test | `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `@testing-library/user-event` 14.6.8, `@testing-library/jest-dom` 7.0.1; `jsdom` 30.1.3 (Node `^22.22.2`, D2) |
| E2E | `@playwright/test` 1.63.0; `@axe-core/playwright` 4.14.0 |
| Server and CLI | `@fastify/static` 10.1.10; the shadcn CLI 4.23.0 |

`@axe-core/playwright` declares `playwright-core >=1.0.0` as a peer and could pull in a
second copy, so `pnpm why playwright-core` must show 1.63.0 only. `eslint-plugin-jsx-a11y`
is pinned at 6.10.2 (Q40).

| Package | Role | License | Kind |
| ------- | ---- | ------- | ---- |
| `react`, `react-dom` | UI runtime | MIT | runtime |
| `@tanstack/react-query` | Server state: fetching, cache, retries off for 4xx (ADR-0004) | MIT | runtime |
| `zustand` | Local UI state: theme, locale, step-up dialog (ADR-0004) | MIT | runtime |
| `@tanstack/react-router` | Routing with typed params and Zod-validated search params (below) | MIT | runtime |
| `react-hook-form`, `@hookform/resolvers` | Forms | MIT | runtime |
| `zod` | Form and response schemas | MIT | runtime |
| `i18next`, `react-i18next` | i18n with namespaces (`project.md` §15) | MIT | runtime |
| `@orpc/client`, `@orpc/openapi-client` (the server's version) | Typed API client (D4) | MIT | runtime |
| `@radix-ui/react-*` primitives that the copied components import (dialog, dropdown-menu, popover, tabs, select, label, slot, tooltip, separator) | Accessible primitives under shadcn/ui | MIT | runtime |
| `class-variance-authority`, `clsx`, `tailwind-merge` | shadcn/ui component styling helpers | Apache-2.0, MIT, MIT | runtime |
| `lucide-react` | Icons, bundled (no icon font, no CDN) | ISC | runtime |
| `cmdk` | The `Ctrl`/`Cmd`+`K` command list (shadcn/ui `Command`) | MIT | runtime |
| `react-markdown` | Markdown property values rendered without raw HTML (D13, Q16) | MIT | runtime |
| `qrcode.react` | The TOTP enrolment QR code as inline SVG (D11, Q17) | ISC | runtime |
| `get-nonce` | Hands the style nonce to the Radix scroll lock (D10, Q15) | MIT | runtime |
| `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css` | Styling, compiled at build time | MIT | build |
| `@vitejs/plugin-react` | Vite React plugin (Vite itself is already a root dev dependency) | MIT | build |
| `@types/react`, `@types/react-dom` | Types | MIT | build |
| `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` (root) | Lint (D2) | MIT | build |
| `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`, `@testing-library/jest-dom` | Component tests | MIT | test |
| `jsdom` | Vitest DOM environment | MIT | test |
| `@playwright/test`, **pinned to `1.63.0`** | E2E. The pin matches the preinstalled Chromium revision 1243 at `/opt/pw-browsers`, so the sandbox needs no download; a bump moves the sandbox browser and CI together | Apache-2.0 | test |
| `@axe-core/playwright` | Accessibility checks in e2e (`axe-core` is MPL-2.0, see below) | MPL-2.0 | test |
| `@fastify/static` (in `@tayzu/api`) | Serves the build (D9) | MIT | server runtime |

shadcn/ui itself is not a dependency (ADR-0007): its CLI runs as `npx shadcn@4.23.0` to
copy components into `src/components/ui/`, and `components.json` records the
configuration. Its output is reviewed in task 2.2: every dependency it adds is re-pinned
to the exact version above, the lockfile diff adds only packages this section names,
and the CLI version and the registry it read are recorded. Fonts are the operating system's font stack (no web font is loaded),
so there is no font dependency. No date library: dates use `Intl.DateTimeFormat` in the
browser's time zone (`project.md` §15).

**License note.** Every package above is on the allowlist of
`docs/security/dependencies.md` (MIT, Apache-2.0, ISC) except `@axe-core/playwright` and
the `axe-core` engine it depends on, which are MPL-2.0: an OSI-approved weak copyleft
license that is neither on the allowlist nor in the "flag for review" list.
`eslint-plugin-jsx-a11y` depends on `axe-core` too (Q40). They are lint and test tools
that never ship in the bundle or the image, and Tayzu does not modify them. The human
accepted them as test-only dev dependencies (Resolved decision Q26, extended to the lint
plugin's copy by Q40): task 2.2 records the license in `docs/security/dependencies.md`
and extends its allowlist note for test-only and lint-only MPL-2.0. The transitive packages of each addition (notably the
`unified`/`remark` family under `react-markdown`) are checked in the same task.

**Router choice: TanStack Router** (code-based route tree, no file-based code
generation plugin). Its typed params and Zod-validated search params put the table
state (sort, order, page size, cursor) and the search query in the URL with a parser
that follows the untrusted-input rules (D15), and it pairs with TanStack Query.
_Rejected:_ React Router 7, whose search params are untyped strings and whose
framework mode brings server rendering this app does not use.

### D4. The API client

- **Catalog calls use oRPC's typed client.** `createORPCClient(new OpenAPILink(contract,
  { url: window.location.origin, plugins: [new SimpleCsrfProtectionLinkPlugin()] }))`
  typed as `ContractRouterClient<typeof catalogContract>`. `OpenAPILink` is required
  because the server mounts an `OpenAPIHandler` (REST paths of the committed document),
  not the RPC protocol, and it reads the routes from the contract at runtime. The link
  gets a custom path-parameter serializer (Q36): `encodeURIComponent`, then `%40`, `%3A`
  and `%3D` turned back into `@`, `:` and `=`, which are valid unencoded in a path
  segment, so an identifier with those characters is sent without any `%` and passes the
  Q74 hook; an identifier with `/` is never sent (D13). The CSRF
  link plugin sends `x-csrf-token: orpc` on every non-`GET` call, which is exactly what
  the server's `SimpleCsrfProtectionHandlerPlugin` checks. Requests use the browser's
  default `credentials: 'same-origin'`, so the cookie goes with them and never needs to
  be read by script. _Rejected:_ a client generated from `openapi/catalog.openapi.json`
  (`openapi-fetch` or a code generator): a second source of types and a generation
  step, while the contract is already TypeScript and its drift is already checked.
- **A browser-safe contract module.** `catalogContract` and its Zod schemas move to
  `packages/catalog/src/api/contract-definition.ts`, which imports only `@orpc/contract`
  and `zod`; `contract.ts` re-exports it and keeps the document generation and drift
  check. `packages/catalog/package.json` gains `"./contract":
  "./src/api/contract-definition.ts"`. The committed OpenAPI document does not change
  from the move.
- **Identity and auth calls use a thin hand-written client** (`src/api/auth-client.ts`)
  over the exact routes the UI needs: the allowlisted Better Auth routes, the plain
  Fastify routes of `043` and `044` (`POST /v1/auth/invitations/accept`,
  `POST /v1/auth/password-reset/request`, `POST /v1/auth/password-reset/confirm`) and
  `GET /v1/me` (D8). The bodies are the routes' own allowlists: accept
  `{ invitationId, token, password? }` and reset confirm `{ id, token, newPassword,
  factor?: { kind: 'totp' | 'backup_code', code } }`. Each response is parsed by a Zod
  schema into a null-prototype object; unknown fields are dropped. Every non-`GET` call sends `x-csrf-token: orpc`
  and `Content-Type: application/json`, which the accept and reset routes check (`043`
  D4, `044` D2). _Rejected (Q24):_ `better-auth/client`, which would add the whole
  `better-auth` package to the bundle and call routes this app does not use.
- **One error model** (`src/api/errors.ts`) maps every failure to a closed set of kinds:
  `unauthenticated` (401), `forbidden` (`AUTH_FORBIDDEN`), `not_found`
  (`CATALOG_NOT_FOUND`, also every cross-tenant answer), `step_up_required` (with the
  optional `reauthorizationUrl`), `validation` (issue paths only: catalog issues are
  `{ path, message }` with no code, so the UI shows the field and a generic localized
  "invalid value", and maps a message to text only for the password-policy rules on
  `/newPassword` (the reset confirm), whose message is the rule name; the accept route
  reports the same rule names on `/password`, `identity/accept-flow.ts:137`, and is
  mapped the same way),
  `reference_violation` (referrer identifiers and the "+N not visible" count),
  `rate_limited` (with `Retry-After`), `conflict` and `server`. The UI renders localized
  text for each kind and never the server's message string, so an internal error can
  show nothing but a generic message (D15).
- **TanStack Query settings.** No retry on a 4xx, at most one retry on a network error
  or 5xx, `refetchOnWindowFocus` on for the session query only, and the cache is
  cleared on sign-out and on any `unauthenticated` answer. Nothing is persisted.

### D5. Search API (Q4)

- **Procedure** `search.entities`, `GET /v1/search/entities`, in the catalog contract
  (the thirteenth catalog procedure). Input (query string): `q` (required), `limit`
  (optional). Output: `{ items: [{ blueprint, identifier, title, match }] }`, where
  `match` is `identifier` or `title`; no cursor (a ranked top-N list, not a page) and no
  count. It is a `GET`, so it carries no CSRF header and is not `x-tayzu-risk: high`.
  The path leaves room for `005` to add other categories under `/v1/search/`.
- **Limits, checked before any database work** (D8 of `001`): `q` is trimmed and
  NFC-normalized, then must be 2 to 100 characters, with no control character;
  `limit` defaults to 20 and is at most 50. New entries in `CatalogLimits`:
  `search: { minQueryLength: 2, maxQueryLength: 100, defaultLimit: 20, maxLimit: 50 }`.
  A shorter or longer query fails with `CATALOG_VALIDATION_FAILED` (issue path `/q`),
  a larger limit with `CATALOG_LIMIT_EXCEEDED` (`search.maxLimit`).
- **Matching**, in one parameterized query inside the tenant transaction
  (`set_config('app.tenant_id', $1, true)`, `statement_timeout`), with `tenant_id`
  filtered explicitly as in every repository:
  `identifier ILIKE $prefix ESCAPE '\'` or `title ILIKE $prefix ESCAPE '\'`, where
  `$prefix` is the query with `\`, `%` and `_` escaped followed by `%`, or `title % $q`
  (`pg_trgm` similarity at its default threshold, 0.3). Ranking: an exact identifier
  match (case-insensitive) first, then an identifier prefix, then a title prefix, then
  trigram similarity descending; ties by blueprint identifier, then entity identifier.
  Results span every blueprint of the tenant, including the `_user` and `_team` system
  blueprints (Q19).
- **Authorization.** The service builds the Cerbos `catalog_entity` `list` plan exactly
  as `entities.list` does (`planEntityList`, unchanged) and folds the filter into the
  query; a denied plan returns no items, never an error. Because the plan is built with
  no blueprint and its mapper is per row, it narrows a cross-blueprint query the same
  way, and a moderator or team-ownership grant on one blueprint shows only that
  blueprint's entities. **No Cerbos policy changes**, so no Checkpoint 3 for policy here.
  _Rejected:_ a dedicated `search` action on `catalog_entity` (a policy change with no
  difference in who may see what, which Q4 rules out by "works as `entities.list` does
  today").
- **Operation.** Declared as `defineCatalogOperation<SearchEntitiesInput,
  SearchEntitiesOutput>({ name: 'entity.search', pool, authz, authorization:
  PLAN_AUTHORIZED, handler })`, the form `entity.list` uses
  (`service/entities.ts:1655-1659`), so it gets the context check, the tenant transaction, the error mapping and the telemetry
  of every catalog operation; agents and humans take the same path. Search reads are
  not audited (`001` R2 defers read audit to `014`).

### D6. Sorting `entities.list`

- **Input.** `sort`: `identifier` (default), `title` or `updatedAt`; `order`: `asc`
  (default) or `desc`. Both are query-string enums in the contract and the committed
  document.
- **Keyset with a tiebreaker.** Rows are ordered by the sort key, then by `identifier`
  in the same direction, and the next page uses a row comparison,
  `(title, identifier) > ($1, $2)` (or `<` for `desc`). Titles compare under the
  database's default collation (D7's indexes use the same).
- **A cursor bound to its sort, anchored on a row id** (Q37). The cursor becomes
  `{ "v": 2, "s": <sort>, "o": <order>, "id": <uuid of the last row> }`, base64url JSON,
  carrying no tenant and no sort value. Inside the tenant transaction the server reads
  that row's sort key and identifier, under the same `tenant_id`, blueprint and Cerbos
  plan filter as the page, and uses them as the keyset bound. So the 512-character limit
  holds for every sort (a 256-character title plus a 256-character identifier would not
  fit in the cursor), and a crafted id of an entity the caller cannot read, of another
  blueprint or of another tenant is the same `CATALOG_VALIDATION_FAILED` (issue path
  `/cursor`) as an anchor that was deleted meanwhile, a cursor used with a different sort
  or order, or a malformed one; the UI then restarts from the first page. A version-1
  cursor (`{ "k": <identifier> }`) stays valid for the default sort, so a page fetched
  before the upgrade still continues; removing that acceptance is a ticket for `005`.
  `blueprints.list` keeps the version-1 cursor.
- **Timestamps.** The `updatedAt` keyset compares the stored `updated_at`, which every
  write sets from the application clock at millisecond precision; rows with an equal
  millisecond are ordered by identifier. Because the bound is read from the row itself,
  no timestamp is ever round-tripped through the cursor.
- **The Cerbos plan filter** applies unchanged; sort never widens what is returned.

### D7. Migration `0015_catalog_entity_search` (⛔ Checkpoint 3)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE INDEX catalog_entity_title_trgm_idx
  ON catalog_entity USING gin (title gin_trgm_ops);
CREATE INDEX catalog_entity_identifier_trgm_idx
  ON catalog_entity USING gin (identifier gin_trgm_ops);
CREATE INDEX catalog_entity_tenant_blueprint_title_idx
  ON catalog_entity (tenant_id, blueprint_id, title, identifier);
CREATE INDEX catalog_entity_tenant_blueprint_updated_idx
  ON catalog_entity (tenant_id, blueprint_id, updated_at, identifier);
```

**One migration, generated** (Q41): `drizzle-kit generate` produces
`packages/db/migrations/0015_catalog_entity_search.sql` from the index declarations
below, and `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` is prepended to
that file by hand before Checkpoint 3, so the whole change is one reviewed file (the
journal ends at idx 14, so `0015` is next). The down script,
`packages/db/migrations/down/0015_catalog_entity_search.down.sql`, drops the four indexes
and then the extension (`DROP EXTENSION IF EXISTS
pg_trgm`, safe because nothing else uses it). The trigram indexes do not lead with
`tenant_id` (a GIN trigram index cannot without `btree_gin`, another extension); with
fewer than 20 tenants (ADR-0006) the tenant predicate filters the bitmap scan cheaply,
and row-level security and the explicit `tenant_id` predicate still apply.
`pg_trgm` is a trusted extension since PostgreSQL 13, so the migration role needs
`CREATE` on the database, not superuser; on Azure Flexible Server it must also be in
the `azure.extensions` server parameter, a first-deployment gate of `046`. No role,
grant or policy changes: the operators and functions of `pg_trgm` are executable by
`PUBLIC`. The Drizzle table in `packages/catalog/src/persistence/schema.ts` declares
the two btree indexes and the two GIN indexes (Drizzle's `.using('gin', ...op('gin_trgm_ops'))`),
so the snapshot matches.

### D8. `GET /v1/me`: the shell's view of its own session

The shell must know who is signed in, in which organization, with what role, and
which gate applies. `/api/auth/get-session` gives the user and session, not the
markers or the role; and `resolveContext` rejects a session under either marker with the
same error as no session, so an oRPC procedure could not answer the gated cases (Q13).

- **A plain Fastify route**, `GET /v1/me`, registered before the `/v1/*` catch-all (as
  token exchange is), with the authenticated rate-limit bucket. It reads the session
  through Better Auth's in-process `getSession` with the request headers; it never reads
  a tenant, user or organization from the path, query or body. It reads the session
  only: a machine bearer token gets the same uniform `401` as no session.
- **A new export of `@tayzu/auth`**, `resolveSessionState(headers)`, does the work,
  because the checks it needs are private to `context-resolver.ts`. It runs the
  resolver's own checks in the resolver's order (the markers, 704-717, then the
  membership, the open tenant and the `_user` state, 719-762) and reuses their helpers
  instead of copying them, but where `resolveContext` rejects a marker it records the
  gate and goes on, so that a gated session that would fail a later check is still the
  uniform `401`. The membership role is read as stored (a comma-separated list is
  allowed) and reported as the highest of `owner`, `admin` and `member`; the
  admin-without-factor gate uses the folded role of `toCerbosRole` (336-339), so an
  owner counts as an admin.
- **No session, an expired or idle session, a banned user, a disabled `_user`, a
  tenant with a pending or purged deletion marker, or no active organization:** the
  same `401 CATALOG_CONTEXT_REQUIRED` body as the catch-all, so the route reveals
  nothing an anonymous caller cannot learn.
- **A valid session** answers `200` with `Cache-Control: no-store`:
  `{ user: { id, name, email }, organization: { id, name }, role:
  "owner" | "admin" | "member", signInMethod: "password" | "visma-connect",
  mfa: { enrolled: boolean }, gate }`, where `gate` is, in this order of precedence:
  `password_expired` (an expired temporary-password marker),
  `password_change_required` (an unexpired one), `mfa_enrolment_required` (the
  re-enrolment marker, or an admin or owner without an enrolled factor, which the
  catch-all refuses), or `none`. A failed lookup fails closed (`401`). `signInMethod`
  is `visma-connect` when the session carries an `ssoSid` (`002` D25) and `password`
  otherwise; the step-up dialog is chosen from it (D11).
- `organization.name` is the caller's own organization's name, shown in the header; it
  never reaches telemetry (D9 of `045` keeps it off every signal, and so does this route).
- The route is in no public allowlist; `route-auth-allowlist.int.test.ts` keeps
  covering it.

### D9. Same-origin hosting ([ADR-0025](../../../docs/adr/0025-same-origin-web-hosting.md), Q2)

- **Setting.** `WEB_DIST_DIR`, optional: the absolute path of the Vite build. Unset, no
  app route is registered and every route answers as today (the DAST of the API alone,
  the existing tests); the security headers of D10 apply either way. Set, startup fails unless it is an absolute path to a readable
  directory containing `index.html`; the error names the variable, never its value
  (Q21).
- **Assets.** `@fastify/static` serves `<WEB_DIST_DIR>/assets/` at `/assets/` with
  `wildcard: false` (the file list is read once at startup, one route per file, so a
  request never reaches the file system with a client path), `dotfiles: 'deny'`,
  `index: false`, no directory listing, and `Cache-Control: public, max-age=31536000,
  immutable` (Vite's file names carry a content hash); the `onSend` `no-store` hook
  (`server.ts:607-614`) only fills a missing header, and a test proves it does not
  replace `immutable`. A missing asset is Fastify's own 404. The **root build files**,
  an explicit list (`theme-init.js` and the favicon), are served from the build root
  with `no-cache`.
- **SPA fallback** (Q28). A `GET` or `HEAD` whose path is not under `/v1`, `/api` or
  `/assets`, is not `/healthz` and is not a root build file answers `index.html`
  (`text/html; charset=utf-8`, `Cache-Control: no-store`), whatever the path holds: a
  `_user` page (`/catalog/_user/alice@example.com`) and an identifier such as `v1.2`
  have a dot, so no "file extension" rule is used. `index.html` is read once at startup
  and the style nonce of D10 is substituted in memory per response. Any other method on
  such a path is the usual 404. The Q74 hook still runs first, so a path with `%`, `//`
  or a backslash never reaches the fallback. The fallback never reads the session:
  authentication happens in the API calls the app then makes. One predicate,
  `isSpaPath(pathname)` in `apps/api`, decides "an app path" for the fallback and for the
  span template of the Observability contract (Q27, B1).
- **Rate limit.** `@fastify/rate-limit` runs with `global: false`, so the fallback opts
  in to its own in-memory bucket keyed by `request.ip` (300 requests per minute per
  replica, never logged); hashed assets get no in-process limit and rely on the ingress
  limit that `046` records as a gate.
- **Allowlists** (Q39). `PUBLIC_ROUTE_ALLOWLIST` gains reviewed entries, each with its
  reason ("static, public by nature, no data"): a prefix entry for `/assets/`, because
  `wildcard: false` registers one route per file, and exact entries for the fallback and
  each root build file. `route-auth-allowlist.int.test.ts` rejects any entry that is not
  a registered route (lines 208-220), so it gains a second harness app started with a
  fixture `web-dist` and `WEB_DIST_DIR`, in which those entries are registered; the
  first app keeps proving every other route closed.
- **Why the same origin.** The session cookie is `SameSite=Lax` and host-only, the CSRF
  defense is a custom header plus Better Auth's origin check, and the Visma Connect
  sign-in and re-authorization callbacks are `form_post` to this origin (`002` D13,
  D23, D25). Serving the app from the same origin keeps all of it unchanged and needs no
  CORS for the app. `ALLOWED_ORIGINS` keeps its rules and contains the app's own origin,
  which the accept and reset routes and Better Auth's trusted origins require;
  `INVITATION_LINK_BASE_URL` and `PASSWORD_RESET_LINK_BASE_URL` are that origin.
  _Rejected (Q2):_ a static host or CDN on a sibling subdomain with CORS, and a
  separate Container Apps app.

### D10. Strict CSP and security headers ([ADR-0026](../../../docs/adr/0026-strict-content-security-policy.md), Q5)

- **One policy on every response** (HTML, JSON, assets and 404s), whether or not
  `WEB_DIST_DIR` is set, through `@fastify/helmet` with
  `contentSecurityPolicy.useDefaults: false` and these directives:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<n>';
  img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none';
  object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  ```

  `script-src 'self'` has no nonce and no hash: `index.html` has no inline script, Vite
  emits external module scripts, and the theme is applied before first paint by the
  external `/theme-init.js`. `upgrade-insecure-requests` is left out: production is
  HTTPS-only with HSTS already, and the directive would break the HTTP e2e and DAST
  stacks on `localhost`.
- **The style nonce** (Q15). Radix's dialog scroll lock (`react-remove-scroll`, through
  `react-style-singleton`) inserts a `<style>` element at runtime, which
  `style-src 'self'` refuses. Each HTML response gets a fresh 128-bit nonce from
  `crypto.randomBytes(16)` (base64), generated by Tayzu's own `onRequest` hook and read
  by the `style-src` directive function (not helmet's `enableCSPNonces`, which emits hex
  and adds the nonce to `script-src` too), placed in the CSP header and in `<meta
  name="tayzu-style-nonce" content="<n>">` of that response's `index.html`; `main.tsx`
  reads it and passes it to `get-nonce`'s `setNonce`. Non-HTML responses carry a nonce
  nothing uses. React's `style` props go through the CSSOM, which CSP does not restrict,
  so no `'unsafe-inline'` and no style hash is needed. If the e2e CSP check (task 10.8)
  finds no runtime `<style>` element, the nonce is removed and `style-src` is `'self'`.
- **`form-action 'self'` without the Visma Connect origin.** The app never submits a
  native form to Visma Connect: sign-in and step-up start with a JSON call that returns a
  URL, and the browser then navigates to it, which `form-action` does not govern. The
  auto-submitting `form_post` page is Visma Connect's own document, under its own
  policy, posting to this origin. So `form-action 'self'` suffices (Resolved decision
  Q25); if the e2e run against the OIDC stub shows otherwise, adding the Visma Connect
  origin is asked in chat as a new question before the policy changes.
- **Other headers.** `Referrer-Policy: no-referrer` (helmet's default, now asserted);
  `X-Frame-Options: DENY`, set explicitly (`xFrameOptions: { action: 'deny' }`;
  helmet's default is `SAMEORIGIN`), matching `frame-ancestors 'none'`;
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy:
  same-origin` (helmet defaults, now asserted); `Cross-Origin-Embedder-Policy:
  require-corp` (every resource is same-origin); `X-Content-Type-Options: nosniff`;
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  (without `interest-cohort`, which Chromium reports as a console error that would fail
  the e2e checks). HSTS stays as `002` set it. `Cache-Control: no-store` stays the
  default for everything but hashed assets. Two existing assertions change with this
  decision: `apps/api/src/headers.int.test.ts:83-84` (`SAMEORIGIN`) and `:103-106` (no
  CSP).
- **The Vite dev server** uses a looser policy (`script-src 'self' 'unsafe-eval'`, the
  HMR WebSocket in `connect-src`, `style-src 'self' 'unsafe-inline'`) set in
  `vite.config.ts` for `serve` only; it proxies `/v1` and `/api/auth` to a local API and
  listens on `127.0.0.1` only (D2).
  The build never carries it, and a test reads the built `index.html` and the served
  header to prove it.
- **DAST.** `scripts/ci/dast.sh up` builds the app and starts the API with
  `WEB_DIST_DIR`, so the ZAP baseline spiders the HTML pages and assets and the CSP and
  header rules (10038, 10055, 10063, 10020, 10021, 90004 and the others) run against
  them. Every new WARN is fixed, not ignored, except a purely informational rule that
  fires on any single-page app (10109 "Modern Web Application"), which is set to `INFO`
  in `.zap/rules.tsv` with its note, as 10049 is (Q22). A baseline run right after task
  2.1 (task 2.1b) shows which alerts the build actually raises; every alert beyond 10109
  (10027 and 10096 are likely) is asked in chat before anything is set to `INFO` (Q42).
  The scan stays green (Q5).

### D11. Authentication pages (Q3)

Every page is a route of the SPA, uses only the allowlisted routes, renders server
answers through the error model of D4 and is keyboard-operable. Password fields use
`autocomplete="current-password"` or `"new-password"`, are never echoed, stored or
logged, and are cleared from form state after a submit.

- **`/sign-in`.** Email and password (`POST /api/auth/sign-in/email`). One uniform
  failure message whatever the reason, matching the API's enumeration resistance, and a
  localized "try again in N seconds" from `Retry-After` on `AUTH_RATE_LIMITED`. When the
  answer requires the second factor, the page switches to a TOTP field
  (`/two-factor/verify-totp`) with a switch to a backup code
  (`/two-factor/verify-backup-code`). A "Sign in with Visma Connect" button posts to
  `/api/auth/sign-in/social` with `provider: "visma-connect"`, `callbackURL: "/"` and
  `errorCallbackURL: "/sign-in?error=sso"` and, only on the user's click, navigates to
  the returned URL if it is an absolute `https:` URL; `?error=sso` shows one generic
  message. A `returnTo` search parameter is honoured only if it is an in-app path (D15).
- **`/change-password`** (gate `password_change_required`): current (temporary)
  password, new password and confirmation, `POST /api/auth/change-password` with
  `revokeOtherSessions: true`; a policy failure shows the localized name of the failed
  rule, which is all the API returns. `password_expired` shows a page that tells the
  user to ask an administrator, with sign-out.
- **`/mfa/enrol`** (gate `mfa_enrolment_required`, and reachable from the user menu
  when not enrolled): password re-entry, `POST /api/auth/two-factor/enable`, then the
  TOTP URI as an inline SVG QR code and as the plain secret for manual entry, and the
  backup codes shown once with a "I have saved them" confirmation, then a code verified
  with `/two-factor/verify-totp`. The URI, secret and codes live only in component
  state, never in the query cache, storage or the URL, and are dropped on leaving the
  page. Re-enrolment after an MFA reset is the same page.
- **Step-up dialog.** Any call answered `step_up_required` opens one dialog (a Zustand
  store holds the pending retry, not its input on disk). The dialog is chosen from the
  session's `signInMethod` in `GET /v1/me` (D8), not from the presence of a URL, because a
  TOTP or password verification never satisfies an SSO session (`step-up.ts:316-334`):
  - a Visma Connect session with a `reauthorizationUrl`: a "Continue with Visma Connect"
    button; on click the app stores only the current in-app path in `sessionStorage`
    (key `tayzu.stepUp.returnTo`) and navigates to the URL. The callback then redirects
    to `/step-up/complete` (below), which reads and deletes the key, validates the path
    (D15) and returns there with a "you are back, repeat the action" notice; it never
    says "verified", because the page cannot know whether the next request will pass.
    The action is never repeated automatically (Q14);
  - a Visma Connect session without a URL (the server's `start()` returns `null` when
    five re-authorizations are already pending for the session or discovery fails,
    `reauthorization.ts:96-127`, `server.ts:537-549`): a "try again in a few minutes"
    message, with no factor field;
  - a local session with MFA: a TOTP field (or a backup code), then
    `/two-factor/verify-totp`, and the original request is retried once, because the
    user's click on "Verify" is the user action;
  - a local session without MFA: password re-entry through `/api/auth/verify-password`,
    then one retry.
- **The re-authorization redirect** (server, `apps/api`). When `WEB_DIST_DIR` is set,
  the Visma Connect re-authorization callback (`GET` and `POST
  /v1/auth/visma-connect/reauthorize/callback`) answers `303 See Other` to the fixed
  path `/step-up/complete` on success, `/step-up/complete?result=failed` on failure, and
  `/step-up/complete?result=rate_limited` (keeping `Retry-After`) when its limiter
  refuses (today a JSON `429`, `server.ts:869-880`), instead of `200 {}`, the `400` body
  or the JSON `429`. The target is a constant, never derived from the request or the
  OIDC state, so the route cannot become an open redirect. Without the web app the
  answers are unchanged. The page shows a retry-later message for `rate_limited`.
- **Step-up telemetry for Visma Connect** (Q27 B2, Q29, task 3.11). On a successful
  `complete`, the server emits the already-declared `auth.security.step_up_succeeded`
  with `tayzu.auth.method` `visma_connect` and the tenant and actor of the session the
  state is bound to (`emitStepUpSucceeded` stops hard-coding `local`); a failed callback
  emits the new `auth.security.reauthorization_failed` (WARN, reason `invalid_state` or
  `exchange_failed`, no tenant, since none is bound to an unknown state). No code, state,
  token or claim reaches either event.
- **`/forgot-password`** (Q23): one email field, `POST /v1/auth/password-reset/request`,
  and the same "if an account exists, a link was sent" message for every answer but
  `AUTH_RATE_LIMITED`.
- **`/reset-password`** (`044` D14, Q10, `044` Q26). Before the first render, the page reads
  `reset` and `token` from `location.hash`, removes the fragment with
  `history.replaceState`, and keeps both values in component state only (never storage,
  the URL, the query cache or a log). It shows new password and confirmation and submits
  only on the user's click (`POST /v1/auth/password-reset/confirm`). On
  `AUTH_STEP_UP_REQUIRED` it shows a factor field (TOTP or backup code) and the user
  submits again with `factor`. The uniform `404` shows "this link is invalid or
  expired"; success shows a link to `/sign-in`. A missing fragment shows the same
  invalid-link message.
- **`/accept-invitation`** (`043` Q32). The same fragment handling (`invitation`,
  `token`). Signed out, the page offers the new-account path (a new password, then
  `POST /v1/auth/invitations/accept` with `{ invitationId, token, password }`) and, for an existing local
  account, a sign-in form embedded in the page, so the token stays in memory; a Visma
  Connect user is told to sign in first and open the link again (Q20). Signed in, it
  offers "Accept" (the session path). Every refusal is the one uniform message. Nothing
  is submitted without a click.
- **Page rules** for the two link pages, tested over HTTP and in e2e: `Referrer-Policy:
  no-referrer` (on every response, D10), no third-party request of any kind (CSP and the
  e2e network check), the fragment gone from `location` before any request is made, and
  no submit without a user action.

### D12. Shell, routing, i18n, theme and state

- **Routes.** `/sign-in`, `/forgot-password`, `/reset-password`, `/accept-invitation`,
  `/change-password`, `/mfa/enrol`, `/step-up/complete`, `/` (the home: the blueprint
  list), `/catalog/$blueprint` (the table), `/catalog/$blueprint/$entity` (the entity
  page, search param `tab`: `details` or `related`), `/search` (search param `q`), and a
  not-found page. Every search param is parsed by a Zod schema with the D15 rules; an
  invalid value falls back to its default, never to an error page. The router is
  created with `pathParamsAllowedCharacters: ['@', ':', '=']`, so an entity path holds
  those characters unencoded, like the API calls of D4 (Q36).
- **Session gate.** A root loader reads `GET /v1/me` through TanStack Query. A `401`
  sends a protected route to `/sign-in?returnTo=<path>`; a gate other than `none` sends
  every route except its own page and sign-out to that page (`/change-password` or
  `/mfa/enrol`, or the expired-password page). The public pages (sign-in, forgot, reset,
  accept, step-up complete) render without a session.
- **Shell.** A header (product name, the search trigger with its shortcut hint, the
  locale selector, the theme toggle, the user menu with name, organization, role and
  sign-out), a sidebar of the tenant's blueprints (`blueprints.list`, one call at the
  maximum page size, the `_`-prefixed system blueprints grouped last), a skip link and
  landmark regions. Sign-out posts `/api/auth/sign-out`, clears the query cache and the
  stores, and navigates to `/sign-in`.
- **i18n (Q10).** i18next with namespaces `common`, `auth`, `catalog` and `search`, the
  `en` and `es` resources bundled and split per namespace through dynamic `import()`
  (Vite chunks, same origin, no HTTP backend). The locale is the stored choice, else
  `navigator.language` reduced to `en` or `es`, else `en`. The selector stores it in
  `localStorage` (`tayzu.locale`), and `<html lang>` follows it. A key-parity test keeps
  `es` complete. Blueprint and property titles and descriptions use their `{ en, es? }`
  value with `en` as the fallback. Dates use `Intl.DateTimeFormat` in the browser's
  time zone; numbers use `Intl.NumberFormat`.
- **Theme.** `system` (default), `light` or `dark`, stored in `localStorage`
  (`tayzu.theme`); `/theme-init.js` sets the `dark` class on `<html>` before first paint,
  and the Zustand store keeps it in step. Tailwind's `dark` variant does the rest. Both
  themes meet the WCAG contrast ratios (checked by axe in both, task 10.9).
- **State.** TanStack Query holds every server answer; Zustand holds only the theme,
  the locale and the step-up dialog. Every `localStorage` and `sessionStorage` access is
  wrapped in `try`/`catch` and the app works when storage throws.

### D13. Catalog table and entity page

- **Columns** come from the blueprint: identifier, title, then each spec property in
  schema order, then each relation (target identifiers), then `updatedAt`. Headers use
  the localized property title. No column can be hidden or reordered in `003` (`047`).
- **Cells** by type: plain text for strings, numbers through `Intl.NumberFormat`,
  booleans as a localized yes or no, `enum` values as plain text (no colors, `047`),
  `date-time` through `Intl.DateTimeFormat`, `url` through the safe link,
  `email` as a `mailto:` safe link, `markdown` as its first line in plain text,
  `yaml` and objects as truncated monospace text, arrays joined and capped at 5 items
  with a "+N" count. Long text is truncated with the full value in an accessible
  tooltip.
- **Table page.** `entities.list` with `sort`, `order`, `pageSize` (25, 50 or 100) and
  `cursor` from the URL. "Next" follows the returned cursor; "Previous" pops a stack of
  earlier cursors kept in memory, and a reload restarts from the first page of the same
  sort. Sortable headers (identifier, title, updated) are buttons with `aria-sort`;
  changing the sort clears the cursor. An unknown blueprint, including another tenant's,
  is the same not-found page. A denied list is an empty table, as the API answers.
- **Entity page.** A header with title, identifier, blueprint, created and updated time
  and actor (type and opaque id), version and generation. **Details tab**: the spec
  properties in schema order and, when present, the status properties with
  `observedGeneration`, source and observed time; markdown values rendered by the
  markdown renderer below. **Related tab**: `entities.listRelated` with a direction
  toggle (forward, backward), a scope select (spec, status, both) and cursor paging,
  each row linking to its target. **Delete** (Q12): a confirmation dialog with the
  `detachReferences` option, the reference-violation answer shown with the readable
  referrer identifiers and the "+N not visible" count, and the step-up dialog of D11.
- **Safe rendering** (`001` T4). A URL value becomes a link only if it parses as an
  absolute `http:` or `https:` URL (a `mailto:` link only for the `email` format), with
  `rel="noopener noreferrer nofollow"` and `target="_blank"`; anything else is text.
  Markdown goes through `react-markdown` with raw HTML skipped, images disallowed (no
  tracking pixels, and `img-src 'self'` would block them anyway), and a URL transform
  that keeps only `http:`, `https:` and `mailto:`. No server string is ever passed to
  `dangerouslySetInnerHTML` (lint-enforced, D2).
- **Identifiers that cannot be addressed by URL** (Q18, narrowed by Q36): an entity
  whose identifier contains `/`, or is made only of dots, is listed, but its link is
  disabled with a localized note: the first needs `%2F`, which the Q74 hook refuses, and
  the browser normalizes the second away. Identifiers with `@`, `:` or `=` open normally,
  because neither the router nor the client encodes those characters (D4, D12).

### D14. Search UI

- **The command dialog** opens with `Ctrl`+`K` (or `Cmd`+`K`) anywhere and from the
  header button. Two groups: **Blueprints** (filtered locally from the sidebar list by
  identifier and localized title) and **Entities** (`search.entities` once the query has
  2 characters, debounced by 250 ms, each request aborted when the next starts, so a
  stale answer is never shown). Arrow keys move, `Enter` opens, `Escape` closes; each
  entity result shows its title, identifier and blueprint title. "See all results" opens
  `/search?q=`.
- **The search page** shows up to 50 results with the query in the URL. The query is
  never written to storage, and it reaches the server only as the `q` query parameter,
  which exported spans drop (`002` Q67).

### D15. Client-side security rules

- **The tenant comes from the session.** The UI never sends a `tenantId`, an organization
  id or an actor in any request; the session's active organization decides the tenant on
  the server (`002` D3). There is no organization switcher (D7).
- **The cookie stays HTTP-only.** No code reads `document.cookie`; a lint rule bans it.
- **No client logging.** `console` is banned by lint, there is no logging or telemetry
  library, and the error boundary renders a generic localized message with a "reload"
  action, never an error message or stack. Tenant free text (titles, descriptions,
  property values, validation messages) therefore never leaves the page.
- **Error display is sanitized.** Only the error kind, the issue paths and counts are
  rendered, with localized text (D4); the server's `message` is never shown, except a
  password-policy rule name, mapped to its localized text.
- **Untrusted input in the browser.** Every response, search param and fragment value is
  parsed with Zod into null-prototype objects; keys `__proto__`, `constructor` and
  `prototype` are rejected at every depth, and lengths are checked before parsing
  further.
- **Return paths.** A `returnTo` value or the stored step-up path is accepted only if it
  starts with a single `/`, contains no `//`, `\` or control character, has no scheme or
  host when resolved against the current origin, and matches a route of the route tree;
  anything else becomes `/`. This keeps sign-in and step-up from being open redirects.
- **Browser storage inventory** (documented in `docs/catalog/catalog-ui.md`):
  `localStorage` `tayzu.theme` and `tayzu.locale`; `sessionStorage`
  `tayzu.stepUp.returnTo` (an in-app path, deleted when read). No token, password, TOTP
  secret, backup code, invitation or reset token, query, or tenant data is ever stored.
- **Never submit without a user action** on every authentication page, not only the two
  link pages.

### D16. Testing strategy (Q7)

- **Component tests** (`apps/web/src/**/*.test.tsx`, Vitest, jsdom, Testing Library,
  `user-event`): every page and component behaviour named in the tasks, with the network
  replaced by a fake `fetch` at the client boundary; no test reaches a real server.
  Queries by role and accessible name, so the tests also check labelling.
- **Server tests** stay where they are: catalog unit and integration tests against a
  real PostgreSQL 18 and Cerbos, and the `apps/api` HTTP integration tests (`*.http.int.test.ts`)
  for the static routes, the headers, `GET /v1/me` and the callback redirect.
- **E2E** (`apps/web/e2e/*.spec.ts`, Playwright 1.63.0, Chromium only) against the real
  stack started by `scripts/ci/e2e.sh`: PostgreSQL 18 behind verified TLS (as
  `dast.sh`), migrations, the pinned Cerbos, the local OIDC stub of `@tayzu/auth`
  (`packages/auth/src/__fixtures__/oidc-stub.ts`) as Visma Connect, and the API from
  `main.ts` with its production configuration, `WEB_DIST_DIR` and
  `MOUNT_IDENTITY_ROUTES=true`. Outside test every origin must be `https:` (Better
  Auth's `trustedOrigins` and the accept and reset `Origin` checks refuse `http:`), so
  the API and the stub sit behind a **test-only TLS reverse proxy** that `e2e.sh` starts
  (Q38): a small `node:https` proxy script under `scripts/ci/`, no new dependency, with
  a `localhost` certificate signed by the same throwaway CA that `dast.sh` generates per
  run. Chromium trusts only that certificate (by its SPKI hash), never
  `ignoreHTTPSErrors`. The product is not touched. A seed script
  (`apps/web/e2e/fixtures/seed.ts`, owned by the `test-writer`, D1) creates two tenants,
  an admin with TOTP, a member without MFA, a user under a temporary password, a Visma
  Connect user, an invitation and a reset request, through the in-process services with
  `043`'s recording email sender, with **random credentials generated per run**, and
  writes them and the captured links to a file in the run's state directory outside the
  repository; secrets and links are never printed. A trace or report can still hold
  them, which is why it is kept 3 days only (D2). Every spec fails on any
  `securitypolicyviolation` event, any console error and any request to an origin other
  than the app's (and the stub's, where the flow needs it).
- **Accessibility.** `@axe-core/playwright` runs on every page, in both themes, with the
  tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa`; any violation fails.
- **Isolation through the UI.** A user of one tenant opening another tenant's entity URL
  sees the not-found page, and search never returns another tenant's entity.

### D17. Docs-as-Code and ADRs

- ADR-0004 (TanStack Query for server state, Zustand for local UI state) and ADR-0007
  (shadcn/ui on Radix and Tailwind, components copied), backfilled from
  `openspec/project.md` §2 (lines 39 and 59) with their original reasoning and what
  `003` adds; they close the two `003`-relevant items of `001` T7. ADR-0001 to 0003,
  0005 and 0006 stay unwritten (a ticket).
- ADR-0025 "Same-origin web hosting" (D9) and ADR-0026 "Strict Content Security
  Policy" (D10), the next free numbers (`docs/adr/` ends at 0024).
- `docs/architecture/system-diagram.md`: the browser SPA as a component of the API
  container, its HTTPS calls to `/v1` and `/api/auth` on the same origin, the asset and
  page routes, and the Visma Connect redirects, in the full diagram and each zone diagram,
  with the images rendered again.
- `docs/security/attack-surfaces.md`: rows for the pages and assets, `GET /v1/me`,
  `GET /v1/search/entities` and the callback redirect; the helmet row (CSP on); the
  "Web UI (003)" planned row becomes current.
- `docs/security/dependencies.md` (D3), `docs/security/crypto-inventory.md` (the style
  nonce), `docs/catalog/catalog-core.md` (sort, search and the new telemetry names, which
  `docs-telemetry.test.ts` checks), `docs/catalog/auth-and-rbac.md` (`GET /v1/me`, the
  step-up UX and the callback redirect), `docs/security/secrets.md` (a Setting row for
  `WEB_DIST_DIR`, a path, not a secret), and a new `docs/catalog/catalog-ui.md` (pages,
  i18n, theme, CSP, browser storage inventory, how to run the app and the e2e suite).
- `packages/catalog/CLAUDE.md` shows the old `defineCatalogOperation(name, handler)` form;
  it is corrected to the object form of D5 (task 11.8).

## Observability contract

Server-side only. **There is no browser telemetry in `003`** (Q6): no OpenTelemetry web
SDK, no RUM, no `traceparent` propagation from the browser, no client logs (`console` is
banned) and no CSP violation reports. The server already traces every request. Browser
RUM is a ticket for `016-observability-dogfood`.

Names follow `001`'s rules: tracer and meter `@tayzu/catalog` for catalog operations and
`@tayzu/auth` for `GET /v1/me` and the step-up events, versions equal to the package
versions; the shared keys come from `@tayzu/observability/semconv`. Catalog names are
added to `packages/catalog/src/telemetry/contract.ts`; the `me` names to `043`'s identity
contract module, `packages/auth/src/telemetry/identity-contract.ts`, which
`otel-smoke-check` already imports; the new `auth.security.reauthorization_failed` event
and its reason attribute to `002`'s contract module,
`packages/auth/src/telemetry/contract.ts`, where every `auth.security.*` event lives. The
identity contract fixture `packages/auth/src/__fixtures__/identity-contract-expected.ts`
records the new `me` span and, as it already does for a value added to `002`'s
`session_revoked` (line 567), the `visma_connect` emission of `step_up_succeeded` and the
new event, so the `apps/api` smoke check asserts them. **Forbidden on every signal**: the search query text, entity titles,
property values, organization and user names, emails, the style nonce and every URL
fragment.

### Spans

| Span name | When | Required attributes (in addition to common) | Conditional attributes |
| --------- | ---- | ------------------------------------------- | ---------------------- |
| `catalog.entity.search` | op | `tayzu.catalog.search.query_length` (int), `tayzu.catalog.page.size` (the limit) | `tayzu.catalog.result.count` |
| `catalog.entity.list` (existing, extended) | op | adds `tayzu.catalog.sort.field` (`identifier`\|`title`\|`updated_at`) and `tayzu.catalog.sort.order` (`asc`\|`desc`) | unchanged |
| `identity.session.me` | route | `tayzu.identity.session.gate` (`none`\|`password_change_required`\|`password_expired`\|`mfa_enrolment_required`\|`unauthenticated`) | `tayzu.tenant.id` (when the session has an active organization) |

`catalog.entity.search` has `001`'s common attributes and its `authz.plan` child span
(unchanged). Errors follow `001`'s rules: `error.type` only for expected errors, a
sanitized exception event for `internal`. HTTP server spans come from the existing
instrumentation. The route-template matcher of `apps/api/src/telemetry.ts` gains one
rule, defined by **path shape**, not by which route answered (Q27, B1): every HTTP server
span whose path is not under `/v1`, `/api` or `/assets`, is not `/healthz` and is not one
of the explicitly served root build files is exported as the template `/{spa}`, at any
status and for any method. So a `POST` to an app path, a path the Q74 hook refused (such
as `/catalog/_user/a%40b.com`) and a 404 all export `/{spa}`, and a `_user` email in an
app path never reaches a span. The predicate is `isSpaPath`, the one the fallback uses
(D9). The asset paths keep their hashed file names. `GET /v1/search/entities` and
`GET /v1/me` have no identifier in their path, and `q` travels in the query string,
which is dropped from every exported span (`002` Q67).

### Metrics

No new instrument.

| Instrument | Change |
| ---------- | ------ |
| `tayzu.catalog.operation.duration` | `tayzu.catalog.operation` gains the value `entity.search` |
| `tayzu.catalog.validation.failures` | `tayzu.catalog.operation` gains the value `entity.search` (a short or long query, a too large limit); under the existing `entity.list` value it now also counts a cursor of another sort or with an unreadable anchor |

Static serving adds no metric: the HTTP server spans cover it. The query length, the
sort field and the gate are span attributes only, never metric attributes, so the
cardinality budget of `001` is unchanged.

### Log events

| Event name | Severity | Attributes | Purpose |
| ---------- | -------- | ---------- | ------- |
| `auth.security.step_up_succeeded` (`002`, existing) | INFO | `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.method` gains the emitted value `visma_connect` | A Visma Connect step-up is now recorded when the re-authorization callback completes; the tenant and actor are those of the session the state is bound to (Q27 B2) |
| `auth.security.reauthorization_failed` | WARN | `tayzu.auth.reauthorization.reason` (`invalid_state`\|`exchange_failed`) | A failed re-authorization callback leaves a trace; no tenant, because an unknown or expired state is bound to none (Q29) |

No code, state, token or claim reaches either event. Over HTTP, a search without a valid
context is refused by the `/v1/*` catch-all before the catalog pipeline runs, so it
emits the catch-all's existing rejection signals, not `001`'s
`catalog.security.context_rejected` (which fires only for an in-process call without a
context). An unexpected failure is `catalog.internal_error`. Search reads are not
audited (`001` R2). The sampling exemption of `001` applies unchanged.

## Security considerations (SSA SEC01-SEC16 posture)

The `vcdm-ssa-validator` pre-assessment (Mode A) of task 1.1 ran on 2026-11-18/19. It
found two blocking gaps (B1 and B2, both SEC16), closed by Q27 to Q29, and the human
answered its questions as Q30 to Q35; its non-blocking gaps are closed in the design and
the tasks as the table below says. A new finding becomes a row from Q44 on. This is
Tayzu's first SSA cycle, so there are no open items from an earlier assessment to carry
(Q31).

| Gap (task 1.1) | Where it is closed |
| -------------- | ------------------ |
| B1 (SEC16) an app path that the fallback does not answer keeps its raw path in spans | Q27, Q28, Observability contract, D9 (`isSpaPath`), task 4.6 |
| B2 (SEC16) no success event for a Visma Connect step-up, no trace of a failed callback | Q27, Q29, D11, Log events, task 3.11 |
| `GET /v1/me` and a bearer token | D8 (the uniform `401`), task 3.9 |
| Fallback exclusion is `/api`, not `/api/auth` | D9, proposal |
| Vite dev server exposure | D2, task 2.1 |
| Rate limit on static routes | D9 (an IP bucket on the fallback), Gates (the ingress limit for assets) |
| Build-chain and shadcn CLI supply chain | D3, task 2.2 |
| Secrets in the bundle | task 2.8 (names from `docs/security/secrets.md`, gitleaks over `dist/`, no `VITE_*`) |
| Secrets in Playwright traces | D2, D16, tasks 10.1 and 10.11 |
| `WEB_DIST_DIR` not in the settings inventory | D17, task 11.7 |
| The e2e job's checkout credentials | D2, task 10.11 |
| The log-events sentence on context rejection | Log events |
| CSP violation reporting (Q30), the repository access review (Q33), misuse and suspicious-location detection (Q34), the SOC delivery time (Q35), TLS posture, DNS DDoS, ingress logs, Defender for Cloud | Gates, Tickets |

| Section | Applies | Posture |
| ------- | ------- | ------- |
| SEC01 Diagram | Yes | The browser SPA is drawn as a component of the API container with its same-origin HTTPS calls and the Visma Connect redirects, in the full and zone diagrams (D17, task 11.6). The check for open items of earlier assessments is N/A: this is Tayzu's first SSA cycle (Q31). |
| SEC02 Attack surfaces | Yes | New: the HTML pages and hashed assets (public, static), `GET /v1/me` (session only; a bearer token gets the uniform `401`) and `GET /v1/search/entities` (session or machine token, Cerbos-narrowed), and the callback's fixed redirect. Each gets a row in `docs/security/attack-surfaces.md` (task 11.5); the public routes are two reviewed `PUBLIC_ROUTE_ALLOWLIST` entries (D9). |
| SEC03 Access control | Yes | Search is narrowed by the same Cerbos `list` plan as `entities.list` and fails closed on a plan it cannot translate (D5); `GET /v1/me` reads only the caller's own session (D8); the UI never sends a tenant (D15); cross-tenant answers stay "not found" through the UI (D16). |
| SEC04 Password storage | Partial | No password is stored or hashed by this change. The forms send passwords only to the allowlisted routes over same-origin TLS, never keep them after submit and never log them (D11). |
| SEC05 Cryptography | Partial | One new use: the 128-bit CSP style nonce from `crypto.randomBytes` per HTML response (D10), recorded in `docs/security/crypto-inventory.md`. TLS and HSTS unchanged. |
| SEC06 Misuse | Yes | Search limits checked before database work and `LIKE` wildcards escaped (D5); a sort-bound cursor (D6); sanitized markdown and URL rendering, no `dangerouslySetInnerHTML` (D13, `001` T4); fragments stripped, no submit without a user action, validated return paths (D11, D15); the callback redirect target is a constant (D11). Detection of sign-ins from suspicious locations and of misuse is not implemented (Q34): two tickets, and misuse detection on the `046` ingress or WAF is a gate. |
| SEC07 Dependencies | Yes | Many new packages, each named with its license in D3, pinned exactly, runtime ones as `dependencies` so `pnpm audit --prod` covers them, in the SBOM, with no install script unless `allowBuilds` names it; no CDN or third-party script at runtime; shadcn/ui copied, not installed, its CLI output reviewed; `axe-core`'s MPL-2.0 accepted as test-only (Q26, Q40, task 2.2); a non-blocking critical-level audit covers the build chain; Dependabot waits 14 days (Q43). |
| SEC08 File upload | N/A | No upload (custom icons are `047`). |
| SEC09/SEC10 Secrets | Partial | The bundle contains no secret: any `import.meta.env.VITE_*` use fails the build check (with `envDir` pointing at an empty directory), the check scans `dist/` for the name of every Secret-class row of `docs/security/secrets.md`, and gitleaks runs a `dir` scan over `dist/` (task 2.8). E2E credentials are random per run and traces are kept 3 days (D2, D16). `WEB_DIST_DIR` is a Setting row, a path, not a secret. |
| SEC11 Phishing | Partial | The accept and reset pages follow the page rules of `043` Q32 and `044` D14 and Q26 (D11); links are built only from trusted settings (unchanged); the Visma Connect navigation requires an `https:` URL returned by the server and a click; external URL values open with `noopener noreferrer`. |
| SEC12 Testing | Yes | Component tests, server integration tests, Playwright e2e against the real stack behind TLS with axe and CSP-violation checks, and the ZAP baseline over the HTML pages (D10, D16). The team has been trained in security testing (Q32). |
| SEC13 Deployment | Partial | Nothing is deployed here; the image that carries `dist/` and sets `WEB_DIST_DIR` is `046`'s (Gates). The access review of the GitHub repository, its Actions secrets and its environments has not been done: a `046` gate (Q33). |
| SEC14 Infra permissions | Yes | One migration (Checkpoint 3) creates a trusted extension and four indexes; no role, grant or policy changes (D7). The Azure extension allowlist is a gate. |
| SEC15 Network and host | Partial | No new listener or port: the pages are served by the existing API on the existing ingress, under CSP, COOP, CORP, COEP, `X-Frame-Options` and HSTS (D10); the fallback has an IP bucket (D9). The TLS posture check, DNS DDoS protection, the ingress or WAF decision and Defender for Cloud are `046` gates. |
| SEC16 Logging | Yes | Three span changes, two metric values and two step-up events in the contract; no tenant free text, no query text and no browser logs on any signal; every app-shaped path exported as one template at any status and method (Q27 B1); a Visma Connect step-up logged on success and failure (Q27 B2, Q29). How long logs take to reach the SOC is unknown: a `046` gate (Q35), with the ACA ingress logs sent to Azure Monitor. |

## Divergences from Port (deliberate)

| Topic | Port | Tayzu 003 | Why |
| ----- | ---- | --------- | --- |
| Global search | Admin-configured index per blueprint, categorized results | Server-side prefix and trigram search over every readable entity, plus a local blueprint filter | Q4; indexing settings and the query language are `005` |
| Catalog table toolkit | Filters, column management, group-by, saved views, export | Schema columns, sort by meta fields, keyset paging | Q1; the rest is `005`, `024` and `047` |
| Entity page | Per-blueprint layout, widget dashboard, custom tabs | Fixed Details and Related tabs | Q1; layouts are `047` |
| Enum colors, icons, branding | Configurable | None | Q1; `047` with its storage |
| Hosting | Port's SaaS app | The API's own origin, self-only CSP, no CDN | Q2, Q5, `SOV` L443 |

## Risks / Trade-offs

- **Library styles under a strict CSP** → a component that injects `<style>` at
  runtime breaks under `style-src 'self'`. The nonce of D10 covers the known case; the
  e2e CSP check fails on any other, so a new component cannot regress silently.
- **Bundle size and the dependency surface** → a dozen runtime libraries and their
  transitive packages ship to every user. Each is reviewed in task 2.2, routes and
  locales are split into chunks, and a build test fails if the initial JavaScript
  exceeds 350 kB gzip (a budget recorded in `docs/catalog/catalog-ui.md`).
- **Tool compatibility** → `eslint-plugin-jsx-a11y` 6.10.2 declares ESLint peers only
  up to 9 (Q40): the `peerDependencyRules` entry is explicit and a lint test proves its
  rules fire on ESLint 10, so a silent no-op is caught. TypeScript 6 with the React
  types and Vite 8 with `@vitejs/plugin-react` are checked in task 2.1; any other
  unsupported pair stops the task and is asked in chat, never forced with overrides
  silently.
- **Fresh releases** → a version younger than 14 days is not adopted (Q43), and
  Dependabot waits as long; a security fix that cannot wait is asked in chat.
- **Trigram ranking and collation** → `title % q` uses the default 0.3 threshold and the
  title sort uses the database collation, which differs between the sandbox (`C.UTF-8`)
  and Azure (`en_US.utf8`); the tests assert relative order only where collation does
  not matter, and the docs state it.
- **Search cost** → a short query can match many rows; the limit (at most 50), the
  minimum length (2), the statement timeout and the trigram indexes bound it. `005`
  replaces it.
- **Entities with `/` in their identifier, or made only of dots,** stay unreachable over
  HTTP (Q18, Q36), so the UI cannot open them; listed with a disabled link and a ticket.
  Identifiers with `@`, `:` or `=` depend on the custom path serializer of D4 and on the
  router setting of D12; a library upgrade that re-encodes them would make those
  entities 404 again, which the client and e2e tests catch.
- **The cursor anchor is a row read** → one more indexed lookup per page, inside the same
  transaction; in exchange the cursor stays small and holds no tenant data (Q37).
- **E2E stability** → the suite needs Docker, PostgreSQL, Cerbos and a browser; it runs
  as its own CI job with retries off and traces kept on failure, so a flaky test is
  visible and fixed, not retried away.
- **The SSO step-up round trip loses the page's in-memory state** → the user repeats the
  action after returning (Q14). Accepted for `003`; a popup flow is the alternative.

## Gates for the first deployment (`046`)

Human-owned, added to the gates `046` inherits from `002` to `045` (Q8):

- `pg_trgm` is in the `azure.extensions` parameter of the PostgreSQL Flexible Server
  before migration `0015` runs, and the migration role has `CREATE` on the database.
- The image carries the `@tayzu/web` build and sets `WEB_DIST_DIR`; the ingress does not
  rewrite or drop the CSP, COEP, `Permissions-Policy` or `Referrer-Policy` headers (a
  header check against the sandbox URL).
- `ALLOWED_ORIGINS`, `BETTER_AUTH_URL`, `INVITATION_LINK_BASE_URL` and
  `PASSWORD_RESET_LINK_BASE_URL` all name the one public origin.
- **CSP violation reporting** (Q30): a same-origin report endpoint with a sanitized log
  (no URL, no sample, only the directive and a count) exists before production.
- **Access review** (Q33): the GitHub repository's collaborators, its Actions secrets and
  its environments are reviewed and the result recorded.
- **Misuse detection** (Q34) on the ingress or a WAF, and the ingress-or-WAF decision
  itself, with Azure DNS DDoS protection recorded.
- **Ingress rate limit** for the hashed assets and the root build files, which have no
  in-process limit (D9).
- **Logging** (Q35): the ACA ingress logs go to Azure Monitor, and the time for logs to
  reach the SOC is measured and recorded.
- **TLS posture**: an SSL Labs or `testssl.sh` run against the public origin shows TLS 1.2
  or later only and HSTS, recorded with `002`'s task 11.12 record.
- **Defender for Cloud** is enabled for the subscription that holds the deployment.
- The `043` and `044` page gates for `MOUNT_IDENTITY_ROUTES` are met by this change's
  `/accept-invitation` and `/reset-password` (tasks 6.8, 6.9, 6.10 and 10.6); `046`
  records the evidence before it turns the switch on.
- The ZAP baseline runs against the sandbox with the app served.

## Tickets (not built in this change)

| Ticket | Item |
| ------ | ---- |
| Browser RUM (`016`) | Browser telemetry with a sanitization contract (no tenant free text), `traceparent` propagation to the API, and CSP violation reporting to a same-origin endpoint (Q6). |
| Catalog UI customization (`047`) | Page layouts, saved views, column configuration, branding, banner, the icon library, enum colors and their storage, each with its migration and Cerbos resource (Q1). |
| Azure deployment and first release (`046`) | The IaC, the sandbox rehearsal and every first-deployment gate (Q8). |
| Repoint the first-deployment gates | Replace each "`010`" first-deployment reference in `002` to `045` (designs, docs and `docs/security/*`) by `046`, or by `016` where it is observability work (Q8, Context). |
| Filter language and full-text search (`005`) | The filter DSL, full-text search with its indexes, admin-chosen indexed blueprints, "My" and "My Teams" filters, and replacing `search.entities` (Q4). |
| Entity identifiers with `/` | Revisit `002` Q74 for the entity segment of catalog routes, or add an id-based route, so the UI can open such an entity (Q18). |
| ADR backfill | ADR-0001, 0002 (superseded by 0012), 0003, 0005 and 0006 remain unwritten (`001` T7). |
| Trusted Types | Evaluate `require-trusted-types-for 'script'` once the dependency set is stable. |
| CSP violation reporting (Q30) | The same-origin report endpoint with a sanitized log; a `046` gate, built with `016`'s browser telemetry or before it. |
| Suspicious-location sign-in detection (Q34) | Detect and alert on sign-ins from unusual locations (SEC06). |
| Misuse detection and WAF (Q34) | Misuse detection at the `046` ingress or a WAF (SEC06, SEC15). |
| Remove version-1 cursor acceptance (`005`) | Drop the version-1 `{ k }` cursor of `entities.list` once no client can hold one (D6, Q37). |
| Visma Connect URL origin check | Accept the sign-in and step-up navigation URL only when its origin is the discovered issuer's authorization endpoint origin, exposed to the app without a new public surface (D11). |
| Entity and blueprint forms | Create and edit forms with the JSON Schema form generator (`project.md` §2), which Q12 keeps out. |

## Migration Plan

1. **One SQL migration, Checkpoint 3** (Q41): `packages/db/migrations/0015_catalog_entity_search.sql`
   (D7), generated by drizzle-kit with the `CREATE EXTENSION` prepended, with
   `packages/db/migrations/down/0015_catalog_entity_search.down.sql`,
   `meta/0015_snapshot.json` and its `_journal.json` entry (idx 15). ⛔ Stop for the human's separate approval of the SQL.
2. **No Cerbos policy change** (D5). If implementation shows one is needed, it is asked
   in chat and stops at Checkpoint 3 before any policy file is written.
3. Deploy (in `046`): the migration first, then the release that carries `sort`,
   `search.entities`, `GET /v1/me` and the static routes with `WEB_DIST_DIR`.
4. Rollback: unset `WEB_DIST_DIR` to stop serving the app (the API is unchanged), and the
   down script removes the indexes and the extension. A version-2 cursor held by a browser
   then fails with `CATALOG_VALIDATION_FAILED` and the table restarts from its first
   page; nothing else breaks.

## Resolved decisions (asked and approved in chat, 2026-11-18 and 2026-11-19)

Per `openspec/project.md` §20. Q1 to Q11 are the human's answers before this proposal
was written. Q12 to Q26 are the human's answers of the same day to the fifteen open
questions this design raised (OQ1 to OQ15, kept in each row); each took the recommended
option. Q27 to Q43 are the human's answers of 2026-11-18 and 2026-11-19 to the questions
of task 1.1, each with the recommended option; each row names its source, the VCDM
Mode A pre-assessment or the drift-check. A row that a later row narrows or extends
says so in italics, as `045` does. A new question becomes a row from Q44 on.

| # | Question | Decision |
| --- | -------- | -------- |
| Q1 | Scope of `003` against the ~30-80 task budget | Split. `003-catalog-ui-core` is the core: the app shell (navigation, catalog sidebar of blueprints, light and dark theme), every auth page, i18n (react-i18next, en and es), the catalog table per blueprint (columns from the blueprint schema, keyset pagination, sorting by meta fields), the entity page with Details and Related tabs, and minimal search. Page layouts, saved views, branding, banner, icons, enum colors and their storage move to a new change, `047-catalog-ui-customization`. _Rejected:_ one change with the full roadmap scope (far over budget); deferring the auth pages to a follow-up (keeps the `043` and `044` links inert). |
| Q2 | Hosting of the web app | _Refined by Q28: the fallback excludes `/api`, not only `/api/auth`, and has no file-extension rule._ The same origin as the API: Fastify serves the Vite build from the same container (a static plugin and an SPA fallback for non-`/v1` and non-`/api/auth` `GET`s). The `SameSite=Lax` cookie, CSRF and Visma Connect `form_post` keep working, and the SPA needs no CORS. _Rejected:_ Azure Static Web Apps or a CDN on a sibling subdomain with CORS; a separate Container Apps app. |
| Q3 | Auth pages in `003` | All of them: sign-in (local and Visma Connect), the temporary-password change, MFA enrolment and re-enrolment, step-up (TOTP, password, SSO round trip), `/accept-invitation` (`043`) and `/reset-password` (`044`) with the `044` D14 rules. They are the prerequisite for turning on `MOUNT_IDENTITY_ROUTES` in production. _Rejected:_ only sign-in now and the rest in a follow-up. |
| Q4 | Search and sort backend | Minimal and server-side: cross-blueprint search by title or identifier (prefix plus a `pg_trgm` trigram index, a migration, Checkpoint 3) and sorting by meta fields (title, updatedAt). Cerbos narrowing works as `entities.list` does today. The filter language and full-text search stay in `005-search-and-query`. _Rejected:_ client-side filtering over loaded pages; PostgreSQL full-text search with GIN now. |
| Q5 | Content Security Policy | Strict and self-only: `default-src 'self'`, no inline script or style hashes unless needed, self-hosted fonts and icons, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` plus the Visma Connect origin as needed; a looser policy only in the Vite dev server; DAST stays green. _Rejected:_ a policy with `'unsafe-inline'`; the same loose policy in development and production. |
| Q6 | Browser telemetry | None in `003`; the server already traces requests. Browser RUM goes to `016-observability-dogfood`, recorded as a ticket. _Rejected:_ the OpenTelemetry web SDK with `traceparent` propagation now; the Application Insights JavaScript SDK (a third-party script, against the page rules). |
| Q7 | Tests | Component tests with Vitest, Testing Library and jsdom; Playwright e2e with axe-core accessibility checks against the real API, PostgreSQL 18 and Cerbos, in a new CI job. The TDD path guard must accept Playwright specs: a hook change, a setup task that needs the human's attention. _Rejected:_ component tests only, with e2e later. |
| Q8 | Deployment | A new roadmap change, `046-azure-deployment-and-first-release`, after `003`, owning the IaC for Container Apps, PostgreSQL Flexible, Key Vault and Monitor, the sandbox rehearsal and every first-deployment gate that `002` to `045` attribute to "`010`"; those references are repointed in a later task or ticket, not in this proposal. _Rejected:_ deploying within `003`; leaving the gates with `010`. |
| Q9 | Naming | `003-catalog-ui-core` keeps its name with the reduced scope; the second half is `047-catalog-ui-customization`; `046` is the deployment. _Rejected:_ renaming to `003a`/`003b`; renumbering the roadmap. |
| Q10 | Locale | The browser locale (`navigator.language`, `en` fallback) plus an in-app selector stored in `localStorage`. No profile field and no auth migration. _Rejected:_ a Better Auth profile field (`project.md` §15), which needs an auth schema migration. |
| Q11 | ADRs | `003` writes the missing ADR-0004 (TanStack Query + Zustand) and ADR-0007 (shadcn/ui) as backfills, plus two new ADRs, same-origin web hosting and the strict CSP, at the next free numbers (0025 and 0026). _Rejected:_ only the new ADRs; leaving the backfill to a separate change. |
| Q12 | (OQ1, answered by the human in chat on 2026-11-18, recommended option (a)) Catalog mutations in `003` (Q1 lists only read views; step-up needs a real consumer) | Entity delete only, from the entity page, with the step-up dialog: small, and it exercises every step-up path for real. _Rejected:_ a fully read-only `003`, with the step-up dialog tested only on the reset and link routes; entity create and edit forms with the JSON Schema form generator (well over budget). |
| Q13 | (OQ2, answered by the human in chat on 2026-11-18, recommended option (a)) How the shell learns the session's gate, role and MFA state | A plain Fastify route, `GET /v1/me` (D8), because `resolveContext` rejects gated sessions uniformly. _Rejected:_ an oRPC procedure plus `get-session` (leaves the gated cases ambiguous); Better Auth's `customSession` plugin on `/get-session` (changes `002`'s session surface). |
| Q14 | (OQ3, answered by the human in chat on 2026-11-18, recommended option (a)) Returning from the Visma Connect step-up round trip | The re-authorization callback answers `303` to the fixed `/step-up/complete`; the app stores only an in-app path in `sessionStorage`, and the user repeats the action. _Rejected:_ a popup window with `postMessage` (more code, popup blockers); keeping the JSON answer and telling the user to go back. |
| Q15 | (OQ4, answered by the human in chat on 2026-11-18, recommended option (a)) Runtime `<style>` elements (Radix scroll lock) under `style-src 'self'` | A per-response style nonce handed to the Radix scroll lock through `get-nonce`; scripts stay nonce-free (D10). _Rejected:_ `style-src 'self' 'unsafe-inline'` (weaker, flagged by ZAP 10055); avoiding every component that injects styles (a custom dialog, more code). |
| Q16 | (OQ5, answered by the human in chat on 2026-11-18, recommended option (a)) Rendering `markdown` property values | `react-markdown` with raw HTML skipped, no images, and a URL filter keeping only `http`, `https` and `mailto`. _Rejected:_ plain text in `003` with rendering later; `marked` with DOMPurify (an HTML string plus a sanitizer). |
| Q17 | (OQ6, answered by the human in chat on 2026-11-18, recommended option (a)) The TOTP enrolment QR code | `qrcode.react`, rendered as inline SVG (no network, no `data:` image). _Rejected:_ the secret as text only (no dependency, poorer UX); `uqr` (smaller, less used). |
| Q18 | (OQ7, answered by the human in chat on 2026-11-18, recommended option (a)) Entities whose identifier contains `/` (unreachable over HTTP because of `002` Q74) | _Narrowed by Q36: the disabled link remains only for `/` and dot-only identifiers._ Entities whose identifier contains `/` are listed with a disabled link and a localized note, plus a ticket to revisit `002` Q74. _Rejected:_ allowing `%2F` in the entity segment of catalog routes in `003`, with its own security review; an id-based entity route. |
| Q19 | (OQ8, answered by the human in chat on 2026-11-18, recommended option (a)) The `_user` and `_team` system blueprints in search | The `_user` and `_team` system blueprints are included in search, narrowed by Cerbos like `entities.list`. _Rejected:_ excluding them from search (users and teams found only in their tables). |
| Q20 | (OQ9, answered by the human in chat on 2026-11-18, recommended option (a)) Accepting an invitation with an existing account while signed out | An embedded local sign-in on the accept page keeps the token in memory only; a Visma Connect user signs in first and reopens the link. _Rejected:_ keeping the token in `sessionStorage` across a sign-in navigation; always requiring a sign-in before the link is opened. |
| Q21 | (OQ10, answered by the human in chat on 2026-11-18, recommended option (a)) How the API finds the build | An optional `WEB_DIST_DIR`; unset means the API alone, exactly as before. _Rejected:_ a fixed path inside the image, always served; a separate `MOUNT_WEB_APP` switch plus the path. |
| Q22 | (OQ11, answered by the human in chat on 2026-11-18, recommended option (a)) ZAP rules that fire on any single-page app | Fix every new ZAP WARN, and set only 10109 "Modern Web Application" to `INFO`, with its note, as 10049. _Rejected:_ setting every new alert to `INFO`; failing until a rule-by-rule review in chat. |
| Q23 | (OQ12, answered by the human in chat on 2026-11-18, recommended option (a)) A `/forgot-password` page (not named in Q3, needed to reach `/reset-password`) | A `/forgot-password` page is part of `003`. _Rejected:_ leaving it out, with admins sending reset links some other way. |
| Q24 | (OQ13, answered by the human in chat on 2026-11-18, recommended option (a)) Calling Better Auth from the browser | A thin hand-written client over the allowlisted routes (D4). _Rejected:_ `better-auth/client` (a large dependency, and routes the app does not use). |
| Q25 | (OQ14, answered by the human in chat on 2026-11-18, recommended option (a)) `form-action` and the Visma Connect origin | `form-action 'self'` only, because the app never submits a form to Visma Connect (D10); the origin is added only if the e2e run proves it is needed, which would be a new question. _Rejected:_ adding the Visma Connect origin now. |
| Q26 | (OQ15, answered by the human in chat on 2026-11-18, recommended option (a)) The MPL-2.0 license of `@axe-core/playwright` and `axe-core` (Q7 names axe-core; the license is not on the allowlist of `docs/security/dependencies.md`) | `@axe-core/playwright` and `axe-core` are adopted as test-only dev dependencies that never ship, with their MPL-2.0 license recorded in `docs/security/dependencies.md` and the allowlist note extended for test-only MPL-2.0. _Rejected:_ Playwright's built-in accessibility snapshots only, without axe (weaker WCAG coverage). |
| Q27 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) Checkpoint 1 with two blocking gaps (B1 and B2, both SEC16) | Checkpoint 1 stays approved, on condition of the fixes. B1: an app path the fallback does not answer (a `POST`, a 404, a `%40` path refused by Q74) kept its raw path, so a `_user` email could reach a span; the `/{spa}` export template is defined by path shape (every HTTP server span whose path is not under `/v1`, `/api` or `/assets`, is not `/healthz` and is not an explicitly served root build file, at any status and for any method), shares its predicate with the fallback (Q28), and task 4.6 covers `GET` and `POST /catalog/_user/alice@example.com`, `/catalog/_user/a%40b.com` and `/catalog/service/payments.api`. B2: a Visma Connect step-up was never logged as succeeded (`emitStepUpSucceeded` hard-codes `local`, `auth.ts:346-361`; the SSO branch of `step-up.ts` emits only required and insufficient; `reauthorization.ts` has no telemetry); on a successful `complete` the server emits `auth.security.step_up_succeeded` with `tayzu.auth.method=visma_connect` and the bound session's tenant and actor, plus the event of Q29, asserted in `otel-smoke-check` with no code, state or token in any attribute (task 3.11). _Rejected:_ withdrawing Checkpoint 1 until the fixes are implemented; accepting B1 or B2 as residual risk. |
| Q28 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) Which paths the SPA fallback answers | `index.html` for every `GET` and `HEAD` outside `/v1`, `/api`, `/assets` and `/healthz`, except an explicit list of root build files (`theme-init.js`, the favicon). This replaces the "no file extension" rule, which broke every `_user` page (identifiers are emails, so they contain a dot) and identifiers such as `v1.2`. _Rejected:_ keeping the file-extension rule; an allowlist of app route patterns duplicated on the server. |
| Q29 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) How a failed re-authorization callback is logged | A new event, `auth.security.reauthorization_failed`, WARN, with the reason `invalid_state` or `exchange_failed` and no tenant (none is bound to an unknown state); plus `step_up_succeeded` with `visma_connect` on success (Q27). _Rejected:_ a counter only, with no log event; reusing `step_up_insufficient` for a failed callback. |
| Q30 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) CSP violation reporting | A `046` gate: a same-origin report endpoint with a sanitized log exists before production; also a ticket. _Rejected:_ building the endpoint in `003`; no reporting at all. |
| Q31 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) SEC01, open items of earlier assessments | N/A: this is Tayzu's first SSA cycle, so there are no open items from earlier assessments. _Rejected:_ carrying the `002` to `045` pre-assessment gaps as open SSA items. |
| Q32 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) SEC12 Q2, security-testing training | Yes: the team has been trained in security testing. _Rejected:_ recording it as unknown; a training ticket. |
| Q33 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) SEC13, the access review of the GitHub repository, its Actions secrets and its environments | Not done; a ticketed `046` gate. _Rejected:_ doing it inside `003`; leaving it undocumented. |
| Q34 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) SEC06 Q1 and Q3, suspicious-location sign-ins and misuse detection | Not implemented; two tickets, and misuse detection goes on the `046` ingress or a WAF (a gate). _Rejected:_ building detection in `003`; one combined ticket with no deployment gate. |
| Q35 | (VCDM Mode A, task 1.1, answered by the human in chat on 2026-11-18, recommended option) SEC16 Q4, the time for logs to reach the SOC | Unknown; a `046` gate that measures and records it. _Rejected:_ stating an assumed time; leaving it out of the SSA. |
| Q36 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) Opening identifiers that hold `@`, `:` or `=` | They must be openable: a custom path serializer in the oRPC link and TanStack Router's `pathParamsAllowedCharacters: ['@', ':', '=']` send them unencoded (today `@orpc/openapi-client` 1.15.4 uses `encodeURIComponent`, and the Q74 hook, `server.ts:581`, refuses any `%`). Q18's disabled link stays only for `/` and for dot-only identifiers, which the browser normalizes and so cannot be reached. _Rejected:_ disabling the link for every identifier with a reserved character; relaxing the Q74 hook for `%40`, `%3A` and `%3D`. |
| Q37 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) The version-2 cursor and the 512-character limit | `{ v: 2, s, o, id: <uuid> }`: the server reads that row's sort key inside the tenant transaction, so the 512-character limit holds (a 256-character title plus a 256-character identifier would not fit). `blueprints.list` stays on version 1. The `updated_at` keyset relies on millisecond precision on writes, recorded in D6. _Rejected:_ the sort value and identifier in the cursor with a larger limit; an encrypted or compressed cursor. |
| Q38 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) The e2e origin, given that outside test every origin must be `https:` | The e2e runs behind a test-only TLS reverse proxy started by `e2e.sh`, with the throwaway CA `dast.sh` already uses; Better Auth `trustedOrigins` (`server.ts:336`) and the accept and reset routes (`server.ts:1014-1016, 1116-1118, 1145-1147`) refuse `Origin: http://…` outside test. The product is not touched. _Rejected:_ running the e2e with `NODE_ENV=test` and `http:` origins (not production-like); relaxing the origin checks for `localhost`. |
| Q39 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) The route-allowlist test and the static routes | A second harness app in `route-auth-allowlist.int.test.ts` with a fixture `web-dist` and `WEB_DIST_DIR`, a reviewed prefix entry for `/assets/`, and exact entries for the fallback and the root files; today lines 208-220 reject any entry that is not a registered route, and `wildcard: false` registers one route per file. _Rejected:_ one entry per hashed asset; exempting the static routes from the test. |
| Q40 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) `eslint-plugin-jsx-a11y` 6.10.2 declares ESLint peers only up to 9 (the repository runs 10.11.0) | An explicit `pnpm.peerDependencyRules.allowedVersions` entry and a lint test proving its rules fire. It also pulls in `axe-core` (MPL-2.0), so the Q26 license note covers that copy too. _Rejected:_ dropping the accessibility lint plugin and relying on axe in e2e only; pinning ESLint back to 9. |
| Q41 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) How migration `0015` is produced | One migration, generated by drizzle-kit, with `CREATE EXTENSION pg_trgm` prepended before Checkpoint 3, in `packages/db/migrations/` (the journal ends at idx 14, so `0015` is next). _Rejected:_ two migrations (the extension as a `--custom` file, then the indexes); a hand-written migration without a generated snapshot. |
| Q42 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) ZAP alerts beyond 10109 | Run the baseline right after task 2.1 (task 2.1b) and ask the human in chat about every alert actually raised beyond 10109 (10027 and 10096 are likely); Q22 stands for 10109. _Rejected:_ setting every new alert to `INFO` now; waiting for group 4 to see the alerts. |
| Q43 | (drift-check, task 1.1, answered by the human in chat on 2026-11-19, recommended option) Dependency versions | Pin the latest release that is at least 14 days old, re-checked at task 2.1 (Vite 8.3.8, of 2026-11-11, is too new: the latest 8.3.x before the cutoff; for `@hookform/resolvers`, the latest major supporting Zod 4 that is at least 14 days old); a Dependabot `cooldown` of 14 days and an `ignore` for `@playwright/test` and `playwright-core`, bumped with the sandbox browser; `pnpm why playwright-core` shows 1.63.0 only; the drift-check's pinned table is D3's starting point. _Rejected:_ the latest release at install time; caret ranges in `apps/web/package.json`. |
| Q44 | (Implementation, task 2.1, answered by the human in chat on 2026-11-19, recommended option) The output of the shadcn CLI 4.23.0 | The CLI's presets add a web font (`@fontsource-variable/geist`), import the monolithic `radix-ui` package, the `cn` npm package and `shadcn/tailwind.css` (a runtime dependency on `shadcn`, against ADR-0007). They are removed and the copied source is adapted to design D3's packages: individual `@radix-ui/react-*` imports (the same API; `radix-ui@1.8.1` depends on exactly D3's primitive versions), `cn` from `@/lib/utils` on `clsx` and `tailwind-merge`, the system font stack, and the custom variants and `no-scrollbar` utility of `shadcn/tailwind.css` copied into `src/index.css` with an MIT notice. Every later `shadcn add` gets the same adaptation, written in `apps/web/CLAUDE.md`. `input-group` and `textarea` are copied as registry dependencies of `command`. _Rejected:_ naming `radix-ui` and `cn` in D3; accepting the CLI output as is. |
| Q45 | (Implementation, task 2.1, 2026-11-19; orchestrator choice, open to Checkpoint 2) Dev server details and the Vite pin | (1) The development CSP's `script-src` also carries the `sha256-` hash of the React Refresh preamble that `@vitejs/plugin-react` 6.2.1 inlines, computed in `vite.config.ts` from the plugin's exported `preambleCode`, instead of `'unsafe-inline'`; `connect-src` adds `ws://127.0.0.1:5173`; the dev headers apply only to `vite serve`, never to `vite preview`. (2) The root `vite` is pinned exactly to 8.3.5 (2026-10-21), because the lockfile had resolved `^8.3.3` to 8.3.8, under 14 days old (Q43); no `server.fs` advisory affects 8.3.x. (3) The dev proxy targets `http://127.0.0.1:3000`, the default of `dast.sh`. (4) The `index.html` nonce placeholder is `__TAYZU_STYLE_NONCE__`, which task 4.5 substitutes. |
| Q46 | (Task 2.1b, the early ZAP baseline, answered by the human in chat on 2026-11-19, recommended option) The alerts beyond 10109 | The baseline over the 2.1 build behind the design D10 headers (ZAP 2.17.0, the pinned image and `.zap/rules.tsv`; 59 PASS, no FAIL) raised only 10109 and 10027. 10027 (Suspicious Comments) fired on the developer comment that `public/theme-init.js` ships verbatim. Resolution: `theme-init.js` ships with no comment: its commented source lives under `src/`, and a small plugin in `vite.config.ts` minifies it with Vite's own transform and emits it unhashed at the build root (still a classic external script under `script-src 'self'` and a root build file of Q28 with `no-cache`), implemented with task 5.6; 10027 stays a WARN. 10109 becomes INFO with its note (Q22). 10096 did not fire. The marketplace beta rules (`pscanrulesBeta`: 90004, 10063, 10110) could not be fetched in the sandbox; task 4.7's run in CI covers them, and any new alert there is asked in chat. _Rejected:_ rewording the comment; 10027 to INFO. |
| Q47 | (Implementation, task 2.3, 2026-11-19; orchestrator choice, open to Checkpoint 2) ESLint details | `eslint-plugin-jsx-a11y` uses its `strict` preset, as design D2 says; the peer rule `eslint-plugin-jsx-a11y@6.10.2>eslint: 10` lives in the root `package.json` `pnpm.peerDependencyRules` and its reason in `docs/security/dependencies.md`, like the overrides; the web bans add `Function(...)` without `new` and `document.writeln` as variants of the listed sinks; the restricted imports use one regex `^@tayzu/(?!catalog/contract$)`, because a gitignore-style negation cannot re-include a child of an excluded path; `input-group.tsx` (shadcn) keeps its mouse-only focus shortcut with a reasoned `eslint-disable-next-line` for `click-events-have-key-events` and `no-noninteractive-element-interactions` (keyboard users reach the input with Tab). |
| Q48 | (Implementation, task 2.8, 2026-11-19; orchestrator choice, open to Checkpoint 2) How the bundle check reads its rules | (1) The `import.meta.env.VITE_*` ban scans the sources (`apps/web/src`, without `src/build-check/`, whose fixtures hold the pattern on purpose), not `dist/`, because Vite replaces those expressions at build time. (2) The secret-name list is every row whose `Class` cell is exactly `Secret` in any table of `docs/security/secrets.md` (column found by header, `{TRACES,METRICS,LOGS}` braces expanded); Sensitive and Setting names do not trip the rule. (3) "Initial JavaScript" is the gzip size of every `<script src>` and `<link rel="modulepreload">` that `index.html` references, summed, against 350 kB; lazy chunks do not count. (4) The `http:`/`https:` origin rule reads `index.html` only, so a vendor chunk's error-message URL passes. (5) The gitleaks `dir` scan of `dist/` is a CI and `ci:local` step beside the module. |
| Q49 | (Implementation, task 2.2, 2026-11-19; orchestrator choice, open to Checkpoint 2) Scope of the Dependabot cooldown | The 14-day `cooldown` (`default-days: 14`, any `semver-*-days` at least 14, no `include`/`exclude`) applies to every ecosystem entry of `.github/dependabot.yml` (npm, github-actions, docker), not only npm as design D3 says, because Q43's 14-day rule is not npm-specific; npm also ignores every update of `@playwright/test` and `playwright-core` (Q43). `dependabot-config.test.ts` asserts both. |

## Open Questions

None. The fifteen questions of the first draft were answered by the human in chat on
2026-11-18 (Resolved decisions Q12 to Q26), and the questions of task 1.1 on 2026-11-18
and 2026-11-19 (Q27 to Q43). A new question becomes a row from Q44 on.
