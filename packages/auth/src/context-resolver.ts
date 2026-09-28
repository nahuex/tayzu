/**
 * Session and tenant resolution (task 3.1, design D3;
 * `specs/auth-and-rbac/spec.md`, "Session and tenant resolution").
 *
 * `createContextResolver({ auth })` returns `resolveContext(headers)`: the
 * session-cookie branch this task covers resolves a real Better Auth session
 * cookie to `{ tenantId: session.activeOrganizationId, actor: { type: 'user',
 * id: user.id } }` -- the exact shape `@tayzu/catalog`'s `CatalogContext`
 * expects (`packages/catalog/src/domain/context.ts`), reused structurally
 * here without a `@tayzu/catalog` dependency (`./errors.js`'s own doc
 * comment explains why).
 *
 * Three outcomes:
 * - A session cookie naming a session with an active organization resolves.
 * - No session cookie (or one Better Auth cannot resolve to a session)
 *   rejects with `AuthContextError`.
 * - A session with no active organization (`activeOrganizationId` `null` or
 *   absent) rejects with the identical `AuthContextError` -- same code, same
 *   message, no detail distinguishing it from the "no session" case.
 *
 * The session-cookie branch also enforces the 12-hour idle timeout (task
 * 3.2, design D3): "every session row's `updatedAt` is checked against 'now'
 * on each use; a session whose last use exceeds 12 hours is treated as
 * expired even though Better Auth's own `expiresIn` has not elapsed." This
 * is layered on top of, not instead of, Better Auth's own `expiresAt` check
 * (already enforced by `api.getSession` itself, which returns `null` for a
 * session past its 7-day `expiresIn`).
 *
 * The idle check itself is done against a `disableRefresh: true` read of
 * `api.getSession` (Better Auth's own documented escape hatch from its
 * `session.updateAge`-driven refresh-on-read side effect, `dist/api/routes/
 * session.mjs`, verified against the installed `better-auth@1.7.6` source):
 * without it, `api.getSession` can itself rewrite `updatedAt` to "now" as a
 * side effect of being called (Better Auth's own rolling-refresh mechanism,
 * `session.updateAge`), which would make a stale session look fresh before
 * this module ever gets to check it. `updatedAt` is read this way purely to
 * decide idleness; the session actually resolved below is read through a
 * second, ordinary (non-`disableRefresh`) call, so Better Auth's own
 * rolling-refresh still runs normally on every non-idle use, exactly as
 * design D3's "kept" `updateAge` describes.
 *
 * Machine access tokens (task 5.4), the `onBehalfOf` non-read guarantee this
 * function already upholds by construction (task 3.4, design D3 -- this
 * module never reads request body, path, or query string at all), and the
 * independent membership re-check (task 3.6, design D19) are later tasks'
 * own red/green cycles, not implemented here.
 */
import type { AuthInstance } from './auth.js';
import { AuthContextError } from './errors.js';

export interface ContextResolverOptions {
  /** The Better Auth instance whose session cookie `resolveContext` resolves against. */
  readonly auth: AuthInstance;
}

export interface ResolvedActor {
  readonly type: 'user';
  readonly id: string;
}

export interface ResolvedContext {
  readonly tenantId: string;
  readonly actor: ResolvedActor;
}

export type ContextResolver = (headers: Headers) => Promise<ResolvedContext>;

/**
 * The slice of `auth.api.getSession`'s resolved value this module reads.
 * `AuthInstance.api` is typed `unknown` (`./auth.ts`); this narrows it
 * locally, the same "introspect the narrower production type locally"
 * pattern `context-resolver.int.test.ts`'s own `AuthApiSurface` uses.
 */
interface SessionResult {
  readonly session: {
    readonly activeOrganizationId?: string | null;
    readonly updatedAt: Date;
  };
  readonly user: { readonly id: string };
}

interface AuthApiSurface {
  getSession(args: {
    headers: Headers;
    query?: { readonly disableRefresh?: boolean };
  }): Promise<SessionResult | null>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/** design D3, Resolved decision Q7: the idle-timeout window, in milliseconds. */
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * design D3: "fails exactly as `CATALOG_CONTEXT_REQUIRED`". Every caller of
 * this function below reaches it for a different reason; none passes a
 * reason through, so the thrown error never carries one.
 */
function rejectMissingContext(): never {
  throw new AuthContextError();
}

export function createContextResolver(options: ContextResolverOptions): ContextResolver {
  const api = apiOf(options.auth);

  return async (headers: Headers): Promise<ResolvedContext> => {
    // design D3: the 12-hour idle timeout, layered on top of Better Auth's
    // own 7-day `expiresIn`/1-day `updateAge`. `disableRefresh: true` reads
    // `updatedAt` as actually persisted, immune to the refresh-on-read side
    // effect a plain `getSession` call could otherwise trigger (see this
    // module's own doc comment). Checked against last use (`updatedAt`),
    // never against `createdAt`.
    const idlePeek = await api.getSession({ headers, query: { disableRefresh: true } });
    if (idlePeek === null) {
      rejectMissingContext();
    }
    const idleFor = Date.now() - idlePeek.session.updatedAt.getTime();
    if (idleFor > IDLE_TIMEOUT_MS) {
      rejectMissingContext();
    }

    // Not idle: resolve normally. Better Auth's own `expiresAt` check
    // (returning `null` past the 7-day `expiresIn`) and its rolling refresh
    // (`session.updateAge`, design D3's "kept") both apply as usual here.
    const result = await api.getSession({ headers });
    if (result === null) {
      rejectMissingContext();
    }

    const tenantId = result.session.activeOrganizationId;
    if (tenantId === null || tenantId === undefined) {
      rejectMissingContext();
    }

    return {
      tenantId,
      actor: { type: 'user', id: result.user.id },
    };
  };
}
