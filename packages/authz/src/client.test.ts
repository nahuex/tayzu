import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCerbosClient } from './client.js';

/**
 * Task 7.1 Verify: the client connects to the CI Cerbos container and a
 * trivial CheckResources call round-trips. Needs a running Cerbos PDP
 * (compose.yaml's `cerbos` service, scripts/dev/start-cerbos.sh, or CI's).
 * The address is passed explicitly: library code never hardcodes it.
 * With no policies loaded, Cerbos default-denies, so the test asserts the
 * round-trip (a decision came back for this resource and action), and that
 * the decision is a deny, never an allow.
 */
const grpcPort = process.env['TAYZU_CERBOS_GRPC_PORT'] ?? '3593';
const address = `localhost:${grpcPort}`;

describe('@tayzu/authz Cerbos client', () => {
  it('connects to Cerbos and a trivial CheckResources call round-trips', async () => {
    const client = createCerbosClient({ address, tls: false });
    const tenantId = randomUUID();
    const resourceId = randomUUID();

    const response = await client.checkResources({
      principal: {
        id: randomUUID(),
        roles: ['member'],
        attr: { tenantId },
      },
      resources: [
        {
          resource: {
            kind: 'catalog_entity',
            id: resourceId,
            attr: { tenantId },
          },
          actions: ['read'],
        },
      ],
    });

    expect(response.results).toHaveLength(1);
    const [result] = response.results;
    expect(result?.resource.kind).toBe('catalog_entity');
    expect(result?.resource.id).toBe(resourceId);
    // Round-trip: a decision for the requested action came back. No policies
    // are deployed for this call, so the strict default is deny.
    expect(result?.actions).toHaveProperty('read');
    // `actions` holds Effect values, so the documented isAllowed() is used.
    // It returns false for a deny and undefined for an unrequested action,
    // so toBe(false) is a strict deny assertion.
    expect(result?.isAllowed('read')).toBe(false);
  });
});
