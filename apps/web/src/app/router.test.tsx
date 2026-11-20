/**
 * The router (task 5.7, design D12, D13, D15 and Q36, Q65; spec "The entity page shows
 * details and relations", scenario "An identifier with reserved characters opens", and
 * the not-found page of "The catalog table shows a blueprint's entities").
 *
 * D12 (Routes): "`/sign-in`, `/forgot-password`, `/reset-password`, `/accept-invitation`,
 * `/change-password`, `/mfa/enrol`, `/step-up/complete`, `/` (the home: the blueprint
 * list), `/catalog/$blueprint` (the table), `/catalog/$blueprint/$entity` (the entity
 * page, search param `tab`: `details` or `related`), `/search` (search param `q`), and a
 * not-found page. Every search param is parsed by a Zod schema with the D15 rules; an
 * invalid value falls back to its default, never to an error page. The router is created
 * with `pathParamsAllowedCharacters: ['@', ':', '=']`, so an entity path holds those
 * characters unencoded, like the API calls of D4 (Q36)."
 * D13 (Table page): "`entities.list` with `sort`, `order`, `pageSize` (25, 50 or 100) and
 * `cursor` from the URL." D6: `sort` is `identifier` (default), `title` or `updatedAt`;
 * `order` is `asc` (default) or `desc`. `CatalogLimits`: default page size 50, cursor at
 * most 512 characters, search `q` 2 to 100 characters.
 * D15: "Every response, search param and fragment value is parsed with Zod [...] and
 * lengths are checked before parsing further." A `returnTo` value goes through
 * `safeReturnPath` (`src/lib/return-path.ts`, Q65); anything else becomes `/`.
 *
 * Assumed API of `./router.js` (`src/app/router.tsx`):
 *
 * ```ts
 * import type { ComponentType } from 'react';
 * import type { RouterHistory } from '@tanstack/react-router';
 *
 * // One page slot per D12 route (the not-found page is not a slot):
 * export const PAGE_NAMES: readonly [
 *   'signIn', 'forgotPassword', 'resetPassword', 'acceptInvitation', 'changePassword',
 *   'mfaEnrol', 'stepUpComplete', 'home', 'catalogTable', 'entity', 'search',
 * ];
 * export type PageName = (typeof PAGE_NAMES)[number];
 * export type AppPages = Record<PageName, ComponentType>;
 *
 * // The TanStack Router code-based tree of D12, created with
 * // `pathParamsAllowedCharacters: ['@', ':', '=']`. Each route renders `pages[name]`,
 * // where `pages` is the given map over the default one: placeholders in 5.7, the real
 * // pages from groups 6 to 9, which replace the defaults without touching this test.
 * // An unknown path renders the not-found page, whose level-1 heading names it
 * // ("Page not found" or similar in `en`, from the `common` namespace).
 * export function createAppRouter(options: {
 *   history: RouterHistory;
 *   pages?: Partial<AppPages>;
 * }): AppRouter;
 * ```
 *
 * Validated search, as a page reads it with `useSearch` (each field falls back on its
 * own, so one bad field never resets the others; every field is optional on input, so a
 * `<Link>` may omit `search`):
 *
 * - `/catalog/$blueprint`: `sort` `identifier` | `title` | `updatedAt` (default
 *   `identifier`), `order` `asc` | `desc` (default `asc`), `pageSize` 25 | 50 | 100
 *   (default 50), `cursor` a string of at most 512 characters (default absent).
 * - `/catalog/$blueprint/$entity`: `tab` `details` | `related` (default `details`).
 * - `/search`: `q` a string of at most 100 characters (default absent); a query of digits
 *   stays the same text.
 * - `/sign-in`: `returnTo`, always `safeReturnPath(raw)`, so `/` when absent or hostile.
 *
 * An over-long `q` or `cursor` is refused on its length first: the over-long value is
 * never trimmed, normalized or decoded, and never reaches the page.
 */
import {
  Link,
  RouterProvider,
  createMemoryHistory,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createI18n } from '../i18n/i18n.js';
import { PAGE_NAMES, createAppRouter, type AppPages, type PageName } from './router.js';

/** The scenario's entity identifier (Q36): `@`, `:` and `=` stay unencoded. */
const RESERVED_ENTITY = 'team@example.com:prod=1';

/** Every D12 route, as a path that matches it, and the page slot it renders. */
const ROUTES: readonly (readonly [PageName, string])[] = [
  ['signIn', '/sign-in'],
  ['forgotPassword', '/forgot-password'],
  ['resetPassword', '/reset-password'],
  ['acceptInvitation', '/accept-invitation'],
  ['changePassword', '/change-password'],
  ['mfaEnrol', '/mfa/enrol'],
  ['stepUpComplete', '/step-up/complete'],
  ['home', '/'],
  ['catalogTable', '/catalog/service'],
  ['entity', '/catalog/service/payments-api'],
  ['search', '/search'],
];

/**
 * A stand-in page: its test id names the slot, and it prints the path params and the
 * validated search exactly as a page receives them.
 */
function Probe({ name }: { name: PageName }): React.JSX.Element {
  // `unknown`: the hooks are typed `any` until the app registers its router type.
  const params: unknown = useParams({ strict: false });
  const search: unknown = useSearch({ strict: false });
  return (
    <div data-testid={`page-${name}`}>
      <pre data-testid="params">{JSON.stringify(params)}</pre>
      <pre data-testid="search">{JSON.stringify(search)}</pre>
    </div>
  );
}

const PROBES: AppPages = {
  signIn: () => <Probe name="signIn" />,
  forgotPassword: () => <Probe name="forgotPassword" />,
  resetPassword: () => <Probe name="resetPassword" />,
  acceptInvitation: () => <Probe name="acceptInvitation" />,
  changePassword: () => <Probe name="changePassword" />,
  mfaEnrol: () => <Probe name="mfaEnrol" />,
  stepUpComplete: () => <Probe name="stepUpComplete" />,
  home: () => <Probe name="home" />,
  catalogTable: () => <Probe name="catalogTable" />,
  entity: () => <Probe name="entity" />,
  search: () => <Probe name="search" />,
};

/** Renders the app router at `path` (memory history) inside the i18n provider. */
async function renderAt(path: string, pages: AppPages = PROBES) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, pages });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
  return { history, router };
}

/** Waits for the page slot `name`, checks it is the only page, and reads what it got. */
async function pageProps(
  name: PageName,
): Promise<{ params: Record<string, unknown>; search: Record<string, unknown> }> {
  await screen.findByTestId(`page-${name}`);
  expect(screen.getAllByTestId(/^page-/)).toHaveLength(1);
  const params = JSON.parse(screen.getByTestId('params').textContent) as Record<string, unknown>;
  const search = JSON.parse(screen.getByTestId('search').textContent) as Record<string, unknown>;
  return { params, search };
}

async function tableSearch(query: string): Promise<Record<string, unknown>> {
  await renderAt(`/catalog/service${query}`);
  return (await pageProps('catalogTable')).search;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the route tree', () => {
  it('has one page slot per D12 route', () => {
    expect([...PAGE_NAMES].sort()).toEqual(ROUTES.map(([name]) => name).sort());
  });

  it.each(ROUTES)('renders the %s page at %s', async (name, path) => {
    await renderAt(path);

    await pageProps(name);
  });

  it('passes the blueprint to the table page', async () => {
    await renderAt('/catalog/_user');

    const { params } = await pageProps('catalogTable');
    expect(params.blueprint).toBe('_user');
  });

  it('passes the blueprint and the entity to the entity page', async () => {
    await renderAt('/catalog/service/payments-api');

    const { params } = await pageProps('entity');
    expect(params).toMatchObject({ blueprint: 'service', entity: 'payments-api' });
  });
});

describe('An identifier with reserved characters opens', () => {
  function HomeWithEntityLink(): React.JSX.Element {
    return (
      <Link
        to="/catalog/$blueprint/$entity"
        params={{ blueprint: 'service', entity: RESERVED_ENTITY }}
      >
        Open the entity
      </Link>
    );
  }

  it('builds a link to team@example.com:prod=1 that holds no %', async () => {
    await renderAt('/', { ...PROBES, home: HomeWithEntityLink });

    const link = await screen.findByRole('link', { name: 'Open the entity' });
    const href = link.getAttribute('href');
    expect(href).toBe(`/catalog/service/${RESERVED_ENTITY}`);
    expect(href).not.toContain('%');
  });

  it('opens the entity page from that link with the identifier intact and no % in the path', async () => {
    const user = userEvent.setup();
    const { history } = await renderAt('/', { ...PROBES, home: HomeWithEntityLink });

    await user.click(await screen.findByRole('link', { name: 'Open the entity' }));

    const { params } = await pageProps('entity');
    expect(params).toMatchObject({ blueprint: 'service', entity: RESERVED_ENTITY });
    expect(history.location.pathname).toBe(`/catalog/service/${RESERVED_ENTITY}`);
    expect(history.location.pathname).not.toContain('%');
  });

  it('opens the entity page when the unencoded path is entered directly', async () => {
    const { history } = await renderAt(`/catalog/service/${RESERVED_ENTITY}`);

    const { params } = await pageProps('entity');
    expect(params).toMatchObject({ blueprint: 'service', entity: RESERVED_ENTITY });
    expect(history.location.pathname).not.toContain('%');
  });
});

describe('the table search params', () => {
  it('uses the defaults when no search param is given', async () => {
    const search = await tableSearch('');

    expect(search).toMatchObject({ sort: 'identifier', order: 'asc', pageSize: 50 });
    expect(search.cursor).toBeUndefined();
  });

  it('keeps valid values', async () => {
    const search = await tableSearch('?sort=title&order=desc&pageSize=25&cursor=eyJ2IjoyfQ');

    expect(search).toMatchObject({
      sort: 'title',
      order: 'desc',
      pageSize: 25,
      cursor: 'eyJ2IjoyfQ',
    });
  });

  it.each(['identifier', 'title', 'updatedAt'])('keeps the sort %s', async (sort) => {
    const search = await tableSearch(`?sort=${sort}`);

    expect(search.sort).toBe(sort);
  });

  it.each([25, 50, 100])('keeps the page size %i', async (pageSize) => {
    const search = await tableSearch(`?pageSize=${String(pageSize)}`);

    expect(search.pageSize).toBe(pageSize);
  });

  it.each([
    '?sort=bogus',
    '?sort=TITLE',
    '?sort=updated_at',
    '?sort=',
    '?sort=title&sort=updatedAt',
  ])('replaces the invalid sort in %s by identifier', async (query) => {
    const search = await tableSearch(query);

    expect(search.sort).toBe('identifier');
  });

  it.each(['?order=sideways', '?order=DESC', '?order=', '?order=1'])(
    'replaces the order outside asc and desc in %s by asc',
    async (query) => {
      const search = await tableSearch(query);

      expect(search.order).toBe('asc');
    },
  );

  it.each([
    '?pageSize=abc',
    '?pageSize=50abc',
    '?pageSize=',
    '?pageSize=0',
    '?pageSize=-25',
    '?pageSize=1.5',
    '?pageSize=30',
    '?pageSize=500',
    '?pageSize=1000',
  ])('replaces the non-numeric or out-of-range page size in %s by 50', async (query) => {
    const search = await tableSearch(query);

    expect(search.pageSize).toBe(50);
  });

  it('replaces only the invalid field and keeps the valid ones', async () => {
    const search = await tableSearch('?sort=bogus&order=desc&pageSize=100&cursor=abc');

    expect(search).toMatchObject({
      sort: 'identifier',
      order: 'desc',
      pageSize: 100,
      cursor: 'abc',
    });
  });

  it('keeps a cursor of 512 characters', async () => {
    const cursor = 'A'.repeat(512);

    const search = await tableSearch(`?cursor=${cursor}`);

    expect(search.cursor).toBe(cursor);
  });

  it('rejects a cursor of 513 characters before use: the page gets no cursor', async () => {
    const cursor = 'A'.repeat(513);

    const search = await tableSearch(`?cursor=${cursor}&sort=title`);

    expect(search.cursor).toBeUndefined();
    expect(search.sort).toBe('title');
    expect(screen.getByTestId('search').textContent).not.toContain(cursor);
  });

  it('checks the cursor length before decoding or parsing it', async () => {
    const cursor = 'A'.repeat(513);
    const atob = vi.spyOn(window, 'atob');
    const parse = vi.spyOn(JSON, 'parse');

    const search = await tableSearch(`?cursor=${cursor}`);

    expect(search.cursor).toBeUndefined();
    expect(atob.mock.calls.some(([text]) => text.includes(cursor))).toBe(false);
    expect(parse.mock.calls.some(([text]) => text.includes(cursor))).toBe(false);
  });
});

describe('the entity search params', () => {
  it('opens the details tab by default', async () => {
    await renderAt('/catalog/service/payments-api');

    expect((await pageProps('entity')).search.tab).toBe('details');
  });

  it.each(['details', 'related'])('keeps the tab %s', async (tab) => {
    await renderAt(`/catalog/service/payments-api?tab=${tab}`);

    expect((await pageProps('entity')).search.tab).toBe(tab);
  });

  it.each(['?tab=bogus', '?tab=Related', '?tab=', '?tab=1'])(
    'replaces the invalid tab in %s by details',
    async (query) => {
      await renderAt(`/catalog/service/payments-api${query}`);

      expect((await pageProps('entity')).search.tab).toBe('details');
    },
  );
});

describe('the search page search params', () => {
  async function searchQuery(query: string): Promise<unknown> {
    await renderAt(`/search${query}`);
    return (await pageProps('search')).search.q;
  }

  it('has no query by default', async () => {
    expect(await searchQuery('')).toBeUndefined();
  });

  it('keeps a query', async () => {
    expect(await searchQuery('?q=paym')).toBe('paym');
  });

  it('keeps a query of digits as the same text', async () => {
    expect(await searchQuery('?q=2024')).toBe('2024');
  });

  it('keeps a query of 100 characters', async () => {
    const q = 'a'.repeat(100);

    expect(await searchQuery(`?q=${q}`)).toBe(q);
  });

  it('rejects a query of 101 characters before use: the page gets no query', async () => {
    const q = 'a'.repeat(101);

    expect(await searchQuery(`?q=${q}`)).toBeUndefined();
    expect(screen.getByTestId('search').textContent).not.toContain(q);
  });

  it('checks the query length before trimming or normalizing it', async () => {
    const q = 'a'.repeat(101);
    const trim = vi.spyOn(String.prototype, 'trim');
    const normalize = vi.spyOn(String.prototype, 'normalize');

    expect(await searchQuery(`?q=${q}`)).toBeUndefined();
    expect(trim.mock.contexts.some((context) => String(context).includes(q))).toBe(false);
    expect(normalize.mock.contexts.some((context) => String(context).includes(q))).toBe(false);
  });
});

describe('the sign-in returnTo', () => {
  async function returnTo(query: string): Promise<unknown> {
    await renderAt(`/sign-in${query}`);
    return (await pageProps('signIn')).search.returnTo;
  }

  it('is / when absent', async () => {
    expect(await returnTo('')).toBe('/');
  });

  it.each(['/', '/catalog/service', `/catalog/service/${RESERVED_ENTITY}`, '/search?q=paym'])(
    'keeps the in-app path %s',
    async (path) => {
      expect(await returnTo(`?returnTo=${encodeURIComponent(path)}`)).toBe(path);
    },
  );

  it.each([
    '//evil.example/x',
    'https://evil.example/',
    'javascript:alert(1)',
    '/\\evil.example',
    '/forgot-password',
    '/catalog/service/%2e%2e',
  ])('replaces the hostile return path %s by /', async (path) => {
    expect(await returnTo(`?returnTo=${encodeURIComponent(path)}`)).toBe('/');
  });
});

describe('the not-found page', () => {
  it.each([
    '/no-such-page',
    '/catalog',
    '/catalog/service/payments-api/extra',
    '/mfa',
    '/step-up',
    '/sign-in/extra',
  ])('shows the not-found page and no other page at %s', async (path) => {
    await renderAt(path);

    expect(
      await screen.findByRole('heading', { level: 1, name: /not found/i }),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^page-/)).toHaveLength(0);
  });
});
