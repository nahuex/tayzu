/**
 * The entity page's Related tab (task 8.3, design D4, D12, D13, D16 and Q18, Q36, Q67,
 * Q83, Q84, Q85; spec "The entity page shows details and relations").
 *
 * Spec (requirement): "a Related tab that lists forward and backward relations in the
 * spec, status or both scopes with cursor paging and links to each target. [...] An
 * entity whose identifier holds `/` or is made only of dots cannot be addressed in a URL
 * path and MUST be listed with its link disabled and an explanation."
 * Spec, scenario "Related entities in both directions": GIVEN `payments` depends on
 * `ledger`, WHEN the user opens `ledger`'s Related tab and chooses backward, THEN
 * `payments` is listed and links to its entity page.
 * D13 (Entity page): "**Related tab**: `entities.listRelated` with a direction toggle
 * (forward, backward), a scope select (spec, status, both) and cursor paging, each row
 * linking to its target."
 * Contract: `entities.listRelated` is `GET /v1/blueprints/{blueprint}/entities/{entity}/related`
 * with `direction` (`forward` or `backward`), `scope` (`spec`, `status` or `both`),
 * `pageSize` and `cursor`; it answers `{ items, cursor? }`, each item
 * `{ relation, scope, sourceBlueprint, entity: { blueprint, identifier, title } }`, where
 * `entity` is the target (forward) or the referrer (backward).
 *
 * Decisions this test pins:
 *
 * - The tab is the Related panel of the real entity page (the router's default `entity`
 *   slot, inside the shell). Its data loads only once the Related tab is selected: the
 *   Details tab sends no `entities.listRelated` request.
 * - Direction and scope are component state, not URL state (D12 gives the entity route
 *   the `tab` search param only): the URL stays `?tab=related` whatever is chosen.
 * - The direction toggle is a radio group (a `group` or `radiogroup` named
 *   `catalog:entity.related.direction.label`, with the radios
 *   `catalog:entity.related.direction.forward` and `.backward`); Forward is the default.
 * - The scope select is a native `<select>` (a `combobox`) labelled
 *   `catalog:entity.related.scope.label`, offering `catalog:entity.related.scope.both`,
 *   `.spec` and `.status` (order left open); Both is the default, as the API's.
 * - Every request sends `direction`, `scope` and `pageSize=50` explicitly, and `cursor`
 *   only past the first page (as Q83's table): for example
 *   `GET /v1/blueprints/service/entities/ledger/related?direction=backward&pageSize=50&scope=spec`.
 *   No path holds a `%` for an identifier with `@`, `:` or `=` (Q36).
 * - Paging, as Q83: "Next" follows the returned cursor and pushes the current page's
 *   cursor on an in-memory stack; "Previous" pops it. Previous is disabled on the first
 *   page, Next when the answer has no cursor. A direction or scope change starts over on
 *   the first page with an empty stack. A cursor the server refuses (`validation` on
 *   `/cursor`, D6) restarts from the first page with no message and is never sent again.
 * - The rows are a table named `catalog:entity.related.caption`, with the column headers
 *   `catalog:entity.related.columns.relation`, `.identifier`, `.title`, `.blueprint` and
 *   `.scope`, in that order. Each row, in the server's order: the relation identifier as
 *   text; the item's entity as `EntityLink` (named by its identifier, to
 *   `/catalog/<entity.blueprint>/<entity.identifier>`, or the disabled link with
 *   `catalog:entity.notAddressable` as its description); its title; its blueprint
 *   identifier; the localized row scope (`catalog:entity.related.scope.spec` or
 *   `.status`).
 * - An empty page shows `catalog:entity.related.empty` in the panel, with no data row (the
 *   text may sit in a full-width row of the table or outside it).
 * - States, as Q84, inside the Related panel while the header stays: a `role="status"`
 *   element with `aria-busy="true"` showing `catalog:entity.related.loading` while the
 *   call is pending; one alert by kind otherwise: `forbidden`
 *   (`catalog:entity.related.error.forbidden`), `rate_limited`
 *   (`catalog:entity.related.error.rateLimited`) and every other kind
 *   (`catalog:entity.related.error.server`, after D4's one retry on a 5xx); never the
 *   server's message. A `not_found` answer of `entities.listRelated` is left open.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), and the
 * query client is `createQueryClient()` (D4's retry policy) with no retry delay.
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

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `catalog:<key>` text in `locale`; a missing key fails the test as an assertion. */
function localeText(locale: Locale, key: string): string {
  let node: unknown = LOCALE_FILES[`../i18n/locales/${locale}/catalog.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `catalog:${key} in ${locale}`).toBe(true);
  return node as string;
}

/** The pinned English texts of this task's `catalog:entity.related.*` keys, and reused ones. */
const PINNED = {
  'entity.tabs.related': 'Related',
  'entity.notAddressable': 'This entity cannot be opened by URL.',
  'entity.related.caption': 'Related entities',
  'entity.related.direction.label': 'Direction',
  'entity.related.direction.forward': 'Forward',
  'entity.related.direction.backward': 'Backward',
  'entity.related.scope.label': 'Scope',
  'entity.related.scope.both': 'Spec and status',
  'entity.related.scope.spec': 'Spec',
  'entity.related.scope.status': 'Status',
  'entity.related.columns.relation': 'Relation',
  'entity.related.columns.identifier': 'Identifier',
  'entity.related.columns.title': 'Title',
  'entity.related.columns.blueprint': 'Blueprint',
  'entity.related.columns.scope': 'Scope',
  'entity.related.empty': 'No related entities.',
  'entity.related.loading': 'Loading related entities...',
  'entity.related.pagination.previous': 'Previous',
  'entity.related.pagination.next': 'Next',
  'entity.related.error.forbidden': 'You do not have permission to view the related entities.',
  'entity.related.error.server': 'The related entities could not be loaded. Try again later.',
  'entity.related.error.rateLimited': 'Too many requests. Wait a moment and try again.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The English text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = localeText('en', key);
  expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

type Direction = 'forward' | 'backward';
type Scope = 'spec' | 'status';
type ScopeFilter = Scope | 'both';

interface Actor {
  readonly type: 'user' | 'agent' | 'integration' | 'system';
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

function blueprint(identifier: string, title: string) {
  return {
    identifier,
    title: { en: title },
    schema: { properties: {}, required: [] },
    relations: {},
    version: 1,
    createdAt: '2026-08-01T10:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-08-01T10:00:00.000Z',
    updatedBy: MEMBER,
  };
}

const BLUEPRINTS = [
  blueprint('service', 'Service'),
  blueprint('database', 'Database'),
  blueprint('monitor', 'Monitor'),
];

interface Entity {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
}

function entityBody(item: Entity) {
  return {
    ...item,
    spec: { properties: {}, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: MEMBER,
  };
}

const LEDGER: Entity = { blueprint: 'service', identifier: 'ledger', title: 'Ledger' };
const PAYMENTS: Entity = { blueprint: 'service', identifier: 'payments', title: 'Payments API' };
const LEDGER_DB: Entity = {
  blueprint: 'database',
  identifier: 'ledger-db',
  title: 'Ledger database',
};
const UPTIME: Entity = { blueprint: 'monitor', identifier: 'uptime-probe', title: 'Uptime probe' };
/** An entity with no relation at all. */
const LONELY: Entity = { blueprint: 'service', identifier: 'lonely', title: 'Lonely service' };
/** An entity referred to by 120 services, for paging. */
const SHARED: Entity = { blueprint: 'service', identifier: 'shared-lib', title: 'Shared library' };
/** An entity whose path holds `@`, `:` and `=`, and whose related rows test the links. */
const RESERVED: Entity = {
  blueprint: 'service',
  identifier: 'team@example.com:prod=1',
  title: 'Reserved entity',
};
const RESERVED_TARGET: Entity = {
  blueprint: 'service',
  identifier: 'billing@eu:tier=1',
  title: 'EU billing',
};
const SLASH_TARGET: Entity = { blueprint: 'service', identifier: 'infra/core', title: 'Core' };
const DOTS_TARGET: Entity = { blueprint: 'service', identifier: '..', title: 'Dots' };

const REFERRERS: readonly Entity[] = Array.from({ length: 120 }, (_, index) => {
  const number = String(index).padStart(3, '0');
  return { blueprint: 'service', identifier: `svc-${number}`, title: `Service ${number}` };
});

const ENTITIES: readonly Entity[] = [
  LEDGER,
  PAYMENTS,
  LEDGER_DB,
  UPTIME,
  LONELY,
  SHARED,
  RESERVED,
  RESERVED_TARGET,
  ...REFERRERS,
];

interface RelatedItem {
  readonly relation: string;
  readonly scope: Scope;
  readonly sourceBlueprint: string;
  readonly entity: Entity;
}

function item(relation: string, scope: Scope, sourceBlueprint: string, target: Entity) {
  return { relation, scope, sourceBlueprint, entity: target } satisfies RelatedItem;
}

/** What each entity relates to, in the server's order (relation, then identifier). */
const RELATED: Record<string, Record<Direction, readonly RelatedItem[]>> = {
  'service/ledger': {
    forward: [
      item('storedIn', 'spec', 'service', LEDGER_DB),
      item('watchedBy', 'status', 'service', UPTIME),
    ],
    // `payments` depends on `ledger`; `uptime-probe` observes it, in status.
    backward: [
      item('dependsOn', 'spec', 'service', PAYMENTS),
      item('observes', 'status', 'monitor', UPTIME),
    ],
  },
  'service/shared-lib': {
    forward: [],
    backward: REFERRERS.map((referrer) => item('uses', 'spec', 'service', referrer)),
  },
  'service/lonely': { forward: [], backward: [] },
  [`service/${RESERVED.identifier}`]: {
    forward: [
      item('dependsOn', 'spec', 'service', DOTS_TARGET),
      item('dependsOn', 'spec', 'service', RESERVED_TARGET),
      item('dependsOn', 'spec', 'service', SLASH_TARGET),
    ],
    backward: [],
  },
};

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entity_relation" on 10.0.0.7';

const PAGE_SIZE = 50;

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

const notFound = (): Response => errorResponse(404, 'CATALOG_NOT_FOUND');
const forbidden = (): Response => errorResponse(403, 'AUTH_FORBIDDEN');
const internal = (): Response => errorResponse(500, 'INTERNAL_SERVER_ERROR');
const rateLimited = (): Response => errorResponse(429, 'AUTH_RATE_LIMITED');
const invalid = (path: string): Response =>
  errorResponse(400, 'CATALOG_VALIDATION_FAILED', { issues: [{ path, message: SERVER_TEXT }] });

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Decodes a path segment for the lookup only; the recorded path stays raw. */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The opaque cursor of the page that starts at `offset` of one direction and scope. */
function cursorOf(direction: Direction, scope: ScopeFilter, offset: number): string {
  return `rel.${direction}.${scope}.${String(offset)}`;
}

function isDirection(value: string | null): value is Direction {
  return value === 'forward' || value === 'backward';
}

function isScopeFilter(value: string | null): value is ScopeFilter {
  return value === 'spec' || value === 'status' || value === 'both';
}

/** The items of one direction and scope, as the server filters them. */
function relatedOf(key: string, direction: Direction, scope: ScopeFilter): RelatedItem[] {
  const all = RELATED[key]?.[direction] ?? [];
  return all.filter((candidate) => scope === 'both' || candidate.scope === scope);
}

/** Overrides the `entities.listRelated` answer; `undefined` keeps the fake's own. */
type RelatedOverride = (search: URLSearchParams) => Response | Promise<Response> | undefined;

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me`, `blueprints.list`,
 * `blueprints.get`, `entities.list`, `entities.get` and `entities.listRelated`. The last
 * checks its input as the server does (a missing or unknown `direction` or `scope`, or a
 * page size other than 50, is a validation answer, which fails the test's row
 * assertions) and refuses a cursor of another direction or scope on `/cursor`.
 */
function createFakeServer(options: { related?: RelatedOverride } = {}) {
  const requests: string[] = [];
  const pathnames: string[] = [];

  const relatedAnswer = (key: string, search: URLSearchParams): Response => {
    const direction = search.get('direction');
    const scope = search.get('scope');
    if (!isDirection(direction)) return invalid('/direction');
    if (!isScopeFilter(scope)) return invalid('/scope');
    if (search.get('pageSize') !== String(PAGE_SIZE)) return invalid('/pageSize');
    const items = relatedOf(key, direction, scope);
    const cursor = search.get('cursor');
    let offset = 0;
    if (cursor !== null) {
      const match = /^rel\.([a-z]+)\.([a-z]+)\.(\d+)$/.exec(cursor);
      if (match?.[1] !== direction || match[2] !== scope) return invalid('/cursor');
      offset = Number(match[3]);
    }
    const page = items.slice(offset, offset + PAGE_SIZE);
    const more = offset + PAGE_SIZE < items.length;
    return jsonResponse(200, {
      items: page,
      ...(more ? { cursor: cursorOf(direction, scope, offset + PAGE_SIZE) } : {}),
    });
  };

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
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: BLUEPRINTS });
    const match = /^\/v1\/blueprints\/([^/]+)(?:\/entities(?:\/([^/]+)(\/related)?)?)?$/.exec(
      pathname,
    );
    const rawBlueprint = match?.[1];
    if (match === null || rawBlueprint === undefined) return notFound();
    const blueprintId = segment(rawBlueprint);
    const found = BLUEPRINTS.find((candidate) => candidate.identifier === blueprintId);
    if (found === undefined) return notFound();
    const held = ENTITIES.filter((candidate) => candidate.blueprint === blueprintId);
    if (pathname.endsWith('/entities')) {
      return jsonResponse(200, {
        items: [...held]
          .sort((a, b) => compareText(a.identifier, b.identifier))
          .slice(0, PAGE_SIZE)
          .map(entityBody),
      });
    }
    const rawEntity = match[2];
    if (rawEntity === undefined) return jsonResponse(200, found);
    const entityId = segment(rawEntity);
    const target = held.find((candidate) => candidate.identifier === entityId);
    if (target === undefined) return notFound();
    if (match[3] === undefined) return jsonResponse(200, entityBody(target));

    const overridden = await options.related?.(url.searchParams);
    if (overridden !== undefined) return overridden;
    return relatedAnswer(`${blueprintId}/${entityId}`, url.searchParams);
  };

  return {
    fetch,
    /** Every request path, raw, as the server received it. */
    pathnames(): readonly string[] {
      return pathnames;
    },
    /** The `entities.listRelated` requests, `GET <path>?<sorted query>`. */
    relatedRequests(): string[] {
      return requests.filter((line) =>
        /^GET \/v1\/blueprints\/[^/]+\/entities\/[^/?]+\/related/.test(line),
      );
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

/** The exact `entities.listRelated` request line for one page. */
function relatedRequest(
  root: Entity,
  direction: Direction,
  scope: ScopeFilter,
  cursor?: string,
): string {
  const query = new URLSearchParams([
    ...(cursor === undefined ? [] : [['cursor', cursor] as [string, string]]),
    ['direction', direction] as [string, string],
    ['pageSize', String(PAGE_SIZE)] as [string, string],
    ['scope', scope] as [string, string],
  ]).toString();
  return `GET /v1/blueprints/${root.blueprint}/entities/${root.identifier}/related?${query}`;
}

/** The `entities.listRelated` requests sent after `before` of them had been sent. */
function relatedSince(server: FakeServer, before: number): string[] {
  return server.relatedRequests().slice(before);
}

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

/** Renders the whole app as `main.tsx` does at `path`, with no retry delay. */
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

/** Opens `root`'s entity page on its Related tab and waits for the panel. */
async function openRelated(
  root: Entity,
  server: FakeServer,
): Promise<{ history: RouterHistory; panel: HTMLElement }> {
  const app = await renderApp(`/catalog/${root.blueprint}/${root.identifier}?tab=related`, server);
  const panel = await findRelatedPanel(root);
  return { ...app, panel };
}

async function findRelatedPanel(root: Entity): Promise<HTMLElement> {
  const main = await screen.findByRole('main', {}, { timeout: 3000 });
  await within(main).findByRole('heading', { level: 1, name: root.title }, { timeout: 3000 });
  return within(main).findByRole(
    'tabpanel',
    { name: text('entity.tabs.related') },
    { timeout: 3000 },
  );
}

function urlSearch(history: RouterHistory): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(history.location.search));
}

/** The direction toggle: one radio group named by its label, and its two radios. */
function directionToggle(panel: HTMLElement) {
  const name = text('entity.related.direction.label');
  const groups = [
    ...within(panel).queryAllByRole('radiogroup', { name }),
    ...within(panel).queryAllByRole('group', { name }),
  ];
  expect(groups, `one radio group "${name}"`).toHaveLength(1);
  const group = groups[0] as HTMLElement;
  expect(within(group).getAllByRole('radio')).toHaveLength(2);
  return {
    group,
    forward: within(group).getByRole('radio', { name: text('entity.related.direction.forward') }),
    backward: within(group).getByRole('radio', {
      name: text('entity.related.direction.backward'),
    }),
  };
}

function scopeSelect(panel: HTMLElement): HTMLSelectElement {
  const select = within(panel).getByRole('combobox', { name: text('entity.related.scope.label') });
  expect(select.tagName).toBe('SELECT');
  return select as HTMLSelectElement;
}

function pager(panel: HTMLElement) {
  return {
    previous: within(panel).getByRole('button', {
      name: text('entity.related.pagination.previous'),
    }),
    next: within(panel).getByRole('button', { name: text('entity.related.pagination.next') }),
  };
}

/** The text of an element with its white space collapsed. */
function shownText(element: Element): string {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

const SCOPE_KEYS = {
  spec: 'entity.related.scope.spec',
  status: 'entity.related.scope.status',
} as const satisfies Record<Scope, PinnedKey>;

/** A full-width row holding only the empty or loading text, as the table page renders. */
function isMessageRow(row: HTMLElement): boolean {
  const shown = shownText(row);
  return (
    within(row).queryAllByRole('cell').length === 1 &&
    (shown === PINNED['entity.related.empty'] || shown === PINNED['entity.related.loading'])
  );
}

/**
 * The data rows of the related table: none when the panel shows no table, and never a
 * full-width row holding the empty or loading text.
 */
function dataRows(panel: HTMLElement): HTMLElement[] {
  const table = within(panel).queryByRole('table', { name: text('entity.related.caption') });
  if (table === null) return [];
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('columnheader').length === 0)
    .filter((row) => !isMessageRow(row));
}

/** One row as shown: relation, the link's name, title, blueprint and localized scope. */
function shownRow(row: HTMLElement): string[] {
  const cells = within(row).getAllByRole('cell');
  expect(cells).toHaveLength(5);
  const [relation, identifier, title, blueprintCell, scope] = cells as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ];
  const links = within(identifier).getAllByRole('link');
  expect(links).toHaveLength(1);
  return [
    shownText(relation),
    shownText(links[0] as HTMLElement),
    shownText(title),
    shownText(blueprintCell),
    shownText(scope),
  ];
}

function expectedRow(related: RelatedItem): string[] {
  return [
    related.relation,
    related.entity.identifier,
    related.entity.title,
    related.entity.blueprint,
    PINNED[SCOPE_KEYS[related.scope]],
  ];
}

/** Waits until the panel shows exactly `expected`, in order. */
async function expectRows(panel: HTMLElement, expected: readonly RelatedItem[]): Promise<void> {
  await waitFor(
    () => {
      expect(dataRows(panel).map(shownRow)).toEqual(expected.map(expectedRow));
    },
    { timeout: 3000 },
  );
}

function pageOf(items: readonly RelatedItem[], page: number): RelatedItem[] {
  return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

/** The status element showing the related loading text, if any. */
function loadingIndicator(panel: HTMLElement): HTMLElement | undefined {
  return within(panel)
    .queryAllByRole('status')
    .find((element) => element.textContent.includes(PINNED['entity.related.loading']));
}

/** No server string anywhere in the document (D4, D15). */
function expectNoServerText(): void {
  expect(document.body.textContent).not.toContain(SERVER_TEXT);
  expect(document.body.textContent).not.toContain('Internal detail');
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

const LEDGER_RELATED = RELATED['service/ledger'] as Record<Direction, readonly RelatedItem[]>;
const SHARED_BACKWARD = (RELATED['service/shared-lib'] as Record<Direction, RelatedItem[]>)
  .backward;

// ---------------------------------------------------------------------------
// Directions

describe('the related tab: direction', () => {
  it('Related entities in both directions', async () => {
    // GIVEN `payments` depends on `ledger`.
    const user = userEvent.setup();
    const server = createFakeServer();

    // WHEN the user opens `ledger`'s Related tab ...
    const { history, panel } = await openRelated(LEDGER, server);
    const toggle = directionToggle(panel);
    expect(toggle.forward).toBeChecked();
    expect(toggle.backward).not.toBeChecked();
    expect(scopeSelect(panel)).toHaveDisplayValue(text('entity.related.scope.both'));

    // Forward by default: what `ledger` points to.
    await expectRows(panel, LEDGER_RELATED.forward);
    expect(server.relatedRequests()).toEqual([relatedRequest(LEDGER, 'forward', 'both')]);
    const headers = within(
      within(panel).getByRole('table', { name: text('entity.related.caption') }),
    ).getAllByRole('columnheader');
    expect(headers.map(shownText)).toEqual([
      text('entity.related.columns.relation'),
      text('entity.related.columns.identifier'),
      text('entity.related.columns.title'),
      text('entity.related.columns.blueprint'),
      text('entity.related.columns.scope'),
    ]);
    expect(within(panel).getByRole('link', { name: 'ledger-db' })).toHaveAttribute(
      'href',
      '/catalog/database/ledger-db',
    );

    // ... and chooses backward.
    const before = server.relatedRequests().length;
    await user.click(toggle.backward);
    expect(directionToggle(panel).backward).toBeChecked();
    expect(directionToggle(panel).forward).not.toBeChecked();

    // THEN `payments` is listed ...
    await expectRows(panel, LEDGER_RELATED.backward);
    expect(relatedSince(server, before)).toEqual([relatedRequest(LEDGER, 'backward', 'both')]);
    // The direction is the tab's own state, not the URL's (D12).
    expect(urlSearch(history)).toEqual({ tab: 'related' });

    // ... and links to its entity page.
    const payments = within(panel).getByRole('link', { name: 'payments' });
    expect(payments).toHaveAttribute('href', '/catalog/service/payments');
    await user.click(payments);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payments API' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(history.location.pathname).toBe('/catalog/service/payments');
    expectNoServerText();
  });

  it('loads the related entities only once the Related tab is selected', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp('/catalog/service/ledger', server);
    const main = await screen.findByRole('main', {}, { timeout: 3000 });
    await within(main).findByRole('heading', { level: 1, name: 'Ledger' }, { timeout: 3000 });
    await settle();
    expect(server.relatedRequests()).toEqual([]);

    await user.click(within(main).getByRole('tab', { name: text('entity.tabs.related') }));
    const panel = await findRelatedPanel(LEDGER);
    await expectRows(panel, LEDGER_RELATED.forward);
    expect(server.relatedRequests()).toEqual([relatedRequest(LEDGER, 'forward', 'both')]);
  });
});

// ---------------------------------------------------------------------------
// Scope

describe('the related tab: scope', () => {
  it('sends the chosen scope in the request, for each direction', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history, panel } = await openRelated(LEDGER, server);
    await expectRows(panel, LEDGER_RELATED.forward);

    const offered = [...scopeSelect(panel).options].map((option) => shownText(option));
    expect([...offered].sort(compareText)).toEqual(
      [
        text('entity.related.scope.both'),
        text('entity.related.scope.spec'),
        text('entity.related.scope.status'),
      ].sort(compareText),
    );

    let before = server.relatedRequests().length;
    await user.selectOptions(scopeSelect(panel), text('entity.related.scope.spec'));
    expect(scopeSelect(panel)).toHaveDisplayValue(text('entity.related.scope.spec'));
    await expectRows(
      panel,
      LEDGER_RELATED.forward.filter((related) => related.scope === 'spec'),
    );
    expect(relatedSince(server, before)).toEqual([relatedRequest(LEDGER, 'forward', 'spec')]);

    before = server.relatedRequests().length;
    await user.selectOptions(scopeSelect(panel), text('entity.related.scope.status'));
    await expectRows(
      panel,
      LEDGER_RELATED.forward.filter((related) => related.scope === 'status'),
    );
    expect(relatedSince(server, before)).toEqual([relatedRequest(LEDGER, 'forward', 'status')]);

    // The scope stays when the direction changes.
    before = server.relatedRequests().length;
    await user.click(directionToggle(panel).backward);
    await expectRows(
      panel,
      LEDGER_RELATED.backward.filter((related) => related.scope === 'status'),
    );
    expect(scopeSelect(panel)).toHaveDisplayValue(text('entity.related.scope.status'));
    expect(relatedSince(server, before)).toEqual([relatedRequest(LEDGER, 'backward', 'status')]);

    before = server.relatedRequests().length;
    await user.selectOptions(scopeSelect(panel), text('entity.related.scope.spec'));
    await expectRows(
      panel,
      LEDGER_RELATED.backward.filter((related) => related.scope === 'spec'),
    );
    expect(relatedSince(server, before)).toEqual([relatedRequest(LEDGER, 'backward', 'spec')]);

    // The scope is the tab's own state, not the URL's (D12).
    expect(urlSearch(history)).toEqual({ tab: 'related' });
    expectNoServerText();
  });
});

// ---------------------------------------------------------------------------
// Paging

describe('the related tab: paging', () => {
  it('pages forward with the returned cursor and back with the stack', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history, panel } = await openRelated(SHARED, server);
    await waitFor(() => {
      expect(within(panel).getByText(text('entity.related.empty'))).toBeInTheDocument();
    });

    let before = server.relatedRequests().length;
    await user.click(directionToggle(panel).backward);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));
    expect(relatedSince(server, before)).toEqual([relatedRequest(SHARED, 'backward', 'both')]);
    expect(pager(panel).previous).toBeDisabled();
    expect(pager(panel).next).toBeEnabled();

    // Next: the returned cursor goes to the request.
    const second = cursorOf('backward', 'both', PAGE_SIZE);
    before = server.relatedRequests().length;
    await user.click(pager(panel).next);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 1));
    expect(relatedSince(server, before)).toEqual([
      relatedRequest(SHARED, 'backward', 'both', second),
    ]);
    expect(pager(panel).previous).toBeEnabled();
    expect(pager(panel).next).toBeEnabled();

    // Next again: the last page, with no cursor, so Next is disabled.
    const third = cursorOf('backward', 'both', 2 * PAGE_SIZE);
    before = server.relatedRequests().length;
    await user.click(pager(panel).next);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 2));
    expect(relatedSince(server, before)).toEqual([
      relatedRequest(SHARED, 'backward', 'both', third),
    ]);
    expect(pager(panel).previous).toBeEnabled();
    expect(pager(panel).next).toBeDisabled();

    // Previous pops the stack: the second page, then the first. A cached page may be
    // shown without a new request; any request is that page's.
    before = server.relatedRequests().length;
    await user.click(pager(panel).previous);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 1));
    for (const line of relatedSince(server, before)) {
      expect(line).toBe(relatedRequest(SHARED, 'backward', 'both', second));
    }
    expect(pager(panel).previous).toBeEnabled();
    expect(pager(panel).next).toBeEnabled();

    before = server.relatedRequests().length;
    await user.click(pager(panel).previous);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));
    for (const line of relatedSince(server, before)) {
      expect(line).toBe(relatedRequest(SHARED, 'backward', 'both'));
    }
    expect(pager(panel).previous).toBeDisabled();
    expect(pager(panel).next).toBeEnabled();

    // Paging is the tab's own state, not the URL's.
    expect(urlSearch(history)).toEqual({ tab: 'related' });
    expectNoServerText();
  });

  it('clears the cursor and the stack when the scope or the direction changes on a later page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { panel } = await openRelated(SHARED, server);
    await user.click(directionToggle(panel).backward);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));
    await user.click(pager(panel).next);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 1));

    // A scope change starts over on the first page, with no cursor.
    let before = server.relatedRequests().length;
    await user.selectOptions(scopeSelect(panel), text('entity.related.scope.spec'));
    await waitFor(() => {
      expect(relatedSince(server, before)).toEqual([relatedRequest(SHARED, 'backward', 'spec')]);
    });
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));
    expect(pager(panel).previous).toBeDisabled();

    // Its own Next, then a direction change: the first page again, with no cursor.
    before = server.relatedRequests().length;
    await user.click(pager(panel).next);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 1));
    expect(relatedSince(server, before)).toEqual([
      relatedRequest(SHARED, 'backward', 'spec', cursorOf('backward', 'spec', PAGE_SIZE)),
    ]);

    before = server.relatedRequests().length;
    await user.click(directionToggle(panel).forward);
    await waitFor(() => {
      expect(within(panel).getByText(text('entity.related.empty'))).toBeInTheDocument();
    });
    expect(relatedSince(server, before)).toEqual([relatedRequest(SHARED, 'forward', 'spec')]);
    expect(dataRows(panel)).toEqual([]);
    expect(pager(panel).previous).toBeDisabled();
    expect(pager(panel).next).toBeDisabled();
    expectNoServerText();
  });

  it('restarts from the first page when the cursor answers CATALOG_VALIDATION_FAILED on /cursor', async () => {
    const user = userEvent.setup();
    // Every cursor is refused, as D6 refuses an anchor deleted meanwhile.
    const server = createFakeServer({
      related: (search) => (search.has('cursor') ? invalid('/cursor') : undefined),
    });
    const { panel } = await openRelated(SHARED, server);
    await user.click(directionToggle(panel).backward);
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));

    const refused = relatedRequest(
      SHARED,
      'backward',
      'both',
      cursorOf('backward', 'both', PAGE_SIZE),
    );
    await user.click(pager(panel).next);
    await waitFor(() => {
      expect(server.relatedRequests()).toContain(refused);
    });
    await settle();
    await expectRows(panel, pageOf(SHARED_BACKWARD, 0));
    expect(pager(panel).previous).toBeDisabled();
    expect(within(panel).queryByRole('alert')).toBeNull();

    // The refused cursor is sent once (no retry on a 4xx) and never again.
    await settle();
    expect(server.relatedRequests().filter((line) => line === refused)).toHaveLength(1);
    expectNoServerText();
  });
});

// ---------------------------------------------------------------------------
// Empty list

describe('the related tab: an empty list', () => {
  it('shows the empty text in both directions, with paging disabled', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { panel } = await openRelated(LONELY, server);
    const empty = text('entity.related.empty');

    await waitFor(() => {
      expect(within(panel).getByText(empty)).toBeInTheDocument();
    });
    expect(server.relatedRequests()).toEqual([relatedRequest(LONELY, 'forward', 'both')]);
    expect(dataRows(panel)).toEqual([]);
    expect(within(panel).queryAllByRole('link')).toEqual([]);
    expect(pager(panel).previous).toBeDisabled();
    expect(pager(panel).next).toBeDisabled();
    expect(loadingIndicator(panel)).toBeUndefined();
    expect(within(panel).queryByRole('alert')).toBeNull();

    await user.click(directionToggle(panel).backward);
    await waitFor(() => {
      expect(server.relatedRequests()).toEqual([
        relatedRequest(LONELY, 'forward', 'both'),
        relatedRequest(LONELY, 'backward', 'both'),
      ]);
    });
    await waitFor(() => {
      expect(within(panel).getByText(empty)).toBeInTheDocument();
    });
    expect(dataRows(panel)).toEqual([]);
    expect(pager(panel).next).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Row links

describe('the related tab: row links', () => {
  it('links an addressable target with no % and disables the link of one that cannot be addressed', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history, panel } = await openRelated(RESERVED, server);
    const rows = (RELATED[`service/${RESERVED.identifier}`] as Record<Direction, RelatedItem[]>)
      .forward;
    await expectRows(panel, rows);

    // The root's own identifier holds `@`, `:` and `=`: no request path holds a `%`.
    expect(server.relatedRequests()).toEqual([relatedRequest(RESERVED, 'forward', 'both')]);
    for (const pathname of server.pathnames()) expect(pathname).not.toContain('%');

    const note = text('entity.notAddressable');
    for (const identifier of [SLASH_TARGET.identifier, DOTS_TARGET.identifier]) {
      const link = within(panel).getByRole('link', { name: identifier });
      expect(link, identifier).toHaveAttribute('aria-disabled', 'true');
      expect(link, identifier).not.toHaveAttribute('href');
      expect(link.closest('a[href]'), identifier).toBeNull();
      expect(link, identifier).toHaveAccessibleDescription(note);
      await user.click(link);
      expect(history.location.pathname, identifier).toBe(`/catalog/service/${RESERVED.identifier}`);
    }
    expect(within(panel).getAllByText(note)).toHaveLength(2);

    const reserved = within(panel).getByRole('link', { name: RESERVED_TARGET.identifier });
    expect(reserved).toHaveAttribute('href', `/catalog/service/${RESERVED_TARGET.identifier}`);
    expect(reserved.getAttribute('href')).not.toContain('%');
    expect(reserved).not.toHaveAttribute('aria-disabled', 'true');
    expect(reserved).not.toHaveAccessibleDescription(note);

    await user.click(reserved);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'EU billing' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(history.location.pathname).toBe(`/catalog/service/${RESERVED_TARGET.identifier}`);
    for (const pathname of server.pathnames()) expect(pathname).not.toContain('%');
  });
});

// ---------------------------------------------------------------------------
// States

describe('the related tab: states', () => {
  it('shows a busy status in the panel while the call is pending', async () => {
    const pending = deferred();
    const server = createFakeServer({ related: () => pending.promise });
    const { panel } = await openRelated(LEDGER, server);
    const loading = text('entity.related.loading');

    await waitFor(() => {
      expect(loadingIndicator(panel), `a status element showing "${loading}"`).toBeDefined();
    });
    expect(
      loadingIndicator(panel)?.closest('[aria-busy="true"]'),
      'aria-busy="true" on it or above',
    ).not.toBe(null);
    // The header stays.
    expect(screen.getByRole('heading', { level: 1, name: 'Ledger' })).toBeInTheDocument();

    pending.resolve(jsonResponse(200, { items: LEDGER_RELATED.forward }));
    await expectRows(panel, LEDGER_RELATED.forward);
    expect(loadingIndicator(panel)).toBeUndefined();
    expect(panel.querySelector('[aria-busy="true"]')).toBeNull();
  });

  const failures: readonly {
    readonly name: string;
    readonly answer: () => Response;
    readonly key: PinnedKey;
    readonly requests: number;
  }[] = [
    { name: 'forbidden', answer: forbidden, key: 'entity.related.error.forbidden', requests: 1 },
    {
      name: 'rate_limited',
      answer: rateLimited,
      key: 'entity.related.error.rateLimited',
      requests: 1,
    },
    // A 5xx is retried once (D4).
    { name: 'server', answer: internal, key: 'entity.related.error.server', requests: 2 },
    // Any other kind shows the generic text.
    {
      name: 'validation',
      answer: () => invalid('/direction'),
      key: 'entity.related.error.server',
      requests: 1,
    },
  ];

  for (const failure of failures) {
    it(`shows one alert in the panel for a ${failure.name} answer, never the server's text`, async () => {
      const server = createFakeServer({ related: failure.answer });
      const { panel } = await openRelated(LEDGER, server);

      const alert = await within(panel).findByRole('alert', {}, { timeout: 3000 });
      expect(alert).toHaveTextContent(text(failure.key));
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(dataRows(panel)).toEqual([]);
      // The header stays.
      expect(screen.getByRole('heading', { level: 1, name: 'Ledger' })).toBeInTheDocument();
      await settle();
      expect(server.relatedRequests()).toHaveLength(failure.requests);
      expectNoServerText();
    });
  }
});
