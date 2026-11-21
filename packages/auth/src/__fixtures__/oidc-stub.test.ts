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
import { createServer } from 'node:net';
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

  it('with neither issuer nor port, it is its own issuer on a random 127.0.0.1 port', async () => {
    const stub = await startOidcStub();
    try {
      expect(stub.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(stub.issuer).toBe(stub.localUrl);
      expect(stub.discoveryUrl).toBe(`${stub.localUrl}/.well-known/openid-configuration`);
    } finally {
      await stub.close();
    }
  });
});

/** A port that was free a moment ago on 127.0.0.1. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/**
 * 003 task 10.1 (design D16, Q38): behind the e2e TLS reverse proxy the stub
 * advertises the proxy's public https issuer, while it listens on a fixed
 * 127.0.0.1 port the proxy forwards to.
 */
describe('OIDC stub fixture behind a TLS proxy (issuer and port options)', () => {
  const ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri'];

  it('advertises the public issuer everywhere and signs the ID token with it, on the fixed port', async () => {
    const port = await freePort();
    const issuer = 'https://localhost:8443/oidc';
    const stub = await startOidcStub({ issuer: `${issuer}/`, port, clientSecret: 'e2e-secret' });
    try {
      expect(stub.issuer).toBe(issuer);
      expect(stub.discoveryUrl).toBe(`${issuer}/.well-known/openid-configuration`);
      expect(stub.localUrl).toBe(`http://127.0.0.1:${String(port)}`);

      // Reached as the proxy reaches it: with the issuer's path, or with it stripped.
      for (const path of [
        '/oidc/.well-known/openid-configuration',
        '/.well-known/openid-configuration',
      ]) {
        const disc = (await (await fetch(`${stub.localUrl}${path}`)).json()) as Record<
          string,
          unknown
        >;
        expect(disc['issuer'], path).toBe(issuer);
        for (const key of ENDPOINTS) {
          expect(String(disc[key]), `${path} ${key}`).toMatch(/^https:\/\/localhost:8443\/oidc\//);
        }
      }

      const local = (endpoint: string): URL =>
        new URL(endpoint.replace(issuer, `${stub.localUrl}/oidc`));
      stub.setSubject({ sub: 'e2e-sub', email: 'vc@example.test', name: 'VC' });
      const authorize = local(`${issuer}/authorize`);
      authorize.search = new URLSearchParams({
        response_type: 'code',
        client_id: stub.clientId,
        redirect_uri: 'https://localhost:8443/api/auth/callback',
        state: 'st',
        nonce: 'n',
      }).toString();
      const redirect = await fetch(authorize, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      const back = new URL(redirect.headers.get('location') ?? '');
      expect(back.searchParams.get('iss')).toBe(issuer);

      const token = await fetch(local(`${issuer}/token`), {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code') ?? '',
          redirect_uri: 'https://localhost:8443/api/auth/callback',
          client_id: stub.clientId,
          client_secret: 'e2e-secret',
        }),
      });
      expect(token.status).toBe(200);
      const { id_token: idToken } = (await token.json()) as { id_token: string };
      expect(decode(idToken.split('.')[1] ?? '')).toMatchObject({
        iss: issuer,
        sub: 'e2e-sub',
        email: 'vc@example.test',
        nonce: 'n',
      });
    } finally {
      await stub.close();
    }
  });

  it('an origin issuer (no path) is served at the root', async () => {
    const stub = await startOidcStub({ issuer: 'https://localhost:8444' });
    try {
      const disc = (await (
        await fetch(`${stub.localUrl}/.well-known/openid-configuration`)
      ).json()) as Record<string, unknown>;
      expect(disc['issuer']).toBe('https://localhost:8444');
      expect(disc['jwks_uri']).toBe('https://localhost:8444/jwks');
      expect((await fetch(`${stub.localUrl}/jwks`)).status).toBe(200);
    } finally {
      await stub.close();
    }
  });

  it('refuses an issuer that is not a plain https URL, and an invalid port, before listening', async () => {
    for (const issuer of [
      'http://localhost:8443',
      'https://localhost:8443/?q=1',
      'https://localhost:8443/#f',
      'https://user:pass@localhost:8443',
      'not a url',
    ]) {
      await expect(startOidcStub({ issuer }), issuer).rejects.toThrow(/issuer/);
    }
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      await expect(startOidcStub({ port }), String(port)).rejects.toThrow(/port/);
    }
  });

  it('rejects when the fixed port is already taken', async () => {
    const first = await startOidcStub();
    try {
      const taken = Number(new URL(first.localUrl).port);
      await expect(startOidcStub({ port: taken })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.close();
    }
  });
});
