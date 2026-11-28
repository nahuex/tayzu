/**
 * The explicit, reviewed list of Fastify routes that are public, that is, not behind
 * `resolveContext` (043 task 14.3b, design D15, VCDM G4). Every other Fastify route
 * must answer an anonymous call like the `/v1/*` catch-all: 401
 * `CATALOG_CONTEXT_REQUIRED`. `route-auth-allowlist.int.test.ts` enforces it, so a new
 * route cannot become public by accident: adding it here is a reviewed decision.
 *
 * `path` is the route as Fastify registers it; `method` is an upper-case HTTP method
 * or `'*'` for any. A `HEAD` route Fastify derives from a `GET` entry is covered. An
 * entry with `prefix: true` covers every registered route whose path starts with `path`
 * (003 Q39: only `/assets/`, where `wildcard: false` registers one route per file).
 */
export interface PublicRoute {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
  readonly prefix?: boolean;
}

export const PUBLIC_ROUTE_ALLOWLIST: readonly PublicRoute[] = [
  {
    method: 'GET',
    path: '/healthz',
    reason: 'Liveness probe: unauthenticated, no dependency check, no detail (002 Q33).',
  },
  {
    method: '*',
    path: '/api/auth/*',
    reason: 'Better Auth sign-in surface; deny-by-default allowlist and its own session checks.',
  },
  {
    method: 'POST',
    path: '/v1/auth/token',
    reason: 'Machine token exchange: authenticates by the credential in the body (002 D20).',
  },
  {
    method: 'POST',
    path: '/v1/auth/invitations/accept',
    reason: 'Invitation acceptance: the invitation token is the credential (043 D15).',
  },
  {
    method: 'POST',
    path: '/v1/auth/password-reset/request',
    reason: 'Password reset request: public by nature, answers the uniform 200 (044 D2).',
  },
  {
    method: 'POST',
    path: '/v1/auth/password-reset/confirm',
    reason: 'Password reset confirmation: the reset token is the credential (044 D2).',
  },
  {
    method: 'POST',
    path: '/v1/auth/visma-connect/backchannel-logout',
    reason: 'OIDC back-channel logout: authenticated by the signed logout token.',
  },
  {
    method: 'OPTIONS',
    path: '*',
    reason: 'CORS preflight, answered by @fastify/cors with no data and no session.',
  },
  {
    method: 'OPTIONS',
    path: '/v1/*',
    reason: 'CORS preflight on the catch-all, answered by @fastify/cors before the handler.',
  },
  {
    method: 'GET',
    path: '/v1/auth/visma-connect/reauthorize/callback',
    reason:
      'Visma Connect re-authorization callback: authenticated by the single-use state, the nonce and the session cookie (048 D6).',
  },
  {
    method: 'POST',
    path: '/v1/csp-reports',
    reason: 'browser CSP violation reports: no session, counted by directive only (048 D9)',
  },
  // 003 D9 (Q39): the web build's routes, registered only with `WEB_DIST_DIR`.
  {
    method: 'GET',
    path: '/assets/',
    prefix: true,
    reason: 'Hashed web build assets: static, public by nature, no data (003 D9).',
  },
  {
    method: 'GET',
    path: '/*',
    reason: 'SPA fallback: the static index.html, public by nature, no data (003 D9, Q28).',
  },
  {
    method: 'GET',
    path: '/theme-init.js',
    reason: 'Root build file: static, public by nature, no data (003 D9, Q58).',
  },
  {
    method: 'GET',
    path: '/favicon.svg',
    reason: 'Root build file: static, public by nature, no data (003 D9, Q58).',
  },
];
