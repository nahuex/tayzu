# ADR-0004: TanStack Query for server state, Zustand for local UI state

- **Status**: Accepted (backfill)
- **Date**: 2026-11-21 (written); decided 2026-09-27, in `openspec/project.md` §2
- **Change**: [`003-catalog-ui-core`](../../openspec/changes/archive/2026-11-27-003-catalog-ui-core/design.md) (design D4, D12, D17; Resolved decision Q11)

This is a **backfill**. The decision has been part of the fixed stack in
`openspec/project.md` §2 (the "Data fetching / state" row, line 39) since the
project started, but its ADR file was never written (`001-catalog-core`
ticket T7). `003-catalog-ui-core`, the first change with a browser app, writes
it with the original decision and what `003` built on it. ADR-0001 to
ADR-0003, ADR-0005 and ADR-0006 are still recorded only in `project.md`.

## Context

`project.md` §2 fixes the frontend as React, Vite and TypeScript, and names
"TanStack Query (server) + Zustand (local UI)" for data fetching and state. It
marks the choice as a recommendation with no direct confirmation that Port
uses it, and gives no further reasoning or alternatives.

The web app of `003` has two kinds of state with different owners:

- **Server state**: the session (`GET /v1/me`), blueprints, entities, search
  results and every mutation's answer. The server is the authority for all of
  it: it decides tenancy, authorization and validation, and the UI only shows
  its answer (no business rule in the UI). This state must be fetched,
  cached, retried with care, invalidated after a mutation, and dropped when
  the session ends.
- **Local UI state**: a few values that are not server answers but must
  outlive a single component, such as the theme and the open step-up dialog.

## Decision

1. **Server state lives in TanStack Query** (`@tanstack/react-query`
   5.106.0). Every server answer is held in its cache and nowhere else: no
   answer is copied into a client store. The one client is
   `createQueryClient()` in `apps/web/src/api/query-client.ts` (design D4):
   - no retry on a 4xx, at most one retry when the error model maps the
     failure to `server` (a network failure or a 5xx), and no retry for a
     mutation;
   - `refetchOnWindowFocus` off by default; the shell's session observer
     (`src/app/app-shell.tsx`) is the only query that refetches on focus, and
     the session query sets its own retry;
   - nothing is persisted (no persister, no storage);
   - the cache is cleared on sign-out and on any `unauthenticated` answer,
     before the app lands on `/sign-in` (D12, Q69).
2. **Local UI state lives in Zustand** (`zustand` 5.0.16), and only for state
   that is not a server answer (design D12). `003` has two stores in
   `apps/web/src/state/`:
   - `theme.ts`: `system`, `light` or `dark`, stored in `localStorage` under
     `tayzu.theme` (wrapped in `try`/`catch`), kept in step with the `dark`
     class that `/theme-init.js` sets before first paint;
   - `step-up.ts`: the open step-up request (only its optional
     `reauthorizationUrl`, never a code or a password), in memory only, plus
     the one-shot "you are back" notice of the Visma Connect return.

   `resetSessionStores()` (`session-stores.ts`) resets the session-bound
   store, the step-up one, after the query cache is cleared. Theme and locale
   are device preferences and stay (Q69).

3. **Everything else stays out of both.** Form fields and short-lived secrets
   (the MFA enrolment URI, secret and backup codes, Q74) are component state.
   Navigation state (the entity tab, the search `q`, the table cursor and page
   size) is in the URL, parsed by TanStack Router's Zod-validated search
   params (D12, D15).
4. **The locale is held by the i18next instance**
   (`apps/web/src/i18n/i18n.ts`, stored under `tayzu.locale`), which already
   notifies React of a change. Design D12 and the D3 dependency table list
   the locale among the Zustand state; the code keeps it in i18next and has
   no locale store.

## Alternatives considered

`project.md` records no alternatives. The ones below are assessed now,
against what `003` needs.

- **Redux Toolkit with RTK Query.** It covers both kinds of state in one
  library, but brings a global store, actions and reducers for what is two
  small stores here. Rejected.
- **SWR** for server state. It caches and revalidates, but has a smaller
  mutation and invalidation model than TanStack Query, and TanStack Router,
  which `003` uses, is built to pair with TanStack Query (D3). Rejected.
- **React context and `useState` only.** No dependency, but hand-written
  fetching, caching and retries, and every context change re-renders its
  whole subtree. Rejected.
- **One store for everything** (server answers copied into Zustand). Two
  sources of truth for server data, and nothing to clear reliably when the
  session ends. Rejected.

## Consequences

- One rule keeps the split clear: a server answer is read through a query or
  a mutation, never stored in Zustand. A reviewer can check it by looking for
  server data in `src/state/`.
- Clearing the query cache and the session-bound stores on sign-out and on an
  `unauthenticated` answer means no answer of one session survives into the
  next one in the same tab.
- Zustand stores are module singletons (`useStepUpStore`), so a test that
  uses one resets it between cases, and a new store that holds session data
  must be added to `resetSessionStores()`.
- Retries never repeat a 4xx, so a denied or invalid call is never sent again
  on its own, and a write is never retried.
- Both libraries are runtime dependencies in the bundle and count against its
  budget (`apps/web/src/build-check/check-bundle.ts`). Since Port's own choice
  is unconfirmed, the decision rests on these needs, not on parity.
