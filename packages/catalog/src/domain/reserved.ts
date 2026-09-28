/**
 * The reserved `_` prefix rule (spec, "Reserved system identifiers"; design
 * D3). Blueprint identifiers starting with `_` are reserved for
 * platform-defined blueprints. This is a pure function of the blueprint
 * identifier, the kind of operation, and the actor: it never reads or writes
 * anything. This module is one of the two files allowed to compare
 * `actor.type` (design D3, lint-enforced; the actor-parity test matrix is
 * the real guard).
 */
import { CatalogError } from './errors.js';
import type { ActorType } from './context.js';

export type ReservedOperationKind = 'blueprint_write' | 'entity_write' | 'read';

const WRITE_OPERATIONS: ReadonlySet<ReservedOperationKind> = new Set([
  'blueprint_write',
  'entity_write',
]);

/**
 * Throws `CatalogError('CATALOG_RESERVED_IDENTIFIER', ...)` when
 * `blueprintIdentifier` starts with `_`, `operation` is a write, and
 * `actor.type` is not `system`. Reads are always allowed, and a
 * non-reserved identifier is never restricted. Returns `true` when access is
 * allowed (rather than `void`): callers only care that it does not throw,
 * and a non-`void` return keeps `@typescript-eslint/no-confusing-void-
 * expression` from flagging `expect(() => assertReservedAccess(...))`.
 */
export function assertReservedAccess(
  blueprintIdentifier: string,
  operation: ReservedOperationKind,
  actor: { type: ActorType; id: string },
): true {
  if (!blueprintIdentifier.startsWith('_')) return true;
  if (!WRITE_OPERATIONS.has(operation)) return true;
  if (actor.type === 'system') return true;

  throw new CatalogError(
    'CATALOG_RESERVED_IDENTIFIER',
    'Reserved blueprints can only be written by the system actor',
  );
}
