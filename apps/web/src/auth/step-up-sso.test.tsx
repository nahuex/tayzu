/**
 * The Visma Connect step-up and its completion page (task 6.6, design D11, D12, D14, D15,
 * D16 and Q14, Q56, Q65, Q68, Q72, Q75; spec "High-risk operations prompt for step-up",
 * scenarios "A Visma Connect user re-authorizes" and "No re-authorization is available
 * for a Visma Connect session"; spec "The UI never carries the tenant, the cookie or
 * tenant free text outside the page").
 *
 * D11 (Step-up dialog): "a Visma Connect session with a `reauthorizationUrl`: a "Continue
 * with Visma Connect" button; on click the app stores only the current in-app path in
 * `sessionStorage` (key `tayzu.stepUp.returnTo`) and navigates to the URL. The callback
 * then redirects to `/step-up/complete` (below), which reads and deletes the key,
 * validates the path (D15) and returns there with a "you are back, repeat the action"
 * notice; it never says "verified", because the page cannot know whether the next
 * request will pass. The action is never repeated automatically (Q14); a Visma Connect
 * session without a URL [...]: a "try again in a few minutes" message, with no factor
 * field."
 * D11 (The re-authorization redirect): the callback answers `303` to `/step-up/complete`,
 * `/step-up/complete?result=failed` or `/step-up/complete?result=rate_limited` (keeping
 * `Retry-After`). "The page shows a retry-later message for `rate_limited`." A browser
 * follows a `303` without handing its headers to script, so the page never sees
 * `Retry-After`: its message names no number of seconds.
 * D15: "A `returnTo` value or the stored step-up path is accepted only if it starts with
 * a single `/`, contains no `//`, `\` or control character, has no scheme or host when
 * resolved against the current origin, and matches a route of the route tree; anything
 * else becomes `/`." Storage inventory: "`sessionStorage` `tayzu.stepUp.returnTo` (an
 * in-app path, deleted when read). No token, [...] query, or tenant data is ever stored."
 * Q65: `safeReturnPath` accepts a query, "so the caller (the step-up return, D14) must not
 * store `/search?q=`". Q72: a server URL is followed only when it parses, with no base, as
 * an absolute `https:` URL, through `navigateToExternal`, once, after the click. Q68: the
 * step-up complete page is public: it never reads `GET /v1/me`.
 * Spec: "For a Visma Connect session with a re-authorization URL in the answer, the prompt
 * MUST offer a Visma Connect round trip that starts only on the user's click and stores at
 * most an in-app return path; [...] and the user MUST repeat the action. For a Visma
 * Connect session without a URL, the prompt MUST ask the user to try again later and MUST
 * NOT offer a code or password field." "A return path, from a query parameter or from
 * storage, MUST be accepted only if it is a path of the app on the same origin; any other
 * value MUST be replaced by `/`."
 * Scenario "A Visma Connect user re-authorizes": GIVEN a user signed in through Visma
 * Connect, WHEN they delete an entity, choose "Continue with Visma Connect" and complete
 * the provider's step-up, THEN they return to the entity page with a notice to repeat the
 * action, and repeating it succeeds.
 * Scenario "No re-authorization is available for a Visma Connect session": GIVEN a user
 * signed in through Visma Connect whose step-up answer carries no re-authorization URL,
 * WHEN the prompt opens, THEN it asks the user to try again later and offers no code or
 * password field.
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/lib/navigate-away.ts (task 6.2, unchanged): mocked here, so the URL check
 * // (`isAbsoluteHttpsUrl` of src/lib/external-url.ts) happens before the call.
 * export function navigateToExternal(url: string): void;
 * ```
 *
 * The dialog (`StepUpDialog`, `signInMethod: 'visma-connect'`; texts from `auth`):
 *
 * - With a `reauthorizationUrl` that is an absolute `https:` URL: a button "Continue with
 *   Visma Connect" (`auth:stepUp.vismaConnect`). Nothing is stored and nothing navigates
 *   until it is clicked. On click, in this order: the current in-app location of the
 *   router (path and query, never `window.location`, never a fragment) passed through
 *   `safeReturnPath`, with the query dropped on `/search` (so `/search?q=...` stores
 *   `/search`), is written to `sessionStorage` under `tayzu.stepUp.returnTo`, the only
 *   key written; then `navigateToExternal(reauthorizationUrl)` is called once. A storage
 *   failure is caught and the navigation still happens. The click never settles the
 *   request as `verified`, so the original call is not retried.
 * - Without a `reauthorizationUrl`, or with one that is not an absolute `https:` URL
 *   (treated as absent, fail closed): the message "Visma Connect cannot verify you right
 *   now. Try again in a few minutes." (`auth:stepUp.ssoUnavailable`), no button to Visma
 *   Connect, no field, no storage write and no navigation.
 * - Either way the footer's "Cancel" (`auth:stepUp.cancel`) settles `cancelled`.
 *
 * The page `/step-up/complete` (the router's default `stepUpComplete` slot, public,
 * outside the shell; its search reads `result` as `'failed' | 'rate_limited'`, anything
 * else absent):
 *
 * - On mount it reads `tayzu.stepUp.returnTo` once, deletes it, and passes it through
 *   `safeReturnPath` (a missing key or a throwing storage gives `/`).
 * - No `result`: it returns to that path at once with `history.replace` semantics (no
 *   new history entry) and the destination, inside the shell, shows the notice "You are
 *   back. Repeat the action to continue." in a `role="status"` region. The transport of
 *   the notice (for example a flag of the session-bound step-up store, or the history
 *   entry's state) is the implementer's choice; it never touches storage or the URL.
 *   Suggested key: `common:stepUpNotice.returned` (the shell loads `common`).
 * - `?result=failed`: it stays, with an `alert` "Visma Connect could not confirm your
 *   identity. Repeat the action to try again." (`auth:stepUpComplete.failed`).
 * - `?result=rate_limited`: it stays, with an `alert` "Too many attempts. Try again in a
 *   few minutes." (`auth:stepUpComplete.rateLimited`).
 * - Both failure pages offer a link "Go back" (`auth:stepUpComplete.back`) to the
 *   validated stored path, and never show the notice.
 * - Nowhere does any of this say "verified", and nothing repeats the original action:
 *   the page and the return send no mutating request.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16).
 */
import { QueryClientProvider, focusManager, useMutation } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient, type ApiClient } from '../api/client.js';
import { toApiError } from '../api/errors.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { navigateToExternal } from '../lib/navigate-away.js';
import { resetSessionStores } from '../state/session-stores.js';
import { useStepUpStore, withStepUp } from '../state/step-up.js';
import { createThemeStore } from '../state/theme.js';

vi.mock('../lib/navigate-away.js', () => ({ navigateToExternal: vi.fn() }));

const RETURN_TO_KEY = 'tayzu.stepUp.returnTo';

const DIALOG_NAME = 'Verify your identity';
const CONTINUE = 'Continue with Visma Connect';
const UNAVAILABLE = 'Visma Connect cannot verify you right now. Try again in a few minutes.';
const NOTICE = 'You are back. Repeat the action to continue.';
const FAILED = 'Visma Connect could not confirm your identity. Repeat the action to try again.';
const RATE_LIMITED = 'Too many attempts. Try again in a few minutes.';
const BACK = 'Go back';

const REAUTHORIZATION_URL =
  'https://connect.visma.com/connect/authorize?client_id=tayzu&state=s1-9f2c&prompt=login&max_age=0';

const ENTITY_PATH = '/catalog/service/payments-api';
const DELETE_PATH = '/v1/blueprints/service/entities/payments-api';
const SEARCH_QUERY = 'payments-confidential';

const ACTOR = { type: 'user', id: 'u_lena' } as const;

const ME = {
  user: { id: 'u_lena', name: 'Lena Lopez', email: 'lena@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'visma-connect',
  mfa: { enrolled: false },
  gate: 'none',
};

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

/** An oRPC error body, as `ORPCError#toJSON()` writes it. */
function orpcError(code: string, status: number, data?: unknown): Response {
  return jsonResponse(status, {
    defined: false,
    code,
    status,
    message: `server-text: ${code}`,
    ...(data === undefined ? {} : { data }),
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
}

interface FakeServerOptions {
  /** Defaults to a signed-in Visma Connect session. */
  readonly signedIn?: boolean;
  /** The step-up answer carries this re-authorization URL. */
  readonly reauthorizationUrl?: string;
  /** The Visma Connect re-authorization completed: the next delete is fresh. */
  readonly reauthorized?: boolean;
}

/**
 * A fake `fetch` playing the API and Better Auth for one Visma Connect user. A local
 * factor never satisfies the session; only a completed re-authorization does.
 */
function createFakeServer(options: FakeServerOptions = {}) {
  const signedIn = options.signedIn ?? true;
  const calls: RecordedRequest[] = [];

  function deleteEntity(): Response {
    if (options.reauthorized === true) return new Response(null, { status: 204 });
    return orpcError(
      'AUTH_STEP_UP_REQUIRED',
      403,
      options.reauthorizationUrl === undefined
        ? undefined
        : { reauthorizationUrl: options.reauthorizationUrl },
    );
  }

  function handle(request: Request): Response {
    const url = new URL(request.url);
    calls.push({ method: request.method, url });
    const { pathname } = url;

    if (pathname.startsWith('/api/auth/')) {
      return jsonResponse(signedIn ? 404 : 401, {
        code: signedIn ? 'NOT_FOUND' : 'UNAUTHORIZED',
        message: 'server-text: refused',
      });
    }
    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (!signedIn) return orpcError('CATALOG_CONTEXT_REQUIRED', 401);
    if (request.method === 'GET' && pathname === '/v1/me') return jsonResponse(200, ME);
    if (request.method === 'GET' && pathname === '/v1/blueprints') {
      return jsonResponse(200, { items: BLUEPRINTS });
    }
    if (request.method === 'DELETE' && pathname === DELETE_PATH) return deleteEntity();
    if (request.method === 'GET' && pathname.endsWith('/entities')) {
      return jsonResponse(200, { items: [] });
    }
    return new Response(null, { status: 204 });
  }

  const callsTo = (method: string, path: string) =>
    calls.filter((call) => call.method === method && call.url.pathname === path);

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      Promise.resolve(handle(new Request(input, init))),
    calls,
    callsTo,
    deleteCalls: () => callsTo('DELETE', DELETE_PATH),
    /** Every request but a `GET`: a repeated action would show here. */
    mutatingCalls: () => calls.filter((call) => call.method !== 'GET'),
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/**
 * A signed-in page deleting the entity through `withStepUp`, as the entity page will
 * (task 8.4). Every signed-in slot gets one, so the step-up can start from any route.
 */
function deletingPage(name: PageName, apiClient: ApiClient): ComponentType {
  return function DeletingProbe(): React.JSX.Element {
    const remove = useMutation({
      mutationFn: () =>
        withStepUp(() =>
          apiClient.entities.delete({
            params: { blueprint: 'service', entity: 'payments-api' },
            query: {},
          }),
        ),
    });
    return (
      <div data-testid={`page-${name}`}>
        <button
          type="button"
          onClick={() => {
            remove.mutate();
          }}
        >
          Delete
        </button>
        {remove.isSuccess && <p>Deleted</p>}
        {remove.isError && <p>{`Failed: ${toApiError(remove.error).kind}`}</p>}
      </div>
    );
  };
}

/** Renders the whole app (session gate, shell and providers, as `main.tsx`) at `path`. */
async function renderApp(path: string, server: FakeServer): Promise<RouterHistory> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const themeStore = createThemeStore();
  const router = createAppRouter({
    history,
    // `stepUpComplete` keeps the router's default: the real page under test.
    pages: {
      signIn: probe('signIn'),
      home: deletingPage('home', apiClient),
      catalogTable: deletingPage('catalogTable', apiClient),
      entity: deletingPage('entity', apiClient),
      search: deletingPage('search', apiClient),
    },
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
  return history;
}

type User = ReturnType<typeof userEvent.setup>;

/** Lets any pending request, render or navigation happen before counting. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

function locationOf(history: RouterHistory): string {
  return `${history.location.pathname}${history.location.search}`;
}

/** Renders the app at `path` (a signed-in page) and opens the step-up dialog from it. */
async function openStepUp(
  user: User,
  path: string,
  page: PageName,
  server: FakeServer,
): Promise<{ history: RouterHistory; dialog: HTMLElement }> {
  const history = await renderApp(path, server);
  await screen.findByTestId(`page-${page}`);
  await screen.findByRole('navigation', { name: 'Catalog' });
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
  return { history, dialog };
}

/** Every `[key, value]` of a storage. */
function entriesOf(storage: Storage): [string, string | null][] {
  const entries: [string, string | null][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) entries.push([key, storage.getItem(key)]);
  }
  return entries;
}

/** The dialog offers no local factor at all. */
function expectNoFactorField(dialog: HTMLElement): void {
  expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
  expect(dialog.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0);
  expect(within(dialog).queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
}

/** Storage that is disabled: reading `window.sessionStorage` throws, as in a browser. */
function disableSessionStorage(): void {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new DOMException('server-text: storage disabled', 'SecurityError');
  });
}

/** Waits for the return to `path` from the completion page, with the notice. */
async function expectReturnedTo(
  history: RouterHistory,
  path: string,
  page: PageName,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(locationOf(history)).toBe(path);
  });
  await screen.findByTestId(`page-${page}`);
  return screen.findByText(NOTICE);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(navigateToExternal).mockReset();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  focusManager.setFocused(undefined);
  // The store is module state: a test that left a request open must not leak it.
  resetSessionStores();
  vi.restoreAllMocks();
});

describe('A Visma Connect user re-authorizes', () => {
  it('stores the entity path on click, returns there with the notice, and repeating the action succeeds', async () => {
    const user = userEvent.setup();
    const before = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', before);

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));
    expect(navigateToExternal).toHaveBeenCalledTimes(1);
    expect(navigateToExternal).toHaveBeenCalledWith(REAUTHORIZATION_URL);
    expect(entriesOf(window.sessionStorage)).toEqual([[RETURN_TO_KEY, ENTITY_PATH]]);

    // The provider's round trip reloads the app at the callback's fixed redirect target.
    cleanup();
    resetSessionStores();
    const after = createFakeServer({ reauthorized: true });
    const history = await renderApp('/step-up/complete', after);

    await expectReturnedTo(history, ENTITY_PATH, 'entity');
    await settle();
    expect(after.mutatingCalls()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Deleted');
    expect(after.deleteCalls()).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the Visma Connect step-up dialog with a reauthorizationUrl', () => {
  it('offers "Continue with Visma Connect" and stores nothing and navigates nowhere before the click', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { history, dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);
    await settle();

    expect(within(dialog).getByRole('button', { name: CONTINUE })).toBeInTheDocument();
    expect(within(dialog).queryByText(UNAVAILABLE)).not.toBeInTheDocument();
    expectNoFactorField(dialog);
    expect(navigateToExternal).not.toHaveBeenCalled();
    expect(entriesOf(window.sessionStorage)).toEqual([]);
    expect(locationOf(history)).toBe(ENTITY_PATH);
    for (const { url } of server.calls) expect(url.origin).toBe(window.location.origin);
    expect(server.deleteCalls()).toHaveLength(1);
  });

  it('on click stores only the in-app path under tayzu.stepUp.returnTo, then navigates to the URL', async () => {
    const user = userEvent.setup();
    let storedAtNavigation: [string, string | null][] | undefined;
    vi.mocked(navigateToExternal).mockImplementation(() => {
      storedAtNavigation = entriesOf(window.sessionStorage);
    });
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { history, dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));
    await settle();

    expect(navigateToExternal).toHaveBeenCalledTimes(1);
    expect(navigateToExternal).toHaveBeenCalledWith(REAUTHORIZATION_URL);
    // The path is stored before the app leaves.
    expect(storedAtNavigation).toEqual([[RETURN_TO_KEY, ENTITY_PATH]]);
    // Exactly one key, whose value is a path: never the URL, its state or a token.
    const stored = entriesOf(window.sessionStorage);
    expect(stored).toEqual([[RETURN_TO_KEY, ENTITY_PATH]]);
    const value = stored[0]?.[1] ?? '';
    expect(value.startsWith('/')).toBe(true);
    expect(value.startsWith('//')).toBe(false);
    for (const fragment of ['https:', 'connect.visma.com', 'state=', 's1-9f2c', 'token']) {
      expect(value).not.toContain(fragment);
    }
    for (const [key] of entriesOf(window.localStorage)) {
      expect(['tayzu.theme', 'tayzu.locale']).toContain(key);
    }
    // The app's router does not move, and the page never fetches the URL itself.
    expect(locationOf(history)).toBe(ENTITY_PATH);
    for (const { url } of server.calls) expect(url.origin).toBe(window.location.origin);
  });

  it('does not repeat the action on click: the original call is not retried', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));
    await settle();

    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.mutatingCalls()).toHaveLength(1);
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('keeps the table query in the stored path', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { dialog } = await openStepUp(
      user,
      '/catalog/service?sort=title',
      'catalogTable',
      server,
    );

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));

    expect(entriesOf(window.sessionStorage)).toEqual([
      [RETURN_TO_KEY, '/catalog/service?sort=title'],
    ]);
    expect(navigateToExternal).toHaveBeenCalledTimes(1);
  });

  it('never stores the search query: from /search?q= it stores /search', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { dialog } = await openStepUp(user, `/search?q=${SEARCH_QUERY}`, 'search', server);

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));

    expect(entriesOf(window.sessionStorage)).toEqual([[RETURN_TO_KEY, '/search']]);
    for (const storage of [window.sessionStorage, window.localStorage]) {
      expect(JSON.stringify(entriesOf(storage))).not.toContain(SEARCH_QUERY);
    }
    expect(navigateToExternal).toHaveBeenCalledTimes(1);
  });

  it('still navigates when sessionStorage throws', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ reauthorizationUrl: REAUTHORIZATION_URL });
    const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);
    disableSessionStorage();

    await user.click(within(dialog).getByRole('button', { name: CONTINUE }));
    await settle();

    expect(navigateToExternal).toHaveBeenCalledTimes(1);
    expect(navigateToExternal).toHaveBeenCalledWith(REAUTHORIZATION_URL);
    expect(screen.getByTestId('page-entity')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('server-text');
  });

  it.each([
    ['http:', 'http://connect.visma.com/connect/authorize?state=s1-9f2c'],
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//connect.visma.com/connect/authorize?state=s1-9f2c'],
    ['relative', '/connect/authorize?state=s1-9f2c'],
    ['unparseable', 'https://'],
  ])(
    'treats a %s reauthorizationUrl as absent: no button, the try-again message, no storage, no navigation',
    async (_case, reauthorizationUrl) => {
      const user = userEvent.setup();
      const server = createFakeServer({ reauthorizationUrl });
      const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);
      await settle();

      expect(within(dialog).queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
      expect(within(dialog).getByText(UNAVAILABLE)).toBeInTheDocument();
      expectNoFactorField(dialog);
      expect(navigateToExternal).not.toHaveBeenCalled();
      expect(entriesOf(window.sessionStorage)).toEqual([]);
    },
  );
});

describe('No re-authorization is available for a Visma Connect session', () => {
  it('asks the user to try again later and offers no code or password field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);
    await settle();

    expect(within(dialog).getByText(UNAVAILABLE)).toBeInTheDocument();
    expectNoFactorField(dialog);
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(within(dialog).queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Use a backup code' }),
    ).not.toBeInTheDocument();
    expect(server.calls.filter((call) => call.url.pathname.startsWith('/api/auth/'))).toEqual([]);
    expect(navigateToExternal).not.toHaveBeenCalled();
    expect(entriesOf(window.sessionStorage)).toEqual([]);
    expect(server.deleteCalls()).toHaveLength(1);
  });

  it('closes with Cancel as cancelled, failing the call with no retry', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { dialog } = await openStepUp(user, ENTITY_PATH, 'entity', server);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await screen.findByText('Failed: step_up_required');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(useStepUpStore.getState().request).toBeNull();
  });
});

describe('/step-up/complete returns to the stored path', () => {
  it.each([
    ['the entity page', ENTITY_PATH, 'entity'],
    ['the table with its query', '/catalog/service?sort=title', 'catalogTable'],
    ['the search page', '/search', 'search'],
    ['home', '/', 'home'],
  ] as const)(
    'returns to %s with the notice, reading the key once and deleting it',
    async (_case, path, page) => {
      window.sessionStorage.setItem(RETURN_TO_KEY, path);
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const server = createFakeServer();
      const history = await renderApp('/step-up/complete', server);

      await expectReturnedTo(history, path, page);
      await settle();

      expect(getItem.mock.calls.filter(([key]) => key === RETURN_TO_KEY)).toHaveLength(1);
      expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
      expect(entriesOf(window.sessionStorage)).toEqual([]);
      // The return replaces the completion page: Back never lands on it again.
      expect(history.length).toBe(1);
    },
  );
});

describe('/step-up/complete: an invalid stored path becomes /', () => {
  it.each([
    ['a protocol-relative URL', '//evil.example/catalog'],
    ['an absolute https: URL', 'https://evil.example/catalog/service'],
    ['a javascript: URL', 'javascript:alert(document.domain)'],
    ['a backslash path', '/\\evil.example'],
    ['a relative path', 'catalog/service'],
    ['a fragment', `${ENTITY_PATH}#x`],
    ['an encoded path', '/catalog/%2F%2Fevil.example'],
    ['a dot segment', '/catalog/../sign-in'],
    ['the sign-in page', '/sign-in'],
    ['the completion page itself', '/step-up/complete'],
    ['an unknown route', '/admin'],
    ['an empty value', ''],
  ])('returns to / with the notice for %s', async (_case, stored) => {
    window.sessionStorage.setItem(RETURN_TO_KEY, stored);
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete', server);

    await expectReturnedTo(history, '/', 'home');
    expect(entriesOf(window.sessionStorage)).toEqual([]);
  });

  it('returns to / with the notice when no path is stored', async () => {
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete', server);

    await expectReturnedTo(history, '/', 'home');
  });

  it('returns to / with the notice when sessionStorage throws', async () => {
    window.sessionStorage.setItem(RETURN_TO_KEY, ENTITY_PATH);
    disableSessionStorage();
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete', server);

    await expectReturnedTo(history, '/', 'home');
    expect(document.body.textContent).not.toContain('server-text');
  });
});

describe('/step-up/complete: the notice wording', () => {
  it('says "you are back, repeat the action" in a status region, and never "verified"', async () => {
    window.sessionStorage.setItem(RETURN_TO_KEY, ENTITY_PATH);
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete', server);

    const notice = await expectReturnedTo(history, ENTITY_PATH, 'entity');
    await settle();

    expect(notice).toHaveTextContent(NOTICE);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/verified/i);
    expect(document.body.textContent).not.toMatch(/success/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('/step-up/complete?result=failed', () => {
  it('shows the failure message, stays, links back to the stored path and deletes the key', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(RETURN_TO_KEY, ENTITY_PATH);
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete?result=failed', server);

    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
    await settle();
    expect(locationOf(history)).toBe('/step-up/complete?result=failed');
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/verified/i);
    expect(entriesOf(window.sessionStorage)).toEqual([]);
    const back = screen.getByRole('link', { name: BACK });
    expect(back).toHaveAttribute('href', ENTITY_PATH);
    expect(server.mutatingCalls()).toEqual([]);

    await user.click(back);
    await waitFor(() => {
      expect(locationOf(history)).toBe(ENTITY_PATH);
    });
    await screen.findByTestId('page-entity');
    await settle();
    expect(server.mutatingCalls()).toEqual([]);
  });

  it('links back to / when the stored path is invalid', async () => {
    window.sessionStorage.setItem(RETURN_TO_KEY, 'https://evil.example/');
    const server = createFakeServer();
    await renderApp('/step-up/complete?result=failed', server);

    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
    expect(screen.getByRole('link', { name: BACK })).toHaveAttribute('href', '/');
    expect(entriesOf(window.sessionStorage)).toEqual([]);
  });
});

describe('/step-up/complete?result=rate_limited', () => {
  it('shows the retry-later message with no number of seconds, stays and deletes the key', async () => {
    window.sessionStorage.setItem(RETURN_TO_KEY, '//evil.example/catalog');
    const server = createFakeServer();
    const history = await renderApp('/step-up/complete?result=rate_limited', server);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(RATE_LIMITED);
    // `Retry-After` never reaches script through a followed redirect.
    expect(alert.textContent).not.toMatch(/\d/);
    await settle();
    expect(locationOf(history)).toBe('/step-up/complete?result=rate_limited');
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: BACK })).toHaveAttribute('href', '/');
    expect(entriesOf(window.sessionStorage)).toEqual([]);
    expect(server.mutatingCalls()).toEqual([]);
  });
});

describe('/step-up/complete is public (Q68)', () => {
  it.each([
    ['failed', FAILED],
    ['rate_limited', RATE_LIMITED],
  ])('renders ?result=%s with no session and never reads GET /v1/me', async (result, message) => {
    window.sessionStorage.setItem(RETURN_TO_KEY, ENTITY_PATH);
    const server = createFakeServer({ signedIn: false });
    const history = await renderApp(`/step-up/complete?result=${result}`, server);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await settle();
    expect(locationOf(history)).toBe(`/step-up/complete?result=${result}`);
    expect(server.callsTo('GET', '/v1/me')).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(screen.queryByTestId('page-signIn')).not.toBeInTheDocument();
  });
});

describe('/step-up/complete never repeats the action automatically', () => {
  it.each([
    ['after a successful re-authorization', '/step-up/complete'],
    ['after a failed one', '/step-up/complete?result=failed'],
    ['after a rate-limited one', '/step-up/complete?result=rate_limited'],
  ])('sends no mutating request %s', async (_case, path) => {
    window.sessionStorage.setItem(RETURN_TO_KEY, ENTITY_PATH);
    const server = createFakeServer({ reauthorized: true });
    await renderApp(path, server);

    await screen.findByText(/You are back|could not confirm|Too many attempts/);
    await settle();
    await settle();

    expect(server.mutatingCalls()).toEqual([]);
    expect(server.deleteCalls()).toEqual([]);
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useStepUpStore.getState().request).toBeNull();
  });
});
