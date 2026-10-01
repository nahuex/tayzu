/**
 * Validation of the `logout_token` Visma Connect posts to the back-channel
 * logout endpoint (task 22.1, design D26).
 *
 * Checks run in order and fail closed at the first failing one: signature
 * (RS256, key named by `kid` in the discovered JWKS, `node:crypto` only),
 * `typ`, `iss`, `aud`, `iat`/`exp` (+-30s skew), `events`, no `nonce`. Any
 * failure resolves `null`; nothing from the token or the provider reaches
 * logs, spans or errors.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

const LOGOUT_TOKEN_TYP = 'logout+jwt';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const LOGOUT_SKEW_SECONDS = 30;
const DISCOVERY_TIMEOUT_MS = 5_000;

export interface LogoutTokenExpectation {
  readonly discoveryUrl: string;
  readonly clientId: string;
}

/** The claims a verified logout token contributes to later steps (replay, revocation). */
export interface VerifiedLogoutToken {
  readonly jti: string | undefined;
  readonly exp: number;
  readonly sid: string | undefined;
  readonly sub: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePart(part: string | undefined): Record<string, unknown> | null {
  if (part === undefined) {
    return null;
  }
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return isRecord(value) ? value : null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!response.ok) {
    return null;
  }
  const body: unknown = await response.json();
  return isRecord(body) ? body : null;
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  return Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Resolves the verified token's claims, or `null` when any D26 check fails. */
export async function verifyLogoutToken(
  logoutToken: string,
  expected: LogoutTokenExpectation,
): Promise<VerifiedLogoutToken | null> {
  try {
    const [headPart, bodyPart, signaturePart, ...rest] = logoutToken.split('.');
    if (signaturePart === undefined || rest.length > 0) {
      return null;
    }
    const header = decodePart(headPart);
    const claims = decodePart(bodyPart);
    if (header === null || claims === null || header['alg'] !== 'RS256') {
      return null;
    }

    // 1. Signature, against the discovery document's JWKS.
    const discovery = await fetchJson(expected.discoveryUrl);
    const issuer = discovery?.['issuer'];
    const jwksUri = discovery?.['jwks_uri'];
    if (typeof issuer !== 'string' || typeof jwksUri !== 'string') {
      return null;
    }
    const jwks = await fetchJson(jwksUri);
    const keys = Array.isArray(jwks?.['keys']) ? (jwks['keys'] as unknown[]) : [];
    const jwk = keys.find(
      (key): key is JsonWebKey & Record<string, unknown> =>
        isRecord(key) && key['kid'] === header['kid'] && key['kty'] === 'RSA',
    );
    if (jwk === undefined) {
      return null;
    }
    const signatureValid = createVerify('RSA-SHA256')
      .update(`${headPart ?? ''}.${bodyPart ?? ''}`)
      .verify(
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signaturePart, 'base64url'),
      );
    if (!signatureValid) {
      return null;
    }

    // 2. `typ` header.
    if (header['typ'] !== LOGOUT_TOKEN_TYP) {
      return null;
    }
    // 3. `iss` and `aud`.
    if (claims['iss'] !== issuer || !audienceMatches(claims['aud'], expected.clientId)) {
      return null;
    }
    // 4. `iat` / `exp` with the skew allowance.
    const { iat, exp } = claims;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      iat - LOGOUT_SKEW_SECONDS > now ||
      exp + LOGOUT_SKEW_SECONDS < now
    ) {
      return null;
    }
    // 5. `events` carries the back-channel logout member.
    const events = claims['events'];
    if (!isRecord(events) || !Object.hasOwn(events, LOGOUT_EVENT)) {
      return null;
    }
    // 6. No `nonce`.
    if (Object.hasOwn(claims, 'nonce')) {
      return null;
    }

    return {
      jti: optionalString(claims['jti']),
      exp,
      sid: optionalString(claims['sid']),
      sub: optionalString(claims['sub']),
    };
  } catch {
    return null;
  }
}
