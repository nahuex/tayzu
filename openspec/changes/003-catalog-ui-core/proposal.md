# Proposal: 003-catalog-ui-core

## Why

Tayzu has a catalog API (`001`), authentication, RBAC and tenant isolation (`002`),
the identity lifecycle (`043`), password reset (`044`) and org deletion (`045`), and
no way for a person to use any of it from a browser. Three earlier changes left pages
to this one and made them gates: the login screen with the local-or-Visma-Connect
choice (`002` design Non-Goals, Q17), the `/accept-invitation` page (`043` Q32) and the
`/reset-password` page (`044` D14, Q26). Until they exist, the links that `043` and
`044` email are inert and `MOUNT_IDENTITY_ROUTES` cannot be turned on in production.
`001` also handed this change two follow-ups: sanitize markdown and URL values on
render under a strict CSP (`001` T4), and filtering and search for `entities.list`
(`001` design lines 51 and 177).

The roadmap scope of `003` (`docs/references/port/roadmap-analysis.md:61-76`: the
global search, the full table toolkit, entity-page layouts and tabs, icons, enum
colors, branding, banner, theme, accessibility) does not fit the ~30-80 TDD-task budget
(`roadmap-analysis.md:9-12`) once those pages are counted. The human decided on
2026-11-18 (Resolved decisions Q1, Q8 and Q9 in `design.md`, recorded as roadmap
decision D13 in `openspec/project.md` §23) to keep `003` as the core and move
customization to a new change, `047-catalog-ui-customization`, and to give the first
Azure deployment its own change, `046-azure-deployment-and-first-release`, after
`003`. The Platform Engineering references argue for the same shape: keep the portal
a thin layer over an API-first backend (`docs/references/platform-engineering/README.md:59`
and `:78`; `SPE4` L190).

## What Changes

- **A web app, `apps/web` (`@tayzu/web`).** React, Vite and TypeScript with shadcn/ui
  components (copied into the repository, not a runtime dependency) on Radix and
  Tailwind, TanStack Query for server state, Zustand for local UI state, TanStack
  Router for typed routes and validated search parameters, react-hook-form with Zod
  for forms, and react-i18next with `en` and `es`. The shell has the navigation, a
  sidebar of the tenant's blueprints, a light and dark theme, a locale selector
  (browser locale by default, `en` fallback, choice kept in `localStorage`) and a
  user menu. Every dependency is named in `design.md` D3 with its license.
- **Same-origin hosting.** The API's Fastify server serves the Vite build from the
  same container: hashed assets under `/assets/`, and an SPA fallback that answers
  `index.html` for a `GET` that is not under `/v1`, `/api/auth`, `/assets` or
  `/healthz`. The `SameSite=Lax` session cookie, the oRPC CSRF header and the Visma
  Connect `form_post` callbacks keep working unchanged, and the SPA needs no CORS
  (Q2). The cookie is never readable by script.
- **A strict, self-only Content Security Policy** and the related headers on every
  response, through `@fastify/helmet` (Q5): `default-src 'self'`, no inline script,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action
  'self'`, self-hosted fonts and icons, `Referrer-Policy: no-referrer` app-wide, and a
  `Permissions-Policy`. The Vite dev server alone uses a looser policy. The OWASP ZAP
  baseline scan now covers the HTML pages and stays green.
- **Every authentication page** (Q3): sign-in with email and password (with the TOTP
  or backup-code step) and with Visma Connect; the temporary-password change; MFA
  enrolment and re-enrolment; the step-up prompt for high-risk operations (TOTP,
  password re-entry through `/verify-password`, or the Visma Connect round trip
  through `data.reauthorizationUrl`); `/forgot-password`; `/reset-password`; and
  `/accept-invitation`. The two link pages strip the URL fragment after reading it,
  send `Referrer-Policy: no-referrer`, load no third-party script, never submit
  without a user action and show a factor field on `AUTH_STEP_UP_REQUIRED` (`043`
  Q32, `044` D14 and Q26).
- **The catalog table** per blueprint: columns from the blueprint schema, type-aware
  and sanitized cell rendering, keyset pagination, and sorting by identifier, title
  or update time, with the sort and cursor in the URL.
- **The entity page** with a Details tab (spec and status properties, sanitized
  markdown and URL values) and a Related tab (forward and backward, spec and status
  scopes), and entity deletion with the step-up prompt (Resolved decision Q12).
- **Minimal search** (Q4): a `Ctrl`/`Cmd`+`K` dialog and a `/search` page over a new,
  small server API.
- **Backend additions.**
  - `search.entities` (`GET /v1/search/entities`): cross-blueprint search of entities
    by identifier or title, by prefix and by `pg_trgm` trigram similarity, narrowed by
    the same Cerbos `list` plan that `entities.list` uses, capped and limit-checked
    before any database work.
  - `entities.list` gains `sort` (`identifier`, `title`, `updatedAt`) and `order`
    (`asc`, `desc`), with a keyset cursor bound to the sort.
  - Migration `0015_catalog_entity_search`: the `pg_trgm` extension, two trigram
    indexes and two sort indexes. ⛔ Checkpoint 3.
  - `GET /v1/me`, the shell's view of the caller's own session: display name, active
    organization, role, sign-in method, MFA state and which gate (temporary password,
    MFA enrolment) applies. It never reads a tenant from input.
  - The Visma Connect re-authorization callback redirects to a fixed page of the app
    instead of answering an empty JSON body, when the web app is served.
- **Tests.** Component tests with Vitest, Testing Library and jsdom, and a Playwright
  end-to-end suite with axe-core accessibility checks (WCAG 2.2 A and AA) against the
  real API, PostgreSQL 18, Cerbos and the local OIDC stub, in a new CI job (Q7). The
  TDD path guard learns Playwright specs; that hook change needs the human's attention
  (task 2.6).
- **No browser telemetry** (Q6). The telemetry contract is server-side only: the new
  search span, the sort attributes of `catalog.entity.list`, the `me` span and the
  path rule for SPA routes.

Out of scope: page layouts, saved views, branding, the announcement banner, the icon
library, enum colors and their storage (`047-catalog-ui-customization`); the filter
language, full-text search, admin-chosen search indexing and the "My Teams" filters
(`005-search-and-query`); entity and blueprint create and edit forms and the JSON
Schema form generator (Q12); the Builder mode (`project.md` §5); browser RUM and CSP
violation reports (`016-observability-dogfood`); the Azure infrastructure and the
first deployment (`046-azure-deployment-and-first-release`); the org switcher (`042`);
a profile locale field (Q10).

## Capabilities

### New Capabilities

- `catalog-ui-core`: the browser application over the catalog and identity APIs,
  served from the API's own origin under a strict CSP, with every authentication page,
  the catalog table, the entity page and minimal search, plus the two small server
  surfaces the shell needs (`GET /v1/me` and the re-authorization redirect).

### Modified Capabilities

- `catalog-core`: "Entity read, list and delete" gains sorting by meta fields with a
  sort-bound keyset cursor, and a new requirement adds cross-blueprint entity search.

## Impact

- **New code**: `apps/web` (the whole SPA, its `CLAUDE.md`, `vite.config.ts`,
  `playwright.config.ts` and `e2e/`); in `packages/catalog`, the browser-safe contract
  module `src/api/contract-definition.ts` (exported as `@tayzu/catalog/contract`), the
  search domain, service and repository code, the sort-bound cursor and the new
  telemetry names; in `apps/api`, the static and SPA routes, the CSP and header
  configuration, `GET /v1/me`, the callback redirect and the `WEB_DIST_DIR` setting;
  `scripts/ci/e2e.sh`.
- **Edits to shared tooling**: `tsconfig.base.json` is unchanged and `apps/web` overrides
  it (DOM lib, JSX); `eslint.config.js` covers `.tsx`; `vitest.shared.ts` gains a web
  project with jsdom; `turbo.json` gains build outputs and an `e2e` task;
  `.github/workflows/ci.yml` gains an `e2e` job; `scripts/ci/local.sh` gains the web
  build and the e2e step; `scripts/ci/dast.sh` serves the built SPA;
  `.claude/hooks/tdd-path-guard.sh` accepts Playwright specs (human attention).
- **Database**: one migration, `0015_catalog_entity_search` (the `pg_trgm` extension
  and four indexes on `catalog_entity`). ⛔ **Checkpoint 3.** No new role and no grant.
- **Cerbos**: no policy change. Search reuses the `catalog_entity` `list` plan (D5).
  A change found necessary during implementation stops at Checkpoint 3.
- **Dependencies**: many, all named in `design.md` D3 with their licenses; runtime
  libraries are `dependencies` of `@tayzu/web` so that `pnpm audit --prod` covers what
  ships in the bundle. One new server dependency, `@fastify/static`.
- **Security**: pre-assessed against SSA SEC01-SEC16 by the `vcdm-ssa-validator` agent
  as task 1.1, before Checkpoint 1. New surface: the HTML pages and static assets on
  the public ingress, two new authenticated routes, and the browser itself.
- **Docs**: ADR-0004 (TanStack Query + Zustand) and ADR-0007 (shadcn/ui) as backfills,
  ADR-0025 (same-origin web hosting) and ADR-0026 (strict CSP); updates to
  `docs/architecture/system-diagram.md`, `docs/security/attack-surfaces.md`,
  `docs/security/dependencies.md`, `docs/security/crypto-inventory.md`,
  `docs/catalog/catalog-core.md`, `docs/catalog/auth-and-rbac.md`, and a new
  `docs/catalog/catalog-ui.md`.
- **Roadmap**: `openspec/project.md` §23 is amended in this proposal (decision D13):
  the reduced `003` row, the new `046` and `047` rows and the execution order
  `002 -> 043 -> 044 -> 045 -> 003 -> 046`, with `047` later.
