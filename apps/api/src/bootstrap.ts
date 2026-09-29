/**
 * Production bootstrap (task 11.1 fix-up; root CLAUDE.md TLS invariant, design
 * D5, D6). Reads the process environment once and builds both pools through
 * `@tayzu/db`'s `createPool`, which enforces `sslmode=verify-full`. The app
 * pool connects as `tayzu_app` (`DATABASE_URL`), Better Auth's as `tayzu_auth`
 * (`AUTH_DATABASE_URL`, never a fallback to the runtime URL).
 */
import { createPool } from '@tayzu/db';

import { createApp, type App } from './server.js';

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export async function createAppFromEnv(env: Env): Promise<App> {
  const appUrl = required(env, 'DATABASE_URL');
  const authUrl = required(env, 'AUTH_DATABASE_URL');
  const authSecret = required(env, 'AUTH_SECRET');
  const cerbosAddress = required(env, 'CERBOS_ADDRESS');
  const allowedOrigins = required(env, 'ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  const appPool = createPool(appUrl);
  let authPool: ReturnType<typeof createPool> | undefined;
  try {
    authPool = createPool(authUrl);
    const built = await createApp({ appPool, authPool, authSecret, cerbosAddress, allowedOrigins });
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
