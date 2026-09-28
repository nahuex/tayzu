// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Security guard (design D3, SEC06): SQL is always parameterized, so any
 * access to drizzle's `sql.raw` escape hatch is banned.
 */
const SQL_RAW_MESSAGE =
  'sql.raw is banned: it bypasses parameterization. Use the sql template tag with bind parameters.';

const sqlRawRestrictions = [
  {
    selector: "MemberExpression[object.name='sql'][property.name='raw']",
    message: SQL_RAW_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='sql'][property.value='raw']",
    message: SQL_RAW_MESSAGE,
  },
  {
    selector: "MemberExpression[object.property.name='sql'][property.name='raw']",
    message: SQL_RAW_MESSAGE,
  },
  {
    selector: "VariableDeclarator[init.name='sql'] > ObjectPattern > Property[key.name='raw']",
    message: SQL_RAW_MESSAGE,
  },
];

/**
 * Secondary aid for the actor-parity principle (design D3): the actor type is
 * data (attribution, the reserved-identifier rule) and never selects a code
 * path. Comparisons on `<...>actor.type`, `<...>onBehalfOf.type` or
 * `<...>principal.type` are banned outside the two allowlisted files. The real
 * guard is the actor-parity test matrix; this rule can be bypassed (for
 * example by destructuring) and is not relied on.
 */
const ACTOR_TYPE_MESSAGE =
  'Actor type must not select a code path (design D3). Only packages/catalog/src/domain/reserved.ts and packages/catalog/src/service/pipeline.ts may compare it.';

const ACTOR_OBJECT = '/(actor|onBehalfOf|principal)$/i';
const ACTOR_TYPE = `MemberExpression[property.name='type']:matches([object.name=${ACTOR_OBJECT}], [object.property.name=${ACTOR_OBJECT}])`;
const EQUALITY = 'BinaryExpression[operator=/^[!=]==?$/]';
const MEMBERSHIP_CALL = 'CallExpression[callee.property.name=/^(includes|has|indexOf)$/]';

const actorTypeRestrictions = [
  { selector: `${EQUALITY} > ${ACTOR_TYPE}`, message: ACTOR_TYPE_MESSAGE },
  { selector: `${EQUALITY} > ChainExpression > ${ACTOR_TYPE}`, message: ACTOR_TYPE_MESSAGE },
  { selector: `SwitchStatement > ${ACTOR_TYPE}.discriminant`, message: ACTOR_TYPE_MESSAGE },
  {
    selector: `SwitchStatement > ChainExpression.discriminant > ${ACTOR_TYPE}`,
    message: ACTOR_TYPE_MESSAGE,
  },
  { selector: `${MEMBERSHIP_CALL} > ${ACTOR_TYPE}.arguments`, message: ACTOR_TYPE_MESSAGE },
];

/** The only files allowed to branch on the actor type (design D3). */
const ACTOR_TYPE_ALLOWLIST = [
  'packages/catalog/src/domain/reserved.ts',
  'packages/catalog/src/service/pipeline.ts',
];

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '**/.turbo/']),
  {
    files: ['**/*.{js,ts}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-restricted-syntax': ['error', ...sqlRawRestrictions, ...actorTypeRestrictions],
    },
  },
  {
    files: ACTOR_TYPE_ALLOWLIST,
    rules: {
      'no-restricted-syntax': ['error', ...sqlRawRestrictions],
    },
  },
  {
    // Plain JavaScript (this config file) is not part of any tsconfig.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Idioms that are normal in tests but not in production code: an async
    // iterable stub with no `await`, and asserting on a void-returning call
    // (`expect(() => voidFn()).not.toThrow()`).
    files: ['**/*.test.ts', '**/*.int.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // vitest types every asymmetric matcher (`expect.objectContaining`,
    // `expect.any`, ...) as `<T = any>(...) => any`. Nesting one as a
    // property value inside another matcher's argument object (asserting on
    // a nested field, as this file does for `entities.listRelated`'s output)
    // has no real type-safety issue, but reads as an unsafe assignment to
    // typescript-eslint.
    files: ['packages/catalog/src/api/router.int.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
