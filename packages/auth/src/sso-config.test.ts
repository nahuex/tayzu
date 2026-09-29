/**
 * Task 19.2 (design D23, resolved decisions Q17-Q18): the `genericOAuth`
 * plugin's Visma Connect provider options match D23's table, and no
 * `accountSubject` resolver is configured (Better Auth's own discovery-default
 * `sub` resolution is relied on, not reimplemented).
 *
 * ## Assumed production API
 *
 * ```ts
 * // ./sso/visma-connect.ts
 * export interface VismaConnectOptions {
 *   readonly discoveryUrl: string; // the task-19.1 stub in tests
 *   readonly clientId: string;     // host-resolved from the environment
 *   readonly clientSecret: string;
 * }
 * export function vismaConnect(options: VismaConnectOptions): ReturnType<typeof genericOAuth>;
 *
 * // ./auth.ts
 * CreateAuthOptions.sso?: VismaConnectOptions; // when set, registers vismaConnect(sso)
 * ```
 *
 * `genericOAuth(options)` returns a plugin whose `id` is `"generic-oauth"` and
 * whose `options` property is the verbatim `{ config: [...] }` it was given
 * (installed `better-auth@1.7.6`, `plugins/generic-oauth/index.mjs`), so the
 * "registered provider's options" are read back from there, both directly and
 * through `createAuth(...)`'s own `betterAuth` instance.
 *
 * Pure unit test: no database, no network (the stub is not even started; the
 * discovery URL is only stored, never fetched, at construction).
 */
import { describe, expect, it } from 'vitest';

import { createAuth } from './auth.js';
import { vismaConnect } from './sso/visma-connect.js';

const SSO = {
  discoveryUrl: 'http://127.0.0.1:1/.well-known/openid-configuration',
  clientId: 'tayzu-test-client',
  clientSecret: 'unit-test-only-client-secret',
} as const;

interface ProviderConfig {
  readonly providerId?: string;
  readonly discoveryUrl?: string;
  readonly requireIdTokenVerification?: boolean;
  readonly pkce?: boolean;
  readonly responseMode?: string;
  readonly scopes?: readonly string[];
  readonly disableImplicitSignUp?: boolean;
  readonly disableSignUp?: boolean;
  readonly overrideUserInfo?: boolean;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly accountSubject?: unknown;
  readonly disableIdTokenNonceBinding?: boolean;
}

interface PluginLike {
  readonly id: string;
  readonly options?: { readonly config?: readonly ProviderConfig[] };
}

function providerFromPlugin(plugin: unknown): ProviderConfig {
  const configs = (plugin as PluginLike).options?.config ?? [];
  expect(configs).toHaveLength(1);
  return configs[0] as ProviderConfig;
}

function providerFromAuth(): ProviderConfig {
  const auth = createAuth({ db: {}, secret: 'unit-test-only-secret-not-real', sso: SSO });
  const plugins = (auth as unknown as { options: { plugins: readonly PluginLike[] } }).options
    .plugins;
  const plugin = plugins.find((p) => p.id === 'generic-oauth');
  expect(plugin).toBeDefined();
  return providerFromPlugin(plugin);
}

function expectD23Table(provider: ProviderConfig): void {
  expect(provider.providerId).toBe('visma-connect');
  expect(provider.discoveryUrl).toBe(SSO.discoveryUrl);
  expect(provider.requireIdTokenVerification).toBe(true);
  expect(provider.pkce).toBe(true);
  expect(provider.responseMode).toBe('form_post');
  expect(provider.scopes).toEqual(['openid', 'email', 'profile']);
  expect(provider.disableImplicitSignUp).toBe(true);
  expect(provider.disableSignUp).toBe(true);
  // `overrideUserInfo` is `false` (default, left off): D24 forbids Better
  // Auth overwriting the core `user.email` automatically.
  expect(provider.overrideUserInfo ?? false).toBe(false);
  expect(provider.clientId).toBe(SSO.clientId);
  expect(provider.clientSecret).toBe(SSO.clientSecret);
  // D23: nonce binding stays on (Better Auth's default).
  expect(provider.disableIdTokenNonceBinding ?? false).toBe(false);
  // D23: no custom `accountSubject`; Better Auth's own `sub` default is used.
  expect(provider.accountSubject).toBeUndefined();
  expect('accountSubject' in provider).toBe(false);
}

describe('Visma Connect genericOAuth provider (design D23)', () => {
  it('vismaConnect() registers one provider whose options match the D23 table', () => {
    const plugin = vismaConnect(SSO);

    expect((plugin as PluginLike).id).toBe('generic-oauth');
    expectD23Table(providerFromPlugin(plugin));
  });

  it('createAuth({ sso }) registers the generic-oauth plugin with the D23 provider options', () => {
    expectD23Table(providerFromAuth());
  });

  it('configures no accountSubject resolver, relying on the default sub resolution', () => {
    expect(providerFromPlugin(vismaConnect(SSO)).accountSubject).toBeUndefined();
    expect(providerFromAuth().accountSubject).toBeUndefined();
  });

  it('registers no generic-oauth plugin when no sso options are supplied', () => {
    const auth = createAuth({ db: {}, secret: 'unit-test-only-secret-not-real' });
    const plugins = (auth as unknown as { options: { plugins: readonly PluginLike[] } }).options
      .plugins;

    expect(plugins.some((p) => p.id === 'generic-oauth')).toBe(false);
  });
});
