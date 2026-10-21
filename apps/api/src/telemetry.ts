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
import { core, logs, metrics, NodeSDK, tracing } from '@opentelemetry/sdk-node';

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

/** True when any OTLP endpoint variable is set to a non-empty value; shared with the CLI guard. */
export function hasOtlpEndpoint(env: Env): boolean {
  return ENDPOINT_VARIABLES.some((name) => (env[name] ?? '') !== '');
}

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

const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target', 'url.path'] as const;

/**
 * The sixteen route templates whose path carries an identifier (email, invitation id,
 * credential id): the thirteen path templates of the identity routes (design D10) and the
 * three catalog `_user` routes (D12, Resolved decision Q119). `{x}` matches any non-empty
 * segment, percent-encoded or not.
 */
const ROUTE_TEMPLATES: readonly (readonly string[])[] = [
  '/v1/users/invitations',
  '/v1/users/invitations/{invitation}/cancel',
  '/v1/users/invitations/{invitation}/resend',
  '/v1/auth/invitations/accept',
  '/v1/users/{user}/status',
  '/v1/users/{user}/mfa/reset',
  '/v1/users',
  '/v1/users/{user}/sso-account',
  '/v1/service-accounts',
  '/v1/service-accounts/{user}',
  '/v1/credentials',
  '/v1/credentials/{credential}/rotate',
  '/v1/credentials/{credential}/revoke',
  '/v1/blueprints/_user/entities/{entity}',
  '/v1/blueprints/_user/entities/{entity}/status',
  '/v1/blueprints/_user/entities/{entity}/related',
].map((template) => template.split('/'));

/**
 * Returns the route template of a parsed pathname, or `undefined` when the path is none of
 * the sixteen templates (the catalog routes of other blueprints keep their paths).
 */
export function routeTemplate(pathname: string): string | undefined {
  const segments = pathname.split('/');
  const match = ROUTE_TEMPLATES.find(
    (template) =>
      template.length === segments.length &&
      template.every((part, index) => {
        const segment = segments[index] ?? '';
        return part.startsWith('{') ? segment !== '' : part === segment;
      }),
  );
  return match?.join('/');
}

/** The pathname of a request target or absolute URL, without query or fragment. */
function pathnameOf(value: string): string {
  const withoutQuery = value.slice(0, value.search(/[?#]|$/));
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(withoutQuery);
  return scheme === null ? withoutQuery : withoutQuery.slice(scheme[0].length);
}

/**
 * Removes the URL query (OAuth `code`/`state`, tokens) from one span's attributes, and
 * replaces the path of an identifier-carrying route with its template.
 */
function stripQuery(span: tracing.ReadableSpan): tracing.ReadableSpan {
  const attributes: Record<string, unknown> = { ...span.attributes };
  delete attributes['url.query'];
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') {
      const index = value.search(/[?#]/);
      const clean = index === -1 ? value : value.slice(0, index);
      const template = routeTemplate(pathnameOf(clean));
      if (template === undefined) {
        attributes[key] = clean;
      } else {
        const prefix = clean.slice(0, clean.length - pathnameOf(clean).length);
        attributes[key] = `${prefix}${template}`;
      }
    }
  }
  return Object.create(span, {
    attributes: { value: attributes, enumerable: true },
  }) as tracing.ReadableSpan;
}

/** Wraps a span exporter so no exported span carries the URL query (design Q67). */
function queryFreeExporter(inner: tracing.SpanExporter): tracing.SpanExporter {
  return {
    export: (spans, done: (result: core.ExportResult) => void) => {
      try {
        inner.export(spans.map(stripQuery), done);
      } catch {
        done({ code: core.ExportResultCode.FAILED });
      }
    },
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush === undefined ? {} : { forceFlush: () => inner.forceFlush?.() }),
  } as tracing.SpanExporter;
}

export function startTelemetry(env: Env): Telemetry | undefined {
  if (!hasOtlpEndpoint(env)) {
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
    traceExporter: queryFreeExporter(new OTLPTraceExporter({ url: signalUrl(env, 'traces') })),
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
