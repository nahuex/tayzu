/**
 * The reversal job (`045` design D3): the audited operator action that cancels a pending org
 * deletion, run as `tayzu_deletion_admin` (Resolved decision Q35) and started only through the
 * reviewed maintenance workflow (Q41). It tombstones the tenant's pending marker and never
 * deletes it. Started by the `identity:cancel-org-deletion` package script through `main`, which
 * opens no listener.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { emitIdentityEvent } from '@tayzu/auth';
import { createPool } from '@tayzu/db';
import type { Pool } from 'pg';

import type { Telemetry } from '../src/telemetry.js';
import { runScript } from './run-script.js';
import { FixedMessageError, loadScriptConfig } from './script-config.js';

export type CancelRefusalReason =
  'invalid_tenant' | 'no_pending_marker' | 'purge_begun' | 'purge_date_passed';

export type CancelOrgDeletionResult =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'refused'; readonly reason: CancelRefusalReason };

export interface CancelOrgDeletionOptions {
  /** The tenant to revive, exactly as the workflow handed it over: not yet shape-checked. */
  readonly tenantId: string;
  /** Defaults to `process.env`. The operator id is `TAYZU_OPERATOR_ID`, never an argument. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A pool the host already built; when given, `main` does not end it. */
  readonly pool?: Pool;
  /** Replaces `startTelemetry(env)`; a test seam. */
  readonly telemetry?: Telemetry;
}

/**
 * The variable the CLI entry point reads the tenant id from (task 7.4: the job receives the
 * operator id and the tenant id as fixed variable names). It is the script's input, not its
 * configuration: a malformed value is a logged `invalid_tenant` refusal, not a load failure, so
 * `loadScriptConfig` does not read it.
 */
export const TENANT_ID_VARIABLE = 'TAYZU_TENANT_ID';

/** The catalog's tenant-id pattern (`packages/catalog/src/domain/context.ts`). */
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const REFUSED_EVENT = 'catalog.security.org_deletion_cancel_refused';

/**
 * Why the tenant's marker cannot be tombstoned, or `undefined` when it can. Under `0013`'s
 * `deletion_admin_select` (Q171) the reversal role reads every pending marker, so a recorded
 * step and a passed purge date are told apart from a missing marker. Both checks use the
 * database clock, as the tombstone policy does.
 */
async function refusalReason(
  pool: Pool,
  tenantId: string,
): Promise<CancelRefusalReason | undefined> {
  const { rows } = await pool.query<{ purge_begun: boolean; date_passed: boolean }>(
    `select (catalog_purged_at is not null or auth_purged_at is not null) as purge_begun,
            purge_after <= now() as date_passed
       from tenant_deletion_marker
      where tenant_id = $1 and state = 'pending'`,
    [tenantId],
  );
  const [marker] = rows;
  if (marker === undefined) return 'no_pending_marker';
  if (marker.purge_begun) return 'purge_begun';
  if (marker.date_passed) return 'purge_date_passed';
  return undefined;
}

/**
 * Tombstones the pending marker: `state = 'cancelled'`, `cancelled_at = now()` and
 * `cancelled_by`, in one statement that `0013`'s `deletion_admin_tombstone` admits only for a
 * marker with no recorded step and a future purge date. Resolves `false` when no row was
 * tombstoned.
 */
async function tombstone(pool: Pool, tenantId: string, operatorId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update tenant_deletion_marker
        set state = 'cancelled', cancelled_at = now(), cancelled_by = $2
      where tenant_id = $1 and state = 'pending'
      returning tenant_id`,
    [tenantId, operatorId],
  );
  return rowCount === 1;
}

/**
 * Logs a refusal (design "Observability"): the operator's opaque id, the reason, and the
 * tenant only when its id passed the shape check. No body, so no free text.
 */
function emitRefused(operatorId: string, reason: CancelRefusalReason, tenantId?: string): void {
  emitIdentityEvent({
    name: REFUSED_EVENT,
    severity: 'WARN',
    attributes: {
      'tayzu.identity.operator.id': operatorId,
      'tayzu.identity.org_deletion.cancel_refusal': reason,
      ...(tenantId === undefined ? {} : { 'tayzu.tenant.id': tenantId }),
    },
  });
}

/**
 * The reversal itself: shape check, classification, tombstone. A tombstone that touches no row
 * lost a race (another reversal, or a purge step, in between); the marker is read again to name
 * the refusal, and one that still looks tombstonable is refused as `no_pending_marker` (fail
 * closed).
 */
async function cancel(
  pool: Pool,
  tenantId: string,
  operatorId: string,
): Promise<CancelOrgDeletionResult> {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    emitRefused(operatorId, 'invalid_tenant');
    return { outcome: 'refused', reason: 'invalid_tenant' };
  }
  let reason = await refusalReason(pool, tenantId);
  if (reason === undefined) {
    if (await tombstone(pool, tenantId, operatorId)) return { outcome: 'cancelled' };
    reason = (await refusalReason(pool, tenantId)) ?? 'no_pending_marker';
  }
  emitRefused(operatorId, reason, tenantId);
  return { outcome: 'refused', reason };
}

/**
 * The entry point. The configuration is loaded first: a missing or malformed
 * `TAYZU_OPERATOR_ID` rejects with the loader's fixed message before any pool, telemetry or
 * event. The pool is built from `REVERSAL_DATABASE_URL` (`createPool` requires
 * `sslmode=verify-full`), the only database URL the script reads. The reversal runs inside
 * `runScript`, which first asserts `current_user = 'tayzu_deletion_admin'` and whose final flush
 * exports the refusal event before this resolves (`043` task 2.0, Resolved decision Q79). A
 * refusal is a result; the CLI turns it into a non-zero exit status.
 */
export async function main(options: CancelOrgDeletionOptions): Promise<CancelOrgDeletionResult> {
  const env = options.env ?? process.env;
  const config = loadScriptConfig('cancel-org-deletion', env);
  const pool = options.pool ?? createPool(config.REVERSAL_DATABASE_URL);
  try {
    return await runScript(
      'cancel-org-deletion',
      () => cancel(pool, options.tenantId, config.TAYZU_OPERATOR_ID),
      {
        env,
        roles: [{ pool, roles: ['tayzu_deletion_admin'] }],
        telemetry: options.telemetry,
      },
    );
  } finally {
    if (options.pool === undefined) await pool.end();
  }
}

const GENERIC_FAILURE_MESSAGE = 'the reversal failed; check the database role and the environment.';

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // An unset tenant variable is an empty id: an `invalid_tenant` refusal, logged like any other.
  main({ tenantId: process.env[TENANT_ID_VARIABLE] ?? '' }).then(
    (result) => {
      if (result.outcome === 'refused') {
        process.stderr.write(`cancel-org-deletion refused: ${result.reason}\n`);
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      // Only a fixed text: a driver error can quote a host or a bind value.
      process.stderr.write(
        `cancel-org-deletion failed: ${error instanceof FixedMessageError ? error.message : GENERIC_FAILURE_MESSAGE}\n`,
      );
      process.exitCode = 1;
    },
  );
}
