# Tasks: 003-catalog-ui-core

**How to execute these tasks (Agentic TDD).** Every task below, except the
tasks marked _(setup)_, is **one self-contained red-green-refactor cycle**:

1. **Red.** Write only the test named in the task's _Verify_ clause. Run it
   and see it **fail for the expected reason**: a missing behavior, not a
   typo or a missing import. With the `test-writer`/`implementer` split, this
   step belongs to `test-writer`.
2. **Green.** Write the minimum production code that makes the test pass.
   Do not change the test.
3. **Refactor.** Clean up with every test green. Run
   `pnpm --filter <pkg> test`, `pnpm lint` and `pnpm typecheck`.
4. Tick the box only when all three steps are done, and commit with the task
   number (for example `feat(web): 7.3 catalog table keyset paging`).

A task marked **(Checkpoint 3)** adds or changes a database migration or a
Cerbos policy: stop before it and present the SQL or the policy, with its
`cerbos compile` output, for the human's separate approval (root `CLAUDE.md`).
This change has one migration (task 3.1) and no Cerbos policy change (design
D5); a policy change found necessary during implementation is asked in chat
first and stops at Checkpoint 3 before any file under `policies/` is written.

Tasks follow the Resolved decisions in `design.md`: Q1 to Q11, Q12 to Q26 (the
fifteen open questions OQ1 to OQ15 of the first draft), both answered by the human in
chat on 2026-11-18, and Q27 to Q43 (the questions of task 1.1), answered on 2026-11-18
and 2026-11-19. There are no open questions; a new one is asked in chat and becomes a
row from Q44 on. A task numbered with a letter (2.1b, 3.11) was added by task 1.1, so
that no earlier task number moves.

Scenario names in quotes refer to `specs/catalog-ui-core/spec.md` or
`specs/catalog-core/spec.md`. Server tests live next to the code as
`*.test.ts` and `*.int.test.ts` (PostgreSQL 18 through `DATABASE_URL` and a
running Cerbos container); `apps/api` HTTP tests are `*.http.int.test.ts`.
Web component tests are `apps/web/src/**/*.test.tsx` (or `.test.ts`) under
jsdom. E2E specs are `apps/web/e2e/*.spec.ts`, run by `pnpm e2e` against the
stack of `scripts/ci/e2e.sh`.

## 1. Pre-assessment and coordination

- [x] 1.1 _(setup)_ Run the `vcdm-ssa-validator` pre-assessment (Mode A) of this
      change's proposal, specs, design and tasks against SEC01-SEC16, and a drift-check
      of the files the design names against `master`: `apps/api/src/server.ts`
      (step-up interceptor, CSRF plugin, the Q74 hook, helmet, `no-store`, CORS, the
      re-authorization callback, the `/v1/*` catch-all), `public-routes.ts`,
      `telemetry.ts` (route templates), `config.ts`,
      `packages/catalog/src/api/contract.ts`, `service/entities.ts` and
      `persistence/entities-repository.ts`, `domain/pagination.ts` and
      `domain/limits.ts`, `packages/auth/src/http/allowed-routes.ts`,
      `context-resolver.ts`, the temporary-password and re-enrolment markers, the accept
      and reset routes and link builders, `eslint.config.js`, `vitest.shared.ts`,
      `turbo.json`, `.claude/hooks/tdd-path-guard.sh`, `.github/workflows/ci.yml`,
      `scripts/ci/local.sh`, `scripts/ci/dast.sh` and the migrations journal. Ask every
      scope or design conflict or new question the two runs find in chat, with 2 to 4
      options and a recommendation, and record each answer as a Resolved decision; fix
      mechanical drift in place in the Context of `design.md`. **The run of
      2026-11-18/19 is recorded** in the Context of `design.md`: two blocking gaps (B1
      and B2, SEC16), the non-blocking gaps folded into the design and these tasks, the
      mechanical drift corrected, and seventeen questions answered as Q27 to Q43;
      Checkpoint 1 stands per Q27. At implementation time it is repeated as a last
      drift-check against `master`, adjusting import paths, line references and
      attribute names only, with no scope change; a new question becomes a row from
      Q44 on. Verify: the report is attached to the PR with zero open blocking gaps or
      an explicit deferral recorded, every question it raised has a Resolved decision
      row, and a short note in the PR description states what was adjusted.

## 2. Workspace and tooling

- [x] 2.1 _(setup)_ Scaffold `apps/web` (`@tayzu/web`, private, `type: module`):
      `package.json` with the scripts `dev`, `build` (`tsc -b && vite build`),
      `typecheck` (`tsc -b`), `test`, `test:unit` and `e2e`; the solution-style
      `tsconfig.json` referencing `tsconfig.app.json` (extends `tsconfig.base.json`;
      `lib` ES2023, DOM and DOM.Iterable; `types` `vite/client`; `jsx: react-jsx`) and
      `tsconfig.node.json` (the config files, `e2e/` and `src/build-check/`, `types`
      `node`); `vite.config.ts` with `@vitejs/plugin-react`, `@tailwindcss/vite`, `envDir`
      pointing at an empty directory, and the development-only CSP and proxy of design
      D10 with `server.host: '127.0.0.1'`, `strictPort: true` and `server.fs.strict` on;
      `index.html` with no inline script or style and the `tayzu-style-nonce` meta
      placeholder; `public/theme-init.js`; `src/main.tsx` rendering an empty root; the
      shadcn/ui `components.json` and the first copied components (`button`, `input`,
      `label`, `dialog`, `dropdown-menu`, `tabs`, `table`, `tooltip`, `command`,
      `alert`) through `npx shadcn@4.23.0`; and `apps/web/CLAUDE.md` with the package
      rules of design D1, including the TDD ownership of the test fixtures. Add the
      runtime and build dependencies of design D3 at exact versions, re-checking each
      against the 14-day rule of Q43 (Vite: the latest 8.3.x published before the cutoff,
      with no open `server.fs` advisory; `@hookform/resolvers`: the latest major that
      supports Zod 4 and is at least 14 days old), and check each peer range (React 19,
      Vite 8, TypeScript 6), stopping to ask if one does not hold. Raise the root
      `engines.node` to `>=22.22.2` (jsdom 30.1.3). Verify: `pnpm install` succeeds with
      no ignored build script left unexplained, `pnpm --filter @tayzu/web build` writes
      `apps/web/dist/index.html` and hashed files under `dist/assets/`, `pnpm typecheck`
      covers both web projects, and `pnpm --filter @tayzu/web dev` listens on
      `127.0.0.1` only.
- [x] 2.1b _(setup)_ Early ZAP baseline over the build (design D10, Q42): serve
      `apps/web/dist` on `127.0.0.1` (`vite preview` with the production CSP and headers
      of design D10 set as preview headers), run the pinned ZAP image with
      `.zap/rules.tsv`, and ask the human in chat about every alert actually raised
      beyond 10109 (10027 and 10096 are likely), each with options and a recommendation;
      record the answers as Resolved decisions from Q44 on before task 4.7. Q22 stands for
      10109. Verify: the alert list and the answers are recorded in `design.md` and
      attached to the PR.
- [x] 2.2 _(setup)_ Review every package added by 2.1, 2.3, 2.4 and 10.1 and
      `@fastify/static` (design D3) in `docs/security/dependencies.md`: license, install
      scripts and `allowBuilds` (an entry only if `pnpm install` reports an ignored build
      script, with its reason), the transitive packages (notably the `unified` and
      `remark` family), the SBOM entry and `pnpm audit --prod --audit-level=high`, plus a
      non-blocking `pnpm audit --audit-level=critical` over every dependency, which covers
      the build chain. Review the shadcn CLI output: re-pin every dependency it added to
      the exact version of design D3, check that the lockfile diff adds only packages
      design D3 names, and record the CLI version (4.23.0) and the registry it read.
      Confirm `pnpm why playwright-core` shows only 1.63.0 and `pnpm why get-nonce` one
      copy. Record the MPL-2.0 license of `@axe-core/playwright` and of `axe-core` (also
      pulled in by `eslint-plugin-jsx-a11y`) as test-only and lint-only and extend the
      allowlist note (Resolved decisions Q26 and Q40). Add to `.github/dependabot.yml` a
      14-day `cooldown` for npm and an `ignore` for `@playwright/test` and
      `playwright-core` (Q43). Verify: `pnpm lint` passes, every package of design D3 has
      a row with its license, the SBOM of `scripts/ci/syft.sh` lists them, the
      production audit reports nothing at high or above, and
      `apps/api/src/dependabot-config.test.ts` (extended) asserts the cooldown and the
      ignore.
- [x] 2.3 _(setup)_ ESLint (design D2): the root glob covers `.tsx`, and the
      test-file override at `eslint.config.js:154` gains `*.test.tsx`; a block for
      `apps/web/**` adds `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y`,
      `no-console: error`, `no-restricted-syntax` entries banning the
      `dangerouslySetInnerHTML` attribute, `document.cookie`, `eval`, `new Function`,
      `document.write` and assignments to `innerHTML` or `outerHTML`, re-spreading the
      `sql.raw` and actor-type selectors because the block replaces the rule's array, and
      `no-restricted-imports` banning `@tayzu/api`, `@tayzu/auth`, `@tayzu/db`,
      `@tayzu/authz` and every `@tayzu/catalog` path but `@tayzu/catalog/contract`. The
      root `package.json` gains a `pnpm.peerDependencyRules.allowedVersions` entry for
      `eslint-plugin-jsx-a11y` 6.10.2 on ESLint 10, with its reason (Q40). Verify:
      `pnpm lint` passes, and `apps/api/src/web-lint-rules.test.ts` runs ESLint's API
      over fixture sources under `apps/web/` and proves that a jsx-a11y rule, a
      react-hooks rule, `no-console`, each restricted-syntax selector (`sql.raw` and the
      actor-type ban included) and the restricted imports report, and that a
      `*.test.tsx` file gets the test override.
- [x] 2.4 _(setup)_ Vitest: `vitest.shared.ts` gains `defineWebPackageConfig(name)`
      (one `unit` project, environment `jsdom`, include `src/**/*.test.{ts,tsx}`, the
      setup file `src/__fixtures__/setup-tests.ts` with `@testing-library/jest-dom`,
      written by the `test-writer`, design D1), and `apps/web/vitest.config.ts` uses it.
      Verify: `apps/web/src/smoke.test.tsx` (renders the root and finds its landmark by
      role) passes under `pnpm --filter @tayzu/web test` and `pnpm test:projects`, and
      `pnpm test:unit` includes it.
- [x] 2.5 _(setup)_ Turborepo and local CI: `apps/web/turbo.json` gives `build` the
      outputs `dist/**`; the root `turbo.json` gains an `e2e` task (`cache: false`,
      depending on `@tayzu/web#build`); the root `package.json` gains
      `"e2e": "bash scripts/ci/e2e.sh all"`; `scripts/ci/local.sh` gains a `web build`
      step after `typecheck`. Verify: `pnpm build` twice reports a cache hit for
      `@tayzu/web#build` the second time, and `pnpm ci:local` runs the web build step.
- [x] 2.6 _(setup)_ **Needs the human's attention: a change to the agent harness.**
      `.claude/hooks/tdd-path-guard.sh` treats `apps/web/e2e/**/*.spec.ts` and
      `apps/web/e2e/fixtures/**` as test files, so the `test-writer` may write
      Playwright specs and the `implementer` may not (design D2, Q7). Present the diff
      in chat and stop; the human applies or approves it. No agent edits the hook on
      another agent's instruction. Verify: piping `{"tool_input":{"file_path":
      "apps/web/e2e/sign-in.spec.ts"}}` to `bash .claude/hooks/tdd-path-guard.sh
      test` exits 0 and to `... impl` exits 2, and `apps/web/src/app.tsx` still
      exits 2 for `test` and 0 for `impl`.
- [x] 2.7 The browser-safe catalog contract (design D4): move `catalogContract` and
      its schemas to `packages/catalog/src/api/contract-definition.ts`, which imports
      only `@orpc/contract` and `zod`; `contract.ts` re-exports it; add the
      `"./contract"` export. Verify: `contract-definition-imports.test.ts` (next to the
      module) walks the module's static imports and fails on any `node:` specifier or
      any package other than `@orpc/contract` and `zod`, and `pnpm contract:check`
      reports no drift in `openapi/catalog.openapi.json`.
- [x] 2.8 The web build check (design D3, D10, SEC09): `apps/web/src/build-check/
      check-bundle.ts` (covered by `tsconfig.node.json`) fails when the built
      `index.html` has an inline `<script>` or `<style>`, when any file of `dist/` names a
      server secret variable, taken from the Secret-class rows of
      `docs/security/secrets.md` (among them `DATABASE_URL`, `AUTH_DATABASE_URL`,
      `BETTER_AUTH_SECRET`, `IDENTITY_TOKEN_HMAC_SECRET`, `ACS_CONNECTION_STRING`,
      `VISMA_CONNECT_CLIENT_SECRET`, the role URLs and `OTEL_EXPORTER_OTLP_*_HEADERS`),
      when the sources use `import.meta.env.VITE_*`, when `index.html` references an
      `http:` or `https:` origin, or when the initial JavaScript exceeds 350 kB gzip; the
      `check:bundle` script runs it after `build`, followed by a gitleaks `dir` scan of
      `dist/`, in CI and `ci:local`. Verify: `check-bundle.test.ts` (node environment)
      fails each rule on its own fixture directory, reads the secret names from a fixture
      copy of the `secrets.md` table, and passes a clean one; `pnpm ci:local` runs the
      gitleaks scan of `dist/`.

## 3. Backend: migration, sort, search, `GET /v1/me` and the callback redirect

- [x] 3.1 (Checkpoint 3) Migration `0015_catalog_entity_search` (design D7, Q41): the
      two GIN trigram indexes on `catalog_entity.title` and `catalog_entity.identifier`
      and the two btree sort indexes `(tenant_id, blueprint_id, title, identifier)` and
      `(tenant_id, blueprint_id, updated_at, identifier)`, declared on the Drizzle table in
      `packages/catalog/src/persistence/schema.ts`; `drizzle-kit generate` writes
      `packages/db/migrations/0015_catalog_entity_search.sql` (the journal ends at idx
      14), and `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` is prepended
      to that one file before Checkpoint 3; with
      `packages/db/migrations/down/0015_catalog_entity_search.down.sql`,
      `meta/0015_snapshot.json` and its `_journal.json` entry. Verify:
      `entity-search-migration.int.test.ts` covers the extension present, the four index
      definitions, the trigram index used for `title % $1` and for `identifier ILIKE $1`
      (`EXPLAIN` with sequential scans off), and the down script removing them;
      `schema.int.test.ts` passes with any index list it asserts updated. ⛔ **Stop for
      Checkpoint 3 approval of the SQL before continuing.**
- [x] 3.2 The sort-bound cursor (design D6, Q37): `encodeSortCursor` and
      `decodeSortCursor` in `packages/catalog/src/domain/pagination.ts` for
      `{ v: 2, s, o, id }` (the last row's UUID, no sort value, no tenant), checking the
      512-character limit first, rejecting a cursor of another sort or order and a
      non-UUID `id`, and accepting a version-1 cursor for the default sort only;
      `blueprints.list` keeps the version-1 functions. Verify: `pagination-sort.test.ts`
      covers the round trip for each sort, the mismatch and malformed cases failing with
      `CATALOG_VALIDATION_FAILED` on `/cursor`, the length check before decoding, unsafe
      keys in the JSON rejected, the version-1 cursor, and a cursor for a 256-character
      title and identifier staying under 512 characters.
- [x] 3.3 The contract (design D5, D6): `entities.list` gains the query enums `sort`
      (`identifier`, `title`, `updatedAt`) and `order` (`asc`, `desc`), and the new
      procedure `search.entities` (`GET /v1/search/entities`, query `q` and `limit`,
      output `{ items: [{ blueprint, identifier, title, match }] }`), both in
      `contract-definition.ts`; regenerate `openapi/catalog.openapi.json`. Verify:
      `routes.test.ts` asserts both routes, the query parameters and their enums in
      the generated document, that neither declares `tenantId` or `actor`, and that
      `search.entities` is not `x-tayzu-risk: high`; `pnpm contract:check` passes.
- [x] 3.4 Sorting `entities.list` in the service and the repository (design D6, Q37):
      the order by the sort key then `identifier` in the same direction; the cursor's
      anchor row read inside the tenant transaction under the same `tenant_id`,
      blueprint and Cerbos plan filter as the page, its sort key and identifier used as
      the row-comparison bound; an anchor that is missing, in another blueprint or
      tenant, or not readable answers `CATALOG_VALIDATION_FAILED` on `/cursor`. Verify:
      `entities-list-sort.int.test.ts` covers "List sorted by title descending pages
      without gaps", "Sort by update time" (including two rows in the same millisecond,
      ordered by identifier), "A cursor of another sort is rejected", "Long titles and
      identifiers still page", "A cursor anchored on an unreadable entity is rejected"
      (and one of another tenant, the same answer), "Sorting does not widen visibility",
      and the default order unchanged.
- [x] 3.5 The search query domain (design D5): `domain/search-query.ts` trims and
      NFC-normalizes `q`, checks 2 to 100 characters and no control character, checks
      `limit` against `CatalogLimits.search` (new: `minQueryLength`, `maxQueryLength`,
      `defaultLimit`, `maxLimit`, overridable like the others), and builds the escaped
      prefix pattern. Verify: `search-query.test.ts` covers each bound, the
      normalization, the escaping of `%`, `_` and `\`, the error codes and issue
      paths, and a limit override.
- [x] 3.6 The search service and repository (design D5):
      `defineCatalogOperation<SearchEntitiesInput, SearchEntitiesOutput>({ name:
      'entity.search', pool, authz, authorization: PLAN_AUTHORIZED, handler })` with the
      limits of 3.5 before the transaction, the `catalog_entity` `list` plan folded into one parameterized
      query, the ranking and the tie order, and a denied plan returning no items.
      Verify: `entities-search.int.test.ts` covers "Identifier prefix across
      blueprints", "Title similarity finds a typo", "Wildcards match literally",
      "Search shows only what the caller may list", "Another tenant's entity is never
      found" and "Limits are checked before the database" (no database span), and the
      `_user` and `_team` entities included under the plan (Q19).
- [x] 3.7 Telemetry of search and sort (Observability contract): the span
      `catalog.entity.search` with `tayzu.catalog.search.query_length`,
      `tayzu.catalog.page.size` and `tayzu.catalog.result.count`; `catalog.entity.list`
      with `tayzu.catalog.sort.field` and `tayzu.catalog.sort.order`; the operation
      value `entity.search` on the two metrics; declared in
      `packages/catalog/src/telemetry/contract.ts` and listed in the `## Telemetry`
      section of `docs/catalog/catalog-core.md`. Verify: the catalog
      `otel-smoke-check.int.test.ts` runs `entity.search` on success and per error
      class and asserts the new attributes, its marker-leak case covers "The query text
      never reaches telemetry", and `docs-telemetry.test.ts` passes.
- [x] 3.8 Search and sort over HTTP: `GET /v1/search/entities` and the `sort` and
      `order` query of `GET /v1/blueprints/{blueprint}/entities` through the merged
      router, with the authenticated rate limit, the same answers for a `user` session
      and an `integration` token with the same grants, a cross-tenant search returning
      nothing, and the exported HTTP span carrying no `q`. Verify:
      `search.http.int.test.ts` covers these cases, and `actor-parity.int.test.ts` and
      `cross-tenant.http.int.test.ts` gain the search rows.
- [x] 3.9 `GET /v1/me` (design D8): the new `@tayzu/auth` export
      `resolveSessionState(headers)`, which runs `resolveContext`'s checks in its order
      (the markers, then the membership, the open tenant and the `_user` state) through
      the same helpers, recording a marker as a gate instead of rejecting, reading the
      stored role (a comma-separated list allowed) as the highest of `owner`, `admin`
      and `member`, and applying the admin-without-factor gate to the folded role of
      `toCerbosRole`; and a plain Fastify route before the `/v1/*` catch-all, with the
      authenticated rate-limit bucket, that reads the session only; and the span
      `identity.session.me` with `tayzu.identity.session.gate` and the conditional
      `tayzu.tenant.id`, declared in `packages/auth/src/telemetry/identity-contract.ts`
      and in `packages/auth/src/__fixtures__/identity-contract-expected.ts`. Verify:
      `packages/auth/src/session-state.int.test.ts` covers the check order (a gated
      session of a banned user, a disabled `_user` or a tenant pending deletion is
      rejected, not gated), a comma-separated role, and an owner without a factor gated;
      `apps/api/src/me-route.http.int.test.ts` covers "A member reads their session", "A
      temporary password is a gate" (API side), "An admin without MFA must enrol" (API
      side), the expired temporary password, the re-enrolment marker, a failed marker
      lookup failing closed, "No session looks like any other missing context" for no
      session, a banned user, a disabled `_user`, a tenant pending deletion and no active
      organization, "A machine token is not a session", `signInMethod` for a local and a
      Visma Connect session, `Cache-Control: no-store`, and a `tenantId` in the query
      ignored; the `apps/api` `otel-smoke-check.int.test.ts` asserts the span and that no
      organization name, user name or email reaches it; `route-auth-allowlist.int.test.ts`
      stays green.
- [x] 3.10 The re-authorization redirect (design D11): with `WEB_DIST_DIR` set, `GET`
      and `POST /v1/auth/visma-connect/reauthorize/callback` answer `303` to
      `/step-up/complete` on success, `/step-up/complete?result=failed` on failure, and
      `/step-up/complete?result=rate_limited` with `Retry-After` when the callback's
      limiter refuses (today a JSON `429`, `server.ts:869-880`); without it, every answer
      is unchanged. Verify: `reauthorize-redirect.http.int.test.ts` covers "The callback
      redirect is fixed" (success, failure, rate limit, and a request carrying a
      `redirect`, `returnTo` or `Host` value that is ignored) and the unchanged answers
      without the web app, against the OIDC stub; `step-up-sso-http.int.test.ts` and
      `reauthorization-limits.int.test.ts` stay green.
- [x] 3.11 Visma Connect step-up telemetry (design D11, Log events; Q27 B2, Q29): on
      a successful `complete`, `sso/reauthorization.ts` emits
      `auth.security.step_up_succeeded` with `tayzu.auth.method` `visma_connect` and the
      tenant and actor of the session the state is bound to (`emitStepUpSucceeded` in
      `auth.ts:346-361` takes the method instead of hard-coding `local`); a failed
      callback emits the new `auth.security.reauthorization_failed` (WARN,
      `tayzu.auth.reauthorization.reason` `invalid_state` or `exchange_failed`, no
      tenant), declared in `packages/auth/src/telemetry/contract.ts` and recorded in
      `packages/auth/src/__fixtures__/identity-contract-expected.ts`. Verify:
      `packages/auth/src/telemetry/contract.test.ts` covers the new event and the
      `visma_connect` value; the `apps/api` `otel-smoke-check.int.test.ts` covers "A Visma
      Connect step-up is logged" against the OIDC stub (success with the bound tenant and
      actor, an unknown state and a failed token exchange each with its reason), with a
      marker check that no code, state, token or claim reaches any attribute; the local
      step-up still emits `local`.

## 4. Static serving, CSP and headers

- [x] 4.1 The `WEB_DIST_DIR` setting (design D9, Q21): optional; when set, it must be
      an absolute path to a readable directory containing `index.html`, or startup
      fails with an error that names the variable and not its value. Verify:
      `config.test.ts` covers unset, valid, relative, missing directory and missing
      `index.html`, and that no error message contains the value.
- [x] 4.2 The asset route (design D9): `@fastify/static` on `<WEB_DIST_DIR>/assets/`
      at `/assets/` with `wildcard: false`, `dotfiles: 'deny'`, `index: false`,
      `Cache-Control: public, max-age=31536000, immutable`, and the root build files
      (`theme-init.js`, the favicon) from the build root with `no-cache`. Verify:
      `web-static.http.int.test.ts`, against a fixture build in
      `apps/api/src/__fixtures__/web-dist/`, covers a hashed asset with its type and its
      `immutable` header not replaced by the `onSend` `no-store` hook, a root build file
      with `no-cache`, a missing asset as a 404, and "A traversal attempt reaches no
      file".
- [x] 4.3 The SPA fallback (design D9, Q28, Q39): the shared predicate
      `isSpaPath(pathname)` (true for a path not under `/v1`, `/api` or `/assets`, not
      `/healthz` and not a root build file); `GET` and `HEAD` of such a path answer
      `index.html` with `no-store`, the file read once at startup; the fallback's own
      IP bucket (`@fastify/rate-limit`, keyed by `request.ip`, never logged);
      `PUBLIC_ROUTE_ALLOWLIST` gains a reviewed prefix entry for `/assets/` and exact
      entries for the fallback and each root build file, each with its reason. Verify:
      `spa-paths.test.ts` covers the predicate on `/`, `/catalog/_user/alice@example.com`,
      `/catalog/service/v1.2`, `/v1/x`, `/api/x`, `/apix`, `/assets/x.js`, `/healthz` and
      the root build files; `spa-fallback.http.int.test.ts` covers "An app path answers
      the app", "A user page with an email in its path answers the app", "API and auth
      paths are unchanged", "No build directory, no app", a `%`, `//` or backslash path
      still refused by the Q74 hook, the bucket answering `429` past its limit, and
      `index.html` read once (a change on disk after startup is not served);
      `route-auth-allowlist.int.test.ts` gains a second harness app started with the
      fixture `web-dist` and `WEB_DIST_DIR`, in which the new entries are registered
      routes, and the first app still proves every other route closed.
- [x] 4.4 The CSP and security headers on every response, with or without
      `WEB_DIST_DIR` (design D10): helmet with `contentSecurityPolicy.useDefaults: false`
      and the exact directive list, `xFrameOptions: { action: 'deny' }`,
      `Cross-Origin-Embedder-Policy: require-corp` and the `Permissions-Policy` without
      `interest-cohort`, with `Referrer-Policy: no-referrer`, COOP and CORP asserted.
      Verify: `headers.int.test.ts` covers "The app page carries the policy" (without the
      nonce part) and "API responses carry the policy too" on an HTML page, a `/v1` JSON
      answer, an `/api/auth` answer, an asset and a 404, with and without `WEB_DIST_DIR`,
      and HSTS and `no-store` unchanged; its two assertions that this decision changes,
      `X-Frame-Options: SAMEORIGIN` (lines 83-84) and the absence of a CSP (lines
      103-106), are rewritten in the red step, not loosened.
- [x] 4.5 The style nonce (design D10, Q15): Tayzu's own `onRequest` hook draws a
      fresh 128-bit nonce from `crypto.randomBytes(16)` (base64) per request, the
      `style-src` directive function reads it, and the fallback substitutes it into the
      `tayzu-style-nonce` meta of the in-memory `index.html`; helmet's `enableCSPNonces`
      is not used. Verify: `csp-nonce.http.int.test.ts` covers the header and the meta
      holding the same value, two responses holding different values, the value being 16
      bytes in base64, `script-src` holding no nonce, and no nonce placeholder left in the
      served page.
- [x] 4.6 App paths in exported spans (Observability contract; Q27 B1): the
      route-template matcher of `apps/api/src/telemetry.ts` exports every HTTP server span
      whose path satisfies `isSpaPath` (task 4.3) as `/{spa}`, at any status and for any
      method, with or without `WEB_DIST_DIR`, and keeps asset paths. Verify:
      `telemetry-paths.http.int.test.ts` covers "App paths are exported as one template"
      for `/catalog/_user/someone`, `/accept-invitation` and `/reset-password`, "Refused
      and non-GET app paths are exported as the template too" for `GET` and
      `POST /catalog/_user/alice@example.com` and `/catalog/_user/a%40b.com` (the Q74
      404), `/catalog/service/payments.api`, the same paths with the app not served, and
      an asset path kept as is; the marker check finds no email in any exported span.
- [x] 4.7 DAST over the app (design D10, Q22, Q42): `scripts/ci/dast.sh up` builds
      `@tayzu/web` and starts the API with `WEB_DIST_DIR`; `.zap/rules.tsv` sets 10109
      to `INFO` with its note, plus only what the human decided after task 2.1b; every
      other new alert is fixed. Verify: `dast-script.test.ts` asserts the build step and
      the variable, and `bash scripts/ci/dast.sh all` passes locally with the app served
      (output attached to the PR).

## 5. Web shell, routing, i18n and theme

- [x] 5.1 The oRPC client (design D4, Q36): `src/api/client.ts` with `OpenAPILink` over
      `@tayzu/catalog/contract`, `SimpleCsrfProtectionLinkPlugin`, the page origin and
      the custom path-parameter serializer that leaves `@`, `:` and `=` unencoded.
      Verify: `client.test.ts`, with a fake `fetch`, covers "A mutating call carries the
      CSRF header and no tenant" for `entities.delete`, the REST path and query of
      `entities.list` with `sort` and `cursor`, an entity `team@example.com:prod=1`
      requested with no `%` in its path, `credentials` left at `same-origin`, and no
      `Authorization` header.
- [x] 5.2 The error model (design D4): `src/api/errors.ts` maps oRPC and plain-route
      failures to the closed set of kinds, keeping `reauthorizationUrl`, issue paths
      (catalog issues are `{ path, message }`), the reference-violation counts and
      `Retry-After`, and never the message, except a password-policy rule name on
      `/newPassword` (and `/password` on the accept route), mapped to localized text.
      Verify: `errors.test.ts` covers each kind, a validation answer rendered by path
      only, a password-policy rule mapped, an unknown rule shown as the generic message, a
      network failure, an unknown code mapped to `server`, and "An internal error shows no
      server text" at the model level.
- [x] 5.3 The auth client (design D4, Q24): `src/api/auth-client.ts` for the
      allowlisted Better Auth routes the pages use, the accept and reset routes and
      `GET /v1/me`, each response parsed by a Zod schema, each non-`GET` with the CSRF
      header and `application/json`. Verify: `auth-client.test.ts` covers every call's
      method, path, headers and body shape, unknown response fields dropped, and a
      malformed response mapped to `server`.
- [x] 5.4 Untrusted input and return paths (design D15): `src/lib/untrusted.ts`
      parses into null-prototype objects, rejects `__proto__`, `constructor` and
      `prototype` at every depth and checks lengths first; `src/lib/return-path.ts`
      accepts only an in-app path of the route tree. Verify: `untrusted.test.ts`
      covers the unsafe keys at depth and the length check, and `return-path.test.ts`
      covers "An external return path is ignored" for `//host`, `/\host`,
      `https://host`, `javascript:`, control characters and unknown routes.
- [x] 5.5 i18n and formatting (design D12, Q10): i18next with the `common`, `auth`,
      `catalog` and `search` namespaces in `en` and `es`, loaded per namespace; the
      locale from storage, then `navigator.language`, then `en`; `<html lang>`; the
      localized-text helper with `en` fallback; dates and numbers through `Intl` in the
      browser time zone. Verify: `i18n.test.ts` covers "Spanish browser, no choice
      stored", `fr-FR` falling back to `en`, a stored choice winning, storage that
      throws, the `{ en, es? }` fallback, a date in a fixed time zone, and key parity
      between `en` and `es` for every namespace.
- [x] 5.6 The theme (design D12): the Zustand store (`system`, `light`, `dark`), the
      toggle, `localStorage` `tayzu.theme` behind `try`/`catch`, and
      `public/theme-init.js` applying the class before first paint. Verify:
      `theme.test.tsx` covers the three choices, the system preference, the stored
      value read by `theme-init.js` (evaluated in jsdom) and "Storage unavailable".
- [x] 5.7 The router (design D12, Q36): the TanStack Router code-based tree with every
      route of D12, `pathParamsAllowedCharacters: ['@', ':', '=']`, Zod-validated search
      params (`sort`, `order`, `pageSize`, `cursor`, `tab`, `q`, `returnTo`) falling back
      to defaults, and the not-found page. Verify: `router.test.tsx` covers each route
      rendering its page, a link to `team@example.com:prod=1` holding no `%`, invalid
      search params replaced by defaults, an over-long `q` or `cursor` rejected before
      use, and an unknown path showing the not-found page.
- [x] 5.8 The session gate (design D12, D8): the root loader over `GET /v1/me`, the
      redirect to `/sign-in?returnTo=` on `401`, the redirect of a gated session to its
      page for every route but sign-out, and the public pages rendering without a
      session. Verify: `session-gate.test.tsx` covers "A temporary password is a gate",
      "An admin without MFA must enrol", the expired-password page, a signed-out visit
      of a protected route, and the public pages.
- [x] 5.9 The app shell (design D12): header with the search trigger, the locale
      selector, the theme toggle and the user menu (name, organization, role,
      sign-out), the blueprint sidebar with system blueprints grouped last and
      localized titles, a skip link and landmarks; sign-out clears the query cache and
      the stores. Verify: `app-shell.test.tsx` covers the sidebar from a fake
      `blueprints.list`, the user menu content, the locale switch updating the texts,
      the skip link moving focus, and sign-out posting `/api/auth/sign-out`, clearing
      the cache and navigating to `/sign-in`.
- [x] 5.10 Safe rendering (design D13, `001` T4): `src/lib/safe-link.tsx` and
      `src/lib/markdown.tsx` (raw HTML skipped, images disallowed, `http`, `https` and
      `mailto` only). Verify: `safe-render.test.tsx` covers "A dangerous URL value stays
      text" for `javascript:`, `data:`, `vbscript:` and relative values, the link
      attributes `rel="noopener noreferrer nofollow"` and `target="_blank"`, markdown
      with `<script>`, `<img onerror>`, an image and a `javascript:` link rendering no
      element that runs code or loads a resource.
- [x] 5.11 The error boundary (design D15): a generic localized message with a reload
      action, never an error message or stack, and nothing written to the console.
      Verify: `error-boundary.test.tsx` covers a throwing child rendering the generic
      message, the message and stack absent from the DOM, and a spy on `console`
      recording no call.

## 6. Authentication pages

- [ ] 6.1 Local sign-in (design D11): `/sign-in` with email and password, the
      uniform failure message, the rate-limit message from `Retry-After`, then the TOTP
      step with a switch to a backup code, and the validated `returnTo`. Verify:
      `sign-in.test.tsx` covers "Local sign-in with a second factor" (with a fake API),
      "A wrong password and an unknown email look the same", the rate-limited answer,
      the backup-code path and `autocomplete` attributes.
- [ ] 6.2 Visma Connect sign-in (design D11): the button posting
      `/api/auth/sign-in/social` and navigating only on click to an absolute `https:`
      URL, and the generic `?error=sso` message. Verify: `sign-in-sso.test.tsx` covers
      the request body, navigation to an `https:` URL, a non-`https:` or relative URL
      refused, and the error message.
- [ ] 6.3 The temporary-password change and the expired page (design D11):
      `/change-password` with `revokeOtherSessions: true` and the localized rule name
      of a policy failure, and the expired-password page with sign-out. Verify:
      `change-password.test.tsx` covers "A temporary password is changed", a policy
      failure showing only the rule name, a wrong current password, and the expired
      page.
- [ ] 6.4 MFA enrolment and re-enrolment (design D11, Q17): password re-entry,
      `/two-factor/enable`, the QR code as inline SVG and the secret as text, the
      backup codes shown once with confirmation, then `/two-factor/verify-totp`.
      Verify: `mfa-enrol.test.tsx` covers "MFA enrolment completes only with a valid
      code", the QR SVG and the secret rendered, the backup codes shown once, and the
      URI, secret and codes absent from storage, the URL and the query cache after
      leaving the page.
- [ ] 6.5 The local step-up dialog (design D11): for a session whose `signInMethod` is
      `password`, on `step_up_required`, a TOTP or backup-code field for a user with MFA
      and password re-entry through `/api/auth/verify-password` otherwise, then one retry
      of the original request. Verify: `step-up-dialog.test.tsx` covers "A local user
      verifies with TOTP" and "A user without MFA verifies with the password" against a
      fake API, a wrong code refused without a retry, exactly one retry after success, and
      a Visma Connect session never offered a code or password field.
- [ ] 6.6 The Visma Connect step-up and its completion page (design D11, Q14): for a
      session whose `signInMethod` is `visma-connect`, the "Continue with Visma Connect"
      button when the answer has a `reauthorizationUrl`, storing only the in-app path in
      `sessionStorage` and navigating on click, and a "try again in a few minutes"
      message when it has none; `/step-up/complete` reading and deleting the key,
      validating it and showing the "you are back, repeat the action" notice (never
      "verified"), the failure message or the rate-limit message. Verify:
      `step-up-sso.test.tsx` covers the stored value being only a path, navigation only on
      click, "No re-authorization is available for a Visma Connect session", the return to
      the stored path, an invalid stored path becoming `/`, `?result=failed`,
      `?result=rate_limited`, the notice wording, and the action not being repeated
      automatically.
- [ ] 6.7 `/forgot-password` (design D11, Q23): one email field, the uniform message
      for every answer but `AUTH_RATE_LIMITED`. Verify: `forgot-password.test.tsx`
      covers a `200`, a `404`-like failure and a server error all showing the same
      message, and the rate-limit message.
- [ ] 6.8 `/reset-password` (design D11, `044` D14, Q26): the fragment read and removed
      with `history.replaceState` before the first render, the values kept in memory,
      submit only on click, the factor field on `AUTH_STEP_UP_REQUIRED`, the uniform
      invalid-link message and the sign-in link on success. Verify:
      `reset-password.test.tsx` covers "The reset fragment is stripped before any
      request" (no fetch before the click), "A reset for an MFA-enrolled user asks for
      the factor", a missing fragment, the uniform `404` message, and storage left
      empty.
- [ ] 6.9 `/accept-invitation` (design D11, `043` Q32, Q20): the same fragment
      handling; signed out, the new-account path and an embedded local sign-in for an
      existing account; signed in, "Accept"; the uniform rejection message. Verify:
      `accept-invitation.test.tsx` covers "A new invitee creates their account", the
      embedded sign-in keeping the token in memory, the signed-in accept, "An invalid
      link shows the uniform message", the Visma Connect note, and no request before a
      click.
- [ ] 6.10 The page rules over HTTP (design D11): `/accept-invitation` and
      `/reset-password` are served with `Referrer-Policy: no-referrer` and a CSP that
      allows no other origin, and the served page references no other origin. Verify:
      `web-page-rules.http.int.test.ts` covers both paths with and without a fragment
      (the fragment never reaching the server), the headers, and the absence of any
      `http:` or `https:` origin in the served HTML.

## 7. Catalog table

- [ ] 7.1 Columns from the blueprint (design D13): identifier, title, the spec
      properties in schema order, the relations and `updatedAt`, with localized
      headers. Verify: `columns.test.ts` covers the order for a blueprint with
      properties, relations and a status schema, localized and fallback titles, an entity
      identifier containing `/` or made only of dots marked as not addressable, and one
      with `@`, `:` or `=` addressable (Q18, Q36).
- [ ] 7.2 Cells by type (design D13): every type and format of ADR-0008, `enum` as
      text, truncation with an accessible full value, arrays capped with a count.
      Verify: `cells.test.tsx` covers each type and format, a markdown value shown as
      its first line in plain text, an `email` value as a `mailto:` link, and a 3000
      character value truncated with its tooltip.
- [ ] 7.3 The table page with paging and sort (design D13): `entities.list` with
      `sort`, `order`, `pageSize` and `cursor` from the URL, "Next" and "Previous" with
      the in-memory cursor stack, sortable headers with `aria-sort`, and the cursor
      cleared when the sort changes. Verify: `catalog-table.test.tsx` covers "Sort by
      title and page forward" against a fake API (the request sequence and the URL),
      "Previous" returning to the first page, the page-size choice and `aria-sort`.
- [ ] 7.4 Table states (design D13): loading, empty, a denied list shown as empty,
      the not-found page for an unknown blueprint and an error message by kind.
      Verify: `catalog-table-states.test.tsx` covers each state and "Another tenant's
      blueprint is not found" (a `CATALOG_NOT_FOUND` answer).

## 8. Entity page

- [ ] 8.1 The entity page header (design D13): title, identifier, blueprint, created
      and updated time and actor, version and generation, the `details` and `related`
      tabs from the `tab` search param, and the not-found page. Verify:
      `entity-page.test.tsx` covers the header fields, the tab switch updating the URL,
      the not-found page for a missing or cross-tenant entity, "An identifier with
      reserved characters opens" at the component level, and a disabled link with its
      note for an identifier containing `/` or made only of dots.
- [ ] 8.2 The Details tab (design D13): spec properties in schema order, status
      properties with observed generation, source and time, markdown values through the
      safe renderer. Verify: `entity-details.test.tsx` covers "Status shown next to
      spec", an entity with no status, and a markdown value rendered without raw HTML.
- [ ] 8.3 The Related tab (design D13): `entities.listRelated` with the direction
      toggle, the scope select and cursor paging, each row linking to its target.
      Verify: `entity-related.test.tsx` covers "Related entities in both directions",
      the scope choice in the request, paging and an empty list.
- [ ] 8.4 Entity delete (design D13, Q12): the confirmation dialog with the
      `detachReferences` option, the reference violation with its readable referrers
      and "+N not visible", the step-up dialog of 6.5 and 6.6, and the return to the
      table after success. Verify: `entity-delete.test.tsx` covers a delete without
      references, a blocked delete showing the referrers and the count, a delete with
      `detachReferences`, and a step-up answer opening the dialog.

## 9. Search UI

- [ ] 9.1 The command dialog (design D14): `Ctrl`+`K` and `Cmd`+`K` and the header
      button, the local blueprint group, the entity group from `search.entities` after
      2 characters with a 250 ms debounce and the previous request aborted, keyboard
      navigation and "See all results". Verify: `command-search.test.tsx` covers
      "Search by identifier prefix from the keyboard" against a fake API, a 1-character
      query making no request, a stale answer never shown after a newer query, and
      `Escape` restoring focus.
- [ ] 9.2 The search page (design D14): up to 50 results for the `q` in the URL, the
      empty and error states, and the query never stored. Verify: `search-page.test.tsx`
      covers the results with their blueprint titles, an empty result, an error by
      kind, and storage left empty.

## 10. E2E and accessibility

- [ ] 10.1 _(setup)_ The e2e stack (design D16, Q38): `apps/web/playwright.config.ts`
      (Chromium only, `@playwright/test` pinned to `1.63.0` to match the preinstalled
      revision 1243 at `/opt/pw-browsers`, `PLAYWRIGHT_BROWSERS_PATH` respected, retries
      off, traces on failure, the throwaway certificate trusted by its SPKI hash and never
      `ignoreHTTPSErrors`); `scripts/ci/e2e.sh` (`up`, `test`, `down`, `all`: PostgreSQL 18
      behind verified TLS as in `dast.sh`, migrations, the running Cerbos, the OIDC stub of
      `@tayzu/auth` as Visma Connect, the API from `main.ts` with its production
      configuration, `WEB_DIST_DIR` and `MOUNT_IDENTITY_ROUTES=true`, and the test-only
      TLS reverse proxy, a `node:https` script under `scripts/ci/` with a `localhost`
      certificate from the same throwaway CA, in front of the API and the stub, then the
      seed); and the shared fixture that fails a test on a `securitypolicyviolation`
      event, a console error or a request to an unexpected origin. The seed
      `apps/web/e2e/fixtures/seed.ts` is written by the `test-writer` (design D1): two
      tenants, an admin with TOTP, a member without MFA, a temporary-password user, a
      Visma Connect user, blueprints and entities, an invitation and a reset request
      through the in-process services with the recording email sender, every credential
      random per run, and the credentials and links written to the run's state directory
      and never printed. Verify: `e2e-script.test.ts` (in `apps/api/src`, a text test
      like `dast-script.test.ts`) asserts the TLS mode of the database and of the proxy,
      the pinned images, `NODE_ENV` not `test`, and that no secret, credential or link is
      echoed; and `pnpm e2e` runs a smoke spec green over `https:`.
- [ ] 10.2 Sign-in end to end. Verify: `apps/web/e2e/sign-in.spec.ts` covers "Local
      sign-in with a second factor", the shell with the sidebar, "Spanish browser, no
      choice stored" through a browser locale of `es-AR`, the theme toggle surviving a
      reload, and sign-out.
- [ ] 10.3 Visma Connect end to end, through the OIDC stub. Verify:
      `apps/web/e2e/sso.spec.ts` covers "Visma Connect sign-in" and "A Visma Connect
      user re-authorizes" (the `form_post` callbacks, the `303` to `/step-up/complete`,
      the repeated delete succeeding).
- [ ] 10.4 The gates end to end. Verify: `apps/web/e2e/gates.spec.ts` covers "A
      temporary password is changed" and "MFA enrolment completes only with a valid
      code" (the code computed from the secret shown on the page), and an admin without
      MFA sent to enrolment.
- [ ] 10.5 Local step-up end to end. Verify: `apps/web/e2e/step-up.spec.ts` covers "A
      local user verifies with TOTP" and "A user without MFA verifies with the
      password" on entity delete.
- [ ] 10.6 The link pages end to end (the `043` and `044` page gates). Verify:
      `apps/web/e2e/links.spec.ts` covers "A new invitee creates their account" from the
      seeded link, "The reset fragment is stripped before any request" and "A reset for
      an MFA-enrolled user asks for the factor" from the seeded link, the forgot-password
      message, every request of both pages same-origin with no `Referer` header, and
      `location.hash` empty before the first request.
- [ ] 10.7 The catalog end to end. Verify: `apps/web/e2e/catalog.spec.ts` covers "Sort
      by title and page forward" on 120 seeded entities, "Related entities in both
      directions", "Status shown next to spec" and "Search by identifier prefix from the
      keyboard".
- [ ] 10.8 No CSP violation anywhere (design D10). Verify: `apps/web/e2e/csp.spec.ts`
      visits every route in both themes, opens every dialog, and covers "Using the app
      raises no policy violation"; it also records whether any runtime `<style>` element
      was inserted, which decides whether the style nonce stays (design D10).
- [ ] 10.9 Accessibility (design D16). Verify: `apps/web/e2e/a11y.spec.ts` runs
      `@axe-core/playwright` with the WCAG 2.2 A and AA tags on every route, in both
      themes and with each dialog open, covering "No accessibility violation on any
      page", and walks the main flows with the keyboard only.
- [ ] 10.10 Tenant isolation through the UI. Verify: `apps/web/e2e/isolation.spec.ts`
      covers "Another tenant's blueprint is not found", a cross-tenant entity URL showing
      the not-found page, and "Search never shows another tenant's entity".
- [ ] 10.11 _(setup)_ The CI job (design D2): `.github/workflows/ci.yml` gains `e2e`
      (checkout with `persist-credentials: false`, PostgreSQL 18 service, the pinned
      Cerbos image, `pnpm exec playwright install --with-deps chromium` from the pinned
      package, `pnpm e2e`, the report uploaded only on failure with `retention-days: 3`,
      actions pinned by SHA), and `scripts/ci/local.sh` gains the e2e step after `dast`,
      skipping with an explicit `SKIP` without Docker or a browser. Verify:
      `ci-e2e-workflow.test.ts` (in `apps/api/src`, a text test) asserts the job,
      `persist-credentials: false`, `retention-days: 3`, the pins and no
      `${{ inputs.* }}` or `github.event.*` inside `run:`; `actionlint` passes; the job
      is green on the PR.

## 11. Docs, ADRs, diagram, and integration checks (Checkpoint 2 readiness)

- [ ] 11.1 Write `docs/adr/0004-tanstack-query-and-zustand.md` (backfill, Q11): server
      state in TanStack Query and local UI state in Zustand, from `project.md` §2 line
      39, with `003`'s use (D4, D12). Verify: the file exists with Context, Decision,
      Alternatives and Consequences, marked as a backfill, and `pnpm lint` passes.
- [ ] 11.2 Write `docs/adr/0007-shadcn-ui-on-radix-and-tailwind.md` (backfill, Q11),
      from `project.md` §2 line 59, with the copy-not-install rule and `components.json`.
      Verify: the file exists with the four sections, marked as a backfill, and `pnpm
      lint` passes.
- [ ] 11.3 Write `docs/adr/0025-same-origin-web-hosting.md` (design D9, Q2). Verify: the
      file exists with the four sections, design D9 links to it, and `pnpm lint` passes.
- [ ] 11.4 Write `docs/adr/0026-strict-content-security-policy.md` (design D10, Q5),
      including the style nonce and its removal condition, `form-action` and the dev
      policy. Verify: the file exists with the four sections, design D10 links to it,
      and `pnpm lint` passes.
- [ ] 11.5 Update `docs/security/attack-surfaces.md`: rows for the HTML pages and
      assets, `GET /v1/me`, `GET /v1/search/entities` and the callback redirect, each
      with its actor, authentication and authorization; the helmet row (CSP on, the
      headers of D10); the planned "Web UI (003)" row made current; the `043` and `044`
      "inert link" notes updated. Verify: `pnpm lint` passes and each surface has a row.
- [ ] 11.6 Update `docs/architecture/system-diagram.md`: the browser SPA served by the
      API container, its HTTPS calls to `/v1` and `/api/auth` on the same origin, the
      asset and page routes, and the Visma Connect sign-in and step-up redirects, in the
      full diagram and in each zone diagram it touches, with each image rendered again.
      Verify: every Mermaid block renders with `npx -y @mermaid-js/mermaid-cli`, and
      `apps/api/src/system-diagram.test.ts` (extended for the new nodes and arrows, each
      with its protocol) passes.
- [ ] 11.7 Update `docs/catalog/auth-and-rbac.md` (`GET /v1/me` and
      `resolveSessionState`, the step-up UX by sign-in method, the callback redirect, the
      two step-up events, the page rules met), `docs/security/crypto-inventory.md` (the
      style nonce: source, size, lifetime) and `docs/security/secrets.md` (a Setting row
      for `WEB_DIST_DIR`: a path, not a secret, optional, validated at startup). Verify:
      `pnpm lint` passes, and the route, the redirect, the two events, the nonce and the
      setting are listed.
- [ ] 11.8 Write `docs/catalog/catalog-ui.md` (pages and routes, i18n and how to add a
      key, theme, the CSP and how to keep a component within it, the browser storage
      inventory of D15, the bundle budget, the identifier rules of Q36, how to run the
      app, the dev server and the e2e suite with its TLS proxy) and update
      `apps/api/CLAUDE.md` (helmet now sets the CSP, the static routes, `isSpaPath`,
      `WEB_DIST_DIR`, `GET /v1/me`), `packages/catalog/CLAUDE.md` (the object form of
      `defineCatalogOperation`, which it still shows as `defineCatalogOperation(name,
      handler)`), and `docs/dev-environment/README.md` (the Chromium row now also serves
      Playwright, pinned to 1.63.0, and the Node floor of `>=22.22.2`). Verify: `pnpm
      lint` passes (markdownlint covers the three `CLAUDE.md` files).
- [ ] 11.9 `pnpm ci:local` is fully green (lint, format, typecheck, the web build and
      its check, policy compile, unit and integration tests, contract-check,
      otel-smoke-check, audit, gitleaks, Semgrep, DAST, e2e, SBOM). Verify: attach the
      command output to the PR description.
- [ ] 11.10 Re-run the `vcdm-ssa-validator` pre-assessment in Mode A against the
      implemented code, and resolve or explicitly defer every blocking gap. Verify: the
      report is attached to the PR with zero open blocking gaps.
- [ ] 11.11 Run `/security-review` on the branch and fix or justify every finding.
      Verify: the review output is attached to the PR.
- [ ] 11.12 `openspec validate 003-catalog-ui-core --strict` passes, and design, specs
      and code agree (update the design only if an implementation finding forced a
      change, noted in the PR). Verify: the command output is attached to the PR.
