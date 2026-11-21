/**
 * The auth client of the web app (design D4, D8, D11, Q24, Q64).
 *
 * A thin hand-written client over the exact routes the pages use: the
 * allowlisted Better Auth routes, the plain accept and reset routes and
 * `GET /v1/me`. Every request goes to the page's own origin with the
 * browser's default `credentials: 'same-origin'`, so the session cookie
 * travels without script reading it. Every non-`GET` call sends
 * `x-csrf-token: orpc` and `Content-Type: application/json`, which the server
 * checks. Each answer is parsed by a Zod schema (unknown fields dropped) into
 * null-prototype objects. No call throws: every failure is an `ApiError`.
 */
import { z } from 'zod';

import { toNullPrototype } from '../lib/untrusted.js';

import { apiErrorFromResponse, type ApiError } from './errors.js';

export type AuthResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export interface AuthClientOptions {
  /** Defaults to the global `fetch`. Called with the final `Request`. */
  readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
}

export type SessionGate =
  'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

export interface Me {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: 'owner' | 'admin' | 'member';
  readonly signInMethod: 'password' | 'visma-connect';
  readonly mfa: { readonly enrolled: boolean };
  readonly gate: SessionGate;
}

export interface AuthClient {
  signInEmail(input: {
    email: string;
    password: string;
  }): Promise<AuthResult<{ readonly twoFactorRequired: boolean }>>;
  verifyTotp(input: { code: string }): Promise<AuthResult<void>>;
  verifyBackupCode(input: { code: string }): Promise<AuthResult<void>>;
  signInWithVismaConnect(): Promise<AuthResult<{ readonly url: string }>>;
  signOut(): Promise<AuthResult<void>>;
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<AuthResult<void>>;
  enableTwoFactor(input: {
    password: string;
  }): Promise<AuthResult<{ readonly totpURI: string; readonly backupCodes: readonly string[] }>>;
  verifyPassword(input: { password: string }): Promise<AuthResult<void>>;
  requestPasswordReset(input: { email: string }): Promise<AuthResult<void>>;
  confirmPasswordReset(input: {
    id: string;
    token: string;
    newPassword: string;
    factor?: { kind: 'totp' | 'backup_code'; code: string };
  }): Promise<AuthResult<void>>;
  acceptInvitation(input: {
    invitationId: string;
    token: string;
    password?: string;
  }): Promise<AuthResult<void>>;
  me(): Promise<AuthResult<Me>>;
}

/** Any JSON object: the answer of a call whose success carries no value. */
const emptySchema = z.object({});

const signInEmailSchema = z.object({ twoFactorRedirect: z.boolean().optional() });

const socialSignInSchema = z.object({ url: z.string() });

const enableTwoFactorSchema = z.object({
  totpURI: z.string(),
  backupCodes: z.array(z.string()),
});

const meSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  organization: z.object({ id: z.string(), name: z.string() }),
  role: z.enum(['owner', 'admin', 'member']),
  signInMethod: z.enum(['password', 'visma-connect']),
  mfa: z.object({ enrolled: z.boolean() }),
  gate: z.enum(['none', 'password_change_required', 'password_expired', 'mfa_enrolment_required']),
});

const SERVER_FAILURE: AuthResult<never> = { ok: false, error: { kind: 'server' } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a 2xx body: anything but a JSON object is `undefined`. */
async function jsonObjectOf(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body = JSON.parse(await response.text()) as unknown;
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const send =
    options.fetch ?? ((request: Request, init?: RequestInit) => globalThis.fetch(request, init));

  /**
   * Sends one call and parses its answer. `body` is `undefined` for a `GET`;
   * every other call is a JSON `POST` with the CSRF header.
   */
  async function call<S extends z.ZodType>(
    path: string,
    body: Record<string, unknown> | undefined,
    schema: S,
  ): Promise<AuthResult<z.output<S>>> {
    const url = new URL(path, window.location.origin);
    const request =
      body === undefined
        ? new Request(url, { method: 'GET' })
        : new Request(url, {
            method: 'POST',
            headers: { 'x-csrf-token': 'orpc', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
    try {
      const response = await send(request);
      if (!response.ok) return { ok: false, error: await apiErrorFromResponse(response) };
      const parsed = schema.safeParse(await jsonObjectOf(response));
      return parsed.success ? { ok: true, value: toNullPrototype(parsed.data) } : SERVER_FAILURE;
    } catch {
      return SERVER_FAILURE;
    }
  }

  /** A call whose success carries no value for the page. */
  async function callVoid(path: string, body: Record<string, unknown>): Promise<AuthResult<void>> {
    const result = await call(path, body, emptySchema);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  return {
    async signInEmail({ email, password }) {
      const result = await call('/api/auth/sign-in/email', { email, password }, signInEmailSchema);
      if (!result.ok) return result;
      return {
        ok: true,
        value: toNullPrototype({ twoFactorRequired: result.value.twoFactorRedirect === true }),
      };
    },
    verifyTotp: ({ code }) => callVoid('/api/auth/two-factor/verify-totp', { code }),
    verifyBackupCode: ({ code }) => callVoid('/api/auth/two-factor/verify-backup-code', { code }),
    signInWithVismaConnect: () =>
      call(
        '/api/auth/sign-in/social',
        { provider: 'visma-connect', callbackURL: '/', errorCallbackURL: '/sign-in?error=sso' },
        socialSignInSchema,
      ),
    signOut: () => callVoid('/api/auth/sign-out', {}),
    changePassword: ({ currentPassword, newPassword }) =>
      callVoid('/api/auth/change-password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      }),
    enableTwoFactor: ({ password }) =>
      call('/api/auth/two-factor/enable', { password }, enableTwoFactorSchema),
    verifyPassword: ({ password }) => callVoid('/api/auth/verify-password', { password }),
    requestPasswordReset: ({ email }) => callVoid('/v1/auth/password-reset/request', { email }),
    confirmPasswordReset: ({ id, token, newPassword, factor }) =>
      callVoid('/v1/auth/password-reset/confirm', {
        id,
        token,
        newPassword,
        ...(factor === undefined ? {} : { factor: { kind: factor.kind, code: factor.code } }),
      }),
    acceptInvitation: ({ invitationId, token, password }) =>
      callVoid('/v1/auth/invitations/accept', {
        invitationId,
        token,
        ...(password === undefined ? {} : { password }),
      }),
    me: () => call('/v1/me', undefined, meSchema),
  };
}
