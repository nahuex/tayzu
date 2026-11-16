/**
 * `044` task 3.5 (design D3 "Link", D9, D14). Scenario: "The link carries the
 * token in the fragment on the configured origin".
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/password-reset-link.ts (does not exist yet)
 * export function buildPasswordResetLink(input: {
 *   readonly baseUrl: string; // PASSWORD_RESET_LINK_BASE_URL
 *   readonly resetId: string;
 *   readonly token: string;
 * }): string; // `${origin}/reset-password#reset=<id>&token=<token>`
 * ```
 *
 * Like `buildInvitationLink`, the builder takes no request, header or
 * `BETTER_AUTH_URL` input: the origin can only come from the trusted setting.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildPasswordResetLink } from './password-reset-link.js';

const BASE_URL = 'https://app.tayzu.test';
const ID = `rst${randomBytes(8).toString('hex')}`;
const TOKEN = `tok_${randomBytes(24).toString('base64url')}`;

describe('The link carries the token in the fragment on the configured origin (044 task 3.5)', () => {
  it('starts with the configured PASSWORD_RESET_LINK_BASE_URL despite forged Host and X-Forwarded-Host', () => {
    // A request carrying forged origin headers is in flight while the link is built.
    const forged = new Request('https://api.tayzu.test/v1/auth/password-reset/request', {
      method: 'POST',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      },
    });
    expect(forged.headers.get('x-forwarded-host')).toBe('evil.example');

    const link = buildPasswordResetLink({ baseUrl: BASE_URL, resetId: ID, token: TOKEN });

    expect(link.startsWith(`${BASE_URL}/`)).toBe(true);
    expect(new URL(link).origin).toBe(BASE_URL);
    expect(link).not.toContain('evil.example');
    expect(link).not.toContain('api.tayzu.test');
  });

  it('uses the fixed path /reset-password with no query string', () => {
    const url = new URL(buildPasswordResetLink({ baseUrl: BASE_URL, resetId: ID, token: TOKEN }));
    expect(url.pathname).toBe('/reset-password');
    expect(url.search).toBe('');
  });

  it('carries the id and the token only after the #', () => {
    const link = buildPasswordResetLink({ baseUrl: BASE_URL, resetId: ID, token: TOKEN });
    const hashIndex = link.indexOf('#');
    expect(hashIndex).toBeGreaterThan(0);

    const beforeFragment = link.slice(0, hashIndex);
    expect(beforeFragment).not.toContain(ID);
    expect(beforeFragment).not.toContain(TOKEN);
    expect(link.slice(hashIndex + 1)).toBe(`reset=${ID}&token=${TOKEN}`);

    const url = new URL(link);
    expect(url.hash).toBe(`#reset=${ID}&token=${TOKEN}`);
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('reset')).toBe(ID);
    expect(params.get('token')).toBe(TOKEN);
  });

  it('keeps only the origin of a base URL given with a trailing slash', () => {
    const link = buildPasswordResetLink({
      baseUrl: `${BASE_URL}/`,
      resetId: ID,
      token: TOKEN,
    });
    expect(link).toBe(`${BASE_URL}/reset-password#reset=${ID}&token=${TOKEN}`);
  });
});
