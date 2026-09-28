import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import { inspect } from 'node:util';

import { Client, Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createPool } from './index.js';

/**
 * Unit tests for the Postgres harness of `@tayzu/db` (task 1.5; design D5 and
 * D12). No database is needed. Every test blocks pg's `Client#connect`, which
 * every pg connection goes through (a `Pool` builds its connections as
 * `new Client(...)`), so a refused or missing configuration must fail before
 * any connection is attempted ("fails fast", D12).
 *
 * Task 1.5: "A test helper `getTestDatabase()` that applies migrations once
 * per run and throws an explicit error when `DATABASE_URL` is unset. Outside
 * the test harness, `createPool` refuses a connection string without
 * `sslmode=verify-full`."
 *
 * D5: "Outside tests, `createPool` requires TLS (`sslmode=verify-full`) and
 * refuses to start otherwise. Only the test harness may connect to a *local*
 * database without TLS."
 *
 * D12 / Risks: "The harness fails fast with an explicit message if
 * `DATABASE_URL` is missing." "The fast-fail message explains how to start
 * it."
 *
 * The TLS rules are about the settings pg actually uses, so every case is
 * checked against pg's own parsing of the connection string
 * (pg-connection-string): percent-encoded parameter names are decoded, the
 * last value of a repeated parameter wins, and a `#fragment` is ignored.
 */

/** A recognizable password, so the tests can prove it never reaches an error. */
const PASSWORD = 'harness-s3cr3t-pw';
const LOCAL_URL = `postgres://tayzu:${PASSWORD}@localhost:5432/tayzu_test`;
const REMOTE_URL = `postgres://tayzu:${PASSWORD}@db.example.com:5432/tayzu`;

/** libpq environment variables that pg falls back to when a setting is missing. */
const PG_ENVIRONMENT = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
] as const;

/** pg's `Client#connect`, with both of its call forms (callback and promise). */
interface Connectable {
  connect(...args: unknown[]): unknown;
}

type ConnectSpy = MockInstance<(...args: unknown[]) => unknown>;

/**
 * Replaces pg's `Client#connect` with one that fails immediately, so a test
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

/** Ends a pool, or the `pool` of a result, that a call returned by mistake. */
async function endIfPool(value: unknown): Promise<void> {
  if (value instanceof Pool) {
    await value.end();
  } else if (typeof value === 'object' && value !== null && 'pool' in value) {
    await endIfPool(value.pool);
  }
}

/**
 * Runs `action` and returns the error it throws or rejects with. It accepts
 * both a synchronous throw and a rejected promise: the design does not fix
 * whether `createPool` or `getTestDatabase` is synchronous.
 */
async function captureFailure(action: () => unknown): Promise<Error> {
  let outcome: unknown;
  try {
    outcome = await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('Expected an Error instance to be thrown.', { cause: error });
  }
  await endIfPool(outcome);
  throw new Error('Expected the call to throw or reject, but it succeeded.');
}

/**
 * Loads a fresh copy of the harness module (the environment is already
 * stubbed) and calls `getTestDatabase()`, all inside `captureFailure`. So a
 * harness that validates `DATABASE_URL` when the module is imported and one
 * that validates it when `getTestDatabase()` is called are both accepted, and
 * no state memoized by an earlier test leaks in.
 */
async function getTestDatabaseFailure(): Promise<Error> {
  return captureFailure(async () => {
    vi.resetModules();
    const { getTestDatabase } = await import('./harness.js');
    return getTestDatabase();
  });
}

/**
 * The password must not reach the error at all: not its message, and not a
 * `cause`, an own property or a hidden property that `console.error` or a
 * logger would print (root CLAUDE.md: "Never print `DATABASE_URL`").
 */
function expectNoPassword(error: Error): void {
  expect(error.message).not.toContain(PASSWORD);
  expect(inspect(error, { depth: null, showHidden: true })).not.toContain(PASSWORD);
}

/**
 * The fast-fail message is explicit: it names the missing variable and what
 * needs it, and tells the reader how to fix it, with the same guidance as the
 * integration global setup and the root CLAUDE.md ("Export it first, for
 * example `export DATABASE_URL=postgres://...`", or run the unit tests only).
 */
function expectMissingDatabaseUrlMessage(error: Error): void {
  expect(error.message).toContain('DATABASE_URL is not set');
  expect(error.message).toMatch(/PostgreSQL/);
  expect(error.message).toContain('export DATABASE_URL=postgres://');
  expect(error.message).toContain('pnpm test:unit');
}

/**
 * An options object in which every property reads as `value`, so that any
 * boolean switch a second `createPool` argument could offer (whatever its
 * name) is turned on (`true`) or off (`false`).
 */
function everyOption(value: boolean): object {
  return new Proxy(
    {},
    {
      get: (_target, key) => (typeof key === 'string' ? value : undefined),
      has: () => true,
    },
  );
}

/** `createPool` called with a second argument, which its typed signature may not declare. */
function createPoolWithOptions(url: string, options: object): unknown {
  return (createPool as (...args: readonly unknown[]) => unknown)(url, options);
}

let connectSpy: ConnectSpy;

beforeEach(() => {
  // Settings must come from the URL, never from libpq environment defaults.
  for (const name of PG_ENVIRONMENT) {
    vi.stubEnv(name, undefined);
  }
  connectSpy = blockConnections();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('getTestDatabase', () => {
  it('throws an explicit error when DATABASE_URL is unset, before any connection attempt', async () => {
    vi.stubEnv('DATABASE_URL', undefined);

    const error = await getTestDatabaseFailure();

    expectMissingDatabaseUrlMessage(error);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
  ])(
    'treats a DATABASE_URL that is %s as unset, before any connection attempt',
    async (_label, value) => {
      vi.stubEnv('DATABASE_URL', value);

      const error = await getTestDatabaseFailure();

      expectMissingDatabaseUrlMessage(error);
      expect(connectSpy).not.toHaveBeenCalled();
    },
  );

  /**
   * The harness exemption covers a local database only. What counts as local
   * (for example the host of the CI `postgres:16` service) is for the
   * implementation to define; none of the effective hosts below is local
   * under any definition, and none of the URLs gives pg `sslmode=verify-full`.
   */
  it.each([
    ['a remote host and no sslmode', REMOTE_URL],
    ['a remote host and sslmode=disable', `${REMOTE_URL}?sslmode=disable`],
    ['a remote host and sslmode=require', `${REMOTE_URL}?sslmode=require`],
    [
      'a remote host whose sslmode=verify-full is overridden by a percent-encoded ssl%6Dode=disable',
      `${REMOTE_URL}?sslmode=verify-full&ssl%6Dode=disable`,
    ],
    [
      'a remote host whose sslmode=verify-full is only in the #fragment, which pg ignores',
      `${REMOTE_URL}?application_name=x#&sslmode=verify-full`,
    ],
    [
      'a remote host whose name only starts with "localhost"',
      `postgres://tayzu:${PASSWORD}@localhost.example.com:5432/tayzu_test`,
    ],
    [
      'a local-looking URL whose host parameter points at a remote server',
      `${LOCAL_URL}?host=db.example.com`,
    ],
    [
      'a local-looking URL whose repeated host parameter ends with a remote server (the last value wins in pg)',
      `${LOCAL_URL}?host=localhost&host=db.example.com`,
    ],
  ])(
    'refuses a non-TLS DATABASE_URL with %s: only a local database may skip TLS',
    async (_label, url) => {
      vi.stubEnv('DATABASE_URL', url);

      const error = await getTestDatabaseFailure();

      expect(error.message).toContain('sslmode=verify-full');
      expectNoPassword(error);
      expect(connectSpy).not.toHaveBeenCalled();
    },
  );
});

/**
 * "Outside test mode" means any caller other than the test harness
 * (`getTestDatabase()`). Design D5: "Only the test harness may connect to a
 * local database without TLS." A direct `createPool(url)` call is therefore
 * outside test mode even though this file runs under Vitest.
 */
describe('createPool outside test mode', () => {
  it.each([
    ['has no sslmode (local database)', LOCAL_URL],
    ['has no sslmode (remote database)', REMOTE_URL],
    ['uses sslmode=disable', `${REMOTE_URL}?sslmode=disable`],
    ['uses sslmode=allow', `${REMOTE_URL}?sslmode=allow`],
    ['uses sslmode=prefer', `${REMOTE_URL}?sslmode=prefer`],
    ['uses sslmode=require', `${REMOTE_URL}?sslmode=require`],
    ['uses sslmode=verify-ca', `${REMOTE_URL}?sslmode=verify-ca`],
    ['uses sslmode=no-verify', `${REMOTE_URL}?sslmode=no-verify`],
    [
      'mentions sslmode=verify-full only inside another parameter value',
      `${REMOTE_URL}?application_name=sslmode=verify-full`,
    ],
    [
      'overrides sslmode=verify-full with a later sslmode=disable',
      `${REMOTE_URL}?sslmode=verify-full&sslmode=disable`,
    ],
    [
      'overrides sslmode=verify-full with a later, percent-encoded ssl%6Dode=disable (pg decodes the name)',
      `${REMOTE_URL}?sslmode=verify-full&ssl%6Dode=disable`,
    ],
    [
      'puts sslmode=verify-full only in the #fragment, which pg ignores',
      `${REMOTE_URL}?application_name=x#&sslmode=verify-full`,
    ],
  ])(
    'refuses a non-TLS URL, before any connection attempt: a connection string that %s',
    async (_label, url) => {
      const error = await captureFailure(() => createPool(url));

      expect(error.message).toContain('sslmode=verify-full');
      expectNoPassword(error);
      expect(connectSpy).not.toHaveBeenCalled();
    },
  );

  it('still refuses a non-TLS URL when the environment looks like a test run', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');

    const error = await captureFailure(() => createPool(LOCAL_URL));

    expect(error.message).toContain('sslmode=verify-full');
    expectNoPassword(error);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  /**
   * Only the test harness may skip TLS, so no argument of the production
   * `createPool` can switch the check off: whatever a second argument says,
   * a URL without `sslmode=verify-full` is refused.
   */
  it.each([
    ['{ allowInsecureLocal: true }', { allowInsecureLocal: true }],
    ['{ allowInsecure: true, insecure: true }', { allowInsecure: true, insecure: true }],
    [
      '{ testMode: true, test: true, harness: true }',
      { testMode: true, test: true, harness: true },
    ],
    ['{ requireTls: false, requireSsl: false }', { requireTls: false, requireSsl: false }],
    ['{ ssl: false, sslmode: "disable" }', { ssl: false, sslmode: 'disable' }],
    ['an object whose every option is true', everyOption(true)],
    ['an object whose every option is false', everyOption(false)],
  ])(
    'still refuses a local URL without sslmode=verify-full when given a second argument %s',
    async (_label, options) => {
      const error = await captureFailure(() => createPoolWithOptions(LOCAL_URL, options));

      expect(error.message).toContain('sslmode=verify-full');
      expectNoPassword(error);
      expect(connectSpy).not.toHaveBeenCalled();
    },
  );

  it('accepts a connection string with sslmode=verify-full: the pool targets that URL with verified TLS', async () => {
    const url = `${REMOTE_URL}?sslmode=verify-full`;

    // `createPool` may return the pool or a promise of it.
    const pool: unknown = await Promise.resolve(createPool(url));

    expect(pool).toBeInstanceOf(Pool);
    if (!(pool instanceof Pool)) {
      return;
    }
    try {
      // pg builds every pooled connection as `new Client(pool.options)`.
      const client = new Client(pool.options);
      expect({
        host: client.host,
        port: client.port,
        database: client.database,
        user: client.user,
      }).toEqual({
        host: 'db.example.com',
        port: 5432,
        database: 'tayzu',
        user: 'tayzu',
      });
      // pg accepts the password as a string or as a function that returns it.
      const password: unknown = client.password;
      expect(typeof password === 'function' ? await (password as () => unknown)() : password).toBe(
        PASSWORD,
      );

      // TLS is on, and neither certificate nor hostname verification is
      // switched off. These two options are how pg does that for
      // `sslmode=no-verify` and for the libpq-compatible (`uselibpqcompat`)
      // `sslmode=require` and `sslmode=verify-ca`. Node's own
      // `tls.checkServerIdentity` is full hostname verification.
      const ssl: unknown = client.ssl;
      expect(ssl === true || (typeof ssl === 'object' && ssl !== null)).toBe(true);
      expect(ssl).not.toHaveProperty('rejectUnauthorized', false);
      const serverIdentityCheck: unknown =
        typeof ssl === 'object' && ssl !== null && 'checkServerIdentity' in ssl
          ? ssl.checkServerIdentity
          : undefined;
      expect([undefined, checkServerIdentity]).toContain(serverIdentityCheck);
    } finally {
      await pool.end();
    }
  });
});

/**
 * The production entry point is the one `package.json` declares for `.`. It
 * exposes `createPool` and `runMigrations` (task 1.5), but not the test
 * harness: only the harness may connect to a local database without TLS
 * (D5), so `getTestDatabase` must not be reachable from production code
 * through `@tayzu/db`.
 */
describe('@tayzu/db production entry point', () => {
  it('exposes createPool and runMigrations but not the test harness (getTestDatabase)', async () => {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
      exports: Record<string, string | undefined>;
    };
    const entryPath = manifest.exports['.'];
    expect(entryPath).toBeTypeOf('string');

    const entry = (await import(
      /* @vite-ignore */ new URL(String(entryPath), manifestUrl).href
    )) as Record<string, unknown>;

    expect(entry.createPool).toBeTypeOf('function');
    expect(entry.runMigrations).toBeTypeOf('function');
    expect(Object.keys(entry)).not.toContain('getTestDatabase');
  });
});
