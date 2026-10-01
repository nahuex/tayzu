/**
 * Visma Connect SSO (task 19.2, design D23, resolved decision Q17): Better
 * Auth's bundled `genericOAuth` plugin with the one fixed `visma-connect`
 * provider. Discovery-based OIDC, authorization code + PKCE S256, `state` and
 * `nonce` from Better Auth's own defaults.
 *
 * No `accountSubject` resolver is set on purpose: for a discovery provider
 * Better Auth's default is the verified ID token's `sub`, the immutable key
 * D24 links on. `overrideUserInfo` stays off so Better Auth never rewrites the
 * core `user.email` (D24). SSO never creates users (`disableImplicitSignUp`,
 * `disableSignUp`).
 *
 * Configuration comes only from the host (`apps/api`), never `process.env`.
 */
import { genericOAuth } from 'better-auth/plugins';

/** design D23: the fixed provider identifier used across allowlist, telemetry and `account.providerId`. */
export const VISMA_CONNECT_PROVIDER_ID = 'visma-connect';

export interface VismaConnectOptions {
  /** `https://connect.visma.com/.well-known/openid-configuration` in production; the local OIDC stub in tests. */
  readonly discoveryUrl: string;
  /** Host-resolved from the environment / Key Vault (D15). */
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Builds the `genericOAuth` plugin registering the D23 Visma Connect provider. */
export function vismaConnect(options: VismaConnectOptions): ReturnType<typeof genericOAuth> {
  return genericOAuth({
    config: [
      {
        providerId: VISMA_CONNECT_PROVIDER_ID,
        discoveryUrl: options.discoveryUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        requireIdTokenVerification: true,
        pkce: true,
        responseMode: 'form_post',
        scopes: ['openid', 'email', 'profile'],
        disableImplicitSignUp: true,
        disableSignUp: true,
        overrideUserInfo: false,
      },
    ],
  });
}
