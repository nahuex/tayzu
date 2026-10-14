/**
 * CLI entry point for `contract:check` (task 14.1c): exits non-zero on drift against
 * the committed `openapi/identity.openapi.json`.
 */
import { checkIdentityContract } from '../src/identity-openapi.js';

const result = await checkIdentityContract();

if (!result.ok) {
  for (const reason of result.reasons) console.error(reason);
  process.exitCode = 1;
}
