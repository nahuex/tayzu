/**
 * The auth client of the web app (task 5.3, design D4 and Q24, D8, D11; scenario "A
 * mutating call carries the CSRF header and no tenant").
 *
 * A thin hand-written client over the exact routes the pages use: the allowlisted
 * Better Auth routes (`packages/auth/src/http/allowed-routes.ts`), the plain routes of
 * `043` and `044` and `GET /v1/me`. Each response is parsed by a Zod schema into a
 * null-prototype object, and unknown fields are dropped. Every non-`GET` call sends
 * `x-csrf-token: orpc` and `Content-Type: application/json`.
 *
 * Assumed API of `./auth-client.js`:
 *
 * ```ts
 * import type { ApiError } from './errors.js';
 *
 * // No call throws: a non-2xx answer maps through `apiErrorFromResponse`; a 2xx
 * // answer the schema refuses, a body that is not JSON, or a rejected `fetch` is
 * // `{ kind: 'server' }`.
 * export type AuthResult<T> =
 *   | { readonly ok: true; readonly value: T }
 *   | { readonly ok: false; readonly error: ApiError };
 *
 * export interface AuthClientOptions {
 *   // Defaults to the global `fetch`. Called with a `Request` for the page's own
 *   // origin (`window.location.origin` + path); any `init` applies on top of it.
 *   readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
 * }
 *
 * export type SessionGate =
 *   'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';
 *
 * export interface Me {
 *   readonly user: { readonly id: string; readonly name: string; readonly email: string };
 *   readonly organization: { readonly id: string; readonly name: string };
 *   readonly role: 'owner' | 'admin' | 'member';
 *   readonly signInMethod: 'password' | 'visma-connect';
 *   readonly mfa: { readonly enrolled: boolean };
 *   readonly gate: SessionGate;
 * }
 *
 * export interface AuthClient {
 *   // POST /api/auth/sign-in/email {email, password}
 *   signInEmail(input: { email: string; password: string }):
 *     Promise<AuthResult<{ readonly twoFactorRequired: boolean }>>;
 *   // POST /api/auth/two-factor/verify-totp {code}
 *   verifyTotp(input: { code: string }): Promise<AuthResult<void>>;
 *   // POST /api/auth/two-factor/verify-backup-code {code}
 *   verifyBackupCode(input: { code: string }): Promise<AuthResult<void>>;
 *   // POST /api/auth/sign-in/social
 *   //   {provider: 'visma-connect', callbackURL: '/', errorCallbackURL: '/sign-in?error=sso'}
 *   signInWithVismaConnect(): Promise<AuthResult<{ readonly url: string }>>;
 *   // POST /api/auth/sign-out {}
 *   signOut(): Promise<AuthResult<void>>;
 *   // POST /api/auth/change-password {currentPassword, newPassword, revokeOtherSessions: true}
 *   changePassword(input: { currentPassword: string; newPassword: string }):
 *     Promise<AuthResult<void>>;
 *   // POST /api/auth/two-factor/enable {password}
 *   enableTwoFactor(input: { password: string }):
 *     Promise<AuthResult<{ readonly totpURI: string; readonly backupCodes: readonly string[] }>>;
 *   // POST /api/auth/verify-password {password}
 *   verifyPassword(input: { password: string }): Promise<AuthResult<void>>;
 *   // POST /v1/auth/password-reset/request {email}
 *   requestPasswordReset(input: { email: string }): Promise<AuthResult<void>>;
 *   // POST /v1/auth/password-reset/confirm {id, token, newPassword, factor?}
 *   confirmPasswordReset(input: {
 *     id: string; token: string; newPassword: string;
 *     factor?: { kind: 'totp' | 'backup_code'; code: string };
 *   }): Promise<AuthResult<void>>;
 *   // POST /v1/auth/invitations/accept {invitationId, token, password?}
 *   acceptInvitation(input: { invitationId: string; token: string; password?: string }):
 *     Promise<AuthResult<void>>;
 *   // GET /v1/me, no body
 *   me(): Promise<AuthResult<Me>>;
 * }
 *
 * export function createAuthClient(options?: AuthClientOptions): AuthClient;
 * ```
 *
 * The fake `fetch` rebuilds the effective request (`new Request(request, init)`), so
 * whatever the client sends, through the request or the second argument, is what the
 * assertions see. Every success fixture carries the server's own extra fields (session
 * tokens, user records) and an unknown field, all holding `MARKER`, and no parsed value
 * may contain it.
 */
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { createAuthClient } from './auth-client.js';

type AuthClient = ReturnType<typeof createAuthClient>;

const MARKER = 'UNKNOWN-FIELD-MARKER-5c91';

interface RecordedRequest {
  readonly request: Request;
  readonly url: URL;
  readonly body: string;
}

function createFakeFetch(respond: () => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push({ request, url: new URL(request.url), body: await request.clone().text() });
    return respond();
  };
  return { fetch, calls };
}

function onlyCall(calls: readonly RecordedRequest[]): RecordedRequest {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error('expected one recorded request');
  return call;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The server's error body: `ORPCError#toJSON()`, as `apps/api` sends it. */
function errorBody(code: string, status: number, data?: unknown): Record<string, unknown> {
  const message = `${MARKER} ${code}`;
  const error =
    data === undefined
      ? new ORPCError(code, { status, message })
      : new ORPCError(code, { status, message, data });
  return JSON.parse(JSON.stringify(error.toJSON())) as Record<string, unknown>;
}

/** A Better Auth user record, as `parseUserOutput` returns it. */
const BETTER_AUTH_USER = {
  id: `user-${MARKER}`,
  email: `${MARKER}@example.com`,
  name: MARKER,
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const ME_BODY = {
  user: { id: 'u_1', name: 'Mia Member', email: 'mia@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'password',
  mfa: { enrolled: false },
  gate: 'none',
};

const RESET_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const RESET_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

interface CallCase {
  readonly name: string;
  readonly invoke: (client: AuthClient) => Promise<unknown>;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** The exact JSON body; `undefined` for a call without a body. */
  readonly body: unknown;
  /** The server's success answer, with its own extra fields and an unknown one. */
  readonly success: () => Response;
}

/** Every call the pages make (design D4, D8, D11, D12), with the server's own answers. */
const CALLS: readonly CallCase[] = [
  {
    name: 'signInEmail',
    invoke: (client) => client.signInEmail({ email: 'mia@example.com', password: 'Secret-pass-1' }),
    method: 'POST',
    path: '/api/auth/sign-in/email',
    body: { email: 'mia@example.com', password: 'Secret-pass-1' },
    success: () =>
      jsonResponse(200, {
        redirect: false,
        token: `token-${MARKER}`,
        user: BETTER_AUTH_USER,
        unknown: MARKER,
      }),
  },
  {
    name: 'verifyTotp',
    invoke: (client) => client.verifyTotp({ code: '123456' }),
    method: 'POST',
    path: '/api/auth/two-factor/verify-totp',
    body: { code: '123456' },
    success: () =>
      jsonResponse(200, { token: `token-${MARKER}`, user: BETTER_AUTH_USER, unknown: MARKER }),
  },
  {
    name: 'verifyBackupCode',
    invoke: (client) => client.verifyBackupCode({ code: 'abcde-fghij' }),
    method: 'POST',
    path: '/api/auth/two-factor/verify-backup-code',
    body: { code: 'abcde-fghij' },
    success: () =>
      jsonResponse(200, { token: `token-${MARKER}`, user: BETTER_AUTH_USER, unknown: MARKER }),
  },
  {
    name: 'signInWithVismaConnect',
    invoke: (client) => client.signInWithVismaConnect(),
    method: 'POST',
    path: '/api/auth/sign-in/social',
    body: { provider: 'visma-connect', callbackURL: '/', errorCallbackURL: '/sign-in?error=sso' },
    success: () =>
      jsonResponse(200, {
        url: 'https://connect.visma.com/connect/authorize?state=s',
        redirect: true,
        unknown: MARKER,
      }),
  },
  {
    name: 'signOut',
    invoke: (client) => client.signOut(),
    method: 'POST',
    path: '/api/auth/sign-out',
    body: {},
    success: () => jsonResponse(200, { success: true, unknown: MARKER }),
  },
  {
    name: 'changePassword',
    invoke: (client) =>
      client.changePassword({ currentPassword: 'Temp-pass-1', newPassword: 'New-pass-12345' }),
    method: 'POST',
    path: '/api/auth/change-password',
    body: {
      currentPassword: 'Temp-pass-1',
      newPassword: 'New-pass-12345',
      revokeOtherSessions: true,
    },
    success: () =>
      jsonResponse(200, { token: `token-${MARKER}`, user: BETTER_AUTH_USER, unknown: MARKER }),
  },
  {
    name: 'enableTwoFactor',
    invoke: (client) => client.enableTwoFactor({ password: 'Secret-pass-1' }),
    method: 'POST',
    path: '/api/auth/two-factor/enable',
    body: { password: 'Secret-pass-1' },
    success: () =>
      jsonResponse(200, {
        method: 'totp',
        totpURI: 'otpauth://totp/Tayzu:mia%40example.com?secret=JBSWY3DPEHPK3PXP',
        backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'],
        unknown: MARKER,
      }),
  },
  {
    name: 'verifyPassword',
    invoke: (client) => client.verifyPassword({ password: 'Secret-pass-1' }),
    method: 'POST',
    path: '/api/auth/verify-password',
    body: { password: 'Secret-pass-1' },
    success: () => jsonResponse(200, { status: true, unknown: MARKER }),
  },
  {
    name: 'requestPasswordReset',
    invoke: (client) => client.requestPasswordReset({ email: 'mia@example.com' }),
    method: 'POST',
    path: '/v1/auth/password-reset/request',
    body: { email: 'mia@example.com' },
    success: () => jsonResponse(200, { accepted: true, unknown: MARKER }),
  },
  {
    name: 'confirmPasswordReset',
    invoke: (client) =>
      client.confirmPasswordReset({
        id: RESET_ID,
        token: RESET_TOKEN,
        newPassword: 'New-pass-12345',
      }),
    method: 'POST',
    path: '/v1/auth/password-reset/confirm',
    body: { id: RESET_ID, token: RESET_TOKEN, newPassword: 'New-pass-12345' },
    success: () => jsonResponse(200, { completed: true, unknown: MARKER }),
  },
  {
    name: 'acceptInvitation',
    invoke: (client) =>
      client.acceptInvitation({
        invitationId: 'inv_1',
        token: 'invitation-token',
        password: 'New-pass-12345',
      }),
    method: 'POST',
    path: '/v1/auth/invitations/accept',
    body: { invitationId: 'inv_1', token: 'invitation-token', password: 'New-pass-12345' },
    success: () => jsonResponse(200, { userId: `user-${MARKER}`, unknown: MARKER }),
  },
  {
    name: 'me',
    invoke: (client) => client.me(),
    method: 'GET',
    path: '/v1/me',
    body: undefined,
    success: () =>
      jsonResponse(
        200,
        {
          ...ME_BODY,
          user: { ...ME_BODY.user, unknown: MARKER },
          organization: { ...ME_BODY.organization, unknown: MARKER },
          mfa: { ...ME_BODY.mfa, unknown: MARKER },
          unknown: MARKER,
        },
        { 'cache-control': 'no-store' },
      ),
  },
];

/** The calls whose success carries no value for the page. */
const VOID_CALLS = new Set([
  'verifyTotp',
  'verifyBackupCode',
  'signOut',
  'changePassword',
  'verifyPassword',
  'requestPasswordReset',
  'confirmPasswordReset',
  'acceptInvitation',
]);

async function send(
  invoke: (client: AuthClient) => Promise<unknown>,
  respond: () => Response | Promise<Response>,
): Promise<{ result: unknown; calls: readonly RecordedRequest[] }> {
  const { fetch, calls } = createFakeFetch(respond);
  const result = await invoke(createAuthClient({ fetch }));
  return { result, calls };
}

/** Narrows an `AuthResult` to its value, failing the test on a failure. */
function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected a success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function hasKeyMatching(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) => pattern.test(key) || hasKeyMatching(nested, pattern),
  );
}

function mediaTypeOf(request: Request): string | undefined {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
}

function expectSameOriginPath(call: RecordedRequest, path: string): void {
  expect(call.url.origin).toBe(window.location.origin);
  expect(call.url.pathname).toBe(path);
  expect(call.url.search).toBe('');
}

function expectBrowserOwnedCredentials(call: RecordedRequest): void {
  expect(call.request.credentials).toBe('same-origin');
  expect(call.request.headers.has('authorization')).toBe(false);
  expect(call.request.headers.has('cookie')).toBe(false);
}

function expectNoTenant(call: RecordedRequest): void {
  expect([...call.request.headers.keys()].filter((name) => /tenant/i.test(name))).toEqual([]);
  expect([...call.url.searchParams.keys()].filter((key) => /tenant/i.test(key))).toEqual([]);
  expect(call.url.pathname).not.toMatch(/tenant/i);
  expect(call.body).not.toMatch(/tenant/i);
  if (call.body !== '') {
    expect(hasKeyMatching(JSON.parse(call.body), /tenant|organization/i)).toBe(false);
  }
}

const SERVER_FAILURE = { ok: false, error: { kind: 'server' } };

describe('createAuthClient (design D4, Q24)', () => {
  describe.each(CALLS)('$name', (call) => {
    it(`sends ${call.method} ${call.path} on the page's own origin, with no query`, async () => {
      const { calls } = await send(call.invoke, call.success);

      const recorded = onlyCall(calls);
      expect(recorded.request.method).toBe(call.method);
      expectSameOriginPath(recorded, call.path);
    });

    if (call.method === 'GET') {
      it('sends no body', async () => {
        const { calls } = await send(call.invoke, call.success);

        expect(onlyCall(calls).body).toBe('');
      });
    } else {
      it('A mutating call carries the CSRF header and no tenant: x-csrf-token: orpc and application/json', async () => {
        const { calls } = await send(call.invoke, call.success);

        const recorded = onlyCall(calls);
        expect(recorded.request.headers.get('x-csrf-token')).toBe('orpc');
        expect(mediaTypeOf(recorded.request)).toBe('application/json');
        expectNoTenant(recorded);
      });

      it('sends exactly the body the route allowlists', async () => {
        const { calls } = await send(call.invoke, call.success);

        expect(JSON.parse(onlyCall(calls).body)).toEqual(call.body);
      });
    }

    it('leaves credentials at same-origin and sends no Authorization or Cookie header', async () => {
      const { calls } = await send(call.invoke, call.success);

      const recorded = onlyCall(calls);
      expectBrowserOwnedCredentials(recorded);
      expectNoTenant(recorded);
    });

    it("drops every unknown response field, the server's tokens and user records included", async () => {
      const { result } = await send(call.invoke, call.success);

      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    });

    if (VOID_CALLS.has(call.name)) {
      it('answers a success with no value', async () => {
        const { result } = await send(call.invoke, call.success);

        expect(result).toEqual({ ok: true });
      });
    }

    it('maps a 2xx body that is not JSON to server', async () => {
      const { result } = await send(
        call.invoke,
        () =>
          new Response('<!doctype html><title>x</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a 2xx JSON null to server', async () => {
      const { result } = await send(call.invoke, () => jsonResponse(200, null));

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a 2xx JSON array to server', async () => {
      const { result } = await send(call.invoke, () => jsonResponse(200, [MARKER]));

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a 2xx JSON string to server', async () => {
      const { result } = await send(call.invoke, () => jsonResponse(200, MARKER));

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a rejected fetch (network failure) to server', async () => {
      const { result } = await send(call.invoke, () => {
        throw new TypeError('Failed to fetch');
      });

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a 500 to server, without the server text', async () => {
      const { result } = await send(call.invoke, () =>
        jsonResponse(500, errorBody('INTERNAL_SERVER_ERROR', 500)),
      );

      expect(result).toEqual(SERVER_FAILURE);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    });
  });

  describe('signInEmail (D11 /sign-in)', () => {
    it('answers a session with twoFactorRequired false, in a null-prototype object', async () => {
      const { result } = await send(
        (client) => client.signInEmail({ email: 'mia@example.com', password: 'p' }),
        () =>
          jsonResponse(200, {
            redirect: false,
            token: `token-${MARKER}`,
            user: BETTER_AUTH_USER,
          }),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['signInEmail']>>);
      expect(value).toEqual({ twoFactorRequired: false });
      expect(Object.getPrototypeOf(value)).toBeNull();
    });

    it("answers the two-factor plugin's challenge with twoFactorRequired true", async () => {
      const { result } = await send(
        (client) => client.signInEmail({ email: 'mia@example.com', password: 'p' }),
        () => jsonResponse(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'], x: MARKER }),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['signInEmail']>>);
      expect(value).toEqual({ twoFactorRequired: true });
      expect(JSON.stringify(value)).not.toContain(MARKER);
    });

    it('maps a twoFactorRedirect that is not a boolean to server', async () => {
      const { result } = await send(
        (client) => client.signInEmail({ email: 'mia@example.com', password: 'p' }),
        () => jsonResponse(200, { twoFactorRedirect: 'yes' }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a wrong password (401) to unauthenticated, whatever the message', async () => {
      const { result } = await send(
        (client) => client.signInEmail({ email: 'mia@example.com', password: 'wrong' }),
        () => jsonResponse(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: MARKER }),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'unauthenticated' } });
    });

    it('maps AUTH_RATE_LIMITED (429) to rate_limited with Retry-After', async () => {
      const { result } = await send(
        (client) => client.signInEmail({ email: 'mia@example.com', password: 'p' }),
        () => jsonResponse(429, errorBody('AUTH_RATE_LIMITED', 429), { 'retry-after': '30' }),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'rate_limited', retryAfterSeconds: 30 } });
    });
  });

  describe('signInWithVismaConnect (D11 /sign-in)', () => {
    it('answers only the returned URL, in a null-prototype object', async () => {
      const url = 'https://connect.visma.com/connect/authorize?state=s';
      const { result } = await send(
        (client) => client.signInWithVismaConnect(),
        () => jsonResponse(200, { url, redirect: true, unknown: MARKER }),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['signInWithVismaConnect']>>);
      expect(value).toEqual({ url });
      expect(Object.getPrototypeOf(value)).toBeNull();
    });

    it('maps an answer without a URL to server', async () => {
      const { result } = await send(
        (client) => client.signInWithVismaConnect(),
        () => jsonResponse(200, { redirect: true }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps a URL that is not a string to server', async () => {
      const { result } = await send(
        (client) => client.signInWithVismaConnect(),
        () => jsonResponse(200, { url: 42, redirect: true }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });
  });

  describe('enableTwoFactor (D11 /mfa/enrol)', () => {
    const totpURI = 'otpauth://totp/Tayzu:mia%40example.com?secret=JBSWY3DPEHPK3PXP';

    it('answers the TOTP URI and the backup codes only, in a null-prototype object', async () => {
      const { result } = await send(
        (client) => client.enableTwoFactor({ password: 'p' }),
        () =>
          jsonResponse(200, {
            method: 'totp',
            totpURI,
            backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'],
            unknown: MARKER,
          }),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['enableTwoFactor']>>);
      expect(value).toEqual({ totpURI, backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] });
      expect(Object.getPrototypeOf(value)).toBeNull();
    });

    it('maps an answer without a TOTP URI to server', async () => {
      const { result } = await send(
        (client) => client.enableTwoFactor({ password: 'p' }),
        () => jsonResponse(200, { method: 'totp', backupCodes: ['aaaaa-bbbbb'] }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps backup codes that are not strings to server', async () => {
      const { result } = await send(
        (client) => client.enableTwoFactor({ password: 'p' }),
        () => jsonResponse(200, { method: 'totp', totpURI, backupCodes: [1, 2] }),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });
  });

  describe('confirmPasswordReset (D11 /reset-password)', () => {
    it('sends the factor when the user gives one', async () => {
      const { calls } = await send(
        (client) =>
          client.confirmPasswordReset({
            id: RESET_ID,
            token: RESET_TOKEN,
            newPassword: 'New-pass-12345',
            factor: { kind: 'backup_code', code: 'abcde-fghij' },
          }),
        () => jsonResponse(200, { completed: true }),
      );

      const recorded = onlyCall(calls);
      expect(JSON.parse(recorded.body)).toEqual({
        id: RESET_ID,
        token: RESET_TOKEN,
        newPassword: 'New-pass-12345',
        factor: { kind: 'backup_code', code: 'abcde-fghij' },
      });
      expect(recorded.request.headers.get('x-csrf-token')).toBe('orpc');
      expect(mediaTypeOf(recorded.request)).toBe('application/json');
    });

    it('sends no factor key when the user gives none', async () => {
      const { calls } = await send(
        (client) =>
          client.confirmPasswordReset({
            id: RESET_ID,
            token: RESET_TOKEN,
            newPassword: 'New-pass-12345',
          }),
        () => jsonResponse(200, { completed: true }),
      );

      expect(Object.keys(JSON.parse(onlyCall(calls).body) as object).sort()).toEqual([
        'id',
        'newPassword',
        'token',
      ]);
    });

    it('maps AUTH_STEP_UP_REQUIRED (403) to step_up_required', async () => {
      const { result } = await send(
        (client) =>
          client.confirmPasswordReset({ id: RESET_ID, token: RESET_TOKEN, newPassword: 'n' }),
        () => jsonResponse(403, errorBody('AUTH_STEP_UP_REQUIRED', 403)),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'step_up_required' } });
    });

    it('maps the uniform 404 to not_found', async () => {
      const { result } = await send(
        (client) =>
          client.confirmPasswordReset({ id: RESET_ID, token: RESET_TOKEN, newPassword: 'n' }),
        () => jsonResponse(404, errorBody('CATALOG_NOT_FOUND', 404)),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'not_found' } });
    });

    it('maps a password-policy refusal on /newPassword to its rule', async () => {
      const { result } = await send(
        (client) =>
          client.confirmPasswordReset({ id: RESET_ID, token: RESET_TOKEN, newPassword: 'n' }),
        () =>
          jsonResponse(
            400,
            errorBody('CATALOG_VALIDATION_FAILED', 400, {
              issues: [{ path: '/newPassword', message: 'length' }],
            }),
          ),
      );

      expect(result).toEqual({
        ok: false,
        error: { kind: 'validation', issues: [{ path: '/newPassword', rule: 'length' }] },
      });
    });
  });

  describe('acceptInvitation (D11 /accept-invitation)', () => {
    it('sends no password key on the session path', async () => {
      const { calls } = await send(
        (client) => client.acceptInvitation({ invitationId: 'inv_1', token: 'invitation-token' }),
        () => jsonResponse(200, { userId: 'u_1' }),
      );

      const recorded = onlyCall(calls);
      expect(JSON.parse(recorded.body)).toEqual({
        invitationId: 'inv_1',
        token: 'invitation-token',
      });
      expect(Object.keys(JSON.parse(recorded.body) as object).sort()).toEqual([
        'invitationId',
        'token',
      ]);
      expect(recorded.request.headers.get('x-csrf-token')).toBe('orpc');
      expect(mediaTypeOf(recorded.request)).toBe('application/json');
    });

    it('maps the uniform 404 to not_found', async () => {
      const { result } = await send(
        (client) => client.acceptInvitation({ invitationId: 'inv_1', token: 't', password: 'p' }),
        () => jsonResponse(404, errorBody('CATALOG_NOT_FOUND', 404)),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'not_found' } });
    });
  });

  describe('me (D8 GET /v1/me)', () => {
    it('A member reads their session: name, organization, role member, sign-in method and gate none', async () => {
      const { result } = await send(
        (client) => client.me(),
        () => jsonResponse(200, ME_BODY),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['me']>>);
      expect(value).toEqual(ME_BODY);
      expect(value.role).toBe('member');
      expect(value.gate).toBe('none');
    });

    it('parses into null-prototype objects at every level', async () => {
      const { result } = await send(
        (client) => client.me(),
        () => jsonResponse(200, ME_BODY),
      );

      const value = valueOf(result as Awaited<ReturnType<AuthClient['me']>>);
      expect(Object.getPrototypeOf(value)).toBeNull();
      expect(Object.getPrototypeOf(value.user)).toBeNull();
      expect(Object.getPrototypeOf(value.organization)).toBeNull();
      expect(Object.getPrototypeOf(value.mfa)).toBeNull();
    });

    it('drops unknown fields at every level', async () => {
      const { result } = await send(
        (client) => client.me(),
        () =>
          jsonResponse(200, {
            ...ME_BODY,
            user: { ...ME_BODY.user, image: MARKER },
            organization: { ...ME_BODY.organization, slug: MARKER },
            mfa: { ...ME_BODY.mfa, methods: [MARKER] },
            tenantId: MARKER,
          }),
      );

      expect(valueOf(result as Awaited<ReturnType<AuthClient['me']>>)).toEqual(ME_BODY);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    });

    it.each([
      ['owner', 'visma-connect', true, 'none'],
      ['admin', 'password', false, 'mfa_enrolment_required'],
      ['member', 'password', false, 'password_change_required'],
      ['member', 'password', false, 'password_expired'],
    ] as const)(
      'keeps role %s, sign-in method %s, mfa.enrolled %s and gate %s',
      async (role, signInMethod, enrolled, gate) => {
        const body = { ...ME_BODY, role, signInMethod, mfa: { enrolled }, gate };
        const { result } = await send(
          (client) => client.me(),
          () => jsonResponse(200, body),
        );

        expect(valueOf(result as Awaited<ReturnType<AuthClient['me']>>)).toEqual(body);
      },
    );

    it.each([
      ['an unknown role', { ...ME_BODY, role: 'root' }],
      ['an unknown gate', { ...ME_BODY, gate: 'unknown' }],
      ['an unknown sign-in method', { ...ME_BODY, signInMethod: 'sms' }],
      ['no mfa', { ...ME_BODY, mfa: undefined }],
      ['an mfa.enrolled that is not a boolean', { ...ME_BODY, mfa: { enrolled: 'yes' } }],
      ['an email that is not a string', { ...ME_BODY, user: { ...ME_BODY.user, email: 7 } }],
      ['no organization', { ...ME_BODY, organization: null }],
      ['an organization without a name', { ...ME_BODY, organization: { id: 'org_1' } }],
    ])('maps a body with %s to server', async (_label, body) => {
      const { result } = await send(
        (client) => client.me(),
        () => jsonResponse(200, body),
      );

      expect(result).toEqual(SERVER_FAILURE);
    });

    it('maps the uniform 401 CATALOG_CONTEXT_REQUIRED to unauthenticated', async () => {
      const { result } = await send(
        (client) => client.me(),
        () => jsonResponse(401, errorBody('CATALOG_CONTEXT_REQUIRED', 401)),
      );

      expect(result).toEqual({ ok: false, error: { kind: 'unauthenticated' } });
    });
  });
});
