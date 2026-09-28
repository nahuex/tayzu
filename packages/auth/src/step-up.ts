/**
 * Step-up guard for high-risk operations (task 4.2, design D4;
 * `specs/auth-and-rbac/spec.md`, "Step-up authentication for high-risk
 * operations").
 *
 * Design D4: "every procedure whose `route.spec` carries `x-tayzu-risk:
 * high` is wrapped so that, for a `user` actor only, the guard calls
 * `auth.api.verifyTwoFactor`'s underlying freshness check (a
 * `twoFactorVerifiedAt` timestamp stored on the session, updated whenever
 * `/two-factor/verify` succeeds) and rejects with `AUTH_STEP_UP_REQUIRED` if
 * older than 5 minutes or absent. `agent`/`integration`/`system` actors skip
 * this guard entirely."
 *
 * The installed `better-auth@1.7.6` source (`dist/plugins/two-factor/
 * verify-two-factor.mjs`, `dist/plugins/two-factor/totp/index.mjs`,
 * `dist/plugins/two-factor/backup-codes/index.mjs`) has no built-in
 * `twoFactorVerifiedAt` field or freshness check of its own -- confirmed by
 * reading every `two-factor` plugin file before writing this module. This
 * package therefore records the freshness marker itself: `./auth.ts`'s
 * `hooks.after` writes a `verification` row (Better Auth's own generic
 * "short-lived value for an out-of-band check" table, already used for
 * `two-factor`'s own trust-device tokens) keyed by
 * `stepUpVerificationIdentifier(sessionToken)` whenever any `/two-factor/
 * verify-*` endpoint succeeds, with `expiresAt` set to the freshness window
 * below. This guard only ever reads that row back, through Better Auth's own
 * `internalAdapter.findVerificationValue` -- never a second, ad hoc database
 * connection, and never direct SQL.
 *
 * `createStepUpGuard({ auth })` follows the same `create*({ auth })` factory
 * convention `./context-resolver.ts`'s `createContextResolver({ auth })`
 * already establishes. `AssertStepUpParams` carries `headers` (so the guard
 * reads the caller's real, current session through `auth.api.getSession`,
 * rather than trusting a caller-supplied timestamp), `tenantId`/`actor`
 * (the same two fields a resolved `CatalogContext` already carries at the
 * point a pipeline integration calls this guard, immediately after context
 * resolution and before the operation itself runs -- design D4's own
 * ordering), `route.riskLevel` (a stand-in for "the invoked procedure's
 * route carries `x-tayzu-risk: high`" -- the real marker lives in
 * `@tayzu/catalog`'s oRPC contract, which this package cannot import), and
 * `operation` (`tayzu.catalog.operation`'s value on the blocked-case
 * telemetry below, `packages/catalog/src/service/pipeline.ts`'s own
 * `OPERATION_ATTRIBUTE`).
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

import type { AuthInstance } from './auth.js';
import { AuthStepUpError } from './errors.js';
import { logger, stepUpRequiredCounter } from './telemetry/instruments.js';

/** design.md, Conventions/D4: "an MFA verification is 'fresh' for 5 minutes." */
export const STEP_UP_FRESHNESS_MS = 5 * 60 * 1000;

/** design.md, Log/Metrics tables: `auth.security.step_up_required`'s/`tayzu.auth.step_up.required`'s shared attribute. */
const OPERATION_ATTRIBUTE = 'tayzu.catalog.operation';

const STEP_UP_VERIFICATION_IDENTIFIER_PREFIX = 'step-up-verified';

/**
 * The `verification` table `identifier` this module's freshness marker is
 * stored under, keyed by session token (never by user id, so a stale token
 * from a since-revoked session cannot carry a freshness marker forward onto
 * a different session). Exported so `./auth.ts`'s `hooks.after` writes under
 * the identical key this guard reads back.
 */
export function stepUpVerificationIdentifier(sessionToken: string): string {
  return `${STEP_UP_VERIFICATION_IDENTIFIER_PREFIX}:${sessionToken}`;
}

export interface StepUpGuardOptions {
  /** The Better Auth instance whose session/verification state the guard reads. */
  readonly auth: AuthInstance;
}

export interface AssertStepUpParams {
  /** The caller's real request headers, so the guard reads its own current session. */
  readonly headers: Headers;
  readonly tenantId: string;
  readonly actor: {
    readonly type: string;
    readonly id: string;
  };
  /** A stand-in for the invoked procedure's route (design D4: `x-tayzu-risk: high`). */
  readonly route: {
    readonly riskLevel?: 'high';
  };
  /** `tayzu.catalog.operation`'s value on the blocked-case telemetry. */
  readonly operation: string;
}

/** Resolves when the operation may proceed; rejects with `AuthStepUpError` otherwise. */
export type StepUpGuard = (params: AssertStepUpParams) => Promise<void>;

/** The slice of `auth.api.getSession`'s resolved value this module reads. */
interface SessionResult {
  readonly session: {
    readonly token: string;
  };
}

interface AuthApiSurface {
  getSession(args: { headers: Headers }): Promise<SessionResult | null>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * The slice of Better Auth's own `AuthContext` (`auth.$context`) this module
 * reads: its low-level internal adapter, the same primitive `./auth.ts`'s
 * `hooks.after` writes the freshness marker through.
 */
interface AuthContextSurface {
  readonly internalAdapter: {
    findVerificationValue(identifier: string): Promise<{ readonly expiresAt: Date } | null>;
  };
}

function contextOf(auth: AuthInstance): Promise<AuthContextSurface> {
  return auth.$context as Promise<AuthContextSurface>;
}

/** design.md, Log events table: `auth.security.step_up_required`; Metrics table: `tayzu.auth.step_up.required`. */
function emitStepUpRequired(params: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly operation: string;
}): void {
  logger.emit({
    eventName: 'auth.security.step_up_required',
    severityNumber: SeverityNumber.WARN,
    attributes: {
      [sharedAttributeKeys.tenantId]: params.tenantId,
      [sharedAttributeKeys.actorId]: params.actorId,
      [OPERATION_ATTRIBUTE]: params.operation,
    },
  });
  stepUpRequiredCounter.add(1, { [OPERATION_ATTRIBUTE]: params.operation });
}

export function createStepUpGuard(options: StepUpGuardOptions): StepUpGuard {
  const api = apiOf(options.auth);

  return async (params: AssertStepUpParams): Promise<void> => {
    // design D4: only `x-tayzu-risk: high` operations are gated at all.
    if (params.route.riskLevel !== 'high') {
      return;
    }
    // design D4: "agent/integration/system actors skip this guard entirely."
    if (params.actor.type !== 'user') {
      return;
    }

    function rejectStepUp(): never {
      emitStepUpRequired({
        tenantId: params.tenantId,
        actorId: params.actor.id,
        operation: params.operation,
      });
      throw new AuthStepUpError();
    }

    const session = await api.getSession({ headers: params.headers });
    if (session === null) {
      rejectStepUp();
    }
    const sessionToken = session.session.token;

    // A lookup failure fails closed, exactly like `./context-resolver.ts`'s
    // own membership re-check: treated as "no fresh verification" rather
    // than allowing the operation through.
    const verification = await contextOf(options.auth)
      .then((context) =>
        context.internalAdapter.findVerificationValue(stepUpVerificationIdentifier(sessionToken)),
      )
      .catch(() => null);

    if (verification === null || verification.expiresAt.getTime() <= Date.now()) {
      rejectStepUp();
    }
  };
}
