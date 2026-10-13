import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { prepareTestDatabase } from './harness.js';

/**
 * Regression: `prepareTestDatabase()` (and every worker's first
 * `getTestDatabase()`) must not take an ACCESS EXCLUSIVE lock on catalog
 * tables when nothing needs to change. `ALTER TABLE ... OWNER TO` takes that
 * lock even when the owner is already correct, so a worker initializing
 * mid-run queued behind running transactions and every later statement queued
 * behind it, hitting the tenant statement timeout (SQLSTATE 57014).
 */

const BOUND_MS = 3000;
const TIMED_OUT = Symbol('timed out');

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

describe('test harness lock behavior', () => {
  it('prepareTestDatabase does not block behind a transaction holding ACCESS SHARE on catalog_blueprint', async () => {
    const holder = new Client({ connectionString: databaseUrl() });
    await holder.connect();
    let preparation: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('select 1 from catalog_blueprint limit 1');

      preparation = prepareTestDatabase();
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          resolve(TIMED_OUT);
        }, BOUND_MS);
      });

      const outcome = await Promise.race([preparation.then(() => 'done' as const), timeout]);

      expect(outcome).toBe('done');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      // Let a blocked preparation finish so nothing is left dangling.
      await preparation?.catch(() => undefined);
    }
  }, 30_000);
});
