import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveOwnerTeam } from './ownership-resolution.js';

// Pure unit test (no Cerbos, no database). Spec: auth-and-rbac, requirement
// "Team ownership"; design D9.
describe('effectiveOwnerTeam resolution', () => {
  it('Direct ownership wins over a conflicting inherited configuration', () => {
    // GIVEN a blueprint configured with both Inherited ownership and a direct
    // team relation
    const readInherited = vi.fn(() => 'team-from-inherited-chain');
    const config = {
      directTeamRelation: 'team',
      inheritedChain: ['service', 'team'],
    };
    const entity = { relations: { team: 'team-from-direct-relation' } };

    // WHEN an entity of that blueprint is read
    const result = resolveEffectiveOwnerTeam({ config, entity, readInherited });

    // THEN its owning team is the one from the direct relation...
    expect(result).toEqual({ kind: 'Direct', teamId: 'team-from-direct-relation' });
    // ...and inherited ownership plays no part
    expect(readInherited).not.toHaveBeenCalled();
  });
});
