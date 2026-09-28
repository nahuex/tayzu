/**
 * Integration test for task 5.4 (design D4, D9, R13; spec "Actor attribution
 * and change events").
 *
 * ## Module under test and assumed API
 *
 * `./change-events.js` does not exist yet (red phase). This test assumes the
 * following exported shape, which is the minimum design D9 and R13 need:
 *
 * ```ts
 * export interface ChangeEventInput {
 *   readonly tenantId: string;
 *   readonly actor: Principal;              // domain/context.js; onBehalfOf optional
 *   readonly action: 'created' | 'updated' | 'status_updated' | 'deleted';
 *   readonly resourceKind: 'blueprint' | 'entity';
 *   readonly blueprintIdentifier: string;
 *   readonly resourceIdentifier: string;
 *   readonly version: number;
 *   readonly changedFields: readonly string[];
 *   readonly snapshot: unknown;              // JSON-serializable; stored as-is in `snapshot jsonb`
 *   readonly traceId?: string;
 *   readonly occurredAt?: Date;              // defaults to now() (UTC) when omitted
 * }
 *
 * // Assigns `seq` with
 * //   INSERT INTO catalog_tenant_sequence (tenant_id, last_seq) VALUES ($1, 1)
 * //   ON CONFLICT (tenant_id) DO UPDATE SET last_seq = catalog_tenant_sequence.last_seq + 1
 * //   RETURNING last_seq
 * // (design D9's "insert on first write" form of the documented
 * // `UPDATE ... RETURNING`), then inserts one row into `catalog_change_event`
 * // with that `seq`, inside the caller-supplied transaction `tx`. Both
 * // statements must run in the same transaction as the rest of the mutation
 * // (spec: "Append exactly one change event per affected resource, in the
 * // same transaction"), so a rollback of `tx` undoes both the sequence bump
 * // and the event insert, leaving the tenant's sequence gap-free.
 * export function appendChangeEvent(
 *   tx: { execute<T extends Record<string, unknown>>(query: SQL): Promise<{ rows: T[] }> },
 *   event: ChangeEventInput,
 * ): Promise<bigint>;
 * ```
 *
 * `tx` is whatever `db.transaction(async (tx) => ...)` (drizzle-orm's
 * node-postgres driver) hands the callback: this test never opens its own
 * `BEGIN`/`COMMIT`, so the appender's own transaction-participation is what is
 * actually exercised.
 *
 * ## Why this test connects the way it does
 *
 * Same pattern as `db-isolation.int.test.ts`: connect directly to the shared
 * `DATABASE_URL` database (no scratch database â€” nothing here changes the
 * schema), apply `runMigrations` defensively, and use a fresh random
 * `tenantId` per scenario (D12). `catalog_change_event.seq` is `bigint`
 * (`int8`); node-postgres returns `int8` values read back through a raw
 * `db.execute` as strings by default (to avoid silent precision loss), so
 * this file converts them to `BigInt` itself wherever it reads `seq` back
 * from a row, while treating `appendChangeEvent`'s own return value as the
 * `bigint` the assumed signature above promises.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Principal } from '../domain/context.js';
import { appendChangeEvent, type ChangeEventInput } from './change-events.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string) {
  return drizzle(url);
}

type Db = ReturnType<typeof connect>;

function randomTenantId(): string {
  return `t${randomUUID().replaceAll('-', '')}`;
}

const SYSTEM_ACTOR: Principal = { type: 'system', id: 'sys' };

function buildEvent(tenantId: string, overrides: Partial<ChangeEventInput> = {}): ChangeEventInput {
  return {
    tenantId,
    actor: SYSTEM_ACTOR,
    action: 'created',
    resourceKind: 'entity',
    blueprintIdentifier: 'bp',
    resourceIdentifier: `e-${randomUUID().replaceAll('-', '').slice(0, 8)}`,
    version: 1,
    changedFields: ['spec'],
    snapshot: { title: 'Entity', spec: {} },
    ...overrides,
  };
}

// A type literal (not an interface), so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in schema-hardening.int.test.ts).
type StoredEventRow = {
  readonly seq: string; // int8 read back raw: node-postgres returns it as a string
  readonly snapshot: unknown;
};

async function selectEvents(db: Db, tenantId: string): Promise<StoredEventRow[]> {
  const result = await db.execute<StoredEventRow>(sql`
    select seq, snapshot from catalog_change_event where tenant_id = ${tenantId} order by seq
  `);
  return result.rows;
}

describe('appendChangeEvent (design D9, R13; spec "Actor attribution and change events")', () => {
  let db: Db;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
  }, 60_000);

  it('assigns seq starting at 1 and increments it per tenant independently', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();

    const seqA1 = await db.transaction((tx) => appendChangeEvent(tx, buildEvent(tenantA)));
    const seqA2 = await db.transaction((tx) => appendChangeEvent(tx, buildEvent(tenantA)));
    const seqB1 = await db.transaction((tx) => appendChangeEvent(tx, buildEvent(tenantB)));

    expect(seqA1).toBe(1n);
    expect(seqA2).toBe(2n);
    expect(seqB1, "tenant B's sequence is independent of tenant A's").toBe(1n);

    const eventsA = await selectEvents(db, tenantA);
    expect(eventsA.map((row) => row.seq)).toEqual(['1', '2']);
    const eventsB = await selectEvents(db, tenantB);
    expect(eventsB.map((row) => row.seq)).toEqual(['1']);
  });

  it('leaves no event and no sequence gap when the transaction rolls back', async () => {
    const tenantId = randomTenantId();
    let seqBeforeRollback: bigint | undefined;

    await expect(
      db.transaction(async (tx) => {
        seqBeforeRollback = await appendChangeEvent(tx, buildEvent(tenantId));
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(seqBeforeRollback, 'appendChangeEvent must have run before the throw').toBe(1n);

    const eventsAfterRollback = await selectEvents(db, tenantId);
    expect(eventsAfterRollback, 'the rolled-back event must not be persisted').toHaveLength(0);

    // The next *committed* append must get seq 1 again (not 2): the sequence
    // bump made inside the rolled-back transaction was rolled back with it,
    // so there is no gap in the tenant's committed sequence (design D9).
    const nextSeq = await db.transaction((tx) => appendChangeEvent(tx, buildEvent(tenantId)));
    expect(nextSeq, 'the sequence is gap-free after a rollback').toBe(1n);

    const eventsAfterCommit = await selectEvents(db, tenantId);
    expect(eventsAfterCommit.map((row) => row.seq)).toEqual(['1']);
  });

  it('stores exactly the snapshot it is given', async () => {
    const tenantId = randomTenantId();
    const snapshot = {
      title: { en: 'Payments' },
      icon: 'wallet',
      spec: { properties: { tier: 'silver' } },
      status: null,
    };

    const seq = await db.transaction((tx) =>
      appendChangeEvent(tx, buildEvent(tenantId, { action: 'updated', snapshot })),
    );

    const rows = await selectEvents(db, tenantId);
    const row = rows.find((candidate) => BigInt(candidate.seq) === seq);
    expect(row, 'the appended row must be found by its returned seq').toBeDefined();
    expect(row?.snapshot).toEqual(snapshot);
  });

  describe('Change events cannot be altered', () => {
    async function appendOneEvent(tenantId: string): Promise<void> {
      await db.transaction((tx) => appendChangeEvent(tx, buildEvent(tenantId)));
    }

    it('rejects a raw UPDATE on a row appended through appendChangeEvent', async () => {
      const tenantId = randomTenantId();
      await appendOneEvent(tenantId);

      await expect(
        db.execute(sql`update catalog_change_event set version = 99 where tenant_id = ${tenantId} and seq = 1`),
      ).rejects.toThrow();

      const rows = await selectEvents(db, tenantId);
      expect(rows).toHaveLength(1);
    });

    it('rejects a raw DELETE on a row appended through appendChangeEvent', async () => {
      const tenantId = randomTenantId();
      await appendOneEvent(tenantId);

      await expect(
        db.execute(sql`delete from catalog_change_event where tenant_id = ${tenantId} and seq = 1`),
      ).rejects.toThrow();

      const rows = await selectEvents(db, tenantId);
      expect(rows).toHaveLength(1);
    });

    it('rejects a raw TRUNCATE of catalog_change_event', async () => {
      const tenantId = randomTenantId();
      await appendOneEvent(tenantId);

      await expect(db.execute(sql`truncate catalog_change_event`)).rejects.toThrow();

      const rows = await selectEvents(db, tenantId);
      expect(rows, 'the row must survive the rejected TRUNCATE').toHaveLength(1);
    });
  });
});
