/**
 * The `auth.internal_error` log event (task 27.4, design Q76): an unmapped
 * Better Auth or Fastify error, sanitized. Only the error's class name and,
 * when present, its SQLSTATE reach the signal: never the message, stack text
 * or a bind value.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';

import { logger } from './telemetry/instruments.js';

const ERROR_TYPE_ATTRIBUTE = 'error.type';
const SQLSTATE_ATTRIBUTE = 'db.response.status_code';
const FALLBACK_ERROR_TYPE = 'unknown';
const MAX_ERROR_TYPE_LENGTH = 64;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const ERROR_TYPE_PATTERN = /^[A-Za-z_$][\w$]*$/;

export function emitInternalError(error: unknown): void {
  const { name, code } =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; code?: unknown })
      : { name: undefined, code: undefined };
  const attributes: Record<string, string> = {
    [ERROR_TYPE_ATTRIBUTE]:
      typeof name === 'string' &&
      name.length <= MAX_ERROR_TYPE_LENGTH &&
      ERROR_TYPE_PATTERN.test(name)
        ? name
        : FALLBACK_ERROR_TYPE,
  };
  if (typeof code === 'string' && SQLSTATE_PATTERN.test(code)) {
    attributes[SQLSTATE_ATTRIBUTE] = code;
  }
  logger.emit({
    eventName: 'auth.internal_error',
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    attributes,
  });
}
