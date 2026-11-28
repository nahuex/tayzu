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
 * (`openspec/changes/archive/2026-10-15-002-auth-and-rbac/design.md` D2).
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuth, hashPasswordNfc } from './auth.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

// A `@better-auth/drizzle-adapter` `DB` handle is typed as `{[key: string]: any}`
// (it is never queried while `betterAuth(...)` builds `auth.api`), so an empty
// object stands in for a real Drizzle database in this unit test.
const stubDb: Record<string, unknown> = {};

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

  /**
   * Task 18.1 (design D22, resolved decision Q16; `specs/auth-and-rbac/
   * spec.md`, "Public self sign-up is not available"):
   *
   * "asserts `auth.options.emailAndPassword.disableSignUp === true`,
   * initially failing since the flag is not yet set (green in 18.2)."
   *
   * `createAuth`'s own `AuthInstance` return type (`./auth.ts`, task 2.1)
   * deliberately types both `api` and `$context` as `unknown` for callers to
   * introspect by name -- `options` is the same kind of `betterAuth(...)`
   * return-value property (`Auth<Options>.options`, the installed
   * `better-auth@1.7.6` source, `dist/types/auth.d.mts`) not otherwise
   * exposed on `AuthInstance` yet, so this test narrows it locally, the same
   * "introspect the narrower production type locally" pattern every int test
   * file in this package already uses for `auth.api`/`auth.handler`.
   *
   * ## Why this is expected to fail for the right reason right now
   *
   * `./auth.ts`'s `emailAndPassword` option is `{ enabled: true }` only
   * (confirmed by reading the file before writing this test): no
   * `disableSignUp` key is set at all, so
   * `options.emailAndPassword.disableSignUp` is `undefined`, not `true` --
   * a plain **assertion failure**, not a missing export or a typo: `./auth.js`
   * and `createAuth` already exist and are exercised unchanged by every other
   * test in this file.
   */
  it('disables public self sign-up (design D22)', () => {
    const auth = createAuth({ db: stubDb, secret: TEST_SECRET });
    const options = (
      auth as unknown as {
        readonly options: { readonly emailAndPassword?: { readonly disableSignUp?: boolean } };
      }
    ).options;

    expect(options.emailAndPassword?.disableSignUp).toBe(true);
  });
  /**
   * Task 1.5 (044 design D7, Q13): the one password-hash function (NFC, then
   * `hashPassword`) is exported from `./auth.ts` as `hashPasswordNfc` and is the
   * function `emailAndPassword.password.hash` uses.
   */
  it("the exported hasher's output verifies through the instance's password.verify, and NFC and non-NFC spellings of one password verify each other", async () => {
    const auth = createAuth({ db: stubDb, secret: TEST_SECRET });
    const context = (await (auth as unknown as { readonly $context: Promise<unknown> })
      .$context) as {
      readonly password: {
        readonly verify: (data: { hash: string; password: string }) => Promise<boolean>;
      };
    };
    const nfc = 'caf\u00e9-correct-horse-battery-staple';
    const nfd = 'cafe\u0301-correct-horse-battery-staple';
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize('NFC')).toBe(nfc);

    const hashOfNfc = await hashPasswordNfc(nfc);
    const hashOfNfd = await hashPasswordNfc(nfd);

    expect(await context.password.verify({ hash: hashOfNfc, password: nfc })).toBe(true);
    expect(await context.password.verify({ hash: hashOfNfd, password: nfd })).toBe(true);
    expect(await context.password.verify({ hash: hashOfNfc, password: nfd })).toBe(true);
    expect(await context.password.verify({ hash: hashOfNfd, password: nfc })).toBe(true);
    expect(await context.password.verify({ hash: hashOfNfc, password: `${nfc}x` })).toBe(false);
  });
});

/**
 * Task 4.2 (048 design D4, Q9; `specs/auth-and-rbac/spec.md`, "An ambient
 * variable cannot change the keys"):
 *
 * > GIVEN the platform's configured list holds version `1` only
 * > WHEN the process environment also carries another versioned list or the
 * > retired single secret
 * > THEN the authentication instance uses exactly the configured keys
 *
 * D4: "`createAuth` takes `secrets` and passes both `secrets: [...secrets]`
 * and `secret: secrets[0].value` to `betterAuth`." Better Auth `1.7.7`
 * (`dist/context/create-context.mjs`) builds its keys from
 * `options.secrets ?? parseSecretsEnv(env.BETTER_AUTH_SECRETS)` and its legacy
 * key from `options.secret || env.BETTER_AUTH_SECRET || ...`, where `env` reads
 * `process.env` lazily; `secretConfig` is then
 * `{ keys: Map<number, string>; currentVersion: number; legacySecret?: string }`
 * (`@better-auth/core` `dist/types/secret.d.mts`). So the configured list must
 * be the whole key map, version `1` the current version, and the configured
 * current value the legacy key, whatever the environment carries.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `createAuth` reads only `options.secret` and passes no `secrets` to
 * `betterAuth`, so the instance takes its keys and legacy key from the ambient
 * variables set below: an assertion failure, not a missing module.
 */
describe('createAuth authentication secrets (048 D4)', () => {
  const configuredSecrets = [{ version: 1, value: TEST_SECRET }] as const;
  // Ambient values that differ from the configured one: a list with an extra
  // version and a different value for version 1, and the retired single secret.
  const ambientSecretsList =
    '2:ambient-only-version-two-not-configured-0123456789,' +
    '1:ambient-only-version-one-not-configured-0123456789';
  const ambientSingleSecret = 'ambient-only-retired-single-secret-not-configured-0123456789';

  const ambientNames = ['BETTER_AUTH_SECRETS', 'BETTER_AUTH_SECRET'] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ambientNames) {
      saved.set(name, process.env[name]);
    }
  });

  afterEach(() => {
    for (const name of ambientNames) {
      const previous = saved.get(name);
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    }
    saved.clear();
  });

  it('An ambient variable cannot change the keys', async () => {
    // GIVEN the platform's configured list holds version 1 only.
    // WHEN the process environment also carries another versioned list and
    // the retired single secret.
    process.env['BETTER_AUTH_SECRETS'] = ambientSecretsList;
    process.env['BETTER_AUTH_SECRET'] = ambientSingleSecret;

    const auth = createAuth({ db: stubDb, secrets: configuredSecrets });
    const context = (await (auth as unknown as { readonly $context: Promise<unknown> })
      .$context) as {
      readonly secretConfig:
        | string
        | {
            readonly keys: Map<number, string>;
            readonly currentVersion: number;
            readonly legacySecret?: string;
          };
    };

    // THEN the authentication instance uses exactly the configured keys.
    const { secretConfig } = context;
    expect(typeof secretConfig).toBe('object');
    if (typeof secretConfig === 'string') {
      return;
    }
    expect([...secretConfig.keys.entries()]).toEqual([[1, TEST_SECRET]]);
    expect(secretConfig.currentVersion).toBe(1);
    expect(secretConfig.legacySecret).toBe(TEST_SECRET);
  });
});
