/**
 * Test-only helper for task 18.1 (design D22; `specs/auth-and-rbac/spec.md`,
 * "Public self sign-up is not available").
 *
 * "A test-only helper (e.g. `createAdminUser`/`bootstrapTestTenant`) in the
 * test harness that creates users through the admin-creation path instead of
 * Better Auth sign-up, and migrate every existing fixture that called
 * sign-up (groups 2-4's integration tests) to use it."
 *
 * `createAdminUser` calls Better Auth's own `admin` plugin endpoint,
 * `auth.api.createUser` (`POST /admin/create-user`), the same in-process,
 * no-`headers` call design D22 names for both `identity.users.create` (task
 * 18.3, not built yet) and `packages/auth/scripts/bootstrap-admin.ts` (task
 * 18.4, not built yet either): the installed `better-auth@1.7.6` source
 * (`dist/plugins/admin/routes.mjs`) only requires a session when the call
 * carries `ctx.request` or `ctx.headers` (`if (!session && (ctx.request ||
 * ctx.headers)) throw ctx.error("UNAUTHORIZED");`) -- an in-process call with
 * no `headers` option, exactly like every other in-process `auth.api.*` call
 * this package's own int tests already make (for example
 * `auth-flow.int.test.ts`'s `api.createOrganization({ body })`), skips that
 * check entirely. No production code is needed for this helper: the `admin`
 * plugin and its `createUser` endpoint are already registered
 * unconditionally by `./../auth.ts` (task 2.1).
 *
 * `signInAdminUser` then drives a real sign-in through `auth.handler(new
 * Request(...))`, the same "real HTTP `Response`, so there is a `Set-Cookie`
 * header to read back" pattern every int test file in this package already
 * establishes for sign-in (`auth.api.signInEmail` never produces one) --
 * `createUser` itself returns no session, so a signed-in fixture always needs
 * this second step.
 *
 * `bootstrapTestTenant` composes both, plus organization creation, into the
 * one "a signed-in admin user with an active organization" shape most
 * migrated fixtures in this package need: because the created user already
 * has their one organization membership *before* the only sign-in call this
 * helper makes, that single session already carries the organization as its
 * `activeOrganizationId` (task 2.4's exactly-one-membership rule) -- unlike
 * the old self-service "sign up (no membership yet), create org, sign in
 * again (second session)" sequence every migrated fixture used to need.
 */
import type { AuthInstance } from '../auth.js';

const DEFAULT_AUTH_BASE_URL = 'http://localhost:3000/api/auth';

export interface AdminCreatedUser {
  readonly userId: string;
  readonly email: string;
}

export interface CreateAdminUserParams {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

interface CreateUserApiSurface {
  createUser(args: {
    body: { name: string; email: string; password: string };
  }): Promise<{ user: { id: string; email: string } }>;
}

/**
 * Creates a Tayzu user account through the admin-creation path
 * (`auth.api.createUser`, design D22), never Better Auth's own `/sign-up/
 * email` route. Returns no session: `createUser` never signs the created
 * user in (see this file's own module doc comment).
 */
export async function createAdminUser(
  auth: AuthInstance,
  params: CreateAdminUserParams,
): Promise<AdminCreatedUser> {
  const api = auth.api as CreateUserApiSurface;
  const result = await api.createUser({ body: params });
  return { userId: result.user.id, email: result.user.email };
}

/**
 * `./../auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is
 * Better Auth's real, documented HTTP entry point, not otherwise exposed on
 * `AuthInstance` -- same cast every int test file in this package already
 * uses locally for its own `handlerOf`.
 */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

/**
 * A real `cookie` header value built from a Better Auth HTTP response's own
 * `Set-Cookie` header(s) -- same helper shape every int test file in this
 * package already establishes locally (for example `mfa.int.test.ts`'s own
 * `cookieHeaderFrom`).
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
}

interface SignInEmailResponseBody {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

export interface SignInAdminUserParams {
  readonly email: string;
  readonly password: string;
  /** A fresh, random `x-forwarded-for` value per call, so the pre-auth rate limiter never interferes. */
  readonly ip: string;
  readonly authBaseUrl?: string;
}

export interface SignedInUser {
  readonly cookie: string;
  readonly token: string;
  readonly userId: string;
  readonly email: string;
}

/** Signs an already-created user in through `auth.handler`, returning the resulting session cookie. */
export async function signInAdminUser(
  auth: AuthInstance,
  params: SignInAdminUserParams,
): Promise<SignedInUser> {
  const handler = handlerOf(auth);
  const baseUrl = params.authBaseUrl ?? DEFAULT_AUTH_BASE_URL;
  const response = await handler(
    new Request(`${baseUrl}/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': params.ip,
      },
      body: JSON.stringify({ email: params.email, password: params.password }),
    }),
  );
  if (response.status !== 200) {
    throw new Error(
      `signInAdminUser: sign-in failed with status ${String(response.status)}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as SignInEmailResponseBody;
  return {
    cookie: cookieHeaderFrom(response),
    token: String(body.token),
    userId: body.user.id,
    email: body.user.email,
  };
}

interface CreateOrganizationApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string; slug: string }>;
}

export interface BootstrapTestTenantParams {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  /** A fresh, random `x-forwarded-for` value per call, so the pre-auth rate limiter never interferes. */
  readonly ip: string;
  readonly authBaseUrl?: string;
}

export interface BootstrappedTenant extends SignedInUser {
  readonly organizationId: string;
}

/**
 * Creates an admin user (`createAdminUser`), creates one organization owned
 * by them, then signs them in -- since the membership already exists before
 * that one sign-in call, the resulting session already carries it as
 * `activeOrganizationId` (see this file's own module doc comment).
 */
export async function bootstrapTestTenant(
  auth: AuthInstance,
  params: BootstrapTestTenantParams,
): Promise<BootstrappedTenant> {
  const admin = await createAdminUser(auth, {
    name: params.name,
    email: params.email,
    password: params.password,
  });
  const organizationApi = auth.api as CreateOrganizationApiSurface;
  const organization = await organizationApi.createOrganization({
    body: {
      name: params.organizationName,
      slug: params.organizationSlug,
      userId: admin.userId,
    },
  });
  const signedIn = await signInAdminUser(auth, {
    email: admin.email,
    password: params.password,
    ip: params.ip,
    authBaseUrl: params.authBaseUrl,
  });
  return { ...signedIn, organizationId: organization.id };
}
