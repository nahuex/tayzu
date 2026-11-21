/**
 * Visma Connect sign-in (task 6.2, design D11, D15, D16 and Q64, Q71; spec "Users can
 * sign in locally or with Visma Connect", scenario "Visma Connect sign-in").
 *
 * D11 (`/sign-in`): "A "Sign in with Visma Connect" button posts to
 * `/api/auth/sign-in/social` with `provider: "visma-connect"`, `callbackURL: "/"` and
 * `errorCallbackURL: "/sign-in?error=sso"` and, only on the user's click, navigates to
 * the returned URL if it is an absolute `https:` URL; `?error=sso` shows one generic
 * message."
 * Spec: "Visma Connect sign-in MUST start only on the user's click and MUST navigate only
 * to an absolute `https:` URL returned by the server. A single-sign-on failure MUST show
 * one generic message."
 * Q64: the auth client "keeps the Visma Connect `url` as a string: the page enforces
 * D11's absolute-`https:` rule."
 * D15: "Error display is sanitized. [...] the server's `message` is never shown"; "Every
 * [...] search param [...] value is parsed with Zod"; "Never submit without a user
 * action on every authentication page."
 * Tickets: the origin check against the discovered issuer is not built in this change,
 * so any absolute `https:` URL is followed and no host is asserted here.
 *
 * Assumed API (the contract of this task):
 *
 * ```ts
 * // src/lib/navigate-away.ts: the only place that leaves the app for another origin.
 * // It calls `window.location.assign(url)` and nothing else. jsdom's `location.assign`
 * // can be neither replaced nor spied on, so this test mocks the module (as 5.11 does
 * // with `src/app/reload.ts`). The URL check happens before this call, in the page or a
 * // `lib/` helper, never inside it: the mock below would hide it.
 * export function navigateToExternal(url: string): void;
 *
 * // src/app/search-params.ts: `signInSearchSchema` also yields `error: 'sso' | undefined`.
 * // It is `'sso'` when the raw `error` is `sso`, or a list whose first value is `sso`:
 * // Better Auth appends its own code to `errorCallbackURL`, so the real return is
 * // `/sign-in?error=sso&error=<code>&error_description=<text>`. Anything else is absent.
 * ```
 *
 * The page (texts from the `auth` namespace, English pinned here):
 *
 * - A button "Sign in with Visma Connect" (`auth:signIn.vismaConnect`) in the `main`
 *   landmark, outside the credentials form's submit: a click sends only
 *   `POST /api/auth/sign-in/social` (through `authClient.signInWithVismaConnect()`).
 * - When the answer's `url` parses, with no base, as an absolute URL whose protocol is
 *   `https:`, the page calls `navigateToExternal(url)` once with that URL; the router
 *   does not move. Anything else (`http:`, `javascript:`, `data:`, relative,
 *   protocol-relative, unparseable), a 5xx or a network failure shows one `alert`,
 *   "Signing in with Visma Connect failed. Try again." (`auth:signIn.ssoFailed`), and
 *   never navigates. The returned value and the server's text are never shown.
 * - `?error=sso` shows the same `alert` on load, with no request; an unknown `error`
 *   value shows no alert. `error_description` is never shown.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { i18n as I18n } from 'i18next';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { navigateToExternal } from '../lib/navigate-away.js';
import { createThemeStore } from '../state/theme.js';

vi.mock('../lib/navigate-away.js', () => ({ navigateToExternal: vi.fn() }));

/** A Visma Connect authorization URL, already in its normalized `URL#href` form. */
const AUTHORIZE_URL =
  'https://connect.visma.com/connect/authorize?client_id=tayzu&response_type=code&scope=openid%20email%20profile&state=st-7f3a9c&code_challenge=cc-41b8e2&code_challenge_method=S256&redirect_uri=https%3A%2F%2Ftayzu.example%2Fapi%2Fauth%2Foauth2%2Fcallback%2Fvisma-connect';

const SOCIAL_PATH = '/api/auth/sign-in/social';

const SOCIAL_BODY = {
  provider: 'visma-connect',
  callbackURL: '/',
  errorCallbackURL: '/sign-in?error=sso',
};

const BUTTON_NAME = 'Sign in with Visma Connect';
const SSO_FAILED = 'Signing in with Visma Connect failed. Try again.';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/** How the fake server answers `POST /api/auth/sign-in/social`. */
type SocialAnswer =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'network' }
  | { readonly kind: 'deferred'; readonly answer: Promise<Response> };

/** A fake `fetch` playing Better Auth and the API, with no session. */
function createFakeServer(social: SocialAnswer) {
  const calls: RecordedRequest[] = [];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, headers: request.headers, body });

    if (request.method === 'POST' && url.pathname === SOCIAL_PATH) {
      switch (social.kind) {
        case 'url':
          return jsonResponse(200, { url: social.url, redirect: true });
        case 'status':
          return jsonResponse(social.status, {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'server-text: discovery failed',
          });
        case 'network':
          throw new TypeError('server-text: network down');
        case 'deferred':
          return social.answer;
      }
    }
    if (url.pathname.startsWith('/v1/')) {
      return jsonResponse(401, {
        defined: false,
        code: 'CATALOG_CONTEXT_REQUIRED',
        status: 401,
        message: 'server-text: unauthorized',
      });
    }
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    calls,
    callsTo(method: string, path: string) {
      return calls.filter((call) => call.method === method && call.url.pathname === path);
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

/** Every slot but `signIn`, which keeps the router's default: the real page. */
const PROBES = {
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

interface RenderedApp {
  readonly history: RouterHistory;
  readonly i18n: I18n;
}

/** Renders the whole app (session gate, shell and providers, as `main.tsx`) at `path`. */
async function renderApp(path: string, server: FakeServer): Promise<RenderedApp> {
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
  return { history, i18n };
}

/** Waits for the sign-in page and returns its `main` landmark. */
async function signInMain(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Sign in to Tayzu' });
  const main = heading.closest('main');
  if (main === null) throw new Error('The sign-in heading is not inside a main landmark');
  return main;
}

/** Waits for the sign-in page and returns its Visma Connect button. */
async function vismaConnectButton(): Promise<HTMLElement> {
  const main = await signInMain();
  return within(main).getByRole('button', { name: BUTTON_NAME });
}

/** Lets pending promises and React updates settle, so a late navigation would show. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function locationOf(history: RouterHistory): string {
  return `${history.location.pathname}${history.location.search}`;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(navigateToExternal).mockClear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Visma Connect sign-in', () => {
  it('posts the exact social sign-in body when the button is clicked', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    await renderApp('/sign-in', server);

    await user.click(await vismaConnectButton());

    await waitFor(() => {
      expect(server.callsTo('POST', SOCIAL_PATH)).toHaveLength(1);
    });
    const [call] = server.callsTo('POST', SOCIAL_PATH);
    expect(call?.url.origin).toBe(window.location.origin);
    expect(call?.url.search).toBe('');
    expect(JSON.parse(call?.body ?? '')).toEqual(SOCIAL_BODY);
    expect(call?.headers.get('x-csrf-token')).toBe('orpc');
    // The button is not the credentials form's submit: nothing else is sent.
    expect(server.calls).toHaveLength(1);
  });

  it('keeps callbackURL "/" whatever the returnTo of the page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    await renderApp(`/sign-in?returnTo=${encodeURIComponent('/catalog/service')}`, server);

    await user.click(await vismaConnectButton());

    await waitFor(() => {
      expect(server.callsTo('POST', SOCIAL_PATH)).toHaveLength(1);
    });
    expect(JSON.parse(server.callsTo('POST', SOCIAL_PATH)[0]?.body ?? '')).toEqual(SOCIAL_BODY);
  });

  it('sends nothing and navigates nowhere before the click', async () => {
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    await renderApp('/sign-in', server);

    await vismaConnectButton();
    await settle();

    expect(server.calls).toEqual([]);
    expect(navigateToExternal).not.toHaveBeenCalled();
  });

  it('navigates to the returned https: URL only after the click and the answer', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const server = createFakeServer({ kind: 'deferred', answer: pending });
    const { history } = await renderApp('/sign-in', server);

    const button = await vismaConnectButton();
    expect(navigateToExternal).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() => {
      expect(server.callsTo('POST', SOCIAL_PATH)).toHaveLength(1);
    });
    await settle();
    expect(navigateToExternal).not.toHaveBeenCalled();

    answer(jsonResponse(200, { url: AUTHORIZE_URL, redirect: true }));

    await waitFor(() => {
      expect(navigateToExternal).toHaveBeenCalledTimes(1);
    });
    expect(navigateToExternal).toHaveBeenCalledWith(AUTHORIZE_URL);
    // The app's router does not move, and the page never fetches the returned URL.
    expect(locationOf(history)).toBe('/sign-in');
    for (const { url } of server.calls) expect(url.origin).toBe(window.location.origin);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a returned URL that is not an absolute https: URL is refused', () => {
  it.each([
    ['http:', 'http://connect.visma.com/connect/authorize?state=st-7f3a9c'],
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['relative with a leading slash', '/connect/authorize?state=st-7f3a9c'],
    ['relative without a leading slash', 'connect/authorize?state=st-7f3a9c'],
    ['protocol-relative', '//connect.visma.com/connect/authorize?state=st-7f3a9c'],
    ['unparseable, a scheme with no host', 'https://'],
    ['unparseable, plain text', 'not a url'],
  ])('refuses a %s URL with the generic message and no navigation', async (_kind, url) => {
    const user = userEvent.setup();
    const server = createFakeServer({ kind: 'url', url });
    const { history } = await renderApp('/sign-in', server);

    await user.click(await vismaConnectButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SSO_FAILED);
    await settle();
    expect(navigateToExternal).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.body.textContent).not.toContain(url);
    expect(locationOf(history)).toBe('/sign-in');
    expect(server.callsTo('POST', SOCIAL_PATH)).toHaveLength(1);
    for (const call of server.calls) expect(call.url.origin).toBe(window.location.origin);
  });
});

describe('a failed social sign-in shows the generic message', () => {
  it.each([
    ['a 500', { kind: 'status', status: 500 }],
    ['a 503', { kind: 'status', status: 503 }],
    ['a network failure', { kind: 'network' }],
  ] as const)('shows the generic message on %s, with no navigation', async (_kind, social) => {
    const user = userEvent.setup();
    const server = createFakeServer(social);
    const { history } = await renderApp('/sign-in', server);

    await user.click(await vismaConnectButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(SSO_FAILED);
    await settle();
    expect(navigateToExternal).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(locationOf(history)).toBe('/sign-in');
  });
});

describe('the ?error=sso return', () => {
  it('shows the generic message on /sign-in?error=sso, with no request and no navigation', async () => {
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    await renderApp('/sign-in?error=sso', server);

    const main = await signInMain();
    expect(await within(main).findByRole('alert')).toHaveTextContent(SSO_FAILED);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // The local form and the button are still offered.
    expect(within(main).getByRole('textbox', { name: 'Email' })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: BUTTON_NAME })).toBeInTheDocument();
    await settle();
    expect(server.calls).toEqual([]);
    expect(navigateToExternal).not.toHaveBeenCalled();
  });

  it("shows the generic message on Better Auth's real return, never the code or description", async () => {
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    // `appendQueryParams` of Better Auth adds its own `error` (and a description) after ours.
    await renderApp(
      '/sign-in?error=sso&error=state_mismatch&error_description=server-text%3A+call+this+number',
      server,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(SSO_FAILED);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(screen.queryByText(/state_mismatch/)).not.toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it('localizes the message', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    const { i18n } = await renderApp('/sign-in?error=sso', server);

    const alert = await screen.findByRole('alert');
    expect(i18n.language).toBe('es');
    const spanish = i18n.t('signIn.ssoFailed', { ns: 'auth' });
    expect(spanish).not.toBe('signIn.ssoFailed');
    expect(spanish).not.toBe(SSO_FAILED);
    expect(alert).toHaveTextContent(spanish);
    expect(
      screen.getByRole('button', { name: i18n.t('signIn.vismaConnect', { ns: 'auth' }) }),
    ).toBeInTheDocument();
    expect(i18n.t('signIn.vismaConnect', { ns: 'auth' })).not.toBe(BUTTON_NAME);
  });

  it.each([
    '?error=other',
    '?error=SSO',
    '?error=sso%20',
    '?error=',
    '?error=state_mismatch',
    '?error=access_denied&error_description=server-text%3A+denied',
    '?error_description=server-text%3A+call+this+number',
  ])('shows no message for %s', async (query) => {
    const server = createFakeServer({ kind: 'url', url: AUTHORIZE_URL });
    await renderApp(`/sign-in${query}`, server);

    await vismaConnectButton();
    await settle();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(SSO_FAILED)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });
});
