/**
 * The forgot-password page (task 6.7, design D11, D12, D15, D16 and Q23, Q64, Q68, Q71;
 * spec "The invitation and password-reset pages follow the page rules").
 *
 * D11 (`/forgot-password`, Q23): "one email field, `POST /v1/auth/password-reset/request`,
 * and the same "if an account exists, a link was sent" message for every answer but
 * `AUTH_RATE_LIMITED`."
 * Spec: "The app MUST serve [...] `/forgot-password` to request a reset. [...] The
 * forgot-password page MUST show the same message for every answer but a rate limit."
 * D12 / Q68: the public pages (sign-in, forgot, reset, accept, step-up complete) render
 * without a session and never call `GET /v1/me`.
 * D15: "Never submit without a user action on every authentication page."
 * Q71 (followed here for what D11 leaves open): empty fields are refused on the client
 * with associated errors (WCAG 3.3.1), with no email-format rule; a `429` without a usable
 * `Retry-After` asks to try again later.
 *
 * The real answers of the request route (`apps/api/src/server.ts`, `044` D2 and D4): a
 * uniform `200 { accepted: true }` whatever happened; a `400 CATALOG_VALIDATION_FAILED`
 * for a malformed body or address, or a refused CSRF header or origin; the limiter's
 * `429 AUTH_RATE_LIMITED` with `Retry-After`; and, when the identity routes are not
 * mounted or something fails, a `404`, a `401` from the `/v1` catch-all or a sanitized
 * `500`. Only the rate limit is told apart.
 *
 * Assumed API (the contract of this task):
 *
 * ```ts
 * // src/auth/forgot-password-page.tsx: the real page of the router's `forgotPassword`
 * // slot. It takes no props and reads the auth client from `useAuthClient()`.
 * export function ForgotPasswordPage(): React.JSX.Element;
 *
 * // src/app/router.tsx: `DEFAULT_PAGES.forgotPassword` is `ForgotPasswordPage`.
 * ```
 *
 * The page (texts from the `auth` namespace, `forgotPassword.` prefix, English pinned):
 *
 * - A `main` landmark with the heading "Forgot your password?".
 * - A textbox "Email" (`type="email"`, `autocomplete` `username` or `email`), a submit
 *   button "Send reset link" and a link "Back to sign-in" to `/sign-in`. An empty field
 *   blocks the submit with no request and is marked `aria-invalid="true"` with the error
 *   "Enter your email." as its accessible description. There is no email-format rule.
 * - A submit sends `requestPasswordReset({ email })` with the value as typed.
 * - Every answer but a rate limit replaces the form with one `status` region, "If an
 *   account exists for this email, a link to reset the password has been sent.", and
 *   keeps the "Back to sign-in" link: the same document for every answer, with no alert,
 *   no server text and no echo of the address.
 * - `AUTH_RATE_LIMITED` keeps the form, with the typed address, and shows an `alert`
 *   "Too many attempts. Try again in N seconds." ("... in 1 second." for one), or "Too
 *   many attempts. Try again later." without a usable `Retry-After`.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const REQUEST_PATH = '/v1/auth/password-reset/request';

const TITLE = 'Forgot your password?';
const EMAIL_LABEL = 'Email';
const SUBMIT = 'Send reset link';
const BACK = 'Back to sign-in';
const EMAIL_REQUIRED = 'Enter your email.';
const UNIFORM_MESSAGE =
  'If an account exists for this email, a link to reset the password has been sent.';
const RATE_LIMITED_LATER = 'Too many attempts. Try again later.';

const EMAIL = 'Mia.Moreno@Example.com';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

/** The limiter's answer (`accept-rate-limit.ts`), with this `Retry-After` if given. */
function rateLimited(retryAfter?: string): Response {
  return jsonResponse(
    429,
    {
      defined: false,
      code: 'AUTH_RATE_LIMITED',
      status: 429,
      message: 'server-text: too many requests',
    },
    retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  );
}

/** What the request route answers: a `Response`, or a thrown network failure. */
type RequestAnswer = () => Response;

/** The route's uniform success. */
const ACCEPTED: RequestAnswer = () => jsonResponse(200, { accepted: true });

/** The route's refusal of a malformed address (`IdentityInputError`). */
const VALIDATION_FAILED: RequestAnswer = () =>
  jsonResponse(400, {
    defined: false,
    code: 'CATALOG_VALIDATION_FAILED',
    status: 400,
    message: 'server-text: input validation failed',
    data: { issues: [{ path: '/email', message: 'server-text: not a valid address' }] },
  });

/** Every answer but a rate limit: each must end on the same page. */
const UNIFORM_ANSWERS: readonly (readonly [string, RequestAnswer])[] = [
  ['a 200', ACCEPTED],
  [
    'a 404 with a JSON body',
    () =>
      jsonResponse(404, {
        defined: false,
        code: 'CATALOG_NOT_FOUND',
        status: 404,
        message: 'server-text: no account with this email',
      }),
  ],
  [
    'a 404 that is not JSON',
    () =>
      new Response('server-text: Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
  ],
  ['a 400', VALIDATION_FAILED],
  ['a 401', contextRequired],
  [
    'a 500',
    () =>
      jsonResponse(500, {
        defined: false,
        code: 'INTERNAL_SERVER_ERROR',
        status: 500,
        message: 'server-text: internal error',
      }),
  ],
  [
    'a network failure',
    () => {
      throw new TypeError('server-text: Failed to fetch');
    },
  ],
];

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * A fake `fetch` playing the API. `answers` are used in order, one per reset request; the
 * last one repeats. No session exists: `GET /v1/me` and every other `/v1` call answer 401.
 */
function createFakeServer(answers: readonly RequestAnswer[] = [ACCEPTED]) {
  const calls: RecordedRequest[] = [];
  let requests = 0;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, headers: request.headers, body });

    if (request.method === 'POST' && url.pathname === REQUEST_PATH) {
      const answer = answers[Math.min(requests, answers.length - 1)];
      requests += 1;
      if (answer === undefined) throw new Error('The fake server has no answer');
      return answer();
    }
    if (url.pathname.startsWith('/v1/')) return contextRequired();
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

/** Every slot but `forgotPassword` and `signIn`, which keep the router's real pages. */
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

/** Waits for the page and returns its `main` landmark. */
async function forgotPage(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The forgot-password heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Waits for the form and returns its controls. */
async function forgotForm() {
  const main = await forgotPage();
  return {
    main,
    email: within(main).getByRole('textbox', { name: EMAIL_LABEL }),
    submit: within(main).getByRole('button', { name: SUBMIT }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function submitEmail(user: User, email: string): Promise<void> {
  const form = await forgotForm();
  await user.clear(form.email);
  await user.type(form.email, email);
  await user.click(form.submit);
}

/** Waits for the uniform message and returns its status region. */
async function uniformMessage(): Promise<HTMLElement> {
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent(UNIFORM_MESSAGE);
  return status;
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

/**
 * The rendered document, without typed input values and without the generated ids
 * (`useId` counts across renders, so two renders never share them).
 */
function documentSnapshot(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  for (const element of copy.querySelectorAll('*')) {
    for (const name of ['value', 'id', 'for', 'aria-describedby', 'aria-labelledby']) {
      element.removeAttribute(name);
    }
  }
  return copy.innerHTML;
}

function locationOf(history: RouterHistory): string {
  return `${history.location.pathname}${history.location.search}${history.location.hash}`;
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

describe('the forgot-password page renders without a session', () => {
  it('shows the form on /forgot-password without reading GET /v1/me or being redirected', async () => {
    const server = createFakeServer();
    const { history } = await renderApp('/forgot-password', server);

    const form = await forgotForm();
    expect(form.email).toHaveValue('');
    expect(within(form.main).getByRole('link', { name: BACK })).toHaveAttribute('href', '/sign-in');
    expect(history.location.pathname).toBe('/forgot-password');
    expect(server.callsTo('GET', '/v1/me')).toHaveLength(0);
    expect(server.calls).toEqual([]);
  });

  it('never reads GET /v1/me after a submit either', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);
    await uniformMessage();

    expect(server.callsTo('GET', '/v1/me')).toHaveLength(0);
    expect(server.calls.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      `POST ${REQUEST_PATH}`,
    ]);
    expect(history.location.pathname).toBe('/forgot-password');
  });

  it('goes back to the sign-in page through its link', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await renderApp('/forgot-password', server);

    const main = await forgotPage();
    await user.click(within(main).getByRole('link', { name: BACK }));

    expect(await screen.findByRole('heading', { name: 'Sign in to Tayzu' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/sign-in');
    expect(server.calls).toEqual([]);
  });
});

describe('the email field', () => {
  it('is one email field marked for password managers', async () => {
    const server = createFakeServer();
    await renderApp('/forgot-password', server);

    const form = await forgotForm();
    expect(within(form.main).getAllByRole('textbox')).toEqual([form.email]);
    expect(form.main.querySelectorAll('input')).toHaveLength(1);
    expect(form.email).toHaveAttribute('type', 'email');
    expect(['username', 'email']).toContain(form.email.getAttribute('autocomplete'));
  });
});

describe('no request without a user action', () => {
  it('sends nothing while the page renders and the user types', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp('/forgot-password', server);

    const form = await forgotForm();
    await user.type(form.email, EMAIL);

    expect(server.calls).toEqual([]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('refuses an empty field on the client, marking it and describing its error', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp('/forgot-password', server);

    const form = await forgotForm();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.email).toHaveAccessibleDescription(EMAIL_REQUIRED);
    expect(server.calls).toEqual([]);
    expect(screen.queryByText(UNIFORM_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: EMAIL_LABEL })).toBe(form.email);
  });
});

describe('the request', () => {
  it('posts the email as typed, once, to the reset request route with the CSRF header', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);
    await uniformMessage();

    const requests = server.callsTo('POST', REQUEST_PATH);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url.origin).toBe(window.location.origin);
    expect(request?.url.search).toBe('');
    expect(request?.headers.get('x-csrf-token')).toBe('orpc');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(request?.body ?? '')).toEqual({ email: EMAIL });
  });

  it('has no email-format rule: the server decides', async () => {
    const user = userEvent.setup();
    const server = createFakeServer([VALIDATION_FAILED]);
    await renderApp('/forgot-password', server);

    await submitEmail(user, 'not-an-address');
    await uniformMessage();

    const requests = server.callsTo('POST', REQUEST_PATH);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({ email: 'not-an-address' });
  });
});

describe('the same message for every answer but a rate limit', () => {
  it.each(UNIFORM_ANSWERS)(
    'replaces the form with the uniform message after %s',
    async (_name, answer) => {
      const user = userEvent.setup();
      const server = createFakeServer([answer]);
      const { history } = await renderApp('/forgot-password', server);

      await submitEmail(user, EMAIL);

      const status = await uniformMessage();
      const main = await forgotPage();
      expect(main).toContainElement(status);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: EMAIL_LABEL })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: SUBMIT })).not.toBeInTheDocument();
      expect(within(main).getByRole('link', { name: BACK })).toHaveAttribute('href', '/sign-in');
      expect(document.body.textContent).not.toContain('server-text');
      expect(document.body.textContent).not.toContain(EMAIL);
      expect(history.location.pathname).toBe('/forgot-password');
      expect(server.callsTo('POST', REQUEST_PATH)).toHaveLength(1);
    },
  );

  it('renders the very same document for every one of those answers', async () => {
    const snapshots: string[] = [];
    for (const [index, [, answer]] of UNIFORM_ANSWERS.entries()) {
      const user = userEvent.setup();
      const server = createFakeServer([answer]);
      await renderApp('/forgot-password', server);

      // A different address each time: the page must not echo it back.
      await submitEmail(user, `person-${String(index)}@example.com`);
      await uniformMessage();
      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: EMAIL_LABEL })).not.toBeInTheDocument();
      });
      snapshots.push(documentSnapshot());
      cleanup();
    }

    expect(snapshots).toHaveLength(UNIFORM_ANSWERS.length);
    for (const snapshot of snapshots) expect(snapshot).toBe(snapshots[0]);
  });
});

describe('the rate-limited answer', () => {
  it.each([
    ['42', 'Too many attempts. Try again in 42 seconds.'],
    ['1', 'Too many attempts. Try again in 1 second.'],
  ])('shows when to try again from Retry-After %s and keeps the form', async (retryAfter, text) => {
    const user = userEvent.setup();
    const server = createFakeServer([() => rateLimited(retryAfter)]);
    const { history } = await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText(UNIFORM_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    const form = await forgotForm();
    expect(form.email).toHaveValue(EMAIL);
    expect(history.location.pathname).toBe('/forgot-password');
  });

  it.each([
    ['without Retry-After', undefined],
    ['with an HTTP-date Retry-After', 'Fri, 20 Nov 2026 10:00:00 GMT'],
    ['with a Retry-After of 0', '0'],
  ])('asks to try again later %s', async (_name, retryAfter) => {
    const user = userEvent.setup();
    const server = createFakeServer([() => rateLimited(retryAfter)]);
    await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);

    expect(await screen.findByRole('alert')).toHaveTextContent(RATE_LIMITED_LATER);
    expect(screen.queryByText(UNIFORM_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(/server-text/)).not.toBeInTheDocument();
    expect((await forgotForm()).email).toHaveValue(EMAIL);
  });

  it('shows the uniform message, and no alert, when a later submit gets through', async () => {
    const user = userEvent.setup();
    const server = createFakeServer([() => rateLimited('5'), ACCEPTED]);
    await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 5 seconds.',
    );

    await user.click((await forgotForm()).submit);

    await uniformMessage();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(server.callsTo('POST', REQUEST_PATH)).toHaveLength(2);
    for (const request of server.callsTo('POST', REQUEST_PATH)) {
      expect(JSON.parse(request.body)).toEqual({ email: EMAIL });
    }
  });
});

describe('the address stays out of the URL and browser storage', () => {
  it.each([
    ['the uniform answer', ACCEPTED, 'status'],
    ['a rate limit', () => rateLimited('42'), 'alert'],
  ] as const)('after %s', async (_name, answer, role) => {
    const user = userEvent.setup();
    const server = createFakeServer([answer]);
    const { history } = await renderApp('/forgot-password', server);

    await submitEmail(user, EMAIL);
    await waitFor(() => {
      expect(server.callsTo('POST', REQUEST_PATH)).toHaveLength(1);
    });
    await screen.findByRole(role);

    for (const value of [EMAIL, EMAIL.toLowerCase(), encodeURIComponent(EMAIL)]) {
      expect(locationOf(history)).not.toContain(value);
      expect(storageText()).not.toContain(value);
    }
    expect(locationOf(history)).toBe('/forgot-password');
    for (const { url } of server.calls) expect(url.search).toBe('');
  });
});
