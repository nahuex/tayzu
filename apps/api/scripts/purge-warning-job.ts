/**
 * The pre-purge warning job (`048-production-hardening` design D14, Resolved decisions Q12,
 * Q23 and Q24): a daily Container Apps Job that emails an organization's administrators 24
 * to 48 hours before its purge. Task 1.3 scaffolds the module; group 12 gives it its
 * behavior.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runScript } from './run-script.js';

/** The entry point. Group 12 replaces this empty pass with the warning run. */
export async function main(): Promise<void> {
  await runScript('purge-warning-job', () => undefined);
}

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
  main().then(
    () => undefined,
    () => {
      // Only a fixed text: a driver error can quote a host or a bind value.
      process.stderr.write('purge-warning-job failed\n');
      process.exitCode = 1;
    },
  );
}
