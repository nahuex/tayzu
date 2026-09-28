/**
 * Change-event appender (design D4, D9; spec "Actor attribution and change
 * events"; task 5.4).
 *
 * `appendChangeEvent` assigns a per-tenant, gap-free `seq` with
 * `INSERT ... ON CONFLICT (tenant_id) DO UPDATE ... RETURNING last_seq`
 * (design D9's "insert on first write" form of the documented
 * `UPDATE ... RETURNING`), then inserts one row into `catalog_change_event`
 * with that `seq`. Both statements run in the caller-supplied transaction
 * `tx`, so a rollback of `tx` undoes both the sequence bump and the event
 * insert, leaving the tenant's committed sequence gap-free (spec: "Append
 * exactly one change event per affected resource, in the same transaction").
 *
 * `catalog_change_event` is append-only: a `BEFORE UPDATE OR DELETE` row
 * trigger and a `BEFORE TRUNCATE` statement trigger (migration 0001) reject
 * every attempt to alter or remove a row, independent of this module.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Principal } from '../domain/context.js';

export type ChangeEventAction = 'created' | 'updated' | 'status_updated' | 'deleted';
export type ChangeEventResourceKind = 'blueprint' | 'entity';

export interface ChangeEventInput {
  readonly tenantId: string;
  /** The context actor. `onBehalfOf`, when present, is recorded alongside it. */
  readonly actor: Principal & { onBehalfOf?: Principal };
  readonly action: ChangeEventAction;
  readonly resourceKind: ChangeEventResourceKind;
  readonly blueprintIdentifier: string;
  readonly resourceIdentifier: string;
  readonly version: number;
  readonly changedFields: readonly string[];
  /** JSON-serializable. Stored as-is in the `snapshot jsonb` column. */
  readonly snapshot: unknown;
  readonly traceId?: string;
  /** Defaults to `now()` (UTC) when omitted. */
  readonly occurredAt?: Date;
}

/**
 * The minimal shape `appendChangeEvent` needs from a transaction handle: what
 * `db.transaction(async (tx) => ...)` (drizzle-orm's node-postgres driver)
 * hands its callback, and nothing this module does not use.
 */
interface ChangeEventTransaction {
  execute(query: SQL): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

/** Assigns the next per-tenant `seq`, inserting the counter row on first write. */
async function nextSeq(tx: ChangeEventTransaction, tenantId: string): Promise<bigint> {
  const result = await tx.execute(sql`
    insert into catalog_tenant_sequence (tenant_id, last_seq)
    values (${tenantId}, 1)
    on conflict (tenant_id)
    do update set last_seq = catalog_tenant_sequence.last_seq + 1
    returning last_seq
  `);
  const row = result.rows[0];
  // `bigint` (`int8`), read back raw as a string (node-postgres default).
  const lastSeq = row?.['last_seq'];
  if (typeof lastSeq !== 'string') {
    throw new Error('catalog_tenant_sequence did not return the assigned seq.');
  }
  return BigInt(lastSeq);
}

/**
 * Appends one row to `catalog_change_event` inside `tx`, with a fresh,
 * per-tenant gap-free `seq`. Returns the assigned `seq`.
 */
export async function appendChangeEvent(tx: ChangeEventTransaction, event: ChangeEventInput): Promise<bigint> {
  const seq = await nextSeq(tx, event.tenantId);
  const onBehalfOf = event.actor.onBehalfOf;
  const occurredAt = event.occurredAt ?? new Date();
  // `sql.param(...)` (not a bare interpolated array): drizzle's `sql` tag
  // otherwise flattens a plain JS array into a comma-separated list of
  // placeholders wrapped in parens (its `IN (...)` shorthand), which is not
  // a valid `text[]` literal. `sql.param` passes the array through to `pg`
  // as a single bind value, which `pg` serializes as a Postgres array.
  const changedFields = sql.param([...event.changedFields]);

  await tx.execute(sql`
    insert into catalog_change_event
      (tenant_id, seq, occurred_at, actor_type, actor_id, on_behalf_of_type, on_behalf_of_id,
       action, resource_kind, blueprint_identifier, resource_identifier, version, changed_fields,
       snapshot, trace_id)
    values
      (${event.tenantId}, ${seq}, ${occurredAt}, ${event.actor.type}, ${event.actor.id},
       ${onBehalfOf?.type ?? null}, ${onBehalfOf?.id ?? null},
       ${event.action}, ${event.resourceKind}, ${event.blueprintIdentifier}, ${event.resourceIdentifier},
       ${event.version}, ${changedFields}::text[],
       ${JSON.stringify(event.snapshot)}::jsonb, ${event.traceId ?? null})
  `);

  return seq;
}
