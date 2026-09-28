/**
 * Task 6.1 (openspec/changes/001-catalog-core/tasks.md), first half: the
 * cross-capability OTel attribute keys, defined once so every capability
 * (001's catalog, and 002/004/008 later) shares one vocabulary (design.md,
 * "Observability contract" -> "Shared attribute keys"; R15).
 *
 * ## Module under test and assumed API
 *
 * `./semconv.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, the minimum the design's "Shared attribute keys"
 * paragraph needs:
 *
 * ```ts
 * export const sharedAttributeKeys = {
 *   tenantId: 'tayzu.tenant.id',
 *   actorType: 'tayzu.actor.type',
 *   actorId: 'tayzu.actor.id',
 *   actorOnBehalfOfType: 'tayzu.actor.on_behalf_of.type',
 *   actorOnBehalfOfId: 'tayzu.actor.on_behalf_of.id',
 * } as const;
 *
 * export type SharedAttributeKey = (typeof sharedAttributeKeys)[keyof typeof sharedAttributeKeys];
 * ```
 *
 * `@tayzu/catalog/src/telemetry/contract.ts` imports `sharedAttributeKeys`
 * from `@tayzu/observability` (this package's entry point) and defines only
 * the `tayzu.catalog.*` keys on top of it (see `contract.test.ts`, which
 * checks that the tenant key value the catalog contract uses is exactly the
 * one this module exports).
 */
import { describe, expect, it } from 'vitest';

import { sharedAttributeKeys } from './semconv.js';

describe('sharedAttributeKeys (design.md, "Shared attribute keys"; R15)', () => {
  it('defines exactly the five cross-capability keys the design lists, with their exact dot-separated names', () => {
    expect(sharedAttributeKeys).toEqual({
      tenantId: 'tayzu.tenant.id',
      actorType: 'tayzu.actor.type',
      actorId: 'tayzu.actor.id',
      actorOnBehalfOfType: 'tayzu.actor.on_behalf_of.type',
      actorOnBehalfOfId: 'tayzu.actor.on_behalf_of.id',
    });
  });

  it('exposes no key beyond the five the design names (exhaustive list)', () => {
    expect(Object.keys(sharedAttributeKeys).sort()).toEqual(
      ['tenantId', 'actorType', 'actorId', 'actorOnBehalfOfType', 'actorOnBehalfOfId'].sort(),
    );
  });

  it('every key value is lowercase, dot-separated and namespaced under tayzu. (design.md, "Naming")', () => {
    const values: readonly string[] = Object.values(sharedAttributeKeys);
    for (const value of values) {
      expect(value).toMatch(/^tayzu\.[a-z0-9_.]+$/);
      expect(value).toBe(value.toLowerCase());
    }
  });
});
