/**
 * The local step-up dialog (task 6.5, design D4, D11, D12, D15, D16 and Q12, Q64, Q69,
 * Q71, Q74; spec "High-risk operations prompt for step-up", scenarios "A local user
 * verifies with TOTP" and "A user without MFA verifies with the password").
 *
 * D11 (Step-up dialog): "Any call answered `step_up_required` opens one dialog (a Zustand
 * store holds the pending retry, not its input on disk). The dialog is chosen from the
 * session's `signInMethod` in `GET /v1/me` (D8), not from the presence of a URL, because
 * a TOTP or password verification never satisfies an SSO session [...]: a local session
 * with MFA: a TOTP field (or a backup code), then `/two-factor/verify-totp`, and the
 * original request is retried once, because the user's click on "Verify" is the user
 * action; a local session without MFA: password re-entry through
 * `/api/auth/verify-password`, then one retry."
 * D11: "Password fields use `autocomplete="current-password"` [...], are never echoed,
 * stored or logged, and are cleared from form state after a submit."
 * D12 (State): "Zustand holds only the theme, the locale and the step-up dialog." Q69:
 * sign-out and any `unauthenticated` answer reset the session-bound stores, the step-up
 * dialog's among them (`resetSessionStores`).
 * Q74: Better Auth's `401 INVALID_CODE` on a code check never counts as a lost session.
 * Spec: "For a local session, the prompt MUST ask for a TOTP or backup code when the user
 * has a second factor, and for the password otherwise, and MAY retry the original request
 * once after a successful verification." The spec's MAY is D11's decided "retried once",
 * which task 6.5 requires ("then one retry of the original request").
 * Scenario "A local user verifies with TOTP": GIVEN a signed-in user with TOTP and no
 * fresh verification, WHEN they delete an entity and enter a valid code in the prompt,
 * THEN the deletion completes.
 * Scenario "A user without MFA verifies with the password": GIVEN a signed-in user
 * without a second factor, WHEN they delete an entity and re-enter their password in the
 * prompt, THEN the deletion completes.
 *
 * Server behaviour played by the fake (`packages/auth/src/step-up.ts`, `auth.ts` hooks,
 * `apps/api/src/server.ts` and `better-auth@1.7.7`): a high-risk call without a fresh
 * marker answers `403 AUTH_STEP_UP_REQUIRED` (with `data.reauthorizationUrl` only when a
 * Visma Connect re-authorization was started); a successful `/two-factor/verify-totp` or
 * `/verify-backup-code` writes an `mfa` marker, a successful `/verify-password` a
 * `password` marker, which satisfies step-up only for a user without MFA (Q51). A wrong
 * code answers `401 INVALID_CODE` (`INVALID_BACKUP_CODE`), a wrong password `400
 * INVALID_PASSWORD`. A Visma Connect session is never satisfied by a local factor.
 *
 * The contract this file pins for the implementer:
 *
 * ```ts
 * // src/state/step-up.ts: the session-bound step-up store (Zustand) and its helper.
 * export type StepUpOutcome = 'verified' | 'cancelled';
 * export interface StepUpRequest { readonly reauthorizationUrl?: string }
 * export interface StepUpState {
 *   // The open request, or `null` when the dialog is closed.
 *   readonly request: StepUpRequest | null;
 *   // Opens the dialog; resolves once the user verifies or cancels, or the session ends.
 *   requestStepUp(request: StepUpRequest): Promise<StepUpOutcome>;
 *   // Closes the dialog and resolves the pending request with `outcome`.
 *   settleStepUp(outcome: StepUpOutcome): void;
 * }
 * export const useStepUpStore: UseBoundStore<StoreApi<StepUpState>>;
 * // Resolves a pending request as 'cancelled' and clears it; `resetSessionStores()`
 * // (src/state/session-stores.ts) calls it.
 * export function resetStepUpStore(): void;
 * // Runs `call`. When it fails with the `step_up_required` kind, opens the dialog with
 * // the answer's `reauthorizationUrl`; on 'verified' it runs `call` exactly once more and
 * // answers (or rejects with) that second result as is, never opening the dialog again;
 * // on 'cancelled' it rejects with the original error. Any other failure is rethrown
 * // without a dialog. A page wraps its `mutationFn` with it.
 * export function withStepUp<T>(call: () => Promise<T>): Promise<T>;
 *
 * // src/auth/step-up-dialog.tsx: `StepUpDialog`, mounted once by `AppShell`. It reads
 * // the session (`SESSION_QUERY_KEY`: `signInMethod`, `mfa.enrolled`) and the auth client
 * // (`useAuthClient()`, or the shell's sources), and calls `verifyTotp`,
 * // `verifyBackupCode` or `verifyPassword` directly, never through `useMutation`, so no
 * // code or password reaches the query or mutation cache. A refused code (`401`) is not
 * // an `unauthenticated` session end.
 * ```
 *
 * The dialog (texts from the `auth` namespace, English pinned here): a modal `dialog`
 * named `auth:stepUp.title` ("Verify your identity"). Focus moves into it on open and
 * back to the element that had it (the page's trigger) on close. A "Cancel" button
 * (`auth:stepUp.cancel`) and `Escape` close it as 'cancelled'.
 *
 * - `signInMethod: 'password'` with `mfa.enrolled`: a textbox "Authentication code"
 *   (`auth:stepUp.code`, `autocomplete="one-time-code"`), a "Use a backup code" button
 *   (`auth:stepUp.useBackupCode`) switching it to a textbox "Backup code"
 *   (`auth:stepUp.backupCode`), and a "Verify" button (`auth:stepUp.verify`). Empty:
 *   "Enter the code." (`auth:stepUp.codeRequired`), no request. A refused code is an
 *   `alert` "The code is not valid." (`auth:stepUp.invalidCode`); the dialog stays open
 *   with the field emptied. Never a password field.
 * - `signInMethod: 'password'` without MFA: a "Password" field (`auth:stepUp.password`,
 *   `type="password"`, `autocomplete="current-password"`) and "Verify". Empty: "Enter
 *   your password." (`auth:stepUp.passwordRequired`), no request. A wrong password shows
 *   "The password is incorrect." (`auth:stepUp.passwordIncorrect`); the dialog stays
 *   open. The field is emptied after every request. Never a code field.
 * - `signInMethod: 'visma-connect'`: the same dialog, with no code or password field and
 *   no local verification call (its content is task 6.6's).
 * - On a successful verification the dialog closes as 'verified'.
 *
 * The probe entity page wraps `apiClient.entities.delete` in `withStepUp` inside its
 * `mutationFn` and shows "Deleted" or "Failed: <kind>". The network is a fake `fetch`
 * behind the real API and auth clients (D16); every server message holds `server-text`.
 */
import {
  QueryClientProvider,
  focusManager,
  useMutation,
  type QueryClient,
} from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient, type ApiClient } from '../api/client.js';
import { toApiError } from '../api/errors.js';
import { createQueryClient } from '../api/query-client.js';
import { SESSION_QUERY_KEY, createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { resetSessionStores } from '../state/session-stores.js';
import { useStepUpStore, withStepUp } from '../state/step-up.js';
import { createThemeStore } from '../state/theme.js';

type SignInMethod = 'password' | 'visma-connect';

interface Account {
  readonly signInMethod: SignInMethod;
  readonly enrolled: boolean;
}

const LOCAL_WITH_MFA: Account = { signInMethod: 'password', enrolled: true };
const LOCAL_WITHOUT_MFA: Account = { signInMethod: 'password', enrolled: false };
const VISMA_CONNECT: Account = { signInMethod: 'visma-connect', enrolled: false };

function meOf(account: Account) {
  return {
    user: { id: 'u_lena', name: 'Lena Lopez', email: 'lena@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    // An admin without a factor would be gated (D8): only the enrolled user is an admin.
    role: account.enrolled ? 'admin' : 'member',
    signInMethod: account.signInMethod,
    mfa: { enrolled: account.enrolled },
    gate: 'none',
  };
}

const PASSWORD = 'Account-Password-2026!';
const WRONG_PASSWORD = 'Not-The-Password-1!';
const VALID_CODE = '246810';
const WRONG_CODE = '135791';
const BACKUP_CODE = 'Hq3vN-8tLwz';
const REAUTHORIZATION_URL =
  'https://connect.visma.com/connect/authorize?client_id=tayzu&state=s1&prompt=login';

const ENTITY_PATH = '/catalog/service/payments-api';
const DELETE_PATH = '/v1/blueprints/service/entities/payments-api';

const ACTOR = { type: 'user', id: 'u_lena' } as const;

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
  readonly body: string;
}

interface FakeServerOptions {
  readonly account: Account;
  /** The step-up answer carries a re-authorization URL (as for a started SSO round trip). */
  readonly reauthorizationUrl?: string;
  /** Every delete answers step-up, even after a successful verification (an expired marker). */
  readonly stepUpAlways?: boolean;
  /** The delete answers this instead of the step-up check. */
  readonly deleteAnswer?: 'not_found';
}

/**
 * A fake `fetch` playing the API and Better Auth for one signed-in user, with the
 * step-up freshness marker of `packages/auth/src/step-up.ts`.
 */
function createFakeServer(options: FakeServerOptions) {
  const { account } = options;
  let signedIn = true;
  let marker: 'mfa' | 'password' | null = null;
  const calls: RecordedRequest[] = [];

  function fresh(): boolean {
    if (account.signInMethod === 'visma-connect' || options.stepUpAlways === true) return false;
    return marker === 'mfa' || (marker === 'password' && !account.enrolled);
  }

  function deleteEntity(): Response {
    if (options.deleteAnswer === 'not_found') return orpcError('CATALOG_NOT_FOUND', 404);
    if (fresh()) return new Response(null, { status: 204 });
    return orpcError(
      'AUTH_STEP_UP_REQUIRED',
      403,
      options.reauthorizationUrl === undefined
        ? undefined
        : { reauthorizationUrl: options.reauthorizationUrl },
    );
  }

  function verifyTotp(input: Record<string, unknown>): Response {
    if (!account.enrolled || input.code !== VALID_CODE) {
      return jsonResponse(401, { code: 'INVALID_CODE', message: 'server-text: Invalid code' });
    }
    marker = 'mfa';
    return jsonResponse(200, { token: 'session-token', user: meOf(account).user });
  }

  function verifyBackupCode(input: Record<string, unknown>): Response {
    if (!account.enrolled || input.code !== BACKUP_CODE) {
      return jsonResponse(401, {
        code: 'INVALID_BACKUP_CODE',
        message: 'server-text: Invalid backup code',
      });
    }
    marker = 'mfa';
    return jsonResponse(200, { token: 'session-token', user: meOf(account).user });
  }

  function verifyPassword(input: Record<string, unknown>): Response {
    if (input.password !== PASSWORD) {
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
    calls.push({ method: request.method, url, body });
    const { pathname } = url;
    const input = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);

    if (request.method === 'POST' && pathname === '/api/auth/sign-out') {
      signedIn = false;
      return jsonResponse(200, { success: true });
    }
    if (request.method === 'POST' && pathname.startsWith('/api/auth/')) {
      if (!signedIn) {
        return jsonResponse(401, { code: 'UNAUTHORIZED', message: 'server-text: no session' });
      }
      if (pathname === '/api/auth/two-factor/verify-totp') return verifyTotp(input);
      if (pathname === '/api/auth/two-factor/verify-backup-code') return verifyBackupCode(input);
      if (pathname === '/api/auth/verify-password') return verifyPassword(input);
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (!pathname.startsWith('/v1/')) {
      return jsonResponse(404, { code: 'NOT_FOUND', message: 'server-text: not found' });
    }
    if (!signedIn) return orpcError('CATALOG_CONTEXT_REQUIRED', 401);
    if (request.method === 'GET' && pathname === '/v1/me') return jsonResponse(200, meOf(account));
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
      handle(new Request(input, init)),
    calls,
    callsTo,
    deleteCalls: () => callsTo('DELETE', DELETE_PATH),
    /** Every local verification call: TOTP, backup code and password. */
    verificationCalls: () =>
      calls.filter(
        (call) =>
          call.method === 'POST' &&
          [
            '/api/auth/two-factor/verify-totp',
            '/api/auth/two-factor/verify-backup-code',
            '/api/auth/verify-password',
          ].includes(call.url.pathname),
      ),
    /** The session ends on the server: every later call answers 401. */
    expireSession() {
      signedIn = false;
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

/**
 * The entity page deleting its entity through `withStepUp`, as the real one will (task
 * 8.4). The trigger stays enabled, so focus can return to it.
 */
function entityPageDeleting(apiClient: ApiClient): ComponentType {
  return function EntityProbe(): React.JSX.Element {
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
      <div data-testid="page-entity">
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

interface RenderedApp {
  readonly history: RouterHistory;
  readonly queryClient: QueryClient;
}

/** Renders the whole app (session gate, shell and providers, as `main.tsx`) at the entity. */
async function renderApp(server: FakeServer): Promise<RenderedApp> {
  const history = createMemoryHistory({ initialEntries: [ENTITY_PATH] });
  const queryClient = createQueryClient();
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const themeStore = createThemeStore();
  const router = createAppRouter({
    history,
    pages: {
      signIn: probe('signIn'),
      home: probe('home'),
      catalogTable: probe('catalogTable'),
      entity: entityPageDeleting(apiClient),
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
  await screen.findByTestId('page-entity');
  await screen.findByRole('navigation', { name: 'Catalog' });
  return { history, queryClient };
}

const DIALOG_NAME = 'Verify your identity';
const CODE_LABEL = 'Authentication code';
const BACKUP_LABEL = 'Backup code';
const PASSWORD_LABEL = 'Password';
const INVALID_CODE = 'The code is not valid.';
const PASSWORD_INCORRECT = 'The password is incorrect.';
const CODE_REQUIRED = 'Enter the code.';
const PASSWORD_REQUIRED = 'Enter your password.';

type User = ReturnType<typeof userEvent.setup>;

/** Lets any pending request or render happen before counting calls. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** Clicks the page's Delete button and returns it (the dialog hides it from the tree). */
async function clickDelete(user: User): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: 'Delete' });
  await user.click(trigger);
  return trigger;
}

async function stepUpDialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: DIALOG_NAME });
}

async function expectDialogClosed(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
}

async function submitCode(user: User, dialog: HTMLElement, label: string, code: string) {
  const field = within(dialog).getByRole('textbox', { name: label });
  await user.clear(field);
  if (code !== '') await user.type(field, code);
  await user.click(within(dialog).getByRole('button', { name: 'Verify' }));
}

async function submitPassword(user: User, dialog: HTMLElement, password: string) {
  const field = within(dialog).getByLabelText(PASSWORD_LABEL);
  await user.clear(field);
  if (password !== '') await user.type(field, password);
  await user.click(within(dialog).getByRole('button', { name: 'Verify' }));
}

function passwordInputs(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('input[type="password"]')];
}

/** The dialog offers no local factor at all: no textbox, no password field, no combobox. */
function expectNoFactorField(dialog: HTMLElement): void {
  expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
  expect(within(dialog).queryAllByRole('spinbutton')).toEqual([]);
  expect(passwordInputs(dialog)).toEqual([]);
  expect(dialog.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0);
}

/** Every query and mutation of the cache, and both storages, as one text. */
function clientStateText(queryClient: QueryClient): string {
  const parts: string[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    parts.push(JSON.stringify({ key: query.queryKey, data: query.state.data }));
  }
  for (const mutation of queryClient.getMutationCache().getAll()) {
    parts.push(
      JSON.stringify({
        variables: mutation.state.variables,
        data: mutation.state.data,
        context: mutation.state.context,
      }),
    );
  }
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) parts.push(key, storage.getItem(key) ?? '');
    }
  }
  parts.push(JSON.stringify(useStepUpStore.getState().request));
  return parts.join('\n');
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
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

describe('A local user verifies with TOTP', () => {
  it('opens the dialog on step_up_required, verifies a valid code and completes the deletion', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    expect(server.deleteCalls()).toHaveLength(1);

    const code = within(dialog).getByRole('textbox', { name: CODE_LABEL });
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(passwordInputs(dialog)).toEqual([]);
    expect(within(dialog).queryByLabelText(PASSWORD_LABEL)).not.toBeInTheDocument();

    await submitCode(user, dialog, CODE_LABEL, VALID_CODE);

    await screen.findByText('Deleted');
    await expectDialogClosed();
    const checks = server.callsTo('POST', '/api/auth/two-factor/verify-totp');
    expect(checks).toHaveLength(1);
    expect(JSON.parse(checks[0]?.body ?? '')).toEqual({ code: VALID_CODE });
    expect(server.callsTo('POST', '/api/auth/verify-password')).toHaveLength(0);
  });

  it('switches to a backup code and completes the deletion with it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Use a backup code' }));
    const backup = await within(dialog).findByRole('textbox', { name: BACKUP_LABEL });
    expect(backup).toHaveAttribute('autocomplete', 'one-time-code');

    await submitCode(user, dialog, BACKUP_LABEL, BACKUP_CODE);

    await screen.findByText('Deleted');
    await expectDialogClosed();
    const checks = server.callsTo('POST', '/api/auth/two-factor/verify-backup-code');
    expect(checks).toHaveLength(1);
    expect(JSON.parse(checks[0]?.body ?? '')).toEqual({ code: BACKUP_CODE });
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
    expect(server.deleteCalls()).toHaveLength(2);
  });

  it('chooses the dialog from signInMethod, not from a reauthorizationUrl in the answer', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      account: LOCAL_WITH_MFA,
      reauthorizationUrl: REAUTHORIZATION_URL,
    });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();

    expect(within(dialog).getByRole('textbox', { name: CODE_LABEL })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Visma Connect/ })).not.toBeInTheDocument();
    await submitCode(user, dialog, CODE_LABEL, VALID_CODE);
    await screen.findByText('Deleted');
  });

  it('refuses an empty code on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitCode(user, dialog, CODE_LABEL, '');

    expect(await within(dialog).findByText(CODE_REQUIRED)).toBeInTheDocument();
    await settle();
    expect(server.verificationCalls()).toHaveLength(0);
    expect(server.deleteCalls()).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBeInTheDocument();
  });
});

describe('A user without MFA verifies with the password', () => {
  it('opens the dialog on step_up_required, re-enters the password and completes the deletion', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA });
    const { queryClient } = await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    expect(server.deleteCalls()).toHaveLength(1);

    const password = within(dialog).getByLabelText(PASSWORD_LABEL);
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(within(dialog).queryByRole('textbox', { name: CODE_LABEL })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Use a backup code' }),
    ).not.toBeInTheDocument();

    await submitPassword(user, dialog, PASSWORD);

    await screen.findByText('Deleted');
    await expectDialogClosed();
    const checks = server.callsTo('POST', '/api/auth/verify-password');
    expect(checks).toHaveLength(1);
    expect(JSON.parse(checks[0]?.body ?? '')).toEqual({ password: PASSWORD });
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(0);
    // D11, D15: the password is never kept in the cache, the storages or the store.
    expect(clientStateText(queryClient)).not.toContain(PASSWORD);
  });

  it('refuses a wrong password without a retry, keeps the dialog open and empties the field', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitPassword(user, dialog, WRONG_PASSWORD);

    expect(await within(dialog).findByText(PASSWORD_INCORRECT)).toBeInTheDocument();
    await settle();
    expect(server.callsTo('POST', '/api/auth/verify-password')).toHaveLength(1);
    expect(server.deleteCalls()).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBe(dialog);
    expect(within(dialog).getByLabelText(PASSWORD_LABEL)).toHaveValue('');
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('server-text');

    await submitPassword(user, dialog, PASSWORD);
    await screen.findByText('Deleted');
    expect(server.deleteCalls()).toHaveLength(2);
  });

  it('refuses an empty password on the client, with no request', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitPassword(user, dialog, '');

    expect(await within(dialog).findByText(PASSWORD_REQUIRED)).toBeInTheDocument();
    await settle();
    expect(server.verificationCalls()).toHaveLength(0);
    expect(server.deleteCalls()).toHaveLength(1);
  });
});

describe('a wrong code is refused without a retry', () => {
  it('shows the refusal, keeps the dialog open, never retries and never ends the session (Q74)', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    const { history, queryClient } = await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitCode(user, dialog, CODE_LABEL, WRONG_CODE);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(INVALID_CODE);
    await settle();
    expect(server.callsTo('POST', '/api/auth/two-factor/verify-totp')).toHaveLength(1);
    expect(server.deleteCalls()).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBe(dialog);
    expect(within(dialog).getByRole('textbox', { name: CODE_LABEL })).toHaveValue('');
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Failed:/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('server-text');
    // The 401 INVALID_CODE is not a lost session: no sign-in, the cache is kept.
    expect(history.location.pathname).toBe(ENTITY_PATH);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeDefined();

    await submitCode(user, dialog, CODE_LABEL, VALID_CODE);
    await screen.findByText('Deleted');
    expect(server.deleteCalls()).toHaveLength(2);
  });

  it('refuses a wrong backup code the same way', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    const { history } = await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Use a backup code' }));
    await within(dialog).findByRole('textbox', { name: BACKUP_LABEL });
    await submitCode(user, dialog, BACKUP_LABEL, 'wrong-backup');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(INVALID_CODE);
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: DIALOG_NAME })).toBe(dialog);
    expect(history.location.pathname).toBe(ENTITY_PATH);
  });
});

describe('exactly one retry after success', () => {
  it('sends the original request once more after a successful verification, and no more', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitCode(user, dialog, CODE_LABEL, VALID_CODE);
    await screen.findByText('Deleted');
    await settle();

    const deletes = server.deleteCalls();
    expect(deletes).toHaveLength(2);
    const verifyIndex = server.calls.findIndex(
      (call) => call.url.pathname === '/api/auth/two-factor/verify-totp',
    );
    expect(server.calls.indexOf(deletes[0] as RecordedRequest)).toBeLessThan(verifyIndex);
    expect(server.calls.indexOf(deletes[1] as RecordedRequest)).toBeGreaterThan(verifyIndex);
  });

  it('does not loop: a second step_up_required on the retry fails the call with no new dialog', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA, stepUpAlways: true });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await submitCode(user, dialog, CODE_LABEL, VALID_CODE);

    await screen.findByText('Failed: step_up_required');
    await expectDialogClosed();
    await settle();
    expect(server.deleteCalls()).toHaveLength(2);
    expect(server.verificationCalls()).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useStepUpStore.getState().request).toBeNull();
  });

  it('opens no dialog for any other failure', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA, deleteAnswer: 'not_found' });
    await renderApp(server);

    await clickDelete(user);

    await screen.findByText('Failed: not_found');
    await settle();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(server.deleteCalls()).toHaveLength(1);
  });
});

describe('cancel', () => {
  it('closes the dialog with Cancel and fails the call with step_up_required, with no retry', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    const dialog = await stepUpDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await screen.findByText('Failed: step_up_required');
    await expectDialogClosed();
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toHaveLength(0);
    expect(useStepUpStore.getState().request).toBeNull();
  });

  it('closes the dialog with Escape the same way', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA });
    await renderApp(server);

    await clickDelete(user);
    await stepUpDialog();
    await user.keyboard('{Escape}');

    await screen.findByText('Failed: step_up_required');
    await expectDialogClosed();
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toHaveLength(0);
  });
});

describe('a Visma Connect session is never offered a code or password field', () => {
  it.each([
    ['without a reauthorizationUrl', undefined],
    ['with a reauthorizationUrl', REAUTHORIZATION_URL],
  ])(
    'opens the step-up dialog %s with no factor field and no local verification',
    async (_case, reauthorizationUrl) => {
      const user = userEvent.setup();
      const server = createFakeServer({
        account: VISMA_CONNECT,
        ...(reauthorizationUrl === undefined ? {} : { reauthorizationUrl }),
      });
      await renderApp(server);

      await clickDelete(user);
      const dialog = await stepUpDialog();
      await settle();

      expectNoFactorField(dialog);
      expect(passwordInputs(document.body)).toEqual([]);
      expect(within(dialog).queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole('button', { name: 'Use a backup code' }),
      ).not.toBeInTheDocument();
      expect(server.verificationCalls()).toHaveLength(0);
      expect(server.deleteCalls()).toHaveLength(1);
    },
  );
});

describe('the dialog is accessible (D16)', () => {
  it('is a named dialog that takes focus on open and gives it back to the trigger on cancel', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    const trigger = await clickDelete(user);
    const dialog = await stepUpDialog();

    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expectDialogClosed();

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('gives focus back to the trigger after a successful verification', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA });
    await renderApp(server);

    const trigger = await clickDelete(user);
    const dialog = await stepUpDialog();
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    });
    await submitPassword(user, dialog, PASSWORD);
    await screen.findByText('Deleted');
    await expectDialogClosed();

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});

describe('the session end resets the step-up store (Q69)', () => {
  it('resetSessionStores closes the open dialog and fails the call with no retry', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    await renderApp(server);

    await clickDelete(user);
    await stepUpDialog();
    expect(useStepUpStore.getState().request).not.toBeNull();

    act(() => {
      resetSessionStores();
    });

    await screen.findByText('Failed: step_up_required');
    await expectDialogClosed();
    await settle();
    expect(useStepUpStore.getState().request).toBeNull();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toHaveLength(0);
  });

  it('clears the open request when the session ends while the dialog is open', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA });
    const { history } = await renderApp(server);

    await clickDelete(user);
    await stepUpDialog();

    // The shell's session observer finds the session gone when the window regains focus.
    server.expireSession();
    act(() => {
      focusManager.setFocused(false);
    });
    act(() => {
      focusManager.setFocused(true);
    });

    await screen.findByTestId('page-signIn');
    await waitFor(() => {
      expect(history.location.pathname).toBe('/sign-in');
    });
    await expectDialogClosed();
    await settle();
    expect(useStepUpStore.getState().request).toBeNull();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toHaveLength(0);
  });
});
