/**
 * Future home of the bootstrap-admin CLI (`043` design D9), which moves here
 * from `packages/auth/scripts/bootstrap-admin.ts`.
 *
 * Scaffolded by `043` task 1.4 (design Q30); the CLI moves here in task 4.6b.
 */
import { runScript } from './run-script.js';

/** Starts through `runScript` (task 2.0); the behavior arrives with task 4.6b. */
export function main(): Promise<void> {
  return runScript('bootstrap-admin', () => undefined);
}
