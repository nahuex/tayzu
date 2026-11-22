/**
 * The app shell (task 5.9, design D12, D13, D4, D8, D14, D16 and Q36, Q68; spec "The app
 * is localized and themed", "The app meets WCAG 2.2 A and AA" and "The shell knows the
 * caller's session and enforces its gates").
 *
 * D12 (Shell): "A header (product name, the search trigger with its shortcut hint, the
 * locale selector, the theme toggle, the user menu with name, organization, role and
 * sign-out), a sidebar of the tenant's blueprints (`blueprints.list`, one call at the
 * maximum page size, the `_`-prefixed system blueprints grouped last), a skip link and
 * landmark regions. Sign-out posts `/api/auth/sign-out`, clears the query cache and the
 * stores, and navigates to `/sign-in`."
 * D12 (i18n): "The selector stores it in `localStorage` (`tayzu.locale`), and
 * `<html lang>` follows it. [...] Blueprint and property titles and descriptions use
 * their `{ en, es? }` value with `en` as the fallback."
 * D4 (TanStack Query settings): "the cache is cleared on sign-out and on any
 * `unauthenticated` answer." Q68: that clearing lands with this task.
 * D12 (Session gate): "A `401` sends a protected route to `/sign-in?returnTo=<path>`."
 * D8: a gated session gets the catch-all's uniform `401` from every catalog route, so a
 * gate page must not call `blueprints.list`. `CatalogLimits`: `maxPageSize` is 500.
 * Spec: "Every page of the app MUST be operable by keyboard alone, MUST have labelled
 * controls and landmarks".
 *
 * Assumed API (extends the frozen contracts of `router.test.tsx` and
 * `session-gate.test.tsx`, which pass no `shell` and so render no shell):
 *
 * ```ts
 * // src/app/router.tsx
 * export function createAppRouter(options: {
 *   history: RouterHistory;
 *   pages?: Partial<AppPageOptions>;
 *   session?: SessionSource;
 *   // The shell's sources (`main.tsx` always passes them, with `session`). With
 *   // `shell`, the signed-in routes (`/`, `/catalog/$blueprint`,
 *   // `/catalog/$blueprint/$entity`, `/search`) render their page inside the shell,
 *   // which uses `session.queryClient`. The public pages and the gate pages
 *   // (`/change-password`, `/mfa/enrol`) never render it. Without `shell`, no route
 *   // renders it.
 *   shell?: {
 *     apiClient: ApiClient; // `blueprints.list` for the sidebar
 *     authClient: AuthClient; // `signOut`
 *     themeStore: ThemeStore; // the header's `ThemeToggle`
 *   };
 * }): AppRouter;
 * ```
 *
 * The shell (`src/app/app-shell.tsx`, texts from the `common` namespace):
 *
 * - The skip link is the first focusable element: a link named `common:skipToContent`
 *   whose `href` is `#<id of main>`. Activating it moves focus to `main` (which takes
 *   focus programmatically, `tabIndex={-1}`).
 * - Landmarks: one `banner` (the header), one `navigation` named `common:nav.catalog`
 *   ("Catalog", "Catálogo"; the sidebar), and one `main` holding the page.
 * - The header holds the product name `common:appName`, the search trigger (a button
 *   whose name starts with `common:search.open`, "Search" or "Buscar", and whose text
 *   holds the `K` shortcut hint; task 9.1 makes it open the dialog), the locale selector
 *   (a button named `common:locale.label` opening `menuitemradio` items
 *   `common:locale.en` and `common:locale.es`, the current one checked; choosing one
 *   calls `changeLocale`), the `ThemeToggle`, and the user menu (a button named
 *   `common:userMenu.label`, "User menu" or "Menú de usuario", opening a `menu` with the
 *   user's name, the organization's name, the localized role `common:role.<role>`
 *   ("Owner" | "Admin" | "Member", "Propietario" | "Administrador" | "Miembro") and a
 *   `menuitem` named `common:signOut`).
 * - The sidebar reads `blueprints.list` once with `pageSize: 500` and no cursor (it
 *   never follows a returned cursor), and lists one link per blueprint, named by its
 *   localized title (`en` fallback), to `/catalog/<identifier>`; the `_`-prefixed
 *   system blueprints come after every other one.
 * - Sign-out: `POST /api/auth/sign-out`, then the query cache is cleared and the app is
 *   at `/sign-in`.
 * - While the shell is mounted, any query or mutation of the cache that fails with the
 *   `unauthenticated` kind (D4) clears the cache and sends the user to
 *   `/sign-in?returnTo=<current path>`.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16).
 */
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from '../api/auth-client.js';
import { createApiClient, type ApiClient } from '../api/client.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

import { SESSION_QUERY_KEY, createAppRouter, type PageName } from './router.js';

type Role = 'owner' | 'admin' | 'member';

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: Role;
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';
}

function meWith(overrides: Partial<MeBody> = {}): MeBody {
  return {
    user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    role: 'member',
    signInMethod: 'password',
    mfa: { enrolled: false },
    gate: 'none',
    ...overrides,
  };
}

const ACTOR = { type: 'user', id: 'u_1' } as const;

function blueprint(identifier: string, title: { en: string; es?: string }) {
  return {
    identifier,
    title,
    schema: { properties: {}, required: [] },
    relations: {},
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-01T10:00:00.000Z',
    updatedBy: ACTOR,
  };
}

/**
 * The tenant's blueprints, in the API's identifier order: the system blueprints
 * (`_team`, `_user`) sort first there, and the shell must list them last. `domain` has
 * no Spanish title.
 */
const BLUEPRINTS = [
  blueprint('_team', { en: 'Team', es: 'Equipo' }),
  blueprint('_user', { en: 'User', es: 'Usuario' }),
  blueprint('domain', { en: 'Domain' }),
  blueprint('payment-service', { en: 'Payment service', es: 'Servicio de pagos' }),
  blueprint('service', { en: 'Service', es: 'Servicio' }),
];

const SYSTEM_TITLES_EN = ['Team', 'User'];
const TENANT_TITLES_EN = ['Domain', 'Payment service', 'Service'];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The uniform 401 of D8, as the `/v1` catch-all and every catalog route send it. */
function contextRequired(): Response {
  return jsonResponse(401, {
    defined: false,
    code: 'CATALOG_CONTEXT_REQUIRED',
    status: 401,
    message: 'Unauthorized',
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
  readonly csrf: string | null;
}

/**
 * A fake `fetch` playing the API: `GET /v1/me`, `GET /v1/blueprints`, any other catalog
 * route (an empty answer while signed in), and `POST /api/auth/sign-out`. Once the
 * session is gone (signed out or expired), every `/v1` route answers the uniform 401.
 */
function createFakeServer(options: { me: MeBody; expireAfterFirstMe?: boolean }) {
  let me: MeBody | undefined = options.me;
  const calls: RecordedRequest[] = [];

  const fetch = (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const { pathname } = url;
    calls.push({
      method: request.method,
      pathname,
      search: url.searchParams,
      csrf: request.headers.get('x-csrf-token'),
    });

    if (request.method === 'POST' && pathname === '/api/auth/sign-out') {
      me = undefined;
      return Promise.resolve(jsonResponse(200, { success: true }));
    }
    if (!pathname.startsWith('/v1/')) {
      return Promise.resolve(jsonResponse(404, { code: 'NOT_FOUND', status: 404 }));
    }
    if (me === undefined) return Promise.resolve(contextRequired());

    if (request.method === 'GET' && pathname === '/v1/me') {
      const body = me;
      if (options.expireAfterFirstMe === true) me = undefined;
      return Promise.resolve(jsonResponse(200, body));
    }
    if (request.method === 'GET' && pathname === '/v1/blueprints') {
      // A cursor says more pages exist; the shell must not follow it (one call).
      return Promise.resolve(jsonResponse(200, { items: BLUEPRINTS, cursor: 'more-blueprints' }));
    }
    if (request.method === 'GET' && pathname.endsWith('/entities')) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  return {
    fetch,
    calls,
    blueprintListCalls: () =>
      calls.filter((call) => call.method === 'GET' && call.pathname === '/v1/blueprints'),
    /** The session ends on the server: every later `/v1` call answers 401. */
    expireSession() {
      me = undefined;
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

interface ShellApp {
  readonly history: RouterHistory;
  readonly queryClient: QueryClient;
  readonly apiClient: ApiClient;
  readonly authClient: AuthClient;
}

/** A page slot: its test id names it. */
function probe(name: PageName | 'passwordExpired'): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
  passwordExpired: probe('passwordExpired'),
};

/** Renders the whole app (session gate and shell) at `path` over the fake server. */
async function renderApp(
  path: string,
  server: FakeServer,
  pages: (clients: { apiClient: ApiClient }) => Partial<typeof PROBES> = () => ({}),
): Promise<ShellApp> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const themeStore = createThemeStore();

  const router = createAppRouter({
    history,
    pages: { ...PROBES, ...pages({ apiClient }) },
    session: { authClient, queryClient },
    shell: { apiClient, authClient, themeStore },
  });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { history, queryClient, apiClient, authClient };
}

/** Waits for the shell's sidebar to list the tenant's blueprints. */
async function sidebar(name = 'Catalog'): Promise<HTMLElement> {
  const nav = await screen.findByRole('navigation', { name });
  await within(nav).findAllByRole('link');
  return nav;
}

function linkNames(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent.trim());
}

/** Every query of the cache that still holds data. */
function cachedData(queryClient: QueryClient): readonly unknown[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryKey);
}

function stubNavigatorLanguage(language: string): void {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language);
}

beforeEach(() => {
  window.localStorage.clear();
  stubNavigatorLanguage('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the sidebar from blueprints.list', () => {
  it('lists every blueprint by its English title, the system blueprints grouped last', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);

    const nav = await sidebar();
    await screen.findByTestId('page-home');

    const names = linkNames(nav);
    expect([...names].sort()).toEqual([...SYSTEM_TITLES_EN, ...TENANT_TITLES_EN].sort());
    const lastTenant = Math.max(...TENANT_TITLES_EN.map((title) => names.indexOf(title)));
    const firstSystem = Math.min(...SYSTEM_TITLES_EN.map((title) => names.indexOf(title)));
    expect(lastTenant).toBeLessThan(firstSystem);
  });

  it('reads blueprints.list once at the maximum page size and never follows its cursor', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);

    await sidebar();

    const listCalls = server.blueprintListCalls();
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) {
      expect(call.search.get('pageSize')).toBe('500');
      expect(call.search.has('cursor')).toBe(false);
    }
  });

  it('links each blueprint to its table at /catalog/<identifier>, with no % in any link', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);

    const nav = await sidebar();

    const expected: readonly (readonly [string, string])[] = [
      ['Team', '/catalog/_team'],
      ['User', '/catalog/_user'],
      ['Domain', '/catalog/domain'],
      ['Payment service', '/catalog/payment-service'],
      ['Service', '/catalog/service'],
    ];
    for (const [name, href] of expected) {
      expect(within(nav).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('%');
    }
  });

  it('opens a blueprint table from the sidebar, inside the shell', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    const { history } = await renderApp('/', server);

    const nav = await sidebar();
    await user.click(within(nav).getByRole('link', { name: 'User' }));

    await screen.findByTestId('page-catalogTable');
    expect(history.location.pathname).toBe('/catalog/_user');
    expect(within(screen.getByRole('main')).getByTestId('page-catalogTable')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Catalog' })).toBeInTheDocument();
  });

  it('uses the Spanish titles in Spanish, with the English title when there is none', async () => {
    stubNavigatorLanguage('es-AR');
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);

    const nav = await sidebar('Catálogo');

    const names = linkNames(nav);
    expect([...names].sort()).toEqual(
      ['Domain', 'Equipo', 'Servicio', 'Servicio de pagos', 'Usuario'].sort(),
    );
    expect(names).not.toContain('Service');
    expect(names.indexOf('Domain')).toBeLessThan(names.indexOf('Equipo'));
    expect(names.indexOf('Servicio de pagos')).toBeLessThan(names.indexOf('Usuario'));
  });
});

describe('the header', () => {
  it('holds the product name, the search trigger with its shortcut hint, the locale selector, the theme toggle and the user menu', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);
    await sidebar();

    const banner = screen.getByRole('banner');
    expect(within(banner).getByText('Tayzu')).toBeInTheDocument();
    const search = within(banner).getByRole('button', { name: /^Search\b/ });
    expect(search.textContent).toContain('K');
    expect(within(banner).getByRole('button', { name: 'Language' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Theme' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'User menu' })).toBeInTheDocument();
  });
});

describe('the user menu', () => {
  it.each([
    ['owner', 'Owner'],
    ['admin', 'Admin'],
    ['member', 'Member'],
  ] as const)(
    'shows the name, the organization and the localized %s role, and sign-out',
    async (role, roleText) => {
      const user = userEvent.setup();
      const server = createFakeServer({ me: meWith({ role }) });
      await renderApp('/', server);
      await sidebar();

      await user.click(screen.getByRole('button', { name: 'User menu' }));

      const menu = await screen.findByRole('menu');
      expect(within(menu).getByText('Mia Moreno')).toBeInTheDocument();
      expect(within(menu).getByText('Acme')).toBeInTheDocument();
      expect(within(menu).getByText(roleText)).toBeInTheDocument();
      expect(within(menu).queryByText(role)).not.toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    },
  );

  it('renders the names the server sends as text, never as markup', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      me: meWith({
        user: { id: 'u_1', name: '<img src=x onerror=alert(1)>', email: 'mia@example.com' },
        organization: { id: 'org_1', name: 'Acme <b>Labs</b>' },
      }),
    });
    await renderApp('/', server);
    await sidebar();

    await user.click(screen.getByRole('button', { name: 'User menu' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(within(menu).getByText('Acme <b>Labs</b>')).toBeInTheDocument();
    expect(menu.querySelector('img')).toBeNull();
    expect(menu.querySelector('b')).toBeNull();
  });

  it('shows the role in Spanish', async () => {
    stubNavigatorLanguage('es-AR');
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith({ role: 'admin' }) });
    await renderApp('/', server);
    await sidebar('Catálogo');

    await user.click(screen.getByRole('button', { name: 'Menú de usuario' }));

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Administrador')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });
});

describe('the locale switch', () => {
  it('switches every text, the blueprint titles and <html lang> to Spanish, and stores the choice', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);
    await sidebar();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Language' }));
    expect(
      await screen.findByRole('menuitemradio', { name: 'English', checked: true }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Español' }));

    const nav = await screen.findByRole('navigation', { name: 'Catálogo' });
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('es');
    });
    expect(window.localStorage.getItem('tayzu.locale')).toBe('es');
    expect(screen.getByRole('link', { name: 'Saltar al contenido principal' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Skip to main content' })).not.toBeInTheDocument();
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('button', { name: /^Buscar\b/ })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Idioma' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Tema' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Menú de usuario' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Servicio' })).toHaveAttribute(
      'href',
      '/catalog/service',
    );
    expect(within(nav).getByRole('link', { name: 'Domain' })).toHaveAttribute(
      'href',
      '/catalog/domain',
    );
    expect(within(nav).getByRole('link', { name: 'Equipo' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Service' })).not.toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: 'Idioma' }));
    expect(
      await screen.findByRole('menuitemradio', { name: 'Español', checked: true }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(within(banner).getByRole('button', { name: 'Menú de usuario' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Miembro')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });
});

describe('the skip link and the landmarks', () => {
  it('has one banner, one catalog navigation and one main holding the page', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/catalog/service', server);
    await sidebar();

    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Catalog' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByTestId('page-catalogTable')).toBeInTheDocument();
    expect(within(main).queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
    expect(within(main).queryByRole('banner')).not.toBeInTheDocument();
  });

  it('makes the skip link the first stop of the keyboard, and it moves focus to main', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);
    await sidebar();

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    const main = screen.getByRole('main');
    expect(main.id).not.toBe('');
    expect(skip).toHaveAttribute('href', `#${main.id}`);

    await user.tab();
    expect(skip).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(main).toHaveFocus();
  });

  it('moves focus to main when the skip link is clicked', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    await renderApp('/', server);
    await sidebar();

    await user.click(screen.getByRole('link', { name: 'Skip to main content' }));

    expect(screen.getByRole('main')).toHaveFocus();
  });
});

describe('sign-out', () => {
  it('posts /api/auth/sign-out, clears the query cache and navigates to /sign-in', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    const { history, queryClient } = await renderApp('/catalog/service', server);
    await sidebar();
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();
    expect(cachedData(queryClient).length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: 'User menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    expect(server.calls).toContainEqual(
      expect.objectContaining({ method: 'POST', pathname: '/api/auth/sign-out', csrf: 'orpc' }),
    );
    expect(cachedData(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
    expect(screen.queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });
});

describe('an unauthenticated answer clears the cache (D4)', () => {
  /** The table page reading `entities.list` on demand, as the real one will. */
  function tablePageReading(apiClient: ApiClient): ComponentType {
    return function TableProbe(): React.JSX.Element {
      const entities = useQuery({
        queryKey: ['probe', 'entities', 'service'],
        queryFn: () => apiClient.entities.list({ blueprint: 'service' }),
        enabled: false,
        retry: false,
      });
      return (
        <div data-testid="page-catalogTable">
          <button type="button" onClick={() => void entities.refetch()}>
            Load entities
          </button>
        </div>
      );
    };
  }

  /** The entity page deleting its entity, as the real one will. */
  function entityPageDeleting(apiClient: ApiClient): ComponentType {
    return function EntityProbe(): React.JSX.Element {
      const remove = useMutation({
        mutationFn: () =>
          apiClient.entities.delete({
            params: { blueprint: 'service', entity: 'payments-api' },
            query: {},
          }),
        retry: false,
      });
      return (
        <div data-testid="page-entity">
          <button
            type="button"
            onClick={() => {
              remove.mutate();
            }}
          >
            Delete
          </button>
        </div>
      );
    };
  }

  it('clears the cache and sends the user to sign-in when a page query answers 401', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    const { history, queryClient } = await renderApp(
      '/catalog/service',
      server,
      ({ apiClient }) => ({
        catalogTable: tablePageReading(apiClient),
      }),
    );
    await sidebar();
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();

    server.expireSession();
    await user.click(screen.getByRole('button', { name: 'Load entities' }));

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    expect(new URLSearchParams(history.location.search).get('returnTo')).toBe('/catalog/service');
    expect(server.calls).toContainEqual(
      expect.objectContaining({ method: 'GET', pathname: '/v1/blueprints/service/entities' }),
    );
    expect(cachedData(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });

  it('clears the cache and sends the user to sign-in when the sidebar query answers 401', async () => {
    const server = createFakeServer({ me: meWith(), expireAfterFirstMe: true });
    const { history, queryClient } = await renderApp('/catalog/service', server);

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    expect(new URLSearchParams(history.location.search).get('returnTo')).toBe('/catalog/service');
    expect(server.blueprintListCalls().length).toBeGreaterThan(0);
    expect(cachedData(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });

  it('clears the cache and sends the user to sign-in when a mutation answers 401', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ me: meWith() });
    const { history, queryClient } = await renderApp(
      '/catalog/service/payments-api',
      server,
      ({ apiClient }) => ({ entity: entityPageDeleting(apiClient) }),
    );
    await sidebar();

    server.expireSession();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    expect(new URLSearchParams(history.location.search).get('returnTo')).toBe(
      '/catalog/service/payments-api',
    );
    expect(server.calls).toContainEqual(
      expect.objectContaining({
        method: 'DELETE',
        pathname: '/v1/blueprints/service/entities/payments-api',
      }),
    );
    expect(cachedData(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });
});

describe('where the shell is not', () => {
  it('renders no shell and calls nothing on a public page', async () => {
    const server = createFakeServer({ me: meWith() });
    await renderApp('/sign-in', server);

    await screen.findByTestId('page-signIn');
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it.each([
    ['password_change_required', '/change-password', 'changePassword'],
    ['mfa_enrolment_required', '/mfa/enrol', 'mfaEnrol'],
  ] as const)(
    'never reads blueprints.list on the gate page of a %s session (%s)',
    async (gate, path, name) => {
      const server = createFakeServer({ me: meWith({ gate }) });
      const { history } = await renderApp(path, server);

      await screen.findByTestId(`page-${name}`);
      await waitFor(() => {
        expect(server.calls.some((call) => call.pathname === '/v1/me')).toBe(true);
      });
      // Give a mounted sidebar the chance to ask; it must not exist here.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.blueprintListCalls()).toEqual([]);
      expect(history.location.pathname).toBe(path);
      expect(screen.queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
    },
  );
});
