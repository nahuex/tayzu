/**
 * Task 2.7 of openspec/changes/044-password-reset-and-account-recovery (design D3 "Identifier
 * families" and D18).
 *
 * Cases: "the writers that exist produce only declared prefixes" and "no row's identifier or
 * value contains a raw token". The declared set is the list `045`'s completeness test consumes.
 *
 * ## Production symbols expected
 *
 * Only symbols that already exist are used (`createResetTokenStore`, `createWithUserLock`).
 * Task 9.1 adds a second writer, `writeMfaReenrolMarker(userId, db?)` in `auth-repository.ts`
 * (writing `mfa-reenrol:<userId>`); it joins the `WRITERS` table below then.
 *
 * Each writer runs once for a fresh random user, and only rows attributable to that run (the
 * user id or the issued id appears in the identifier or the value) are inspected, so rows
 * written by other test files in the shared database are never judged here.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { harnessPools } from '../__fixtures__/pools.js';
import { createResetTokenStore } from './reset-token-store.js';
import { createWithUserLock } from './user-lock.js';

/** The identifier families this change writes (design D3, D11, D18). */
const DECLARED_PREFIXES: readonly string[] = ['password-reset:', 'mfa-reenrol:'];

interface VerificationRow {
  identifier: string;
  value: string;
}

interface WriterRun {
  /** Strings that tie a row to this run: the user id and any generated id. */
  needles: string[];
  /** Raw secrets that must never be stored. */
  secrets: string[];
}

function prefixOf(identifier: string): string {
  const colon = identifier.indexOf(':');
  return colon === -1 ? identifier : identifier.slice(0, colon + 1);
}

describe('auth.verification identifier families (task 2.7)', () => {
  let authPool: Pool;
  let writers: { name: string; run: () => Promise<WriterRun> }[];

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    await runMigrations(authPool);
    const store = createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
    writers = [
      {
        name: 'reset token issue',
        run: async () => {
          const userId = randomUUID();
          const { id, token } = await store.issue(userId);
          return { needles: [userId, id], secrets: [token] };
        },
      },
    ];
  }, 60_000);

  async function rowsOf(needles: string[]): Promise<VerificationRow[]> {
    const result = await authPool.query<VerificationRow>(
      `select identifier, value from auth.verification
       where position($1 in identifier) > 0 or position($1 in value) > 0
          or position($2 in identifier) > 0 or position($2 in value) > 0`,
      [needles[0] ?? '', needles[1] ?? needles[0] ?? ''],
    );
    return result.rows;
  }

  it('the writers that exist produce only declared prefixes', async () => {
    expect(writers.length).toBeGreaterThan(0);
    for (const writer of writers) {
      const run = await writer.run();
      const rows = await rowsOf(run.needles);
      expect(rows.length, `${writer.name} wrote no row`).toBeGreaterThan(0);
      const prefixes = new Set(rows.map((row) => prefixOf(row.identifier)));
      for (const prefix of prefixes) {
        expect(DECLARED_PREFIXES, `${writer.name} wrote the undeclared prefix ${prefix}`).toContain(
          prefix,
        );
      }
    }
  });

  it("no row's identifier or value contains a raw token", async () => {
    for (const writer of writers) {
      const run = await writer.run();
      expect(run.secrets.length).toBeGreaterThan(0);
      for (const secret of run.secrets) {
        const leaks = await authPool.query(
          'select 1 from auth.verification where position($1 in identifier) > 0 or position($1 in value) > 0',
          [secret],
        );
        expect(leaks.rowCount, `${writer.name} stored a raw token`).toBe(0);
      }
    }
  });
});
