import { inspect } from 'node:util';

import { Client, Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { assertVerifiedTls } from './connection-security.js';
import { createPool } from './index.js';

/**
 * Unit tests for the variable name in the TLS error (048 task 2.2, design D1).
 * No database is needed: pg's `Client#connect` is blocked, so a refused URL
 * must fail before any connection is attempted.
 *
 * Spec (auth-and-rbac), scenario "A TLS error names the variable it was given":
 *   WHEN the migration command is given a non-local connection string without
 *        verified TLS
 *   THEN it fails before connecting, and the message names the migration
 *        role's variable, not the runtime one
 *
 * Design D1: "`assertVerifiedTls(url, variable)` and `createPool(url, { variable })`
 * take the name of the variable that held the URL, defaulting to
 * `DATABASE_URL`, and the TLS message names it. The migration command passes
 * `MIGRATION_DATABASE_URL`; the other pools may pass theirs."
 *
 * Task 2.2: "... and no message holds the URL, the host or the user."
 */

const MIGRATION_VARIABLE = 'MIGRATION_DATABASE_URL';

/** Recognizable parts, so the tests can prove none of them reaches an error. */
const USER = 'migrator-login-u5er';
const PASSWORD = 'tls-variable-s3cr3t-pw';
const HOST = 'pg-primary.prod-db.example.net';
const DATABASE = 'tayzu_prod_db';
const REMOTE_URL = `postgres://${USER}:${PASSWORD}@${HOST}:5432/${DATABASE}`;

/** Non-local connection strings that pg would not open with verified TLS. */
const UNVERIFIED_URLS = [
  ['no sslmode', REMOTE_URL],
  ['sslmode=disable', `${REMOTE_URL}?sslmode=disable`],
  ['sslmode=require', `${REMOTE_URL}?sslmode=require`],
] as const;

/** `DATABASE_URL` as a name of its own, not as the tail of `MIGRATION_DATABASE_URL`. */
const RUNTIME_VARIABLE_ALONE = /(?<![A-Z0-9_])DATABASE_URL/;

/** pg's `Client#connect`, with both of its call forms (callback and promise). */
interface Connectable {
  connect(...args: unknown[]): unknown;
}

type ConnectSpy = MockInstance<(...args: unknown[]) => unknown>;

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

/** Ends a pool that a call returned by mistake. */
async function endIfPool(value: unknown): Promise<void> {
  if (value instanceof Pool) {
    await value.end();
  }
}

/** Runs `action` and returns the error it throws or rejects with. */
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
 * Neither the message nor anything a logger would print (a `cause`, an own or
 * a hidden property) holds the URL, the host, the user or the password.
 */
function expectNoConnectionDetails(error: Error, url: string): void {
  const printed = inspect(error, { depth: null, showHidden: true });
  for (const value of [url, REMOTE_URL, HOST, USER, PASSWORD, DATABASE]) {
    expect(error.message).not.toContain(value);
    expect(printed).not.toContain(value);
  }
}

let connectSpy: ConnectSpy;

beforeEach(() => {
  connectSpy = blockConnections();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A TLS error names the variable it was given', () => {
  describe('assertVerifiedTls', () => {
    it.each(UNVERIFIED_URLS)(
      'names MIGRATION_DATABASE_URL, not DATABASE_URL, for a non-local URL with %s',
      async (_label, url) => {
        const error = await captureFailure(() => {
          assertVerifiedTls(url, MIGRATION_VARIABLE);
        });

        expect(error.message).toContain(MIGRATION_VARIABLE);
        expect(error.message).not.toMatch(RUNTIME_VARIABLE_ALONE);
        expect(error.message).toContain('sslmode=verify-full');
        expectNoConnectionDetails(error, url);
      },
    );

    it('names whichever variable it is given (another pool passes its own)', async () => {
      const error = await captureFailure(() => {
        assertVerifiedTls(REMOTE_URL, 'AUTH_DATABASE_URL');
      });

      expect(error.message).toContain('AUTH_DATABASE_URL');
      expect(error.message).not.toContain(MIGRATION_VARIABLE);
      expect(error.message).not.toMatch(RUNTIME_VARIABLE_ALONE);
      expect(error.message).toContain('sslmode=verify-full');
      expectNoConnectionDetails(error, REMOTE_URL);
    });

    it.each(UNVERIFIED_URLS)(
      'names DATABASE_URL by default for a non-local URL with %s',
      async (_label, url) => {
        const error = await captureFailure(() => {
          assertVerifiedTls(url);
        });

        expect(error.message).toMatch(RUNTIME_VARIABLE_ALONE);
        expect(error.message).not.toContain(MIGRATION_VARIABLE);
        expect(error.message).toContain('sslmode=verify-full');
        expectNoConnectionDetails(error, url);
      },
    );

    it('still accepts a verify-full URL when given a variable', () => {
      expect(() => {
        assertVerifiedTls(`${REMOTE_URL}?sslmode=verify-full`, MIGRATION_VARIABLE);
      }).not.toThrow();
    });
  });

  describe('createPool', () => {
    it.each(UNVERIFIED_URLS)(
      'names MIGRATION_DATABASE_URL, not DATABASE_URL, before connecting, for a non-local URL with %s',
      async (_label, url) => {
        const error = await captureFailure(() => createPool(url, { variable: MIGRATION_VARIABLE }));

        expect(error.message).toContain(MIGRATION_VARIABLE);
        expect(error.message).not.toMatch(RUNTIME_VARIABLE_ALONE);
        expect(error.message).toContain('sslmode=verify-full');
        expectNoConnectionDetails(error, url);
        expect(connectSpy).not.toHaveBeenCalled();
      },
    );

    it.each(UNVERIFIED_URLS)(
      'names DATABASE_URL by default, before connecting, for a non-local URL with %s',
      async (_label, url) => {
        const error = await captureFailure(() => createPool(url));

        expect(error.message).toMatch(RUNTIME_VARIABLE_ALONE);
        expect(error.message).not.toContain(MIGRATION_VARIABLE);
        expect(error.message).toContain('sslmode=verify-full');
        expectNoConnectionDetails(error, url);
        expect(connectSpy).not.toHaveBeenCalled();
      },
    );

    it('naming a variable does not exempt a local database from TLS', async () => {
      const localUrl = `postgres://${USER}:${PASSWORD}@localhost:5432/${DATABASE}`;

      const error = await captureFailure(() =>
        createPool(localUrl, { variable: MIGRATION_VARIABLE }),
      );

      expect(error.message).toContain(MIGRATION_VARIABLE);
      expect(error.message).toContain('sslmode=verify-full');
      expectNoConnectionDetails(error, localUrl);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('still builds a pool, without connecting, for a verify-full URL when given a variable', async () => {
      const pool = createPool(`${REMOTE_URL}?sslmode=verify-full`, {
        variable: MIGRATION_VARIABLE,
      });

      expect(pool).toBeInstanceOf(Pool);
      expect(connectSpy).not.toHaveBeenCalled();
      await pool.end();
    });
  });
});
