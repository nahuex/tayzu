/**
 * The accept page's own step-up (follow-up of task 6.9, design D11, D15, D16 and Q51, Q74,
 * Q75, Q78, Q79, Q80; spec "High-risk operations prompt for step-up" and "The invitation
 * and password-reset pages follow the page rules").
 *
 * Q80 (answered by the human in chat on 2026-11-20): "An admin invitation for an existing
 * account can be answered `403 AUTH_STEP_UP_REQUIRED` (the session's step-up is not fresh,
 * or the sign-in had no second factor), and the shell's step-up dialog is not mounted on
 * public pages. The accept page shows its own factor field, as the reset page does (Q78):
 * a TOTP or backup code for a user with MFA, the password through `/verify-password`
 * otherwise, then retries the accept once. A Visma Connect session is told to sign in
 * with Visma Connect again."
 * Q75: the variant "follows the session (`signInMethod`, `mfa.enrolled`), never the
 * answer", a second `step_up_required` on the retry fails the call with no new prompt, and
 * a refused code never ends the session (Q74).
 * Spec: "For a local session, the prompt MUST ask for a TOTP or backup code when the user
 * has a second factor, and for the password otherwise, and MAY retry the original request
 * once after a successful verification." Q80 decides that the accept page does retry once.
 * Spec: "Each link page MUST [...] keep both [identifier and token] only in memory, and
 * submit only on the user's action."
 *
 * The server (`apps/api/src/identity/accept-flow.ts` `requireStepUp`,
 * `packages/auth/src/step-up.ts`, `packages/auth/src/auth.ts` hooks):
 *
 * - only an `admin` invitation for an existing account is guarded, after the session, the
 *   email and the token have passed; a stale or absent marker answers `403 {
 *   code: 'AUTH_STEP_UP_REQUIRED' }`, with `data.reauthorizationUrl` only when a Visma
 *   Connect re-authorization was started (a session with `ssoSid`, which no local factor
 *   satisfies);
 * - a successful `/two-factor/verify-totp` or `/verify-backup-code` writes an `mfa` marker
 *   on the session it answers with, also the one the embedded sign-in creates; so a
 *   sign-in that went through a code is already fresh, and every sign-in of an enrolled
 *   user goes through a code (trust-device is refused, Q61);
 * - a successful `/verify-password` writes a `password` marker, which satisfies step-up
 *   only for a user without MFA (Q51); a wrong code answers `401 INVALID_CODE`
 *   (`INVALID_BACKUP_CODE`), a wrong password `400 INVALID_PASSWORD`.
 *
 * Decisions this file pins (orchestrator's call within Q80, open to Checkpoint 2):
 *
 * - The variant comes from session data the page already has, with no extra request: on
 *   the signed-in path, the `GET /v1/me` it read on "I already have an account"
 *   (`signInMethod`, `mfa.enrolled`); on the embedded sign-in path, the sign-in itself
 *   (always a local `password` sign-in, with MFA exactly when it asked for a code).
 * - The factor step replaces the "Accept invitation" button (or the embedded sign-in) with
 *   an intro text, the field and a "Verify and accept" button. A refused factor shows one
 *   alert, empties the field, keeps the step and sends no accept. A successful one sends
 *   exactly one more accept; a second `step_up_required` shows the generic alert and no
 *   field again.
 * - A Visma Connect session gets a note and never a code or password field. The spec's
 *   MUST ("For a Visma Connect session with a re-authorization URL in the answer, the
 *   prompt MUST offer a Visma Connect round trip that starts only on the user's click and
 *   stores at most an in-app return path") holds here too: when the answer carries an
 *   absolute `https:` `reauthorizationUrl` (`isAbsoluteHttpsUrl` of `../lib/external-url.js`),
 *   the note comes with a "Continue with Visma Connect" button. Before the click nothing
 *   is stored, nothing navigates and nothing more is sent. The click stores the return
 *   path through `saveStepUpReturnPath` of `./step-up-return.js`, the dialog's helper, with
 *   the router's current path; `safeReturnPath` refuses the public `/accept-invitation`,
 *   so the stored value is `/`. Then it calls `navigateToExternal(url)` exactly once. The
 *   invitation id and token are never stored, so the note tells the user to open the link
 *   again after verifying. Without a usable URL (missing, `http:`, relative,
 *   protocol-relative or any other scheme) the page shows the note alone, with no button.
 * - No step-up dialog: the page never opens the shell's `StepUpDialog` (it is not mounted
 *   there) and never goes through the step-up store.
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/auth/accept-invitation-page.tsx: unchanged export. On a `step_up_required`
 * // answer of the session-path accept, the page shows its own factor step and calls
 * // `verifyTotp`, `verifyBackupCode` or `verifyPassword` of `useAuthClient()` directly
 * // (never `useMutation`, never `withStepUp` or the step-up store), then
 * // `acceptInvitation(link)` exactly once more. For a Visma Connect session it shows the
 * // note and, for an absolute `https:` `reauthorizationUrl`, a button whose click calls
 * // `saveStepUpReturnPath(<router's current path>)` then `navigateToExternal(url)`.
 * export function AcceptInvitationPage(): React.JSX.Element;
 *
 * // Unchanged, reused: src/auth/step-up-return.ts and src/lib/navigate-away.ts (mocked
 * // here, as in `step-up-sso.test.tsx`).
 * export function saveStepUpReturnPath(path: string): void;
 * export function navigateToExternal(url: string): void;
 * ```
 *
 * Texts (the `auth` namespace, English pinned here; `es` gets the same keys):
 *
 * - `acceptInvitation.stepUpCodeIntro`: "Accepting this invitation needs a recent
 *   verification. Enter an authentication code or a backup code."
 * - `acceptInvitation.stepUpPasswordIntro`: "Accepting this invitation needs a recent
 *   verification. Enter your password."
 * - `acceptInvitation.stepUpVismaConnect`: "Accepting this invitation needs a recent
 *   verification with Visma Connect. This page does not keep the invitation, so after you
 *   verify, open the invitation link again."
 * - `acceptInvitation.stepUpVismaConnectContinue`: "Continue with Visma Connect" (a button)
 * - `acceptInvitation.stepUpCode`: "Authentication code" (`autocomplete="one-time-code"`)
 * - `acceptInvitation.stepUpBackupCode`: "Backup code" (`autocomplete="one-time-code"`)
 * - `acceptInvitation.stepUpUseBackupCode`: "Use a backup code" (a button)
 * - `acceptInvitation.stepUpCodeRequired`: "Enter the code."
 * - `acceptInvitation.stepUpPassword`: "Password" (`type="password"`,
 *   `autocomplete="current-password"`)
 * - `acceptInvitation.stepUpPasswordRequired`: "Enter your password."
 * - `acceptInvitation.stepUpInvalidCode`: "The code is not valid." (an `alert`)
 * - `acceptInvitation.stepUpPasswordIncorrect`: "The password is incorrect." (an `alert`)
 * - `acceptInvitation.stepUpSubmit`: "Verify and accept" (the submit button)
 *
 * An empty field blocks the submit with no request, as the field's accessible description
 * with `aria-invalid="true"`. The field is emptied after every request. Success is the
 * existing "You have joined the organization." with the "Continue" link. The generic
 * failure is the existing "The invitation could not be accepted. Try again later."
 *
 * The network is a fake `fetch` behind the real auth and API clients (D16), playing the
 * server; every server message holds `server-text`, which the page must never show. The
 * harness is the one of `accept-invitation.test.tsx`.
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
import { navigateToExternal } from '../lib/navigate-away.js';
import { createThemeStore } from '../state/theme.js';

import { STEP_UP_RETURN_KEY } from './step-up-return.js';

// jsdom's `location.assign` can be neither replaced nor spied on (Q72).
vi.mock('../lib/navigate-away.js', () => ({ navigateToExternal: vi.fn() }));

/** A Better Auth id (32 characters) and `043` D4's token (32 bytes, base64url, 43). */
const INVITATION_ID = 'Inv0aB1cD2eF3gH4iJ5kL6mN7oP8qR9s';
const TOKEN = 'Zq8-Wm3_Rt5Yu7Io9Pa1Sd2Fg4Hj6Kl0Xc3Vb5Nm7Qw';
const FRAGMENT = `#invitation=${INVITATION_ID}&token=${TOKEN}`;

const ACCEPT_PATH = '/accept-invitation';
const ACCEPT_ROUTE = '/v1/auth/invitations/accept';
const SIGN_IN_ROUTE = '/api/auth/sign-in/email';
const VERIFY_TOTP_ROUTE = '/api/auth/two-factor/verify-totp';
const VERIFY_BACKUP_ROUTE = '/api/auth/two-factor/verify-backup-code';
const VERIFY_PASSWORD_ROUTE = '/api/auth/verify-password';
const ME_ROUTE = '/v1/me';

const ADA_PASSWORD = 'Ada-Admin-Password-0101!';
const BEN_PASSWORD = 'Ben-Admin-Password-0202!';
const WRONG_PASSWORD = 'Not-Bens-Password-0303!';
const VALID_TOTP = '246810';
const WRONG_TOTP = '135791';
const VALID_BACKUP_CODE = 'Hq3vN-8tLwz';
const WRONG_BACKUP_CODE = 'Zz9zZ-9zZzz';
const REAUTHORIZATION_URL =
  'https://connect.visma.com/connect/authorize?client_id=tayzu&state=server-state-value';

/** Every value that must live only in the page's memory (D11, D15, Q20). */
const SECRETS = [
  INVITATION_ID,
  TOKEN,
  ADA_PASSWORD,
  BEN_PASSWORD,
  WRONG_PASSWORD,
  VALID_TOTP,
  WRONG_TOTP,
  VALID_BACKUP_CODE,
  WRONG_BACKUP_CODE,
];

const TITLE = 'Accept your invitation';
const EXISTING_ACCOUNT = 'I already have an account';
const SIGN_IN_AND_ACCEPT = 'Sign in and accept';
const ACCEPT = 'Accept invitation';
const JOINED = 'You have joined the organization.';
const ACCEPT_FAILED = 'The invitation could not be accepted. Try again later.';

/** `auth:acceptInvitation.stepUp*`, English. */
const STEP_UP_CODE_INTRO =
  'Accepting this invitation needs a recent verification. Enter an authentication code or a backup code.';
const STEP_UP_PASSWORD_INTRO =
  'Accepting this invitation needs a recent verification. Enter your password.';
const STEP_UP_VISMA_CONNECT =
  'Accepting this invitation needs a recent verification with Visma Connect. This page does not keep the invitation, so after you verify, open the invitation link again.';
const STEP_UP_VISMA_CONNECT_CONTINUE = 'Continue with Visma Connect';
const STEP_UP_CODE = 'Authentication code';
const STEP_UP_BACKUP_CODE = 'Backup code';
const STEP_UP_USE_BACKUP_CODE = 'Use a backup code';
const STEP_UP_CODE_REQUIRED = 'Enter the code.';
const STEP_UP_PASSWORD = 'Password';
const STEP_UP_PASSWORD_REQUIRED = 'Enter your password.';
const STEP_UP_INVALID_CODE = 'The code is not valid.';
const STEP_UP_PASSWORD_INCORRECT = 'The password is incorrect.';
const STEP_UP_SUBMIT = 'Verify and accept';

/** The shell's step-up dialog (`auth:stepUp.title`), which this page never opens. */
const STEP_UP_DIALOG_TITLE = 'Verify your identity';

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
  /** The local password; a Visma Connect account has none on this page. */
  readonly password?: string;
  /** The valid TOTP code; without it the account has no second factor. */
  readonly totp?: string;
  readonly backupCodes?: readonly string[];
  readonly me: MeBody;
}

function meOf(
  id: string,
  email: string,
  options: { mfaEnrolled?: boolean; signInMethod?: MeBody['signInMethod'] } = {},
): MeBody {
  return {
    user: { id, name: email, email },
    organization: { id: 'org_home', name: 'Home Org' },
    role: 'member',
    signInMethod: options.signInMethod ?? 'password',
    mfa: { enrolled: options.mfaEnrolled ?? false },
    gate: 'none',
  };
}

/** An existing local account with TOTP and a backup code, invited as an admin. */
const ADA: Account = {
  email: 'ada@example.com',
  password: ADA_PASSWORD,
  totp: VALID_TOTP,
  backupCodes: [VALID_BACKUP_CODE],
  me: meOf('u_ada', 'ada@example.com', { mfaEnrolled: true }),
};

/** An existing local account without a second factor, invited as an admin. */
const BEN: Account = {
  email: 'ben@example.com',
  password: BEN_PASSWORD,
  me: meOf('u_ben', 'ben@example.com'),
};

/** An existing account signed in through Visma Connect, invited as an admin. */
const VERA: Account = {
  email: 'vera@example.com',
  me: meOf('u_vera', 'vera@example.com', { signInMethod: 'visma-connect' }),
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

/** `requireStepUp`: no fresh marker, with the URL only when a re-authorization started. */
function stepUpRequired(reauthorizationUrl?: string): Response {
  return jsonResponse(403, {
    defined: false,
    code: 'AUTH_STEP_UP_REQUIRED',
    status: 403,
    message: 'server-text: Step-up authentication is required',
    data: reauthorizationUrl === undefined ? {} : { reauthorizationUrl },
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
  /** The invitation's email is this existing account's; the invitation's role is `admin`. */
  readonly invitee: Account;
  /** Signed in from the start, with no fresh step-up marker. */
  readonly signedInAs?: Account;
  /** A verification succeeds but never leaves a marker the guard accepts. */
  readonly markerNeverFresh?: boolean;
  /**
   * A Visma Connect session's `data.reauthorizationUrl`: `REAUTHORIZATION_URL` by
   * default, `null` for none (no re-authorization could be started).
   */
  readonly reauthorizationUrl?: string | null;
}

const ACCEPT_FIELDS: ReadonlySet<string> = new Set(['invitationId', 'token', 'password']);

/**
 * A fake `fetch` playing Better Auth and the API: the accept route of an `admin`
 * invitation for an existing account, in `043` D4's order of work with the 8.5d step-up
 * guard; the local sign-in with its second factor; the step-up factors on a session; and
 * `GET /v1/me`.
 */
function createFakeServer(options: FakeServerOptions) {
  const accounts: Account[] = [options.invitee];
  let session: Account | undefined = options.signedInAs;
  let pendingSecondFactor: Account | undefined;
  /** The session's step-up marker (Q51). */
  let marker: 'mfa' | 'password' | undefined;
  let linkUsed = false;
  const calls: RecordedRequest[] = [];

  function fresh(account: Account): boolean {
    if (options.markerNeverFresh === true) return false;
    return marker === 'mfa' || (marker === 'password' && account.totp === undefined);
  }

  function accept(input: Record<string, unknown>, crossSiteSafe: boolean): Response {
    if (Object.keys(input).some((key) => !ACCEPT_FIELDS.has(key))) return malformedBody();
    if (linkUsed || input.invitationId !== INVITATION_ID || input.token !== TOKEN) {
      return uniformRejection();
    }
    const { invitee } = options;
    // The existing-account path: only the invitee's own session, read with the CSRF header.
    if (!crossSiteSafe || session !== invitee) return uniformRejection();
    // 8.5d: an `admin` invitation needs a fresh step-up, checked only after the above.
    if (invitee.me.signInMethod === 'visma-connect') {
      const url =
        options.reauthorizationUrl === undefined ? REAUTHORIZATION_URL : options.reauthorizationUrl;
      return stepUpRequired(url ?? undefined);
    }
    if (!fresh(invitee)) return stepUpRequired();
    linkUsed = true;
    return jsonResponse(200, { userId: invitee.me.user.id });
  }

  function signIn(input: Record<string, unknown>): Response {
    const account = accounts.find((candidate) => candidate.email === input.email);
    if (account?.password === undefined || account.password !== input.password) {
      return jsonResponse(401, {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'server-text: invalid email or password',
      });
    }
    marker = undefined;
    if (account.totp !== undefined) {
      pendingSecondFactor = account;
      return jsonResponse(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    }
    session = account;
    return jsonResponse(200, { redirect: false, token: 'session-token', user: account.me.user });
  }

  /** A sign-in's second factor, or a step-up on the current session. */
  function verifyCode(input: Record<string, unknown>, kind: 'totp' | 'backup'): Response {
    const account = pendingSecondFactor ?? session;
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
    marker = 'mfa';
    return jsonResponse(200, { token: 'session-token', user: account.me.user });
  }

  function verifyPassword(input: Record<string, unknown>): Response {
    if (session === undefined) {
      return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'server-text: no session' });
    }
    if (session.password === undefined || session.password !== input.password) {
      return jsonResponse(400, {
        code: 'INVALID_PASSWORD',
        message: 'server-text: Invalid password',
      });
    }
    // Q51: a password re-entry never shadows a fresh `mfa` marker.
    if (marker !== 'mfa') marker = 'password';
    return jsonResponse(200, { status: true });
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
      if (pathname === VERIFY_TOTP_ROUTE) return verifyCode(input, 'totp');
      if (pathname === VERIFY_BACKUP_ROUTE) return verifyCode(input, 'backup');
      if (pathname === VERIFY_PASSWORD_ROUTE) return verifyPassword(input);
    }
    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
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

interface RenderedApp {
  readonly history: RouterHistory;
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
}

/** The browser history of the running test, destroyed after it. */
let activeHistory: RouterHistory | undefined;

/**
 * Opens `url` (path, query and fragment) in jsdom's window and renders the whole app on
 * a browser history, as `main.tsx` does (session gate, shell and providers).
 */
async function renderApp(url: string, server: FakeServer): Promise<RenderedApp> {
  window.history.replaceState(null, '', url);
  const history = createBrowserHistory();
  activeHistory = history;
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
  return { history, router, queryClient };
}

/** Waits for the accept page and returns its `main` landmark. */
async function acceptPage(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: TITLE });
  const main = heading.closest('main');
  if (main === null) throw new Error('The accept heading is not inside a main landmark');
  return main;
}

type User = ReturnType<typeof userEvent.setup>;

async function fill(field: HTMLElement, user: User, value: string): Promise<void> {
  await user.clear(field);
  if (value !== '') await user.type(field, value);
}

/** Chooses "I already have an account". */
async function chooseExistingAccount(user: User): Promise<HTMLElement> {
  const main = await acceptPage();
  await user.click(await within(main).findByRole('button', { name: EXISTING_ACCOUNT }));
  return main;
}

/** Signed in: chooses the account, then clicks "Accept invitation". */
async function acceptSignedIn(user: User): Promise<HTMLElement> {
  const main = await chooseExistingAccount(user);
  await user.click(await within(main).findByRole('button', { name: ACCEPT }));
  return main;
}

/** Signed out: chooses the account, then submits the embedded sign-in. */
async function submitEmbeddedSignIn(user: User, email: string, password: string): Promise<void> {
  const main = await chooseExistingAccount(user);
  await fill(await within(main).findByRole('textbox', { name: 'Email' }), user, email);
  await fill(within(main).getByLabelText('Password'), user, password);
  await user.click(within(main).getByRole('button', { name: SIGN_IN_AND_ACCEPT }));
}

/** Fills the step-up field and clicks "Verify and accept". */
async function submitStepUp(user: User, label: string, value: string): Promise<void> {
  const main = await acceptPage();
  await fill(await within(main).findByLabelText(label), user, value);
  await user.click(within(main).getByRole('button', { name: STEP_UP_SUBMIT }));
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

/** Every key and value of `storage`, in order. */
function entriesOf(storage: Storage): [string, string | null][] {
  const entries: [string, string | null][] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) entries.push([key, storage.getItem(key)]);
  }
  return entries;
}

/**
 * Storage, the address, the history, the caches and the document hold no secret. With
 * `returnPathStored`, `sessionStorage` holds exactly the step-up return path `/`.
 */
function expectNothingKept(
  app: RenderedApp,
  options: { readonly returnPathStored?: boolean } = {},
): void {
  expect(window.localStorage).toHaveLength(0);
  expect(entriesOf(window.sessionStorage)).toEqual(
    options.returnPathStored === true ? [[STEP_UP_RETURN_KEY, '/']] : [],
  );
  expect(window.location.hash).toBe('');
  expect(window.location.href).not.toContain('#');
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

/** The page never left `/accept-invitation`. */
function expectStillOnAcceptPage(app: RenderedApp): void {
  expect(window.location.pathname).toBe(ACCEPT_PATH);
  expect(app.history.location.pathname).toBe(ACCEPT_PATH);
  expect(screen.queryByRole('heading', { name: 'Sign in to Tayzu' })).not.toBeInTheDocument();
  expect(navigateToExternal).not.toHaveBeenCalled();
}

/** The page handles the step-up itself: the shell's step-up dialog never appears. */
function expectNoStepUpDialog(): void {
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.queryByText(STEP_UP_DIALOG_TITLE)).not.toBeInTheDocument();
}

/** Lets any request the page might still send on its own go out. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const ACCEPT_BODY = { invitationId: INVITATION_ID, token: TOKEN };

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.mocked(navigateToExternal).mockReset();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  activeHistory?.destroy();
  activeHistory = undefined;
  window.history.replaceState(null, '', '/');
});

describe('a user with MFA verifies on the page', () => {
  it('GIVEN a signed-in invitee with TOTP and no fresh verification, WHEN the accept is answered step_up_required and they enter a valid code, THEN the page verifies it, retries the accept exactly once and they join', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);

    // The page's own factor step, chosen from the session (`mfa.enrolled`).
    expect(await within(main).findByText(STEP_UP_CODE_INTRO)).toBeInTheDocument();
    const code = within(main).getByLabelText(STEP_UP_CODE);
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(within(main).getByRole('button', { name: STEP_UP_USE_BACKUP_CODE })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: STEP_UP_SUBMIT })).toBeInTheDocument();
    expect(within(main).queryByLabelText(STEP_UP_PASSWORD)).not.toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: ACCEPT })).not.toBeInTheDocument();
    expect(within(main).queryByRole('alert')).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
    expectNoStepUpDialog();
    expectStillOnAcceptPage(app);
    expectNothingKept(app);

    await submitStepUp(user, STEP_UP_CODE, VALID_TOTP);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    expect(within(main).getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/');
    expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_TOTP_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(VERIFY_TOTP_ROUTE)).toEqual([{ code: VALID_TOTP }]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectTokenOnlyInAcceptBodies(server);
    expectNoStepUpDialog();
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
    expectNoServerText();
  });

  it('accepts after a backup code entered in the step-up field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await user.click(await within(main).findByRole('button', { name: STEP_UP_USE_BACKUP_CODE }));
    const backup = within(main).getByLabelText(STEP_UP_BACKUP_CODE);
    expect(backup).toHaveAttribute('autocomplete', 'one-time-code');
    expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);

    await submitStepUp(user, STEP_UP_BACKUP_CODE, VALID_BACKUP_CODE);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_BACKUP_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(VERIFY_BACKUP_ROUTE)).toEqual([{ code: VALID_BACKUP_CODE }]);
    expect(server.bodiesTo(VERIFY_TOTP_ROUTE)).toEqual([]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectTokenOnlyInAcceptBodies(server);
    expectNoStepUpDialog();
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
    expectNoServerText();
  });

  it('needs no step-up after an embedded sign-in that went through a code, since that code is fresh', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await submitEmbeddedSignIn(user, ADA.email, ADA_PASSWORD);
    const main = await acceptPage();
    await fill(await within(main).findByLabelText('Authentication code'), user, VALID_TOTP);
    await user.click(within(main).getByRole('button', { name: 'Verify and accept' }));

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${SIGN_IN_ROUTE}`,
      `POST ${VERIFY_TOTP_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(within(main).queryByText(STEP_UP_CODE_INTRO)).not.toBeInTheDocument();
    expectNoStepUpDialog();
    expectNothingKept(app);
  });
});

describe('a user without MFA verifies with the password', () => {
  it('GIVEN a signed-in invitee without a second factor, WHEN the accept is answered step_up_required and they re-enter their password, THEN the page sends it to verify-password, retries the accept exactly once and they join', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN, signedInAs: BEN });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);

    expect(await within(main).findByText(STEP_UP_PASSWORD_INTRO)).toBeInTheDocument();
    const password = within(main).getByLabelText(STEP_UP_PASSWORD);
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
    expect(
      within(main).queryByRole('button', { name: STEP_UP_USE_BACKUP_CODE }),
    ).not.toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: ACCEPT })).not.toBeInTheDocument();
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
    expectNoStepUpDialog();

    await submitStepUp(user, STEP_UP_PASSWORD, BEN_PASSWORD);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_PASSWORD_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(VERIFY_PASSWORD_ROUTE)).toEqual([{ password: BEN_PASSWORD }]);
    // The session path: the retry carries no password either.
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectTokenOnlyInAcceptBodies(server);
    expectNoStepUpDialog();
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
    expectNoServerText();
  });

  it('asks for the password, with no extra request, after an embedded sign-in that had no second factor', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await submitEmbeddedSignIn(user, BEN.email, BEN_PASSWORD);
    const main = await acceptPage();

    expect(await within(main).findByText(STEP_UP_PASSWORD_INTRO)).toBeInTheDocument();
    const password = within(main).getByLabelText(STEP_UP_PASSWORD);
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    // The embedded sign-in is gone: one password field, the step-up's, and it is empty.
    expect(within(main).queryByRole('textbox', { name: 'Email' })).not.toBeInTheDocument();
    expect(
      within(main).queryByRole('button', { name: SIGN_IN_AND_ACCEPT }),
    ).not.toBeInTheDocument();
    expect(main.querySelectorAll('input')).toHaveLength(1);
    expect(password).toHaveValue('');
    expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
    // The variant comes from the sign-in itself: no `GET /v1/me` after it.
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${SIGN_IN_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expectNoStepUpDialog();
    expectNothingKept(app);

    await submitStepUp(user, STEP_UP_PASSWORD, BEN_PASSWORD);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${SIGN_IN_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_PASSWORD_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(VERIFY_PASSWORD_ROUTE)).toEqual([{ password: BEN_PASSWORD }]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectTokenOnlyInAcceptBodies(server);
    expectNoStepUpDialog();
    expectStillOnAcceptPage(app);
    expectNothingKept(app);
    expectNoServerText();
  });
});

describe('a refused factor', () => {
  it('refuses a wrong code with one message and no retry, empties the field, keeps the step, and accepts once with the valid one', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await submitStepUp(user, STEP_UP_CODE, WRONG_TOTP);

    expect(await within(main).findByRole('alert')).toHaveTextContent(STEP_UP_INVALID_CODE);
    expect(within(main).getAllByRole('alert')).toHaveLength(1);
    const code = within(main).getByLabelText(STEP_UP_CODE);
    expect(code).toHaveValue('');
    expect(within(main).getByText(STEP_UP_CODE_INTRO)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_TOTP_ROUTE}`,
    ]);
    // Better Auth's 401 for a wrong code is not a lost session (Q74).
    expect(within(main).queryByRole('button', { name: EXISTING_ACCOUNT })).not.toBeInTheDocument();
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();

    await submitStepUp(user, STEP_UP_CODE, VALID_TOTP);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.bodiesTo(VERIFY_TOTP_ROUTE)).toEqual([
      { code: WRONG_TOTP },
      { code: VALID_TOTP },
    ]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectNothingKept(app);
  });

  it('refuses a wrong backup code with the same message and no retry', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await user.click(await within(main).findByRole('button', { name: STEP_UP_USE_BACKUP_CODE }));
    await submitStepUp(user, STEP_UP_BACKUP_CODE, WRONG_BACKUP_CODE);

    expect(await within(main).findByRole('alert')).toHaveTextContent(STEP_UP_INVALID_CODE);
    expect(within(main).getByLabelText(STEP_UP_BACKUP_CODE)).toHaveValue('');
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_BACKUP_ROUTE}`,
    ]);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();
  });

  it('refuses a wrong password with one message and no retry, empties the field, and accepts once with the right one', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN, signedInAs: BEN });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await submitStepUp(user, STEP_UP_PASSWORD, WRONG_PASSWORD);

    expect(await within(main).findByRole('alert')).toHaveTextContent(STEP_UP_PASSWORD_INCORRECT);
    expect(within(main).getAllByRole('alert')).toHaveLength(1);
    expect(within(main).getByLabelText(STEP_UP_PASSWORD)).toHaveValue('');
    expect(within(main).getByText(STEP_UP_PASSWORD_INTRO)).toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_PASSWORD_ROUTE}`,
    ]);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();

    await submitStepUp(user, STEP_UP_PASSWORD, BEN_PASSWORD);

    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.bodiesTo(VERIFY_PASSWORD_ROUTE)).toEqual([
      { password: WRONG_PASSWORD },
      { password: BEN_PASSWORD },
    ]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectNothingKept(app);
  });

  it('refuses an empty code on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    const code = await within(main).findByLabelText(STEP_UP_CODE);
    await user.click(within(main).getByRole('button', { name: STEP_UP_SUBMIT }));

    await waitFor(() => {
      expect(code).toHaveAttribute('aria-invalid', 'true');
    });
    expect(code).toHaveAccessibleDescription(STEP_UP_CODE_REQUIRED);
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
  });

  it('refuses an empty password on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN, signedInAs: BEN });
    await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    const password = await within(main).findByLabelText(STEP_UP_PASSWORD);
    await user.click(within(main).getByRole('button', { name: STEP_UP_SUBMIT }));

    await waitFor(() => {
      expect(password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(password).toHaveAccessibleDescription(STEP_UP_PASSWORD_REQUIRED);
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
  });
});

describe('one retry only', () => {
  it('shows the generic failure, with no new field and no further request, when the retry is answered step_up_required again', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: ADA, signedInAs: ADA, markerNeverFresh: true });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await submitStepUp(user, STEP_UP_CODE, VALID_TOTP);

    expect(await within(main).findByRole('alert')).toHaveTextContent(ACCEPT_FAILED);
    expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
    expect(within(main).queryByLabelText(STEP_UP_BACKUP_CODE)).not.toBeInTheDocument();
    expect(within(main).queryByLabelText(STEP_UP_PASSWORD)).not.toBeInTheDocument();
    expect(within(main).queryByText(STEP_UP_CODE_INTRO)).not.toBeInTheDocument();
    expect(within(main).queryByText(JOINED)).not.toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_TOTP_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();
  });

  it('does the same for the password variant', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN, signedInAs: BEN, markerNeverFresh: true });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);
    await submitStepUp(user, STEP_UP_PASSWORD, BEN_PASSWORD);

    expect(await within(main).findByRole('alert')).toHaveTextContent(ACCEPT_FAILED);
    expect(within(main).queryByLabelText(STEP_UP_PASSWORD)).not.toBeInTheDocument();
    expect(within(main).queryByText(STEP_UP_PASSWORD_INTRO)).not.toBeInTheDocument();
    await settle();
    expect(server.routes()).toEqual([
      `GET ${ME_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
      `POST ${VERIFY_PASSWORD_ROUTE}`,
      `POST ${ACCEPT_ROUTE}`,
    ]);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
  });
});

/** A Visma Connect session's step-up: the note, and never a local factor. */
function expectVismaConnectNoteOnly(main: HTMLElement): void {
  expect(within(main).getByText(STEP_UP_VISMA_CONNECT)).toBeInTheDocument();
  // The variant follows the session, never the answer: no local factor at all.
  expect(main.querySelector('input')).toBeNull();
  expect(within(main).queryByRole('textbox')).not.toBeInTheDocument();
  expect(within(main).queryByLabelText(STEP_UP_CODE)).not.toBeInTheDocument();
  expect(within(main).queryByLabelText(STEP_UP_PASSWORD)).not.toBeInTheDocument();
  expect(within(main).queryByRole('button', { name: STEP_UP_SUBMIT })).not.toBeInTheDocument();
  expect(
    within(main).queryByRole('button', { name: STEP_UP_USE_BACKUP_CODE }),
  ).not.toBeInTheDocument();
  expect(within(main).queryByText(STEP_UP_CODE_INTRO)).not.toBeInTheDocument();
  expect(within(main).queryByText(STEP_UP_PASSWORD_INTRO)).not.toBeInTheDocument();
  expect(within(main).queryByText(ACCEPT_FAILED)).not.toBeInTheDocument();
}

describe('a Visma Connect session', () => {
  it('GIVEN a signed-in invitee whose session came from Visma Connect, WHEN the accept is answered step_up_required with a re-authorization URL, THEN the page shows the note and a "Continue with Visma Connect" button, with no code or password field, and stores, navigates and sends nothing before the click', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: VERA, signedInAs: VERA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    const main = await acceptSignedIn(user);

    expect(await within(main).findByText(STEP_UP_VISMA_CONNECT)).toBeInTheDocument();
    expectVismaConnectNoteOnly(main);
    expect(
      within(main).getByRole('button', { name: STEP_UP_VISMA_CONNECT_CONTINUE }),
    ).toBeInTheDocument();
    // The round trip leaves only through `navigateToExternal`, never through a rendered URL.
    expect(documentSnapshot()).not.toContain('server-state-value');
    await settle();
    // Nothing more is sent, nothing is stored, and the page did not leave on its own.
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
    expect(navigateToExternal).not.toHaveBeenCalled();
    expect(entriesOf(window.sessionStorage)).toEqual([]);
    expectTokenOnlyInAcceptBodies(server);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();
  });

  it('on the click, stores the return path `/` through the step-up helper, never the id or the token, then navigates to the re-authorization URL exactly once', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: VERA, signedInAs: VERA });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);
    // What `sessionStorage` held at the moment the page left.
    let storedWhenLeaving: [string, string | null][] | undefined;
    vi.mocked(navigateToExternal).mockImplementation(() => {
      storedWhenLeaving = entriesOf(window.sessionStorage);
    });

    const main = await acceptSignedIn(user);
    await user.click(
      await within(main).findByRole('button', { name: STEP_UP_VISMA_CONNECT_CONTINUE }),
    );
    await settle();

    expect(navigateToExternal).toHaveBeenCalledTimes(1);
    expect(navigateToExternal).toHaveBeenCalledWith(REAUTHORIZATION_URL);
    // `safeReturnPath` refuses the public `/accept-invitation`: the stored path is `/`.
    expect(storedWhenLeaving).toEqual([[STEP_UP_RETURN_KEY, '/']]);
    expect(entriesOf(window.sessionStorage)).toEqual([[STEP_UP_RETURN_KEY, '/']]);
    expect(window.localStorage).toHaveLength(0);
    for (const secret of [INVITATION_ID, TOKEN]) {
      expect(storageText().includes(secret), `storage holds ${secret}`).toBe(false);
    }
    // The click itself sends nothing: the round trip is the navigation.
    expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
    expectTokenOnlyInAcceptBodies(server);
    expectNoStepUpDialog();
    expectNothingKept(app, { returnPathStored: true });
    expectNoServerText();
  });

  it.each([
    ['missing', null],
    ['http:', 'http://connect.visma.com/connect/authorize?client_id=tayzu&state=s1-9f2c'],
    ['relative', '/connect/authorize?client_id=tayzu&state=s1-9f2c'],
    ['protocol-relative', '//connect.visma.com/connect/authorize?client_id=tayzu&state=s1-9f2c'],
    ['javascript:', 'javascript:alert(document.domain)'],
  ])(
    'shows the note alone, with no button, no storage and no navigation, for a %s reauthorizationUrl',
    async (_case, reauthorizationUrl) => {
      const user = userEvent.setup();
      const server = createFakeServer({ invitee: VERA, signedInAs: VERA, reauthorizationUrl });
      const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

      const main = await acceptSignedIn(user);

      expect(await within(main).findByText(STEP_UP_VISMA_CONNECT)).toBeInTheDocument();
      expectVismaConnectNoteOnly(main);
      expect(
        within(main).queryByRole('button', { name: STEP_UP_VISMA_CONNECT_CONTINUE }),
      ).not.toBeInTheDocument();
      expect(
        within(main).queryByRole('button', { name: /visma connect/i }),
      ).not.toBeInTheDocument();
      await settle();
      expect(server.routes()).toEqual([`GET ${ME_ROUTE}`, `POST ${ACCEPT_ROUTE}`]);
      expect(navigateToExternal).not.toHaveBeenCalled();
      expect(entriesOf(window.sessionStorage)).toEqual([]);
      expectStillOnAcceptPage(app);
      expectNoStepUpDialog();
      expectNothingKept(app);
      expectNoServerText();
    },
  );
});

describe('the token stays in memory throughout the step-up', () => {
  it('keeps the id, the token and every factor out of storage, the address, the history, the caches and the document, at the field, after a refusal and after joining', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ invitee: BEN });
    const app = await renderApp(`${ACCEPT_PATH}${FRAGMENT}`, server);

    await submitEmbeddedSignIn(user, BEN.email, BEN_PASSWORD);
    const main = await acceptPage();
    expect(await within(main).findByLabelText(STEP_UP_PASSWORD)).toBeInTheDocument();
    expectNothingKept(app);

    await submitStepUp(user, STEP_UP_PASSWORD, WRONG_PASSWORD);
    expect(await within(main).findByRole('alert')).toHaveTextContent(STEP_UP_PASSWORD_INCORRECT);
    expectNothingKept(app);

    await submitStepUp(user, STEP_UP_PASSWORD, BEN_PASSWORD);
    expect(await within(main).findByText(JOINED)).toBeInTheDocument();
    await settle();
    expect(server.bodiesTo(ACCEPT_ROUTE)).toEqual([ACCEPT_BODY, ACCEPT_BODY]);
    // Neither the sign-in password nor the step-up password reaches an accept body.
    for (const body of server.bodiesTo(ACCEPT_ROUTE)) {
      expect(JSON.stringify(body)).not.toContain(BEN_PASSWORD);
      expect(JSON.stringify(body)).not.toContain(WRONG_PASSWORD);
    }
    expectTokenOnlyInAcceptBodies(server);
    expectStillOnAcceptPage(app);
    expectNoStepUpDialog();
    expectNothingKept(app);
    expectNoServerText();
  });
});
