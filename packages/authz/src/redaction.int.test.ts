import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCerbosClient } from './client.js';
import { redactUnreadable } from './redaction.js';

/**
 * Task 23.4 (design Q34, D12): the redaction helper checks the `view` action,
 * because the real policies define `view`, not `read`. This runs against the
 * real Cerbos policies (no mock), so a helper that asks for `read` gets a
 * deny for everything and names no identifier.
 *
 * Spec: catalog-core "Delete-blocking referrers the caller cannot read are
 * redacted to a count" and "Incompatible entities the caller cannot read are
 * redacted".
 */
const grpcPort = process.env['TAYZU_CERBOS_GRPC_PORT'] ?? '3593';
const authz = createCerbosClient({ address: `localhost:${grpcPort}`, tls: false });

describe('redactUnreadable against the real policies', () => {
  it('a member sees the identifiers they may view and only the unreadable ones are redacted', async () => {
    // GIVEN a caller who belongs to team-a and holds no organization role
    // that grants blanket view, so `view` is allowed only through team
    // ownership (policies/resource_policies/catalog_entity.yaml)
    const tenantId = randomUUID();
    const principal = { roles: ['guest'], teams: ['team-a'], moderatedBlueprints: [] };
    // AND 2 referrers owned by team-a and 3 owned by team-x
    const candidates = [
      { id: 'own-1', attributes: { ownerTeam: 'team-a', blueprintId: 'service' } },
      { id: 'hidden-1', attributes: { ownerTeam: 'team-x', blueprintId: 'service' } },
      { id: 'own-2', attributes: { ownerTeam: 'team-a', blueprintId: 'service' } },
      { id: 'hidden-2', attributes: { ownerTeam: 'team-x', blueprintId: 'service' } },
      { id: 'hidden-3', attributes: { ownerTeam: 'team-x', blueprintId: 'service' } },
    ];

    // WHEN the list is redacted for that caller
    const result = await redactUnreadable({
      authz,
      tenantId,
      actor: { id: randomUUID() },
      principal,
      kind: 'catalog_entity',
      candidates,
    });

    // THEN the identifiers the caller may view are named, in order
    expect(result.readable).toEqual(['own-1', 'own-2']);
    // AND only the unreadable ones are counted, never named
    expect(result.notVisible).toBe(3);
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('a member with blanket view sees every identifier in their tenant', async () => {
    // GIVEN the `member` role, which may view every entity of its tenant
    const tenantId = randomUUID();

    // WHEN a candidate list is redacted for that member
    const result = await redactUnreadable({
      authz,
      tenantId,
      actor: { id: randomUUID() },
      principal: { roles: ['member'], teams: [], moderatedBlueprints: [] },
      kind: 'catalog_entity',
      candidates: [{ id: 'a' }, { id: 'b', attributes: { ownerTeam: 'team-x' } }],
    });

    // THEN both are readable and nothing is redacted
    expect(result.readable).toEqual(['a', 'b']);
    expect(result.notVisible).toBe(0);
  });
});
