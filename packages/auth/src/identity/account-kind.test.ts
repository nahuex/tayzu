import { describe, expect, it } from 'vitest';

import { resolveAccountKind } from './account-kind.js';

/**
 * `043` task 2.3 (design D1): a blueprint `default` applies on write only, so an
 * existing `_user` row does not read back `accountKind: "standard"`. Every reader
 * treats an absent value as `standard`.
 */

/** The structural shape of a `_user` entity as the readers see it. */
function userEntity(properties: Record<string, unknown>): {
  spec: { properties: Record<string, unknown> };
} {
  return { spec: { properties } };
}

describe('resolveAccountKind', () => {
  it('a `_user` read without the accountKind property resolves to standard', () => {
    const entity = userEntity({ email: 'ada@example.com', status: 'Active' });

    expect(entity.spec.properties).not.toHaveProperty('accountKind');
    expect(resolveAccountKind(entity)).toBe('standard');
  });

  it('a `_user` whose accountKind is explicitly undefined resolves to standard', () => {
    const entity = userEntity({ status: 'Active', accountKind: undefined });

    expect(resolveAccountKind(entity)).toBe('standard');
  });

  it('a `_user` with accountKind standard resolves to standard', () => {
    const entity = userEntity({ status: 'Active', accountKind: 'standard' });

    expect(resolveAccountKind(entity)).toBe('standard');
  });

  it('a `_user` with accountKind service resolves to service', () => {
    const entity = userEntity({ status: 'Active', accountKind: 'service' });

    expect(resolveAccountKind(entity)).toBe('service');
  });

  it('does not mutate the entity it reads', () => {
    const entity = userEntity({ status: 'Active' });

    resolveAccountKind(entity);

    expect(entity.spec.properties).not.toHaveProperty('accountKind');
  });
});
