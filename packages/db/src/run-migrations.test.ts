import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Unit tests for `resolveMigrationUrl(env)` of the `db:migrate` command
 * (change 048, task 2.1; design D1; Resolved decision Q5). No database is
 * needed.
 *
 * Task 2.1: "`resolveMigrationUrl(env)` reads only `MIGRATION_DATABASE_URL`
 * (design D1). Verify: [...] covers 'The migration command needs its own
 * variable': unset and blank fail with the fixed message naming only
 * `MIGRATION_DATABASE_URL`, a set `DATABASE_URL` is never read, and a set value
 * is returned unchanged."
 *
 * D1: "`packages/db/src/run-migrations.ts` gains a pure
 * `resolveMigrationUrl(env)`: it reads `MIGRATION_DATABASE_URL` only; unset or
 * blank throws the fixed `'MIGRATION_DATABASE_URL is not set: db:migrate needs
 * the migration role's connection string.'`. It never reads `DATABASE_URL`, so
 * no environment can migrate through the runtime URL by accident."
 *
 * Q5: "`MIGRATION_DATABASE_URL` is always required and never falls back to
 * `DATABASE_URL`."
 *
 * Spec `auth-and-rbac`, Scenario "The migration command needs its own
 * variable":
 * - GIVEN the migration role's variable is unset and the runtime role's
 *   variable is set
 * - WHEN the migration command runs
 * - THEN it fails before connecting, with a message that names only the
 *   migration role's variable
 *
 * The module is the CLI entry point, so it is imported dynamically, with both
 * variables removed from `process.env` and pg's `Client#connect` blocked: an
 * import that still ran the command at load time fails fast instead of
 * touching a database. A pure function in that module implies importing it
 * has no side effects, which the first test checks.
 */

const FIXED_MESSAGE =
  "MIGRATION_DATABASE_URL is not set: db:migrate needs the migration role's connection string.";

/** Recognizable values, so the tests can prove no URL reaches an error. */
const RUNTIME_PASSWORD = 'runtime-s3cr3t-pw';
const RUNTIME_HOST = 'runtime-db.example.com';
const RUNTIME_USER = 'tayzu_app';
const RUNTIME_URL = `postgres://${RUNTIME_USER}:${RUNTIME_PASSWORD}@${RUNTIME_HOST}:5432/tayzu?sslmode=verify-full`;

const MIGRATION_URL =
  'postgres://tayzu_migrator:migrator-s3cr3t-pw@migrate-db.example.com:5432/tayzu?sslmode=verify-full';

/** Blank values: each one counts as unset. */
const BLANK_VALUES = [
  ['empty', ''],
  ['a single space', ' '],
  ['only whitespace (spaces, tab, newline)', '  \t\n '],
] as const;

type Env = Record<string, string | undefined>;
type ResolveMigrationUrl = (env: Env) => string;

/** pg's `Client#connect`, with both of its call forms (callback and promise). */
interface Connectable {
  connect(...args: unknown[]): unknown;
}

type ConnectSpy = MockInstance<(...args: unknown[]) => unknown>;

/**
 * Replaces pg's `Client#connect` with one that fails immediately, so this file
 * never opens a socket, and returns the spy so a test can assert that no
 * connection was attempted.
 */
function blockConnections(): ConnectSpy {
  return vi
    .spyOn(Client.prototype as unknown as Connectable, 'connect')
    .mockImplementation((...args: unknown[]) => {
      const error = new Error('Unexpected connection attempt in a unit test.');
      const [callback] = args;
      if (typeof callback === 'function') {
        queueMicrotask(() => {
          (callback as (error: Error) => void)(error);
        });
        return undefined;
      }
      return Promise.reject(error);
    });
}

/**
 * An environment that records every key read from it, through any trap, so a
 * test can prove a key was never read.
 */
function recordingEnv(values: Env): { env: Env; readKeys: Set<PropertyKey> } {
  const readKeys = new Set<PropertyKey>();
  const target: Env = Object.assign(Object.create(null) as Env, values);
  const env = new Proxy(target, {
    get(object, key, receiver) {
      readKeys.add(key);
      return Reflect.get(object, key, receiver) as unknown;
    },
    has(object, key) {
      readKeys.add(key);
      return Reflect.has(object, key);
    },
    getOwnPropertyDescriptor(object, key) {
      readKeys.add(key);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    ownKeys(object) {
      // Enumerating the keys exposes every value name, DATABASE_URL included.
      readKeys.add('DATABASE_URL');
      return Reflect.ownKeys(object);
    },
  });
  return { env, readKeys };
}

/** Calls `fn` and returns what it threw, failing the test when it returns. */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected resolveMigrationUrl to throw, but it returned.');
}

/** The message names only MIGRATION_DATABASE_URL and holds no URL part. */
function expectNamesOnlyTheMigrationVariable(error: Error): void {
  expect(error.message).toBe(FIXED_MESSAGE);
  expect(error.message).toContain('MIGRATION_DATABASE_URL');
  expect(error.message.replaceAll('MIGRATION_DATABASE_URL', '')).not.toContain('DATABASE_URL');
  for (const fragment of [
    RUNTIME_URL,
    RUNTIME_PASSWORD,
    RUNTIME_HOST,
    RUNTIME_USER,
    'postgres://',
  ]) {
    expect(error.message).not.toContain(fragment);
  }
}

let connectSpy: ConnectSpy;
let importError: unknown;
let resolveMigrationUrl: ResolveMigrationUrl;

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', undefined);
  vi.stubEnv('MIGRATION_DATABASE_URL', undefined);
  connectSpy = blockConnections();
  try {
    ({ resolveMigrationUrl } = await import('./run-migrations.js'));
  } catch (error) {
    importError = error;
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveMigrationUrl (design D1, Q5)', () => {
  it('importing the module runs nothing: it neither throws nor attempts a connection', () => {
    expect(importError).toBeUndefined();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(typeof resolveMigrationUrl).toBe('function');
  });

  describe('Scenario: The migration command needs its own variable', () => {
    it('fails with the fixed message naming only MIGRATION_DATABASE_URL when it is unset and DATABASE_URL is set', () => {
      // GIVEN the migration role's variable is unset and the runtime role's variable is set
      const env: Env = { DATABASE_URL: RUNTIME_URL };

      // WHEN the migration command runs / THEN it fails ... names only the migration role's variable
      const error = thrownBy(() => resolveMigrationUrl(env));
      expectNamesOnlyTheMigrationVariable(error);
      // ... before connecting
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('fails with the fixed message when MIGRATION_DATABASE_URL is unset and DATABASE_URL is unset too', () => {
      const error = thrownBy(() => resolveMigrationUrl({}));
      expectNamesOnlyTheMigrationVariable(error);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('fails with the fixed message when MIGRATION_DATABASE_URL is present but undefined', () => {
      const error = thrownBy(() =>
        resolveMigrationUrl({ MIGRATION_DATABASE_URL: undefined, DATABASE_URL: RUNTIME_URL }),
      );
      expectNamesOnlyTheMigrationVariable(error);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it.each(BLANK_VALUES)(
      'treats a MIGRATION_DATABASE_URL that is %s as unset, even when DATABASE_URL is set',
      (_label, blank) => {
        const error = thrownBy(() =>
          resolveMigrationUrl({ MIGRATION_DATABASE_URL: blank, DATABASE_URL: RUNTIME_URL }),
        );
        expectNamesOnlyTheMigrationVariable(error);
        expect(connectSpy).not.toHaveBeenCalled();
      },
    );

    it('never reads DATABASE_URL when MIGRATION_DATABASE_URL is unset', () => {
      const { env, readKeys } = recordingEnv({ DATABASE_URL: RUNTIME_URL });

      const error = thrownBy(() => resolveMigrationUrl(env));

      expectNamesOnlyTheMigrationVariable(error);
      expect(readKeys.has('DATABASE_URL')).toBe(false);
    });

    it('never reads DATABASE_URL when MIGRATION_DATABASE_URL is set, and returns the migration URL', () => {
      const { env, readKeys } = recordingEnv({
        MIGRATION_DATABASE_URL: MIGRATION_URL,
        DATABASE_URL: RUNTIME_URL,
      });

      expect(resolveMigrationUrl(env)).toBe(MIGRATION_URL);
      expect(readKeys.has('DATABASE_URL')).toBe(false);
    });

    it('returns a set MIGRATION_DATABASE_URL unchanged, without trimming or rewriting it', () => {
      const padded = `  ${MIGRATION_URL}\n`;
      expect(resolveMigrationUrl({ MIGRATION_DATABASE_URL: MIGRATION_URL })).toBe(MIGRATION_URL);
      expect(resolveMigrationUrl({ MIGRATION_DATABASE_URL: padded })).toBe(padded);
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});
