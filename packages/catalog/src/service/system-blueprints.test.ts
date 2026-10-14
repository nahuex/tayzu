/**
 * Unit tests for task 2.1 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (design D1).
 *
 * ## Production symbols assumed
 *
 * - `./system-blueprints.js` exports `USER_BLUEPRINT: CreateBlueprintInput`
 *   and `buildUserBlueprintInput(): CreateBlueprintInput`, the full input
 *   `blueprints.update` takes (not a patch). It is structurally equal to
 *   `USER_BLUEPRINT` and independent of it (a fresh object per call).
 * - `../index.js` (the package index) re-exports both.
 */
import { describe, expect, it } from 'vitest';

import * as catalogIndex from '../index.js';
import { parseBlueprintDefinition } from '../domain/blueprint-definition.js';
import { buildUserBlueprintInput, USER_BLUEPRINT } from './system-blueprints.js';

describe('`_user` blueprint exports (task 2.1)', () => {
  it('the package index exports USER_BLUEPRINT', () => {
    expect(catalogIndex).toHaveProperty('USER_BLUEPRINT');
    expect((catalogIndex as Record<string, unknown>)['USER_BLUEPRINT']).toEqual(USER_BLUEPRINT);
  });

  it('the package index exports the input builder', () => {
    expect(catalogIndex).toHaveProperty('buildUserBlueprintInput');
    expect(typeof (catalogIndex as Record<string, unknown>)['buildUserBlueprintInput']).toBe(
      'function',
    );
  });

  it('the builder returns the full `_user` input, with accountKind and the four-value status', () => {
    const input = buildUserBlueprintInput();
    expect(input).toEqual(USER_BLUEPRINT);
    expect(input.identifier).toBe('_user');
    const properties = input.schema.properties as Record<
      string,
      { enum?: string[]; default?: unknown }
    >;
    expect(properties['accountKind']?.enum).toEqual(['standard', 'service']);
    expect(properties['accountKind']?.default).toBe('standard');
    expect(properties['status']?.enum).toEqual(['Staged', 'Invited', 'Active', 'Disabled']);
    expect(properties['status']?.default).toBe('Staged');
  });

  it('the built input validates as a blueprint definition', () => {
    expect(() => parseBlueprintDefinition(buildUserBlueprintInput())).not.toThrow();
  });

  it('each call returns a fresh object, so a caller cannot mutate the constant', () => {
    expect(buildUserBlueprintInput()).not.toBe(buildUserBlueprintInput());
  });
});
