/**
 * Reconcile of members and `_user` rows (`043` design D1, D9, Q84 and Q124).
 * Run with `pnpm --filter @tayzu/api identity:reconcile-users`.
 *
 * Scaffolded by `043` task 1.4 (design Q30); its behavior arrives with task
 * 4.2b.
 */
import { runScript } from './run-script.js';

/** Starts through `runScript` (task 2.0); the behavior arrives with task 4.2b. */
export function main(): Promise<void> {
  return runScript('reconcile-users', () => undefined);
}
