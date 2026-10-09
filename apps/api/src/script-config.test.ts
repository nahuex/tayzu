/**
 * `043` task 2.0b (design D9, Resolved decisions Q114 and Q116): the
 * maintenance scripts read `apps/api/scripts/script-config.ts`, which reads
 * only the variables a script declares.
 */
import { describe, expect, it } from 'vitest';

import { loadScriptConfig, SCRIPT_VARIABLES } from '../scripts/script-config.js';

const SECRET = 'script-config-s3cr3t-value-0123456789';
const FULL_ENV = {
  DATABASE_URL: 'postgres://app@localhost:5432/db',
  AUTH_DATABASE_URL: 'postgres://auth@localhost:5432/db',
  BETTER_AUTH_SECRET: SECRET,
  CERBOS_ADDRESS: '127.0.0.1:3593',
  TAYZU_OPERATOR_ID: 'gh:12345',
} as const;

/** An env that records every name read from it. */
function recordingEnv(values: Record<string, string>): {
  env: Record<string, string | undefined>;
  reads: Set<string>;
} {
  const reads = new Set<string>();
  const env = new Proxy<Record<string, string | undefined>>(values, {
    get(target, name) {
      if (typeof name === 'string') reads.add(name);
      return target[name as string];
    },
  });
  return { env, reads };
}

function without(name: keyof typeof FULL_ENV): Record<string, string> {
  return Object.fromEntries(Object.entries(FULL_ENV).filter(([key]) => key !== name));
}

describe('loadScriptConfig', () => {
  it('reads only the variables the script declares', () => {
    const { env, reads } = recordingEnv({ ...FULL_ENV });
    const config = loadScriptConfig('backfill-user-blueprint', env);
    expect([...reads].sort()).toEqual([...SCRIPT_VARIABLES['backfill-user-blueprint']].sort());
    expect(Object.keys(config).sort()).toEqual(
      [...SCRIPT_VARIABLES['backfill-user-blueprint']].sort(),
    );
  });

  it('succeeds with only its own variables set', () => {
    expect(
      loadScriptConfig('backfill-user-blueprint', {
        DATABASE_URL: FULL_ENV.DATABASE_URL,
        AUTH_DATABASE_URL: FULL_ENV.AUTH_DATABASE_URL,
        CERBOS_ADDRESS: FULL_ENV.CERBOS_ADDRESS,
      }),
    ).toEqual({
      DATABASE_URL: FULL_ENV.DATABASE_URL,
      AUTH_DATABASE_URL: FULL_ENV.AUTH_DATABASE_URL,
      CERBOS_ADDRESS: FULL_ENV.CERBOS_ADDRESS,
    });
  });

  it('a missing variable fails only the script that needs it', () => {
    const env = without('TAYZU_OPERATOR_ID');
    expect(() => loadScriptConfig('backfill-user-blueprint', env)).not.toThrow();
    expect(() => loadScriptConfig('reconcile-users', env)).toThrow('TAYZU_OPERATOR_ID is required');
    expect(() => loadScriptConfig('bootstrap-admin', env)).toThrow('TAYZU_OPERATOR_ID is required');
  });

  it('neither the backfill nor the reconcile declares or reads BETTER_AUTH_SECRET', () => {
    for (const script of ['backfill-user-blueprint', 'reconcile-users'] as const) {
      expect(SCRIPT_VARIABLES[script] as readonly string[]).not.toContain('BETTER_AUTH_SECRET');
      const { env, reads } = recordingEnv(without('BETTER_AUTH_SECRET'));
      loadScriptConfig(script, env);
      expect(reads.has('BETTER_AUTH_SECRET')).toBe(false);
    }
  });

  it.each(['backfill-user-blueprint', 'reconcile-users'] as const)(
    '%s declares CERBOS_ADDRESS and refuses to start without it',
    (script) => {
      expect(SCRIPT_VARIABLES[script] as readonly string[]).toContain('CERBOS_ADDRESS');
      expect(() => loadScriptConfig(script, without('CERBOS_ADDRESS'))).toThrow(
        'CERBOS_ADDRESS is required',
      );
    },
  );

  it.each(['reconcile-users', 'bootstrap-admin'] as const)(
    '%s declares TAYZU_OPERATOR_ID and refuses to start without it',
    (script) => {
      expect(SCRIPT_VARIABLES[script] as readonly string[]).toContain('TAYZU_OPERATOR_ID');
      expect(() => loadScriptConfig(script, without('TAYZU_OPERATOR_ID'))).toThrow(
        'TAYZU_OPERATOR_ID is required',
      );
      expect(() => loadScriptConfig(script, { ...FULL_ENV, TAYZU_OPERATOR_ID: '   ' })).toThrow(
        'TAYZU_OPERATOR_ID is required',
      );
    },
  );

  it.each(['someone@example.com', 'a b', 'x'.repeat(129)])(
    'rejects a malformed operator id without echoing it',
    (bad) => {
      let message = '';
      try {
        loadScriptConfig('reconcile-users', { ...FULL_ENV, TAYZU_OPERATOR_ID: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('TAYZU_OPERATOR_ID is malformed');
      expect(message).not.toContain(bad);
    },
  );

  it('the bootstrap CLI requires a long enough secret and never echoes it', () => {
    let message = '';
    try {
      loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRET: 'short-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BETTER_AUTH_SECRET is malformed');
    expect(message).not.toContain('short-secret');
  });

  it('never puts a value in a missing-variable error', () => {
    let message = '';
    try {
      loadScriptConfig('reconcile-users', without('CERBOS_ADDRESS'));
    } catch (error) {
      message = (error as Error).message;
    }
    for (const value of Object.values(FULL_ENV)) {
      expect(message).not.toContain(value);
    }
  });
});
