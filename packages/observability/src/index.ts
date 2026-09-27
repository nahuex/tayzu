/**
 * @tayzu/observability: the OpenTelemetry test harness (in-memory span,
 * metric and log exporters) and the SDK bootstrap helper for host apps.
 *
 * Libraries such as @tayzu/catalog depend on the OTel API only. The SDK is
 * configured here, by tests and by host apps.
 */
export { createTelemetryTestHarness } from './harness.js';
export type { TelemetryTestHarness } from './harness.js';
