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
import { logger, sessionEventsCounter } from './telemetry/instruments.js';

const SIGN_IN_EMAIL_PATH = '/sign-in/email';
const CHANGE_PASSWORD_PATH = '/change-password';
const SET_ACTIVE_ORGANIZATION_PATH = '/organization/set-active';

/** design.md, Metrics table: `tayzu.auth.session.events`'s only attribute. */
const AUTH_EVENT_ATTRIBUTE = 'tayzu.auth.event';

/** design.md, Log events table: `auth.security.login_failed`'s only attribute. */
const FAILURE_REASON_ATTRIBUTE = 'tayzu.auth.failure_reason';

/** design.md, Log events table: `auth.security.session_revoked`'s reason attribute. */
const REVOCATION_REASON_ATTRIBUTE = 'tayzu.auth.revocation.reason';

/** design.md, Log events table: `auth.security.session_revoked` -- the only reason task 3.3 emits. */
const PASSWORD_CHANGE_REVOCATION_REASON = 'password_change';

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

/** Builds the one `betterAuth` instance `@tayzu/auth` exposes. */
export function createAuth(options: CreateAuthOptions): AuthInstance {
  return betterAuth({
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schemaName: 'auth',
    }),
    // Email/password sign-up and sign-in (task 2.3). No `minPasswordLength`
    // override: Better Auth's own default (8 characters) is the policy this
    // change fixes; a stricter policy is not named anywhere in the design.
    emailAndPassword: {
      enabled: true,
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
      organization(),
      admin(),
      twoFactor(),
      jwt(),
      apiKey(),
      preAuthRateLimitPlugin(options),
    ],
    databaseHooks: {
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
        }
      }),
    },
  });
}
