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
    // (the mock decides by position: candidates 0 and 2 are the readable ones;
    // resource ids are positions since Q119/Q125, never identifiers)
    const { client, checkResources } = mockClient(new Set(['0', '2']));
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
    // Rewritten (Resolved decisions Q119, Q125; stricter): the request ids are
    // the candidates' positions and no candidate id appears in the request.
    expect(request.resources.map((entry) => entry.resource.id)).toEqual(
      candidates.map((_candidate, position) => String(position)),
    );
    const serializedRequest = JSON.stringify(request);
    for (const candidate of candidates) {
      expect(serializedRequest).not.toContain(candidate.id);
    }
    for (const entry of request.resources) {
      expect(entry.actions).toEqual(['view']);
      expect(entry.resource.kind).toBe('catalog_entity');
      expect(Object.keys(entry.resource.attr)[0]).toBe('tenantId');
      expect(entry.resource.attr['tenantId']).toBe(TENANT_ID);
    }
    expect(request.principal.attr['tenantId']).toBe(TENANT_ID);
  });

  it('a candidate missing from the response still counts as not visible', async () => {
    // GIVEN Cerbos answers only for the first and the third of four candidates
    const checkResources = vi.fn((request: { resources: { resource: { id: string } }[] }) =>
      Promise.resolve({
        cerbosCallId: 'call-2',
        results: request.resources
          .filter((_entry, position) => position === 0 || position === 2)
          .map(({ resource }) => ({
            resource: { id: resource.id },
            isAllowed: (action: string) => action === 'view',
          })),
      }),
    );

    // WHEN the four candidates are redacted
    const result = await redactUnreadable({
      authz: { checkResources } as unknown as CerbosClient,
      tenantId: TENANT_ID,
      actor: { id: 'user-1' },
      principal: { roles: ['member'], teams: [], moderatedBlueprints: [] },
      kind: 'catalog_entity',
      candidates: ['alpha', 'beta', 'gamma', 'delta'].map((id) => ({ id })),
    });

    // THEN only the two answered-and-allowed ones are readable, in order, and the
    // two the response left out count as not visible
    expect(result.readable).toEqual(['alpha', 'gamma']);
    expect(result.notVisible).toBe(2);
  });

  it('sends positions even when an identifier looks like a position', async () => {
    // GIVEN candidates whose identifiers are digit strings in a different order
    const { client, checkResources } = mockClient(new Set(['1']));

    // WHEN they are redacted, only position 1 being readable
    const result = await redactUnreadable({
      authz: client,
      tenantId: TENANT_ID,
      actor: { id: 'user-1' },
      principal: { roles: ['member'], teams: [], moderatedBlueprints: [] },
      kind: 'catalog_entity',
      candidates: [{ id: '1' }, { id: '0' }],
    });

    // THEN the decision maps back by position, not by identifier
    expect(result.readable).toEqual(['0']);
    expect(result.notVisible).toBe(1);
    const request = checkResources.mock.calls[0]?.[0];
    expect(request?.resources.map((entry) => entry.resource.id)).toEqual(['0', '1']);
  });
});
