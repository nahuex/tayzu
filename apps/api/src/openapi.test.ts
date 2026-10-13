/**
 * Task 14.2 (openspec/changes/043-identity-lifecycle-and-org-admin, Resolved
 * decisions Q19 and Q31): scenario "Every route in the high-risk set is marked".
 * Reads the committed `openapi/identity.openapi.json` of 14.1c; no database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const committedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'openapi',
  'identity.openapi.json',
);

type Operation = Record<string, unknown>;
type Document = { paths: Record<string, Record<string, Operation>> };

// The high-risk set of the spec's "Every high-risk operation requires step-up".
const HIGH_RISK_SET: readonly (readonly [string, string, string])[] = [
  ['identity.users.setStatus', 'put', '/v1/users/{user}/status'],
  ['identity.users.invite', 'post', '/v1/users/invitations'],
  ['identity.users.create', 'post', '/v1/users'],
  ['identity.serviceAccounts.create', 'post', '/v1/service-accounts'],
  ['identity.serviceAccounts.delete', 'delete', '/v1/service-accounts/{user}'],
  ['identity.credentials.create', 'post', '/v1/credentials'],
  ['identity.credentials.rotate', 'post', '/v1/credentials/{credential}/rotate'],
  ['identity.credentials.revoke', 'post', '/v1/credentials/{credential}/revoke'],
  ['identity.users.linkSsoAccount', 'post', '/v1/users/{user}/sso-account'],
  ['identity.users.unlinkSsoAccount', 'delete', '/v1/users/{user}/sso-account'],
];

describe('identity OpenAPI risk markers (task 14.2)', () => {
  const document = JSON.parse(readFileSync(committedPath, 'utf8')) as Document;

  it('Every route in the high-risk set is marked', () => {
    for (const [operationId, method, path] of HIGH_RISK_SET) {
      const operation = document.paths[path]?.[method];
      expect(operation, `${method} ${path} is in the document`).toBeDefined();
      expect(operation?.['operationId']).toBe(operationId);
      expect(operation?.['x-tayzu-risk'], `${operationId} risk`).toBe('high');
    }
  });
});
