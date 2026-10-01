/**
 * Harness pools for apps/api integration tests (task 11.1 fix-up, design D6).
 *
 * The host injects already-built pools into `createApp`; the test suite is the
 * host here. `appPool` runs every query as `tayzu_app` (RLS enforced, the
 * harness's `SET ROLE tayzu_app` pool). `authPool` is the harness's plain
 * `DATABASE_URL` role: `tayzu_auth` has no password in the test cluster, so the
 * owner pool stands in for it. Neither pool is built from a URL by apps/api.
 */
import type { Pool } from 'pg';

import { getOwnerPool, getTestDatabase } from '../../../../packages/db/src/harness.js';

export interface HarnessPools {
  readonly appPool: Pool;
  readonly authPool: Pool;
}

export async function harnessPools(): Promise<HarnessPools> {
  const { pool } = await getTestDatabase();
  const authPool = await getOwnerPool();
  return { appPool: pool, authPool };
}
