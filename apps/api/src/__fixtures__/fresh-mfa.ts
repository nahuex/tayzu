/**
 * Fresh-MFA fixture for apps/api integration tests (task 11.15, design D4).
 *
 * `createApp` wires the step-up guard, always on, into every `/v1` route marked
 * `x-tayzu-risk: high` (`blueprints.update`, `blueprints.delete`,
 * `entities.delete`). A user without a fresh (5-minute) MFA verification gets
 * `403 AUTH_STEP_UP_REQUIRED` there. Tests that legitimately call those routes
 * as a user use `freshMfaSessionCookie`, which does what `step-up.int.test.ts`
 * and `link-social-step-up.int.test.ts` do: enroll TOTP, then sign in through a
 * real TOTP challenge.
 */
import { randomInt } from 'node:crypto';

import { expect } from 'vitest';

import type { App } from '../server.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface TwoFactorApiSurface {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error(`invalid base32 character in TOTP secret: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bitsCollected += 5;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

function cookieHeaderOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

function authHandlerOf(app: App): (request: Request) => Promise<Response> {
  return (app.auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

/** Enrolls TOTP for the user behind `enrollmentCookie` and returns the raw TOTP secret. */
export async function enrollTotp(
  app: App,
  args: { readonly password: string; readonly enrollmentCookie: string },
): Promise<string> {
  const totp = app.auth.api as TwoFactorApiSurface;
  const enrollHeaders = new Headers({ cookie: args.enrollmentCookie });
  const enabled = await totp.enableTwoFactor({
    body: { password: args.password, method: 'totp' },
    headers: enrollHeaders,
  });
  const secret = rawSecretFromTotpUri(enabled.totpURI);
  await totp.verifyTOTP({
    body: { code: (await totp.generateTOTP({ body: { secret } })).code },
    headers: enrollHeaders,
  });
  return secret;
}

/**
 * Signs an MFA-enrolled user in through a real TOTP challenge and returns the
 * session cookie, which carries a fresh MFA verification.
 */
export async function signInWithTotp(
  app: App,
  args: {
    readonly email: string;
    readonly password: string;
    readonly secret: string;
    readonly origin: string;
    /** Defaults to the harness Better Auth base URL. */
    readonly authBaseUrl?: string;
  },
): Promise<string> {
  const totp = app.auth.api as TwoFactorApiSurface;
  const authHandler = authHandlerOf(app);
  const baseUrl = args.authBaseUrl ?? AUTH_BASE_URL;
  const challenge = await authHandler(
    new Request(`${baseUrl}/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: args.origin,
      },
      body: JSON.stringify({ email: args.email, password: args.password }),
    }),
  );
  expect(challenge.status, 'the sign-in is challenged, not rejected').toBe(200);
  const verified = await authHandler(
    new Request(`${baseUrl}/two-factor/verify-totp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        cookie: cookieHeaderOf(challenge),
        origin: args.origin,
      },
      body: JSON.stringify({
        code: (await totp.generateTOTP({ body: { secret: args.secret } })).code,
      }),
    }),
  );
  expect(verified.status, 'the TOTP challenge is verified').toBe(200);
  return cookieHeaderOf(verified);
}

/**
 * Enrolls TOTP for the user behind `enrollmentCookie` (a signed-in session, for
 * example `BootstrappedTenant.cookie`), then signs in again through a real TOTP
 * challenge and returns the resulting session cookie, which carries a fresh MFA
 * verification.
 */
export async function freshMfaSessionCookie(
  app: App,
  args: {
    readonly email: string;
    readonly password: string;
    readonly enrollmentCookie: string;
    /** An allowed origin of the app under test, sent as `Origin` like a browser does (Q40). */
    readonly origin: string;
    readonly authBaseUrl?: string;
  },
): Promise<string> {
  const secret = await enrollTotp(app, args);
  return signInWithTotp(app, { ...args, secret });
}

/**
 * Task 23.15 (Q43): an unenrolled organization admin/owner is limited to MFA
 * enrollment on `/v1`. Takes the tenant from `bootstrapTestTenant` and returns
 * it with an MFA-enrolled session cookie for the same admin (the cookie also
 * carries a fresh MFA verification).
 */
export async function enrolledAdminSession<
  T extends { readonly email: string; readonly cookie: string },
>(
  app: App,
  tenant: T,
  args: { readonly password: string; readonly origin: string; readonly authBaseUrl?: string },
): Promise<T> {
  const cookie = await freshMfaSessionCookie(app, {
    email: tenant.email,
    password: args.password,
    enrollmentCookie: tenant.cookie,
    origin: args.origin,
  });
  return { ...tenant, cookie };
}

/** The session token inside a `cookie` header value (the signed cookie value minus its signature). */
export function sessionTokenOfCookie(cookie: string): string {
  const pair = cookie.split('; ').find((entry) => entry.includes('session_token='));
  const signed = decodeURIComponent(pair?.slice(pair.indexOf('=') + 1) ?? '');
  return signed.split('.')[0] ?? '';
}
