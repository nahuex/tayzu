/**
 * Shared authorization fixtures (002 task 9.1, Q26/Q27): the real Cerbos
 * client and an admin principal, so pre-existing catalog tests keep exercising
 * the same behavior now that every operation is authorized.
 */
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';

import type { AuthorizationDeclaration } from '../pipeline.js';

const CERBOS_ADDRESS = 'localhost:3593';

/** Same Cerbos endpoint as `authz-pipeline.int.test.ts`. */
export function createTestAuthz(): CerbosClient {
  return createCerbosClient({ address: CERBOS_ADDRESS, tls: false });
}

/** Shared client for tests that build services with `{ pool, authz }`. */
export const authz: CerbosClient = createTestAuthz();

/** The principal every actor type gets in fixtures: `admin` of the test's tenant. */
export const ADMIN_PRINCIPAL = { roles: ['admin'] } as const satisfies {
  readonly roles: readonly string[];
};

/** Authorization declaration for dummy pipeline operations defined by tests. */
export function testAuthorization(): AuthorizationDeclaration {
  return { kind: 'catalog_entity', action: 'view', resourceId: 'pipeline-test-resource' };
}
