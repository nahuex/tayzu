/**
 * Assumed API of `./apply-write.js` (task 4.4):
 *
 * ```ts
 * export type WriteMode = 'replace' | 'merge';
 *
 * export interface EntitySpec {
 *   properties: Record<string, unknown>;
 *   relations: Record<string, unknown>;
 * }
 *
 * export interface EntitySpecWriteInput {
 *   properties?: Record<string, unknown | null>;
 *   relations?: Record<string, unknown | null>;
 * }
 *
 * function applyWrite(
 *   current: EntitySpec | undefined,
 *   input: EntitySpecWriteInput,
 *   mode: WriteMode,
 * ): EntitySpec;
 * ```
 *
 * Computes the next `spec` (design D9: "a pure `applyWrite(current, input,
 * mode)` function"), independently for `properties` and `relations`.
 * `current` defaults to `{ properties: {}, relations: {} }` (entity
 * creation: both modes then behave the same way).
 *
 * - `mode: 'replace'` ("upsert in `replace` mode ... replaces its whole
 *   ... `spec`"): the result for each bag is built from `input` alone,
 *   ignoring `current` entirely. A key given as `null` is treated as
 *   absent. A key of `current` that `input` does not mention is dropped
 *   ("`replace` drops keys that are not given").
 * - `mode: 'merge'` ("upsert in `merge` mode ... shallow-merges the given
 *   `spec.properties` and `spec.relations` keys into the existing spec"):
 *   the result for each bag starts as a shallow copy of `current`'s bag,
 *   and is then overlaid, key by key, with `input`'s bag. A key explicitly
 *   set to `null` in `input` removes that key from the result ("A key
 *   explicitly set to `null` removes that property or relation value"). A
 *   key of `current` not mentioned in `input` is kept unchanged ("Merge
 *   keeps unspecified keys").
 * - Never uses `Object.assign` or a `{}` spread target directly (design D9:
 *   "It never uses `Object.assign` or spread onto `{}`"); the returned
 *   object's own keys are exactly the surviving keys, nothing more.
 *
 * `applyWrite` never validates values or checks relation cardinality: that
 * is `./entity-validator.js` and `./relation-values.js`.
 */
import { describe, expect, it } from 'vitest';
import { applyWrite } from './apply-write.js';

describe('"Merge keeps unspecified keys"', () => {
  it('keeps language and updates tier when merging a partial properties bag', () => {
    const current = { properties: { language: 'go', tier: 'gold' }, relations: {} };

    const result = applyWrite(current, { properties: { tier: 'silver' } }, 'merge');

    expect(result.properties).toEqual({ language: 'go', tier: 'silver' });
  });

  it('keeps unspecified relation keys unchanged when merging', () => {
    const current = { properties: {}, relations: { owner: 'team-a', dependsOn: ['ledger'] } };

    const result = applyWrite(current, { relations: { dependsOn: ['ledger', 'auth'] } }, 'merge');

    expect(result.relations).toEqual({ owner: 'team-a', dependsOn: ['ledger', 'auth'] });
  });
});

describe('"Merge with null removes a value"', () => {
  it('removes a property explicitly set to null', () => {
    const current = { properties: { tier: 'gold' }, relations: {} };

    const result = applyWrite(current, { properties: { tier: null } }, 'merge');

    expect(result.properties).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(result.properties, 'tier')).toBe(false);
  });

  it('removes a relation explicitly set to null', () => {
    const current = { properties: {}, relations: { owner: 'team-a' } };

    const result = applyWrite(current, { relations: { owner: null } }, 'merge');

    expect(result.relations).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(result.relations, 'owner')).toBe(false);
  });
});

describe('"replace" drops keys that are not given', () => {
  it('drops an existing property not present in the replace input', () => {
    const current = { properties: { language: 'go', tier: 'gold' }, relations: {} };

    const result = applyWrite(current, { properties: { language: 'rust' } }, 'replace');

    expect(result.properties).toEqual({ language: 'rust' });
    expect(Object.prototype.hasOwnProperty.call(result.properties, 'tier')).toBe(false);
  });

  it('drops an existing relation not present in the replace input', () => {
    const current = { properties: {}, relations: { owner: 'team-a', dependsOn: ['ledger'] } };

    const result = applyWrite(current, { relations: { owner: 'team-b' } }, 'replace');

    expect(result.relations).toEqual({ owner: 'team-b' });
    expect(Object.prototype.hasOwnProperty.call(result.relations, 'dependsOn')).toBe(false);
  });

  it('drops everything when replace is given an empty spec', () => {
    const current = { properties: { language: 'go' }, relations: { owner: 'team-a' } };

    const result = applyWrite(current, {}, 'replace');

    expect(result).toEqual({ properties: {}, relations: {} });
  });

  it('treats an explicit null in replace mode as absent, not as an error', () => {
    const current = { properties: { language: 'go' }, relations: {} };

    const result = applyWrite(current, { properties: { language: null, tier: 'gold' } }, 'replace');

    expect(result.properties).toEqual({ tier: 'gold' });
  });
});

describe('"Upsert creates then replaces" (creation with no current spec)', () => {
  it('applies the input directly when current is undefined, in replace mode', () => {
    const result = applyWrite(
      undefined,
      { properties: { language: 'go', tier: 'gold' } },
      'replace',
    );

    expect(result).toEqual({ properties: { language: 'go', tier: 'gold' }, relations: {} });
  });

  it('applies the input directly when current is undefined, in merge mode', () => {
    const result = applyWrite(undefined, { properties: { language: 'go' } }, 'merge');

    expect(result).toEqual({ properties: { language: 'go' }, relations: {} });
  });

  it('replacing again with a different value drops the previous keys not repeated', () => {
    const created = applyWrite(
      undefined,
      { properties: { language: 'go', tier: 'gold' } },
      'replace',
    );
    const replaced = applyWrite(created, { properties: { language: 'rust' } }, 'replace');

    expect(replaced.properties).toEqual({ language: 'rust' });
  });
});
