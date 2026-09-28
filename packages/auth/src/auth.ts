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
 * Configuration comes only from `CreateAuthOptions`, supplied by the host
 * (`apps/api`): this library never reads `process.env` or logs `secret`.
 */
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter, type DB } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { admin, jwt, organization, twoFactor } from 'better-auth/plugins';

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
  });
}
