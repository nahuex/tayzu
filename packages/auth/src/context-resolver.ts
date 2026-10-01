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
 * The session-cookie branch also independently re-verifies
 * `session.activeOrganizationId` against a membership-row lookup (task 3.6,
 * design D19): "In addition to Better Auth's own membership check on
 * `setActiveOrganization`, `resolveContext()`'s session-cookie branch MUST
 * independently re-verify, via a membership-row lookup, that
 * `session.activeOrganizationId` names an organization the session's user
 * currently belongs to, using a cache no older than a few seconds. A failed
 * or unavailable re-verification MUST fail closed, with the same status and
 * body as `CATALOG_CONTEXT_REQUIRED`." The lookup goes through Better Auth's
 * own low-level adapter (`auth.$context`'s `.adapter`, the same primitive
 * `./auth.ts`'s own `databaseHooks` use via `context.context.adapter`), never
 * a second, ad hoc database connection -- direct SQL against the same `auth`
 * schema, outside `withTenantTransaction` (design D6). The result is cached
 * per resolver instance, keyed by `userId`/`organizationId`, for at most 5
 * seconds -- "bounded the same way D21's revocation cache is" (design D19) --
 * and a lookup failure is treated as non-membership and never cached, so a
 * transient failure fails closed for exactly one request rather than
 * extending the fail-closed window.
 *
 * Machine access tokens (task 5.4, design D5): a request carrying an
 * `Authorization: Bearer <token>` header is resolved through a second,
 * independent branch, never the session-cookie branch above -- "every
 * HTTP-served ... procedure MUST accept exactly two forms of caller
 * credential" (spec). The bearer token is the 1-hour access token
 * `./token-exchange.ts`'s `exchangeMachineToken` mints (task 5.3): this
 * branch verifies it via the `jwt` plugin's own `auth.api.verifyJWT`
 * (`better-auth@1.7.6`, `dist/plugins/jwt/verify.mjs`), which independently
 * rejects an unsigned, malformed, tampered, or expired token (`jose`'s own
 * `exp` check) by returning a `null` payload -- this module never re-checks
 * expiry itself. A verified payload's own `{ tenantId, actor: { type, id } }`
 * claims (design D5's own mint-time shape) are read back as-is and returned,
 * after validating their shape defensively (an untrusted signed payload
 * still gets structurally checked before being trusted as a `ResolvedContext`)
 * -- "A valid machine access token MUST resolve to `{ tenantId, actor: {
 * type: 'integration'|'agent', id } }` per the token's own claims" (spec).
 * Revocation-list consultation (task 5.7, design D21) is described at
 * `isCredentialRevoked` below.
 *
 * The `onBehalfOf` non-read guarantee this function already upholds by
 * construction (task 3.4, design D3 -- this module never reads request
 * body, path, or query string at all) applies equally to this branch.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { withTenantTransaction, type createPool } from '@tayzu/db';

import type { AuthInstance } from './auth.js';
import { logger, revocationChecksCounter } from './telemetry/instruments.js';
import { AuthContextError } from './errors.js';
import { isIdle } from './session-idle.js';

export interface ContextResolverOptions {
  /** The Better Auth instance whose session cookie `resolveContext` resolves against. */
  readonly auth: AuthInstance;
  /**
   * Task 5.7, design D21: a `tayzu_app` pool used to read
   * `machine_credential_revocation` on every machine-token request. When
   * required, so no resolver can skip the revocation list.
   */
  readonly revocationPool: ReturnType<typeof createPool>;
}

export interface ResolvedActor {
  readonly type: 'user' | 'integration' | 'agent';
  readonly id: string;
}

/**
 * Task 9.5, resolved decision Q26: the host-supplied authorization principal.
 * Filled only here, from the membership row, never from request input.
 */
export interface ResolvedPrincipal {
  readonly roles: readonly ('admin' | 'member')[];
  readonly teams?: readonly string[];
  readonly moderatedBlueprints?: readonly string[];
}

export interface ResolvedContext {
  readonly tenantId: string;
  readonly actor: ResolvedActor;
  readonly principal?: ResolvedPrincipal;
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
  readonly user: { readonly id: string; readonly email?: string };
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

/**
 * Task 5.4, design D5: the slice of `auth.api.verifyJWT`'s installed response
 * (`better-auth@1.7.6`, `dist/plugins/jwt/index.mjs`) this module reads. A
 * `null` payload covers every verification failure alike (bad signature,
 * malformed token, missing `sub`/`aud`, or an expired `exp` claim -- `jose`'s
 * own check, caught internally by `verifyJWT` and folded into the same
 * `null`) -- this module never distinguishes which.
 */
interface JwtApiSurface {
  verifyJWT(args: { body: { token: string } }): Promise<{
    readonly payload: Record<string, unknown> | null;
  }>;
}

function jwtApiOf(auth: AuthInstance): JwtApiSurface {
  return auth.api as JwtApiSurface;
}

/** design D5: `POST /v1/auth/token`'s bearer-token convention. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Reads a `Bearer` access token off the `authorization` header, or `null`
 * when the header is absent, empty, or not `Bearer`-scheme -- in every such
 * case the session-cookie branch runs instead (this module's own doc
 * comment).
 */
function extractBearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function isMachineActorType(value: unknown): value is 'integration' | 'agent' {
  return value === 'integration' || value === 'agent';
}

/**
 * Structurally validates a verified access token's own payload against
 * design D5's mint-time shape (`./token-exchange.ts`'s `exchangeMachineToken`)
 * before it is trusted as a `ResolvedContext` -- a valid signature proves the
 * token was minted by this instance's own `jwt` plugin key, not that its
 * claims are shaped the way this module expects, so they are checked anyway.
 */
function parseMachineTokenPayload(payload: Record<string, unknown>): ResolvedContext | null {
  const { tenantId, actor } = payload;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return null;
  }
  if (typeof actor !== 'object' || actor === null) {
    return null;
  }
  const { type, id } = actor as Record<string, unknown>;
  if (!isMachineActorType(type) || typeof id !== 'string' || id.length === 0) {
    return null;
  }
  // Q28: every machine credential is `member`, carried as a signed claim.
  // A missing or any other role fails closed; the principal never comes from input.
  if (payload['role'] !== 'member') {
    return null;
  }
  return {
    tenantId,
    actor: { type, id },
    principal: { roles: ['member'], teams: [], moderatedBlueprints: [] },
  };
}

/**
 * The slice of Better Auth's own `AuthContext` (`auth.$context`, `./auth.ts`'s
 * own doc comment) this module reads: its low-level model adapter, the same
 * primitive `./auth.ts`'s `databaseHooks` reach via `context.context.adapter`.
 */
interface AuthContextSurface {
  readonly adapter: {
    findOne(data: {
      readonly model: 'member';
      readonly where: ReadonlyArray<{ readonly field: string; readonly value: string }>;
    }): Promise<{ readonly role?: unknown } | null>;
  };
}

function contextOf(auth: AuthInstance): Promise<AuthContextSurface> {
  return auth.$context as Promise<AuthContextSurface>;
}

/**
 * design D19: "using a cache no older than a few seconds," bounded the same
 * way design D21's revocation cache is (task 5.7, "a TTL of at most 5
 * seconds").
 */
const MEMBERSHIP_CACHE_TTL_MS = 5000;

/** design D21: the revocation cache's TTL ("at most 5 seconds"). */
const REVOCATION_CACHE_TTL_MS = 5000;

interface RevocationCacheEntry {
  readonly revoked: boolean;
  readonly expiresAt: number;
}

interface MembershipCacheEntry {
  /** The Better Auth member role, or `null` for a non-member. */
  readonly role: string | null;
  readonly expiresAt: number;
}

/**
 * Better Auth `owner`/`admin` -> Cerbos `admin`; every other role -> `member`
 * (design D11, Q26). Better Auth may store several roles comma-separated.
 */
function toCerbosRole(memberRole: string): 'admin' | 'member' {
  const roles = memberRole.split(',').map((role) => role.trim());
  return roles.includes('owner') || roles.includes('admin') ? 'admin' : 'member';
}

/** design Q34, D8: the `_user` entity's teams and moderated blueprints. */
interface UserEntityGrants {
  readonly teams: readonly string[];
  readonly moderatedBlueprints: readonly string[];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads the caller's `_user` entity (identifier = the user's email) and its
 * `teams` relation under the caller's tenant. An absent entity means no
 * grants; a read failure throws, and the caller fails closed.
 */
async function readUserEntityGrants(
  pool: ReturnType<typeof createPool>,
  tenantId: string,
  email: string,
): Promise<UserEntityGrants> {
  return withTenantTransaction(pool, { tenantId }, async (client) => {
    const entity = await client.query<{ id: string; spec_properties: unknown }>(
      `select e.id, e.spec_properties
         from catalog_entity e
         join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
        where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
      [tenantId, email],
    );
    const row = entity.rows[0];
    if (row === undefined) {
      return { teams: [], moderatedBlueprints: [] };
    }
    const properties = row.spec_properties as Record<string, unknown> | null;
    const teams = await client.query<{ identifier: string }>(
      `select t.identifier
         from catalog_entity_relation r
         join catalog_relation_definition d
           on d.tenant_id = r.tenant_id and d.id = r.relation_definition_id
         join catalog_entity t on t.tenant_id = r.tenant_id and t.id = r.target_entity_id
        where r.tenant_id = $1 and r.source_entity_id = $2
          and r.scope = 'spec' and d.identifier = 'teams'
        order by r.position`,
      [tenantId, row.id],
    );
    return {
      teams: teams.rows.map((team) => team.identifier),
      moderatedBlueprints: stringsOf(properties?.['moderatedBlueprints']),
    };
  });
}

function membershipCacheKey(userId: string, organizationId: string): string {
  return `${userId}\u0000${organizationId}`;
}

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
  const jwtApi = jwtApiOf(options.auth);
  const membershipCache = new Map<string, MembershipCacheEntry>();
  const revocationCache = new Map<string, RevocationCacheEntry>();

  // Task 5.7, design D21: consults `machine_credential_revocation` through
  // an in-process cache keyed by `credential_id` (TTL 5 s). Read under the
  // token's own tenant claim, so RLS applies. Any lookup failure resolves to
  // "revoked" and is never cached: the token is rejected, never assumed
  // not revoked.
  // Telemetry (design D21): one counter increment per check, and a WARN log
  // on a revoked rejection; only the tenant and the credential kind, never
  // the token, client id or secret.
  async function isCredentialRevoked(
    pool: ReturnType<typeof createPool>,
    tenantId: string,
    credentialId: string,
    kind: string,
  ): Promise<boolean> {
    const result = await lookupRevoked(pool, tenantId, credentialId);
    revocationChecksCounter.add(1, {
      'tayzu.auth.credential.kind': kind,
      'tayzu.auth.revocation.result': result,
    });
    if (result === 'rejected') {
      logger.emit({
        eventName: 'auth.security.revoked_token_rejected',
        severityNumber: SeverityNumber.WARN,
        attributes: { 'tayzu.tenant.id': tenantId, 'tayzu.auth.credential.kind': kind },
      });
    }
    return result !== 'allowed';
  }

  async function lookupRevoked(
    pool: ReturnType<typeof createPool>,
    tenantId: string,
    credentialId: string,
  ): Promise<'allowed' | 'rejected' | 'lookup_failed'> {
    const now = Date.now();
    const cached = revocationCache.get(credentialId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.revoked ? 'rejected' : 'allowed';
    }

    let revoked: boolean;
    try {
      revoked = await withTenantTransaction(pool, { tenantId }, async (client) => {
        const result = await client.query(
          'select 1 from machine_credential_revocation where credential_id = $1 and tenant_id = $2',
          [credentialId, tenantId],
        );
        return result.rows.length > 0;
      });
    } catch {
      return 'lookup_failed';
    }

    revocationCache.set(credentialId, { revoked, expiresAt: now + REVOCATION_CACHE_TTL_MS });
    return revoked ? 'rejected' : 'allowed';
  }

  // Task 3.6, design D19: the independent membership re-check. A cache hit
  // (younger than `MEMBERSHIP_CACHE_TTL_MS`) skips the lookup; a miss
  // queries Better Auth's own `member` table directly. Any lookup failure
  // (the table or the database is unreachable) resolves to `false` and is
  // never cached, so it fails closed for exactly this one request rather
  // than widening the fail-closed window past the failure itself.
  // Resolves to the member's role, or `null` when not a member / on failure.
  async function memberRoleOf(userId: string, organizationId: string): Promise<string | null> {
    const key = membershipCacheKey(userId, organizationId);
    const now = Date.now();
    const cached = membershipCache.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.role;
    }

    let role: string | null;
    try {
      const context = await contextOf(options.auth);
      const member = await context.adapter.findOne({
        model: 'member',
        where: [
          { field: 'organizationId', value: organizationId },
          { field: 'userId', value: userId },
        ],
      });
      role = member === null ? null : typeof member.role === 'string' ? member.role : 'member';
    } catch {
      return null;
    }

    membershipCache.set(key, { role, expiresAt: now + MEMBERSHIP_CACHE_TTL_MS });
    return role;
  }

  return async (headers: Headers): Promise<ResolvedContext> => {
    // Task 5.4, design D5: a `Bearer` access token is resolved through its
    // own branch, never falling through to the session-cookie branch below
    // -- "exactly two forms of caller credential" (spec), never both checked
    // for the same request.
    const bearerToken = extractBearerToken(headers);
    if (bearerToken !== null) {
      const verified = await jwtApi.verifyJWT({ body: { token: bearerToken } });
      if (verified.payload === null) {
        rejectMissingContext();
      }
      const resolved = parseMachineTokenPayload(verified.payload);
      if (resolved === null) {
        rejectMissingContext();
      }
      if (
        await isCredentialRevoked(
          options.revocationPool,
          resolved.tenantId,
          resolved.actor.id,
          resolved.actor.type,
        )
      ) {
        rejectMissingContext();
      }
      return resolved;
    }

    // design D3: the 12-hour idle timeout, layered on top of Better Auth's
    // own 7-day `expiresIn`/1-day `updateAge`. `disableRefresh: true` reads
    // `updatedAt` as actually persisted, immune to the refresh-on-read side
    // effect a plain `getSession` call could otherwise trigger (see this
    // module's own doc comment). Checked against last use (`updatedAt`),
    // never against `createdAt`.
    // The `/get-session` before hook (task 27.3) refuses an idle session
    // with an `APIError`; that refusal is the same context rejection.
    const idlePeek = await api
      .getSession({ headers, query: { disableRefresh: true } })
      .catch(() => rejectMissingContext());
    if (idlePeek === null) {
      rejectMissingContext();
    }
    if (isIdle(idlePeek.session.updatedAt)) {
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

    // Task 3.6, design D19: independently re-verify the session's own
    // `activeOrganizationId` against a membership-row lookup, rather than
    // trusting the session row alone.
    const memberRole = await memberRoleOf(result.user.id, tenantId);
    if (memberRole === null) {
      rejectMissingContext();
    }

    // Task 23.1, Q34: teams and moderated blueprints come from the caller's
    // `_user` entity. If it cannot be read the principal is left absent, so
    // Cerbos denies (fail closed) instead of assuming empty grants.
    const actor = { type: 'user', id: result.user.id } as const;
    const email = result.user.email;
    if (typeof email !== 'string' || email.length === 0) {
      return { tenantId, actor };
    }
    try {
      const grants = await readUserEntityGrants(options.revocationPool, tenantId, email);
      return {
        tenantId,
        actor,
        principal: {
          roles: [toCerbosRole(memberRole)],
          teams: grants.teams,
          moderatedBlueprints: grants.moderatedBlueprints,
        },
      };
    } catch {
      return { tenantId, actor };
    }
  };
}
