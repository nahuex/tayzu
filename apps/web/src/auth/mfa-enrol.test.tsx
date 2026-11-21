/**
 * MFA enrolment and re-enrolment (task 6.4, design D10, D11, D12, D15, D16 and Q17,
 * Q69, Q71, Q73; spec "Users can complete the temporary-password and MFA gates",
 * scenario "MFA enrolment completes only with a valid code").
 *
 * D11 (`/mfa/enrol`): "(gate `mfa_enrolment_required`, and reachable from the user menu
 * when not enrolled): password re-entry, `POST /api/auth/two-factor/enable`, then the
 * TOTP URI as an inline SVG QR code and as the plain secret for manual entry, and the
 * backup codes shown once with a "I have saved them" confirmation, then a code verified
 * with `/two-factor/verify-totp`. The URI, secret and codes live only in component
 * state, never in the query cache, storage or the URL, and are dropped on leaving the
 * page. Re-enrolment after an MFA reset is the same page."
 * D11: "Password fields use `autocomplete="current-password"` [...], are never echoed,
 * stored or logged, and are cleared from form state after a submit."
 * Q17: "`qrcode.react`, rendered as inline SVG (no network, no `data:` image)."
 * D10: `style-src 'self' 'nonce-<n>'` and `img-src 'self'`, so the QR code must be an
 * inline `<svg>` with no `<style>` element and no `data:` image.
 * D15: "No token, password, TOTP secret, backup code [...] is ever stored."
 * Spec: "The MFA enrolment page MUST require the password, then show the TOTP secret as
 * a QR code and as text and the backup codes once, and MUST complete only after a valid
 * code. The secret and the backup codes MUST NOT be stored anywhere but the page's own
 * memory. Re-enrolment after an MFA reset MUST use the same page."
 * Scenario "MFA enrolment completes only with a valid code": GIVEN a user who must
 * enrol, WHEN they confirm their password, scan the code and enter a wrong code, then a
 * valid one, THEN the wrong code is refused, the valid one enrols the factor, and the
 * gate clears.
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/auth/mfa-enrol-page.tsx: the router's `mfaEnrol` page. It reads the route's
 * // validated `returnTo` (through `safeReturnPath`, so `/` when absent or hostile), the
 * // auth client from `useAuthClient()` and the query client from `useQueryClient()`.
 * // It calls `authClient.enableTwoFactor` and `authClient.verifyTotp` directly, never
 * // through `useQuery` or `useMutation`, so neither the password, the URI, the secret
 * // nor the codes ever reach the query or mutation cache.
 * export function MfaEnrolPage(): React.JSX.Element;
 *
 * // src/app/router.tsx: `DEFAULT_PAGES.mfaEnrol` is `MfaEnrolPage`; `/mfa/enrol` takes a
 * // `returnTo` search param, like `/change-password`. The session gate's redirect to
 * // `/mfa/enrol` carries the requested path and query as `returnTo` (Q73's pattern).
 *
 * // src/app/user-menu.tsx: when the session's `mfa.enrolled` is false, the menu offers a
 * // `menuitem` "Set up two-factor authentication" leading to `/mfa/enrol`; an enrolled
 * // user's menu does not.
 * ```
 *
 * The page (texts from the `auth` namespace, English pinned here), a `main` landmark
 * with the heading `auth:mfaEnrol.title` ("Set up two-factor authentication") and a
 * "Sign out" button (`common:signOut`) on every step:
 *
 * 1. Password: a "Password" field (`type="password"`, `autocomplete="current-password"`)
 *    and a "Continue" button. Empty: "Enter your password." as the field's accessible
 *    description, `aria-invalid="true"`, no request. Then `POST
 *    /api/auth/two-factor/enable` with `{ password }` only. A wrong password (`400
 *    INVALID_PASSWORD`) marks the field: "The password is incorrect."; any other failure
 *    is an `alert`: "Two-factor authentication could not be set up. Try again later.".
 *    The field is emptied after every request.
 * 2. Scan and save: the TOTP URI as an inline `<svg role="img">` QR code (qrcode.react's
 *    `QRCodeSVG` with `value` the URI) named "QR code for your authenticator app", the
 *    `secret` parameter of the URI as text (one element whose whole text is the secret),
 *    and the backup codes as a `list` named "Backup codes", one `listitem` per code in
 *    the server's order. A checkbox "I have saved my backup codes" and a "Continue"
 *    button; without the checkbox the step does not advance.
 * 3. Verify: an "Authentication code" field (`autocomplete="one-time-code"`,
 *    `inputmode="numeric"`) and a "Verify" button. Empty: "Enter the code.", no request.
 *    Then `POST /api/auth/two-factor/verify-totp` with `{ code }` only. A refused code
 *    (Better Auth answers `401 INVALID_CODE`, which the error model reads as
 *    `unauthenticated`: the page must not take it for a lost session) is an `alert`
 *    "The code is not valid.", stays on this step with the field emptied, and never
 *    shows the backup codes again. On success the page removes the cached session (Q71)
 *    and goes to `returnTo`.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QRCodeSVG } from 'qrcode.react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { SESSION_QUERY_KEY, createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { createThemeStore } from '../state/theme.js';

type Gate = 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';
type Role = 'owner' | 'admin' | 'member';

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: Role;
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: Gate;
}

function meWith(state: { gate: Gate; enrolled: boolean; role: Role }): MeBody {
  return {
    user: { id: 'u_tara', name: 'Tara Torres', email: 'tara@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    role: state.role,
    signInMethod: 'password',
    mfa: { enrolled: state.enrolled },
    gate: state.gate,
  };
}

const PASSWORD = 'Account-Password-2026!';
/** A Base32 secret as Better Auth's `createOTP(...).url(...)` writes it into the URI. */
const SECRET = 'KRSXG5DTMVRXEZLUOBQWO2LMMNXWIZJAMFXGIIDTMVRXEZLUOBQXGZ3H';
const TOTP_URI = `otpauth://totp/Tayzu:tara%40example.com?secret=${SECRET}&issuer=Tayzu&digits=6&period=30`;
const BACKUP_CODES = [
  'Hq3vN-8tLwz',
  'pR7xK-2mBcd',
  'Zt5yW-9gFhj',
  'mN4qL-6vXkp',
  'Bw8eT-1rYus',
  'Kc2jH-7nDqa',
  'Yf6uP-3sGzm',
  'Lx9oR-5bVwe',
  'Ud1iE-4cJtn',
  'Ga7kS-0hMyr',
] as const;
const VALID_CODE = '246810';
const WRONG_CODE = '135791';

/** Every value that must live only in the page's memory (D11, D15). */
const SECRETS = [TOTP_URI, encodeURIComponent(TOTP_URI), SECRET, PASSWORD, ...BACKUP_CODES];

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

interface FakeServerOptions {
  readonly gate: Gate;
  readonly role?: Role;
  readonly enrolled?: boolean;
  /** What a right password gets from `/two-factor/enable`; success by default. */
  readonly enableAnswer?: 'success' | 'internal';
}

/**
 * A fake `fetch` playing Better Auth (`better-auth@1.7.7`'s two-factor plugin) and the
 * API for one signed-in user. `/two-factor/enable` answers `400 INVALID_PASSWORD` to a
 * wrong password and `{ totpURI, backupCodes }` otherwise; `/two-factor/verify-totp`
 * answers `401 INVALID_CODE` to a wrong code and, for the valid one after an enable,
 * enrols the factor and clears the re-enrolment marker: the gate becomes `none`.
 */
function createFakeServer(options: FakeServerOptions) {
  let session: { gate: Gate; enrolled: boolean; role: Role } | undefined = {
    gate: options.gate,
    enrolled: options.enrolled ?? false,
    role: options.role ?? 'admin',
  };
  let enrolmentStarted = false;
  const calls: RecordedRequest[] = [];

  function enable(input: Record<string, unknown>): Response {
    if (input.password !== PASSWORD) {
      return jsonResponse(400, {
        code: 'INVALID_PASSWORD',
        message: 'server-text: Invalid password',
      });
    }
    if (options.enableAnswer === 'internal') {
      return jsonResponse(500, { code: 'INTERNAL', message: 'server-text: internal failure' });
    }
    enrolmentStarted = true;
    return jsonResponse(200, { totpURI: TOTP_URI, backupCodes: BACKUP_CODES });
  }

  function verifyTotp(input: Record<string, unknown>): Response {
    if (!enrolmentStarted) {
      return jsonResponse(400, {
        code: 'TOTP_NOT_ENABLED',
        message: 'server-text: TOTP not enabled',
      });
    }
    if (input.code !== VALID_CODE) {
      return jsonResponse(401, { code: 'INVALID_CODE', message: 'server-text: Invalid code' });
    }
    if (session !== undefined) session = { ...session, gate: 'none', enrolled: true };
    enrolmentStarted = false;
    return jsonResponse(200, { token: 'session-token', user: meWith(session ?? DEFAULT).user });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body });
    const { pathname } = url;
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST' && pathname === '/api/auth/sign-out') {
      session = undefined;
      enrolmentStarted = false;
      return jsonResponse(200, { success: true });
    }
    if (request.method === 'POST' && pathname.startsWith('/api/auth/')) {
      if (session === undefined) {
        return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'server-text: no session' });
      }
      if (pathname === '/api/auth/two-factor/enable') return enable(input);
      if (pathname === '/api/auth/two-factor/verify-totp') return verifyTotp(input);
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }

    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (session === undefined) return contextRequired();
    if (request.method === 'GET' && pathname === '/v1/me')
      return jsonResponse(200, meWith(session));
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
    /** Whether the factor is enrolled on the server. */
    enrolled: () => session?.enrolled === true,
  };
}

const DEFAULT = { gate: 'none', enrolled: false, role: 'admin' } as const;

type FakeServer = ReturnType<typeof createFakeServer>;

/** A page slot: its test id names it. */
function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `mfaEnrol`, which keeps the router's default: the real page. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  catalogTable: probe('catalogTable'),
  entity: probe('entity'),
  search: probe('search'),
};

interface RenderedApp {
  readonly history: RouterHistory;
  readonly queryClient: QueryClient;
  /** Every location the history held, its `href` and its serialized `state`. */
  readonly visited: string[];
}

/** Renders the whole app (session gate, shell and providers, as `main.tsx`) at `path`. */
async function renderApp(path: string, server: FakeServer): Promise<RenderedApp> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const visited: string[] = [];
  const record = (location: RouterHistory['location']) => {
    visited.push(location.href, JSON.stringify(location.state));
  };
  record(history.location);
  history.subscribe(({ location }) => {
    record(location);
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
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthClientProvider client={authClient}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { history, queryClient, visited };
}

const TITLE = 'Set up two-factor authentication';
const QR_NAME = 'QR code for your authenticator app';
const PASSWORD_REQUIRED = 'Enter your password.';
const PASSWORD_INCORRECT = 'The password is incorrect.';
const ENABLE_FAILED = 'Two-factor authentication could not be set up. Try again later.';
const CODE_REQUIRED = 'Enter the code.';
const INVALID_CODE = 'The code is not valid.';
const SAVED_CONFIRMATION = 'I have saved my backup codes';
const MENU_ENTRY = 'Set up two-factor authentication';

/** The enrolment page's `main` landmark, once its heading is shown. */
async function enrolMain(): Promise<HTMLElement> {
  // The heading first: after a navigation the previous page's `main` can still be mounted.
  const heading = await screen.findByRole('heading', { name: TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The enrolment heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Waits for the password step and returns its controls. */
async function passwordStep() {
  const main = await enrolMain();
  const password = await within(main).findByLabelText('Password');
  return {
    main,
    password,
    submit: within(main).getByRole('button', { name: 'Continue' }),
  };
}

/** Waits for the scan-and-save step and returns its controls. */
async function codesStep() {
  const main = await enrolMain();
  const list = await within(main).findByRole('list', { name: 'Backup codes' });
  return {
    main,
    list,
    qr: within(main).getByRole('img', { name: QR_NAME }),
    saved: within(main).getByRole('checkbox', { name: SAVED_CONFIRMATION }),
    submit: within(main).getByRole('button', { name: 'Continue' }),
  };
}

/** Waits for the verification step and returns its controls. */
async function verifyStep() {
  const main = await enrolMain();
  const code = await within(main).findByLabelText('Authentication code');
  return {
    main,
    code,
    submit: within(main).getByRole('button', { name: 'Verify' }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function submitPassword(user: User, password: string): Promise<void> {
  const step = await passwordStep();
  await user.clear(step.password);
  if (password !== '') await user.type(step.password, password);
  await user.click(step.submit);
}

async function confirmSaved(user: User): Promise<void> {
  const step = await codesStep();
  await user.click(step.saved);
  await user.click(step.submit);
}

async function submitCode(user: User, code: string): Promise<void> {
  const step = await verifyStep();
  await user.clear(step.code);
  if (code !== '') await user.type(step.code, code);
  await user.click(step.submit);
}

/** Runs the page up to the verification step. */
async function reachVerifyStep(user: User): Promise<void> {
  await submitPassword(user, PASSWORD);
  await confirmSaved(user);
  await verifyStep();
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

/** Every query and mutation of the cache: keys, data, variables, errors and context. */
function cacheText(queryClient: QueryClient): string {
  const queries = queryClient
    .getQueryCache()
    .getAll()
    .map((query) =>
      JSON.stringify({
        key: query.queryKey,
        data: query.state.data,
        error: String(query.state.error),
      }),
    );
  const mutations = queryClient
    .getMutationCache()
    .getAll()
    .map((mutation) =>
      JSON.stringify({
        key: mutation.options.mutationKey,
        variables: mutation.state.variables,
        data: mutation.state.data,
        context: mutation.state.context,
        error: String(mutation.state.error),
      }),
    );
  return [...queries, ...mutations].join('\n');
}

/**
 * No password, URI, secret or backup code in storage, the URL (the router's history,
 * every location it held and its state, and the window's), the query or mutation cache,
 * or, once the page is left, the document.
 */
function expectNothingLeft(app: RenderedApp, options: { pageLeft: boolean }): void {
  const places: Record<string, string> = {
    storage: storageText(),
    'history location': `${app.history.location.href}\n${JSON.stringify(app.history.location.state)}`,
    'visited locations': app.visited.join('\n'),
    'window location': `${window.location.href}\n${JSON.stringify(window.history.state)}`,
    'query cache': cacheText(app.queryClient),
  };
  if (options.pageLeft) places.document = documentSnapshot();
  for (const [place, text] of Object.entries(places)) {
    for (const secret of SECRETS) {
      expect(text.includes(secret), `${place} holds ${secret}`).toBe(false);
    }
  }
}

/** Only the page's own secret display may hold the secret; nothing holds server text. */
function expectNoServerText(): void {
  expect(documentSnapshot()).not.toContain('server-text');
}

/** The `d` of the foreground path of every `QRCodeSVG` rendering of `value` it may use. */
function qrForegroundPaths(value: string): Set<string> {
  const paths = new Set<string>();
  for (const level of ['L', 'M', 'Q', 'H'] as const) {
    for (const boostLevel of [true, false]) {
      for (const marginSize of [0, 1, 2, 3, 4]) {
        const markup = renderToStaticMarkup(
          <QRCodeSVG value={value} level={level} boostLevel={boostLevel} marginSize={marginSize} />,
        );
        const svg = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg');
        const foreground = svg?.querySelectorAll('path')[1]?.getAttribute('d');
        if (foreground !== null && foreground !== undefined) paths.add(foreground);
      }
    }
  }
  return paths;
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

describe('MFA enrolment completes only with a valid code', () => {
  it('GIVEN a user who must enrol, WHEN they confirm their password, scan the code and enter a wrong code, then a valid one, THEN the wrong code is refused, the valid one enrols the factor, and the gate clears', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required', role: 'admin' });
    const app = await renderApp('/catalog/service?sort=title', server);

    // GIVEN: the gate holds the user on the enrolment page.
    await passwordStep();
    expect(app.history.location.pathname).toBe('/mfa/enrol');
    expect(screen.queryByTestId('page-catalogTable')).not.toBeInTheDocument();

    // WHEN they confirm their password...
    await submitPassword(user, PASSWORD);
    const enables = server.callsTo('POST', '/api/auth/two-factor/enable');
    expect(enables).toHaveLength(1);
    expect(JSON.parse(enables[0]?.call.body ?? '')).toEqual({ password: PASSWORD });

    // ...scan the code...
    const codes = await codesStep();
    expect(codes.qr.tagName.toLowerCase()).toBe('svg');
    expect(within(codes.main).getByText(SECRET)).toBeInTheDocument();
    await confirmSaved(user);

    // ...and enter a wrong code: THEN the wrong code is refused.
    await submitCode(user, WRONG_CODE);
    const step = await verifyStep();
    expect(await within(step.main).findByRole('alert')).toHaveTextContent(INVALID_CODE);
    await waitFor(() => {
      expect(step.code).toHaveValue('');
    });
    expect(server.enrolled()).toBe(false);
    expect(app.history.location.pathname).toBe('/mfa/enrol');
    expect(screen.queryByTestId('page-signIn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-catalogTable')).not.toBeInTheDocument();
    expect(app.queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();
    expectNoServerText();

    // ...then a valid one: THEN it enrols the factor and the gate clears.
    await submitCode(user, VALID_CODE);
    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/catalog/service?sort=title');
    expect(screen.queryByRole('heading', { name: TITLE })).not.toBeInTheDocument();
    expect(server.enrolled()).toBe(true);

    const verifications = server.callsTo('POST', '/api/auth/two-factor/verify-totp');
    expect(verifications.map(({ call }) => JSON.parse(call.body) as unknown)).toEqual([
      { code: WRONG_CODE },
      { code: VALID_CODE },
    ]);
    // The gate cleared because the session was read again after the valid code (Q71).
    const lastVerification = verifications.at(-1)?.index ?? Infinity;
    const meAfter = server.callsTo('GET', '/v1/me').filter(({ index }) => index > lastVerification);
    expect(meAfter.length).toBeGreaterThan(0);
    // One enable for the whole flow: the codes were never generated again.
    expect(server.callsTo('POST', '/api/auth/two-factor/enable')).toHaveLength(1);
    expectNothingLeft(app, { pageLeft: true });
  });

  it('returns to the returnTo of /mfa/enrol, query included', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const returnTo = '/catalog/service?sort=title';
    const app = await renderApp(`/mfa/enrol?returnTo=${encodeURIComponent(returnTo)}`, server);

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);

    expect(await screen.findByTestId('page-catalogTable')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe(returnTo);
  });

  it('goes to the home page without a returnTo', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/');
  });

  it('ignores an external returnTo and goes to the home page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp(
      `/mfa/enrol?returnTo=${encodeURIComponent('https://evil.example/phish')}`,
      server,
    );

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/');
  });
});

describe('the password step', () => {
  it('asks for the password with its autocomplete purpose, never echoing it, and offers sign-out', async () => {
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    const step = await passwordStep();
    expect(step.password).toHaveAttribute('type', 'password');
    expect(step.password).toHaveAttribute('autocomplete', 'current-password');
    expect(within(step.main).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // Nothing is enabled before the password is confirmed.
    expect(within(step.main).queryByRole('img', { name: QR_NAME })).not.toBeInTheDocument();
    expect(server.callsTo('POST', '/api/auth/two-factor/enable')).toHaveLength(0);
  });

  it('refuses an empty password on the client, with no request and the error tied to the field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await submitPassword(user, '');

    const step = await passwordStep();
    await waitFor(() => {
      expect(step.password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(step.password).toHaveAccessibleDescription(PASSWORD_REQUIRED);
    expect(server.callsTo('POST', '/api/auth/two-factor/enable')).toHaveLength(0);
  });

  it('marks a wrong password, empties the field and shows no QR code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);

    await submitPassword(user, `${PASSWORD}-wrong`);

    const step = await passwordStep();
    await waitFor(() => {
      expect(step.password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(step.password).toHaveAccessibleDescription(PASSWORD_INCORRECT);
    expect(step.password).toHaveValue('');
    expect(screen.queryByRole('img', { name: QR_NAME })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Backup codes' })).not.toBeInTheDocument();
    expect(server.callsTo('POST', '/api/auth/two-factor/enable')).toHaveLength(1);
    expect(app.history.location.pathname).toBe('/mfa/enrol');
    expect(documentSnapshot()).not.toContain(`${PASSWORD}-wrong`);
    expectNoServerText();
    expectNothingLeft(app, { pageLeft: false });
  });

  it('shows a generic alert when the server fails, empties the field and shows no QR code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required', enableAnswer: 'internal' });
    const app = await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);

    expect(await screen.findByRole('alert')).toHaveTextContent(ENABLE_FAILED);
    const step = await passwordStep();
    expect(step.password).toHaveValue('');
    expect(document.body.textContent).not.toContain(PASSWORD_INCORRECT);
    expect(screen.queryByRole('img', { name: QR_NAME })).not.toBeInTheDocument();
    expect(app.history.location.pathname).toBe('/mfa/enrol');
    expectNoServerText();
    expectNothingLeft(app, { pageLeft: false });
  });

  it('offers sign-out, which reaches the sign-in page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);
    await passwordStep();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByTestId('page-signIn')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/sign-in');
    expect(server.callsTo('POST', '/api/auth/sign-out')).toHaveLength(1);
    expect(app.queryClient.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
  });
});

describe('the QR code and the secret', () => {
  it('renders the TOTP URI as an inline SVG QR code, with no image, no data: URL and no style', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    const { main, qr } = await codesStep();

    // Inline in the page, not an <img>, <object> or <iframe> pointing anywhere.
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(main.contains(qr)).toBe(true);
    expect(document.querySelectorAll('img, image, object, embed, iframe')).toHaveLength(0);
    // D10: nothing a strict `style-src` or `img-src 'self'` would refuse.
    expect(qr.querySelectorAll('style, foreignObject, script, image, use')).toHaveLength(0);
    expect(qr).not.toHaveAttribute('style');
    expect(qr.querySelectorAll('[style]')).toHaveLength(0);
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toMatch(/data:/i);
      }
    }

    // It encodes the URI the server returned (qrcode.react's own rendering of it).
    const expected = qrForegroundPaths(TOTP_URI);
    const drawn = Array.from(qr.querySelectorAll('path'), (path) => path.getAttribute('d'));
    expect(drawn.some((d) => d !== null && expected.has(d))).toBe(true);
  });

  it('shows the secret of the URI as text for manual entry', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    const { main } = await codesStep();

    expect(within(main).getByText(SECRET)).toBeVisible();
    expectNoServerText();
  });

  it('never sends the URI, the secret or the codes in any request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);
    await screen.findByTestId('page-home');

    for (const call of server.calls) {
      for (const secret of [TOTP_URI, encodeURIComponent(TOTP_URI), SECRET, ...BACKUP_CODES]) {
        expect(call.url.href.includes(secret), `${call.method} ${call.url.pathname} URL`).toBe(
          false,
        );
        expect(call.body.includes(secret), `${call.method} ${call.url.pathname} body`).toBe(false);
      }
    }
  });
});

describe('the backup codes are shown once', () => {
  it('lists every backup code in the server order, with the saved confirmation', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    const { list, saved } = await codesStep();

    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent.trim())).toEqual([...BACKUP_CODES]);
    expect(saved).not.toBeChecked();
    // The verification comes after the codes are saved.
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
  });

  it('does not move on before the user confirms they saved the codes', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    const step = await codesStep();
    await user.click(step.submit);

    expect(await codesStep()).toBeDefined();
    for (const code of BACKUP_CODES) expect(within(step.list).getByText(code)).toBeInTheDocument();
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
  });

  it('removes the codes once confirmed, and never shows them again after a wrong code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);

    const expectCodesGone = () => {
      expect(screen.queryByRole('list', { name: 'Backup codes' })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: SAVED_CONFIRMATION })).not.toBeInTheDocument();
      const text = documentSnapshot();
      for (const code of BACKUP_CODES) expect(text).not.toContain(code);
    };
    expectCodesGone();

    await submitCode(user, WRONG_CODE);
    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID_CODE);
    await verifyStep();
    expectCodesGone();
    expect(server.callsTo('POST', '/api/auth/two-factor/enable')).toHaveLength(1);
    expectNothingLeft(app, { pageLeft: false });
  });
});

describe('the verification code field', () => {
  it('is a one-time-code field with a numeric keyboard', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);
    const step = await verifyStep();

    expect(step.code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(step.code).toHaveAttribute('inputmode', 'numeric');
    expect(within(step.main).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('refuses an empty code on the client, with no request and the error tied to the field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);
    await submitCode(user, '');

    const step = await verifyStep();
    await waitFor(() => {
      expect(step.code).toHaveAttribute('aria-invalid', 'true');
    });
    expect(step.code).toHaveAccessibleDescription(CODE_REQUIRED);
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
  });
});

describe('the URI, secret and codes are absent after leaving the page', () => {
  it('leaves nothing in storage, the URL or the query cache after enrolling', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);

    await reachVerifyStep(user);
    // While on the page, nothing but the page's own memory holds them either.
    expectNothingLeft(app, { pageLeft: false });
    await submitCode(user, VALID_CODE);
    await screen.findByTestId('page-home');

    expectNothingLeft(app, { pageLeft: true });
  });

  it('leaves nothing behind when the user signs out while the codes are shown', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'mfa_enrolment_required' });
    const app = await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    const step = await codesStep();
    await user.click(within(step.main).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByTestId('page-signIn')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/sign-in');
    expectNothingLeft(app, { pageLeft: true });
  });

  it('drops them when the user navigates away, and starts again from the password on return', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'none', role: 'member' });
    const app = await renderApp('/mfa/enrol', server);

    await submitPassword(user, PASSWORD);
    await codesStep();

    app.history.push('/');
    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expectNothingLeft(app, { pageLeft: true });

    app.history.push('/mfa/enrol');
    await passwordStep();
    expect(screen.queryByRole('img', { name: QR_NAME })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Backup codes' })).not.toBeInTheDocument();
    expectNothingLeft(app, { pageLeft: true });
  });
});

describe('re-enrolment and enrolment from the user menu', () => {
  it('re-enrols a member after an MFA reset on the same page, and the gate clears', async () => {
    const user = userEvent.setup();
    // The re-enrolment marker of an MFA reset: a member, no factor, the enrolment gate.
    const server = createFakeServer({ gate: 'mfa_enrolment_required', role: 'member' });
    const app = await renderApp('/', server);

    await passwordStep();
    expect(app.history.location.pathname).toBe('/mfa/enrol');
    expect(screen.queryByTestId('page-home')).not.toBeInTheDocument();

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/');
    expect(server.enrolled()).toBe(true);
    expectNothingLeft(app, { pageLeft: true });
  });

  it('offers enrolment in the user menu when not enrolled, on the same page, with gate none', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'none', role: 'member', enrolled: false });
    const app = await renderApp('/', server);
    await screen.findByTestId('page-home');

    await user.click(await screen.findByRole('button', { name: 'User menu' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: MENU_ENTRY }));

    await passwordStep();
    expect(app.history.location.pathname).toBe('/mfa/enrol');

    await reachVerifyStep(user);
    await submitCode(user, VALID_CODE);

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(locationOf(app.history)).toBe('/');
    expect(server.enrolled()).toBe(true);
    expectNothingLeft(app, { pageLeft: true });

    // The session was read again: the menu no longer offers enrolment.
    await user.click(await screen.findByRole('button', { name: 'User menu' }));
    const after = await screen.findByRole('menu');
    expect(within(after).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(after).queryByRole('menuitem', { name: MENU_ENTRY })).not.toBeInTheDocument();
  });

  it('does not offer enrolment in the user menu of an enrolled user', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ gate: 'none', role: 'member', enrolled: true });
    await renderApp('/', server);
    await screen.findByTestId('page-home');

    await user.click(await screen.findByRole('button', { name: 'User menu' }));
    const menu = await screen.findByRole('menu');

    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: MENU_ENTRY })).not.toBeInTheDocument();
  });
});
