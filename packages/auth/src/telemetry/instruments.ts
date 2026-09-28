/**
 * `@tayzu/auth`'s OpenTelemetry instruments: the tracer, the logger and the
 * meter instruments its operations need. Obtained once, at import time,
 * through the OTel **API** only (design.md, "Observability contract"): this
 * package depends on `@opentelemetry/api` and `@opentelemetry/api-logs` only,
 * never an SDK package. The SDK and its exporters are configured by the host
 * app, or by `@tayzu/observability`'s test harness in tests.
 *
 * Design D1 ("Import order", `packages/observability/CLAUDE.md`): the OTel
 * metrics API has no proxy meter provider, so a module that imports this one
 * (transitively, `../auth.ts`) must itself be imported only after a
 * telemetry harness has registered, or every instrument below is a
 * permanent no-op. See `src/__fixtures__/registered-harness.ts`.
 *
 * Task 2.4's sign-in hooks, task 4.2's step-up guard (design D4), and task
 * 5.3's token exchange (design D5) are the only instruments live here today.
 * Later tasks add the remaining `./contract.ts` spans/metrics as their own
 * operations start emitting them.
 */
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';

import { INSTRUMENTATION_SCOPE_NAME } from './contract.js';

/** Matches `package.json`'s `version` field (design.md, "Instrumentation scope"). */
export const INSTRUMENTATION_SCOPE_VERSION = '0.0.0';

export const tracer = trace.getTracer(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);
export const logger = logs.getLogger(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);

const meter = metrics.getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);

/** design.md, Metrics table: "Authentication security signal". */
export const sessionEventsCounter = meter.createCounter('tayzu.auth.session.events', {
  unit: '{event}',
});

/** design.md, Metrics table: "Pre-authentication brute-force signal (design D20)". */
export const rateLimitEventsCounter = meter.createCounter('tayzu.auth.rate_limit.events', {
  unit: '{event}',
});

/** design.md, Metrics table: "Step-up friction signal" (design D4). */
export const stepUpRequiredCounter = meter.createCounter('tayzu.auth.step_up.required', {
  unit: '{event}',
});

/** design.md, Metrics table: "Machine-credential usage and abuse signal" (design D5). */
export const tokenExchangesCounter = meter.createCounter('tayzu.auth.token.exchanges', {
  unit: '{exchange}',
});
