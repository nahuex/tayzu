/**
 * Production bootstrap (task 11.1 fix-up; root CLAUDE.md TLS invariant, design
 * D5, D6). Reads the process environment once and builds both pools through
 * `@tayzu/db`'s `createPool`, which enforces `sslmode=verify-full`. The app
 * pool connects as `tayzu_app` (`DATABASE_URL`), Better Auth's as `tayzu_auth`
 * (`AUTH_DATABASE_URL`, never a fallback to the runtime URL).
 */
import { createPool } from '@tayzu/db';

import { loadConfig } from './config.js';
import { createApp, type App } from './server.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Startup assertion on a runtime database role (design Q62, D6): the role in
 * effect must not be a superuser, must not have BYPASSRLS and must own no
 * catalog table. Judges `current_user`, and throws a fixed message so nothing
 * from the connection (host, password, role name) reaches the error.
 */
async function assertRuntimeRole(pool: ReturnType<typeof createPool>): Promise<void> {
  const result = await pool.query<{ privileged: boolean }>(
    `select (r.rolsuper or r.rolbypassrls or exists (
       select 1 from pg_class c
       where c.relowner = r.oid and c.relkind in ('r', 'p') and c.relname like 'catalog\\_%'
     )) as privileged
     from pg_roles r where r.rolname = current_user`,
  );
  if (result.rows[0]?.privileged !== false) {
    throw new Error('A runtime database role is privileged: startup aborted');
  }
}

export async function createAppFromEnv(env: Env): Promise<App> {
  const config = loadConfig(env);
  const appUrl = config.appDatabaseUrl;
  const authUrl = config.authDatabaseUrl;
  const authSecret = config.betterAuthSecret;
  const { cerbosAddress, allowedOrigins } = config;

  const appPool = createPool(appUrl);
  let authPool: ReturnType<typeof createPool> | undefined;
  try {
    authPool = createPool(authUrl);
    if ((env['NODE_ENV'] ?? process.env['NODE_ENV']) !== 'test') {
      await assertRuntimeRole(appPool);
      await assertRuntimeRole(authPool);
    }
    const built = await createApp({
      appPool,
      authPool,
      authSecret,
      cerbosAddress,
      allowedOrigins,
      ...(config.betterAuthUrl === undefined ? {} : { baseUrl: config.betterAuthUrl }),
      backchannelLogoutRateLimitPerMinute: config.backchannelLogoutRateLimitPerMinute,
      ...(config.sso === undefined ? {} : { sso: config.sso }),
      // One configured pre-auth budget covers sign-in and two-factor verification (D20);
      // password checks have their own budget (Q52).
      preAuthRateLimit: {
        signIn: config.preAuthSignInRateLimit,
        twoFactorVerify: config.preAuthSignInRateLimit,
        passwordCheck: config.preAuthPasswordCheckRateLimit,
      },
      rateLimit: config.rateLimit,
      tokenExchangeRateLimit: config.tokenExchangeRateLimit,
      bodyLimit: config.bodyLimit,
    });
    const ownedAuthPool = authPool;
    return {
      ...built,
      async close(): Promise<void> {
        await built.close();
        await appPool.end();
        await ownedAuthPool.end();
      },
    };
  } catch (error) {
    await appPool.end();
    await authPool?.end();
    throw error;
  }
}
