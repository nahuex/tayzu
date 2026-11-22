/**
 * The catalog table's states (task 7.4, design D4, D6, D13, D15, D16 and Q63, Q68, Q69,
 * Q83; spec "The catalog table shows a blueprint's entities with sort and keyset paging"
 * and "The UI never carries the tenant, the cookie or tenant free text outside the page").
 *
 * Spec (requirement): "An unknown blueprint, including another tenant's, MUST show the
 * not-found page."
 * Spec, scenario "Another tenant's blueprint is not found": GIVEN a user of tenant `t2`,
 * WHEN they open the table URL of a blueprint that exists only in tenant `t1`, THEN the
 * app shows the not-found page.
 * Spec, scenario "An internal error shows no server text": GIVEN the API answers a call
 * with `INTERNAL` and a message, WHEN the app renders the failure, THEN the page shows the
 * generic localized error and not the message.
 * D13 (Table page): "An unknown blueprint, including another tenant's, is the same
 * not-found page. A denied list is an empty table, as the API answers."
 * D4: the closed error kinds; `not_found` is `CATALOG_NOT_FOUND`, "also every
 * cross-tenant answer"; "No retry on a 4xx, at most one retry on a network error or
 * 5xx"; "The UI renders localized text for each kind and never the server's message
 * string". Q63: a network failure is `server`; `Retry-After` reaches the model on plain
 * routes only (an `ORPCError` carries no headers).
 * D6: a cursor the server cannot use is `CATALOG_VALIDATION_FAILED` (issue path
 * `/cursor`); "the UI then restarts from the first page".
 * Q69: any `unauthenticated` answer of a query clears the cache and lands on
 * `/sign-in?returnTo=<path>`.
 * Server side: `entity.list` answers a denied Cerbos plan with `200 { items: [] }`
 * (`packages/catalog/src/service/entities.ts`, `planFilter.kind === 'denied'`), and both
 * `blueprint.get` and `entity.list` answer an unknown blueprint of the caller's tenant,
 * whether it exists in another tenant or nowhere, with `CATALOG_NOT_FOUND`.
 *
 * Decisions this test pins:
 *
 * - Loading: while `blueprints.get` or `entities.list` is pending, the page shows an
 *   element with the `status` role whose text is `catalog:table.loading`, and that element
 *   or an ancestor carries `aria-busy="true"`. It never shows the empty text while
 *   loading. Once the page has its answer, neither the text nor `aria-busy="true"` stays
 *   in `main`.
 * - Empty: an answer with no items keeps the table (named by the blueprint title, D16)
 *   and shows `catalog:table.empty`; "Previous" and "Next" are disabled. A denied list is
 *   the same `200 { items: [] }`, so the page shows exactly what an empty blueprint
 *   shows: no alert and no hint that anything is hidden.
 * - Not found: a `not_found` answer of either call renders the real not-found page
 *   (`common:notFound.*`, its home link) inside the shell's `main`, with no table, no
 *   blueprint title and no error alert; the URL stays as opened. Another tenant's
 *   blueprint and a blueprint that exists nowhere render the same `main`, which never
 *   echoes the identifier.
 * - Errors: one `role="alert"` in `main` with the localized text of the kind, never the
 *   empty text and never a server string:
 *   - `forbidden` (`AUTH_FORBIDDEN`, on either call): `catalog:table.error.forbidden`;
 *   - `server` (a 5xx or a network failure, on either call): `catalog:table.error.server`
 *     after exactly one retry (D4), so the failing call is sent twice;
 *   - `rate_limited` (`429`): `catalog:table.error.rateLimited`, sent once, the same text
 *     with or without `Retry-After` (Q63: the oRPC client never sees the header);
 *   - `validation` on `/cursor`: no message is required; the page restarts from the first
 *     page (the cursor leaves the URL, the first page's rows are shown, "Previous" is
 *     disabled), the refused cursor is sent once and never again;
 *   - `unauthenticated` (`401`): the shell's handling, `/sign-in?returnTo=/catalog/<id>`.
 * - A 4xx answer is never retried: each failing table call is sent once.
 * - English texts: `catalog:table.loading` "Loading entities...",
 *   `catalog:table.empty` "No entities yet.", `catalog:table.error.forbidden` "You do not
 *   have permission to view this blueprint.", `catalog:table.error.server` "The entities
 *   could not be loaded. Try again later." and `catalog:table.error.rateLimited` "Too
 *   many requests. Wait a moment and try again." (the key-parity test keeps `es`
 *   complete).
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), and the
 * query client is `createQueryClient()` (D4's retry policy, as `main.tsx`) with no retry
 * delay.
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
function englishText(namespace: 'catalog' | 'common', key: string): string {
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

/** The pinned English texts of this task's `catalog:table.*` keys. */
const PINNED = {
  'table.loading': 'Loading entities...',
  'table.empty': 'No entities yet.',
  'table.error.forbidden': 'You do not have permission to view this blueprint.',
  'table.error.server': 'The entities could not be loaded. Try again later.',
  'table.error.rateLimited': 'Too many requests. Wait a moment and try again.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = englishText('catalog', key);
  expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

const ACTOR = { type: 'user', id: 'u_1' } as const;

const ME = {
  user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'password',
  mfa: { enrolled: false },
  gate: 'none',
} as const;

interface Blueprint {
  readonly identifier: string;
  readonly title: { en: string; es?: string };
  readonly [key: string]: unknown;
}

function blueprint(identifier: string, title: { en: string; es?: string }): Blueprint {
  return {
    identifier,
    title,
    schema: {
      properties: { tier: { type: 'string', title: { en: 'Tier', es: 'Nivel' } } },
      required: [],
    },
    relations: {},
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-01T10:00:00.000Z',
    updatedBy: ACTOR,
  };
}

const SERVICE = blueprint('service', { en: 'Service', es: 'Servicio' });
const TEAM = blueprint('_team', { en: 'Team', es: 'Equipo' });
/** A blueprint of tenant `t1` only. */
const BILLING = blueprint('billing', { en: 'Billing ledger', es: 'Libro de facturación' });

interface Entity {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly [key: string]: unknown;
}

function entity(blueprintId: string, index: number): Entity {
  return {
    blueprint: blueprintId,
    identifier: `${blueprintId}-${String(index).padStart(3, '0')}`,
    title: `${blueprintId} ${String(index)}`,
    spec: { properties: { tier: 'gold' }, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: ACTOR,
  };
}

/** 120 `service` entities, so the default page size (50) has a next page. */
const SERVICES: readonly Entity[] = Array.from({ length: 120 }, (_, i) => entity('service', i + 1));
const BILLING_ENTITIES: readonly Entity[] = Array.from({ length: 3 }, (_, i) =>
  entity('billing', i + 1),
);

/** What each tenant holds. A session belongs to one tenant; the server decides which. */
const TENANTS = {
  t1: {
    blueprints: [BILLING, TEAM],
    entities: { billing: BILLING_ENTITIES } as Record<string, readonly Entity[]>,
  },
  t2: {
    blueprints: [SERVICE, TEAM],
    entities: { service: SERVICES } as Record<string, readonly Entity[]>,
  },
} as const;

type Tenant = keyof typeof TENANTS;

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entities" on 10.0.0.7';

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

const notFound = (): Response => errorResponse(404, 'CATALOG_NOT_FOUND');
const forbidden = (): Response => errorResponse(403, 'AUTH_FORBIDDEN');
const internal = (): Response => errorResponse(500, 'INTERNAL_SERVER_ERROR');
const unauthenticated = (): Response => errorResponse(401, 'UNAUTHORIZED');
const rateLimited = (headers: Record<string, string> = {}): Response =>
  errorResponse(429, 'AUTH_RATE_LIMITED', { headers });
const invalidCursor = (): Response =>
  errorResponse(400, 'CATALOG_VALIDATION_FAILED', {
    data: { issues: [{ path: '/cursor', message: SERVER_TEXT }] },
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

/** The table call a request is: `get` (`blueprints.get`) or `list` (`entities.list`). */
type TableCall = 'get' | 'list';

/**
 * Overrides the answer of a table call; `undefined` keeps the tenant's answer. A promise
 * that is not settled yet keeps the call pending.
 */
type Override = (
  call: TableCall,
  blueprintId: string,
  search: URLSearchParams,
) => Response | Promise<Response> | undefined;

/** The default `entities.list`: identifier order, keyset after the anchor identifier. */
function listEntities(entities: readonly Entity[], search: URLSearchParams): Response {
  const pageSize = Number(search.get('pageSize') ?? '50');
  const rows = [...entities].sort((a, b) => compareText(a.identifier, b.identifier));
  const cursor = search.get('cursor');
  let start = 0;
  if (cursor !== null) {
    const anchor = rows.findIndex((row) => `cur-${row.identifier}` === cursor);
    if (anchor === -1) return invalidCursor();
    start = anchor + 1;
  }
  const items = rows.slice(start, start + pageSize);
  const last = items.at(-1);
  const more = start + pageSize < rows.length && last !== undefined;
  return jsonResponse(200, { items, ...(more ? { cursor: `cur-${last.identifier}` } : {}) });
}

/**
 * A fake `fetch` playing the API for a signed-in member of `tenant`: `GET /v1/me`,
 * `blueprints.list` (the sidebar), `blueprints.get` and `entities.list`. A blueprint the
 * tenant does not hold is `CATALOG_NOT_FOUND` on both table calls, as the server answers.
 */
function createFakeServer(options: { tenant?: Tenant; override?: Override } = {}) {
  const held = TENANTS[options.tenant ?? 't2'];
  const requests: string[] = [];

  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname, searchParams } = new URL(request.url);
    requests.push(describeRequest(request.method, pathname, searchParams));

    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: held.blueprints });
    const match = /^\/v1\/blueprints\/([^/]+)(\/entities)?$/.exec(pathname);
    if (match?.[1] === undefined) return notFound();
    const blueprintId = match[1];
    const call: TableCall = match[2] === undefined ? 'get' : 'list';

    const overridden = options.override?.(call, blueprintId, searchParams);
    if (overridden !== undefined) return overridden;

    const found = held.blueprints.find((item) => item.identifier === blueprintId);
    if (found === undefined) return notFound();
    if (call === 'get') return jsonResponse(200, found);
    return listEntities(held.entities[blueprintId] ?? [], searchParams);
  };

  return {
    fetch,
    /** The `blueprints.get` requests for `blueprintId`. */
    getRequests(blueprintId: string): string[] {
      return requests.filter((line) => line === `GET /v1/blueprints/${blueprintId}`);
    },
    /** The `entities.list` requests for `blueprintId`, in order. */
    listRequests(blueprintId: string): string[] {
      const prefix = `GET /v1/blueprints/${blueprintId}/entities`;
      return requests.filter((line) => line === prefix || line.startsWith(`${prefix}?`));
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

/** Every slot but `catalogTable` is a probe, so the table slot keeps its default page. */
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

function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

/** The `status` element showing the loading text, if any. */
function loadingIndicator(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((element) => element.textContent.includes(PINNED['table.loading']));
}

/** Waits until the busy indicator is shown, and checks that it is announced as busy. */
async function expectLoading(): Promise<void> {
  const loading = text('table.loading');
  await waitFor(
    () => {
      expect(loadingIndicator(), `a status element showing "${loading}"`).toBeDefined();
    },
    { timeout: 3000 },
  );
  const indicator = loadingIndicator();
  expect(indicator?.closest('[aria-busy="true"]'), 'aria-busy="true" on it or above').not.toBe(
    null,
  );
}

/** Nothing in `main` is still loading. */
function expectNotLoading(main: HTMLElement): void {
  expect(within(main).queryByText(PINNED['table.loading'])).toBeNull();
  expect(main.querySelector('[aria-busy="true"]')).toBeNull();
}

/** The body rows of the table, in order. */
function bodyRows(table: HTMLElement): HTMLTableRowElement[] {
  return within(table)
    .queryAllByRole('row')
    .filter(
      (row): row is HTMLTableRowElement =>
        row instanceof HTMLTableRowElement && row.closest('tbody') !== null,
    );
}

/** The entity identifiers the table shows, in order (links and plain text alike). */
function shownIdentifiers(table: HTMLElement): string[] {
  return bodyRows(table)
    .map((row) => row.cells[0]?.textContent.trim() ?? '')
    .filter((cell) => /^[a-z_]+-\d{3}$/.test(cell));
}

function pagerButtons() {
  return {
    previous: screen.getByRole('button', {
      name: englishText('catalog', 'table.pagination.previous'),
    }),
    next: screen.getByRole('button', { name: englishText('catalog', 'table.pagination.next') }),
  };
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

/** The real not-found page, inside the shell's `main` (D12, D13). */
async function expectNotFoundPage(main: HTMLElement): Promise<void> {
  expect(
    await within(main).findByRole(
      'heading',
      { level: 1, name: englishText('common', 'notFound.title') },
      { timeout: 3000 },
    ),
  ).toBeInTheDocument();
  expect(within(main).getByText(englishText('common', 'notFound.description'))).toBeInTheDocument();
  expect(
    within(main).getByRole('link', { name: englishText('common', 'notFound.home') }),
  ).toHaveAttribute('href', '/');
  // Still the shell around it.
  expect(screen.getByRole('banner')).toBeInTheDocument();
  expect(
    screen.getByRole('navigation', { name: englishText('common', 'nav.catalog') }),
  ).toBeInTheDocument();
  // Nothing of the table and no error.
  expect(within(main).queryByRole('table')).toBeNull();
  expect(within(main).queryByRole('alert')).toBeNull();
  expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
  expectNotLoading(main);
}

/** Lets pending retries and effects run before counting requests. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// jsdom gaps

/** Methods the Radix select and tooltip call that jsdom does not implement. */
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
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests

describe('the table page while it loads', () => {
  it('shows a busy status while the blueprint and its first page are pending', async () => {
    const blueprintAnswer = deferred();
    const listAnswer = deferred();
    const server = createFakeServer({
      override: (call) => (call === 'get' ? blueprintAnswer.promise : listAnswer.promise),
    });
    await renderApp('/catalog/service', server);
    const main = await findMain();

    await expectLoading();
    expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
    expect(within(main).queryByRole('alert')).toBeNull();

    blueprintAnswer.resolve(jsonResponse(200, SERVICE));
    listAnswer.resolve(listEntities(SERVICES, new URLSearchParams({ pageSize: '50' })));

    const table = await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });
    await waitFor(() => {
      expect(shownIdentifiers(table)).toHaveLength(50);
    });
    expectNotLoading(main);
  });

  it('stays busy, and never shows the empty text, while only the page is pending', async () => {
    const listAnswer = deferred();
    const server = createFakeServer({
      override: (call) => (call === 'list' ? listAnswer.promise : undefined),
    });
    await renderApp('/catalog/service', server);
    const main = await findMain();

    await waitFor(() => {
      expect(server.getRequests('service')).toHaveLength(1);
      expect(server.listRequests('service')).toHaveLength(1);
    });
    await settle();
    await expectLoading();
    expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
    expect(within(main).queryByRole('alert')).toBeNull();

    listAnswer.resolve(jsonResponse(200, { items: [] }));

    expect(await within(main).findByText(text('table.empty'))).toBeInTheDocument();
    expectNotLoading(main);
  });
});

describe('the table page with no entities to show', () => {
  it('shows the empty text in the table of a blueprint with no entities', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'list' ? jsonResponse(200, { items: [] }) : undefined),
    });
    await renderApp('/catalog/service', server);
    const main = await findMain();

    expect(
      await within(main).findByText(text('table.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(within(main).getByRole('heading', { level: 1, name: 'Service' })).toBeInTheDocument();
    const table = within(main).getByRole('table', { name: 'Service' });
    expect(shownIdentifiers(table)).toEqual([]);
    expect(within(main).queryByRole('alert')).toBeNull();
    expectNotLoading(main);
    const { previous, next } = pagerButtons();
    expect(previous).toBeDisabled();
    expect(next).toBeDisabled();
  });

  it('shows a denied list exactly as an empty one, with no error and no hint', async () => {
    // The tenant holds 120 `service` entities, but the caller's Cerbos plan is denied:
    // `entity.list` answers `200 { items: [] }`, as `planFilter.kind === 'denied'` does.
    const denied = createFakeServer({
      override: (call) => (call === 'list' ? jsonResponse(200, { items: [] }) : undefined),
    });
    await renderApp('/catalog/service', denied);
    const deniedMain = await findMain();
    expect(
      await within(deniedMain).findByText(text('table.empty'), {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(within(deniedMain).getByRole('table', { name: 'Service' })).toBeInTheDocument();
    expect(within(deniedMain).queryByRole('alert')).toBeNull();
    expect(within(deniedMain).queryByText(PINNED['table.error.forbidden'])).toBeNull();
    expectNotLoading(deniedMain);
    expectNoServerText();
    const deniedText = deniedMain.textContent;
    cleanup();

    // A blueprint that really holds no entity.
    const empty = createFakeServer({
      override: (call, _blueprint, search) =>
        call === 'list' ? listEntities([], search) : undefined,
    });
    await renderApp('/catalog/service', empty);
    const emptyMain = await findMain();
    await within(emptyMain).findByText(text('table.empty'), {}, { timeout: 3000 });

    expect(emptyMain.textContent).toBe(deniedText);
  });
});

describe('the table page for a blueprint the tenant does not hold', () => {
  it("Another tenant's blueprint is not found", async () => {
    // GIVEN a blueprint that exists only in tenant `t1`: its table opens there.
    const t1 = createFakeServer({ tenant: 't1' });
    await renderApp('/catalog/billing', t1);
    expect(
      await screen.findByRole('table', { name: 'Billing ledger' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    cleanup();

    // WHEN a user of tenant `t2` opens the same table URL (a `CATALOG_NOT_FOUND` answer).
    const t2 = createFakeServer({ tenant: 't2' });
    const { history } = await renderApp('/catalog/billing', t2);
    const main = await findMain();

    // THEN the app shows the not-found page.
    await expectNotFoundPage(main);
    await settle();
    expect(document.body.textContent).not.toContain('Billing ledger');
    expect(main.textContent).not.toContain('billing');
    expect(history.location.pathname).toBe('/catalog/billing');
    // D4: a 4xx is never retried.
    expect(t2.getRequests('billing').length).toBeLessThanOrEqual(1);
    expect(t2.listRequests('billing').length).toBeLessThanOrEqual(1);
    expect(t2.getRequests('billing').length + t2.listRequests('billing').length).toBeGreaterThan(0);
    expectNoServerText();
    const crossTenantText = main.textContent;
    cleanup();

    // The same page as a blueprint that exists in no tenant.
    const nowhere = createFakeServer({ tenant: 't2' });
    await renderApp('/catalog/nowhere', nowhere);
    const nowhereMain = await findMain();
    await expectNotFoundPage(nowhereMain);
    expect(nowhereMain.textContent).toBe(crossTenantText);
  });

  it('shows the not-found page when only entities.list answers CATALOG_NOT_FOUND', async () => {
    // The blueprint is read, then deleted before its entities are listed.
    const server = createFakeServer({
      override: (call) => (call === 'list' ? notFound() : undefined),
    });
    const { history } = await renderApp('/catalog/service', server);
    const main = await findMain();

    await expectNotFoundPage(main);
    await settle();
    expect(within(main).queryByRole('heading', { name: 'Service' })).toBeNull();
    expect(within(main).queryByText('Service')).toBeNull();
    expect(history.location.pathname).toBe('/catalog/service');
    expect(server.listRequests('service')).toHaveLength(1);
    expectNoServerText();
  });

  it('shows the not-found page when only blueprints.get answers CATALOG_NOT_FOUND', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'get' ? notFound() : undefined),
    });
    await renderApp('/catalog/service', server);
    const main = await findMain();

    await expectNotFoundPage(main);
    await settle();
    expect(within(main).queryByText(/service-\d{3}/)).toBeNull();
    expect(server.getRequests('service')).toHaveLength(1);
    expectNoServerText();
  });
});

describe('the table page when a call fails', () => {
  it.each<TableCall>(['get', 'list'])(
    'shows the forbidden message, once and without retry, when %s answers AUTH_FORBIDDEN',
    async (failing) => {
      const server = createFakeServer({
        override: (call) => (call === failing ? forbidden() : undefined),
      });
      await renderApp('/catalog/service', server);
      const main = await findMain();

      await expectErrorAlert(main, 'table.error.forbidden');
      await settle();
      expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
      expect(within(main).queryByText(/service-\d{3}/)).toBeNull();
      expectNotLoading(main);
      const sent =
        failing === 'get' ? server.getRequests('service') : server.listRequests('service');
      expect(sent).toHaveLength(1);
      expectNoServerText();
    },
  );

  it.each<[TableCall, string]>([
    ['get', 'a 500'],
    ['list', 'a 500'],
    ['get', 'a network failure'],
    ['list', 'a network failure'],
  ])(
    'shows the generic error and no server text after one retry when %s answers %s',
    async (failing, answer) => {
      const server = createFakeServer({
        override: (call) => {
          if (call !== failing) return undefined;
          return answer === 'a 500' ? internal() : Promise.reject(new TypeError('Failed to fetch'));
        },
      });
      await renderApp('/catalog/service', server);
      const main = await findMain();

      await expectErrorAlert(main, 'table.error.server');
      await settle();
      // D4: at most one retry on a network failure or a 5xx.
      const sent =
        failing === 'get' ? server.getRequests('service') : server.listRequests('service');
      expect(sent).toHaveLength(2);
      expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
      expect(within(main).queryByText(/service-\d{3}/)).toBeNull();
      expectNotLoading(main);
      expectNoServerText();
    },
  );

  it('shows the same rate-limit message, once and without retry, with or without Retry-After', async () => {
    const plain = createFakeServer({
      override: (call) => (call === 'list' ? rateLimited() : undefined),
    });
    await renderApp('/catalog/service', plain);
    const plainMain = await findMain();
    const plainAlert = await expectErrorAlert(plainMain, 'table.error.rateLimited');
    await settle();
    expect(plain.listRequests('service')).toHaveLength(1);
    expect(within(plainMain).queryByText(PINNED['table.empty'])).toBeNull();
    expectNotLoading(plainMain);
    expectNoServerText();
    const plainText = plainAlert.textContent;
    cleanup();

    const withHeader = createFakeServer({
      override: (call) => (call === 'list' ? rateLimited({ 'retry-after': '30' }) : undefined),
    });
    await renderApp('/catalog/service', withHeader);
    const headerMain = await findMain();
    const headerAlert = await expectErrorAlert(headerMain, 'table.error.rateLimited');
    await settle();
    expect(withHeader.listRequests('service')).toHaveLength(1);
    expectNoServerText();
    // Q63: the oRPC client never sees `Retry-After`, so the message is the same.
    expect(headerAlert.textContent).toBe(plainText);
  });

  it('restarts from the first page when the cursor answers CATALOG_VALIDATION_FAILED on /cursor', async () => {
    // Every cursor is refused, as D6 refuses an anchor deleted meanwhile.
    const server = createFakeServer({
      override: (call, _blueprint, search) =>
        call === 'list' && search.has('cursor') ? invalidCursor() : undefined,
    });
    const user = userEvent.setup();
    const { history } = await renderApp('/catalog/service', server);
    const main = await findMain();
    const table = await within(main).findByRole('table', { name: 'Service' }, { timeout: 3000 });
    const firstPage = SERVICES.slice(0, 50).map((item) => item.identifier);
    await waitFor(() => {
      expect(shownIdentifiers(table)).toEqual(firstPage);
    });
    const before = server.listRequests('service').length;

    await user.click(pagerButtons().next);

    const refused = 'cursor=cur-service-050';
    await waitFor(() => {
      expect(server.listRequests('service').some((line) => line.includes(refused))).toBe(true);
    });
    await waitFor(() => {
      expect(urlSearch(history)).toEqual({});
    });
    await waitFor(() => {
      expect(shownIdentifiers(screen.getByRole('table', { name: 'Service' }))).toEqual(firstPage);
    });
    await settle();
    expect(history.location.pathname).toBe('/catalog/service');
    expect(pagerButtons().previous).toBeDisabled();
    // The refused cursor is sent once (no retry on a 4xx) and never again.
    const after = server.listRequests('service').slice(before);
    expect(after.filter((line) => line.includes(refused))).toHaveLength(1);
    const refusalIndex = after.findIndex((line) => line.includes(refused));
    expect(after.slice(refusalIndex + 1).filter((line) => line.includes('cursor='))).toEqual([]);
    expect(within(main).queryByText(PINNED['table.empty'])).toBeNull();
    expectNotLoading(main);
    expectNoServerText();
  });

  it('sends the user to sign-in, keeping the table as returnTo, on an unauthenticated answer', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'list' ? unauthenticated() : undefined),
    });
    const { history } = await renderApp('/catalog/service', server);

    expect(await screen.findByTestId('page-signIn', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    expect(urlSearch(history)).toEqual({ returnTo: '/catalog/service' });
    expectNoServerText();
  });
});
