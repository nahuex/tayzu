/**
 * The search page (task 9.2, design D14, D12, D15, D16 and Q36, Q63, Q65, Q67, Q69, Q84,
 * Q85; spec "Users can search the catalog from anywhere" and "The UI never carries the
 * tenant, the cookie or tenant free text outside the page").
 *
 * Spec (requirement): "A search page MUST show the full result list for a query kept in
 * the URL. The query MUST NOT be stored in browser storage."
 * Spec (requirement): the web app "MUST NOT store any token, password, second-factor
 * secret, backup code, search query or catalog data in browser storage".
 * Spec, scenario "Search never shows another tenant's entity": GIVEN an entity
 * `secret-svc` in tenant `t1` only, WHEN a user of tenant `t2` searches for `secret`,
 * THEN no result is shown.
 * D14: "The search page shows up to 50 results with the query in the URL. The query is
 * never written to storage, and it reaches the server only as the `q` query parameter".
 * D15 (Browser storage inventory): only `tayzu.theme`, `tayzu.locale` and
 * `tayzu.stepUp.returnTo`; no query is ever stored. TanStack Query's cache is memory
 * only (D12, State), so the search answer in the cache is not storage.
 * D12 and Q67: `/search` has the search param `q`, kept as text (`q=2024` is `'2024'`)
 * and refused on its raw length over 100 (then absent). "A 1-character `q` is the search
 * page's concern (task 9.2)."
 * Contract: `search.entities` is `GET /v1/search/entities` with `q` (2 to 100 characters
 * after trimming and NFC normalization) and `limit` (1 to 50); it answers
 * `{ items: [{ blueprint, identifier, title, match }] }`, ranked, with no cursor. A `q`
 * under 2 characters answers `CATALOG_VALIDATION_FAILED` on `/q`.
 *
 * Decisions this test pins:
 *
 * - The page is the router's default `search` slot (`src/search/search-page.tsx`),
 *   rendered inside the shell. Its texts are under `search:page.*`.
 * - The page has a level-1 heading `search:page.title` and no text input of its own:
 *   D14 gives the page none (the command dialog of task 9.1 is where a query is typed).
 * - Request: once per `q`, `GET /v1/search/entities?limit=50&q=<q>`, `q` exactly as in the
 *   URL. The query appears in no other request.
 * - Blueprint titles come from the sidebar's `blueprints.list` (one call of 500, Q69),
 *   never from a `blueprints.get` per result: the app sends at most one
 *   `GET /v1/blueprints?pageSize=500` and no other `/v1/blueprints/...` request.
 * - Results: a table named `search:page.title` with the column headers
 *   `search:page.columns.title`, `.identifier` and `.blueprint`, in that order, one row
 *   per item in the server's order: the entity title as text, the identifier through
 *   `EntityLink` (a link to `/catalog/<blueprint>/<identifier>`, or the disabled link
 *   described by `catalog:entity.notAddressable`), and the blueprint's localized title
 *   (`en` as the fallback), or the blueprint identifier when the list does not hold it.
 *   How the `match` field is shown, if at all, is left open.
 * - Edge cases, none of which sends a search request or shows an alert:
 *   - no `q`, an empty or whitespace-only `q`, and a `q` the router refused (over 100
 *     characters, so absent) show the prompt `search:page.prompt`;
 *   - a `q` of 1 character after trimming shows the hint `search:page.tooShort`.
 * - An answer with no items shows `search:page.empty` and no data row; this is also what
 *   another tenant's entity looks like (the server answers no item).
 * - States, as Q84: a `role="status"` element with `aria-busy="true"` showing
 *   `search:page.loading` while the call is pending; then one alert by kind, never the
 *   empty text and never the server's message: `forbidden`
 *   (`search:page.error.forbidden`), `rate_limited` (`search:page.error.rateLimited`,
 *   sent once, the same text with or without `Retry-After`), and every other kind
 *   (`search:page.error.server`): a 500 or a network failure after D4's one retry, a
 *   `validation` answer sent once. `unauthenticated` is the shell's (Q69): sign-in with
 *   the search as `returnTo`.
 * - Storage: neither `localStorage` nor `sessionStorage` is ever written while the page
 *   searches, shows results, follows a new `q` or opens a result, and both stay empty.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), and the query
 * client is `createQueryClient()` (D4's retry policy, as `main.tsx`) with no retry delay.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/en/*.json', {
  eager: true,
  import: 'default',
});

/** The English `<namespace>:<key>` text; a missing key fails the test as an assertion. */
function englishText(namespace: 'catalog' | 'common' | 'search', key: string): string {
  let node: unknown = LOCALE_FILES[`../i18n/locales/en/${namespace}.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `${namespace}:${key} in en`).toBe(true);
  return node as string;
}

/** The pinned English texts of this task's `search:page.*` keys. */
const PINNED = {
  'page.title': 'Search results',
  'page.prompt': 'Type a query in the search box to search the catalog.',
  'page.tooShort': 'Type at least 2 characters to search.',
  'page.loading': 'Searching...',
  'page.empty': 'No results.',
  'page.columns.title': 'Title',
  'page.columns.identifier': 'Identifier',
  'page.columns.blueprint': 'Blueprint',
  'page.error.forbidden': 'You do not have permission to search the catalog.',
  'page.error.server': 'The search could not be completed. Try again later.',
  'page.error.rateLimited': 'Too many requests. Wait a moment and try again.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = englishText('search', key);
  expect(shown, `search:${key}`).toBe(PINNED[key]);
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

/** The tenant's blueprints, as the sidebar's `blueprints.list` answers them. */
const BLUEPRINTS = [
  blueprint('service', { en: 'Service', es: 'Servicio' }),
  // No Spanish title: `en` is the fallback.
  blueprint('library', { en: 'Library' }),
  blueprint('_team', { en: 'Team', es: 'Equipo' }),
];

interface SearchItem {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly match: 'identifier' | 'title';
}

function item(
  blueprintId: string,
  identifier: string,
  title: string,
  match: SearchItem['match'] = 'identifier',
): SearchItem {
  return { blueprint: blueprintId, identifier, title, match };
}

/** The answer to `q=paym`, in the server's ranked order. */
const PAYM_ITEMS: readonly SearchItem[] = [
  item('service', 'payments-api', 'Payments API'),
  item('library', 'payments-sdk', 'Payments SDK'),
  // A blueprint the sidebar list does not hold: its identifier is shown.
  item('legacy', 'payments-legacy', 'Legacy payments'),
  item('_team', 'payments-team', 'Payments team', 'title'),
  // Not addressable by URL (Q18): a disabled link with its note.
  item('service', 'payments/v1', 'Payments v1'),
];

/** The answer to `q=ledger`. */
const LEDGER_ITEMS: readonly SearchItem[] = [item('service', 'ledger', 'Ledger')];

/** 50 results, the page's limit. */
const FIFTY_ITEMS: readonly SearchItem[] = Array.from({ length: 50 }, (_, i) =>
  item('service', `svc-${String(i + 1).padStart(3, '0')}`, `Service ${String(i + 1)}`),
);

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entity" on 10.0.0.7';

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
const invalidQuery = (): Response =>
  errorResponse(400, 'CATALOG_VALIDATION_FAILED', {
    data: { issues: [{ path: '/q', message: SERVER_TEXT }] },
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

/**
 * The answer of one `search.entities` call, by its decoded `q`; `undefined` answers no
 * item. A promise not settled yet keeps the call pending.
 */
type SearchAnswer = (q: string, search: URLSearchParams) => Response | Promise<Response>;

/** The tenant's answers: `paym`, `ledger` and `svc` match; anything else matches nothing. */
const defaultAnswer: SearchAnswer = (q) => {
  if (q === 'paym') return jsonResponse(200, { items: PAYM_ITEMS });
  if (q === 'ledger') return jsonResponse(200, { items: LEDGER_ITEMS });
  if (q === 'svc') return jsonResponse(200, { items: FIFTY_ITEMS });
  return jsonResponse(200, { items: [] });
};

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me`, `blueprints.list`
 * (the sidebar) and `search.entities`. Every other catalog call is `CATALOG_NOT_FOUND`.
 */
function createFakeServer(answer: SearchAnswer = defaultAnswer) {
  const requests: string[] = [];

  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname, searchParams } = new URL(request.url);
    requests.push(describeRequest(request.method, pathname, searchParams));

    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: BLUEPRINTS });
    if (pathname === '/v1/search/entities')
      return answer(searchParams.get('q') ?? '', searchParams);
    return errorResponse(404, 'CATALOG_NOT_FOUND');
  };

  return {
    fetch,
    /** Every request, in order. */
    requests(): readonly string[] {
      return requests;
    },
    /** The `search.entities` requests, in order. */
    searchRequests(): string[] {
      return requests.filter(
        (line) => line === 'GET /v1/search/entities' || line.startsWith('GET /v1/search/entities?'),
      );
    },
    /** Every request to a `/v1/blueprints` path. */
    blueprintRequests(): string[] {
      return requests.filter((line) => /^GET \/v1\/blueprints(?:[/?]|$)/.test(line));
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

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

/** Every slot but `search` is a probe, so the search slot keeps its default page. */
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
  home: probe('home'),
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
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

/** The page's heading, once the `search` namespace has loaded. */
async function findHeading(main: HTMLElement): Promise<HTMLElement> {
  return within(main).findByRole(
    'heading',
    { level: 1, name: text('page.title') },
    { timeout: 3000 },
  );
}

/** The results table, once shown. */
async function findResults(main: HTMLElement): Promise<HTMLElement> {
  return within(main).findByRole('table', { name: text('page.title') }, { timeout: 3000 });
}

function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

/** The body rows of a table, in order. */
function bodyRows(table: HTMLElement): HTMLTableRowElement[] {
  return within(table)
    .queryAllByRole('row')
    .filter(
      (row): row is HTMLTableRowElement =>
        row instanceof HTMLTableRowElement && row.closest('tbody') !== null,
    );
}

/** The data rows (a row with all three cells), as `[title, identifier, blueprint]`. */
function shownRows(table: HTMLElement): string[][] {
  return bodyRows(table)
    .filter((row) => row.cells.length === 3)
    .map((row) => [...row.cells].map((cell) => cell.textContent.trim()));
}

/** The `status` element showing the loading text, if any. */
function loadingIndicator(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((element) => element.textContent.includes(PINNED['page.loading']));
}

/** Nothing in `main` is still loading. */
function expectNotLoading(main: HTMLElement): void {
  expect(within(main).queryByText(PINNED['page.loading'])).toBeNull();
  expect(main.querySelector('[aria-busy="true"]')).toBeNull();
}

/** No server string anywhere in the document (D4, D15). */
function expectNoServerText(): void {
  expect(document.body.textContent).not.toContain(SERVER_TEXT);
  expect(document.body.textContent).not.toContain('Internal detail');
}

/** The one error alert of `main`, with the text of `key`. */
async function expectErrorAlert(main: HTMLElement, key: PinnedKey): Promise<HTMLElement> {
  const message = text(key);
  const alert = await within(main).findByRole('alert', {}, { timeout: 3000 });
  expect(alert).toHaveTextContent(message);
  expect(within(main).getAllByRole('alert')).toHaveLength(1);
  return alert;
}

/** Lets pending retries and effects run before counting requests. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Both browser storages hold nothing. */
function expectStorageEmpty(): void {
  expect(window.localStorage.length, 'localStorage keys').toBe(0);
  expect(window.sessionStorage.length, 'sessionStorage keys').toBe(0);
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

describe('the search page with results', () => {
  it('shows the results for the q in the URL with their blueprint titles', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/search?q=paym', server);
    const main = await findMain();
    await findHeading(main);
    const table = await findResults(main);

    // The column headers, in order.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent.trim()),
    ).toEqual([
      text('page.columns.title'),
      text('page.columns.identifier'),
      text('page.columns.blueprint'),
    ]);

    // One row per item, in the server's order: title, identifier, blueprint title (or
    // the blueprint identifier when the list does not hold it).
    await waitFor(() => {
      expect(shownRows(table)).toEqual([
        ['Payments API', 'payments-api', 'Service'],
        ['Payments SDK', 'payments-sdk', 'Library'],
        ['Legacy payments', 'payments-legacy', 'legacy'],
        ['Payments team', 'payments-team', 'Team'],
        ['Payments v1', `payments/v1${englishText('catalog', 'entity.notAddressable')}`, 'Service'],
      ]);
    });

    // The identifier is the entity link (Q85's `EntityLink`).
    expect(within(table).getByRole('link', { name: 'payments-api' })).toHaveAttribute(
      'href',
      '/catalog/service/payments-api',
    );
    expect(within(table).getByRole('link', { name: 'payments-sdk' })).toHaveAttribute(
      'href',
      '/catalog/library/payments-sdk',
    );
    expect(within(table).getByRole('link', { name: 'payments-team' })).toHaveAttribute(
      'href',
      '/catalog/_team/payments-team',
    );
    const disabled = within(table).getByRole('link', { name: 'payments/v1' });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).not.toHaveAttribute('href');
    expect(disabled).toHaveAccessibleDescription(englishText('catalog', 'entity.notAddressable'));

    // One request, with `limit=50` and the query only as `q`.
    await settle();
    expect(server.searchRequests()).toEqual(['GET /v1/search/entities?limit=50&q=paym']);
    expect(
      server
        .requests()
        .filter((line) => !line.startsWith('GET /v1/search/entities'))
        .filter((line) => line.includes('paym')),
    ).toEqual([]);
    // Blueprint titles come from the sidebar's list, never one call per result.
    expect(server.blueprintRequests()).toEqual(['GET /v1/blueprints?pageSize=500']);

    // No alert, no empty text, no busy state, no input of the page's own.
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expect(within(main).queryByRole('textbox')).toBeNull();
    expect(within(main).queryByRole('searchbox')).toBeNull();
    expectNotLoading(main);
    expect(history.location.pathname).toBe('/search');
    expect(urlSearch(history)).toEqual({ q: 'paym' });
  });

  it('shows the localized blueprint title, with en as the fallback', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    const server = createFakeServer();
    await renderApp('/search?q=paym', server);
    const main = await findMain();
    const table = await within(main).findByRole('table', {}, { timeout: 3000 });

    await waitFor(() => {
      expect(shownRows(table).map((row) => row[2])).toEqual([
        'Servicio',
        'Library',
        'legacy',
        'Equipo',
        'Servicio',
      ]);
    });
    expect(shownRows(table).map((row) => row[0])).toEqual(PAYM_ITEMS.map((result) => result.title));
    expect(server.blueprintRequests()).toEqual(['GET /v1/blueprints?pageSize=500']);
  });

  it('shows all 50 results of a full answer', async () => {
    const server = createFakeServer();
    await renderApp('/search?q=svc', server);
    const main = await findMain();
    const table = await findResults(main);

    await waitFor(() => {
      expect(shownRows(table)).toHaveLength(50);
    });
    expect(shownRows(table).map((row) => row[1])).toEqual(
      FIFTY_ITEMS.map((result) => result.identifier),
    );
    expect(server.searchRequests()).toEqual(['GET /v1/search/entities?limit=50&q=svc']);
  });

  it('keeps q as text', async () => {
    const server = createFakeServer();
    await renderApp('/search?q=2024', server);
    const main = await findMain();

    expect(
      await within(main).findByText(text('page.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(server.searchRequests()).toEqual(['GET /v1/search/entities?limit=50&q=2024']);
  });

  it('follows a new q in the URL with a new search', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/search?q=paym', server);
    const main = await findMain();
    const table = await findResults(main);
    await waitFor(() => {
      expect(shownRows(table)).toHaveLength(PAYM_ITEMS.length);
    });

    history.push('/search?q=ledger');

    await waitFor(() => {
      const results = screen.getByRole('table', { name: PINNED['page.title'] });
      expect(shownRows(results)).toEqual([['Ledger', 'ledger', 'Service']]);
    });
    expect(server.searchRequests()).toEqual([
      'GET /v1/search/entities?limit=50&q=paym',
      'GET /v1/search/entities?limit=50&q=ledger',
    ]);
  });

  it('opens the entity page of a result', async () => {
    const server = createFakeServer();
    const user = userEvent.setup();
    const { history } = await renderApp('/search?q=paym', server);
    const main = await findMain();
    const table = await findResults(main);

    await user.click(await within(table).findByRole('link', { name: 'payments-api' }));

    expect(await screen.findByTestId('page-entity', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/catalog/service/payments-api');
  });
});

describe('the search page with no query to send', () => {
  it.each<[string, string]>([
    ['no q', '/search'],
    ['an empty q', '/search?q='],
    ['a whitespace-only q', '/search?q=%20%20'],
    ['a q over 100 characters', `/search?q=${'a'.repeat(101)}`],
  ])('shows the prompt and sends no request for %s', async (_case, path) => {
    const server = createFakeServer();
    await renderApp(path, server);
    const main = await findMain();
    await findHeading(main);

    expect(
      await within(main).findByText(text('page.prompt'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await settle();
    expect(server.searchRequests()).toEqual([]);
    expect(within(main).queryByText(PINNED['page.tooShort'])).toBeNull();
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expect(within(main).queryByRole('alert')).toBeNull();
    expectNotLoading(main);
  });

  it.each<[string, string]>([
    ['a 1-character q', '/search?q=a'],
    ['a q of 1 character after trimming', '/search?q=%20a%20'],
  ])('shows the hint and sends no request for %s', async (_case, path) => {
    const server = createFakeServer();
    await renderApp(path, server);
    const main = await findMain();
    await findHeading(main);

    expect(
      await within(main).findByText(text('page.tooShort'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    await settle();
    expect(server.searchRequests()).toEqual([]);
    expect(within(main).queryByText(PINNED['page.prompt'])).toBeNull();
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expect(within(main).queryByRole('alert')).toBeNull();
    expectNotLoading(main);
  });
});

describe('the search page while it loads', () => {
  it('shows a busy status while the search is pending', async () => {
    const pending = deferred();
    const server = createFakeServer(() => pending.promise);
    await renderApp('/search?q=paym', server);
    const main = await findMain();

    const loading = text('page.loading');
    await waitFor(
      () => {
        expect(loadingIndicator(), `a status element showing "${loading}"`).toBeDefined();
      },
      { timeout: 3000 },
    );
    expect(loadingIndicator()?.closest('[aria-busy="true"]'), 'aria-busy="true"').not.toBe(null);
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expect(within(main).queryByRole('alert')).toBeNull();

    pending.resolve(jsonResponse(200, { items: PAYM_ITEMS }));

    const table = await findResults(main);
    await waitFor(() => {
      expect(shownRows(table)).toHaveLength(PAYM_ITEMS.length);
    });
    expectNotLoading(main);
  });
});

describe('the search page with an empty result', () => {
  it('shows the empty text and no row for a query that matches nothing', async () => {
    const server = createFakeServer();
    await renderApp('/search?q=nothing', server);
    const main = await findMain();
    await findHeading(main);

    expect(
      await within(main).findByText(text('page.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    const table = within(main).queryByRole('table');
    if (table !== null) expect(shownRows(table)).toEqual([]);
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(within(main).queryByRole('link', { name: /nothing/ })).toBeNull();
    expectNotLoading(main);
    expect(server.searchRequests()).toEqual(['GET /v1/search/entities?limit=50&q=nothing']);
  });

  it("Search never shows another tenant's entity", async () => {
    // GIVEN an entity `secret-svc` in tenant `t1` only: a user of `t1` finds it.
    const t1 = createFakeServer((q) =>
      jsonResponse(200, {
        items: q === 'secret' ? [item('service', 'secret-svc', 'Secret service')] : [],
      }),
    );
    await renderApp('/search?q=secret', t1);
    const t1Main = await findMain();
    const t1Table = await findResults(t1Main);
    await waitFor(() => {
      expect(shownRows(t1Table)).toEqual([['Secret service', 'secret-svc', 'Service']]);
    });
    cleanup();

    // WHEN a user of tenant `t2` searches for `secret` (the server answers no item).
    const t2 = createFakeServer(() => jsonResponse(200, { items: [] }));
    await renderApp('/search?q=secret', t2);
    const main = await findMain();

    // THEN no result is shown.
    expect(
      await within(main).findByText(text('page.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret-svc');
    expect(document.body.textContent).not.toContain('Secret service');
    expect(within(main).queryByRole('alert')).toBeNull();
  });
});

describe('the search page when the search fails', () => {
  it('shows the forbidden message, once and without retry, on AUTH_FORBIDDEN', async () => {
    const server = createFakeServer(() => forbidden());
    await renderApp('/search?q=paym', server);
    const main = await findMain();

    await expectErrorAlert(main, 'page.error.forbidden');
    await settle();
    expect(server.searchRequests()).toHaveLength(1);
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expectNotLoading(main);
    expectNoServerText();
  });

  it.each<[string, () => Promise<Response> | Response]>([
    ['a 500', () => internal()],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows the generic error after one retry on %s', async (_case, answer) => {
    const server = createFakeServer(answer);
    await renderApp('/search?q=paym', server);
    const main = await findMain();

    await expectErrorAlert(main, 'page.error.server');
    await settle();
    // D4: at most one retry on a network failure or a 5xx.
    expect(server.searchRequests()).toHaveLength(2);
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expectNotLoading(main);
    expectNoServerText();
  });

  it('shows the generic error, once and without retry, on any other kind', async () => {
    // The server refuses a query the page sent (for example a control code point).
    const server = createFakeServer(() => invalidQuery());
    await renderApp('/search?q=paym', server);
    const main = await findMain();

    await expectErrorAlert(main, 'page.error.server');
    await settle();
    expect(server.searchRequests()).toHaveLength(1);
    expect(within(main).queryByText(PINNED['page.empty'])).toBeNull();
    expectNotLoading(main);
    expectNoServerText();
  });

  it('shows the same rate-limit message, once and without retry, with or without Retry-After', async () => {
    const plain = createFakeServer(() => rateLimited());
    await renderApp('/search?q=paym', plain);
    const plainMain = await findMain();
    const plainAlert = await expectErrorAlert(plainMain, 'page.error.rateLimited');
    await settle();
    expect(plain.searchRequests()).toHaveLength(1);
    expect(within(plainMain).queryByText(PINNED['page.empty'])).toBeNull();
    expectNotLoading(plainMain);
    expectNoServerText();
    const plainText = plainAlert.textContent;
    cleanup();

    const withHeader = createFakeServer(() => rateLimited({ 'retry-after': '30' }));
    await renderApp('/search?q=paym', withHeader);
    const headerMain = await findMain();
    const headerAlert = await expectErrorAlert(headerMain, 'page.error.rateLimited');
    await settle();
    expect(withHeader.searchRequests()).toHaveLength(1);
    expectNoServerText();
    // Q63: the oRPC client never sees `Retry-After`, so the message is the same.
    expect(headerAlert.textContent).toBe(plainText);
  });

  it('sends the user to sign-in, keeping the search as returnTo, on an unauthenticated answer', async () => {
    const server = createFakeServer(() => unauthenticated());
    const { history } = await renderApp('/search?q=paym', server);

    expect(await screen.findByTestId('page-signIn', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    expect(urlSearch(history)).toEqual({ returnTo: '/search?q=paym' });
    expectNoServerText();
    expectStorageEmpty();
  });
});

describe('the search query is never stored', () => {
  it('leaves localStorage and sessionStorage empty while searching, following a new q and opening a result', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const server = createFakeServer();
    const user = userEvent.setup();
    const { history } = await renderApp('/search?q=paym', server);
    const main = await findMain();
    const table = await findResults(main);
    await waitFor(() => {
      expect(shownRows(table)).toHaveLength(PAYM_ITEMS.length);
    });
    expectStorageEmpty();

    history.push('/search?q=ledger');
    await waitFor(() => {
      const results = screen.getByRole('table', { name: PINNED['page.title'] });
      expect(shownRows(results)).toEqual([['Ledger', 'ledger', 'Service']]);
    });
    expectStorageEmpty();

    await user.click(screen.getByRole('link', { name: 'ledger' }));
    expect(await screen.findByTestId('page-entity', {}, { timeout: 3000 })).toBeInTheDocument();
    await settle();

    expectStorageEmpty();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('leaves both storages empty for a query too short to send', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const server = createFakeServer();
    await renderApp('/search?q=a', server);
    const main = await findMain();
    await within(main).findByText(text('page.tooShort'), {}, { timeout: 3000 });
    await settle();

    expectStorageEmpty();
    expect(setItem).not.toHaveBeenCalled();
  });
});
