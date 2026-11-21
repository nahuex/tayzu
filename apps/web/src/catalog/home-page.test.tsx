/**
 * The home page, `/` (design D12, D16 and Q69, Q84, Q89, Q97).
 *
 * D12 (Routes): "`/` (the home: the blueprint list)". D12 (Shell): "a sidebar of the
 * tenant's blueprints (`blueprints.list`, one call at the maximum page size, the
 * `_`-prefixed system blueprints grouped last)". D12 (i18n): "Blueprint and property
 * titles and descriptions use their `{ en, es? }` value with `en` as the fallback."
 * Q97: "The home page `/` rendered nothing (the placeholder slot), so it gets the
 * blueprint list D12 names in a follow-up cycle."
 * Q84 (table states, which Q89 applies to the search page and this test applies here):
 * a `role="status"` element with `aria-busy` while pending; "Errors show one alert per
 * kind ... `forbidden`, `server` (after D4's one retry), `rate_limited` (no seconds: an
 * `ORPCError` carries no headers, Q63); any other kind shows the generic `server` text,
 * never server text." Q89: other views read "the sidebar's `blueprints.list` cache" and
 * send no call of their own. Q69: an `unauthenticated` answer lands on `/sign-in`.
 * D4: "No retry on a 4xx, at most one retry on a network error or 5xx".
 *
 * Decisions this test pins:
 *
 * - The page is the default `home` slot of `createAppRouter` (this file passes no `home`
 *   page), rendered inside the shell's `main`. Its heading (level 1) is
 *   `catalog:home.title` in every state.
 * - It lists every blueprint of the sidebar's `blueprints.list` answer, in the sidebar's
 *   order (`systemLast`: tenant blueprints first, then the `_`-prefixed ones, each group
 *   in the API's order). Each blueprint is one link in `main` whose accessible name is
 *   exactly its localized title (`en` as the fallback) and whose `href` is
 *   `/catalog/<identifier>`. `main` holds no other link. Titles are React text.
 * - It is not a second sidebar: the document keeps exactly one `navigation` landmark
 *   named `common:nav.catalog` (the e2e specs locate the sidebar by that name).
 * - One request in total: the page reads the sidebar's query (`sidebarBlueprintsQuery`,
 *   `GET /v1/blueprints?pageSize=500`) and never sends a `blueprints.list` or
 *   `blueprints.get` of its own, also when the user leaves `/` and comes back.
 * - Loading: while the list is pending, an element with the `status` role shows
 *   `catalog:home.loading`, with `aria-busy="true"` on it or an ancestor; no empty text
 *   and no link. Neither stays once the answer is in.
 * - Empty: an answer with no items shows `catalog:home.empty`, no link and no alert.
 * - Errors: exactly one `role="alert"` in `main`, with the text of the kind only,
 *   whatever the server's message: `forbidden` -> `catalog:home.error.forbidden` (sent
 *   once); `server` (a 5xx or a network failure) -> `catalog:home.error.server` after one
 *   retry (sent twice); `rate_limited` -> `catalog:home.error.rateLimited` (sent once,
 *   with or without `Retry-After`); any other kind -> `catalog:home.error.server` (sent
 *   once). No empty text, no link, no busy status, no server string.
 * - `unauthenticated`: the shell's handling, `/sign-in` with `returnTo` `/` (or absent,
 *   its default), and no alert.
 * - Whether a blueprint's description or icon is shown is left open: neither D12 nor D13
 *   says, so the fixtures carry none.
 * - English texts are pinned below; Spanish shows the `es` file's texts (the key-parity
 *   test keeps `es` complete), which differ from the English sentences.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), and the query
 * client is `createQueryClient()` (D4's retry policy, as `main.tsx`) with no retry delay.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n, type Locale } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

/** Every locale file, keyed `../i18n/locales/<lng>/<namespace>.json`. */
const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `<namespace>:<key>` text of `locale`; a missing key fails the test as an assertion. */
function localeText(locale: Locale, namespace: 'catalog' | 'common', key: string): string {
  let node: unknown = LOCALE_FILES[`../i18n/locales/${locale}/${namespace}.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `${namespace}:${key} in ${locale}`).toBe(true);
  return node as string;
}

/** The pinned English texts of this cycle's `catalog:home.*` keys. */
const PINNED = {
  'home.title': 'Blueprints',
  'home.loading': 'Loading blueprints...',
  'home.empty': 'No blueprints yet.',
  'home.error.forbidden': 'You do not have permission to view the blueprints.',
  'home.error.server': 'The blueprints could not be loaded. Try again later.',
  'home.error.rateLimited': 'Too many requests. Wait a moment and try again.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The text of a pinned key in `locale`; the English one is checked against the pin. */
function text(key: PinnedKey, locale: Locale = 'en'): string {
  const shown = localeText(locale, 'catalog', key);
  if (locale === 'en') expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

const ME = {
  user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'password',
  mfa: { enrolled: false },
  gate: 'none',
} as const;

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

/** The tenant's blueprints in the API's order, system blueprints interleaved. */
const BLUEPRINTS = [
  blueprint('_team', { en: 'Team', es: 'Equipo' }),
  blueprint('service', { en: 'Service', es: 'Servicio' }),
  blueprint('_user', { en: 'User', es: 'Usuario' }),
  // No Spanish title: `en` is the fallback.
  blueprint('library', { en: 'Library' }),
  blueprint('website', { en: 'Website', es: 'Sitio web' }),
];

/** The home page's list: tenant blueprints first, then the system ones, as the sidebar. */
const EXPECTED_EN = [
  { name: 'Service', href: '/catalog/service' },
  { name: 'Library', href: '/catalog/library' },
  { name: 'Website', href: '/catalog/website' },
  { name: 'Team', href: '/catalog/_team' },
  { name: 'User', href: '/catalog/_user' },
];

const EXPECTED_ES = [
  { name: 'Servicio', href: '/catalog/service' },
  { name: 'Library', href: '/catalog/library' },
  { name: 'Sitio web', href: '/catalog/website' },
  { name: 'Equipo', href: '/catalog/_team' },
  { name: 'Usuario', href: '/catalog/_user' },
];

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_blueprint" on 10.0.0.7';

// ---------------------------------------------------------------------------
// The fake API

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  extra: { data?: unknown; headers?: Record<string, string> } = {},
): Response {
  return jsonResponse(
    status,
    {
      defined: false,
      code,
      status,
      message: SERVER_TEXT,
      ...(extra.data === undefined ? {} : { data: extra.data }),
    },
    extra.headers,
  );
}

const forbidden = (): Response => errorResponse(403, 'AUTH_FORBIDDEN');
const internal = (): Response => errorResponse(500, 'INTERNAL_SERVER_ERROR');
const unauthenticated = (): Response => errorResponse(401, 'UNAUTHORIZED');
const rateLimited = (headers: Record<string, string> = {}): Response =>
  errorResponse(429, 'AUTH_RATE_LIMITED', { headers });
const invalidRequest = (): Response =>
  errorResponse(400, 'CATALOG_VALIDATION_FAILED', {
    data: { issues: [{ path: '/pageSize', message: SERVER_TEXT }] },
  });

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** One request, as `METHOD /path?query` with the query keys sorted. */
function describeRequest(method: string, pathname: string, search: URLSearchParams): string {
  const sorted = new URLSearchParams(
    [...search.entries()].sort(([a], [b]) => compareText(a, b)),
  ).toString();
  return `${method} ${pathname}${sorted === '' ? '' : `?${sorted}`}`;
}

/** The answer of one `blueprints.list` call. A promise not settled yet keeps it pending. */
type ListAnswer = () => Response | Promise<Response>;

const tenantList: ListAnswer = () => jsonResponse(200, { items: BLUEPRINTS });

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me` and
 * `blueprints.list`. Every other catalog call is `CATALOG_NOT_FOUND`.
 */
function createFakeServer(answer: ListAnswer = tenantList) {
  const requests: string[] = [];

  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname, searchParams } = new URL(request.url);
    requests.push(describeRequest(request.method, pathname, searchParams));

    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return answer();
    return errorResponse(404, 'CATALOG_NOT_FOUND');
  };

  return {
    fetch,
    /** Every request to a `/v1/blueprints` path, in order. */
    blueprintRequests(): string[] {
      return requests.filter((line) => /^GET \/v1\/blueprints(?:[/?]|$)/.test(line));
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

/** The one `blueprints.list` call the shell's sidebar sends. */
const SIDEBAR_REQUEST = 'GET /v1/blueprints?pageSize=500';

/** A promise settled from outside, for a call that stays pending. */
function deferred(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Rendering

/** Every slot but `home` is a probe, so the home slot keeps its default page. */
function probe(name: PageName): ComponentType {
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
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
};

/**
 * Renders the whole app as `main.tsx` does (session gate, shell, D4's query client) at
 * `path`, with no retry delay.
 */
async function renderApp(path: string, server: FakeServer): Promise<{ history: RouterHistory }> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  });
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const themeStore = createThemeStore();
  const router = createAppRouter({
    history,
    pages: PROBES,
    session: { authClient, queryClient },
    shell: { apiClient, authClient, themeStore },
  });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthClientProvider client={authClient}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { history };
}

/** The shell's `main` landmark, once the shell is shown. */
async function findMain(): Promise<HTMLElement> {
  return screen.findByRole('main', {}, { timeout: 3000 });
}

/** The page's heading, once the `catalog` namespace has loaded. */
async function findHeading(main: HTMLElement, locale: Locale = 'en'): Promise<HTMLElement> {
  return within(main).findByRole(
    'heading',
    { level: 1, name: text('home.title', locale) },
    { timeout: 3000 },
  );
}

/** The links of `container`, as `{ name, href }`, in document order. */
function shownLinks(container: HTMLElement): { name: string; href: string | null }[] {
  return within(container)
    .queryAllByRole('link')
    .map((link) => ({
      name: link.textContent.trim(),
      href: link.getAttribute('href'),
    }));
}

/** Waits until `main` lists exactly `expected`, in order, each named by its title. */
async function expectHomeLinks(
  main: HTMLElement,
  expected: readonly { name: string; href: string }[],
): Promise<void> {
  await waitFor(
    () => {
      expect(shownLinks(main)).toEqual(expected);
    },
    { timeout: 3000 },
  );
  // The accessible name is exactly the localized title.
  for (const { name, href } of expected) {
    const link = within(main).getByRole('link', { name });
    expect(link).toHaveAttribute('href', href);
  }
}

/** The shell's sidebar: the one navigation landmark named `common:nav.catalog`. */
function sidebar(locale: Locale = 'en'): HTMLElement {
  const name = localeText(locale, 'common', 'nav.catalog');
  const landmarks = screen.getAllByRole('navigation', { name });
  expect(landmarks, `navigation landmarks named "${name}"`).toHaveLength(1);
  const [landmark] = landmarks;
  if (landmark === undefined) throw new Error('No sidebar');
  return landmark;
}

/** The `status` element showing the loading text, if any. */
function loadingIndicator(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((element) => element.textContent.includes(PINNED['home.loading']));
}

/** Nothing in `main` is still loading. */
function expectNotLoading(main: HTMLElement): void {
  expect(within(main).queryByText(PINNED['home.loading'])).toBeNull();
  expect(main.querySelector('[aria-busy="true"]')).toBeNull();
}

/** No server string anywhere in the document (D4, D15). */
function expectNoServerText(): void {
  expect(document.body.textContent).not.toContain(SERVER_TEXT);
  expect(document.body.textContent).not.toContain('Internal detail');
}

/** The one error alert of `main`, with the text of `key` in `locale`. */
async function expectErrorAlert(
  main: HTMLElement,
  key: PinnedKey,
  locale: Locale = 'en',
): Promise<HTMLElement> {
  const message = text(key, locale);
  const alert = await within(main).findByRole('alert', {}, { timeout: 3000 });
  expect(alert).toHaveTextContent(message);
  expect(within(main).getAllByRole('alert')).toHaveLength(1);
  return alert;
}

/** What every failure leaves in `main`: no list, no empty text, no busy status. */
function expectFailureOnly(main: HTMLElement): void {
  expect(within(main).queryAllByRole('link')).toEqual([]);
  expect(within(main).queryByText(PINNED['home.empty'])).toBeNull();
  expectNotLoading(main);
  expectNoServerText();
}

/** Lets pending retries and effects run before counting requests. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

// ---------------------------------------------------------------------------
// jsdom gaps

/** Methods the Radix menus and tooltips call that jsdom does not implement. */
const ELEMENT_STUBS = [
  'hasPointerCapture',
  'setPointerCapture',
  'releasePointerCapture',
  'scrollIntoView',
] as const;

const addedStubs: string[] = [];

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // Intentionally empty.
      }
      unobserve(): void {
        // Intentionally empty.
      }
      disconnect(): void {
        // Intentionally empty.
      }
    },
  );
  for (const name of ELEMENT_STUBS) {
    if (name in Element.prototype) continue;
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value: () => false,
    });
    addedStubs.push(name);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const name of addedStubs) Reflect.deleteProperty(Element.prototype, name);
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests

describe('the home page at /', () => {
  it("shows a heading and the tenant's blueprints, system blueprints last, each linking to its table", async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const main = await findMain();

    expect(await findHeading(main)).toBeInTheDocument();
    await expectHomeLinks(main, EXPECTED_EN);
    // The same blueprints, in the same order, as the shell's sidebar.
    expect(shownLinks(sidebar())).toEqual(EXPECTED_EN);
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(within(main).queryByText(PINNED['home.empty'])).toBeNull();
    expectNotLoading(main);
    expect(history.location.pathname).toBe('/');
  });

  it('shows the localized titles in Spanish, with en as the fallback', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    const server = createFakeServer();
    await renderApp('/', server);
    const main = await findMain();

    expect(await findHeading(main, 'es')).toBeInTheDocument();
    await expectHomeLinks(main, EXPECTED_ES);
    expect(shownLinks(sidebar('es'))).toEqual(EXPECTED_ES);
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
  });

  it("opens a blueprint's table from its link", async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const main = await findMain();
    await expectHomeLinks(main, EXPECTED_EN);

    await user.click(within(main).getByRole('link', { name: 'Library' }));

    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/catalog/library');
  });

  it('keeps a blueprint title as text', async () => {
    const markup = '<img src="x" onerror="alert(1)"><b>Bold</b>';
    const server = createFakeServer(() =>
      jsonResponse(200, { items: [blueprint('service', { en: markup })] }),
    );
    await renderApp('/', server);
    const main = await findMain();

    await expectHomeLinks(main, [{ name: markup, href: '/catalog/service' }]);
    expect(main.querySelector('img')).toBeNull();
    expect(main.querySelector('b')).toBeNull();
  });
});

describe('the home page reuses the sidebar list', () => {
  it('sends one blueprints.list call in total, at the maximum page size', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const main = await findMain();
    await expectHomeLinks(main, EXPECTED_EN);

    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
  });

  it('sends no second call when the user leaves the home page and comes back', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const main = await findMain();
    await expectHomeLinks(main, EXPECTED_EN);

    await user.click(within(main).getByRole('link', { name: 'Service' }));
    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    history.push('/');

    const back = await findMain();
    expect(await findHeading(back)).toBeInTheDocument();
    await expectHomeLinks(back, EXPECTED_EN);
    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
  });
});

describe('the home page while the list loads', () => {
  it('shows a busy status, and no empty text or link, while the list is pending', async () => {
    const pending = deferred();
    const server = createFakeServer(() => pending.promise);
    await renderApp('/', server);
    const main = await findMain();
    expect(await findHeading(main)).toBeInTheDocument();

    await waitFor(
      () => {
        expect(loadingIndicator()).toBeDefined();
      },
      { timeout: 3000 },
    );
    const status = loadingIndicator();
    expect(main).toContainElement(status ?? null);
    expect(status?.closest('[aria-busy="true"]')).not.toBeNull();
    expect(within(main).queryByText(PINNED['home.empty'])).toBeNull();
    expect(within(main).queryAllByRole('link')).toEqual([]);

    pending.resolve(jsonResponse(200, { items: BLUEPRINTS }));
    await expectHomeLinks(main, EXPECTED_EN);
    expectNotLoading(main);
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
  });
});

describe('the home page of a tenant with no blueprint', () => {
  it('shows the empty text and no blueprint link', async () => {
    const server = createFakeServer(() => jsonResponse(200, { items: [] }));
    await renderApp('/', server);
    const main = await findMain();
    expect(await findHeading(main)).toBeInTheDocument();

    expect(
      await within(main).findByText(text('home.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(within(main).queryAllByRole('link')).toEqual([]);
    expect(within(main).queryByRole('alert')).toBeNull();
    expectNotLoading(main);
    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
  });

  it('shows the Spanish empty text', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    const server = createFakeServer(() => jsonResponse(200, { items: [] }));
    await renderApp('/', server);
    const main = await findMain();
    expect(await findHeading(main, 'es')).toBeInTheDocument();

    const empty = text('home.empty', 'es');
    expect(empty).not.toBe(PINNED['home.empty']);
    expect(await within(main).findByText(empty, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(main).queryAllByRole('link')).toEqual([]);
  });
});

describe('the home page when the list fails', () => {
  it('shows the forbidden message, once and without retry, on AUTH_FORBIDDEN', async () => {
    const server = createFakeServer(() => forbidden());
    await renderApp('/', server);
    const main = await findMain();

    await expectErrorAlert(main, 'home.error.forbidden');
    expect(await findHeading(main)).toBeInTheDocument();
    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
    expectFailureOnly(main);
  });

  it.each<[string, ListAnswer]>([
    ['a 500', () => internal()],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows the generic error after one retry on %s', async (_case, answer) => {
    const server = createFakeServer(answer);
    await renderApp('/', server);
    const main = await findMain();

    await expectErrorAlert(main, 'home.error.server');
    expect(await findHeading(main)).toBeInTheDocument();
    await settle();
    // D4: at most one retry on a network failure or a 5xx.
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST, SIDEBAR_REQUEST]);
    expectFailureOnly(main);
  });

  it.each<[string, Record<string, string>]>([
    ['without Retry-After', {}],
    ['with Retry-After', { 'retry-after': '30' }],
  ])('shows the rate-limit message, once and without retry, %s', async (_case, headers) => {
    const server = createFakeServer(() => rateLimited(headers));
    await renderApp('/', server);
    const main = await findMain();

    const alert = await expectErrorAlert(main, 'home.error.rateLimited');
    // Q63: the oRPC client never sees `Retry-After`, so no seconds are shown.
    expect(alert.textContent.trim()).toBe(PINNED['home.error.rateLimited']);
    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
    expectFailureOnly(main);
  });

  it('shows the generic error, once and without retry, on any other kind', async () => {
    const server = createFakeServer(() => invalidRequest());
    await renderApp('/', server);
    const main = await findMain();

    await expectErrorAlert(main, 'home.error.server');
    await settle();
    expect(server.blueprintRequests()).toEqual([SIDEBAR_REQUEST]);
    expectFailureOnly(main);
  });

  it('shows the Spanish error text, never the server text', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    const server = createFakeServer(() => forbidden());
    await renderApp('/', server);
    const main = await findMain();

    const alert = await expectErrorAlert(main, 'home.error.forbidden', 'es');
    expect(alert.textContent).not.toContain(PINNED['home.error.forbidden']);
    expect(await findHeading(main, 'es')).toBeInTheDocument();
    expectFailureOnly(main);
  });

  it('sends the user to sign-in, with no alert, on an unauthenticated answer', async () => {
    const server = createFakeServer(() => unauthenticated());
    const { history } = await renderApp('/', server);

    expect(await screen.findByTestId('page-signIn', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    // `/` is the default `returnTo`, which the sign-in route leaves out of the URL.
    expect(urlSearch(history).returnTo ?? '/').toBe('/');
    expect(screen.queryByRole('alert')).toBeNull();
    expectNoServerText();
  });
});
