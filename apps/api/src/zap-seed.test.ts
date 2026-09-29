/**
 * Unit test for task 15.1 (design D16, resolved decision Q30): the CI seed
 * script `scripts/ci/zap-seed.ts` that prepares the OWASP ZAP baseline job.
 * Its argument and environment handling only; no network, no database.
 *
 * Q30: the script reuses `packages/auth/scripts/bootstrap-admin.ts` to create
 * one organization and its first admin, starts nothing itself (the workflow
 * starts `apps/api` with `main.ts`), signs in over HTTP and hands the session
 * cookie to ZAP through `ZAP_AUTH_HEADER`. `BETTER_AUTH_SECRET` is random per
 * run and zaproxy/action-baseline is pinned by commit SHA.
 *
 * This file lives in `apps/api/src` only because the Vitest projects glob
 * `src/**`; `scripts/ci` is outside every package.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // scripts/ci/zap-seed.ts (does not exist yet)
 * export interface ZapSeedConfig {
 *   databaseUrl: string;        // DATABASE_URL (required)
 *   betterAuthSecret: string;   // BETTER_AUTH_SECRET (required)
 *   baseUrl: string;            // ZAP_TARGET_URL (required), http(s), no trailing slash
 *   organizationName: string;   // ZAP_SEED_ORGANIZATION_NAME, defaulted
 *   organizationSlug: string;   // ZAP_SEED_ORGANIZATION_SLUG, defaulted
 *   adminName: string;          // ZAP_SEED_ADMIN_NAME, defaulted
 *   adminEmail: string;         // ZAP_SEED_ADMIN_EMAIL, defaulted
 * }
 * export function parseZapSeedConfig(env: Readonly<Record<string, string | undefined>>): ZapSeedConfig;
 * // Turns Set-Cookie header values into the request header ZAP replays.
 * export function buildZapAuthHeader(setCookie: readonly string[]): { name: 'Cookie'; value: string };
 * // POST `${baseUrl}/api/auth/sign-in/email` with JSON { email, password };
 * // resolves to the Cookie header value. `fetch` is injected.
 * export function signInForSessionCookie(params: {
 *   baseUrl: string; email: string; password: string; fetch: typeof fetch;
 * }): Promise<string>;
 * ```
 *
 * The script's `main` (guarded like bootstrap-admin.ts) calls
 * `bootstrapAdmin` from `packages/auth/scripts/bootstrap-admin.ts`, signs in
 * with the returned one-time password and writes the header where the
 * workflow reads it. It never prints the password, the secret or the cookie.
 *
 * ## Why this fails right now
 *
 * `../../../scripts/ci/zap-seed.js` does not exist ("Cannot find module" is
 * the only cause).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// The module under test. Does not exist yet.
import {
  buildZapAuthHeader,
  parseZapSeedConfig,
  signInForSessionCookie,
} from '../../../scripts/ci/zap-seed.js';

const SECRET_MARKER = 'seed-secret-MARKER-9f3a1c7e5b2d4f60a8c1e3d5b7f90a2c';
const DB_MARKER = 'seed-db-pw-MARKER-77';

const completeEnv = {
  DATABASE_URL: `postgres://tayzu_auth:${DB_MARKER}@localhost:5432/tayzu_ci`,
  BETTER_AUTH_SECRET: SECRET_MARKER,
  ZAP_TARGET_URL: 'http://127.0.0.1:3000',
} as const;

describe('ZAP seed script: environment handling', () => {
  it('reads the required variables and defaults the organization and admin', () => {
    const config = parseZapSeedConfig(completeEnv);
    expect(config.databaseUrl).toBe(completeEnv.DATABASE_URL);
    expect(config.betterAuthSecret).toBe(SECRET_MARKER);
    expect(config.baseUrl).toBe('http://127.0.0.1:3000');
    for (const value of [
      config.organizationName,
      config.organizationSlug,
      config.adminName,
      config.adminEmail,
    ]) {
      expect(value.trim()).not.toBe('');
    }
    expect(config.adminEmail).toContain('@');
  });

  it('honors explicit organization and admin overrides', () => {
    const config = parseZapSeedConfig({
      ...completeEnv,
      ZAP_SEED_ORGANIZATION_NAME: 'Scan Org',
      ZAP_SEED_ORGANIZATION_SLUG: 'scan-org',
      ZAP_SEED_ADMIN_NAME: 'Scan Admin',
      ZAP_SEED_ADMIN_EMAIL: 'scan-admin@example.test',
    });
    expect(config.organizationName).toBe('Scan Org');
    expect(config.organizationSlug).toBe('scan-org');
    expect(config.adminName).toBe('Scan Admin');
    expect(config.adminEmail).toBe('scan-admin@example.test');
  });

  it('strips a trailing slash from the target URL', () => {
    expect(
      parseZapSeedConfig({ ...completeEnv, ZAP_TARGET_URL: 'http://127.0.0.1:3000/' }).baseUrl,
    ).toBe('http://127.0.0.1:3000');
  });

  it.each(['DATABASE_URL', 'BETTER_AUTH_SECRET', 'ZAP_TARGET_URL'] as const)(
    'fails fast naming %s when it is missing or blank, without echoing any value',
    (name) => {
      for (const bad of [undefined, '', '   ']) {
        const env = { ...completeEnv, [name]: bad };
        let message = '';
        try {
          parseZapSeedConfig(env);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain(name);
        expect(message).not.toContain(SECRET_MARKER);
        expect(message).not.toContain(DB_MARKER);
      }
    },
  );

  it.each(['not a url', 'ftp://127.0.0.1:3000', 'javascript:alert(1)'])(
    'rejects a ZAP_TARGET_URL that is not an http(s) URL: %s',
    (url) => {
      expect(() => parseZapSeedConfig({ ...completeEnv, ZAP_TARGET_URL: url })).toThrow(
        /ZAP_TARGET_URL/,
      );
    },
  );
});

describe('ZAP seed script: session cookie handed to ZAP_AUTH_HEADER', () => {
  it('builds a Cookie header from Set-Cookie values, dropping attributes', () => {
    const header = buildZapAuthHeader([
      'better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
      'better-auth.session_data=xyz; Path=/; HttpOnly',
    ]);
    expect(header.name).toBe('Cookie');
    expect(header.value).toBe('better-auth.session_token=abc.def; better-auth.session_data=xyz');
    expect(header.value).not.toMatch(/HttpOnly|Path=|Max-Age|SameSite/i);
  });

  it('fails closed when sign-in produced no cookie', () => {
    expect(() => buildZapAuthHeader([])).toThrow();
  });

  it('signs in over HTTP with the one-time password and returns the cookie', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'set-cookie': 'better-auth.session_token=tok.sig; Path=/; HttpOnly' },
        }),
      ),
    );
    const cookie = await signInForSessionCookie({
      baseUrl: 'http://127.0.0.1:3000',
      email: 'zap-admin@example.test',
      password: 'one-time-pw',
      fetch: fetchMock,
    });
    expect(cookie).toBe('better-auth.session_token=tok.sig');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requestUrl =
      typeof url === 'string' ? url : url instanceof URL ? url.href : (url?.url ?? '');
    const body = typeof init?.body === 'string' ? init.body : '';
    expect(requestUrl).toBe('http://127.0.0.1:3000/api/auth/sign-in/email');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(body)).toMatchObject({
      email: 'zap-admin@example.test',
      password: 'one-time-pw',
    });
  });

  it('fails when sign-in is refused, without leaking the password', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ code: 'INVALID' }), { status: 401 })),
    );
    let message = '';
    try {
      await signInForSessionCookie({
        baseUrl: 'http://127.0.0.1:3000',
        email: 'zap-admin@example.test',
        password: 'one-time-pw-MARKER',
        fetch: fetchMock,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('one-time-pw-MARKER');
  });
});

describe('ZAP baseline workflow pin (Q30)', () => {
  it('pins zaproxy/action-baseline by the v0.9.0 commit SHA', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );
    expect(workflow).toContain('zaproxy/action-baseline@41aee98ebc7cf2802c3beae4e7d4336413a21e43');
    expect(workflow).not.toMatch(/zaproxy\/action-baseline@(?![0-9a-f]{40}\b)/);
    expect(workflow).toContain('ZAP_AUTH_HEADER');
  });
});
