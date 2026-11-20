/**
 * The router (design D12 and Q36, Q67): TanStack Router's code-based tree of every
 * D12 route, plus the not-found page for any other path.
 *
 * Each route renders one page slot. `createAppRouter` lays the given pages over the
 * defaults (placeholders until groups 6 to 9 bring the real pages). Path params may
 * hold `@`, `:` and `=` unencoded, like the API calls of D4, so an entity such as
 * `team@example.com:prod=1` opens. Search params go through `./search-params.js`.
 *
 * Given a `session` source (task 5.8, Q68), every protected route runs the session
 * gate of `./session-gate.js` before its page renders; the public pages (sign-in,
 * forgot, reset, accept, step-up complete) never read the session. Without one, no
 * route reads a session.
 *
 * Given `shell` sources as well (task 5.9, Q69), the signed-in routes (`/`, the table,
 * the entity page, `/search`) render their page inside the `AppShell` of a pathless
 * layout route; the public and gate pages never do. Without them, the layout renders
 * the page alone.
 */
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  stripSearchParams,
  useRouteContext,
} from '@tanstack/react-router';
import type { RouteComponent, RouterHistory } from '@tanstack/react-router';
import type { ComponentType } from 'react';

import { AppShell, type ShellSources } from './app-shell.js';
import { NotFoundPage } from './not-found-page.js';
import { RouteErrorPage } from './route-error-page.js';
import {
  ENTITY_SEARCH_DEFAULTS,
  TABLE_SEARCH_DEFAULTS,
  entitySearchSchema,
  parseSearch,
  searchPageSearchSchema,
  signInSearchSchema,
  stringifySearch,
  tableSearchSchema,
} from './search-params.js';
import { isPasswordExpired, sessionGuard, type SessionSource } from './session-gate.js';

export { SESSION_QUERY_KEY, type SessionSource } from './session-gate.js';
export type { ShellSources } from './app-shell.js';

/** One page slot per D12 route; the not-found page is not a slot. */
export const PAGE_NAMES = [
  'signIn',
  'forgotPassword',
  'resetPassword',
  'acceptInvitation',
  'changePassword',
  'mfaEnrol',
  'stepUpComplete',
  'home',
  'catalogTable',
  'entity',
  'search',
] as const;

export type PageName = (typeof PAGE_NAMES)[number];

/** The page of each slot: a component with no props, reading the route through hooks. */
export type AppPages = Record<PageName, ComponentType>;

/**
 * The pages `createAppRouter` accepts: one per slot, plus the expired-password page,
 * which `/change-password` renders instead of `changePassword` under the
 * `password_expired` gate (D11, Q68). It is not a route, so not in `PAGE_NAMES`.
 */
export type AppPageOptions = AppPages & { passwordExpired: ComponentType };

/** Stands in for a page until its group replaces it. */
function PlaceholderPage(): null {
  return null;
}

const DEFAULT_PAGES: AppPageOptions = {
  signIn: PlaceholderPage,
  forgotPassword: PlaceholderPage,
  resetPassword: PlaceholderPage,
  acceptInvitation: PlaceholderPage,
  changePassword: PlaceholderPage,
  mfaEnrol: PlaceholderPage,
  stepUpComplete: PlaceholderPage,
  home: PlaceholderPage,
  catalogTable: PlaceholderPage,
  entity: PlaceholderPage,
  search: PlaceholderPage,
  passwordExpired: PlaceholderPage,
};

/** A route component rendering `Page`: route components are function components only. */
function routeComponent(Page: ComponentType): RouteComponent {
  return function PageSlot(): React.JSX.Element {
    return <Page />;
  };
}

/**
 * The `/change-password` slot: the expired-password page under the `password_expired`
 * gate, the change form otherwise (and always without a session source).
 */
function changePasswordComponent(pages: AppPageOptions): RouteComponent {
  const { changePassword: ChangePassword, passwordExpired: PasswordExpired } = pages;
  return function ChangePasswordSlot(): React.JSX.Element {
    // `unknown`: the hook is typed `any` inside the tree that the router type comes from.
    const context: unknown = useRouteContext({ from: '/change-password' });
    return isPasswordExpired(context) ? <PasswordExpired /> : <ChangePassword />;
  };
}

/**
 * The signed-in routes' layout: the shell around the page, when both the session source
 * and the shell sources are given; the page alone otherwise.
 */
function shellComponent(
  session: SessionSource | undefined,
  shell: ShellSources | undefined,
): RouteComponent {
  if (session === undefined || shell === undefined) return Outlet;
  return function ShellLayout(): React.JSX.Element {
    return (
      <AppShell {...shell} session={session}>
        <Outlet />
      </AppShell>
    );
  };
}

function buildRouteTree(
  history: RouterHistory,
  pages: AppPageOptions,
  session: SessionSource | undefined,
  shell: ShellSources | undefined,
) {
  const rootRoute = createRootRoute({
    component: Outlet,
    errorComponent: RouteErrorPage,
    notFoundComponent: NotFoundPage,
  });
  /** The session gate of the protected route at `path`; none without a session source. */
  const guard = (path: string) =>
    session === undefined ? undefined : sessionGuard(session, history, path);
  const page = <P extends string>(path: P, name: PageName) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: routeComponent(pages[name]) });
  const shellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'signed-in',
    component: shellComponent(session, shell),
  });

  return rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'sign-in',
      validateSearch: signInSearchSchema,
      component: routeComponent(pages.signIn),
    }),
    page('forgot-password', 'forgotPassword'),
    page('reset-password', 'resetPassword'),
    page('accept-invitation', 'acceptInvitation'),
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'change-password',
      beforeLoad: guard('/change-password'),
      component: changePasswordComponent(pages),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'mfa/enrol',
      beforeLoad: guard('/mfa/enrol'),
      component: routeComponent(pages.mfaEnrol),
    }),
    page('step-up/complete', 'stepUpComplete'),
    shellRoute.addChildren([
      createRoute({
        getParentRoute: () => shellRoute,
        path: '/',
        beforeLoad: guard('/'),
        component: routeComponent(pages.home),
      }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: 'catalog/$blueprint',
        validateSearch: tableSearchSchema,
        search: { middlewares: [stripSearchParams(TABLE_SEARCH_DEFAULTS)] },
        beforeLoad: guard('/catalog/$blueprint'),
        component: routeComponent(pages.catalogTable),
      }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: 'catalog/$blueprint/$entity',
        validateSearch: entitySearchSchema,
        search: { middlewares: [stripSearchParams(ENTITY_SEARCH_DEFAULTS)] },
        beforeLoad: guard('/catalog/$blueprint/$entity'),
        component: routeComponent(pages.entity),
      }),
      createRoute({
        getParentRoute: () => shellRoute,
        path: 'search',
        validateSearch: searchPageSearchSchema,
        beforeLoad: guard('/search'),
        component: routeComponent(pages.search),
      }),
    ]),
  ]);
}

function buildRouter(
  history: RouterHistory,
  pages: AppPageOptions,
  session: SessionSource | undefined,
  shell: ShellSources | undefined,
) {
  return createRouter({
    routeTree: buildRouteTree(history, pages, session, shell),
    history,
    pathParamsAllowedCharacters: ['@', ':', '='],
    parseSearch,
    stringifySearch,
  });
}

export type AppRouter = ReturnType<typeof buildRouter>;

/** Every key of `AppPageOptions`: the slots and the expired-password page. */
const PAGE_OPTION_NAMES = [...PAGE_NAMES, 'passwordExpired'] as const;

/**
 * The app router over `history`, each slot rendering `pages[name]` or its default. With
 * `session`, the protected routes run the session gate; without it, none reads a session.
 * With `session` and `shell`, the signed-in routes render inside the app shell, which
 * uses `session.queryClient`.
 */
export function createAppRouter(options: {
  history: RouterHistory;
  pages?: Partial<AppPageOptions>;
  session?: SessionSource;
  shell?: ShellSources;
}): AppRouter {
  const pages = { ...DEFAULT_PAGES };
  for (const name of PAGE_OPTION_NAMES) {
    const given = options.pages?.[name];
    if (given !== undefined) pages[name] = given;
  }
  return buildRouter(options.history, pages, options.session, options.shell);
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
