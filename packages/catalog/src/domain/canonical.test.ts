/**
 * Assumed API of `./canonical.js` (task 4.5):
 *
 * ```ts
 * function canonicalize(value: unknown): string;
 * function areCanonicallyEqual(a: unknown, b: unknown): boolean;
 * ```
 *
 * Canonical equality for detecting an `unchanged` write (design D9: "compares
 * canonical JSON (sorted keys, relation order preserved) of `title`, `icon`,
 * and `spec`"). `canonicalize` serializes `value` to a JSON string in which
 * every plain object's keys are sorted (recursively, at every depth),
 * regardless of their original insertion order; array elements (in
 * particular a `many` relation's target list) are serialized in their given
 * order, which is significant. `areCanonicallyEqual(a, b)` is
 * `canonicalize(a) === canonicalize(b)`. Neither function mutates its input
 * or performs any I/O.
 */
import { describe, expect, it } from 'vitest';
import { areCanonicallyEqual, canonicalize } from './canonical.js';

describe('key order is irrelevant', () => {
  it('produces the same canonical form for two top-level key orderings', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('treats two differently-ordered objects as canonically equal', () => {
    expect(areCanonicallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('sorts keys recursively at every nesting depth', () => {
    const a = { spec: { properties: { language: 'go', tier: 'gold' }, relations: {} } };
    const b = { spec: { relations: {}, properties: { tier: 'gold', language: 'go' } } };

    expect(areCanonicallyEqual(a, b)).toBe(true);
  });
});

describe('"many" relation order is significant', () => {
  it('treats two different target orderings as canonically unequal', () => {
    const a = { relations: { dependsOn: ['ledger', 'auth'] } };
    const b = { relations: { dependsOn: ['auth', 'ledger'] } };

    expect(areCanonicallyEqual(a, b)).toBe(false);
  });

  it('treats the same target order as canonically equal', () => {
    const a = { relations: { dependsOn: ['ledger', 'auth'] } };
    const b = { relations: { dependsOn: ['ledger', 'auth'] } };

    expect(areCanonicallyEqual(a, b)).toBe(true);
  });
});

describe('detecting an unchanged entity write (title, icon, spec triple)', () => {
  it('treats a reordered but value-identical triple as unchanged', () => {
    const before = {
      title: 'Payments',
      icon: 'server',
      spec: { properties: { language: 'go', tier: 'gold' }, relations: { owner: 'team-a' } },
    };
    const after = {
      icon: 'server',
      spec: { relations: { owner: 'team-a' }, properties: { tier: 'gold', language: 'go' } },
      title: 'Payments',
    };

    expect(areCanonicallyEqual(before, after)).toBe(true);
  });

  it('treats a genuinely different spec value as changed', () => {
    const before = {
      title: 'Payments',
      icon: 'server',
      spec: { properties: { language: 'go' }, relations: {} },
    };
    const after = {
      title: 'Payments',
      icon: 'server',
      spec: { properties: { language: 'rust' }, relations: {} },
    };

    expect(areCanonicallyEqual(before, after)).toBe(false);
  });

  it('treats a title change as changed', () => {
    const before = { title: 'Payments', icon: 'server', spec: { properties: {}, relations: {} } };
    const after = {
      title: 'Payments Service',
      icon: 'server',
      spec: { properties: {}, relations: {} },
    };

    expect(areCanonicallyEqual(before, after)).toBe(false);
  });
});
