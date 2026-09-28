/**
 * Machine-credential token exchange (task 5.3, design D5; `specs/auth-and-
 * rbac/spec.md`, "Machine credentials").
 *
 * "A new procedure, `POST /v1/auth/token`, is **not** part of Better Auth's
 * own route set. It calls `auth.api.verifyApiKey({ body: { key } })`; on
 * success it mints a 1-hour token via the `jwt` plugin (`auth.api.getToken`-
 * equivalent, scoped to `{ tenantId: key.referenceId, actor: { type: key.
 * metadata.actorKind, id: key.id } }`), signed with the `jwt` plugin's own
 * key ... On failure it returns `AUTH_INVALID_CREDENTIALS`." "`actorKind`
 * (`integration` or `agent`) is fixed at credential-creation time via the
 * config's `metadata`, never chosen by the caller of `POST /v1/auth/token`."
 *
 * `auth.api.verifyApiKey` is scoped to the `machine-credential` config
 * (`./machine-credentials.ts`'s own `MACHINE_CREDENTIAL_CONFIG_ID`, mirrored
 * here): the installed `@better-auth/api-key@1.7.6` route falls back to a
 * config literally named `"default"` when `configId` is omitted
 * (`resolveConfiguration`, `dist/index.mjs`), and `./auth.ts` registers no
 * such config -- design D5's own `{ body: { key } }` quote elides this
 * scoping detail, confirmed by running this file's own tests unscoped first
 * and observing `NO_DEFAULT_API_KEY_CONFIGURATION_FOUND`.
 *
 * The installed `better-auth@1.7.6` `jwt` plugin's own session-bound `/token`
 * route (`getToken`, `dist/plugins/jwt/index.mjs`) requires a live session
 * (`sessionMiddleware`) and signs `ctx.context.session.user` -- not usable
 * here, where the caller authenticates with a client id/secret pair, not a
 * session. `auth.api.signJWT` (the same plugin's `serverOnly` endpoint, `dist/
 * plugins/jwt/index.mjs`) signs an arbitrary caller-supplied payload with the
 * identical `jwt` plugin key instead: this module's "`auth.api.getToken`-
 * equivalent" per design D5's own wording. Passing an explicit `exp` claim
 * (now + one hour) is read as-is by `signJWT` (`dist/plugins/jwt/sign.mjs`:
 * `exp = payload.exp ?? defaultExp`), which is this module's one-hour
 * expiry -- no `overrideOptions` needed.
 *
 * `auth.api.verifyApiKey` (`@better-auth/api-key@1.7.6`, `dist/index.mjs`)
 * never throws on an invalid, mismatched, or disabled (revoked) key: every
 * failure is caught internally and returned as `{ valid: false, key: null }`.
 * This module treats every such outcome identically, per the requirement
 * text ("On failure it returns `AUTH_INVALID_CREDENTIALS`") -- a caller
 * cannot distinguish an unknown client id from a revoked one.
 */
import type { AuthInstance } from './auth.js';
import { AuthInvalidCredentialsError } from './errors.js';
import type { MachineCredentialActorKind } from './machine-credentials.js';
import { tokenExchangesCounter, tracer } from './telemetry/instruments.js';

/** design D5: the one `apiKey` plugin config machine credentials live under (mirrors `./machine-credentials.ts`'s own `MACHINE_CREDENTIAL_CONFIG_ID`). */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/** design D5: the config `verifyApiKey` looks the credential up under. */
const ACTOR_KIND_METADATA_KEY = 'actorKind';

/** design D5: "a 1-hour access token." */
const ONE_HOUR_SECONDS = 60 * 60;

/** design.md, Spans/Metrics tables: `tayzu.auth.credential.kind` (`integration`|`agent`). */
const CREDENTIAL_KIND_ATTRIBUTE = 'tayzu.auth.credential.kind';
/** design.md, Metrics table: `tayzu.auth.exchange.outcome` (`success`|`invalid_credentials`). */
const EXCHANGE_OUTCOME_ATTRIBUTE = 'tayzu.auth.exchange.outcome';

export interface ExchangeMachineTokenParams {
  /** The credential's client id (`CreatedMachineCredential['id']`). Not otherwise used: `verifyApiKey` looks the credential up by its secret alone. */
  readonly clientId: string;
  /** The credential's client secret (`CreatedMachineCredential['secret']`). */
  readonly clientSecret: string;
}

/** design D5, requirement text: "MUST return an access token." */
export interface ExchangedMachineToken {
  readonly accessToken: string;
}

/**
 * The narrow slice of `auth.api.verifyApiKey`'s installed response
 * (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`) this module
 * reads.
 */
interface VerifiedApiKey {
  readonly valid: boolean;
  readonly key: {
    readonly id: string;
    readonly referenceId: string;
    readonly metadata: Record<string, unknown> | null;
  } | null;
}

/** The narrow slice of `auth.api.signJWT`'s installed response (`better-auth@1.7.6`, `dist/plugins/jwt/index.mjs`) this module reads. */
interface SignedJwt {
  readonly token: string;
}

interface AuthApiSurface {
  verifyApiKey(args: { body: { key: string; configId: string } }): Promise<VerifiedApiKey>;
  signJWT(args: { body: { payload: Record<string, unknown> } }): Promise<SignedJwt>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/** design.md, Spans table: `auth.token.exchange`; Metrics table: `tayzu.auth.token.exchanges`. */
function recordSuccessfulExchange(actorKind: MachineCredentialActorKind): void {
  tracer
    .startSpan('auth.token.exchange', { attributes: { [CREDENTIAL_KIND_ATTRIBUTE]: actorKind } })
    .end();
  tokenExchangesCounter.add(1, {
    [CREDENTIAL_KIND_ATTRIBUTE]: actorKind,
    [EXCHANGE_OUTCOME_ATTRIBUTE]: 'success',
  });
}

/**
 * Exchanges a machine credential's client id and secret for a 1-hour access
 * token (design D5). Rejects with `AuthInvalidCredentialsError` on an
 * unknown, mismatched, or revoked credential -- see this module's own doc
 * comment for why every such case is indistinguishable from the caller's
 * side.
 */
export async function exchangeMachineToken(
  auth: AuthInstance,
  params: ExchangeMachineTokenParams,
): Promise<ExchangedMachineToken> {
  const api = apiOf(auth);

  const verified = await api.verifyApiKey({
    body: { key: params.clientSecret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
  });
  const key = verified.valid ? verified.key : null;
  if (key === null) {
    throw new AuthInvalidCredentialsError();
  }

  const actorKind = key.metadata?.[ACTOR_KIND_METADATA_KEY];
  if (actorKind !== 'integration' && actorKind !== 'agent') {
    throw new AuthInvalidCredentialsError();
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = await api.signJWT({
    body: {
      payload: {
        tenantId: key.referenceId,
        actor: { type: actorKind, id: key.id },
        iat: nowSeconds,
        exp: nowSeconds + ONE_HOUR_SECONDS,
      },
    },
  });

  recordSuccessfulExchange(actorKind);

  return { accessToken: signed.token };
}
