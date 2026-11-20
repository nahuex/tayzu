/**
 * The router (design D12 and Q36, Q67): TanStack Router's code-based tree of every
 * D12 route, plus the not-found page for any other path.
 *
 * Each route renders one page slot. `createAppRouter` lays the given pages over the
 * defaults (placeholders until groups 6 to 9 bring the real pages). Path params may
 * hold `@`, `:` and `=` unencoded, like the API calls of D4, so an entity such as
 * `team@example.com:prod=1` opens. Search params go through `./search-params.js`.
 */
import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { RouteComponent, RouterHistory } from '@tanstack/react-router';
import type { ComponentType } from 'react';

import { NotFoundPage } from './not-found-page.js';
import {
  entitySearchSchema,
  parseSearch,
  searchPageSearchSchema,
  signInSearchSchema,
  stringifySearch,
  tableSearchSchema,
} from './search-params.js';

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

/** Stands in for a page until its group replaces it. */
function PlaceholderPage(): null {
  return null;
}

const DEFAULT_PAGES: AppPages = {
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
};

/** A route component rendering `Page`: route components are function components only. */
function routeComponent(Page: ComponentType): RouteComponent {
  return function PageSlot(): React.JSX.Element {
    return <Page />;
  };
}

function buildRouteTree(pages: AppPages) {
  const rootRoute = createRootRoute({
    component: Outlet,
    notFoundComponent: NotFoundPage,
  });
  const page = <P extends string>(path: P, name: PageName) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: routeComponent(pages[name]) });

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
    page('change-password', 'changePassword'),
    page('mfa/enrol', 'mfaEnrol'),
    page('step-up/complete', 'stepUpComplete'),
    page('/', 'home'),
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'catalog/$blueprint',
      validateSearch: tableSearchSchema,
      component: routeComponent(pages.catalogTable),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'catalog/$blueprint/$entity',
      validateSearch: entitySearchSchema,
      component: routeComponent(pages.entity),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: 'search',
      validateSearch: searchPageSearchSchema,
      component: routeComponent(pages.search),
    }),
  ]);
}

function buildRouter(history: RouterHistory, pages: AppPages) {
  return createRouter({
    routeTree: buildRouteTree(pages),
    history,
    pathParamsAllowedCharacters: ['@', ':', '='],
    parseSearch,
    stringifySearch,
  });
}

export type AppRouter = ReturnType<typeof buildRouter>;

/** The app router over `history`, each slot rendering `pages[name]` or its default. */
export function createAppRouter(options: {
  history: RouterHistory;
  pages?: Partial<AppPages>;
}): AppRouter {
  const pages = { ...DEFAULT_PAGES };
  for (const name of PAGE_NAMES) {
    const given = options.pages?.[name];
    if (given !== undefined) pages[name] = given;
  }
  return buildRouter(options.history, pages);
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
