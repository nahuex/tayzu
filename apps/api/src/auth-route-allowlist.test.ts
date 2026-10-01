/**
 * Allowlist-drift test for task 11.10 (design D18; `specs/auth-and-rbac/spec.md`,
 * requirement "Only an allowlisted set of Better Auth routes is reachable over
 * HTTP").
 *
 * Task 11.10: "An allowlist-drift test enumerating Better Auth's actual
 * mounted routes against the allowlist constant."
 *
 * Scenario (quoted from the spec):
 * - "An unlisted Better Auth route fails the allowlist test":
 *   GIVEN Better Auth's actual set of mounted `/api/auth/*` routes
 *   WHEN a route exists that the allowlist does not explicitly name
 *   THEN the allowlist test fails, rather than silently allowing or blocking
 *   it by default.
 *
 * ## How this works
 *
 * The routes are read from the real `createAuth` instance: every entry of
 * `auth.api` carrying a string `path` is an HTTP-mountable endpoint (entries
 * without a `path` are server-only). Every mounted route must be classified
 * explicitly, either in `ALLOWED_AUTH_ROUTES` (the production constant) or in
 * `BLOCKED_AUTH_ROUTES` below (a reviewed decision to keep it unreachable).
 * A Better Auth or plugin upgrade that mounts a new route is therefore in
 * neither set, and this test fails until someone decides.
 *
 * A route is classified as allowed when the allowlist names it, either by its
 * exact path or, for a parameterised mounted pattern such as `/callback/:id`,
 * when some allowlisted path is an instance of that pattern.
 *
 * ## Status
 *
 * `ALLOWED_AUTH_ROUTES` already exists (task 11.9), so the drift check is
 * expected to be green now: this test guards future drift. The scenario is
 * exercised on demand by the "unlisted route" test, which feeds the same
 * classifier a synthetic extra route and requires it to be reported. The
 * manual scratch-route demonstration in the task's Verify clause is done on a
 * throwaway copy and is not committed.
 *
 * ## Production symbols used (all exist)
 *
 * `createAuth`, `ALLOWED_AUTH_ROUTES`, `AUTH_BASE_PATH`, `isAllowedAuthPath`
 * from `@tayzu/auth`.
 */
import { ALLOWED_AUTH_ROUTES, AUTH_BASE_PATH, createAuth, isAllowedAuthPath } from '@tayzu/auth';
import { describe, expect, it } from 'vitest';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

// `betterAuth(...)` builds `auth.api` synchronously and never queries the
// database while doing so, so an empty object stands in for the Drizzle handle.
const STUB_DB: Record<string, unknown> = {};

/**
 * Every Better Auth route that is mounted but deliberately NOT reachable.
 * Adding a route here is a reviewed decision; forgetting to is what makes the
 * drift test fail.
 */
const BLOCKED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  // Core.
  '/sign-up/email',
  '/reset-password',
  '/change-email',
  '/update-session',
  '/update-user',
  '/delete-user',
  '/request-password-reset',
  '/reset-password/:token',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/delete-user/callback',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
  '/ok',
  '/error',
  // Organization plugin (membership mutations go through Cerbos-gated oRPC).
  '/organization/create',
  '/organization/update',
  '/organization/delete',
  '/organization/get-organization',
  '/organization/get-full-organization',
  '/organization/list',
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/accept-invitation',
  '/organization/get-invitation',
  '/organization/reject-invitation',
  '/organization/list-invitations',
  '/organization/get-active-member',
  '/organization/check-slug',
  '/organization/remove-member',
  '/organization/update-member-role',
  '/organization/leave',
  '/organization/list-user-invitations',
  '/organization/list-members',
  '/organization/get-active-member-role',
  '/organization/has-permission',
  // Admin plugin.
  '/admin/set-role',
  '/admin/get-user',
  '/admin/create-user',
  '/admin/update-user',
  '/admin/list-users',
  '/admin/list-user-sessions',
  '/admin/unban-user',
  '/admin/ban-user',
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
  '/admin/set-user-password',
  '/admin/has-permission',
  // Two-factor plugin (enable/verify/get-totp-uri/backup codes are allowlisted).
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
  // Leaves the allowlist (Q52): `/two-factor/enable` already returns the URI.
  '/two-factor/get-totp-uri',
  '/two-factor/disable',
  // Leaves the allowlist (Q56): 002 sends no email.
  '/send-verification-email',
  '/verify-email',
  // JWT plugin (`/jwks` is allowlisted per design D5; `/token` stays blocked).
  '/token',
  // apiKey plugin management routes.
  '/api-key/create',
  '/api-key/get',
  '/api-key/update',
  '/api-key/delete',
  '/api-key/list',
]);

interface MountedRoute {
  readonly handlerName: string;
  readonly path: string;
}

/** Every `auth.api` endpoint that carries an HTTP path, from the real instance. */
function enumerateMountedRoutes(): readonly MountedRoute[] {
  const auth = createAuth({ db: STUB_DB, secret: TEST_SECRET });
  const api = auth.api as Record<string, unknown>;
  const routes: MountedRoute[] = [];
  for (const [handlerName, endpoint] of Object.entries(api)) {
    const path = (endpoint as { path?: unknown } | null | undefined)?.path;
    if (typeof path === 'string') {
      routes.push({ handlerName, path });
    }
  }
  return routes;
}

/** Whether a mounted path pattern (`/callback/:id`) matches a concrete path. */
function patternMatches(pattern: string, concrete: string): boolean {
  if (!pattern.includes(':')) {
    return pattern === concrete;
  }
  const source = pattern
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`).test(concrete);
}

function isAllowlisted(mountedPath: string, allowed: ReadonlySet<string>): boolean {
  return [...allowed].some((entry) => patternMatches(mountedPath, entry));
}

/** Mounted routes that are in neither the allowlist nor the explicit blocked set. */
function unclassified(
  mounted: readonly MountedRoute[],
  allowed: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
): string[] {
  return mounted
    .filter((route) => !isAllowlisted(route.path, allowed) && !blocked.has(route.path))
    .map((route) => `${route.handlerName} ${route.path}`);
}

describe('apps/api /api/auth/* allowlist drift (task 11.10)', () => {
  const mounted = enumerateMountedRoutes();

  it('enumerates a non-trivial set of Better Auth mounted routes', () => {
    const paths = mounted.map((route) => route.path);
    // Guards against the enumeration silently returning nothing.
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain('/sign-in/email');
    expect(paths).toContain('/organization/invite-member');
    expect(paths).toContain('/api-key/create');
  });

  it('An unlisted Better Auth route fails the allowlist test: every mounted route is either allowlisted or explicitly blocked', () => {
    expect(unclassified(mounted, ALLOWED_AUTH_ROUTES, BLOCKED_AUTH_ROUTES)).toEqual([]);
  });

  it('An unlisted Better Auth route fails the allowlist test: a route in neither set is reported, not silently allowed or blocked', () => {
    const scratch: MountedRoute = { handlerName: 'scratchRoute', path: '/scratch/new-route' };

    const reported = unclassified([...mounted, scratch], ALLOWED_AUTH_ROUTES, BLOCKED_AUTH_ROUTES);

    expect(reported).toEqual(['scratchRoute /scratch/new-route']);
  });

  it('a route named by neither set stays unreachable over HTTP until classified (deny by default)', () => {
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/scratch/new-route`)).toBe(false);
  });

  it('the JWKS route is published (design D5): /jwks is mounted and allowlisted, not blocked', () => {
    expect(mounted.map((route) => route.path)).toContain('/jwks');
    expect(ALLOWED_AUTH_ROUTES.has('/jwks')).toBe(true);
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/jwks`)).toBe(true);
    expect(BLOCKED_AUTH_ROUTES.has('/jwks')).toBe(false);
  });

  it('/verify-password is mounted and allowlisted, not blocked (Q49: it records the step-up marker)', () => {
    expect(mounted.map((route) => route.path)).toContain('/verify-password');
    expect(ALLOWED_AUTH_ROUTES.has('/verify-password')).toBe(true);
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/verify-password`)).toBe(true);
    expect(BLOCKED_AUTH_ROUTES.has('/verify-password')).toBe(false);
  });

  it('no route is both allowlisted and blocked', () => {
    const both = [...BLOCKED_AUTH_ROUTES].filter((path) => ALLOWED_AUTH_ROUTES.has(path));
    expect(both).toEqual([]);
  });

  it('the organization membership-mutation and apiKey management routes are never allowlisted', () => {
    const mustStayBlocked = [
      '/organization/invite-member',
      '/organization/update-member-role',
      '/organization/remove-member',
      '/organization/create',
      '/organization/delete',
      '/api-key/create',
      '/api-key/list',
      '/api-key/delete',
    ];
    for (const path of mustStayBlocked) {
      expect(mounted.map((route) => route.path)).toContain(path);
      expect(ALLOWED_AUTH_ROUTES.has(path)).toBe(false);
      expect(isAllowedAuthPath(`${AUTH_BASE_PATH}${path}`)).toBe(false);
    }
  });
});

describe('apps/api /api/auth/* allowlist: /change-password (task 23.16, design Q46 and D18)', () => {
  const mounted = enumerateMountedRoutes();

  it('/change-password is a mounted Better Auth route and is allowlisted (Q46)', () => {
    expect(mounted.map((route) => route.path)).toContain('/change-password');
    expect(ALLOWED_AUTH_ROUTES.has('/change-password')).toBe(true);
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/change-password`)).toBe(true);
  });

  it('the sibling password routes stay unlisted: only /change-password was added', () => {
    for (const path of [
      '/reset-password',
      '/request-password-reset',
      '/reset-password/some-token',
      '/change-email',
      '/admin/set-user-password',
    ]) {
      expect(isAllowedAuthPath(`${AUTH_BASE_PATH}${path}`)).toBe(false);
    }
  });
});

describe('apps/api /api/auth/* allowlist drift with Visma Connect SSO registered (task 19.3, design D23)', () => {
  // Discovery is only stored at construction, never fetched (task 19.2's unit test does the same).
  const SSO = {
    discoveryUrl: 'http://127.0.0.1:1/.well-known/openid-configuration',
    clientId: 'tayzu-test-client',
    clientSecret: 'unit-test-only-client-secret',
  } as const;

  function enumerateWithSso(): readonly MountedRoute[] {
    const auth = createAuth({ db: STUB_DB, secret: TEST_SECRET, sso: SSO });
    const routes: MountedRoute[] = [];
    for (const [handlerName, endpoint] of Object.entries(auth.api as Record<string, unknown>)) {
      const path = (endpoint as { path?: unknown } | null | undefined)?.path;
      if (typeof path === 'string') {
        routes.push({ handlerName, path });
      }
    }
    return routes;
  }

  const FIVE_SSO_ROUTES = [
    '/sign-in/social',
    '/callback/visma-connect',
    '/link-social',
    '/unlink-account',
    '/list-accounts',
  ] as const;

  it('the five Visma Connect routes are allowlisted, and each is a mounted Better Auth route', () => {
    const mountedPaths = enumerateWithSso().map((route) => route.path);
    for (const path of FIVE_SSO_ROUTES) {
      expect(ALLOWED_AUTH_ROUTES.has(path)).toBe(true);
      expect(isAllowedAuthPath(`${AUTH_BASE_PATH}${path}`)).toBe(true);
      expect(mountedPaths.some((mountedPath) => patternMatches(mountedPath, path))).toBe(true);
    }
  });

  it('An unlisted Better Auth route fails the allowlist test: with SSO registered, every mounted route is still allowlisted or explicitly blocked', () => {
    expect(unclassified(enumerateWithSso(), ALLOWED_AUTH_ROUTES, BLOCKED_AUTH_ROUTES)).toEqual([]);
  });

  it('An unlisted Better Auth route fails the allowlist test: with SSO registered, a route in neither set is still reported', () => {
    const scratch: MountedRoute = { handlerName: 'scratchRoute', path: '/scratch/new-route' };

    const reported = unclassified(
      [...enumerateWithSso(), scratch],
      ALLOWED_AUTH_ROUTES,
      BLOCKED_AUTH_ROUTES,
    );

    expect(reported).toEqual(['scratchRoute /scratch/new-route']);
  });

  it('the SSO additions did not open a sibling route: a nearby unlisted path stays denied', () => {
    for (const path of [
      '/callback/other-provider',
      '/oauth2/link',
      '/sign-in/oauth2',
      '/sign-up/social',
    ]) {
      expect(isAllowedAuthPath(`${AUTH_BASE_PATH}${path}`)).toBe(false);
    }
  });
});

describe('apps/api /api/auth/* allowlist: /two-factor/get-totp-uri (task 24.3, design Q52 and D18)', () => {
  const mounted = enumerateMountedRoutes();

  it('/two-factor/get-totp-uri is still a mounted Better Auth route, but no longer allowlisted (Q52)', () => {
    expect(mounted.map((route) => route.path)).toContain('/two-factor/get-totp-uri');
    expect(ALLOWED_AUTH_ROUTES.has('/two-factor/get-totp-uri')).toBe(false);
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/two-factor/get-totp-uri`)).toBe(false);
  });

  it('the rest of the two-factor allowlist is unchanged: enable, verify-totp, generate-backup-codes and verify-backup-code stay allowlisted', () => {
    for (const path of [
      '/two-factor/enable',
      '/two-factor/verify-totp',
      '/two-factor/generate-backup-codes',
      '/two-factor/verify-backup-code',
    ]) {
      expect(ALLOWED_AUTH_ROUTES.has(path)).toBe(true);
    }
  });
});

describe('apps/api /api/auth/* allowlist: verification-email routes (task 24.7, design Q56 and D18)', () => {
  const mounted = enumerateMountedRoutes();

  it('/send-verification-email and /verify-email are still mounted Better Auth routes, but no longer allowlisted (Q56)', () => {
    for (const path of ['/send-verification-email', '/verify-email']) {
      expect(mounted.map((route) => route.path)).toContain(path);
      expect(ALLOWED_AUTH_ROUTES.has(path)).toBe(false);
      expect(isAllowedAuthPath(`${AUTH_BASE_PATH}${path}`)).toBe(false);
    }
  });
});
