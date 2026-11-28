/**
 * Validation of the `logout_token` Visma Connect posts to the back-channel
 * logout endpoint (task 22.1, design D26).
 *
 * Checks run in order and fail closed at the first failing one: `typ`, `iss`,
 * `aud`, `iat`/`exp` (+-30s skew, `exp - iat` at most 300 seconds), `events`,
 * no `nonce`, `sid` or `sub` present, then the signature last (RS256, key named
 * by `kid` in the discovered JWKS, `node:crypto` only), so only a token passing
 * every cheap check causes an outbound discovery or JWKS fetch (task 13.11 of
 * 043). Any failure resolves `null`; nothing from the token or the provider reaches
 * logs, spans or errors.
 *
 * The discovery document and the key set come from a `LogoutKeyCache` (048
 * design D8, Q25): each copy is used for at most `ttlSeconds`, an unknown `kid`
 * refreshes the key set at most once per 60 seconds, a failed fetch is never
 * cached, and with no unexpired copy the token is rejected.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

const LOGOUT_TOKEN_TYP = 'logout+jwt';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const LOGOUT_SKEW_SECONDS = 30;
/** Longest accepted `exp - iat`; a longer-lived token is rejected (048 design D8, Q25). */
const MAX_LOGOUT_TOKEN_LIFETIME_SECONDS = 300;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** At most one key-set refresh for an unknown `kid` per this window (Q25). */
const UNKNOWN_KID_REFRESH_INTERVAL_MS = 60_000;

export interface LogoutTokenExpectation {
  /** The issuer from the startup discovery, so `iss` is checked without a fetch. */
  readonly issuer: string;
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

/** Resolves the JSON object at `url`, or `null` on any network, status or parse failure. */
async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

type RsaJwk = JsonWebKey & Record<string, unknown>;

interface CachedDiscovery {
  readonly discoveryUrl: string;
  readonly jwksUri: string;
  readonly fetchedAtMs: number;
}

interface CachedKeySet {
  readonly jwksUri: string;
  /** RSA keys by `kid`; a `Map`, so a provider-supplied `kid` never reaches a prototype. */
  readonly keys: ReadonlyMap<string, RsaJwk>;
  readonly fetchedAtMs: number;
}

/**
 * The per-app cache of the provider's discovery document and key set (048 D8). Opaque to
 * callers: create one with `createLogoutKeyCache` and pass it to every `verifyLogoutToken`.
 */
export interface LogoutKeyCache {
  /** The RSA key named `kid`, or `null` when it cannot be found in an unexpired key set. */
  readonly signingKey: (discoveryUrl: string, kid: string) => Promise<RsaJwk | null>;
}

/** The RSA keys of a JWKS body, or `null` when the body is not a key set. */
function parseKeySet(
  jwksUri: string,
  body: Record<string, unknown> | null,
  nowMs: number,
): CachedKeySet | null {
  const listed = body?.['keys'];
  if (!Array.isArray(listed)) {
    return null;
  }
  const keys = new Map<string, RsaJwk>();
  for (const key of listed as unknown[]) {
    if (isRecord(key) && typeof key['kid'] === 'string' && key['kty'] === 'RSA') {
      keys.set(key['kid'], key);
    }
  }
  return { jwksUri, keys, fetchedAtMs: nowMs };
}

/** Creates a cache whose copies are used for at most `ttlSeconds` (600 in production, Q25). */
export function createLogoutKeyCache(options: { readonly ttlSeconds: number }): LogoutKeyCache {
  if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive number');
  }
  const ttlMs = options.ttlSeconds * 1000;
  let discovery: CachedDiscovery | undefined;
  let keySet: CachedKeySet | undefined;
  let lastUnknownKidRefreshMs: number | undefined;

  // A clock that moved backwards makes a copy expired too: fail closed.
  const isFresh = (fetchedAtMs: number, nowMs: number): boolean =>
    nowMs >= fetchedAtMs && nowMs - fetchedAtMs < ttlMs;

  async function jwksUriFor(discoveryUrl: string, nowMs: number): Promise<string | null> {
    if (
      discovery !== undefined &&
      discovery.discoveryUrl === discoveryUrl &&
      isFresh(discovery.fetchedAtMs, nowMs)
    ) {
      return discovery.jwksUri;
    }
    discovery = undefined;
    const jwksUri = (await fetchJson(discoveryUrl))?.['jwks_uri'];
    if (typeof jwksUri !== 'string') {
      return null;
    }
    discovery = { discoveryUrl, jwksUri, fetchedAtMs: nowMs };
    return jwksUri;
  }

  async function refreshKeySet(jwksUri: string, nowMs: number): Promise<CachedKeySet | null> {
    const fetched = parseKeySet(jwksUri, await fetchJson(jwksUri), nowMs);
    if (fetched !== null) {
      keySet = fetched;
    }
    return fetched;
  }

  return {
    async signingKey(discoveryUrl, kid) {
      const nowMs = Date.now();
      const jwksUri = await jwksUriFor(discoveryUrl, nowMs);
      if (jwksUri === null) {
        return null;
      }
      const cached =
        keySet !== undefined && keySet.jwksUri === jwksUri && isFresh(keySet.fetchedAtMs, nowMs)
          ? keySet
          : undefined;
      if (cached === undefined) {
        // No unexpired copy: an expired one is dropped, never used.
        keySet = undefined;
        return (await refreshKeySet(jwksUri, nowMs))?.keys.get(kid) ?? null;
      }
      const known = cached.keys.get(kid);
      if (known !== undefined) {
        return known;
      }
      // Unknown `kid` against an unexpired copy: at most one refresh per 60 seconds. The
      // attempt is stamped before the fetch, so concurrent tokens do not refresh twice.
      if (
        lastUnknownKidRefreshMs !== undefined &&
        nowMs >= lastUnknownKidRefreshMs &&
        nowMs - lastUnknownKidRefreshMs < UNKNOWN_KID_REFRESH_INTERVAL_MS
      ) {
        return null;
      }
      lastUnknownKidRefreshMs = nowMs;
      return (await refreshKeySet(jwksUri, nowMs))?.keys.get(kid) ?? null;
    },
  };
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
  keyCache: LogoutKeyCache,
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

    // 1. `typ` header.
    if (header['typ'] !== LOGOUT_TOKEN_TYP) {
      return null;
    }
    // 2. `iss` and `aud`.
    if (claims['iss'] !== expected.issuer || !audienceMatches(claims['aud'], expected.clientId)) {
      return null;
    }
    // 3. `iat` / `exp` with the skew allowance, and a bounded lifetime.
    const { iat, exp } = claims;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      iat - LOGOUT_SKEW_SECONDS > now ||
      exp + LOGOUT_SKEW_SECONDS < now ||
      exp - iat > MAX_LOGOUT_TOKEN_LIFETIME_SECONDS
    ) {
      return null;
    }
    // 4. `events` carries the back-channel logout member.
    const events = claims['events'];
    if (!isRecord(events) || !Object.hasOwn(events, LOGOUT_EVENT)) {
      return null;
    }
    // 5. No `nonce`.
    if (Object.hasOwn(claims, 'nonce')) {
      return null;
    }
    // 6. At least one of `sid` / `sub` names what to revoke.
    const sid = optionalString(claims['sid']);
    const sub = optionalString(claims['sub']);
    if (sid === undefined && sub === undefined) {
      return null;
    }

    // 7. Signature last, against the discovery document's JWKS: the only checks that
    // fetch, so a token failing any cheap check above triggers no outbound call.
    const kid = header['kid'];
    if (typeof kid !== 'string') {
      return null;
    }
    const jwk = await keyCache.signingKey(expected.discoveryUrl, kid);
    if (jwk === null) {
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

    return {
      jti: optionalString(claims['jti']),
      exp,
      sid,
      sub,
    };
  } catch {
    return null;
  }
}
