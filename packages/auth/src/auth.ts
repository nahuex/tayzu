/**
 * The @tayzu/auth Better Auth instance (task 2.1, design D2).
 *
 * `organization`, `admin`, `two-factor` and `jwt` (all bundled in
 * `better-auth`) and `apiKey` (the separate `@better-auth/api-key` package)
 * are registered. `organization`'s `dynamicAccessControl` and `teams`
 * sub-options are left unconfigured (off): Cerbos is the only authorization
 * decision point (Better Auth's roles are read as plain input attributes),
 * and `_team` is a catalog system blueprint, not a second, Better-Auth-native
 * notion of team membership (D2, D9).
 *
 * Every Better Auth table lives in its own Postgres schema, `auth`, via
 * `@better-auth/drizzle-adapter`'s `schemaName` option — never `public`.
 *
 * Task 2.4 (design D3, D19; "Observability contract"): `databaseHooks.
 * session.create.before` resolves `session.activeOrganizationId` on every
 * session creation (sign-up and sign-in alike — orchestrator decision: a
 * user belonging to exactly one organization gets it as their active one,
 * otherwise it stays `null`), and a top-level `hooks.after` emits the
 * `auth.security.login_succeeded`/`login_failed` log events and the
 * `tayzu.auth.session.events` counter for `/sign-in/email`. Both hooks look
 * up rows through the request's own `DBAdapter` (`context.context.adapter`),
 * never a second, ad hoc database connection.
 *
 * Task 3.3 (design D3): a top-level `hooks.before` forces
 * `revokeOtherSessions: true` onto every `/change-password` call -- "A
 * password change MUST revoke every other active session belonging to that
 * user," production code's own responsibility, not something left to
 * whichever caller happens to invoke `changePassword`. The same `hooks.after`
 * that already handles `/sign-in/email` also handles `/change-password`,
 * emitting `auth.security.session_revoked` (reason `password_change`) and the
 * `tayzu.auth.session.events` counter on success.
 *
 * Task 3.5 (design D19): "their active organization is unchanged" after a
 * rejected `/organization/set-active` attempt. Better Auth's own installed
 * route (`dist/plugins/organization/routes/crud-org.mjs`, verified against
 * the installed `better-auth@1.7.6` source) persists
 * `activeOrganizationId = null` on the session *before* throwing `FORBIDDEN
 * USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` on a non-member attempt -- a
 * rejected request whose active organization was still changed, from a real
 * organization to none. A `hooks.before` snapshot (via the same
 * `getSessionFromCtx` helper Better Auth's own `sessionMiddleware` uses, so
 * the read is cached and adds no extra round trip) paired with a
 * `hooks.after` restore (`internalAdapter.updateSession`, the same primitive
 * the organization plugin's own `setActiveOrganization` calls) undoes that
 * side effect whenever the attempt is rejected, independent of Better Auth's
 * own ordering. The snapshot lives in a `WeakMap` keyed by the per-request
 * `ctx.context` object (a fresh object every dispatch, per
 * `dist/api/dispatch.mjs`), so it needs no manual cleanup on the success
 * path.
 *
 * Task 4.2 (design D4): a top-level `hooks.after` matcher on every
 * `/two-factor/verify-*` path records the step-up freshness marker
 * `./step-up.ts`'s guard reads back (see that module's own doc comment for
 * why this file, not Better Auth itself, owns writing it).
 *
 * Configuration comes only from `CreateAuthOptions`, supplied by the host
 * (`apps/api`): this library never reads `process.env` or logs `secret`.
 */
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter, type DB } from '@better-auth/drizzle-adapter';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { admin, jwt, organization, twoFactor } from 'better-auth/plugins';

import {
  preAuthRateLimitPlugin,
  type PreAuthRateLimitOptions,
} from './rate-limit/pre-auth-rate-limit.js';
import {
  callbackFailureCode,
  isCallbackHop,
  recordSsoSignInFailed,
  ssoRejectedResponse,
  SSO_CALLBACK_PATH,
} from './sso/callback-rejection.js';
import { emitAccountLinkEvent } from './account-link-telemetry.js';
import {
  VISMA_CONNECT_PROVIDER_ID,
  vismaConnect,
  type VismaConnectOptions,
} from './sso/visma-connect.js';
import { fetchVismaUserInfo } from './sso/userinfo-refresh.js';
import { STEP_UP_FRESHNESS_MS, stepUpVerificationIdentifier } from './step-up.js';
import { logger, sessionEventsCounter, ssoEventsCounter, tracer } from './telemetry/instruments.js';

const SIGN_IN_EMAIL_PATH = '/sign-in/email';
const CHANGE_PASSWORD_PATH = '/change-password';
const SET_ACTIVE_ORGANIZATION_PATH = '/organization/set-active';
/** design D4: every `two-factor` verify endpoint (`/two-factor/verify-totp`, `-backup-code`, `-otp`). */
const TWO_FACTOR_VERIFY_PATH_PREFIX = '/two-factor/verify';

/** design D5, task 5.1: the one `apiKey` plugin config machine credentials use (`./machine-credentials.ts`). */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/**
 * Task 5.4 fix (design D5): a fixed, non-secret `iss`/`aud` for every `jwt`
 * plugin-signed token this instance mints (`./token-exchange.ts`'s machine
 * access tokens today; the plugin's own session-JWT side channel later, if
 * ever read back). Required because the installed `better-auth@1.7.6` `jwt`
 * plugin's own `verifyJWT` (`dist/plugins/jwt/verify.mjs`) rejects any
 * payload whose `aud` claim is falsy, and both `signJWT` and `verifyJWT`
 * fall back identically to `ctx.context.options.baseURL` -- an empty
 * string, never `undefined`, when unset (confirmed against the installed
 * `create-context.mjs`) -- for `iss`/`aud` alike whenever this option is
 * left unset, which is falsy and so always rejected. Configured once, here,
 * rather than per-payload in `./token-exchange.ts`, so `signJWT`'s and
 * `verifyJWT`'s defaults stay the same fixed value on both sides.
 */
const MACHINE_TOKEN_ISSUER = 'tayzu-auth';
const MACHINE_TOKEN_AUDIENCE = 'tayzu-auth';

/**
 * design D18/D22, task 18.2: Better Auth's own sign-up route. Never added to
 * D18's allowlist (`packages/auth/CLAUDE.md`, task 11.9) -- intercepted here
 * instead, ahead of that later Fastify-layer work, since `apps/api` is not a
 * running listener yet (task 1.2's scaffold) and this route must already be
 * indistinguishable from an unmatched one through `auth.handler`, Better
 * Auth's real HTTP entry point, the one `apps/api` mounts unchanged in task
 * 11.1.
 */
const SIGN_UP_EMAIL_PATH = '/sign-up/email';

/**
 * Better Auth's own default `basePath` (`dist/context/create-context.mjs`:
 * `options.basePath || "/api/auth"`) -- `CreateAuthOptions` never overrides
 * it, so it is fixed here rather than threaded through per request.
 */
const AUTH_BASE_PATH = '/api/auth';

/** design.md, Metrics table: `tayzu.auth.session.events`'s only attribute. */
const AUTH_EVENT_ATTRIBUTE = 'tayzu.auth.event';

/** design.md, Log events table: `auth.security.login_failed`'s only attribute. */
const FAILURE_REASON_ATTRIBUTE = 'tayzu.auth.failure_reason';

/** design.md, Log events table: `auth.security.session_revoked`'s reason attribute. */
const REVOCATION_REASON_ATTRIBUTE = 'tayzu.auth.revocation.reason';

/** design.md, Log events table: `auth.security.session_revoked` -- the only reason task 3.3 emits. */
const PASSWORD_CHANGE_REVOCATION_REASON = 'password_change';

/**
 * Mirrors `@better-auth/core/utils/url`'s `normalizePathname` (also mirrored
 * by `./rate-limit/pre-auth-rate-limit.ts`'s own `requestPath`), relative to
 * the fixed `AUTH_BASE_PATH` above. Duplicated locally rather than imported:
 * `@better-auth/core` is only a transitive dependency of `better-auth`, not a
 * direct dependency of this package (`package.json`), so importing it would
 * be a phantom dependency under pnpm's strict `node_modules` layout.
 */
function normalizedRequestPath(request: Request): string {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (pathname === AUTH_BASE_PATH) {
    return '/';
  }
  if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    return pathname.slice(AUTH_BASE_PATH.length) || '/';
  }
  return pathname;
}

/**
 * Byte-identical to `better-call@1.4.0`'s own unmatched-route response
 * (`dist/router.mjs`, `processRequest`: every "no route" branch returns
 * `new Response(null, { status: 404, statusText: "Not Found" })`) -- so a
 * request to `SIGN_UP_EMAIL_PATH` cannot be told apart from a request to a
 * path that was never registered at all (design D18's own reasoning: a
 * different status, body, or even a `403` would reveal the route exists).
 */
function unmatchedRouteResponse(): Response {
  return new Response(null, { status: 404, statusText: 'Not Found' });
}

/** A single `auth.member` row: the shape `databaseHooks.session.create.before` needs. */
interface MembershipRow {
  readonly organizationId: string;
}

/**
 * Task 3.5, design D19: the session state `hooks.before` snapshots for
 * `/organization/set-active`, restored by `hooks.after` on rejection. Keyed
 * by the per-request `ctx.context` object (see this file's own doc comment
 * for why that needs no manual cleanup).
 */
interface ActiveOrganizationSnapshot {
  readonly sessionToken: string;
  readonly previousActiveOrganizationId: string | null;
}

const activeOrganizationBeforeAttempt = new WeakMap<object, ActiveOrganizationSnapshot>();

/** The `auth.session` row's tenant column, read back after `/sign-in/email` creates it. */
interface ActiveOrganizationRow {
  readonly activeOrganizationId: string | null;
}

/** `/sign-in/email`'s success body (Better Auth's own route, `sign-in.mjs`): the fields this file reads. */
interface SignInEmailSuccessResponse {
  readonly token: string;
  readonly user: { readonly id: string };
}

/**
 * `/change-password`'s success body (Better Auth's own route,
 * `update-user.mjs`): the fields this file reads. `token` is the new
 * session's token, set whenever `revokeOtherSessions` is true -- always, on
 * this path, since `hooks.before` below forces it.
 */
interface ChangePasswordSuccessResponse {
  readonly token: string | null;
  readonly user: { readonly id: string };
}

/**
 * Every `/two-factor/verify-*` endpoint's success body (`verify-two-factor.
 * mjs`'s own `valid(ctx)` handler, shared by `verifyTOTP`/`verifyBackupCode`):
 * the field task 4.2's freshness marker keys on. `token` is only absent when
 * a caller opts out of a new session via `disableSession` (`verify-backup-
 * code` only) -- that path carries nothing to key a freshness marker on, so
 * it is silently skipped (task 4.2, design D4).
 */
interface TwoFactorVerifySuccessResponse {
  readonly token?: string | null;
}

/** design.md, Log events table: `auth.security.login_succeeded`. */
function emitLoginSucceeded(params: {
  readonly actorId: string;
  readonly tenantId?: string;
}): void {
  const attributes: Record<string, string> = {
    [sharedAttributeKeys.actorId]: params.actorId,
  };
  if (params.tenantId !== undefined) {
    attributes[sharedAttributeKeys.tenantId] = params.tenantId;
  }
  logger.emit({
    eventName: 'auth.security.login_succeeded',
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
  sessionEventsCounter.add(1, { [AUTH_EVENT_ATTRIBUTE]: 'login_succeeded' });
}

/**
 * design.md, Log events table: `auth.security.login_failed`. Wrong password
 * and an unknown email both reach here as the identical `bad_credentials`
 * reason (Better Auth's own enumeration-resistant `INVALID_EMAIL_OR_PASSWORD`
 * `APIError`, thrown identically for both cases by `/sign-in/email`); no
 * other failure reason is reachable from this route yet (`mfa_failed`,
 * `account_disabled` are later tasks' concern).
 */
function emitLoginFailed(): void {
  logger.emit({
    eventName: 'auth.security.login_failed',
    severityNumber: SeverityNumber.WARN,
    attributes: { [FAILURE_REASON_ATTRIBUTE]: 'bad_credentials' },
  });
  sessionEventsCounter.add(1, { [AUTH_EVENT_ATTRIBUTE]: 'login_failed' });
}

/**
 * design.md, Log events table: `auth.security.session_revoked`. Task 3.3
 * only reaches this for the `password_change` reason; `admin_action` is a
 * later task's own hook.
 */
function emitSessionRevoked(params: {
  readonly actorId: string;
  readonly tenantId?: string;
}): void {
  const attributes: Record<string, string> = {
    [sharedAttributeKeys.actorId]: params.actorId,
    [REVOCATION_REASON_ATTRIBUTE]: PASSWORD_CHANGE_REVOCATION_REASON,
  };
  if (params.tenantId !== undefined) {
    attributes[sharedAttributeKeys.tenantId] = params.tenantId;
  }
  logger.emit({
    eventName: 'auth.security.session_revoked',
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
  sessionEventsCounter.add(1, { [AUTH_EVENT_ATTRIBUTE]: 'session_revoked' });
}

/** The `providerId` of the Visma Connect SSO account (design D23). */
const SELF_LINK_PROVIDER_ID = VISMA_CONNECT_PROVIDER_ID;

/** Emits the D24 audit signals for a self-service link/unlink; skips non-SSO accounts and direct adapter calls. */
async function emitSelfLink(
  event: 'linked' | 'unlinked',
  account: { readonly providerId?: unknown; readonly userId?: unknown },
  context: Parameters<typeof getSessionFromCtx>[0] | null | undefined,
): Promise<void> {
  if (!context || account.providerId !== SELF_LINK_PROVIDER_ID) {
    return;
  }
  if (typeof account.userId !== 'string') {
    return;
  }
  const session = await getSessionFromCtx(context).catch(() => null);
  const tenantId = (session?.session as { activeOrganizationId?: string | null } | undefined)
    ?.activeOrganizationId;
  emitAccountLinkEvent(event, 'self', {
    actorId: account.userId,
    ...(typeof tenantId === 'string' ? { tenantId } : {}),
  });
}

/** Better Auth's route template for `/callback/:providerId` (`ctx.path` is the template, not the URL). */
const GENERIC_OAUTH_CALLBACK_ROUTE = '/callback/:id';

/**
 * Task 21.1, design D24: after a Visma Connect callback sign-in, writes the
 * userinfo `name`/`email` to the linked user's `_user` entity (`title` /
 * `contactEmail`) through the `system`-actor user sync. The entity is
 * addressed by the user's own local email, and Better Auth's `user.email` is
 * never written. Best-effort: any failure leaves the sign-in untouched.
 */
async function refreshDisplayData(
  options: CreateAuthOptions,
  account: {
    readonly providerId?: unknown;
    readonly userId?: unknown;
    readonly accessToken?: unknown;
  },
  context: Parameters<typeof getSessionFromCtx>[0] | null | undefined,
): Promise<void> {
  if (
    options.sso === undefined ||
    options.userSync === undefined ||
    !context ||
    context.path !== GENERIC_OAUTH_CALLBACK_ROUTE ||
    account.providerId !== VISMA_CONNECT_PROVIDER_ID ||
    typeof account.userId !== 'string' ||
    typeof account.accessToken !== 'string'
  ) {
    return;
  }
  try {
    const info = await fetchVismaUserInfo(options.sso.discoveryUrl, account.accessToken);
    if (info === null || (info.name === undefined && info.email === undefined)) {
      return;
    }
    const user = await context.context.internalAdapter.findUserById(account.userId);
    if (user === null) {
      return;
    }
    const memberships = await context.context.adapter.findMany<MembershipRow>({
      model: 'member',
      where: [{ field: 'userId', value: account.userId }],
    });
    for (const membership of memberships) {
      await options.userSync.upsertUser({
        tenantId: membership.organizationId,
        email: user.email,
        name: info.name ?? user.name,
        ...(info.email === undefined ? {} : { contactEmail: info.email }),
      });
    }
  } catch {
    // Display data is best-effort; never block or fail the sign-in.
  }
}

export interface CreateAuthOptions {
  /**
   * A `@better-auth/drizzle-adapter`-compatible DB handle. The adapter never
   * queries it during construction (`betterAuth`'s own `getEndpoints` builds
   * `auth.api` synchronously from the plugin list), so any object shaped
   * like a Drizzle database is enough here.
   */
  readonly db: DB;
  /** Better Auth's own `secret` option (`BETTER_AUTH_SECRET`, host-resolved). */
  readonly secret: string;
  /**
   * Pre-authentication rate limiting (task 2.5, design D20). Optional so
   * every earlier task's `createAuth({ db, secret })` call keeps working
   * unchanged; a path with no configured rule here is never rate-limited.
   */
  readonly rateLimit?: PreAuthRateLimitOptions;
  /**
   * Task 12.2 (design D22, Q16): keeps the tenant's `_user` entity in step
   * with Better Auth. Typed structurally so this package does not depend on
   * `@tayzu/catalog`; the host passes `createUserSync(...)`. Optional so
   * earlier tasks' `createAuth({ db, secret })` calls keep working.
   */
  readonly userSync?: UserSyncPort;
  /**
   * Task 19.2 (design D23, Q17): Visma Connect SSO. When set, registers the
   * `genericOAuth` provider; otherwise no SSO plugin exists.
   */
  readonly sso?: VismaConnectOptions;
}

/** The structural slice of `@tayzu/catalog`'s `UserSync` this package calls. */
export interface UserSyncPort {
  upsertUser(input: {
    readonly tenantId: string;
    readonly email: string;
    readonly name: string;
    /** Display-only Visma Connect email (design D24); never an identity key. */
    readonly contactEmail?: string;
    readonly portRole?: 'admin' | 'member';
    readonly status?: 'Active' | 'Disabled';
  }): Promise<void>;
}

/** The `auth.user` columns the `_user` sync reads. */
interface SyncUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly banned?: boolean | null;
}

/** design Q2: Better Auth `owner`/`admin` organization roles map to `portRole` `admin`. */
function portRoleFor(role: string): 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? 'admin' : 'member';
}

export interface AuthInstance {
  /**
   * Better Auth's generated endpoint surface, keyed by handler name (for
   * example `createOrganization`, `banUser`, `enableTwoFactor`,
   * `createApiKey`, `getToken`). Callers introspect it by name; this stays
   * `unknown` rather than Better Auth's own precise per-plugin-inferred type
   * because nothing in this package needs that precision yet.
   */
  readonly api: unknown;
  /**
   * Better Auth's own internal context promise (`Auth['$context']`,
   * `dist/types/auth.d.mts`), the same object `databaseHooks` above reach via
   * `context.context` -- its `.adapter` is Better Auth's own low-level model
   * adapter (`findOne`/`findMany`/`count`, keyed by model name), independent
   * of any request/session middleware. `./context-resolver.ts`'s task 3.6
   * membership re-check reads `.adapter` off it the same way, outside any
   * hook. Typed `unknown` for the same reason `api` is: callers narrow it
   * locally where used.
   */
  readonly $context: unknown;
}

/**
 * Better Auth's own runtime `handler` shape (`Auth['handler']`,
 * `dist/types/auth.d.mts`; also `.fetch`, the identical function under a
 * second name) -- the narrow surface `createAuth`'s sign-up guard below
 * needs. `AuthInstance` stays `unknown`-typed for `api`/`$context`
 * (see that interface's own doc comments); this local type exists only to
 * wrap `handler`/`fetch` without widening the public interface.
 */
interface AuthHandlerSurface {
  readonly handler: (request: Request) => Promise<Response>;
  readonly fetch: (request: Request) => Promise<Response>;
}

/** Builds the one `betterAuth` instance `@tayzu/auth` exposes. */
export function createAuth(options: CreateAuthOptions): AuthInstance {
  const auth = betterAuth({
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schemaName: 'auth',
    }),
    // Email/password sign-up and sign-in (task 2.3). No `minPasswordLength`
    // override: Better Auth's own default (8 characters) is the policy this
    // change fixes; a stricter policy is not named anywhere in the design.
    // `disableSignUp: true` (task 18.1/18.2, design D22): public self
    // sign-up is disabled under every circumstance -- users are created only
    // through the admin-creation path (`identity.users.create`, task 18.3)
    // or the bootstrap script (task 18.4), both calling `auth.api.
    // createUser` directly, which `disableSignUp` does not affect (confirmed
    // against the installed `@better-auth/core@1.7.6` option type).
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    // `enabled: false` (task 2.5, design D20): Better Auth's own built-in
    // database-backed rate limiter can only key by IP+path and its blocked
    // response cannot be reshaped into `AUTH_RATE_LIMITED`/`Retry-After`
    // (`./rate-limit/pre-auth-rate-limit.ts`'s own module doc comment), so
    // it stays fully disabled; `storage: "database"` still registers the
    // `rateLimit` schema table (`./persistence/schema.ts`) that plugin reads
    // and writes through `ctx.adapter` instead.
    rateLimit: {
      enabled: false,
      storage: 'database',
    },
    plugins: [
      // Task 12.2 (design D22, Q16): organization-member add (including the
      // owner membership `createOrganization` creates, so the bootstrap
      // script is covered) upserts the tenant's `_user` entity. Better Auth's
      // organization adapter writes members below `databaseHooks`, so the
      // plugin's own `organizationHooks` is the hook point.
      organization({
        organizationHooks: {
          afterAddMember: async ({ member, user }) => {
            await options.userSync?.upsertUser({
              tenantId: member.organizationId,
              email: user.email,
              name: user.name,
              portRole: portRoleFor(member.role),
              status: (user as { banned?: boolean | null }).banned === true ? 'Disabled' : 'Active',
            });
          },
        },
      }),
      admin(),
      twoFactor(),
      // Task 5.4 fix (this file's own `MACHINE_TOKEN_ISSUER`/`_AUDIENCE` doc
      // comment): a fixed, non-empty `iss`/`aud` default, required for
      // `verifyJWT` to accept any token this plugin signs at all.
      jwt({
        jwt: { issuer: MACHINE_TOKEN_ISSUER, audience: MACHINE_TOKEN_AUDIENCE },
        // Tayzu never uses the `set-auth-jwt` session response header, and
        // it would sign a token (decrypting the JWKS private key) on every
        // in-process `getSession` call `resolveContext` makes (task 11.1).
        disableSettingJwtHeader: true,
      }),
      // Task 5.1, design D5: the one `apiKey` plugin config machine
      // credentials use. `references: "organization"` makes
      // `checkOrgApiKeyPermission` (installed `@better-auth/api-key@1.7.6`
      // source) the admin-only gate `./machine-credentials.ts` relies on;
      // `enableMetadata: true` is required for `actorKind` to be storable at
      // all (`METADATA_DISABLED` otherwise, same installed source).
      apiKey({
        configId: MACHINE_CREDENTIAL_CONFIG_ID,
        references: 'organization',
        defaultPrefix: 'tayzu_mc_',
        enableMetadata: true,
      }),
      preAuthRateLimitPlugin(options),
      ...(options.sso === undefined ? [] : [vismaConnect(options.sso)]),
    ],
    databaseHooks: {
      // Task 20.4 (design D24): self-service link/unlink. The hooks run with an
      // endpoint context only for Better Auth's own routes (`/link-social`
      // callback, `/unlink-account`); the admin path calls the adapter
      // directly (no context) and emits its own signal from the router.
      account: {
        create: {
          after: async (account, context) => {
            await emitSelfLink('linked', account, context);
          },
        },
        delete: {
          after: async (account, context) => {
            await emitSelfLink('unlinked', account, context);
          },
        },
        // Task 21.1 (design D24): Better Auth refreshes the linked account's
        // tokens on every successful callback sign-in; that update is the hook
        // point for the JIT display-data refresh.
        update: {
          after: async (account, context) => {
            await refreshDisplayData(options, account, context);
          },
        },
      },
      // Ban/unban: mirror `banned` onto every membership's `_user` entity.
      user: {
        update: {
          after: async (user, context) => {
            if (!context || options.userSync === undefined) {
              return;
            }
            const row = user as unknown as SyncUserRow;
            if (typeof row.banned !== 'boolean') {
              return;
            }
            const memberships = await context.context.adapter.findMany<MembershipRow>({
              model: 'member',
              where: [{ field: 'userId', value: row.id }],
            });
            for (const membership of memberships) {
              await options.userSync.upsertUser({
                tenantId: membership.organizationId,
                email: row.email,
                name: row.name,
                status: row.banned ? 'Disabled' : 'Active',
              });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (!context) {
              return;
            }
            const rows = await context.context.adapter.findMany<MembershipRow>({
              model: 'member',
              where: [{ field: 'userId', value: session.userId }],
              limit: 2,
            });
            const [onlyMembership] = rows;
            if (rows.length !== 1 || onlyMembership === undefined) {
              return;
            }
            return { data: { activeOrganizationId: onlyMembership.organizationId } };
          },
        },
      },
    },
    hooks: {
      // Task 3.3, design D3: "`changePassword` is called with
      // `revokeOtherSessions: true`" -- forced here so every caller gets
      // this behavior, not only ones that remember to opt in themselves.
      // Returning `{ context: { body: {...} } }` deep-merges onto the
      // endpoint's own `ctx.body` (`better-call`'s `createMiddleware`/
      // Better Auth's own `dispatchAuthEndpoint`, both verified against the
      // installed source), leaving `currentPassword`/`newPassword` untouched.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SET_ACTIVE_ORGANIZATION_PATH) {
          // Task 3.5, design D19: snapshot the session's current active
          // organization before Better Auth's own route runs, so
          // `hooks.after` can restore it if the membership check rejects the
          // attempt (see this file's own doc comment). `getSessionFromCtx`
          // is the same helper Better Auth's own `sessionMiddleware` calls,
          // so this caches the read rather than adding a second one.
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (session) {
            activeOrganizationBeforeAttempt.set(ctx.context, {
              sessionToken: session.session.token,
              previousActiveOrganizationId:
                (session.session.activeOrganizationId as string | null | undefined) ?? null,
            });
          }
          return undefined;
        }
        if (ctx.path !== CHANGE_PASSWORD_PATH) {
          return undefined;
        }
        return { context: { body: { revokeOtherSessions: true } } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SET_ACTIVE_ORGANIZATION_PATH) {
          // Task 3.5, design D19: "their active organization is unchanged"
          // -- restore the pre-attempt value whenever the attempt was
          // rejected (see this file's own doc comment for why Better Auth's
          // own route needs this undone).
          const snapshot = activeOrganizationBeforeAttempt.get(ctx.context);
          activeOrganizationBeforeAttempt.delete(ctx.context);
          if (snapshot && isAPIError(ctx.context.returned)) {
            await ctx.context.internalAdapter.updateSession(snapshot.sessionToken, {
              activeOrganizationId: snapshot.previousActiveOrganizationId,
            });
          }
          return;
        }
        if (ctx.path === SIGN_IN_EMAIL_PATH) {
          if (isAPIError(ctx.context.returned)) {
            emitLoginFailed();
            return;
          }
          const response = ctx.context.returned as SignInEmailSuccessResponse;
          const sessionRow = await ctx.context.adapter.findOne<ActiveOrganizationRow>({
            model: 'session',
            where: [{ field: 'token', value: response.token }],
          });
          emitLoginSucceeded({
            actorId: response.user.id,
            tenantId: sessionRow?.activeOrganizationId ?? undefined,
          });
          return;
        }
        if (ctx.path === CHANGE_PASSWORD_PATH) {
          if (isAPIError(ctx.context.returned)) {
            return;
          }
          const response = ctx.context.returned as ChangePasswordSuccessResponse;
          const sessionRow = await ctx.context.adapter.findOne<ActiveOrganizationRow>({
            model: 'session',
            where: [{ field: 'token', value: response.token }],
          });
          emitSessionRevoked({
            actorId: response.user.id,
            tenantId: sessionRow?.activeOrganizationId ?? undefined,
          });
          return;
        }
        if (ctx.path.startsWith(TWO_FACTOR_VERIFY_PATH_PREFIX)) {
          // Task 4.2, design D4: record the freshness marker `./step-up.ts`'s
          // guard later reads, on every successful `/two-factor/verify-*`
          // completion (TOTP, backup code, or a future OTP factor alike).
          // Keyed by the resulting session's own token (see `./step-up.ts`'s
          // own doc comment for why no built-in Better Auth mechanism does
          // this already).
          if (isAPIError(ctx.context.returned)) {
            return;
          }
          const response = ctx.context.returned as TwoFactorVerifySuccessResponse;
          if (response.token === undefined || response.token === null) {
            return;
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: stepUpVerificationIdentifier(response.token),
            value: 'verified',
            expiresAt: new Date(Date.now() + STEP_UP_FRESHNESS_MS),
          });
        }
      }),
    },
  });

  // Task 18.2, design D18/D22: `/sign-up/email` is never reachable, over
  // `auth.handler`, as anything other than the identical 404 an unmatched
  // route already returns -- intercepted before Better Auth's own router
  // runs at all, so its `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` body (thrown by
  // `disableSignUp` above) never reaches a caller and never reveals the route
  // exists. `auth.api.signUpEmail` (in-process, bypassing this wrapper
  // entirely) still reaches that same `disableSignUp` guard directly and is
  // refused there.
  const { handler: baseHandler } = auth as unknown as AuthHandlerSurface;
  const signUpGuardedHandler = async (request: Request): Promise<Response> => {
    if (normalizedRequestPath(request) === SIGN_UP_EMAIL_PATH) {
      return unmatchedRouteResponse();
    }
    if (options.sso !== undefined && normalizedRequestPath(request) === SSO_CALLBACK_PATH) {
      // Task 19.4, design D24: every callback failure becomes the same 401.
      // Task 19.5: one `auth.sso.callback` span and one counter event per
      // completed sign-in. With `form_post`, the POST hop that only redirects
      // to the GET callback is not a completion and emits nothing.
      const startTime = Date.now();
      let response: Response | undefined;
      try {
        response = await baseHandler(request);
      } catch {
        response = undefined;
      }
      const failure = response === undefined ? { code: null } : callbackFailureCode(response);
      if (response !== undefined && failure === null && isCallbackHop(response)) {
        return response;
      }
      const outcome = failure === null ? 'success' : 'rejected';
      const span = tracer.startSpan('auth.sso.callback', {
        startTime,
        attributes: { 'tayzu.auth.method': 'visma_connect', 'tayzu.auth.sso.outcome': outcome },
      });
      span.end();
      ssoEventsCounter.add(1, {
        'tayzu.auth.event': failure === null ? 'sso_succeeded' : 'sso_rejected',
      });
      if (failure === null) {
        return response as Response;
      }
      recordSsoSignInFailed(failure.code);
      return ssoRejectedResponse();
    }
    return baseHandler(request);
  };

  const guardedAuth = { ...auth, handler: signUpGuardedHandler, fetch: signUpGuardedHandler };
  return guardedAuth;
}
