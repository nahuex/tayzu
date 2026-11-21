/**
 * The sign-in page's link to the forgot-password page (follow-up cycle of task 6.7,
 * design D11, D12, D15, D16 and Q23, Q77).
 *
 * Q23: "A `/forgot-password` page is part of `003`" ("needed to reach `/reset-password`").
 * Q77: "A "Back to sign-in" link is always there, and the sign-in page links to
 * `/forgot-password` (Q23: the page exists to reach `/reset-password`), added in a
 * follow-up cycle of this task."
 * D11 (`/sign-in`): "Email and password [...]. When the answer requires the second factor,
 * the page switches to a TOTP field (`/two-factor/verify-totp`) with a switch to a backup
 * code". The link is part of the credentials step: once the password has been accepted the
 * page has switched to the code step, where a forgotten password is no longer the question,
 * so the code step does not show it (as it does not show the Visma Connect button).
 * D15: "Never submit without a user action on every authentication page." Following the
 * link is navigation, not a submit: it sends nothing.
 * D12 / Q68: the public pages render without a session and never call `GET /v1/me`.
 *
 * Assumed API (the contract of this cycle):
 *
 * - `src/auth/sign-in-page.tsx`: on the credentials step only, the `main` landmark holds
 *   one link `auth:signIn.forgotPassword`, "Forgot your password?" (English pinned here),
 *   to exactly `/forgot-password`: no `returnTo`, no search, no hash and no typed value.
 * - Following it renders the real forgot-password page (`DEFAULT_PAGES.forgotPassword`,
 *   heading "Forgot your password?") with an empty email field, and sends no request.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

const SIGN_IN_TITLE = 'Sign in to Tayzu';
const FORGOT_LINK = 'Forgot your password?';
const FORGOT_TITLE = 'Forgot your password?';

const EMAIL = 'mia@example.com';
const PASSWORD = 'correct-horse-battery-staple';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The uniform 401 of D8, as the `/v1` catch-all sends it. */
function contextRequired(): Response {
  return jsonResponse(401, {
    defined: false,
    code: 'CATALOG_CONTEXT_REQUIRED',
    status: 401,
    message: 'server-text: unauthorized',
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
}

/**
 * A fake `fetch` playing Better Auth and the API, with no session. The one account has a
 * second factor, so a valid password reaches the code step.
 */
function createFakeServer() {
  const calls: RecordedRequest[] = [];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body });
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
      if (input.email === EMAIL && input.password === PASSWORD) {
        return jsonResponse(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'] });
      }
      return jsonResponse(401, {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'server-text: invalid email or password',
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/password-reset/request') {
      return jsonResponse(200, { accepted: true });
    }
    if (url.pathname.startsWith('/v1/')) return contextRequired();
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    calls,
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

/** A page slot: its test id names it. */
function probe(name: PageName | 'passwordExpired'): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `signIn` and `forgotPassword`, which keep the router's real pages. */
const PROBES = {
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

/** Waits for the sign-in page and returns its `main` landmark. */
async function signInPage(): Promise<HTMLElement> {
  // The heading first: after a navigation the previous page's `main` can still be mounted.
  const heading = await screen.findByRole('heading', { name: SIGN_IN_TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The sign-in heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Waits for the forgot-password page and returns its `main` landmark. */
async function forgotPage(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: FORGOT_TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The forgot-password heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Every key and value of both storages, as one text. */
function storageText(): string {
  const parts: string[] = [];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) parts.push(key, storage.getItem(key) ?? '');
    }
  }
  return parts.join('\n');
}

function locationOf(history: RouterHistory): string {
  return `${history.location.pathname}${history.location.search}${history.location.hash}`;
}

type User = ReturnType<typeof userEvent.setup>;

async function submitCredentials(user: User, main: HTMLElement): Promise<void> {
  await user.type(within(main).getByRole('textbox', { name: 'Email' }), EMAIL);
  await user.type(within(main).getByLabelText('Password'), PASSWORD);
  await user.click(within(main).getByRole('button', { name: 'Sign in' }));
}

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

describe('the sign-in page links to the forgot-password page', () => {
  it('shows a "Forgot your password?" link to /forgot-password on the credentials step', async () => {
    const server = createFakeServer();
    await renderApp('/sign-in', server);

    const main = await signInPage();
    const link = within(main).getByRole('link', { name: FORGOT_LINK });
    expect(link).toHaveAttribute('href', '/forgot-password');
    expect(within(main).getAllByRole('link', { name: FORGOT_LINK })).toEqual([link]);
    expect(server.calls).toEqual([]);
  });

  it('reaches the real forgot-password page through the link, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/sign-in', server);

    const signIn = await signInPage();
    await user.click(within(signIn).getByRole('link', { name: FORGOT_LINK }));

    const forgot = await forgotPage();
    expect(within(forgot).getByRole('textbox', { name: 'Email' })).toHaveValue('');
    expect(within(forgot).getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: SIGN_IN_TITLE })).not.toBeInTheDocument();
    expect(locationOf(history)).toBe('/forgot-password');
    expect(server.calls).toEqual([]);
  });

  it('reaches the forgot-password page from the keyboard', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/sign-in', server);

    const signIn = await signInPage();
    const link = within(signIn).getByRole('link', { name: FORGOT_LINK });
    link.focus();
    expect(link).toHaveFocus();
    await user.keyboard('{Enter}');

    await forgotPage();
    expect(locationOf(history)).toBe('/forgot-password');
    expect(server.calls).toEqual([]);
  });
});

describe('the link carries nothing from the sign-in page', () => {
  it('drops returnTo and the typed email and password, and submits nothing', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp(
      `/sign-in?returnTo=${encodeURIComponent('/catalog/service?q=api')}`,
      server,
    );

    const signIn = await signInPage();
    await user.type(within(signIn).getByRole('textbox', { name: 'Email' }), EMAIL);
    await user.type(within(signIn).getByLabelText('Password'), PASSWORD);

    const link = within(signIn).getByRole('link', { name: FORGOT_LINK });
    expect(link).toHaveAttribute('href', '/forgot-password');

    await user.click(link);

    const forgot = await forgotPage();
    expect(locationOf(history)).toBe('/forgot-password');
    expect(history.location.search).toBe('');
    expect(history.location.hash).toBe('');
    expect(within(forgot).getByRole('textbox', { name: 'Email' })).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(EMAIL);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(storageText()).not.toContain(EMAIL);
    expect(storageText()).not.toContain(PASSWORD);
    expect(server.calls).toEqual([]);
  });
});

describe('the code step does not offer the link', () => {
  it('has no "Forgot your password?" link once the page has switched to the code step', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp('/sign-in', server);

    const signIn = await signInPage();
    expect(within(signIn).getByRole('link', { name: FORGOT_LINK })).toBeInTheDocument();
    await submitCredentials(user, signIn);

    expect(await screen.findByRole('textbox', { name: 'Authentication code' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: FORGOT_LINK })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use a backup code' }));
    expect(await screen.findByRole('textbox', { name: 'Backup code' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: FORGOT_LINK })).not.toBeInTheDocument();
  });
});
