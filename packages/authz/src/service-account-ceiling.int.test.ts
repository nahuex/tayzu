import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildAttributes } from './attributes.js';
import { createCerbosClient } from './client.js';

/**
 * Task 5.5 (043 design D3, Resolved decisions Q7 and Q16): the same inputs as
 * `policies/resource_policies/user_test.yaml`, against the real Cerbos
 * container. Scenario: "The Cerbos ceiling denies an elevated service-account
 * resource".
 */
const grpcPort = process.env['TAYZU_CERBOS_GRPC_PORT'] ?? '3593';
const authz = createCerbosClient({ address: `localhost:${grpcPort}`, tls: false });

type CerbosAttributes = NonNullable<
  Parameters<typeof authz.checkResources>[0]['principal']['attr']
>;
type ResourceExtra = Record<string, unknown>;

async function isAllowed(options: {
  readonly tenantId: string;
  readonly principalId?: string;
  readonly roles: readonly string[];
  readonly resourceId?: string;
  readonly resourceExtra?: ResourceExtra;
  readonly action: string;
}): Promise<boolean> {
  const response = await authz.checkResources({
    principal: {
      id: options.principalId ?? randomUUID(),
      roles: [...options.roles],
      // The principal attributes the catalog pipeline sends (pipeline.ts `authorize`).
      attr: buildAttributes(options.tenantId, { teams: [], moderatedBlueprints: [] }),
    },
    resources: [
      {
        resource: {
          kind: 'user',
          id: options.resourceId ?? randomUUID(),
          attr: buildAttributes(options.tenantId, options.resourceExtra) as CerbosAttributes,
        },
        actions: [options.action],
      },
    ],
  });
  return response.results[0]?.isAllowed(options.action) === true;
}

const ACTIONS = ['view', 'create', 'update', 'delete', 'invite', 'updateStatus'] as const;

describe('Cerbos service-account ceiling on resource kind user', () => {
  it('a call with none of the new attributes (today callers) stays allowed for an admin', async () => {
    const tenantId = randomUUID();
    for (const action of ACTIONS) {
      expect(await isAllowed({ tenantId, roles: ['admin'], action }), action).toBe(true);
    }
  });

  it('a service-account resource with portRole admin is denied every action, for an admin', async () => {
    const tenantId = randomUUID();
    for (const action of [...ACTIONS, 'list', 'export']) {
      const allowed = await isAllowed({
        tenantId,
        roles: ['admin'],
        resourceExtra: { accountKind: 'service', portRole: 'admin' },
        action,
      });
      expect(allowed, action).toBe(false);
    }
  });

  it('a service-account resource with a non-empty moderatedBlueprints is denied every action, for an admin', async () => {
    const tenantId = randomUUID();
    for (const action of [...ACTIONS, 'list', 'export']) {
      const allowed = await isAllowed({
        tenantId,
        roles: ['admin'],
        resourceExtra: {
          accountKind: 'service',
          portRole: 'member',
          moderatedBlueprints: ['service'],
        },
        action,
      });
      expect(allowed, action).toBe(false);
    }
  });

  it('a service-account resource with only moderatedBlueprints (no portRole) is denied', async () => {
    const tenantId = randomUUID();
    const allowed = await isAllowed({
      tenantId,
      roles: ['admin'],
      resourceExtra: { accountKind: 'service', moderatedBlueprints: ['service'] },
      action: 'update',
    });
    expect(allowed).toBe(false);
  });

  it('a compliant service account (member role, no moderation) is unaffected', async () => {
    const tenantId = randomUUID();
    for (const resourceExtra of [
      { accountKind: 'service', portRole: 'member', moderatedBlueprints: [] },
      { accountKind: 'service' },
    ]) {
      for (const action of ACTIONS) {
        expect(await isAllowed({ tenantId, roles: ['admin'], resourceExtra, action }), action).toBe(
          true,
        );
      }
    }
  });

  it('an equivalent standard account with the same elevated values is unaffected', async () => {
    const tenantId = randomUUID();
    const elevated = [
      { accountKind: 'standard', portRole: 'admin', moderatedBlueprints: ['service'] },
      { accountKind: 'standard', portRole: 'admin' },
      { accountKind: 'standard', moderatedBlueprints: ['service'] },
      // No accountKind at all: absent means standard (D1).
      { portRole: 'admin', moderatedBlueprints: ['service'] },
    ];
    for (const resourceExtra of elevated) {
      for (const action of ACTIONS) {
        expect(await isAllowed({ tenantId, roles: ['admin'], resourceExtra, action }), action).toBe(
          true,
        );
      }
    }
  });

  it('the same elevated service-account resource is denied for the system actor as the catalog sends it', async () => {
    // The catalog sends the `system` actor (id `user-sync`, see
    // service/user-sync.ts) with the principal roles ['admin'], and the same
    // principal attributes as for any actor.
    const tenantId = randomUUID();
    const base = { tenantId, principalId: 'user-sync', roles: ['admin'] };

    // Control: the system actor is allowed on a resource without the ceiling.
    expect(await isAllowed({ ...base, action: 'update' })).toBe(true);

    for (const resourceExtra of [
      { accountKind: 'service', portRole: 'admin' },
      { accountKind: 'service', portRole: 'member', moderatedBlueprints: ['service'] },
    ]) {
      for (const action of ['create', 'update', 'delete', 'updateStatus']) {
        expect(await isAllowed({ ...base, resourceExtra, action }), action).toBe(false);
      }
    }
  });
});
