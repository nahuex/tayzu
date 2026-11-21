/**
 * The entity page header, its tabs and its states (task 8.1, design D4, D12, D13, D15,
 * D16 and Q18, Q36, Q67, Q68, Q83, Q84; spec "The entity page shows details and
 * relations").
 *
 * Spec (requirement): "The app MUST show an entity page with the entity's title,
 * identifier, blueprint, timestamps, actors, version and generation, a Details tab [...]
 * and a Related tab [...]. An entity that is missing or in another tenant MUST show the
 * not-found page. An entity whose identifier holds `@`, `:` or `=` MUST open normally,
 * with those characters sent unencoded in the app path and in the API call. An entity
 * whose identifier holds `/` or is made only of dots cannot be addressed in a URL path
 * and MUST be listed with its link disabled and an explanation."
 * Spec, scenario "An identifier with reserved characters opens": GIVEN an entity
 * `team@example.com:prod=1`, WHEN the user opens it from the table, THEN its entity page
 * shows it, and no request path holds a `%`.
 * D13 (Entity page): "A header with title, identifier, blueprint, created and updated
 * time and actor (type and opaque id), version and generation."
 * D13 (Identifiers that cannot be addressed by URL): "an entity whose identifier contains
 * `/`, or is made only of dots, is listed, but its link is disabled with a localized
 * note".
 * D12: `/catalog/$blueprint/$entity`, search param `tab`: `details` or `related`; an
 * invalid value falls back to its default. Q68: the default `tab=details` is stripped
 * from the URL.
 * D4: `not_found` is `CATALOG_NOT_FOUND`, "also every cross-tenant answer"; no retry on a
 * 4xx, at most one retry on a 5xx; the UI never shows the server's message.
 *
 * Decisions this test pins:
 *
 * - The page is the router's default `entity` slot (`createAppRouter` without an
 *   `entity` page renders it), inside the shell, reading the shell's API client.
 * - It reads `entities.get` (`GET /v1/blueprints/<bp>/entities/<id>`) and
 *   `blueprints.get` (`GET /v1/blueprints/<bp>`): the header shows the blueprint's
 *   localized title, and the Details tab (8.2) needs its schema. A tab switch reads
 *   neither again.
 * - Header: the heading of level 1 is the entity title. The fields are a description
 *   list in `main`, each `<dt>` (the localized label) followed by its `<dd>`:
 *   - Identifier: the identifier, as text;
 *   - Blueprint: a link named by the localized blueprint title to the table,
 *     `/catalog/<bp>` (the way back to the table; D13 has no breadcrumb);
 *   - Created and Updated: `formatDate(<at>, locale)` (`lib/format.ts`);
 *   - Created by and Updated by: the localized actor type and the opaque actor id, as
 *     text;
 *   - Version and Generation: the numbers.
 *   An `onBehalfOf` principal is left open (D13 names type and id only).
 * - Tabs (Radix tabs, D3): a `tablist` named `catalog:entity.tabs.label` with the tabs
 *   `catalog:entity.tabs.details` and `catalog:entity.tabs.related`. The selected tab is
 *   the URL's `tab` (an invalid value is Details). Choosing a tab, by pointer or by arrow
 *   key, writes it to the URL: `?tab=related`, and no `tab` at all for Details. Only the
 *   selected tab's panel is shown, named by its tab. The panels' content is 8.2's and
 *   8.3's; push or replace is left open.
 * - States, as the table's (Q84): while either call is pending, a `role="status"`
 *   element with `aria-busy="true"` shows `catalog:entity.loading`. A `not_found` answer
 *   of either call renders the real not-found page (`common:notFound.*`) inside the
 *   shell, with no header, no tabs and no alert; another tenant's entity and an entity
 *   that exists nowhere render the same `main`, which never echoes the identifier or the
 *   title. Any other failure is one alert in `main` by kind: `forbidden`
 *   (`catalog:entity.error.forbidden`), `rate_limited` (`catalog:entity.error.rateLimited`)
 *   and every other kind (`catalog:entity.error.server`, after D4's one retry on a 5xx);
 *   `unauthenticated` is the shell's sign-in redirect. A 4xx is never retried.
 * - `EntityLink` (`./entity-link.tsx`, props `blueprint`, `identifier` and optional
 *   `children`, the link text, which defaults to the identifier): the one link to an
 *   entity page, for the related rows (8.3) and search (group 9) to reuse. For an
 *   addressable identifier (`isAddressableIdentifier`, Q18, Q36) it is a router link to
 *   `/catalog/<bp>/<id>` with no `%`. Otherwise it is a disabled link: an element with
 *   the `link` role, named by its text, with `aria-disabled="true"` and no `href`, whose
 *   accessible description is the visible note `catalog:entity.notAddressable`; activating
 *   it goes nowhere. Whether it stays focusable is left open.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
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
import { Suspense, type ComponentType, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n, type Locale } from '../i18n/i18n.js';
import { formatDate } from '../lib/format.js';
import { createThemeStore } from '../state/theme.js';

import { EntityLink } from './entity-link.js';

// ---------------------------------------------------------------------------
// Locale texts

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `<namespace>:<key>` text in `locale`; a missing key fails the test as an assertion. */
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

/** The pinned English texts of this task's `catalog:entity.*` keys. */
const PINNED = {
  'entity.loading': 'Loading entity...',
  'entity.fields.identifier': 'Identifier',
  'entity.fields.blueprint': 'Blueprint',
  'entity.fields.createdAt': 'Created',
  'entity.fields.createdBy': 'Created by',
  'entity.fields.updatedAt': 'Updated',
  'entity.fields.updatedBy': 'Updated by',
  'entity.fields.version': 'Version',
  'entity.fields.generation': 'Generation',
  'entity.actorType.user': 'User',
  'entity.actorType.agent': 'Agent',
  'entity.actorType.integration': 'Integration',
  'entity.actorType.system': 'System',
  'entity.tabs.label': 'Entity sections',
  'entity.tabs.details': 'Details',
  'entity.tabs.related': 'Related',
  'entity.notAddressable': 'This entity cannot be opened by URL.',
  'entity.error.forbidden': 'You do not have permission to view this entity.',
  'entity.error.server': 'The entity could not be loaded. Try again later.',
  'entity.error.rateLimited': 'Too many requests. Wait a moment and try again.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The English text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = localeText('en', 'catalog', key);
  expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

type ActorType = 'user' | 'agent' | 'integration' | 'system';

interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

const MEMBER: Actor = { type: 'user', id: 'u_1' };

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
    createdAt: '2026-08-01T10:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-08-01T10:00:00.000Z',
    updatedBy: MEMBER,
  };
}

const SERVICE = blueprint('service', { en: 'Service', es: 'Servicio' });
/** A blueprint every tenant holds. */
const TEAM = blueprint('_team', { en: 'Team', es: 'Equipo' });
/** A blueprint of tenant `t1` only. */
const BILLING = blueprint('billing', { en: 'Billing ledger', es: 'Libro de facturación' });

interface Entity {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly generation: number;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: Actor;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
  readonly [key: string]: unknown;
}

function entity(
  blueprintId: string,
  identifier: string,
  title: string,
  extra: Partial<Entity> = {},
): Entity {
  return {
    blueprint: blueprintId,
    identifier,
    title,
    spec: { properties: { tier: 'gold' }, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: MEMBER,
    ...extra,
  };
}

/** The entity the header tests open: every header value is distinct. */
const PAYMENTS = entity('service', 'svc-payments', 'Payments API', {
  generation: 4,
  version: 7,
  createdAt: '2026-09-14T08:30:00.000Z',
  createdBy: { type: 'agent', id: 'agt_7f3a' },
  updatedAt: '2026-11-02T16:45:00.000Z',
  updatedBy: { type: 'integration', id: 'int_github' },
});

/** The other two actor types. */
const LEDGER_SYNC = entity('service', 'svc-ledger-sync', 'Ledger sync', {
  createdBy: { type: 'user', id: 'u_42' },
  updatedBy: { type: 'system', id: 'sys_reconciler' },
});

const RESERVED_ID = 'team@example.com:prod=1';
const RESERVED = entity('service', RESERVED_ID, 'Reserved entity', { version: 3 });

/** An entity of tenant `t1` in a blueprint only `t1` holds. */
const LEDGER = entity('billing', 'ledger-main', 'Main ledger');
/** An entity of tenant `t1` in a blueprint both tenants hold. */
const PLATFORM = entity('_team', 'platform-team', 'Platform team');

/** What each tenant holds. A session belongs to one tenant; the server decides which. */
const TENANTS = {
  t1: {
    blueprints: [BILLING, TEAM],
    entities: { billing: [LEDGER], _team: [PLATFORM] } as Record<string, readonly Entity[]>,
  },
  t2: {
    blueprints: [SERVICE, TEAM],
    entities: { service: [PAYMENTS, LEDGER_SYNC, RESERVED], _team: [] } as Record<
      string,
      readonly Entity[]
    >,
  },
} as const;

type Tenant = keyof typeof TENANTS;

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entities" on 10.0.0.7';

// ---------------------------------------------------------------------------
// The fake API

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { defined: false, code, status, message: SERVER_TEXT });
}

const notFound = (): Response => errorResponse(404, 'CATALOG_NOT_FOUND');
const forbidden = (): Response => errorResponse(403, 'AUTH_FORBIDDEN');
const internal = (): Response => errorResponse(500, 'INTERNAL_SERVER_ERROR');
const unauthenticated = (): Response => errorResponse(401, 'UNAUTHORIZED');
const rateLimited = (): Response => errorResponse(429, 'AUTH_RATE_LIMITED');

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * A catalog call: `blueprint` (`blueprints.get`), `list` (`entities.list`), `entity`
 * (`entities.get`) or `related` (`entities.listRelated`).
 */
type CatalogCall = 'blueprint' | 'list' | 'entity' | 'related';

/**
 * Overrides the answer of a catalog call; `undefined` keeps the tenant's answer. A
 * promise that is not settled yet keeps the call pending.
 */
type Override = (
  call: CatalogCall,
  blueprintId: string,
  entityId: string | undefined,
) => Response | Promise<Response> | undefined;

/** Decodes a path segment for the lookup only; the recorded path stays raw. */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A fake `fetch` playing the API for a signed-in member of `tenant`: `GET /v1/me`,
 * `blueprints.list` (the sidebar), `blueprints.get`, `entities.list`, `entities.get` and
 * `entities.listRelated` (empty). Whatever the tenant does not hold is
 * `CATALOG_NOT_FOUND`, as the server answers for another tenant's blueprint or entity.
 */
function createFakeServer(options: { tenant?: Tenant; override?: Override } = {}) {
  const held = TENANTS[options.tenant ?? 't2'];
  const requests: string[] = [];
  const pathnames: string[] = [];

  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const { pathname } = url;
    pathnames.push(pathname);
    const query = new URLSearchParams(
      [...url.searchParams.entries()].sort(([a], [b]) => compareText(a, b)),
    ).toString();
    requests.push(`${request.method} ${pathname}${query === '' ? '' : `?${query}`}`);

    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: held.blueprints });
    const match = /^\/v1\/blueprints\/([^/]+)(?:\/entities(?:\/([^/]+)(\/related)?)?)?$/.exec(
      pathname,
    );
    const rawBlueprint = match?.[1];
    if (match === null || rawBlueprint === undefined) return notFound();
    const blueprintId = segment(rawBlueprint);
    const entityId = match[2] === undefined ? undefined : segment(match[2]);
    let call: CatalogCall = 'blueprint';
    if (pathname.endsWith('/entities')) call = 'list';
    else if (entityId !== undefined) call = match[3] === undefined ? 'entity' : 'related';

    const overridden = await options.override?.(call, blueprintId, entityId);
    if (overridden !== undefined) return overridden;

    const found = held.blueprints.find((item) => item.identifier === blueprintId);
    if (found === undefined) return notFound();
    const entities = held.entities[blueprintId] ?? [];
    switch (call) {
      case 'blueprint':
        return jsonResponse(200, found);
      case 'list':
        return jsonResponse(200, {
          items: [...entities].sort((a, b) => compareText(a.identifier, b.identifier)),
        });
      case 'entity': {
        const item = entities.find((candidate) => candidate.identifier === entityId);
        return item === undefined ? notFound() : jsonResponse(200, item);
      }
      case 'related': {
        const item = entities.find((candidate) => candidate.identifier === entityId);
        return item === undefined ? notFound() : jsonResponse(200, { items: [] });
      }
    }
  };

  return {
    fetch,
    /** Every request path, raw, as the server received it. */
    pathnames(): readonly string[] {
      return pathnames;
    },
    /** The `entities.get` requests for `blueprintId` and `entityId`. */
    entityRequests(blueprintId: string, entityId: string): string[] {
      return requests.filter(
        (line) => line === `GET /v1/blueprints/${blueprintId}/entities/${entityId}`,
      );
    },
    /** The `blueprints.get` requests for `blueprintId`. */
    blueprintRequests(blueprintId: string): string[] {
      return requests.filter((line) => line === `GET /v1/blueprints/${blueprintId}`);
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

function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `catalogTable` and `entity` is a probe, so those two keep their pages. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
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

/** The entity page's heading, once it is shown. */
async function findEntityHeading(main: HTMLElement, title: string): Promise<HTMLElement> {
  return within(main).findByRole('heading', { level: 1, name: title }, { timeout: 3000 });
}

function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

type FieldKey =
  | 'identifier'
  | 'blueprint'
  | 'createdAt'
  | 'createdBy'
  | 'updatedAt'
  | 'updatedBy'
  | 'version'
  | 'generation';

/** The `<dd>` that follows the `<dt>` labelled `catalog:entity.fields.<key>` in `scope`. */
function headerField(scope: HTMLElement, key: FieldKey, label?: string): HTMLElement {
  const name = label ?? text(`entity.fields.${key}`);
  const terms = [...scope.querySelectorAll('dt')].filter(
    (term) => term.textContent.trim() === name,
  );
  expect(terms, `one <dt> "${name}"`).toHaveLength(1);
  const value = terms[0]?.nextElementSibling;
  expect(value?.tagName, `the <dd> after "${name}"`).toBe('DD');
  return value as HTMLElement;
}

/** The text of an element with its white space collapsed. */
function shownText(element: Element): string {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

/** An actor field: its localized type and its opaque id, and nothing of `other`. */
function expectActor(value: HTMLElement, actor: Actor, other: Actor): void {
  expect(value).toHaveTextContent(text(`entity.actorType.${actor.type}`));
  expect(value).toHaveTextContent(actor.id);
  expect(value.textContent).not.toContain(other.id);
}

/** The `status` element showing the loading text, if any. */
function loadingIndicator(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((element) => element.textContent.includes(PINNED['entity.loading']));
}

async function expectLoading(): Promise<void> {
  const loading = text('entity.loading');
  await waitFor(
    () => {
      expect(loadingIndicator(), `a status element showing "${loading}"`).toBeDefined();
    },
    { timeout: 3000 },
  );
  expect(
    loadingIndicator()?.closest('[aria-busy="true"]'),
    'aria-busy="true" on it or above',
  ).not.toBe(null);
}

function expectNotLoading(main: HTMLElement): void {
  expect(within(main).queryByText(PINNED['entity.loading'])).toBeNull();
  expect(main.querySelector('[aria-busy="true"]')).toBeNull();
}

function tabs() {
  const list = screen.getByRole('tablist', { name: text('entity.tabs.label') });
  return {
    list,
    details: within(list).getByRole('tab', { name: text('entity.tabs.details') }),
    related: within(list).getByRole('tab', { name: text('entity.tabs.related') }),
  };
}

/** Only `selected` is the selected tab, and only its panel is shown, named by it. */
function expectSelectedTab(selected: 'details' | 'related'): void {
  const other = selected === 'details' ? 'related' : 'details';
  const shown = tabs();
  expect(shown[selected]).toHaveAttribute('aria-selected', 'true');
  expect(shown[other]).toHaveAttribute('aria-selected', 'false');
  expect(
    screen.getByRole('tabpanel', { name: text(`entity.tabs.${selected}`) }),
  ).toBeInTheDocument();
  expect(screen.queryByRole('tabpanel', { name: text(`entity.tabs.${other}`) })).toBeNull();
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
}

/** No server string anywhere in the document (D4, D15). */
function expectNoServerText(): void {
  expect(document.body.textContent).not.toContain(SERVER_TEXT);
  expect(document.body.textContent).not.toContain('Internal detail');
}

/** The real not-found page inside the shell's `main`, with nothing of the entity page. */
async function expectNotFoundPage(main: HTMLElement): Promise<void> {
  expect(
    await within(main).findByRole(
      'heading',
      { level: 1, name: localeText('en', 'common', 'notFound.title') },
      { timeout: 3000 },
    ),
  ).toBeInTheDocument();
  expect(
    within(main).getByText(localeText('en', 'common', 'notFound.description')),
  ).toBeInTheDocument();
  expect(
    within(main).getByRole('link', { name: localeText('en', 'common', 'notFound.home') }),
  ).toHaveAttribute('href', '/');
  expect(screen.getByRole('banner')).toBeInTheDocument();
  expect(
    screen.getByRole('navigation', { name: localeText('en', 'common', 'nav.catalog') }),
  ).toBeInTheDocument();
  expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(within(main).queryByRole('tablist')).toBeNull();
  expect(within(main).queryByRole('tabpanel')).toBeNull();
  expect(main.querySelector('dl')).toBeNull();
  expect(within(main).queryByRole('alert')).toBeNull();
  expectNotLoading(main);
}

/** Lets pending retries and effects run before counting requests. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// jsdom gaps

/** Methods the Radix components call that jsdom does not implement. */
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
// The header

describe('the entity page header', () => {
  it('shows the title, identifier, blueprint, times, actors, version and generation', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    await findEntityHeading(main, 'Payments API');
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);

    expect(shownText(headerField(main, 'identifier'))).toBe('svc-payments');

    const blueprintField = headerField(main, 'blueprint');
    expect(within(blueprintField).getByRole('link', { name: 'Service' })).toHaveAttribute(
      'href',
      '/catalog/service',
    );

    expect(shownText(headerField(main, 'createdAt'))).toBe(formatDate(PAYMENTS.createdAt, 'en'));
    expect(shownText(headerField(main, 'updatedAt'))).toBe(formatDate(PAYMENTS.updatedAt, 'en'));
    expectActor(headerField(main, 'createdBy'), PAYMENTS.createdBy, PAYMENTS.updatedBy);
    expectActor(headerField(main, 'updatedBy'), PAYMENTS.updatedBy, PAYMENTS.createdBy);
    expect(shownText(headerField(main, 'version'))).toBe('7');
    expect(shownText(headerField(main, 'generation'))).toBe('4');

    expectNotLoading(main);
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(history.location.pathname).toBe('/catalog/service/svc-payments');
    expect(server.entityRequests('service', 'svc-payments')).toHaveLength(1);
    expect(server.blueprintRequests('service')).toHaveLength(1);
  });

  it('shows a user and a system actor by their localized type and id', async () => {
    const server = createFakeServer();
    await renderApp('/catalog/service/svc-ledger-sync', server);
    const main = await findMain();

    await findEntityHeading(main, 'Ledger sync');
    expectActor(headerField(main, 'createdBy'), LEDGER_SYNC.createdBy, LEDGER_SYNC.updatedBy);
    expectActor(headerField(main, 'updatedBy'), LEDGER_SYNC.updatedBy, LEDGER_SYNC.createdBy);
  });

  it('goes back to the table through the blueprint link', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();
    await findEntityHeading(main, 'Payments API');

    await user.click(within(headerField(main, 'blueprint')).getByRole('link', { name: 'Service' }));

    expect(await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 })).toBeVisible();
    expect(history.location.pathname).toBe('/catalog/service');
  });

  it('uses the Spanish labels, actor types, tabs and blueprint title', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-AR');
    const server = createFakeServer();
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    await findEntityHeading(main, 'Payments API');
    const es = (key: string): string => localeText('es', 'catalog', key);
    const blueprintField = headerField(main, 'blueprint', es('entity.fields.blueprint'));
    expect(within(blueprintField).getByRole('link', { name: 'Servicio' })).toHaveAttribute(
      'href',
      '/catalog/service',
    );
    expect(shownText(headerField(main, 'createdAt', es('entity.fields.createdAt')))).toBe(
      formatDate(PAYMENTS.createdAt, 'es'),
    );
    const createdBy = headerField(main, 'createdBy', es('entity.fields.createdBy'));
    expect(createdBy).toHaveTextContent(es('entity.actorType.agent'));
    expect(createdBy).toHaveTextContent('agt_7f3a');
    const list = screen.getByRole('tablist', { name: es('entity.tabs.label') });
    expect(within(list).getByRole('tab', { name: es('entity.tabs.details') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(list).getByRole('tab', { name: es('entity.tabs.related') })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The tabs

describe('the details and related tabs', () => {
  it('opens on Details, with no tab in the URL', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments', server);
    await findEntityHeading(await findMain(), 'Payments API');

    expectSelectedTab('details');
    expect(urlSearch(history)).toEqual({});
  });

  it('switches tabs by pointer, writing the tab to the URL, without reading the entity again', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments', server);
    await findEntityHeading(await findMain(), 'Payments API');

    await user.click(tabs().related);
    await waitFor(() => {
      expect(urlSearch(history)).toEqual({ tab: 'related' });
    });
    expect(history.location.pathname).toBe('/catalog/service/svc-payments');
    expectSelectedTab('related');

    await user.click(tabs().details);
    await waitFor(() => {
      expect(urlSearch(history)).toEqual({});
    });
    expect(history.location.pathname).toBe('/catalog/service/svc-payments');
    expectSelectedTab('details');

    await settle();
    expect(server.entityRequests('service', 'svc-payments')).toHaveLength(1);
    expect(server.blueprintRequests('service')).toHaveLength(1);
  });

  it('switches tabs with the arrow keys, writing the tab to the URL', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments', server);
    await findEntityHeading(await findMain(), 'Payments API');

    tabs().details.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(urlSearch(history)).toEqual({ tab: 'related' });
    });
    expectSelectedTab('related');
    expect(tabs().related).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(urlSearch(history)).toEqual({});
    });
    expectSelectedTab('details');
  });

  it('opens on Related when the URL says so', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-payments?tab=related', server);
    await findEntityHeading(await findMain(), 'Payments API');

    expectSelectedTab('related');
    expect(urlSearch(history)).toEqual({ tab: 'related' });
  });

  it('falls back to Details for an invalid tab', async () => {
    const server = createFakeServer();
    await renderApp('/catalog/service/svc-payments?tab=bogus', server);
    await findEntityHeading(await findMain(), 'Payments API');

    expectSelectedTab('details');
  });
});

// ---------------------------------------------------------------------------
// Reserved characters

describe('reserved characters in the identifier', () => {
  it('An identifier with reserved characters opens', async () => {
    // GIVEN an entity `team@example.com:prod=1`.
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service', server);
    const table = await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });

    // WHEN the user opens it from the table.
    await user.click(await within(table).findByRole('link', { name: RESERVED_ID }));

    // THEN its entity page shows it,
    const main = await findMain();
    await findEntityHeading(main, 'Reserved entity');
    expect(shownText(headerField(main, 'identifier'))).toBe(RESERVED_ID);
    expect(shownText(headerField(main, 'version'))).toBe('3');
    expect(history.location.pathname).toBe(`/catalog/service/${RESERVED_ID}`);
    // AND no request path holds a `%`.
    await settle();
    expect(server.entityRequests('service', RESERVED_ID)).toHaveLength(1);
    expect(server.pathnames().length).toBeGreaterThan(0);
    expect(server.pathnames().filter((pathname) => pathname.includes('%'))).toEqual([]);
    expect(history.location.href).not.toContain('%');
  });

  it('opens the same entity from its URL, with no % in any request path', async () => {
    const server = createFakeServer();
    await renderApp(`/catalog/service/${RESERVED_ID}`, server);
    const main = await findMain();

    await findEntityHeading(main, 'Reserved entity');
    expect(shownText(headerField(main, 'identifier'))).toBe(RESERVED_ID);
    await settle();
    expect(server.entityRequests('service', RESERVED_ID)).toHaveLength(1);
    expect(server.pathnames().filter((pathname) => pathname.includes('%'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Not found

describe('the not-found page', () => {
  it('shows the not-found page for an entity that does not exist', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/catalog/service/svc-ghost', server);
    const main = await findMain();

    await expectNotFoundPage(main);
    await settle();
    expect(main.textContent).not.toContain('svc-ghost');
    expect(history.location.pathname).toBe('/catalog/service/svc-ghost');
    // D4: a 4xx is never retried.
    expect(server.entityRequests('service', 'svc-ghost')).toHaveLength(1);
    expectNoServerText();
  });

  it("shows the same not-found page for another tenant's entity", async () => {
    // Both entities open in tenant `t1`.
    for (const [path, title] of [
      ['/catalog/billing/ledger-main', 'Main ledger'],
      ['/catalog/_team/platform-team', 'Platform team'],
    ] as const) {
      await renderApp(path, createFakeServer({ tenant: 't1' }));
      await findEntityHeading(await findMain(), title);
      cleanup();
    }

    // An entity that exists nowhere, for the comparison.
    await renderApp('/catalog/service/svc-ghost', createFakeServer({ tenant: 't2' }));
    const nowhere = await findMain();
    await expectNotFoundPage(nowhere);
    const notFoundText = nowhere.textContent;
    cleanup();

    // A user of `t2` opens them: the blueprint is `t1`'s only, or both tenants hold it.
    for (const [blueprintId, entityId, title, blueprintTitle] of [
      ['billing', 'ledger-main', 'Main ledger', 'Billing ledger'],
      ['_team', 'platform-team', 'Platform team', undefined],
    ] as const) {
      const server = createFakeServer({ tenant: 't2' });
      const { history } = await renderApp(`/catalog/${blueprintId}/${entityId}`, server);
      const main = await findMain();

      await expectNotFoundPage(main);
      await settle();
      expect(main.textContent).toBe(notFoundText);
      expect(main.textContent).not.toContain(entityId);
      expect(document.body.textContent).not.toContain(title);
      if (blueprintTitle !== undefined) {
        expect(document.body.textContent).not.toContain(blueprintTitle);
      }
      expect(history.location.pathname).toBe(`/catalog/${blueprintId}/${entityId}`);
      expect(server.entityRequests(blueprintId, entityId).length).toBeLessThanOrEqual(1);
      expect(server.blueprintRequests(blueprintId).length).toBeLessThanOrEqual(1);
      expectNoServerText();
      cleanup();
    }
  });

  it('shows the not-found page when only the blueprint answers CATALOG_NOT_FOUND', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'blueprint' ? notFound() : undefined),
    });
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    await expectNotFoundPage(main);
    await settle();
    expect(document.body.textContent).not.toContain('Payments API');
    expect(server.blueprintRequests('service')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loading and errors

describe('the entity page while it loads and when it fails', () => {
  it('shows a busy status while the entity is pending', async () => {
    const answer = deferred();
    const server = createFakeServer({
      override: (call) => (call === 'entity' ? answer.promise : undefined),
    });
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    await expectLoading();
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(within(main).queryByRole('heading', { name: 'Payments API' })).toBeNull();

    answer.resolve(jsonResponse(200, PAYMENTS));
    await findEntityHeading(main, 'Payments API');
    expectNotLoading(main);
  });

  it('shows a busy status while only the blueprint is pending', async () => {
    const answer = deferred();
    const server = createFakeServer({
      override: (call) => (call === 'blueprint' ? answer.promise : undefined),
    });
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    await expectLoading();
    expect(within(main).queryByRole('alert')).toBeNull();

    answer.resolve(jsonResponse(200, SERVICE));
    await findEntityHeading(main, 'Payments API');
    await waitFor(() => {
      expectNotLoading(main);
    });
  });

  for (const [call, label] of [
    ['entity', 'entities.get'],
    ['blueprint', 'blueprints.get'],
  ] as const) {
    it(`shows the forbidden alert, sent once, when ${label} answers AUTH_FORBIDDEN`, async () => {
      const server = createFakeServer({
        override: (failing) => (failing === call ? forbidden() : undefined),
      });
      await renderApp('/catalog/service/svc-payments', server);
      const main = await findMain();

      const alert = await within(main).findByRole('alert', {}, { timeout: 3000 });
      expect(alert).toHaveTextContent(text('entity.error.forbidden'));
      expect(within(main).getAllByRole('alert')).toHaveLength(1);
      expect(within(main).queryByRole('tablist')).toBeNull();
      await settle();
      const sent =
        call === 'entity'
          ? server.entityRequests('service', 'svc-payments')
          : server.blueprintRequests('service');
      expect(sent).toHaveLength(1);
      expectNoServerText();
    });
  }

  it('shows the server alert after one retry on a 5xx', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'entity' ? internal() : undefined),
    });
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    const alert = await within(main).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(text('entity.error.server'));
    expect(within(main).getAllByRole('alert')).toHaveLength(1);
    expect(within(main).queryByRole('heading', { name: 'Payments API' })).toBeNull();
    await settle();
    expect(server.entityRequests('service', 'svc-payments')).toHaveLength(2);
    expectNoServerText();
  });

  it('shows the rate-limited alert, sent once, on a 429', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'entity' ? rateLimited() : undefined),
    });
    await renderApp('/catalog/service/svc-payments', server);
    const main = await findMain();

    const alert = await within(main).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(text('entity.error.rateLimited'));
    expect(within(main).getAllByRole('alert')).toHaveLength(1);
    await settle();
    expect(server.entityRequests('service', 'svc-payments')).toHaveLength(1);
    expectNoServerText();
  });

  it('sends the user to sign-in, keeping the entity as returnTo, on an unauthenticated answer', async () => {
    const server = createFakeServer({
      override: (call) => (call === 'entity' ? unauthenticated() : undefined),
    });
    const { history } = await renderApp('/catalog/service/svc-payments?tab=related', server);

    expect(await screen.findByTestId('page-signIn', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    expect(urlSearch(history)).toEqual({ returnTo: '/catalog/service/svc-payments?tab=related' });
    expectNoServerText();
  });
});

// ---------------------------------------------------------------------------
// EntityLink: the link to an entity page, disabled when it cannot be addressed

interface LinkSpec {
  readonly blueprint: string;
  readonly identifier: string;
  readonly children?: ReactNode;
}

/**
 * Renders `EntityLink` for each of `links` on the home route, with the entity slot a
 * probe, through the app router without a session (no request is made).
 */
async function renderLinks(links: readonly LinkSpec[]): Promise<{ history: RouterHistory }> {
  function LinksPage(): React.JSX.Element {
    return (
      <Suspense fallback={null}>
        <ul>
          {links.map((link) => (
            <li key={`${link.blueprint}/${link.identifier}`}>
              <EntityLink blueprint={link.blueprint} identifier={link.identifier}>
                {link.children}
              </EntityLink>
            </li>
          ))}
        </ul>
      </Suspense>
    );
  }
  const history = createMemoryHistory({ initialEntries: ['/'] });
  const router = createAppRouter({
    history,
    pages: { ...PROBES, home: LinksPage, entity: probe('entity') },
  });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  await screen.findAllByRole('listitem', {}, { timeout: 3000 });
  return { history };
}

describe('EntityLink', () => {
  it('links an addressable identifier to its entity page, with no %', async () => {
    const user = userEvent.setup();
    const { history } = await renderLinks([
      { blueprint: 'service', identifier: 'svc-payments' },
      { blueprint: 'service', identifier: RESERVED_ID },
    ]);
    const note = text('entity.notAddressable');

    const plain = await screen.findByRole('link', { name: 'svc-payments' }, { timeout: 3000 });
    expect(plain).toHaveAttribute('href', '/catalog/service/svc-payments');
    expect(plain).not.toHaveAttribute('aria-disabled', 'true');

    const reserved = screen.getByRole('link', { name: RESERVED_ID });
    expect(reserved).toHaveAttribute('href', `/catalog/service/${RESERVED_ID}`);
    expect(reserved.getAttribute('href')).not.toContain('%');
    expect(reserved).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(note)).toBeNull();

    await user.click(reserved);
    expect(await screen.findByTestId('page-entity', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(history.location.pathname).toBe(`/catalog/service/${RESERVED_ID}`);
  });

  it('uses its children as the link text', async () => {
    await renderLinks([
      { blueprint: 'service', identifier: 'svc-payments', children: 'Payments API' },
      { blueprint: 'service', identifier: 'a/b', children: 'Slash entity' },
    ]);

    expect(
      await screen.findByRole('link', { name: 'Payments API' }, { timeout: 3000 }),
    ).toHaveAttribute('href', '/catalog/service/svc-payments');
    const disabled = screen.getByRole('link', { name: 'Slash entity' });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).not.toHaveAttribute('href');
  });

  it('shows a disabled link with its note for an identifier with / or made only of dots', async () => {
    const user = userEvent.setup();
    const unaddressable = ['a/b', '/leading', 'trailing/', '.', '..', '...'] as const;
    const { history } = await renderLinks([
      ...unaddressable.map((identifier) => ({ blueprint: 'service', identifier })),
      { blueprint: 'service', identifier: 'svc-payments' },
    ]);
    const note = text('entity.notAddressable');

    for (const identifier of unaddressable) {
      const link = await screen.findByRole('link', { name: identifier }, { timeout: 3000 });
      expect(link, identifier).toHaveAttribute('aria-disabled', 'true');
      expect(link, identifier).not.toHaveAttribute('href');
      expect(link.closest('a[href]'), identifier).toBeNull();
      expect(link, identifier).toHaveAccessibleDescription(note);
      const item = link.closest('li');
      expect(item, identifier).not.toBeNull();
      expect(within(item as HTMLElement).getByText(note), identifier).toBeVisible();

      await user.click(link);
      expect(history.location.pathname, identifier).toBe('/');
    }
    expect(screen.getAllByText(note)).toHaveLength(unaddressable.length);
    expect(screen.queryByTestId('page-entity')).toBeNull();

    // An addressable identifier next to them carries no note.
    expect(screen.getByRole('link', { name: 'svc-payments' })).not.toHaveAccessibleDescription(
      note,
    );
  });
});
