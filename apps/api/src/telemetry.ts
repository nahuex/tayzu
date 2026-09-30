/**
 * OpenTelemetry SDK bootstrap (task 13.4, resolved decision Q31). Configured
 * only through the standard `OTEL_*` variables, and started only when an OTLP
 * endpoint is set (outside test, startup fails without one unless
 * `TAYZU_TELEMETRY_DISABLED=true`, Q41). HTTP instrumentation records no bodies or headers, and the
 * pg instrumentation never records bind values.
 */
import { createRequire } from 'node:module';

import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { logs, metrics, NodeSDK } from '@opentelemetry/sdk-node';

type Env = Readonly<Record<string, string | undefined>>;

export interface Telemetry {
  /** Flushes pending data and stops the SDK. */
  shutdown(): Promise<void>;
}

const ENDPOINT_VARIABLES = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

/**
 * Resolves one signal's URL from the injected environment: the per-signal
 * endpoint is used as is, the generic one gets `/v1/<signal>` appended.
 */
function signalUrl(env: Env, signal: 'traces' | 'metrics' | 'logs'): string | undefined {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  if (specific !== undefined && specific !== '') return specific;
  const base = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (base === undefined || base === '') return undefined;
  return `${base.replace(/\/+$/, '')}/v1/${signal}`;
}

export function startTelemetry(env: Env): Telemetry | undefined {
  if (!ENDPOINT_VARIABLES.some((name) => (env[name] ?? '') !== '')) {
    if ((env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test') {
      return undefined;
    }
    // Q41, D14: security logging must not be silently absent outside test.
    if (env['TAYZU_TELEMETRY_DISABLED'] !== 'true') {
      throw new Error(
        'OTEL_EXPORTER_OTLP_ENDPOINT is required outside test; set TAYZU_TELEMETRY_DISABLED=true to run without telemetry explicitly.',
      );
    }
    console.warn('TAYZU_TELEMETRY_DISABLED=true: telemetry is disabled, no signals are exported.');
    return undefined;
  }
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: signalUrl(env, 'traces') }),
    metricReader: new metrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: signalUrl(env, 'metrics') }),
    }),
    logRecordProcessors: [
      new logs.BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: signalUrl(env, 'logs') }),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        headersToSpanAttributes: {},
        // Also emit the legacy method attribute (the request method is not
        // tenant data), so dashboards keyed on `http.method` keep working.
        startIncomingSpanHook: (request) => ({ 'http.method': request.method ?? '' }),
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  // The instrumentations patch through require hooks. A module that an ESM
  // import already loaded is only patched when it is required again.
  const require = createRequire(import.meta.url);
  require('node:http');
  require('pg');
  return {
    shutdown: () => sdk.shutdown(),
  };
}
