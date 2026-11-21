/**
 * The password-reset page (task 6.8, design D11, D12, D15, D16 and Q68, Q71, Q73, Q74;
 * archived `044` design D2, D3, D6, D14 and its Q26; spec "The invitation and
 * password-reset pages follow the page rules", scenarios "The reset fragment is stripped
 * before any request", "A reset for an MFA-enrolled user asks for the factor" and "An
 * invalid link shows the uniform message").
 *
 * D11 (`/reset-password`): "Before the first render, the page reads `reset` and `token`
 * from `location.hash`, removes the fragment with `history.replaceState`, and keeps both
 * values in component state only (never storage, the URL, the query cache or a log). It
 * shows new password and confirmation and submits only on the user's click (`POST
 * /v1/auth/password-reset/confirm`). On `AUTH_STEP_UP_REQUIRED` it shows a factor field
 * (TOTP or backup code) and the user submits again with `factor`. The uniform `404` shows
 * "this link is invalid or expired"; success shows a link to `/sign-in`. A missing
 * fragment shows the same invalid-link message."
 * D11: "Password fields use [...] `"new-password"`, are never echoed, stored or logged,
 * and are cleared from form state after a submit." Page rules: "the fragment gone from
 * `location` before any request is made, and no submit without a user action."
 * `044` D3: the link is `/reset-password#reset=<id>&token=<token>`, `id` 22 and `token`
 * 43 characters of base64url. `044` D14 (Q26): the page "never submits the new password
 * without the user's action, and it shows a factor field when the confirm route answers
 * `AUTH_STEP_UP_REQUIRED`".
 * Q68: the public pages never call `GET /v1/me`, so the fragment is stripped before any
 * request.
 * Spec: "Each link page MUST read its identifier and token from the URL fragment, remove
 * the fragment from the address before any request, keep both only in memory, and submit
 * only on the user's action. The reset page MUST show a factor field when the
 * confirmation answers `AUTH_STEP_UP_REQUIRED`. [...] Every rejection MUST show one
 * uniform message."
 * Scenario "The reset fragment is stripped before any request": GIVEN a valid reset
 * link, WHEN a user opens it, THEN the address shows `/reset-password` with no fragment
 * before the page makes any request, and no request carries the token until the user
 * submits.
 * Scenario "A reset for an MFA-enrolled user asks for the factor": GIVEN a valid reset
 * link for a user with TOTP, WHEN they submit a new password without a factor, THEN the
 * page asks for a code, and submitting again with a valid code completes the reset.
 * Scenario "An invalid link shows the uniform message": WHEN a visitor opens
 * `/reset-password` with an unknown token, THEN after they submit, the page shows the
 * uniform invalid-or-expired message.
 *
 * The server's answers (`apps/api/src/identity/password-reset-confirm.ts`, `server.ts`,
 * `error-mapping.ts`), in the route's order of work:
 *
 * - an unknown, expired or used link (and a cross-site request): the uniform
 *   `404 { code: 'CATALOG_NOT_FOUND' }`;
 * - an enrolled user and no `factor`: `403 { code: 'AUTH_STEP_UP_REQUIRED' }`, nothing
 *   consumed;
 * - a policy or breach refusal: `400 { code: 'CATALOG_VALIDATION_FAILED', data: { issues:
 *   [{ path: '/newPassword', message: <rule> }] } }`;
 * - a wrong factor: the same `403 AUTH_STEP_UP_REQUIRED`;
 * - the limiter: `429 { code: 'AUTH_RATE_LIMITED' }` with `Retry-After`;
 * - success: `200 { completed: true }`, and the link is used.
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/auth/reset-password-page.tsx: the router's `resetPassword` page
 * // (`DEFAULT_PAGES.resetPassword`). No props. It reads the auth client from
 * // `useAuthClient()` and calls `authClient.confirmPasswordReset` directly, never through
 * // `useQuery` or `useMutation` (Q74), so neither the id, the token nor the password
 * // reaches the query or mutation cache.
 * export function ResetPasswordPage(): React.JSX.Element;
 * ```
 *
 * The fragment: the page takes it in the `useState` initializer of `ResetPasswordPage`,
 * outside the page's `Suspense` boundary (the `auth` namespace loads on demand, and a
 * render that suspends would drop the state): it reads `window.location.hash` and calls
 * `window.history.replaceState(window.history.state, '', pathname + search)`
 * synchronously, before anything is committed. TanStack Router's browser history wraps
 * `window.history.replaceState`, so the router's location follows. This file checks the
 * result, whatever the mechanism: the call that empties `location.hash` happens while
 * the page has rendered nothing, `location`, the router's location and the history state
 * hold neither value afterwards, and no request is made before the click.
 * `URLSearchParams` over the fragment, with `reset` exactly 22 and `token` exactly 43
 * base64url characters (`044` D2's strict parse): anything else is the invalid link, with
 * no request, because the server would answer a malformed body with a non-uniform `400`.
 *
 * The page (texts from the `auth` namespace under `resetPassword.`, English pinned here),
 * a `main` landmark with the heading "Reset your password" in every state:
 *
 * - Valid link: "New password" and "Confirm new password" (`type="password"`,
 *   `autocomplete="new-password"`) and a "Reset password" button. Empty fields block the
 *   submit with no request ("Enter a new password.", "Confirm the new password.", as the
 *   field's accessible description with `aria-invalid="true"`), as does a different
 *   confirmation ("The passwords do not match."). Both password fields are emptied after
 *   every request.
 * - `step_up_required`: the text "This account uses two-factor authentication. Enter a
 *   code to reset your password." and an "Authentication code" field
 *   (`autocomplete="one-time-code"`), with a "Use a backup code" button that switches it
 *   to a "Backup code" field (`autocomplete="one-time-code"`). The password fields stay,
 *   emptied, so the user enters the new password again with the code (D11's clearing),
 *   and a later policy failure has its field. An empty code blocks the submit ("Enter the
 *   code.", no request). The submit sends `factor: { kind: 'totp' | 'backup_code', code }`.
 *   A `step_up_required` answer to a request that carried a factor is an `alert` "The code
 *   is not valid.", with the code field emptied.
 * - `not_found` (`404`), and a missing or malformed fragment from the start: an `alert`
 *   "This link is invalid or has expired." and no form.
 * - A `/newPassword` issue: the new password field is marked, described by
 *   `auth:passwordPolicy.ruleFailed` with the rule name, or `auth:passwordPolicy.failed`
 *   for an unknown rule (the change page's texts).
 * - `rate_limited`: an `alert` "Too many attempts. Try again in N seconds." (`_one`:
 *   "Try again in 1 second.") from `Retry-After`, or "Too many attempts. Try again
 *   later." without it; the form stays.
 * - Any other failure: an `alert` "The password could not be reset. Try again later.";
 *   the form stays.
 * - Success: the form is replaced by "Your password has been reset." and a "Sign in"
 *   link to `/sign-in`.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show. The
 * router runs on a real browser history over jsdom's `window`, as in `main.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createAppRouter, type AppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

/** `044` D3: 16 random bytes and 32 random bytes, base64url (22 and 43 characters). */
const RESET_ID = 'rS3t-Id_0123456789abcd';
const RESET_TOKEN = 'Tk9_mQ2-vX7wLp4ZrB8nYc1HdJ6sKf3GuE5aW0oNiTx';
const FRAGMENT = `#reset=${RESET_ID}&token=${RESET_TOKEN}`;

const NEW_PASSWORD = 'Brand-New-Password-2026!';
const VALID_TOTP = '246810';
const WRONG_TOTP = '135791';
const VALID_BACKUP_CODE = 'Hq3vN-8tLwz';

/** Every value that must live only in the page's memory (D11, D15). */
const SECRETS = [RESET_ID, RESET_TOKEN, NEW_PASSWORD, VALID_TOTP, WRONG_TOTP, VALID_BACKUP_CODE];

const RESET_PATH = '/reset-password';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';

const TITLE = 'Reset your password';
const INVALID_LINK = 'This link is invalid or has expired.';
const FACTOR_REQUIRED =
  'This account uses two-factor authentication. Enter a code to reset your password.';
const INVALID_CODE = 'The code is not valid.';
const COMPLETED = 'Your password has been reset.';
const RESET_FAILED = 'The password could not be reset. Try again later.';
const RATE_LIMITED_LATER = 'Too many attempts. Try again later.';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The uniform 401 of D8, as the `/v1` catch-all and `GET /v1/me` send it. */
function contextRequired(): Response {
  return jsonResponse(401, {
    defined: false,
    code: 'CATALOG_CONTEXT_REQUIRED',
    status: 401,
    message: 'server-text: unauthorized',
  });
}

function notFound(): Response {
  return jsonResponse(404, {
    defined: false,
    code: 'CATALOG_NOT_FOUND',
    status: 404,
    message: 'server-text: The requested resource was not found',
    data: {},
  });
}

function stepUpRequired(): Response {
  return jsonResponse(403, {
    defined: false,
    code: 'AUTH_STEP_UP_REQUIRED',
    status: 403,
    message: 'server-text: step-up required',
  });
}

function policyRefused(rule: string): Response {
  return jsonResponse(400, {
    defined: false,
    code: 'CATALOG_VALIDATION_FAILED',
    status: 400,
    message: `server-text: The password does not meet the policy: ${rule}`,
    data: { issues: [{ path: '/newPassword', message: rule }] },
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
  /** `window.location.hash` when the request was made. */
  readonly hashAtRequest: string;
}

interface FakeServerOptions {
  /**
   * The link: `valid` (the default), unknown to the server, or expiring (or spent by
   * failed factors) once the first confirm has been answered.
   */
  readonly link?: 'valid' | 'unknown' | 'expires_after_first_answer';
  /** The user has TOTP and backup codes (`044` D6). */
  readonly enrolled?: boolean;
  /** Every confirm that reaches the policy check fails this rule. */
  readonly policyRule?: string;
  /** Every confirm answers this instead (the limiter, a server failure). */
  readonly answer?:
    { readonly kind: 'rate_limited'; readonly retryAfter?: string } | { readonly kind: 'internal' };
}

/**
 * A fake `fetch` playing the confirm route of `044` in its order of work: the link, the
 * missing factor, the policy, the factor, then the completion, which uses the link.
 * `GET /v1/me` has no session: the visitor is signed out.
 */
function createFakeServer(options: FakeServerOptions = {}) {
  let linkUsed = options.link === 'unknown';
  const calls: RecordedRequest[] = [];

  function confirm(input: Record<string, unknown>): Response {
    const { answer } = options;
    if (answer?.kind === 'rate_limited') {
      return jsonResponse(
        429,
        { defined: false, code: 'AUTH_RATE_LIMITED', status: 429, message: 'server-text: slow' },
        answer.retryAfter === undefined ? {} : { 'retry-after': answer.retryAfter },
      );
    }
    if (answer?.kind === 'internal') {
      return jsonResponse(500, {
        defined: false,
        code: 'INTERNAL_SERVER_ERROR',
        status: 500,
        message: 'server-text: internal failure',
      });
    }
    if (linkUsed || input.id !== RESET_ID || input.token !== RESET_TOKEN) return notFound();
    if (options.link === 'expires_after_first_answer') linkUsed = true;
    const factor = input.factor as { kind?: unknown; code?: unknown } | undefined;
    if (options.enrolled === true && factor === undefined) return stepUpRequired();
    if (options.policyRule !== undefined) return policyRefused(options.policyRule);
    if (options.enrolled === true) {
      const valid =
        (factor?.kind === 'totp' && factor.code === VALID_TOTP) ||
        (factor?.kind === 'backup_code' && factor.code === VALID_BACKUP_CODE);
      if (!valid) return stepUpRequired();
    }
    linkUsed = true;
    return jsonResponse(200, { completed: true });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body, hashAtRequest: window.location.hash });
    if (request.method === 'POST' && url.pathname === CONFIRM_PATH) {
      return confirm(JSON.parse(body) as Record<string, unknown>);
    }
    if (url.pathname.startsWith('/v1/')) return contextRequired();
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    calls,
    /** The bodies of the confirm calls, in order. */
    confirmBodies(): unknown[] {
      return calls
        .filter((call) => call.method === 'POST' && call.url.pathname === CONFIRM_PATH)
        .map((call) => JSON.parse(call.body) as unknown);
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

/** A page slot: its test id names it. */
function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `resetPassword`, which keeps the router's real page. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
};

/** One call of `window.history.replaceState` made once the app was created. */
interface ReplaceRecord {
  /** Whether any page content was in the document when the call was made. */
  readonly pageRendered: boolean;
  /** `window.location.hash` right after the call. */
  readonly hashAfter: string;
}

interface RenderedApp {
  readonly history: RouterHistory;
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
  readonly replaces: readonly ReplaceRecord[];
}

/** The browser history of the running test, destroyed after it. */
let activeHistory: RouterHistory | undefined;

/** Any content of the reset page, or of any page. */
function pageRendered(): boolean {
  return document.querySelector('main, h1, form, input, [role="alert"]') !== null;
}

/**
 * Opens `url` (path, query and fragment) in jsdom's window and renders the whole app on
 * a browser history, as `main.tsx` does (session gate, shell and providers).
 */
async function renderApp(
  url: string,
  server: FakeServer,
  options: { readonly authNamespaceLoaded?: boolean } = {},
): Promise<RenderedApp> {
  window.history.replaceState(null, '', url);
  const history = createBrowserHistory();
  activeHistory = history;
  // The router's history has wrapped `replaceState`; record every later call over it.
  const replaceState = window.history.replaceState.bind(window.history);
  const replaces: ReplaceRecord[] = [];
  vi.spyOn(window.history, 'replaceState').mockImplementation((data, unused, target) => {
    const rendered = pageRendered();
    replaceState(data, unused, target);
    replaces.push({ pageRendered: rendered, hashAfter: window.location.hash });
  });
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
  // Loaded up front, the page renders without suspending, so its first render commits.
  if (options.authNamespaceLoaded === true) await i18n.loadNamespaces('auth');
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthClientProvider client={authClient}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { history, router, queryClient, replaces };
}

/** Waits for the reset page and returns its `main` landmark. */
async function resetPage(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The reset heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Waits for the reset form and returns its controls. */
async function resetForm() {
  const main = await resetPage();
  return {
    main,
    next: await within(main).findByLabelText('New password'),
    confirmation: within(main).getByLabelText('Confirm new password'),
    submit: within(main).getByRole('button', { name: 'Reset password' }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function fill(field: HTMLElement, user: User, value: string): Promise<void> {
  await user.clear(field);
  if (value !== '') await user.type(field, value);
}

/** Fills the form (and the code field when given) and clicks "Reset password". */
async function submitReset(
  user: User,
  values: { next: string; confirmation?: string; code?: { label: string; value: string } },
): Promise<void> {
  const form = await resetForm();
  await fill(form.next, user, values.next);
  await fill(form.confirmation, user, values.confirmation ?? values.next);
  if (values.code !== undefined) {
    await fill(within(form.main).getByLabelText(values.code.label), user, values.code.value);
  }
  await user.click(form.submit);
}

/** Both password fields are empty. */
async function expectPasswordFieldsEmpty(): Promise<void> {
  const form = await resetForm();
  await waitFor(() => {
    expect(form.next).toHaveValue('');
  });
  expect(form.confirmation).toHaveValue('');
}

/** The uniform invalid-link state: the message, and no form left to submit. */
async function expectInvalidLink(): Promise<void> {
  const main = await resetPage();
  expect(await within(main).findByRole('alert')).toHaveTextContent(INVALID_LINK);
  expect(within(main).queryByLabelText('New password')).not.toBeInTheDocument();
  expect(within(main).queryByLabelText('Confirm new password')).not.toBeInTheDocument();
  expect(within(main).queryByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
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

/** Every key and value the query and mutation caches hold. */
function cacheText(queryClient: QueryClient): string {
  const queries = queryClient
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify({ key: query.queryKey, data: query.state.data }));
  const mutations = queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) =>
      JSON.stringify({
        key: mutation.options.mutationKey,
        variables: mutation.state.variables,
        data: mutation.state.data,
        context: mutation.state.context,
      }),
    );
  return [...queries, ...mutations].join('\n');
}

/** The address, the router's location and the history state hold no fragment and no value. */
function expectAddressClean(app: RenderedApp): void {
  expect(window.location.hash).toBe('');
  expect(window.location.pathname).toBe(RESET_PATH);
  expect(window.location.href).not.toContain('#');
  expect(app.history.location.hash).toBe('');
  expect(app.router.state.location.hash).toBe('');
  const places: Record<string, string> = {
    'window location': window.location.href,
    'window history state': JSON.stringify(window.history.state),
    'history location': `${app.history.location.href}\n${JSON.stringify(app.history.location.state)}`,
    'router location': `${app.router.state.location.href}\n${JSON.stringify(app.router.state.location.state)}`,
  };
  for (const [place, text] of Object.entries(places)) {
    for (const secret of [RESET_ID, RESET_TOKEN]) {
      expect(text.includes(secret), `${place} holds ${secret}`).toBe(false);
    }
  }
}

/** The page never read the session (Q68) and every request went to the page's origin. */
function expectOnlyConfirmCalls(server: FakeServer): void {
  for (const call of server.calls) {
    expect(call.url.origin).toBe(window.location.origin);
    expect(`${call.method} ${call.url.pathname}`).toBe(`POST ${CONFIRM_PATH}`);
    expect(call.url.href).not.toContain(RESET_TOKEN);
  }
}

function expectNoServerText(): void {
  expect(documentSnapshot()).not.toContain('server-text');
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  // First the spies (back to the router's wrappers), then the history (back to jsdom's).
  vi.restoreAllMocks();
  activeHistory?.destroy();
  activeHistory = undefined;
  window.history.replaceState(null, '', '/');
});

describe('The reset fragment is stripped before any request', () => {
  it('GIVEN a valid reset link, WHEN a user opens it, THEN the address shows /reset-password with no fragment before the page makes any request, and no request carries the token until the user submits', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    const form = await resetForm();
    expectAddressClean(app);
    expect(server.calls).toEqual([]);

    // Typing is not a submit: still no request.
    await user.type(form.next, NEW_PASSWORD);
    await user.type(form.confirmation, NEW_PASSWORD);
    expect(server.calls).toEqual([]);

    await user.click(form.submit);

    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies()).toEqual([
      { id: RESET_ID, token: RESET_TOKEN, newPassword: NEW_PASSWORD },
    ]);
    for (const call of server.calls) expect(call.hashAtRequest).toBe('');
    expectOnlyConfirmCalls(server);
    expectAddressClean(app);
    expectNoServerText();
  });

  it.each([
    ['with the auth texts still loading', false],
    ['with the auth texts already loaded', true],
  ])(
    'removes the fragment with history.replaceState before the page first renders, %s',
    async (_label, authNamespaceLoaded) => {
      const server = createFakeServer();
      const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server, { authNamespaceLoaded });

      await resetForm();

      const strip = app.replaces.find((record) => record.hashAfter === '');
      expect(strip, 'no replaceState call removed the fragment').toBeDefined();
      expect(strip?.pageRendered, 'the page rendered before the fragment was removed').toBe(false);
      // Nothing put the fragment back afterwards.
      expect(app.replaces.at(-1)?.hashAfter).toBe('');
      expectAddressClean(app);
      expect(server.calls).toEqual([]);
    },
  );

  it('keeps the link usable in memory after the fragment is gone', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await resetForm();
    expect(window.location.hash).toBe('');
    await submitReset(user, { next: NEW_PASSWORD });

    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies()).toHaveLength(1);
    expectAddressClean(app);
  });

  it('labels both password fields with the new-password purpose, never echoing them', async () => {
    const server = createFakeServer();
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    const form = await resetForm();
    for (const field of [form.next, form.confirmation]) {
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
  });

  it('refuses empty fields on the client, with no request and each error tied to its field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    const form = await resetForm();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.next).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.next).toHaveAccessibleDescription('Enter a new password.');
    expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    expect(form.confirmation).toHaveAccessibleDescription('Confirm the new password.');
    expect(server.calls).toEqual([]);
  });

  it('refuses a confirmation that differs from the new password, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD, confirmation: `${NEW_PASSWORD}x` });

    const form = await resetForm();
    await waitFor(() => {
      expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.confirmation).toHaveAccessibleDescription('The passwords do not match.');
    expect(server.calls).toEqual([]);
  });
});

describe('A reset for an MFA-enrolled user asks for the factor', () => {
  it('GIVEN a valid reset link for a user with TOTP, WHEN they submit a new password without a factor, THEN the page asks for a code, and submitting again with a valid code completes the reset', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true });
    const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    // The page asks for a code.
    const main = await resetPage();
    expect(await within(main).findByText(FACTOR_REQUIRED)).toBeInTheDocument();
    const code = within(main).getByLabelText('Authentication code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(server.confirmBodies()).toEqual([
      { id: RESET_ID, token: RESET_TOKEN, newPassword: NEW_PASSWORD },
    ]);
    await expectPasswordFieldsEmpty();
    // The page's own factor field, never the shell's step-up dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: VALID_TOTP },
    });

    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies()).toEqual([
      { id: RESET_ID, token: RESET_TOKEN, newPassword: NEW_PASSWORD },
      {
        id: RESET_ID,
        token: RESET_TOKEN,
        newPassword: NEW_PASSWORD,
        factor: { kind: 'totp', code: VALID_TOTP },
      },
    ]);
    expectOnlyConfirmCalls(server);
    expectAddressClean(app);
    expectNoServerText();
  });

  it('completes the reset with a backup code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    await user.click(await within(main).findByRole('button', { name: 'Use a backup code' }));
    const backup = within(main).getByLabelText('Backup code');
    expect(backup).toHaveAttribute('autocomplete', 'one-time-code');

    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Backup code', value: VALID_BACKUP_CODE },
    });

    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies().at(-1)).toEqual({
      id: RESET_ID,
      token: RESET_TOKEN,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'backup_code', code: VALID_BACKUP_CODE },
    });
  });

  it('refuses a wrong code with one message, empties the fields, and completes with the valid one', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    await within(main).findByLabelText('Authentication code');
    // Asking for the factor is not a refusal.
    expect(within(main).queryByText(INVALID_CODE)).not.toBeInTheDocument();

    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: WRONG_TOTP },
    });

    expect(await within(main).findByRole('alert')).toHaveTextContent(INVALID_CODE);
    await waitFor(() => {
      expect(within(main).getByLabelText('Authentication code')).toHaveValue('');
    });
    await expectPasswordFieldsEmpty();
    expect(server.confirmBodies()).toHaveLength(2);
    expect(server.confirmBodies()[1]).toEqual({
      id: RESET_ID,
      token: RESET_TOKEN,
      newPassword: NEW_PASSWORD,
      factor: { kind: 'totp', code: WRONG_TOTP },
    });

    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: VALID_TOTP },
    });

    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies()).toHaveLength(3);
    expectNoServerText();
  });

  it('refuses an empty code on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    const code = await within(main).findByLabelText('Authentication code');

    await submitReset(user, { next: NEW_PASSWORD });

    await waitFor(() => {
      expect(code).toHaveAttribute('aria-invalid', 'true');
    });
    expect(code).toHaveAccessibleDescription('Enter the code.');
    expect(server.confirmBodies()).toHaveLength(1);
  });
});

describe('a missing or malformed fragment', () => {
  it('shows the uniform invalid-link message, with no form and no request, for a link with no fragment', async () => {
    const server = createFakeServer();
    const app = await renderApp(RESET_PATH, server);

    await expectInvalidLink();
    await waitFor(() => {
      expect(app.router.state.status).toBe('idle');
    });
    expect(window.location.pathname).toBe(RESET_PATH);
    expect(server.calls).toEqual([]);
  });

  it.each([
    ['no token', `#reset=${RESET_ID}`],
    ['no id', `#token=${RESET_TOKEN}`],
    ['empty values', '#reset=&token='],
    ['a short id', `#reset=${RESET_ID.slice(1)}&token=${RESET_TOKEN}`],
    ['a long token', `#reset=${RESET_ID}&token=${RESET_TOKEN}A`],
    ['a token that is not base64url', `#reset=${RESET_ID}&token=${RESET_TOKEN.slice(1)}*`],
    ['an invitation fragment', `#invitation=${RESET_ID}&token=${RESET_TOKEN}`],
  ])(
    'shows the same message for a fragment with %s, removes it, and makes no request',
    async (_label, fragment) => {
      const server = createFakeServer();
      await renderApp(`${RESET_PATH}${fragment}`, server);

      await expectInvalidLink();
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe(RESET_PATH);
      expect(server.calls).toEqual([]);
    },
  );
});

describe('An invalid link shows the uniform message', () => {
  it('WHEN a visitor opens /reset-password with an unknown token, THEN after they submit, the page shows the uniform invalid-or-expired message', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ link: 'unknown' });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    await expectInvalidLink();
    expect(server.confirmBodies()).toHaveLength(1);
    expect(screen.queryByText(COMPLETED)).not.toBeInTheDocument();
    expectNoServerText();
  });

  it('shows the same message when the link stops being valid on the factor step', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true, link: 'expires_after_first_answer' });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    await within(main).findByLabelText('Authentication code');
    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: VALID_TOTP },
    });

    await expectInvalidLink();
    expect(within(main).queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(server.confirmBodies()).toHaveLength(2);
    expectNoServerText();
  });
});

describe('the other answers of the confirm route', () => {
  const RULE_NAMES = {
    length: 'Length',
    uppercase: 'Uppercase letter',
    lowercase: 'Lowercase letter',
    digit: 'Digit',
    symbol: 'Symbol',
    character: 'Allowed characters',
    denylist: 'Not a common password',
    breached: 'Not a known breached password',
  } as const;

  it.each(Object.entries(RULE_NAMES))(
    'shows only the localized name of the failed rule %s on the new password field',
    async (rule, name) => {
      const user = userEvent.setup();
      const server = createFakeServer({ policyRule: rule });
      await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

      await submitReset(user, { next: NEW_PASSWORD });

      const form = await resetForm();
      await waitFor(() => {
        expect(form.next).toHaveAttribute('aria-invalid', 'true');
      });
      expect(form.next).toHaveAccessibleDescription(
        `The new password does not meet this rule: ${name}.`,
      );
      await expectPasswordFieldsEmpty();
      expectNoServerText();
    },
  );

  it('shows the generic policy message for an unknown rule', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ policyRule: 'server-text-rule' });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    const form = await resetForm();
    await waitFor(() => {
      expect(form.next).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.next).toHaveAccessibleDescription(
      'The new password does not meet the password policy.',
    );
    expectNoServerText();
  });

  it('shows a policy failure on the factor step, keeping the factor field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true, policyRule: 'length' });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    await within(main).findByLabelText('Authentication code');
    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: VALID_TOTP },
    });

    const form = await resetForm();
    await waitFor(() => {
      expect(form.next).toHaveAccessibleDescription(
        'The new password does not meet this rule: Length.',
      );
    });
    expect(within(main).getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it.each([
    ['30', 'Too many attempts. Try again in 30 seconds.'],
    ['1', 'Too many attempts. Try again in 1 second.'],
  ])('shows when to try again from Retry-After %s, keeping the form', async (retryAfter, text) => {
    const user = userEvent.setup();
    const server = createFakeServer({ answer: { kind: 'rate_limited', retryAfter } });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    const form = await resetForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(text);
    expect(form.submit).toBeInTheDocument();
    expectNoServerText();
  });

  it('asks to try again later without a usable Retry-After', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ answer: { kind: 'rate_limited' } });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    const form = await resetForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(RATE_LIMITED_LATER);
  });

  it('shows one generic alert for a server failure, keeping the form', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ answer: { kind: 'internal' } });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    const form = await resetForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(RESET_FAILED);
    expect(form.submit).toBeInTheDocument();
    await expectPasswordFieldsEmpty();
    expectNoServerText();
  });

  it('replaces the form with a link to /sign-in on success', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });

    const main = await resetPage();
    expect(await within(main).findByText(COMPLETED)).toBeInTheDocument();
    expect(within(main).queryByLabelText('New password')).not.toBeInTheDocument();
    const signIn = within(main).getByRole('link', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', '/sign-in');

    await user.click(signIn);

    expect(await screen.findByTestId('page-signIn')).toBeInTheDocument();
    expect(app.history.location.pathname).toBe('/sign-in');
    expectOnlyConfirmCalls(server);
  });
});

describe('storage left empty', () => {
  it('keeps the id, the token, the password and the codes out of storage, the URL, the history state and the query cache', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ enrolled: true });
    const app = await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    const main = await resetPage();
    await within(main).findByLabelText('Authentication code');
    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: WRONG_TOTP },
    });
    await within(main).findByRole('alert');
    await submitReset(user, {
      next: NEW_PASSWORD,
      code: { label: 'Authentication code', value: VALID_TOTP },
    });
    expect(await screen.findByText(COMPLETED)).toBeInTheDocument();
    expect(server.confirmBodies()).toHaveLength(3);

    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
    const places: Record<string, string> = {
      storage: storageText(),
      'window location': `${window.location.href}\n${JSON.stringify(window.history.state)}`,
      'history location': `${app.history.location.href}\n${JSON.stringify(app.history.location.state)}`,
      'router location': `${app.router.state.location.href}\n${JSON.stringify(app.router.state.location.state)}`,
      'query cache': cacheText(app.queryClient),
      document: documentSnapshot(),
    };
    for (const [place, text] of Object.entries(places)) {
      for (const secret of SECRETS) {
        expect(text.includes(secret), `${place} holds ${secret}`).toBe(false);
      }
    }
    expectAddressClean(app);
  });

  it('leaves storage empty for an invalid link too', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ link: 'unknown' });
    await renderApp(`${RESET_PATH}${FRAGMENT}`, server);

    await submitReset(user, { next: NEW_PASSWORD });
    await expectInvalidLink();

    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });
});
