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
 * Only the session-cookie branch is implemented here. Machine access tokens
 * (task 5.4), the idle timeout (task 3.2), the `onBehalfOf` non-read
 * guarantee this function already upholds by construction (task 3.4, design
 * D3 -- this module never reads request body, path, or query string at all),
 * and the independent membership re-check (task 3.6, design D19) are later
 * tasks' own red/green cycles, not implemented here.
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
  readonly session: { readonly activeOrganizationId?: string | null };
  readonly user: { readonly id: string };
}

interface AuthApiSurface {
  getSession(args: { headers: Headers }): Promise<SessionResult | null>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * design D3: "fails exactly as `CATALOG_CONTEXT_REQUIRED`". Both callers of
 * this function below reach it for different reasons; neither passes a
 * reason through, so the thrown error never carries one.
 */
function rejectMissingContext(): never {
  throw new AuthContextError();
}

export function createContextResolver(options: ContextResolverOptions): ContextResolver {
  const api = apiOf(options.auth);

  return async (headers: Headers): Promise<ResolvedContext> => {
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
