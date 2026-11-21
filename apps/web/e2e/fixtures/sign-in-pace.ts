/**
 * Sign-in pacing of the e2e suite (003 tasks 10.4 to 10.6). The stack runs the API with
 * its production configuration, so the pre-auth limit of `/api/auth/sign-in/email`
 * applies: `DEFAULT_SIGN_IN_LIMIT` of `apps/api/src/config.ts`, 10 sign-ins per client
 * IP with a 60-second window (002 design D20). Every browser request reaches the API
 * from the same loopback address through the TLS proxy, so the suite as a whole shares
 * one bucket, and a run over the limit is answered `429`: the product working as
 * designed, not a failure to hide. The seed's in-process app has no rate limit, so only
 * the browser's sign-ins count.
 *
 * The bucket is not a sliding window. `consumeRateLimitBucket` of `@tayzu/auth` (002
 * Resolved decision Q66) moves the bucket's `lastRequest` on every allowed hit and
 * resets the count only once a whole window has passed since then, so the count keeps
 * growing as long as sign-ins come less than a minute apart, however slowly.
 *
 * The suite keeps under the limit instead: every sign-in request of a test is recorded with its time in a ledger in the run's state directory. Before a
 * test starts, the shared fixture replays the ledger through the same rule, and when the
 * sign-ins that test declares (`signInBudget`, one by default) would not fit, it waits
 * for a whole quiet window, after which the bucket starts again. The ledger holds times
 * only, never an address, an email or a value.
 *
 * This module has no dependency on the server code, so the Playwright process can load
 * it without starting anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { seedFilePath } from './seed-file.js';

/** `DEFAULT_SIGN_IN_LIMIT` of `apps/api/src/config.ts`; `e2e.sh` does not override it. */
export const SIGN_IN_LIMIT = { max: 10, windowSeconds: 60 } as const;
/** One sign-in of headroom, and two seconds of clock skew on top of the window. */
const HEADROOM = 1;
const WINDOW_MS = (SIGN_IN_LIMIT.windowSeconds + 2) * 1000;
/** How far back the ledger is kept: far more than any run goes without a quiet window. */
const LEDGER_HORIZON_MS = 30 * 60 * 1000;
/** The path every local sign-in posts to, the embedded one of the invitation page too. */
export const SIGN_IN_PATH = '/api/auth/sign-in/email';

const LEDGER_FILE_NAME = 'sign-in-ledger.json';

function ledgerPath(): string {
  // Next to the seed file, in the run's state directory (outside the repository).
  return join(dirname(seedFilePath()), LEDGER_FILE_NAME);
}

function readTimes(path: string): number[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed)
    ? parsed.filter((time): time is number => typeof time === 'number')
    : [];
}

/** Appends sign-in times (ms since the epoch) to the ledger; older entries are dropped. */
export function recordSignIns(times: readonly number[]): void {
  if (times.length === 0) return;
  const path = ledgerPath();
  const horizon = Date.now() - LEDGER_HORIZON_MS;
  const kept = [...readTimes(path), ...times].filter((time) => time > horizon);
  writeFileSync(path, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
}

/**
 * How long to wait, from now, until the bucket has room for `budget` more sign-ins, with
 * one of headroom. `0` when there is room already. The ledger is replayed through the
 * bucket's rule: a hit at least a window after the previous one starts the count again.
 * A refused hit (which the bucket does not count) is counted here too, so the estimate
 * only errs on the side of waiting.
 */
export function signInWaitMs(budget: number, now: number = Date.now()): number {
  const allowed = SIGN_IN_LIMIT.max - HEADROOM;
  if (budget > allowed) {
    throw new Error(`A test may declare at most ${String(allowed)} sign-ins.`);
  }
  const times = readTimes(ledgerPath()).sort((left, right) => left - right);
  let count = 0;
  let last: number | undefined;
  for (const time of times) {
    count = last === undefined || time - last >= WINDOW_MS ? 1 : count + 1;
    last = time;
  }
  if (last === undefined || now - last >= WINDOW_MS) return 0;
  return count + budget <= allowed ? 0 : last + WINDOW_MS - now;
}
