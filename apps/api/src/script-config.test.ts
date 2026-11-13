/**
 * `043` task 2.0b (design D9, Resolved decisions Q114 and Q116): the
 * maintenance scripts read `apps/api/scripts/script-config.ts`, which reads
 * only the variables a script declares.
 */
import { describe, expect, it } from 'vitest';

import {
  loadScriptConfig,
  OPERATOR_ID_PATTERN,
  SCRIPT_VARIABLES,
} from '../scripts/script-config.js';

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

describe('recover-admin-mfa script configuration (044 task 11.1)', () => {
  const RECOVER_ENV = {
    AUTH_DATABASE_URL: 'postgres://auth-recover@localhost:5432/recover-db',
    TAYZU_OPERATOR_ID: 'gh:recover-operator',
    EMAIL_PROVIDER: 'acs',
    EMAIL_SENDER_ADDRESS: 'sender-recover@mail.example.test',
    EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: 'allowed-recover.example.test',
    ACS_CONNECTION_STRING: 'endpoint=https://recover.example.test/;accesskey=recover-key-value',
  } as const;

  function recoverWithout(name: string): Record<string, string> {
    return Object.fromEntries(Object.entries(RECOVER_ENV).filter(([key]) => key !== name));
  }

  function messageOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  }

  describe('The command holds no signing key', () => {
    it('declares exactly the eight variables and none of the signing or app ones', () => {
      const declared = SCRIPT_VARIABLES['recover-admin-mfa'] as readonly string[];
      expect([...declared].sort()).toEqual(
        [
          'AUTH_DATABASE_URL',
          'TAYZU_OPERATOR_ID',
          'EMAIL_PROVIDER',
          'EMAIL_SENDER_ADDRESS',
          'EMAIL_RECIPIENT_DOMAIN_ALLOWLIST',
          'ACS_CONNECTION_STRING',
          'EMAIL_DISABLED_TENANT_IDS',
          'INVITATION_EMAIL_KILL_SWITCH',
        ].sort(),
      );
      expect(declared).not.toContain('BETTER_AUTH_SECRET');
      expect(declared).not.toContain('DATABASE_URL');
      expect(declared).not.toContain('CERBOS_ADDRESS');
    });

    it('never reads a variable it does not declare', () => {
      const { env, reads } = recordingEnv({ ...FULL_ENV, ...RECOVER_ENV });
      loadScriptConfig('recover-admin-mfa', env);
      const declared = SCRIPT_VARIABLES['recover-admin-mfa'] as readonly string[];
      for (const name of reads) expect(declared).toContain(name);
      expect(reads.has('BETTER_AUTH_SECRET')).toBe(false);
      expect(reads.has('DATABASE_URL')).toBe(false);
      expect(reads.has('CERBOS_ADDRESS')).toBe(false);
    });
  });

  it('an unset optional variable does not fail', () => {
    const config: Record<string, string | undefined> = loadScriptConfig(
      'recover-admin-mfa',
      RECOVER_ENV,
    );
    expect(config['EMAIL_DISABLED_TENANT_IDS']).toBeUndefined();
    expect(config['INVITATION_EMAIL_KILL_SWITCH']).toBeUndefined();
    expect(config['AUTH_DATABASE_URL']).toBe(RECOVER_ENV.AUTH_DATABASE_URL);
  });

  it('returns the optional variables when they are set', () => {
    const config: Record<string, string | undefined> = loadScriptConfig('recover-admin-mfa', {
      ...RECOVER_ENV,
      EMAIL_DISABLED_TENANT_IDS: 'tenant-a,tenant-b',
      INVITATION_EMAIL_KILL_SWITCH: 'true',
    });
    expect(config['EMAIL_DISABLED_TENANT_IDS']).toBe('tenant-a,tenant-b');
    expect(config['INVITATION_EMAIL_KILL_SWITCH']).toBe('true');
  });

  describe('the ACS variables are required only for `acs` and the allowlist only for a real provider', () => {
    const NONE_ENV = {
      AUTH_DATABASE_URL: RECOVER_ENV.AUTH_DATABASE_URL,
      TAYZU_OPERATOR_ID: RECOVER_ENV.TAYZU_OPERATOR_ID,
      EMAIL_PROVIDER: 'none',
    };

    it('provider none needs no ACS variable, no sender address and no allowlist', () => {
      expect(() => loadScriptConfig('recover-admin-mfa', NONE_ENV)).not.toThrow();
    });

    it.each(['ACS_CONNECTION_STRING', 'EMAIL_SENDER_ADDRESS'])(
      'provider acs requires %s',
      (name) => {
        expect(() => loadScriptConfig('recover-admin-mfa', recoverWithout(name))).toThrow(
          `${name} is required`,
        );
      },
    );

    it('provider acs requires the recipient allowlist', () => {
      expect(() =>
        loadScriptConfig('recover-admin-mfa', recoverWithout('EMAIL_RECIPIENT_DOMAIN_ALLOWLIST')),
      ).toThrow('EMAIL_RECIPIENT_DOMAIN_ALLOWLIST is required');
    });

    it('provider acs succeeds with all three present', () => {
      expect(() => loadScriptConfig('recover-admin-mfa', RECOVER_ENV)).not.toThrow();
    });
  });

  describe('a missing required variable throws naming the variable and never a value', () => {
    it.each(['AUTH_DATABASE_URL', 'TAYZU_OPERATOR_ID', 'EMAIL_PROVIDER'])(
      'names %s only',
      (name) => {
        const message = messageOf(() =>
          loadScriptConfig('recover-admin-mfa', recoverWithout(name)),
        );
        expect(message).toContain(`${name} is required`);
        for (const value of Object.values(RECOVER_ENV)) expect(message).not.toContain(value);
      },
    );
  });

  describe('the exported pattern equals the one TAYZU_OPERATOR_ID is checked with', () => {
    it('is the catalog id pattern', () => {
      expect(OPERATOR_ID_PATTERN.source).toBe('^[A-Za-z0-9_.:-]{1,128}$');
      expect(OPERATOR_ID_PATTERN.flags).toBe('');
    });

    it.each(['gh:12345', 'a', 'x'.repeat(128), 'someone@example.com', 'a b', '', 'x'.repeat(129)])(
      'accepts and rejects the same values as the loader (%#)',
      (value) => {
        const accepted = OPERATOR_ID_PATTERN.test(value);
        const loaderAccepts =
          messageOf(() =>
            loadScriptConfig('reconcile-users', { ...FULL_ENV, TAYZU_OPERATOR_ID: value }),
          ) === '';
        expect(loaderAccepts).toBe(accepted);
      },
    );
  });
});
