/**
 * `043` task 6.3 (design D5, Resolved decision Q32). Scenario: "The link origin
 * ignores the request headers".
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/invitation-link.ts (does not exist yet)
 * export function buildInvitationLink(input: {
 *   readonly baseUrl: string; // Config.invitationLinkBaseUrl (INVITATION_LINK_BASE_URL)
 *   readonly invitationId: string;
 *   readonly token: string;
 * }): string; // `${origin}/accept-invitation#invitation=<id>&token=<token>`
 * ```
 *
 * The builder takes no request, header or `BETTER_AUTH_URL` input at all: the
 * origin can only come from the trusted setting. `Config.invitationLinkBaseUrl`
 * is covered in `config.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { buildInvitationLink } from './invitation-link.js';

const BASE_URL = 'https://app.tayzu.test';
const ID = 'inv_0123456789abcdef';
const TOKEN = 'tok_Zm9vYmFyLWJheg-_0123456789';

function configEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    BETTER_AUTH_SECRET: 'invitation-link-test-only-secret-0123456789-abcdef',
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: 'https://app.tayzu.test',
    BETTER_AUTH_URL: 'https://api.tayzu.test',
    INVITATION_LINK_BASE_URL: BASE_URL,
  };
}

describe('The link origin ignores the request headers (043 task 6.3, Q32)', () => {
  it('starts with the configured INVITATION_LINK_BASE_URL despite forged Host and X-Forwarded-Host', () => {
    const config = loadConfig(configEnv());
    // A request carrying forged origin headers is in flight while the link is built.
    const forged = new Request('https://api.tayzu.test/v1/identity/invite', {
      method: 'POST',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      },
    });
    expect(forged.headers.get('x-forwarded-host')).toBe('evil.example');

    const link = buildInvitationLink({
      baseUrl: config.invitationLinkBaseUrl ?? '',
      invitationId: ID,
      token: TOKEN,
    });

    expect(config.invitationLinkBaseUrl).toBe(BASE_URL);
    expect(link.startsWith(`${BASE_URL}/`)).toBe(true);
    expect(new URL(link).origin).toBe(BASE_URL);
    expect(link).not.toContain('evil.example');
  });

  it('never uses BETTER_AUTH_URL as the origin', () => {
    const link = buildInvitationLink({ baseUrl: BASE_URL, invitationId: ID, token: TOKEN });
    expect(link).not.toContain('api.tayzu.test');
  });

  it('uses the fixed path /accept-invitation', () => {
    const url = new URL(buildInvitationLink({ baseUrl: BASE_URL, invitationId: ID, token: TOKEN }));
    expect(url.pathname).toBe('/accept-invitation');
    expect(url.search).toBe('');
  });

  it('carries the invitation id and the token only after the #', () => {
    const link = buildInvitationLink({ baseUrl: BASE_URL, invitationId: ID, token: TOKEN });
    const hashIndex = link.indexOf('#');
    expect(hashIndex).toBeGreaterThan(0);

    const beforeFragment = link.slice(0, hashIndex);
    const fragment = link.slice(hashIndex + 1);
    expect(beforeFragment).not.toContain(ID);
    expect(beforeFragment).not.toContain(TOKEN);
    expect(fragment).toBe(`invitation=${ID}&token=${TOKEN}`);

    const url = new URL(link);
    expect(url.hash).toBe(`#invitation=${ID}&token=${TOKEN}`);
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('invitation')).toBe(ID);
    expect(params.get('token')).toBe(TOKEN);
  });

  it('keeps only the origin of a base URL given with a trailing slash', () => {
    const link = buildInvitationLink({
      baseUrl: `${BASE_URL}/`,
      invitationId: ID,
      token: TOKEN,
    });
    expect(link).toBe(`${BASE_URL}/accept-invitation#invitation=${ID}&token=${TOKEN}`);
  });
});
