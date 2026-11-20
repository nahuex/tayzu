/**
 * The temporary-password change and the expired page (task 6.3, design D11, D12, D15,
 * D16 and Q55, Q63, Q68, Q69, Q71; spec "Users can complete the temporary-password and
 * MFA gates", scenario "A temporary password is changed").
 *
 * D11 (`/change-password`): "(gate `password_change_required`): current (temporary)
 * password, new password and confirmation, `POST /api/auth/change-password` with
 * `revokeOtherSessions: true`; a policy failure shows the localized name of the failed
 * rule, which is all the API returns. `password_expired` shows a page that tells the
 * user to ask an administrator, with sign-out."
 * D11: "Password fields use `autocomplete="current-password"` or `"new-password"`, are
 * never echoed, stored or logged, and are cleared from form state after a submit."
 * Spec: "The change-password page MUST change a temporary password with the current and
 * a new password and revoke the user's other sessions, and MUST show only the name of a
 * failed password rule. An expired temporary password MUST show that an administrator
 * must act, with sign-out."
 * Scenario "A temporary password is changed": GIVEN a user under a temporary password,
 * WHEN they enter the temporary password and a policy-compliant new password, THEN the
 * gate clears and they reach the page they asked for.
 * D12: a gate sends every route "except its own page and sign-out" to its page; sign-out
 * "posts `/api/auth/sign-out`, clears the query cache and the stores, and navigates to
 * `/sign-in`" (Q69: whatever `/api/auth/sign-out` answers).
 * Q63: Better Auth's `/change-password` policy answers map to a `/newPassword` rule.
 *
 * The server's answers (`packages/auth/src/auth.ts` and Better Auth 1.7):
 *
 * - policy: `400 { code: 'PASSWORD_POLICY_VIOLATION', message, rule }`, `rule` one of
 *   `length`, `uppercase`, `lowercase`, `digit`, `symbol`, `character`, `denylist`;
 * - breach check (`haveIBeenPwned` at hash time): `400 { code: 'PASSWORD_COMPROMISED',
 *   message }`;
 * - wrong current password: `400 { code: 'INVALID_PASSWORD', message: 'Invalid password' }`;
 * - success: `200 { token, user }`, and the temporary-password marker is gone, so
 *   `GET /v1/me` then reports `gate: 'none'`.
 *
 * Assumed API (the contract of this task):
 *
 * ```ts
 * // src/auth/change-password-page.tsx: the real page of the router's `changePassword`
 * // slot. No props: it reads `returnTo` from the `/change-password` route search (passed
 * // through `safeReturnPath`, so `/` when absent or hostile), the auth client from
 * // `useAuthClient()` and the query client from `useQueryClient()`.
 * export function ChangePasswordPage(): React.JSX.Element;
 *
 * // src/auth/password-expired-page.tsx: the router's `passwordExpired` page.
 * export function PasswordExpiredPage(): React.JSX.Element;
 *
 * // src/app/router.tsx: `DEFAULT_PAGES.changePassword` is `ChangePasswordPage` and
 * // `DEFAULT_PAGES.passwordExpired` is `PasswordExpiredPage`; `/change-password` takes a
 * // `returnTo` search param. The session gate's redirect to `/change-password` carries
 * // the requested path and query as `returnTo`, so the user reaches the page they asked
 * // for once the gate clears.
 *
 * // src/api/errors.ts, `apiErrorFromResponse`:
 * //   400 PASSWORD_POLICY_VIOLATION, rule r (known) ->
 * //       { kind: 'validation', issues: [{ path: '/newPassword', rule: r }] }
 * //   400 PASSWORD_POLICY_VIOLATION, unknown or missing rule ->
 * //       { kind: 'validation', issues: [{ path: '/newPassword' }] }
 * //   400 PASSWORD_COMPROMISED ->
 * //       { kind: 'validation', issues: [{ path: '/newPassword', rule: 'breached' }] }
 * //   400 INVALID_PASSWORD -> { kind: 'validation', issues: [{ path: '/currentPassword' }] }
 * ```
 *
 * The change page (texts from the `auth` namespace, English pinned here):
 *
 * - A `main` landmark with the heading `auth:changePassword.title` ("Change your
 *   password").
 * - Fields "Current password" (`type="password"`, `autocomplete="current-password"`),
 *   "New password" and "Confirm new password" (both `type="password"`,
 *   `autocomplete="new-password"`), a submit button "Change password", and a "Sign out"
 *   button (`common:signOut`).
 * - An empty field blocks the submit with no request, marked `aria-invalid="true"` with
 *   its error as its accessible description: "Enter your current password.", "Enter a new
 *   password.", "Confirm the new password.". A confirmation different from the new
 *   password blocks the submit the same way: "The passwords do not match." on the
 *   confirmation field.
 * - Every password field is emptied after every request.
 * - A policy failure marks the new password field, whose accessible description is
 *   "The new password does not meet this rule: <rule name>." with the rule names of
 *   `auth:passwordPolicy.rules.<rule>`: length "Length", uppercase "Uppercase letter",
 *   lowercase "Lowercase letter", digit "Digit", symbol "Symbol", character "Allowed
 *   characters", denylist "Not a common password", breached "Not a known breached
 *   password". A `/newPassword` issue with no known rule: "The new password does not
 *   meet the password policy.".
 * - A wrong current password marks the current password field: "The current password is
 *   incorrect.".
 * - Any other failure shows an `alert`: "The password could not be changed. Try again
 *   later.".
 * - On success the page drops the cached session (so the gate reads `GET /v1/me` again)
 *   and navigates to `returnTo`.
 *
 * The expired page: a `main` landmark with the heading `auth:passwordExpired.title`
 * ("Your temporary password has expired"), the text `auth:passwordExpired.description`
 * ("Ask an administrator to set a new temporary password, then sign in again."), no
 * password field, and a "Sign out" button that posts `/api/auth/sign-out`, clears the
 * query cache and goes to `/sign-in`, whatever the server answers.
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
import { SESSION_QUERY_KEY, createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

type Gate = 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: 'owner' | 'admin' | 'member';
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: Gate;
}

function meWith(gate: Gate): MeBody {
  return {
    user: { id: 'u_tara', name: 'Tara Torres', email: 'tara@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    role: 'member',
    signInMethod: 'password',
    mfa: { enrolled: false },
    gate,
  };
}

const TEMPORARY_PASSWORD = 'Temp-Password-0001-xyz';
const NEW_PASSWORD = 'Brand-New-Password-2026!';

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

/** What `/api/auth/change-password` answers when the current password is right. */
type ChangeAnswer =
  | { readonly kind: 'success' }
  | { readonly kind: 'policy'; readonly rule: string | undefined }
  | { readonly kind: 'compromised' }
  | { readonly kind: 'internal' };

interface FakeServerOptions {
  readonly gate: Gate;
  readonly changeAnswer?: ChangeAnswer;
  /** The status `/api/auth/sign-out` answers; 200 by default. */
  readonly signOutStatus?: number;
}

/**
 * A fake `fetch` playing Better Auth and the API for one user signed in under a
 * temporary password. A successful change clears the marker: the gate becomes `none`.
 */
function createFakeServer(options: FakeServerOptions) {
  let gate: Gate | undefined = options.gate;
  const calls: RecordedRequest[] = [];

  function changePassword(input: Record<string, unknown>): Response {
    if (input.currentPassword !== TEMPORARY_PASSWORD) {
      return jsonResponse(400, {
        code: 'INVALID_PASSWORD',
        message: 'server-text: Invalid password',
      });
    }
    const answer = options.changeAnswer ?? { kind: 'success' };
    switch (answer.kind) {
      case 'policy':
        return jsonResponse(400, {
          code: 'PASSWORD_POLICY_VIOLATION',
          message: 'server-text: PASSWORD_POLICY_VIOLATION',
          ...(answer.rule === undefined ? {} : { rule: answer.rule }),
        });
      case 'compromised':
        return jsonResponse(400, {
          code: 'PASSWORD_COMPROMISED',
          message:
            'server-text: The password you entered has been compromised. Please choose a different password.',
        });
      case 'internal':
        return jsonResponse(500, { code: 'INTERNAL', message: 'server-text: internal failure' });
      case 'success':
        gate = 'none';
        return jsonResponse(200, { token: null, user: meWith('none').user });
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body });
    const { pathname } = url;
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST' && pathname === '/api/auth/change-password') {
      if (gate === undefined) {
        return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'server-text: no session' });
      }
      return changePassword(input);
    }
    if (request.method === 'POST' && pathname === '/api/auth/sign-out') {
      const status = options.signOutStatus ?? 200;
      if (status !== 200) {
        return jsonResponse(status, { code: 'INTERNAL', message: 'server-text: sign-out failed' });
      }
      gate = undefined;
      return jsonResponse(200, { success: true });
    }

    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (gate === undefined) return contextRequired();
    if (request.method === 'GET' && pathname === '/v1/me') return jsonResponse(200, meWith(gate));
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
function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `changePassword` and `passwordExpired`, which keep the real pages. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
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

/** The English rule names, keyed by the rule id of `PasswordRule`. */
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

type RuleId = keyof typeof RULE_NAMES;

const POLICY_RULES = [
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'symbol',
  'character',
  'denylist',
] as const satisfies readonly RuleId[];

function ruleFailure(rule: RuleId): string {
  return `The new password does not meet this rule: ${RULE_NAMES[rule]}.`;
}

const GENERIC_POLICY_FAILURE = 'The new password does not meet the password policy.';
const WRONG_CURRENT_PASSWORD = 'The current password is incorrect.';
const CHANGE_FAILED = 'The password could not be changed. Try again later.';

/** Waits for the change-password page and returns its controls. */
async function changePasswordForm() {
  // The heading first: after a navigation the previous page's `main` can still be mounted.
  const heading = await screen.findByRole('heading', { name: 'Change your password' });
  const main = heading.closest('main');
  if (main === null) throw new Error('The change-password heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return {
    current: within(main).getByLabelText('Current password'),
    next: within(main).getByLabelText('New password'),
    confirmation: within(main).getByLabelText('Confirm new password'),
    submit: within(main).getByRole('button', { name: 'Change password' }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function submitChange(
  user: User,
  values: { current: string; next: string; confirmation?: string },
): Promise<void> {
  const form = await changePasswordForm();
  await user.clear(form.current);
  if (values.current !== '') await user.type(form.current, values.current);
  await user.clear(form.next);
  if (values.next !== '') await user.type(form.next, values.next);
  await user.clear(form.confirmation);
  const confirmation = values.confirmation ?? values.next;
  if (confirmation !== '') await user.type(form.confirmation, confirmation);
  await user.click(form.submit);
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

function expectNoSecretsOrServerText(history: RouterHistory): void {
  const visible = documentSnapshot();
  expect(visible).not.toContain('server-text');
  for (const secret of [TEMPORARY_PASSWORD, NEW_PASSWORD]) {
    expect(visible).not.toContain(secret);
    expect(storageText()).not.toContain(secret);
    expect(locationOf(history)).not.toContain(secret);
  }
}

/** Every password field of the change form is empty. */
async function expectPasswordFieldsEmpty(): Promise<void> {
  const form = await changePasswordForm();
  await waitFor(() => {
    expect(form.current).toHaveValue('');
  });
  expect(form.next).toHaveValue('');
  expect(form.confirmation).toHaveValue('');
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

describe('A temporary password is changed', () => {
  it('GIVEN a user under a temporary password, WHEN they enter it and a policy-compliant new password, THEN the gate clears and they reach the page they asked for', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const { history } = await renderApp('/catalog/service?sort=title', server);

    // The gate holds the user on the change-password page.
    await changePasswordForm();
    expect(history.location.pathname).toBe('/change-password');
    expect(screen.queryByTestId('page-catalogTable')).not.toBeInTheDocument();

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    expect(locationOf(history)).toBe('/catalog/service?sort=title');
    expect(screen.queryByRole('heading', { name: 'Change your password' })).not.toBeInTheDocument();

    const changes = server.callsTo('POST', '/api/auth/change-password');
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(JSON.parse(change?.call.body ?? '')).toEqual({
      currentPassword: TEMPORARY_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    // The gate cleared because the session was read again after the change.
    const meAfter = server
      .callsTo('GET', '/v1/me')
      .filter(({ index }) => index > (change?.index ?? Infinity));
    expect(meAfter.length).toBeGreaterThan(0);
    expectNoSecretsOrServerText(history);
  });

  it('returns to the returnTo of /change-password, query included', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const returnTo = '/catalog/service?sort=title';
    const { history } = await renderApp(
      `/change-password?returnTo=${encodeURIComponent(returnTo)}`,
      server,
    );

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    expect(locationOf(history)).toBe(returnTo);
  });

  it('goes to the home page without a returnTo', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const { history } = await renderApp('/change-password', server);

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(history)).toBe('/');
  });

  it('ignores an external returnTo and goes to the home page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const { history } = await renderApp(
      `/change-password?returnTo=${encodeURIComponent('https://evil.example/phish')}`,
      server,
    );

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(history)).toBe('/');
  });
});

describe('the change-password form', () => {
  it('labels the three password fields with their autocomplete purpose, never echoing them', async () => {
    const server = createFakeServer({ gate: 'password_change_required' });
    await renderApp('/change-password', server);

    const form = await changePasswordForm();
    expect(form.current).toHaveAttribute('type', 'password');
    expect(form.current).toHaveAttribute('autocomplete', 'current-password');
    expect(form.next).toHaveAttribute('type', 'password');
    expect(form.next).toHaveAttribute('autocomplete', 'new-password');
    expect(form.confirmation).toHaveAttribute('type', 'password');
    expect(form.confirmation).toHaveAttribute('autocomplete', 'new-password');
  });

  it('refuses empty fields on the client, with no request and each error tied to its field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    await renderApp('/change-password', server);

    const form = await changePasswordForm();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.current).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.current).toHaveAccessibleDescription('Enter your current password.');
    expect(form.next).toHaveAttribute('aria-invalid', 'true');
    expect(form.next).toHaveAccessibleDescription('Enter a new password.');
    expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    expect(form.confirmation).toHaveAccessibleDescription('Confirm the new password.');
    expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(0);
  });

  it('refuses a confirmation that differs from the new password, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    await renderApp('/change-password', server);

    await submitChange(user, {
      current: TEMPORARY_PASSWORD,
      next: NEW_PASSWORD,
      confirmation: `${NEW_PASSWORD}-typo`,
    });

    const form = await changePasswordForm();
    await waitFor(() => {
      expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.confirmation).toHaveAccessibleDescription('The passwords do not match.');
    expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(0);
  });

  it('offers sign-out, which reaches the sign-in page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const { history, queryClient } = await renderApp('/change-password', server);
    await changePasswordForm();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByTestId('page-signIn')).toBeInTheDocument();
    expect(locationOf(history)).toBe('/sign-in');
    expect(server.callsTo('POST', '/api/auth/sign-out')).toHaveLength(1);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });
});

describe('a policy failure shows only the localized name of the failed rule', () => {
  it.each(POLICY_RULES)(
    'shows only the rule name for PASSWORD_POLICY_VIOLATION with rule %s',
    async (rule) => {
      const user = userEvent.setup();
      const server = createFakeServer({
        gate: 'password_change_required',
        changeAnswer: { kind: 'policy', rule },
      });
      const { history } = await renderApp('/change-password', server);

      await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

      const form = await changePasswordForm();
      await waitFor(() => {
        expect(form.next).toHaveAttribute('aria-invalid', 'true');
      });
      expect(form.next).toHaveAccessibleDescription(ruleFailure(rule));
      const text = document.body.textContent;
      for (const [other, name] of Object.entries(RULE_NAMES)) {
        if (other !== rule) expect(text).not.toContain(name);
      }
      expect(form.current).not.toHaveAttribute('aria-invalid', 'true');
      expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(1);
      // Still gated: no navigation, no re-read of the gate.
      expect(history.location.pathname).toBe('/change-password');
      await expectPasswordFieldsEmpty();
      expectNoSecretsOrServerText(history);
    },
  );

  it('shows the breached rule for PASSWORD_COMPROMISED', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      gate: 'password_change_required',
      changeAnswer: { kind: 'compromised' },
    });
    const { history } = await renderApp('/change-password', server);

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    const form = await changePasswordForm();
    await waitFor(() => {
      expect(form.next).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.next).toHaveAccessibleDescription(ruleFailure('breached'));
    expect(history.location.pathname).toBe('/change-password');
    await expectPasswordFieldsEmpty();
    expectNoSecretsOrServerText(history);
  });

  it.each([
    ['an unknown rule', 'no-such-rule'],
    ['no rule', undefined],
  ] as const)('shows the generic policy message for %s', async (_name, rule) => {
    const user = userEvent.setup();
    const server = createFakeServer({
      gate: 'password_change_required',
      changeAnswer: { kind: 'policy', rule },
    });
    const { history } = await renderApp('/change-password', server);

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    const form = await changePasswordForm();
    await waitFor(() => {
      expect(form.next).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.next).toHaveAccessibleDescription(GENERIC_POLICY_FAILURE);
    const text = document.body.textContent;
    for (const name of Object.values(RULE_NAMES)) expect(text).not.toContain(name);
    expect(text).not.toContain('no-such-rule');
    expectNoSecretsOrServerText(history);
  });

  it('shows the rule name in the chosen language', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-AR');
    const user = userEvent.setup();
    const server = createFakeServer({
      gate: 'password_change_required',
      changeAnswer: { kind: 'policy', rule: 'digit' },
    });
    const { history } = await renderApp('/change-password', server);

    // The Spanish page: its texts are not pinned here, so the fields are found by type.
    await waitFor(() => {
      expect(document.querySelectorAll('input[type="password"]')).toHaveLength(3);
    });
    const [current, next, confirmation] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    if (current === undefined || next === undefined || confirmation === undefined) {
      throw new Error('The change-password form has no three password fields');
    }
    await user.type(current, TEMPORARY_PASSWORD);
    await user.type(next, NEW_PASSWORD);
    await user.type(confirmation, NEW_PASSWORD);
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(next).toHaveAttribute('aria-invalid', 'true');
    });
    expect(next).toHaveAccessibleDescription(/\S/);
    expect(next).not.toHaveAccessibleDescription(ruleFailure('digit'));
    expect(document.body.textContent).not.toContain(RULE_NAMES.digit);
    expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(1);
    expectNoSecretsOrServerText(history);
  });
});

describe('a wrong current password', () => {
  it('marks the current password as incorrect, stays on the page and shows no server text', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'password_change_required' });
    const { history } = await renderApp('/change-password', server);

    await submitChange(user, { current: `${TEMPORARY_PASSWORD}-wrong`, next: NEW_PASSWORD });

    const form = await changePasswordForm();
    await waitFor(() => {
      expect(form.current).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.current).toHaveAccessibleDescription(WRONG_CURRENT_PASSWORD);
    expect(form.next).not.toHaveAttribute('aria-invalid', 'true');
    const text = document.body.textContent;
    for (const name of Object.values(RULE_NAMES)) expect(text).not.toContain(name);
    expect(text).not.toContain(CHANGE_FAILED);
    expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(1);
    expect(history.location.pathname).toBe('/change-password');
    await expectPasswordFieldsEmpty();
    expectNoSecretsOrServerText(history);
    expect(documentSnapshot()).not.toContain(`${TEMPORARY_PASSWORD}-wrong`);
  });

  it('tells a wrong current password apart from a server failure, which shows a generic alert', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      gate: 'password_change_required',
      changeAnswer: { kind: 'internal' },
    });
    const { history } = await renderApp('/change-password', server);

    await submitChange(user, { current: TEMPORARY_PASSWORD, next: NEW_PASSWORD });

    expect(await screen.findByRole('alert')).toHaveTextContent(CHANGE_FAILED);
    expect(document.body.textContent).not.toContain(WRONG_CURRENT_PASSWORD);
    expect(history.location.pathname).toBe('/change-password');
    await expectPasswordFieldsEmpty();
    expectNoSecretsOrServerText(history);
  });
});

describe('An expired temporary password', () => {
  it('tells the user to ask an administrator, with no password field and no change request', async () => {
    const server = createFakeServer({ gate: 'password_expired' });
    const { history } = await renderApp('/catalog/service', server);

    const heading = await screen.findByRole('heading', {
      name: 'Your temporary password has expired',
    });
    const main = heading.closest('main');
    if (main === null) throw new Error('The expired-page heading is not inside a main landmark');
    expect(main).toBe(screen.getByRole('main'));
    expect(main).toHaveTextContent(
      'Ask an administrator to set a new temporary password, then sign in again.',
    );
    expect(within(main).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'Change your password' })).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/change-password');
    expect(server.callsTo('POST', '/api/auth/change-password')).toHaveLength(0);
  });

  it.each([
    ['answers', 200],
    ['fails', 500],
  ] as const)(
    'signs out when the server %s: the cache is cleared and the page is /sign-in',
    async (_name, signOutStatus) => {
      const user = userEvent.setup();
      const server = createFakeServer({ gate: 'password_expired', signOutStatus });
      const { history, queryClient } = await renderApp('/change-password', server);
      await screen.findByRole('heading', { name: 'Your temporary password has expired' });
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();

      await user.click(screen.getByRole('button', { name: 'Sign out' }));

      expect(await screen.findByTestId('page-signIn')).toBeInTheDocument();
      expect(locationOf(history)).toBe('/sign-in');
      expect(server.callsTo('POST', '/api/auth/sign-out')).toHaveLength(1);
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
      expect(documentSnapshot()).not.toContain('server-text');
    },
  );
});
