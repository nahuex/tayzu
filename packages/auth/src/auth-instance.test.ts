/**
 * Assumed API of `./auth.ts` (task 2.1, design D2):
 *
 * ```ts
 * export interface CreateAuthOptions {
 *   // A `@better-auth/drizzle-adapter`-compatible DB handle. The adapter
 *   // itself never queries it during construction, so a plain stub object
 *   // is enough to build the instance without a live database.
 *   readonly db: unknown;
 *   readonly secret: string;
 * }
 *
 * export function createAuth(options: CreateAuthOptions): { api: Record<string, unknown> };
 * ```
 *
 * `createAuth` builds one `betterAuth` instance registering `organization`,
 * `admin`, `two-factor` (all bundled in `better-auth@1.7.6`), `jwt` (bundled),
 * and `apiKey` (the separate `@better-auth/api-key@1.7.6` package), backed by
 * `drizzleAdapter(options.db, { schemaName: 'auth' })`
 * (`openspec/changes/002-auth-and-rbac/design.md` D2).
 *
 * D2 also requires that neither the `organization` plugin's `teams`
 * sub-option nor its `dynamicAccessControl` sub-option is turned on: Better
 * Auth only registers `auth.api.createTeam`/`auth.api.createOrgRole` (and
 * their siblings) when those sub-options are explicitly enabled, so their
 * absence from `auth.api` is exactly how "left unconfigured (off)" is
 * observable from the outside, without reading `createAuth`'s internal
 * options object.
 *
 * This is a pure unit test: `betterAuth`'s own construction (`getEndpoints`)
 * builds `auth.api` synchronously from the plugin list and never awaits a
 * database round trip, so no `DATABASE_URL` is needed here.
 */
import { describe, expect, it } from 'vitest';

import { createAuth } from './auth.js';

// A `@better-auth/drizzle-adapter` `DB` handle is typed as `{[key: string]: any}`
// (it is never queried while `betterAuth(...)` builds `auth.api`), so an empty
// object stands in for a real Drizzle database in this unit test.
const stubDb: Record<string, unknown> = {};

const TEST_SECRET = 'unit-test-only-secret-not-used-for-anything-real';

function buildAuthApi(): Record<string, unknown> {
  const auth = createAuth({ db: stubDb, secret: TEST_SECRET });
  return auth.api as Record<string, unknown>;
}

describe('createAuth', () => {
  it('registers the organization plugin', () => {
    const api = buildAuthApi();

    expect(api['createOrganization']).toBeTypeOf('function');
    expect(api['setActiveOrganization']).toBeTypeOf('function');
  });

  it('registers the admin plugin', () => {
    const api = buildAuthApi();

    expect(api['banUser']).toBeTypeOf('function');
    expect(api['setRole']).toBeTypeOf('function');
  });

  it('registers the two-factor plugin', () => {
    const api = buildAuthApi();

    expect(api['enableTwoFactor']).toBeTypeOf('function');
    expect(api['verifyTOTP']).toBeTypeOf('function');
  });

  it('registers the apiKey plugin', () => {
    const api = buildAuthApi();

    expect(api['createApiKey']).toBeTypeOf('function');
    expect(api['verifyApiKey']).toBeTypeOf('function');
  });

  it('registers the jwt plugin', () => {
    const api = buildAuthApi();

    expect(api['getToken']).toBeTypeOf('function');
    expect(api['getJwks']).toBeTypeOf('function');
  });

  it('registers no dynamic-access-control handler', () => {
    const api = buildAuthApi();

    // `organization`'s `dynamicAccessControl` sub-option is off (design D2):
    // Better Auth only adds `createOrgRole` and its siblings when it is on.
    expect(api['createOrgRole']).toBeUndefined();
    expect(api['deleteOrgRole']).toBeUndefined();
    expect(api['listOrgRoles']).toBeUndefined();
  });

  it('registers no teams handler', () => {
    const api = buildAuthApi();

    // `organization`'s `teams` sub-option is off (design D2): Better Auth
    // only adds `createTeam` and its siblings when it is on. `_team` is a
    // catalog system blueprint instead (design D9).
    expect(api['createTeam']).toBeUndefined();
    expect(api['listOrganizationTeams']).toBeUndefined();
    expect(api['removeTeam']).toBeUndefined();
  });
});
