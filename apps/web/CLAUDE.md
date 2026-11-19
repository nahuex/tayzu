# @tayzu/web

Tayzu's single-page web app: React 19, Vite 8, TanStack Router and Query,
Zustand, react-i18next, Tailwind CSS 4 and shadcn/ui. Global rules are in the
root `CLAUDE.md`. The design is `openspec/changes/003-catalog-ui-core/design.md`
(D1 to D16); the behavior is `specs/catalog-ui-core/spec.md` in the same change.
When code and design disagree, stop and ask.

## Layout

- `index.html` has no inline script or style. `public/theme-init.js` applies
  the stored theme before first paint, as an external classic script.
- `src/main.tsx` is the entry point (providers, router). The rest of `src/` is
  split by concern: `api/` (the oRPC client, the auth client, the error
  model), `app/` (shell, session gate, error boundary), `auth/`, `catalog/`,
  `search/`, `i18n/`, `state/` (Zustand stores), `components/ui/` (shadcn/ui),
  `lib/` (safe rendering, formatting, return paths) and `build-check/` (the
  Node bundle check).
- `tsconfig.json` is solution-style. `tsconfig.app.json` covers browser code
  (`lib` DOM, `types` `vite/client`, no Node types, so a Node API in browser
  code fails to typecheck). `tsconfig.node.json` covers `vite.config.ts`, `vitest.config.ts`,
  `playwright.config.ts`, `e2e/` and `src/build-check/`. `typecheck` is
  `tsc -b`, which checks both.
- `vite.config.ts` sets `envDir` to the empty `env/` directory, so no `.env`
  file reaches the bundle. The build output is `dist/` (`index.html`, hashed
  files under `dist/assets/`, and the root files of `public/`).

## Page rules

- No business rule in the UI. The server decides; the UI shows its answer.
- No `tenantId` anywhere: not in state, URLs, requests or storage. The server
  takes the tenant from the session.
- No `console`. No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`,
  `document.write`, `document.cookie`, `eval` or `new Function`.
- Every server string is rendered as React text, unless it goes through a
  renderer in `lib/` (safe links, markdown without raw HTML).
- Imports from the workspace: `@tayzu/catalog/contract` only. Never
  `@tayzu/api`, `@tayzu/auth`, `@tayzu/db`, `@tayzu/authz` or any other
  `@tayzu/catalog` path, so no Node-only module reaches the bundle.
- No `import.meta.env.VITE_*`, and no server secret name in any source.
- Same origin only: no CDN, no web font, no third-party script, no `http:` or
  `https:` origin in `index.html`. Icons come from `lucide-react`, bundled.
- `localStorage` and `sessionStorage` are wrapped in `try`/`catch`, and the
  app works when storage throws.

## Content Security Policy

- Production: `script-src 'self'` with no nonce and no hash, and
  `style-src 'self' 'nonce-<n>'`. The API sets the policy and fills the
  `tayzu-style-nonce` meta of `index.html`; `main.tsx` hands that nonce to
  `get-nonce` for the Radix scroll lock.
- The Vite dev server has its own looser policy in `vite.config.ts`, for the
  dev server only. It listens on `127.0.0.1` with `strictPort` and
  `server.fs.strict`; never start it with `--host`. It proxies `/v1` and
  `/api/auth` to a local API on `127.0.0.1:3000`.

## Dependencies

- Only the packages that design D3 names, pinned to exact versions (no caret),
  each the latest release published at least 14 days earlier (Q43). Libraries
  that ship in the bundle are `dependencies`; build and test tools are
  `devDependencies`. Vite itself is a root dev dependency.
- shadcn/ui is not a dependency (ADR-0007). Components are copied into
  `src/components/ui/` with `npx shadcn@4.23.0 add <name>`, and
  `components.json` records the configuration (style `radix-nova`, Lucide
  icons). The CLI output is reviewed and adapted before it is kept:
  - Radix imports use the individual `@radix-ui/react-*` packages
    (`import * as DialogPrimitive from '@radix-ui/react-dialog'`), never the
    `radix-ui` package.
  - `cn` comes from `@/lib/utils` (`clsx` and `tailwind-merge`), never the
    `cn` package.
  - No `@fontsource-*` font and no `shadcn/tailwind.css` import: the theme
    uses the operating system's font stack, and the custom variants the
    components need live in `src/index.css`.
  - Remove every dependency the CLI adds that design D3 does not name, re-pin
    the rest to D3's versions, and check that the lockfile diff adds only D3
    packages and their transitive dependencies.

## Tests (Agentic TDD)

- Component tests are `src/**/*.test.tsx` (or `.test.ts`) under jsdom with
  Testing Library. E2E specs are `e2e/*.spec.ts` (Playwright with axe-core),
  run by `pnpm e2e` against the stack of `scripts/ci/e2e.sh`.
- The `test-writer` writes the tests and the test fixtures; the `implementer`
  never edits them. The fixtures are the Vitest setup file
  `src/__fixtures__/setup-tests.ts` (the jest-dom matchers) and everything
  under `src/__fixtures__/`, and the e2e seed `e2e/fixtures/seed.ts` and
  everything under `e2e/fixtures/`.
- `playwright.config.ts`, `scripts/ci/e2e.sh` and the e2e TLS proxy are setup
  files, written by the orchestrator in their setup tasks.
- Component tests replace the network with a fake `fetch` at the client
  boundary; no component test reaches a real server. They query by role and
  accessible name, so they also check labelling (design D16).
