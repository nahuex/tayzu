import { describe, expect, it, vi } from 'vitest';

import type { CerbosClient } from './client.js';
import { redactUnreadable } from './redaction.js';

// Pure unit test against a mocked Cerbos client (no Cerbos, no database).
// Spec: catalog-core deltas "Incompatible entities the caller cannot read are
// redacted" and "Delete-blocking referrers the caller cannot read are redacted
// to a count"; design D12 (batch CheckResources(read), then a "+N not visible"
// count).
const TENANT_ID = 'tenant-1';

function mockClient(readable: ReadonlySet<string>) {
  const checkResources = vi.fn((request: { resources: { resource: { id: string } }[] }) =>
    Promise.resolve({
      cerbosCallId: 'call-1',
      results: request.resources.map(({ resource }) => ({
        resource: { id: resource.id },
        isAllowed: (action: string) => action === 'view' && readable.has(resource.id),
      })),
    }),
  );
  return { client: { checkResources } as unknown as CerbosClient, checkResources };
}

describe('redactUnreadable', () => {
  it('N identifiers become a count when unreadable', async () => {
    // GIVEN 5 candidate identifiers, of which 2 are readable by the caller
    // and 3 belong to a team the caller cannot read
    const { client, checkResources } = mockClient(new Set(['payments', 'ledger']));
    const candidates = ['payments', 'hidden-1', 'ledger', 'hidden-2', 'hidden-3'].map((id) => ({
      id,
      attributes: { ownerTeam: id.startsWith('hidden') ? 'team-x' : 'team-a' },
    }));

    // WHEN the candidate list is redacted for that caller
    const result = await redactUnreadable({
      authz: client,
      tenantId: TENANT_ID,
      actor: { id: 'user-1' },
      principal: { roles: ['member'], teams: ['team-a'], moderatedBlueprints: [] },
      kind: 'catalog_entity',
      candidates,
    });

    // THEN the 2 readable identifiers are named, in their original order...
    expect(result.readable).toEqual(['payments', 'ledger']);
    // ...and the 3 unreadable ones are reported only as a count
    expect(result.notVisible).toBe(3);
    expect(JSON.stringify(result)).not.toContain('hidden');

    // AND one single batch CheckResources(read) covered every candidate
    expect(checkResources).toHaveBeenCalledTimes(1);
    const request = checkResources.mock.calls[0]?.[0] as {
      principal: { attr: Record<string, unknown> };
      resources: {
        resource: { kind: string; id: string; attr: Record<string, unknown> };
        actions: string[];
      }[];
    };
    expect(request.resources.map((entry) => entry.resource.id)).toEqual(
      candidates.map((candidate) => candidate.id),
    );
    for (const entry of request.resources) {
      expect(entry.actions).toEqual(['view']);
      expect(entry.resource.kind).toBe('catalog_entity');
      expect(Object.keys(entry.resource.attr)[0]).toBe('tenantId');
      expect(entry.resource.attr['tenantId']).toBe(TENANT_ID);
    }
    expect(request.principal.attr['tenantId']).toBe(TENANT_ID);
  });
});
