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
 * Configuration comes only from `CreateAuthOptions`, supplied by the host
 * (`apps/api`): this library never reads `process.env` or logs `secret`.
 */
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter, type DB } from '@better-auth/drizzle-adapter';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { admin, jwt, organization, twoFactor } from 'better-auth/plugins';

import { logger, sessionEventsCounter } from './telemetry/instruments.js';

const SIGN_IN_EMAIL_PATH = '/sign-in/email';

/** design.md, Metrics table: `tayzu.auth.session.events`'s only attribute. */
const AUTH_EVENT_ATTRIBUTE = 'tayzu.auth.event';

/** design.md, Log events table: `auth.security.login_failed`'s only attribute. */
const FAILURE_REASON_ATTRIBUTE = 'tayzu.auth.failure_reason';

/** A single `auth.member` row: the shape `databaseHooks.session.create.before` needs. */
interface MembershipRow {
  readonly organizationId: string;
}

/** The `auth.session` row's tenant column, read back after `/sign-in/email` creates it. */
interface ActiveOrganizationRow {
  readonly activeOrganizationId: string | null;
}

/** `/sign-in/email`'s success body (Better Auth's own route, `sign-in.mjs`): the fields this file reads. */
interface SignInEmailSuccessResponse {
  readonly token: string;
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
    plugins: [organization(), admin(), twoFactor(), jwt(), apiKey()],
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
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_EMAIL_PATH) {
          return;
        }
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
      }),
    },
  });
}
