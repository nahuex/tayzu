/**
 * The command dialog (task 9.1, design D1, D4, D12, D13, D14, D15, D16 and Q36, Q65, Q67,
 * Q84, Q85; spec "Users can search the catalog from anywhere").
 *
 * Spec (requirement): "The app MUST open a search dialog with `Ctrl`+`K` or `Cmd`+`K` and
 * from the header, listing matching blueprints and, once the query has at least two
 * characters, matching entities from the server's search, with keyboard navigation. A
 * newer query MUST cancel the older request so that a stale answer is never shown. [...]
 * The query MUST NOT be stored in browser storage."
 * Spec, scenario "Search by identifier prefix from the keyboard": GIVEN a signed-in user
 * and an entity `payments-api`, WHEN they press `Ctrl`+`K`, type `paym` and press `Enter`
 * on the first entity result, THEN the entity page of `payments-api` opens.
 * D14: "The command dialog opens with `Ctrl`+`K` (or `Cmd`+`K`) anywhere and from the
 * header button. Two groups: **Blueprints** (filtered locally from the sidebar list by
 * identifier and localized title) and **Entities** (`search.entities` once the query has
 * 2 characters, debounced by 250 ms, each request aborted when the next starts, so a
 * stale answer is never shown). Arrow keys move, `Enter` opens, `Escape` closes; each
 * entity result shows its title, identifier and blueprint title. "See all results" opens
 * `/search?q=`."
 * D5: `search.entities` is `GET /v1/search/entities` with `q` (2 to 100 characters) and
 * an optional `limit`; it answers `{ items: [{ blueprint, identifier, title, match }] }`,
 * ranked, and may hold a title match by trigram similarity that is not a prefix.
 * D15: the server's `message` is never shown; no query is ever written to storage.
 * Q85: an entity that cannot be addressed by URL is shown with the disabled-link note and
 * cannot be opened.
 *
 * Contract this test pins for the implementer:
 *
 * - The dialog lives in `src/search/` (D1) and is mounted by the shell, so it exists on
 *   every signed-in route. It is a `dialog` named `search:command.title`.
 * - It opens from the header trigger (the button whose name starts with
 *   `common:search.open`), and on `Ctrl`+`K` or `Cmd`+`K` (`Meta`) anywhere in the shell,
 *   also while focus is in a text field (D14 says "anywhere"). The shortcut's keydown has
 *   its default prevented (the browsers' own `Ctrl`+`K`). A plain `k` opens nothing.
 * - On open, focus is in the search input, a `combobox` named `search:command.inputLabel`.
 *   `Escape` closes the dialog and focus returns to the element that had it before (the
 *   trigger, a sidebar link, a text field).
 * - The list holds, in this order: the group `search:command.blueprints` (a `group` named
 *   by its heading, one `option` per matching blueprint of the sidebar's cached
 *   `blueprints.list`, named by its localized title, filtered locally by identifier and
 *   localized title with no request), then the group `search:command.entities` (one
 *   `option` per `search.entities` item, in the server's order, every item the server
 *   sent shown, none filtered out by the client), then the option
 *   `search:command.seeAll` once the query has 2 characters or more.
 * - `search.entities` is called only for a query of 2 characters or more, 250 ms after the
 *   last keystroke (one request for a quickly typed `paym`, none for `pa`, `pay`), with
 *   `q` as typed. When a newer request starts, the previous one's `AbortSignal` is
 *   aborted. An answer for an older query is never shown once a newer query was typed,
 *   whenever it arrives.
 * - Each entity option shows the item's title, its identifier and its blueprint's
 *   localized title (from the cached `blueprints.list`).
 * - Selection follows the `aria-selected` options and the input's
 *   `aria-activedescendant`. When the entity answer arrives, the selection is the list's
 *   first option. `ArrowDown` and `ArrowUp` move it; `Enter` opens it:
 *   a blueprint opens `/catalog/<blueprint>`, an entity `/catalog/<blueprint>/<entity>`
 *   (`EntityLink`'s target) and "See all results" `/search?q=<query>`. The dialog closes.
 * - A result whose identifier cannot be addressed (holding `/`, or only dots) is an
 *   option with `aria-disabled="true"` showing the note of `catalog:entity.notAddressable`
 *   (Q85); activating it goes nowhere and leaves the dialog open.
 * - A failed `search.entities` (here a 500, after D4's one retry) shows
 *   `search:command.error` in the dialog, never the server's text.
 * - The query is never stored: typing changes no URL and writes nothing to storage.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
 *
 * Decisions: timers are real. The debounce is checked from timestamps the fake `fetch`
 * records (no request before the delay, one request after it), because fake timers would
 * also freeze TanStack Query's scheduler, the router and Radix's focus handling. The abort
 * is checked on the `AbortSignal` of the `Request` the fake `fetch` receives, which is how
 * an abort reaches the network whatever the mechanism (TanStack Query's `queryFn` signal
 * passed to oRPC's client options, or an `AbortController` of the component's own).
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), and the query
 * client is `createQueryClient()` (D4's retry policy) with no retry delay.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n, type Locale } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `<namespace>:<key>` text in `locale`; a missing key fails the test as an assertion. */
function localeText(locale: Locale, namespace: string, key: string): string {
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

/** The pinned English texts of this task's `search:command.*` keys. */
const PINNED = {
  'command.title': 'Search the catalog',
  'command.inputLabel': 'Search blueprints and entities',
  'command.blueprints': 'Blueprints',
  'command.entities': 'Entities',
  'command.seeAll': 'See all results',
  'command.error': 'The search failed. Try again later.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The English text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = localeText('en', 'search', key);
  expect(shown, `search:${key}`).toBe(PINNED[key]);
  return shown;
}

/** The shell's search trigger: its name starts with `common:search.open` ("Search"). */
const TRIGGER_NAME = /^Search/;

/** Reused from task 8.1: the note of an entity that cannot be opened by URL. */
const NOT_ADDRESSABLE = 'This entity cannot be opened by URL.';

// ---------------------------------------------------------------------------
// Fixtures

const MEMBER = { type: 'user', id: 'u_1' } as const;

const ME = {
  user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'password',
  mfa: { enrolled: false },
  gate: 'none',
} as const;

function blueprint(identifier: string, title: { en: string; es?: string }) {
  return {
    identifier,
    title,
    schema: { properties: {}, required: [] },
    relations: {},
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-08-01T10:00:00.000Z',
    updatedBy: MEMBER,
  };
}

/**
 * The tenant's blueprints, in the API's order. The queries below are chosen so that each
 * matches the same blueprints whether the local filter is by prefix, substring or a fuzzy
 * score: `k` and `k8s` match only `k8s-cluster` (by identifier), `busi` only `domain` (by
 * title), `serv` only `service`, and `paym`, `pa`, `pay` and `infra` none.
 */
const BLUEPRINTS = [
  blueprint('_team', { en: 'Team', es: 'Equipo' }),
  blueprint('_user', { en: 'User', es: 'Usuario' }),
  blueprint('domain', { en: 'Business domain', es: 'Dominio de negocio' }),
  blueprint('k8s-cluster', { en: 'Kubernetes cluster' }),
  blueprint('service', { en: 'Service', es: 'Servicio' }),
];

interface SearchItem {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly match: 'identifier' | 'title';
}

const PAYMENTS_API: SearchItem = {
  blueprint: 'service',
  identifier: 'payments-api',
  title: 'Payments API',
  match: 'identifier',
};
const PAYMENTS_WORKER: SearchItem = {
  blueprint: 'service',
  identifier: 'payments-worker',
  title: 'Payments worker',
  match: 'identifier',
};
/** A title match by trigram similarity: no client-side filter would keep it for `paym`. */
const PYAMENT_ROUTER: SearchItem = {
  blueprint: 'domain',
  identifier: 'routing-core',
  title: 'Pyament router',
  match: 'title',
};
/** Only ever in an answer for an older query. */
const PAYMENTS_LEGACY: SearchItem = {
  blueprint: 'service',
  identifier: 'payments-legacy',
  title: 'Payments (legacy)',
  match: 'identifier',
};
const SERVER_01: SearchItem = {
  blueprint: 'service',
  identifier: 'server-01',
  title: 'Server 01',
  match: 'identifier',
};
const SERVING_LAYER: SearchItem = {
  blueprint: 'domain',
  identifier: 'serving-layer',
  title: 'Serving layer',
  match: 'identifier',
};
/** Holds `/`, so it cannot be a route segment (D13, Q85). */
const INFRA_CORE: SearchItem = {
  blueprint: 'service',
  identifier: 'infra/core',
  title: 'Infra core',
  match: 'identifier',
};
const INFRA_API: SearchItem = {
  blueprint: 'service',
  identifier: 'infra-api',
  title: 'Infra API',
  match: 'identifier',
};

/** The server's ranked answer per query; any other query answers no item. */
const ANSWERS: Record<string, readonly SearchItem[]> = {
  paym: [PAYMENTS_API, PAYMENTS_WORKER, PYAMENT_ROUTER],
  serv: [SERVER_01, SERVING_LAYER],
  infra: [INFRA_CORE, INFRA_API],
};

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entity" on 10.0.0.7';

// ---------------------------------------------------------------------------
// The fake API

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, data?: unknown): Response {
  return jsonResponse(status, {
    defined: false,
    code,
    status,
    message: SERVER_TEXT,
    ...(data === undefined ? {} : { data }),
  });
}

function answer(items: readonly SearchItem[]): Response {
  return jsonResponse(200, { items });
}

/** One `search.entities` request as the server received it. */
interface SearchCall {
  readonly q: string | null;
  readonly params: URLSearchParams;
  readonly signal: AbortSignal;
  /** `performance.now()` when the request reached the server. */
  readonly at: number;
}

type SearchHandler = (call: SearchCall) => Response | Promise<Response>;

/** The server's own answer: `ANSWERS`, after D5's limits on `q`. */
const defaultSearch: SearchHandler = ({ q }) => {
  const query = (q ?? '').trim();
  if (query.length < 2 || query.length > 100) {
    return errorResponse(400, 'CATALOG_VALIDATION_FAILED', {
      issues: [{ path: '/q', message: SERVER_TEXT }],
    });
  }
  return answer(ANSWERS[query] ?? []);
};

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me`, `blueprints.list`
 * and `search.entities` (through `search`, `defaultSearch` by default). No other route is
 * expected: the pages are probes.
 */
function createFakeServer(options: { search?: SearchHandler } = {}) {
  const searchCalls: SearchCall[] = [];
  const requests: string[] = [];
  const search = options.search ?? defaultSearch;

  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const { pathname } = url;
    requests.push(`${request.method} ${pathname}`);

    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: BLUEPRINTS });
    if (pathname === '/v1/search/entities') {
      const call: SearchCall = {
        q: url.searchParams.get('q'),
        params: url.searchParams,
        signal: request.signal,
        at: performance.now(),
      };
      searchCalls.push(call);
      return search(call);
    }
    return errorResponse(404, 'CATALOG_NOT_FOUND');
  };

  return {
    fetch,
    /** Every `search.entities` request, in order. */
    searchCalls(): readonly SearchCall[] {
      return searchCalls;
    },
    /** The `blueprints.list` requests so far. */
    blueprintListCount(): number {
      return requests.filter((line) => line === 'GET /v1/blueprints').length;
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

/** A response settled from outside; with `honourAbort`, it rejects as `fetch` does. */
function pendingResponse(signal: AbortSignal, honourAbort: boolean) {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle, reject) => {
    resolve = settle;
    if (honourAbort) {
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
    }
  });
  return { promise, resolve };
}

/**
 * A search handler whose answers stay pending until the test settles them, one per
 * request, in request order.
 */
function controlledSearch(honourAbort: boolean) {
  const pending: ReturnType<typeof pendingResponse>[] = [];
  const handler: SearchHandler = ({ signal }) => {
    const response = pendingResponse(signal, honourAbort);
    pending.push(response);
    return response.promise;
  };
  return {
    handler,
    /** Settles the answer of the `index`-th request (0-based). */
    resolve(index: number, response: Response): void {
      const entry = pending[index];
      expect(entry, `search request #${String(index)}`).toBeDefined();
      entry?.resolve(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering

function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** The home page holds a text field, to press the shortcut from inside one. */
function HomeProbe(): React.JSX.Element {
  return (
    <div data-testid="page-home">
      <label>
        Probe field
        <input type="text" />
      </label>
    </div>
  );
}

const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: HomeProbe,
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
};

/** Renders the whole app as `main.tsx` does at `path`, and waits for the sidebar. */
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
  const nav = await screen.findByRole('navigation', { name: 'Catalog' }, { timeout: 3000 });
  await within(nav).findByRole('link', { name: 'Service' }, { timeout: 3000 });
  return { history };
}

function sleep(ms: number): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: TRIGGER_NAME });
}

/** The open command dialog and its search input, which has focus. */
async function findDialog(): Promise<{ dialog: HTMLElement; input: HTMLElement }> {
  const dialog = await screen.findByRole('dialog', { name: text('command.title') });
  const input = within(dialog).getByRole('combobox', { name: text('command.inputLabel') });
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  return { dialog, input };
}

async function openFromTrigger(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return findDialog();
}

function group(dialog: HTMLElement, key: 'command.blueprints' | 'command.entities') {
  return within(dialog).getByRole('group', { name: text(key) });
}

/** The entity options of the dialog, waiting until `identifier` is among them. */
async function findEntityOptions(dialog: HTMLElement, identifier: string): Promise<HTMLElement[]> {
  await within(dialog).findByRole('option', { name: new RegExp(escapeRegExp(identifier)) });
  return within(group(dialog, 'command.entities')).getAllByRole('option');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function optionNamed(dialog: HTMLElement, identifier: string): HTMLElement {
  return within(dialog).getByRole('option', { name: new RegExp(escapeRegExp(identifier)) });
}

function queryOptionNamed(dialog: HTMLElement, identifier: string): HTMLElement | null {
  return within(dialog).queryByRole('option', { name: new RegExp(escapeRegExp(identifier)) });
}

/** The one selected option of the dialog, which the input points at. */
function selectedOption(dialog: HTMLElement, input: HTMLElement): HTMLElement {
  const selected = within(dialog)
    .getAllByRole('option')
    .filter((option) => option.getAttribute('aria-selected') === 'true');
  expect(selected, 'exactly one selected option').toHaveLength(1);
  const option = selected[0] as HTMLElement;
  expect(option.id).not.toBe('');
  expect(input).toHaveAttribute('aria-activedescendant', option.id);
  return option;
}

/** Every stored value of both storages, keys included. */
function storedText(): string {
  const all: string[] = [];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      all.push(key, storage.getItem(key) ?? '');
    }
  }
  return all.join('\n');
}

// ---------------------------------------------------------------------------
// jsdom gaps: cmdk measures its list and scrolls the selected option into view.

class NoopResizeObserver {
  observe(): void {
    // jsdom has no layout.
  }
  unobserve(): void {
    // jsdom has no layout.
  }
  disconnect(): void {
    // jsdom has no layout.
  }
}

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollIntoView',
);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (scrollIntoViewDescriptor === undefined) {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  } else {
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  }
});

// ---------------------------------------------------------------------------
// Tests

describe('Search by identifier prefix from the keyboard', () => {
  it('Ctrl+K, type "paym", Enter on the first entity result: the entity page of payments-api opens', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();

    await user.keyboard('{Control>}k{/Control}');
    const { dialog, input } = await findDialog();
    await user.keyboard('paym');

    const entities = await findEntityOptions(dialog, PAYMENTS_API.identifier);
    const first = entities[0] as HTMLElement;
    expect(first).toHaveAccessibleName(/payments-api/);
    // No blueprint matches `paym`, so the first entity result is the list's first option.
    expect(selectedOption(dialog, input)).toBe(first);

    await user.keyboard('{Enter}');

    await screen.findByTestId('page-entity');
    expect(history.location.pathname).toBe('/catalog/service/payments-api');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows each entity result with its title, identifier and blueprint title, every server item kept', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('paym');

    const entities = await findEntityOptions(dialog, PAYMENTS_API.identifier);
    // The server's order, including the trigram title match no prefix filter would keep.
    expect(entities).toHaveLength(3);
    const expected = [
      [PAYMENTS_API, 'Service'],
      [PAYMENTS_WORKER, 'Service'],
      [PYAMENT_ROUTER, 'Business domain'],
    ] as const;
    expected.forEach(([item, blueprintTitle], index) => {
      const option = entities[index] as HTMLElement;
      expect(option).toHaveTextContent(item.title);
      expect(option).toHaveTextContent(item.identifier);
      expect(option).toHaveTextContent(blueprintTitle);
    });
  });
});

describe('opening and closing the dialog', () => {
  it('opens from the header button, with focus in the search input', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openFromTrigger(user);
  });

  it('opens with Ctrl+K and with Cmd+K, preventing the browser default', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();
    const prevented: boolean[] = [];
    const record = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k') prevented.push(event.defaultPrevented);
    };
    window.addEventListener('keydown', record);

    try {
      await user.keyboard('{Control>}k{/Control}');
      await findDialog();
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      await user.keyboard('{Meta>}k{/Meta}');
      await findDialog();
    } finally {
      window.removeEventListener('keydown', record);
    }
    expect(prevented).toEqual([true, true]);
  });

  it('opens with the shortcut from inside a text field, and a plain "k" opens nothing', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();
    const field = screen.getByRole('textbox', { name: 'Probe field' });

    await user.click(field);
    await user.keyboard('k');
    await sleep(50);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(field).toHaveValue('k');

    await user.keyboard('{Control>}k{/Control}');
    await findDialog();
  });

  it('Escape closes the dialog and restores focus to the header button', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    await openFromTrigger(user);
    await user.keyboard('paym');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  it('Escape restores focus to whatever had it when Cmd+K opened the dialog', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    const link = within(screen.getByRole('navigation', { name: 'Catalog' })).getByRole('link', {
      name: 'Service',
    });
    act(() => {
      link.focus();
    });
    expect(link).toHaveFocus();
    await user.keyboard('{Meta>}k{/Meta}');
    await findDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });

    const field = screen.getByRole('textbox', { name: 'Probe field' });
    await user.click(field);
    await user.keyboard('{Control>}k{/Control}');
    await findDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
  });
});

describe('the local blueprint group', () => {
  it('a 1-character query lists matching blueprints and makes no request', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    const listCalls = server.blueprintListCount();
    await user.keyboard('k');

    const blueprints = group(dialog, 'command.blueprints');
    expect(within(blueprints).getByRole('option', { name: /Kubernetes cluster/ })).toBeVisible();
    expect(within(blueprints).queryByRole('option', { name: /Service/ })).not.toBeInTheDocument();
    // Well past the 250 ms debounce: still no search request, and no blueprint refetch.
    await sleep(500);
    expect(server.searchCalls()).toHaveLength(0);
    expect(server.blueprintListCount()).toBe(listCalls);
  });

  it('filters by localized title and by identifier, and Enter opens the blueprint table', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    const listCalls = server.blueprintListCount();
    await user.keyboard('busi');
    const byTitle = within(group(dialog, 'command.blueprints')).getAllByRole('option');
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]).toHaveAccessibleName(/Business domain/);

    await user.clear(within(dialog).getByRole('combobox'));
    await user.keyboard('k8s');
    const byIdentifier = within(group(dialog, 'command.blueprints')).getAllByRole('option');
    expect(byIdentifier).toHaveLength(1);
    expect(byIdentifier[0]).toHaveAccessibleName(/Kubernetes cluster/);
    expect(server.blueprintListCount()).toBe(listCalls);

    // `k8s` answers no entity, so the blueprint stays the first option.
    await waitFor(() => {
      expect(server.searchCalls().map((call) => call.q)).toContain('k8s');
    });
    await sleep(50);
    await user.keyboard('{Enter}');

    await screen.findByTestId('page-catalogTable');
    expect(history.location.pathname).toBe('/catalog/k8s-cluster');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the entity group from search.entities', () => {
  it('sends one request with q 250 ms after the last keystroke, none before', async () => {
    const server = createFakeServer();
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('paym');
    const typedAt = performance.now();
    expect(server.searchCalls()).toHaveLength(0);

    await findEntityOptions(dialog, PAYMENTS_API.identifier);
    await sleep(300);
    const calls = server.searchCalls();
    // The quickly typed prefixes `pa` and `pay` are never sent.
    expect(calls.map((call) => call.q)).toEqual(['paym']);
    const call = calls[0] as SearchCall;
    // The debounce timer starts at the last keystroke, a little before `typedAt`.
    expect(call.at - typedAt).toBeGreaterThanOrEqual(200);
    // The tenant comes from the session, never from the request (D15).
    for (const key of call.params.keys()) expect(['q', 'limit']).toContain(key);
  });

  it('aborts the previous request when the next one starts', async () => {
    const search = controlledSearch(true);
    const server = createFakeServer({ search: search.handler });
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('pa');
    await waitFor(() => {
      expect(server.searchCalls()).toHaveLength(1);
    });
    const first = server.searchCalls()[0] as SearchCall;
    expect(first.q).toBe('pa');
    expect(first.signal.aborted).toBe(false);

    await user.keyboard('y');
    await waitFor(() => {
      expect(server.searchCalls()).toHaveLength(2);
    });
    const second = server.searchCalls()[1] as SearchCall;
    expect(second.q).toBe('pay');
    await waitFor(() => {
      expect(first.signal.aborted).toBe(true);
    });
    expect(second.signal.aborted).toBe(false);

    search.resolve(1, answer([PAYMENTS_API]));
    await findEntityOptions(dialog, PAYMENTS_API.identifier);
  });

  it('never shows a stale answer that lands before the newer one', async () => {
    // The worst case: a server that answers an aborted request anyway.
    const search = controlledSearch(false);
    const server = createFakeServer({ search: search.handler });
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('pa');
    await waitFor(() => {
      expect(server.searchCalls()).toHaveLength(1);
    });
    await user.keyboard('ym');
    await waitFor(() => {
      expect(server.searchCalls().map((call) => call.q)).toEqual(['pa', 'paym']);
    });

    search.resolve(0, answer([PAYMENTS_LEGACY]));
    await sleep(100);
    expect(queryOptionNamed(dialog, PAYMENTS_LEGACY.identifier)).not.toBeInTheDocument();

    search.resolve(1, answer([PAYMENTS_API]));
    await findEntityOptions(dialog, PAYMENTS_API.identifier);
    await sleep(50);
    expect(queryOptionNamed(dialog, PAYMENTS_LEGACY.identifier)).not.toBeInTheDocument();
  });

  it('never shows a stale answer that lands after the newer one', async () => {
    const search = controlledSearch(false);
    const server = createFakeServer({ search: search.handler });
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('pa');
    await waitFor(() => {
      expect(server.searchCalls()).toHaveLength(1);
    });
    await user.keyboard('ym');
    await waitFor(() => {
      expect(server.searchCalls()).toHaveLength(2);
    });

    search.resolve(1, answer([PAYMENTS_API]));
    await findEntityOptions(dialog, PAYMENTS_API.identifier);
    search.resolve(0, answer([PAYMENTS_LEGACY]));
    await sleep(100);

    expect(queryOptionNamed(dialog, PAYMENTS_LEGACY.identifier)).not.toBeInTheDocument();
    expect(optionNamed(dialog, PAYMENTS_API.identifier)).toBeInTheDocument();
  });

  it('shows a result that cannot be addressed as disabled, with its note, and it opens nothing', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('infra');
    await findEntityOptions(dialog, INFRA_API.identifier);

    const disabled = optionNamed(dialog, INFRA_CORE.identifier);
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(within(disabled).getByText(NOT_ADDRESSABLE)).toBeInTheDocument();
    expect(localeText('en', 'catalog', 'entity.notAddressable')).toBe(NOT_ADDRESSABLE);
    expect(optionNamed(dialog, INFRA_API.identifier)).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(disabled);
    await sleep(50);
    expect(history.location.pathname).toBe('/');
    expect(screen.getByRole('dialog', { name: text('command.title') })).toBeInTheDocument();
  });

  it('shows the localized error on a failed search, never the server text', async () => {
    const server = createFakeServer({
      search: () => errorResponse(500, 'INTERNAL_SERVER_ERROR'),
    });
    await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('paym');

    expect(await within(dialog).findByText(text('command.error'))).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SERVER_TEXT);
    expect(document.body).not.toHaveTextContent('INTERNAL_SERVER_ERROR');
  });
});

describe('keyboard navigation and "See all results"', () => {
  it('arrow keys move through blueprints, entities and "See all results"; Enter opens the selection', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog, input } = await openFromTrigger(user);
    await user.keyboard('serv');
    await findEntityOptions(dialog, SERVING_LAYER.identifier);

    const all = within(dialog).getAllByRole('option');
    const service = within(group(dialog, 'command.blueprints')).getByRole('option', {
      name: /Service/,
    });
    const server01 = optionNamed(dialog, SERVER_01.identifier);
    const servingLayer = optionNamed(dialog, SERVING_LAYER.identifier);
    const seeAll = within(dialog).getByRole('option', { name: text('command.seeAll') });
    expect(all).toEqual([service, server01, servingLayer, seeAll]);

    expect(selectedOption(dialog, input)).toBe(service);
    await user.keyboard('{ArrowDown}');
    expect(selectedOption(dialog, input)).toBe(server01);
    await user.keyboard('{ArrowDown}');
    expect(selectedOption(dialog, input)).toBe(servingLayer);
    await user.keyboard('{ArrowDown}');
    expect(selectedOption(dialog, input)).toBe(seeAll);
    await user.keyboard('{ArrowUp}');
    expect(selectedOption(dialog, input)).toBe(servingLayer);
    // Focus never leaves the input while the selection moves.
    expect(input).toHaveFocus();

    await user.keyboard('{Enter}');
    await screen.findByTestId('page-entity');
    expect(history.location.pathname).toBe('/catalog/domain/serving-layer');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('"See all results" opens /search with the query', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();

    const { dialog, input } = await openFromTrigger(user);
    await user.keyboard('paym');
    await findEntityOptions(dialog, PYAMENT_ROUTER.identifier);
    const seeAll = within(dialog).getByRole('option', { name: text('command.seeAll') });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(selectedOption(dialog, input)).toBe(seeAll);

    await user.keyboard('{Enter}');
    await screen.findByTestId('page-search');
    expect(history.location.pathname).toBe('/search');
    expect(new URLSearchParams(history.location.search).get('q')).toBe('paym');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the query is never stored', () => {
  it('typing changes no URL and writes nothing to storage', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/', server);
    const user = userEvent.setup();
    const before = history.location.href;
    const entries = history.length;

    const { dialog } = await openFromTrigger(user);
    await user.keyboard('paym');
    await findEntityOptions(dialog, PAYMENTS_API.identifier);

    expect(history.location.href).toBe(before);
    expect(history.length).toBe(entries);
    expect(storedText()).not.toContain('paym');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(history.location.href).toBe(before);
    expect(storedText()).not.toContain('paym');
  });
});
