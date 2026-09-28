/**
 * Assumed API of `./reserved.js` (task 3.6):
 *
 * ```ts
 * export type ReservedOperationKind = 'blueprint_write' | 'entity_write' | 'read';
 *
 * function assertReservedAccess(
 *   blueprintIdentifier: string,
 *   operation: ReservedOperationKind,
 *   actor: { type: ActorType; id: string },
 * ): void;
 * ```
 *
 * A pure function of the blueprint identifier, the kind of operation, and
 * the actor (spec, "Reserved system identifiers"; design D3). Blueprint
 * identifiers starting with `_` are reserved for platform-defined
 * blueprints. `assertReservedAccess` throws
 * `CatalogError('CATALOG_RESERVED_IDENTIFIER', ...)` exactly when all three
 * hold:
 * - `blueprintIdentifier` starts with `_`;
 * - `operation` is `'blueprint_write'` or `'entity_write'` (never
 *   `'read'`);
 * - `actor.type` is not `'system'`.
 *
 * It never throws for a `'read'` operation, regardless of the blueprint
 * identifier or the actor. It never throws for a non-reserved identifier
 * (any operation, any actor). It returns `undefined` when access is
 * allowed. `actor.type` is read only through this module (design D3: the
 * reserved rule is one of the two allowlisted places where `actor.type` may
 * be compared).
 */
import { describe, expect, it } from 'vitest';
import { assertReservedAccess, type ReservedOperationKind } from './reserved.js';
import { isCatalogError } from './errors.js';
import type { ActorType } from './context.js';

const RESERVED_IDENTIFIER = '_workflow';
const NON_RESERVED_IDENTIFIER = 'service';

const NON_SYSTEM_ACTOR_TYPES: readonly ActorType[] = ['user', 'agent', 'integration'];
const ALL_ACTOR_TYPES: readonly ActorType[] = ['user', 'agent', 'integration', 'system'];
const WRITE_OPERATIONS: readonly ReservedOperationKind[] = ['blueprint_write', 'entity_write'];

function actor(type: ActorType): { type: ActorType; id: string } {
  return { type, id: 'actor-1' };
}

function expectReservedRejected(
  operation: ReservedOperationKind,
  actorType: ActorType,
  identifier: string = RESERVED_IDENTIFIER,
): void {
  try {
    assertReservedAccess(identifier, operation, actor(actorType));
    expect.unreachable('assertReservedAccess should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_RESERVED_IDENTIFIER');
  }
}

describe('"Tenant cannot create a reserved blueprint"', () => {
  it('rejects a user actor creating blueprint "_workflow"', () => {
    expectReservedRejected('blueprint_write', 'user');
  });
});

describe('"Tenant cannot write entities of a reserved blueprint"', () => {
  it('rejects an agent actor upserting an entity of "_workflow"', () => {
    expectReservedRejected('entity_write', 'agent');
  });
});

describe('"System actor can create a reserved blueprint"', () => {
  it('does not throw for a system actor creating blueprint "_workflow"', () => {
    expect(() =>
      assertReservedAccess(RESERVED_IDENTIFIER, 'blueprint_write', actor('system')),
    ).not.toThrow();
  });
});

describe('every non-system actor is rejected for every write on a reserved blueprint', () => {
  for (const operation of WRITE_OPERATIONS) {
    for (const actorType of NON_SYSTEM_ACTOR_TYPES) {
      it(`rejects actor "${actorType}" on operation "${operation}"`, () => {
        expectReservedRejected(operation, actorType);
      });
    }
  }
});

describe('the system actor is allowed for every write on a reserved blueprint', () => {
  for (const operation of WRITE_OPERATIONS) {
    it(`does not throw for operation "${operation}"`, () => {
      expect(() =>
        assertReservedAccess(RESERVED_IDENTIFIER, operation, actor('system')),
      ).not.toThrow();
    });
  }
});

describe('reads on a reserved blueprint are always allowed', () => {
  for (const actorType of ALL_ACTOR_TYPES) {
    it(`does not throw for actor "${actorType}"`, () => {
      expect(() =>
        assertReservedAccess(RESERVED_IDENTIFIER, 'read', actor(actorType)),
      ).not.toThrow();
    });
  }
});

describe('a non-reserved blueprint is never restricted', () => {
  const operations: readonly ReservedOperationKind[] = [...WRITE_OPERATIONS, 'read'];

  for (const operation of operations) {
    for (const actorType of ALL_ACTOR_TYPES) {
      it(`does not throw for operation "${operation}" and actor "${actorType}"`, () => {
        expect(() =>
          assertReservedAccess(NON_RESERVED_IDENTIFIER, operation, actor(actorType)),
        ).not.toThrow();
      });
    }
  }
});
