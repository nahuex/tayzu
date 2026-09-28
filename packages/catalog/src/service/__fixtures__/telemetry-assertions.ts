/**
 * Shared telemetry-assertion helpers for the blueprint-operation integration
 * tests (tasks 7.1-7.6). Structurally identical to the helpers
 * `pipeline.int.test.ts` defines inline (same derived-type rationale: this
 * package does not declare `@opentelemetry/sdk-trace-base`, `sdk-metrics` or
 * `sdk-logs` as its own dependency, only `@tayzu/observability` does, so
 * every shape here is derived from `TelemetryTestHarness` rather than
 * imported from an SDK package directly), factored out so
 * `blueprints.int.test.ts` and `blueprints-update.int.test.ts` do not each
 * repeat them.
 */
import type { Attributes } from '@opentelemetry/api';
import { expect } from 'vitest';

import type { TelemetryTestHarness } from './registered-harness.js';

type SpanExporterLike = TelemetryTestHarness['spanExporter'];
type ReadableSpanLike = ReturnType<SpanExporterLike['getFinishedSpans']>[number];
type MetricExporterLike = TelemetryTestHarness['metricExporter'];
type LogExporterLike = TelemetryTestHarness['logExporter'];
type ReadableLogRecordLike = ReturnType<LogExporterLike['getFinishedLogRecords']>[number];

export function finishedSpans(exporter: SpanExporterLike, name: string): ReadableSpanLike[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

/** Asserts exactly one span with `name` was captured, and returns it. */
export function onlySpan(exporter: SpanExporterLike, name: string): ReadableSpanLike {
  const spans = finishedSpans(exporter, name);
  expect(spans, `expected exactly one span named ${name}`).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) {
    throw new Error('unreachable: length was just asserted to be 1');
  }
  return span;
}

export function finishedLogRecords(
  exporter: LogExporterLike,
  eventName: string,
): ReadableLogRecordLike[] {
  return [...exporter.getFinishedLogRecords()].filter((record) => record.eventName === eventName);
}

/**
 * `@opentelemetry/sdk-metrics`'s `DataPointType.SUM` value, inlined rather
 * than imported (same rationale as `pipeline.int.test.ts`'s identical
 * constant): it is part of the exporter's own stable, JSON-serializable data
 * shape, not something that varies across SDK versions.
 */
const METRIC_DATA_POINT_TYPE_SUM = 3;

export interface CapturedSumPoint {
  readonly attributes: Attributes;
  readonly value: number;
}

/** Every SUM (counter) data point of `name`, across every export the exporter holds. */
export function sumDataPoints(exporter: MetricExporterLike, name: string): CapturedSumPoint[] {
  const points: CapturedSumPoint[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        // The enum's real type is intentionally not imported (see the
        // comment above); the numeric value it compares against is that
        // same enum's own stable, documented value.
        if (
          metric.descriptor.name === name &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
          metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
        ) {
          for (const dataPoint of metric.dataPoints) {
            points.push({ attributes: dataPoint.attributes, value: dataPoint.value });
          }
        }
      }
    }
  }
  return points;
}
