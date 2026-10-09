/**
 * Backfill of the `_user` blueprint extension, run once per existing tenant
 * (`043` design D1 and D9). Run with `pnpm --filter @tayzu/api
 * identity:backfill-user-blueprint`.
 *
 * Scaffolded by `043` task 1.4 (design Q30); its behavior arrives with task
 * 2.2.
 */
import { runScript } from './run-script.js';

/** Starts through `runScript` (task 2.0); the behavior arrives with task 2.2. */
export function main(): Promise<void> {
  return runScript('backfill-user-blueprint', () => undefined);
}
