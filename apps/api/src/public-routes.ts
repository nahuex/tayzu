/**
 * The explicit, reviewed list of Fastify routes that are public, that is, not behind
 * `resolveContext` (043 task 14.3b, design D15, VCDM G4). Every other Fastify route
 * must answer an anonymous call like the `/v1/*` catch-all: 401
 * `CATALOG_CONTEXT_REQUIRED`. `route-auth-allowlist.int.test.ts` enforces it, so a new
 * route cannot become public by accident: adding it here is a reviewed decision.
 *
 * `path` is the route as Fastify registers it; `method` is an upper-case HTTP method
 * or `'*'` for any. A `HEAD` route Fastify derives from a `GET` entry is covered.
 */
export interface PublicRoute {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
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
    method: '*',
    path: '/v1/auth/visma-connect/reauthorize/callback',
    reason: 'Visma Connect re-authorization callback: authenticated by the OIDC state.',
  },
];
