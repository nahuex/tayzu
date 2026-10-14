/**
 * Task 8.5g (043 Resolved decisions Q87 and Q115; spec "An SSO link that its
 * user did not make does not survive into a second tenant", scenario "A link to
 * a provider account with another email is refused"): the account-linking
 * configuration that makes the provenance marker sound is pinned on the options
 * `createAuth` builds.
 *
 * The marker is written for every account created on the callback route, so
 * that is a link the user made only while:
 * - `account.accountLinking.disableImplicitLinking` is `true` (a sign-in never
 *   links an account by its email),
 * - `account.accountLinking.trustedProviders` is not set (no provider is trusted
 *   to link by email),
 * - `account.accountLinking.allowDifferentEmails` is not set (a link to a
 *   provider account with another email is refused), and
 * - `account.updateAccountOnSignIn` is not `false` (the account update that the
 *   callback check of 8.5k depends on runs).
 *
 * Pure unit test: no database and no network. Each setting is asserted on its
 * own so that a regression names the setting it breaks.
 */
import { describe, expect, it } from 'vitest';

import { createAuth } from './auth.js';

interface BuiltOptions {
  readonly account?: {
    readonly updateAccountOnSignIn?: boolean;
    readonly accountLinking?: {
      readonly disableImplicitLinking?: boolean;
      readonly trustedProviders?: readonly string[];
      readonly allowDifferentEmails?: boolean;
    };
  };
}

const SSO = {
  discoveryUrl: 'http://127.0.0.1:1/.well-known/openid-configuration',
  clientId: 'tayzu-test-client',
  clientSecret: 'unit-test-only-client-secret',
} as const;

function optionsOf(withSso: boolean): BuiltOptions {
  const auth = createAuth({
    db: {},
    secret: 'unit-test-only-secret-not-real',
    ...(withSso ? { sso: SSO } : {}),
  });
  return (auth as unknown as { options: BuiltOptions }).options;
}

describe.each([
  ['without SSO', false],
  ['with SSO', true],
])('the account-linking configuration createAuth builds (%s)', (_label, withSso) => {
  it('disables implicit linking', () => {
    expect(optionsOf(withSso).account?.accountLinking?.disableImplicitLinking).toBe(true);
  });

  it('sets no trustedProviders, not even an empty list', () => {
    expect(optionsOf(withSso).account?.accountLinking?.trustedProviders).toBeUndefined();
  });

  it('leaves allowDifferentEmails unset', () => {
    const linking = optionsOf(withSso).account?.accountLinking;
    expect(linking?.allowDifferentEmails).toBeUndefined();
    expect(linking !== undefined && 'allowDifferentEmails' in linking).toBe(false);
  });

  it('does not set updateAccountOnSignIn to false', () => {
    expect(optionsOf(withSso).account?.updateAccountOnSignIn).not.toBe(false);
  });
});
