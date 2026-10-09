// @ts-check

/**
 * Identity adapter restrictions (043 task 5.1c, design D14, Resolved decision Q69).
 *
 * Direct adapter access to the `apikey`, `invitation`, `member`, `session`, `user`
 * and `account` models goes only through `apps/api/src/identity/auth-repository.ts`.
 * The selectors and import restrictions live in one module because a later
 * flat-config block replaces the earlier setting of the same rule: this module
 * merges them per file set (later identity tasks add their restrictions here).
 */

const MODELS = ['apikey', 'invitation', 'member', 'session', 'user', 'account'];
const MODEL_PATTERN = `/^(${MODELS.join('|')})$/`;

const ADAPTER_MESSAGE =
  'Direct adapter access to the apikey, invitation, member, session, user and account models is banned here. Use apps/api/src/identity/auth-repository.ts (043 Q69).';
const ACCOUNT_READ_MESSAGE =
  'The internal adapter findAccount… reads are banned here. Use globalAccountByKey and globalAccountsOf from apps/api/src/identity/auth-repository.ts (043 Q69).';
const FACTORY_MESSAGE =
  'Importing the adapter factory is banned here. Adapter access goes through apps/api/src/identity/auth-repository.ts (043 Q69).';

/** `no-restricted-syntax` entries added on top of the global ones. */
export const identitySyntaxRestrictions = [
  {
    selector: `CallExpression[callee.type='MemberExpression'] > ObjectExpression.arguments > Property[key.name='model'][value.value=${MODEL_PATTERN}]`,
    message: ADAPTER_MESSAGE,
  },
  {
    selector: `CallExpression[callee.type='MemberExpression'] > ObjectExpression.arguments > Property[key.value='model'][value.value=${MODEL_PATTERN}]`,
    message: ADAPTER_MESSAGE,
  },
  {
    selector: 'CallExpression[callee.property.name=/^findAccount/]',
    message: ACCOUNT_READ_MESSAGE,
  },
];

/** `no-restricted-imports` options for the same files. */
export const identityImportRestrictions = {
  paths: [
    { name: '@better-auth/drizzle-adapter', message: FACTORY_MESSAGE },
    { name: 'better-auth/adapters/drizzle', message: FACTORY_MESSAGE },
  ],
};

/** Scoped files, and the one file that may touch the adapter. */
export const IDENTITY_FILES = ['apps/api/src/identity/**/*.ts', 'apps/api/src/identity-router.ts'];
export const IDENTITY_REPOSITORY_FILES = ['apps/api/src/identity/auth-repository.ts'];
