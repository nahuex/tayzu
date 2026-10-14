/**
 * Task 8.5h (043 Resolved decision Q114; design D4 step 7): the shed revokes a
 * session by deleting the user's `session` rows, which is a revocation only
 * while Better Auth reads no session from anywhere else. So the options
 * `createAuth` builds must set no `secondaryStorage` and must not enable
 * `session.cookieCache`, with or without SSO configured.
 *
 * Pure unit test: no database and no network. Each setting is asserted on its
 * own so that a regression names the setting it breaks.
 */
import { describe, expect, it } from 'vitest';

import { createAuth } from './auth.js';

interface BuiltOptions {
  readonly secondaryStorage?: unknown;
  readonly session?: {
    readonly cookieCache?: { readonly enabled?: boolean } | undefined;
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
])('the session storage createAuth builds (%s)', (_label, withSso) => {
  it('sets no secondaryStorage, so a deleted session row is a revoked session', () => {
    const options = optionsOf(withSso);
    expect(options.secondaryStorage).toBeUndefined();
    expect('secondaryStorage' in options && options.secondaryStorage !== undefined).toBe(false);
  });

  it('does not enable session.cookieCache, so a session is always read from its row', () => {
    const cookieCache = optionsOf(withSso).session?.cookieCache;
    expect(cookieCache?.enabled === true).toBe(false);
  });
});
