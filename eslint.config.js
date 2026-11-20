// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import {
  IDENTITY_FILES,
  IDENTITY_REPOSITORY_FILES,
  IDENTITY_ROUTER_FILES,
  MACHINE_CREDENTIAL_EXEMPT_FILES,
  MACHINE_CREDENTIAL_FILES,
  identityImportRestrictions,
  identityRouterImportRestrictions,
  machineCredentialImportRestrictions,
  identitySyntaxRestrictions,
} from './eslint/identity-restrictions.js';

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

/**
 * The only files allowed to branch on the actor type (design D3), plus
 * `packages/auth/src/step-up.ts` (002-auth-and-rbac design D4): step-up is an
 * explicit, spec-named human-only control layered *alongside* the operation
 * pipeline, not a branch inside it -- "agent/integration/system actors skip
 * this guard entirely (Cerbos already decided whether they may act; step-up
 * is a human-specific control, matching the spec's own restriction)". The
 * actor-parity principle this rule otherwise protects (every actor type runs
 * the same operation pipeline) is untouched: Cerbos's decision for non-`user`
 * actors is unaffected by this guard.
 */
const ACTOR_TYPE_ALLOWLIST = [
  'packages/catalog/src/domain/reserved.ts',
  'packages/catalog/src/service/pipeline.ts',
  'packages/auth/src/step-up.ts',
];

/**
 * Page rules of the web app (003 design D2 and D15, `apps/web/CLAUDE.md`):
 * every server string is rendered as React text, so the raw-HTML sinks,
 * dynamic code evaluation and direct cookie access are banned.
 */
const WEB_HTML_SINK_MESSAGE =
  'Raw HTML sinks are banned in the web app (003 D15): render server strings as React text or through a renderer in src/lib/.';
const WEB_COOKIE_MESSAGE =
  'document.cookie is banned in the web app (003 D15): the session cookie is HttpOnly and owned by the server.';
const WEB_EVAL_MESSAGE =
  'Dynamic code evaluation is banned in the web app (003 D15): the CSP forbids it.';

const webSyntaxRestrictions = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: WEB_HTML_SINK_MESSAGE },
  {
    selector: "MemberExpression[object.name='document'][property.name='cookie']",
    message: WEB_COOKIE_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='document'][property.value='cookie']",
    message: WEB_COOKIE_MESSAGE,
  },
  { selector: "CallExpression[callee.name='eval']", message: WEB_EVAL_MESSAGE },
  { selector: "NewExpression[callee.name='Function']", message: WEB_EVAL_MESSAGE },
  { selector: "CallExpression[callee.name='Function']", message: WEB_EVAL_MESSAGE },
  {
    selector: "MemberExpression[object.name='document'][property.name=/^write(ln)?$/]",
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(inner|outer)HTML$/]',
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    selector: 'AssignmentExpression > MemberExpression.left[property.value=/^(inner|outer)HTML$/]',
    message: WEB_HTML_SINK_MESSAGE,
  },
];

/**
 * The web app imports `@tayzu/catalog/contract` and no other workspace
 * package (003 design D2), so no Node-only module reaches the bundle. A regex
 * is used because a gitignore-style negation cannot re-include a path whose
 * parent (`@tayzu/catalog`) is already excluded.
 */
const webImportRestrictions = {
  patterns: [
    {
      regex: '^@tayzu/(?!catalog/contract$)',
      message:
        'The web app may import only @tayzu/catalog/contract from the workspace (003 D2): never @tayzu/api, @tayzu/auth, @tayzu/db, @tayzu/authz or any other @tayzu/catalog path.',
    },
  ],
};

export default defineConfig(
  // Agent worktrees are full copies of the repository (Claude Code, `.claude/worktrees/`).
  globalIgnores(['**/dist/', '**/coverage/', '**/.turbo/', '.claude/worktrees/']),
  {
    files: ['**/*.{js,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['scripts/ci/*.ts'] },
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
    // 043 5.1c: adapter access only through the auth repository. Spreads the global
    // selectors because a later block replaces the rule's array.
    files: IDENTITY_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sqlRawRestrictions,
        ...actorTypeRestrictions,
        ...identitySyntaxRestrictions,
      ],
      'no-restricted-imports': ['error', identityImportRestrictions],
    },
  },
  {
    // 043 9.1c (Q78): machine-credential functions only from apps/api/src/identity/**.
    files: MACHINE_CREDENTIAL_FILES,
    ignores: MACHINE_CREDENTIAL_EXEMPT_FILES,
    rules: { 'no-restricted-imports': ['error', machineCredentialImportRestrictions] },
  },
  {
    // identity-router.ts matches both the 5.1c and the 9.1c rule: merge, not replace.
    files: IDENTITY_ROUTER_FILES,
    rules: { 'no-restricted-imports': ['error', identityRouterImportRestrictions] },
  },
  {
    files: IDENTITY_REPOSITORY_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...sqlRawRestrictions, ...actorTypeRestrictions],
      'no-restricted-imports': 'off',
    },
  },
  {
    // 003 D2: the web app. Re-spreads the global selectors because this block
    // replaces the rule's array (web code never compares the actor type).
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended, jsxA11y.flatConfigs.strict],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        ...sqlRawRestrictions,
        ...actorTypeRestrictions,
        ...webSyntaxRestrictions,
      ],
      'no-restricted-imports': ['error', webImportRestrictions],
    },
  },
  {
    // Plain JavaScript (this config file) is not part of any tsconfig.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // 003 Q46: the source of `/theme-init.js`, a classic browser script (no
    // `import` or `export`) that runs before the app, with only these globals.
    files: ['apps/web/src/state/theme-init.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { window: 'readonly', document: 'readonly' },
    },
  },
  {
    // Idioms that are normal in tests but not in production code: an async
    // iterable stub with no `await`, and asserting on a void-returning call
    // (`expect(() => voidFn()).not.toThrow()`).
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.int.test.ts'],
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
