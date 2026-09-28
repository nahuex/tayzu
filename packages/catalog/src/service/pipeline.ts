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
import { withTenantTransaction } from '@tayzu/db';
import type { Pool, PoolClient } from 'pg';

import type { CatalogContext } from '../domain/context.js';
import { parseCatalogContext } from '../domain/context.js';
import { CatalogError, isCatalogError } from '../domain/errors.js';
import { contextRejectionsCounter, logger, operationDurationHistogram, tracer } from '../telemetry/instruments.js';

const TENANT_ATTRIBUTE = 'tayzu.tenant.id';
const ACTOR_TYPE_ATTRIBUTE = 'tayzu.actor.type';
const ACTOR_ID_ATTRIBUTE = 'tayzu.actor.id';
const ACTOR_ON_BEHALF_OF_TYPE_ATTRIBUTE = 'tayzu.actor.on_behalf_of.type';
const ACTOR_ON_BEHALF_OF_ID_ATTRIBUTE = 'tayzu.actor.on_behalf_of.id';
const OPERATION_ATTRIBUTE = 'tayzu.catalog.operation';
const OUTCOME_ATTRIBUTE = 'tayzu.catalog.outcome';
const ERROR_TYPE_ATTRIBUTE = 'error.type';
const CONTEXT_REASON_ATTRIBUTE = 'tayzu.catalog.context.reason';

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

export interface DefineCatalogOperationOptions<Input, Output> {
  /** For example `'entity.upsert'`: span `catalog.entity.upsert`, attribute value `'entity.upsert'`. */
  readonly name: string;
  /** The production connection pool this operation runs against. */
  readonly pool: Pool;
  readonly handler: CatalogOperationHandler<Input, Output>;
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

/** Reads a string property off an unknown thrown value without ever widening it to `any`. */
function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/** The thrown value's `.stack` with its first line (the message) removed. */
function stacktraceWithoutMessage(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const newlineIndex = stack.indexOf('\n');
  return newlineIndex === -1 ? '' : stack.slice(newlineIndex + 1);
}

/**
 * Design D3 step 5, D11: sanitizes an unknown thrown value down to exactly
 * `exception.type`, `exception.stacktrace`, and (only when the driver
 * supplies them) `db.response.status_code` (SQLSTATE) and
 * `tayzu.db.constraint`. Never the error's `.message`, Postgres `detail` or
 * `where`, or any bind value.
 */
function sanitizeUnknownError(error: unknown): Attributes {
  const exceptionType =
    typeof error === 'object' && error !== null ? error.constructor.name : typeof error;

  const attributes: Record<string, string> = {
    'exception.type': exceptionType,
    'exception.stacktrace': stacktraceWithoutMessage(error),
  };

  const sqlstate = readStringProperty(error, 'code');
  if (sqlstate !== undefined) {
    attributes['db.response.status_code'] = sqlstate;
  }
  const constraint = readStringProperty(error, 'constraint');
  if (constraint !== undefined) {
    attributes['tayzu.db.constraint'] = constraint;
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
  const { name, pool, handler } = options;
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
        const result = await withTenantTransaction(pool, ctx, (client) => handler({ ctx, client, input }));

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

        if (isCatalogError(error)) {
          span.setAttribute(ERROR_TYPE_ATTRIBUTE, error.code);
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
