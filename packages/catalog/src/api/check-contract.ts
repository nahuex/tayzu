/**
 * CLI entry point for `pnpm contract:check` (task 9.3; design D11). Fails
 * (non-zero exit) on contract drift against the committed
 * `openapi/catalog.openapi.json`, or on a forbidden `tenantId`/`actor` field
 * in any procedure input (spec "Contract cannot carry the tenant"). Run with
 * `tsx` (root CLAUDE.md).
 */
import { checkContract } from './contract.js';

const result = await checkContract();

if (!result.ok) {
  for (const reason of result.reasons) {
    console.error(reason);
  }
  process.exitCode = 1;
}
