/**
 * The session gate (task 5.8, design D12, D8, D11, D4, D15 and Q64, Q65, Q67; spec
 * "The shell knows the caller's session and enforces its gates", scenarios "A temporary
 * password is a gate" and "An admin without MFA must enrol").
 *
 * D12 (Session gate): "A root loader reads `GET /v1/me` through TanStack Query. A `401`
 * sends a protected route to `/sign-in?returnTo=<path>`; a gate other than `none` sends
 * every route except its own page and sign-out to that page (`/change-password` or
 * `/mfa/enrol`, or the expired-password page). The public pages (sign-in, forgot, reset,
 * accept, step-up complete) render without a session."
 * D8: `gate` is `password_expired`, `password_change_required`, `mfa_enrolment_required`
 * or `none`; no session is the uniform `401 CATALOG_CONTEXT_REQUIRED`.
 * D11: "`/change-password` (gate `password_change_required`) [...] `password_expired`
 * shows a page that tells the user to ask an administrator, with sign-out." "`/mfa/enrol`
 * (gate `mfa_enrolment_required`, and reachable from the user menu when not enrolled)".
 * D11 (Page rules of the link pages) and the spec: the fragment is gone "before any
 * request is made".
 * D12 (Shell): "Sign-out posts `/api/auth/sign-out`, clears the query cache and the
 * stores, and navigates to `/sign-in`."
 * Spec: "The web app MUST send a signed-out visitor of a protected page to the sign-in
 * page, and a gated session to its gate's page for every route but sign-out."
 * Q65: `safeReturnPath` keeps only the signed-in routes, so a gate page's `returnTo` is `/`.
 *
 * Assumed API of `./router.js` (extends the frozen 5.7 contract of `router.test.tsx`):
 *
 * ```ts
 * import type { QueryClient } from '@tanstack/react-query';
 * import type { AuthClient } from '../api/auth-client.js';
 *
 * export function createAppRouter(options: {
 *   history: RouterHistory;
 *   // `passwordExpired` is the expired-password page. It is not a route and not in
 *   // `PAGE_NAMES`: under `password_expired` the `/change-password` route renders it
 *   // instead of `changePassword`.
 *   pages?: Partial<AppPages & { passwordExpired: ComponentType }>;
 *   // The session source. Absent (the 5.7 route-tree test), no route reads a session.
 *   // `main.tsx` always passes it.
 *   session?: { authClient: Pick<AuthClient, 'me'>; queryClient: QueryClient };
 * }): AppRouter;
 * ```
 *
 * With `session`, before any page of a protected route renders, the root reads
 * `authClient.me()` through `queryClient`:
 *
 * | Route | `me()` answers | Result |
 * | --- | --- | --- |
 * | public: `/sign-in`, `/forgot-password`, `/reset-password`, `/accept-invitation`, `/step-up/complete` | never called | the page renders |
 * | protected, any | `unauthenticated` (401) | `/sign-in?returnTo=<safeReturnPath(path + query)>` |
 * | protected, any | another failure (5xx, network) | no page and no redirect: an error state |
 * | protected, any | gate `none` | its own page (including `/mfa/enrol`) |
 * | protected but `/change-password` | gate `password_change_required` | `/change-password` |
 * | protected but `/mfa/enrol` | gate `mfa_enrolment_required` | `/mfa/enrol` |
 * | protected, any | gate `password_expired` | `/change-password`, rendering `passwordExpired` |
 *
 * Sign-out is not a route: it is the action of D12, whose target `/sign-in` is public, so
 * a gated session that signs out reaches the sign-in page.
 *
 * The network is a fake `fetch` behind the real auth client (D16), playing the server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, useNavigate } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, type ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthClient } from '../api/auth-client.js';
import type { AuthClient } from '../api/auth-client.js';
import { createI18n } from '../i18n/i18n.js';
import { safeReturnPath } from '../lib/return-path.js';

import { createAppRouter, type PageName } from './router.js';

type SlotName = PageName | 'passwordExpired';

type Gate = 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

interface MeBody {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: 'owner' | 'admin' | 'member';
  signInMethod: 'password' | 'visma-connect';
  mfa: { enrolled: boolean };
  gate: Gate;
}

/** What the fake server answers to `GET /v1/me`. */
type SessionState =
  | { readonly kind: 'session'; readonly me: MeBody }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'network-failure' };

function memberWith(gate: Gate): MeBody {
  return {
    user: { id: 'u_1', name: 'Mia Member', email: 'mia@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    role: 'member',
    signInMethod: 'password',
    mfa: { enrolled: false },
    gate,
  };
}

/** An admin with no enrolled factor, as `GET /v1/me` reports them (D8). */
function adminWithoutFactor(gate: Gate): MeBody {
  return {
    user: { id: 'u_2', name: 'Ada Admin', email: 'ada@example.com' },
    organization: { id: 'org_1', name: 'Acme' },
    role: 'admin',
    signInMethod: 'password',
    mfa: { enrolled: false },
    gate,
  };
}

function jsonResponse(status: number, body: unknown): Response {
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
    message: 'Unauthorized',
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
}

/** A fake `fetch` playing `GET /v1/me` and `POST /api/auth/sign-out`. */
function createFakeServer(initial: SessionState) {
  let state = initial;
  const calls: RecordedRequest[] = [];
  const fetch = (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({ method: request.method, pathname });
    if (request.method === 'POST' && pathname === '/api/auth/sign-out') {
      state = { kind: 'signed-out' };
      return Promise.resolve(jsonResponse(200, { success: true }));
    }
    if (request.method !== 'GET' || pathname !== '/v1/me') {
      return Promise.resolve(jsonResponse(404, { code: 'NOT_FOUND', status: 404 }));
    }
    switch (state.kind) {
      case 'session':
        return Promise.resolve(jsonResponse(200, state.me));
      case 'signed-out':
        return Promise.resolve(contextRequired());
      case 'status':
        return Promise.resolve(
          jsonResponse(state.status, { code: 'INTERNAL_SERVER_ERROR', status: state.status }),
        );
      case 'network-failure':
        return Promise.reject(new TypeError('Failed to fetch'));
    }
  };
  return {
    fetch,
    calls,
    meCalls: () => calls.filter((call) => call.pathname === '/v1/me'),
    setState(next: SessionState) {
      state = next;
    },
  };
}

type FakeServer = ReturnType<typeof createFakeServer>;

interface AppContext {
  readonly history: RouterHistory;
  readonly router: ReturnType<typeof createAppRouter>;
  readonly queryClient: QueryClient;
  readonly authClient: AuthClient;
  /** Every page slot that mounted, in order. */
  readonly mounted: SlotName[];
}

/** Sign-out as D12 does it: post `/api/auth/sign-out`, clear the cache, go to `/sign-in`. */
function SignOutButton({
  authClient,
  queryClient,
}: {
  authClient: AuthClient;
  queryClient: QueryClient;
}): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        void authClient.signOut().then(() => {
          queryClient.clear();
          return navigate({ to: '/sign-in' });
        });
      }}
    >
      Sign out
    </button>
  );
}

/** Renders the app router at `path` with the fake server as its session source. */
async function renderApp(
  path: string,
  server: FakeServer,
  extraPages: Partial<Record<SlotName, ComponentType>> = {},
): Promise<AppContext> {
  const mounted: SlotName[] = [];
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const authClient = createAuthClient({ fetch: server.fetch });

  function Probe({
    name,
    withSignOut = false,
  }: {
    name: SlotName;
    withSignOut?: boolean;
  }): React.JSX.Element {
    useEffect(() => {
      mounted.push(name);
    }, [name]);
    return (
      <div data-testid={`page-${name}`}>
        {withSignOut ? <SignOutButton authClient={authClient} queryClient={queryClient} /> : null}
      </div>
    );
  }

  const pages: Record<SlotName, ComponentType> = {
    signIn: () => <Probe name="signIn" />,
    forgotPassword: () => <Probe name="forgotPassword" />,
    resetPassword: () => <Probe name="resetPassword" />,
    acceptInvitation: () => <Probe name="acceptInvitation" />,
    changePassword: () => <Probe name="changePassword" withSignOut />,
    mfaEnrol: () => <Probe name="mfaEnrol" withSignOut />,
    stepUpComplete: () => <Probe name="stepUpComplete" />,
    home: () => <Probe name="home" />,
    catalogTable: () => <Probe name="catalogTable" />,
    entity: () => <Probe name="entity" />,
    search: () => <Probe name="search" />,
    passwordExpired: () => <Probe name="passwordExpired" withSignOut />,
    ...extraPages,
  };

  const router = createAppRouter({ history, pages, session: { authClient, queryClient } });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { history, router, queryClient, authClient, mounted };
}

/** Waits for the page slot `name` and checks it is the only page shown. */
async function expectPage(name: SlotName): Promise<void> {
  await screen.findByTestId(`page-${name}`);
  expect(screen.getAllByTestId(/^page-/)).toHaveLength(1);
}

/** Waits until the router has settled (no navigation, load or redirect in flight). */
async function settled(router: AppContext['router']): Promise<void> {
  await waitFor(
    () => {
      expect(router.state.status).toBe('idle');
      expect(router.state.isLoading).toBe(false);
    },
    { timeout: 4000 },
  );
}

/** The signed-in routes, as a path (and query) that matches each, and its page slot. */
const SIGNED_IN_ROUTES: readonly (readonly [PageName, string])[] = [
  ['home', '/'],
  ['catalogTable', '/catalog/service'],
  ['entity', '/catalog/service/payments-api'],
  ['search', '/search?q=paym'],
];

/** The public pages of D12, which render without a session. */
const PUBLIC_ROUTES: readonly (readonly [PageName, string])[] = [
  ['signIn', '/sign-in'],
  ['forgotPassword', '/forgot-password'],
  ['resetPassword', '/reset-password'],
  ['acceptInvitation', '/accept-invitation'],
  ['stepUpComplete', '/step-up/complete'],
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A temporary password is a gate', () => {
  it('shows the change-password page when the user opens /catalog/service', async () => {
    const server = createFakeServer({
      kind: 'session',
      me: memberWith('password_change_required'),
    });

    const { history, mounted } = await renderApp('/catalog/service', server);

    await expectPage('changePassword');
    expect(history.location.pathname).toBe('/change-password');
    expect(mounted).not.toContain('catalogTable');
    expect(server.meCalls().length).toBeGreaterThan(0);
    expect(server.meCalls().every((call) => call.method === 'GET')).toBe(true);
  });

  it.each([...SIGNED_IN_ROUTES, ['mfaEnrol', '/mfa/enrol'] as const])(
    'sends the %s route (%s) to /change-password without rendering it',
    async (name, path) => {
      const server = createFakeServer({
        kind: 'session',
        me: memberWith('password_change_required'),
      });

      const { history, mounted } = await renderApp(path, server);

      await expectPage('changePassword');
      expect(history.location.pathname).toBe('/change-password');
      expect(mounted).not.toContain(name);
    },
  );

  it('keeps the gated session on its own page, /change-password', async () => {
    const server = createFakeServer({
      kind: 'session',
      me: memberWith('password_change_required'),
    });

    const { history, router } = await renderApp('/change-password', server);

    await expectPage('changePassword');
    await settled(router);
    expect(history.location.pathname).toBe('/change-password');
  });
});

describe('An admin without MFA must enrol', () => {
  /** The sign-in page signing the admin in, then going where sign-in goes: `/`. */
  function signInPageFor(server: FakeServer): ComponentType {
    return function SignInProbe(): React.JSX.Element {
      const navigate = useNavigate();
      return (
        <div data-testid="page-signIn">
          <button
            type="button"
            onClick={() => {
              server.setState({
                kind: 'session',
                me: adminWithoutFactor('mfa_enrolment_required'),
              });
              void navigate({ to: '/' });
            }}
          >
            Sign in
          </button>
        </div>
      );
    };
  }

  it('shows the MFA enrolment page when they sign in', async () => {
    const user = userEvent.setup();
    const server = createFakeServer({ kind: 'signed-out' });
    const { history, mounted } = await renderApp('/sign-in', server, {
      signIn: signInPageFor(server),
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    await expectPage('mfaEnrol');
    expect(history.location.pathname).toBe('/mfa/enrol');
    expect(mounted).not.toContain('home');
    expect(server.meCalls().length).toBeGreaterThan(0);
  });

  it.each([...SIGNED_IN_ROUTES, ['changePassword', '/change-password'] as const])(
    'sends the %s route (%s) to /mfa/enrol without rendering it',
    async (name, path) => {
      const server = createFakeServer({
        kind: 'session',
        me: adminWithoutFactor('mfa_enrolment_required'),
      });

      const { history, mounted } = await renderApp(path, server);

      await expectPage('mfaEnrol');
      expect(history.location.pathname).toBe('/mfa/enrol');
      expect(mounted).not.toContain(name);
    },
  );

  it('keeps the gated session on its own page, /mfa/enrol', async () => {
    const server = createFakeServer({
      kind: 'session',
      me: adminWithoutFactor('mfa_enrolment_required'),
    });

    const { history, router } = await renderApp('/mfa/enrol', server);

    await expectPage('mfaEnrol');
    await settled(router);
    expect(history.location.pathname).toBe('/mfa/enrol');
  });

  it('follows the gate the server reports, not the role or the factor: gate none opens home', async () => {
    const server = createFakeServer({ kind: 'session', me: adminWithoutFactor('none') });

    const { history, router } = await renderApp('/', server);

    await expectPage('home');
    await settled(router);
    expect(history.location.pathname).toBe('/');
  });
});

describe('the expired-password page', () => {
  it.each([...SIGNED_IN_ROUTES, ['mfaEnrol', '/mfa/enrol'] as const])(
    'shows the expired-password page at /change-password from the %s route (%s)',
    async (name, path) => {
      const server = createFakeServer({ kind: 'session', me: memberWith('password_expired') });

      const { history, mounted } = await renderApp(path, server);

      await expectPage('passwordExpired');
      expect(history.location.pathname).toBe('/change-password');
      expect(mounted).not.toContain(name);
      expect(mounted).not.toContain('changePassword');
    },
  );

  it('shows the expired-password page, not the change form, at /change-password', async () => {
    const server = createFakeServer({ kind: 'session', me: memberWith('password_expired') });

    const { history, router, mounted } = await renderApp('/change-password', server);

    await expectPage('passwordExpired');
    await settled(router);
    expect(history.location.pathname).toBe('/change-password');
    expect(mounted).not.toContain('changePassword');
  });
});

describe('sign-out under a gate', () => {
  it.each([
    ['password_change_required', '/change-password'],
    ['mfa_enrolment_required', '/mfa/enrol'],
    ['password_expired', '/change-password'],
  ] as const)(
    'lets a %s session sign out from %s and reach the sign-in page',
    async (gate, gatePath) => {
      const user = userEvent.setup();
      const server = createFakeServer({ kind: 'session', me: memberWith(gate) });
      const { history, router } = await renderApp(gatePath, server);
      await screen.findByRole('button', { name: 'Sign out' });

      await user.click(screen.getByRole('button', { name: 'Sign out' }));

      await expectPage('signIn');
      await settled(router);
      expect(history.location.pathname).toBe('/sign-in');
      expect(server.calls).toContainEqual({ method: 'POST', pathname: '/api/auth/sign-out' });
    },
  );
});

describe('a signed-out visit of a protected route', () => {
  it.each([
    '/',
    '/catalog/service',
    '/catalog/service?sort=title&pageSize=25',
    '/catalog/service/payments-api?tab=related',
    '/catalog/service/team@example.com:prod=1',
    '/search?q=paym',
  ])('sends %s to /sign-in with that path and query as returnTo', async (path) => {
    const server = createFakeServer({ kind: 'signed-out' });

    const { history, mounted } = await renderApp(path, server);

    await expectPage('signIn');
    expect(history.location.pathname).toBe('/sign-in');
    const returnTo = new URLSearchParams(history.location.search).get('returnTo');
    expect(returnTo).toBe(path);
    expect(returnTo).toBe(safeReturnPath(path));
    expect(mounted.filter((name) => name !== 'signIn')).toEqual([]);
  });

  it.each([
    ['changePassword', '/change-password'],
    ['mfaEnrol', '/mfa/enrol'],
  ] as const)(
    'sends the %s gate page (%s) to /sign-in with returnTo / (Q65)',
    async (name, path) => {
      const server = createFakeServer({ kind: 'signed-out' });

      const { history, mounted } = await renderApp(path, server);

      await expectPage('signIn');
      expect(history.location.pathname).toBe('/sign-in');
      const returnTo = new URLSearchParams(history.location.search).get('returnTo');
      expect(returnTo).toBe(safeReturnPath(path));
      expect(returnTo).toBe('/');
      expect(mounted).not.toContain(name);
    },
  );

  it('reads the session through GET /v1/me', async () => {
    const server = createFakeServer({ kind: 'signed-out' });

    await renderApp('/catalog/service', server);

    await expectPage('signIn');
    expect(server.meCalls().length).toBeGreaterThan(0);
    expect(server.meCalls().every((call) => call.method === 'GET')).toBe(true);
  });
});

describe('the public pages', () => {
  it.each(PUBLIC_ROUTES)(
    'renders the %s page at %s without a session and without calling the API',
    async (name, path) => {
      const server = createFakeServer({ kind: 'signed-out' });

      const { history, router } = await renderApp(path, server);

      await expectPage(name);
      await settled(router);
      expect(history.location.pathname).toBe(path);
      expect(server.calls).toEqual([]);
    },
  );

  it.each([
    ['resetPassword', '/reset-password', '#reset=AAAAAAAAAAAAAAAAAAAAAA&token=BBBB'],
    ['acceptInvitation', '/accept-invitation', '#invitation=inv_1&token=CCCC'],
  ] as const)(
    'leaves the %s link page and its fragment to the page, with no request before it renders',
    async (name, path, fragment) => {
      const server = createFakeServer({ kind: 'signed-out' });

      const { history, router } = await renderApp(`${path}${fragment}`, server);

      await expectPage(name);
      await settled(router);
      expect(history.location.pathname).toBe(path);
      expect(server.calls).toEqual([]);
    },
  );
});

describe('a session with no gate', () => {
  it.each([...SIGNED_IN_ROUTES, ['mfaEnrol', '/mfa/enrol'] as const])(
    'renders the %s page at %s',
    async (name, path) => {
      const server = createFakeServer({ kind: 'session', me: memberWith('none') });

      const { history, router } = await renderApp(path, server);

      await expectPage(name);
      await settled(router);
      expect(history.location.pathname).toBe(path.split('?')[0]);
    },
  );
});

describe('a failed session read', () => {
  it.each([
    ['a 500', { kind: 'status', status: 500 }],
    ['a 503', { kind: 'status', status: 503 }],
    ['a network failure', { kind: 'network-failure' }],
  ] as const)(
    'neither renders the protected page nor sends it to sign-in on %s',
    async (_label, state) => {
      const server = createFakeServer(state);

      const { history, router, mounted } = await renderApp('/catalog/service', server);

      await waitFor(() => {
        expect(server.meCalls().length).toBeGreaterThan(0);
      });
      await settled(router);
      expect(history.location.pathname).toBe('/catalog/service');
      expect(mounted).toEqual([]);
      expect(screen.queryAllByTestId(/^page-/)).toHaveLength(0);
    },
  );
});
