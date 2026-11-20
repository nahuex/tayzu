/**
 * The session query refetches on window focus (follow-up of task 5.9, design D4, D8,
 * D12 and Q68, Q69; spec "The shell knows the caller's session and enforces its gates").
 *
 * D4 (TanStack Query settings): "No retry on a 4xx, at most one retry on a network error
 * or 5xx, `refetchOnWindowFocus` on for the session query only, and the cache is cleared
 * on sign-out and on any `unauthenticated` answer."
 * D12 (Session gate): "A `401` sends a protected route to `/sign-in?returnTo=<path>`; a
 * gate other than `none` sends every route except its own page and sign-out to that page
 * (`/change-password` or `/mfa/enrol`, or the expired-password page)."
 * Q69: "Any `unauthenticated` answer of a query or mutation clears the cache and lands on
 * `/sign-in?returnTo=<path>` (D4, D12). [...] A `401` on the session read itself counts
 * as unauthenticated too."
 * D8: a gated session gets the catch-all's uniform `401` from every catalog route, and
 * `GET /v1/me` reports the gate.
 * Spec: "The web app MUST send a signed-out visitor of a protected page to the sign-in
 * page, and a gated session to its gate's page for every route but sign-out."
 *
 * Expected behavior (the app as `main.tsx` wires it, with `createQueryClient()`):
 *
 * - While a signed-in page is shown, the window regaining focus reads `GET /v1/me` again.
 * - No other query refetches on focus: neither the sidebar's `blueprints.list` nor a
 *   page's own query.
 * - When that refetch answers the uniform `401`, the cache is cleared and the app lands
 *   on `/sign-in?returnTo=<current path>`.
 * - When that refetch reports a gate other than `none`, the app moves to the gate's page
 *   (`/change-password`, rendering the expired-password page for `password_expired`, or
 *   `/mfa/enrol`) and no longer renders the shell.
 *
 * Focus is driven through TanStack Query's `focusManager`, which is what a browser
 * `visibilitychange` feeds. The network is a fake `fetch` behind the real API and auth
 * clients (D16).
 */
import {
  focusManager,
  QueryClientProvider,
  useQuery,
  type QueryClient,
} from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthClient } from '../api/auth-client.js';
import { createApiClient, type ApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

import { SESSION_QUERY_KEY, createAppRouter, type PageName } from './router.js';

type Gate = 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: 'owner' | 'admin' | 'member';
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: Gate;
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

const BLUEPRINTS = [
  {
    identifier: 'service',
    title: { en: 'Service', es: 'Servicio' },
    schema: { properties: {}, required: [] },
    relations: {},
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-01T10:00:00.000Z',
    updatedBy: ACTOR,
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The uniform 401 of D8, as the `/v1` catch-all and `GET /v1/me` send it. */
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
}

/**
 * A fake `fetch` playing the API. `GET /v1/me` reports the current session; the catalog
 * routes answer while the session has no gate, and the uniform 401 once it is gone or
 * gated (D8).
 */
function createFakeServer(initial: MeBody) {
  let me: MeBody | undefined = initial;
  const calls: RecordedRequest[] = [];

  const fetch = (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({ method: request.method, pathname });

    if (!pathname.startsWith('/v1/')) {
      return Promise.resolve(jsonResponse(404, { code: 'NOT_FOUND', status: 404 }));
    }
    if (me === undefined) return Promise.resolve(contextRequired());
    if (request.method === 'GET' && pathname === '/v1/me') {
      return Promise.resolve(jsonResponse(200, me));
    }
    if (me.gate !== 'none') return Promise.resolve(contextRequired());
    if (request.method === 'GET' && pathname === '/v1/blueprints') {
      return Promise.resolve(jsonResponse(200, { items: BLUEPRINTS }));
    }
    if (request.method === 'GET' && pathname.endsWith('/entities')) {
      return Promise.resolve(jsonResponse(200, { items: [] }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const callsTo = (pathname: string): RecordedRequest[] =>
    calls.filter((call) => call.method === 'GET' && call.pathname === pathname);

  return {
    fetch,
    calls,
    meCalls: () => callsTo('/v1/me'),
    blueprintListCalls: () => callsTo('/v1/blueprints'),
    entityListCalls: () => callsTo('/v1/blueprints/service/entities'),
    /** The session ends on the server: every later `/v1` call answers 401. */
    expireSession() {
      me = undefined;
    },
    /** A gate now applies to the session, for example after an admin reset. */
    setGate(gate: Gate) {
      me = meWith({ gate });
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

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

/** The table page reading `entities.list` when it mounts, as the real one will. */
function tablePageReading(apiClient: ApiClient): ComponentType {
  return function TableProbe(): React.JSX.Element {
    const entities = useQuery({
      queryKey: ['probe', 'entities', 'service'],
      queryFn: () => apiClient.entities.list({ blueprint: 'service' }),
    });
    return (
      <div data-testid="page-catalogTable">{entities.isSuccess ? 'Entities loaded' : null}</div>
    );
  };
}

interface App {
  readonly history: RouterHistory;
  readonly queryClient: QueryClient;
}

/** Renders the whole app as `main.tsx` wires it, at `path`, over the fake server. */
async function renderApp(path: string, server: FakeServer): Promise<App> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const themeStore = createThemeStore();

  const router = createAppRouter({
    history,
    pages: { ...PROBES, catalogTable: tablePageReading(apiClient) },
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
  return { history, queryClient };
}

/** Waits for `/catalog/service` to be fully shown: the sidebar and the page's own data. */
async function signedInTable(): Promise<void> {
  const nav = await screen.findByRole('navigation', { name: 'Catalog' });
  await within(nav).findAllByRole('link');
  await screen.findByText('Entities loaded');
}

/** Lets any pending request or render happen before counting calls. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** The user leaves the tab and comes back to it. */
function blurAndFocusWindow(): void {
  act(() => {
    focusManager.setFocused(false);
  });
  act(() => {
    focusManager.setFocused(true);
  });
}

/** Every query of the cache that still holds data. */
function cachedData(queryClient: QueryClient): readonly unknown[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.queryKey);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  // Hand focus back to the browser's own visibility state.
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
});

describe('the session query refetches on window focus (D4)', () => {
  it('reads GET /v1/me again when the window regains focus on a signed-in page', async () => {
    const server = createFakeServer(meWith());
    const { history } = await renderApp('/catalog/service', server);
    await signedInTable();
    await settle();
    const before = server.meCalls().length;
    expect(before).toBeGreaterThan(0);

    blurAndFocusWindow();

    await waitFor(() => {
      expect(server.meCalls().length).toBeGreaterThan(before);
    });
    await settle();
    expect(history.location.pathname).toBe('/catalog/service');
    expect(screen.getByTestId('page-catalogTable')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Catalog' })).toBeInTheDocument();
  });

  it('refetches no other query on focus: blueprints.list and the page query are not called again', async () => {
    const server = createFakeServer(meWith());
    await renderApp('/catalog/service', server);
    await signedInTable();
    await settle();
    const meBefore = server.meCalls().length;
    expect(server.blueprintListCalls()).toHaveLength(1);
    expect(server.entityListCalls()).toHaveLength(1);

    blurAndFocusWindow();

    await waitFor(() => {
      expect(server.meCalls().length).toBeGreaterThan(meBefore);
    });
    await settle();
    expect(server.blueprintListCalls()).toHaveLength(1);
    expect(server.entityListCalls()).toHaveLength(1);
  });

  it('clears the cache and lands on /sign-in?returnTo=<path> when the focus refetch answers 401', async () => {
    const server = createFakeServer(meWith());
    const { history, queryClient } = await renderApp('/catalog/service', server);
    await signedInTable();
    await settle();
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();
    const callsBefore = server.calls.length;

    server.expireSession();
    blurAndFocusWindow();

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    expect(new URLSearchParams(history.location.search).get('returnTo')).toBe('/catalog/service');
    // The session read is what found the session gone; nothing else was asked.
    const callsAfter = server.calls.slice(callsBefore);
    expect(callsAfter.length).toBeGreaterThan(0);
    expect(callsAfter.every((call) => call.method === 'GET' && call.pathname === '/v1/me')).toBe(
      true,
    );
    expect(cachedData(queryClient)).toEqual([]);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
    expect(screen.queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
  });

  it.each([
    ['password_change_required', '/change-password', 'changePassword'],
    ['password_expired', '/change-password', 'passwordExpired'],
    ['mfa_enrolment_required', '/mfa/enrol', 'mfaEnrol'],
  ] as const)(
    'moves to the gate page when the focus refetch reports %s (%s)',
    async (gate, path, name) => {
      const server = createFakeServer(meWith());
      const { history } = await renderApp('/catalog/service', server);
      await signedInTable();
      await settle();
      const meBefore = server.meCalls().length;

      server.setGate(gate);
      blurAndFocusWindow();

      await screen.findByTestId(`page-${name}`);
      await waitFor(() => {
        expect(history.location.pathname).toBe(path);
      });
      expect(server.meCalls().length).toBeGreaterThan(meBefore);
      expect(screen.queryByTestId('page-catalogTable')).not.toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Catalog' })).not.toBeInTheDocument();
    },
  );
});
