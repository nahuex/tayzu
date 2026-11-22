/**
 * The invitation page (task 6.9, design D11, D12, D15, D16 and Q20, Q68, Q71, Q73, Q74,
 * Q78; archived `043` design D4 "Acceptance", D5 and its Q22, Q32; spec "The invitation
 * and password-reset pages follow the page rules", scenarios "A new invitee creates their
 * account" and "An invalid link shows the uniform message").
 *
 * D11 (`/accept-invitation`, `043` Q32): "The same fragment handling (`invitation`,
 * `token`). Signed out, the page offers the new-account path (a new password, then `POST
 * /v1/auth/invitations/accept` with `{ invitationId, token, password }`) and, for an
 * existing local account, a sign-in form embedded in the page, so the token stays in
 * memory; a Visma Connect user is told to sign in first and open the link again (Q20).
 * Signed in, it offers "Accept" (the session path). Every refusal is the one uniform
 * message. Nothing is submitted without a click."
 * D11 (`/reset-password`, the fragment handling): "Before the first render, the page reads
 * [the values] from `location.hash`, removes the fragment with `history.replaceState`, and
 * keeps both values in component state only (never storage, the URL, the query cache or
 * a log)." D11: "Password fields use `autocomplete="current-password"` or
 * `"new-password"`, are never echoed, stored or logged, and are cleared from form state
 * after a submit." Page rules: "the fragment gone from `location` before any request is
 * made, and no submit without a user action."
 * Q20: "An embedded local sign-in on the accept page keeps the token in memory only; a
 * Visma Connect user signs in first and reopens the link. _Rejected:_ keeping the token in
 * `sessionStorage` across a sign-in navigation."
 * Q68: the public pages never call `GET /v1/me` before they render, "so the reset and
 * invitation fragments are stripped before any request"; "`/accept-invitation` reads its
 * signed-in state itself".
 * Q78: the fragment is taken in the page's `useState` initializer, outside its
 * `Suspense`, and removed there with `window.history.replaceState` before the first
 * commit; the link format is checked on the client, because the server answers a
 * malformed body with a non-uniform `400`.
 * Task 6.9's Verify: "the embedded sign-in keeping the token in memory, the signed-in
 * accept, [...] the Visma Connect note, and no request before a click".
 * Spec: "Each link page MUST read its identifier and token from the URL fragment, remove
 * the fragment from the address before any request, keep both only in memory, and submit
 * only on the user's action. [...] The accept page MUST offer the new-account path with a
 * password and, for an existing account, the session path. Every rejection MUST show one
 * uniform message."
 * Scenario "A new invitee creates their account": GIVEN a valid invitation link for an
 * email with no account, WHEN the invitee opens it, chooses a password and accepts, THEN
 * the account is created and they can sign in.
 * Scenario "An invalid link shows the uniform message": WHEN a visitor opens
 * `/accept-invitation` [...] with an unknown token, THEN after they submit, the page
 * shows the uniform invalid-or-expired message.
 *
 * The server (`apps/api/src/identity/accept-flow.ts`, `server.ts`, `error-mapping.ts`,
 * `invitation-link.ts`; `packages/auth/src/identity/invitation-token.ts`):
 *
 * - the link is `/accept-invitation#invitation=<id>&token=<token>`; the id is Better
 *   Auth's (the route accepts 1 to 64 characters of `[A-Za-z0-9_-]` and answers anything
 *   else with a non-uniform `400 CATALOG_VALIDATION_FAILED`), the token 32 random bytes
 *   in base64url (43 characters);
 * - the body is exactly `{ invitationId, token, password? }`; the session is read only
 *   for a request with `x-csrf-token: orpc` and an allowed `Origin`;
 * - every refusal (unknown, expired, cancelled or used invitation, wrong token, no
 *   session or another account's session for an existing account, no password for a new
 *   account) is the uniform `404 { code: 'CATALOG_NOT_FOUND' }`;
 * - a new account's password that fails the policy, only once the token verified: `400 {
 *   code: 'CATALOG_VALIDATION_FAILED', data: { issues: [{ path: '/password', message:
 *   <rule> }] } }` (`breached` included), the token not consumed;
 * - the limiter: `429 { code: 'AUTH_RATE_LIMITED' }` with `Retry-After`;
 * - success, on both paths: `200 { userId }`. The new-account path creates the account
 *   and opens no session; the existing-account path ignores a `password`.
 *
 * Decisions this file pins (task 6.9, orchestrator's call, open to Checkpoint 2):
 *
 * - "No request before a click" is read strictly: the page makes no request at all, not
 *   even `GET /v1/me`, until the user clicks. It first offers two choices, "Create a new
 *   account" and "I already have an account". The first opens the new-account form with
 *   no request. The second reads `GET /v1/me` on that click (the page's own signed-in
 *   check, Q68): a session shows "Accept invitation" (the session path), a `401` shows the
 *   embedded sign-in with the Visma Connect note, and any other failure the generic alert
 *   with both choices kept.
 * - The new-account form has no name field (the route takes none): password and
 *   confirmation, then the accept with `password`. Success opens no session, so the page
 *   says the account was created and links to `/sign-in`.
 * - The embedded sign-in is the sign-in page's flow inside the accept page: email and
 *   password (`/api/auth/sign-in/email`), then the code step when asked (TOTP, or a
 *   backup code), then the accept without `password`, all on the user's submit of the
 *   last step ("Sign in and accept", "Verify and accept"). The page never leaves
 *   `/accept-invitation`, and the sign-in password never reaches the accept body.
 * - The session paths end on "You have joined the organization." with a "Continue" link
 *   to `/`; the page has removed the cached session, so the gate reads `GET /v1/me`
 *   again there (Q71).
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/auth/accept-invitation-page.tsx: the router's `acceptInvitation` page
 * // (`DEFAULT_PAGES.acceptInvitation`). No props. It reads the auth client from
 * // `useAuthClient()` and calls it directly, never through `useMutation`, so neither the
 * // id, the token nor a password or code reaches the mutation cache.
 * export function AcceptInvitationPage(): React.JSX.Element;
 * ```
 *
 * The page (texts from the `auth` namespace under `acceptInvitation.`, English pinned
 * here), a `main` landmark with the heading "Accept your invitation" in every state:
 *
 * - Valid link: the text "You have been invited to join an organization in Tayzu." and
 *   the buttons "Create a new account" and "I already have an account".
 * - New account: "Password" and "Confirm password" (`type="password"`,
 *   `autocomplete="new-password"`) and a "Create account and accept" button. Empty fields
 *   ("Enter a password.", "Confirm the password.") and a different confirmation ("The
 *   passwords do not match.") block the submit with no request, as the field's accessible
 *   description with `aria-invalid="true"`. Both fields are emptied after every request.
 *   A `/password` issue marks the password field with `auth:passwordPolicy.ruleFailed`
 *   (the rule's localized name) or `auth:passwordPolicy.failed` (unknown rule). Success
 *   replaces the form with "Your account has been created." and a "Sign in" link to
 *   `/sign-in`.
 * - Signed out, existing account: "Email" (`type="email"`, `autocomplete` `username` or
 *   `email`), "Password" (`type="password"`, `autocomplete="current-password"`) and a
 *   "Sign in and accept" button; the note "If you sign in with Visma Connect, sign in
 *   first, then open the invitation link again." with a "Go to sign-in" link to
 *   `/sign-in`, and no Visma Connect button. Empty fields: "Enter your email.", "Enter
 *   your password.". A refused sign-in (any answer but a rate limit): `alert` "The email
 *   or password is incorrect.", the password emptied. A second factor: "Authentication
 *   code" (`autocomplete="one-time-code"`), "Verify and accept", and "Use a backup code"
 *   switching to "Backup code"; an empty code: "Enter the code."; a refused code: `alert`
 *   "The code is not valid.", staying on the step.
 * - Signed in: "You are signed in as <email>." (the email as React text, never
 *   HTML-escaped twice) and an "Accept invitation" button.
 * - Session-path success: "You have joined the organization." and a "Continue" link to
 *   `/`, the cached session removed.
 * - The uniform `404`, and a missing or malformed fragment from the start: an `alert`
 *   "This invitation link is invalid or has expired." and no form and no choice.
 * - `rate_limited` (of the accept or of the embedded sign-in): `alert` "Too many attempts.
 *   Try again in N seconds." (`_one`: "... in 1 second."), or "Too many attempts. Try
 *   again later." without a usable `Retry-After`; the form stays.
 * - Any other failure (the accept, or the session read of "I already have an account"):
 *   `alert` "The invitation could not be accepted. Try again later."; the form (or the
 *   choices) stays.
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show. The
 * router runs on a real browser history over jsdom's `window`, as in `main.tsx`, with the
 * real sign-in page.
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

/** A Better Auth id (32 characters) and `043` D4's token (32 bytes, base64url, 43). */
const INVITATION_ID = 'Inv0aB1cD2eF3gH4iJ5kL6mN7oP8qR9s';
const TOKEN = 'Zq8-Wm3_Rt5Yu7Io9Pa1Sd2Fg4Hj6Kl0Xc3Vb5Nm7Qw';
const FRAGMENT = `#invitation=${INVITATION_ID}&token=${TOKEN}`;

const ACCEPT_PATH = '/accept-invitation';
const ACCEPT_ROUTE = '/v1/auth/invitations/accept';
const SIGN_IN_ROUTE = '/api/auth/sign-in/email';
const VERIFY_TOTP_ROUTE = '/api/auth/two-factor/verify-totp';
const VERIFY_BACKUP_ROUTE = '/api/auth/two-factor/verify-backup-code';
const ME_ROUTE = '/v1/me';

/** The invitee of the new-account path, and the password they choose (`043` Q22). */
const NEW_EMAIL = 'nora.new@example.com';
const NEW_PASSWORD = 'Brand-New-Password-2026!';

const EXISTING_PASSWORD = 'Existing-Password-0042!';
const VALID_TOTP = '246810';
const WRONG_TOTP = '135791';
const VALID_BACKUP_CODE = 'Hq3vN-8tLwz';

/** Every value that must live only in the page's memory (D11, D15, Q20). */
const SECRETS = [
  INVITATION_ID,
  TOKEN,
  NEW_PASSWORD,
  EXISTING_PASSWORD,
  VALID_TOTP,
  WRONG_TOTP,
  VALID_BACKUP_CODE,
];

const TITLE = 'Accept your invitation';
const INTRO = 'You have been invited to join an organization in Tayzu.';
const NEW_ACCOUNT = 'Create a new account';
const EXISTING_ACCOUNT = 'I already have an account';
const CREATE_AND_ACCEPT = 'Create account and accept';
const SIGN_IN_AND_ACCEPT = 'Sign in and accept';
const VERIFY_AND_ACCEPT = 'Verify and accept';
const ACCEPT = 'Accept invitation';
const ACCOUNT_CREATED = 'Your account has been created.';
const JOINED = 'You have joined the organization.';
const INVALID_LINK = 'This invitation link is invalid or has expired.';
const VISMA_CONNECT_NOTE =
  'If you sign in with Visma Connect, sign in first, then open the invitation link again.';
const SIGN_IN_FAILED = 'The email or password is incorrect.';
const INVALID_CODE = 'The code is not valid.';
const ACCEPT_FAILED = 'The invitation could not be accepted. Try again later.';
const RATE_LIMITED_LATER = 'Too many attempts. Try again later.';

/** `GET /v1/me`'s body (D8). */
interface MeBody {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: 'owner' | 'admin' | 'member';
  readonly signInMethod: 'password' | 'visma-connect';
  readonly mfa: { readonly enrolled: boolean };
  readonly gate: 'none';
}

interface Account {
  readonly email: string;
  readonly password: string;
  /** The valid TOTP code; without it the account has no second factor. */
  readonly totp?: string;
  readonly backupCodes?: readonly string[];
  readonly me: MeBody;
}

function meOf(id: string, email: string, mfaEnrolled = false): MeBody {
  return {
    user: { id, name: email, email },
    organization: { id: 'org_home', name: 'Home Org' },
    role: 'member',
    signInMethod: 'password',
    mfa: { enrolled: mfaEnrolled },
    gate: 'none',
  };
}

/** An existing local account without a second factor. The `'` must not be escaped twice. */
const ANA: Account = {
  email: "ana.o'neil@example.com",
  password: EXISTING_PASSWORD,
  me: meOf('u_ana', "ana.o'neil@example.com"),
};

/** An existing local account with TOTP and a backup code. */
const MIA: Account = {
  email: 'mia@example.com',
  password: EXISTING_PASSWORD,
  totp: VALID_TOTP,
  backupCodes: [VALID_BACKUP_CODE],
  me: meOf('u_mia', 'mia@example.com', true),
};

/** Another existing account, not the invitee. */
const OMAR: Account = {
  email: 'omar@example.com',
  password: 'Omar-Password-0077!',
  me: meOf('u_omar', 'omar@example.com'),
};

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

/** `043` D4 step 5: every refused acceptance. */
function uniformRejection(): Response {
  return jsonResponse(404, {
    defined: false,
    code: 'CATALOG_NOT_FOUND',
    status: 404,
    message: 'server-text: The requested resource was not found',
    data: {},
  });
}

function malformedBody(): Response {
  return jsonResponse(400, {
    defined: false,
    code: 'CATALOG_VALIDATION_FAILED',
    status: 400,
    message: 'server-text: The request input is invalid',
    data: { issues: [{ path: '/', message: 'server-text: Invalid value' }] },
  });
}

function policyRefused(rule: string): Response {
  return jsonResponse(400, {
    defined: false,
    code: 'CATALOG_VALIDATION_FAILED',
    status: 400,
    message: `server-text: The password does not meet the policy: ${rule}`,
    data: { issues: [{ path: '/password', message: rule }] },
  });
}

function internalError(): Response {
  return jsonResponse(500, {
    defined: false,
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'server-text: internal failure',
  });
}

function rateLimited(retryAfter: string | undefined): Response {
  return jsonResponse(
    429,
    { defined: false, code: 'AUTH_RATE_LIMITED', status: 429, message: 'server-text: slow' },
    retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  );
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: string;
  /** `window.location.hash` when the request was made. */
  readonly hashAtRequest: string;
}

type Answer =
  { readonly kind: 'rate_limited'; readonly retryAfter?: string } | { readonly kind: 'internal' };

interface FakeServerOptions {
  /** The invitation's email: no account yet (`new`), or this account. */
  readonly invitee: 'new' | Account;
  /** `unknown`: the server knows no such link (wrong, expired or used). */
  readonly link?: 'valid' | 'unknown';
  /** Accounts that may sign in, besides the invitee's. */
  readonly accounts?: readonly Account[];
  /** Signed in from the start. */
  readonly signedInAs?: Account;
  /** Every new-account acceptance that reaches the policy check fails this rule. */
  readonly policyRule?: string;
  /** Every acceptance answers this instead. */
  readonly acceptAnswer?: Answer;
  /** Every sign-in answers this instead. */
  readonly signInAnswer?: Answer;
  /** `GET /v1/me` answers this instead. */
  readonly meAnswer?: Answer;
}

const ACCEPT_FIELDS: ReadonlySet<string> = new Set(['invitationId', 'token', 'password']);

/**
 * A fake `fetch` playing Better Auth and the API: the accept route in `043` D4's order of
 * work, the local sign-in with its second factor, `GET /v1/me` and the shell's sidebar.
 */
function createFakeServer(options: FakeServerOptions) {
  const accounts: Account[] = [
    ...(options.invitee === 'new' ? [] : [options.invitee]),
    ...(options.accounts ?? []),
  ];
  let session: Account | undefined = options.signedInAs;
  let pendingSecondFactor: Account | undefined;
  let linkUsed = options.link === 'unknown';
  const calls: RecordedRequest[] = [];

  function accept(input: Record<string, unknown>, crossSiteSafe: boolean): Response {
    const { acceptAnswer } = options;
    if (acceptAnswer?.kind === 'rate_limited') return rateLimited(acceptAnswer.retryAfter);
    if (acceptAnswer?.kind === 'internal') return internalError();
    if (Object.keys(input).some((key) => !ACCEPT_FIELDS.has(key))) return malformedBody();
    if (linkUsed || input.invitationId !== INVITATION_ID || input.token !== TOKEN) {
      return uniformRejection();
    }
    const { invitee } = options;
    if (invitee === 'new') {
      if (typeof input.password !== 'string') return uniformRejection();
      if (options.policyRule !== undefined) return policyRefused(options.policyRule);
      accounts.push({ email: NEW_EMAIL, password: input.password, me: meOf('u_new', NEW_EMAIL) });
      linkUsed = true;
      return jsonResponse(200, { userId: 'u_new' });
    }
    // The existing-account path: only the invitee's own session, read with the CSRF header.
    if (!crossSiteSafe || session !== invitee) return uniformRejection();
    linkUsed = true;
    return jsonResponse(200, { userId: invitee.me.user.id });
  }

  function signIn(input: Record<string, unknown>): Response {
    const { signInAnswer } = options;
    if (signInAnswer?.kind === 'rate_limited') return rateLimited(signInAnswer.retryAfter);
    if (signInAnswer?.kind === 'internal') return internalError();
    const account = accounts.find((candidate) => candidate.email === input.email);
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

  function verify(input: Record<string, unknown>, kind: 'totp' | 'backup'): Response {
    const account = pendingSecondFactor;
    const valid =
      kind === 'totp'
        ? account?.totp !== undefined && account.totp === input.code
        : account !== undefined && (account.backupCodes ?? []).includes(String(input.code));
    if (account === undefined || !valid) {
      return jsonResponse(401, {
        code: kind === 'totp' ? 'INVALID_CODE' : 'INVALID_BACKUP_CODE',
        message: 'server-text: invalid code',
      });
    }
    pendingSecondFactor = undefined;
    session = account;
    return jsonResponse(200, { token: 'session-token', user: account.me.user });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, body, hashAtRequest: window.location.hash });
    const { pathname } = url;
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST') {
      if (pathname === ACCEPT_ROUTE) {
        return accept(input, request.headers.get('x-csrf-token') === 'orpc');
      }
      if (pathname === SIGN_IN_ROUTE) return signIn(input);
      if (pathname === VERIFY_TOTP_ROUTE) return verify(input, 'totp');
      if (pathname === VERIFY_BACKUP_ROUTE) return verify(input, 'backup');
    }
    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (request.method === 'GET' && pathname === ME_ROUTE) {
      const { meAnswer } = options;
      if (meAnswer?.kind === 'rate_limited') return rateLimited(meAnswer.retryAfter);
      if (meAnswer?.kind === 'internal') return internalError();
    }
    if (session === undefined) return contextRequired();
    if (request.method === 'GET' && pathname === ME_ROUTE) return jsonResponse(200, session.me);
    if (request.method === 'GET' && pathname === '/v1/blueprints') {
      return jsonResponse(200, { items: [] });
    }
    return new Response(null, { status: 204 });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    calls,
    /** Every request as `METHOD /path`, in order. */
    routes(): string[] {
      return calls.map((call) => `${call.method} ${call.url.pathname}`);
    },
    /** The bodies sent to `path` with `POST`, in order. */
    bodiesTo(path: string): unknown[] {
      return calls
        .filter((call) => call.method === 'POST' && call.url.pathname === path)
        .map((call) => JSON.parse(call.body) as unknown);
    },
    /** The index of the last request to `METHOD /path`, or -1. */
    lastIndexOf(route: string): number {
      return calls.map((call) => `${call.method} ${call.url.pathname}`).lastIndexOf(route);
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

/** Every slot but `acceptInvitation` and `signIn`, which keep the router's real pages. */
const PROBES = {
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
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

/** Any content of the accept page, or of any page. */
function pageRendered(): boolean {
  return document.querySelector('main, h1, form, input, button, [role="alert"]') !== null;
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

/** Waits for the accept page and returns its `main` landmark. */
async function acceptPage(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The accept heading is not inside a main landmark');
  expect(main).toBe(screen.getByRole('main'));
  return main;
}

/** Waits for the two choices of a valid link and returns them. */
async function choices() {
  const main = await acceptPage();
  return {
    main,
    newAccount: await within(main).findByRole('button', { name: NEW_ACCOUNT }),
    existingAccount: within(main).getByRole('button', { name: EXISTING_ACCOUNT }),
  };
}

type User = ReturnType<typeof userEvent.setup>;

async function fill(field: HTMLElement, user: User, value: string): Promise<void> {
  await user.clear(field);
  if (value !== '') await user.type(field, value);
}

/** Chooses the new-account path and returns its form. */
async function openNewAccountForm(user: User) {
  const { main, newAccount } = await choices();
  await user.click(newAccount);
  return newAccountForm(main);
}

async function newAccountForm(main?: HTMLElement) {
  const page = main ?? (await acceptPage());
  return {
    main: page,
    password: await within(page).findByLabelText('Password'),
    confirmation: within(page).getByLabelText('Confirm password'),
    submit: within(page).getByRole('button', { name: CREATE_AND_ACCEPT }),
  };
}

/** Fills the new-account form and clicks "Create account and accept". */
async function submitNewAccount(
  user: User,
  values: { password: string; confirmation?: string },
): Promise<void> {
  const form = await newAccountForm();
  await fill(form.password, user, values.password);
  await fill(form.confirmation, user, values.confirmation ?? values.password);
  await user.click(form.submit);
}

/** Chooses "I already have an account". */
async function chooseExistingAccount(user: User): Promise<HTMLElement> {
  const { main, existingAccount } = await choices();
  await user.click(existingAccount);
  return main;
}

/** Waits for the embedded sign-in form and returns its controls. */
async function embeddedSignIn() {
  const main = await acceptPage();
  return {
    main,
    email: await within(main).findByRole('textbox', { name: 'Email' }),
    password: within(main).getByLabelText('Password'),
    submit: within(main).getByRole('button', { name: SIGN_IN_AND_ACCEPT }),
  };
}

async function submitEmbeddedSignIn(user: User, email: string, password: string): Promise<void> {
  const form = await embeddedSignIn();
  await fill(form.email, user, email);
  await fill(form.password, user, password);
  await user.click(form.submit);
}

async function submitCode(
  user: User,
  label: 'Authentication code' | 'Backup code',
  code: string,
): Promise<void> {
  const main = await acceptPage();
  await fill(await within(main).findByLabelText(label), user, code);
  await user.click(within(main).getByRole('button', { name: VERIFY_AND_ACCEPT }));
}

/** The uniform invalid-link state: the message, and nothing left to submit or choose. */
async function expectInvalidLink(): Promise<void> {
  const main = await acceptPage();
  expect(await within(main).findByRole('alert')).toHaveTextContent(INVALID_LINK);
  expect(within(main).queryByRole('textbox')).not.toBeInTheDocument();
  expect(main.querySelector('input')).toBeNull();
  for (const name of [
    NEW_ACCOUNT,
    EXISTING_ACCOUNT,
    CREATE_AND_ACCEPT,
    SIGN_IN_AND_ACCEPT,
    VERIFY_AND_ACCEPT,
    ACCEPT,
  ]) {
    expect(within(main).queryByRole('button', { name })).not.toBeInTheDocument();
  }
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
  expect(window.location.pathname).toBe(ACCEPT_PATH);
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
    for (const secret of [INVITATION_ID, TOKEN]) {
      expect(text.includes(secret), `${place} holds ${secret}`).toBe(false);
    }
  }
}

/** Storage, the address, the history, the caches and the document hold no secret. */
function expectNothingKept(app: RenderedApp): void {
  expect(window.localStorage).toHaveLength(0);
  expect(window.sessionStorage).toHaveLength(0);
  const places: Record<string, string> = {
    storage: storageText(),
    'window location': `${window.location.href}\n${JSON.stringify(window.history.state)}`,
    'history location': `${app.history.location.href}\n${JSON.stringify(app.history.location.state)}`,
    'router location': `${app.router.state.location.href}\n${JSON.stringify(app.router.state.location.state)}`,
    'query and mutation caches': cacheText(app.queryClient),
    document: documentSnapshot(),
  };
  for (const [place, text] of Object.entries(places)) {
    for (const secret of SECRETS) {
      expect(text.includes(secret), `${place} holds ${secret}`).toBe(false);
    }
  }
}

/**
 * Every request went to the page's origin with no fragment left, and only the accept
 * route ever carried the invitation id or the token, in its body only.
 */
function expectTokenOnlyInAcceptBodies(server: FakeServer): void {
  for (const call of server.calls) {
    expect(call.url.origin).toBe(window.location.origin);
    expect(call.hashAtRequest).toBe('');
    expect(call.url.href.includes(TOKEN)).toBe(false);
    expect(call.url.href.includes(INVITATION_ID)).toBe(false);
    if (call.url.pathname !== ACCEPT_ROUTE) {
      expect(call.body.includes(TOKEN), `${call.url.pathname} carries the token`).toBe(false);
      expect(call.body.includes(INVITATION_ID), `${call.url.pathname} carries the id`).toBe(false);
    }
  }
}

function expectNoServerText(): void {
  expect(documentSnapshot()).not.toContain('server-text');
}

/** The page never left `/accept-invitation` (the embedded sign-in is not `/sign-in`). */
function expectStillOnAcceptPage(app: RenderedApp): void {
  expect(window.location.pathname).toBe(ACCEPT_PATH);
  expect(app.history.location.pathname).toBe(ACCEPT_PATH);
  expect(screen.queryByRole('heading', { name: 'Sign in to Tayzu' })).not.toBeInTheDocument();
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

describe('the fragment', () => {
  it.each([
    ['with the auth texts still loading', false],
    ['with the auth texts already loaded', true],
  ])(
    'removes the fragment with history.replaceState before the page first renders, %s',
    async (_label, authNamespaceLoaded) => {
      const server = createFakeServer({ invitee: 'new' });
      const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server, { authNamespaceLoaded });

      await choices();

      const strip = app.replaces.find((record) => record.hashAfter === '');
      expect(strip, 'no replaceState call removed the fragment').toBeDefined();
      expect(strip?.pageRendered, 'the page rendered before the fragment was removed').toBe(false);
      // Nothing put the fragment back afterwards.
      expect(app.replaces.at(-1)?.hashAfter).toBe('');
      expectAddressClean(app);
      expect(server.calls).toEqual([]);
      expect(window.localStorage).toHaveLength(0);
      expect(window.sessionStorage).toHaveLength(0);
      expect(cacheText(app.queryClient)).not.toContain(TOKEN);
    },
  );

  it('shows the invitation and both choices for a valid link', async () => {
    const server = createFakeServer({ invitee: 'new' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const { main } = await choices();
    expect(within(main).getByText(INTRO)).toBeInTheDocument();
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
    expect(main.querySelector('input')).toBeNull();
  });

  it('shows the uniform invalid-link message, with no form and no request, for a link with no fragment', async () => {
    const server = createFakeServer({ invitee: 'new' });
    const app = await renderApp(ACCEPT_PATH, server);

    await expectInvalidLink();
    await waitFor(() => {
      expect(app.router.state.status).toBe('idle');
    });
    expect(window.location.pathname).toBe(ACCEPT_PATH);
    expect(server.calls).toEqual([]);
  });

  it.each([
    ['no token', `#invitation=${INVITATION_ID}`],
    ['no invitation', `#token=${TOKEN}`],
    ['empty values', '#invitation=&token='],
    ['a short token', `#invitation=${INVITATION_ID}&token=${TOKEN.slice(1)}`],
    ['a long token', `#invitation=${INVITATION_ID}&token=${TOKEN}A`],
    ['a token that is not base64url', `#invitation=${INVITATION_ID}&token=${TOKEN.slice(1)}*`],
    ['an id with a dot', `#invitation=inv.${INVITATION_ID}&token=${TOKEN}`],
    ['an id longer than 64 characters', `#invitation=${'a'.repeat(65)}&token=${TOKEN}`],
    ['a reset fragment', `#reset=rS3t-Id_0123456789abcd&token=${TOKEN}`],
  ])(
    'shows the same message for a fragment with %s, removes it, and makes no request',
    async (_label, fragment) => {
      const server = createFakeServer({ invitee: 'new' });
      await renderApp(`${ACCEPT_PATH}${fragment}`, server);

      await expectInvalidLink();
      expect(window.location.hash).toBe('');
      expect(window.location.pathname).toBe(ACCEPT_PATH);
      expect(server.calls).toEqual([]);
    },
  );
});

describe('no request before a click', () => {
  it.each([
    ['signed out', undefined],
    ['signed in', ANA],
  ] as const)(
    'makes no request on opening the link %s, not even the session read',
    async (_label, signedInAs) => {
      const server = createFakeServer(
        signedInAs === undefined ? { invitee: ANA } : { invitee: ANA, signedInAs },
      );
      const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

      await choices();
      await waitFor(() => {
        expect(app.router.state.status).toBe('idle');
      });
      // Give any effect, timer or query a chance to fire.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(server.calls).toEqual([]);
      expectAddressClean(app);
    },
  );

  it('sends nothing while the new invitee chooses and types, and only the accept on their click', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const form = await openNewAccountForm(user);
    expect(server.calls).toEqual([]);

    await user.type(form.password, NEW_PASSWORD);
    await user.type(form.confirmation, NEW_PASSWORD);
    expect(server.calls).toEqual([]);

    await user.click(form.submit);

    expect(await screen.findByText(ACCOUNT_CREATED)).toBeInTheDocument();
    expect(server.routes()).toEqual([`POST ${ACCEPT_ROUTE}`]);
  });

  it('sends nothing while the existing user types the sign-in form until they submit it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    const form = await embeddedSignIn();
    // The click on "I already have an account" read the session, and nothing else.
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);

    await user.type(form.email, ANA.email);
    await user.type(form.password, ANA.password);
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
  });

  it('sends the signed-in accept only on the click of "Accept invitation"', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, signedInAs: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await chooseExistingAccount(user);
    await within(main).findByRole('button', { name: ACCEPT });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);
  });
});

describe('A new invitee creates their account', () => {
  it('GIVEN a valid invitation link for an email with no account, WHEN the invitee opens it, chooses a password and accepts, THEN the account is created and they can sign in', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new' });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    // The invitee opens it.
    await choices();
    expectAddressClean(app);
    expect(server.calls).toEqual([]);

    // They choose a password and accept.
    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    // The account is created.
    const main = await acceptPage();
    expect(await within(main).findByText(ACCOUNT_CREATED)).toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([
      { invitationId: INVITATION_ID, token: TOKEN, password: NEW_PASSWORD },
    ]);
    expect(server.routes()).toEqual([`POST ${ACCEPT_ROUTE}`]);
    expect(within(main).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(within(main).queryByLabelText('Confirm password')).not.toBeInTheDocument();
    expectTokenOnlyInAcceptBodies(server);
    expectAddressClean(app);
    expectNothingKept(app);
    expectNoServerText();

    // They can sign in.
    const signIn = within(main).getByRole('link', { name: 'Sign in' });
    expect(signIn).toHaveAttribute('href', '/sign-in');
    await user.click(signIn);

    expect(await screen.findByRole('heading', { name: 'Sign in to Tayzu' })).toBeInTheDocument();
    expect(app.history.location.pathname).toBe('/sign-in');
    await user.type(screen.getByRole('textbox', { name: 'Email' }), NEW_EMAIL);
    await user.type(screen.getByLabelText('Password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(server.bodiesTo(SIGN_IN_ROUTE)).toEqual([{ email: NEW_EMAIL, password: NEW_PASSWORD }]);
    expectTokenOnlyInAcceptBodies(server);
  });

  it('labels both password fields with the new-password purpose, never echoing them', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const form = await openNewAccountForm(user);
    for (const field of [form.password, form.confirmation]) {
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
    // The new-account form is not a sign-in form.
    expect(within(form.main).queryByRole('textbox', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('refuses empty fields on the client, with no request and each error tied to its field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const form = await openNewAccountForm(user);
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.password).toHaveAccessibleDescription('Enter a password.');
    expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    expect(form.confirmation).toHaveAccessibleDescription('Confirm the password.');
    expect(server.calls).toEqual([]);
  });

  it('refuses a confirmation that differs from the password, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD, confirmation: `${NEW_PASSWORD}x` });

    const form = await newAccountForm();
    await waitFor(() => {
      expect(form.confirmation).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.confirmation).toHaveAccessibleDescription('The passwords do not match.');
    expect(server.calls).toEqual([]);
  });
});

describe('the embedded sign-in keeps the token in memory', () => {
  it('GIVEN an invitation for an existing account with TOTP and a signed-out visitor, WHEN they sign in on the page and verify their code, THEN the page accepts with the token it kept in memory, never leaving the page or storing it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: MIA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    const form = await embeddedSignIn();
    expect(form.email).toHaveAttribute('type', 'email');
    expect(['username', 'email']).toContain(form.email.getAttribute('autocomplete'));
    expect(form.password).toHaveAttribute('type', 'password');
    expect(form.password).toHaveAttribute('autocomplete', 'current-password');

    await submitEmbeddedSignIn(user, MIA.email, MIA.password);

    // The code step, on the same page, with the token still only in memory.
    const main = await acceptPage();
    const code = await within(main).findByLabelText('Authentication code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(within(main).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${SIGN_IN_ROUTE}`]);
    expect(server.bodiesTo(SIGN_IN_ROUTE)).toEqual([{ email: MIA.email, password: MIA.password }]);
    expectStillOnAcceptPage(app);
    expectAddressClean(app);
    expectNothingKept(app);

    await submitCode(user, 'Authentication code', VALID_TOTP);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${SIGN_IN_ROUTE}`,
      `POST ${VERIFY_TOTP_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(VERIFY_TOTP_ROUTE)).toEqual([{ code: VALID_TOTP }]);
    // The session path: no password, and never the sign-in password.
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
    expectTokenOnlyInAcceptBodies(server);
    expectStillOnAcceptPage(app);
    expectAddressClean(app);
    expectNothingKept(app);
    expectNoServerText();
  });

  it('accepts right after the sign-in of an account without a second factor', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, ANA.email, ANA.password);

    const main = await acceptPage();
    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${SIGN_IN_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
    expectTokenOnlyInAcceptBodies(server);
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
  });

  it('accepts after a backup code', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: MIA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, MIA.email, MIA.password);
    const main = await acceptPage();
    await user.click(await within(main).findByRole('button', { name: 'Use a backup code' }));
    const backup = within(main).getByLabelText('Backup code');
    expect(backup).toHaveAttribute('autocomplete', 'one-time-code');

    await submitCode(user, 'Backup code', VALID_BACKUP_CODE);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(server.bodiesTo(VERIFY_BACKUP_ROUTE)).toEqual([{ code: VALID_BACKUP_CODE }]);
    expect(server.bodiesTo(VERIFY_TOTP_ROUTE)).toEqual([]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
  });

  it('refuses a wrong password with the uniform sign-in message, sends no accept, and empties the password', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, ANA.email, 'Wrong-Password-0000!');

    const form = await embeddedSignIn();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(SIGN_IN_FAILED);
    await waitFor(() => {
      expect(form.password).toHaveValue('');
    });
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
    expectStillOnAcceptPage(app);
    expectNoServerText();

    // The link is still usable: the right password accepts.
    await submitEmbeddedSignIn(user, ANA.email, ANA.password);
    expect(await within(form.main).findByText(JOINED)).toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
  });

  it('refuses an unknown email with the same message', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, 'nobody@example.com', ANA.password);

    const form = await embeddedSignIn();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(SIGN_IN_FAILED);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
    expectNoServerText();
  });

  it('refuses a wrong code with one message, stays on the code step, and accepts with the valid one', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: MIA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, MIA.email, MIA.password);
    await submitCode(user, 'Authentication code', WRONG_TOTP);

    const main = await acceptPage();
    expect(await within(main).findByRole('alert')).toHaveTextContent(INVALID_CODE);
    expect(within(main).getByLabelText('Authentication code')).toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
    // Better Auth's 401 for a wrong code is not a lost session (Q74).
    expectStillOnAcceptPage(app);

    await submitCode(user, 'Authentication code', VALID_TOTP);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
    expectNothingKept(app);
    expectNoServerText();
  });

  it('refuses empty sign-in fields and an empty code on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: MIA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    const form = await embeddedSignIn();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.email).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.email).toHaveAccessibleDescription('Enter your email.');
    expect(form.password).toHaveAttribute('aria-invalid', 'true');
    expect(form.password).toHaveAccessibleDescription('Enter your password.');
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);

    await submitEmbeddedSignIn(user, MIA.email, MIA.password);
    const main = await acceptPage();
    const code = await within(main).findByLabelText('Authentication code');
    await user.click(within(main).getByRole('button', { name: VERIFY_AND_ACCEPT }));

    await waitFor(() => {
      expect(code).toHaveAttribute('aria-invalid', 'true');
    });
    expect(code).toHaveAccessibleDescription('Enter the code.');
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${SIGN_IN_ROUTE}`]);
  });

  it('shows when to try again when the sign-in is rate limited, keeping the form', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      invitee: ANA,
      signInAnswer: { kind: 'rate_limited', retryAfter: '30' },
    });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, ANA.email, ANA.password);

    const form = await embeddedSignIn();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 30 seconds.',
    );
    expect(form.submit).toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
  });
});

describe('the Visma Connect note', () => {
  it('tells a signed-out Visma Connect user to sign in first and open the link again, with no Visma Connect sign-in on the page', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    const form = await embeddedSignIn();

    expect(within(form.main).getByText(VISMA_CONNECT_NOTE)).toBeInTheDocument();
    const signIn = within(form.main).getByRole('link', { name: 'Go to sign-in' });
    expect(signIn).toHaveAttribute('href', '/sign-in');
    // A Visma Connect sign-in would leave the page and lose the token (Q20).
    expect(
      within(form.main).queryByRole('button', { name: /visma connect/i }),
    ).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);
    expect(window.sessionStorage).toHaveLength(0);
  });

  it('leaves no token behind when the user follows the note to /sign-in', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    const form = await embeddedSignIn();
    await user.click(within(form.main).getByRole('link', { name: 'Go to sign-in' }));

    expect(await screen.findByRole('heading', { name: 'Sign in to Tayzu' })).toBeInTheDocument();
    expect(app.history.location.pathname).toBe('/sign-in');
    expectNothingKept(app);
    expectTokenOnlyInAcceptBodies(server);
  });
});

describe('the signed-in accept', () => {
  it('GIVEN a visitor signed in as the invitee, WHEN they choose their account and click "Accept invitation", THEN the page accepts through the session with no password and leads on to the app', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, signedInAs: ANA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await chooseExistingAccount(user);
    const accept = await within(main).findByRole('button', { name: ACCEPT });
    // The email as React text, escaped once (no `&#39;`).
    expect(within(main).getByText(`You are signed in as ${ANA.email}.`)).toBeInTheDocument();
    // The session path asks for no credential.
    expect(main.querySelector('input')).toBeNull();
    expect(within(main).queryByText(VISMA_CONNECT_NOTE)).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`]);

    await user.click(accept);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([{ invitationId: INVITATION_ID, token: TOKEN }]);
    expect(within(main).queryByRole('button', { name: ACCEPT })).not.toBeInTheDocument();
    expectTokenOnlyInAcceptBodies(server);
    expectAddressClean(app);
    expectNothingKept(app);
    expectNoServerText();

    // The cached session was removed, so the gate reads it again on the way in.
    const acceptIndex = server.lastIndexOf(`POST ${ACCEPT_ROUTE}`);
    const next = within(main).getByRole('link', { name: 'Continue' });
    expect(next).toHaveAttribute('href', '/');
    await user.click(next);

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(server.lastIndexOf(`GET ${ME_ROUTE}`)).toBeGreaterThan(acceptIndex);
  });

  it('removes the cached session after the embedded sign-in too, so the gate reads the new one', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, ANA.email, ANA.password);
    const main = await acceptPage();
    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    const acceptIndex = server.lastIndexOf(`POST ${ACCEPT_ROUTE}`);

    await user.click(within(main).getByRole('link', { name: 'Continue' }));

    expect(await screen.findByTestId('page-home')).toBeInTheDocument();
    expect(server.lastIndexOf(`GET ${ME_ROUTE}`)).toBeGreaterThan(acceptIndex);
  });

  it('shows the generic alert when the session cannot be read, keeping both choices', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, meAnswer: { kind: 'internal' } });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);

    const { main } = await choices();
    expect(await within(main).findByRole('alert')).toHaveTextContent(ACCEPT_FAILED);
    expect(within(main).queryByRole('button', { name: ACCEPT })).not.toBeInTheDocument();
    expect(within(main).queryByRole('textbox', { name: 'Email' })).not.toBeInTheDocument();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([]);
    expectNoServerText();
  });
});

describe('An invalid link shows the uniform message', () => {
  it('WHEN a visitor opens /accept-invitation with an unknown token, THEN after they submit, the page shows the uniform invalid-or-expired message', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new', link: 'unknown' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    await expectInvalidLink();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toHaveLength(1);
    expect(screen.queryByText(ACCOUNT_CREATED)).not.toBeInTheDocument();
    expectNoServerText();
  });

  it('shows the same message for an unknown token on the signed-in path', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, link: 'unknown', signedInAs: ANA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await chooseExistingAccount(user);
    await user.click(await within(main).findByRole('button', { name: ACCEPT }));

    await expectInvalidLink();
    expect(screen.queryByText(JOINED)).not.toBeInTheDocument();
    expectNoServerText();
  });

  it('shows the same message for an unknown token after the embedded sign-in', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, link: 'unknown' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await chooseExistingAccount(user);
    await submitEmbeddedSignIn(user, ANA.email, ANA.password);

    await expectInvalidLink();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toHaveLength(1);
    expectNoServerText();
  });

  it('shows the same message when the signed-in account is not the invitee', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ANA, accounts: [OMAR], signedInAs: OMAR });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await chooseExistingAccount(user);
    await user.click(await within(main).findByRole('button', { name: ACCEPT }));

    await expectInvalidLink();
    expectNoServerText();
  });
});

describe('the other answers of the accept route', () => {
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
    'shows only the localized name of the failed rule %s on the password field',
    async (rule, name) => {
      const user = userEvent.setup();
      const server = createFakeServer({ invitee: 'new', policyRule: rule });
      await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

      await openNewAccountForm(user);
      await submitNewAccount(user, { password: NEW_PASSWORD });

      const form = await newAccountForm();
      await waitFor(() => {
        expect(form.password).toHaveAttribute('aria-invalid', 'true');
      });
      expect(form.password).toHaveAccessibleDescription(
        `The new password does not meet this rule: ${name}.`,
      );
      expect(form.password).toHaveValue('');
      expect(form.confirmation).toHaveValue('');
      expect(within(form.main).queryByText(INVALID_LINK)).not.toBeInTheDocument();
      expectNoServerText();
    },
  );

  it('shows the generic policy message for an unknown rule', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new', policyRule: 'server-text-rule' });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    const form = await newAccountForm();
    await waitFor(() => {
      expect(form.password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(form.password).toHaveAccessibleDescription(
      'The new password does not meet the password policy.',
    );
    expectNoServerText();
  });

  it.each([
    ['30', 'Too many attempts. Try again in 30 seconds.'],
    ['1', 'Too many attempts. Try again in 1 second.'],
  ])('shows when to try again from Retry-After %s, keeping the form', async (retryAfter, text) => {
    const user = userEvent.setup();
    const server = createFakeServer({
      invitee: 'new',
      acceptAnswer: { kind: 'rate_limited', retryAfter },
    });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    const form = await newAccountForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(text);
    expect(form.submit).toBeInTheDocument();
    expect(form.password).toHaveValue('');
    expectNoServerText();
  });

  it('asks to try again later without a usable Retry-After', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new', acceptAnswer: { kind: 'rate_limited' } });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    const form = await newAccountForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(RATE_LIMITED_LATER);
    expect(form.submit).toBeInTheDocument();
  });

  it('shows one generic alert for a server failure on the new-account path, keeping the form', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: 'new', acceptAnswer: { kind: 'internal' } });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await openNewAccountForm(user);
    await submitNewAccount(user, { password: NEW_PASSWORD });

    const form = await newAccountForm();
    expect(await within(form.main).findByRole('alert')).toHaveTextContent(ACCEPT_FAILED);
    expect(form.submit).toBeInTheDocument();
    expect(form.password).toHaveValue('');
    expect(form.confirmation).toHaveValue('');
    expectNoServerText();
  });

  it('shows the same alert for a server failure on the signed-in path, keeping "Accept invitation"', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      invitee: ANA,
      signedInAs: ANA,
      acceptAnswer: { kind: 'internal' },
    });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await chooseExistingAccount(user);
    await user.click(await within(main).findByRole('button', { name: ACCEPT }));

    expect(await within(main).findByRole('alert')).toHaveTextContent(ACCEPT_FAILED);
    expect(within(main).getByRole('button', { name: ACCEPT })).toBeInTheDocument();
    expect(screen.queryByText(JOINED)).not.toBeInTheDocument();
    expectNoServerText();
  });
});
