/**
 * Smoke test for the local OIDC stub (task 19.1, "Verify: the stub's own
 * smoke test, standing it up and tearing it down cleanly").
 */
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  type JsonWebKey,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startOidcStub } from './oidc-stub.js';

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('OIDC stub fixture', () => {
  it('stands up, serves a full OIDC flow with verifiable tokens, and tears down cleanly', async () => {
    const stub = await startOidcStub();
    let closed = false;
    try {
      // Discovery document
      const disc = (await (await fetch(stub.discoveryUrl)).json()) as Record<string, unknown>;
      expect(disc['issuer']).toBe(stub.issuer);
      for (const key of [
        'authorization_endpoint',
        'token_endpoint',
        'userinfo_endpoint',
        'jwks_uri',
      ]) {
        expect(typeof disc[key]).toBe('string');
      }
      expect(disc['code_challenge_methods_supported']).toContain('S256');

      // JWKS
      const jwks = (await (await fetch(disc['jwks_uri'] as string)).json()) as {
        keys: (JsonWebKey & { kid: string })[];
      };
      expect(jwks.keys).toHaveLength(1);
      const jwk = jwks.keys[0];
      expect(jwk?.kid).toBe(stub.kid);
      expect(jwk).not.toHaveProperty('d');

      // Authorization (query mode) with PKCE
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      stub.setSubject({ sub: 'sub-123', email: 'a@example.test', name: 'A', sid: 'sid-9' });
      const authUrl = new URL(disc['authorization_endpoint'] as string);
      authUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: stub.clientId,
        redirect_uri: 'http://localhost/cb',
        scope: 'openid email profile',
        state: 'st-1',
        nonce: 'nonce-1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      const authRes = await fetch(authUrl, { redirect: 'manual' });
      expect(authRes.status).toBe(302);
      const back = new URL(authRes.headers.get('location') ?? '');
      expect(back.searchParams.get('state')).toBe('st-1');
      const code = back.searchParams.get('code') ?? '';
      expect(code).not.toBe('');
      expect(stub.authorizationRequests).toHaveLength(1);

      // Token: wrong PKCE verifier is rejected, right one accepted (code is single use)
      const tokenBody = (v: string, c: string): URLSearchParams =>
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: c,
          redirect_uri: 'http://localhost/cb',
          client_id: stub.clientId,
          client_secret: stub.clientSecret,
          code_verifier: v,
        });
      const tokenUrl = disc['token_endpoint'] as string;
      const bad = await fetch(tokenUrl, { method: 'POST', body: tokenBody('wrong', code) });
      expect(bad.status).toBe(400);

      authUrl.searchParams.set('state', 'st-2');
      const second = await fetch(authUrl, { redirect: 'manual' });
      const code2 = new URL(second.headers.get('location') ?? '').searchParams.get('code') ?? '';
      const ok = await fetch(tokenUrl, { method: 'POST', body: tokenBody(verifier, code2) });
      expect(ok.status).toBe(200);
      const tokens = (await ok.json()) as { id_token: string; access_token: string };

      // ID token: RS256 signature verifies against the published JWKS, claims correct
      const [h, p, s] = tokens.id_token.split('.') as [string, string, string];
      expect(decode(h)).toMatchObject({ alg: 'RS256', kid: stub.kid });
      const claims = decode(p);
      expect(claims).toMatchObject({
        iss: stub.issuer,
        aud: stub.clientId,
        sub: 'sub-123',
        nonce: 'nonce-1',
        email: 'a@example.test',
        sid: 'sid-9',
      });
      const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
      expect(
        createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, Buffer.from(s, 'base64url')),
      ).toBe(true);

      // Userinfo
      const info = await fetch(disc['userinfo_endpoint'] as string, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      expect(await info.json()).toMatchObject({ sub: 'sub-123', email: 'a@example.test' });
      const noAuth = await fetch(disc['userinfo_endpoint'] as string);
      expect(noAuth.status).toBe(401);

      // Arbitrary signed JWTs (for later back-channel logout tests) verify too
      const [lh, lp, ls] = stub.signJwt({ iss: stub.issuer, sub: 'x' }).split('.') as [
        string,
        string,
        string,
      ];
      expect(
        createVerify('RSA-SHA256')
          .update(`${lh}.${lp}`)
          .verify(stub.publicKey, Buffer.from(ls, 'base64url')),
      ).toBe(true);

      await stub.close();
      closed = true;
      await expect(fetch(stub.discoveryUrl)).rejects.toThrow();
    } finally {
      if (!closed) await stub.close();
    }
  });

  it('supports response_mode=form_post', async () => {
    const stub = await startOidcStub();
    try {
      const url = new URL(`${stub.issuer}/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: stub.clientId,
        redirect_uri: 'http://localhost/cb',
        state: 's',
        response_mode: 'form_post',
      }).toString();
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('method="post"');
      expect(html).toContain('name="code"');
      expect(html).toContain('name="state" value="s"');
    } finally {
      await stub.close();
    }
  });
});
