/**
 * `043` task 2.0b (design D9, Resolved decisions Q114 and Q116): the
 * maintenance scripts read `apps/api/scripts/script-config.ts`, which reads
 * only the variables a script declares.
 */
import { describe, expect, it } from 'vitest';

import {
  FixedMessageError,
  loadScriptConfig,
  OPERATOR_ID_PATTERN,
  SCRIPT_VARIABLES,
} from '../scripts/script-config.js';

const SECRET = 'script-config-s3cr3t-value-0123456789';
const FULL_ENV = {
  DATABASE_URL: 'postgres://app@localhost:5432/db',
  AUTH_DATABASE_URL: 'postgres://auth@localhost:5432/db',
  // 048 D4: the versioned list replaces the retired single secret.
  BETTER_AUTH_SECRETS: `1:${SECRET}`,
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

  it('neither the backfill nor the reconcile declares or reads BETTER_AUTH_SECRETS', () => {
    for (const script of ['backfill-user-blueprint', 'reconcile-users'] as const) {
      expect(SCRIPT_VARIABLES[script] as readonly string[]).not.toContain('BETTER_AUTH_SECRETS');
      expect(SCRIPT_VARIABLES[script] as readonly string[]).not.toContain('BETTER_AUTH_SECRET');
      const { env, reads } = recordingEnv(without('BETTER_AUTH_SECRETS'));
      loadScriptConfig(script, env);
      expect(reads.has('BETTER_AUTH_SECRETS')).toBe(false);
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
      loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRETS: '1:short-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BETTER_AUTH_SECRETS is malformed');
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
      expect(declared).not.toContain('BETTER_AUTH_SECRETS');
      expect(declared).not.toContain('BETTER_AUTH_SECRET');
      expect(declared).not.toContain('DATABASE_URL');
      expect(declared).not.toContain('CERBOS_ADDRESS');
    });

    it('never reads a variable it does not declare', () => {
      const { env, reads } = recordingEnv({ ...FULL_ENV, ...RECOVER_ENV });
      loadScriptConfig('recover-admin-mfa', env);
      const declared = SCRIPT_VARIABLES['recover-admin-mfa'] as readonly string[];
      for (const name of reads) expect(declared).toContain(name);
      expect(reads.has('BETTER_AUTH_SECRETS')).toBe(false);
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

describe('purge and reversal script configuration (045 task 1.3)', () => {
  const DELETION_ENV = {
    ...FULL_ENV,
    PURGE_DATABASE_URL: 'postgres://purge@localhost:5432/purge-db',
    REVERSAL_DATABASE_URL: 'postgres://reversal@localhost:5432/reversal-db',
  } as const;

  function deletionWithout(name: keyof typeof DELETION_ENV): Record<string, string> {
    return Object.fromEntries(Object.entries(DELETION_ENV).filter(([key]) => key !== name));
  }

  it('the two new variables are read by their scripts', () => {
    const purge = recordingEnv({ ...DELETION_ENV });
    expect(loadScriptConfig('purge-job', purge.env)).toEqual({
      PURGE_DATABASE_URL: DELETION_ENV.PURGE_DATABASE_URL,
    });
    expect([...purge.reads]).toEqual(['PURGE_DATABASE_URL']);

    const reversal = recordingEnv({ ...DELETION_ENV });
    expect(loadScriptConfig('cancel-org-deletion', reversal.env)).toEqual({
      REVERSAL_DATABASE_URL: DELETION_ENV.REVERSAL_DATABASE_URL,
      TAYZU_OPERATOR_ID: DELETION_ENV.TAYZU_OPERATOR_ID,
    });
    expect([...reversal.reads].sort()).toEqual(['REVERSAL_DATABASE_URL', 'TAYZU_OPERATOR_ID']);
  });

  it('a script reads only its own variables', () => {
    const purge = recordingEnv({ ...DELETION_ENV });
    loadScriptConfig('purge-job', purge.env);
    expect(purge.reads.has('REVERSAL_DATABASE_URL')).toBe(false);
    expect(purge.reads.has('DATABASE_URL')).toBe(false);

    const reversal = recordingEnv({ ...DELETION_ENV });
    loadScriptConfig('cancel-org-deletion', reversal.env);
    expect(reversal.reads.has('PURGE_DATABASE_URL')).toBe(false);
    expect(reversal.reads.has('DATABASE_URL')).toBe(false);

    for (const script of Object.keys(SCRIPT_VARIABLES) as (keyof typeof SCRIPT_VARIABLES)[]) {
      const declared = SCRIPT_VARIABLES[script] as readonly string[];
      expect(declared.includes('PURGE_DATABASE_URL')).toBe(script === 'purge-job');
      expect(declared.includes('REVERSAL_DATABASE_URL')).toBe(script === 'cancel-org-deletion');
    }
  });

  it('a missing one fails only the script that needs it', () => {
    const noPurge = deletionWithout('PURGE_DATABASE_URL');
    expect(() => loadScriptConfig('purge-job', noPurge)).toThrow('PURGE_DATABASE_URL is required');
    expect(() => loadScriptConfig('cancel-org-deletion', noPurge)).not.toThrow();
    expect(() => loadScriptConfig('reconcile-users', noPurge)).not.toThrow();

    const noReversal = deletionWithout('REVERSAL_DATABASE_URL');
    expect(() => loadScriptConfig('cancel-org-deletion', noReversal)).toThrow(
      'REVERSAL_DATABASE_URL is required',
    );
    expect(() => loadScriptConfig('purge-job', noReversal)).not.toThrow();
    expect(() => loadScriptConfig('reconcile-users', noReversal)).not.toThrow();

    expect(() =>
      loadScriptConfig('cancel-org-deletion', deletionWithout('TAYZU_OPERATOR_ID')),
    ).toThrow('TAYZU_OPERATOR_ID is required');
  });

  it.each(['PURGE_DATABASE_URL', 'REVERSAL_DATABASE_URL'] as const)(
    'a missing %s names the variable and never a value',
    (name) => {
      const script = name === 'PURGE_DATABASE_URL' ? 'purge-job' : 'cancel-org-deletion';
      let message = '';
      try {
        loadScriptConfig(script, deletionWithout(name));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`${name} is required`);
      for (const value of Object.values(DELETION_ENV)) expect(message).not.toContain(value);
    },
  );
});

describe('the scripts read BETTER_AUTH_SECRETS (048 task 4.4, design D4)', () => {
  const RETIRED_VALUE = 'retired-single-secret-value-0123456789';
  const RETIREMENT_MESSAGE = 'BETTER_AUTH_SECRET is retired: set BETTER_AUTH_SECRETS instead.';
  /** Every variable any script declares, plus both secret names. */
  const EVERY_ENV = {
    ...FULL_ENV,
    BETTER_AUTH_SECRET: RETIRED_VALUE,
    PURGE_DATABASE_URL: 'postgres://purge@localhost:5432/purge-db',
    REVERSAL_DATABASE_URL: 'postgres://reversal@localhost:5432/reversal-db',
    EMAIL_PROVIDER: 'none',
  } as const;

  const OTHER_SCRIPTS = (Object.keys(SCRIPT_VARIABLES) as (keyof typeof SCRIPT_VARIABLES)[]).filter(
    (script) => script !== 'bootstrap-admin',
  );

  function errorOf(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  describe('bootstrap-admin declares and parses BETTER_AUTH_SECRETS', () => {
    it('declares BETTER_AUTH_SECRETS and not the retired name', () => {
      const declared = SCRIPT_VARIABLES['bootstrap-admin'] as readonly string[];
      expect(declared).toContain('BETTER_AUTH_SECRETS');
      expect(declared).not.toContain('BETTER_AUTH_SECRET');
    });

    it('loads a well-formed versioned list with several entries', () => {
      const list = `2:${SECRET}-two,1:${SECRET}`;
      const config = loadScriptConfig('bootstrap-admin', {
        ...FULL_ENV,
        BETTER_AUTH_SECRETS: list,
      });
      expect(config.BETTER_AUTH_SECRETS).toBe(list);
    });

    it.each([
      ['a duplicate version', `1:${SECRET},1:${SECRET}-other`],
      ['an entry with no version', SECRET],
      ['a signed version', `+1:${SECRET}`],
    ])('refuses %s without echoing a value', (_label, list) => {
      const error = errorOf(() =>
        loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRETS: list }),
      );
      expect(error).toBeInstanceOf(FixedMessageError);
      const message = (error as Error).message;
      expect(message).toContain('BETTER_AUTH_SECRETS is malformed');
      expect(message).not.toContain(SECRET);
    });

    it('requires BETTER_AUTH_SECRETS even when the retired name is not set', () => {
      expect(() => loadScriptConfig('bootstrap-admin', without('BETTER_AUTH_SECRETS'))).toThrow(
        'BETTER_AUTH_SECRETS is required',
      );
    });
  });

  describe('every other script declares neither name', () => {
    it('enumerates at least the known non-bootstrap scripts', () => {
      expect(OTHER_SCRIPTS).toEqual(
        expect.arrayContaining([
          'backfill-user-blueprint',
          'reconcile-users',
          'recover-admin-mfa',
          'purge-job',
          'cancel-org-deletion',
        ]),
      );
    });

    it.each(OTHER_SCRIPTS)('%s declares, reads and returns neither secret name', (script) => {
      const declared = SCRIPT_VARIABLES[script] as readonly string[];
      expect(declared).not.toContain('BETTER_AUTH_SECRETS');
      expect(declared).not.toContain('BETTER_AUTH_SECRET');
      const { env, reads } = recordingEnv({ ...EVERY_ENV });
      const config: Record<string, string | undefined> = loadScriptConfig(script, env);
      expect(reads.has('BETTER_AUTH_SECRETS')).toBe(false);
      expect(reads.has('BETTER_AUTH_SECRET')).toBe(false);
      expect(Object.keys(config)).not.toContain('BETTER_AUTH_SECRETS');
      expect(Object.keys(config)).not.toContain('BETTER_AUTH_SECRET');
      expect(Object.values(config)).not.toContain(FULL_ENV.BETTER_AUTH_SECRETS);
      expect(Object.values(config)).not.toContain(RETIRED_VALUE);
    });
  });

  describe('a script refuses a set BETTER_AUTH_SECRET', () => {
    it('bootstrap-admin fails with the fixed retirement message even beside a valid list', () => {
      const error = errorOf(() =>
        loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRET: RETIRED_VALUE }),
      );
      expect(error).toBeInstanceOf(FixedMessageError);
      expect((error as Error).message).toBe(RETIREMENT_MESSAGE);
    });

    it('bootstrap-admin fails with the retirement message when only the retired name is set', () => {
      const error = errorOf(() =>
        loadScriptConfig('bootstrap-admin', {
          ...without('BETTER_AUTH_SECRETS'),
          BETTER_AUTH_SECRET: RETIRED_VALUE,
        }),
      );
      expect(error).toBeInstanceOf(FixedMessageError);
      expect((error as Error).message).toBe(RETIREMENT_MESSAGE);
    });

    it('the retirement message never contains either value', () => {
      const message = (
        errorOf(() =>
          loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRET: RETIRED_VALUE }),
        ) as Error | undefined
      )?.message;
      expect(message).toBe(RETIREMENT_MESSAGE);
      expect(message).not.toContain(RETIRED_VALUE);
      expect(message).not.toContain(SECRET);
    });

    it('a blank BETTER_AUTH_SECRET counts as unset', () => {
      expect(() =>
        loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRET: '   ' }),
      ).not.toThrow();
      expect(() =>
        loadScriptConfig('bootstrap-admin', { ...FULL_ENV, BETTER_AUTH_SECRET: '' }),
      ).not.toThrow();
    });
  });

  describe('The command holds no signing key', () => {
    it('recover-admin-mfa declares neither secret name and its config holds no signing key', () => {
      const declared = SCRIPT_VARIABLES['recover-admin-mfa'] as readonly string[];
      expect(declared).toContain('AUTH_DATABASE_URL');
      expect(declared).toContain('TAYZU_OPERATOR_ID');
      expect(declared).toContain('EMAIL_PROVIDER');
      expect(declared).not.toContain('BETTER_AUTH_SECRETS');
      expect(declared).not.toContain('BETTER_AUTH_SECRET');
      expect(declared).not.toContain('DATABASE_URL');
      expect(declared).not.toContain('CERBOS_ADDRESS');

      const { env, reads } = recordingEnv({ ...EVERY_ENV });
      const config: Record<string, string | undefined> = loadScriptConfig('recover-admin-mfa', env);
      expect(reads.has('BETTER_AUTH_SECRETS')).toBe(false);
      expect(reads.has('BETTER_AUTH_SECRET')).toBe(false);
      expect(config['BETTER_AUTH_SECRETS']).toBeUndefined();
      expect(config['BETTER_AUTH_SECRET']).toBeUndefined();
      for (const value of Object.values(config)) {
        expect(value).not.toContain(SECRET);
        expect(value).not.toContain(RETIRED_VALUE);
      }
    });
  });
});
