/**
 * Entity delete from the entity page (task 8.4, design D4, D11, D13, D15, D16 and Q12,
 * Q63, Q75, Q76, Q84, Q85; spec "High-risk operations prompt for step-up" and "The UI
 * never carries the tenant, the cookie or tenant free text outside the page").
 *
 * D13 (Entity page): "**Delete** (Q12): a confirmation dialog with the `detachReferences`
 * option, the reference-violation answer shown with the readable referrer identifiers and
 * the "+N not visible" count, and the step-up dialog of D11."
 * Q12: "Entity delete only, from the entity page, with the step-up dialog".
 * D4: `reference_violation` keeps "referrer identifiers and the "+N not visible" count";
 * "The UI renders localized text for each kind and never the server's message string".
 * Q75: "`withStepUp(call)` wraps a mutation's `mutationFn`: on `step_up_required` it asks
 * the session-bound step-up store [...] to open the one `StepUpDialog` the shell mounts,
 * retries `call` exactly once after `verified` [...] and rejects with the original error
 * on cancel. The dialog's variant follows the session (`signInMethod`, `mfa.enrolled`)".
 * Q76: a Visma Connect session gets "Continue with Visma Connect" for an absolute `https:`
 * `reauthorizationUrl`; "it never settles `verified`, so nothing is retried".
 * Spec, scenario "A local user verifies with TOTP": GIVEN a signed-in user with TOTP and
 * no fresh verification, WHEN they delete an entity and enter a valid code in the prompt,
 * THEN the deletion completes.
 * Spec, scenario "A user without MFA verifies with the password": GIVEN a signed-in user
 * without a second factor, WHEN they delete an entity and re-enter their password in the
 * prompt, THEN the deletion completes.
 * Spec, scenario "A mutating call carries the CSRF header and no tenant": the request
 * carries `x-csrf-token: orpc` and has no `tenantId` field, header or parameter.
 * Spec, scenario "An internal error shows no server text".
 *
 * Server behaviour played by the fake (`packages/catalog/src/service/entities.ts`,
 * `api/errors.ts`, `contract-definition.ts`): `entities.delete` is
 * `DELETE /v1/blueprints/<bp>/entities/<id>` with `inputStructure: 'detailed'`, so the
 * client input is `{ params: { blueprint, entity }, query: { detachReferences? } }` and the
 * option travels as `?detachReferences=true`; success is `204`. An entity still referenced
 * (and `detachReferences` not set) answers `422 CATALOG_REFERENCE_VIOLATION` with
 * `data.details` `{ referrers, notVisible? }`: `referrers` are bare entity identifiers
 * (`source_identifier`, at most 10, possibly of other blueprints) the caller can read, and
 * `notVisible` (only when above 0) counts the rest. A high-risk call without a fresh
 * verification answers `403 AUTH_STEP_UP_REQUIRED`.
 *
 * Decisions this test pins (the contract for the implementer):
 *
 * - The entity page (the router's default `entity` slot) shows a "Delete entity" button
 *   (`catalog:entity.delete.open`) to every signed-in user, here a `member`: the UI has no
 *   role rule of its own, the server decides (a refusal is the `forbidden` alert).
 * - The button opens a modal `dialog` named `catalog:entity.delete.title`, described by
 *   `catalog:entity.delete.description`, with an unchecked checkbox named
 *   `catalog:entity.delete.detachReferences`, a confirm button
 *   (`catalog:entity.delete.confirm`) and a cancel button (`catalog:entity.delete.cancel`).
 *   Focus moves into the dialog on open; Cancel or `Escape` closes it with no request and
 *   focus back on "Delete entity".
 * - Confirm runs one `useMutation` whose `mutationFn` is
 *   `withStepUp(() => apiClient.entities.delete({ params: { blueprint, entity }, query }))`,
 *   `query` being `{ detachReferences: true }` when the box is checked and no `true`
 *   otherwise. The confirmation dialog stays open while the call is pending, so the shell's
 *   `StepUpDialog` opens over it.
 * - On success (`204`): the dialog closes and the app navigates to `/catalog/<bp>`, whose
 *   table (its `entities.list` queries invalidated) no longer lists the entity. A success
 *   notice is left open, but never an `alert`.
 * - On `reference_violation`: the dialog stays open, on the entity page, and shows one
 *   `alert` holding `catalog:entity.delete.blocked`, a `list` named
 *   `catalog:entity.delete.referrers` with one item per referrer identifier, as text
 *   (bare identifiers carry no blueprint, so they cannot be linked to an entity page), and,
 *   only when `notVisible` is above 0, `catalog:entity.delete.notVisible` with `count`
 *   ("+3 not visible"). The checkbox stays offered: checking it and confirming again
 *   retries with `detachReferences=true`.
 * - On `step_up_required`: the shell's `StepUpDialog` opens (its variant follows the
 *   session); after a local verification the delete is retried once and succeeds as above.
 *   A Visma Connect session gets "Continue with Visma Connect" and nothing is retried.
 *   Cancelling the step-up leaves the user on the entity page with one request sent.
 * - On `forbidden`: one `alert` in the dialog with `catalog:entity.delete.error.forbidden`;
 *   every other kind: one `alert` with `catalog:entity.delete.error.server`. Never the
 *   server's message, never a navigation, and a 4xx is never retried.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16); every server
 * message holds `SERVER_TEXT`.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n } from '../i18n/i18n.js';
import { resetSessionStores } from '../state/session-stores.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `<namespace>:<key>` text in `en`; a missing key fails the test as an assertion. */
function localeText(namespace: 'catalog' | 'auth', key: string): string {
  let node: unknown = LOCALE_FILES[`../i18n/locales/en/${namespace}.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `${namespace}:${key} in en`).toBe(true);
  return node as string;
}

/** The pinned English texts of this task's `catalog:entity.delete.*` keys. */
const PINNED = {
  'entity.delete.open': 'Delete entity',
  'entity.delete.title': 'Delete this entity?',
  'entity.delete.description': 'The entity is deleted permanently. This cannot be undone.',
  'entity.delete.detachReferences': 'Remove the references other entities hold to it',
  'entity.delete.confirm': 'Delete',
  'entity.delete.cancel': 'Cancel',
  'entity.delete.blocked': 'Other entities still reference this entity.',
  'entity.delete.referrers': 'Referencing entities',
  'entity.delete.notVisible': '+{{count}} not visible',
  'entity.delete.error.forbidden': 'You do not have permission to delete this entity.',
  'entity.delete.error.server': 'The entity could not be deleted. Try again later.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The English text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = localeText('catalog', key);
  expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

/** The step-up dialog's texts, pinned by task 6.5 and 6.6. */
const STEP_UP = {
  title: 'Verify your identity',
  code: 'Authentication code',
  password: 'Password',
  verify: 'Verify',
  cancel: 'Cancel',
  vismaConnect: 'Continue with Visma Connect',
} as const;

function stepUpText(key: keyof typeof STEP_UP): string {
  const shown = localeText('auth', `stepUp.${key}`);
  expect(shown, `auth:stepUp.${key}`).toBe(STEP_UP[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

type SignInMethod = 'password' | 'visma-connect';

interface Account {
  readonly signInMethod: SignInMethod;
  readonly enrolled: boolean;
}

const LOCAL_WITHOUT_MFA: Account = { signInMethod: 'password', enrolled: false };
const LOCAL_WITH_MFA: Account = { signInMethod: 'password', enrolled: true };
const VISMA_CONNECT: Account = { signInMethod: 'visma-connect', enrolled: false };

function meOf(account: Account) {
  return {
    user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    // An admin without a factor would be gated (D8): only the enrolled user is an admin.
    role: account.enrolled ? 'admin' : 'member',
    signInMethod: account.signInMethod,
    mfa: { enrolled: account.enrolled },
    gate: 'none',
  };
}

const PASSWORD = 'Account-Password-2026!';
const VALID_CODE = '246810';
const REAUTHORIZATION_URL =
  'https://connect.visma.com/connect/authorize?client_id=tayzu&state=s1&prompt=login';

/** A server string that must never reach the page (D4, D15). */
const SERVER_TEXT = 'Internal detail: relation "catalog_entities" on 10.0.0.7';

const ACTOR = { type: 'user', id: 'u_1' } as const;

const SERVICE = {
  identifier: 'service',
  title: { en: 'Service', es: 'Servicio' },
  schema: {
    properties: { tier: { type: 'string', title: { en: 'Tier', es: 'Nivel' } } },
    required: [],
  },
  relations: {},
  version: 1,
  createdAt: '2026-08-01T10:00:00.000Z',
  createdBy: ACTOR,
  updatedAt: '2026-08-01T10:00:00.000Z',
  updatedBy: ACTOR,
};

function entity(identifier: string, title: string) {
  return {
    blueprint: 'service',
    identifier,
    title,
    spec: { properties: { tier: 'gold' }, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: ACTOR,
  };
}

const PAYMENTS_ID = 'svc-payments';
const PAYMENTS_TITLE = 'Payments API';
const ENTITY_PATH = `/catalog/service/${PAYMENTS_ID}`;
const TABLE_PATH = '/catalog/service';
const DELETE_PATH = `/v1/blueprints/service/entities/${PAYMENTS_ID}`;

/** The readable referrers of the blocked delete: bare identifiers, as the server names them. */
const REFERRERS = ['svc-checkout', 'billing-ledger'] as const;

// ---------------------------------------------------------------------------
// The fake API

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
    message: SERVER_TEXT,
    ...(data === undefined ? {} : { data }),
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

interface FakeServerOptions {
  readonly account?: Account;
  /**
   * The entity is still referenced: a delete without `detachReferences=true` answers the
   * reference violation with these details.
   */
  readonly references?: { readonly referrers: readonly string[]; readonly notVisible?: number };
  /** A delete needs a fresh verification first. */
  readonly stepUp?: boolean;
  /** The step-up answer carries this re-authorization URL. */
  readonly reauthorizationUrl?: string;
  /** Every delete answers this instead. */
  readonly deleteAnswer?: 'forbidden' | 'internal';
}

/**
 * A fake `fetch` playing the API and Better Auth for one signed-in user of one tenant
 * holding the `service` blueprint with `svc-payments` and `svc-checkout`.
 */
function createFakeServer(options: FakeServerOptions = {}) {
  const account = options.account ?? LOCAL_WITHOUT_MFA;
  const entities = [entity('svc-checkout', 'Checkout'), entity(PAYMENTS_ID, PAYMENTS_TITLE)];
  let verified = false;
  const calls: RecordedRequest[] = [];

  function fresh(): boolean {
    if (options.stepUp !== true) return true;
    return account.signInMethod === 'password' && verified;
  }

  function deleteEntity(url: URL): Response {
    if (options.deleteAnswer === 'forbidden') return orpcError('AUTH_FORBIDDEN', 403);
    if (options.deleteAnswer === 'internal') return orpcError('INTERNAL', 500);
    if (!fresh()) {
      return orpcError(
        'AUTH_STEP_UP_REQUIRED',
        403,
        options.reauthorizationUrl === undefined
          ? undefined
          : { reauthorizationUrl: options.reauthorizationUrl },
      );
    }
    const index = entities.findIndex((item) => item.identifier === PAYMENTS_ID);
    if (index < 0) return orpcError('CATALOG_NOT_FOUND', 404);
    const detach = url.searchParams.get('detachReferences') === 'true';
    if (options.references !== undefined && !detach) {
      const { referrers, notVisible } = options.references;
      return orpcError('CATALOG_REFERENCE_VIOLATION', 422, {
        details: notVisible === undefined ? { referrers } : { referrers, notVisible },
      });
    }
    entities.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  function authRoute(pathname: string, input: Record<string, unknown>): Response {
    if (pathname === '/api/auth/verify-password') {
      if (input.password !== PASSWORD) {
        return jsonResponse(400, { code: 'INVALID_PASSWORD', message: SERVER_TEXT });
      }
      if (!account.enrolled) verified = true;
      return jsonResponse(200, { status: true });
    }
    if (pathname === '/api/auth/two-factor/verify-totp') {
      if (!account.enrolled || input.code !== VALID_CODE) {
        return jsonResponse(401, { code: 'INVALID_CODE', message: SERVER_TEXT });
      }
      verified = true;
      return jsonResponse(200, { token: 'session-token', user: meOf(account).user });
    }
    return jsonResponse(404, { code: 'NOT_FOUND', message: SERVER_TEXT });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, url, headers: request.headers, body });
    const { pathname } = url;

    if (request.method === 'POST' && pathname.startsWith('/api/auth/')) {
      return authRoute(pathname, body === '' ? {} : (JSON.parse(body) as Record<string, unknown>));
    }
    if (request.method === 'DELETE' && pathname === DELETE_PATH) return deleteEntity(url);
    if (request.method !== 'GET') return orpcError('CATALOG_NOT_FOUND', 404);
    if (pathname === '/v1/me') return jsonResponse(200, meOf(account));
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: [SERVICE] });
    if (pathname === '/v1/blueprints/service') return jsonResponse(200, SERVICE);
    if (pathname === '/v1/blueprints/service/entities') {
      return jsonResponse(200, { items: [...entities] });
    }
    const match = /^\/v1\/blueprints\/service\/entities\/([^/]+)(\/related)?$/.exec(pathname);
    const found = entities.find((item) => item.identifier === match?.[1]);
    if (match === null || found === undefined) return orpcError('CATALOG_NOT_FOUND', 404);
    return match[2] === undefined ? jsonResponse(200, found) : jsonResponse(200, { items: [] });
  }

  return {
    fetch: (input: Request, init?: RequestInit): Promise<Response> =>
      handle(new Request(input, init)),
    /** Every `entities.delete` request, in order. */
    deleteCalls: (): RecordedRequest[] =>
      calls.filter((call) => call.method === 'DELETE' && call.url.pathname === DELETE_PATH),
    /** Every request but `GET`s, any path. */
    mutatingCalls: (): RecordedRequest[] => calls.filter((call) => call.method !== 'GET'),
    /** The `entities.list` requests of the table. */
    listCalls: (): RecordedRequest[] =>
      calls.filter(
        (call) => call.method === 'GET' && call.url.pathname === '/v1/blueprints/service/entities',
      ),
    /** Every local verification call. */
    verificationCalls: (): RecordedRequest[] =>
      calls.filter(
        (call) =>
          call.method === 'POST' &&
          ['/api/auth/verify-password', '/api/auth/two-factor/verify-totp'].includes(
            call.url.pathname,
          ),
      ),
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

// ---------------------------------------------------------------------------
// Rendering

function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `catalogTable` and `entity` is a probe, so those two keep their pages. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  search: probe('search'),
};

/** Renders the whole app as `main.tsx` does (session gate, shell, D4's query client). */
async function renderApp(path: string, server: FakeServer): Promise<{ history: RouterHistory }> {
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  });
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

type User = ReturnType<typeof userEvent.setup>;

/** Opens the entity page at `ENTITY_PATH` and waits for its heading. */
async function openEntityPage(server: FakeServer): Promise<{ history: RouterHistory }> {
  const rendered = await renderApp(ENTITY_PATH, server);
  const main = await screen.findByRole('main', {}, { timeout: 3000 });
  await within(main).findByRole('heading', { level: 1, name: PAYMENTS_TITLE }, { timeout: 3000 });
  return rendered;
}

function deleteTrigger(): HTMLElement {
  return within(screen.getByRole('main')).getByRole('button', {
    name: text('entity.delete.open'),
  });
}

/** Clicks "Delete entity" and returns the confirmation dialog. */
async function openConfirmation(user: User): Promise<HTMLElement> {
  await user.click(deleteTrigger());
  return screen.findByRole('dialog', { name: text('entity.delete.title') });
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: text('entity.delete.confirm') });
}

function detachCheckbox(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('checkbox', { name: text('entity.delete.detachReferences') });
}

function confirmationDialog(): HTMLElement | null {
  return screen.queryByRole('dialog', { name: PINNED['entity.delete.title'] });
}

async function findStepUpDialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: stepUpText('title') }, { timeout: 3000 });
}

/** The delete reached the table: the path, the table and the entity gone from it. */
async function expectBackOnTable(history: RouterHistory, server: FakeServer): Promise<void> {
  await waitFor(
    () => {
      expect(history.location.pathname).toBe(TABLE_PATH);
    },
    { timeout: 3000 },
  );
  const table = await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });
  expect(await within(table).findByRole('link', { name: 'svc-checkout' })).toBeInTheDocument();
  await waitFor(
    () => {
      expect(within(table).queryByRole('link', { name: PAYMENTS_ID })).toBeNull();
      expect(within(table).queryByText(PAYMENTS_TITLE)).toBeNull();
    },
    { timeout: 3000 },
  );
  expect(server.listCalls().length).toBeGreaterThan(0);
  expect(confirmationDialog()).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
}

/** No server string anywhere in the document (D4, D15). */
function expectNoServerText(): void {
  expect(document.body.textContent).not.toContain(SERVER_TEXT);
  expect(document.body.textContent).not.toContain('Internal detail');
}

/** The value of `detachReferences` in a recorded delete, or `null`. */
function detachParam(call: RecordedRequest | undefined): string | null {
  expect(call, 'a recorded delete').toBeDefined();
  return call?.url.searchParams.get('detachReferences') ?? null;
}

/** Lets any pending request or render happen before counting calls. */
async function settle(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

// ---------------------------------------------------------------------------
// jsdom gaps

const ELEMENT_STUBS = [
  'hasPointerCapture',
  'setPointerCapture',
  'releasePointerCapture',
  'scrollIntoView',
] as const;

const addedStubs: string[] = [];

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // Intentionally empty.
      }
      unobserve(): void {
        // Intentionally empty.
      }
      disconnect(): void {
        // Intentionally empty.
      }
    },
  );
  for (const name of ELEMENT_STUBS) {
    if (name in Element.prototype) continue;
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value: () => false,
    });
    addedStubs.push(name);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const name of addedStubs) Reflect.deleteProperty(Element.prototype, name);
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  // The step-up store is module state: a test that left a request open must not leak it.
  resetSessionStores();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The confirmation dialog

describe('the delete confirmation dialog', () => {
  it('is offered to a member, with the detachReferences option unchecked and focus inside', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    await openEntityPage(server);

    const dialog = await openConfirmation(user);
    expect(dialog).toHaveAccessibleDescription(text('entity.delete.description'));
    expect(detachCheckbox(dialog)).not.toBeChecked();
    expect(confirmButton(dialog)).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: text('entity.delete.cancel') }),
    ).toBeEnabled();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(server.mutatingCalls()).toEqual([]);
  });

  it('sends nothing on Cancel and returns focus to the delete button', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(within(dialog).getByRole('button', { name: text('entity.delete.cancel') }));
    await waitFor(() => {
      expect(confirmationDialog()).toBeNull();
    });
    expect(deleteTrigger()).toHaveFocus();

    await openConfirmation(user);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(confirmationDialog()).toBeNull();
    });
    expect(deleteTrigger()).toHaveFocus();

    await settle();
    expect(server.mutatingCalls()).toEqual([]);
    expect(history.location.pathname).toBe(ENTITY_PATH);
  });
});

// ---------------------------------------------------------------------------
// The Verify items

describe('a delete without references', () => {
  it('deletes the entity and returns to the table, which no longer lists it', async () => {
    const user = userEvent.setup();
    const server = createFakeServer();
    // From the table, so its list is already cached when the delete succeeds.
    const { history } = await renderApp(TABLE_PATH, server);
    const table = await screen.findByRole('table', { name: 'Service' }, { timeout: 3000 });
    await user.click(await within(table).findByRole('link', { name: PAYMENTS_ID }));
    await screen.findByRole('heading', { level: 1, name: PAYMENTS_TITLE }, { timeout: 3000 });
    const listCallsBefore = server.listCalls().length;

    await user.click(confirmButton(await openConfirmation(user)));

    await expectBackOnTable(history, server);
    expect(server.listCalls().length).toBeGreaterThan(listCallsBefore);

    const deletes = server.deleteCalls();
    expect(deletes).toHaveLength(1);
    const [call] = deletes;
    expect([null, 'false']).toContain(detachParam(call));
    // Spec, "A mutating call carries the CSRF header and no tenant".
    expect(call?.headers.get('x-csrf-token')).toBe('orpc');
    expect(call?.url.search.toLowerCase()).not.toContain('tenant');
    expect([...(call?.headers.keys() ?? [])].join(' ').toLowerCase()).not.toContain('tenant');
    expect(call?.body.toLowerCase() ?? '').not.toContain('tenant');
  });
});

describe('a blocked delete', () => {
  it('shows the readable referrers and the not-visible count, and stays on the entity', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ references: { referrers: REFERRERS, notVisible: 3 } });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(text('entity.delete.blocked'));
    const list = within(alert).getByRole('list', { name: text('entity.delete.referrers') });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent.trim())).toEqual([...REFERRERS]);
    // Bare identifiers carry no blueprint: they are text, never a link to a guessed page.
    expect(within(alert).queryAllByRole('link')).toEqual([]);
    expect(text('entity.delete.notVisible')).toContain('{{count}}');
    expect(alert).toHaveTextContent('+3 not visible');
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);

    expect(confirmationDialog()).toBe(dialog);
    expect(detachCheckbox(dialog)).not.toBeChecked();
    expect(history.location.pathname).toBe(ENTITY_PATH);
    expect(server.deleteCalls()).toHaveLength(1);
    expectNoServerText();
  });

  it('shows no not-visible count when every referrer is readable', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ references: { referrers: ['svc-checkout'] } });
    await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole('alert', {}, { timeout: 3000 });
    const list = within(alert).getByRole('list', { name: text('entity.delete.referrers') });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent.trim()),
    ).toEqual(['svc-checkout']);
    expect(alert.textContent).not.toContain('not visible');
    expect(alert.textContent).not.toContain('+0');
  });

  it('retries with detachReferences once the option is checked, and returns to the table', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ references: { referrers: REFERRERS, notVisible: 3 } });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(confirmButton(dialog));
    await within(dialog).findByRole('alert', {}, { timeout: 3000 });

    await user.click(detachCheckbox(dialog));
    expect(detachCheckbox(dialog)).toBeChecked();
    await user.click(confirmButton(dialog));

    await expectBackOnTable(history, server);
    const deletes = server.deleteCalls();
    expect(deletes).toHaveLength(2);
    expect([null, 'false']).toContain(detachParam(deletes[0]));
    expect(detachParam(deletes[1])).toBe('true');
  });
});

describe('a delete with detachReferences', () => {
  it('sends detachReferences=true when the option is checked and returns to the table', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ references: { referrers: REFERRERS } });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(detachCheckbox(dialog));
    await user.click(confirmButton(dialog));

    await expectBackOnTable(history, server);
    const deletes = server.deleteCalls();
    expect(deletes).toHaveLength(1);
    expect(detachParam(deletes[0])).toBe('true');
    expect(deletes[0]?.headers.get('x-csrf-token')).toBe('orpc');
  });
});

describe('a step-up answer', () => {
  it('opens the step-up dialog; a user without MFA re-enters the password and the deletion completes', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA, stepUp: true });
    const { history } = await openEntityPage(server);

    await user.click(confirmButton(await openConfirmation(user)));

    const stepUp = await findStepUpDialog();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(history.location.pathname).toBe(ENTITY_PATH);
    await user.type(within(stepUp).getByLabelText(stepUpText('password')), PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: stepUpText('verify') }));

    await expectBackOnTable(history, server);
    expect(screen.queryByRole('dialog', { name: STEP_UP.title })).toBeNull();
    expect(server.verificationCalls()).toHaveLength(1);
    // Retried exactly once after the verification.
    expect(server.deleteCalls()).toHaveLength(2);
  });

  it('opens the step-up dialog; a user with TOTP enters a valid code and the deletion completes', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITH_MFA, stepUp: true });
    const { history } = await openEntityPage(server);

    await user.click(confirmButton(await openConfirmation(user)));

    const stepUp = await findStepUpDialog();
    await user.type(within(stepUp).getByRole('textbox', { name: stepUpText('code') }), VALID_CODE);
    await user.click(within(stepUp).getByRole('button', { name: stepUpText('verify') }));

    await expectBackOnTable(history, server);
    expect(server.deleteCalls()).toHaveLength(2);
  });

  it('keeps the detachReferences choice for the retry after the verification', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      account: LOCAL_WITHOUT_MFA,
      stepUp: true,
      references: { referrers: REFERRERS },
    });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(detachCheckbox(dialog));
    await user.click(confirmButton(dialog));

    const stepUp = await findStepUpDialog();
    await user.type(within(stepUp).getByLabelText(stepUpText('password')), PASSWORD);
    await user.click(within(stepUp).getByRole('button', { name: stepUpText('verify') }));

    await expectBackOnTable(history, server);
    expect(server.deleteCalls().map((call) => detachParam(call))).toEqual(['true', 'true']);
  });

  it('leaves the entity in place when the step-up is cancelled', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ account: LOCAL_WITHOUT_MFA, stepUp: true });
    const { history } = await openEntityPage(server);

    await user.click(confirmButton(await openConfirmation(user)));
    const stepUp = await findStepUpDialog();
    await user.click(within(stepUp).getByRole('button', { name: stepUpText('cancel') }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: STEP_UP.title })).toBeNull();
    });
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toEqual([]);
    expect(history.location.pathname).toBe(ENTITY_PATH);
    expectNoServerText();
  });

  it('offers a Visma Connect session the round trip and retries nothing', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({
      account: VISMA_CONNECT,
      stepUp: true,
      reauthorizationUrl: REAUTHORIZATION_URL,
    });
    const { history } = await openEntityPage(server);

    await user.click(confirmButton(await openConfirmation(user)));

    const stepUp = await findStepUpDialog();
    expect(
      within(stepUp).getByRole('button', { name: stepUpText('vismaConnect') }),
    ).toBeInTheDocument();
    expect(within(stepUp).queryAllByRole('textbox')).toEqual([]);
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(server.verificationCalls()).toEqual([]);
    expect(history.location.pathname).toBe(ENTITY_PATH);
  });
});

// ---------------------------------------------------------------------------
// Other failures

describe('a refused or failed delete', () => {
  it('shows one forbidden alert, never the server text, and stays on the entity', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ deleteAnswer: 'forbidden' });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(text('entity.delete.error.forbidden'));
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: STEP_UP.title })).toBeNull();
    await settle();
    expect(server.deleteCalls()).toHaveLength(1);
    expect(history.location.pathname).toBe(ENTITY_PATH);
    expectNoServerText();
  });

  it('shows the generic alert for an internal error, never the server text', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ deleteAnswer: 'internal' });
    const { history } = await openEntityPage(server);

    const dialog = await openConfirmation(user);
    await user.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent(text('entity.delete.error.server'));
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
    expect(history.location.pathname).toBe(ENTITY_PATH);
    expectNoServerText();
  });
});
