/**
 * The session gate (design D12, D8, D4 and Q64, Q65, Q68, Q73, Q74).
 *
 * Every protected route reads `GET /v1/me` through TanStack Query before its page
 * renders. Only `unauthenticated` (the uniform `401` of D8) sends the visitor to
 * `/sign-in`, with `returnTo` the raw path and query through `safeReturnPath`. Any
 * other failure fails closed: the route throws and the root error component shows a
 * generic message. A gate other than `none` sends every protected route but its own
 * page to that page, with the requested path and query as `returnTo` (Q73, Q74). The
 * gate follows only the server's `gate` field. The public pages never call this.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { redirect, type RouterHistory } from '@tanstack/react-router';

import type { AuthClient, Me, SessionGate } from '../api/auth-client.js';
import type { ApiErrorKind } from '../api/errors.js';
import { safeReturnPath } from '../lib/return-path.js';

/** Where the router reads the session from; `main.tsx` always passes it. */
export interface SessionSource {
  readonly authClient: Pick<AuthClient, 'me'>;
  readonly queryClient: QueryClient;
}

/** The query key of `GET /v1/me`; sign-out clears it with the rest of the cache. */
export const SESSION_QUERY_KEY = ['session', 'me'] as const;

/** The page of each gate. `password_expired` renders the expired-password page there. */
const GATE_PATHS = {
  password_change_required: '/change-password',
  password_expired: '/change-password',
  mfa_enrolment_required: '/mfa/enrol',
} as const satisfies Record<Exclude<SessionGate, 'none'>, string>;

/** A route path that a gate may own. */
export type GatePath = (typeof GATE_PATHS)[keyof typeof GATE_PATHS];

/** A failed session read. It carries the error kind only, never a server string. */
export class SessionReadError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind) {
    super('The session could not be read');
    this.name = 'SessionReadError';
    this.kind = kind;
  }
}

/** D4: at most one retry, and only on a network failure or a 5xx (`server`). */
function retrySessionRead(failureCount: number, error: Error): boolean {
  return failureCount < 1 && error instanceof SessionReadError && error.kind === 'server';
}

/**
 * The session query. Its function unwraps the `AuthResult` and throws on failure
 * (Q64), so a failure is never cached as data and the next read asks again.
 */
export function sessionQueryOptions(authClient: Pick<AuthClient, 'me'>) {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<Me> => {
      const result = await authClient.me();
      if (!result.ok) throw new SessionReadError(result.error.kind);
      return result.value;
    },
    retry: retrySessionRead,
  });
}

/** What a protected route adds to its context: the gate the server reported. */
export interface SessionRouteContext {
  readonly sessionGate: SessionGate;
}

/**
 * True when a route context holds the `password_expired` gate. The context is read as
 * `unknown`: without a session source no route adds the gate.
 */
export function isPasswordExpired(context: unknown): boolean {
  return (
    typeof context === 'object' &&
    context !== null &&
    Object.hasOwn(context, 'sessionGate') &&
    (context as Partial<SessionRouteContext>).sessionGate === 'password_expired'
  );
}

/**
 * The raw path and query of the location being loaded, without the fragment. They come
 * from the history, which the router updates before it loads, and not from the parsed
 * location, whose search string the router serializes again.
 */
function rawPathAndQuery(history: RouterHistory): string {
  const { pathname, search } = history.location;
  return `${pathname}${search}`;
}

/**
 * The redirect to a gate's page. It carries the requested path and query as `returnTo`,
 * so a changed password (Q73) or an enrolled factor (Q74) lands where the user was going.
 */
function gateRedirect(gatePath: GatePath, history: RouterHistory) {
  return redirect({
    to: gatePath,
    search: { returnTo: safeReturnPath(rawPathAndQuery(history)) },
  });
}

/**
 * The `beforeLoad` of the protected route at `ownPath`, over the router's `history`. It
 * throws a redirect to sign-in or to the gate's page, rethrows any other failure, and
 * otherwise hands the gate to the route context.
 */
export function sessionGuard(session: SessionSource, history: RouterHistory, ownPath: string) {
  return async (): Promise<SessionRouteContext> => {
    let me: Me;
    try {
      // `staleTime: 'static'` is the deprecated `ensureQueryData`: cached data is used
      // as is, and only a missing session (never a cached failure) is fetched.
      me = await session.queryClient.query({
        ...sessionQueryOptions(session.authClient),
        staleTime: 'static',
      });
    } catch (error) {
      if (error instanceof SessionReadError && error.kind === 'unauthenticated') {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a router redirect is thrown
        throw redirect({
          to: '/sign-in',
          search: { returnTo: safeReturnPath(rawPathAndQuery(history)) },
        });
      }
      throw error;
    }

    if (me.gate !== 'none') {
      const gatePath: GatePath = GATE_PATHS[me.gate];
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a router redirect is thrown
      if (gatePath !== ownPath) throw gateRedirect(gatePath, history);
    }
    return { sessionGate: me.gate };
  };
}
