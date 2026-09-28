/**
 * Registers the telemetry test harness while `auth-flow.int.test.ts`'s module
 * graph loads, before `../auth.js` (and, after task 2.4's green phase, the
 * telemetry/instruments module it is expected to import) create their
 * tracer, meter instruments and logger at import time (design D1: "Import
 * order" in `@tayzu/observability`'s harness contract,
 * `packages/observability/CLAUDE.md`).
 *
 * This mirrors `packages/catalog/src/service/__fixtures__/registered-harness.ts`
 * exactly (same reasoning: the OTel metrics API has no proxy meter provider,
 * so an instrument obtained before registration never emits again). It lives
 * in `@tayzu/auth` rather than being imported from `@tayzu/observability`
 * because it is a test-only fixture of *this* package's module graph, not
 * something `@tayzu/observability` itself needs to export.
 *
 * A registration failure is captured instead of thrown, so a descriptive
 * assertion failure is reported per test instead of the whole file failing to
 * load.
 */
import { createTelemetryTestHarness, type TelemetryTestHarness } from '@tayzu/observability';

export type { TelemetryTestHarness } from '@tayzu/observability';

export type Registration = { readonly harness: TelemetryTestHarness } | { readonly error: unknown };

function register(): Registration {
  try {
    return { harness: createTelemetryTestHarness() };
  } catch (error) {
    return { error };
  }
}

export const registration: Registration = register();
