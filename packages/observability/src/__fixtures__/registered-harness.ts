/**
 * Registers the telemetry test harness while the test module graph loads,
 * before any module that creates OTel instruments at import time. This is
 * what a Vitest setup file (or the first import of a test file) does in the
 * packages that use the harness, for example `@tayzu/catalog`, whose
 * `src/telemetry` module creates its tracer, meter instruments and logger at
 * import time (design D1).
 *
 * The order is load-bearing:
 *
 * - The OTel metrics API has no proxy meter provider, so an instrument
 *   created before registration is a no-op forever.
 * - `@opentelemetry/instrumentation-pg` patches `pg` when `pg` is loaded, so
 *   `pg` must be loaded after registration.
 *
 * A registration failure is captured instead of thrown, so that every test
 * reports it instead of the whole file failing to load.
 */
import { createTelemetryTestHarness } from '../harness.js';

export type TelemetryTestHarness = ReturnType<typeof createTelemetryTestHarness>;

export type Registration =
  | {
      readonly harness: TelemetryTestHarness;
      /** Whether the pg instrumentation was enabled when `createTelemetryTestHarness()` returned. */
      readonly pgInstrumentationEnabledOnReturn: boolean;
    }
  | { readonly error: unknown };

function register(): Registration {
  try {
    const harness = createTelemetryTestHarness();
    return {
      harness,
      pgInstrumentationEnabledOnReturn: harness.pgInstrumentation.isEnabled(),
    };
  } catch (error) {
    return { error };
  }
}

export const registration: Registration = register();
