import { describe, expect, it } from 'vitest';

import { RESOURCE_KINDS } from './resource-kinds.js';

/** `043` task 5.1 (design D3): the two new Cerbos resource kinds exist. */
describe('RESOURCE_KINDS', () => {
  it('has the service_account kind', () => {
    expect(RESOURCE_KINDS).toHaveProperty('serviceAccount', 'service_account');
  });

  it('has the credential kind', () => {
    expect(RESOURCE_KINDS).toHaveProperty('credential', 'credential');
  });

  it('keeps the four existing kinds', () => {
    expect(RESOURCE_KINDS.catalogBlueprint).toBe('catalog_blueprint');
    expect(RESOURCE_KINDS.catalogEntity).toBe('catalog_entity');
    expect(RESOURCE_KINDS.team).toBe('team');
    expect(RESOURCE_KINDS.user).toBe('user');
  });
});
