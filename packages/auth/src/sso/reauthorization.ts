/**
 * Server-side validation of the ID token a Visma Connect step-up
 * re-authorization returns (task 21.3, design D25).
 *
 * The guard never trusts that `max_age`/`prompt`/`acr_values` survived the
 * browser: it verifies the returned token's signature against the discovered
 * JWKS (RS256, `node:crypto` only), then `iss`, `aud`, `exp`, `sid`, and the
 * step-up claims `auth_time` (300s, +-30s skew), `acr` (>= 3) and `amr`
 * (an accepted MFA method). Any failure returns `false`; nothing from the
 * token or the provider reaches logs, spans or errors.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

/** design D25: the step-up freshness window, and the skew tolerance shared with D26. */
export const REAUTH_MAX_AGE_SECONDS = 300;
export const REAUTH_SKEW_SECONDS = 30;
const MIN_ACR = 3;
const DISCOVERY_TIMEOUT_MS = 5_000;

/** design D25: `id-token.md`'s accepted MFA / electronic-ID `amr` values. */
const ACCEPTED_AMR = new Set([
  'otp',
  'push',
  'pop',
  'hwk',
  'face_fpt',
  'sms',
  'mfa',
  'pwdless',
  'nbid',
  'nbid-biometric',
  'sbid',
  'sbid-mobile',
  'mitid',
  'mitid-erhverv',
  'fbid',
]);
const ACCEPTED_AMR_PREFIXES = ['mitid:', 'fbid:method:'];

export interface ReauthorizationExpectation {
  readonly discoveryUrl: string;
  readonly clientId: string;
  /** The session's `ssoSid`; the token must belong to the same Visma Connect session. */
  readonly sid: string;
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

function isAcceptedAmr(method: unknown): boolean {
  return (
    typeof method === 'string' &&
    (ACCEPTED_AMR.has(method) || ACCEPTED_AMR_PREFIXES.some((prefix) => method.startsWith(prefix)))
  );
}

function acrLevel(acr: unknown): number {
  if (typeof acr === 'number') {
    return acr;
  }
  return typeof acr === 'string' && acr.trim() !== '' ? Number(acr) : Number.NaN;
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  return Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
}

/** Whether the claims satisfy issuer, audience, expiry, session and D25's step-up checks. */
function claimsSatisfyStepUp(
  claims: Record<string, unknown>,
  issuer: string,
  expected: ReauthorizationExpectation,
  nowSeconds: number,
): boolean {
  const { exp, auth_time: authTime, acr, amr, sid } = claims;
  if (claims['iss'] !== issuer || !audienceMatches(claims['aud'], expected.clientId)) {
    return false;
  }
  if (typeof exp !== 'number' || exp + REAUTH_SKEW_SECONDS < nowSeconds) {
    return false;
  }
  if (sid !== expected.sid) {
    return false;
  }
  if (
    typeof authTime !== 'number' ||
    nowSeconds - authTime > REAUTH_MAX_AGE_SECONDS + REAUTH_SKEW_SECONDS ||
    authTime - nowSeconds > REAUTH_SKEW_SECONDS
  ) {
    return false;
  }
  if (!(acrLevel(acr) >= MIN_ACR)) {
    return false;
  }
  return Array.isArray(amr) && amr.some(isAcceptedAmr);
}

/** Resolves `true` only when the ID token verifies and satisfies every D25 check. */
export async function isValidReauthorization(
  idToken: string,
  expected: ReauthorizationExpectation,
): Promise<boolean> {
  try {
    const [headPart, bodyPart, signaturePart, ...rest] = idToken.split('.');
    if (signaturePart === undefined || rest.length > 0) {
      return false;
    }
    const header = decodePart(headPart);
    const claims = decodePart(bodyPart);
    if (header === null || claims === null || header['alg'] !== 'RS256') {
      return false;
    }
    const discovery = await fetchJson(expected.discoveryUrl);
    const issuer = discovery?.['issuer'];
    const jwksUri = discovery?.['jwks_uri'];
    if (typeof issuer !== 'string' || typeof jwksUri !== 'string') {
      return false;
    }
    const jwks = await fetchJson(jwksUri);
    const keys = Array.isArray(jwks?.['keys']) ? (jwks['keys'] as unknown[]) : [];
    const jwk = keys.find(
      (key): key is JsonWebKey & Record<string, unknown> =>
        isRecord(key) && key['kid'] === header['kid'] && key['kty'] === 'RSA',
    );
    if (jwk === undefined) {
      return false;
    }
    const verified = createVerify('RSA-SHA256')
      .update(`${headPart ?? ''}.${bodyPart ?? ''}`)
      .verify(
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signaturePart, 'base64url'),
      );
    return verified && claimsSatisfyStepUp(claims, issuer, expected, Math.floor(Date.now() / 1000));
  } catch {
    return false;
  }
}
