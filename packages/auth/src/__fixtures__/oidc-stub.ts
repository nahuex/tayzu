/**
 * Local OIDC provider stub (task 19.1, resolved decisions Q16-Q21). No test
 * in this package ever calls the real Visma Connect: SSO tests point
 * `genericOAuth`'s `discoveryUrl` at `stub.discoveryUrl` instead.
 *
 * It has its own RSA keypair (node:crypto only, no new dependency), a
 * discovery document, a JWKS, and authorization / token / userinfo
 * endpoints. The authorization endpoint auto-approves and honours
 * `response_mode` (`query` redirect or `form_post` auto-submitting page).
 * The token endpoint checks the client credentials, the redirect URI and
 * the PKCE S256 verifier. Tests choose the identity that the next
 * authorization signs in with through `setSubject`, and can mint arbitrary
 * signed tokens (for example back-channel `logout_token`s) with `signJwt`.
 */
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OidcStubSubject {
  sub: string;
  email?: string;
  name?: string;
  sid?: string;
  /** Extra claims merged into the ID token (for example `acr`, `amr`). */
  claims?: Record<string, unknown>;
}

export interface OidcStubOptions {
  clientId?: string;
  clientSecret?: string;
}

export interface OidcStub {
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly kid: string;
  readonly publicKey: KeyObject;
  /** Sets the identity the next authorization requests sign in as. */
  setSubject: (subject: OidcStubSubject) => void;
  /** Signs any payload with the stub's key (RS256, `kid` header). */
  signJwt: (payload: Record<string, unknown>) => string;
  /** Authorization requests received, oldest first. */
  readonly authorizationRequests: readonly Record<string, string>[];
  close: () => Promise<void>;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

interface IssuedCode {
  subject: OidcStubSubject;
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  codeChallenge: string | undefined;
}

export async function startOidcStub(options: OidcStubOptions = {}): Promise<OidcStub> {
  const clientId = options.clientId ?? 'tayzu-test-client';
  const clientSecret = options.clientSecret ?? randomBytes(16).toString('hex');
  const kid = `stub-${randomBytes(4).toString('hex')}`;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };

  let subject: OidcStubSubject = { sub: `stub-sub-${randomBytes(4).toString('hex')}` };
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, OidcStubSubject>();
  const authorizationRequests: Record<string, string>[] = [];
  let issuer = '';

  const signJwt = (payload: Record<string, unknown>): string => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(payload));
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64url(signature)}`;
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readForm = async (req: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };

  const handleAuthorize = (url: URL, res: ServerResponse): void => {
    const params = Object.fromEntries(url.searchParams);
    authorizationRequests.push(params);
    const redirectUri = params['redirect_uri'];
    if (params['client_id'] !== clientId || redirectUri === undefined) {
      json(res, 400, { error: 'invalid_request' });
      return;
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      subject,
      clientId,
      redirectUri,
      nonce: params['nonce'],
      codeChallenge: params['code_challenge'],
    });
    const result: Record<string, string> = { code, iss: issuer };
    if (params['state'] !== undefined) result['state'] = params['state'];
    if (params['response_mode'] === 'form_post') {
      const inputs = Object.entries(result)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
        .join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><body onload="document.forms[0].submit()"><form method="post" action="${redirectUri}">${inputs}</form></body></html>`,
      );
      return;
    }
    const target = new URL(redirectUri);
    for (const [k, v] of Object.entries(result)) target.searchParams.set(k, v);
    res.writeHead(302, { location: target.toString() });
    res.end();
  };

  const clientAuthOk = (req: IncomingMessage, form: URLSearchParams): boolean => {
    const basic = req.headers.authorization;
    if (basic?.startsWith('Basic ') === true) {
      const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      return (
        decodeURIComponent(id ?? '') === clientId &&
        decodeURIComponent(secret ?? '') === clientSecret
      );
    }
    return form.get('client_id') === clientId && form.get('client_secret') === clientSecret;
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = await readForm(req);
    if (!clientAuthOk(req, form)) {
      json(res, 401, { error: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    codes.delete(code); // single use
    if (
      form.get('grant_type') !== 'authorization_code' ||
      issued === undefined ||
      issued.redirectUri !== form.get('redirect_uri')
    ) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    if (issued.codeChallenge !== undefined) {
      const verifier = form.get('code_verifier') ?? '';
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (expected !== issued.codeChallenge) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const s = issued.subject;
    const idToken = signJwt({
      iss: issuer,
      aud: issued.clientId,
      sub: s.sub,
      iat: now,
      exp: now + 300,
      ...(issued.nonce !== undefined ? { nonce: issued.nonce } : {}),
      ...(s.email !== undefined ? { email: s.email } : {}),
      ...(s.name !== undefined ? { name: s.name } : {}),
      ...(s.sid !== undefined ? { sid: s.sid } : {}),
      ...s.claims,
    });
    const accessToken = randomBytes(24).toString('hex');
    accessTokens.set(accessToken, s);
    json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  };

  const handleUserinfo = (req: IncomingMessage, res: ServerResponse): void => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const s = accessTokens.get(token);
    if (s === undefined) {
      json(res, 401, { error: 'invalid_token' });
      return;
    }
    json(res, 200, {
      sub: s.sub,
      ...(s.email !== undefined ? { email: s.email } : {}),
      ...(s.name !== undefined ? { name: s.name } : {}),
    });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    void (async () => {
      switch (route) {
        case 'GET /.well-known/openid-configuration':
          json(res, 200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ['code'],
            response_modes_supported: ['query', 'form_post'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['openid', 'email', 'profile'],
            backchannel_logout_supported: true,
            backchannel_logout_session_supported: true,
          });
          return;
        case 'GET /jwks':
          json(res, 200, { keys: [jwk] });
          return;
        case 'GET /authorize':
          handleAuthorize(url, res);
          return;
        case 'POST /token':
          await handleToken(req, res);
          return;
        case 'GET /userinfo':
          handleUserinfo(req, res);
          return;
        default:
          json(res, 404, { error: 'not_found' });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    clientId,
    clientSecret,
    kid,
    publicKey,
    setSubject: (next) => {
      subject = next;
    },
    signJwt,
    authorizationRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
