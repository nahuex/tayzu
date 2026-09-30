/**
 * The deny-by-default allowlist of Better Auth routes reachable over HTTP
 * (design D18, D19, D22, D23). Paths are relative to Better Auth's
 * `/api/auth` base path. Anything not listed, including the `organization`
 * plugin's membership-mutation routes, every `apiKey` management route and
 * `/sign-up/email` (Q16), answers a plain `404` like an unknown route.
 */
export const AUTH_BASE_PATH = '/api/auth';

export const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  // Sign-in, sign-out and session read.
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  // Two-factor enrollment and verification.
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
  '/two-factor/generate-backup-codes',
  '/two-factor/verify-backup-code',
  // Self-service tenant switch (D19).
  '/organization/set-active',
  // Email verification.
  '/send-verification-email',
  '/verify-email',
  // Visma Connect sign-in and account linking (D23, D24).
  '/sign-in/social',
  '/callback/visma-connect',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  // Fresh password re-entry for a user without MFA (Q49): records the step-up marker.
  '/verify-password',
  // Password change with the current password; other sessions are revoked (Q46, D3).
  '/change-password',
  // Public signing key set of the `jwt` plugin (D5).
  '/jwks',
]);

/** Whether a request path (no query string) under `/api/auth` is allowlisted. */
export function isAllowedAuthPath(pathname: string): boolean {
  if (!pathname.startsWith(AUTH_BASE_PATH + '/')) {
    return false;
  }
  return ALLOWED_AUTH_ROUTES.has(pathname.slice(AUTH_BASE_PATH.length));
}
