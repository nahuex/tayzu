/**
 * Local sign-in (task 6.1, design D11, D12, D15, D16 and Q64, Q65, Q67, Q68; spec "Users
 * can sign in locally or with Visma Connect", scenarios "Local sign-in with a second
 * factor" and "A wrong password and an unknown email look the same", and "The UI never
 * carries the tenant, the cookie or tenant free text outside the page", scenario "An
 * external return path is ignored").
 *
 * D11 (`/sign-in`): "Email and password (`POST /api/auth/sign-in/email`). One uniform
 * failure message whatever the reason, matching the API's enumeration resistance, and a
 * localized "try again in N seconds" from `Retry-After` on `AUTH_RATE_LIMITED`. When the
 * answer requires the second factor, the page switches to a TOTP field
 * (`/two-factor/verify-totp`) with a switch to a backup code
 * (`/two-factor/verify-backup-code`). [...] A `returnTo` search parameter is honoured
 * only if it is an in-app path (D15)."
 * D11: "Password fields use `autocomplete="current-password"` or `"new-password"`, are
 * never echoed, stored or logged, and are cleared from form state after a submit."
 * D15: "No token, password, TOTP secret, backup code, [...] is ever stored." "Never
 * submit without a user action on every authentication page."
 * D12 / Q68: the public pages never call `GET /v1/me`; the session gate of a protected
 * route reads it through TanStack Query (`SESSION_QUERY_KEY`).
 * Spec: "Every page of the app MUST be operable by keyboard alone, MUST have labelled
 * controls and landmarks" (WCAG 2.2 A and AA, so a field error is tied to its field).
 *
 * Assumed API (the contract of this task):
 *
 * ```ts
 * // src/auth/sign-in-page.tsx: the real page of the router's `signIn` slot. It takes no
 * // props: it reads `returnTo` from the `/sign-in` route search (already passed through
 * // `safeReturnPath`), the auth client from `useAuthClient()` and the query client from
 * // `useQueryClient()`.
 * export function SignInPage(): React.JSX.Element;
 *
 * // src/api/auth-client-context.tsx
 * export function AuthClientProvider(props: {
 *   client: AuthClient;
 *   children: React.ReactNode;
 * }): React.JSX.Element;
 * export function useAuthClient(): AuthClient; // throws outside a provider
 *
 * // src/app/router.tsx: `DEFAULT_PAGES.signIn` is `SignInPage`.
 * ```
 *
 * The page (texts from the `auth` namespace, English pinned here):
 *
 * - A `main` landmark with the heading `auth:signIn.title` ("Sign in to Tayzu").
 * - The credentials step: a textbox "Email" (`type="email"`, `autocomplete` `username` or
 *   `email`), a field "Password" (`type="password"`, `autocomplete="current-password"`)
 *   and a submit button "Sign in". An empty field blocks the submit with no request and
 *   is marked `aria-invalid="true"` with an error message as its accessible description.
 * - Any failed sign-in but a rate limit shows one `alert`, "The email or password is
 *   incorrect.", whatever the server said; the password field is emptied after every
 *   submit.
 * - `AUTH_RATE_LIMITED` shows an `alert` "Too many attempts. Try again in N seconds."
 *   ("... in 1 second." for one), or "Too many attempts. Try again later." without a
 *   usable `Retry-After`.
 * - `twoFactorRedirect` switches to the code step: the password field is gone, a textbox
 *   "Authentication code" (`autocomplete="one-time-code"`), a submit button "Verify" and
 *   a button "Use a backup code", which switches to a textbox "Backup code"
 *   (`autocomplete="one-time-code"`) with the same "Verify". A refused code shows an
 *   `alert` "The code is not valid." and stays on the step.
 * - On success the page drops the cached session (so the gate reads `GET /v1/me` again)
 *   and navigates to `returnTo`, `/` by default.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
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

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: 'owner' | 'admin' | 'member';
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';
}

interface Account {
  readonly email: string;
  readonly password: string;
  /** The valid TOTP code; without it the account has no second factor. */
  readonly totp?: string;
  readonly backupCodes?: readonly string[];
  readonly me: MeBody;
}

function meOf(id: string, name: string, email: string, overrides: Partial<MeBody> = {}): MeBody {
  return {
    user: { id, name, email },
    organization: { id: 'org_1', name: 'Acme' },
    role: 'member',
    signInMethod: 'password',
    mfa: { enrolled: false },
    gate: 'none',
    ...overrides,
  };
}

const PASSWORD = 'correct-horse-battery-staple';
const TOTP_CODE = '123456';
const BACKUP_CODE = 'k7Qx2-Lp9Wd';

/** A user with TOTP enrolled. */
const MIA: Account = {
  email: 'mia@example.com',
  password: PASSWORD,
  totp: TOTP_CODE,
  backupCodes: [BACKUP_CODE],
  me: meOf('u_mia', 'Mia Moreno', 'mia@example.com', { mfa: { enrolled: true } }),
};

/** A user without a second factor. */
const NOAH: Account = {
  email: 'noah@example.com',
  password: 'noah-password-0042',
  me: meOf('u_noah', 'Noah Navarro', 'noah@example.com'),
};

/** An admin without a second factor: their session must enrol first. */
const ADA: Account = {
  email: 'ada@example.com',
  password: 'ada-password-0099',
  me: meOf('u_ada', 'Ada Alvarez', 'ada@example.com', {
    role: 'admin',
    gate: 'mfa_enrolment_required',
  }),
};

const ACTOR = { type: 'user', id: 'u_1' } as const;

function blueprint(identifier: string, title: { en: string; es?: string }) {
  return {
    identifier,
    title,
    schema: { properties: {}, required: [] },
    relations: {},
    version: 1,
    createdAt: '2026-11-01T10:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-01T10:00:00.000Z',
    updatedBy: ACTOR,
  };
}

const BLUEPRINTS = [
  blueprint('domain', { en: 'Domain' }),
  blueprint('service', { en: 'Service', es: 'Servicio' }),
];

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The uniform 401 of D8, as the `/v1` catch-all and every catalog route send it. */
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

interface FakeServerOptions {
  readonly accounts: readonly Account[];
  /** Signed in from the start. */
  readonly signedInAs?: Account;
  /** Every sign-in answers `429 AUTH_RATE_LIMITED`, with this `Retry-After` if given. */
  readonly rateLimited?: { readonly retryAfter?: string };
}

/**
 * A fake `fetch` playing Better Auth and the API. A wrong password and an unknown email
 * get different codes and messages on purpose: only the page can make them look the same.
 */
function createFakeServer(options: FakeServerOptions) {
  let session: Account | undefined = options.signedInAs;
  let pendingSecondFactor: Account | undefined;
  const calls: RecordedRequest[] = [];

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body });
    const { pathname } = url;
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST' && pathname === '/api/auth/sign-in/email') {
      if (options.rateLimited !== undefined) {
        const { retryAfter } = options.rateLimited;
        return jsonResponse(
          429,
          { code: 'AUTH_RATE_LIMITED', message: 'server-text: too many sign-ins' },
          retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        );
      }
      const account = options.accounts.find((candidate) => candidate.email === input.email);
      if (account === undefined) {
        return jsonResponse(401, {
          code: 'USER_NOT_FOUND',
          message: 'server-text: no user with this email',
        });
      }
      if (account.password !== input.password) {
        return jsonResponse(401, {
          code: 'INVALID_PASSWORD',
          message: 'server-text: wrong password for this user',
        });
      }
      if (account.totp !== undefined) {
        pendingSecondFactor = account;
        return jsonResponse(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'] });
      }
      session = account;
      return jsonResponse(200, { redirect: false, token: 'session-token', user: account.me.user });
    }

    if (request.method === 'POST' && pathname === '/api/auth/two-factor/verify-totp') {
      const account = pendingSecondFactor;
      if (account?.totp === undefined || account.totp !== input.code) {
        return jsonResponse(401, { code: 'INVALID_CODE', message: 'server-text: invalid code' });
      }
      pendingSecondFactor = undefined;
      session = account;
      return jsonResponse(200, { token: 'session-token', user: account.me.user });
    }

    if (request.method === 'POST' && pathname === '/api/auth/two-factor/verify-backup-code') {
      const account = pendingSecondFactor;
      if (account === undefined || !(account.backupCodes ?? []).includes(String(input.code))) {
        return jsonResponse(401, {
          code: 'INVALID_BACKUP_CODE',
          message: 'server-text: invalid backup code',
        });
      }
      pendingSecondFactor = undefined;
      session = account;
      return jsonResponse(200, { token: 'session-token', user: account.me.user });
    }

    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (session === undefined) return contextRequired();
    if (request.method === 'GET' && pathname === '/v1/me') return jsonResponse(200, session.me);
    if (request.method === 'GET' && pathname === '/v1/blueprints') {
      return jsonResponse(200, { items: BLUEPRINTS });
    }
    if (request.method === 'GET' && pathname.endsWith('/entities')) {
      return jsonResponse(200, { items: [] });
    }
    return new Response(null, { status: 204 });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    calls,
    /** The calls to `path`, in order, as `{ index, call }` over the whole log. */
    callsTo(method: string, path: string) {
      return calls
        .map((call, index) => ({ index, call }))
        .filter(({ call }) => call.method === method && call.url.pathname === path);
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
  readonly queryClient: QueryClient;
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
  return { history, queryClient };
}

const UNIFORM_FAILURE = 'The email or password is incorrect.';
const INVALID_CODE = 'The code is not valid.';

/** Waits for the sign-in page and returns its credential fields. */
async function signInForm() {
  // The heading first: after a navigation the previous page's `main` can still be mounted.
  const heading = await screen.findByRole('heading', { name: 'Sign in to Tayzu' });
  const main = heading.closest('main');
  if (main === null) throw new Error('The sign-in heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return {
    email: within(main).getByRole('textbox', { name: 'Email' }),
    password: within(main).getByLabelText('Password'),
    submit: within(main).getByRole('button', { name: 'Sign in' }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function submitCredentials(user: User, email: string, password: string): Promise<void> {
  const form = await signInForm();
  await user.clear(form.email);
  await user.type(form.email, email);
  await user.clear(form.password);
  await user.type(form.password, password);
  await user.click(form.submit);
}

async function submitCode(user: User, label: 'Authentication code' | 'Backup code', code: string) {
  const field = await screen.findByRole('textbox', { name: label });
  await user.type(field, code);
  await user.click(screen.getByRole('button', { name: 'Verify' }));
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

/** The rendered document, with the typed values of the inputs left out. */
function documentSnapshot(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  for (const input of copy.querySelectorAll('input')) input.removeAttribute('value');
  return copy.innerHTML;
}

function locationOf(history: RouterHistory): string {
  return `${history.location.pathname}${history.location.search}`;
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

describe('Local sign-in with a second factor', () => {
  it('reaches the home page with the blueprints in the sidebar after the password and a valid code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA, NOAH] });
    const { history } = await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, PASSWORD);

    // The page switches to the code step: the password field is gone.
    await screen.findByRole('textbox', { name: 'Authentication code' });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');

    await submitCode(user, 'Authentication code', TOTP_CODE);

    await screen.findByTestId('page-home');
    expect(history.location.pathname).toBe('/');
    const nav = await screen.findByRole('navigation', { name: 'Catalog' });
    expect(await within(nav).findByRole('link', { name: 'Domain' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Service' })).toBeInTheDocument();

    // One sign-in, one code check, then the gate reads the new session.
    const signIns = server.callsTo('POST', '/api/auth/sign-in/email');
    const totpChecks = server.callsTo('POST', '/api/auth/two-factor/verify-totp');
    expect(signIns).toHaveLength(1);
    expect(JSON.parse(signIns[0]?.call.body ?? '')).toEqual({
      email: MIA.email,
      password: PASSWORD,
    });
    expect(totpChecks).toHaveLength(1);
    expect(JSON.parse(totpChecks[0]?.call.body ?? '')).toEqual({ code: TOTP_CODE });
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-backup-code')).toHaveLength(0);
    const sessionReads = server.callsTo('GET', '/v1/me');
    expect(sessionReads.at(-1)?.index).toBeGreaterThan(totpChecks[0]?.index ?? Infinity);
  });

  it('comes back to the returnTo path and query that the session gate sent it from', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    const { history } = await renderApp('/catalog/service?sort=title', server);

    await signInForm();
    expect(history.location.pathname).toBe('/sign-in');

    await submitCredentials(user, MIA.email, PASSWORD);
    await submitCode(user, 'Authentication code', TOTP_CODE);

    await screen.findByTestId('page-catalogTable');
    expect(locationOf(history)).toBe('/catalog/service?sort=title');
  });

  it('keeps the code step and shows the code message when the code is refused', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    const { history } = await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, PASSWORD);
    await submitCode(user, 'Authentication code', '000000');

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID_CODE);
    expect(screen.getByRole('textbox', { name: 'Authentication code' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-home')).not.toBeInTheDocument();
  });

  it('reads the session again after signing in, so a stale cached session never decides the landing page', async () => {
    const user = userEvent.setup();
    // Noah is signed in and his session is in the cache; Ada then signs in on /sign-in.
    const server = createFakeServer({ accounts: [NOAH, ADA], signedInAs: NOAH });
    const { history } = await renderApp('/', server);
    await screen.findByTestId('page-home');

    history.push('/sign-in');
    await submitCredentials(user, ADA.email, ADA.password);

    // Ada's own session reports the MFA enrolment gate.
    await screen.findByTestId('page-mfaEnrol');
    expect(history.location.pathname).toBe('/mfa/enrol');
    expect(screen.queryByTestId('page-home')).not.toBeInTheDocument();
  });
});

describe('a user without a second factor', () => {
  it('goes straight to the returnTo path after the password', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [NOAH] });
    const { history } = await renderApp(
      `/sign-in?returnTo=${encodeURIComponent('/catalog/service')}`,
      server,
    );

    await submitCredentials(user, NOAH.email, NOAH.password);

    await screen.findByTestId('page-catalogTable');
    expect(locationOf(history)).toBe('/catalog/service');
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
  });
});

describe('the backup-code path', () => {
  it('switches from the TOTP field to a backup code and signs in with it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    const { history } = await renderApp(
      `/sign-in?returnTo=${encodeURIComponent('/catalog/service')}`,
      server,
    );

    await submitCredentials(user, MIA.email, PASSWORD);
    await screen.findByRole('textbox', { name: 'Authentication code' });

    await user.click(screen.getByRole('button', { name: 'Use a backup code' }));
    expect(screen.queryByRole('textbox', { name: 'Authentication code' })).not.toBeInTheDocument();
    await submitCode(user, 'Backup code', BACKUP_CODE);

    await screen.findByTestId('page-catalogTable');
    expect(locationOf(history)).toBe('/catalog/service');
    const backupChecks = server.callsTo('POST', '/api/auth/two-factor/verify-backup-code');
    expect(backupChecks).toHaveLength(1);
    expect(JSON.parse(backupChecks[0]?.call.body ?? '')).toEqual({ code: BACKUP_CODE });
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
  });
});

describe('A wrong password and an unknown email look the same', () => {
  it('shows the same message and the same page both times, and never the server text', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    const { history } = await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, 'not-the-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(UNIFORM_FAILURE);
    await waitFor(() => {
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });
    const afterWrongPassword = documentSnapshot();

    await submitCredentials(user, 'nobody@example.com', 'any-password');
    await waitFor(() => {
      expect(server.callsTo('POST', '/api/auth/sign-in/email')).toHaveLength(2);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(UNIFORM_FAILURE);
    await waitFor(() => {
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });
    const afterUnknownEmail = documentSnapshot();

    expect(afterUnknownEmail).toBe(afterWrongPassword);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
  });
});

describe('the rate-limited answer', () => {
  it.each([
    ['42', 'Too many attempts. Try again in 42 seconds.'],
    ['1', 'Too many attempts. Try again in 1 second.'],
  ])('shows when to try again from Retry-After %s', async (retryAfter, message) => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA], rateLimited: { retryAfter } });
    const { history } = await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText(UNIFORM_FAILURE)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
  });

  it('asks to try again later without a usable Retry-After', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA], rateLimited: {} });
    await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again later.',
    );
    expect(screen.queryByText(UNIFORM_FAILURE)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
  });
});

describe('autocomplete attributes', () => {
  it('marks the email, the password and both code fields for password managers and one-time codes', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    await renderApp('/sign-in', server);

    const form = await signInForm();
    expect(form.email).toHaveAttribute('type', 'email');
    expect(['username', 'email']).toContain(form.email.getAttribute('autocomplete'));
    expect(form.password).toHaveAttribute('type', 'password');
    expect(form.password).toHaveAttribute('autocomplete', 'current-password');

    await submitCredentials(user, MIA.email, PASSWORD);
    const totp = await screen.findByRole('textbox', { name: 'Authentication code' });
    expect(totp).toHaveAttribute('autocomplete', 'one-time-code');

    await user.click(screen.getByRole('button', { name: 'Use a backup code' }));
    const backup = await screen.findByRole('textbox', { name: 'Backup code' });
    expect(backup).toHaveAttribute('autocomplete', 'one-time-code');
  });
});

describe('An external return path is ignored', () => {
  it.each([
    '//evil.example/x',
    'https://evil.example/x',
    '/\\evil.example/x',
    'javascript:alert(1)',
    '/sign-in',
  ])('lands on / for returnTo=%s', async (returnTo) => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [NOAH] });
    const { history } = await renderApp(
      `/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
      server,
    );

    await submitCredentials(user, NOAH.email, NOAH.password);

    await screen.findByTestId('page-home');
    expect(locationOf(history)).toBe('/');
    for (const { url } of server.calls) expect(url.origin).toBe(window.location.origin);
  });
});

describe('no request without a user action, and the secrets stay out of the URL and storage', () => {
  it('sends nothing while the page renders and the user types', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    await renderApp('/sign-in', server);

    const form = await signInForm();
    await user.type(form.email, MIA.email);
    await user.type(form.password, PASSWORD);

    expect(server.calls).toEqual([]);
  });

  it('blocks a submit with empty fields, marking each field and describing its error', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    await renderApp('/sign-in', server);

    const form = await signInForm();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.password).toHaveAttribute('aria-invalid', 'true');
    expect(form.email).toHaveAccessibleDescription(expect.stringMatching(/\S/));
    expect(form.password).toHaveAccessibleDescription(expect.stringMatching(/\S/));
    expect(server.calls).toEqual([]);
  });

  it('never puts the password or a code in the URL or in browser storage', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ accounts: [MIA] });
    const { history } = await renderApp('/sign-in', server);

    await submitCredentials(user, MIA.email, PASSWORD);
    await screen.findByRole('textbox', { name: 'Authentication code' });
    expect(locationOf(history)).not.toContain(PASSWORD);
    expect(storageText()).not.toContain(PASSWORD);

    await submitCode(user, 'Authentication code', TOTP_CODE);
    await screen.findByTestId('page-home');

    for (const secret of [PASSWORD, TOTP_CODE, MIA.email]) {
      expect(locationOf(history)).not.toContain(secret);
      expect(storageText()).not.toContain(secret);
    }
    for (const { url } of server.calls) {
      expect(url.search).not.toContain(encodeURIComponent(PASSWORD));
      expect(url.search).not.toContain(TOTP_CODE);
    }
  });
});
