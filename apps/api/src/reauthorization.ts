/**
 * Visma Connect step-up re-authorization over HTTP (task 23.8, design Q36, D25).
 *
 * `start` builds the authorization URL (`max_age=300`, `prompt=login`,
 * `acr_values=urn:idp:vismaconnect:mfa`, PKCE S256, a 256-bit `nonce`,
 * `response_mode=query`) for a session that Visma Connect established, and
 * remembers the `state` in `auth.verification`, bound to that session's token
 * (048 design D6: the stored binding also holds the nonce). `complete` exchanges the callback's
 * code, verifies the ID token's signature, issuer, audience and bound `nonce` (D6), and stores
 * the returned ID token under the session; `lookup` hands it to the step-up
 * guard, which validates `auth_time`, `acr`, `amr` and `sid` server-side (D25).
 * The callback is bound to the browser (048 design D6): after the single-use
 * `state` is consumed, the request's session cookie must resolve to the bound
 * session, or the callback fails as `session_mismatch`. Nothing from the
 * provider or the token reaches logs or errors.
 *
 * 003 design D11 (Q27 B2, Q29): a completed callback emits
 * `auth.security.step_up_succeeded` (`visma_connect`) for the bound session's
 * tenant and actor; a failed one emits `auth.security.reauthorization_failed`
 * with only its reason.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  emitReauthorizationFailed,
  emitStepUpSucceeded,
  verifyReauthorizationIdToken,
  type AuthInstance,
} from '@tayzu/auth';
import type { createPool } from '@tayzu/db';

type Pool = ReturnType<typeof createPool>;

export interface ReauthorizationOptions {
  readonly auth: AuthInstance;
  readonly authPool: Pool;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Absolute URL of the callback route, registered at Visma Connect. */
  readonly redirectUri: string;
  /** Unexpired `state` rows one session may hold at once (default 5); beyond it `start` inserts none. */
  readonly maxPendingPerSession?: number;
}

/** design D25: freshness threshold, the same 5 minutes as local step-up. */
const MAX_AGE_SECONDS = 300;
const ACR_VALUES = 'urn:idp:vismaconnect:mfa';
const STATE_TTL_SECONDS = 600;
/** The stored ID token lives as long as it can still pass D25's `auth_time` check. */
const RESULT_TTL_SECONDS = MAX_AGE_SECONDS + 30;
const DEFAULT_MAX_PENDING_PER_SESSION = 5;
const HTTP_TIMEOUT_MS = 5_000;

const STATE_PREFIX = 'sso-reauth-state:';
const RESULT_PREFIX = 'sso-reauth-result:';

interface SessionSurface {
  getSession(args: { headers: Headers }): Promise<{
    session: { token: string; ssoSid?: string | null };
  } | null>;
}

/** What `complete` reads back from a state row: the session's token, PKCE verifier and nonce. */
interface StateBinding {
  readonly token: string;
  readonly verifier: string;
  /** 048 design D6: the ID token must carry this value. */
  readonly nonce: string;
}

interface BoundSession {
  readonly userId: string;
  readonly activeOrganizationId: string | null;
}

interface Discovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface Reauthorization {
  /** The authorization URL for a Visma-Connect-established session; `null` for any other caller. */
  start(headers: Headers): Promise<string | null>;
  /** The stored ID token for the caller's session, if a callback recorded one still in date. */
  lookup(headers: Headers): Promise<{ readonly idToken: string } | null>;
  /**
   * Handles the callback; resolves `true` when an ID token was stored for the bound session.
   * `headers` are the callback request's: its session cookie must be the bound session's.
   */
  complete(
    params: { readonly code?: unknown; readonly state?: unknown },
    headers: Headers,
  ): Promise<boolean>;
}

/** The stored value of a consumed state row; `null` when absent or not the shape `start` wrote. */
function parseBinding(raw: string | undefined): StateBinding | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { token, verifier, nonce } = parsed as Record<string, unknown>;
    return typeof token === 'string' &&
      typeof verifier === 'string' &&
      typeof nonce === 'string' &&
      nonce !== ''
      ? { token, verifier, nonce }
      : null;
  } catch {
    return null;
  }
}

/** Constant-time equality over SHA-256 digests, so unequal lengths leak nothing (048 design D6). */
function sameToken(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

async function fetchDiscovery(url: string): Promise<Discovery | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = body['authorization_endpoint'];
  const tokenEndpoint = body['token_endpoint'];
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    return null;
  }
  return { authorizationEndpoint, tokenEndpoint };
}

export function createReauthorization(options: ReauthorizationOptions): Reauthorization {
  const api = options.auth.api as SessionSurface;

  async function ssoSession(headers: Headers): Promise<string | null> {
    const found = await api.getSession({ headers }).catch(() => null);
    const sid = found?.session.ssoSid;
    return found !== null && typeof sid === 'string' && sid !== '' ? found.session.token : null;
  }

  async function store(identifier: string, value: string, ttlSeconds: number): Promise<void> {
    await options.authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, $3, now() + make_interval(secs => $4))`,
      [randomUUID(), identifier, value, ttlSeconds],
    );
  }

  /** The `auth.session` row a state is bound to, or `null` when that session no longer exists. */
  async function boundSession(token: string): Promise<BoundSession | null> {
    const found = await options.authPool.query<BoundSession>(
      `select user_id as "userId", active_organization_id as "activeOrganizationId"
       from auth.session where token = $1`,
      [token],
    );
    return found.rows[0] ?? null;
  }

  /** Exchanges the callback's code for an ID token; `null` when the provider returns none. */
  async function exchangeCode(code: string, verifier: string): Promise<string | null> {
    const discovery = await fetchDiscovery(options.discoveryUrl);
    if (discovery === null) {
      return null;
    }
    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as Record<string, unknown>;
    const idToken = body['id_token'];
    return typeof idToken === 'string' ? idToken : null;
  }

  return {
    async start(headers) {
      const token = await ssoSession(headers);
      if (token === null) {
        return null;
      }
      const discovery = await fetchDiscovery(options.discoveryUrl).catch(() => null);
      if (discovery === null) {
        return null;
      }
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      // 048 design D6: a fresh 256-bit nonce per start, bound with the state to this session.
      const nonce = randomBytes(32).toString('base64url');
      // One statement: the insert happens only while the session is under its bound (VCDM M13).
      const inserted = await options.authPool.query(
        `insert into auth.verification (id, identifier, value, expires_at)
         select $1, $2, $3, now() + make_interval(secs => $4)
         where (
           select count(*) from auth.verification
           where identifier like $5 and expires_at > now() and position($6 in value) = 1
         ) < $7`,
        [
          randomUUID(),
          `${STATE_PREFIX}${state}`,
          // The token stays the first key: the pending bound below matches the value's prefix.
          JSON.stringify({ token, verifier, nonce }),
          STATE_TTL_SECONDS,
          `${STATE_PREFIX}%`,
          `{"token":${JSON.stringify(token)},`,
          options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION,
        ],
      );
      if (inserted.rowCount === 0) {
        return null;
      }
      const url = new URL(discovery.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('scope', 'openid');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('max_age', String(MAX_AGE_SECONDS));
      url.searchParams.set('prompt', 'login');
      url.searchParams.set('acr_values', ACR_VALUES);
      return url.toString();
    },

    async lookup(headers) {
      const token = await ssoSession(headers);
      if (token === null) {
        return null;
      }
      const result = await options.authPool.query<{ value: string }>(
        `select value from auth.verification
         where identifier = $1 and expires_at > now()
         order by created_at desc limit 1`,
        [`${RESULT_PREFIX}${token}`],
      );
      const idToken = result.rows[0]?.value;
      return idToken === undefined ? null : { idToken };
    },

    async complete(params, headers) {
      if (typeof params.code !== 'string' || typeof params.state !== 'string') {
        emitReauthorizationFailed('invalid_state');
        return false;
      }
      // Single use: the state row is consumed by the first callback that presents it.
      const consumed = await options.authPool.query<{ value: string }>(
        `delete from auth.verification
         where identifier = $1 and expires_at > now()
         returning value`,
        [`${STATE_PREFIX}${params.state}`],
      );
      const binding = parseBinding(consumed.rows[0]?.value);
      if (binding === null) {
        emitReauthorizationFailed('invalid_state');
        return false;
      }
      // 048 design D6: after the consume, so a callback replayed into another browser burns
      // the state. No cookie, an invalid one or another session's is a mismatch.
      const cookieToken = await ssoSession(headers);
      if (cookieToken === null || !sameToken(cookieToken, binding.token)) {
        emitReauthorizationFailed('session_mismatch');
        return false;
      }
      const session = await boundSession(binding.token);
      if (session === null) {
        emitReauthorizationFailed('invalid_state');
        return false;
      }
      try {
        const idToken = await exchangeCode(params.code, binding.verifier);
        // 048 design D6 (Q22): a token without the bound nonce is another exchange failure.
        if (
          idToken === null ||
          !(await verifyReauthorizationIdToken(idToken, {
            discoveryUrl: options.discoveryUrl,
            clientId: options.clientId,
            nonce: binding.nonce,
          }))
        ) {
          emitReauthorizationFailed('exchange_failed');
          return false;
        }
        // The guard still checks the D25 step-up claims; this only records the result.
        await options.authPool.query('delete from auth.verification where identifier = $1', [
          `${RESULT_PREFIX}${binding.token}`,
        ]);
        await store(`${RESULT_PREFIX}${binding.token}`, idToken, RESULT_TTL_SECONDS);
      } catch {
        emitReauthorizationFailed('exchange_failed');
        return false;
      }
      // design D11 (Q27 B2): the tenant and actor of the session the state is bound to.
      emitStepUpSucceeded({
        actorId: session.userId,
        tenantId: session.activeOrganizationId ?? undefined,
        method: 'visma_connect',
      });
      return true;
    },
  };
}
