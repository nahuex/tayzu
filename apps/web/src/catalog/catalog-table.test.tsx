/**
 * The catalog table page (task 7.3, design D4, D12, D13, D16 and Q36, Q67, Q68, Q69;
 * spec "The catalog table shows a blueprint's entities with sort and keyset paging").
 *
 * Spec (requirement): "It MUST page with the API's cursor, sort by identifier, title or
 * update time in either direction, keep the sort, order, page size and cursor in the URL,
 * and reset the cursor when the sort changes."
 * Spec, scenario "Sort by title and page forward": GIVEN a blueprint with 120 readable
 * entities, WHEN the user sorts by title descending and moves to the next page, THEN the
 * second page continues the descending order with no gap and no repeat.
 * D13 (Table page): "`entities.list` with `sort`, `order`, `pageSize` (25, 50 or 100) and
 * `cursor` from the URL. "Next" follows the returned cursor; "Previous" pops a stack of
 * earlier cursors kept in memory, and a reload restarts from the first page of the same
 * sort. Sortable headers (identifier, title, updated) are buttons with `aria-sort`;
 * changing the sort clears the cursor."
 * D6: `sort` is `identifier`, `title` or `updatedAt`, `order` is `asc` or `desc`; the
 * cursor is bound to its sort and order. Contract: `entities.list` is
 * `GET /v1/blueprints/{blueprint}/entities` and answers `{ items, cursor? }`.
 * Q68: the table route strips its default search values from the URL (`sort=identifier`,
 * `order=asc`, `pageSize=50`).
 * D13 (Q18, narrowed by Q36): an identifier with `/` or made only of dots "is listed, but
 * its link is disabled with a localized note"; one with `@`, `:` or `=` opens normally,
 * with no `%` in its path.
 *
 * Decisions this test pins:
 *
 * - The page is the default `catalogTable` slot of `createAppRouter` (this file passes
 *   no `catalogTable` page). It reads the catalog through the `shell.apiClient` given to
 *   `createAppRouter`, so the app renders exactly as `main.tsx` renders it today (I18n,
 *   QueryClient, AuthClientProvider, RouterProvider) and no other provider is needed.
 * - Every `entities.list` call sends `sort`, `order` and `pageSize` explicitly (the
 *   validated URL values, defaults included), and `cursor` only when there is one. The
 *   blueprint is read once (`blueprints.get`) while the sort and the pages change.
 * - The cursor stack: "Next" pushes the current cursor (none on the first page) and
 *   navigates to the returned one; "Previous" pops it. "Previous" is disabled on the first
 *   page, "Next" when the answer has no cursor. A sort, order or page-size change clears
 *   the cursor and the stack, and so does opening another blueprint.
 * - A reload (a first render with a `cursor` in the URL and so an empty stack) restarts
 *   from the first page of the same sort, order and page size, as D13 says: the stale
 *   cursor is never sent and leaves the URL.
 * - Sorting: a header button chooses its column ascending; the current column's button
 *   toggles the order. Only identifier, title and updated are sortable (the API's three
 *   keys); property and relation headers carry no button and no `aria-sort`. The sorted
 *   header's `aria-sort` is `ascending` or `descending`; the other sortable headers carry
 *   `none` or no `aria-sort` (ARIA lets an author apply it to one header only), which this
 *   test reads alike.
 * - The page-size control is a combobox named `catalog:table.pageSize.label` holding
 *   25, 50 and 100: a native `<select>` or the Radix select of D3, both driven here.
 * - Texts: `catalog:table.pagination.previous`, `catalog:table.pagination.next`,
 *   `catalog:table.pageSize.label` and `catalog:table.notAddressable` (the note shown as
 *   text in the row of an identifier that cannot be opened), in both locales.
 * - The page heading (level 1) is the localized blueprint title, and the table's
 *   accessible name (its caption, D16) is that title too.
 * - The identifier cell links to `/catalog/<blueprint>/<identifier>` when
 *   `isAddressableIdentifier` allows it; otherwise the identifier is plain text, the row
 *   has no link with an `href`, and the note is shown.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16). It sorts and
 * pages like the API (keyset after the anchor row, `identifier` as the tiebreaker) and
 * refuses a cursor of another sort or order, as D6 does.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n, type Locale } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

/** The `catalog` locale files, keyed `../i18n/locales/<lng>/catalog.json`. */
const CATALOG_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/catalog.json', {
  eager: true,
  import: 'default',
});

/** The `catalog:<key>` text of `locale`; a missing key fails the test as an assertion. */
function catalogText(locale: Locale, key: string): string {
  let node: unknown = CATALOG_FILES[`../i18n/locales/${locale}/catalog.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `catalog:${key} in ${locale}`).toBe(true);
  return node as string;
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

function blueprint(
  identifier: string,
  title: { en: string; es?: string },
  shape: { properties?: Record<string, unknown>; relations?: Record<string, unknown> } = {},
) {
  return {
    identifier,
    title,
    schema: { properties: shape.properties ?? {}, required: [] },
    relations: shape.relations ?? {},
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-01T10:00:00.000Z',
    updatedBy: ACTOR,
  };
}

/** `service` has a property of each kind the headers need and one relation. */
const SERVICE = blueprint(
  'service',
  { en: 'Service', es: 'Servicio' },
  {
    properties: {
      tier: { type: 'string', title: { en: 'Tier', es: 'Nivel' }, enum: ['gold', 'silver'] },
      replicas: { type: 'integer', title: { en: 'Replicas', es: 'Réplicas' } },
    },
    relations: {
      ownedBy: {
        title: { en: 'Owned by', es: 'Equipo dueño' },
        target: '_team',
        many: false,
        required: false,
      },
    },
  },
);

const TEAM = blueprint('_team', { en: 'Team', es: 'Equipo' });

const BLUEPRINTS = [TEAM, SERVICE];

interface Entity {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly [key: string]: unknown;
}

const BASE_TIME = Date.parse('2026-10-01T00:00:00.000Z');

function entity(
  blueprintId: string,
  identifier: string,
  title: string,
  minute: number,
  spec: { properties?: Record<string, unknown>; relations?: Record<string, unknown> } = {},
): Entity {
  const updatedAt = new Date(BASE_TIME + minute * 60_000).toISOString();
  return {
    blueprint: blueprintId,
    identifier,
    title,
    spec: { properties: spec.properties ?? {}, relations: spec.relations ?? {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: ACTOR,
    updatedAt,
    updatedBy: ACTOR,
  };
}

/**
 * 120 readable `service` entities. Identifier, title and update time are three different
 * orders (37 and 53 are coprime with 120), so each sort shows a different first page.
 */
const SERVICES: readonly Entity[] = Array.from({ length: 120 }, (_, i) =>
  entity(
    'service',
    `svc-${String(i + 1).padStart(3, '0')}`,
    `Service ${String((i * 37) % 120).padStart(3, '0')}`,
    (i * 53) % 120,
    { properties: { tier: 'gold', replicas: i }, relations: { ownedBy: 'platform' } },
  ),
);

const TEAMS: readonly Entity[] = Array.from({ length: 3 }, (_, i) =>
  entity('_team', `team-${String(i + 1)}`, `Team ${String(i + 1)}`, i),
);

type Sort = 'identifier' | 'title' | 'updatedAt';
type Order = 'asc' | 'desc';

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The API's order: the sort key, then `identifier`, both in `order` (D6). */
function ordered(entities: readonly Entity[], sort: Sort, order: Order): Entity[] {
  const sorted = [...entities].sort(
    (a, b) => compareText(a[sort], b[sort]) || compareText(a.identifier, b.identifier),
  );
  return order === 'asc' ? sorted : sorted.reverse();
}

/** The fake API's opaque cursor: bound to its sort and order, anchored on a row (D6). */
function cursorAfter(sort: Sort, order: Order, identifier: string): string {
  return `cur-${sort}-${order}-${identifier}`;
}

const CURSOR_PATTERN = /^cur-(identifier|title|updatedAt)-(asc|desc)-(.+)$/;

function identifiersOf(entities: readonly Entity[]): string[] {
  return entities.map((item) => item.identifier);
}

/** Page `index` (0-based) of `entities` in `sort` and `order`, `size` rows per page. */
function pageOf(
  entities: readonly Entity[],
  sort: Sort,
  order: Order,
  size: number,
  index: number,
): Entity[] {
  return ordered(entities, sort, order).slice(index * size, (index + 1) * size);
}

/** The cursor the API returns after page `index` of `entities`. */
function cursorAfterPage(
  entities: readonly Entity[],
  sort: Sort,
  order: Order,
  size: number,
  index: number,
): string {
  const last = pageOf(entities, sort, order, size, index).at(-1);
  if (last === undefined) throw new Error('No such page');
  return cursorAfter(sort, order, last.identifier);
}

// ---------------------------------------------------------------------------
// The fake API

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function validationFailed(path: string): Response {
  return jsonResponse(400, {
    defined: false,
    code: 'CATALOG_VALIDATION_FAILED',
    status: 400,
    message: 'Validation failed',
    data: { issues: [{ path, message: 'invalid' }] },
  });
}

function notFound(): Response {
  return jsonResponse(404, {
    defined: false,
    code: 'CATALOG_NOT_FOUND',
    status: 404,
    message: 'Not found',
  });
}

/** One request, as `METHOD /path?query` with the query keys sorted. */
function describeRequest(method: string, pathname: string, search: URLSearchParams): string {
  const sorted = new URLSearchParams(
    [...search.entries()].sort(([a], [b]) => compareText(a, b)),
  ).toString();
  return `${method} ${pathname}${sorted === '' ? '' : `?${sorted}`}`;
}

/** The `entities.list` request the page should send. */
function listRequest(
  blueprintId: string,
  query: { sort: Sort; order: Order; pageSize: number; cursor?: string },
): string {
  const search = new URLSearchParams({
    sort: query.sort,
    order: query.order,
    pageSize: String(query.pageSize),
  });
  if (query.cursor !== undefined) search.set('cursor', query.cursor);
  return describeRequest('GET', `/v1/blueprints/${blueprintId}/entities`, search);
}

function getBlueprintRequest(blueprintId: string): string {
  return `GET /v1/blueprints/${blueprintId}`;
}

function listEntities(entities: readonly Entity[], search: URLSearchParams): Response {
  const sort = (search.get('sort') ?? 'identifier') as Sort;
  const order = (search.get('order') ?? 'asc') as Order;
  if (!['identifier', 'title', 'updatedAt'].includes(sort)) return validationFailed('/sort');
  if (!['asc', 'desc'].includes(order)) return validationFailed('/order');
  const pageSize = Number(search.get('pageSize') ?? '50');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    return validationFailed('/pageSize');
  }

  const rows = ordered(entities, sort, order);
  let start = 0;
  const cursor = search.get('cursor');
  if (cursor !== null) {
    const match = CURSOR_PATTERN.exec(cursor);
    if (match?.[1] !== sort || match[2] !== order) return validationFailed('/cursor');
    const anchor = rows.findIndex((row) => row.identifier === match[3]);
    if (anchor === -1) return validationFailed('/cursor');
    start = anchor + 1;
  }
  const items = rows.slice(start, start + pageSize);
  const last = items.at(-1);
  const more = start + pageSize < rows.length && last !== undefined;
  return jsonResponse(200, {
    items,
    ...(more ? { cursor: cursorAfter(sort, order, last.identifier) } : {}),
  });
}

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me`, `blueprints.list`
 * (the sidebar), `blueprints.get` and `entities.list` over `entities` per blueprint.
 */
function createFakeServer(entities: Readonly<Record<string, readonly Entity[]>>) {
  const requests: string[] = [];

  const fetch = (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    requests.push(describeRequest(request.method, pathname, searchParams));

    if (request.method !== 'GET') return Promise.resolve(jsonResponse(405, {}));
    if (pathname === '/v1/me') return Promise.resolve(jsonResponse(200, ME));
    if (pathname === '/v1/blueprints') {
      return Promise.resolve(jsonResponse(200, { items: BLUEPRINTS }));
    }
    const match = /^\/v1\/blueprints\/([^/]+)(\/entities)?$/.exec(pathname);
    const found = BLUEPRINTS.find((item) => item.identifier === match?.[1]);
    if (match === null || found === undefined) return Promise.resolve(notFound());
    if (match[2] === undefined) return Promise.resolve(jsonResponse(200, found));
    return Promise.resolve(listEntities(entities[found.identifier] ?? [], searchParams));
  };

  return {
    fetch,
    /** The requests of the table page: `blueprints.get` and `entities.list`. */
    tableRequests(): string[] {
      return requests.filter((line) => /^GET \/v1\/blueprints\/[^/?]+/.test(line));
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

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

/** Renders the whole app (session gate, shell and providers, as `main.tsx`) at `path`. */
async function renderApp(path: string, server: FakeServer): Promise<{ history: RouterHistory }> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
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

/** The URL's search params as a plain object. */
function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

/** The table, found by its accessible name (the localized blueprint title). */
function table(name = 'Service'): HTMLElement {
  return screen.getByRole('table', { name });
}

/** The body rows of the table, in order. */
function bodyRows(name = 'Service'): HTMLTableRowElement[] {
  return within(table(name))
    .queryAllByRole('row')
    .filter(
      (row): row is HTMLTableRowElement =>
        row instanceof HTMLTableRowElement && row.closest('tbody') !== null,
    );
}

/** The identifier column (the first one) of each body row, in order. */
function shownIdentifiers(name = 'Service'): string[] {
  return bodyRows(name).map((row) => row.cells[0]?.textContent.trim() ?? '');
}

/** Waits until the table shows exactly `expected`, in order. */
async function expectRows(expected: readonly Entity[], name = 'Service'): Promise<void> {
  await waitFor(() => {
    expect(shownIdentifiers(name)).toEqual(identifiersOf(expected));
  });
}

function header(name: string): HTMLElement {
  return screen.getByRole('columnheader', { name });
}

/** The sort state a header announces; no `aria-sort` reads as `none`. */
function sortState(name: string): string {
  return header(name).getAttribute('aria-sort') ?? 'none';
}

function sortButton(name: string): HTMLElement {
  return within(header(name)).getByRole('button', { name });
}

function pagerButtons(locale: Locale = 'en') {
  return {
    previous: screen.getByRole('button', {
      name: catalogText(locale, 'table.pagination.previous'),
    }),
    next: screen.getByRole('button', { name: catalogText(locale, 'table.pagination.next') }),
  };
}

function pageSizeControl(locale: Locale = 'en'): HTMLElement {
  return screen.getByRole('combobox', { name: catalogText(locale, 'table.pageSize.label') });
}

/** The page size the control shows: a native select's value, or the Radix trigger's text. */
function shownPageSize(): string {
  const control = pageSizeControl();
  return control instanceof HTMLSelectElement ? control.value : control.textContent.trim();
}

/** Chooses `size` in the page-size control, a native select or the Radix select of D3. */
async function choosePageSize(user: ReturnType<typeof userEvent.setup>, size: 25 | 50 | 100) {
  const control = pageSizeControl();
  if (control instanceof HTMLSelectElement) {
    await user.selectOptions(control, String(size));
    return;
  }
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: String(size) }));
}

/** The page-size choices the control offers. */
async function offeredPageSizes(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  const control = pageSizeControl();
  if (control instanceof HTMLSelectElement) {
    return Array.from(control.options, (option) => option.value);
  }
  await user.click(control);
  const options = await screen.findAllByRole('option');
  const sizes = options.map((option) => option.textContent.trim());
  await user.keyboard('{Escape}');
  return sizes;
}

/** Opens `path` and waits for the table to show `firstPage`. */
async function openTable(path: string, server: FakeServer, firstPage: readonly Entity[]) {
  const user = userEvent.setup();
  const app = await renderApp(path, server);
  await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });
  await expectRows(firstPage);
  return { user, ...app };
}

/** The table requests sent after `before` of them had been sent. */
function requestsSince(server: FakeServer, before: number): string[] {
  return server.tableRequests().slice(before);
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

describe('the table page at /catalog/$blueprint', () => {
  it('shows the blueprint title and reads the blueprint and the first page at the default sort', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { history } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Service' })).toBeInTheDocument();
    expect(table()).toBeInTheDocument();
    expect([...server.tableRequests()].sort()).toEqual(
      [
        getBlueprintRequest('service'),
        listRequest('service', { sort: 'identifier', order: 'asc', pageSize: 50 }),
      ].sort(),
    );
    // Q68: the defaults stay out of the URL.
    expect(history.location.pathname).toBe('/catalog/service');
    expect(urlSearch(history)).toEqual({});
  });

  it('reads sort, order and page size from the URL', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { history } = await openTable(
      '/catalog/service?sort=updatedAt&order=desc&pageSize=25',
      server,
      pageOf(SERVICES, 'updatedAt', 'desc', 25, 0),
    );

    expect(server.tableRequests()).toContain(
      listRequest('service', { sort: 'updatedAt', order: 'desc', pageSize: 25 }),
    );
    expect(urlSearch(history)).toEqual({ sort: 'updatedAt', order: 'desc', pageSize: '25' });
    expect(sortState('Updated')).toBe('descending');
    expect(shownPageSize()).toBe('25');
  });
});

describe('Sort by title and page forward', () => {
  it('sorts by title descending and moves to the next page, which continues the order with no gap and no repeat', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );
    const afterLoad = server.tableRequests().length;

    // Title, ascending first.
    await user.click(sortButton('Title'));
    await expectRows(pageOf(SERVICES, 'title', 'asc', 50, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title' });
    expect(requestsSince(server, afterLoad)).toEqual([
      listRequest('service', { sort: 'title', order: 'asc', pageSize: 50 }),
    ]);
    const afterAscending = server.tableRequests().length;

    // Title again: descending.
    await user.click(sortButton('Title'));
    const firstPage = pageOf(SERVICES, 'title', 'desc', 50, 0);
    await expectRows(firstPage);
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc' });
    expect(requestsSince(server, afterAscending)).toEqual([
      listRequest('service', { sort: 'title', order: 'desc', pageSize: 50 }),
    ]);
    const afterDescending = server.tableRequests().length;

    // Next: the returned cursor goes to the URL and to the request.
    const cursor = cursorAfterPage(SERVICES, 'title', 'desc', 50, 0);
    await user.click(pagerButtons().next);
    const secondPage = pageOf(SERVICES, 'title', 'desc', 50, 1);
    await expectRows(secondPage);
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc', cursor });
    expect(requestsSince(server, afterDescending)).toEqual([
      listRequest('service', { sort: 'title', order: 'desc', pageSize: 50, cursor }),
    ]);

    // No gap and no repeat: both pages together are the first 100 rows in title desc.
    const seen = [...identifiersOf(firstPage), ...identifiersOf(secondPage)];
    expect(seen).toEqual(identifiersOf(ordered(SERVICES, 'title', 'desc').slice(0, 100)));
    expect(new Set(seen).size).toBe(100);

    // The blueprint was read once, whatever the sort and the page.
    expect(
      server.tableRequests().filter((line) => line === getBlueprintRequest('service')),
    ).toHaveLength(1);
    expect(pagerButtons().previous).toBeEnabled();
  });
});

describe('"Previous" and the in-memory cursor stack', () => {
  it('"Previous" returns page by page to the first page, with no cursor', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service?sort=title&order=desc',
      server,
      pageOf(SERVICES, 'title', 'desc', 50, 0),
    );
    const first = cursorAfterPage(SERVICES, 'title', 'desc', 50, 0);
    const second = cursorAfterPage(SERVICES, 'title', 'desc', 50, 1);

    expect(pagerButtons().previous).toBeDisabled();
    await user.click(pagerButtons().next);
    await expectRows(pageOf(SERVICES, 'title', 'desc', 50, 1));
    await user.click(pagerButtons().next);
    // The last page: 20 rows and no returned cursor.
    await expectRows(pageOf(SERVICES, 'title', 'desc', 50, 2));
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc', cursor: second });
    expect(pagerButtons().next).toBeDisabled();
    expect(pagerButtons().previous).toBeEnabled();

    const beforePrevious = server.tableRequests().length;
    await user.click(pagerButtons().previous);
    await expectRows(pageOf(SERVICES, 'title', 'desc', 50, 1));
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc', cursor: first });
    expect(pagerButtons().previous).toBeEnabled();
    expect(pagerButtons().next).toBeEnabled();

    const beforeFirstPage = server.tableRequests().length;
    await user.click(pagerButtons().previous);
    await expectRows(pageOf(SERVICES, 'title', 'desc', 50, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc' });
    expect(pagerButtons().previous).toBeDisabled();
    expect(pagerButtons().next).toBeEnabled();

    // Going back reuses the cached page or reads it again with the popped cursor; it
    // never sends another cursor.
    const backToSecond = requestsSince(server, beforePrevious).slice(
      0,
      beforeFirstPage - beforePrevious,
    );
    for (const line of backToSecond) {
      expect(line).toBe(
        listRequest('service', { sort: 'title', order: 'desc', pageSize: 50, cursor: first }),
      );
    }
    for (const line of requestsSince(server, beforeFirstPage)) {
      expect(line).toBe(listRequest('service', { sort: 'title', order: 'desc', pageSize: 50 }));
    }
  });

  it('disables "Previous" and "Next" on a single page', async () => {
    const server = createFakeServer({ service: SERVICES.slice(0, 10) });
    await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES.slice(0, 10), 'identifier', 'asc', 50, 0),
    );

    expect(pagerButtons().previous).toBeDisabled();
    expect(pagerButtons().next).toBeDisabled();
  });

  it('restarts a reload with a cursor in the URL from the first page of the same sort', async () => {
    const stale = cursorAfterPage(SERVICES, 'title', 'desc', 50, 0);
    const server = createFakeServer({ service: SERVICES });
    const { history } = await openTable(
      `/catalog/service?sort=title&order=desc&cursor=${stale}`,
      server,
      pageOf(SERVICES, 'title', 'desc', 50, 0),
    );

    await waitFor(() => {
      expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc' });
    });
    for (const line of server.tableRequests()) expect(line).not.toContain('cursor=');
    expect(server.tableRequests()).toContain(
      listRequest('service', { sort: 'title', order: 'desc', pageSize: 50 }),
    );
    expect(pagerButtons().previous).toBeDisabled();
  });

  it('clears the cursor and the stack when another column is sorted on a later page', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service?sort=title',
      server,
      pageOf(SERVICES, 'title', 'asc', 50, 0),
    );
    await user.click(pagerButtons().next);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 50, 1));
    const before = server.tableRequests().length;

    await user.click(sortButton('Updated'));
    await expectRows(pageOf(SERVICES, 'updatedAt', 'asc', 50, 0));
    expect(urlSearch(history)).toEqual({ sort: 'updatedAt' });
    expect(requestsSince(server, before)).toEqual([
      listRequest('service', { sort: 'updatedAt', order: 'asc', pageSize: 50 }),
    ]);
    expect(pagerButtons().previous).toBeDisabled();
  });

  it('clears the cursor and the stack when the order of the sorted column changes on a later page', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service?sort=title',
      server,
      pageOf(SERVICES, 'title', 'asc', 50, 0),
    );
    await user.click(pagerButtons().next);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 50, 1));
    const before = server.tableRequests().length;

    await user.click(sortButton('Title'));
    await expectRows(pageOf(SERVICES, 'title', 'desc', 50, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title', order: 'desc' });
    expect(requestsSince(server, before)).toEqual([
      listRequest('service', { sort: 'title', order: 'desc', pageSize: 50 }),
    ]);
    expect(pagerButtons().previous).toBeDisabled();
  });

  it('starts another blueprint on its first page with an empty stack', async () => {
    const server = createFakeServer({ service: SERVICES, _team: TEAMS });
    const { user, history } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );
    await user.click(pagerButtons().next);
    await expectRows(pageOf(SERVICES, 'identifier', 'asc', 50, 1));

    const nav = screen.getByRole('navigation', { name: 'Catalog' });
    await user.click(within(nav).getByRole('link', { name: 'Team' }));

    await screen.findByRole('table', { name: 'Team' });
    await expectRows(pageOf(TEAMS, 'identifier', 'asc', 50, 0), 'Team');
    expect(history.location.pathname).toBe('/catalog/_team');
    expect(urlSearch(history)).toEqual({});
    expect(server.tableRequests()).toContain(
      listRequest('_team', { sort: 'identifier', order: 'asc', pageSize: 50 }),
    );
    expect(pagerButtons().previous).toBeDisabled();
  });
});

describe('the page-size choice', () => {
  it('offers 25, 50 and 100, with 50 by default', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );

    expect(shownPageSize()).toBe('50');
    expect(await offeredPageSizes(user)).toEqual(['25', '50', '100']);
  });

  it('requests the chosen size, keeps it in the URL and clears the cursor and the stack', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service?sort=title',
      server,
      pageOf(SERVICES, 'title', 'asc', 50, 0),
    );

    let before = server.tableRequests().length;
    await choosePageSize(user, 25);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 25, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title', pageSize: '25' });
    expect(requestsSince(server, before)).toEqual([
      listRequest('service', { sort: 'title', order: 'asc', pageSize: 25 }),
    ]);

    const cursor = cursorAfterPage(SERVICES, 'title', 'asc', 25, 0);
    before = server.tableRequests().length;
    await user.click(pagerButtons().next);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 25, 1));
    expect(urlSearch(history)).toEqual({ sort: 'title', pageSize: '25', cursor });
    expect(requestsSince(server, before)).toEqual([
      listRequest('service', { sort: 'title', order: 'asc', pageSize: 25, cursor }),
    ]);

    before = server.tableRequests().length;
    await choosePageSize(user, 100);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 100, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title', pageSize: '100' });
    expect(requestsSince(server, before)).toEqual([
      listRequest('service', { sort: 'title', order: 'asc', pageSize: 100 }),
    ]);
    expect(pagerButtons().previous).toBeDisabled();
    expect(shownPageSize()).toBe('100');

    // Back to the default: it leaves the URL (Q68).
    await choosePageSize(user, 50);
    await expectRows(pageOf(SERVICES, 'title', 'asc', 50, 0));
    expect(urlSearch(history)).toEqual({ sort: 'title' });
  });
});

describe('aria-sort and the sortable headers', () => {
  it('announces the default sort on the identifier header', async () => {
    const server = createFakeServer({ service: SERVICES });
    await openTable('/catalog/service', server, pageOf(SERVICES, 'identifier', 'asc', 50, 0));

    expect(header('Identifier')).toHaveAttribute('aria-sort', 'ascending');
    expect(sortState('Title')).toBe('none');
    expect(sortState('Updated')).toBe('none');
  });

  it('moves aria-sort to the clicked header and flips it on a second click', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );

    await user.click(sortButton('Title'));
    await waitFor(() => {
      expect(header('Title')).toHaveAttribute('aria-sort', 'ascending');
    });
    expect(sortState('Identifier')).toBe('none');
    expect(sortState('Updated')).toBe('none');

    await user.click(sortButton('Title'));
    await waitFor(() => {
      expect(header('Title')).toHaveAttribute('aria-sort', 'descending');
    });
    expect(sortState('Identifier')).toBe('none');

    await user.click(sortButton('Identifier'));
    await waitFor(() => {
      expect(header('Identifier')).toHaveAttribute('aria-sort', 'ascending');
    });
    expect(sortState('Title')).toBe('none');
  });

  it('toggles the default identifier sort to descending', async () => {
    const server = createFakeServer({ service: SERVICES });
    const { user, history } = await openTable(
      '/catalog/service',
      server,
      pageOf(SERVICES, 'identifier', 'asc', 50, 0),
    );

    await user.click(sortButton('Identifier'));
    await expectRows(pageOf(SERVICES, 'identifier', 'desc', 50, 0));
    expect(urlSearch(history)).toEqual({ order: 'desc' });
    expect(header('Identifier')).toHaveAttribute('aria-sort', 'descending');
  });

  it('makes only identifier, title and updated sortable: property and relation headers have no button and no aria-sort', async () => {
    const server = createFakeServer({ service: SERVICES });
    await openTable('/catalog/service', server, pageOf(SERVICES, 'identifier', 'asc', 50, 0));

    for (const name of ['Identifier', 'Title', 'Updated']) {
      expect(sortButton(name)).toBeInTheDocument();
    }
    for (const name of ['Tier', 'Replicas', 'Owned by']) {
      expect(header(name)).not.toHaveAttribute('aria-sort');
      expect(within(header(name)).queryByRole('button')).toBeNull();
    }
  });
});

describe('row links to the entity page', () => {
  const SPECIAL: readonly Entity[] = [
    entity('service', 'svc-001', 'Plain entity', 1),
    entity('service', 'team@example.com:prod=1', 'Reserved entity', 2),
    entity('service', 'a/b', 'Slash entity', 3),
    entity('service', '..', 'Dots entity', 4),
  ];

  function rowWithTitle(title: string): HTMLTableRowElement {
    const row = bodyRows().find((candidate) => within(candidate).queryByText(title) !== null);
    if (row === undefined) throw new Error(`No row titled ${title}`);
    return row;
  }

  /**
   * Opens the table of `SPECIAL` and waits for its rows by title: the identifier cell of
   * a row that cannot be opened also holds the note, so identifiers alone do not match.
   */
  async function openSpecial(server: FakeServer) {
    const user = userEvent.setup();
    const app = await renderApp('/catalog/service', server);
    await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });
    await waitFor(() => {
      expect(bodyRows().map((row) => row.cells[1]?.textContent.trim())).toEqual(
        ordered(SPECIAL, 'identifier', 'asc').map((item) => item.title),
      );
    });
    return { user, ...app };
  }

  it('links an addressable identifier to /catalog/<blueprint>/<identifier>, with no %', async () => {
    const server = createFakeServer({ service: SPECIAL });
    const { user, history } = await openSpecial(server);

    const plain = within(rowWithTitle('Plain entity')).getByRole('link', { name: 'svc-001' });
    expect(plain).toHaveAttribute('href', '/catalog/service/svc-001');

    const reserved = within(rowWithTitle('Reserved entity')).getByRole('link', {
      name: 'team@example.com:prod=1',
    });
    expect(reserved).toHaveAttribute('href', '/catalog/service/team@example.com:prod=1');
    expect(reserved.getAttribute('href')).not.toContain('%');

    await user.click(reserved);
    await screen.findByTestId('page-entity');
    expect(history.location.pathname).toBe('/catalog/service/team@example.com:prod=1');
  });

  it('shows an identifier with / or made only of dots as text, with no link and the note', async () => {
    const server = createFakeServer({ service: SPECIAL });
    await openSpecial(server);
    const note = catalogText('en', 'table.notAddressable');

    for (const [title, identifier] of [
      ['Slash entity', 'a/b'],
      ['Dots entity', '..'],
    ] as const) {
      const row = rowWithTitle(title);
      expect(row.cells[0]?.textContent).toContain(identifier);
      const links = within(row)
        .queryAllByRole('link')
        .filter((link) => link.hasAttribute('href'));
      expect(links).toEqual([]);
      expect(within(row).getByText(note)).toBeInTheDocument();
    }
    expect(within(rowWithTitle('Plain entity')).queryByText(note)).toBeNull();
  });
});

describe('the table page in Spanish', () => {
  it('uses the Spanish blueprint title, headers and controls', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-AR');
    const server = createFakeServer({ service: SERVICES });
    await renderApp('/catalog/service', server);

    await screen.findByRole('table', { name: 'Servicio' }, { timeout: 3000 });
    await expectRows(pageOf(SERVICES, 'identifier', 'asc', 50, 0), 'Servicio');
    expect(screen.getByRole('heading', { level: 1, name: 'Servicio' })).toBeInTheDocument();
    expect(within(header('Título')).getByRole('button', { name: 'Título' })).toBeInTheDocument();
    expect(header('Identificador')).toHaveAttribute('aria-sort', 'ascending');
    expect(pagerButtons('es').next).toBeInTheDocument();
    expect(pageSizeControl('es')).toBeInTheDocument();
  });
});
