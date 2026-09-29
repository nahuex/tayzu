/**
 * The operation pipeline (tasks 6.2, 6.3; design D3, D5, D9, D11).
 * `defineCatalogOperation` is the **only** entry point a catalog operation
 * goes through: context validation, the operation span, the tenant
 * transaction, error mapping and sanitization, the `operation.duration`
 * histogram, and the mutation audit trail. There is no second path (design
 * D3): actor type is read here only as data (attribution, and the common
 * span attributes), never to select behavior, which is why this file is one
 * of the two the actor-type lint rule allowlists.
 *
 * The runtime flow:
 *
 * 1. `parseCatalogContext(rawContext)`. On failure: count
 *    `tayzu.catalog.context.rejections`, emit the WARN log
 *    `catalog.security.context_rejected`, and rethrow. No span starts, and
 *    the handler never runs.
 * 1b. Authorization (task 9.1, 002 design D10): Cerbos `CheckResources`,
 *    before the tenant transaction opens. A deny throws `AUTH_FORBIDDEN`,
 *    emits `catalog.security.authz_denied` and counts
 *    `tayzu.authz.decisions`. A missing or empty principal is a deny, and a
 *    Cerbos failure is never an allow.
 * 2. Start span `catalog.<name>` with the common attributes, and make it the
 *    active span for the rest of the operation.
 * 3. Run `withTenantTransaction(pool, ctx, (client) => handler({ ctx, client,
 *    input }))` (`@tayzu/db`, design D5).
 * 4. On a thrown `CatalogError`: span status `ERROR`, `error.type` = the
 *    code, no exception event, the error's own message never reaches the
 *    span. Outcome `client_error`.
 * 5. On any other thrown value: span status `ERROR`, `error.type` =
 *    `'internal'`, and exactly one sanitized `exception` event (type,
 *    SQLSTATE, constraint, and the stack without its message line; design
 *    D11). The ERROR log `catalog.internal_error` carries the same
 *    attributes. Outcome `server_error`. The pipeline never fabricates a
 *    `CatalogError` for this case: the original value propagates unchanged.
 * 6. On success: outcome `success`. If the handler's result carries `audit`,
 *    emit `catalog.audit.mutation` (INFO) after the transaction has
 *    committed.
 * 7. In every case, record `tayzu.catalog.operation.duration`.
 */
import type { Attributes } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { buildAttributes, type CerbosClient, type ResourceKind } from '@tayzu/authz';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool, PoolClient } from 'pg';

import type { CatalogContext } from '../domain/context.js';
import { parseCatalogContext } from '../domain/context.js';
import {
  AuthorizationError,
  CatalogError,
  isAuthorizationError,
  isCatalogError,
  type CatalogErrorCode,
} from '../domain/errors.js';
import { pgErrorInfo } from '../persistence/db-errors.js';
import {
  authzCheckDurationHistogram,
  authzDecisionsCounter,
  contextRejectionsCounter,
  logger,
  operationDurationHistogram,
  tracer,
  validationFailuresCounter,
} from '../telemetry/instruments.js';

const TENANT_ATTRIBUTE = 'tayzu.tenant.id';
const ACTOR_TYPE_ATTRIBUTE = 'tayzu.actor.type';
const ACTOR_ID_ATTRIBUTE = 'tayzu.actor.id';
const ACTOR_ON_BEHALF_OF_TYPE_ATTRIBUTE = 'tayzu.actor.on_behalf_of.type';
const ACTOR_ON_BEHALF_OF_ID_ATTRIBUTE = 'tayzu.actor.on_behalf_of.id';
const OPERATION_ATTRIBUTE = 'tayzu.catalog.operation';
const OUTCOME_ATTRIBUTE = 'tayzu.catalog.outcome';
const ERROR_TYPE_ATTRIBUTE = 'error.type';
const AUTHZ_KIND_ATTRIBUTE = 'tayzu.authz.resource.kind';
const AUTHZ_CALL_ID_ATTRIBUTE = 'tayzu.authz.cerbos.call_id';
const AUTHZ_ACTION_ATTRIBUTE = 'tayzu.authz.action';
const AUTHZ_DECISION_ATTRIBUTE = 'tayzu.authz.decision';
const CONTEXT_REASON_ATTRIBUTE = 'tayzu.catalog.context.reason';

/**
 * design.md, Metrics table: `tayzu.catalog.validation.failures`'s allowed
 * `error.type` values ("Client-quality and misuse signal", SEC06). Every
 * other `CatalogError` code (`CATALOG_CONTEXT_REQUIRED`, `CATALOG_NOT_FOUND`,
 * `CATALOG_ALREADY_EXISTS`, `CATALOG_VERSION_CONFLICT`) never increments it.
 */
const VALIDATION_FAILURE_CODES: ReadonlySet<CatalogErrorCode> = new Set([
  'CATALOG_VALIDATION_FAILED',
  'CATALOG_REFERENCE_VIOLATION',
  'CATALOG_SCHEMA_INCOMPATIBLE',
  'CATALOG_LIMIT_EXCEEDED',
  'CATALOG_RESERVED_IDENTIFIER',
]);

type OperationOutcome = 'success' | 'client_error' | 'server_error';

export type MutationKind = 'created' | 'updated' | 'status_updated' | 'deleted' | 'detached';
export type MutationResourceKind = 'blueprint' | 'entity';

/** design.md, log events table ("catalog.audit.mutation"): what a successful mutation reports. */
export interface CatalogMutationAudit {
  readonly mutation: MutationKind;
  readonly resourceKind: MutationResourceKind;
  readonly blueprintIdentifier: string;
  readonly resourceIdentifier: string;
  readonly version: number;
  readonly changeEventSeq: bigint;
}

/**
 * `output` is what the operation returns to its caller. `audit`, present
 * only for a successful mutation, is consumed by the pipeline to emit
 * `catalog.audit.mutation` after commit; it is never returned to the caller.
 */
export interface CatalogOperationResult<Output> {
  readonly output: Output;
  readonly audit?: CatalogMutationAudit;
}

export interface CatalogOperationHandlerParams<Input> {
  readonly ctx: CatalogContext;
  /** From `withTenantTransaction`: `app.tenant_id` and `statement_timeout` are already set. */
  readonly client: PoolClient;
  readonly input: Input;
}

export type CatalogOperationHandler<Input, Output> = (
  params: CatalogOperationHandlerParams<Input>,
) => Promise<CatalogOperationResult<Output>>;

/** What an operation asks Cerbos: one action on one resource (design Q27). */
export interface AuthorizationDeclaration {
  readonly kind: ResourceKind;
  readonly action: string;
  readonly resourceId: string;
  /** Extra resource attributes; `tenantId` is always added from the context. */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Declares an operation authorized by a Cerbos `PlanResources` query plan the
 * handler folds into its own query (design D11), so the pipeline runs no
 * `CheckResources` for it. Still an explicit, mandatory declaration (Q27).
 */
export const PLAN_AUTHORIZED = { mode: 'plan' } as const;

export interface DefineCatalogOperationOptions<Input, Output> {
  /** For example `'entity.upsert'`: span `catalog.entity.upsert`, attribute value `'entity.upsert'`. */
  readonly name: string;
  /** The production connection pool this operation runs against. */
  readonly pool: Pool;
  readonly handler: CatalogOperationHandler<Input, Output>;
  /** The Cerbos client the authorization stage calls (design Q27). */
  readonly authz: CerbosClient;
  /**
   * Mandatory (design Q27): what the pipeline checks before the transaction.
   * Receives the still-untrusted input, so it must read it defensively.
   */
  readonly authorization:
    | ((params: {
        readonly ctx: CatalogContext;
        readonly input: Input;
      }) => AuthorizationDeclaration)
    | typeof PLAN_AUTHORIZED;
  /**
   * Overrides `withTenantTransaction`'s default 5 s `statement_timeout`
   * (design D5). Design Risks: "`statement_timeout` raised only for this
   * operation (30 s)" -- used by `blueprints.update`'s compatibility check
   * (design D7), which streams every entity of a blueprint.
   */
  readonly statementTimeoutMs?: number;
}

/** Reads `error.details.reason`, falling back to `'invalid_actor'` if it is ever missing. */
function contextRejectionReason(error: CatalogError): string {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : 'invalid_actor';
}

/** Design D3 step 1: counts the rejection and emits the matching WARN log, with the same two attributes. */
function recordContextRejection(operationName: string, reason: string): void {
  const attributes: Attributes = {
    [OPERATION_ATTRIBUTE]: operationName,
    [CONTEXT_REASON_ATTRIBUTE]: reason,
  };
  contextRejectionsCounter.add(1, attributes);
  logger.emit({
    eventName: 'catalog.security.context_rejected',
    severityNumber: SeverityNumber.WARN,
    attributes,
  });
}

/**
 * The thrown value's `.stack`, kept only where it is a real V8 call-site
 * line. `Error.captureStackTrace` renders the message (`${name}: ${message}`)
 * as one or more *leading* lines before the first `    at ...` frame, but a
 * message can itself span several physical lines -- `DrizzleQueryError`'s own
 * message is `Failed query: <sql>\nparams: <bind values>`, two lines, not
 * one. Slicing off only the first line (as a bare "remove the message line"
 * would) leaves the second message line, `params: ...`, verbatim in the
 * stacktrace -- exactly the SQL bind values design D11 forbids. Filtering by
 * shape instead (every trimmed, non-blank line must start with `"at "`,
 * V8's own frame prefix) drops every message line regardless of how many
 * there are, and never depends on the message's own content.
 */
function stacktraceWithoutMessage(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  return stack
    .split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .join('\n');
}

/**
 * Design D3 step 5, D11: sanitizes an unknown thrown value down to exactly
 * `exception.type`, `exception.stacktrace`, and (only when the driver
 * supplies them) `db.response.status_code` (SQLSTATE) and
 * `tayzu.db.constraint`. Never the error's `.message`, Postgres `detail` or
 * `where`, or any bind value.
 *
 * `code` and `constraint` are read through `pgErrorInfo`'s `.cause`-unwrapping
 * loop (`persistence/db-errors.ts`), not off the top-level thrown value: a
 * real database write goes through drizzle-orm's query builder
 * (`tx.execute(sql\`...\`)`), which wraps every failure in its own
 * `DrizzleQueryError` and moves the underlying `pg` `DatabaseError` (where
 * `code`/`constraint` actually live) to `error.cause`.
 */
function sanitizeUnknownError(error: unknown): Attributes {
  const exceptionType =
    typeof error === 'object' && error !== null ? error.constructor.name : typeof error;

  const attributes: Record<string, string> = {
    'exception.type': exceptionType,
    'exception.stacktrace': stacktraceWithoutMessage(error),
  };

  const info = pgErrorInfo(error);
  if (info.code !== undefined) {
    attributes['db.response.status_code'] = info.code;
  }
  if (info.constraint !== undefined) {
    attributes['tayzu.db.constraint'] = info.constraint;
  }

  return attributes;
}

function emitInternalErrorLog(operationName: string, sanitized: Attributes): void {
  logger.emit({
    eventName: 'catalog.internal_error',
    severityNumber: SeverityNumber.ERROR,
    attributes: {
      [OPERATION_ATTRIBUTE]: operationName,
      ...sanitized,
    },
  });
}

/** Design.md, log events table: `catalog.audit.mutation`, emitted after the transaction commits. */
function emitAuditMutationLog(ctx: CatalogContext, audit: CatalogMutationAudit): void {
  const attributes: Record<string, string | number> = {
    [TENANT_ATTRIBUTE]: ctx.tenantId,
    [ACTOR_TYPE_ATTRIBUTE]: ctx.actor.type,
    [ACTOR_ID_ATTRIBUTE]: ctx.actor.id,
    'tayzu.catalog.mutation': audit.mutation,
    'tayzu.catalog.resource.kind': audit.resourceKind,
    'tayzu.catalog.blueprint.identifier': audit.blueprintIdentifier,
    'tayzu.catalog.resource.identifier': audit.resourceIdentifier,
    'tayzu.catalog.version': audit.version,
    'tayzu.catalog.change_event.seq': Number(audit.changeEventSeq),
  };

  const onBehalfOf = ctx.actor.onBehalfOf;
  if (onBehalfOf) {
    attributes[ACTOR_ON_BEHALF_OF_TYPE_ATTRIBUTE] = onBehalfOf.type;
    attributes[ACTOR_ON_BEHALF_OF_ID_ATTRIBUTE] = onBehalfOf.id;
  }

  logger.emit({
    eventName: 'catalog.audit.mutation',
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}

interface RecordOperationDurationParams {
  readonly operationName: string;
  readonly ctx: CatalogContext;
  readonly outcome: OperationOutcome;
  readonly durationSeconds: number;
  readonly errorType?: string;
}

/** Design.md, Metrics table: `tayzu.catalog.operation.duration`, recorded in every case (step 7). */
function recordOperationDuration(params: RecordOperationDurationParams): void {
  const attributes: Record<string, string> = {
    [OPERATION_ATTRIBUTE]: params.operationName,
    [OUTCOME_ATTRIBUTE]: params.outcome,
    [TENANT_ATTRIBUTE]: params.ctx.tenantId,
    [ACTOR_TYPE_ATTRIBUTE]: params.ctx.actor.type,
  };
  if (params.errorType !== undefined) {
    attributes[ERROR_TYPE_ATTRIBUTE] = params.errorType;
  }
  operationDurationHistogram.record(params.durationSeconds, attributes);
}

/**
 * A string field of the still-untrusted input, or `'_'` when it is not one.
 * Cerbos needs a non-empty resource id; a malformed input is rejected by the
 * handler's own validation once the check allows it.
 */
export function inputString(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) return '_';
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : '_';
}

/**
 * Design D10: `CheckResources` for one action. Never allows on a missing
 * principal (no Cerbos call is made), and a Cerbos failure propagates as an
 * unknown error, which the pipeline records sanitized and never turns into
 * an allow.
 */
async function authorize(
  authz: CerbosClient,
  ctx: CatalogContext,
  declaration: AuthorizationDeclaration,
): Promise<void> {
  const { kind, action } = declaration;
  const roles = ctx.principal?.roles ?? [];
  const startedAtMillis = Date.now();

  const parentContext = context.active();
  let allowed = false;
  if (roles.length > 0) {
    const response = await tracer.startActiveSpan('authz.check', async (checkSpan) => {
      checkSpan.setAttributes({ [AUTHZ_KIND_ATTRIBUTE]: kind, [AUTHZ_ACTION_ATTRIBUTE]: action });
      try {
        const checked = await authz.checkResources({
          principal: {
            id: ctx.actor.id,
            roles: [...roles],
            attr: buildAttributes(ctx.tenantId, {
              teams: [...(ctx.principal?.teams ?? [])],
              moderatedBlueprints: [...(ctx.principal?.moderatedBlueprints ?? [])],
            }),
          },
          resources: [
            {
              resource: {
                kind,
                id: declaration.resourceId,
                attr: buildAttributes(ctx.tenantId, declaration.attributes),
              },
              actions: [action],
            },
          ],
        });
        // Correlates the Cerbos decision log with the trace (design D14).
        const callId = checked.cerbosCallId;
        if (callId !== '') {
          checkSpan.setAttribute(AUTHZ_CALL_ID_ATTRIBUTE, callId);
          trace.getSpan(parentContext)?.setAttribute(AUTHZ_CALL_ID_ATTRIBUTE, callId);
        }
        return checked;
      } finally {
        checkSpan.end();
      }
    });
    allowed = response.results[0]?.isAllowed(action) === true;
  }
  authzCheckDurationHistogram.record(elapsedSeconds(startedAtMillis), {
    [AUTHZ_KIND_ATTRIBUTE]: kind,
  });

  authzDecisionsCounter.add(1, {
    [TENANT_ATTRIBUTE]: ctx.tenantId,
    [AUTHZ_KIND_ATTRIBUTE]: kind,
    [AUTHZ_ACTION_ATTRIBUTE]: action,
    [AUTHZ_DECISION_ATTRIBUTE]: allowed ? 'allow' : 'deny',
  });
  if (allowed) return;

  logger.emit({
    eventName: 'catalog.security.authz_denied',
    severityNumber: SeverityNumber.WARN,
    attributes: {
      [TENANT_ATTRIBUTE]: ctx.tenantId,
      [ACTOR_TYPE_ATTRIBUTE]: ctx.actor.type,
      [ACTOR_ID_ATTRIBUTE]: ctx.actor.id,
      [AUTHZ_KIND_ATTRIBUTE]: kind,
      [AUTHZ_ACTION_ATTRIBUTE]: action,
    },
  });
  throw new AuthorizationError();
}

function elapsedSeconds(startedAtMillis: number): number {
  return (Date.now() - startedAtMillis) / 1000;
}

/**
 * Declares one catalog operation. There is no other way to build the
 * function a service or API layer calls (design D3).
 */
export function defineCatalogOperation<Input, Output>(
  options: DefineCatalogOperationOptions<Input, Output>,
): (rawContext: unknown, input: Input) => Promise<Output> {
  const { name, pool, handler, statementTimeoutMs, authz, authorization } = options;
  const spanName = `catalog.${name}`;

  return async function catalogOperation(rawContext: unknown, input: Input): Promise<Output> {
    let ctx: CatalogContext;
    try {
      ctx = parseCatalogContext(rawContext);
    } catch (error) {
      if (isCatalogError(error) && error.code === 'CATALOG_CONTEXT_REQUIRED') {
        recordContextRejection(name, contextRejectionReason(error));
      }
      throw error;
    }

    const span = tracer.startSpan(spanName, {
      attributes: {
        [TENANT_ATTRIBUTE]: ctx.tenantId,
        [ACTOR_TYPE_ATTRIBUTE]: ctx.actor.type,
        [ACTOR_ID_ATTRIBUTE]: ctx.actor.id,
        [OPERATION_ATTRIBUTE]: name,
      },
    });
    const startedAtMillis = Date.now();

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        if (typeof authorization === 'function') {
          await authorize(authz, ctx, authorization({ ctx, input }));
        }
        const result = await withTenantTransaction(
          pool,
          ctx,
          (client) => handler({ ctx, client, input }),
          {
            statementTimeoutMs,
          },
        );

        if (result.audit) {
          emitAuditMutationLog(ctx, result.audit);
        }
        recordOperationDuration({
          operationName: name,
          ctx,
          outcome: 'success',
          durationSeconds: elapsedSeconds(startedAtMillis),
        });
        span.end();
        return result.output;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });

        if (isAuthorizationError(error)) {
          span.setAttribute(ERROR_TYPE_ATTRIBUTE, error.code);
          recordOperationDuration({
            operationName: name,
            ctx,
            outcome: 'client_error',
            durationSeconds: elapsedSeconds(startedAtMillis),
            errorType: error.code,
          });
        } else if (isCatalogError(error)) {
          span.setAttribute(ERROR_TYPE_ATTRIBUTE, error.code);
          if (VALIDATION_FAILURE_CODES.has(error.code)) {
            validationFailuresCounter.add(1, {
              [TENANT_ATTRIBUTE]: ctx.tenantId,
              [OPERATION_ATTRIBUTE]: name,
              [ERROR_TYPE_ATTRIBUTE]: error.code,
            });
          }
          recordOperationDuration({
            operationName: name,
            ctx,
            outcome: 'client_error',
            durationSeconds: elapsedSeconds(startedAtMillis),
            errorType: error.code,
          });
        } else {
          span.setAttribute(ERROR_TYPE_ATTRIBUTE, 'internal');
          const sanitized = sanitizeUnknownError(error);
          span.addEvent('exception', sanitized);
          emitInternalErrorLog(name, sanitized);
          recordOperationDuration({
            operationName: name,
            ctx,
            outcome: 'server_error',
            durationSeconds: elapsedSeconds(startedAtMillis),
            errorType: 'internal',
          });
        }

        span.end();
        throw error;
      }
    });
  };
}
